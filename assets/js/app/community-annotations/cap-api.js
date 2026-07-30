/**
 * @fileoverview Cell Annotation Platform (CAP) proxy client.
 *
 * The browser never sends GraphQL text or APQ material. It calls the fixed CAP
 * routes on the trusted Cellucid Worker, which owns the persisted operations
 * and validates the upstream projection.
 *
 * Privacy: search terms are relayed by the configured Cellucid Worker to CAP.
 *
 * @module community-annotations/cap-api
 */

import { getGitHubWorkerOrigin } from './github-auth.js';
import { parseExactJson } from './wire-contract.js';

const CAP_DEFAULT_TIMEOUT_MS = 12_000;
const CAP_WORKER_CONTRACT_VERSION = 1;
const CAP_REQUEST_BODY_MAX_BYTES = 4 * 1024;
const CAP_RESPONSE_BODY_MAX_BYTES = 8 * 1024 * 1024;
const CAP_LOOKUP_LIMIT = 25;
const CAP_DATASET_LIMIT = 10;
const CAP_TERM_MAX_CODEPOINTS = 256;
const CAP_MARKER_TERM_MAX_CODEPOINTS = (50 * 64) + 49;
const CAP_RESULT_TEXT_MAX_CODEPOINTS = 512;
const CAP_RESULT_ID_MAX_CODEPOINTS = 64;
const CAP_RESULT_GENE_MAX_CODEPOINTS = 64;
const CAP_RESULT_SYNONYM_LIMIT = 100;
const CAP_RESULT_MARKER_LIMIT = 200;

const LOOKUP_KINDS = new Set(['name', 'ontology', 'marker', 'feedback']);
const LOOKUP_RESULT_KEYS = [
  'canonicalMarkerGenes',
  'count',
  'fullName',
  'id',
  'markerGenes',
  'name',
  'ontologyTerm',
  'ontologyTermId',
  'scores',
  'synonyms',
];
const DATASET_RESULT_KEYS = ['cellCount', 'id', 'name'];

function toCleanString(value) {
  return String(value ?? '').trim();
}

function exceedsCodePointLimit(value, maximum) {
  if (value.length <= maximum) return false;
  if (value.length > maximum * 2) return true;
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return true;
  }
  return false;
}

function assertExactObject(value, label, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const actual = Object.keys(value).sort();
  const expected = expectedKeys.slice().sort();
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])
  ) {
    throw new Error(`${label} must contain exactly ${expected.join(', ')}`);
  }
  return value;
}

function assertBoundedString(value, label, maxCodePoints, {
  nullable = false,
  nonblank = true,
} = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`${label} must be ${nullable ? 'a string or null' : 'a string'}`);
  }
  if (
    (nonblank && (!value || /^\s|\s$/.test(value) || !/\S/.test(value))) ||
    exceedsCodePointLimit(value, maxCodePoints)
  ) {
    throw new Error(
      `${label} must be ${nonblank ? 'an exact nonblank ' : 'an exact '}string of at most ` +
      `${maxCodePoints} Unicode code points`
    );
  }
  return value;
}

function assertNonnegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function assertExactStringArray(value, label, {
  maxItems,
  maxCodePoints,
} = {}) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} must be an array of at most ${maxItems} strings`);
  }
  return value.map((entry, index) => (
    assertBoundedString(
      entry,
      `${label}[${index}]`,
      maxCodePoints
    )
  ));
}

function assertAbortSignalOrNull(signal) {
  if (
    signal !== null &&
    (
      typeof signal !== 'object' ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function'
    )
  ) {
    throw new TypeError('CAP request signal must be an AbortSignal or exact null');
  }
  return signal;
}

function assertTimeoutMs(timeoutMs) {
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0
  ) {
    throw new Error('CAP timeoutMs must be a nonnegative safe integer');
  }
  return timeoutMs;
}

function createAbortError(message, cause = undefined) {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'CAP_REQUEST_ABORTED';
  if (cause !== undefined) error.cause = cause;
  return error;
}

function ownerAbortReason(signal, fallbackCause = undefined) {
  if (signal?.reason instanceof Error) return signal.reason;
  return createAbortError('CAP request was cancelled', fallbackCause);
}

function createRequestAbortScope(signal, timeoutMs) {
  const ownerSignal = assertAbortSignalOrNull(signal);
  const ms = assertTimeoutMs(timeoutMs);
  if (typeof AbortController !== 'function') {
    throw new Error('AbortController is required for CAP requests');
  }
  const controller = new AbortController();
  let abortCause = null;
  const abort = (cause, reason = undefined) => {
    if (abortCause !== null) return;
    abortCause = cause;
    controller.abort(reason);
  };
  const abortFromOwner = () => abort('owner', ownerSignal?.reason);
  if (ownerSignal !== null) {
    if (ownerSignal.aborted) abortFromOwner();
    else ownerSignal.addEventListener('abort', abortFromOwner, { once: true });
  }

  /** @type {ReturnType<typeof setTimeout>|null} */
  let timeout = null;
  if (ms > 0) {
    try {
      timeout = setTimeout(() => {
        abort('timeout', createAbortError(`CAP request timed out after ${ms}ms`));
      }, ms);
    } catch (error) {
      ownerSignal?.removeEventListener('abort', abortFromOwner);
      throw error;
    }
  }

  return {
    controller,
    ownerSignal,
    abortCause: () => abortCause,
    cleanup() {
      try {
        if (timeout !== null) clearTimeout(timeout);
      } catch {
        // Request cleanup cannot replace its primary outcome.
      }
      try {
        ownerSignal?.removeEventListener('abort', abortFromOwner);
      } catch {
        // Request cleanup cannot replace its primary outcome.
      }
    },
  };
}

function throwIfAborted(scope, cause = undefined) {
  const abortCause = scope.abortCause();
  if (abortCause === 'owner') {
    throw ownerAbortReason(scope.ownerSignal, cause);
  }
  if (abortCause === 'timeout') {
    const error = new Error('CAP request timed out');
    error.code = 'CAP_REQUEST_TIMEOUT';
    if (cause !== undefined) error.cause = cause;
    throw error;
  }
}

function isNetworkError(error) {
  if (error instanceof TypeError) return true;
  const message = toCleanString(error?.message);
  return /failed to fetch|load failed|networkerror|fetch failed/i.test(message);
}

function workerUrl(path) {
  if (path !== '/cap/lookup-cells' && path !== '/cap/search-datasets') {
    throw new Error('CAP proxy path is not an approved persisted operation');
  }
  return `${getGitHubWorkerOrigin()}${path}`;
}

function parseWorkerError(value, status) {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof value.error === 'string' &&
    value.error &&
    !/^\s|\s$/.test(value.error) &&
    !exceedsCodePointLimit(
      value.error,
      CAP_RESULT_TEXT_MAX_CODEPOINTS
    )
  ) {
    return value.error;
  }
  return `HTTP ${status}`;
}

function createCapError(message, code, cause = undefined) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

async function cancelResponseBodyPreservingOutcome(response) {
  if (response?.body && typeof response.body.cancel === 'function') {
    try {
      await response.body.cancel();
    } catch {
      // Preserve the authoritative response-boundary outcome.
    }
  }
}

function assertResponseContentLength(response) {
  const raw = response?.headers?.get?.('content-length') ?? null;
  if (raw === null || raw === '') return;
  if (!/^\d+$/.test(raw)) return;
  const byteLength = Number(raw);
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength > CAP_RESPONSE_BODY_MAX_BYTES
  ) {
    throw createCapError(
      `CAP proxy response exceeds ${CAP_RESPONSE_BODY_MAX_BYTES} bytes`,
      'CAP_RESPONSE_TOO_LARGE'
    );
  }
}

async function readBoundedResponseText(response) {
  try {
    assertResponseContentLength(response);
  } catch (error) {
    await cancelResponseBodyPreservingOutcome(response);
    throw error;
  }

  const body = response?.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    // Preserve a UTF-8 BOM so the exact JSON boundary rejects it.
    const decoder = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    });
    const chunks = [];
    let byteLength = 0;
    let streamDone = false;
    let readerCancelled = false;
    const cancelLiveReader = async () => {
      if (streamDone || readerCancelled) return;
      readerCancelled = true;
      try {
        await reader.cancel();
      } catch {
        // Preserve the authoritative response-boundary outcome.
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          streamDone = true;
          break;
        }
        if (!(value instanceof Uint8Array)) {
          throw createCapError(
            'CAP proxy response stream returned a non-byte chunk',
            'CAP_RESPONSE_INVALID'
          );
        }
        byteLength += value.byteLength;
        if (byteLength > CAP_RESPONSE_BODY_MAX_BYTES) {
          const sizeError = createCapError(
            `CAP proxy response exceeds ${CAP_RESPONSE_BODY_MAX_BYTES} bytes`,
            'CAP_RESPONSE_TOO_LARGE'
          );
          await cancelLiveReader();
          throw sizeError;
        }
        try {
          chunks.push(decoder.decode(value, { stream: true }));
        } catch (cause) {
          throw createCapError(
            'CAP proxy response is not valid UTF-8',
            'CAP_RESPONSE_INVALID',
            cause
          );
        }
      }
      try {
        chunks.push(decoder.decode());
      } catch (cause) {
        throw createCapError(
          'CAP proxy response is not valid UTF-8',
          'CAP_RESPONSE_INVALID',
          cause
        );
      }
      return chunks.join('');
    } catch (cause) {
      await cancelLiveReader();
      throw cause;
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        // Stream cleanup cannot replace its primary outcome.
      }
    }
  }

  // Non-streaming path: the platform allocates response.text() before we can
  // measure it. Content-Length is still preflighted and the decoded byte count
  // is enforced, but streaming browsers take the bounded path above.
  const text = await response.text();
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > CAP_RESPONSE_BODY_MAX_BYTES) {
    throw createCapError(
      `CAP proxy response exceeds ${CAP_RESPONSE_BODY_MAX_BYTES} bytes`,
      'CAP_RESPONSE_TOO_LARGE'
    );
  }
  return text;
}

async function executeProxy(path, body, {
  signal = null,
  timeoutMs = CAP_DEFAULT_TIMEOUT_MS,
} = {}) {
  assertExactObject(
    body,
    'CAP proxy request body',
    path === '/cap/lookup-cells'
      ? ['kind', 'term', 'limit']
      : ['search', 'limit']
  );
  const scope = createRequestAbortScope(signal, timeoutMs);
  try {
    throwIfAborted(scope);
    const requestBody = JSON.stringify(body);
    if (
      new TextEncoder().encode(requestBody).byteLength >
      CAP_REQUEST_BODY_MAX_BYTES
    ) {
      throw createCapError(
        `CAP proxy request exceeds ${CAP_REQUEST_BODY_MAX_BYTES} bytes`,
        'CAP_REQUEST_TOO_LARGE'
      );
    }
    const response = await fetch(workerUrl(path), {
      method: 'POST',
      credentials: 'omit',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: requestBody,
      signal: scope.controller.signal,
    });
    throwIfAborted(scope);

    const text = await readBoundedResponseText(response);
    throwIfAborted(scope);

    if (!response.ok) {
      if (response.status === 404) {
        throw createCapError(
          'CAP proxy route is unavailable; deploy the matching Cellucid Worker source',
          'CAP_WORKER_INCOMPATIBLE'
        );
      }
      let detail = `HTTP ${response.status}`;
      if (text) {
        try {
          const errorDocument = parseExactJson(text, {
            path: `CAP proxy ${path} error response`,
          });
          const workerDetail = parseWorkerError(
            errorDocument,
            response.status
          );
          if (workerDetail !== detail) {
            detail = `${detail}: ${workerDetail}`;
          }
        } catch {
          // An untrusted non-success body cannot replace its HTTP outcome.
        }
      }
      throw new Error(`CAP proxy error: ${detail}`);
    }

    let document;
    try {
      if (!text) throw new Error('empty response body');
      document = parseExactJson(text, { path: `CAP proxy ${path} response` });
    } catch (cause) {
      throw new Error(`CAP proxy returned invalid JSON: ${cause?.message || cause}`, {
        cause,
      });
    }
    return assertExactObject(
      document,
      `CAP proxy ${path} response`,
      ['contractVersion', 'results', 'omittedInvalidCount']
    );
  } catch (error) {
    throwIfAborted(scope, error);
    if (error?.name === 'AbortError') {
      throw createCapError(
        'CAP proxy request was independently aborted by fetch',
        'CAP_FETCH_ABORTED',
        error
      );
    }
    if (isNetworkError(error)) {
      throw new Error('CAP proxy unreachable (network error)', { cause: error });
    }
    throw error;
  } finally {
    scope.cleanup();
  }
}

function validateLookupResult(value, index) {
  const path = `CAP lookup results[${index}]`;
  const item = assertExactObject(value, path, LOOKUP_RESULT_KEYS);
  const scores = assertExactObject(
    item.scores,
    `${path}.scores`,
    ['agree', 'disagree', 'idk']
  );
  const agree = assertNonnegativeSafeInteger(scores.agree, `${path}.scores.agree`);
  const disagree = assertNonnegativeSafeInteger(scores.disagree, `${path}.scores.disagree`);
  const idk = assertNonnegativeSafeInteger(scores.idk, `${path}.scores.idk`);
  const scoreTotal = agree + disagree + idk;
  if (!Number.isSafeInteger(scoreTotal)) {
    throw new Error(`${path}.scores total must be a safe integer`);
  }
  return {
    id: assertBoundedString(item.id, `${path}.id`, CAP_RESULT_ID_MAX_CODEPOINTS),
    name: assertBoundedString(item.name, `${path}.name`, CAP_RESULT_TEXT_MAX_CODEPOINTS),
    fullName: assertBoundedString(
      item.fullName,
      `${path}.fullName`,
      CAP_RESULT_TEXT_MAX_CODEPOINTS
    ),
    ontologyTerm: assertBoundedString(
      item.ontologyTerm,
      `${path}.ontologyTerm`,
      CAP_RESULT_TEXT_MAX_CODEPOINTS,
      { nullable: true }
    ),
    ontologyTermId: assertBoundedString(
      item.ontologyTermId,
      `${path}.ontologyTermId`,
      CAP_RESULT_ID_MAX_CODEPOINTS,
      { nullable: true }
    ),
    synonyms: assertExactStringArray(item.synonyms, `${path}.synonyms`, {
      maxItems: CAP_RESULT_SYNONYM_LIMIT,
      maxCodePoints: CAP_RESULT_TEXT_MAX_CODEPOINTS,
    }),
    markerGenes: assertExactStringArray(item.markerGenes, `${path}.markerGenes`, {
      maxItems: CAP_RESULT_MARKER_LIMIT,
      maxCodePoints: CAP_RESULT_GENE_MAX_CODEPOINTS,
    }),
    canonicalMarkerGenes: assertExactStringArray(
      item.canonicalMarkerGenes,
      `${path}.canonicalMarkerGenes`,
      {
        maxItems: CAP_RESULT_MARKER_LIMIT,
        maxCodePoints: CAP_RESULT_GENE_MAX_CODEPOINTS,
      }
    ),
    count: assertNonnegativeSafeInteger(item.count, `${path}.count`),
    scores: { agree, disagree, idk },
  };
}

function validateDatasetResult(value, index) {
  const path = `CAP dataset results[${index}]`;
  const item = assertExactObject(value, path, DATASET_RESULT_KEYS);
  return {
    id: assertBoundedString(item.id, `${path}.id`, CAP_RESULT_ID_MAX_CODEPOINTS),
    name: assertBoundedString(item.name, `${path}.name`, CAP_RESULT_TEXT_MAX_CODEPOINTS),
    cellCount: assertNonnegativeSafeInteger(item.cellCount, `${path}.cellCount`),
  };
}

function validateEnvelope(document, validator, label, maxResults) {
  if (document.contractVersion !== CAP_WORKER_CONTRACT_VERSION) {
    throw createCapError(
      `${label}.contractVersion does not match this Cellucid client; ` +
      'deploy the matching Cellucid Worker source',
      'CAP_WORKER_INCOMPATIBLE'
    );
  }
  if (
    !Array.isArray(document.results) ||
    document.results.length > maxResults
  ) {
    throw new Error(`${label}.results must be an array of at most ${maxResults} items`);
  }
  const omittedInvalidCount = assertNonnegativeSafeInteger(
    document.omittedInvalidCount,
    `${label}.omittedInvalidCount`
  );
  const projectedCount = document.results.length + omittedInvalidCount;
  if (
    !Number.isSafeInteger(projectedCount) ||
    projectedCount > maxResults
  ) {
    throw new Error(
      `${label} results plus omittedInvalidCount must not exceed ${maxResults}`
    );
  }
  return {
    results: document.results.map((entry, index) => validator(entry, index)),
    omittedInvalidCount,
  };
}

function normalizeForSearch(value) {
  const string = toCleanString(value);
  if (!string) return '';
  return string
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeSearch(value) {
  const normalized = normalizeForSearch(value);
  if (!normalized) return [];
  const parts = normalized.split(' ').filter(Boolean);
  const isMulti = parts.length > 1;
  const seen = new Set();
  const output = [];
  for (const part of parts) {
    if (isMulti && part.length < 2) continue;
    if (seen.has(part)) continue;
    seen.add(part);
    output.push(part);
  }
  return output;
}

function computeStringMatchScore(value, context) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return 0;
  const rawLower = raw.toLowerCase();
  const normalized = normalizeForSearch(raw);
  const searchLower = context.searchLower;
  const searchNorm = context.searchNorm;
  const tokens = context.tokens;
  let best = 0;

  if (rawLower === searchLower) best = Math.max(best, 1000);
  if (searchNorm && normalized === searchNorm) best = Math.max(best, 950);
  if (rawLower.startsWith(searchLower)) {
    best = Math.max(best, 900 - Math.min(250, rawLower.length - searchLower.length));
  }
  if (searchNorm && normalized.startsWith(searchNorm)) {
    best = Math.max(best, 850 - Math.min(250, normalized.length - searchNorm.length));
  }
  const rawIndex = rawLower.indexOf(searchLower);
  if (rawIndex >= 0) best = Math.max(best, 700 - rawIndex);
  if (searchNorm) {
    const normalizedIndex = normalized.indexOf(searchNorm);
    if (normalizedIndex >= 0) best = Math.max(best, 650 - normalizedIndex);
  }

  if (tokens.length) {
    let matches = 0;
    for (const token of tokens) {
      if (normalized.includes(token)) matches += 1;
    }
    if (matches === tokens.length) best = Math.max(best, 600);
    else if (matches > 0) {
      best = Math.max(best, 420 + Math.round((matches / tokens.length) * 120));
    }
  }
  return best;
}

function normalizeMarkerKey(value) {
  return value.replace(/\s+/g, '').toUpperCase();
}

function normalizeMarkerSearchInput(markerGenes) {
  if (markerGenes === null) return [];
  if (!Array.isArray(markerGenes)) {
    throw new Error('CAP markerGenes must be an array or null');
  }
  if (markerGenes.length > 50) {
    throw new Error('CAP markerGenes must contain at most 50 items');
  }
  const seen = new Set();
  const output = [];
  for (let index = 0; index < markerGenes.length; index++) {
    const gene = assertBoundedString(
      markerGenes[index],
      `CAP markerGenes[${index}]`,
      CAP_RESULT_GENE_MAX_CODEPOINTS
    );
    const key = normalizeMarkerKey(gene);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(gene);
  }
  return output;
}

function markerMatchInfo(result, markerGenes) {
  const wanted = new Set(markerGenes.map(normalizeMarkerKey));
  if (!wanted.size) return { markerMatchCount: 0, wantedCount: 0 };
  const available = new Set();
  for (const gene of result.markerGenes) available.add(normalizeMarkerKey(gene));
  for (const gene of result.canonicalMarkerGenes) available.add(normalizeMarkerKey(gene));
  let markerMatchCount = 0;
  for (const key of wanted) {
    if (available.has(key)) markerMatchCount += 1;
  }
  return { markerMatchCount, wantedCount: wanted.size };
}

function computeCellTypeRelevance(result, context, markerGenes) {
  const { markerMatchCount, wantedCount } = markerMatchInfo(result, markerGenes);
  let score = 0;
  score = Math.max(score, computeStringMatchScore(result.ontologyTermId, context) * 1.25);
  score = Math.max(score, computeStringMatchScore(result.ontologyTerm, context) * 1.05);
  score = Math.max(score, computeStringMatchScore(result.fullName, context));
  score = Math.max(score, computeStringMatchScore(result.name, context));
  for (const synonym of result.synonyms) {
    score = Math.max(score, computeStringMatchScore(synonym, context) * 0.85);
  }
  for (const gene of result.markerGenes) {
    score = Math.max(score, computeStringMatchScore(gene, context) * 0.8);
  }
  for (const gene of result.canonicalMarkerGenes) {
    score = Math.max(score, computeStringMatchScore(gene, context) * 0.75);
  }
  if (markerMatchCount > 0) {
    score += 140 * markerMatchCount;
    if (wantedCount > 0 && markerMatchCount === wantedCount) score += 180;
  }
  return { score, markerMatchCount };
}

function compareCodeUnits(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function displayName(result) {
  return result.fullName || result.ontologyTerm || result.name;
}

function dedupeKey(result, sourceIndex) {
  const ontologyId = result.ontologyTermId?.toLowerCase() || '';
  if (ontologyId) return `ontology:${ontologyId}`;
  const name = normalizeForSearch(displayName(result));
  if (name) return `name:${name}`;
  if (result.id) return `id:${result.id.toLowerCase()}`;
  return `source:${sourceIndex}`;
}

function rankAndDedupe(results, searchTerm, markerGenes, limit) {
  const trimmed = searchTerm.trim();
  const context = {
    searchLower: trimmed.toLowerCase(),
    searchNorm: normalizeForSearch(trimmed),
    tokens: tokenizeSearch(trimmed),
  };
  const ranked = results.map((result, sourceIndex) => {
    const relevance = computeCellTypeRelevance(result, context, markerGenes);
    return { result, sourceIndex, ...relevance };
  }).filter((entry) => (
    entry.score > 0 &&
    (!markerGenes.length || entry.markerMatchCount > 0)
  ));

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.markerMatchCount !== left.markerMatchCount) {
      return right.markerMatchCount - left.markerMatchCount;
    }
    if (right.result.count !== left.result.count) {
      return right.result.count - left.result.count;
    }
    const byName = compareCodeUnits(
      displayName(left.result).toLowerCase(),
      displayName(right.result).toLowerCase()
    );
    if (byName !== 0) return byName;
    const byId = compareCodeUnits(left.result.id.toLowerCase(), right.result.id.toLowerCase());
    if (byId !== 0) return byId;
    return left.sourceIndex - right.sourceIndex;
  });

  const seen = new Set();
  const output = [];
  for (const entry of ranked) {
    const key = dedupeKey(entry.result, entry.sourceIndex);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(entry.result);
    if (output.length === limit) break;
  }
  return output;
}

function assertLookupKind(kind) {
  if (!LOOKUP_KINDS.has(kind)) {
    throw new Error('CAP lookup kind must equal name, ontology, marker, or feedback');
  }
  return kind;
}

function assertSearchTerm(value, kind) {
  if (typeof value !== 'string') {
    throw new Error('CAP search term must be a string');
  }
  const term = value.trim();
  if (!term) return '';
  const maximum = kind === 'marker'
    ? CAP_MARKER_TERM_MAX_CODEPOINTS
    : CAP_TERM_MAX_CODEPOINTS;
  if (exceedsCodePointLimit(term, maximum)) {
    throw new Error(`CAP ${kind} term must be at most ${maximum} Unicode code points`);
  }
  return term;
}

function assertLimit(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function assertOptions(options, allowedKeys, label) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error(`${label} must be an object`);
  }
  const unknown = Object.keys(options).filter((key) => !allowedKeys.includes(key));
  if (unknown.length) {
    throw new Error(`${label} contains unknown option ${JSON.stringify(unknown[0])}`);
  }
  return options;
}

/**
 * Search CAP cell-label metadata.
 *
 * @returns {Promise<{results:Object[], omittedInvalidCount:number}>}
 */
export async function searchCellTypes(searchTerm, limit = 10, options = {}) {
  assertLimit(limit, CAP_LOOKUP_LIMIT, 'CAP result limit');
  const exactOptions = assertOptions(
    options,
    ['kind', 'markerGenes', 'signal', 'timeoutMs'],
    'CAP search options'
  );
  const kind = assertLookupKind(exactOptions.kind ?? 'name');
  const term = assertSearchTerm(searchTerm, kind);
  if (!term) return { results: [], omittedInvalidCount: 0 };
  const markerGenes = normalizeMarkerSearchInput(exactOptions.markerGenes ?? null);
  const document = await executeProxy(
    '/cap/lookup-cells',
    { kind, term, limit: CAP_LOOKUP_LIMIT },
    {
      signal: exactOptions.signal ?? null,
      timeoutMs: exactOptions.timeoutMs ?? CAP_DEFAULT_TIMEOUT_MS,
    }
  );
  const envelope = validateEnvelope(
    document,
    validateLookupResult,
    'CAP lookup response',
    CAP_LOOKUP_LIMIT
  );
  return {
    results: rankAndDedupe(envelope.results, term, markerGenes, limit),
    omittedInvalidCount: envelope.omittedInvalidCount,
  };
}

export async function lookupByOntologyId(ontologyId, options = {}) {
  const exactOptions = assertOptions(
    options,
    ['signal', 'timeoutMs'],
    'CAP ontology lookup options'
  );
  const term = assertSearchTerm(ontologyId, 'ontology');
  if (!term) return { results: [], omittedInvalidCount: 0 };
  const envelope = await searchCellTypes(term, CAP_LOOKUP_LIMIT, {
    kind: 'ontology',
    ...exactOptions,
  });
  const normalized = term.toLowerCase();
  const match = envelope.results.find(
    (result) => result.ontologyTermId?.toLowerCase() === normalized
  );
  return {
    results: match ? [match] : [],
    omittedInvalidCount: envelope.omittedInvalidCount,
  };
}

export async function lookupByName(name, options = {}) {
  const exactOptions = assertOptions(
    options,
    ['signal', 'timeoutMs'],
    'CAP name lookup options'
  );
  const term = assertSearchTerm(name, 'name');
  if (!term) return { results: [], omittedInvalidCount: 0 };
  const envelope = await searchCellTypes(term, CAP_LOOKUP_LIMIT, {
    kind: 'name',
    ...exactOptions,
  });
  const normalized = term.toLowerCase();
  const match = envelope.results.find((result) => (
    result.fullName.toLowerCase() === normalized ||
    result.name.toLowerCase() === normalized ||
    result.ontologyTerm?.toLowerCase() === normalized ||
    result.synonyms.some((synonym) => synonym.toLowerCase() === normalized)
  ));
  return {
    results: match ? [match] : [],
    omittedInvalidCount: envelope.omittedInvalidCount,
  };
}

export async function getCommunityFeedback(cellTypeName, options = {}) {
  const exactOptions = assertOptions(
    options,
    ['signal', 'timeoutMs'],
    'CAP feedback options'
  );
  const term = assertSearchTerm(cellTypeName, 'feedback');
  if (!term) return { results: [], omittedInvalidCount: 0 };
  const envelope = await searchCellTypes(term, CAP_LOOKUP_LIMIT, {
    kind: 'feedback',
    ...exactOptions,
  });
  const normalized = term.toLowerCase();
  const label = envelope.results.find((result) => (
    result.fullName.toLowerCase() === normalized ||
    result.name.toLowerCase() === normalized
  ));
  if (!label) {
    return { results: [], omittedInvalidCount: envelope.omittedInvalidCount };
  }
  const { agree, disagree, idk } = label.scores;
  const total = agree + disagree + idk;
  if (!Number.isSafeInteger(total)) {
    throw new Error('CAP feedback total must be a safe integer');
  }
  return {
    results: [{
      name: label.fullName || label.name,
      feedback: { agree, disagree, idk },
      total,
      agreePercent: total > 0 ? Math.round((agree / total) * 100) : 0,
    }],
    omittedInvalidCount: envelope.omittedInvalidCount,
  };
}

export async function findSynonyms(cellTypeName, options = {}) {
  const envelope = await lookupByName(cellTypeName, options);
  const label = envelope.results[0] ?? null;
  if (!label) return envelope;
  const allNames = new Set([label.name, label.fullName]);
  if (label.ontologyTerm) allNames.add(label.ontologyTerm);
  const synonyms = label.synonyms.filter((synonym) => synonym !== 'unknown');
  for (const synonym of synonyms) allNames.add(synonym);
  return {
    results: [{
      name: label.fullName || label.name,
      ontologyTermId: label.ontologyTermId,
      synonyms,
      allNames: [...allNames],
    }],
    omittedInvalidCount: envelope.omittedInvalidCount,
  };
}

export async function checkIfSynonyms(name1, name2, options = {}) {
  const exactOptions = assertOptions(
    options,
    ['signal', 'timeoutMs'],
    'CAP synonym comparison options'
  );
  const firstName = assertSearchTerm(name1, 'name');
  const secondName = assertSearchTerm(name2, 'name');
  if (!firstName || !secondName) {
    return {
      results: [{
        areSynonyms: false,
        sharedOntologyId: null,
        canonicalName: null,
      }],
      omittedInvalidCount: 0,
    };
  }
  if (firstName.toLowerCase() === secondName.toLowerCase()) {
    return {
      results: [{
        areSynonyms: true,
        sharedOntologyId: null,
        canonicalName: firstName,
      }],
      omittedInvalidCount: 0,
    };
  }
  const [firstEnvelope, secondEnvelope] = await Promise.all([
    findSynonyms(firstName, exactOptions),
    findSynonyms(secondName, exactOptions),
  ]);
  const omittedInvalidCount =
    firstEnvelope.omittedInvalidCount + secondEnvelope.omittedInvalidCount;
  if (!Number.isSafeInteger(omittedInvalidCount)) {
    throw new Error('CAP combined omittedInvalidCount must be a safe integer');
  }
  const first = firstEnvelope.results[0] ?? null;
  const second = secondEnvelope.results[0] ?? null;
  const firstLower = firstName.toLowerCase();
  const secondLower = secondName.toLowerCase();
  let result = {
    areSynonyms: false,
    sharedOntologyId: null,
    canonicalName: null,
  };
  if (
    first?.ontologyTermId &&
    second?.ontologyTermId &&
    first.ontologyTermId === second.ontologyTermId
  ) {
    result = {
      areSynonyms: true,
      sharedOntologyId: first.ontologyTermId,
      canonicalName: first.name,
    };
  } else if (first?.allNames.some((name) => name.toLowerCase() === secondLower)) {
    result = {
      areSynonyms: true,
      sharedOntologyId: first.ontologyTermId,
      canonicalName: first.name,
    };
  } else if (second?.allNames.some((name) => name.toLowerCase() === firstLower)) {
    result = {
      areSynonyms: true,
      sharedOntologyId: second.ontologyTermId,
      canonicalName: second.name,
    };
  }
  return { results: [result], omittedInvalidCount };
}

export async function searchDatasets(options = {}) {
  const exactOptions = assertOptions(
    options,
    ['search', 'limit', 'signal', 'timeoutMs'],
    'CAP dataset options'
  );
  const search = exactOptions.search ?? null;
  const limit = exactOptions.limit ?? CAP_DATASET_LIMIT;
  const signal = exactOptions.signal ?? null;
  const timeoutMs = exactOptions.timeoutMs ?? CAP_DEFAULT_TIMEOUT_MS;
  assertLimit(limit, CAP_DATASET_LIMIT, 'CAP dataset limit');
  let exactSearch = null;
  if (search !== null) {
    exactSearch = assertSearchTerm(search, 'name');
    if (!exactSearch) exactSearch = null;
  }
  const document = await executeProxy(
    '/cap/search-datasets',
    { search: exactSearch, limit },
    { signal, timeoutMs }
  );
  return validateEnvelope(
    document,
    validateDatasetResult,
    'CAP dataset response',
    limit
  );
}
