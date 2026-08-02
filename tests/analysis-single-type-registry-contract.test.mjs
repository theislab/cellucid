/**
 * There is exactly one registry of analysis modes.
 *
 * The modes the application offers are registered at runtime by
 * `ComparisonModule._registerAnalysisTypes()` into `AnalysisUIManager`, which
 * also owns the page-count predicates (`getAvailableTypes`, `isTypeAvailable`).
 * A second, hand-written `ANALYSIS_TYPES` table used to sit in the
 * `analysis-types` barrel alongside its own copies of those predicates. Nothing
 * ever read it, so nothing ever failed when it drifted — and it did drift, in
 * both directions at once: it named the modes `Quick Insights`,
 * `Correlation Explorer` and `Gene Signature Score` where the application shows
 * `Quick`, `Correlation` and `Gene Signature`, and it declared Differential
 * Expression as `minPages: 2, maxPages: 2` where the live registration accepts
 * one page and lets the user pick the two groups to compare inside the form.
 *
 * A reader who found the dead table first would have believed both. This sweep
 * keeps the duplicate from coming back.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ANALYSIS_ROOT = fileURLToPath(
  new URL('../assets/js/app/analysis/', import.meta.url)
);

/** Names that only ever belonged to the duplicate registry. */
const RETIRED_REGISTRY_EXPORTS = Object.freeze([
  'ANALYSIS_TYPES',
  'isAnalysisTypeAvailable',
  'getAvailableAnalysisTypes',
]);

function* findModules(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* findModules(entryPath);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      yield entryPath;
    }
  }
}

test('no analysis module publishes a second analysis-type registry', async () => {
  const barrels = [
    'index.js',
    'ui/index.js',
    'ui/analysis-types/index.js',
  ].map(relative => path.join(ANALYSIS_ROOT, relative));

  for (const barrel of barrels) {
    const module = await import(pathToFileURL(barrel).href);
    const offending = RETIRED_REGISTRY_EXPORTS.filter(name => name in module);
    assert.deepEqual(
      offending,
      [],
      `${path.relative(ANALYSIS_ROOT, barrel)} re-exports ${offending.join(', ')}; `
        + 'the analysis-mode registry is AnalysisUIManager, populated by '
        + 'ComparisonModule._registerAnalysisTypes()',
    );
  }
});

test('no analysis source defines a second analysis-type registry', () => {
  const offending = [];
  for (const modulePath of findModules(ANALYSIS_ROOT)) {
    const source = fs.readFileSync(modulePath, 'utf8');
    for (const name of RETIRED_REGISTRY_EXPORTS) {
      if (source.includes(name)) {
        offending.push(`${path.relative(ANALYSIS_ROOT, modulePath)}: ${name}`);
      }
    }
  }
  assert.deepEqual(offending, []);
});

test('the live registry is the one that decides mode availability', async () => {
  const { AnalysisUIManager } = await import(
    pathToFileURL(path.join(ANALYSIS_ROOT, 'ui/analysis-ui-manager.js')).href
  );

  for (const method of ['register', 'getAllTypes', 'getAvailableTypes', 'isTypeAvailable']) {
    assert.equal(
      typeof AnalysisUIManager.prototype[method],
      'function',
      `AnalysisUIManager must own ${method}; it is the single analysis-mode registry`,
    );
  }
});
