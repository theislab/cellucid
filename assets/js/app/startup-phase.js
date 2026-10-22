/**
 * @fileoverview One owner for the network awaits of application startup.
 *
 * Startup is a chain of awaits on servers the application does not control: a
 * health endpoint, a dataset catalog, a dataset's identity and manifests, its
 * default embedding, and the published default session a sample advertises.
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
  'identity',
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
  identity: 'reading the dataset identity and manifests',
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
 * @returns {Error}
 */
function createStartupStallError(phase, target, deadlineMs) {
  const error = new Error(
    `Startup stalled while ${PHASE_DESCRIPTIONS[requirePhase(phase)]}: ` +
    `${target} did not answer within ${deadlineMs / 1000} s.`
  );
  error.name = 'TimeoutError';
  error.code = STARTUP_STALL_CODE;
  error.phase = phase;
  error.target = target;
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
     * @template T
     * @param {string} phase
     * @param {string} target - URL or named endpoint, used in the stall error
     * @param {(signal: AbortSignal) => Promise<T>|T} operation
     * @returns {Promise<T>}
     */
    async step(phase, target, operation) {
      enter(phase);
      if (typeof target !== 'string' || target.length === 0) {
        throw new TypeError('A startup step must name what it waits on.');
      }
      if (typeof operation !== 'function') {
        throw new TypeError('A startup step requires an operation.');
      }
      const deadline = createDeadline(deadlineMs);
      const signal = AbortSignal.any([lifetime.signal, deadline.signal]);
      let onDeadline = null;
      const stalled = new Promise((_resolve, reject) => {
        onDeadline = () => reject(
          createStartupStallError(phase, target, deadlineMs)
        );
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
          throw createStartupStallError(phase, target, deadlineMs);
        }
        throw error;
      } finally {
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
