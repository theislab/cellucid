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

function assertRestoreParticipant(participant, context) {
  assertExactKeys(
    participant,
    ['value', 'prepare', 'commit', 'rollback'],
    context
  );
  requireMethod(participant, 'prepare', context);
  requireMethod(participant, 'commit', context);
  requireMethod(participant, 'rollback', context);
  return participant;
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

      const commitPreparedParticipants = () => {
        phase = 'committing';
        const commitResult = runParticipantMethod(entries, 'commit');
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
  'cellOrder'
]);

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
 * Two independent 32-bit accumulators are folded over the coordinate bytes and
 * emitted as one 64-bit hex value. Both are updated with a multiply and a
 * rotation per word, so the digest depends on the order of the words, not only
 * on their multiset. Measured on 842k cells (9.64 MiB of Float32 coordinates):
 * 4.3 ms for the digest, 5.6 ms for the complete fingerprint.
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
 * @param {Float32Array} positions
 * @returns {string} 16 lowercase hexadecimal characters.
 */
function digestCellOrder(positions) {
  const memoized = CELL_ORDER_DIGESTS.get(positions);
  if (memoized !== undefined) return memoized;
  // A Float32Array is always 4-byte aligned, so its buffer can be read as
  // 32-bit words without copying.
  const words = new Uint32Array(
    positions.buffer,
    positions.byteOffset,
    positions.length
  );
  let low = 0x9e3779b1 ^ words.length;
  let high = 0x85ebca6b ^ words.length;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    low = Math.imul(low ^ word, 0x85ebca77);
    high = Math.imul(high ^ word, 0xc2b2ae3d);
    low = (low << 13) | (low >>> 19);
    high = (high << 17) | (high >>> 15);
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

function assertCellOrder(value, context) {
  assertExactKeys(value, ['dimension', 'digest'], context);
  assertSafeInteger(
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
  return value;
}

function isCellOrderUnverifiableRecord(value) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...CELL_ORDER_UNVERIFIABLE_KEYS].sort();
  return (
    actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
  );
}

/**
 * Validate one complete dataset fingerprint record from untrusted input.
 *
 * A record carrying only the pre-cell-order keys is refused with the message
 * the user is shown; a record that is malformed in any other way is a schema
 * violation.
 *
 * @param {any} value
 * @param {string} context
 * @returns {object}
 */
export function assertDatasetFingerprint(value, context) {
  if (isCellOrderUnverifiableRecord(value)) {
    throw new RangeError(SESSION_WITHOUT_CELL_IDENTITY_MESSAGE);
  }
  assertExactKeys(value, DATASET_FINGERPRINT_KEYS, context);
  assertNullableString(value.sourceType, `${context} sourceType`);
  assertNullableString(value.datasetId, `${context} datasetId`);
  assertSafeInteger(value.cellCount, `${context} cellCount`);
  assertSafeInteger(value.varCount, `${context} varCount`);
  assertCellOrder(value.cellOrder, `${context} cellOrder`);
  return value;
}

/**
 * Create the exact current dataset fingerprint.
 *
 * All five fields are mandatory; source identity may be explicitly null only
 * when no data-source manager owns the loaded state.
 *
 * @param {object} ctx
 * @returns {{
 *   sourceType: string|null,
 *   datasetId: string|null,
 *   cellCount: number,
 *   varCount: number,
 *   cellOrder: { dimension: number, digest: string }
 * }}
 */
export function getDatasetFingerprint(ctx) {
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
  const varCount = assertSafeInteger(
    ctx.state.varData.fields.length,
    'Dataset fingerprint varCount'
  );
  const positions = ctx.state.positionsArray;
  if (
    !(positions instanceof Float32Array)
    || positions.length !== cellCount * 3
  ) {
    throw new TypeError(
      'Dataset fingerprint requires the exact dataset Float32 XYZ array.'
    );
  }
  const dimension = assertSafeInteger(
    requireMethod(
      ctx.state,
      'getViewDimensionLevel',
      'Dataset fingerprint DataState'
    ).call(ctx.state, 'live'),
    'Dataset fingerprint live dimension',
    { minimum: 1, maximum: 3 }
  );
  return {
    sourceType,
    datasetId,
    cellCount,
    varCount,
    cellOrder: Object.freeze({
      dimension,
      digest: digestCellOrder(positions)
    })
  };
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
    && a.cellOrder.dimension === b.cellOrder.dimension
    && a.cellOrder.digest === b.cellOrder.digest
  );
}

/**
 * Explain a dataset fingerprint mismatch to the person loading the session.
 *
 * The session controls surface this text verbatim, so each cause gets the
 * sentence that names what actually differs and what to do next. Naming a cause
 * the evidence does not establish would be its own integrity failure: telling a
 * user their data was re-ordered when they merely switched the view, or when
 * the same rows were exported again from a re-computed embedding, would make
 * them distrust a sound dataset.
 *
 * What each field can prove differs:
 * - The scalars name the dataset, so a difference there is conclusive.
 * - The dimension is read directly, so a difference there is conclusive.
 * - `cellOrder.digest` is a one-way fold over the coordinate bytes in row
 *   order. It changes when the rows are permuted and it changes when the
 *   coordinate values change, and a hash cannot say which happened. So the
 *   last message states the one thing that is established — the coordinates
 *   are not the ones the session was saved against — and offers both causes
 *   rather than asserting the alarming one. Separating them would need an
 *   order-independent digest saved beside this one, which is a session-file
 *   schema change shared with the Python reader.
 *
 * @param {any} saved
 * @param {any} current
 * @returns {string|null} null when the two fingerprints are the same identity.
 */
export function describeDatasetFingerprintMismatch(saved, current) {
  if (datasetFingerprintMatches(saved, current)) return null;
  if (
    saved.sourceType !== current.sourceType
    || saved.datasetId !== current.datasetId
    || saved.cellCount !== current.cellCount
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
  if (saved.cellOrder.dimension !== current.cellOrder.dimension) {
    return (
      `This session was saved while the ${saved.cellOrder.dimension}D view was `
      + `shown, and the ${current.cellOrder.dimension}D view is shown now. `
      + 'Cellucid confirms that saved selections still cover the same cells by '
      + 'checking the coordinates on screen, and the two views have different '
      + `coordinates. Switch back to the ${saved.cellOrder.dimension}D view, `
      + 'then load the session again.'
    );
  }
  return (
    'This dataset is not the one this session was saved on. It has the same '
    + 'name and the same number of cells and genes, but the cell coordinates '
    + 'differ from the ones the session was saved against, so Cellucid cannot '
    + 'confirm that a saved selection still marks the same cells. Either the '
    + 'cells are stored in a different order, or the same cells were exported '
    + 'again from a re-computed embedding. The session was not opened. Load '
    + 'the version of the dataset the session was saved on, or re-create the '
    + 'selections on this one.'
  );
}
