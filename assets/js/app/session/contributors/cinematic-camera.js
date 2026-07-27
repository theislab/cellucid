/**
 * @fileoverview Session contributor: cinematic camera (keyframes + path settings).
 *
 * EAGER chunk (dataset-dependent):
 * - Restores keyframes, loop-back state, autoplay, and the next-index counter.
 * - Starts enabled autoplay only after the complete restore transaction commits.
 *
 * @module session/contributors/cinematic-camera
 */

import {
  assertCameraPathPlaybackSnapshot,
  assertCameraPathSessionState
} from '../../ui/modules/cinematic-camera/index.js';
import { requireMethod } from '../schema-contract.js';

export const id = 'cinematic-camera';
const CAMERA_STATE_PARTICIPANT_ID = 'cinematic-camera/state';

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
  const transaction = ctx.restoreTransaction;

  if (transaction === null || typeof transaction !== 'object') {
    if (data.autoplay) {
      throw new TypeError(
        'Cinematic camera autoplay restore requires the session restore transaction.'
      );
    }
    cam.restoreSessionState(data);
    return;
  }

  requireMethod(
    transaction,
    'register',
    'Cinematic camera state transaction'
  );
  requireMethod(cam, 'exportSessionState', 'Cinematic camera rollback owner');
  requireMethod(
    cam,
    'capturePlaybackSnapshot',
    'Cinematic camera rollback owner'
  );
  requireMethod(
    cam,
    'restorePlaybackSnapshot',
    'Cinematic camera rollback owner'
  );
  requireMethod(
    cam,
    'getNavigationMode',
    'Cinematic camera transaction owner'
  );
  requireMethod(cam, 'startAutoplay', 'Cinematic camera autoplay owner');
  requireMethod(cam, 'stopAutoplay', 'Cinematic camera autoplay owner');
  const previousState = structuredClone(
    assertCameraPathSessionState(cam.exportSessionState())
  );
  const previousPlaybackSnapshot = structuredClone(
    assertCameraPathPlaybackSnapshot(cam.capturePlaybackSnapshot())
  );
  let applied = false;
  let targetAutoplayStarted = false;
  transaction.register(CAMERA_STATE_PARTICIPANT_ID, {
    value: data,
    prepare() {
      if (cam.getNavigationMode() !== data.navigationMode) {
        throw new TypeError(
          'Cinematic camera navigation mode must match the restored core camera mode.'
        );
      }
    },
    commit() {
      if (!data.autoplay) return;
      const result = cam.startAutoplay();
      if (typeof result !== 'boolean') {
        throw new TypeError(
          'Cinematic camera autoplay owner must report a boolean start result.'
        );
      }
      targetAutoplayStarted = result;
    },
    rollback() {
      if (!applied) return;
      if (targetAutoplayStarted) cam.stopAutoplay();
      cam.restoreSessionState(previousState);
      cam.restorePlaybackSnapshot(previousPlaybackSnapshot);
      applied = false;
    }
  });

  applied = true;
  cam.restoreSessionState(data);
}
