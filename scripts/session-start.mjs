#!/usr/bin/env node
/**
 * CatWrangler SessionStart hook.
 *
 * Fires at the start of every Claude Code session where this plugin is enabled.
 * SessionStart runs BEFORE MCP servers finish connecting, so this script does
 * NOT inspect connection/auth state — it only INJECTS the standing instruction
 * (call init_session for the right project) and lets the model act on it once
 * MCP is up. This is the deterministic, app-less replacement for the old
 * "paste a URL + hand-write CLAUDE.md" bootstrap.
 *
 * Confinement: the script acts only when a `.catwrangler` file is present in the
 * session's working directory. No file → silent no-op. That makes the plugin
 * safe to install user-global: it stays quiet everywhere except real CatWrangler
 * workspaces, with no directory allowlist to maintain.
 *
 * Contract (Claude Code hooks):
 *   stdin  = JSON: { cwd, source, session_id, hook_event_name, ... }
 *   stdout = JSON: {
 *     systemMessage?: string,              // top-level: shown to the USER
 *     hookSpecificOutput?: {               // event-scoped: read by the MODEL
 *       hookEventName: "SessionStart",
 *       additionalContext?: string,        // attaches to a turn the user starts
 *       initialUserMessage?: string        // CREATES the opening turn (-p only)
 *     }
 *   }
 *   exit 0 always (a hook failure must never block the session)
 *
 * The nesting matters: additionalContext is only read inside hookSpecificOutput
 * with a matching hookEventName. Emitted at the top level it is silently
 * ignored — the user still sees systemMessage, so the hook looks like it worked
 * while the model never receives the bootstrap instruction.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Emit hook output and exit cleanly. Takes the flat shape
 * { additionalContext?, systemMessage? } and writes the wire shape Claude Code
 * expects, nesting additionalContext under hookSpecificOutput. Never throw past
 * this.
 */
function emit(out) {
  if (!out || (!out.additionalContext && !out.systemMessage)) process.exit(0);

  const payload = {};
  if (out.systemMessage) payload.systemMessage = out.systemMessage;
  if (out.additionalContext || out.initialUserMessage) {
    payload.hookSpecificOutput = { hookEventName: 'SessionStart' };
    if (out.additionalContext) {
      payload.hookSpecificOutput.additionalContext = out.additionalContext;
    }
    if (out.initialUserMessage) {
      payload.hookSpecificOutput.initialUserMessage = out.initialUserMessage;
    }
  }
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

/**
 * Sources where an injected first turn is wanted. `clear` and `compact` are
 * mid-session events — Claude Code ignores initialUserMessage there anyway, and
 * asking for a fresh "what's new" catch-up after a compact would be wrong even
 * if it didn't.
 */
const TURN_SOURCES = new Set(['startup', 'resume', 'fork']);

/** Read all of stdin synchronously; tolerate an empty/absent payload. */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  let input = {};
  try {
    const raw = readStdin();
    if (raw.trim()) input = JSON.parse(raw);
  } catch {
    // Malformed hook payload — fall back to env/cwd below.
  }

  const cwd =
    input.cwd ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();

  // Locate the workspace descriptor. Its presence is the enable signal.
  let manifest;
  try {
    const text = readFileSync(join(cwd, '.catwrangler'), 'utf8');
    manifest = JSON.parse(text);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // No .catwrangler here: the plugin is installed but this directory has no
      // project connected yet. Emit a one-line, user-facing nudge toward
      // /catwrangler:connect, and nothing for the model — there is no project to
      // connect to, so no bootstrap instruction belongs here. Limited to real
      // session starts (not clear/compact) so it never re-nags mid-session.
      const src = typeof input.source === 'string' ? input.source : 'startup';
      if (!TURN_SOURCES.has(src)) return emit(null);
      return emit({
        systemMessage:
          '\n\n' +
          'CatWrangler: not connected to a project in this directory.\n' +
          '  - Run /catwrangler:connect to see your projects and connect to one.',
      });
    }
    // File exists but is unreadable/malformed — tell the user, don't guess.
    return emit({
      systemMessage:
        '\n\nCatWrangler: found a .catwrangler file but could not parse it.\n' +
        '  - Fix or regenerate it, or run /catwrangler:connect.',
    });
  }

  const projects = Array.isArray(manifest.projects) ? manifest.projects : [];
  const server = manifest.server || manifest.mcp_url || 'the CatWrangler MCP server';
  const source = typeof input.source === 'string' ? input.source : 'startup';

  // Build the model-facing instruction. Selection is stated, never inferred:
  // one project → connect to it; several → pick by task or ask; unknown → ask
  // the server for the authoritative list rather than trusting this cache.
  const lines = [];
  lines.push('This is a CatWrangler workspace. Before doing ANY work on the project, call the `catwrangler` MCP server\'s `init_session` tool. It returns your full working protocol and context — follow what it returns.');

  if (projects.length === 1) {
    const p = projects[0];
    lines.push(`One project is configured here: **${p.slug}**${p.name ? ` (${p.name})` : ''}. Call init_session for it.`);
  } else if (projects.length > 1) {
    lines.push('Projects reachable in this workspace:');
    for (const p of projects) {
      const name = p.name ? ` (${p.name})` : '';
      const desc = p.description ? ` — ${p.description}` : '';
      lines.push(`  • ${p.slug}${name}${desc}`);
    }
    lines.push('Pick the project that matches the user\'s task and call init_session for it. If more than one plausibly applies and it is ambiguous, ask the user which — do not guess.');
  } else {
    lines.push('No projects are listed in .catwrangler. Call init_session to retrieve the authoritative list of projects this user can reach, then proceed.');
  }

  // Identity discipline: init_session mints an agent_id that must ride every
  // later call, kept separate per instance (anti-cross), recoverable on reconnect.
  lines.push('init_session returns an `agent_id`. Remember it, and include it as `_agent_id: "<agent_id>"` in the body of EVERY subsequent call to this server — calls without it are rejected. Each CatWrangler instance you connect to issues its OWN agent_id; use the matching one per server and never reuse one instance\'s agent_id on another. After an AUTH_REQUIRED error or a reconnect, call init_session with `reclaim_agent_id: "<agent_id>"` to recover without losing your branch or work — do not re-init without it.');

  // No local source: all project code and decisions live on the server.
  lines.push('You have NO local source code or decision files for the project — it all lives on the CatWrangler server behind its SCCS gates. Use the server\'s MCP tools (get_task_briefing, grep_code, read_code, list_files, search_decisions) for ALL code and decision access; do NOT use local file tools (Read, Grep, Glob, cat) to explore the project. The only local files are CLAUDE.md and Docs/.');

  lines.push('This .catwrangler file is a convenience cache, not the source of truth. If the user references a project not listed here, call init_session to get the authoritative, current list from the server.');

  // The opening turn. Unlike additionalContext, which attaches to a turn the
  // user starts, this CREATES one — so it only lands in non-interactive (-p)
  // runs, where a session would otherwise begin work without ever connecting.
  // Interactive sessions ignore it and rely on additionalContext above.
  const target =
    projects.length === 1
      ? `\`${projects[0].slug}\``
      : projects.length > 1
        ? 'the project that fits my task (ask me if it is ambiguous)'
        : 'the project this workspace can reach';
  const initialUserMessage = TURN_SOURCES.has(source)
    ? `Connect to CatWrangler: call init_session for ${target}, then tell me what's new — recent decisions, active conflicts, and anything waiting on me. Keep it short.`
    : null;

  // Build the concise user-facing notice.
  const names = projects.map((p) => p.slug).filter(Boolean);
  const shown = names.slice(0, 4).join(', ');
  const more = names.length > 4 ? `, +${names.length - 4} more` : '';
  // Claude Code prefixes this with "SessionStart:startup says:", so lead with a
  // blank line to clear it, then hang the details off the headline as an
  // indented list — it reads as one CatWrangler block rather than three loose
  // sentences the user has to attribute.
  const summary =
    projects.length === 0
      ? [
          '',
          '',
          `CatWrangler workspace detected (${server}).`,
          '  - Retrieving your projects…',
        ].join('\n')
      : [
          '',
          '',
          `CatWrangler workspace: ${projects.length} project${projects.length === 1 ? '' : 's'} available (${shown}${more}).`,
          `  - Connecting via ${server}.`,
          '  - Run /catwrangler:connect to manage projects.',
        ].join('\n');

  return emit({
    additionalContext: lines.join('\n'),
    initialUserMessage,
    systemMessage: summary,
  });
}

try {
  main();
} catch {
  // Absolute backstop — a hook must never crash the session.
  process.exit(0);
}
