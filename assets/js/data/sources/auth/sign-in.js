/**
 * Sign-in steps waiting on the person: "Private file on Google Drive. [Sign
 * in to Google]", "Google sign-in expired. [Sign in again]".
 *
 * A provider that cannot go on without the person asks for a step and waits
 * on it. The step's button runs `act` inside the click, because a sign-in
 * popup opens only from a click. Reads waiting on a step pause; nothing is
 * cancelled unless the person cancels. One step per account is shown at a
 * time: a second request for the same account and kind joins the first, so
 * twenty parallel reads whose token expired show one "Sign in again". Each
 * request is a wait on the person (`utils/person-wait.js`) until it settles:
 * a deadline measuring the network's silence stands still meanwhile.
 *
 * This module holds state only; `app/source-sign-in-view.js` shows it, in the
 * Session panel under the address bar and as a notification.
 *
 * @module data/sources/auth/sign-in
 */

import { whileWaitingOnPerson } from '../../../utils/person-wait.js';

/**
 * @typedef {Object} SignInStep
 * @property {number} id
 * @property {'google'|'microsoft'} account
 * @property {string} kind - `sign-in`, `expired`, `more-access`, `pick`
 * @property {string} text - One short line: what is needed
 * @property {string} action - The button's label
 * @property {boolean} ready - The button works now (the provider's script has loaded)
 * @property {boolean} working - The sign-in it started is under way
 * @property {string|null} problem - Why the last attempt did not finish
 * @property {{url: string, label: string}|null} help - Where the person reads
 *   what to do about that (an administrator's approval), from the failure
 */

/**
 * What a step's action is given when the person takes it: `signal`, aborted
 * once the step ends (it succeeded, it was dismissed, nobody waits for it),
 * and `report(error)`, which says an attempt did not finish (its window was
 * found closed) while the action still listens: a sign-in that finishes after
 * all still ends the step, and the button is offered again meanwhile.
 *
 * @typedef {{signal: AbortSignal, report: (error: SignInFailure) => void}} SignInAttempt
 */

/**
 * What a failed attempt of a step's action may carry beside its message:
 * `retryAction`, the button's label for the next attempt when trying the
 * same way again would only fail again ("Use another account"), and
 * `help`, `{url, label}`, the page that says what to do.
 *
 * @typedef {Error & {final?: boolean, retryAction?: string, help?: {url: string, label: string}}} SignInFailure
 */

export class SignInSteps {
  constructor() {
    /** @type {Map<number, Object>} */
    this._steps = new Map();
    this._nextId = 1;
    this._listeners = new Set();
  }

  /**
   * Ask the person for a step and wait until its action succeeds.
   *
   * @param {{account: string, kind: string, text: string, action: string,
   *   act: (attempt: SignInAttempt) => Promise<unknown>, ready?: Promise<unknown>|null,
   *   signal?: AbortSignal|null}} request
   *   `act` runs inside the button's click; it must open any popup before
   *   its first `await`. `ready` settles once the button can work.
   * @returns {Promise<unknown>} What `act` resolved with
   */
  request({ account, kind, text, action, act, ready = null, signal = null }) {
    if (typeof act !== 'function') throw new TypeError('A sign-in step needs act().');
    if (signal?.aborted) return Promise.reject(signal.reason);
    let step = [...this._steps.values()].find(item => item.account === account && item.kind === kind) ?? null;
    if (step === null) {
      step = {
        id: this._nextId++,
        account,
        kind,
        text,
        action,
        act,
        ready: ready === null,
        working: false,
        attempt: 0,
        problem: null,
        help: null,
        retryAction: null,
        waiters: new Set(),
        ended: new AbortController(),
      };
      this._steps.set(step.id, step);
      if (ready !== null) {
        const id = step.id;
        Promise.resolve(ready).then(
          () => {
            const current = this._steps.get(id);
            if (current === undefined) return;
            current.ready = true;
            this._publish();
          },
          error => this._reject(id, error)
        );
      }
    }
    const current = step;
    const promise = new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, stop: null };
      if (signal !== null) {
        const onAbort = () => {
          current.waiters.delete(waiter);
          reject(signal.reason);
          // Nobody waits any more: the step goes.
          if (current.waiters.size === 0 && this._steps.get(current.id) === current && !current.working) {
            this._end(current);
            this._publish();
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.stop = () => signal.removeEventListener('abort', onAbort);
      }
      current.waiters.add(waiter);
    });
    this._publish();
    return whileWaitingOnPerson(promise);
  }

  /**
   * Take a step's action: called from the button's click handler, so the
   * sign-in popup opens inside the click. Taking it again while it is under
   * way starts another attempt (a sign-in window lost behind others comes
   * back): an earlier attempt's failure is then ignored, and whichever
   * attempt signs in first ends the step.
   *
   * @param {number} id
   */
  run(id) {
    const step = this._steps.get(id);
    if (step === undefined || !step.ready) return;
    const attempt = ++step.attempt;
    step.working = true;
    step.problem = null;
    step.help = null;
    const latest = () => this._steps.get(id) === step && step.attempt === attempt;
    // The person can try again: the step stays, saying what happened, what
    // to read about it, and how the next attempt differs.
    const offerAgain = error => {
      step.working = false;
      step.problem = error?.message ?? String(error);
      step.help = validHelp(error?.help);
      step.retryAction = typeof error?.retryAction === 'string' && error.retryAction.trim() !== '' ? error.retryAction : null;
      this._publish();
    };
    const report = error => {
      if (latest()) offerAgain(error);
    };
    let outcome;
    try {
      outcome = Promise.resolve(step.act({ signal: step.ended.signal, report }));
    } catch (error) {
      outcome = Promise.reject(error);
    }
    this._publish();
    outcome.then(
      value => {
        if (this._steps.get(id) !== step) return;
        this._end(step);
        for (const waiter of step.waiters) {
          waiter.stop?.();
          waiter.resolve(value);
        }
        this._publish();
      },
      error => {
        if (!latest()) return;
        if (error?.final === true) {
          this._reject(id, error);
          return;
        }
        offerAgain(error);
      }
    );
  }

  /**
   * The person dismissed the step: everything waiting on it stops.
   *
   * @param {number} id
   */
  dismiss(id) {
    this._reject(id, new DOMException('Sign-in was dismissed.', 'AbortError'));
  }

  /** @returns {SignInStep[]} */
  list() {
    return [...this._steps.values()].map(step => Object.freeze({
      id: step.id,
      account: step.account,
      kind: step.kind,
      text: step.text,
      action: step.retryAction ?? step.action,
      ready: step.ready,
      working: step.working,
      problem: step.problem,
      help: step.help,
    }));
  }

  /**
   * @param {(steps: SignInStep[]) => void} listener
   * @returns {() => void}
   */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** @private The step goes; whatever its attempts still listen for stops. */
  _end(step) {
    this._steps.delete(step.id);
    step.ended.abort(new DOMException('The sign-in step ended.', 'AbortError'));
  }

  /** @private */
  _reject(id, error) {
    const step = this._steps.get(id);
    if (step === undefined) return;
    this._end(step);
    for (const waiter of step.waiters) {
      waiter.stop?.();
      waiter.reject(error);
    }
    this._publish();
  }

  /** @private */
  _publish() {
    const steps = this.list();
    for (const listener of this._listeners) {
      try {
        listener(steps);
      } catch (error) {
        console.error('[cellucid:sign-in] A sign-in display failed:', error);
      }
    }
  }
}

/** A failure's help link when it is one: an https address and its words. */
function validHelp(help) {
  if (help === null || typeof help !== 'object') return null;
  if (typeof help.url !== 'string' || !help.url.startsWith('https://')) return null;
  if (typeof help.label !== 'string' || help.label.trim() === '') return null;
  return Object.freeze({ url: help.url, label: help.label });
}

/**
 * A failure of a step's action that ends the step (the person cannot fix it
 * by trying again: an organisation's policy, a site that is not configured).
 *
 * @param {Error} error
 * @returns {Error}
 */
export function finalSignInFailure(error) {
  error.final = true;
  return error;
}

let steps = null;

/** The page's sign-in steps. */
export function getSignInSteps() {
  steps ??= new SignInSteps();
  return steps;
}
