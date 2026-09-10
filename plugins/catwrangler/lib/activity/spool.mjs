/**
 * Normalization: raw host hook payloads → canonical schema-v1 events (cw:d-3731).
 *
 * Pure functions, no I/O — the daemon owns files and network. Three jobs:
 *
 *  1. Turn one PostToolUse payload into a tool_call + tool_result event pair,
 *     bounded (64KiB line cap server-side; we truncate payloads well before
 *     it) and redacted (credential-shaped keys and the activity_capture grant
 *     never leave the machine — SDD §6.3 displayability is a producer
 *     property).
 *  2. Extract the ignition material from an init_session tool_response: the
 *     one-use bootstrap grant, the minted agent_id, and the project id. The
 *     grant is then REDACTED from the persisted/uploaded event.
 *  3. Deterministic event ids: evt_<sha256(session:file:index)>, so
 *     re-processing a spool file after a crash re-produces the same ids and
 *     the server's dedup makes the replay a no-op.
 */

import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;
/** Keep normalized payloads comfortably under the server's 64KiB line cap. */
const PAYLOAD_BYTE_BUDGET = 40 * 1024;

const CW_TOOL_RE = /catwrangler/i;
const SENSITIVE_KEY_RE = /(token|bearer|secret|password|credential|authorization|api[_-]?key)/i;
// Grant/ingest-token literals wherever they appear. MCP tool responses arrive
// as JSON *text blocks*, so key-based redaction alone would ship the grant
// embedded in a string — the capture-smoke test exists to catch exactly that.
const TOKEN_LITERAL_RE = /\b(?:acg|act)_[A-Za-z0-9._~-]+/g;

export function isCatWranglerTool(name) {
  return typeof name === 'string' && CW_TOOL_RE.test(name);
}

/** mcp__<server>__<tool> → <tool>; anything else passes through. */
export function shortToolName(name) {
  if (typeof name !== 'string') return 'unknown';
  const m = name.match(/^mcp__.+__([^_].*)$/);
  return m ? m[1] : name;
}

export function eventId(sessionId, sourceName, index) {
  const h = createHash('sha256').update(`${sessionId}:${sourceName}:${index}`).digest('hex');
  return `evt_${h.slice(0, 32)}`;
}

/**
 * Deep copy with redaction: credential-shaped keys and the activity_capture
 * block become typed placeholders. Depth- and breadth-bounded so a hostile or
 * cyclic payload cannot wedge the daemon.
 */
export function redact(value, depth = 0) {
  if (typeof value === 'string') return value.replace(TOKEN_LITERAL_RE, '[redacted]');
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));
  const out = {};
  let keys = 0;
  for (const [k, v] of Object.entries(value)) {
    if (++keys > 200) break;
    if (k === 'activity_capture') {
      out[k] = { redacted: 'activity_capture_grant' };
    } else if (SENSITIVE_KEY_RE.test(k) && typeof v !== 'object') {
      out[k] = '[redacted]';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

/** Serialize-bounded copy: over budget becomes a typed truncation stub. */
export function bounded(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return { truncated: true, reason: 'unserializable' };
  }
  if (json === undefined) return undefined;
  if (Buffer.byteLength(json, 'utf8') <= PAYLOAD_BYTE_BUDGET) return value;
  return {
    truncated: true,
    bytes: Buffer.byteLength(json, 'utf8'),
    preview: json.slice(0, PAYLOAD_BYTE_BUDGET / 2),
  };
}

/** Best-effort tool_response text: MCP responses arrive as content blocks. */
function responseText(toolResponse) {
  if (typeof toolResponse === 'string') return toolResponse;
  if (toolResponse && Array.isArray(toolResponse.content)) {
    return toolResponse.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

/** Recursively find the first object value under key `wanted`. */
function findKey(value, wanted, depth = 0) {
  if (depth > 10 || value === null || typeof value !== 'object') return undefined;
  if (!Array.isArray(value)) {
    if (value[wanted] !== undefined) return value[wanted];
  }
  for (const v of Array.isArray(value) ? value : Object.values(value)) {
    const hit = findKey(v, wanted, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Claude Code replaces an oversized tool_response with a notice string naming
 * the file the full result was saved to ("Output has been saved to <path>") —
 * and init_session responses are large enough to hit this every time. Return
 * that path when the notice is present and the path is shaped like the host's
 * own tool-results spill; the daemon (which owns I/O) decides whether to read
 * it. Anything not matching the exact spill shape returns null — this must
 * never become a generic file-read primitive driven by response text.
 */
export function spillFilePath(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = responseText(raw.tool_response);
  const m = typeof text === 'string' ? text.match(/saved to ([A-Za-z]:)?((?:\/|\\)[^\s"'`]+\.txt)/) : null;
  if (!m) return null;
  const path = (m[1] || '') + m[2];
  if (path.includes('..') || !/[\/\\]tool-results[\/\\][^\/\\]+\.txt$/.test(path)) return null;
  return path;
}

/**
 * Pull ignition material out of an init_session PostToolUse payload. Works on
 * the structured tool_response when the host preserves it, and falls back to
 * parsing embedded JSON text blocks. Returns null when this is not an
 * init_session result or nothing usable is present.
 */
export function extractIgnition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!/init_session/.test(String(raw.tool_name ?? ''))) return null;

  const sources = [raw.tool_response];
  const text = responseText(raw.tool_response);
  // Parse on agent_session too, not just activity_capture: when the instance
  // flag is (or goes) OFF the response carries no grant, and ignition must
  // still run so consent bookkeeping updates and an armed flag file can be
  // cleared — otherwise the sh hook keeps spooling into a parked queue.
  if (text && (text.includes('activity_capture') || text.includes('agent_session'))) {
    try { sources.push(JSON.parse(text)); } catch { /* not a single JSON doc */ }
  }

  let grantBlock;
  let agentId;
  let projectId = typeof raw.tool_input?.project_id === 'string' ? raw.tool_input.project_id : undefined;
  for (const source of sources) {
    grantBlock = grantBlock ?? findKey(source, 'activity_capture');
    const session = findKey(source, 'agent_session');
    if (session && typeof session.agent_id === 'string') agentId = session.agent_id;
  }
  // agent-<hex>-<hex>.p-<slug>: the suffix is the project id the lane minted.
  if (!projectId && typeof agentId === 'string') {
    const dot = agentId.indexOf('.');
    if (dot > 0) projectId = agentId.slice(dot + 1);
  }
  if (!grantBlock && !agentId) return null;
  const grant = grantBlock && typeof grantBlock.grant === 'string' ? grantBlock.grant : undefined;
  return {
    grant,
    exchange_path: grantBlock && typeof grantBlock.exchange_path === 'string'
      ? grantBlock.exchange_path : '/api/agent-activity/token',
    agent_id: agentId,
    project_id: projectId,
  };
}

/**
 * One PostToolUse payload → tool_call + tool_result events. `ctx` supplies
 * identity and sequencing: { projectId, agentId, client, sourceName, seqBase }.
 * Non-CatWrangler tools return [] — the matcher already scopes the hook, this
 * is defense in depth against a stray manifest edit.
 */
export function normalizePostToolUse(raw, ctx) {
  if (!raw || typeof raw !== 'object' || !isCatWranglerTool(raw.tool_name)) return [];
  const sessionId = typeof raw.session_id === 'string' && raw.session_id ? raw.session_id : 'unknown-session';
  const occurredAt = new Date().toISOString();
  const tool = shortToolName(raw.tool_name);
  const base = {
    schema_version: SCHEMA_VERSION,
    project_id: ctx.projectId,
    agent_id: ctx.agentId,
    session_id: sessionId,
    occurred_at: occurredAt,
    client: ctx.client,
    ...(typeof raw.tool_use_id === 'string' ? { tool_use_id: raw.tool_use_id } : {}),
  };
  // Content-derived id seed: the ignite handoff and the sh hook can both
  // spool the same payload, and two files with the same tool_use_id must
  // produce the SAME event ids so the server's dedup collapses them.
  const idSeed = typeof raw.tool_use_id === 'string' && raw.tool_use_id
    ? `tu:${raw.tool_use_id}` : ctx.sourceName;
  const call = {
    ...base,
    event_id: eventId(sessionId, idSeed, 0),
    sequence: ctx.seqBase,
    kind: 'tool_call',
    payload: { tool, input: bounded(redact(raw.tool_input ?? null)) },
  };
  const result = {
    ...base,
    event_id: eventId(sessionId, idSeed, 1),
    sequence: ctx.seqBase + 1,
    kind: 'tool_result',
    payload: {
      tool,
      outcome: raw.tool_response && raw.tool_response.isError ? 'error' : 'ok',
      ...(typeof raw.duration_ms === 'number' ? { duration_ms: raw.duration_ms } : {}),
      response: bounded(redact(raw.tool_response ?? null)),
    },
  };
  return [call, result];
}

/** A capture_gap diagnostic event (SDD §6.3) — used by the daemon on parse failures. */
export function gapEvent(sessionId, ctx, reason) {
  return {
    schema_version: SCHEMA_VERSION,
    project_id: ctx.projectId,
    agent_id: ctx.agentId,
    session_id: sessionId,
    event_id: eventId(sessionId, ctx.sourceName, 0),
    sequence: ctx.seqBase,
    occurred_at: new Date().toISOString(),
    client: ctx.client,
    kind: 'capture_gap',
    payload: { reason: String(reason).slice(0, 500) },
  };
}

/** An assistant_text event from a transcript block (level "full" only). */
export function assistantTextEvent(sessionId, ctx, text, index) {
  return {
    schema_version: SCHEMA_VERSION,
    project_id: ctx.projectId,
    agent_id: ctx.agentId,
    session_id: sessionId,
    event_id: eventId(sessionId, ctx.sourceName, index),
    sequence: ctx.seqBase,
    occurred_at: new Date().toISOString(),
    client: ctx.client,
    kind: 'assistant_text',
    payload: { text: String(text).slice(0, PAYLOAD_BYTE_BUDGET / 2) },
  };
}
