/**
 * A MatrixMarket folder whose matrix is larger than its lists and tables
 * opens map first (`data/anndata/transcode/matrix-market.js`): the cells
 * are drawn from the lists and the cell table, the matrix is read after
 * them in the reader worker keeping the share genes are read for, the
 * reader is swapped onto the store that makes, and the page reads its genes
 * (`app/matrix-share-notices.js`). A later visit opens both parts from what
 * this browser kept, reading nothing of the folder.
 *
 * Where showing a cell is measured slow (a device whose GPU draws a first
 * frame slowly), the folder opens progressively: a first view, then steps
 * to every cell. Its matrix is
 * still read in one pass, for the cells the opening grows to, and one share
 * is kept (`AnnDataReader.shareRows`, `MatrixStream.ensure`); a pass a step
 * read the whole matrix again each step and kept a share each.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { closePageWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { openZarrFolder } from './helpers/dataset-drop.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { keptStoreDirectories, workersKeepFiles } from './helpers/origin-storage.mjs';

test.use({ persistentStorage: true });

const CELLS = 3000;
/** How the Dataset box writes that count (`display-format.js` `formatCompactCount`). */
const CELLS_SHOWN = '3K';
const GENES = 40;
const GENE = 3;

/** A Cell Ranger-like folder: a cell-sorted matrix larger than its lists and its UMAP table, and gene `GENE`'s sum and non-zero count. */
async function writeFolder(directory) {
  let state = 11;
  const next = () => ((state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 4294967296);
  const lines = [];
  let sum = 0;
  let nonzero = 0;
  for (let cell = 0; cell < CELLS; cell++) {
    const genes = new Set();
    while (genes.size < 10) genes.add(Math.floor(next() * GENES));
    for (const gene of [...genes].sort((a, b) => a - b)) {
      const value = 1 + Math.floor(next() * 9);
      lines.push(`${gene + 1} ${cell + 1} ${value}`);
      if (gene === GENE) {
        sum += value;
        nonzero++;
      }
    }
  }
  const barcodes = Array.from({ length: CELLS }, (_, i) => `CELL${i}-1`);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'matrix.mtx'), ['%%MatrixMarket matrix coordinate integer general', `${GENES} ${CELLS} ${lines.length}`, ...lines].join('\n') + '\n');
  await writeFile(path.join(directory, 'features.tsv'), Array.from({ length: GENES }, (_, g) => `ENSG${g}\tg${g}\tGene Expression`).join('\n') + '\n');
  await writeFile(path.join(directory, 'barcodes.tsv'), barcodes.join('\n') + '\n');
  await writeFile(path.join(directory, 'cells.csv'), ['barcode,UMAP_1,UMAP_2', ...barcodes.map((cell, i) => `${cell},${i % 31},${(i * 7) % 29}`)].join('\n') + '\n');
  return { sum, nonzero };
}

async function start(page) {
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready');
}

async function chooseGene(page, name) {
  const search = page.locator('#gene-expression-search');
  await search.click();
  await search.fill(name);
  await search.press('Enter');
  await expect.poll(() => page.evaluate(gene => {
    const state = window._cellucidState;
    const field = state.varData?.fields?.[state.activeVarFieldIndex];
    return state.activeFieldSource === 'var' && field?.key === gene && field.loaded === true;
  }, name), { timeout: 60_000 }).toBe(true);
}

/** The gene shown: its values' sum and non-zero count over every cell, and how many have none (not read). */
function shownGene(page) {
  return page.evaluate(() => {
    const state = window._cellucidState;
    const values = state.varData.fields[state.activeVarFieldIndex].values;
    let sum = 0;
    let nonzero = 0;
    let notRead = 0;
    for (const value of values) {
      if (Number.isNaN(value)) notRead++;
      else if (value !== 0) {
        sum += value;
        nonzero++;
      }
    }
    return { sum, nonzero, notRead };
  });
}

/**
 * Record, from now on, every read operation the app's read activity log
 * tells of: the matrix passes among them (`matrix.mtx: genes of N cells`).
 */
async function recordReadActivities(page) {
  await page.evaluate(async () => {
    const { getReadActivityLog } = await import('/assets/js/data/read-activity-log.js');
    window.__readActivities = new Map();
    getReadActivityLog().subscribe(activity => window.__readActivities.set(activity.id, activity));
  });
}

/** The passes over the matrix the page was told of. */
function matrixPasses(page) {
  return page.evaluate(async () => {
    const { getReadActivityLog } = await import('/assets/js/data/read-activity-log.js');
    getReadActivityLog().flush();
    return [...window.__readActivities.values()].map(({ label }) => label).filter(label => /^matrix\.mtx: genes of /.test(label));
  });
}

/** Every count of open cells the state takes, as it takes it (a progressive opening's first view and steps). */
async function noteOpenCounts(page) {
  await page.addInitScript(() => {
    window.__counts = [];
    const note = count => {
      if (count > 0 && window.__counts.at(-1) !== count) window.__counts.push(count);
    };
    let shownState;
    Object.defineProperty(window, '_cellucidState', {
      configurable: true,
      get: () => shownState,
      set(state) {
        shownState = state;
        let count = state.pointCount;
        note(count);
        Object.defineProperty(state, 'pointCount', {
          configurable: true,
          enumerable: true,
          get: () => count,
          set(value) {
            count = value;
            note(value);
          },
        });
      },
    });
  });
}

for (const opening of ['at once', 'progressively']) test.describe(`opened ${opening}`, () => {
  // What showing a cell costs this page (`data/opening-cost.js`), held by
  // the fixture's device: 2 ms a cell, so 3,000 cells take 6 s, a first
  // view of the cells shown within a second opens, then steps to every
  // cell; or nothing measured, so every cell opens at once (as on a fast
  // GPU). The page's own records leave it as it is: measured, the start
  // sample's record landed at its first frame, after startup was ready on a
  // slow runner, and made the "at once" opening progressive (Web contracts
  // run 41307458156, Linux Firefox).
  test.use({ device: { openingMsPerCell: opening === 'progressively' ? 2 : null } });

  test(`a MatrixMarket folder larger than its tables draws its cells first (${opening}), then its genes arrive in one pass; a later visit reads nothing of it`, async ({ page, context, browserName }, testInfo) => {
    const errors = [];
    page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
    page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
    await noteOpenCounts(page);
    await start(page);
    await page.evaluate(() => {
      window.__counts = [];
    });
    await recordReadActivities(page);
    const keeps = await workersKeepFiles(page);
    const directory = testInfo.outputPath('stream');
    const expected = await writeFolder(directory);
    await openZarrFolder(page, browserName, directory);
    await expect(page.locator('#dataset-cells')).toHaveText(CELLS_SHOWN);
    await expect.poll(() => page.evaluate(() => window._cellucidViewer.getPointCount()), { timeout: 60_000 }).toBe(CELLS);
    const counts = await page.evaluate(() => window.__counts);
    if (opening === 'progressively') expect(counts[0], `open counts ${counts.join(' → ')}`).toBeLessThan(CELLS);
    else expect(counts).toEqual([CELLS]);
    // The share arrives (every cell fits this device): genes are read for every open cell.
    await expect.poll(() => page.evaluate(() => window._cellucidState.getGeneSample()), { timeout: 60_000 }).toBeNull();
    await chooseGene(page, `g${GENE}`);
    await expect.poll(() => shownGene(page)).toEqual({ ...expected, notRead: 0 });
    // One pass over the matrix, for every cell, however the cells opened.
    expect(await matrixPasses(page)).toEqual([`matrix.mtx: genes of ${CELLS.toLocaleString('en-US')} cells`]);
    // The map and the matrix share, each kept once.
    const kept = await keptStoreDirectories(page);
    if (keeps) expect(kept).toHaveLength(2);
    expect(errors).toEqual([]);

    await closePageWithApplicationRetirement(page);
    const later = await context.newPage();
    const laterErrors = [];
    later.on('pageerror', error => laterErrors.push(`page: ${error.stack || error.message}`));
    await start(later);
    await openZarrFolder(later, browserName, directory);
    await expect(later.locator('#dataset-cells')).toHaveText(CELLS_SHOWN);
    if (keeps) {
      // Opened from what was kept: genes at once, nothing new kept.
      expect(await later.evaluate(() => window._cellucidState.getGeneSample())).toBeNull();
      expect(await keptStoreDirectories(later)).toEqual(kept);
    }
    await chooseGene(later, `g${GENE}`);
    await expect.poll(() => shownGene(later)).toEqual({ ...expected, notRead: 0 });
    expect(laterErrors).toEqual([]);
  });
});
