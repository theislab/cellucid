/**
 * The page surface a highlight-tool test stub needs now that Confirm is a
 * `highlight.cells` action (`ui/modules/highlight/highlight-actions.js`):
 * one shown page holding the groups the stub's `addHighlightDirect` makes,
 * a cell identity over every cell (original positions are positions), and
 * the action implementations provided on the page's dispatcher for the
 * test's duration.
 */
import { getActions } from '../../assets/js/app/actions/index.js';
import { provideHighlightActions } from '../../assets/js/app/ui/modules/highlight/highlight-actions.js';
import { createCellIdentity } from '../../assets/js/data/cell-identity.js';

/**
 * Give `state` (a stub with `pointCount` and `addHighlightDirect`) one shown
 * highlight page whose groups are what `addHighlightDirect` returned.
 * @template T
 * @param {T} state
 * @returns {T}
 */
export function withHighlightPage(state) {
  const groups = Array.isArray(state.savedGroups) ? state.savedGroups : [];
  const page = { id: 'page_1', name: 'Page 1', color: '#2563eb', highlightedGroups: groups };
  const add = state.addHighlightDirect;
  // Descriptors, not Object.assign: the cell identity follows the stub's
  // point count (a test may replace the dataset under the tools).
  Object.defineProperties(state, Object.getOwnPropertyDescriptors({
    ensureHighlightPage() {},
    getActivePage: () => page,
    getHighlightPages: () => [page],
    switchToPage: id => id === page.id,
    get cellIdentity() {
      return createCellIdentity({ nObs: state.pointCount });
    },
    addHighlightDirect(group) {
      const made = add.call(state, group);
      if (made !== null && typeof made === 'object' && !groups.includes(made)) groups.push(made);
      return made;
    },
  }));
  return state;
}

/**
 * Provide the highlight actions for `state` on the page's dispatcher; call
 * the result when the test ends.
 * @param {object} state
 * @returns {() => void}
 */
export function provideStubHighlightActions(state) {
  return provideHighlightActions({ state, actions: getActions() });
}

/** Wait for every dispatched action to finish (a dispatch starts a few hops later). */
export async function settleActions() {
  await new Promise(resolve => setTimeout(resolve, 0));
  await getActions().idle();
}
