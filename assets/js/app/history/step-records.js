/**
 * @fileoverview A history's step records as the session file, the autosave
 * and its store keep them, in one place: which values a step names (the
 * history's own rule, `tree.js` `stepHashes`: before, after and every input
 * it read), every step of a tracker with those its Recently deleted holds,
 * and a step or a journal entry as stored, its parameters and outcome as
 * skeletons (`value-parts.js`).
 *
 * @module app/history/step-records
 */

import { stepHashes } from './tree.js';
import { splitValue } from './value-parts.js';

export { stepHashes };

/** Every step of a tracker (a record, or a live tracker with a map of steps), those its journal holds included. */
export function everyStep(tracker) {
  const steps = tracker.steps instanceof Map ? [...tracker.steps.values()] : [...tracker.steps];
  for (const entry of tracker.journal ?? []) {
    if (entry.purged) continue;
    steps.push(...entry.before.steps, ...entry.after.steps);
  }
  return steps;
}

/** A step as stored: its parameters and outcome as skeletons (arrays and parts gathered in `arrays`, `parts`). */
export async function storedStep(step, arrays, parts) {
  return { ...step, params: await splitValue(step.params, arrays, parts), outcome: await splitValue(step.outcome, arrays, parts) };
}

/** A journal entry as stored: the steps of both its patches as stored steps; a purged one as it is. */
export async function storedJournalEntry(entry, arrays, parts) {
  if (entry.purged) return entry;
  const side = async patch => {
    const steps = [];
    for (const step of patch.steps) steps.push(await storedStep(step, arrays, parts));
    return { ...patch, steps };
  };
  return { ...entry, before: await side(entry.before), after: await side(entry.after) };
}
