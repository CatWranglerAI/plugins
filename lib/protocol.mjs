/**
 * The standing protocol every connected session runs under — host-neutral, and
 * neutral about *how* the session got connected.
 *
 * It exists as its own file because two different paths lead to a connected
 * session, and both have to deliver the same rules:
 *
 *   1. SessionStart. The workspace already has a `.catwrangler`, so the hook
 *      injects these lines as additionalContext before the first turn.
 *   2. /catwrangler:connect. The workspace had NO `.catwrangler` when the
 *      session started, so the hook emitted a nudge and nothing else — the model
 *      never received any of this. The user then connects by hand, init_session
 *      succeeds, and without these lines the session runs the rest of its life
 *      knowing only that it is connected. That is the first-run case, and it is
 *      the common one: the very first session in a workspace is always it.
 *
 * So the skill injects the same text at build time (tools/build-skills.mjs
 * resolves {{PROTOCOL}} from here) rather than paraphrasing it. A paraphrase
 * drifts, and the drift is invisible: both paths keep working, they just stop
 * agreeing about the rules, and only one of them is right.
 *
 * What belongs here is what stays true for the whole session regardless of
 * project — identity, where code lives, what the registry is worth. Anything
 * that depends on *which* project was chosen stays in bootstrap.mjs, which is
 * the only place that reads the registry.
 */

/**
 * The protocol lines, one rule per entry. Rendered as newline-joined context by
 * the SessionStart hook and as a bullet list by the skill, so each entry has to
 * stand alone — no "the above", no ordering dependency between them.
 */
export const SESSION_PROTOCOL = [
  'init_session returns an `agent_id`. Remember it, and include it as `_agent_id: "<agent_id>"` in the body of EVERY subsequent call to this server — calls without it are rejected. Each CatWrangler instance you connect to issues its OWN agent_id; use the matching one per server and never reuse one instance\'s agent_id on another. After an AUTH_REQUIRED error or a reconnect, call init_session with `reclaim_agent_id: "<agent_id>"` to recover without losing your branch or work — do not re-init without it.',
  'You have NO local source code or decision files for the project — it all lives on the CatWrangler server behind its SCCS gates. Use the server\'s MCP tools (get_task_briefing, grep_code, read_code, list_files, search_decisions) for ALL code and decision access; do NOT use local file tools (Read, Grep, Glob, cat) to explore the project. The only local files are CLAUDE.md and Docs/.',
  'Whatever init_session returns is the authority on how to work this project — read it and follow it, even where it goes beyond these lines.',
  'The workspace\'s `.catwrangler` file is a convenience cache, not the source of truth. If the user references a project not registered there, call init_session to get the authoritative, current list from the server.',
];

/**
 * What a configured workspace should tell the user about re-running connect.
 *
 * Users read a slash command they ran once as a step they now owe every session,
 * and there is nothing in a normal session that contradicts that — the hook's
 * work is invisible when it succeeds. So say it out loud, from both entry
 * points: the first-run connect (where the habit forms) and every session after
 * (where it would otherwise be repeated).
 *
 * The claim is only ever "unnecessary", never "don't" — re-running is harmless,
 * and overstating it would make a user hesitate to reach for the command when
 * they genuinely want to switch projects.
 */
export const NO_RECONNECT_NEEDED =
  'Connecting is automatic and persistent: every future session started in this directory connects on its own at startup, with no /catwrangler:connect and no other setup step. Do not let the user believe otherwise — if they ask whether they need to connect, or reach for the command out of habit, tell them plainly that they are already correctly configured. The command is for adding, removing, or switching projects; re-running it is harmless, just unnecessary.';
