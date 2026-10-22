/**
 * @fileoverview Session serializer context construction helpers.
 *
 * Contributors receive a small `ctx` object so they can capture/restore
 * feature-owned state without the orchestrator knowing any feature internals.
 *
 * @module session/session-context
 */

import { getNotificationCenter } from '../notification-center.js';
import { getDockableAccordions } from '../dockable-accordions-registry.js';
import {
  assertExactKeys,
  assertNonEmptyString,
  assertNullableString,
  assertPlainRecord,
  assertSafeInteger,
  requireMethod
} from './schema-contract.js';
import {
  ANNDATA_KIND,
  compareEmbeddingRefs,
  validateDataMapping,
  validateEmbeddingRef
} from '../../data/data-mapping.js';
import {
  describeEmbeddingRef,
  layoutEmbeddingRef,
  describeMappingGroupValue,
  MAPPING_GROUP_LABELS,
  resolveEmbeddingRefLayout,
  UNCHANGEABLE_GROUP_CLAUSE,
} from '../../data/dataset-mapping.js';
import { MappingLoadError } from '../../data/data-mapping-candidates.js';

const PARTICIPANT_KEYS = ['value', 'prepare', 'commit', 'rollback'];
const PRESENTATION_PARTICIPANT_KEYS = [...PARTICIPANT_KEYS, 'stage'];

/**
 * A participant commits either restored state (the default) or a presentation
 * of it. Presentation participants, such as reopened analysis windows, read
 * what the state participants publish, so every state commit runs first,
 * whatever order the bundle's chunks registered them in.
 */
function assertRestoreParticipant(participant, context) {
  const presentation = (
    participant !== null
    && typeof participant === 'object'
    && Object.hasOwn(participant, 'stage')
  );
  assertExactKeys(
    participant,
    presentation ? PRESENTATION_PARTICIPANT_KEYS : PARTICIPANT_KEYS,
    context
  );
  if (presentation && participant.stage !== 'presentation') {
    throw new TypeError(`${context} stage must be exactly "presentation".`);
  }
  requireMethod(participant, 'prepare', context);
  requireMethod(participant, 'commit', context);
  requireMethod(participant, 'rollback', context);
  return participant;
}

function isPresentationParticipant(participant) {
  return Object.hasOwn(participant, 'stage');
}

function preserveRollbackFailure(error, rollbackError) {
  if (error instanceof Error && error.cause === undefined) {
    error.cause = rollbackError;
  }
}

const RESTORE_SNAPSHOTS_PARTICIPANT_ID =
  'session/restore-snapshots';

function isPromiseLike(value) {
  return (
    value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function'
  );
}

/**
 * Create the exact transaction shared by contributors during one restore.
 *
 * Contributors stage feature state under a unique id. The serializer prepares
 * and commits every participant only after the complete bundle stream has been
 * consumed. Any restore or commit failure rolls registered participants back.
 *
 * @returns {{
 *   register: (id: string, participant: object) => void,
 *   get: (id: string) => any,
 *   commit: () => Promise<void>|void,
 *   rollback: () => Promise<void>|void
 * }}
 */
export function createSessionRestoreTransaction() {
  const participants = new Map();
  let phase = 'open';
  let rollbackTask = null;

  function requireOpen(operation) {
    if (phase !== 'open') {
      throw new Error(
        `Session restore transaction cannot ${operation} while ${phase}.`
      );
    }
  }

  function finishRollback(rollbackErrors) {
    phase = 'rolled-back';
    rollbackTask = null;
    if (rollbackErrors.length === 1) throw rollbackErrors[0];
    if (rollbackErrors.length > 1) {
      throw new AggregateError(
        rollbackErrors,
        'Multiple session restore participants failed to roll back.'
      );
    }
  }

  function rollbackParticipants() {
    if (phase === 'rolled-back') return;
    if (phase === 'rolling-back') {
      return rollbackTask;
    }
    phase = 'rolling-back';
    const rollbackErrors = [];
    const entries = [...participants.values()];
    let pending = null;
    for (let index = entries.length - 1; index >= 0; index--) {
      const participant = entries[index];
      const invokeRollback = () => {
        try {
          const result = participant.rollback();
          if (isPromiseLike(result)) {
            return Promise.resolve(result).catch(error => {
              rollbackErrors.push(error);
            });
          }
          return undefined;
        } catch (error) {
          rollbackErrors.push(error);
          return undefined;
        }
      };
      if (pending === null) {
        const result = invokeRollback();
        if (isPromiseLike(result)) pending = result;
      } else {
        pending = pending.then(invokeRollback);
      }
    }
    if (pending === null) {
      finishRollback(rollbackErrors);
      return;
    }
    rollbackTask = pending.then(() => finishRollback(rollbackErrors));
    return rollbackTask;
  }

  function runParticipantMethod(entries, methodName) {
    for (let index = 0; index < entries.length; index++) {
      const result = entries[index][methodName]();
      if (!isPromiseLike(result)) continue;
      return (async () => {
        await result;
        for (
          let remainingIndex = index + 1;
          remainingIndex < entries.length;
          remainingIndex++
        ) {
          await entries[remainingIndex][methodName]();
        }
      })();
    }
    return undefined;
  }

  function failCommit(error) {
    let rollbackResult;
    try {
      rollbackResult = rollbackParticipants();
    } catch (rollbackError) {
      preserveRollbackFailure(error, rollbackError);
      throw error;
    }
    if (!isPromiseLike(rollbackResult)) throw error;
    return Promise.resolve(rollbackResult).then(
      () => {
        throw error;
      },
      rollbackError => {
        preserveRollbackFailure(error, rollbackError);
        throw error;
      }
    );
  }

  return Object.freeze({
    register(participantId, participant) {
      requireOpen('register a participant');
      const exactId = assertNonEmptyString(
        participantId,
        'Session restore participant id'
      );
      if (participants.has(exactId)) {
        throw new TypeError(
          `Session restore participant "${exactId}" is already registered.`
        );
      }
      participants.set(
        exactId,
        assertRestoreParticipant(
          participant,
          `Session restore participant "${exactId}"`
        )
      );
    },

    get(participantId) {
      requireOpen('read a participant');
      const exactId = assertNonEmptyString(
        participantId,
        'Session restore participant id'
      );
      const participant = participants.get(exactId);
      if (participant === undefined) {
        throw new RangeError(
          `Session restore participant "${exactId}" is not registered.`
        );
      }
      return participant.value;
    },

    commit() {
      requireOpen('commit');
      const entries = [...participants.values()];
      const commitEntries = [
        ...entries.filter(participant => !isPresentationParticipant(participant)),
        ...entries.filter(isPresentationParticipant)
      ];

      const commitPreparedParticipants = () => {
        phase = 'committing';
        const commitResult = runParticipantMethod(commitEntries, 'commit');
        if (!isPromiseLike(commitResult)) {
          phase = 'committed';
          return undefined;
        }
        return Promise.resolve(commitResult).then(() => {
          phase = 'committed';
        });
      };

      try {
        phase = 'preparing';
        const prepareResult = runParticipantMethod(entries, 'prepare');
        if (isPromiseLike(prepareResult)) {
          return Promise.resolve(prepareResult)
            .then(commitPreparedParticipants)
            .catch(error => failCommit(error));
        }
        const commitResult = commitPreparedParticipants();
        if (isPromiseLike(commitResult)) {
          return Promise.resolve(commitResult)
            .catch(error => failCommit(error));
        }
      } catch (error) {
        return failCommit(error);
      }
    },

    rollback() {
      return rollbackParticipants();
    }
  });
}

/**
 * Register the immutable pre-restore payload inventory used by reversible
 * contributors. The serializer owns population before contributor dispatch.
 *
 * @param {object} restoreTransaction
 * @param {Map<string, any>} snapshots
 */
export function registerSessionRestoreSnapshots(
  restoreTransaction,
  snapshots
) {
  if (
    restoreTransaction === null
    || typeof restoreTransaction !== 'object'
  ) {
    throw new TypeError(
      'Session restore snapshots require the current restore transaction.'
    );
  }
  requireMethod(
    restoreTransaction,
    'register',
    'Session restore snapshot transaction'
  );
  if (!(snapshots instanceof Map)) {
    throw new TypeError('Session restore snapshots must be a Map.');
  }
  restoreTransaction.register(
    RESTORE_SNAPSHOTS_PARTICIPANT_ID,
    {
      value: snapshots,
      prepare() {},
      commit() {},
      rollback() {}
    }
  );
}

/**
 * Read one pre-restore JSON payload when the serializer captured it.
 * Direct contributor unit calls may omit the shared snapshot participant.
 *
 * @param {object} ctx
 * @param {string} chunkId
 * @returns {any|undefined}
 */
export function getSessionRestoreSnapshot(ctx, chunkId) {
  const exactChunkId = assertNonEmptyString(
    chunkId,
    'Session restore snapshot chunk id'
  );
  const restoreTransaction = ctx?.restoreTransaction;
  if (
    restoreTransaction === null
    || typeof restoreTransaction !== 'object'
  ) {
    return undefined;
  }
  requireMethod(
    restoreTransaction,
    'get',
    'Session restore snapshot transaction'
  );
  let snapshots;
  try {
    snapshots = restoreTransaction.get(
      RESTORE_SNAPSHOTS_PARTICIPANT_ID
    );
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
  if (!(snapshots instanceof Map)) {
    throw new TypeError(
      'Session restore snapshot participant must own a Map.'
    );
  }
  return snapshots.get(exactChunkId);
}

function assertRestoreTransaction(value) {
  if (value === null) return value;
  assertExactKeys(
    value,
    ['register', 'get', 'commit', 'rollback'],
    'Session restore transaction'
  );
  for (const methodName of ['register', 'get', 'commit', 'rollback']) {
    requireMethod(value, methodName, 'Session restore transaction');
  }
  return value;
}

/**
 * @typedef {object} SessionContextBase
 * @property {import('../state/core/data-state.js').DataState} state
 * @property {object} viewer
 * @property {HTMLElement|null} sidebar
 * @property {import('../../data/data-source-manager.js').DataSourceManager|null} dataSourceManager
 * @property {any|null} comparisonModule
 * @property {any|null} analysisWindowManager
 * @property {any|null} cinematicCamera
 */

/**
 * Build the context passed to all contributors.
 *
 * @param {SessionContextBase} base
 * @param {{
 *   abortSignal: AbortSignal | null,
 *   restoreTransaction: object | null
 * }} options
 * @returns {object}
 */
export function buildSessionContext(base, options) {
  assertExactKeys(
    base,
    [
      'state',
      'viewer',
      'sidebar',
      'dataSourceManager',
      'comparisonModule',
      'analysisWindowManager',
      'cinematicCamera'
    ],
    'Session context base'
  );
  assertExactKeys(
    options,
    ['abortSignal', 'restoreTransaction'],
    'Session context options'
  );
  if (base.state === null || typeof base.state !== 'object') {
    throw new TypeError('Session context requires the current DataState owner.');
  }
  if (base.viewer === null || typeof base.viewer !== 'object') {
    throw new TypeError('Session context requires the current viewer owner.');
  }
  if (
    base.sidebar === null
    || typeof base.sidebar !== 'object'
  ) {
    throw new TypeError('Session context requires the explicitly supplied current sidebar.');
  }
  if (
    base.dataSourceManager !== null
    && typeof base.dataSourceManager !== 'object'
  ) {
    throw new TypeError('Session context dataSourceManager must be an object or null.');
  }
  if (
    options.abortSignal !== null
    && (
      typeof options.abortSignal !== 'object'
      || typeof options.abortSignal.aborted !== 'boolean'
    )
  ) {
    throw new TypeError('Session context abortSignal must be an AbortSignal or null.');
  }
  const restoreTransaction = assertRestoreTransaction(
    options.restoreTransaction
  );

  return {
    state: base.state,
    viewer: base.viewer,
    sidebar: base.sidebar,
    dataSourceManager: base.dataSourceManager,
    dockableAccordions: getDockableAccordions(),
    comparisonModule: base.comparisonModule,
    analysisWindowManager: base.analysisWindowManager,
    cinematicCamera: base.cinematicCamera,
    notifications: getNotificationCenter(),
    abortSignal: options.abortSignal,
    restoreTransaction
  };
}

/**
 * Keys a `.cellucid-session` file written before cell-order identity existed.
 * Such a file records selections as raw dataset row indices with nothing that
 * ties those rows to cell content, so it can never be verified.
 */
const CELL_ORDER_UNVERIFIABLE_KEYS = Object.freeze([
  'sourceType',
  'datasetId',
  'cellCount',
  'varCount'
]);

const DATASET_FINGERPRINT_KEYS = Object.freeze([
  ...CELL_ORDER_UNVERIFIABLE_KEYS,
  'cellOrder',
  'dataMapping'
]);

/**
 * Surfaced verbatim to the user by the session controls, for a file whose
 * fingerprint records a cell order but no data mapping.
 */
export const SESSION_WITHOUT_DATA_MAPPING_MESSAGE =
  'This session file was saved by an earlier Cellucid release, before sessions '
  + 'recorded which stored embeddings and arrays a dataset is shown with, and '
  + 'that release read an export format this one no longer opens. The session '
  + 'was not opened. Re-create the view on the current dataset and save a new '
  + 'session file.';

/**
 * Surfaced verbatim to the user by the session controls.
 */
export const SESSION_WITHOUT_CELL_IDENTITY_MESSAGE =
  'This session file was saved before Cellucid started recording which cells a '
  + 'selection contains, so there is no way to confirm that its selections '
  + 'still mark the same cells in the dataset that is open now. The session was '
  + 'not opened. Re-create the selections on this dataset and save a new '
  + 'session file.';

/**
 * Digest of every cell coordinate in dataset row order.
 *
 * The fingerprint scalars (source, dataset id, cell count, gene count) are all
 * preserved when a dataset is re-exported at the same id from re-sorted input,
 * so they cannot tell one row order from another. Positions are the only
 * per-cell payload the viewer always holds in memory, and a re-ordered export
 * permutes them, so digesting them in row order is what makes a restored
 * selection provably denote the cells it was drawn around.
 *
 * Two independent 32-bit accumulators are folded over the coordinate words and
 * emitted as one 64-bit hex value. Both are updated with a multiply and a
 * rotation per word, so the digest depends on the order of the words, not only
 * on their multiset. Measured on 842k cells (9.64 MiB of Float32 coordinates):
 * 4.3 ms for the digest, 5.6 ms for the complete fingerprint.
 *
 * The digest is defined over XYZ triples. The viewer holds a 1-D or 2-D
 * embedding with only its own components per cell (see
 * `rendering/position-layout.js`), so the axes it does not have are folded in
 * as the zero word they are — `+0.0` is the all-zero bit pattern — without
 * materializing a padded copy. A digest therefore does not depend on how the
 * coordinates are laid out in memory, and every published preset and saved
 * session keeps matching.
 *
 * A matching digest therefore proves the coordinates are the same ones in the
 * same order. A differing digest proves only that they are not: it cannot
 * separate permuted rows from re-computed coordinates, which is why
 * `describeDatasetFingerprintMismatch()` names both.
 *
 * The result is memoized against the coordinate array itself. The array is
 * replaced, never rewritten, when the dataset or the displayed embedding
 * changes, so the capture guard can re-derive the fingerprint once per
 * contributor for 0.06 ms in total instead of re-reading 9.64 MiB nine times.
 *
 * @type {WeakMap<Float32Array, string>}
 */
const CELL_ORDER_DIGESTS = new WeakMap();

/**
 * Exported for the publishing step in `cellucid-datasets`, which recomputes a
 * generation's digest from the coordinates it ships to prove a capture belongs
 * to it. That check has to run the function the application runs, not a
 * transcription of it: a transcription that drifted would approve exactly the
 * presets the reader then refuses.
 *
 * @param {Float32Array} positions - `dimension` components per cell.
 * @param {1|2|3} [dimension=3]
 * @returns {string} 16 lowercase hexadecimal characters.
 */
export function digestCellOrder(positions, dimension = 3) {
  if (dimension !== 1 && dimension !== 2 && dimension !== 3) {
    throw new RangeError('Cell-order digest dimension must be exactly 1, 2, or 3.');
  }
  if (
    !(positions instanceof Float32Array)
    || positions.length % dimension !== 0
  ) {
    throw new TypeError(
      `Cell-order digest requires a Float32Array with ${dimension} values per cell.`
    );
  }
  const memoized = CELL_ORDER_DIGESTS.get(positions);
  if (memoized !== undefined) return memoized;
  // A Float32Array is always 4-byte aligned, so its buffer can be read as
  // 32-bit words without copying.
  const words = new Uint32Array(
    positions.buffer,
    positions.byteOffset,
    positions.length
  );
  const cellCount = positions.length / dimension;
  const wordCount = cellCount * 3;
  let low = 0x9e3779b1 ^ wordCount;
  let high = 0x85ebca6b ^ wordCount;
  // One fold step per XYZ word, in cell order. The axes a 1D or 2D
  // embedding lacks fold the zero word: `word ^ 0` is the accumulator itself.
  // A 3D array already holds exactly that word sequence.
  if (dimension === 3) {
    for (let index = 0; index < words.length; index++) {
      const word = words[index];
      low = Math.imul(low ^ word, 0x85ebca77);
      high = Math.imul(high ^ word, 0xc2b2ae3d);
      low = (low << 13) | (low >>> 19);
      high = (high << 17) | (high >>> 15);
    }
  } else {
    // Each cell folds its `dimension` words, then 3 - dimension zero words.
    const zeroWords = 3 - dimension;
    for (let index = 0; index < words.length; index++) {
      const word = words[index];
      low = Math.imul(low ^ word, 0x85ebca77);
      high = Math.imul(high ^ word, 0xc2b2ae3d);
      low = (low << 13) | (low >>> 19);
      high = (high << 17) | (high >>> 15);
      if (dimension === 1 || (index & 1) === 1) {
        low = Math.imul(low, 0x85ebca77);
        high = Math.imul(high, 0xc2b2ae3d);
        low = (low << 13) | (low >>> 19);
        high = (high << 17) | (high >>> 15);
        if (zeroWords === 2) {
          low = Math.imul(low, 0x85ebca77);
          high = Math.imul(high, 0xc2b2ae3d);
          low = (low << 13) | (low >>> 19);
          high = (high << 17) | (high >>> 15);
        }
      }
    }
  }
  low = Math.imul(low ^ (low >>> 16), 0x2c1b3c6d)
    ^ Math.imul(high ^ (high >>> 13), 0x297a2d39);
  high = Math.imul(high ^ (high >>> 16), 0x2c1b3c6d)
    ^ Math.imul(low ^ (low >>> 13), 0x297a2d39);
  const digest = (high >>> 0).toString(16).padStart(8, '0')
    + (low >>> 0).toString(16).padStart(8, '0');
  CELL_ORDER_DIGESTS.set(positions, digest);
  return digest;
}

function assertCellOrder(value, kind, context) {
  assertExactKeys(value, ['embedding', 'dimension', 'digest'], context);
  const dimension = assertSafeInteger(
    value.dimension,
    `${context} dimension`,
    { minimum: 1, maximum: 3 }
  );
  const digest = assertNonEmptyString(value.digest, `${context} digest`);
  if (!/^[0-9a-f]{16}$/.test(digest)) {
    throw new TypeError(
      `${context} digest must be 16 lowercase hexadecimal characters.`
    );
  }
  try {
    validateEmbeddingRef(value.embedding, {
      kind,
      dimension: kind === ANNDATA_KIND ? dimension : null,
      label: `${context} embedding`,
    });
  } catch (error) {
    throw new TypeError(error.message, { cause: error });
  }
  return value;
}

function hasExactKeySet(value, keys) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
  );
}

function isPreMappingRecord(value) {
  return hasExactKeySet(value, [...CELL_ORDER_UNVERIFIABLE_KEYS, 'cellOrder']);
}

/**
 * Validate one complete dataset fingerprint record from untrusted input.
 *
 * A record written by an earlier release — before cell-order identity, or
 * before data mappings — is refused with the message the user is shown; a
 * record that is malformed in any other way is a schema violation.
 *
 * @param {any} value
 * @param {string} context
 * @returns {object}
 */
export function assertDatasetFingerprint(value, context) {
  if (hasExactKeySet(value, CELL_ORDER_UNVERIFIABLE_KEYS)) {
    throw new RangeError(SESSION_WITHOUT_CELL_IDENTITY_MESSAGE);
  }
  if (isPreMappingRecord(value)) {
    throw new RangeError(SESSION_WITHOUT_DATA_MAPPING_MESSAGE);
  }
  assertExactKeys(value, DATASET_FINGERPRINT_KEYS, context);
  assertNullableString(value.sourceType, `${context} sourceType`);
  assertNullableString(value.datasetId, `${context} datasetId`);
  assertSafeInteger(value.cellCount, `${context} cellCount`);
  assertSafeInteger(value.varCount, `${context} varCount`);
  let mapping;
  try {
    mapping = validateDataMapping(value.dataMapping, {
      label: `${context} dataMapping`,
    });
  } catch (error) {
    throw new TypeError(error.message, { cause: error });
  }
  if (JSON.stringify(mapping) !== JSON.stringify(value.dataMapping)) {
    throw new TypeError(`${context} dataMapping must be in canonical form.`);
  }
  assertCellOrder(value.cellOrder, mapping.kind, `${context} cellOrder`);
  return value;
}

function requireCurrentDataMapping(state) {
  const mapping = requireMethod(
    state,
    'getDataMapping',
    'Dataset fingerprint DataState'
  ).call(state);
  if (mapping === null) {
    throw new TypeError('Dataset fingerprint requires the loaded data mapping.');
  }
  return mapping;
}

function currentFingerprintScalars(ctx) {
  assertPlainRecord(ctx, 'Session context');
  if (ctx.state === null || typeof ctx.state !== 'object') {
    throw new TypeError('Dataset fingerprint requires the current DataState.');
  }
  const manager = ctx.dataSourceManager;
  let sourceType = null;
  let datasetId = null;
  if (manager !== null) {
    requireMethod(manager, 'getCurrentSourceType', 'Dataset fingerprint manager');
    requireMethod(manager, 'getCurrentDatasetId', 'Dataset fingerprint manager');
    sourceType = assertNullableString(
      manager.getCurrentSourceType(),
      'Dataset fingerprint sourceType'
    );
    datasetId = assertNullableString(
      manager.getCurrentDatasetId(),
      'Dataset fingerprint datasetId'
    );
  }
  const cellCount = assertSafeInteger(
    ctx.state.pointCount,
    'Dataset fingerprint cellCount'
  );
  if (
    ctx.state.varData === null
    || typeof ctx.state.varData !== 'object'
    || !Array.isArray(ctx.state.varData.fields)
  ) {
    throw new TypeError('Dataset fingerprint requires the current var field inventory.');
  }
  // The gene count describes the dataset, so it counts only the source's own
  // var fields. User-defined fields (a duplicated gene, a derived field) are
  // session content restored from the session itself; counting them would
  // make the session refuse the very dataset it was saved on.
  let sourceVarFieldCount = 0;
  for (const field of ctx.state.varData.fields) {
    if (field?._isUserDefined !== true) sourceVarFieldCount += 1;
  }
  const varCount = assertSafeInteger(
    sourceVarFieldCount,
    'Dataset fingerprint varCount'
  );
  return { sourceType, datasetId, cellCount, varCount };
}

/**
 * Create the exact current dataset fingerprint.
 *
 * All six fields are mandatory; source identity may be explicitly null only
 * when no data-source manager owns the loaded state. The cell-order digest is
 * taken over the layout the live view shows, and `cellOrder.embedding` names
 * that layout under the dataset's data mapping.
 *
 * @param {object} ctx
 * @returns {{
 *   sourceType: string|null,
 *   datasetId: string|null,
 *   cellCount: number,
 *   varCount: number,
 *   cellOrder: { embedding: {key: string, columns: number[]|null}, dimension: number, digest: string },
 *   dataMapping: object
 * }}
 */
export function getDatasetFingerprint(ctx) {
  const scalars = currentFingerprintScalars(ctx);
  const state = ctx.state;
  const dataMapping = requireCurrentDataMapping(state);
  const positions = state.positionsArray;
  const dimension = assertSafeInteger(
    requireMethod(
      state,
      'getViewDimensionLevel',
      'Dataset fingerprint DataState'
    ).call(state, 'live'),
    'Dataset fingerprint live dimension',
    { minimum: 1, maximum: 3 }
  );
  if (
    !(positions instanceof Float32Array)
    || positions.length !== scalars.cellCount * dimension
  ) {
    throw new TypeError(
      'Dataset fingerprint requires the exact live dataset positions in the live view dimension.'
    );
  }
  const layoutKey = requireMethod(
    state,
    'getViewLayoutKey',
    'Dataset fingerprint DataState'
  ).call(state, 'live');
  const embedding = layoutEmbeddingRef(
    state.dimensionManager,
    layoutKey,
    dataMapping.kind
  );
  return {
    ...scalars,
    cellOrder: Object.freeze({
      embedding: Object.freeze(embedding),
      dimension,
      digest: digestCellOrder(positions, dimension)
    }),
    dataMapping
  };
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compare two dataset fingerprints.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
export function datasetFingerprintMatches(a, b) {
  assertDatasetFingerprint(a, 'Saved dataset fingerprint');
  assertDatasetFingerprint(b, 'Current dataset fingerprint');
  return (
    a.sourceType === b.sourceType
    && a.datasetId === b.datasetId
    && a.cellCount === b.cellCount
    && a.varCount === b.varCount
    && sameJson(a.cellOrder.embedding, b.cellOrder.embedding)
    && a.cellOrder.dimension === b.cellOrder.dimension
    && a.cellOrder.digest === b.cellOrder.digest
    && sameJson(a.dataMapping, b.dataMapping)
  );
}

/**
 * Name one side of an identity mismatch the way the person reading it would.
 *
 * Both fields are nullable, and either can be the one that differs, so this
 * says whichever is available rather than interpolating a bare `null` or
 * printing the same id on both sides of a sentence about a difference.
 *
 * @param {{sourceType: string|null, datasetId: string|null}} fingerprint
 * @returns {string}
 */
function describeDatasetIdentity(fingerprint) {
  if (typeof fingerprint.datasetId === 'string' && fingerprint.datasetId !== '') {
    return `"${fingerprint.datasetId}"`;
  }
  if (typeof fingerprint.sourceType === 'string' && fingerprint.sourceType !== '') {
    return `a dataset opened from ${fingerprint.sourceType}`;
  }
  return 'a dataset that recorded no source';
}

/**
 * The sentence naming the first way a saved data mapping cannot be restored
 * onto the open dataset, or null when it can.
 *
 * The embeddings may differ: a session restores every representation it
 * enables and its defaults, provided the dataset can plot each one
 * (`describeEmbeddingRefusal`). Every other group may differ too, provided
 * the dataset can use the saved choice (`describeChoiceRefusal`); a group the
 * dataset cannot change must be exactly the one it is shown with.
 *
 * @param {object} saved - A canonical DataMapping.
 * @param {object} current - A canonical DataMapping.
 * @param {{
 *   describeEmbeddingRefusal: (ref: {key: string, columns: number[]|null}) => string|null,
 *   describeChoiceRefusal: (group: string, value: unknown) => string|null
 * }} readers - Why the open dataset cannot show one embedding, or use one
 *   value of one group, as a clause such as "this dataset does not have" (or
 *   {@link UNCHANGEABLE_GROUP_CLAUSE}), or null when it can.
 * @returns {string|null}
 */
export function describeDataMappingMismatch(saved, current, readers) {
  if (
    typeof readers?.describeEmbeddingRefusal !== 'function' ||
    typeof readers?.describeChoiceRefusal !== 'function'
  ) {
    throw new TypeError(
      'Data mapping comparison requires an embedding and a choice refusal reader.'
    );
  }
  const { describeEmbeddingRefusal, describeChoiceRefusal } = readers;
  if (sameJson(saved, current)) return null;
  if (saved.kind !== current.kind) {
    return (
      `This session was saved on ${saved.kind === 'export' ? 'a prepared export' : 'an AnnData file'}, `
      + `and ${current.kind === 'export' ? 'a prepared export' : 'an AnnData file'} is open now. `
      + 'Open the dataset the session was saved on, then load the session again.'
    );
  }
  for (const was of saved.embeddings.enabled) {
    if (current.embeddings.enabled.some(ref => compareEmbeddingRefs(ref, was) === 0)) continue;
    const refusal = describeEmbeddingRefusal(was);
    if (refusal === null) continue;
    return (
      `This session shows ${describeEmbeddingRef(was)}, `
      + `which ${refusal}. The session was not opened.`
      + ' Open the dataset version the session was saved on, then load the session again.'
    );
  }
  for (const group of ['knn', 'geneNames', 'expression', 'latent', 'vectorFields']) {
    if (sameJson(saved[group], current[group])) continue;
    const refusal = describeChoiceRefusal(group, saved[group]);
    if (refusal === null) continue;
    if (refusal !== UNCHANGEABLE_GROUP_CLAUSE) {
      return (
        `This session uses ${describeMappingGroupValue(group, saved[group])} as its `
        + `${MAPPING_GROUP_LABELS[group]}, which ${refusal}. The session was not opened.`
        + ' Open the dataset version the session was saved on, then load the session again.'
      );
    }
    return (
      `This session was saved with ${describeMappingGroupValue(group, saved[group])} `
      + `as its ${MAPPING_GROUP_LABELS[group]}, and this dataset is shown with `
      + `${describeMappingGroupValue(group, current[group])}. The session was not opened.`
      + ' Open the dataset version the session was saved on, then load the session again.'
    );
  }
  return null;
}

/**
 * Explain a dataset fingerprint mismatch to the person loading the session,
 * from everything but the cell-order digest.
 *
 * The session controls surface this text verbatim, so each cause gets the
 * sentence that names what actually differs and what to do next. Naming a cause
 * the evidence does not establish would be its own integrity failure.
 *
 * - The counts are conclusive, and they are also the evidence the first message
 *   quotes, so that message is reserved for the case where they actually
 *   differ. Two copies of one dataset opened through different sources agree on
 *   every count, so the identity fields get their own sentence, which names the
 *   identities instead.
 *
 * @param {any} saved
 * @param {object} current - The current scalars.
 * @returns {string|null}
 */
function describeDatasetIdentityMismatch(saved, current) {
  if (
    saved.cellCount !== current.cellCount
    || saved.varCount !== current.varCount
  ) {
    return (
      'This session was saved on a different dataset than the one that is open '
      + `now (${saved.cellCount.toLocaleString('en-US')} cells and `
      + `${saved.varCount.toLocaleString('en-US')} genes when it was saved, `
      + `${current.cellCount.toLocaleString('en-US')} cells and `
      + `${current.varCount.toLocaleString('en-US')} genes now). Open the `
      + 'dataset the session was saved on, then load the session again.'
    );
  }
  // The counts are the evidence in the message above, so it can only be used
  // where they differ. A session captured on the same data through a different
  // source — the common one is a preset captured against a locally served copy
  // of a dataset the catalog also publishes — reaches here with every count
  // equal, and printing the same two numbers twice as proof of a difference
  // reads as a bug in the check rather than a fact about the file.
  if (
    saved.sourceType !== current.sourceType
    || saved.datasetId !== current.datasetId
  ) {
    return (
      'This session was saved on a different copy of this dataset. It has the '
      + `same ${saved.cellCount.toLocaleString('en-US')} cells and `
      + `${saved.varCount.toLocaleString('en-US')} genes, but it was saved on `
      + `${describeDatasetIdentity(saved)} and `
      + `${describeDatasetIdentity(current)} is open now, so Cellucid cannot `
      + 'confirm the two hold their cells in the same order. Open the dataset '
      + 'the session was saved on, then load the session again.'
    );
  }
  return null;
}

/**
 * The refusal shown when a session's cell-order digest does not match.
 *
 * `cellOrder.digest` is a one-way fold over the coordinate bytes in row order.
 * It changes when the rows are permuted and it changes when the coordinate
 * values change, and a hash cannot say which happened, so the message states
 * the one thing that is established and offers both causes.
 */
const CELL_ORDER_MISMATCH_MESSAGE =
  'This dataset is not the one this session was saved on. It has the same '
  + 'name and the same number of cells and genes, but the cell coordinates '
  + 'differ from the ones the session was saved against, so Cellucid cannot '
  + 'confirm that a saved selection still marks the same cells. Either the '
  + 'cells are stored in a different order, or the same cells were exported '
  + 'again from a re-computed embedding. The session was not opened. Load '
  + 'the version of the dataset the session was saved on, or re-create the '
  + 'selections on this one.';

/**
 * Verify a saved session fingerprint against the open dataset, without
 * changing anything the user sees.
 *
 * In order: the dataset's counts and identity, its data mapping, then the
 * cell-order digest of the very layout the session names, whose positions are
 * loaded (pinned, so no view's cache is disturbed) whichever layout the live
 * view shows now. Nothing is applied before all of them pass.
 *
 * @param {object} ctx
 * @param {any} saved - A validated `manifest.datasetFingerprint`.
 * @returns {Promise<string|null>} The refusal to show, or null when it matches.
 */
export async function verifySessionFingerprint(ctx, saved) {
  assertDatasetFingerprint(saved, 'Saved dataset fingerprint');
  const scalars = currentFingerprintScalars(ctx);
  // Choosing None leaves a runtime of zero cells and no data mapping. That is
  // no dataset at all, so quoting its zero counts as "the one that is open
  // now" would be untrue.
  if (scalars.cellCount === 0) {
    return (
      'No dataset is open. Open the dataset the session was saved on '
      + `(${describeDatasetIdentity(saved)}), then load the session again.`
    );
  }
  const dataMapping = requireCurrentDataMapping(ctx.state);
  // On an AnnData file the gene count is that of the var axis the saved
  // mapping names (raw.X has its own), read from metadata: a session saved on
  // raw restores onto a file that opened on X. A prepared export has one gene
  // axis, whatever names it shows.
  const varCount = saved.dataMapping.kind === ANNDATA_KIND && dataMapping.kind === ANNDATA_KIND
    ? requireMethod(
        ctx.state,
        'describeMappingVarCount',
        'Session restore DataState'
      ).call(ctx.state, saved.dataMapping)
    : scalars.varCount;
  const current = { ...scalars, varCount, dataMapping };
  const identity = describeDatasetIdentityMismatch(saved, current);
  if (identity !== null) return identity;
  if (!sameJson(saved.dataMapping, current.dataMapping)) {
    const mapping = describeDataMappingMismatch(
      saved.dataMapping,
      current.dataMapping,
      {
        describeEmbeddingRefusal: requireMethod(
          ctx.state,
          'describeEmbeddingRefusal',
          'Session restore DataState'
        ).bind(ctx.state),
        describeChoiceRefusal: requireMethod(
          ctx.state,
          'describeMappingChoiceRefusal',
          'Session restore DataState'
        ).bind(ctx.state),
      }
    );
    if (mapping !== null) return mapping;
  }

  const dimensionManager = ctx.state.dimensionManager;
  const layoutKey = resolveEmbeddingRefLayout(
    dimensionManager,
    saved.cellOrder.embedding,
    saved.dataMapping.kind,
    saved.cellOrder.dimension,
    'Saved cell-order embedding'
  );
  if (layoutKey === null) {
    return (
      `This session recorded its cell order on ${describeEmbeddingRef(saved.cellOrder.embedding)} `
      + `in ${saved.cellOrder.dimension}D, which this dataset does not have. `
      + 'The session was not opened.'
      + ' Open the dataset version the session was saved on, then load the session again.'
    );
  }
  const release = dimensionManager.pinLayout(layoutKey);
  let digest;
  try {
    const positions = await dimensionManager.getPositions(layoutKey, {
      showProgress: false
    });
    digest = digestCellOrder(positions, saved.cellOrder.dimension);
  } catch (error) {
    if (!(error instanceof MappingLoadError)) throw error;
    return (
      `This session recorded its cell order on ${describeEmbeddingRef(saved.cellOrder.embedding)}, `
      + `which this dataset cannot plot (${error.reason}). The session was not opened.`
    );
  } finally {
    release();
  }
  return digest === saved.cellOrder.digest ? null : CELL_ORDER_MISMATCH_MESSAGE;
}

/**
 * Restore the representations a verified session enables, before its views
 * are restored, as a participant of the restore transaction.
 *
 * Every representation the session enables is enabled now, beside the ones
 * enabled already, with the session's defaults, so the views it restores
 * find their layouts and no view loses its own before it is restored. At
 * commit the session's mapping is applied exactly, which disables the extras
 * once no restored view shows them. Rollback runs after the contributors have
 * restored the previous views, and restores the previous mapping.
 *
 * @param {object} ctx
 * @param {object} saved - The verified `datasetFingerprint.dataMapping`.
 * @returns {Promise<void>}
 */
export async function restoreSessionDataMapping(ctx, saved) {
  const state = ctx.state;
  const previous = requireMethod(
    state,
    'getDataMapping',
    'Session data-mapping restore'
  ).call(state);
  if (sameJson(saved, previous)) return;
  for (const method of ['applyDataMapping', 'getDataMappingOrigin']) {
    requireMethod(state, method, 'Session data-mapping restore');
  }
  const previousOrigin = state.getDataMappingOrigin();
  ctx.restoreTransaction.register('core/data-mapping', {
    value: null,
    prepare() {},
    async commit() {
      if (!sameJson(state.getDataMapping(), saved)) {
        await state.applyDataMapping(saved, { origin: 'session' });
      }
    },
    async rollback() {
      if (!sameJson(state.getDataMapping(), previous)) {
        await state.applyDataMapping(previous, { origin: previousOrigin });
      }
    }
  });
  const enabled = [...saved.embeddings.enabled];
  for (const ref of previous.embeddings.enabled) {
    if (!enabled.some(candidate => compareEmbeddingRefs(candidate, ref) === 0)) {
      enabled.push(ref);
    }
  }
  enabled.sort(compareEmbeddingRefs);
  await state.applyDataMapping(
    { ...saved, embeddings: { enabled, defaults: saved.embeddings.defaults } },
    { origin: 'session' }
  );
}
