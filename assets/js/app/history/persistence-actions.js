/**
 * @fileoverview The history's actions that write it down or read it out
 * (History v2 §4): one path for the State panel, agents, Python and R.
 *
 * - `history.methods`, `history.pseudocode`: a branch (main when left out) in
 *   words (`exports/methods.js`, `exports/pseudocode.js`), the methods with
 *   the dataset's facts and Cellucid's citation.
 * - `history.saved.list`, `history.saved.delete`: the saved states of this
 *   browser, listed and one removed (`autosave.js` `removeSavedStates`, the
 *   one way they are removed, which resumes an autosave paused for room).
 * - `history.share`: a session file of what the parameters chose
 *   (`share-scope.js`: the trackers and branches included, the history, the
 *   current state only or the steps only, notes, conversations, Recently
 *   deleted, times, the dataset's source, results), downloaded.
 * - `history.save`: the same choice kept as a named saved state of this
 *   browser (`dataset-history.js` `saveAs`).
 *
 * Each reads the history shown when it runs (`histories.current()`), so it is
 * provided once for the page.
 *
 * @module app/history/persistence-actions
 */

import { ActionRefused } from '../actions/dispatcher.js';
import { SAVE_DEFAULTS } from '../session/share-scope.js';
import { shareScopeOf } from '../actions/definitions/history.js';
import { HISTORY_SENTENCES, nameKey } from './model.js';
import { methodsParagraph } from './exports/methods.js';
import { historyPseudocode } from './exports/pseudocode.js';
import { pageVersion } from '../utils/page-version.js';
import { quoteName } from '../actions/targets/names.js';
import { HISTORY_WAITS_FOR_DATASET } from '../ui/no-dataset.js';

/**
 * Provide the history's persistence actions on `dispatcher`. Returns what
 * stops providing them.
 *
 * @param {{
 *   dispatcher: ReturnType<typeof import('../actions/dispatcher.js').createActionDispatcher>,
 *   histories: ReturnType<typeof import('./dataset-history.js').createDatasetHistories>,
 *   serializer: import('../session/session-serializer.js').SessionSerializer,
 *   datasetFacts: () => object,
 *   citation: () => Promise<string|null>,
 *   download: (blob: Blob, filename: string) => void,
 *   version?: () => string|null,
 * }} options - `datasetFacts`: the facts the methods name (`ui/modules/state/dataset-facts.js`);
 *   `citation`: Cellucid's citation (APA), or null when it cannot be read
 */
export function providePersistenceActions({ dispatcher, histories, serializer, datasetFacts, citation, download, version = () => pageVersion() }) {
  function shown(type) {
    const history = histories.current();
    if (history === null || history.active === null) {
      throw new ActionRefused(HISTORY_WAITS_FOR_DATASET, { code: 'unavailable', type });
    }
    return history;
  }

  /** A tracker's record (its name or id; the one in use when left out) and one of its branches (main when left out). */
  function branchOf(history, { tracker = null, branch = null }) {
    const record = history.trackerRecord(tracker ?? history.active.id);
    if (branch === null) return { record, branch: record.branches.find(candidate => candidate.id === record.mainBranch) };
    const found = record.branches.find(candidate => candidate.id === branch)
      ?? record.branches.find(candidate => nameKey(candidate.name) === nameKey(branch));
    if (found === undefined) {
      throw new ActionRefused(HISTORY_SENTENCES.noBranch({ ref: branch, names: record.branches.map(candidate => candidate.name) }), { code: 'no-target' });
    }
    return { record, branch: found };
  }

  const idName = record => ({ id: record.id, name: record.name });

  const stops = [
    dispatcher.provide('history.methods', async params => {
      const history = shown('history.methods');
      const { record, branch } = branchOf(history, params);
      const text = methodsParagraph({
        tracker: record, branch: branch.id, dataset: datasetFacts(), version: version(), cellucidCitation: await citation(),
      });
      return { tracker: idName(record), branch: idName(branch), text };
    }),
    dispatcher.provide('history.pseudocode', async params => {
      const history = shown('history.pseudocode');
      const { record, branch } = branchOf(history, params);
      const text = historyPseudocode({ tracker: record, branch: branch.id, dataset: datasetFacts(), version: version() });
      return { tracker: idName(record), branch: idName(branch), text };
    }),
    dispatcher.provide('history.saved.list', async () => {
      const shownDataset = histories.current()?.active?.dataset?.id ?? null;
      const saved = await histories.savedStates.list();
      return {
        saved: saved.map(state => ({
          id: state.id, kind: state.kind, name: state.name, dataset: state.dataset,
          this_dataset: shownDataset !== null && state.dataset.id === shownDataset,
          created_at: state.createdAt, updated_at: state.updatedAt, steps: state.steps,
          trackers: state.trackers, bytes: state.bytes, openable: state.openable,
        })),
      };
    }),
    dispatcher.provide('history.saved.delete', async ({ saved: id }) => {
      const states = await histories.savedStates.list();
      const state = states.find(entry => entry.id === id);
      if (state === undefined) {
        throw new ActionRefused(
          `No saved state of this browser has the id ${quoteName(id)}; ${states.length === 0 ? 'none is saved' : `the saved states are ${states.map(entry => `${quoteName(entry.id)}`).join(', ')}`} (history_saved_list).`,
          { code: 'no-target', type: 'history.saved.delete' },
        );
      }
      if (await histories.savedStates.remove(id) !== 1) throw new Error(`The saved state "${id}" could not be removed from this browser.`);
      return { saved: id, name: state.name, dataset: state.dataset?.name ?? null, steps: state.steps };
    }),
    dispatcher.provide('history.share', async (params, { signal }) => {
      const history = shown('history.share');
      const scope = shareScopeOf(params);
      let trackers = 'active';
      let branches = 'main-and-shown';
      if (params.include !== undefined) {
        trackers = [];
        branches = [];
        for (const entry of params.include) {
          const record = history.trackerRecord(entry.tracker);
          trackers.push(record.id);
          if (entry.branches !== undefined) {
            branches.push({ tracker: record.id, branches: entry.branches.map(ref => branchOf(history, { tracker: record.id, branch: ref }).branch.id) });
          }
        }
        if (branches.length === 0) branches = 'main-and-shown';
      }
      const { blob, shared } = await serializer.writeShare({ choice: { ...scope, trackers, branches }, signal });
      const facts = datasetFacts();
      const file = params.file ?? `${facts.name ?? 'Cellucid history'}.cellucid-session`;
      download(blob, file);
      // The whole history written down: leaving it is no longer losing it (`dataset-history.js` `unkept`).
      if (shared.scope.content === 'history') histories.markSaved();
      return {
        file, bytes: blob.size, content: shared.scope.content,
        trackers: shared.history.trackers.map(idName),
        steps: shared.history.trackers.reduce((sum, tracker) => sum + tracker.steps.length - 1, 0),
      };
    }),
    dispatcher.provide('history.save', async params => {
      shown('history.save');
      const { content, results } = shareScopeOf({ ...SAVE_DEFAULTS, ...params });
      const saved = await histories.savedStates.saveAs(params.name ?? null, { content, results });
      return { saved: saved.id, name: saved.name, content: saved.content, bytes: saved.bytes, steps: saved.steps };
    }),
  ];
  return () => { for (const stop of stops) stop(); };
}
