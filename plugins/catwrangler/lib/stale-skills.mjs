/**
 * Old local copies of skills this plugin now ships (cw:d-5114).
 *
 * catteam, handoff and redteam used to be downloaded by hand into a command or
 * skill folder. Those copies never update, and a stale one taught a retired
 * worker-launch method for weeks. The plugin now carries the current version, so
 * the session-start banner names any old copy the user can delete.
 *
 * A file only counts when it mentions CatWrangler: someone's own unrelated
 * "handoff" command is not ours to flag. Nothing is ever deleted here.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Skill names bundled by the plugin; matching local copies are candidates for stale-copy notices. */
export const SHIPPED_SKILLS = ['catteam', 'handoff', 'redteam'];

function candidatePaths(name, cwd, home) {
  const paths = [];
  for (const root of [cwd, home]) {
    if (!root) continue;
    paths.push(join(root, '.claude', 'commands', `${name}.md`));
    paths.push(join(root, '.claude', 'skills', name, 'SKILL.md'));
  }
  if (home) {
    paths.push(join(home, '.codex', 'prompts', `${name}.md`));
    paths.push(join(home, '.codex', 'skills', name, 'SKILL.md'));
    paths.push(join(home, '.agents', 'skills', name, 'SKILL.md'));
  }
  return paths;
}

function mentionsCatWrangler(path) {
  try {
    return /catwrangler/i.test(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}

/** Absolute paths of old local copies, de-duplicated, in a stable order. */
export function findStaleSkillCopies({ cwd, home = process.env.HOME || homedir() } = {}) {
  const found = [];
  const seen = new Set();
  for (const name of SHIPPED_SKILLS) {
    for (const path of candidatePaths(name, cwd, home)) {
      if (seen.has(path)) continue;
      seen.add(path);
      if (existsSync(path) && mentionsCatWrangler(path)) found.push(path);
    }
  }
  return found;
}

/** Banner lines for the user, or [] when there is nothing to say. */
export function staleSkillNotice(paths) {
  if (!paths || paths.length === 0) return [];
  return [
    '  - The CatWrangler plugin now includes the current catteam, handoff and redteam skills. These older local copies do not update and can be deleted:',
    ...paths.map((p) => `      ${p}`),
  ];
}
