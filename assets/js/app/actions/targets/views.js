/**
 * @fileoverview The one owner of view names. A view is named `"View N"`, as
 * the Compare views list numbers its rows (the pill on each row, the chip on
 * each pane): the live view, while shown, is View 1, and the kept views
 * follow in the order they were kept. A step, a refusal, a timeline label, a
 * comparison line and an agent's read all say the same name for the same
 * view, so a person finds the view a step names under that number, and a
 * replay of the same steps names the same view again. Kept-view ids
 * (`snap_N`) are the viewer's own counters and never leave the page.
 *
 * A state domain's per-view value lists every view, the live view first even
 * while it is hidden (`app/state/domains/view-list.js`); `viewNameInValue`
 * names its entries the way the list numbers them.
 *
 * Pure: importable in Node (the action definitions use it).
 *
 * @module app/actions/targets/views
 */

import { ActionRefused } from '../dispatcher.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { quoteName } from './names.js';

const VIEW_NUMBER = /^View ([1-9][0-9]*)$/;

/**
 * The name of the view on the `position`-th row (from 0) of the Compare
 * views list.
 * @param {number} position
 * @returns {string}
 */
export function viewNameAt(position) {
  if (!Number.isSafeInteger(position) || position < 0) throw new RangeError(`A view position must be a whole number from 0, not ${position}.`);
  return `View ${position + 1}`;
}

/**
 * How a per-view domain value's entry is named (`index`: its position in the
 * value, the live view first; `liveHidden`: the live view is removed from the
 * list). The hidden live view has no row, so it is named as what it is.
 * @param {number} index
 * @param {boolean} liveHidden
 * @returns {string}
 */
export function viewNameInValue(index, liveHidden) {
  if (!liveHidden) return viewNameAt(index);
  return index === 0 ? 'the hidden live view' : viewNameAt(index - 1);
}

/**
 * The ids of the open views in the order the Compare views list shows them.
 * @param {{getLiveViewHidden: () => boolean, getSnapshotViews: () => Array<{id: string}>}} viewer
 * @returns {string[]}
 */
export function openViewIds(viewer) {
  const ids = viewer.getLiveViewHidden() ? [] : ['live'];
  for (const snapshot of viewer.getSnapshotViews()) ids.push(snapshot.id);
  return ids;
}

/**
 * The name of an open view ("View N").
 * @param {object} viewer
 * @param {string} viewId
 * @returns {string}
 */
export function viewNameOf(viewer, viewId) {
  const position = openViewIds(viewer).indexOf(viewId);
  if (position < 0) throw new RangeError(`View "${viewId}" is not open.`);
  return viewNameAt(position);
}

/** "View 1", "View 1 and View 2", "View 1 to View 4": the names of `count` open views. */
function namesOfOpenViews(count) {
  if (count === 1) return viewNameAt(0);
  return count === 2 ? `${viewNameAt(0)} and ${viewNameAt(1)}` : `${viewNameAt(0)} to ${viewNameAt(count - 1)}`;
}

/**
 * The id of the open view `name` names, or a refusal that says which views
 * there are.
 * @param {object} viewer
 * @param {string} name
 * @returns {string}
 */
export function resolveViewName(viewer, name) {
  const ids = openViewIds(viewer);
  const listed = `${formatCountOf(ids.length, 'view')} ${ids.length === 1 ? 'is' : 'are'} open (${namesOfOpenViews(ids.length)})`;
  const match = VIEW_NUMBER.exec(String(name));
  if (match === null) {
    throw new ActionRefused(`${quoteName(name)} names no view; ${listed}.`, { code: 'no-target' });
  }
  const number = Number(match[1]);
  if (number > ids.length) {
    // `name` is of the form "View N" here (`VIEW_NUMBER`): no text of anyone's.
    throw new ActionRefused(`There is no ${name}: ${listed}.`, { code: 'no-target' });
  }
  return ids[number - 1];
}
