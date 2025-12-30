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

/**
 * Ensure indices are a sorted Uint32Array.
 * @param {ArrayLike<number>} indices
 * @returns {Uint32Array}
 */
function toSortedUint32(indices) {
  const n = indices?.length ?? 0;
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const v = indices[i];
    const num = Number(v);
    if (!Number.isFinite(num) || num < 0) {
      throw new Error(`Invalid index at ${i}: ${v}`);
    }
    out[i] = num >>> 0;
  }
  // TypedArray#sort is supported in modern browsers and is stable enough for our needs.
  out.sort();
  return out;
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
 * @param {{ maxCount?: number, maxIndex?: number }} [options]
 * @returns {Uint32Array}
 */
export function decodeDeltaUvarint(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('decodeDeltaUvarint: expected Uint8Array.');
  }

  const maxCount = typeof options.maxCount === 'number' ? options.maxCount : null;
  const maxIndex = typeof options.maxIndex === 'number' ? options.maxIndex : null;
  const signal = options.signal ?? null;

  let offset = 0;
  const countRes = decodeUvarint(bytes, offset);
  const count = countRes.value;
  offset = countRes.nextOffset;

  if (maxCount != null && count > maxCount) {
    throw new Error(`decodeDeltaUvarint: count ${count} exceeds maxCount ${maxCount}.`);
  }

  const out = new Uint32Array(count);
  let acc = 0;

  for (let i = 0; i < count; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const { value: delta, nextOffset } = decodeUvarint(bytes, offset);
    offset = nextOffset;
    acc += delta;
    if (maxIndex != null && acc > maxIndex) {
      throw new Error(`decodeDeltaUvarint: index ${acc} exceeds maxIndex ${maxIndex}.`);
    }
    out[i] = acc >>> 0;
  }

  // Extra trailing bytes are allowed (future extensions / padding), but we
  // keep them ignored intentionally for robustness.
  return out;
}
