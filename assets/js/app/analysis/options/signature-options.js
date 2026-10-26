/**
 * @fileoverview The options of Gene signature.
 *
 * Context (`GeneSignatureUI._getOptionsContext`):
 *   getGenes()       the dataset's gene names (matching and autocomplete)
 *   getMarkerSets()  one set per group of the last marker genes result, or null
 *
 * Display options (re-drawn without scoring again): plotType, rescale,
 * layout.
 *
 * @module analysis/options/signature-options
 */

import { defineOptions } from './option-schema.js';

export const SIGNATURE_METHODS = Object.freeze(['mean', 'median', 'mean_z', 'module', 'ucell']);

export const SIGNATURE_OPTIONS = defineOptions({
  id: 'signature',
  groups: [
    { id: 'scoring', title: 'Scoring', tip: 'signature-methods' },
    { id: 'display', title: 'Display', tip: 'analysis-signature' },
  ],
  options: [
    {
      key: 'geneSets', kind: 'gene-sets', label: 'Gene sets', tip: 'analysis-gene-sets', group: 'essentials',
      default: [{ name: 'Set 1', genes: [] }],
      defaultText: 'One empty set',
    },
    {
      key: 'method', kind: 'select', label: 'Method', tip: 'signature-methods', group: 'scoring',
      default: 'mean',
      choices: [
        { value: 'mean', label: 'Mean' },
        { value: 'median', label: 'Median' },
        { value: 'mean_z', label: 'Mean z-score' },
        { value: 'module', label: 'Module score (scanpy)' },
        { value: 'ucell', label: 'Rank-based (UCell)' },
      ],
    },
    {
      key: 'controlSize', kind: 'number', label: 'Control genes', tip: 'signature-methods', group: 'scoring',
      default: 50, min: 1, integer: true,
      when: record => record.method === 'module',
    },
    {
      key: 'bins', kind: 'number', label: 'Expression bins', tip: 'signature-methods', group: 'scoring',
      default: 25, min: 2, integer: true,
      when: record => record.method === 'module',
    },
    {
      key: 'seed', kind: 'number', label: 'Random seed', tip: 'signature-methods', group: 'scoring',
      default: 0, min: 0, integer: true,
      when: record => record.method === 'module',
    },
    {
      key: 'maxRank', kind: 'number', label: 'Max rank', tip: 'signature-methods', group: 'scoring',
      default: 1500, min: 1, integer: true,
      when: record => record.method === 'ucell',
    },
    {
      key: 'plotType', kind: 'select', label: 'Plot', tip: 'analysis-signature', group: 'display',
      default: 'violinplot',
      choices: [
        { value: 'violinplot', label: 'Violin plot' },
        { value: 'boxplot', label: 'Box plot' },
        { value: 'histogram', label: 'Histogram' },
      ],
    },
    {
      key: 'rescale', kind: 'select', label: 'Rescale', tip: 'analysis-signature', group: 'display',
      default: 'none',
      choices: [
        { value: 'none', label: 'None' },
        { value: 'zscore', label: 'z-score' },
        { value: 'minmax', label: '0–1' },
      ],
    },
    {
      key: 'layout', kind: 'segmented', label: 'Sets', tip: 'analysis-signature', group: 'display',
      default: 'side',
      choices: [
        { value: 'side', label: 'Side by side' },
        { value: 'each', label: 'One at a time' },
      ],
    },
  ],
});

export const SIGNATURE_DISPLAY_KEYS = Object.freeze(['plotType', 'rescale', 'layout']);
