/**
 * @fileoverview Compare two branches side by side: one kept view per branch,
 * each showing what the selected view shows at the branch's last step, laid
 * out side by side, while the step shown stays where it is.
 *
 * It is made of the views' own actions (`app/actions/definitions/views.js`):
 * `view.keep` with the branch's name, once per branch, then `view.layout.set`
 * to the grid. So the comparison is steps of the history like any kept view
 * (undone together with one click per step), an agent compares branches the
 * same way, and nothing here publishes a view itself.
 *
 * @module ui/modules/state/compare
 */

import { trackerView } from './history-source.js';

/**
 * @param {{dispatch: (type: string, params: object) => Promise<{outcome: unknown}>}} options -
 *   the page's dispatcher (`getActions().dispatch`)
 * @returns {(history: object, branchA: string, branchB: string) => Promise<string[]>} the kept views' names
 *   (branches by id, of the tracker in use)
 */
export function createBranchComparison({ dispatch }) {
  if (typeof dispatch !== 'function') throw new TypeError('Comparing branches needs the action dispatcher.');
  return async function compareBranches(history, branchA, branchB) {
    const tracker = trackerView(history);
    const views = [];
    for (const id of [branchA, branchB]) {
      const branch = tracker?.branch(id);
      if (branch === undefined) throw new RangeError(`There is no branch "${id}"`);
      const { outcome } = await dispatch('view.keep', { branch: branch.name });
      views.push(outcome.view);
    }
    await dispatch('view.layout.set', { layout: 'grid' });
    return views;
  };
}
