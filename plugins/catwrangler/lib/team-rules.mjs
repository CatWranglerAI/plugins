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
 * Only instruction is matched (cw:d-4739). Quoted text is evidence: a log
 * line, an error, a code block. On the surfaces the book lists under
 * `quoted_is_evidence` it is masked before matching. And of a Bash command,
 * only what the launched worker reads is its brief: the launch's own words,
 * heredocs and prompt files, never a grep or sed argument beside it.
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

/** Every { rule, sentence } hit in `text` for one surface: `worker_brief` or `agent_text`. */
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
 * A Bash command that may start a headless worker: `claude -p` / `--print`, or
 * `codex exec`. A cheap first look only; the shell parse below decides.
 */
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

const HEREDOC = /(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][\w-]*))/g;
const heredocMark = (index) => `__cw_heredoc_${index}__`;

/**
 * The command with each heredoc body cut out and its `<<DELIM` replaced by a
 * marker word, so the shell parse never reads a body as commands. The bodies
 * come back by index; a body with no closing line runs to the end.
 */
function cutHeredocs(command) {
  const lines = command.split('\n');
  const bodies = [];
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const pending = [];
    out.push(lines[i].replace(HEREDOC, (_, dash, single, double, bare) => {
      pending.push({ dash, delimiter: single ?? double ?? bare });
      return ` ${heredocMark(bodies.length + pending.length - 1)} `;
    }));
    for (const { dash, delimiter } of pending) {
      const body = [];
      while (++i < lines.length && (dash ? lines[i].replace(/^\t+/, '') : lines[i]).trim() !== delimiter) body.push(lines[i]);
      bodies.push(body.join('\n'));
    }
  }
  return { text: out.join('\n'), bodies };
}

/** The index just past the `)` closing a `$(` whose body starts at `i`. */
function closeSubstitution(text, i) {
  for (let depth = 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === "'") i = text.indexOf("'", i + 1) < 0 ? text.length : text.indexOf("'", i + 1);
    else if (c === '"') i = readDoubleQuoted(text, i + 1).end - 1;
    else if (c === '`') i = text.indexOf('`', i + 1) < 0 ? text.length : text.indexOf('`', i + 1);
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return text.length;
}

/**
 * A double-quoted string whose body starts at `i`: its value and the index past
 * the closing quote. A command substitution inside it stands as a space in the
 * value, because the worker reads its output, not its text.
 */
function readDoubleQuoted(text, i) {
  let value = '';
  while (i < text.length && text[i] !== '"') {
    const c = text[i];
    if (c === '\\' && '$`"\\\n'.includes(text[i + 1] ?? '')) {
      value += text[i + 1] === '\n' ? '' : text[i + 1];
      i += 2;
    } else if (c === '$' && text[i + 1] === '(') {
      value += ' ';
      i = closeSubstitution(text, i + 2);
    } else if (c === '`') {
      value += ' ';
      i = text.indexOf('`', i + 1) < 0 ? text.length : text.indexOf('`', i + 1) + 1;
    } else {
      value += c;
      i++;
    }
  }
  return { value, end: i + 1 };
}

const REDIRECT = /^(?:<<<|<>|<&|>&|>>|>\||&>>|&>|<|>)/;

/**
 * A shell command split into simple commands, each with its words (unquoted
 * values, redirections as `{ redirect }`), its source span, and the operator
 * that ends it. Enough of POSIX sh to find a launch and its arguments; anything
 * it does not model reads as ordinary word characters.
 */
function shellCommands(text) {
  const commands = [];
  let words = [];
  let word = null;
  let start = 0;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '\\') {
      word = (word ?? '') + (text[i + 1] === '\n' ? '' : text[i + 1] ?? '');
      i += 2;
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close < 0 ? text.length : close;
      word = (word ?? '') + text.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      const { value, end } = readDoubleQuoted(text, i + 1);
      word = (word ?? '') + value;
      i = end;
    } else if (c === '$' && text[i + 1] === '(') {
      word = (word ?? '') + ' ';
      i = closeSubstitution(text, i + 2);
    } else if (c === '`') {
      const close = text.indexOf('`', i + 1);
      word = (word ?? '') + ' ';
      i = close < 0 ? text.length : close + 1;
    } else if (c === '#' && word === null) {
      const newline = text.indexOf('\n', i);
      i = newline < 0 ? text.length : newline;
    } else if (REDIRECT.test(text.slice(i, i + 3))) {
      // A file-descriptor number before the operator (2>&1) is not a word.
      if (word !== null && !/^\d+$/.test(word)) words.push(word);
      word = null;
      const op = text.slice(i, i + 3).match(REDIRECT)[0];
      words.push({ redirect: op });
      i += op.length;
    } else if (c === '|' || c === '&' || c === ';' || c === '\n') {
      endWord();
      const op = /^(?:\|\||&&|;;|\|&)/.test(text.slice(i, i + 2)) ? text.slice(i, i + 2) : c;
      commands.push({ words, start, end: i, op });
      words = [];
      i += op.length;
      start = i;
    } else if (/\s/.test(c)) {
      endWord();
      i++;
    } else {
      word = (word ?? '') + c;
      i++;
    }
  }
  endWord();
  commands.push({ words, start, end: text.length, op: null });
  return commands;
}

/**
 * Where a simple command launches a worker: the index of its `claude` / `codex`
 * word, when a later word makes it `claude -p` / `--print` or `codex exec`.
 */
function findLaunch(words) {
  for (let k = 0; k < words.length; k++) {
    if (typeof words[k] !== 'string') continue;
    const program = words[k].split(/[\\/]/).pop().replace(/\.(?:exe|cmd)$/i, '');
    const rest = words.slice(k + 1).filter((w) => typeof w === 'string');
    if (program === 'claude' && rest.some((w) => w === '-p' || w === '--print' || w.startsWith('--print='))) return { k, program };
    if (program === 'codex' && rest.includes('exec')) return { k, program };
  }
  return null;
}

/**
 * The prompt text a launch command line hands its worker: the launch's own
 * argument words (options aside), here-strings, and the heredocs and prompt
 * files of its pipeline. A word that is itself a launch command line, as in
 * `bash -lc 'codex exec ...'`, is read the same way.
 */
function launchPrompts(command, cwd, bodies) {
  const texts = [];
  const commands = Array.isArray(command)
    ? [{ words: command.map(String), start: 0, end: 0, op: null }]
    : shellCommands(command);
  const source = Array.isArray(command) ? '' : command;
  for (let n = 0; n < commands.length; n++) {
    const { words } = commands[n];
    for (const word of words) {
      if (typeof word === 'string' && /\s/.test(word) && WORKER_LAUNCH.test(word)) texts.push(...launchPrompts(word, cwd, bodies));
    }
    const launch = findLaunch(words);
    if (!launch) continue;
    let skipTarget = false;
    let subcommand = launch.program === 'codex';
    for (const word of words.slice(launch.k + 1)) {
      if (typeof word !== 'string') {
        skipTarget = word.redirect !== '<<<';
        continue;
      }
      if (skipTarget) { skipTarget = false; continue; }
      if (subcommand && word === 'exec') { subcommand = false; continue; }
      if (word.startsWith('-') || !word.trim()) continue;
      texts.push(word);
    }
    // The pipeline this launch belongs to: commands joined by `|` around it.
    let first = n;
    while (first > 0 && commands[first - 1].op?.startsWith('|') && commands[first - 1].op !== '||') first--;
    let last = n;
    while (last < commands.length - 1 && commands[last].op?.startsWith('|') && commands[last].op !== '||') last++;
    const pipeline = source.slice(commands[first].start, commands[last].end);
    for (const [, index] of pipeline.matchAll(/__cw_heredoc_(\d+)__/g)) texts.push(bodies[Number(index)]);
    texts.push(...promptFiles(pipeline, cwd).map(readPromptFile));
  }
  return texts;
}

/**
 * The worker brief(s) in a PreToolUse payload. A shell command counts only when
 * it launches a worker, and then only what that worker reads is its brief: the
 * launch's prompt words, here-strings, heredocs and prompt files. The rest of
 * the command line, a grep or sed argument beside the launch, is not. Any other
 * tool the hook is matched on is a worker-starting tool, whose brief is its
 * `prompt` (Claude Code's Agent/Task) or `message` (Codex spawn_agent).
 */
export function workerBriefs(payload, cwd) {
  const input = payload?.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const command = input.command;
  if (typeof command === 'string' || Array.isArray(command)) {
    if (!WORKER_LAUNCH.test(Array.isArray(command) ? command.join(' ') : command)) return [];
    const { text, bodies } = Array.isArray(command) ? { text: command, bodies: [] } : cutHeredocs(command);
    return launchPrompts(text, cwd, bodies).filter((brief) => typeof brief === 'string' && brief.trim());
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
