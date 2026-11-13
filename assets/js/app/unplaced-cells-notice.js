/**
 * The short notice of cells an embedding or a vector field leaves out: a
 * cell whose row of the file is NaN (or infinite) has no position in that
 * embedding, or no vector in that field (`data/embedding-payload.js`). It
 * is not drawn in a view of that embedding (or is drawn without an arrow);
 * other views, filters and analyses keep it. The notice counts those cells
 * and names the first of them by their obs names.
 *
 * @module app/unplaced-cells-notice
 */

import { formatCount, formatCountOf } from '../utils/format-units.js';

/**
 * @param {{kind: 'layout'|'vectors', label: string, count: number, names: ReadonlyArray<string>, added?: boolean}} notice -
 *   `label`: the embedding or vector field as the app names it; `added`:
 *   the cells were added by an opening grown in place
 * @returns {string}
 */
export function unplacedCellsText({ kind, label, count, names, added = false }) {
  const one = count === 1;
  const cells = formatCountOf(count, added ? 'added cell' : 'cell');
  const more = count > names.length ? `, and ${formatCount(count - names.length)} more` : '';
  const named = names.length === 0 ? '' : `: ${names.join(', ')}${more}`;
  if (kind === 'vectors') {
    return `${cells} ${one ? 'has' : 'have'} no vector in ${label} (NaN or infinite in the file) and ${one ? 'is' : 'are'} drawn without an arrow${named}.`;
  }
  return `${cells} ${one ? 'has' : 'have'} no position in ${label} (NaN or infinite in the file) and ${one ? 'is' : 'are'} not drawn ` +
    `in views showing it${named}. Other views and analyses keep ${one ? 'it' : 'them'}.`;
}

/**
 * The notice of a vector field that shows no motion at all: every vector of
 * it, on the embedding it is drawn on, is shorter than the overlay draws
 * (`VELOCITY_STILL_SPEED`), so turning the overlay on changes nothing on the
 * screen. Said once, when the field is read.
 *
 * @param {{label: string, embedding: string, longest: number}} notice -
 *   `longest`: the longest vector's length as drawn
 * @returns {string}
 */
export function stillFieldText({ label, embedding, longest }) {
  const why = longest === 0
    ? 'every vector is zero'
    : `every vector is too short to draw (the longest is ${longest.toExponential(1)})`;
  return `No particle moves in ${label} on ${embedding}: ${why}.`;
}
