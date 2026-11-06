/**
 * @fileoverview The parameter schemas several areas name things with, and
 * the pure helpers that word them in labels and pseudocode. Each is defined
 * once here, so a field, a category, a colour, a set of cells, a view, an
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

import { formatCountOf } from '../../../utils/format-units.js';
import { PLAIN_QUOTE } from '../targets/names.js';

export const FIELD_SOURCES = Object.freeze(['obs', 'var']);

/**
 * What decides which cells the view in focus shows (its visibility): the open
 * cells and the cells genes are read for, the data mapping (a gene's values,
 * the latent space an outlier filter uses), the fields' values (user fields),
 * and the filters and hidden cells of the view in focus (`views`). An action
 * that takes the cells the view shows reads these (`reads`, `catalog.js`).
 */
export const VISIBLE_CELLS_READS = Object.freeze(['cells', 'mapping', 'field-overlays', 'filters', 'visibility', 'views']);

/**
 * What a setting of the field the view in focus is coloured by reads (a
 * continuous colour setting, a range or outlier filter): the field it names
 * (renames and user fields; a gene by the mapping's gene names), which must
 * be the one the view in focus (`views`) is coloured by (`active-field`).
 */
export const SHOWN_FIELD_READS = Object.freeze(['field-overlays', 'mapping', 'active-field', 'views']);

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
    source: { type: 'string', const: 'obs', description: 'Categories belong to columns of the cells.' },
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

/** A `#rrggbb` colour. */
export const COLOR = Object.freeze({
  type: 'string',
  pattern: '^#[0-9a-fA-F]{6}$',
  description: 'A colour as six hex digits, "#e41a1c".',
  examples: ['#e41a1c'],
});

/** Cells by original position (their 0-based row of `obs`). */
export const CELLS = Object.freeze({
  type: 'array', items: { type: 'integer', minimum: 0 }, 'x-cells': true, minItems: 1,
  description: 'Cells by original position (0-based row of obs), each once, in any order.',
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

/** The words a field is named with in a sentence: "cell_type", "gene CD3E". */
export function fieldWords(field, quote = PLAIN_QUOTE) {
  return field.source === 'var' ? `gene ${quote.bare(field.key)}` : quote.bare(field.key);
}

/** A pseudocode argument naming a field: `"cell_type"` or `gene="CD3E"`. */
export function fieldArgument(field) {
  return field.source === 'var' ? `gene=${JSON.stringify(field.key)}` : JSON.stringify(field.key);
}

/** "T cells", or "3 categories" past a few. */
export function categoriesWords(labels, quote = PLAIN_QUOTE) {
  if (labels.length === 1) return quote.bare(labels[0]);
  if (labels.length <= 3) return `${labels.slice(0, -1).map(quote.bare).join(', ')} and ${quote.bare(labels.at(-1))}`;
  return formatCountOf(labels.length, 'category', 'categories');
}

/** A coalescing key for steps on one field (a slider drag on its range). */
export function fieldCoalesceKey(field) {
  return `${field.source}:${field.key}`;
}
