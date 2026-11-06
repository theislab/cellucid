/**
 * The gene index of a file stored cell by cell, kept in this browser across
 * visits (`anndata/kept-column-index.js`), in the app: opened again later
 * (a reload: a new page and reader worker, the same browser storage) with the
 * same cells, a gene shows at once — whole from its first colours, with
 * nothing of the index read (the link's version, its ETag, is the one the
 * runs were kept under), only each gene's values not read before — and the
 * Session panel's Stored line names the index, refreshed as the runs are
 * kept (the page holds each, then its worker lets go). That only the new
 * cells are indexed for a larger share, integrity, identity and eviction
 * are held exactly by `tests/kept-column-index-contract.test.mjs`; that the
 * parts read before are not downloaded again, by
 * `tests/browser/kept-parts.spec.mjs`.
 *
 * What the later visit reads is held by what it is, not by how many requests
 * carry it: how reads are shaped into requests follows the link as measured
 * (gaps merged within its bandwidth x round trip, the page's range cache
 * asked for no longer than a round trip, `formats/io/link.js`), and a link
 * to a server on this machine, measured at a millisecond or two, varies from
 * run to run and engine to engine.
 *
 * Both visits plan on the fixture's device (`helpers/device.mjs`): the link
 * and the decoding rate held, genes are read for every open cell in the
 * share's own order on each. Measured, a hosted macOS WebKit runner read
 * them for a sample on one visit only, twice: on the first (its gene shown
 * on 606 of the 1,000 cells, the rest NaN, Web contracts run 42180511574),
 * and on the later (811 of the 1,000, in the file's cell order of blocks of
 * 1,792, where the first visit had read every cell in the share's own
 * order, run 42202865024). Every value of both visits is its cell's (each
 * checked against the fixture's own formula); what differed is which cells
 * were read and where they stand, which the spec compares position by
 * position. A sample on the later visit also indexes the matrix again: an
 * index kept under the share's own order is not looked for under a sample's
 * cell order.
 *
 * WebKit keeps a persistent context's origin storage outside its profile
 * folder (`helpers/test.mjs` `clearOriginStorage`), and two workers running
 * specs of `persistentStorage` at once lose what they kept: this spec and
 * `kept-parts.spec.mjs` failed 6 of 12 runs with two workers ("no gene
 * index is built again", "no byte downloaded again"), and in none of 120
 * with one, as CI runs them, was anything kept lost (2026-11-06). Run them
 * with `--workers=1`.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { anndataZarrZip } from './helpers/anndata-zarr-zip.mjs';
import { openCollapsedPanels, openSessionSectionsOnLoad } from './helpers/panels.mjs';
import { workersKeepFiles } from './helpers/origin-storage.mjs';

// Cells to open, Genes read for and the data mapping are in the Session
// panel's sections, collapsed by default: open, as a viewer who opened them.
test.beforeEach(async ({ page }) => {
  await openSessionSectionsOnLoad(page);
});

// A context that keeps an origin-private file system, as an ordinary
// browser window does (`helpers/test.mjs` `persistentStorage`: on WebKit a
// persistent context, where its reader worker has synchronous access
// handles as Safari's has). Where the page still has none (Playwright
// 1.62's Linux WebKit has no `navigator.storage`), the test asks the page
// (`helpers/origin-storage.mjs`) and holds the app to what it does there:
// nothing kept, and a later visit indexes the matrix again.
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

/**
 * Record, from now on, every read operation the app's read activity log
 * tells of (it keeps only those under way): the page's own module, imported
 * once the app has loaded it.
 */
async function recordReadActivities(page) {
  await page.evaluate(async () => {
    const { getReadActivityLog } = await import('/assets/js/data/read-activity-log.js');
    window.__readActivities = new Map();
    getReadActivityLog().subscribe(activity => window.__readActivities.set(activity.id, activity));
  });
}

/** The read operations of the page, as the app's read activity log told of them. */
async function readActivities(page) {
  return page.evaluate(async () => {
    const { getReadActivityLog } = await import('/assets/js/data/read-activity-log.js');
    getReadActivityLog().flush();
    return [...window.__readActivities.values()].map(({ kind, label, status }) => ({ kind, label, status }));
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

/**
 * The files whose gene index this browser keeps (the distinct identities of
 * the kept runs' manifests), or null where the page has no origin-private
 * file system.
 */
async function keptIndexFiles(page) {
  return page.evaluate(async () => {
    let root;
    try {
      root = await navigator.storage.getDirectory();
    } catch {
      return null;
    }
    let parent;
    try {
      parent = await root.getDirectoryHandle('cellucid-transcoded');
    } catch {
      return 0;
    }
    const files = new Set();
    for await (const [, folder] of parent.entries()) {
      if (folder.kind !== 'directory') continue;
      try {
        const manifest = JSON.parse(await (await (await folder.getFileHandle('manifest.json')).getFile()).text());
        if (manifest.kind === 'column-index') files.add(manifest.source);
      } catch {
        // A run still being written has no manifest yet.
      }
    }
    return files.size;
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

/** The gene's values once every open cell's is in: it is shown as its cells are read, the rest NaN until then. */
async function geneValues(page) {
  const values = () => page.evaluate(() => {
    const state = window._cellucidState;
    return Array.from(state.varData.fields[state.activeVarFieldIndex].values);
  });
  await expect.poll(async () => (await values()).filter(Number.isNaN).length, { timeout: 60_000 }).toBe(0);
  return values();
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
  const keeps = await workersKeepFiles(page);
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 60_000 }).toBe(1000);
  await recordReadActivities(page);
  await openCollapsedPanels(page);
  const opened = counter.requests;
  await chooseGene(page, 'g5');
  const firstGeneRequests = counter.requests - opened;
  const first = await geneValues(page);
  // The first visit indexes the matrix by gene (what a later visit must not do again).
  expect((await readActivities(page)).filter(activity => activity.kind === 'index').length).toBeGreaterThan(0);
  if (keeps) {
    await expect.poll(() => keptIndexFiles(page), { timeout: 60_000 }).toBe(1);
    // The line hears the runs kept after the opening ended.
    await expect(page.locator('#kept-stores-line')).toBeVisible();
  } else {
    expect(await keptIndexFiles(page)).toBeNull();
    await expect(page.locator('#kept-stores-text'), 'nothing kept for a later visit (the row may name the connection speeds remembered)').not.toContainText('dataset');
  }

  // A later visit (the page and its reader worker anew, the same storage).
  await page.goto(link, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 60_000 }).toBe(1000);
  await recordReadActivities(page);
  await openCollapsedPanels(page);
  if (!keeps) {
    // Nothing was kept: the later visit indexes the matrix by gene again,
    // and its genes are what the first visit showed.
    await expect(page.locator('#kept-stores-text'), 'nothing kept for a later visit (the row may name the connection speeds remembered)').not.toContainText('dataset');
    await chooseGene(page, 'g5');
    expect(await geneValues(page)).toEqual(first);
    expect((await readActivities(page)).filter(activity => activity.kind === 'index').length, 'the gene index is built again').toBeGreaterThan(0);
    expect(await keptIndexFiles(page)).toBeNull();
    expect(errors).toEqual([]);
    return;
  }
  await expect(page.locator('#kept-stores-line')).toBeVisible();
  await recordPartials(page);
  const before = counter.requests;
  const rangesBefore = counter.ranges.length;
  await chooseGene(page, 'g5');
  expect(await geneValues(page)).toEqual(first);
  await chooseGene(page, 'g9');
  // Whole from the start, with no index read: only each gene's values not
  // read before (over a link the app measures slower than a disk, the index
  // is the structure and a gene's values are read as it is shown).
  expect(await page.evaluate(() => window.__partials)).toEqual([]);
  expect((await readActivities(page)).filter(activity => activity.kind === 'index'), 'no gene index is built again').toEqual([]);
  // Nothing of the index (the column indices of X) is fetched again.
  const [indicesStart, indicesEnd] = zipEntries(bytes).get('X/indices/0');
  const indexReads = counter.ranges.slice(rangesBefore)
    .map(range => /^bytes=(\d+)-(\d+)$/.exec(range ?? ''))
    .map(match => (match === null ? null : [Number(match[1]), Number(match[2]) + 1]))
    .filter(range => range === null || (range[0] < indicesEnd && range[1] > indicesStart));
  expect(indexReads, 'no read of the index').toEqual([]);
  test.info().annotations.push({ type: 'requests', description: `first visit, first gene ${firstGeneRequests}; later visit, two genes ${counter.requests - before}` });
  expect((await geneValues(page)).filter(Number.isNaN)).toEqual([]);
  expect(errors).toEqual([]);
});
