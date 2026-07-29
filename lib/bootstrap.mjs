/**
 * SessionStart bootstrap text — host-neutral.
 *
 * Turns a workspace directory plus a session `source` into the flat shape
 * { additionalContext?, systemMessage?, initialUserMessage? }. Wrapping that in
 * a host's wire envelope is lib/hook.mjs's job; deciding *what to say* is this
 * file's, and it says the same thing to every host. The instruction is the
 * product, so it must not exist in two copies that quietly diverge.
 *
 * SessionStart runs BEFORE MCP servers finish connecting on both hosts, so
 * nothing here inspects connection or auth state — it only injects the standing
 * instruction (call init_session for the right project) and lets the model act
 * on it once MCP is up.
 *
 * Confinement is by file presence: a workspace with no `.catwrangler` gets a
 * one-line nudge and no model instruction. That makes the plugin safe to install
 * user-global — it stays quiet everywhere except real CatWrangler workspaces,
 * with no directory allowlist to maintain.
 */

import { readFileSync } from 'node:fs';
import { registryPath } from './registry.mjs';

/**
 * Sources where an injected first turn is wanted, and where the not-connected
 * nudge is allowed to appear. `clear` and `compact` are mid-session events —
 * asking for a fresh "what's new" catch-up after a compact would be wrong, and
 * re-nagging about an unconnected directory mid-session is noise. `fork` is
 * Claude Code only; Codex never sends it, which costs nothing.
 */
const TURN_SOURCES = new Set(['startup', 'resume', 'fork']);

/**
 * Build the bootstrap output for a session.
 *
 * Returns null when there is nothing to say at all. `initialUserMessage` is
 * always populated when the source warrants one; hosts that cannot create an
 * opening turn drop it at the envelope layer rather than here, so the decision
 * about what a session needs stays in one place.
 */
export function buildBootstrap({ cwd, source }) {
  const src = typeof source === 'string' ? source : 'startup';

  // Locate the workspace descriptor. Its presence is the enable signal.
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(registryPath(cwd), 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // No .catwrangler here: the plugin is installed but this directory has no
      // project connected yet. Emit a one-line, user-facing nudge toward
      // /catwrangler:connect, and nothing for the model — there is no project to
      // connect to, so no bootstrap instruction belongs here.
      if (!TURN_SOURCES.has(src)) return null;
      return {
        systemMessage:
          '\n\n' +
          'CatWrangler: not connected to a project in this directory.\n' +
          '  - Run /catwrangler:connect to see your projects and connect to one.',
      };
    }
    // File exists but is unreadable/malformed — tell the user, don't guess.
    return {
      systemMessage:
        '\n\nCatWrangler: found a .catwrangler file but could not parse it.\n' +
        '  - Fix or regenerate it, or run /catwrangler:connect.',
    };
  }

  const projects = Array.isArray(manifest.projects) ? manifest.projects : [];
  const server = manifest.server || manifest.mcp_url || 'the CatWrangler MCP server';

  // Build the model-facing instruction. Selection is stated, never inferred:
  // one project → connect to it; several → pick by task or ask; unknown → ask
  // the server for the authoritative list rather than trusting this cache.
  const lines = [];
  lines.push('This is a CatWrangler workspace. Before doing ANY work on the project, call the `catwrangler` MCP server\'s `init_session` tool. It returns your full working protocol and context — follow what it returns.');
  lines.push('When the project you connect to carries an `id` below, pass that id to init_session as its `project_id` parameter — it pins the exact project. Only fall back to the slug when no id is recorded.');

  if (projects.length === 1) {
    const p = projects[0];
    const idNote = p.id ? ` (id \`${p.id}\`)` : '';
    lines.push(`One project is configured here: **${p.slug}**${p.name ? ` (${p.name})` : ''}${idNote}. Call init_session for it${p.id ? ' with that id' : ''}.`);
  } else if (projects.length > 1) {
    lines.push('Projects reachable in this workspace:');
    for (const p of projects) {
      const name = p.name ? ` (${p.name})` : '';
      const id = p.id ? ` [id ${p.id}]` : '';
      const desc = p.description ? ` — ${p.description}` : '';
      lines.push(`  • ${p.slug}${name}${id}${desc}`);
    }
    lines.push('Pick the project that matches the user\'s task and call init_session for it, passing its `id` above. If more than one plausibly applies and it is ambiguous, ask the user which — do not guess.');
  } else {
    lines.push('No projects are registered in .catwrangler. Call init_session to retrieve the authoritative list of projects this user can reach, then proceed.');
  }

  // Identity discipline: init_session mints an agent_id that must ride every
  // later call, kept separate per instance (anti-cross), recoverable on reconnect.
  lines.push('init_session returns an `agent_id`. Remember it, and include it as `_agent_id: "<agent_id>"` in the body of EVERY subsequent call to this server — calls without it are rejected. Each CatWrangler instance you connect to issues its OWN agent_id; use the matching one per server and never reuse one instance\'s agent_id on another. After an AUTH_REQUIRED error or a reconnect, call init_session with `reclaim_agent_id: "<agent_id>"` to recover without losing your branch or work — do not re-init without it.');

  // No local source: all project code and decisions live on the server.
  lines.push('You have NO local source code or decision files for the project — it all lives on the CatWrangler server behind its SCCS gates. Use the server\'s MCP tools (get_task_briefing, grep_code, read_code, list_files, search_decisions) for ALL code and decision access; do NOT use local file tools (Read, Grep, Glob, cat) to explore the project. The only local files are CLAUDE.md and Docs/.');

  lines.push('This .catwrangler file is a convenience cache, not the source of truth. If the user references a project not registered here, call init_session to get the authoritative, current list from the server.');

  // The opening turn. Unlike additionalContext, which attaches to a turn the
  // user starts, this CREATES one — so it only matters in non-interactive runs,
  // where a session would otherwise begin work without ever connecting.
  const target =
    projects.length === 1
      ? `\`${projects[0].slug}\``
      : projects.length > 1
        ? 'the project that fits my task (ask me if it is ambiguous)'
        : 'the project this workspace can reach';
  const initialUserMessage = TURN_SOURCES.has(src)
    ? `Connect to CatWrangler: call init_session for ${target}, then tell me what's new — recent decisions, active conflicts, and anything waiting on me. Keep it short.`
    : null;

  // Build the concise user-facing notice.
  const names = projects.map((p) => p.slug).filter(Boolean);
  const shown = names.slice(0, 4).join(', ');
  const more = names.length > 4 ? `, +${names.length - 4} more` : '';
  // Hosts prefix this with something like "SessionStart:startup says:", so lead
  // with a blank line to clear it, then hang the details off the headline as an
  // indented list — it reads as one CatWrangler block rather than three loose
  // sentences the user has to attribute.
  const systemMessage =
    projects.length === 0
      ? ['', '', `CatWrangler workspace detected (${server}).`, '  - Retrieving your projects…'].join('\n')
      : [
          '',
          '',
          `CatWrangler workspace: ${projects.length} project${projects.length === 1 ? '' : 's'} available (${shown}${more}).`,
          `  - Connecting via ${server}.`,
          '  - Run /catwrangler:connect to manage projects.',
        ].join('\n');

  return { additionalContext: lines.join('\n'), initialUserMessage, systemMessage };
}
