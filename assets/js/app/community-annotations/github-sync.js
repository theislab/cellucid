/**
 * Community Annotation - GitHub sync (GitHub App OAuth).
 *
 * Static-site friendly GitHub sync using the REST API "contents" endpoints,
 * proxied through a Cloudflare Worker to avoid exposing client secrets.
 * - Pull: list & fetch `annotations/users/ghid_*.json`, merge into local session
 * - Push: write only `annotations/users/ghid_<id>.json`
 *
 * Security:
 * - Never logs tokens.
 * - Avoids DOM usage (UI layer is separate).
 */

import { getGitHubAuthSession, getGitHubWorkerOrigin } from './github-auth.js';
import {
  getAnnotationRepoForDataset,
  getAnnotationRepoMetaForDataset,
  setAnnotationRepoForDataset
} from './repo-store.js';
import {
  ANNOTATION_FILE_MAX_UTF8_BYTES,
  AnnotationFileTooLargeError,
  assertConfigDocument,
  assertMergesDocument,
  assertSchemaIdentity,
  assertUserDocument,
  parseExactJson,
  toAnnotationPublicationBytes,
} from './wire-contract.js';
import {
  isCanonicalGitHubAccount,
  isCanonicalGitHubBranch,
  isCanonicalGitHubRepositoryFullName,
  isCanonicalGitHubRepositoryName,
  parseCanonicalGitHubRepositoryReference,
} from './github-reference.js';

const GITHUB_DEFAULT_TIMEOUT_MS = 20_000;
const GITHUB_FORK_READINESS_ATTEMPTS = 5;
const GITHUB_FORK_READINESS_REQUEST_TIMEOUT_MS = 3_000;
const GITHUB_RENAMED_FORK_LOOKUP_MAX_PAGES = 10;
const GITHUB_RENAMED_FORK_LOOKUP_MAX_ITEMS =
  GITHUB_RENAMED_FORK_LOOKUP_MAX_PAGES * 100;
const GITHUB_RENAMED_FORK_LOOKUP_TIMEOUT_MS = 10_000;
const DEFAULT_USER_PULL_CONCURRENCY = 8;
const MAX_TREE_ITEMS = 100_000;
export const COMMUNITY_ANNOTATION_MAX_PULL_USER_FILES = 10_000;
export const COMMUNITY_ANNOTATION_MAX_PULL_UTF8_BYTES = 64_000_000;
const GITHUB_SHA = /^[0-9a-f]{40}$/;
const ANNOTATION_USERS_DIRECTORY_PATH = 'annotations/users';
const ANNOTATION_USERS_PATH_PREFIX =
  `${ANNOTATION_USERS_DIRECTORY_PATH}/`;
const EMPTY_ANNOTATION_USERS_SENTINEL = Object.freeze({
  path: `${ANNOTATION_USERS_PATH_PREFIX}.gitkeep`,
  sha: '8b137891791fe96927ad78e64b0aad7bded08bdc',
  size: 1,
});
const PUBLICATION_MODES = new Set(['direct', 'fork-pull-request']);
const OPERATION_ID_HEADER = 'X-Cellucid-Operation-Id';
const OPERATION_OUTCOME_HEADER = 'X-Cellucid-Operation-Outcome';
const OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION_OUTCOMES = new Set([
  'applied',
  'not-applied',
  'unknown',
]);

export class CommunityAnnotationPullLimitError extends Error {
  constructor(kind, actual, maximum) {
    const isFiles = kind === 'user-files';
    const unit = isFiles ? 'user files' : 'decoded UTF-8 bytes';
    super(
      `Community annotation Pull contains ${actual} ${unit}; the browser ` +
      `safety limit is ${maximum}. Archive old user files or split the ` +
      'annotation repository before pulling again.'
    );
    this.name = 'CommunityAnnotationPullLimitError';
    this.code = 'COMMUNITY_ANNOTATION_PULL_LIMIT';
    this.phase = 'remote-tree-preflight';
    this.kind = kind;
    this.actual = actual;
    this.maximum = maximum;
  }
}

function assertExactNonblankString(value, label, { max = 2048 } = {}) {
  if (
    typeof value !== 'string' ||
    !value ||
    /^\s|\s$/.test(value) ||
    Array.from(value).length > max
  ) {
    throw new Error(`${label} must be an exact nonblank string`);
  }
  return value;
}

function assertExactObjectKeys(value, fields, label) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must be a JSON object`);
  }
  const keys = Object.keys(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  ) {
    throw new Error(`${label} must contain exactly ${fields.join(', ')}`);
  }
  return value;
}

function assertExactHttpOrigin(value, label) {
  const origin = assertExactNonblankString(value, label);
  let parsed;
  try {
    parsed = new URL(origin);
  } catch (cause) {
    const error = new Error(`${label} must be an exact HTTP(S) origin`);
    error.cause = cause;
    throw error;
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password ||
    origin !== parsed.origin
  ) {
    throw new Error(`${label} must be an exact HTTP(S) origin`);
  }
  return origin;
}

function assertGitHubBranch(value, label = 'GitHub branch') {
  const branch = assertExactNonblankString(value, label, { max: 1024 });
  if (!isCanonicalGitHubBranch(branch)) {
    throw new Error(`${label} is not a canonical GitHub branch`);
  }
  return branch;
}

function assertGitHubSha(value, label) {
  const sha = assertExactNonblankString(value, label, { max: 40 });
  if (!GITHUB_SHA.test(sha)) {
    throw new Error(`${label} must be a lowercase 40-character Git SHA`);
  }
  return sha;
}

function assertOptionalToken(value) {
  if (value === null) return null;
  return assertExactNonblankString(value, 'GitHub token', { max: 4096 });
}

function assertTimeoutMs(timeoutMs) {
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0
  ) {
    throw new Error('GitHub request timeoutMs must be a nonnegative safe integer');
  }
  return timeoutMs;
}

function assertAbortSignalOrNull(value, label = 'GitHub request signal') {
  if (
    value !== null &&
    (
      typeof value !== 'object' ||
      typeof value.aborted !== 'boolean' ||
      typeof value.addEventListener !== 'function' ||
      typeof value.removeEventListener !== 'function'
    )
  ) {
    throw new TypeError(`${label} must be an AbortSignal or exact null`);
  }
  return value;
}

function createRequestAbortScope(signal, timeoutMs) {
  const ownerSignal = assertAbortSignalOrNull(signal);
  const ms = assertTimeoutMs(timeoutMs);
  if (typeof AbortController === 'undefined') {
    throw new Error('AbortController is required for GitHub annotation requests');
  }
  const controller = new AbortController();
  let abortCause = null;
  const abortWithCause = (cause) => {
    if (abortCause === null) abortCause = cause;
    controller.abort();
  };
  const abortFromOwner = () => {
    abortWithCause('owner');
  };
  if (ownerSignal !== null) {
    if (ownerSignal.aborted) abortFromOwner();
    else ownerSignal.addEventListener('abort', abortFromOwner, { once: true });
  }

  /** @type {ReturnType<typeof setTimeout> | null} */
  let timeout = null;
  if (ms > 0) {
    timeout = setTimeout(() => {
      abortWithCause('timeout');
    }, ms);
  }

  return {
    abortCause: () => abortCause,
    controller,
    ownerSignal,
    timeoutMs: ms,
    cleanup() {
      if (timeout !== null) clearTimeout(timeout);
      ownerSignal?.removeEventListener('abort', abortFromOwner);
    },
  };
}

function createOwnedRequestAbortError(label, cause = undefined) {
  const error = new Error(`${label} was cancelled`);
  error.name = 'AbortError';
  error.code = 'GITHUB_REQUEST_ABORTED';
  if (cause !== undefined) error.cause = cause;
  return error;
}

function throwIfRequestAborted(scope, label, cause = undefined) {
  const abortCause = scope.abortCause();
  if (abortCause === 'owner') {
    throw createOwnedRequestAbortError(
      label,
      scope.ownerSignal.reason ?? cause
    );
  }
  if (abortCause === 'timeout') {
    const error = new Error(
      `${label} timed out after ${Math.max(
        1,
        Math.round(scope.timeoutMs / 1000)
      )}s`
    );
    error.code = 'TIMEOUT';
    if (cause !== undefined) error.cause = cause;
    throw error;
  }
}

function attachRetryAfterHeader(error, response) {
  if (
    !error ||
    typeof error !== 'object' ||
    !response ||
    typeof response !== 'object' ||
    !response.headers ||
    typeof response.headers.get !== 'function'
  ) {
    return error;
  }
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null) {
    if (
      typeof retryAfter === 'string' &&
      retryAfter.length > 0 &&
      retryAfter === retryAfter.trim()
    ) {
      error.retryAfter = retryAfter;
    }
    return error;
  }
  const rawReset = response.headers.get('x-ratelimit-reset');
  if (
    typeof rawReset === 'string' &&
    /^(?:0|[1-9][0-9]*)$/.test(rawReset)
  ) {
    const reset = Number(rawReset);
    if (Number.isSafeInteger(reset)) {
      error.rateLimitResetEpochSeconds = reset;
    }
  }
  return error;
}

function assertPublicationMode(value) {
  if (!PUBLICATION_MODES.has(value)) {
    throw new Error(
      'publicationMode must equal "direct" or "fork-pull-request"'
    );
  }
  return value;
}

function assertGitHubLogin(value, label = 'GitHub login') {
  const login = assertExactNonblankString(value, label, { max: 64 });
  if (!isCanonicalGitHubAccount(login)) {
    throw new Error(`${label} is not a canonical GitHub account`);
  }
  return login;
}

function assertGitHubRepositoryFullName(value, label) {
  const fullName = assertExactNonblankString(value, label, { max: 256 });
  if (!isCanonicalGitHubRepositoryFullName(fullName)) {
    throw new Error(`${label} must equal an exact owner/repository name`);
  }
  return fullName;
}

function assertRepositoryPublicationInfo(repoInfo) {
  assertExactObjectKeys(
    repoInfo,
    [
      'full_name',
      'default_branch',
      'private',
      'allow_forking',
      'permissions',
    ],
    'GitHub repository metadata'
  );
  assertGitHubRepositoryFullName(
    repoInfo.full_name,
    'GitHub repository full_name'
  );
  assertGitHubBranch(
    repoInfo.default_branch,
    'GitHub repository default_branch'
  );
  if (typeof repoInfo.private !== 'boolean') {
    throw new Error('GitHub repository private must be boolean');
  }
  if (typeof repoInfo.allow_forking !== 'boolean') {
    throw new Error('GitHub repository allow_forking must be boolean');
  }
  const permissions = repoInfo.permissions;
  assertExactObjectKeys(
    permissions,
    ['pull', 'triage', 'push', 'maintain', 'admin'],
    'GitHub repository permissions'
  );
  for (const key of ['pull', 'triage', 'push', 'maintain', 'admin']) {
    if (typeof permissions[key] !== 'boolean') {
      throw new Error(`GitHub repository permissions.${key} must be boolean`);
    }
  }
  return {
    private: repoInfo.private,
    allowForking: repoInfo.allow_forking,
    canDirectPush:
      permissions.push || permissions.maintain || permissions.admin,
    canManage: permissions.maintain || permissions.admin,
  };
}

export function selectAnnotationPublicationMode(repoInfo) {
  const capability = assertRepositoryPublicationInfo(repoInfo);
  if (capability.canDirectPush) return 'direct';
  if (capability.allowForking) return 'fork-pull-request';
  return null;
}

export function buildUpdatedAnnotationConfig({
  currentConfig,
  datasetId,
  datasetName,
  fieldsToAnnotate,
  annotatableSettings,
  closedFields,
} = {}) {
  assertConfigDocument(currentConfig, {
    path: 'annotations/config.json',
  });
  const did = assertExactNonblankString(
    datasetId,
    'datasetId',
    { max: 256 }
  );
  const existing =
    currentConfig.supportedDatasets.find(
      entry => entry.datasetId === did
    ) ?? null;
  const replacement = {
    datasetId: did,
    name: datasetName === undefined ? existing?.name : datasetName,
    fieldsToAnnotate,
    annotatableSettings,
    closedFields,
  };
  const config = {
    version: 1,
    supportedDatasets: existing
      ? currentConfig.supportedDatasets.map(entry =>
        entry.datasetId === did ? replacement : entry
      )
      : [...currentConfig.supportedDatasets, replacement],
  };
  assertConfigDocument(config, {
    path: 'annotations/config.json publish payload',
  });
  return { config, replacement };
}

function assertAuthUserResponse(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'id') ||
    !Object.hasOwn(value, 'login')
  ) {
    throw new Error('GitHub auth user response must contain exactly id and login');
  }
  if (!Number.isSafeInteger(value.id) || value.id < 1) {
    throw new Error('GitHub auth user id must be a positive safe integer');
  }
  return {
    id: value.id,
    login: assertGitHubLogin(value.login, 'GitHub auth user login'),
  };
}

function isAbortError(err) {
  return err?.name === 'AbortError';
}

function deriveGitHubMutationKind(method, path) {
  if (method === 'GET') return null;
  if (
    method === 'PUT' &&
    /^\/repos\/[^/]+\/[^/]+\/contents\/.+$/.test(path)
  ) {
    return 'contents-put';
  }
  if (
    method === 'POST' &&
    /^\/repos\/[^/]+\/[^/]+\/git\/refs$/.test(path)
  ) {
    return 'git-refs-post';
  }
  if (
    method === 'POST' &&
    /^\/repos\/[^/]+\/[^/]+\/forks$/.test(path)
  ) {
    return 'forks-post';
  }
  if (
    method === 'POST' &&
    /^\/repos\/[^/]+\/[^/]+\/pulls$/.test(path)
  ) {
    return 'pulls-post';
  }
  throw new Error(
    `GitHub ${method} ${path} has no exact mutation operation contract`
  );
}

function createGitHubMutationOperation(method, path) {
  const kind = deriveGitHubMutationKind(method, path);
  if (kind === null) return null;
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error(
      'crypto.randomUUID is required for GitHub mutation ownership'
    );
  }
  const id = globalThis.crypto.randomUUID();
  if (typeof id !== 'string' || !OPERATION_ID.test(id)) {
    throw new Error(
      'crypto.randomUUID returned a non-canonical operation identity'
    );
  }
  return Object.freeze({ id, kind });
}

function mutationOperationRecord(operation, outcome) {
  if (
    !operation ||
    typeof operation !== 'object' ||
    !OPERATION_ID.test(operation.id) ||
    typeof operation.kind !== 'string' ||
    !OPERATION_OUTCOMES.has(outcome)
  ) {
    throw new Error('Invalid GitHub mutation outcome record');
  }
  return Object.freeze({
    id: operation.id,
    kind: operation.kind,
    outcome,
  });
}

function createUnknownMutationOutcomeError(
  message,
  operation,
  cause = undefined
) {
  const error = new Error(message);
  error.code = 'GITHUB_MUTATION_OUTCOME_UNKNOWN';
  error.operation = mutationOperationRecord(operation, 'unknown');
  if (cause !== undefined) error.cause = cause;
  return error;
}

function readWorkerMutationOutcome(response, operation) {
  const responseOperationId = response.headers.get(OPERATION_ID_HEADER);
  if (responseOperationId !== operation.id) {
    throw createUnknownMutationOutcomeError(
      'GitHub mutation operation identity mismatch after dispatch',
      operation
    );
  }
  const outcome = response.headers.get(OPERATION_OUTCOME_HEADER);
  if (!OPERATION_OUTCOMES.has(outcome)) {
    throw createUnknownMutationOutcomeError(
      'GitHub mutation operation outcome is missing or invalid after dispatch',
      operation
    );
  }
  if (
    (response.ok && outcome !== 'applied') ||
    (!response.ok && outcome === 'applied')
  ) {
    throw createUnknownMutationOutcomeError(
      'GitHub mutation operation outcome contradicts its HTTP status',
      operation
    );
  }
  return outcome;
}

function attachMutationOutcome(error, operation, outcome) {
  if (!error || typeof error !== 'object') {
    return createUnknownMutationOutcomeError(
      'GitHub mutation failed after dispatch',
      operation,
      error
    );
  }
  error.operation = mutationOperationRecord(operation, outcome);
  return error;
}

function attachMutationOutcomeToDocument(document, operation, outcome) {
  if (
    document === null ||
    typeof document !== 'object' ||
    Array.isArray(document)
  ) {
    throw createUnknownMutationOutcomeError(
      'GitHub mutation returned an invalid success document after dispatch',
      operation
    );
  }
  Object.defineProperty(document, 'operation', {
    configurable: false,
    enumerable: false,
    value: mutationOperationRecord(operation, outcome),
    writable: false,
  });
  return document;
}

function attachDocumentMutationOutcome(error, document) {
  if (
    error &&
    typeof error === 'object' &&
    !error.operation &&
    document &&
    typeof document === 'object' &&
    !Array.isArray(document) &&
    document.operation
  ) {
    error.operation = document.operation;
  }
  return error;
}

function observeResponseBodyCancellation(response) {
  if (typeof response?.body?.cancel !== 'function') return;
  try {
    Promise.resolve(response.body.cancel()).catch(() => {});
  } catch {
    // The primary protocol error owns the public outcome.
  }
}

function parseHttpJson(text, label) {
  if (typeof text !== 'string' || text === '') {
    throw new Error(`${label} returned an empty response body`);
  }
  return parseExactJson(text, { path: label });
}

function assertWorkerErrorDocument(value, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'error')
  ) {
    throw new Error(`${label} must contain exactly error`);
  }
  return assertExactNonblankString(value.error, `${label} error`, {
    max: 4096,
  });
}

function stableStringifyJson(value) {
  const ancestors = new WeakSet();
  const walk = (v) => {
    if (v === null) return null;
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v !== 'object') {
      throw new Error('Cannot compare a non-JSON value');
    }
    if (ancestors.has(v)) throw new Error('Cannot compare cyclic JSON');
    ancestors.add(v);
    if (Array.isArray(v)) {
      const array = v.map(walk);
      ancestors.delete(v);
      return array;
    }
    const out = Object.create(null);
    for (const k of Object.keys(v).sort()) {
      out[k] = walk(v[k]);
    }
    ancestors.delete(v);
    return out;
  };
  return JSON.stringify(walk(value));
}

function encodeBase64Bytes(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('Base64 input must be a Uint8Array');
  }
  const chunks = [];
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(
      String.fromCharCode(
        ...bytes.subarray(
          offset,
          Math.min(bytes.byteLength, offset + chunkSize)
        )
      )
    );
  }
  return btoa(chunks.join(''));
}

function base64AlphabetValue(code) {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  if (code >= 48 && code <= 57) return code - 48 + 52;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

function scanFoldedBase64Payload(
  value,
  {
    compareCanonical = null,
    path = 'GitHub annotation content',
    phase = 'remote-read',
  } = {}
) {
  if (typeof value !== 'string') {
    throw new Error('GitHub annotation content must be a base64 string');
  }
  if (compareCanonical !== null && typeof compareCanonical !== 'string') {
    throw new Error('Canonical base64 comparison input must be a string');
  }

  let payloadLength = 0;
  let padding = 0;
  let hasFolding = false;
  let equalsCanonical = compareCanonical === null ? null : true;
  let lastAlphabetValue = -1;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 13) {
      if (value.charCodeAt(index + 1) !== 10) {
        throw new Error(
          'GitHub annotation content must be valid base64 with optional line folding'
        );
      }
      hasFolding = true;
      index += 1;
      continue;
    }
    if (code === 10) {
      hasFolding = true;
      continue;
    }

    if (code === 61) {
      padding += 1;
      if (padding > 2) {
        throw new Error(
          'GitHub annotation content must be valid base64 with optional line folding'
        );
      }
    } else {
      const alphabetValue = base64AlphabetValue(code);
      if (alphabetValue < 0 || padding !== 0) {
        throw new Error(
          'GitHub annotation content must be valid base64 with optional line folding'
        );
      }
      lastAlphabetValue = alphabetValue;
    }

    if (
      compareCanonical !== null &&
      (
        payloadLength >= compareCanonical.length ||
        code !== compareCanonical.charCodeAt(payloadLength)
      )
    ) {
      equalsCanonical = false;
    }
    payloadLength += 1;
  }

  if (payloadLength === 0 || payloadLength % 4 !== 0) {
    throw new Error(
      'GitHub annotation content must be valid base64 with optional line folding'
    );
  }
  if (
    (padding === 1 && (lastAlphabetValue & 0b11) !== 0) ||
    (padding === 2 && (lastAlphabetValue & 0b1111) !== 0)
  ) {
    throw new Error(
      'GitHub annotation content must be canonical base64 with zero padding bits'
    );
  }
  if (
    compareCanonical !== null &&
    payloadLength !== compareCanonical.length
  ) {
    equalsCanonical = false;
  }
  const decodedByteLength =
    (payloadLength / 4) * 3 - padding;
  if (decodedByteLength > ANNOTATION_FILE_MAX_UTF8_BYTES) {
    throw new AnnotationFileTooLargeError(
      path,
      decodedByteLength,
      { phase }
    );
  }
  return {
    decodedByteLength,
    equalsCanonical,
    hasFolding,
    payloadLength,
  };
}

function base64PayloadEqualsCanonical(value, canonical, path) {
  const canonicalInfo = scanFoldedBase64Payload(canonical, {
    path,
    phase: 'publication-preflight',
  });
  if (canonicalInfo.hasFolding) {
    throw new Error('Canonical base64 comparison input must not be folded');
  }
  return scanFoldedBase64Payload(value, {
    compareCanonical: canonical,
    path,
  }).equalsCanonical === true;
}

function decodeBase64Utf8(b64, path) {
  const {
    decodedByteLength,
    hasFolding,
  } = scanFoldedBase64Payload(b64, { path });
  const base64 = hasFolding
    ? b64.replaceAll('\r\n', '').replaceAll('\n', '')
    : b64;
  const bin = atob(base64);
  if (typeof TextDecoder === 'undefined') {
    throw new Error('TextDecoder is required for GitHub annotation sync');
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Preserve a UTF-8 BOM so the exact JSON parser rejects it, matching the
  // repository validator instead of silently discarding it.
  return {
    decoded: new TextDecoder(
      'utf-8',
      { fatal: true, ignoreBOM: true }
    ).decode(bytes),
    decodedByteLength,
  };
}

async function getGitTreeRecursive({
  workerOrigin,
  owner,
  repo,
  token = null,
  ref,
  signal = null,
}) {
  const treeish = assertGitHubBranch(ref, 'Git tree ref');
  const res = await githubRequest(
    workerOrigin,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeish)}`,
    { token, query: { recursive: 1 }, signal }
  );
  const list = Array.isArray(res?.tree) ? res.tree : null;
  if (!list) throw new Error('Expected git tree listing');
  if (typeof res?.truncated !== 'boolean') {
    throw new Error('GitHub git tree response truncated must be boolean');
  }
  if (res.truncated) {
    throw new Error('GitHub returned a truncated git tree; annotation Pull is incomplete');
  }
  if (list.length > MAX_TREE_ITEMS) {
    throw new Error(`Git tree contains more than ${MAX_TREE_ITEMS} entries`);
  }
  return list.map((rawEntry, index) => {
    if (
      rawEntry === null ||
      typeof rawEntry !== 'object' ||
      Array.isArray(rawEntry)
    ) {
      throw new Error(`Git tree entry ${index} must be an object`);
    }
    if (
      rawEntry.type !== 'blob' &&
      rawEntry.type !== 'tree' &&
      rawEntry.type !== 'commit'
    ) {
      throw new Error(
        `Git tree entry ${index} type must equal blob, tree, or commit`
      );
    }
    const path = assertExactNonblankString(
      rawEntry.path,
      `Git tree entry ${index} path`,
      { max: 4096 }
    );
    if (
      path.startsWith('/') ||
      path.endsWith('/') ||
      path.split('/').some((segment) => !segment)
    ) {
      throw new Error(`Git tree entry ${index} path is not canonical`);
    }
    let size = null;
    if (rawEntry.type === 'blob') {
      if (
        !Number.isSafeInteger(rawEntry.size) ||
        rawEntry.size < 0
      ) {
        throw new Error(
          `Git tree blob entry ${index} size must be a nonnegative safe integer`
        );
      }
      size = rawEntry.size;
    }
    return {
      type: rawEntry.type,
      path,
      sha: assertGitHubSha(
        rawEntry.sha,
        `Git tree entry ${index} SHA`
      ),
      size,
    };
  });
}

async function getGitBlobJson({
  workerOrigin,
  owner,
  repo,
  token = null,
  sha,
  path,
  signal = null,
}) {
  const s = assertGitHubSha(sha, 'Git blob SHA');
  const res = await githubRequest(
    workerOrigin,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(s)}`,
    { token, signal }
  );
  if (res?.encoding !== 'base64') {
    throw new Error(`GitHub blob ${JSON.stringify(path)} must use base64 encoding`);
  }
  if (typeof res?.content !== 'string' || !res.content) {
    throw new Error(`GitHub blob ${JSON.stringify(path)} has empty content`);
  }
  const { decoded, decodedByteLength } =
    decodeBase64Utf8(res.content, path);
  return {
    decodedByteLength,
    json: parseExactJson(decoded, { path }),
  };
}

async function mapWithConcurrency(
  items,
  concurrency,
  fn,
  { signal = null } = {}
) {
  if (!Array.isArray(items)) {
    throw new Error('Concurrent map items must be an array');
  }
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1
  ) {
    throw new Error('Concurrent map limit must be a positive safe integer');
  }
  if (typeof fn !== 'function') {
    throw new Error('Concurrent map callback must be a function');
  }
  const ownerSignal = assertAbortSignalOrNull(
    signal,
    'Concurrent GitHub request signal'
  );
  const list = items;
  const limit = concurrency;
  const results = new Array(list.length);
  if (!list.length) return results;

  const abortScope = createRequestAbortScope(ownerSignal, 0);
  let nextIndex = 0;
  let firstError;
  let hasError = false;
  try {
    const workers = new Array(Math.min(limit, list.length))
      .fill(null)
      .map(async () => {
        while (!hasError && !abortScope.controller.signal.aborted) {
          const idx = nextIndex;
          nextIndex += 1;
          if (idx >= list.length) return;
          try {
            results[idx] = await fn(
              list[idx],
              idx,
              abortScope.controller.signal
            );
          } catch (error) {
            if (!hasError) {
              hasError = true;
              firstError = error;
              abortScope.controller.abort();
            }
            return;
          }
        }
      });
    await Promise.all(workers);
    if (hasError) throw firstError;
    throwIfRequestAborted(
      abortScope,
      'Concurrent GitHub requests'
    );
    return results;
  } finally {
    abortScope.cleanup();
  }
}

export function parseOwnerRepo(input) {
  return parseCanonicalGitHubRepositoryReference(input);
}

function sanitizeUserKeyForPath(userKey) {
  if (typeof userKey !== 'string') return null;
  const m = userKey.match(/^ghid_([1-9][0-9]*)$/);
  if (!m) return null;
  const id = Number(m[1]);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return userKey;
}

function fnv1aHash32(input) {
  const str = assertExactNonblankString(input, 'Hash input', { max: 8192 });
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function encodeGitRefPath(ref) {
  const raw = assertGitHubBranch(ref, 'GitHub ref path');
  return raw.split('/').map((p) => encodeURIComponent(p)).join('/');
}

function toDeterministicPrBranch({ datasetId, baseBranch, fileUser }) {
  const didRaw = assertExactNonblankString(
    datasetId,
    'Pull-request dataset id',
    { max: 256 }
  );
  const baseRaw = assertGitHubBranch(baseBranch, 'Pull-request base branch');
  const userRaw = sanitizeUserKeyForPath(fileUser);
  if (userRaw === null) {
    throw new Error('Pull-request file user must be an exact ghid identity');
  }
  const fingerprint = fnv1aHash32(
    `${didRaw}\u0000${baseRaw}\u0000${userRaw}`
  ).toString(36);
  return `cellucid-annotations/${userRaw}/${fingerprint}`;
}

function toWorkerApiUrl(workerOrigin, githubPath) {
  const origin = assertExactHttpOrigin(workerOrigin, 'GitHub worker origin');
  const p = assertExactNonblankString(githubPath, 'GitHub API path');
  if (!p.startsWith('/')) throw new Error('GitHub API path must start with "/"');
  return new URL(`${origin}/api${p}`);
}

function toWorkerAuthUrl(workerOrigin, workerPath) {
  const origin = assertExactHttpOrigin(workerOrigin, 'GitHub worker origin');
  const p = assertExactNonblankString(workerPath, 'GitHub worker path');
  if (!p.startsWith('/')) throw new Error('Worker path must start with "/"');
  return new URL(`${origin}${p}`);
}

async function githubRequest(workerOrigin, path, {
  token = null,
  method = 'GET',
  query = null,
  body = null,
  timeoutMs = GITHUB_DEFAULT_TIMEOUT_MS,
  signal = null,
} = {}) {
  const url = toWorkerApiUrl(workerOrigin, path);
  if (
    query !== null &&
    (
      typeof query !== 'object' ||
      Array.isArray(query)
    )
  ) {
    throw new Error('GitHub query must be a JSON object or null');
  }
  if (query !== null) {
    for (const [k, v] of Object.entries(query)) {
      const key = assertExactNonblankString(k, 'GitHub query key', {
        max: 128,
      });
      let encodedValue;
      if (typeof v === 'string') {
        encodedValue = assertExactNonblankString(
          v,
          `GitHub query ${key}`,
          { max: 2048 }
        );
      } else if (Number.isSafeInteger(v) && v >= 0) {
        encodedValue = `${v}`;
      } else {
        throw new Error(
          `GitHub query ${key} must be an exact string or nonnegative safe integer`
        );
      }
      url.searchParams.set(key, encodedValue);
    }
  }
  if (method !== 'GET' && method !== 'POST' && method !== 'PUT') {
    throw new Error('GitHub request method must equal GET, POST, or PUT');
  }

  const headers = {
    Accept: 'application/vnd.github+json',
  };
  const mutationOperation = createGitHubMutationOperation(method, path);
  const exactToken = assertOptionalToken(token);
  if (exactToken !== null) headers.Authorization = `Bearer ${exactToken}`;
  if (body != null) headers['Content-Type'] = 'application/json';
  if (mutationOperation !== null) {
    headers[OPERATION_ID_HEADER] = mutationOperation.id;
  }

  const abortScope = createRequestAbortScope(signal, timeoutMs);
  let dispatched = false;

  try {
    throwIfRequestAborted(abortScope, 'GitHub request');
    dispatched = true;
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body !== null ? stableStringifyJson(body) : undefined,
      signal: abortScope.controller.signal
    });
    throwIfRequestAborted(abortScope, 'GitHub request');

    let mutationOutcome = null;
    if (mutationOperation !== null) {
      try {
        mutationOutcome = readWorkerMutationOutcome(
          res,
          mutationOperation
        );
      } catch (error) {
        observeResponseBodyCancellation(res);
        throw error;
      }
    }

    const text = await res.text();
    throwIfRequestAborted(abortScope, 'GitHub request');
    let responseJson;
    try {
      responseJson = parseHttpJson(
        text,
        `GitHub ${method} ${path} response`
      );
    } catch (cause) {
      const error = new Error(
        `GitHub ${method} ${path} returned invalid JSON: ${cause?.message || cause}`
      );
      error.status = res.status;
      error.github = { path, method };
      error.cause = cause;
      const exactError = attachRetryAfterHeader(error, res);
      if (mutationOperation !== null) {
        throw createUnknownMutationOutcomeError(
          exactError.message,
          mutationOperation,
          exactError
        );
      }
      throw exactError;
    }

    if (!res.ok) {
      const msg = assertWorkerErrorDocument(
        responseJson,
        `GitHub ${method} ${path} error response`
      );
      const err = new Error(msg);
      // attach minimal context (no token)
      err.status = res.status;
      err.github = { path, method };
      const exactError = attachRetryAfterHeader(err, res);
      if (mutationOperation !== null) {
        throw attachMutationOutcome(
          exactError,
          mutationOperation,
          mutationOutcome
        );
      }
      throw exactError;
    }

    return mutationOperation === null
      ? responseJson
      : attachMutationOutcomeToDocument(
          responseJson,
          mutationOperation,
          mutationOutcome
        );
  } catch (err) {
    try {
      throwIfRequestAborted(
        abortScope,
        'GitHub request',
        err
      );
    } catch (ownedError) {
      ownedError.github = { path, method };
      if (mutationOperation !== null && dispatched) {
        const unknown = createUnknownMutationOutcomeError(
          'GitHub mutation outcome is unknown after request cancellation',
          mutationOperation,
          ownedError
        );
        unknown.github = { path, method };
        throw unknown;
      }
      throw ownedError;
    }
    if (
      mutationOperation !== null &&
      dispatched &&
      !err?.operation
    ) {
      const unknown = createUnknownMutationOutcomeError(
        'GitHub mutation outcome is unknown after a transport failure',
        mutationOperation,
        err
      );
      unknown.github = { path, method };
      throw unknown;
    }
    if (
      mutationOperation !== null &&
      err?.operation &&
      !err.github
    ) {
      err.github = { path, method };
    }
    if (isAbortError(err) && mutationOperation === null) {
      const error = new Error(
        'GitHub request transport was interrupted independently'
      );
      error.code = 'GITHUB_TRANSPORT_FAILED';
      error.github = { path, method };
      error.cause = err;
      throw error;
    }
    if (err && typeof err === 'object' && !err.github) err.github = { path, method };
    throw err;
  } finally {
    abortScope.cleanup();
  }
}

async function workerAuthRequest(workerOrigin, path, {
  token = null,
  method = 'GET',
  body = null,
  timeoutMs = GITHUB_DEFAULT_TIMEOUT_MS,
  signal = null,
} = {}) {
  const url = toWorkerAuthUrl(workerOrigin, path);
  const headers = {};
  const exactToken = assertOptionalToken(token);
  if (exactToken !== null) headers.Authorization = `Bearer ${exactToken}`;
  if (body != null) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'POST') {
    throw new Error('GitHub worker request method must equal GET or POST');
  }

  const abortScope = createRequestAbortScope(signal, timeoutMs);

  try {
    throwIfRequestAborted(abortScope, 'GitHub auth request');
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body !== null ? stableStringifyJson(body) : undefined,
      signal: abortScope.controller.signal
    });
    throwIfRequestAborted(abortScope, 'GitHub auth request');

    const text = await res.text();
    throwIfRequestAborted(abortScope, 'GitHub auth request');
    let responseJson;
    try {
      responseJson = parseHttpJson(
        text,
        `GitHub worker ${method} ${path} response`
      );
    } catch (cause) {
      const error = new Error(
        `GitHub worker ${method} ${path} returned invalid JSON: ${cause?.message || cause}`
      );
      error.status = res.status;
      error.worker = { path, method };
      error.cause = cause;
      throw attachRetryAfterHeader(error, res);
    }
    if (!res.ok) {
      const msg = assertWorkerErrorDocument(
        responseJson,
        `GitHub worker ${method} ${path} error response`
      );
      const err = new Error(msg);
      err.status = res.status;
      err.worker = { path, method };
      throw attachRetryAfterHeader(err, res);
    }
    return responseJson;
  } catch (err) {
    try {
      throwIfRequestAborted(
        abortScope,
        'GitHub auth request',
        err
      );
    } catch (ownedError) {
      ownedError.worker = { path, method };
      throw ownedError;
    }
    if (isAbortError(err)) {
      const error = new Error(
        'GitHub auth request transport was interrupted independently'
      );
      error.code = 'GITHUB_TRANSPORT_FAILED';
      error.worker = { path, method };
      error.cause = err;
      throw error;
    }
    if (err && typeof err === 'object' && !err.worker) err.worker = { path, method };
    throw err;
  } finally {
    abortScope.cleanup();
  }
}

async function getRepoInfo({
  workerOrigin,
  owner,
  repo,
  token = null,
  signal = null,
}) {
  return githubRequest(
    workerOrigin,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { token, signal }
  );
}

function assertForkRepositoryIdentity(value) {
  assertExactObjectKeys(
    value,
    ['full_name', 'fork', 'parent'],
    'GitHub fork identity'
  );
  const fullName = assertGitHubRepositoryFullName(
    value.full_name,
    'GitHub fork identity full_name'
  );
  if (typeof value.fork !== 'boolean') {
    throw new Error('GitHub fork identity fork must be boolean');
  }
  if (value.fork === false) {
    if (value.parent !== null) {
      throw new Error(
        'GitHub non-fork identity parent must equal exact null'
      );
    }
    return { fork: false, fullName, parentFullName: null };
  }
  assertExactObjectKeys(
    value.parent,
    ['full_name'],
    'GitHub fork identity parent'
  );
  return {
    fork: true,
    fullName,
    parentFullName: assertGitHubRepositoryFullName(
      value.parent.full_name,
      'GitHub fork identity parent full_name'
    ),
  };
}

async function getForkRepositoryIdentity({
  workerOrigin,
  owner,
  repo,
  token,
  signal = null,
}) {
  return assertForkRepositoryIdentity(
    await githubRequest(
      workerOrigin,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        token,
        query: { fork_identity: 1 },
        signal,
      }
    )
  );
}

async function getContent({
  workerOrigin,
  owner,
  repo,
  token = null,
  path,
  ref = null,
  signal = null,
}) {
  const p = assertExactNonblankString(path, 'GitHub content path');
  if (p.startsWith('/') || p.split('/').some((segment) => !segment)) {
    throw new Error('GitHub content path must be a canonical relative path');
  }
  const query =
    ref === null ? null : { ref: assertGitHubBranch(ref, 'GitHub content ref') };
  return githubRequest(
    workerOrigin,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${p.split('/').map(encodeURIComponent).join('/')}`,
    { token, query, signal }
  );
}

function assertContentFileRecord(content, path) {
  if (!content || content.type !== 'file') {
    throw new Error(`Expected file at ${path}`);
  }
  if (content.encoding !== 'base64') {
    throw new Error(`GitHub file ${JSON.stringify(path)} must use base64 encoding`);
  }
  const sha = assertGitHubSha(content.sha, `GitHub file ${JSON.stringify(path)} SHA`);
  scanFoldedBase64Payload(content.content, { path });
  return {
    contentBase64: content.content,
    sha,
  };
}

function shouldReconcileMutation(error, kind) {
  const operation = error?.operation;
  if (
    operation &&
    operation.kind === kind &&
    (
      operation.outcome === 'unknown' ||
      operation.outcome === 'applied'
    )
  ) {
    return true;
  }
  return (
    (error?.status === 409 || error?.status === 422) &&
    (
      !operation ||
      (
        operation.kind === kind &&
        operation.outcome === 'not-applied'
      )
    )
  );
}

async function putContent({
  workerOrigin,
  owner,
  repo,
  token,
  path,
  branch,
  message,
  contentBase64,
  sha = null,
  signal = null,
}) {
  const exactToken = assertExactNonblankString(
    token,
    'GitHub token',
    { max: 4096 }
  );
  const p = assertExactNonblankString(path, 'GitHub content path');
  if (p.startsWith('/') || p.split('/').some((segment) => !segment)) {
    throw new Error('GitHub content path must be a canonical relative path');
  }
  const exactMessage = assertExactNonblankString(
    message,
    'GitHub commit message',
    { max: 256 }
  );
  if (
    typeof contentBase64 !== 'string' ||
    !contentBase64 ||
    /^\s|\s$/.test(contentBase64)
  ) {
    throw new Error('GitHub base64 content must be an exact nonblank string');
  }
  const exactContent = contentBase64;
  if (
    scanFoldedBase64Payload(exactContent, {
      path: p,
      phase: 'publication-preflight',
    }).hasFolding
  ) {
    throw new Error('GitHub base64 content must be canonical and unfolded');
  }
  const payload = {
    message: exactMessage,
    content: exactContent,
    branch: assertGitHubBranch(branch),
  };
  if (sha !== null) payload.sha = assertGitHubSha(sha, 'Existing content SHA');
  const requestPath =
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${p.split('/').map(encodeURIComponent).join('/')}`;
  let response = null;
  try {
    response = await githubRequest(
      workerOrigin,
      requestPath,
      {
        token: exactToken,
        method: 'PUT',
        body: payload,
        signal,
      }
    );
    assertGitHubSha(
      response?.content?.sha,
      'Published GitHub content SHA'
    );
    return response;
  } catch (caughtError) {
    const error = attachDocumentMutationOutcome(caughtError, response);
    if (
      !shouldReconcileMutation(error, 'contents-put') ||
      signal?.aborted === true
    ) {
      throw error;
    }
    try {
      const remote = await getContent({
        workerOrigin,
        owner,
        repo,
        token: exactToken,
        path: p,
        ref: payload.branch,
        signal,
      });
      const remoteFile = assertContentFileRecord(remote, p);
      if (
        base64PayloadEqualsCanonical(
          remoteFile.contentBase64,
          exactContent,
          p
        )
      ) {
        return { content: { sha: remoteFile.sha } };
      }
    } catch {
      // The original mutation outcome remains authoritative when one bounded
      // desired-state read cannot prove convergence.
    }
    throw error;
  }
}

function isContentConflictError(error) {
  return (
    error?.status === 409 &&
    (
      !error?.operation ||
      error.operation.outcome === 'not-applied'
    )
  );
}

function inheritMutationErrorContext(error, cause) {
  error.cause = cause;
  if (Number.isSafeInteger(cause?.status)) {
    error.status = cause.status;
  }
  if (cause?.operation) {
    error.operation = cause.operation;
  }
  if (cause?.github) {
    error.github = cause.github;
  }
  return error;
}

function decodeJsonContentFile(content, path) {
  const file = assertContentFileRecord(content, path);
  const { decoded } = decodeBase64Utf8(file.contentBase64, path);
  return {
    json: parseExactJson(decoded, { path }),
    sha: file.sha,
    contentBase64: file.contentBase64,
  };
}

async function readJsonFile({
  workerOrigin,
  owner,
  repo,
  token = null,
  path,
  ref = null,
  signal = null,
}) {
  const content = await getContent({
    workerOrigin,
    owner,
    repo,
    token,
    path,
    ref,
    signal,
  });
  return decodeJsonContentFile(content, path);
}

function isNotFoundError(err) {
  return err?.status === 404;
}

async function readJsonFileOrNull({
  workerOrigin,
  owner,
  repo,
  token,
  path,
  ref,
  signal = null,
}) {
  try {
    return await readJsonFile({
      workerOrigin,
      owner,
      repo,
      token,
      path,
      ref,
      signal,
    });
  } catch (err) {
    if (isNotFoundError(err)) {
      return { json: null, sha: null, contentBase64: null };
    }
    throw err;
  }
}

function assertForkRecord(
  value,
  index,
  upstreamFullName,
  { requireParent = false } = {}
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`GitHub fork ${index} must be an object`);
  }
  const fullName = assertGitHubRepositoryFullName(
    value.full_name,
    `GitHub fork ${index} full_name`
  );
  if (!value.owner || typeof value.owner !== 'object' || Array.isArray(value.owner)) {
    throw new Error(`GitHub fork ${index} owner must be an object`);
  }
  const owner = assertGitHubLogin(
    value.owner.login,
    `GitHub fork ${index} owner login`
  );
  const name = assertExactNonblankString(
    value.name,
    `GitHub fork ${index} name`,
    { max: 100 }
  );
  if (!isCanonicalGitHubRepositoryName(name)) {
    throw new Error(`GitHub fork ${index} name is not canonical`);
  }
  if (fullName.toLowerCase() !== `${owner}/${name}`.toLowerCase()) {
    throw new Error(`GitHub fork ${index} identity fields disagree`);
  }
  if (requireParent && value.parent === undefined) {
    throw new Error(`GitHub fork ${index} is missing its parent repository`);
  }
  if (value.parent !== undefined) {
    if (
      !value.parent ||
      typeof value.parent !== 'object' ||
      Array.isArray(value.parent) ||
      assertGitHubRepositoryFullName(
        value.parent.full_name,
        `GitHub fork ${index} parent full_name`
      ).toLowerCase() !== upstreamFullName.toLowerCase()
    ) {
      throw new Error(`GitHub fork ${index} has a different parent repository`);
    }
  }
  return { owner, name, fullName };
}

function createForkLookupLimitError({
  forkOwner,
  upstreamFullName,
  cause = undefined,
}) {
  const error = new Error(
    `Cellucid could not safely locate a renamed fork of ` +
    `${upstreamFullName} owned by ${forkOwner} within the newest ` +
    `${GITHUB_RENAMED_FORK_LOOKUP_MAX_ITEMS.toLocaleString('en-US')} forks ` +
    `or ${Math.round(GITHUB_RENAMED_FORK_LOOKUP_TIMEOUT_MS / 1000)}s. ` +
    `Rename the fork to the upstream repository name on GitHub, then publish again.`
  );
  error.code = 'GITHUB_FORK_LOOKUP_LIMIT';
  if (cause !== undefined) error.cause = cause;
  return error;
}

function createForkNameConflictError({
  forkOwner,
  upstreamFullName,
  canonicalFullName,
}) {
  const error = new Error(
    `GitHub repository ${canonicalFullName} exists, but it is not a fork of ` +
    `${upstreamFullName}. Rename that repository or rename the existing ` +
    `${forkOwner} fork to the upstream repository name, then publish again.`
  );
  error.code = 'GITHUB_FORK_NAME_CONFLICT';
  return error;
}

async function probeCanonicalOwnedFork({
  workerOrigin,
  upstreamRepo,
  upstreamFullName,
  token,
  forkOwner,
  signal = null,
}) {
  const exactForkOwner = assertGitHubLogin(forkOwner, 'Fork owner');
  const expectedFullName = `${exactForkOwner}/${upstreamRepo}`;
  let identity;
  try {
    identity = await getForkRepositoryIdentity({
      workerOrigin,
      owner: exactForkOwner,
      repo: upstreamRepo,
      token,
      signal,
    });
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  const separator = identity.fullName.indexOf('/');
  const actualOwner = identity.fullName.slice(0, separator);
  const actualName = identity.fullName.slice(separator + 1);
  if (
    actualOwner.toLowerCase() === exactForkOwner.toLowerCase() &&
    identity.fork &&
    identity.parentFullName.toLowerCase() === upstreamFullName.toLowerCase()
  ) {
    return {
      collision: false,
      name: actualName,
    };
  }
  return {
    collision: true,
    canonicalFullName:
      actualOwner.toLowerCase() === exactForkOwner.toLowerCase()
        ? identity.fullName
        : expectedFullName,
  };
}

async function findOwnedForkRepo({
  workerOrigin,
  upstreamOwner,
  upstreamRepo,
  upstreamFullName,
  token,
  forkOwner,
  signal = null,
}) {
  const exactUpstreamFullName = assertGitHubRepositoryFullName(
    upstreamFullName,
    'Fork source repository'
  );
  const exactForkOwner = assertGitHubLogin(forkOwner, 'Fork owner');
  const seen = new Set();
  const abortScope = createRequestAbortScope(
    signal,
    GITHUB_RENAMED_FORK_LOOKUP_TIMEOUT_MS
  );
  try {
    for (
      let page = 1;
      page <= GITHUB_RENAMED_FORK_LOOKUP_MAX_PAGES;
      page += 1
    ) {
      throwIfRequestAborted(abortScope, 'GitHub renamed fork lookup');
      const document = await githubRequest(
        workerOrigin,
        `/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}/forks`,
        {
          token,
          query: { sort: 'newest', per_page: 100, page },
          signal: abortScope.controller.signal,
          timeoutMs: 0,
        }
      );
      if (!Array.isArray(document)) {
        throw new Error('GitHub forks response must be an array');
      }
      if (document.length > 100) {
        throw new Error('GitHub forks response page exceeds 100 entries');
      }
      let matchingName = null;
      document.forEach((raw, index) => {
        const fork = assertForkRecord(
          raw,
          (page - 1) * 100 + index,
          exactUpstreamFullName
        );
        const key = fork.fullName.toLowerCase();
        if (seen.has(key)) {
          throw new Error(`GitHub forks response repeats ${fork.fullName}`);
        }
        seen.add(key);
        if (fork.owner.toLowerCase() === exactForkOwner.toLowerCase()) {
          if (matchingName !== null) {
            throw new Error(
              `GitHub returned multiple forks owned by ${exactForkOwner}`
            );
          }
          matchingName = fork.name;
        }
      });
      if (matchingName !== null) return matchingName;
      if (document.length < 100) return null;
    }
    throw createForkLookupLimitError({
      forkOwner: exactForkOwner,
      upstreamFullName: exactUpstreamFullName,
    });
  } catch (error) {
    try {
      throwIfRequestAborted(
        abortScope,
        'GitHub renamed fork lookup',
        error
      );
    } catch (ownedError) {
      if (abortScope.abortCause() === 'timeout') {
        throw createForkLookupLimitError({
          forkOwner: exactForkOwner,
          upstreamFullName: exactUpstreamFullName,
          cause: ownedError,
        });
      }
      throw ownedError;
    }
    if (error?.code === 'TIMEOUT') {
      throw createForkLookupLimitError({
        forkOwner: exactForkOwner,
        upstreamFullName: exactUpstreamFullName,
        cause: error,
      });
    }
    throw error;
  } finally {
    abortScope.cleanup();
  }
}

async function selectOrCreateForkRepo({
  workerOrigin,
  upstreamOwner,
  upstreamRepo,
  upstreamFullName,
  token,
  forkOwner,
  signal = null,
}) {
  const exactUpstreamFullName = assertGitHubRepositoryFullName(
    upstreamFullName,
    'Fork source repository'
  );
  const exactForkOwner = assertGitHubLogin(forkOwner, 'Fork owner');
  const canonical = await probeCanonicalOwnedFork({
    workerOrigin,
    upstreamRepo,
    upstreamFullName: exactUpstreamFullName,
    token,
    forkOwner: exactForkOwner,
    signal,
  });
  if (canonical !== null && !canonical.collision) {
    return { name: canonical.name, requiresReadiness: false };
  }
  if (canonical?.collision) {
    const renamed = await findOwnedForkRepo({
      workerOrigin,
      upstreamOwner,
      upstreamRepo,
      upstreamFullName: exactUpstreamFullName,
      token,
      forkOwner: exactForkOwner,
      signal,
    });
    if (renamed !== null) {
      return { name: renamed, requiresReadiness: false };
    }
    throw createForkNameConflictError({
      forkOwner: exactForkOwner,
      upstreamFullName: exactUpstreamFullName,
      canonicalFullName: canonical.canonicalFullName,
    });
  }

  let created = null;
  try {
    created = await githubRequest(
      workerOrigin,
      `/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}/forks`,
      { token, method: 'POST', body: {}, signal }
    );
    const fork = assertForkRecord(
      created,
      'created',
      exactUpstreamFullName,
      { requireParent: true }
    );
    if (fork.owner.toLowerCase() !== exactForkOwner.toLowerCase()) {
      throw new Error(
        `GitHub created the fork for ${fork.owner}, expected ${exactForkOwner}`
      );
    }
    return { name: fork.name, requiresReadiness: true };
  } catch (caughtError) {
    const error = attachDocumentMutationOutcome(caughtError, created);
    if (
      !shouldReconcileMutation(error, 'forks-post') ||
      signal?.aborted === true
    ) {
      throw error;
    }
    try {
      const reconciledCanonical = await probeCanonicalOwnedFork({
        workerOrigin,
        upstreamRepo,
        upstreamFullName: exactUpstreamFullName,
        token,
        forkOwner: exactForkOwner,
        signal,
      });
      if (
        reconciledCanonical !== null &&
        !reconciledCanonical.collision
      ) {
        return {
          name: reconciledCanonical.name,
          requiresReadiness: true,
        };
      }
      const reconciled = await findOwnedForkRepo({
        workerOrigin,
        upstreamOwner,
        upstreamRepo,
        upstreamFullName: exactUpstreamFullName,
        token,
        forkOwner: exactForkOwner,
        signal,
      });
      if (reconciled !== null) {
        return { name: reconciled, requiresReadiness: true };
      }
      if (reconciledCanonical?.collision) {
        throw createForkNameConflictError({
          forkOwner: exactForkOwner,
          upstreamFullName: exactUpstreamFullName,
          canonicalFullName:
            reconciledCanonical.canonicalFullName,
        });
      }
    } catch (reconciliationError) {
      if (
        error?.operation?.outcome === 'unknown' ||
        error?.operation?.outcome === 'applied'
      ) {
        throw error;
      }
      if (
        reconciliationError?.code === 'GITHUB_FORK_LOOKUP_LIMIT' ||
        reconciliationError?.code === 'GITHUB_FORK_NAME_CONFLICT' ||
        reconciliationError?.code === 'GITHUB_REQUEST_ABORTED'
      ) {
        throw reconciliationError;
      }
      // Preserve the original mutation outcome when the bounded read cannot
      // prove that the exact fork now exists.
    }
    throw error;
  }
}

function waitForForkReadinessDelay(delayMs, signal) {
  if (!Number.isSafeInteger(delayMs) || delayMs < 1) {
    throw new Error('GitHub fork readiness delay must be a positive integer');
  }
  if (signal?.aborted === true) {
    throw createOwnedRequestAbortError(
      'GitHub fork readiness',
      signal.reason
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      settle(
        reject,
        createOwnedRequestAbortError(
          'GitHub fork readiness',
          signal.reason
        )
      );
    };
    const timer = setTimeout(() => settle(resolve), delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

async function waitForForkBaseRef({
  workerOrigin,
  owner,
  repo,
  token,
  branch,
  signal = null,
}) {
  const exactOwner = assertGitHubLogin(owner, 'Fork readiness owner');
  const exactRepo = assertExactNonblankString(
    repo,
    'Fork readiness repository',
    { max: 100 }
  );
  if (!isCanonicalGitHubRepositoryName(exactRepo)) {
    throw new Error('Fork readiness repository is not canonical');
  }
  const exactBranch = assertGitHubBranch(
    branch,
    'Fork readiness base branch'
  );
  let lastNotFound = null;
  for (
    let attempt = 1;
    attempt <= GITHUB_FORK_READINESS_ATTEMPTS;
    attempt += 1
  ) {
    try {
      await getBranchTipSha({
        workerOrigin,
        owner: exactOwner,
        repo: exactRepo,
        token,
        branch: exactBranch,
        signal,
        timeoutMs: GITHUB_FORK_READINESS_REQUEST_TIMEOUT_MS,
      });
      return;
    } catch (error) {
      if (error?.status !== 404) throw error;
      lastNotFound = error;
    }
    if (attempt < GITHUB_FORK_READINESS_ATTEMPTS) {
      await waitForForkReadinessDelay(
        Math.min(1_000, 100 * (2 ** (attempt - 1))),
        signal
      );
    }
  }
  const error = new Error(
    `GitHub fork ${exactOwner}/${exactRepo} did not expose base branch ` +
    `${exactBranch} after ${GITHUB_FORK_READINESS_ATTEMPTS} readiness probes. ` +
    'Wait for GitHub to finish creating the fork, then try again.'
  );
  error.code = 'GITHUB_FORK_NOT_READY';
  error.cause = lastNotFound;
  throw error;
}

function requireBranchTipSha(document, label) {
  if (
    !document ||
    typeof document !== 'object' ||
    Array.isArray(document) ||
    !document.object ||
    typeof document.object !== 'object' ||
    Array.isArray(document.object)
  ) {
    throw new Error(`${label} must contain an object SHA`);
  }
  return assertGitHubSha(document.object.sha, `${label} object SHA`);
}

async function getBranchTipSha({
  workerOrigin,
  owner,
  repo,
  token,
  branch,
  signal = null,
  timeoutMs = GITHUB_DEFAULT_TIMEOUT_MS,
}) {
  const exactBranch = assertGitHubBranch(branch);
  const ref = await githubRequest(
    workerOrigin,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeGitRefPath(exactBranch)}`,
    { token, signal, timeoutMs }
  );
  return requireBranchTipSha(ref, 'GitHub branch response');
}

async function ensureBranchExists({
  workerOrigin,
  owner,
  repo,
  token,
  branch,
  baseSha,
  signal = null,
}) {
  const b = assertGitHubBranch(branch, 'Pull Request branch');
  const sha = assertGitHubSha(baseSha, 'Pull Request base SHA');
  try {
    const existing = await githubRequest(
      workerOrigin,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeGitRefPath(b)}`,
      { token, signal }
    );
    requireBranchTipSha(existing, 'Existing Pull Request branch response');
    return;
  } catch (err) {
    if (err?.status !== 404) throw err;
  }
  try {
    await githubRequest(
      workerOrigin,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
      {
        token,
        method: 'POST',
        body: { ref: `refs/heads/${b}`, sha },
        signal,
      }
    );
  } catch (error) {
    if (
      !shouldReconcileMutation(error, 'git-refs-post') ||
      signal?.aborted === true
    ) {
      throw error;
    }
    try {
      const currentSha = await getBranchTipSha({
        workerOrigin,
        owner,
        repo,
        token,
        branch: b,
        signal,
      });
      if (currentSha === sha) return;
    } catch {
      // The original mutation outcome remains authoritative when the exact
      // requested branch tip cannot be proved by one read.
    }
    throw error;
  }
}

async function upsertFileOnBranch({
  workerOrigin,
  owner,
  repo,
  token,
  branch,
  path,
  message,
  contentBase64,
  signal = null,
}) {
  const b = assertGitHubBranch(branch, 'Pull Request branch');
  const p = assertExactNonblankString(path, 'Pull Request file path');

  let sha = null;
  try {
    const existing = await getContent({
      workerOrigin,
      owner,
      repo,
      token,
      path: p,
      ref: b,
      signal,
    });
    if (!existing || existing.type !== 'file') {
      throw new Error(`Expected file at ${p}`);
    }
    const existingFile = assertContentFileRecord(existing, p);
    sha = existingFile.sha;
    if (
      base64PayloadEqualsCanonical(
        existingFile.contentBase64,
        contentBase64,
        p
      )
    ) {
      return;
    }
  } catch (err) {
    if (err?.status !== 404) throw err;
  }

  await putContent({
    workerOrigin,
    owner,
    repo,
    token,
    path: p,
    branch: b,
    message,
    contentBase64,
    sha,
    signal,
  });
}

function assertPullRequestRecord(value, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Number.isSafeInteger(value.number) ||
    value.number < 1
  ) {
    throw new Error(`${label} has an invalid number`);
  }
  const htmlUrl = assertExactNonblankString(
    value.html_url,
    `${label} html_url`,
    { max: 2048 }
  );
  let parsed;
  try {
    parsed = new URL(htmlUrl);
  } catch (cause) {
    const error = new Error(`${label} html_url must be an HTTPS URL`);
    error.cause = cause;
    throw error;
  }
  if (parsed.protocol !== 'https:' || parsed.toString() !== htmlUrl) {
    throw new Error(`${label} html_url must be an exact HTTPS URL`);
  }
  return {
    number: value.number,
    html_url: htmlUrl,
  };
}

async function findOpenPullRequest({
  workerOrigin,
  token,
  upstreamOwner,
  upstreamRepo,
  baseBranch,
  headOwner,
  headBranch,
  signal = null,
}) {
  const headQuery = `${headOwner}:${headBranch}`;
  const existing = await githubRequest(
    workerOrigin,
    `/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}/pulls`,
    {
      token,
      query: {
        state: 'open',
        head: headQuery,
        base: baseBranch,
        per_page: 100,
      },
      signal,
    }
  );
  if (!Array.isArray(existing)) {
    throw new Error('GitHub Pull Request lookup must return an array');
  }
  if (existing.length > 1) {
    throw new Error('GitHub returned multiple open Pull Requests for one head');
  }
  return existing.length === 0
    ? null
    : assertPullRequestRecord(
        existing[0],
        'Existing GitHub Pull Request'
      );
}

async function openOrReusePullRequest({
  workerOrigin,
  token,
  upstreamOwner,
  upstreamRepo,
  baseBranch,
  headOwner,
  headRepo,
  headBranch,
  title,
  body,
  signal = null,
}) {
  const exactHeadOwner = assertGitHubLogin(headOwner, 'Pull Request head owner');
  const exactHeadBranch = assertGitHubBranch(
    headBranch,
    'Pull Request head branch'
  );
  const exactBaseBranch = assertGitHubBranch(
    baseBranch,
    'Pull Request base branch'
  );
  const exactTitle = assertExactNonblankString(
    title,
    'Pull Request title',
    { max: 256 }
  );
  const exactBody = assertExactNonblankString(
    body,
    'Pull Request body',
    { max: 65_536 }
  );
  const headQuery = `${exactHeadOwner}:${exactHeadBranch}`;

  const existing = await findOpenPullRequest({
    workerOrigin,
    token,
    upstreamOwner,
    upstreamRepo,
    baseBranch: exactBaseBranch,
    headOwner: exactHeadOwner,
    headBranch: exactHeadBranch,
    signal,
  });
  if (existing !== null) return { pr: existing, reused: true };

  let created = null;
  try {
    created = await githubRequest(
      workerOrigin,
      `/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}/pulls`,
      {
        token,
        method: 'POST',
        body: {
          title: exactTitle,
          head: headQuery,
          base: exactBaseBranch,
          body: exactBody,
          maintainer_can_modify: true
        },
        signal,
      },
    );
    return {
      pr: assertPullRequestRecord(
        created,
        'Created GitHub Pull Request'
      ),
      reused: false,
    };
  } catch (caughtError) {
    const error = attachDocumentMutationOutcome(caughtError, created);
    if (
      !shouldReconcileMutation(error, 'pulls-post') ||
      signal?.aborted === true
    ) {
      throw error;
    }
    try {
      const reconciled = await findOpenPullRequest({
        workerOrigin,
        token,
        upstreamOwner,
        upstreamRepo,
        baseBranch: exactBaseBranch,
        headOwner: exactHeadOwner,
        headBranch: exactHeadBranch,
        signal,
      });
      if (reconciled !== null) {
        return { pr: reconciled, reused: true };
      }
    } catch {
      // Do not create a second Pull Request when one bounded lookup cannot
      // prove the outcome of the dispatched creation.
    }
    throw error;
  }
}

async function publishFileViaPullRequest({
  workerOrigin,
  token,
  upstreamOwner,
  upstreamRepo,
  baseBranch,
  headOwner,
  headRepo,
  headBranch,
  path,
  title,
  body,
  contentBase64,
  signal = null,
}) {
  const upstreamSha = await getBranchTipSha({
    workerOrigin,
    owner: upstreamOwner,
    repo: upstreamRepo,
    token,
    branch: baseBranch,
    signal,
  });

  await ensureBranchExists({
    workerOrigin,
    owner: headOwner,
    repo: headRepo,
    token,
    branch: headBranch,
    baseSha: upstreamSha,
    signal,
  });
  await upsertFileOnBranch({
    workerOrigin,
    owner: headOwner,
    repo: headRepo,
    token,
    branch: headBranch,
    path,
    message: title,
    contentBase64,
    signal,
  });

  const { pr, reused } = await openOrReusePullRequest({
    workerOrigin,
    token,
    upstreamOwner,
    upstreamRepo,
    baseBranch,
    headOwner,
    headRepo,
    headBranch,
    title,
    body,
    signal,
  });

  if (
    !pr ||
    typeof pr !== 'object' ||
    Array.isArray(pr) ||
    !Number.isSafeInteger(pr.number) ||
    pr.number < 1
  ) {
    throw new Error('GitHub Pull Request response has an invalid number');
  }
  const prUrl = assertExactNonblankString(
    pr.html_url,
    'GitHub Pull Request html_url',
    { max: 2048 }
  );
  let parsedPrUrl;
  try {
    parsedPrUrl = new URL(prUrl);
  } catch (cause) {
    const error = new Error('GitHub Pull Request html_url must be an HTTPS URL');
    error.cause = cause;
    throw error;
  }
  if (parsedPrUrl.protocol !== 'https:' || parsedPrUrl.toString() !== prUrl) {
    throw new Error('GitHub Pull Request html_url must be an exact HTTPS URL');
  }
  return { prUrl, prNumber: pr.number, reused };
}

async function publishAnnotationFile({
  publicationMode,
  repoInfo,
  workerOrigin,
  token,
  upstreamOwner,
  upstreamRepo,
  baseBranch,
  datasetId,
  fileUser,
  path,
  title,
  body,
  contentBase64,
  sourceSha,
  signal = null,
}) {
  const mode = assertPublicationMode(publicationMode);
  const capability = assertRepositoryPublicationInfo(repoInfo);
  assertGitHubLogin(upstreamOwner, 'Connected repository owner');
  if (!isCanonicalGitHubRepositoryName(upstreamRepo)) {
    throw new Error('Connected repository name is not canonical');
  }
  const resolvedSource = parseCanonicalGitHubRepositoryReference(
    repoInfo.full_name
  );
  if (resolvedSource === null || resolvedSource.ref !== null) {
    throw new Error(
      'GitHub repository metadata did not resolve an exact source repository'
    );
  }
  if (mode === 'direct') {
    if (!capability.canDirectPush) {
      throw new Error(
        'Direct annotation publication requires GitHub write permission'
      );
    }
    const response = await putContent({
      workerOrigin,
      owner: resolvedSource.owner,
      repo: resolvedSource.repo,
      token,
      path,
      branch: baseBranch,
      message: title,
      contentBase64,
      sha: sourceSha,
      signal,
    });
    const rawSha = response?.content?.sha;
    return {
      mode,
      sha: assertGitHubSha(rawSha, 'Published GitHub content SHA'),
    };
  }

  if (!capability.allowForking) {
    throw new Error(
      'Fork Pull Request publication is disabled for this repository'
    );
  }
  const authUser = assertAuthUserResponse(
    await workerAuthRequest(workerOrigin, '/auth/user', {
      token,
      signal,
    })
  );
  const expectedFileUser = `ghid_${authUser.id}`;
  if (fileUser !== null && fileUser !== expectedFileUser) {
    throw new Error(
      `Pull Request file identity must equal authenticated user ${expectedFileUser}`
    );
  }
  const fork = await selectOrCreateForkRepo({
    workerOrigin,
    upstreamOwner: resolvedSource.owner,
    upstreamRepo: resolvedSource.repo,
    upstreamFullName: repoInfo.full_name,
    token,
    forkOwner: authUser.login,
    signal,
  });
  if (fork.requiresReadiness) {
    await waitForForkBaseRef({
      workerOrigin,
      owner: authUser.login,
      repo: fork.name,
      token,
      branch: baseBranch,
      signal,
    });
  }
  const headBranch = toDeterministicPrBranch({
    datasetId,
    baseBranch,
    fileUser: expectedFileUser,
  });
  const result = await publishFileViaPullRequest({
    workerOrigin,
    token,
    upstreamOwner: resolvedSource.owner,
    upstreamRepo: resolvedSource.repo,
    baseBranch,
    headOwner: authUser.login,
    headRepo: fork.name,
    headBranch,
    path,
    title,
    body,
    contentBase64,
    signal,
  });
  return { mode, ...result };
}

export class CommunityAnnotationGitHubSync {
  constructor({ datasetId, owner, repo, token = null, branch = null, workerOrigin = null } = {}) {
    this.datasetId = assertExactNonblankString(
      datasetId,
      'Annotation sync datasetId',
      { max: 256 }
    );
    if (
      typeof owner !== 'string' ||
      typeof repo !== 'string' ||
      !isCanonicalGitHubAccount(owner) ||
      !isCanonicalGitHubRepositoryName(repo)
    ) {
      throw new Error('Annotation sync owner and repo must be exact GitHub names');
    }
    this.owner = owner;
    this.repo = repo;
    this.token = assertOptionalToken(token);
    this.branch = branch === null ? null : assertGitHubBranch(branch);
    const configuredOrigin = workerOrigin === null
      ? getGitHubWorkerOrigin()
      : workerOrigin;
    this.workerOrigin = assertExactHttpOrigin(
      configuredOrigin,
      'GitHub worker origin'
    );

    this._schemaCheckedRef = null;
    this._repoInfo = null;
  }

  get ownerRepo() {
    return `${this.owner}/${this.repo}`;
  }

  async validateAndLoadConfig({ datasetId, signal = null } = {}) {
    const requestSignal = assertAbortSignalOrNull(
      signal,
      'Annotation config request signal'
    );
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');
    const workerOrigin = this.workerOrigin;
    const repoInfo = await getRepoInfo({
      workerOrigin,
      owner: this.owner,
      repo: this.repo,
      token,
      signal: requestSignal,
    });
    assertRepositoryPublicationInfo(repoInfo);
    this._repoInfo = repoInfo;
    const branch = this.branch === null
      ? assertGitHubBranch(
        repoInfo.default_branch,
        'GitHub repository default_branch'
      )
      : this.branch;

    this.branch = branch;

    // Validate the complete, exact contract published by the repository.
    if (this._schemaCheckedRef !== branch) {
      const schemaSpecs = [
        ['user', 'annotations/schema.json'],
        ['config', 'annotations/config.schema.json'],
        ['merges', 'annotations/moderation/merges.schema.json'],
      ];
      const schemas = await Promise.all(
        schemaSpecs.map(async ([kind, path]) => {
          const { json } = await readJsonFile({
            workerOrigin,
            owner: this.owner,
            repo: this.repo,
            token,
            path,
            ref: branch,
            signal: requestSignal,
          });
          return { kind, path, json };
        })
      );
      schemas.forEach(({ kind, path, json }) => {
        assertSchemaIdentity(json, kind, { path });
      });
      this._schemaCheckedRef = branch;
    }

    const { json: config, sha: configSha } = await readJsonFile({
      workerOrigin,
      owner: this.owner,
      repo: this.repo,
      token,
      path: 'annotations/config.json',
      ref: branch,
      signal: requestSignal,
    });
    assertConfigDocument(config, { path: 'annotations/config.json' });

    const targetDatasetId = datasetId === undefined
      ? this.datasetId
      : assertExactNonblankString(
        datasetId,
        'Annotation config datasetId',
        { max: 256 }
      );
    const supported = config.supportedDatasets;
    const match =
      supported.find((entry) => entry.datasetId === targetDatasetId) ?? null;

    return { repoInfo, branch, config, configSha: configSha || null, datasetId: targetDatasetId, datasetConfig: match };
  }

  async readRepoConfigJson({ signal = null } = {}) {
    const requestSignal = assertAbortSignalOrNull(
      signal,
      'Annotation config read signal'
    );
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');
    const branch = assertGitHubBranch(
      this.branch,
      'Resolved annotation repository branch'
    );
    return readJsonFile({
      workerOrigin: this.workerOrigin,
      owner: this.owner,
      repo: this.repo,
      token,
      path: 'annotations/config.json',
      ref: branch,
      signal: requestSignal,
    });
  }

  async updateDatasetFieldsToAnnotate({
    datasetId,
    datasetName,
    fieldsToAnnotate,
    annotatableSettings,
    closedFields,
    commitMessage = null,
    conflictIfRemoteShaNotEqual = null,
    publicationMode,
    signal = null,
  } = {}) {
    const requestSignal = assertAbortSignalOrNull(
      signal,
      'Annotation config publication signal'
    );
    const mode = assertPublicationMode(publicationMode);
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');

    const { repoInfo, branch } = await this.validateAndLoadConfig({
      datasetId,
      signal: requestSignal,
    });
    const capability = assertRepositoryPublicationInfo(repoInfo);
    if (!capability.canManage) {
      throw new Error(
        'Maintain/admin access required to update annotations/config.json'
      );
    }

    const did = datasetId === undefined
      ? this.datasetId
      : assertExactNonblankString(datasetId, 'datasetId', { max: 256 });

    const msg = commitMessage === null
      ? `Update annotatable fields for ${did}`
      : assertExactNonblankString(
        commitMessage,
        'Annotation config commit message',
        { max: 256 }
      );
    const expectedSha = conflictIfRemoteShaNotEqual === null
      ? null
      : assertGitHubSha(
        conflictIfRemoteShaNotEqual,
        'Expected annotation config SHA'
      );
    const {
      json: current,
      sha,
      contentBase64: remoteContentBase64,
    } = await readJsonFile({
      workerOrigin: this.workerOrigin,
      owner: this.owner,
      repo: this.repo,
      token,
      path: 'annotations/config.json',
      ref: branch,
      signal: requestSignal,
    });
    assertConfigDocument(current, { path: 'annotations/config.json' });

    const {
      config: nextConfig,
      replacement,
    } = buildUpdatedAnnotationConfig({
      currentConfig: current,
      datasetId: did,
      datasetName,
      fieldsToAnnotate,
      annotatableSettings,
      closedFields,
    });
    const contentBase64 = encodeBase64Bytes(
      toAnnotationPublicationBytes(nextConfig, {
        path: 'annotations/config.json',
      })
    );

    if (
      base64PayloadEqualsCanonical(
        remoteContentBase64,
        contentBase64,
        'annotations/config.json'
      )
    ) {
      return {
        mode: 'none',
        branch,
        path: 'annotations/config.json',
        sha: sha || null,
        ...replacement,
        changed: false
      };
    }

    if (!expectedSha) {
      const err = new Error(
        'Missing baseline version for annotations/config.json.\n' +
        'Pull first to load the latest config, then Publish again.'
      );
      err.code = 'COMMUNITY_ANNOTATION_CONFLICT';
      err.path = 'annotations/config.json';
      err.remoteSha = sha || null;
      err.expectedSha = null;
      throw err;
    }
    if (sha !== expectedSha) {
      const err = new Error(
        'annotations/config.json changed since your last Pull.\n' +
        'Pull first to review the latest settings, then Publish again.'
      );
      err.code = 'COMMUNITY_ANNOTATION_CONFLICT';
      err.path = 'annotations/config.json';
      err.remoteSha = sha || null;
      err.expectedSha = expectedSha;
      throw err;
    }

    // Avoid no-op commits: compare semantic JSON ignoring key order.
    const changed = stableStringifyJson(current) !== stableStringifyJson(nextConfig);
    if (!changed) {
      return {
        mode: 'none',
        branch,
        path: 'annotations/config.json',
        sha: sha || null,
        ...replacement,
        changed: false
      };
    }

    try {
      const result = await publishAnnotationFile({
        publicationMode: mode,
        repoInfo,
        workerOrigin: this.workerOrigin,
        token,
        upstreamOwner: this.owner,
        upstreamRepo: this.repo,
        baseBranch: branch,
        datasetId: did,
        fileUser: null,
        path: 'annotations/config.json',
        title: msg,
        body: [
          'Community annotation configuration update from Cellucid.',
          '',
          'File: `annotations/config.json`',
        ].join('\n'),
        contentBase64,
        sourceSha: sha,
        signal: requestSignal,
      });
      return {
        ...result,
        branch,
        path: 'annotations/config.json',
        ...replacement,
        changed: true
      };
    } catch (err) {
      if (isContentConflictError(err)) {
        const conflict = new Error(
          'annotations/config.json changed while publishing.\n' +
          'Pull first to review/merge the latest settings, then Publish again.'
        );
        conflict.code = 'COMMUNITY_ANNOTATION_CONFLICT';
        conflict.path = 'annotations/config.json';
        throw inheritMutationErrorContext(conflict, err);
      }
      throw err;
    }
  }

  async pullModerationMerges({
    knownShas = null,
    signal = null,
  } = {}) {
    const requestSignal = assertAbortSignalOrNull(
      signal,
      'Annotation moderation pull signal'
    );
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');
    const branch = assertGitHubBranch(
      this.branch,
      'Resolved annotation repository branch'
    );
    const workerOrigin = this.workerOrigin;
    const path = 'annotations/moderation/merges.json';
    if (
      knownShas !== null &&
      (
        typeof knownShas !== 'object' ||
        Array.isArray(knownShas)
      )
    ) {
      throw new Error('Known annotation SHAs must be a JSON object or null');
    }
    const previousSha =
      knownShas !== null && Object.hasOwn(knownShas, path)
        ? assertGitHubSha(knownShas[path], `Known SHA for ${path}`)
        : null;
    try {
      const content = await getContent({
        workerOrigin,
        owner: this.owner,
        repo: this.repo,
        token,
        path,
        ref: branch,
        signal: requestSignal,
      });
      if (!content || content.type !== 'file') {
        throw new Error(`Expected file at ${path}`);
      }
      const sha = assertGitHubSha(content.sha, `${path} SHA`);
      if (previousSha === sha) {
        return { doc: null, sha, path, fetched: false };
      }
      const { json } = decodeJsonContentFile(content, path);
      assertMergesDocument(json, { path });
      return { doc: json, sha, path, fetched: true };
    } catch (err) {
      if (isNotFoundError(err)) return { doc: null, sha: null, path, fetched: false };
      throw err;
    }
  }

  async pushModerationMerges({
    mergesDoc,
    commitMessage = null,
    conflictIfRemoteShaNotEqual = null,
    publicationMode,
    signal = null,
  } = {}) {
    const requestSignal = assertAbortSignalOrNull(
      signal,
      'Annotation moderation publication signal'
    );
    const mode = assertPublicationMode(publicationMode);
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');

    const repoInfo =
      this._repoInfo === null
        ? await getRepoInfo({
            workerOrigin: this.workerOrigin,
            owner: this.owner,
            repo: this.repo,
            token,
            signal: requestSignal,
          })
        : this._repoInfo;
    const capability = assertRepositoryPublicationInfo(repoInfo);
    this._repoInfo = repoInfo;
    if (!capability.canManage) {
      throw new Error(
        'Maintain/admin access required to publish moderation merges'
      );
    }

    const branch = this.branch === null
      ? assertGitHubBranch(
        repoInfo?.default_branch,
        'GitHub repository default_branch'
      )
      : assertGitHubBranch(this.branch);
    this.branch = branch;

    const msg = commitMessage === null
      ? 'Update annotation moderation merges'
      : assertExactNonblankString(
        commitMessage,
        'Moderation merges commit message',
        { max: 256 }
      );
    assertMergesDocument(mergesDoc, {
      path: 'annotations/moderation/merges.json publish payload',
    });
    const incoming = mergesDoc;

    const expectedSha = conflictIfRemoteShaNotEqual === null
      ? null
      : assertGitHubSha(
        conflictIfRemoteShaNotEqual,
        'Expected moderation merges SHA'
      );

    const {
      json: current,
      sha,
      contentBase64: remoteContentBase64,
    } = await readJsonFileOrNull({
      workerOrigin: this.workerOrigin,
      owner: this.owner,
      repo: this.repo,
      token,
      path: 'annotations/moderation/merges.json',
      ref: branch,
      signal: requestSignal,
    });

    if (current !== null) {
      assertMergesDocument(current, { path: 'annotations/moderation/merges.json' });
    }
    const currentComparable = current
      ? { version: current.version, merges: current.merges }
      : null;
    const nextComparable = { version: incoming.version, merges: incoming.merges };
    const contentBase64 = encodeBase64Bytes(
      toAnnotationPublicationBytes(incoming, {
        path: 'annotations/moderation/merges.json',
      })
    );

    if (
      remoteContentBase64 !== null &&
      base64PayloadEqualsCanonical(
        remoteContentBase64,
        contentBase64,
        'annotations/moderation/merges.json'
      )
    ) {
      return {
        mode: 'none',
        branch,
        path: 'annotations/moderation/merges.json',
        sha: sha || null,
        changed: false,
      };
    }

    // If the remote file exists, require a baseline SHA from the last Pull.
    if (!expectedSha && sha) {
      const err = new Error(
        'Missing baseline version for annotations/moderation/merges.json.\n' +
        'Pull first to load the latest merges, then Publish again.'
      );
      err.code = 'COMMUNITY_ANNOTATION_CONFLICT';
      err.path = 'annotations/moderation/merges.json';
      err.remoteSha = sha || null;
      err.expectedSha = null;
      throw err;
    }
    if (expectedSha && sha !== expectedSha) {
      const err = new Error(
        'annotations/moderation/merges.json changed since your last Pull.\n' +
        'Pull first to review the latest merges, then Publish again.'
      );
      err.code = 'COMMUNITY_ANNOTATION_CONFLICT';
      err.path = 'annotations/moderation/merges.json';
      err.remoteSha = sha || null;
      err.expectedSha = expectedSha;
      throw err;
    }

    const changed = stableStringifyJson(currentComparable) !== stableStringifyJson(nextComparable);
    if (!changed) {
      return {
        mode: 'none',
        branch,
        path: 'annotations/moderation/merges.json',
        sha: sha || null,
        changed: false,
      };
    }

    try {
      const result = await publishAnnotationFile({
        publicationMode: mode,
        repoInfo,
        workerOrigin: this.workerOrigin,
        token,
        upstreamOwner: this.owner,
        upstreamRepo: this.repo,
        baseBranch: branch,
        datasetId: this.datasetId,
        fileUser: null,
        path: 'annotations/moderation/merges.json',
        title: msg,
        body: [
          'Community annotation moderation update from Cellucid.',
          '',
          'File: `annotations/moderation/merges.json`',
        ].join('\n'),
        contentBase64,
        sourceSha: sha,
        signal: requestSignal,
      });
      return {
        ...result,
        branch,
        path: 'annotations/moderation/merges.json',
        changed: true,
      };
    } catch (err) {
      if (isContentConflictError(err)) {
        const conflict = new Error(
          'annotations/moderation/merges.json changed while publishing.\n' +
          'Pull first to review the latest merges, then Publish again.'
        );
        conflict.code = 'COMMUNITY_ANNOTATION_CONFLICT';
        conflict.path = 'annotations/moderation/merges.json';
        throw inheritMutationErrorContext(conflict, err);
      }
      throw err;
    }
  }

  async getAuthenticatedUser({ signal = null } = {}) {
    const requestSignal = assertAbortSignalOrNull(
      signal,
      'Authenticated GitHub user request signal'
    );
    const token = this.token;
    if (!token) return null;
    return assertAuthUserResponse(
      await workerAuthRequest(this.workerOrigin, '/auth/user', {
        token,
        signal: requestSignal,
      })
    );
  }

  async pullAllUsers({ knownShas = null, signal = null } = {}) {
    const requestSignal = assertAbortSignalOrNull(
      signal,
      'Annotation users pull signal'
    );
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');
    const branch = assertGitHubBranch(
      this.branch,
      'Resolved annotation repository branch'
    );
    const workerOrigin = this.workerOrigin;

    const tree = await getGitTreeRecursive({
      workerOrigin,
      owner: this.owner,
      repo: this.repo,
      token,
      ref: branch,
      signal: requestSignal,
    });
    if (!Array.isArray(tree)) {
      throw new Error('Git tree response must contain an array');
    }
    const userBlobs = [];
    let hasUsersInventory = false;
    for (const entry of tree) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('Git tree entries must be objects');
      }
      const path = entry.path;
      if (
        typeof path !== 'string' ||
        !path ||
        /^\s|\s$/.test(path)
      ) {
        throw new Error('Git tree entry path must be an exact nonblank string');
      }

      if (path === ANNOTATION_USERS_DIRECTORY_PATH) {
        if (entry.type !== 'tree') {
          throw new Error(
            `${ANNOTATION_USERS_DIRECTORY_PATH} must be a Git tree`
          );
        }
        hasUsersInventory = true;
        continue;
      }

      if (path === EMPTY_ANNOTATION_USERS_SENTINEL.path) {
        if (
          entry.type !== 'blob' ||
          entry.sha !== EMPTY_ANNOTATION_USERS_SENTINEL.sha ||
          entry.size !== EMPTY_ANNOTATION_USERS_SENTINEL.size
        ) {
          throw new Error(
            `${EMPTY_ANNOTATION_USERS_SENTINEL.path} must be the exact ` +
            'one-byte pristine template sentinel'
          );
        }
        hasUsersInventory = true;
        continue;
      }

      if (!path.startsWith(ANNOTATION_USERS_PATH_PREFIX)) {
        const lowerPath = path.toLowerCase();
        if (
          lowerPath === ANNOTATION_USERS_DIRECTORY_PATH ||
          lowerPath.startsWith(ANNOTATION_USERS_PATH_PREFIX)
        ) {
          throw new Error(
            `Invalid annotation users inventory path ${JSON.stringify(path)}; ` +
            `expected exact lowercase ${ANNOTATION_USERS_DIRECTORY_PATH}`
          );
        }
        continue;
      }
      if (
        entry.type !== 'blob' ||
        !/^annotations\/users\/ghid_[1-9][0-9]*\.json$/.test(path)
      ) {
        throw new Error(
          `Invalid annotation user-file path ${JSON.stringify(path)}; ` +
          'expected annotations/users/ghid_<positive-github-id>.json'
        );
      }
      hasUsersInventory = true;
      userBlobs.push(entry);
    }
    if (!hasUsersInventory) {
      throw new Error(
        `Git tree does not contain the required ${ANNOTATION_USERS_DIRECTORY_PATH} inventory`
      );
    }
    if (
      userBlobs.length >
      COMMUNITY_ANNOTATION_MAX_PULL_USER_FILES
    ) {
      throw new CommunityAnnotationPullLimitError(
        'user-files',
        userBlobs.length,
        COMMUNITY_ANNOTATION_MAX_PULL_USER_FILES
      );
    }

    /** @type {Record<string, string>} */
    const nextShas = {};
    const userBlobSizes = new Map();
    let totalDecodedBytes = 0;
    for (const f of userBlobs) {
      const path = f.path;
      if (!Number.isSafeInteger(f.size) || f.size < 0) {
        throw new Error(
          `Git tree is missing the decoded byte size for ${JSON.stringify(path)}`
        );
      }
      if (f.size > ANNOTATION_FILE_MAX_UTF8_BYTES) {
        throw new AnnotationFileTooLargeError(
          path,
          f.size,
          { phase: 'remote-tree-preflight' }
        );
      }
      totalDecodedBytes += f.size;
      const sha = assertGitHubSha(
        f.sha,
        `Git tree SHA for ${JSON.stringify(path)}`
      );
      if (Object.hasOwn(nextShas, path)) {
        throw new Error(`Git tree contains duplicate path ${JSON.stringify(path)}`);
      }
      nextShas[path] = sha;
      userBlobSizes.set(path, f.size);
    }
    if (
      totalDecodedBytes >
      COMMUNITY_ANNOTATION_MAX_PULL_UTF8_BYTES
    ) {
      throw new CommunityAnnotationPullLimitError(
        'decoded-bytes',
        totalDecodedBytes,
        COMMUNITY_ANNOTATION_MAX_PULL_UTF8_BYTES
      );
    }

    if (
      knownShas !== null &&
      (
        typeof knownShas !== 'object' ||
        Array.isArray(knownShas)
      )
    ) {
      throw new Error('Known annotation SHAs must be a JSON object or null');
    }
    if (knownShas !== null) {
      for (const [path, sha] of Object.entries(knownShas)) {
        if (
          path !== 'annotations/config.json' &&
          path !== 'annotations/moderation/merges.json' &&
          !/^annotations\/users\/ghid_[1-9][0-9]*\.json$/.test(path)
        ) {
          throw new Error(
            `Known annotation SHA path is invalid: ${JSON.stringify(path)}`
          );
        }
        assertGitHubSha(sha, `Known SHA for ${path}`);
      }
    }
    const needsFetch = (path, sha) => {
      if (knownShas === null || !Object.hasOwn(knownShas, path)) return true;
      return knownShas[path] !== sha;
    };

    const allPaths = Object.keys(nextShas).sort((a, b) => a.localeCompare(b));
    const toFetch = allPaths.filter((path) => needsFetch(path, nextShas[path]));

    const concurrency = DEFAULT_USER_PULL_CONCURRENCY;
    const out = await mapWithConcurrency(
      toFetch,
      concurrency,
      async (path, _index, batchSignal) => {
        const sha = nextShas[path] || null;
        const filename = path.split('/').pop();
        const { decodedByteLength, json } = await getGitBlobJson({
          workerOrigin,
          owner: this.owner,
          repo: this.repo,
          token,
          sha,
          path,
          signal: batchSignal,
        });
        const expectedDecodedByteLength =
          userBlobSizes.get(path) ?? null;
        if (decodedByteLength !== expectedDecodedByteLength) {
          throw new Error(
            `Git blob ${JSON.stringify(path)} decoded byte length changed ` +
            'from the recursive tree; start a new Pull'
          );
        }
        assertUserDocument(json, { path, filename });
        return { path, sha, doc: json };
      },
      { signal: requestSignal }
    );

    return {
      docs: out,
      shas: nextShas,
      fetchedCount: toFetch.length,
      totalCount: allPaths.length,
      concurrency
    };
  }

  async pullUserFile({ userKey = null, signal = null } = {}) {
    const requestSignal = assertAbortSignalOrNull(
      signal,
      'Annotation user-file pull signal'
    );
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');
    const branch = assertGitHubBranch(
      this.branch,
      'Resolved annotation repository branch'
    );
    const workerOrigin = this.workerOrigin;

    const key = sanitizeUserKeyForPath(userKey);
    if (!key) throw new Error('userKey required');

    try {
      const path = `annotations/users/${key}.json`;
      const { json, sha } = await readJsonFile({
        workerOrigin,
        owner: this.owner,
        repo: this.repo,
        token,
        path,
        ref: branch,
        signal: requestSignal,
      });
      assertUserDocument(json, { path, filename: `${key}.json` });
      return { doc: json, sha: sha || null, path };
    } catch (err) {
      if (err?.status === 404) return null;
      throw err;
    }
  }

  async pushMyUserFile({
    userDoc,
    commitMessage = null,
    conflictIfRemoteShaNotEqual = null,
    publicationMode,
    signal = null,
  } = {}) {
    const requestSignal = assertAbortSignalOrNull(
      signal,
      'Annotation user-file publication signal'
    );
    const mode = assertPublicationMode(publicationMode);
    const token = this.token;
    if (!token) throw new Error('GitHub token required to push');
    const branch = assertGitHubBranch(
      this.branch,
      'Resolved annotation repository branch'
    );
    const workerOrigin = this.workerOrigin;

    const id = userDoc?.githubUserId;
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new Error('User doc githubUserId must be a positive safe integer');
    }
    const fileUser = `ghid_${id}`;
    const path = `annotations/users/${fileUser}.json`;
    assertUserDocument(userDoc, { path, filename: `${fileUser}.json` });
    const content = encodeBase64Bytes(
      toAnnotationPublicationBytes(userDoc, { path })
    );
    const authenticatedUser = assertAuthUserResponse(
      await workerAuthRequest(workerOrigin, '/auth/user', {
        token,
        signal: requestSignal,
      })
    );
    if (authenticatedUser.id !== id) {
      throw new Error(
        `User document identity ${fileUser} does not match authenticated GitHub user ghid_${authenticatedUser.id}`
      );
    }

    let sha = null;
    let remoteUpdatedAt = null;
    let remoteContentBase64 = null;
    try {
      const existing = await getContent({
        workerOrigin,
        owner: this.owner,
        repo: this.repo,
        token,
        path,
        ref: branch,
        signal: requestSignal,
      });
      const {
        json: parsed,
        sha: existingSha,
        contentBase64: existingContentBase64,
      } = decodeJsonContentFile(existing, path);
      sha = existingSha;
      assertUserDocument(parsed, { path, filename: `${fileUser}.json` });
      remoteUpdatedAt = parsed.updatedAt;
      remoteContentBase64 = existingContentBase64;
    } catch (err) {
      if (err?.status !== 404) throw err;
    }

    if (
      remoteContentBase64 !== null &&
      base64PayloadEqualsCanonical(remoteContentBase64, content, path)
    ) {
      return {
        mode: 'none',
        branch,
        path,
        sha,
        remoteUpdatedAt,
      };
    }

    const expectedSha = conflictIfRemoteShaNotEqual === null
      ? null
      : assertGitHubSha(
        conflictIfRemoteShaNotEqual,
        'Expected remote user-file SHA'
      );
    if (!expectedSha && sha) {
      const err = new Error(
        'Missing baseline version for your remote user file.\n' +
        'Pull first to merge any existing votes/suggestions, then Publish again.'
      );
      err.code = 'COMMUNITY_ANNOTATION_CONFLICT';
      err.remoteUpdatedAt = remoteUpdatedAt;
      err.remoteSha = sha;
      err.expectedSha = null;
      err.path = path;
      throw err;
    }
    if (expectedSha && sha !== expectedSha) {
      const err = new Error(
        'Remote user file changed since your last Pull.\n' +
        'Pull first to merge changes before publishing.'
      );
      err.code = 'COMMUNITY_ANNOTATION_CONFLICT';
      err.remoteUpdatedAt = remoteUpdatedAt;
      err.remoteSha = sha;
      err.expectedSha = expectedSha;
      err.path = path;
      throw err;
    }

    const repoInfo =
      this._repoInfo === null
        ? await getRepoInfo({
            workerOrigin,
            owner: this.owner,
            repo: this.repo,
            token,
            signal: requestSignal,
          })
        : this._repoInfo;
    assertRepositoryPublicationInfo(repoInfo);
    this._repoInfo = repoInfo;
    const msg = commitMessage === null
      ? `Update annotations for @${authenticatedUser.login}`
      : assertExactNonblankString(
        commitMessage,
        'Annotation user-file commit message',
        { max: 256 }
      );
    try {
      const result = await publishAnnotationFile({
        publicationMode: mode,
        repoInfo,
        workerOrigin,
        upstreamOwner: this.owner,
        upstreamRepo: this.repo,
        token,
        baseBranch: branch,
        datasetId: this.datasetId,
        fileUser,
        path,
        title: msg,
        body: [
          'Community annotation update from Cellucid.',
          '',
          `User: @${authenticatedUser.login}`,
          `File: \`${path}\``,
        ].join('\n'),
        contentBase64: content,
        sourceSha: sha,
        signal: requestSignal,
      });
      return { ...result, path, remoteUpdatedAt };
    } catch (err) {
      if (isContentConflictError(err)) {
        const conflict = new Error(
          'Remote user file changed while publishing.\n' +
          'Pull first to merge changes before publishing.'
        );
        conflict.code = 'COMMUNITY_ANNOTATION_CONFLICT';
        conflict.remoteUpdatedAt = remoteUpdatedAt;
        conflict.path = path;
        throw inheritMutationErrorContext(conflict, err);
      }
      throw err;
    }
  }
}

export function getGitHubSyncForDataset({ datasetId, username = 'local', tokenOverride = null } = {}) {
  const repo = getAnnotationRepoForDataset(datasetId, username);
  if (!repo) return null;
  const parsed = parseOwnerRepo(repo);
  if (!parsed) return null;
  const meta = getAnnotationRepoMetaForDataset(datasetId, username);
  if (!meta || (meta.branchMode !== 'default' && meta.branchMode !== 'explicit')) {
    throw new Error('Stored annotation repository connection is missing exact branchMode');
  }
  if (meta.branchMode === 'explicit' && parsed.ref === null) {
    throw new Error('Explicit annotation repository connection is missing its branch');
  }
  const branchMode = meta.branchMode;
  const token = tokenOverride === null
    ? getGitHubAuthSession().getToken()
    : assertOptionalToken(tokenOverride);
  return new CommunityAnnotationGitHubSync({
    datasetId,
    owner: parsed.owner,
    repo: parsed.repo,
    token,
    branch: branchMode === 'explicit' ? (parsed.ref || null) : null,
    workerOrigin: getGitHubWorkerOrigin()
  });
}

export function setDatasetAnnotationRepoFromUrlParam({ datasetId, urlParamValue, username = 'local' }) {
  const parsed = parseOwnerRepo(urlParamValue);
  if (!parsed || parsed.ref === null) return false;
  return setAnnotationRepoForDataset(
    datasetId,
    parsed.ownerRepoRef,
    username,
    { branchMode: 'explicit' }
  );
}

export async function resolveAnnotationRepositoryFromUrlParam({
  urlParamValue,
  tokenOverride = null,
  signal = null,
} = {}) {
  const requestSignal = assertAbortSignalOrNull(
    signal,
    'Annotation repository resolution signal'
  );
  const parsed = parseOwnerRepo(urlParamValue);
  if (!parsed) return null;

  // Default-branch ownership is resolved once, before the repository reference
  // becomes persistent state.
  if (!parsed.ref) {
    const token = tokenOverride === null
      ? getGitHubAuthSession().getToken()
      : assertOptionalToken(tokenOverride);
    if (!token) return false;
    const repoInfo = await getRepoInfo({
      workerOrigin: getGitHubWorkerOrigin(),
      owner: parsed.owner,
      repo: parsed.repo,
      token,
      signal: requestSignal,
    });
    const head = assertGitHubBranch(
      repoInfo?.default_branch,
      'GitHub repository default_branch'
    );
    return {
      repoRef: `${parsed.ownerRepo}@${head}`,
      branchMode: 'default',
    };
  }

  return {
    repoRef: parsed.ownerRepoRef,
    branchMode: 'explicit',
  };
}

export async function setDatasetAnnotationRepoFromUrlParamAsync({
  datasetId,
  urlParamValue,
  username = 'local',
  tokenOverride = null,
  signal = null,
} = {}) {
  const resolved = await resolveAnnotationRepositoryFromUrlParam({
    urlParamValue,
    tokenOverride,
    signal,
  });
  if (resolved === null || resolved === false) return false;
  return setAnnotationRepoForDataset(
    datasetId,
    resolved.repoRef,
    username,
    { branchMode: resolved.branchMode }
  );
}
