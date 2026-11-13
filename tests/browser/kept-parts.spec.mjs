/**
 * The parts of a remote file downloaded before are kept in this browser
 * across visits (`formats/io/kept-parts.js`), in the app: a dataset stored
 * cell by cell (CSR) opened by link, two genes read; then a later visit (a
 * reload: a new page and reader worker, the same browser storage) opens it
 * again and reads the same two genes with no byte of the file downloaded --
 * not its structure, not its embedding, not the genes. The only request is
 * the probe of the file's version (a `HEAD`, no body), asked of the host at
 * every opening. A visit closed the moment its reads ended keeps all it
 * read (each piece is kept as it arrives): a later visit downloads none of
 * it. Version changes, damage, eviction and credentials are held exactly by
 * `tests/kept-parts-contract.test.mjs` and
 * `tests/kept-parts-leave-contract.test.mjs`.
 */

import { readFileSync } from 'node:fs';
import { closePageWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { anndataZarrZip } from './helpers/anndata-zarr-zip.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { workersKeepFiles } from './helpers/origin-storage.mjs';
import { waitForPageAtRest } from './helpers/dataset-ready.mjs';

// A context that keeps an origin-private file system, as an ordinary
// browser window does (`helpers/test.mjs` `persistentStorage`).
test.use({ persistentStorage: true });

/**
 * The files' host: a remote one. A server on this machine (the test's own,
 * on a loopback address) is read in place and nothing of it is kept
 * (`kept-parts.js` `sameMachine`), so the files are answered here, as the
 * remote host would answer them.
 */
const REMOTE = 'https://data.kept-parts.test';

const CELLS = 2400;
const GENES = 700;
const PER_CELL = 600;

/** A CSR dataset in a stored `.zarr.zip`, with a 2-D embedding. */
function csrDataset() {
  const data = new Float32Array(CELLS * PER_CELL);
  const indices = new Int32Array(CELLS * PER_CELL);
  const indptr = new Int32Array(CELLS + 1);
  for (let cell = 0; cell < CELLS; cell++) {
    const genes = Array.from({ length: PER_CELL }, (_, j) => (cell * 37 + j) % GENES).sort((a, b) => a - b);
    genes.forEach((gene, j) => {
      indices[cell * PER_CELL + j] = gene;
      data[cell * PER_CELL + j] = 1 + ((cell * 7 + gene) % 13);
    });
    indptr[cell + 1] = (cell + 1) * PER_CELL;
  }
  return anndataZarrZip({
    cells: CELLS,
    genes: Array.from({ length: GENES }, (_, g) => `g${g}`),
    X: { data, indices, indptr },
    obsm: { X_umap: { data: Float32Array.from({ length: CELLS * 2 }, (_, i) => Math.sin(i) * 10), columns: 2 } },
  });
}

/**
 * The file with a version (ETag and Last-Modified); every request and every
 * body byte counted. A `HEAD` with a range is answered as S3 answers it
 * (206, `Content-Range`: the version and that ranges are read, no body); a
 * host that ignores the range on a `HEAD` costs the probe one 1-byte range
 * request more, at every opening.
 */
function serveVersioned(route, bytes, counter) {
  const request = route.request();
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'ETag, Last-Modified, Content-Range, Content-Length',
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
    ETag: '"kept-v1"',
    'Last-Modified': 'Tue, 27 Oct 2026 10:00:00 GMT',
  };
  if (request.method() === 'HEAD') {
    counter.heads++;
    const ranged = /^bytes=0-$/.test(request.headers().range ?? '');
    return route.fulfill({
      status: ranged ? 206 : 200,
      headers: { ...headers, 'Content-Length': String(bytes.length), ...(ranged ? { 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}` } : {}) },
      body: '',
    });
  }
  counter.gets++;
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? '');
  if (range === null) {
    counter.bytes += bytes.length;
    return route.fulfill({ status: 200, headers, body: Buffer.from(bytes) });
  }
  const start = Number(range[1]);
  const end = Math.min(range[2] === '' ? bytes.length - 1 : Number(range[2]), bytes.length - 1);
  counter.bytes += end - start + 1;
  return route.fulfill({ status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }, body: Buffer.from(bytes.subarray(start, end + 1)) });
}

async function chooseGene(page, name) {
  const search = page.locator('#gene-expression-search');
  await search.click();
  await search.fill(name);
  await search.press('Enter');
  await expect.poll(() => page.evaluate(gene => {
    const state = window._cellucidState;
    return state.activeFieldSource === 'var' && state.varData.fields[state.activeVarFieldIndex]?.key === gene;
  }, name), { timeout: 60_000 }).toBe(true);
}

async function geneValues(page) {
  return page.evaluate(() => {
    const state = window._cellucidState;
    return Array.from(state.varData.fields[state.activeVarFieldIndex].values);
  });
}

/**
 * Wait until the page's reads have ended: the page at rest (startup over,
 * the gene list read, the viewer settled) and no read operation under way
 * (`data/read-activity-log.js`, the page's own module). A spec that sees
 * no request for a while sees only that none was made in that while.
 */
async function readsEnded(page) {
  await waitForPageAtRest(page, { timeout: 120_000 });
  await expect.poll(() => page.evaluate(async () => {
    const { getReadActivityLog } = await import('/assets/js/data/read-activity-log.js');
    const reading = getReadActivityLog().entries().map(activity => activity.label);
    return reading.length === 0 ? 'ended' : `reading: ${reading.join(', ')}`;
  }), { timeout: 60_000 }).toBe('ended');
}

/**
 * Wait until what the page's reads fetched is kept: its reads ended, and no
 * journal of parts still written. A reader closes its journal once its
 * reads go quiet (`formats/io/kept-parts.js`), letting go of the journal's
 * `#writing` lock (`space.js` `openKeptJournal`), and a later visit reads
 * only a closed journal.
 */
async function readsKept(page) {
  await readsEnded(page);
  await expect.poll(() => page.evaluate(async () => {
    const writing = (await navigator.locks.query()).held
      .map(lock => lock.name)
      .filter(name => name.endsWith('#writing'));
    return writing.length === 0 ? 'kept' : `writing: ${writing.join(', ')}`;
  }), { timeout: 60_000 }).toBe('kept');
}

/**
 * The bytes of downloaded parts kept in this browser, or null without an
 * origin-private file system. The app's own listing (`listKeptStores`): it
 * reads each directory under the lock its removal takes. Read without that
 * lock, a kept file whose directory goes meanwhile fails in WebKit, which
 * says so on the page's console ("Failed to load resource: ...
 * WebKitBlobResource error 1": a `File` read after its file or directory was
 * removed, or one rewritten while it is read; `space.js` `filesOf` holds both
 * under one lock; measured: 38_decisions_testing_and_hosted_runners.md).
 */
async function keptPartBytes(page) {
  return page.evaluate(async () => {
    const { TRANSCODED_DIRECTORY, listKeptStores } = await import('/assets/js/data/anndata/transcode/space.js');
    try {
      await (await navigator.storage.getDirectory()).getDirectoryHandle(TRANSCODED_DIRECTORY);
    } catch {
      return null;
    }
    const kept = await listKeptStores();
    return kept.filter(item => item.kind === 'parts').reduce((bytes, item) => bytes + item.saves, 0);
  });
}

test('a later visit downloads nothing it read before: the open, the embedding and two genes', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  const url = `${REMOTE}/kept-parts/csr.zarr.zip`;
  const bytes = csrDataset();
  const counter = { heads: 0, gets: 0, bytes: 0 };
  await page.route(url, route => serveVersioned(route, bytes, counter));
  const link = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(url)}`;

  // First visit: opened, the embedding shown, two genes read.
  await page.goto(link, { waitUntil: 'domcontentloaded' });
  const keeps = await workersKeepFiles(page);
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 60_000 }).toBe(CELLS);
  await openCollapsedPanels(page);
  await chooseGene(page, 'g5');
  const g5 = await geneValues(page);
  await chooseGene(page, 'g9');
  const g9 = await geneValues(page);
  const firstBytes = counter.bytes;
  expect(firstBytes).toBeGreaterThan(0);
  if (!keeps) {
    // No storage the reader worker can write: nothing is kept, and a later visit downloads again.
    expect(await keptPartBytes(page)).toBeNull();
    expect(errors).toEqual([]);
    return;
  }
  // What the first visit downloaded is kept, once its reads went quiet.
  await readsKept(page);
  expect(await keptPartBytes(page)).toBeGreaterThan(0);

  // A later visit: the page and its reader worker anew, the same storage.
  const before = { ...counter };
  await page.goto(link, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 60_000 }).toBe(CELLS);
  await openCollapsedPanels(page);
  await chooseGene(page, 'g5');
  expect(await geneValues(page)).toEqual(g5);
  await chooseGene(page, 'g9');
  expect(await geneValues(page)).toEqual(g9);
  test.info().annotations.push({ type: 'downloads', description: `first visit ${firstBytes} bytes in ${before.gets} requests; later visit ${counter.bytes - before.bytes} bytes, ${counter.gets - before.gets} GET, ${counter.heads - before.heads} HEAD` });
  expect(counter.bytes - before.bytes, 'no byte downloaded again').toBe(0);
  expect(counter.gets - before.gets, 'no GET request').toBe(0);
  // The version is asked of the host at every opening (a HEAD, no body).
  expect(counter.heads - before.heads).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('a visit cut short at once keeps what it read: the page closed the moment its reads ended, a later visit downloads none of it', async ({ page }) => {
  test.setTimeout(240_000);
  const url = `${REMOTE}/kept-parts/short.h5ad`;
  const bytes = new Uint8Array(readFileSync(new URL('../fixtures/gene-read/cellxgene-shaped.h5ad', import.meta.url)));
  const counter = { heads: 0, gets: 0, bytes: 0 };
  // A slow host (each answer a second late): the link's retransmission
  // timeout is several seconds, and nothing waits for it to keep a byte.
  const slow = async route => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    return serveVersioned(route, bytes, counter);
  };
  const link = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(url)}`;
  await page.route(url, slow);
  await page.goto(link, { waitUntil: 'domcontentloaded' });
  const keeps = await workersKeepFiles(page);
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 120_000 }).toBe(300);
  test.skip(!keeps, 'this browser gives the reader worker no storage it can write');
  await readsEnded(page);
  const first = { ...counter };
  // A read does not wait for the disk: what it fetched is written in the worker's next
  // turns, and a page closed before that fetches the last range again (now and then on
  // Firefox under load; a harmless cost of reads that never wait to be kept). What is
  // held here is that nothing more is needed once it is written: the journal open, no
  // quiet time gone by, nothing flushed, no page event.
  await expect.poll(() => keptPartBytes(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(first.bytes);
  // The tab is closed the moment that is so: no linger, no hidden page;
  // the application is torn down first, which ends its reader workers from
  // outside (nothing they were asked to keep is waited for).
  const context = page.context();
  await closePageWithApplicationRetirement(page);

  const later = await context.newPage();
  await later.route(url, slow);
  await later.goto(link, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => later.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 120_000 }).toBe(300);
  await readsEnded(later);
  test.info().annotations.push({ type: 'downloads', description: `first visit ${first.bytes} bytes in ${first.gets} GET; later visit ${counter.bytes - first.bytes} bytes, ${counter.gets - first.gets} GET, ${counter.heads - first.heads} HEAD` });
  expect(counter.gets - first.gets, 'no GET: every byte the short visit read was kept').toBe(0);
  expect(counter.bytes - first.bytes).toBe(0);
  await closePageWithApplicationRetirement(later);
});
