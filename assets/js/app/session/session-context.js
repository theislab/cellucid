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
 *   commit: () => void,
 *   rollback: () => void
 * }}
 */
export function createSessionRestoreTransaction() {
  const participants = new Map();
  let phase = 'open';

  function requireOpen(operation) {
    if (phase !== 'open') {
      throw new Error(
        `Session restore transaction cannot ${operation} while ${phase}.`
      );
    }
  }

  function rollbackParticipants() {
    if (phase === 'rolled-back') return;
    if (phase === 'rolling-back') {
      throw new Error('Session restore transaction rollback is already in progress.');
    }
    phase = 'rolling-back';
    const rollbackErrors = [];
    const entries = [...participants.values()];
    for (let index = entries.length - 1; index >= 0; index--) {
      try {
        entries[index].rollback();
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    phase = 'rolled-back';
    if (rollbackErrors.length === 1) throw rollbackErrors[0];
    if (rollbackErrors.length > 1) {
      throw new AggregateError(
        rollbackErrors,
        'Multiple session restore participants failed to roll back.'
      );
    }
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
      try {
        phase = 'preparing';
        for (const participant of participants.values()) {
          participant.prepare();
        }
        phase = 'committing';
        for (const participant of participants.values()) {
          participant.commit();
        }
        phase = 'committed';
      } catch (error) {
        try {
          rollbackParticipants();
        } catch (rollbackError) {
          preserveRollbackFailure(error, rollbackError);
        }
        throw error;
      }
    },

    rollback() {
      rollbackParticipants();
    }
  });
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
 * Create a dataset fingerprint for dev-phase safety checks.
 *
 * Minimum fields (per plan): { sourceType, datasetId }
 * Recommended: include fast mismatch guards (cellCount, varCount).
 *
 * @param {object} ctx
 * @returns {{ sourceType: string|null, datasetId: string|null, cellCount?: number, varCount?: number }}
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
