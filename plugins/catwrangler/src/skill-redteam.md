{{#claude}}---
description: Write a thorough SDD for the idea being discussed, then red-team it with adversarial subagents over one or more vetting passes, revising between passes
argument-hint: [agents] [passes] [optional focus, e.g. "the durable cache idea"] — e.g. /redteam 5 3 the auth broker
---

The user wants the idea currently being discussed turned into a real design document and then *attacked* until it either survives or dies. Produce exactly ONE document (the SDD, with a red-team record inside it), store it, and reply in chat with a brief verdict + pointer. **The document is the complete artifact; the chat message is not.**

## Step 0 — Parse arguments

From `$ARGUMENTS`:
- The **first bare integer**, if present, is the number of red-team subagents per pass; the **second**, if present, is the number of vetting passes. When given, these are the user's call — honor them.
- **When no numbers are given, size it yourself** — scale to the idea's stakes and surface area, and say what you chose and why in one line before starting. A small self-contained idea deserves a single pass with 1–2 attackers; a big architectural bet with many moving parts earns more. Do not default to heavyweight: one good pass that gets adjudicated honestly beats two ceremonial ones, and a second pass is only worth running when the first pass forced real revisions.
- Everything else is the **focus** — which idea to design and vet. If absent, use the idea most recently under discussion in this conversation. If the conversation has no clear candidate idea, say so and stop — do not invent one.

**Model:** red-team subagents run on the same model as the main session (they inherit it) — never quietly downgrade the attackers to a smaller model. The vetting is only as good as the adversary.

## Step 1 — Write the SDD (thorough, honest, self-contained)

Write a complete Software Design Document for the idea. A fresh agent must be able to judge and build from it cold. Required sections:

- **Problem & motivation** — what hurts today, who feels it, why now. Include the *actual* stakes, not inflated ones.
- **Proposed design** — architecture, data model, interfaces/contracts, key flows. Concrete enough to attack: name the tables, endpoints, components, and state transitions.
- **Scope & non-goals** — what this deliberately does not do.
- **Alternatives considered** — including the null alternative ("do nothing") and the cheapest alternative, each with an honest reason it lost.
- **Failure modes & degraded behavior** — what happens when each dependency is down, slow, stale, or wrong.
- **Cost & complexity** — build cost, run cost, and the *carry* cost (maintenance, cognitive load, migration burden).
- **Open questions** — things the author genuinely doesn't know.

Ground it in the real project: read the relevant source, decisions, and prior docs first (use the project's briefing/search tools if it's a CatWrangler-managed project). An SDD that contradicts the live system is red-team bait, not a design.

## Step 2 — Red-team passes

Run the configured number of passes. Each pass:

1. **Decide how to divide the attack, then spawn the red-team subagents in parallel** (one message, multiple Agent calls). Each subagent gets the full current SDD text plus its specific assignment. How to split the work is YOUR call, based on where this particular idea is most likely to break:
   - **By lens** — each attacker takes a different failure class: kill-the-idea (the problem is smaller than claimed / the null or cheapest alternative wins / it duplicates something that exists), correctness & failure modes, complexity & carry cost, security & abuse, operations.
   - **By part** — when the idea has distinct components (a store, an endpoint, a migration, a UI), give each attacker one part to break deeply, plus the seams between parts (integration points are where designs actually die — never leave them unassigned).
   - **By assumption** — identify the SDD's 2–3 load-bearing assumptions and assign an attacker to each one specifically.
   - Or a mix. With a single attacker, give it the whole document but name the two or three places you most suspect. Whatever the split, the **kill-the-idea challenge must be assigned to someone** — it's the one lens that never gets skipped.

   Instruct each subagent explicitly: *your job is to find real reasons this fails, not to polish it.* Every finding must state a concrete failure scenario and a severity: **fatal** (design is wrong / idea shouldn't proceed), **must-fix** (proceed only after addressing), **consider** (real trade-off, author's call), **nit**. Zero findings is an acceptable answer and must not be padded — but require the agent to *say* it looked and where.

2. **Adjudicate honestly.** Merge duplicate findings. For each, decide: accept (revise the SDD), reject (record *why* it doesn't hold — rebut with evidence, not preference), or defer (open question). Do not silently drop findings.

3. **Revise the SDD** to address accepted findings, then record the pass in a **Red-team record** section appended to the document: pass number, findings with severity and disposition, and what changed.

4. **Early exit:** if a pass produces no fatal or must-fix findings, later passes are optional — run at most one confirmation pass and stop. **Early death:** if a fatal finding survives adjudication (you cannot honestly rebut it), stop the passes; the outcome is "idea killed" or "needs rethink," and that IS a valid, valuable result. Say so plainly — do not soften a kill into "needs iteration."

Later passes get *fresh* subagents attacking the *revised* SDD (they also get the red-team record so they don't re-litigate rebutted findings — unless they can break the rebuttal).

## Step 3 — Store it, then send a BRIEF verdict (do NOT reprint the document)

- Save the final SDD (with the full red-team record inside) to the CatWrangler server's docs store under `design/`, titled with today's date + a short slug (e.g. `design/redteam-durable-cache-SDD-2026-08-08.md`). If the project isn't CatWrangler-managed, save a local dated markdown file and say where.
- Reply in chat with only:
  - one line: the **verdict** — survived (build it), survived-with-conditions (the must-fixes now baked in), or killed (and the one-sentence reason),
  - one line: findings count by severity across all passes,
  - the document's path.

The user opens the document for the detail.

## Reminder

The point is calibrated confidence, not ceremony. A red-team that always blesses the idea is worthless; so is one that always finds ten objections. The severity tiers and honest adjudication are what make the output trustworthy — and "we killed it in design for the cost of a document" is one of the best possible outcomes.
{{/claude}}{{#codex}}---
name: catwrangler-redteam
description: Write a thorough SDD for the idea being discussed, then red-team it adversarially over one or more vetting passes, revising between passes. Use when the user asks to red-team, stress-test, vet, or pressure-test an idea or design before building it.
---

The user wants the idea currently being discussed turned into a real design document and then *attacked* until it either survives or dies. Produce exactly ONE document (the SDD, with a red-team record inside it), store it, and reply in chat with a brief verdict + pointer. **The document is the complete artifact; the chat message is not.**

## Step 0 — Arguments and sizing

If the user's invocation includes numbers, the first is the number of red-team attackers per pass and the second is the number of vetting passes — honor them. Any remaining text is the **focus** (which idea to design and vet); if absent, use the idea most recently under discussion. If there is no clear candidate idea, say so and stop — do not invent one.

**When no numbers are given, size it yourself** — scale to the idea's stakes and surface area, and say what you chose and why in one line before starting. A small self-contained idea deserves a single pass with 1–2 attackers; a big architectural bet with many moving parts earns more. Do not default to heavyweight: one good pass adjudicated honestly beats two ceremonial ones, and a second pass is only worth running when the first forced real revisions.

**Attackers:** if this environment can spawn parallel subagents, use them — one per attacker, each on the same model as the main session (never quietly downgrade the attackers; the vetting is only as good as the adversary). If it cannot, run each attacker as a SEPARATE, independent adversarial analysis in sequence: fully adopt one attacker's assignment, write its findings completely, then start the next from scratch without defending the design against the previous one's findings. Do not blend them into one soft review.

## Step 1 — Write the SDD (thorough, honest, self-contained)

Write a complete Software Design Document for the idea. A fresh agent must be able to judge and build from it cold. Required sections:

- **Problem & motivation** — what hurts today, who feels it, why now. The *actual* stakes, not inflated ones.
- **Proposed design** — architecture, data model, interfaces/contracts, key flows. Concrete enough to attack: name the tables, endpoints, components, and state transitions.
- **Scope & non-goals** — what this deliberately does not do.
- **Alternatives considered** — including the null alternative ("do nothing") and the cheapest alternative, each with an honest reason it lost.
- **Failure modes & degraded behavior** — what happens when each dependency is down, slow, stale, or wrong.
- **Cost & complexity** — build cost, run cost, and the *carry* cost (maintenance, cognitive load, migration burden).
- **Open questions** — things the author genuinely doesn't know.

Ground it in the real project: read the relevant source, decisions, and prior docs first (on a CatWrangler-managed project, use the server's briefing/search/read tools). An SDD that contradicts the live system is red-team bait, not a design.

## Step 2 — Red-team passes

Each pass:

1. **Decide how to divide the attack.** Each attacker gets the full current SDD plus a specific assignment. How to split is YOUR call, based on where this particular idea is most likely to break:
   - **By lens** — each attacker takes a failure class: kill-the-idea (the problem is smaller than claimed / the null or cheapest alternative wins / it duplicates something that exists), correctness & failure modes, complexity & carry cost, security & abuse, operations.
   - **By part** — when the idea has distinct components, give each attacker one part to break deeply, plus the seams between parts (integration points are where designs actually die — never leave them unassigned).
   - **By assumption** — identify the SDD's 2–3 load-bearing assumptions and assign an attacker to each.
   - Or a mix. With a single attacker, give it the whole document but name the two or three places you most suspect. Whatever the split, the **kill-the-idea challenge must be assigned to someone** — it never gets skipped.

   Each attacker's job is to find real reasons this fails, not to polish it. Every finding must state a concrete failure scenario and a severity: **fatal** (design is wrong / idea shouldn't proceed), **must-fix** (proceed only after addressing), **consider** (real trade-off, author's call), **nit**. Zero findings is acceptable and must not be padded — but the attacker must say it looked and where.

2. **Adjudicate honestly.** Merge duplicates. For each finding: accept (revise the SDD), reject (record *why* it doesn't hold — rebut with evidence, not preference), or defer (open question). Do not silently drop findings.

3. **Revise the SDD**, then record the pass in a **Red-team record** section appended to the document: pass number, findings with severity and disposition, and what changed.

4. **Early exit:** a pass with no fatal or must-fix findings ends the vetting — at most one confirmation pass. **Early death:** if a fatal finding survives adjudication (you cannot honestly rebut it), stop; the outcome is "idea killed" or "needs rethink," and that IS a valid, valuable result. Say so plainly — never soften a kill into "needs iteration."

Later passes attack the *revised* SDD with fresh eyes (they see the red-team record so they don't re-litigate rebutted findings — unless they can break the rebuttal).

## Step 3 — Store it, then send a BRIEF verdict (do NOT reprint the document)

- Save the final SDD (with the full red-team record inside) to the CatWrangler server's docs store under `design/`, titled with today's date + a short slug (e.g. `design/redteam-durable-cache-SDD-2026-08-08.md`). If the project isn't CatWrangler-managed, save a local dated markdown file and say where.
- Reply in chat with only:
  - one line: the **verdict** — survived (build it), survived-with-conditions (must-fixes now baked in), or killed (with the one-sentence reason),
  - one line: findings count by severity across all passes,
  - the document's path.

## Reminder

The point is calibrated confidence, not ceremony. A red-team that always blesses the idea is worthless; so is one that always finds ten objections. The severity tiers and honest adjudication make the output trustworthy — and "we killed it in design for the cost of a document" is one of the best possible outcomes.
{{/codex}}
