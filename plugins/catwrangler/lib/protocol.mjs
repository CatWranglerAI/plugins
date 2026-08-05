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
 * A third path arrived with the SubagentStart hook, and it is why the rules
 * below are named constants rather than anonymous array entries. A sub-agent
 * needs SOME of this — the identity contract, where code lives — and none of the
 * parts addressed to a user it cannot talk to. Composing the sub-agent block
 * from the same constants keeps the shared rules to one copy; a hand-shortened
 * restatement is exactly the invisible drift described above, arriving by a new
 * door.
 *
 * What belongs here is what stays true for the whole session regardless of
 * project — identity, where code lives, what the registry is worth. Anything
 * that depends on *which* project was chosen stays in bootstrap.mjs, which is
 * the only place that reads the registry.
 */

/**
 * The identity contract. First rule everywhere, because every other tool call
 * depends on getting it right, and getting it wrong fails every call rather than
 * degrading.
 */
export const AGENT_ID_RULE =
  'init_session returns an `agent_id`. Remember it, and include it as `_agent_id: "<agent_id>"` in the body of EVERY subsequent call to this server — calls without it are rejected. Each CatWrangler instance you connect to issues its OWN agent_id; use the matching one per server and never reuse one instance\'s agent_id on another. After an AUTH_REQUIRED error or a reconnect, call init_session with `reclaim_agent_id: "<agent_id>"` to recover without losing your branch or work — do not re-init without it.';

/**
 * Where the code is. The rule an unbriefed agent breaks first and most quietly:
 * local file tools do not error in a CatWrangler workspace, they just report an
 * empty or misleading tree.
 */
export const NO_LOCAL_FILES_RULE =
  'You have NO local source code or decision files for the project — it all lives on the CatWrangler server behind its SCCS gates. Use the server\'s MCP tools (get_task_briefing, grep_code, read_code, list_files, search_decisions) for ALL code and decision access; do NOT use local file tools (Read, Grep, Glob, cat) to explore the project. The only local files are CLAUDE.md and Docs/.';

/** The server outranks anything stated here, including this file. */
export const SERVER_AUTHORITY_RULE =
  'Whatever init_session returns is the authority on how to work this project — read it and follow it, even where it goes beyond these lines.';

/**
 * What the registry is worth. Session-only: its trigger is the user naming a
 * project, which is not a thing that happens to a sub-agent.
 */
export const REGISTRY_IS_CACHE_RULE =
  'The workspace\'s `.catwrangler` file is a convenience cache, not the source of truth. If the user references a project this workspace is not connected to, call init_session to get the authoritative, current list from the server.';

/**
 * The protocol lines, one rule per entry. Rendered as newline-joined context by
 * the SessionStart hook and as a bullet list by the skill, so each entry has to
 * stand alone — no "the above", no ordering dependency between them.
 */
export const SESSION_PROTOCOL = [
  AGENT_ID_RULE,
  NO_LOCAL_FILES_RULE,
  SERVER_AUTHORITY_RULE,
  REGISTRY_IS_CACHE_RULE,
];

/**
 * How the sub-agent block opens, and the sub-agent's counterpart to the session
 * bootstrap's "this is a CatWrangler workspace, call init_session" line.
 *
 * It is a separate sentence rather than the shared one because a sub-agent has
 * to be told what it IS before it is told what to do: a sub-agent inherits a
 * prompt, not a session, and its most natural wrong assumption is that whoever
 * spawned it already connected it. Everything after this line reads differently
 * once that is settled, which is why it goes first.
 */
export const SUBAGENT_OPENING =
  'You are a SUB-AGENT spawned into a CatWrangler workspace, and connecting is yours to do: your parent\'s session did not connect you, and its `agent_id` is not yours to use. Before ANY work on the project, call the `catwrangler` MCP server\'s `init_session` tool exactly as a top-level session would, and follow the protocol it returns.';

/**
 * The rules that bind a sub-agent and nobody else, appended after the shared
 * ones by buildSubagentBootstrap.
 *
 * Each exists because a sub-agent's default behavior is wrong in a way the
 * parent cannot see until the work comes back:
 *
 *   - Connecting without `parent_agent_id` succeeds, which is the problem — it
 *     takes a peer identity and its own top-level branch instead of a
 *     sub-identity under the parent, and the parent then has nothing to assemble.
 *   - Left to itself it will register a decision to get through the write gate,
 *     which is how ordinary implementation slices become orphan decisions.
 */
export const SUBAGENT_PROTOCOL = [
  'If your task names the parent\'s CatWrangler `agent_id`, pass it as `parent_agent_id` to init_session. That allocates you a sub-identity and your own sub-branch under the parent, which is what lets the parent assemble your work. Connecting WITHOUT it also succeeds — it just makes you a peer with a top-level branch the parent will not find, so do not skip it when you were given one. If you were not given one, connect normally and report the `agent_id` you were issued back to the parent.',
  'Work under the decision the parent gave you. Do NOT register a new decision for an ordinary implementation slice — pass the parent\'s decision id to `sccs_write_checkout` instead — and do not merge to trunk; that is the parent\'s to do once it has assembled your branch. Report what you changed, what you read, what you ran, and anything unresolved.',
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
 * they genuinely want to connect another project.
 */
export const NO_RECONNECT_NEEDED =
  'Connecting is automatic and persistent: every future session started in this directory connects on its own at startup, with no /catwrangler:connect and no other setup step. Do not let the user believe otherwise — if they ask whether they need to connect, or reach for the command out of habit, tell them plainly that they are already correctly configured. The command is for connecting or disconnecting projects; re-running it is harmless, just unnecessary.';
