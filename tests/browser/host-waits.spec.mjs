/**
 * A wait a host names is waited for, said, and never taken for a failure
 * (`formats/io/byte-source.js` `withRetries`, `formats/io/hosts.js`): a
 * served store's `503` "being prepared" with `Retry-After` and its own words,
 * and a host's spent request budget (`X-RateLimit-*`, as Zenodo states it).
 * The file is a fixture `.h5ad` behind a routed host, so the answers are
 * exactly what each case needs; it is small enough that its probe's head
 * read holds all of it, so the waits are the probe's, said as the opening's
 * step (the reader's own are said on its read activity and the Transfers
 * log: `tests/host-budget-contract.test.mjs`).
 */
import { readFileSync } from 'node:fs';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';

const REMOTE = 'https://data.host-waits.test';
const BYTES = new Uint8Array(readFileSync(new URL('../fixtures/gene-read/cellxgene-shaped.h5ad', import.meta.url)));
const EXPOSED = 'ETag, Last-Modified, Content-Range, Content-Length, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset';

/** The file's answer to one request: a HEAD, or a range. */
function answer(route) {
  const request = route.request();
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': EXPOSED,
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
    ETag: '"waits-v1"',
  };
  if (request.method() === 'HEAD') {
    return route.fulfill({ status: 206, headers: { ...headers, 'Content-Length': String(BYTES.length), 'Content-Range': `bytes 0-${BYTES.length - 1}/${BYTES.length}` }, body: '' });
  }
  const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(request.headers().range ?? '').map(Number);
  const last = Math.min(end, BYTES.length - 1);
  return route.fulfill({ status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${last}/${BYTES.length}` }, body: Buffer.from(BYTES.subarray(start, last + 1)) });
}

/** Every text the opening's step shows (the opening overlay), as it changes. */
async function recordSteps(page) {
  await page.addInitScript(() => {
    window.__openingSteps = [];
    new MutationObserver(() => {
      for (const step of document.querySelectorAll('.opening-step')) {
        const text = step.textContent ?? '';
        if (text !== '' && window.__openingSteps.at(-1) !== text) window.__openingSteps.push(text);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

function watch(page) {
  const lines = { info: [], errors: [] };
  page.on('console', message => {
    // The browser's own line for an answer it was given (a 503, a 429): not the app's.
    if (message.type() === 'error' && !/^Failed to load resource: the server responded with a status of (503|429)\b/.test(message.text())) lines.errors.push(message.text());
    else lines.info.push(message.text());
  });
  page.on('pageerror', error => lines.errors.push(error.message));
  return lines;
}

test('a server preparing what was asked for is waited for as long as it asks, in its own words, and the file opens', async ({ browserName, page }) => {
  test.skip(browserName === 'firefox', 'Firefox does not route requests made by the AnnData reader worker');
  const url = `${REMOTE}/served/prepared.h5ad`;
  const words = 'X is being laid out gene-major for the viewer (60% done, about 1 s left).';
  let preparing = 3;
  await page.route(url, route => {
    if (route.request().method() === 'GET' && preparing > 0) {
      preparing--;
      return route.fulfill({
        status: 503,
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': EXPOSED, 'Retry-After': '1', 'Content-Type': 'text/plain', 'Content-Length': String(words.length) },
        body: words,
      });
    }
    return answer(route);
  });
  await recordSteps(page);
  const lines = watch(page);
  const started = Date.now();
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(url)}`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 60_000 }).toBe(300);
  expect(Date.now() - started, 'each wait as long as asked').toBeGreaterThanOrEqual(1000);
  const steps = await page.evaluate(() => window.__openingSteps);
  expect(steps.some(text => text.includes(words)), `the server's own words are the opening's step (${steps.join(' | ')})`).toBe(true);
  expect(lines.info.filter(line => /Asked \d+ times? so far/.test(line)), 'never retried as a failure').toEqual([]);
  expect(lines.errors).toEqual([]);
});

test('a host whose request budget is spent is waited for until it refills, and the file opens', async ({ browserName, page }) => {
  test.skip(browserName === 'firefox', 'Firefox does not route requests made by the AnnData reader worker');
  const url = `${REMOTE}/limited/budget.h5ad`;
  let refused = 0;
  let refillAt = 0;
  await page.route(url, route => {
    const now = Date.now();
    if (route.request().method() === 'GET' && refused === 0) {
      refused++;
      refillAt = now + 2000;
    }
    const budget = {
      'X-RateLimit-Limit': '133',
      'X-RateLimit-Remaining': now < refillAt ? '0' : '132',
      'X-RateLimit-Reset': String(Math.ceil((now < refillAt ? refillAt : now + 60_000) / 1000)),
    };
    if (now < refillAt) {
      return route.fulfill({ status: 429, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': EXPOSED, ...budget }, body: '' });
    }
    return answer(route).then(() => undefined);
  });
  await recordSteps(page);
  const lines = watch(page);
  const started = Date.now();
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(url)}`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 60_000 }).toBe(300);
  expect(Date.now() - started, 'waited for the refill').toBeGreaterThanOrEqual(1000);
  const steps = await page.evaluate(() => window.__openingSteps);
  expect(steps.some(text => /limits how many requests it answers/.test(text)), `the wait is the opening's step (${steps.join(' | ')})`).toBe(true);
  expect(lines.info.filter(line => /Asked \d+ times? so far/.test(line)), 'never retried as a failure').toEqual([]);
  expect(lines.errors).toEqual([]);
});
