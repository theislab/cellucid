/**
 * @fileoverview Session contributor: highlight group cell memberships.
 *
 * LAZY chunks (dataset-dependent):
 * - One chunk per highlight group: `highlights/cells/<groupId>`
 * - Payload is delta+uvarint encoded indices, then gzip compressed by the bundle codec.
 *
 * Restore strategy:
 * - Decode into a Uint32Array
 * - Attach to the existing group shell created by `highlights/meta`
 * - Batch highlight recompute + notifications to avoid UI thrash
 *
 * @module session/contributors/highlights-cells
 */

import { encodeDeltaUvarint, decodeDeltaUvarint } from '../codecs/delta-varint.js';

export const id = 'highlights-cells';

// Coalesce expensive highlight recomputations to at most once per animation frame.
const scheduledByState = new WeakMap();

/**
 * @param {any} state
 */
function scheduleHighlightRecompute(state) {
  if (!state) return;
  if (typeof requestAnimationFrame !== 'function') {
    throw new Error('Session restore requires requestAnimationFrame (dev-phase requirement).');
  }

  if (scheduledByState.has(state)) return;

  const handle = requestAnimationFrame(() => {
    scheduledByState.delete(state);
    try { state._recomputeHighlightArray?.(); } catch (err) {
      console.warn('[SessionSerializer] Highlight recompute failed:', err);
    }
    try { state._notifyHighlightChange?.(); } catch {}
  });

  scheduledByState.set(state, handle);
}

/**
 * Capture highlight memberships as one chunk per group.
 * @param {object} ctx
 * @returns {import('../session-serializer.js').SessionChunk[]}
 */
export function capture(ctx) {
  const state = ctx?.state;
  if (!state?.getHighlightPages) return [];

  /** @type {import('../session-serializer.js').SessionChunk[]} */
  const chunks = [];

  const pages = state.getHighlightPages() || [];
  for (const page of pages) {
    for (const group of (page?.highlightedGroups || [])) {
      const groupId = String(group?.id || '').trim();
      if (!groupId) continue;

      const indices = group?.cellIndices;
      if (!indices || indices.length === 0) continue;

      // Encode indices compactly (sorted -> delta -> uvarint).
      const bytes = encodeDeltaUvarint(indices);

      chunks.push({
        id: `highlights/cells/${groupId}`,
        contributorId: id,
        priority: 'lazy',
        kind: 'binary',
        codec: 'gzip',
        label: `Highlight cells: ${group?.label || groupId}`,
        datasetDependent: true,
        payload: bytes
      });
    }
  }

  return chunks;
}

/**
 * Restore a single highlight membership chunk.
 * @param {object} ctx
 * @param {any} chunkMeta
 * @param {Uint8Array} payload
 */
export function restore(ctx, chunkMeta, payload) {
  const state = ctx?.state;
  if (!state || !(payload instanceof Uint8Array)) return;

  const chunkId = String(chunkMeta?.id || '').trim();
  const groupId = chunkId.startsWith('highlights/cells/') ? chunkId.slice('highlights/cells/'.length) : '';
  if (!groupId) return;

  // Find the group shell by id (created by `highlights/meta`).
  let targetGroup = null;
  for (const page of (state.highlightPages || [])) {
    const match = (page?.highlightedGroups || []).find?.((g) => g?.id === groupId) || null;
    if (match) {
      targetGroup = match;
      break;
    }
  }
  if (!targetGroup) {
    console.warn(`[SessionSerializer] Highlight group not found for cells chunk: ${groupId}`);
    return;
  }

  // Decode indices with simple bounds checks.
  const maxIndex = typeof state.pointCount === 'number' && state.pointCount > 0 ? state.pointCount - 1 : null;
  const decoded = decodeDeltaUvarint(payload, {
    maxCount: typeof state.pointCount === 'number' ? state.pointCount : undefined,
    maxIndex: typeof maxIndex === 'number' ? maxIndex : undefined,
    signal: ctx.abortSignal ?? null
  });

  targetGroup.cellIndices = decoded;
  targetGroup.cellCount = decoded.length;

  scheduleHighlightRecompute(state);
}
