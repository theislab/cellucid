/**
 * The byte paths a measured reader reads through, each recording every read
 * it served (`{file, start, end, bytes, t0, t1}`) so the floor can tell
 * which bytes were needed.
 *
 * - `installRemoteLink`: `fetch` over a throttled link, as a browser reaches
 *   a web host: a fixed round-trip latency, one shared bandwidth, six
 *   requests at once over HTTP/1.1 (a browser's connections to one host) or
 *   the host's concurrent streams over HTTP/2 (GitHub and S3 behind a CDN:
 *   100). A `HEAD` costs a round trip. Requests to `https://floor.local/`
 *   are answered from files under `root`; any other URL (a Python or R
 *   server on loopback) is fetched for real and then held to the link's
 *   latency and bandwidth, so a served store is measured over the same link
 *   as a file.
 * - `installLocalRecorder`: a `File` (`Blob`) read in slices, as the app
 *   reads a picked file or folder: every `arrayBuffer()` of a slice is one
 *   read of the slice's bytes at its offset in the picked file.
 *
 * @module scripts/efficiency-floor/link
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

export const FLOOR_HOST = 'https://floor.local/';

/** Every read served, in order, and running totals. */
export class Recorder {
  constructor() {
    this.reads = [];
    this.requests = 0;
    this.bytes = 0;
  }
  record(read) {
    this.reads.push(read);
    this.requests++;
    this.bytes += read.bytes;
  }
  mark() {
    return this.reads.length;
  }
  since(mark) {
    return this.reads.slice(mark);
  }
}

export function installRemoteLink({ root, latencyMs, bandwidthMBps, protocol = 'http/1.1', streams = 100, recorder }) {
  if (protocol !== 'http/1.1' && protocol !== 'h2') throw new Error('protocol is http/1.1 or h2');
  const bytesPerMs = bandwidthMBps * 1e6 / 1000;
  const connections = protocol === 'http/1.1' ? 6 : streams;
  const realFetch = globalThis.fetch;
  let onWire = 0;
  const waiting = [];
  const connection = async () => {
    if (onWire < connections) {
      onWire++;
      return;
    }
    await new Promise(resolve => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else onWire--;
  };
  let linkFreeAt = 0;
  // The response's last byte arrives after the round trip and after every
  // byte sent before it has passed the shared link.
  const arrival = (asked, bytes) => {
    const start = Math.max(asked + latencyMs, linkFreeAt);
    linkFreeAt = start + bytes / bytesPerMs;
    return linkFreeAt;
  };
  const sleepUntil = at => new Promise(resolve => setTimeout(resolve, Math.max(0, at - performance.now())));
  const fds = new Map();
  const fdOf = target => {
    if (!fds.has(target)) fds.set(target, openSync(target, 'r'));
    return fds.get(target);
  };

  async function answerLocal(url, init, asked) {
    const relative = decodeURIComponent(new URL(url).pathname.slice(1));
    const target = path.join(root, relative);
    let size;
    try {
      size = statSync(target).size;
    } catch {
      await sleepUntil(asked + latencyMs);
      recorder.record({ file: relative, start: 0, end: 0, bytes: 0, t0: asked, t1: performance.now(), status: 404 });
      return new Response('', { status: 404 });
    }
    if ((init.method ?? 'GET') === 'HEAD') {
      await sleepUntil(asked + latencyMs);
      recorder.record({ file: relative, start: 0, end: 0, bytes: 0, t0: asked, t1: performance.now(), head: true });
      return new Response(null, { status: 200, headers: { 'Content-Length': String(size), ETag: `"${size}"` } });
    }
    const range = headerOf(init.headers, 'Range');
    let start = 0;
    let end = size;
    let ranged = false;
    if (range !== null) {
      const plain = /^bytes=(\d+)-(\d*)$/.exec(range);
      const suffix = /^bytes=-(\d+)$/.exec(range);
      if (plain !== null) {
        start = Number(plain[1]);
        end = plain[2] === '' ? size : Math.min(size, Number(plain[2]) + 1);
        ranged = true;
      } else if (suffix !== null) {
        start = Math.max(0, size - Number(suffix[1]));
        ranged = true;
      }
    }
    const bytes = new Uint8Array(Math.max(0, end - start));
    if (bytes.length > 0) readSync(fdOf(target), bytes, 0, bytes.length, start);
    await sleepUntil(arrival(asked, bytes.length));
    recorder.record({ file: relative, start, end, bytes: bytes.length, t0: asked, t1: performance.now() });
    const headers = { 'Content-Length': String(bytes.length), ETag: `"${size}"`, 'Accept-Ranges': 'bytes' };
    if (ranged) headers['Content-Range'] = `bytes ${start}-${end - 1}/${size}`;
    return new Response(bytes, { status: ranged ? 206 : 200, headers });
  }

  async function answerProxied(url, init, asked) {
    const response = await realFetch(url, { ...init, signal: undefined });
    const body = new Uint8Array(await response.arrayBuffer());
    await sleepUntil(arrival(asked, body.length));
    const range = /bytes (\d+)-(\d+)/.exec(response.headers.get('Content-Range') ?? '');
    const start = range === null ? 0 : Number(range[1]);
    recorder.record({ file: new URL(url).pathname.slice(1), start, end: start + body.length, bytes: body.length, t0: asked, t1: performance.now() });
    return new Response((init.method ?? 'GET') === 'HEAD' ? null : body, { status: response.status, headers: response.headers });
  }

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    await connection();
    if (init.signal?.aborted) {
      release();
      throw init.signal.reason ?? new DOMException('The request was aborted.', 'AbortError');
    }
    const asked = performance.now();
    try {
      return url.startsWith(FLOOR_HOST) ? await answerLocal(url, init, asked) : await answerProxied(url, init, asked);
    } finally {
      release();
    }
  };
  return {
    concurrency: connections,
    close() {
      for (const fd of fds.values()) closeSync(fd);
      globalThis.fetch = realFetch;
    },
  };
}

function headerOf(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name.toLowerCase()) return value;
  return null;
}

/**
 * Record every read of a picked file's slices: a slice remembers which file
 * it is of and where it starts, so a read of a slice of a slice is placed at
 * its offset in the file.
 */
export function installLocalRecorder(recorder) {
  const slice = Blob.prototype.slice;
  const arrayBuffer = Blob.prototype.arrayBuffer;
  const origin = new WeakMap();
  Blob.prototype.slice = function recordedSlice(start = 0, end = this.size, type) {
    const part = slice.call(this, start, end, type);
    const parent = origin.get(this) ?? { file: this.name ?? '', offset: 0 };
    const from = start < 0 ? Math.max(0, this.size + start) : Math.min(start, this.size);
    origin.set(part, { file: parent.file, offset: parent.offset + from });
    return part;
  };
  Blob.prototype.arrayBuffer = async function recordedArrayBuffer() {
    const t0 = performance.now();
    const buffer = await arrayBuffer.call(this);
    const where = origin.get(this) ?? { file: this.name ?? '', offset: 0 };
    recorder.record({ file: where.file, start: where.offset, end: where.offset + this.size, bytes: this.size, t0, t1: performance.now() });
    return buffer;
  };
  return {
    concurrency: Infinity,
    /** Name a picked file by its path in the dataset (a Zarr folder's key). */
    tag(file, name) {
      origin.set(file, { file: name, offset: 0 });
      return file;
    },
    close() {
      Blob.prototype.slice = slice;
      Blob.prototype.arrayBuffer = arrayBuffer;
    },
  };
}
