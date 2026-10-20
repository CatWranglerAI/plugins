import { spawn } from 'node:child_process';
import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY_INFO = Buffer.from('catwrangler-project-secret-use-v1', 'utf8');
const KEY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENVELOPE_RE = /^[A-Za-z0-9_-]{100,65536}$/;

export function secretKeyDirectory(env = process.env) {
  const root = env.CW_SECRETS_DIR || env.CODEX_HOME || join(homedir(), '.cw-secrets');
  return join(root, 'secret-use');
}

export async function prepareSecretUse(env = process.env) {
  const directory = secretKeyDirectory(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const pair = generateKeyPairSync('x25519');
  const key_id = randomUUID();
  await writeFile(join(directory, key_id + '.pem'),
    pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
  return { key_id, public_key: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') };
}

export function decryptSecretEnvelope(encoded, privateKey, now = Date.now()) {
  if (typeof encoded !== 'string' || !ENVELOPE_RE.test(encoded)) throw new Error('SECRET_ENVELOPE_INVALID');
  try {
    const envelope = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const header = envelope.header;
    if (header?.version !== 1 || header.environment !== 'staging'
        || typeof header.project_id !== 'string' || typeof header.agent_id !== 'string'
        || !Array.isArray(header.names) || !header.names.length || header.names.length > 16
        || header.names.some(name => typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(name))
        || !Number.isFinite(Date.parse(header.expires_at))
        || Date.parse(header.expires_at) < now
        || Date.parse(header.expires_at) > now + 5 * 60_000) throw new Error('invalid');
    const sender = createPublicKey({ key: Buffer.from(envelope.ephemeral_public_key, 'base64url'),
      format: 'der', type: 'spki' });
    if (sender.asymmetricKeyType !== 'x25519') throw new Error('invalid');
    const salt = Buffer.from(envelope.salt, 'base64url');
    const nonce = Buffer.from(envelope.nonce, 'base64url');
    const tag = Buffer.from(envelope.tag, 'base64url');
    if (salt.length !== 32 || nonce.length !== 12 || tag.length !== 16) throw new Error('invalid');
    const shared = diffieHellman({ privateKey, publicKey: sender });
    const key = Buffer.from(hkdfSync('sha256', shared, salt, KEY_INFO, 32));
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(JSON.stringify(header), 'utf8'));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]);
    const values = JSON.parse(plain.toString('utf8')).secrets;
    if (!values || typeof values !== 'object' || Array.isArray(values)
        || Object.keys(values).length !== header.names.length
        || header.names.some(name => typeof values[name] !== 'string')) throw new Error('invalid');
    return values;
  } catch { throw new Error('SECRET_ENVELOPE_INVALID'); }
}

export async function readAndConsumeSecretEnvelope(keyId, envelope, env = process.env, now = Date.now()) {
  if (!KEY_ID_RE.test(keyId || '')) throw new Error('SECRET_KEY_ID_INVALID');
  const path = join(secretKeyDirectory(env), keyId + '.pem');
  let privateKey;
  try {
    privateKey = createPrivateKey(await readFile(path));
    if (privateKey.asymmetricKeyType !== 'x25519') throw new Error('invalid');
    return decryptSecretEnvelope(envelope, privateKey, now);
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

export const SECRET_EXEC_HELP = `Project Secret script use:
  1. Call runtime_secrets action=list and choose staging-mapped names.
  2. Run: cw-secrets prepare
  3. Call runtime_secrets action=seal with names:[...], public_key from step 2.
  4. Run: CW_SECRET_ENVELOPE=<envelope> cw-secrets exec --key-id <key_id> -- node script.mjs
The selected values appear only as environment variables in that child script.
Do not print, return, or save the values. An expired envelope needs a new prepare/seal.
`;

export async function runSecretCli(argv = process.argv.slice(2), env = process.env, output = process.stdout) {
  if (argv[0] === '--help' || argv[0] === 'help' || argv.length === 0) {
    const command = `node ${JSON.stringify(process.argv[1] || 'secrets-exec.mjs')}`;
    output.write(SECRET_EXEC_HELP.replaceAll('cw-secrets', command));
    return 0;
  }
  if (argv[0] === 'prepare' && argv.length === 1) {
    output.write(JSON.stringify(await prepareSecretUse(env)) + '\n');
    return 0;
  }
  if (argv[0] !== 'exec' || argv[1] !== '--key-id' || !argv[2] || argv[3] !== '--'
      || !argv[4]) throw new Error('SECRET_EXEC_USAGE_INVALID');
  const values = await readAndConsumeSecretEnvelope(argv[2], env.CW_SECRET_ENVELOPE, env);
  const childEnv = { ...env, ...values };
  delete childEnv.CW_SECRET_ENVELOPE;
  delete childEnv.CW_SECRETS_DIR;
  const child = spawn(argv[4], argv.slice(5), { env: childEnv, stdio: 'inherit' });
  const forwardTerm = () => child.kill('SIGTERM');
  const forwardInt = () => child.kill('SIGINT');
  process.once('SIGTERM', forwardTerm);
  process.once('SIGINT', forwardInt);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(signal ? (signal === 'SIGINT' ? 130 : 143) : code ?? 1));
    });
  } finally {
    process.off('SIGTERM', forwardTerm);
    process.off('SIGINT', forwardInt);
  }
}
