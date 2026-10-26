/**
 * @fileoverview The options of the Dot plot analysis.
 *
 * Context (`ui/analysis-types/dotplot-ui.js`):
 *   categoricalFields  [{key, name, categoryCount}]
 *   colorField         the categorical field the cells are coloured by, or null
 *   pages              [{id, name}] the highlight pages
 *   groupsFor(entry, record)  the groups of the chosen field
 *   getGenes(), getMarkerSets()  for the gene-set editor
 *   expressionMatrices the matrices the genes can be read from (as for marker genes)
 *
 * @module analysis/options/dotplot-options
 */

import { defineOptions } from './option-schema.js';
import { defaultCellTypeField } from './composition-options.js';
import { matrixOption } from './marker-options.js';

function fieldChoices(context) {
  return (context?.categoricalFields ?? []).map(field => ({ value: field.key, label: field.name }));
}

function cellChoices(context) {
  return [
    { value: 'all', label: 'All cells' },
    { value: 'visible', label: 'Visible cells' },
    ...(context?.pages ?? []).map(page => ({ value: `page:${page.id}`, label: page.name }))
  ];
}

export const dotplotOptions = defineOptions({
  id: 'dotplot',
  groups: [
    { id: 'groups', title: 'Groups and cells', tip: 'dotplot-groups' },
    { id: 'values', title: 'Values', tip: 'dotplot-values' },
    { id: 'layout', title: 'Layout', tip: 'dotplot-layout' }
  ],
  options: [
    {
      key: 'groupBy',
      kind: 'select',
      label: 'Group by',
      tip: 'dotplot-group-by',
      group: 'essentials',
      default: defaultCellTypeField,
      defaultText: 'The coloring field when it is not named like a sample, else the first categorical field named like a cell type or cluster, else the first not named like a sample',
      choices: fieldChoices,
      check: value => (value === '' ? 'Choose the field to group the cells by' : null)
    },
    {
      key: 'geneSets',
      kind: 'gene-sets',
      label: 'Genes',
      tip: 'dotplot-genes',
      group: 'essentials',
      default: [{ name: 'Set 1', genes: [] }],
      defaultText: 'One empty set'
    },
    {
      key: 'groups',
      kind: 'groups',
      label: 'Groups to show',
      tip: 'dotplot-groups',
      group: 'groups',
      default: { mode: 'all' }
    },
    {
      key: 'cells',
      kind: 'select',
      label: 'Cells',
      tip: 'dotplot-groups',
      group: 'groups',
      default: 'all',
      defaultText: 'All cells',
      choices: cellChoices
    },
    matrixOption('values'),
    {
      key: 'scale',
      kind: 'select',
      label: 'Color',
      tip: 'dotplot-values',
      group: 'values',
      default: 'none',
      choices: [
        { value: 'none', label: 'Mean expression' },
        { value: 'var', label: 'Mean, scaled 0–1 per gene' },
        { value: 'z', label: 'Mean, z-score per gene' }
      ]
    },
    {
      key: 'cutoff',
      kind: 'number',
      label: 'Expressed above',
      tip: 'dotplot-values',
      group: 'values',
      default: 0
    },
    {
      key: 'meanOnlyExpressing',
      kind: 'boolean',
      label: 'Mean of expressing cells only',
      tip: 'dotplot-values',
      group: 'values',
      default: false
    },
    {
      key: 'plot',
      kind: 'select',
      label: 'Plot',
      tip: 'dotplot-layout',
      group: 'layout',
      default: 'dot',
      choices: [
        { value: 'dot', label: 'Dot plot' },
        { value: 'matrix', label: 'Matrix plot' },
        { value: 'violin', label: 'Stacked violin' }
      ]
    },
    {
      key: 'swapAxes',
      kind: 'boolean',
      label: 'Genes down, groups across',
      tip: 'dotplot-layout',
      group: 'layout',
      default: false
    },
    {
      key: 'groupOrder',
      kind: 'select',
      label: 'Group order',
      tip: 'dotplot-layout',
      group: 'layout',
      default: 'field',
      choices: [
        { value: 'field', label: 'As in the field' },
        { value: 'size', label: 'Largest first' },
        { value: 'dendrogram', label: 'Dendrogram' }
      ]
    },
    {
      key: 'colorMap',
      kind: 'select',
      label: 'Color map',
      tip: 'dotplot-layout',
      group: 'layout',
      default: 'Reds',
      choices: [
        { value: 'Reds', label: 'Reds' },
        { value: 'Viridis', label: 'Viridis' },
        { value: 'Blues', label: 'Blues' }
      ]
    },
    {
      key: 'maxDotSize',
      kind: 'select',
      label: 'Largest dot',
      tip: 'dotplot-layout',
      group: 'layout',
      default: 'auto',
      choices: [
        { value: 'auto', label: 'Automatic' },
        { value: '12', label: '12 px' },
        { value: '18', label: '18 px' },
        { value: '24', label: '24 px' },
        { value: '32', label: '32 px' }
      ],
      when: record => record.plot === 'dot'
    }
  ]
});

/** Options that change only how a result is drawn, never what is computed. */
export const DOTPLOT_DISPLAY_OPTIONS = Object.freeze([
  'scale', 'meanOnlyExpressing', 'plot', 'swapAxes', 'groupOrder', 'colorMap', 'maxDotSize'
]);
