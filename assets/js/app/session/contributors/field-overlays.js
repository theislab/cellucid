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

export function capture(ctx) {
  if (ctx === null || typeof ctx !== 'object' || ctx.state === null || typeof ctx.state !== 'object') {
    throw new TypeError('Field-overlay capture requires the current DataState owner.');
  }
  const {
    renameRegistry,
    deleteRegistry,
    userDefinedRegistry
  } = getOwners(ctx.state, 'capture');
  const payload = {
    renames: renameRegistry.toJSON(),
    deletedFields: deleteRegistry.toJSON(),
    userDefinedFields: userDefinedRegistry.toSessionMeta()
  };
  assertPayload(payload);

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

  owners.renameRegistry.clear();
  owners.deleteRegistry.clear();
  owners.userDefinedRegistry.clear();
  owners.renameRegistry.fromJSON(payload.renames);
  owners.deleteRegistry.fromJSON(payload.deletedFields);
  owners.userDefinedRegistry.fromSessionMeta(payload.userDefinedFields);
  state.applyFieldOverlays();
}
