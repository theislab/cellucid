/**
 * @fileoverview Delta + uvarint codec for sorted index sets.
 *
 * Used for highlight memberships:
 *  1) count (uvarint)
 *  2) `count` deltas (uvarint), where:
 *     - indices are sorted ascending
 *     - d0 = idx0
 *     - di = idxi - idx(i-1) for i > 0
 *
 * This pre-gzip binary format is compact, fast, and cross-language friendly.
 *
 * @module session/codecs/delta-varint
 */

import { decodeUvarint, pushUvarint } from './varint.js';
import {
  assertExactKeys,
  assertNullableSafeInteger,
  assertPlainRecord
} from '../schema-contract.js';

const COOPERATIVE_DECODE_BUDGET = 64 * 1024;

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

/**
 * Ensure indices are a sorted Uint32Array.
 * @param {ArrayLike<number>} indices
 * @returns {Uint32Array}
 */
function toSortedUint32(indices) {
  if (
    indices === null
    || typeof indices !== 'object'
    || !Number.isSafeInteger(indices.length)
    || indices.length < 0
  ) {
    throw new TypeError('Delta-uvarint indices must be an exact array-like collection.');
  }
  const values = new Array(indices.length);
  const n = indices.length;
  for (let i = 0; i < n; i++) {
    const v = indices[i];
    if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) {
      throw new TypeError(`Delta-uvarint index at ${i} must be an unsigned 32-bit integer.`);
    }
    values[i] = v;
  }
  values.sort((a, b) => a - b);
  for (let i = 1; i < values.length; i++) {
    if (values[i] === values[i - 1]) {
      throw new TypeError('Delta-uvarint indices must be a strict set without duplicates.');
    }
  }
  return new Uint32Array(values);
}

/**
 * Encode a sorted index set into delta+uvarint bytes (pre-gzip).
 * @param {ArrayLike<number>} indices
 * @returns {Uint8Array}
 */
export function encodeDeltaUvarint(indices) {
  const sorted = toSortedUint32(indices);
  const count = sorted.length;

  /** @type {number[]} */
  const bytes = [];
  pushUvarint(count, bytes);

  let prev = 0;
  for (let i = 0; i < count; i++) {
    const idx = sorted[i];
    const delta = i === 0 ? idx : (idx - prev);
    pushUvarint(delta, bytes);
    prev = idx;
  }

  return new Uint8Array(bytes);
}

/**
 * Decode delta+uvarint bytes (pre-gzip) into a Uint32Array.
 *
 * @param {Uint8Array} bytes
 * @param {{ maxCount: number|null, maxIndex: number|null, signal: AbortSignal|null }} options
 * @returns {Promise<Uint32Array>}
 */
export async function decodeDeltaUvarint(bytes, options) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('decodeDeltaUvarint: expected Uint8Array.');
  }
  assertPlainRecord(options, 'Delta-uvarint decode options');
  assertExactKeys(
    options,
    ['maxCount', 'maxIndex', 'signal'],
    'Delta-uvarint decode options'
  );
  const maxCount = assertNullableSafeInteger(
    options.maxCount,
    'Delta-uvarint maxCount'
  );
  const maxIndex = assertNullableSafeInteger(
    options.maxIndex,
    'Delta-uvarint maxIndex',
    { maximum: 0xffff_ffff }
  );
  const signal = options.signal;
  if (
    signal !== null
    && (
      typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
    )
  ) {
    throw new TypeError('Delta-uvarint signal must be an AbortSignal or null.');
  }
  throwIfAborted(signal);

  let offset = 0;
  const countRes = decodeUvarint(bytes, offset);
  const count = countRes.value;
  offset = countRes.nextOffset;

  if (maxCount != null && count > maxCount) {
    throw new Error(`decodeDeltaUvarint: count ${count} exceeds maxCount ${maxCount}.`);
  }

  const out = new Uint32Array(count);
  let acc = 0;
  let lastYieldOffset = offset;

  for (let i = 0; i < count; i++) {
    throwIfAborted(signal);
    const { value: delta, nextOffset } = decodeUvarint(bytes, offset);
    offset = nextOffset;
    if (i > 0 && delta === 0) {
      throw new Error('decodeDeltaUvarint: decoded indices must be strictly increasing.');
    }
    acc += delta;
    if (!Number.isInteger(acc) || acc > 0xffff_ffff) {
      throw new Error('decodeDeltaUvarint: decoded index exceeds uint32 range.');
    }
    if (maxIndex != null && acc > maxIndex) {
      throw new Error(`decodeDeltaUvarint: index ${acc} exceeds maxIndex ${maxIndex}.`);
    }
    out[i] = acc;
    if (
      i + 1 < count
      && (
        (i + 1) % COOPERATIVE_DECODE_BUDGET === 0
        || offset - lastYieldOffset >= COOPERATIVE_DECODE_BUDGET
      )
    ) {
      lastYieldOffset = offset;
      await yieldToMacrotask();
      throwIfAborted(signal);
    }
  }

  if (offset !== bytes.byteLength) {
    throw new Error('decodeDeltaUvarint: trailing bytes are not allowed.');
  }
  throwIfAborted(signal);
  return out;
}
