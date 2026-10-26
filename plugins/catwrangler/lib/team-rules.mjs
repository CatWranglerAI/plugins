/**
 * The team-work rule book (cw:d-4664): load it, match text against it, and
 * decide the PreToolUse and Stop hooks. Host-neutral, like the rest of lib/.
 *
 * CatWrangler runs agents concurrently by design. Every agent has its own
 * branch, and each merge reconciles that branch against current trunk,
 * including edits to the same file and the same lines. An agent that fences
 * files off from its workers, or holds work back until another worker merges,
 * spends an hour buying a safety the merge already provides, and it does so
 * silently. The rules that catch it live in team-rules.json, not here, because
 * they are data other clients read too: the CatWrangler Harness applies the
 * same book to its own `task` tool. This file is one reader of that book and
 * holds no rule of its own.
 *
 * Two surfaces, two hooks:
 *
 *   worker_brief  PreToolUse on the tools that start workers (Agent/Task, and
 *                 a Bash command that launches `claude -p` or `codex exec`,
 *                 including a prompt read from a file). A hit BLOCKS the call:
 *                 the adapter exits 2 and the message, on stderr, quotes each
 *                 offending sentence with its correction so the model rewrites
 *                 the brief and launches again. Nothing is rewritten silently.
 *   agent_text    Stop. A final message that holds independent work back to
 *                 avoid conflicts blocks the stop once (`stop_hook_active`
 *                 marks the retry), with the correction as the reason.
 *
 * Both are confined to CatWrangler workspaces by the same registry hunt as the
 * bootstrap. The plugin is installed user-global, and outside a workspace
 * nothing reconciles concurrent edits, so the rules do not hold there.
 *
 * Every entry point fails open. A rule book that will not load or compile, a
 * prompt file that cannot be read, a payload of an unexpected shape: each is
 * "no opinion", never a block. A broken hook must never stop work.
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
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
 * that does not compile; the hook adapters catch that and fail open.
 */
export function compileRuleBook(book) {
  const compile = (source) => new RegExp(source, book.flags || '');
  return {
    surfaces: book.surfaces || {},
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

/** Every { rule, sentence } hit in `text` for one surface: `worker_brief` or `agent_text`. */
export function scanText(text, surface, compiled) {
  const hits = [];
  for (const sentence of splitSentences(text)) {
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

/** A Bash command that starts a headless worker: `claude -p` / `--print`, or `codex exec`. */
const WORKER_LAUNCH = /\bclaude\b[^\n|;&]*?\s(?:-p|--print)\b|\bcodex\b[^\n|;&]*?\bexec\b/;

/**
 * Where a launch command reads its prompt from a file. Each capture is one or
 * more shell words naming the file.
 */
const PROMPT_FILE_REFERENCES = [
  /\$\(\s*cat\s+([^)]+)\)/g, //            claude -p "$(cat brief.md)"
  /`\s*cat\s+([^`]+)`/g, //                claude -p "`cat brief.md`"
  /\bcat\s+([^|;&\n)`]+?)\s*\|/g, //       cat brief.md | claude -p
  /(?<!<)<(?![<(])\s*("[^"]*"|'[^']*'|[^\s<>|;&)]+)/g, // codex exec - < brief.md
];

const SHELL_WORD = /"([^"]*)"|'([^']*)'|((?:\\.|\S)+)/g;

/** Resolve one shell word to a readable path, or null for anything still unexpanded. */
function resolvePromptPath(word, cwd) {
  const home = homedir();
  const path = word.replace(/^(?:\$HOME|\$\{HOME\}|~)(?=\/|$)/, home);
  if (!path || path.startsWith('-') || path.startsWith('<') || /[$`*?]/.test(path)) return null;
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function promptFiles(command, cwd) {
  const paths = new Set();
  for (const reference of PROMPT_FILE_REFERENCES) {
    for (const match of command.matchAll(reference)) {
      for (const word of match[1].matchAll(SHELL_WORD)) {
        const path = resolvePromptPath(word[1] ?? word[2] ?? word[3].replace(/\\(.)/g, '$1'), cwd);
        if (path) paths.add(path);
      }
    }
  }
  return [...paths];
}

/** A prompt file's text, or '' when it cannot be read: an unreadable file is no opinion. */
function readPromptFile(path) {
  try {
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

/**
 * The worker brief(s) in a PreToolUse payload. A shell command counts only when
 * it launches a worker, and then the whole command is scanned (an inline or
 * heredoc prompt lives there) along with every prompt file it reads. Any other
 * tool the hook is matched on is a worker-starting tool, whose brief is its
 * `prompt` (Claude Code's Agent/Task) or `message` (Codex spawn_agent).
 */
export function workerBriefs(payload, cwd) {
  const input = payload?.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const command = Array.isArray(input.command) ? input.command.join(' ') : input.command;
  if (typeof command === 'string') {
    if (!WORKER_LAUNCH.test(command)) return [];
    // A double quote bounds an inline prompt, so it bounds a sentence too:
    // otherwise the quoted sentence would carry the whole command line with it.
    const inline = command.replaceAll('"', '\n');
    return [inline, ...promptFiles(command, cwd).map(readPromptFile)].filter(Boolean);
  }
  return [input.prompt, input.message].filter((text) => typeof text === 'string' && text.trim());
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
 *   { block: true, message }   PreToolUse hit: exit 2, message on stderr
 *   { output }                 Stop hit: print `output` ({decision, reason}), exit 0
 *   null                       no opinion: print {}, exit 0
 *
 * Throws only on a broken book or an unreadable transcript; the adapters treat
 * any throw as null.
 */
export function decideTeamRules(payload, { book = TEAM_RULES } = {}) {
  if (!book || !payload || typeof payload !== 'object') return null;
  const event = payload.hook_event_name;
  if (event !== 'PreToolUse' && event !== 'Stop') return null;
  if (event === 'Stop' && payload.stop_hook_active) return null; // once per turn

  const cwd = typeof payload.cwd === 'string' && payload.cwd
    ? payload.cwd
    : process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!findRegistry(cwd)) return null;

  const compiled = compileRuleBook(book);
  if (event === 'PreToolUse') {
    const hits = unique(workerBriefs(payload, cwd).flatMap((text) => scanText(text, 'worker_brief', compiled)));
    if (!hits.length) return null;
    return { block: true, message: formatHits(compiled.surfaces.worker_brief?.intro || '', hits) };
  }

  const hits = unique(scanText(finalAssistantText(payload), 'agent_text', compiled));
  if (!hits.length) return null;
  return { output: { decision: 'block', reason: formatHits(compiled.surfaces.agent_text?.intro || '', hits) } };
}
