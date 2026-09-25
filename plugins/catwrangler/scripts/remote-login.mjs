#!/usr/bin/env node
/**
 * Remote login entry point, for the remote-login skill on both hosts.
 *
 * Deliberately empty: the implementation, and the reasons behind it, are in
 * lib/remote-login.mjs. Launched through remote-login.sh so that Node is
 * resolved the same way as for every other plugin entry point (d-3696).
 */

import { runRemoteLoginCli } from '../lib/remote-login.mjs';

runRemoteLoginCli(process.argv.slice(2));
