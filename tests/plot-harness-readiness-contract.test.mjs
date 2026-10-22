/**
 * The analysis plot harness is opened only through `openPlotHarness`.
 *
 * The plot modules read their theme tokens from the application stylesheet
 * when they are imported. A spec that navigated to the harness with
 * `waitUntil: 'domcontentloaded'` and imported a plot module at once raced that
 * stylesheet, and on a loaded machine the import failed with "Plot theme token
 * --font-sans must resolve to a concrete value". `openPlotHarness` waits for the
 * tokens to resolve. This sweep keeps a spec from naming the harness itself
 * and reintroducing the race.
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const BROWSER_TESTS = fileURLToPath(new URL('./browser/', import.meta.url));
const HELPER = path.join(BROWSER_TESTS, 'helpers', 'plot-harness.mjs');

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'fixtures') files.push(...await sourceFiles(full));
    } else if (/\.m?js$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

test('only the plot-harness helper names the analysis plot harness', async () => {
  const offenders = [];
  const users = [];
  for (const file of await sourceFiles(BROWSER_TESTS)) {
    const source = await readFile(file, 'utf8');
    if (file !== HELPER && source.includes('analysis-plot-harness')) {
      offenders.push(path.relative(BROWSER_TESTS, file));
    }
    if (source.includes('openPlotHarness(page')) users.push(file);
  }
  assert.deepEqual(offenders, []);
  assert.ok(users.length > 0, 'some spec opens the plot harness');
});

test('the helper waits for the theme tokens, not only for the document', async () => {
  const source = await readFile(HELPER, 'utf8');
  assert.match(source, /getPropertyValue\('--font-sans'\)\.trim\(\)\.length > 0/);
});
