/**
 * One request to the community-annotation Worker, sent through the app's one
 * transport (`formats/io/byte-source.js` `fetchOnce` / `withRetries`), as
 * every other request to a web host is:
 *
 * - **Never a total deadline.** A request is aborted only when neither it,
 *   nor any other request to the Worker, received anything for the link's
 *   stall timeout (`formats/io/link.js` `ResponseClock`: RFC 6298 from the
 *   Worker's measured answers, three seconds before the first). A 1 MB user
 *   file on a slow uplink, or a large tree streaming for half a minute, is
 *   delivering, not stalled.
 * - **Its request budget.** The Worker relays GitHub's `X-RateLimit-*` and
 *   `Retry-After` headers; `formats/io/hosts.js` (`realmHosts`) paces every
 *   request to the Worker by them, shared by every realm of this site, and
 *   a wait GitHub names is waited for exactly. An `X-RateLimit-Reset` on a
 *   failure that is not a rate limit (a `503` with budget left) names no
 *   wait: the request is asked again as any busy one is.
 * - **Retries per request** for transient failures (a busy or failing answer,
 *   a stall, a connection dropped mid-body), with the waits `withRetries`
 *   grows from the link's retransmission timeout. A mutation is asked again
 *   only when the Worker states it did not apply it (`X-Cellucid-Operation-
 *   Outcome: not-applied`) and the answer is transient: a mutation whose
 *   outcome is unknown is never repeated blindly (its caller reconciles).
 *
 * What a request that did not succeed is, as a caller acts on it (`code`):
 *
 * - `GITHUB_WORKER_UNREACHABLE`: no answer this page may read. `answeredBefore`
 *   tells a Worker that answered this site before and now sends nothing
 *   readable (failing, refusing this network for now, or this computer lost
 *   its connection) from one never reached (down, or not allowing this site:
 *   CORS, its `ALLOWED_ORIGINS`).
 * - `COMMUNITY_ANNOTATION_RESPONSE_CUT`: the answer began (its headers came)
 *   and its body failed before it was complete. Transient: asking again may
 *   succeed.
 *
 * @module app/community-annotations/worker-request
 */

import {
  BYTE_SOURCE_FAILURES,
  ByteSourceError,
  fetchOnce,
  isTransientAnswer,
  isTransientFailure,
  spreadOf,
  transientStatusError,
  withRetries,
} from '../../formats/io/byte-source.js';
import { ResponseClock } from '../../formats/io/link.js';
import { realmHosts } from '../../formats/io/hosts.js';
import { OPERATION_OUTCOME_HEADER } from './worker-contract.js';
import { formatDuration } from '../../utils/format-units.js';

export const WORKER_UNREACHABLE = 'GITHUB_WORKER_UNREACHABLE';
export const WORKER_RESPONSE_CUT = 'COMMUNITY_ANNOTATION_RESPONSE_CUT';


/** The link to each Worker origin, measured across every request and every Pull of this page. */
const linksByOrigin = new Map();

/**
 * The transport requests to `origin` go through by default: the page's
 * `fetch`, the realm's book of hosts and one measured link per origin.
 *
 * @param {string} origin
 * @returns {{fetch: typeof fetch, hosts: ReturnType<import('../../formats/io/hosts.js').createHostBook>, clock: ResponseClock}}
 */
export function defaultWorkerTransport(origin) {
  let clock = linksByOrigin.get(origin);
  if (clock === undefined) {
    clock = new ResponseClock();
    linksByOrigin.set(origin, clock);
  }
  return Object.freeze({
    // Read at call time: a page (or a test) that replaces `fetch` is used.
    fetch: (url, init) => globalThis.fetch(url, init),
    hosts: realmHosts,
    clock,
  });
}

/**
 * Check a transport given by a caller (tests give a virtual clock and their
 * own book of hosts).
 */
export function assertWorkerTransport(transport) {
  if (
    transport === null ||
    typeof transport !== 'object' ||
    typeof transport.fetch !== 'function' ||
    typeof transport.hosts?.admit !== 'function' ||
    !(transport.clock instanceof ResponseClock)
  ) {
    throw new TypeError(
      'A Worker transport has fetch, hosts (a book of hosts) and clock (a ResponseClock)'
    );
  }
  return transport;
}

function utf8Text(bytes, label) {
  if (bytes === null || bytes.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause) {
    const error = new Error(`${label} answered a body that is not UTF-8 text`);
    error.cause = cause;
    throw error;
  }
}

/**
 * The failure a request that got no usable answer is, in the words a person
 * acts on (module doc). Anything else is returned as it is.
 */
function workerFailure(error, { origin, label, hosts, url }) {
  if (!(error instanceof ByteSourceError)) return error;
  const { code, details = {} } = error;
  if (
    (code === BYTE_SOURCE_FAILURES.NETWORK || code === BYTE_SOURCE_FAILURES.STALLED) &&
    details.phase === 'body'
  ) {
    const cut = new Error(
      `The community-annotation service at ${origin} began answering ${label}, ` +
      'but the answer stopped before it was complete' +
      (code === BYTE_SOURCE_FAILURES.STALLED
        ? ` (no more bytes for ${formatDuration(details.silentMs ?? 0)})`
        : ' (the connection dropped)') +
      '. Nothing was lost; try again.'
    );
    cut.code = WORKER_RESPONSE_CUT;
    cut.transient = true;
    cut.cause = error;
    return cut;
  }
  if (code === BYTE_SOURCE_FAILURES.NETWORK || code === BYTE_SOURCE_FAILURES.STALLED) {
    const answeredBefore = hosts.answeredBefore(url) === true;
    const silence = code === BYTE_SOURCE_FAILURES.STALLED
      ? `no answer for ${formatDuration(details.silentMs ?? 0)}`
      : 'no answer this page may read';
    const site = typeof location === 'object' && location?.origin ? location.origin : 'this site';
    const unreachable = new Error(
      answeredBefore
        ? `The community-annotation service at ${origin} answered this site before and now gives ` +
          `${silence} (${label}): it may be failing or refusing this network for now, or this ` +
          'computer lost its connection. Try again later.'
        : `Cellucid could not reach the community-annotation service at ${origin} (${label}: ` +
          `${silence}). It may be down, or it does not allow ${site} (its ALLOWED_ORIGINS); ` +
          'check the connection and the service, then try again.'
    );
    unreachable.code = WORKER_UNREACHABLE;
    unreachable.answeredBefore = answeredBefore;
    unreachable.transient = true;
    unreachable.cause = error;
    return unreachable;
  }
  return error;
}

/**
 * Send one request to the Worker (module doc) and answer it whole:
 * `{response, text}` with the body's text ('' for none). A transient answer
 * still failing once its repeats are spent is answered as it is (its caller
 * reports its status); a request with no usable answer throws
 * (`GITHUB_WORKER_UNREACHABLE`, `COMMUNITY_ANNOTATION_RESPONSE_CUT`).
 *
 * @param {{fetch: typeof fetch, hosts: object, clock: ResponseClock}} transport
 * @param {string} url
 * @param {RequestInit} init
 * @param {{signal?: AbortSignal|null, label: string, origin: string, mutation?: boolean,
 *   onWait?: ((wait: {host: string|null, untilMs: number|null, text: string}|null) => void)|null,
 *   answersAsIs?: ((response: Response) => boolean)|null,
 *   onDispatch?: (() => void)|null}} options
 *   `mutation`: repeated only on a transient answer the Worker states it did
 *   not apply; `answersAsIs(response)`: a status the caller acts on itself
 *   instead of asking again (the blob batches halve on a `502`/`504`);
 *   `onDispatch`: told when a request reaches `fetch` (a mutation sent)
 * @returns {Promise<{response: Response, text: string}>}
 */
export async function requestWorker(transport, url, init, {
  signal = null,
  label,
  origin,
  mutation = false,
  onWait = null,
  answersAsIs = null,
  onDispatch = null,
}) {
  const { hosts, clock } = transport;
  const fetchImpl = (target, options) => {
    onDispatch?.();
    return transport.fetch(target, options);
  };
  // The last transient answer: answered as it is once asking again is over.
  let lastTransient = null;
  try {
    return await withRetries(async () => {
      lastTransient = null;
      // A transient answer's body is not gathered (`fetchOnce` reads what it
      // says, when it says it in JSON or text), so the book of hosts learns
      // a limit, its `Retry-After` and its budget's reset from it.
      const { response, bytes, said } = await fetchOnce(url, init, {
        fetchImpl,
        signal,
        clock,
        hosts,
        label,
        onWait,
        wantsBody: (answer) => answersAsIs?.(answer) === true || !isTransientAnswer(answer),
      });
      if (bytes !== null) return { response, text: utf8Text(bytes, label) };
      const text = said ?? '';
      const notApplied = response.headers.get(OPERATION_OUTCOME_HEADER) === 'not-applied';
      if (mutation && !notApplied) return { response, text };
      lastTransient = { response, text };
      throw transientStatusError(response, label, said);
    }, {
      signal,
      clock,
      onWait,
      random: spreadOf(`${init?.method ?? 'GET'} ${url}`),
      // A mutation is repeated only on an answer stating it was not applied
      // (thrown above as a transient status); a request it sent and lost may
      // have been applied, and its caller reconciles.
      retryable: (error) => isTransientFailure(error) && (
        !mutation ||
        error.code === BYTE_SOURCE_FAILURES.RATE_LIMITED ||
        error.code === BYTE_SOURCE_FAILURES.UNAVAILABLE ||
        error.details?.sent === false
      ),
    });
  } catch (error) {
    if (
      lastTransient !== null &&
      error instanceof ByteSourceError &&
      (error.code === BYTE_SOURCE_FAILURES.RATE_LIMITED || error.code === BYTE_SOURCE_FAILURES.UNAVAILABLE)
    ) {
      return lastTransient;
    }
    throw workerFailure(error, { origin, label, hosts, url });
  }
}

/**
 * How long the Worker asked to be left alone after `response` (a
 * `Retry-After`, or the reset of a request budget it says is spent), in
 * milliseconds, or null: what a person is told to wait.
 */
export function namedWaitMsOf(transport, url, response) {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const held = transport.hosts.heldForMs?.(url) ?? 0;
  return held > 0 ? held : null;
}
