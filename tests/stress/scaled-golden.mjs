/**
 * The golden history (`tests/fixtures/history-golden.cellucid-session`, the
 * session file cellucid-python and cellucid-r read) made longer, for timing
 * the packages' session readers at scale.
 *
 * The golden file is read with the web app's own reader (`readHistoryFile`),
 * the main branch of its first tracker gets `extraSteps` more steps after its
 * tip, and the history is written again with the web app's own writer
 * (`writeHistoryFile`), so the file is exactly what the app writes: steps,
 * parts and values cut into pieces, gzip or none per chunk, eager before lazy.
 *
 * The added steps are copies of the tip (a category merge, which touches
 * `field-overlays`), alternately undoing and redoing it by value (before and
 * after swap), with new ids and times, the branch's tip and the tracker's
 * head moved to the last one. Every value they name is one the file already
 * holds, so the file grows by its step records alone: what a reader's time
 * grows with here is the steps; a real long history's values grow too (the
 * Node suite measures those bytes).
 */

import { readHistoryFile, sessionHeaderOf, writeHistoryFile } from '../../assets/js/app/session/history-file.js';

/**
 * @param {Uint8Array} golden - the golden session file's bytes
 * @param {number} extraSteps
 * @returns {Promise<Uint8Array>} the session file the web app writes for the golden history with
 *   `extraSteps` more steps on the first tracker's main branch
 */
export async function scaleGoldenSession(golden, extraSteps) {
  const { manifest, history, values } = await readHistoryFile(new Blob([golden]));
  const trackers = history.trackers.map(tracker => ({ ...tracker, steps: [...tracker.steps], branches: tracker.branches.map(branch => ({ ...branch })) }));
  const tracker = trackers[0];
  const branch = tracker.branches.find(entry => entry.id === tracker.mainBranch);
  if (tracker.headId !== branch.tip) throw new RangeError('The golden history is expected to show its main branch\'s tip');
  const tipIndex = tracker.steps.findIndex(step => step.id === branch.tip);
  const tip = tracker.steps[tipIndex];
  let parent = { ...tip, children: [...tip.children] };
  tracker.steps[tipIndex] = parent;
  let next = tracker.nextStep;
  let at = tip.until;
  for (let i = 0; i < extraSteps; i++) {
    const forward = i % 2 === 1;
    const step = {
      ...structuredClone(tip),
      id: `s${next++}`, parent: parent.id, children: [], at: (at += 60_000), until: at, notes: [], bookmark: null,
      before: forward ? { ...tip.before } : { ...tip.after },
      after: forward ? { ...tip.after } : { ...tip.before },
    };
    parent.children.push(step.id);
    tracker.steps.push(step);
    parent = step;
  }
  branch.tip = parent.id;
  tracker.headId = parent.id;
  tracker.nextStep = next;
  const blob = await writeHistoryFile({
    header: sessionHeaderOf(manifest), app: manifest.app, actions: manifest.actions, scope: manifest.scope,
    history: { activeTracker: history.activeTracker, trackers }, valueOf: hash => values.get(hash),
  });
  return new Uint8Array(await blob.arrayBuffer());
}
