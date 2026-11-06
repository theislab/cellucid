/**
 * @fileoverview The one way state changes: `dispatch(type, params, meta)`.
 *
 * Every control, every agent tool call, every Python or R command and every
 * replayed step goes through here, so each one is checked against the same
 * schema, ordered the same way, recorded as one history step with who made
 * it, and undoable the same way.
 *
 * - **Implementations** are provided by the module that owns the state
 *   (`provide(type, handler)`), so the orchestration that already lives there
 *   (reading a field before showing it, superseding an older choice) is reused
 *   as it is. A dispatch of a type nobody provides fails and names the type.
 * - **Ordering.** Two actions whose domains overlap run one after the other,
 *   in dispatch order; actions on disjoint domains run side by side. A
 *   `supersede` action cancels the unfinished one of its type first.
 * - **Recording.** A recorder (the history) is told before and after; it
 *   captures the touched domains and keeps one step when something changed.
 *   A handler that fails after changing something is rolled back to the
 *   before-values, so a failed action leaves no half-state. A read, a move
 *   of the history (effect `history`: undo, redo, a jump), another dataset
 *   opened and an act outside the state (effect `outside`: a file written,
 *   a publication) record nothing and run at once.
 * - **The person's permissions.** Every change an agent asks for (any
 *   action that is not a read) passes the confirmer first (`setConfirmer`,
 *   the agent presence: the person's permission settings), with the
 *   action's estimate of its work when its owner gives one
 *   (`provideEstimate`: time and bytes from what this page measured). The
 *   confirmer allows it, refuses it with its own sentence, or asks the
 *   person, and the agent waits; subscribers hear `asking` when the person
 *   is asked and `answered` when they answered (the relay tells a waiting
 *   agent; the chat bar says it waits). What the history cannot undo (the
 *   definition's `confirm`) is asked about before the action runs, or, for
 *   a definition with `confirmAt: 'handler'`, by its implementation
 *   (`ctx.confirm(detail)`) once it knows what it costs (a download's size,
 *   `detail`); never when nothing costs (a copy already kept). Without a
 *   confirmer an action with `confirm` is refused; a refusal changes
 *   nothing. Only an agent's action is asked about, and what any other
 *   origin that is not a click in the page publishes (`confirm:
 *   'publishes'`: a notebook's vote is asked as an agent's is); the person
 *   acts themselves, and otherwise a notebook, a session and a replay act
 *   for them. An
 *   agent's meta names its connection (`meta.connection`: id, kind, client,
 *   host), which a permission "for this chat" or "for this connection"
 *   keys on.
 * - **Who is acting.** Every dispatch, a read included, is told to
 *   subscribers as it starts and as it ends (`start`, then `done` or
 *   `failed`), with its meta (origin, agent, connection, turn), so the agent
 *   presence (`app/agent/presence/`) can say which agent acts now.
 *   `stop(match)` stops the dispatches whose meta matches (the person's
 *   Stop), from the moment they are dispatched: one waiting for its
 *   estimate, for the person's answer or at the gate never runs; one
 *   running ends as a cancellation, and a change is rolled back. The
 *   confirmer is given the dispatch's own `signal`, which aborts with either
 *   (its question goes).
 * - **Observed changes.** Settings controls and camera gestures change their
 *   owner first and are recorded after (`recordObserved`), so a control added
 *   to the markup is recorded without code here. One observed while an
 *   action on the same domains runs is part of that action's step. A
 *   gesture recorded only once it settles registers how to end it now
 *   (`addSettler`); the history calls `settle()` before it moves.
 * - **Turns.** An agent's or a notebook's meta names its turn, and what the
 *   history's turn record keeps of it: the model, the conversation, the
 *   message that acted and what was asked (`turnLabel`).
 *
 * @module app/actions/dispatcher
 */

import { withDefaults } from './schema.js';
import { MARKED_QUOTE, plainSentence } from './targets/names.js';
import { isSteplessEffect } from './catalog.js';
import { awaitWithSignal, cancel, cancelled, onAbort, throwIfAborted } from '../../utils/abort.js';

export const ACTION_ORIGINS = Object.freeze([
  'user', 'agent', 'host', 'session', 'replay', 'startup',
]);

/**
 * An action that was not applied, with the reason a person or agent can act
 * on. The sentence marks the names it quotes as data (`targets/names.js`
 * `quoteName`): `marked` is what an agent reads, `message` what a person
 * reads (each marked name written `"name"`). `missing`, when a name it was given resolves to nothing here (a target
 * resolver's refusal): `{kind: 'field'|'category'|'gene', name, field}`
 * (`field`: the field a category was looked for in, else null), what a
 * replay's report keeps so "Use instead" can offer a name in its place.
 */
export class ActionRefused extends Error {
  constructor(message, { code = 'refused', type = null, missing = null } = {}) {
    super(plainSentence(message));
    this.name = 'ActionRefused';
    this.marked = String(message);
    this.code = code;
    this.type = type;
    this.missing = missing;
  }
}

/**
 * The kinds of agent connection: Cellucid's chat bar, Claude or ChatGPT
 * through the relay (`connector`), or an agent app on this computer (Claude
 * Code, Claude Desktop, Cursor) through `cellucid mcp` of the Python or R
 * package and the viewer channel (`local`).
 */
export const AGENT_CONNECTION_KINDS = Object.freeze(['chat', 'connector', 'local']);

/**
 * Which connection an agent's action came through, as the permission
 * settings key it ("allow for this connection") and the history labels it:
 * `{id, kind, client, host}` (`client`: the app's own name, `host`: the
 * host that vouches for it), or null.
 */
function requireConnection(connection) {
  if (connection === undefined || connection === null) return null;
  if (typeof connection !== 'object' || typeof connection.id !== 'string' || connection.id.length === 0
    || !AGENT_CONNECTION_KINDS.includes(connection.kind)) {
    throw new TypeError(`An agent's connection names its id and kind (${AGENT_CONNECTION_KINDS.join(', ')})`);
  }
  for (const key of ['client', 'host']) {
    const value = connection[key] ?? null;
    if (value !== null && typeof value !== 'string') throw new TypeError(`An agent's connection ${key} is text or null`);
  }
  return Object.freeze({ id: connection.id, kind: connection.kind, client: connection.client ?? null, host: connection.host ?? null });
}

function requireMeta(meta) {
  const origin = meta?.origin ?? 'user';
  if (!ACTION_ORIGINS.includes(origin)) {
    throw new TypeError(`Action origin must be one of ${ACTION_ORIGINS.join(', ')}`);
  }
  const agent = meta?.agent ?? null;
  if (origin === 'agent' && (typeof agent !== 'string' || agent.length === 0)) {
    throw new TypeError('An agent action names its agent (Claude, ChatGPT, …)');
  }
  const host = meta?.host ?? null;
  const turn = meta?.turn ?? null;
  if (turn !== null && (typeof turn !== 'string' || turn.length === 0)) throw new TypeError('A turn is named by a non-empty text');
  const actsInTurns = origin === 'agent' || origin === 'host';
  return {
    origin,
    agent: origin === 'agent' ? agent : null,
    // The agent's model, its conversation and the message that acted (the
    // history's turn record and the step's `by`).
    model: origin === 'agent' ? optionalText(meta?.model, 'model') : null,
    conversation: actsInTurns ? optionalText(meta?.conversation, 'conversation') : null,
    message: actsInTurns ? optionalText(meta?.message, 'message') : null,
    connection: origin === 'agent' ? requireConnection(meta?.connection) : null,
    host: origin === 'host' ? host : null,
    turn,
    // What the turn was asked to do, in a few words (the turn's label).
    turnLabel: actsInTurns && turn !== null ? optionalText(meta?.turnLabel, 'turnLabel') : null,
    signal: meta?.signal ?? null,
    // Set only by the history when it applies a recorded step again: the
    // step it rewrites, the recorded step a replay applies, and a pass
    // through its own gate.
    rewrite: meta?.rewrite ?? null,
    replayOf: meta?.internal === true ? (meta?.replayOf ?? null) : null,
    internal: meta?.internal === true,
  };
}

function optionalText(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`A dispatch's ${label} is a non-empty text or null`);
  return value;
}

/**
 * @param {{catalog: ReturnType<typeof import('./catalog.js').createActionCatalog>}} options
 */
export function createActionDispatcher({ catalog }) {
  const handlers = new Map();
  /**
   * In-flight dispatches: {definition, domains:Set, done:Promise, controller,
   * applying}; `applying` once its before-values are kept and its handler runs.
   */
  const inFlight = new Set();
  /** Every dispatch from the moment it is made until it ends, reads included: {meta, controller}; what `stop` reaches. */
  const running = new Set();
  const listeners = new Set();
  let recorder = null;
  let confirmer = null;
  /** type → the owner's estimate of an action's work (`provideEstimate`). */
  const estimators = new Map();
  /** Resolves when a new action may start (the history holds it during a jump). */
  let gate = () => undefined;
  /** Owners of gestures recorded when they settle (a camera drag): each ends its gesture now (`settle`). */
  const settlers = new Set();
  /**
   * The page's application retired (`retire`): the cancellation every
   * dispatch under way ended with, and every later one is refused with; null
   * while the application runs.
   */
  let retired = null;

  function emit(event) {
    for (const listener of [...listeners]) {
      try { listener(event); } catch (error) { console.error('[actions] listener failed', error); }
    }
  }

  function overlapping(domains) {
    const waits = [];
    for (const entry of inFlight) {
      for (const domain of domains) {
        if (entry.domains.has(domain)) { waits.push(entry.done); break; }
      }
    }
    return waits;
  }

  /** The work an action would do, as its owner estimates it (null when it gives none or fails to). */
  async function estimateOf(definition, params, signal) {
    const estimator = estimators.get(definition.type);
    if (estimator === undefined) return null;
    try {
      const estimate = await estimator(params, { signal });
      return estimate ?? null;
    } catch (error) {
      if (signal?.aborted) throw error;
      console.error(`[actions] the estimate of ${definition.type} failed`, error);
      return null;
    }
  }

  /**
   * Pass an agent's change to the confirmer (resolves at once for a read and
   * for any other origin). At the start (`atHandler` false): every change,
   * with its estimate, and its `confirm` when it is asked before it runs.
   * From its implementation (`atHandler`, `ctx.confirm(detail)`): its
   * `confirm`, with `detail`, one sentence on what makes it cost.
   */
  async function confirmIfNeeded(definition, params, meta, { signal, atHandler = false, detail = null }) {
    if (meta.origin === 'user' || definition.effect === 'read') return;
    const askedNow = definition.confirm !== null && (definition.confirmAt === 'handler') === atHandler;
    const confirm = askedNow ? definition.confirm : null;
    // Only an agent is asked about every change; any other origin that is
    // not a click in the page (a notebook, and a session, a replay or the
    // start, which never publish) is asked before it publishes.
    if (meta.origin !== 'agent' && confirm !== 'publishes') return;
    if (confirmer === null) {
      if (confirm === null) return;
      throw new ActionRefused(
        `${definition.title} needs the person's go-ahead, and this page cannot ask for it`,
        { code: 'needs-confirmation', type: definition.type },
      );
    }
    const estimate = atHandler ? null : await estimateOf(definition, params, signal);
    // Whoever waits on the agent's call (the relay, the chat bar) hears when
    // the person is asked, and when they answered.
    let asked = false;
    let yes = false;
    const asking = () => {
      if (asked) return;
      asked = true;
      emit({ kind: 'asking', type: definition.type, params, meta, detail });
    };
    try {
      yes = await confirmer({ definition, params, meta, signal, estimate, confirm, detail, stage: atHandler ? 'handler' : 'start', asking });
    } finally {
      if (asked) emit({ kind: 'answered', type: definition.type, params, meta, allowed: yes === true });
    }
    if (yes !== true) {
      throw new ActionRefused(`The person declined, so this was not done: ${definition.title} (${definition.describe(params, null, MARKED_QUOTE)}).`, {
        code: 'declined', type: definition.type,
      });
    }
  }

  /** The `ctx.confirm(detail)` a handler asks with (a `confirmAt: 'handler'` action); `signal`: its dispatch's. */
  function askerFor(definition, params, meta, signal) {
    return detail => {
      if (definition.confirm === null || definition.confirmAt !== 'handler') {
        return Promise.reject(new TypeError(`"${definition.type}" asks the person only as its definition says (confirm, confirmAt: 'handler')`));
      }
      if (detail !== null && (typeof detail !== 'string' || detail.length === 0)) {
        return Promise.reject(new TypeError('What a confirmation is about is one sentence, or null'));
      }
      return confirmIfNeeded(definition, params, meta, { signal, atHandler: true, detail });
    };
  }

  /**
   * Apply one action.
   * @param {string} type
   * @param {object} params
   * @param {{origin?: string, agent?: string, model?: string, conversation?: string, message?: string, host?: string,
   *   turn?: string, turnLabel?: string, signal?: AbortSignal}} [meta]
   * @returns {Promise<{outcome: unknown, step: object|null}>}
   */
  async function dispatch(type, params = {}, meta = {}) {
    if (retired !== null) throw retired;
    const definition = catalog.check(type, params);
    const exactMeta = requireMeta(meta);
    const exactParams = withDefaults(definition.params, params);
    const handler = handlers.get(type);
    if (handler === undefined) {
      throw new ActionRefused(`"${definition.title}" is not available on this page yet`, {
        code: 'unavailable', type,
      });
    }
    // Its work, from now on: `stop` (the person's Stop of an agent) reaches
    // it while its estimate is made, while the person is asked and while it
    // waits at the gate, as while it runs; so does its caller's signal.
    const controller = new AbortController();
    const { signal } = controller;
    const work = { meta: exactMeta, controller };
    running.add(work);
    const removeOuter = onAbort(exactMeta.signal, () => controller.abort(exactMeta.signal.reason));
    const confirm = askerFor(definition, exactParams, exactMeta, signal);
    try {
      await awaitWithSignal(confirmIfNeeded(definition, exactParams, exactMeta, { signal }), signal);
      if (isSteplessEffect(definition.effect)) {
        // A read, a move of the history (undo, redo, a jump), another
        // dataset opened or an act outside the state (a file written, a
        // publication, what this browser keeps removed): no step, so no
        // recorder, and no gate -- the history runs its move exclusively
        // itself (waiting for the actions in flight); waiting at its gate
        // here would wait for that move. All but a read are changes the
        // person's permissions govern, as every other change of an agent's.
        emit({ kind: 'start', type, params: exactParams, meta: exactMeta });
        try {
          const outcome = await handler(exactParams, { signal, meta: exactMeta, confirm });
          emit({ kind: 'done', type, params: exactParams, meta: exactMeta, step: null, outcome });
          return { outcome: outcome ?? null, step: null };
        } catch (error) {
          emit({ kind: 'failed', type, params: exactParams, meta: exactMeta, error });
          throw error;
        }
      }
      if (!exactMeta.internal) await awaitWithSignal(gate(), signal);
      throwIfAborted(signal);
      return await apply(definition, exactParams, exactMeta, handler, controller, confirm);
    } finally {
      removeOuter();
      running.delete(work);
    }
  }

  /** Apply a change (after its go-ahead and the gate): in order with the others on its domains, recorded as a step. */
  async function apply(definition, exactParams, exactMeta, handler, controller, confirm) {
    const { type } = definition;
    if (definition.supersede) {
      for (const entry of inFlight) {
        if (entry.definition.type === type) entry.controller.abort(new ActionRefused('A newer choice replaced it', { code: 'superseded', type }));
      }
    }
    const domains = new Set(definition.touches);
    const waits = overlapping(domains);
    let settle;
    const entry = { definition, domains, controller, applying: false, done: new Promise(resolve => { settle = resolve; }) };
    inFlight.add(entry);
    emit({ kind: 'start', type, params: exactParams, meta: exactMeta });
    try {
      await Promise.all(waits);
      throwIfAborted(controller.signal);
      const token = recorder === null ? null : await recorder.before({ definition, params: exactParams, meta: exactMeta });
      entry.applying = true;
      let outcome;
      try {
        outcome = await handler(exactParams, { signal: controller.signal, meta: exactMeta, confirm });
      } catch (error) {
        // A retired page has no state left to put back.
        if (token !== null && retired === null) await recorder.failed(token, error);
        throw error;
      }
      // Nor a step to record: its owners are being withdrawn.
      if (retired !== null) throw retired;
      const step = token === null ? null : await recorder.after(token, outcome ?? null);
      emit({ kind: 'done', type, params: exactParams, meta: exactMeta, step, outcome });
      return { outcome: outcome ?? null, step };
    } catch (error) {
      // Retired meanwhile: the owners of its state may be withdrawn under its
      // recording, so whatever failed after is the page closing, not a failure.
      const reason = retired ?? error;
      emit({ kind: 'failed', type, params: exactParams, meta: exactMeta, error: reason });
      throw reason;
    } finally {
      inFlight.delete(entry);
      settle();
    }
  }

  /**
   * Stop the dispatches whose meta `match` names (every key given must
   * equal: `origin`, `agent`, `turn`): the person's Stop of an agent. Each is
   * aborted with `reason` (a cancellation, `utils/abort.js`) wherever it is:
   * its estimate, a question to the person, the gate (it never runs), or
   * running (a read ends and a change is rolled back). Returns how many
   * were stopped.
   *
   * @param {{origin?: string, agent?: string, turn?: string}} match
   * @param {Error} reason
   */
  function stop(match, reason) {
    const keys = Object.keys(match ?? {});
    if (keys.length === 0) throw new TypeError('Stopping names whose work to stop (origin, agent or turn)');
    let stopped = 0;
    for (const work of [...running]) {
      if (work.controller.signal.aborted || !keys.every(key => work.meta[key] === match[key])) continue;
      work.controller.abort(reason);
      stopped += 1;
    }
    return stopped;
  }

  /**
   * Record a change its owner already made (a settings control, a camera
   * gesture). Call it synchronously from the owner's change event: a change
   * the history itself made while showing another step is not a step.
   * `outcome` is what a handler would have returned (the setting's label,
   * for one), so the step reads the same as a dispatched one. `after`, when
   * the change set off work that changes state too (an analysis's redraw,
   * its run after a delay), resolves once that work has settled: the step is
   * recorded then and holds all of it (`recorder.observed`).
   */
  function recordObserved(type, params, meta = {}, outcome = null, { after = null } = {}) {
    const definition = catalog.check(type, params);
    const exactMeta = requireMeta(meta);
    if (recorder === null) return Promise.resolve(null);
    // A change made while an action on the same state runs (a camera the
    // cells read again put back, a control a restore sets) is that action's:
    // its step holds it.
    for (const entry of inFlight) {
      if (entry.applying && definition.touches.some(domain => entry.domains.has(domain))) return Promise.resolve(null);
    }
    return recorder.observed({ definition, params: withDefaults(definition.params, params), meta: exactMeta, outcome, after })
      .then(step => {
        if (step !== null) emit({ kind: 'done', type, params, meta: exactMeta, step, outcome });
        return step;
      });
  }
  return Object.freeze({
    dispatch,
    recordObserved,
    stop,
    /**
     * @param {string} type
     * @param {(params: object, ctx: {signal: AbortSignal, meta: object, confirm: (detail: string|null) => Promise<void>}) => unknown} handler
     *   `ctx.confirm`: for a `confirmAt: 'handler'` action, ask the person now
     *   (an agent's action only; refused: `ActionRefused` code `declined`)
     */
    provide(type, handler) {
      catalog.get(type);
      if (typeof handler !== 'function') throw new TypeError(`Action "${type}" handler must be a function`);
      if (handlers.has(type)) throw new Error(`Action "${type}" already has an implementation`);
      handlers.set(type, handler);
      return () => { if (handlers.get(type) === handler) handlers.delete(type); };
    },
    provided: type => handlers.has(type),
    /**
     * What an action of `type` would do, estimated by the owner of its
     * state from what this page measured (`{ms, bytes, what}`: the time it
     * would take, the bytes it would download, one short phrase; each null
     * when not known). The agent presence judges heavy work by it.
     * @param {string} type
     * @param {(params: object, ctx: {signal: AbortSignal|null}) => (object|null|Promise<object|null>)} estimator
     */
    provideEstimate(type, estimator) {
      catalog.get(type);
      if (typeof estimator !== 'function') throw new TypeError(`Action "${type}" estimate must be a function`);
      if (estimators.has(type)) throw new Error(`Action "${type}" already has an estimate`);
      estimators.set(type, estimator);
      return () => { if (estimators.get(type) === estimator) estimators.delete(type); };
    },
    unprovided: () => catalog.list().map(d => d.type).filter(type => !handlers.has(type)),
    /**
     * Register how a gesture recorded only once it settles (a camera drag,
     * recorded at its settle) is ended now: `settle()` records its change at
     * once through `recordObserved`, so the history never moves before the
     * gesture is a step. Returns the remover.
     * @param {() => (void|Promise<void>)} settle
     */
    addSettler(settle) {
      if (typeof settle !== 'function') throw new TypeError('A settler is a function');
      settlers.add(settle);
      return () => settlers.delete(settle);
    },
    /** End every gesture still settling now (`addSettler`): what the history does before a move. */
    async settle() {
      for (const settle of [...settlers]) {
        try { await settle(); } catch (error) { console.error('[actions] a gesture could not be settled', error); }
      }
    },
    /** The changes running now, oldest first (what a move waits for: "Waiting for …"). */
    running: () => [...inFlight].map(entry => ({ type: entry.definition.type, title: entry.definition.title, applying: entry.applying })),
    setRecorder(next) { recorder = next; },
    setConfirmer(next) { confirmer = next; },
    /** @param {() => (Promise<void>|void)} next */
    setGate(next) { gate = next; },
    /** @param {(event: object) => void} listener */
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /**
     * The page's application retires (its teardown, before the owners of
     * the state are withdrawn): every dispatch under way is stopped with one
     * cancellation (kind `closed`), and ends with it wherever it is, its
     * recording included, so none records a step or puts state back into
     * owners withdrawn under it; every later dispatch is refused with it. A
     * cancellation is never said as a failure (`control-dispatch.js`).
     * Synchronous: the teardown runs its operations in order without
     * waiting. Final for the page.
     */
    retire() {
      if (retired !== null) return;
      retired = cancelled('closed', 'The page is closing.');
      for (const work of [...running]) cancel(work.controller, 'closed', 'The page is closing.');
    },
    /** Resolves once nothing is in flight (tests, a save). */
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight].map(entry => entry.done));
    },
    catalog,
  });
}
