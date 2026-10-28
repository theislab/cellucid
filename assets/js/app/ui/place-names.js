/**
 * @fileoverview The names of the places in the sidebar that a message sends
 * someone to: its panels and the blocks in them, as their headings write
 * them.
 *
 * A message names a place from here, never in words of its own, and
 * `tests/ui-place-names-contract.test.mjs` holds every name to its heading
 * in `index.html` (a panel's `<summary>`, a block's `.section-title`), so a
 * renamed heading cannot leave a message naming what is no longer there.
 * A place the page builds itself (the legend's Visible range) takes its
 * heading from here too.
 *
 * @module ui/place-names
 */

/**
 * @param {string} name - The heading's text
 * @param {{panel?: string, heading?: string}} where - `panel`: the id of the
 *   panel's `<details>`; `heading`: the id of a block's heading
 */
function place(name, where) {
  return Object.freeze({ name, ...where });
}

export const PLACES = Object.freeze({
  // Panels.
  session: place('Session', { panel: 'session-section' }),
  visualization: place('Visualization', { panel: 'visualization-section' }),
  navigation: place('Navigation', { panel: 'navigation-section' }),
  compareViews: place('Compare views', { panel: 'compare-views-section' }),
  coloringFiltering: place('Coloring & filtering', { panel: 'coloring-filtering-section' }),
  highlighting: place('Highlighting', { panel: 'highlighted-cells-section' }),
  benchmark: place('Benchmark', { panel: 'benchmark-section' }),
  // Blocks of the Session panel.
  dataset: place('Dataset', { heading: 'dataset-facts-title' }),
  openData: place('Open data', { heading: 'open-data-title' }),
  dataMapping: place('Data mapping', { heading: 'data-mapping-title' }),
  sessionFile: place('Session file', { heading: 'session-state-title' }),
  // Blocks of the Visualization panel.
  performance: place('Performance', { heading: 'renderer-settings-title' }),
  vectorField: place('Vector field', { heading: 'vector-field-title' }),
  // Places the page builds itself, headed with these names: the legend's
  // range of a continuous field (`legend-renderer.js`), the community
  // annotation panel's columns (`community-annotation/controls-panel.js`).
  visibleRange: place('Visible range', {}),
  annotatedColumns: place('Annotated columns', {}),
});

/**
 * A path to a place, as `Session › Data mapping`.
 *
 * @param {...{name: string}} places - Outermost first
 * @returns {string}
 */
export function placePath(...places) {
  return places.map(entry => entry.name).join(' › ');
}
