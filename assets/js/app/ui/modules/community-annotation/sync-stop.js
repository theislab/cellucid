/**
 * @fileoverview How the one Pull or Publish under way is stopped, and what its
 * catch reads when it was.
 *
 * A stop says why, as an error the sync's controller is aborted with
 * (`utils/abort.js`): a cancellation (`cancelled(kind, words)`) for a stop
 * that is no failure -- the person's Cancel (`user`), a change of dataset,
 * repository or user, a disconnect, another tab, the controls going away
 * (`closed`), a newer sync (`superseded`) -- or a plain error for one that
 * fails the sync (the connection lost). Every step of the sync throws that
 * reason (`throwIfAborted(controller.signal)`), and its catch reads it back
 * (`syncFailureOf`): a cancellation is said as one (`stoppedSyncOutcome`),
 * never as a failure, wherever the stop caught the sync (round 9: a stop
 * was a plain `Error`, so the person's Cancel read as "Pull failed").
 *
 * @module ui/modules/community-annotation/sync-stop
 */

import { abortReason, cancel, cancellationKind, isCancellation, onAbort, requireSignal } from '../../../../utils/abort.js';

/**
 * The stop of the one sync under way: `begin()` starts one (stopping any
 * still under way as `superseded`), `stop(reason)` stops it, `end(controller)`
 * forgets it once it settled; `running` says whether one is under way.
 *
 * @returns {{begin: () => AbortController, end: (controller: AbortController) => void,
 *   stop: (reason: Error) => void, readonly running: boolean}}
 */
export function createSyncStop() {
  /** @type {AbortController|null} */
  let active = null;
  return Object.freeze({
    begin() {
      cancel(active, 'superseded', 'A newer Pull or Publish replaced this one.');
      active = new AbortController();
      return active;
    },
    end(controller) {
      if (active === controller) active = null;
    },
    /**
     * Stop the sync under way with why (module overview). Nothing happens
     * when none runs or it was stopped already: the first reason stands.
     *
     * @param {Error} reason
     */
    stop(reason) {
      if (!(reason instanceof Error) || !reason.message) {
        throw new TypeError('An annotation sync is stopped with an error saying why.');
      }
      if (active === null || active.signal.aborted) return;
      active.abort(reason);
    },
    get running() {
      return active !== null;
    },
  });
}

/**
 * Stop the sync `controller` owns when `signal` (its caller's, or the
 * context it belongs to) aborts, with that signal's reason. Returns the
 * remover.
 *
 * @param {AbortController} controller
 * @param {AbortSignal} signal
 * @returns {() => void}
 */
export function bindSyncOwner(controller, signal) {
  requireSignal(signal, 'Active annotation sync owner signal');
  return onAbort(signal, () => controller.abort(abortReason(signal)));
}

/**
 * What a sync that threw `error` failed with: once it was stopped, why it
 * was stopped (a step that failed because of the stop, an aborted request,
 * says no more), unless GitHub may have applied what was under way (an
 * operation whose outcome is unknown is said as such).
 *
 * @param {unknown} error
 * @param {AbortController} controller
 * @returns {unknown}
 */
export function syncFailureOf(error, controller) {
  if (error?.operation?.outcome === 'unknown') return error;
  if (!controller.signal.aborted) return error;
  return abortReason(controller.signal);
}

/**
 * Whether `error` is the failure the sync was stopped for (not a
 * cancellation: the connection lost), said as that failure.
 *
 * @param {unknown} error
 * @param {AbortController} controller
 */
export function isStoppedForFailure(error, controller) {
  return controller.signal.aborted && error === controller.signal.reason && !isCancellation(error);
}

/**
 * The outcome of a sync that was stopped (a cancellation): the person's own
 * stop ends its card with the stop's words; any other (a change of context,
 * a disconnect, another tab) withdraws the card -- whoever stopped it says
 * what happened. Words beyond the stop's own are the sync's news, which no
 * stopper knows (a Publish that GitHub had already partly accepted, and what
 * to do before publishing again): the card ends saying them, as a sync that
 * did not finish, whoever stopped it.
 *
 * @param {Error} error - A cancellation (`isCancellation`)
 * @param {{complete: Function, fail: Function, dismiss: Function}} notifications
 * @param {string|null} trackerId - The sync's card, or null for a quiet one
 * @param {string} [words] - What to say on the card (the stop's own words, or the sync's news with them)
 * @returns {{status: 'cancelled', kind: string, words: string}}
 */
export function stoppedSyncOutcome(error, notifications, trackerId, words = error.message) {
  const kind = cancellationKind(error);
  // Words other than the stop's own are the sync's news (a Publish GitHub
  // partly took): they stay on the card. A bare stop leaves nothing to say.
  const hasNews = words !== error.message;
  if (trackerId !== null && trackerId !== undefined) {
    if (kind === 'user') notifications.complete(trackerId, words);
    else if (hasNews) notifications.fail(trackerId, words);
    else notifications.dismiss(trackerId);
  }
  return { status: 'cancelled', kind, words };
}
