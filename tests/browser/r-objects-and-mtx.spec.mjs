/**
 * Single-stream formats in the browser (`data/anndata/transcode/`): a
 * Seurat `.rds` picked with File…, a SingleCellExperiment `.rds` dropped, a
 * Seurat `.rds` opened from a link (one pass over the download), a `save()`
 * file of two objects (the opening asks which), and a MatrixMarket folder
 * chosen with Folder…. Each is read once into this browser's storage (the
 * origin-private file system), opens with its cells drawn, and opened again
 * in the same tab reads what was kept; the Dataset box says where it is kept
 * and lists every part that was not read. The fixtures are the R and
 * MatrixMarket corpora (`tests/fixtures/rds/corpus.zip`).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from './helpers/test.mjs';
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
 * engine gives this page no origin-private file system (Playwright's WebKit:
 * the store is then kept in memory).
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

test('a Seurat .rds picked with File… opens, kept in this browser for the tab', async ({ page }, testInfo) => {
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
  // Playwright's WebKit gives the page no origin-private file system: there
  // the store is kept in memory, and the box says so.
  const inStorage = (await keptStores(page)) !== null;
  await expect(line).toHaveText(`${inStorage
    ? "Read once into this browser's storage for this tab"
    : 'Read once into memory for this tab'} · 5 parts not read`);
  await expect(page.locator('#dataset-origin')).toHaveText('R data (.rda, .RData) · this computer');
  await page.locator('#dataset-details .disclosure-header').click();
  await expect(kept).toHaveText(inStorage
    ? "In this browser's storage (the origin-private file system) until this tab closes"
    : 'In memory until this tab closes: this browser gives this page no storage (as in a private window)');
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
    ? "Read once into this browser's storage for this tab"
    : 'Read once into memory for this tab');
  await page.locator('#dataset-details .disclosure-header').click();
  await expect(kept).toBeVisible();
  await expect(notRead).toHaveCount(0);

  // Opened again in the tab: from what was kept, with the same notes.
  await chooseFiles(page.locator('#user-data-file-input'), pbmc);
  await expect(page.locator('#dataset-cells')).toHaveText('80');
  await expect(line).toHaveText(`${inStorage
    ? "Opened from this browser's storage, read earlier in this tab"
    : 'Read once into memory for this tab'} · 5 parts not read`);

  // An AnnData file is read in place: no such line.
  await chooseFiles(page.locator('#user-data-file-input'), path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'catalog', 'current-ui.h5ad'));
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await expect(line).toBeHidden();
  expect(errors).toEqual([]);
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
    ? "Read once into this browser's storage for this tab"
    : 'Read once into memory for this tab');
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
