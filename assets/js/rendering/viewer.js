/**
 * WebGL2 Viewer with High-Performance Renderer
 * =============================================
 * Uses HighPerfRenderer for scatter points with WebGL2 only.
 * Keeps smoke, grid, and line rendering.
 */

import { GRID_VS_SOURCE, GRID_FS_SOURCE, LINE_INSTANCED_VS_SOURCE, LINE_INSTANCED_FS_SOURCE } from './shaders/edge-grid-shaders.js';
import { createConnectivityRenderWeights } from './connectivity-weights.js';
import {
  createProgram,
  createCanvasResizeObserver,
  createRequiredTexture
} from './gl-utils.js';
import { CENTROID_VS, CENTROID_FS } from './shaders/centroid-shaders.js';
import { SmokeRenderer } from './smoke-cloud/smoke-renderer.js';
import { HighPerfRenderer } from './high-perf-renderer.js';
import { HighlightTools } from './highlight-renderer.js';
import { OrbitAnchorRenderer } from './orbit-anchor.js';
import { createProjectileSystem } from './projectiles.js';
import { OverlayManager } from './overlays/overlay-manager.js';
import { buildOverlayContext } from './overlays/overlay-context.js';
import {
  DEFAULT_VELOCITY_PARTICLE_CAPACITY,
  VelocityOverlay,
  validateActiveVelocityFieldId,
  validateVelocityFieldId,
  validateVelocityOverlayConfig
} from './overlays/velocity/velocity-overlay.js';
import {
  assertCameraState,
  assertNavigationMode,
  cloneCameraState
} from './camera-state-contract.js';
import {
  applyHorizontalProjectionCenter,
  computePaneCenterNdcX
} from './viewport-center.js';
import { findRaySamplePick } from './picking.js';

const VALID_DIMENSION_LEVELS = new Set([1, 2, 3]);
const INITIAL_DIMENSION_LEVEL = 3;
const VALID_VIEWER_BACKGROUNDS = new Set(['grid', 'grid-dark', 'white', 'black']);
const VALID_RENDER_MODES = new Set(['points', 'smoke']);
const VELOCITY_OVERLAY_ID = 'velocity';
// Below this size, one direct interaction scan is cheaper than retaining a
// tree. Large clicked panes build exactly one notified tree lazily so picking,
// lasso previews, and proximity previews never rescan 10–30M points per move.
export const INTERACTIVE_SPATIAL_INDEX_POINT_THRESHOLD = 250_000;
// The raw GL/renderer getters remain available only so cleanup diagnostics can
// inspect exact owners. Their returned objects are read-only by contract once
// isDisposed() becomes true; normal renderer work must use a new viewer.
const TERMINAL_SAFE_VIEWER_METHODS = new Set([
  'dispose',
  'getGLContext',
  'getHPRenderer',
  'isDisposed',
  'isDisposalSettled',
  'isPaused',
  'isWebGL2',
  'pause',
  'resume',
  'start'
]);

export {
  assertCameraState,
  assertNavigationMode,
  cloneCameraState
} from './camera-state-contract.js';

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

/**
 * Return the exact binary visibility byte consumed by the edge shader.
 * WebGL normalizes R8 bytes to [0, 1], so 0/255 preserves the shader's
 * historical `visibility < 0.5` decision for every finite Float32 input in
 * the documented [0, 1] contract.
 *
 * @param {number} value
 * @param {number} [index=-1]
 * @returns {0|255}
 */
export function encodeEdgeVisibilityByte(value, index = -1) {
  const suffix = Number.isSafeInteger(index) && index >= 0
    ? ` at index ${index}`
    : '';
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(
      `Connectivity visibility${suffix} must be one finite Float32 value.`
    );
  }
  if (value < 0 || value > 1) {
    throw new RangeError(
      `Connectivity visibility${suffix} must be between 0 and 1.`
    );
  }
  return value < 0.5 ? 0 : 255;
}

/**
 * Compute the square-ish texture layout shared by edge positions and
 * visibility. Keeping this pure makes the exact allocation arithmetic
 * independently testable at production-scale point counts.
 *
 * @param {number} count
 * @param {number} maxTextureSize
 * @returns {[number, number]}
 */
export function calculateEdgeTextureDimensions(count, maxTextureSize) {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(
      'Connectivity texture count must be one non-negative safe integer.'
    );
  }
  if (!Number.isSafeInteger(maxTextureSize) || maxTextureSize <= 0) {
    throw new RangeError(
      'Connectivity maximum texture size must be one positive safe integer.'
    );
  }
  if (count === 0) return [1, 1];
  const width = Math.min(Math.ceil(Math.sqrt(count)), maxTextureSize);
  const height = Math.ceil(count / width);
  return [width, Math.min(height, maxTextureSize)];
}

function assertViewId(viewId) {
  if (typeof viewId !== 'string' || viewId.length === 0) {
    throw new TypeError('Renderer view id must be a non-empty string.');
  }
  return viewId;
}

function createViewerDisposedError(methodName) {
  const error = new Error(
    `Viewer method "${methodName}" is unavailable after dispose(); ` +
    'create a new viewer instance.'
  );
  error.name = 'ViewerDisposedError';
  return error;
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

function assertNoWebGLError(gl, label) {
  const errorCodes = [];
  for (let attempt = 0; attempt < 32; attempt++) {
    const errorCode = gl.getError();
    if (errorCode === gl.NO_ERROR) break;
    errorCodes.push(errorCode);
  }
  if (errorCodes.length > 0) {
    const encodedErrors = errorCodes
      .map(errorCode => `0x${errorCode.toString(16)}`)
      .join(', ');
    throw new Error(
      `${label} encountered WebGL error${errorCodes.length === 1 ? '' : 's'} ${encodedErrors}.`
    );
  }
}

/**
 * Execute one ArrayBufferView texture publication against neutral WebGL2
 * unpack state and restore every caller-owned binding/addressing parameter.
 *
 * @param {WebGL2RenderingContext|Object} gl
 * @param {WebGLTexture|Object} texture
 * @param {string} label
 * @param {Function} upload
 */
export function runExactEdgeTextureUpload(
  gl,
  texture,
  label,
  upload
) {
  assertNoWebGLError(gl, `${label} preflight`);
  const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
  const unpackParameters = [
    gl.UNPACK_ALIGNMENT,
    gl.UNPACK_ROW_LENGTH,
    gl.UNPACK_IMAGE_HEIGHT,
    gl.UNPACK_SKIP_PIXELS,
    gl.UNPACK_SKIP_ROWS,
    gl.UNPACK_SKIP_IMAGES,
  ].filter(Number.isInteger);
  const ownsPixelUnpackBufferState = (
    Number.isInteger(gl.PIXEL_UNPACK_BUFFER) &&
    Number.isInteger(gl.PIXEL_UNPACK_BUFFER_BINDING) &&
    typeof gl.bindBuffer === 'function'
  );
  const previousPixelStore = unpackParameters.map(
    parameter => gl.getParameter(parameter)
  );
  const previousPixelUnpackBuffer = ownsPixelUnpackBufferState
    ? gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING)
    : null;
  let publicationError = null;
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (ownsPixelUnpackBufferState) {
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    }
    for (const parameter of unpackParameters) {
      gl.pixelStorei(
        parameter,
        parameter === gl.UNPACK_ALIGNMENT ? 1 : 0
      );
    }
    upload();
    assertNoWebGLError(gl, label);
  } catch (error) {
    publicationError = error instanceof Error
      ? error
      : new Error(`${label} threw a non-Error value.`);
  }

  const restorationFailures = [];
  const restorationOperations = [];
  for (let index = 0; index < unpackParameters.length; index++) {
    restorationOperations.push(
      () => gl.pixelStorei(
        unpackParameters[index],
        previousPixelStore[index]
      )
    );
  }
  if (ownsPixelUnpackBufferState) {
    restorationOperations.push(
      () => gl.bindBuffer(
        gl.PIXEL_UNPACK_BUFFER,
        previousPixelUnpackBuffer
      )
    );
  }
  restorationOperations.push(
    () => gl.bindTexture(gl.TEXTURE_2D, previousTexture)
  );
  for (const operation of restorationOperations) {
    try {
      operation();
    } catch (error) {
      restorationFailures.push(
        error instanceof Error
          ? error
          : new Error(`${label} state restoration threw a non-Error value.`)
      );
    }
  }
  try {
    assertNoWebGLError(gl, `${label} state restoration`);
  } catch (error) {
    restorationFailures.push(error);
  }
  if (publicationError !== null || restorationFailures.length > 0) {
    const failures = publicationError === null
      ? restorationFailures
      : [publicationError, ...restorationFailures];
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(
      failures,
      `${label} failed and WebGL state restoration was incomplete.`
    );
  }
}

/**
 * Drain exact texture handles while distinguishing a pre-delete failure from
 * a wrapper that threw after WebGL already accepted deletion.
 *
 * @param {WebGL2RenderingContext|Object} gl
 * @param {Set<*>} pending
 * @returns {Error[]}
 */
export function drainExactTextureRetirements(gl, pending) {
  if (!(pending instanceof Set)) {
    throw new TypeError(
      'Texture retirement journal must be one exact Set.'
    );
  }
  const failures = [];
  for (const texture of Array.from(pending)) {
    try {
      gl.deleteTexture(texture);
      pending.delete(texture);
    } catch (error) {
      const exactError = error instanceof Error
        ? error
        : new Error('Texture retirement threw a non-Error value.');
      let definitelyRetired = false;
      if (typeof gl.isTexture === 'function') {
        try {
          definitelyRetired = gl.isTexture(texture) === false;
        } catch (livenessError) {
          failures.push(
            new AggregateError(
              [
                exactError,
                livenessError instanceof Error
                  ? livenessError
                  : new Error(
                    'Texture liveness check threw a non-Error value.'
                  ),
              ],
              'Texture deletion and liveness verification both failed.'
            )
          );
          continue;
        }
      }
      if (definitelyRetired) {
        pending.delete(texture);
      } else {
        failures.push(exactError);
      }
    }
  }
  return failures;
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

function assertOutlierArray(value, expectedLength, label) {
  const exact = assertExactFloat32Array(value, expectedLength, label);
  for (let index = 0; index < exact.length; index += 1) {
    const quantile = exact[index];
    if (!Number.isFinite(quantile) || quantile < -1) {
      throw new RangeError(
        `${label} value ${index} must be finite and at least -1.`
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

/**
 * Track whether dimension defaults still own navigation for each view.
 * This state changes only on UI/session events and is never read by the render
 * loop.
 */
export function createNavigationModeOwnership() {
  let sharedUserChoice = false;
  const viewUserChoices = new Set();

  return Object.freeze({
    recordSharedUserChoice(mode) {
      assertNavigationMode(mode);
      sharedUserChoice = true;
    },
    recordViewUserChoice(viewId, mode) {
      assertNavigationMode(mode);
      viewUserChoices.add(assertViewId(viewId));
    },
    promoteViewUserChoice(viewId, mode) {
      assertNavigationMode(mode);
      const exactViewId = assertViewId(viewId);
      if (!viewUserChoices.has(exactViewId)) {
        return false;
      }
      sharedUserChoice = true;
      return true;
    },
    hasExplicitUserChoice(viewId) {
      const exactViewId = assertViewId(viewId);
      return sharedUserChoice || viewUserChoices.has(exactViewId);
    },
    deleteView(viewId) {
      viewUserChoices.delete(assertViewId(viewId));
    },
    clear() {
      sharedUserChoice = false;
      viewUserChoices.clear();
    }
  });
}

export function createViewer({ canvas, labelLayer, viewTitleLayer, onViewFocus }) {
  // Every current rendering path requires WebGL2.
  const gl = canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance' });

  if (!gl) {
    throw new Error('WebGL2 is required but not supported in this browser.');
  }

  console.log('[Viewer] Using WebGL2');

  // ResizeObserver-based canvas sizing to avoid per-frame layout reads
  const canvasResizeObserver = createCanvasResizeObserver(canvas);

  const mat4 = glMatrix.mat4;
  const vec3 = glMatrix.vec3;
  const vec4 = glMatrix.vec4;

  // === HIGH-PERFORMANCE RENDERER FOR SCATTER POINTS ===
  const hpRenderer = new HighPerfRenderer(gl, {
    USE_LOD: false,
    USE_FRUSTUM_CULLING: false,
    USE_INTERLEAVED_BUFFERS: true
  });
  console.log('[Viewer] HighPerfRenderer initialized');

  // === ORBIT ANCHOR RENDERER ===
  // Per-view compass visualization with proper elevation indicator and cardinal markers
  const orbitAnchorRenderer = new OrbitAnchorRenderer(gl, canvas);
  console.log('[Viewer] OrbitAnchorRenderer initialized');

  // === SMOKE RENDERER ===
  const smokeRenderer = new SmokeRenderer(gl, createProgram);
  console.log('[Viewer] SmokeRenderer initialized');

  // === INSTANCED LINE PROGRAM (V2 - GPU-optimized) ===
  const lineInstancedProgram = createProgram(gl, LINE_INSTANCED_VS_SOURCE, LINE_INSTANCED_FS_SOURCE);
  const lineInstancedAttribLocations = {
    quadPos: gl.getAttribLocation(lineInstancedProgram, 'a_quadPos'),
  };
  const lineInstancedUniformLocations = {
    mvpMatrix:         gl.getUniformLocation(lineInstancedProgram, 'u_mvpMatrix'),
    viewMatrix:        gl.getUniformLocation(lineInstancedProgram, 'u_viewMatrix'),
    modelMatrix:       gl.getUniformLocation(lineInstancedProgram, 'u_modelMatrix'),
    viewportSize:      gl.getUniformLocation(lineInstancedProgram, 'u_viewportSize'),
    lineWidth:         gl.getUniformLocation(lineInstancedProgram, 'u_lineWidth'),
    maxEdges:          gl.getUniformLocation(lineInstancedProgram, 'u_maxEdges'),
    edgeTexture:       gl.getUniformLocation(lineInstancedProgram, 'u_edgeTexture'),
    edgeWeightTexture: gl.getUniformLocation(lineInstancedProgram, 'u_edgeWeightTexture'),
    edgeTexDims:       gl.getUniformLocation(lineInstancedProgram, 'u_edgeTexDims'),
    positionTexture:   gl.getUniformLocation(lineInstancedProgram, 'u_positionTexture'),
    posTexDims:        gl.getUniformLocation(lineInstancedProgram, 'u_posTexDims'),
    visibilityTexture: gl.getUniformLocation(lineInstancedProgram, 'u_visibilityTexture'),
    lineColor:         gl.getUniformLocation(lineInstancedProgram, 'u_lineColor'),
    lineAlpha:         gl.getUniformLocation(lineInstancedProgram, 'u_lineAlpha'),
    fogDensity:        gl.getUniformLocation(lineInstancedProgram, 'u_fogDensity'),
    fogNearMean:       gl.getUniformLocation(lineInstancedProgram, 'u_fogNearMean'),
    fogFarMean:        gl.getUniformLocation(lineInstancedProgram, 'u_fogFarMean'),
    fogColor:          gl.getUniformLocation(lineInstancedProgram, 'u_fogColor'),
  };

  // === GRID PROGRAM ===
  const gridProgram = createProgram(gl, GRID_VS_SOURCE, GRID_FS_SOURCE);
  const gridAttribLocations = {
    position: gl.getAttribLocation(gridProgram, 'a_position'),
  };
  const gridUniformLocations = {
    mvpMatrix:    gl.getUniformLocation(gridProgram, 'u_mvpMatrix'),
    viewMatrix:   gl.getUniformLocation(gridProgram, 'u_viewMatrix'),
    modelMatrix:  gl.getUniformLocation(gridProgram, 'u_modelMatrix'),
    gridColor:    gl.getUniformLocation(gridProgram, 'u_gridColor'),
    bgColor:      gl.getUniformLocation(gridProgram, 'u_bgColor'),
    gridSpacing:  gl.getUniformLocation(gridProgram, 'u_gridSpacing'),
    gridLineWidth: gl.getUniformLocation(gridProgram, 'u_gridLineWidth'),
    gridOpacity:  gl.getUniformLocation(gridProgram, 'u_gridOpacity'),
    planeAlpha:   gl.getUniformLocation(gridProgram, 'u_planeAlpha'),
    planeType:    gl.getUniformLocation(gridProgram, 'u_planeType'),
    fogDensity:   gl.getUniformLocation(gridProgram, 'u_fogDensity'),
    fogNearMean:  gl.getUniformLocation(gridProgram, 'u_fogNearMean'),
    fogFarMean:   gl.getUniformLocation(gridProgram, 'u_fogFarMean'),
    axisXColor:   gl.getUniformLocation(gridProgram, 'u_axisXColor'),
    axisYColor:   gl.getUniformLocation(gridProgram, 'u_axisYColor'),
    axisZColor:   gl.getUniformLocation(gridProgram, 'u_axisZColor'),
    gridSize:     gl.getUniformLocation(gridProgram, 'u_gridSize'),
  };

  // === CENTROID PROGRAM (simple WebGL2 shader for small centroid count) ===
  const centroidProgram = createProgram(gl, CENTROID_VS, CENTROID_FS);
  const centroidAttribLocations = {
    position: gl.getAttribLocation(centroidProgram, 'a_position'),
    color: gl.getAttribLocation(centroidProgram, 'a_color'), // RGBA uint8 normalized
  };
  const centroidUniformLocations = {
    mvpMatrix: gl.getUniformLocation(centroidProgram, 'u_mvpMatrix'),
    viewMatrix: gl.getUniformLocation(centroidProgram, 'u_viewMatrix'),
    modelMatrix: gl.getUniformLocation(centroidProgram, 'u_modelMatrix'),
    pointSize: gl.getUniformLocation(centroidProgram, 'u_pointSize'),
    sizeAttenuation: gl.getUniformLocation(centroidProgram, 'u_sizeAttenuation'),
    viewportHeight: gl.getUniformLocation(centroidProgram, 'u_viewportHeight'),
    fov: gl.getUniformLocation(centroidProgram, 'u_fov'),
  };

  // Highlight toolset (renderer + interactive tools)
  let highlightTools = null;
  let currentShaderQuality = 'full';

  // === OVERLAYS (opt-in render passes, e.g. vector field particles) ===
  let overlayManager = null;
  let vectorFieldOverlay = null;

  function ensureOverlayManager() {
    if (overlayManager) return overlayManager;
    overlayManager = new OverlayManager(gl);
    return overlayManager;
  }

  function reportVelocityRenderFailure(value) {
    const exactError = value instanceof Error
      ? value
      : new Error('Velocity rendering failed with a non-Error value.');
    if (velocityRenderFailureHandler === null) {
      queueMicrotask(() => {
        throw exactError;
      });
      return;
    }
    try {
      velocityRenderFailureHandler(exactError);
    } catch (observerError) {
      queueMicrotask(() => {
        throw observerError;
      });
    }
  }

  function settleVelocityRenderFailure(value) {
    const renderError = value instanceof Error
      ? value
      : new Error('Velocity rendering failed with a non-Error value.');
    let reportedError = renderError;
    try {
      vectorFieldOverlay?.setEnabled?.(false);
    } catch (cleanupError) {
      reportedError = new AggregateError(
        [renderError, cleanupError],
        'Velocity rendering failed and shutdown was incomplete.'
      );
    }
    reportVelocityRenderFailure(reportedError);
  }

  function prepareVelocityFrame(viewIds) {
    if (!vectorFieldOverlay?.enabled) return;
    try {
      vectorFieldOverlay.prepareFrame(viewIds);
    } catch (error) {
      settleVelocityRenderFailure(error);
    }
  }

  function ensureVectorFieldOverlay() {
    if (vectorFieldOverlay) return vectorFieldOverlay;
    overlayManager?.retryRetirement(VELOCITY_OVERLAY_ID);
    const candidate = new VelocityOverlay(gl);
    candidate.setFailureHandler(reportVelocityRenderFailure);
    try {
      candidate.init();
      ensureOverlayManager().register(candidate);
    } catch (error) {
      try {
        candidate.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Velocity overlay initialization and cleanup both failed.'
        );
      }
      throw error;
    }
    vectorFieldOverlay = candidate;
    return candidate;
  }

  // === BUFFERS ===
  // Centroid buffers (small count, separate from main points)
  // Color buffer now stores RGBA as uint8 (alpha packed in)
  let centroidPositionBuffer = gl.createBuffer();
  let centroidColorBuffer = gl.createBuffer(); // RGBA uint8
  if (!centroidPositionBuffer || !centroidColorBuffer) {
    if (centroidPositionBuffer) gl.deleteBuffer(centroidPositionBuffer);
    if (centroidColorBuffer) gl.deleteBuffer(centroidColorBuffer);
    throw new Error(
      'Viewer could not allocate the required centroid buffers.'
    );
  }

  // === INSTANCED EDGE RENDERING ===
  // Quad geometry buffer for instanced edges (6 vertices, 2 triangles)
  // Each vertex has (x, y) where x = endpoint (-1=src, +1=dst), y = side (-1=left, +1=right)
  const edgeQuadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, edgeQuadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    // Triangle 1: src-left, src-right, dst-left
    -1, -1,  -1, 1,  1, -1,
    // Triangle 2: src-right, dst-right, dst-left
    -1, 1,  1, 1,  1, -1,
  ]), gl.STATIC_DRAW);

  // V2 edge textures (created on demand)
  // Global edge topology texture (shared across all views - edges don't change)
  let edgeTextureV2 = null;
  let edgeWeightTextureV2 = null;
  let edgeTexDimsV2 = [0, 0];
  let nEdgesV2 = 0;
  let nCellsV2 = 0;
  let hasEdgeDataV2 = false;
  let useInstancedEdges = false;  // Whether to use v2 instanced rendering
  let edgeLodLimit = 0;  // LOD limit for number of edges to render (0 = all)

  // Per-view edge textures for multi-view/multi-dimension support
  // Each view can have different positions (embeddings) and visibility (filters/LOD)
  // Exact renderer geometry generations share one immutable RGB32F texture.
  // The view map intentionally points at the pooled entry itself so a frozen
  // snapshot retains its old generation when the live view is republished.
  const edgePositionTexturePoolV2 = new Map(); // generation -> pooled entry
  const edgePositionTexturesV2 = new Map();   // viewId -> pooled entry
  const edgeVisibilityTexturesV2 = new Map(); // viewId -> { texture, dims: [w, h], scratchBuffer, format }
  const pendingEdgeTextureRetirements = new Set();

  // Debug flag for edge rendering (set to true to enable verbose logging)
  let edgeDebugMode = false;
  let edgeDebugFrameCount = 0;  // Limit debug output to first few frames


  // Centroid snapshot buffers - pre-uploaded GPU buffers for each snapshot view
  // Eliminates per-frame CPU→GPU uploads in multiview mode
  const centroidSnapshotBuffers = new Map(); // viewId -> { vao, buffer, count }
  const pendingCentroidSnapshotRetirements = new Set();

  // Grid plane buffers - 6 sides (complete box)
  const GRID_SIZE = 2.0;
  const gridPlaneBuffers = {
    bottom: gl.createBuffer(),  // XZ plane at y=-s (floor)
    top: gl.createBuffer(),     // XZ plane at y=+s (ceiling)
    back: gl.createBuffer(),    // XY plane at z=-s
    front: gl.createBuffer(),   // XY plane at z=+s
    left: gl.createBuffer(),    // YZ plane at x=-s
    right: gl.createBuffer(),   // YZ plane at x=+s
  };

  function initGridPlanes(size) {
    const s = size || GRID_SIZE;

    // Bottom floor (XZ plane at y=-s)
    gl.bindBuffer(gl.ARRAY_BUFFER, gridPlaneBuffers.bottom);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -s, -s, -s,  s, -s, -s,  s, -s, s,
      -s, -s, -s,  s, -s, s,  -s, -s, s
    ]), gl.STATIC_DRAW);

    // Top ceiling (XZ plane at y=+s)
    gl.bindBuffer(gl.ARRAY_BUFFER, gridPlaneBuffers.top);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -s, s, -s,  s, s, -s,  s, s, s,
      -s, s, -s,  s, s, s,  -s, s, s
    ]), gl.STATIC_DRAW);

    // Back wall (XY plane at z=-s)
    gl.bindBuffer(gl.ARRAY_BUFFER, gridPlaneBuffers.back);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -s, -s, -s,  s, -s, -s,  s, s, -s,
      -s, -s, -s,  s, s, -s,  -s, s, -s
    ]), gl.STATIC_DRAW);

    // Front wall (XY plane at z=+s)
    gl.bindBuffer(gl.ARRAY_BUFFER, gridPlaneBuffers.front);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -s, -s, s,  s, -s, s,  s, s, s,
      -s, -s, s,  s, s, s,  -s, s, s
    ]), gl.STATIC_DRAW);

    // Left wall (YZ plane at x=-s)
    gl.bindBuffer(gl.ARRAY_BUFFER, gridPlaneBuffers.left);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -s, -s, -s,  -s, -s, s,  -s, s, s,
      -s, -s, -s,  -s, s, s,  -s, s, -s
    ]), gl.STATIC_DRAW);

    // Right wall (YZ plane at x=+s)
    gl.bindBuffer(gl.ARRAY_BUFFER, gridPlaneBuffers.right);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      s, -s, -s,  s, -s, s,  s, s, s,
      s, -s, -s,  s, s, s,  s, s, -s
    ]), gl.STATIC_DRAW);
  }
  initGridPlanes(GRID_SIZE);

  // === GL State ===
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  // === Scene Variables ===
  let pointCount = 0;
  let centroidCount = 0;
  let defaultShowCentroidPoints = false;
  let defaultShowCentroidLabels = false;
  const viewCentroidFlags = new Map();
  const viewCentroidLabels = new Map();
  const centroidLabelOwners = new WeakMap();
  const pendingCentroidLabelRetirements = new Map();

  // Small-multiples / snapshot views
  const LIVE_VIEW_ID = 'live';
  const MAX_SNAPSHOTS = 3;
  let snapshotViews = [];
  const pendingSnapshotCleanupIds = new Set();
  let nextSnapshotId = 1;
  let viewLayoutMode = 'grid';
  let focusedViewId = LIVE_VIEW_ID;
  let liveViewLabel = 'View 1';
  let liveViewHidden = false; // Whether to hide live view from grid
  let viewFocusHandler = typeof onViewFocus === 'function' ? onViewFocus : null;
  let navigationModeChangeHandler = null;
  let smokeRenderFailureHandler = null;
  let velocityRenderFailureHandler = null;

  function assertKnownViewId(viewId) {
    const exactViewId = assertViewId(viewId);
    if (
      exactViewId !== LIVE_VIEW_ID &&
      !snapshotViews.some((snapshot) => snapshot.id === exactViewId)
    ) {
      throw new RangeError(`Unknown renderer view "${exactViewId}".`);
    }
    return exactViewId;
  }

  // Camera lock state for independent view navigation
  let camerasLocked = true;           // Default: all views share camera
  let liveCameraState = null;         // Camera state for live view when unlocked

  // Cached view matrices for unlocked camera mode (avoids per-frame recalculation)
  const cachedViewMatrices = new Map();  // viewId -> { viewMatrix: Float32Array, radius: number, dirty: boolean }
  const cachedGridProjections = new Map();
  let cachedGridProjectionAspect = null;

	  // Per-view dimension tracking for multi-dimensional support
	  const viewDimensionLevels = new Map([
	    [LIVE_VIEW_ID, INITIAL_DIMENSION_LEVEL]
	  ]);  // viewId -> exact published dimension level
	  const viewPositionsCache = new Map();   // viewId -> Float32Array positions
	  // Per-view render params (avoid per-frame allocations in multiview render loop)
	  const renderParamsByView = new Map();   // viewId -> mutable params object passed to HighPerfRenderer
	  // Per-view overlay contexts + stable builder options (avoid per-frame allocations/closures)
	  const overlayCtxByView = new Map();     // viewId -> OverlayContext
	  const overlayCtxOptionsByView = new Map(); // viewId -> stable buildOverlayContext options object
	  const lodChangeListeners = new Set();
	  const publishedLodLevels = new Map();

	  function publishLodLevelChange(viewId) {
	    const exactViewId = assertKnownViewId(viewId);
	    const lodLevel = hpRenderer.getCurrentLODLevel(exactViewId);
	    if (!Number.isSafeInteger(lodLevel) || lodLevel < -1) {
	      throw new Error(
	        `Renderer published an invalid LOD level for view "${exactViewId}".`
	      );
	    }
	    if (!publishedLodLevels.has(exactViewId)) {
	      publishedLodLevels.set(exactViewId, lodLevel);
	      return;
	    }
	    if (publishedLodLevels.get(exactViewId) === lodLevel) return;
	    publishedLodLevels.set(exactViewId, lodLevel);
	    const event = Object.freeze({ viewId: exactViewId, lodLevel });
	    for (const listener of lodChangeListeners) {
	      listener(event);
	    }
	  }

	  function getPublishedDimensionLevel(viewId) {
	    if (typeof viewId !== 'string' || viewId.length === 0) {
	      throw new TypeError('Renderer view id must be a non-empty string.');
	    }
	    if (!viewDimensionLevels.has(viewId)) {
	      throw new RangeError(
	        `Dimension state is not published for view "${viewId}".`
	      );
	    }
	    const dimensionLevel = viewDimensionLevels.get(viewId);
	    getDefaultNavigationMode(dimensionLevel);
	    return dimensionLevel;
	  }

	  function getExactViewPositions(viewId) {
	    if (typeof viewId !== 'string' || viewId.length === 0) {
	      throw new TypeError('Renderer view id must be a non-empty string.');
	    }
	    const positions = viewPositionsCache.get(viewId);
	    if (!(positions instanceof Float32Array)) {
	      throw new Error(`Positions are not published for view "${viewId}".`);
	    }
	    return positions;
	  }

		  function getExactViewTransparency(viewId) {
	    if (typeof viewId !== 'string' || viewId.length === 0) {
	      throw new TypeError('Renderer view id must be a non-empty string.');
	    }
	    if (viewId === LIVE_VIEW_ID) {
	      if (!(transparencyArray instanceof Float32Array)) {
	        throw new Error('Transparency is not published for view "live".');
	      }
	      return transparencyArray;
	    }
	    const snapshot = snapshotViews.find((entry) => entry.id === viewId);
	    if (!snapshot) {
	      throw new Error(`View "${viewId}" does not exist.`);
	    }
	    if (!(snapshot.transparency instanceof Float32Array)) {
	      throw new Error(`Transparency is not published for view "${viewId}".`);
	    }
		    return snapshot.transparency;
		  }

      function getSpatialQueryOwner(
        viewId,
        ensureLargeIndex = false
      ) {
        const exactViewId = assertKnownViewId(viewId);
        if (typeof ensureLargeIndex !== 'boolean') {
          throw new TypeError(
            'Spatial-query index preparation state must be an exact boolean.'
          );
        }
        const publishedPositions = getExactViewPositions(exactViewId);
        const transparency = getExactViewTransparency(exactViewId);
        const dimensionLevel =
          getPublishedDimensionLevel(exactViewId);
        const pointCountForView = publishedPositions.length / 3;
        const resolveIndex = () => (
          exactViewId === LIVE_VIEW_ID
            ? hpRenderer.getSpatialIndex(dimensionLevel)
            : hpRenderer.getSnapshotSpatialIndex(
                exactViewId,
                dimensionLevel
              )
        );
        let spatialIndex = resolveIndex();

        if (
          ensureLargeIndex &&
          spatialIndex === null &&
          pointCountForView >=
            INTERACTIVE_SPATIAL_INDEX_POINT_THRESHOLD
        ) {
          if (exactViewId === LIVE_VIEW_ID) {
            hpRenderer.ensureSpatialIndex(dimensionLevel);
          } else {
            hpRenderer.rebuildSnapshotSpatialIndex(
              exactViewId,
              dimensionLevel,
              false
            );
            // Snapshots sharing the current live geometry resolve the main
            // generation's tree instead of owning a duplicate copy.
            if (resolveIndex() === null) {
              hpRenderer.ensureSpatialIndex(dimensionLevel);
            }
          }
          spatialIndex = resolveIndex();
          if (spatialIndex === null) {
            throw new Error(
              `Large view "${exactViewId}" did not publish its prepared spatial index.`
            );
          }
        }

        // Index construction is synchronous today, but verify all publication
        // identities so a future yielding builder cannot return a mixed owner.
        if (
          getExactViewPositions(exactViewId) !== publishedPositions ||
          getExactViewTransparency(exactViewId) !== transparency ||
          getPublishedDimensionLevel(exactViewId) !== dimensionLevel
        ) {
          throw new Error(
            `Spatial-query owner for view "${exactViewId}" changed during preparation.`
          );
        }
        if (
          spatialIndex !== null &&
          (
            spatialIndex.pointCount !== pointCountForView ||
            spatialIndex.dimensionLevel !== dimensionLevel ||
            typeof spatialIndex.visitRaySegmentCandidates !== 'function' ||
            typeof spatialIndex.visitRadiusCandidates !== 'function' ||
            typeof spatialIndex.visitProjectedRectCandidates !== 'function'
          )
        ) {
          throw new Error(
            `Spatial-query index does not match exact view "${exactViewId}".`
          );
        }
        // A snapshot of the current live generation owns a frozen positions
        // copy but may borrow the renderer-certified live tree. Query against
        // that tree's exact coordinate owner while retaining the published
        // snapshot identity below for mid-gesture generation checks.
        const positions = spatialIndex === null
          ? publishedPositions
          : spatialIndex.positions;
        return Object.freeze({
          viewId: exactViewId,
          positions,
          publishedPositions,
          transparency,
          dimensionLevel,
          spatialIndex,
        });
      }

		  function requireSnapshotBufferId(viewId) {
		    const exactId = assertViewId(viewId);
		    if (exactId === LIVE_VIEW_ID) return null;
		    if (!hpRenderer.hasSnapshotBuffer(exactId)) {
		      throw new Error(
		        `View "${exactId}" has no published snapshot GPU buffer.`
		      );
		    }
		    return exactId;
		  }

	  function getOrCreateRenderParams(viewId) {
	    if (typeof viewId !== 'string' || viewId.length === 0) {
	      throw new TypeError('Renderer view id must be a non-empty string.');
	    }
	    const vid = viewId;
	    let renderParams = renderParamsByView.get(vid);
	    if (!renderParams) {
	      renderParams = {
	        mvpMatrix,
	        viewMatrix,
	        modelMatrix,
	        projectionMatrix,
	        pointSize: 5.0,
	        sizeAttenuation: 0,
	        viewportHeight: 0,
	        viewportWidth: 0,
	        fov: 0,
	        lightingStrength: 0,
	        fogDensity: 0,
	        fogColor: [1, 1, 1],
	        lightDir,
	        cameraPosition: vec3.create(),
	        cameraDistance: 0,
	        forceLOD: -1,
	        quality: currentShaderQuality,
	        viewId: vid,
	        dimensionLevel: getPublishedDimensionLevel(vid),
	        useAlphaTexture: false,
	        autoFog: true,
	        overrideBounds: null
	      };
	      renderParamsByView.set(vid, renderParams);
	    }
	    return renderParams;
	  }

  const viewTitleLayerEl = viewTitleLayer || null;
  let viewTitleEntries = [];
  let lastTitleKey = null;
  // Cache for view title layout to avoid per-frame style updates
  let lastTitleLayoutWidth = 0;
  let lastTitleLayoutHeight = 0;
  let lastTitleLayoutCols = 0;
  let lastTitleLayoutRows = 0;

  const projectionMatrix = mat4.create();
  const viewMatrix = mat4.create();
  const modelMatrix = mat4.create();
  const mvpMatrix = mat4.create();
  const viewProjMatrix = mat4.create();
  const invViewProjMatrix = mat4.create();
  const tempInvViewMatrix = mat4.create();
  mat4.identity(modelMatrix);

  const tempVec4 = vec4.create();
  const tempVec3 = vec3.create();
  const tempVec3b = vec3.create();
  const tempVec3c = vec3.create();
  const tempVec3d = vec3.create();  // Scratch for pan forward vector
  const tempVec3e = vec3.create();  // Scratch for pan camRight vector
  const tempVec3f = vec3.create();  // Scratch for pan camUp vector
  const lightDir = vec3.normalize(vec3.create(), [0.5, 0.7, 0.5]);
  // Preallocated scratch vectors for getFreeflyAxes() to avoid per-frame allocations
  const _freeflyForward = vec3.create();
  const _freeflyRight = vec3.create();
  const _freeflyUp = vec3.create();
  const _freeflyWorldUp = vec3.fromValues(0, 1, 0);
  // Preallocated scratch matrix for grid rendering to avoid per-frame mat4.clone()
  const _activeViewMatrixScratch = mat4.create();
  // Preallocated scratch vectors for updateFreefly() to avoid per-frame allocations
  const _freeflyMove = vec3.create();
  const _freeflyTargetVel = vec3.create();
	  // Preallocated scratch vector for updateCamera() free-fly lookTarget to avoid per-frame allocation
	  const _cameraLookTarget = vec3.create();
	  // Preallocated array for render loop view list to avoid per-frame array allocation
	  const _renderAllViews = [];
	  const _renderVelocityViewIds = [];
	  // Reused per-frame parameter objects (avoid per-view per-frame allocations in multiview mode)
	  const _projectileDrawParams = {
	    viewportHeight: 0,
	    mvpMatrix,
	    viewMatrix,
	    modelMatrix,
	    basePointSize: 0,
	    sizeAttenuation: 0,
	    fov: 0,
	  };
	  const _orbitAnchorDrawParams = {
	    viewId: LIVE_VIEW_ID,
	    viewTheta: 0,
	    viewPhi: 0,
	    viewTarget: null,
	    viewRadius: 0,
	    pointBoundsRadius: 0,
	    bgColor: null,
	    use3D: false,
	    mvpMatrix,
	    viewMatrix,
	    modelMatrix,
	    fogDensity: 0,
	    fogColor: null,
	    lightingStrength: 0,
	    lightDir,
	    navigationMode: 'orbit'
	  };

  let positionsArray = null;
  let colorsArray = null;
  let transparencyArray = null;
  let fogNearMean = 0.0;
  let fogFarMean = 1.0;

  // Render mode state
  let renderMode = 'points';
  const startTime = performance.now();
  // Initialize highlight tools after shared start time is available
  highlightTools = new HighlightTools({
    gl,
    canvas,
    hpRenderer,
    mat4,
    vec3,
    pickCellAtScreen,
    screenToRay,
    getViewportInfoAtScreen,
    getRenderContext: () => getHighlightContext(),
    getNavigationState: () => ({ navigationMode, isDragging }),
    getViewPositions: getExactViewPositions,
    getViewTransparency: getExactViewTransparency,
    getSpatialQueryOwner,
    startTime,
    shaderQuality: currentShaderQuality
  });

  // Connectivity/Edge state
  let showConnectivity = false;
  let connectivityLineWidth = 1.0;
  let connectivityAlpha = 0.60;
  const connectivityColorBytes = new Uint8Array([77, 77, 77]); // ~0.3 in 0-255
  const connectivityColorVec = vec3.create(); // normalized to 0-1 on use

  // Camera
  // Keep near plane tight so points do not disappear too early when orbiting in
  const near = 0.02;
  const far = 1000.0;
  const fov = 45 * Math.PI / 180;
  const minOrbitRadius = 0.05;
  let viewportLeftOcclusionRatio = 0;

  let basePointSize = 1.0;
  let lightingStrength = 0.6;
  let fogDensity = 0.5;
  let sizeAttenuation = 0.65;
  // Default to a clean white background; background modes can override.
  let bgColor = [1.0, 1.0, 1.0];
  let fogColor = [1.0, 1.0, 1.0];

  // Grid state - grid is default background (matches 'grid' light mode)
  let showGrid = true;
  // Match original neutral grid contrast, but on pure white instead of off-white.
		  let gridColor = [0.45, 0.45, 0.48];   // Medium gray - visible on light bg
		  let gridBgColor = [1.0, 1.0, 1.0];    // Must match bgColor exactly in light grid mode
		  let gridSpacing = 0.2;
		  let gridLineWidth = 0.008;
		  let gridOpacity = 0.75;
  // Target values for smooth grid transitions
  let targetGridOpacity = 0.75;
  let gridTransitionSpeed = 3.0;  // Opacity change per second
  // Allow theme-specific tuning of how strongly fog affects the grid.
  // In light grid mode we keep the grid more visible at distance by
  // lowering effective fog strength slightly.
  let gridFogDensityMultiplier = 1.0;
  // Scientific grayscale axis colors (no distracting colors)
  let axisXColor = [0.35, 0.35, 0.35];  // Neutral gray for all axes
  let axisYColor = [0.35, 0.35, 0.35];
  let axisZColor = [0.35, 0.35, 0.35];

  // Interaction
  let radius = 3.0;
  let theta = Math.PI / 4;
  let phi = Math.PI / 4;
  const target = vec3.fromValues(0, 0, 0);
  const eye = vec3.create();
  const up = vec3.fromValues(0, 1, 0);
  // Google Earth-style orbit by default (drag inverts horizontal)
  let orbitInvertX = true;

  let isDragging = false;
  let dragMode = 'rotate';
  let lastX = 0;
  let lastY = 0;
  let cursorX = 0;  // Current cursor position for aiming (client coords)
  let cursorY = 0;
	  let targetRadius = radius;
	  let lastTouchDist = 0;
	  let animationHandle = null;
	  let renderPaused = false;
	  let disposed = false;
	  let disposalSettled = false;
	  const completedDisposalSteps = new Set();

  // Navigation (orbit + free-fly + planar)
  let navigationMode = 'orbit';
  const navigationModeOwnership = createNavigationModeOwnership();
  let lookSensitivity = 0.0025; // radians per pixel
  let invertLookX = false;
  let invertLookY = false;
  // Planar mode: zoom to cursor (pinch-style) vs center zoom
  let planarZoomToCursor = true;
  // Planar mode: invert pan axes
  let planarInvertAxes = false;
  let moveSpeed = 1.0; // units per second
  // Keyboard navigation speeds (controlled by UI sliders)
  let orbitKeySpeed = 0.4; // multiplier for orbit rotation and zoom speed
  let planarPanSpeed = 0.0075; // multiplier for planar pan and zoom speed
  const sprintMultiplier = 2.2;
  const activeKeys = new Set();
  let freeflyPosition = vec3.fromValues(0, 0, 3.0);
  let freeflyVelocity = vec3.create();
  let freeflyYaw = Math.PI / 4;
  let freeflyPitch = 0;
  let pointerLockEnabled = false;
  let pointerLockActive = false;
  let pointerLockChangeHandler = null;
  let pointerLockRequestGeneration = 0;
  let pointerLockRequestPending = false;
  let pendingShot = false;
  let pendingShotViewportInfo = null;  // Cached viewport info for pointer lock shots
  let projectileBuildGeneration = 0;
  let projectileBuildTimer = null;
  let projectileBuildCompletion = null;
  let lookActive = false;
  let lastFrameTime = performance.now();
  let renderFrameId = 0;

  let velocityTheta = 0;
  let velocityPhi = 0;
  let velocityPanX = 0;
  let velocityPanY = 0;
  let velocityPanZ = 0;
  let lastMoveTime = 0;
  let lastDx = 0;
  let lastDy = 0;

  const INERTIA_FRICTION = 0.92;
  const INERTIA_MIN_VELOCITY = 0.0001;
  const VELOCITY_SMOOTHING = 0.3;
  const PHYSICS_TICK_RATE = 60;          // Reference frame rate for frame-independent physics (Hz)

  const projectileSystem = createProjectileSystem({
    gl,
    canvas,
    mat4,
    vec3,
    vec4,
    hpRenderer,
    physicsTickRate: PHYSICS_TICK_RATE,
    getPointCount: () => pointCount,
    getPositionsArray: () => positionsArray,
    getColorsArray: () => colorsArray,
    getCursorPosition: () => ({ x: cursorX, y: cursorY }),
    getFreeflyPosition: () => freeflyPosition,
    getFreeflyAxes,
    getCameraParams: () => ({ fov, near, far }),
    centroidProgram,
    centroidAttribLocations,
    centroidUniformLocations,
    // For charge indicator
    getLassoCtx: () => highlightTools?.getLassoCtx?.() || null,
    getPointerLockActive: () => pointerLockActive,
    getNavigationMode: () => navigationMode,
    // For grid collision
    getGridBounds: () => ({ min: -GRID_SIZE, max: GRID_SIZE }),
    isGridVisible: () => showGrid && gridOpacity > 0.1,
    // For dimension-aware spatial index collision queries
    getCurrentDimensionLevel: () => getPublishedDimensionLevel(LIVE_VIEW_ID),
  });

  function getOrbitSigns() {
    // Google Earth style: invert horizontal drag to feel like grabbing the globe
    const xSign = orbitInvertX ? -1 : 1;
    // Always keep vertical drag "grab the globe": drag up tilts the globe down
    const ySign = 1;
    return { xSign, ySign };
  }

  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  // === Event Listener Registry (for cleanup/dispose) ===
  const eventCleanupFns = [];
  function addEventListenerWithCleanup(target, event, handler, options) {
    const guardedHandler = function viewerEventHandler(...args) {
      if (disposed) return;
      return Reflect.apply(handler, this, args);
    };
    target.addEventListener(event, guardedHandler, options);
    eventCleanupFns.push(
      () => target.removeEventListener(event, guardedHandler, options)
    );
  }

  // === WebGL context loss handling (WebGL2-only policy) ===
  let webglContextLost = false;
  let webglContextOverlay = null;
  let webglContextOverlayMessage = null;

  function ensureWebglContextOverlay() {
    if (webglContextOverlay) return webglContextOverlay;

    const overlay = document.createElement('div');
    overlay.id = 'cellucid-webgl-context-overlay';
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.65);
      color: #fff;
      font-family: var(--font-sans, system-ui, sans-serif);
      padding: 24px;
      text-align: center;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
      max-width: 520px;
      width: 100%;
      background: rgba(20, 20, 20, 0.9);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 10px;
      padding: 18px 20px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
    `;

    const title = document.createElement('div');
    title.style.cssText = 'font-size: 16px; font-weight: 700; margin-bottom: 10px;';
    title.textContent = 'WebGL Context Lost';

    const message = document.createElement('div');
    message.style.cssText = 'font-size: 13px; line-height: 1.5; opacity: 0.95; margin-bottom: 14px;';
    message.textContent = 'WebGL context lost. Reload required.';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-small';
    btn.textContent = 'Reload';
    btn.style.cssText = 'cursor: pointer;';
    btn.addEventListener('click', () => window.location.reload());

    panel.appendChild(title);
    panel.appendChild(message);
    panel.appendChild(btn);
    overlay.appendChild(panel);

    document.body.appendChild(overlay);
    webglContextOverlay = overlay;
    webglContextOverlayMessage = message;
    return overlay;
  }

  function showWebglContextOverlay(message) {
    const overlay = ensureWebglContextOverlay();
    if (webglContextOverlayMessage) {
      webglContextOverlayMessage.textContent = message;
    }
    overlay.style.display = 'flex';
  }

  // === Event Listeners ===
  const handleContextMenu = (e) => { e.preventDefault(); return false; };
  addEventListenerWithCleanup(canvas, 'contextmenu', handleContextMenu);

  addEventListenerWithCleanup(canvas, 'webglcontextlost', (e) => {
    // Prevent default so the browser is allowed to attempt restoration; we still require reload.
    e.preventDefault();
    if (webglContextLost) return;
    webglContextLost = true;
    const contextLossFailures = [];
    const attemptContextLossStep = operation => {
      try {
        operation();
      } catch (error) {
        contextLossFailures.push(
          error instanceof Error
            ? error
            : new Error('WebGL context-loss cleanup threw a non-Error value.')
        );
      }
    };

    // Fence the scheduled frame before any fallible resource or DOM cleanup.
    // A notification failure must never leave the RAF owner running against a
    // lost context.
    const scheduledAnimationHandle = animationHandle;
    animationHandle = null;
    if (scheduledAnimationHandle !== null) {
      attemptContextLossStep(
        () => cancelAnimationFrame(scheduledAnimationHandle)
      );
    }

    attemptContextLossStep(() => smokeRenderer.handleContextLost());
    attemptContextLossStep(
      () => vectorFieldOverlay?.handleContextLost?.()
    );

    // Hide DOM overlays that assume a working render loop.
    if (labelLayer) {
      attemptContextLossStep(() => {
        labelLayer.style.display = 'none';
      });
    }
    if (viewTitleLayerEl) {
      attemptContextLossStep(() => {
        viewTitleLayerEl.style.display = 'none';
      });
    }

    attemptContextLossStep(() => {
      showWebglContextOverlay(
        'WebGL context lost. Reload required to continue.'
      );
    });
    if (contextLossFailures.length > 0) {
      const cleanupError = new AggregateError(
        contextLossFailures,
        'WebGL context loss was fenced, but cleanup was incomplete.'
      );
      // Context loss is already a terminal viewer lifecycle. Surface cleanup
      // defects without turning the expected DOM event into an uncaught
      // pageerror that can obscure the reload recovery UI.
      console.error('[Viewer] WebGL context-loss cleanup was incomplete.', cleanupError);
    }
  });

  addEventListenerWithCleanup(canvas, 'webglcontextrestored', () => {
    // Resource re-init is complex and high-risk; require a full reload.
    showWebglContextOverlay('WebGL context restored, but Cellucid requires a reload to reinitialize GPU resources.');
  });

  addEventListenerWithCleanup(canvas, 'mousedown', (e) => {
    if (highlightTools && highlightTools.handleMouseDown(e)) {
      return;
    }

    const highlighterActive = highlightTools?.isInteractionActive?.();
    // In grid mode, ALWAYS update focused view when clicking in a different view's area.
    // This ensures dimension controls and other view-specific operations target the correct view.
    // Camera save/restore only happens when cameras are unlocked.
    if (viewLayoutMode === 'grid' && !highlighterActive) {
      const clickedViewId = getViewIdAtScreenPosition(e.clientX, e.clientY);
      if (clickedViewId && clickedViewId !== focusedViewId) {
        // Only save/restore cameras when unlocked
        if (!camerasLocked) {
          // Save current camera to previous view
          setViewCameraState(focusedViewId, getCurrentCameraStateInternal());
          // Stop any ongoing inertia (so it doesn't carry to new view)
          velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
          vec3.set(freeflyVelocity, 0, 0, 0);
        }
        // Switch focus (always, regardless of camera lock state)
        focusedViewId = clickedViewId;
        // Update active state on view title chips
        updateViewTitleActiveState();
        // Load new view's camera (only when unlocked)
        if (!camerasLocked) {
          const newCam = getViewCameraState(focusedViewId);
          if (newCam) applyCameraStateTemporarily(newCam);
        }
        // Notify UI (always, so dimension buttons target the clicked view)
        if (viewFocusHandler) viewFocusHandler(focusedViewId);
      }
    }

    if (navigationMode === 'free') {
      const wantsShot = e.button === 0;
      // Only request pointer lock if user has enabled it via checkbox
      if (pointerLockEnabled && !pointerLockActive) {
        // Pointer lock enabled but not yet active - request it and queue the shot
        // Capture viewport info NOW (before pointer lock changes cursor behavior)
        if (wantsShot) {
          const vpInfo = getViewportInfoAtScreen(e.clientX, e.clientY);
          // Use getCameraForView which correctly handles non-focused views via cached view matrix
          const { position: cameraPosition, axes: cameraAxes } = getCameraForView(vpInfo.viewId);
          pendingShotViewportInfo = {
            vpWidth: vpInfo.vpWidth,
            vpHeight: vpInfo.vpHeight,
            vpOffsetX: vpInfo.vpOffsetX,
            vpOffsetY: vpInfo.vpOffsetY,
            vpAspect: vpInfo.vpAspect,
            cameraPosition,
            cameraAxes
          };
        }
        pendingShot = pendingShot || wantsShot;
        requestPointerLockOwned();
      } else {
        // Either pointer lock is disabled, or already active - use normal mouse look
        lookActive = true;
        lastX = e.clientX;
        lastY = e.clientY;
        if (wantsShot) {
          // Start charging instead of firing immediately
          const vpInfo = getViewportInfoAtScreen(e.clientX, e.clientY);
          // Use getCameraForView which correctly handles non-focused views via cached view matrix
          const { position: cameraPosition, axes: cameraAxes } = getCameraForView(vpInfo.viewId);
          projectileSystem.startCharging({
            vpWidth: vpInfo.vpWidth,
            vpHeight: vpInfo.vpHeight,
            vpOffsetX: vpInfo.vpOffsetX,
            vpOffsetY: vpInfo.vpOffsetY,
            vpAspect: vpInfo.vpAspect,
            cameraPosition,
            cameraAxes
          });
        }
      }
      canvas.classList.add('dragging');
      canvas.style.cursor = pointerLockActive ? 'none' : 'crosshair';
      e.preventDefault();
      return;
    }
    isDragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    lastMoveTime = performance.now();
    velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
    lastDx = lastDy = 0;

    if (navigationMode === 'planar') {
      // Planar mode: always pan (no rotation)
      dragMode = 'pan';
      canvas.style.cursor = 'move';
    } else if (e.button === 2 || e.shiftKey) {
      dragMode = 'pan';
      canvas.style.cursor = 'move';
    } else {
      dragMode = 'rotate';
      canvas.style.cursor = 'grabbing';
    }
    canvas.classList.add('dragging');
  });

  const handleMouseUp = (e) => {
    if (highlightTools && highlightTools.handleMouseUp(e)) {
      return;
    }

    // Fire charged projectile on release
    if (projectileSystem.isCharging() && e.button === 0) {
      // When pointer lock is active, use the viewport info captured at click time
      // (cursor position is locked, so e.clientX/Y would give wrong viewport)
      let viewportInfo;
      if (pointerLockActive && pendingShotViewportInfo) {
        viewportInfo = pendingShotViewportInfo;
      } else {
        const vpInfo = getViewportInfoAtScreen(e.clientX, e.clientY);
        // Use getCameraForView which correctly handles non-focused views via cached view matrix
        const { position: cameraPosition, axes: cameraAxes } = getCameraForView(vpInfo.viewId);
        viewportInfo = {
          vpWidth: vpInfo.vpWidth,
          vpHeight: vpInfo.vpHeight,
          vpOffsetX: vpInfo.vpOffsetX,
          vpOffsetY: vpInfo.vpOffsetY,
          vpAspect: vpInfo.vpAspect,
          cameraPosition,
          cameraAxes
        };
      }

      projectileSystem.stopChargingAndFire({
        navigationMode,
        pointerLockActive,
        viewportInfo
      });

      // Clear stored viewport info after firing
      pendingShotViewportInfo = null;
    }

    if (navigationMode === 'free') {
      // Keep looking active while pointer lock is held; only stop drag-look when not locked
      if (!pointerLockActive) {
        lookActive = false;
        canvas.classList.remove('dragging');
        canvas.style.cursor = 'crosshair';
      } else {
        canvas.classList.add('dragging');
        canvas.style.cursor = 'none';
      }
      isDragging = false;
      return;
    }
    if (isDragging) {
      const timeDelta = performance.now() - lastMoveTime;
      if (timeDelta < 50 && (Math.abs(lastDx) > 0.5 || Math.abs(lastDy) > 0.5)) {
        const rotateSpeed = 0.005;
        const { xSign, ySign } = getOrbitSigns();
        if (dragMode === 'rotate') {
          velocityTheta = -lastDx * rotateSpeed * 0.5 * xSign;
          velocityPhi = -lastDy * rotateSpeed * 0.5 * ySign;
        } else if (dragMode === 'pan') {
          // Use scratch vectors to avoid per-event allocations
          vec3.sub(tempVec3d, target, eye);  // forward
          vec3.normalize(tempVec3d, tempVec3d);
          vec3.cross(tempVec3e, tempVec3d, up);  // camRight
          vec3.normalize(tempVec3e, tempVec3e);
          vec3.cross(tempVec3f, tempVec3e, tempVec3d);  // camUp
          vec3.normalize(tempVec3f, tempVec3f);
          const panSpeed = radius * 0.002 * 0.5;
          velocityPanX = -lastDx * panSpeed * tempVec3e[0] + lastDy * panSpeed * tempVec3f[0];
          velocityPanY = -lastDx * panSpeed * tempVec3e[1] + lastDy * panSpeed * tempVec3f[1];
          velocityPanZ = -lastDx * panSpeed * tempVec3e[2] + lastDy * panSpeed * tempVec3f[2];
        }
      }
    }
    isDragging = false;
    canvas.classList.remove('dragging');
    updateCursorForHighlightMode();

    // Save camera state to active view when unlocked
    if (!camerasLocked) {
      setViewCameraState(focusedViewId, getCurrentCameraStateInternal());
    }
  };
  addEventListenerWithCleanup(window, 'mouseup', handleMouseUp);

  const handleMouseMove = (e) => {
    // Always track cursor position for aiming (when not in pointer lock)
    if (!pointerLockActive) {
      cursorX = e.clientX;
      cursorY = e.clientY;
    }

    if (highlightTools && highlightTools.handleMouseMove(e)) {
      return;
    }

    if (navigationMode === 'free') {
      if (!lookActive) return;
      const dx = pointerLockActive ? e.movementX : (e.clientX - lastX);
      const dy = pointerLockActive ? e.movementY : (e.clientY - lastY);
      const invertX = invertLookX ? -1 : 1;
      const invertY = invertLookY ? -1 : 1;
      freeflyYaw += dx * lookSensitivity * invertX;
      freeflyPitch -= dy * lookSensitivity * invertY;
      const PITCH_EPS = 0.001;
      const MAX_PITCH = Math.PI / 2 - PITCH_EPS;
      freeflyPitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, freeflyPitch));
      if (!pointerLockActive) {
        lastX = e.clientX;
        lastY = e.clientY;
      }
      return;
    }
    if (!isDragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastDx = dx * VELOCITY_SMOOTHING + lastDx * (1 - VELOCITY_SMOOTHING);
    lastDy = dy * VELOCITY_SMOOTHING + lastDy * (1 - VELOCITY_SMOOTHING);
    lastMoveTime = performance.now();
    const rotateSpeed = 0.005;
    const { xSign, ySign } = getOrbitSigns();

    if (dragMode === 'rotate') {
      theta -= dx * rotateSpeed * xSign;
      phi -= dy * rotateSpeed * ySign;
      const EPS = 0.05;
      phi = Math.max(EPS, Math.min(Math.PI - EPS, phi));
      while (theta > Math.PI * 2) theta -= Math.PI * 2;
      while (theta < 0) theta += Math.PI * 2;
    } else if (dragMode === 'pan') {
      const panSpeed = radius * 0.002;
      if (navigationMode === 'planar') {
        // Planar mode: pan in X and Y (camera looks down Z axis)
        const invertX = planarInvertAxes ? 1 : -1;
        const invertY = planarInvertAxes ? -1 : 1;
        target[0] += dx * panSpeed * invertX;
        target[1] += dy * panSpeed * invertY;
      } else {
        // Use scratch vectors to avoid per-event allocations
        vec3.sub(tempVec3d, target, eye);  // forward
        vec3.normalize(tempVec3d, tempVec3d);
        vec3.cross(tempVec3e, tempVec3d, up);  // camRight
        vec3.normalize(tempVec3e, tempVec3e);
        vec3.cross(tempVec3f, tempVec3e, tempVec3d);  // camUp
        vec3.normalize(tempVec3f, tempVec3f);
        vec3.scaleAndAdd(target, target, tempVec3e, -dx * panSpeed);
        vec3.scaleAndAdd(target, target, tempVec3f, dy * panSpeed);
      }
    }
    lastX = e.clientX;
    lastY = e.clientY;
  };
  addEventListenerWithCleanup(window, 'mousemove', handleMouseMove);

  addEventListenerWithCleanup(canvas, 'wheel', (e) => {
    e.preventDefault();
    if (navigationMode === 'free') {
      return;
    }
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 16;
    else if (e.deltaMode === 2) delta *= 100;
    delta = Math.max(-100, Math.min(100, delta));
    const sensitivity = 0.001 * targetRadius;
    const oldRadius = targetRadius;
    targetRadius += delta * sensitivity;
    targetRadius = Math.max(minOrbitRadius, Math.min(100.0, targetRadius));

    // Planar zoom-to-cursor: adjust target so cursor stays at same world position
    if (navigationMode === 'planar' && planarZoomToCursor) {
      // In multiview mode, use viewport-local coordinates for correct NDC calculation
      const vpInfo = getViewportInfoAtScreen(e.clientX, e.clientY);
      // Normalized device coords (-1 to 1) relative to the viewport
      const rawNdcX = (vpInfo.vpLocalX / vpInfo.vpWidth) * 2 - 1;
      const ndcX = rawNdcX - (vpInfo.projectionCenterNdcX ?? 0);
      const ndcY = -((vpInfo.vpLocalY / vpInfo.vpHeight) * 2 - 1);
      // In planar mode with perspective, calculate world offset at target plane
      const aspect = vpInfo.vpAspect;
      const halfHeight = oldRadius * Math.tan(fov / 2);
      const halfWidth = halfHeight * aspect;
      // World position under cursor before zoom (X and Y plane)
      const worldX = target[0] + ndcX * halfWidth;
      const worldY = target[1] + ndcY * halfHeight;
      // After zoom, recalculate what the new half extents would be
      const newHalfHeight = targetRadius * Math.tan(fov / 2);
      const newHalfWidth = newHalfHeight * aspect;
      // Adjust target so that worldX, worldY stays under cursor
      target[0] = worldX - ndcX * newHalfWidth;
      target[1] = worldY - ndcY * newHalfHeight;
      // Make zoom instant to avoid wobble from smooth interpolation
      radius = targetRadius;
    }

    // Save camera state to active view when unlocked
    if (!camerasLocked) {
      setViewCameraState(focusedViewId, getCurrentCameraStateInternal());
    }
  }, { passive: false });

  function updateCursorForHighlightMode() {
    if (highlightTools) {
      highlightTools.updateCursorForHighlightMode();
    }
  }

  const handleAltKeyDown = (e) => {
    if (isTypingTarget(e.target)) return;
    if (e.key === 'Alt') {
      highlightTools?.handleAltKeyDown?.();
    }
  };
  addEventListenerWithCleanup(window, 'keydown', handleAltKeyDown);

  const handleAltKeyUp = (e) => {
    if (isTypingTarget(e.target)) return;
    if (e.key === 'Alt') {
      highlightTools?.handleAltKeyUp?.();
    }
  };
  addEventListenerWithCleanup(window, 'keyup', handleAltKeyUp);

  // Also update when window loses focus (Alt might be released while window unfocused)
  const handleWindowBlur = () => {
    highlightTools?.handleWindowBlur?.();
  };
  addEventListenerWithCleanup(window, 'blur', handleWindowBlur);

  function publishPointerLockState(active, errorMessage) {
    if (pointerLockChangeHandler !== null) {
      pointerLockChangeHandler(active, errorMessage);
    }
  }

  function clearPointerLockIntent(errorMessage = null) {
    pointerLockRequestGeneration += 1;
    pointerLockRequestPending = false;
    pointerLockActive = false;
    pointerLockEnabled = false;
    lookActive = false;
    pendingShot = false;
    pendingShotViewportInfo = null;
    projectileSystem.cancelCharging();
    canvas.classList.remove('dragging');
    if (navigationMode === 'free') {
      canvas.style.cursor = 'crosshair';
    } else {
      updateCursorForHighlightMode();
    }
    publishPointerLockState(false, errorMessage);
  }

  function requestPointerLockOwned() {
    if (typeof canvas.requestPointerLock !== 'function') {
      clearPointerLockIntent(
        'Pointer lock is unavailable in this browser or platform context.'
      );
      return;
    }
    if (pointerLockRequestPending || pointerLockActive) return;
    const generation = pointerLockRequestGeneration + 1;
    pointerLockRequestGeneration = generation;
    pointerLockRequestPending = true;
    let result;
    try {
      result = canvas.requestPointerLock();
    } catch (error) {
      clearPointerLockIntent(
        `Pointer lock request failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    if (result === undefined) return;
    if (
      result === null ||
      typeof result !== 'object' ||
      typeof result.then !== 'function'
    ) {
      clearPointerLockIntent(
        'Pointer lock returned an invalid browser request result.'
      );
      return;
    }
    result.catch((error) => {
      if (
        generation !== pointerLockRequestGeneration ||
        pointerLockActive
      ) {
        return;
      }
      clearPointerLockIntent(
        `Pointer lock request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  function publishProjectileBuildResult(completion, status, message) {
    if (completion === null) return;
    try {
      completion(Object.freeze({ status, message }));
    } catch (error) {
      // Completion callbacks observe an already committed/fenced generation.
      // They cannot roll renderer or viewer ownership back.
      try {
        console.error(
          '[Viewer] Projectile preparation observer failed.',
          error
        );
      } catch {
        // Optional diagnostics are never authoritative.
      }
    }
  }

  function cancelPendingProjectileBuild(message) {
    projectileBuildGeneration += 1;
    if (projectileBuildTimer !== null) {
      clearTimeout(projectileBuildTimer);
      projectileBuildTimer = null;
    }
    const completion = projectileBuildCompletion;
    projectileBuildCompletion = null;
    publishProjectileBuildResult(completion, 'cancelled', message);
  }

  function handlePointerLockChange() {
    pointerLockActive = document.pointerLockElement === canvas;
    if (pointerLockActive) {
      pointerLockRequestPending = false;
      lookActive = true;
      if (typeof canvas.focus === 'function') {
        canvas.focus();
      }
      canvas.classList.add('dragging');
      canvas.style.cursor = 'none';
      if (pendingShot && pendingShotViewportInfo) {
        // Start charging when pointer lock activates (fire on mouseup)
        // Use the viewport info captured at click time (correct view's camera)
        projectileSystem.startCharging(pendingShotViewportInfo);
        pendingShot = false;
      }
    } else {
      clearPointerLockIntent(null);
      return;
    }
    publishPointerLockState(true, null);
  }

  addEventListenerWithCleanup(document, 'pointerlockchange', handlePointerLockChange);
  const handlePointerLockError = () => {
    clearPointerLockIntent('The browser rejected the pointer lock request.');
  };
  addEventListenerWithCleanup(document, 'pointerlockerror', handlePointerLockError);

  const handleNavigationKeyDown = (e) => {
    if (isTypingTarget(e.target)) return;
    const code = e.code;
    if (pointerLockActive && code === 'Escape') {
      if (document.exitPointerLock) document.exitPointerLock();
      clearPointerLockIntent(null);
      return;
    }
    // WASD navigation works in all modes (free, orbit, planar)
    // Zoom keys: Equal (=) and Minus (-) for zoom in/out, also BracketRight (]) and BracketLeft ([)
    const navKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight',
                     'Equal', 'Minus', 'BracketLeft', 'BracketRight'];
    if (navKeys.includes(code)) {
      e.preventDefault();
    }
    activeKeys.add(code);
  };
  addEventListenerWithCleanup(window, 'keydown', handleNavigationKeyDown);

  const handleKeyUp = (e) => {
    activeKeys.delete(e.code);
  };
  addEventListenerWithCleanup(window, 'keyup', handleKeyUp);

  // Touch events (use cleanup registry to prevent handler stacking on recreate)
  addEventListenerWithCleanup(canvas, 'touchstart', (e) => {
    if (navigationMode === 'free') return;
    velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
    lastDx = lastDy = 0;
    if (e.touches.length === 1) {
      isDragging = true;
      // Planar mode: always pan (no rotation)
      dragMode = navigationMode === 'planar' ? 'pan' : 'rotate';
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
      lastMoveTime = performance.now();
    } else if (e.touches.length === 2) {
      isDragging = false;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastTouchDist = Math.sqrt(dx * dx + dy * dy);
    }
    e.preventDefault();
  }, { passive: false });

  addEventListenerWithCleanup(canvas, 'touchmove', (e) => {
    if (navigationMode === 'free') return;
    e.preventDefault();
    if (e.touches.length === 1 && isDragging) {
      const dx = e.touches[0].clientX - lastX;
      const dy = e.touches[0].clientY - lastY;
      lastDx = dx * VELOCITY_SMOOTHING + lastDx * (1 - VELOCITY_SMOOTHING);
      lastDy = dy * VELOCITY_SMOOTHING + lastDy * (1 - VELOCITY_SMOOTHING);
      lastMoveTime = performance.now();
      if (navigationMode === 'planar') {
        // Planar mode: pan in X and Y (camera looks down Z axis)
        const panSpeed = radius * 0.002;
        const invertX = planarInvertAxes ? 1 : -1;
        const invertY = planarInvertAxes ? -1 : 1;
        target[0] += dx * panSpeed * invertX;
        target[1] += dy * panSpeed * invertY;
      } else {
        const rotateSpeed = 0.005;
        const { xSign, ySign } = getOrbitSigns();
        theta -= dx * rotateSpeed * xSign;
        phi -= dy * rotateSpeed * ySign;
        const EPS = 0.05;
        phi = Math.max(EPS, Math.min(Math.PI - EPS, phi));
        while (theta > Math.PI * 2) theta -= Math.PI * 2;
        while (theta < 0) theta += Math.PI * 2;
      }
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (lastTouchDist > 0) {
        targetRadius *= lastTouchDist / dist;
        targetRadius = Math.max(minOrbitRadius, Math.min(100.0, targetRadius));
      }
      lastTouchDist = dist;
    }
  }, { passive: false });

  addEventListenerWithCleanup(canvas, 'touchend', (e) => {
    if (navigationMode === 'free') return;
    if (isDragging && e.touches.length === 0) {
      const timeDelta = performance.now() - lastMoveTime;
      if (timeDelta < 50 && (Math.abs(lastDx) > 0.5 || Math.abs(lastDy) > 0.5)) {
        const { xSign, ySign } = getOrbitSigns();
        velocityTheta = -lastDx * 0.005 * 0.5 * xSign;
        velocityPhi = -lastDy * 0.005 * 0.5 * ySign;
      }
    }
    isDragging = false;
    lastTouchDist = 0;
  });

  // === Helper Functions ===
  function computePointBoundsFromPositions(positions) {
    projectileSystem.computePointBoundsFromPositions(positions);
  }

  function getFreeflyAxes() {
    // Reuse preallocated scratch vectors to avoid per-frame allocations
    vec3.set(_freeflyForward,
      Math.cos(freeflyPitch) * Math.cos(freeflyYaw),
      Math.sin(freeflyPitch),
      Math.cos(freeflyPitch) * Math.sin(freeflyYaw)
    );
    vec3.normalize(_freeflyForward, _freeflyForward);
    vec3.cross(_freeflyRight, _freeflyForward, _freeflyWorldUp);
    if (vec3.length(_freeflyRight) < 1e-6) vec3.set(_freeflyRight, 1, 0, 0);
    vec3.normalize(_freeflyRight, _freeflyRight);
    vec3.cross(_freeflyUp, _freeflyRight, _freeflyForward);
    vec3.normalize(_freeflyUp, _freeflyUp);
    return { forward: _freeflyForward, right: _freeflyRight, upVec: _freeflyUp };
  }

  // Extract camera position and axes from a view matrix (for multiview projectile support)
  // This is more reliable than camera state for non-focused views since view matrices
  // are always correctly computed during rendering
  function getCameraFromViewMatrix(viewMatrixArr) {
    if (!viewMatrixArr) return null;
    // Invert the view matrix to get camera world transform
    const invView = mat4.create();
    if (!mat4.invert(invView, viewMatrixArr)) return null;
    // Camera position is the translation component of the inverted view matrix
    const position = vec3.fromValues(invView[12], invView[13], invView[14]);
    // Extract axes from the inverted view matrix (camera's world orientation)
    // Column 0 = right, Column 1 = up, Column 2 = forward (negated in view space)
    const right = vec3.fromValues(invView[0], invView[1], invView[2]);
    const upVec = vec3.fromValues(invView[4], invView[5], invView[6]);
    const forward = vec3.fromValues(-invView[8], -invView[9], -invView[10]);
    vec3.normalize(right, right);
    vec3.normalize(upVec, upVec);
    vec3.normalize(forward, forward);
    return { position, axes: { forward, right, upVec } };
  }

  // Compute camera position and axes from a camera state (for multiview projectile support)
  function getCameraFromState(camState) {
    const exactState = assertCameraState(
      camState,
      'Per-view projectile camera state'
    );
    const exactViewMatrix = mat4.create();
    computeViewMatrixFromState(exactState, exactViewMatrix);
    const exactCamera = getCameraFromViewMatrix(exactViewMatrix);
    if (exactCamera === null) {
      throw new Error('Per-view camera matrix is not invertible.');
    }
    return exactCamera;
  }

  // Get camera position and axes for a specific view (multiview support)
  // Uses cached view matrix for non-focused views (more reliable than camera state)
  function getCameraForView(viewId) {
    const vid = assertViewId(viewId);
    const isFocused = vid === assertViewId(focusedViewId);
    // For the focused view, use global state (always up-to-date)
    if (isFocused || camerasLocked) {
      return { position: freeflyPosition, axes: getFreeflyAxes() };
    }
    // For non-focused views, try cached view matrix first (most reliable)
    const cached = cachedViewMatrices.get(vid);
    if (cached && cached.viewMatrix) {
      const fromMatrix = getCameraFromViewMatrix(cached.viewMatrix);
      if (fromMatrix === null) {
        throw new Error(
          `Cached camera matrix for view "${vid}" is not invertible.`
        );
      }
      return fromMatrix;
    }
    // Derive from the exact published camera state when the matrix cache is cold.
    const camState = getViewCameraState(vid);
    return getCameraFromState(camState);
  }

  function updateFreefly(dt) {
    const { forward, right, upVec } = getFreeflyAxes();
    // Use scratch vector to avoid per-frame allocation
    vec3.set(_freeflyMove, 0, 0, 0);
    if (activeKeys.has('KeyW')) vec3.add(_freeflyMove, _freeflyMove, forward);
    if (activeKeys.has('KeyS')) vec3.sub(_freeflyMove, _freeflyMove, forward);
    if (activeKeys.has('KeyD')) vec3.add(_freeflyMove, _freeflyMove, right);
    if (activeKeys.has('KeyA')) vec3.sub(_freeflyMove, _freeflyMove, right);
    if (activeKeys.has('KeyE')) vec3.add(_freeflyMove, _freeflyMove, upVec);
    if (activeKeys.has('KeyQ')) vec3.sub(_freeflyMove, _freeflyMove, upVec);

    const hasInput = vec3.length(_freeflyMove) > 0.0001;
    if (hasInput) {
      vec3.normalize(_freeflyMove, _freeflyMove);
      const sprint = (activeKeys.has('ShiftLeft') || activeKeys.has('ShiftRight')) ? sprintMultiplier : 1;
      // Use scratch vector for target velocity
      vec3.scale(_freeflyTargetVel, _freeflyMove, moveSpeed * sprint);
      const lerpAlpha = Math.min(1, dt * 10);
      vec3.lerp(freeflyVelocity, freeflyVelocity, _freeflyTargetVel, lerpAlpha);
    } else {
      vec3.scale(freeflyVelocity, freeflyVelocity, Math.pow(INERTIA_FRICTION, dt * PHYSICS_TICK_RATE));
      if (vec3.length(freeflyVelocity) < INERTIA_MIN_VELOCITY) {
        vec3.set(freeflyVelocity, 0, 0, 0);
      }
    }

    vec3.scaleAndAdd(freeflyPosition, freeflyPosition, freeflyVelocity, dt);
  }

  // WASD navigation and zoom for orbit/planar modes
  // Uses velocity system for smooth inertia (same as mouse drag)
  function updateOrbitPlanarKeys(dt) {
    const sprint = (activeKeys.has('ShiftLeft') || activeKeys.has('ShiftRight')) ? 3.0 : 1.0;

    if (navigationMode === 'planar') {
      // Planar mode: WASD pans the view using velocity for smooth inertia
      // Respects "Invert axes" checkbox (same as mouse drag)
      const panAccel = radius * 0.15 * planarPanSpeed * sprint;
      const invertX = planarInvertAxes ? 1 : -1;
      const invertY = planarInvertAxes ? -1 : 1;
      if (activeKeys.has('KeyW')) velocityPanY += panAccel * invertY;
      if (activeKeys.has('KeyS')) velocityPanY -= panAccel * invertY;
      if (activeKeys.has('KeyA')) velocityPanX += panAccel * invertX;
      if (activeKeys.has('KeyD')) velocityPanX -= panAccel * invertX;
      // Zoom with = (plus) and - (minus), or ] and [ (brackets)
      const zoomSpeed = radius * 1.5 * planarPanSpeed * dt;
      if (activeKeys.has('Equal') || activeKeys.has('BracketRight')) {
        targetRadius = Math.max(minOrbitRadius, targetRadius - zoomSpeed);
      }
      if (activeKeys.has('Minus') || activeKeys.has('BracketLeft')) {
        targetRadius = Math.min(100.0, targetRadius + zoomSpeed);
      }
    } else if (navigationMode === 'orbit') {
      // Orbit mode: WASD rotates around the anchor using velocity for smooth inertia
      // Respects "Google Earth-style drag" checkbox (orbitInvertX) for A/D keys
      const orbitAccel = 0.008 * orbitKeySpeed * sprint;
      const xSign = orbitInvertX ? -1 : 1;
      // A/D rotate horizontally (theta) - respects invert setting
      if (activeKeys.has('KeyA')) velocityTheta -= orbitAccel * xSign;
      if (activeKeys.has('KeyD')) velocityTheta += orbitAccel * xSign;
      // W/S rotate vertically (phi)
      if (activeKeys.has('KeyW')) velocityPhi -= orbitAccel;
      if (activeKeys.has('KeyS')) velocityPhi += orbitAccel;
      // Zoom with = (plus) and - (minus), or ] and [ (brackets)
      const zoomSpeed = radius * 1.5 * orbitKeySpeed * dt;
      if (activeKeys.has('Equal') || activeKeys.has('BracketRight')) {
        targetRadius = Math.max(minOrbitRadius, targetRadius - zoomSpeed);
      }
      if (activeKeys.has('Minus') || activeKeys.has('BracketLeft')) {
        targetRadius = Math.min(100.0, targetRadius + zoomSpeed);
      }
    }
  }

  function syncFreeflyFromOrbit() {
    const forward = vec3.sub(vec3.create(), target, eye);
    vec3.normalize(forward, forward);
    vec3.copy(freeflyPosition, eye);
    freeflyYaw = Math.atan2(forward[2], forward[0]);
    freeflyPitch = Math.asin(forward[1]);
    vec3.set(freeflyVelocity, 0, 0, 0);
  }

  function syncOrbitFromFreefly() {
    const offset = vec3.sub(vec3.create(), freeflyPosition, target);
    const r = Math.max(minOrbitRadius, vec3.length(offset));
    radius = targetRadius = r;
    theta = Math.atan2(offset[2], offset[0]);
    const cosPhi = Math.min(1, Math.max(-1, offset[1] / r));
    phi = Math.acos(cosPhi);
    const EPS = 0.05;
    phi = Math.max(EPS, Math.min(Math.PI - EPS, phi));
  }

  function updateInertia() {
    if (Math.abs(velocityTheta) > INERTIA_MIN_VELOCITY || Math.abs(velocityPhi) > INERTIA_MIN_VELOCITY) {
      theta += velocityTheta;
      phi += velocityPhi;
      const EPS = 0.05;
      phi = Math.max(EPS, Math.min(Math.PI - EPS, phi));
      while (theta > Math.PI * 2) theta -= Math.PI * 2;
      while (theta < 0) theta += Math.PI * 2;
      velocityTheta *= INERTIA_FRICTION;
      velocityPhi *= INERTIA_FRICTION;
      if (Math.abs(velocityTheta) < INERTIA_MIN_VELOCITY) velocityTheta = 0;
      if (Math.abs(velocityPhi) < INERTIA_MIN_VELOCITY) velocityPhi = 0;
    }

    const panVelocityMag = Math.sqrt(velocityPanX * velocityPanX + velocityPanY * velocityPanY + velocityPanZ * velocityPanZ);
    if (panVelocityMag > INERTIA_MIN_VELOCITY) {
      target[0] += velocityPanX;
      target[1] += velocityPanY;
      target[2] += velocityPanZ;
      velocityPanX *= INERTIA_FRICTION;
      velocityPanY *= INERTIA_FRICTION;
      velocityPanZ *= INERTIA_FRICTION;
      if (panVelocityMag * INERTIA_FRICTION < INERTIA_MIN_VELOCITY) {
        velocityPanX = velocityPanY = velocityPanZ = 0;
      }
    }
  }

  function updateSmoothZoom() {
    const diff = targetRadius - radius;
    if (Math.abs(diff) > 0.001) {
      radius += diff * 0.15;
    } else {
      radius = targetRadius;
    }
  }

  function getProjectionCenterNdcX(
    paneLeftRatio,
    paneWidthRatio,
    paneNavigationMode = navigationMode
  ) {
    const exactMode = assertNavigationMode(paneNavigationMode);
    if (exactMode === 'free') return 0;
    return computePaneCenterNdcX(
      paneLeftRatio,
      paneWidthRatio,
      viewportLeftOcclusionRatio
    );
  }

  function configureInteractiveProjection(
    output,
    aspect,
    paneLeftRatio = 0,
    paneWidthRatio = 1,
    paneNavigationMode = navigationMode
  ) {
    mat4.perspective(output, fov, aspect, near, far);
    const centerNdcX = getProjectionCenterNdcX(
      paneLeftRatio,
      paneWidthRatio,
      paneNavigationMode
    );
    if (centerNdcX !== null) {
      applyHorizontalProjectionCenter(output, centerNdcX);
    }
    return centerNdcX;
  }

  function getCachedGridProjection(
    aspect,
    paneLeftRatio,
    paneWidthRatio,
    paneNavigationMode
  ) {
    const centerNdcX = getProjectionCenterNdcX(
      paneLeftRatio,
      paneWidthRatio,
      paneNavigationMode
    );
    if (cachedGridProjectionAspect !== aspect) {
      cachedGridProjections.clear();
      cachedGridProjectionAspect = aspect;
    }
    const cacheKey = centerNdcX === null ? -1 : centerNdcX;
    let matrix = cachedGridProjections.get(cacheKey);
    if (!matrix) {
      matrix = mat4.create();
      mat4.perspective(matrix, fov, aspect, near, far);
      if (centerNdcX !== null) {
        applyHorizontalProjectionCenter(matrix, centerNdcX);
      }
      cachedGridProjections.set(cacheKey, matrix);
    }
    return matrix;
  }

  function updateCamera(width, height) {
    const aspect = width / height;
    configureInteractiveProjection(projectionMatrix, aspect);
    if (navigationMode === 'free') {
      const { forward, upVec } = getFreeflyAxes();
      vec3.copy(eye, freeflyPosition);
      // Use preallocated vector for lookTarget to avoid per-frame allocation
      vec3.add(_cameraLookTarget, freeflyPosition, forward);
      mat4.lookAt(viewMatrix, eye, _cameraLookTarget, upVec);
    } else if (navigationMode === 'planar') {
      // Planar mode: camera looks at the XY plane from the Z axis
      // Camera positioned in front of the target on Z axis
      eye[0] = target[0];
      eye[1] = target[1];
      eye[2] = target[2] + radius;  // Camera in front on Z axis
      // Y-axis is up on screen
      mat4.lookAt(viewMatrix, eye, target, up);
    } else {
      eye[0] = target[0] + radius * Math.sin(phi) * Math.cos(theta);
      eye[1] = target[1] + radius * Math.cos(phi);
      eye[2] = target[2] + radius * Math.sin(phi) * Math.sin(theta);
      mat4.lookAt(viewMatrix, eye, target, up);
    }
  }

  function computeFogAnchors() {
    if (navigationMode === 'free') {
      const speed = vec3.length(freeflyVelocity);
      fogNearMean = Math.max(0.5, 1.5 + speed * 0.5);
      fogFarMean = fogNearMean + 5.0;
    } else {
      fogNearMean = Math.max(0, radius - 2);
      fogFarMean = radius + 2;
    }
  }

  // ============================================================================
  // INSTANCED EDGE RENDERING - GPU-OPTIMIZED
  // ============================================================================

  /**
   * Calculate optimal 2D texture dimensions for a given count
   * @param {number} count - Number of elements
   * @returns {[number, number]} - [width, height]
   */
  function calcTextureDims(count) {
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    return calculateEdgeTextureDimensions(count, maxSize);
  }

  function queueEdgeTextureRetirement(texture) {
    if (texture !== null && texture !== undefined) {
      pendingEdgeTextureRetirements.add(texture);
    }
  }

  function drainEdgeTextureRetirements() {
    return drainExactTextureRetirements(
      gl,
      pendingEdgeTextureRetirements
    );
  }

  function reportCommittedRetirementFailures(failures, message) {
    if (failures.length === 0) return;
    const diagnostic = failures.length === 1
      ? failures[0]
      : new AggregateError(failures, message);
    try {
      console.error(`[Viewer] ${message}`, diagnostic);
    } catch {
      // Diagnostics cannot invalidate an already published GPU generation.
    }
  }

  function throwEdgeTexturePublicationFailure(error, textures, message) {
    const exactError = error instanceof Error
      ? error
      : new Error('Edge texture publication threw a non-Error value.');
    for (const texture of textures) {
      queueEdgeTextureRetirement(texture);
    }
    const cleanupFailures = drainEdgeTextureRetirements();
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [exactError, ...cleanupFailures],
        message
      );
    }
    throw exactError;
  }

  function runEdgeTextureUpload(texture, label, upload) {
    return runExactEdgeTextureUpload(gl, texture, label, upload);
  }

  function createUploadedEdgeTexture(label, upload) {
    assertNoWebGLError(gl, `${label} allocation preflight`);
    const texture = createRequiredTexture(gl, label);
    try {
      runEdgeTextureUpload(texture, label, upload);
    } catch (error) {
      throwEdgeTexturePublicationFailure(
        error,
        [texture],
        `${label} publication and cleanup were incomplete.`
      );
    }
    return texture;
  }

  function publishEdgeTextureReplacements(replacements, message) {
    const failures = [];
    try {
      const boundTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
      if (replacements.has(boundTexture)) {
        gl.bindTexture(
          gl.TEXTURE_2D,
          replacements.get(boundTexture)
        );
      }
    } catch (error) {
      failures.push(
        error instanceof Error
          ? error
          : new Error('Edge texture binding replacement threw a non-Error value.')
      );
    }
    for (const retiredTexture of replacements.keys()) {
      queueEdgeTextureRetirement(retiredTexture);
    }
    failures.push(...drainEdgeTextureRetirements());
    reportCommittedRetirementFailures(failures, message);
  }

  /**
   * Create edge topology and weight textures from one aligned payload.
   * @param {Uint32Array} sources - Source cell indices
   * @param {Uint32Array} destinations - Destination cell indices
   * @param {Float32Array} renderWeights - Validated relative edge strengths
   * @param {number} nEdges - Number of edges
   */
  function createEdgeTexturesV2(
    sources,
    destinations,
    renderWeights,
    nEdges
  ) {
    const nextDims = calcTextureDims(nEdges);
    const [width, height] = nextDims;
    const texelCount = width * height;
    if (texelCount < nEdges) {
      throw new Error(
        `Connectivity rendering requires ${nEdges} texture texels, ` +
        `but this WebGL2 implementation supports ${texelCount}.`
      );
    }

    const topologyData = new Uint32Array(texelCount * 2);
    for (let i = 0; i < nEdges; i++) {
      topologyData[i * 2] = sources[i];
      topologyData[i * 2 + 1] = destinations[i];
    }
    const weightData = new Float32Array(texelCount);
    weightData.set(renderWeights);

    let nextTopologyTexture = null;
    let nextWeightTexture = null;

    try {
      nextTopologyTexture = createUploadedEdgeTexture(
        'weighted connectivity topology',
        () => {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32UI, width, height, 0, gl.RG_INTEGER, gl.UNSIGNED_INT, topologyData);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        }
      );
      nextWeightTexture = createUploadedEdgeTexture(
        'weighted connectivity weights',
        () => {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, weightData);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        }
      );
    } catch (error) {
      throwEdgeTexturePublicationFailure(
        error,
        [nextTopologyTexture, nextWeightTexture],
        'Weighted connectivity texture publication and cleanup were incomplete.'
      );
    }

    const previousTopologyTexture = edgeTextureV2;
    const previousWeightTexture = edgeWeightTextureV2;
    edgeTextureV2 = nextTopologyTexture;
    edgeWeightTextureV2 = nextWeightTexture;
    edgeTexDimsV2 = nextDims;
    nEdgesV2 = nEdges;
    const replacements = new Map();
    if (previousTopologyTexture !== null) {
      replacements.set(previousTopologyTexture, nextTopologyTexture);
    }
    if (previousWeightTexture !== null) {
      replacements.set(previousWeightTexture, nextWeightTexture);
    }
    publishEdgeTextureReplacements(
      replacements,
      'Weighted connectivity prior-generation retirement was incomplete.'
    );
    console.log(`[Viewer] Created weighted edge textures V2: ${nEdges} edges, ${width}x${height} textures`);
    return true;
  }

  function detachEdgeResourcesV2() {
    const retiringTextures = new Set(pendingEdgeTextureRetirements);
    if (edgeTextureV2 !== null) retiringTextures.add(edgeTextureV2);
    if (edgeWeightTextureV2 !== null) {
      retiringTextures.add(edgeWeightTextureV2);
    }
    for (const entry of edgePositionTexturePoolV2.values()) {
      if (entry.texture) retiringTextures.add(entry.texture);
      entry.refCount = 0;
    }
    for (const entry of edgeVisibilityTexturesV2.values()) {
      if (entry.texture) retiringTextures.add(entry.texture);
    }

    // Detach the render inventory before any hostile deletion can fail.
    edgeTextureV2 = null;
    edgeWeightTextureV2 = null;
    edgePositionTexturePoolV2.clear();
    edgePositionTexturesV2.clear();
    edgeVisibilityTexturesV2.clear();
    edgeTexDimsV2 = [0, 0];
    nEdgesV2 = 0;
    nCellsV2 = 0;
    hasEdgeDataV2 = false;
    useInstancedEdges = false;
    edgeLodLimit = 0;

    if (retiringTextures.size === 0) return [];

    const failures = [];
    try {
      const boundTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
      if (retiringTextures.has(boundTexture)) {
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
    } catch (error) {
      failures.push(error);
    }
    for (const texture of retiringTextures) {
      queueEdgeTextureRetirement(texture);
    }
    failures.push(...drainEdgeTextureRetirements());
    return failures;
  }

  function clearEdgeResourcesV2() {
    const failures = detachEdgeResourcesV2();
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Connectivity resources were detached with pending texture retirement failures.'
      );
    }
  }

  // ========================================================================
  // PER-VIEW EDGE TEXTURE MANAGEMENT
  // Enables multi-view edge rendering with different positions/visibility per view
  // ========================================================================

  function getCertifiedEdgeGeometry(viewId) {
    const vid = assertViewId(viewId);
    const generationBefore =
      hpRenderer.getViewGeometryGeneration(vid);
    const positions = vid === LIVE_VIEW_ID
      ? hpRenderer.getPositions()
      : hpRenderer.getSnapshotPositions(vid);
    const generationAfter =
      hpRenderer.getViewGeometryGeneration(vid);
    if (
      generationBefore !== generationAfter ||
      !Number.isSafeInteger(generationAfter) ||
      generationAfter <= 0
    ) {
      throw new Error(
        `Connectivity geometry certificate changed while reading view "${vid}".`
      );
    }
    if (
      !(positions instanceof Float32Array) ||
      positions.length === 0 ||
      positions.length % 3 !== 0
    ) {
      throw new Error(
        `Renderer published invalid connectivity positions for view "${vid}".`
      );
    }
    const nCells = positions.length / 3;
    if (
      !Number.isSafeInteger(nCells) ||
      nCells <= 0 ||
      (pointCount > 0 && nCells !== pointCount) ||
      (nCellsV2 > 0 && nCells !== nCellsV2)
    ) {
      throw new RangeError(
        `Renderer connectivity geometry for view "${vid}" has an incompatible cell count.`
      );
    }
    return {
      generation: generationAfter,
      nCells,
      positions,
    };
  }

  function releaseEdgePositionPoolEntry(
    entry,
    replacementTexture,
    replacements
  ) {
    if (!entry) return;
    if (
      !Number.isSafeInteger(entry.refCount) ||
      entry.refCount <= 0 ||
      edgePositionTexturePoolV2.get(entry.generation) !== entry
    ) {
      throw new Error(
        'Connectivity position texture pool ownership is inconsistent.'
      );
    }
    entry.refCount -= 1;
    if (entry.refCount !== 0) return;
    edgePositionTexturePoolV2.delete(entry.generation);
    replacements.set(entry.texture, replacementTexture);
  }

  /**
   * Create or update position texture for a specific view.
   * Exact renderer geometry generations share one immutable texture.
   * @param {string} viewId - View identifier
   * @param {Float32Array|null} expectedPositions - Optional compatibility input
   * @param {number|null} expectedNCells - Optional compatibility input
   * @returns {boolean} True if texture was created successfully
   */
  function createPositionTextureV2ForView(
    viewId,
    expectedPositions = null,
    expectedNCells = null
  ) {
    if (typeof viewId !== 'string' || viewId.length === 0) {
      return false;
    }
    const vid = viewId;
    const geometry = getCertifiedEdgeGeometry(vid);
    const { generation, nCells, positions } = geometry;
    if (expectedPositions !== null) {
      if (
        !(expectedPositions instanceof Float32Array) ||
        expectedPositions.length !== positions.length
      ) {
        throw new TypeError(
          `Connectivity setup positions for view "${vid}" do not match the renderer publication.`
        );
      }
      for (let index = 0; index < positions.length; index++) {
        if (!Object.is(expectedPositions[index], positions[index])) {
          throw new RangeError(
            `Connectivity setup positions for view "${vid}" differ from ` +
            `the certified renderer owner at coordinate ${index}.`
          );
        }
      }
    }
    if (
      expectedNCells !== null &&
      (
        !Number.isSafeInteger(expectedNCells) ||
        expectedNCells !== nCells
      )
    ) {
      throw new RangeError(
        `Connectivity setup cell count for view "${vid}" does not match the renderer publication.`
      );
    }

    const existing = edgePositionTexturesV2.get(vid);
    const newDims = calcTextureDims(nCells);
    const [width, height] = newDims;
    const texelCount = width * height;
    if (texelCount < nCells) {
      throw new RangeError(
        `Connectivity positions for view "${vid}" require ${nCells} texels, ` +
        `but this WebGL2 implementation supports ${texelCount}.`
      );
    }

    let pooledEntry = edgePositionTexturePoolV2.get(generation);
    if (pooledEntry) {
      if (
        pooledEntry.nCells !== nCells ||
        pooledEntry.dims[0] !== width ||
        pooledEntry.dims[1] !== height ||
        pooledEntry.format !== 'RGB32F' ||
        !pooledEntry.texture
      ) {
        throw new Error(
          `Connectivity position texture generation ${generation} is inconsistent.`
        );
      }
    } else {
      const texture = createUploadedEdgeTexture(
        `weighted connectivity positions for view "${vid}"`,
        () => {
          gl.texParameteri(
            gl.TEXTURE_2D,
            gl.TEXTURE_MIN_FILTER,
            gl.NEAREST
          );
          gl.texParameteri(
            gl.TEXTURE_2D,
            gl.TEXTURE_MAG_FILTER,
            gl.NEAREST
          );
          gl.texParameteri(
            gl.TEXTURE_2D,
            gl.TEXTURE_WRAP_S,
            gl.CLAMP_TO_EDGE
          );
          gl.texParameteri(
            gl.TEXTURE_2D,
            gl.TEXTURE_WRAP_T,
            gl.CLAMP_TO_EDGE
          );
          // Allocate zero-initialized GPU storage, then stream directly from
          // the exact renderer owner. This avoids a width*height*3 padded host
          // duplicate at 10–30M cells.
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGB32F,
            width,
            height,
            0,
            gl.RGB,
            gl.FLOAT,
            null
          );
          const completeRows = Math.floor(nCells / width);
          if (completeRows > 0) {
            gl.texSubImage2D(
              gl.TEXTURE_2D,
              0,
              0,
              0,
              width,
              completeRows,
              gl.RGB,
              gl.FLOAT,
              positions,
              0
            );
          }
          const tailLength = nCells - completeRows * width;
          if (tailLength > 0) {
            gl.texSubImage2D(
              gl.TEXTURE_2D,
              0,
              0,
              completeRows,
              tailLength,
              1,
              gl.RGB,
              gl.FLOAT,
              positions,
              completeRows * width * 3
            );
          }
        }
      );
      pooledEntry = {
        dims: newDims,
        format: 'RGB32F',
        generation,
        nCells,
        refCount: 0,
        texture,
      };
      edgePositionTexturePoolV2.set(generation, pooledEntry);
    }

    if (existing === pooledEntry) {
      if (vid === LIVE_VIEW_ID) nCellsV2 = nCells;
      return true;
    }

    const replacements = new Map();
    const dimsChanged =
      existing?.texture &&
      (
        !existing.dims ||
        existing.dims[0] !== newDims[0] ||
        existing.dims[1] !== newDims[1]
      );

    // Publish the new lookup/refcount before retiring the prior entry. No
    // WebGL deletion is allowed to roll back this committed generation.
    pooledEntry.refCount += 1;
    edgePositionTexturesV2.set(vid, pooledEntry);
    releaseEdgePositionPoolEntry(
      existing,
      pooledEntry.texture,
      replacements
    );
    if (dimsChanged) {
      const visEntry = edgeVisibilityTexturesV2.get(vid);
      edgeVisibilityTexturesV2.delete(vid);
      if (visEntry?.texture) {
        replacements.set(visEntry.texture, null);
      }
    }

    // Track cell count for debugging (use live view's count as the canonical value)
    if (vid === LIVE_VIEW_ID) {
      nCellsV2 = nCells;
    }
    publishEdgeTextureReplacements(
      replacements,
      `Connectivity prior position generation for view "${vid}" could not be fully retired.`
    );

    return true;
  }

  /**
   * Create or update visibility texture for a specific view.
   * Each view can have different visibility (filters, LOD level).
   * @param {string} viewId - View identifier
   * @param {Float32Array} visibility - Per-cell visibility (0-1)
   * @returns {boolean} True if texture was created/updated successfully
   */
  function updateVisibilityTextureV2ForView(
    viewId,
    visibility,
    internalByteAt = null
  ) {
    if (typeof viewId !== 'string' || viewId.length === 0) {
      return false;
    }
    const vid = viewId;

    let nCells;
    let readByte;
    if (internalByteAt === null) {
      if (
        !(visibility instanceof Float32Array) ||
        visibility.length === 0
      ) {
        console.warn(`[Viewer] Invalid visibility for view ${vid}: visibility is empty or null`);
        return false;
      }
      nCells = visibility.length;
      readByte = index => encodeEdgeVisibilityByte(
        visibility[index],
        index
      );
    } else {
      if (
        !Number.isSafeInteger(visibility) ||
        visibility <= 0 ||
        typeof internalByteAt !== 'function'
      ) {
        throw new TypeError(
          'Internal connectivity visibility publication is invalid.'
        );
      }
      nCells = visibility;
      readByte = internalByteAt;
    }

    // Get position texture dims for this view (visibility must match position count)
    const posEntry = edgePositionTexturesV2.get(vid);
    if (!posEntry) {
      console.warn(`[Viewer] Cannot update visibility for view ${vid}: no position texture`);
      return false;
    }
    if (nCells !== posEntry.nCells) {
      return false;
    }

    const [width, height] = posEntry.dims;
    const texelCount = width * height;

    // Get or create visibility entry
    let visEntry = edgeVisibilityTexturesV2.get(vid);

    // Check if existing visibility texture has mismatched dimensions (safety check)
    // This can happen if position texture was recreated without cleaning up visibility
    if (visEntry?.texture && visEntry.dims) {
      const dimsMismatch = visEntry.dims[0] !== width || visEntry.dims[1] !== height;
      if (dimsMismatch) {
        edgeVisibilityTexturesV2.delete(vid);
        publishEdgeTextureReplacements(
          new Map([[visEntry.texture, null]]),
          `Connectivity mismatched visibility generation for view "${vid}" could not be fully retired.`
        );
        visEntry = null;
      }
    }

    // R8 is the exact shader contract: hidden=0, visible=255. The persistent
    // comparison owner is therefore one byte per texel instead of four.
    let scratchBuffer = visEntry?.scratchBuffer;
    const hadPreviousBuffer = (
      scratchBuffer instanceof Uint8Array &&
      scratchBuffer.length === texelCount
    );
    if (!hadPreviousBuffer) {
      scratchBuffer = new Uint8Array(texelCount);
    }

    // Validate the complete caller array before any GL mutation. Binary
    // comparison means finite Float32 values on the same side of 0.5 do not
    // cause redundant uploads.
    let dirtyRowStart = height;
    let dirtyRowEnd = 0;
    for (let index = 0; index < nCells; index++) {
      const nextByte = readByte(index);
      if (nextByte !== 0 && nextByte !== 255) {
        throw new RangeError(
          `Internal connectivity visibility byte at index ${index} must be 0 or 255.`
        );
      }
      if (!hadPreviousBuffer || scratchBuffer[index] !== nextByte) {
        const row = Math.floor(index / width);
        if (row < dirtyRowStart) dirtyRowStart = row;
        dirtyRowEnd = row + 1;
      }
    }
    if (hadPreviousBuffer && dirtyRowEnd === 0) return true;

    // Validation is now complete. Mutate only the scratch rows this
    // publication owns, then upload that same Uint8 owner directly. If an
    // in-place upload fails, the catch path detaches the texture and this
    // scratch together, so no rollback copy or conversion staging is needed.
    const encodeStart = hadPreviousBuffer
      ? dirtyRowStart * width
      : 0;
    const encodeEnd = hadPreviousBuffer
      ? Math.min(dirtyRowEnd * width, nCells)
      : nCells;
    for (let index = encodeStart; index < encodeEnd; index++) {
      scratchBuffer[index] = readByte(index);
    }

    if (!visEntry?.texture) {
      // First time: create texture
      const texture = createUploadedEdgeTexture(
        `weighted connectivity visibility for view "${vid}"`,
        () => {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.R8,
            width,
            height,
            0,
            gl.RED,
            gl.UNSIGNED_BYTE,
            null
          );
          const completeRows = Math.floor(nCells / width);
          if (completeRows > 0) {
            gl.texSubImage2D(
              gl.TEXTURE_2D,
              0,
              0,
              0,
              width,
              completeRows,
              gl.RED,
              gl.UNSIGNED_BYTE,
              scratchBuffer,
              0
            );
          }
          const tailLength = nCells - completeRows * width;
          if (tailLength > 0) {
            gl.texSubImage2D(
              gl.TEXTURE_2D,
              0,
              0,
              completeRows,
              tailLength,
              1,
              gl.RED,
              gl.UNSIGNED_BYTE,
              scratchBuffer,
              completeRows * width
            );
          }
        }
      );

      // Store with format tag for validation
      edgeVisibilityTexturesV2.set(vid, {
        dims: [width, height],
        format: 'R8',
        scratchBuffer,
        texture,
      });
    } else {
      // Subsequent updates: use row-based partial upload if fewer than 50% of rows changed
      const dirtyRowCount = dirtyRowEnd - dirtyRowStart;
      const usePartialUpload = dirtyRowCount < height * 0.5 && dirtyRowCount > 0;

      const uploadRows = (startRow, endRow) => {
        const completeRowCount = Math.floor(nCells / width);
        const completeEnd = Math.min(endRow, completeRowCount);
        if (startRow < completeEnd) {
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            startRow,
            width,
            completeEnd - startRow,
            gl.RED,
            gl.UNSIGNED_BYTE,
            scratchBuffer,
            startRow * width
          );
        }
        const tailLength = nCells % width;
        const tailRow = completeRowCount;
        if (
          tailLength > 0 &&
          startRow <= tailRow &&
          endRow > tailRow
        ) {
          const tailOffset = tailRow * width;
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            tailRow,
            tailLength,
            1,
            gl.RED,
            gl.UNSIGNED_BYTE,
            scratchBuffer,
            tailOffset
          );
        }
      };
      try {
        runEdgeTextureUpload(
          visEntry.texture,
          `weighted connectivity visibility update for view "${vid}"`,
          () => {
            if (usePartialUpload) {
              uploadRows(dirtyRowStart, dirtyRowEnd);
            } else {
              uploadRows(0, height);
            }
          }
        );
      } catch (error) {
        edgeVisibilityTexturesV2.delete(vid);
        throwEdgeTexturePublicationFailure(
          error,
          [visEntry.texture],
          `Connectivity visibility update for view "${vid}" failed and cleanup was incomplete.`
        );
      }

      // The scratch owner and GPU texture now represent the same generation.
      visEntry.scratchBuffer = scratchBuffer;
    }

    return true;
  }

  /**
   * Delete edge textures for a specific view (cleanup on snapshot removal).
   * @param {string} viewId - View identifier
   * @returns {boolean} Whether an exact view identifier was accepted
   */
  function deleteEdgeTexturesForView(viewId) {
    if (typeof viewId !== 'string' || viewId.length === 0) {
      return false;
    }
    const vid = viewId;

    const posEntry = edgePositionTexturesV2.get(vid);
    edgePositionTexturesV2.delete(vid);

    const visEntry = edgeVisibilityTexturesV2.get(vid);
    edgeVisibilityTexturesV2.delete(vid);

    const replacements = new Map();
    releaseEdgePositionPoolEntry(posEntry, null, replacements);
    if (visEntry?.texture) {
      replacements.set(visEntry.texture, null);
    }
    const failures = [];
    try {
      const boundTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
      if (replacements.has(boundTexture)) {
        gl.bindTexture(
          gl.TEXTURE_2D,
          replacements.get(boundTexture)
        );
      }
    } catch (error) {
      failures.push(error);
    }
    for (const texture of replacements.keys()) {
      queueEdgeTextureRetirement(texture);
    }
    failures.push(...drainEdgeTextureRetirements());
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Connectivity textures for view "${vid}" were detached with pending retirement failures.`
      );
    }
    return true;
  }

  /**
   * Validate that a texture entry has the expected shader-facing format.
   * @param {Object} entry - Texture entry with texture and format properties
   * @param {string} expectedFormat - Expected format ('RGB32F' or 'R8')
   * @returns {boolean} True if valid
   */
  function isValidEdgeTexture(entry, expectedFormat) {
    if (!entry?.texture) return false;
    // If format was tracked, verify it matches
    if (entry.format && entry.format !== expectedFormat) {
      console.error(`[Viewer] Texture format mismatch: expected ${expectedFormat}, got ${entry.format}`);
      return false;
    }
    return true;
  }

  /**
   * Get the exact edge textures owned by a specific view.
   * Live and snapshot views each require their own position and visibility
   * textures so per-view filtering cannot leak across views.
   *
   * @param {string} viewId - View identifier
   * @returns {{ posTexture, visTexture, dims } | null} Textures and dimensions, or null if unavailable
   */
  function getEdgeTexturesForView(viewId) {
    if (typeof viewId !== 'string' || viewId.length === 0) {
      return null;
    }
    const vid = viewId;

    // Helper to validate and return a texture set
    const validateAndReturn = (posEntry, visEntry, source) => {
      // Validate both textures exist and have correct formats
      if (!isValidEdgeTexture(posEntry, 'RGB32F')) {
        console.warn(`[Viewer] Invalid position texture for ${source}`);
        return null;
      }
      if (!isValidEdgeTexture(visEntry, 'R8')) {
        console.warn(`[Viewer] Invalid visibility texture for ${source}`);
        return null;
      }
      // Validate dimensions match
      const posDims = posEntry.dims;
      const visDims = visEntry.dims;
      if (!posDims || !visDims || posDims[0] !== visDims[0] || posDims[1] !== visDims[1]) {
        console.warn(`[Viewer] Dimension mismatch for ${source}: pos=${posDims}, vis=${visDims}`);
        return null;
      }
      return {
        posTexture: posEntry.texture,
        visTexture: visEntry.texture,
        dims: posDims
      };
    };

    if (vid === LIVE_VIEW_ID) {
      return validateAndReturn(
        edgePositionTexturesV2.get(LIVE_VIEW_ID),
        edgeVisibilityTexturesV2.get(LIVE_VIEW_ID),
        'live'
      );
    }

    const snapshot = snapshotViews.find(s => s.id === vid);
    if (!snapshot) {
      return null;
    }

    return validateAndReturn(
      edgePositionTexturesV2.get(vid),
      edgeVisibilityTexturesV2.get(vid),
      `view ${vid}`
    );
  }

  /**
   * Check if a view has per-view edge textures set up.
   * @param {string} viewId - View identifier
   * @returns {boolean}
   */
  function hasEdgeTexturesForView(viewId) {
    if (typeof viewId !== 'string' || viewId.length === 0) {
      return false;
    }
    return edgePositionTexturesV2.has(viewId) &&
      edgeVisibilityTexturesV2.has(viewId);
  }

  function getEdgeTextureStatsV2() {
    const positionGenerations = Array.from(
      edgePositionTexturePoolV2.values(),
      entry => Object.freeze({
        allocatedTexels: entry.dims[0] * entry.dims[1],
        generation: entry.generation,
        gpuBytes:
          entry.dims[0] *
          entry.dims[1] *
          3 *
          Float32Array.BYTES_PER_ELEMENT,
        nCells: entry.nCells,
        refCount: entry.refCount,
      })
    );
    const positionViewGenerations = Array.from(
      edgePositionTexturesV2,
      ([viewId, entry]) => Object.freeze({
        generation: entry.generation,
        viewId,
      })
    );
    const visibilityViews = Array.from(
      edgeVisibilityTexturesV2,
      ([viewId, entry]) => {
        const allocatedTexels = entry.dims[0] * entry.dims[1];
        return Object.freeze({
          allocatedTexels,
          cpuBytes: entry.scratchBuffer.byteLength,
          format: entry.format,
          gpuBytes: allocatedTexels,
          viewId,
        });
      }
    );
    return Object.freeze({
      pendingRetirements: pendingEdgeTextureRetirements.size,
      positionGenerations: Object.freeze(positionGenerations),
      positionViewGenerations: Object.freeze(
        positionViewGenerations
      ),
      visibilityViews: Object.freeze(visibilityViews),
    });
  }

  /**
   * Draw connectivity using instanced rendering (V2)
   * Now supports per-view textures for multi-view rendering with different
   * dimensional projections (e.g., XY vs XZ) and view-specific filtering.
   *
   * @param {number} widthPx - Viewport width in pixels
   * @param {number} heightPx - Viewport height in pixels
   * @param {string} viewId - View ID for exact per-view texture lookup
   */
  function drawConnectivityInstanced(widthPx, heightPx, viewId) {
    if (
      !showConnectivity ||
      nEdgesV2 === 0 ||
      !edgeTextureV2 ||
      !edgeWeightTextureV2
    ) {
      return;
    }

    // Get textures owned by this view.
    const textures = getEdgeTexturesForView(viewId);

    // Need valid textures to render
    if (!textures || !textures.posTexture || !textures.visTexture) {
      if (edgeDebugMode && edgeDebugFrameCount < 5) {
        console.warn(`[Viewer] No valid textures for view ${viewId}, skipping edge render`);
      }
      return;
    }

    const { posTexture, visTexture, dims } = textures;

    // Validate dimensions are non-zero and valid
    if (!dims || !Array.isArray(dims) || dims.length < 2 || !dims[0] || !dims[1]) {
      console.warn(`[Viewer] Invalid edge texture dims for view ${viewId}:`, dims);
      return;
    }

    // Debug logging for first few frames
    if (edgeDebugMode && edgeDebugFrameCount < 5) {
      console.log(`[Viewer] Edge render for ${viewId}: dims=${dims}, posTexture=${!!posTexture}, visTexture=${!!visTexture}`);
    }

    gl.useProgram(lineInstancedProgram);

    // Set uniforms
    gl.uniformMatrix4fv(lineInstancedUniformLocations.mvpMatrix, false, mvpMatrix);
    gl.uniformMatrix4fv(lineInstancedUniformLocations.viewMatrix, false, viewMatrix);
    gl.uniformMatrix4fv(lineInstancedUniformLocations.modelMatrix, false, modelMatrix);
    gl.uniform2f(lineInstancedUniformLocations.viewportSize, widthPx, heightPx);
    gl.uniform1f(lineInstancedUniformLocations.lineWidth, connectivityLineWidth);

    // LOD: limit edges if set - this directly reduces the instance count for actual GPU savings
    // Previously we passed maxEdges as a uniform and let the shader discard, which still wasted
    // vertex shader invocations. Now we reduce the draw call itself.
    const maxEdges = edgeLodLimit > 0 ? Math.min(edgeLodLimit, nEdgesV2) : nEdgesV2;
    // Keep uniform for shader-side early-out (defensive, in case instance count differs)
    gl.uniform1i(lineInstancedUniformLocations.maxEdges, maxEdges);

    // Texture dimensions (use per-view dims for position texture)
    gl.uniform2i(lineInstancedUniformLocations.edgeTexDims, edgeTexDimsV2[0], edgeTexDimsV2[1]);
    gl.uniform2i(lineInstancedUniformLocations.posTexDims, dims[0], dims[1]);

    // Bind textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, edgeTextureV2);
    gl.uniform1i(lineInstancedUniformLocations.edgeTexture, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, posTexture);  // Per-view position texture
    gl.uniform1i(lineInstancedUniformLocations.positionTexture, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, visTexture);  // Per-view visibility texture
    gl.uniform1i(lineInstancedUniformLocations.visibilityTexture, 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, edgeWeightTextureV2);
    gl.uniform1i(lineInstancedUniformLocations.edgeWeightTexture, 3);

    // Color and fog uniforms
    connectivityColorVec[0] = connectivityColorBytes[0] / 255;
    connectivityColorVec[1] = connectivityColorBytes[1] / 255;
    connectivityColorVec[2] = connectivityColorBytes[2] / 255;
    gl.uniform3fv(lineInstancedUniformLocations.lineColor, connectivityColorVec);
    gl.uniform1f(lineInstancedUniformLocations.lineAlpha, connectivityAlpha);
    gl.uniform1f(lineInstancedUniformLocations.fogDensity, fogDensity);
    gl.uniform1f(lineInstancedUniformLocations.fogNearMean, fogNearMean);
    gl.uniform1f(lineInstancedUniformLocations.fogFarMean, fogFarMean);
    gl.uniform3fv(lineInstancedUniformLocations.fogColor, fogColor);

    // Bind quad geometry
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeQuadBuffer);
    gl.enableVertexAttribArray(lineInstancedAttribLocations.quadPos);
    gl.vertexAttribPointer(lineInstancedAttribLocations.quadPos, 2, gl.FLOAT, false, 0, 0);

    // Draw instanced - use maxEdges (not nEdgesV2) to actually reduce GPU work
    // This is the critical fix: reducing the instance count saves vertex shader invocations,
    // whereas the shader-side check just outputs degenerate triangles but still runs the VS
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, maxEdges);

    // Cleanup - explicitly unbind textures to prevent state leakage
    gl.disableVertexAttribArray(lineInstancedAttribLocations.quadPos);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Increment debug frame counter
    if (edgeDebugMode) {
      edgeDebugFrameCount++;
    }
  }

		  function drawGrid() {
		    // Allow fade-out transition to complete before stopping render
		    if (gridOpacity <= 0) return;
		    gl.useProgram(gridProgram);
		    gl.uniformMatrix4fv(gridUniformLocations.mvpMatrix, false, mvpMatrix);
		    gl.uniformMatrix4fv(gridUniformLocations.viewMatrix, false, viewMatrix);
		    gl.uniformMatrix4fv(gridUniformLocations.modelMatrix, false, modelMatrix);
		    gl.uniform3fv(gridUniformLocations.gridColor, gridColor);
		    gl.uniform3fv(gridUniformLocations.bgColor, gridBgColor);
		    gl.uniform1f(gridUniformLocations.gridSpacing, gridSpacing);
		    gl.uniform1f(gridUniformLocations.gridLineWidth, gridLineWidth);
		    gl.uniform1f(gridUniformLocations.gridOpacity, gridOpacity);
		    gl.uniform1f(gridUniformLocations.fogDensity, fogDensity * gridFogDensityMultiplier);
		    gl.uniform1f(gridUniformLocations.fogNearMean, fogNearMean);
		    gl.uniform1f(gridUniformLocations.fogFarMean, fogFarMean);
		    gl.uniform1f(gridUniformLocations.gridSize, GRID_SIZE);

    // Scientific axis colors (RGB for XYZ)
    gl.uniform3fv(gridUniformLocations.axisXColor, axisXColor);
    gl.uniform3fv(gridUniformLocations.axisYColor, axisYColor);
    gl.uniform3fv(gridUniformLocations.axisZColor, axisZColor);

    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Extract view direction from view matrix (works correctly in multiview unlocked camera mode)
    // The view matrix's third row (column-major indices 2, 6, 10) gives the camera's forward axis
    // This is the direction from camera toward target, which is what we need for plane visibility
    const viewDir = [
      -viewMatrix[2],
      -viewMatrix[6],
      -viewMatrix[10]
    ];
    // The view matrix's rotation part is orthonormal, so viewDir is already normalized

    // Plane normals (outward facing from box center)
    // We want to show planes that are "behind" the data (facing away from camera)
    // A plane is visible when dot(viewDir, planeNormal) > 0 (camera looking toward plane)
    const planes = [
      { buffer: gridPlaneBuffers.bottom, type: 1, normal: [0, -1, 0] },  // floor y=-s
      { buffer: gridPlaneBuffers.top,    type: 1, normal: [0, 1, 0] },   // ceiling y=+s
      { buffer: gridPlaneBuffers.back,   type: 0, normal: [0, 0, -1] },  // back z=-s
      { buffer: gridPlaneBuffers.front,  type: 0, normal: [0, 0, 1] },   // front z=+s
      { buffer: gridPlaneBuffers.left,   type: 2, normal: [-1, 0, 0] },  // left x=-s
      { buffer: gridPlaneBuffers.right,  type: 2, normal: [1, 0, 0] },   // right x=+s
    ];

    // Render planes with smooth alpha based on viewing angle
    for (const plane of planes) {
      // Dot product: positive = camera looking toward this plane (plane is visible)
      const dot = viewDir[0]*plane.normal[0] + viewDir[1]*plane.normal[1] + viewDir[2]*plane.normal[2];

      // Smooth transition: show grid planes as much as possible while behind data.
      // Only hide when the plane clearly blocks the camera's view of the data.
      // Negative fadeStart keeps planes visible slightly past perpendicular.
      const fadeStart = -0.2;  // Keep showing a bit past perpendicular
      const fadeEnd = 0.05;    // Reach full opacity quickly once facing camera
      const alpha = smoothstep(fadeStart, fadeEnd, dot);

      // Skip fully transparent planes
      if (alpha < 0.01) continue;

      gl.uniform1f(gridUniformLocations.planeAlpha, alpha);
      gl.uniform1i(gridUniformLocations.planeType, plane.type);
      gl.bindBuffer(gl.ARRAY_BUFFER, plane.buffer);
      gl.enableVertexAttribArray(gridAttribLocations.position);
      gl.vertexAttribPointer(gridAttribLocations.position, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }

  // Smoothstep helper for smooth transitions
  function smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  function drawConnectivityLines(widthPx, heightPx, viewId) {
    drawConnectivityInstanced(widthPx, heightPx, viewId);
  }

  function drawCentroids(count, viewportHeight) {
    const numPoints = count !== undefined ? count : centroidCount;
    if (numPoints === 0) return;
    gl.useProgram(centroidProgram);
    gl.uniformMatrix4fv(centroidUniformLocations.mvpMatrix, false, mvpMatrix);
    gl.uniformMatrix4fv(centroidUniformLocations.viewMatrix, false, viewMatrix);
    gl.uniformMatrix4fv(centroidUniformLocations.modelMatrix, false, modelMatrix);
    // Make centroids stand out by rendering them much larger than regular points
    gl.uniform1f(centroidUniformLocations.pointSize, basePointSize * 4.0);
    gl.uniform1f(centroidUniformLocations.sizeAttenuation, sizeAttenuation);
    gl.uniform1f(centroidUniformLocations.viewportHeight, viewportHeight);
    gl.uniform1f(centroidUniformLocations.fov, fov);

    gl.bindBuffer(gl.ARRAY_BUFFER, centroidPositionBuffer);
    gl.enableVertexAttribArray(centroidAttribLocations.position);
    gl.vertexAttribPointer(centroidAttribLocations.position, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, centroidColorBuffer);
    gl.enableVertexAttribArray(centroidAttribLocations.color);
    gl.vertexAttribPointer(centroidAttribLocations.color, 4, gl.UNSIGNED_BYTE, true, 0, 0); // RGBA uint8 normalized

    gl.drawArrays(gl.POINTS, 0, numPoints);
  }

  // === CENTROID SNAPSHOT BUFFER MANAGEMENT ===
  // Pre-upload centroid data to GPU once per snapshot (eliminates per-frame uploads)

  function queueCentroidSnapshotRetirement(record) {
    const retirement = {
      buffer: record?.buffer ?? null,
      vao: record?.vao ?? null,
    };
    if (retirement.buffer !== null || retirement.vao !== null) {
      pendingCentroidSnapshotRetirements.add(retirement);
    }
  }

  function drainCentroidSnapshotRetirements() {
    const failures = [];
    for (
      const retirement of
      Array.from(pendingCentroidSnapshotRetirements)
    ) {
      if (retirement.vao !== null) {
        try {
          gl.deleteVertexArray(retirement.vao);
          retirement.vao = null;
        } catch (error) {
          failures.push(error);
        }
      }
      if (retirement.buffer !== null) {
        try {
          gl.deleteBuffer(retirement.buffer);
          retirement.buffer = null;
        } catch (error) {
          failures.push(error);
        }
      }
      if (retirement.vao === null && retirement.buffer === null) {
        pendingCentroidSnapshotRetirements.delete(retirement);
      }
    }
    return failures;
  }

  /**
   * Create or update a centroid snapshot buffer for a view.
   * @param {string} viewId - View identifier
   * @param {Float32Array} positions - Centroid positions
   * @param {Uint8Array} colors - Centroid colors (RGBA)
   * @param {number} [dimensionLevel] - Optional dimension level for tracking changes
   */
  function createCentroidSnapshotBuffer(viewId, positions, colors, dimensionLevel = undefined) {
    assertNonEmptyTrimmedString(viewId, 'Centroid snapshot view id');
    if (
      !(positions instanceof Float32Array) ||
      positions.length % 3 !== 0 ||
      !(colors instanceof Uint8Array) ||
      colors.length !== (positions.length / 3) * 4
    ) {
      throw new TypeError(
        'Centroid snapshot data requires exact Float32 XYZ positions and Uint8 RGBA colors.'
      );
    }
    const count = positions.length / 3;
    const vid = viewId;
    if (count === 0) {
      const previous = centroidSnapshotBuffers.get(vid) ?? null;
      centroidSnapshotBuffers.delete(vid);
      if (previous !== null) {
        queueCentroidSnapshotRetirement(previous);
      }
      const retirementFailures =
        drainCentroidSnapshotRetirements();
      reportCommittedRetirementFailures(
        retirementFailures,
        `Empty centroid snapshot for view "${vid}" committed with pending prior-generation retirement.`
      );
      return true;
    }

    // Build interleaved buffer: 16 bytes per point (12 pos + 4 color)
    const STRIDE = 16;
    const buffer = new ArrayBuffer(count * STRIDE);
    const posView = new Float32Array(buffer);
    const colorView = new Uint8Array(buffer);

    for (let i = 0; i < count; i++) {
      const floatOffset = i * 4;
      const byteOffset = i * STRIDE + 12;

      posView[floatOffset] = positions[i * 3];
      posView[floatOffset + 1] = positions[i * 3 + 1];
      posView[floatOffset + 2] = positions[i * 3 + 2];

      colorView[byteOffset] = colors[i * 4];
      colorView[byteOffset + 1] = colors[i * 4 + 1];
      colorView[byteOffset + 2] = colors[i * 4 + 2];
      colorView[byteOffset + 3] = colors[i * 4 + 3];
    }

    // Create GPU buffer (STATIC_DRAW - uploaded once)
    assertNoWebGLError(gl, 'Centroid snapshot publication');
    let glBuffer = null;
    let vao = null;
    try {
      glBuffer = gl.createBuffer();
      vao = gl.createVertexArray();
      if (!glBuffer || !vao) {
        throw new Error(
          'Viewer could not allocate candidate centroid snapshot resources.'
        );
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, buffer, gl.STATIC_DRAW);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);
      gl.enableVertexAttribArray(centroidAttribLocations.position);
      gl.vertexAttribPointer(
        centroidAttribLocations.position,
        3,
        gl.FLOAT,
        false,
        STRIDE,
        0
      );
      gl.enableVertexAttribArray(centroidAttribLocations.color);
      gl.vertexAttribPointer(
        centroidAttribLocations.color,
        4,
        gl.UNSIGNED_BYTE,
        true,
        STRIDE,
        12
      );
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      assertNoWebGLError(gl, 'Candidate centroid snapshot publication');
    } catch (error) {
      const rollbackFailures = [];
      for (const operation of [
        () => gl.bindVertexArray(null),
        () => gl.bindBuffer(gl.ARRAY_BUFFER, null),
        () => gl.getError(),
      ]) {
        try {
          operation();
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      queueCentroidSnapshotRetirement({
        vao,
        buffer: glBuffer,
      });
      rollbackFailures.push(
        ...drainCentroidSnapshotRetirements()
      );
      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [error, ...rollbackFailures],
          `Centroid snapshot "${vid}" publication failed and rollback was incomplete.`
        );
      }
      throw error;
    }

    const candidate = {
      vao,
      buffer: glBuffer,
      count,
      dimensionLevel,
      posFingerprint: computeCentroidFingerprint(positions)
    };
    const previous = centroidSnapshotBuffers.get(vid) || null;
    centroidSnapshotBuffers.set(vid, candidate);
    if (previous) {
      queueCentroidSnapshotRetirement(previous);
      const retirementFailures =
        drainCentroidSnapshotRetirements();
      if (retirementFailures.length > 0) {
        reportCommittedRetirementFailures(
          retirementFailures,
          `Centroid snapshot prior generation for view "${vid}" could not be fully retired.`
        );
      }
    }
    return true;
  }

  /**
   * Compute a simple fingerprint of centroid positions to detect changes.
   * @param {Float32Array} positions - Centroid positions array
   * @returns {string} Fingerprint string
   */
  function computeCentroidFingerprint(positions) {
    if (!positions || positions.length < 3) return '0';
    const len = positions.length;
    const mid = Math.floor(len / 2) - (Math.floor(len / 2) % 3);  // Align to xyz triplet
    const last = len - 3;
    // Sample first, middle, last positions and include total length
    return `${len}:${positions[0].toFixed(4)},${positions[mid].toFixed(4)},${positions[last].toFixed(4)}`;
  }

  function deleteCentroidSnapshotBuffer(viewId) {
    const vid = String(viewId);
    const existing = centroidSnapshotBuffers.get(vid);
    if (existing) {
      centroidSnapshotBuffers.delete(vid);
      queueCentroidSnapshotRetirement(existing);
    }
    const failures = drainCentroidSnapshotRetirements();
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Centroid snapshot "${vid}" was detached with pending retirement failures.`
      );
    }
  }

  function hasCentroidSnapshotBuffer(viewId) {
    return centroidSnapshotBuffers.has(String(viewId));
  }

  /**
   * Check if centroid buffer needs recreation (dimension changed, positions changed, or doesn't exist)
   * @param {string} viewId - View identifier
   * @param {number} currentDimensionLevel - Current dimension level for the view
   * @param {Float32Array} [positions] - Optional positions to check for changes
   * @returns {boolean} True if buffer needs to be (re)created
   */
  function centroidBufferNeedsUpdate(viewId, currentDimensionLevel, positions = null) {
    const vid = String(viewId);
    getDefaultNavigationMode(currentDimensionLevel);
    const existing = centroidSnapshotBuffers.get(vid);
    if (!existing) return true;  // Doesn't exist, need to create
    if (!VALID_DIMENSION_LEVELS.has(existing.dimensionLevel)) {
      throw new TypeError(
        `Centroid buffer for view "${vid}" has no exact dimension state.`
      );
    }
    // Check if dimension changed since buffer was created
    if (existing.dimensionLevel !== currentDimensionLevel) {
      return true;
    }
    // Check if positions changed (detects data reload with same dimension)
    if (positions && existing.posFingerprint) {
      const currentFingerprint = computeCentroidFingerprint(positions);
      if (currentFingerprint !== existing.posFingerprint) {
        return true;  // Positions changed, need to recreate
      }
    }
    return false;
  }

  function drawCentroidsWithSnapshot(viewId, viewportHeight) {
    const snapshot = centroidSnapshotBuffers.get(String(viewId));
    if (!snapshot || snapshot.count === 0) return;

    gl.useProgram(centroidProgram);
    gl.uniformMatrix4fv(centroidUniformLocations.mvpMatrix, false, mvpMatrix);
    gl.uniformMatrix4fv(centroidUniformLocations.viewMatrix, false, viewMatrix);
    gl.uniformMatrix4fv(centroidUniformLocations.modelMatrix, false, modelMatrix);
    gl.uniform1f(centroidUniformLocations.pointSize, basePointSize * 4.0);
    gl.uniform1f(centroidUniformLocations.sizeAttenuation, sizeAttenuation);
    gl.uniform1f(centroidUniformLocations.viewportHeight, viewportHeight);
    gl.uniform1f(centroidUniformLocations.fov, fov);

    // Single VAO bind - no per-frame buffer uploads!
    gl.bindVertexArray(snapshot.vao);
    gl.drawArrays(gl.POINTS, 0, snapshot.count);
    gl.bindVertexArray(null);
  }

  // === CELL PICKING ===
  // Convert screen coordinates to a ray and find the nearest cell
  // Optional viewportAspect parameter allows using a different aspect ratio than the global projection matrix
  function screenToRay(
    screenX,
    screenY,
    canvasWidth,
    canvasHeight,
    viewportAspect = null,
    customViewMatrix = null,
    projectionCenterNdcX = 0
  ) {
    // Normalize to clip space (-1 to 1)
    const ndcX = (screenX / canvasWidth) * 2 - 1;
    const ndcY = 1 - (screenY / canvasHeight) * 2;

    // Create inverse view-projection matrix
    // If a custom viewport aspect is provided, create a temporary projection matrix
    // If a custom view matrix is provided, use it instead of the global viewMatrix
    const viewProj = mat4.create();
    const effectiveViewMatrix = customViewMatrix || viewMatrix;
    if (viewportAspect !== null) {
      const tempProj = mat4.create();
      mat4.perspective(tempProj, fov, viewportAspect, near, far);
      if (projectionCenterNdcX !== null) {
        applyHorizontalProjectionCenter(tempProj, projectionCenterNdcX);
      }
      mat4.multiply(viewProj, tempProj, effectiveViewMatrix);
    } else {
      mat4.multiply(viewProj, projectionMatrix, effectiveViewMatrix);
    }
    const invViewProj = mat4.create();
    if (!mat4.invert(invViewProj, viewProj)) {
      return null;
    }

    // Unproject near and far points
    const nearPoint = vec4.fromValues(ndcX, ndcY, -1, 1);
    const farPoint = vec4.fromValues(ndcX, ndcY, 1, 1);

    vec4.transformMat4(nearPoint, nearPoint, invViewProj);
    vec4.transformMat4(farPoint, farPoint, invViewProj);

    // Perspective divide
    const near3 = vec3.fromValues(
      nearPoint[0] / nearPoint[3],
      nearPoint[1] / nearPoint[3],
      nearPoint[2] / nearPoint[3]
    );
    const far3 = vec3.fromValues(
      farPoint[0] / farPoint[3],
      farPoint[1] / farPoint[3],
      farPoint[2] / farPoint[3]
    );

    // Ray direction
    const dir = vec3.create();
    vec3.subtract(dir, far3, near3);
    vec3.normalize(dir, dir);

    return { origin: near3, direction: dir };
  }

  // Get viewport info for a screen position (handles multiview grid layout)
  function getViewportInfoAtScreen(screenX, screenY) {
    const rect = canvas.getBoundingClientRect();
    const localX = screenX - rect.left;
    const localY = screenY - rect.top;

    let vpLocalX = localX;
    let vpLocalY = localY;
    let vpWidth = rect.width;
    let vpHeight = rect.height;
    let vpOffsetX = 0;
    let vpOffsetY = 0;
    let clickedViewId = focusedViewId;

    const viewCount = (liveViewHidden ? 0 : 1) + snapshotViews.length;

    if (viewLayoutMode === 'grid' && viewCount > 1) {
      const cols = viewCount <= 3 ? viewCount : Math.ceil(Math.sqrt(viewCount));
      const rows = Math.ceil(viewCount / cols);
      vpWidth = rect.width / cols;
      vpHeight = rect.height / rows;

      const col = Math.floor(localX / vpWidth);
      const row = Math.floor(localY / vpHeight);
      const clampedCol = Math.max(0, Math.min(col, cols - 1));
      const clampedRow = Math.max(0, Math.min(row, rows - 1));

      vpOffsetX = clampedCol * vpWidth;
      vpOffsetY = clampedRow * vpHeight;
      vpLocalX = localX - vpOffsetX;
      vpLocalY = localY - vpOffsetY;

      const viewIndex = clampedRow * cols + clampedCol;
      const allViews = [];
      if (!liveViewHidden) allViews.push({ id: LIVE_VIEW_ID });
      snapshotViews.forEach(s => allViews.push({ id: s.id }));
      const clickedView = allViews[viewIndex];
      if (!clickedView) return -1;
      clickedViewId = clickedView.id;
    }

    // Get effective view matrix for the viewport
    let effectiveViewMatrix = null;
    let effectiveNavigationMode = navigationMode;
    let effectiveTargetRadius = targetRadius;
    if (!camerasLocked && viewCount > 1) {
      const cameraState = assertCameraState(
        getViewCameraState(clickedViewId),
        `Viewport camera state for view "${clickedViewId}"`
      );
      effectiveNavigationMode = cameraState.navigationMode;
      effectiveTargetRadius = cameraState.orbit.targetRadius;
      const cached = cachedViewMatrices.get(clickedViewId);
      if (cached && cached.viewMatrix) {
        effectiveViewMatrix = cached.viewMatrix;
      } else {
        effectiveViewMatrix = mat4.create();
        computeViewMatrixFromState(cameraState, effectiveViewMatrix);
      }
    }

    const paneLeftRatio = vpOffsetX / rect.width;
    const paneWidthRatio = vpWidth / rect.width;
    const projectionCenterNdcX = getProjectionCenterNdcX(
      paneLeftRatio,
      paneWidthRatio,
      effectiveNavigationMode
    );
    const viewportProjectionMatrix = mat4.create();
    mat4.perspective(
      viewportProjectionMatrix,
      fov,
      vpWidth / vpHeight,
      near,
      far
    );
    if (projectionCenterNdcX !== null) {
      applyHorizontalProjectionCenter(
        viewportProjectionMatrix,
        projectionCenterNdcX
      );
    }
    const interactionViewMatrix = effectiveViewMatrix ?? viewMatrix;
    const cameraForward = vec3.fromValues(
      -interactionViewMatrix[2],
      -interactionViewMatrix[6],
      -interactionViewMatrix[10]
    );
    const forwardLength = vec3.length(cameraForward);
    if (!Number.isFinite(forwardLength) || forwardLength <= 0) {
      throw new Error(
        `Viewport camera forward vector for view "${clickedViewId}" is invalid.`
      );
    }
    vec3.scale(cameraForward, cameraForward, 1 / forwardLength);
    if (
      !Number.isFinite(effectiveTargetRadius) ||
      effectiveTargetRadius <= 0
    ) {
      throw new Error(
        `Viewport camera target radius for view "${clickedViewId}" is invalid.`
      );
    }

    return {
      vpWidth,
      vpHeight,
      vpOffsetX,
      vpOffsetY,
      vpLocalX,
      vpLocalY,
      viewId: clickedViewId,
      effectiveViewMatrix,
      vpAspect: vpWidth / vpHeight,
      paneLeftRatio,
      paneWidthRatio,
      projectionCenterNdcX,
      projectionMatrix: viewportProjectionMatrix,
      cameraForward,
      cameraTargetRadius: effectiveTargetRadius
    };
  }

  function pickCellRecordAtScreen(screenX, screenY) {
    const viewport = getViewportInfoAtScreen(screenX, screenY);
    if (viewport === -1) return null;
    const {
      vpLocalX,
      vpLocalY,
      vpWidth,
      vpHeight,
      vpAspect,
      effectiveViewMatrix,
      projectionCenterNdcX,
      viewId: clickedViewId,
      cameraTargetRadius
    } = viewport;
    const ray = screenToRay(
      vpLocalX,
      vpLocalY,
      vpWidth,
      vpHeight,
      vpAspect,
      effectiveViewMatrix,
      projectionCenterNdcX
    );
    if (!ray) return null;

    // Large panes lazily build one exact, notified spatial owner on first
    // interaction. Small panes retain the lower-overhead direct scan.
    const queryOwner = getSpatialQueryOwner(clickedViewId, true);
    const positions = queryOwner.positions;

    const pick = findRaySamplePick({
      positions,
      transparency: queryOwner.transparency,
      ray,
      maxDistance: Math.min(cameraTargetRadius * 4, 10),
      spatialIndex: queryOwner.spatialIndex
    });
    if (pick.cellIndex === -1) return null;

    const positionOffset = pick.cellIndex * 3;
    const position = Object.freeze({
      x: positions[positionOffset],
      y: positions[positionOffset + 1],
      z: positions[positionOffset + 2]
    });
    return Object.freeze({
      viewId: clickedViewId,
      cellIndex: pick.cellIndex,
      position
    });
  }

  function pickCellAtScreen(screenX, screenY) {
    return pickCellRecordAtScreen(screenX, screenY)?.cellIndex ?? -1;
  }

  function getHighlightContext() {
    return {
      fov,
      near,
      far,
      modelMatrix,
      viewMatrix,
      liveViewHidden,
      snapshotViews,
      viewLayoutMode,
      transparencyArray,
      targetRadius,
      target,
      eye,
      getViewTransparency: getExactViewTransparency
    };
  }

  function getViewFlags(viewId) {
    const key = assertKnownViewId(viewId);
    const flags = viewCentroidFlags.get(key);
    return {
      points: flags?.points ?? defaultShowCentroidPoints,
      labels: flags?.labels ?? defaultShowCentroidLabels
    };
  }

  function setViewFlags(viewId, partial) {
    const key = assertKnownViewId(viewId);
    const prev = viewCentroidFlags.get(key) || {};
    viewCentroidFlags.set(key, {
      points: partial.points != null ? partial.points : (prev.points ?? defaultShowCentroidPoints),
      labels: partial.labels != null ? partial.labels : (prev.labels ?? defaultShowCentroidLabels)
    });
  }

  function getLabelsForView(viewId) {
    return viewCentroidLabels.get(assertViewId(viewId)) || [];
  }

  function createOwnedCentroidLabel(item) {
    const owned = {
      el: item.el,
      position: Object.freeze([...item.position])
    };
    if (Object.hasOwn(item, 'alpha')) {
      owned.alpha = item.alpha;
    }
    return Object.freeze(owned);
  }

  function queueCentroidLabelRetirements(viewId, labels, excludedElements = null) {
    const key = assertViewId(viewId);
    const pending = pendingCentroidLabelRetirements.get(key) || [];
    const queuedElements = new Set(pending.map(item => item.el));
    for (const item of labels) {
      const element = item?.el;
      if (
        !(element instanceof HTMLElement) ||
        excludedElements?.has(element) ||
        queuedElements.has(element)
      ) {
        continue;
      }
      pending.push(item);
      queuedElements.add(element);
      centroidLabelOwners.set(element, key);
    }
    if (pending.length > 0) {
      pendingCentroidLabelRetirements.set(key, pending);
    }
  }

  function cancelCentroidLabelRetirements(viewId, retainedElements) {
    const key = assertViewId(viewId);
    const pending = pendingCentroidLabelRetirements.get(key);
    if (!pending) return;
    const remaining = pending.filter(item => !retainedElements.has(item.el));
    if (remaining.length > 0) {
      pendingCentroidLabelRetirements.set(key, remaining);
    } else {
      pendingCentroidLabelRetirements.delete(key);
    }
  }

  function viewOwnsCentroidLabelElement(viewId, element) {
    const labels = viewCentroidLabels.get(assertViewId(viewId)) || [];
    return labels.some(item => item.el === element);
  }

  function drainCentroidLabelRetirements(viewId) {
    const key = assertViewId(viewId);
    const pending = pendingCentroidLabelRetirements.get(key) || [];
    pendingCentroidLabelRetirements.delete(key);
    const failed = [];
    const failures = [];
    for (const item of pending) {
      const element = item.el;
      let retirementError = null;
      const parent = element.parentNode;
      if (parent !== null) {
        try {
          parent.removeChild(element);
        } catch (error) {
          // A hostile wrapper may throw after performing the removal. The
          // observable ownership state, rather than the exception alone,
          // determines whether this exact element still needs retirement.
          if (element.parentNode !== null) {
            retirementError = error instanceof Error
              ? error
              : new Error(
                'Centroid label retirement threw a non-Error value.'
              );
          }
        }
      }
      if (element.parentNode !== null && retirementError === null) {
        retirementError = new Error(
          'Centroid label retirement returned without detaching its element.'
        );
      }
      if (element.parentNode !== null) {
        try {
          element.style.display = 'none';
        } catch (error) {
          failures.push(
            error instanceof Error
              ? error
              : new Error(
                'Centroid label retirement hiding threw a non-Error value.'
              )
          );
        }
        failed.push(item);
        failures.push(retirementError);
        continue;
      }
      if (
        centroidLabelOwners.get(element) === key &&
        !viewOwnsCentroidLabelElement(key, element)
      ) {
        centroidLabelOwners.delete(element);
      }
    }
    if (failed.length > 0) {
      pendingCentroidLabelRetirements.set(key, failed);
    }
    return failures;
  }

  function removeLabelsForView(viewId) {
    const key = assertViewId(viewId);
    const labels = viewCentroidLabels.get(key) || [];
    viewCentroidLabels.delete(key);
    queueCentroidLabelRetirements(key, labels);
    const failures = drainCentroidLabelRetirements(key);
    if (failures.length > 0) {
      // Keep an empty publication sentinel so terminal/disposal retries that
      // enumerate published view IDs cannot lose this pending DOM owner.
      viewCentroidLabels.set(key, []);
      throw new AggregateError(
        failures,
        `Centroid labels for view "${key}" could not be fully removed.`
      );
    }
  }

  function captureCentroidLabelDomState(item) {
    const element = item.el;
    return {
      element,
      parent: element.parentNode,
      nextSibling: element.nextSibling,
      hadViewId: element.hasAttribute('data-view-id'),
      viewId: element.getAttribute('data-view-id'),
      domAttempted: false,
      datasetAttempted: false,
      domError: null,
      datasetError: null
    };
  }

  function restoreCentroidLabelDomStates(states, viewId) {
    const key = assertViewId(viewId);
    for (let index = states.length - 1; index >= 0; index -= 1) {
      const state = states[index];
      if (state.datasetAttempted) {
        try {
          if (state.hadViewId) {
            state.element.setAttribute('data-view-id', state.viewId);
          } else {
            state.element.removeAttribute('data-view-id');
          }
        } catch (error) {
          state.datasetError = error;
        }
      }
      if (state.domAttempted) {
        try {
          if (state.parent === null) {
            state.element.parentNode?.removeChild(state.element);
          } else if (state.nextSibling?.parentNode === state.parent) {
            state.parent.insertBefore(state.element, state.nextSibling);
          } else {
            state.parent.appendChild(state.element);
          }
        } catch (error) {
          state.domError = error;
        }
      }
    }

    const failures = [];
    for (const state of states) {
      const datasetRestored = (
        state.element.hasAttribute('data-view-id') === state.hadViewId &&
        (
          !state.hadViewId ||
          state.element.getAttribute('data-view-id') === state.viewId
        )
      );
      if (!datasetRestored) {
        failures.push(
          state.datasetError instanceof Error
            ? state.datasetError
            : new Error(
              'Centroid label rollback could not restore data-view-id.'
            )
        );
      }

      const domRestored = (
        !state.domAttempted ||
        (
          state.element.parentNode === state.parent &&
          state.element.nextSibling === state.nextSibling
        )
      );
      if (!domRestored) {
        failures.push(
          state.domError instanceof Error
            ? state.domError
            : new Error(
              'Centroid label rollback could not restore DOM ownership.'
            )
        );
        if (
          state.parent !== labelLayer &&
          state.element.parentNode === labelLayer
        ) {
          try {
            state.element.style.display = 'none';
          } catch (error) {
            failures.push(
              error instanceof Error
                ? error
                : new Error(
                  'Centroid label rollback hiding threw a non-Error value.'
                )
            );
          }
          const rollbackLabel = Object.freeze({
            el: state.element,
            position: Object.freeze([0, 0, 0]),
            alpha: 0
          });
          centroidLabelOwners.set(state.element, key);
          queueCentroidLabelRetirements(key, [rollbackLabel]);
          if (!viewCentroidLabels.has(key)) {
            viewCentroidLabels.set(key, []);
          }
        }
      }
    }
    return failures;
  }

  function hideLabelsForView(viewId) {
    const labels = getLabelsForView(viewId);
    for (const item of labels) { if (item?.el) item.el.style.display = 'none'; }
  }

  function updateLabelLayerVisibility() {
    let anyVisible = false;
    const singleMode = viewLayoutMode === 'single';
    const focusKey = String(focusedViewId || LIVE_VIEW_ID);
    for (const [viewId, labels] of viewCentroidLabels.entries()) {
      const flags = getViewFlags(viewId);
      if (!flags.labels || !labels.length) continue;
      const isActiveView = String(viewId) === focusKey;
      if (singleMode && !isActiveView) {
        hideLabelsForView(viewId);
        continue;
      }
      if (labels.some(item => item?.el && item.el.style.display !== 'none')) {
        anyVisible = true;
        if (singleMode) break;
      }
    }
    if (labelLayer) labelLayer.style.display = anyVisible ? 'block' : 'none';
  }

  /**
   * Update view title chips (positioned at top-center of each viewport in grid mode)
   * @param {Array} views - Array of view objects with id and label
   * @param {number} cols - Number of columns in grid
   * @param {number} rows - Number of rows in grid
   */
  function updateViewTitles(views, cols, rows) {
    if (!viewTitleLayerEl) return;

    // Generate a key to detect if we need to rebuild chips
    const titleKey = views.map(v => `${v.id}:${v.label}`).join('|') + `|${cols}x${rows}`;
    if (titleKey === lastTitleKey && viewTitleEntries.length === views.length) {
      // Just update positions (in case canvas resized)
      repositionViewTitles(views, cols, rows);
      return;
    }
    lastTitleKey = titleKey;

    // Clear existing chips
    viewTitleEntries.forEach(entry => entry.el?.remove());
    viewTitleEntries = [];

    // Create chips for each view
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    views.forEach((view, i) => {
      const chip = document.createElement('div');
      chip.className = 'view-title-chip';
      // Mark active view
      if (view.id === focusedViewId) {
        chip.classList.add('active');
      }
      chip.textContent = view.label || view.id;
      chip.dataset.viewId = view.id;

      // Click handler to focus this view
      chip.addEventListener('click', () => {
        if (view.id !== focusedViewId) {
          // Save current camera to previous view before switching
          if (!camerasLocked) {
            setViewCameraState(focusedViewId, getCurrentCameraStateInternal());
          }
          focusedViewId = view.id;
          // Load new view's camera
          if (!camerasLocked) {
            const newCam = getViewCameraState(focusedViewId);
            if (newCam) applyCameraStateTemporarily(newCam);
          }
          // Update active state on title chips
          updateViewTitleActiveState();
        }
        if (viewFocusHandler) viewFocusHandler(view.id);
      });

      // Calculate position: center-top of each viewport cell
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cellW = width / cols;
      const cellH = height / rows;
      const x = col * cellW + cellW / 2;
      const y = row * cellH + 20; // 20px from top of cell

      chip.style.left = `${x}px`;
      chip.style.top = `${y}px`;

      viewTitleLayerEl.appendChild(chip);
      viewTitleEntries.push({ el: chip, viewId: view.id });
    });
  }

  function repositionViewTitles(views, cols, rows) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    // Skip style updates if layout dimensions haven't changed
    if (width === lastTitleLayoutWidth &&
        height === lastTitleLayoutHeight &&
        cols === lastTitleLayoutCols &&
        rows === lastTitleLayoutRows) {
      return;
    }

    // Cache current layout for next frame comparison
    lastTitleLayoutWidth = width;
    lastTitleLayoutHeight = height;
    lastTitleLayoutCols = cols;
    lastTitleLayoutRows = rows;

    viewTitleEntries.forEach((entry, i) => {
      if (!entry.el || i >= views.length) return;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cellW = width / cols;
      const cellH = height / rows;
      const x = col * cellW + cellW / 2;
      const y = row * cellH + 20;
      entry.el.style.left = `${x}px`;
      entry.el.style.top = `${y}px`;
    });
  }

  function hideViewTitles() {
    viewTitleEntries.forEach(entry => {
      if (entry.el) entry.el.style.display = 'none';
    });
  }

  function showViewTitles() {
    viewTitleEntries.forEach(entry => {
      if (entry.el) entry.el.style.display = '';
    });
  }

  function updateViewTitleActiveState() {
    viewTitleEntries.forEach(entry => {
      if (!entry.el) return;
      if (entry.viewId === focusedViewId) {
        entry.el.classList.add('active');
      } else {
        entry.el.classList.remove('active');
      }
    });
  }

  function updateCentroidLabelPositions(labels, viewportNorm) {
    // Use CSS pixels (clientWidth/Height) not device pixels (width/height)
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    // Viewport bounds in CSS pixels
    const vpX = viewportNorm.x * width;
    const vpY = viewportNorm.y * height;
    const vpW = viewportNorm.w * width;
    const vpH = viewportNorm.h * height;
    // Small margin to hide labels that are partially outside (avoids text clipping at edges)
    const margin = 5;

    for (const item of labels) {
      if (!item?.el || !item.position) continue;
      if (item.alpha != null && item.alpha < 0.01) {
        item.el.style.display = 'none';
        continue;
      }
      vec4.set(tempVec4, item.position[0], item.position[1], item.position[2], 1);
      vec4.transformMat4(tempVec4, tempVec4, mvpMatrix);
      if (tempVec4[3] <= 0) { item.el.style.display = 'none'; continue; }
      const ndcX = tempVec4[0] / tempVec4[3];
      const ndcY = tempVec4[1] / tempVec4[3];
      // NDC x: -1 = left, +1 = right
      const screenX = vpX + (ndcX * 0.5 + 0.5) * vpW;
      // NDC y: -1 = bottom, +1 = top; CSS y: 0 = top, increases downward
      const screenY = vpY + (0.5 - ndcY * 0.5) * vpH;

      // Clip labels to viewport bounds (prevents bleeding into adjacent views)
      if (screenX < vpX + margin || screenX > vpX + vpW - margin ||
          screenY < vpY + margin || screenY > vpY + vpH - margin) {
        item.el.style.display = 'none';
        continue;
      }

      item.el.style.display = 'block';
      item.el.style.left = `${screenX}px`;
      item.el.style.top = `${screenY}px`;
    }
  }

  function render() {
    if (disposed || webglContextLost || renderPaused) return;
    animationHandle = requestAnimationFrame(render);
    renderFrameId = renderFrameId === Number.MAX_SAFE_INTEGER
      ? 0
      : renderFrameId + 1;
    const now = performance.now();
    const timeSeconds = now / 1000;
    const dt = Math.min(0.05, Math.max(0.001, (now - lastFrameTime) / 1000));
    lastFrameTime = now;

    if (navigationMode === 'free') {
      updateFreefly(dt);
    } else {
      updateOrbitPlanarKeys(dt);
      updateSmoothZoom();
      updateInertia();
    }

    projectileSystem.update(dt);

    // Update charge indicator UI (handled by projectile system)
    projectileSystem.updateChargeUI();

    // Smooth grid opacity transition
    if (showGrid) {
      // Fade in towards target
      if (gridOpacity < targetGridOpacity) {
        gridOpacity = Math.min(targetGridOpacity, gridOpacity + gridTransitionSpeed * dt);
      }
    } else {
      // Fade out towards zero
      if (gridOpacity > 0) {
        gridOpacity = Math.max(0, gridOpacity - gridTransitionSpeed * dt);
      }
    }

    const [width, height] = canvasResizeObserver.getSize();

    if (!pointCount) {
      _renderVelocityViewIds.length = 0;
      prepareVelocityFrame(_renderVelocityViewIds);
      gl.viewport(0, 0, width, height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      return;
    }

    updateCamera(width, height);
    computeFogAnchors();
    mat4.multiply(mvpMatrix, projectionMatrix, viewMatrix);
    mat4.multiply(mvpMatrix, mvpMatrix, modelMatrix);

		    if (renderMode === 'smoke') {
		      _renderVelocityViewIds.length = 0;
		      prepareVelocityFrame(_renderVelocityViewIds);
		      gl.viewport(0, 0, width, height);
		      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		      // Draw grid first as background reference (render during fade-out too)
		      if (gridOpacity > 0) {
		        drawGrid();
		      }
      // Compute inverse view-projection matrix for smoke ray marching
      mat4.multiply(viewProjMatrix, projectionMatrix, viewMatrix);
      mat4.invert(invViewProjMatrix, viewProjMatrix);
      // Render smoke with alpha blending on top of grid
      try {
        smokeRenderer.render({
          invViewProjMatrix,
          eye,
          lightDir,
          width,
          height
        });
      } catch (error) {
        renderMode = 'points';
        const exactError = error instanceof Error
          ? error
          : new Error('Smoke rendering failed with a non-Error value.');
        if (smokeRenderFailureHandler === null) {
          queueMicrotask(() => {
            throw exactError;
          });
        } else {
          try {
            smokeRenderFailureHandler(exactError);
          } catch (observerError) {
            queueMicrotask(() => {
              throw observerError;
            });
          }
        }
      }
      return;
    }

    // Determine views to render (include centroid data for each view)
    // Reuse preallocated array to avoid per-frame allocation
    _renderAllViews.length = 0;

    // Add live view only if not hidden
    if (!liveViewHidden) {
      _renderAllViews.push({
        id: LIVE_VIEW_ID,
        label: liveViewLabel,
        colors: colorsArray,
        transparency: transparencyArray,
        centroidPositions: null, // Use current buffers
        centroidColors: null,
        centroidTransparencies: null,
        centroidCount: centroidCount,
        cameraState: liveCameraState  // Include camera state directly
      });
    }

    for (const snap of snapshotViews) {
      _renderAllViews.push({
        id: snap.id,
        label: snap.label,
        colors: snap.colors,
        transparency: snap.transparency,
        centroidPositions: snap.centroidPositions,
        centroidColors: snap.centroidColors,
        centroidTransparencies: snap.centroidTransparencies,
        centroidCount: snap.centroidPositions ? snap.centroidPositions.length / 3 : 0,
        cameraState: snap.cameraState  // Include camera state directly
      });
    }

    // In single mode or only one view, render full screen
    if (viewLayoutMode === 'single' || _renderAllViews.length <= 1) {
      gl.viewport(0, 0, width, height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      // If we have exactly one view (e.g., live hidden with 1 snapshot), load its data
      if (_renderAllViews.length === 1) {
        const view = _renderAllViews[0];
        _renderVelocityViewIds.length = 0;
        _renderVelocityViewIds.push(view.id);
        prepareVelocityFrame(_renderVelocityViewIds);

        const snapshotId = requireSnapshotBufferId(view.id);
        renderSingleView(
          width,
          height,
          { x: 0, y: 0, w: 1, h: 1 },
          view.id,
          view.centroidCount,
          snapshotId,
          dt,
          timeSeconds,
          navigationMode,
          0,
          0,
          false
        );
      } else {
        // The focused view must be part of the published render layout.
        const view = _renderAllViews.find(v => v.id === focusedViewId);
        if (!view) {
          throw new Error(
            `Focused view "${focusedViewId}" is absent from the published render layout.`
          );
        }
        _renderVelocityViewIds.length = 0;
        _renderVelocityViewIds.push(view.id);
        prepareVelocityFrame(_renderVelocityViewIds);

        // Create or recreate centroid snapshot buffer if needed
        const viewDimLevel = getPublishedDimensionLevel(view.id);
        if (view.centroidPositions && view.centroidColors && centroidBufferNeedsUpdate(view.id, viewDimLevel, view.centroidPositions)) {
          createCentroidSnapshotBuffer(view.id, view.centroidPositions, view.centroidColors, viewDimLevel);
        }

	        const snapshotId = requireSnapshotBufferId(view.id);
	        renderSingleView(
	          width,
	          height,
	          { x: 0, y: 0, w: 1, h: 1 },
	          view.id,
	          view.centroidCount,
	          snapshotId,
	          dt,
	          timeSeconds,
	          navigationMode,
	          0,
	          0,
	          false
	        );
	      }
	      hideViewTitles(); // No titles in single/fullscreen mode
	      updateLabelLayerVisibility();
	      return;
	    }

    // Grid mode: render multiple viewports
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const viewCount = _renderAllViews.length;
    _renderVelocityViewIds.length = 0;
    for (let index = 0; index < viewCount; index++) {
      _renderVelocityViewIds.push(_renderAllViews[index].id);
    }
    prepareVelocityFrame(_renderVelocityViewIds);
    // Layout: 1=1x1, 2=2x1, 3=3x1, 4=2x2, 5+=grid
    const cols = viewCount <= 3 ? viewCount : Math.ceil(Math.sqrt(viewCount));
    const rows = Math.ceil(viewCount / cols);

    // Update view title chips
    updateViewTitles(_renderAllViews, cols, rows);
    showViewTitles();

    // Pre-compute viewport dimensions (same for all cells in uniform grid)
    const vw = Math.floor(width / cols);
    const vh = Math.floor(height / rows);
    const vpAspect = vw / vh;

    // Store active view's matrices (computed once in updateCamera before this loop)
    // Use preallocated scratch matrix to avoid per-frame allocation
    mat4.copy(_activeViewMatrixScratch, viewMatrix);
    const activeRadius = radius;

    // Frustum culling and LOD work per-view: each renderSingleView call receives
    // the correct mvpMatrix and cameraDistance for that view's camera

    for (let i = 0; i < viewCount; i++) {
        const view = _renderAllViews[i];
        const col = i % cols;
        const row = Math.floor(i / cols);
        const vx = col * vw;
        const vy = (rows - 1 - row) * vh; // Flip Y for GL

        const isActiveView = view.id === focusedViewId;
        let paneNavigationMode = navigationMode;

        // OPTIMIZATION: Use cached view matrices instead of per-frame recalculation
        // No global state modification, no applyCameraStateTemporarily, no updateCamera
        if (isActiveView) {
          // Active view: always use the freshly computed active view matrix
          mat4.copy(viewMatrix, _activeViewMatrixScratch);
          radius = activeRadius;
        } else if (!camerasLocked) {
          const cached = cachedViewMatrices.get(view.id);
          const cameraState = assertCameraState(
            getViewCameraState(view.id),
            `Grid camera state for view "${view.id}"`
          );
          paneNavigationMode = cameraState.navigationMode;
          if (cached) {
            // Use pre-computed cached viewMatrix directly
            mat4.copy(viewMatrix, cached.viewMatrix);
            radius = cached.radius;
          } else {
            // No cache exists yet - compute correct matrix immediately from camera state
            // This avoids a one-frame jump where the wrong camera would be used
            // Compute and cache the view matrix from exact published state.
            const tempViewMatrix = mat4.create();
            computeViewMatrixFromState(cameraState, tempViewMatrix);
            mat4.copy(viewMatrix, tempViewMatrix);
            radius = cameraState.orbit.radius;
            // Cache for future frames
            updateCachedViewMatrix(view.id, cameraState);
          }
        } else {
          // Locked mode: non-active views use active view's matrix
          mat4.copy(viewMatrix, _activeViewMatrixScratch);
          radius = activeRadius;
        }

        const cachedProjection = getCachedGridProjection(
          vpAspect,
          col / cols,
          1 / cols,
          paneNavigationMode
        );
        mat4.copy(projectionMatrix, cachedProjection);
        mat4.multiply(mvpMatrix, projectionMatrix, viewMatrix);
        mat4.multiply(mvpMatrix, mvpMatrix, modelMatrix);

        // Set viewport and clear depth for this pane
        gl.viewport(vx, vy, vw, vh);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(vx, vy, vw, vh);
        gl.clear(gl.DEPTH_BUFFER_BIT);

        // Create or recreate centroid snapshot buffer if needed (dimension change, position change, or doesn't exist)
        const viewDimLevel = getPublishedDimensionLevel(view.id);
        if (view.centroidPositions && view.centroidColors && centroidBufferNeedsUpdate(view.id, viewDimLevel, view.centroidPositions)) {
          createCentroidSnapshotBuffer(view.id, view.centroidPositions, view.centroidColors, viewDimLevel);
        }

        const snapshotId = requireSnapshotBufferId(view.id);
        renderSingleView(
          vw,
          vh,
          { x: col / cols, y: row / rows, w: 1 / cols, h: 1 / rows },
          view.id,
          view.centroidCount,
          snapshotId,
          dt,
          timeSeconds,
          paneNavigationMode,
          vx,
          vy,
          true
        );

        gl.disable(gl.SCISSOR_TEST);
      }

    // Restore active view's state after grid render
    mat4.copy(viewMatrix, _activeViewMatrixScratch);
    radius = activeRadius;

	    // Restore projection matrix for full canvas aspect
	    configureInteractiveProjection(projectionMatrix, width / height);
	    mat4.multiply(mvpMatrix, projectionMatrix, viewMatrix);
	    mat4.multiply(mvpMatrix, mvpMatrix, modelMatrix);

	    // Aggregate label layer visibility once per frame (after all views render).
	    updateLabelLayerVisibility();
	  }

		  function renderSingleView(
		    width,
		    height,
		    viewport,
		    viewId,
		    overrideCentroidCount,
		    snapshotBufferId = null,
		    dtSeconds = 0.016,
		    timeSeconds = 0,
		    paneNavigationMode,
		    viewportX,
		    viewportY,
		    scissorEnabled
		  ) {
		    const vid = assertViewId(viewId);
		    const exactPaneNavigationMode = assertNavigationMode(
		      paneNavigationMode
		    );
		    if (
		      !Number.isSafeInteger(viewportX) ||
		      viewportX < 0 ||
		      !Number.isSafeInteger(viewportY) ||
		      viewportY < 0 ||
		      typeof scissorEnabled !== 'boolean'
		    ) {
		      throw new TypeError(
		        `Viewport ownership for view "${vid}" is invalid.`
		      );
		    }
		    if (!Number.isSafeInteger(overrideCentroidCount) || overrideCentroidCount < 0) {
		      throw new TypeError(
		        `Centroid count for view "${vid}" must be a non-negative safe integer.`
		      );
		    }
		    if (
		      snapshotBufferId !== null &&
		      (assertViewId(snapshotBufferId) !== vid || vid === LIVE_VIEW_ID)
		    ) {
		      throw new Error(
		        `Snapshot buffer id must exactly match snapshot view "${vid}".`
		      );
		    }
		    const numCentroids = overrideCentroidCount;

			    // Draw grid first
			    drawGrid();

	    const snapshot = vid === LIVE_VIEW_ID
	      ? null
	      : snapshotViews.find(s => s.id === vid);
	    if (vid !== LIVE_VIEW_ID && !snapshot) {
	      throw new Error(`Snapshot view "${vid}" is absent from published viewer state.`);
	    }
	    // Render params shared by both render paths
	    // Get dimension level for this view (used for LOD and frustum culling calculations)
	    const dimLevel = getPublishedDimensionLevel(vid);
	    // Camera distance calculation: use per-view cached distance when available (for multiview support)
	    // For focused view or locked cameras, global state is authoritative; otherwise use cached per-view value
	    let camDist;
	    const isActiveView = vid === focusedViewId;
	    if (isActiveView || camerasLocked) {
	      // Active view: use global state (most up-to-date during interaction)
	      camDist = navigationMode === 'free' ? vec3.length(freeflyPosition) : radius;
	    } else {
	      // Non-active view: use cached camera distance from view's camera state
	      const cached = cachedViewMatrices.get(vid);
	      if (!cached || !Number.isFinite(cached.cameraDistance)) {
	        throw new Error(
	          `View "${vid}" has no exact cached camera distance for unlocked rendering.`
	        );
	      }
	      camDist = cached.cameraDistance;
	    }
	    const renderParams = getOrCreateRenderParams(vid);
	    renderParams.pointSize = basePointSize;
	    renderParams.sizeAttenuation = sizeAttenuation;
	    renderParams.viewportHeight = height;
	    renderParams.viewportWidth = width;
	    renderParams.fov = fov;
	    renderParams.lightingStrength = lightingStrength;
	    renderParams.fogDensity = fogDensity;
	    renderParams.fogColor = fogColor;
	    renderParams.cameraDistance = camDist;
	    renderParams.dimensionLevel = dimLevel;
	    renderParams.useAlphaTexture = false;
	    renderParams.quality = currentShaderQuality;

	    // Camera position is used for fog/lighting; avoid per-view mat4.invert in the render loop.
	    const cameraPosition = renderParams.cameraPosition;
	    if (isActiveView || camerasLocked) {
	      cameraPosition[0] = eye[0];
	      cameraPosition[1] = eye[1];
	      cameraPosition[2] = eye[2];
	    } else {
	      const cached = cachedViewMatrices.get(vid);
	      if (
	        !cached ||
	        !cached.cameraPosition ||
	        cached.cameraPosition.length !== 3 ||
	        !Number.isFinite(cached.cameraPosition[0]) ||
	        !Number.isFinite(cached.cameraPosition[1]) ||
	        !Number.isFinite(cached.cameraPosition[2])
	      ) {
	        throw new Error(
	          `View "${vid}" has no exact cached camera position for unlocked rendering.`
	        );
	      }
	      cameraPosition[0] = cached.cameraPosition[0];
	      cameraPosition[1] = cached.cameraPosition[1];
	      cameraPosition[2] = cached.cameraPosition[2];
	    }

	    // Render scatter points - use snapshot buffer if available (no data upload!)
	    if (snapshotBufferId) {
	      hpRenderer.renderWithSnapshot(snapshotBufferId, renderParams);
	    } else {
      hpRenderer.render(renderParams);
    }
	    publishLodLevelChange(vid);

	    // Render overlays (after main points, before selection highlights).
	    if (overlayManager?.hasEnabledOverlays?.()) {
	      let overlayCtx = overlayCtxByView.get(vid) || null;
	      let overlayOpts = overlayCtxOptionsByView.get(vid) || null;
	      if (!overlayOpts) {
	        const getViewPositions = () => getExactViewPositions(vid);
	        const getViewTransparency = () => getExactViewTransparency(vid);
		        overlayOpts = {
		          gl,
		          viewId: vid,
		          frameId: renderFrameId,
	          renderParams,
	          timeSeconds,
		          deltaTimeSeconds: dtSeconds,
		          isSnapshot: Boolean(snapshotBufferId),
		          dimensionLevel: dimLevel,
		          devicePixelRatio: window.devicePixelRatio,
		          viewportX,
		          viewportY,
		          scissorEnabled,
		          outputFramebuffer: null,
		          hpRenderer,
		          getViewPositions,
		          getViewTransparency,
		          target: {}
		        };
	        overlayCtxOptionsByView.set(vid, overlayOpts);
	      } else {
	        overlayOpts.frameId = renderFrameId;
	        overlayOpts.renderParams = renderParams;
	        overlayOpts.timeSeconds = timeSeconds;
		        overlayOpts.deltaTimeSeconds = dtSeconds;
		        overlayOpts.isSnapshot = Boolean(snapshotBufferId);
		        overlayOpts.dimensionLevel = dimLevel;
		        overlayOpts.devicePixelRatio = window.devicePixelRatio;
		        overlayOpts.viewportX = viewportX;
		        overlayOpts.viewportY = viewportY;
		        overlayOpts.scissorEnabled = scissorEnabled;
		        overlayOpts.outputFramebuffer = null;
		        if (overlayCtx !== null) {
		          overlayOpts.target = overlayCtx;
		        }
	      }
	      try {
	        overlayCtx = buildOverlayContext(overlayOpts);
	        overlayCtxByView.set(vid, overlayCtx);
	        overlayManager.update(dtSeconds, overlayCtx);
	        overlayManager.render(overlayCtx);
	      } catch (error) {
	        settleVelocityRenderFailure(error);
	      }
	    }

    // Draw highlights (selection rings) on top of scatter points
    // Use view-specific positions and transparency for multi-view support
    const viewPos = getExactViewPositions(vid);
    const viewTransp = getExactViewTransparency(vid);
    highlightTools.renderHighlights(renderParams, viewPos, viewTransp);

    // Draw connectivity lines (pass viewId for per-view position/visibility textures)
    drawConnectivityLines(width, height, vid);

    // Draw centroids
    const flags = getViewFlags(vid);
	    if (flags.points && numCentroids > 0) {
	      // Use snapshot buffer if available (no per-frame upload), otherwise use live buffer
	      if (hasCentroidSnapshotBuffer(vid)) {
	        drawCentroidsWithSnapshot(vid, height);
	      } else {
	        drawCentroids(numCentroids, height);
	      }
	    }
	    _projectileDrawParams.viewportHeight = height;
	    _projectileDrawParams.basePointSize = basePointSize;
	    _projectileDrawParams.sizeAttenuation = sizeAttenuation;
	    _projectileDrawParams.fov = fov;
	    projectileSystem.draw(_projectileDrawParams);

    // Draw the orbit anchor only for panes whose exact camera mode is Orbit.
    if (exactPaneNavigationMode === 'orbit') {
      // Get camera state for this view (supports per-view cameras in unlocked mode)
      let viewTheta = theta;
      let viewPhi = phi;
      let viewTarget = target;
      let viewRadius = radius;
      if (!camerasLocked && vid !== focusedViewId) {
        const camState = assertCameraState(
          getViewCameraState(vid),
          `Orbit-anchor camera state for view "${vid}"`
        );
        viewTheta = camState.orbit.theta;
        viewPhi = camState.orbit.phi;
        viewTarget = camState.orbit.target;
        viewRadius = camState.orbit.radius;
      }
	      _orbitAnchorDrawParams.viewId = vid;
	      _orbitAnchorDrawParams.viewTheta = viewTheta;
	      _orbitAnchorDrawParams.viewPhi = viewPhi;
	      _orbitAnchorDrawParams.viewTarget = viewTarget;
	      _orbitAnchorDrawParams.viewRadius = viewRadius;
	      _orbitAnchorDrawParams.pointBoundsRadius = projectileSystem.getPointBoundsRadius();
	      _orbitAnchorDrawParams.bgColor = bgColor;
	      _orbitAnchorDrawParams.use3D = currentShaderQuality === 'full';
	      _orbitAnchorDrawParams.fogDensity = fogDensity;
	      _orbitAnchorDrawParams.fogColor = fogColor;
	      _orbitAnchorDrawParams.lightingStrength = lightingStrength;
		      _orbitAnchorDrawParams.navigationMode = exactPaneNavigationMode;
	      orbitAnchorRenderer.draw(_orbitAnchorDrawParams);
	    }

    // Update labels
	    if (flags.labels) {
	      const labels = getLabelsForView(vid);
	      if (labels.length) updateCentroidLabelPositions(labels, viewport);
	    } else {
	      hideLabelsForView(vid);
	    }
	  }

  function setBackground(mode) {
    const exactMode = assertViewerBackground(mode);
    showGrid = false;
    switch (exactMode) {
	      case 'grid':
	        showGrid = true;
        // Light grid with subtle gray tint - reduces eye strain and improves
        // line contrast on LCD/OLED screens. Mirrors dark grid design principles.
        targetGridOpacity = 0.85;
        // Subtle warm gray tint instead of pure white
        gl.clearColor(0.965, 0.965, 0.970, 1);
        bgColor = [0.965, 0.965, 0.970];
        fogColor = [0.965, 0.965, 0.970];
	        // Light grid lines - subtle but visible on light background
	        gridColor = [0.56, 0.56, 0.57];
	        gridBgColor = [0.965, 0.965, 0.970];  // Must match bgColor exactly
		        gridSpacing = 0.2;
		        gridLineWidth = 0.010;                // Slightly thicker for screen legibility
		        // Subtle per-axis tint (kept near-neutral)
		        axisXColor = [0.48, 0.46, 0.46];
		        axisYColor = [0.46, 0.48, 0.46];
		        axisZColor = [0.46, 0.46, 0.48];
	        gridFogDensityMultiplier = 1.0;
	        break;
	      case 'grid-dark':
        showGrid = true;
        targetGridOpacity = 0.75;
        gl.clearColor(0.08, 0.09, 0.1, 1);
        bgColor = [0.08, 0.09, 0.1];
        fogColor = [0.08, 0.09, 0.1];
	        gridColor = [0.38, 0.38, 0.42];   // Subtle gray lines
		        gridBgColor = [0.08, 0.09, 0.1];
		        gridSpacing = 0.2;
		        gridLineWidth = 0.008;
		        // Subtle per-axis tint (kept near-neutral)
		        axisXColor = [0.62, 0.58, 0.58];
		        axisYColor = [0.58, 0.62, 0.58];
		        axisZColor = [0.58, 0.58, 0.62];
	        gridFogDensityMultiplier = 1.0;
	        break;
      case 'black':
        gl.clearColor(0, 0, 0, 1);
        bgColor = [0, 0, 0];
        fogColor = [0.05, 0.05, 0.08];
        // Match grid bg to main bg for clean fade-out
        gridBgColor = [0, 0, 0];
        gridColor = [0.3, 0.3, 0.3];
        gridFogDensityMultiplier = 1.0;
        break;
      case 'white':
        gl.clearColor(1, 1, 1, 1);
        bgColor = [1, 1, 1];
        fogColor = [1, 1, 1];
        // Match grid bg to main bg for clean fade-out
        gridBgColor = [1, 1, 1];
        gridColor = [0.7, 0.7, 0.7];
        gridFogDensityMultiplier = 1.0;
    }
  }

  // === Per-view camera helpers ===
  function getViewCameraState(viewId) {
    const exactViewId = assertKnownViewId(viewId);
    if (exactViewId === LIVE_VIEW_ID) {
      return liveCameraState
        ? liveCameraState
        : getCurrentCameraStateInternal();
    }
    const snap = snapshotViews.find(s => s.id === exactViewId);
    if (!snap.cameraState) {
      throw new TypeError(`Camera state is missing for view "${exactViewId}".`);
    }
    return snap.cameraState;
  }

  function setViewCameraState(viewId, camState) {
    const exactViewId = assertKnownViewId(viewId);
    const ownedState = cloneCameraState(
      camState,
      `Camera state for view "${exactViewId}"`
    );
    if (exactViewId === LIVE_VIEW_ID) {
      liveCameraState = ownedState;
    } else {
      const snap = snapshotViews.find(s => s.id === exactViewId);
      snap.cameraState = ownedState;
    }
    // Update cached view matrix for this view (avoids per-frame recalculation)
    if (!camerasLocked) {
      updateCachedViewMatrix(exactViewId, ownedState);
    }
  }

  // === Per-view navigation mode helpers ===
  function getViewNavigationMode(viewId) {
    const exactViewId = assertKnownViewId(viewId);
    if (camerasLocked) {
      return navigationMode;
    }
    const camState = getViewCameraState(exactViewId);
    return assertNavigationMode(camState.navigationMode);
  }

  // Sync freefly data from orbit data within a camera state (for non-focused views)
  function syncFreeflyInCameraState(camState) {
    const exactState = assertCameraState(
      camState,
      'Camera state synchronized from orbit'
    );
    const orb = exactState.orbit;
    const r = orb.radius;
    const t = orb.theta;
    const p = orb.phi;
    const tgt = orb.target;
    // Compute eye position from orbit params
    const eyePos = [
      tgt[0] + r * Math.sin(p) * Math.cos(t),
      tgt[1] + r * Math.cos(p),
      tgt[2] + r * Math.sin(p) * Math.sin(t)
    ];
    // Compute forward direction
    const forward = [tgt[0] - eyePos[0], tgt[1] - eyePos[1], tgt[2] - eyePos[2]];
    const fwdLen = Math.sqrt(forward[0] * forward[0] + forward[1] * forward[1] + forward[2] * forward[2]);
    if (fwdLen > 1e-6) {
      forward[0] /= fwdLen; forward[1] /= fwdLen; forward[2] /= fwdLen;
    }
    // Compute yaw and pitch from forward
    const syncedYaw = Math.atan2(forward[2], forward[0]);
    const syncedPitch = Math.asin(Math.min(1, Math.max(-1, forward[1])));
    exactState.freefly = {
      position: eyePos,
      yaw: syncedYaw,
      pitch: syncedPitch
    };
  }

  function applyViewNavigationMode(viewId, mode) {
    const exactMode = assertNavigationMode(mode);
    // For the focused view, get fresh camera state that includes current global position
    const isFocused = viewId === focusedViewId;

    // Handle live view specially - ensure liveCameraState exists
    if (viewId === LIVE_VIEW_ID) {
      if (!liveCameraState || isFocused) {
        // Always refresh camera state for focused view to capture current position
        liveCameraState = getCurrentCameraStateInternal();
      }
      // When switching to free-fly, ensure freefly data is synced from orbit
      if (exactMode === 'free' && !isFocused) {
        syncFreeflyInCameraState(liveCameraState);
      }
      liveCameraState.navigationMode = exactMode;
      if (!camerasLocked) {
        updateCachedViewMatrix(viewId, liveCameraState);
      }
    } else {
      // Handle snapshot views
      const snap = snapshotViews.find(s => s.id === viewId);
      if (!snap) {
        throw new RangeError(`Unknown camera view "${String(viewId)}".`);
      }
      if (!snap.cameraState) {
        throw new TypeError(`Camera state is missing for view "${viewId}".`);
      }
      if (isFocused) {
        // Refresh the focused view from the active camera.
        snap.cameraState = getCurrentCameraStateInternal();
      }
      // When switching to free-fly, ensure freefly data is synced from orbit
      if (exactMode === 'free' && !isFocused) {
        syncFreeflyInCameraState(snap.cameraState);
      }
      snap.cameraState.navigationMode = exactMode;
      if (!camerasLocked) {
        updateCachedViewMatrix(viewId, snap.cameraState);
      }
    }
    // If this is the focused view, also update the global navigation mode
    if (isFocused) {
      applyNavigationModeDirectly(exactMode);
    }
  }

  // Apply navigation mode directly without triggering UI sync (internal use)
  // Used when switching views - applies stored freefly params, doesn't sync from orbit
  function applyNavigationModeDirectly(mode) {
    const exactMode = assertNavigationMode(mode);
    const prev = navigationMode;
    if (exactMode === prev) return;
    navigationMode = exactMode;
    canvas.classList.remove('free-nav', 'planar-nav');

    // Reset velocities and active keys when changing modes
    velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
    vec3.set(freeflyVelocity, 0, 0, 0);
    activeKeys.clear();

    if (exactMode === 'free') {
      canvas.classList.add('free-nav');
      canvas.style.cursor = pointerLockActive ? 'none' : 'crosshair';
    } else if (exactMode === 'planar') {
      canvas.classList.add('planar-nav');
      lookActive = false;
      // Exit pointer lock when switching away from freefly
      if (document.pointerLockElement === canvas && document.exitPointerLock) {
        document.exitPointerLock();
      }
      updateCursorForHighlightMode();
    } else {
      // orbit mode
      lookActive = false;
      // Exit pointer lock when switching away from freefly
      if (document.pointerLockElement === canvas && document.exitPointerLock) {
        document.exitPointerLock();
      }
      updateCursorForHighlightMode();
    }
  }

	  function applyDimensionNavigationDefault(viewId, dimensionLevel) {
	    const exactViewId = assertViewId(viewId);
    const defaultMode = getDefaultNavigationMode(dimensionLevel);
    if (navigationModeOwnership.hasExplicitUserChoice(exactViewId)) {
      return false;
    }

    const previousMode = navigationMode;
    if (camerasLocked || exactViewId === focusedViewId) {
      applyNavigationModeWithSync(defaultMode);
    }
    applyViewNavigationMode(exactViewId, defaultMode);
    if (navigationMode !== previousMode) {
      const observer = navigationModeChangeHandler;
      const publishedMode = navigationMode;
      if (observer !== null) {
        // UI synchronization remains synchronous on the normal path. It is an
        // observer, not a publication veto, so only a thrown observer error is
        // reported outside the caller's reversible dimension transaction.
        try {
          observer(exactViewId, publishedMode);
        } catch (observerError) {
          queueMicrotask(() => {
            throw observerError;
          });
        }
      }
    }
    return true;
  }

  function applyNavigationModeWithSync(mode) {
    const next = assertNavigationMode(mode);
    if (next === navigationMode) return;
    if (next === 'free') {
      // Ensure orbit state is synced before switching.
      const width = canvas.clientWidth || canvas.width || 1;
      const height = canvas.clientHeight || canvas.height || 1;
      updateCamera(width, height);
      syncFreeflyFromOrbit();
      navigationMode = 'free';
      canvas.classList.add('free-nav');
      canvas.classList.remove('planar-nav');
      canvas.style.cursor = pointerLockActive ? 'none' : 'crosshair';
      velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
      activeKeys.clear();
    } else if (next === 'planar') {
      // Planar mode: fix camera to look at the XY plane.
      if (navigationMode === 'free') {
        syncOrbitFromFreefly();
      }
      navigationMode = 'planar';
      canvas.classList.remove('free-nav');
      canvas.classList.add('planar-nav');
      const planarWasPointerLocked = document.pointerLockElement === canvas;
      clearPointerLockIntent(null);
      if (
        planarWasPointerLocked &&
        typeof document.exitPointerLock === 'function'
      ) {
        document.exitPointerLock();
      }
      activeKeys.clear();
      vec3.set(freeflyVelocity, 0, 0, 0);
      velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
      updateCursorForHighlightMode();
    } else {
      // Orbit mode.
      if (navigationMode === 'free') {
        syncOrbitFromFreefly();
      }
      navigationMode = 'orbit';
      canvas.classList.remove('free-nav');
      canvas.classList.remove('planar-nav');
      const orbitWasPointerLocked = document.pointerLockElement === canvas;
      clearPointerLockIntent(null);
      if (
        orbitWasPointerLocked &&
        typeof document.exitPointerLock === 'function'
      ) {
        document.exitPointerLock();
      }
      activeKeys.clear();
      vec3.set(freeflyVelocity, 0, 0, 0);
      updateCursorForHighlightMode();
    }
  }

  function getCurrentCameraStateInternal() {
    // Sync the inactive mode from the active mode before saving.
    // This ensures both orbit and freefly params are current/equivalent
    // so that keyframes, session state, and view snapshots always carry
    // a consistent "where I look" for every camera mode.
    if (navigationMode === 'free') {
      // Sync orbit from freefly so orbit params are up-to-date
      const offset = vec3.sub(vec3.create(), freeflyPosition, target);
      const r = Math.max(minOrbitRadius, vec3.length(offset));
      const syncedRadius = r;
      const syncedTheta = Math.atan2(offset[2], offset[0]);
      const cosPhi = Math.min(1, Math.max(-1, offset[1] / r));
      const syncedPhi = Math.acos(cosPhi);
      return {
        navigationMode,
        orbit: {
          radius: syncedRadius,
          targetRadius: syncedRadius,
          theta: syncedTheta,
          phi: syncedPhi,
          target: [target[0], target[1], target[2]]
        },
        freefly: {
          position: [freeflyPosition[0], freeflyPosition[1], freeflyPosition[2]],
          yaw: freeflyYaw,
          pitch: freeflyPitch
        }
      };
    } else if (navigationMode === 'planar') {
      // Planar: camera is on the +Z axis looking at the XY plane.
      // Compute eye and look direction directly from orbit params.
      const eyeX = target[0];
      const eyeY = target[1];
      const eyeZ = target[2] + radius;
      const fwdX = target[0] - eyeX;  // 0
      const fwdY = target[1] - eyeY;  // 0
      const fwdZ = target[2] - eyeZ;  // -radius
      const len = Math.sqrt(fwdX * fwdX + fwdY * fwdY + fwdZ * fwdZ) || 1;
      const syncedYaw = Math.atan2(fwdZ / len, fwdX / len);
      const syncedPitch = Math.asin(Math.min(1, Math.max(-1, fwdY / len)));
      return {
        navigationMode,
        orbit: {
          radius,
          targetRadius,
          theta,
          phi,
          target: [target[0], target[1], target[2]]
        },
        freefly: {
          position: [eyeX, eyeY, eyeZ],
          yaw: syncedYaw,
          pitch: syncedPitch
        }
      };
    } else {
      // Orbit mode: compute eye position from orbit params directly
      // (avoids relying on the cached `eye` which could be one frame stale).
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);
      const eyeX = target[0] + radius * sinPhi * Math.cos(theta);
      const eyeY = target[1] + radius * cosPhi;
      const eyeZ = target[2] + radius * sinPhi * Math.sin(theta);
      // Forward = direction from eye to target
      const fwdX = target[0] - eyeX;
      const fwdY = target[1] - eyeY;
      const fwdZ = target[2] - eyeZ;
      const len = Math.sqrt(fwdX * fwdX + fwdY * fwdY + fwdZ * fwdZ) || 1;
      const syncedYaw = Math.atan2(fwdZ / len, fwdX / len);
      const syncedPitch = Math.asin(Math.min(1, Math.max(-1, fwdY / len)));
      return {
        navigationMode,
        orbit: {
          radius,
          targetRadius,
          theta,
          phi,
          target: [target[0], target[1], target[2]]
        },
        freefly: {
          position: [eyeX, eyeY, eyeZ],
          yaw: syncedYaw,
          pitch: syncedPitch
        }
      };
    }
  }

  function applyCameraStateTemporarily(camState, { applyNavMode = true } = {}) {
    const exactState = assertCameraState(camState, 'Temporary camera state');
    // Apply navigation mode if requested (when switching views with unlocked cameras)
    if (applyNavMode) {
      applyNavigationModeDirectly(exactState.navigationMode);
    }
    radius = exactState.orbit.radius;
    targetRadius = exactState.orbit.targetRadius;
    theta = exactState.orbit.theta;
    phi = exactState.orbit.phi;
    vec3.set(
      target,
      exactState.orbit.target[0],
      exactState.orbit.target[1],
      exactState.orbit.target[2]
    );
    vec3.set(
      freeflyPosition,
      exactState.freefly.position[0],
      exactState.freefly.position[1],
      exactState.freefly.position[2]
    );
    freeflyYaw = exactState.freefly.yaw;
    freeflyPitch = exactState.freefly.pitch;
  }

  // Compute viewMatrix from cameraState WITHOUT modifying global state (for cached rendering)
  function computeViewMatrixFromState(camState, outViewMatrix) {
    const exactState = assertCameraState(
      camState,
      'Camera view-matrix state'
    );
    const navMode = exactState.navigationMode;
    if (navMode === 'free') {
      const pos = exactState.freefly.position;
      const yaw = exactState.freefly.yaw;
      const pitch = exactState.freefly.pitch;
      // Compute forward vector from yaw/pitch - must match getFreeflyAxes() convention
      const cosPitch = Math.cos(pitch);
      const forward = [
        cosPitch * Math.cos(yaw),
        Math.sin(pitch),
        cosPitch * Math.sin(yaw)
      ];
      const lookTarget = [pos[0] + forward[0], pos[1] + forward[1], pos[2] + forward[2]];
      // Up vector computed via cross products to match getFreeflyAxes()
      const worldUp = [0, 1, 0];
      // right = forward x worldUp
      const right = [
        forward[1] * worldUp[2] - forward[2] * worldUp[1],
        forward[2] * worldUp[0] - forward[0] * worldUp[2],
        forward[0] * worldUp[1] - forward[1] * worldUp[0]
      ];
      const rightLen = Math.sqrt(right[0] * right[0] + right[1] * right[1] + right[2] * right[2]);
      if (rightLen > 1e-6) {
        right[0] /= rightLen; right[1] /= rightLen; right[2] /= rightLen;
      } else {
        right[0] = 1; right[1] = 0; right[2] = 0;
      }
      // upVec = right x forward
      const upVec = [
        right[1] * forward[2] - right[2] * forward[1],
        right[2] * forward[0] - right[0] * forward[2],
        right[0] * forward[1] - right[1] * forward[0]
      ];
      mat4.lookAt(outViewMatrix, pos, lookTarget, upVec);
    } else if (navMode === 'planar') {
      // Planar mode: camera looks at XY plane from the Z axis
      const r = exactState.orbit.radius;
      const tgt = exactState.orbit.target;
      const eyePos = [tgt[0], tgt[1], tgt[2] + r];
      mat4.lookAt(outViewMatrix, eyePos, tgt, up);
    } else {
      const r = exactState.orbit.radius;
      const t = exactState.orbit.theta;
      const p = exactState.orbit.phi;
      const tgt = exactState.orbit.target;
      const eyePos = [
        tgt[0] + r * Math.sin(p) * Math.cos(t),
        tgt[1] + r * Math.cos(p),
        tgt[2] + r * Math.sin(p) * Math.sin(t)
      ];
      mat4.lookAt(outViewMatrix, eyePos, tgt, up);
    }
    return outViewMatrix;
  }

  // Update cached view matrix for a specific view (call when camera changes)
	  function updateCachedViewMatrix(viewId, camState) {
	    const vid = assertViewId(viewId);
	    const exactState = assertCameraState(
	      camState,
	      `Cached camera state for view "${vid}"`
	    );
	    let cached = cachedViewMatrices.get(vid);
	    if (!cached) {
	      cached = { viewMatrix: mat4.create(), radius: 0, cameraDistance: 0, cameraPosition: vec3.create() };
	      cachedViewMatrices.set(vid, cached);
	    }
	    computeViewMatrixFromState(exactState, cached.viewMatrix);
	    cached.radius = exactState.orbit.radius;
	    // Cache camera distance based on view's navigation mode (for LOD/fog calculations)
	    if (exactState.navigationMode === 'free') {
	      // Freefly mode: distance is length of position vector
	      const pos = exactState.freefly.position;
	      cached.cameraDistance = Math.sqrt(pos[0] * pos[0] + pos[1] * pos[1] + pos[2] * pos[2]);
	    } else {
	      // Orbit mode: distance is the orbit radius
	      cached.cameraDistance = cached.radius;
	    }

	    // Cache camera position for this view (avoid per-frame mat4.invert in render loop).
	    const outPos = cached.cameraPosition;
	    if (exactState.navigationMode === 'free') {
	      const pos = exactState.freefly.position;
	      outPos[0] = pos[0];
	      outPos[1] = pos[1];
	      outPos[2] = pos[2];
	    } else if (exactState.navigationMode === 'planar') {
	      const r = exactState.orbit.radius;
	      const tgt = exactState.orbit.target;
	      outPos[0] = tgt[0];
	      outPos[1] = tgt[1];
	      outPos[2] = tgt[2] + r;
	    } else {
	      const r = exactState.orbit.radius;
	      const t = exactState.orbit.theta;
	      const p = exactState.orbit.phi;
	      const tgt = exactState.orbit.target;
	      outPos[0] = tgt[0] + r * Math.sin(p) * Math.cos(t);
	      outPos[1] = tgt[1] + r * Math.cos(p);
	      outPos[2] = tgt[2] + r * Math.sin(p) * Math.sin(t);
	    }
	  }

  // Invalidate all cached matrices (call when switching lock modes)
  function invalidateAllCachedMatrices() {
    cachedViewMatrices.clear();
    cachedGridProjections.clear();
    cachedGridProjectionAspect = null;
  }

  function getViewIdAtScreenPosition(screenX, screenY) {
    const viewport = getViewportInfoAtScreen(screenX, screenY);
    return viewport === -1 ? focusedViewId : viewport.viewId;
  }

  // === Public API ===
  const publicApi = {
    setData(payload) {
      const {
        positions,
        colors,
        transparency,
        dimensionLevel,
        pointCount: nextPointCount
      } = assertViewerDataPayload(payload);
      // Load data into HP renderer (alpha is packed in colors as RGBA uint8)
      // Pass dimension level so the renderer can build the appropriate spatial index (BinaryTree/Quadtree/Octree)
      hpRenderer.loadData(positions, colors, {
        alphaValues: transparency,
        dimensionLevel
      });

      // The renderer generation is authoritative once loadData returns. Edge
      // topology and every per-view derived texture belong to the superseded
      // dataset, so detach their logical inventory before any later viewer
      // work can render or throw. Hostile deletion remains journaled and
      // diagnostic-only; it cannot make the committed data publication appear
      // rolled back to this caller.
      reportCommittedRetirementFailures(
        detachEdgeResourcesV2(),
        'Connectivity resources from the prior committed dataset generation could not be fully retired.'
      );

      highlightTools.retireSpatialInteractions(LIVE_VIEW_ID);
      cancelPendingProjectileBuild(
        'Projectile preparation was cancelled because the dataset changed.'
      );
      projectileSystem.setEnabled(false);
      pointCount = nextPointCount;
      positionsArray = positions;
      colorsArray = colors;
      transparencyArray = transparency;
      computePointBoundsFromPositions(positions);
      viewDimensionLevels.set(LIVE_VIEW_ID, dimensionLevel);
      viewPositionsCache.set(LIVE_VIEW_ID, positions);
      applyDimensionNavigationDefault(LIVE_VIEW_ID, dimensionLevel);
      vectorFieldOverlay?.markGeometryDirty?.(LIVE_VIEW_ID);
    },

    updateColors(colors) {
      assertExactUint8Array(colors, pointCount * 4, 'Viewer live colors');
      hpRenderer.updateColors(colors);
      colorsArray = colors;
    },

    updateTransparency(alphaArray) {
      assertTransparencyArray(
        alphaArray,
        pointCount,
        'Viewer live transparency'
      );
      hpRenderer.updateAlphas(alphaArray);
      highlightTools.retireSpatialInteractions(LIVE_VIEW_ID);
      transparencyArray = alphaArray;
      // Let overlays (e.g., vector field particles) rebuild spawn sources lazily when visibility changes.
      if (vectorFieldOverlay?.enabled) {
        vectorFieldOverlay.markVisibilityDirty(LIVE_VIEW_ID);
      }

      highlightTools.handleTransparencyChange(LIVE_VIEW_ID);
    },

    /**
     * Update positions for dimension switching (maintains same point count and indices)
     * Also updates edge position texture if edge rendering is enabled.
     * @param {Float32Array} positions - New 3D positions array (n_points * 3)
     * @param {number} dimensionLevel - Dimension owned by this position generation.
     */
    updatePositions(positions, dimensionLevel) {
      assertFiniteFloat32Array(
        positions,
        pointCount * 3,
        'Viewer live positions'
      );
      getDefaultNavigationMode(dimensionLevel);
      const previousDimensionLevel =
        getPublishedDimensionLevel(LIVE_VIEW_ID);
      const previousPositions = positionsArray;
      let rendererPublished = false;
      try {
        hpRenderer.updatePositions(positions, dimensionLevel);
        rendererPublished = true;

        // The edge helper stages its texture and preserves the old texture if
        // upload fails. Only after both owners succeed is the position set
        // visible to the rest of the viewer.
        if (useInstancedEdges && nEdgesV2 > 0) {
          createPositionTextureV2ForView(LIVE_VIEW_ID);
        }
      } catch (publicationError) {
        if (rendererPublished) {
          const restorationFailures = [];
          try {
            hpRenderer.loadData(previousPositions, colorsArray, {
              alphaValues: transparencyArray,
              dimensionLevel: previousDimensionLevel
            });
          } catch (restorationError) {
            restorationFailures.push(restorationError);
          }
          if (
            restorationFailures.length === 0 &&
            useInstancedEdges &&
            nEdgesV2 > 0
          ) {
            try {
              createPositionTextureV2ForView(LIVE_VIEW_ID);
            } catch (edgeRestorationError) {
              restorationFailures.push(edgeRestorationError);
            }
          }
          if (restorationFailures.length > 0) {
            throw new AggregateError(
              [publicationError, ...restorationFailures],
              'Viewer position publication and renderer restoration both failed.'
            );
          }
        }
        throw publicationError;
      }

      highlightTools.retireSpatialInteractions(LIVE_VIEW_ID);
      positionsArray = positions;
      viewPositionsCache.set(LIVE_VIEW_ID, positions);
      computePointBoundsFromPositions(positions);
      vectorFieldOverlay?.markGeometryDirty?.(LIVE_VIEW_ID);
    },

    /**
     * Get a caller-owned copy of the current positions array.
     * @returns {Float32Array|null}
     */
    getPositions() {
      return positionsArray === null
        ? null
        : new Float32Array(positionsArray);
    },

    /**
     * Get a caller-owned copy of the packed RGBA colors for the live view.
     * @returns {Uint8Array|null}
     */
    getColors() {
      return colorsArray === null
        ? null
        : new Uint8Array(colorsArray);
    },

    /**
     * Read one exact view coordinate without exposing the renderer's mutable
     * large-array owner.
     * @param {number} cellIndex
     * @param {string} [viewId='live']
     * @returns {{x: number, y: number, z: number}}
     */
    getCellPosition(cellIndex, viewId = LIVE_VIEW_ID) {
      if (
        !Number.isSafeInteger(cellIndex) ||
        cellIndex < 0 ||
        cellIndex >= pointCount
      ) {
        throw new RangeError(
          `Cell position index must be an integer in [0, ${pointCount}).`
        );
      }
      const positions = getExactViewPositions(assertKnownViewId(viewId));
      const offset = cellIndex * 3;
      return Object.freeze({
        x: positions[offset],
        y: positions[offset + 1],
        z: positions[offset + 2]
      });
    },

    /**
     * Get point count
     * @returns {number}
     */
    getPointCount() {
      return pointCount;
    },

    /**
     * Set dimension level for a specific view (for multi-dimensional support)
     * @param {string} viewId - View identifier
     * @param {number} level - Dimension level (1, 2, or 3)
     */
    setViewDimension(viewId, level) {
      const vid = assertViewId(viewId);
      getDefaultNavigationMode(level);
      const oldLevel = getPublishedDimensionLevel(vid);
      if (vid === LIVE_VIEW_ID && oldLevel !== level) {
        cancelPendingProjectileBuild(
          'Projectile preparation was cancelled because the live dimension changed.'
        );
        projectileSystem.setEnabled(false);
      }
      const snap = snapshotViews.find(s => s.id === vid);

      // Invalidate per-view caches when dimension changes (LOD/frustum calculations differ)
      if (oldLevel !== level && hpRenderer) {
        // Publish the renderer owner before exposing the dimension through
        // viewer state. Snapshot metadata changes preserve their immutable
        // geometry buffer and rebuild only a required custom spatial index.
        if (snap) {
          hpRenderer.setSnapshotDimensionLevel(vid, level);
        } else {
          hpRenderer.setDimensionLevel(level);
        }
        hpRenderer.invalidateViewState(vid);
        highlightTools.retireSpatialInteractions(vid);
      }

      viewDimensionLevels.set(vid, level);
      if (snap) {
        snap.dimensionLevel = level;
      }

      // Invalidate cached view matrix since camera behavior may differ per dimension
      cachedViewMatrices.delete(vid);
      applyDimensionNavigationDefault(vid, level);
      if (oldLevel !== level) {
        vectorFieldOverlay?.markDimensionDirty?.(vid);
      }
    },

    /**
     * Get dimension level for a specific view
     * @param {string} viewId - View identifier
     * @returns {number} Dimension level (defaults to 3)
     */
    getViewDimension(viewId) {
      return getPublishedDimensionLevel(viewId);
    },

    /**
     * Set positions for a specific view (for multi-dimensional support in multiview)
     * Updates the snapshot buffer with new positions if the view has one.
     * Also updates per-view edge position textures if edge rendering is enabled.
     * @param {string} viewId - View identifier
     * @param {Float32Array} positions - 3D positions array
     * @param {number} dimensionLevel - Dimension owned by this position generation.
     */
    setViewPositions(viewId, positions, dimensionLevel) {
      const vid = assertKnownViewId(viewId);
      assertFiniteFloat32Array(
        positions,
        pointCount * 3,
        `Positions for view "${vid}"`
      );
      getDefaultNavigationMode(dimensionLevel);
      let publishedPositions = positions;
      const previousPositions = getExactViewPositions(vid);
      const previousDimensionLevel = getPublishedDimensionLevel(vid);
      let rendererPublished = false;

      // If this is the live view, update the main positions
      if (vid === LIVE_VIEW_ID) {
        try {
          hpRenderer.updatePositions(positions, dimensionLevel);
          rendererPublished = true;
          if (useInstancedEdges && nEdgesV2 > 0) {
            createPositionTextureV2ForView(vid);
          }
        } catch (publicationError) {
          if (rendererPublished) {
            const restorationFailures = [];
            try {
              hpRenderer.loadData(previousPositions, colorsArray, {
                alphaValues: transparencyArray,
                dimensionLevel: previousDimensionLevel
              });
            } catch (restorationError) {
              restorationFailures.push(restorationError);
            }
            if (
              restorationFailures.length === 0 &&
              useInstancedEdges &&
              nEdgesV2 > 0
            ) {
              try {
                createPositionTextureV2ForView(vid);
              } catch (edgeRestorationError) {
                restorationFailures.push(edgeRestorationError);
              }
            }
            if (restorationFailures.length > 0) {
              throw new AggregateError(
                [publicationError, ...restorationFailures],
                `View "${vid}" position publication and renderer restoration both failed.`
              );
            }
          }
          throw publicationError;
        }
        highlightTools.retireSpatialInteractions(vid);
        positionsArray = positions;
        computePointBoundsFromPositions(positions);
      } else {
        try {
          hpRenderer.updateSnapshotPositions(
            vid,
            positions,
            dimensionLevel
          );
          rendererPublished = true;
          publishedPositions = hpRenderer.getSnapshotPositions(vid);
          if (useInstancedEdges && nEdgesV2 > 0) {
            createPositionTextureV2ForView(vid);
          }
        } catch (publicationError) {
          if (rendererPublished) {
            const restorationFailures = [];
            try {
              hpRenderer.updateSnapshotPositions(
                vid,
                previousPositions,
                previousDimensionLevel
              );
              // updateSnapshotPositions publishes an immutable renderer-owned
              // copy. Restore the cache to that exact owner, not the released
              // pre-attempt array, so subsequent snapshot derivation can prove
              // geometry-generation identity.
              viewPositionsCache.set(
                vid,
                hpRenderer.getSnapshotPositions(vid)
              );
            } catch (restorationError) {
              restorationFailures.push(restorationError);
            }
            if (
              restorationFailures.length === 0 &&
              useInstancedEdges &&
              nEdgesV2 > 0
            ) {
              try {
                createPositionTextureV2ForView(vid);
              } catch (edgeRestorationError) {
                restorationFailures.push(edgeRestorationError);
              }
            }
            if (restorationFailures.length > 0) {
              throw new AggregateError(
                [publicationError, ...restorationFailures],
                `Snapshot "${vid}" position publication and renderer restoration both failed.`
              );
            }
          }
          throw publicationError;
        }
        highlightTools.retireSpatialInteractions(vid);
      }
      viewPositionsCache.set(vid, publishedPositions);
      vectorFieldOverlay?.markGeometryDirty?.(vid);
    },

    /**
     * Get a caller-owned positions copy for a specific view.
     * @param {string} viewId - View identifier
     * @returns {Float32Array} Positions array
     */
    getViewPositions(viewId) {
      return new Float32Array(getExactViewPositions(viewId));
    },

    /**
     * Get packed RGBA colors for a specific view.
     * Snapshot views may have independent colors for split-view comparisons.
     *
     * @param {string} viewId - View identifier
     * @returns {Uint8Array|null}
     */
    getViewColors(viewId) {
      const vid = assertViewId(viewId);
      if (vid === LIVE_VIEW_ID) {
        if (!(colorsArray instanceof Uint8Array)) {
          throw new Error('Colors are not published for view "live".');
        }
        return new Uint8Array(colorsArray);
      }
      const snapshot = snapshotViews.find(s => s.id === vid);
      if (!snapshot) {
        throw new Error(`View "${vid}" does not exist.`);
      }
      if (!(snapshot.colors instanceof Uint8Array)) {
        throw new Error(`Colors are not published for view "${vid}".`);
      }
      return new Uint8Array(snapshot.colors);
    },

    /**
     * Get transparency array for a specific view.
     * Used by selection tools to respect per-view filtering in multi-view mode.
     * @param {string} viewId - View identifier
     * @returns {Float32Array|null} Transparency array (0 = hidden, >0 = visible)
     */
    getViewTransparency(viewId) {
      return getExactViewTransparency(viewId);
    },

    updateHighlight(highlightData, highlightedIndices = null) {
      highlightTools.updateHighlight(highlightData, highlightedIndices);
    },

    setHighlightStyle(options = {}) {
      highlightTools.setHighlightStyle(options);
    },

    getHighlightedCount() {
      return highlightTools.getHighlightedCount();
    },

    /**
     * Resolve one exact per-view pick.
     * @returns {{
     *   viewId: string,
     *   cellIndex: number,
     *   position: {x: number, y: number, z: number}
     * }|null} Frozen record for a hit, otherwise null.
     */
    pickCellRecordAtScreen(screenX, screenY) {
      return pickCellRecordAtScreen(screenX, screenY);
    },

    // Scalar convenience API for callers that need only the cell ID.
    pickCellAtScreen(screenX, screenY) {
      return pickCellAtScreen(screenX, screenY);
    },

    setCellSelectionCallback(callback) {
      highlightTools.setCellSelectionCallback(callback);
    },

    setSelectionStepCallback(callback) {
      highlightTools.setSelectionStepCallback(callback);
    },

    setCellSelectionEnabled(enabled) {
      highlightTools.setCellSelectionEnabled(enabled);
    },

    getCellSelectionEnabled() {
      return highlightTools.getCellSelectionEnabled();
    },

    setSelectionPreviewCallback(callback) {
      highlightTools.setSelectionPreviewCallback(callback);
    },

    getAnnotationState() {
      return highlightTools.getAnnotationState();
    },

    confirmAnnotationSelection() {
      highlightTools.confirmAnnotationSelection();
    },

    cancelAnnotationSelection() {
      highlightTools.cancelAnnotationSelection();
    },

    setHighlightMode(mode) {
      highlightTools.setHighlightMode(mode);
    },

    getHighlightMode() {
      return highlightTools.getHighlightMode();
    },

    // Lasso selection API
    setLassoEnabled(enabled) {
      highlightTools.setLassoEnabled(enabled);
    },

    getLassoEnabled() {
      return highlightTools.getLassoEnabled();
    },

    setLassoCallback(callback) {
      highlightTools.setLassoCallback(callback);
    },

    setLassoPreviewCallback(callback) {
      highlightTools.setLassoPreviewCallback(callback);
    },

    clearLasso() {
      highlightTools.clearLasso();
    },

    // Multi-step lasso selection API
    setLassoStepCallback(callback) {
      highlightTools.setLassoStepCallback(callback);
    },

    getLassoState() {
      return highlightTools.getLassoState();
    },

    confirmLassoSelection() {
      highlightTools.confirmLassoSelection();
    },

    cancelLassoSelection() {
      highlightTools.cancelLassoSelection();
    },

    // Restore lasso state for undo/redo
    restoreLassoState(candidates, step) {
      highlightTools.restoreLassoState(candidates, step);
    },

    // Proximity drag selection API
    setProximityEnabled(enabled) {
      highlightTools.setProximityEnabled(enabled);
    },

    getProximityEnabled() {
      return highlightTools.getProximityEnabled();
    },

    setProximityCallback(callback) {
      highlightTools.setProximityCallback(callback);
    },

    setProximityPreviewCallback(callback) {
      highlightTools.setProximityPreviewCallback(callback);
    },

    setProximityStepCallback(callback) {
      highlightTools.setProximityStepCallback(callback);
    },

    getProximityState() {
      return highlightTools.getProximityState();
    },

    confirmProximitySelection() {
      highlightTools.confirmProximitySelection();
    },

    cancelProximitySelection() {
      highlightTools.cancelProximitySelection();
    },

    // Restore proximity state for undo/redo
    restoreProximityState(candidates, step) {
      highlightTools.restoreProximityState(candidates, step);
    },

    // KNN drag selection API
    setKnnEnabled(enabled) {
      highlightTools.setKnnEnabled(enabled);
    },

    getKnnEnabled() {
      return highlightTools.getKnnEnabled();
    },

    setKnnCallback(callback) {
      highlightTools.setKnnCallback(callback);
    },

    setKnnPreviewCallback(callback) {
      highlightTools.setKnnPreviewCallback(callback);
    },

    setKnnStepCallback(callback) {
      highlightTools.setKnnStepCallback(callback);
    },

    setKnnEdgeLoadCallback(callback) {
      highlightTools.setKnnEdgeLoadCallback(callback);
    },

    getKnnState() {
      return highlightTools.getKnnState();
    },

    // Load KNN edges from edge arrays and build adjacency list
    loadKnnEdges(sources, destinations) {
      return highlightTools.loadKnnEdges(sources, destinations);
    },

    clearKnnEdges() {
      highlightTools.clearKnnEdges();
    },

    isKnnEdgesLoaded() {
      return highlightTools.isKnnEdgesLoaded();
    },

    confirmKnnSelection() {
      highlightTools.confirmKnnSelection();
    },

    cancelKnnSelection() {
      highlightTools.cancelKnnSelection();
    },

    // Restore KNN state for undo/redo
    restoreKnnState(candidates, step) {
      highlightTools.restoreKnnState(candidates, step);
    },

    // Unified selection API (shared state across lasso, proximity, KNN)
    // Allows switching tools mid-selection to refine with different methods
    getUnifiedSelectionState() {
      return highlightTools.getUnifiedSelectionState();
    },

    confirmUnifiedSelection(callback) {
      return highlightTools.confirmUnifiedSelection(callback);
    },

    cancelUnifiedSelection() {
      highlightTools.cancelUnifiedSelection();
    },

    restoreUnifiedState(candidates, step) {
      highlightTools.restoreUnifiedState(candidates, step);
    },

  setCentroids(payload) {
    const {
      positions,
      colors,
      count: nextCentroidCount
    } = assertCentroidPayload(payload);
    if (nextCentroidCount === 0) {
      const previousPositions = centroidPositionBuffer;
      const previousColors = centroidColorBuffer;
      centroidPositionBuffer = null;
      centroidColorBuffer = null;
      centroidCount = 0;
      queueCentroidSnapshotRetirement({
        buffer: previousPositions,
      });
      queueCentroidSnapshotRetirement({
        buffer: previousColors,
      });
      reportCommittedRetirementFailures(
        drainCentroidSnapshotRetirements(),
        'Empty live centroid generation committed with pending prior-buffer retirement.'
      );
      return;
    }
    assertNoWebGLError(gl, 'Viewer centroid publication');
    let candidatePositions = null;
    let candidateColors = null;
    try {
      candidatePositions = gl.createBuffer();
      candidateColors = gl.createBuffer();
      if (!candidatePositions || !candidateColors) {
        throw new Error(
          'Viewer could not allocate candidate centroid buffers.'
        );
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, candidatePositions);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, candidateColors);
      gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      assertNoWebGLError(gl, 'Viewer candidate centroid publication');
    } catch (error) {
      const rollbackFailures = [];
      for (const operation of [
        () => gl.bindBuffer(gl.ARRAY_BUFFER, null),
        () => gl.getError(),
      ]) {
        try {
          operation();
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      queueCentroidSnapshotRetirement({
        buffer: candidatePositions,
      });
      queueCentroidSnapshotRetirement({
        buffer: candidateColors,
      });
      rollbackFailures.push(
        ...drainCentroidSnapshotRetirements()
      );
      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [error, ...rollbackFailures],
          'Viewer centroid publication failed and rollback was incomplete.'
        );
      }
      throw error;
    }

    const previousPositions = centroidPositionBuffer;
    const previousColors = centroidColorBuffer;
    centroidPositionBuffer = candidatePositions;
    centroidColorBuffer = candidateColors;
    centroidCount = nextCentroidCount;
    queueCentroidSnapshotRetirement({
      buffer: previousPositions,
    });
    queueCentroidSnapshotRetirement({
      buffer: previousColors,
    });
    reportCommittedRetirementFailures(
      drainCentroidSnapshotRetirements(),
      'Live centroid prior generation could not be fully retired.'
    );
  },

    setCentroidLabels(labels, viewId) {
      const targetId = assertKnownViewId(viewId);
      const entries = [...assertCentroidLabelEntries(labels)];
      if (entries.length > 0 && !labelLayer) {
        throw new Error(
          'Centroid labels require a label-layer element.'
        );
      }
      const candidateElements = new Set();
      for (const [index, item] of entries.entries()) {
        const element = item.el;
        if (candidateElements.has(element)) {
          throw new TypeError(
            `Centroid label ${index} aliases an element already present in this publication.`
          );
        }
        if (
          centroidLabelOwners.has(element) &&
          centroidLabelOwners.get(element) !== targetId
        ) {
          throw new TypeError(
            `Centroid label ${index} is already owned by view ` +
            `"${centroidLabelOwners.get(element)}".`
          );
        }
        candidateElements.add(element);
      }

      const domStates = entries.map(captureCentroidLabelDomState);
      try {
        for (const state of domStates) {
          if (state.element.parentNode !== labelLayer) {
            state.domAttempted = true;
            labelLayer.appendChild(state.element);
          }
        }
        for (const state of domStates) {
          state.datasetAttempted = true;
          state.element.setAttribute('data-view-id', targetId);
        }
      } catch (error) {
        const rollbackFailures = restoreCentroidLabelDomStates(
          domStates,
          targetId
        );
        if (rollbackFailures.length > 0) {
          throw new AggregateError(
            [error, ...rollbackFailures],
            `Centroid labels for view "${targetId}" were not published and rollback was incomplete.`
          );
        }
        throw error;
      }

      const previousLabels = viewCentroidLabels.get(targetId) || [];
      const ownedEntries = entries.map(createOwnedCentroidLabel);
      cancelCentroidLabelRetirements(targetId, candidateElements);
      viewCentroidLabels.set(targetId, ownedEntries);
      for (const element of candidateElements) {
        centroidLabelOwners.set(element, targetId);
      }
      queueCentroidLabelRetirements(
        targetId,
        previousLabels,
        candidateElements
      );

      const settlementFailures = drainCentroidLabelRetirements(targetId);
      try {
        updateLabelLayerVisibility();
      } catch (error) {
        settlementFailures.push(
          error instanceof Error
            ? error
            : new Error(
              'Centroid label visibility reconciliation threw a non-Error value.'
            )
        );
      }
      if (settlementFailures.length > 0) {
        throw new AggregateError(
          settlementFailures,
          `Centroid labels for view "${targetId}" were published, but prior-generation settlement was incomplete.`
        );
      }
    },

    setPointSize(size) {
      basePointSize = assertFiniteNumberInRange(size, 0.25, 200, 'Point size');
    },
    setSizeAttenuation(value) {
      sizeAttenuation = assertFiniteNumberInRange(
        value,
        0,
        1,
        'Perspective size scaling'
      );
    },
    setLightingStrength(value) {
      lightingStrength = assertFiniteNumberInRange(value, 0, 1, 'Lighting strength');
    },
    setFogDensity(value) {
      fogDensity = assertFiniteNumberInRange(value, 0, 1, 'Fog density');
    },
    setShowCentroidPoints(show, viewId) {
      const exactShow = assertExactBoolean(show, 'Centroid point visibility');
      setViewFlags(viewId, { points: exactShow });
    },

    setShowCentroidLabels(show, viewId) {
      const exactShow = assertExactBoolean(show, 'Centroid label visibility');
      const key = assertKnownViewId(viewId);
      setViewFlags(key, { labels: exactShow });
      if (!exactShow) hideLabelsForView(key);
      updateLabelLayerVisibility();
    },

    getCentroidFlags(viewId) { return getViewFlags(viewId); },
    setBackground,
    setViewportLeftOcclusionRatio(value) {
      const exactRatio = assertFiniteNumberInRange(
        value,
        0,
        1,
        'Viewport left occlusion ratio'
      );
      if (exactRatio === viewportLeftOcclusionRatio) return;
      viewportLeftOcclusionRatio = exactRatio;
      cachedGridProjections.clear();
      cachedGridProjectionAspect = null;
    },
    setRenderMode(mode) {
      const exactMode = assertRenderMode(mode);
      if (exactMode === 'smoke' && snapshotViews.length > 0) {
        throw new RangeError('Smoke render mode is unavailable while snapshots exist.');
      }
      if (renderMode === 'smoke' && exactMode !== 'smoke') {
        smokeRenderer.cancelNoiseGeneration();
      }
      renderMode = exactMode;
    },
    setSmokeRenderFailureHandler(fn) {
      smokeRenderFailureHandler = assertExactFunction(
        fn,
        'Smoke render failure handler'
      );
    },
    setVelocityRenderFailureHandler(fn) {
      velocityRenderFailureHandler = assertExactFunction(
        fn,
        'Velocity render failure handler'
      );
    },
    setNavigationMode(mode) {
      const exactMode = assertNavigationMode(mode);
      const previousMode = navigationMode;
      if (camerasLocked) {
        navigationModeOwnership.recordSharedUserChoice(exactMode);
      } else {
        navigationModeOwnership.recordViewUserChoice(focusedViewId, exactMode);
      }
      applyNavigationModeWithSync(exactMode);
      if (camerasLocked) {
        applyViewNavigationMode(LIVE_VIEW_ID, exactMode);
        for (const snapshot of snapshotViews) {
          applyViewNavigationMode(snapshot.id, exactMode);
        }
      } else {
        applyViewNavigationMode(focusedViewId, exactMode);
      }
      if (navigationMode !== previousMode) {
        navigationModeChangeHandler?.(focusedViewId, navigationMode);
      }
    },
    getNavigationMode() { return navigationMode; },
    setLookSensitivity(value) {
      lookSensitivity = assertFiniteNumberInRange(
        value,
        0.0005,
        0.02,
        'Look sensitivity'
      );
    },
    setMoveSpeed(value) {
      moveSpeed = assertFiniteNumberInRange(
        value,
        0.01,
        5,
        'Movement speed'
      );
    },
    setInvertLookY(value) {
      invertLookY = assertExactBoolean(value, 'Vertical invert look');
    },
    setInvertLookX(value) {
      invertLookX = assertExactBoolean(value, 'Horizontal invert look');
    },
    setOrbitInvertRotation(value) {
      orbitInvertX = assertExactBoolean(value, 'Orbit rotation inversion');
    },
    setPlanarZoomToCursor(value) {
      planarZoomToCursor = assertExactBoolean(value, 'Planar zoom-to-cursor');
    },
    setPlanarInvertAxes(value) {
      planarInvertAxes = assertExactBoolean(value, 'Planar axis inversion');
    },
    // Keyboard navigation speed setters
    setOrbitKeySpeed(value) {
      orbitKeySpeed = assertFiniteNumberInRange(
        value,
        0.01,
        2,
        'Orbit keyboard speed'
      );
    },
    setPlanarPanSpeed(value) {
      planarPanSpeed = assertFiniteNumberInRange(
        value,
        0.001,
        0.0075,
        'Planar keyboard pan speed'
      );
    },
    setPointerLockEnabled(enabled) {
      const exactEnabled = assertExactBoolean(enabled, 'Pointer lock');
      if (exactEnabled && navigationMode !== 'free') {
        throw new RangeError(
          'Pointer lock can be enabled only in Free Fly navigation mode.'
        );
      }
      if (exactEnabled) {
        if (typeof canvas.requestPointerLock !== 'function') {
          clearPointerLockIntent(
            'Pointer lock is unavailable in this browser or platform context.'
          );
          return;
        }
        pointerLockEnabled = true;
        requestPointerLockOwned();
      } else {
        const wasLocked = document.pointerLockElement === canvas;
        clearPointerLockIntent(null);
        if (wasLocked) {
          if (typeof document.exitPointerLock !== 'function') {
            throw new Error(
              'The browser cannot release its active pointer lock.'
            );
          }
          document.exitPointerLock();
        }
      }
    },
    setPointerLockChangeHandler(fn) {
      pointerLockChangeHandler = assertExactFunction(
        fn,
        'Pointer lock change handler'
      );
    },
    setProjectilesEnabled(enabled, onComplete) {
      const exactEnabled = assertExactBoolean(enabled, 'Projectile visibility');
      const completion = onComplete === undefined
        ? null
        : assertExactFunction(onComplete, 'Projectile completion handler');
      if (!exactEnabled && completion !== null) {
        throw new TypeError(
          'Projectile completion handlers are accepted only when enabling projectiles.'
        );
      }

      cancelPendingProjectileBuild(
        'Projectile preparation was superseded by a newer request.'
      );
      projectileSystem.setEnabled(false);
      if (!exactEnabled) return;

      const dimLevel = getPublishedDimensionLevel(LIVE_VIEW_ID);
      if (hpRenderer.hasSpatialIndex(dimLevel)) {
        projectileSystem.setEnabled(true);
        publishProjectileBuildResult(completion, 'ready', null);
        return;
      }

      const generation = projectileBuildGeneration;
      projectileBuildCompletion = completion;
      projectileBuildTimer = setTimeout(() => {
        projectileBuildTimer = null;
        if (
          generation !== projectileBuildGeneration ||
          getPublishedDimensionLevel(LIVE_VIEW_ID) !== dimLevel
        ) {
          return;
        }
        try {
          hpRenderer.ensureSpatialIndex(dimLevel);
          if (
            generation !== projectileBuildGeneration ||
            getPublishedDimensionLevel(LIVE_VIEW_ID) !== dimLevel
          ) {
            return;
          }
          const ownedCompletion = projectileBuildCompletion;
          projectileBuildCompletion = null;
          projectileSystem.setEnabled(true);
          publishProjectileBuildResult(ownedCompletion, 'ready', null);
        } catch (error) {
          if (generation !== projectileBuildGeneration) return;
          const ownedCompletion = projectileBuildCompletion;
          projectileBuildCompletion = null;
          projectileSystem.setEnabled(false);
          const detail = error instanceof Error && error.message.length > 0
            ? error.message
            : String(error);
          publishProjectileBuildResult(
            ownedCompletion,
            'error',
            `Projectile preparation failed: ${detail}`
          );
        }
      }, 10);
    },
    isProjectileSpatialIndexReady() {
      const dimLevel = getPublishedDimensionLevel(LIVE_VIEW_ID);
      return !!(hpRenderer && hpRenderer.hasSpatialIndex(dimLevel));
    },

    // Orbit anchor visibility control
    setShowOrbitAnchor(show) {
      orbitAnchorRenderer.setShowAnchor(
        assertExactBoolean(show, 'Orbit anchor visibility')
      );
    },
    getShowOrbitAnchor() { return orbitAnchorRenderer.getShowAnchor(); },

    // Smoke renderer API (delegates to SmokeRenderer)
    setSmokeVolume(volumeDesc) { smokeRenderer.setVolume(volumeDesc); },
    clearSmokeVolume() { smokeRenderer.clearVolume(); },
    buildSmokeVolumeGPU(positions, options = {}) { return smokeRenderer.buildVolumeGPU(positions, options); },
    hasSmokeVolume() { return smokeRenderer.hasVolume(); },
    setSmokeParams(params) { smokeRenderer.setParams(params); },
    setCloudResolutionScale(scale) { smokeRenderer.setResolutionScale(scale); },
    getCloudResolutionScale() { return smokeRenderer.getResolutionScale(); },
    setNoiseTextureResolution(size) { smokeRenderer.setNoiseTextureResolution(size); },
    getNoiseTextureResolution() { return smokeRenderer.getNoiseTextureResolution(); },
    getAdaptiveScaleFactor() { return smokeRenderer.getAdaptiveScaleFactor(); },
    hasPendingSmokeNoiseGeneration() {
      return smokeRenderer.hasPendingNoiseGeneration();
    },
    hasSmokeNoiseTextures() { return smokeRenderer.hasNoiseTextures(); },
	    setSmokeQualityPreset(preset) { smokeRenderer.setQualityPreset(preset); },

    setShowConnectivity(show) {
      showConnectivity = assertExactBoolean(show, 'Connectivity visibility');
    },
    getShowConnectivity() { return showConnectivity; },
    setConnectivityLineWidth(width) {
      connectivityLineWidth = assertFiniteNumberInRange(
        width,
        0.1,
        10,
        'Connectivity line width'
      );
    },
    getConnectivityLineWidth() { return connectivityLineWidth; },
    setConnectivityAlpha(alpha) {
      connectivityAlpha = assertFiniteNumberInRange(
        alpha,
        0.01,
        1,
        'Connectivity opacity'
      );
    },
    getConnectivityAlpha() { return connectivityAlpha; },
    setConnectivityColor(r, g, b) {
      const red = assertIntegerInRange(r, 0, 255, 'Connectivity red channel');
      const green = assertIntegerInRange(g, 0, 255, 'Connectivity green channel');
      const blue = assertIntegerInRange(b, 0, 255, 'Connectivity blue channel');
      connectivityColorBytes[0] = red;
      connectivityColorBytes[1] = green;
      connectivityColorBytes[2] = blue;
    },
    // Returns byte values (0-255)
    getConnectivityColor() { return [connectivityColorBytes[0], connectivityColorBytes[1], connectivityColorBytes[2]]; },
    hasConnectivityData() { return hasEdgeDataV2; },
    getEdgeCount() { return nEdgesV2; },

    // ========================================================================
    // V2 GPU-INSTANCED EDGE API
    // ========================================================================

    /**
     * Set up V2 instanced edge rendering with edge data
     * @param {Object} edgeData - Exact weighted edge payload
     * @param {Float32Array} positions - Cell positions (flat xyz array)
     */
    setupEdgesV2(edgeData, positions = null) {
      const {
        sources,
        destinations,
        weights,
        nEdges,
        nCells,
      } = edgeData;

      if (
        !(sources instanceof Uint32Array) ||
        !(destinations instanceof Uint32Array) ||
        !(weights instanceof Float64Array) ||
        !Number.isSafeInteger(nEdges) ||
        nEdges < 0 ||
        !Number.isSafeInteger(nCells) ||
        nCells <= 0 ||
        sources.length !== nEdges ||
        destinations.length !== nEdges ||
        weights.length !== nEdges ||
        (
          positions !== null &&
          (
            !(positions instanceof Float32Array) ||
            positions.length !== nCells * 3
          )
        )
      ) {
        throw new TypeError(
          'V2 edge setup requires exact edge summaries, matching ' +
          'Uint32 endpoints and Float64 weights, and a renderer-published ' +
          'Float32 XYZ geometry generation.'
        );
      }

      const renderWeights =
        createConnectivityRenderWeights(weights).values;
      clearEdgeResourcesV2();
      try {
        createEdgeTexturesV2(
          sources,
          destinations,
          renderWeights,
          nEdges
        );

        if (
          !createPositionTextureV2ForView(
            LIVE_VIEW_ID,
            positions,
            nCells
          ) ||
          !updateVisibilityTextureV2ForView(
            LIVE_VIEW_ID,
            nCells,
            () => 255
          )
        ) {
          clearEdgeResourcesV2();
          return false;
        }
      } catch (error) {
        clearEdgeResourcesV2();
        throw error;
      }

      hasEdgeDataV2 = true;
      useInstancedEdges = true;
      edgeLodLimit = 0;
      console.log(`[Viewer] V2 instanced edges enabled: ${nEdges} edges, ${nCells} cells`);
      return true;
    },

    /**
     * Update visibility texture for V2 edges (live view).
     * @param {Float32Array} visibility - Per-cell visibility (0-1)
     */
    updateEdgeVisibilityV2(visibility) {
      if (
        !hasEdgeDataV2 ||
        !useInstancedEdges ||
        !edgePositionTexturesV2.has(LIVE_VIEW_ID)
      ) {
        return false;
      }
      return updateVisibilityTextureV2ForView(
        LIVE_VIEW_ID,
        visibility
      );
    },

    /**
     * Set LOD limit for V2 edges (0 = no limit)
     * @param {number} limit - Maximum edges to render
     */
    setEdgeLodLimit(limit) {
      edgeLodLimit = assertIntegerInRange(
        limit,
        0,
        nEdgesV2,
        'Connectivity edge LOD limit'
      );
    },

    /**
     * Get current LOD limit
     */
    getEdgeLodLimit() {
      return edgeLodLimit;
    },

    /**
     * Check if V2 instanced edges are enabled
     */
    isUsingInstancedEdges() {
      return useInstancedEdges;
    },

    /**
     * Get V2 edge count
     */
    getEdgeCountV2() {
      return nEdgesV2;
    },

    /**
     * Disable V2 instanced edges
     */
    disableEdgesV2() {
      useInstancedEdges = false;
    },

    clearEdgesV2() {
      clearEdgeResourcesV2();
    },

    /**
     * Enable V2 instanced edges (if set up)
     */
    enableEdgesV2() {
      if (
        !hasEdgeDataV2 ||
        edgeTextureV2 === null ||
        edgeWeightTextureV2 === null ||
        !edgePositionTexturesV2.has(LIVE_VIEW_ID) ||
        !edgeVisibilityTexturesV2.has(LIVE_VIEW_ID)
      ) {
        return false;
      }
      useInstancedEdges = true;
      return true;
    },

    // ========================================================================
    // PER-VIEW EDGE API (Multi-view / Multi-dimension support)
    // ========================================================================

    /**
     * Set up edge position texture for a specific view.
     * Call this when a view has different positions than the global (e.g., XY vs XZ embedding).
     * The edge topology texture is shared across all views.
     * @param {string} viewId - View identifier
     * @param {Float32Array} positions - Cell positions (flat xyz array, nCells * 3)
     * @param {number} nCells - Number of cells
     */
    setupEdgesV2ForView(
      viewId,
      positions = null,
      nCells = null
    ) {
      if (!hasEdgeDataV2 || !useInstancedEdges) {
        console.warn('[Viewer] Cannot setup per-view edges: V2 edges not initialized');
        return false;
      }
      if (
        typeof viewId !== 'string' ||
        viewId.length === 0 ||
        (
          nCells !== null &&
          (
            !Number.isSafeInteger(nCells) ||
            nCells <= 0 ||
            nCells !== nCellsV2
          )
        ) ||
        (
          positions !== null &&
          (
            !(positions instanceof Float32Array) ||
            positions.length !== nCellsV2 * 3
          )
        )
      ) {
        throw new TypeError(
          'Per-view edge setup requires a non-empty view id and, when ' +
          'provided, the exact published cell count and Float32 XYZ shape.'
        );
      }
      if (!createPositionTextureV2ForView(viewId, positions, nCells)) {
        return false;
      }
      if (
        !updateVisibilityTextureV2ForView(
          viewId,
          nCellsV2,
          () => 255
        )
      ) {
        deleteEdgeTexturesForView(viewId);
        return false;
      }
      return true;
    },

    /**
     * Update edge visibility texture for a specific view.
     * @param {string} viewId - View identifier
     * @param {Float32Array} visibility - Per-cell visibility (0-1)
     */
    updateEdgeVisibilityV2ForView(viewId, visibility) {
      if (!hasEdgeDataV2 || !useInstancedEdges) {
        return false;
      }
      if (typeof viewId !== 'string' || viewId.length === 0) {
        return false;
      }
      const vid = viewId;
      if (!edgePositionTexturesV2.has(vid)) {
        return false;
      }
      return updateVisibilityTextureV2ForView(viewId, visibility);
    },

    /**
     * Check if a view has per-view edge textures set up.
     * @param {string} viewId - View identifier
     * @returns {boolean}
     */
    hasEdgeTexturesForView(viewId) {
      return hasEdgeTexturesForView(viewId);
    },

    /**
     * Delete edge textures for a specific view (cleanup on snapshot removal).
     * @param {string} viewId - View identifier
     * @returns {boolean} Whether an exact view identifier was accepted
     */
    deleteEdgeTexturesForView(viewId) {
      return deleteEdgeTexturesForView(viewId);
    },

    /**
     * Get the number of cells for edge rendering (for visibility array sizing).
     * @returns {number}
     */
    getEdgeCellCount() {
      // Return from first per-view entry (live view is always set up first)
      for (const entry of edgePositionTexturesV2.values()) {
        return entry.nCells;
      }
      return 0;
    },

    getEdgeTextureStatsV2() {
      return getEdgeTextureStatsV2();
    },

    /**
     * Enable/disable edge debug mode for troubleshooting.
     * @param {boolean} enabled - Whether to enable debug logging
     */
    setEdgeDebugMode(enabled) {
      edgeDebugMode = assertExactBoolean(enabled, 'Edge debug mode');
      edgeDebugFrameCount = 0;  // Reset frame counter
      if (enabled) {
        console.log('[Viewer] Edge debug mode enabled. Debug output will be logged for next 5 frames.');
        console.log('[Viewer] Edge texture state:', {
          edgeTextureV2: !!edgeTextureV2,
          edgeWeightTextureV2: !!edgeWeightTextureV2,
          nEdgesV2,
          nCellsV2,
          useInstancedEdges,
          positionTextures: Array.from(edgePositionTexturesV2.keys()),
          visibilityTextures: Array.from(edgeVisibilityTexturesV2.keys())
        });
      }
    },

    resetCamera() {
      velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
      radius = targetRadius = 3.0;
      theta = phi = Math.PI / 4;
      vec3.set(target, 0, 0, 0);
      vec3.set(freeflyPosition, 0, 0, 3.0);
      vec3.set(freeflyVelocity, 0, 0, 0);
      freeflyYaw = Math.PI / 4;
      freeflyPitch = 0;
      const resetWasPointerLocked = document.pointerLockElement === canvas;
      clearPointerLockIntent(null);
      projectileSystem.reset();
      if (
        resetWasPointerLocked &&
        typeof document.exitPointerLock === 'function'
      ) {
        document.exitPointerLock();
      }
    },

    getCameraState() {
      return getCurrentCameraStateInternal();
    },

    setCameraState(camState) {
      const exactState = assertCameraState(camState);
      const exactMode = exactState.navigationMode;
      const previousMode = navigationMode;

      // Stop any inertia so the camera holds the exact position we set
      velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
      vec3.set(freeflyVelocity, 0, 0, 0);

      // Set navigation mode directly without triggering sync functions —
      // the caller (interpolation engine / goto) already provides fully-synced
      // orbit + freefly data so no re-sync is needed.
      applyNavigationModeDirectly(exactMode);

      // Apply both representations unconditionally so all internal variables
      // stay in sync regardless of which mode is active.
      radius = exactState.orbit.radius;
      targetRadius = exactState.orbit.targetRadius;
      theta = exactState.orbit.theta;
      phi = exactState.orbit.phi;
      vec3.set(
        target,
        exactState.orbit.target[0],
        exactState.orbit.target[1],
        exactState.orbit.target[2]
      );
      vec3.set(
        freeflyPosition,
        exactState.freefly.position[0],
        exactState.freefly.position[1],
        exactState.freefly.position[2]
      );
      freeflyYaw = exactState.freefly.yaw;
      freeflyPitch = exactState.freefly.pitch;
      if (navigationMode !== previousMode) {
        navigationModeChangeHandler?.(focusedViewId, navigationMode);
      }
    },

    stopInertia() {
      velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
      vec3.set(freeflyVelocity, 0, 0, 0);
    },

    // Camera lock API for independent view navigation
    setCamerasLocked(locked) {
      if (typeof locked !== 'boolean') {
        throw new TypeError('Camera lock state must be an exact boolean.');
      }
      const wasLocked = camerasLocked;
      camerasLocked = locked;

      if (wasLocked && !camerasLocked) {
        // Transitioning to unlocked: initialize all view cameras from current state
        const currentCam = getCurrentCameraStateInternal();
        if (!liveCameraState) {
          liveCameraState = JSON.parse(JSON.stringify(currentCam));
        } else {
          // Update existing camera state with current navigation mode and camera position
          liveCameraState.navigationMode = currentCam.navigationMode;
          liveCameraState.orbit = JSON.parse(JSON.stringify(currentCam.orbit));
          liveCameraState.freefly = JSON.parse(JSON.stringify(currentCam.freefly));
        }
        for (const snap of snapshotViews) {
          if (!snap.cameraState) {
            snap.cameraState = JSON.parse(JSON.stringify(currentCam));
          } else {
            // Update existing camera state with current navigation mode and camera position
            snap.cameraState.navigationMode = currentCam.navigationMode;
            snap.cameraState.orbit = JSON.parse(JSON.stringify(currentCam.orbit));
            snap.cameraState.freefly = JSON.parse(JSON.stringify(currentCam.freefly));
          }
        }
        // Pre-compute cached view matrices for all views (avoids per-frame recalculation)
        updateCachedViewMatrix(LIVE_VIEW_ID, liveCameraState);
        for (const snap of snapshotViews) {
          updateCachedViewMatrix(snap.id, snap.cameraState);
        }
      } else if (!wasLocked && camerasLocked) {
        // Transitioning to locked: adopt active view's camera as global
        const activeCam = getViewCameraState(focusedViewId);
        if (activeCam) {
          navigationModeOwnership.promoteViewUserChoice(
            focusedViewId,
            activeCam.navigationMode
          );
          applyCameraStateTemporarily(activeCam);
        }
        // Clear cached matrices (not needed in locked mode)
        invalidateAllCachedMatrices();
      }
    },

    getCamerasLocked() { return camerasLocked; },
    getFocusedViewId() { return focusedViewId; },

    getViewCameraState(viewId) {
      return cloneCameraState(
        getViewCameraState(viewId),
        `Camera state for view "${String(viewId)}"`
      );
    },
    setViewCameraState(viewId, camState) {
      const exactViewId = assertKnownViewId(viewId);
      const exactState = assertCameraState(camState, 'View camera state');
      const exactMode = exactState.navigationMode;
      navigationModeOwnership.recordViewUserChoice(exactViewId, exactMode);
      setViewCameraState(exactViewId, exactState);
    },

    // Per-view navigation mode (only relevant when cameras are unlocked)
    getViewNavigationMode(viewId) { return getViewNavigationMode(viewId); },
    setViewNavigationMode(viewId, mode) {
      const exactViewId = assertKnownViewId(viewId);
      const exactMode = assertNavigationMode(mode);
      const previousMode = navigationMode;
      navigationModeOwnership.recordViewUserChoice(exactViewId, exactMode);
      applyViewNavigationMode(exactViewId, exactMode);
      if (navigationMode !== previousMode) {
        navigationModeChangeHandler?.(exactViewId, navigationMode);
      }
    },

    setViewFocusHandler(fn) {
      viewFocusHandler = assertExactFunction(fn, 'View focus handler');
    },
    setNavigationModeChangeHandler(fn) {
      navigationModeChangeHandler = assertExactFunction(
        fn,
        'Navigation mode change handler'
      );
    },
    setLiveViewLabel(label) {
      liveViewLabel = assertNonEmptyTrimmedString(label, 'Live view label');
    },
    getLiveViewLabel() { return liveViewLabel; },

    // Snapshot API - stores view configs for multiview
    createSnapshotView(config) {
      if (renderMode === 'smoke') {
        throw new RangeError(
          'Snapshot creation is unavailable in smoke render mode.'
        );
      }
      if (snapshotViews.length >= MAX_SNAPSHOTS) {
        throw new RangeError(`Viewer supports a maximum of ${MAX_SNAPSHOTS} snapshots.`);
      }
      if (
        config === null ||
        typeof config !== 'object' ||
        Array.isArray(config) ||
        Object.getPrototypeOf(config) !== Object.prototype
      ) {
        throw new TypeError('Snapshot configuration must be one exact plain object.');
      }
      const sourceViewId = assertKnownViewId(config.sourceViewId);
      const sourcePositions = getExactViewPositions(sourceViewId);
      const exactConfig = assertSnapshotConfig(
        config,
        sourcePositions.length / 3
      );
      const inheritedMode = exactConfig.cameraState.navigationMode;
      const initialDimLevel = exactConfig.dimensionLevel;
      const id = `snap_${nextSnapshotId}`;

      const snapshot = {
        id,
        label: exactConfig.label,
        fieldKey: exactConfig.fieldKey,
        fieldKind: exactConfig.fieldKind,
        colors: exactConfig.colors,
        transparency: exactConfig.transparency,
        centroidPositions: exactConfig.centroidPositions,
        centroidColors: exactConfig.centroidColors,
        meta: exactConfig.meta,
        cameraState: exactConfig.cameraState,
        dimensionLevel: initialDimLevel
      };

      let snapshotBufferAttempted = false;
      let centroidBufferAttempted = false;
      let edgeTexturesAttempted = false;
      let snapshotPositions = null;
      try {
        // Stage every fallible renderer resource before publishing inventory or
        // consuming the next stable snapshot identity.
        snapshotBufferAttempted = true;
        hpRenderer.createSnapshotBuffer(
          id,
          snapshot.colors,
          snapshot.transparency,
          sourcePositions,
          initialDimLevel,
          sourceViewId
        );
        snapshotPositions = hpRenderer.getSnapshotPositions(id);

        if (snapshot.centroidPositions !== null) {
          centroidBufferAttempted = true;
          createCentroidSnapshotBuffer(
            id,
            snapshot.centroidPositions,
            snapshot.centroidColors,
            initialDimLevel
          );
        }

        if (useInstancedEdges && nEdgesV2 > 0) {
          edgeTexturesAttempted = true;
          const nCells = snapshotPositions.length / 3;
          if (!createPositionTextureV2ForView(id)) {
            throw new Error(`Snapshot edge positions were not published for view "${id}".`);
          }
          if (
            !updateVisibilityTextureV2ForView(
              id,
              nCells,
              index => (
                snapshot.transparency[index] > 0.01 ? 255 : 0
              )
            )
          ) {
            throw new Error(`Snapshot edge visibility was not published for view "${id}".`);
          }
        }

        if (!camerasLocked) {
          updateCachedViewMatrix(id, exactConfig.cameraState);
        }
      } catch (error) {
        const rollbackFailures = [];
        const rollback = operation => {
          try {
            operation();
          } catch (rollbackError) {
            rollbackFailures.push(rollbackError);
          }
        };
        if (snapshotBufferAttempted) {
          rollback(() => hpRenderer.deleteSnapshotBuffer(id));
          rollback(() => hpRenderer.clearViewState(id));
        }
        if (centroidBufferAttempted) {
          rollback(() => deleteCentroidSnapshotBuffer(id));
        }
        if (edgeTexturesAttempted) {
          rollback(() => deleteEdgeTexturesForView(id));
        }
        cachedViewMatrices.delete(id);
        if (rollbackFailures.length > 0) {
          throw new AggregateError(
            [error, ...rollbackFailures],
            `Snapshot "${id}" creation failed and renderer rollback was incomplete.`
          );
        }
        throw error;
      }

      snapshotViews.push(snapshot);
      viewDimensionLevels.set(id, initialDimLevel);
      viewPositionsCache.set(id, snapshotPositions);
      navigationModeOwnership.recordViewUserChoice(id, inheritedMode);
      nextSnapshotId += 1;
      return { id, label: snapshot.label };
    },

    updateSnapshotAttributes(id, attrs) {
      const exactId = assertKnownViewId(id);
      if (exactId === LIVE_VIEW_ID) {
        throw new RangeError('Live-view attributes are not snapshot attributes.');
      }
      if (
        attrs === null ||
        typeof attrs !== 'object' ||
        Array.isArray(attrs) ||
        Object.getPrototypeOf(attrs) !== Object.prototype
      ) {
        throw new TypeError('Snapshot attributes must be one exact plain object.');
      }
      const allowedKeys = new Set([
        'centroidColors',
        'centroidPositions',
        'colors',
        'fieldKey',
        'fieldKind',
        'label',
        'meta',
        'transparency'
      ]);
      const keys = Object.keys(attrs);
      if (
        keys.length === 0 ||
        keys.some((key) => !allowedKeys.has(key))
      ) {
        throw new TypeError(
          'Snapshot attributes must contain only current published snapshot fields.'
        );
      }
      const snap = snapshotViews.find((entry) => entry.id === exactId);
      const pointCountForSnapshot = getExactViewPositions(exactId).length / 3;
      const colorsChanged = Object.hasOwn(attrs, 'colors');
      const transparencyChanged = Object.hasOwn(attrs, 'transparency');
      const centroidPositionsChanged = Object.hasOwn(
        attrs,
        'centroidPositions'
      );
      const centroidColorsChanged = Object.hasOwn(attrs, 'centroidColors');
      if (
        (colorsChanged || transparencyChanged) &&
        (centroidPositionsChanged || centroidColorsChanged)
      ) {
        throw new TypeError(
          'Snapshot point buffers and centroid buffers must be published in separate exact updates.'
        );
      }
      if (centroidPositionsChanged !== centroidColorsChanged) {
        throw new TypeError(
          'Snapshot centroid positions and colors must be updated together.'
        );
      }
      const fieldKeyChanged = Object.hasOwn(attrs, 'fieldKey');
      const fieldKindChanged = Object.hasOwn(attrs, 'fieldKind');
      if (fieldKeyChanged !== fieldKindChanged) {
        throw new TypeError(
          'Snapshot fieldKey and fieldKind must be updated together.'
        );
      }

      const nextColors = colorsChanged
        ? new Uint8Array(assertExactUint8Array(
            attrs.colors,
            pointCountForSnapshot * 4,
            'Snapshot colors'
          ))
        : snap.colors;
      const nextTransparency = transparencyChanged
        ? new Float32Array(assertTransparencyArray(
            attrs.transparency,
            pointCountForSnapshot,
            'Snapshot transparency'
          ))
        : snap.transparency;
      let nextCentroidPositions = snap.centroidPositions;
      let nextCentroidColors = snap.centroidColors;
      if (centroidPositionsChanged) {
        if (
          !(attrs.centroidPositions instanceof Float32Array) ||
          attrs.centroidPositions.length % 3 !== 0
        ) {
          throw new TypeError(
            'Snapshot centroid positions must contain complete Float32 XYZ triples.'
          );
        }
        const nextCentroidCount = attrs.centroidPositions.length / 3;
        nextCentroidPositions = new Float32Array(assertFiniteFloat32Array(
          attrs.centroidPositions,
          nextCentroidCount * 3,
          'Snapshot centroid positions'
        ));
        nextCentroidColors = new Uint8Array(assertExactUint8Array(
          attrs.centroidColors,
          nextCentroidCount * 4,
          'Snapshot centroid colors'
        ));
      }
      if (fieldKeyChanged) {
        assertSnapshotFieldDescriptor(attrs.fieldKey, attrs.fieldKind);
      }
      const nextLabel = Object.hasOwn(attrs, 'label')
        ? assertNonEmptyTrimmedString(attrs.label, 'Snapshot label')
        : snap.label;
      const nextMeta = Object.hasOwn(attrs, 'meta')
        ? cloneSnapshotMeta(attrs.meta)
        : snap.meta;

      if (colorsChanged || transparencyChanged) {
        hpRenderer.updateSnapshotBuffer(
          exactId,
          nextColors,
          nextTransparency,
          getExactViewPositions(exactId),
          getPublishedDimensionLevel(exactId)
        );
      }

      if (centroidPositionsChanged) {
        createCentroidSnapshotBuffer(
          exactId,
          nextCentroidPositions,
          nextCentroidColors,
          getPublishedDimensionLevel(exactId)
        );
      }

      if (transparencyChanged) {
        highlightTools.retireSpatialInteractions(exactId);
      }
      snap.colors = nextColors;
      snap.transparency = nextTransparency;
      snap.centroidPositions = nextCentroidPositions;
      snap.centroidColors = nextCentroidColors;
      snap.label = nextLabel;
      snap.meta = nextMeta;
      if (fieldKeyChanged) {
        snap.fieldKey = attrs.fieldKey;
        snap.fieldKind = attrs.fieldKind;
      }
      if (centroidPositionsChanged) {
        snap.centroidCount = nextCentroidPositions.length / 3;
      }

      if (
        transparencyChanged &&
        vectorFieldOverlay !== null &&
        vectorFieldOverlay.enabled
      ) {
        vectorFieldOverlay.markVisibilityDirty(exactId);
      }
      if (transparencyChanged) {
        highlightTools.handleTransparencyChange(exactId);
      }
      return true;
    },

    removeSnapshotView(id) {
      const exactId = assertViewId(id);
      const idx = snapshotViews.findIndex(s => s.id === exactId);
      if (idx < 0) {
        // A prior detach may still own hostile cleanup failures. Repeating the
        // exact removal is the explicit convergence path for those journals.
        const retryFailures = [];
        const retry = operation => {
          try {
            operation();
          } catch (error) {
            retryFailures.push(error);
          }
        };
        retry(() => hpRenderer?.deleteSnapshotBuffer?.(exactId));
        retry(() => hpRenderer?.clearViewState?.(exactId));
        retry(() => highlightTools?.clearViewState?.(exactId));
        retry(() => deleteCentroidSnapshotBuffer(exactId));
        retry(() => deleteEdgeTexturesForView(exactId));
        retry(() => orbitAnchorRenderer?.deleteViewState?.(exactId));
        retry(() => vectorFieldOverlay?.disposeView?.(exactId));
        if (viewCentroidLabels.has(exactId)) {
          retry(() => removeLabelsForView(exactId));
        }
        if (retryFailures.length > 0) {
          pendingSnapshotCleanupIds.add(exactId);
          throw new AggregateError(
            retryFailures,
            `Snapshot "${exactId}" retirement remains pending.`
          );
        }
        pendingSnapshotCleanupIds.delete(exactId);
        return;
      }
      if (idx >= 0) {
        // Detach logical inventory first. Renderer retirement is also
        // detach-first, so a cleanup error must not leave the viewer claiming
        // that a no-longer-renderable snapshot still exists.
        snapshotViews.splice(idx, 1);
        pendingSnapshotCleanupIds.add(exactId);
        const cleanupFailures = [];
        const cleanup = operation => {
          try {
            operation();
          } catch (error) {
            cleanupFailures.push(error);
          }
        };
        if (hpRenderer) {
          cleanup(() => hpRenderer.deleteSnapshotBuffer(exactId));
          cleanup(() => hpRenderer.clearViewState(exactId));
        }
        cleanup(() => highlightTools.clearViewState(exactId));
        cleanup(() => deleteCentroidSnapshotBuffer(exactId));
        cleanup(() => deleteEdgeTexturesForView(exactId));
        cleanup(() => orbitAnchorRenderer.deleteViewState(exactId));
        cachedViewMatrices.delete(exactId);
        renderParamsByView.delete(exactId);
        overlayCtxByView.delete(exactId);
        overlayCtxOptionsByView.delete(exactId);
        viewDimensionLevels.delete(exactId);
        viewPositionsCache.delete(exactId);
        publishedLodLevels.delete(exactId);
        cleanup(() => vectorFieldOverlay?.disposeView?.(exactId));
        cleanup(() => navigationModeOwnership.deleteView(exactId));
        const key = exactId;
        if (key !== LIVE_VIEW_ID) {
          cleanup(() => removeLabelsForView(key));
          viewCentroidFlags.delete(key);
        }
        if (focusedViewId === exactId) focusedViewId = LIVE_VIEW_ID;
        if (snapshotViews.length === 0 && liveViewHidden) {
          liveViewHidden = false;
        }
        cleanup(() => updateLabelLayerVisibility());
        if (cleanupFailures.length > 0) {
          throw new AggregateError(
            cleanupFailures,
            `Snapshot "${exactId}" was removed with ${cleanupFailures.length} cleanup error(s).`
          );
        }
        pendingSnapshotCleanupIds.delete(exactId);
      }
    },

    clearSnapshotViews() {
      const removedSnapshots = snapshotViews.splice(
        0,
        snapshotViews.length
      );
      for (const snapshot of removedSnapshots) {
        pendingSnapshotCleanupIds.add(snapshot.id);
      }
      const cleanupIds = Array.from(pendingSnapshotCleanupIds);
      focusedViewId = LIVE_VIEW_ID;
      liveViewHidden = false;
      const cleanupFailures = [];
      const cleanup = operation => {
        try {
          operation();
        } catch (error) {
          cleanupFailures.push(error);
        }
      };

      if (hpRenderer) {
        cleanup(() => hpRenderer.deleteAllSnapshotBuffers());
        for (const viewId of cleanupIds) {
          cleanup(() => hpRenderer.clearViewState(viewId));
          cleanup(() => orbitAnchorRenderer.deleteViewState(viewId));
        }
      }
      for (const id of Array.from(centroidSnapshotBuffers.keys())) {
        if (String(id) !== LIVE_VIEW_ID) {
          cleanup(() => deleteCentroidSnapshotBuffer(id));
        }
      }
      for (const id of Array.from(edgePositionTexturesV2.keys())) {
        if (String(id) !== LIVE_VIEW_ID) {
          cleanup(() => deleteEdgeTexturesForView(id));
        }
      }
      cleanup(() => {
        const failures = drainCentroidSnapshotRetirements();
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            'Pending centroid snapshot retirement remains incomplete.'
          );
        }
      });
      cleanup(() => {
        const failures = drainEdgeTextureRetirements();
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            'Pending edge texture retirement remains incomplete.'
          );
        }
      });
      for (const viewId of cleanupIds) {
        cleanup(() => highlightTools.clearViewState(viewId));
        cachedViewMatrices.delete(viewId);
        renderParamsByView.delete(viewId);
        overlayCtxByView.delete(viewId);
        overlayCtxOptionsByView.delete(viewId);
        viewDimensionLevels.delete(viewId);
        viewPositionsCache.delete(viewId);
        publishedLodLevels.delete(viewId);
        cleanup(() => vectorFieldOverlay?.disposeView?.(viewId));
        cleanup(() => navigationModeOwnership.deleteView(viewId));
      }
      for (const key of Array.from(viewCentroidLabels.keys())) {
        if (String(key) !== LIVE_VIEW_ID) {
          cleanup(() => removeLabelsForView(key));
        }
      }
      for (const key of Array.from(viewCentroidFlags.keys())) {
        if (String(key) !== LIVE_VIEW_ID) {
          viewCentroidFlags.delete(key);
        }
      }
      cleanup(() => updateLabelLayerVisibility());
      if (colorsArray) cleanup(() => hpRenderer.updateColors(colorsArray));
      if (transparencyArray) {
        cleanup(() => hpRenderer.updateAlphas(transparencyArray));
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          cleanupFailures,
          `All snapshots were cleared with ${cleanupFailures.length} cleanup error(s).`
        );
      }
      pendingSnapshotCleanupIds.clear();
    },

    getSnapshotViews() {
      return snapshotViews.map(s => ({
        id: s.id,
        label: s.label,
        fieldKey: s.fieldKey,
        fieldKind: s.fieldKind,
        meta: cloneSnapshotMeta(s.meta)
      }));
    },

    hasSnapshots() { return snapshotViews.length > 0; },

    setViewLayout(mode, activeId) {
      if (mode !== 'single' && mode !== 'grid') {
        throw new TypeError('View layout mode must be exactly "single" or "grid".');
      }
      const exactActiveId = assertKnownViewId(activeId);
      const changesFocus = exactActiveId !== focusedViewId;
      const nextCamera = changesFocus && !camerasLocked
        ? assertCameraState(
            getViewCameraState(exactActiveId),
            `Camera state for layout view "${exactActiveId}"`
          )
        : null;

      viewLayoutMode = mode;
      if (changesFocus) {
        // Save current camera to previous view before switching (if unlocked)
        if (!camerasLocked) {
          setViewCameraState(focusedViewId, getCurrentCameraStateInternal());
        }
        focusedViewId = exactActiveId;
        // Update active state on title chips
        updateViewTitleActiveState();
        // Load new view's camera (if unlocked)
        if (!camerasLocked) {
          applyCameraStateTemporarily(nextCamera);
        }
      }
      if (viewLayoutMode === 'single') {
        for (const key of viewCentroidLabels.keys()) {
          if (key !== focusedViewId) {
            hideLabelsForView(key);
          }
        }
      }
      updateLabelLayerVisibility();
    },

    getViewLayout() { return { mode: viewLayoutMode, activeId: focusedViewId, liveViewHidden }; },

    setLiveViewHidden(hidden) {
      const exactHidden = assertExactBoolean(hidden, 'Live view visibility');
      if (exactHidden) {
        if (snapshotViews.length === 0) {
          throw new Error(
            'The live view cannot be hidden without a published snapshot.'
          );
        }
        if (
          focusedViewId === LIVE_VIEW_ID ||
          !snapshotViews.some((snapshot) => snapshot.id === focusedViewId)
        ) {
          throw new Error(
            'The live view can be hidden only while a published snapshot has focus.'
          );
        }
      }
      liveViewHidden = exactHidden;
    },

    getLiveViewHidden() {
      return liveViewHidden;
    },

    getGLContext() { return gl; },
    getHPRenderer() { return hpRenderer; },
    isWebGL2() { return true; },

    // ---------------------------------------------------------------------
    // Vector field overlay (GPU particle flow)
    // ---------------------------------------------------------------------

    setVectorFieldOverlayEnabled(enabled) {
      const on = assertExactBoolean(enabled, 'Vector field overlay visibility');
      if (!on && !vectorFieldOverlay) return;
      const overlay = ensureVectorFieldOverlay();
      overlay.setEnabled(on);
    },

    setVectorFieldConfig(key, value) {
      const particleCapacity = vectorFieldOverlay === null
        ? DEFAULT_VELOCITY_PARTICLE_CAPACITY
        : vectorFieldOverlay.config.particleCapacity;
      const validated = validateVelocityOverlayConfig(
        key,
        value,
        particleCapacity
      );
      const overlay = vectorFieldOverlay || ensureVectorFieldOverlay();
      overlay.setConfig(validated.key, validated.value);
    },

    setActiveVectorField(fieldId) {
      const exactFieldId = validateActiveVelocityFieldId(fieldId);
      if (exactFieldId === null && vectorFieldOverlay === null) return;
      const overlay = vectorFieldOverlay || ensureVectorFieldOverlay();
      overlay.setActiveField(exactFieldId);
    },

    setVectorFieldData(fieldId, dimensionLevel, fieldData) {
      if (vectorFieldOverlay !== null) {
        vectorFieldOverlay.setVectorFieldData(
          fieldId,
          dimensionLevel,
          fieldData
        );
        return;
      }
      overlayManager?.retryRetirement(VELOCITY_OVERLAY_ID);
      const candidate = new VelocityOverlay(gl);
      candidate.setFailureHandler(reportVelocityRenderFailure);
      try {
        candidate.setVectorFieldData(fieldId, dimensionLevel, fieldData);
        ensureOverlayManager().register(candidate);
      } catch (error) {
        try {
          candidate.dispose();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Velocity field publication and cleanup both failed.'
          );
        }
        throw error;
      }
      vectorFieldOverlay = candidate;
    },

    hasVectorFieldForDimension(fieldId, dimensionLevel) {
      const exactFieldId = validateVelocityFieldId(fieldId);
      getDefaultNavigationMode(dimensionLevel);
      if (vectorFieldOverlay === null) return false;
      return vectorFieldOverlay.hasFieldForDimension(
        exactFieldId,
        dimensionLevel
      );
    },

    resetVectorFieldOverlay() {
      if (!vectorFieldOverlay) {
        overlayManager?.retryRetirement(VELOCITY_OVERLAY_ID);
        return;
      }
      const retiringOverlay = vectorFieldOverlay;
      if (overlayManager === null) {
        throw new Error(
          'Velocity overlay ownership is published without its overlay manager.'
        );
      }
      vectorFieldOverlay = null;
      overlayManager.unregister(retiringOverlay.id);
    },

    getRenderState() {
      const [width, height] = canvasResizeObserver.getSize();
      updateCamera(width, height);
      mat4.multiply(mvpMatrix, projectionMatrix, viewMatrix);
      mat4.multiply(mvpMatrix, mvpMatrix, modelMatrix);
      mat4.invert(tempInvViewMatrix, viewMatrix);
      const cameraDistance = navigationMode === 'free'
        ? vec3.length(freeflyPosition)
        : radius;
      return {
        mvpMatrix: new Float32Array(mvpMatrix),
        viewMatrix: new Float32Array(viewMatrix),
        modelMatrix: new Float32Array(modelMatrix),
        projectionMatrix: new Float32Array(projectionMatrix),
        pointSize: basePointSize,
        sizeAttenuation,
        viewportHeight: height,
        viewportWidth: width,
        fov,
        near,
        far,
        lightingStrength,
        fogDensity,
        fogColor: new Float32Array(fogColor),
        bgColor: new Float32Array(bgColor),
        lightDir: new Float32Array(lightDir),
        cameraPosition: [tempInvViewMatrix[12], tempInvViewMatrix[13], tempInvViewMatrix[14]],
        cameraDistance,
        shaderQuality: currentShaderQuality
      };
    },

    /**
     * Camera parameters used for projection computations.
     * @returns {{ fov: number; near: number; far: number }}
     */
    getCameraParams() {
      return { fov, near, far };
    },

    /**
     * Compute a render-state snapshot for a specific view without mutating
     * the active camera or render loop state.
     *
     * Used by figure export to reproduce the exact projection for split views.
     *
     * @param {string} viewId
     * @param {{ viewportWidth: number; viewportHeight: number } | null} viewport
     */
    getViewRenderState(viewId, viewport) {
      const [canvasW, canvasH] = canvasResizeObserver.getSize();
      let viewportWidth;
      let viewportHeight;
      if (viewport === null) {
        viewportWidth = canvasW;
        viewportHeight = canvasH;
      } else {
        if (
          viewport === null ||
          typeof viewport !== 'object' ||
          Array.isArray(viewport) ||
          Object.getPrototypeOf(viewport) !== Object.prototype ||
          Object.keys(viewport).sort().join(',') !== 'viewportHeight,viewportWidth'
        ) {
          throw new TypeError(
            'Per-view render-state viewport must be null or an exact viewportHeight/viewportWidth object.'
          );
        }
        viewportWidth = viewport.viewportWidth;
        viewportHeight = viewport.viewportHeight;
      }
      if (
        !Number.isSafeInteger(viewportWidth) ||
        viewportWidth <= 0 ||
        !Number.isSafeInteger(viewportHeight) ||
        viewportHeight <= 0
      ) {
        throw new TypeError(
          'Per-view render-state viewport dimensions must be positive safe integers.'
        );
      }

      const exactViewId = assertViewId(viewId);
      const camState = assertCameraState(
        getViewCameraState(exactViewId),
        `Render camera state for view "${exactViewId}"`
      );
      const viewMtx = mat4.create();
      computeViewMatrixFromState(camState, viewMtx);

      const projMtx = mat4.create();
      mat4.perspective(projMtx, fov, viewportWidth / viewportHeight, near, far);

      const mvpMtx = mat4.create();
      mat4.multiply(mvpMtx, projMtx, viewMtx);
      mat4.multiply(mvpMtx, mvpMtx, modelMatrix);

      // Derive camera position by inverting the view matrix.
      const invView = mat4.create();
      if (mat4.invert(invView, viewMtx) === null) {
        throw new Error(
          `Render camera matrix for view "${exactViewId}" is not invertible.`
        );
      }

      const navMode = camState.navigationMode;
      const cameraDistance = navMode === 'free'
        ? Math.sqrt(
          camState.freefly.position[0] ** 2 +
          camState.freefly.position[1] ** 2 +
          camState.freefly.position[2] ** 2
        )
        : camState.orbit.radius;

      return {
        mvpMatrix: new Float32Array(mvpMtx),
        viewMatrix: new Float32Array(viewMtx),
        modelMatrix: new Float32Array(modelMatrix),
        projectionMatrix: new Float32Array(projMtx),
        pointSize: basePointSize,
        sizeAttenuation,
        viewportHeight,
        viewportWidth,
        fov,
        near,
        far,
        lightingStrength,
        fogDensity,
        fogColor: new Float32Array(fogColor),
        bgColor: new Float32Array(bgColor),
        lightDir: new Float32Array(lightDir),
        cameraPosition: [invView[12], invView[13], invView[14]],
        cameraDistance,
        shaderQuality: currentShaderQuality
      };
    },

    // HP renderer controls
    setShaderQuality(quality) {
      hpRenderer.setQuality(quality);
      highlightTools.setQuality(quality);
      currentShaderQuality = quality;
    },
    setFrustumCulling(enabled) {
      hpRenderer.setFrustumCulling(
        assertExactBoolean(enabled, 'Frustum culling')
      );
    },
    setAdaptiveLOD(enabled) {
      hpRenderer.setAdaptiveLOD(
        assertExactBoolean(enabled, 'Adaptive LOD')
      );
    },
    setForceLOD(level) {
      hpRenderer.setForceLOD(
        assertIntegerInRange(level, -1, 17, 'Forced LOD level')
      );
    },
    hasRendererStats(viewId) {
      return hpRenderer.hasStats(assertKnownViewId(viewId));
    },
    getRendererStats(viewId) {
      return hpRenderer.getStats(assertKnownViewId(viewId));
    },
    debugRendererStatus() { return hpRenderer.debugStatus(); },

    // LOD visibility for edge filtering and highlight rendering
    // These now support per-view LOD tracking in multiview mode
    getLodVisibilityArray(viewId, dimensionLevel) {
      return hpRenderer.getLodVisibilityArray(
        assertKnownViewId(viewId),
        dimensionLevel
      );
    },
    getCurrentLODLevel(viewId) {
      return hpRenderer.getCurrentLODLevel(assertKnownViewId(viewId));
    },
    onLodChanged(listener) {
      const exactListener = assertExactFunction(
        listener,
        'LOD change listener'
      );
      lodChangeListeners.add(exactListener);
      for (const viewId of [
        LIVE_VIEW_ID,
        ...snapshotViews.map((snapshot) => snapshot.id)
      ]) {
        publishedLodLevels.set(
          viewId,
          hpRenderer.getCurrentLODLevel(viewId)
        );
      }
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        lodChangeListeners.delete(exactListener);
      };
    },
    // Combined LOD + alpha visibility (preferred for consumers that need filter-aware visibility)
    getCombinedVisibilityForView(viewId, alphaThreshold, dimensionLevel) {
      return hpRenderer.getCombinedVisibilityForView(
        assertKnownViewId(viewId),
        alphaThreshold,
        dimensionLevel
      );
    },

    start() {
      if (disposed) return;
      if (webglContextLost) {
        showWebglContextOverlay('WebGL context lost. Reload required to continue.');
        return;
      }
      if (renderPaused) return;
      if (animationHandle === null) {
        animationHandle = requestAnimationFrame(render);
      }
    },

    /**
     * Pause the render loop without disposing GPU resources.
     *
     * This is used for the Jupyter "freeze" UX: the view stays exactly as-is,
     * but interactions/network-driven updates are expected to stop.
     */
    pause() {
      renderPaused = true;
      if (animationHandle !== null) {
        cancelAnimationFrame(animationHandle);
        animationHandle = null;
      }
    },

    /**
     * Resume after `pause()`.
     */
    resume() {
      if (disposed) return;
      renderPaused = false;
      if (webglContextLost) {
        showWebglContextOverlay('WebGL context lost. Reload required to continue.');
        return;
      }
      if (animationHandle === null) {
        animationHandle = requestAnimationFrame(render);
      }
    },

    isPaused() {
      return renderPaused;
    },

    isDisposed() {
      return disposed;
    },

    isDisposalSettled() {
      return disposalSettled;
    },

    /**
     * Clean up all resources (event listeners, observers, WebGL resources).
     * Call this before recreating the viewer or when unmounting.
     */
	    dispose() {
	      if (disposalSettled) return;
	      const failures = [];
	      const normalizeFailure = (error, owner) => (
	        error instanceof Error
	          ? error
	          : new Error(`${owner} threw a non-Error value.`)
	      );
	      const attempt = (key, operation) => {
	        if (completedDisposalSteps.has(key)) return;
	        try {
	          operation();
	          completedDisposalSteps.add(key);
	        } catch (error) {
	          failures.push(normalizeFailure(error, key));
	        }
	      };

	      // Publish the terminal fence before any fallible observer or resource
	      // cleanup. A callback that survives cancellation can only return at
	      // the render guard and cannot reschedule or touch WebGL.
	      if (!disposed) {
	        disposed = true;
	        renderPaused = true;
	        const scheduledAnimationHandle = animationHandle;
	        animationHandle = null;
	        if (scheduledAnimationHandle !== null) {
	          try {
	            cancelAnimationFrame(scheduledAnimationHandle);
	          } catch (error) {
	            failures.push(
	              normalizeFailure(error, 'viewer animation cancellation')
	            );
	          }
	        }
	        // The overlay manager becomes the sole retry owner immediately.
	        vectorFieldOverlay = null;
	      }

	      attempt('projectile build cancellation', () => {
	        cancelPendingProjectileBuild(
	          'Projectile preparation was cancelled because the viewer was disposed.'
	        );
	      });
	      attempt('pointer-lock retirement', () => {
	        pointerLockRequestGeneration += 1;
	        pointerLockRequestPending = false;
	        pointerLockActive = false;
	        pointerLockEnabled = false;
	        lookActive = false;
	        pendingShot = false;
	        pendingShotViewportInfo = null;
	        const pointerFailures = [];
	        for (const operation of [
	          () => projectileSystem.cancelCharging(),
	          () => canvas.classList.remove('dragging', 'free-nav', 'planar-nav'),
	          () => {
	            canvas.style.cursor = '';
	          },
	          () => {
	            if (
	              document.pointerLockElement === canvas &&
	              typeof document.exitPointerLock === 'function'
	            ) {
	              const result = document.exitPointerLock();
	              if (result?.catch) {
	                result.catch((error) => {
	                  try {
	                    console.error(
	                      '[Viewer] Pointer-lock exit failed during disposal.',
	                      error
	                    );
	                  } catch {
	                    // Terminal state is already fenced.
	                  }
	                });
	              }
	            }
	          },
	          () => {
	            const handler = pointerLockChangeHandler;
	            pointerLockChangeHandler = null;
	            handler?.(false, null);
	          },
	        ]) {
	          try {
	            operation();
	          } catch (error) {
	            pointerFailures.push(error);
	          }
	        }
	        if (pointerFailures.length > 0) {
	          throw new AggregateError(
	            pointerFailures,
	            'Pointer-lock retirement was incomplete.'
	          );
	        }
	      });
	      attempt('projectile activity fence', () => {
	        projectileSystem.setEnabled(false);
	      });
	      attempt('event listener retirement', () => {
	        const callbacks = eventCleanupFns.splice(
	          0,
	          eventCleanupFns.length
	        );
	        const failedCallbacks = [];
	        const listenerFailures = [];
	        for (const cleanup of callbacks) {
	          try {
	            cleanup();
	          } catch (error) {
	            failedCallbacks.push(cleanup);
	            listenerFailures.push(error);
	          }
	        }
	        eventCleanupFns.push(...failedCallbacks);
	        if (listenerFailures.length > 0) {
	          throw new AggregateError(
	            listenerFailures,
	            'Viewer event-listener retirement was incomplete.'
	          );
	        }
	      });
	      attempt('resize observer retirement', () => {
	        canvasResizeObserver.disconnect();
	      });
	      attempt('context overlay retirement', () => {
	        if (webglContextOverlay?.parentNode) {
	          webglContextOverlay.parentNode.removeChild(
	            webglContextOverlay
	          );
	        }
	        webglContextOverlay = null;
	        webglContextOverlayMessage = null;
	      });
	      attempt('view-title retirement', () => {
	        const failedEntries = [];
	        const titleFailures = [];
	        for (const entry of viewTitleEntries) {
	          try {
	            entry.el?.remove();
	          } catch (error) {
	            failedEntries.push(entry);
	            titleFailures.push(error);
	          }
	        }
	        viewTitleEntries = failedEntries;
	        lastTitleKey = '';
	        if (titleFailures.length > 0) {
	          throw new AggregateError(
	            titleFailures,
	            'Viewer title-chip retirement was incomplete.'
	          );
	        }
	      });
	      attempt('centroid-label retirement', () => {
	        const labelFailures = [];
	        const ownedViewIds = new Set([
	          ...viewCentroidLabels.keys(),
	          ...pendingCentroidLabelRetirements.keys(),
	        ]);
	        for (const viewId of ownedViewIds) {
	          try {
	            removeLabelsForView(viewId);
	          } catch (error) {
	            labelFailures.push(error);
	          }
	        }
	        if (labelFailures.length > 0) {
	          throw new AggregateError(
	            labelFailures,
	            'Viewer centroid-label retirement was incomplete.'
	          );
	        }
	      });
	      attempt('overlay manager retirement', () => {
	        if (overlayManager !== null) {
	          overlayManager.dispose();
	          overlayManager = null;
	        }
	      });

	      attempt('projectile resource retirement', () => {
	        projectileSystem.dispose();
	      });
	      attempt('orbit-anchor retirement', () => {
	        orbitAnchorRenderer.dispose();
	      });
	      attempt('centroid snapshot retirement', () => {
	        const centroidFailures = [];
	        for (const viewId of Array.from(centroidSnapshotBuffers.keys())) {
	          try {
	            deleteCentroidSnapshotBuffer(viewId);
	          } catch (error) {
	            centroidFailures.push(error);
	          }
	        }
	        centroidFailures.push(
	          ...drainCentroidSnapshotRetirements()
	        );
	        if (centroidFailures.length > 0) {
	          throw new AggregateError(
	            centroidFailures,
	            'Viewer centroid snapshot retirement was incomplete.'
	          );
	        }
	      });

	      for (const key of Object.keys(gridPlaneBuffers)) {
	        attempt(`grid buffer ${key}`, () => {
	          const buffer = gridPlaneBuffers[key];
	          if (buffer !== null) {
	            gl.deleteBuffer(buffer);
	            gridPlaneBuffers[key] = null;
	          }
	        });
	      }
	      attempt('edge texture retirement', () => {
	        clearEdgeResourcesV2();
	      });
	      attempt('high-performance renderer retirement', () => {
	        hpRenderer.dispose();
	      });
	      attempt('highlight tools retirement', () => {
	        highlightTools?.dispose?.();
	        highlightTools = null;
	      });
	      attempt('smoke renderer retirement', () => {
	        smokeRenderer.dispose();
	      });

	      for (const [key, program] of [
	        ['line program', lineInstancedProgram],
	        ['grid program', gridProgram],
	        ['centroid program', centroidProgram],
	      ]) {
	        attempt(key, () => {
	          if (program) gl.deleteProgram(program);
	        });
	      }
	      attempt('centroid position buffer', () => {
	        if (centroidPositionBuffer) {
	          gl.deleteBuffer(centroidPositionBuffer);
	          centroidPositionBuffer = null;
	        }
	      });
	      attempt('centroid color buffer', () => {
	        if (centroidColorBuffer) {
	          gl.deleteBuffer(centroidColorBuffer);
	          centroidColorBuffer = null;
	        }
	      });
	      attempt('edge quad buffer', () => {
	        if (edgeQuadBuffer) gl.deleteBuffer(edgeQuadBuffer);
	      });
	      attempt('viewer cache retirement', () => {
	        cachedViewMatrices.clear();
	        renderParamsByView.clear();
	        overlayCtxByView.clear();
	        overlayCtxOptionsByView.clear();
	        viewDimensionLevels.clear();
	        viewPositionsCache.clear();
	        viewCentroidFlags.clear();
	        viewCentroidLabels.clear();
	        publishedLodLevels.clear();
	        lodChangeListeners.clear();
	        cachedGridProjections.clear();
	        activeKeys.clear();
	        _renderAllViews.length = 0;
	        _renderVelocityViewIds.length = 0;
	        snapshotViews.length = 0;
	        positionsArray = null;
	        colorsArray = null;
	        transparencyArray = null;
	        pointCount = 0;
	        centroidCount = 0;
	        navigationModeOwnership.clear();
	        viewFocusHandler = null;
	        navigationModeChangeHandler = null;
	        smokeRenderFailureHandler = null;
	        velocityRenderFailureHandler = null;
	        if (labelLayer) labelLayer.style.display = 'none';
	        if (viewTitleLayerEl) {
	          viewTitleLayerEl.style.display = 'none';
	        }
	      });

	      if (failures.length > 0) {
	        throw new AggregateError(
	          failures,
	          `Viewer disposal remains pending for ${failures.length} owner(s).`
	        );
	      }
	      pendingSnapshotCleanupIds.clear();
	      disposalSettled = true;
    }
  };

  // Disposal is a terminal lifecycle boundary. Keep only the explicit
  // diagnostics, retryable disposal, and inert loop controls callable after
  // the first disposal attempt. Guarding the returned methods here prevents a
  // stale callback from reaching any GPU/DOM owner, including owners whose
  // first retirement attempt failed. The wrapper identities are created once
  // and remain stable for the lifetime of this API object.
  for (const [methodName, method] of Object.entries(publicApi)) {
    if (TERMINAL_SAFE_VIEWER_METHODS.has(methodName)) continue;
    publicApi[methodName] = function guardedViewerMethod(...args) {
      if (disposed) {
        throw createViewerDisposedError(methodName);
      }
      return Reflect.apply(method, publicApi, args);
    };
  }

  return publicApi;
}
