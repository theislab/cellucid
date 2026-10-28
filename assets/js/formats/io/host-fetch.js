/**
 * Reads from a host program the page cannot reach over the network: the
 * notebook kernel behind a notebook widget (`cellucid.Widget` in Python),
 * which the page reaches only by messages to the frame that embeds it
 * (`data/viewer-embed.js`).
 *
 * Such a host is named by one reserved origin, `EMBEDDED_HOST_ORIGIN`, under
 * the `.invalid` top-level domain (RFC 6761: never resolved), so a request
 * that is not routed here fails instead of going anywhere. `routedFetch` is
 * `fetch` for every other URL; a URL of that origin is asked of the host the
 * page connected to (`setHostRequester`), and its answer comes back as a
 * `Response`. Every reader -- `httpByteSource`, `httpStore`, the viewer
 * host's documents -- therefore reads the host exactly as it reads a web
 * server, `Range` requests, `206` and `Content-Range` included.
 *
 * A worker has no frame to message: the page hands each worker that reads
 * the host a `MessagePort` (`hostRequesterPort`), answered by the page's own
 * requester, and the worker adopts it (`adoptHostRequesterPort`).
 *
 * A host request is `{method, path, range}`: `GET` or `HEAD`, the path
 * relative to the host's base address (`_cellucid/datasets`), and the
 * `Range` header or null. Its answer is `{status, headers, bytes}`, `bytes`
 * an ArrayBuffer (null for a `HEAD`).
 *
 * @module formats/io/host-fetch
 */

import { onAbort } from './abort.js';

/** The origin every URL of an embedded viewer's host is spelled with. */
export const EMBEDDED_HOST_ORIGIN = 'https://host.cellucid.invalid';

/**
 * @typedef {{method: 'GET'|'HEAD', path: string, range: string|null}} HostRequest
 * @typedef {{status: number, headers: Object<string, string>, bytes: ArrayBuffer|null}} HostAnswer
 * @typedef {(request: HostRequest, options: {signal: AbortSignal|null}) => Promise<HostAnswer>} HostRequester
 */

/** @type {HostRequester|null} */
let requester = null;

/**
 * Route this realm's requests to `EMBEDDED_HOST_ORIGIN` to `next` (null: to
 * nothing, so they fail as a network failure does).
 *
 * @param {HostRequester|null} next
 */
export function setHostRequester(next) {
  if (next !== null && typeof next !== 'function') {
    throw new TypeError('A host requester is a function or null.');
  }
  requester = next;
}

/** Whether this realm reaches an embedded host. */
export function hasHostRequester() {
  return requester !== null;
}

/** Whether `url` names the embedded host. */
export function isHostUrl(url) {
  return typeof url === 'string' && url.startsWith(`${EMBEDDED_HOST_ORIGIN}/`);
}

function abortError(signal) {
  return signal?.reason ?? new DOMException('The request was aborted.', 'AbortError');
}

/**
 * `fetch`, except that a URL of `EMBEDDED_HOST_ORIGIN` is asked of the
 * embedded host. A failure to reach the host rejects with a `TypeError`,
 * as `fetch` does for a network failure.
 *
 * @param {RequestInfo|URL} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function routedFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  if (!isHostUrl(url)) return globalThis.fetch(input, init);
  const signal = init.signal ?? null;
  if (signal?.aborted) throw abortError(signal);
  const own = requester;
  if (own === null) {
    throw new TypeError(`${url}: this page is connected to no notebook.`);
  }
  const method = String(init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    throw new TypeError(`${url}: a notebook host answers GET and HEAD only.`);
  }
  const parsed = new URL(url);
  const path = `${parsed.pathname.slice(1)}${parsed.search}`;
  const range = new Headers(init.headers ?? {}).get('Range');
  let answer;
  try {
    answer = await own({ method, path, range }, { signal });
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    throw new TypeError(`${url}: the notebook did not answer (${error?.message ?? error}).`, { cause: error });
  }
  if (signal?.aborted) throw abortError(signal);
  const empty = method === 'HEAD' || answer.status === 204 || answer.status === 304;
  return new Response(empty ? null : answer.bytes, { status: answer.status, headers: answer.headers });
}

/**
 * A port a worker reads the embedded host through (`adoptHostRequesterPort`),
 * answered by this realm's requester; null when this realm reaches no host.
 *
 * @returns {MessagePort|null}
 */
export function hostRequesterPort() {
  if (requester === null) return null;
  const own = requester;
  const channel = new MessageChannel();
  /** The worker's requests under way, by id: a `cancel` aborts one. */
  const running = new Map();
  channel.port1.onmessage = async event => {
    const { id, request, cancel } = event.data ?? {};
    if (cancel !== undefined) {
      running.get(cancel)?.abort(new DOMException('The reader no longer waits for this request.', 'AbortError'));
      return;
    }
    const controller = new AbortController();
    running.set(id, controller);
    try {
      const answer = await own(request, { signal: controller.signal });
      channel.port1.postMessage({ id, answer }, answer.bytes === null ? [] : [answer.bytes]);
    } catch (error) {
      if (!controller.signal.aborted) channel.port1.postMessage({ id, error: String(error?.message ?? error) });
    } finally {
      running.delete(id);
    }
  };
  return channel.port2;
}

/**
 * Read the embedded host through `port` (a worker's end of
 * `hostRequesterPort`).
 *
 * @param {MessagePort} port
 */
export function adoptHostRequesterPort(port) {
  if (typeof MessagePort === 'undefined' || !(port instanceof MessagePort)) {
    throw new TypeError('A host requester port is a MessagePort.');
  }
  /** @type {Map<number, {resolve: Function, reject: Function}>} */
  const waiting = new Map();
  let nextId = 0;
  port.onmessage = event => {
    const { id, answer, error } = event.data ?? {};
    const entry = waiting.get(id);
    if (entry === undefined) return;
    waiting.delete(id);
    if (error === undefined) entry.resolve(answer);
    else entry.reject(new Error(error));
  };
  setHostRequester((request, { signal }) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const id = nextId++;
    // An abandoned request is withdrawn all the way to the notebook's widget,
    // which drops it unless it has gone to the kernel; an answer that comes
    // all the same is dropped.
    const stop = onAbort(signal, () => {
      waiting.delete(id);
      port.postMessage({ cancel: id });
      reject(abortError(signal));
    });
    waiting.set(id, {
      resolve: value => {
        stop();
        resolve(value);
      },
      reject: error => {
        stop();
        reject(error);
      },
    });
    port.postMessage({ id, request });
  }));
}
