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
 * Create the exact current dataset fingerprint.
 *
 * All four fields are mandatory; source identity may be explicitly null only
 * when no data-source manager owns the loaded state.
 *
 * @param {object} ctx
 * @returns {{ sourceType: string|null, datasetId: string|null, cellCount: number, varCount: number }}
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
  return { sourceType, datasetId, cellCount, varCount };
}

/**
 * Compare two dataset fingerprints.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
export function datasetFingerprintMatches(a, b) {
  for (const [value, context] of [[a, 'Saved'], [b, 'Current']]) {
    assertExactKeys(
      value,
      ['sourceType', 'datasetId', 'cellCount', 'varCount'],
      `${context} dataset fingerprint`
    );
    assertNullableString(value.sourceType, `${context} dataset fingerprint sourceType`);
    assertNullableString(value.datasetId, `${context} dataset fingerprint datasetId`);
    assertSafeInteger(value.cellCount, `${context} dataset fingerprint cellCount`);
    assertSafeInteger(value.varCount, `${context} dataset fingerprint varCount`);
  }
  return (
    a.sourceType === b.sourceType
    && a.datasetId === b.datasetId
    && a.cellCount === b.cellCount
    && a.varCount === b.varCount
  );
}
