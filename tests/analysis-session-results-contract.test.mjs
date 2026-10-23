/**
 * Analysis panel state and results in a session.
 *
 * The docked panel saves which mode row is open and, for every mode it has
 * created, its settings and its shown result. Results are JSON values plus
 * typed numeric arrays (session/codecs/typed-json.js), name genes, fields and
 * categories by key, and come back deep-equal to the live result through the
 * same render path a fresh run takes. A result that names something the open
 * dataset lacks is refused.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeAnalysisResult,
  encodeAnalysisResult,
  requireTypedJsonValue,
} from '../assets/js/app/analysis/shared/analysis-result-codec.js';
import { ANALYSIS_RESULT_VERSION } from '../assets/js/app/analysis/shared/analysis-result-session.js';
import { ComparisonModule } from '../assets/js/app/analysis/comparison-module.js';
import { CorrelationAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/correlation-analysis-ui.js';
import { DEAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/de-analysis-ui.js';
import { DetailedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/detailed-analysis-ui.js';
import { GeneSignatureUI } from '../assets/js/app/analysis/ui/analysis-types/gene-signature-ui.js';
import { GenesPanelUI } from '../assets/js/app/analysis/ui/analysis-types/genes-panel-ui.js';
import { AnalysisWindowManager } from '../assets/js/app/analysis/ui/analysis-window-manager.js';
import { ClusteringEngine } from '../assets/js/app/analysis/genes-panel/clustering-engine.js';
import { decodeTypedJson, encodeTypedJson } from '../assets/js/app/session/codecs/typed-json.js';

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
    async ensureObsFieldLoaded() {},
  };
}

/** A UI whose render path is recorded instead of drawn. */
function createUI(UI, dataLayer = createDataLayer()) {
  const ui = new UI({ comparisonModule: {}, dataLayer, multiVariableAnalysis: {} });
  ui.shown = [];
  ui._showResult = async result => {
    ui.shown.push(result);
  };
  if (UI === GenesPanelUI) ui._ensureController = async () => null;
  return ui;
}

/** The session's own storage step: typed JSON bytes and back. */
function throughSession(value) {
  requireTypedJsonValue(value);
  return decodeTypedJson(encodeTypedJson(value));
}

function deResult() {
  return {
    type: 'differential',
    plotType: 'volcanoplot',
    data: {
      results: [
        { gene: 'CD3E', meanA: 2.5, meanB: 0.25, log2FoldChange: 3.1, pValue: 1e-12, statistic: 9.5, nA: 5, nB: 3, method: 'wilcox', adjustedPValue: 6e-12 },
        { gene: '__proto__', meanA: 0, meanB: -0, log2FoldChange: 0, pValue: 0.5, statistic: 0.1, nA: 5, nB: 3, method: 'wilcox', adjustedPValue: 0.75 },
        { gene: 'NKG7', error: 'Insufficient valid cells (A: 1, B: 0)', meanA: NaN, meanB: NaN, log2FoldChange: NaN, pValue: NaN, statistic: NaN, nA: 1, nB: 0, method: 'wilcox', adjustedPValue: null },
      ],
      summary: {
        genesTested: 2,
        genesUntestable: 1,
        minCells: 3,
        significantGenes: 1,
        upregulated: 1,
        downregulated: 0,
        method: 'wilcox',
        pageA: 'page-a',
        pageB: 'page-b',
        duration: 12.5,
        throughput: Infinity,
        batchConfig: { preloadCount: 4, memoryBudgetMB: 512 },
      },
      metadata: { pageAName: 'PAGE-A', pageBName: 'PAGE-B', recommendedSettings: undefined },
    },
    options: { pValueThreshold: 0.05, foldChangeThreshold: 1, useAdjustedPValue: true, labelTopN: 15 },
    title: 'Differential expression',
    subtitle: 'PAGE-A vs PAGE-B',
  };
}

function signatureResult() {
  return {
    type: 'signature',
    plotType: 'violinplot',
    data: [
      { pageId: 'page-a', pageName: 'PAGE-A', values: Float32Array.of(0.5, NaN, 1.25, -0, 3), variableInfo: { name: 'Signature Score', kind: 'continuous' } },
      { pageId: 'page-b', pageName: 'PAGE-B', values: Float32Array.of(2, 0, 1), variableInfo: { name: 'Signature Score', kind: 'continuous' } },
    ],
    options: { showPoints: 'outliers', showMean: true },
    title: 'Gene signature score',
    subtitle: '2 genes: CD3E, NKG7',
    metadata: { genes: ['CD3E', 'NKG7'], method: 'mean', normalize: 'none' },
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

async function markersPayload() {
  const genes = ['CD3E', 'MS4A1', 'NKG7', 'LYZ', 'GNLY'];
  const groupIds = ['category-code:3', 'category-code:0', 'category-code:2'];
  const values = Float32Array.from({ length: genes.length * 3 }, (_, i) => Math.sin(i * 1.7) * 2);
  const matrix = {
    genes,
    groupIds,
    groupNames: ['Monocyte', 'T cell', 'NK cell'],
    groupColors: ['#aa0000', '#00aa00', '#0000aa'],
    values,
    rawValues: values.map(v => Math.exp(v)),
    nRows: genes.length,
    nCols: 3,
    transform: 'zscore',
  };
  const clustering = await new ClusteringEngine().clusterMatrix({
    matrix,
    clusterRows: true,
    clusterCols: true,
    distance: 'correlation',
    linkage: 'average',
    memoryBudgetBytes: 2 ** 26,
  });
  const markerRows = (groupId, list) => list.map((gene, i) => ({
    gene, groupId, rank: i + 1, pValue: 1e-5 * (i + 1), adjustedPValue: 2e-5 * (i + 1), log2FoldChange: 2 - i,
    meanInGroup: 3, meanOutGroup: 1, percentInGroup: 90, percentOutGroup: 10,
  }));
  const groups = {};
  for (const [index, groupId] of groupIds.entries()) {
    groups[groupId] = {
      groupId,
      groupName: matrix.groupNames[index],
      cellCount: 10 + index,
      color: matrix.groupColors[index],
      genesTested: 5,
      genesUntestable: 0,
      markers: markerRows(groupId, genes.slice(index, index + 2)),
    };
  }
  const result = {
    type: 'genes_panel',
    plotType: 'gene-heatmap',
    data: { matrix, clustering },
    options: { pValueThreshold: 0.05, foldChangeThreshold: 1, useAdjustedPValue: true, transform: 'zscore', hasClustering: true, colorscale: 'RdBu', showValues: false, reverseColorscale: true },
    title: 'Marker genes',
    subtitle: 'cell_type',
    markers: {
      obsCategory: 'cell_type',
      method: 'wilcox',
      minCellsPerSide: 3,
      computedAt: 1,
      computeDuration: 2,
      geneCount: genes.length,
      groups,
      stats: {
        genes,
        groupIds: [...groupIds],
        pValuesByGroup: groupIds.map(() => Float64Array.from(genes, (_, i) => 1e-3 * (i + 1))),
      },
    },
    clustering,
    metadata: { obsCategory: 'cell_type', mode: 'clustered', distance: 'correlation', linkage: 'average', matrixGeneCount: genes.length },
  };
  return { result, fullMatrix: matrix, committedGeneListMode: 'top5' };
}

test('the result codec round-trips special numbers, sharing, records and labels exactly', () => {
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
  const decoded = decodeAnalysisResult(throughSession(encoded));
  assert.deepStrictEqual(decoded, value);
  assert.equal(decoded.twice[0], decoded.twice[1]);
  assert.equal(decoded.typed, decoded.sameTyped);
  assert.notEqual(decoded.typed, typed, 'the encoded value never aliases the live arrays');
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.ok(Object.hasOwn(decoded, '__proto__'));
  assert.throws(() => encodeAnalysisResult({ m: new Map() }), /Map/);
  assert.throws(() => decodeAnalysisResult({ $: 'mystery' }), /unknown tag/);
});

for (const [label, UI, kind, makeResult] of [
  ['differential expression', DEAnalysisUI, 'differential', deResult],
  ['gene signature', GeneSignatureUI, 'signature', signatureResult],
  ['correlation', CorrelationAnalysisUI, 'correlation', correlationResult],
]) {
  test(`${label} results restore deep-equal through the session and the render path`, async () => {
    const original = makeResult();
    const source = createUI(UI);
    source._lastResult = original;
    const exported = source.exportResult();
    assert.equal(exported.kind, kind);
    assert.equal(exported.version, ANALYSIS_RESULT_VERSION);
    requireTypedJsonValue(exported);

    const target = createUI(UI);
    await target.importResult(throughSession(exported));
    assert.deepStrictEqual(target.shown, [original]);
    assert.deepStrictEqual(target._lastResult, original);
    assert.equal(target.shown[0], target._lastResult, 'the rendered and published result are one value');
    assert.equal(target.isLoading(), false);

    assert.equal(createUI(UI).exportResult(), null);
    await target.importResult(null);
    assert.equal(target._lastResult, null);

    await assert.rejects(
      createUI(UI).importResult({ ...exported, version: ANALYSIS_RESULT_VERSION + 1 }),
      /version/,
    );
    await assert.rejects(
      createUI(UI).importResult({ ...exported, kind: 'other' }),
      /cannot be restored/,
    );
    await assert.rejects(
      createUI(UI, createDataLayer({ genes: ['MS4A1'] })).importResult(throughSession(exported)),
      /"CD3E".*lacks|lacks: "CD3E"/,
    );
    await assert.rejects(
      createUI(UI, createDataLayer({ pages: new Map([['page-a', 5]]) })).importResult(throughSession(exported)),
      /do not exist: "page-b"/,
    );
  });
}

test('a signature result is refused when a group no longer has its scored cells', async () => {
  const source = createUI(GeneSignatureUI);
  source._lastResult = signatureResult();
  await assert.rejects(
    createUI(GeneSignatureUI, createDataLayer({ pages: new Map([['page-a', 4], ['page-b', 3]]) }))
      .importResult(throughSession(source.exportResult())),
    /5 scores for cell group "page-a", which now has 4 cells/,
  );
});

test('a correlation result is refused when its colour field lacks a category', async () => {
  const source = createUI(CorrelationAnalysisUI);
  source._lastResult = correlationResult();
  await assert.rejects(
    createUI(CorrelationAnalysisUI, createDataLayer({ categories: ['T cell'] }))
      .importResult(throughSession(source.exportResult())),
    /category "B cell"/,
  );
});

test('marker results name groups by category and restore with matrix, dendrograms and sharing', async () => {
  const payload = await markersPayload();
  const source = createUI(GenesPanelUI);
  source._lastResult = payload.result;
  source._fullMatrix = payload.fullMatrix;
  source._committedGeneListMode = payload.committedGeneListMode;
  const exported = source.exportResult();
  requireTypedJsonValue(exported);
  const text = new TextDecoder().decode(encodeTypedJson(exported));
  assert.equal(text.includes('category-code:'), false, 'codes never reach the session');
  assert.equal(text.includes('category:\\"Monocyte\\"'), true);

  // Codes differ in the open dataset: the same categories, reordered.
  const reordered = ['Monocyte', 'NK cell', 'B cell', 'T cell'];
  const target = createUI(GenesPanelUI, createDataLayer({ categories: reordered }));
  await target.importResult(throughSession(exported));
  const remap = id => `category-code:${reordered.indexOf(CATEGORIES[Number(id.slice(14))])}`;
  const expected = await markersPayload();
  const remapAll = value => {
    value.result.data.matrix.groupIds = value.result.data.matrix.groupIds.map(remap);
    value.result.markers.stats.groupIds = value.result.markers.stats.groupIds.map(remap);
    const groups = {};
    for (const [id, group] of Object.entries(value.result.markers.groups)) {
      group.groupId = remap(id);
      for (const marker of group.markers) marker.groupId = remap(marker.groupId);
      groups[remap(id)] = group;
    }
    value.result.markers.groups = groups;
  };
  remapAll(expected);
  assert.deepStrictEqual(target._lastResult, expected.result);
  assert.deepStrictEqual(target._fullMatrix, expected.fullMatrix);
  assert.equal(target._committedGeneListMode, 'top5');
  assert.equal(target._fullMatrix, target._lastResult.data.matrix, 'shared matrices stay shared');
  assert.equal(target._lastResult.clustering, target._lastResult.data.clustering);

  // Same codes: the restored result is the original, deep-equal.
  const same = createUI(GenesPanelUI);
  await same.importResult(throughSession(exported));
  assert.deepStrictEqual(same._lastResult, payload.result);

  await assert.rejects(
    createUI(GenesPanelUI, createDataLayer({ categories: ['T cell', 'NK cell'] })).importResult(throughSession(exported)),
    /category "Monocyte", which field "cell_type" lacks/,
  );
  await assert.rejects(
    createUI(GenesPanelUI, createDataLayer({ genes: ['CD3E'] })).importResult(throughSession(exported)),
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
  requireTypedJsonValue(state);

  const restored = createPanel();
  await restored.module.importSessionState(throughSession(state));
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

  // A closed row in the session closes the open one.
  await restored.module.importSessionState({ openMode: null, modes: {} });
  assert.equal(restored.module._getOpenMode(), null);
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

test('floating windows carry their result through the session and restore it after their settings', async () => {
  const result = { kind: 'differential', version: ANALYSIS_RESULT_VERSION, payload: null };
  const calls = [];
  const manager = Object.create(AnalysisWindowManager.prototype);
  manager._windows = new Map();
  manager._assertWindowCreationAvailable = () => {};
  manager._createWindow = (modeId, settings) => {
    calls.push(`create:${modeId}:${settings.marker}`);
    const id = `window-${manager._windows.size + 1}`;
    manager._windows.set(id, {
      id,
      modeId,
      headerTitle: 'DE',
      frame: { getBoundingClientRect: () => ({ left: 1, top: 2, width: 300, height: 200 }) },
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
  const descriptor = {
    modeId: 'differential',
    rect: { left: 1, top: 2, width: 300, height: 200 },
    settings: { marker: 'saved' },
    result,
    headerTitle: 'DE',
  };

  assert.equal(await manager.createFromSessionDescriptor(descriptor), 'window-1');
  assert.deepStrictEqual(calls, ['create:differential:saved', 'result:differential']);
  const exported = manager.exportSessionWindows();
  assert.deepStrictEqual(exported, [descriptor]);
  requireTypedJsonValue(exported);

  calls.length = 0;
  assert.equal(manager.createFromSessionDescriptor({ ...descriptor, result: null }), 'window-2');
  assert.deepStrictEqual(calls, ['create:differential:saved'], 'no result, nothing to restore');

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
});
