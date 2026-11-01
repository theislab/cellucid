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
import { hasFilterState } from '../state-serializer/filters.js';
import {
  assertNonEmptyString,
  assertNullableString,
  assertSafeInteger,
  requireMethod,
} from './schema-contract.js';
import {
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
import { sameJson } from '../utils/same-json.js';
import { requireExactKeys, requirePlainRecord } from '../../utils/exact-record.js';
import { formatCountOf, countNoun } from '../../utils/format-units.js';

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
  requireExactKeys(
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
  requireExactKeys(
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
  requireExactKeys(
    base,
    [
      'state',
      'viewer',
      'sidebar',
      'dataSourceManager',
      'comparisonModule',
      'analysisWindowManager',
      'cinematicCamera',
      'figureExport'
    ],
    'Session context base'
  );
  requireExactKeys(
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
    figureExport: base.figureExport,
    notifications: getNotificationCenter(),
    abortSignal: options.abortSignal,
    restoreTransaction
  };
}

/**
 * The dataset fields a session uses: every observation field and gene that a
 * view shows or filters on, or that a highlight group is bound to, by the key
 * the dataset gives it (a field renamed in the session is listed by its
 * original key). Fields the session creates itself are not listed. Recorded as
 * the manifest's `requires`, so a dataset missing any of them is refused before
 * anything is applied, naming every missing key at once.
 *
 * @param {object} state
 * @returns {{obs: string[], var: string[]}}
 */
export function collectRequiredFields(state) {
  const obs = new Set();
  const vars = new Set();
  const datasetKey = field => field._originalKey ?? field.key;
  const add = (set, field) => {
    if (
      field === null
      || typeof field !== 'object'
      || field._isUserDefined === true
      || field._isDeleted === true
    ) {
      return;
    }
    set.add(datasetKey(field));
  };
  const visit = ({ obsData, varData, activeFieldSource, activeFieldIndex, activeVarFieldIndex }) => {
    const obsFields = Array.isArray(obsData?.fields) ? obsData.fields : [];
    const varFields = Array.isArray(varData?.fields) ? varData.fields : [];
    for (const field of obsFields) if (hasFilterState(field)) add(obs, field);
    for (const field of varFields) if (hasFilterState(field)) add(vars, field);
    if (activeFieldSource === 'obs') add(obs, obsFields[activeFieldIndex] ?? null);
    if (activeFieldSource === 'var') add(vars, varFields[activeVarFieldIndex] ?? null);
  };
  // The focused view's state is the top level; every other view's is parked
  // in its context.
  visit(state);
  const activeViewId = state.getActiveViewId();
  if (state.viewContexts instanceof Map) {
    for (const [viewId, context] of state.viewContexts) {
      if (viewId !== activeViewId) visit(context);
    }
  }
  for (const page of state.getHighlightPages?.() ?? []) {
    for (const group of page.highlightedGroups ?? []) {
      if (typeof group.fieldKey !== 'string') continue;
      const fields = group.fieldSource === 'var' ? state.varData?.fields : state.obsData?.fields;
      add(group.fieldSource === 'var' ? vars : obs, fields?.[group.fieldIndex] ?? null);
    }
  }
  return { obs: [...obs].sort(), var: [...vars].sort() };
}

/**
 * Validate a manifest's `requires` record (untrusted input).
 * @param {unknown} value
 * @param {string} context
 * @returns {{obs: string[], var: string[]}}
 */
export function assertSessionRequires(value, context) {
  requireExactKeys(value, ['obs', 'var'], context);
  for (const source of ['obs', 'var']) {
    const keys = value[source];
    if (!Array.isArray(keys)) {
      throw new TypeError(`${context} ${source} must be an array of field keys.`);
    }
    for (let index = 0; index < keys.length; index++) {
      assertNonEmptyString(keys[index], `${context} ${source}[${index}]`);
      if (index > 0 && !(keys[index - 1] < keys[index])) {
        throw new TypeError(`${context} ${source} must be sorted and without duplicates.`);
      }
    }
  }
  return value;
}

function quoteKeys(keys) {
  return keys.map(key => `"${key}"`).join(', ');
}

/**
 * The refusal naming every field a session uses that the open dataset lacks,
 * or null when it has them all.
 *
 * @param {object} state
 * @param {{obs: string[], var: string[]}} requires
 * @returns {string|null}
 */
export function describeMissingRequiredFields(state, requires) {
  const keysOf = data => new Set(
    (Array.isArray(data?.fields) ? data.fields : [])
      .filter(field => field?._isUserDefined !== true)
      .map(field => field._originalKey ?? field.key)
  );
  const obsKeys = keysOf(state.obsData);
  const varKeys = keysOf(state.varData);
  const missingObs = requires.obs.filter(key => !obsKeys.has(key));
  const missingVar = requires.var.filter(key => !varKeys.has(key));
  if (missingObs.length === 0 && missingVar.length === 0) return null;
  const parts = [];
  if (missingObs.length > 0) {
    parts.push(`the observation ${countNoun(missingObs.length, 'field')} ${quoteKeys(missingObs)}`);
  }
  if (missingVar.length > 0) {
    parts.push(`the ${countNoun(missingVar.length, 'gene')} ${quoteKeys(missingVar)}`);
  }
  return (
    `This session uses ${parts.join(' and ')}, which the dataset that is open `
    + 'now does not have. The session was not opened. Open the dataset the '
    + 'session was saved on, then load the session again.'
  );
}

/**
 * The dataset a session belongs to, whatever it was opened from: its identity
 * id (the id its file states in `uns['cellucid']['id']`, else the one its
 * source gives it), its
 * counts, the digest of its cells' coordinates, and its data mapping. The
 * cell-order digest is what proves two copies hold the same cells at the
 * same coordinates, so a session saved on one host applies to the same
 * dataset opened from another.
 */
const DATASET_FINGERPRINT_KEYS = Object.freeze([
  'datasetId',
  'name',
  'cellCount',
  'varCount',
  'cellOrder',
  'dataMapping'
]);

function assertCellOrder(value, context) {
  requireExactKeys(value, ['embedding', 'dimension', 'digest'], context);
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
      dimension,
      label: `${context} embedding`,
    });
  } catch (error) {
    throw new TypeError(error.message, { cause: error });
  }
  return value;
}

/**
 * Validate one complete dataset fingerprint record from untrusted input.
 *
 * A file without the session signature never reaches this check: it is
 * refused first (`bundle/format.js`). A record that is malformed
 * in any way is a schema violation.
 *
 * @param {any} value
 * @param {string} context
 * @returns {object}
 */
export function assertDatasetFingerprint(value, context) {
  requireExactKeys(value, DATASET_FINGERPRINT_KEYS, context);
  assertNullableString(value.datasetId, `${context} datasetId`);
  assertNullableString(value.name, `${context} name`);
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
  assertCellOrder(value.cellOrder, `${context} cellOrder`);
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
  requirePlainRecord(ctx, 'Session context');
  if (ctx.state === null || typeof ctx.state !== 'object') {
    throw new TypeError('Dataset fingerprint requires the current DataState.');
  }
  const manager = ctx.dataSourceManager;
  let datasetId = null;
  let name = null;
  if (manager !== null) {
    // The identity id, not the route's own id: a local copy of a published
    // dataset is the same dataset (`local-user:<id>` is only the route's key).
    requireMethod(manager, 'getCurrentIdentityId', 'Dataset fingerprint manager');
    datasetId = assertNullableString(
      manager.getCurrentIdentityId(),
      'Dataset fingerprint datasetId'
    );
    // The name the dataset gives itself, for the messages that ask the person
    // to open it; it is not part of the identity.
    const metadataName = manager.getCurrentMetadata?.()?.name;
    name = typeof metadataName === 'string' && metadataName.trim() !== ''
      ? metadataName.trim()
      : null;
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
  return { datasetId, name, cellCount, varCount };
}

/**
 * The current dataset fingerprint without its cell-order digest, and the
 * layout the digest is taken over: the one the live view shows, which
 * `cellOrder.embedding` names under the dataset's data mapping. @private
 */
function describeCurrentFingerprint(ctx) {
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
  const embedding = layoutEmbeddingRef(state.dimensionManager, layoutKey);
  return { scalars, dataMapping, embedding, dimension, layoutKey };
}

/**
 * Create the exact current dataset fingerprint.
 *
 * All five fields are mandatory; the dataset id may be explicitly null only
 * when no data-source manager owns the loaded state. The cell-order digest is
 * taken over the stored values of the embedding the live view shows, each
 * open cell named by its original position (`data/cell-order-digest.js`),
 * and `cellOrder.embedding` names that embedding under the dataset's data
 * mapping. The reader worker summed the values as it read them, so this
 * folds nothing on the page.
 *
 * @param {object} ctx
 * @returns {Promise<{
 *   datasetId: string|null,
 *   cellCount: number,
 *   varCount: number,
 *   cellOrder: { embedding: {key: string, columns: number[]}, dimension: number, digest: string },
 *   dataMapping: object
 * }>}
 */
export async function getDatasetFingerprint(ctx) {
  const { scalars, dataMapping, embedding, dimension, layoutKey } = describeCurrentFingerprint(ctx);
  const dimensionManager = ctx.state.dimensionManager;
  const digest = await requireMethod(
    dimensionManager,
    'getCellOrderDigest',
    'Dataset fingerprint DimensionManager'
  ).call(dimensionManager, layoutKey);
  return {
    ...scalars,
    cellOrder: Object.freeze({
      embedding: Object.freeze(embedding),
      dimension,
      digest
    }),
    dataMapping
  };
}

/**
 * Whether `fingerprint` (taken with `getDatasetFingerprint`) still names the
 * open dataset: every field but the digest compared with the current ones.
 * The digest is a function of the cells open and the embedding shown, so
 * while those and the dataset generation stand, it stands too.
 *
 * @param {object} ctx
 * @param {object} fingerprint
 * @returns {boolean}
 */
export function datasetFingerprintStillCurrent(ctx, fingerprint) {
  const { scalars, dataMapping, embedding, dimension } = describeCurrentFingerprint(ctx);
  return datasetFingerprintMatches(fingerprint, {
    ...scalars,
    cellOrder: { embedding, dimension, digest: fingerprint.cellOrder.digest },
    dataMapping
  });
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
    a.datasetId === b.datasetId
    && a.cellCount === b.cellCount
    && a.varCount === b.varCount
    && sameJson(a.cellOrder.embedding, b.cellOrder.embedding)
    && a.cellOrder.dimension === b.cellOrder.dimension
    && a.cellOrder.digest === b.cellOrder.digest
    && sameJson(a.dataMapping, b.dataMapping)
  );
}

/**
 * Name one side of an identity mismatch the way the person reading it would:
 * by the name the Dataset box shows for it, quoted, never by its identity id
 * (an internal key: a link's is its encoded address); null when the dataset
 * gave no name.
 *
 * @param {{name?: string|null}} fingerprint
 * @returns {string|null}
 */
function describeDatasetIdentity(fingerprint) {
  return typeof fingerprint.name === 'string' && fingerprint.name !== '' ? `"${fingerprint.name}"` : null;
}

/** Where a session was saved, against what is open, when both have the same counts. */
function describeOtherDataset(saved, current) {
  const savedName = describeDatasetIdentity(saved);
  const currentName = describeDatasetIdentity(current);
  if (savedName !== null && savedName === currentName) {
    return `another dataset also called ${savedName} than the one open now`;
  }
  return `${savedName ?? 'another dataset'} and ${currentName ?? 'another one'} is open now`;
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
 *   describeEmbeddingRefusal: (ref: {key: string, columns: number[]}) => string|null,
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
  // A multimodal dataset's expression groups are its modality's: the modality first.
  for (const group of ['knn', 'modality', 'geneNames', 'expression', 'log1p', 'highlyVariable', 'latent', 'vectorFields']) {
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
 *   differ. Two datasets that agree on every count but not on their id get
 *   their own sentence, which names the ids instead.
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
      + `now (${formatCountOf(saved.cellCount, 'cell')} and `
      + `${formatCountOf(saved.varCount, 'gene')} when it was saved, `
      + `${formatCountOf(current.cellCount, 'cell')} and `
      + `${formatCountOf(current.varCount, 'gene')} now). Open the `
      + 'dataset the session was saved on, then load the session again.'
    );
  }
  // The counts are the evidence in the message above, so it can only be used
  // where they differ; two datasets with equal counts are told apart by
  // their identity, and named by the names they show.
  if (saved.datasetId !== current.datasetId) {
    return (
      'This session was saved on a different dataset. It has the same '
      + `${formatCountOf(saved.cellCount, 'cell')} and `
      + `${formatCountOf(saved.varCount, 'gene')}, but it was saved on `
      + `${describeOtherDataset(saved, current)}. Open the dataset `
      + 'the session was saved on, then load the session again.'
    );
  }
  return null;
}

/**
 * The refusal shown when a session's cell-order digest does not match.
 *
 * `cellOrder.digest` is a one-way hash of the embedding's stored values,
 * each cell named by its original position (`data/cell-order-digest.js`).
 * It changes when another cell sits at an original position (the cells
 * listed in another order) and when the coordinate values change, and a
 * hash cannot say which happened, so the message states the one thing that
 * is established and offers both causes. How the cells were opened (whole,
 * grown, cut, in priority order) never changes it.
 */
const CELL_ORDER_MISMATCH_MESSAGE =
  'This dataset is not the one this session was saved on. It has the same '
  + 'name and the same number of cells and genes, but the cell coordinates '
  + 'differ from the ones the session was saved against, so Cellucid cannot '
  + 'confirm that a saved selection still marks the same cells. Either the '
  + 'cells are listed in a different order, or the same cells were exported '
  + 'again from a re-computed embedding. The session was not opened. Load '
  + 'the version of the dataset the session was saved on, or re-create the '
  + 'selections on this one.';

/**
 * Verify a saved session fingerprint against the open dataset, without
 * changing anything the user sees.
 *
 * In order: the dataset's counts and identity, its data mapping, then the
 * cell-order digest of the very embedding the session names, over the open
 * cells, whichever layout the live view shows now (the reader worker's sums,
 * `DimensionManager.getCellOrderDigest`: no layout is loaded for it).
 * Nothing is applied before all of them pass.
 *
 * A session names the cells it was saved on, which are opened before it is
 * restored (`session-controls.js`): the digest of those cells is the same
 * however they are opened now -- whole, grown, cut in place from a larger
 * share, in priority order or as the file gives them.
 *
 * A dataset's published starting view (`profile` 'published-default') is
 * saved on every cell and holds no per-cell state (its seven static chunks,
 * `published-default.js`): it applies to any subsample of its dataset --
 * fitted to the device, or named in the link -- as it does to every cell.
 * The cell count is then the dataset's (`nOriginal` of the open cells'
 * identity), and the cell-order digest, a sum over every cell, cannot be
 * taken from the cells a subsample holds: the catalog binds the view to its
 * dataset's generation by SHA-256 instead.
 *
 * @param {object} ctx
 * @param {any} saved - A validated `manifest.datasetFingerprint`.
 * @param {{profile?: 'published-default'|null}} [options]
 * @returns {Promise<string|null>} The refusal to show, or null when it matches.
 */
export async function verifySessionFingerprint(ctx, saved, { profile = null } = {}) {
  assertDatasetFingerprint(saved, 'Saved dataset fingerprint');
  const opened = currentFingerprintScalars(ctx);
  const cells = ctx.state.cellIdentity ?? null;
  const ontoSubsample = profile === 'published-default' && cells?.isSubset === true && cells.nOriginal === saved.cellCount;
  const scalars = ontoSubsample ? { ...opened, cellCount: cells.nOriginal } : opened;
  // Choosing None leaves a runtime of zero cells and no data mapping. That is
  // no dataset at all, so quoting its zero counts as "the one that is open
  // now" would be untrue.
  if (scalars.cellCount === 0) {
    const savedName = describeDatasetIdentity(saved);
    return (
      'No dataset is open. Open the dataset the session was saved on'
      + `${savedName === null ? '' : ` (${savedName})`}, then load the session again.`
    );
  }
  const dataMapping = requireCurrentDataMapping(ctx.state);
  // The gene count is that of the var axis the saved mapping names (raw.X
  // has its own), read from metadata: a session saved on raw restores onto a
  // file that opened on X.
  const varCount = requireMethod(
    ctx.state,
    'describeMappingVarCount',
    'Session restore DataState'
  ).call(ctx.state, saved.dataMapping);
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
        // Expression choices are those of the session's modality.
        describeChoiceRefusal: (group, value) => requireMethod(
          ctx.state,
          'withMappingModality',
          'Session restore DataState'
        ).call(ctx.state, saved.dataMapping.modality ?? null, () => requireMethod(
          ctx.state,
          'describeMappingChoiceRefusal',
          'Session restore DataState'
        ).call(ctx.state, group, value)),
      }
    );
    if (mapping !== null) return mapping;
  }

  if (ontoSubsample) return null;
  const dimensionManager = ctx.state.dimensionManager;
  const layoutKey = resolveEmbeddingRefLayout(
    dimensionManager,
    saved.cellOrder.embedding,
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
  const digest = await requireMethod(
    dimensionManager,
    'getCellOrderDigest',
    'Session restore DimensionManager'
  ).call(dimensionManager, layoutKey);
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
