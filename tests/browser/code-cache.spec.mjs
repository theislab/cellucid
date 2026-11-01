/**
 * The code cache (service-worker.js): a deployed page registers it once it
 * has loaded and names the files it loaded; the worker keeps every one whose
 * address names its bytes, and the next visit's requests for them are
 * answered from this browser (`tests/code-cache-contract.test.mjs` pins what
 * it keeps and refuses). A page on this machine registers none: its sources
 * change under it. Every other spec runs without service workers
 * (playwright.config.mjs), since `page.route` cannot see their requests.
 *
 * Playwright's Firefox cannot run the next visit: under its automation
 * protocol (Juggler) a navigation the worker leaves to the network, as this
 * one leaves the page, commits uncontrolled, in every context and from
 * `page.goto` or the page's own navigation alike. The same Firefox build
 * without Playwright, or driven over WebDriver BiDi, starts the next visit
 * under the worker and takes every startup file from it (measured
 * 2026-10-31; the developer docs, "Build, run, and deployment", the code
 * cache). Firefox runs the first visit here.
 */
import { readFileSync } from 'node:fs';

import { expect, test } from './helpers/test.mjs';
import { DEPLOYED_APP_ORIGIN, ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';

test.use({ serviceWorkers: 'allow' });

const INDEX_HTML = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const BOOT = /<script id="cellucid-page-boot">([\s\S]*?)<\/script>/.exec(INDEX_HTML)[1];
const STARTUP_FILES = [...BOOT.matchAll(/"(assets\/page\/[^"]+)"/g)].map(match => `/${match[1]}`);
const STYLESHEET = /<link rel="stylesheet" href="(assets\/css\/main\.css\?v=[0-9a-f]{12})"/.exec(INDEX_HTML)[1];
const DEPLOYED_DATASET_URL = `${DEPLOYED_APP_ORIGIN}/?sampleCatalog=${encodeURIComponent(
  `${DEPLOYED_APP_ORIGIN}/tests/browser/fixtures/catalog/`,
)}&dataset=current-ui`;
const LOCAL_DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui`;

async function openDataset(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  const welcome = page.locator('#welcome-modal');
  if (await welcome.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(welcome).toBeHidden();
  }
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
}

/** Every URL the code cache keeps, as path and query. */
function keptFiles(page) {
  return page.evaluate(async () => {
    const kept = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) {
        const url = new URL(request.url);
        kept.push(`${url.pathname}${url.search}`);
      }
    }
    return kept;
  });
}

/** A deployed page's first visit: it registers the code cache and keeps its code. */
async function firstVisit(page) {
  await openDataset(page, DEPLOYED_DATASET_URL);
  // Registered once the page loaded, for this build; the page is not taken over.
  const build = await page.locator('meta[name="cellucid-web-build-id"]').getAttribute('content');
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.scriptURL ?? null))
    .toBe(`${DEPLOYED_APP_ORIGIN}/service-worker.js?build=${encodeURIComponent(build)}`);
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBe(null);
  // Every startup file and the stylesheet are kept, under this build's cache.
  await expect.poll(() => keptFiles(page)).toEqual(expect.arrayContaining([...STARTUP_FILES, `/${STYLESHEET}`]));
  expect(await page.evaluate(() => caches.keys())).toEqual([`cellucid-code-${build}`]);
  // A dataset request of this site is not the cache's: it is never kept.
  expect((await keptFiles(page)).filter(path => path.startsWith('/tests/'))).toEqual([]);
}

test('a deployed page keeps its code in this browser, under its build', async ({ page }) => {
  await firstVisit(page);
});

test('the next visit of a deployed page takes its code from this browser', async ({ page, browserName }) => {
  test.skip(
    browserName === 'firefox',
    "Playwright's Firefox (Juggler) leaves a navigation the service worker does not answer uncontrolled; " +
      'the same build without Playwright or over WebDriver BiDi does not (see the header of this file).',
  );
  await firstVisit(page);

  // The next visit starts under the worker, which answers every startup file
  // (`workerStart` marks it in Chromium and WebKit; Firefox 153 leaves it 0
  // for a file its worker answered, so it would need another witness).
  await openDataset(page, DEPLOYED_DATASET_URL);
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  const answered = await page.evaluate(files => performance.getEntriesByType('resource')
    .filter(entry => files.includes(new URL(entry.name).pathname))
    .map(entry => ({ path: new URL(entry.name).pathname, viaWorker: entry.workerStart > 0 })), STARTUP_FILES);
  expect(answered.map(({ path }) => path).sort()).toEqual([...STARTUP_FILES].sort());
  expect(answered.filter(({ viaWorker }) => !viaWorker)).toEqual([]);
  // A dataset request of this site is not the cache's: it is never kept.
  expect((await keptFiles(page)).filter(path => path.startsWith('/tests/'))).toEqual([]);
});

test('a page on this machine registers no code cache', async ({ page }) => {
  await page.addInitScript(() => {
    window.__registrations = [];
    const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = (...args) => {
      window.__registrations.push(String(args[0]));
      return register(...args);
    };
  });
  await openDataset(page, LOCAL_DATASET_URL);
  // The boot script asks for its registration in a load listener, which has
  // run by now; a task later, nothing was asked for.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  expect(await page.evaluate(() => window.__registrations)).toEqual([]);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
});
