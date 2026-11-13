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
 *   (`provideEstimate`: time and bytes from what this page measured; an
 *   estimate that finds the action refused refuses it before anyone is
 *   asked). The
 *   confirmer allows it, refuses it with its own sentence, or asks the
 *   person, and the agent waits; subscribers hear `asking` when the person
 *   is asked and `answered` when they answered (the relay tells a waiting
 *   agent; the chat bar says it waits). What the history cannot undo (the
 *   definition's `confirm`) is asked about before the action runs, or, for
 *   a definition with `confirmAt: 'handler'`, by its implementation
 *   (`ctx.confirm(detail)`) once it knows what it costs (a download's size,
 *   `detail`); never when nothing costs (a copy already kept). Heavy work
 *   an implementation finds only once it runs (what restoring a saved
 *   state reads, the cells' totals a new matrix needs) is asked about then
 *   (`ctx.heavy(estimate)`), as an estimate given at the start would have
 *   been, unless the start was already judged heavy. An action that may
 *   fetch an address its parameters name (`opensLinks`: a dataset's link)
 *   asks, by its implementation and before anything is requested, about an
 *   address the person has not seen in this tab (`ctx.confirmLink(address)`,
 *   the kind `unseen-link`). Without a
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
import { createListenerSet } from '../../utils/listener-set.js';
import { promiseWithResolvers } from '../../utils/promise-resolvers.js';

export const ACTION_ORIGINS = Object.freeze([
  'user', 'agent', 'host', 'session', 'replay', 'startup',
]);

/** The notebook hosts an action of origin `host` comes from, by language (a step records it: `By.host`). */
export const ACTION_HOSTS = Object.freeze(['python', 'r']);

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
 * `{id, kind, client, host, known}` (`client`: the app's own name, `host`:
 * the host that vouches for it, `known`: whether that host vouches for the
 * name, Claude's and ChatGPT's through the relay), or null.
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
  if (connection.known !== undefined && typeof connection.known !== 'boolean') throw new TypeError('An agent\'s connection known is true or false');
  return Object.freeze({
    id: connection.id, kind: connection.kind, client: connection.client ?? null, host: connection.host ?? null, known: connection.known === true,
  });
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
  // Checked here, before anything runs: the history records it (`By.host`), and refuses a step without one.
  if (origin === 'host' && !ACTION_HOSTS.includes(host)) {
    throw new TypeError(`A host action names its language: one of ${ACTION_HOSTS.join(', ')}`);
  }
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
    // Heavy work an internal dispatch finds is its outer action's (a replay, a load that replays):
    // the outer action's `heavy`, which asks its agent or names the work on its load's progress line.
    heavy: meta?.internal === true && typeof meta?.heavy === 'function' ? meta.heavy : null,
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
  /**
   * Every dispatch from the moment it is made until it ends, reads included:
   * {meta, controller, asking}; what `stop` reaches and `idle` waits
   * for. `asking`: how many of the person's answers it waits for now (asked
   * at its start, by its implementation, or about heavy work an internal
   * dispatch it runs finds: `askConfirmer`).
   */
  const running = new Set();
  /** Wakes each `idle` waiting now: a dispatch ended, or the person was asked or answered. */
  const idleWaiters = new Set();
  function runningChanged() {
    const waiters = [...idleWaiters];
    idleWaiters.clear();
    for (const wake of waiters) wake();
  }
  /**
   * Ask the confirmer `request` on behalf of the dispatches `works`, and tell
   * whoever waits on them when the person is asked and when they answered:
   * each of `works` waits for the person from the moment the confirmer says
   * it asks (its `asking()`, never for a change its settings allow at once)
   * until the answer. Resolves the confirmer's answer.
   */
  async function askConfirmer(works, request) {
    const { definition, params, meta, detail } = request;
    let asked = false;
    let yes = false;
    const asking = () => {
      if (asked) return;
      asked = true;
      for (const work of works) work.asking++;
      runningChanged();
      emit({ kind: 'asking', type: definition.type, params, meta, detail });
    };
    try {
      yes = await confirmer({ ...request, asking });
      return yes;
    } finally {
      if (asked) {
        for (const work of works) work.asking--;
        runningChanged();
        emit({ kind: 'answered', type: definition.type, params, meta, allowed: yes === true });
      }
    }
  }
  /** Each `ctx.heavy` this dispatcher made → its asker given the dispatches that wait on it too (`heavyAskerFor`). */
  const heavyAskers = new WeakMap();
  /**
   * Work an action started that goes on after it answers (`ctx.ongoing(stop)`:
   * a looping camera path), {meta, stop}, until the work ends or is stopped.
   * It belongs to the turn that started it: `stop` reaches it as it reaches
   * the dispatches of that turn, so a film an agent set looping never
   * outlives the turn the person stopped.
   */
  const ongoingWork = new Set();
  const listeners = createListenerSet('the actions');
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
    listeners.notify(event);
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
  async function estimateOf(definition, params, signal, meta) {
    const estimator = estimators.get(definition.type);
    if (estimator === undefined) return null;
    try {
      const estimate = await estimator(params, { signal, meta });
      return estimate ?? null;
    } catch (error) {
      // An estimate that finds the action refused refuses it before the person is asked:
      // never a card approved for a squash of someone else's steps that is then refused.
      if (signal?.aborted || error instanceof ActionRefused) throw error;
      console.error(`[actions] the estimate of ${definition.type} failed`, error);
      return null;
    }
  }

  /**
   * Pass an agent's change to the confirmer (resolves at once for a read and
   * for any other origin). At the start (`atHandler` false): every change,
   * with its estimate, and its `confirm` when it is asked before it runs.
   * From its implementation (`atHandler`, `ctx.confirm(detail)`): its
   * `confirm`, with `detail`, one sentence on what makes it cost. Resolves
   * the estimate it was asked with at the start (null when none was made):
   * heavy work its implementation finds later is judged against it
   * (`heavyAskerFor`).
   */
  async function confirmIfNeeded(definition, params, meta, { signal, work, atHandler = false, detail = null, kind = null }) {
    if (meta.origin === 'user' || definition.effect === 'read') return null;
    const askedNow = definition.confirm !== null && (definition.confirmAt === 'handler') === atHandler;
    // `kind`: a question the implementation asks of its own (an unseen link), not the definition's `confirm`.
    const confirm = kind ?? (askedNow ? definition.confirm : null);
    // Only an agent is asked about every change; any other origin that is
    // not a click in the page (a notebook, and a session, a replay or the
    // start, which never publish) is asked before it publishes.
    if (meta.origin !== 'agent' && confirm !== 'publishes') return null;
    if (confirmer === null) {
      if (confirm === null) return null;
      throw new ActionRefused(
        `${definition.title} needs the person's go-ahead, and this page cannot ask for it`,
        { code: 'needs-confirmation', type: definition.type },
      );
    }
    const estimate = atHandler ? null : await estimateOf(definition, params, signal, meta);
    // Whoever waits on the agent's call (the relay, the chat bar) hears when
    // the person is asked, and when they answered.
    const yes = await askConfirmer([work], { definition, params, meta, signal, estimate, confirm, detail, stage: atHandler ? 'handler' : 'start' });
    if (yes !== true) {
      throw new ActionRefused(`The person declined, so this was not done: ${definition.title} (${definition.describe(params, null, MARKED_QUOTE)}).`, {
        code: 'declined', type: definition.type,
      });
    }
    return estimate;
  }

  /**
   * The `ctx.heavy(estimate)` a handler asks with when it finds work only
   * once it runs (what restoring a saved state reads, the cells' totals a
   * new matrix needs): `estimate` as `provideEstimate` gives one (`{ms,
   * bytes, what}`, and `doing`: the work as a progress line says it while it
   * runs). An internal dispatch hands it to its outer action's `heavy`
   * (`meta.heavy`). An agent's action is judged as at its start, by the
   * person's heavy-work permission, unless its start already was (its own
   * estimate heavy: asked, or allowed, then); any other origin acts for the
   * person and is not asked. Rejects with the refusal when declined.
   * `started()`: the estimate the start was asked with. `work`: its
   * dispatch, which waits for the person while they are asked, as does
   * each internal dispatch whose heavy work it is asked about.
   */
  function heavyAskerFor(definition, params, meta, signal, started, work) {
    const ask = async (estimate, waiting) => {
      if (estimate === null || estimate === undefined) return;
      if (typeof estimate !== 'object' || typeof estimate.what !== 'string' || estimate.what.length === 0
        || (estimate.doing !== undefined && (typeof estimate.doing !== 'string' || estimate.doing.length === 0))) {
        throw new TypeError('Heavy work found by a handler is an estimate {ms, bytes, what, doing?}');
      }
      if (meta.heavy !== null) {
        const outer = heavyAskers.get(meta.heavy);
        return outer === undefined ? meta.heavy(estimate) : outer(estimate, waiting);
      }
      if (meta.origin !== 'agent' || definition.effect === 'read' || confirmer === null) return;
      throwIfAborted(signal);
      const detail = estimate.what;
      const yes = await askConfirmer(waiting, { definition, params, meta, signal, estimate, confirm: null, detail, stage: 'handler', started: started() });
      if (yes !== true) {
        throw new ActionRefused(`The person declined, so this was not done: ${definition.title} (${definition.describe(params, null, MARKED_QUOTE)}). ${plainSentence(detail)}.`, {
          code: 'declined', type: definition.type,
        });
      }
    };
    const heavy = estimate => ask(estimate, [work]);
    heavyAskers.set(heavy, (estimate, waiting) => ask(estimate, [work, ...waiting]));
    return heavy;
  }

  /** The `ctx.confirm(detail)` a handler asks with (a `confirmAt: 'handler'` action); `signal`: its dispatch's. */
  function askerFor(definition, params, meta, signal, work) {
    return detail => {
      if (definition.confirm === null || definition.confirmAt !== 'handler') {
        return Promise.reject(new TypeError(`"${definition.type}" asks the person only as its definition says (confirm, confirmAt: 'handler')`));
      }
      if (detail !== null && (typeof detail !== 'string' || detail.length === 0)) {
        return Promise.reject(new TypeError('What a confirmation is about is one sentence, or null'));
      }
      return confirmIfNeeded(definition, params, meta, { signal, work, atHandler: true, detail });
    };
  }

  /**
   * The `ctx.confirmReplacing(detail)` a handler of an action that replaces
   * the dataset shown (`effect: 'dataset'`) asks with when the work on it is
   * not kept in this browser (`app/unkept-work-guard.js`): of the kind
   * `replaces-unkept`, with what would be lost in the sentence the card
   * shows. Only an agent is asked; any other origin is the person's own
   * choice, asked in the page. Rejects with the refusal when declined.
   */
  function replaceAskerFor(definition, params, meta, signal, work) {
    return detail => {
      if (definition.effect !== 'dataset') {
        return Promise.reject(new TypeError(`"${definition.type}" does not replace the dataset shown (effect 'dataset')`));
      }
      if (typeof detail !== 'string' || detail.length === 0) {
        return Promise.reject(new TypeError('What would be lost is one sentence'));
      }
      return confirmIfNeeded(definition, params, meta, { signal, work, atHandler: true, detail, kind: 'replaces-unkept' });
    };
  }

  /**
   * The `ctx.confirmLink(address)` a handler of an `opensLinks` action asks
   * with before it requests an address the person has not seen in this tab
   * (the handler tells: `ui/modules/seen-addresses.js`): of the kind
   * `unseen-link`, with the address, marked as data, in the sentence the
   * card shows and the waiting agent reads. Only an agent is asked; a
   * notebook, a session or a replay acts for the person. Rejects with the
   * refusal when declined.
   */
  function linkAskerFor(definition, params, meta, signal, work) {
    return address => {
      if (definition.opensLinks !== true) {
        return Promise.reject(new TypeError(`"${definition.type}" fetches no address its parameters name (opensLinks)`));
      }
      if (typeof address !== 'string' || address.length === 0) {
        return Promise.reject(new TypeError('The address asked about is its text'));
      }
      const detail = `It opens ${MARKED_QUOTE(address)}, an address not typed, pasted or opened in this tab before.`;
      return confirmIfNeeded(definition, params, meta, { signal, work, atHandler: true, detail, kind: 'unseen-link' });
    };
  }

  /**
   * Apply one action.
   * @param {string} type
   * @param {object} params
   * @param {{origin?: string, agent?: string, model?: string, conversation?: string, message?: string, host?: string,
   *   turn?: string, turnLabel?: string, signal?: AbortSignal}} [meta]
   * @returns {Promise<{outcome: unknown, step: object|null, unrecorded: string|null}>} `unrecorded`:
   *   why a change made no step (a key of `data/viewer-protocol.js` `VIEWER_ACTION_UNRECORDED`, the closed set a host hears and
   *   `agent/bridge/mcp-content.js` `UNRECORDED_NOTES` tells an agent), null when it made one or is no change (a read, a
   *   move of the history, a dataset opened, an act outside the state)
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
    const work = { meta: exactMeta, controller, asking: 0 };
    running.add(work);
    const removeOuter = onAbort(exactMeta.signal, () => controller.abort(exactMeta.signal.reason));
    const confirm = askerFor(definition, exactParams, exactMeta, signal, work);
    const confirmLink = linkAskerFor(definition, exactParams, exactMeta, signal, work);
    const confirmReplacing = replaceAskerFor(definition, exactParams, exactMeta, signal, work);
    let started = null;
    const heavy = heavyAskerFor(definition, exactParams, exactMeta, signal, () => started, work);
    try {
      started = await awaitWithSignal(confirmIfNeeded(definition, exactParams, exactMeta, { signal, work }), signal);
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
          // A read stopped ends at once, wherever its implementation is (it
          // changes nothing, so nothing waits for it); a move of the history,
          // an opening, an act outside the state and a control end when their
          // implementation does, with what they did.
          const running = handler(exactParams, { signal, meta: exactMeta, confirm, confirmLink, confirmReplacing, heavy, ongoing: ongoingFor(exactMeta) });
          const outcome = await (definition.effect === 'read' ? awaitWithSignal(running, signal) : running);
          emit({ kind: 'done', type, params: exactParams, meta: exactMeta, step: null, outcome });
          return { outcome: outcome ?? null, step: null, unrecorded: null };
        } catch (error) {
          emit({ kind: 'failed', type, params: exactParams, meta: exactMeta, error });
          throw error;
        }
      }
      if (!exactMeta.internal) await awaitWithSignal(gate(), signal);
      throwIfAborted(signal);
      return await apply(definition, exactParams, exactMeta, handler, controller, { confirm, confirmLink, confirmReplacing, heavy });
    } finally {
      removeOuter();
      running.delete(work);
      runningChanged();
    }
  }

  /** Apply a change (after its go-ahead and the gate): in order with the others on its domains, recorded as a step. */
  async function apply(definition, exactParams, exactMeta, handler, controller, { confirm, confirmLink, confirmReplacing, heavy }) {
    const { type } = definition;
    if (definition.supersede) {
      for (const entry of inFlight) {
        if (entry.definition.type === type) entry.controller.abort(new ActionRefused('A newer choice replaced it', { code: 'superseded', type }));
      }
    }
    const domains = new Set(definition.touches);
    const waits = overlapping(domains);
    const { promise: done, resolve: settle } = promiseWithResolvers();
    const entry = { definition, domains, controller, applying: false, done };
    inFlight.add(entry);
    emit({ kind: 'start', type, params: exactParams, meta: exactMeta });
    try {
      await Promise.all(waits);
      throwIfAborted(controller.signal);
      // The history that began recording it is the one told how it ended: another dataset opened
      // meanwhile has a history of its own, which never puts back or records the replaced one's
      // change (that history, retired, keeps nothing to put back: its dataset is gone).
      const recording = recorder;
      const token = recording === null ? null : await recording.before({ definition, params: exactParams, meta: exactMeta });
      entry.applying = true;
      let outcome;
      try {
        outcome = await handler(exactParams, { signal: controller.signal, meta: exactMeta, confirm, confirmLink, confirmReplacing, heavy, ongoing: ongoingFor(exactMeta) });
        // Stopped (the person's Stop, the page closing) while it ran, by a
        // handler that went on to its end: it ends as a cancellation all the
        // same and what it changed is put back, so "stopped" never leaves a
        // change or a step, whether or not its implementation watched the
        // signal. One a newer choice of its type replaced and
        // that still finished keeps its step: the newer one runs right after
        // it on the same state, and putting back a domain it is about to
        // replace (the open cells: a read of the dataset) is work for nothing.
        // One that keeps what it did when stopped (`keepsWhenStopped`: a
        // camera path stays where the film stopped) answers and keeps
        // its step.
        if (
          controller.signal.aborted
          && controller.signal.reason?.code !== 'superseded'
          && !definition.keepsWhenStopped
        ) throwIfAborted(controller.signal);
      } catch (error) {
        // A retired page has no state left to put back.
        if (token !== null && retired === null) await recording.failed(token, error);
        throw error;
      }
      // Nor a step to record: its owners are being withdrawn.
      if (retired !== null) throw retired;
      const step = token === null ? null : await recording.after(token, outcome ?? null);
      emit({ kind: 'done', type, params: exactParams, meta: exactMeta, step, outcome });
      // No history records here yet (its dataset's history not started), or the recorder said why it recorded none.
      const unrecorded = step !== null ? null : token === null ? 'no-history' : (token.unrecorded ?? null);
      return { outcome: outcome ?? null, step, unrecorded };
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
   * running (a read ends and a change is rolled back, but for one that
   * keeps what it did when stopped, `keepsWhenStopped`). Returns how many
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
    for (const work of [...ongoingWork]) {
      if (!keys.every(key => work.meta[key] === match[key])) continue;
      ongoingWork.delete(work);
      try {
        work.stop(reason);
      } catch (error) {
        console.error('[actions] stopping work an action left going failed', error);
      }
      stopped += 1;
    }
    return stopped;
  }

  /**
   * `ctx.ongoing(stop)` of an action of `meta`: register work that goes on
   * after the action answers; `stop(reason)` ends it when its turn is
   * stopped. Returns the release its owner calls once the work ends by
   * itself (stopped another way, finished), so a later Stop of that turn
   * reaches nothing.
   */
  function ongoingFor(meta) {
    return stopWork => {
      if (typeof stopWork !== 'function') throw new TypeError('Ongoing work is stopped by a function');
      const work = { meta, stop: stopWork };
      ongoingWork.add(work);
      return () => { ongoingWork.delete(work); };
    };
  }

  /**
   * Record a change its owner already made (a settings control, a camera
   * gesture). Call it synchronously from the owner's change event: a change
   * the history itself made while showing another step is not a step.
   * `outcome` is what a handler would have returned (the setting's label,
   * for one), so the step reads the same as a dispatched one. `after`, when
   * the change set off work that changes state too (an analysis's redraw,
   * its run after a delay), resolves once that work has settled: the step is
   * recorded then and holds all of it (`recorder.observed`). `person`: the
   * change is the person's own act by construction (a press, a drag, a
   * control's event that a restore never fires), never work an action set
   * off.
   */
  function recordObserved(type, params, meta = {}, outcome = null, { after = null, person = false } = {}) {
    const definition = catalog.check(type, params);
    const exactMeta = requireMeta(meta);
    if (recorder === null) return Promise.resolve(null);
    // A change made while an action on the same state runs (a camera the
    // cells read again put back) is that action's: its step holds it. A
    // person's own act never is (a window closed while its run ran would
    // be the run's, and the stopped run's rollback would open it again): it is
    // its own step, and a rollback of that action leaves what it changed.
    if (!person) {
      for (const entry of inFlight) {
        if (entry.applying && definition.touches.some(domain => entry.domains.has(domain))) return Promise.resolve(null);
      }
    }
    return recorder.observed({ definition, params: withDefaults(definition.params, params), meta: exactMeta, outcome, after, person })
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
     * @param {(params: object, ctx: {signal: AbortSignal, meta: object, confirm: (detail: string|null) => Promise<void>,
     *   confirmLink: (address: string) => Promise<void>,
     *   heavy: (estimate: {ms: number|null, bytes: number|null, what: string}|null) => Promise<void>}) => unknown} handler
     *   `ctx.confirm`: for a `confirmAt: 'handler'` action, ask the person now
     *   (an agent's action only; refused: `ActionRefused` code `declined`);
     *   `ctx.confirmLink`: for an `opensLinks` action, ask before requesting
     *   an address the person has not seen in this tab (an agent's only);
     *   `ctx.heavy`: work found once it runs, asked as heavy work is (an
     *   agent's action only, unless its start was judged heavy already)
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
     * when not known). The agent presence judges heavy work by it. An
     * estimator that throws `ActionRefused` refuses the action there, before
     * the person is asked about it (it checks what the implementation would
     * refuse: a squash of steps not the agent's own, a locked branch).
     * @param {string} type
     * @param {(params: object, ctx: {signal: AbortSignal|null, meta: object}) => (object|null|Promise<object|null>)} estimator
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
    subscribe: listener => listeners.add(listener),
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
      // Its owners are withdrawn with the page and end their own work.
      ongoingWork.clear();
    },
    /**
     * Resolves once every dispatch has ended, those made meanwhile included,
     * but for those waiting for the person's go-ahead: from the moment it is
     * made a dispatch is under way, so one waiting at the gate (behind a
     * history operation, a dataset's history starting) or for its estimate
     * is too. One waiting for the person's go-ahead (at its start, from its
     * implementation, for heavy work a dispatch it runs finds) is not, from
     * the moment it waits until the person answers: it waits for a person,
     * not for work. Judged again whenever a dispatch ends or begins or stops
     * waiting for the person. What a control's caller waits for (a test, a
     * host); never awaited inside a dispatch, which would wait for itself
     * (that waits for `whenApplied`).
     */
    async idle() {
      while ([...running].some(work => work.asking === 0)) {
        await new Promise(resolve => idleWaiters.add(resolve));
      }
    },
    /**
     * Resolves once no change is applying: the changes past the gate, those
     * started meanwhile included. What a history move and a saved file wait
     * for from inside their own turn, where a change waiting at the gate
     * waits for them.
     */
    async whenApplied() {
      while (inFlight.size > 0) await Promise.all([...inFlight].map(entry => entry.done));
    },
    catalog,
  });
}
