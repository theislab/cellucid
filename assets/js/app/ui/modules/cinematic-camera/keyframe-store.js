/**
 * @fileoverview Keyframe data model for cinematic camera paths.
 *
 * Stores an ordered list of camera-state snapshots (keyframes), each with an
 * editable label, a per-segment transition duration and a hold (the seconds
 * the camera rests there before moving on).  Emits a single `'changed'` event
 * on every mutation so the UI can re-render.
 *
 * A hold of 0 is no `hold` key at all, and a keyframe with one holds a
 * positive number of seconds: one value per path, so the `camera-path`
 * domain compares, hashes and stores a path without holds exactly as a path
 * of a Cellucid before holds (session format 4 is read unchanged).
 *
 * @module ui/modules/cinematic-camera/keyframe-store
 */

import { isExactCameraState } from '../../../../rendering/camera-state-contract.js';
import { createListenerSet } from '../../../../utils/listener-set.js';
import { createOpaqueId } from '../../../../utils/opaque-id.js';

/** The shortest transition a keyframe pair may declare; there is no longest. */
export const MIN_TRANSITION_DURATION_SECONDS = 0.1;
const VALID_KEYFRAME_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEYFRAME_KEYS = [
  'freefly',
  'id',
  'label',
  'navigationMode',
  'orbit',
  'representation',
  'transitionDuration'
];
/** The keys of a keyframe that holds (`KEYFRAME_KEYS` and `hold`), sorted. */
const HOLDING_KEYFRAME_KEYS = [...KEYFRAME_KEYS.slice(0, 5), 'hold', ...KEYFRAME_KEYS.slice(5)].sort();

/** Whether `seconds` is a hold a keyframe can take: 0 (none) or any finite positive number. */
export function isValidKeyframeHold(seconds) {
  return Number.isFinite(seconds) && seconds >= 0;
}

/** The seconds the camera rests at `keyframe` before moving on (0 when it does not). */
export function keyframeHold(keyframe) {
  return Object.hasOwn(keyframe, 'hold') ? keyframe.hold : 0;
}

/**
 * The representation a keyframe was recorded on: the embedding reference of
 * the view it was captured in (`{key, columns}`), or null where there is none
 * (a synthetic dataset). A path replays camera poses only; playing it on a
 * view that shows another representation is allowed, and the interface says
 * so.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidKeyframeRepresentation(value) {
  if (value === null) return true;
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'columns,key' ||
    typeof value.key !== 'string' ||
    value.key.length === 0
  ) {
    return false;
  }
  return value.columns === null || (
    Array.isArray(value.columns) &&
    value.columns.length >= 1 &&
    value.columns.length <= 3 &&
    value.columns.every(column => Number.isSafeInteger(column) && column >= 0) &&
    new Set(value.columns).size === value.columns.length
  );
}

function freezeRepresentation(representation) {
  return representation === null
    ? null
    : Object.freeze({
      key: representation.key,
      columns: representation.columns === null ? null : Object.freeze([...representation.columns])
    });
}

function assertKeyframeId(id) {
  if (typeof id !== 'string' || !VALID_KEYFRAME_ID.test(id)) {
    throw new TypeError('Camera path keyframe id is invalid.');
  }
  return id;
}

function isExactKeyframeLabel(label) {
  return typeof label === 'string' &&
    label.length > 0 &&
    label === label.trim();
}

function createStoredKeyframe({
  id,
  label,
  navigationMode,
  orbit,
  freefly,
  representation,
  transitionDuration,
  hold = 0
}) {
  return Object.freeze({
    ...(hold > 0 ? { hold } : {}),
    id,
    label,
    navigationMode,
    representation: freezeRepresentation(representation),
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
    representation: keyframe.representation === null
      ? null
      : {
        key: keyframe.representation.key,
        columns: keyframe.representation.columns === null
          ? null
          : [...keyframe.representation.columns]
      },
    transitionDuration: keyframe.transitionDuration,
    ...(keyframeHold(keyframe) > 0 ? { hold: keyframe.hold } : {})
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
  const expected = Object.hasOwn(value, 'hold') ? HOLDING_KEYFRAME_KEYS : KEYFRAME_KEYS;
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    return false;
  }
  // A hold is a positive number of seconds; none is no `hold` key.
  if (Object.hasOwn(value, 'hold') && !(isValidKeyframeHold(value.hold) && value.hold > 0)) return false;
  if (!isExactCameraState({
    navigationMode: value.navigationMode,
    orbit: value.orbit,
    freefly: value.freefly
  })) {
    return false;
  }
  if (typeof value.id !== 'string' || !VALID_KEYFRAME_ID.test(value.id)) return false;
  if (!isValidKeyframeRepresentation(value.representation)) return false;
  if (!isExactKeyframeLabel(value.label)) {
    return false;
  }
  if (!Object.hasOwn(value, 'transitionDuration')) return false;
  return value.transitionDuration === null ||
    (
      Number.isFinite(value.transitionDuration) &&
      value.transitionDuration >= MIN_TRANSITION_DURATION_SECONDS
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
 * @property {{key: string, columns: number[]|null}|null} representation
 *                                                The embedding it was recorded on.
 * @property {number|null}  transitionDuration  Seconds to next keyframe, or null for auto-pace.
 * @property {number}       [hold]              Seconds the camera rests here before moving on
 *                                                (positive; absent when it does not rest).
 */

/**
 * Create a new keyframe store. Labels are unique: `add` and `rename` refuse a
 * label another keyframe has (a session restored with two equal labels is
 * kept as it is; a camera path action naming such a label is refused).
 *
 * @returns {{ add, remove, rename, reorder, setDuration, setAllDurations,
 *             setHold, setAllHolds, getAll, getCount, getById, clear, on, off }}
 */
export function createKeyframeStore() {
  /** @type {Keyframe[]} */
  let keyframes = [];
  let nextIndex = 1;

  // One event type: 'changed'.
  const listeners = createListenerSet('the camera keyframes');

  function emit() {
    listeners.notify();
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

  /** Whether a keyframe other than `exceptId` has `label`. */
  function labelInUse(label, exceptId) {
    return keyframes.some((keyframe) => keyframe.label === label && keyframe.id !== exceptId);
  }

  // ---- Public API ----

  /**
   * Add a camera-state snapshot as a new keyframe.
   * @param {Object} cameraState  The value returned by viewer.getCameraState().
   * @param {string|undefined} label  A custom label, or undefined for "KF n".
   * @param {{key: string, columns: number[]|null}|null} representation
   *   The embedding the view it was captured in shows.
   * @param {number} [hold=0]  Seconds the camera rests there before moving on.
   * @returns {string}  The new keyframe's id.
   */
  function add(cameraState, label, representation, hold = 0) {
    if (!isValidCameraState(cameraState)) {
      throw new TypeError(
        'Camera path keyframes require an exact synchronized camera state.'
      );
    }
    // `nextIndex` numbers default labels and nothing else, so a caller that
    // brings its own label must not consume one. The return-to-start keyframe
    // is such a caller: letting it advance the counter made every later "KF n"
    // skip a number, and toggling it repeatedly walked the numbering away from
    // the list the user is looking at. A default label someone already gave a
    // keyframe is skipped: a keyframe is named by its label (camera path
    // actions, `app/actions/definitions/camera.js`), so labels are unique.
    const usesDefaultLabel = label === undefined;
    if (usesDefaultLabel) {
      while (labelInUse(`KF ${nextIndex}`, null)) nextIndex++;
    }
    const exactLabel = usesDefaultLabel ? `KF ${nextIndex}` : label;
    if (!isExactKeyframeLabel(exactLabel)) {
      throw new TypeError(
        'Camera path keyframe label must be a trimmed non-empty string.'
      );
    }
    if (labelInUse(exactLabel, null)) {
      throw new RangeError(`A camera path keyframe is labeled "${exactLabel}" already.`);
    }
    if (!isValidKeyframeRepresentation(representation)) {
      throw new TypeError(
        'Camera path keyframes record the representation they were captured on, or null.'
      );
    }
    assertHold(hold);
    const id = createOpaqueId();
    keyframes.push(createStoredKeyframe({
      id,
      label: exactLabel,
      navigationMode: cameraState.navigationMode,
      orbit: cameraState.orbit,
      freefly: cameraState.freefly,
      representation,
      transitionDuration: null, // auto-pace by default
      hold
    }));
    if (usesDefaultLabel) nextIndex++;
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
        'Camera path keyframe label must be a trimmed non-empty string.'
      );
    }
    if (labelInUse(newLabel, id)) {
      throw new RangeError(`A camera path keyframe is labeled "${newLabel}" already.`);
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
        duration < MIN_TRANSITION_DURATION_SECONDS
      )
    ) {
      throw new TypeError(
        `Camera path duration must be null or a finite number of at least ${MIN_TRANSITION_DURATION_SECONDS} seconds.`
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
        duration < MIN_TRANSITION_DURATION_SECONDS
      )
    ) {
      throw new TypeError(
        `Camera path duration must be null or a finite number of at least ${MIN_TRANSITION_DURATION_SECONDS} seconds.`
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

  function assertHold(seconds) {
    if (!isValidKeyframeHold(seconds)) {
      throw new TypeError('Camera path hold must be a finite number of seconds, 0 or more.');
    }
  }

  /**
   * Set how long the camera rests at the keyframe at `index` before moving on.
   * @param {number} index    Keyframe index (0-based).
   * @param {number} seconds  0 for no rest.
   */
  function setHold(index, seconds) {
    if (!Number.isInteger(index) || index < 0 || index >= keyframes.length) {
      throw new RangeError(`Camera path keyframe index is out of range: ${String(index)}.`);
    }
    assertHold(seconds);
    keyframes[index] = createStoredKeyframe({ ...keyframes[index], hold: seconds });
    emit();
  }

  /** Set the same hold on every keyframe. */
  function setAllHolds(seconds) {
    assertHold(seconds);
    for (let i = 0; i < keyframes.length; i++) {
      keyframes[i] = createStoredKeyframe({ ...keyframes[i], hold: seconds });
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
    setHold,
    setAllHolds,
    getAll,
    getCount,
    getById,
    clear,
    exportAll,
    importAll,
    on,
    off
  };
}
