/**
 * @fileoverview How an analysis is shown, as the action `analysis.view.set`
 * names it (`app/actions/definitions/analysis.js`): which disclosures of its
 * options form are open (`more`, the option `groups` open), and for the
 * marker genes and the gene signature what their result shows. It is part
 * of the analysis's settings (the `analysis` state domain), so a person's
 * change of it is a step like any other.
 *
 * Pure (importable in Node): the action definition, the analyses' UIs and
 * the marker heatmap's plot options read the same choices from here.
 *
 * @module analysis/options/analysis-views
 */

/** What the marker genes result shows. */
export const MARKER_SHOW_CHOICES = Object.freeze(['list', 'heatmap', 'clustered']);

/** The marker heatmap's look and clustering, each choice by its value (`plots/types/gene-heatmap.js`). */
export const HEATMAP_VIEW_CHOICES = Object.freeze({
  transform: Object.freeze(['zscore', 'log1p', 'none']),
  colorscale: Object.freeze(['RdBu', 'Viridis', 'Blues', 'YlOrRd', 'Greens']),
  distance: Object.freeze(['correlation', 'euclidean', 'cosine']),
  linkage: Object.freeze(['average', 'complete', 'single']),
});

/** The marker heatmap's clustering switches. */
export const HEATMAP_VIEW_SWITCHES = Object.freeze(['clusterRows', 'clusterCols']);

/** Every key of the marker heatmap's view. */
export const HEATMAP_VIEW_KEYS = Object.freeze([...Object.keys(HEATMAP_VIEW_CHOICES), ...HEATMAP_VIEW_SWITCHES]);

/**
 * The view keys an analysis takes: an analysis with an options form, its
 * disclosures; the marker genes, what the result shows, the group its
 * expanded table lists and the heatmap's look; the gene signature, the set
 * a result of one score per set shows.
 *
 * @param {{name: string, options: object|null}} mode - An `ANALYSIS_MODES` entry
 * @returns {string[]}
 */
export function viewKeysOf(mode) {
  const keys = mode.options === null ? [] : ['more', 'groups', 'plot'];
  if (mode.name === 'markers') keys.push('show', 'group', 'heatmap');
  if (mode.name === 'signature') keys.push('set');
  return keys;
}
