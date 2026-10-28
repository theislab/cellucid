/**
 * @fileoverview The values of user-defined continuous fields that hold their
 * own (a column a notebook pushed, `setField`).
 *
 * A continuous alias is restored by copying its source field; a stored
 * field's values exist nowhere else, so each is one binary chunk,
 * `user-defined/values/<field id>`: its float32 values, little-endian, one
 * per cell (NaN where a cell has none), gzip-compressed by the bundle. The
 * field's record in `core/field-overlays` names their length and type; the
 * chunks are eager and follow the code chunks, so every value is in place
 * before the views that colour by a field are restored.
 *
 * @module session/contributors/user-defined-values
 */

import {
  assertArray,
  assertNonEmptyString,
  assertSafeInteger,
  requireMethod,
} from '../schema-contract.js';
import { requireExactKeys } from '../../../utils/exact-record.js';
import { mapCells, mapValues, sessionCellOrder } from '../session-cell-order.js';
import { formatCountOf } from '../../../utils/format-units.js';

export const id = 'user-defined-values';

const CHUNK_PREFIX = 'user-defined/values/';
const CHUNK_META_KEYS = Object.freeze([
  'id',
  'contributorId',
  'priority',
  'kind',
  'codec',
  'label',
  'datasetDependent',
  'storedBytes',
  'uncompressedBytes'
]);
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

function getState(ctx, operation) {
  if (ctx === null || typeof ctx !== 'object' || ctx.state === null || typeof ctx.state !== 'object') {
    throw new TypeError(`User-defined values ${operation} requires the current DataState owner.`);
  }
  return ctx.state;
}

/** Whether a user-defined field holds its own values (no source to copy). */
export function isStoredContinuousField(field) {
  return field.kind === 'continuous' && field._sourceField === null;
}

function encodeValues(values) {
  if (HOST_IS_LITTLE_ENDIAN) return new Uint8Array(values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength));
  const bytes = new Uint8Array(values.byteLength);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index++) view.setFloat32(index * 4, values[index], true);
  return bytes;
}

function decodeValues(payload, length) {
  if (payload.byteLength !== length * 4) {
    throw new RangeError(
      `User-defined values hold ${formatCountOf(payload.byteLength, 'byte')} for ${formatCountOf(length, 'float32 value')}.`
    );
  }
  const values = new Float32Array(length);
  if (HOST_IS_LITTLE_ENDIAN) {
    new Uint8Array(values.buffer).set(payload);
  } else {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    for (let index = 0; index < length; index++) values[index] = view.getFloat32(index * 4, true);
  }
  for (let index = 0; index < length; index++) {
    if (values[index] === Infinity || values[index] === -Infinity) {
      throw new RangeError('User-defined values must be finite numbers or NaN.');
    }
  }
  return values;
}

export function capture(ctx) {
  const state = getState(ctx, 'capture');
  requireMethod(state, 'getUserDefinedFieldsRegistry', 'User-defined values capture owner');
  const registry = state.getUserDefinedFieldsRegistry();
  requireMethod(registry, 'getAllFields', 'UserDefinedFieldsRegistry');
  const pointCount = assertSafeInteger(state.pointCount, 'User-defined values dataset pointCount', { minimum: 1 });
  const chunks = [];
  for (const field of assertArray(registry.getAllFields(), 'Current user-defined field inventory')) {
    if (field._isPurged === true || !isStoredContinuousField(field)) continue;
    const fieldId = assertNonEmptyString(field._userDefinedId, 'User-defined field id');
    if (!(field.values instanceof Float32Array) || field.values.length !== pointCount) {
      throw new TypeError(`User-defined field "${fieldId}" must hold one float32 value per cell.`);
    }
    chunks.push({
      id: `${CHUNK_PREFIX}${fieldId}`,
      contributorId: id,
      priority: 'eager',
      kind: 'binary',
      codec: 'gzip',
      label: `User-defined values: ${assertNonEmptyString(field.key, `User-defined field "${fieldId}" key`)}`,
      datasetDependent: true,
      // By original position (`session-cell-order.js`).
      payload: encodeValues(mapValues(field.values, sessionCellOrder(state.cellIdentity)?.toSession ?? null))
    });
  }
  return chunks;
}

export function restore(ctx, chunkMeta, payload) {
  const state = getState(ctx, 'restore');
  if (!(payload instanceof Uint8Array)) {
    throw new TypeError('User-defined values payload must be a Uint8Array.');
  }
  requireExactKeys(chunkMeta, CHUNK_META_KEYS, 'User-defined values chunk metadata');
  if (
    chunkMeta.contributorId !== id
    || chunkMeta.priority !== 'eager'
    || chunkMeta.kind !== 'binary'
    || chunkMeta.codec !== 'gzip'
    || chunkMeta.datasetDependent !== true
  ) {
    throw new TypeError('User-defined values chunks must be eager, binary, gzip and dataset-dependent.');
  }
  const chunkId = assertNonEmptyString(chunkMeta.id, 'User-defined values chunk id');
  if (!chunkId.startsWith(CHUNK_PREFIX)) {
    throw new TypeError(`User-defined values chunk id must start with "${CHUNK_PREFIX}".`);
  }
  const fieldId = assertNonEmptyString(chunkId.slice(CHUNK_PREFIX.length), 'User-defined values field id');
  const pointCount = assertSafeInteger(state.pointCount, 'User-defined values dataset pointCount', { minimum: 1 });
  if (chunkMeta.uncompressedBytes !== payload.byteLength) {
    throw new RangeError('User-defined values payload length must equal metadata uncompressedBytes.');
  }
  const template = state.getUserDefinedFieldsRegistry().getField(fieldId);
  if (template === null || template === undefined || !isStoredContinuousField(template) || template._userDefinedId !== fieldId) {
    throw new RangeError(`User-defined field "${fieldId}" does not hold its own values.`);
  }
  if (chunkMeta.label !== `User-defined values: ${template.key}`) {
    throw new TypeError(`User-defined values chunk label must match field "${fieldId}".`);
  }
  if (template._valuesLengthHint !== pointCount) {
    throw new RangeError(`User-defined field "${fieldId}" holds values for another cell count.`);
  }
  // Stored by original position (`session-cell-order.js`), held in open order.
  const values = mapValues(decodeValues(payload, pointCount), sessionCellOrder(state.cellIdentity)?.toOpen ?? null);
  template.values = values;
  template.loaded = true;
  delete template._valuesLengthHint;
  const copies = [...(state.obsData?.fields ?? [])];
  if (state.viewContexts instanceof Map) {
    for (const context of state.viewContexts.values()) copies.push(...(context?.obsData?.fields ?? []));
  }
  for (const field of copies) {
    if (field?._userDefinedId !== fieldId) continue;
    field.values = values;
    field.loaded = true;
    delete field._valuesLengthHint;
  }
}
