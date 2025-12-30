/**
 * @fileoverview Session contributor: user-defined categorical codes arrays.
 *
 * Chunks:
 * - `user-defined/codes/<fieldId>` (binary + gzip)
 *
 * Priority split (per session-serializer-plan.md):
 * - EAGER only for fields needed to render the initial view (active coloring + multiview actives)
 * - LAZY for all other user-defined categorical fields
 *
 * Encoding (pre-gzip, small + dependency-free):
 * - 1 byte: encodingType
 *   - 0 = raw Uint8
 *   - 1 = raw Uint16
 *   - 2 = RLE pairs encoded as uvarints
 * - codesLength (uvarint)
 * - payload:
 *   - raw: `codesLength * bytesPerElement` bytes
 *   - RLE: pairCount (uvarint) followed by (value uvarint, runLength uvarint) pairs
 *
 * @module session/contributors/user-defined-codes
 */

import { decodeUvarint, pushUvarint } from '../codecs/varint.js';

export const id = 'user-defined-codes';

const ENC_RAW_U8 = 0;
const ENC_RAW_U16 = 1;
const ENC_RLE_UVARINT = 2;

/**
 * @param {AbortSignal | null | undefined} signal
 */
function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

/**
 * Encode codes into the most compact binary representation (pre-gzip).
 * @param {Uint8Array|Uint16Array} codes
 * @returns {Uint8Array}
 */
function encodeCodesBinary(codes) {
  const codesLength = codes.length >>> 0;
  const isU16 = codes instanceof Uint16Array;

  // Raw typed array payload.
  const rawHeader = [];
  rawHeader.push(isU16 ? ENC_RAW_U16 : ENC_RAW_U8);
  pushUvarint(codesLength, rawHeader);
  const rawBytes = new Uint8Array(codes.buffer, codes.byteOffset, codes.byteLength);
  const rawOut = new Uint8Array(rawHeader.length + rawBytes.byteLength);
  rawOut.set(rawHeader, 0);
  rawOut.set(rawBytes, rawHeader.length);

  // RLE payload (uvarint pairs).
  const rlePairsBytes = [];
  let pairCount = 0;
  if (codesLength > 0) {
    let current = codes[0];
    let run = 1;
    for (let i = 1; i < codesLength; i++) {
      const v = codes[i];
      if (v === current) {
        run += 1;
        continue;
      }
      pairCount += 1;
      pushUvarint(current, rlePairsBytes);
      pushUvarint(run, rlePairsBytes);
      current = v;
      run = 1;
    }
    pairCount += 1;
    pushUvarint(current, rlePairsBytes);
    pushUvarint(run, rlePairsBytes);
  }

  const rleHeader = [];
  rleHeader.push(ENC_RLE_UVARINT);
  pushUvarint(codesLength, rleHeader);
  pushUvarint(pairCount, rleHeader);

  const rleOut = new Uint8Array(rleHeader.length + rlePairsBytes.length);
  rleOut.set(rleHeader, 0);
  rleOut.set(rlePairsBytes, rleHeader.length);

  // Choose the smaller pre-gzip representation.
  return rleOut.byteLength < rawOut.byteLength ? rleOut : rawOut;
}

/**
 * Decode a codes payload produced by encodeCodesBinary().
 * @param {Uint8Array} bytes
 * @param {{ signal?: AbortSignal | null }} [options]
 * @returns {{ length: number, codes: Uint8Array|Uint16Array }}
 */
function decodeCodesBinary(bytes, options = {}) {
  const signal = options.signal ?? null;
  throwIfAborted(signal);

  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2) {
    throw new Error('Invalid user-defined codes payload (too short).');
  }

  let offset = 0;
  const enc = bytes[offset++];

  const lenRes = decodeUvarint(bytes, offset);
  const length = lenRes.value >>> 0;
  offset = lenRes.nextOffset;

  if (enc === ENC_RAW_U8) {
    const needed = length;
    if (offset + needed > bytes.byteLength) throw new Error('Invalid raw-u8 codes payload (truncated).');
    const slice = bytes.subarray(offset, offset + needed);
    return { length, codes: new Uint8Array(slice) };
  }

  if (enc === ENC_RAW_U16) {
    const needed = length * 2;
    if (offset + needed > bytes.byteLength) throw new Error('Invalid raw-u16 codes payload (truncated).');
    // Ensure we create a properly aligned Uint16Array; copy into a tight buffer.
    const buf = bytes.slice(offset, offset + needed).buffer;
    return { length, codes: new Uint16Array(buf) };
  }

  if (enc === ENC_RLE_UVARINT) {
    const pairRes = decodeUvarint(bytes, offset);
    const pairCount = pairRes.value >>> 0;
    offset = pairRes.nextOffset;

    // Default to Uint8 unless we see any value >= 256.
    let needsU16 = false;
    /** @type {Array<{ value: number, run: number }>} */
    const pairs = [];

    for (let p = 0; p < pairCount; p++) {
      throwIfAborted(signal);
      const vRes = decodeUvarint(bytes, offset);
      const value = vRes.value >>> 0;
      offset = vRes.nextOffset;
      const rRes = decodeUvarint(bytes, offset);
      const run = rRes.value >>> 0;
      offset = rRes.nextOffset;
      if (value >= 256) needsU16 = true;
      pairs.push({ value, run });
    }

    const out = needsU16 ? new Uint16Array(length) : new Uint8Array(length);
    let i = 0;
    for (const pair of pairs) {
      // Allow canceling very large decodes (keeps UI responsive on huge sessions).
      throwIfAborted(signal);
      const end = Math.min(length, i + pair.run);
      for (; i < end; i++) {
        if ((i & 0x3fff) === 0) throwIfAborted(signal);
        out[i] = pair.value;
      }
      if (i >= length) break;
    }

    return { length, codes: out };
  }

  throw new Error(`Invalid user-defined codes encodingType: ${enc}`);
}

/**
 * Compute which user-defined categorical field IDs are required for the initial view.
 * @param {any} state
 * @returns {Set<string>}
 */
function getCriticalUserDefinedFieldIds(state) {
  /** @type {Set<string>} */
  const ids = new Set();

  // Live active field.
  const active = state?.getActiveField?.();
  if (active?._isUserDefined && active?._userDefinedId && active?.kind === 'category') {
    ids.add(String(active._userDefinedId));
  }

  // Active fields in snapshot view contexts (multiview).
  const contexts = state?.viewContexts instanceof Map ? state.viewContexts : null;
  if (contexts) {
    for (const ctx of contexts.values()) {
      const source = ctx?.activeFieldSource;
      if (source === 'obs' && ctx?.activeFieldIndex >= 0) {
        const f = ctx?.obsData?.fields?.[ctx.activeFieldIndex];
        if (f?._isUserDefined && f?._userDefinedId && f?.kind === 'category') {
          ids.add(String(f._userDefinedId));
        }
      }
      if (source === 'var' && ctx?.activeVarFieldIndex >= 0) {
        const f = ctx?.varData?.fields?.[ctx.activeVarFieldIndex];
        if (f?._isUserDefined && f?._userDefinedId && f?.kind === 'category') {
          ids.add(String(f._userDefinedId));
        }
      }
    }
  }

  return ids;
}

/**
 * Capture user-defined categorical codes as binary chunks.
 * @param {object} ctx
 * @returns {import('../session-serializer.js').SessionChunk[]}
 */
export function capture(ctx) {
  const state = ctx?.state;
  const registry = state?.getUserDefinedFieldsRegistry?.();
  if (!state || !registry?.getAllFields) return [];

  const criticalIds = getCriticalUserDefinedFieldIds(state);

  /** @type {import('../session-serializer.js').SessionChunk[]} */
  const chunks = [];

  for (const field of registry.getAllFields()) {
    if (!field || field.kind !== 'category') continue;
    const fieldId = String(field._userDefinedId || '').trim();
    if (!fieldId) continue;

    const codes = field.codes;
    if (!(codes instanceof Uint8Array || codes instanceof Uint16Array)) continue;
    if (codes.length === 0) continue;

    const payload = encodeCodesBinary(codes);
    const priority = criticalIds.has(fieldId) ? 'eager' : 'lazy';

    chunks.push({
      id: `user-defined/codes/${fieldId}`,
      contributorId: id,
      priority,
      kind: 'binary',
      codec: 'gzip',
      label: `User-defined codes: ${field.key || fieldId}`,
      datasetDependent: true,
      payload
    });
  }

  return chunks;
}

/**
 * Restore user-defined categorical codes into the registry + injected field clones.
 * @param {object} ctx
 * @param {any} chunkMeta
 * @param {Uint8Array} payload
 */
export function restore(ctx, chunkMeta, payload) {
  const state = ctx?.state;
  if (!state || !(payload instanceof Uint8Array)) return;

  const signal = ctx.abortSignal ?? null;
  throwIfAborted(signal);

  const chunkId = String(chunkMeta?.id || '').trim();
  const fieldId = chunkId.startsWith('user-defined/codes/') ? chunkId.slice('user-defined/codes/'.length) : '';
  if (!fieldId) return;

  const { length, codes } = decodeCodesBinary(payload, { signal });

  // Sanity: user-defined codes must align with the current dataset.
  const expected = typeof state.pointCount === 'number' ? state.pointCount : null;
  if (expected != null && length !== expected) {
    console.warn(`[SessionSerializer] Skipping user-defined codes '${fieldId}' (length ${length} != pointCount ${expected}).`);
    return;
  }

  // Update registry template.
  const registry = state.getUserDefinedFieldsRegistry?.();
  const template = registry?.getField?.(fieldId) || null;
  if (template) {
    template.codes = codes;
    template.loaded = true;
    template._codesLengthHint = length;
    template._codesTypeHint = codes.constructor?.name || template._codesTypeHint;
  }

  // Update injected copies in the live field lists.
  const updateFieldObject = (f) => {
    if (!f || f._userDefinedId !== fieldId) return;
    f.codes = codes;
    f.loaded = true;
    if (template?.centroidsByDim) f.centroidsByDim = template.centroidsByDim;
  };

  for (const f of (state.obsData?.fields || [])) updateFieldObject(f);
  for (const f of (state.varData?.fields || [])) updateFieldObject(f);

  // Update all stored view contexts too (snapshots clone field objects).
  if (state.viewContexts instanceof Map) {
    for (const ctxEntry of state.viewContexts.values()) {
      for (const f of (ctxEntry?.obsData?.fields || [])) updateFieldObject(f);
      for (const f of (ctxEntry?.varData?.fields || [])) updateFieldObject(f);
    }
  }

  // If this field is currently active, push updated colors to the viewer.
  const active = state.getActiveField?.();
  if (active?._isUserDefined && String(active._userDefinedId) === fieldId && active.kind === 'category') {
    try {
      state.updateColorsCategorical?.(active);
      state.buildCentroidsForField?.(active);
      state._pushColorsToViewer?.();
      state._pushCentroidsToViewer?.();
      state.computeGlobalVisibility?.();
    } catch (err) {
      console.warn('[SessionSerializer] Failed to refresh active user-defined field after codes restore:', err);
    }
  }
}
