/**
 * The exact value, payload and configuration contracts the viewer enforces at
 * its public boundary.
 *
 * Everything here is a pure guard: it either returns the caller's value
 * unchanged, returns an exact normalised record derived from it, or throws.
 * Nothing reads viewer state, touches WebGL, or allocates a GPU owner, so the
 * whole file can be exercised without a canvas.
 *
 * Three layers, in dependency order: the scalar and identifier guards, the
 * typed-array guards, and the payload/snapshot records assembled from them.
 */

import { cloneCameraState } from '../camera-state-contract.js';
import { isProvenFiniteFloat32Array, markProvenFiniteFloat32Array } from '../position-layout.js';
import {
  VIEWER_BACKGROUND_ERROR_MESSAGE,
  isViewerBackground
} from '../viewer-backgrounds.js';

const VALID_DIMENSION_LEVELS = new Set([1, 2, 3]);

const VALID_RENDER_MODES = new Set(['points', 'smoke']);

/**
 * Return the camera default owned by an exact supported embedding dimension.
 *
 * @param {unknown} dimensionLevel
 * @returns {'orbit'|'planar'}
 */
export function getDefaultNavigationMode(dimensionLevel) {
  if (!VALID_DIMENSION_LEVELS.has(dimensionLevel)) {
    throw new RangeError(
      `Camera dimension must be exactly 1, 2, or 3; received ${String(dimensionLevel)}.`
    );
  }
  return dimensionLevel === 3 ? 'orbit' : 'planar';
}

function assertViewId(viewId) {
  if (typeof viewId !== 'string' || viewId.length === 0) {
    throw new TypeError('Renderer view id must be a non-empty string.');
  }
  return viewId;
}

function assertExactBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} state must be an exact boolean.`);
  }
  return value;
}

function assertFiniteNumberInRange(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be one finite number.`);
  }
  if (value < min || value > max) {
    throw new RangeError(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

function assertIntegerInRange(value, min, max, label) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be one safe integer.`);
  }
  if (value < min || value > max) {
    throw new RangeError(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

function assertExactFunction(value, label) {
  if (typeof value !== 'function') {
    throw new TypeError(`${label} must be one function.`);
  }
  return value;
}

function assertNonEmptyTrimmedString(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new TypeError(
      `${label} must be one non-empty string without leading or trailing whitespace.`
    );
  }
  return value;
}

function assertExactPlainRecord(value, expectedKeys, label) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be one exact plain object.`);
  }
  const actualKeys = Object.keys(value).sort();
  const exactKeys = expectedKeys.slice().sort();
  if (
    actualKeys.length !== exactKeys.length ||
    actualKeys.some((key, index) => key !== exactKeys[index])
  ) {
    throw new TypeError(
      `${label} must contain exactly: ${exactKeys.join(', ')}.`
    );
  }
  return value;
}

function assertExactFloat32Array(value, expectedLength, label) {
  if (!(value instanceof Float32Array)) {
    throw new TypeError(`${label} must be a Float32Array.`);
  }
  if (value.length !== expectedLength) {
    throw new RangeError(
      `${label} must contain exactly ${expectedLength} values; received ${value.length}.`
    );
  }
  return value;
}

/**
 * A published positions or centroid array is never written after
 * publication, so it is proven finite once: scanned the first time it is
 * published, or already proven where it was made (an embedding the reader
 * worker checked, `publishPositionBounds`). A representation switch back to
 * a layout the viewer has shown costs no O(N) pass (a full scan is 30-60 ms
 * at 10M 3D).
 */
function assertFiniteFloat32Array(value, expectedLength, label) {
  const exact = assertExactFloat32Array(value, expectedLength, label);
  if (isProvenFiniteFloat32Array(exact)) return exact;
  for (let index = 0; index < exact.length; index += 1) {
    if (!Number.isFinite(exact[index])) {
      throw new RangeError(`${label} value ${index} must be finite.`);
    }
  }
  markProvenFiniteFloat32Array(exact);
  return exact;
}

function assertExactUint8Array(value, expectedLength, label) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be a Uint8Array.`);
  }
  if (value.length !== expectedLength) {
    throw new RangeError(
      `${label} must contain exactly ${expectedLength} bytes; received ${value.length}.`
    );
  }
  return value;
}

/**
 * Point transparency: one byte a cell, exactly 0 (hidden) or 1 (shown).
 * See rendering/alpha-visibility.js.
 */
function assertTransparencyArray(value, expectedLength, label) {
  const exact = assertExactUint8Array(value, expectedLength, label);
  for (let index = 0; index < exact.length; index += 1) {
    if (exact[index] > 1) {
      throw new RangeError(
        `${label} value ${index} must be exactly 0 or 1.`
      );
    }
  }
  return exact;
}

/**
 * A view's layout key: the identity of the embedding its positions belong
 * to, or exact null for a view with no dataset.
 *
 * @param {unknown} layoutKey
 * @param {string} label
 * @returns {string|null}
 */
function assertViewLayoutKey(layoutKey, label) {
  if (
    layoutKey !== null &&
    (typeof layoutKey !== 'string' || layoutKey.length === 0)
  ) {
    throw new TypeError(
      `${label} layoutKey must be a non-empty string or exact null.`
    );
  }
  return layoutKey;
}

function assertViewerDataPayload(payload) {
  const exact = assertExactPlainRecord(
    payload,
    [
      'positions',
      'colors',
      'transparency',
      'dimensionLevel',
      'layoutKey'
    ],
    'Viewer data'
  );
  const dimensionLevel = exact.dimensionLevel;
  getDefaultNavigationMode(dimensionLevel);
  const layoutKey = assertViewLayoutKey(exact.layoutKey, 'Viewer data');
  if (layoutKey === null && exact.positions?.length !== 0) {
    throw new TypeError(
      'Viewer data with points must name the layout its positions belong to.'
    );
  }
  // Positions carry exactly the embedding's components per point, so the
  // published dimension is also their stride (rendering/position-layout.js).
  if (
    !(exact.positions instanceof Float32Array) ||
    exact.positions.length % dimensionLevel !== 0
  ) {
    throw new TypeError(
      'Viewer positions must be a Float32Array with exactly dimensionLevel values per point.'
    );
  }
  const pointCount = exact.positions.length / dimensionLevel;
  assertFiniteFloat32Array(
    exact.positions,
    pointCount * dimensionLevel,
    'Viewer positions'
  );
  assertExactUint8Array(exact.colors, pointCount * 4, 'Viewer colors');
  assertTransparencyArray(
    exact.transparency,
    pointCount,
    'Viewer transparency'
  );
  return {
    positions: exact.positions,
    colors: exact.colors,
    transparency: exact.transparency,
    dimensionLevel,
    layoutKey,
    pointCount
  };
}

function assertCentroidPayload(payload) {
  const exact = assertExactPlainRecord(
    payload,
    ['positions', 'colors'],
    'Centroid data'
  );
  if (
    !(exact.positions instanceof Float32Array) ||
    exact.positions.length % 3 !== 0
  ) {
    throw new TypeError(
      'Centroid positions must be a Float32Array with exactly three values per centroid.'
    );
  }
  const count = exact.positions.length / 3;
  assertFiniteFloat32Array(
    exact.positions,
    count * 3,
    'Centroid positions'
  );
  assertExactUint8Array(exact.colors, count * 4, 'Centroid colors');
  return {
    positions: exact.positions,
    colors: exact.colors,
    count
  };
}

function cloneSnapshotMeta(value, label = 'Snapshot metadata') {
  const exact = assertExactPlainRecord(
    value,
    ['filtersText'],
    label
  );
  if (
    !Array.isArray(exact.filtersText) ||
    exact.filtersText.some(
      (entry) =>
        typeof entry !== 'string' ||
        entry.length === 0 ||
        entry.trim() !== entry
    )
  ) {
    throw new TypeError(
      `${label} filtersText must be an array of non-empty trimmed strings.`
    );
  }
  return { filtersText: [...exact.filtersText] };
}

function assertSnapshotFieldDescriptor(fieldKey, fieldKind) {
  if (fieldKey === null || fieldKind === null) {
    if (fieldKey !== null || fieldKind !== null) {
      throw new TypeError(
        'Snapshot fieldKey and fieldKind must both be null or both be present.'
      );
    }
    return;
  }
  assertNonEmptyTrimmedString(fieldKey, 'Snapshot field key');
  if (fieldKind !== 'category' && fieldKind !== 'continuous') {
    throw new RangeError(
      'Snapshot field kind must be exactly "category", "continuous", or null.'
    );
  }
}

function assertSnapshotConfig(config, sourcePointCount) {
  const exact = assertExactPlainRecord(
    config,
    [
      'cameraState',
      'centroidColors',
      'centroidPositions',
      'colors',
      'dimensionLevel',
      'fieldKey',
      'fieldKind',
      'label',
      'meta',
      'sourceViewId',
      'transparency'
    ],
    'Snapshot configuration'
  );
  assertNonEmptyTrimmedString(exact.label, 'Snapshot label');
  assertSnapshotFieldDescriptor(exact.fieldKey, exact.fieldKind);
  assertExactUint8Array(
    exact.colors,
    sourcePointCount * 4,
    'Snapshot colors'
  );
  assertTransparencyArray(
    exact.transparency,
    sourcePointCount,
    'Snapshot transparency'
  );
  const centroidArrays = [
    exact.centroidPositions,
    exact.centroidColors
  ];
  const allCentroidsNull = centroidArrays.every((value) => value === null);
  if (
    !allCentroidsNull &&
    centroidArrays.some((value) => value === null)
  ) {
    throw new TypeError(
      'Snapshot centroid positions and colors must be published together.'
    );
  }
  let centroidCount = 0;
  if (!allCentroidsNull) {
    if (
      !(exact.centroidPositions instanceof Float32Array) ||
      exact.centroidPositions.length % 3 !== 0
    ) {
      throw new TypeError(
        'Snapshot centroid positions must contain complete Float32 XYZ triples.'
      );
    }
    centroidCount = exact.centroidPositions.length / 3;
    assertFiniteFloat32Array(
      exact.centroidPositions,
      centroidCount * 3,
      'Snapshot centroid positions'
    );
    assertExactUint8Array(
      exact.centroidColors,
      centroidCount * 4,
      'Snapshot centroid colors'
    );
  }
  const dimensionLevel = exact.dimensionLevel;
  getDefaultNavigationMode(dimensionLevel);
  const cameraState = cloneCameraState(
    exact.cameraState,
    'Snapshot camera state'
  );
  return {
    label: exact.label,
    fieldKey: exact.fieldKey,
    fieldKind: exact.fieldKind,
    // A snapshot's colors are kept by reference: the application never writes
    // into an array it has handed to a snapshot (a recolor publishes a new
    // one), which is the same contract the renderer's snapshot store states.
    // Transparency is copied, because the viewer must keep the accepted
    // generation to restore when a later publication fails.
    colors: exact.colors,
    transparency: new Uint8Array(exact.transparency),
    centroidPositions: allCentroidsNull
      ? null
      : new Float32Array(exact.centroidPositions),
    centroidColors: allCentroidsNull
      ? null
      : new Uint8Array(exact.centroidColors),
    centroidCount,
    meta: cloneSnapshotMeta(exact.meta),
    cameraState,
    dimensionLevel
  };
}

function assertCentroidLabelEntries(labels) {
  if (!Array.isArray(labels)) {
    throw new TypeError('Centroid labels must be an array.');
  }
  for (const [index, item] of labels.entries()) {
    const keys = (
      item !== null &&
      typeof item === 'object' &&
      !Array.isArray(item)
    )
      ? Object.keys(item).sort().join(',')
      : '';
    const hasAlpha = keys === 'alpha,el,position';
    if (
      item === null ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.getPrototypeOf(item) !== Object.prototype ||
      (keys !== 'el,position' && !hasAlpha) ||
      !(item.el instanceof HTMLElement) ||
      !Array.isArray(item.position) ||
      item.position.length !== 3 ||
      !item.position.every(
        (value) => typeof value === 'number' && Number.isFinite(value)
      ) ||
      (
        hasAlpha &&
        (
          typeof item.alpha !== 'number' ||
          !Number.isFinite(item.alpha) ||
          item.alpha < 0 ||
          item.alpha > 1
        )
      )
    ) {
      throw new TypeError(
        `Centroid label ${index} must be an exact element/finite-3D-position record with optional finite alpha from 0 through 1.`
      );
    }
  }
  return labels;
}

function assertViewerBackground(mode) {
  if (!isViewerBackground(mode)) {
    throw new TypeError(VIEWER_BACKGROUND_ERROR_MESSAGE);
  }
  return mode;
}

function assertRenderMode(mode) {
  if (!VALID_RENDER_MODES.has(mode)) {
    throw new TypeError('Render mode must be exactly "points" or "smoke".');
  }
  return mode;
}

export {
  VALID_DIMENSION_LEVELS,
  assertCentroidLabelEntries,
  assertCentroidPayload,
  assertExactBoolean,
  assertExactFloat32Array,
  assertExactFunction,
  assertExactUint8Array,
  assertFiniteFloat32Array,
  assertFiniteNumberInRange,
  assertIntegerInRange,
  assertNonEmptyTrimmedString,
  assertRenderMode,
  assertSnapshotConfig,
  assertSnapshotFieldDescriptor,
  assertTransparencyArray,
  assertViewId,
  assertViewerBackground,
  assertViewerDataPayload,
  assertViewLayoutKey,
  cloneSnapshotMeta,
};
