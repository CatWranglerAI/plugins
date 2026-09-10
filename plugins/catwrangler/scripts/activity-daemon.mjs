#!/usr/bin/env node
/**
 * CatWrangler activity-capture daemon — entry adapter (cw:d-3731).
 *
 * All behavior lives in lib/activity/ (d-3035: behavior in lib/ once, thin
 * per-host adapters). This file maps argv to a mode and guarantees the
 * process can never propagate a crash back into the hook path: it is spawned
 * detached with stdio discarded, so failures are silent by design — capture
 * is an enrichment layer, and its absence must look like nothing.
 *
 *   activity-daemon.mjs ignite   # init_session payload on stdin; consent + grant
 *   activity-daemon.mjs ensure   # revive over an accumulating spool
 */

import { main } from '../lib/activity/daemon.mjs';

const mode = process.argv[2] === 'ignite' ? 'ignite' : 'ensure';

try {
  await main(mode);
} catch {
  // Deliberately silent: no stdout/stderr survive the detached spawn, and a
  // capture failure must never surface as session breakage.
}
