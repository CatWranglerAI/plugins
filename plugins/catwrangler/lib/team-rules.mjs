/**
 * The team-work rule book (cw:d-4664, cw:d-4743): load it, match text against
 * it, and decide the Stop hook. Host-neutral, like the rest of lib/.
 *
 * CatWrangler runs agents concurrently by design. Every agent has its own
 * branch, and each merge reconciles that branch against current trunk,
 * including edits to the same file and the same lines. An agent that holds work
 * back until another worker merges spends an hour buying a safety the merge
 * already provides, and it does so silently. The rules live in team-rules.json,
 * not here, because they are data other clients read too: the CatWrangler
 * Harness applies the same book. This file is one reader of that book and holds
 * no rule of its own.
 *
 * Briefs are not policed. Every agent is taught at start (the book's `teach`,
 * via protocol.mjs) to disregard instructions that fence files off, queue it
 * behind another agent, or ask it to coordinate or rebase to avoid conflicts,
 * so a worker does the right thing whatever its brief says.
 *
 * One surface, one hook:
 *
 *   agent_text    Stop. A final message that holds independent work back to
 *                 avoid conflicts blocks the stop once (`stop_hook_active`
 *                 marks the retry), with the correction as the reason.
 *
 * Only instruction is matched (cw:d-4739): quoted text is evidence, a log line
 * or a code block, and on the surfaces the book lists under
 * `quoted_is_evidence` it is masked before matching.
 *
 * Confined to CatWrangler workspaces by the same registry hunt as the
 * bootstrap. The plugin is installed user-global, and outside a workspace
 * nothing reconciles concurrent edits, so the rules do not hold there.
 *
 * Every entry point fails open. A rule book that will not load or compile, a
 * payload of an unexpected shape: each is "no opinion", never a block. A
 * broken hook must never stop work.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findRegistry } from './registry.mjs';

export const RULE_BOOK_PATH = fileURLToPath(new URL('./team-rules.json', import.meta.url));

/** Read and parse the rule book. Throws on a missing or malformed file. */
export function loadRuleBook(path = RULE_BOOK_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * The book as loaded at import, or null when it cannot be read. Importing this
 * module never throws: protocol.mjs reads `teach` from here at session start,
 * and an unreadable book must cost the session one paragraph, not its bootstrap.
 */
export const TEAM_RULES = (() => {
  try {
    return loadRuleBook();
  } catch {
    return null;
  }
})();

/**
 * Compile every pattern once, with the book's own flags. Throws on a pattern
 * that does not compile; the hook adapter catches that and fails open.
 */
export function compileRuleBook(book) {
  const compile = (source) => new RegExp(source, book.flags || '');
  return {
    surfaces: book.surfaces || {},
    quotedIsEvidence: book.quoted_is_evidence || [],
    ignore: (book.ignore || []).map(compile),
    rules: book.rules.map((rule) => ({
      ...rule,
      patterns: rule.patterns.map(compile),
      exceptions: (rule.exceptions || []).map(compile),
    })),
  };
}

/** Sentences as the book's $comment defines them, typographic apostrophes folded to ASCII. */
export function splitSentences(text) {
  return String(text ?? '')
    .replace(/[‘’ʼ]/g, "'")
    .split(/(?<=[.!?])\s+|[;\r\n]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

const FENCED_BLOCK = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;
const QUOTED_SPAN = /`([^`\n]+)`|"([^"\n]*)"|“([^”\n]*)”/g;

/**
 * Text with its quoted evidence masked, as the book's $comment defines it: a
 * closed fenced code block goes; a backtick, double-quoted or curly-quoted span
 * on one line keeps its text when it is a single token (a path or a name, which
 * the sentence around it is about) and is otherwise replaced by an ellipsis.
 */
export function maskQuoted(text) {
  return String(text ?? '')
    .replace(FENCED_BLOCK, '$1')
    .replace(QUOTED_SPAN, (_, tick, straight, curly) => {
      const inner = (tick ?? straight ?? curly).trim();
      return /^\S+$/.test(inner) ? inner : '…';
    });
}

/** Every { rule, sentence } hit in `text` for one surface of the book, such as `agent_text`. */
export function scanText(text, surface, compiled) {
  const hits = [];
  const scanned = compiled.quotedIsEvidence.includes(surface) ? maskQuoted(text) : text;
  for (const sentence of splitSentences(scanned)) {
    if (compiled.ignore.some((re) => re.test(sentence))) continue;
    for (const rule of compiled.rules) {
      if (!rule.applies_to.includes(surface)) continue;
      if (!rule.patterns.some((re) => re.test(sentence))) continue;
      if (rule.exceptions.some((re) => re.test(sentence))) continue;
      hits.push({ rule, sentence });
    }
  }
  return hits;
}

function unique(hits) {
  const seen = new Set();
  return hits.filter(({ rule, sentence }) => {
    const key = `${rule.id}\n${sentence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The model-facing message: the surface's framing, then each hit with its correction. */
export function formatHits(intro, hits) {
  const lines = [intro, ''];
  for (const { rule, sentence } of hits) {
    lines.push(`[${rule.id}] ${rule.description}`);
    lines.push(`  Sentence: "${sentence}"`);
    lines.push(`  Correction: ${rule.correction}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * The final assistant message of the turn. Both hosts now send it as
 * `last_assistant_message`; older Claude Code sends only `transcript_path`,
 * whose trailing assistant entries after the last user entry are that message.
 */
export function finalAssistantText(payload) {
  if (typeof payload?.last_assistant_message === 'string') return payload.last_assistant_message;
  if (typeof payload?.transcript_path !== 'string' || !payload.transcript_path) return '';
  const lines = readFileSync(payload.transcript_path, 'utf8').split('\n');
  const parts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry?.type === 'user') break;
    if (entry?.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (typeof content === 'string') parts.unshift(content);
    else if (Array.isArray(content)) {
      parts.unshift(...content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text));
    }
  }
  return parts.join('\n');
}

/**
 * The hook decision for one payload:
 *
 *   { output }   Stop hit: print `output` ({decision, reason}), exit 0
 *   null         no opinion: print {}, exit 0
 *
 * Throws only on a broken book or an unreadable transcript; the adapter treats
 * any throw as null.
 */
export function decideTeamRules(payload, { book = TEAM_RULES } = {}) {
  if (!book || !payload || typeof payload !== 'object') return null;
  if (payload.hook_event_name !== 'Stop') return null;
  if (payload.stop_hook_active) return null; // once per turn

  const cwd = typeof payload.cwd === 'string' && payload.cwd
    ? payload.cwd
    : process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!findRegistry(cwd)) return null;

  const compiled = compileRuleBook(book);
  const hits = unique(scanText(finalAssistantText(payload), 'agent_text', compiled));
  if (!hits.length) return null;
  return { output: { decision: 'block', reason: formatHits(compiled.surfaces.agent_text?.intro || '', hits) } };
}
