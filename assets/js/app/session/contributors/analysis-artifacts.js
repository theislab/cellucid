/**
 * @fileoverview Session contributor: analysis caches + artifacts.
 *
 * LAZY chunks (dataset-dependent):
 * - `analysis/artifacts/<artifactId>` (binary + gzip)
 *
 * Dev-phase implementation:
 * - Persist DataLayer bulk gene cache entries (the most expensive analysis cache).
 * - Store each gene+page payload as a compact 2-column table:
 *   - cellIndex (uint32)
 *   - value (float32)
 *
 * Restore:
 * - Decode table
 * - Incrementally import via DataLayer.importSessionCache()
 *
 * @module session/contributors/analysis-artifacts
 */

import { encodeTable, decodeTable } from '../codecs/table-codec.js';

export const id = 'analysis-artifacts';

/**
 * Encode a string for safe inclusion in a chunk id segment.
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
  return encodeURIComponent(String(s || ''));
}

/**
 * Decode an encoded chunk-id segment.
 * @param {string} s
 * @returns {string}
 */
function unesc(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * Capture analysis artifacts as lazily-restored chunks.
 * @param {object} ctx
 * @returns {import('../session-serializer.js').SessionChunk[]}
 */
export function capture(ctx) {
  const dataLayer = ctx?.comparisonModule?.dataLayer || null;
  if (!dataLayer?.exportSessionCache) return [];

  const artifacts = dataLayer.exportSessionCache();
  if (!Array.isArray(artifacts) || artifacts.length === 0) return [];

  /** @type {import('../session-serializer.js').SessionChunk[]} */
  const chunks = [];

  for (const a of artifacts) {
    if (!a || a.kind !== 'bulk-gene') continue;
    if (!(a.values instanceof Float32Array) || !(a.cellIndices instanceof Uint32Array)) continue;
    if (a.values.length !== a.cellIndices.length) continue;

    const cacheKey = String(a.cacheKey || '').trim();
    const gene = String(a.gene || '').trim();
    const pageId = String(a.pageId || '').trim();
    if (!cacheKey || !gene || !pageId) continue;

    // Small, self-describing columnar table (pre-gzip).
    const payload = encodeTable({
      rowCount: a.values.length,
      columns: [
        { name: 'cellIndex', dtype: 'uint32', data: a.cellIndices },
        { name: 'value', dtype: 'float32', data: a.values }
      ]
    });

    chunks.push({
      id: `analysis/artifacts/bulk-gene/${esc(cacheKey)}/${esc(gene)}/${esc(pageId)}`,
      contributorId: id,
      priority: 'lazy',
      kind: 'binary',
      codec: 'gzip',
      label: `Analysis cache: ${gene} (${pageId})`,
      datasetDependent: true,
      payload
    });
  }

  return chunks;
}

/**
 * Restore a single analysis artifact chunk.
 * @param {object} ctx
 * @param {any} chunkMeta
 * @param {Uint8Array} payload
 */
export function restore(ctx, chunkMeta, payload) {
  const dataLayer = ctx?.comparisonModule?.dataLayer || null;
  if (!dataLayer?.importSessionCache) return;
  if (!(payload instanceof Uint8Array)) return;

  const chunkId = String(chunkMeta?.id || '').trim();
  if (!chunkId.startsWith('analysis/artifacts/bulk-gene/')) return;

  // Parse identifiers from the chunk id.
  const parts = chunkId.split('/');
  const cacheKey = unesc(parts[3] || '');
  const gene = unesc(parts[4] || '');
  const pageId = unesc(parts[5] || '');
  if (!cacheKey || !gene || !pageId) return;

  const table = decodeTable(payload);
  const cellIndex = table.columns?.cellIndex;
  const value = table.columns?.value;

  if (!(cellIndex instanceof Uint32Array) || !(value instanceof Float32Array)) return;
  if (cellIndex.length !== value.length) return;

  dataLayer.importSessionCache({
    kind: 'bulk-gene',
    cacheKey,
    gene,
    pageId,
    pageName: pageId,
    cellCount: cellIndex.length,
    timestamp: Date.now(),
    geneCount: 0,
    values: value,
    cellIndices: cellIndex
  });
}

