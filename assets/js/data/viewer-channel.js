/**
 * The viewer's end of the viewer channel: one WebSocket to the host program
 * (a notebook's `cellucid` Python package, the `cellucid` R package's viewer)
 * that served this page. `data/viewer-protocol.js` holds the rules.
 *
 * - `open()` connects, says `hello` with the viewer's id and token, and
 *   resolves on the host's `welcome`.
 * - Commands from the host reach `onCommand` in the order they were sent: a
 *   text frame as its JSON object, a binary frame (a command that names
 *   cells) as its header's fields with `cells`, a Uint32Array read in place
 *   (`decodeViewerBinaryCommand`).
 * - Events go out with `sendEvent` (a JSON text frame) and `sendBinary` (a
 *   header and a body, sent as one Blob so the body is never copied here).
 *   While the socket is reconnecting they wait, in order; a newer hover
 *   replaces a waiting one, every other event is kept.
 * - A socket that drops (the network, a proxy restarting) is reopened at once,
 *   and only on that drop. Nothing is polled: the host's pings keep an idle
 *   socket open, and the host closing the socket is how the viewer learns it
 *   stopped. When a reopen fails, one health request tells "the host stopped"
 *   from "the host runs but the WebSocket cannot reach it" (a proxy that does
 *   not pass WebSockets), and the channel ends with the matching reason.
 * - The channel ends for good (`onEnd`, once) when the host stops the viewer
 *   (1001, or 4401 after it was connected), when the same viewer opened a newer
 *   channel elsewhere (4409: this page no longer talks to the host and does
 *   not take the channel back), or when either side broke the protocol.
 *
 * @module data/viewer-channel
 */

import {
  VIEWER_BINARY_COMMAND_HEADER_FIELDS,
  VIEWER_CHANNEL_PATH,
  VIEWER_CLOSE_CODES,
  VIEWER_WELCOME_FIELDS,
  decodeViewerBinaryCommand,
  encodeViewerBinaryFrame,
} from './viewer-protocol.js';
import { isPlainRecord } from '../utils/exact-record.js';

/**
 * Why a channel ended: `stopped` (the host stopped this viewer, or the host
 * itself stopped), `replaced` (this viewer was opened again in another page),
 * `unreachable` (the host answers HTTP but not the WebSocket), `protocol` (a
 * frame broke the rules), `closed` (this page closed it).
 *
 * @typedef {{kind: 'stopped'|'replaced'|'unreachable'|'protocol'|'closed', message: string}} ViewerChannelEnd
 */

/**
 * The WebSocket address of the channel of the server at `serverUrl`: the same
 * host and path prefix as the page's server, so a notebook proxy that carries
 * the server carries the channel.
 *
 * @param {string} serverUrl - Exact http(s) base URL without trailing slash
 * @param {string} [channelPath]
 */
export function viewerChannelUrl(serverUrl, channelPath = VIEWER_CHANNEL_PATH) {
  const url = new URL(`${serverUrl}/${channelPath}`);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  else throw new TypeError('The viewer channel needs an http(s) server address');
  return url.toString();
}

function isWelcome(value) {
  return (
    isPlainRecord(value) &&
    Object.keys(value).length === VIEWER_WELCOME_FIELDS.length &&
    value.type === 'welcome'
  );
}

class ChannelClosedBeforeWelcome extends Error {
  constructor(code, reason, opened) {
    super(`The viewer channel closed before the host answered (code ${code}${reason ? `: ${reason}` : ''})`);
    this.code = code;
    this.reason = reason;
    this.opened = opened;
  }
}

export class ViewerChannel {
  /**
   * @param {{
   *   serverUrl: string,
   *   viewerId: string,
   *   viewerToken: string,
   *   channelPath?: string,
   *   onCommand: (command: Object) => void,
   *   onEnd: (end: ViewerChannelEnd) => void,
   *   isHostAlive: () => Promise<boolean>,
   *   WebSocketImpl?: typeof WebSocket,
   * }} options
   */
  constructor(options) {
    this._url = viewerChannelUrl(options.serverUrl, options.channelPath);
    this._hello = JSON.stringify({
      type: 'hello',
      viewerId: options.viewerId,
      viewerToken: options.viewerToken,
    });
    this._onCommand = options.onCommand;
    this._onEnd = options.onEnd;
    this._isHostAlive = options.isHostAlive;
    this._WebSocket = options.WebSocketImpl ?? globalThis.WebSocket;
    /** @type {WebSocket|null} */
    this._socket = null;
    /** @type {'idle'|'connecting'|'open'|'reconnecting'|'ended'} */
    this.state = 'idle';
    /** @type {Array<string|Blob>} Frames waiting for an open socket, in order. */
    this._queue = [];
    /** Index in `_queue` of the waiting hover, or -1. */
    this._queuedHover = -1;
  }

  get url() {
    return this._url;
  }

  /**
   * Connect and authenticate. Resolves once the host said `welcome`; rejects
   * with an Error that says what to do when it cannot.
   */
  async open() {
    if (this.state !== 'idle') {
      throw new Error('The viewer channel was already opened');
    }
    this.state = 'connecting';
    try {
      this._adopt(await this._connect());
    } catch (error) {
      this.state = 'ended';
      throw await this._explainFailure(error, false);
    }
  }

  /**
   * One WebSocket through its `hello`/`welcome` exchange.
   * @returns {Promise<WebSocket>}
   */
  _connect() {
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new this._WebSocket(this._url);
      } catch (error) {
        reject(error);
        return;
      }
      socket.binaryType = 'arraybuffer';
      let opened = false;
      socket.onopen = () => {
        opened = true;
        socket.send(this._hello);
      };
      socket.onmessage = event => {
        let value = null;
        try {
          value = typeof event.data === 'string' ? JSON.parse(event.data) : null;
        } catch {
          value = null;
        }
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
        if (!isWelcome(value)) {
          socket.close(VIEWER_CLOSE_CODES.protocolViolation, 'Expected welcome');
          reject(new ChannelClosedBeforeWelcome(VIEWER_CLOSE_CODES.protocolViolation, 'the host did not answer hello with welcome', true));
          return;
        }
        resolve(socket);
      };
      // An error event is always followed by a close event, which decides.
      socket.onerror = () => {};
      socket.onclose = event => {
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
        reject(new ChannelClosedBeforeWelcome(event.code, event.reason, opened));
      };
    });
  }

  /** Make `socket` the channel's and send everything that waited. */
  _adopt(socket) {
    this._socket = socket;
    this.state = 'open';
    socket.onmessage = event => this._receive(socket, event);
    socket.onclose = event => {
      if (this._socket !== socket) return;
      this._socket = null;
      void this._closed(event.code, event.reason);
    };
    socket.onerror = () => {};
    const waiting = this._queue;
    this._queue = [];
    this._queuedHover = -1;
    for (const frame of waiting) socket.send(frame);
  }

  _receive(socket, event) {
    if (this._socket !== socket) return;
    let command;
    try {
      if (typeof event.data !== 'string') {
        if (!(event.data instanceof ArrayBuffer)) {
          throw new TypeError('a binary frame must arrive as an ArrayBuffer');
        }
        command = decodeViewerBinaryCommand(event.data);
      } else {
        command = JSON.parse(event.data);
        if (!isPlainRecord(command) || typeof command.type !== 'string') {
          throw new TypeError('a command must be a JSON object with a type');
        }
        if (Object.hasOwn(VIEWER_BINARY_COMMAND_HEADER_FIELDS, command.type)) {
          throw new TypeError(`a ${command.type} command is sent as a binary frame`);
        }
      }
    } catch (error) {
      this._end('protocol', `The notebook or R session sent something this viewer cannot read (${error.message}); reload the page.`, VIEWER_CLOSE_CODES.protocolViolation);
      return;
    }
    this._onCommand(command);
  }

  async _closed(code, reason) {
    if (this.state === 'ended') return;
    if (code === VIEWER_CLOSE_CODES.replaced) {
      this._end('replaced', 'This viewer was opened again in another page; that page now talks to the notebook or R session, and this one no longer does.');
      return;
    }
    if (code === VIEWER_CLOSE_CODES.goingAway || code === VIEWER_CLOSE_CODES.unauthorized) {
      this._end('stopped', 'The notebook or R session stopped this viewer. The last complete view stays as it is.');
      return;
    }
    if (code === VIEWER_CLOSE_CODES.protocolViolation) {
      this._end('protocol', `The notebook or R session closed this viewer's channel: ${reason || 'a frame broke the protocol'}.`);
      return;
    }
    // A drop: reopen once, at once.
    this.state = 'reconnecting';
    try {
      const socket = await this._connect();
      if (this.state !== 'reconnecting') {
        socket.close(VIEWER_CLOSE_CODES.normal, 'Viewer channel closed');
        return;
      }
      this._adopt(socket);
    } catch (error) {
      if (this.state !== 'reconnecting') return;
      const explained = await this._explainFailure(error, true);
      this._end(explained.kind, explained.message);
    }
  }

  /**
   * Turn a failed connect into what the person can do about it.
   * @returns {Promise<Error & {kind: string}>}
   */
  async _explainFailure(error, reconnecting) {
    let kind;
    let message;
    if (error instanceof ChannelClosedBeforeWelcome && error.code === VIEWER_CLOSE_CODES.unauthorized) {
      kind = 'stopped';
      message = reconnecting
        ? 'The notebook or R session stopped this viewer. The last complete view stays as it is.'
        : 'The notebook or R session no longer knows this viewer (it was stopped). Run the cell that shows it again.';
    } else if (error instanceof ChannelClosedBeforeWelcome && error.opened) {
      kind = 'protocol';
      message = `The notebook or R session closed this viewer's channel: ${error.reason || `code ${error.code}`}.`;
    } else {
      let alive = false;
      try {
        alive = await this._isHostAlive();
      } catch {
        alive = false;
      }
      if (alive) {
        kind = 'unreachable';
        message =
          `The notebook or R session is running, but this viewer cannot open its channel (${this._url}). ` +
          'A proxy between this page and the host must pass WebSockets ' +
          '(jupyter-server-proxy does; check its configuration and any reverse proxy in front of it).';
      } else {
        kind = 'stopped';
        message = 'The notebook or R session that opened this viewer stopped (its server no longer answers). ' +
          'The last complete view stays as it is.';
      }
    }
    const explained = new Error(message, { cause: error });
    explained.kind = kind;
    return explained;
  }

  _end(kind, message, closeCode = VIEWER_CLOSE_CODES.normal) {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this._queue = [];
    this._queuedHover = -1;
    const socket = this._socket;
    this._socket = null;
    if (socket !== null) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close(closeCode, kind === 'closed' ? 'Viewer closed' : '');
      } catch {
        // Already closing.
      }
    }
    try {
      this._onEnd({ kind, message });
    } catch (error) {
      console.error('[ViewerChannel] end handler failed:', error);
    }
  }

  /** Close the channel from this page. */
  close() {
    this._end('closed', 'The viewer closed its channel.');
  }

  _send(frame, isHover) {
    if (this.state === 'ended') {
      throw new Error('The viewer channel has ended');
    }
    if (this.state === 'open' && this._socket !== null) {
      this._socket.send(frame);
      return;
    }
    if (isHover && this._queuedHover >= 0) {
      this._queue[this._queuedHover] = frame;
      return;
    }
    if (isHover) this._queuedHover = this._queue.length;
    this._queue.push(frame);
  }

  /** Send one event as a JSON text frame. */
  sendEvent(event) {
    this._send(JSON.stringify(event), event.type === 'hover');
  }

  /**
   * Send one binary event: the header and the body as one Blob, so the body
   * (a selection's cells, a session file) is handed to the socket as it is.
   *
   * @param {Object} header
   * @param {Uint8Array|Blob} body
   */
  sendBinary(header, body) {
    const prefix = encodeViewerBinaryFrame(header, new Uint8Array(0));
    this._send(new Blob([prefix, body]), false);
  }
}
