/**
 * @fileoverview Provenance and staleness for any step (History v2 §3.4).
 *
 * An action declares the inputs its result is computed from (`reads`, the
 * catalogue's result inputs): state domains, and `history` (another branch's
 * tip, which a kept view of a branch shows). A step records the value hash
 * of each as it was when it ran (`Step.reads`). A step R of any action is
 * **stale** at the head H when all three hold:
 * - what R made is still what H shows (`valuesAt(H)[d] === R.after[d]` for
 *   every domain R changed: a result replaced since is not stale, it is gone);
 * - an input it read differs now (`valuesAt(H)[r] !== R.reads[r]`, or the
 *   branch it showed has moved on);
 * - its **cause** is the first step after R on the path that changed that
 *   input ("Stale since step 23"), or none when the values differ with no
 *   step between (the cause was deleted).
 *
 * Stale is derived and never stored. The state a parameter's name resolves
 * in (the field names, the view in focus) is the action's name context
 * (`context`), never recorded: a rename or a focus change makes no result
 * less current. Result inputs and name context together make deleting a step
 * re-apply only the steps that depend on it (`history.js`).
 *
 * @module app/history/provenance
 */

import { pathTo } from './tree.js';

/**
 * The inputs a step records (`Step.reads`): each declared domain's hash as
 * shown before the action ran, and for `history` the branch tip it shows.
 *
 * @param {readonly string[]|null} declared - the definition's `reads`
 * @param {Record<string, string>} shown - domain → hash before the action
 * @param {{tracker: string, branch: string, tip: string}|null} branchTip - for a `history` input
 */
export function readsOf(declared, shown, branchTip = null) {
  const out = {};
  for (const input of declared ?? []) {
    if (input === 'history') {
      if (branchTip !== null) out.history = { ...branchTip };
    } else if (shown[input] !== undefined) {
      out[input] = shown[input];
    }
  }
  return out;
}

/**
 * Every stale step on the path from the root to `headId`, each with its
 * cause and the inputs that changed. One walk of the path: each step's
 * inputs are compared with the values at the head, and the cause found by
 * the last change of each input before the head.
 *
 * @param {object} tracker - live
 * @param {string} headId
 * @param {(branchTip: {tracker: string, branch: string, tip: string}) => boolean} [branchMoved] - whether a
 *   `history` input's branch has moved on (or gone)
 * @returns {Array<{step: object, cause: object|null, inputs: string[]}>}
 */
export function staleOnPath(tracker, headId, branchMoved = () => false) {
  const path = pathTo(tracker, headId);
  const values = {};
  for (const step of path) Object.assign(values, step.after);
  // For each domain, the steps on the path that changed it, in order.
  const changes = new Map();
  path.forEach((step, index) => {
    for (const domain of step.touches) {
      let list = changes.get(domain);
      if (list === undefined) changes.set(domain, list = []);
      list.push(index);
    }
  });
  const firstChangeAfter = (domain, index) => {
    const list = changes.get(domain);
    if (list === undefined) return null;
    // Binary search for the first change after `index`.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] <= index) lo = mid + 1; else hi = mid;
    }
    return lo < list.length ? list[lo] : null;
  };
  const out = [];
  path.forEach((step, index) => {
    const inputs = Object.keys(step.reads);
    if (inputs.length === 0 || step.status !== 'applied') return;
    if (step.touches.some(domain => values[domain] !== step.after[domain])) return;
    const changed = [];
    let cause = null;
    for (const input of inputs) {
      const differs = input === 'history' ? branchMoved(step.reads.history) : values[input] !== step.reads[input];
      if (!differs) continue;
      changed.push(input);
      if (input === 'history') continue;
      const at = firstChangeAfter(input, index);
      if (at !== null && (cause === null || at < cause)) cause = at;
    }
    if (changed.length > 0) out.push({ step, cause: cause === null ? null : path[cause], inputs: changed });
  });
  return out;
}
