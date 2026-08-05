#!/usr/bin/env node
/**
 * `.catwrangler` CRUD for the /catwrangler:connect skill — Claude Code entry point.
 *
 * Deliberately empty: the whole implementation is lib/manage-cli.mjs (argv,
 * stdout, exit codes) over lib/registry.mjs (the file itself), both host-neutral.
 * This file exists only because Claude Code resolves the skill's script through
 * ${CLAUDE_SKILL_DIR}, so the path has to live inside the skill. The Codex entry
 * point is the same delegation from its own skill directory.
 *
 * Run `node lib/manage-cli.mjs --help`-style discovery there, not here: the
 * subcommand contract, flags, and JSON shapes are documented at the top of
 * lib/manage-cli.mjs.
 */

import { runManageCli } from '../../../lib/manage-cli.mjs';

runManageCli(process.argv.slice(2));
