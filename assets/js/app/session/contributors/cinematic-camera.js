/**
 * @fileoverview Session contributor: cinematic camera (keyframes + path settings).
 *
 * EAGER chunk (dataset-dependent):
 * - Restores keyframes, loop-back state, and the next-index counter so the
 *   cinematic camera path is immediately available after session load.
 *
 * @module session/contributors/cinematic-camera
 */

export const id = 'cinematic-camera';

/**
 * Capture cinematic camera keyframes and path state.
 * @param {object} ctx
 * @returns {import('../session-serializer.js').SessionChunk[]}
 */
export function capture(ctx) {
  const cam = ctx?.cinematicCamera;
  if (!cam?.exportSessionState) return [];

  const data = cam.exportSessionState();
  if (!data?.keyframes?.length) return [];

  return [
    {
      id: 'cinematic/camera',
      contributorId: id,
      priority: 'eager',
      kind: 'json',
      codec: 'gzip',
      label: 'Cinematic camera path',
      datasetDependent: true,
      payload: data
    }
  ];
}

/**
 * Restore cinematic camera keyframes and path state.
 * @param {object} ctx
 * @param {any} _chunkMeta
 * @param {object} payload
 */
export function restore(ctx, _chunkMeta, payload) {
  const cam = ctx?.cinematicCamera;
  if (!cam?.restoreSessionState || !payload) return;

  try {
    cam.restoreSessionState(payload);
  } catch (err) {
    console.warn('[SessionSerializer] Failed to restore cinematic camera state:', err);
  }
}
