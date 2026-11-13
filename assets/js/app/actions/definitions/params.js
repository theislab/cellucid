/**
 * @fileoverview The parameter schemas several areas name things with, and
 * the pure helpers that word them in labels and pseudocode. Each is defined
 * once here, so a field, a category, a color, a set of cells, a view, an
 * embedding and a highlight page read the same in every tool an agent sees.
 *
 * A field is `{source, key}`: `obs` for a column of the cells, `var` for a
 * gene, and its name as the app shows it (after a rename, the new name). A
 * category is its label as shown; a highlight page its name; a view
 * `"View N"` as the Compare views list numbers it; cells their original
 * positions. Nothing names a position in an inventory, so a step replays on
 * another dataset that has the same names. The names are resolved to the
 * open dataset's objects by `app/actions/targets/`.
 *
 * @module app/actions/definitions/params
 */

import { formatCountOf, formatPercent } from '../../../utils/format-units.js';
import { SUBSAMPLE_METHODS } from '../../../data/subsample.js';
import { PLAIN_QUOTE } from '../targets/names.js';

export const FIELD_SOURCES = Object.freeze(['obs', 'var']);

/**
 * What decides which cells the view in focus shows (its visibility): the open
 * cells and the cells genes are read for, the data mapping (a gene's values,
 * the latent space an outlier filter uses), the expression values a gene is
 * shown in (`expression`), the fields' values (user fields),
 * and the filters and hidden cells of the view in focus (`views`). An action
 * that takes the cells the view shows reads these (`reads`, `catalog.js`).
 */
export const VISIBLE_CELLS_READS = Object.freeze(['cells', 'mapping', 'expression', 'field-overlays', 'filters', 'visibility', 'views']);

/**
 * What a setting of the field the view in focus is colored by reads (a
 * continuous color setting, a range or outlier filter): the field it names
 * (renames and user fields; a gene by the mapping's gene names, its values
 * in the expression values shown, `expression`), which must be the one the
 * view in focus (`views`) is colored by (`active-field`).
 */
export const SHOWN_FIELD_READS = Object.freeze(['field-overlays', 'mapping', 'expression', 'active-field', 'views']);

/** A field (`obs`) or gene (`var`) by the name the app shows. */
export const FIELD = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['source', 'key'],
  description: 'A field by name: source "obs" for a column of the cells, "var" for a gene; key is the name as shown.',
  properties: {
    source: { type: 'string', enum: [...FIELD_SOURCES], description: '"obs" for a column of the cells, "var" for a gene.' },
    key: { type: 'string', minLength: 1, description: 'The field or gene name as the app shows it.' },
  },
  examples: [{ source: 'obs', key: 'cell_type' }],
});

/** A categorical column of the cells by name. */
export const CATEGORY_FIELD = Object.freeze({
  ...FIELD,
  description: 'A categorical column of the cells by name (source "obs").',
  properties: {
    // The const says it; a description here would repeat the field's own in every tool.
    source: { type: 'string', const: 'obs' },
    key: { type: 'string', minLength: 1, description: 'The column name as the app shows it.' },
  },
});

/** One category label as the legend shows it. */
export const CATEGORY_LABEL = Object.freeze({
  type: 'string',
  minLength: 1,
  description: 'A category label as the legend shows it.',
  examples: ['T cells'],
});

/** A `#rrggbb` color. */
export const COLOR = Object.freeze({
  type: 'string',
  pattern: '^#[0-9a-fA-F]{6}$',
  description: 'A color as six hex digits, "#e41a1c".',
  examples: ['#e41a1c'],
});

/** Cells by original position (their 0-based row of `obs`). */
export const CELLS = Object.freeze({
  type: 'array', items: { type: 'integer', minimum: 0 }, 'x-cells': true, minItems: 1,
  description: 'Cells by original position, each once, in any order: the 0-based row of obs in the order the data was given. A file prepare() wrote holds its rows in priority order, so a row of it read as stored is not that position: its obs["cellucid_original_position"] gives the row\'s (or pass obs names).',
  examples: [[0, 1, 2]],
});

/** A trimmed, non-empty name: what a panel shows and the app keeps. */
export const TRIMMED_NAME = '^\\S(?:.*\\S)?$';

/** A highlight page by its name. */
export const PAGE = Object.freeze({
  type: 'string', minLength: 1, pattern: TRIMMED_NAME,
  description: 'A highlight page, by its name as its tab shows it.',
  examples: ['Page 1'],
});

/** A view as the Compare views list numbers it (`app/actions/targets/views.js`). */
export const VIEW = Object.freeze({
  type: 'string', pattern: '^View [1-9][0-9]*$',
  description: 'A view: "View N" as the Compare views list numbers its rows (the live view is View 1 while it is shown, the kept views follow in the order they were kept).',
  examples: ['View 1'],
});

/**
 * The name a view is given (`view.rename`, `view.keep`): shown beside its
 * number in its row, on its pane and as its panel's title in a figure. Not
 * of the form "View N" (`checkViewLabel`, `app/actions/targets/views.js`).
 */
export const VIEW_NAME = Object.freeze({
  type: 'string', minLength: 1, pattern: TRIMMED_NAME,
  description: 'A name for the view, one line of text ("Early", "Day 7, treated"): its row and its pane show it beside its number ("2 · Early"), a figure\'s panel after its letter ("B. Early": the figure letters its panels A, B, … in order, so a name needs no letter of its own). Not "View N".',
  examples: ['Early'],
});

/** An embedding a view shows: an obsm array and the columns of it plotted. */
export const EMBEDDING = Object.freeze({
  type: 'object', additionalProperties: false, required: ['key', 'columns'],
  description: 'An embedding: the obsm array and the columns of it plotted.',
  properties: {
    key: { type: 'string', minLength: 1, description: 'The obsm key, "X_umap".' },
    columns: {
      type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, maxItems: 3, uniqueItems: true,
      description: 'The 0-based columns plotted, one per dimension.',
    },
  },
  examples: [{ key: 'X_umap', columns: [0, 1] }],
});

/**
 * Which cells an opening reads, as `cells.open` (the open dataset read again)
 * and `dataset.open` (another dataset opened) both take them: how many (an
 * exact `count` or a `fraction` of the dataset's cells, one of them), how
 * they are chosen and with which seed, and what the method needs. One
 * definition, so both take a subsample the same way; `cellsToOpenRequestOf`
 * (`app/actions/targets/cells-to-open.js`) checks them and makes the
 * reader's request (`data/anndata/subsample-plan.js`).
 */
export const CELLS_TO_OPEN = Object.freeze({
  count: {
    type: 'integer', minimum: 1,
    description: 'How many cells, exactly (at least 2; the dataset\'s count or more opens every cell). Not with fraction.',
  },
  fraction: {
    type: 'number', exclusiveMinimum: 0, maximum: 1,
    description: 'The share of the dataset\'s cells: 0.1 opens a tenth, 1 every cell. Not with count.',
  },
  method: {
    type: ['string', 'null'], enum: [...SUBSAMPLE_METHODS, null], default: null,
    description: 'How the cells are chosen; null for the file\'s default.',
  },
  seed: { type: ['integer', 'null'], minimum: 0, maximum: 0xffffffff, default: null, description: 'The subsample\'s seed; null for the file\'s.' },
  field: { type: 'string', minLength: 1, description: 'Stratified: the categorical column it is stratified by.' },
  allocation: { type: 'string', enum: ['proportional', 'balanced'], default: 'proportional', description: 'Stratified: how the cells are split over the categories.' },
  embedding: { type: 'string', minLength: 1, description: 'Spatial: the obsm embedding it thins.' },
});

/** Whether the parameters of `CELLS_TO_OPEN` name a size (`count` or `fraction`). */
export function namesCellsToOpen(params) {
  return params.count !== undefined || params.fraction !== undefined;
}

/** "10% of the cells", "56,195 cells": the size `CELLS_TO_OPEN` names, in a step's words. */
export function cellsToOpenWords(params) {
  const size = params.fraction === undefined
    ? formatCountOf(params.count, 'cell')
    : `${formatPercent(params.fraction * 100, { figures: 6 })} of the cells`;
  return `${size}${params.method === null || params.method === undefined ? '' : ` (${params.method})`}`;
}

/** `["fraction=0.1", "method=\"blocks\"", "seed=7"]`: the pseudocode arguments of `CELLS_TO_OPEN` given. */
export function cellsToOpenArguments(params) {
  return [
    params.count === undefined ? null : `count=${params.count}`,
    params.fraction === undefined ? null : `fraction=${params.fraction}`,
    params.method === null || params.method === undefined ? null : `method=${JSON.stringify(params.method)}`,
    params.seed === null || params.seed === undefined ? null : `seed=${params.seed}`,
  ].filter(argument => argument !== null);
}

/** The words a field is named with in a sentence: "cell_type", "gene CD3E". */
export function fieldWords(field, quote = PLAIN_QUOTE) {
  return field.source === 'var' ? `gene ${quote.bare(field.key)}` : quote.bare(field.key);
}

/** A pseudocode argument naming a field: `"cell_type"` or `gene="CD3E"`. */
export function fieldArgument(field) {
  return field.source === 'var' ? `gene=${JSON.stringify(field.key)}` : JSON.stringify(field.key);
}

/**
 * "T cells", or "3 categories" past a few; `noun` counts them as something
 * else ("4 groups" for the groups a field is grouped into).
 */
export function categoriesWords(labels, quote = PLAIN_QUOTE, noun = ['category', 'categories']) {
  if (labels.length === 1) return quote.bare(labels[0]);
  if (labels.length <= 3) return `${labels.slice(0, -1).map(quote.bare).join(', ')} and ${quote.bare(labels.at(-1))}`;
  return formatCountOf(labels.length, noun[0], noun[1]);
}

/** A coalescing key for steps on one field (a slider drag on its range). */
export function fieldCoalesceKey(field) {
  return `${field.source}:${field.key}`;
}
