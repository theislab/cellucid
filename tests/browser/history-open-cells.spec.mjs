/**
 * The cells open are part of the history (the `cells` state domain,
 * `app/state/domains/cells.js`): Cells to open is a step; undo reads the
 * dataset again on the cells shown before, redo on the share again, exactly
 * the same cells (a subsample's specification reproduces them, `strict`).
 * The same dataset read again is not another dataset: its history keeps its
 * tracker and every step (`app/history/dataset-history.js`, `main.js`
 * `keepHistory`), and what the person set up comes back with the cells.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { hiddenOf, historyFacts, takeSteps, waitForHistory } from './helpers/state-history.mjs';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=history-open-cells-ci`;
const CELL_TYPE = Object.freeze({ source: 'obs', key: 'cell_type' });

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

/** The cells open now: how many, and their original positions (null: every cell). */
function openCells(page) {
  return page.evaluate(() => {
    const identity = window._cellucidState.cellIdentity;
    return {
      count: window._cellucidState.pointCount,
      kept: identity.isSubset ? Array.from(identity.toOriginal(Uint32Array.from({ length: identity.n }, (_, i) => i))).sort((a, b) => a - b) : null,
    };
  });
}

/** The `cells` domain's value now. */
function cellsValue(page) {
  return page.evaluate(async () => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    return getStateDomains().owner('cells').capture();
  });
}

test('Cells to open is a step: undo reads the cells shown before again, redo the share, on one tracker', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = observeProductErrors(page);
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  // No section is opened: that is a step of its own (`layout.section.open`),
  // and the steps below are exactly the spec's.
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await waitForHistory(page);
  const tracker = (await historyFacts(page)).tracker;

  // Set up before the share: colored by score, gamma hidden. (The dataset opens colored by
  // cell_type, its first coloring: score is a step.)
  await takeSteps(page, [
    ['color.by', { field: { source: 'obs', key: 'score' } }],
    ['filter.category.visibility', { field: CELL_TYPE, categories: ['gamma'], visible: false }],
  ]);
  expect(await cellsValue(page)).toEqual({ open: null, genes: null });
  const every = await openCells(page);
  expect(every).toEqual({ count: 120, kept: null });

  // A share of the cells: one step, on the same history and tracker.
  const historyBefore = await page.evaluate(() => {
    window.__historyBeforeReread = window._cellucidHistories.current();
    return window.__historyBeforeReread.active.id;
  });
  const [opened] = await takeSteps(page, [['cells.open', { mode: 'subsample', count: 60, method: 'uniform', seed: 1 }]]);
  expect(opened).not.toBeNull();
  const share = await openCells(page);
  expect(share.count).toBe(60);
  expect(share.kept).toHaveLength(60);
  expect(await page.evaluate(() => window._cellucidHistories.current() === window.__historyBeforeReread)).toBe(true);
  const facts = await historyFacts(page);
  expect(facts.tracker).toBe(tracker);
  expect(await page.evaluate(() => window._cellucidHistories.current().active.id)).toBe(historyBefore);
  expect(facts.labels[facts.head]).toBe('Opened 60 cells (uniform)');
  expect(Object.values(facts.labels)).toEqual(['Opened', 'Colored by score', 'Hid gamma of cell_type', 'Opened 60 cells (uniform)']);
  expect(await cellsValue(page)).toEqual({ open: { method: 'uniform', k: 60, seed: 1 }, genes: null });
  // What was set up came with the cells.
  expect(await hiddenOf(page, 'cell_type')).toEqual(['gamma']);
  expect(await page.evaluate(() => window._cellucidState.getActiveField()?.key)).toBe('score');

  // Undo: every cell is read again, and the history is the same one.
  await page.locator('#history-undo-btn').click();
  await expect.poll(async () => (await openCells(page)).count, { timeout: 60_000 }).toBe(120);
  await expect.poll(async () => (await historyFacts(page)).head).not.toBe(opened);
  expect(await openCells(page)).toEqual(every);
  expect(await cellsValue(page)).toEqual({ open: null, genes: null });
  expect(await page.evaluate(() => window._cellucidHistories.current() === window.__historyBeforeReread)).toBe(true);
  expect((await historyFacts(page)).steps).toBe(4);
  expect(await hiddenOf(page, 'cell_type')).toEqual(['gamma']);

  // Redo: exactly the same cells again.
  await page.locator('#history-redo-btn').click();
  await expect.poll(async () => (await openCells(page)).count, { timeout: 60_000 }).toBe(60);
  await expect.poll(async () => (await historyFacts(page)).head).toBe(opened);
  expect(await openCells(page)).toEqual(share);
  expect(await hiddenOf(page, 'cell_type')).toEqual(['gamma']);

  // The opening: every cell, nothing set up; then back to the share in one jump.
  await page.evaluate(() => window._cellucidHistories.current().jump(window._cellucidHistories.current().active.rootId));
  expect(await openCells(page)).toEqual(every);
  expect(await hiddenOf(page, 'cell_type')).toEqual([]);
  expect(await page.evaluate(() => window._cellucidState.getActiveField()?.key)).toBe('cell_type');
  await page.evaluate(id => window._cellucidHistories.current().jump(id), opened);
  expect(await openCells(page)).toEqual(share);
  expect(await hiddenOf(page, 'cell_type')).toEqual(['gamma']);
  expect(await page.evaluate(() => window._cellucidHistories.current() === window.__historyBeforeReread)).toBe(true);
  expect(errors).toEqual([]);
});
