/**
 * @fileoverview The options of the Composition analysis.
 *
 * Context (`ui/analysis-types/composition-ui.js`):
 *   categoricalFields  [{key, name, categoryCount}] (categoryCount null
 *                      until the field is read)
 *   colorField         the key of the categorical field the cells are
 *                      colored by, or null
 *   pages              [{id, name}] the highlight pages
 *   groupsFor(entry, record)  the cell types of the chosen field
 *
 * @module analysis/options/composition-options
 */

import { CELL_SCOPE_MEANS, defineOptions } from './option-schema.js';
import { identityField, sampleField, sampleFieldRank } from '../../utils/field-roles.js';

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

/**
 * The field of cell types: the coloring field when it is categorical and not
 * named like a sample; else the best-ranked identity name (cell type,
 * annotation, lineage, cluster: `utils/field-roles.js`); else the first not
 * named like a sample, an id or a quality flag; with two or more categories
 * where there is one.
 */
export function defaultCellTypeField(context) {
  const fields = context?.categoricalFields ?? [];
  if (fields.length === 0) return '';
  // The coloring field, unless it reads as samples (a view colored by donor).
  if (
    context.colorField &&
    sampleFieldRank(context.colorField) === null &&
    fields.some(field => field.key === context.colorField)
  ) {
    return context.colorField;
  }
  return identityField(fields);
}

/**
 * The best-ranked field named like a donor, patient, sample, library or
 * batch (`utils/field-roles.js` `SAMPLE_FIELD_TIERS`) that is not the cell
 * types' field; else none.
 */
export function defaultSampleField(context) {
  return sampleField(context?.categoricalFields ?? [], defaultCellTypeField(context));
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
      defaultText: 'The coloring field when it is not named like a sample, else the best field named like a cell type, annotation, lineage or cluster, else the first not named like a sample',
      choices: fieldChoices,
      check: value => (value === '' ? 'Choose the field that holds the cell types' : null)
    },
    {
      key: 'samples',
      kind: 'select',
      label: 'Samples',
      tip: 'composition-samples',
      group: 'essentials',
      means: 'a sample or donor field: the replicate the tests run across (empty: none)',
      default: defaultSampleField,
      defaultText: 'The other field named most like a donor, patient, sample, library or batch, in that order; else None',
      choices: noneOrFieldExcept('cellTypes')
    },
    {
      key: 'condition',
      kind: 'select',
      label: 'Condition',
      tip: 'composition-condition',
      group: 'essentials',
      means: 'a categorical field whose groups are compared (bin a continuous one such as age into a field first; empty: no test)',
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
      means: CELL_SCOPE_MEANS,
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
      means: 'logit: Welch\'s t or ANOVA of logit proportions across samples (propeller without moderation); rank: Wilcoxon or Kruskal–Wallis; clr: centered log-ratios',
      default: 'logit',
      choices: [
        { value: 'logit', label: 'Logit proportions (propeller)' },
        { value: 'rank', label: 'Ranks of proportions' },
        { value: 'clr', label: 'Centered log-ratio' }
      ],
      when: record => record.samples !== '' && record.condition !== ''
    },
    {
      // The same donors in both conditions (two organs of one fetus): each
      // donor's difference (`stats/composition-tests.js`).
      key: 'paired',
      kind: 'boolean',
      label: 'Pair samples across conditions',
      tip: 'composition-paired',
      group: 'test',
      means: 'true (two conditions, at least 3 samples in both): a sample with cells in both is a pair, others left out; each cell type tested over the pairs holding its cells, not tested in fewer than 3 (test: too few pairs); logit and clr: paired t-test (scipy ttest_rel), rank: Wilcoxon signed-rank. The result\'s about says how many samples are in both',
      default: false,
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
