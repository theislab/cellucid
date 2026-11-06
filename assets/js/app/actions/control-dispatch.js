/**
 * @fileoverview How a control dispatches an action (`app/actions/`): the
 * change it asks for is made, recorded and undoable the same way an agent's
 * or a notebook's is. What the person needs to hear is said once: a refusal
 * as its own sentence, any other failure after what was being done; a choice
 * a newer one replaced, or one stopped, is not a failure.
 *
 * A drag (a slider, a colour picker) dispatches the latest value only: while
 * one dispatch runs, newer values replace each other and the last one is
 * dispatched next (`createLatestDispatch`), so a fast drag never queues one
 * step per frame; the action's `coalesce` makes the drag one step.
 *
 * @module app/actions/control-dispatch
 */

import { getActions } from './index.js';
import { ActionRefused } from './dispatcher.js';
import { getNotificationCenter } from '../notification-center.js';
import { isCancellation } from '../../utils/abort.js';

/** A failure nobody needs to hear of: superseded by a newer choice, or stopped. */
export function isQuietFailure(error) {
  return isCancellation(error) || (error instanceof ActionRefused && error.code === 'superseded');
}

/** The words a failure is said with. */
export function failureWords(error, failure = null) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ActionRefused || failure === null) return message;
  return `${failure}: ${message}`;
}

/**
 * Say a dispatch's failure (`failure`: what was being done, said before
 * anything but a refusal); nothing for a quiet one.
 */
export function reportActionFailure(error, { failure = null, category = 'filter' } = {}) {
  if (isQuietFailure(error)) return;
  if (!(error instanceof ActionRefused)) console.error(error);
  try {
    getNotificationCenter().error(failureWords(error, failure), { category });
  } catch (notificationError) {
    // A page being torn down has nowhere to say it; the console has it.
    console.error(`[actions] ${failureWords(error, failure)}`, notificationError);
  }
}

/**
 * Dispatch `type` from a control, origin `user`.
 *
 * @param {string} type
 * @param {object} params
 * @param {{failure?: string|null, category?: string, signal?: AbortSignal|null}} [options]
 * @returns {Promise<{outcome: unknown, step: object|null}|null>} null when it
 *   failed (said) or was superseded
 */
export async function dispatchFromControl(type, params, { failure = null, category = 'filter', signal = null } = {}) {
  try {
    return await getActions().dispatch(type, params, signal === null ? {} : { signal });
  } catch (error) {
    reportActionFailure(error, { failure, category });
    return null;
  }
}

/**
 * A dispatcher for a drag: `push(params)` dispatches now when nothing of it
 * runs, else keeps `params` as the next one, replacing any kept before.
 * `flush()` resolves once the last value pushed is dispatched.
 *
 * @param {string} type
 * @param {{failure?: string|null, category?: string, onSettled?: () => void}} [options]
 *   `onSettled`: called when the last dispatch of a burst settles
 */
export function createLatestDispatch(type, { failure = null, category = 'filter', onSettled = () => {} } = {}) {
  let running = null;
  // The parameters of the dispatch running (as JSON), and the next ones.
  let runningKey = null;
  let next = null;
  let idle = Promise.resolve();
  let resolveIdle = null;

  function run(params) {
    runningKey = JSON.stringify(params);
    running = dispatchFromControl(type, params, { failure, category }).finally(() => {
      running = null;
      runningKey = null;
      if (next !== null) {
        const queued = next;
        next = null;
        run(queued);
        return;
      }
      resolveIdle?.();
      resolveIdle = null;
      onSettled();
    });
  }

  return Object.freeze({
    push(params) {
      if (running !== null) {
        // The value running is the latest again: nothing more to dispatch.
        next = JSON.stringify(params) === runningKey ? null : params;
        return;
      }
      idle = new Promise(resolve => { resolveIdle = resolve; });
      run(params);
    },
    /** Drop the value waiting to be dispatched (the person stopped the work). */
    clear() { next = null; },
    /** Whether a value pushed is not dispatched and settled yet. */
    get pending() { return running !== null; },
    flush: () => idle,
  });
}
