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
 *   stdout = JSON: { additionalContext?, systemMessage? }
 *     additionalContext → added to the model's context (the instruction)
 *     systemMessage      → shown to the USER as a transcript notice
 *   exit 0 always (a hook failure must never block the session)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Emit hook output and exit cleanly. Never throw past this. */
function emit(out) {
  if (out && (out.additionalContext || out.systemMessage)) {
    process.stdout.write(JSON.stringify(out));
  }
  process.exit(0);
}

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
      // Not a CatWrangler workspace — stay silent.
      return emit(null);
    }
    // File exists but is unreadable/malformed — tell the user, don't guess.
    return emit({
      systemMessage:
        'CatWrangler: found a .catwrangler file but could not parse it. ' +
        'Fix or regenerate it, or run /cw-connect.',
    });
  }

  const projects = Array.isArray(manifest.projects) ? manifest.projects : [];
  const server = manifest.server || manifest.mcp_url || 'the CatWrangler MCP server';

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

  // Build the concise user-facing notice.
  const names = projects.map((p) => p.slug).filter(Boolean);
  const shown = names.slice(0, 4).join(', ');
  const more = names.length > 4 ? `, +${names.length - 4} more` : '';
  const summary =
    projects.length === 0
      ? `CatWrangler workspace detected (${server}). Retrieving your projects…`
      : `CatWrangler workspace: ${projects.length} project${projects.length === 1 ? '' : 's'} available (${shown}${more}). Connecting via ${server}. Run /cw-connect to manage projects.`;

  return emit({
    additionalContext: lines.join('\n'),
    systemMessage: summary,
  });
}

try {
  main();
} catch {
  // Absolute backstop — a hook must never crash the session.
  process.exit(0);
}
