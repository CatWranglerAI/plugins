#!/usr/bin/env node
/**
 * `.catwrangler` CRUD — plugin-root alias for the skill's own entry point.
 *
 * Not the canonical path. Each host's skill carries its own manage.mjs inside
 * its own skill directory, because that is the path the skill body names and the
 * only one Claude Code's ${CLAUDE_SKILL_DIR} can resolve. This file exists for
 * the join that agents actually make.
 *
 * Codex names bundled scripts by a path relative to the skill directory, so the
 * skill says `./scripts/manage.mjs` and means skills-codex/connect/scripts/. A
 * live install resolved that against the PLUGIN ROOT instead and failed with
 * MODULE_NOT_FOUND — an easy mistake to make, since the root has a scripts/ of
 * its own holding the session-start adapters. The skill now says which directory
 * it means; this file means the wrong guess costs nothing when it happens anyway.
 *
 * It is a pure alias: same lib/manage-cli.mjs, same argv contract, same JSON, so
 * there is no behavior here that could drift from the entry point it stands in
 * for. The registry it edits is found by hunting from the working directory, not
 * from this file, so which of the three paths ran makes no difference to the
 * result.
 */

import { runManageCli } from '../lib/manage-cli.mjs';

runManageCli(process.argv.slice(2));
