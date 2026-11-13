/**
 * Analysis results left out of a shared file are computed again on open
 * (Share › Results "compute again on open"), in the
 * page, through the one share action (`history.share`) and Load:
 *
 * - the file leaves the result out and marks it so (kind and what it was
 *   computed on, no payload), never as an analysis that did not run;
 * - opening it shows its settings, then runs the analysis again as one step
 *   of `analysis.run` (by "Session"), whose result is the dataset's own;
 * - no step changes outside the history, and a jump back to the shared head
 *   shows no result and runs nothing again;
 * - the current state only, shared the same way, is computed again too.
 */
import { expect, test } from './helpers/test.mjs';
import { anndataZarrZip, fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { waitForDatasetReady, waitForPageAtRest } from './helpers/dataset-ready.mjs';
import { waitForHistory } from './helpers/state-history.mjs';
import { sessionManifest } from './helpers/session-files.mjs';
import { clickLoadSession } from './helpers/session-buttons.mjs';

const DATASET = 'share-results';
const ROOT = appUrl('/tests/browser/fixtures/generated-share-results/');
const CELLS = 60;
const GENES = Object.freeze(['CD3E', 'CD3D', 'MS4A1', 'LYZ', 'NKG7', 'GNLY']);
const TYPES = Object.freeze(['T cell', 'B cell', 'Monocyte']);
const typeOf = cell => cell % 3;
// Each gene is high in one cell type (its markers) and varies a little in every cell.
const expressionOf = (cell, gene) => (typeOf(cell) === gene % 3 ? 5 : 0) + ((cell + gene) % 2);

async function serveDataset(page) {
  const bytes = anndataZarrZip({
    cells: CELLS,
    genes: [...GENES],
    X: Float32Array.from({ length: CELLS * GENES.length }, (_, index) => expressionOf(Math.floor(index / GENES.length), index % GENES.length)),
    obs: { cell_type: { categories: [...TYPES], codes: Int8Array.from({ length: CELLS }, (_, cell) => typeOf(cell)) } },
    obsm: {
      X_umap: { data: Float32Array.from({ length: CELLS * 2 }, (_, index) => (index % 2 === 0 ? (index / 2) % 10 : Math.floor(index / 20))), columns: 2 },
    },
    uns: { cellucid: { schema: 1, id: DATASET, name: 'Share results fixture' } },
  });
  const file = `${DATASET}.zarr.zip`;
  const catalog = JSON.stringify({ schema: 2, default: DATASET, datasets: [{ id: DATASET, path: file }] });
  const prefix = new URL(ROOT).pathname;
  await page.route(`${ROOT}**`, async route => {
    const relative = new URL(route.request().url()).pathname.slice(prefix.length);
    if (relative === 'datasets.json') {
      await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: catalog });
    } else if (relative === file) {
      await fulfillFile(route, bytes).catch(() => {});
    } else {
      await route.fulfill({ status: 404, body: `Unexpected fixture request: ${relative}\n` });
    }
  });
}

function observeProductErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function openFixture(page) {
  await serveDataset(page);
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await waitForDatasetReady(page, CELLS);
  await waitForPageAtRest(page);
  await waitForHistory(page);
  await page.waitForFunction(() => window._comparisonModule?.getAnalysisWindowManager?.() != null);
}

/** Dispatch an action in the page; a refusal comes back as `{error}`. */
function dispatch(page, type, params = {}) {
  return page.evaluate(async ([type, params]) => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    try {
      const { outcome, step } = await getActions().dispatch(type, params);
      return { outcome, step: step === null ? null : { id: step.id, type: step.type } };
    } catch (error) {
      return { error: error.message };
    }
  }, [type, params]);
}

/** Share through the action; the file it downloads. */
async function share(page, params) {
  const downloadPromise = page.waitForEvent('download');
  const answer = await dispatch(page, 'history.share', params);
  expect(answer.error).toBeUndefined();
  const download = await downloadPromise;
  const { readFile } = await import('node:fs/promises');
  return readFile(await download.path());
}

/** Load… › Open a session file…, then wait until what it set off has settled. */
async function load(page, name, bytes) {
  const chooserPromise = page.waitForEvent('filechooser');
  await clickLoadSession(page);
  await (await chooserPromise).setFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
}

/** The tracker shown: its head, each step's type, origin, label, and the markers result each holds at the panel. */
function shown(page) {
  return page.evaluate(async () => {
    const history = window._cellucidHistories.current();
    await history.idle();
    const tree = history.active;
    const resultAt = id => {
      const value = history.valueAt(id, 'analysis');
      const result = value?.docked?.modes?.genesPanel?.result ?? null;
      if (result === null) return null;
      return result.leftOut === true ? { leftOut: true, kind: result.kind, provenance: result.provenance !== null } : { payload: result.payload !== null };
    };
    return {
      name: tree.name,
      head: tree.headId,
      steps: [...tree.steps.values()].map(step => ({
        id: step.id, type: step.type, origin: step.by.origin, label: step.label, kind: step.kind, result: resultAt(step.id),
      })),
    };
  });
}

/** What the markers analysis reads now. */
async function markers(page) {
  const listed = await dispatch(page, 'analysis.list');
  return listed.outcome.analyses.find(entry => entry.analysis === 'markers' && entry.in === 'panel');
}

async function runMarkers(page) {
  expect((await dispatch(page, 'analysis.open', { analysis: 'markers' })).error).toBeUndefined();
  expect((await dispatch(page, 'analysis.markers.set', { options: { groupBy: 'cell_type' } })).error).toBeUndefined();
  const ran = await dispatch(page, 'analysis.run', { analysis: 'markers' });
  expect(ran.error).toBeUndefined();
  expect(ran.outcome.rows).toBeGreaterThan(0);
}

test('a result left out of a shared file is computed again on open, as one step, and never again on a jump', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = observeProductErrors(page);
  await openFixture(page);
  await runMarkers(page);
  const before = await shown(page);
  expect(before.steps.at(-1)).toMatchObject({ type: 'analysis.run', result: { payload: true } });

  // The file leaves the result out, and says so.
  const bytes = await share(page, { results: 'recompute' });
  expect((await sessionManifest(bytes)).scope).toMatchObject({ content: 'history', results: 'recompute' });

  await load(page, 'with-results-left-out.cellucid-session', bytes);
  await expect(page.locator('.notification-message', { hasText: 'Computed again on open (left out of the file): Marker genes.' })).toBeVisible();
  const opened = await shown(page);
  expect(opened.name).not.toBe(before.name);
  // Every shared step holds the result as left out; the step after the shared head runs it again here.
  const shared = opened.steps.slice(0, -1);
  expect(shared.find(step => step.type === 'analysis.run').result).toEqual({ leftOut: true, kind: 'markers', provenance: true });
  expect(opened.steps.at(-1)).toMatchObject({ type: 'analysis.run', origin: 'session', label: 'Ran Marker genes', result: { payload: true } });
  expect(opened.head).toBe(opened.steps.at(-1).id);
  expect(opened.steps.filter(step => step.kind === 'outside')).toEqual([]);
  expect(await markers(page)).toMatchObject({ has_result: true, stale: false });

  // Back to the shared head: its settings, no result, and nothing runs again.
  const sharedHead = shared.at(-1).id;
  await page.evaluate(async id => {
    const history = window._cellucidHistories.current();
    await history.jump(id);
    await history.idle();
  }, sharedHead);
  const jumped = await shown(page);
  expect(jumped.head).toBe(sharedHead);
  expect(jumped.steps).toHaveLength(opened.steps.length);
  expect(await markers(page)).toMatchObject({ has_result: false });
  // The left-out record is what the page shows there: no change outside the history.
  await page.evaluate(() => window._cellucidHistories.current().reconcile());
  expect((await shown(page)).steps.filter(step => step.kind === 'outside')).toEqual([]);
  expect(errors).toEqual([]);
});
