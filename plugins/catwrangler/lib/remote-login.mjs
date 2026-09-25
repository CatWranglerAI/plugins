/**
 * Remote login: restore this machine's CatWrangler MCP credential from a phone.
 *
 * Host-neutral. The Claude Code and Codex skills both reach it through
 * scripts/remote-login.sh, which passes the host explicitly.
 *
 * THE PROBLEM. When the credential a host CLI holds for the plugin's MCP server
 * reaches terminal expiry, the fix is `<host> mcp login <server>`. That login
 * finishes in a browser on THIS machine. A human driving the session remotely
 * cannot reach that browser, so the session stays dead until they get back to
 * the machine.
 *
 * THE SHAPE. The host CLI still does all the OAuth: PKCE, the code exchange, and
 * storing the credential. This module never sees a token. It adds one relay leg,
 * using the authorization server's handoff mode (atc:d-1763):
 *
 *   start   spawns a detached worker and returns one line for the human:
 *           the authorize URL plus `handoff=<h>`, and a confirmation code.
 *   worker  runs `<host> mcp login <server> --no-browser` and holds a random
 *           secret s in memory, where h = base64url(sha256(s)). It polls the
 *           server's pickup route with s. Once the human approves on the phone,
 *           pickup returns the loopback callback URL, and the worker GETs it
 *           against the CLI's own localhost listener, as a browser would have.
 *   wait    reports the worker's outcome. It is bounded, so that it fits an
 *           ordinary tool-call timeout; the skill simply runs it again.
 *
 * Why the work is split into start and wait rather than one long command: a
 * single long command needs background-process support from every host, while
 * two short commands fit ordinary tool calls.
 *
 * WHAT MUST STAY TRUE, and why each rule exists:
 *   - The secret never touches disk or stdout. Seeing the link (h is public;
 *     it travels through chat) must not be enough to collect the approval.
 *   - The secret is sent only to the origin of the authorize URL the CLI
 *     itself printed, and only over https (loopback is allowed for tests). That
 *     origin is the authorization server the CLI is about to trust anyway.
 *   - The callback is delivered only to a loopback http URL whose host, port and
 *     path match the redirect_uri of the CLI's own authorize request, and whose
 *     state matches. Anything else is refused: this module must never be a way
 *     to make a machine GET an arbitrary URL.
 *   - A failure is reported and names the standard login command (d-3038). It
 *     is never retried into something else.
 *
 * WHY A PSEUDO-TERMINAL FOR CLAUDE, and why it is `script`. Claude Code's login
 * exits at once when stdin is not a terminal. On macOS, `script -q /dev/null …`
 * fails with tcgetattr when stdin is a Node pipe, and works when stdin is
 * ignored (spike, 2026-09-24). That is why the callback goes through the
 * listener rather than stdin. Codex needs no terminal, but it abandons the login
 * when stdin closes, so it gets a pipe that stays open and is never written.
 * Python was ruled out because the interpreter differed from session to session
 * on the same machine.
 *
 * POSIX only. Windows has no `script`, and the Windows path is deferred.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, lstatSync, statSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(PLUGIN_ROOT, 'scripts', 'remote-login.mjs');

export const HOSTS = ['claude', 'codex'];

/** How long `start` waits for the login command to print its authorize URL. */
const START_TIMEOUT_MS = 45_000;
/** Matches the server's handoff TTL (HANDOFF_TTL_SECONDS in atc src/auth/mcp-handoff.ts). */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const PICKUP_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** How long the login command gets to exchange the code once the callback is delivered. */
const EXCHANGE_TIMEOUT_MS = 60_000;
/** Default `wait` bound. Under Claude Code's default 2-minute tool timeout. */
export const DEFAULT_WAIT_SECONDS = 100;
const MAX_WAIT_SECONDS = 600;
const OUTPUT_CAP = 64 * 1024;

// ---- the handoff contract (atc:d-1763) -------------------------------------
//
// The server's copy is src/auth/mcp-handoff.ts in atc-dev. Changing either side
// alone makes every confirmation code mismatch. tests/remote-login.mjs pins the
// server's test vector.

const CONFIRMATION_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 256 bits as unpadded base64url: 43 characters, the form the server accepts. */
export function newSecret() {
  return randomBytes(32).toString('base64url');
}

/** h = base64url(sha256(secret)), unpadded. */
export function handleForSecret(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('base64url');
}

/** What the Approve page shows. sha256(handle), first four bytes, each masked to 5 bits. */
export function confirmationCode(handle) {
  const digest = createHash('sha256').update(handle, 'utf8').digest();
  let code = '';
  for (let i = 0; i < 4; i++) code += CONFIRMATION_ALPHABET[digest[i] & 31];
  return code;
}

// ---- reading the login command's output -------------------------------------

/** OSC 8 hyperlink: ESC ] 8 ; params ; URI (BEL | ESC \). Claude wraps its URL in one. */
const OSC8 = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]/g;
const AUTHORIZE_URL = /https?:\/\/[^\s"'<>\x1b]+[?&]state=[^\s"'<>\x1b]+/;

export function stripAnsi(text) {
  return text.replace(ANSI, '');
}

/**
 * The authorize URL the login command printed, or null.
 *
 * The OSC 8 target comes first because the terminal never wraps it. The visible
 * text can be broken across lines at the pseudo-terminal's width, and a URL cut
 * at a line break still parses; it is simply a different, broken request.
 */
export function findAuthorizeUrl(output) {
  for (const m of output.matchAll(OSC8)) {
    const hit = m[1].match(AUTHORIZE_URL);
    if (hit) return hit[0];
  }
  const hit = stripAnsi(output).match(AUTHORIZE_URL);
  return hit ? hit[0] : null;
}

/** Appended as text, not through URLSearchParams, so the CLI's own encoding of every other parameter survives byte for byte. */
export function withHandoff(authorizeUrl, handle) {
  return `${authorizeUrl}${authorizeUrl.includes('?') ? '&' : '?'}handoff=${handle}`;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const isLoopbackHost = (hostname) => LOOPBACK_HOSTS.has(hostname);

/** Where the secret goes: the authorize URL's own origin, over https unless it is loopback. */
export function pickupUrl(authorizeUrl) {
  const u = new URL(authorizeUrl);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) {
    throw new Error(`the authorization server at ${u.origin} is not https, so the approval secret will not be sent to it`);
  }
  return `${u.origin}/mcp-as/handoff/pickup`;
}

/**
 * Refuse any callback that is not the login command's own listener.
 *
 * The callback comes back from the network, so it is checked against the
 * request this machine made: loopback http, the same host:port and path as the
 * redirect_uri, the same state, and a code. Throws with the reason.
 */
export function checkCallback(callback, authorizeUrl) {
  const req = new URL(authorizeUrl).searchParams;
  const redirect = req.get('redirect_uri');
  if (!redirect) throw new Error('the authorize request carried no redirect_uri to check the callback against');
  let cb;
  let ru;
  try {
    cb = new URL(callback);
    ru = new URL(redirect);
  } catch {
    throw new Error('the server returned a callback that is not a valid URL');
  }
  if (cb.protocol !== 'http:' || !isLoopbackHost(cb.hostname)) {
    throw new Error(`the server returned a callback outside this machine (${cb.origin}); it was not followed`);
  }
  if (cb.host !== ru.host || cb.pathname !== ru.pathname) {
    throw new Error(`the server returned a callback for ${cb.host}${cb.pathname}, but the login command is listening on ${ru.host}${ru.pathname}`);
  }
  const state = req.get('state');
  if (state && cb.searchParams.get('state') !== state) {
    throw new Error('the callback state does not match the login request');
  }
  if (!cb.searchParams.get('code')) throw new Error('the callback carries no authorization code');
  return cb.href;
}

// ---- which server, which command --------------------------------------------

const readJson = (name) => JSON.parse(readFileSync(join(PLUGIN_ROOT, name), 'utf8'));

/** The first (and only) key of a server map, unwrapping Claude's `mcpServers`. */
function serverKey(cfg) {
  const servers = (cfg && cfg.mcpServers) || cfg || {};
  const key = Object.keys(servers)[0];
  if (!key) throw new Error('the plugin manifest names no MCP server');
  return key;
}

/**
 * The name this host knows the plugin's MCP server by, read from the manifests.
 *
 * It is read, never written here, because the same tree is published twice
 * (d-3126), and the internal flavor renames the plugin and the server key in
 * these manifests (d-3147). A literal here would name the other build's server.
 * Claude Code scopes plugin servers as plugin:<plugin>:<server>; Codex's table
 * is flat.
 */
export function serverName(host) {
  if (host === 'claude') {
    return `plugin:${readJson('.claude-plugin/plugin.json').name}:${serverKey(readJson('mcp-config.json'))}`;
  }
  if (host === 'codex') return serverKey(readJson('codex-mcp.json'));
  throw new Error(`unknown host ${host}`);
}

/** The ordinary login, which every failure line names. */
export const standardLogin = (host, server) => `${host} mcp login ${server}`;

/** First executable named `name` on PATH, or null. */
export function findOnPath(name, pathVar = process.env.PATH || '') {
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      const st = statSync(candidate);
      if (st.isFile() && st.mode & 0o111) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * argv and stdin for the login command, per host and platform. See the header
 * for why Claude gets `script` with stdin ignored and Codex gets a pipe that
 * stays open.
 */
export function loginSpawn(host, exe, server, platform = process.platform) {
  const login = [exe, 'mcp', 'login', server, '--no-browser'];
  if (host === 'codex') return { argv: login, stdin: 'pipe' };
  if (platform === 'darwin') return { argv: ['script', '-q', '/dev/null', ...login], stdin: 'ignore' };
  return { argv: ['script', '-qec', login.map(shellQuote).join(' '), '/dev/null'], stdin: 'ignore' };
}

// ---- status file -------------------------------------------------------------
//
// The worker's only output channel. It holds nothing secret: the authorize URL
// (which the human is sent anyway), the confirmation code, and outcome text.
// There is one per host, and a new `start` replaces the previous run.

function stateDir(host) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const base = join(tmpdir(), `catwrangler-remote-login-${uid}`);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  // /tmp is shared on Linux. Refuse a directory someone else planted.
  const st = lstatSync(base);
  if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
    throw new Error(`${base} is not a directory owned by this user`);
  }
  const dir = join(base, host);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const statusPath = (host) => join(stateDir(host), 'status.json');

export function readStatus(host) {
  try {
    return JSON.parse(readFileSync(statusPath(host), 'utf8'));
  } catch {
    return null;
  }
}

function writeStatus(host, status) {
  const fp = statusPath(host);
  const tmp = `${fp}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...status, updated_at: new Date().toISOString() }), { mode: 0o600 });
  renameSync(tmp, fp);
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const TERMINAL = new Set(['done', 'failed']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastLine = (text) =>
  stripAnsi(text)
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() || '';

// ---- output lines ------------------------------------------------------------

const say = (line) => process.stdout.write(`${line}\n`);

function failLine(host, server, error) {
  return `CW_LOGIN_FAILED: ${error}. Use the standard login instead: ${standardLogin(host, server)}`;
}

function actionLine(status) {
  return `CW_LOGIN_ACTION: Open ${status.action_url} and approve the sign-in. Check that the page shows confirmation code ${status.code}.`;
}

// ---- start -------------------------------------------------------------------

async function start(host) {
  const server = serverName(host);
  if (process.platform === 'win32') {
    say(failLine(host, server, 'remote login is not available on Windows'));
    return 1;
  }
  if (!findOnPath(host)) {
    say(failLine(host, server, `the ${host} CLI was not found on PATH`));
    return 1;
  }
  if (host === 'claude' && !findOnPath('script')) {
    say(failLine(host, server, 'the `script` command, which provides the terminal the Claude login needs, was not found on PATH'));
    return 1;
  }

  // One run per host. A newer start makes the older link useless, so stop the
  // older worker rather than leave it polling for an approval nobody will give.
  const previous = readStatus(host);
  if (previous && !TERMINAL.has(previous.state) && previous.pid && isAlive(previous.pid)) {
    try {
      process.kill(previous.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }

  const runId = randomBytes(8).toString('hex');
  writeStatus(host, { run_id: runId, host, server, state: 'starting', started_at: new Date().toISOString() });
  const worker = spawn(process.execPath, [ENTRY, host, 'worker', runId], { detached: true, stdio: 'ignore' });
  worker.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(250);
    const st = readStatus(host);
    if (!st || st.run_id !== runId) continue;
    if (st.state === 'awaiting_approval') {
      say(actionLine(st));
      return 0;
    }
    if (st.state === 'failed') {
      say(failLine(host, server, st.error));
      return 1;
    }
    if (!isAlive(worker.pid)) {
      say(failLine(host, server, 'the login helper stopped before the login command printed a sign-in link'));
      return 1;
    }
  }
  try {
    process.kill(worker.pid, 'SIGTERM');
  } catch {
    // already gone
  }
  say(failLine(host, server, `the login command printed no sign-in link within ${START_TIMEOUT_MS / 1000} seconds`));
  return 1;
}

// ---- worker ------------------------------------------------------------------

async function worker(host, runId) {
  const server = serverName(host);
  const base = { run_id: runId, host, server, pid: process.pid, started_at: new Date().toISOString() };
  let status = { ...base, state: 'starting' };
  const update = (patch) => {
    status = { ...status, ...patch };
    // A newer start owns the file now; this run must not overwrite it.
    const cur = readStatus(host);
    if (cur && cur.run_id !== runId) return;
    writeStatus(host, status);
  };

  const exe = findOnPath(host);
  const { argv, stdin } = loginSpawn(host, exe, server);
  // Its own process group, so a failure can stop `script` and the CLI under it together.
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: [stdin, 'pipe', 'pipe'] });
  let output = '';
  let exited = null;
  const collect = (chunk) => {
    output = (output + chunk.toString('utf8')).slice(-OUTPUT_CAP);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      resolve(exited);
    });
    child.on('error', (err) => {
      exited = { code: null, signal: null, error: err.message };
      resolve(exited);
    });
  });

  const stopChild = () => {
    if (exited) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
  };
  const fail = (error) => {
    stopChild();
    update({ state: 'failed', error });
    process.exit(1);
  };
  process.on('SIGTERM', () => fail('stopped, because a newer remote login replaced this one'));

  // 1. The authorize URL.
  let authorizeUrl = null;
  const urlDeadline = Date.now() + START_TIMEOUT_MS - 5_000;
  while (!authorizeUrl && Date.now() < urlDeadline) {
    authorizeUrl = findAuthorizeUrl(output);
    if (authorizeUrl) break;
    if (exited) {
      fail(`the login command exited${exited.code !== null ? ` with code ${exited.code}` : ''} before printing a sign-in link${exited.error ? `: ${exited.error}` : lastLine(output) ? `: ${lastLine(output)}` : ''}`);
    }
    await sleep(200);
  }
  if (!authorizeUrl) fail(`the login command printed no sign-in link${lastLine(output) ? `; its last output was: ${lastLine(output)}` : ''}`);

  let pickup;
  try {
    pickup = pickupUrl(authorizeUrl);
  } catch (err) {
    fail(err.message);
  }

  // 2. The secret, which exists only in this process.
  const secret = newSecret();
  const handle = handleForSecret(secret);
  update({ state: 'awaiting_approval', action_url: withHandoff(authorizeUrl, handle), code: confirmationCode(handle) });

  // 3. Pickup. 202 means not approved yet. Transient errors are recorded, never swallowed.
  let callback = null;
  const approvalDeadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() < approvalDeadline) {
    if (exited) fail(`the login command exited before the sign-in was approved${lastLine(output) ? `: ${lastLine(output)}` : ''}`);
    let res;
    try {
      res = await fetch(pickup, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      update({ last_error: `could not reach ${new URL(pickup).origin}: ${err.cause?.message || err.message}` });
      await sleep(PICKUP_INTERVAL_MS);
      continue;
    }
    const body = await res.text().catch(() => '');
    if (res.status === 200) {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        // handled below
      }
      if (!parsed || typeof parsed.callback !== 'string') fail('the server approved the sign-in but returned no callback');
      try {
        callback = checkCallback(parsed.callback, authorizeUrl);
      } catch (err) {
        fail(err.message);
      }
      break;
    }
    if (res.status === 410) fail('the approval expired or was already used');
    if (res.status === 403) fail('the account that approved the sign-in is not an active member of the organization');
    if ([400, 404].includes(res.status)) fail(`the server refused the pickup (${res.status}: ${body.slice(0, 200)}); it may not support phone approval`);
    if (res.status !== 202) update({ last_error: `the server answered ${res.status} to the pickup` });
    else if (status.last_error) update({ last_error: null });
    await sleep(PICKUP_INTERVAL_MS);
  }
  if (!callback) fail(`no approval arrived within ${APPROVAL_TIMEOUT_MS / 60_000} minutes`);

  // 4. Delivery to the login command's own listener, exactly as a browser redirect would.
  update({ state: 'delivering' });
  try {
    await fetch(callback, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    fail(`the approval could not be passed to the login command on this machine: ${err.cause?.message || err.message}`);
  }

  // 5. The login command exchanges the code and saves the credential.
  const outcome = await Promise.race([exitPromise, sleep(EXCHANGE_TIMEOUT_MS).then(() => null)]);
  if (!outcome) fail(`the login command did not finish within ${EXCHANGE_TIMEOUT_MS / 1000} seconds of the approval`);
  if (outcome.code !== 0) {
    fail(`the login command exited with ${outcome.code !== null ? `code ${outcome.code}` : `signal ${outcome.signal}`}${lastLine(output) ? `: ${lastLine(output)}` : ''}`);
  }
  update({ state: 'done', message: lastLine(output) });
  process.exit(0);
}

// ---- wait --------------------------------------------------------------------

async function wait(host, seconds) {
  let server;
  try {
    server = serverName(host);
  } catch (err) {
    say(`CW_LOGIN_FAILED: ${err.message}`);
    return 1;
  }
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const st = readStatus(host);
    if (!st) {
      say(failLine(host, server, 'no remote login has been started on this machine; run start first'));
      return 1;
    }
    if (st.state === 'done') {
      say(`CW_LOGIN_DONE: ${host} saved a new credential for ${st.server}. Retry the CatWrangler call that failed.`);
      return 0;
    }
    if (st.state === 'failed') {
      say(failLine(host, st.server, st.error));
      return 1;
    }
    if (st.pid && !isAlive(st.pid)) {
      say(failLine(host, st.server, 'the login helper stopped unexpectedly'));
      return 1;
    }
    if (Date.now() >= deadline) break;
    await sleep(1_000);
  }
  const st = readStatus(host) || {};
  const note = st.last_error ? ` Last problem reaching the server: ${st.last_error}.` : '';
  say(`CW_LOGIN_PENDING: still waiting for the sign-in to be approved on the phone (confirmation code ${st.code || 'unknown'}).${note} Run wait again; do not run start again, because that makes the link already sent useless.`);
  return 3;
}

// ---- CLI ---------------------------------------------------------------------

/**
 * argv: <host> start | <host> wait [--timeout <seconds>] | <host> worker <run-id>
 *
 * Exit codes: 0 done / link printed, 1 failed, 2 usage, 3 still pending.
 */
export async function runRemoteLoginCli(argv) {
  const [host, verb, ...rest] = argv;
  if (!HOSTS.includes(host)) {
    process.stderr.write('usage: remote-login <claude|codex> <start|wait> [--timeout <seconds>]\n');
    process.exit(2);
  }
  let code;
  try {
    if (verb === 'start') code = await start(host);
    else if (verb === 'worker' && rest[0]) code = await worker(host, rest[0]);
    else if (verb === 'wait') {
      const i = rest.indexOf('--timeout');
      const n = i >= 0 ? Number(rest[i + 1]) : DEFAULT_WAIT_SECONDS;
      const seconds = Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_WAIT_SECONDS) : DEFAULT_WAIT_SECONDS;
      code = await wait(host, seconds);
    } else {
      process.stderr.write('usage: remote-login <claude|codex> <start|wait> [--timeout <seconds>]\n');
      code = 2;
    }
  } catch (err) {
    say(`CW_LOGIN_FAILED: ${err.message}`);
    code = 1;
  }
  process.exit(code);
}
