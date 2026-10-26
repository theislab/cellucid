/**
 * The settings of the option-driven analyses (marker genes, differential
 * expression, gene signature, correlation) go through a session unchanged:
 * `exportSettings()` is exactly `{options, selectedPages, view}` (plus a
 * mode's own keys), the session stores it as typed JSON, and
 * `importSettings()` of that record on a fresh UI exports the same record
 * again — every option (including ones hidden by `when`), the "More options"
 * and group disclosures, the mode's view state and the selected pages. A
 * record with an unknown or missing option is refused whole.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CorrelationAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/correlation-analysis-ui.js';
import { DEAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/de-analysis-ui.js';
import { GeneSignatureUI } from '../assets/js/app/analysis/ui/analysis-types/gene-signature-ui.js';
import { GenesPanelUI } from '../assets/js/app/analysis/ui/analysis-types/genes-panel-ui.js';
import { requireTypedJsonValue } from '../assets/js/app/analysis/shared/analysis-result-codec.js';
import { decodeTypedJson, encodeTypedJson } from '../assets/js/app/session/codecs/typed-json.js';
import { getDataSourceManager } from '../assets/js/data/data-source-manager.js';

// No form is mounted: settings live on the UI itself.
globalThis.HTMLElement ??= class HTMLElement {};

// Marker genes key their groups by the open dataset.
const manager = getDataSourceManager();
const previousDatasetId = manager.activeDatasetId;
test.before(() => { manager.activeDatasetId = 'roundtrip-dataset'; });
test.after(() => { manager.activeDatasetId = previousDatasetId; });

const GENES = ['CD3E', 'MS4A1', 'NKG7', 'LYZ', 'GNLY', 'MT-CO1'];
const CATEGORIES = ['T cell', 'B cell', 'NK cell', 'Monocyte'];
const CODES = Uint8Array.from({ length: 40 }, (_, cell) => cell % CATEGORIES.length);
const PAGES = new Map([['page-a', 5], ['page-b', 3], ['page-c', 7]]);

function createDataLayer() {
  return {
    state: { pointCount: CODES.length, getDataMapping: () => ({ expression: 'X', geneNames: 'index' }) },
    getPages: () => [...PAGES.keys()].map(id => ({ id, name: id.toUpperCase() })),
    getPageInfo: pageId => (PAGES.has(pageId) ? { id: pageId, name: pageId.toUpperCase() } : null),
    getCellCountForPageId: pageId => PAGES.get(pageId) ?? 0,
    getPageCells: pageIds => pageIds.map(pageId => ({
      pageId,
      pageName: pageId.toUpperCase(),
      cellIndices: Uint32Array.from({ length: PAGES.get(pageId) }, (_, cell) => cell * 2),
    })),
    getExpressionMatrices: () => ({ choices: [{ value: 'mapped', label: 'Mapped (X)' }], reason: null }),
    resolveExpressionMatrix: () => ({ matrix: 'X', read: null, label: 'Mapped (X)' }),
    async getGeneKeys() { return this.getAvailableVariables('gene_expression').map(gene => gene.key); },
    getAvailableVariables(type) {
      if (type === 'gene_expression') return GENES.map(key => ({ key }));
      if (type === 'categorical_obs') {
        return [
          { key: 'cell_type', categories: CATEGORIES, categoryCount: CATEGORIES.length },
          { key: 'sample', categories: ['s1', 's2'], categoryCount: 2 },
        ];
      }
      if (type === 'continuous_obs') return [{ key: 'age' }, { key: 'n_counts' }];
      return [];
    },
    getVariableInfo: () => null,
    async ensureObsFieldLoaded(key) {
      if (key === 'cell_type') return { kind: 'category', codes: CODES, categories: CATEGORIES };
      if (key === 'sample') return { kind: 'category', codes: CODES.map(code => code % 2), categories: ['s1', 's2'] };
      return null;
    },
  };
}

function createUI(UI) {
  const ui = new UI({ comparisonModule: {}, dataLayer: createDataLayer(), multiVariableAnalysis: {} });
  ui._notifications = { error(message) { throw new Error(`unexpected notification: ${message}`); } };
  // The form is not mounted in node; the record is what is under test.
  ui._renderControls = () => {};
  return ui;
}

/** The session's own storage step: typed JSON bytes and back. */
function throughSession(value) {
  requireTypedJsonValue(value);
  return decodeTypedJson(encodeTypedJson(value));
}

/** Let asynchronous group descriptions settle. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

const CASES = [
  {
    label: 'marker genes',
    UI: GenesPanelUI,
    options: {
      groupBy: 'cell_type',
      compareAgainst: 'group',
      referenceGroup: 'NK cell',
      testGroups: { mode: 'subset', ids: ['T cell', 'B cell'] },
      cells: 'page:page-b',
      restIncludes: 'selected',
      minCells: 25,
      smallGroups: 'pool',
      method: 'ttest_overestim_var',
      pConvention: 'normal_tie',
      correction: 'bonferroni',
      direction: 'both',
      maxAdjP: 0.2,
      minLog2FC: 0.75,
      minPctIn: 12.5,
      maxPctRef: 60,
      excludePattern: '^RP[SL]',
      onlyGenes: 'list',
      onlyGenesList: 'CD3E, NKG7\nLYZ',
      rankBy: 'auroc',
      topN: 7,
    },
    view: { show: 'clustered', selectedGroupId: 'category:1', heatmap: null },
  },
  {
    label: 'differential expression',
    UI: DEAnalysisUI,
    options: {
      compare: 'categories',
      pageA: 'page-c',
      pageB: 'page-a',
      field: 'cell_type',
      categoriesA: { mode: 'subset', ids: ['T cell'] },
      categoriesB: { mode: 'subset', ids: ['B cell', 'Monocyte'] },
      within: 'category',
      withinField: 'sample',
      withinCategories: { mode: 'subset', ids: ['s2'] },
      minCells: 4,
      method: 'ttest',
      correction: 'bonferroni',
      maxAdjP: 0.01,
      minLog2FC: 2,
      minPct: 30,
      onlyGenes: 'list',
      onlyGenesList: 'GNLY',
      labels: 25,
    },
    view: {},
  },
  {
    label: 'gene signature',
    UI: GeneSignatureUI,
    options: {
      geneSets: [{ name: 'T', genes: ['CD3E', 'GNLY'] }, { name: 'Myeloid', genes: ['LYZ', 'NOT_A_GENE'] }],
      method: 'module',
      controlSize: 30,
      bins: 12,
      seed: 7,
      maxRank: 900,
      plotType: 'boxplot',
      rescale: 'minmax',
      layout: 'each',
    },
    view: { shownSet: 1 },
    extra: { customPageColors: [] },
  },
  {
    label: 'correlation',
    UI: CorrelationAnalysisUI,
    options: {
      variableX: { type: 'gene_expression', key: 'NKG7' },
      variableY: { type: 'continuous_obs', key: 'age' },
      method: 'spearman',
      colorBy: 'cell_type',
    },
    view: {},
    extra: { customPageColors: [] },
  },
];

for (const { label, UI, options: changed, view, extra = {} } of CASES) {
  test(`${label}: settings go through a session and come back exactly`, async () => {
    const source = createUI(UI);
    const schema = source._getOptionsSchema();
    const defaults = schema.defaults(source._getOptionsContext());
    // Options the case names must be real ones; the rest keep their defaults.
    for (const key of Object.keys(changed)) assert.ok(schema.keys.includes(key), `${label} has option ${key}`);
    const options = { ...defaults, ...structuredClone(changed) };
    // Mode view state: the case's, filled from what the mode exports.
    const exportedView = source.exportSettings().view;
    const modeView = Object.fromEntries(Object.entries(exportedView).filter(([key]) => key !== 'disclosures'));
    for (const [key, value] of Object.entries(view)) if (value !== null) modeView[key] = value;
    const settings = {
      options,
      selectedPages: ['page-c', 'page-a'],
      view: { disclosures: { more: true, groups: [schema.groups.at(-1).id, schema.groups[0].id] }, ...modeView },
      ...extra,
    };
    assert.deepEqual(Object.keys(source.exportSettings()).sort(), Object.keys(settings).sort());

    source.importSettings(throughSession(settings));
    await settle();
    const exported = throughSession(source.exportSettings());
    assert.deepEqual(exported, settings, 'what was imported is what is exported');

    const fresh = createUI(UI);
    fresh.importSettings(exported);
    await settle();
    assert.deepEqual(fresh.exportSettings(), settings, 'a fresh UI restores the record exactly');
    await source.destroy();
    await fresh.destroy();
  });

  test(`${label}: a settings record with an unknown or missing option is refused whole`, async () => {
    const ui = createUI(UI);
    const settings = ui.exportSettings();
    const before = structuredClone(settings);
    const extraKey = { ...settings, options: { ...settings.options, notAnOption: 1 } };
    assert.throws(() => ui.importSettings(extraKey), /notAnOption/);
    const firstKey = Object.keys(settings.options)[0];
    const missing = structuredClone(settings);
    delete missing.options[firstKey];
    assert.throws(() => ui.importSettings(missing), new RegExp(firstKey));
    assert.throws(() => ui.importSettings({ ...settings, extra: true }));
    assert.throws(() => ui.importSettings({ ...settings, view: { ...settings.view, disclosures: { more: 'yes', groups: [] } } }));
    assert.deepEqual(ui.exportSettings(), before, 'a refused record changes nothing');
    await ui.destroy();
  });
}
