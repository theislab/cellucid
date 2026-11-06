/**
 * @fileoverview The tab's end of the Cellucid relay: how Claude and ChatGPT
 * (connected to Cellucid as a connector) reach the person's open tab.
 *
 * The tab keeps one WebSocket to the relay (`wss://<relay>/tab`), proven by
 * the tab secret (`tab-secret.js`), and:
 *
 * - **runs tool calls**: a call names a tool; the tab finds its action in the
 *   catalogue and dispatches it as the agent (`origin: 'agent'`, the agent's
 *   name from the connection, a turn id), so the person's history records
 *   it, labels it and can undo the agent's whole turn at once. The answer is
 *   MCP content (`mcp-content.js`). A call the agent gives up on is stopped.
 * - **answers the tool list** from the catalogue (`mcp-tools.js`).
 * - **reports focus**: commands go to the tab of this browser focused last.
 * - **approves connections**: a connect code (from the relay's approval
 *   page, by link or typed) is claimed; the relay says who asks
 *   (`onApproval`); the person allows or denies (`approve` / `deny`).
 * - **lists and removes connections**, and **forgets** the pairing.
 * - **stays connected** over changing links: reconnects with growing,
 *   jittered waits, at once when the browser is back online or the tab is
 *   shown again, and replaces a link that stopped answering its keep-alive.
 *
 * Calls, turns and tool lists are `agent-calls.js`'s, shared with a local
 * agent connection (`cellucid mcp`, over the viewer channel).
 *
 * The visible Connect panel uses the API this returns (see the README of
 * this folder); `startRelayClientForPage` is the page's wiring.
 *
 * @module app/agent/bridge/relay-client
 */

import { isLocalDevHost } from '../../utils/local-dev.js';
import { createAgentCalls } from './agent-calls.js';
import { formatConnectCode, normalizeConnectCode, takeConnectCode } from './connect-code.js';
import { pageVersion } from '../../utils/page-version.js';
import {
  RELAY_CLOSE,
  RELAY_PING,
  RELAY_PONG,
  RELAY_PROTOCOL_VERSION,
  RELAY_SECRET_PREFIX,
  RELAY_SUBPROTOCOL,
  VIEW_APP,
} from './relay-protocol.js';
import { ensureTabSecret, forgetTabSecret, readTabSecret } from './tab-secret.js';

/**
 * The deployed relay (`wrangler.relay.jsonc`), on its custom domain. It answers
 * MCP at its root, so this origin is also the connector address.
 */
export const DEFAULT_RELAY_ORIGIN = 'https://mcp.cellucid.com';

/** First wait before reconnecting; each failed attempt doubles it (with jitter). */
const RECONNECT_FIRST_MS = 1_000;
/** The longest wait between reconnection attempts; coming back online or showing the tab retries at once. */
const RECONNECT_DELAY_CEILING_MS = 60_000;
/** A keep-alive ping this often; a ping still unanswered at the next one means the link is gone. */
const KEEPALIVE_MS = 30_000;
/** How long the relay may take to answer a claim, a decision or a list of connections. */
const RELAY_REPLY_WAIT_MS = 20_000;

const CLOSE_NORMAL = 1000;
const CLOSE_GOING_AWAY = 1001;
const CLOSE_UNANSWERED = 4000;

function exactRelayOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.origin !== value) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  return url.origin;
}

/**
 * The relay this page talks to: the deployed one, or, on a local development
 * host only, `window.__CELLUCID_RELAY_ORIGIN__` (a relay run with `wrangler
 * dev`). A deployed page never sends its tab secret anywhere else.
 * @param {object} [win]
 */
export function relayOriginForPage(win = globalThis.window) {
  const override = win?.__CELLUCID_RELAY_ORIGIN__;
  if (override === undefined || !isLocalDevHost()) return DEFAULT_RELAY_ORIGIN;
  const origin = exactRelayOrigin(override);
  if (origin === null) throw new TypeError(`The relay override ${JSON.stringify(override)} is not an exact https (or loopback http) origin`);
  return origin;
}

function relayError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * @param {{
 *   relayOrigin: string,
 *   actions: {catalog: object, dispatch: Function, subscribe: Function},
 *   secrets?: {read: () => string|null, ensure: () => string, forget: () => void},
 *   WebSocketImpl?: typeof WebSocket,
 *   win?: object|null,
 *   doc?: object|null,
 *   version?: string,
 *   datasetName?: () => string|null,
 *   datasetLink?: () => string|null,
 *   currentStep?: () => ({id: string, label: string}|null),
 *   permissionFor?: (question: {kind: string, connection: {id: string, kind: string}}) => ('ask'|'allow'|'deny'|null),
 *   onApproval?: (approval: object) => void,
 *   onStatus?: (status: object) => void,
 *   onConnectionsChanged?: () => void,
 *   clock?: {now: () => number, random: () => number, setTimeout: Function, clearTimeout: Function},
 * }} options - `datasetLink`: the public link that opens the dataset shown in
 *   Cellucid, or null (what the view card's Open in Cellucid opens);
 *   `currentStep`: the history step shown now (what the view card says the
 *   picture is after);
 *   `permissionFor({kind, connection})`: what the person's settings make
 *   of a kind of action (`change`, or a `confirm` kind) for a connection:
 *   `ask`, `allow`, `deny`, or null (the default); its tool list says so
 */
export function createRelayClient({
  relayOrigin,
  actions,
  secrets = { read: () => readTabSecret(), ensure: () => ensureTabSecret(), forget: () => forgetTabSecret() },
  WebSocketImpl = globalThis.WebSocket,
  win = globalThis.window ?? null,
  doc = globalThis.document ?? null,
  version = '',
  datasetName = () => null,
  datasetLink = () => null,
  currentStep = () => null,
  permissionFor = () => null,
  onApproval = () => {},
  onStatus = () => {},
  onConnectionsChanged = () => {},
  clock = {
    now: () => Date.now(),
    random: () => Math.random(),
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: handle => globalThis.clearTimeout(handle),
  },
}) {
  if (exactRelayOrigin(relayOrigin) === null) throw new TypeError(`Relay origin ${JSON.stringify(relayOrigin)} is not exact`);
  const socketUrl = `${relayOrigin.replace(/^http/, 'ws')}/tab`;

  /** @type {WebSocket|null} */
  let socket = null;
  let welcomed = false;
  let wanted = false;
  let state = 'off';
  let lastError = null;
  let attempt = 0;
  let retryTimer = null;
  let retryAt = null;
  let keepaliveTimer = null;
  let pingSentAt = null;
  let heardAt = 0;
  let nextRef = 1;
  /** Requests to the relay waiting for their reply: ref → {message, resolve, reject, timer}. */
  const requests = new Map();
  /** Approvals waiting for the person: code → approval. */
  const approvals = new Map();
  /** The timers that drop an approval when its code expires. */
  const approvalTimers = new Set();
  let listeners = null;

  // The calls of the connector's agents (`agent-calls.js`): run as the
  // connection's agent, answered to the relay; the person being asked about
  // one is told to the relay, which tells the agent waiting on it.
  const calls = createAgentCalls({
    actions,
    kind: 'connector',
    permissionFor,
    now: () => clock.now(),
    // The view card (an MCP App) shows what dataset this is and opens it in Cellucid.
    decorate: (tool, result) => {
      if (!VIEW_APP.tools.includes(tool)) return;
      result._meta = {
        [VIEW_APP.meta]: { dataset: datasetName() ?? null, link: datasetLink() ?? null, step: currentStep() ?? null, version },
      };
    },
    onResult: (id, result) => send({ type: 'result', id, result }),
    onAsking: (id, { detail }) => send({ type: 'asking', id, detail }),
    onAnswered: (id, allowed) => send({ type: 'answered', id, allowed }),
  });

  function status() {
    return Object.freeze({
      state,
      error: lastError,
      retryAt,
      approvals: Object.freeze([...approvals.values()]),
    });
  }

  function setState(next, error = null) {
    state = next;
    lastError = error;
    try { onStatus(status()); } catch (cause) { console.error('[agent relay] status listener failed', cause); }
  }

  function open() {
    return socket !== null && socket.readyState === 1 && welcomed;
  }

  function send(message) {
    if (socket === null || socket.readyState !== 1) return false;
    socket.send(typeof message === 'string' ? message : JSON.stringify(message));
    return true;
  }

  function flushRequests() {
    for (const request of requests.values()) {
      if (!request.sent) request.sent = send(request.message);
    }
  }

  function request(type, fields = {}) {
    const ref = nextRef++;
    const message = { type, ref, ...fields };
    return new Promise((resolve, reject) => {
      const timer = clock.setTimeout(() => {
        requests.delete(ref);
        reject(relayError('The Cellucid relay did not answer. Check the connection and try again.', 'relay-unanswered'));
      }, RELAY_REPLY_WAIT_MS);
      const entry = { message, resolve, reject, timer, sent: false };
      requests.set(ref, entry);
      if (open()) entry.sent = send(message);
    });
  }

  function settleReply({ ref, ok, value, error }) {
    const entry = requests.get(ref);
    if (entry === undefined) return;
    requests.delete(ref);
    clock.clearTimeout(entry.timer);
    if (ok === true) entry.resolve(value ?? null);
    else entry.reject(relayError(String(error?.message ?? 'The relay refused it'), String(error?.code ?? 'refused')));
  }

  function runCall({ id, tool, args, agent, grant, client = null, host = null }) {
    if (!calls.has(tool)) {
      send({ type: 'result', id, error: { code: 'unknown-tool', message: `Cellucid has no tool "${tool}"` } });
      return;
    }
    void calls.run({ id, tool, args, agent, connection: { id: grant, client, host } });
  }

  /** The tools as the connection `grant` may use them: each question as the person's settings answer it for that connection. */
  function answerList(id, grant) {
    send({ type: 'tools', id, tools: calls.list(typeof grant === 'string' ? grant : null) });
  }

  function reportState() {
    if (!open()) return;
    send({
      type: 'state',
      focused: typeof doc?.hasFocus === 'function' ? doc.hasFocus() : false,
      visible: doc?.visibilityState === undefined ? true : doc.visibilityState === 'visible',
      dataset: datasetName() ?? null,
      version,
    });
  }

  function onMessage(event) {
    heardAt = clock.now();
    if (event.data === RELAY_PONG) { pingSentAt = null; return; }
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    switch (message?.type) {
      case 'welcome':
        if (message.protocol !== RELAY_PROTOCOL_VERSION) {
          wanted = false;
          socket?.close(CLOSE_NORMAL, 'protocol');
          setState('refused', 'This page and the Cellucid relay were updated separately. Reload the page to reconnect.');
          return;
        }
        welcomed = true;
        attempt = 0;
        retryAt = null;
        setState('connected');
        reportState();
        flushRequests();
        return;
      case 'call':
        runCall(message);
        return;
      case 'list':
        answerList(message.id, message.grant);
        return;
      case 'cancel':
        calls.cancel(message.id);
        return;
      case 'detach':
        // The agent's time ran out while the person is asked: the question
        // stays open and the call goes on, whatever the link does next.
        calls.detach(message.id);
        return;
      case 'reply':
        settleReply(message);
        return;
      case 'event':
        if (message.name === 'connections-changed') {
          try { onConnectionsChanged(); } catch (cause) { console.error('[agent relay] connections listener failed', cause); }
        }
        return;
      default:
    }
  }

  function stopKeepalive() {
    if (keepaliveTimer !== null) clock.clearTimeout(keepaliveTimer);
    keepaliveTimer = null;
    pingSentAt = null;
  }

  /**
   * The link's watch, from the moment it is dialled: a socket not welcomed
   * by the next tick never opened (a captive or stalled network), and a
   * ping unanswered by the next tick means the link is gone.
   */
  function keepalive() {
    keepaliveTimer = clock.setTimeout(() => {
      keepaliveTimer = null;
      if (socket === null) return;
      if (!welcomed) {
        lastError = 'The Cellucid relay did not answer.';
        drop(CLOSE_UNANSWERED, 'no welcome');
        return;
      }
      if (pingSentAt !== null && heardAt < pingSentAt) {
        // The last ping went unanswered: the link is gone even if the
        // browser has not noticed (a sleeping laptop, a changed network).
        drop(CLOSE_UNANSWERED, 'unanswered');
        return;
      }
      pingSentAt = clock.now();
      send(RELAY_PING);
      keepalive();
    }, KEEPALIVE_MS);
  }

  function failCalls() {
    calls.failAll('The connection to the agent was lost');
  }

  function drop(code, reason) {
    const current = socket;
    if (current === null) return;
    detach(current);
    try { current.close(code, reason); } catch { /* already closing */ }
    afterClose(null);
  }

  function detach(current) {
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.onerror = null;
    if (socket === current) socket = null;
    welcomed = false;
    stopKeepalive();
  }

  function afterClose(code) {
    failCalls();
    for (const entry of requests.values()) entry.sent = false;
    if (code === RELAY_CLOSE.forgotten) {
      wanted = false;
      clearApprovals();
      setState('off', 'This browser\'s connection to agents was forgotten.');
      return;
    }
    if (code === RELAY_CLOSE.protocol) {
      wanted = false;
      setState('refused', 'This page and the Cellucid relay were updated separately. Reload the page to reconnect.');
      return;
    }
    if (wanted) scheduleRetry();
    else setState('off');
  }

  function scheduleRetry() {
    if (retryTimer !== null) return;
    const delay = Math.min(RECONNECT_DELAY_CEILING_MS, RECONNECT_FIRST_MS * 2 ** attempt) * (0.5 + clock.random() / 2);
    attempt += 1;
    retryAt = clock.now() + delay;
    setState('retrying', lastError);
    retryTimer = clock.setTimeout(() => {
      retryTimer = null;
      retryAt = null;
      dial();
    }, delay);
  }

  function retryNow() {
    if (!wanted || socket !== null) return;
    if (retryTimer !== null) clock.clearTimeout(retryTimer);
    retryTimer = null;
    retryAt = null;
    dial();
  }

  function dial() {
    if (!wanted || socket !== null) return;
    let secret;
    try {
      secret = secrets.read();
    } catch (error) {
      wanted = false;
      setState('unavailable', error.message);
      return;
    }
    if (secret === null) {
      wanted = false;
      setState('off');
      return;
    }
    setState('connecting', lastError);
    let current;
    try {
      current = new WebSocketImpl(socketUrl, [RELAY_SUBPROTOCOL, `${RELAY_SECRET_PREFIX}${secret}`]);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      scheduleRetry();
      return;
    }
    socket = current;
    heardAt = clock.now();
    keepalive();
    current.onmessage = onMessage;
    current.onerror = () => { lastError = 'The Cellucid relay cannot be reached.'; };
    current.onclose = event => {
      if (socket !== current) return;
      detach(current);
      afterClose(event?.code ?? null);
    };
  }

  function listen() {
    if (listeners !== null) return;
    listeners = new AbortController();
    const options = { signal: listeners.signal };
    win?.addEventListener?.('online', retryNow, options);
    win?.addEventListener?.('focus', reportState, options);
    win?.addEventListener?.('blur', reportState, options);
    win?.addEventListener?.('pagehide', () => { if (socket !== null) drop(CLOSE_GOING_AWAY, 'page hidden'); }, options);
    win?.addEventListener?.('pageshow', retryNow, options);
    doc?.addEventListener?.('visibilitychange', () => {
      reportState();
      if (doc.visibilityState === 'visible') retryNow();
    }, options);
  }

  function connectWith(secretReady) {
    if (!secretReady) return false;
    wanted = true;
    listen();
    dial();
    return true;
  }

  function clearApprovals() {
    for (const timer of approvalTimers) clock.clearTimeout(timer);
    approvalTimers.clear();
    approvals.clear();
  }

  /** Connect when this browser is paired already (a tab secret is kept); true when it is. */
  function start() {
    let secret;
    try {
      secret = secrets.read();
    } catch (error) {
      setState('unavailable', error.message);
      return false;
    }
    return connectWith(secret !== null);
  }

  /** Pair this browser now (making its tab secret) and connect. */
  function connect() {
    try {
      secrets.ensure();
    } catch (error) {
      setState('unavailable', error.message);
      throw error;
    }
    return connectWith(true);
  }

  /** Disconnect this tab (the pairing stays; `start` reconnects). */
  function stop() {
    wanted = false;
    if (retryTimer !== null) clock.clearTimeout(retryTimer);
    retryTimer = null;
    retryAt = null;
    if (socket !== null) drop(CLOSE_NORMAL, 'stopped');
    else setState('off');
    listeners?.abort();
    listeners = null;
  }

  /**
   * Ask the relay who asks to connect with `code` (typed or from the
   * approval link), pairing this browser first when needed. Resolves with
   * the approval the person answers; it is also handed to `onApproval`.
   * @param {string} code
   * @param {{via?: 'link'|'typed'}} [options]
   */
  async function claim(code, { via = 'typed' } = {}) {
    const exact = normalizeConnectCode(code);
    if (exact === null) throw relayError('That is not a connect code: it has eight letters and digits, like ABCD-EFGH.', 'not-a-code');
    if (!wanted) connect();
    const answer = await request('claim', { code: exact });
    const approval = Object.freeze({
      code: exact,
      display: formatConnectCode(exact),
      via,
      client: Object.freeze({ ...answer.client }),
      expiresAt: answer.expiresAt,
    });
    approvals.set(exact, approval);
    const timer = clock.setTimeout(() => {
      approvalTimers.delete(timer);
      if (approvals.get(exact) === approval) {
        approvals.delete(exact);
        setState(state, lastError);
      }
    }, Math.max(0, approval.expiresAt - clock.now()));
    approvalTimers.add(timer);
    try { onApproval(approval); } catch (cause) { console.error('[agent relay] approval listener failed', cause); }
    setState(state, lastError);
    return approval;
  }

  async function decide(code, allow) {
    const exact = normalizeConnectCode(code);
    if (exact === null) throw relayError('That is not a connect code.', 'not-a-code');
    try {
      await request('decide', { code: exact, allow });
    } finally {
      approvals.delete(exact);
      setState(state, lastError);
    }
  }

  /**
   * Forget this browser's pairing: the relay removes every connection made
   * through it, every tab of this browser disconnects, and the tab secret
   * is deleted. Resolves `{revokedAtRelay}`: false when the relay could not
   * be reached (the connections then stop working anyway, since no tab can
   * prove the forgotten secret).
   */
  async function forget() {
    let revokedAtRelay = false;
    if (open()) {
      try {
        await request('forget');
        revokedAtRelay = true;
      } catch {
        revokedAtRelay = false;
      }
    }
    secrets.forget();
    wanted = false;
    if (retryTimer !== null) clock.clearTimeout(retryTimer);
    retryTimer = null;
    retryAt = null;
    if (socket !== null) drop(CLOSE_NORMAL, 'forgotten');
    clearApprovals();
    setState('off');
    return { revokedAtRelay };
  }

  /** Stop for good: disconnect and stop listening to the page and the dispatcher. */
  function destroy() {
    stop();
    calls.destroy();
    clearApprovals();
    for (const entry of requests.values()) {
      clock.clearTimeout(entry.timer);
      entry.reject(relayError('The connection to agents was closed.', 'closed'));
    }
    requests.clear();
  }

  return Object.freeze({
    status,
    reportState,
    start,
    connect,
    stop,
    claim,
    /** Allow the connection waiting with `code`. */
    approve: code => decide(code, true),
    /** Refuse the connection waiting with `code`. */
    deny: code => decide(code, false),
    /** The agents connected through this browser: `[{grant, agent, client, host, createdAt, lastUsedAt, expiresAt}]`. */
    connections: () => request('connections'),
    /** Remove one connection; that agent must be approved again. */
    disconnect: grant => request('disconnect', { grant }),
    forget,
    destroy,
  });
}

/**
 * The page's relay client: the deployed relay, this browser's tab secret,
 * the page's dispatcher. It connects at once when this browser is paired
 * already, and claims the connect code the page was opened with (the relay
 * approval page's link), which pairs it first when needed.
 *
 * @param {{
 *   actions: object,
 *   onApproval?: (approval: object) => void,
 *   onApprovalError?: (failure: {code: string, display: string, error: Error}) => void,
 *   onStatus?: (status: object) => void,
 *   onConnectionsChanged?: () => void,
 *   datasetName?: () => string|null,
 *   datasetLink?: () => string|null,
 * }} options
 */
export function startRelayClientForPage({ actions, onApprovalError = () => {}, ...listeners }) {
  const version = pageVersion() ?? '';
  const client = createRelayClient({ relayOrigin: relayOriginForPage(), actions, version, ...listeners });
  const pending = takeConnectCode();
  if (pending !== null) {
    client.claim(pending.code, { via: pending.via }).catch(error => {
      onApprovalError({ code: pending.code, display: formatConnectCode(pending.code), error });
    });
  } else {
    client.start();
  }
  return client;
}
