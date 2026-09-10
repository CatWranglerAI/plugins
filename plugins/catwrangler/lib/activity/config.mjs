/**
 * Activity-capture configuration — consent, state paths, credentials (cw:d-3731).
 *
 * Consent (`activityCapture`) lives in the workspace `.catwrangler` registry:
 * top-level default with per-project override, levels "full" | "toolCalls" |
 * "off" (review notes §3). The registry's existence is the consent boundary
 * (d-3782): inside a governed workspace, no setting at all means "full", and
 * "toolCalls"/"off" are the explicit dial-downs — while a directory with no
 * governing registry is never captured at all. It is capture-at-source: "off"
 * means nothing is written for that workspace. The instance runtime-config
 * flag remains the authoritative OUTER gate — the server refuses grants and
 * ingest when it is off, whatever this file says.
 *
 * The machine-global flag file the sh hook tests is a Phase 0 simplification:
 * it says "at least one workspace on this machine captures", and the daemon
 * re-checks the owning workspace's consent per event before normalizing.
 *
 * The credential keyring is keyed by {server origin, project} (handoff B4 —
 * dev, atc-dev, and customer instances are different URLs and credentials).
 * Files are 0600 inside a 0700 state dir; they hold the short-lived ingest
 * token, never OAuth material.
 */

import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { findRegistry, readRegistryFile } from '../registry.mjs';

export const CAPTURE_LEVELS = ['full', 'toolCalls', 'off'];

export function stateDir() {
  return process.env.CATWRANGLER_ACTIVITY_DIR || join(homedir(), '.catwrangler', 'activity');
}

export const paths = {
  incoming: () => join(stateDir(), 'incoming'),
  sessions: () => join(stateDir(), 'sessions'),
  creds: () => join(stateDir(), 'creds'),
  rejected: () => join(stateDir(), 'rejected'),
  pidfile: () => join(stateDir(), 'daemon.pid'),
  enabledFlag: () => join(stateDir(), 'capture-enabled'),
  flushMarker: () => join(stateDir(), 'flush-requested'),
};

export function ensureStateDirs() {
  for (const dir of [stateDir(), paths.incoming(), paths.sessions(), paths.creds(), paths.rejected()]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Resolve the capture level and project routing for a workspace directory.
 * Returns { level, project } where project is the registry entry that governs
 * this workspace (by id when known, else the sole entry), or null when the
 * directory is not a CatWrangler workspace at all.
 */
export function resolveCapture(cwd, projectId) {
  const found = findRegistry(cwd || '.');
  if (!found) return null;
  let manifest;
  try {
    manifest = readRegistryFile(found.path);
  } catch {
    return null;
  }
  const projects = Array.isArray(manifest.projects) ? manifest.projects : [];
  const project = (projectId && projects.find((p) => p && p.id === projectId))
    || (projects.length === 1 ? projects[0] : undefined);

  const topLevel = normalizeLevel(manifest.activityCapture);
  const perProject = project ? normalizeLevel(project.activityCapture) : undefined;
  // Precedence (review notes §3): project entry > workspace top level. The
  // instance flag outranks both, but that is enforced server-side. Absent
  // everywhere = full (d-3782): reaching this line at all means a governing
  // registry exists, and that is the consent boundary — "off" is the explicit
  // opt-out, set through the connect skill's capture command.
  const level = perProject ?? topLevel ?? 'full';
  return { level, project: project ?? null, registry_path: found.path };
}

function normalizeLevel(value) {
  return typeof value === 'string' && CAPTURE_LEVELS.includes(value) ? value : undefined;
}

/** Materialize/remove the flag file the sh hook gates on. Content = level. */
export function setEnabledFlag(level) {
  ensureStateDirs();
  if (level && level !== 'off') {
    writeFileSync(paths.enabledFlag(), level + '\n', { mode: 0o600 });
    return true;
  }
  try { unlinkSync(paths.enabledFlag()); } catch { /* already absent */ }
  return false;
}

function credKey(origin, projectId) {
  return `${String(origin).replace(/[^A-Za-z0-9.-]/g, '_')}__${String(projectId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

/** Persist a session-independent ingest credential (0600, atomic rename). */
export function saveCredential(origin, projectId, cred) {
  ensureStateDirs();
  const file = join(paths.creds(), credKey(origin, projectId));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cred, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export function loadCredential(origin, projectId) {
  try {
    return JSON.parse(readFileSync(join(paths.creds(), credKey(origin, projectId)), 'utf8'));
  } catch {
    return null;
  }
}

export function dropCredential(origin, projectId) {
  try { unlinkSync(join(paths.creds(), credKey(origin, projectId))); } catch { /* gone */ }
}

export function hasEnabledFlag() {
  return existsSync(paths.enabledFlag());
}
