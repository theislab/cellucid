/**
 * One pairing: a Durable Object per browser that connected agents (its name
 * is the pairing id, derived from the tab secret; `keys.js`).
 *
 * It holds:
 *
 * - **the tabs** of that browser, as hibernating WebSockets (the object
 *   sleeps between messages and the sockets stay open); each socket's
 *   attachment says when it connected, whether it is focused and visible,
 *   and which dataset it shows. Calls go to the tab focused last.
 * - **calls in flight**: a tool call or a tool list sent to a tab and the
 *   HTTP request waiting for its answer, in memory only (a call in flight
 *   keeps the object awake). A call waits at most `TAB_CALL_WAIT_MS`, under
 *   the 240 s Claude gives a tool call; the caller giving up, the tab closing
 *   or the time running out each answer it and tell the tab to stop, except
 *   a call whose question the person is still being asked (the tab said
 *   `asking`): its time running out answers the agent with that, and the
 *   tab keeps the question open (`detach`).
 * - **connections** (OAuth grants), in storage: per agent connected through
 *   this browser, its client (the client id's digest), name, when it was made and last used, until
 *   when it lasts, and its refresh-token generation (a refresh token works
 *   once; a used one presented again closes the connection, the theft
 *   signal of OAuth 2.1). Forget deletes them all and closes every tab.
 *
 * It never stores a tool's arguments or results, a chat, or any dataset
 * bytes; they pass through memory on their way between the agent and the tab.
 */

import { RELAY_BUNDLE } from './generated/bundle.js';
import { isConnectCode } from './approval.js';
import { displayText } from './clients.js';
import { randomBase64Url, sha256Base64Url } from './encoding.js';

/** How long a tool call may wait for the tab: under the 240 s Claude allows a tool call, with time for the answer to travel. */
export const TAB_CALL_WAIT_MS = 225_000;
/**
 * How long the tab may take to list its tools before the relay answers with
 * its bundled list: a tab that is awake answers within a round trip, so one
 * that has not after this is asleep (a frozen background tab) or gone.
 */
export const TAB_LIST_WAIT_MS = 5_000;
/**
 * How long a call or a status waits for this browser's tab to come back when
 * its last tab closed a moment ago: a reloaded page reaches the relay again
 * within a few seconds (the page dials before its dataset opens; measured:
 * 34_decisions_agents.md) and reports its dataset soon after,
 * so a call that arrives during a reload runs in the reloaded tab instead of
 * being told no tab is there. A tab that closed for good is said so after
 * this wait, well within the time a client shows a call as running.
 */
export const TAB_RECONNECT_WAIT_MS = 20_000;
/** How long a connection lasts unused: each refresh renews it. */
export const CONNECTION_SECONDS = 30 * 24 * 60 * 60;
/** How often "last used" is written (it is shown to the person in minutes, not seconds). */
const LAST_USED_RESOLUTION_MS = 60_000;

/** The header the Worker names the pairing with on every request to this object. */
export const PAIRING_HEADER = 'X-Cellucid-Pairing';
/** The header the Worker passes the tab's offered protocol in. */
export const PROTOCOL_HEADER = 'X-Cellucid-Protocol';

const TAB_TAG = 'tab';
const OPEN = 1;
const PROTOCOL = RELAY_BUNDLE.protocol;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Why a tab's tool result cannot be passed on, or null: text over the bound
 * is reported with its length, a picture over a chat's bound with its size
 * (the tab leaves such a picture out itself; this holds a tab that did not).
 */
function resultProblem(result) {
  if (result === null || typeof result !== 'object' || !Array.isArray(result.content) || typeof result.isError !== 'boolean') {
    return { outcome: 'bad-result' };
  }
  let chars = 0;
  for (const item of result.content) {
    if (item?.type === 'text' && typeof item.text === 'string') {
      chars += item.text.length;
    } else if (item?.type === 'image' && IMAGE_TYPES.has(item.mimeType) && typeof item.data === 'string' && BASE64.test(item.data)) {
      // Pictures are not text: Claude's bound counts characters of text.
      if (item.data.length > PROTOCOL.resultImageMaxBytes) return { outcome: 'oversize-image', bytes: item.data.length };
    } else {
      return { outcome: 'bad-result' };
    }
  }
  return chars > PROTOCOL.resultTextChars ? { outcome: 'oversize', chars } : null;
}

export class RelayPairing {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    /** @type {Map<string, {tab: string, grant: string|null, rpcId: unknown, socket: WebSocket, settle: (answer: object) => void}>} */
    this.pending = new Map();
    /** When the last open tab of this browser closed (0: none closed while this object was awake). */
    this.lastTabGoneAt = 0;
    /** Calls and statuses waiting for a tab to come back: each is woken by a tab's connection or state. */
    this.tabWaiters = new Set();
    // The platform answers the tab's keep-alive without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PROTOCOL.ping, PROTOCOL.pong));
  }

  // ---- HTTP from the Worker -------------------------------------------------

  async fetch(request) {
    const { pathname } = new URL(request.url);
    const pairingId = request.headers.get(PAIRING_HEADER);
    if (pathname === '/tab') return this.acceptTab(request, pairingId);
    const body = await request.json();
    switch (pathname) {
      case '/grant/create': return json(await this.createGrant(body));
      case '/grant/rotate': return json(await this.rotateGrant(body));
      case '/list': return json(await this.list(body));
      case '/call': return json(await this.call(body));
      case '/status': return json(await this.status(body));
      case '/cancel': return json(this.cancel(body));
      default: return json({ error: 'unknown' }, 404);
    }
  }

  acceptTab(request, pairingId) {
    const offered = request.headers.get(PROTOCOL_HEADER);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [TAB_TAG]);
    server.serializeAttachment({
      tab: randomBase64Url(12),
      pairingId,
      connectedAt: Date.now(),
      focusedAt: 0,
      focused: false,
      visible: true,
      dataset: null,
      version: null,
    });
    server.send(JSON.stringify({ type: 'welcome', protocol: PROTOCOL.version }));
    if (offered !== PROTOCOL.subprotocol) {
      server.close(PROTOCOL.close.protocol, 'protocol');
    }
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': offered } });
  }

  tabs() {
    return this.ctx.getWebSockets(TAB_TAG).filter(socket => socket.readyState === OPEN);
  }

  /**
   * The tab calls go to, once there is one to go to: while the last tab of
   * this browser closed less than `TAB_RECONNECT_WAIT_MS` ago (a reload), wait
   * until a tab is back and has said which dataset it shows, or the wait is
   * over; otherwise the tab there is now (`target`), or null.
   */
  async targetSoon() {
    const deadline = this.lastTabGoneAt + TAB_RECONNECT_WAIT_MS;
    for (;;) {
      const socket = this.target();
      const ready = socket !== null && socket.deserializeAttachment().dataset !== null;
      const left = deadline - Date.now();
      if (ready || left <= 0) return socket;
      await new Promise(resolve => {
        const wake = () => { clearTimeout(timer); this.tabWaiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, left);
        this.tabWaiters.add(wake);
      });
    }
  }

  wakeTabWaiters() {
    for (const wake of [...this.tabWaiters]) wake();
  }

  /** The tab calls go to: focused last, else connected last. */
  target() {
    let best = null;
    let bestAttachment = null;
    for (const socket of this.tabs()) {
      const attachment = socket.deserializeAttachment();
      if (best === null
        || attachment.focusedAt > bestAttachment.focusedAt
        || (attachment.focusedAt === bestAttachment.focusedAt && attachment.connectedAt > bestAttachment.connectedAt)) {
        best = socket;
        bestAttachment = attachment;
      }
    }
    return best;
  }

  broadcast(message) {
    const text = JSON.stringify(message);
    for (const socket of this.tabs()) {
      try { socket.send(text); } catch { /* closing */ }
    }
  }

  /** Send `message` to `socket` and wait for the tab's answer (`settle`d by its id). */
  ask(socket, message, waitMs, { grant = null, rpcId = null } = {}) {
    const { tab } = socket.deserializeAttachment();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(message.id);
        if (entry === undefined) return;
        this.pending.delete(message.id);
        // The person is being asked: the question stays open in the tab
        // (detached, never cancelled), and the agent is told so.
        if (entry.asking !== null) {
          try { socket.send(JSON.stringify({ type: 'detach', id: message.id })); } catch { /* closing */ }
          resolve({ outcome: 'asking', detail: entry.asking.detail });
          return;
        }
        try { socket.send(JSON.stringify({ type: 'cancel', id: message.id })); } catch { /* closing */ }
        resolve({ outcome: 'timeout' });
      }, waitMs);
      this.pending.set(message.id, {
        tab, grant, rpcId, socket, asking: null,
        settle: answer => {
          clearTimeout(timer);
          this.pending.delete(message.id);
          resolve(answer);
        },
      });
      try {
        socket.send(JSON.stringify(message));
      } catch {
        this.pending.get(message.id)?.settle({ outcome: 'tab-closed' });
      }
    });
  }

  // ---- connections (grants) ---------------------------------------------------

  async grant(id) {
    if (typeof id !== 'string') return null;
    const record = await this.ctx.storage.get(`grant:${id}`);
    if (record === undefined) return null;
    if (Date.now() >= record.expiresAt) {
      await this.ctx.storage.delete(`grant:${id}`);
      return null;
    }
    return record;
  }

  async scheduleExpiry() {
    const grants = await this.ctx.storage.list({ prefix: 'grant:' });
    let next = Infinity;
    for (const record of grants.values()) next = Math.min(next, record.expiresAt);
    if (next === Infinity) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  async createGrant({ clientId, agent, clientName, clientHost, known, scope }) {
    const id = randomBase64Url(16);
    const now = Date.now();
    // The client id is kept as its digest: a registered one is up to
    // CLIENT_ID_MAX_CHARS of the registrant's choosing, and a connection is
    // kept for CONNECTION_SECONDS, so the id itself would let anyone who
    // approves their own connections in a loop store kilobytes per connection
    // for a month. Checking a refresh needs only equality.
    await this.ctx.storage.put(`grant:${id}`, {
      clientDigest: await sha256Base64Url(clientId), agent, clientName, clientHost, known: known === true, scope,
      generation: 0, createdAt: now, lastUsedAt: now, expiresAt: now + CONNECTION_SECONDS * 1000,
    });
    await this.scheduleExpiry();
    this.broadcast({ type: 'event', name: 'connections-changed' });
    return { grant: id, generation: 0 };
  }

  async rotateGrant({ grant, generation, clientId }) {
    const record = await this.grant(grant);
    if (record === null) return { error: 'This connection was removed in Cellucid or has expired; connect again.' };
    if (clientId !== null && await sha256Base64Url(clientId) !== record.clientDigest) {
      return { error: 'This refresh token was issued to another client.' };
    }
    if (generation !== record.generation) {
      await this.ctx.storage.delete(`grant:${grant}`);
      await this.scheduleExpiry();
      this.endCalls([grant]);
      this.broadcast({ type: 'event', name: 'connections-changed' });
      return { error: 'This refresh token was used already, so the connection was closed for safety; connect again.' };
    }
    const now = Date.now();
    record.generation += 1;
    record.lastUsedAt = now;
    record.expiresAt = now + CONNECTION_SECONDS * 1000;
    await this.ctx.storage.put(`grant:${grant}`, record);
    await this.scheduleExpiry();
    return { generation: record.generation, scope: record.scope };
  }

  async touch(id, record) {
    const now = Date.now();
    if (now - record.lastUsedAt < LAST_USED_RESOLUTION_MS) return;
    record.lastUsedAt = now;
    await this.ctx.storage.put(`grant:${id}`, record);
  }

  async connections() {
    const grants = await this.ctx.storage.list({ prefix: 'grant:' });
    const now = Date.now();
    return [...grants.entries()]
      .filter(([, record]) => now < record.expiresAt)
      .map(([key, record]) => ({
        grant: key.slice('grant:'.length),
        agent: record.agent,
        client: record.clientName,
        host: record.clientHost,
        // Whether Claude's or ChatGPT's host vouches for it: else its own name is only what it calls itself.
        known: record.known === true,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
        expiresAt: record.expiresAt,
      }))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  async alarm() {
    const grants = await this.ctx.storage.list({ prefix: 'grant:' });
    const now = Date.now();
    const expired = [...grants.entries()].filter(([, record]) => now >= record.expiresAt).map(([key]) => key);
    if (expired.length > 0) {
      await this.ctx.storage.delete(expired);
      this.endCalls(expired.map(key => key.slice('grant:'.length)));
      this.broadcast({ type: 'event', name: 'connections-changed' });
    }
    await this.scheduleExpiry();
  }

  // ---- MCP work ---------------------------------------------------------------

  async list({ grant }) {
    if (await this.grant(grant) === null) return { outcome: 'revoked' };
    const socket = await this.targetSoon();
    if (socket === null) return { outcome: 'no-tab' };
    // The connection asking: its tools say what the person's settings let it do.
    const answer = await this.ask(socket, { type: 'list', id: randomBase64Url(12), grant }, TAB_LIST_WAIT_MS);
    return answer.outcome === 'tools' ? answer : { outcome: 'no-answer' };
  }

  async call({ grant, callId, rpcId, tool, args }) {
    const record = await this.grant(grant);
    if (record === null) return { outcome: 'revoked' };
    await this.touch(grant, record);
    const socket = await this.targetSoon();
    if (socket === null) return { outcome: 'no-tab' };
    // `agent` is the name the person sees (the vouching host for an app that is not Claude's or
    // ChatGPT's); the app's own name goes with `known`, so the tab quotes an unvouched one.
    return this.ask(socket, {
      type: 'call', id: callId, tool, args, agent: record.agent, grant,
      client: record.clientName ?? null, host: record.clientHost ?? null, known: record.known === true,
    }, TAB_CALL_WAIT_MS, { grant, rpcId });
  }

  async status({ grant }) {
    const record = await this.grant(grant);
    if (record === null) return { outcome: 'revoked' };
    const target = await this.targetSoon();
    return {
      outcome: 'status',
      agent: record.agent,
      tabs: this.tabs().map(socket => {
        const { focused, visible, dataset, version, connectedAt } = socket.deserializeAttachment();
        return { focused, visible, dataset, version, connectedAt, receivesCalls: socket === target };
      }),
    };
  }

  /**
   * Connections ended (removed in Cellucid, closed after a refresh token was
   * used twice, expired, or every one of this browser forgotten): their
   * calls in flight are stopped in the tab and answered as such at once, so
   * nothing a removed agent asked for goes on running, records a step as
   * that agent, or sends it what the call read. `grants` null: every one.
   */
  endCalls(grants) {
    for (const [id, entry] of [...this.pending]) {
      if (entry.grant === null || (grants !== null && !grants.includes(entry.grant))) continue;
      try { entry.socket.send(JSON.stringify({ type: 'cancel', id })); } catch { /* closing */ }
      entry.settle({ outcome: 'removed' });
    }
  }

  /** The caller stopped waiting: by the call's id, or (an MCP cancellation) by the request id of its connection. */
  cancel({ callId = null, grant = null, rpcId = null }) {
    for (const [id, entry] of this.pending) {
      if (id === callId || (grant !== null && entry.grant === grant && entry.rpcId === rpcId)) {
        try { entry.socket.send(JSON.stringify({ type: 'cancel', id })); } catch { /* closing */ }
        entry.settle({ outcome: 'cancelled' });
        return { cancelled: true };
      }
    }
    return { cancelled: false };
  }

  // ---- the tab's messages -----------------------------------------------------

  reply(socket, ref, value, error = null) {
    const message = error === null ? { type: 'reply', ref, ok: true, value } : { type: 'reply', ref, ok: false, error };
    try { socket.send(JSON.stringify(message)); } catch { /* closing */ }
  }

  async approval(code, path, body) {
    const stub = this.env.APPROVAL.get(this.env.APPROVAL.idFromName(`approval:${code}`));
    const response = await stub.fetch(`https://approval${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: response.ok, body: await response.json() };
  }

  async webSocketMessage(socket, message) {
    if (typeof message !== 'string') {
      socket.close(1003, 'text frames only');
      return;
    }
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (data === null || typeof data !== 'object') return;
    const attachment = socket.deserializeAttachment();
    switch (data.type) {
      case 'state': {
        const focused = data.focused === true;
        socket.serializeAttachment({
          ...attachment,
          focused,
          visible: data.visible !== false,
          focusedAt: focused ? Date.now() : attachment.focusedAt,
          dataset: displayText(data.dataset),
          version: typeof data.version === 'string' ? displayText(data.version) : null,
        });
        this.wakeTabWaiters();
        return;
      }
      case 'result': {
        const entry = this.pending.get(data.id);
        if (entry === undefined || entry.tab !== attachment.tab) return;
        if (data.error !== undefined) {
          entry.settle(data.error?.code === 'unknown-tool'
            ? { outcome: 'unknown-tool', message: String(data.error.message ?? '') }
            : { outcome: 'bad-result' });
          return;
        }
        entry.settle(resultProblem(data.result) ?? { outcome: 'result', result: data.result });
        return;
      }
      case 'asking':
      case 'answered': {
        // Cellucid asks the person about a call (a large download), or they answered.
        const entry = this.pending.get(data.id);
        if (entry === undefined || entry.tab !== attachment.tab) return;
        // The sentence is passed on in a tool result: bounded by what one carries.
        entry.asking = data.type === 'asking' ? { detail: displayText(data.detail, PROTOCOL.resultTextChars) } : null;
        return;
      }
      case 'tools': {
        const entry = this.pending.get(data.id);
        if (entry === undefined || entry.tab !== attachment.tab) return;
        const valid = Array.isArray(data.tools) && data.tools.every(tool => typeof tool?.name === 'string'
          && tool.inputSchema !== null && typeof tool.inputSchema === 'object');
        entry.settle(valid ? { outcome: 'tools', tools: data.tools } : { outcome: 'bad-result' });
        return;
      }
      case 'decide': {
        // A code is claimed over HTTP, with the browser's approver cookie
        // (`oauth.js` `handleClaim`); only the pairing that claimed it decides.
        if (!isConnectCode(data.code)) {
          this.reply(socket, data.ref, null, { code: 'not-a-code', message: 'That is not a connect code.' });
          return;
        }
        const answer = await this.approval(data.code, '/decide', { pairingId: attachment.pairingId, allow: data.allow === true });
        if (answer.ok) this.reply(socket, data.ref, answer.body);
        else this.reply(socket, data.ref, null, { code: answer.body.code, message: answer.body.message });
        return;
      }
      case 'connections':
        this.reply(socket, data.ref, await this.connections());
        return;
      case 'disconnect': {
        const removed = typeof data.grant === 'string' && (await this.ctx.storage.delete(`grant:${data.grant}`));
        await this.scheduleExpiry();
        if (removed) {
          this.endCalls([data.grant]);
          this.broadcast({ type: 'event', name: 'connections-changed' });
        }
        this.reply(socket, data.ref, { removed: Boolean(removed) });
        return;
      }
      case 'forget': {
        await this.ctx.storage.deleteAll();
        await this.ctx.storage.deleteAlarm();
        this.endCalls(null);
        this.reply(socket, data.ref, { forgotten: true });
        for (const tab of this.tabs()) {
          try { tab.close(PROTOCOL.close.forgotten, 'forgotten'); } catch { /* closing */ }
        }
        return;
      }
      default:
    }
  }

  closed(socket) {
    const { tab } = socket.deserializeAttachment() ?? {};
    for (const entry of [...this.pending.values()]) {
      if (entry.tab === tab) entry.settle({ outcome: 'tab-closed' });
    }
    // The last tab gone: a reload brings it back within seconds (`targetSoon`).
    if (this.tabs().every(other => other === socket)) this.lastTabGoneAt = Date.now();
  }

  async webSocketClose(socket, code, reason) {
    this.closed(socket);
    try { socket.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch { /* closed already */ }
  }

  async webSocketError(socket) {
    this.closed(socket);
  }
}
