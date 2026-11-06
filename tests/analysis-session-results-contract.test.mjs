/**
 * Analysis panel state and results in a session.
 *
 * The docked panel saves which mode row is open and, for every mode it has
 * created, its settings and its shown result. Results are JSON values plus
 * typed numeric arrays, stored as every history value is
 * (`app/history/value-parts.js`), name genes, fields and categories by key,
 * and come back deep-equal to the live result through the same render path a
 * fresh run takes. A result that names something the open dataset lacks is
 * refused.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeAnalysisResult,
  encodeAnalysisResult,
} from '../assets/js/app/analysis/shared/analysis-result-codec.js';
import { ANALYSIS_RESULT_VERSION } from '../assets/js/app/analysis/shared/analysis-result-session.js';
import { ComparisonModule } from '../assets/js/app/analysis/comparison-module.js';
import { CorrelationAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/correlation-analysis-ui.js';
import { DEAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/de-analysis-ui.js';
import { DetailedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/detailed-analysis-ui.js';
import { GeneSignatureUI } from '../assets/js/app/analysis/ui/analysis-types/gene-signature-ui.js';
import { GenesPanelUI } from '../assets/js/app/analysis/ui/analysis-types/genes-panel-ui.js';
import { AnalysisWindowManager } from '../assets/js/app/analysis/ui/analysis-window-manager.js';
import { hashValue } from '../assets/js/app/history/value-pool.js';
import { joinValue, parseArrayDigest, splitValue } from '../assets/js/app/history/value-parts.js';

// No result container is mounted: staleness has nothing to dim.
globalThis.HTMLElement ??= class HTMLElement {};

const GENES = ['CD3E', 'MS4A1', '__proto__', 'NKG7', 'LYZ', 'GNLY'];
const CATEGORIES = ['T cell', 'B cell', 'NK cell', 'Monocyte'];
const PAGES = new Map([['page-a', 5], ['page-b', 3]]);

function createDataLayer({ genes = GENES, categories = CATEGORIES, pages = PAGES } = {}) {
  const geneSet = new Set(genes);
  return {
    getVariableInfo(type, key) {
      if (type === 'gene_expression') return geneSet.has(key) ? { key } : null;
      if (type === 'categorical_obs') return key === 'cell_type' ? { key, categories } : null;
      if (type === 'continuous_obs') return key === 'age' ? { key } : null;
      return null;
    },
    getPageInfo(pageId) {
      return pages.has(pageId) ? { id: pageId, name: pageId.toUpperCase() } : null;
    },
    getCellCountForPageId(pageId) {
      return pages.get(pageId) ?? 0;
    },
    // Each page's open cells, the pages one after another.
    getPageCells(pageIds) {
      const starts = new Map();
      let at = 0;
      for (const [id, count] of pages) {
        starts.set(id, at);
        at += count;
      }
      return pageIds.map(id => ({ pageId: id, pageName: id.toUpperCase(), cellIndices: Uint32Array.from({ length: pages.get(id) ?? 0 }, (_, k) => starts.get(id) + k) }));
    },
    getPages() {
      return [...pages.keys()].map(id => ({ id, name: id.toUpperCase() }));
    },
    getExpressionMatrices: () => ({ choices: [{ value: 'mapped', label: 'Mapped (X)' }], reason: null }),
    resolveExpressionMatrix: () => ({ matrix: 'X', read: null, label: 'Mapped (X)' }),
    // Genes are read for every open cell (no gene sample).
    geneCellsOf: async () => null,
    async getGeneKeys() { return this.getAvailableVariables('gene_expression').map(gene => gene.key); },
    getAvailableVariables(type) {
      if (type === 'gene_expression') return genes.map(key => ({ key }));
      if (type === 'categorical_obs') return [{ key: 'cell_type', categories, categoryCount: categories.length }];
      return [];
    },
    async ensureObsFieldLoaded() {},
  };
}

/** A UI whose render path is recorded instead of drawn. */
/**
 * Show `result` in `ui` as a run leaves it: the result and what it was
 * computed on (`shared/result-provenance.js`), the page as it is now.
 */
async function shown(ui, result) {
  ui._lastResult = result;
  const genes = ui._resultGeneSample(result);
  ui._resultInputs = {
    options: structuredClone(ui._requireOptions()),
    provenance: await ui._currentProvenance(ui._requireOptions(), [...ui._selectedPages], genes === null ? null : { cells: genes.cells, of: genes.of }),
  };
}

function createUI(UI, dataLayer = createDataLayer()) {
  const ui = new UI({ comparisonModule: {}, dataLayer, multiVariableAnalysis: {} });
  ui.shown = [];
  ui._showResult = async result => {
    ui.shown.push(result);
  };
  return ui;
}

/**
 * The session's own storage step (`app/history/value-parts.js`, as the
 * session file and the autosave keep a history value): the value's skeleton
 * as JSON text, each typed array as its bytes, joined again and checked
 * against the hash the history keeps the value by.
 */
async function throughSession(value) {
  const hash = await hashValue(value);
  const arrays = new Map();
  const text = JSON.stringify(await splitValue(value, arrays));
  const restored = joinValue(JSON.parse(text), digest => {
    const { type } = parseArrayDigest(digest);
    const array = arrays.get(digest);
    return new type(new Uint8Array(array.buffer, array.byteOffset, array.byteLength).slice().buffer);
  });
  assert.equal(await hashValue(restored), hash, 'what is read back is the value saved');
  return restored;
}

/** What a DE run returns (`MultiVariableAnalysis.differentialExpression`). */
function deFull() {
  return {
    results: [
      { gene: 'CD3E', meanA: 2.5, meanB: 0.25, pctA: 80, pctB: 10, log2FoldChange: 3.1, pValue: 1e-12, statistic: 9.5, score: 7.2, auroc: 0.95, nA: 5, nB: 3, method: 'wilcox', adjustedPValue: 6e-12 },
      { gene: '__proto__', meanA: 0, meanB: -0, pctA: 0, pctB: 0, log2FoldChange: 0, pValue: 0.5, statistic: 0.1, score: 0.1, auroc: 0.5, nA: 5, nB: 3, method: 'wilcox', adjustedPValue: 0.75 },
      { gene: 'NKG7', error: 'Too few measured cells (A: 1, B: 0)', meanA: NaN, meanB: NaN, pctA: 0, pctB: NaN, log2FoldChange: NaN, pValue: NaN, statistic: NaN, score: NaN, auroc: NaN, nA: 1, nB: 0, method: 'wilcox', adjustedPValue: null },
    ],
    summary: {
      genesTested: 2,
      genesUntestable: 1,
      minCells: 10,
      lowN: ['PAGE-A', 'PAGE-B'],
      method: 'wilcox',
      pConvention: 'exact',
      correction: 'bh',
      foldChange: { mode: 'stored', base: null },
      matrix: 'mapped',
      matrixLabel: 'Mapped (X)',
      replicates: null,
      groupAName: 'PAGE-A',
      groupBName: 'PAGE-B',
      groupASize: 5,
      groupBSize: 3,
      duration: 12.5,
    },
    metadata: { pageAName: 'PAGE-A', pageBName: 'PAGE-B' },
  };
}

/** What a signature run keeps (`GeneSignatureUI` `result.raw`). */
function signatureRaw() {
  return {
    method: 'mean',
    unscored: [{ name: 'Empty', unmatched: ['NOPE'] }],
    sets: [{
      name: 'T cells',
      genes: ['CD3E', 'NKG7'],
      controlGenes: [],
      constantGenes: [],
      unmatched: ['CD3X'],
      pages: [
        { pageId: 'page-a', pageName: 'PAGE-A', scores: Float32Array.of(0.5, NaN, 1.25, -0, 3), cellIndices: Uint32Array.of(0, 1, 2, 3, 4) },
        { pageId: 'page-b', pageName: 'PAGE-B', scores: Float32Array.of(2, 0, 1), cellIndices: Uint32Array.of(5, 6, 7) },
      ],
    }],
  };
}

function correlationResult() {
  const page = (pageId, n) => ({
    pageId,
    pageName: pageId.toUpperCase(),
    r: 0.8,
    rSquared: 0.64,
    pValue: 1e-4,
    n,
    method: 'pearson',
    slope: 1.5,
    intercept: NaN,
    xValues: Float32Array.from({ length: n }, (_, i) => i),
    yValues: Float32Array.from({ length: n }, (_, i) => i * 1.5),
    xVariable: 'CD3E',
    yVariable: 'age',
    sampled: false,
    colorValues: Array.from({ length: n }, (_, i) => (i % 3 === 2 ? null : CATEGORIES[i % 2])),
    colorVariable: 'cell_type',
  });
  return {
    type: 'correlation',
    plotType: 'scatterplot',
    data: [page('page-a', 5), page('page-b', 3)],
    options: { showTrendline: true, showR2: true, showConfidenceInterval: true, colorBy: { type: 'categorical_obs', key: 'cell_type' } },
    title: 'Correlation',
    subtitle: 'CD3E vs age',
    metadata: {
      method: 'pearson',
      variableX: { type: 'gene_expression', key: 'CD3E' },
      variableY: { type: 'continuous_obs', key: 'age' },
      colorBy: 'cell_type',
    },
  };
}

/** What a marker run keeps (`GenesPanelUI` `result.stats` and `metadata`). */
function markersRun() {
  const genes = ['CD3E', 'MS4A1', 'NKG7', 'LYZ', 'GNLY'];
  const lane = (ArrayType, f) => [0, 1, 2].map(g => ArrayType.from(genes, (_, i) => f(g, i)));
  const stats = {
    genes,
    groups: [
      { groupId: 'category-code:3', groupName: 'Monocyte', cellCount: 12, color: '#aa0000', tested: true, small: false, smallFate: null, reference: false },
      { groupId: 'category-code:0', groupName: 'T cell', cellCount: 11, color: '#00aa00', tested: true, small: false, smallFate: null, reference: false },
      { groupId: 'category-code:2', groupName: 'NK cell', cellCount: 4, color: '#0000aa', tested: false, small: true, smallFate: 'skipped', reference: false },
    ],
    method: 'wilcox',
    pConvention: 'exact',
    correction: 'bh',
    foldChange: { mode: 'stored', base: null },
    minCellsPerSide: 10,
    computedAt: 1,
    computeDuration: 2,
    pValuesByGroup: lane(Float64Array, (g, i) => (g === 2 ? NaN : 1e-3 * (i + 1))),
    adjustedPValuesByGroup: lane(Float64Array, (g, i) => (g === 2 ? NaN : 2e-3 * (i + 1))),
    scoresByGroup: lane(Float32Array, (g, i) => (g === 2 ? NaN : 5 - i - g)),
    log2FoldChangeByGroup: lane(Float32Array, (g, i) => 2 - i * 0.5),
    meanInGroupByGroup: lane(Float32Array, (g, i) => g + i * 0.25),
    pctInByGroup: lane(Float32Array, () => 50),
    pctRefByGroup: lane(Float32Array, () => 10),
    aurocByGroup: lane(Float32Array, (g, i) => (g === 2 ? NaN : 0.9 - i * 0.05)),
    genesTestedByGroup: [5, 5, 0],
  };
  const metadata = {
    groupBy: 'cell_type', matrix: 'mapped', matrixLabel: 'Mapped (X)', method: 'wilcox', pConvention: 'exact', correction: 'bh',
    foldChange: { mode: 'stored', base: null }, minCellsPerSide: 10, geneCount: 5, groupCount: 3, testedCount: 2,
    skippedGroups: [{ name: 'NK cell', cells: 4 }], pooledGroups: [], lowNGroups: [], cached: false, durationMs: 2, tuning: null,
  };
  return { stats, metadata };
}

test('the result codec round-trips special numbers, sharing, records and labels exactly', async () => {
  const shared = { kept: true };
  const typed = Float32Array.of(1, NaN, -0);
  const value = {
    numbers: [1, NaN, -0, Infinity, -Infinity],
    counts: [0, 1, 4294967295],
    records: [{ a: 1, b: 'x' }, { a: NaN, c: null }, { a: 2, b: 'y', c: 3 }],
    labels: ['x', 'y', 'x', 'x'],
    twice: [shared, shared],
    typed,
    sameTyped: typed,
    narrow: Int16Array.of(-5, 7),
    clamped: Uint8ClampedArray.of(0, 255),
    missing: undefined,
    $typed: 'data, not a reserved key',
    empty: [],
  };
  Object.defineProperty(value, '__proto__', { value: 'own', enumerable: true, configurable: true, writable: true });
  const encoded = encodeAnalysisResult(value);
  const decoded = decodeAnalysisResult(await throughSession(encoded));
  assert.deepStrictEqual(decoded, value);
  assert.equal(decoded.twice[0], decoded.twice[1]);
  assert.equal(decoded.typed, decoded.sameTyped);
  assert.notEqual(decoded.typed, typed, 'the encoded value never aliases the live arrays');
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.ok(Object.hasOwn(decoded, '__proto__'));
  assert.throws(() => encodeAnalysisResult({ m: new Map() }), /Map/);
  assert.throws(() => decodeAnalysisResult({ $: 'mystery' }), /unknown tag/);
});

test('differential expression results restore deep-equal through the session and the render path', async () => {
  const source = createUI(DEAnalysisUI);
  await shown(source, source._buildResult(deFull(), source._requireOptions()));
  const exported = source.exportResult();
  assert.equal(exported.kind, 'differential');
  assert.equal(exported.version, ANALYSIS_RESULT_VERSION);
  const target = createUI(DEAnalysisUI);
  await target.importResult(await throughSession(exported));
  assert.deepStrictEqual(target._lastResult.full, deFull());
  assert.equal(target.shown[0], target._lastResult, 'the rendered and published result are one value');
  assert.equal(createUI(DEAnalysisUI).exportResult(), null);
  await target.importResult(null);
  assert.equal(target._lastResult, null);
  await assert.rejects(createUI(DEAnalysisUI).importResult({ ...exported, version: ANALYSIS_RESULT_VERSION - 1 }), /version/);
  await assert.rejects(
    createUI(DEAnalysisUI, createDataLayer({ genes: ['MS4A1'] })).importResult(await throughSession(exported)),
    /"CD3E".*lacks|lacks: "CD3E"/,
  );
});

test('a restored result is current at once; its drawing, which waits for its panel to be shown, is never waited for', async () => {
  const source = createUI(DEAnalysisUI);
  await shown(source, source._buildResult(deFull(), source._requireOptions()));
  const exported = source.exportResult();

  // A panel not shown (a closed row or window, a tab in the background):
  // its plot draws only once it has a size, here never until `show()`.
  const hidden = createUI(DEAnalysisUI);
  let show;
  hidden._showResult = result => new Promise(resolve => {
    show = () => { hidden.shown.push(result); resolve(); };
  });
  await hidden.importResult(await throughSession(exported));
  assert.deepStrictEqual(hidden._lastResult.full, deFull(), 'restored before anything is drawn');
  assert.equal(hidden.shown.length, 0);
  assert.notEqual(hidden.exportResult(), null, 'saved again before it is drawn, the result is kept');
  show();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(hidden.shown[0], hidden._lastResult, 'drawn once shown: the drawn and current result are one value');
  assert.equal(hidden.isLoading(), false, 'the restore request ends with its drawing');

  // A drawing that fails says so and withdraws the result.
  const failing = createUI(DEAnalysisUI);
  const said = [];
  failing._notifications = { error: message => said.push(message) };
  let fail;
  failing._showResult = () => new Promise((_, reject) => { fail = reject; });
  await failing.importResult(await throughSession(exported));
  assert.notEqual(failing._lastResult, null);
  fail(new Error('no graphics'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(failing._lastResult, null);
  assert.deepEqual(said, ['The restored result could not be drawn: no graphics']);
});

test('gene signature results restore deep-equal through the session and the render path', async () => {
  const source = createUI(GeneSignatureUI);
  await shown(source, await source._buildResult(signatureRaw(), source._requireOptions()));
  const exported = source.exportResult();
  assert.equal(exported.kind, 'signature');
  const target = createUI(GeneSignatureUI);
  await target.importResult(await throughSession(exported));
  assert.deepStrictEqual(target._lastResult.raw, signatureRaw());
  assert.equal(target.shown[0], target._lastResult);
  await assert.rejects(
    createUI(GeneSignatureUI, createDataLayer({ genes: ['MS4A1'] })).importResult(await throughSession(exported)),
    /"CD3E".*lacks|lacks: "CD3E"/,
  );
  await assert.rejects(
    createUI(GeneSignatureUI, createDataLayer({ pages: new Map([['page-a', 5]]) })).importResult(await throughSession(exported)),
    /do not exist: "page-b"/,
  );
});

test('correlation results restore deep-equal through the session and the render path', async () => {
  const original = correlationResult();
  const source = createUI(CorrelationAnalysisUI);
  await shown(source, original);
  const exported = source.exportResult();
  const target = createUI(CorrelationAnalysisUI);
  await target.importResult(await throughSession(exported));
  assert.deepStrictEqual(target.shown, [original]);
  assert.deepStrictEqual(target._lastResult, original);
  await assert.rejects(
    createUI(CorrelationAnalysisUI, createDataLayer({ pages: new Map([['page-a', 5]]) })).importResult(await throughSession(exported)),
    /do not exist: "page-b"/,
  );
});

test('a signature result is refused when a group no longer has its scored cells', async () => {
  const source = createUI(GeneSignatureUI);
  await shown(source, await source._buildResult(signatureRaw(), source._requireOptions()));
  await assert.rejects(
    createUI(GeneSignatureUI, createDataLayer({ pages: new Map([['page-a', 4], ['page-b', 3]]) }))
      .importResult(await throughSession(source.exportResult())),
    /5 scores for cell group "page-a", which now has 4 cells/,
  );
});

test('a signature scored on the cells genes were read for restores with them, and says so', async () => {
  // Genes read for the first 6 of 8 open cells: page-b (cells 5-7) was scored on cell 5 alone.
  const raw = signatureRaw();
  raw.geneSample = { cells: 6, of: 8, groups: [{ name: 'PAGE-A', used: 5, of: 5 }, { name: 'PAGE-B', used: 1, of: 3 }] };
  raw.sets[0].pages[1] = { pageId: 'page-b', pageName: 'PAGE-B', scores: Float32Array.of(2), cellIndices: Uint32Array.of(5) };
  const source = createUI(GeneSignatureUI);
  await shown(source, await source._buildResult(raw, source._requireOptions()));
  assert.deepEqual(source._lastResult.geneSample, raw.geneSample, 'the result names its gene sample');
  const target = createUI(GeneSignatureUI);
  await target.importResult(await throughSession(source.exportResult()));
  assert.deepStrictEqual(target._lastResult.raw, raw);
  assert.deepEqual(target._lastResult.geneSample, raw.geneSample);
  // Scores for more of a page's cells than genes were read for: refused, naming the sample.
  const wrong = signatureRaw();
  wrong.geneSample = raw.geneSample;
  const refused = createUI(GeneSignatureUI);
  await shown(refused, await refused._buildResult(wrong, refused._requireOptions()));
  await assert.rejects(
    createUI(GeneSignatureUI).importResult(await throughSession(refused.exportResult())),
    /3 scores for cell group "page-b", which now has 1 cell among the first 6 open cells, those genes were read for/,
  );
});

test('a correlation result is refused when its colour field lacks a category', async () => {
  const source = createUI(CorrelationAnalysisUI);
  await shown(source, correlationResult());
  await assert.rejects(
    createUI(CorrelationAnalysisUI, createDataLayer({ categories: ['T cell'] }))
      .importResult(await throughSession(source.exportResult())),
    /category "B cell"/,
  );
});

test('marker results name groups by category and restore by category, whatever the codes', async () => {
  const { stats, metadata } = markersRun();
  const source = createUI(GenesPanelUI);
  await shown(source, { stats, metadata });
  const exported = source.exportResult();
  const text = JSON.stringify(await splitValue(exported, new Map()));
  assert.equal(text.includes('category-code:'), false, 'codes never reach the session');
  assert.equal(text.includes('category:\\"Monocyte\\"'), true);

  // Codes differ in the open dataset: the same categories, reordered.
  const reordered = ['Monocyte', 'NK cell', 'B cell', 'T cell'];
  const target = createUI(GenesPanelUI, createDataLayer({ categories: reordered }));
  target._show = 'list';
  await target.importResult(await throughSession(exported));
  assert.deepStrictEqual(
    target._lastResult.stats.groups.map(group => group.groupId),
    ['category-code:0', 'category-code:3', 'category-code:1'],
  );
  assert.deepStrictEqual(target._lastResult.stats.scoresByGroup, stats.scoresByGroup);
  assert.equal(target.shown[0], target._lastResult);

  await assert.rejects(
    createUI(GenesPanelUI, createDataLayer({ categories: ['T cell', 'NK cell'] })).importResult(await throughSession(exported)),
    /category "Monocyte", which field "cell_type" lacks/,
  );
  await assert.rejects(
    createUI(GenesPanelUI, createDataLayer({ genes: ['CD3E'] })).importResult(await throughSession(exported)),
    /genes the open dataset lacks/,
  );
});

test('Quick and Detailed recompute from settings and hold no session result', async () => {
  const ui = new DetailedAnalysisUI({ comparisonModule: {}, dataLayer: createDataLayer(), multiVariableAnalysis: {} });
  assert.equal(ui.exportResult(), null);
  await ui.importResult(null);
  await assert.rejects(ui.importResult({ kind: 'detailed' }), /must be null/);
});

function createModeRow(mode, open) {
  const header = {
    expanded: open ? 'true' : 'false',
    getAttribute: () => header.expanded,
    setAttribute: (_name, value) => { header.expanded = value; },
  };
  const content = { hidden: !open };
  return {
    dataset: { mode },
    header,
    querySelector(selector) {
      return selector.includes('disclosure-header') ? header : content;
    },
  };
}

function createPanel({ openMode = null } = {}) {
  const ids = ['simple', 'differential', 'signature'];
  const rows = ids.map(id => createModeRow(id, id === openMode));
  const uis = new Map();
  const calls = [];
  for (const id of ids) {
    uis.set(id, {
      settings: { selectedPages: [], marker: `${id}-default` },
      result: null,
      exportSettings() { return structuredClone(this.settings); },
      exportResult() { return this.result; },
      importSettings(settings) {
        if (settings.marker === 'bad') throw new TypeError(`${id} settings refused`);
        calls.push(`${id}:settings`);
        this.settings = settings;
      },
      async importResult(result) {
        calls.push(`${id}:result`);
        this.result = result;
      },
    });
  }
  const initialized = new Set(['simple']);
  const module = Object.create(ComparisonModule.prototype);
  module._analysisMode = 'simple';
  module._modeToggleContainer = {
    querySelectorAll: () => rows,
    querySelector: selector => rows.find(row => selector.includes(`"${row.dataset.mode}"`)) ?? null,
  };
  module._uiManager = {
    getAllTypes: () => ids.map(id => ({ id })),
    getTypeInfo: id => (ids.includes(id) ? { id } : null),
    isInitialized: id => initialized.has(id),
    getUI(id) {
      initialized.add(id);
      return uis.get(id);
    },
    switchToMode(id) { calls.push(`switch:${id}`); },
    async releaseMode(id) {
      calls.push(`release:${id}`);
      initialized.delete(id);
    },
    onVisibilityChanged() {},
    clearActiveMode() { calls.push('clear'); },
  };
  return { module, rows, uis, calls, initialized };
}

test('the docked panel exports its open row and every created mode, and restores them in order', async () => {
  const saved = createPanel({ openMode: 'differential' });
  saved.module._uiManager.getUI('differential');
  saved.uis.get('differential').result = { kind: 'differential', version: 1, payload: null };
  const state = saved.module.exportSessionState();
  assert.deepStrictEqual(state, {
    openMode: 'differential',
    modes: {
      simple: { settings: { selectedPages: [], marker: 'simple-default' }, result: null },
      differential: {
        settings: { selectedPages: [], marker: 'differential-default' },
        result: { kind: 'differential', version: 1, payload: null },
      },
    },
  });

  const restored = createPanel();
  await restored.module.importSessionState(await throughSession(state));
  assert.deepStrictEqual(restored.calls, [
    'switch:differential',
    'simple:settings',
    'simple:result',
    'differential:settings',
    'differential:result',
  ]);
  assert.equal(restored.rows[1].header.expanded, 'true');
  assert.equal(restored.module._getOpenMode(), 'differential');
  assert.deepStrictEqual(restored.module.exportSessionState(), state);

  // A closed row in the session closes the open one, and a mode the state
  // never opened is unmade: the panel exports exactly what was restored.
  restored.calls.length = 0;
  await restored.module.importSessionState({ openMode: null, modes: {} });
  assert.equal(restored.module._getOpenMode(), null);
  assert.deepStrictEqual(restored.calls.filter(call => call.startsWith('release:')), ['release:simple', 'release:differential']);
  assert.deepStrictEqual(restored.module.exportSessionState(), { openMode: null, modes: {} });
});

test('docked panel session state is refused whole when its shape is wrong', async () => {
  const { module, calls } = createPanel();
  const valid = { settings: { selectedPages: [] }, result: null };
  for (const [state, pattern] of [
    [{ openMode: null }, /exactly openMode and modes/],
    [{ openMode: null, modes: {}, extra: 1 }, /exactly openMode and modes/],
    [{ openMode: null, modes: { mystery: valid } }, /unknown mode "mystery"/],
    [{ openMode: null, modes: { simple: { settings: {} } } }, /exactly settings and result/],
    [{ openMode: null, modes: { simple: { settings: [], result: null } } }, /settings must be an object/],
    [{ openMode: null, modes: { simple: { settings: {}, result: 3 } } }, /result must be null or an object/],
    [{ openMode: 'signature', modes: { simple: valid } }, /openMode must be null or one of its modes/],
  ]) {
    await assert.rejects(module.importSessionState(state), pattern);
  }
  assert.deepStrictEqual(calls, [], 'nothing changes before the state is checked');
  await assert.rejects(
    module.importSessionState({ openMode: null, modes: { simple: { settings: { marker: 'bad' }, result: null } } }),
    /simple settings refused/,
  );
});

test('floating windows carry their result through the session and restore it after their settings; their place is apart', async () => {
  const result = { kind: 'differential', version: ANALYSIS_RESULT_VERSION, payload: null };
  const calls = [];
  const manager = Object.create(AnalysisWindowManager.prototype);
  manager._windows = new Map();
  manager._assertWindowCreationAvailable = () => {};
  manager._createWindow = (modeId, settings, options) => {
    calls.push(`create:${modeId}:${settings.marker}`);
    const id = `window-${manager._windows.size + 1}`;
    // The window's own box, as the dockable owner writes it (which window is
    // in front is not part of the record: a press raises a window); without
    // a place, where a new window opens.
    const style = new Map([
      ['--pos-x', `${options.left ?? 40}px`],
      ['--pos-y', `${options.top ?? 40}px`],
      ['--pos-width', `${options.preferredSize?.width ?? 320}px`],
      ['--pos-height', `${options.preferredSize?.height ?? 240}px`],
      ['--z-layer', '7'],
    ]);
    manager._windows.set(id, {
      id,
      modeId,
      headerTitle: 'DE',
      details: { open: options.open ?? true },
      frame: {
        getBoundingClientRect: () => ({ left: 1, top: 2, width: 300, height: 34 }),
        style: { getPropertyValue: name => style.get(name) ?? '' },
      },
      ui: {
        exportSettings: () => ({ ...settings }),
        exportResult: () => result,
        async importResult(value) {
          calls.push(`result:${value?.kind ?? 'none'}`);
          if (value?.kind === 'refused') throw new Error('result refused');
        },
      },
    });
    return id;
  };
  manager.closeWindow = async id => {
    calls.push(`close:${id}`);
    manager._windows.delete(id);
  };
  // The window's analysis (the `analysis` domain), and its place (the
  // `layout` domain): a collapsed window's saved box is the one it reopens
  // at, never the header-high box the stylesheet draws.
  const descriptor = {
    modeId: 'differential',
    settings: { marker: 'saved' },
    result,
    headerTitle: 'DE',
  };
  const place = { rect: { left: 1, top: 2, width: 300, height: 200 }, open: false };

  assert.equal(await manager.createFromSessionDescriptor(descriptor, place), 'window-1');
  assert.deepStrictEqual(calls, ['create:differential:saved', 'result:differential']);
  const exported = manager.exportSessionWindows();
  assert.deepStrictEqual(exported, [descriptor]);
  assert.deepStrictEqual(manager.exportWindowPlaces(), [place]);
  assert.deepStrictEqual(await throughSession(exported), exported, 'the window record is a storable history value');
  assert.deepStrictEqual(await throughSession(manager.exportWindowPlaces()), [place], 'so are the places');

  calls.length = 0;
  assert.equal(manager.createFromSessionDescriptor({ ...descriptor, result: null }), 'window-2');
  assert.deepStrictEqual(calls, ['create:differential:saved'], 'no result, nothing to restore');
  assert.deepStrictEqual(manager.exportWindowPlaces()[1], { rect: { left: 40, top: 40, width: 320, height: 240 }, open: true },
    'without a place, where a new window of its analysis opens');
  assert.throws(() => manager.createFromSessionDescriptor(descriptor, { rect: place.rect }), /must contain exactly/);
  assert.throws(() => manager.createFromSessionDescriptor({ ...descriptor, open: true }), /unexpected: open/, 'a window\'s fold is its place, not its analysis');

  calls.length = 0;
  await assert.rejects(
    manager.createFromSessionDescriptor({ ...descriptor, result: { kind: 'refused' } }),
    /result refused/,
  );
  assert.deepStrictEqual(calls, ['create:differential:saved', 'result:refused', 'close:window-3']);
  assert.throws(
    () => manager.createFromSessionDescriptor({ ...descriptor, result: undefined }),
    /must contain exactly|result must be null or an object/,
  );
  const { result: _omitted, ...withoutResult } = descriptor;
  assert.throws(() => manager.createFromSessionDescriptor(withoutResult), /must contain exactly/);
  assert.throws(() => manager.createFromSessionDescriptor({ ...descriptor, z: 3 }), /unexpected: z/);
});
