import { spawn } from 'node:child_process';
import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const KEY_INFO = Buffer.from('catwrangler-project-secret-use-v1', 'utf8');
const KEY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENVELOPE_RE = /^[A-Za-z0-9_-]{100,65536}$/;
const KEY_LIFETIME_MS = 2 * 60_000;

export function secretKeyDirectory(env = process.env) {
  const root = env.CW_SECRETS_DIR || env.CODEX_HOME || join(homedir(), '.cw-secrets');
  return join(root, 'secret-use');
}

export async function prepareSecretUse(env = process.env) {
  const directory = secretKeyDirectory(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  // Only reap our expired prepared keys, never unrelated files.
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.pem') || !KEY_ID_RE.test(name.slice(0, -4))) continue;
    const path = join(directory, name);
    try {
      if (Date.now() - (await stat(path)).mtimeMs >= KEY_LIFETIME_MS) await unlink(path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
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
        || typeof header.project_id !== 'string' || !header.project_id
        || typeof header.agent_id !== 'string' || !header.agent_id
        || !Array.isArray(header.names) || !header.names.length || header.names.length > 16
        || new Set(header.names).size !== header.names.length
        || header.names.some(name => typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(name))
        || !Number.isFinite(Date.parse(header.expires_at))
        || Date.parse(header.expires_at) <= now
        || Date.parse(header.expires_at) > now + KEY_LIFETIME_MS) throw new Error('invalid');
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
        || header.names.some(name => typeof values[name] !== 'string' || !values[name])) throw new Error('invalid');
    return values;
  } catch { throw new Error('SECRET_ENVELOPE_INVALID'); }
}

export async function readAndConsumeSecretEnvelope(keyId, envelope, env = process.env, now = Date.now()) {
  if (!KEY_ID_RE.test(keyId || '')) throw new Error('SECRET_KEY_ID_INVALID');
  const path = join(secretKeyDirectory(env), keyId + '.pem');
  const consumed = path + '.consumed-' + randomUUID();
  // Atomic claim: concurrent executions cannot read the same prepared key.
  try { await rename(path, consumed); }
  catch { throw new Error('SECRET_KEY_UNAVAILABLE'); }
  try {
    const info = await stat(consumed);
    if (!info.isFile() || now - info.mtimeMs >= KEY_LIFETIME_MS || info.mtimeMs > now + 30_000) {
      throw new Error('SECRET_KEY_EXPIRED');
    }
    const privateKey = createPrivateKey(await readFile(consumed));
    if (privateKey.asymmetricKeyType !== 'x25519') throw new Error('SECRET_KEY_INVALID');
    return decryptSecretEnvelope(envelope, privateKey, now);
  } finally {
    await unlink(consumed).catch(() => undefined);
  }
}

/** Redact literal injected values across UTF-8 and stream chunk boundaries. */
export function secretOutputRedactor(values, output) {
  const literals = [...new Set(Object.values(values))].filter(Boolean).sort((a, b) => b.length - a.length);
  const retain = Math.max(0, ...literals.map(value => value.length - 1));
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const flush = final => {
    for (const value of literals) pending = pending.split(value).join('[REDACTED]');
    const cut = final ? pending.length : Math.max(0, pending.length - retain);
    if (cut) output.write(pending.slice(0, cut));
    pending = pending.slice(cut);
  };
  return {
    write(chunk) { pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); flush(false); },
    end() { pending += decoder.end(); flush(true); },
  };
}

export const SECRET_EXEC_HELP = `Project Secret script use:
  1. Call runtime_secrets action=list and choose staging-mapped names.
  2. Run: cw-secrets prepare
  3. Call runtime_secrets action=seal with names:[...], public_key from step 2.
  4. Run: CW_SECRET_ENVELOPE=<envelope> cw-secrets exec --key-id <key_id> -- node script.mjs
The selected values appear only as environment variables in that child script.
Keys and envelopes expire after two minutes; each prepared key is consumed once.
Literal injected values are redacted from stdout/stderr. Scripts are trusted:
do not encode, print, return, save, or otherwise disclose values.
An expired or failed execution needs a new prepare/seal.
`;

export async function runSecretCli(argv = process.argv.slice(2), env = process.env, output = process.stdout, errorOutput = process.stderr) {
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
  if (argv.slice(4).some(arg => Object.values(values).some(value => arg.includes(value)))) {
    throw new Error('SECRET_EXEC_ARGUMENT_FORBIDDEN');
  }
  const childEnv = { ...env, ...values };
  delete childEnv.CW_SECRET_ENVELOPE;
  delete childEnv.CW_SECRETS_DIR;
  const child = spawn(argv[4], argv.slice(5), { env: childEnv, stdio: ['inherit', 'pipe', 'pipe'] });
  const stdout = secretOutputRedactor(values, output), stderr = secretOutputRedactor(values, errorOutput);
  child.stdout.on('data', chunk => stdout.write(chunk));
  child.stderr.on('data', chunk => stderr.write(chunk));
  const forwardTerm = () => child.kill('SIGTERM');
  const forwardInt = () => child.kill('SIGINT');
  process.once('SIGTERM', forwardTerm);
  process.once('SIGINT', forwardInt);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('SECRET_EXEC_FAILED')));
      child.once('close', (code, signal) => resolve(signal ? (signal === 'SIGINT' ? 130 : 143) : code ?? 1));
    });
  } finally {
    stdout.end(); stderr.end();
    process.off('SIGTERM', forwardTerm);
    process.off('SIGINT', forwardInt);
  }
}
