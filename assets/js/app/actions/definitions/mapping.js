/**
 * @fileoverview Actions on what is read and how: the data mapping (which
 * stored arrays are the embeddings, the genes, the neighbour graph, the
 * latent space and the vector fields), the cells open (a share of the
 * dataset), and how many of them genes are read for.
 *
 * `mapping.set` names only the groups it changes, each by the mapping's own
 * value, so a step that switched the expression matrix replays as that on
 * another dataset. `log1p` is a list of `{matrix, base}` here (the mapping
 * holds it keyed by matrix: `mappingChangesOf` / `mappingParamsOf` convert).
 *
 * @module app/actions/definitions/mapping
 */

import { defineAction } from '../catalog.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { SUBSAMPLE_METHODS } from '../../../data/subsample.js';

const EMBEDDING_REF = Object.freeze({
  type: 'object', additionalProperties: false, required: ['key', 'columns'],
  description: 'An obsm array and the columns of it plotted (null: as many first columns as its width allows).',
  properties: {
    key: { type: 'string', minLength: 1 },
    columns: { type: ['array', 'null'], items: { type: 'integer', minimum: 0 } },
  },
});

const SLOT_REF = Object.freeze({ ...EMBEDDING_REF, type: ['object', 'null'] });
const NULLABLE_KEY = Object.freeze({ type: ['string', 'null'], minLength: 1 });

/** Each mapping group as a parameter (snake case) and as the mapping's key. */
export const MAPPING_GROUP_PARAMS = Object.freeze([
  ['embeddings', 'embeddings'],
  ['knn', 'knn'],
  ['modality', 'modality'],
  ['gene_names', 'geneNames'],
  ['expression', 'expression'],
  ['log1p', 'log1p'],
  ['highly_variable', 'highlyVariable'],
  ['latent', 'latent'],
  ['vector_fields', 'vectorFields'],
]);

const GROUP_WORDS = Object.freeze({
  embeddings: 'embeddings',
  knn: 'neighbour graph',
  modality: 'modality',
  gene_names: 'gene names',
  expression: 'expression',
  log1p: 'log1p',
  highly_variable: 'highly variable genes',
  latent: 'latent space',
  vector_fields: 'vector fields',
});

/**
 * The mapping keys and values the parameters of `mapping.set` change.
 * @param {object} params
 * @returns {object}
 */
export function mappingChangesOf(params) {
  const changes = {};
  for (const [param, key] of MAPPING_GROUP_PARAMS) {
    if (!Object.hasOwn(params, param)) continue;
    changes[key] = param === 'log1p'
      ? Object.fromEntries(params.log1p.map(({ matrix, base }) => [matrix, { base }]))
      : structuredClone(params[param]);
  }
  return changes;
}

/**
 * The parameters of `mapping.set` that change the groups of `current` that
 * `next` differs in (the panel's Apply names only what it changes).
 * @param {object} current - The mapping shown
 * @param {object} next - The mapping asked for
 * @returns {object}
 */
export function mappingParamsOf(current, next) {
  const params = {};
  for (const [param, key] of MAPPING_GROUP_PARAMS) {
    if (!Object.hasOwn(next, key)) continue;
    if (Object.hasOwn(current, key) && JSON.stringify(current[key]) === JSON.stringify(next[key])) continue;
    params[param] = key === 'log1p'
      ? Object.entries(next.log1p).map(([matrix, entry]) => ({ matrix, base: entry.base }))
      : structuredClone(next[key]);
  }
  return params;
}

export const mappingActions = Object.freeze([
  defineAction({
    type: 'mapping.set',
    title: 'Change the data mapping',
    summary: 'Choose which stored arrays are the embeddings, neighbour graph, genes (modality, expression matrix, gene names, log1p, highly variable), latent space and vector fields; groups not named stay as they are. Applied as one change: refused, nothing changes.',
    group: 'Data',
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        embeddings: {
          type: 'object', additionalProperties: false, required: ['enabled', 'defaults'],
          description: 'The embeddings views can show, sorted by key then columns, and the default of each dimension.',
          properties: {
            enabled: { type: 'array', minItems: 1, items: EMBEDDING_REF },
            defaults: {
              type: 'object', additionalProperties: false, required: ['1d', '2d', '3d'],
              properties: { '1d': SLOT_REF, '2d': SLOT_REF, '3d': SLOT_REF },
            },
          },
        },
        knn: { ...NULLABLE_KEY, description: 'The obsp neighbour graph, or null for none.' },
        modality: { type: 'string', minLength: 1, description: 'The modality genes are read from (a dataset of several).' },
        gene_names: { type: 'string', minLength: 1, description: '"index", or "column:<var column>".' },
        expression: { type: ['string', 'null'], minLength: 1, description: '"X", "raw", "layer:<name>", or null for no genes.' },
        log1p: {
          type: 'array', description: 'Each expression matrix that holds log1p values, with its base (null: e).',
          items: {
            type: 'object', additionalProperties: false, required: ['matrix', 'base'],
            properties: { matrix: { type: 'string', minLength: 1 }, base: { type: ['number', 'null'] } },
          },
        },
        highly_variable: { ...NULLABLE_KEY, description: 'The boolean var column marking highly variable genes, or null.' },
        latent: { ...NULLABLE_KEY, description: 'The obsm latent space outlier filters use, or null.' },
        vector_fields: {
          type: 'array', description: 'Vector fields bound to enabled embeddings, sorted by embedding then key.',
          items: {
            type: 'object', additionalProperties: false, required: ['key', 'embedding'],
            properties: { key: { type: 'string', minLength: 1 }, embedding: EMBEDDING_REF },
          },
        },
      },
    },
    // A mapping change can close analysis windows, drop a gene's colouring,
    // change what views show and reset their cameras.
    touches: ['mapping', 'views', 'active-field', 'filters', 'colors', 'camera', 'analysis'],
    reads: [],
    effect: 'state',
    describe: p => {
      const groups = MAPPING_GROUP_PARAMS.map(([param]) => param).filter(param => Object.hasOwn(p, param));
      return groups.length === 0
        ? 'Applied the data mapping'
        : `Changed the data mapping: ${groups.map(group => GROUP_WORDS[group]).join(', ')}`;
    },
    code: p => {
      const parts = MAPPING_GROUP_PARAMS.map(([param]) => param).filter(param => Object.hasOwn(p, param))
        .map(param => `${param}=${JSON.stringify(p[param])}`);
      return `set_data_mapping(${parts.join(', ')})`;
    },
  }),
  defineAction({
    type: 'cells.open',
    title: 'Open a share of the cells',
    summary: 'Read the dataset again with every cell, or with exactly `count` cells chosen by a subsample method; highlights, labels, views and filters are kept for the cells still open.',
    group: 'Data',
    params: {
      type: 'object', additionalProperties: false, required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['all', 'subsample'] },
        count: { type: 'integer', minimum: 1, description: 'Subsample: how many cells.' },
        method: {
          type: ['string', 'null'], enum: [...SUBSAMPLE_METHODS, null], default: null,
          description: 'Subsample: how the cells are chosen; null for the file\'s default.',
        },
        seed: { type: ['integer', 'null'], minimum: 0, maximum: 0xffffffff, default: null, description: 'Subsample: its seed; null for the file\'s.' },
        field: { type: 'string', minLength: 1, description: 'Stratified: the categorical column it is stratified by.' },
        allocation: { type: 'string', enum: ['proportional', 'balanced'], default: 'proportional', description: 'Stratified: how the cells are split over the categories.' },
        embedding: { type: 'string', minLength: 1, description: 'Spatial: the obsm embedding it thins.' },
      },
    },
    // Reading the cells again carries what was made across by original cell
    // position: everything a cell can be named in.
    touches: ['cells', 'mapping', 'field-overlays', 'gene-sets', 'views', 'active-field', 'filters', 'colors',
      'visibility', 'highlights', 'camera', 'settings', 'analysis'],
    reads: [],
    effect: 'state',
    // Another share chosen while what was shown is still coming back replaces it.
    supersede: true,
    describe: p => (p.mode === 'all'
      ? 'Opened every cell'
      : `Opened ${formatCountOf(p.count, 'cell')}${p.method === null ? '' : ` (${p.method})`}`),
    code: p => (p.mode === 'all'
      ? 'open_cells("all")'
      : `open_cells(${p.count}${p.method === null ? '' : `, method=${JSON.stringify(p.method)}`}${p.seed === null ? '' : `, seed=${p.seed}`})`),
  }),
  defineAction({
    type: 'cells.read-genes',
    title: 'Read genes for more cells',
    summary: 'Read every gene for the first `cells` open cells (a dataset stored cell by cell reads genes for a sample of the open cells); stopping keeps what was read.',
    group: 'Data',
    params: {
      type: 'object', additionalProperties: false, required: ['cells'],
      properties: { cells: { type: 'integer', minimum: 1, description: 'How many of the open cells; more than are open reads every one.' } },
    },
    touches: ['cells'],
    reads: [],
    effect: 'state',
    describe: (p, outcome) => {
      const cells = outcome?.cells ?? p.cells;
      return `Read genes for ${formatCountOf(cells, 'cell')}${outcome?.stopped === true ? ' (stopped)' : ''}`;
    },
    code: p => `read_genes_for(${p.cells})`,
  }),
]);
