/**
 * Picking the file that is already open opens it again.
 *
 * A file picked with File… is a new opening whatever is on screen: the
 * dataset it holds may state the id of the one that is open (the same file,
 * or a newer copy of it), and is still read and shown afresh, its view
 * starting as the file says. The dataset select's "already open" shortcut
 * is for choosing a listed dataset again, never for a file the person just
 * handed over. A `.rds` opened again in the tab reads the store kept the
 * first time, so the second opening converts nothing.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { expectNoFailureAnnounced, observePage, readRecord } from './helpers/dataset-loading.mjs';
import { createByteReader } from '../../assets/js/formats/io/byte-reader.js';
import { bytesByteSource } from '../../assets/js/formats/io/byte-source.js';
import { openZipArchive } from '../../assets/js/formats/zip/index.js';
import { chooseFiles } from './helpers/file-input.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const H5AD = path.join(FIXTURES, 'current-ui-smoke.h5ad');
const CORPUS = path.join(FIXTURES, '..', '..', 'fixtures', 'rds', 'corpus.zip');

async function corpusFile(name) {
  const archive = await openZipArchive(createByteReader(
    bytesByteSource(new Uint8Array(await readFile(CORPUS)), { name: 'corpus.zip' }),
  ));
  return Buffer.from((await archive.entry(name).read()).slice());
}

async function start(page) {
  const errors = await observePage(page);
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready');
  return errors;
}

/**
 * The directories this origin keeps converted stores in, or null where the
 * engine gives the page no origin-private file system (the store is then
 * kept in memory).
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
    return names.sort();
  });
}

/** How many distinct notifications said the file is ready. */
async function readyAnnouncements(page, cells) {
  const { notifications } = await readRecord(page);
  return new Set(
    notifications
      .filter(entry => entry.type === 'success' && entry.text.includes(`User data ready: ${cells} cells`))
      .map(entry => entry.id),
  ).size;
}

/**
 * Pick `file` twice. Between the picks the open dataset is given a
 * highlight; the second opening starts the dataset afresh, so it is gone.
 */
async function pickTwice(page, file, { name, cells, afterFirst = async () => {} }) {
  const input = page.locator('#user-data-file-input');
  await chooseFiles(input, file);
  await expect(page.locator('#dataset-name')).toHaveText(name);
  await expect(page.locator('#dataset-cells')).toHaveText(String(cells));
  await expect.poll(() => readyAnnouncements(page, cells)).toBe(1);
  await page.evaluate(() => {
    const highlight = new Uint8Array(window._cellucidState.pointCount);
    highlight[0] = 255;
    window._cellucidViewer.updateHighlight(highlight);
  });
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getHighlightedCount())).toBe(1);
  await afterFirst();

  await chooseFiles(input, file);
  await expect.poll(() => readyAnnouncements(page, cells)).toBe(2);
  await expect(page.locator('#dataset-name')).toHaveText(name);
  await expect(page.locator('#dataset-cells')).toHaveText(String(cells));
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getPointCount())).toBe(cells);
  expect(await page.evaluate(() => window._cellucidViewer.getHighlightedCount())).toBe(0);
  await expectNoFailureAnnounced(page);
}

test('the .h5ad that is open, picked again, opens again', async ({ page }) => {
  const errors = await start(page);
  await pickTwice(page, H5AD, { name: 'current-ui-smoke', cells: 120 });
  expect(errors).toEqual([]);
});

test('the .rds that is open, picked again, opens again from what the tab kept', async ({ page }, testInfo) => {
  const errors = await start(page);
  const file = testInfo.outputPath('seurat5_gzip.rds');
  await writeFile(file, await corpusFile('rds/seurat5_gzip.rds'));
  let kept = null;
  await pickTwice(page, file, {
    name: 'Corpus Seurat object',
    cells: 120,
    afterFirst: async () => { kept = await keptStores(page); },
  });
  // The second opening read the store the first one kept, and kept no other.
  if (kept !== null) {
    expect(kept).toHaveLength(1);
    expect(await keptStores(page)).toEqual(kept);
  }
  expect(errors).toEqual([]);
});
