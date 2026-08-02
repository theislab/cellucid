/**
 * Every `index.js` barrel under `assets/js/app/analysis/` must link.
 *
 * A barrel re-exports names it does not itself define, and an ES module rejects
 * a re-export of a name the source module does not publish — but only when the
 * barrel is actually loaded. `assets/js/app/analysis/shared/index.js` therefore
 * carried four re-exports of names `matrix-utils.js` has never exported, and
 * throwing `SyntaxError` on import went unnoticed because nothing imports it.
 *
 * Loading each barrel is the whole check: a re-export of a name that is not
 * there is a link-time failure, so a barrel that imports at all is a barrel
 * whose every re-export resolves.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ANALYSIS_ROOT = fileURLToPath(
  new URL('../assets/js/app/analysis/', import.meta.url)
);

function* findBarrels(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* findBarrels(entryPath);
    } else if (entry.isFile() && entry.name === 'index.js') {
      yield entryPath;
    }
  }
}

test('every analysis barrel re-exports only names its sources publish', async () => {
  const barrels = [...findBarrels(ANALYSIS_ROOT)].sort();
  assert.ok(
    barrels.length >= 11,
    `found ${barrels.length} analysis barrels; the tree carries at least 11, so `
      + 'this sweep would otherwise assert nothing'
  );

  const failures = [];
  for (const barrel of barrels) {
    const relative = path.relative(ANALYSIS_ROOT, barrel);
    let module;
    try {
      module = await import(pathToFileURL(barrel).href);
    } catch (error) {
      failures.push(`${relative}: ${error.message}`);
      continue;
    }
    if (Object.keys(module).length === 0) {
      failures.push(`${relative}: links but publishes no exports`);
    }
  }

  assert.deepEqual(failures, []);
});
