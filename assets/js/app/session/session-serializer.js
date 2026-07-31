/**
 * @fileoverview Session bundle orchestrator.
 *
 * Responsibilities:
 * - enumerate contributors in a fixed order
 * - capture chunks + write a single-file `.cellucid-session` bundle
 * - load manifest and apply eager/lazy chunks in one awaited restore operation
 * - integrate NotificationCenter progress tracking
 * - own cancellation (AbortController) and isolate failures
 *
 * The orchestrator deliberately does NOT know feature internals.
 *
 * @module session/session-serializer
 */

import { readBundle } from './bundle/reader.js';
import { writeBundle } from './bundle/writer.js';
import {
  MAX_UNCOMPRESSED_CHUNK_BYTES,
  MAX_STORED_CHUNK_BYTES
} from './bundle/format.js';
import { gzipCompress, gzipDecompress } from './codecs/gzip.js';
import {
  ANALYSIS_CACHE_INVENTORY_CHUNK_PROFILE
} from './contributors/analysis-artifacts.js';
import {
  assertDatasetFingerprint,
  buildSessionContext,
  createSessionRestoreTransaction,
  datasetFingerprintMatches,
  describeDatasetFingerprintMismatch,
  getDatasetFingerprint,
  registerSessionRestoreSnapshots
} from './session-context.js';
import {
  assertArray,
  assertBoolean,
  assertExactKeys,
  assertNonEmptyString,
  assertPlainRecord,
  assertSafeInteger,
  requireMethod
} from './schema-contract.js';

/**
 * @typedef {'eager'|'lazy'} ChunkPriority
 * @typedef {'json'|'binary'} ChunkKind
 * @typedef {'none'|'gzip'} ChunkCodec
 *
 * @typedef {object} SessionChunk
 * @property {string} id
 * @property {string} contributorId
 * @property {ChunkPriority} priority
 * @property {ChunkKind} kind
 * @property {ChunkCodec} codec
 * @property {string} label
 * @property {boolean} datasetDependent
 * @property {object|Uint8Array} payload
 */

/**
 * @typedef {object} SessionContributor
 * @property {string} id
 * @property {(ctx: any) => Promise<SessionChunk[]|void>|SessionChunk[]|void} capture
 * @property {(ctx: any, chunkMeta: any, payload: any) => Promise<void>|void} restore
 */

const MAX_PUBLISHED_DEFAULT_STATE_BYTES = 32 * 1024;
const MAX_PUBLISHED_DEFAULT_UNCOMPRESSED_BYTES = 64 * 1024;

export const SESSION_RESTORE_SUPERSEDED_CODE =
  'CELLUCID_SESSION_RESTORE_SUPERSEDED';
export const SESSION_RESTORE_CANCELED_CODE =
  'CELLUCID_SESSION_RESTORE_CANCELED';

export function createSessionRestoreCanceledError() {
  const error = new Error('Session restore was canceled by the user.');
  error.name = 'AbortError';
  error.code = SESSION_RESTORE_CANCELED_CODE;
  return error;
}

export function isSessionRestoreCanceledError(error) {
  return error?.code === SESSION_RESTORE_CANCELED_CODE;
}

export function createSessionRestoreSupersededError() {
  const error = new Error(
    'Session restore was superseded by a newer restore.'
  );
  error.name = 'AbortError';
  error.code = SESSION_RESTORE_SUPERSEDED_CODE;
  return error;
}

export function isSessionRestoreSupersededError(error) {
  return error?.code === SESSION_RESTORE_SUPERSEDED_CODE;
}

const PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE = Object.freeze([
  Object.freeze({
    id: 'core/field-overlays',
    contributorId: 'field-overlays',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Field overlays',
    datasetDependent: true
  }),
  Object.freeze({
    id: 'core/state',
    contributorId: 'core-state',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Core state',
    datasetDependent: true
  }),
  Object.freeze({
    id: 'ui/dockable-layout',
    contributorId: 'dockable-layout',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Floating panels',
    datasetDependent: false
  }),
  Object.freeze({
    id: 'analysis/windows',
    contributorId: 'analysis-windows',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Analysis windows',
    datasetDependent: true
  }),
  Object.freeze({
    id: 'highlights/meta',
    contributorId: 'highlights-meta',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Highlight metadata',
    datasetDependent: true
  })
]);
const CINEMATIC_CAMERA_CHUNK_PROFILE = Object.freeze({
  id: 'cinematic/camera',
  contributorId: 'cinematic-camera',
  priority: 'eager',
  kind: 'json',
  codec: 'gzip',
  label: 'Cinematic camera path',
  datasetDependent: true
});
const CURRENT_GENERIC_STATIC_CHUNK_PROFILES = Object.freeze([
  ...PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE,
  ANALYSIS_CACHE_INVENTORY_CHUNK_PROFILE,
  CINEMATIC_CAMERA_CHUNK_PROFILE
]);
const STATIC_CHUNK_PROFILE_KEYS = Object.freeze([
  'id',
  'contributorId',
  'priority',
  'kind',
  'codec',
  'label',
  'datasetDependent'
]);
const BUILT_IN_STATIC_CHUNK_PROFILES = Object.freeze([
  ...CURRENT_GENERIC_STATIC_CHUNK_PROFILES
]);
const STATIC_PROFILE_BY_ID = new Map(
  BUILT_IN_STATIC_CHUNK_PROFILES.map(profile => [profile.id, profile])
);
const STATIC_PROFILE_BY_CONTRIBUTOR = new Map(
  BUILT_IN_STATIC_CHUNK_PROFILES
    .filter(profile => profile.contributorId !== 'analysis-artifacts')
    .map(
      profile => [profile.contributorId, profile]
    )
);

function validateBuiltInStaticChunkProfile(entry, context) {
  const idProfile = STATIC_PROFILE_BY_ID.get(entry.id);
  const contributorProfile =
    STATIC_PROFILE_BY_CONTRIBUTOR.get(entry.contributorId);
  if (
    idProfile !== undefined
    && contributorProfile !== undefined
    && idProfile !== contributorProfile
  ) {
    throw new TypeError(
      `${context} mixes two canonical built-in chunk identities.`
    );
  }
  const expected = idProfile ?? contributorProfile;
  if (expected === undefined) return;
  for (const key of STATIC_CHUNK_PROFILE_KEYS) {
    if (entry[key] !== expected[key]) {
      throw new TypeError(
        `${context} must match canonical built-in chunk "${expected.id}".`
      );
    }
  }
}

function isExpectedRestoreDismissal(error, signal) {
  return (
    isSessionRestoreSupersededError(error)
    || isSessionRestoreCanceledError(error)
    || isSessionRestoreSupersededError(signal.reason)
    || isSessionRestoreCanceledError(signal.reason)
  );
}

/**
 * @param {AbortSignal | null | undefined} signal
 */
function throwIfAborted(signal) {
  if (signal !== null && signal.aborted) {
    if (signal.reason instanceof Error) throw signal.reason;
    throw new DOMException('Aborted', 'AbortError');
  }
}

function captureSessionDatasetOwner(ctx) {
  const state = ctx.state;
  const getGeneration = requireMethod(
    state,
    'getDatasetGeneration',
    'Session capture DataState'
  );
  const generation = assertSafeInteger(
    getGeneration.call(state),
    'Session capture dataset generation'
  );
  return Object.freeze({
    fingerprint: Object.freeze(getDatasetFingerprint(ctx)),
    generation,
    obsData: state.obsData,
    obsFields: state.obsData?.fields,
    positionsArray: state.positionsArray,
    state,
    varData: state.varData,
    varFields: state.varData?.fields
  });
}

function assertSessionDatasetOwner(ctx, owner) {
  const state = ctx.state;
  const getGeneration = requireMethod(
    state,
    'getDatasetGeneration',
    'Session capture DataState'
  );
  const generation = assertSafeInteger(
    getGeneration.call(state),
    'Session capture dataset generation'
  );
  if (
    state !== owner.state
    || generation !== owner.generation
    || state.obsData !== owner.obsData
    || state.obsData?.fields !== owner.obsFields
    || state.positionsArray !== owner.positionsArray
    || state.varData !== owner.varData
    || state.varData?.fields !== owner.varFields
    || !datasetFingerprintMatches(
      owner.fingerprint,
      getDatasetFingerprint(ctx)
    )
  ) {
    const error = new Error(
      'Session capture dataset generation changed before capture completed.'
    );
    error.code = 'SESSION_CAPTURE_DATASET_CHANGED';
    throw error;
  }
}

/**
 * Yield back to the browser so rendering stays responsive.
 * @returns {Promise<void>}
 */
function nextTick() {
  if (typeof requestAnimationFrame !== 'function') {
    throw new Error('Session restore requires requestAnimationFrame.');
  }
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Download a Blob as a file.
 * @param {Blob} blob
 * @param {string} filename
 */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Basic manifest shape validation (untrusted input).
 * @param {any} manifest
 */
function validateManifest(manifest, contributorById, manifestProfile) {
  if (
    manifestProfile !== null
    && manifestProfile !== 'published-default'
  ) {
    throw new TypeError('Session manifest profile is invalid.');
  }
  assertExactKeys(
    manifest,
    ['createdAt', 'datasetFingerprint', 'chunks'],
    'Session manifest'
  );
  if (
    typeof manifest.createdAt !== 'string'
    || new Date(manifest.createdAt).toISOString() !== manifest.createdAt
  ) {
    throw new TypeError('Session manifest createdAt must be a canonical ISO timestamp.');
  }
  assertDatasetFingerprint(
    manifest.datasetFingerprint,
    'Session manifest datasetFingerprint'
  );
  assertArray(manifest.chunks, 'Session manifest chunks');
  const chunkIds = new Set();
  const contributorOrder = new Map(
    [...contributorById.keys()].map(
      (contributorId, index) => [contributorId, index]
    )
  );
  let fieldOverlaysAvailable = false;
  let sawLazy = false;
  let lastEagerContributorIndex = -1;
  let lastLazyContributorIndex = -1;
  for (let index = 0; index < manifest.chunks.length; index++) {
    const entry = manifest.chunks[index];
    const context = `Session manifest chunk ${index}`;
    assertExactKeys(
      entry,
      [
        'id',
        'contributorId',
        'priority',
        'kind',
        'codec',
        'label',
        'datasetDependent',
        'storedBytes',
        'uncompressedBytes'
      ],
      context
    );
    const chunkId = assertNonEmptyString(entry.id, `${context} id`);
    if (chunkIds.has(chunkId)) {
      throw new TypeError(`Session manifest chunk id "${chunkId}" is duplicated.`);
    }
    chunkIds.add(chunkId);
    const contributorId = assertNonEmptyString(
      entry.contributorId,
      `${context} contributorId`
    );
    if (!contributorById.has(contributorId)) {
      throw new Error(
        `Session contributor "${contributorId}" is not registered for chunk "${chunkId}".`
      );
    }
    if (
      chunkId === 'core/field-overlays'
      && contributorId === 'field-overlays'
    ) {
      fieldOverlaysAvailable = true;
    }
    if (
      contributorId === 'user-defined-codes'
      && !fieldOverlaysAvailable
    ) {
      throw new TypeError(
        'User-defined code chunks require the prior field-overlays chunk.'
      );
    }
    if (entry.priority !== 'eager' && entry.priority !== 'lazy') {
      throw new TypeError(`${context} priority must be eager or lazy.`);
    }
    if (entry.priority === 'lazy') {
      sawLazy = true;
    } else if (sawLazy) {
      throw new TypeError('Session manifest eager chunks must precede lazy chunks.');
    }
    if (manifestProfile === null) {
      const currentContributorIndex = contributorOrder.get(contributorId);
      const previousContributorIndex = entry.priority === 'eager'
        ? lastEagerContributorIndex
        : lastLazyContributorIndex;
      if (currentContributorIndex < previousContributorIndex) {
        throw new TypeError(
          `Session manifest ${entry.priority} contributor groups must ` +
          'match their registered order.'
        );
      }
      if (entry.priority === 'eager') {
        lastEagerContributorIndex = currentContributorIndex;
      } else {
        lastLazyContributorIndex = currentContributorIndex;
      }
    }
    if (entry.kind !== 'json' && entry.kind !== 'binary') {
      throw new TypeError(`${context} kind must be json or binary.`);
    }
    if (entry.codec !== 'none' && entry.codec !== 'gzip') {
      throw new TypeError(`${context} codec must be none or gzip.`);
    }
    assertNonEmptyString(entry.label, `${context} label`);
    assertBoolean(entry.datasetDependent, `${context} datasetDependent`);
    validateBuiltInStaticChunkProfile(entry, context);
    if (
      contributorId === ANALYSIS_CACHE_INVENTORY_CHUNK_PROFILE.contributorId
      && entry.priority === 'eager'
      && chunkId !== ANALYSIS_CACHE_INVENTORY_CHUNK_PROFILE.id
    ) {
      throw new TypeError(
        'The analysis-artifacts contributor has exactly one canonical eager cache inventory.'
      );
    }
    assertSafeInteger(entry.storedBytes, `${context} storedBytes`, {
      maximum: MAX_STORED_CHUNK_BYTES
    });
    assertSafeInteger(entry.uncompressedBytes, `${context} uncompressedBytes`, {
      maximum: MAX_UNCOMPRESSED_CHUNK_BYTES
    });
  }
  if (manifestProfile === null) {
    for (const expected of CURRENT_GENERIC_STATIC_CHUNK_PROFILES) {
      if (
        contributorById.has(expected.contributorId)
        && !chunkIds.has(expected.id)
      ) {
        throw new TypeError(
          `Current session manifests require singleton chunk "${expected.id}".`
        );
      }
    }
  }
  return manifest;
}

/**
 * Published official defaults are intentionally much narrower than an
 * interactive user-authored session. Validate the complete static profile
 * before the chunk iterator can dispatch even its first contributor.
 *
 * @param {any} manifest
 */
function validatePublishedDefaultManifest(manifest) {
  if (
    manifest === null
    || typeof manifest !== 'object'
    || !Array.isArray(manifest.chunks)
  ) {
    throw new TypeError(
      'Published default session must match the exact static profile.'
    );
  }

  for (const entry of manifest.chunks) {
    if (
      entry !== null
      && typeof entry === 'object'
      && (
        (
          typeof entry.id === 'string'
          && entry.id.startsWith('cinematic/')
        )
        || entry.contributorId === 'cinematic-camera'
      )
    ) {
      throw new TypeError(
        'Published default session must not contain cinematic camera data.'
      );
    }
  }

  if (
    manifest.chunks.length
    !== PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE.length
  ) {
    throw new TypeError(
      'Published default session must match the exact static profile.'
    );
  }

  let aggregateUncompressedBytes = 0;
  for (
    let index = 0;
    index < PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE.length;
    index++
  ) {
    const actual = manifest.chunks[index];
    const expected = PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE[index];
    if (actual === null || typeof actual !== 'object') {
      throw new TypeError(
        'Published default session must match the exact static profile.'
      );
    }
    for (const key of STATIC_CHUNK_PROFILE_KEYS) {
      if (actual[key] !== expected[key]) {
        throw new TypeError(
          'Published default session must match the exact static profile.'
        );
      }
    }
    const uncompressedBytes = assertSafeInteger(
      actual.uncompressedBytes,
      `Published default chunk "${actual.id}" uncompressedBytes`,
      { maximum: MAX_PUBLISHED_DEFAULT_UNCOMPRESSED_BYTES }
    );
    aggregateUncompressedBytes += uncompressedBytes;
    if (
      aggregateUncompressedBytes
      > MAX_PUBLISHED_DEFAULT_UNCOMPRESSED_BYTES
    ) {
      throw new RangeError(
        'Published default session exceeds the 64 KiB aggregate uncompressed byte limit.'
      );
    }
  }
  return manifest;
}

function assertJsonValue(value, context, ancestors = new Set()) {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${context} JSON numbers must be finite.`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${context} must contain only exact JSON values.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${context} must not contain cyclic references.`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`${context} arrays must not contain holes.`);
      }
      assertJsonValue(value[index], `${context}[${index}]`, ancestors);
    }
  } else {
    assertPlainRecord(value, context);
    for (const [key, child] of Object.entries(value)) {
      assertNonEmptyString(key, `${context} property name`);
      assertJsonValue(child, `${context}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
  return value;
}

/**
 * Encode a JSON payload into UTF-8 bytes.
 * @param {any} value
 * @returns {Uint8Array}
 */
function encodeJsonBytes(value) {
  assertJsonValue(value, 'Session JSON payload');
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * Decode UTF-8 JSON bytes.
 * @param {Uint8Array} bytes
 * @returns {any}
 */
function decodeJsonBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('Session JSON bytes must be a Uint8Array.');
  }
  const value = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  );
  return assertJsonValue(value, 'Decoded session JSON payload');
}

function assertOwner(value, context) {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`${context} must be an object.`);
  }
  return value;
}

function assertNullableOwner(value, context) {
  if (value === null) return value;
  return assertOwner(value, context);
}

function assertAbortController(value, context) {
  assertOwner(value, context);
  requireMethod(value, 'abort', context);
  if (
    value.signal === null
    || typeof value.signal !== 'object'
    || typeof value.signal.aborted !== 'boolean'
  ) {
    throw new TypeError(`${context} must expose an AbortSignal.`);
  }
  return value;
}

function assertAbortSignal(value, context) {
  assertOwner(value, context);
  if (typeof value.aborted !== 'boolean') {
    throw new TypeError(`${context} must expose an aborted boolean.`);
  }
  requireMethod(value, 'addEventListener', context);
  requireMethod(value, 'removeEventListener', context);
  return value;
}

function assertNotifications(value) {
  assertOwner(value, 'Session notification owner');
  for (const methodName of [
    'startDownload',
    'updateDownload',
    'completeDownload',
    'dismissDownload',
    'failDownload',
    'info'
  ]) {
    requireMethod(value, methodName, 'Session notification owner');
  }
  return value;
}

function assertCapturedChunk(chunk, contributorId, chunkIds) {
  const context = `Session contributor "${contributorId}" chunk`;
  assertExactKeys(
    chunk,
    [
      'id',
      'contributorId',
      'priority',
      'kind',
      'codec',
      'label',
      'datasetDependent',
      'payload'
    ],
    context
  );
  const chunkId = assertNonEmptyString(chunk.id, `${context} id`);
  if (chunkIds.has(chunkId)) {
    throw new TypeError(`Session chunk id "${chunkId}" is duplicated.`);
  }
  chunkIds.add(chunkId);
  if (chunk.contributorId !== contributorId) {
    throw new TypeError(
      `${context} contributorId must equal its current contributor id.`
    );
  }
  if (chunk.priority !== 'eager' && chunk.priority !== 'lazy') {
    throw new TypeError(`${context} priority must be eager or lazy.`);
  }
  if (chunk.kind !== 'json' && chunk.kind !== 'binary') {
    throw new TypeError(`${context} kind must be json or binary.`);
  }
  if (chunk.codec !== 'none' && chunk.codec !== 'gzip') {
    throw new TypeError(`${context} codec must be none or gzip.`);
  }
  assertNonEmptyString(chunk.label, `${context} label`);
  assertBoolean(chunk.datasetDependent, `${context} datasetDependent`);
  if (chunk.kind === 'json') {
    assertJsonValue(chunk.payload, `${context} payload`);
  } else if (!(chunk.payload instanceof Uint8Array)) {
    throw new TypeError(`${context} binary payload must be a Uint8Array.`);
  }
  return chunk;
}

async function captureRestoreSnapshots(
  ctx,
  contributorById,
  manifest,
  manifestProfile
) {
  const snapshots = new Map();
  const capturedIds = new Set();
  const incomingChunkIds = new Set(
    manifest.chunks.map(chunk => chunk.id)
  );
  const requiredProfiles = manifestProfile === 'published-default'
    ? PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE
    : PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE.filter(
      profile => incomingChunkIds.has(profile.id)
    );
  for (const expected of requiredProfiles) {
    const contributor = contributorById.get(expected.contributorId);
    if (contributor === undefined) {
      throw new Error(
        `Session rollback contributor "${expected.contributorId}" is not registered.`
      );
    }
    const produced = await contributor.capture(ctx);
    if (!Array.isArray(produced) || produced.length !== 1) {
      throw new TypeError(
        `Session rollback contributor "${expected.contributorId}" must capture exactly one chunk.`
      );
    }
    const chunk = assertCapturedChunk(
      produced[0],
      expected.contributorId,
      capturedIds
    );
    for (const key of STATIC_CHUNK_PROFILE_KEYS) {
      if (chunk[key] !== expected[key]) {
        throw new TypeError(
          `Session rollback chunk "${expected.id}" does not match its current profile.`
        );
      }
    }
    snapshots.set(expected.id, structuredClone(chunk.payload));
  }
  return snapshots;
}

function failureMessage(error) {
  if (!(error instanceof Error)) {
    return 'Session operation threw a non-Error value.';
  }
  if (typeof error.message !== 'string' || error.message.length === 0) {
    return error.name;
  }
  return error.message;
}

function preserveRestoreRollbackFailure(error, rollbackError) {
  if (error instanceof Error && error.cause === undefined) {
    error.cause = rollbackError;
  }
}

export class SessionSerializer {
  /**
   * @param {object} options
   * @param {import('../state/core/data-state.js').DataState} options.state
   * @param {object} options.viewer
   * @param {HTMLElement|null} [options.sidebar]
   * @param {import('../../data/data-source-manager.js').DataSourceManager|null} [options.dataSourceManager]
   * @param {any|null} [options.comparisonModule]
   * @param {any|null} [options.analysisWindowManager]
  * @param {SessionContributor[]} options.contributors
   */
  constructor(options) {
    assertExactKeys(
      options,
      [
        'state',
        'viewer',
        'sidebar',
        'dataSourceManager',
        'comparisonModule',
        'analysisWindowManager',
        'cinematicCamera',
        'contributors'
      ],
      'SessionSerializer options'
    );
    this._base = {
      state: assertOwner(options.state, 'SessionSerializer state'),
      viewer: assertOwner(options.viewer, 'SessionSerializer viewer'),
      sidebar: assertOwner(options.sidebar, 'SessionSerializer sidebar'),
      dataSourceManager: assertNullableOwner(
        options.dataSourceManager,
        'SessionSerializer dataSourceManager'
      ),
      comparisonModule: assertNullableOwner(
        options.comparisonModule,
        'SessionSerializer comparisonModule'
      ),
      analysisWindowManager: assertNullableOwner(
        options.analysisWindowManager,
        'SessionSerializer analysisWindowManager'
      ),
      cinematicCamera: assertNullableOwner(
        options.cinematicCamera,
        'SessionSerializer cinematicCamera'
      )
    };

    /** @type {SessionContributor[]} */
    this._contributors = assertArray(
      options.contributors,
      'SessionSerializer contributors'
    );

    /** @type {Map<string, SessionContributor>} */
    this._contributorById = new Map();
    for (let index = 0; index < this._contributors.length; index++) {
      const contributor = assertOwner(
        this._contributors[index],
        `Session contributor ${index}`
      );
      const contributorId = assertNonEmptyString(
        contributor.id,
        `Session contributor ${index} id`
      );
      requireMethod(contributor, 'capture', `Session contributor "${contributorId}"`);
      requireMethod(contributor, 'restore', `Session contributor "${contributorId}"`);
      if (this._contributorById.has(contributorId)) {
        throw new TypeError(`Session contributor id "${contributorId}" is duplicated.`);
      }
      this._contributorById.set(contributorId, contributor);
    }

    /** @type {AbortController|null} */
    this._activeRestoreAbort = null;
    /** @type {Promise<void>|null} */
    this._activeRestoreTask = null;
    /** @type {Promise<void>|null} */
    this._activeLazyTask = null;
    /** @type {(() => Promise<void>|void)|null} */
    this._captureSettlement = null;
    /** @type {(() => Promise<void>|void)|null} */
    this._restoreSettlement = null;
    /** @type {Promise<void>} */
    this._stateOperationTail = Promise.resolve();
  }

  /**
   * Update the analysis module references once it is initialized.
   * This avoids hard coupling to `main.js` bootstrap order.
   *
   * @param {{ comparisonModule: object, analysisWindowManager: object }} refs
   */
  setAnalysisRefs(refs) {
    assertExactKeys(
      refs,
      ['comparisonModule', 'analysisWindowManager'],
      'Session analysis references'
    );
    this._base.comparisonModule = assertOwner(
      refs.comparisonModule,
      'Session comparisonModule'
    );
    this._base.analysisWindowManager = assertOwner(
      refs.analysisWindowManager,
      'Session analysisWindowManager'
    );
  }

  /**
   * Set the cinematic camera reference once the UI is initialized.
   * @param {object} cinematicCamera
   */
  setCinematicCameraRef(cinematicCamera) {
    this._base.cinematicCamera = assertOwner(
      cinematicCamera,
      'Session cinematic camera'
    );
  }

  /**
   * Bind the exact UI-mutation settlement required before contributors read
   * session state. The UI owner is installed once after bootstrap.
   *
   * @param {() => Promise<void>|void} settle
   */
  setCaptureSettlement(settle) {
    if (typeof settle !== 'function') {
      throw new TypeError(
        'Session capture settlement must be a function.'
      );
    }
    if (
      this._captureSettlement !== null
      && this._captureSettlement !== settle
    ) {
      throw new Error(
        'Session capture settlement is already owned.'
      );
    }
    this._captureSettlement = settle;
  }

  /**
   * Bind synchronous invalidation plus drainage required before any restore
   * contributor snapshots or replaces current UI-backed state.
   *
   * @param {() => Promise<void>|void} settle
   */
  setRestoreSettlement(settle) {
    if (typeof settle !== 'function') {
      throw new TypeError(
        'Session restore settlement must be a function.'
      );
    }
    if (
      this._restoreSettlement !== null
      && this._restoreSettlement !== settle
    ) {
      throw new Error(
        'Session restore settlement is already owned.'
      );
    }
    this._restoreSettlement = settle;
  }

  /**
   * Serialize every operation that reads or mutates contributor-backed state.
   * The public task preserves the exact operation outcome while the internal
   * tail always settles so one failure cannot poison later work.
   *
   * @template T
   * @param {() => Promise<T>|T} operation
   * @returns {Promise<T>}
   */
  _runExclusiveStateOperation(operation) {
    if (typeof operation !== 'function') {
      throw new TypeError(
        'Session state operation must be a function.'
      );
    }
    const task = this._stateOperationTail.then(operation);
    this._stateOperationTail = task.then(
      () => {},
      () => {}
    );
    return task;
  }

  async _runSettlementLease(settle, label, operation) {
    let release = null;
    let failure = null;
    let value;
    try {
      if (settle !== null) {
        const candidate = await settle();
        if (
          candidate !== undefined
          && typeof candidate !== 'function'
        ) {
          throw new TypeError(
            `${label} must return a release function or undefined.`
          );
        }
        release = candidate ?? null;
      }
      value = await operation();
    } catch (error) {
      failure = error;
    }
    if (release !== null) {
      try {
        await release();
      } catch (releaseError) {
        failure = failure === null
          ? releaseError
          : new AggregateError(
              [failure, releaseError],
              `${label} operation and release both failed.`
            );
      }
    }
    if (failure !== null) throw failure;
    return value;
  }

  /**
   * Cancel any in-flight restore and return an awaitable settlement boundary.
   *
   * Aborting remains synchronous for existing UI callers. Awaiting the returned
   * promise guarantees that no contributor from the canceled restore is still
   * running.
   *
   * @returns {Promise<void>}
   */
  cancelRestore() {
    if (this._activeRestoreAbort !== null) {
      this._activeRestoreAbort.abort(
        createSessionRestoreCanceledError()
      );
    }
    const activeTask = this._activeRestoreTask;
    if (activeTask === null) return Promise.resolve();
    return activeTask.then(
      () => {},
      () => {}
    );
  }

  /**
   * Explicitly cancel and await the owned restore operation.
   *
   * @returns {Promise<void>}
   */
  async cancelRestoreAndWait() {
    await this.cancelRestore();
  }

  /**
   * Serialize restore ownership. A replacement aborts the current owner, waits
   * for every contributor in that operation to settle, and only then starts.
   *
   * @param {(abortController: AbortController) => Promise<void>} operation
   * @param {{ signal: AbortSignal|null }} options
   * @returns {Promise<void>}
   */
  _runOwnedRestore(operation, options) {
    if (typeof operation !== 'function') {
      throw new TypeError('Session restore operation must be a function.');
    }
    assertExactKeys(options, ['signal'], 'Owned session restore options');
    const callerSignal = options.signal === null
      ? null
      : assertAbortSignal(
        options.signal,
        'Owned session restore caller signal'
      );

    const previousTask = this._activeRestoreTask;
    if (this._activeRestoreAbort !== null) {
      this._activeRestoreAbort.abort(
        createSessionRestoreSupersededError()
      );
    }

    const abortController = new AbortController();
    let detachCallerAbort = null;
    if (callerSignal !== null) {
      const forwardCallerAbort = () => abortController.abort();
      callerSignal.addEventListener('abort', forwardCallerAbort, {
        once: true
      });
      detachCallerAbort = () => {
        callerSignal.removeEventListener('abort', forwardCallerAbort);
      };
      if (callerSignal.aborted) {
        abortController.abort();
      }
    }

    const ownedTask = this._runExclusiveStateOperation(async () => {
      if (previousTask !== null) {
        try {
          await previousTask;
        } catch {
          // The prior caller owns its result. Replacement only needs settlement.
        }
      }
      throwIfAborted(abortController.signal);
      let releaseSettlement = null;
      let failure = null;
      try {
        if (this._restoreSettlement !== null) {
          const release = await this._restoreSettlement();
          if (release !== undefined && typeof release !== 'function') {
            throw new TypeError(
              'Session restore settlement must return a release function or undefined.'
            );
          }
          releaseSettlement = release ?? null;
          throwIfAborted(abortController.signal);
        }
        await operation(abortController);
      } catch (error) {
        if (
          abortController.signal.aborted
          && (
            isSessionRestoreSupersededError(
              abortController.signal.reason
            )
            || isSessionRestoreCanceledError(
              abortController.signal.reason
            )
          )
        ) {
          failure = abortController.signal.reason;
        } else {
          failure = error;
        }
      }
      if (releaseSettlement !== null) {
        try {
          await releaseSettlement();
        } catch (releaseError) {
          failure = failure === null
            ? releaseError
            : new AggregateError(
                [failure, releaseError],
                'Session restore and UI settlement release both failed.'
              );
        }
      }
      if (failure !== null) throw failure;
    });

    this._activeRestoreAbort = abortController;
    this._activeRestoreTask = ownedTask;

    const releaseOwnership = () => {
      if (detachCallerAbort !== null) detachCallerAbort();
      if (this._activeRestoreTask === ownedTask) {
        this._activeRestoreTask = null;
        this._activeRestoreAbort = null;
      }
    };
    ownedTask.then(releaseOwnership, releaseOwnership);
    return ownedTask;
  }

  /**
   * Create a `.cellucid-session` bundle Blob.
   * @returns {Promise<Blob>}
   */
  createSessionBundle() {
    return this._runExclusiveStateOperation(
      () => this._createSessionBundle()
    );
  }

  async _createSessionBundle() {
    return this._runSettlementLease(
      this._captureSettlement,
      'Session capture settlement',
      () => this._captureSessionBundlePayload()
    );
  }

  async _captureSessionBundlePayload() {
    const ctx = buildSessionContext(this._base, {
      abortSignal: null,
      restoreTransaction: null
    });
    const datasetOwner = captureSessionDatasetOwner(ctx);

    /** @type {SessionChunk[]} */
    const emittedChunks = [];
    const emittedChunkIds = new Set();
    for (const contributor of this._contributors) {
      assertSessionDatasetOwner(ctx, datasetOwner);
      const produced = await contributor.capture(ctx);
      assertSessionDatasetOwner(ctx, datasetOwner);
      if (!Array.isArray(produced)) {
        throw new TypeError(
          `Session contributor "${contributor.id}" capture() must return an array`
        );
      }
      for (const chunk of produced) {
        emittedChunks.push(
          assertCapturedChunk(chunk, contributor.id, emittedChunkIds)
        );
      }
    }

    // Writer invariant: all eager chunks must appear before any lazy chunks.
    // Preserve contributor-relative ordering within each priority bucket.
    /** @type {SessionChunk[]} */
    const eagerChunks = [];
    /** @type {SessionChunk[]} */
    const lazyChunks = [];
    for (const chunk of emittedChunks) {
      if (chunk.priority === 'lazy') lazyChunks.push(chunk);
      else eagerChunks.push(chunk);
    }
    const orderedChunks = [...eagerChunks, ...lazyChunks];

    // Encode and (optionally) gzip each chunk payload into stored bytes.
    /** @type {any[]} */
    const manifestChunks = [];
    /** @type {Uint8Array[]} */
    const storedChunks = [];

    for (const chunk of orderedChunks) {
      // Serialize payload to bytes.
      const uncompressedBytes =
        chunk.kind === 'json'
          ? encodeJsonBytes(chunk.payload)
          : chunk.payload;
      if (uncompressedBytes.byteLength > MAX_UNCOMPRESSED_CHUNK_BYTES) {
        throw new RangeError(
          `Session chunk "${chunk.id}" exceeds the uncompressed byte limit.`
        );
      }

      // Apply codec.
      const storedBytes = chunk.codec === 'gzip'
        ? await gzipCompress(uncompressedBytes, { signal: null })
        : uncompressedBytes;
      if (storedBytes.byteLength > MAX_STORED_CHUNK_BYTES) {
        throw new RangeError(
          `Session chunk "${chunk.id}" exceeds the stored byte limit.`
        );
      }

      storedChunks.push(storedBytes);

      manifestChunks.push({
        id: chunk.id,
        contributorId: chunk.contributorId,
        priority: chunk.priority,
        kind: chunk.kind,
        codec: chunk.codec,
        label: chunk.label,
        datasetDependent: chunk.datasetDependent,
        storedBytes: storedBytes.byteLength,
        uncompressedBytes: uncompressedBytes.byteLength
      });
    }

    const manifest = {
      createdAt: new Date().toISOString(),
      datasetFingerprint: datasetOwner.fingerprint,
      chunks: manifestChunks
    };

    validateManifest(manifest, this._contributorById, null);
    return writeBundle({ manifest, chunks: storedChunks });
  }

  /**
   * Download a `.cellucid-session` bundle.
   * @param {string} filename
   */
  async downloadSession(filename) {
    assertNonEmptyString(filename, 'Session download filename');
    const blob = await this.createSessionBundle();
    downloadBlob(blob, filename);
  }

  /**
   * Show a file picker and progressively restore a session bundle.
   *
   * Resolves only after every selected session chunk has been restored.
   *
   * @returns {Promise<boolean>} True if a file was selected and restore started.
   */
  async loadSessionFromFile() {
    const file = await this._pickSessionFile();
    if (file === null) return false;
    try {
      await this.restoreFromBlob(file);
      return true;
    } catch (error) {
      if (
        isSessionRestoreCanceledError(error)
        || isSessionRestoreSupersededError(error)
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Restore a session from a Blob/File.
   * Resolves only after every selected session chunk has been restored.
   *
   * @param {Blob} blob
   * @returns {Promise<void>}
   */
  async restoreFromBlob(blob) {
    if (!(blob instanceof Blob)) {
      throw new TypeError('Session restore source must be a Blob or File.');
    }
    const totalBytes = assertSafeInteger(
      blob.size,
      'Session restore Blob size'
    );
    await this._runOwnedRestore(
      (abortController) => this._restoreFromBundleSource(blob, {
        totalBytes,
        notifications: null,
        downloadId: null,
        abortController,
        manifestProfile: null,
        refreshUi: null
      }),
      { signal: null }
    );
  }

  /**
   * Restore the one official static default published with a dataset.
   *
   * This path is deliberately distinct from arbitrary user session restore:
   * the transport is bounded and its manifest must match the exact static
   * profile before any contributor can mutate application state.
   *
   * @param {Blob} blob
   * @param {{ signal: AbortSignal, refreshUi: (options: {phase: 'commit'|'rollback'}) => Promise<void>|void }} options
   * @returns {Promise<void>}
   */
  async restorePublishedDefaultState(blob, options) {
    if (!(blob instanceof Blob)) {
      throw new TypeError(
        'Published default session restore source must be a Blob.'
      );
    }
    assertExactKeys(
      options,
      ['signal', 'refreshUi'],
      'Published default session restore options'
    );
    const callerSignal = assertAbortSignal(
      options.signal,
      'Published default session restore signal'
    );
    throwIfAborted(callerSignal);
    if (typeof options.refreshUi !== 'function') {
      throw new TypeError(
        'Published default session restore refreshUi must be a function.'
      );
    }
    const totalBytes = assertSafeInteger(
      blob.size,
      'Published default session Blob size'
    );
    if (totalBytes > MAX_PUBLISHED_DEFAULT_STATE_BYTES) {
      throw new RangeError(
        'Published default session exceeds the 32 KiB byte limit.'
      );
    }

    await this._runOwnedRestore(
      (abortController) => this._restoreFromBundleSource(blob, {
        totalBytes,
        notifications: null,
        downloadId: null,
        abortController,
        manifestProfile: 'published-default',
        refreshUi: options.refreshUi
      }),
      { signal: callerSignal }
    );
  }

  /**
   * Restore a session from a URL (fetch + streaming decode).
   * Resolves only after every selected session chunk has been restored.
   *
   * @param {string} url
   * @param {{ cache: RequestCache }} options
   * @returns {Promise<void>}
   */
  async restoreFromUrl(url, options) {
    const target = assertNonEmptyString(url, 'Session restore URL');
    assertExactKeys(options, ['cache'], 'Session URL restore options');
    const cacheModes = new Set([
      'default',
      'no-store',
      'reload',
      'no-cache',
      'force-cache',
      'only-if-cached'
    ]);
    if (!cacheModes.has(options.cache)) {
      throw new TypeError('Session URL restore cache mode is invalid.');
    }

    await this._runOwnedRestore(async (abortController) => {
      const ctx = buildSessionContext(this._base, {
        abortSignal: abortController.signal,
        restoreTransaction: null
      });
      const notifications = assertNotifications(ctx.notifications);

      const downloadId = assertNonEmptyString(
        notifications.startDownload('Loading session', null, {
          onCancel: () => abortController.abort(
            createSessionRestoreCanceledError()
          )
        }),
        'Session download notification id'
      );
      let delegatedToRestore = false;

      try {
        const fetchFn = requireMethod(
          ctx.dataSourceManager,
          'fetch',
          'Session URL restore data source manager'
        ).bind(ctx.dataSourceManager);
        const res = await fetchFn(target, {
          signal: abortController.signal,
          cache: options.cache
        });
        assertOwner(res, 'Session URL response');
        if (res.ok !== true) {
          assertSafeInteger(res.status, 'Session URL response status', {
            minimum: 100,
            maximum: 599
          });
          if (typeof res.statusText !== 'string') {
            throw new TypeError(
              'Session URL response statusText must be a string.'
            );
          }
          throw new Error(
            `Failed to fetch session (${res.status}): ${res.statusText}`
          );
        }
        if (
          res.body === null
          || typeof res.body !== 'object'
          || typeof res.body.getReader !== 'function'
        ) {
          throw new Error(
            'restoreFromUrl: fetch response has no readable body stream.'
          );
        }

        const source = {
          stream: () => res.body
        };
        delegatedToRestore = true;
        await this._restoreFromBundleSource(source, {
          totalBytes: null,
          notifications,
          downloadId,
          abortController,
          manifestProfile: null,
          refreshUi: null
        });
      } catch (err) {
        if (!delegatedToRestore) {
          if (isExpectedRestoreDismissal(err, abortController.signal)) {
            notifications.dismissDownload(downloadId);
          } else if (err instanceof Error && err.name === 'AbortError') {
            notifications.failDownload(
              downloadId,
              'Session restore canceled.'
            );
          } else {
            notifications.failDownload(downloadId, failureMessage(err));
          }
        }
        throw err;
      }
    }, { signal: null });
  }

  /**
   * Shared restore implementation for any bundle source (Blob/File or a
   * Blob-like `{ size, stream() }` object).
   *
   * @param {any} source
   * @param {{ totalBytes: number|null, notifications: object|null, downloadId: string|null, abortController: AbortController, manifestProfile: 'published-default'|null, refreshUi: (() => Promise<void>|void)|null }} options
   * @returns {Promise<void>}
   */
  async _restoreFromBundleSource(source, options) {
    assertExactKeys(
      options,
      [
        'totalBytes',
        'notifications',
        'downloadId',
        'abortController',
        'manifestProfile',
        'refreshUi'
      ],
      'Session restore options'
    );
    const totalBytes = options.totalBytes === null
      ? null
      : assertSafeInteger(options.totalBytes, 'Session restore totalBytes');
    const providedNotifications = options.notifications === null
      ? null
      : assertNotifications(options.notifications);
    const providedDownloadId = options.downloadId === null
      ? null
      : assertNonEmptyString(options.downloadId, 'Session download notification id');
    const abortController = assertAbortController(
      options.abortController,
      'Session restore AbortController'
    );
    if (
      options.manifestProfile !== null
      && options.manifestProfile !== 'published-default'
    ) {
      throw new TypeError('Session restore manifest profile is invalid.');
    }
    const manifestProfile = options.manifestProfile;
    const refreshUi = options.refreshUi === null
      ? null
      : options.refreshUi;
    if (
      (manifestProfile === 'published-default')
      !== (typeof refreshUi === 'function')
    ) {
      throw new TypeError(
        'Published default restore requires exactly one refreshUi function.'
      );
    }

    const restoreTransaction = createSessionRestoreTransaction();
    if (refreshUi !== null) {
      restoreTransaction.register(
        'published-default/ui-rollback-refresh',
        {
          value: null,
          prepare() {},
          commit() {},
          rollback() {
            return refreshUi({ phase: 'rollback' });
          }
        }
      );
    }
    const restoreSnapshots = new Map();
    registerSessionRestoreSnapshots(
      restoreTransaction,
      restoreSnapshots
    );
    const ctx = buildSessionContext(this._base, {
      abortSignal: abortController.signal,
      restoreTransaction
    });
    const notifications = providedNotifications === null
      ? assertNotifications(ctx.notifications)
      : providedNotifications;

    // Progress UI: treat the session file as a "download" so we can reuse the
    // existing progress + speed UI in NotificationCenter.
    const downloadId = providedDownloadId === null
      ? assertNonEmptyString(
        notifications.startDownload('Loading session', totalBytes, {
          onCancel: () => abortController.abort(
            createSessionRestoreCanceledError()
          )
        }),
        'Session download notification id'
      )
      : providedDownloadId;

    try {
      const { manifest, chunkStream } = await readBundle(source, {
        signal: abortController.signal,
        onProgress: (loaded) =>
          notifications.updateDownload(downloadId, loaded, totalBytes)
      });

      if (manifestProfile === 'published-default') {
        validatePublishedDefaultManifest(manifest);
      }
      validateManifest(
        manifest,
        this._contributorById,
        manifestProfile
      );

      const currentFp = getDatasetFingerprint(ctx);
      const fileFp = manifest.datasetFingerprint;
      const mismatch = describeDatasetFingerprintMismatch(fileFp, currentFp);
      if (mismatch !== null) {
        throw new RangeError(mismatch);
      }
      const capturedSnapshots = await captureRestoreSnapshots(
        ctx,
        this._contributorById,
        manifest,
        manifestProfile
      );
      throwIfAborted(abortController.signal);
      for (const [chunkId, payload] of capturedSnapshots) {
        restoreSnapshots.set(chunkId, payload);
      }
      // Phase split: apply eager chunks now, then continue lazy in the background.
      const iterator = chunkStream[Symbol.asyncIterator]();

      // Helper that decodes a chunk payload and dispatches to its contributor.
      const applyChunk = async (meta, storedBytes) => {
        throwIfAborted(abortController.signal);
        assertPlainRecord(meta, 'Session restore chunk metadata');
        if (!(storedBytes instanceof Uint8Array)) {
          throw new TypeError('Session restore chunk bytes must be a Uint8Array.');
        }

        const contributor = this._contributorById.get(meta.contributorId);
        if (contributor === undefined) {
          throw new Error(
            `Session contributor "${meta.contributorId}" is not registered ` +
            `for chunk "${meta.id}"`
          );
        }

        let decodedBytes;
        if (meta.codec === 'gzip') {
          decodedBytes = await gzipDecompress(storedBytes, {
            maxOutputBytes: meta.uncompressedBytes,
            signal: abortController.signal
          });
        } else {
          decodedBytes = storedBytes;
        }
        if (decodedBytes.byteLength !== meta.uncompressedBytes) {
          throw new Error(
            `Session chunk "${meta.id}" uncompressed byte length does not match its manifest.`
          );
        }

        // Decode kind.
        const payload = meta.kind === 'json' ? decodeJsonBytes(decodedBytes) : decodedBytes;

        await contributor.restore(ctx, meta, payload);
      };

      // EAGER stage: process until the first lazy chunk (or EOF).
      let firstLazy = null;
      while (true) {
        throwIfAborted(abortController.signal);
        const { value, done } = await iterator.next();
        if (done) break;
        assertExactKeys(
          value,
          ['index', 'meta', 'bytes'],
          'Session streamed chunk'
        );
        assertSafeInteger(value.index, 'Session streamed chunk index');
        if (value.meta.priority === 'lazy') {
          firstLazy = value;
          break;
        }
        await applyChunk(value.meta, value.bytes);
      }

      // Apply the lazy stage in the same public restore operation. Yielding
      // between chunks keeps the browser responsive without creating a second
      // failure channel after restoreFromBlob()/restoreFromUrl() has resolved.
      if (firstLazy) {
        const lazyTask = (async () => {
          await applyChunk(firstLazy.meta, firstLazy.bytes);
          while (true) {
            throwIfAborted(abortController.signal);
            const { value, done } = await iterator.next();
            if (done) break;
            await nextTick();
            assertExactKeys(
              value,
              ['index', 'meta', 'bytes'],
              'Session streamed chunk'
            );
            assertSafeInteger(value.index, 'Session streamed chunk index');
            await applyChunk(value.meta, value.bytes);
          }
        })();
        this._activeLazyTask = lazyTask;
        try {
          await lazyTask;
        } finally {
          if (this._activeLazyTask === lazyTask) {
            this._activeLazyTask = null;
          }
        }
      } else {
        this._activeLazyTask = null;
      }

      if (refreshUi !== null) {
        restoreTransaction.register(
          'published-default/ui-commit-refresh',
          {
            value: null,
            prepare() {},
            commit() {
              return refreshUi({ phase: 'commit' });
            },
            rollback() {}
          }
        );
      }
      await restoreTransaction.commit();
      notifications.info('Session fully restored.', {
        category: 'session',
        duration: 2200
      });
      notifications.completeDownload(downloadId, 'Session fully restored.');
    } catch (err) {
      try {
        await restoreTransaction.rollback();
      } catch (rollbackError) {
        preserveRestoreRollbackFailure(err, rollbackError);
      }
      const isAbortFailure =
        err instanceof Error && err.name === 'AbortError';
      const isSilentReplacement =
        isExpectedRestoreDismissal(err, abortController.signal)
        || (
          manifestProfile === 'published-default'
          && isAbortFailure
          && abortController.signal.aborted
        );
      if (isSilentReplacement) {
        notifications.dismissDownload(downloadId);
      } else if (isAbortFailure) {
        notifications.failDownload(downloadId, 'Session restore canceled.');
      } else {
        notifications.failDownload(downloadId, failureMessage(err));
      }
      throw err;
    }
  }

  /**
   * Open a file picker for `.cellucid-session` files.
   * @returns {Promise<File|null>}
   */
  async _pickSessionFile() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = false;
      input.accept = '.cellucid-session,application/octet-stream';
      input.style.position = 'fixed';
      input.style.left = '-10000px';
      input.style.top = '0';
      input.style.opacity = '0';
      document.body.appendChild(input);

      let settled = false;
      const cleanup = () => {
        input.remove();
      };

      const settle = (file, error = null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error !== null) reject(error);
        else resolve(file);
      };

      input.addEventListener('change', () => {
        if (input.files === null) {
          settle(null, new TypeError('Session file input did not publish a FileList.'));
          return;
        }
        if (input.files.length > 1) {
          settle(null, new TypeError('Session file input published more than one file.'));
          return;
        }
        settle(input.files.length === 1 ? input.files[0] : null);
      }, { once: true });

      input.addEventListener('cancel', () => settle(null), { once: true });

      input.click();
    });
  }
}
