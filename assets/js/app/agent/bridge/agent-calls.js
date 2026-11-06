/**
 * @fileoverview The calls of agents that reach this tab from outside it: one
 * engine for every way in that is not the chat bar -- the Cellucid relay
 * (Claude and ChatGPT using Cellucid as a connector, `relay-client.js`) and a
 * local agent connection (`cellucid mcp` of the Python or R package, driving
 * a viewer it serves or one a notebook serves, over the viewer channel:
 * `data/viewer-host-source.js`).
 *
 * - **runs tool calls**: a call names a tool; its action is found in the
 *   catalogue and dispatched as the agent (`origin: 'agent'`, the agent's
 *   name, a turn, the connection it came through: `runToolCall`), so the
 *   person's history records it, labels it and can undo the agent's whole
 *   turn at once, and the person's permissions decide whether it runs,
 *   waits for the person or is refused. The answer is MCP content.
 * - **answers the tool list** as the connection may use it (`mcp-tools.js`
 *   with the person's settings for that connection).
 * - **tells the caller when the person is asked** about a call (`onAsking`,
 *   with the sentence the confirm card asks, so an agent's own app can ask
 *   it too) and when they answered (`onAnswered`).
 * - **stops** a call the caller gave up on (`cancel`), or lets one go on
 *   unanswered (`detach`: the caller stopped waiting while the person is
 *   asked; the question stays open in the tab).
 *
 * Turns: calls from one connection belong to one turn while they follow each
 * other within `AGENT_TURN_IDLE_MS` and no one else made a step in between;
 * the person (or a notebook, a session) acting starts a new turn.
 *
 * @module app/agent/bridge/agent-calls
 */

import { catalogDocument } from '../../actions/catalog.js';
import { cancel } from '../../../utils/abort.js';
import { createOpaqueId } from '../../utils/opaque-id.js';
import { mcpToolsOf, toolIndexOf } from './mcp-tools.js';
import { historySettings, offDomainsOf } from '../../history/history-settings.js';
import { runToolCall } from './tool-call.js';
import { refusalText } from './mcp-content.js';

/** Calls of one connection this close together (and nobody else's step between) are one turn. */
export const AGENT_TURN_IDLE_MS = 120_000;

/** The kinds of connection this engine runs calls for (the chat bar runs its own: `chat/agent-loop.js`). */
export const OUTSIDE_CONNECTION_KINDS = Object.freeze(['connector', 'local']);

/**
 * @param {{
 *   actions: {catalog: object, dispatch: Function, subscribe: Function},
 *   kind: 'connector'|'local',
 *   permissionFor?: (question: {kind: string, connection: {id: string, kind: string}}) => ('ask'|'allow'|'deny'|null),
 *   questionFor?: (signal: AbortSignal) => (string|null),
 *   decorate?: (tool: string, result: {content: object[], isError: boolean}) => void,
 *   onResult: (id: string, result: {content: object[], isError: boolean}) => void,
 *   onAsking?: (id: string, question: {detail: string|null, message: string}) => void,
 *   onAnswered?: (id: string, allowed: boolean) => void,
 *   now?: () => number,
 * }} options - `kind`: the connections these calls come through;
 *   `permissionFor`: what the person's settings make of a kind of action for
 *   a connection (the presence's), which its tool list says; `questionFor`:
 *   the sentence the person is asked about the call whose signal this is
 *   (the presence's confirm card), or null; `decorate`: add to a successful
 *   result (the relay's view card metadata); `onResult`: a call's answer
 */
export function createAgentCalls({
  actions,
  kind,
  permissionFor = () => null,
  questionFor = () => null,
  decorate = () => {},
  onResult,
  onAsking = () => {},
  onAnswered = () => {},
  now = () => Date.now(),
}) {
  if (!OUTSIDE_CONNECTION_KINDS.includes(kind)) {
    throw new TypeError(`Agent calls come through one of ${OUTSIDE_CONNECTION_KINDS.join(', ')}`);
  }
  if (typeof onResult !== 'function') throw new TypeError('Agent calls need where their answers go (onResult)');
  const tools = toolIndexOf(actions.catalog);
  const document = catalogDocument(actions.catalog);
  /** Calls running: id → AbortController. */
  const calls = new Map();
  /** The turn of each connection: connection id → {id, lastAt, others}. */
  const turns = new Map();
  /** How many steps someone other than an agent made (the person, a notebook, a session). */
  let otherSteps = 0;
  let destroyed = false;

  /** The call a dispatcher event belongs to: the one whose signal it carries. */
  function callOf(event) {
    const signal = event.meta?.signal ?? null;
    if (signal === null) return null;
    for (const [id, controller] of calls) if (controller.signal === signal) return id;
    return null;
  }

  const unsubscribe = actions.subscribe(event => {
    if (event.kind === 'done' && event.step !== null && event.meta?.origin !== 'agent') otherSteps += 1;
    // The person is asked about one of these calls: the caller tells the
    // agent waiting on it, rather than let its time run out unexplained.
    if (event.kind !== 'asking' && event.kind !== 'answered') return;
    const id = callOf(event);
    if (id === null) return;
    try {
      if (event.kind === 'asking') {
        const definition = actions.catalog.has(event.type) ? actions.catalog.get(event.type) : null;
        const message = questionFor(event.meta.signal)
          ?? `Cellucid asks the person before “${definition?.title ?? event.type}”.`;
        // The detail an agent reads keeps the names its sentence marked as data, any other `<` escaped.
        onAsking(id, { detail: typeof event.detail === 'string' ? refusalText(event.detail) : null, message });
      } else {
        onAnswered(id, event.allowed === true);
      }
    } catch (error) {
      console.error('[agent calls] telling the caller the person is asked failed', error);
    }
  });

  function turnFor(connectionId) {
    const at = now();
    const current = turns.get(connectionId);
    if (current !== undefined && at - current.lastAt <= AGENT_TURN_IDLE_MS && current.others === otherSteps) {
      current.lastAt = at;
      return current.id;
    }
    const next = { id: `turn-${createOpaqueId()}`, lastAt: at, others: otherSteps };
    turns.set(connectionId, next);
    return next.id;
  }

  /**
   * Run one call and answer it (`onResult`), whatever happens.
   * @param {{id: string, tool: string, args: unknown, agent: string,
   *   connection: {id: string, client?: string|null, host?: string|null}}} call
   */
  async function run({ id, tool, args, agent, connection }) {
    if (destroyed) {
      onResult(id, { content: [{ type: 'text', text: 'Cellucid closed before this call ran; nothing was done.' }], isError: true });
      return;
    }
    const controller = new AbortController();
    calls.set(id, controller);
    const turn = turnFor(connection.id);
    let result;
    try {
      ({ result } = await runToolCall({
        actions, tools, name: tool, args, agent, turn, signal: controller.signal,
        // Which connection: the person's settings may allow it for this one.
        connection: {
          id: connection.id,
          kind,
          client: typeof connection.client === 'string' ? connection.client : null,
          host: typeof connection.host === 'string' ? connection.host : null,
        },
      }));
      if (!result.isError) decorate(tool, result);
    } finally {
      calls.delete(id);
      const current = turns.get(connection.id);
      if (current?.id === turn) current.lastAt = now();
    }
    onResult(id, result);
  }

  /**
   * The tools as the connection `connectionId` may use them: each question as
   * the person's settings answer it for that connection (null: the defaults),
   * and what their History settings leave out of the history.
   */
  function list(connectionId) {
    const connection = typeof connectionId === 'string' ? { id: connectionId, kind } : null;
    return mcpToolsOf(document, {
      permissionOf: permissionKind => (connection === null ? null : permissionFor({ kind: permissionKind, connection })),
      // The details History settings leave out of the history, said on their actions.
      offDomains: offDomainsOf(historySettings()),
    });
  }

  return Object.freeze({
    run,
    list,
    /** Whether a tool of this name exists (an unknown one is answered at once by the caller). */
    has: name => tools.has(name),
    /** The caller gave up on call `id`: stop it in the tab. */
    cancel(id) {
      cancel(calls.get(id), 'closed', 'The agent stopped waiting for this step');
    },
    /** The caller stopped waiting for call `id` while the person is asked: it goes on, unanswered. */
    detach(id) {
      calls.delete(id);
    },
    /** The signal of call `id` while it runs (what the presence keys its question on), or null. */
    signalOf: id => calls.get(id)?.signal ?? null,
    /** The ids of the calls running now. */
    running: () => [...calls.keys()],
    /** Stop every call running (the link to the agents was lost). */
    failAll(words = 'The connection to the agent was lost') {
      for (const controller of calls.values()) cancel(controller, 'closed', words);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const controller of calls.values()) cancel(controller, 'closed', 'Cellucid closed before this call ended');
      unsubscribe();
    },
  });
}
