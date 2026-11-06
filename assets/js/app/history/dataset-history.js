/**
 * @fileoverview The history of the dataset shown, from its opening to its
 * replacement, and the saved states the State section lists.
 *
 * - **Open** (`open`), when a dataset is published: its history is made,
 *   with no tracker yet. Its starting view, if its catalog names one, is put
 *   back into it without a step (`SessionSerializer.restorePublishedDefaultState`,
 *   `history.showValues`); an action taken meanwhile is applied and not
 *   recorded, so it is part of the state the history starts from.
 * - **Begin** (`begin`), once the starting view is applied (or there is
 *   none): the first tracker starts from what is shown, the autosave keeps
 *   every change in this browser (`autosave.js`), and the dataset's latest
 *   autosave of an earlier visit is offered to continue.
 * - **Retire** (`retire`), before another dataset (or none) is published:
 *   the history stops recording at once (its recorder and gate leave the
 *   dispatcher) and the autosave finishes writing what changed. The same
 *   dataset read again on other cells is not another dataset: its history
 *   is kept (`main.js`, `keepHistory`), since that reading is one of its
 *   steps (`cells.open`) or one of its steps shown (the `cells` domain).
 * - **Memory**: the bytes of the values the history keeps are part of the
 *   working set (`data/memory-budget.js`, part `'history'`): the person's
 *   work, never evicted, held while the dataset is shown.
 * - **Saved states** (`savedStates`): the interface the State section calls
 *   (list, open, replay, rename, remove, save as, room), over `autosave.js`.
 * - **Replay** (`replay`): a saved history (a session file, a saved state), of
 *   this dataset or another, read whole and checked, then its steps applied
 *   again by name in a new tracker of the dataset shown, linked to the tracker
 *   they come from (`replay.js`, `history.js` `replay`).
 *
 * @module app/history/dataset-history
 */

import { getCurrentHistory, getSavedHistories, setCurrentHistory, setSavedHistories } from './current.js';
import { createHistory } from './history.js';
import { readReplayPlan } from './replay.js';
import {
  collectSavedStates, createAutosave, keepAsSavedState, keepSavedStatesWhenSpaceIsLow, listSavedStates, onSavedStatesChange,
  openSavedState, removeSavedStates, renameSavedState, savedStatesStorage,
} from './autosave.js';
import { defaultHistoryStore } from './autosave-store.js';
import { historySettings, offDomainsOf, onHistorySettingsChange } from './history-settings.js';
import { createOpaqueId } from '../utils/opaque-id.js';
import { SAVE_DEFAULTS, shareHistory } from '../session/share-scope.js';
import { NO_PAGE_CHROME } from '../session/history-file.js';
import { appStamp } from '../session/app-stamp.js';
import { pageVersion } from '../utils/page-version.js';
import { getActionCatalog } from '../actions/index.js';
import { PLACES, placePath } from '../ui/place-names.js';
import { setWorkingSet } from '../../data/memory-budget.js';

/**
 * @param {{
 *   dispatcher: ReturnType<typeof import('../actions/dispatcher.js').createActionDispatcher>,
 *   domains: ReturnType<typeof import('../actions/domains.js').createDomainRegistry>,
 *   notifications: {show: Function, warning: Function},
 *   header: () => Promise<object>,
 *   loadSavedHistory: (open: () => Promise<object>, options: {label: string}) => Promise<void>,
 *   openSavedState: (id: string) => Promise<boolean>,
 *   store?: ReturnType<typeof import('./autosave-store.js').createHistoryStore>|null,
 *   now?: () => number,
 *   chrome?: {capture: () => {pressed: Record<string, string>}},
 *   version?: () => string|null,
 * }} options - `chrome`: the page chrome saved states carry outside the history (CEL-0249);
 *   `version`: the Cellucid version that writes them; `header`: the open dataset's session header
 *   (`SessionSerializer.captureSessionHeader`); `loadSavedHistory`: load a saved
 *   history into the shown one (`SessionSerializer.loadSavedHistory`);
 *   `openSavedState`: open a saved state from the lists, its dataset first
 *   (the session controls)
 */
export function createDatasetHistories({
  dispatcher, domains, notifications, header, loadSavedHistory, openSavedState: openFromList,
  store = defaultHistoryStore(), now = () => Date.now(), chrome = null, version = () => pageVersion(),
}) {
  const pageChrome = () => chrome?.capture() ?? NO_PAGE_CHROME;
  /** What wrote a saved state: this page's version and catalogue (null where the page names no version). */
  const stamp = async () => {
    const named = version();
    return named === null ? null : appStamp({ catalog: getActionCatalog(), version: named });
  };
  /** @type {{history: ReturnType<typeof createHistory>, autosave: ReturnType<typeof createAutosave>|null, dataset: object, stop: () => void}|null} */
  let current = null;
  let collected = false;
  let quotaSaid = false;

  function accountMemory(history) {
    setWorkingSet('history', history.destroyed ? 0 : history.pool.byteLength());
  }

  const stopSettings = onHistorySettingsChange(settings => {
    if (settings.autosave) current?.autosave?.resume();
  });

  function quotaExceeded() {
    if (quotaSaid) return;
    quotaSaid = true;
    notifications.warning(
      'This browser has no room left to keep the history, so the steps from now on are not kept. '
      + `Remove saved states you no longer need (Load… in ${placePath(PLACES.state, PLACES.sessionFile)}, or Stored in ${placePath(PLACES.session, PLACES.stored)}); keeping resumes then.`,
      { category: 'session', duration: 0 }
    );
  }

  const api = {
    /** The history of the dataset shown, or null while none is. */
    current: () => current?.history ?? null,
    /** The autosave of the dataset shown, or null. */
    currentAutosave: () => current?.autosave ?? null,
    /**
     * A dataset was published: make its history (no tracker yet).
     *
     * @param {{id: string|null, name: string|null}} dataset - its identity id and name
     */
    open(dataset) {
      api.retire();
      const history = createHistory({
        dispatcher, domains, dataset: { id: dataset.id, name: dataset.name, cellOrder: null },
        newTrackerId: () => `t-${createOpaqueId()}`, now,
        // `history.replay` reads a saved state of this browser.
        openSaved: id => openSavedState(id, store),
        // History settings (§3.15.5): what is recorded, whether a new dataset records, who the person is.
        offDomains: () => offDomainsOf(historySettings()),
        recordNewTrackers: () => historySettings().recordNewDatasets,
        person: () => historySettings().personName,
      });
      let pending = false;
      const stop = history.subscribe(() => {
        if (pending) return;
        pending = true;
        queueMicrotask(() => {
          pending = false;
          accountMemory(history);
        });
      });
      // Each replay's source by the tracker it made, while the dataset is shown ("Replay again with these names").
      current = { history, autosave: null, dataset, stop, replays: new Map() };
      return history;
    },
    /**
     * The starting view of the dataset `history` is of is applied (or there
     * is none): start its first tracker from what is shown, keep it in this
     * browser, and offer to continue the dataset's latest autosave. Nothing
     * happens when another dataset has been opened since.
     *
     * @param {ReturnType<typeof createHistory>} history - what `open` returned
     */
    async begin(history) {
      const owned = current;
      if (owned === null || owned.history !== history || history.active !== null) return;
      await owned.history.startTracker();
      if (current !== owned) return;
      accountMemory(owned.history);
      // Shown from now on: the State panel, the keyboard's undo and the agent read it.
      setCurrentHistory(owned.history);
      owned.autosave = createAutosave({
        history: owned.history, dataset: owned.dataset, header, store, now,
        enabled: () => historySettings().autosave, onQuotaExceeded: quotaExceeded, chrome: pageChrome, stamp,
        // Room was made (a removal anywhere): a later full storage is said again.
        onResume: () => { quotaSaid = false; },
      });
      if (!collected) {
        collected = true;
        void collectSavedStates(store);
      }
      void owned.autosave.offerContinue({
        notifications,
        onContinue: saved => {
          void openFromList(saved.id).catch(error => {
            console.error('[history] Continuing a saved state failed:', error);
          });
        },
      });
    },
    /** Another dataset (or none) is about to be shown: stop recording now; the autosave finishes writing. */
    retire() {
      const owned = current;
      if (owned === null) return Promise.resolve();
      current = null;
      if (getCurrentHistory() === owned.history) setCurrentHistory(null);
      owned.stop();
      owned.history.destroy();
      setWorkingSet('history', 0);
      return owned.autosave === null ? Promise.resolve() : owned.autosave.retire();
    },
    /** Write what changed now (the page is being left). */
    flush: () => current?.autosave?.flush() ?? Promise.resolve(),
    /**
     * Load a saved state's source (`autosave.js` `openSavedState`) into the
     * shown history: an autosave keeps being written into, a named save
     * stays as it was and the history is kept as a new autosave.
     *
     * @param {Awaited<ReturnType<typeof openSavedState>>} source
     */
    async loadSaved(source) {
      const owned = current;
      if (owned === null) throw new Error('No dataset is open. Open the dataset the saved state was made on first.');
      const load = () => loadSavedHistory(() => Promise.resolve(source), { label: 'Saved state' });
      if (source.entry.kind === 'autosave' && owned.autosave !== null) {
        const continued = await owned.autosave.continueFrom({ id: source.entry.id, createdAt: source.entry.createdAt }, load);
        if (!continued) {
          notifications.show({
            type: 'info', category: 'session',
            message: 'This history is open in another tab, so it continues here as a copy: both are kept.',
          });
        }
      } else {
        await load();
      }
    },
    /**
     * Replay a saved history on the dataset shown: `open` gives its source (a
     * session file's, `SessionSerializer.openSessionFile`; a saved state's,
     * `openSavedState`), which is read whole and checked, never compared with
     * the dataset shown; then its branch shown is applied again by name in a
     * new tracker linked to its tracker. Resolves to the history's report.
     *
     * `choice`: where it comes from (`saved`, `file`) and the tracker and
     * branch to replay (`replay.js` `replayPlanOf`); `mapping`: the names to
     * use instead (History v2 §3.10). The source is kept by the tracker made,
     * for `replayAgain`, while the dataset is shown.
     *
     * @param {() => Promise<import('../session/session-serializer.js').SavedHistorySource>} open
     * @param {{signal?: AbortSignal|null, onStep?: Function|null, mapping?: object|null,
     *   choice?: {saved?: string|null, file?: string|null, tracker?: string|null, branch?: string|null}}} [options]
     */
    async replay(open, { signal = null, onStep = null, mapping = null, choice = {} } = {}) {
      const owned = current;
      if (owned === null || owned.history.active === null) {
        throw new Error('Open a dataset first: a history is replayed on the dataset shown.');
      }
      const plan = await readReplayPlan(await open(), { signal, ...choice });
      if (current !== owned) throw new Error('Another dataset was opened while the history was read; replay it again there.');
      const result = await owned.history.replay({ ...plan, mapping }, { signal, onStep });
      owned.replays.set(result.tracker, { open, choice: { ...choice, tracker: plan.from.tracker.id, branch: plan.from.branch.id } });
      return result;
    },
    /**
     * Where the steps a replayed tracker applied can be read again: the
     * source this page replayed them from, else the saved state of this
     * browser its start names; null when neither is at hand (a file replayed
     * before the page was opened: replay it again from Load…).
     * @param {string} trackerId
     */
    replaySource(trackerId) {
      const owned = current;
      if (owned === null) return null;
      const kept = owned.replays.get(trackerId);
      if (kept !== undefined) return kept;
      const start = owned.history.allTrackers().find(tracker => tracker.id === trackerId)?.start ?? null;
      const from = start?.from ?? null;
      if (start?.kind !== 'replay' || typeof from?.saved !== 'string') return null;
      return {
        open: () => openSavedState(from.saved, store),
        choice: { saved: from.saved, tracker: from.tracker?.id ?? null, branch: from.branch?.id ?? null },
      };
    },
    /**
     * Replay the steps a replayed tracker applied again, from the same source,
     * with `mapping` (the names to use instead), in a new tracker.
     * @param {string} trackerId
     * @param {object} mapping
     * @param {{signal?: AbortSignal|null, onStep?: Function|null}} [options]
     */
    replayAgain(trackerId, mapping, { signal = null, onStep = null } = {}) {
      const source = api.replaySource(trackerId);
      if (source === null) {
        throw new Error('The steps it replayed are not at hand on this page: replay the session file again (Load… › Replay a session file here…).');
      }
      return api.replay(source.open, { signal, onStep, mapping, choice: source.choice });
    },
    /** What the State section calls: every saved state of this browser. */
    savedStates: Object.freeze({
      /** Every saved state, most recently written first (`listSavedStates`); `current` marks this history's own. */
      async list() {
        const states = await listSavedStates(store);
        const own = current?.autosave?.entryId ?? null;
        return states.map(state => ({ ...state, current: state.id === own }));
      },
      /** Open one: its dataset first, then its history (resolves whether it was opened). */
      open: id => openFromList(id),
      /** The source of one saved state, for the opener (`openSavedState`). */
      read: id => openSavedState(id, store),
      /** Replay one on the dataset shown, in a new tracker linked to it (`replay`). */
      replay: (id, options = {}) => api.replay(() => openSavedState(id, store), { ...options, choice: { saved: id } }),
      rename: (id, name) => renameSavedState(id, name, store),
      /** Remove one saved state (`removeSavedStates`, which resumes an autosave paused for room). */
      remove: id => removeSavedStates([id], store),
      /**
       * Keep the history as it is now as a named saved state of this browser,
       * beside the autosave (`history.save`): the whole history (every
       * tracker), the current state only or the steps only
       * (`share-scope.js`), its analysis results kept or left out. Changes
       * made while recording was paused become one step first. Resolves to
       * `{id, name, content, bytes, steps}`.
       *
       * @param {string|null} name - the dataset's name and the time when null
       * @param {{content?: 'history'|'state'|'steps', results?: 'include'|'recompute'}} [options]
       */
      async saveAs(name, { content = 'history', results = 'include' } = {}) {
        const owned = current;
        if (owned === null || owned.history.active === null) throw new Error('Open a dataset first: a saved state is of a dataset\'s history.');
        const { history } = owned;
        await history.settlePaused({ origin: 'user' });
        await history.reconcile();
        const at = now();
        const exact = name === null
          ? `${owned.dataset.name ?? 'History'} ${new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
          : String(name).trim();
        if (exact.length === 0) throw new TypeError('A saved state needs a name');
        const taken = await header();
        // The values read across awaits stay readable while they are read (`value-pool.js` hold).
        const unhold = history.pool.hold();
        try {
          const shared = await shareHistory({
            snapshot: history.snapshot(), shown: history.shownHashes(), valueOf: hash => history.pool.get(hash),
            choice: { ...SAVE_DEFAULTS, chats: true, content, results }, catalog: getActionCatalog(),
            newTrackerId: () => `t-${createOpaqueId()}`, now: at,
          });
          const saved = await keepAsSavedState({
            history: shared.history, valueOf: shared.valueOf, content: shared.scope.content,
            header: { ...taken, createdAt: shared.createdAt(taken.createdAt), source: shared.keepSource ? taken.source : null },
            dataset: { id: owned.dataset.id, name: owned.dataset.name }, name: exact, createdAt: at, updatedAt: at,
            chrome: pageChrome(), app: await stamp(),
          }, store);
          return { ...saved, name: exact, content: shared.scope.content };
        } finally {
          unhold();
        }
      },
      subscribe: listener => onSavedStatesChange(listener),
      storage: () => savedStatesStorage(),
      keepWhenSpaceIsLow: () => keepSavedStatesWhenSpaceIsLow(),
    }),
    destroy() {
      stopSettings();
      if (getSavedHistories() === api.savedStates) setSavedHistories(null);
      return api.retire();
    },
  };
  setSavedHistories(api.savedStates);
  return api;
}
