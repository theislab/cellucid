/**
 * @fileoverview The options of Correlation.
 *
 * Context (`CorrelationAnalysisUI._getOptionsContext`):
 *   variableExists(type, key)   whether the dataset has the variable
 *   createVariableControl(entry, value, onChange)  the X / Y picker
 *   categoricalFields           [{key}] (Colour by)
 *
 * Display options (re-drawn without reading again): colorBy.
 *
 * @module analysis/options/correlation-options
 */

import { defineOptions } from './option-schema.js';

export const CORRELATION_OPTIONS = defineOptions({
  id: 'correlation',
  groups: [
    { id: 'test', title: 'Test', tip: 'correlation-method' },
    { id: 'display', title: 'Display', tip: 'analysis-correlation' },
  ],
  options: [
    {
      key: 'variableX', kind: 'variable', label: 'X axis', tip: 'analysis-correlation', group: 'essentials',
      types: ['continuous_obs', 'gene_expression'], default: null,
    },
    {
      key: 'variableY', kind: 'variable', label: 'Y axis', tip: 'analysis-correlation', group: 'essentials',
      types: ['continuous_obs', 'gene_expression'], default: null,
    },
    {
      key: 'method', kind: 'segmented', label: 'Method', tip: 'correlation-method', group: 'test',
      default: 'pearson',
      choices: [
        { value: 'pearson', label: 'Pearson' },
        { value: 'spearman', label: 'Spearman' },
      ],
    },
    {
      key: 'colorBy', kind: 'select', label: 'Colour by', tip: 'analysis-correlation', group: 'display',
      default: '',
      defaultText: 'Page',
      choices: context => [
        { value: '', label: 'Page' },
        ...(context?.categoricalFields ?? []).map(field => ({ value: field.key, label: field.key })),
      ],
    },
  ],
});
