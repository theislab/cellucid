/**
 * The gene index of a file stored cell by cell, kept in this browser across
 * visits (`anndata/kept-column-index.js`), in the app: opened again later
 * (a reload: a new page and reader worker, the same browser storage) with the
 * same cells, a gene shows at once — whole from its first colours, with no
 * index read: the link's `ETag` says only when the file was written, so the
 * kept runs' fingerprints (a few chunks) are read first, and each gene's
 * values — and the Session panel's Stored line names the index, refreshed
 * as the runs are kept (the page holds each, then its worker lets go). That
 * only the new cells are indexed for a larger share, integrity, identity,
 * fingerprints and eviction are held exactly by
 * `tests/kept-column-index-contract.test.mjs`.
 *
 * What the later visit reads is held by what it is, not by how many requests
 * carry it: how reads are shaped into requests follows the link as measured
 * (gaps merged within its bandwidth x round trip, the page's range cache
 * asked for no longer than a round trip, `formats/io/link.js`), and a link
 * to a server on this machine, measured at a millisecond or two, varies from
 * run to run and engine to engine.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { anndataZarrZip } from './helpers/anndata-zarr-zip.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

// A context that keeps an origin-private file system, as an ordinary
// browser window does (`helpers/test.mjs` `persistentStorage`: on WebKit a
// persistent context, where its reader worker has synchronous access
// handles as Safari's has).
test.use({ persistentStorage: true });

const CELLS = 2400;
const GENES = 700;
const PER_CELL = 600;

function wideDataset() {
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
 * Where each stored file of a `.zarr.zip` (stored, not deflated) lies in it:
 * name -> `[start, end)` of its bytes, from the central directory.
 */
function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end--;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = Buffer.from(bytes.subarray(at + 46, at + 46 + nameLength)).toString('utf8');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    entries.set(name, [start, start + size]);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The read operations of the open dataset, as the app's read activity log has them. */
async function readActivities(page) {
  return page.evaluate(async () => {
    const { getReadActivityLog } = await import('/assets/js/data/read-activity-log.js');
    return getReadActivityLog().entries().map(({ kind, label, status }) => ({ kind, label, status }));
  });
}

/** The file, with an ETag (a version: what it is kept under across visits); every range request counted. */
function serveVersioned(route, bytes, counter) {
  const request = route.request();
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'ETag, Content-Range, Content-Length',
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
    ETag: '"wide-v1"',
  };
  if (request.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...headers, 'Content-Length': String(bytes.length) }, body: '' });
  counter.requests++;
  counter.ranges.push(request.headers().range ?? null);
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? '');
  if (range === null) return route.fulfill({ status: 200, headers, body: bytes });
  const start = Number(range[1]);
  const end = Math.min(range[2] === '' ? bytes.length - 1 : Number(range[2]), bytes.length - 1);
  return route.fulfill({ status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }, body: bytes.subarray(start, end + 1) });
}

/** Whether a worker of this page can keep files in the origin-private file system (not in a private window). */
async function workersHaveOpfs(page) {
  return page.evaluate(() => {
    const source = 'onmessage = async () => { try { await navigator.storage.getDirectory(); postMessage(true); } catch { postMessage(false); } };';
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    return new Promise(resolve => {
      worker.onmessage = event => {
        worker.terminate();
        resolve(event.data === true);
      };
      worker.postMessage(null);
    });
  });
}

/** The rows of every kept run's fingerprint, from the manifests in this browser's storage. */
async function fingerprintRows(page) {
  return page.evaluate(async () => {
    const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle('cellucid-transcoded');
    let rows = 0;
    for await (const [, folder] of parent.entries()) {
      if (folder.kind !== 'directory') continue;
      const manifest = JSON.parse(await (await (await folder.getFileHandle('manifest.json')).getFile()).text());
      if (manifest.kind === 'column-index') rows += manifest.fingerprint?.length ?? 0;
    }
    return rows;
  });
}

async function recordPartials(page) {
  await page.evaluate(() => {
    const state = window._cellucidState;
    window.__partials = [];
    const show = state.showPartialVarField.bind(state);
    state.showPartialVarField = (index, values) => {
      window.__partials.push(values.length);
      return show(index, values);
    };
  });
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

test('a later visit opening the same cells shows genes at once from the gene index kept in this browser', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  const url = `${SAMPLE_ORIGIN}/kept-index/wide.zarr.zip`;
  const bytes = wideDataset();
  const counter = { requests: 0, ranges: [] };
  await page.route(url, route => serveVersioned(route, bytes, counter));
  const link = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(url)}&cells=1000&sample=uniform&seed=3`;

  // First visit: the gene's index is built, then kept.
  await page.goto(link, { waitUntil: 'domcontentloaded' });
  expect(await workersHaveOpfs(page), 'the reader worker has an origin-private file system').toBe(true);
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 60_000 }).toBe(1000);
  await openCollapsedPanels(page);
  const opened = counter.requests;
  await chooseGene(page, 'g5');
  const firstGeneRequests = counter.requests - opened;
  const first = await geneValues(page);
  // The first visit indexes the matrix by gene (what a later visit must not do again).
  expect((await readActivities(page)).filter(activity => activity.kind === 'index').length).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(async () => {
    const { keptStoresUsage } = await import('/assets/js/data/anndata/transcode/space.js');
    return (await keptStoresUsage()).indexes;
  }), { timeout: 60_000 }).toBe(1);
  // The line hears the runs kept after the opening ended.
  await expect(page.locator('#kept-stores-text')).toHaveText(/the gene index of 1 file stored cell by cell kept in this browser/i, { timeout: 30_000 });

  // A later visit (the page and its reader worker anew, the same storage).
  await page.goto(link, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 60_000 }).toBe(1000);
  await openCollapsedPanels(page);
  await expect(page.locator('#kept-stores-text')).toHaveText(/the gene index of 1 file stored cell by cell kept in this browser \(.+\): opened again with the same cells, its genes are read at once/i, { timeout: 30_000 });
  await recordPartials(page);
  const before = counter.requests;
  const rangesBefore = counter.ranges.length;
  await chooseGene(page, 'g5');
  expect(await geneValues(page)).toEqual(first);
  await chooseGene(page, 'g9');
  // Whole from the start, with no index read: the runs' fingerprints (a link's
  // ETag does not name the file's content) and each gene's values (over a
  // link the app measures slower than a disk, the index is the structure and
  // a gene's values are read as it is shown).
  expect(await page.evaluate(() => window.__partials)).toEqual([]);
  expect((await readActivities(page)).filter(activity => activity.kind === 'index'), 'no gene index is built again').toEqual([]);
  const rows = await fingerprintRows(page);
  expect(rows).toBeGreaterThan(0);
  // Of the index (the column indices of X), only the fingerprint rows: a
  // range per row, whole rows (one row's entries are PER_CELL int32), fewer
  // ranges where the link joins rows close enough to cost less than a request.
  const [indicesStart, indicesEnd] = zipEntries(bytes).get('X/indices/0');
  const rowBytes = PER_CELL * Int32Array.BYTES_PER_ELEMENT;
  const indexReads = counter.ranges.slice(rangesBefore)
    .map(range => /^bytes=(\d+)-(\d+)$/.exec(range ?? ''))
    .map(match => (match === null ? null : [Number(match[1]), Number(match[2]) + 1]))
    .filter(range => range === null || (range[0] < indicesEnd && range[1] > indicesStart));
  expect(indexReads.length).toBeGreaterThan(0);
  expect(indexReads.length).toBeLessThanOrEqual(rows);
  for (const range of indexReads) {
    expect(range, 'a bounded range').not.toBeNull();
    expect([(range[0] - indicesStart) % rowBytes, (range[1] - indicesStart) % rowBytes, range[0] >= indicesStart, range[1] <= indicesEnd], `${range}: whole rows of the index`).toEqual([0, 0, true, true]);
  }
  test.info().annotations.push({ type: 'requests', description: `first visit, first gene ${firstGeneRequests}; later visit, two genes ${counter.requests - before} (${rows} fingerprint rows, ${indexReads.length} reads of the index)` });
  expect((await geneValues(page)).filter(Number.isNaN)).toEqual([]);
  expect(errors).toEqual([]);
});
