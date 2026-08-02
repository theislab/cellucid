/**
 * @fileoverview Playback state machine for cinematic camera paths.
 *
 * Runs its own `requestAnimationFrame` loop that calls
 * `viewer.setCameraState()` on every frame during playback.  The viewer's own
 * render loop picks up the updated camera values on its next frame.
 *
 * States: STOPPED → PLAYING ↔ PAUSED → STOPPED
 *
 * Under `prefers-reduced-motion: reduce` the loop never runs: the path
 * completes instantly at its end keyframe instead.  CSS cannot reach a
 * `requestAnimationFrame` camera path, so the preference is read here.
 *
 * @module ui/modules/cinematic-camera/playback-controller
 */

import {
  assertCameraPathOptions,
  createCameraPathPlan,
  interpolatePlannedCameraState
} from './interpolation-engine.js';
import { isCameraPathReady } from './keyframe-store.js';
import { readCameraBooleanOption } from '../camera-input-contract.js';

const STOPPED = 'STOPPED';
const PLAYING = 'PLAYING';
const PAUSED = 'PAUSED';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** @type {MediaQueryList|null} */
let reducedMotionMedia = null;

/**
 * The user's live "reduce motion" preference.
 *
 * A platform without `matchMedia` cannot state a preference, so motion stays
 * enabled there; that is the only case in which this reports `false` without
 * having asked the platform.
 *
 * @returns {boolean}
 */
export function prefersReducedMotion() {
  if (reducedMotionMedia === null) {
    if (typeof globalThis.matchMedia !== 'function') return false;
    const media = globalThis.matchMedia(REDUCED_MOTION_QUERY);
    if (
      media === null ||
      typeof media !== 'object' ||
      typeof media.matches !== 'boolean'
    ) {
      throw new TypeError(
        'Reduced-motion preference requires an exact MediaQueryList.'
      );
    }
    reducedMotionMedia = media;
  }
  return reducedMotionMedia.matches;
}

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
  let pauseElapsed = 0;    // seconds elapsed at pause or at the last seek
  let totalDuration = 0;   // seconds for full path
  let rafId = null;
  let destroyed = false;
  /** Validated keyframes + resolved timing for the path currently in flight. */
  let plan = null;
  let loopEnabled = false;

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

  // ---- Path plan ----

  /**
   * The validated path and timing this controller is currently driving.
   *
   * Rebuilt only when an input that can change it changes: the keyframes (the
   * store announces every mutation, which drops the plan below) or a setting
   * the timing or geometry depends on. `loop` is deliberately excluded, because
   * it steers the clock rather than the path, and rebuilding for it would make
   * a mid-playback loop toggle re-derive the whole path for nothing.
   */
  function refreshPlan() {
    const options = getExactInterpolationOptions();
    loopEnabled = options.loop;
    if (
      plan === null ||
      plan.autoPaceSpeed !== options.autoPaceSpeed ||
      plan.positionMethod !== options.positionMethod ||
      plan.rotationMethod !== options.rotationMethod ||
      plan.easing !== options.easing
    ) {
      plan = createCameraPathPlan(keyframeStore.getAll(), options);
    }
    return plan;
  }

  /**
   * Adopt the current plan's duration without moving the camera.
   *
   * The default-speed slider stays live during playback, so the path's total
   * duration can change under a running clock. Holding the elapsed *fraction*
   * keeps the transport readout, the scrubber, and the interpolated viewpoint
   * describing one timeline: retiming changes how fast the rest of the path
   * plays, never where it currently is.
   *
   * @param {number} now  Seconds, from the same clock as startTime.
   */
  function adoptPlan(now) {
    const active = refreshPlan();
    if (active.totalDuration === totalDuration) return active;
    const previousTotal = totalDuration;
    const elapsed = state === PLAYING ? now - startTime : pauseElapsed;
    const fraction = previousTotal > 0
      ? Math.max(0, Math.min(1, elapsed / previousTotal))
      : 0;
    totalDuration = active.totalDuration;
    if (state === PLAYING) {
      startTime = now - fraction * totalDuration;
    } else {
      pauseElapsed = fraction * totalDuration;
    }
    return active;
  }

  // ---- Reduced motion ----

  /**
   * Settle on the exact end of the path without animating toward it.
   *
   * Refusing to move would strand a reduced-motion user short of the viewpoint
   * the path exists to reach, which is not an accessible outcome for a
   * scientific viewer. Completing instantly publishes the same final camera
   * state the animation would have published, and `seekTo()` still reaches
   * every intermediate viewpoint, so nothing becomes unreachable.
   */
  function completeWithoutMotion() {
    const now = performance.now() / 1000;
    const active = adoptPlan(now);
    viewer.setCameraState(interpolatePlannedCameraState(active, 1));
    emit('timeUpdate', { globalT: 1, elapsed: totalDuration, totalDuration });
    stop({ resetCamera: false });
  }

  // ---- Frame tick ----

  function tick() {
    if (destroyed || state !== PLAYING) return;

    const now = performance.now() / 1000;
    const active = adoptPlan(now);
    if (active.keyframes.length < 2) {
      stop({ resetCamera: false });
      return;
    }

    if (prefersReducedMotion()) {
      // The preference turned on mid-flight: finish now rather than animate on.
      completeWithoutMotion();
      return;
    }

    let elapsed = now - startTime;
    let globalT = elapsed / totalDuration;

    if (globalT >= 1) {
      if (loopEnabled) {
        // Seamless loop: reset start time
        startTime = now;
        elapsed = 0;
        globalT = 0;
      } else {
        // Publish the exact endpoint and finish in place.
        viewer.setCameraState(interpolatePlannedCameraState(active, 1));
        emit('timeUpdate', { globalT: 1, elapsed: totalDuration, totalDuration });
        stop({ resetCamera: false });
        return;
      }
    }

    viewer.setCameraState(interpolatePlannedCameraState(active, globalT));

    emit('timeUpdate', { globalT, elapsed, totalDuration });

    rafId = requestAnimationFrame(tick);
  }

  // ---- Public API ----

  function play() {
    requireActive('play');
    if (!isCameraPathReady(keyframeStore.getAll())) {
      throw new Error('Camera path playback requires at least two valid keyframes.');
    }
    if (state === PLAYING) {
      throw new Error('Camera path playback is already playing.');
    }

    const now = performance.now() / 1000;
    adoptPlan(now);
    if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
      throw new Error('Camera path playback requires a positive finite duration.');
    }

    if (prefersReducedMotion()) {
      // A stated reduced-motion preference must never produce an unrequested
      // animation, so the path completes at its end keyframe instead of
      // starting a frame loop.
      completeWithoutMotion();
      return;
    }

    // Resume from wherever the timeline currently sits. `pauseElapsed` carries
    // both a pause and a seek, so scrubbing an idle path then pressing Play
    // continues from the viewpoint the transport is showing instead of
    // silently discarding it. Only an explicit Stop clears it, and a timeline
    // already at the end restarts, so Play is never a control that does
    // nothing.
    if (pauseElapsed >= totalDuration) pauseElapsed = 0;
    startTime = now - pauseElapsed;

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
    if (resetCamera && isCameraPathReady(keyframeStore.getAll())) {
      viewer.setCameraState(interpolatePlannedCameraState(refreshPlan(), 0));
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
    if (!isCameraPathReady(keyframeStore.getAll())) {
      throw new Error('Camera path seeking requires at least two valid keyframes.');
    }
    if (!Number.isFinite(globalT) || globalT < 0 || globalT > 1) {
      throw new RangeError(
        `Camera path progress must be a finite number from 0 through 1; received ${String(globalT)}.`
      );
    }

    const now = performance.now() / 1000;
    const active = adoptPlan(now);
    if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
      throw new Error('Camera path seeking requires a positive finite duration.');
    }

    viewer.setCameraState(interpolatePlannedCameraState(active, globalT));

    if (state === PLAYING) {
      // Adjust startTime so play continues from the seek point
      startTime = now - globalT * totalDuration;
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
    // Dropping the plan here is what lets every other path assume it describes
    // the store; stopping in place keeps mutations from continuing along stale
    // path geometry.
    plan = null;
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
    plan = null;
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
