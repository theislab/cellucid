/**
 * @fileoverview Playback state machine for cinematic camera paths.
 *
 * Runs its own `requestAnimationFrame` loop that calls
 * `viewer.setCameraState()` on every frame during playback.  The viewer's own
 * render loop picks up the updated camera values on its next frame.
 *
 * States: STOPPED → PLAYING ↔ PAUSED → STOPPED
 *
 * @module ui/modules/cinematic-camera/playback-controller
 */

import {
  assertCameraPathOptions,
  interpolateCameraState,
  resolveSegmentDurations
} from './interpolation-engine.js';
import { isCameraPathReady } from './keyframe-store.js';
import { readCameraBooleanOption } from '../camera-input-contract.js';

const STOPPED = 'STOPPED';
const PLAYING = 'PLAYING';
const PAUSED = 'PAUSED';

/**
 * @param {Object} options
 * @param {Object} options.viewer             Viewer API (getCameraState, setCameraState).
 * @param {import('./keyframe-store.js').ReturnType<typeof import('./keyframe-store.js').createKeyframeStore>} options.keyframeStore
 * @param {() => Object} options.getInterpolationOptions  Returns { positionMethod, rotationMethod, easing, loop }.
 */
export function createPlaybackController({ viewer, keyframeStore, getInterpolationOptions }) {
  if (!viewer || typeof viewer.setCameraState !== 'function') {
    throw new TypeError('Camera path playback requires viewer.setCameraState().');
  }
  if (
    !keyframeStore ||
    typeof keyframeStore.getAll !== 'function' ||
    typeof keyframeStore.on !== 'function' ||
    typeof keyframeStore.off !== 'function'
  ) {
    throw new TypeError('Camera path playback requires the exact keyframe-store contract.');
  }
  if (typeof getInterpolationOptions !== 'function') {
    throw new TypeError('Camera path playback requires getInterpolationOptions().');
  }

  let state = STOPPED;
  let startTime = 0;       // seconds (performance.now / 1000)
  let pauseElapsed = 0;    // seconds elapsed at pause
  let totalDuration = 0;   // seconds for full path
  let rafId = null;
  let destroyed = false;

  // Lightweight event emitter
  const listeners = { stateChange: new Set(), timeUpdate: new Set() };

  function getExactInterpolationOptions() {
    return assertCameraPathOptions(getInterpolationOptions());
  }

  function requireActive(operation) {
    if (destroyed) {
      throw new Error(
        `Camera path playback cannot ${operation} after destruction.`
      );
    }
  }

  function on(event, fn) {
    requireActive('register listeners');
    if (!Object.hasOwn(listeners, event)) {
      throw new RangeError(`Unsupported camera playback event: ${String(event)}.`);
    }
    if (typeof fn !== 'function') {
      throw new TypeError('Camera playback listeners must be functions.');
    }
    listeners[event].add(fn);
  }

  function off(event, fn) {
    if (!Object.hasOwn(listeners, event)) {
      throw new RangeError(`Unsupported camera playback event: ${String(event)}.`);
    }
    if (typeof fn !== 'function') {
      throw new TypeError('Camera playback listeners must be functions.');
    }
    if (destroyed) return;
    listeners[event].delete(fn);
  }

  function emit(event, data) {
    for (const fn of listeners[event]) {
      fn(data);
    }
  }

  // ---- Duration computation ----

  function computeTotalDuration() {
    const keyframes = keyframeStore.getAll();
    const opts = getExactInterpolationOptions();
    const durations = resolveSegmentDurations(keyframes, opts.autoPaceSpeed);
    return durations.reduce((s, d) => s + d, 0);
  }

  // ---- Frame tick ----

  function tick() {
    if (destroyed || state !== PLAYING) return;

    const keyframes = keyframeStore.getAll();
    if (!isCameraPathReady(keyframes)) {
      stop({ resetCamera: false });
      return;
    }

    const now = performance.now() / 1000;
    const elapsed = now - startTime;
    let globalT = elapsed / totalDuration;

    const opts = getExactInterpolationOptions();

    if (globalT >= 1) {
      if (opts.loop) {
        // Seamless loop: reset start time
        startTime = now;
        globalT = 0;
      } else {
        // Publish the exact endpoint and finish in place.
        globalT = 1;
        const camState = interpolateCameraState(keyframes, 1, opts);
        viewer.setCameraState(camState);
        emit('timeUpdate', { globalT: 1, elapsed: totalDuration, totalDuration });
        stop({ resetCamera: false });
        return;
      }
    }

    const camState = interpolateCameraState(keyframes, globalT, opts);
    viewer.setCameraState(camState);

    emit('timeUpdate', { globalT, elapsed, totalDuration });

    rafId = requestAnimationFrame(tick);
  }

  // ---- Public API ----

  function play() {
    requireActive('play');
    const keyframes = keyframeStore.getAll();
    if (!isCameraPathReady(keyframes)) {
      throw new Error('Camera path playback requires at least two valid keyframes.');
    }
    if (state === PLAYING) {
      throw new Error('Camera path playback is already playing.');
    }

    totalDuration = computeTotalDuration();
    if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
      throw new Error('Camera path playback requires a positive finite duration.');
    }

    const now = performance.now() / 1000;

    if (state === PAUSED) {
      // Resume from pause point
      startTime = now - pauseElapsed;
    } else {
      // Start from beginning
      startTime = now;
      pauseElapsed = 0;
    }

    state = PLAYING;
    emit('stateChange', state);
    rafId = requestAnimationFrame(tick);
  }

  function pause() {
    requireActive('pause');
    if (state !== PLAYING) {
      throw new Error('Camera path playback can pause only while it is playing.');
    }
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;

    pauseElapsed = performance.now() / 1000 - startTime;
    state = PAUSED;
    emit('stateChange', state);
  }

  function stop(options) {
    requireActive('stop');
    const resetCamera = readCameraBooleanOption(
      options,
      'resetCamera',
      'Camera path stop'
    );
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;

    state = STOPPED;
    pauseElapsed = 0;

    // The explicit reset command always honors the transport's reset-to-start label.
    if (resetCamera) {
      const keyframes = keyframeStore.getAll();
      if (isCameraPathReady(keyframes)) {
        const opts = getExactInterpolationOptions();
        const camState = interpolateCameraState(keyframes, 0, opts);
        viewer.setCameraState(camState);
      }
    }

    emit('stateChange', state);
    emit('timeUpdate', { globalT: 0, elapsed: 0, totalDuration });
  }

  /**
   * Jump to an arbitrary position on the timeline.
   * @param {number} globalT  0 = start, 1 = end.
   */
  function seekTo(globalT) {
    requireActive('seek');
    const keyframes = keyframeStore.getAll();
    if (!isCameraPathReady(keyframes)) {
      throw new Error('Camera path seeking requires at least two valid keyframes.');
    }
    if (!Number.isFinite(globalT) || globalT < 0 || globalT > 1) {
      throw new RangeError(
        `Camera path progress must be a finite number from 0 through 1; received ${String(globalT)}.`
      );
    }

    totalDuration = computeTotalDuration();
    if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
      throw new Error('Camera path seeking requires a positive finite duration.');
    }

    const opts = getExactInterpolationOptions();
    const camState = interpolateCameraState(keyframes, globalT, opts);
    viewer.setCameraState(camState);

    if (state === PLAYING) {
      // Adjust startTime so play continues from the seek point
      startTime = performance.now() / 1000 - globalT * totalDuration;
    } else {
      pauseElapsed = globalT * totalDuration;
    }

    emit('timeUpdate', {
      globalT,
      elapsed: globalT * totalDuration,
      totalDuration
    });
  }

  function getState() {
    return state;
  }

  function getProgress() {
    if (state === STOPPED) return 0;
    if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
      throw new Error(
        'Camera path playback progress requires a positive finite duration.'
      );
    }
    const elapsed = state === PLAYING
      ? performance.now() / 1000 - startTime
      : pauseElapsed;
    const opts = getExactInterpolationOptions();
    if (opts.loop) {
      const wrapped = elapsed % totalDuration;
      return Math.max(0, wrapped / totalDuration);
    }
    return Math.max(0, Math.min(1, elapsed / totalDuration));
  }

  function onKeyframeChange() {
    if (destroyed) return;
    // Any edit invalidates timing/interpolation cached when playback started.
    // Stop in place so mutations never continue along stale path geometry.
    if (state !== STOPPED) {
      stop({ resetCamera: false });
    }
  }

  keyframeStore.on('changed', onKeyframeChange);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    const failures = [];
    if (rafId != null) {
      try {
        cancelAnimationFrame(rafId);
      } catch (error) {
        failures.push(error);
      }
    }
    rafId = null;
    state = STOPPED;
    try {
      keyframeStore.off('changed', onKeyframeChange);
    } catch (error) {
      failures.push(error);
    }
    listeners.stateChange.clear();
    listeners.timeUpdate.clear();
    const exactFailures = [...new Set(failures)];
    if (exactFailures.length === 1) throw exactFailures[0];
    if (exactFailures.length > 1) {
      throw new AggregateError(
        exactFailures,
        'Camera path playback failed to release every owned resource.'
      );
    }
  }

  return {
    play,
    pause,
    stop,
    seekTo,
    getState,
    getProgress,
    on,
    off,
    destroy
  };
}
