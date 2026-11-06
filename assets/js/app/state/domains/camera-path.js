/**
 * @fileoverview The `camera-path` state domain: the Camera Path's keyframes
 * and how it plays them (`ui/modules/cinematic-camera`).
 *
 * Value: the Camera Path's own state (`exportPath`), nothing other domains
 * hold (the navigation mode is the `camera` domain's, the navigation
 * settings the `settings` domain's controls):
 *
 *     {keyframes: [{id, name, camera, …}, …],   // as the keyframe store exports them
 *      nextIndex,                               // the number the next keyframe takes
 *      loopBackKeyframeId,                      // the keyframe a loop returns to, or null
 *      autoplay, loopPlayback,                  // booleans
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
        lines.push('Camera path: keyframes changed');
      }
      for (const [key, label] of [['loopPlayback', 'loop'], ['autoplay', 'autoplay'], ['positionMethod', 'position interpolation'],
        ['rotationMethod', 'rotation interpolation'], ['easing', 'easing'], ['defaultSpeed', 'speed'], ['loopBackKeyframeId', 'loop back']]) {
        if (!sameValue(a[key], b[key])) lines.push(`Camera path: ${label} ${typeof b[key] === 'boolean' ? (b[key] ? 'on' : 'off') : String(b[key])}`);
      }
      return lines;
    },
  };
}
