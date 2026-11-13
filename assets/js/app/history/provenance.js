/**
 * @fileoverview Provenance and staleness for any step .
 *
 * An action declares the inputs its result is computed from (`reads`, the
 * catalog's result inputs): state domains, and `history` (another branch's
 * tip, which a kept view of a branch shows). A step records the value hash
 * of each as it was when it ran (`Step.reads`). A step R of any action is
 * **stale** at the head H when all three hold:
 * - what R made is still what H shows (`valuesAt(H)[d] === R.after[d]` for
 *   every domain R changed: a result replaced since is not stale, it is gone);
 * - an input it read differs now (`valuesAt(H)[r] !== R.reads[r]`, or the
 *   branch it showed has moved on);
 * - each input that changed has its own **cause**: the first step after R
 *   on the path that changed that input ("Filters changed at step 23"), or
 *   none when the values differ with no step between (the cause was
 *   deleted); R's cause is the earliest of them (the step a timeline marks it stale from).
 *   Each reason names its own input's cause, never one cause for all.
 *
 * An input held per view (the filters, hidden cells, coloring field and
 * views of each view) is compared at the view R acted in (the view in focus
 * when it ran): its owner's `readPart(value, views)` is that view's part,
 * and R is stale only when that part differs (`sameRead`). Keeping another
 * view, or changing another view's filters, changes the domain's value but
 * not the cells R used, so it makes no step stale.
 *
 * An input the action **captures** (`captures`: a keyframe holds the camera
 * it was saved at) is read, for replay, but its result never follows it: a
 * later change of it makes no step stale.
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
import { domainName } from '../actions/domains.js';
import { idNumber } from './model.js';

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
 * @param {{branchMoved?: (branchTip: {tracker: string, branch: string, tip: string}) => boolean,
 *   capturedOf?: (type: string) => readonly string[],
 *   sameRead?: (input: string, recorded: string, now: string|undefined, views: string|undefined) => boolean}} [options] -
 *   `branchMoved`: whether a `history` input's branch has moved on (or gone); `capturedOf`: the
 *   inputs an action captures (its definition's `captures`); `sameRead`: whether an input whose
 *   hash differs is still what the step read (the part of a per-view input at the view the step
 *   acted in, `views`: the `views` hash when it ran), hashes compared alone by default
 * @returns {Array<{step: object, cause: object|null, inputs: string[], causes: Record<string, object|null>}>}
 *   `causes`: each changed input's own cause (null for `history` and for a cause deleted)
 */
export function staleOnPath(tracker, headId, { branchMoved = () => false, capturedOf = () => [], sameRead = (input, recorded, now) => recorded === now } = {}) {
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
  // The `views` value each step ran with (before it): the view it acted in.
  let viewsBefore;
  path.forEach((step, index) => {
    const views = viewsBefore;
    if (Object.hasOwn(step.after, 'views')) viewsBefore = step.after.views;
    const captured = step.kind === 'action' ? capturedOf(step.type) : [];
    const inputs = Object.keys(step.reads).filter(input => !captured.includes(input));
    if (inputs.length === 0 || step.status !== 'applied') return;
    if (step.touches.some(domain => values[domain] !== step.after[domain])) return;
    const changed = [];
    const causes = {};
    let cause = null;
    for (const input of inputs) {
      const differs = input === 'history'
        ? branchMoved(step.reads.history)
        : values[input] !== step.reads[input] && !sameRead(input, step.reads[input], values[input], views);
      if (!differs) continue;
      changed.push(input);
      if (input === 'history') {
        causes.history = null;
        continue;
      }
      // The first step after it whose change of this input it no longer matches.
      let at = firstChangeAfter(input, index);
      while (at !== null && sameRead(input, step.reads[input], path[at].after[input], views)) at = firstChangeAfter(input, at);
      causes[input] = at === null ? null : path[at];
      if (at !== null && (cause === null || at < cause)) cause = at;
    }
    if (changed.length > 0) out.push({ step, cause: cause === null ? null : path[cause], inputs: changed, causes });
  });
  return out;
}

/**
 * Why a stale step is stale, one sentence per input that changed, each with
 * its own cause: "Filters changed at step 23 ("Hid Alpha in View 2")."
 * The one wording `history.stale`, `history.step` and the State panel give.
 *
 * @param {{inputs: string[], causes?: Record<string, object|null>}} entry - a `staleOnPath` entry
 * @param {{quote?: (text: string) => string}} [options] - how a step's label is quoted
 * @returns {string[]}
 */
export function staleReasons(entry, { quote = text => `"${text}"` } = {}) {
  return entry.inputs.map(input => {
    if (input === 'history') return 'The branch it shows has changed since.';
    const cause = entry.causes?.[input] ?? null;
    return cause === null
      ? `${domainName(input)} changed since (the step that changed it is no longer in the history).`
      : `${domainName(input)} changed at step ${idNumber(cause.id)} (${quote(cause.label)}).`;
  });
}
