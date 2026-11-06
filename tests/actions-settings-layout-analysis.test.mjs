/**
 * Settings, layout, analysis and the agent's reads as actions
 * (`app/actions/definitions/{settings,layout,analysis,reads,history}.js`):
 * what is defined, that the analysis actions are derived from the analyses'
 * own option schemas (a new option needs no action code), the settings'
 * domain partition, the history read, result provenance and staleness, and
 * the one renderer behind a figure download and a picture.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getActionCatalog } from '../assets/js/app/actions/index.js';
import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { exampleOf, schemaProblem } from '../assets/js/app/actions/schema.js';
import { analysisActions, optionParamSchema, optionsParamSchema } from '../assets/js/app/actions/definitions/analysis.js';
import { settingsActions } from '../assets/js/app/actions/definitions/settings.js';
import { layoutActions } from '../assets/js/app/actions/definitions/layout.js';
import { readActions } from '../assets/js/app/actions/definitions/reads.js';
import { historyActions } from '../assets/js/app/actions/definitions/history.js';
import { ANALYSIS_MODES, analysisModeNamed, analysisModeOfId } from '../assets/js/app/analysis/options/analysis-modes.js';
import { defineOptions } from '../assets/js/app/analysis/options/option-schema.js';
import { HEATMAP_VIEW_CHOICES, HEATMAP_VIEW_SWITCHES, viewKeysOf } from '../assets/js/app/analysis/options/analysis-views.js';
import { CONTROL_DOMAIN_IDS, SETTING_CONTROL_DOMAINS } from '../assets/js/app/state-serializer/ui-controls.js';
import { createHistory } from '../assets/js/app/history/history.js';
import {
  captureProvenance, describeProvenance, requireProvenance, staleReasons, visibleCellsNow,
} from '../assets/js/app/analysis/shared/result-provenance.js';
import { hashValue, typedArrayDigest } from '../assets/js/app/history/value-pool.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';

const catalog = getActionCatalog();

const B3_TYPES = {
  'setting.set': ['settings', 'views'],
  'layout.panel.float': ['layout'],
  'layout.panel.dock': ['layout'],
  'layout.panel.place': ['layout'],
  'layout.section.open': ['layout'],
  'layout.sidebar.show': ['layout'],
  'layout.sidebar.width': ['layout'],
  'layout.theme.set': ['layout'],
  'analysis.open': ['analysis', 'layout'],
  'analysis.close': ['analysis'],
  'analysis.pages.set': ['analysis'],
  'analysis.run': ['analysis'],
  // A window's place, size and fold are layout (History v2 §3.15.5); opening,
  // copying or closing one changes both what is analysed and the layout.
  'analysis.window.copy': ['analysis', 'layout'],
  'analysis.window.close': ['analysis', 'layout'],
  'analysis.window.place': ['layout'],
  'analysis.window.collapse': ['layout'],
  'analysis.view.set': ['analysis'],
  'analysis.quick.set': ['analysis'],
  'analysis.detailed.set': ['analysis'],
  'analysis.size.set': ['layout'],
};
const B3_READS = [
  'settings.list', 'layout.get', 'analysis.list', 'analysis.result', 'analysis.cancel', 'history.get',
  'dataset.summary', 'fields.list', 'field.categories', 'genes.search', 'cells.values', 'field.summary',
  'views.state', 'view.picture',
];

test('every settings, layout and analysis action touches exactly its domains; every read has a result schema', () => {
  for (const [type, touches] of Object.entries(B3_TYPES)) {
    const definition = catalog.get(type);
    assert.deepEqual([...definition.touches].sort(), [...touches].sort(), type);
    assert.notEqual(definition.effect, 'read', type);
  }
  for (const type of B3_READS) {
    const definition = catalog.get(type);
    assert.equal(definition.effect, 'read', type);
    assert.equal(definition.touches.length, 0, type);
    assert.notEqual(definition.result, null, `${type} says what it returns`);
  }
  for (const mode of ANALYSIS_MODES.filter(m => m.options !== null)) {
    assert.deepEqual(catalog.get(`analysis.${mode.name}.set`).touches, ['analysis']);
    assert.equal(catalog.get(`analysis.${mode.name}.get`).effect, 'read');
  }
});

test('each action applies its own example and labels it in a sentence and a line of pseudocode', () => {
  const ours = [...settingsActions, ...layoutActions, ...analysisActions, ...readActions, ...historyActions];
  assert.ok(ours.length >= 40);
  for (const definition of ours) {
    const example = exampleOf(definition.params);
    assert.equal(schemaProblem(definition.params, example), null, definition.type);
    const label = definition.describe(example, null);
    assert.equal(typeof label, 'string', definition.type);
    assert.ok(label.length > 0 && !label.includes('\n'), definition.type);
    const code = definition.code(example);
    assert.ok(typeof code === 'string' && code.length > 0 && !code.includes('\n'), definition.type);
  }
});

test('the analyses are listed once: each with options has its own schema, by its panel mode', async () => {
  const names = ANALYSIS_MODES.map(mode => mode.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(ANALYSIS_MODES.map(mode => mode.id)).size, names.length);
  for (const mode of ANALYSIS_MODES) {
    if (mode.options !== null) assert.equal(mode.options.id, mode.id, `${mode.name}'s schema is its mode's`);
    assert.equal(analysisModeNamed(mode.name), mode);
    assert.equal(analysisModeOfId(mode.id), mode);
  }
  // The panel offers exactly these modes (comparison-module.js ANALYSIS_SECTIONS).
  const source = await readFile(new URL('../assets/js/app/analysis/comparison-module.js', import.meta.url), 'utf8');
  const offered = [...source.matchAll(/\{ mode: '([A-Za-z]+)', title: '([^']+)'/g)].map(match => [match[1], match[2]]);
  assert.deepEqual(offered.map(([id]) => id).sort(), ANALYSIS_MODES.map(mode => mode.id).sort());
  for (const [id, title] of offered) assert.equal(analysisModeOfId(id).title, title, `${id} is titled the same`);
  // Every analysis UI with a Run button returns the registry's schema.
  for (const file of ['de-analysis-ui', 'genes-panel-ui', 'gene-signature-ui', 'correlation-analysis-ui', 'dotplot-ui', 'composition-ui']) {
    const ui = await readFile(new URL(`../assets/js/app/analysis/ui/analysis-types/${file}.js`, import.meta.url), 'utf8');
    assert.match(ui, /_resultTable\(result, top\)/, `${file} gives its result to an agent`);
  }
});

test('how an analysis is shown is one action: each analysis\'s view keys, named choices, and labels that say what changed', async () => {
  const view = catalog.get('analysis.view.set');
  assert.equal(view.effect, 'view');
  // Every analysis with an options form takes its disclosures; the marker genes and the signature their result's view.
  const viewed = ANALYSIS_MODES.filter(mode => viewKeysOf(mode).length > 0).map(mode => mode.name);
  assert.deepEqual(view.params.properties.analysis.enum, viewed);
  assert.deepEqual(viewed, ANALYSIS_MODES.filter(mode => mode.options !== null).map(mode => mode.name));
  assert.deepEqual(viewKeysOf(analysisModeNamed('markers')), ['more', 'groups', 'plot', 'show', 'group', 'heatmap']);
  assert.deepEqual(viewKeysOf(analysisModeNamed('signature')), ['more', 'groups', 'plot', 'set']);
  assert.deepEqual(viewKeysOf(analysisModeNamed('quick')), []);
  // The option groups a view opens are the analyses' own, by id.
  const groupIds = new Set(ANALYSIS_MODES.filter(mode => mode.options !== null).flatMap(mode => mode.options.groups.map(group => group.id)));
  assert.deepEqual(new Set(view.params.properties.view.properties.groups.items.enum), groupIds);
  // The heatmap's choices are the marker heatmap plot's own.
  const { default: heatmap } = await import('../assets/js/app/analysis/plots/types/gene-heatmap.js');
  for (const [key, values] of Object.entries(HEATMAP_VIEW_CHOICES)) {
    assert.deepEqual(heatmap.optionSchema[key].options.map(option => option.value).sort(), [...values].sort(), `heatmap ${key}`);
    assert.ok(values.includes(heatmap.defaultOptions[key]), `heatmap ${key} default`);
  }
  for (const key of HEATMAP_VIEW_SWITCHES) assert.equal(heatmap.optionSchema[key].type, 'checkbox', `heatmap ${key}`);
  assert.equal(schemaProblem(view.params, { analysis: 'markers', view: { heatmap: { colorscale: 'Viridis', clusterRows: false } } }), null);
  assert.match(schemaProblem(view.params, { analysis: 'markers', view: { heatmap: { colorscale: 'Rainbow' } } }), /must be one of/);
  assert.match(schemaProblem(view.params, { analysis: 'quick', view: {} }), /must be one of/);
  assert.equal(view.describe({ analysis: 'markers', view: { show: 'list' } }, null), 'Showed Marker genes as a list');
  assert.equal(view.describe({ analysis: 'dotplot', in: 2, view: { more: true } }, null), 'Opened More options of Dot plot in window 2');
  assert.equal(view.describe({ analysis: 'signature', view: { set: 'T cells' } }, null), 'Showed the gene set T cells in Gene signature');
  assert.equal(view.describe({ analysis: 'markers', view: { more: true, show: 'list' } }, null), 'Changed how Marker genes is shown');
  assert.equal(view.code({ analysis: 'markers', in: 'panel', view: { group: 'B cells' } }), 'analysis_view("markers", {"group":"B cells"})');
  // The plot an expanded view draws: its options by name (composition's Plot, a heatmap's Show values).
  assert.equal(schemaProblem(view.params, { analysis: 'composition', view: { plot: [{ option: 'view', value: 'bar' }] } }), null);
  assert.match(schemaProblem(view.params, { analysis: 'composition', view: { plot: [] } }), /at least 1/);
  assert.equal(view.describe({ analysis: 'markers', view: { plot: [{ option: 'showValues', value: true }] } }, null),
    'Set showValues to true in the plot of Marker genes');
  assert.notEqual(view.coalesce({ analysis: 'composition', in: 'panel', view: { plot: [{ option: 'view', value: 'bar' }] } }),
    view.coalesce({ analysis: 'composition', in: 'panel', view: { plot: [{ option: 'legendPosition', value: 'right' }] } }));
  // A burst of the same change is one step; another key is another step (its parameters still say all it changed).
  const key = params => view.coalesce(params);
  assert.equal(key({ analysis: 'markers', in: 'panel', view: { heatmap: { colorscale: 'Blues' } } }),
    key({ analysis: 'markers', in: 'panel', view: { heatmap: { colorscale: 'Greens' } } }));
  assert.notEqual(key({ analysis: 'markers', in: 'panel', view: { heatmap: { colorscale: 'Blues' } } }),
    key({ analysis: 'markers', in: 'panel', view: { heatmap: { transform: 'none' } } }));
  assert.notEqual(key({ analysis: 'markers', in: 'panel', view: { more: true } }), key({ analysis: 'markers', in: 1, view: { more: true } }));
  // An analysis sent another's genes opens with them in one step.
  const set = catalog.get('analysis.signature.set');
  assert.equal(set.describe({ options: { geneSets: [] }, show: true }, null), 'Opened Gene signature with geneSets');
  assert.equal(set.code({ in: 'panel', options: {}, show: true }), 'analysis_set("signature", {}, show=True)');
  assert.notEqual(set.coalesce({ in: 'panel', options: { geneSets: [] }, show: true }), set.coalesce({ in: 'panel', options: { geneSets: [] }, show: false }));
  const collapse = catalog.get('analysis.window.collapse');
  assert.equal(collapse.effect, 'layout');
  assert.equal(collapse.describe({ window: 2, collapsed: true }, null), 'Collapsed analysis window 2');
  // The analyses without an options form name what they show by name too.
  const quick = catalog.get('analysis.quick.set');
  assert.equal(quick.describe({ categorical: ['cell_type'], continuous: [] }, null), 'Showed composition of cell_type and statistics of no fields in Quick');
  assert.notEqual(quick.coalesce({ categorical: [] }), quick.coalesce({ continuous: [] }));
  const detailed = catalog.get('analysis.detailed.set');
  assert.equal(detailed.describe({ variable: { type: 'gene_expression', key: 'CD3E' }, plot: 'violin' }, null), 'Plotted CD3E as a violin in Detailed');
  assert.equal(detailed.describe({ variable: null }, null), 'Plotted nothing in Detailed');
  const size = catalog.get('analysis.size.set');
  assert.equal(size.effect, 'layout');
  assert.equal(size.coalesce({ analysis: 'markers' }), size.coalesce({ analysis: 'markers' }));
  assert.equal(size.describe({ analysis: 'dotplot', expanded: { width: 1, height: 1, optionsWidth: 1, footerHeight: 1, statsWidth: 1 } }, null), 'Resized the expanded view of Dot plot');
  assert.match(schemaProblem(detailed.params, { plot_options: [{ option: 'nbins', value: [1, 2] }] }), /plot_options/);
  assert.equal(detailed.code({ in: 2, plot_options: [{ option: 'nbins', value: 20 }] }), 'analysis_detailed({"plot_options":[{"option":"nbins","value":20}]}, in_=2)');
});

test('analysis options become action parameters with no code: every option, typed by its kind', () => {
  for (const mode of ANALYSIS_MODES.filter(m => m.options !== null)) {
    const params = catalog.get(`analysis.${mode.name}.set`).params;
    assert.deepEqual(Object.keys(params.properties.options.properties), [...mode.options.keys], mode.name);
    // The defaults are valid parameters (what the form opens with is settable).
    for (const entry of mode.options.entries) {
      if (typeof entry.default === 'function') continue;
      assert.equal(schemaProblem(params.properties.options.properties[entry.key], entry.default), null, `${mode.name}.${entry.key}`);
    }
  }
  // A new option added to an analysis's schema is a parameter at once.
  const schema = defineOptions({
    id: 'probe', groups: [],
    options: [
      { key: 'level', kind: 'number', label: 'Level', tip: 'x', group: 'essentials', default: 2, min: 1, max: 9, integer: true },
      { key: 'how', kind: 'select', label: 'How', tip: 'x', group: 'essentials', default: 'a', choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { key: 'genes', kind: 'gene-sets', label: 'Genes', tip: 'x', group: 'essentials', default: [] },
      { key: 'x', kind: 'variable', label: 'X', tip: 'x', group: 'essentials', default: null, types: ['gene_expression'] },
      { key: 'groups', kind: 'groups', label: 'Groups', tip: 'x', group: 'essentials', default: { mode: 'all' } },
      { key: 'flags', kind: 'flags', label: 'Flags', tip: 'x', group: 'essentials', default: [], choices: [{ value: 'f', label: 'F' }] },
    ],
  });
  const derived = optionsParamSchema(schema);
  assert.deepEqual(Object.keys(derived.properties), ['level', 'how', 'genes', 'x', 'groups', 'flags']);
  assert.deepEqual(optionParamSchema(schema.entry('level')), { type: 'integer', description: 'Level', minimum: 1, maximum: 9 });
  assert.match(schemaProblem(derived, { level: 10 }), /at most 9/);
  assert.match(schemaProblem(derived, { how: 'c' }), /must be one of "a", "b"/);
  assert.equal(schemaProblem(derived, { groups: { mode: 'subset', ids: ['T cells'] }, x: { type: 'gene_expression', key: 'CD3E' } }), null);
  assert.match(schemaProblem(derived, { groups: { mode: 'some' } }), /matches none/);
  assert.match(schemaProblem(derived, { nope: 1 }), /has no parameter "nope"/);
});

test('setting.set covers every control of the inventory but the layout\'s, and touches each domain they are held in', () => {
  assert.deepEqual([...SETTING_CONTROL_DOMAINS].sort(), CONTROL_DOMAIN_IDS.filter(domain => domain !== 'layout').sort());
  assert.deepEqual([...catalog.get('setting.set').touches].sort(), [...SETTING_CONTROL_DOMAINS].sort());
});

test('a read is given a signal its caller can stop, and changes nothing', async () => {
  const reads = createActionCatalog([defineAction({
    type: 'probe.read', title: 't', summary: 's', group: 'g',
    params: { type: 'object', additionalProperties: false, properties: {} },
    reads: [], effect: 'read', describe: () => 'r', code: () => 'r()',
  })]);
  const dispatcher = createActionDispatcher({ catalog: reads });
  let seen = null;
  dispatcher.provide('probe.read', (_params, { signal }) => {
    seen = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  });
  // The handler starts once the dispatch is through its checks (a few microtasks): wait for it, however many.
  const started = async () => { while (seen === null) await Promise.resolve(); };
  const caller = new AbortController();
  const read = dispatcher.dispatch('probe.read', {}, { signal: caller.signal });
  await started();
  assert.ok(seen instanceof AbortSignal);
  caller.abort(new Error('closed'));
  await assert.rejects(read, /closed/);
  // Without a caller's signal it still has one.
  seen = null;
  dispatcher.dispatch('probe.read', {});
  await started();
  assert.ok(seen instanceof AbortSignal && !seen.aborted);
});

test('history.get reads the path to the step shown, or every branch, with who took each step and its pseudocode', async () => {
  const defs = [
    ...catalog.list().filter(d => d.type === 'history.get' || d.type === 'layout.theme.set' || d.type === 'setting.set'),
  ];
  const local = createActionCatalog(defs);
  const dispatcher = createActionDispatcher({ catalog: local });
  const domains = createDomainRegistry();
  const state = { theme: 'light', settings: { 'point-size': 1 } };
  domains.provide('layout', { capture: () => ({ theme: state.theme }), restore: v => { state.theme = v.theme; } });
  domains.provide('settings', { capture: () => structuredClone(state.settings), restore: v => { state.settings = structuredClone(v); } });
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  dispatcher.provide('layout.theme.set', ({ theme }) => { state.theme = theme; return { theme }; });
  dispatcher.provide('setting.set', ({ setting, value }) => {
    state.settings = { ...state.settings, [setting]: value };
    return { label: 'Point size', shown: String(value) };
  });
  let n = 0;
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'd', name: 'D', cellOrder: null }, newTrackerId: () => `t-00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, now: () => 1000,
  });
  await assert.rejects(dispatcher.dispatch('history.get', {}), /starts once the dataset is open/);
  await history.startTracker({ name: 'Main work' });
  await dispatcher.dispatch('layout.theme.set', { theme: 'dark' }, { origin: 'agent', agent: 'Claude', turn: 'turn-1' });
  await dispatcher.dispatch('setting.set', { setting: 'point-size', value: 3 });
  await history.undo();
  await dispatcher.dispatch('setting.set', { setting: 'point-size', value: 5 });

  const shown = (await dispatcher.dispatch('history.get', {})).outcome;
  assert.equal(schemaProblem(local.get('history.get').result, shown), null);
  assert.deepEqual(shown.steps.map(step => step.label), ['Opened', 'Chose the dark theme', 'Point size: set to 5']);
  assert.deepEqual(shown.steps.map(step => step.code), [null, 'set_theme("dark")', 'set_setting("point-size", 5)']);
  assert.deepEqual(shown.steps.map(step => [step.origin, step.agent, step.turn]), [
    ['startup', null, null], ['agent', 'Claude', 'turn-1'], ['user', null, null],
  ]);
  assert.equal(shown.head, shown.steps.at(-1).id);
  assert.deepEqual(shown.tracker, { id: 't-00000000-0000-4000-8000-000000000001', name: 'Main work' });
  assert.equal(shown.branches.length, 2);
  assert.equal(shown.branches.filter(branch => branch.active).length, 1);

  const all = (await dispatcher.dispatch('history.get', { all_branches: true })).outcome;
  assert.equal(schemaProblem(local.get('history.get').result, all), null);
  assert.equal(all.steps.length, 4);
  assert.deepEqual(all.steps.filter(step => !step.shown).map(step => step.label), ['Point size: set to 3']);
  assert.deepEqual([all.total, all.next], [4, null]);
  // A page at a time: the cursor is the last step of the page before; one that is not listed is refused.
  const first = (await dispatcher.dispatch('history.get', { all_branches: true, limit: 3 })).outcome;
  assert.equal(schemaProblem(local.get('history.get').result, first), null);
  assert.deepEqual([first.steps.length, first.total, first.next], [3, 4, first.steps[2].id]);
  const second = (await dispatcher.dispatch('history.get', { all_branches: true, limit: 3, cursor: first.next })).outcome;
  assert.deepEqual(second.steps.map(step => step.id), [all.steps[3].id]);
  assert.equal(second.next, null);
  assert.deepEqual([...first.steps, ...second.steps].map(step => step.id), all.steps.map(step => step.id));
  assert.deepEqual(shown.steps.map(step => [step.kind, step.squash, step.group]), [['root', null, null], ['action', null, null], ['action', null, null]]);
  await assert.rejects(dispatcher.dispatch('history.get', { cursor: 's99' }),
    { message: 'There is no step "s99" on the path to the step shown; start again without a cursor.', code: 'no-target' });
  history.destroy();
  assert.equal(dispatcher.provided('history.get'), false, 'the read goes with its history');
});

function fakeState({ kept = null, pages = [], mapping = { x: 1 } } = {}) {
  return {
    cellIdentity: createCellIdentity({ nObs: 10, kept: kept === null ? null : Uint32Array.from(kept) }),
    getHighlightPages: () => pages,
    getHighlightedCellCountForPage: id => pages.find(page => page.id === id)?.highlightedGroups
      .reduce((sum, group) => sum + group.cellIndices.length, 0) ?? 0,
    getDataMapping: () => mapping,
  };
}

test('a result records what it was computed on, and is stale exactly when that changes, saying what', async () => {
  const page = { id: 'page_1', name: 'T cells', highlightedGroups: [{ id: 'g', enabled: true, cellIndices: Uint32Array.of(1, 2) }] };
  const state = fakeState({ kept: [1, 2, 3, 4], pages: [page] });
  const dataset = { id: 'demo', method: 'uniform', seed: 7 };
  const inputs = { state, dataset, pageIds: ['page_1', 'restof__page_1'], options: { n: 1 }, genesReadFor: { cells: 2, of: 4 }, visible: null };
  const recorded = await captureProvenance(inputs);
  requireProvenance(structuredClone(recorded));
  assert.deepEqual(describeProvenance(recorded).pages, [{ name: 'T cells', cells: 2 }, { name: 'Rest of T cells', cells: null }]);
  assert.deepEqual(describeProvenance(recorded).cells, {
    open: 4, of: 10, share: 0.4, method: 'uniform', seed: 7, digest: state.cellIdentity.digest,
  });
  const now = async overrides => staleReasons(recorded, await captureProvenance({ ...inputs, ...overrides }));
  assert.deepEqual(await now({}), []);
  assert.deepEqual(await now({ genesReadFor: { cells: 2, of: 4 } }), []);
  assert.deepEqual(await now({ genesReadFor: null }), ['Genes are read for more cells since this result (2 cells then, every open cell now).']);
  assert.deepEqual(await now({ state: fakeState({ kept: [1, 2], pages: [page] }) }), [
    'The open cells changed since this result (4 cells then, 2 cells now).',
  ]);
  assert.deepEqual(await now({ state: fakeState({ kept: [1, 2, 3, 5], pages: [page] }) }), ['The open cells changed since this result.']);
  assert.deepEqual(await now({ state: fakeState({ kept: [1, 2, 3, 4], pages: [page], mapping: { x: 2 } }) }), ['The data mapping changed since this result.']);
  assert.deepEqual(await now({ options: { n: 2 } }), ['The settings changed since this result.']);
  assert.deepEqual(await now({ visible: Uint8Array.of(1, 0) }), ['The cells the view shows changed since this result.']);
  assert.deepEqual(await now({ dataset: { ...dataset, id: 'other' } }), ['This result was computed on another dataset.']);
  assert.deepEqual(await now({ pageIds: ['page_1'] }), ['The pages chosen changed since this result (T cells, Rest of T cells then, T cells now).']);
  // The page's cells change: the base page and its rest are both stale.
  page.highlightedGroups = [{ id: 'g', enabled: true, cellIndices: Uint32Array.of(1, 2, 3) }];
  assert.deepEqual(await now({}), ['The cells of T cells changed since this result.', 'The cells of Rest of T cells changed since this result.']);
  // A group switched off is a change of the page's cells.
  page.highlightedGroups = [{ id: 'g', enabled: false, cellIndices: Uint32Array.of(1, 2) }];
  assert.equal((await now({})).length, 2);
  // Digests are of content (another array of the same cells is the same input).
  page.highlightedGroups = [{ id: 'g', enabled: true, cellIndices: Uint32Array.of(1, 2) }];
  assert.deepEqual(await now({}), []);

  // One digest scheme: the history's. The mapping is named by the hash the
  // history keeps for the mapping domain's value, a page by its groups'
  // typed-array digests, the visible cells by theirs.
  assert.equal(recorded.mapping, await hashValue(structuredClone(state.getDataMapping())));
  assert.equal(recorded.pages[0].digest, await hashValue([page.highlightedGroups[0].cellIndices]));
  assert.match(recorded.pages[0].digest, /^[0-9a-f]{64}$/);
  const visible = Uint8Array.of(1, 1, 0, 1);
  assert.equal((await captureProvenance({ ...inputs, visible })).visible, await typedArrayDigest(visible));
  assert.match(await typedArrayDigest(visible), /^Uint8Array:4:[0-9a-f]{64}$/);
  // The inputs are taken when it is called: a change while the digests are computed is not in it.
  const mapping = { x: 1 };
  const moving = fakeState({ kept: [1, 2, 3, 4], pages: [page], mapping });
  const pending = captureProvenance({ ...inputs, state: moving });
  mapping.x = 3;
  assert.equal((await pending).mapping, recorded.mapping);
  // A malformed provenance from a file is refused by name.
  assert.throws(() => requireProvenance({ ...recorded, extra: 1 }), /extra/);
  assert.throws(() => requireProvenance({ ...recorded, cells: { ...recorded.cells, open: -1 } }), /open cells must be a count/);
});

test('the visible cells are copied once per change of the set, never per visibility pass', () => {
  const state = { categoryTransparency: Uint8Array.of(1, 1, 0, 1), _transparencyEpoch: 1 };
  const first = visibleCellsNow(state);
  assert.deepEqual([...first.cells], [1, 1, 0, 1]);
  assert.notEqual(first.cells, state.categoryTransparency, 'a copy: the transparency is written in place');
  assert.equal(visibleCellsNow(state).cells, first.cells, 'asked again, the same copy');
  // A pass that leaves the set as it was (a recolour): the same revision and copy.
  state._transparencyEpoch = 2;
  assert.deepEqual(visibleCellsNow(state), first);
  // The set changes in place: a new revision and a new copy; the earlier copy is kept as it was.
  state.categoryTransparency[2] = 1;
  state._transparencyEpoch = 3;
  const second = visibleCellsNow(state);
  assert.equal(second.revision, first.revision + 1);
  assert.deepEqual([...second.cells], [1, 1, 1, 1]);
  assert.deepEqual([...first.cells], [1, 1, 0, 1]);
  // Another array of the same cells is the same set.
  state.categoryTransparency = Uint8Array.of(1, 1, 1, 1);
  assert.equal(visibleCellsNow(state).revision, second.revision);
  assert.equal(visibleCellsNow({}), null);
});

test('a picture and a download are drawn by the one figure renderer', async () => {
  const source = await readFile(new URL('../assets/js/app/ui/modules/figure-export/figure-export-engine.js', import.meta.url), 'utf8');
  assert.equal(source.match(/renderFigureToPngBlob\(/g)?.length, 1, 'one PNG render call');
  assert.equal(source.match(/renderFigureToSvgBlob\(/g)?.length, 1, 'one SVG render call');
  assert.match(source, /async function renderFigure\(options, \{ viewId = null \} = \{\}\) \{[\s\S]*?await renderStaged\(/);
  assert.match(source, /async function runExport\(options, jobs\) \{[\s\S]*?await renderStaged\(options, jobs, \{ progress \}\)/);
  const renderFigure = source.slice(source.indexOf('async function renderFigure('));
  assert.doesNotMatch(renderFigure.slice(0, renderFigure.indexOf('\n  }\n')), /downloadBlob|notifications/, 'a picture is neither downloaded nor announced');
});
