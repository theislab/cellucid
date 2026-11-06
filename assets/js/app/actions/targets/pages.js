/**
 * @fileoverview A highlight page by its name and a highlight group by its
 * label, as the Highlighting panel shows them, resolved to the open
 * dataset's current pages and groups; a name that does not resolve is
 * refused with one sentence that says what there is.
 *
 * @module app/actions/targets/pages
 */

import { ActionRefused } from '../dispatcher.js';
import { listNames, quoteName } from './names.js';

/**
 * The highlight page called `name`.
 * @param {object} state - DataState
 * @param {string} name
 */
export function resolvePage(state, name) {
  const pages = state.getHighlightPages();
  const matches = pages.filter(page => page.name === name);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new ActionRefused(`${matches.length} highlight pages are called ${quoteName(name)}; rename one of them first.`, { code: 'ambiguous-page' });
  }
  throw new ActionRefused(`There is no highlight page ${quoteName(name)}; the pages are ${listNames(pages.map(page => page.name))}.`, { code: 'no-such-page' });
}

/**
 * The highlight group labelled `label` on `page`.
 * @param {object} page
 * @param {string} label
 */
export function resolveGroup(page, label) {
  const matches = page.highlightedGroups.filter(group => group.label === label);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new ActionRefused(`${matches.length} highlights on page ${quoteName(page.name)} are called ${quoteName(label)}; remove one of them first.`, { code: 'ambiguous-group' });
  }
  if (page.highlightedGroups.length === 0) {
    throw new ActionRefused(`Page ${quoteName(page.name)} has no highlight ${quoteName(label)}; it has no highlights.`, { code: 'no-such-group' });
  }
  throw new ActionRefused(
    `Page ${quoteName(page.name)} has no highlight ${quoteName(label)}; its highlights are ${listNames(page.highlightedGroups.map(group => group.label))}.`,
    { code: 'no-such-group' },
  );
}
