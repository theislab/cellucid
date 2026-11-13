import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

// A link whose host does not give what was asked for says who is at fault
// (`hostFaultSentence`, `formats/io/byte-source.js`): the host failing or
// limiting on its side, refusing this network although what it serves is
// public, the link's permissions, nothing at the address, or this computer
// offline; named with the provider the host serves, with the status; Try
// again first where asking again may help. Every provider host is answered
// here by a stub (no request leaves the machine): an outage of NCBI
// answered HTTP 500 and 403 for every file under /geo/.

const PINNED = `sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&`;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type' };
const PASSES = ['Try again', 'Open without this link'];
const SETTLED = ['Open without this link', 'Try again'];

const CASES = [
  {
    name: 'GEO file, NCBI failing (500)', data: 'geo:GSE350831/GSE350831_Flex.h5ad', host: /ftp\.ncbi\.nlm\.nih\.gov/, status: 500,
    said: /^NCBI GEO \(ftp\.ncbi\.nlm\.nih\.gov\) is not answering \(HTTP 500, a server error\) for GSE350831_Flex\.h5ad: a problem on NCBI GEO's side, not with the link or with Cellucid\./,
    actions: PASSES,
  },
  {
    name: 'web address, missing (404)', data: 'https://data.example.test/lab/atlas.h5ad', host: /data\.example\.test/, status: 404,
    said: /^atlas\.h5ad was not found at data\.example\.test \(HTTP 404, not found\): the link or record does not exist/,
    actions: SETTLED,
  },
  {
    name: 'web address, this computer offline', data: 'https://data.example.test/lab/atlas.h5ad', host: /data\.example\.test/, status: 'offline',
    said: /^This computer is offline, so atlas\.h5ad cannot be read from data\.example\.test: the connection on this side/,
    actions: PASSES,
  },
];

for (const scenario of CASES) {
  test(`a host fault is said as whose it is: ${scenario.name}`, async ({ page, browserName }, testInfo) => {
    test.setTimeout(90_000);
    if (scenario.status === 'offline') {
      await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false }));
    }
    await page.context().route(url => scenario.host.test(new URL(url).host), route => {
      if (scenario.status === 'offline') return route.abort('internetdisconnected');
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { ...CORS, 'Access-Control-Allow-Headers': 'Range' } });
      }
      return route.fulfill({ status: scenario.status, headers: { ...CORS, 'Content-Type': 'text/html' }, body: `<h1>${scenario.status}</h1>` });
    });
    await page.goto(`/?${PINNED}data=${encodeURIComponent(scenario.data)}`, { waitUntil: 'domcontentloaded' });
    const failed = page.locator('.opening-overlay[data-state="failed"]:not([hidden])');
    await expect(failed).toBeVisible({ timeout: 60_000 });
    await expect(failed.locator('.opening-title')).toHaveText('The data could not be opened');
    await expect(failed.locator('.opening-step')).toHaveText(scenario.said);
    await expect(failed.locator('.opening-actions button')).toHaveText(scenario.actions);
    // Details hold the sentence and what met it: never empty, never only a stack.
    await expect(failed.locator('.opening-failure .welcome-details-text')).not.toHaveText('');
    const shots = process.env.CELLUCID_HOST_FAULT_SHOTS;
    const path = shots ? `${shots}/${browserName}-${testInfo.title.replace(/[^a-z0-9]+/gi, '-').slice(-60)}.png` : testInfo.outputPath('host-fault.png');
    await page.screenshot({ path });
  });
}

test('a link opened from the bar over a dataset says its host\'s fault in a notification with Try again', async ({ page, browserName }) => {
  test.setTimeout(90_000);
  let failing = true;
  await page.context().route(url => new URL(url).host === 'data.example.test', route => (failing
    ? route.fulfill({ status: 503, headers: { ...CORS, 'Content-Type': 'text/html' }, body: '<h1>503</h1>' })
    : route.fulfill({ status: 404, headers: CORS, body: '' })));
  // A sample on screen: the link's failure is a notification beside it.
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  const shown = (await page.locator('#dataset-name').textContent()).trim();
  await page.locator('#data-address').fill('https://data.example.test/lab/atlas.h5ad');
  await page.locator('#data-address-open-btn').click();
  const card = page.locator('#notification-center .notification')
    .filter({ hasText: /data\.example\.test is not answering \(HTTP 503, service unavailable\) for atlas\.h5ad: a problem on data\.example\.test's side/ });
  await expect(card).toHaveCount(1, { timeout: 60_000 });
  await expect(card.locator('.notification-action')).toHaveText('Try again');
  // The dataset on screen stays.
  await expect(page.locator('#dataset-name')).toHaveText(shown);
  const shots = process.env.CELLUCID_HOST_FAULT_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/${browserName}-bar-notification-try-again.png` });
  // Try again asks the same address again: the host's answer now (nothing there) is said.
  failing = false;
  await card.locator('.notification-action').click();
  await expect(page.locator('#notification-center .notification')
    .filter({ hasText: /atlas\.h5ad was not found at data\.example\.test \(HTTP 404, not found\)/ })).toHaveCount(1);
  await expect(page.locator('#dataset-name')).toHaveText(shown);
});
