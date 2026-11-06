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
import { WORKER_CONTRACT_VERSION } from './worker-contract.js';
import { defaultWorkerTransport, requestWorker } from './worker-request.js';
import { requireExactObjectKeys, requireObjectKeys } from '../../utils/exact-record.js';
import { formatCountOf } from '../../utils/format-units.js';
import { cancelled, isCancellation } from '../../utils/abort.js';
import { toCleanString } from '../../utils/clean-string.js';

const CAP_REQUEST_BODY_MAX_BYTES = 4 * 1024;
/**
 * Results one lookup fetches (the worker's CAP_LOOKUP_LIMIT_MAX). The voting
 * modal asks for all of them, so every fetched result is shown; a term whose
 * matches exceed one lookup is narrowed by the user.
 */
export const CAP_LOOKUP_LIMIT = 25;
const CAP_TERM_MAX_CODEPOINTS = 256;
const CAP_MARKER_TERM_MAX_CODEPOINTS = (50 * 64) + 49;
// A CAP result's strings and arrays have no length limit of their own: a
// result is shown whole.
const CAP_RESULT_UNBOUNDED = Number.MAX_SAFE_INTEGER;
// A gene a marker search may name: the worker accepts at most
// CAP_MARKER_TERM_MAX_CODEPOINTS for the whole marker signature.
const CAP_MARKER_GENE_MAX_CODEPOINTS = 64;
// The worker's own error sentences are short; a longer "error" is not one of
// them, and the status code is shown instead (MSG).
const CAP_WORKER_ERROR_MAX_CODEPOINTS = 512;

const LOOKUP_KINDS = new Set(['name', 'ontology', 'marker']);
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

function assertExactStringArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((entry, index) => (
    assertBoundedString(entry, `${label}[${index}]`, CAP_RESULT_UNBOUNDED)
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

function ownerAbortReason(signal, defaultCause = undefined) {
  if (signal?.reason instanceof Error || isCancellation(signal?.reason)) return signal.reason;
  return cancelled('user', 'CAP request was cancelled.', defaultCause);
}

/** The worker's one CAP route: a fixed persisted cell-type lookup. */
const CAP_LOOKUP_PATH = '/cap/lookup-cells';

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
      CAP_WORKER_ERROR_MAX_CODEPOINTS
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

/**
 * One CAP lookup through the Worker, sent through the app's one transport
 * (`worker-request.js`): a stall timeout from the measured link instead of a
 * fixed deadline, the request budget the Worker states, and retries of busy
 * answers. A request the Worker never answered throws its
 * `GITHUB_WORKER_UNREACHABLE` failure; one the caller stopped throws the
 * caller's reason.
 */
async function executeLookupProxy(body, { signal = null, transport = null } = {}) {
  requireExactObjectKeys(body, ['kind', 'term', 'limit'], 'CAP proxy request body');
  const ownerSignal = assertAbortSignalOrNull(signal);
  if (ownerSignal?.aborted) throw ownerAbortReason(ownerSignal);
  const requestBody = JSON.stringify(body);
  if (new TextEncoder().encode(requestBody).byteLength > CAP_REQUEST_BODY_MAX_BYTES) {
    throw createCapError(
      `CAP proxy request exceeds ${CAP_REQUEST_BODY_MAX_BYTES} bytes`,
      'CAP_REQUEST_TOO_LARGE'
    );
  }
  const origin = getGitHubWorkerOrigin();
  let answer;
  try {
    answer = await requestWorker(
      transport ?? defaultWorkerTransport(origin),
      `${origin}${CAP_LOOKUP_PATH}`,
      {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: requestBody,
      },
      { signal: ownerSignal, label: `CAP lookup (${body.kind})`, origin }
    );
  } catch (error) {
    if (ownerSignal?.aborted) throw ownerAbortReason(ownerSignal, error);
    throw error;
  }
  const { response, text } = answer;

  if (!response.ok) {
    if (response.status === 404) {
      throw createCapError(
        'CAP proxy route is unavailable; deploy the matching Cellucid Worker source',
        'GITHUB_WORKER_INCOMPATIBLE'
      );
    }
    let detail = `HTTP ${response.status}`;
    if (text) {
      try {
        const errorDocument = parseExactJson(text, {
          path: `CAP proxy ${CAP_LOOKUP_PATH} error response`,
        });
        const workerDetail = parseWorkerError(errorDocument, response.status);
        if (workerDetail !== detail) detail = `${detail}: ${workerDetail}`;
      } catch {
        // An untrusted non-success body cannot replace its HTTP outcome.
      }
    }
    const error = new Error(`CAP proxy error: ${detail}`);
    error.status = response.status;
    throw error;
  }

  let document;
  try {
    if (!text) throw new Error('empty response body');
    document = parseExactJson(text, { path: `CAP proxy ${CAP_LOOKUP_PATH} response` });
  } catch (cause) {
    throw createCapError(`CAP proxy returned invalid JSON: ${cause?.message || cause}`, 'CAP_RESPONSE_INVALID', cause);
  }
  return requireExactObjectKeys(
    document,
    ['contractVersion', 'results', 'omittedInvalidCount'],
    `CAP proxy ${CAP_LOOKUP_PATH} response`
  );
}

function validateLookupResult(value, index) {
  const path = `CAP lookup results[${index}]`;
  const item = requireExactObjectKeys(value, LOOKUP_RESULT_KEYS, path);
  const scores = requireExactObjectKeys(item.scores, ['agree', 'disagree', 'idk'], `${path}.scores`);
  const agree = assertNonnegativeSafeInteger(scores.agree, `${path}.scores.agree`);
  const disagree = assertNonnegativeSafeInteger(scores.disagree, `${path}.scores.disagree`);
  const idk = assertNonnegativeSafeInteger(scores.idk, `${path}.scores.idk`);
  const scoreTotal = agree + disagree + idk;
  if (!Number.isSafeInteger(scoreTotal)) {
    throw new Error(`${path}.scores total must be a safe integer`);
  }
  return {
    id: assertBoundedString(item.id, `${path}.id`, CAP_RESULT_UNBOUNDED),
    name: assertBoundedString(item.name, `${path}.name`, CAP_RESULT_UNBOUNDED),
    fullName: assertBoundedString(
      item.fullName,
      `${path}.fullName`,
      CAP_RESULT_UNBOUNDED
    ),
    ontologyTerm: assertBoundedString(
      item.ontologyTerm,
      `${path}.ontologyTerm`,
      CAP_RESULT_UNBOUNDED,
      { nullable: true }
    ),
    ontologyTermId: assertBoundedString(
      item.ontologyTermId,
      `${path}.ontologyTermId`,
      CAP_RESULT_UNBOUNDED,
      { nullable: true }
    ),
    synonyms: assertExactStringArray(item.synonyms, `${path}.synonyms`),
    markerGenes: assertExactStringArray(item.markerGenes, `${path}.markerGenes`),
    canonicalMarkerGenes: assertExactStringArray(
      item.canonicalMarkerGenes,
      `${path}.canonicalMarkerGenes`
    ),
    count: assertNonnegativeSafeInteger(item.count, `${path}.count`),
    scores: { agree, disagree, idk },
  };
}

function validateEnvelope(document, validator, label, maxResults) {
  if (document.contractVersion !== WORKER_CONTRACT_VERSION) {
    const older = Number.isSafeInteger(document.contractVersion) && document.contractVersion < WORKER_CONTRACT_VERSION;
    throw createCapError(
      older
        ? `The community-annotation service runs an older version (contract ${document.contractVersion}) ` +
          `than this Cellucid (contract ${WORKER_CONTRACT_VERSION}); its owner must redeploy the Worker.`
        : `${label}.contractVersion does not match this Cellucid client (contract ${WORKER_CONTRACT_VERSION}); reload Cellucid.`,
      older ? 'GITHUB_WORKER_OUTDATED' : 'GITHUB_WORKER_INCOMPATIBLE'
    );
  }
  if (
    !Array.isArray(document.results) ||
    document.results.length > maxResults
  ) {
    throw new Error(`${label}.results must be an array of at most ${formatCountOf(maxResults, 'item')}`);
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
      CAP_MARKER_GENE_MAX_CODEPOINTS
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
    throw new Error('CAP lookup kind must equal name, ontology, or marker');
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

/**
 * Search CAP cell-label metadata.
 *
 * @returns {Promise<{results:Object[], omittedInvalidCount:number}>}
 */
export async function searchCellTypes(searchTerm, limit = 10, options = {}) {
  assertLimit(limit, CAP_LOOKUP_LIMIT, 'CAP result limit');
  const exactOptions = requireObjectKeys(
    options,
    [],
    ['kind', 'markerGenes', 'signal', 'transport'],
    'CAP search options'
  );
  const kind = assertLookupKind(exactOptions.kind ?? 'name');
  const term = assertSearchTerm(searchTerm, kind);
  if (!term) return { results: [], omittedInvalidCount: 0 };
  const markerGenes = normalizeMarkerSearchInput(exactOptions.markerGenes ?? null);
  const document = await executeLookupProxy(
    { kind, term, limit: CAP_LOOKUP_LIMIT },
    {
      signal: exactOptions.signal ?? null,
      transport: exactOptions.transport ?? null,
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
  const exactOptions = requireObjectKeys(
    options,
    [],
    ['signal', 'transport'],
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
