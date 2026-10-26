/**
 * @fileoverview The options of Marker genes, and the test and gene-filter
 * options Differential expression shares with it.
 *
 * Context (`GenesPanelUI._getOptionsContext`):
 *   categoricalFields  [{key}] with two or more categories, in field order
 *   groupsFor(entry, record)  the categories of `record.groupBy` in scope:
 *                      [{id, name, count, color}], largest first
 *   groupsKnown(record)  false while those categories are still being read:
 *                      the reference group is then not checked against them
 *                      (a restored session keeps its reference)
 *   minCellsFor(entry, record)  `record.minCells`
 *   pages              [{id, name}] (the "Cells" choice)
 *   geneFamilyCounts   {mito, ribo, hemo}: genes each family matches
 *   hasHighlyVariable  whether the file marks highly variable genes
 *   expressionMatrices {choices: [{value, label}], reason}: the matrices the
 *                      genes can be read from (`DataLayer.getExpressionMatrices`)
 *
 * Display options (re-applied to a result without testing again): direction,
 * maxAdjP, minLog2FC, minPctIn, maxPctRef, rankBy, topN
 * (`genes-panel/marker-selection.js`).
 *
 * @module analysis/options/marker-options
 */

import { defineOptions } from './option-schema.js';
import { compileGenePattern, GENE_FAMILIES } from '../shared/gene-sets.js';
import { formatCount } from '../../../utils/format-units.js';


/**
 * "Expression matrix": the mapped matrix, or another of the file
 * (`DataLayer.getExpressionMatrices`, given as `context.expressionMatrices`).
 * Shared by Marker genes, Differential expression and Dot plot.
 */
export function matrixOption(group) {
  return {
    key: 'matrix', kind: 'select', label: 'Expression matrix', tip: 'analysis-expression-matrix', group,
    default: 'mapped',
    defaultText: 'The mapped matrix',
    choices: context => context?.expressionMatrices?.choices ?? null,
  };
}

/** Test options shared with Differential expression. */
export function testOptions(group) {
  return [
    {
      key: 'method', kind: 'select', label: 'Method', tip: 'analysis-test-options', group,
      default: 'wilcox',
      choices: [
        { value: 'wilcox', label: 'Wilcoxon rank-sum' },
        { value: 'ttest', label: 't-test (Welch)' },
        { value: 'ttest_overestim_var', label: 't-test, overestimated variance' },
      ],
    },
    {
      key: 'pConvention', kind: 'select', label: 'Wilcoxon p-values', tip: 'analysis-wilcoxon-p', group,
      default: 'exact',
      when: record => record.method === 'wilcox',
      choices: [
        { value: 'exact', label: 'Exact or continuity-corrected (SciPy, R)' },
        { value: 'normal', label: 'Normal approximation (scanpy)' },
        { value: 'normal_tie', label: 'Normal, tie-corrected' },
      ],
    },
    {
      key: 'correction', kind: 'segmented', label: 'Multiple testing', tip: 'analysis-multiple-testing', group,
      default: 'bh',
      choices: [
        { value: 'bh', label: 'Benjamini–Hochberg' },
        { value: 'bonferroni', label: 'Bonferroni' },
      ],
    },
    matrixOption(group),
    {
      key: 'foldChange', kind: 'select', label: 'Fold change from', tip: 'analysis-fold-change', group,
      default: 'auto',
      choices: [
        { value: 'auto', label: 'Automatic' },
        { value: 'log1p', label: 'Undo log1p (scanpy)' },
        { value: 'stored', label: 'As stored' },
      ],
    },
  ];
}

/** Gene-filter options (which genes are tested) shared with DE. */
export function geneFilterOptions(group) {
  return [
    {
      key: 'excludeGenes', kind: 'flags', label: 'Exclude genes', tip: 'analysis-gene-filters', group,
      default: [],
      choices: context => Object.entries(GENE_FAMILIES).map(([value, family]) => ({
        value,
        label: `${family.label} (${formatCount(context?.geneFamilyCounts?.[value] ?? 0)})`,
      })),
    },
    {
      key: 'excludePattern', kind: 'text', label: 'Exclude pattern', tip: 'analysis-gene-filters', group,
      default: '',
      check: value => compileGenePattern(value).error,
    },
    {
      key: 'onlyGenes', kind: 'select', label: 'Only genes in', tip: 'analysis-gene-filters', group,
      default: 'all',
      defaultText: 'All genes',
      choices: context => [
        { value: 'all', label: 'All genes' },
        ...(context?.hasHighlyVariable ? [{ value: 'hvg', label: 'Highly variable' }] : []),
        { value: 'list', label: 'A gene list' },
      ],
    },
    {
      key: 'onlyGenesList', kind: 'text', label: 'Gene list', tip: 'analysis-gene-filters', group,
      default: '',
      when: record => record.onlyGenes === 'list',
    },
  ];
}

/** Choices of "Cells": every cell, the visible ones, or a page's. */
export function cellScopeChoices(context) {
  return [
    { value: 'all', label: 'All cells' },
    { value: 'visible', label: 'Visible cells' },
    ...(context?.pages ?? []).map(page => ({ value: `page:${page.id}`, label: page.name })),
  ];
}

export const MARKER_OPTIONS = defineOptions({
  id: 'genesPanel',
  groups: [
    { id: 'groups', title: 'Groups and cells', tip: 'analysis-groups-and-cells' },
    { id: 'test', title: 'Test', tip: 'analysis-test-options' },
    { id: 'filters', title: 'Filters', tip: 'analysis-filters' },
    { id: 'ranking', title: 'Ranking', tip: 'analysis-ranking' },
  ],
  options: [
    {
      key: 'groupBy', kind: 'select', label: 'Group by', tip: 'marker-genes-group-by', group: 'essentials',
      default: context => context?.categoricalFields?.[0]?.key ?? '',
      defaultText: 'The first categorical field with two or more categories',
      choices: context => (context?.categoricalFields ?? []).map(field => ({ value: field.key, label: field.key })),
    },
    {
      key: 'compareAgainst', kind: 'segmented', label: 'Compare against', tip: 'marker-genes-reference', group: 'essentials',
      default: 'rest',
      choices: [
        { value: 'rest', label: 'Rest' },
        { value: 'group', label: 'Group' },
      ],
    },
    {
      key: 'referenceGroup', kind: 'select', label: 'Reference group', tip: 'marker-genes-reference', group: 'essentials',
      default: '',
      defaultText: 'The largest group',
      when: record => record.compareAgainst === 'group',
      choices: (context, record) => (context?.groupsKnown?.(record) === false ? null : [
        { value: '', label: 'Largest group' },
        ...(context?.groupsFor?.(null, record) ?? []).map(group => ({ value: group.id, label: group.name })),
      ]),
    },
    {
      key: 'testGroups', kind: 'groups', label: 'Groups to test', tip: 'analysis-groups-and-cells', group: 'groups',
      default: { mode: 'all' },
    },
    {
      key: 'cells', kind: 'select', label: 'Cells', tip: 'analysis-groups-and-cells', group: 'groups',
      default: 'all',
      defaultText: 'All cells',
      choices: cellScopeChoices,
    },
    {
      key: 'restIncludes', kind: 'segmented', label: 'Rest includes', tip: 'analysis-groups-and-cells', group: 'groups',
      default: 'all',
      when: record => record.compareAgainst === 'rest' && record.testGroups.mode === 'subset',
      choices: [
        { value: 'all', label: 'All other cells' },
        { value: 'selected', label: 'Selected groups only' },
      ],
    },
    {
      key: 'minCells', kind: 'number', label: 'Min cells per group', tip: 'analysis-small-groups', group: 'groups',
      default: 10, min: 2, integer: true,
    },
    {
      key: 'smallGroups', kind: 'select', label: 'Small groups', tip: 'analysis-small-groups', group: 'groups',
      default: 'skip',
      choices: [
        { value: 'skip', label: 'Skip and list' },
        { value: 'pool', label: 'Pool into one group' },
        { value: 'test', label: 'Test anyway, flagged' },
      ],
    },
    ...testOptions('test'),
    {
      key: 'direction', kind: 'segmented', label: 'Direction', tip: 'analysis-filters', group: 'filters',
      default: 'up',
      choices: [
        { value: 'up', label: 'Up' },
        { value: 'down', label: 'Down' },
        { value: 'both', label: 'Both' },
      ],
    },
    {
      key: 'maxAdjP', kind: 'number', label: 'Max adjusted p', tip: 'analysis-filters', group: 'filters',
      default: 0.05, min: 0, max: 1,
    },
    {
      key: 'minLog2FC', kind: 'number', label: 'Min |log2FC|', tip: 'analysis-filters', group: 'filters',
      default: 0, min: 0,
    },
    {
      key: 'minPctIn', kind: 'number', label: 'Min % expressing in group', tip: 'analysis-filters', group: 'filters',
      default: 0, min: 0, max: 100,
    },
    {
      key: 'maxPctRef', kind: 'number', label: 'Max % in reference', tip: 'analysis-filters', group: 'filters',
      default: 100, min: 0, max: 100,
    },
    ...geneFilterOptions('filters'),
    {
      key: 'rankBy', kind: 'select', label: 'Rank by', tip: 'analysis-ranking', group: 'ranking',
      default: 'score',
      choices: [
        { value: 'score', label: 'Score (z or t)' },
        { value: 'padj', label: 'Adjusted p' },
        { value: 'log2fc', label: 'log2 fold change' },
        { value: 'auroc', label: 'AUROC' },
        { value: 'pct_diff', label: '% in group − % in reference' },
      ],
    },
    {
      key: 'topN', kind: 'number', label: 'Top genes per group', tip: 'analysis-ranking', group: 'ranking',
      default: 10, min: 1, integer: true,
    },
  ],
});
