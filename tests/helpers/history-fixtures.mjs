/**
 * A fake page for the history and its session file: four state domains
 * (highlights with cell sets, colors with a Float64Array, a camera holding
 * NaN, -0 and Infinity, a cell mask), three actions on them, a history over
 * them, and the dataset header a session file of them carries.
 */
import { historyActions } from '../../assets/js/app/actions/definitions/history.js';
import { createActionCatalog, defineAction } from '../../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../../assets/js/app/actions/domains.js';
import { createHistory } from '../../assets/js/app/history/history.js';
import { validateDataMapping } from '../../assets/js/data/data-mapping.js';

const MAPPING = validateDataMapping({
  kind: 'anndata',
  embeddings: { enabled: [{ key: 'X_umap', columns: [0, 1] }], defaults: { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null } },
  knn: null, geneNames: 'index', expression: 'X', log1p: {}, highlyVariable: null, latent: null, vectorFields: [],
});

export const HEADER = Object.freeze({
  createdAt: '2026-11-03T12:00:00.000Z',
  datasetFingerprint: {
    datasetId: 'demo', name: 'Demo', cellCount: 1000, varCount: 5,
    cellOrder: { embedding: { key: 'X_umap', columns: [0, 1] }, dimension: 2, digest: '0123456789abcdef' },
    dataMapping: MAPPING,
  },
  source: { kind: 'sample', dataset: 'demo' },
  requires: { obs: ['cell_type'], var: [] },
});

/** A page of four domains (highlights with cell sets, a color, a camera with NaN and -0, a mask) and three actions. */
export function page() {
  const state = {
    highlights: { groups: [] },
    colors: { by: 'cell_type', scale: new Float64Array([0, 0.5, 1]) },
    camera: { at: 0, unset: Number.NaN, zero: -0, far: Infinity },
    visibility: { hidden: new Uint8Array(0) },
  };
  const domains = createDomainRegistry();
  domains.provide('highlights', {
    capture: () => ({ groups: state.highlights.groups.map(group => ({ ...group })) }),
    restore: value => { state.highlights = { groups: value.groups.map(group => ({ ...group })) }; },
  });
  domains.provide('colors', { capture: () => ({ ...state.colors }), restore: value => { state.colors = { ...value }; } });
  domains.provide('camera', { capture: () => ({ ...state.camera }), restore: value => { state.camera = { ...value }; } });
  domains.provide('visibility', { capture: () => ({ ...state.visibility }), restore: value => { state.visibility = { ...value }; } });
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  return { state, domains };
}

const DEFINITIONS = [
  defineAction({
    type: 'highlight.cells', title: 'Highlight cells', summary: 'Keep cells as a group.', group: 'Highlights',
    params: {
      type: 'object', additionalProperties: false, required: ['label', 'cells'],
      properties: { label: { type: 'string', minLength: 1 }, cells: { type: 'array', items: { type: 'integer', minimum: 0 }, 'x-cells': true } },
    },
    touches: ['highlights'], reads: [], effect: 'state', describe: p => `Highlighted ${p.label}`, code: p => `highlight(${JSON.stringify(p.label)})`,
  }),
  defineAction({
    type: 'color.by', title: 'Color by', summary: 'Color by a field.', group: 'Colors',
    params: { type: 'object', additionalProperties: false, required: ['field'], properties: { field: { type: 'string' } } },
    touches: ['colors'], reads: [], effect: 'view', describe: p => `Colored by ${p.field}`, code: p => `color_by(${JSON.stringify(p.field)})`,
  }),
  defineAction({
    type: 'camera.set', title: 'Camera', summary: 'Place the camera.', group: 'Camera',
    params: { type: 'object', additionalProperties: false, required: ['at'], properties: { at: { type: 'number' } } },
    touches: ['camera'], reads: [], effect: 'view', coalesce: () => 'camera', describe: p => `Camera at ${p.at}`, code: p => `camera(${p.at})`,
  }),
];

export function setup({ withHistoryActions = false } = {}) {
  const { state, domains } = page();
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog(withHistoryActions ? [...DEFINITIONS, ...historyActions] : DEFINITIONS) });
  dispatcher.provide('highlight.cells', ({ label, cells }) => {
    state.highlights = { groups: [...state.highlights.groups, { label, cells: Uint32Array.from(cells) }] };
  });
  dispatcher.provide('color.by', ({ field }) => { state.colors = { ...state.colors, by: field }; });
  dispatcher.provide('camera.set', ({ at }) => { state.camera = { ...state.camera, at }; });
  let n = 0;
  let t = 1000;
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'demo', name: 'Demo', cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, now: () => ++t,
  });
  return { state, domains, dispatcher, history };
}

