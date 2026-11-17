---
name: catwrangler-handoff
description: Write one durable CatWrangler session record—a standalone handoff when real work is in flight, otherwise a session summary. Use when the user says handoff, pause, wrap up, save context, end the session, or asks for a session record.
---
<!-- GENERATED from src/skill-handoff.md for codex — edit the source, then run: node tools/build-skills.mjs -->

Produce exactly ONE curated document, store it on the CatWrangler server, and reply with only a brief pointer. The client already keeps the raw transcript; the document is the complete, self-contained record, not a re-transcription.

If the user names a focus (for example, “handoff the auth deploy”), center the document on that.

## 1. Choose honestly: handoff or summary

Write a **HANDOFF** only when genuine unfinished work must continue: a task mid-execution, a change not yet verified live, something blocked or awaiting approval or external state, a decision not yet implemented, or a concrete next step already teed up.

Otherwise write a **SESSION SUMMARY**. Do not manufacture work to hand off. Unstarted ideas and backlog items are not work in flight.

Always write exactly one document. If it is a summary, say plainly: “Nothing to hand off—wrote a summary.”

## 2. Write for a cold-starting agent

The next agent must be able to resume without this conversation. Include exact files, decision references, entry points, and the current verified state. Distinguish drafted, committed, merged, deployed, and verified. Do not narrate the whole session.

**HANDOFF**

- **Status** — the single open thing.
- **In flight** — what started, its real state, and what is not confirmed.
- **Next steps** — ordered, concrete, independently doable.
- **Blockers / waiting on** — external state, approvals, and misleading discrepancies. Normal concurrent CatWrangler operation is not a blocker.
- **How to resume** — the exact entry point and how to re-verify current state before acting.
- **Also landed** — other notable work that shipped.

**SESSION SUMMARY**

- **What this session did** — outcomes, in a few bullets.
- **Decisions / changes that landed** — what is now different and verified.
- **Open items** — “none,” or a short list.
- **Worth knowing next time** — useful context, gotchas, or dead ends.

## 3. Store it through the server

Use the selected project’s document-write tool. Do not rely on a local `Docs/` folder.

- Handoff: `handoffs/<short-subject>-YYYY-MM-DD.md`
- Summary: `sessions/<short-subject>-YYYY-MM-DD.md`

The subject comes first and the date comes last. For example: `handoffs/auth-deploy-2026-09-03.md`. Use the current revision when updating an existing record, or `base_revision: "new"` for a genuinely new one.

For a handoff, treat the write as successful only when the response confirms that it was registered, filed, and hidden from ordinary documents, and supplies the deliberate claim call plus share and pickup instructions. Use those returned instructions as the authority. If registration fails or those confirmations are missing, do not claim the handoff was filed and do not create duplicate copies blindly; report the supplied recovery action.

For a non-CatWrangler project with no server document tool, save one local subject-first, date-last Markdown file and say where.

## 4. Point the next agent to deliberate pickup

Standalone handoffs are intentionally absent from ordinary document listing, search, browsing, and broad project grounding. Never tell the receiving agent to search for or ordinarily read one.

The normal transfer is the exact path returned by the write. The receiving agent calls `handoff_claim` with that path. A writer who has reclaimed the same agent identity may call `handoff_claim` without a selector to pick up its newest unclaimed handoff. Writer lookup is also available when the transfer explicitly names the writer.

An exact named handoff remains retrievable after it was claimed, but the response warns that it may be historical or previously used. The receiving agent must re-verify time-sensitive state before acting. A handoff is transfer context, never current architectural authority.

Session summaries remain ordinary project documents; they are not claimed as handoffs.

## 5. Reply with only the pointer

Do not reprint or summarize the document in chat. Reply with exactly three short lines:

1. What you wrote.
2. What is in flight, or “Nothing in flight.”
3. The exact document path returned by the server.

## Reminder

A handoff exists only because real work is unfinished. A summary records a finished session. Merged is not shipped, and the receiving agent must verify that the handoff still matches reality.

