/**
 * A synthetic page for the history stress suite: every state domain of
 * `app/actions/domains.js` with values of the shapes the app's owners
 * capture (`app/state/domains/README.md`), sized like a real dataset (up to
 * millions of cells, 20 000 genes), and the real action catalogue
 * (`ACTION_DEFINITIONS`) with handlers that change those values as the
 * page's own implementations do. What is real is everything the history
 * owns: the catalogue's schemas, labels and pseudocode, the dispatcher, the
 * history, the value pool, the session file, the autosave. What is synthetic
 * is the page under it: an owner here captures and restores plain data, so
 * the time a real owner spends reading the viewer is not counted, and the
 * figures are the history's own.
 *
 * Analysis results are made by the analysis code's own encoder
 * (`createResultEnvelope`) from results of the shapes a marker-genes, a
 * differential-expression and a correlation run return
 * (`tests/analysis-session-results-contract.test.mjs` holds small ones), so
 * a result is the value the history keeps of a real one.
 *
 * Every owner's capture copies its plain data and keeps typed arrays by
 * reference, as the real owners do (an array is immutable once captured, so
 * the pool hashes it once).
 */

import { createActionCatalog } from '../../assets/js/app/actions/catalog.js';
import { sameValue } from '../../assets/js/app/state/domains/same-value.js';
import { createActionDispatcher } from '../../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry, DOMAIN_IDS } from '../../assets/js/app/actions/domains.js';
import { ACTION_DEFINITIONS } from '../../assets/js/app/actions/definitions/index.js';
import { createResultEnvelope } from '../../assets/js/app/analysis/shared/analysis-result-session.js';
import { validateDataMapping } from '../../assets/js/data/data-mapping.js';

/** A seeded generator (mulberry32): the same seed builds the same history. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deep copy of plain data that keeps typed arrays by reference (what an owner's capture returns). */
export function clonePlain(value) {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return value.map(clonePlain);
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = clonePlain(item);
  return out;
}

const CATEGORICAL_FIELDS = Object.freeze([
  ['cell_type', 30], ['leiden', 40], ['sample', 12], ['batch', 4], ['phase', 3], ['donor', 8],
]);
const CONTINUOUS_FIELDS = Object.freeze(['n_counts', 'n_genes', 'pct_mito', 'score_a', 'score_b', 'pseudotime']);
const SECTIONS = Object.freeze(['Visualization', 'Navigation', 'Filtering', 'Highlighting', 'Session', 'Analysis', 'State']);
const COLORMAPS = Object.freeze(['viridis', 'plasma', 'magma', 'cividis', 'turbo', 'coolwarm']);
const SETTING_COUNT = 120;

function categoriesOf(field, count) {
  return Array.from({ length: count }, (_, i) => `${field} ${i}`);
}

function camera(random) {
  return {
    navigationMode: 'orbit',
    orbit: {
      radius: 1 + random() * 10, targetRadius: 3, theta: random() * 6.283, phi: random() * 3.14,
      target: [random() - 0.5, random() - 0.5, 0],
    },
    freefly: { position: [0, 0, 5], yaw: 0, pitch: 0 },
  };
}

function initialSettings() {
  const controls = {};
  for (let i = 0; i < SETTING_COUNT; i++) {
    const id = `setting-${String(i).padStart(3, '0')}`;
    controls[id] = i % 3 === 0 ? { type: 'checkbox', checked: i % 2 === 0 } : { type: 'range', value: i };
  }
  return { controls, figureExport: { format: 'png', scale: 2, background: 'white', legend: true } };
}

/**
 * The dataset the page shows: `cells` cells, `genes` gene names, the
 * categorical and continuous fields, and the session header a file of it
 * carries.
 */
export function syntheticDataset({ cells, genes = 20_000 }) {
  const geneNames = Array.from({ length: genes }, (_, i) => `GENE${String(i).padStart(5, '0')}`);
  const mapping = validateDataMapping({
    kind: 'anndata',
    embeddings: { enabled: [{ key: 'X_umap', columns: [0, 1] }], defaults: { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null } },
    knn: null, geneNames: 'index', expression: 'X', log1p: {}, highlyVariable: null, latent: null, vectorFields: [],
  });
  const header = {
    createdAt: '2026-11-04T12:00:00.000Z',
    datasetFingerprint: {
      datasetId: 'stress', name: 'History stress', cellCount: cells, varCount: genes,
      cellOrder: { embedding: { key: 'X_umap', columns: [0, 1] }, dimension: 2, digest: '0123456789abcdef' },
      dataMapping: mapping,
    },
    source: { kind: 'sample', dataset: 'stress' },
    requires: { obs: ['cell_type'], var: [] },
  };
  return { cells, genes: geneNames, mapping, header };
}

/**
 * A strictly increasing cell set of about `size` of `cells` cells, picked at
 * random (a lasso's cells are scattered in original-position order): a
 * Bernoulli scan, or for a set of most cells, every cell but a random few.
 */
export function randomCellSet(random, cells, size) {
  if (size >= cells) return Uint32Array.from({ length: cells }, (_, i) => i);
  if (size > cells / 2) {
    const drop = new Uint8Array(cells);
    let dropped = 0;
    while (dropped < cells - size) {
      const cell = Math.floor(random() * cells);
      if (drop[cell] === 0) { drop[cell] = 1; dropped++; }
    }
    const out = new Uint32Array(size);
    let n = 0;
    for (let cell = 0; cell < cells; cell++) if (drop[cell] === 0) out[n++] = cell;
    return out;
  }
  const p = size / cells;
  const picked = [];
  for (let cell = 0; cell < cells; cell++) if (random() < p) picked.push(cell);
  if (picked.length === 0) picked.push(Math.floor(random() * cells));
  return Uint32Array.from(picked);
}

/** What a differential-expression run keeps (`MultiVariableAnalysis.differentialExpression`), over every gene. */
function differentialResult(random, genes, run) {
  const results = genes.map(gene => {
    const lfc = (random() - 0.5) * 6;
    const p = random() ** 4;
    return {
      gene, meanA: random() * 3, meanB: random() * 3, pctA: random() * 100, pctB: random() * 100,
      log2FoldChange: lfc, pValue: p, statistic: lfc * 3, score: lfc * 2, auroc: random(),
      nA: 5000, nB: 7000, method: 'wilcox', adjustedPValue: Math.min(1, p * 20),
    };
  });
  return {
    results,
    summary: {
      genesTested: genes.length, genesUntestable: 0, minCells: 10, lowN: [], method: 'wilcox', pConvention: 'exact',
      correction: 'bh', foldChange: { mode: 'stored', base: null }, matrix: 'mapped', matrixLabel: 'Mapped (X)',
      replicates: null, groupAName: `Group A ${run}`, groupBName: 'Rest', groupASize: 5000, groupBSize: 7000, duration: 812.5,
    },
    metadata: { pageAName: `Group A ${run}`, pageBName: 'Rest' },
  };
}

/** What a marker-genes run keeps (`GenesPanelUI` `result.stats` and `metadata`), every gene by every group. */
function markersResult(random, genes, groupCount, run) {
  const lane = (ArrayType) => Array.from({ length: groupCount }, () => ArrayType.from({ length: genes.length }, () => random()));
  return {
    stats: {
      genes: [...genes],
      groups: Array.from({ length: groupCount }, (_, g) => ({
        groupId: `category:"cell_type ${g}"`, groupName: `cell_type ${g}`, cellCount: 1000 + g, color: '#aa0000',
        tested: true, small: false, smallFate: null, reference: false,
      })),
      method: 'wilcox', pConvention: 'exact', correction: 'bh', foldChange: { mode: 'stored', base: null },
      minCellsPerSide: 10, computedAt: run, computeDuration: 900,
      pValuesByGroup: lane(Float64Array), adjustedPValuesByGroup: lane(Float64Array), scoresByGroup: lane(Float32Array),
      log2FoldChangeByGroup: lane(Float32Array), meanInGroupByGroup: lane(Float32Array), pctInByGroup: lane(Float32Array),
      pctRefByGroup: lane(Float32Array), aurocByGroup: lane(Float32Array),
      genesTestedByGroup: Array.from({ length: groupCount }, () => genes.length),
    },
    metadata: {
      groupBy: 'cell_type', matrix: 'mapped', matrixLabel: 'Mapped (X)', method: 'wilcox', pConvention: 'exact', correction: 'bh',
      foldChange: { mode: 'stored', base: null }, minCellsPerSide: 10, geneCount: genes.length, groupCount, testedCount: groupCount,
      skippedGroups: [], pooledGroups: [], lowNGroups: [], cached: false, durationMs: 900,
    },
  };
}

/** What a correlation run keeps: per page, both variables of every cell plotted. */
function correlationResult(random, cellsPerPage, run) {
  const page = (pageId) => ({
    pageId, pageName: pageId.toUpperCase(), r: random(), rSquared: random(), pValue: random() / 1000, n: cellsPerPage,
    method: 'pearson', slope: random(), intercept: random(),
    xValues: Float32Array.from({ length: cellsPerPage }, () => random()),
    yValues: Float32Array.from({ length: cellsPerPage }, () => random()),
    xVariable: 'GENE00001', yVariable: 'n_counts', sampled: false,
    colorValues: Array.from({ length: cellsPerPage }, (_, i) => `cell_type ${i % 30}`),
    colorVariable: 'cell_type',
  });
  return {
    type: 'correlation', plotType: 'scatterplot', data: [page('page_1'), page('page_2')],
    options: { showTrendline: true, showR2: true, showConfidenceInterval: true, colorBy: { type: 'categorical_obs', key: 'cell_type' } },
    title: 'Correlation', subtitle: `GENE00001 vs n_counts (${run})`,
    metadata: { method: 'pearson', variableX: { type: 'gene_expression', key: 'GENE00001' }, variableY: { type: 'continuous_obs', key: 'n_counts' }, colorBy: 'cell_type' },
  };
}

function provenanceOf(dataset, run) {
  return {
    dataset: 'stress', cells: { open: dataset.cells, of: dataset.cells, share: 1, method: null, seed: null, digest: `cells-${dataset.cells}` },
    genes_read_for: null, pages: ['page_1'], visible_only: false, run,
  };
}

/**
 * The page: state, owners, the real catalogue and a dispatcher with handlers
 * for the actions the suite takes.
 *
 * @param {{dataset: ReturnType<typeof syntheticDataset>, seed?: number, markerGroups?: number, correlationCells?: number,
 *   catalog?: object}} options - `catalog`: a catalogue to dispatch through (the suite's timed wrapper)
 */
export function syntheticPage({ dataset, seed = 1, markerGroups = 12, correlationCells = 50_000, catalog = null }) {
  const random = seededRandom(seed);
  const allCells = Uint32Array.from({ length: dataset.cells }, (_, i) => i);
  const state = {
    cells: { open: null, genes: null },
    mapping: dataset.mapping,
    'field-overlays': { renamedFields: [], renamedCategories: [], deletedFields: [], userFields: [] },
    'gene-sets': { sets: [] },
    views: {
      layout: 'single', focus: 0, liveHidden: false, camerasLinked: false,
      views: [{ embedding: { key: 'X_umap', columns: [0, 1] }, followsDefault: true, centroids: { field: null, labels: true, points: false } }],
    },
    'active-field': { views: [{ source: 'obs', key: 'cell_type' }] },
    filters: { views: [[]] },
    colors: { views: [[]] },
    visibility: { views: [new Uint32Array(0)] },
    highlights: { active: 'page_1', pages: [{ id: 'page_1', name: 'Page 1', color: '#e41a1c', groups: [] }] },
    camera: { views: [camera(random)] },
    'camera-path': null,
    settings: initialSettings(),
    analysis: { windows: [], sizes: null, docked: { openMode: null, modes: {} } },
    layout: {
      theme: 'light', sections: Object.fromEntries(SECTIONS.map((name, i) => [name, i < 3])),
      panels: SECTIONS.map(id => ({ id, rect: null })), sidebar: { shown: true, width: 320 },
    },
  };
  /** Time spent in owners' capture and restore (what the real page's owners would spend instead). */
  const ownerTime = { capture: 0, restore: 0, captures: 0, restores: 0 };
  const domains = createDomainRegistry();
  // The analyses' owner gives back the value it captured last while they are unchanged, as the real one
  // does (`app/state/domains/analysis.js`): captured with every highlight change, it is hashed once.
  let previousAnalysis = null;
  for (const id of DOMAIN_IDS) {
    domains.provide(id, {
      capture: () => {
        const start = performance.now();
        let value = clonePlain(state[id]);
        if (id === 'analysis') {
          if (previousAnalysis !== null && sameValue(previousAnalysis, value)) value = previousAnalysis;
          else previousAnalysis = value;
        }
        ownerTime.capture += performance.now() - start;
        ownerTime.captures++;
        return value;
      },
      restore: value => {
        const start = performance.now();
        state[id] = clonePlain(value);
        ownerTime.restore += performance.now() - start;
        ownerTime.restores++;
      },
      describe: () => ['changed'],
    });
  }

  const realCatalog = createActionCatalog(ACTION_DEFINITIONS);
  const dispatcher = createActionDispatcher({ catalog: catalog?.(realCatalog) ?? realCatalog });
  let groupCounter = 0;
  let userFieldCounter = 0;
  let analysisRun = 0;

  function perView(domain, change) {
    state[domain] = { ...state[domain], views: state[domain].views.map((entry, i) => (i === 0 ? change(entry) : entry)) };
  }
  function fieldEntries(domain, field, change) {
    perView(domain, entries => {
      const at = entries.findIndex(entry => entry.field.source === field.source && entry.field.key === field.key);
      const before = at < 0 ? { field: { ...field } } : entries[at];
      const after = change(before);
      return at < 0 ? [...entries, after] : entries.map((entry, i) => (i === at ? after : entry));
    });
  }
  function highlightPage(change) {
    state.highlights = { ...state.highlights, pages: state.highlights.pages.map((page, i) => (i === 0 ? change(page) : page)) };
  }
  function setAnalysis(kind, result) {
    const docked = state.analysis.docked;
    const settings = { groupBy: 'cell_type', method: 'wilcox', minCells: 10, topGenes: 50 };
    state.analysis = {
      ...state.analysis,
      docked: { openMode: kind, modes: { ...docked.modes, [kind]: { settings, result } } },
    };
  }

  const handlers = {
    'camera.set': ({ camera: next }) => { perView('camera', () => clonePlain(next)); },
    // Opening a field changes no colours or filters: those values record only what differs from its opening state.
    'color.by': ({ field }) => { perView('active-field', () => (field === null ? null : { ...field })); },
    'color.continuous.colormap': ({ field, colormap }) => { fieldEntries('colors', field, entry => ({ ...entry, colormap })); },
    'filter.category.visibility': ({ field, categories, visible }) => {
      fieldEntries('filters', field, entry => {
        const hidden = new Set(entry.hidden ?? []);
        for (const category of categories) visible ? hidden.delete(category) : hidden.add(category);
        return { ...entry, hidden: [...hidden].sort() };
      });
    },
    'filter.continuous.range': ({ field, min, max }) => {
      fieldEntries('filters', field, entry => ({ ...entry, range: { min, max } }));
      fieldEntries('colors', field, entry => ({ ...entry, range: { min, max } }));
    },
    'highlight.cells': ({ cells, label }) => {
      groupCounter++;
      // A tool's cells are kept by identity: the step's cells and the group's are one array.
      highlightPage(page => ({
        ...page, groups: [...page.groups, { id: `highlight_${groupCounter}`, type: 'lasso', label: label ?? `Highlight ${groupCounter}`, enabled: true, cells }],
      }));
      return { cells: cells.length };
    },
    'highlight.group.remove': ({ group }) => {
      highlightPage(page => ({ ...page, groups: page.groups.filter(entry => entry.label !== group) }));
    },
    'highlight.group.toggle': ({ group, enabled }) => {
      highlightPage(page => ({ ...page, groups: page.groups.map(entry => (entry.label === group ? { ...entry, enabled } : entry)) }));
    },
    'cells.visibility.set': ({ cells, visible }) => {
      perView('visibility', hidden => {
        if (cells === null) return visible ? new Uint32Array(0) : allCells;
        const set = new Set(hidden);
        for (const cell of cells) visible ? set.delete(cell) : set.add(cell);
        return Uint32Array.from([...set].sort((a, b) => a - b));
      });
    },
    'category.rename': ({ field, category, name }) => {
      const overlays = state['field-overlays'];
      const rest = overlays.renamedCategories.filter(entry => !(entry.field === field.key && entry.category === category));
      state['field-overlays'] = { ...overlays, renamedCategories: [...rest, { source: 'obs', field: field.key, category, name }] };
    },
    'field.push': ({ key, categories, values }) => {
      userFieldCounter++;
      const overlays = state['field-overlays'];
      state['field-overlays'] = {
        ...overlays,
        userFields: [...overlays.userFields, {
          id: `user_${userFieldCounter}`, source: 'obs', kind: 'category', key, deleted: false, purged: false, createdAt: userFieldCounter,
          sourceField: null, operation: null, categories: [...categories], codes: { cells: allCells, values },
          sourcePages: [], overlapStrategy: 'first', overlapLabel: null, intersectionLabels: false, uncoveredLabel: 'Unassigned',
        }],
      };
      perView('active-field', () => ({ source: 'obs', user: `user_${userFieldCounter}` }));
    },
    'setting.set': ({ setting, value }) => {
      const record = state.settings.controls[setting];
      state.settings = {
        ...state.settings,
        controls: { ...state.settings.controls, [setting]: record.type === 'checkbox' ? { ...record, checked: Boolean(value) } : { ...record, value } },
      };
    },
    'layout.panel.place': ({ panel, left, top, width, height }) => {
      state.layout = { ...state.layout, panels: state.layout.panels.map(entry => (entry.id === panel ? { id: panel, rect: { left, top, width, height } } : entry)) };
    },
    'layout.section.open': ({ section, open }) => {
      state.layout = { ...state.layout, sections: { ...state.layout.sections, [section]: open } };
    },
    'analysis.open': ({ analysis }) => {
      state.analysis = { ...state.analysis, docked: { ...state.analysis.docked, openMode: analysis } };
      state.layout = { ...state.layout, sections: { ...state.layout.sections, Analysis: true } };
    },
    'analysis.run': ({ analysis }) => {
      analysisRun++;
      let result;
      if (analysis === 'differential') result = differentialResult(random, dataset.genes, analysisRun);
      else if (analysis === 'markers') result = markersResult(random, dataset.genes, markerGroups, analysisRun);
      else if (analysis === 'correlation') result = correlationResult(random, correlationCells, analysisRun);
      else throw new RangeError(`The stress page runs no "${analysis}" analysis`);
      setAnalysis(analysis, { ...createResultEnvelope(analysis, result), provenance: provenanceOf(dataset, analysisRun) });
      return { rows: analysis === 'correlation' ? correlationCells * 2 : dataset.genes.length };
    },
  };
  /** Time spent in handlers (what the real page's implementations would spend instead). */
  const handlerTime = { total: 0, calls: 0 };
  for (const [type, handler] of Object.entries(handlers)) {
    dispatcher.provide(type, (params, ctx) => {
      const start = performance.now();
      try {
        return handler(params, ctx);
      } finally {
        handlerTime.total += performance.now() - start;
        handlerTime.calls++;
      }
    });
  }

  /** Parameters for one action of `kind`, drawn from the page as it is now. */
  const params = {
    camera: () => ['camera.set', { view: 'View 1', camera: camera(random) }],
    colorField: () => {
      const [key] = CATEGORICAL_FIELDS[Math.floor(random() * CATEGORICAL_FIELDS.length)];
      return ['color.by', { field: { source: 'obs', key } }];
    },
    colorGene: () => ['color.by', { field: { source: 'var', key: dataset.genes[Math.floor(random() * dataset.genes.length)] } }],
    colormap: () => ['color.continuous.colormap', {
      field: { source: 'obs', key: CONTINUOUS_FIELDS[Math.floor(random() * CONTINUOUS_FIELDS.length)] },
      colormap: COLORMAPS[Math.floor(random() * COLORMAPS.length)],
    }],
    filterCategory: () => {
      const [key, count] = CATEGORICAL_FIELDS[Math.floor(random() * CATEGORICAL_FIELDS.length)];
      const categories = categoriesOf(key, count).filter(() => random() < 0.2);
      return ['filter.category.visibility', {
        field: { source: 'obs', key }, categories: categories.length > 0 ? categories : [`${key} 0`], visible: random() < 0.4,
      }];
    },
    filterRange: () => {
      const min = random() * 50;
      return ['filter.continuous.range', {
        field: { source: 'obs', key: CONTINUOUS_FIELDS[Math.floor(random() * CONTINUOUS_FIELDS.length)] }, min, max: min + random() * 50,
      }];
    },
    brush: size => () => ['highlight.cells', { cells: randomCellSet(random, dataset.cells, size), label: `Brush ${groupCounter + 1}`, tool: 'lasso' }],
    removeOldestGroup: () => {
      const groups = state.highlights.pages[0].groups;
      return groups.length === 0 ? null : ['highlight.group.remove', { group: groups[0].label }];
    },
    toggleGroup: () => {
      const groups = state.highlights.pages[0].groups;
      if (groups.length === 0) return null;
      const group = groups[Math.floor(random() * groups.length)];
      return ['highlight.group.toggle', { group: group.label, enabled: !group.enabled }];
    },
    hideCells: () => {
      // A run of up to 10 000 cells (a tenth of a small dataset), somewhere.
      const size = Math.max(1, Math.min(10_000, Math.floor(dataset.cells / 10)));
      const start = Math.floor(random() * (dataset.cells - size));
      return ['cells.visibility.set', { cells: Uint32Array.from({ length: size }, (_, i) => start + i), visible: false }];
    },
    showAll: () => ['cells.visibility.set', { cells: null, visible: true }],
    labelEdit: () => {
      const [key, count] = CATEGORICAL_FIELDS[Math.floor(random() * 2)];
      const category = `${key} ${Math.floor(random() * count)}`;
      return ['category.rename', { field: { source: 'obs', key }, category, name: `${category} (renamed ${Math.floor(random() * 1e6)})` }];
    },
    userField: () => {
      const categories = ['in', 'out', 'border'];
      return ['field.push', {
        key: `user field ${userFieldCounter + 1}`, kind: 'categorical', categories, n_obs: dataset.cells, cells: null,
        values: Uint8Array.from({ length: dataset.cells }, () => Math.floor(random() * 4)),
      }];
    },
    setting: () => {
      const i = Math.floor(random() * SETTING_COUNT);
      return ['setting.set', { setting: `setting-${String(i).padStart(3, '0')}`, value: i % 3 === 0 ? random() < 0.5 : Math.round(random() * 1000) / 10 }];
    },
    panel: () => ['layout.panel.place', {
      panel: SECTIONS[Math.floor(random() * SECTIONS.length)], left: Math.round(random() * 1200), top: Math.round(random() * 800), width: 320, height: 480,
    }],
    section: () => ['layout.section.open', { section: SECTIONS[Math.floor(random() * SECTIONS.length)], open: random() < 0.5 }],
    analysisOpen: () => ['analysis.open', { analysis: ['markers', 'differential', 'correlation'][Math.floor(random() * 3)] }],
    differential: () => ['analysis.run', { analysis: 'differential' }],
    markers: () => ['analysis.run', { analysis: 'markers' }],
    correlation: () => ['analysis.run', { analysis: 'correlation' }],
  };

  return { state, domains, dispatcher, catalog: realCatalog, params, random, ownerTime, handlerTime, dataset };
}
