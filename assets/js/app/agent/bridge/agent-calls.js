/**
 * @fileoverview The calls of agents that reach this tab from outside it: one
 * engine for every way in that is not the chat bar -- the Cellucid relay
 * (Claude and ChatGPT using Cellucid as a connector, `relay-client.js`) and a
 * local agent connection (`cellucid mcp` of the Python or R package, driving
 * a viewer it serves or one a notebook serves, over the viewer channel:
 * `data/viewer-host-source.js`).
 *
 * - **runs tool calls**: a call names a tool; its action is found in the
 *   catalog and dispatched as the agent (`origin: 'agent'`, the agent's
 *   name, a turn, the connection it came through: `runToolCall`), so the
 *   person's history records it, labels it and can undo the agent's whole
 *   turn at once, and the person's permissions decide whether it runs,
 *   waits for the person or is refused. The answer is MCP content.
 * - **answers the tool list**: the same list whatever the person's settings
 *   (`mcp-tools.js`), and **tells the agent those settings** as they hold for
 *   its connection (its permissions, the dataset's data switch, what the
 *   History settings leave out: `../settings-told.js`) after the first
 *   result of the connection and after any result once they changed.
 * - **tells the agent what the person did since its last call** (as
 *   the chat bar tells its model with the person's next message): the
 *   history each connection saw as its last call ended (`historySeen`) is
 *   kept for the tab (`sessionStorage`, so a reload keeps it), and the next
 *   call's result says what changed since (`historySinceSentence`: its own
 *   steps undone, the person's steps, another history shown).
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
import { createOpaqueId } from '../../../utils/opaque-id.js';
import { mcpToolsOf, toolIndexOf } from './mcp-tools.js';
import { historySettings, offDomainsOf } from '../../history/history-settings.js';
import { PERMISSION_KINDS } from '../presence/permissions.js';
import { settingsTold } from '../settings-told.js';
import { dataScopeNow } from '../data-scope.js';
import { runToolCall } from './tool-call.js';
import { refusalText } from './mcp-content.js';
import { getCurrentHistory } from '../../history/current.js';
import { historySeen, historySinceSentence, isHistorySeen } from '../history-link.js';
import { webStorage } from '../../../utils/web-storage.js';

/** Calls of one connection this close together (and nobody else's step between) are one turn. */
export const AGENT_TURN_IDLE_MS = 120_000;

/** Where a connection's seen history is kept in the tab. */
const seenKey = connectionId => `cellucid.agent-calls.seen.${connectionId}`;

/** The tab's `sessionStorage` as a seen store, or null where there is none (a worker, node, blocked site data). */
function tabSeenStore() {
  const storage = webStorage('sessionStorage');
  if (storage === null) return null;
  return { get: key => storage.getItem(key), set: (key, value) => storage.setItem(key, value) };
}

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
 *   history?: {current: () => object|null},
 *   seenStore?: {get: (key: string) => string|null, set: (key: string, value: string) => void}|null,
 * }} options - `kind`: the connections these calls come through;
 *   `permissionFor`: what the person's settings make of a kind of action for
 *   a connection (the presence's), which the agent is told after its results; `questionFor`:
 *   the sentence the person is asked about the call whose signal this is
 *   (the presence's confirm card), or null; `decorate`: add to a successful
 *   result (the relay's view card metadata); `onResult`: a call's answer;
 *   `history`: the page's history (its tracker shown is what the agent is told
 *   changed); `seenStore`: where what each connection saw is kept for the tab
 *   (`sessionStorage` by default; null keeps it in memory only)
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
  history = { current: getCurrentHistory },
  seenStore = tabSeenStore(),
}) {
  if (!OUTSIDE_CONNECTION_KINDS.includes(kind)) {
    throw new TypeError(`Agent calls come through one of ${OUTSIDE_CONNECTION_KINDS.join(', ')}`);
  }
  if (typeof onResult !== 'function') throw new TypeError('Agent calls need where their answers go (onResult)');
  const tools = toolIndexOf(actions.catalog);
  // One list for every connection, whatever the person's settings (`mcp-tools.js`).
  const toolList = mcpToolsOf(catalogDocument(actions.catalog));
  /** What each connection was last told of the person's settings: connection id → the words. */
  const told = new Map();
  /** Calls running: id → AbortController. */
  const calls = new Map();
  /** The turn of each connection: connection id → {id, lastAt, others}. */
  const turns = new Map();
  /** Each connection's turns (its own steps are of these): connection id → Set of turn ids. */
  const ownTurns = new Map();
  /** What each connection saw of the history as its last call ended (`historySeen`), read back once from the tab. */
  const seen = new Map();
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
    if (!ownTurns.has(connectionId)) ownTurns.set(connectionId, new Set());
    ownTurns.get(connectionId).add(next.id);
    return next.id;
  }

  /** The tracker shown now, or null (no dataset open). */
  function shownTree() {
    try {
      return history.current()?.active ?? null;
    } catch {
      return null;
    }
  }

  /**
   * What the connection saw as its last call ended: this tab's memory, else
   * what the tab kept before a reload (with the turns of its own steps there,
   * so they are still told as its own).
   */
  function seenOf(connectionId) {
    if (seen.has(connectionId)) return seen.get(connectionId);
    let kept = null;
    try {
      const text = seenStore?.get(seenKey(connectionId)) ?? null;
      const value = text === null ? null : JSON.parse(text);
      if (value !== null && typeof value === 'object' && isHistorySeen(value.seen)
        && Array.isArray(value.turns) && value.turns.every(turn => typeof turn === 'string')) {
        kept = value.seen;
        if (!ownTurns.has(connectionId)) ownTurns.set(connectionId, new Set());
        for (const turn of value.turns) ownTurns.get(connectionId).add(turn);
      }
    } catch {
      kept = null;
    }
    seen.set(connectionId, kept);
    return kept;
  }

  function keepSeen(connectionId, value) {
    seen.set(connectionId, value);
    // Its own turns among the steps it saw: after a reload they are still its own.
    const own = ownTurns.get(connectionId) ?? new Set();
    const turns = [...new Set(value.steps.map(step => step.by.turn).filter(turn => turn !== null && own.has(turn)))];
    try {
      seenStore?.set(seenKey(connectionId), JSON.stringify({ seen: value, turns }));
    } catch {
      // A tab that keeps nothing (private mode, storage full) still tells within this page's life.
    }
  }

  /**
   * The note telling the connection what changed in the history since its
   * last call ended (the person's steps, its own undone, another history
   * shown), or none; the history as it is now becomes what it saw.
   * @returns {string[]}
   */
  function historyToTell(connectionId) {
    const tree = shownTree();
    if (tree === null) return [];
    try {
      const since = historySinceSentence(tree, seenOf(connectionId), ownTurns.get(connectionId) ?? new Set());
      return since === null ? [] : [`[Cellucid: ${since}]`];
    } catch (error) {
      console.error('[agent calls] what changed in the history could not be told to the agent', error);
      return [];
    }
  }

  /** The history as a call ends, kept as what the connection saw (others' steps taken meanwhile left out: told next). */
  function noteSeen(connectionId, start) {
    const tree = shownTree();
    if (tree === null) return;
    try {
      keepSeen(connectionId, historySeen(tree, {
        from: start !== null && start.tracker === tree.id ? start.next : null,
        ownTurns: ownTurns.get(connectionId) ?? new Set(),
      }));
    } catch (error) {
      console.error('[agent calls] the history the agent saw could not be kept', error);
    }
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
    // What the person did since this connection's last call, said with this call's result;
    // where the tracker stands as the call begins (a step someone else takes meanwhile is told next time).
    const sinceTold = historyToTell(connection.id);
    const startTree = shownTree();
    const start = startTree === null ? null : { tracker: startTree.id, next: startTree.nextStep ?? 0 };
    let result;
    try {
      ({ result } = await runToolCall({
        actions, tools, name: tool, args, agent, turn, signal: controller.signal,
        // The person's settings, said after the result when this connection was not told them yet or they changed;
        // then what changed in the history since its last call.
        told: [...settingsToTell(connection.id), ...sinceTold],
        // Which connection: the person's settings may allow it for this one.
        connection: {
          id: connection.id,
          kind,
          client: typeof connection.client === 'string' ? connection.client : null,
          host: typeof connection.host === 'string' ? connection.host : null,
          // Whether a site vouches for the app's own name (the relay's Claude and ChatGPT).
          known: connection.known === true,
        },
      }));
      if (!result.isError) decorate(tool, result);
    } finally {
      calls.delete(id);
      const current = turns.get(connection.id);
      if (current?.id === turn) current.lastAt = now();
      noteSeen(connection.id, start);
    }
    onResult(id, result);
  }

  /**
   * The person's settings as they hold for the connection `connectionId`:
   * each kind of action as its permission decides it there (the person's
   * settings with what they allowed for that connection), the dataset's
   * data switch, what the History settings leave out of the history.
   */
  function settingsNow(connectionId) {
    const connection = { id: connectionId, kind };
    const kinds = {};
    for (const permissionKind of PERMISSION_KINDS) {
      const choice = permissionFor({ kind: permissionKind, connection });
      if (choice === null || choice === undefined) return settingsTold({ permissions: null, summariesOnly: dataScopeNow().summariesOnly, offDomains: offDomainsOf(historySettings()) });
      kinds[permissionKind] = choice;
    }
    return settingsTold({ permissions: { kinds }, summariesOnly: dataScopeNow().summariesOnly, offDomains: offDomainsOf(historySettings()) });
  }

  /**
   * The note telling the connection `connectionId` the person's settings,
   * when it was not told them yet or they changed since (as the chat bar's
   * model is told them with the person's message); else none. Marked told.
   * @returns {string[]}
   */
  function settingsToTell(connectionId) {
    let now;
    try {
      now = settingsNow(connectionId);
    } catch (error) {
      console.error('[agent calls] the person\'s settings could not be read for the agent', error);
      return [];
    }
    if (told.get(connectionId) === now) return [];
    told.set(connectionId, now);
    return [`[Cellucid: the person's settings for you now. ${now}]`];
  }

  /** The tools: one list for every connection, whatever the person's settings. */
  function list() {
    return toolList;
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
