/**
 * An in-memory Cloudflare Workers runtime for the relay's contract tests:
 * Durable Object namespaces whose objects keep their storage (with alarms)
 * across requests, the WebSocket Hibernation API (`acceptWebSocket`,
 * `getWebSockets`, attachments, the keep-alive auto-response), and
 * `WebSocketPair` with the `101 Switching Protocols` answer Node's `Response`
 * does not allow. The relay runs on it unchanged (`relay/worker.js`).
 *
 * `installWorkersRuntime()` puts the globals in place for one test file and
 * returns a function that takes them away again.
 */

const OPEN = 1;
const CLOSED = 3;

class FakeStorage {
  constructor() {
    this.values = new Map();
    this.alarm = null;
  }

  async get(key) {
    if (Array.isArray(key)) return new Map(key.filter(k => this.values.has(k)).map(k => [k, structuredClone(this.values.get(k))]));
    return this.values.has(key) ? structuredClone(this.values.get(key)) : undefined;
  }

  async put(key, value) {
    if (typeof key === 'object') {
      for (const [k, v] of Object.entries(key)) this.values.set(k, structuredClone(v));
      return;
    }
    this.values.set(key, structuredClone(value));
  }

  async delete(key) {
    if (Array.isArray(key)) {
      let count = 0;
      for (const k of key) if (this.values.delete(k)) count += 1;
      return count;
    }
    return this.values.delete(key);
  }

  async deleteAll() {
    this.values.clear();
  }

  async list({ prefix = '' } = {}) {
    return new Map([...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => [key, structuredClone(value)]));
  }

  async setAlarm(time) {
    this.alarm = typeof time === 'number' ? time : time.getTime();
  }

  async getAlarm() {
    return this.alarm;
  }

  async deleteAlarm() {
    this.alarm = null;
  }
}

/** One end of a fake WebSocket pair. */
class FakeSocket {
  constructor() {
    this.readyState = OPEN;
    this.peer = null;
    this.listeners = new Map();
    this.attachment = null;
    /** Set on the server end when an object accepts it. */
    this.owner = null;
    this.tags = [];
    /** Messages this end received, in order. */
    this.received = [];
    this.closeEvent = null;
    this.work = [];
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, event) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  serializeAttachment(value) {
    const copy = structuredClone(value);
    if (JSON.stringify(copy).length > 16_384) throw new RangeError('attachment too large');
    this.attachment = copy;
  }

  deserializeAttachment() {
    return this.attachment === null ? null : structuredClone(this.attachment);
  }

  send(data) {
    if (this.readyState !== OPEN) throw new TypeError('WebSocket is closed');
    const peer = this.peer;
    if (this.owner !== null) {
      // The object's end: deliver to the client end.
      peer.received.push(data);
      peer.emit('message', { data });
      return;
    }
    // The client end: the platform's auto-response, or the object's handler.
    const object = peer.owner;
    const auto = object?.ctxAutoResponse ?? null;
    if (auto !== null && data === auto.request) {
      queueMicrotask(() => {
        this.received.push(auto.response);
        this.emit('message', { data: auto.response });
      });
      return;
    }
    const delivery = Promise.resolve().then(() => object.instance.webSocketMessage(peer, data));
    this.work.push(delivery);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    const peer = this.peer;
    if (peer.readyState !== CLOSED) {
      peer.readyState = CLOSED;
      if (this.owner !== null) {
        peer.closeEvent = { code, reason };
        peer.emit('close', { code, reason });
      } else {
        const object = peer.owner;
        const delivery = Promise.resolve().then(() => object.instance.webSocketClose(peer, code, reason, true));
        this.work.push(delivery);
      }
    }
  }

  /** Wait until every message this client end sent has been handled by the object. */
  async settle() {
    while (this.work.length > 0) await this.work.shift();
  }

  /** The received messages parsed as JSON (keep-alive text left out). */
  messages() {
    return this.received.filter(text => text.startsWith('{')).map(text => JSON.parse(text));
  }

  /** The next received JSON message that matches `predicate` (already received ones count). */
  next(predicate = () => true) {
    const seen = this.messages().find(predicate);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise(resolve => {
      const listener = event => {
        if (!String(event.data).startsWith('{')) return;
        const message = JSON.parse(event.data);
        if (predicate(message)) {
          this.removeEventListener('message', listener);
          resolve(message);
        }
      };
      this.addEventListener('message', listener);
    });
  }
}

class FakeWebSocketPair {
  constructor() {
    const client = new FakeSocket();
    const server = new FakeSocket();
    client.peer = server;
    server.peer = client;
    this[0] = client;
    this[1] = server;
  }
}

class FakeRequestResponsePair {
  constructor(request, response) {
    this.request = request;
    this.response = response;
  }
}

/** A Durable Object namespace: one instance (and one storage) per name. */
export class FakeNamespace {
  constructor(ObjectClass) {
    this.ObjectClass = ObjectClass;
    this.env = null;
    this.objects = new Map();
  }

  idFromName(name) {
    return Object.freeze({ name, toString: () => `id:${name}` });
  }

  object(name) {
    let object = this.objects.get(name);
    if (object === undefined) {
      const sockets = [];
      object = { name, sockets, ctxAutoResponse: null, instance: null };
      const ctx = {
        id: this.idFromName(name),
        storage: new FakeStorage(),
        acceptWebSocket(socket, tags = []) {
          socket.owner = object;
          socket.tags = [...tags];
          sockets.push(socket);
        },
        getWebSockets(tag) {
          return sockets.filter(socket => socket.readyState === OPEN && (tag === undefined || socket.tags.includes(tag)));
        },
        setWebSocketAutoResponse(pair) {
          object.ctxAutoResponse = pair;
        },
      };
      object.ctx = ctx;
      object.instance = new this.ObjectClass(ctx, this.env);
      this.objects.set(name, object);
    }
    return object;
  }

  /** The object's instance (for alarms and inspection in tests). */
  instance(name) {
    return this.object(name).instance;
  }

  get(id) {
    const object = this.object(id.name);
    return {
      fetch: async (input, init) => object.instance.fetch(input instanceof Request ? input : new Request(input, init)),
    };
  }
}

/**
 * Install `WebSocketPair`, `WebSocketRequestResponsePair` and a `Response`
 * that also makes the `101` answer with its `webSocket`.
 * @returns {() => void} take them away
 */
export function installWorkersRuntime() {
  const NodeResponse = globalThis.Response;
  const previous = {
    WebSocketPair: globalThis.WebSocketPair,
    WebSocketRequestResponsePair: globalThis.WebSocketRequestResponsePair,
  };
  function WorkersResponse(body, init = {}) {
    if (init?.status === 101) {
      return { status: 101, ok: false, webSocket: init.webSocket, headers: new Headers(init.headers) };
    }
    return new NodeResponse(body, init);
  }
  WorkersResponse.prototype = NodeResponse.prototype;
  globalThis.Response = WorkersResponse;
  globalThis.WebSocketPair = FakeWebSocketPair;
  globalThis.WebSocketRequestResponsePair = FakeRequestResponsePair;
  return () => {
    globalThis.Response = NodeResponse;
    globalThis.WebSocketPair = previous.WebSocketPair;
    globalThis.WebSocketRequestResponsePair = previous.WebSocketRequestResponsePair;
  };
}

/**
 * The relay's environment over fresh namespaces.
 * @param {{PAIRING: Function, APPROVAL: Function}} classes
 */
export function relayEnvironment({ RelayPairing, RelayApproval }, overrides = {}) {
  const env = {
    RELAY_SIGNING_KEY: 'k'.repeat(20) + '0123456789abcdefghijklmnopqrstuv',
    ALLOWED_ORIGINS: 'https://www.cellucid.com,http://localhost:8000',
    PAIRING: new FakeNamespace(RelayPairing),
    APPROVAL: new FakeNamespace(RelayApproval),
    ...overrides,
  };
  for (const binding of [env.PAIRING, env.APPROVAL]) {
    if (binding instanceof FakeNamespace) binding.env = env;
  }
  return env;
}
