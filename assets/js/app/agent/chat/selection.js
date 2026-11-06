/**
 * @fileoverview The person's selection, attached to a message of the chat:
 * a reference to the cells highlighted on the active highlight page (its
 * name, its groups and their counts), never the cells themselves. The agent
 * reads what it needs through the tools (`views.state` lists the pages and
 * their groups; the analyses take a page by its name), so what it is sent
 * of the cells follows the dataset's switch like any read
 * (`../data-scope.js`): the reference itself is names and counts only.
 *
 * Its names were written by the person or, in a shared session, by others:
 * the model is given them as data (`RESULT_DATA_TAGS`), as a tool result's.
 *
 * @module app/agent/chat/selection
 */

import { resultDataText } from '../bridge/relay-protocol.js';
import { formatCountOf } from '../../../utils/format-units.js';

/**
 * The selection shown now: the active highlight page's highlighted cells,
 * or null when none are highlighted.
 * @param {{getActivePage: Function, getTotalHighlightedCellCount: Function}} state
 * @returns {{page: string, cells: number, groups: Array<{name: string, cells: number, enabled: boolean}>}|null}
 */
export function selectionOf(state) {
  const page = state.getActivePage?.() ?? null;
  const cells = state.getTotalHighlightedCellCount?.() ?? 0;
  if (page === null || !Number.isSafeInteger(cells) || cells <= 0) return null;
  return {
    page: String(page.name),
    cells,
    groups: (page.highlightedGroups ?? []).map(group => ({
      name: String(group.label),
      cells: Number.isSafeInteger(group.cellCount) ? group.cellCount : (group.cellIndices?.length ?? 0),
      enabled: group.enabled !== false,
    })),
  };
}

/** Whether two selections are the same reference (page, count and groups). */
export function sameSelection(a, b) {
  if (a === null || b === null) return a === b;
  return a.page === b.page && a.cells === b.cells && a.groups.length === b.groups.length
    && a.groups.every((group, index) => group.name === b.groups[index].name && group.cells === b.groups[index].cells
      && group.enabled === b.groups[index].enabled);
}

/** The chip's words: "Selection: 1,234 cells". */
export function selectionLabel(selection) {
  return `Selection: ${formatCountOf(selection.cells, 'cell')}`;
}

/** The chip's longer description (its title and its remove button's name). */
export function selectionTitle(selection) {
  const groups = selection.groups.length === 0 ? '' : `, ${formatCountOf(selection.groups.length, 'group')}`;
  return `${formatCountOf(selection.cells, 'cell')} highlighted on the page "${selection.page}"${groups}`;
}

/**
 * What the model is told of an attached selection, with the person's
 * message: a reference, its names as data.
 * @param {{page: string, cells: number, groups: object[]}} selection
 */
export function selectionContext(selection) {
  return 'The person attached their selection: a reference to the cells highlighted on a highlight page, not the cells. '
    + 'Read what you need with the tools (the views read lists the pages and their groups; analyses take the page by its name): '
    + resultDataText(JSON.stringify({ page: selection.page, cells: selection.cells, groups: selection.groups }));
}

/**
 * The selection of a page's state, heard as it changes (`highlight:changed`,
 * `page:changed`).
 * @param {{on: (event: string, listener: Function) => (() => void)}|null} state
 */
export function createSelectionSource(state) {
  return Object.freeze({
    current: () => (state === null ? null : selectionOf(state)),
    subscribe(listener) {
      if (state === null || typeof state.on !== 'function') return () => {};
      const offs = ['highlight:changed', 'page:changed'].map(event => state.on(event, listener));
      return () => {
        for (const off of offs) if (typeof off === 'function') off();
      };
    },
  });
}
