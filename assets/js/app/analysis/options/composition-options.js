/**
 * @fileoverview The options of the Composition analysis.
 *
 * Context (`ui/analysis-types/composition-ui.js`):
 *   categoricalFields  [{key, name, categoryCount}] (categoryCount null
 *                      until the field is read)
 *   colorField         the key of the categorical field the cells are
 *                      coloured by, or null
 *   pages              [{id, name}] the highlight pages
 *   groupsFor(entry, record)  the cell types of the chosen field
 *
 * @module analysis/options/composition-options
 */

import { defineOptions } from './option-schema.js';

/** Field names that read as the sample (replicate) of a cell. */
export const SAMPLE_FIELD_PATTERN = /sample|donor|patient|individual|library|batch/i;

function fieldChoices(context) {
  return (context?.categoricalFields ?? []).map(field => ({ value: field.key, label: field.name }));
}

/** None, or any field the other roles do not hold. */
function noneOrFieldExcept(...taken) {
  return (context, record) => [
    { value: '', label: 'None' },
    ...fieldChoices(context).filter(choice => !taken.some(key => record?.[key] === choice.value))
  ];
}

/** Field names that read as a cell type or cluster annotation. */
export const CELL_TYPE_FIELD_PATTERN = /cell.?type|annotation|cluster|leiden|louvain|subtype|label|lvl\d/i;

/**
 * The field of cell types: the coloring field when it is categorical; else
 * the first categorical field named like a cell type or cluster; else the
 * first that is not named like a sample; with two or more categories where
 * there is one.
 */
export function defaultCellTypeField(context) {
  const fields = context?.categoricalFields ?? [];
  if (fields.length === 0) return '';
  // The coloring field, unless it reads as samples (a view colored by donor).
  if (
    context.colorField &&
    !SAMPLE_FIELD_PATTERN.test(context.colorField) &&
    fields.some(field => field.key === context.colorField)
  ) {
    return context.colorField;
  }
  // A field whose categories are not read yet may well have several.
  const several = fields.filter(field => field.categoryCount === null || field.categoryCount >= 2);
  return (
    several.find(field => CELL_TYPE_FIELD_PATTERN.test(field.key))
    ?? several.find(field => !SAMPLE_FIELD_PATTERN.test(field.key))
    ?? several[0]
    ?? fields[0]
  ).key;
}

/**
 * The first field named like a sample, donor, patient, individual, library
 * or batch that is not the cell types' field; else none.
 */
export function defaultSampleField(context) {
  const cellTypes = defaultCellTypeField(context);
  return (context?.categoricalFields ?? [])
    .find(field => field.key !== cellTypes && SAMPLE_FIELD_PATTERN.test(field.key))?.key ?? '';
}

function cellChoices(context) {
  return [
    { value: 'all', label: 'All cells' },
    { value: 'visible', label: 'Visible cells' },
    ...(context?.pages ?? []).map(page => ({ value: `page:${page.id}`, label: page.name }))
  ];
}

export const compositionOptions = defineOptions({
  id: 'composition',
  groups: [
    { id: 'cells', title: 'Cells', tip: 'composition-cells' },
    { id: 'test', title: 'Test', tip: 'composition-test' },
    { id: 'display', title: 'Display', tip: 'composition-display' }
  ],
  options: [
    {
      key: 'cellTypes',
      kind: 'select',
      label: 'Cell types',
      tip: 'composition-cell-types',
      group: 'essentials',
      default: defaultCellTypeField,
      defaultText: 'The coloring field when it is not named like a sample, else the first categorical field named like a cell type or cluster, else the first not named like a sample',
      choices: fieldChoices,
      check: value => (value === '' ? 'Choose the field that holds the cell types' : null)
    },
    {
      key: 'samples',
      kind: 'select',
      label: 'Samples',
      tip: 'composition-samples',
      group: 'essentials',
      default: defaultSampleField,
      defaultText: 'The first other field named like sample, donor, patient, individual, library or batch; else None',
      choices: noneOrFieldExcept('cellTypes')
    },
    {
      key: 'condition',
      kind: 'select',
      label: 'Condition',
      tip: 'composition-condition',
      group: 'essentials',
      default: '',
      defaultText: 'None',
      choices: noneOrFieldExcept('cellTypes', 'samples')
    },
    {
      key: 'cells',
      kind: 'select',
      label: 'Cells',
      tip: 'composition-cells',
      group: 'cells',
      default: 'all',
      defaultText: 'All cells',
      choices: cellChoices
    },
    {
      key: 'onlyTypes',
      kind: 'groups',
      label: 'Only these cell types',
      tip: 'composition-only-types',
      group: 'cells',
      default: { mode: 'all' }
    },
    {
      key: 'method',
      kind: 'select',
      label: 'Test',
      tip: 'composition-test',
      group: 'test',
      default: 'logit',
      choices: [
        { value: 'logit', label: 'Logit proportions (propeller)' },
        { value: 'rank', label: 'Ranks of proportions' },
        { value: 'clr', label: 'Centred log-ratio' }
      ],
      when: record => record.samples !== '' && record.condition !== ''
    },
    {
      key: 'correction',
      kind: 'segmented',
      label: 'Multiple testing',
      tip: 'composition-correction',
      group: 'test',
      default: 'bh',
      choices: [
        { value: 'bh', label: 'BH' },
        { value: 'bonferroni', label: 'Bonferroni' }
      ],
      when: record => record.condition !== ''
    },
    {
      key: 'barsBy',
      kind: 'segmented',
      label: 'Bars per',
      tip: 'composition-display',
      group: 'display',
      default: 'sample',
      choices: [
        { value: 'sample', label: 'Sample' },
        { value: 'condition', label: 'Condition' }
      ],
      when: record => record.samples !== '' && record.condition !== ''
    },
    {
      key: 'order',
      kind: 'select',
      label: 'Cell type order',
      tip: 'composition-display',
      group: 'display',
      default: 'field',
      choices: [
        { value: 'field', label: 'As in the field' },
        { value: 'abundance', label: 'Most abundant first' },
        { value: 'change', label: 'Largest change first' }
      ]
    },
    {
      key: 'values',
      kind: 'segmented',
      label: 'Show',
      tip: 'composition-display',
      group: 'display',
      default: 'proportion',
      choices: [
        { value: 'proportion', label: 'Proportions' },
        { value: 'count', label: 'Cell counts' }
      ]
    }
  ]
});

/** Options that change only how a result is drawn, never what is computed. */
export const COMPOSITION_DISPLAY_OPTIONS = Object.freeze(['barsBy', 'order', 'values']);
