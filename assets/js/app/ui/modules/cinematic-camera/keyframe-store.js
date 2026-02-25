/**
 * @fileoverview Keyframe data model for cinematic camera paths.
 *
 * Stores an ordered list of camera-state snapshots (keyframes), each with an
 * editable label and a per-segment transition duration.  Emits a single
 * `'changed'` event on every mutation so the UI can re-render.
 *
 * @module ui/modules/cinematic-camera/keyframe-store
 */

const MAX_KEYFRAMES = 100;

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

  function on(event, fn) {
    if (event === 'changed') listeners.add(fn);
  }

  function off(event, fn) {
    if (event === 'changed') listeners.delete(fn);
  }

  // ---- Public API ----

  /**
   * Add a camera-state snapshot as a new keyframe.
   * @param {Object} cameraState  The value returned by viewer.getCameraState().
   * @param {string} [label]      Optional custom label.
   * @returns {string|null}  The new keyframe's id, or null if at capacity.
   */
  function add(cameraState, label) {
    if (keyframes.length >= MAX_KEYFRAMES) return null;

    const id = crypto.randomUUID();
    keyframes.push({
      id,
      label: label || `KF ${nextIndex}`,
      navigationMode: cameraState.navigationMode,
      orbit: cameraState.orbit
        ? {
            radius: cameraState.orbit.radius,
            targetRadius: cameraState.orbit.targetRadius,
            theta: cameraState.orbit.theta,
            phi: cameraState.orbit.phi,
            target: [
              cameraState.orbit.target[0],
              cameraState.orbit.target[1],
              cameraState.orbit.target[2]
            ]
          }
        : null,
      freefly: cameraState.freefly
        ? {
            position: [
              cameraState.freefly.position[0],
              cameraState.freefly.position[1],
              cameraState.freefly.position[2]
            ],
            yaw: cameraState.freefly.yaw,
            pitch: cameraState.freefly.pitch
          }
        : null,
      transitionDuration: null // auto-pace by default
    });
    nextIndex++;
    emit();
    return id;
  }

  /** Remove a keyframe by id. */
  function remove(id) {
    const idx = keyframes.findIndex((kf) => kf.id === id);
    if (idx === -1) return;
    keyframes.splice(idx, 1);
    emit();
  }

  /** Rename a keyframe. */
  function rename(id, newLabel) {
    const kf = keyframes.find((k) => k.id === id);
    if (!kf) return;
    kf.label = String(newLabel).trim() || kf.label;
    emit();
  }

  /**
   * Move a keyframe up (-1) or down (+1).
   * @param {string} id
   * @param {-1|1}  direction
   */
  function reorder(id, direction) {
    const idx = keyframes.findIndex((kf) => kf.id === id);
    if (idx === -1) return;
    const target = idx + direction;
    if (target < 0 || target >= keyframes.length) return;
    [keyframes[idx], keyframes[target]] = [keyframes[target], keyframes[idx]];
    emit();
  }

  /**
   * Set the transition duration for the segment starting at keyframe index.
   * @param {number}      index     Keyframe index (0-based).
   * @param {number|null} duration  Seconds, or null for auto-pace.
   */
  function setDuration(index, duration) {
    if (index < 0 || index >= keyframes.length) return;
    keyframes[index].transitionDuration =
      duration === null || duration === '' ? null : Math.max(0.1, Number(duration) || 2);
    emit();
  }

  /** Set the same duration on every keyframe (except the last). */
  function setAllDurations(duration) {
    const val =
      duration === null || duration === '' ? null : Math.max(0.1, Number(duration) || 2);
    for (let i = 0; i < keyframes.length; i++) {
      keyframes[i].transitionDuration = val;
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
    on,
    off,
    MAX_KEYFRAMES
  };
}
