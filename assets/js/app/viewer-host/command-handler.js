/**
 * Carry out a host's (Python's, R's) actions: every command that changes or
 * reads the viewer's state is an `action` of the catalog (`app/actions/`),
 * dispatched with origin `host` and the host's name, so it takes the path a
 * control takes, is one step of the history (labeled as the host's) and is
 * undone like any other. Undo, redo and jumps are actions too (effect
 * `history`): they move the history and record no step.
 *
 * The parameters arrive as the channel decoded them
 * (`data/viewer-protocol.js` `decodeViewerBinaryCommand`): an `x-cells` list
 * of original positions as a Uint32Array, an `x-values` column in its own
 * value type. The action's schema checks them and its implementation
 * resolves the names and cells against the open dataset; an unknown action
 * or parameters its schema refuses reach the host as its `command_error`.
 *
 * A host's actions name its own dataset's cells and fields, so none is
 * carried out while the person shows another dataset in the viewer; and a
 * host does not open another dataset in its viewer (an action of effect
 * `dataset`): its viewer shows the dataset it serves, and it shows another
 * by serving that one.
 *
 * The answer is JSON (`app/actions/outcome.js`), converted as an agent's
 * is: an action that ran is never answered as if it had not because its
 * outcome held a value JSON cannot carry. A change that made no step says
 * why (`unrecorded`: it was so already, recording paused, ...;
 * `data/viewer-protocol.js` `VIEWER_ACTION_UNRECORDED`), as an agent is told.
 *
 * A host's **turn** (`with viewer.turn("QC"):` in Python, `cellucid_turn()`
 * in R) travels with each of its actions (`turn`, `turnLabel`) into the
 * dispatch meta, so the history records one turn of the notebook, undone
 * together in the State panel, as an agent's turn is.
 *
 * A host pushes a **session file** into the viewer (`load_session`): it is
 * loaded as a file the person opened (`loadSession`), its trackers beside the
 * person's own, while the viewer shows the host's dataset.
 */

import { outcomeAsJson } from '../actions/outcome.js';
import { viewerHostWords } from '../../data/viewer-protocol.js';

const HANDLER_OPTIONS = Object.freeze(['getShownHostDataset', 'getHostRuntime', 'actions', 'loadSession']);

/**
 * @param {{
 *   getShownHostDataset: () => string|null,
 *   getHostRuntime: () => string|null,
 *   actions: ReturnType<typeof import('../actions/dispatcher.js').createActionDispatcher>,
 *   loadSession: (file: File) => Promise<{tracker: {id: string, name: string}, head: string}>,
 * }} options
 *   `getShownHostDataset` names the host's dataset the viewer shows, or null
 *   while the person has another one open; `getHostRuntime` is what opened
 *   the viewer (a key of `VIEWER_HOST_RUNTIMES`, null before it said), whose
 *   words name the host in a refusal and whose language (`python` for a
 *   notebook, a script and `cellucid serve` alike; `r`) labels each of its
 *   steps (`viewerHostWords`); `actions` is the page's
 *   dispatcher (`app/actions/index.js` `getActions()`); `loadSession` loads a
 *   session file into the open dataset's history as the person's Load does
 *   (`session-serializer.js` `restoreFromBlob`) and resolves to the tracker
 *   then shown and its step shown.
 */
export function createViewerHostCommandHandlers(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).length !== HANDLER_OPTIONS.length ||
    !HANDLER_OPTIONS.every(key => Object.hasOwn(options, key))
  ) {
    throw new TypeError(
      `Viewer host command handlers require exactly ${HANDLER_OPTIONS.join(', ')}`
    );
  }
  for (const key of ['getShownHostDataset', 'getHostRuntime', 'loadSession']) {
    if (typeof options[key] !== 'function') {
      throw new TypeError(`Viewer host command ${key} must be a function`);
    }
  }
  const { getShownHostDataset, getHostRuntime, actions, loadSession } = options;
  const hostWords = () => viewerHostWords(getHostRuntime());
  if (actions === null || typeof actions !== 'object' || typeof actions.dispatch !== 'function') {
    throw new TypeError('Viewer host command handlers require the page\'s action dispatcher');
  }

  /** Refuse what names the host's dataset while the viewer shows another. */
  function requireHostDataset(what) {
    if (getShownHostDataset() === null) {
      const { name } = hostWords();
      throw new Error(
        `The viewer shows a dataset ${name} did not open, so ${what} was not carried out; `
        + `open the dataset of ${name} again in the viewer, or show the viewer again.`
      );
    }
  }

  /**
   * One host action, through the page's dispatcher, as part of the host's
   * turn when it names one.
   *
   * @param {{action: string, params: object, turn: string|null, turnLabel: string|null}} command
   * @returns {Promise<{outcome: unknown, step: {id: string, label: string}|null, unrecorded: string|null}>}
   *   the action's outcome as JSON (a read's result), the history step it
   *   made, and why a change made none (the dispatch's `unrecorded`; null
   *   beside a step and for no change)
   */
  async function handleAction({ action, params, turn, turnLabel }) {
    requireHostDataset(`"${action}"`);
    if (actions.catalog?.has(action) && actions.catalog.get(action).effect === 'dataset') {
      const { name, language } = hostWords();
      const how = language === 'r' ? 'R shows another dataset with cellucid_view()'
        : language === 'python' ? 'Python shows another dataset with show_anndata() or serve_anndata()'
          : 'its host shows another dataset by serving it';
      throw new Error(`"${action}" is not carried out from ${name}: this viewer shows the dataset ${name} serves, and ${how}.`);
    }
    const { outcome, step, unrecorded } = await actions.dispatch(action, params, {
      origin: 'host',
      host: hostWords().language,
      turn,
      turnLabel,
    });
    return {
      outcome: outcomeAsJson(outcome),
      step: step === null || step === undefined ? null : { id: step.id, label: step.label },
      unrecorded,
    };
  }

  /**
   * One session file the host pushed, loaded as the person's Load loads one.
   *
   * @param {{name: string, file: Uint8Array}} load
   * @returns {Promise<{tracker: {id: string, name: string}, head: string}>}
   */
  async function handleLoadSession({ name, file }) {
    requireHostDataset(`the session "${name}"`);
    return loadSession(new File([file], name, { type: 'application/octet-stream' }));
  }

  return Object.freeze({ handleAction, handleLoadSession });
}
