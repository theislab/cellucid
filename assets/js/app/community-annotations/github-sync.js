/**
 * Community Annotation - GitHub sync through the community-annotation Worker.
 *
 * Every request goes through `worker-request.js` (the app's one transport:
 * stall timeouts, request budgets from GitHub's headers, retries per request).
 *
 * **Pull** (`openSnapshot`, `validateAndLoadConfig`, `pullFiles`) reads one
 * commit, then only what changed under it:
 *
 * 1. Repository metadata, asked with `If-None-Match` (its last ETag and body
 *    are kept for the page: an unchanged answer is a `304`).
 * 2. `POST /graphql/snapshot` at the resolved branch: the commit and every
 *    entry of `annotations/` and `annotations/moderation/` with its blob id
 *    and size. Everything after is read by object id from this one commit,
 *    never at the branch name, so one Pull never mixes two commits. When the
 *    `annotations` tree id equals the last completed Pull's (`file-cache.js`
 *    marker), nothing changed: the Pull stops there.
 * 3. The three schemas are checked by blob id against
 *    `ANNOTATION_SCHEMA_BLOB_OIDS` (no download).
 * 4. The users tree is listed by its id (`GET git/trees/{oid}`, skipped when
 *    it is the last completed Pull's); a tree GitHub truncated is an explicit
 *    error.
 * 5. Changed files (user files, the merges file, the config) are read through
 *    `POST /graphql/blobs`, packed into batches by their sizes in the tree
 *    (an adaptive batch: doubled after a batch succeeds, halved when GitHub
 *    or the Worker refuses one for its size or time); a blob whose text GitHub
 *    truncated is read alone through the REST blob route.
 * 6. Each file is validated and projected onto the open dataset as its batch
 *    arrives, and kept in the file cache with the batch: an interrupted Pull
 *    resumes from there. A file that fails is excluded on its own (kept as
 *    excluded, with its reason, by blob id, so it is not read again until it
 *    changes) and reported; a path under `annotations/users/` that is not a
 *    user file, and a case variant of an annotation path, is ignored and
 *    listed. A Pull never stops for one file.
 * 7. Files gone from the repository are pruned, then the Pull is marked
 *    complete.
 *
 * **Publish** writes only the contributor's own `annotations/users/ghid_<id>.json`
 * (and, for authors, `annotations/config.json` and the merges file), directly
 * or, without write access, through one pull request per contributor and
 * base branch from their fork (`publishUserFileViaFork`; the contributor
 * makes the fork on GitHub, Cellucid only finds it).
 *
 * Never logs tokens; no DOM.
 */

import { getGitHubAuthSession, getGitHubWorkerOrigin } from './github-auth.js';
import {
  getAnnotationRepoForDataset,
  getAnnotationRepoMetaForDataset,
  setAnnotationRepoForDataset
} from './repo-store.js';
import {
  ANNOTATION_FILE_MAX_UTF8_BYTES,
  ANNOTATION_SCHEMA_BLOB_OIDS,
  AnnotationFileTooLargeError,
  assertConfigDocument,
  assertMergesDocument,
  assertUserFile,
  composeMergesFile,
  composeUserFile,
  projectMergesFile,
  projectUserFile,
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
import {
  assertWorkerTransport,
  defaultWorkerTransport,
  namedWaitMsOf,
  requestWorker,
  WORKER_RESPONSE_CUT,
} from './worker-request.js';
import { ANNOTATION_MERGES_PATH } from './file-cache.js';
import { OPERATION_ID_HEADER, OPERATION_OUTCOME_HEADER } from './worker-contract.js';
import { isLimitAnswer } from '../../formats/io/byte-source.js';
import { requireExactObjectKeys } from '../../utils/exact-record.js';
import { cancelled } from '../../utils/abort.js';

const GIT_OID = /^[0-9a-f]{40}$/;
const USER_FILE_NAME = /^ghid_([1-9][0-9]*)\.json$/;
const ANNOTATION_CONFIG_PATH = 'annotations/config.json';
const ANNOTATION_TEMPLATE_URL = 'https://github.com/theislab/cellucid-annotation';
const PUBLICATION_MODES = new Set(['direct', 'fork-pull-request']);
const OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION_OUTCOMES = new Set(['applied', 'not-applied', 'unknown']);

/**
 * The first `/graphql/blobs` batch carries files of about this many bytes
 * (their sizes in the tree, plus `BLOB_RECORD_OVERHEAD_BYTES` each); every
 * batch that succeeds doubles it, and one GitHub or the Worker refuses for
 * its size or time (HTTP 413, 502, 504, a GraphQL resource or timeout error)
 * halves it. A scheduling size, not a limit: a larger file is a batch of its
 * own, and no file is left unread. 256 KiB is about 250 typical user files
 * of a large repository (about 1 KB each), so the batches of a first Pull of
 * 5,000 users grow 256 KiB, 512 KiB, 1 MiB, 2 MiB: about six requests.
 */
const BLOB_BATCH_START_BYTES = 256 * 1024;

/**
 * What one blob adds to a batch beyond its bytes: its id in the request
 * (`"<40 hex>",`) and its record in the answer (`"b123":{"oid":...,
 * "byteSize":...,"isBinary":false,"isTruncated":false,"text":""}`), so a
 * repository of many tiny files is packed by request size too. Measured from
 * the shapes, a scheduling size.
 */
const BLOB_RECORD_OVERHEAD_BYTES = 160;

/** The statuses a blob batch is halved on instead of asked again as it is (module doc, step 5). */
const BLOB_BATCH_RESIZE_STATUSES = new Set([413, 502, 504]);
/** GraphQL error types that say a query asked too much at once (GitHub's resource limits). */
const GRAPHQL_RESOURCE_ERRORS = new Set(['MAX_NODE_LIMIT_EXCEEDED', 'RESOURCE_LIMITS_EXCEEDED']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactNonblankString(value, label) {
  if (typeof value !== 'string' || !value || /^\s|\s$/.test(value)) {
    throw new Error(`${label} must be an exact nonblank string`);
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
  const branch = assertExactNonblankString(value, label);
  if (!isCanonicalGitHubBranch(branch)) {
    throw new Error(`${label} is not a canonical GitHub branch`);
  }
  return branch;
}

function assertGitHubSha(value, label) {
  if (typeof value !== 'string' || !GIT_OID.test(value)) {
    throw new Error(`${label} must be a lowercase 40-character Git SHA`);
  }
  return value;
}

function assertOptionalToken(value) {
  if (value === null) return null;
  return assertExactNonblankString(value, 'GitHub token');
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

function assertSafeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

/** The caller stopped a GitHub request: a cancellation naming what it was. */
function ownedRequestCancelled(label, cause = undefined) {
  return cancelled('user', `${label} was cancelled.`, cause);
}

function assertPublicationMode(value) {
  if (!PUBLICATION_MODES.has(value)) {
    throw new Error('publicationMode must equal "direct" or "fork-pull-request"');
  }
  return value;
}

function assertGitHubLogin(value, label = 'GitHub login') {
  const login = assertExactNonblankString(value, label);
  if (!isCanonicalGitHubAccount(login)) {
    throw new Error(`${label} is not a canonical GitHub account`);
  }
  return login;
}

function assertGitHubRepositoryFullName(value, label) {
  const fullName = assertExactNonblankString(value, label);
  if (!isCanonicalGitHubRepositoryFullName(fullName)) {
    throw new Error(`${label} must equal an exact owner/repository name`);
  }
  return fullName;
}

function assertRepositoryPublicationInfo(repoInfo) {
  requireExactObjectKeys(
    repoInfo,
    ['full_name', 'default_branch', 'private', 'allow_forking', 'permissions'],
    'GitHub repository metadata'
  );
  assertGitHubRepositoryFullName(repoInfo.full_name, 'GitHub repository full_name');
  assertGitHubBranch(repoInfo.default_branch, 'GitHub repository default_branch');
  if (typeof repoInfo.private !== 'boolean') {
    throw new Error('GitHub repository private must be boolean');
  }
  if (typeof repoInfo.allow_forking !== 'boolean') {
    throw new Error('GitHub repository allow_forking must be boolean');
  }
  const permissions = repoInfo.permissions;
  requireExactObjectKeys(
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
    canDirectPush: permissions.push || permissions.maintain || permissions.admin,
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
  assertConfigDocument(currentConfig, { path: ANNOTATION_CONFIG_PATH });
  const did = assertExactNonblankString(datasetId, 'datasetId');
  const existing =
    currentConfig.supportedDatasets.find(entry => entry.datasetId === did) ?? null;
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
  assertConfigDocument(config, { path: 'annotations/config.json publish payload' });
  return { config, replacement };
}

function assertAuthUserResponse(value) {
  if (
    !isPlainObject(value) ||
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

// ---------------------------------------------------------------- mutations

function deriveGitHubMutationKind(method, path) {
  if (method === 'GET') return null;
  if (method === 'PUT' && /^\/repos\/[^/]+\/[^/]+\/contents\/.+$/.test(path)) {
    return 'contents-put';
  }
  if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/git\/refs$/.test(path)) {
    return 'git-refs-post';
  }
  if (method === 'PATCH' && /^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/.+$/.test(path)) {
    return 'git-ref-patch';
  }
  if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/pulls$/.test(path)) {
    return 'pulls-post';
  }
  throw new Error(`GitHub ${method} ${path} has no exact mutation operation contract`);
}

function createGitHubMutationOperation(method, path) {
  const kind = deriveGitHubMutationKind(method, path);
  if (kind === null) return null;
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('crypto.randomUUID is required for GitHub mutation ownership');
  }
  const id = globalThis.crypto.randomUUID();
  if (typeof id !== 'string' || !OPERATION_ID.test(id)) {
    throw new Error('crypto.randomUUID returned a non-canonical operation identity');
  }
  return Object.freeze({ id, kind });
}

function mutationOperationRecord(operation, outcome) {
  if (
    !isPlainObject(operation) ||
    !OPERATION_ID.test(operation.id) ||
    typeof operation.kind !== 'string' ||
    !OPERATION_OUTCOMES.has(outcome)
  ) {
    throw new Error('Invalid GitHub mutation outcome record');
  }
  return Object.freeze({ id: operation.id, kind: operation.kind, outcome });
}

function createUnknownMutationOutcomeError(message, operation, cause = undefined) {
  const error = new Error(message);
  error.code = 'GITHUB_MUTATION_OUTCOME_UNKNOWN';
  error.operation = mutationOperationRecord(operation, 'unknown');
  if (cause !== undefined) error.cause = cause;
  return error;
}

function readWorkerMutationOutcome(response, operation) {
  if (response.headers.get(OPERATION_ID_HEADER) !== operation.id) {
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
  if ((response.ok && outcome !== 'applied') || (!response.ok && outcome === 'applied')) {
    throw createUnknownMutationOutcomeError(
      'GitHub mutation operation outcome contradicts its HTTP status',
      operation
    );
  }
  return outcome;
}

function attachMutationOutcome(error, operation, outcome) {
  error.operation = mutationOperationRecord(operation, outcome);
  return error;
}

function attachMutationOutcomeToDocument(document, operation, outcome) {
  if (!isPlainObject(document)) {
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
    isPlainObject(error) || error instanceof Error
  ) {
    if (!error.operation && isPlainObject(document) && document.operation) {
      error.operation = document.operation;
    }
  }
  return error;
}

function shouldReconcileMutation(error, kind) {
  const operation = error?.operation;
  if (
    operation &&
    operation.kind === kind &&
    (operation.outcome === 'unknown' || operation.outcome === 'applied')
  ) {
    return true;
  }
  return (
    (error?.status === 409 || error?.status === 422) &&
    (!operation || (operation.kind === kind && operation.outcome === 'not-applied'))
  );
}

function inheritMutationErrorContext(error, cause) {
  error.cause = cause;
  if (Number.isSafeInteger(cause?.status)) error.status = cause.status;
  if (cause?.operation) error.operation = cause.operation;
  if (cause?.github) error.github = cause.github;
  return error;
}

function stableStringifyJson(value) {
  const ancestors = new WeakSet();
  const walk = (v) => {
    if (v === null) return null;
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v !== 'object') throw new Error('Cannot compare a non-JSON value');
    if (ancestors.has(v)) throw new Error('Cannot compare cyclic JSON');
    ancestors.add(v);
    if (Array.isArray(v)) {
      const array = v.map(walk);
      ancestors.delete(v);
      return array;
    }
    const out = Object.create(null);
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    ancestors.delete(v);
    return out;
  };
  return JSON.stringify(walk(value));
}

// ------------------------------------------------------------------- base64

function encodeBase64Bytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('Base64 input must be a Uint8Array');
  const chunks = [];
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize))));
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
  { compareCanonical = null, path = 'GitHub annotation content', phase = 'remote-read' } = {}
) {
  if (typeof value !== 'string') throw new Error('GitHub annotation content must be a base64 string');
  if (compareCanonical !== null && typeof compareCanonical !== 'string') {
    throw new Error('Canonical base64 comparison input must be a string');
  }
  const invalid = () => new Error('GitHub annotation content must be valid base64 with optional line folding');
  let payloadLength = 0;
  let padding = 0;
  let hasFolding = false;
  let equalsCanonical = compareCanonical === null ? null : true;
  let lastAlphabetValue = -1;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 13) {
      if (value.charCodeAt(index + 1) !== 10) throw invalid();
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
      if (padding > 2) throw invalid();
    } else {
      const alphabetValue = base64AlphabetValue(code);
      if (alphabetValue < 0 || padding !== 0) throw invalid();
      lastAlphabetValue = alphabetValue;
    }
    if (
      compareCanonical !== null &&
      (payloadLength >= compareCanonical.length || code !== compareCanonical.charCodeAt(payloadLength))
    ) {
      equalsCanonical = false;
    }
    payloadLength += 1;
  }
  if (payloadLength === 0 || payloadLength % 4 !== 0) throw invalid();
  if (
    (padding === 1 && (lastAlphabetValue & 0b11) !== 0) ||
    (padding === 2 && (lastAlphabetValue & 0b1111) !== 0)
  ) {
    throw new Error('GitHub annotation content must be canonical base64 with zero padding bits');
  }
  if (compareCanonical !== null && payloadLength !== compareCanonical.length) {
    equalsCanonical = false;
  }
  const decodedByteLength = (payloadLength / 4) * 3 - padding;
  if (decodedByteLength > ANNOTATION_FILE_MAX_UTF8_BYTES) {
    throw new AnnotationFileTooLargeError(path, decodedByteLength, { phase });
  }
  return { decodedByteLength, equalsCanonical, hasFolding, payloadLength };
}

function base64PayloadEqualsCanonical(value, canonical, path) {
  const canonicalInfo = scanFoldedBase64Payload(canonical, { path, phase: 'publication-preflight' });
  if (canonicalInfo.hasFolding) throw new Error('Canonical base64 comparison input must not be folded');
  return scanFoldedBase64Payload(value, { compareCanonical: canonical, path }).equalsCanonical === true;
}

/** Decode base64 text (optionally folded) to exact UTF-8; a UTF-8 BOM is kept, so exact JSON refuses it. */
function decodeBase64Utf8(b64, path) {
  const { decodedByteLength, hasFolding } = scanFoldedBase64Payload(b64, { path });
  const base64 = hasFolding ? b64.replaceAll('\r\n', '').replaceAll('\n', '') : b64;
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return {
    decoded: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    decodedByteLength,
  };
}

const utf8Encoder = new TextEncoder();

// ---------------------------------------------------------------- transport

/**
 * What one sync talks to the Worker with: its origin, the token, the
 * transport (`worker-request.js`) and who hears a wait the host names.
 *
 * @typedef {{workerOrigin: string, token: string|null, transport: object,
 *   onWait: ((wait: object|null) => void)|null}} WorkerContext
 */

function workerUrl(workerOrigin, scope, path, query) {
  const origin = assertExactHttpOrigin(workerOrigin, 'GitHub worker origin');
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error('Worker path must start with "/"');
  }
  const url = new URL(`${origin}${scope === 'api' ? '/api' : ''}${path}`);
  if (query !== null) {
    if (!isPlainObject(query)) throw new Error('GitHub query must be a JSON object or null');
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === 'string') {
        url.searchParams.set(assertExactNonblankString(key, 'GitHub query key'), assertExactNonblankString(value, `GitHub query ${key}`));
      } else if (Number.isSafeInteger(value) && value >= 0) {
        url.searchParams.set(key, `${value}`);
      } else {
        throw new Error(`GitHub query ${key} must be an exact string or nonnegative safe integer`);
      }
    }
  }
  return url;
}

/** The Worker's own error words (`{"error": "..."}`), or the status. */
function workerErrorMessage(text, label, status) {
  try {
    const document = JSON.parse(text);
    if (
      isPlainObject(document) &&
      Object.keys(document).length === 1 &&
      typeof document.error === 'string' &&
      document.error.trim() !== ''
    ) {
      return document.error;
    }
  } catch {
    // Not the Worker's error document: said by its status.
  }
  return `${label} failed with HTTP ${status}`;
}

/**
 * One request to the Worker: `scope` 'api' is the GitHub proxy
 * (`/api/repos/...`; a mutation carries an operation id and its outcome is
 * read), 'service' the Worker's own routes (`/auth/user`, `/graphql/*`).
 * Answers `{status, document, etag, response}`: the JSON body of a success,
 * or `status: 304` and no document for an unchanged conditional GET. Every
 * other answer throws an error carrying `status`, where it was asked
 * (`github` / `worker`: `{path, method}`), whether it was a rate limit
 * (`rateLimited`, `retryAfterMs`) and a mutation's outcome (`operation`).
 *
 * @param {WorkerContext} ctx
 */
async function callWorker(ctx, {
  scope,
  path,
  method = 'GET',
  query = null,
  body = null,
  ifNoneMatch = null,
  signal = null,
  answersAsIs = null,
}) {
  if (scope !== 'api' && scope !== 'service') throw new Error('Worker request scope must equal api or service');
  if (!['GET', 'POST', 'PUT', 'PATCH'].includes(method)) {
    throw new Error('GitHub request method must equal GET, POST, PUT, or PATCH');
  }
  const url = workerUrl(ctx.workerOrigin, scope, path, query);
  const ownerSignal = assertAbortSignalOrNull(signal);
  const where = scope === 'api' ? { github: { path, method } } : { worker: { path, method } };
  const decorate = (error) => {
    if (error && typeof error === 'object' && !error.github && !error.worker) Object.assign(error, where);
    return error;
  };
  const operation = scope === 'api' ? createGitHubMutationOperation(method, path) : null;
  const headers = { Accept: scope === 'api' ? 'application/vnd.github+json' : 'application/json' };
  const token = assertOptionalToken(ctx.token);
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (body !== null) headers['Content-Type'] = 'application/json';
  if (ifNoneMatch !== null) headers['If-None-Match'] = ifNoneMatch;
  if (operation !== null) headers[OPERATION_ID_HEADER] = operation.id;
  const label = `GitHub ${method} ${scope === 'api' ? '' : 'worker '}${path}`;

  let dispatched = false;
  let answer;
  try {
    if (ownerSignal?.aborted) throw ownedRequestCancelled(label, ownerSignal.reason);
    answer = await requestWorker(ctx.transport, url.toString(), {
      method,
      headers,
      body: body === null ? undefined : stableStringifyJson(body),
    }, {
      signal: ownerSignal,
      label,
      origin: ctx.workerOrigin,
      mutation: operation !== null,
      onWait: ctx.onWait,
      answersAsIs,
      onDispatch: () => {
        dispatched = true;
      },
    });
  } catch (error) {
    if (ownerSignal?.aborted) {
      const stop = ownedRequestCancelled(label, ownerSignal.reason ?? error);
      if (operation !== null && dispatched) {
        throw decorate(createUnknownMutationOutcomeError(
          'GitHub mutation outcome is unknown after request cancellation',
          operation,
          stop
        ));
      }
      throw decorate(stop);
    }
    if (operation !== null && dispatched) {
      throw decorate(createUnknownMutationOutcomeError(
        'GitHub mutation outcome is unknown after a transport failure',
        operation,
        error
      ));
    }
    throw decorate(error);
  }

  const { response, text } = answer;
  let outcome = null;
  if (operation !== null) {
    try {
      outcome = readWorkerMutationOutcome(response, operation);
    } catch (error) {
      throw decorate(error);
    }
  }
  if (response.status === 304 && ifNoneMatch !== null) {
    return { status: 304, document: null, etag: response.headers.get('ETag'), response };
  }
  if (answersAsIs?.(response) === true) {
    return { status: response.status, document: null, etag: null, response, text };
  }
  if (!response.ok) {
    const error = new Error(workerErrorMessage(text, label, response.status));
    error.status = response.status;
    if (isLimitAnswer(response, text)) {
      error.rateLimited = true;
      error.retryAfterMs = namedWaitMsOf(ctx.transport, url.toString(), response);
    }
    decorate(error);
    if (operation !== null) throw attachMutationOutcome(error, operation, outcome);
    throw error;
  }
  let document;
  try {
    if (text === '') throw new Error('empty body');
    document = JSON.parse(text);
  } catch (cause) {
    const cut = new Error(
      `${label} answered HTTP ${response.status} with an incomplete or invalid JSON body; try again`
    );
    cut.code = WORKER_RESPONSE_CUT;
    cut.transient = true;
    cut.status = response.status;
    cut.cause = cause;
    decorate(cut);
    if (operation !== null) {
      throw decorate(createUnknownMutationOutcomeError(cut.message, operation, cut));
    }
    throw cut;
  }
  if (operation !== null) {
    try {
      attachMutationOutcomeToDocument(document, operation, outcome);
    } catch (error) {
      throw decorate(error);
    }
  }
  return { status: response.status, document, etag: response.headers.get('ETag'), response };
}

/** A GET through the GitHub proxy: its JSON document. */
async function githubGet(ctx, path, { query = null, signal = null } = {}) {
  return (await callWorker(ctx, { scope: 'api', path, query, signal })).document;
}

function repoPath(owner, repo, rest = '') {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${rest}`;
}

function contentPath(owner, repo, path) {
  const p = assertExactNonblankString(path, 'GitHub content path');
  if (p.startsWith('/') || p.split('/').some((segment) => !segment)) {
    throw new Error('GitHub content path must be a canonical relative path');
  }
  return repoPath(owner, repo, `/contents/${p.split('/').map(encodeURIComponent).join('/')}`);
}

function encodeGitRefPath(ref) {
  return assertGitHubBranch(ref, 'GitHub ref path').split('/').map((p) => encodeURIComponent(p)).join('/');
}

function isNotFoundError(err) {
  return err?.status === 404;
}

function layoutInvalid(message) {
  const error = new Error(message);
  error.code = 'COMMUNITY_ANNOTATION_REPOSITORY_LAYOUT_INVALID';
  return error;
}

function protocolError(message) {
  const error = new Error(message);
  error.code = 'GITHUB_WORKER_RESPONSE_INVALID';
  return error;
}

// -------------------------------------------------------------- GraphQL

/** A GraphQL answer's `{data, errors}`, checked for shape. */
function graphqlEnvelope(document, label) {
  if (!isPlainObject(document)) throw protocolError(`${label} must be a JSON object`);
  for (const key of Object.keys(document)) {
    if (key !== 'data' && key !== 'errors' && key !== 'extensions') {
      throw protocolError(`${label} has an unexpected member ${JSON.stringify(key)}`);
    }
  }
  const errors = document.errors === undefined ? [] : document.errors;
  if (!Array.isArray(errors) || errors.some((error) => !isPlainObject(error) || typeof error.message !== 'string')) {
    throw protocolError(`${label} errors must be an array of objects with a message`);
  }
  const data = document.data === undefined ? null : document.data;
  if (data !== null && !isPlainObject(data)) throw protocolError(`${label} data must be an object or null`);
  return { data, errors };
}

function graphqlFailure(errors, label) {
  const error = new Error(`${label} failed: ${errors.map((entry) => entry.message).join('; ')}`);
  error.graphqlErrors = errors.map((entry) => ({ type: typeof entry.type === 'string' ? entry.type : null, message: entry.message }));
  return error;
}

/**
 * One `/graphql/*` request. GitHub answers a spent GraphQL budget with HTTP
 * 200 and a `RATE_LIMITED` error; its headers tell the book of hosts the
 * budget's reset, which holds the next request until then, so it is asked
 * again (while the book holds the Worker; never in a loop of refusals).
 */
async function callGraphql(ctx, path, body, { signal = null, answersAsIs = null } = {}) {
  const label = `GitHub worker POST ${path}`;
  for (;;) {
    const result = await callWorker(ctx, { scope: 'service', path, method: 'POST', body, signal, answersAsIs });
    if (result.document === null) return { ...result, data: null, errors: [] };
    const { data, errors } = graphqlEnvelope(result.document, label);
    if (errors.some((error) => error.type === 'RATE_LIMITED')) {
      const url = workerUrl(ctx.workerOrigin, 'service', path, null).toString();
      if ((ctx.transport.hosts.heldForMs?.(url) ?? 0) > 0) continue;
      const limited = graphqlFailure(errors, label);
      limited.status = 403;
      limited.rateLimited = true;
      limited.retryAfterMs = null;
      limited.worker = { path, method: 'POST' };
      throw limited;
    }
    return { ...result, data, errors };
  }
}

/** The entries of a GraphQL tree object: `[{name, type, oid, byteSize}]` (`byteSize` null for a tree or submodule). */
function graphqlTreeEntries(object, label) {
  if (!isPlainObject(object) || !Array.isArray(object.entries)) {
    throw protocolError(`${label} must be a tree with entries`);
  }
  const seen = new Set();
  return object.entries.map((entry, index) => {
    const at = `${label} entry ${index}`;
    if (!isPlainObject(entry)) throw protocolError(`${at} must be an object`);
    if (typeof entry.name !== 'string' || entry.name === '' || entry.name.includes('/')) {
      throw protocolError(`${at} name must be one nonempty path segment`);
    }
    if (seen.has(entry.name)) throw protocolError(`${label} repeats ${JSON.stringify(entry.name)}`);
    seen.add(entry.name);
    if (entry.type !== 'blob' && entry.type !== 'tree' && entry.type !== 'commit') {
      throw protocolError(`${at} type must equal blob, tree, or commit`);
    }
    assertGitHubSha(entry.oid, `${at} oid`);
    let byteSize = null;
    if (entry.type === 'blob') {
      if (!isPlainObject(entry.object)) throw protocolError(`${at} blob must state its byteSize`);
      byteSize = assertSafeCount(entry.object.byteSize, `${at} byteSize`);
    }
    return { name: entry.name, type: entry.type, oid: entry.oid, byteSize };
  });
}

/** The entry of a GraphQL `file(path:)` lookup: `{oid, type, object}` or null. */
function graphqlFileEntry(value, label) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) throw protocolError(`${label} must be an object or null`);
  assertGitHubSha(value.oid, `${label} oid`);
  return value;
}

/**
 * Names under `annotations/` (and its moderation folder) that Cellucid reads,
 * by their exact lowercase spelling: an entry spelled otherwise (`Users`,
 * `Config.json`) is a case variant, ignored and listed (a case-insensitive
 * checkout would merge it with the real one).
 */
const ANNOTATION_NAMES = Object.freeze(['users', 'config.json', 'schema.json', 'config.schema.json', 'moderation']);
const MODERATION_NAMES = Object.freeze(['merges.json', 'merges.schema.json']);

function caseVariantsOf(entries, names, prefix) {
  return entries
    .filter((entry) => !names.includes(entry.name) && names.includes(entry.name.toLowerCase()))
    .map((entry) => ({
      path: `${prefix}${entry.name}`,
      reason: `a case variant of ${prefix}${entry.name.toLowerCase()}; Cellucid reads only the exact lowercase path`,
    }));
}

function requireSchemaBlob(entries, name, expectedOid, path) {
  const entry = entries.find((candidate) => candidate.name === name) ?? null;
  if (entry === null || entry.type !== 'blob') {
    throw layoutInvalid(
      `${path} is missing. Copy it from ${ANNOTATION_TEMPLATE_URL} (the annotation template), then Pull again.`
    );
  }
  if (entry.oid !== expectedOid) {
    throw layoutInvalid(
      `${path} is not the schema this Cellucid reads (Git blob ${entry.oid}, expected ${expectedOid}). ` +
      `Copy the current ${path} from ${ANNOTATION_TEMPLATE_URL}, then Pull again.`
    );
  }
}

/**
 * The repository at one commit, as a Pull reads it (module doc, steps 2–3).
 *
 * @typedef {{repoInfo: object, branch: string, commitOid: string, annotationsOid: string,
 *   usersOid: string, config: {oid: string, byteSize: number},
 *   merges: {oid: string, byteSize: number}|null, ignored: Array<{path: string, reason: string}>}} RepositorySnapshot
 */
function parseSnapshot(data, { owner, repo, branch, repoInfo }) {
  const where = `${owner}/${repo}@${branch}`;
  if (data === null || !isPlainObject(data)) throw protocolError('GitHub snapshot answered no data');
  const repository = data.repository;
  if (repository === null || repository === undefined) {
    const error = new Error(`GitHub repository ${owner}/${repo} is not accessible`);
    error.status = 404;
    throw error;
  }
  if (!isPlainObject(repository)) throw protocolError('GitHub snapshot repository must be an object');
  if (repository.ref === null || repository.ref === undefined) {
    throw layoutInvalid(`Branch "${branch}" does not exist in ${owner}/${repo}.`);
  }
  const target = repository.ref?.target;
  if (!isPlainObject(target)) throw protocolError('GitHub snapshot ref target must be an object');
  const commitOid = assertGitHubSha(target.oid, 'GitHub snapshot commit oid');
  const annotations = graphqlFileEntry(target.annotations, 'GitHub snapshot annotations');
  if (annotations === null || annotations.type !== 'tree') {
    throw layoutInvalid(
      `${where} has no annotations/ folder. Set the repository up from ${ANNOTATION_TEMPLATE_URL}, then Pull again.`
    );
  }
  const entries = graphqlTreeEntries(annotations.object, 'GitHub snapshot annotations/');
  const moderation = graphqlFileEntry(target.moderation, 'GitHub snapshot annotations/moderation');
  const moderationEntries = moderation !== null && moderation.type === 'tree'
    ? graphqlTreeEntries(moderation.object, 'GitHub snapshot annotations/moderation/')
    : [];

  requireSchemaBlob(entries, 'schema.json', ANNOTATION_SCHEMA_BLOB_OIDS.user, 'annotations/schema.json');
  requireSchemaBlob(entries, 'config.schema.json', ANNOTATION_SCHEMA_BLOB_OIDS.config, 'annotations/config.schema.json');
  requireSchemaBlob(
    moderationEntries,
    'merges.schema.json',
    ANNOTATION_SCHEMA_BLOB_OIDS.merges,
    'annotations/moderation/merges.schema.json'
  );
  const users = entries.find((entry) => entry.name === 'users') ?? null;
  if (users === null || users.type !== 'tree') {
    throw layoutInvalid(
      `${where} has no annotations/users/ folder. Set the repository up from ${ANNOTATION_TEMPLATE_URL}, then Pull again.`
    );
  }
  const config = entries.find((entry) => entry.name === 'config.json') ?? null;
  if (config === null || config.type !== 'blob') {
    throw layoutInvalid(
      `${where} has no annotations/config.json. Set the repository up from ${ANNOTATION_TEMPLATE_URL}, then Pull again.`
    );
  }
  const ignored = [
    ...caseVariantsOf(entries, ANNOTATION_NAMES, 'annotations/'),
    ...caseVariantsOf(moderationEntries, MODERATION_NAMES, 'annotations/moderation/'),
  ];
  const mergesEntry = moderationEntries.find((entry) => entry.name === 'merges.json') ?? null;
  let merges = null;
  if (mergesEntry !== null) {
    if (mergesEntry.type === 'blob') {
      merges = { oid: mergesEntry.oid, byteSize: mergesEntry.byteSize };
    } else {
      ignored.push({ path: ANNOTATION_MERGES_PATH, reason: `a ${mergesEntry.type === 'tree' ? 'folder' : 'submodule'}, not a file` });
    }
  }
  return Object.freeze({
    repoInfo,
    branch,
    commitOid,
    annotationsOid: annotations.oid,
    usersOid: users.oid,
    config: { oid: config.oid, byteSize: config.byteSize },
    merges,
    ignored,
  });
}

// ------------------------------------------------------- what the page keeps

/**
 * Repository metadata as last answered, by Worker origin and repository:
 * its ETag and body, so the next Pull asks `If-None-Match` and an unchanged
 * answer (`304`) costs no transfer. A `304` names the same body for whoever
 * asks (the ETag is the body's), so it is kept per repository, not per user.
 */
const repositoryMetadataByKey = new Map();
/** Validated config documents by blob id (content addressed). */
const configByOid = new Map();

function repositoryKey(workerOrigin, owner, repo) {
  return `${workerOrigin}|${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/** Read one blob through the REST blob route (a blob GitHub's GraphQL truncated): `{text, byteSize}`. */
async function readBlobRest(ctx, owner, repo, oid, path, { signal = null } = {}) {
  const document = await githubGet(ctx, repoPath(owner, repo, `/git/blobs/${oid}`), { signal });
  if (!isPlainObject(document) || document.sha !== oid || document.encoding !== 'base64' || typeof document.content !== 'string') {
    throw protocolError(`GitHub blob ${oid} (${path}) must answer its sha and base64 content`);
  }
  const byteSize = assertSafeCount(document.size, `GitHub blob ${oid} size`);
  const { decoded, decodedByteLength } = decodeBase64Utf8(document.content, path);
  if (decodedByteLength !== byteSize) throw protocolError(`GitHub blob ${oid} (${path}) content does not match its size`);
  return { text: decoded, byteSize };
}

/**
 * Read blobs by id, `/graphql/blobs` in one request: per oid in request
 * order `{oid, byteSize, isBinary, text}` (a blob whose text GitHub
 * truncated is read through the REST route), or `{resize: true}` when the
 * batch was refused for its size or time.
 */
async function readBlobBatch(ctx, owner, repo, items, { signal = null } = {}) {
  const label = 'GitHub worker POST /graphql/blobs';
  const result = await callGraphql(ctx, '/graphql/blobs', { owner, repo, oids: items.map((item) => item.oid) }, {
    signal,
    answersAsIs: (response) => BLOB_BATCH_RESIZE_STATUSES.has(response.status),
  });
  if (result.document === null && BLOB_BATCH_RESIZE_STATUSES.has(result.status)) return { resize: true };
  const { data, errors } = result;
  if (errors.length > 0) {
    const resize = errors.every((error) =>
      GRAPHQL_RESOURCE_ERRORS.has(error.type) || /\btim(?:e|ed)\s?out\b/i.test(error.message)
    );
    if (resize) return { resize: true };
    throw graphqlFailure(errors, label);
  }
  const repository = data?.repository;
  if (!isPlainObject(repository)) {
    const error = new Error(`GitHub repository ${owner}/${repo} is not accessible`);
    error.status = 404;
    throw error;
  }
  const blobs = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const blob = repository[`b${index}`];
    if (blob === null || blob === undefined) {
      throw protocolError(
        `GitHub did not answer blob ${item.oid} (${item.path}) of the commit this Pull reads; start a new Pull`
      );
    }
    if (!isPlainObject(blob) || blob.oid !== item.oid) {
      throw protocolError(`GitHub answered another object for blob ${item.oid} (${item.path})`);
    }
    const byteSize = assertSafeCount(blob.byteSize, `GitHub blob ${item.oid} byteSize`);
    if (typeof blob.isBinary !== 'boolean' || typeof blob.isTruncated !== 'boolean') {
      throw protocolError(`GitHub blob ${item.oid} must state isBinary and isTruncated`);
    }
    if (blob.isBinary) {
      blobs.push({ oid: item.oid, byteSize, isBinary: true, text: null });
    } else if (blob.isTruncated) {
      const rest = await readBlobRest(ctx, owner, repo, item.oid, item.path, { signal });
      blobs.push({ oid: item.oid, byteSize: rest.byteSize, isBinary: false, text: rest.text });
    } else {
      if (typeof blob.text !== 'string') throw protocolError(`GitHub blob ${item.oid} must state its text`);
      blobs.push({ oid: item.oid, byteSize, isBinary: false, text: blob.text });
    }
  }
  return { blobs };
}

/** Read one blob by id (batch of one, REST when a batch of one is refused). */
async function readOneBlob(ctx, owner, repo, item, { signal = null } = {}) {
  const outcome = await readBlobBatch(ctx, owner, repo, [item], { signal });
  if (outcome.resize) {
    const rest = await readBlobRest(ctx, owner, repo, item.oid, item.path, { signal });
    return { oid: item.oid, byteSize: rest.byteSize, isBinary: false, text: rest.text };
  }
  return outcome.blobs[0];
}

/**
 * What one file is, read: `{view}` its projection onto the open dataset, or
 * `{rejection: {code, message}}` why it is excluded. Never throws for the
 * file's content: a Pull never stops for one file.
 */
function verdictOf(path, blob, datasetId) {
  const reject = (code, message) => ({ rejection: { code, message } });
  if (blob.isBinary) {
    return reject('COMMUNITY_ANNOTATION_FILE_NOT_TEXT', `${path} is binary, not JSON text`);
  }
  if (utf8Encoder.encode(blob.text).length !== blob.byteSize) {
    return reject('COMMUNITY_ANNOTATION_FILE_NOT_TEXT', `${path} is not valid UTF-8 text`);
  }
  try {
    const json = parseExactJson(blob.text, { path });
    if (path === ANNOTATION_MERGES_PATH) return { view: projectMergesFile(json, datasetId, { path }) };
    return { view: projectUserFile(json, datasetId, { path, filename: path.slice('annotations/users/'.length) }) };
  } catch (error) {
    return reject(
      typeof error?.code === 'string' && error.code ? error.code : 'COMMUNITY_ANNOTATION_CONTRACT_INVALID',
      typeof error?.message === 'string' && error.message ? error.message : `${path} is not a valid annotation file`
    );
  }
}

/** A user-file path's entry in the users tree, or why the entry is ignored. */
function classifyUsersEntry(entry) {
  const path = `annotations/users/${entry.name}`;
  if (entry.name === '.gitkeep') return { skip: true };
  const match = USER_FILE_NAME.exec(entry.name);
  if (match === null || !Number.isSafeInteger(Number(match[1]))) {
    return { ignored: { path, reason: 'not a user file (annotations/users/ holds only ghid_<GitHub user id>.json)' } };
  }
  if (entry.type !== 'blob') {
    return { ignored: { path, reason: `a ${entry.type === 'tree' ? 'folder' : 'submodule'}, not a user file` } };
  }
  return { file: { path, sha: entry.sha, size: entry.size } };
}

/** The users tree, listed by its id: user files and ignored paths (module doc, step 4). */
async function listUsersTree(ctx, owner, repo, usersOid, { signal = null } = {}) {
  const document = await githubGet(ctx, repoPath(owner, repo, `/git/trees/${usersOid}`), { signal });
  if (!isPlainObject(document) || document.sha !== usersOid || !Array.isArray(document.tree)) {
    throw protocolError(`GitHub tree ${usersOid} must answer its sha and entries`);
  }
  if (typeof document.truncated !== 'boolean') throw protocolError('GitHub tree truncated must be boolean');
  if (document.truncated) {
    throw layoutInvalid(
      `GitHub truncated the listing of annotations/users/ (GitHub lists at most 100,000 entries or 7 MB of a tree: ` +
      'https://docs.github.com/en/rest/git/trees#get-a-tree), so this Pull cannot see every user file.'
    );
  }
  const files = [];
  const ignored = [];
  const seen = new Set();
  document.tree.forEach((raw, index) => {
    if (!isPlainObject(raw) || typeof raw.path !== 'string' || raw.path === '' || raw.path.includes('/')) {
      throw protocolError(`GitHub tree ${usersOid} entry ${index} must name one path segment`);
    }
    if (seen.has(raw.path)) throw protocolError(`GitHub tree ${usersOid} repeats ${JSON.stringify(raw.path)}`);
    seen.add(raw.path);
    if (raw.type !== 'blob' && raw.type !== 'tree' && raw.type !== 'commit') {
      throw protocolError(`GitHub tree ${usersOid} entry ${index} type must equal blob, tree, or commit`);
    }
    const sha = assertGitHubSha(raw.sha, `GitHub tree ${usersOid} entry ${index} sha`);
    const size = raw.type === 'blob' ? assertSafeCount(raw.size, `GitHub tree ${usersOid} entry ${index} size`) : null;
    const verdict = classifyUsersEntry({ name: raw.path, type: raw.type, sha, size });
    if (verdict.file) files.push(verdict.file);
    else if (verdict.ignored) ignored.push(verdict.ignored);
  });
  return { files, ignored };
}

/** Code-unit order (never locale-dependent). */
function byCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ---------------------------------------------------- publication (Contents)

function assertContentFileRecord(content, path) {
  if (!isPlainObject(content) || content.type !== 'file') throw new Error(`Expected file at ${path}`);
  if (content.encoding !== 'base64') {
    throw new Error(`GitHub file ${JSON.stringify(path)} must use base64 encoding`);
  }
  const sha = assertGitHubSha(content.sha, `GitHub file ${JSON.stringify(path)} SHA`);
  scanFoldedBase64Payload(content.content, { path });
  return { contentBase64: content.content, sha };
}

/** A file at a branch through the Contents API (publication reads it for its SHA): `{json, sha, contentBase64}`, or null. */
async function readContentFile(ctx, owner, repo, path, ref, { signal = null } = {}) {
  let content;
  try {
    content = await githubGet(ctx, contentPath(owner, repo, path), {
      query: { ref: assertGitHubBranch(ref, 'GitHub content ref') },
      signal,
    });
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  const file = assertContentFileRecord(content, path);
  const { decoded } = decodeBase64Utf8(file.contentBase64, path);
  return { json: parseExactJson(decoded, { path }), sha: file.sha, contentBase64: file.contentBase64 };
}

function conflictError(path, message, cause = undefined) {
  const error = new Error(message);
  error.code = 'COMMUNITY_ANNOTATION_CONFLICT';
  error.path = path;
  if (cause !== undefined) inheritMutationErrorContext(error, cause);
  return error;
}

/**
 * Write one file with the Contents API, `sha` naming the version it
 * replaces (null: a new file). A write GitHub refuses because the file
 * changed meanwhile -- `409`, or `422` when it was created after it was read
 * as missing (another device publishing at the same moment) -- or whose
 * outcome is unknown, is settled by reading the file again: the bytes this
 * write sent are success; any other version than `sha` is
 * `COMMUNITY_ANNOTATION_CONFLICT`.
 */
async function putContent(ctx, { owner, repo, path, branch, message, contentBase64, sha = null, signal = null }) {
  if (assertOptionalToken(ctx.token) === null) throw new Error('GitHub token required to publish');
  const exactMessage = assertExactNonblankString(message, 'GitHub commit message');
  if (typeof contentBase64 !== 'string' || !contentBase64 || /^\s|\s$/.test(contentBase64)) {
    throw new Error('GitHub base64 content must be an exact nonblank string');
  }
  if (scanFoldedBase64Payload(contentBase64, { path, phase: 'publication-preflight' }).hasFolding) {
    throw new Error('GitHub base64 content must be canonical and unfolded');
  }
  const payload = { message: exactMessage, content: contentBase64, branch: assertGitHubBranch(branch) };
  if (sha !== null) payload.sha = assertGitHubSha(sha, 'Existing content SHA');
  let response = null;
  try {
    response = (await callWorker(ctx, {
      scope: 'api',
      path: contentPath(owner, repo, path),
      method: 'PUT',
      body: payload,
      signal,
    })).document;
    assertGitHubSha(response?.content?.sha, 'Published GitHub content SHA');
    return response;
  } catch (caughtError) {
    const error = attachDocumentMutationOutcome(caughtError, response);
    if (!shouldReconcileMutation(error, 'contents-put') || signal?.aborted === true) throw error;
    let remote;
    try {
      remote = await readContentFile(ctx, owner, repo, path, payload.branch, { signal });
    } catch {
      // The original outcome stands when the file cannot be read again.
      throw error;
    }
    if (remote !== null && base64PayloadEqualsCanonical(remote.contentBase64, contentBase64, path)) {
      return { content: { sha: remote.sha } };
    }
    if ((remote?.sha ?? null) !== sha) {
      throw conflictError(
        path,
        `${path} changed on GitHub while publishing.\nPull first to merge the latest version, then Publish again.`,
        error
      );
    }
    throw error;
  }
}

// ------------------------------------------------------------------ fork

function assertForkRecord(value, index) {
  if (!isPlainObject(value)) throw new Error(`GitHub fork ${index} must be an object`);
  const fullName = assertGitHubRepositoryFullName(value.full_name, `GitHub fork ${index} full_name`);
  if (!isPlainObject(value.owner)) throw new Error(`GitHub fork ${index} owner must be an object`);
  const owner = assertGitHubLogin(value.owner.login, `GitHub fork ${index} owner login`);
  const name = assertExactNonblankString(value.name, `GitHub fork ${index} name`);
  if (!isCanonicalGitHubRepositoryName(name)) throw new Error(`GitHub fork ${index} name is not canonical`);
  if (fullName.toLowerCase() !== `${owner}/${name}`.toLowerCase()) {
    throw new Error(`GitHub fork ${index} identity fields disagree`);
  }
  return { owner, name, fullName };
}

function assertForkRepositoryIdentity(value) {
  requireExactObjectKeys(value, ['full_name', 'fork', 'parent'], 'GitHub fork identity');
  const fullName = assertGitHubRepositoryFullName(value.full_name, 'GitHub fork identity full_name');
  if (typeof value.fork !== 'boolean') throw new Error('GitHub fork identity fork must be boolean');
  if (value.fork === false) {
    if (value.parent !== null) throw new Error('GitHub non-fork identity parent must equal exact null');
    return { fork: false, fullName, parentFullName: null };
  }
  requireExactObjectKeys(value.parent, ['full_name'], 'GitHub fork identity parent');
  return {
    fork: true,
    fullName,
    parentFullName: assertGitHubRepositoryFullName(value.parent.full_name, 'GitHub fork identity parent full_name'),
  };
}

function createForkNameConflictError({ forkOwner, upstreamFullName, canonicalFullName }) {
  const error = new Error(
    `GitHub repository ${canonicalFullName} exists, but it is not a fork of ` +
    `${upstreamFullName}. Rename that repository or rename the existing ` +
    `${forkOwner} fork to the upstream repository name, then publish again.`
  );
  error.code = 'GITHUB_FORK_NAME_CONFLICT';
  return error;
}

/** `{login}/{upstream name}`: the caller's fork (`{collision: false, name}`), another repository (`{collision: true}`), or null. */
async function probeCanonicalOwnedFork(ctx, { upstreamRepo, upstreamFullName, forkOwner, signal = null }) {
  const expectedFullName = `${forkOwner}/${upstreamRepo}`;
  let identity;
  try {
    identity = assertForkRepositoryIdentity(await githubGet(ctx, repoPath(forkOwner, upstreamRepo), {
      query: { fork_identity: 1 },
      signal,
    }));
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  const separator = identity.fullName.indexOf('/');
  const actualOwner = identity.fullName.slice(0, separator);
  const actualName = identity.fullName.slice(separator + 1);
  if (
    actualOwner.toLowerCase() === forkOwner.toLowerCase() &&
    identity.fork &&
    identity.parentFullName.toLowerCase() === upstreamFullName.toLowerCase()
  ) {
    return { collision: false, name: actualName };
  }
  return {
    collision: true,
    canonicalFullName: actualOwner.toLowerCase() === forkOwner.toLowerCase() ? identity.fullName : expectedFullName,
  };
}

/**
 * The caller's fork under another name (renamed): the upstream's forks,
 * newest first, a page of 100 at a time until GitHub has no more (a page
 * shorter than 100), each request under the transport's stall timeout.
 */
async function findOwnedForkRepo(ctx, { upstreamOwner, upstreamRepo, forkOwner, signal = null }) {
  const seen = new Set();
  for (let page = 1; ; page += 1) {
    const document = await githubGet(ctx, repoPath(upstreamOwner, upstreamRepo, '/forks'), {
      query: { sort: 'newest', per_page: 100, page },
      signal,
    });
    if (!Array.isArray(document)) throw new Error('GitHub forks response must be an array');
    if (document.length > 100) throw new Error('GitHub forks response page exceeds the 100 entries asked for');
    let matchingName = null;
    document.forEach((raw, index) => {
      const fork = assertForkRecord(raw, (page - 1) * 100 + index);
      const key = fork.fullName.toLowerCase();
      if (seen.has(key)) throw new Error(`GitHub forks response repeats ${fork.fullName}`);
      seen.add(key);
      if (fork.owner.toLowerCase() === forkOwner.toLowerCase()) {
        if (matchingName !== null) throw new Error(`GitHub returned multiple forks owned by ${forkOwner}`);
        matchingName = fork.name;
      }
    });
    if (matchingName !== null) return matchingName;
    if (document.length < 100) return null;
  }
}

/**
 * The repository a contributor publishes from: their fork of the source, as
 * the source's name under their account, else (renamed) among the source's
 * forks. Cellucid never creates one (that needs the GitHub App's
 * Administration permission, which it does not ask for): without a fork,
 * Publish stops and says where to make it.
 */
async function findForkRepo(ctx, { upstreamOwner, upstreamRepo, upstreamFullName, forkOwner, signal = null }) {
  const lookup = { upstreamOwner, upstreamRepo, upstreamFullName, forkOwner, signal };
  const canonical = await probeCanonicalOwnedFork(ctx, lookup);
  if (canonical !== null && !canonical.collision) return canonical.name;
  const renamed = await findOwnedForkRepo(ctx, lookup);
  if (renamed !== null) return renamed;
  if (canonical?.collision) {
    throw createForkNameConflictError({ forkOwner, upstreamFullName, canonicalFullName: canonical.canonicalFullName });
  }
  throw forkMissingError(upstreamFullName);
}

/**
 * A contributor's user token writes to their fork only when Cellucid's GitHub
 * App is installed on their account with access to that fork: a user token
 * reaches only "resources in an account where it [the app] is installed"
 * (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user),
 * and an installation reaches all repositories or the ones selected.
 */
const FORK_INSTALLATION_SENTENCE =
  "Cellucid's GitHub App must be installed on your GitHub account with access to your fork " +
  '(All repositories, or Only select repositories with the fork selected).';

function forkMissingError(upstreamFullName) {
  const forkUrl = `https://github.com/${upstreamFullName}/fork`;
  const error = new Error(
    `You have no fork of ${upstreamFullName} yet: fork it on GitHub, then Publish again.\n` +
    `Fork it at ${forkUrl}. ${FORK_INSTALLATION_SENTENCE}`
  );
  error.code = 'GITHUB_FORK_MISSING';
  error.forkUrl = forkUrl;
  return error;
}

function forkNotWritableError(forkFullName, cause) {
  const error = new Error(
    `Cellucid cannot write to your fork ${forkFullName}: install Cellucid's GitHub App on your account ` +
    'with access to it, then Publish again.\n' +
    `${FORK_INSTALLATION_SENTENCE}\nGitHub said: ${cause?.message ?? cause}`
  );
  error.code = 'GITHUB_FORK_NOT_WRITABLE';
  error.cause = cause;
  return error;
}

function requireBranchTipSha(document, label) {
  if (!isPlainObject(document) || !isPlainObject(document.object)) {
    throw new Error(`${label} must contain an object SHA`);
  }
  return assertGitHubSha(document.object.sha, `${label} object SHA`);
}

/** The commit a branch points at, or null when it does not exist. */
async function getBranchTipSha(ctx, owner, repo, branch, { signal = null } = {}) {
  try {
    return requireBranchTipSha(
      await githubGet(ctx, repoPath(owner, repo, `/git/ref/heads/${encodeGitRefPath(branch)}`), { signal }),
      'GitHub branch response'
    );
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

/**
 * GitHub copies a new fork asynchronously; until it has, the fork's Git
 * objects cannot be read (https://docs.github.com/en/rest/repos/forks#create-a-fork).
 * A copied fork has the source's base branch, or (forked with its default
 * branch only) at least the source's default branch; with neither, Publish
 * stops and asks to try again rather than waiting a fixed time.
 */
async function assertForkCopied(ctx, { owner, repo, baseBranch, defaultBranch, signal = null }) {
  if ((await getBranchTipSha(ctx, owner, repo, baseBranch, { signal })) !== null) return;
  if (defaultBranch !== baseBranch && (await getBranchTipSha(ctx, owner, repo, defaultBranch, { signal })) !== null) return;
  const error = new Error(`GitHub is still copying your fork ${owner}/${repo}; Publish again in a minute.`);
  error.code = 'GITHUB_FORK_NOT_READY';
  throw error;
}

function fnv1aHash32(input) {
  const str = assertExactNonblankString(input, 'Hash input');
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The one head branch of a contributor's pull requests against one base
 * branch: `cellucid-annotations/ghid_<id>/<fnv(base)>`. One user file holds
 * every dataset of the contributor, so every dataset they publish goes into
 * the same pull request.
 */
export function toAnnotationHeadBranch({ baseBranch, fileUser }) {
  const base = assertGitHubBranch(baseBranch, 'Pull-request base branch');
  if (typeof fileUser !== 'string' || !/^ghid_[1-9][0-9]*$/.test(fileUser) || !Number.isSafeInteger(Number(fileUser.slice(5)))) {
    throw new Error('Pull-request file user must be an exact ghid identity');
  }
  return `cellucid-annotations/${fileUser}/${fnv1aHash32(base).toString(36)}`;
}

function assertPullRequestRecord(value, label) {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.number) || value.number < 1) {
    throw new Error(`${label} has an invalid number`);
  }
  const htmlUrl = assertExactNonblankString(value.html_url, `${label} html_url`);
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
  return { number: value.number, html_url: htmlUrl };
}

async function findOpenPullRequest(ctx, { upstreamOwner, upstreamRepo, baseBranch, headOwner, headBranch, signal = null }) {
  const existing = await githubGet(ctx, repoPath(upstreamOwner, upstreamRepo, '/pulls'), {
    query: { state: 'open', head: `${headOwner}:${headBranch}`, base: baseBranch, per_page: 100 },
    signal,
  });
  if (!Array.isArray(existing)) throw new Error('GitHub Pull Request lookup must return an array');
  if (existing.length > 1) throw new Error('GitHub returned multiple open Pull Requests for one head');
  return existing.length === 0 ? null : assertPullRequestRecord(existing[0], 'Existing GitHub Pull Request');
}

async function createPullRequest(ctx, { upstreamOwner, upstreamRepo, baseBranch, headOwner, headBranch, title, body, signal = null }) {
  let created = null;
  try {
    created = (await callWorker(ctx, {
      scope: 'api',
      path: repoPath(upstreamOwner, upstreamRepo, '/pulls'),
      method: 'POST',
      body: {
        title: assertExactNonblankString(title, 'Pull Request title'),
        head: `${headOwner}:${headBranch}`,
        base: baseBranch,
        body: assertExactNonblankString(body, 'Pull Request body'),
        maintainer_can_modify: true,
      },
      signal,
    })).document;
    return { pr: assertPullRequestRecord(created, 'Created GitHub Pull Request'), reused: false };
  } catch (caughtError) {
    const error = attachDocumentMutationOutcome(caughtError, created);
    if (!shouldReconcileMutation(error, 'pulls-post') || signal?.aborted === true) throw error;
    let reconciled = null;
    try {
      reconciled = await findOpenPullRequest(ctx, { upstreamOwner, upstreamRepo, baseBranch, headOwner, headBranch, signal });
    } catch {
      // Never create a second pull request when the first one's outcome cannot be read.
    }
    if (reconciled !== null) return { pr: reconciled, reused: true };
    throw error;
  }
}

/**
 * Point the contributor's head branch at `sha` (the upstream tip): created
 * when missing, else moved with a forced update (the Worker allows that only
 * on the caller's own `cellucid-annotations/ghid_<id>/` branch of the
 * caller's own fork). A write whose outcome is unknown, or refused because
 * the branch appeared or moved meanwhile, is settled by reading it again.
 */
async function resetHeadBranch(ctx, { owner, repo, branch, sha, signal = null }) {
  const current = await getBranchTipSha(ctx, owner, repo, branch, { signal });
  if (current === sha) return;
  const kind = current === null ? 'git-refs-post' : 'git-ref-patch';
  try {
    await callWorker(ctx, current === null
      ? { scope: 'api', path: repoPath(owner, repo, '/git/refs'), method: 'POST', body: { ref: `refs/heads/${branch}`, sha }, signal }
      : {
          scope: 'api',
          path: repoPath(owner, repo, `/git/refs/heads/${encodeGitRefPath(branch)}`),
          method: 'PATCH',
          body: { sha, force: true },
          signal,
        });
  } catch (error) {
    if (!shouldReconcileMutation(error, kind) || signal?.aborted === true) throw error;
    let now = null;
    try {
      now = await getBranchTipSha(ctx, owner, repo, branch, { signal });
    } catch {
      throw error;
    }
    if (now === sha) return;
    // Created by another of the contributor's devices meanwhile: moved now.
    if (current === null && now !== null) {
      await resetHeadBranch(ctx, { owner, repo, branch, sha, signal });
      return;
    }
    throw error;
  }
}

function userFileOf(userDoc) {
  const id = userDoc?.githubUserId;
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('User doc githubUserId must be a positive safe integer');
  const fileUser = `ghid_${id}`;
  return { id, fileUser, path: `annotations/users/${fileUser}.json`, filename: `${fileUser}.json` };
}

/**
 * The contributor's own published file, which a Publish composes onto. One
 * that does not meet the contract is never overwritten silently: the
 * Publish stops and says so.
 */
function assertOwnPublishedFile(json, path, filename, where) {
  try {
    return assertUserFile(json, { path, filename });
  } catch (cause) {
    const error = new Error(
      `Your published file ${path}${where} is not a valid annotation file (${cause?.message ?? cause}). ` +
      'Cellucid will not overwrite it: fix or remove it on GitHub, then Pull and Publish again.'
    );
    error.code = 'COMMUNITY_ANNOTATION_OWN_FILE_INVALID';
    error.path = path;
    error.cause = cause;
    throw error;
  }
}

/**
 * Publish a contributor's file through a pull request from their fork
 * (design: one head branch per contributor and base branch):
 *
 * 1. The file to compose onto is the open pull request's head file (it
 *    carries the sections of other datasets not merged yet), else the
 *    upstream tip's file.
 * 2. Unchanged against what the pull request (or, without one, upstream)
 *    already holds: nothing is written.
 * 3. The head branch is reset to the upstream tip (created, or moved with a
 *    forced update) and the composed file is written on it, so the pull
 *    request's diff is the user file alone and a squash-merged earlier pull
 *    request never makes it conflict.
 * 4. The open pull request is reused, else one is opened.
 */
async function publishUserFileViaFork(ctx, {
  repoInfo,
  source,
  baseBranch,
  datasetId,
  file,
  viewOver,
  upstream,
  authUser,
  title,
  body,
  signal = null,
}) {
  const capability = assertRepositoryPublicationInfo(repoInfo);
  if (!capability.allowForking) throw new Error('Fork Pull Request publication is disabled for this repository');
  const { fileUser, path, filename } = file;
  if (`ghid_${authUser.id}` !== fileUser) {
    throw new Error(`Pull Request file identity must equal authenticated user ghid_${authUser.id}`);
  }
  const upstreamFullName = repoInfo.full_name;
  const fork = {
    name: await findForkRepo(ctx, {
      upstreamOwner: source.owner,
      upstreamRepo: source.repo,
      upstreamFullName,
      forkOwner: authUser.login,
      signal,
    }),
  };
  await assertForkCopied(ctx, {
    owner: authUser.login,
    repo: fork.name,
    baseBranch,
    defaultBranch: repoInfo.default_branch,
    signal,
  });
  const headBranch = toAnnotationHeadBranch({ baseBranch, fileUser });
  const pull = { upstreamOwner: source.owner, upstreamRepo: source.repo, baseBranch, headOwner: authUser.login, headBranch, signal };
  const openPr = await findOpenPullRequest(ctx, pull);

  const headFile = openPr === null
    ? null
    : await readContentFile(ctx, authUser.login, fork.name, path, headBranch, { signal });
  const base = headFile ?? upstream;
  const prior = base === null
    ? null
    : assertOwnPublishedFile(base.json, path, filename, headFile !== null ? ` (pull request #${openPr.number})` : '');
  // A composed change goes on top of the file the pull request already
  // proposes (its other unmerged changes stay in it), else on top of upstream.
  const view = viewOver(prior);
  const contentBase64 = encodeBase64Bytes(
    toAnnotationPublicationBytes(composeUserFile(prior, datasetId, view, { path, filename }), { path })
  );
  if (base !== null && base64PayloadEqualsCanonical(base.contentBase64, contentBase64, path)) {
    if (openPr !== null) {
      return { mode: 'fork-pull-request', prUrl: openPr.html_url, prNumber: openPr.number, reused: true, changed: false, view };
    }
    return { mode: 'none', sha: upstream.sha, changed: false, view };
  }

  const upstreamTip = await getBranchTipSha(ctx, source.owner, source.repo, baseBranch, { signal });
  if (upstreamTip === null) throw layoutInvalid(`Branch "${baseBranch}" does not exist in ${upstreamFullName}.`);
  try {
    await resetHeadBranch(ctx, { owner: authUser.login, repo: fork.name, branch: headBranch, sha: upstreamTip, signal });
    // The file at the upstream tip, which the write replaces (read again: the
    // tip may be newer than the file read above).
    const atTip = await readContentFile(ctx, authUser.login, fork.name, path, headBranch, { signal });
    await putContent(ctx, {
      owner: authUser.login,
      repo: fork.name,
      path,
      branch: headBranch,
      message: title,
      contentBase64,
      sha: atTip?.sha ?? null,
      signal,
    });
  } catch (error) {
    // GitHub refuses a user token's write to a repository its app is not
    // installed on (403 "Resource not accessible by integration", or 404).
    if ((error?.status === 403 && error?.rateLimited !== true) || error?.status === 404) {
      throw forkNotWritableError(`${authUser.login}/${fork.name}`, error);
    }
    throw error;
  }
  const { pr, reused } = openPr !== null
    ? { pr: openPr, reused: true }
    : await createPullRequest(ctx, { ...pull, title, body });
  return { mode: 'fork-pull-request', prUrl: pr.html_url, prNumber: pr.number, reused, changed: true, view };
}

export class CommunityAnnotationGitHubSync {
  /**
   * @param {{datasetId: string, owner: string, repo: string, token?: string|null, branch?: string|null,
   *   workerOrigin?: string|null, transport?: object|null, onWait?: ((wait: object|null) => void)|null}} options
   *   `transport`: what requests go through (`worker-request.js`; the page's
   *   by default, tests give a virtual clock); `onWait`: told when a request
   *   waits for a wait the host named (a rate limit's reset), and null after
   */
  constructor({ datasetId, owner, repo, token = null, branch = null, workerOrigin = null, transport = null, onWait = null } = {}) {
    this.datasetId = assertExactNonblankString(datasetId, 'Annotation sync datasetId');
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
    this.workerOrigin = assertExactHttpOrigin(
      workerOrigin === null ? getGitHubWorkerOrigin() : workerOrigin,
      'GitHub worker origin'
    );
    this.transport = transport === null ? defaultWorkerTransport(this.workerOrigin) : assertWorkerTransport(transport);
    if (onWait !== null && typeof onWait !== 'function') throw new TypeError('Annotation sync onWait must be a function or null');
    this.onWait = onWait;
    /** @type {RepositorySnapshot|null} */
    this._snapshot = null;
  }

  get ownerRepo() {
    return `${this.owner}/${this.repo}`;
  }

  _ctx() {
    if (!this.token) throw new Error('GitHub sign-in required');
    return { workerOrigin: this.workerOrigin, token: this.token, transport: this.transport, onWait: this.onWait };
  }

  /** Repository metadata, asked with the last ETag of this repository (module doc, step 1). */
  async _repositoryMetadata(signal) {
    const key = repositoryKey(this.workerOrigin, this.owner, this.repo);
    const known = repositoryMetadataByKey.get(key) ?? null;
    const result = await callWorker(this._ctx(), {
      scope: 'api',
      path: repoPath(this.owner, this.repo),
      ifNoneMatch: known?.etag ?? null,
      signal,
    });
    const repoInfo = result.status === 304 ? known.repoInfo : result.document;
    assertRepositoryPublicationInfo(repoInfo);
    if (result.status !== 304) {
      if (typeof result.etag === 'string' && result.etag !== '') {
        repositoryMetadataByKey.set(key, { etag: result.etag, repoInfo });
      } else {
        repositoryMetadataByKey.delete(key);
      }
    }
    return repoInfo;
  }

  /** The repository resolved from its metadata: `{owner, repo}` as GitHub names it now (renames followed). */
  _source(repoInfo) {
    const source = parseCanonicalGitHubRepositoryReference(repoInfo.full_name);
    if (source === null || source.ref !== null) {
      throw new Error('GitHub repository metadata did not resolve an exact source repository');
    }
    return source;
  }

  /**
   * The repository at the branch's current commit (module doc, steps 1–3):
   * metadata, the snapshot, the schemas checked by blob id.
   *
   * @returns {Promise<RepositorySnapshot>}
   */
  async openSnapshot({ signal = null } = {}) {
    const requestSignal = assertAbortSignalOrNull(signal, 'Annotation snapshot signal');
    const repoInfo = await this._repositoryMetadata(requestSignal);
    const branch = this.branch === null
      ? assertGitHubBranch(repoInfo.default_branch, 'GitHub repository default_branch')
      : this.branch;
    this.branch = branch;
    const source = this._source(repoInfo);
    const { data, errors } = await callGraphql(this._ctx(), '/graphql/snapshot', {
      owner: source.owner,
      repo: source.repo,
      branch,
    }, { signal: requestSignal });
    if (errors.length > 0 && (data === null || data.repository === undefined)) {
      throw graphqlFailure(errors, 'GitHub snapshot');
    }
    this._snapshot = parseSnapshot(data, { owner: source.owner, repo: source.repo, branch, repoInfo });
    return this._snapshot;
  }

  /** The config of a snapshot, read by its blob id (kept for the page by id). */
  async _readConfig(snapshot, signal) {
    const { oid, byteSize } = snapshot.config;
    const known = configByOid.get(oid);
    if (known !== undefined) return known;
    if (byteSize > ANNOTATION_FILE_MAX_UTF8_BYTES) {
      throw new AnnotationFileTooLargeError(ANNOTATION_CONFIG_PATH, byteSize, { phase: 'remote-tree-preflight' });
    }
    const source = this._source(snapshot.repoInfo);
    const blob = await readOneBlob(this._ctx(), source.owner, source.repo, { oid, path: ANNOTATION_CONFIG_PATH }, { signal });
    if (blob.isBinary || utf8Encoder.encode(blob.text).length !== blob.byteSize) {
      throw layoutInvalid(`${ANNOTATION_CONFIG_PATH} is not UTF-8 JSON text`);
    }
    const config = parseExactJson(blob.text, { path: ANNOTATION_CONFIG_PATH });
    assertConfigDocument(config, { path: ANNOTATION_CONFIG_PATH });
    configByOid.set(oid, config);
    return config;
  }

  /**
   * Open the repository and read its config: `{repoInfo, branch, config,
   * configSha, datasetId, datasetConfig, snapshot}`. `configSha` is the
   * config's blob id, which is the SHA the Contents API names it by.
   */
  async validateAndLoadConfig({ datasetId, signal = null } = {}) {
    const requestSignal = assertAbortSignalOrNull(signal, 'Annotation config request signal');
    const snapshot = await this.openSnapshot({ signal: requestSignal });
    const config = await this._readConfig(snapshot, requestSignal);
    const targetDatasetId = datasetId === undefined
      ? this.datasetId
      : assertExactNonblankString(datasetId, 'Annotation config datasetId');
    const datasetConfig = config.supportedDatasets.find((entry) => entry.datasetId === targetDatasetId) ?? null;
    return {
      repoInfo: snapshot.repoInfo,
      branch: snapshot.branch,
      config,
      configSha: snapshot.config.oid,
      datasetId: targetDatasetId,
      datasetConfig,
      snapshot,
    };
  }

  /**
   * Read every changed file of a snapshot into the file cache (module doc,
   * steps 2 and 4–7). Answers what the cache now holds of it:
   * `{unchanged, userCount, fetchedCount, ignored, ownSha, mergesSha}` --
   * `unchanged` when the `annotations` tree is the last completed Pull's
   * (nothing was read); `ignored` the paths that are no annotation file,
   * with why; `ownSha` the blob id of the caller's own user file (null when
   * they have none). Excluded files are in the cache, with their reasons.
   *
   * @param {{snapshot: RepositorySnapshot, fileCache: import('./file-cache.js').CommunityAnnotationFileCache,
   *   cacheScope: {datasetId: string, repoRef: string, userId: number}, ownUserKey?: string|null,
   *   signal?: AbortSignal|null, onProgress?: ((progress: {done: number, total: number}) => void)|null}} options
   */
  async pullFiles({ snapshot, fileCache, cacheScope, ownUserKey = null, signal = null, onProgress = null } = {}) {
    const requestSignal = assertAbortSignalOrNull(signal, 'Annotation files pull signal');
    if (snapshot === null || typeof snapshot !== 'object' || !GIT_OID.test(snapshot.annotationsOid ?? '')) {
      throw new TypeError('Annotation files pull requires a repository snapshot');
    }
    if (ownUserKey !== null && !/^ghid_[1-9][0-9]*$/.test(ownUserKey)) {
      throw new Error('Annotation files pull own user key must be an exact ghid identity');
    }
    const ownPath = ownUserKey === null ? null : `annotations/users/${ownUserKey}.json`;
    const mergesSha = snapshot.merges?.oid ?? null;
    const marker = await fileCache.getPullMarker(cacheScope);
    if (marker !== null && marker.annotationsOid === snapshot.annotationsOid) {
      const own = ownPath === null ? null : await fileCache.getRecord(cacheScope, ownPath);
      return {
        unchanged: true,
        userCount: null,
        fetchedCount: 0,
        ignored: [...snapshot.ignored, ...marker.ignored],
        ownSha: own?.sha ?? null,
        mergesSha,
      };
    }

    // From here records change: the marker no longer describes them.
    await fileCache.deletePullMarker(cacheScope, { signal: requestSignal });
    const ctx = this._ctx();
    const source = this._source(snapshot.repoInfo);
    const known = await fileCache.getKnownShas(cacheScope);
    let files;
    let usersIgnored;
    if (marker !== null && marker.usersOid === snapshot.usersOid) {
      // The last completed Pull listed this very tree, and the cache holds
      // exactly its files.
      files = [...known].filter(([path]) => path !== ANNOTATION_MERGES_PATH).map(([path, sha]) => ({ path, sha, size: null }));
      usersIgnored = marker.ignored;
    } else {
      ({ files, ignored: usersIgnored } = await listUsersTree(ctx, source.owner, source.repo, snapshot.usersOid, { signal: requestSignal }));
    }

    const tooLarge = [];
    const pending = [];
    const consider = (path, oid, size) => {
      if (known.get(path) === oid) return;
      if (size > ANNOTATION_FILE_MAX_UTF8_BYTES) {
        tooLarge.push({
          path,
          sha: oid,
          rejection: {
            code: 'COMMUNITY_ANNOTATION_FILE_TOO_LARGE',
            message: new AnnotationFileTooLargeError(path, size, { phase: 'remote-tree-preflight' }).message,
          },
        });
      } else {
        pending.push({ path, oid, size });
      }
    };
    for (const file of files) consider(file.path, file.sha, file.size);
    if (snapshot.merges !== null) consider(ANNOTATION_MERGES_PATH, snapshot.merges.oid, snapshot.merges.byteSize);
    if (tooLarge.length > 0) await fileCache.putRecords(cacheScope, tooLarge, { signal: requestSignal });
    pending.sort((left, right) => byCodeUnits(left.path, right.path));

    const total = pending.length;
    let done = 0;
    onProgress?.({ done, total });
    let budget = BLOB_BATCH_START_BYTES;
    // The smallest batch refused for its size in this Pull: batches grow up
    // to just under it, so one refusal is not met again and again.
    let refusedAt = Infinity;
    for (let start = 0; start < pending.length;) {
      let end = start;
      let cost = 0;
      do {
        cost += pending[end].size + BLOB_RECORD_OVERHEAD_BYTES;
        end += 1;
      } while (end < pending.length && cost + pending[end].size + BLOB_RECORD_OVERHEAD_BYTES <= budget);
      const batch = pending.slice(start, end);
      let blobs;
      const outcome = await readBlobBatch(ctx, source.owner, source.repo, batch, { signal: requestSignal });
      if (outcome.resize) {
        refusedAt = Math.min(refusedAt, cost);
        if (batch.length > 1) {
          budget = Math.max(1, Math.floor(cost / 2));
          continue;
        }
        const rest = await readBlobRest(ctx, source.owner, source.repo, batch[0].oid, batch[0].path, { signal: requestSignal });
        blobs = [{ oid: batch[0].oid, byteSize: rest.byteSize, isBinary: false, text: rest.text }];
      } else {
        blobs = outcome.blobs;
        budget = Math.max(budget, Math.min(budget * 2, refusedAt - 1));
      }
      const records = batch.map((item, index) => {
        if (blobs[index].byteSize !== item.size) {
          throw protocolError(`GitHub blob ${item.oid} (${item.path}) does not have the size its tree states`);
        }
        return { path: item.path, sha: item.oid, ...verdictOf(item.path, blobs[index], this.datasetId) };
      });
      await fileCache.putRecords(cacheScope, records, { signal: requestSignal });
      done += batch.length;
      onProgress?.({ done, total });
      start = end;
    }

    const keep = new Set(files.map((file) => file.path));
    if (snapshot.merges !== null) keep.add(ANNOTATION_MERGES_PATH);
    await fileCache.pruneToPaths(cacheScope, keep, { signal: requestSignal });
    await fileCache.setPullMarker(cacheScope, {
      commitOid: snapshot.commitOid,
      annotationsOid: snapshot.annotationsOid,
      usersOid: snapshot.usersOid,
      ignored: usersIgnored,
    }, { signal: requestSignal });
    return {
      unchanged: false,
      userCount: files.length,
      fetchedCount: total + tooLarge.length,
      ignored: [...snapshot.ignored, ...usersIgnored],
      ownSha: ownPath === null ? null : files.find((file) => file.path === ownPath)?.sha ?? null,
      mergesSha,
    };
  }

  /** Metadata and branch of this sync's repository: from the snapshot already opened, else opened now. */
  async _resolved(signal) {
    const snapshot = this._snapshot ?? await this.openSnapshot({ signal });
    return { repoInfo: snapshot.repoInfo, branch: snapshot.branch, source: this._source(snapshot.repoInfo) };
  }

  /** Authors write the config and merges directly: maintain and admin access include write access. */
  _requireAuthorDirect(repoInfo, mode, what) {
    const capability = assertRepositoryPublicationInfo(repoInfo);
    if (!capability.canManage) throw new Error(`Maintain/admin access required to publish ${what}`);
    if (mode !== 'direct' || !capability.canDirectPush) {
      throw new Error(`${what} is published directly: maintain/admin access includes write access`);
    }
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
    const requestSignal = assertAbortSignalOrNull(signal, 'Annotation config publication signal');
    const mode = assertPublicationMode(publicationMode);
    const ctx = this._ctx();
    const { repoInfo, branch, source } = await this._resolved(requestSignal);
    this._requireAuthorDirect(repoInfo, mode, 'annotations/config.json');
    const did = datasetId === undefined ? this.datasetId : assertExactNonblankString(datasetId, 'datasetId');
    const msg = commitMessage === null
      ? `Update annotatable fields for ${did}`
      : assertExactNonblankString(commitMessage, 'Annotation config commit message');
    const expectedSha = conflictIfRemoteShaNotEqual === null
      ? null
      : assertGitHubSha(conflictIfRemoteShaNotEqual, 'Expected annotation config SHA');
    const current = await readContentFile(ctx, source.owner, source.repo, ANNOTATION_CONFIG_PATH, branch, { signal: requestSignal });
    if (current === null) throw layoutInvalid(`${repoInfo.full_name}@${branch} has no annotations/config.json.`);
    assertConfigDocument(current.json, { path: ANNOTATION_CONFIG_PATH });
    const { config: nextConfig, replacement } = buildUpdatedAnnotationConfig({
      currentConfig: current.json,
      datasetId: did,
      datasetName,
      fieldsToAnnotate,
      annotatableSettings,
      closedFields,
    });
    const contentBase64 = encodeBase64Bytes(toAnnotationPublicationBytes(nextConfig, { path: ANNOTATION_CONFIG_PATH }));
    const unchanged = { mode: 'none', branch, path: ANNOTATION_CONFIG_PATH, sha: current.sha, ...replacement, changed: false };
    if (base64PayloadEqualsCanonical(current.contentBase64, contentBase64, ANNOTATION_CONFIG_PATH)) return unchanged;
    if (expectedSha === null) {
      const err = conflictError(
        ANNOTATION_CONFIG_PATH,
        'Missing baseline version for annotations/config.json.\nPull first to load the latest config, then Publish again.'
      );
      err.remoteSha = current.sha;
      err.expectedSha = null;
      throw err;
    }
    if (current.sha !== expectedSha) {
      const err = conflictError(
        ANNOTATION_CONFIG_PATH,
        'annotations/config.json changed since your last Pull.\nPull first to review the latest settings, then Publish again.'
      );
      err.remoteSha = current.sha;
      err.expectedSha = expectedSha;
      throw err;
    }
    if (stableStringifyJson(current.json) === stableStringifyJson(nextConfig)) return unchanged;
    const response = await putContent(ctx, {
      owner: source.owner,
      repo: source.repo,
      path: ANNOTATION_CONFIG_PATH,
      branch,
      message: msg,
      contentBase64,
      sha: current.sha,
      signal: requestSignal,
    });
    return {
      mode: 'direct',
      sha: assertGitHubSha(response?.content?.sha, 'Published GitHub content SHA'),
      branch,
      path: ANNOTATION_CONFIG_PATH,
      ...replacement,
      changed: true,
    };
  }

  async pushModerationMerges({
    mergesDoc,
    commitMessage = null,
    conflictIfRemoteShaNotEqual = null,
    publicationMode,
    signal = null,
  } = {}) {
    const requestSignal = assertAbortSignalOrNull(signal, 'Annotation moderation publication signal');
    const mode = assertPublicationMode(publicationMode);
    const ctx = this._ctx();
    const { repoInfo, branch, source } = await this._resolved(requestSignal);
    this._requireAuthorDirect(repoInfo, mode, ANNOTATION_MERGES_PATH);
    const msg = commitMessage === null
      ? 'Update annotation moderation merges'
      : assertExactNonblankString(commitMessage, 'Moderation merges commit message');
    assertMergesDocument(mergesDoc, { path: 'annotations/moderation/merges.json publish payload' });
    const expectedSha = conflictIfRemoteShaNotEqual === null
      ? null
      : assertGitHubSha(conflictIfRemoteShaNotEqual, 'Expected moderation merges SHA');
    const current = await readContentFile(ctx, source.owner, source.repo, ANNOTATION_MERGES_PATH, branch, { signal: requestSignal });
    // The open dataset's merges replace that dataset's part of the file;
    // every other dataset's merges stay as published.
    const incoming = composeMergesFile(current?.json ?? null, this.datasetId, mergesDoc, { path: ANNOTATION_MERGES_PATH });
    const contentBase64 = encodeBase64Bytes(toAnnotationPublicationBytes(incoming, { path: ANNOTATION_MERGES_PATH }));
    const unchanged = { mode: 'none', branch, path: ANNOTATION_MERGES_PATH, sha: current?.sha ?? null, changed: false };
    if (current !== null && base64PayloadEqualsCanonical(current.contentBase64, contentBase64, ANNOTATION_MERGES_PATH)) {
      return unchanged;
    }
    if (expectedSha === null && current !== null) {
      const err = conflictError(
        ANNOTATION_MERGES_PATH,
        'Missing baseline version for annotations/moderation/merges.json.\nPull first to load the latest merges, then Publish again.'
      );
      err.remoteSha = current.sha;
      err.expectedSha = null;
      throw err;
    }
    if (expectedSha !== null && current?.sha !== expectedSha) {
      const err = conflictError(
        ANNOTATION_MERGES_PATH,
        'annotations/moderation/merges.json changed since your last Pull.\nPull first to review the latest merges, then Publish again.'
      );
      err.remoteSha = current?.sha ?? null;
      err.expectedSha = expectedSha;
      throw err;
    }
    const currentComparable = current === null ? null : { version: current.json.version, merges: current.json.merges };
    if (stableStringifyJson(currentComparable) === stableStringifyJson({ version: incoming.version, merges: incoming.merges })) {
      return unchanged;
    }
    const response = await putContent(ctx, {
      owner: source.owner,
      repo: source.repo,
      path: ANNOTATION_MERGES_PATH,
      branch,
      message: msg,
      contentBase64,
      sha: current?.sha ?? null,
      signal: requestSignal,
    });
    return {
      mode: 'direct',
      sha: assertGitHubSha(response?.content?.sha, 'Published GitHub content SHA'),
      branch,
      path: ANNOTATION_MERGES_PATH,
      changed: true,
    };
  }

  /** The caller's own user file at the branch (a profile load, not a Pull): `{doc, sha, path}` or null. */
  async pullUserFile({ userKey = null, signal = null } = {}) {
    const requestSignal = assertAbortSignalOrNull(signal, 'Annotation user-file pull signal');
    if (typeof userKey !== 'string' || !/^ghid_[1-9][0-9]*$/.test(userKey)) throw new Error('userKey required');
    const { branch, source } = await this._resolved(requestSignal);
    const path = `annotations/users/${userKey}.json`;
    const file = await readContentFile(this._ctx(), source.owner, source.repo, path, branch, { signal: requestSignal });
    if (file === null) return null;
    return { doc: projectUserFile(file.json, this.datasetId, { path, filename: `${userKey}.json` }), sha: file.sha, path };
  }

  /**
   * Publish the person's own file: `userDoc` is the open dataset's view to
   * publish, or a function that makes it from the view published now (null
   * when none is) — a single change (an agent's vote or suggestion) is
   * published on top of what is on GitHub (in fork mode, on top of the open
   * pull request's file), never with the rest of the person's unpublished
   * changes. A composed view names its owner in `githubUserId`. Answers the
   * route taken with the view written (`view`).
   */
  async pushMyUserFile({
    userDoc,
    githubUserId = null,
    commitMessage = null,
    conflictIfRemoteShaNotEqual = null,
    publicationMode,
    signal = null,
  } = {}) {
    const requestSignal = assertAbortSignalOrNull(signal, 'Annotation user-file publication signal');
    const mode = assertPublicationMode(publicationMode);
    const ctx = this._ctx();
    const composeView = typeof userDoc === 'function' ? userDoc : null;
    if (composeView !== null && (!Number.isSafeInteger(githubUserId) || githubUserId < 1)) {
      throw new Error('A composed user file names its githubUserId');
    }
    const { id, fileUser, path, filename } = userFileOf(composeView === null ? userDoc : { githubUserId });
    if (composeView === null) {
      // The open dataset's section alone must fit the file limit; checked
      // before any request, because the published file can only be larger.
      toAnnotationPublicationBytes(composeUserFile(null, this.datasetId, userDoc, { path, filename }), { path });
    }
    // The view to publish over a published file (null: none).
    const viewOver = (file) => (composeView === null
      ? userDoc
      : composeView(file === null ? null : projectUserFile(file, this.datasetId, { path, filename })));
    const authenticatedUser = assertAuthUserResponse(
      (await callWorker(ctx, { scope: 'service', path: '/auth/user', signal: requestSignal })).document
    );
    if (authenticatedUser.id !== id) {
      throw new Error(
        `User document identity ${fileUser} does not match authenticated GitHub user ghid_${authenticatedUser.id}`
      );
    }
    const { repoInfo, branch, source } = await this._resolved(requestSignal);
    assertRepositoryPublicationInfo(repoInfo);
    const upstream = await readContentFile(ctx, source.owner, source.repo, path, branch, { signal: requestSignal });
    const published = upstream === null ? null : assertOwnPublishedFile(upstream.json, path, filename, '');
    const remoteUpdatedAt = published?.updatedAt ?? null;
    const msg = commitMessage === null
      ? `Update annotations for @${authenticatedUser.login}`
      : assertExactNonblankString(commitMessage, 'Annotation user-file commit message');

    // Direct: the open dataset's view replaces that dataset's section of the
    // file; the contributor's other datasets stay as published.
    const view = mode === 'direct' ? viewOver(published) : null;
    const content = mode === 'direct'
      ? encodeBase64Bytes(
        toAnnotationPublicationBytes(composeUserFile(published, this.datasetId, view, { path, filename }), { path })
      )
      : null;
    if (mode === 'direct' && upstream !== null && base64PayloadEqualsCanonical(upstream.contentBase64, content, path)) {
      return { mode: 'none', branch, path, sha: upstream.sha, remoteUpdatedAt, view };
    }
    const expectedSha = conflictIfRemoteShaNotEqual === null
      ? null
      : assertGitHubSha(conflictIfRemoteShaNotEqual, 'Expected remote user-file SHA');
    const sha = upstream?.sha ?? null;
    if (!expectedSha && sha) {
      const err = conflictError(
        path,
        'Missing baseline version for your remote user file.\nPull first to merge any existing votes/suggestions, then Publish again.'
      );
      Object.assign(err, { remoteUpdatedAt, remoteSha: sha, expectedSha: null });
      throw err;
    }
    if (expectedSha && sha !== expectedSha) {
      const err = conflictError(path, 'Remote user file changed since your last Pull.\nPull first to merge changes before publishing.');
      Object.assign(err, { remoteUpdatedAt, remoteSha: sha, expectedSha });
      throw err;
    }

    if (mode === 'fork-pull-request') {
      const result = await publishUserFileViaFork(ctx, {
        repoInfo,
        source,
        baseBranch: branch,
        datasetId: this.datasetId,
        file: { fileUser, path, filename },
        viewOver,
        upstream,
        authUser: authenticatedUser,
        title: msg,
        body: [
          'Community annotation update from Cellucid.',
          '',
          `User: @${authenticatedUser.login}`,
          `File: \`${path}\``,
        ].join('\n'),
        signal: requestSignal,
      });
      return { ...result, branch, path, remoteUpdatedAt };
    }

    if (!assertRepositoryPublicationInfo(repoInfo).canDirectPush) {
      throw new Error('Direct annotation publication requires GitHub write permission');
    }
    try {
      const response = await putContent(ctx, {
        owner: source.owner,
        repo: source.repo,
        path,
        branch,
        message: msg,
        contentBase64: content,
        sha,
        signal: requestSignal,
      });
      return {
        mode: 'direct',
        sha: assertGitHubSha(response?.content?.sha, 'Published GitHub content SHA'),
        branch,
        path,
        remoteUpdatedAt,
        view,
      };
    } catch (err) {
      if (err?.code === 'COMMUNITY_ANNOTATION_CONFLICT') err.remoteUpdatedAt = remoteUpdatedAt;
      throw err;
    }
  }
}

/**
 * Fold a Pull's cached files into `remoteUserFiles` (the session's
 * `createRemoteUserFiles()`), one record at a time from the file cache: a
 * file excluded when it was read stays out, and one the session refuses when
 * it is folded (`COMMUNITY_ANNOTATION_FILE_REJECTED`: an id another
 * contributor owns, a second file of one identity) is left out on its own.
 * Answers `{excluded: [{path, sha, reason}], moderationDocument}`.
 */
export async function foldCachedFiles({ fileCache, cacheScope, remoteUserFiles }) {
  const excluded = [];
  let moderationDocument = null;
  await fileCache.forEachRecord(cacheScope, (record) => {
    if (record.rejection !== null) {
      excluded.push({ path: record.path, sha: record.sha, reason: record.rejection.message });
      return;
    }
    if (record.path === ANNOTATION_MERGES_PATH) {
      moderationDocument = record.view;
      return;
    }
    try {
      remoteUserFiles.add(record.view);
    } catch (error) {
      if (error?.code !== 'COMMUNITY_ANNOTATION_FILE_REJECTED') throw error;
      excluded.push({ path: record.path, sha: record.sha, reason: String(error.message) });
    }
  });
  return { excluded, moderationDocument };
}

export function parseOwnerRepo(input) {
  return parseCanonicalGitHubRepositoryReference(input);
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
  const token = tokenOverride === null ? getGitHubAuthSession().getToken() : assertOptionalToken(tokenOverride);
  return new CommunityAnnotationGitHubSync({
    datasetId,
    owner: parsed.owner,
    repo: parsed.repo,
    token,
    branch: meta.branchMode === 'explicit' ? (parsed.ref || null) : null,
    workerOrigin: getGitHubWorkerOrigin(),
  });
}

export function setDatasetAnnotationRepoFromUrlParam({ datasetId, urlParamValue, username = 'local' }) {
  const parsed = parseOwnerRepo(urlParamValue);
  if (!parsed || parsed.ref === null) return false;
  return setAnnotationRepoForDataset(datasetId, parsed.ownerRepoRef, username, { branchMode: 'explicit' });
}

export async function resolveAnnotationRepositoryFromUrlParam({ urlParamValue, tokenOverride = null, signal = null } = {}) {
  const requestSignal = assertAbortSignalOrNull(signal, 'Annotation repository resolution signal');
  const parsed = parseOwnerRepo(urlParamValue);
  if (!parsed) return null;
  // Default-branch ownership is resolved once, before the repository reference
  // becomes persistent state.
  if (!parsed.ref) {
    const token = tokenOverride === null ? getGitHubAuthSession().getToken() : assertOptionalToken(tokenOverride);
    if (!token) return false;
    const workerOrigin = getGitHubWorkerOrigin();
    const repoInfo = await githubGet(
      { workerOrigin, token, transport: defaultWorkerTransport(workerOrigin), onWait: null },
      repoPath(parsed.owner, parsed.repo),
      { signal: requestSignal }
    );
    const head = assertGitHubBranch(repoInfo?.default_branch, 'GitHub repository default_branch');
    return { repoRef: `${parsed.ownerRepo}@${head}`, branchMode: 'default' };
  }
  return { repoRef: parsed.ownerRepoRef, branchMode: 'explicit' };
}
