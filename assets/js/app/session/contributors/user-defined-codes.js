/**
 * @fileoverview Exact binary user-defined categorical code arrays.
 *
 * @module session/contributors/user-defined-codes
 */

import { decodeUvarint, pushUvarint } from '../codecs/varint.js';
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

export const id = 'user-defined-codes';

const ENC_RAW_U8 = 0;
const ENC_RAW_U16 = 1;
const ENC_RLE_U8 = 2;
const ENC_RLE_U16 = 3;
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

function yieldToMacrotask() {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
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

function encodeRawCodes(codes) {
  if (codes instanceof Uint8Array) {
    return new Uint8Array(codes);
  }
  const bytes = new Uint8Array(codes.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < codes.length; index++) {
    view.setUint16(index * 2, codes[index], true);
  }
  return bytes;
}

function encodeCodesBinary(codes) {
  if (!(codes instanceof Uint8Array) && !(codes instanceof Uint16Array)) {
    throw new TypeError('User-defined codes must be Uint8Array or Uint16Array.');
  }
  const codesLength = assertSafeInteger(
    codes.length,
    'User-defined codes length',
    { maximum: 0xffff_ffff }
  );
  const isU16 = codes instanceof Uint16Array;

  const rawHeader = [isU16 ? ENC_RAW_U16 : ENC_RAW_U8];
  pushUvarint(codesLength, rawHeader);
  const rawBytes = encodeRawCodes(codes);
  const rawOut = new Uint8Array(rawHeader.length + rawBytes.byteLength);
  rawOut.set(rawHeader, 0);
  rawOut.set(rawBytes, rawHeader.length);

  const rlePairsBytes = [];
  let pairCount = 0;
  if (codesLength > 0) {
    let current = codes[0];
    let run = 1;
    for (let index = 1; index < codesLength; index++) {
      const value = codes[index];
      if (value === current) {
        run += 1;
      } else {
        pairCount += 1;
        pushUvarint(current, rlePairsBytes);
        pushUvarint(run, rlePairsBytes);
        current = value;
        run = 1;
      }
    }
    pairCount += 1;
    pushUvarint(current, rlePairsBytes);
    pushUvarint(run, rlePairsBytes);
  }

  const rleHeader = [isU16 ? ENC_RLE_U16 : ENC_RLE_U8];
  pushUvarint(codesLength, rleHeader);
  pushUvarint(pairCount, rleHeader);
  const rleOut = new Uint8Array(rleHeader.length + rlePairsBytes.length);
  rleOut.set(rleHeader, 0);
  rleOut.set(rlePairsBytes, rleHeader.length);
  return rleOut.byteLength < rawOut.byteLength ? rleOut : rawOut;
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
  if (
    options.expectedCodesType !== 'Uint8Array'
    && options.expectedCodesType !== 'Uint16Array'
  ) {
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

  const isU8 = encoding === ENC_RAW_U8 || encoding === ENC_RLE_U8;
  const isU16 = encoding === ENC_RAW_U16 || encoding === ENC_RLE_U16;
  if (!isU8 && !isU16) {
    throw new TypeError(`Invalid user-defined codes encoding type ${encoding}.`);
  }
  const actualCodesType = isU8 ? 'Uint8Array' : 'Uint16Array';
  if (actualCodesType !== options.expectedCodesType) {
    throw new TypeError(
      `User-defined codes encoding type ${actualCodesType} does not match field metadata ${options.expectedCodesType}.`
    );
  }

  if (encoding === ENC_RAW_U8) {
    if (bytes.byteLength - offset !== length) {
      throw new Error('Invalid raw-u8 user-defined codes byte length or trailing bytes.');
    }
    const codes = new Uint8Array(length);
    for (
      let outputOffset = 0;
      outputOffset < length;
      outputOffset += COOPERATIVE_DECODE_BUDGET
    ) {
      throwIfAborted(signal);
      const end = Math.min(
        outputOffset + COOPERATIVE_DECODE_BUDGET,
        length
      );
      codes.set(
        bytes.subarray(offset + outputOffset, offset + end),
        outputOffset
      );
      if (end < length) {
        await yieldToMacrotask();
      }
    }
    throwIfAborted(signal);
    return codes;
  }

  if (encoding === ENC_RAW_U16) {
    if (bytes.byteLength - offset !== length * 2) {
      throw new Error('Invalid raw-u16 user-defined codes byte length or trailing bytes.');
    }
    const codes = new Uint16Array(length);
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length * 2);
    for (let index = 0; index < length; index++) {
      throwIfAborted(signal);
      codes[index] = view.getUint16(index * 2, true);
      if (
        index + 1 < length
        && (index + 1) % COOPERATIVE_DECODE_BUDGET === 0
      ) {
        await yieldToMacrotask();
      }
    }
    throwIfAborted(signal);
    return codes;
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

  const codes = isU8 ? new Uint8Array(length) : new Uint16Array(length);
  let decodedLength = 0;
  let previousValue = null;
  const maximumValue = isU8 ? 0xff : 0xffff;
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
    if (field.kind === 'continuous') continue;
    if (field.kind !== 'category') {
      throw new TypeError(`User-defined field "${fieldId}" has unsupported kind.`);
    }
    const fieldKey = assertNonEmptyString(
      field.key,
      `User-defined field "${fieldId}" key`
    );
    const codes = field.codes;
    if (!(codes instanceof Uint8Array) && !(codes instanceof Uint16Array)) {
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
  ) {
    throw new TypeError(`User-defined field "${fieldId}" metadata code type is unsupported.`);
  }
  assertPlainRecord(
    template.centroidsByDim,
    `User-defined field "${fieldId}" centroidsByDim`
  );
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

  template.codes = codes;
  template.loaded = true;
  delete template._codesLengthHint;
  delete template._codesTypeHint;
  for (const field of copies) {
    field.codes = codes;
    field.loaded = true;
    field.centroidsByDim = template.centroidsByDim;
    delete field._codesLengthHint;
    delete field._codesTypeHint;
  }

  if (isActive) {
    state.updateColorsCategorical(active);
    state.buildCentroidsForField(active, { viewId: state.getActiveViewId() });
    state._pushColorsToViewer();
    state._pushCentroidsToViewer();
    state.computeGlobalVisibility();
  }
  if (inventoryTracker !== null) {
    inventoryTracker.record(fieldId, chunkMeta.priority);
  }
}
