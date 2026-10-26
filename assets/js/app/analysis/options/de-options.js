/**
 * @fileoverview The options of Differential expression.
 *
 * Context (`DEAnalysisUI._getOptionsContext`):
 *   pages              [{id, name}] (pages and their "rest of" pages)
 *   categoricalFields  [{key}] with two or more categories
 *   groupsFor(entry, record)  the categories of the field the option reads
 *                      (`field` for A and B, `withinField` for Within):
 *                      [{id, name, count, color}]
 *   geneFamilyCounts, hasHighlyVariable, expressionMatrices  as for marker genes
 *
 * Replicates: '' (cells are the observations) or a categorical sample
 * field: pseudobulk, each sample's cells of a group one observation
 * (`stats/pseudobulk.js`).
 *
 * Display options (the volcano re-drawn, nothing tested again): maxAdjP,
 * minLog2FC, minPct, labels.
 *
 * @module analysis/options/de-options
 */

import { defineOptions } from './option-schema.js';
import { cellScopeChoices, geneFilterOptions, testOptions } from './marker-options.js';

const pageChoices = context => (context?.pages ?? []).map(page => ({ value: page.id, label: page.name }));
const fieldChoices = context => (context?.categoricalFields ?? []).map(field => ({ value: field.key, label: field.key }));

export const DE_OPTIONS = defineOptions({
  id: 'differential',
  groups: [
    { id: 'cells', title: 'Cells', tip: 'analysis-groups-and-cells' },
    { id: 'test', title: 'Test', tip: 'analysis-test-options' },
    { id: 'filters', title: 'Filters', tip: 'analysis-filters' },
    { id: 'labels', title: 'Labels', tip: 'analysis-filters' },
  ],
  options: [
    {
      key: 'compare', kind: 'segmented', label: 'Compare', tip: 'analysis-differential', group: 'essentials',
      default: 'pages',
      choices: [
        { value: 'pages', label: 'Pages' },
        { value: 'categories', label: 'Categories' },
      ],
    },
    {
      key: 'pageA', kind: 'select', label: 'Group A', tip: 'analysis-differential', group: 'essentials',
      default: context => context?.pages?.[0]?.id ?? '',
      defaultText: 'The first page',
      when: record => record.compare === 'pages',
      choices: pageChoices,
    },
    {
      key: 'pageB', kind: 'select', label: 'Group B', tip: 'analysis-differential', group: 'essentials',
      default: context => context?.pages?.[1]?.id ?? context?.pages?.[0]?.id ?? '',
      defaultText: 'The second page',
      when: record => record.compare === 'pages',
      choices: pageChoices,
    },
    {
      key: 'field', kind: 'select', label: 'Field', tip: 'analysis-differential', group: 'essentials',
      default: context => context?.categoricalFields?.[0]?.key ?? '',
      defaultText: 'The first categorical field with two or more categories',
      when: record => record.compare === 'categories',
      choices: fieldChoices,
    },
    {
      key: 'categoriesA', kind: 'groups', label: 'Group A', tip: 'analysis-differential', group: 'essentials',
      default: { mode: 'subset', ids: [] },
      defaultText: 'None',
      when: record => record.compare === 'categories',
    },
    {
      key: 'categoriesB', kind: 'groups', label: 'Group B', tip: 'analysis-differential', group: 'essentials',
      default: { mode: 'subset', ids: [] },
      defaultText: 'None',
      when: record => record.compare === 'categories',
    },
    {
      key: 'within', kind: 'select', label: 'Within', tip: 'analysis-groups-and-cells', group: 'cells',
      default: 'all',
      defaultText: 'All cells',
      choices: context => [...cellScopeChoices(context), { value: 'category', label: 'Categories of a field' }],
    },
    {
      key: 'withinField', kind: 'select', label: 'Within field', tip: 'analysis-groups-and-cells', group: 'cells',
      default: context => context?.categoricalFields?.[0]?.key ?? '',
      defaultText: 'The first categorical field',
      when: record => record.within === 'category',
      choices: fieldChoices,
    },
    {
      key: 'withinCategories', kind: 'groups', label: 'Within categories', tip: 'analysis-groups-and-cells', group: 'cells',
      default: { mode: 'all' },
      when: record => record.within === 'category',
    },
    {
      key: 'minCells', kind: 'number', label: 'Min cells per group', tip: 'analysis-small-groups', group: 'cells',
      default: 10, min: 2, integer: true,
    },
    {
      key: 'replicates', kind: 'select', label: 'Replicates', tip: 'analysis-replicates', group: 'test',
      default: '',
      defaultText: 'None (cells)',
      choices: context => [
        { value: '', label: 'None (cells)' },
        ...(context?.categoricalFields ?? []).map(field => ({ value: field.key, label: field.key })),
      ],
    },
    // Pseudobulk is one test (Welch's t across samples): the cell-level
    // method and p-value convention apply only without replicates.
    ...testOptions('test').map(entry => (
      entry.key === 'method' || entry.key === 'pConvention'
        ? { ...entry, when: (record, context) => record.replicates === '' && (entry.when === undefined || entry.when(record, context)) }
        : entry
    )),
    {
      key: 'maxAdjP', kind: 'number', label: 'Max adjusted p', tip: 'analysis-filters', group: 'filters',
      default: 0.05, min: 0, max: 1,
    },
    {
      key: 'minLog2FC', kind: 'number', label: 'Min |log2FC|', tip: 'analysis-filters', group: 'filters',
      default: 1, min: 0,
    },
    {
      key: 'minPct', kind: 'number', label: 'Min % expressing in either group', tip: 'analysis-filters', group: 'filters',
      default: 0, min: 0, max: 100,
    },
    ...geneFilterOptions('filters'),
    {
      key: 'labels', kind: 'number', label: 'Labelled genes', tip: 'analysis-filters', group: 'labels',
      default: 15, min: 0, integer: true,
    },
  ],
});

/** Options that re-draw a DE result without testing again. */
export const DE_DISPLAY_KEYS = Object.freeze(['maxAdjP', 'minLog2FC', 'minPct', 'labels']);
