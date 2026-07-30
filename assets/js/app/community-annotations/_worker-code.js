/**
 * Cloudflare Worker for Cellucid community-annotation GitHub OAuth and API access.
 *
 * This is the deployable worker source used by the self-hosting guide. It exposes
 * only the routes consumed by the current Cellucid browser client.
 */

import {
  ANNOTATION_FILE_MAX_UTF8_BYTES,
  parseExactJson,
} from './wire-contract.js';
import {
  isCanonicalGitHubAccount,
  isCanonicalGitHubBranch,
  isCanonicalGitHubRepositoryFullName,
  isCanonicalGitHubRepositoryName,
} from './github-reference.js';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const CAP_GRAPHQL_URL = 'https://celltype.info/graphql';
const WORKER_CONTRACT_VERSION = 1;
const GITHUB_API_VERSION = '2026-03-10';
const GITHUB_PAGE_SIZE = 100;
const GITHUB_COLLECTION_MAX_ITEMS = 10_000;
const GITHUB_COLLECTION_CONCURRENCY = 6;
const WORKER_REQUEST_DEADLINE_MS = 15_000;
const WORKER_REQUEST_BODY_MAX_BYTES = 1_400_000;
const CAP_REQUEST_BODY_MAX_BYTES = 4 * 1024;
const CAP_RESPONSE_BODY_MAX_BYTES = 8 * 1024 * 1024;
const CAP_OUTPUT_BODY_MAX_BYTES = 8 * 1024 * 1024;
const CAP_LOOKUP_LIMIT_MAX = 25;
const CAP_DATASET_LIMIT_MAX = 10;
const CAP_PREFLIGHT_MAX_AGE_SECONDS = 600;
const CAP_TERM_MAX_CODE_POINTS = 256;
const CAP_MARKER_TERM_MAX_CODE_POINTS = (50 * 64) + 49;
const CAP_ID_MAX_CODE_POINTS = 64;
const CAP_TEXT_MAX_CODE_POINTS = 512;
const CAP_GENE_MAX_CODE_POINTS = 64;
const CAP_SYNONYM_MAX_ITEMS = 100;
const CAP_MARKER_MAX_ITEMS = 200;
const GITHUB_STANDARD_RESPONSE_BODY_MAX_BYTES = 1_500_000;
const GITHUB_COLLECTION_PAGE_MAX_BYTES = 1_500_000;
const GITHUB_CONTENT_RESPONSE_MAX_BYTES = 1_500_000;
const GITHUB_TREE_RESPONSE_MAX_BYTES = 7_500_000;
const CAP_LOOKUP_APQ_HASH =
  '7669f4698d1243244b365018dc60a69b61969791659814e0b4ad1b65385ddaab';
const CAP_DATASET_APQ_HASH =
  '84226dc93685478baaabbc0687bb8c85fd24ea280c9d1db957d332dc8a9bff57';
const OPERATION_ID_HEADER = 'X-Cellucid-Operation-Id';
const OPERATION_OUTCOME_HEADER = 'X-Cellucid-Operation-Outcome';
const OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GITHUB_MUTATION_KINDS = new Set([
  'contents-put',
  'git-refs-post',
  'forks-post',
  'pulls-post',
]);
const CAP_LOOKUP_KINDS = new Set([
  'name',
  'ontology',
  'marker',
  'feedback',
]);
const CAP_ONTOLOGY_LOOKUP_FIELDS = Object.freeze(['ontologyTermId']);
const CAP_MARKER_LOOKUP_FIELDS = Object.freeze([
  'markerGenes',
  'canonicalMarkerGenes',
]);
const GITHUB_SHA = /^[0-9a-f]{40}$/;
const GITHUB_USER_FILE =
  /^annotations\/users\/ghid_[1-9][0-9]*\.json$/;
const GITHUB_READ_ONLY_SCHEMA_FILES = new Set([
  'annotations/schema.json',
  'annotations/config.schema.json',
  'annotations/moderation/merges.schema.json',
]);

const OAUTH_OWNER_COOKIE_PREFIX = 'cellucid_gh_oauth_owner_';
const OAUTH_COOKIE_MAX_AGE_S = 10 * 60;
const OAUTH_COOKIE_MAX_SERIALIZED_BYTES = 4096;
const OAUTH_RANDOM_HEX_256 = /^[0-9a-f]{64}$/;

const APP_AUTH_FLAG_PARAM = 'cellucid_github_auth';
const APP_AUTH_TOKEN_PARAM = 'cellucid_github_token';
const APP_AUTH_ERROR_PARAM = 'cellucid_github_error';

const ALLOWED_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'OPTIONS',
]);
const ALLOWED_REQUEST_HEADERS = new Set([
  'authorization',
  'content-type',
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
const EXPOSED_RESPONSE_HEADERS = Object.freeze([
  'Retry-After',
  OPERATION_ID_HEADER,
  OPERATION_OUTCOME_HEADER,
  'X-GitHub-Request-Id',
  'X-RateLimit-Reset',
]);

class WorkerHttpError extends Error {
  constructor(status, message, { headers = null, cause = null } = {}) {
    super(message);
    this.name = 'WorkerHttpError';
    this.status = status;
    this.responseHeaders = headers;
    this.cause = cause;
  }
}

function createWorkerRequestScope(request) {
  if (
    typeof AbortController !== 'function' ||
    !(request?.signal instanceof AbortSignal)
  ) {
    throw new WorkerHttpError(
      500,
      'AbortController and Request signals are required by the GitHub worker'
    );
  }

  const controller = new AbortController();
  let firstCause = null;
  let firstReason = null;
  let closed = false;
  let closeRequested = false;
  let deferredCloseCount = 0;

  const abort = (cause, reason = null) => {
    if (closed || firstCause !== null) return;
    firstCause = cause;
    firstReason = reason;
    controller.abort(reason);
  };
  const onCallerAbort = () => {
    abort('caller', request.signal.reason);
  };

  request.signal.addEventListener('abort', onCallerAbort, { once: true });
  if (request.signal.aborted) onCallerAbort();

  let deadline = null;
  try {
    deadline = setTimeout(
      () => abort('timeout'),
      WORKER_REQUEST_DEADLINE_MS
    );
  } catch (cause) {
    request.signal.removeEventListener('abort', onCallerAbort);
    throw new WorkerHttpError(
      500,
      'Worker request deadline could not be created',
      { cause }
    );
  }

  const createAbortError = () => {
    if (firstCause === 'caller') {
      return new WorkerHttpError(
        499,
        'Worker request was cancelled',
        { cause: firstReason }
      );
    }
    if (firstCause === 'timeout') {
      return new WorkerHttpError(
        504,
        `Worker request timed out after ${WORKER_REQUEST_DEADLINE_MS}ms`
      );
    }
    if (firstCause === 'internal') {
      return new WorkerHttpError(
        502,
        'Worker request stopped after an internal upstream failure',
        { cause: firstReason }
      );
    }
    return null;
  };

  const finishClose = () => {
    if (closed || !closeRequested || deferredCloseCount !== 0) return;
    closed = true;
    clearTimeout(deadline);
    request.signal.removeEventListener('abort', onCallerAbort);
  };

  return {
    signal: controller.signal,
    createAbortError,
    throwIfAborted() {
      const error = createAbortError();
      if (error !== null) throw error;
    },
    cancelInternal(reason) {
      abort('internal', reason);
    },
    deferClose() {
      if (closed || closeRequested) {
        throw new WorkerHttpError(
          500,
          'Worker request ownership is already closed'
        );
      }
      deferredCloseCount += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        deferredCloseCount -= 1;
        finishClose();
      };
    },
    close() {
      if (closed || closeRequested) return;
      closeRequested = true;
      finishClose();
    },
  };
}

function awaitWithinWorkerRequestScope(promise, requestScope) {
  requestScope.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      requestScope.signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      settle(
        reject,
        requestScope.createAbortError() ??
          new WorkerHttpError(502, 'Worker request was interrupted')
      );
    };

    requestScope.signal.addEventListener('abort', onAbort, { once: true });
    if (requestScope.signal.aborted) {
      onAbort();
    }
    Promise.resolve(promise).then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error)
    );
  });
}

async function readBoundedUtf8Body(
  source,
  label,
  {
    maxBytes,
    readErrorStatus,
    tooLargeStatus,
    requestScope,
  }
) {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(readErrorStatus) ||
    !Number.isSafeInteger(tooLargeStatus)
  ) {
    throw new WorkerHttpError(500, 'Invalid Worker body-read contract');
  }
  if (
    typeof TextDecoder !== 'function' ||
    typeof TextEncoder !== 'function'
  ) {
    throw new WorkerHttpError(
      500,
      'UTF-8 encoding support is required by the GitHub worker'
    );
  }

  requestScope.throwIfAborted();
  const body = source?.body;
  if (!body || typeof body.getReader !== 'function') {
    if (typeof source?.text !== 'function') {
      throw new WorkerHttpError(
        readErrorStatus,
        `${label} body could not be read`
      );
    }
    let text;
    try {
      text = await awaitWithinWorkerRequestScope(
        source.text(),
        requestScope
      );
    } catch (cause) {
      if (cause instanceof WorkerHttpError) throw cause;
      const ownedAbort = requestScope.createAbortError();
      if (ownedAbort !== null) throw ownedAbort;
      throw new WorkerHttpError(
        readErrorStatus,
        `${label} body could not be read`,
        { cause }
      );
    }
    requestScope.throwIfAborted();
    if (typeof text !== 'string') {
      throw new WorkerHttpError(
        readErrorStatus,
        `${label} body could not be read`
      );
    }
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new WorkerHttpError(
        tooLargeStatus,
        `${label} body exceeds ${maxBytes} bytes`
      );
    }
    return text;
  }

  const reader = body.getReader();
  // Preserve a UTF-8 BOM so the exact JSON parser rejects it instead of
  // silently accepting an alternate wire representation.
  const decoder = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  });
  const textParts = [];
  let totalBytes = 0;
  let complete = false;
  try {
    while (true) {
      const result = await awaitWithinWorkerRequestScope(
        reader.read(),
        requestScope
      );
      requestScope.throwIfAborted();
      if (
        !result ||
        typeof result !== 'object' ||
        typeof result.done !== 'boolean'
      ) {
        throw new WorkerHttpError(
          readErrorStatus,
          `${label} body could not be read`
        );
      }
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw new WorkerHttpError(
          readErrorStatus,
          `${label} body could not be read`
        );
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        throw new WorkerHttpError(
          tooLargeStatus,
          `${label} body exceeds ${maxBytes} bytes`
        );
      }
      try {
        textParts.push(decoder.decode(result.value, { stream: true }));
      } catch (cause) {
        throw new WorkerHttpError(
          readErrorStatus,
          `${label} body contains invalid UTF-8`,
          { cause }
        );
      }
    }
    try {
      textParts.push(decoder.decode());
    } catch (cause) {
      throw new WorkerHttpError(
        readErrorStatus,
        `${label} body contains invalid UTF-8`,
        { cause }
      );
    }
    requestScope.throwIfAborted();
    complete = true;
    return textParts.join('');
  } catch (cause) {
    if (cause instanceof WorkerHttpError) throw cause;
    const ownedAbort = requestScope.createAbortError();
    if (ownedAbort !== null) throw ownedAbort;
    throw new WorkerHttpError(
      readErrorStatus,
      `${label} body could not be read`,
      { cause }
    );
  } finally {
    if (!complete) {
      try {
        Promise.resolve(reader.cancel()).catch(() => {});
      } catch {
        // The primary body-read outcome owns error reporting.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // A pending platform read is already observed by the owned promise.
    }
  }
}

function parseCanonicalContentLength(response, label) {
  const raw = response?.headers?.get?.('Content-Length');
  if (raw === null || raw === undefined) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new WorkerHttpError(
      502,
      `${label} Content-Length is invalid`
    );
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) {
    throw new WorkerHttpError(
      502,
      `${label} Content-Length is invalid`
    );
  }
  return length;
}

function streamBoundedGitHubJsonResponse(
  response,
  label,
  { maxBytes, headers, requestScope }
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new WorkerHttpError(500, 'Invalid streamed response byte limit');
  }
  if (
    typeof ReadableStream !== 'function' ||
    typeof TextDecoder !== 'function'
  ) {
    throw new WorkerHttpError(
      500,
      'Streaming and UTF-8 decoding are required by the GitHub worker'
    );
  }

  requestScope.throwIfAborted();
  const contentLength = parseCanonicalContentLength(response, label);
  if (contentLength !== null && contentLength > maxBytes) {
    try {
      Promise.resolve(response?.body?.cancel?.()).catch(() => {});
    } catch {
      // The bounded-response error owns the public outcome.
    }
    throw new WorkerHttpError(
      502,
      `${label} body exceeds ${maxBytes} bytes`
    );
  }
  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') {
    throw new WorkerHttpError(
      502,
      `${label} body could not be streamed`
    );
  }

  let reader;
  try {
    reader = body.getReader();
  } catch (cause) {
    throw new WorkerHttpError(
      502,
      `${label} body could not be streamed`,
      { cause }
    );
  }
  const releaseRequestOwnership = requestScope.deferClose();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let downstreamController = null;
  let totalBytes = 0;
  let terminalStarted = false;
  let terminalPromise = null;

  const release = () => {
    requestScope.signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A pending read remains observed by awaitWithinWorkerRequestScope.
    }
    releaseRequestOwnership();
  };
  const cancelUpstream = (reason) => {
    if (terminalPromise !== null) return terminalPromise;
    terminalStarted = true;
    requestScope.signal.removeEventListener('abort', onAbort);
    let cancellation;
    try {
      cancellation = reader.cancel(reason);
    } catch (cause) {
      cancellation = Promise.reject(cause);
    }
    terminalPromise = Promise.resolve(cancellation)
      .catch(() => {})
      .finally(release);
    return terminalPromise;
  };
  const complete = () => {
    if (terminalStarted) return;
    terminalStarted = true;
    requestScope.signal.removeEventListener('abort', onAbort);
    release();
    terminalPromise = Promise.resolve();
  };
  const onAbort = () => {
    if (terminalStarted) return;
    const error =
      requestScope.createAbortError() ??
      new WorkerHttpError(502, 'Worker request was interrupted');
    try {
      downstreamController?.error(error);
    } catch {
      // Downstream cancellation may have already closed the controller.
    }
    void cancelUpstream(error);
  };

  const stream = new ReadableStream({
    start(controller) {
      downstreamController = controller;
      requestScope.signal.addEventListener('abort', onAbort, { once: true });
      if (requestScope.signal.aborted) onAbort();
    },
    async pull(controller) {
      if (terminalStarted) {
        if (terminalPromise !== null) await terminalPromise;
        return;
      }
      try {
        const result = await awaitWithinWorkerRequestScope(
          reader.read(),
          requestScope
        );
        requestScope.throwIfAborted();
        if (
          !result ||
          typeof result !== 'object' ||
          typeof result.done !== 'boolean'
        ) {
          throw new WorkerHttpError(
            502,
            `${label} body could not be streamed`
          );
        }
        if (result.done) {
          try {
            decoder.decode();
          } catch (cause) {
            throw new WorkerHttpError(
              502,
              `${label} body contains invalid UTF-8`,
              { cause }
            );
          }
          controller.close();
          complete();
          return;
        }
        if (!(result.value instanceof Uint8Array)) {
          throw new WorkerHttpError(
            502,
            `${label} body could not be streamed`
          );
        }
        totalBytes += result.value.byteLength;
        if (totalBytes > maxBytes) {
          throw new WorkerHttpError(
            502,
            `${label} body exceeds ${maxBytes} bytes`
          );
        }
        try {
          decoder.decode(result.value, { stream: true });
        } catch (cause) {
          throw new WorkerHttpError(
            502,
            `${label} body contains invalid UTF-8`,
            { cause }
          );
        }
        controller.enqueue(result.value);
      } catch (cause) {
        const error =
          cause instanceof WorkerHttpError
            ? cause
            : requestScope.createAbortError() ??
              new WorkerHttpError(
                502,
                `${label} body could not be streamed`,
                { cause }
              );
        if (!terminalStarted) {
          try {
            controller.error(error);
          } catch {
            // The downstream may already have cancelled the stream.
          }
          await cancelUpstream(error);
        } else if (terminalPromise !== null) {
          await terminalPromise;
        }
      }
    },
    cancel(reason) {
      return cancelUpstream(reason);
    },
  });

  return new Response(stream, {
    status: response.status,
    headers: mergeHeaders(headers, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    }),
  });
}

export default {
  async fetch(request, env) {
    let corsHeaders = new Headers();
    let requestScope = null;
    try {
      if (!(request instanceof Request)) {
        throw new WorkerHttpError(400, 'Worker request must be a Request');
      }
      const url = new URL(request.url);
      const allowedOrigins = validateWorkerEnvironment(env);
      const origin = request.headers.get('Origin');
      if (origin !== null && !allowedOrigins.has(origin)) {
        return jsonResponse(
          { error: `Origin is not allowed: ${origin}` },
          403
        );
      }
      const isCapLookup = url.pathname === '/cap/lookup-cells';
      const isCapDatasetSearch = url.pathname === '/cap/search-datasets';
      const isCapRoute = isCapLookup || isCapDatasetSearch;
      const isCapNamespace =
        url.pathname === '/cap' || url.pathname.startsWith('/cap/');
      if (isCapNamespace && !isCapRoute) {
        throw new WorkerHttpError(404, 'CAP route not found');
      }
      if (isCapRoute && origin === null) {
        throw new WorkerHttpError(403, 'CAP routes require an allowed Origin');
      }
      corsHeaders = createCorsHeaders(
        origin,
        isCapRoute
          ? {
              allowedMethods: CAP_ALLOWED_METHODS,
              allowedRequestHeaders: CAP_ALLOWED_REQUEST_HEADERS,
              exposedResponseHeaders: [],
            }
          : undefined
      );

      if (request.method === 'OPTIONS') {
        return handlePreflight(
          request,
          corsHeaders,
          isCapRoute
            ? {
                allowedMethods: CAP_ALLOWED_METHODS,
                allowedRequestHeaders: CAP_ALLOWED_REQUEST_HEADERS,
                maxAgeSeconds: CAP_PREFLIGHT_MAX_AGE_SECONDS,
              }
            : undefined
        );
      }
      if (isCapRoute) {
        requireMethod(request, 'POST');
        requestScope = createWorkerRequestScope(request);
        return isCapLookup
          ? await handleCapLookup(request, url, corsHeaders, requestScope)
          : await handleCapDatasetSearch(
              request,
              url,
              corsHeaders,
              requestScope
            );
      }
      if (!ALLOWED_METHODS.has(request.method)) {
        throw new WorkerHttpError(405, `Method is not allowed: ${request.method}`);
      }

      if (url.pathname === '/auth/login') {
        requireMethod(request, 'GET');
        return await handleLogin(url, env);
      }
      if (url.pathname === '/auth/callback') {
        requireMethod(request, 'GET');
        requestScope = createWorkerRequestScope(request);
        return await handleCallback(request, url, env, requestScope);
      }
      if (url.pathname === '/auth/user') {
        requireMethod(request, 'GET');
        requestScope = createWorkerRequestScope(request);
        return await handleGetUser(request, corsHeaders, requestScope);
      }
      if (url.pathname === '/auth/installations') {
        requireMethod(request, 'GET');
        requestScope = createWorkerRequestScope(request);
        return await handleGetInstallations(
          request,
          corsHeaders,
          requestScope
        );
      }
      if (url.pathname === '/auth/installation-repos') {
        requireMethod(request, 'POST');
        requestScope = createWorkerRequestScope(request);
        return await handleGetInstallationRepos(
          request,
          corsHeaders,
          requestScope
        );
      }
      if (url.pathname.startsWith('/api/')) {
        requestScope = createWorkerRequestScope(request);
        return await handleApiProxy(
          request,
          url,
          corsHeaders,
          requestScope
        );
      }
      if (url.pathname === '/') {
        requireMethod(request, 'GET');
        return jsonResponse(
          {
            status: 'ok',
            service: 'Cellucid GitHub Auth',
            contractVersion: WORKER_CONTRACT_VERSION,
            endpoints: [
              '/auth/login',
              '/auth/callback',
              '/auth/user',
              '/auth/installations',
              '/auth/installation-repos',
              '/cap/lookup-cells',
              '/cap/search-datasets',
              '/api/repos/*',
            ],
          },
          200,
          corsHeaders
        );
      }
      throw new WorkerHttpError(404, 'Route not found');
    } catch (error) {
      const status =
        error instanceof WorkerHttpError ? error.status : 500;
      const message =
        error instanceof WorkerHttpError
          ? error.message
          : 'Internal worker error';
      if (!(error instanceof WorkerHttpError)) {
        console.error('Cellucid GitHub worker error', {
          name: error?.name,
          message: error?.message,
        });
      }
      const headers = mergeHeaders(
        corsHeaders,
        error?.responseHeaders
      );
      return jsonResponse({ error: message }, status, headers);
    } finally {
      requestScope?.close();
    }
  },
};

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

function assertExactString(
  value,
  label,
  { max = 4096, status = 400 } = {}
) {
  if (
    typeof value !== 'string' ||
    !value ||
    /^\s|\s$/.test(value) ||
    exceedsCodePointLimit(value, max)
  ) {
    throw new WorkerHttpError(
      status,
      `${label} must be an exact nonblank string`
    );
  }
  return value;
}

function assertExactFields(value, fields, label, status = 400) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new WorkerHttpError(status, `${label} must be a JSON object`);
  }
  const keys = Object.keys(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  ) {
    throw new WorkerHttpError(
      status,
      `${label} must contain exactly ${fields.join(', ')}`
    );
  }
  return value;
}

function assertCanonicalGitHubAccount(value, label) {
  assertExactString(value, label, { max: 64, status: 502 });
  if (!isCanonicalGitHubAccount(value)) {
    throw new WorkerHttpError(
      502,
      `${label} is not a canonical GitHub account`
    );
  }
  return value;
}

function upstreamErrorMessage(document, label) {
  if (
    !document ||
    typeof document !== 'object' ||
    Array.isArray(document) ||
    !Object.hasOwn(document, 'message')
  ) {
    throw new WorkerHttpError(
      502,
      `${label} response must contain message`
    );
  }
  return assertExactString(document.message, `${label} response message`, {
    max: 4096,
    status: 502,
  });
}

function requireMethod(request, expected) {
  if (request.method !== expected) {
    throw new WorkerHttpError(
      405,
      `${request.url} requires ${expected}`
    );
  }
}

function requireEnvString(env, key, { max = 16384 } = {}) {
  const value = env?.[key];
  if (
    typeof value !== 'string' ||
    !value ||
    /^\s|\s$/.test(value) ||
    exceedsCodePointLimit(value, max)
  ) {
    throw new WorkerHttpError(500, `Missing or invalid worker secret: ${key}`);
  }
  return value;
}

function isLoopbackHostname(hostname) {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127\.[0-9]+\.[0-9]+\.[0-9]+$/.test(hostname)
  );
}

function parseAllowedOrigins(env) {
  const raw = requireEnvString(env, 'ALLOWED_ORIGINS');
  const entries = raw.split(',');
  if (!entries.length || entries.some((entry) => !entry)) {
    throw new WorkerHttpError(
      500,
      'ALLOWED_ORIGINS must be a comma-separated list of exact origins'
    );
  }
  const allowed = new Set();
  for (const entry of entries) {
    if (entry === '*') {
      throw new WorkerHttpError(500, 'ALLOWED_ORIGINS must not contain "*"');
    }
    let parsed;
    try {
      parsed = new URL(entry);
    } catch (cause) {
      throw new WorkerHttpError(
        500,
        `ALLOWED_ORIGINS contains an invalid URL: ${entry}`,
        { cause }
      );
    }
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      (
        parsed.protocol === 'http:' &&
        !isLoopbackHostname(parsed.hostname)
      ) ||
      parsed.username ||
      parsed.password ||
      entry !== parsed.origin
    ) {
      throw new WorkerHttpError(
        500,
        'ALLOWED_ORIGINS entries must be exact HTTPS origins or loopback ' +
        `HTTP development origins: ${entry}`
      );
    }
    if (allowed.has(entry)) {
      throw new WorkerHttpError(
        500,
        `ALLOWED_ORIGINS contains a duplicate origin: ${entry}`
      );
    }
    allowed.add(entry);
  }
  return allowed;
}

function validateWorkerEnvironment(env) {
  const allowedOrigins = parseAllowedOrigins(env);
  requireEnvString(env, 'GITHUB_CLIENT_ID', { max: 512 });
  requireEnvString(env, 'GITHUB_CLIENT_SECRET', { max: 4096 });
  return allowedOrigins;
}

function createCorsHeaders(
  origin,
  {
    allowedMethods = ALLOWED_METHODS,
    allowedRequestHeaders = ALLOWED_REQUEST_HEADERS,
    exposedResponseHeaders = EXPOSED_RESPONSE_HEADERS,
  } = {}
) {
  const headers = new Headers({
    'Access-Control-Allow-Methods': [...allowedMethods].join(', '),
    'Access-Control-Allow-Headers': [...allowedRequestHeaders].join(', '),
    'Vary': 'Origin',
  });
  if (exposedResponseHeaders.length !== 0) {
    headers.set(
      'Access-Control-Expose-Headers',
      exposedResponseHeaders.join(', ')
    );
  }
  if (origin !== null) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  return headers;
}

function handlePreflight(
  request,
  corsHeaders,
  {
    allowedMethods = ALLOWED_METHODS,
    allowedRequestHeaders = ALLOWED_REQUEST_HEADERS,
    maxAgeSeconds = null,
  } = {}
) {
  const requestedMethod = request.headers.get('Access-Control-Request-Method');
  if (
    requestedMethod === null ||
    !allowedMethods.has(requestedMethod) ||
    requestedMethod === 'OPTIONS'
  ) {
    throw new WorkerHttpError(400, 'Invalid CORS preflight method');
  }
  const rawHeaders =
    request.headers.get('Access-Control-Request-Headers') ?? '';
  const requestedHeaders = rawHeaders
    ? rawHeaders.split(',').map((header) => header.trim().toLowerCase())
    : [];
  if (
    requestedHeaders.some(
      (header) => !header || !allowedRequestHeaders.has(header)
    )
  ) {
    throw new WorkerHttpError(400, 'Invalid CORS preflight request header');
  }
  const responseHeaders = new Headers(corsHeaders);
  if (maxAgeSeconds !== null) {
    if (
      !Number.isSafeInteger(maxAgeSeconds) ||
      maxAgeSeconds < 1 ||
      maxAgeSeconds > 86_400
    ) {
      throw new WorkerHttpError(500, 'Invalid CORS preflight max age');
    }
    responseHeaders.set('Access-Control-Max-Age', String(maxAgeSeconds));
  }
  return new Response(null, { status: 204, headers: responseHeaders });
}

function createOperationOutcomeHeaders(operationId, outcome) {
  if (
    operationId !== null &&
    (typeof operationId !== 'string' || !OPERATION_ID.test(operationId))
  ) {
    throw new WorkerHttpError(500, 'Invalid Worker operation identity');
  }
  if (
    outcome !== 'applied' &&
    outcome !== 'not-applied' &&
    outcome !== 'unknown'
  ) {
    throw new WorkerHttpError(500, 'Invalid Worker operation outcome');
  }
  const headers = new Headers({
    [OPERATION_OUTCOME_HEADER]: outcome,
  });
  if (operationId !== null) {
    headers.set(OPERATION_ID_HEADER, operationId);
  }
  return headers;
}

function createGitHubMutationContext(request, kind) {
  const isMutation = GITHUB_MUTATION_KINDS.has(kind);
  const suppliedOperationId = request.headers.get(OPERATION_ID_HEADER);
  const suppliedOutcome = request.headers.get(OPERATION_OUTCOME_HEADER);

  if (!isMutation) {
    if (suppliedOperationId !== null || suppliedOutcome !== null) {
      throw new WorkerHttpError(
        400,
        'GitHub read requests must not contain Cellucid operation headers'
      );
    }
    return null;
  }
  if (suppliedOutcome !== null) {
    const operationId =
      suppliedOperationId !== null && OPERATION_ID.test(suppliedOperationId)
        ? suppliedOperationId
        : null;
    throw new WorkerHttpError(
      400,
      `${OPERATION_OUTCOME_HEADER} is response-only`,
      {
        headers: createOperationOutcomeHeaders(
          operationId,
          'not-applied'
        ),
      }
    );
  }
  if (
    suppliedOperationId === null ||
    !OPERATION_ID.test(suppliedOperationId)
  ) {
    throw new WorkerHttpError(
      400,
      `${OPERATION_ID_HEADER} must be one canonical lowercase UUIDv4`,
      {
        headers: createOperationOutcomeHeaders(null, 'not-applied'),
      }
    );
  }

  let forwarded = false;
  return {
    id: suppliedOperationId,
    markForwarded() {
      forwarded = true;
    },
    responseHeaders(outcome) {
      return createOperationOutcomeHeaders(suppliedOperationId, outcome);
    },
    decorateError(error, additionalHeaders = null) {
      const outcome = forwarded ? 'unknown' : 'not-applied';
      const responseHeaders = mergeHeaders(
        error?.responseHeaders,
        additionalHeaders,
        createOperationOutcomeHeaders(suppliedOperationId, outcome)
      );
      if (error && typeof error === 'object') {
        error.responseHeaders = responseHeaders;
        return error;
      }
      return new WorkerHttpError(500, 'Internal worker error', {
        headers: responseHeaders,
        cause: error,
      });
    },
  };
}

function createSafeGitHubResponseHeaders(response) {
  const headers = new Headers();
  const retryAfter = response?.headers?.get?.('Retry-After');
  if (
    typeof retryAfter === 'string' &&
    retryAfter.length > 0 &&
    retryAfter.length <= 256 &&
    retryAfter === retryAfter.trim() &&
    !/[\u0000-\u001f\u007f]/.test(retryAfter)
  ) {
    headers.set('Retry-After', retryAfter);
  }
  const rateLimitReset = response?.headers?.get?.('X-RateLimit-Reset');
  if (
    typeof rateLimitReset === 'string' &&
    /^(?:0|[1-9][0-9]{0,15})$/.test(rateLimitReset)
  ) {
    headers.set('X-RateLimit-Reset', rateLimitReset);
  }
  const requestId = response?.headers?.get?.('X-GitHub-Request-Id');
  if (
    typeof requestId === 'string' &&
    /^[A-Za-z0-9:-]{1,128}$/.test(requestId)
  ) {
    headers.set('X-GitHub-Request-Id', requestId);
  }
  return headers;
}

function mergeHeaders(...sources) {
  const merged = new Headers();
  for (const source of sources) {
    if (!source) continue;
    new Headers(source).forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') {
        merged.append(key, value);
      } else {
        merged.set(key, value);
      }
    });
  }
  return merged;
}

function jsonTextResponse(text, status, headers = null) {
  const responseHeaders = mergeHeaders(headers, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  return new Response(text, {
    status,
    headers: responseHeaders,
  });
}

function jsonResponse(data, status, headers = null) {
  return jsonTextResponse(JSON.stringify(data), status, headers);
}

function boundedJsonResponse(data, status, headers, maxBytes, label) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new WorkerHttpError(500, 'Invalid JSON response byte limit');
  }
  if (typeof TextEncoder !== 'function') {
    throw new WorkerHttpError(
      500,
      'UTF-8 encoding support is required by the GitHub worker'
    );
  }
  const text = JSON.stringify(data);
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new WorkerHttpError(502, `${label} exceeds ${maxBytes} bytes`);
  }
  return jsonTextResponse(text, status, headers);
}

function getSingleQueryParam(url, name, { required = false } = {}) {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new WorkerHttpError(400, `${name} must occur at most once`);
  }
  if (!values.length) {
    if (required) {
      throw new WorkerHttpError(400, `Missing ${name}`);
    }
    return null;
  }
  return assertExactString(values[0], name);
}

function validateReturnTo(rawReturnTo, env) {
  const candidate = assertExactString(rawReturnTo, 'return_to');
  const allowedOrigins = parseAllowedOrigins(env);
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
    throw new WorkerHttpError(
      400,
      `Disallowed return_to origin: ${parsed.origin}`
    );
  }
  return parsed.toString();
}

function serializeCookie(name, value, { path, maxAge }) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new WorkerHttpError(500, 'Invalid worker cookie name');
  }
  if (typeof value !== 'string') {
    throw new WorkerHttpError(500, 'Invalid worker cookie value');
  }
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new WorkerHttpError(500, 'Invalid worker cookie path');
  }
  if (!Number.isSafeInteger(maxAge) || maxAge < 0) {
    throw new WorkerHttpError(500, 'Invalid worker cookie max age');
  }
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

function getCookie(request, name, { required = false } = {}) {
  const raw = request.headers.get('Cookie');
  if (raw === null) {
    if (required) throw new WorkerHttpError(400, `Missing ${name} cookie`);
    return null;
  }
  const matches = [];
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) {
      throw new WorkerHttpError(400, 'Malformed Cookie header');
    }
    const cookieName = part.slice(0, separator).trim();
    if (cookieName !== name) continue;
    const encodedValue = part.slice(separator + 1).trim();
    try {
      matches.push(decodeURIComponent(encodedValue));
    } catch (cause) {
      throw new WorkerHttpError(400, `Invalid ${name} cookie`, { cause });
    }
  }
  if (matches.length > 1) {
    throw new WorkerHttpError(400, `Duplicate ${name} cookie`);
  }
  if (!matches.length || !matches[0]) {
    if (required) throw new WorkerHttpError(400, `Missing ${name} cookie`);
    return null;
  }
  return matches[0];
}

function getOauthOwnerCookieName(state) {
  if (
    typeof state !== 'string' ||
    !OAUTH_RANDOM_HEX_256.test(state)
  ) {
    throw new WorkerHttpError(
      400,
      'OAuth state must be 64 lowercase hexadecimal characters'
    );
  }
  return `${OAUTH_OWNER_COOKIE_PREFIX}${state}`;
}

function clearOauthOwnerCookie(headers, name) {
  headers.append(
    'Set-Cookie',
    serializeCookie(name, '', {
      path: '/auth/callback',
      maxAge: 0,
    })
  );
}

function serializeOauthOwnerCookie(state, returnTo, codeVerifier) {
  const name = getOauthOwnerCookieName(state);
  const value = JSON.stringify({
    return_to: returnTo,
    code_verifier: codeVerifier,
  });
  const serialized = serializeCookie(name, value, {
    path: '/auth/callback',
    maxAge: OAUTH_COOKIE_MAX_AGE_S,
  });
  if (typeof TextEncoder !== 'function') {
    throw new WorkerHttpError(
      500,
      'Web Crypto text encoding support is required'
    );
  }
  if (
    new TextEncoder().encode(serialized).byteLength >
    OAUTH_COOKIE_MAX_SERIALIZED_BYTES
  ) {
    throw new WorkerHttpError(
      400,
      `OAuth owner cookie exceeds ${OAUTH_COOKIE_MAX_SERIALIZED_BYTES} serialized bytes`
    );
  }
  return { name, serialized };
}

function parseOauthOwnerCookie(rawValue, env) {
  let document;
  try {
    document = parseExactJson(rawValue, {
      path: 'OAuth owner cookie',
    });
  } catch (cause) {
    throw new WorkerHttpError(
      400,
      'OAuth owner cookie contains invalid JSON',
      { cause }
    );
  }
  assertExactFields(
    document,
    ['return_to', 'code_verifier'],
    'OAuth owner cookie'
  );
  const returnTo = validateReturnTo(document.return_to, env);
  const codeVerifier = assertExactString(
    document.code_verifier,
    'OAuth owner code_verifier',
    { max: 64 }
  );
  if (!OAUTH_RANDOM_HEX_256.test(codeVerifier)) {
    throw new WorkerHttpError(
      400,
      'OAuth owner code_verifier must be 64 lowercase hexadecimal characters'
    );
  }
  return { returnTo, codeVerifier };
}

const APP_AUTH_FRAGMENT_PARAM_NAMES = new Set([
  APP_AUTH_FLAG_PARAM,
  APP_AUTH_TOKEN_PARAM,
  APP_AUTH_ERROR_PARAM,
]);

function readFragmentParamName(segment, index) {
  // Decode only the field name. Retaining the raw segment prevents unrelated
  // fragment bytes and separators from being normalized during auth cleanup.
  let candidate = segment;
  if (index === 0 && candidate.startsWith('?')) {
    candidate = candidate.slice(1);
  }
  if (!candidate) return null;
  const separatorIndex = candidate.indexOf('=');
  const rawName =
    separatorIndex === -1
      ? candidate
      : candidate.slice(0, separatorIndex);
  const probe = new URLSearchParams(`__cellucid_probe__=&${rawName}=`);
  const names = probe.keys();
  names.next();
  return names.next().value ?? null;
}

function scrubAppAuthFragment(hash, { hasFragment }) {
  const segments = hasFragment ? hash.split('&') : [];
  const retained = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const name = readFragmentParamName(segment, index);
    if (name !== null && APP_AUTH_FRAGMENT_PARAM_NAMES.has(name)) {
      continue;
    }
    retained.push(segment);
  }
  return {
    cleanedHash: retained.join('&'),
    hasRetainedSegments: retained.length > 0,
  };
}

function redirectToApp(returnTo, { token = null, error = null }, headers) {
  if ((token === null) === (error === null)) {
    throw new WorkerHttpError(
      500,
      'OAuth redirect requires exactly one token or error'
    );
  }
  const destination = new URL(returnTo);
  const fragmentIndex = destination.href.indexOf('#');
  const {
    cleanedHash,
    hasRetainedSegments,
  } = scrubAppAuthFragment(
    fragmentIndex === -1
      ? ''
      : destination.href.slice(fragmentIndex + 1),
    { hasFragment: fragmentIndex !== -1 }
  );
  const hashParams = new URLSearchParams();
  hashParams.set(APP_AUTH_FLAG_PARAM, '1');
  if (token !== null) {
    hashParams.set(
      APP_AUTH_TOKEN_PARAM,
      assertExactString(token, 'OAuth token')
    );
  }
  if (error !== null) {
    hashParams.set(
      APP_AUTH_ERROR_PARAM,
      assertExactString(error, 'OAuth error')
    );
  }
  const authHash = hashParams.toString();
  destination.hash = hasRetainedSegments
    ? `${cleanedHash}&${authHash}`
    : authHash;

  const responseHeaders = mergeHeaders(headers, {
    'Cache-Control': 'no-store',
    'Location': destination.toString(),
  });
  return new Response(null, { status: 302, headers: responseHeaders });
}

function createRandomHex256() {
  if (typeof crypto?.getRandomValues !== 'function') {
    throw new WorkerHttpError(500, 'Web Crypto random generation is required');
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
}

async function createPkceChallenge(verifier) {
  if (
    typeof crypto?.subtle?.digest !== 'function' ||
    typeof TextEncoder !== 'function' ||
    typeof btoa !== 'function'
  ) {
    throw new WorkerHttpError(500, 'Web Crypto PKCE support is required');
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(verifier)
    )
  );
  const binary = String.fromCharCode(...digest);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function handleLogin(url, env) {
  const returnTo = validateReturnTo(
    getSingleQueryParam(url, 'return_to', { required: true }),
    env
  );
  const clientId = requireEnvString(env, 'GITHUB_CLIENT_ID');
  const state = createRandomHex256();
  const codeVerifier = createRandomHex256();
  const codeChallenge = await createPkceChallenge(codeVerifier);
  const ownerCookie = serializeOauthOwnerCookie(
    state,
    returnTo,
    codeVerifier
  );
  const redirectUri = `${url.origin}/auth/callback`;

  const authUrl = new URL(GITHUB_AUTH_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Location': authUrl.toString(),
  });
  headers.append(
    'Set-Cookie',
    ownerCookie.serialized
  );
  return new Response(null, { status: 302, headers });
}

function oauthCallbackFailureMessage(error, outcomeUnknown) {
  if (outcomeUnknown) {
    return (
      'GitHub sign-in outcome is unknown. ' +
      'Start a new sign-in; do not retry this callback.'
    );
  }
  if (error instanceof WorkerHttpError && error.status === 400) {
    return `GitHub sign-in failed: ${error.message}`;
  }
  return 'GitHub sign-in could not be completed. Please try again.';
}

async function handleCallback(request, url, env, requestScope) {
  const returnedState = getSingleQueryParam(url, 'state', {
    required: true,
  });
  const ownerCookieName = getOauthOwnerCookieName(returnedState);
  const headers = new Headers();
  clearOauthOwnerCookie(headers, ownerCookieName);
  let returnTo = null;
  let tokenExchangeForwarded = false;
  try {
    const owner = parseOauthOwnerCookie(
      getCookie(request, ownerCookieName, { required: true }),
      env
    );
    returnTo = owner.returnTo;
    const codeVerifier = owner.codeVerifier;

    const code = getSingleQueryParam(url, 'code');
    const oauthError = getSingleQueryParam(url, 'error');
    const errorDescription = getSingleQueryParam(url, 'error_description');
    if ((code === null) === (oauthError === null)) {
      throw new WorkerHttpError(
        400,
        'OAuth callback requires exactly one code or error'
      );
    }
    if (oauthError !== null) {
      if (errorDescription === null) {
        throw new WorkerHttpError(
          400,
          'OAuth error must include error_description'
        );
      }
      return redirectToApp(
        returnTo,
        { error: `GitHub error: ${errorDescription}` },
        headers
      );
    }
    if (errorDescription !== null) {
      throw new WorkerHttpError(
        400,
        'OAuth error_description cannot accompany an authorization code'
      );
    }

    const clientId = requireEnvString(env, 'GITHUB_CLIENT_ID');
    const clientSecret = requireEnvString(env, 'GITHUB_CLIENT_SECRET');
    const tokenResponse = await fetchUpstream(
      GITHUB_TOKEN_URL,
      {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          code_verifier: codeVerifier,
          redirect_uri: `${url.origin}/auth/callback`,
        }),
      },
      'GitHub OAuth token exchange',
      requestScope,
      {
        markForwarded() {
          tokenExchangeForwarded = true;
        },
      }
    );
    const tokenDocument = await parseResponseJson(
      tokenResponse,
      'GitHub OAuth token response',
      requestScope
    );
    if (!tokenResponse.ok) {
      assertExactFields(
        tokenDocument,
        ['error', 'error_description', 'error_uri'],
        'GitHub OAuth error response',
        502
      );
      const message = assertExactString(
        tokenDocument.error_description,
        'GitHub OAuth error_description',
        { status: 502 }
      );
      return redirectToApp(returnTo, { error: message }, headers);
    }
    assertExactFields(
      tokenDocument,
      ['access_token', 'token_type', 'scope'],
      'GitHub OAuth success response',
      502
    );
    if (tokenDocument?.token_type !== 'bearer' || tokenDocument?.scope !== '') {
      throw new WorkerHttpError(
        502,
        'GitHub OAuth response has an invalid token_type or scope'
      );
    }
    const token = assertExactString(
      tokenDocument?.access_token,
      'GitHub OAuth access_token',
      { status: 502 }
    );
    return redirectToApp(returnTo, { token }, headers);
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
        {
          error: oauthCallbackFailureMessage(
            error,
            tokenExchangeForwarded
          ),
        },
        headers
      );
    }
    if (error && typeof error === 'object') {
      error.responseHeaders = mergeHeaders(
        error.responseHeaders,
        headers
      );
    }
    throw error;
  }
}

function getBearerToken(request) {
  const authorization = request.headers.get('Authorization');
  if (authorization === null) {
    throw new WorkerHttpError(401, 'Missing bearer token');
  }
  const match = authorization.match(/^Bearer ([^\s,]+)$/);
  if (!match || exceedsCodePointLimit(match[1], 4096)) {
    throw new WorkerHttpError(401, 'Invalid bearer token');
  }
  return match[1];
}

async function handleGetUser(request, corsHeaders, requestScope) {
  const token = getBearerToken(request);
  const { response, document } = await githubFetchJson(
    '/user',
    token,
    requestScope
  );
  const responseHeaders = mergeHeaders(
    corsHeaders,
    createSafeGitHubResponseHeaders(response)
  );
  if (!response.ok) {
    return jsonResponse(
      { error: upstreamErrorMessage(document, 'GitHub user request failed') },
      response.status,
      responseHeaders
    );
  }
  const id = document?.id;
  const login = document?.login;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new WorkerHttpError(502, 'GitHub user id is invalid');
  }
  assertCanonicalGitHubAccount(login, 'GitHub user login');
  return jsonResponse({ id, login }, 200, responseHeaders);
}

function projectInstallationCollectionItem(installation, index) {
  const id = installation?.id;
  const login = installation?.account?.login;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new WorkerHttpError(
      502,
      `GitHub installation ${index} has an invalid id`
    );
  }
  assertCanonicalGitHubAccount(
    login,
    `GitHub installation ${index} account login`
  );
  return { id, account: { login } };
}

function projectRepositoryCollectionItem(repository, index) {
  const id = repository?.id;
  const fullName = repository?.full_name;
  const isPrivate = repository?.private;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new WorkerHttpError(
      502,
      `GitHub repository ${index} has an invalid id`
    );
  }
  assertExactString(fullName, `GitHub repository ${index} full_name`, {
    max: 256,
    status: 502,
  });
  if (!isCanonicalGitHubRepositoryFullName(fullName)) {
    throw new WorkerHttpError(
      502,
      `GitHub repository ${index} full_name is not canonical`
    );
  }
  if (typeof isPrivate !== 'boolean') {
    throw new WorkerHttpError(
      502,
      `GitHub repository ${index} private must be boolean`
    );
  }
  return { id, full_name: fullName, private: isPrivate };
}

async function handleGetInstallations(request, corsHeaders, requestScope) {
  const token = getBearerToken(request);
  const result = await githubFetchCollection(
    '/user/installations',
    token,
    'installations',
    projectInstallationCollectionItem,
    requestScope
  );
  const responseHeaders = mergeHeaders(
    corsHeaders,
    createSafeGitHubResponseHeaders(result.response)
  );
  if (!result.response.ok) {
    return jsonResponse(
      {
        error: upstreamErrorMessage(
          result.errorDocument,
          'GitHub installations request failed'
        ),
      },
      result.response.status,
      responseHeaders
    );
  }
  const seenIds = new Set();
  const seenAccounts = new Set();
  for (const installation of result.items) {
    const id = installation?.id;
    const login = installation?.account?.login;
    if (seenIds.has(id)) {
      throw new WorkerHttpError(
        502,
        `GitHub installations response contains duplicate id ${id}`
      );
    }
    const accountKey = login.toLowerCase();
    if (seenAccounts.has(accountKey)) {
      throw new WorkerHttpError(
        502,
        `GitHub installations response contains duplicate account ${login}`
      );
    }
    seenIds.add(id);
    seenAccounts.add(accountKey);
  }
  return jsonResponse(
    { installations: result.items },
    200,
    responseHeaders
  );
}

async function readExactRequestObject(
  request,
  label,
  allowedKeys = null,
  requestScope,
  maxBytes = WORKER_REQUEST_BODY_MAX_BYTES
) {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw new WorkerHttpError(415, `${label} requires application/json`);
  }
  const text = await readBoundedUtf8Body(request, label, {
    maxBytes,
    readErrorStatus: 400,
    tooLargeStatus: 413,
    requestScope,
  });
  if (!text) throw new WorkerHttpError(400, `${label} body is empty`);
  let document;
  try {
    document = parseExactJson(text, { path: label });
  } catch (cause) {
    throw new WorkerHttpError(400, `${label} contains invalid JSON`, { cause });
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new WorkerHttpError(400, `${label} must be a JSON object`);
  }
  const keys = Object.keys(document);
  if (
    allowedKeys !== null &&
    (
      keys.length !== allowedKeys.length ||
      allowedKeys.some((key) => !Object.hasOwn(document, key))
    )
  ) {
    throw new WorkerHttpError(
      400,
      `${label} must contain exactly ${allowedKeys.join(', ')}`
    );
  }
  return document;
}

function assertCapRequestHasNoCredentials(request) {
  for (const header of CAP_FORBIDDEN_REQUEST_HEADERS) {
    if (request.headers.has(header)) {
      throw new WorkerHttpError(
        400,
        `CAP requests must not contain ${header}`
      );
    }
  }
}

function assertCapLimit(value, max, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new WorkerHttpError(
      400,
      `${label} must be a safe integer from 1 to ${max}`
    );
  }
  return value;
}

function createCapPersistedQueryDocument(operationName, hash, variables) {
  return {
    operationName,
    variables,
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: hash,
      },
    },
  };
}

function isWorkerRequestAbort(error) {
  return (
    error instanceof WorkerHttpError &&
    (error.status === 499 || error.status === 504)
  );
}

async function cancelCapResponseBodyPreservingOwnerAbort(
  response,
  requestScope
) {
  const body = response?.body;
  if (!body || typeof body.cancel !== 'function') {
    requestScope.throwIfAborted();
    return;
  }

  let cancellation;
  try {
    cancellation = body.cancel();
  } catch {
    requestScope.throwIfAborted();
    return;
  }
  try {
    await awaitWithinWorkerRequestScope(cancellation, requestScope);
  } catch {
    const ownedAbort = requestScope.createAbortError();
    if (ownedAbort !== null) throw ownedAbort;
  }
  requestScope.throwIfAborted();
}

async function preflightCapUpstreamResponse(response, requestScope) {
  requestScope.throwIfAborted();
  if (response?.ok !== true) {
    await cancelCapResponseBodyPreservingOwnerAbort(
      response,
      requestScope
    );
    throw new WorkerHttpError(502, 'CAP upstream request failed');
  }

  let contentLength;
  let contentLengthError = null;
  try {
    contentLength = parseCanonicalContentLength(
      response,
      'CAP GraphQL response'
    );
  } catch (error) {
    contentLengthError = error;
  }
  if (
    contentLengthError !== null ||
    (
      contentLength !== null &&
      contentLength > CAP_RESPONSE_BODY_MAX_BYTES
    )
  ) {
    await cancelCapResponseBodyPreservingOwnerAbort(
      response,
      requestScope
    );
    throw new WorkerHttpError(502, 'CAP upstream response was invalid', {
      cause: contentLengthError,
    });
  }
  requestScope.throwIfAborted();
}

async function executeCapPersistedQuery(
  operationName,
  hash,
  variables,
  requestScope
) {
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
        body: JSON.stringify(
          createCapPersistedQueryDocument(operationName, hash, variables)
        ),
        credentials: 'omit',
        redirect: 'error',
      },
      'CAP GraphQL request',
      requestScope
    );
  } catch (error) {
    if (isWorkerRequestAbort(error)) throw error;
    throw new WorkerHttpError(502, 'CAP upstream request failed', {
      cause: error,
    });
  }

  await preflightCapUpstreamResponse(response, requestScope);
  let document;
  try {
    document = await parseResponseJson(
      response,
      'CAP GraphQL response',
      requestScope,
      CAP_RESPONSE_BODY_MAX_BYTES
    );
  } catch (error) {
    if (isWorkerRequestAbort(error)) throw error;
    throw new WorkerHttpError(502, 'CAP upstream response was invalid', {
      cause: error,
    });
  }
  return document;
}

function assertCapString(value, label, max) {
  return assertExactString(value, label, { max, status: 502 });
}

function assertNullableCapString(value, label, max) {
  if (value === null) return null;
  return assertCapString(value, label, max);
}

function assertCapNonnegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkerHttpError(
      502,
      `${label} must be a nonnegative safe integer`
    );
  }
  return value;
}

function projectCapStringArray(value, label, maxItems, maxCodePoints) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new WorkerHttpError(
      502,
      `${label} must be an array with at most ${maxItems} items`
    );
  }
  return value.map((entry, index) =>
    assertCapString(entry, `${label}[${index}]`, maxCodePoints)
  );
}

function projectCapLookupItem(value, index) {
  const label = `CAP lookup result[${index}]`;
  const item = assertUpstreamRecord(value, label);
  const scores = assertUpstreamRecord(item.scores, `${label}.scores`);
  const agree = assertCapNonnegativeSafeInteger(
    scores.agree,
    `${label}.scores.agree`
  );
  const disagree = assertCapNonnegativeSafeInteger(
    scores.disagree,
    `${label}.scores.disagree`
  );
  const idk = assertCapNonnegativeSafeInteger(
    scores.idk,
    `${label}.scores.idk`
  );
  if (!Number.isSafeInteger(agree + disagree + idk)) {
    throw new WorkerHttpError(
      502,
      `${label}.scores total must be a nonnegative safe integer`
    );
  }
  return {
    id: assertCapString(item.id, `${label}.id`, CAP_ID_MAX_CODE_POINTS),
    name: assertCapString(
      item.name,
      `${label}.name`,
      CAP_TEXT_MAX_CODE_POINTS
    ),
    fullName: assertCapString(
      item.fullName,
      `${label}.fullName`,
      CAP_TEXT_MAX_CODE_POINTS
    ),
    ontologyTerm: assertNullableCapString(
      item.ontologyTerm,
      `${label}.ontologyTerm`,
      CAP_TEXT_MAX_CODE_POINTS
    ),
    ontologyTermId: assertNullableCapString(
      item.ontologyTermId,
      `${label}.ontologyTermId`,
      CAP_ID_MAX_CODE_POINTS
    ),
    synonyms: projectCapStringArray(
      item.synonyms,
      `${label}.synonyms`,
      CAP_SYNONYM_MAX_ITEMS,
      CAP_TEXT_MAX_CODE_POINTS
    ),
    markerGenes: projectCapStringArray(
      item.markerGenes,
      `${label}.markerGenes`,
      CAP_MARKER_MAX_ITEMS,
      CAP_GENE_MAX_CODE_POINTS
    ),
    canonicalMarkerGenes: projectCapStringArray(
      item.canonicalMarkerGenes,
      `${label}.canonicalMarkerGenes`,
      CAP_MARKER_MAX_ITEMS,
      CAP_GENE_MAX_CODE_POINTS
    ),
    count: assertCapNonnegativeSafeInteger(item.count, `${label}.count`),
    scores: { agree, disagree, idk },
  };
}

function projectCapDatasetItem(value, index) {
  const label = `CAP dataset result[${index}]`;
  const item = assertUpstreamRecord(value, label);
  return {
    id: assertCapString(item.id, `${label}.id`, CAP_ID_MAX_CODE_POINTS),
    name: assertCapString(
      item.name,
      `${label}.name`,
      CAP_TEXT_MAX_CODE_POINTS
    ),
    cellCount: assertCapNonnegativeSafeInteger(
      item.cellCount,
      `${label}.cellCount`
    ),
  };
}

function projectCapGraphQlResults(document, field, limit, projectItem) {
  const response = assertUpstreamRecord(document, 'CAP GraphQL response');
  if (Object.hasOwn(response, 'errors')) {
    if (!Array.isArray(response.errors) || response.errors.length !== 0) {
      throw new WorkerHttpError(502, 'CAP GraphQL operation failed');
    }
  }
  const data = assertUpstreamRecord(
    response.data,
    'CAP GraphQL response.data'
  );
  const rawResults = data[field];
  if (!Array.isArray(rawResults) || rawResults.length > limit) {
    throw new WorkerHttpError(
      502,
      `CAP GraphQL response.data.${field} is invalid`
    );
  }

  const results = [];
  let omittedInvalidCount = 0;
  for (let index = 0; index < rawResults.length; index += 1) {
    try {
      results.push(projectItem(rawResults[index], index));
    } catch (error) {
      if (!(error instanceof WorkerHttpError) || error.status !== 502) {
        throw error;
      }
      omittedInvalidCount += 1;
    }
  }
  return { results, omittedInvalidCount };
}

function capGatewayResponse(data, corsHeaders) {
  return boundedJsonResponse(
    {
      contractVersion: WORKER_CONTRACT_VERSION,
      results: data.results,
      omittedInvalidCount: data.omittedInvalidCount,
    },
    200,
    corsHeaders,
    CAP_OUTPUT_BODY_MAX_BYTES,
    'CAP gateway response'
  );
}

function capLookupSearch(kind, term) {
  if (kind === 'ontology') {
    return { name: term, fields: CAP_ONTOLOGY_LOOKUP_FIELDS };
  }
  if (kind === 'marker') {
    return { name: term, fields: CAP_MARKER_LOOKUP_FIELDS };
  }
  return { name: term };
}

async function handleCapLookup(request, url, corsHeaders, requestScope) {
  assertNoQuery(url, 'CAP lookup route');
  assertCapRequestHasNoCredentials(request);
  const body = await readExactRequestObject(
    request,
    'CAP lookup request',
    ['kind', 'term', 'limit'],
    requestScope,
    CAP_REQUEST_BODY_MAX_BYTES
  );
  const kind = assertExactString(body.kind, 'CAP lookup kind', { max: 16 });
  if (!CAP_LOOKUP_KINDS.has(kind)) {
    throw new WorkerHttpError(
      400,
      'CAP lookup kind must be name, ontology, marker, or feedback'
    );
  }
  const term = assertExactString(body.term, 'CAP lookup term', {
    max:
      kind === 'marker'
        ? CAP_MARKER_TERM_MAX_CODE_POINTS
        : CAP_TERM_MAX_CODE_POINTS,
  });
  const limit = assertCapLimit(
    body.limit,
    CAP_LOOKUP_LIMIT_MAX,
    'CAP lookup limit'
  );
  const document = await executeCapPersistedQuery(
    'LookupCells',
    CAP_LOOKUP_APQ_HASH,
    { options: { limit }, search: capLookupSearch(kind, term) },
    requestScope
  );
  return capGatewayResponse(
    projectCapGraphQlResults(
      document,
      'lookupCells',
      limit,
      projectCapLookupItem
    ),
    corsHeaders
  );
}

async function handleCapDatasetSearch(
  request,
  url,
  corsHeaders,
  requestScope
) {
  assertNoQuery(url, 'CAP dataset search route');
  assertCapRequestHasNoCredentials(request);
  const body = await readExactRequestObject(
    request,
    'CAP dataset search request',
    ['search', 'limit'],
    requestScope,
    CAP_REQUEST_BODY_MAX_BYTES
  );
  let search = null;
  if (body.search !== null) {
    search = assertExactString(body.search, 'CAP dataset search', {
      max: CAP_TERM_MAX_CODE_POINTS,
    });
  }
  const limit = assertCapLimit(
    body.limit,
    CAP_DATASET_LIMIT_MAX,
    'CAP dataset limit'
  );
  const document = await executeCapPersistedQuery(
    'SearchDatasets',
    CAP_DATASET_APQ_HASH,
    {
      options: { limit },
      search: search === null ? null : { name: search },
    },
    requestScope
  );
  return capGatewayResponse(
    projectCapGraphQlResults(
      document,
      'results',
      limit,
      projectCapDatasetItem
    ),
    corsHeaders
  );
}

async function handleGetInstallationRepos(
  request,
  corsHeaders,
  requestScope
) {
  const token = getBearerToken(request);
  const body = await readExactRequestObject(
    request,
    'installation repositories request',
    ['installation_id'],
    requestScope
  );
  const installationId = body.installation_id;
  if (!Number.isSafeInteger(installationId) || installationId < 1) {
    throw new WorkerHttpError(
      400,
      'installation_id must be a positive safe integer'
    );
  }

  const result = await githubFetchCollection(
    `/user/installations/${installationId}/repositories`,
    token,
    'repositories',
    projectRepositoryCollectionItem,
    requestScope
  );
  const responseHeaders = mergeHeaders(
    corsHeaders,
    createSafeGitHubResponseHeaders(result.response)
  );
  if (!result.response.ok) {
    return jsonResponse(
      {
        error: upstreamErrorMessage(
          result.errorDocument,
          'GitHub installation repositories request failed'
        ),
      },
      result.response.status,
      responseHeaders
    );
  }
  const seenIds = new Set();
  const seenNames = new Set();
  for (const repository of result.items) {
    const id = repository?.id;
    const fullName = repository?.full_name;
    if (seenIds.has(id)) {
      throw new WorkerHttpError(
        502,
        `GitHub repositories response contains duplicate id ${id}`
      );
    }
    const nameKey = fullName.toLowerCase();
    if (seenNames.has(nameKey)) {
      throw new WorkerHttpError(
        502,
        `GitHub repositories response contains duplicate name ${fullName}`
      );
    }
    seenIds.add(id);
    seenNames.add(nameKey);
  }
  return jsonResponse(
    { repositories: result.items },
    200,
    responseHeaders
  );
}

function decodeCanonicalPathSegment(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new WorkerHttpError(400, `${label} path segment is missing`);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch (cause) {
    throw new WorkerHttpError(400, `${label} path segment is invalid`, {
      cause,
    });
  }
  if (!decoded || encodeURIComponent(decoded) !== value) {
    throw new WorkerHttpError(
      400,
      `${label} path segment is not canonically encoded`
    );
  }
  return decoded;
}

function requireProxyMethod(method, allowed, label) {
  if (!allowed.includes(method)) {
    throw new WorkerHttpError(
      405,
      `${label} supports only ${allowed.join(' or ')}`
    );
  }
}

function assertExactQuery(url, expected, label) {
  const expectedKeys = Object.keys(expected);
  const actualKeys = [...new Set(url.searchParams.keys())];
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !actualKeys.includes(key))
  ) {
    throw new WorkerHttpError(
      400,
      `${label} query must contain exactly ${expectedKeys.join(', ')}`
    );
  }
  const output = {};
  for (const key of expectedKeys) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1) {
      throw new WorkerHttpError(
        400,
        `${label} query field ${key} must occur exactly once`
      );
    }
    output[key] = values[0];
  }
  return output;
}

function assertNoQuery(url, label) {
  if (url.search !== '') {
    throw new WorkerHttpError(400, `${label} does not accept a query`);
  }
}

function assertPositiveQueryInteger(value, label) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new WorkerHttpError(400, `${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || `${parsed}` !== value) {
    throw new WorkerHttpError(400, `${label} must be a safe integer`);
  }
  return parsed;
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
  return value;
}

function assertAllowedGitHubProxyRoute(githubUrl, method) {
  const segments = githubUrl.pathname.split('/').slice(1);
  if (
    segments.length < 3 ||
    segments[0] !== 'repos'
  ) {
    throw new WorkerHttpError(
      404,
      'GitHub API proxy supports only exact repository operations'
    );
  }
  const owner = decodeCanonicalPathSegment(segments[1], 'Repository owner');
  const repo = decodeCanonicalPathSegment(segments[2], 'Repository name');
  if (!isCanonicalGitHubRepositoryFullName(`${owner}/${repo}`)) {
    throw new WorkerHttpError(
      400,
      'GitHub repository path must contain an exact owner/repository name'
    );
  }
  const rest = segments.slice(3);

  if (rest.length === 0) {
    requireProxyMethod(method, ['GET'], 'Repository metadata');
    if (githubUrl.search === '') {
      return { kind: 'repository-metadata' };
    }
    const query = assertExactQuery(
      githubUrl,
      { fork_identity: true },
      'Repository fork identity'
    );
    if (query.fork_identity !== '1') {
      throw new WorkerHttpError(
        400,
        'Repository fork identity must equal 1'
      );
    }
    return {
      kind: 'repository-fork-identity',
      stripQueryBeforeUpstream: true,
    };
  }

  if (rest[0] === 'contents' && rest.length >= 2) {
    requireProxyMethod(method, ['GET', 'PUT'], 'Repository contents');
    const path = rest
      .slice(1)
      .map((segment) =>
        decodeCanonicalPathSegment(segment, 'Repository content')
      )
      .join('/');
    const isMutableAnnotationDocument =
      path === 'annotations/config.json' ||
      path === 'annotations/moderation/merges.json' ||
      GITHUB_USER_FILE.test(path);
    const isReadOnlySchema = GITHUB_READ_ONLY_SCHEMA_FILES.has(path);
    if (!isMutableAnnotationDocument && !isReadOnlySchema) {
      throw new WorkerHttpError(
        404,
        'GitHub contents proxy supports only current annotation documents and schemas'
      );
    }
    if (method === 'GET') {
      const query = assertExactQuery(
        githubUrl,
        { ref: true },
        'Repository contents'
      );
      if (!isCanonicalGitHubBranch(query.ref)) {
        throw new WorkerHttpError(
          400,
          'Repository contents ref must be an exact branch'
        );
      }
      return { kind: 'contents-get' };
    }
    if (isReadOnlySchema) {
      throw new WorkerHttpError(
        405,
        'Annotation schemas are read-only through the GitHub proxy'
      );
    }
    assertNoQuery(githubUrl, 'Repository contents mutation');
    return { kind: 'contents-put' };
  }

  if (rest[0] === 'git' && rest[1] === 'trees' && rest.length === 3) {
    requireProxyMethod(method, ['GET'], 'Git tree');
    const branch = decodeCanonicalPathSegment(rest[2], 'Git tree branch');
    if (!isCanonicalGitHubBranch(branch)) {
      throw new WorkerHttpError(400, 'Git tree branch is invalid');
    }
    const query = assertExactQuery(
      githubUrl,
      { recursive: true },
      'Git tree'
    );
    if (query.recursive !== '1') {
      throw new WorkerHttpError(400, 'Git tree recursive must equal 1');
    }
    return { kind: 'git-tree-get' };
  }

  if (rest[0] === 'git' && rest[1] === 'blobs' && rest.length === 3) {
    requireProxyMethod(method, ['GET'], 'Git blob');
    const sha = decodeCanonicalPathSegment(rest[2], 'Git blob SHA');
    if (!GITHUB_SHA.test(sha)) {
      throw new WorkerHttpError(
        400,
        'Git blob SHA must be exactly 40 lowercase hexadecimal characters'
      );
    }
    assertNoQuery(githubUrl, 'Git blob');
    return { kind: 'git-blob-get' };
  }

  if (
    rest[0] === 'git' &&
    rest[1] === 'ref' &&
    rest[2] === 'heads' &&
    rest.length >= 4
  ) {
    requireProxyMethod(method, ['GET'], 'Git branch reference');
    const branch = rest
      .slice(3)
      .map((segment) =>
        decodeCanonicalPathSegment(segment, 'Git branch reference')
      )
      .join('/');
    if (!isCanonicalGitHubBranch(branch)) {
      throw new WorkerHttpError(400, 'Git branch reference is invalid');
    }
    assertNoQuery(githubUrl, 'Git branch reference');
    return { kind: 'git-ref-get' };
  }

  if (
    rest.length === 2 &&
    rest[0] === 'git' &&
    rest[1] === 'refs'
  ) {
    requireProxyMethod(method, ['POST'], 'Git branch creation');
    assertNoQuery(githubUrl, 'Git branch creation');
    return { kind: 'git-refs-post' };
  }

  if (rest.length === 1 && rest[0] === 'forks') {
    requireProxyMethod(method, ['GET', 'POST'], 'Repository forks');
    if (method === 'GET') {
      const query = assertExactQuery(
        githubUrl,
        { sort: true, per_page: true, page: true },
        'Repository forks'
      );
      if (query.sort !== 'newest') {
        throw new WorkerHttpError(
          400,
          'Repository forks sort must equal newest'
        );
      }
      if (query.per_page !== `${GITHUB_PAGE_SIZE}`) {
        throw new WorkerHttpError(
          400,
          `Repository forks per_page must equal ${GITHUB_PAGE_SIZE}`
        );
      }
      assertPositiveQueryInteger(query.page, 'Repository forks page');
      return { kind: 'forks-get' };
    }
    assertNoQuery(githubUrl, 'Repository fork creation');
    return { kind: 'forks-post' };
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
        throw new WorkerHttpError(
          400,
          'Pull Request lookup state must equal open'
        );
      }
      assertPullHead(query.head, 'Pull Request lookup head');
      if (!isCanonicalGitHubBranch(query.base)) {
        throw new WorkerHttpError(
          400,
          'Pull Request lookup base must be an exact branch'
        );
      }
      if (query.per_page !== `${GITHUB_PAGE_SIZE}`) {
        throw new WorkerHttpError(
          400,
          `Pull Request lookup per_page must equal ${GITHUB_PAGE_SIZE}`
        );
      }
      return { kind: 'pulls-get' };
    }
    assertNoQuery(githubUrl, 'Pull Request creation');
    return { kind: 'pulls-post' };
  }

  throw new WorkerHttpError(
    404,
    'GitHub API proxy does not expose this repository operation'
  );
}

function assertExactRequestFields(document, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(document);
  if (
    required.some((key) => !Object.hasOwn(document, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new WorkerHttpError(
      400,
      `${label} must contain required fields ${required.join(', ')} and only optional fields ${optional.join(', ')}`
    );
  }
  return document;
}

function assertExactSha(value, label) {
  if (typeof value !== 'string' || !GITHUB_SHA.test(value)) {
    throw new WorkerHttpError(
      400,
      `${label} must be exactly 40 lowercase hexadecimal characters`
    );
  }
  return value;
}

function base64AlphabetValue(code) {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  if (code >= 48 && code <= 57) return code - 48 + 52;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

function inspectCanonicalBase64Payload(value, allowLineFolding) {
  if (typeof value !== 'string') return null;
  let payloadLength = 0;
  let paddingLength = 0;
  let sawPadding = false;
  let lastAlphabetValue = -1;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 10 || code === 13) {
      if (!allowLineFolding) return null;
      if (code === 13) {
        if (value.charCodeAt(index + 1) !== 10) return null;
        index += 1;
      }
      continue;
    }

    payloadLength += 1;
    if (code === 61) {
      sawPadding = true;
      paddingLength += 1;
      if (paddingLength > 2) return null;
      continue;
    }
    const alphabetValue = base64AlphabetValue(code);
    if (alphabetValue < 0 || sawPadding) return null;
    lastAlphabetValue = alphabetValue;
  }

  if (payloadLength === 0 || payloadLength % 4 !== 0) return null;
  if (
    (paddingLength === 1 && (lastAlphabetValue & 0b11) !== 0) ||
    (paddingLength === 2 && (lastAlphabetValue & 0b1111) !== 0)
  ) {
    return null;
  }
  return {
    decodedByteLength:
      (payloadLength / 4) * 3 - paddingLength,
    paddingLength,
    payloadLength,
  };
}

function assertCanonicalBase64(value, label) {
  const inspection = inspectCanonicalBase64Payload(value, false);
  if (inspection === null) {
    throw new WorkerHttpError(400, `${label} must be canonical base64`);
  }
  if (
    inspection.decodedByteLength >
    ANNOTATION_FILE_MAX_UTF8_BYTES
  ) {
    throw new WorkerHttpError(
      413,
      `${label} exceeds ${ANNOTATION_FILE_MAX_UTF8_BYTES} decoded bytes`
    );
  }
  return value;
}

function validateGitHubProxyMutationBody(kind, document) {
  if (kind === 'contents-put') {
    const body = assertExactRequestFields(
      document,
      ['message', 'content', 'branch'],
      ['sha'],
      'Repository contents mutation'
    );
    assertExactString(body.message, 'Repository contents message', {
      max: 256,
    });
    assertCanonicalBase64(body.content, 'Repository contents content');
    if (!isCanonicalGitHubBranch(body.branch)) {
      throw new WorkerHttpError(
        400,
        'Repository contents branch must be an exact branch'
      );
    }
    if (Object.hasOwn(body, 'sha')) {
      assertExactSha(body.sha, 'Repository contents sha');
    }
    return;
  }
  if (kind === 'git-refs-post') {
    assertExactFields(
      document,
      ['ref', 'sha'],
      'Git branch creation request'
    );
    if (
      typeof document.ref !== 'string' ||
      !document.ref.startsWith('refs/heads/') ||
      !isCanonicalGitHubBranch(document.ref.slice('refs/heads/'.length))
    ) {
      throw new WorkerHttpError(
        400,
        'Git branch creation ref must equal refs/heads/<exact branch>'
      );
    }
    assertExactSha(document.sha, 'Git branch creation sha');
    return;
  }
  if (kind === 'forks-post') {
    assertExactFields(document, [], 'Repository fork creation request');
    return;
  }
  if (kind === 'pulls-post') {
    assertExactFields(
      document,
      ['title', 'head', 'base', 'body', 'maintainer_can_modify'],
      'Pull Request creation request'
    );
    assertExactString(document.title, 'Pull Request title', { max: 256 });
    assertPullHead(document.head, 'Pull Request head');
    if (!isCanonicalGitHubBranch(document.base)) {
      throw new WorkerHttpError(
        400,
        'Pull Request base must be an exact branch'
      );
    }
    assertExactString(document.body, 'Pull Request body', { max: 65_536 });
    if (document.maintainer_can_modify !== true) {
      throw new WorkerHttpError(
        400,
        'Pull Request maintainer_can_modify must equal true'
      );
    }
    return;
  }
  throw new WorkerHttpError(
    400,
    'This GitHub proxy route does not accept a mutation body'
  );
}

function assertUpstreamRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerHttpError(502, `${label} must be a JSON object`);
  }
  return value;
}

function assertUpstreamBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new WorkerHttpError(502, `${label} must be boolean`);
  }
  return value;
}

function assertUpstreamPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WorkerHttpError(502, `${label} must be a positive safe integer`);
  }
  return value;
}

function assertUpstreamHttpsUrl(value, label) {
  assertExactString(value, label, { max: 2048, status: 502 });
  let parsed;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new WorkerHttpError(502, `${label} must be an exact HTTPS URL`, {
      cause,
    });
  }
  if (parsed.protocol !== 'https:' || parsed.toString() !== value) {
    throw new WorkerHttpError(502, `${label} must be an exact HTTPS URL`);
  }
  return value;
}

function projectRepositoryMetadata(document) {
  const repository = assertUpstreamRecord(
    document,
    'GitHub repository response'
  );
  const fullName = repository.full_name;
  if (!isCanonicalGitHubRepositoryFullName(fullName)) {
    throw new WorkerHttpError(
      502,
      'GitHub repository response.full_name must be canonical'
    );
  }
  const defaultBranch = repository.default_branch;
  if (!isCanonicalGitHubBranch(defaultBranch)) {
    throw new WorkerHttpError(
      502,
      'GitHub repository response.default_branch must be an exact branch'
    );
  }
  const permissions = assertUpstreamRecord(
    repository.permissions,
    'GitHub repository response.permissions'
  );
  return {
    full_name: fullName,
    default_branch: defaultBranch,
    private: assertUpstreamBoolean(
      repository.private,
      'GitHub repository response.private'
    ),
    allow_forking: assertUpstreamBoolean(
      repository.allow_forking,
      'GitHub repository response.allow_forking'
    ),
    permissions: {
      pull: assertUpstreamBoolean(
        permissions.pull,
        'GitHub repository response.permissions.pull'
      ),
      triage: assertUpstreamBoolean(
        permissions.triage,
        'GitHub repository response.permissions.triage'
      ),
      push: assertUpstreamBoolean(
        permissions.push,
        'GitHub repository response.permissions.push'
      ),
      maintain: assertUpstreamBoolean(
        permissions.maintain,
        'GitHub repository response.permissions.maintain'
      ),
      admin: assertUpstreamBoolean(
        permissions.admin,
        'GitHub repository response.permissions.admin'
      ),
    },
  };
}

function projectRepositoryForkIdentity(document) {
  const repository = assertUpstreamRecord(
    document,
    'GitHub fork identity response'
  );
  const fullName = repository.full_name;
  if (!isCanonicalGitHubRepositoryFullName(fullName)) {
    throw new WorkerHttpError(
      502,
      'GitHub fork identity response.full_name must be canonical'
    );
  }
  const isFork = assertUpstreamBoolean(
    repository.fork,
    'GitHub fork identity response.fork'
  );
  if (!isFork) {
    if (
      repository.parent !== undefined &&
      repository.parent !== null
    ) {
      throw new WorkerHttpError(
        502,
        'GitHub non-fork identity response.parent must be absent or null'
      );
    }
    return {
      full_name: fullName,
      fork: false,
      parent: null,
    };
  }
  const parent = assertUpstreamRecord(
    repository.parent,
    'GitHub fork identity response.parent'
  );
  if (!isCanonicalGitHubRepositoryFullName(parent.full_name)) {
    throw new WorkerHttpError(
      502,
      'GitHub fork identity response.parent.full_name must be canonical'
    );
  }
  return {
    full_name: fullName,
    fork: true,
    parent: { full_name: parent.full_name },
  };
}

function assertExactShaWithStatus(value, label, status) {
  if (typeof value !== 'string' || !GITHUB_SHA.test(value)) {
    throw new WorkerHttpError(
      status,
      `${label} must be exactly 40 lowercase hexadecimal characters`
    );
  }
  return value;
}

function projectContentPut(document) {
  const response = assertUpstreamRecord(
    document,
    'GitHub contents mutation response'
  );
  const content = assertUpstreamRecord(
    response.content,
    'GitHub contents mutation response.content'
  );
  return {
    content: {
      sha: assertExactShaWithStatus(
        content.sha,
        'GitHub contents mutation response.content.sha',
        502
      ),
    },
  };
}

function projectGitRef(document) {
  const response = assertUpstreamRecord(
    document,
    'GitHub branch reference response'
  );
  const object = assertUpstreamRecord(
    response.object,
    'GitHub branch reference response.object'
  );
  return {
    object: {
      sha: assertExactShaWithStatus(
        object.sha,
        'GitHub branch reference response.object.sha',
        502
      ),
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
  if (
    fork.full_name.toLowerCase() !==
    `${owner.login}/${fork.name}`.toLowerCase()
  ) {
    throw new WorkerHttpError(502, `${label} identity fields disagree`);
  }
  const projected = {
    full_name: fork.full_name,
    name: fork.name,
    owner: { login: owner.login },
  };
  if (fork.parent !== undefined) {
    const parent = assertUpstreamRecord(fork.parent, `${label}.parent`);
    if (!isCanonicalGitHubRepositoryFullName(parent.full_name)) {
      throw new WorkerHttpError(
        502,
        `${label}.parent.full_name must be canonical`
      );
    }
    projected.parent = { full_name: parent.full_name };
  }
  return projected;
}

function projectForks(document) {
  if (!Array.isArray(document)) {
    throw new WorkerHttpError(502, 'GitHub forks response must be an array');
  }
  if (document.length > GITHUB_PAGE_SIZE) {
    throw new WorkerHttpError(
      502,
      `GitHub forks response exceeds ${GITHUB_PAGE_SIZE} entries`
    );
  }
  return document.map((fork, index) =>
    projectForkRecord(fork, `GitHub fork ${index}`)
  );
}

function projectPullRequest(document, label) {
  const pullRequest = assertUpstreamRecord(document, label);
  return {
    number: assertUpstreamPositiveInteger(
      pullRequest.number,
      `${label}.number`
    ),
    html_url: assertUpstreamHttpsUrl(
      pullRequest.html_url,
      `${label}.html_url`
    ),
  };
}

function projectPullRequests(document) {
  if (!Array.isArray(document)) {
    throw new WorkerHttpError(
      502,
      'GitHub Pull Request lookup response must be an array'
    );
  }
  if (document.length > GITHUB_PAGE_SIZE) {
    throw new WorkerHttpError(
      502,
      `GitHub Pull Request lookup exceeds ${GITHUB_PAGE_SIZE} entries`
    );
  }
  return document.map((pullRequest, index) =>
    projectPullRequest(pullRequest, `GitHub Pull Request ${index}`)
  );
}

function projectGitHubProxyResponse(kind, document) {
  if (kind === 'repository-metadata') {
    return projectRepositoryMetadata(document);
  }
  if (kind === 'repository-fork-identity') {
    return projectRepositoryForkIdentity(document);
  }
  if (kind === 'contents-put') return projectContentPut(document);
  if (kind === 'git-ref-get') return projectGitRef(document);
  if (kind === 'git-refs-post') {
    assertUpstreamRecord(document, 'Git branch creation response');
    return {};
  }
  if (kind === 'forks-get') return projectForks(document);
  if (kind === 'forks-post') {
    return projectForkRecord(document, 'GitHub fork creation response');
  }
  if (kind === 'pulls-get') return projectPullRequests(document);
  if (kind === 'pulls-post') {
    return projectPullRequest(document, 'GitHub Pull Request creation response');
  }
  throw new WorkerHttpError(500, 'Unknown GitHub proxy response contract');
}

async function handleApiProxy(request, url, corsHeaders, requestScope) {
  if (
    request.method !== 'GET' &&
    request.method !== 'POST' &&
    request.method !== 'PUT'
  ) {
    throw new WorkerHttpError(
      405,
      `GitHub API proxy does not support ${request.method}`
    );
  }
  const githubPath = url.pathname.slice('/api'.length);
  if (!githubPath.startsWith('/repos/')) {
    throw new WorkerHttpError(
      404,
      'GitHub API proxy supports only /api/repos/*'
    );
  }
  const githubUrl = new URL(githubPath, GITHUB_API_ORIGIN);
  githubUrl.search = url.search;
  if (
    githubUrl.origin !== GITHUB_API_ORIGIN ||
    !githubUrl.pathname.startsWith('/repos/')
  ) {
    throw new WorkerHttpError(400, 'Invalid GitHub repository API path');
  }
  const route = assertAllowedGitHubProxyRoute(githubUrl, request.method);
  if (route.stripQueryBeforeUpstream === true) {
    githubUrl.search = '';
  }
  const mutationContext = createGitHubMutationContext(
    request,
    route.kind
  );
  let safeResponseHeaders = null;

  try {
    const token = getBearerToken(request);
    const headers = createGitHubHeaders(token);
    let body;
    if (request.method !== 'GET') {
      const document = await readExactRequestObject(
        request,
        'GitHub API proxy request',
        null,
        requestScope
      );
      validateGitHubProxyMutationBody(route.kind, document);
      body = JSON.stringify(document);
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetchUpstream(
      githubUrl,
      {
        method: request.method,
        headers,
        body,
      },
      `GitHub API ${request.method} ${githubPath}`,
      requestScope,
      mutationContext
    );
    safeResponseHeaders = createSafeGitHubResponseHeaders(response);
    const streamedMaxBytes =
      route.kind === 'contents-get' ||
      route.kind === 'git-blob-get'
        ? GITHUB_CONTENT_RESPONSE_MAX_BYTES
        : route.kind === 'git-tree-get'
          ? GITHUB_TREE_RESPONSE_MAX_BYTES
          : null;
    if (response.ok && streamedMaxBytes !== null) {
      return streamBoundedGitHubJsonResponse(
        response,
        `GitHub API ${request.method} ${githubPath} response`,
        {
          maxBytes: streamedMaxBytes,
          headers: mergeHeaders(corsHeaders, safeResponseHeaders),
          requestScope,
        }
      );
    }
    const document = await parseResponseJson(
      response,
      `GitHub API ${request.method} ${githubPath} response`,
      requestScope
    );
    if (!response.ok) {
      const outcome =
        response.status === 408 || response.status >= 500
          ? 'unknown'
          : 'not-applied';
      const responseHeaders = mergeHeaders(
        corsHeaders,
        safeResponseHeaders,
        mutationContext?.responseHeaders(outcome)
      );
      return jsonResponse(
        {
          error: upstreamErrorMessage(
            document,
            `GitHub API ${request.method} ${githubPath} failed`
          ),
        },
        response.status,
        responseHeaders
      );
    }
    const responseHeaders = mergeHeaders(
      corsHeaders,
      safeResponseHeaders,
      mutationContext?.responseHeaders('applied')
    );
    return jsonResponse(
      projectGitHubProxyResponse(route.kind, document),
      response.status,
      responseHeaders
    );
  } catch (error) {
    if (mutationContext !== null) {
      throw mutationContext.decorateError(error, safeResponseHeaders);
    }
    if (error && typeof error === 'object') {
      error.responseHeaders = mergeHeaders(
        error.responseHeaders,
        safeResponseHeaders
      );
    }
    throw error;
  }
}

function createGitHubHeaders(token) {
  return new Headers({
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'Cellucid-GitHub-App',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  });
}

async function githubFetchJson(
  path,
  token,
  requestScope,
  maxBytes = GITHUB_STANDARD_RESPONSE_BODY_MAX_BYTES
) {
  const response = await fetchUpstream(
    `${GITHUB_API_ORIGIN}${path}`,
    { headers: createGitHubHeaders(token) },
    `GitHub API GET ${path}`,
    requestScope
  );
  const document = await parseResponseJson(
    response,
    `GitHub API GET ${path} response`,
    requestScope,
    maxBytes
  );
  return { response, document };
}

async function githubFetchCollection(
  path,
  token,
  field,
  projectItem,
  requestScope
) {
  if (typeof projectItem !== 'function') {
    throw new WorkerHttpError(
      500,
      `GitHub ${field} collection projector is invalid`
    );
  }
  const fetchPage = async (page) => {
    const separator = path.includes('?') ? '&' : '?';
    const pagePath =
      `${path}${separator}per_page=${GITHUB_PAGE_SIZE}&page=${page}`;
    requestScope.throwIfAborted();
    return githubFetchJson(
      pagePath,
      token,
      requestScope,
      GITHUB_COLLECTION_PAGE_MAX_BYTES
    );
  };

  const projectPageItems = (document, totalCount, page, pageCount) => {
    const pageTotal = document?.total_count;
    const pageItems = document?.[field];
    if (!Number.isSafeInteger(pageTotal) || pageTotal < 0) {
      throw new WorkerHttpError(
        502,
        `GitHub ${field} response has an invalid total_count`
      );
    }
    if (!Array.isArray(pageItems)) {
      throw new WorkerHttpError(
        502,
        `GitHub ${field} response is missing ${field}`
      );
    }
    if (pageTotal !== totalCount) {
      throw new WorkerHttpError(
        502,
        `GitHub ${field} total_count changed during pagination`
      );
    }
    const expectedLength =
      page < pageCount
        ? GITHUB_PAGE_SIZE
        : totalCount - GITHUB_PAGE_SIZE * (pageCount - 1);
    if (pageItems.length !== expectedLength) {
      throw new WorkerHttpError(
        502,
        `GitHub ${field} page ${page} must contain exactly ${expectedLength} items`
      );
    }
    const baseIndex = (page - 1) * GITHUB_PAGE_SIZE;
    return pageItems.map((item, index) =>
      projectItem(item, baseIndex + index)
    );
  };

  const first = await fetchPage(1);
  if (!first.response.ok) {
    return {
      response: first.response,
      errorDocument: first.document,
      items: null,
    };
  }
  const totalCount = first.document?.total_count;
  if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
    throw new WorkerHttpError(
      502,
      `GitHub ${field} response has an invalid total_count`
    );
  }
  if (totalCount > GITHUB_COLLECTION_MAX_ITEMS) {
    throw new WorkerHttpError(
      502,
      `GitHub ${field} total_count exceeds ${GITHUB_COLLECTION_MAX_ITEMS}`
    );
  }
  const pageCount = Math.max(
    1,
    Math.ceil(totalCount / GITHUB_PAGE_SIZE)
  );
  const pages = new Array(pageCount);
  pages[0] = projectPageItems(
    first.document,
    totalCount,
    1,
    pageCount
  );
  let finalResponse =
    pageCount === 1 ? first.response : null;

  let nextPage = 2;
  let primaryError = null;
  let primaryFailure = null;
  const workerCount = Math.min(
    GITHUB_COLLECTION_CONCURRENCY,
    pageCount - 1
  );
  const workers = Array.from({ length: workerCount }, async () => {
    while (primaryError === null && primaryFailure === null) {
      const page = nextPage;
      nextPage += 1;
      if (page > pageCount) return;
      try {
        const result = await fetchPage(page);
        if (!result.response.ok) {
          if (primaryError === null && primaryFailure === null) {
            primaryFailure = {
              response: result.response,
              errorDocument: result.document,
              items: null,
            };
            requestScope.cancelInternal(
              new Error(`GitHub ${field} page ${page} failed`)
            );
          }
          return;
        }
        pages[page - 1] = projectPageItems(
          result.document,
          totalCount,
          page,
          pageCount
        );
        if (page === pageCount) finalResponse = result.response;
      } catch (error) {
        if (primaryError === null && primaryFailure === null) {
          primaryError = error;
          requestScope.cancelInternal(error);
        }
        return;
      }
    }
  });
  await Promise.all(workers);
  if (primaryFailure !== null) return primaryFailure;
  if (primaryError !== null) throw primaryError;

  const items = [];
  for (const pageItems of pages) {
    items.push(...pageItems);
  }
  return {
    response: finalResponse ?? first.response,
    errorDocument: null,
    items,
  };
}

async function fetchUpstream(
  url,
  options,
  label,
  requestScope,
  mutationContext = null
) {
  requestScope.throwIfAborted();
  try {
    mutationContext?.markForwarded();
    const response = await awaitWithinWorkerRequestScope(
      fetch(url, {
        ...options,
        signal: requestScope.signal,
      }),
      requestScope
    );
    requestScope.throwIfAborted();
    return response;
  } catch (cause) {
    if (cause instanceof WorkerHttpError) throw cause;
    const ownedAbort = requestScope.createAbortError();
    if (ownedAbort !== null) throw ownedAbort;
    throw new WorkerHttpError(
      502,
      `${label} could not be reached`,
      { cause }
    );
  }
}

async function parseResponseJson(
  response,
  label,
  requestScope,
  maxBytes = GITHUB_STANDARD_RESPONSE_BODY_MAX_BYTES
) {
  const text = await readBoundedUtf8Body(response, label, {
    maxBytes,
    readErrorStatus: 502,
    tooLargeStatus: 502,
    requestScope,
  });
  if (!text) {
    throw new WorkerHttpError(502, `${label} is empty`);
  }
  try {
    return parseExactJson(text, { path: label });
  } catch (cause) {
    throw new WorkerHttpError(502, `${label} contains invalid JSON`, {
      cause,
    });
  }
}
