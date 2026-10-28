/**
 * The viewer embedded by a notebook widget: the page at
 * `?viewer=embedded`, framed by the widget's own output (`cellucid.Widget`
 * in Python), which talks to the notebook kernel over the notebook's own
 * connection. The page reaches the kernel only through that frame, so no
 * port, proxy or server address is involved anywhere: the same page works in
 * JupyterLab, Notebook 7, VS Code, Google Colab, marimo and Databricks.
 *
 * One transport, under the protocol, replaces the WebSocket and the HTTP
 * requests a served viewer uses:
 *
 * 1. The page tells the frame that embeds it that it is ready
 *    (`{[VIEWER_EMBED_KEY]: 'ready'}`, posted to `window.parent`; it carries
 *    nothing). The widget accepts that message only from its own frame
 *    (`event.source`) and only from the origin it loaded the page from.
 * 2. The widget answers with `connect`, posted to the page's exact origin
 *    with one `MessagePort` transferred and the viewer's id and token: the
 *    credentials travel only in this message, never in an address, and the
 *    page accepts it only from `window.parent`.
 * 3. Everything after travels on that port, which no other window can post
 *    to. The viewer channel (`viewer-channel.js`) runs unchanged over
 *    `PortSocket`, a WebSocket whose frames are port messages
 *    (`{t: 'open'|'text'|'binary'|'close', s}`), and every request the page
 *    and its reader workers make to `EMBEDDED_HOST_ORIGIN` is answered over
 *    it (`{t: 'fetch', id, method, path, range}`, withdrawn with
 *    `{t: 'cancel', id}`, and `{t: 'answer', id,
 *    status, headers, bytes}`, `formats/io/host-fetch.js`).
 *
 * The widget relays each port message to the kernel and back; the kernel
 * runs the same viewer channel the WebSocket reaches (`hello`/`welcome`,
 * the commands, the events) and answers the requests from the dataset the
 * notebook showed. Binary bodies travel as transferred ArrayBuffers.
 *
 * @module data/viewer-embed
 */

import { EMBEDDED_HOST_ORIGIN, setHostRequester } from '../formats/io/host-fetch.js';
import { onAbort } from '../formats/io/abort.js';
import { isPlainRecord } from '../utils/exact-record.js';

/** The value of the page's `viewer` parameter that makes it an embedded viewer. */
export const VIEWER_EMBED_MODE = 'embedded';

/** The key every window message of the embedding handshake carries. */
export const VIEWER_EMBED_KEY = 'cellucidViewerEmbed';

/** Close code of a port socket whose frame went away (the widget's output was removed). */
const GOING_AWAY = 1001;

/**
 * Whether `params` (the page's search parameters) open the embedded viewer:
 * exactly `viewer=embedded`, nothing else. The page carries no credentials.
 *
 * @param {URLSearchParams} params
 * @returns {boolean}
 */
export function isEmbeddedViewerAddress(params) {
  const keys = [...params.keys()];
  return keys.length === 1 && keys[0] === 'viewer' && params.get('viewer') === VIEWER_EMBED_MODE;
}

function requireConnect(data) {
  if (!isPlainRecord(data) || data[VIEWER_EMBED_KEY] !== 'connect') return null;
  const keys = Object.keys(data).sort();
  if (keys.length !== 3 || keys[0] !== VIEWER_EMBED_KEY || keys[1] !== 'viewerId' || keys[2] !== 'viewerToken') {
    return null;
  }
  for (const key of ['viewerId', 'viewerToken']) {
    const value = data[key];
    if (typeof value !== 'string' || value.length === 0 || /\s/.test(value)) return null;
  }
  return { viewerId: data.viewerId, viewerToken: data.viewerToken };
}

/**
 * The page's end of the port to the widget: the sockets open on it and the
 * requests waiting for an answer.
 */
class EmbeddedHost {
  /**
   * @param {MessagePort} port
   */
  constructor(port) {
    this.port = port;
    /** @type {Map<number, PortSocket>} */
    this.sockets = new Map();
    this.nextSocket = 0;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.requests = new Map();
    this.nextRequest = 0;
    port.onmessage = event => this._receive(event.data);
    port.start?.();
  }

  _receive(message) {
    if (!isPlainRecord(message)) return;
    if (message.t === 'answer') {
      const waiting = this.requests.get(message.id);
      if (waiting === undefined) return;
      this.requests.delete(message.id);
      if (typeof message.error === 'string') {
        waiting.reject(new Error(message.error));
        return;
      }
      waiting.resolve({
        status: message.status,
        headers: isPlainRecord(message.headers) ? message.headers : {},
        bytes: message.bytes instanceof ArrayBuffer ? message.bytes : null,
      });
      return;
    }
    const socket = this.sockets.get(message.s);
    socket?._receive(message);
  }

  /** @type {import('../formats/io/host-fetch.js').HostRequester} */
  request(request, { signal }) {
    return new Promise((resolve, reject) => {
      const id = this.nextRequest++;
      const stop = onAbort(signal, () => {
        this.requests.delete(id);
        // The widget drops it if it has not gone to the kernel yet.
        this.port.postMessage({ t: 'cancel', id });
        reject(signal.reason ?? new DOMException('The request was aborted.', 'AbortError'));
      });
      this.requests.set(id, {
        resolve: value => {
          stop();
          resolve(value);
        },
        reject: error => {
          stop();
          reject(error);
        },
      });
      this.port.postMessage({
        t: 'fetch',
        id,
        method: request.method,
        path: request.path,
        range: request.range ?? null,
      });
    });
  }

  /** The WebSocket class whose sockets are frames on this port. */
  socketClass() {
    const host = this;
    return class extends PortSocket {
      constructor(url) {
        super(host, url);
      }
    };
  }
}

/**
 * A WebSocket whose frames travel on the port to the widget, for
 * `ViewerChannel` (`WebSocketImpl`). Frames are sent in the order `send` is
 * called, a Blob's bytes included.
 */
export class PortSocket {
  /**
   * @param {EmbeddedHost} host
   * @param {string} url
   */
  constructor(host, url) {
    this.url = url;
    this.readyState = 0;
    this.binaryType = 'blob';
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this._host = host;
    this._id = host.nextSocket++;
    /** Sends wait on this so a Blob read cannot reorder frames. */
    this._sending = Promise.resolve();
    host.sockets.set(this._id, this);
    host.port.postMessage({ t: 'open', s: this._id });
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data) {
    if (this.readyState !== 1) return;
    const port = this._host.port;
    const s = this._id;
    this._sending = this._sending.then(async () => {
      if (typeof data === 'string') {
        port.postMessage({ t: 'text', s, text: data });
        return;
      }
      let bytes;
      if (data instanceof Blob) bytes = await data.arrayBuffer();
      else if (data instanceof ArrayBuffer) bytes = data.slice(0);
      else bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      port.postMessage({ t: 'binary', s, bytes }, [bytes]);
    }).catch(error => {
      console.error('[ViewerEmbed] a frame could not be sent:', error);
    });
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this._sending = this._sending.then(() => {
      this._host.port.postMessage({ t: 'close', s: this._id, code, reason });
    });
    this._host.sockets.delete(this._id);
    queueMicrotask(() => this.onclose?.({ code, reason, wasClean: true }));
  }

  _receive(message) {
    if (this.readyState === 3) return;
    if (message.t === 'text' && typeof message.text === 'string') {
      this.onmessage?.({ data: message.text });
    } else if (message.t === 'binary' && message.bytes instanceof ArrayBuffer) {
      this.onmessage?.({ data: this.binaryType === 'arraybuffer' ? message.bytes : new Blob([message.bytes]) });
    } else if (message.t === 'close') {
      this.readyState = 3;
      this._host.sockets.delete(this._id);
      const code = Number.isInteger(message.code) ? message.code : GOING_AWAY;
      this.onclose?.({ code, reason: typeof message.reason === 'string' ? message.reason : '', wasClean: true });
    }
  }
}

/** @type {Promise<Object>|null} */
let connection = null;

/**
 * Connect this page to the widget that embeds it: once per page, whoever
 * asks. Resolves when the widget sent `connect` with the viewer's credentials
 * and a port, with
 *
 *     {config: {serverUrl, viewerId, viewerToken}, WebSocketImpl}
 *
 * `serverUrl` is `EMBEDDED_HOST_ORIGIN`, whose requests this page (and every
 * reader worker it starts) now sends over the port, and `WebSocketImpl` opens
 * sockets on it. A page that no frame embeds is refused at once: it can only
 * be opened by a notebook widget.
 *
 * @param {{scope?: Window}} [options]
 * @returns {Promise<{config: {serverUrl: string, viewerId: string, viewerToken: string},
 *   WebSocketImpl: typeof PortSocket}>}
 */
export function connectEmbeddedHost({ scope = globalThis } = {}) {
  connection ??= new Promise((resolve, reject) => {
    const parent = scope.parent;
    if (parent === undefined || parent === null || parent === scope) {
      reject(new Error(
        'This address opens the Cellucid viewer of a notebook widget (cellucid.Widget, show_anndata(), ' +
        'cellucid_view() in a Jupyter notebook); it shows data only inside the notebook that displays it.'
      ));
      return;
    }
    const onMessage = event => {
      if (event.source !== parent) return;
      const credentials = requireConnect(event.data);
      if (credentials === null || event.ports?.length !== 1) return;
      scope.removeEventListener('message', onMessage);
      const host = new EmbeddedHost(event.ports[0]);
      setHostRequester((request, options) => host.request(request, options));
      resolve({
        config: Object.freeze({ serverUrl: EMBEDDED_HOST_ORIGIN, ...credentials }),
        WebSocketImpl: host.socketClass(),
      });
    };
    scope.addEventListener('message', onMessage);
    // The ready message carries nothing, so it may go to whatever origin the
    // parent is; only the parent's answer, from the parent, is accepted.
    parent.postMessage({ [VIEWER_EMBED_KEY]: 'ready' }, '*');
  });
  return connection;
}

/** Forget the page's connection (tests). */
export function resetEmbeddedHostConnection() {
  connection = null;
  setHostRequester(null);
}
