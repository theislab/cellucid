/**
 * @fileoverview Session contributor for exact field-overlay registries.
 *
 * @module session/contributors/field-overlays
 */

import {
  assertArray,
  assertBoolean,
  assertExactKeys,
  assertNonEmptyString,
  assertNullableFiniteNumber,
  assertPlainRecord,
  assertSafeInteger,
  requireMethod
} from '../schema-contract.js';
import {
  getSessionRestoreSnapshot
} from '../session-context.js';
import {
  getCriticalUserDefinedFieldIds,
  USER_DEFINED_CODES_RESTORE_TRANSACTION_ID
} from './user-defined-code-inventory.js';

export const id = 'field-overlays';

function assertStringRecord(value, context) {
  assertPlainRecord(value, context);
  for (const [key, entry] of Object.entries(value)) {
    assertNonEmptyString(key, `${context} key`);
    assertNonEmptyString(entry, `${context} value for "${key}"`);
  }
}

function assertRenames(value) {
  assertExactKeys(value, ['fields', 'categories'], 'Field rename registry state');
  assertStringRecord(value.fields, 'Field rename registry fields');
  assertStringRecord(value.categories, 'Field rename registry categories');
}

function assertUniqueStringArray(value, context) {
  assertArray(value, context);
  const seen = new Set();
  for (const item of value) {
    const exact = assertNonEmptyString(item, `${context} entry`);
    if (seen.has(exact)) {
      throw new TypeError(`${context} must not contain duplicate "${exact}".`);
    }
    seen.add(exact);
  }
  return seen;
}

function assertDeletedFields(value) {
  assertExactKeys(value, ['deleted', 'purged'], 'Field delete registry state');
  const deleted = assertUniqueStringArray(
    value.deleted,
    'Field delete registry deleted entries'
  );
  const purged = assertUniqueStringArray(
    value.purged,
    'Field delete registry purged entries'
  );
  for (const fieldId of purged) {
    if (!deleted.has(fieldId)) {
      throw new TypeError(`Purged field "${fieldId}" must also be deleted.`);
    }
  }
}

function assertNullableRecord(value, context) {
  if (value === null) return;
  assertPlainRecord(value, context);
}

function assertPrimitiveCategoryArray(value, context) {
  assertArray(value, context);
  const seen = new Set();
  for (const entry of value) {
    const type = typeof entry;
    if (
      (type !== 'string' && type !== 'number' && type !== 'boolean')
      || (type === 'number' && !Number.isFinite(entry))
    ) {
      throw new TypeError(
        `${context} entries must be strings, finite numbers, or booleans.`
      );
    }
    if (seen.has(entry)) {
      throw new TypeError(`${context} must not contain duplicate category values.`);
    }
    seen.add(entry);
  }
}

function assertUserDefinedMetaItem(item, index) {
  assertPlainRecord(item, `User-defined field metadata ${index}`);
  const commonContext = `User-defined field metadata ${index}`;
  if (item.kind === 'continuous') {
    assertExactKeys(
      item,
      [
        'id',
        'source',
        'kind',
        'key',
        'isDeleted',
        'isPurged',
        'sourceField',
        'operation',
        'createdAt'
      ],
      commonContext
    );
  } else if (item.kind === 'category') {
    assertExactKeys(
      item,
      [
        'id',
        'source',
        'kind',
        'key',
        'categories',
        'isDeleted',
        'isPurged',
        'codesLength',
        'codesType',
        'centroidsByDim',
        'normalizedDims',
        'sourceField',
        'operation',
        'sourcePages',
        'overlapStrategy',
        'overlapLabel',
        'intersectionLabels',
        'uncoveredLabel',
        'createdAt'
      ],
      commonContext
    );
    assertPrimitiveCategoryArray(item.categories, `${commonContext} categories`);
    assertSafeInteger(item.codesLength, `${commonContext} codesLength`);
    if (item.codesType !== 'Uint8Array' && item.codesType !== 'Uint16Array') {
      throw new TypeError(`${commonContext} codesType must be Uint8Array or Uint16Array.`);
    }
    assertPlainRecord(item.centroidsByDim, `${commonContext} centroidsByDim`);
    assertArray(item.normalizedDims, `${commonContext} normalizedDims`);
    for (const dimension of item.normalizedDims) {
      assertSafeInteger(dimension, `${commonContext} normalized dimension`, {
        minimum: 2
      });
    }
    assertArray(item.sourcePages, `${commonContext} sourcePages`);
    if (
      item.overlapStrategy !== 'first'
      && item.overlapStrategy !== 'last'
      && item.overlapStrategy !== 'overlap-label'
      && item.overlapStrategy !== 'intersections'
    ) {
      throw new TypeError(`${commonContext} has unsupported overlapStrategy.`);
    }
    if (item.overlapLabel !== null) {
      assertNonEmptyString(item.overlapLabel, `${commonContext} overlapLabel`);
    }
    assertNullableRecord(item.intersectionLabels, `${commonContext} intersectionLabels`);
    if (item.uncoveredLabel !== null) {
      assertNonEmptyString(item.uncoveredLabel, `${commonContext} uncoveredLabel`);
    }
  } else {
    throw new TypeError(`${commonContext} kind must be "category" or "continuous".`);
  }

  assertNonEmptyString(item.id, `${commonContext} id`);
  assertNonEmptyString(item.key, `${commonContext} key`);
  if (item.source !== 'obs' && item.source !== 'var') {
    throw new TypeError(`${commonContext} source must be "obs" or "var".`);
  }
  assertBoolean(item.isDeleted, `${commonContext} isDeleted`);
  assertBoolean(item.isPurged, `${commonContext} isPurged`);
  if (item.isPurged && !item.isDeleted) {
    throw new TypeError(`${commonContext} purged fields must also be deleted.`);
  }
  assertNullableRecord(item.sourceField, `${commonContext} sourceField`);
  assertNullableRecord(item.operation, `${commonContext} operation`);
  assertNullableFiniteNumber(item.createdAt, `${commonContext} createdAt`);
}

function assertUserDefinedFields(value) {
  assertArray(value, 'Field overlays userDefinedFields');
  const ids = new Set();
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    assertUserDefinedMetaItem(item, index);
    if (ids.has(item.id)) {
      throw new TypeError(`User-defined field id "${item.id}" is duplicated.`);
    }
    ids.add(item.id);
  }
}

function assertPayload(payload) {
  assertExactKeys(
    payload,
    ['renames', 'deletedFields', 'userDefinedFields'],
    'Field overlays payload'
  );
  assertRenames(payload.renames);
  assertDeletedFields(payload.deletedFields);
  assertUserDefinedFields(payload.userDefinedFields);
}

function getOwners(state, operation) {
  requireMethod(state, 'getRenameRegistry', 'Field-overlay state');
  requireMethod(state, 'getDeleteRegistry', 'Field-overlay state');
  requireMethod(state, 'getUserDefinedFieldsRegistry', 'Field-overlay state');
  const renameRegistry = state.getRenameRegistry();
  const deleteRegistry = state.getDeleteRegistry();
  const userDefinedRegistry = state.getUserDefinedFieldsRegistry();
  for (const [owner, ownerName, captureMethod, restoreMethod] of [
    [renameRegistry, 'RenameRegistry', 'toJSON', 'fromJSON'],
    [deleteRegistry, 'DeleteRegistry', 'toJSON', 'fromJSON'],
    [userDefinedRegistry, 'UserDefinedFieldsRegistry', 'toSessionMeta', 'fromSessionMeta']
  ]) {
    requireMethod(owner, 'clear', ownerName);
    requireMethod(
      owner,
      operation === 'capture' ? captureMethod : restoreMethod,
      ownerName
    );
  }
  return { renameRegistry, deleteRegistry, userDefinedRegistry };
}

function capturePayload(owners) {
  const payload = {
    renames: owners.renameRegistry.toJSON(),
    deletedFields: owners.deleteRegistry.toJSON(),
    userDefinedFields: owners.userDefinedRegistry.toSessionMeta()
  };
  assertPayload(payload);
  return payload;
}

function applyPayload(state, owners, payload) {
  assertPayload(payload);
  owners.renameRegistry.clear();
  owners.deleteRegistry.clear();
  owners.userDefinedRegistry.clear();
  owners.renameRegistry.fromJSON(payload.renames);
  owners.deleteRegistry.fromJSON(payload.deletedFields);
  owners.userDefinedRegistry.fromSessionMeta(payload.userDefinedFields);
  state.applyFieldOverlays();
}

function captureCategoricalCodes(userDefinedRegistry, payload) {
  const categoricalMetadata = payload.userDefinedFields.filter(
    field => field.kind === 'category'
  );
  if (categoricalMetadata.length === 0) return new Map();
  requireMethod(
    userDefinedRegistry,
    'getField',
    'UserDefinedFieldsRegistry categorical rollback owner'
  );
  const snapshots = new Map();
  for (const metadata of categoricalMetadata) {
    const field = userDefinedRegistry.getField(metadata.id);
    if (
      field === null
      || typeof field !== 'object'
      || (
        !(field.codes instanceof Uint8Array)
        && !(field.codes instanceof Uint16Array)
      )
    ) {
      throw new TypeError(
        `User-defined field "${metadata.id}" requires exact rollback codes.`
      );
    }
    if (
      field.codes.length !== metadata.codesLength
      || field.codes.constructor.name !== metadata.codesType
    ) {
      throw new RangeError(
        `User-defined field "${metadata.id}" rollback codes do not match its metadata.`
      );
    }
    snapshots.set(metadata.id, field.codes);
  }
  return snapshots;
}

function restoreCategoricalCodes(
  state,
  userDefinedRegistry,
  codeSnapshots
) {
  if (codeSnapshots.size === 0) return;
  requireMethod(
    userDefinedRegistry,
    'getField',
    'UserDefinedFieldsRegistry categorical rollback owner'
  );
  for (const [fieldId, codes] of codeSnapshots) {
    const field = userDefinedRegistry.getField(fieldId);
    if (field === null || typeof field !== 'object') {
      throw new RangeError(
        `User-defined field "${fieldId}" was not reconstructed for rollback.`
      );
    }
    field.codes = codes;
    field.loaded = true;
    delete field._codesLengthHint;
    delete field._codesTypeHint;
  }
  state.applyFieldOverlays();
}

function createCategoricalCodeInventoryTracker(state, payload) {
  const categoricalIds = payload.userDefinedFields
    .filter(field => field.kind === 'category')
    .map(field => field.id);
  const expectedIds = new Set(categoricalIds);
  const receivedPriorities = new Map();
  const receivedOrder = {
    eager: [],
    lazy: []
  };

  return Object.freeze({
    record(fieldId, priority) {
      const exactId = assertNonEmptyString(
        fieldId,
        'Restored user-defined code field id'
      );
      if (!expectedIds.has(exactId)) {
        throw new RangeError(
          `User-defined code field "${exactId}" is not in the field-overlay inventory.`
        );
      }
      if (priority !== 'eager' && priority !== 'lazy') {
        throw new TypeError(
          `User-defined code field "${exactId}" has an invalid priority.`
        );
      }
      if (receivedPriorities.has(exactId)) {
        throw new TypeError(
          `User-defined code field "${exactId}" was restored more than once.`
        );
      }
      receivedPriorities.set(exactId, priority);
      receivedOrder[priority].push(exactId);
    },

    prepare() {
      if (receivedPriorities.size !== expectedIds.size) {
        throw new RangeError(
          `Field overlays advertise ${expectedIds.size} categorical code ` +
          `chunks but restored ${receivedPriorities.size}.`
        );
      }
      if (expectedIds.size === 0) return;
      const criticalIds = getCriticalUserDefinedFieldIds(state);
      for (const criticalId of criticalIds) {
        if (!expectedIds.has(criticalId)) {
          throw new RangeError(
            `Active user-defined field "${criticalId}" is absent from ` +
            'the field-overlay code inventory.'
          );
        }
      }
      for (const fieldId of expectedIds) {
        const actualPriority = receivedPriorities.get(fieldId);
        if (actualPriority === undefined) {
          throw new RangeError(
            `User-defined code field "${fieldId}" is missing its chunk.`
          );
        }
        const expectedPriority = criticalIds.has(fieldId)
          ? 'eager'
          : 'lazy';
        if (actualPriority !== expectedPriority) {
          throw new TypeError(
            `User-defined code field "${fieldId}" must be ${expectedPriority} ` +
            'for the restored active-field graph.'
          );
        }
      }
      for (const priority of ['eager', 'lazy']) {
        const expectedOrder = categoricalIds.filter(
          fieldId => (
            criticalIds.has(fieldId)
              ? priority === 'eager'
              : priority === 'lazy'
          )
        );
        const actualOrder = receivedOrder[priority];
        if (
          actualOrder.length !== expectedOrder.length
          || actualOrder.some(
            (fieldId, index) => fieldId !== expectedOrder[index]
          )
        ) {
          throw new TypeError(
            `User-defined ${priority} code chunks must match the exact ` +
            'field-overlay inventory order.'
          );
        }
      }
    }
  });
}

export function capture(ctx) {
  if (ctx === null || typeof ctx !== 'object' || ctx.state === null || typeof ctx.state !== 'object') {
    throw new TypeError('Field-overlay capture requires the current DataState owner.');
  }
  const {
    renameRegistry,
    deleteRegistry,
    userDefinedRegistry
  } = getOwners(ctx.state, 'capture');
  const payload = capturePayload({
    renameRegistry,
    deleteRegistry,
    userDefinedRegistry
  });

  return [{
    id: 'core/field-overlays',
    contributorId: id,
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Field overlays',
    datasetDependent: true,
    payload
  }];
}

export function restore(ctx, _chunkMeta, payload) {
  if (ctx === null || typeof ctx !== 'object' || ctx.state === null || typeof ctx.state !== 'object') {
    throw new TypeError('Field-overlay restore requires the current DataState owner.');
  }
  const state = ctx.state;
  const owners = getOwners(state, 'restore');
  requireMethod(state, 'applyFieldOverlays', 'Field-overlay restore owner');
  assertPayload(payload);

  const restoreTransaction = ctx.restoreTransaction;
  if (
    restoreTransaction === null
    || typeof restoreTransaction !== 'object'
  ) {
    applyPayload(state, owners, payload);
    return;
  }
  requireMethod(
    restoreTransaction,
    'register',
    'Field-overlay restore transaction'
  );
  const sharedSnapshot = getSessionRestoreSnapshot(
    ctx,
    'core/field-overlays'
  );
  const previousPayload = sharedSnapshot === undefined
    ? capturePayload(owners)
    : structuredClone(sharedSnapshot);
  assertPayload(previousPayload);
  const previousCodes = captureCategoricalCodes(
    owners.userDefinedRegistry,
    previousPayload
  );
  const codeInventoryTracker = createCategoricalCodeInventoryTracker(
    state,
    payload
  );
  let applied = false;
  const rollbackState = () => {
    if (!applied) return;
    applyPayload(state, owners, previousPayload);
    restoreCategoricalCodes(
      state,
      owners.userDefinedRegistry,
      previousCodes
    );
    applied = false;
  };
  restoreTransaction.register(USER_DEFINED_CODES_RESTORE_TRANSACTION_ID, {
    value: Object.freeze({
      rollback: rollbackState,
      record: codeInventoryTracker.record
    }),
    prepare: codeInventoryTracker.prepare,
    commit() {},
    rollback: rollbackState
  });

  applied = true;
  applyPayload(state, owners, payload);
}
