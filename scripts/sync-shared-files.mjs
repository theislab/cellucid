/**
 * Make every shared file's copies agree with its home (`shared-files.mjs`).
 *
 *   node scripts/sync-shared-files.mjs           # make the homes that have a generator, then write every copy
 *   node scripts/sync-shared-files.mjs --check   # exit 1, naming each home or copy that is stale
 *
 * A home with a generator is made by it first (the generator's own `--check`
 * under `--check`). Then each copy is compared with its home, byte for byte,
 * and written when it differs. A sibling repository that is not there is
 * named and skipped; with `CELLUCID_REQUIRE_SIBLINGS=1` that is a failure.
 *
 * After writing, the packages make what they build from the copies:
 * `python scripts/generate_actions.py` and `python scripts/generate_history_model.py`
 * in cellucid-python, `Rscript tools/generate-actions.R` and
 * `Rscript tools/generate-history-model.R` in cellucid-r.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT, SHARED_FILES, copyPaths, siblingsRequired } from './shared-files.mjs';

/** Each generator once, in the order the list first names it. */
function generators() {
  return [...new Set(SHARED_FILES.map(entry => entry.generator).filter(generator => generator !== null))];
}

/**
 * Every copy against its home: `{home, repository, file, state}`, `state`
 * `current`, `stale`, `written`, or `absent` (its repository is not there).
 * Writes the stale ones unless `check`.
 *
 * @param {{check?: boolean, env?: NodeJS.ProcessEnv}} [options]
 */
export function syncCopies({ check = false, env = process.env } = {}) {
  const results = [];
  for (const entry of SHARED_FILES) {
    const home = readFileSync(path.join(ROOT, entry.home));
    for (const copy of copyPaths(entry, env)) {
      const result = { home: entry.home, repository: copy.repository, env: copy.env, file: copy.file };
      if (copy.path === null) {
        results.push({ ...result, state: 'absent' });
        continue;
      }
      const same = existsSync(copy.path) && readFileSync(copy.path).equals(home);
      if (!same && !check) {
        mkdirSync(path.dirname(copy.path), { recursive: true });
        writeFileSync(copy.path, home);
      }
      results.push({ ...result, state: same ? 'current' : check ? 'stale' : 'written' });
    }
  }
  return results;
}

function main() {
  const flags = process.argv.slice(2);
  const unknown = flags.filter(flag => flag !== '--check');
  if (unknown.length > 0) throw new Error(`Unknown argument ${unknown[0]}; the only one is --check`);
  const check = flags.includes('--check');
  let stale = 0;
  for (const generator of generators()) {
    const run = spawnSync(process.execPath, [generator, ...(check ? ['--check'] : [])], { cwd: ROOT, stdio: 'inherit' });
    if (run.status !== 0) {
      if (!check) throw new Error(`${generator} failed`);
      stale += 1;
    }
  }
  const results = syncCopies({ check });
  const absent = new Map();
  for (const result of results) {
    if (result.state === 'absent') absent.set(result.repository, result.env);
    else if (result.state !== 'current') console.log(`${result.state.padEnd(7)} ${result.repository}/${result.file}`);
    if (result.state === 'stale') stale += 1;
  }
  for (const [repository, variable] of absent) {
    console.log(`skipped ${repository}: not found (set ${variable})`);
    if (siblingsRequired()) stale += 1;
  }
  const compared = results.filter(result => result.state !== 'absent').length;
  console.log(`${compared} copies of ${SHARED_FILES.length} shared files ${check ? 'compared' : 'agree'}${stale > 0 ? `; ${stale} stale` : ''}`);
  if (stale > 0) {
    console.log('Run node scripts/sync-shared-files.mjs, then the packages\' own generators (see this script\'s header).');
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
