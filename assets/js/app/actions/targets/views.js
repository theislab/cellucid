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
 * **A view's label.** A person or an agent can name a view (`view.rename`,
 * `view.keep`'s `name`): one line of plain text the viewer keeps with the
 * view (`getViewName`), shown beside its number wherever the view is shown
 * (its row and pane chip, a step's label, a figure's panel title). The
 * number stays the view's address: an action names a view "View N", so a
 * replay finds the same view whether or not the step that named it is
 * replayed, and a label never has to be unique. A label is a name someone
 * wrote, so a sentence quotes it (`viewWords`: marked as data for an agent).
 *
 * Pure: importable in Node (the action definitions use it).
 *
 * @module app/actions/targets/views
 */

import { ActionRefused } from '../dispatcher.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { PLAIN_QUOTE, quoteName } from './names.js';

const VIEW_NUMBER = /^View ([1-9][0-9]*)$/;
/** A label is one line with no space at either end (`TRIMMED_NAME`, `definitions/params.js`). */
const ONE_TRIMMED_LINE = /^\S(?:.*\S)?$/u;

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
export function viewNameInValue(index, liveHidden, labels = null) {
  const name = liveHidden ? (index === 0 ? 'the hidden live view' : viewNameAt(index - 1)) : viewNameAt(index);
  return viewWords(name, labels?.[index] ?? null);
}

/**
 * A view's name with its label, as a sentence says it: `View 2 "Early"`, or
 * `View 2` for a view with no label. `quote` is `describe`'s (plain for a
 * person, marked for an agent).
 * @param {string} name - "View N" (or "the hidden live view")
 * @param {string|null|undefined} label
 * @param {typeof PLAIN_QUOTE} [quote]
 * @returns {string}
 */
export function viewWords(name, label, quote = PLAIN_QUOTE) {
  return typeof label === 'string' ? `${quote.bare(name)} ${quote(label)}` : quote.bare(name);
}

/**
 * The label a person or an agent gave an open view, or null.
 * @param {{getViewName: (viewId: string) => string|null}} viewer
 * @param {string} viewId
 * @returns {string|null}
 */
export function viewLabelOf(viewer, viewId) {
  const label = viewer.getViewName(viewId);
  if (label !== null && typeof label !== 'string') throw new TypeError(`The label of view "${viewId}" must be text or null.`);
  return label;
}

/**
 * An action's outcome with the label of the view it acted on (`label`), so
 * its step says 'View 2 "Early"' (`viewWords`); unchanged for a view with no
 * label. Read the label before the action removes the view.
 * @template {object|null} T
 * @param {string|null} label - `viewLabelOf`
 * @param {T} outcome
 * @returns {T | (T & {label: string})}
 */
export function withViewLabel(label, outcome) {
  return label === null ? outcome : { ...(outcome ?? {}), label };
}

/**
 * Every value-ordered label (the live view first, as a per-view domain value
 * lists views), null for a view with none; null when no view has one.
 * @param {{views: Array<{name?: string}>}|null|undefined} viewsValue - The `views` domain's value
 * @returns {Array<string|null>|null}
 */
export function viewLabelsInValue(viewsValue) {
  const views = viewsValue?.views;
  if (!Array.isArray(views) || !views.some(view => typeof view?.name === 'string')) return null;
  return views.map(view => (typeof view?.name === 'string' ? view.name : null));
}

/**
 * A view label as given, checked: one line of text with no space at either
 * end, and not of the form "View N" (that is how views are numbered, so
 * "View 3" on View 2 would name two views at once).
 * @param {unknown} label
 * @returns {string}
 */
export function checkViewLabel(label) {
  if (typeof label !== 'string' || !ONE_TRIMMED_LINE.test(label)) {
    throw new ActionRefused('A view\'s name is one line of text with no space at either end.', { code: 'bad-name' });
  }
  if (VIEW_NUMBER.test(label)) {
    throw new ActionRefused(`${quoteName(label)} is how views are numbered; give the view another name, or none to number it again.`, { code: 'bad-name' });
  }
  return label;
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
