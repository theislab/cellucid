/**
 * Tell a host (Python, R) how the history changes: one `history_changed`
 * event per change of the open dataset's history (`data/viewer-protocol.js`),
 * so a notebook keeps a current account of it (`viewer.history`,
 * `cellucid_last_history_change()`) and its hooks run, without asking.
 *
 * The history tells its subscribers each change as `{kind, ...detail}`
 * (`history.js` `subscribe`); the event says it in the protocol's few kinds
 * (`VIEWER_HISTORY_CHANGE_KINDS`): a step recorded, the step shown moved, the
 * history's structure edited, a tracker started, used, renamed or removed, a
 * session loaded. A change of a conversation kept with a tracker is not the
 * history's structure and is not told. Every event carries where the history
 * stands after the change: the tracker in use, its step shown, the step the
 * change made or concerns, and the active branch.
 *
 * The page's history is replaced when another dataset opens
 * (`history/current.js`); this follows the history current at each moment,
 * and the source sends nothing while the viewer shows a dataset the host did
 * not open (`notifyHistoryChanged`).
 *
 * @module app/viewer-host/history-events
 */

/** The history's change kinds, by the protocol kind they are told as. */
const KIND_OF = Object.freeze({
  step: 'step',
  moved: 'moved',
  tracker: 'tracker',
  loaded: 'loaded',
  // Not the history's structure: a conversation kept with a tracker.
  chat: null,
});

/**
 * The protocol kind a history change is told as: its own when the protocol
 * has it, nothing for a conversation, and `edited` for every other edit of
 * the history (a rename, a delete, a note, a bookmark, a restore, …).
 *
 * @param {string} kind - The history's change kind
 * @returns {string|null}
 */
export function historyChangeKind(kind) {
  if (typeof kind !== 'string' || kind.length === 0) throw new TypeError('A history change has a kind');
  return Object.hasOwn(KIND_OF, kind) ? KIND_OF[kind] : 'edited';
}

/**
 * Where a history stands: the tracker in use, its step shown and its active
 * branch (null while it names none).
 *
 * @param {{active: {id: string, headId: string, activeBranch?: unknown}}} history
 */
function standing(history) {
  const tree = history.active;
  if (tree === null || tree === undefined) return null;
  return {
    tracker: tree.id,
    head: tree.headId,
    branch: typeof tree.activeBranch === 'string' ? tree.activeBranch : null,
  };
}

/**
 * Send `history_changed` to the host for every change of the page's current
 * history, from now until `stop()`.
 *
 * @param {{
 *   notify: (change: {kind: string, tracker: string, head: string, step: string|null, branch: string|null}) => boolean,
 *   getCurrentHistory: () => (object|null),
 *   subscribeCurrentHistory: (listener: () => void) => (() => void),
 *   onError: (error: unknown) => void,
 * }} options - `notify` is the source's `notifyHistoryChanged`; `onError`
 *   reports a change that could not be told (a host is told the next one)
 * @returns {{stop: () => void}}
 */
export function createViewerHostHistoryEvents({ notify, getCurrentHistory, subscribeCurrentHistory, onError }) {
  for (const [name, value] of Object.entries({ notify, getCurrentHistory, subscribeCurrentHistory, onError })) {
    if (typeof value !== 'function') throw new TypeError(`Viewer host history events need ${name}()`);
  }
  let history = null;
  let unsubscribe = () => {};

  function tell(kind, detail) {
    const told = historyChangeKind(kind);
    if (told === null || history === null) return;
    const at = standing(history);
    if (at === null) return;
    const step = told === 'step' && typeof detail?.step === 'string' ? detail.step : null;
    try {
      notify({ kind: told, ...at, step });
    } catch (error) {
      onError(error);
    }
  }

  function follow() {
    const next = getCurrentHistory();
    if (next === history) return;
    unsubscribe();
    unsubscribe = () => {};
    history = next;
    if (history !== null) unsubscribe = history.subscribe(event => tell(event.kind, event));
  }

  const stopFollowing = subscribeCurrentHistory(follow);
  follow();
  return Object.freeze({
    stop() {
      stopFollowing();
      unsubscribe();
      unsubscribe = () => {};
      history = null;
    },
  });
}
