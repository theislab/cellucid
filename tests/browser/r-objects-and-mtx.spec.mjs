/**
 * Single-stream formats in the browser (`data/anndata/transcode/`): a
 * Seurat `.rds` picked with File…, a SingleCellExperiment `.rds` dropped, a
 * Seurat `.rds` opened from a link (one pass over the download), a `save()`
 * file of two objects (the opening asks which), and a MatrixMarket folder
 * chosen with Folder…. Each cannot be read in parts: the opening says so up
 * front, it is read whole once into this browser's storage (the
 * origin-private file system), opens with its cells drawn, and opened again,
 * in the same tab or on a later visit, reads what was kept and nothing of the
 * file; the Dataset box says how it was read, where it is kept and lists
 * every part that was not read, and Open data's Stored line counts what is
 * kept, with Clear. The fixtures are the R and MatrixMarket corpora
 * (`tests/fixtures/rds/corpus.zip`).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePageWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { createDrag, dragAndDrop, openZarrFolder } from './helpers/dataset-drop.mjs';
import { fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { createByteReader } from '../../assets/js/formats/io/byte-reader.js';
import { bytesByteSource } from '../../assets/js/formats/io/byte-source.js';
import { openZipArchive } from '../../assets/js/formats/zip/index.js';
import { chooseFiles } from './helpers/file-input.mjs';

const CORPUS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'rds', 'corpus.zip');
const PINNED = `sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&`;

// Each test runs in a context that keeps an origin-private file system, as
// an ordinary browser window does (`helpers/test.mjs` `persistentStorage`:
// on WebKit a persistent context; Playwright's ephemeral WebKit contexts
// have none, as a Safari private window has none).
test.use({ persistentStorage: true });

let archive = null;
async function corpusFile(name) {
  archive ??= await openZipArchive(createByteReader(bytesByteSource(new Uint8Array(await readFile(CORPUS)), { name: 'corpus.zip' })));
  return Buffer.from((await archive.entry(name).read()).slice());
}

/** One corpus folder written to disk, for the folder picker. */
async function corpusFolder(prefix, directory) {
  archive ??= await openZipArchive(createByteReader(bytesByteSource(new Uint8Array(await readFile(CORPUS)), { name: 'corpus.zip' })));
  for (const entry of archive.entries.filter(item => item.path.startsWith(`${prefix}/`))) {
    const target = path.join(directory, entry.path.slice(prefix.length + 1));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, (await entry.read()).slice());
  }
  return directory;
}

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function start(page) {
  await page.goto(`/?${PINNED}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready');
}

async function expectOpened(page, { name, cells }) {
  await expect(page.locator('#dataset-name')).toHaveText(name);
  await expect(page.locator('#dataset-cells')).toHaveText(String(cells));
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getPointCount())).toBe(cells);
}

/**
 * The directories this origin keeps transcoded stores in, or null where the
 * engine gives this page no origin-private file system (a private window,
 * Playwright's ephemeral WebKit contexts: the store is then kept in memory).
 */
async function keptStores(page) {
  return page.evaluate(async () => {
    let root;
    try {
      root = await navigator.storage.getDirectory();
    } catch {
      return null;
    }
    const names = [];
    try {
      const parent = await root.getDirectoryHandle('cellucid-transcoded');
      for await (const [name] of parent.entries()) names.push(name);
    } catch {
      return [];
    }
    return names;
  });
}

test('a Seurat .rds picked with File… opens, kept in this browser', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await start(page);
  // Files on disk: picked again, a file is the same file (name, size, time).
  const seurat = testInfo.outputPath('seurat5_gzip.rds');
  const sce = testInfo.outputPath('sce.rds');
  await writeFile(seurat, await corpusFile('rds/seurat5_gzip.rds'));
  await writeFile(sce, await corpusFile('rds/sce.rds'));
  await chooseFiles(page.locator('#user-data-file-input'), seurat);
  await expectOpened(page, { name: 'Corpus Seurat object', cells: 120 });
  const first = await keptStores(page);
  await chooseFiles(page.locator('#user-data-file-input'), sce);
  await expect(page.locator('#dataset-name')).toHaveText('sce');
  const both = await keptStores(page);
  // Opened again in the same tab: what was kept is read, nothing new is kept.
  await chooseFiles(page.locator('#user-data-file-input'), seurat);
  await expectOpened(page, { name: 'Corpus Seurat object', cells: 120 });
  if (first !== null) {
    expect(first).toHaveLength(1);
    expect(both).toHaveLength(2);
    expect(await keptStores(page)).toEqual(both);
  }
  expect(errors).toEqual([]);
});

test.describe('where a converted object is kept, with storage and without it', () => {
  // WebKit's test context has no storage here, as a Safari private window.
  test.use({ persistentStorage: false });

  test('the Dataset box says where a converted object is kept and every part it did not read', async ({ page }, testInfo) => {
    const errors = watchErrors(page);
    await start(page);
    const pbmc = testInfo.outputPath('pbmc_small.rda');
    const sce = testInfo.outputPath('sce.rds');
    await writeFile(pbmc, await corpusFile('rds/SeuratObject_5.4.0_pbmc_small.rda'));
    await writeFile(sce, await corpusFile('rds/sce.rds'));
    const line = page.locator('#dataset-conversion');
    const notRead = page.locator('#dataset-details-list dt:text-is("Not read") + dd > div');
    const kept = page.locator('#dataset-details-list dt:text-is("Kept") + dd');

    await chooseFiles(page.locator('#user-data-file-input'), pbmc);
    await expect(page.locator('#dataset-cells')).toHaveText('80');
    // WebKit runs this test as a Safari private window (no origin-private
    // file system, no IndexedDB): the store is kept in memory, and the box
    // says so; Chromium and Firefox keep it in storage.
    const inStorage = (await keptStores(page)) !== null;
    await expect(line).toHaveText(`${inStorage
      ? "Read whole once (it cannot be read in parts), kept in this browser's storage for next time"
      : 'Read whole once (it cannot be read in parts), into memory for this tab'} · 5 parts not read`);
    await expect(page.locator('#dataset-origin')).toHaveText('R data (.rda, .RData) · this computer');
    await page.locator('#dataset-details .disclosure-header').click();
    await expect(kept).toHaveText(inStorage
      ? "In this browser's storage (the origin-private file system) until it is cleared (Session › Open data: Stored, Clear) or the browser needs the room"
      : 'In memory until this tab closes: this browser gives this page no storage (as in a private window)');
    await expect(page.locator('#dataset-details-list dt:text-is("Read in parts") + dd')).toHaveText(/cellucid_prepare\(\) in R, cellucid\.prepare\(\) in Python/);
    await expect(notRead).toHaveText([
      'assays$RNA@scale.data (15 KB): Cellucid does not use it.',
      'reductions$pca@feature.loadings (3.5 KB): Cellucid does not use it.',
      'reductions$pca@feature.loadings.projected (3.5 KB): Cellucid does not use it.',
      'reductions$pca@jackstraw (4.8 KB): Cellucid does not use it.',
      'commands (7.4 KB): Cellucid does not use it.',
    ]);

    // An object that left nothing out has the line without a count, and no row.
    await chooseFiles(page.locator('#user-data-file-input'), sce);
    await expect(page.locator('#dataset-name')).toHaveText('sce');
    await expect(line).toHaveText(inStorage
      ? "Read whole once (it cannot be read in parts), kept in this browser's storage for next time"
      : 'Read whole once (it cannot be read in parts), into memory for this tab');
    await page.locator('#dataset-details .disclosure-header').click();
    await expect(kept).toBeVisible();
    await expect(notRead).toHaveCount(0);

    // Opened again in the tab: from what was kept, with the same notes.
    await chooseFiles(page.locator('#user-data-file-input'), pbmc);
    await expect(page.locator('#dataset-cells')).toHaveText('80');
    await expect(line).toHaveText(`${inStorage
      ? "Opened from this browser's storage, read whole on an earlier open"
      : 'Read whole once (it cannot be read in parts), into memory for this tab'} · 5 parts not read`);

    // An AnnData file is read in place: no such line.
    await chooseFiles(page.locator('#user-data-file-input'), path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'catalog', 'current-ui.h5ad'));
    await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
    await expect(line).toBeHidden();
    expect(errors).toEqual([]);
  });
});

test('a dropped SingleCellExperiment .rds and an uncompressed one open', async ({ page }) => {
  const errors = watchErrors(page);
  await start(page);
  for (const name of ['sce.rds', 'seurat5_none.rds']) {
    const buffer = await corpusFile(`rds/${name}`);
    const drag = await createDrag(page, { files: [{ name, base64: buffer.toString('base64') }] });
    await dragAndDrop(page, drag);
    await expect(page.locator('#dataset-cells')).toHaveText('120');
  }
  expect(errors).toEqual([]);
});

test('a Seurat .rds link opens in one pass over the download', async ({ page }) => {
  const errors = watchErrors(page);
  const url = `${SAMPLE_ORIGIN}/corpus/seurat5_xz.rds`;
  const bytes = await corpusFile('rds/seurat5_xz.rds');
  await page.route(url, route => fulfillFile(route, bytes));
  await page.goto(`/?${PINNED}data=${encodeURIComponent(url)}`, { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(page);
  await expectOpened(page, { name: 'Corpus Seurat object', cells: 120 });
  expect(errors).toEqual([]);
});

test('a save() file of two objects asks which to open', async ({ page }) => {
  const errors = watchErrors(page);
  await start(page);
  const buffer = await corpusFile('rds/two_objects.rda');
  await chooseFiles(page.locator('#user-data-file-input'), { name: 'two_objects.rda', mimeType: 'application/octet-stream', buffer });
  const panel = page.locator('.opening-overlay[data-state="choosing"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.opening-step')).toHaveText(/holds 2 single-cell objects\. Open which one\?/);
  const options = panel.locator('.opening-actions button');
  await expect(options).toHaveText([/^seu \(Seurat, 120 cells\)$/, /^sce \(SingleCellExperiment, 120 cells\)$/]);
  await options.nth(1).click();
  await expect(panel).toBeHidden();
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  expect(errors).toEqual([]);
});

test('a MatrixMarket folder chosen with Folder… opens with its cell table', async ({ page, browserName }, testInfo) => {
  const errors = watchErrors(page);
  await start(page);
  const directory = await corpusFolder('mtx/cellranger3', testInfo.outputPath('cellranger3'));
  await openZarrFolder(page, browserName, directory);
  await expectOpened(page, { name: 'cellranger3', cells: 90 });
  const inStorage = (await keptStores(page)) !== null;
  await expect(page.locator('#dataset-conversion')).toHaveText(inStorage
    ? "Read whole once (it cannot be read in parts), kept in this browser's storage for next time"
    : 'Read whole once (it cannot be read in parts), into memory for this tab');
  await expect(page.locator('#dataset-origin')).toHaveText('MatrixMarket folder · this computer');
  expect(errors).toEqual([]);
});

test('an .rds with no embedding is refused with what to do', async ({ page }) => {
  await start(page);
  const buffer = await corpusFile('rds/seurat5_noembedding.rds');
  await chooseFiles(page.locator('#user-data-file-input'), { name: 'bare.rds', mimeType: 'application/octet-stream', buffer });
  await expect(page.locator('#notification-center .notification[data-type="error"]').filter({ hasText: /has no cell embedding/ })).toHaveCount(1);
  expect([null, []]).toContainEqual(await keptStores(page));
});

/** A file host that names each file's version (an ETag), counting the bytes it sends; `hold` delays whole-file answers. */
function versionedHost(bytes, { hold = null } = {}) {
  const served = { bytes: 0, requests: 0 };
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
    ETag: '"corpus-1"',
  };
  const handler = async route => {
    const request = route.request();
    served.requests++;
    if (request.method() === 'HEAD') {
      return route.fulfill({ status: 200, headers: { ...headers, 'Content-Length': String(bytes.length) }, body: '' });
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? '');
    const start = range === null ? 0 : Number(range[1]);
    const end = range === null ? bytes.length - 1 : Math.min(range[2] === '' ? bytes.length - 1 : Number(range[2]), bytes.length - 1);
    if (hold !== null && end - start > 64) await hold;
    served.bytes += end - start + 1;
    return route.fulfill({
      status: range === null ? 200 : 206,
      headers: range === null ? headers : { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}` },
      body: bytes.subarray(start, end + 1),
    });
  };
  return { served, handler };
}

test('a picked .rds opened again on a later visit opens from what the first kept, and Stored says what is kept', async ({ page, context, browserName }, testInfo) => {
  const errors = watchErrors(page);
  await start(page);
  const seurat = testInfo.outputPath('seurat5_bzip2.rds');
  await writeFile(seurat, await corpusFile('rds/seurat5_bzip2.rds'));
  await chooseFiles(page.locator('#user-data-file-input'), seurat);
  await expectOpened(page, { name: 'Corpus Seurat object', cells: 120 });
  await expect(page.locator('#dataset-conversion')).toHaveText("Read whole once (it cannot be read in parts), kept in this browser's storage for next time");
  await expect(page.locator('#kept-stores-line')).toBeVisible();
  await expect(page.locator('#kept-stores-text')).toHaveText(/^1 file kept in this browser \(.+\): opened again, it is not read again \(in use by an open tab\)$/);
  const kept = await keptStores(page);
  expect(errors).toEqual([]);
  await closePageWithApplicationRetirement(page);

  // A later visit: a new page, the first one gone with its worker and locks.
  const later = await context.newPage();
  const laterErrors = watchErrors(later);
  await start(later);
  await expect(later.locator('#kept-stores-text')).toHaveText(/^1 file kept in this browser \(.+\): opened again, it is not read again$/);
  await chooseFiles(later.locator('#user-data-file-input'), seurat);
  await expectOpened(later, { name: 'Corpus Seurat object', cells: 120 });
  await expect(later.locator('#dataset-conversion')).toHaveText("Opened from this browser's storage, read whole on an earlier open");
  expect(await keptStores(later)).toEqual(kept);
  // Nothing to clear while the only kept file is in use by a tab.
  await expect(later.locator('#kept-stores-text')).toHaveText(/\(in use by an open tab\)$/);
  await expect(later.locator('#kept-stores-clear-btn')).toBeDisabled();
  expect(laterErrors).toEqual([]);
  await closePageWithApplicationRetirement(later);

  // A visit that has not opened it clears it.
  const third = await context.newPage();
  await start(third);
  await expect(third.locator('#kept-stores-text')).toHaveText(/^1 file kept in this browser \(.+\): opened again, it is not read again$/);
  await third.locator('#kept-stores-clear-btn').click();
  await expect(third.locator('#kept-stores-line')).toBeHidden();
  expect(await keptStores(third)).toEqual([]);
});

test('a linked .rds says up front that it is read whole, and a later visit downloads nothing of it', async ({ page, context, browserName }) => {
  const errors = watchErrors(page);
  const url = `${SAMPLE_ORIGIN}/corpus/versioned/seurat5_gzip.rds`;
  const bytes = await corpusFile('rds/seurat5_gzip.rds');
  let release;
  const first = versionedHost(bytes, { hold: new Promise(resolve => { release = resolve; }) });
  await page.route(url, first.handler);
  await page.goto(`/?${PINNED}data=${encodeURIComponent(url)}`, { waitUntil: 'domcontentloaded' });
  // Before the file's bytes arrive, the opening says what will happen.
  const note = page.locator('.opening-overlay .opening-note');
  await expect(note).toHaveText(/^An R object \(\.rds\) cannot be read in parts: all 22 KB of it is read once, and what Cellucid shows of it is kept /);
  await expect(note).toContainText('cellucid_prepare() in R, cellucid.prepare() in Python');
  await expect(page.locator('.opening-overlay .opening-step')).toHaveText(/Reading seurat5_gzip\.rds whole, once/);
  release();
  await openCollapsedPanels(page);
  await expectOpened(page, { name: 'Corpus Seurat object', cells: 120 });
  expect(first.served.bytes).toBeGreaterThanOrEqual(bytes.length);
  expect(errors).toEqual([]);
  await closePageWithApplicationRetirement(page);

  const later = await context.newPage();
  const again = versionedHost(bytes);
  await later.route(url, again.handler);
  await later.goto(`/?${PINNED}data=${encodeURIComponent(url)}`, { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(later);
  await expectOpened(later, { name: 'Corpus Seurat object', cells: 120 });
  await expect(later.locator('#dataset-conversion')).toHaveText("Opened from this browser's storage, read whole on an earlier open");
  // Only the link's check of the file (its size and version), none of its body.
  expect(again.served.bytes).toBeLessThan(64);
});

test('a MatrixMarket folder chosen again on a later visit opens from what the first kept', async ({ page, context, browserName }, testInfo) => {
  await start(page);
  const directory = await corpusFolder('mtx/cellranger3', testInfo.outputPath('cellranger3'));
  await openZarrFolder(page, browserName, directory);
  await expectOpened(page, { name: 'cellranger3', cells: 90 });
  const kept = await keptStores(page);
  expect(kept).toHaveLength(1);
  await closePageWithApplicationRetirement(page);
  const later = await context.newPage();
  await start(later);
  await openZarrFolder(later, browserName, directory);
  await expectOpened(later, { name: 'cellranger3', cells: 90 });
  await expect(later.locator('#dataset-conversion')).toHaveText("Opened from this browser's storage, read whole on an earlier open");
  expect(await keptStores(later)).toEqual(kept);
});

test('an .rds on a host that serves only whole files is said up front, downloaded once, and not downloaded on a later visit', async ({ page, context, browserName }) => {
  const url = `${SAMPLE_ORIGIN}/corpus/whole-only/seurat5_gzip.rds`;
  const bytes = await corpusFile('rds/seurat5_gzip.rds');
  const served = { bodies: 0 };
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  // A host that ignores Range: every GET answers the whole file.
  const wholeOnly = ({ held }) => async route => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length, ETag',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.length),
      ETag: '"whole-1"',
    };
    if (route.request().method() === 'HEAD') return route.fulfill({ status: 200, headers, body: '' });
    // The download (no Range) waits; the link's check of the file (a range it ignores) does not.
    if (held && route.request().headers().range === undefined) await hold;
    served.bodies += bytes.length;
    return route.fulfill({ status: 200, headers, body: bytes });
  };
  await page.route(url, wholeOnly({ held: true }));
  await page.goto(`/?${PINNED}data=${encodeURIComponent(url)}`, { waitUntil: 'domcontentloaded' });
  const note = page.locator('.opening-overlay .opening-note');
  await expect(note).toHaveText(/serves this file only whole \(its host does not serve parts of files\): all 22 KB of it is downloaded once before it opens/);
  await expect(page.locator('.opening-overlay .opening-step')).toHaveText(/^Downloading the whole file \(22 KB\)/);
  release();
  await openCollapsedPanels(page);
  await expectOpened(page, { name: 'Corpus Seurat object', cells: 120 });
  await closePageWithApplicationRetirement(page);

  served.bodies = 0;
  const later = await context.newPage();
  await later.route(url, wholeOnly({ held: false }));
  await later.goto(`/?${PINNED}data=${encodeURIComponent(url)}`, { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(later);
  await expectOpened(later, { name: 'Corpus Seurat object', cells: 120 });
  await expect(later.locator('#dataset-conversion')).toHaveText("Opened from this browser's storage, read whole on an earlier open");
  // The link's check of the file only: its store opens without the file.
  expect(served.bodies).toBeLessThanOrEqual(bytes.length);
});

test('a second tab opens what the first tab kept while the first still has it open', async ({ page, context, browserName }, testInfo) => {
  await start(page);
  const seurat = testInfo.outputPath('seurat5_xz.rds');
  await writeFile(seurat, await corpusFile('rds/seurat5_xz.rds'));
  await chooseFiles(page.locator('#user-data-file-input'), seurat);
  await expectOpened(page, { name: 'Corpus Seurat object', cells: 120 });
  const kept = await keptStores(page);
  const other = await context.newPage();
  await start(other);
  await chooseFiles(other.locator('#user-data-file-input'), seurat);
  await expectOpened(other, { name: 'Corpus Seurat object', cells: 120 });
  await expect(other.locator('#dataset-conversion')).toHaveText("Opened from this browser's storage, read whole on an earlier open");
  expect(await keptStores(other)).toEqual(kept);
  // Clear in the second tab keeps what both have open.
  await expect(other.locator('#kept-stores-clear-btn')).toBeDisabled();
  await closePageWithApplicationRetirement(other);
});
