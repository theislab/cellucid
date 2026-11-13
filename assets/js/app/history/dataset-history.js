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
 *   is kept (`dataset/reload.js`, `keepHistory`), since that reading is one of its
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
import { createOpaqueId } from '../../utils/opaque-id.js';
import { SAVE_DEFAULTS, shareHistory } from '../session/share-scope.js';
import { NO_PAGE_CHROME } from '../session/history-file.js';
import { appStamp } from '../session/app-stamp.js';
import { pageVersion } from '../utils/page-version.js';
import { getActionCatalog } from '../actions/index.js';
import { PLACES, placePath } from '../ui/place-names.js';
import { setWorkingSet } from '../../data/memory-budget.js';
import { afterWelcome } from '../../utils/startup-sequence.js';
import { NO_DATASET_OPEN, noDatasetOpenTo } from '../ui/no-dataset.js';

/**
 * @param {{
 *   dispatcher: ReturnType<typeof import('../actions/dispatcher.js').createActionDispatcher>,
 *   domains: ReturnType<typeof import('../actions/domains.js').createDomainRegistry>,
 *   notifications: {show: Function, warning: Function},
 *   header: () => Promise<object>,
 *   loadSavedHistory: (open: () => Promise<object>, options: {label: string}) => Promise<void>,
 *   openSavedState: (id: string, options?: {heavy?: Function|null, signal?: AbortSignal|null}) => Promise<{opened: boolean, problem: string|null, code: string|null}>,
 *   store?: ReturnType<typeof import('./autosave-store.js').createHistoryStore>|null,
 *   now?: () => number,
 *   chrome?: {capture: () => {pressed: Record<string, string>}},
 *   version?: () => string|null,
 * }} options - `chrome`: the page chrome saved states carry outside the history;
 *   `version`: the Cellucid version that writes them; `header`: the open dataset's session header
 *   (`SessionSerializer.captureSessionHeader`); `loadSavedHistory`: load a saved
 *   history into the shown one (`SessionSerializer.loadSavedHistory`);
 *   `openSavedState`: open a saved state from the lists, its dataset first
 *   (the session controls)
 */
/**
 * The steps of `tracker` that are work a person would lose: every step but
 * the opening, except one that only arranged the page (a panel opened,
 * moved or docked, a section folded: the `layout` domain alone). Opening the
 * Agents section is a step, but leaving it unkept is no loss to ask about
 * ("Your work is not kept" before another dataset opened, for nothing).
 *
 * @param {{steps: Map<string, {parent: string|null, after?: Object}>}} tracker
 * @returns {number}
 */
export function workStepsOf(tracker) {
  let count = 0;
  for (const step of tracker.steps.values()) {
    if (step.parent === null) continue;
    if (Object.keys(step.after ?? {}).some(domain => domain !== 'layout')) count += 1;
  }
  return count;
}

/**
 * The history events that change what only this page holds: a step, an edit,
 * a replay, a tracker, a conversation, a turn, changes while paused. Not a
 * head moved by undo or redo (nothing is lost), nor a load (what it brought
 * is kept where it came from).
 */
const CONTENT_EVENTS = new Set(['step', 'edited', 'replayed', 'tracker', 'chat', 'turn', 'recording']);

export function createDatasetHistories({
  dispatcher, domains, notifications, header, loadSavedHistory, openSavedState: openFromList,
  store = defaultHistoryStore(), now = () => Date.now(), chrome = null, version = () => pageVersion(),
}) {
  const pageChrome = () => chrome?.capture() ?? NO_PAGE_CHROME;
  /** What wrote a saved state: this page's version and catalog (null where the page names no version). */
  const stamp = async () => {
    const named = version();
    return named === null ? null : appStamp({ catalog: getActionCatalog(), version: named });
  };
  /** @type {{history: ReturnType<typeof createHistory>, autosave: ReturnType<typeof createAutosave>|null, dataset: object, stop: () => void}|null} */
  let current = null;
  let collected = false;
  let quotaSaid = false;
  /**
   * Session loads under way (`holdOffersUntil`): a dataset opened for one is
   * offered nothing to continue until it has settled, and nothing when it
   * loaded a history.
   * @type {Set<Promise<unknown>>}
   */
  const offerHolds = new Set();

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

  /**
   * Offer to continue the dataset's latest autosave, unless a session load
   * holds offers (`holdOffersUntil`): then once it settled, and only if it
   * loaded no history and the dataset is still shown. Never awaited by the
   * opening: a session load waits for the opening it caused.
   */
  async function offerToContinue(owned) {
    if (offerHolds.size > 0) {
      let loaded = false;
      const stopWatching = owned.history.subscribe(event => {
        if (event.kind === 'loaded') loaded = true;
      });
      try {
        while (offerHolds.size > 0) await Promise.all([...offerHolds]);
      } finally {
        stopWatching();
      }
      if (loaded || current !== owned || owned.autosave === null) return;
    }
    // After the welcome, never on top of it (`utils/startup-sequence.js`).
    await afterWelcome();
    if (current !== owned || owned.autosave === null) return;
    await owned.autosave.offerContinue({
      notifications,
      onContinue: saved => {
        void openFromList(saved.id).catch(error => {
          console.error('[history] Continuing a saved state failed:', error);
        });
      },
    });
  }

  const api = {
    /**
     * A session (a file, a saved state) is being loaded, which may open its
     * dataset first: no "Continue where you left off?" is offered until
     * `settled` settles, and none when the load put a history in place — the
     * person chose which history to show (the offer would show mid-load and
     * go once the session landed).
     *
     * @param {Promise<unknown>} settled
     */
    holdOffersUntil(settled) {
      if (typeof settled?.then !== 'function') throw new TypeError('holdOffersUntil needs a promise.');
      const held = Promise.resolve(settled).then(() => {}, () => {});
      offerHolds.add(held);
      void held.then(() => offerHolds.delete(held));
    },
    /** The history of the dataset shown, or null while none is. */
    current: () => current?.history ?? null,
    /** The autosave of the dataset shown, or null. */
    currentAutosave: () => current?.autosave ?? null,
    /**
     * The work on the dataset shown that would be lost if it were replaced or
     * the page left, or null when there is none: steps (and notes,
     * conversations, changes while paused) made since the history was last
     * saved, while this browser is not keeping them — the autosave switched
     * off, no storage, or no room left. Opening another dataset asks first,
     * and so does leaving the page (`app/unkept-work-guard.js`).
     *
     * @returns {{dataset: string|null, steps: number, why: 'off'|'unavailable'|'room'}|null}
     */
    unkept() {
      const owned = current;
      if (owned === null || owned.history.active === null || owned.history.destroyed) return null;
      if (owned.autosave?.keeping === true || owned.changes === owned.savedAt) return null;
      const steps = owned.history.trackers().reduce((sum, tracker) => sum + workStepsOf(tracker), 0);
      if (steps === 0) return null;
      const why = !historySettings().autosave ? 'off' : owned.autosave?.paused === true ? 'room' : 'unavailable';
      return { dataset: owned.dataset.name ?? null, steps, why };
    },
    /** The history shown was written down as it is now (a session file, a saved state): nothing of it is unkept. */
    markSaved() {
      if (current !== null) current.savedAt = current.changes;
    },
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
        // History settings: what is recorded, whether a new dataset records, who the person is.
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
      // `changes` counts what changed the history's content; `savedAt` the count a save covered (`unkept`).
      current = { history, autosave: null, dataset, stop, replays: new Map(), changes: 0, savedAt: 0 };
      const stopCounting = history.subscribe(event => {
        if (CONTENT_EVENTS.has(event?.kind) && current?.history === history) current.changes += 1;
      });
      const stopAccounting = current.stop;
      current.stop = () => { stopCounting(); stopAccounting(); };
      return history;
    },
    /**
     * The starting view of the dataset `history` is of is applied (or there
     * is none): start its first tracker from what is shown, keep it in this
     * browser, and offer to continue the dataset's latest autosave. Nothing
     * happens when another dataset has been opened since, or the page was
     * left: a history retired while it starts has nothing to start, and what
     * its start then fails on (an owner withdrawn with the page) is no failure.
     *
     * @param {ReturnType<typeof createHistory>} history - what `open` returned
     */
    async begin(history) {
      const owned = current;
      if (owned === null || owned.history !== history || history.active !== null) return;
      try {
        await owned.history.startTracker();
      } catch (error) {
        if (current !== owned) return;
        throw error;
      }
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
      void offerToContinue(owned);
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
     * @param {{heavy?: ((estimate: Object) => Promise<void>)|null, signal?: AbortSignal|null}} [options] - An action's `ctx.heavy`
     *   (an agent's `history.saved.open`): asked before restoring sums cells' totals; `signal`: its Stop, which stops
     *   the restore (what was shown comes back)
     */
    async loadSaved(source, { heavy = null, signal = null } = {}) {
      const owned = current;
      if (owned === null) throw new Error('No dataset is open. Open the dataset the saved state was made on first.');
      let loaded = null;
      const load = async () => {
        loaded = await loadSavedHistory(() => Promise.resolve(source), { label: 'Saved state', heavy, signal });
      };
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
      // What the load could not restore (`SessionSerializer` `_restore`: `{notRestored}`), or null.
      return loaded ?? null;
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
     * use instead. The source is kept by the tracker made,
     * for `replayAgain`, while the dataset is shown.
     *
     * @param {() => Promise<import('../session/session-serializer.js').SavedHistorySource>} open
     * @param {{signal?: AbortSignal|null, onStep?: Function|null, mapping?: object|null,
     *   choice?: {saved?: string|null, file?: string|null, tracker?: string|null, branch?: string|null}}} [options]
     */
    async replay(open, { signal = null, onStep = null, mapping = null, choice = {} } = {}) {
      const owned = current;
      if (owned === null || owned.history.active === null) {
        throw new Error(noDatasetOpenTo('replay a history on it'));
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
      /**
       * Open one to continue it: its dataset first, then its history (the
       * session controls' `openSavedState`). Resolves `{opened, problem,
       * code}`: when it was not opened, why, unless that was said where it
       * happened.
       */
      open: (id, { heavy = null, signal = null } = {}) => openFromList(id, { heavy, signal }),
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
        if (owned === null || owned.history.active === null) throw new Error(`${NO_DATASET_OPEN} A saved state is of a dataset's history: open its dataset first.`);
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
          if (shared.scope.content === 'history' && current === owned) api.markSaved();
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
