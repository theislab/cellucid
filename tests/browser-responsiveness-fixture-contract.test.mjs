/**
 * A browser spec that measures how long the page's main thread is held reads
 * its dataset over HTTP, never through `page.route`.
 *
 * WebKit's Playwright delivers a fulfilled body through the page's own
 * process, on its main thread. The analysis responsiveness spec once routed
 * its 16 MiB fixture and saw WebKit hold the page for about 185 ms on the
 * dataset's first gene read, once per dataset, while Chromium showed nothing.
 * Nothing in the application ran then: the reader worker's one request was
 * in flight, and a bare worker fetch of a routed 16 MiB body, with no
 * application code loaded, holds WebKit's page for about 250 ms. Served over
 * HTTP the same file holds it for none. A routed dataset makes the harness
 * the long task such a spec reports (`helpers/served-fixture.mjs`).
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const BROWSER_TESTS = new URL('./browser/', import.meta.url);

/** The specs that measure main-thread holds: long tasks or frame gaps. */
async function responsivenessSpecs() {
  const specs = [];
  for (const name of await readdir(BROWSER_TESTS)) {
    if (!name.endsWith('.spec.mjs')) continue;
    const source = await readFile(new URL(name, BROWSER_TESTS), 'utf8');
    if (/['"]longtask['"]/.test(source)) specs.push({ name, source });
  }
  return specs;
}

test('a spec measuring main-thread holds reads its dataset over HTTP', async () => {
  const specs = await responsivenessSpecs();
  assert.ok(
    specs.some(spec => spec.name === 'analysis-no-long-tasks.spec.mjs'),
    'the analysis responsiveness spec measures long tasks'
  );
  for (const { name, source } of specs) {
    assert.doesNotMatch(source, /\.route\(|fulfillFile|serveSyntheticCatalog|serveAnnData/, `${name} routes its data`);
    assert.match(source, /writeServedFixture/, `${name} serves its dataset with writeServedFixture`);
  }
});

test('a served fixture lives under the ignored test-results tree, keyed by port', async () => {
  const helper = await readFile(new URL('./browser/helpers/served-fixture.mjs', import.meta.url), 'utf8');
  assert.match(helper, /`test-results\/served-fixtures-\$\{port\}\/\$\{name\}`/);
  const ignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(ignore, /^\/test-results\*\/$/m);
});
