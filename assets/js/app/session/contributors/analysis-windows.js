/**
 * @fileoverview Session contributor: floating analysis windows.
 *
 * EAGER chunk (dataset-dependent):
 * - Reopen floating analysis windows with their modeId + geometry + settings.
 *
 * Uses AnalysisWindowManager public APIs added for session restore:
 * - exportSessionWindows()
 * - createFromSessionDescriptor()
 *
 * @module session/contributors/analysis-windows
 */

export const id = 'analysis-windows';

/**
 * Capture all floating analysis windows.
 * @param {object} ctx
 * @returns {import('../session-serializer.js').SessionChunk[]}
 */
export function capture(ctx) {
  const mgr = ctx?.analysisWindowManager;
  if (!mgr?.exportSessionWindows) return [];

  const windows = mgr.exportSessionWindows();
  return [
    {
      id: 'analysis/windows',
      contributorId: id,
      priority: 'eager',
      kind: 'json',
      codec: 'gzip',
      label: 'Analysis windows',
      datasetDependent: true,
      payload: { windows }
    }
  ];
}

/**
 * Restore floating analysis windows from descriptors.
 * @param {object} ctx
 * @param {any} _chunkMeta
 * @param {{ windows?: any[] }} payload
 */
export function restore(ctx, _chunkMeta, payload) {
  const mgr = ctx?.analysisWindowManager;
  if (!mgr?.createFromSessionDescriptor || !Array.isArray(payload?.windows)) return;

  // Idempotency: restore into a clean slate.
  try { mgr.closeAll?.(); } catch { /* ignore */ }

  for (const desc of payload.windows) {
    try { mgr.createFromSessionDescriptor(desc); } catch (err) {
      console.warn('[SessionSerializer] Failed to restore analysis window:', err);
    }
  }
}

