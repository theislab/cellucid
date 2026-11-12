/**
 * @fileoverview The `camera-path` state domain: the Camera Path's keyframes
 * and how it plays them (`ui/modules/cinematic-camera`).
 *
 * Value: the Camera Path's own state (`exportPath`), nothing other domains
 * hold (the navigation mode is the `camera` domain's, the navigation
 * settings the `settings` domain's controls):
 *
 *     {keyframes: [{id, label, camera, …, hold?}, …], // as the keyframe store exports them (`hold` only when it rests)
 *      nextIndex,                               // the number the next keyframe takes
 *      loopBackKeyframeId,                      // the keyframe a loop returns to, or null
 *      autoplay, loopPlayback,                  // booleans
 *      captions?,                               // false when captions are off; absent: on
 *                                               // (an added key, `record-keys.js`)
 *      positionMethod, rotationMethod, easing,  // interpolation choices
 *      defaultSpeed}                            // the speed slider, as its text
 *
 * Restore hands the Camera Path its state (`restorePath`), which moves
 * nothing else; playback stops. Autoplay is a setting here, not a start: a
 * history step never starts playback (a session file loaded with it on does,
 * `session-serializer.js`).
 *
 * @module app/state/domains/camera-path
 */

import { sameValue } from './same-value.js';
import { formatCountOf } from '../../../utils/format-units.js';

/**
 * @param {{cinematicCamera: object|null}} options
 */
export function createCameraPathDomain({ cinematicCamera }) {
  function capture() {
    return cinematicCamera === null ? null : structuredClone(cinematicCamera.exportPath());
  }
  return {
    capture,
    restore(value) {
      if (cinematicCamera === null) {
        if (value !== null) throw new Error('The Camera Path is not available on this page.');
        return;
      }
      if (sameValue(capture(), value)) return;
      cinematicCamera.restorePath(structuredClone(value));
    },
    describe(a, b) {
      if (a === null || b === null) return [];
      const lines = [];
      if (a.keyframes.length !== b.keyframes.length) {
        lines.push(`Camera path: ${formatCountOf(b.keyframes.length, 'keyframe')} (was ${a.keyframes.length})`);
      } else if (!sameValue(a.keyframes, b.keyframes)) {
        const withoutHold = keyframes => keyframes.map(({ hold, ...keyframe }) => keyframe);
        lines.push(sameValue(withoutHold(a.keyframes), withoutHold(b.keyframes))
          ? 'Camera path: holds changed'
          : 'Camera path: keyframes changed');
      }
      for (const [key, label] of [['loopPlayback', 'loop'], ['autoplay', 'autoplay'], ['captions', 'captions'], ['positionMethod', 'position interpolation'],
        ['rotationMethod', 'rotation interpolation'], ['easing', 'easing'], ['defaultSpeed', 'speed'], ['loopBackKeyframeId', 'loop back']]) {
        // An added key absent from a record is its default (`record-keys.js`).
        const before = key === 'captions' ? (a.captions ?? true) : a[key];
        const after = key === 'captions' ? (b.captions ?? true) : b[key];
        if (!sameValue(before, after)) lines.push(`Camera path: ${label} ${typeof after === 'boolean' ? (after ? 'on' : 'off') : String(after)}`);
      }
      return lines;
    },
  };
}
