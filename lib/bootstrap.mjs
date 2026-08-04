/**
 * SessionStart bootstrap text — host-neutral.
 *
 * Turns a workspace directory plus a session `source` into the flat shape
 * { additionalContext?, systemMessage? }. Wrapping that in a host's wire
 * envelope is lib/hook.mjs's job; deciding *what to say* is this file's, and it
 * says the same thing to every host. The instruction is the product, so it must
 * not exist in two copies that quietly diverge.
 *
 * Nothing here starts a turn. The bootstrap instructs and then gets out of the
 * way: the model reads it alongside whatever the user actually opened the
 * session to do, and connects as part of doing that. An earlier version also
 * emitted `initialUserMessage`, which Claude Code turns into a synthetic user
 * turn asking for a catch-up briefing. It was meant for headless runs, but it
 * fired on every startup, resume, and fork, so an interactive session opened
 * with a report nobody requested — and headless `claude -p` already supplies a
 * turn for the context to attach to. Injecting a turn is a much larger claim on
 * the session than injecting context; do not reintroduce it without one.
 *
 * SessionStart runs BEFORE MCP servers finish connecting on both hosts, so
 * nothing here inspects connection or auth state — it only injects the standing
 * instruction (call init_session for the right project) and lets the model act
 * on it once MCP is up.
 *
 * Confinement is by file presence: a workspace with no `.catwrangler` in scope
 * gets a one-line nudge and no model instruction. That makes the plugin safe to
 * install user-global — it stays quiet everywhere except real CatWrangler
 * workspaces, with no directory allowlist to maintain.
 *
 * "In scope" means the hunt in registry.mjs: cwd, then every ancestor, then the
 * home directory, nearest wins. Sessions start wherever the work is, which is
 * usually not the top of the repo, so a cwd-only check made a configured
 * workspace look unconfigured from any subdirectory of it.
 */

import { findRegistry, readRegistryFile } from './registry.mjs';
import {
  SESSION_PROTOCOL,
  SUBAGENT_OPENING,
  SUBAGENT_PROTOCOL,
  AGENT_ID_RULE,
  NO_LOCAL_FILES_RULE,
  SERVER_AUTHORITY_RULE,
  NO_RECONNECT_NEEDED,
} from './protocol.mjs';

/**
 * Sources where the not-connected nudge is allowed to appear. `clear` and
 * `compact` are mid-session events, and re-nagging about an unconnected
 * directory mid-session is noise. `fork` is Claude Code only; Codex never sends
 * it, which costs nothing.
 */
const NUDGE_SOURCES = new Set(['startup', 'resume', 'fork']);

/**
 * The two opening instructions.
 *
 * They live here rather than in protocol.mjs because they are about the
 * registry — which project, and how to name it — and bootstrap.mjs is the only
 * module that reads it.
 *
 * PROJECT_ID_LINE is a constant because both builders emit it verbatim, and two
 * copies of an instruction is the drift this plugin keeps designing against.
 * INIT_SESSION_LINE opens the session bootstrap only: the sub-agent path opens
 * with SUBAGENT_OPENING instead, which says the same thing after first saying
 * what the agent is. It stays a named constant for symmetry with its sibling
 * rather than because it is shared.
 */
const INIT_SESSION_LINE =
  'This is a CatWrangler workspace. Before doing ANY work on the project, call the `catwrangler` MCP server\'s `init_session` tool. It returns your full working protocol and context — follow what it returns.';
const PROJECT_ID_LINE =
  'When the project you connect to carries an `id` below, pass that id to init_session as its `project_id` parameter — it pins the exact project. Only fall back to the slug when no id is recorded.';

/**
 * Build the bootstrap output for a session.
 *
 * Returns null when there is nothing to say at all.
 */
export function buildBootstrap({ cwd, source }) {
  const src = typeof source === 'string' ? source : 'startup';

  // Locate the workspace descriptor — cwd, ancestors, then home. Its presence is
  // the enable signal.
  const found = findRegistry(cwd);
  if (!found) {
    // Nothing in scope: the plugin is installed but no project is connected
    // anywhere above this directory. Emit a one-line, user-facing nudge toward
    // /catwrangler:connect, and nothing for the model — there is no project to
    // connect to, so no bootstrap instruction belongs here.
    if (!NUDGE_SOURCES.has(src)) return null;
    return {
      systemMessage:
        '\n\n' +
        'CatWrangler: not connected to a project in this directory.\n' +
        '  - Run /catwrangler:connect to see your projects and connect to one.',
    };
  }

  let manifest;
  try {
    manifest = readRegistryFile(found.path);
  } catch {
    // The file exists but is unreadable/malformed — tell the user, don't guess.
    // Name the path: with the hunt it may be one the user did not know applied
    // here, and "your .catwrangler is broken" is unactionable without it.
    return {
      systemMessage:
        '\n\nCatWrangler: found a .catwrangler file but could not parse it.\n' +
        `  - ${found.path}\n` +
        '  - Fix or regenerate it, or run /catwrangler:connect.',
    };
  }

  const projects = Array.isArray(manifest.projects) ? manifest.projects : [];
  const server = manifest.server || manifest.mcp_url || 'the CatWrangler MCP server';

  // Build the model-facing instruction. Selection is stated, never inferred:
  // one project → connect to it; several → pick by task or ask; unknown → ask
  // the server for the authoritative list rather than trusting this cache.
  const lines = [];
  lines.push(INIT_SESSION_LINE);
  lines.push(PROJECT_ID_LINE);

  if (projects.length === 1) {
    const p = projects[0];
    const idNote = p.id ? ` (id \`${p.id}\`)` : '';
    // Nothing to disambiguate against, but the description still orients the
    // session on what it is about to work on, so it is worth the line.
    const desc = p.description ? ` — ${p.description}` : '';
    lines.push(`One project is configured here: **${p.slug}**${p.name ? ` (${p.name})` : ''}${idNote}${desc} Call init_session for it${p.id ? ' with that id' : ''}.`);
    if (p.web_url) lines.push(`  web: ${p.web_url}`);
  } else if (projects.length > 1) {
    lines.push('Projects reachable in this workspace:');
    for (const p of projects) {
      const name = p.name ? ` (${p.name})` : '';
      const id = p.id ? ` [id ${p.id}]` : '';
      const desc = p.description ? ` — ${p.description}` : '';
      lines.push(`  • ${p.slug}${name}${id}${desc}`);
      // The local routing note, on its own line so it reads as guidance rather
      // than more description. It is the user's own words; treat it that way.
      if (p.use_when) lines.push(`      use when: ${p.use_when}`);
      // Per project, not per workspace: behind the shared MCP lane every entry
      // has the same `mcp_url`, so this is the one line that differs, and the
      // one a session cannot reconstruct from anything else in the file.
      if (p.web_url) lines.push(`      web: ${p.web_url}`);
    }
    lines.push('Route by the `use when` lines first — they are this user\'s own statement of which project owns which work, and they outrank anything you would infer from a description. Call init_session for the project that fits, passing its `id` above.');
    lines.push('You may hold MORE THAN ONE of these open at once: a session can init_session into several projects and keep a separate agent_id per server. When you do, route every subsequent call by these same rules and send it with the agent_id belonging to that project\'s server — never let a call for one project ride another\'s session.');
    lines.push('If more than one project plausibly applies and it is genuinely ambiguous, ask the user which — do not guess. When they answer, or when they correct a choice you already made, make it stick: use the /catwrangler:connect skill to update that project\'s `use when` note. A correction you do not record is one they have to repeat next session.');
  } else {
    lines.push('.catwrangler names no projects. Call init_session to retrieve the authoritative list of projects this user can reach, then proceed.');
  }

  // What a `web:` line is for — stated once, and only when one was actually
  // printed. The risk it carries is specific: an agent handed an HTTP origin for
  // a project whose code it cannot read locally may treat the browser as the way
  // in, which routes around the SCCS gates the MCP tools exist to enforce. So the
  // line says what it is good for and, more importantly, what it does not change.
  if (projects.some((p) => p && p.web_url)) {
    lines.push('A `web:` line is that project\'s CatWrangler UI and HTTP API — the same instance you reach over MCP, seen from a browser. It does not change how you work: the MCP tools remain the way you read code, decisions, and history, because they are the path through this project\'s gates. Use the URL to hand the user a link when they want to look at something themselves, or to reach an HTTP endpoint when a task genuinely needs one and no MCP tool covers it. It is not a second route to the project\'s contents, and it is never a reason to skip init_session.');
  }

  // Where the answer came from. Only worth a line when it is not the obvious
  // place: a registry the user is not standing in still governs this session, and
  // the model needs the path to answer "why is this project connected?" or to
  // point /catwrangler:connect at the right file.
  if (found.scope === 'ancestor') {
    lines.push(`This came from \`${found.path}\`, in a parent of the current directory — it governs every directory beneath it.`);
  } else if (found.scope === 'home') {
    lines.push(`This came from \`${found.path}\`, the user's home registry — the fallback for directories no project claims. It applies because nothing between here and the filesystem root has its own \`.catwrangler\`. Adding a project from here creates one in the current directory rather than editing the home file.`);
  }

  // The standing rules — identity, where code lives, what the registry is worth.
  // Shared verbatim with /catwrangler:connect, which has to say the same thing to
  // a session the hook found nothing to bootstrap. See lib/protocol.mjs.
  lines.push(...SESSION_PROTOCOL);

  // A configured workspace connects itself, and that success is invisible. Say so,
  // or the user carries the first-run connect forward as a per-session chore.
  lines.push(NO_RECONNECT_NEEDED);

  // Build the concise user-facing notice.
  const names = projects.map((p) => p.slug).filter(Boolean);
  const shown = names.slice(0, 4).join(', ');
  const more = names.length > 4 ? `, +${names.length - 4} more` : '';
  // Hosts prefix this with something like "SessionStart:startup says:", so lead
  // with a blank line to clear it, then hang the details off the headline as an
  // indented list — it reads as one CatWrangler block rather than three loose
  // sentences the user has to attribute.
  // Name the registry only when it is somewhere the user would not think to
  // look. In cwd it is the assumed case and the line is pure noise; from a
  // parent or from home it is the answer to "why is this session connected to
  // that?", asked at the moment it would otherwise be surprising.
  const origin =
    found.scope === 'ancestor'
      ? [`  - From ${found.path} (a parent directory).`]
      : found.scope === 'home'
        ? [`  - From ${found.path} — your home registry, used where no project claims the directory.`]
        : [];

  const systemMessage =
    projects.length === 0
      ? ['', '', `CatWrangler workspace detected (${server}).`, ...origin, '  - Retrieving your projects…'].join('\n')
      : [
          '',
          '',
          // "available" is the OTHER state now — reachable but not set up here.
          // Saying it about the projects this workspace is wired to is exactly
          // the muddle the two-state model exists to remove.
          `CatWrangler workspace: ${projects.length} project${projects.length === 1 ? '' : 's'} connected (${shown}${more}).`,
          `  - Connecting via ${server}.`,
          ...origin,
          // "manage projects" read as "connect to a project", which is the one
          // thing this line is not for — the session above already did that.
          '  - Run /catwrangler:connect to connect or disconnect projects.',
        ].join('\n');

  return { additionalContext: lines.join('\n'), systemMessage };
}

/**
 * Build the bootstrap output for a SUB-AGENT spawn.
 *
 * Same job as buildBootstrap, different audience, and the differences are all
 * consequences of that:
 *
 *   - It returns model context and NEVER a systemMessage. A parent that fans out
 *     ten sub-agents would print ten CatWrangler banners restating what the
 *     session-start notice already said once. The user is not the audience of a
 *     sub-agent spawn.
 *   - Because there is no user-facing channel, every failure is silent. An
 *     unreadable `.catwrangler` returns null here where buildBootstrap reports
 *     it — the session-start hook already told the user, from a place they could
 *     act on it, and repeating it per spawn into a channel only the model reads
 *     helps nobody.
 *   - It says nothing about /catwrangler:connect, `web:` URLs, or which registry
 *     file won. Those answer questions a user asks. A sub-agent cannot run a
 *     slash command, does not hand out links, and has no stake in why this
 *     workspace is connected — only in what it is connected TO.
 *
 * Returns null when there is nothing to say, which is the common case: the hook
 * is installed user-global, so it fires for every sub-agent on the machine and
 * must be silent everywhere that is not a CatWrangler workspace.
 */
export function buildSubagentBootstrap({ cwd }) {
  // Same hunt as the session bootstrap — cwd, ancestors, then home. A sub-agent
  // usually starts in the parent's directory, but nothing guarantees it, and the
  // hunt is what makes a subdirectory still count as inside the workspace.
  const found = findRegistry(cwd);
  if (!found) return null;

  let manifest;
  try {
    manifest = readRegistryFile(found.path);
  } catch {
    // Malformed registry. Nothing useful to say into a model-only channel, and
    // no user channel to say it on — see the note above.
    return null;
  }

  const projects = Array.isArray(manifest.projects) ? manifest.projects : [];

  const lines = [];
  lines.push(SUBAGENT_OPENING);
  lines.push(PROJECT_ID_LINE);

  if (projects.length === 1) {
    const p = projects[0];
    const idNote = p.id ? ` (id \`${p.id}\`)` : '';
    const desc = p.description ? ` — ${p.description}` : '';
    lines.push(`One project is configured here: **${p.slug}**${p.name ? ` (${p.name})` : ''}${idNote}${desc} Call init_session for it${p.id ? ' with that id' : ''}.`);
  } else if (projects.length > 1) {
    lines.push('Projects reachable in this workspace:');
    for (const p of projects) {
      const name = p.name ? ` (${p.name})` : '';
      const id = p.id ? ` [id ${p.id}]` : '';
      const desc = p.description ? ` — ${p.description}` : '';
      lines.push(`  • ${p.slug}${name}${id}${desc}`);
      if (p.use_when) lines.push(`      use when: ${p.use_when}`);
    }
    // Where this genuinely departs from the session bootstrap. That one resolves
    // ambiguity by asking the user; a sub-agent has no user to ask, and the cost
    // of guessing is higher — a whole delegated slice lands in the wrong
    // project's gates, under the wrong decisions, on a branch the parent will
    // not think to look at.
    lines.push('Route by the `use when` lines first — they are this user\'s own statement of which project owns which work — and otherwise by the task your parent gave you. Call init_session for the project that fits, passing its `id` above.');
    lines.push('If more than one project plausibly applies and the task does not settle it, STOP and ask your parent which — do not guess, and do not spread one task across projects. Reporting that the routing is ambiguous is a useful result; picking wrong is expensive and looks like success.');
  } else {
    lines.push('.catwrangler names no projects. Call init_session to retrieve the authoritative list of projects this user can reach, then proceed.');
  }

  // The shared rules a sub-agent still needs, from the same constants the
  // session protocol composes — never a shortened restatement. REGISTRY_IS_CACHE
  // is deliberately absent: its trigger is the user naming an unconnected
  // project, which does not happen to a sub-agent.
  lines.push(AGENT_ID_RULE);
  lines.push(NO_LOCAL_FILES_RULE);
  lines.push(SERVER_AUTHORITY_RULE);

  // Then what binds a sub-agent and nobody else.
  lines.push(...SUBAGENT_PROTOCOL);

  return { additionalContext: lines.join('\n') };
}
