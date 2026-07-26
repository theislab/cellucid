/**
 * @fileoverview Session contributor: cinematic camera (keyframes + path settings).
 *
 * EAGER chunk (dataset-dependent):
 * - Restores keyframes, loop-back state, and the next-index counter so the
 *   cinematic camera path is immediately available after session load.
 *
 * @module session/contributors/cinematic-camera
 */

import { assertCameraPathSessionState } from '../../ui/modules/cinematic-camera/index.js';
import { requireMethod } from '../schema-contract.js';

export const id = 'cinematic-camera';

/**
 * Capture cinematic camera keyframes and path state.
 * @param {object} ctx
 * @returns {import('../session-serializer.js').SessionChunk[]}
 */
export function capture(ctx) {
  if (ctx === null || typeof ctx !== 'object') {
    throw new TypeError('Cinematic camera capture requires a session context.');
  }
  const cam = ctx.cinematicCamera;
  requireMethod(cam, 'exportSessionState', 'Cinematic camera capture owner');

  const data = assertCameraPathSessionState(cam.exportSessionState());
  if (data.keyframes.length === 0) return [];

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
  if (ctx === null || typeof ctx !== 'object') {
    throw new TypeError('Cinematic camera restore requires a session context.');
  }
  const cam = ctx.cinematicCamera;
  requireMethod(cam, 'restoreSessionState', 'Cinematic camera restore owner');
  assertCameraPathSessionState(payload);
  cam.restoreSessionState(payload);
}
