/**
 * Voice capture (cw:d-3731, cw:d-3767): assistant commentary from the host
 * transcript, plus the turn-final conclusion from a Stop hook payload.
 *
 * Everything here runs only at consent level "full", and the boundary is the
 * one tool capture draws (handoff §B2): text is CW-correlated voice, never
 * general conversation. Hosts write ONE content block per transcript entry —
 * text, thinking, and tool_use never share an entry — so that boundary maps
 * onto the entry stream as: the text entry immediately preceding a CW
 * tool_use in the same turn (the lead-in, held in sess.pending_text until a
 * CW call claims it or a user-side entry retires it), and the first text
 * entry after a CW tool_use (the conclusion, armed via
 * sess.capture_next_assistant). Non-CW conversation never leaves the machine.
 *
 * State contract: these functions mutate the sess object they are given
 * (transcript_offset, next_seq, pending_text, capture_next_assistant, gap
 * flag) and the caller must persist that SAME object — handing in a copy
 * re-reads the same transcript region on every drain and re-arms the
 * turn-final fallback.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { assistantTextEvent, gapEvent, isCatWranglerTool } from './spool.mjs';

const TRANSCRIPT_READ_CAP = 2 * 1024 * 1024;
/** assistantTextEvent truncates payloads to this anyway; capping the pending
 * lead-in at the same size keeps session-state files bounded. */
const PENDING_TEXT_CAP = 20 * 1024;

function emitText(sess, wireProjectId, sessionId, text, events, log) {
  const ctx = {
    projectId: wireProjectId, agentId: sess.agent_id, client: sess.client,
    sourceName: `transcript:${sess.transcript_offset}:${events.length}`, seqBase: sess.next_seq,
  };
  events.push(assistantTextEvent(sessionId, ctx, text, events.length));
  sess.next_seq += 1;
  // Preview so the local log shows WHAT was captured, not just that
  // something was. Runs only at consent level "full", on the user's own
  // machine, about their own sessions — the no-payloads rule stays absolute
  // for credentials.
  log(`said: ${sessionId} "${text.replace(/\s+/g, ' ').trim().slice(0, 100)}"`);
}

/**
 * Tail the host transcript from the session's stored offset, appending
 * guard-matched assistant_text events. wireProjectId is the ingest binding's
 * project id — the event-envelope form — not the lane p-form the session
 * state carries.
 */
export function tailTranscript(sess, wireProjectId, sessionId, transcriptPath, events, log) {
  if (sess.level !== 'full' || typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) return;
  try {
    const size = statSync(transcriptPath).size;
    let offset = typeof sess.transcript_offset === 'number' ? sess.transcript_offset : 0;
    if (offset >= size) return;
    const toRead = Math.min(size - offset, TRANSCRIPT_READ_CAP);
    const fd = openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(toRead);
    readSync(fd, buf, 0, toRead, offset);
    closeSync(fd);
    const text = buf.toString('utf8');
    // Only consume complete lines; a torn tail is re-read next time.
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline < 0) return;
    sess.transcript_offset = offset + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8');

    for (const line of text.slice(0, lastNewline).split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      // A user-side entry (prompt or tool result) is a boundary: text seen
      // before it can no longer be the lead-in for a later CW call. The
      // conclusion guard survives — tool results always land between a CW
      // call and the text that concludes it.
      if (entry && entry.type === 'user') { sess.pending_text = undefined; continue; }
      const content = entry && entry.type === 'assistant' && entry.message && Array.isArray(entry.message.content)
        ? entry.message.content : null;
      if (!content) continue;
      const hasCwToolUse = content.some((b) => b && b.type === 'tool_use' && isCatWranglerTool(b.name));
      if (hasCwToolUse) {
        if (typeof sess.pending_text === 'string' && sess.pending_text.trim()) {
          emitText(sess, wireProjectId, sessionId, sess.pending_text, events, log);
        }
        sess.pending_text = undefined;
        sess.capture_next_assistant = true;
      }
      for (const block of content) {
        if (!(block && block.type === 'text' && typeof block.text === 'string' && block.text.trim())) continue;
        if (sess.capture_next_assistant) {
          emitText(sess, wireProjectId, sessionId, block.text, events, log);
          sess.capture_next_assistant = false;
        } else {
          sess.pending_text = block.text.slice(0, PENDING_TEXT_CAP);
        }
      }
    }
  } catch (err) {
    if (!sess.transcript_gap_reported) {
      sess.transcript_gap_reported = true;
      const ctx = {
        projectId: wireProjectId, agentId: sess.agent_id, client: sess.client,
        sourceName: `transcript-gap:${Date.now()}`, seqBase: sess.next_seq,
      };
      events.push(gapEvent(sessionId, ctx, `transcript tail failed: ${err && err.message}`));
      sess.next_seq += 1;
    }
  }
}

/**
 * Drain one Stop payload: tail first, then — while the guard still says the
 * conclusion never reached the transcript (the host writes it asynchronously,
 * so at Stop time it is exactly the line most likely to be missing) — emit it
 * from last_assistant_message. Emitting consumes the guard, which is also
 * what makes the later transcript catch-up a no-op instead of a duplicate.
 */
export function stopVoice(sess, wireProjectId, sessionId, payload, sourceName, events, log) {
  tailTranscript(sess, wireProjectId, sessionId, payload.transcript_path, events, log);
  if (sess.level !== 'full' || !sess.capture_next_assistant) return;
  const text = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message.trim() : '';
  if (!text) return;
  const ctx = {
    projectId: wireProjectId, agentId: sess.agent_id, client: sess.client,
    sourceName, seqBase: sess.next_seq,
  };
  events.push(assistantTextEvent(sessionId, ctx, text, 0));
  sess.next_seq += 1;
  sess.capture_next_assistant = false;
  log(`said: ${sessionId} "${text.replace(/\s+/g, ' ').slice(0, 100)}"`);
}
