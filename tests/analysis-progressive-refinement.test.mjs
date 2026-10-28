/**
 * Progressive analysis (`shared/progressive-cells.js`): a run answers first on
 * a uniform random sample of the open cells (the first cells of their
 * priority order, `data/cell-priority.js`), then on every open cell.
 *
 * - The final result is bit for bit what a single run on every cell gives:
 *   the first pass runs on derived "sample" pages, so it shares no cache entry
 *   with the full pass, and a page's sample is its cells in the priority
 *   prefix.
 * - The first pass is taken only when the measured cost says it pays.
 * - A form analysis draws the first pass, says which cells it used, refines
 *   in place, keeps the first pass (saying so) when the refinement is
 *   cancelled, and skips a first pass the sample cannot carry.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AnalysisCostModel,
  FIRST_ANSWER_TARGET_MS,
  createCellSample,
  describeCellsUsed,
  firstPassSize,
  getAnalysisCostModel,
  runProgressively,
} from '../assets/js/app/analysis/shared/progressive-cells.js';
import { DataLayer } from '../assets/js/app/analysis/data/data-layer.js';
import { computeStats } from '../assets/js/app/analysis/shared/number-utils.js';
import { runStatisticalTests } from '../assets/js/app/analysis/stats/statistical-tests.js';
import { histogramSamples } from '../assets/js/app/analysis/plots/plotly-histogram-bins.js';
import { createSamplePageId, isDerivedPageId, parseSamplePageId } from '../assets/js/app/analysis/shared/page-derivation-utils.js';
import { DEFAULT_CELL_PRIORITY, OPEN_ORDER_PRIORITY, buildPriorityOrder, priorityPrefix } from '../assets/js/data/cell-priority.js';
import { FormBasedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/base/form-based-analysis.js';
import { defineOptions } from '../assets/js/app/analysis/options/option-schema.js';

globalThis.HTMLElement ??= class HTMLElement {};

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function page(id, cellIndices) {
  return {
    id,
    name: `Page ${id}`,
    highlightedGroups: [{ id: `${id}-g`, type: 'lasso', label: id, enabled: true, cellIndices, cellCount: cellIndices.length }],
  };
}

/** A data layer over `n` cells: a continuous field and two pages. */
function makeLayer(n, priority, seed = 5) {
  const random = lcg(seed);
  const values = Float32Array.from({ length: n }, (_, i) => (random() < 0.03 ? NaN : Math.fround((i % 3) + random() * 4)));
  const a = [];
  const b = [];
  for (let i = 0; i < n; i++) {
    const r = random();
    if (r < 0.45) a.push(i);
    else if (r < 0.8) b.push(i);
  }
  const colors = { a: '#112233', b: '#445566' };
  const state = {
    pointCount: n,
    cellPriority: priority,
    getHighlightPages: () => [page('a', a), page('b', b)],
    getHighlightPageColor: id => colors[id] ?? null,
    obsData: { fields: [{ key: 'score', kind: 'continuous', loaded: true, values }] },
    varData: { fields: [] },
    ensureFieldLoaded: async () => {},
    ensureVarFieldLoaded: async () => {},
  };
  const layer = new DataLayer(state, { enableNotifications: false, enablePrefetch: false, enableVersionTracking: true });
  return { layer, values, pages: { a, b } };
}

/** The summary a detailed analysis draws: per-page statistics, tests and histogram bins. */
async function summarise(layer, pageIds) {
  const data = await layer.getDataForPages({ type: 'continuous_obs', variableKey: 'score', pageIds });
  return {
    cells: data.map(pd => Array.from(pd.cellIndices)),
    stats: data.map(pd => computeStats(pd.values)),
    tests: runStatisticalTests(data.map(pd => ({ pageName: pd.pageName, values: pd.values })), 'continuous_obs'),
    histogram: histogramSamples(data.map(pd => pd.values), 30),
  };
}

test('the first pass is taken when it answers at least twice as soon, and sized to the target', () => {
  // Nothing measured: one run (a first pass of unknown cost could read every gene twice).
  assert.equal(firstPassSize(null, 1_000_000), null);
  assert.equal(firstPassSize(null, 1), null);
  // Fast enough in one run: no first pass.
  assert.equal(firstPassSize({ fixedMs: 10, perCellMs: 1e-4 }, 1_000_000), null);
  // Per-cell work dominates: as many cells as the target allows.
  const perCellMs = 1e-3;
  const m = firstPassSize({ fixedMs: 100, perCellMs }, 10_000_000);
  assert.equal(m, Math.floor((FIRST_ANSWER_TARGET_MS - 100) / perCellMs));
  // The fixed part dominates (genes read whatever the cells): one run.
  assert.equal(firstPassSize({ fixedMs: 30_000, perCellMs: 1e-5 }, 10_000_000), null);
  // A fixed part above the target still leaves a sqrt(n) first pass when cells dominate.
  assert.equal(firstPassSize({ fixedMs: 2_000, perCellMs: 1e-3 }, 10_000_000), Math.ceil(Math.sqrt(10_000_000)));
});

test('the cost model fits its last two passes and survives broken storage', () => {
  const stored = new Map();
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  const model = new AnalysisCostModel({ storage });
  assert.equal(model.cost('DE'), null);
  model.record('DE', 1_000, 150);
  assert.deepEqual(model.cost('DE'), { fixedMs: 0, perCellMs: 0.15 });
  model.record('DE', 101_000, 1_150);
  const cost = model.cost('DE');
  assert.ok(Math.abs(cost.perCellMs - 0.01) < 1e-12);
  assert.ok(Math.abs(cost.fixedMs - 140) < 1e-9);
  // Kept across visits.
  assert.deepEqual(new AnalysisCostModel({ storage }).cost('DE'), cost);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); } };
  const fragile = new AnalysisCostModel({ storage: broken });
  fragile.record('DE', 10, 1);
  assert.deepEqual(fragile.cost('DE'), { fixedMs: 0, perCellMs: 0.1 });
});

for (const [label, priority] of [['ranked', DEFAULT_CELL_PRIORITY], ['open order', OPEN_ORDER_PRIORITY]]) {
  test(`${label}: a sample page is its page's cells in the priority prefix`, async () => {
    const n = 30_000;
    const { layer, pages } = makeLayer(n, priority);
    const m = 3_000;
    const sample = createCellSample(layer, n, m);
    const id = sample.pageId('a');
    assert.equal(id, createSamplePageId('a', m));
    assert.deepEqual(parseSamplePageId(id), { baseId: 'a', m });
    assert.ok(isDerivedPageId(id));
    const prefix = priorityPrefix(priority, n, m);
    const expected = pages.a.filter(cell => prefix.has(cell));
    assert.deepEqual(Array.from(layer.getCellIndicesForPage(id)), expected);
    assert.equal(layer.getCellCountForPageId(id), expected.length);
    // ... which are the page's cells among the first cells of the order.
    const order = buildPriorityOrder(n, priority);
    const firstCells = new Set(order.subarray(0, prefix.filter(Uint32Array.from({ length: n }, (_, i) => i)).length));
    assert.ok(expected.every(cell => firstCells.has(cell)));
    assert.equal(layer.getPageInfo(id).name, 'Page a');
    assert.deepEqual(layer.getPageInfo(id).derived, { kind: 'sample', baseId: 'a', m });
    assert.equal(layer.getPageColor(id), '#112233');
    // A rest-of page has a sample too.
    const restId = sample.pageId('restof__a');
    assert.equal(sample.basePageId(restId), 'restof__a');
    assert.ok(layer.getCellIndicesForPage(restId).every(cell => prefix.has(cell)));
    // The masks a field-grouped analysis narrows its scope with.
    const scope = new Uint8Array(n);
    for (const cell of pages.b) scope[cell] = 1;
    const masked = sample.mask(scope);
    for (let cell = 0; cell < n; cell++) assert.equal(masked[cell], scope[cell] === 1 && prefix.has(cell) ? 1 : 0);
    assert.equal(sample.mask(null).reduce((sum, bit) => sum + bit, 0), prefix.filter(Uint32Array.from({ length: n }, (_, i) => i)).length);
  });

  test(`${label}: the refined summary is bit for bit a direct run on every cell`, async () => {
    const n = 40_000;
    const direct = await summarise(makeLayer(n, priority).layer, ['a', 'b']);
    const { layer } = makeLayer(n, priority);
    const model = new AnalysisCostModel({ storage: null });
    // Measured: a slow run, nearly all of it per cell.
    model.record('summary', n, 2_000);
    const firsts = [];
    const result = await runProgressively({
      kind: 'summary',
      dataLayer: layer,
      isCurrent: () => true,
      model,
      pass: sample => summarise(layer, sample === null ? ['a', 'b'] : sample.pageIds(['a', 'b'])),
      onFirstPass: async (first, sample) => { firsts.push({ first, sample }); },
    });
    assert.equal(firsts.length, 1, 'a run measured slow takes a first pass');
    const { first, sample } = firsts[0];
    assert.equal(sample.m, Math.floor(FIRST_ANSWER_TARGET_MS / (2_000 / n)));
    assert.ok(first.cells[0].length < direct.cells[0].length);
    assert.deepStrictEqual(result, direct);
    // The cache now holds both; a direct read of every cell is still the direct one.
    assert.deepStrictEqual(await summarise(layer, ['a', 'b']), direct);
    assert.ok(model.cost('summary') !== null);
  });
}

test('a first pass the sample cannot carry is skipped; a cancel stops both passes', async () => {
  const n = 10_000;
  const { layer } = makeLayer(n, DEFAULT_CELL_PRIORITY);
  const model = new AnalysisCostModel({ storage: null });
  model.record('strict', n, 5_000);
  let calls = 0;
  const result = await runProgressively({
    kind: 'strict', dataLayer: layer, isCurrent: () => true, model,
    pass: async sample => {
      calls += 1;
      if (sample !== null) throw new Error('Each group needs at least 2 cells');
      return 'all';
    },
    onFirstPass: async () => assert.fail('nothing to draw'),
  });
  assert.equal(result, 'all');
  assert.equal(calls, 2);
  const controller = new AbortController();
  controller.abort(new Error('Cancelled'));
  await assert.rejects(runProgressively({
    kind: 'strict', dataLayer: layer, isCurrent: () => true, model,
    job: { signal: controller.signal },
    pass: async () => { throw controller.signal.reason; },
    onFirstPass: async () => {},
  }), /Cancelled/);
});

const SCHEMA = defineOptions({
  id: 'progressive',
  groups: [],
  options: [
    { key: 'size', kind: 'number', label: 'Size', tip: 'analysis-signature', group: 'essentials', default: 1 },
  ],
});

class ProgressiveHarness extends FormBasedAnalysisUI {
  static getRequirements() {
    return { minPages: 0 };
  }

  _getTitle() {
    return this.title;
  }

  _getOptionsSchema() {
    return SCHEMA;
  }

  _takesCellSample() {
    return true;
  }

  async _showResult(result) {
    this.renders.push(result.data.cells);
  }
}

function createHarness(title, n, runImpl) {
  const { layer } = makeLayer(n, DEFAULT_CELL_PRIORITY);
  const ui = new ProgressiveHarness({ comparisonModule: {}, dataLayer: layer });
  ui.title = title;
  ui.renders = [];
  ui.used = [];
  ui._notifications = { loading: () => 'p', complete() {}, fail() {}, dismiss() {}, error() {} };
  const button = { disabled: false, textContent: 'Run', dataset: {}, removeAttribute() {}, setAttribute() {} };
  ui._runRow = { button, reason: { hidden: true, textContent: '' } };
  ui._cellsUsedLine = { root: { hidden: true, dataset: {} }, set: text => ui.used.push(text) };
  ui._runAnalysisImpl = runImpl;
  return ui;
}

test('a form analysis draws its first pass, says so, and refines in place to every cell', async () => {
  const n = 1_000_000;
  // Measured: about 2 s on every cell, nearly all of it per cell.
  getAnalysisCostModel().record('Refines in place', n, 2_000);
  const passes = [];
  const ui = createHarness('Refines in place', n, async (_options, _requestId, _job, sample) => {
    passes.push(sample);
    return { data: { cells: sample === null ? n : sample.m } };
  });
  await ui._runAnalysis();
  assert.equal(passes.length, 2);
  const m = Math.floor(FIRST_ANSWER_TARGET_MS / (2_000 / n));
  assert.equal(passes[0].m, m);
  assert.equal(passes[1], null);
  assert.deepEqual(ui.renders, [m, n]);
  assert.equal(ui.getLastResult().data.cells, n);
  assert.equal(ui.used[0], describeCellsUsed({ m, n }, n, 'refining'));
  assert.equal(ui.used.at(-1), describeCellsUsed(null, n));
  assert.match(ui.used[0], /uniform sample of 50\.0% of the open cells \(about 500,000 of 1,000,000\) · refining/);
  assert.equal(ui._cellsUsedLine.root.dataset.cellsUsed, 'all');
});

test('a refinement that is cancelled leaves the first pass on screen, saying it is one', async () => {
  const n = 1_000_000;
  getAnalysisCostModel().record('Cancelled refinement', n, 2_000);
  const ui = createHarness('Cancelled refinement', n, async (_options, _requestId, job, sample) => {
    if (sample === null) {
      job.cancel();
      throw job.signal.reason ?? new Error('Cancelled');
    }
    return { data: { cells: sample.m } };
  });
  await ui._runAnalysis();
  assert.equal(ui.renders.length, 1);
  assert.match(ui.used.at(-1), /Stopped before every cell/);
  assert.equal(ui._cellsUsedLine.root.dataset.cellsUsed, 'sample');
});
