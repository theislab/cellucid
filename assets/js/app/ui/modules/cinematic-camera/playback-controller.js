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

import { interpolateCameraState, resolveSegmentDurations } from './interpolation-engine.js';

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
  let state = STOPPED;
  let startTime = 0;       // seconds (performance.now / 1000)
  let pauseElapsed = 0;    // seconds elapsed at pause
  let totalDuration = 0;   // seconds for full path
  let rafId = null;

  // Lightweight event emitter
  const listeners = { stateChange: new Set(), timeUpdate: new Set() };

  function on(event, fn) {
    if (listeners[event]) listeners[event].add(fn);
  }

  function off(event, fn) {
    if (listeners[event]) listeners[event].delete(fn);
  }

  function emit(event, data) {
    if (listeners[event]) {
      for (const fn of listeners[event]) fn(data);
    }
  }

  // ---- Duration computation ----

  function computeTotalDuration() {
    const keyframes = keyframeStore.getAll();
    const opts = getInterpolationOptions();
    const durations = resolveSegmentDurations(keyframes, opts.autoPaceSpeed);
    return durations.reduce((s, d) => s + d, 0);
  }

  // ---- Frame tick ----

  function tick() {
    if (state !== PLAYING) return;

    const now = performance.now() / 1000;
    const elapsed = now - startTime;
    let globalT = totalDuration > 0 ? elapsed / totalDuration : 1;

    const opts = getInterpolationOptions();
    const keyframes = keyframeStore.getAll();

    if (globalT >= 1) {
      if (opts.loop && keyframes.length >= 2) {
        // Seamless loop: reset start time
        startTime = now;
        globalT = 0;
      } else {
        // Clamp to end and stop
        globalT = 1;
        const camState = interpolateCameraState(keyframes, 1, opts);
        if (camState) viewer.setCameraState(camState);
        emit('timeUpdate', { globalT: 1, elapsed: totalDuration, totalDuration });
        stop();
        return;
      }
    }

    const camState = interpolateCameraState(keyframes, globalT, opts);
    if (camState) viewer.setCameraState(camState);

    emit('timeUpdate', { globalT, elapsed: Math.min(elapsed, totalDuration), totalDuration });

    rafId = requestAnimationFrame(tick);
  }

  // ---- Public API ----

  function play() {
    const keyframes = keyframeStore.getAll();
    if (keyframes.length < 2) return;

    totalDuration = computeTotalDuration();
    if (totalDuration <= 0) return;

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
    if (state !== PLAYING) return;
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;

    pauseElapsed = performance.now() / 1000 - startTime;
    state = PAUSED;
    emit('stateChange', state);
  }

  function stop() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;

    const wasPlaying = state === PLAYING || state === PAUSED;
    state = STOPPED;
    pauseElapsed = 0;

    // Jump to first keyframe
    if (wasPlaying) {
      const keyframes = keyframeStore.getAll();
      if (keyframes.length > 0) {
        const opts = getInterpolationOptions();
        const camState = interpolateCameraState(keyframes, 0, opts);
        if (camState) viewer.setCameraState(camState);
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
    const keyframes = keyframeStore.getAll();
    if (keyframes.length < 2) return;

    totalDuration = computeTotalDuration();
    if (totalDuration <= 0) return;

    const clamped = Math.max(0, Math.min(1, globalT));
    const opts = getInterpolationOptions();
    const camState = interpolateCameraState(keyframes, clamped, opts);
    if (camState) viewer.setCameraState(camState);

    if (state === PLAYING) {
      // Adjust startTime so play continues from the seek point
      startTime = performance.now() / 1000 - clamped * totalDuration;
    } else {
      pauseElapsed = clamped * totalDuration;
    }

    emit('timeUpdate', {
      globalT: clamped,
      elapsed: clamped * totalDuration,
      totalDuration
    });
  }

  function getState() {
    return state;
  }

  function destroy() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
    state = STOPPED;
    listeners.stateChange.clear();
    listeners.timeUpdate.clear();
  }

  return { play, pause, stop, seekTo, getState, on, off, destroy };
}
