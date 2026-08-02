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

const VALID_DIMENSION_LEVELS = new Set([1, 2, 3]);

const VALID_VIEWER_BACKGROUNDS = new Set(['grid', 'grid-dark', 'white', 'black']);
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

function assertFiniteFloat32Array(value, expectedLength, label) {
  const exact = assertExactFloat32Array(value, expectedLength, label);
  for (let index = 0; index < exact.length; index += 1) {
    if (!Number.isFinite(exact[index])) {
      throw new RangeError(`${label} value ${index} must be finite.`);
    }
  }
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

function assertTransparencyArray(value, expectedLength, label) {
  const exact = assertExactFloat32Array(value, expectedLength, label);
  for (let index = 0; index < exact.length; index += 1) {
    const alpha = exact[index];
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
      throw new RangeError(
        `${label} value ${index} must be finite and between 0 and 1.`
      );
    }
  }
  return exact;
}

function assertViewerDataPayload(payload) {
  const exact = assertExactPlainRecord(
    payload,
    [
      'positions',
      'colors',
      'transparency',
      'dimensionLevel'
    ],
    'Viewer data'
  );
  const dimensionLevel = exact.dimensionLevel;
  getDefaultNavigationMode(dimensionLevel);
  if (
    !(exact.positions instanceof Float32Array) ||
    exact.positions.length % 3 !== 0
  ) {
    throw new TypeError(
      'Viewer positions must be a Float32Array with exactly three values per point.'
    );
  }
  const pointCount = exact.positions.length / 3;
  assertFiniteFloat32Array(
    exact.positions,
    pointCount * 3,
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
    colors: new Uint8Array(exact.colors),
    transparency: new Float32Array(exact.transparency),
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
  if (!VALID_VIEWER_BACKGROUNDS.has(mode)) {
    throw new TypeError(
      'Viewer background must be exactly "grid", "grid-dark", "white", or "black".'
    );
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
  cloneSnapshotMeta,
};
