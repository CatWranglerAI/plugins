#!/usr/bin/env node
/**
 * `.catwrangler` CRUD for the /catwrangler:connect skill — Codex entry point.
 *
 * The mirror of skills/connect/scripts/manage.mjs. Deliberately empty: the whole
 * implementation is lib/manage-cli.mjs over lib/registry.mjs, both host-neutral,
 * so the two hosts cannot drift in output shape or file format.
 *
 * It exists as a separate file only because each host's skill has to carry its
 * own script inside its own skill directory. The subcommand contract, flags, and
 * JSON shapes are documented at the top of lib/manage-cli.mjs.
 */

import { runManageCli } from '../../../lib/manage-cli.mjs';

runManageCli(process.argv.slice(2));
