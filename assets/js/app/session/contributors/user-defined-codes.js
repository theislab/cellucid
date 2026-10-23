/**
 * @fileoverview Exact binary user-defined categorical code arrays.
 *
 * @module session/contributors/user-defined-codes
 */

import { yieldToMacrotask } from '../../../utils/yield-macrotask.js';
import { decodeUvarint, uvarintLength, writeUvarint } from '../codecs/varint.js';
import { computeAllLayoutCentroids } from '../../registries/user-defined-fields/centroids.js';
import {
  assertArray,
  assertExactKeys,
  assertNonEmptyString,
  assertPlainRecord,
  assertSafeInteger,
  requireMethod
} from '../schema-contract.js';
import {
  getCriticalUserDefinedFieldIds,
  USER_DEFINED_CODES_RESTORE_TRANSACTION_ID
} from './user-defined-code-inventory.js';
import { requireCategoryCodes } from '../../registries/user-defined-fields.js';
import { isCategoricalCodes } from '../../../data/categorical-storage-contract.js';

export const id = 'user-defined-codes';

/**
 * Codes payload (before the chunk's gzip): u8 encoding, uvarint length, then
 *
 * - 0 raw: `length` codes, little-endian, at the field's declared code width;
 * - 1 runs: uvarint runCount, then runCount × (uvarint value, uvarint length),
 *   adjacent runs with distinct values;
 * - 2 packed: u8 bitsPerCode (1, 2 or 4), then ceil(length × bits / 8) bytes,
 *   code i in bits [i × bits, (i + 1) × bits) counted from the least
 *   significant bit of byte 0.
 *
 * The writer keeps the smallest. Measured on Suo (562k cells, 3 codes made
 * from two highlight pages): runs 441 KB, packed 140 KB before gzip; 107 KB
 * and 86 KB after.
 */
const ENC_RAW = 0;
const ENC_RUNS = 1;
const ENC_PACKED = 2;

/** Each code width's element size and largest value. */
const CODE_WIDTHS = Object.freeze({
  Uint8Array: Object.freeze({ bytes: 1, ArrayType: Uint8Array, maximum: 0xff }),
  Uint16Array: Object.freeze({ bytes: 2, ArrayType: Uint16Array, maximum: 0xffff }),
  Uint32Array: Object.freeze({ bytes: 4, ArrayType: Uint32Array, maximum: 0xffff_ffff }),
});

const CHUNK_PREFIX = 'user-defined/codes/';
const COOPERATIVE_DECODE_BUDGET = 64 * 1024;
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

function throwIfAborted(signal) {
  if (signal !== null && signal.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }
}


function assertSignal(signal) {
  if (
    signal !== null
    && (
      typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
    )
  ) {
    throw new TypeError('User-defined codes signal must be an AbortSignal or null.');
  }
  return signal;
}

function writeRawCodes(out, offset, codes) {
  if (codes instanceof Uint8Array) {
    out.set(codes, offset);
    return;
  }
  const view = new DataView(out.buffer, out.byteOffset + offset, codes.length * codes.BYTES_PER_ELEMENT);
  if (codes instanceof Uint16Array) {
    for (let index = 0; index < codes.length; index++) view.setUint16(index * 2, codes[index], true);
  } else {
    for (let index = 0; index < codes.length; index++) view.setUint32(index * 4, codes[index], true);
  }
}

function encodeCodesBinary(codes) {
  if (!isCategoricalCodes(codes)) {
    throw new TypeError('User-defined codes must be Uint8Array, Uint16Array or Uint32Array.');
  }
  const codesLength = assertSafeInteger(
    codes.length,
    'User-defined codes length',
    { maximum: 0xffff_ffff }
  );
  const headerBytes = 1 + uvarintLength(codesLength);

  // One pass sizes the run encoding and finds the largest code.
  let runCount = 0;
  let runBytes = 0;
  let largest = 0;
  for (let index = 0; index < codesLength;) {
    const value = codes[index];
    let end = index + 1;
    while (end < codesLength && codes[end] === value) end++;
    runCount += 1;
    runBytes += uvarintLength(value) + uvarintLength(end - index);
    if (value > largest) largest = value;
    index = end;
  }
  runBytes += uvarintLength(runCount);
  const rawBytes = codesLength * codes.BYTES_PER_ELEMENT;
  const bits = largest < 2 ? 1 : largest < 4 ? 2 : largest < 16 ? 4 : 0;
  const packedBytes = bits === 0 ? Infinity : 1 + Math.ceil((codesLength * bits) / 8);
  const smallest = Math.min(rawBytes, runBytes, packedBytes);

  if (smallest === packedBytes) {
    const out = new Uint8Array(headerBytes + packedBytes);
    out[0] = ENC_PACKED;
    const body = writeUvarint(out, 1, codesLength);
    out[body] = bits;
    const perByte = 8 / bits;
    for (let index = 0; index < codesLength; index++) {
      out[body + 1 + Math.floor(index / perByte)] |= codes[index] << ((index % perByte) * bits);
    }
    return out;
  }
  if (smallest === runBytes) {
    const out = new Uint8Array(headerBytes + runBytes);
    out[0] = ENC_RUNS;
    let offset = writeUvarint(out, writeUvarint(out, 1, codesLength), runCount);
    for (let index = 0; index < codesLength;) {
      const value = codes[index];
      let end = index + 1;
      while (end < codesLength && codes[end] === value) end++;
      offset = writeUvarint(out, offset, value);
      offset = writeUvarint(out, offset, end - index);
      index = end;
    }
    return out;
  }
  const out = new Uint8Array(headerBytes + rawBytes);
  out[0] = ENC_RAW;
  writeRawCodes(out, writeUvarint(out, 1, codesLength), codes);
  return out;
}

async function decodeCodesBinary(bytes, options) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2) {
    throw new TypeError('Invalid user-defined codes payload.');
  }
  assertPlainRecord(options, 'User-defined codes decode options');
  const optionKeys = Object.keys(options).sort();
  const expectedOptionKeys = ['expectedCodesType', 'expectedLength', 'signal'];
  if (
    optionKeys.length !== expectedOptionKeys.length
    || optionKeys.some((key, index) => key !== expectedOptionKeys[index])
  ) {
    throw new TypeError(
      'User-defined codes decode options must contain exact expectedCodesType, expectedLength, signal keys.'
    );
  }
  const signal = assertSignal(options.signal);
  throwIfAborted(signal);
  const expectedLength = assertSafeInteger(
    options.expectedLength,
    'User-defined codes expectedLength',
    { maximum: 0xffff_ffff }
  );
  if (!Object.hasOwn(CODE_WIDTHS, options.expectedCodesType)) {
    throw new TypeError('User-defined codes expectedCodesType is unsupported.');
  }

  let offset = 0;
  const encoding = bytes[offset++];
  const lengthResult = decodeUvarint(bytes, offset);
  const length = lengthResult.value;
  offset = lengthResult.nextOffset;
  if (length !== expectedLength) {
    throw new RangeError(
      `User-defined codes length ${length} does not match pointCount ${expectedLength}.`
    );
  }

  const { ArrayType, bytes: elementBytes, maximum: maximumValue } =
    CODE_WIDTHS[options.expectedCodesType];

  if (encoding === ENC_PACKED) {
    const bits = bytes[offset++];
    if (bits !== 1 && bits !== 2 && bits !== 4) {
      throw new TypeError('Packed user-defined codes must use 1, 2 or 4 bits per code.');
    }
    if (bytes.byteLength - offset !== Math.ceil((length * bits) / 8)) {
      throw new Error('Invalid packed user-defined codes byte length or trailing bytes.');
    }
    const perByte = 8 / bits;
    const mask = (1 << bits) - 1;
    const codes = new ArrayType(length);
    for (let index = 0; index < length; index++) {
      codes[index] = (bytes[offset + Math.floor(index / perByte)] >>> ((index % perByte) * bits)) & mask;
      if (index + 1 < length && (index + 1) % COOPERATIVE_DECODE_BUDGET === 0) {
        await yieldToMacrotask();
        throwIfAborted(signal);
      }
    }
    const usedBits = (length * bits) % 8;
    if (usedBits !== 0 && (bytes[bytes.byteLength - 1] >>> usedBits) !== 0) {
      throw new Error('Packed user-defined codes set bits past their length.');
    }
    throwIfAborted(signal);
    return codes;
  }

  if (encoding === ENC_RAW) {
    if (bytes.byteLength - offset !== length * elementBytes) {
      throw new Error(`Invalid raw-u${elementBytes * 8} user-defined codes byte length or trailing bytes.`);
    }
    const codes = new ArrayType(length);
    if (elementBytes === 1) {
      codes.set(bytes.subarray(offset, offset + length));
    } else {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length * elementBytes);
      for (let index = 0; index < length; index++) {
        codes[index] = elementBytes === 2
          ? view.getUint16(index * 2, true)
          : view.getUint32(index * 4, true);
        if (index + 1 < length && (index + 1) % COOPERATIVE_DECODE_BUDGET === 0) {
          await yieldToMacrotask();
          throwIfAborted(signal);
        }
      }
    }
    throwIfAborted(signal);
    return codes;
  }

  if (encoding !== ENC_RUNS) {
    throw new TypeError(`Invalid user-defined codes encoding type ${encoding}.`);
  }
  const pairResult = decodeUvarint(bytes, offset);
  const pairCount = pairResult.value;
  offset = pairResult.nextOffset;
  if (
    (length === 0 && pairCount !== 0)
    || (length > 0 && (pairCount === 0 || pairCount > length))
  ) {
    throw new Error('Invalid user-defined RLE pair count.');
  }

  const codes = new ArrayType(length);
  let decodedLength = 0;
  let previousValue = null;
  let workSinceYield = 0;
  for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
    throwIfAborted(signal);
    const valueResult = decodeUvarint(bytes, offset);
    const value = valueResult.value;
    offset = valueResult.nextOffset;
    const runResult = decodeUvarint(bytes, offset);
    const run = runResult.value;
    offset = runResult.nextOffset;
    if (value > maximumValue) {
      throw new RangeError('User-defined RLE value exceeds its declared code type.');
    }
    if (run === 0) {
      throw new Error('User-defined RLE runs must be positive.');
    }
    if (previousValue === value) {
      throw new Error('User-defined RLE adjacent runs must have distinct values.');
    }
    decodedLength += run;
    if (!Number.isSafeInteger(decodedLength) || decodedLength > length) {
      throw new Error('User-defined RLE runs exceed the declared codes length.');
    }
    const runStart = decodedLength - run;
    let fillStart = runStart;
    while (fillStart < decodedLength) {
      const fillCount = Math.min(
        decodedLength - fillStart,
        COOPERATIVE_DECODE_BUDGET - workSinceYield
      );
      const fillEnd = fillStart + fillCount;
      codes.fill(value, fillStart, fillEnd);
      fillStart = fillEnd;
      workSinceYield += fillCount;
      if (
        workSinceYield === COOPERATIVE_DECODE_BUDGET
        && (
          fillStart < decodedLength
          || pairIndex + 1 < pairCount
        )
      ) {
        workSinceYield = 0;
        await yieldToMacrotask();
        throwIfAborted(signal);
      }
    }
    previousValue = value;
  }
  if (decodedLength !== length) {
    throw new Error('User-defined RLE runs do not fill the declared codes length.');
  }
  if (offset !== bytes.byteLength) {
    throw new Error('User-defined RLE payload contains trailing bytes.');
  }
  throwIfAborted(signal);
  return codes;
}

function getState(ctx, operation) {
  if (
    ctx === null
    || typeof ctx !== 'object'
    || ctx.state === null
    || typeof ctx.state !== 'object'
  ) {
    throw new TypeError(`User-defined codes ${operation} requires the current DataState owner.`);
  }
  return ctx.state;
}

export function capture(ctx) {
  const state = getState(ctx, 'capture');
  requireMethod(state, 'getUserDefinedFieldsRegistry', 'User-defined codes capture owner');
  const registry = state.getUserDefinedFieldsRegistry();
  requireMethod(registry, 'getAllFields', 'UserDefinedFieldsRegistry');
  const pointCount = assertSafeInteger(
    state.pointCount,
    'User-defined codes dataset pointCount',
    { minimum: 1 }
  );
  const criticalIds = getCriticalUserDefinedFieldIds(state);
  const fields = assertArray(
    registry.getAllFields(),
    'Current user-defined field inventory'
  );
  const fieldIds = new Set();
  const chunks = [];

  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field === null || typeof field !== 'object') {
      throw new TypeError(`User-defined field ${index} must be an object.`);
    }
    const fieldId = assertNonEmptyString(
      field._userDefinedId,
      `User-defined field ${index} id`
    );
    if (fieldIds.has(fieldId)) {
      throw new TypeError(`User-defined field id "${fieldId}" is duplicated.`);
    }
    fieldIds.add(fieldId);
    // A purged field released its codes, and nothing can restore it, so there
    // is no chunk to write. The id is still registered above, because the
    // tombstone in the metadata still names it.
    if (field._isPurged === true) continue;
    if (field.kind === 'continuous') continue;
    if (field.kind !== 'category') {
      throw new TypeError(`User-defined field "${fieldId}" has unsupported kind.`);
    }
    const fieldKey = assertNonEmptyString(
      field.key,
      `User-defined field "${fieldId}" key`
    );
    const codes = field.codes;
    if (!isCategoricalCodes(codes)) {
      throw new TypeError(`User-defined field "${fieldId}" requires exact typed codes.`);
    }
    if (codes.length !== pointCount) {
      throw new RangeError(
        `User-defined field "${fieldId}" codes length does not match pointCount.`
      );
    }

    chunks.push({
      id: `${CHUNK_PREFIX}${fieldId}`,
      contributorId: id,
      priority: criticalIds.has(fieldId) ? 'eager' : 'lazy',
      kind: 'binary',
      codec: 'gzip',
      label: `User-defined codes: ${fieldKey}`,
      datasetDependent: true,
      payload: encodeCodesBinary(codes)
    });
  }

  return chunks;
}

function collectInjectedFields(state, fieldId) {
  if (
    state.obsData === null
    || typeof state.obsData !== 'object'
    || !Array.isArray(state.obsData.fields)
    || state.varData === null
    || typeof state.varData !== 'object'
    || !Array.isArray(state.varData.fields)
    || !(state.viewContexts instanceof Map)
  ) {
    throw new TypeError('User-defined codes restore requires complete current field inventories.');
  }
  const copies = [];
  const collect = (fields, context) => {
    assertArray(fields, context);
    for (const field of fields) {
      if (field === null || typeof field !== 'object') {
        throw new TypeError(`${context} entries must be objects.`);
      }
      if (field._userDefinedId === fieldId) copies.push(field);
    }
  };
  collect(state.obsData.fields, 'Current obs fields');
  collect(state.varData.fields, 'Current var fields');
  for (const [viewId, context] of state.viewContexts) {
    const exactViewId = assertNonEmptyString(viewId, 'Snapshot view id');
    if (
      context === null
      || typeof context !== 'object'
      || context.obsData === null
      || typeof context.obsData !== 'object'
      || context.varData === null
      || typeof context.varData !== 'object'
    ) {
      throw new TypeError(`Snapshot view "${exactViewId}" field context is incomplete.`);
    }
    collect(context.obsData.fields, `Snapshot view "${exactViewId}" obs fields`);
    collect(context.varData.fields, `Snapshot view "${exactViewId}" var fields`);
  }
  return copies;
}

function getInventoryTracker(ctx) {
  const transaction = ctx.restoreTransaction;
  if (transaction === null || transaction === undefined) return null;
  if (typeof transaction !== 'object') {
    throw new TypeError(
      'User-defined codes restoreTransaction must be an object or null.'
    );
  }
  requireMethod(
    transaction,
    'get',
    'User-defined codes restore transaction'
  );
  let tracker;
  try {
    tracker = transaction.get(USER_DEFINED_CODES_RESTORE_TRANSACTION_ID);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new TypeError(
        'User-defined code chunks require the prior field-overlays inventory.'
      );
    }
    throw error;
  }
  requireMethod(
    tracker,
    'record',
    'User-defined code inventory tracker'
  );
  return tracker;
}

export async function restore(ctx, chunkMeta, payload) {
  const state = getState(ctx, 'restore');
  if (!(payload instanceof Uint8Array)) {
    throw new TypeError('User-defined codes payload must be a Uint8Array.');
  }
  assertExactKeys(
    chunkMeta,
    CHUNK_META_KEYS,
    'User-defined codes chunk metadata'
  );
  if (chunkMeta.contributorId !== id) {
    throw new TypeError(
      `User-defined codes contributorId must equal "${id}".`
    );
  }
  if (chunkMeta.priority !== 'eager' && chunkMeta.priority !== 'lazy') {
    throw new TypeError(
      'User-defined codes priority must be eager or lazy.'
    );
  }
  if (
    chunkMeta.kind !== 'binary'
    || chunkMeta.codec !== 'gzip'
    || chunkMeta.datasetDependent !== true
  ) {
    throw new TypeError(
      'User-defined codes chunks must be binary, gzip, and dataset-dependent.'
    );
  }
  const chunkId = assertNonEmptyString(chunkMeta.id, 'User-defined codes chunk id');
  if (!chunkId.startsWith(CHUNK_PREFIX)) {
    throw new TypeError(`User-defined codes chunk id must start with "${CHUNK_PREFIX}".`);
  }
  const fieldId = assertNonEmptyString(
    chunkId.slice(CHUNK_PREFIX.length),
    'User-defined codes field id'
  );
  const pointCount = assertSafeInteger(
    state.pointCount,
    'User-defined codes dataset pointCount',
    { minimum: 1 }
  );
  requireMethod(state, 'getUserDefinedFieldsRegistry', 'User-defined codes restore owner');
  requireMethod(state, 'getActiveField', 'User-defined codes restore owner');
  const registry = state.getUserDefinedFieldsRegistry();
  requireMethod(registry, 'getField', 'UserDefinedFieldsRegistry');
  const template = registry.getField(fieldId);
  if (template === null || template === undefined || typeof template !== 'object') {
    throw new RangeError(`User-defined field "${fieldId}" was not found.`);
  }
  if (
    template.kind !== 'category'
    || template._isUserDefined !== true
    || template._userDefinedId !== fieldId
  ) {
    throw new TypeError(`User-defined field "${fieldId}" metadata is inconsistent.`);
  }
  const fieldKey = assertNonEmptyString(
    template.key,
    `User-defined field "${fieldId}" key`
  );
  if (chunkMeta.label !== `User-defined codes: ${fieldKey}`) {
    throw new TypeError(
      `User-defined codes chunk label must match field "${fieldId}".`
    );
  }
  assertSafeInteger(
    chunkMeta.storedBytes,
    'User-defined codes chunk storedBytes'
  );
  const uncompressedBytes = assertSafeInteger(
    chunkMeta.uncompressedBytes,
    'User-defined codes chunk uncompressedBytes'
  );
  if (uncompressedBytes !== payload.byteLength) {
    throw new RangeError(
      'User-defined codes payload length must equal metadata uncompressedBytes.'
    );
  }
  if (template._codesLengthHint !== pointCount) {
    throw new RangeError(
      `User-defined field "${fieldId}" metadata length does not match pointCount.`
    );
  }
  if (
    template._codesTypeHint !== 'Uint8Array'
    && template._codesTypeHint !== 'Uint16Array'
    && template._codesTypeHint !== 'Uint32Array'
  ) {
    throw new TypeError(`User-defined field "${fieldId}" metadata code type is unsupported.`);
  }
  if (!(template.centroidsByLayout instanceof Map)) {
    throw new TypeError(
      `User-defined field "${fieldId}" centroidsByLayout must be a Map.`
    );
  }
  const copies = collectInjectedFields(state, fieldId);
  const active = state.getActiveField();
  const isActive = (
    active !== null
    && active !== undefined
    && typeof active === 'object'
    && active._isUserDefined === true
    && active._userDefinedId === fieldId
    && active.kind === 'category'
  );
  if (isActive) {
    for (const method of [
      'updateColorsCategorical',
      'buildCentroidsForField',
      'getActiveViewId',
      'getViewLayoutKey',
      '_pushColorsToViewer',
      '_pushCentroidsToViewer',
      'computeGlobalVisibility'
    ]) {
      requireMethod(state, method, 'Active user-defined field refresh owner');
    }
  }

  const signal = assertSignal(ctx.abortSignal);
  const inventoryTracker = getInventoryTracker(ctx);
  const codes = await decodeCodesBinary(payload, {
    expectedLength: pointCount,
    expectedCodesType: template._codesTypeHint,
    signal
  });

  // The decode proves the length and the width, which is what the bundle
  // declared - not that the codes name categories this field actually has.
  // Without this the array goes straight into the field and every reader after
  // it indexes past the end of the inventory.
  if (!Array.isArray(template.categories)) {
    throw new TypeError(
      `User-defined field "${fieldId}" has no category inventory to bound its codes.`
    );
  }
  requireCategoryCodes(
    codes,
    template.categories,
    pointCount,
    `User-defined field "${fieldId}"`
  );

  // A session stores codes, never centroids: compute them for every layout
  // whose positions are resident, as a field built in this session has them.
  const { centroidsByLayout, normalizedLayouts } = computeAllLayoutCentroids(
    codes,
    template.categories,
    state
  );
  template.codes = codes;
  template.loaded = true;
  template.centroidsByLayout = centroidsByLayout;
  template._normalizedLayouts = normalizedLayouts;
  delete template._codesLengthHint;
  delete template._codesTypeHint;
  for (const field of copies) {
    field.codes = codes;
    field.loaded = true;
    field.centroidsByLayout = template.centroidsByLayout;
    field._normalizedLayouts = template._normalizedLayouts;
    delete field._codesLengthHint;
    delete field._codesTypeHint;
  }

  if (isActive) {
    state.updateColorsCategorical(active);
    state.buildCentroidsForField(active, {
      viewId: state.getActiveViewId(),
      layoutKey: state.getViewLayoutKey(state.getActiveViewId())
    });
    state._pushColorsToViewer();
    state._pushCentroidsToViewer();
    state.computeGlobalVisibility();
  }
  if (inventoryTracker !== null) {
    inventoryTracker.record(fieldId, chunkMeta.priority);
  }
}
