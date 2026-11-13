/**
 * @fileoverview Actions that choose which cells are shown: categories shown
 * or hidden (one by one, all, the cells without one, or only some cells of
 * one), a continuous field's visible range, the outlier filter, a filter
 * turned off or removed, and cells hidden one by one.
 *
 * Filters act on the view in focus, as the sidebar does. A categorical
 * filter may be on any categorical column, shown or not; a range or outlier
 * filter is set on the field the view is colored by, as the legend sets it.
 *
 * @module app/actions/definitions/filters
 */

import { defineAction } from '../catalog.js';
import { formatBound, formatCountOf, formatPercent } from '../../../utils/format-units.js';
import { PLAIN_QUOTE } from '../targets/names.js';
import {
  CATEGORY_FIELD, CATEGORY_LABEL, FIELD, SHOWN_FIELD_READS, VISIBLE_CELLS_READS,
  categoriesWords, fieldArgument, fieldCoalesceKey, fieldWords,
} from './params.js';

const FILTER_KINDS = Object.freeze(['category', 'continuous', 'outlier']);

const KIND_WORDS = Object.freeze({
  category: 'category filter',
  continuous: 'range filter',
  outlier: 'outlier filter',
});

/**
 * A range or outlier filter of the field the view in focus is colored by:
 * kept within the open cells' values (an outlier filter's quantiles are of
 * the open cells).
 */
const SHOWN_FIELD_VALUES_READS = Object.freeze([...SHOWN_FIELD_READS, 'cells']);

const FILTERED_FIELD = Object.freeze({
  ...FIELD,
  description: 'The field or gene whose filter it is, by name.',
});

export const filterActions = Object.freeze([
  defineAction({
    type: 'filter.category.visibility',
    title: 'Show or hide categories',
    summary: 'Show or hide the cells of one or more categories of a categorical column.',
    group: 'Filters',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'categories', 'visible'],
      properties: {
        field: CATEGORY_FIELD,
        categories: { type: 'array', minItems: 1, uniqueItems: true, items: CATEGORY_LABEL, description: 'Category labels as the legend shows them.' },
        visible: { type: 'boolean' },
      },
    },
    touches: ['filters'],
    reads: [],
    context: ['field-overlays', 'views'],
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `${p.visible ? 'Showed' : 'Hid'} ${categoriesWords(p.categories, quote)} of ${quote.bare(p.field.key)}`,
    code: p => `${p.visible ? 'show' : 'hide'}_categories(${JSON.stringify(p.field.key)}, [${p.categories.map(c => JSON.stringify(c)).join(', ')}])`,
  }),
  defineAction({
    type: 'filter.category.all',
    title: 'Show or hide every category',
    summary: 'Show or hide every category of a categorical column that has open cells, and the cells without a category.',
    group: 'Filters',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'visible'],
      properties: { field: CATEGORY_FIELD, visible: { type: 'boolean' } },
    },
    touches: ['filters'],
    // As the legend does: the categories with cells the view shows after the other filters.
    reads: VISIBLE_CELLS_READS.filter(input => input !== 'filters'),
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `${p.visible ? 'Showed' : 'Hid'} every category of ${quote.bare(p.field.key)}`,
    code: p => `${p.visible ? 'show' : 'hide'}_all_categories(${JSON.stringify(p.field.key)})`,
  }),
  defineAction({
    type: 'filter.category.missing',
    title: 'Show or hide cells without a category',
    summary: 'Show or hide the cells of a categorical column that have no category (the legend\'s Missing row).',
    group: 'Filters',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'visible'],
      properties: { field: CATEGORY_FIELD, visible: { type: 'boolean' } },
    },
    touches: ['filters'],
    reads: [],
    context: ['field-overlays', 'views'],
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `${p.visible ? 'Showed' : 'Hid'} the cells of ${quote.bare(p.field.key)} without a category`,
    code: p => `${p.visible ? 'show' : 'hide'}_missing(${JSON.stringify(p.field.key)})`,
  }),
  defineAction({
    type: 'filter.category.cell-count',
    title: 'Keep N cells of a category',
    summary: 'Show only `count` cells of one category, a random sample drawn with `seed` (the same seed and count show the same cells; a larger count adds cells); null shows all its cells again.',
    group: 'Filters',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'category', 'count'],
      properties: {
        field: CATEGORY_FIELD,
        category: CATEGORY_LABEL,
        count: { type: ['integer', 'null'], minimum: 0, description: 'How many of its cells stay shown; null for all of them.' },
        // A uint32, as a subsample's seed (`data/subsample.js`).
        seed: { type: 'integer', minimum: 0, maximum: 0xffffffff, default: 0, description: 'The sample\'s seed.' },
      },
    },
    touches: ['filters'],
    reads: [],
    context: ['field-overlays', 'views'],
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => (p.count === null
      ? `Showed every cell of ${quote.bare(p.category)} in ${quote.bare(p.field.key)}`
      : `Kept ${formatCountOf(p.count, 'cell')} of ${quote.bare(p.category)} in ${quote.bare(p.field.key)}`),
    code: p => `keep_cells(${JSON.stringify(p.field.key)}, ${JSON.stringify(p.category)}, ${p.count === null ? 'None' : p.count}${p.seed === undefined ? '' : `, seed=${p.seed}`})`,
  }),
  defineAction({
    type: 'filter.continuous.range',
    title: 'Set a visible range',
    summary: 'Show only the cells whose value of a continuous field or gene lies in [min, max]; the colors follow when they are rescaled to the range.',
    group: 'Filters',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'min', 'max'],
      properties: {
        field: { ...FILTERED_FIELD, description: 'The continuous field or gene the view in focus is colored by, by name.' },
        min: { type: 'number' },
        max: { type: 'number' },
      },
    },
    touches: ['filters', 'colors'],
    reads: [],
    context: SHOWN_FIELD_VALUES_READS,
    effect: 'state',
    // A slider drag is one step.
    coalesce: p => fieldCoalesceKey(p.field),
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Showed ${fieldWords(p.field, quote)} from ${formatBound(p.min)} to ${formatBound(p.max)}`,
    code: p => `visible_range(${fieldArgument(p.field)}, ${p.min}, ${p.max})`,
  }),
  defineAction({
    type: 'filter.continuous.reset',
    title: 'Reset a visible range',
    summary: 'Show every value of a continuous field or gene again.',
    group: 'Filters',
    params: {
      type: 'object', additionalProperties: false, required: ['field'],
      properties: { field: { ...FILTERED_FIELD, description: 'The continuous field or gene the view in focus is colored by, by name.' } },
    },
    touches: ['filters', 'colors'],
    reads: [],
    context: SHOWN_FIELD_VALUES_READS,
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Reset the visible range of ${fieldWords(p.field, quote)}`,
    code: p => `reset_range(${fieldArgument(p.field)})`,
  }),
  defineAction({
    type: 'filter.outlier',
    title: 'Filter outliers',
    summary: 'Hide the cells of each category that lie furthest from it in the latent space: those above the threshold quantile (1 hides none).',
    group: 'Filters',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'threshold'],
      properties: {
        field: { ...CATEGORY_FIELD, description: 'The categorical column the view in focus is colored by, by name.' },
        threshold: { type: 'number', minimum: 0, maximum: 1, description: 'The quantile above which cells are hidden; 1 hides none.' },
      },
    },
    touches: ['filters'],
    reads: ['cells', 'field-overlays', 'mapping'],
    context: ['active-field', 'views'],
    effect: 'state',
    coalesce: p => fieldCoalesceKey(p.field),
    describe: (p, outcome, quote = PLAIN_QUOTE) => (p.threshold >= 0.9999
      ? `Showed every outlier of ${quote.bare(p.field.key)}`
      : `Hid outliers of ${quote.bare(p.field.key)} above ${formatPercent(p.threshold * 100)}`),
    code: p => `outlier_filter(${JSON.stringify(p.field.key)}, ${p.threshold})`,
  }),
  defineAction({
    type: 'filter.enable',
    title: 'Turn a filter on or off',
    summary: 'Turn a field\'s category, range or outlier filter off (its settings kept) or on again.',
    group: 'Filters',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'kind', 'enabled'],
      properties: { field: FILTERED_FIELD, kind: { type: 'string', enum: [...FILTER_KINDS] }, enabled: { type: 'boolean' } },
    },
    touches: ['filters'],
    reads: [],
    context: ['field-overlays', 'mapping', 'views'],
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Turned the ${KIND_WORDS[p.kind]} of ${fieldWords(p.field, quote)} ${p.enabled ? 'on' : 'off'}`,
    code: p => `enable_filter(${fieldArgument(p.field)}, ${JSON.stringify(p.kind)}, ${p.enabled ? 'True' : 'False'})`,
  }),
  defineAction({
    type: 'filter.remove',
    title: 'Remove a filter',
    summary: 'Remove a field\'s category, range or outlier filter: every cell it hid is shown again.',
    group: 'Filters',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'kind'],
      properties: { field: FILTERED_FIELD, kind: { type: 'string', enum: [...FILTER_KINDS] } },
    },
    touches: ['filters', 'colors'],
    reads: [],
    context: ['field-overlays', 'mapping', 'views'],
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Removed the ${KIND_WORDS[p.kind]} of ${fieldWords(p.field, quote)}`,
    code: p => `remove_filter(${fieldArgument(p.field)}, ${JSON.stringify(p.kind)})`,
  }),
]);
