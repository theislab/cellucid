/**
 * @fileoverview One owner for the network awaits of application startup.
 *
 * Startup is a chain of awaits on servers the application does not control: a
 * health endpoint, a dataset catalog, opening the startup dataset (its
 * metadata, field lists and the embedding its first view draws), and the
 * published default session a sample advertises.
 * The interface is built after the catalog is read and before the startup
 * dataset loads, so the data controls are live — and can replace that load —
 * for the whole of it.
 * Each of them can stall without failing, and a stalled await leaves the page
 * waiting forever with nothing saying which request it is waiting on.
 *
 * Every such await runs through this owner, which
 *
 * - publishes the phase it belongs to as `data-startup-phase` on the root
 *   element, so a stalled page says where it stopped; and
 * - for the request/response phases, bounds the await with a deadline and
 *   hands the operation a signal that the deadline aborts, so a request that
 *   never answers ends startup through the terminal failure surface with an
 *   error naming the phase and the URL.
 *
 * Every request of a dataset's files bounds itself (`formats/io/byte-source.js`:
 * a request that stalls is made again, then fails naming its URL), so a step
 * that reads a dataset passes `progress` and its deadline measures silence,
 * not duration: it fires only when nothing at all has arrived for a whole
 * deadline, which no working read does, and says which reads were open
 * (`pending`).
 *
 * The positions and interface phases are published but not deadline-bound:
 * their duration scales with the dataset (a large embedding over a slow link
 * legitimately takes minutes), so a wall-clock limit there would fail a
 * startup that is progressing.
 *
 * @module app/startup-phase
 */

import { createDeadline } from '../utils/deadline.js';

/**
 * Phases in startup order. `ready` is published once the startup dataset has
 * loaded, or a choice the user made while it loaded has replaced it.
 */
const STARTUP_PHASES = Object.freeze([
  'sign-in',
  'health',
  'catalog',
  'ui',
  'dataset',
  'positions',
  'session',
  'ready'
]);

/** Deadline for one request/response startup step. */
export const STARTUP_STEP_DEADLINE_MS = 60_000;

/** `code` carried by the error a step raises when its deadline elapses. */
export const STARTUP_STALL_CODE = 'CELLUCID_STARTUP_STALLED';

const PHASE_DESCRIPTIONS = Object.freeze({
  'sign-in': 'completing GitHub sign-in',
  health: 'checking the data server',
  catalog: 'reading the dataset catalog',
  dataset: 'opening the dataset (its metadata, field lists and the embedding its first view draws)',
  positions: 'loading cell positions',
  ui: 'building the interface',
  session: 'reading the published default session',
  ready: 'running'
});

function requirePhase(phase) {
  if (!STARTUP_PHASES.includes(phase)) {
    throw new TypeError(`Unknown startup phase ${JSON.stringify(phase)}.`);
  }
  return phase;
}

/**
 * @param {string} phase
 * @param {string} target - URL (or named endpoint) the step was waiting on
 * @param {number} deadlineMs
 * @param {{silence?: boolean, pending?: string|null}} [details] - `silence`:
 *   the deadline measured time without progress; `pending`: what was being
 *   read when it elapsed
 * @returns {Error}
 */
function createStartupStallError(phase, target, deadlineMs, { silence = false, pending = null } = {}) {
  const seconds = deadlineMs / 1000;
  const error = new Error(
    `Startup stalled while ${PHASE_DESCRIPTIONS[requirePhase(phase)]}: ` +
    (silence
      ? `nothing arrived from ${target} for ${seconds} s`
      : `${target} did not answer within ${seconds} s`) +
    (pending === null || pending === '' ? '.' : `, while reading ${pending}.`)
  );
  error.name = 'TimeoutError';
  error.code = STARTUP_STALL_CODE;
  error.phase = phase;
  error.target = target;
  error.pending = pending;
  return error;
}

/**
 * @param {{ root: { dataset: Record<string, string> }, deadlineMs?: number }} options
 */
export function createStartupPhaseOwner(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    options.root === null ||
    typeof options.root !== 'object' ||
    options.root.dataset === null ||
    typeof options.root.dataset !== 'object'
  ) {
    throw new TypeError(
      'Startup phase owner requires the root element whose dataset it publishes.'
    );
  }
  const { root } = options;
  const deadlineMs = options.deadlineMs ?? STARTUP_STEP_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new RangeError('Startup step deadline must be a positive integer.');
  }
  const lifetime = new AbortController();
  let currentPhase = null;

  const enter = phase => {
    currentPhase = requirePhase(phase);
    root.dataset.startupPhase = currentPhase;
  };

  return Object.freeze({
    get phase() {
      return currentPhase;
    },

    /** Publish a phase whose awaits are not deadline-bound. */
    enter,

    /**
     * Run one request/response startup await under the deadline.
     *
     * The operation receives a signal that the deadline (or the end of
     * startup) aborts; it passes that signal to its fetches. An operation
     * that does not observe it is still raced against the deadline, so the
     * step ends either way.
     *
     * A step whose work grows with the data (opening a linked file reads
     * as much of it as its first view needs) passes `progress`: a
     * subscription to evidence that bytes are still arriving. Each report
     * restarts the deadline, so the step stalls only when nothing arrives
     * for a whole interval, however long the step takes.
     *
     * @template T
     * @param {string} phase
     * @param {string} target - URL or named endpoint, used in the stall error
     * @param {(signal: AbortSignal) => Promise<T>|T} operation
     * A step's `pending` names what it is waiting for when its deadline
     * elapses (the reads still open), for the stall error.
     *
     * @param {{progress?: (onProgress: () => void) => () => void, pending?: () => string|null}} [options]
     * @returns {Promise<T>}
     */
    async step(phase, target, operation, { progress = null, pending = null } = {}) {
      enter(phase);
      if (typeof target !== 'string' || target.length === 0) {
        throw new TypeError('A startup step must name what it waits on.');
      }
      if (typeof operation !== 'function') {
        throw new TypeError('A startup step requires an operation.');
      }
      if (progress !== null && typeof progress !== 'function') {
        throw new TypeError('A startup step progress source must be a subscription.');
      }
      if (pending !== null && typeof pending !== 'function') {
        throw new TypeError('A startup step pending description must be a function.');
      }
      const stallError = () => createStartupStallError(phase, target, deadlineMs, {
        silence: progress !== null,
        pending: pending?.() ?? null,
      });
      const deadline = createDeadline(deadlineMs);
      const stopProgress = progress === null ? null : progress(() => deadline.extend());
      const signal = AbortSignal.any([lifetime.signal, deadline.signal]);
      let onDeadline = null;
      const stalled = new Promise((_resolve, reject) => {
        onDeadline = () => reject(stallError());
        deadline.signal.addEventListener('abort', onDeadline, { once: true });
      });
      const work = Promise.resolve().then(() => operation(signal));
      // Whichever loses the race is still observed, never unhandled.
      stalled.catch(() => {});
      work.catch(() => {});
      try {
        return await Promise.race([work, stalled]);
      } catch (error) {
        // A fetch the deadline aborted rejects with its own abort error; the
        // stall is the cause worth reporting.
        if (deadline.signal.aborted && !lifetime.signal.aborted) {
          throw stallError();
        }
        throw error;
      } finally {
        stopProgress?.();
        deadline.release();
        deadline.signal.removeEventListener('abort', onDeadline);
      }
    },

    /** End startup: abort whatever startup request is still open. */
    retire(reason) {
      lifetime.abort(reason);
    }
  });
}
