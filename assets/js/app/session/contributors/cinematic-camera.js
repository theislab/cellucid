/**
 * @fileoverview Session contributor: cinematic camera (keyframes + path settings).
 *
 * EAGER chunk (dataset-dependent):
 * - Restores keyframes, loop-back state, autoplay, and the next-index counter.
 * - Starts enabled autoplay only after the complete restore transaction commits.
 *
 * @module session/contributors/cinematic-camera
 */

import { assertCameraPathSessionState } from '../../ui/modules/cinematic-camera/index.js';
import { requireMethod } from '../schema-contract.js';

export const id = 'cinematic-camera';
const AUTOPLAY_PARTICIPANT_ID = 'cinematic-camera/autoplay';

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
  const data = assertCameraPathSessionState(payload);

  if (data.autoplay) {
    const transaction = ctx.restoreTransaction;
    if (transaction === null || typeof transaction !== 'object') {
      throw new TypeError(
        'Cinematic camera autoplay restore requires the session restore transaction.'
      );
    }
    requireMethod(
      transaction,
      'register',
      'Cinematic camera autoplay transaction'
    );
    requireMethod(cam, 'startAutoplay', 'Cinematic camera autoplay owner');
    requireMethod(cam, 'stopAutoplay', 'Cinematic camera autoplay owner');

    let started = false;
    transaction.register(AUTOPLAY_PARTICIPANT_ID, {
      value: data.autoplay,
      prepare() {},
      commit() {
        const result = cam.startAutoplay();
        if (typeof result !== 'boolean') {
          throw new TypeError(
            'Cinematic camera autoplay owner must report a boolean start result.'
          );
        }
        started = result;
      },
      rollback() {
        if (started) cam.stopAutoplay();
      }
    });
  }

  cam.restoreSessionState(data);
}
