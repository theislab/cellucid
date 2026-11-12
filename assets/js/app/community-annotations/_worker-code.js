/**
 * Cloudflare Worker for Cellucid community annotations: GitHub sign-in
 * (OAuth with PKCE), a fixed set of GitHub repository operations, two fixed
 * GitHub GraphQL reads, and one fixed Cell Annotation Platform (CAP) lookup.
 *
 * This is the deployable source of the self-hosting guide
 * (`docs/github-oauth-cloudflare-setup.md`, Wrangler configuration
 * `wrangler.community-annotations.jsonc`). It exposes only the routes the
 * current Cellucid page uses; what the page and the Worker agree on (version,
 * route inventory, headers, the callback fragment) lives in
 * `worker-contract.js`, which both import.
 *
 * Built for the Workers Free plan (https://developers.cloudflare.com/workers/platform/limits/):
 * - 10 ms of CPU per request: no JavaScript loop walks a body character by
 *   character. JSON is parsed natively, base64 is checked by one regular
 *   expression, and large reads (file contents, blobs, trees, GraphQL
 *   answers) are relayed as bytes without being parsed.
 * - 50 subrequests per request: a request makes at most two (a mutation that
 *   must know who is calling looks the caller up first), and a collection is
 *   one GitHub page per request.
 * - No wall-clock deadline: a request is stopped only when nothing has moved
 *   for a whole stall window (`WORKER_STALL_TIMEOUT_MS`), or when the browser
 *   that sent it goes away (`enable_request_signal`), which stops the
 *   GitHub request too.
 */

import { ANNOTATION_FILE_MAX_UTF8_BYTES } from './wire-contract.js';
import {
  isCanonicalGitHubAccount,
  isCanonicalGitHubBranch,
  isCanonicalGitHubRepositoryFullName,
  isCanonicalGitHubRepositoryName,
} from './github-reference.js';
import {
  AUTH_ERROR_PARAM,
  AUTH_FLAG_PARAM,
  AUTH_TOKEN_EXPIRES_PARAM,
  AUTH_TOKEN_PARAM,
  OPERATION_ID_HEADER,
  OPERATION_OUTCOME_HEADER,
  WORKER_CONTRACT_VERSION,
  WORKER_ENDPOINTS,
  WORKER_EXPOSED_RESPONSE_HEADERS,
  WORKER_SERVICE,
  scrubAuthFragment,
} from './worker-contract.js';
import { requireExactObjectKeys, requireObjectKeys } from '../../utils/exact-record.js';
import { formatCountOf } from '../../utils/format-units.js';
import { onAbort } from '../../utils/abort.js';
import { parseOriginAllowlist } from '../../utils/origin-allowlist.js';
import { bytesOfBase64, randomHex } from '../../utils/byte-text.js';
import { codeChallengeOf } from '../../data/sources/auth/pkce.js';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';
const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const CAP_GRAPHQL_URL = 'https://celltype.info/graphql';
const GITHUB_API_VERSION = '2026-03-10';
const GITHUB_USER_AGENT = 'Cellucid-GitHub-App';

/** GitHub's largest page (`per_page` at most 100: https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api). */
const GITHUB_PAGE_SIZE = 100;

/**
 * GitHub ends a REST or GraphQL request it has worked on for 10 seconds with
 * a timeout answer of its own
 * (https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#timeouts,
 * https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api#timeouts),
 * and setting up a connection may take 3 seconds (RFC 6298 5.7, RFC 1122
 * 4.2.3.1).
 */
const GITHUB_PROCESSING_TIMEOUT_MS = 10_000;
const CONNECTION_SETUP_MS = 3_000;

/**
 * How long a request may wait with nothing moving (no request-body bytes from
 * the browser, no answer and no body bytes from the upstream) before it is
 * stopped with 504: an upstream silent past GitHub's own timeout plus a
 * connection set-up will not answer, and a browser whose upload is silent as
 * long is gone. Only silence counts: a slow upload or download that keeps
 * moving is never stopped, and time spent waiting for the browser to read
 * what the Worker already relayed is not waiting on anything (the browser
 * has its own stall timeout, and leaving cancels the request). A timing
 * choice, never a size: it bounds no data.
 */
const WORKER_STALL_TIMEOUT_MS = GITHUB_PROCESSING_TIMEOUT_MS + CONNECTION_SETUP_MS;

/**
 * A request body is read into the isolate's memory (128 MB, shared by the
 * requests it serves: https://developers.cloudflare.com/workers/platform/limits/#memory)
 * before it is checked. The largest body Cellucid sends is one annotation
 * file of ANNOTATION_FILE_MAX_UTF8_BYTES in base64 (1,333,336 bytes) in its
 * small JSON envelope (a commit message, a branch, a blob id); this bound
 * holds that with room to spare, and a `/graphql/blobs` body of this size
 * names about 30,000 objects, more than one batch ever asks for.
 */
const WORKER_REQUEST_BODY_MAX_BYTES = 1_400_000;

/**
 * Chromium keeps a CORS preflight answer for at most 2 hours, Firefox for 24
 * (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Max-Age):
 * the longest every engine honors.
 */
const PREFLIGHT_MAX_AGE_SECONDS = 7200;

const CAP_REQUEST_BODY_MAX_BYTES = 4 * 1024;
const CAP_RESPONSE_BODY_MAX_BYTES = 8 * 1024 * 1024;
const CAP_OUTPUT_BODY_MAX_BYTES = 8 * 1024 * 1024;
const CAP_LOOKUP_LIMIT_MAX = 25;
const CAP_TERM_MAX_CODE_POINTS = 256;
const CAP_MARKER_TERM_MAX_CODE_POINTS = (50 * 64) + 49;
const CAP_LOOKUP_APQ_HASH =
  '7669f4698d1243244b365018dc60a69b61969791659814e0b4ad1b65385ddaab';
const CAP_LOOKUP_KINDS = new Set(['name', 'ontology', 'marker']);
const CAP_ONTOLOGY_LOOKUP_FIELDS = Object.freeze(['ontologyTermId']);
const CAP_MARKER_LOOKUP_FIELDS = Object.freeze([
  'markerGenes',
  'canonicalMarkerGenes',
]);

const OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GITHUB_SHA = /^[0-9a-f]{40}$/;
const GITHUB_USER_FILE = /^annotations\/users\/ghid_([1-9][0-9]*)\.json$/;
const GITHUB_READ_ONLY_SCHEMA_FILES = new Set([
  'annotations/schema.json',
  'annotations/config.schema.json',
  'annotations/moderation/merges.schema.json',
]);
const GITHUB_MUTABLE_DOCUMENTS = new Set([
  'annotations/config.json',
  'annotations/moderation/merges.json',
]);
/** Branches Cellucid writes for a contributor live under this root, one folder per GitHub user id. */
const ANNOTATION_BRANCH_ROOT = 'cellucid-annotations/';
const GITHUB_MUTATION_KINDS = new Set([
  'contents-put',
  'git-refs-post',
  'git-ref-patch',
  'pulls-post',
]);

/**
 * Canonical base64 (RFC 4648 4): `atob` checks the alphabet and the padding
 * natively, but forgives whitespace and nonzero pad bits, which these two
 * refuse, so one byte string has one spelling. (A regular expression over
 * the whole text cost 2.8 ms of CPU for a 1 MB file; this costs 0.2 ms.)
 */
const ASCII_WHITESPACE = /[\t\n\f\r ]/;
const CANONICAL_BASE64_LAST_QUANTUM =
  /^(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=|[A-Za-z0-9+/][AQgw]==)$/;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
/** RFC 9110 13.1.2: `*`, or a list of entity tags. */
const IF_NONE_MATCH =
  /^(?:\*|(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"(?:[ \t]*,[ \t]*(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*")*)$/;

/**
 * The GitHub response headers relayed to the page (each in its grammar; any
 * other value is dropped), all of them exposed to it: the conditional-request
 * tag, the waits GitHub asks for, the request budget and GitHub's request id.
 */
const RELAYED_GITHUB_HEADERS = Object.freeze([
  ['ETag', /^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/],
  [
    'Retry-After',
    /^(?:0|[1-9][0-9]*|[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT)$/,
  ],
  ['X-RateLimit-Limit', DECIMAL],
  ['X-RateLimit-Remaining', DECIMAL],
  ['X-RateLimit-Reset', DECIMAL],
  ['X-RateLimit-Used', DECIMAL],
  ['X-RateLimit-Resource', /^[a-z][a-z_]*$/],
  ['X-GitHub-Request-Id', /^[A-Za-z0-9:-]+$/],
]);

const OAUTH_OWNER_COOKIE_PREFIX = 'cellucid_gh_oauth_owner_';
const OAUTH_COOKIE_PATH = '/auth/callback';
const OAUTH_COOKIE_MAX_AGE_S = 10 * 60;
/** Browsers keep a cookie of at least 4,096 bytes, name, value and attributes together (RFC 6265 6.1). */
const OAUTH_COOKIE_MAX_SERIALIZED_BYTES = 4096;
const OAUTH_RANDOM_HEX_256 = /^[0-9a-f]{64}$/;
/** GitHub's install-time redirect (no `state`) names one of these. */
const GITHUB_SETUP_ACTIONS = new Set(['install', 'update', 'request']);

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS']);
const ALLOWED_REQUEST_HEADERS = new Set([
  'authorization',
  'content-type',
  'if-none-match',
  OPERATION_ID_HEADER.toLowerCase(),
]);
const CAP_ALLOWED_METHODS = new Set(['POST']);
const CAP_ALLOWED_REQUEST_HEADERS = new Set(['content-type']);
const CAP_FORBIDDEN_REQUEST_HEADERS = Object.freeze([
  'Authorization',
  'Cookie',
  'Proxy-Authorization',
  OPERATION_ID_HEADER,
  OPERATION_OUTCOME_HEADER,
]);
const BASE_RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

const SNAPSHOT_QUERY = `query CellucidAnnotationSnapshot($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) {
      target {
        oid
        ... on Commit {
          annotations: file(path: "annotations") {
            oid type
            object { ... on Tree { entries { name type oid object { ... on Blob { byteSize } } } } }
          }
          moderation: file(path: "annotations/moderation") {
            oid type
            object { ... on Tree { entries { name type oid object { ... on Blob { byteSize } } } } }
          }
        }
      }
    }
  }
  rateLimit { cost limit remaining resetAt }
}`;

class WorkerHttpError extends Error {
  constructor(status, message, { headers = null, cause = null } = {}) {
    super(message);
    this.name = 'WorkerHttpError';
    this.status = status;
    this.responseHeaders = headers;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// One request's lifetime: the browser leaving, the stall clock, streams.
// ---------------------------------------------------------------------------

/**
 * The lifetime of one request. Its `signal` stops every upstream request it
 * made when the browser goes away (`request.signal`, compatibility flag
 * `enable_request_signal`) or when nothing moved for a whole stall window.
 * The stall clock runs only while the request waits on something (`wait`:
 * a request-body chunk, an upstream answer, an upstream body chunk), and
 * every wait that completes is progress. A relayed body `hold`s the request
 * open until it ends, so the request stays stoppable while it streams.
 */
function createRequestScope(request) {
  if (typeof AbortController !== 'function' || !(request.signal instanceof AbortSignal)) {
    throw new WorkerHttpError(
      500,
      'Request signals are required by the Worker (compatibility flag enable_request_signal)'
    );
  }
  const controller = new AbortController();
  let stopCause = null;
  let stopReason = null;
  let waiting = 0;
  let stallTimer = null;
  let holds = 0;
  let closeRequested = false;
  let closed = false;

  const disarm = () => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };
  const stop = (cause, reason) => {
    if (closed || stopCause !== null) return;
    stopCause = cause;
    stopReason = reason;
    disarm();
    controller.abort(reason);
  };
  const arm = () => {
    disarm();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      stop('stall', null);
    }, WORKER_STALL_TIMEOUT_MS);
  };
  const stopCaller = onAbort(request.signal, () => stop('caller', request.signal.reason));

  const stoppedError = () => {
    if (stopCause === 'caller') {
      return new WorkerHttpError(499, 'Worker request was canceled', { cause: stopReason });
    }
    if (stopCause === 'stall') {
      return new WorkerHttpError(
        504,
        `Worker request stalled: nothing moved for ${WORKER_STALL_TIMEOUT_MS / 1000} s`
      );
    }
    return null;
  };
  const finishClose = () => {
    if (closed || !closeRequested || holds !== 0) return;
    closed = true;
    disarm();
    stopCaller();
  };

  return {
    signal: controller.signal,
    stoppedError,
    throwIfStopped() {
      const error = stoppedError();
      if (error !== null) throw error;
    },
    /** Wait for one step of upstream or request-body work, under the stall clock. */
    wait(promise) {
      const stopped = stoppedError();
      if (stopped !== null) {
        Promise.resolve(promise).catch(() => {});
        return Promise.reject(stopped);
      }
      waiting += 1;
      if (waiting === 1) arm();
      return new Promise((resolve, reject) => {
        let settled = false;
        let release = () => {};
        const settle = (callback, value, moved) => {
          if (settled) return;
          settled = true;
          release();
          waiting -= 1;
          if (stopCause === null) {
            if (waiting === 0) disarm();
            else if (moved) arm();
          }
          callback(value);
        };
        release = onAbort(controller.signal, () => {
          settle(
            reject,
            stoppedError() ?? new WorkerHttpError(502, 'Worker request was interrupted'),
            false
          );
        });
        Promise.resolve(promise).then(
          value => settle(resolve, value, true),
          error => settle(reject, error, true)
        );
      });
    },
    /** Keep the request open (stoppable, its listeners live) until the returned release runs. */
    hold() {
      if (closed) throw new WorkerHttpError(500, 'Worker request is already closed');
      holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        finishClose();
      };
    },
    close() {
      closeRequested = true;
      finishClose();
    },
  };
}

// ---------------------------------------------------------------------------
// Bodies.
// ---------------------------------------------------------------------------

function concatenate(chunks, total) {
  if (chunks.length === 1) return chunks[0];
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Read a request's or an upstream response's whole body as UTF-8 text, chunk
 * by chunk under the stall clock. A leading byte-order mark is kept, so JSON
 * parsing refuses it rather than accepting a second spelling.
 */
async function readBodyText(source, label, scope, { failStatus, maxBytes = null }) {
  scope.throwIfStopped();
  const body = source.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const result = await scope.wait(reader.read());
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw new WorkerHttpError(failStatus, `${label} body could not be read`);
      }
      total += result.value.byteLength;
      if (maxBytes !== null && total > maxBytes) {
        throw new WorkerHttpError(413, `${label} body exceeds ${formatCountOf(maxBytes, 'byte')}`);
      }
      chunks.push(result.value);
    }
    complete = true;
  } catch (cause) {
    if (cause instanceof WorkerHttpError) throw cause;
    throw scope.stoppedError() ??
      new WorkerHttpError(failStatus, `${label} body could not be read`, { cause });
  } finally {
    if (!complete) {
      try {
        Promise.resolve(reader.cancel()).catch(() => {});
      } catch {
        // The read's own failure is the answer.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // A pending read is settled by its own wait.
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(concatenate(chunks, total));
  } catch (cause) {
    throw new WorkerHttpError(failStatus, `${label} body contains invalid UTF-8`, { cause });
  }
}

function parseJsonText(text, label, status) {
  if (!text) throw new WorkerHttpError(status, `${label} body is empty`);
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new WorkerHttpError(status, `${label} contains invalid JSON`, { cause });
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The JSON object a request carries. JSON is parsed natively, so a repeated
 * key keeps its last value; what is forwarded is always re-serialized from
 * the values checked here, never the bytes received.
 */
async function readJsonRequestObject(request, label, scope, maxBytes = WORKER_REQUEST_BODY_MAX_BYTES) {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    throw new WorkerHttpError(415, `${label} requires application/json`);
  }
  const declared = request.headers.get('Content-Length');
  if (declared !== null) {
    if (!DECIMAL.test(declared)) {
      throw new WorkerHttpError(400, `${label} Content-Length is invalid`);
    }
    if (Number(declared) > maxBytes) {
      throw new WorkerHttpError(413, `${label} body exceeds ${formatCountOf(maxBytes, 'byte')}`);
    }
  }
  const text = await readBodyText(request, label, scope, { failStatus: 400, maxBytes });
  const document = parseJsonText(text, label, 400);
  if (!isRecord(document)) {
    throw new WorkerHttpError(400, `${label} must be a JSON object`);
  }
  return document;
}

async function readUpstreamJson(response, label, scope) {
  return parseJsonText(await readBodyText(response, label, scope, { failStatus: 502 }), label, 502);
}

function discardBody(response) {
  try {
    Promise.resolve(response.body?.cancel()).catch(() => {});
  } catch {
    // Nothing of the body is used.
  }
}

// ---------------------------------------------------------------------------
// Responses and headers.
// ---------------------------------------------------------------------------

function mergeHeaders(...sources) {
  const merged = new Headers();
  for (const source of sources) {
    if (!source) continue;
    new Headers(source).forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') merged.append(key, value);
      else merged.set(key, value);
    });
  }
  return merged;
}

function jsonResponse(data, status, headers = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: mergeHeaders(headers, BASE_RESPONSE_HEADERS, {
      'Content-Type': 'application/json; charset=utf-8',
    }),
  });
}

/** The GitHub headers of `response` the page may read, each only in its grammar. */
function relayedGitHubHeaders(response) {
  const headers = new Headers();
  for (const [name, grammar] of RELAYED_GITHUB_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null && grammar.test(value)) headers.set(name, value);
  }
  return headers;
}

function notModifiedResponse(response, headers) {
  discardBody(response);
  return new Response(null, {
    status: 304,
    headers: mergeHeaders(headers, BASE_RESPONSE_HEADERS),
  });
}

/**
 * Relay an upstream answer as it is (status, `Content-Type`, body bytes),
 * unparsed: its size costs no CPU. The body is read chunk by chunk under the
 * request's stall clock, and only when the browser asks for more; the browser
 * leaving cancels the upstream body.
 */
function relayResponse(upstream, headers, scope) {
  const responseHeaders = mergeHeaders(headers, BASE_RESPONSE_HEADERS);
  const contentType = upstream.headers.get('Content-Type');
  if (contentType !== null) responseHeaders.set('Content-Type', contentType);
  if (upstream.body === null || [204, 205, 304].includes(upstream.status)) {
    discardBody(upstream);
    return new Response(null, { status: upstream.status, headers: responseHeaders });
  }
  return new Response(relayStream(upstream.body, scope), {
    status: upstream.status,
    headers: responseHeaders,
  });
}

function relayStream(body, scope) {
  const reader = body.getReader();
  const release = scope.hold();
  let finished = false;
  let cancelling = null;
  let stopWatching = () => {};
  const finish = () => {
    if (finished) return;
    finished = true;
    stopWatching();
    try {
      reader.releaseLock();
    } catch {
      // A pending read is settled by its own wait.
    }
    release();
  };
  const cancelUpstream = (reason) => {
    if (cancelling !== null) return cancelling;
    let cancelled;
    try {
      cancelled = reader.cancel(reason);
    } catch (cause) {
      cancelled = Promise.reject(cause);
    }
    cancelling = Promise.resolve(cancelled).catch(() => {}).finally(finish);
    return cancelling;
  };
  return new ReadableStream({
    start(controller) {
      stopWatching = onAbort(scope.signal, () => {
        const error = scope.stoppedError() ??
          new WorkerHttpError(502, 'Worker request was interrupted');
        try {
          controller.error(error);
        } catch {
          // The browser may already have cancelled the stream.
        }
        void cancelUpstream(error);
      });
    },
    async pull(controller) {
      if (finished || cancelling !== null) return;
      let result;
      try {
        result = await scope.wait(reader.read());
      } catch (cause) {
        const error = cause instanceof WorkerHttpError
          ? cause
          : scope.stoppedError() ??
            new WorkerHttpError(502, 'The upstream body failed', { cause });
        try {
          controller.error(error);
        } catch {
          // The stream was already errored by the stop.
        }
        await cancelUpstream(error);
        return;
      }
      if (result.done) {
        controller.close();
        finish();
        return;
      }
      controller.enqueue(result.value);
    },
    cancel(reason) {
      return cancelUpstream(reason);
    },
  });
}

/** The message of a GitHub error answer: GitHub's own `message`, or its status. */
async function upstreamErrorMessage(response, label, scope) {
  const statusMessage = `${label} failed: GitHub answered HTTP ${response.status}`;
  let text;
  try {
    text = await readBodyText(response, label, scope, { failStatus: 502 });
  } catch (error) {
    const stopped = scope.stoppedError();
    if (stopped !== null) throw stopped;
    return statusMessage;
  }
  try {
    const document = JSON.parse(text);
    if (
      isRecord(document) &&
      typeof document.message === 'string' &&
      document.message.trim() !== ''
    ) {
      return document.message;
    }
  } catch {
    // Not JSON (an HTML error page): the status says what happened.
  }
  return statusMessage;
}

// ---------------------------------------------------------------------------
// Entry.
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    let corsHeaders = new Headers();
    let scope = null;
    try {
      if (!(request instanceof Request)) {
        throw new WorkerHttpError(400, 'Worker request must be a Request');
      }
      const url = new URL(request.url);
      const allowedOrigins = validateWorkerEnvironment(env);
      const origin = request.headers.get('Origin');
      if (origin !== null && !allowedOrigins.has(origin)) {
        return jsonResponse({ error: `Origin is not allowed: ${origin}` }, 403);
      }
      const isCapRoute = url.pathname === '/cap/lookup-cells';
      const isCapNamespace = url.pathname === '/cap' || url.pathname.startsWith('/cap/');
      if (isCapNamespace && !isCapRoute) {
        throw new WorkerHttpError(404, 'CAP route not found');
      }
      if (isCapRoute && origin === null) {
        throw new WorkerHttpError(403, 'CAP routes require an allowed Origin');
      }
      const cors = isCapRoute
        ? {
            allowedMethods: CAP_ALLOWED_METHODS,
            allowedRequestHeaders: CAP_ALLOWED_REQUEST_HEADERS,
            exposedResponseHeaders: [],
          }
        : {
            allowedMethods: ALLOWED_METHODS,
            allowedRequestHeaders: ALLOWED_REQUEST_HEADERS,
            exposedResponseHeaders: WORKER_EXPOSED_RESPONSE_HEADERS,
          };
      corsHeaders = createCorsHeaders(origin, cors);

      if (request.method === 'OPTIONS') {
        return handlePreflight(request, corsHeaders, cors);
      }
      if (isCapRoute) {
        requireMethod(request, 'POST');
        scope = createRequestScope(request);
        return await handleCapLookup(request, url, corsHeaders, scope);
      }
      if (!ALLOWED_METHODS.has(request.method)) {
        throw new WorkerHttpError(405, `Method is not allowed: ${request.method}`);
      }

      switch (url.pathname) {
        case '/':
          requireMethod(request, 'GET');
          return jsonResponse(
            {
              status: 'ok',
              service: WORKER_SERVICE,
              contractVersion: WORKER_CONTRACT_VERSION,
              endpoints: WORKER_ENDPOINTS,
            },
            200,
            corsHeaders
          );
        case '/auth/login':
          requireMethod(request, 'GET');
          return await handleLogin(url, env, allowedOrigins);
        case '/auth/callback':
          requireMethod(request, 'GET');
          scope = createRequestScope(request);
          return await handleCallback(request, url, env, allowedOrigins, scope);
        case '/auth/revoke':
          requireMethod(request, 'POST');
          scope = createRequestScope(request);
          return await handleRevoke(request, env, corsHeaders, scope);
        case '/auth/user':
          requireMethod(request, 'GET');
          scope = createRequestScope(request);
          return await handleGetUser(request, url, corsHeaders, scope);
        case '/auth/installations':
          requireMethod(request, 'GET');
          scope = createRequestScope(request);
          return await handleGetInstallations(request, url, corsHeaders, scope);
        case '/auth/installation-repos':
          requireMethod(request, 'POST');
          scope = createRequestScope(request);
          return await handleGetInstallationRepos(request, url, corsHeaders, scope);
        case '/graphql/snapshot':
          requireMethod(request, 'POST');
          scope = createRequestScope(request);
          return await handleGraphQLSnapshot(request, url, corsHeaders, scope);
        case '/graphql/blobs':
          requireMethod(request, 'POST');
          scope = createRequestScope(request);
          return await handleGraphQLBlobs(request, url, corsHeaders, scope);
        default:
          break;
      }
      if (url.pathname.startsWith('/api/')) {
        scope = createRequestScope(request);
        return await handleApiProxy(request, url, corsHeaders, scope);
      }
      throw new WorkerHttpError(404, 'Route not found');
    } catch (error) {
      const status = error instanceof WorkerHttpError ? error.status : 500;
      const message = error instanceof WorkerHttpError ? error.message : 'Internal worker error';
      if (!(error instanceof WorkerHttpError)) {
        console.error('Cellucid GitHub worker error', {
          name: error?.name,
          message: error?.message,
        });
      }
      return jsonResponse(
        { error: message },
        status,
        mergeHeaders(corsHeaders, error?.responseHeaders)
      );
    } finally {
      scope?.close();
    }
  },
};

// ---------------------------------------------------------------------------
// Request checks, environment, CORS.
// ---------------------------------------------------------------------------

function exceedsCodePointLimit(value, max) {
  if (value.length <= max) return false;
  if (value.length > max * 2) return true;
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > max) return true;
  }
  return false;
}

/** A non-empty string without leading or trailing whitespace. */
function assertExactString(value, label, status = 400) {
  if (typeof value !== 'string' || !value || /^\s|\s$/.test(value)) {
    throw new WorkerHttpError(status, `${label} must be an exact nonblank string`);
  }
  return value;
}

function assertExactFields(value, fields, label, status = 400) {
  return requireExactObjectKeys(value, fields, label, message => new WorkerHttpError(status, message));
}

function assertFields(value, required, optional, label, status = 400) {
  return requireObjectKeys(value, required, optional, label, message => new WorkerHttpError(status, message));
}

function requireMethod(request, expected) {
  if (request.method !== expected) {
    throw new WorkerHttpError(405, `${request.url} requires ${expected}`);
  }
}

function assertNoQuery(url, label) {
  if (url.search !== '') {
    throw new WorkerHttpError(400, `${label} does not accept a query`);
  }
}

function assertExactQuery(url, expected, label) {
  const expectedKeys = Object.keys(expected);
  const actualKeys = [...new Set(url.searchParams.keys())];
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some(key => !actualKeys.includes(key))
  ) {
    throw new WorkerHttpError(400, `${label} query must contain exactly ${expectedKeys.join(', ')}`);
  }
  const output = {};
  for (const key of expectedKeys) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1) {
      throw new WorkerHttpError(400, `${label} query field ${key} must occur exactly once`);
    }
    output[key] = values[0];
  }
  return output;
}

function assertPositiveInteger(value, label) {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new WorkerHttpError(400, `${label} must be a positive safe integer`);
  }
  return Number(value);
}

function getSingleQueryParam(url, name, { required = false } = {}) {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new WorkerHttpError(400, `${name} must occur at most once`);
  }
  if (!values.length) {
    if (required) throw new WorkerHttpError(400, `Missing ${name}`);
    return null;
  }
  return assertExactString(values[0], name);
}

function requireEnvString(env, key) {
  const value = env?.[key];
  if (typeof value !== 'string' || !value || /^\s|\s$/.test(value)) {
    throw new WorkerHttpError(500, `Missing or invalid worker secret: ${key}`);
  }
  return value;
}

function validateWorkerEnvironment(env) {
  const allowedOrigins = parseOriginAllowlist(
    requireEnvString(env, 'ALLOWED_ORIGINS'),
    message => new WorkerHttpError(500, message)
  );
  requireEnvString(env, 'GITHUB_CLIENT_ID');
  requireEnvString(env, 'GITHUB_CLIENT_SECRET');
  return allowedOrigins;
}

function createCorsHeaders(origin, { allowedMethods, allowedRequestHeaders, exposedResponseHeaders }) {
  const headers = new Headers({
    'Access-Control-Allow-Methods': [...allowedMethods].join(', '),
    'Access-Control-Allow-Headers': [...allowedRequestHeaders].join(', '),
    'Vary': 'Origin',
  });
  if (exposedResponseHeaders.length !== 0) {
    headers.set('Access-Control-Expose-Headers', exposedResponseHeaders.join(', '));
  }
  if (origin !== null) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function handlePreflight(request, corsHeaders, { allowedMethods, allowedRequestHeaders }) {
  const requestedMethod = request.headers.get('Access-Control-Request-Method');
  if (
    requestedMethod === null ||
    !allowedMethods.has(requestedMethod) ||
    requestedMethod === 'OPTIONS'
  ) {
    throw new WorkerHttpError(400, 'Invalid CORS preflight method');
  }
  const rawHeaders = request.headers.get('Access-Control-Request-Headers') ?? '';
  const requestedHeaders = rawHeaders
    ? rawHeaders.split(',').map(header => header.trim().toLowerCase())
    : [];
  if (requestedHeaders.some(header => !header || !allowedRequestHeaders.has(header))) {
    throw new WorkerHttpError(400, 'Invalid CORS preflight request header');
  }
  const headers = new Headers(corsHeaders);
  headers.set('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE_SECONDS));
  return new Response(null, { status: 204, headers });
}

function getBearerToken(request) {
  const authorization = request.headers.get('Authorization');
  if (authorization === null) {
    throw new WorkerHttpError(401, 'Missing bearer token');
  }
  const match = /^Bearer ([^\s,]+)$/.exec(authorization);
  if (!match) throw new WorkerHttpError(401, 'Invalid bearer token');
  return match[1];
}

/**
 * The conditional-request tag a GitHub read passes on (`If-None-Match`), or
 * null; any other request refuses one.
 */
function readIfNoneMatch(request, { allowed }) {
  const value = request.headers.get('If-None-Match');
  if (value === null) return null;
  if (!allowed) {
    throw new WorkerHttpError(400, 'If-None-Match is accepted only on GitHub reads');
  }
  if (!IF_NONE_MATCH.test(value)) {
    throw new WorkerHttpError(400, 'If-None-Match must be * or a list of entity tags');
  }
  return value;
}

function assertNoOperationHeaders(request) {
  if (request.headers.has(OPERATION_ID_HEADER) || request.headers.has(OPERATION_OUTCOME_HEADER)) {
    throw new WorkerHttpError(400, 'GitHub read requests must not contain Cellucid operation headers');
  }
}

// ---------------------------------------------------------------------------
// GitHub requests.
// ---------------------------------------------------------------------------

function createGitHubHeaders(token) {
  return new Headers({
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'User-Agent': GITHUB_USER_AGENT,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  });
}

async function fetchUpstream(url, init, label, scope, mutation = null) {
  scope.throwIfStopped();
  mutation?.markForwarded();
  try {
    return await scope.wait(fetch(url, { ...init, signal: scope.signal }));
  } catch (cause) {
    if (cause instanceof WorkerHttpError) throw cause;
    throw scope.stoppedError() ??
      new WorkerHttpError(502, `${label} could not be reached`, { cause });
  }
}

async function githubGet(path, token, scope, ifNoneMatch = null) {
  const headers = createGitHubHeaders(token);
  if (ifNoneMatch !== null) headers.set('If-None-Match', ifNoneMatch);
  return fetchUpstream(`${GITHUB_API_ORIGIN}${path}`, { headers }, `GitHub API GET ${path}`, scope);
}

function projectUser(document, status = 502) {
  if (!isRecord(document)) {
    throw new WorkerHttpError(status, 'GitHub user response must be a JSON object');
  }
  const { id, login } = document;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new WorkerHttpError(status, 'GitHub user id is invalid');
  }
  if (!isCanonicalGitHubAccount(login)) {
    throw new WorkerHttpError(status, 'GitHub user login is not a canonical GitHub account');
  }
  return { id, login };
}

// ---------------------------------------------------------------------------
// OAuth.
// ---------------------------------------------------------------------------

function validateReturnTo(rawReturnTo, allowedOrigins) {
  const candidate = assertExactString(rawReturnTo, 'return_to');
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (cause) {
    throw new WorkerHttpError(400, 'Invalid return_to URL', { cause });
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password
  ) {
    throw new WorkerHttpError(400, 'Invalid return_to URL');
  }
  if (!allowedOrigins.has(parsed.origin)) {
    throw new WorkerHttpError(400, `Disallowed return_to origin: ${parsed.origin}`);
  }
  return parsed.toString();
}

function serializeCookie(name, value, { maxAge }) {
  return [
    `${name}=${value}`,
    `Path=${OAUTH_COOKIE_PATH}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

function getCookie(request, name, { required = false } = {}) {
  const raw = request.headers.get('Cookie');
  const matches = [];
  if (raw !== null) {
    for (const part of raw.split(';')) {
      const separator = part.indexOf('=');
      if (separator < 1) throw new WorkerHttpError(400, 'Malformed Cookie header');
      if (part.slice(0, separator).trim() !== name) continue;
      matches.push(part.slice(separator + 1).trim());
    }
  }
  if (matches.length > 1) throw new WorkerHttpError(400, `Duplicate ${name} cookie`);
  if (!matches.length || !matches[0]) {
    if (required) throw new WorkerHttpError(400, `Missing ${name} cookie`);
    return null;
  }
  return matches[0];
}

function getOauthOwnerCookieName(state) {
  if (typeof state !== 'string' || !OAUTH_RANDOM_HEX_256.test(state)) {
    throw new WorkerHttpError(400, 'OAuth state must be 64 lowercase hexadecimal characters');
  }
  return `${OAUTH_OWNER_COOKIE_PREFIX}${state}`;
}

function clearOauthOwnerCookie(headers, name) {
  headers.append('Set-Cookie', serializeCookie(name, '', { maxAge: 0 }));
}

/**
 * The owner cookie's value is the PKCE verifier, a dot, and the return URL.
 * A serialized URL is printable ASCII; a cookie value may hold any printable
 * ASCII but `"`, `,`, `;` and `\` (RFC 6265 4.1.1), so only those and `%` are
 * percent-escaped: the URL costs its own length, plus two bytes per escape.
 */
function encodeOwnerCookieValue(codeVerifier, returnTo) {
  const escaped = returnTo.replace(
    /[%",;\\]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${codeVerifier}.${escaped}`;
}

function parseOwnerCookieValue(rawValue, allowedOrigins) {
  const codeVerifier = rawValue.slice(0, 64);
  if (!OAUTH_RANDOM_HEX_256.test(codeVerifier) || rawValue[64] !== '.') {
    throw new WorkerHttpError(400, 'OAuth owner cookie is malformed');
  }
  let returnTo;
  try {
    returnTo = decodeURIComponent(rawValue.slice(65));
  } catch (cause) {
    throw new WorkerHttpError(400, 'OAuth owner cookie is malformed', { cause });
  }
  return { codeVerifier, returnTo: validateReturnTo(returnTo, allowedOrigins) };
}

function redirectToApp(returnTo, { token = null, expiresIn = null, error = null }, headers) {
  if ((token === null) === (error === null) || (token === null) !== (expiresIn === null)) {
    throw new WorkerHttpError(500, 'OAuth redirect requires exactly one token with its lifetime, or an error');
  }
  const destination = new URL(returnTo);
  const fragmentIndex = destination.href.indexOf('#');
  const retained = fragmentIndex === -1
    ? { cleanedHash: '', hasRetainedSegments: false }
    : scrubAuthFragment(destination.href.slice(fragmentIndex + 1));
  const hashParams = new URLSearchParams();
  hashParams.set(AUTH_FLAG_PARAM, '1');
  if (token !== null) {
    hashParams.set(AUTH_TOKEN_PARAM, assertExactString(token, 'OAuth token', 502));
    hashParams.set(AUTH_TOKEN_EXPIRES_PARAM, String(expiresIn));
  } else {
    hashParams.set(AUTH_ERROR_PARAM, assertExactString(error, 'OAuth error', 502));
  }
  const authHash = hashParams.toString();
  destination.hash = retained.hasRetainedSegments
    ? `${retained.cleanedHash}&${authHash}`
    : authHash;
  return new Response(null, {
    status: 302,
    headers: mergeHeaders(headers, {
      'Cache-Control': 'no-store',
      'Location': destination.toString(),
    }),
  });
}

async function handleLogin(url, env, allowedOrigins) {
  const returnTo = validateReturnTo(
    getSingleQueryParam(url, 'return_to', { required: true }),
    allowedOrigins
  );
  const state = randomHex(32);
  const codeVerifier = randomHex(32);
  const ownerCookie = serializeCookie(
    getOauthOwnerCookieName(state),
    encodeOwnerCookieValue(codeVerifier, returnTo),
    { maxAge: OAUTH_COOKIE_MAX_AGE_S }
  );
  if (ownerCookie.length > OAUTH_COOKIE_MAX_SERIALIZED_BYTES) {
    // The sign-in cannot carry this address through GitHub, and this is a
    // top-level navigation: send the page back with the reason.
    return redirectToApp(
      returnTo,
      {
        error:
          'GitHub sign-in could not start: this page address is ' +
          `${formatCountOf(returnTo.length, 'character')} long, more than the ` +
          `${formatCountOf(OAUTH_COOKIE_MAX_SERIALIZED_BYTES, 'byte')} a browser keeps in the ` +
          'sign-in cookie that carries it through GitHub. Open Cellucid from a ' +
          'shorter address, sign in, then open the data again.',
      },
      null
    );
  }
  const authUrl = new URL(GITHUB_AUTH_URL);
  authUrl.searchParams.set('client_id', requireEnvString(env, 'GITHUB_CLIENT_ID'));
  authUrl.searchParams.set('redirect_uri', `${url.origin}/auth/callback`);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', await codeChallengeOf(codeVerifier));
  authUrl.searchParams.set('code_challenge_method', 'S256');
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Location': authUrl.toString(),
  });
  headers.append('Set-Cookie', ownerCookie);
  return new Response(null, { status: 302, headers });
}

function oauthCallbackFailureMessage(error, outcomeUnknown) {
  if (outcomeUnknown) {
    return 'GitHub sign-in outcome is unknown. Start a new sign-in; do not retry this callback.';
  }
  if (error instanceof WorkerHttpError && error.status === 400) {
    return `GitHub sign-in failed: ${error.message}`;
  }
  return 'GitHub sign-in could not be completed. Please try again.';
}

const INSTALLATION_PAGES = Object.freeze({
  install: [
    'The Cellucid GitHub App is installed',
    'Go back to the Cellucid tab you came from and sign in with GitHub there (or reopen the repository list if you are signed in already). You can close this tab.',
  ],
  update: [
    'The Cellucid GitHub App installation is updated',
    'Go back to the Cellucid tab you came from and reopen the repository list to see the repositories it can reach now. You can close this tab.',
  ],
  request: [
    'Your request to install the Cellucid GitHub App was sent',
    'An owner of that account must approve it. Once they have, go back to Cellucid and sign in with GitHub. You can close this tab.',
  ],
});

/**
 * GitHub's redirect after an installation (the App's "Request user
 * authorization (OAuth) during installation"): it carries `setup_action` and
 * no `state`, as no Cellucid sign-in started it, so there is no page to
 * return to and no PKCE verifier. Its code is not exchanged (it expires
 * unused after ten minutes); the person is told to go back to Cellucid, whose
 * own sign-in then completes at once, the app being authorized already.
 */
function installationPage(url) {
  const setupAction = getSingleQueryParam(url, 'setup_action', { required: true });
  if (!GITHUB_SETUP_ACTIONS.has(setupAction)) {
    throw new WorkerHttpError(400, 'setup_action must be install, update or request');
  }
  const [title, text] = INSTALLATION_PAGES[setupAction];
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${title}</title></head>` +
    '<body style="font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem">' +
    `<h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      ...BASE_RESPONSE_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
    },
  });
}

async function handleCallback(request, url, env, allowedOrigins, scope) {
  if (!url.searchParams.has('state') && url.searchParams.has('setup_action')) {
    return installationPage(url);
  }
  const ownerCookieName = getOauthOwnerCookieName(
    getSingleQueryParam(url, 'state', { required: true })
  );
  const headers = new Headers();
  clearOauthOwnerCookie(headers, ownerCookieName);
  let returnTo = null;
  let tokenExchangeForwarded = false;
  try {
    const owner = parseOwnerCookieValue(
      getCookie(request, ownerCookieName, { required: true }),
      allowedOrigins
    );
    returnTo = owner.returnTo;

    const code = getSingleQueryParam(url, 'code');
    const oauthError = getSingleQueryParam(url, 'error');
    const errorDescription = getSingleQueryParam(url, 'error_description');
    if ((code === null) === (oauthError === null)) {
      throw new WorkerHttpError(400, 'OAuth callback requires exactly one code or error');
    }
    if (oauthError !== null) {
      if (errorDescription === null) {
        throw new WorkerHttpError(400, 'OAuth error must include error_description');
      }
      return redirectToApp(returnTo, { error: `GitHub error: ${errorDescription}` }, headers);
    }
    if (errorDescription !== null) {
      throw new WorkerHttpError(400, 'OAuth error_description cannot accompany an authorization code');
    }

    const tokenResponse = await fetchUpstream(
      GITHUB_TOKEN_URL,
      {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: requireEnvString(env, 'GITHUB_CLIENT_ID'),
          client_secret: requireEnvString(env, 'GITHUB_CLIENT_SECRET'),
          code,
          code_verifier: owner.codeVerifier,
          redirect_uri: `${url.origin}/auth/callback`,
        }),
      },
      'GitHub OAuth token exchange',
      scope,
      { markForwarded() { tokenExchangeForwarded = true; } }
    );
    const tokenDocument = await readUpstreamJson(tokenResponse, 'GitHub OAuth token response', scope);
    // GitHub refuses an exchange (a used or expired code, a PKCE mismatch, a
    // wrong client secret) with an `error` document, usually under HTTP 200
    // (https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-oauth-app-access-token-request-errors).
    if (isRecord(tokenDocument) && Object.hasOwn(tokenDocument, 'error')) {
      assertFields(
        tokenDocument,
        ['error'],
        ['error_description', 'error_uri'],
        'GitHub OAuth error response',
        502
      );
      const errorCode = assertExactString(tokenDocument.error, 'GitHub OAuth error', 502);
      // The code names what to fix (`incorrect_client_credentials` is the
      // operator's secret); it is never a secret itself.
      console.error('Cellucid GitHub OAuth token exchange refused', {
        error: errorCode,
        status: tokenResponse.status,
      });
      const message = Object.hasOwn(tokenDocument, 'error_description')
        ? assertExactString(tokenDocument.error_description, 'GitHub OAuth error_description', 502)
        : errorCode;
      return redirectToApp(returnTo, { error: message }, headers);
    }
    if (!tokenResponse.ok) {
      throw new WorkerHttpError(502, `GitHub OAuth token exchange answered HTTP ${tokenResponse.status}`);
    }
    // An expiring user token (the GitHub App's "Expire user authorization
    // tokens"): the access token lasts hours, never indefinitely. Its refresh
    // token is not used: it never leaves the worker, and a sign-in that runs
    // out is a new sign-in.
    assertExactFields(
      tokenDocument,
      ['access_token', 'expires_in', 'refresh_token', 'refresh_token_expires_in', 'scope', 'token_type'],
      'GitHub OAuth success response',
      502
    );
    if (tokenDocument.token_type !== 'bearer' || tokenDocument.scope !== '') {
      throw new WorkerHttpError(502, 'GitHub OAuth response has an invalid token_type or scope');
    }
    const token = assertExactString(tokenDocument.access_token, 'GitHub OAuth access_token', 502);
    const expiresIn = tokenDocument.expires_in;
    if (!Number.isSafeInteger(expiresIn) || expiresIn < 1) {
      throw new WorkerHttpError(502, 'GitHub OAuth expires_in is not a positive number of seconds');
    }
    return redirectToApp(returnTo, { token, expiresIn }, headers);
  } catch (error) {
    if (returnTo !== null) {
      if (!(error instanceof WorkerHttpError)) {
        console.error('Cellucid GitHub OAuth callback error', {
          name: error?.name,
          message: error?.message,
        });
      }
      return redirectToApp(
        returnTo,
        { error: oauthCallbackFailureMessage(error, tokenExchangeForwarded) },
        headers
      );
    }
    if (error && typeof error === 'object') {
      error.responseHeaders = mergeHeaders(error.responseHeaders, headers);
    }
    throw error;
  }
}

/**
 * Revoke the bearer token at GitHub (`DELETE /applications/{client_id}/token`,
 * which only the app's own credentials may call): Sign out ends the token,
 * not only the page's copy of it. A token GitHub no longer knows (expired,
 * revoked already) is revoked too.
 */
async function handleRevoke(request, env, corsHeaders, scope) {
  const token = getBearerToken(request);
  const clientId = requireEnvString(env, 'GITHUB_CLIENT_ID');
  const clientSecret = requireEnvString(env, 'GITHUB_CLIENT_SECRET');
  const response = await fetchUpstream(
    `${GITHUB_API_ORIGIN}/applications/${encodeURIComponent(clientId)}/token`,
    {
      method: 'DELETE',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        'Content-Type': 'application/json',
        'User-Agent': GITHUB_USER_AGENT,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
      body: JSON.stringify({ access_token: token }),
    },
    'GitHub token revocation',
    scope
  );
  discardBody(response);
  const headers = mergeHeaders(corsHeaders, relayedGitHubHeaders(response));
  if (response.status !== 204 && response.status !== 404 && response.status !== 422) {
    throw new WorkerHttpError(502, `GitHub token revocation failed (HTTP ${response.status})`, { headers });
  }
  return new Response(null, { status: 204, headers: mergeHeaders(headers, BASE_RESPONSE_HEADERS) });
}

// ---------------------------------------------------------------------------
// The signed-in user, installations, repositories.
// ---------------------------------------------------------------------------

async function handleGetUser(request, url, corsHeaders, scope) {
  assertNoQuery(url, 'GitHub user route');
  const token = getBearerToken(request);
  const response = await githubGet('/user', token, scope, readIfNoneMatch(request, { allowed: true }));
  const headers = mergeHeaders(corsHeaders, relayedGitHubHeaders(response));
  if (response.status === 304) return notModifiedResponse(response, headers);
  if (!response.ok) {
    return jsonResponse(
      { error: await upstreamErrorMessage(response, 'GitHub user request', scope) },
      response.status,
      headers
    );
  }
  return jsonResponse(projectUser(await readUpstreamJson(response, 'GitHub user response', scope)), 200, headers);
}

function projectInstallation(installation, index) {
  if (!isRecord(installation)) {
    throw new WorkerHttpError(502, `GitHub installation ${index} must be a JSON object`);
  }
  const id = installation.id;
  const login = isRecord(installation.account) ? installation.account.login : undefined;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new WorkerHttpError(502, `GitHub installation ${index} has an invalid id`);
  }
  if (!isCanonicalGitHubAccount(login)) {
    throw new WorkerHttpError(502, `GitHub installation ${index} account login is not a canonical GitHub account`);
  }
  return { id, account: { login } };
}

function projectRepository(repository, index) {
  if (!isRecord(repository)) {
    throw new WorkerHttpError(502, `GitHub repository ${index} must be a JSON object`);
  }
  const { id, full_name: fullName, private: isPrivate } = repository;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new WorkerHttpError(502, `GitHub repository ${index} has an invalid id`);
  }
  if (!isCanonicalGitHubRepositoryFullName(fullName)) {
    throw new WorkerHttpError(502, `GitHub repository ${index} full_name is not canonical`);
  }
  if (typeof isPrivate !== 'boolean') {
    throw new WorkerHttpError(502, `GitHub repository ${index} private must be boolean`);
  }
  return { id, full_name: fullName, private: isPrivate };
}

/**
 * The next page GitHub names in its `Link` header, which must be the page
 * after this one, or null on the last page.
 */
function nextPageOf(response, page, label) {
  const link = response.headers.get('Link');
  if (link === null) return null;
  for (const part of link.split(',')) {
    const match = /^\s*<([^>]*)>\s*((?:;[^;]*)*)$/.exec(part);
    if (match === null) {
      throw new WorkerHttpError(502, `${label} Link header is malformed`);
    }
    const rel = /;\s*rel="([^"]*)"/.exec(match[2]);
    if (rel === null || !rel[1].split(/\s+/).includes('next')) continue;
    let next;
    try {
      next = new URL(match[1]);
    } catch (cause) {
      throw new WorkerHttpError(502, `${label} Link header is malformed`, { cause });
    }
    if (next.searchParams.get('page') !== String(page + 1)) {
      throw new WorkerHttpError(502, `${label} names a next page that is not page ${page + 1}`);
    }
    return page + 1;
  }
  return null;
}

/**
 * One page of a GitHub collection, as `{items, nextPage}`: one GitHub request
 * per Worker request (Cloudflare Free allows 50 subrequests per request:
 * https://developers.cloudflare.com/workers/platform/limits/#subrequests),
 * so a collection of any size is listed by asking page after page until
 * `nextPage` is null.
 */
async function respondWithCollectionPage({
  path,
  token,
  page,
  ifNoneMatch,
  field,
  projectItem,
  identityOf,
  label,
  corsHeaders,
  scope,
}) {
  const response = await githubGet(`${path}?per_page=${GITHUB_PAGE_SIZE}&page=${page}`, token, scope, ifNoneMatch);
  const headers = mergeHeaders(corsHeaders, relayedGitHubHeaders(response));
  if (response.status === 304) return notModifiedResponse(response, headers);
  if (!response.ok) {
    return jsonResponse({ error: await upstreamErrorMessage(response, label, scope) }, response.status, headers);
  }
  const document = await readUpstreamJson(response, `${label} response`, scope);
  if (!isRecord(document)) {
    throw new WorkerHttpError(502, `${label} response must be a JSON object`);
  }
  if (!Number.isSafeInteger(document.total_count) || document.total_count < 0) {
    throw new WorkerHttpError(502, `${label} response has an invalid total_count`);
  }
  const rawItems = document[field];
  if (!Array.isArray(rawItems)) {
    throw new WorkerHttpError(502, `${label} response is missing ${field}`);
  }
  if (rawItems.length > GITHUB_PAGE_SIZE) {
    throw new WorkerHttpError(502, `${label} page holds more than ${GITHUB_PAGE_SIZE} items`);
  }
  const base = (page - 1) * GITHUB_PAGE_SIZE;
  const items = rawItems.map((item, index) => projectItem(item, base + index));
  const seen = new Set();
  for (const item of items) {
    for (const key of identityOf(item)) {
      if (seen.has(key)) {
        throw new WorkerHttpError(502, `${label} page repeats ${key.slice(key.indexOf(':') + 1)}`);
      }
      seen.add(key);
    }
  }
  return jsonResponse({ items, nextPage: nextPageOf(response, page, label) }, 200, headers);
}

function collectionPageOf(url, label) {
  return assertPositiveInteger(assertExactQuery(url, { page: true }, label).page, `${label} page`);
}

async function handleGetInstallations(request, url, corsHeaders, scope) {
  const page = collectionPageOf(url, 'GitHub installations');
  const token = getBearerToken(request);
  return respondWithCollectionPage({
    path: '/user/installations',
    token,
    page,
    ifNoneMatch: readIfNoneMatch(request, { allowed: true }),
    field: 'installations',
    projectItem: projectInstallation,
    identityOf: item => [`id:${item.id}`, `account:${item.account.login.toLowerCase()}`],
    label: 'GitHub installations',
    corsHeaders,
    scope,
  });
}

async function handleGetInstallationRepos(request, url, corsHeaders, scope) {
  const page = collectionPageOf(url, 'GitHub installation repositories');
  const token = getBearerToken(request);
  readIfNoneMatch(request, { allowed: false });
  const body = await readJsonRequestObject(request, 'installation repositories request', scope);
  assertExactFields(body, ['installation_id'], 'installation repositories request');
  const installationId = body.installation_id;
  if (!Number.isSafeInteger(installationId) || installationId < 1) {
    throw new WorkerHttpError(400, 'installation_id must be a positive safe integer');
  }
  return respondWithCollectionPage({
    path: `/user/installations/${installationId}/repositories`,
    token,
    page,
    ifNoneMatch: null,
    field: 'repositories',
    projectItem: projectRepository,
    identityOf: item => [`id:${item.id}`, `name:${item.full_name.toLowerCase()}`],
    label: 'GitHub installation repositories',
    corsHeaders,
    scope,
  });
}

// ---------------------------------------------------------------------------
// GraphQL reads: the Worker writes the query; GitHub's answer is relayed.
// ---------------------------------------------------------------------------

function assertRepositoryCoordinates(body, label) {
  if (!isCanonicalGitHubAccount(body.owner)) {
    throw new WorkerHttpError(400, `${label} owner must be a canonical GitHub account`);
  }
  if (!isCanonicalGitHubRepositoryName(body.repo)) {
    throw new WorkerHttpError(400, `${label} repo must be a canonical GitHub repository name`);
  }
}

/** The blob batch query: aliases `b<i>` and variables `$o<i>` in request order. */
function blobsQuery(count) {
  const variables = [];
  const fields = [];
  for (let index = 0; index < count; index += 1) {
    variables.push(`, $o${index}: GitObjectID!`);
    fields.push(
      `    b${index}: object(oid: $o${index}) { ... on Blob { oid byteSize isBinary isTruncated text } }\n`
    );
  }
  return (
    `query CellucidAnnotationBlobs($owner: String!, $name: String!${variables.join('')}) {\n` +
    '  repository(owner: $owner, name: $name) {\n' +
    fields.join('') +
    '  }\n' +
    '  rateLimit { cost limit remaining resetAt }\n' +
    '}'
  );
}

async function relayGraphQL(request, query, variables, label, corsHeaders, scope) {
  const token = getBearerToken(request);
  const headers = new Headers({
    'Accept': 'application/json',
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': GITHUB_USER_AGENT,
  });
  const response = await fetchUpstream(
    GITHUB_GRAPHQL_URL,
    { method: 'POST', headers, body: JSON.stringify({ query, variables }) },
    label,
    scope
  );
  // Relayed unparsed, whatever the status: GraphQL reports query errors under
  // HTTP 200 in an `errors` array, which the page reads.
  return relayResponse(response, mergeHeaders(corsHeaders, relayedGitHubHeaders(response)), scope);
}

async function handleGraphQLSnapshot(request, url, corsHeaders, scope) {
  assertNoQuery(url, 'GraphQL snapshot route');
  getBearerToken(request);
  readIfNoneMatch(request, { allowed: false });
  assertNoOperationHeaders(request);
  const label = 'GraphQL snapshot request';
  const body = await readJsonRequestObject(request, label, scope);
  assertExactFields(body, ['owner', 'repo', 'branch'], label);
  assertRepositoryCoordinates(body, label);
  if (!isCanonicalGitHubBranch(body.branch)) {
    throw new WorkerHttpError(400, `${label} branch must be an exact branch`);
  }
  return relayGraphQL(
    request,
    SNAPSHOT_QUERY,
    { owner: body.owner, name: body.repo, ref: `refs/heads/${body.branch}` },
    'GitHub GraphQL snapshot',
    corsHeaders,
    scope
  );
}

async function handleGraphQLBlobs(request, url, corsHeaders, scope) {
  assertNoQuery(url, 'GraphQL blobs route');
  getBearerToken(request);
  readIfNoneMatch(request, { allowed: false });
  assertNoOperationHeaders(request);
  const label = 'GraphQL blobs request';
  const body = await readJsonRequestObject(request, label, scope);
  assertExactFields(body, ['owner', 'repo', 'oids'], label);
  assertRepositoryCoordinates(body, label);
  const oids = body.oids;
  if (!Array.isArray(oids) || oids.length === 0) {
    throw new WorkerHttpError(400, `${label} oids must be a non-empty array`);
  }
  const variables = { owner: body.owner, name: body.repo };
  const seen = new Set();
  for (let index = 0; index < oids.length; index += 1) {
    const oid = oids[index];
    if (typeof oid !== 'string' || !GITHUB_SHA.test(oid)) {
      throw new WorkerHttpError(400, `${label} oids[${index}] must be 40 lowercase hexadecimal characters`);
    }
    if (seen.has(oid)) {
      throw new WorkerHttpError(400, `${label} oids repeats ${oid}`);
    }
    seen.add(oid);
    variables[`o${index}`] = oid;
  }
  return relayGraphQL(request, blobsQuery(oids.length), variables, 'GitHub GraphQL blobs', corsHeaders, scope);
}

// ---------------------------------------------------------------------------
// CAP lookup.
// ---------------------------------------------------------------------------

function assertCapRequestHasNoCredentials(request) {
  for (const header of CAP_FORBIDDEN_REQUEST_HEADERS) {
    if (request.headers.has(header)) {
      throw new WorkerHttpError(400, `CAP requests must not contain ${header}`);
    }
  }
}

function assertCapTerm(value, max) {
  assertExactString(value, 'CAP lookup term');
  if (exceedsCodePointLimit(value, max)) {
    throw new WorkerHttpError(400, `CAP lookup term must be at most ${formatCountOf(max, 'code point')}`);
  }
  return value;
}

function parseCanonicalContentLength(response) {
  const raw = response.headers.get('Content-Length');
  if (raw === null) return null;
  if (!DECIMAL.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new WorkerHttpError(502, 'CAP GraphQL response Content-Length is invalid');
  }
  return Number(raw);
}

async function cancelCapResponseBody(response, scope) {
  const body = response.body;
  if (body === null) {
    scope.throwIfStopped();
    return;
  }
  let cancellation;
  try {
    cancellation = body.cancel();
  } catch {
    scope.throwIfStopped();
    return;
  }
  try {
    await scope.wait(cancellation);
  } catch {
    scope.throwIfStopped();
  }
  scope.throwIfStopped();
}

async function preflightCapUpstreamResponse(response, scope) {
  scope.throwIfStopped();
  if (!response.ok) {
    await cancelCapResponseBody(response, scope);
    throw new WorkerHttpError(502, 'CAP upstream request failed');
  }
  let contentLength;
  let contentLengthError = null;
  try {
    contentLength = parseCanonicalContentLength(response);
  } catch (error) {
    contentLengthError = error;
  }
  if (contentLengthError !== null || (contentLength !== null && contentLength > CAP_RESPONSE_BODY_MAX_BYTES)) {
    await cancelCapResponseBody(response, scope);
    throw new WorkerHttpError(502, 'CAP upstream response was invalid', { cause: contentLengthError });
  }
}

function isStop(error) {
  return error instanceof WorkerHttpError && (error.status === 499 || error.status === 504);
}

async function executeCapPersistedQuery(operationName, hash, variables, scope) {
  let response;
  try {
    response = await fetchUpstream(
      CAP_GRAPHQL_URL,
      {
        method: 'POST',
        headers: new Headers({
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          operationName,
          variables,
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
        }),
        credentials: 'omit',
        // The Workers runtime rejects `redirect: 'error'` outright. A manual
        // redirect arrives as a non-2xx response, which the preflight refuses.
        redirect: 'manual',
      },
      'CAP GraphQL request',
      scope
    );
  } catch (error) {
    if (isStop(error)) throw error;
    throw new WorkerHttpError(502, 'CAP upstream request failed', { cause: error });
  }
  await preflightCapUpstreamResponse(response, scope);
  try {
    const text = await readBodyText(response, 'CAP GraphQL response', scope, {
      failStatus: 502,
      maxBytes: CAP_RESPONSE_BODY_MAX_BYTES,
    });
    return parseJsonText(text, 'CAP GraphQL response', 502);
  } catch (error) {
    if (isStop(error)) throw error;
    throw new WorkerHttpError(502, 'CAP upstream response was invalid', { cause: error });
  }
}

function assertCapString(value, label) {
  return assertExactString(value, label, 502);
}

function assertCapRecord(value, label) {
  if (!isRecord(value)) throw new WorkerHttpError(502, `${label} must be a JSON object`);
  return value;
}

function assertCapNonnegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkerHttpError(502, `${label} must be a nonnegative safe integer`);
  }
  return value;
}

function projectCapStringArray(value, label) {
  if (!Array.isArray(value)) throw new WorkerHttpError(502, `${label} must be an array`);
  return value.map((entry, index) => assertCapString(entry, `${label}[${index}]`));
}

function projectCapLookupItem(value, index) {
  const label = `CAP lookup result[${index}]`;
  const item = assertCapRecord(value, label);
  const scores = assertCapRecord(item.scores, `${label}.scores`);
  const agree = assertCapNonnegativeSafeInteger(scores.agree, `${label}.scores.agree`);
  const disagree = assertCapNonnegativeSafeInteger(scores.disagree, `${label}.scores.disagree`);
  const idk = assertCapNonnegativeSafeInteger(scores.idk, `${label}.scores.idk`);
  if (!Number.isSafeInteger(agree + disagree + idk)) {
    throw new WorkerHttpError(502, `${label}.scores total must be a nonnegative safe integer`);
  }
  return {
    id: assertCapString(item.id, `${label}.id`),
    name: assertCapString(item.name, `${label}.name`),
    fullName: assertCapString(item.fullName, `${label}.fullName`),
    ontologyTerm: item.ontologyTerm === null ? null : assertCapString(item.ontologyTerm, `${label}.ontologyTerm`),
    ontologyTermId: item.ontologyTermId === null ? null : assertCapString(item.ontologyTermId, `${label}.ontologyTermId`),
    synonyms: projectCapStringArray(item.synonyms, `${label}.synonyms`),
    markerGenes: projectCapStringArray(item.markerGenes, `${label}.markerGenes`),
    canonicalMarkerGenes: projectCapStringArray(item.canonicalMarkerGenes, `${label}.canonicalMarkerGenes`),
    count: assertCapNonnegativeSafeInteger(item.count, `${label}.count`),
    scores: { agree, disagree, idk },
  };
}

function projectCapLookupResults(document, limit) {
  const response = assertCapRecord(document, 'CAP GraphQL response');
  if (Object.hasOwn(response, 'errors')) {
    if (!Array.isArray(response.errors) || response.errors.length !== 0) {
      throw new WorkerHttpError(502, 'CAP GraphQL operation failed');
    }
  }
  const data = assertCapRecord(response.data, 'CAP GraphQL response.data');
  const rawResults = data.lookupCells;
  if (!Array.isArray(rawResults) || rawResults.length > limit) {
    throw new WorkerHttpError(502, 'CAP GraphQL response.data.lookupCells is invalid');
  }
  const results = [];
  let omittedInvalidCount = 0;
  for (let index = 0; index < rawResults.length; index += 1) {
    try {
      results.push(projectCapLookupItem(rawResults[index], index));
    } catch (error) {
      if (!(error instanceof WorkerHttpError) || error.status !== 502) throw error;
      omittedInvalidCount += 1;
    }
  }
  return { results, omittedInvalidCount };
}

function capGatewayResponse(data, corsHeaders) {
  const text = JSON.stringify({
    contractVersion: WORKER_CONTRACT_VERSION,
    results: data.results,
    omittedInvalidCount: data.omittedInvalidCount,
  });
  if (new TextEncoder().encode(text).byteLength > CAP_OUTPUT_BODY_MAX_BYTES) {
    throw new WorkerHttpError(502, `CAP gateway response exceeds ${formatCountOf(CAP_OUTPUT_BODY_MAX_BYTES, 'byte')}`);
  }
  return new Response(text, {
    status: 200,
    headers: mergeHeaders(corsHeaders, BASE_RESPONSE_HEADERS, {
      'Content-Type': 'application/json; charset=utf-8',
    }),
  });
}

function capLookupSearch(kind, term) {
  if (kind === 'ontology') return { name: term, fields: CAP_ONTOLOGY_LOOKUP_FIELDS };
  if (kind === 'marker') return { name: term, fields: CAP_MARKER_LOOKUP_FIELDS };
  return { name: term };
}

async function handleCapLookup(request, url, corsHeaders, scope) {
  assertNoQuery(url, 'CAP lookup route');
  assertCapRequestHasNoCredentials(request);
  const body = await readJsonRequestObject(request, 'CAP lookup request', scope, CAP_REQUEST_BODY_MAX_BYTES);
  assertExactFields(body, ['kind', 'term', 'limit'], 'CAP lookup request');
  const kind = assertExactString(body.kind, 'CAP lookup kind');
  if (!CAP_LOOKUP_KINDS.has(kind)) {
    throw new WorkerHttpError(400, 'CAP lookup kind must be name, ontology, or marker');
  }
  const term = assertCapTerm(
    body.term,
    kind === 'marker' ? CAP_MARKER_TERM_MAX_CODE_POINTS : CAP_TERM_MAX_CODE_POINTS
  );
  const limit = body.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CAP_LOOKUP_LIMIT_MAX) {
    throw new WorkerHttpError(400, `CAP lookup limit must be a safe integer from 1 to ${CAP_LOOKUP_LIMIT_MAX}`);
  }
  const document = await executeCapPersistedQuery(
    'LookupCells',
    CAP_LOOKUP_APQ_HASH,
    { options: { limit }, search: capLookupSearch(kind, term) },
    scope
  );
  return capGatewayResponse(projectCapLookupResults(document, limit), corsHeaders);
}

// ---------------------------------------------------------------------------
// The repository proxy (`/api/repos/*`).
// ---------------------------------------------------------------------------

function decodeCanonicalPathSegment(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new WorkerHttpError(400, `${label} path segment is missing`);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch (cause) {
    throw new WorkerHttpError(400, `${label} path segment is invalid`, { cause });
  }
  if (!decoded || encodeURIComponent(decoded) !== value) {
    throw new WorkerHttpError(400, `${label} path segment is not canonically encoded`);
  }
  return decoded;
}

function decodeBranchSegments(segments, label) {
  const branch = segments.map(segment => decodeCanonicalPathSegment(segment, label)).join('/');
  if (!isCanonicalGitHubBranch(branch)) {
    throw new WorkerHttpError(400, `${label} is invalid`);
  }
  return branch;
}

function requireProxyMethod(method, allowed, label) {
  if (!allowed.includes(method)) {
    throw new WorkerHttpError(405, `${label} supports only ${allowed.join(' or ')}`);
  }
}

function assertPullHead(value, label) {
  if (typeof value !== 'string') {
    throw new WorkerHttpError(400, `${label} must be a string`);
  }
  const colon = value.indexOf(':');
  if (colon < 1 || colon !== value.lastIndexOf(':')) {
    throw new WorkerHttpError(400, `${label} must equal owner:branch`);
  }
  const owner = value.slice(0, colon);
  const branch = value.slice(colon + 1);
  if (!isCanonicalGitHubAccount(owner) || !isCanonicalGitHubBranch(branch)) {
    throw new WorkerHttpError(400, `${label} must equal owner:branch`);
  }
  return { owner, branch };
}

function assertGitHubSha(value, label, status = 400) {
  if (typeof value !== 'string' || !GITHUB_SHA.test(value)) {
    throw new WorkerHttpError(status, `${label} must be exactly 40 lowercase hexadecimal characters`);
  }
  return value;
}

/**
 * The repository operation a proxied path and method name, with what its
 * checks need. Anything else is refused before GitHub is asked.
 */
function parseProxyRoute(githubUrl, method) {
  const segments = githubUrl.pathname.split('/').slice(1);
  if (segments.length < 3 || segments[0] !== 'repos') {
    throw new WorkerHttpError(404, 'GitHub API proxy supports only exact repository operations');
  }
  const owner = decodeCanonicalPathSegment(segments[1], 'Repository owner');
  const repo = decodeCanonicalPathSegment(segments[2], 'Repository name');
  if (!isCanonicalGitHubRepositoryFullName(`${owner}/${repo}`)) {
    throw new WorkerHttpError(400, 'GitHub repository path must contain an exact owner/repository name');
  }
  const rest = segments.slice(3);
  const route = (kind, extra = {}) => ({ kind, owner, repo, ...extra });

  if (rest.length === 0) {
    requireProxyMethod(method, ['GET'], 'Repository metadata');
    if (githubUrl.search === '') return route('repository-metadata');
    const query = assertExactQuery(githubUrl, { fork_identity: true }, 'Repository fork identity');
    if (query.fork_identity !== '1') {
      throw new WorkerHttpError(400, 'Repository fork identity must equal 1');
    }
    return route('repository-fork-identity', { stripQuery: true });
  }

  if (rest[0] === 'contents' && rest.length >= 2) {
    requireProxyMethod(method, ['GET', 'PUT'], 'Repository contents');
    const path = rest
      .slice(1)
      .map(segment => decodeCanonicalPathSegment(segment, 'Repository content'))
      .join('/');
    const userFile = GITHUB_USER_FILE.exec(path);
    const userFileId = userFile === null ? null : Number(userFile[1]);
    if (userFileId !== null && !Number.isSafeInteger(userFileId)) {
      throw new WorkerHttpError(400, 'Annotation user file id must be a safe integer');
    }
    const isReadOnlySchema = GITHUB_READ_ONLY_SCHEMA_FILES.has(path);
    if (userFileId === null && !GITHUB_MUTABLE_DOCUMENTS.has(path) && !isReadOnlySchema) {
      throw new WorkerHttpError(404, 'GitHub contents proxy supports only current annotation documents and schemas');
    }
    if (method === 'GET') {
      const query = assertExactQuery(githubUrl, { ref: true }, 'Repository contents');
      if (!isCanonicalGitHubBranch(query.ref)) {
        throw new WorkerHttpError(400, 'Repository contents ref must be an exact branch');
      }
      return route('contents-get', { streamed: true });
    }
    if (isReadOnlySchema) {
      throw new WorkerHttpError(405, 'Annotation schemas are read-only through the GitHub proxy');
    }
    assertNoQuery(githubUrl, 'Repository contents mutation');
    return route('contents-put', { userFileId });
  }

  if (rest[0] === 'git' && (rest[1] === 'trees' || rest[1] === 'blobs') && rest.length === 3) {
    const label = rest[1] === 'trees' ? 'Git tree' : 'Git blob';
    requireProxyMethod(method, ['GET'], label);
    const sha = decodeCanonicalPathSegment(rest[2], `${label} SHA`);
    assertGitHubSha(sha, `${label} SHA`);
    assertNoQuery(githubUrl, label);
    return route(rest[1] === 'trees' ? 'git-tree-get' : 'git-blob-get', { streamed: true });
  }

  if (rest[0] === 'git' && rest[1] === 'ref' && rest[2] === 'heads' && rest.length >= 4) {
    requireProxyMethod(method, ['GET'], 'Git branch reference');
    decodeBranchSegments(rest.slice(3), 'Git branch reference');
    assertNoQuery(githubUrl, 'Git branch reference');
    return route('git-ref-get');
  }

  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2) {
    requireProxyMethod(method, ['POST'], 'Git branch creation');
    assertNoQuery(githubUrl, 'Git branch creation');
    return route('git-refs-post');
  }

  if (rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && rest.length >= 4) {
    requireProxyMethod(method, ['PATCH'], 'Git branch update');
    const branch = decodeBranchSegments(rest.slice(3), 'Git branch update reference');
    assertNoQuery(githubUrl, 'Git branch update');
    return route('git-ref-patch', { branch });
  }

  if (rest.length === 1 && rest[0] === 'forks') {
    // Listing only: a contributor forks on GitHub; Cellucid never creates a
    // fork (that needs the app's Administration permission, which it does not ask for).
    requireProxyMethod(method, ['GET'], 'Repository forks');
    const query = assertExactQuery(githubUrl, { sort: true, per_page: true, page: true }, 'Repository forks');
    if (query.sort !== 'newest') {
      throw new WorkerHttpError(400, 'Repository forks sort must equal newest');
    }
    if (query.per_page !== `${GITHUB_PAGE_SIZE}`) {
      throw new WorkerHttpError(400, `Repository forks per_page must equal ${GITHUB_PAGE_SIZE}`);
    }
    assertPositiveInteger(query.page, 'Repository forks page');
    return route('forks-get');
  }

  if (rest.length === 1 && rest[0] === 'pulls') {
    requireProxyMethod(method, ['GET', 'POST'], 'Repository Pull Requests');
    if (method === 'GET') {
      const query = assertExactQuery(
        githubUrl,
        { state: true, head: true, base: true, per_page: true },
        'Pull Request lookup'
      );
      if (query.state !== 'open') {
        throw new WorkerHttpError(400, 'Pull Request lookup state must equal open');
      }
      assertPullHead(query.head, 'Pull Request lookup head');
      if (!isCanonicalGitHubBranch(query.base)) {
        throw new WorkerHttpError(400, 'Pull Request lookup base must be an exact branch');
      }
      if (query.per_page !== `${GITHUB_PAGE_SIZE}`) {
        throw new WorkerHttpError(400, `Pull Request lookup per_page must equal ${GITHUB_PAGE_SIZE}`);
      }
      return route('pulls-get');
    }
    assertNoQuery(githubUrl, 'Pull Request creation');
    return route('pulls-post');
  }

  throw new WorkerHttpError(404, 'GitHub API proxy does not expose this repository operation');
}

function createOperationOutcomeHeaders(operationId, outcome) {
  const headers = new Headers({ [OPERATION_OUTCOME_HEADER]: outcome });
  if (operationId !== null) headers.set(OPERATION_ID_HEADER, operationId);
  return headers;
}

/**
 * A mutation's identity and outcome: `applied` (GitHub accepted it),
 * `not-applied` (it never reached GitHub, or GitHub refused it), `unknown`
 * (it reached GitHub and no answer says what happened). Reads must carry no
 * operation header.
 */
function createMutationContext(request, kind) {
  const suppliedOperationId = request.headers.get(OPERATION_ID_HEADER);
  const suppliedOutcome = request.headers.get(OPERATION_OUTCOME_HEADER);
  if (!GITHUB_MUTATION_KINDS.has(kind)) {
    assertNoOperationHeaders(request);
    return null;
  }
  if (suppliedOutcome !== null) {
    const operationId =
      suppliedOperationId !== null && OPERATION_ID.test(suppliedOperationId)
        ? suppliedOperationId
        : null;
    throw new WorkerHttpError(400, `${OPERATION_OUTCOME_HEADER} is response-only`, {
      headers: createOperationOutcomeHeaders(operationId, 'not-applied'),
    });
  }
  if (suppliedOperationId === null || !OPERATION_ID.test(suppliedOperationId)) {
    throw new WorkerHttpError(400, `${OPERATION_ID_HEADER} must be one canonical lowercase UUIDv4`, {
      headers: createOperationOutcomeHeaders(null, 'not-applied'),
    });
  }
  let forwarded = false;
  return {
    markForwarded() {
      forwarded = true;
    },
    responseHeaders(outcome) {
      return createOperationOutcomeHeaders(suppliedOperationId, outcome);
    },
    decorateError(error, additionalHeaders = null) {
      const responseHeaders = mergeHeaders(
        error?.responseHeaders,
        additionalHeaders,
        createOperationOutcomeHeaders(suppliedOperationId, forwarded ? 'unknown' : 'not-applied')
      );
      if (error && typeof error === 'object') {
        error.responseHeaders = responseHeaders;
        return error;
      }
      return new WorkerHttpError(500, 'Internal worker error', { headers: responseHeaders, cause: error });
    },
  };
}

function assertCanonicalBase64(value, label) {
  let decodedBytes = -1;
  if (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length % 4 === 0 &&
    !ASCII_WHITESPACE.test(value) &&
    CANONICAL_BASE64_LAST_QUANTUM.test(value.slice(-4))
  ) {
    try {
      decodedBytes = bytesOfBase64(value).length;
    } catch {
      decodedBytes = -1;
    }
  }
  if (decodedBytes < 0) {
    throw new WorkerHttpError(400, `${label} must be canonical base64`);
  }
  if (decodedBytes > ANNOTATION_FILE_MAX_UTF8_BYTES) {
    throw new WorkerHttpError(413, `${label} exceeds ${ANNOTATION_FILE_MAX_UTF8_BYTES} decoded bytes`);
  }
  return value;
}

function refuseBinding(message) {
  throw new WorkerHttpError(403, message);
}

function sameLogin(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

/** Whether `branch` is one of the caller's own contribution branches. */
function isCallerBranch(branch, caller) {
  const prefix = `${ANNOTATION_BRANCH_ROOT}ghid_${caller.id}/`;
  return branch.startsWith(prefix) && branch.length > prefix.length;
}

function requireCallerBranch(branch, caller, label) {
  if (!isCallerBranch(branch, caller)) {
    refuseBinding(
      `${label} ${branch} is not a branch of the signed-in user ` +
        `(${ANNOTATION_BRANCH_ROOT}ghid_${caller.id}/...)`
    );
  }
}

function requireCallerRepository(route, caller, label) {
  if (!sameLogin(route.owner, caller.login)) {
    refuseBinding(`${label} is allowed only in a repository of the signed-in user (${caller.login})`);
  }
}

/**
 * Check a mutation body and return what is forwarded (re-serialized from the
 * checked values) and, when the mutation is bound to its caller, the check
 * the caller must pass:
 * - a user file `annotations/users/ghid_<n>.json` is written only by user n;
 * - a branch under `cellucid-annotations/` is written, created or moved only
 *   as the caller's own `cellucid-annotations/ghid_<id>/...`, and created or
 *   moved only in the caller's own repository;
 * - a Pull Request is opened only from the caller's own such branch.
 */
function checkMutationBody(route, document) {
  if (route.kind === 'contents-put') {
    const body = assertFields(document, ['message', 'content', 'branch'], ['sha'], 'Repository contents mutation');
    const forward = {
      message: assertExactString(body.message, 'Repository contents message'),
      content: assertCanonicalBase64(body.content, 'Repository contents content'),
      branch: body.branch,
    };
    if (!isCanonicalGitHubBranch(body.branch)) {
      throw new WorkerHttpError(400, 'Repository contents branch must be an exact branch');
    }
    if (Object.hasOwn(body, 'sha')) forward.sha = assertGitHubSha(body.sha, 'Repository contents sha');
    const bindsUserFile = route.userFileId !== null;
    const bindsBranch = body.branch.startsWith(ANNOTATION_BRANCH_ROOT);
    return {
      forward,
      bind: bindsUserFile || bindsBranch
        ? (caller) => {
            if (bindsUserFile && route.userFileId !== caller.id) {
              refuseBinding(
                `The signed-in user may write only annotations/users/ghid_${caller.id}.json`
              );
            }
            if (bindsBranch) requireCallerBranch(body.branch, caller, 'Repository contents branch');
          }
        : null,
    };
  }
  if (route.kind === 'git-refs-post') {
    assertExactFields(document, ['ref', 'sha'], 'Git branch creation request');
    const ref = document.ref;
    if (
      typeof ref !== 'string' ||
      !ref.startsWith('refs/heads/') ||
      !isCanonicalGitHubBranch(ref.slice('refs/heads/'.length))
    ) {
      throw new WorkerHttpError(400, 'Git branch creation ref must equal refs/heads/<exact branch>');
    }
    const branch = ref.slice('refs/heads/'.length);
    return {
      forward: { ref, sha: assertGitHubSha(document.sha, 'Git branch creation sha') },
      bind(caller) {
        requireCallerBranch(branch, caller, 'Git branch creation');
        requireCallerRepository(route, caller, 'Git branch creation');
      },
    };
  }
  if (route.kind === 'git-ref-patch') {
    assertExactFields(document, ['sha', 'force'], 'Git branch update request');
    if (document.force !== true) {
      throw new WorkerHttpError(400, 'Git branch update force must equal true');
    }
    return {
      forward: { sha: assertGitHubSha(document.sha, 'Git branch update sha'), force: true },
      bind(caller) {
        requireCallerBranch(route.branch, caller, 'Git branch update');
        requireCallerRepository(route, caller, 'Git branch update');
      },
    };
  }
  if (route.kind === 'pulls-post') {
    assertExactFields(
      document,
      ['title', 'head', 'base', 'body', 'maintainer_can_modify'],
      'Pull Request creation request'
    );
    const head = assertPullHead(document.head, 'Pull Request head');
    if (!isCanonicalGitHubBranch(document.base)) {
      throw new WorkerHttpError(400, 'Pull Request base must be an exact branch');
    }
    if (document.maintainer_can_modify !== true) {
      throw new WorkerHttpError(400, 'Pull Request maintainer_can_modify must equal true');
    }
    return {
      forward: {
        title: assertExactString(document.title, 'Pull Request title'),
        head: document.head,
        base: document.base,
        body: assertExactString(document.body, 'Pull Request body'),
        maintainer_can_modify: true,
      },
      bind(caller) {
        if (!sameLogin(head.owner, caller.login)) {
          refuseBinding(`Pull Request head must be a branch of the signed-in user (${caller.login})`);
        }
        requireCallerBranch(head.branch, caller, 'Pull Request head');
      },
    };
  }
  throw new WorkerHttpError(400, 'This GitHub proxy route does not accept a mutation body');
}

/**
 * Who calls: one `GET /user` with the caller's own token. Its GitHub headers
 * (the request budget it spent) go with whatever the mutation answers.
 */
async function resolveCaller(token, scope) {
  const response = await githubGet('/user', token, scope);
  const headers = relayedGitHubHeaders(response);
  // The user resource's tag says nothing about the mutation.
  headers.delete('ETag');
  try {
    if (!response.ok) {
      const message = await upstreamErrorMessage(response, 'GitHub user lookup', scope);
      throw new WorkerHttpError(
        response.status,
        `The signed-in GitHub user could not be identified: ${message}`
      );
    }
    return {
      caller: projectUser(await readUpstreamJson(response, 'GitHub user response', scope)),
      headers,
    };
  } catch (error) {
    if (error && typeof error === 'object') {
      error.responseHeaders = mergeHeaders(headers, error.responseHeaders);
    }
    throw error;
  }
}

function assertUpstreamRecord(value, label) {
  if (!isRecord(value)) throw new WorkerHttpError(502, `${label} must be a JSON object`);
  return value;
}

function assertUpstreamBoolean(value, label) {
  if (typeof value !== 'boolean') throw new WorkerHttpError(502, `${label} must be boolean`);
  return value;
}

function assertUpstreamPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WorkerHttpError(502, `${label} must be a positive safe integer`);
  }
  return value;
}

function assertUpstreamHttpsUrl(value, label) {
  assertExactString(value, label, 502);
  let parsed;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new WorkerHttpError(502, `${label} must be an exact HTTPS URL`, { cause });
  }
  if (parsed.protocol !== 'https:' || parsed.toString() !== value) {
    throw new WorkerHttpError(502, `${label} must be an exact HTTPS URL`);
  }
  return value;
}

function projectRepositoryMetadata(document) {
  const repository = assertUpstreamRecord(document, 'GitHub repository response');
  if (!isCanonicalGitHubRepositoryFullName(repository.full_name)) {
    throw new WorkerHttpError(502, 'GitHub repository response.full_name must be canonical');
  }
  if (!isCanonicalGitHubBranch(repository.default_branch)) {
    throw new WorkerHttpError(502, 'GitHub repository response.default_branch must be an exact branch');
  }
  const permissions = assertUpstreamRecord(repository.permissions, 'GitHub repository response.permissions');
  const permission = name =>
    assertUpstreamBoolean(permissions[name], `GitHub repository response.permissions.${name}`);
  return {
    full_name: repository.full_name,
    default_branch: repository.default_branch,
    private: assertUpstreamBoolean(repository.private, 'GitHub repository response.private'),
    allow_forking: assertUpstreamBoolean(repository.allow_forking, 'GitHub repository response.allow_forking'),
    permissions: {
      pull: permission('pull'),
      triage: permission('triage'),
      push: permission('push'),
      maintain: permission('maintain'),
      admin: permission('admin'),
    },
  };
}

function projectRepositoryForkIdentity(document) {
  const repository = assertUpstreamRecord(document, 'GitHub fork identity response');
  if (!isCanonicalGitHubRepositoryFullName(repository.full_name)) {
    throw new WorkerHttpError(502, 'GitHub fork identity response.full_name must be canonical');
  }
  const isFork = assertUpstreamBoolean(repository.fork, 'GitHub fork identity response.fork');
  if (!isFork) {
    if (repository.parent !== undefined && repository.parent !== null) {
      throw new WorkerHttpError(502, 'GitHub non-fork identity response.parent must be absent or null');
    }
    return { full_name: repository.full_name, fork: false, parent: null };
  }
  const parent = assertUpstreamRecord(repository.parent, 'GitHub fork identity response.parent');
  if (!isCanonicalGitHubRepositoryFullName(parent.full_name)) {
    throw new WorkerHttpError(502, 'GitHub fork identity response.parent.full_name must be canonical');
  }
  return { full_name: repository.full_name, fork: true, parent: { full_name: parent.full_name } };
}

function projectContentPut(document) {
  const response = assertUpstreamRecord(document, 'GitHub contents mutation response');
  const content = assertUpstreamRecord(response.content, 'GitHub contents mutation response.content');
  return {
    content: {
      sha: assertGitHubSha(content.sha, 'GitHub contents mutation response.content.sha', 502),
    },
  };
}

function projectGitRef(document) {
  const response = assertUpstreamRecord(document, 'GitHub branch reference response');
  const object = assertUpstreamRecord(response.object, 'GitHub branch reference response.object');
  return {
    object: {
      sha: assertGitHubSha(object.sha, 'GitHub branch reference response.object.sha', 502),
    },
  };
}

function projectForkRecord(document, label) {
  const fork = assertUpstreamRecord(document, label);
  if (!isCanonicalGitHubRepositoryFullName(fork.full_name)) {
    throw new WorkerHttpError(502, `${label}.full_name must be canonical`);
  }
  if (!isCanonicalGitHubRepositoryName(fork.name)) {
    throw new WorkerHttpError(502, `${label}.name must be canonical`);
  }
  const owner = assertUpstreamRecord(fork.owner, `${label}.owner`);
  if (!isCanonicalGitHubAccount(owner.login)) {
    throw new WorkerHttpError(502, `${label}.owner.login must be canonical`);
  }
  if (fork.full_name.toLowerCase() !== `${owner.login}/${fork.name}`.toLowerCase()) {
    throw new WorkerHttpError(502, `${label} identity fields disagree`);
  }
  return {
    full_name: fork.full_name,
    name: fork.name,
    owner: { login: owner.login },
  };
}

function projectPage(document, label, projectItem) {
  if (!Array.isArray(document)) {
    throw new WorkerHttpError(502, `${label} response must be an array`);
  }
  if (document.length > GITHUB_PAGE_SIZE) {
    throw new WorkerHttpError(502, `${label} response exceeds ${GITHUB_PAGE_SIZE} entries`);
  }
  return document.map(projectItem);
}

function projectPullRequest(document, label) {
  const pullRequest = assertUpstreamRecord(document, label);
  return {
    number: assertUpstreamPositiveInteger(pullRequest.number, `${label}.number`),
    html_url: assertUpstreamHttpsUrl(pullRequest.html_url, `${label}.html_url`),
  };
}

function projectGitHubProxyResponse(kind, document) {
  switch (kind) {
    case 'repository-metadata':
      return projectRepositoryMetadata(document);
    case 'repository-fork-identity':
      return projectRepositoryForkIdentity(document);
    case 'contents-put':
      return projectContentPut(document);
    case 'git-ref-get':
    case 'git-ref-patch':
      return projectGitRef(document);
    case 'git-refs-post':
      assertUpstreamRecord(document, 'Git branch creation response');
      return {};
    case 'forks-get':
      return projectPage(document, 'GitHub forks', (fork, index) => projectForkRecord(fork, `GitHub fork ${index}`));
    case 'pulls-get':
      return projectPage(document, 'GitHub Pull Request lookup', (pull, index) =>
        projectPullRequest(pull, `GitHub Pull Request ${index}`));
    case 'pulls-post':
      return projectPullRequest(document, 'GitHub Pull Request creation response');
    default:
      throw new WorkerHttpError(500, 'Unknown GitHub proxy response contract');
  }
}

async function handleApiProxy(request, url, corsHeaders, scope) {
  const githubPath = url.pathname.slice('/api'.length);
  if (!githubPath.startsWith('/repos/')) {
    throw new WorkerHttpError(404, 'GitHub API proxy supports only /api/repos/*');
  }
  const githubUrl = new URL(githubPath, GITHUB_API_ORIGIN);
  githubUrl.search = url.search;
  if (githubUrl.origin !== GITHUB_API_ORIGIN || !githubUrl.pathname.startsWith('/repos/')) {
    throw new WorkerHttpError(400, 'Invalid GitHub repository API path');
  }
  const method = request.method;
  let route;
  try {
    route = parseProxyRoute(githubUrl, method);
  } catch (error) {
    // A refused write never reached GitHub: say so, as for any other refusal.
    if (method !== 'GET' && error && typeof error === 'object') {
      const operationId = request.headers.get(OPERATION_ID_HEADER);
      error.responseHeaders = mergeHeaders(
        error.responseHeaders,
        createOperationOutcomeHeaders(
          operationId !== null && OPERATION_ID.test(operationId) ? operationId : null,
          'not-applied'
        )
      );
    }
    throw error;
  }
  if (route.stripQuery === true) githubUrl.search = '';
  const mutation = createMutationContext(request, route.kind);
  const label = `GitHub API ${method} ${githubPath}`;
  let relayed = null;

  try {
    const token = getBearerToken(request);
    const ifNoneMatch = readIfNoneMatch(request, { allowed: method === 'GET' });
    const headers = createGitHubHeaders(token);
    let body;
    if (method === 'GET') {
      if (ifNoneMatch !== null) headers.set('If-None-Match', ifNoneMatch);
    } else {
      const document = await readJsonRequestObject(request, 'GitHub API proxy request', scope);
      const { forward, bind } = checkMutationBody(route, document);
      if (bind !== null) {
        const resolved = await resolveCaller(token, scope);
        relayed = resolved.headers;
        bind(resolved.caller);
      }
      body = JSON.stringify(forward);
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetchUpstream(githubUrl, { method, headers, body }, label, scope, mutation);
    relayed = relayedGitHubHeaders(response);
    const responseHeaders = mergeHeaders(corsHeaders, relayed);
    if (response.status === 304 && method === 'GET') {
      return notModifiedResponse(response, responseHeaders);
    }
    if (!response.ok) {
      const outcome = response.status === 408 || response.status >= 500 ? 'unknown' : 'not-applied';
      return jsonResponse(
        { error: await upstreamErrorMessage(response, label, scope) },
        response.status,
        mergeHeaders(responseHeaders, mutation?.responseHeaders(outcome))
      );
    }
    if (route.streamed === true) {
      return relayResponse(response, responseHeaders, scope);
    }
    const document = await readUpstreamJson(response, `${label} response`, scope);
    return jsonResponse(
      projectGitHubProxyResponse(route.kind, document),
      response.status,
      mergeHeaders(responseHeaders, mutation?.responseHeaders('applied'))
    );
  } catch (error) {
    if (mutation !== null) throw mutation.decorateError(error, relayed);
    if (error && typeof error === 'object') {
      error.responseHeaders = mergeHeaders(relayed, error.responseHeaders);
    }
    throw error;
  }
}
