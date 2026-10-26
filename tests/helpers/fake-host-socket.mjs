/**
 * A fake host for the viewer channel (`data/viewer-channel.js`): it stands in
 * for the WebSocket and answers `hello` with `welcome` exactly as
 * cellucid-python and cellucid-r do (`viewer-protocol.json`), records every
 * frame the viewer sends after it, and can send commands (text and binary
 * frames) and close.
 *
 * Importing this module installs it as `globalThis.WebSocket`.
 */
/**
 * The host end of one viewer channel. `host` holds what the fake host knows:
 * the viewer it registered, and whether its WebSocket can be reached.
 */
export const host = {
  viewerId: 'viewer-1',
  viewerToken: 'secret-1',
  /** When true, a new socket fails before it opens (a proxy without WebSockets). */
  unreachable: false,
};

export class FakeHostSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.binaryType = 'blob';
    /** Frames the viewer sent after its hello, in order. */
    this.frames = [];
    this.hello = null;
    this.closedByViewer = null;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeHostSocket.instances.push(this);
    setImmediate(() => {
      if (host.unreachable) {
        this.readyState = 3;
        this.onerror?.({});
        this.onclose?.({ code: 1006, reason: '' });
        return;
      }
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data) {
    if (this.readyState !== 1) return;
    if (this.hello === null) {
      this.hello = JSON.parse(data);
      const accepted =
        Object.keys(this.hello).length === 3 &&
        this.hello.type === 'hello' &&
        this.hello.viewerId === host.viewerId &&
        this.hello.viewerToken === host.viewerToken;
      setImmediate(() => {
        if (accepted) this.hostSend({ type: 'welcome' });
        else this.hostClose(4401, 'Unknown viewer, or a wrong viewer token');
      });
      return;
    }
    this.frames.push(data);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedByViewer = { code, reason };
  }

  /** The host sends one text frame. */
  hostSend(value) {
    this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) });
  }

  /** The host sends one binary frame; the viewer's socket delivers an ArrayBuffer. */
  hostSendBinary(bytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    this.onmessage?.({ data: copy.buffer });
  }

  /** The host (or the network) closes the socket. */
  hostClose(code, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}
globalThis.WebSocket = FakeHostSocket;

export function lastSocket() {
  return FakeHostSocket.instances.at(-1);
}

/** Decode the viewer's frames: JSON events, and binary events as {header, body}. */
export async function decodeFrames(frames) {
  const decoded = [];
  for (const frame of frames) {
    if (typeof frame === 'string') {
      decoded.push(JSON.parse(frame));
      continue;
    }
    const bytes = new Uint8Array(await frame.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const headerLength = view.getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength)));
    decoded.push({ header, body: bytes.subarray(4 + headerLength) });
  }
  return decoded;
}
