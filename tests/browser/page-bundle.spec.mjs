/**
 * Where the page's code comes from (index.html, CELLUCID_PAGE_BOOT).
 *
 * A deployed site runs the page bundle (`assets/page/`, built by
 * scripts/build-page-bundle.mjs): the entry and every file it imports at
 * startup are asked for at once from the head, the parts the app imports on
 * demand come from the bundle as well, and no module of the sources is
 * requested but the few that read their own address (`PAGE_EXTERNALS`) and
 * the classic scripts the head names. A page on this machine runs the
 * sources and asks for nothing of the bundle. The page is a deployed site
 * when it is not served from this machine's own name, so those tests open it
 * at `deployed.localhost`, which every engine resolves to the same server.
 */
import { readFileSync } from 'node:fs';

import { expect, test } from './helpers/test.mjs';
import { DEPLOYED_APP_ORIGIN, ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { PAGE_EXTERNALS } from '../../scripts/build-page-bundle.mjs';

const ROOT = new URL('../../', import.meta.url);
const INDEX_HTML = readFileSync(new URL('index.html', ROOT), 'utf8');
const BOOT = /<script id="cellucid-page-boot">([\s\S]*?)<\/script>/.exec(INDEX_HTML)[1];
// The entry and its startup files, as the boot script lists them.
const STARTUP_FILES = [...BOOT.matchAll(/"(assets\/page\/[^"]+)"/g)].map(match => `/${match[1]}`);
// The classic scripts the page names itself.
const PAGE_SCRIPTS = [...INDEX_HTML.matchAll(/<script\b[^>]*\bsrc="([^"?]+)/g)].map(match => `/${match[1]}`);
const LOCAL_DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui`;
const DEPLOYED_DATASET_URL = `${DEPLOYED_APP_ORIGIN}/?sampleCatalog=${encodeURIComponent(
  `${DEPLOYED_APP_ORIGIN}/tests/browser/fixtures/catalog/`,
)}&dataset=current-ui`;

/** Every script request of the page, workers' included, by path. */
function observeScripts(page) {
  const requests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('.js')) requests.push({ path: url.pathname, type: request.resourceType() });
  });
  return requests;
}

test('a deployed page runs the page bundle: its startup files at once, nothing of the sources', async ({ page }) => {
  expect(STARTUP_FILES.length).toBeGreaterThan(1);
  const scripts = observeScripts(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(DEPLOYED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  // Preloaded from the head: every startup file is asked for before the
  // document has finished loading.
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('link[rel="modulepreload"]')]
    .map(link => new URL(link.href).pathname))).toEqual(STARTUP_FILES);
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await expect(page.locator('html')).toHaveAttribute('data-code-started', 'true');
  expect(scripts.map(({ path }) => path)).toEqual(expect.arrayContaining(STARTUP_FILES));

  // A part imported on demand comes from the bundle too.
  await openCollapsedPanels(page);
  await page.locator('#benchmark-section > summary').click();
  await expect.poll(() => scripts.some(({ path }) => /^\/assets\/page\/benchmark\.[A-Z2-7]{8}\.js$/.test(path))).toBe(true);

  const allowed = new Set([...PAGE_EXTERNALS.map(path => `/${path}`), ...PAGE_SCRIPTS]);
  expect(scripts
    .filter(({ path }) => path.startsWith('/assets/js/') && !allowed.has(path))
    .map(({ path }) => path)).toEqual([]);
  expect(errors).toEqual([]);
});

test('a page on this machine runs its sources and asks for nothing of the page bundle', async ({ page }) => {
  const scripts = observeScripts(page);
  await page.goto(LOCAL_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  expect(scripts.map(({ path }) => path)).toContain('/assets/js/app/main.js');
  expect(scripts.filter(({ path }) => path.startsWith('/assets/page/')).map(({ path }) => path)).toEqual([]);
  expect(await page.locator('link[rel="modulepreload"]').count()).toBe(0);
});

test('a deployed page whose startup file does not download says so instead of starting forever', async ({ page }) => {
  await page.route(`**${STARTUP_FILES.at(-1)}`, route => route.abort());
  await page.goto(DEPLOYED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  const failure = page.locator('#cellucid-startup-failure');
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute('data-code-failure', 'download');
  await expect(failure.locator('.welcome-title')).toHaveText('Cellucid could not load');
  await expect(failure.locator('.welcome-details-text')).toContainText('did not download');
  await expect(page.locator('html')).not.toHaveAttribute('data-code-started', /.*/);
});
