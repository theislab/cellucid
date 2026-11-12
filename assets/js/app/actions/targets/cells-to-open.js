/**
 * @fileoverview The cells an opening reads, from the parameters `cells.open`
 * and `dataset.open` share (`CELLS_TO_OPEN`, `definitions/params.js`): checked
 * once here and made into the reader's cell subset request
 * (`data/anndata/subsample-plan.js`, `data/cell-subset-policy.js`), so both
 * refuse the same mistakes with the same sentence and open the same cells.
 *
 * A subsample asked for by name is exact (`strict`): a stratifying field or an
 * embedding the dataset lacks fails the opening, never another method in its
 * place (the tab's own request may meet datasets it was not chosen for; an
 * action's names one dataset).
 *
 * Pure: the cell count is handed in (null while the dataset is not open yet;
 * the reader then makes a fraction a count, `countFromFraction`).
 *
 * @module app/actions/targets/cells-to-open
 */

import { ActionRefused } from '../dispatcher.js';
import {
  DEFAULT_GRID_SIZE, FEWEST_OPEN_CELLS, FEWEST_OPEN_CELLS_REASON, countFromFraction,
} from '../../../data/subsample.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { namesCellsToOpen } from '../definitions/params.js';

function refuse(message) {
  return new ActionRefused(message, { code: 'bad-params' });
}

/** The method's settings the parameters give beyond their defaults. */
function settingsNamed(params) {
  return [
    ...['method', 'seed', 'field', 'embedding'].filter(key => params[key] !== undefined && params[key] !== null),
    ...(params.allocation === undefined || params.allocation === 'proportional' ? [] : ['allocation']),
  ];
}

/**
 * The request of an opening of another dataset (`dataset.open`): null when
 * the parameters name nothing of its cells (it opens with the cells the tab
 * opens datasets with), else `cellsToOpenRequestOf` them.
 *
 * @param {object} params
 * @returns {Readonly<Object>|null}
 */
export function openingCellsRequestOf(params) {
  if (!namesCellsToOpen(params) && settingsNamed(params).length === 0) return null;
  return cellsToOpenRequestOf(params, null);
}

/**
 * The cell subset request the parameters ask for: `{mode: 'all'}`, or an
 * exact subsample (`{mode: 'subsample', k | fraction, method?, seed?, …,
 * strict: true}`). Refused (one sentence) when count and fraction are both
 * given or neither, when the method's settings are given without a size, when
 * the size is under the fewest cells drawn, or a stratified subsample names no
 * field.
 *
 * @param {{count?: number, fraction?: number, method: string|null, seed: number|null,
 *   field?: string, allocation: string, embedding?: string}} params
 * @param {number|null} nObs - The dataset's cells, when it is open
 * @returns {Readonly<Object>}
 */
export function cellsToOpenRequestOf(params, nObs) {
  if (params.count !== undefined && params.fraction !== undefined) {
    throw refuse('Give how many cells to open as count or as fraction, not both.');
  }
  if (!namesCellsToOpen(params)) {
    const named = settingsNamed(params);
    throw refuse(named.length === 0
      ? 'A subsample names how many cells to open: count, or fraction.'
      : `A subsample names how many cells to open (count, or fraction) beside its ${named.join(' and ')}.`);
  }
  let size;
  if (params.fraction !== undefined) {
    if (params.fraction === 1) return Object.freeze({ mode: 'all' });
    size = nObs === null ? { fraction: params.fraction } : { k: countFromFraction(params.fraction, nObs) };
  } else {
    size = { k: params.count };
  }
  if (size.k !== undefined && nObs !== null && size.k >= nObs) return Object.freeze({ mode: 'all' });
  if (size.k !== undefined && size.k < FEWEST_OPEN_CELLS) {
    throw refuse(`Open at least ${formatCountOf(FEWEST_OPEN_CELLS, 'cell')}: ${FEWEST_OPEN_CELLS_REASON}.`);
  }
  const method = params.method;
  if (method === 'stratified' && params.field === undefined) {
    throw refuse('A stratified subsample names the categorical column it is stratified by (field).');
  }
  return Object.freeze({
    mode: 'subsample',
    ...(method === null ? {} : { method }),
    ...(params.seed === null ? {} : { seed: params.seed }),
    ...(method === 'stratified' ? { field: params.field, allocation: params.allocation } : {}),
    ...(method === 'spatial' ? { ...(params.embedding === undefined ? {} : { embedding: params.embedding }), gridSize: DEFAULT_GRID_SIZE } : {}),
    ...size,
    strict: true,
  });
}
