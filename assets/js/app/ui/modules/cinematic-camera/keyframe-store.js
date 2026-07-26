/**
 * @fileoverview Keyframe data model for cinematic camera paths.
 *
 * Stores an ordered list of camera-state snapshots (keyframes), each with an
 * editable label and a per-segment transition duration.  Emits a single
 * `'changed'` event on every mutation so the UI can re-render.
 *
 * @module ui/modules/cinematic-camera/keyframe-store
 */

import { isExactCameraState } from '../../../../rendering/camera-state-contract.js';

export const MAX_KEYFRAMES = 100;
export const MAX_TRANSITION_DURATION_SECONDS = 60;
const VALID_KEYFRAME_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEYFRAME_KEYS = [
  'freefly',
  'id',
  'label',
  'navigationMode',
  'orbit',
  'transitionDuration'
];

function assertKeyframeId(id) {
  if (typeof id !== 'string' || !VALID_KEYFRAME_ID.test(id)) {
    throw new TypeError('Camera path keyframe id is invalid.');
  }
  return id;
}

function isExactKeyframeLabel(label) {
  return typeof label === 'string' &&
    label.length > 0 &&
    label.length <= 40 &&
    label === label.trim();
}

function createStoredKeyframe({
  id,
  label,
  navigationMode,
  orbit,
  freefly,
  transitionDuration
}) {
  return Object.freeze({
    id,
    label,
    navigationMode,
    orbit: Object.freeze({
      radius: orbit.radius,
      targetRadius: orbit.targetRadius,
      theta: orbit.theta,
      phi: orbit.phi,
      target: Object.freeze([orbit.target[0], orbit.target[1], orbit.target[2]])
    }),
    freefly: Object.freeze({
      position: Object.freeze([
        freefly.position[0],
        freefly.position[1],
        freefly.position[2]
      ]),
      yaw: freefly.yaw,
      pitch: freefly.pitch
    }),
    transitionDuration
  });
}

function cloneKeyframeForExport(keyframe) {
  return {
    id: keyframe.id,
    label: keyframe.label,
    navigationMode: keyframe.navigationMode,
    orbit: {
      radius: keyframe.orbit.radius,
      targetRadius: keyframe.orbit.targetRadius,
      theta: keyframe.orbit.theta,
      phi: keyframe.orbit.phi,
      target: [...keyframe.orbit.target]
    },
    freefly: {
      position: [...keyframe.freefly.position],
      yaw: keyframe.freefly.yaw,
      pitch: keyframe.freefly.pitch
    },
    transitionDuration: keyframe.transitionDuration
  };
}

/**
 * Validate the complete, synchronized camera state required by interpolation.
 * Every captured keyframe carries both orbit and free-fly representations so
 * cross-mode paths never need to guess missing coordinates.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidCameraState(value) {
  return isExactCameraState(value);
}

/**
 * Validate a stored/session keyframe, including its identity and timing.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidCameraKeyframe(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== KEYFRAME_KEYS.length ||
    keys.some((key, index) => key !== KEYFRAME_KEYS[index])
  ) {
    return false;
  }
  if (!isExactCameraState({
    navigationMode: value.navigationMode,
    orbit: value.orbit,
    freefly: value.freefly
  })) {
    return false;
  }
  if (typeof value.id !== 'string' || !VALID_KEYFRAME_ID.test(value.id)) return false;
  if (!isExactKeyframeLabel(value.label)) {
    return false;
  }
  if (!Object.hasOwn(value, 'transitionDuration')) return false;
  return value.transitionDuration === null ||
    (
      Number.isFinite(value.transitionDuration) &&
      value.transitionDuration >= 0.1 &&
      value.transitionDuration <= MAX_TRANSITION_DURATION_SECONDS
    );
}

export function assertCameraKeyframe(value, boundary = 'Camera path keyframe') {
  if (!isValidCameraKeyframe(value)) {
    throw new TypeError(
      `${boundary} must match the exact current camera-keyframe schema.`
    );
  }
  return value;
}

/**
 * A camera path can control playback only when every keyframe is valid and at
 * least one complete segment exists.
 *
 * @param {unknown} keyframes
 * @returns {boolean}
 */
export function isCameraPathReady(keyframes) {
  return Array.isArray(keyframes) &&
    keyframes.length >= 2 &&
    keyframes.every(isValidCameraKeyframe);
}

/**
 * @typedef {Object} Keyframe
 * @property {string}       id                  Unique identifier.
 * @property {string}       label               User-editable display name.
 * @property {string}       navigationMode      'orbit' | 'planar' | 'free'
 * @property {Object}       orbit               Orbit camera params.
 * @property {Object}       freefly             Free-fly camera params.
 * @property {number|null}  transitionDuration  Seconds to next keyframe, or null for auto-pace.
 */

/**
 * Create a new keyframe store.
 *
 * @returns {{ add, remove, rename, reorder, setDuration, setAllDurations,
 *             getAll, getCount, getById, clear, on, off }}
 */
export function createKeyframeStore() {
  /** @type {Keyframe[]} */
  let keyframes = [];
  let nextIndex = 1;

  // Minimal event emitter (single event type: 'changed')
  /** @type {Set<() => void>} */
  const listeners = new Set();

  function emit() {
    for (const fn of listeners) fn();
  }

  function assertChangedListener(event, fn) {
    if (event !== 'changed') {
      throw new RangeError(`Unsupported camera keyframe event: ${String(event)}.`);
    }
    if (typeof fn !== 'function') {
      throw new TypeError('Camera keyframe listeners must be functions.');
    }
  }

  function on(event, fn) {
    assertChangedListener(event, fn);
    listeners.add(fn);
  }

  function off(event, fn) {
    assertChangedListener(event, fn);
    listeners.delete(fn);
  }

  // ---- Public API ----

  /**
   * Add a camera-state snapshot as a new keyframe.
   * @param {Object} cameraState  The value returned by viewer.getCameraState().
   * @param {string} [label]      Optional custom label.
   * @returns {string|null}  The new keyframe's id, or null if at capacity.
   */
  function add(cameraState, label) {
    if (!isValidCameraState(cameraState)) {
      throw new TypeError(
        'Camera path keyframes require an exact synchronized camera state.'
      );
    }
    const exactLabel = label === undefined ? `KF ${nextIndex}` : label;
    if (!isExactKeyframeLabel(exactLabel)) {
      throw new TypeError(
        'Camera path keyframe label must be a trimmed non-empty string of at most 40 characters.'
      );
    }
    if (keyframes.length >= MAX_KEYFRAMES) {
      return null;
    }

    const id = crypto.randomUUID();
    keyframes.push(createStoredKeyframe({
      id,
      label: exactLabel,
      navigationMode: cameraState.navigationMode,
      orbit: cameraState.orbit,
      freefly: cameraState.freefly,
      transitionDuration: null // auto-pace by default
    }));
    nextIndex++;
    emit();
    return id;
  }

  /** Remove a keyframe by id. */
  function remove(id) {
    assertKeyframeId(id);
    const idx = keyframes.findIndex((kf) => kf.id === id);
    if (idx === -1) {
      throw new RangeError(`Camera path keyframe was not found: ${id}.`);
    }
    keyframes.splice(idx, 1);
    emit();
  }

  /** Rename a keyframe. */
  function rename(id, newLabel) {
    assertKeyframeId(id);
    const index = keyframes.findIndex((keyframe) => keyframe.id === id);
    if (index === -1) {
      throw new RangeError(`Camera path keyframe was not found: ${id}.`);
    }
    if (!isExactKeyframeLabel(newLabel)) {
      throw new TypeError(
        'Camera path keyframe label must be a trimmed non-empty string of at most 40 characters.'
      );
    }
    keyframes[index] = createStoredKeyframe({
      ...keyframes[index],
      label: newLabel
    });
    emit();
  }

  /**
   * Move a keyframe up (-1) or down (+1).
   * @param {string} id
   * @param {-1|1}  direction
   */
  function reorder(id, direction) {
    assertKeyframeId(id);
    if (direction !== -1 && direction !== 1) {
      throw new TypeError('Camera path reorder direction must be exactly -1 or 1.');
    }
    const idx = keyframes.findIndex((kf) => kf.id === id);
    if (idx === -1) {
      throw new RangeError(`Camera path keyframe was not found: ${id}.`);
    }
    const target = idx + direction;
    if (target < 0 || target >= keyframes.length) {
      throw new RangeError('Camera path reorder target is out of range.');
    }
    [keyframes[idx], keyframes[target]] = [keyframes[target], keyframes[idx]];
    emit();
  }

  /**
   * Set the transition duration for the segment starting at keyframe index.
   * @param {number}      index     Keyframe index (0-based).
   * @param {number|null} duration  Seconds, or null for auto-pace.
   */
  function setDuration(index, duration) {
    if (!Number.isInteger(index) || index < 0 || index >= keyframes.length) {
      throw new RangeError(`Camera path keyframe index is out of range: ${String(index)}.`);
    }
    if (
      duration !== null &&
      (
        !Number.isFinite(duration) ||
        duration < 0.1 ||
        duration > MAX_TRANSITION_DURATION_SECONDS
      )
    ) {
      throw new TypeError(
        `Camera path duration must be null or a finite number from 0.1 through ${MAX_TRANSITION_DURATION_SECONDS} seconds.`
      );
    }
    keyframes[index] = createStoredKeyframe({
      ...keyframes[index],
      transitionDuration: duration
    });
    emit();
  }

  /** Set the same duration on every keyframe (except the last). */
  function setAllDurations(duration) {
    if (
      duration !== null &&
      (
        !Number.isFinite(duration) ||
        duration < 0.1 ||
        duration > MAX_TRANSITION_DURATION_SECONDS
      )
    ) {
      throw new TypeError(
        `Camera path duration must be null or a finite number from 0.1 through ${MAX_TRANSITION_DURATION_SECONDS} seconds.`
      );
    }
    for (let i = 0; i < keyframes.length; i++) {
      keyframes[i] = createStoredKeyframe({
        ...keyframes[i],
        transitionDuration: duration
      });
    }
    emit();
  }

  /** @returns {Keyframe[]} Shallow copy of the ordered keyframe array. */
  function getAll() {
    return keyframes.slice();
  }

  function getCount() {
    return keyframes.length;
  }

  /** @returns {Keyframe|undefined} */
  function getById(id) {
    return keyframes.find((kf) => kf.id === id);
  }

  /** Remove all keyframes and reset the index counter. */
  function clear() {
    keyframes = [];
    nextIndex = 1;
    emit();
  }

  /**
   * Export all keyframes and the next-index counter for session serialization.
   * @returns {{ keyframes: Keyframe[], nextIndex: number }}
   */
  function exportAll() {
    return {
      keyframes: keyframes.map(cloneKeyframeForExport),
      nextIndex
    };
  }

  /**
   * Bulk-import keyframes from a session snapshot (replaces current state).
   * @param {{ keyframes: Keyframe[], nextIndex?: number }} data
   */
  function importAll(data) {
    const keys = data && typeof data === 'object' && !Array.isArray(data)
      ? Object.keys(data).sort()
      : [];
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      keys.length !== 2 ||
      keys[0] !== 'keyframes' ||
      keys[1] !== 'nextIndex' ||
      !Array.isArray(data.keyframes) ||
      data.keyframes.length > MAX_KEYFRAMES ||
      !Number.isInteger(data.nextIndex) ||
      data.nextIndex <= 0
    ) {
      return false;
    }

    const incoming = data.keyframes;
    const ids = new Set();
    if (incoming.some((kf) => {
      if (!isValidCameraKeyframe(kf) || ids.has(kf.id)) return true;
      ids.add(kf.id);
      return false;
    })) {
      return false;
    }

    keyframes = incoming.map(createStoredKeyframe);
    nextIndex = data.nextIndex;
    emit();
    return true;
  }

  return {
    add,
    remove,
    rename,
    reorder,
    setDuration,
    setAllDurations,
    getAll,
    getCount,
    getById,
    clear,
    exportAll,
    importAll,
    on,
    off,
    MAX_KEYFRAMES
  };
}
