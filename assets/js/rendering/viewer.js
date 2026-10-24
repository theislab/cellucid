/**
 * WebGL2 Viewer with High-Performance Renderer
 * =============================================
 * Uses HighPerfRenderer for scatter points with WebGL2 only.
 * Keeps smoke, grid, studio backdrop, and line rendering.
 */

import { GRID_VS_SOURCE, GRID_FS_SOURCE } from './shaders/edge-grid-shaders.js';
import { createConnectivityEdgeLayer } from './connectivity-edge-layer.js';
import {
  drainAfterFramePhase,
  drainBeforeFramePhase,
  setFramePhaseDriver,
} from './frame-phases.js';
import {
  configureStraightAlphaBlending,
  createProgram,
  createProgramBatch,
  createCanvasResizeObserver,
  deleteProgramReleasingUse
} from './gl-utils.js';
import { CENTROID_VS, CENTROID_FS } from './shaders/centroid-shaders.js';
import { STUDIO_VS_SOURCE, STUDIO_FS_SOURCE } from './shaders/studio-shaders.js';
import {
  STUDIO_PALETTES,
  STUDIO_STAGE,
  STUDIO_SURFACE_TRANSITION_SECONDS,
  resolveStudioBackdropPlane,
  resolveStudioPaneGeometry,
  resolveStudioPool,
  resolveStudioSurfaceWeights,
  studioColor01,
  studioSurfacePlanarity
} from './studio-backdrop.js';
import { createBackdropLookRenderer } from './backdrops/backdrop-look-renderer.js';
import { backdropLookSurface01, isBackdropLook } from './backdrops/backdrop-looks.js';
import { SmokeRenderer } from './smoke-cloud/smoke-renderer.js';
import { HighPerfRenderer } from './high-perf-renderer.js';
import { isContextLostError, requireCleanWebGLState, requireLiveContext } from './gl-errors.js';
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
import { POINT_VISIBILITY_THRESHOLD } from './alpha-visibility.js';
import { createSceneMsaaTarget } from './scene-msaa-target.js';
import {
  MAXIMUM_POINT_SIZE,
  MINIMUM_POINT_SIZE,
} from './point-size-scale.js';
import { applyHorizontalProjectionCenter } from './viewport-center.js';
import { findScreenSpacePick } from './picking.js';
import {
  DEFAULT_SHADER_QUALITY,
  SHADER_QUALITY_TRAITS,
} from './shader-quality.js';
import {
  readPositionBounds,
  readPositionXYZ,
  requirePositionArray
} from './position-layout.js';
import { createDefaultCameraPose } from './camera-state-contract.js';
import {
  PresentedCameraSettlementTracker
} from './presented-camera-settlement.js';
import {
  createViewerContextLostError,
  createViewerDisposedError,
  createViewerRendererFacade
} from './viewer/renderer-facade.js';
import {
  VALID_DIMENSION_LEVELS,
  assertCentroidLabelEntries,
  assertCentroidPayload,
  assertExactBoolean,
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
  getDefaultNavigationMode
} from './viewer/viewer-contracts.js';
import {
  getPresentedPane,
  getPresentedPaneAtCssPoint,
  resolvePresentedLayout,
  runSynchronousBorrowedViewDataCallback,
  selectPresentedCameraState
} from './viewer/presented-view-layout.js';

const INITIAL_DIMENSION_LEVEL = 3;
const VELOCITY_OVERLAY_ID = 'velocity';
let nextWebglContextOverlayIdentity = 1;
// Below this size, one direct interaction scan is cheaper than retaining a
// tree. Large clicked panes build exactly one notified tree lazily so picking,
// lasso previews, and proximity previews never rescan 10–30M points per move.
const INTERACTIVE_SPATIAL_INDEX_POINT_THRESHOLD = 250_000;
// A frame is drawn only when something on screen can have changed: a public
// API mutation, viewer input, a canvas resize, or a time-driven animation.
// Drawing continues after the last such cause until FRAME_SETTLE_MIN_FRAMES
// frames have been drawn, and then stops. Every multi-frame convergence is a
// named cause of its own (camera settlement, LOD hysteresis, fades, smoke),
// so the floor only has to cover the frame that shows a change. There is no
// wall-clock window on top: it kept a fast display drawing 60–120 identical
// frames after every change, and a slow renderer never reached its second
// frame inside it anyway.
const FRAME_SETTLE_MIN_FRAMES = 2;
// The raw GL getter and guarded renderer facade remain available so cleanup
// diagnostics can inspect exact owners. Renderer methods and property writes
// are actively fenced at either terminal boundary; the raw GL object is
// read-only by contract once the viewer is terminal.
/**
 * Public methods that only read state. Every other public call can change what
 * is drawn, so it marks the next frame for drawing.
 *
 * `pick…` looks a cell up under a screen point; hover readers call it on every
 * pointer frame, and treating it as a mutation redrew the whole scene for a
 * full settle window after each lookup. `prepareCellPicking` builds, in a
 * worker, the index those lookups read, which changes nothing on screen.
 */
const FRAME_NEUTRAL_VIEWER_METHODS = new Set(['prepareCellPicking']);

function isFrameReaderMethodName(methodName) {
  return /^(get|has|is|pick)[A-Z]/.test(methodName)
    || FRAME_NEUTRAL_VIEWER_METHODS.has(methodName);
}

/**
 * Public setters that invalidate the frame themselves, and only when they
 * change something drawn.
 *
 * The app re-publishes every view's label on each field activation and filter
 * change (`_pushActiveViewLabelToViewer`, `_refreshInactiveViewLabels`), and
 * almost every one of those pushes carries the label the view already shows.
 * Under the blanket rule each push redrew the whole scene for a settle window,
 * which is a full GPU pass per frame for nothing and, on a renderer that takes
 * seconds per frame, tens of seconds of drawing after a click. A lasso,
 * proximity or KNN preview likewise republishes the highlight on every
 * pointer move, mostly with the cells it already shows.
 */
const SELF_INVALIDATING_VIEWER_METHODS = new Set([
  'setLiveViewLabel',
  'updateHighlight',
  'updateSnapshotAttributes'
]);

const TERMINAL_SAFE_VIEWER_METHODS = new Set([
  'dispose',
  'getGLContext',
  'getAntialiasing',
  'getHPRenderer',
  'getAntialiasingSampleCount',
  'isAntialiasingAvailable',
  'isContextLost',
  'isDisposed',
  'isDisposalSettled',
  'isPaused',
  'isWebGL2',
  'pause',
  'resume',
  'start'
]);

export { assertNavigationMode } from './camera-state-contract.js';

export {
  createViewerRendererFacade
} from './viewer/renderer-facade.js';

export {
  getDefaultNavigationMode
} from './viewer/viewer-contracts.js';

export {
  getPresentedGridColumns,
  getPresentedPane,
  getPresentedPaneAtCssPoint,
  resolvePresentedLayout,
  runSynchronousBorrowedViewDataCallback,
  selectPresentedCameraState
} from './viewer/presented-view-layout.js';

/**
 * Release dataset-sized owners held by a stable per-frame render descriptor.
 *
 * The descriptor identity stays stable so the render loop can reuse it without
 * allocation, while terminal viewer disposal no longer keeps live typed arrays
 * or camera state reachable through the closed-over record.
 *
 * @param {Object} record
 * @returns {Object} the same retired record
 */
export function retireRenderViewRecord(record) {
  if (record === null || typeof record !== 'object') {
    throw new TypeError(
      'Viewer render-record retirement requires an exact record.'
    );
  }
  record.label = '';
  record.colors = null;
  record.transparency = null;
  record.centroidPositions = null;
  record.centroidColors = null;
  record.centroidTransparencies = null;
  record.centroidCount = 0;
  record.cameraState = null;
  return record;
}

/**
 * Certify that one centroid VAO was built from the exact immutable snapshot
 * owners currently published by a view. Identity is the publication boundary:
 * it is complete, O(1), and detects color-only replacement without sampling
 * dataset values or allocating a per-frame fingerprint.
 */
export function centroidSnapshotBufferOwnsData(
  record,
  positions,
  colors
) {
  return (
    record !== null &&
    record !== undefined &&
    record.positionsOwner === positions &&
    record.colorsOwner === colors &&
    record.count === positions.length / 3 &&
    colors.length === record.count * 4
  );
}

function requireViewerLodMembership(membership, pointCount) {
  if (membership === null) return null;
  if (
    typeof membership !== 'object' ||
    Array.isArray(membership) ||
    !Object.isFrozen(membership) ||
    !(membership.admissionLevels instanceof Uint8Array) ||
    membership.admissionLevels.length !== pointCount ||
    !(membership.indices instanceof Uint32Array) ||
    membership.indices.length > pointCount ||
    membership.pointCount !== pointCount ||
    !VALID_DIMENSION_LEVELS.has(membership.dimensionLevel) ||
    !Number.isInteger(membership.lodLevel) ||
    membership.lodLevel < 0 ||
    membership.lodLevel >= 0xff ||
    membership.generationToken === null ||
    typeof membership.generationToken !== 'object' ||
    !Object.isFrozen(membership.generationToken)
  ) {
    throw new TypeError(
      'Viewer LOD membership must be null or one exact frozen renderer descriptor.'
    );
  }
  return membership;
}

function requireViewerSequentialLodMembership(membership, pointCount) {
  if (membership === null) return null;
  const exactKeys = [
    'dimensionLevel',
    'generationToken',
    'indices',
    'lodLevel',
    'pointCount',
  ];
  const ownKeys =
    typeof membership === 'object' && membership !== null
      ? Reflect.ownKeys(membership)
      : [];
  if (
    typeof membership !== 'object' ||
    Array.isArray(membership) ||
    Object.getPrototypeOf(membership) !== Object.prototype ||
    !Object.isFrozen(membership) ||
    ownKeys.length !== exactKeys.length ||
    ownKeys.some((key) => (
      typeof key !== 'string' || !exactKeys.includes(key)
    )) ||
    !(membership.indices instanceof Uint32Array) ||
    membership.indices.length > pointCount ||
    membership.pointCount !== pointCount ||
    !VALID_DIMENSION_LEVELS.has(membership.dimensionLevel) ||
    !Number.isInteger(membership.lodLevel) ||
    membership.lodLevel < 0 ||
    membership.lodLevel >= 0xff ||
    membership.generationToken === null ||
    typeof membership.generationToken !== 'object' ||
    !Object.isFrozen(membership.generationToken)
  ) {
    throw new TypeError(
      'Viewer sequential LOD membership must be null or one exact frozen compact descriptor.'
    );
  }
  return membership;
}

function createLodFilteredVisibilityOwner(
  transparency,
  membership
) {
  if (
    !(transparency instanceof Uint8Array) ||
    transparency.length === 0
  ) {
    throw new TypeError(
      'LOD-filtered connectivity requires one non-empty Uint8 transparency array.'
    );
  }
  const exactMembership = requireViewerLodMembership(
    membership,
    transparency.length
  );
  return Object.freeze({
    admissionLevels:
      exactMembership?.admissionLevels ?? null,
    lodLevel: exactMembership?.lodLevel ?? -1,
    transparency,
  });
}


/**
 * The navigation modes the user chose, per view and per dimension.
 *
 * Every view navigates by its own dimension: a 3D view orbits, a 1D or 2D view
 * pans (see `getDefaultNavigationMode`). A choice is recorded only when it
 * differs from that default, for the dimension the view showed when it was
 * made: a view the user set to free-fly in 3D flies again whenever it shows a
 * 3D representation, and pans whenever it shows a 2D one. Publishing a
 * dimension's own default -- a dataset's opening state, Reset Camera, a
 * session -- is not a choice and releases it. This state changes only on
 * UI/session events and is never read by the render loop.
 */
export function createNavigationModeOwnership() {
  const choices = new Map();

  return Object.freeze({
    record(viewId, dimension, mode) {
      assertNavigationMode(mode);
      getDefaultNavigationMode(dimension);
      const exactViewId = assertViewId(viewId);
      if (!choices.has(exactViewId)) choices.set(exactViewId, new Map());
      choices.get(exactViewId).set(dimension, mode);
    },
    release(viewId, dimension) {
      getDefaultNavigationMode(dimension);
      choices.get(assertViewId(viewId))?.delete(dimension);
    },
    choiceFor(viewId, dimension) {
      getDefaultNavigationMode(dimension);
      return choices.get(assertViewId(viewId))?.get(dimension) ?? null;
    },
    copyView(sourceViewId, targetViewId) {
      const source = choices.get(assertViewId(sourceViewId));
      const target = assertViewId(targetViewId);
      if (source === undefined) {
        choices.delete(target);
      } else {
        choices.set(target, new Map(source));
      }
    },
    deleteView(viewId) {
      choices.delete(assertViewId(viewId));
    },
    clear() {
      choices.clear();
    }
  });
}

export function createViewer({
  canvas,
  labelLayer,
  viewTitleLayer,
  onViewFocus
}) {
  // The drawing buffer is deliberately single-sampled. `antialias` as a
  // context-creation attribute is fixed for the life of the context, and
  // Cellucid has no path to a second one, which made antialiasing the only
  // render setting that could not take effect until the page was reloaded — and
  // it is the setting whose right answer depends on the dataset. Multisampling
  // is provided instead by `rendering/scene-msaa-target.js`, which the app owns
  // and can switch per frame.
  // Every current rendering path requires WebGL2.
  // The drawing buffer is preserved because frames are drawn only when the
  // scene changes; a reader of the canvas between drawn frames still sees the
  // last one instead of a cleared buffer.
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true
  });

  if (!gl) {
    throw new Error('WebGL2 is required but not supported in this browser.');
  }

  // Starts off, with nothing allocated. `render-controls.js` is the one owner of
  // the preference and publishes it before `start()` draws the first frame, so
  // there is no value to duplicate here and no frame drawn with the wrong one.
  const sceneMsaaTarget = createSceneMsaaTarget(gl);

  console.log('[Viewer] Using WebGL2');

  // ResizeObserver-based canvas sizing to avoid per-frame layout reads
  // A canvas that changes size needs a frame at its new size.
  const canvasResizeObserver = createCanvasResizeObserver(canvas, () => ensureFrameScheduled());

  const mat4 = glMatrix.mat4;
  const vec3 = glMatrix.vec3;
  const vec4 = glMatrix.vec4;

  // === HIGH-PERFORMANCE RENDERER FOR SCATTER POINTS ===
  const hpRenderer = new HighPerfRenderer(gl, {
    USE_LOD: false,
    USE_FRUSTUM_CULLING: false
  });
  // Terminal cleanup is an internal lifecycle capability, not a replaceable
  // facade extension point. Capture the exact implementation before callers
  // can legitimately customize other preterminal renderer methods.
  const handleHpRendererContextLost =
    hpRenderer.handleContextLost.bind(hpRenderer);
  const disposeHpRenderer =
    hpRenderer.dispose.bind(hpRenderer);
  // A tree built off the main thread has landed: draw, so its view adopts it.
  hpRenderer.onAsyncTreeReady = () => invalidateFrame();
  console.log('[Viewer] HighPerfRenderer initialized');

  // === ORBIT ANCHOR RENDERER ===
  // Per-view compass visualization with proper elevation indicator and cardinal markers
  const orbitAnchorRenderer = new OrbitAnchorRenderer(gl, canvas);
  console.log('[Viewer] OrbitAnchorRenderer initialized');

  // === SMOKE RENDERER ===
  const smokeRenderer = new SmokeRenderer(gl, createProgram);
  console.log('[Viewer] SmokeRenderer initialized');

  // The grid, studio backdrop and centroid programs, compiled and linked in
  // one batch (`createProgramBatch`): one wait instead of three.
  const [initialGridProgram, initialStudioProgram, initialCentroidProgram] =
    createProgramBatch(gl, [
      { label: 'grid', vs: GRID_VS_SOURCE, fs: GRID_FS_SOURCE },
      { label: 'studio backdrop', vs: STUDIO_VS_SOURCE, fs: STUDIO_FS_SOURCE },
      { label: 'centroid', vs: CENTROID_VS, fs: CENTROID_FS },
    ]);

  // === GRID PROGRAM ===
  let gridProgram = initialGridProgram;
  const gridAttribLocations = {
    position: gl.getAttribLocation(gridProgram, 'a_position'),
  };
  const gridUniformLocations = {
    mvpMatrix:    gl.getUniformLocation(gridProgram, 'u_mvpMatrix'),
    modelMatrix:  gl.getUniformLocation(gridProgram, 'u_modelMatrix'),
    gridColor:    gl.getUniformLocation(gridProgram, 'u_gridColor'),
    bgColor:      gl.getUniformLocation(gridProgram, 'u_bgColor'),
    gridSpacing:  gl.getUniformLocation(gridProgram, 'u_gridSpacing'),
    gridLineWidth: gl.getUniformLocation(gridProgram, 'u_gridLineWidth'),
    gridOpacity:  gl.getUniformLocation(gridProgram, 'u_gridOpacity'),
    planeAlpha:   gl.getUniformLocation(gridProgram, 'u_planeAlpha'),
    planeType:    gl.getUniformLocation(gridProgram, 'u_planeType'),
    axisXColor:   gl.getUniformLocation(gridProgram, 'u_axisXColor'),
    axisYColor:   gl.getUniformLocation(gridProgram, 'u_axisYColor'),
    axisZColor:   gl.getUniformLocation(gridProgram, 'u_axisZColor'),
    gridSize:     gl.getUniformLocation(gridProgram, 'u_gridSize'),
  };

  // === STUDIO BACKDROP PROGRAM ===
  // One full-pane triangle in its own vertex array, so the draw neither reads
  // nor disturbs the attribute state another pass left on the default one.
  let studioProgram = initialStudioProgram;
  let studioVao = gl.createVertexArray();
  let studioCornerBuffer = gl.createBuffer();
  gl.bindVertexArray(studioVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, studioCornerBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  const studioUniformLocations = {
    invMvpMatrix:     gl.getUniformLocation(studioProgram, 'u_invMvpMatrix'),
    eye:              gl.getUniformLocation(studioProgram, 'u_eye'),
    pixelRatio:       gl.getUniformLocation(studioProgram, 'u_pixelRatio'),
    surfaceColor:     gl.getUniformLocation(studioProgram, 'u_surfaceColor'),
    glowColor:        gl.getUniformLocation(studioProgram, 'u_glowColor'),
    glowCenterX:      gl.getUniformLocation(studioProgram, 'u_glowCenterX'),
    inkColor:         gl.getUniformLocation(studioProgram, 'u_inkColor'),
    lineMinorAlpha:   gl.getUniformLocation(studioProgram, 'u_lineMinorAlpha'),
    lineMajorAlpha:   gl.getUniformLocation(studioProgram, 'u_lineMajorAlpha'),
    dotMinorAlpha:    gl.getUniformLocation(studioProgram, 'u_dotMinorAlpha'),
    dotMajorAlpha:    gl.getUniformLocation(studioProgram, 'u_dotMajorAlpha'),
    opacity:          gl.getUniformLocation(studioProgram, 'u_opacity'),
    floorWeight:      gl.getUniformLocation(studioProgram, 'u_floorWeight'),
    floorY:           gl.getUniformLocation(studioProgram, 'u_floorY'),
    stageCenter:      gl.getUniformLocation(studioProgram, 'u_stageCenter'),
    backdropWeight:   gl.getUniformLocation(studioProgram, 'u_backdropWeight'),
    backNormal:       gl.getUniformLocation(studioProgram, 'u_backNormal'),
    backOffset:       gl.getUniformLocation(studioProgram, 'u_backOffset'),
    backU:            gl.getUniformLocation(studioProgram, 'u_backU'),
    backV:            gl.getUniformLocation(studioProgram, 'u_backV'),
    poolCenter:       gl.getUniformLocation(studioProgram, 'u_poolCenter'),
    poolInverse:      gl.getUniformLocation(studioProgram, 'u_poolInverse'),
    poolStrength:     gl.getUniformLocation(studioProgram, 'u_poolStrength'),
  };

  // === BACKDROP LOOKS ===
  // Baked procedural backgrounds; see rendering/backdrops/. Bakes run in idle
  // slices outside the frame and wake the viewer once when they land.
  const backdropLooks = createBackdropLookRenderer(gl, {
    invalidate: () => invalidateFrame(),
    prefersReducedMotion: () => prefersReducedMotion(),
    readViewSource: (viewId) => {
      const record = viewPositionsCache.get(viewId);
      if (!(record?.positions instanceof Float32Array)) return null;
      let colors = null;
      let visibility = null;
      let generation = 0;
      try { colors = getExactViewColors(viewId); } catch { colors = null; }
      try { visibility = getExactViewTransparency(viewId); } catch { visibility = null; }
      try { generation = getViewDataGeneration(viewId); } catch { generation = 0; }
      return { positions: record.positions, dimension: record.dimension, colors, visibility, generation };
    },
  });

  // === CENTROID PROGRAM (simple WebGL2 shader for small centroid count) ===
  let centroidProgram = initialCentroidProgram;
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
  let currentShaderQuality = DEFAULT_SHADER_QUALITY;

  // === OVERLAYS (opt-in render passes, e.g. vector field particles) ===
  let overlayManager = null;
  let vectorFieldOverlay = null;

  function ensureOverlayManager() {
    if (overlayManager) return overlayManager;
    overlayManager = new OverlayManager(gl);
    return overlayManager;
  }

  function reportHighlightRenderFailure(value, viewId) {
    const exactError = value instanceof Error
      ? value
      : new Error('Highlight rendering failed with a non-Error value.');
    if (highlightRenderFailureHandler === null) {
      // Highlight publication is fenced by its exact semantic generation. A
      // diagnostic here is therefore report-once without terminating the RAF
      // loop or preventing the remaining panes/passes from rendering.
      try {
        console.error(
          `[Viewer] Highlight rendering failed for view "${viewId}".`,
          exactError
        );
      } catch {
        // Diagnostics are observational and must not become a render failure.
      }
      return;
    }
    try {
      highlightRenderFailureHandler(exactError, viewId);
    } catch (observerError) {
      queueMicrotask(() => {
        throw observerError;
      });
    }
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
    candidate.setPositionRetention(positions => hpRenderer.holdsGeometryFor(positions));
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
  // The live centroid pass owns its vertex array, so its attribute state never
  // lands on whichever vertex array another pass left bound.
  let centroidVao = gl.createVertexArray();
  if (!centroidPositionBuffer || !centroidColorBuffer || !centroidVao) {
    if (centroidPositionBuffer) gl.deleteBuffer(centroidPositionBuffer);
    if (centroidColorBuffer) gl.deleteBuffer(centroidColorBuffer);
    if (centroidVao) gl.deleteVertexArray(centroidVao);
    throw new Error(
      'Viewer could not allocate the required centroid buffers.'
    );
  }

  // === CONNECTIVITY EDGES ===
  // The graph, each pane's shown edges and their GPU records
  // (connectivity-edge-layer.js). The layer reads a pane's positions from the
  // renderer at draw time, so a representation switch needs no call here.
  const edgeLayer = createConnectivityEdgeLayer({
    gl,
    getViewGeometry: viewId => getCertifiedEdgeGeometry(viewId),
    retainsPositions: positions => hpRenderer.holdsGeometryFor(positions),
    onVisibleCount: (viewId, stats) => {
      for (const listener of edgeVisibleCountListeners) {
        try {
          listener(viewId, stats);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    },
  });
  const edgeVisibleCountListeners = new Set();
  let useInstancedEdges = false; // Whether published edges are drawn
  // Scratch for the per-draw model-view product the edge shader reads.
  const edgeModelViewMatrix = mat4.create();
  const edgeFrame = {
    mvpMatrix: null,
    modelViewMatrix: edgeModelViewMatrix,
    widthPx: 0,
    heightPx: 0,
    lineWidth: 1,
    lineColor: new Float32Array(3),
    lineAlpha: 1,
    fogDensity: 0,
    fogNear: 0,
    fogFar: 0,
  };

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
  const gridPlaneDescriptors = Object.freeze([
    Object.freeze({
      bufferKey: 'bottom',
      normalX: 0,
      normalY: -1,
      normalZ: 0,
      type: 1,
    }),
    Object.freeze({
      bufferKey: 'top',
      normalX: 0,
      normalY: 1,
      normalZ: 0,
      type: 1,
    }),
    Object.freeze({
      bufferKey: 'back',
      normalX: 0,
      normalY: 0,
      normalZ: -1,
      type: 0,
    }),
    Object.freeze({
      bufferKey: 'front',
      normalX: 0,
      normalY: 0,
      normalZ: 1,
      type: 0,
    }),
    Object.freeze({
      bufferKey: 'left',
      normalX: -1,
      normalY: 0,
      normalZ: 0,
      type: 2,
    }),
    Object.freeze({
      bufferKey: 'right',
      normalX: 1,
      normalY: 0,
      normalZ: 0,
      type: 2,
    }),
  ]);

  // === GL State ===
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  configureStraightAlphaBlending(gl);

  // === Scene Variables ===
  let pointCount = 0;
  let centroidCount = 0;
  // Bytes the live centroid buffers hold: a publication that fits is written
  // in place, with no allocation and so no error read (a GPU round trip).
  let centroidPositionCapacity = 0;
  let centroidColorCapacity = 0;
  let defaultShowCentroidPoints = false;
  let defaultShowCentroidLabels = false;
  const viewCentroidFlags = new Map();
  const viewCentroidLabels = new Map();
  const hiddenCentroidLabelViews = new Set();
  const EMPTY_CENTROID_LABELS = Object.freeze([]);
  const centroidLabelOwners = new WeakMap();
  const centroidLabelPresentation = new WeakMap();
  const pendingCentroidLabelRetirements = new Map();

  // Small-multiples / snapshot views
  const LIVE_VIEW_ID = 'live';
  // The views drawn this frame, rewritten in place (hpRenderer.setPresentedViews).
  const _presentedViewIdsScratch = [];
  let snapshotViews = [];
  const snapshotViewsById = new Map();
  const certifiedCameraStateOwners = new WeakSet();
  const pendingSnapshotCleanupIds = new Set();
  let nextSnapshotId = 1;
  let viewLayoutMode = 'grid';
  let focusedViewId = LIVE_VIEW_ID;
  let liveViewLabel = 'View 1';
  let liveViewHidden = false; // Whether to hide live view from grid
  let viewFocusHandler = typeof onViewFocus === 'function' ? onViewFocus : null;
  let navigationModeChangeHandler = null;
  let highlightRenderFailureHandler = null;
  let smokeRenderFailureHandler = null;
  // Told whenever the live view's positions or colours are republished: a
  // built smoke volume is a function of both, so its owner must rebuild it.
  let smokeSourceChangeHandler = null;
  function publishSmokeSourceChange() {
    if (smokeSourceChangeHandler === null) return;
    try {
      smokeSourceChangeHandler();
    } catch (observerError) {
      queueMicrotask(() => {
        throw observerError;
      });
    }
  }
  let velocityRenderFailureHandler = null;

  function assertKnownViewId(viewId) {
    const exactViewId = assertViewId(viewId);
    if (
      exactViewId !== LIVE_VIEW_ID &&
      !snapshotViewsById.has(exactViewId)
    ) {
      throw new RangeError(`Unknown renderer view "${exactViewId}".`);
    }
    return exactViewId;
  }

  function certifyCameraStateOwner(cameraState, boundary) {
    if (
      cameraState === null ||
      (typeof cameraState !== 'object' &&
        typeof cameraState !== 'function')
    ) {
      return assertCameraState(cameraState, boundary);
    }
    if (!certifiedCameraStateOwners.has(cameraState)) {
      assertCameraState(cameraState, boundary);
      certifiedCameraStateOwners.add(cameraState);
    }
    return cameraState;
  }

  // Every view owns a camera state, navigation mode included. The focused
  // view is drawn from the global camera scalars; with linked cameras, so is
  // every other view that shows the same representation (layout) as the
  // focused one. Views of another representation keep their own cameras even
  // while linked: one camera cannot serve a 3D view and a 2D view, or two
  // embeddings with different geometry. `cameraFollowers` is that set, kept
  // current on every focus, link, layout and inventory change, so the render
  // loop reads one Set per pane.
  let camerasLocked = true;           // "Link cameras": link views of one representation
  let liveCameraState = null;         // The live view's stored camera
  let cameraFollowers = new Set([LIVE_VIEW_ID]);

  // Cached view matrices for unlocked camera mode (avoids per-frame recalculation)
  const cachedViewMatrices = new Map();  // viewId -> { viewMatrix: Float32Array, radius: number, dirty: boolean }
  // Presented layout (see getPresentedLayout): the resolved panes, the
  // inputs they were resolved from, and one projection matrix per pane.
  let presentedLayout = null;
  const presentedLayoutKey = {
    width: 0,
    height: 0,
    cssWidth: 0,
    cssHeight: 0,
    leftOcclusionRatio: 0,
    mode: null,
    focusedViewId: null,
    liveViewHidden: false,
    snapshotIds: []
  };
  const presentedPaneProjections = [];
  const presentedLayoutListeners = new Set();

	  // Per-view dimension tracking for multi-dimensional support
	  const viewDimensionLevels = new Map([
	    [LIVE_VIEW_ID, INITIAL_DIMENSION_LEVEL]
	  ]);  // viewId -> exact published dimension level
	  // viewId -> layout key of the embedding the view's positions belong to
	  // (null while the view shows no dataset). The layout, not the dimension,
	  // is the identity of a view's geometry: per-view LOD, picking and vector
	  // state is invalidated whenever it changes.
	  const viewLayoutKeys = new Map([
	    [LIVE_VIEW_ID, null]
	  ]);
	  // viewId -> { positions, dimension }: each view's published positions and
	  // their components per point (rendering/position-layout.js).
	  const viewPositionsCache = new Map();
	  // Per-view render params (avoid per-frame allocations in multiview render loop)
	  const renderParamsByView = new Map();   // viewId -> mutable params object passed to HighPerfRenderer
	  // viewId -> the studio backdrop's per-view record: the geometry resolved
	  // from the positions it was derived from, and the surface crossfade.
	  const studioPaneStates = new Map();
	  // Per-view overlay contexts + stable builder options (avoid per-frame allocations/closures)
	  const overlayCtxByView = new Map();     // viewId -> OverlayContext
	  const overlayCtxOptionsByView = new Map(); // viewId -> stable buildOverlayContext options object
	  const lodChangeListeners = new Set();
	  const publishedLodCertificates = new Map();
	  const presentedViewStateListeners = new Set();
	  let presentedViewStateGeneration = 0;
	  const presentedCameraSettlement =
	    new PresentedCameraSettlementTracker();
	  const presentedFrameState = {
	    initialized: false,
	    canvasHeight: 0,
	    canvasWidth: 0,
	    navigationMode: null,
	    radius: 0,
	    theta: 0,
	    phi: 0,
	    targetX: 0,
	    targetY: 0,
	    targetZ: 0,
	    freeflyX: 0,
	    freeflyY: 0,
	    freeflyZ: 0,
	    freeflyYaw: 0,
	    freeflyPitch: 0
	  };
	  // Point attribute updates can legally reuse the same Uint8/Float32 owner.
	  // One explicit publication generation therefore complements reference
	  // and renderer geometry checks at synchronous borrowed-data boundaries.
	  const viewDataGenerations = new Map();
	  let nextViewDataGeneration = 1;
	  const presentedLodGenerationIds = new WeakMap();
	  let nextPresentedLodGenerationId = 1;

	  function reportPresentedObserverFailures(failures) {
	    if (failures.length === 0) return;
	    const diagnostic = failures.length === 1
	      ? failures[0]
	      : new AggregateError(
	          failures,
	          'Multiple presented-state observers failed.'
	        );
	    queueMicrotask(() => {
	      try {
	        console.error(
	          '[Viewer] Presented-state observer failed.',
	          diagnostic
	        );
	      } catch {
	        // Diagnostics cannot invalidate a presented-state publication.
	      }
	    });
	  }

	  function publishPresentedViewStateChange(
	    reason,
	    viewId = focusedViewId,
	    resetFrameBaseline = true
	  ) {
	    if (
	      typeof reason !== 'string' ||
	      reason.length === 0 ||
	      reason.trim() !== reason
	    ) {
	      throw new TypeError(
	        'Presented-state change reason must be a non-empty trimmed string.'
	      );
	    }
	    const exactViewId = assertViewId(viewId);
	    if (typeof resetFrameBaseline !== 'boolean') {
	      throw new TypeError(
	        'Presented-state frame-baseline reset must be an exact boolean.'
	      );
	    }
	    // Any explicit semantic publication becomes the new frame baseline;
	    // camera tracking will initialize from it instead of delivering a
	    // duplicate trailing event for the same change.
	    if (resetFrameBaseline) {
	      presentedFrameState.initialized = false;
	      presentedCameraSettlement.reset();
	    }
	    if (presentedViewStateListeners.size === 0) return;
	    presentedViewStateGeneration =
	      presentedViewStateGeneration === Number.MAX_SAFE_INTEGER
	        ? 1
	        : presentedViewStateGeneration + 1;
	    const event = Object.freeze({
	      generation: presentedViewStateGeneration,
	      reason,
	      viewId: exactViewId
	    });
	    const failures = [];
	    for (const listener of presentedViewStateListeners) {
	      try {
	        listener(event);
	      } catch (error) {
	        failures.push(
	          error instanceof Error
	            ? error
	            : new Error(
	                'Presented-state observer threw a non-Error value.'
	              )
	        );
	      }
	    }
	    reportPresentedObserverFailures(failures);
	  }

	  function trackPresentedFrameState(now, canvasWidth, canvasHeight) {
	    if (presentedViewStateListeners.size === 0) {
	      presentedFrameState.initialized = false;
	      presentedCameraSettlement.reset();
	      return;
	    }
	    const state = presentedFrameState;
	    const changed = (
	      !state.initialized ||
	      state.canvasWidth !== canvasWidth ||
	      state.canvasHeight !== canvasHeight ||
	      state.navigationMode !== navigationMode ||
	      state.radius !== radius ||
	      state.theta !== theta ||
	      state.phi !== phi ||
	      state.targetX !== target[0] ||
	      state.targetY !== target[1] ||
	      state.targetZ !== target[2] ||
	      state.freeflyX !== freeflyPosition[0] ||
	      state.freeflyY !== freeflyPosition[1] ||
	      state.freeflyZ !== freeflyPosition[2] ||
	      state.freeflyYaw !== freeflyYaw ||
	      state.freeflyPitch !== freeflyPitch
	    );
	    if (changed) {
	      const wasInitialized = state.initialized;
	      state.initialized = true;
	      state.canvasWidth = canvasWidth;
	      state.canvasHeight = canvasHeight;
	      state.navigationMode = navigationMode;
	      state.radius = radius;
	      state.theta = theta;
	      state.phi = phi;
	      state.targetX = target[0];
	      state.targetY = target[1];
	      state.targetZ = target[2];
	      state.freeflyX = freeflyPosition[0];
	      state.freeflyY = freeflyPosition[1];
	      state.freeflyZ = freeflyPosition[2];
	      state.freeflyYaw = freeflyYaw;
	      state.freeflyPitch = freeflyPitch;
	      const transition = presentedCameraSettlement.observeFrame(
	        true,
	        now,
	        wasInitialized
	      );
	      if (transition === 'camera-changing') {
	        publishPresentedViewStateChange(
	          transition,
	          focusedViewId,
	          false
	        );
	      }
	      return;
	    }
	    const transition = presentedCameraSettlement.observeFrame(
	      false,
	      now,
	      true
	    );
	    if (transition === 'camera-settled') {
	      publishPresentedViewStateChange(
	        transition,
	        focusedViewId
	      );
	    }
	  }

	  function publishViewDataGeneration(viewId) {
	    const exactViewId = assertKnownViewId(viewId);
	    if (
	      !Number.isSafeInteger(nextViewDataGeneration) ||
	      nextViewDataGeneration <= 0
	    ) {
	      throw new Error(
	        'Viewer point-data generation space is exhausted.'
	      );
	    }
	    const generation = nextViewDataGeneration;
	    nextViewDataGeneration += 1;
	    viewDataGenerations.set(exactViewId, generation);
	    return generation;
	  }

	  function getViewDataGeneration(viewId) {
	    const exactViewId = assertKnownViewId(viewId);
	    const generation = viewDataGenerations.get(exactViewId);
	    if (!Number.isSafeInteger(generation) || generation <= 0) {
	      throw new Error(
	        `Point data are not published for view "${exactViewId}".`
	      );
	    }
	    return generation;
	  }

	  function getPresentedLodGenerationId(generationToken) {
	    if (generationToken === null) return 0;
	    if (
	      typeof generationToken !== 'object' ||
	      !Object.isFrozen(generationToken)
	    ) {
	      throw new TypeError(
	        'Presented LOD generation token must be null or one frozen object.'
	      );
	    }
	    let id = presentedLodGenerationIds.get(generationToken);
	    if (id !== undefined) return id;
	    if (
	      !Number.isSafeInteger(nextPresentedLodGenerationId) ||
	      nextPresentedLodGenerationId <= 0
	    ) {
	      throw new Error(
	        'Presented LOD generation identity space is exhausted.'
	      );
	    }
	    id = nextPresentedLodGenerationId;
	    nextPresentedLodGenerationId += 1;
	    presentedLodGenerationIds.set(generationToken, id);
	    return id;
	  }

	  function createLodPublicationCertificate(viewId) {
	    const exactViewId = assertKnownViewId(viewId);
	    const lodLevel = hpRenderer.getCurrentLODLevel(exactViewId);
	    const dimensionLevel = getPublishedDimensionLevel(exactViewId);
	    const geometryGeneration =
	      hpRenderer.getViewGeometryGeneration(exactViewId);
	    const lodOwnerToken = hpRenderer.getCurrentLodOwnerToken(
	      exactViewId,
	      dimensionLevel
	    );
	    if (!Number.isSafeInteger(lodLevel) || lodLevel < -1) {
	      throw new Error(
	        `Renderer published an invalid LOD level for view "${exactViewId}".`
	      );
	    }
	    if (
	      !Number.isSafeInteger(geometryGeneration) ||
	      geometryGeneration <= 0
	    ) {
	      throw new Error(
	        `Renderer published an invalid geometry generation for view "${exactViewId}".`
	      );
	    }
	    return Object.freeze({
	      dimensionLevel,
	      geometryGeneration,
	      lodLevel,
	      lodOwnerToken,
	      viewId: exactViewId,
	    });
	  }

	  function publishLodLevelChange(viewId) {
	    const exactViewId = assertKnownViewId(viewId);
	    const lodLevel = hpRenderer.getCurrentLODLevel(exactViewId);
	    const dimensionLevel = getPublishedDimensionLevel(exactViewId);
	    const geometryGeneration =
	      hpRenderer.getViewGeometryGeneration(exactViewId);
	    const lodOwnerToken = hpRenderer.getCurrentLodOwnerToken(
	      exactViewId,
	      dimensionLevel
	    );
	    if (!Number.isSafeInteger(lodLevel) || lodLevel < -1) {
	      throw new Error(
	        `Renderer published an invalid LOD level for view "${exactViewId}".`
	      );
	    }
	    if (
	      !Number.isSafeInteger(geometryGeneration) ||
	      geometryGeneration <= 0
	    ) {
	      throw new Error(
	        `Renderer published an invalid geometry generation for view "${exactViewId}".`
	      );
	    }
	    const previous = publishedLodCertificates.get(exactViewId);
	    if (
	      previous !== undefined &&
	      previous.lodLevel === lodLevel &&
	      previous.dimensionLevel === dimensionLevel &&
	      previous.geometryGeneration === geometryGeneration &&
	      previous.lodOwnerToken === lodOwnerToken
	    ) return;
	    const nextCertificate = Object.freeze({
	      dimensionLevel,
	      geometryGeneration,
	      lodLevel,
	      lodOwnerToken,
	      viewId: exactViewId,
	    });
	    publishedLodCertificates.set(
	      exactViewId,
	      nextCertificate
	    );
	    const next = Object.freeze({
	      dimensionLevel,
	      geometryGeneration,
	      lodLevel,
	      viewId: exactViewId,
	    });
	    // A level of detail change is not a camera change: it must not restart
	    // the camera burst, or a zoom that steps LOD emits a camera-changing
	    // per step and never settles.
	    publishPresentedViewStateChange('lod', exactViewId, false);
	    const observerFailures = [];
	    for (const listener of lodChangeListeners) {
	      try {
	        listener(next);
	      } catch (error) {
	        observerFailures.push(
	          error instanceof Error
	            ? error
	            : new Error(
	                'LOD change observer threw a non-Error value.'
	              )
	        );
	      }
	    }
	    if (observerFailures.length > 0) {
	      const diagnostic = observerFailures.length === 1
	        ? observerFailures[0]
	        : new AggregateError(
	            observerFailures,
	            'Multiple LOD change observers failed.'
	          );
	      queueMicrotask(() => {
	        try {
	          console.error(
	            '[Viewer] LOD change observer failed.',
	            diagnostic
	          );
	        } catch {
	          // Diagnostics cannot invalidate a published render generation.
	        }
	      });
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

	  function getExactViewPositionRecord(viewId) {
	    if (typeof viewId !== 'string' || viewId.length === 0) {
	      throw new TypeError('Renderer view id must be a non-empty string.');
	    }
	    const record = viewPositionsCache.get(viewId);
	    if (!(record?.positions instanceof Float32Array)) {
	      throw new Error(`Positions are not published for view "${viewId}".`);
	    }
	    return record;
	  }

	  function getExactViewPositions(viewId) {
	    return getExactViewPositionRecord(viewId).positions;
	  }

	  /** Components per point of a view's published positions (1, 2 or 3). */
	  function getExactViewPositionDimension(viewId) {
	    return getExactViewPositionRecord(viewId).dimension;
	  }

	  function publishViewPositions(viewId, positions, dimension) {
	    // An empty publication (no dataset) is valid in any layout.
	    requirePositionArray(
	      positions,
	      dimension,
	      `Positions for view "${viewId}"`,
	      { allowEmpty: true }
	    );
	    viewPositionsCache.set(
	      viewId,
	      Object.freeze({ positions, dimension })
	    );
	  }

	  function getExactViewColors(viewId) {
	    const exactViewId = assertKnownViewId(viewId);
	    if (exactViewId === LIVE_VIEW_ID) {
	      if (!(colorsArray instanceof Uint8Array)) {
	        throw new Error('Colors are not published for view "live".');
	      }
	      return colorsArray;
	    }
	    const snapshot = snapshotViewsById.get(exactViewId);
	    if (!(snapshot?.colors instanceof Uint8Array)) {
	      throw new Error(
	        `Colors are not published for view "${exactViewId}".`
	      );
	    }
	    return snapshot.colors;
	  }

		  function getExactViewTransparency(viewId) {
	    if (typeof viewId !== 'string' || viewId.length === 0) {
	      throw new TypeError('Renderer view id must be a non-empty string.');
	    }
	    if (viewId === LIVE_VIEW_ID) {
	      if (!(transparencyArray instanceof Uint8Array)) {
	        throw new Error('Transparency is not published for view "live".');
	      }
	      return transparencyArray;
	    }
	    const snapshot = snapshotViewsById.get(viewId);
	    if (!snapshot) {
	      throw new Error(`View "${viewId}" does not exist.`);
	    }
	    if (!(snapshot.transparency instanceof Uint8Array)) {
	      throw new Error(`Transparency is not published for view "${viewId}".`);
	    }
		    return snapshot.transparency;
		  }

	  function captureExactViewDataOwnership(viewId) {
	    const exactViewId = assertKnownViewId(viewId);
	    const geometryGenerationBefore =
	      hpRenderer.getViewGeometryGeneration(exactViewId);
	    const dataGeneration = getViewDataGeneration(exactViewId);
	    const positions = getExactViewPositions(exactViewId);
	    const colors = getExactViewColors(exactViewId);
	    const transparency =
	      getExactViewTransparency(exactViewId);
	    const dimensionLevel =
	      getPublishedDimensionLevel(exactViewId);
	    // The published dimension is also the positions' stride.
	    const pointCountForView = positions.length / dimensionLevel;
	    if (
	      getExactViewPositionDimension(exactViewId) !== dimensionLevel ||
	      !Number.isSafeInteger(pointCountForView) ||
	      pointCountForView !== pointCount ||
	      colors.length !== pointCountForView * 4 ||
	      transparency.length !== pointCountForView
	    ) {
	      throw new Error(
	        `Point-data ownership is inconsistent for view "${exactViewId}".`
	      );
	    }
	    const lodLevel =
	      hpRenderer.getCurrentLODLevel(exactViewId);
	    const lodMembership = requireViewerSequentialLodMembership(
	      hpRenderer.getCurrentLodSequentialMembership(
	        exactViewId,
	        dimensionLevel
	      ),
	      pointCountForView
	    );
	    const lodSizeMultiplier =
	      hpRenderer.getCurrentLODSizeMultiplier(
	        exactViewId,
	        dimensionLevel
	      );
	    // The order the pane draws its points in at full detail (null: source
	    // order); a reduced level draws a prefix of it.
	    const drawOrder = hpRenderer.getViewDrawOrder(exactViewId);
	    const geometryGenerationAfter =
	      hpRenderer.getViewGeometryGeneration(exactViewId);
	    if (
	      geometryGenerationBefore !== geometryGenerationAfter ||
	      !Number.isSafeInteger(geometryGenerationAfter) ||
	      geometryGenerationAfter <= 0
	    ) {
	      throw new Error(
	        `Point-data geometry changed while reading view "${exactViewId}".`
	      );
	    }
	    return Object.freeze({
	      colors,
	      dataGeneration,
	      dimensionLevel,
	      drawOrder,
	      geometryGeneration: geometryGenerationAfter,
	      lodLevel,
	      lodMembership,
	      lodSizeMultiplier,
	      pointCount: pointCountForView,
	      positions,
	      transparency,
	      viewId: exactViewId
	    });
	  }

	  function assertViewDataOwnershipCurrent(
	    owner,
	    boundary = 'Borrowed point data'
	  ) {
	    let current;
	    try {
	      current = captureExactViewDataOwnership(owner.viewId);
	    } catch (error) {
	      throw new Error(
	        `${boundary} for view "${owner.viewId}" changed during capture.`,
	        { cause: error }
	      );
	    }
	    if (
	      current.positions !== owner.positions ||
	      current.colors !== owner.colors ||
	      current.transparency !== owner.transparency ||
	      current.pointCount !== owner.pointCount ||
	      current.dimensionLevel !== owner.dimensionLevel ||
	      current.geometryGeneration !== owner.geometryGeneration ||
	      current.dataGeneration !== owner.dataGeneration ||
	      current.lodLevel !== owner.lodLevel ||
	      current.lodMembership !== owner.lodMembership ||
	      current.drawOrder !== owner.drawOrder ||
	      current.lodSizeMultiplier !== owner.lodSizeMultiplier
	    ) {
	      throw new Error(
	        `${boundary} for view "${owner.viewId}" changed during capture.`
	      );
	    }
	  }

	  function createPresentedLodMembership(membership) {
	    if (membership === null) return null;
	    // Presentation observers need a freshness certificate, never the
	    // renderer-owned admitted-index array. The borrowed synchronous
	    // boundary remains the only route that can clone those data.
	    return Object.freeze({
	      admittedCount: membership.indices.length,
	      dimensionLevel: membership.dimensionLevel,
	      generationToken: membership.generationToken,
	      lodLevel: membership.lodLevel,
	      pointCount: membership.pointCount,
	    });
	  }

      /**
       * The exact owner of one view's spatial queries: its published
       * positions, transparency and dimension, and its tree when one is
       * installed (null before). `requestLargeIndex` asks for a large view's
       * missing tree to be built off the main thread; the caller answers
       * this query without it.
       */
      function getSpatialQueryOwner(
        viewId,
        requestLargeIndex = false
      ) {
        const exactViewId = assertKnownViewId(viewId);
        if (typeof requestLargeIndex !== 'boolean') {
          throw new TypeError(
            'Spatial-query index preparation state must be an exact boolean.'
          );
        }
        const publishedPositions = getExactViewPositions(exactViewId);
        const transparency = getExactViewTransparency(exactViewId);
        const dimensionLevel =
          getPublishedDimensionLevel(exactViewId);
        if (getExactViewPositionDimension(exactViewId) !== dimensionLevel) {
          throw new Error(
            `Spatial-query positions for view "${exactViewId}" are not published in its ${dimensionLevel}D layout.`
          );
        }
        const pointCountForView = publishedPositions.length / dimensionLevel;
        const resolveIndex = () => (
          exactViewId === LIVE_VIEW_ID
            ? hpRenderer.spatialIndices.get(dimensionLevel) ?? null
            : hpRenderer._getSpatialIndexForViewGeneration(
                exactViewId,
                dimensionLevel
              )
        );
        const spatialIndex = resolveIndex();

        if (
          requestLargeIndex &&
          spatialIndex === null &&
          pointCountForView >=
            INTERACTIVE_SPATIAL_INDEX_POINT_THRESHOLD
        ) {
          // Never built on the main thread (tens of milliseconds a million
          // cells): the worker builds it and installs it when it lands.
          hpRenderer.buildSpatialIndexInBackground(exactViewId).catch(error => {
            console.warn('[Viewer] Background spatial index failed:', error);
          });
        }

        // Verify every publication identity, so a reader never gets a mixed
        // owner.
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
	        multisampled: false,
	        autoFog: true,
	        overrideBounds: null
	      };
	      renderParamsByView.set(vid, renderParams);
	    }
	    return renderParams;
	  }

  const viewTitleLayerEl = viewTitleLayer || null;
  let viewTitleEntries = [];
  // The presented layout the title chips were last placed for; chips are
  // repositioned only when the layout object changes, never per frame.
  let lastTitleLayout = null;
  // A chip sits this far below the top edge of its pane (CSS pixels).
  const VIEW_TITLE_TOP_OFFSET_PX = 20;

  const projectionMatrix = mat4.create();
  const viewMatrix = mat4.create();
  const modelMatrix = mat4.create();
  const mvpMatrix = mat4.create();
  const viewProjMatrix = mat4.create();
  const invViewProjMatrix = mat4.create();
  const tempInvViewMatrix = mat4.create();
  // Preallocated studio backdrop scratch: one pane's inverse MVP and camera.
  const _studioInvMvpMatrix = mat4.create();
  const _studioInvViewMatrix = mat4.create();
  const _studioEye = new Float32Array(3);
  const _studioPool = {
    gate: 0,
    centerX: 0,
    centerY: 0,
    axisAX: 0,
    axisAY: 0,
    axisBX: 0,
    axisBY: 0,
  };
  const _studioPoolInverse = new Float32Array(4);
  const _studioSurfaceWeights = { floor: 0, backdrop: 0 };
  const _studioBackPlane = {
    normalX: 0,
    normalY: 0,
    normalZ: -1,
    offset: 0,
    uX: 1,
    uY: 0,
    uZ: 0,
    vX: 0,
    vY: 1,
    vZ: 0,
  };
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
  const _freeflyAxes = {
    forward: _freeflyForward,
    right: _freeflyRight,
    upVec: _freeflyUp
  };
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
	  const _smokeRenderParams = {
	    invViewProjMatrix,
	    eye: null,
	    lightDir,
	    width: 0,
	    height: 0,
	    // Where the smoke composites. Null is the default framebuffer; with
	    // antialiasing on it is the multisampled scene target, and binding zero
	    // instead would drop the smoke out of the resolved image.
	    sceneFramebuffer: null,
	  };
	  const _liveRenderViewRecord = {
	    id: LIVE_VIEW_ID,
	    label: '',
	    colors: null,
	    transparency: null,
	    centroidPositions: null,
	    centroidColors: null,
	    centroidTransparencies: null,
	    centroidCount: 0,
	    cameraState: null
	  };
	  // Snapshot objects are stable for their published lifetime. Weak keys
	  // eliminate per-frame descriptor literals without retaining removed
	  // snapshots or their potentially large typed arrays.
	  const _snapshotRenderViewRecordPool = new WeakMap();
	  function getSnapshotRenderViewRecord(snapshot) {
	    let record =
	      _snapshotRenderViewRecordPool.get(snapshot);
	    if (!record) {
	      record = {
	        id: snapshot.id,
	        label: snapshot.label,
	        colors: snapshot.colors,
	        transparency: snapshot.transparency,
	        centroidPositions: snapshot.centroidPositions,
	        centroidColors: snapshot.centroidColors,
	        centroidTransparencies:
	          snapshot.centroidTransparencies,
	        centroidCount: 0,
	        cameraState: snapshot.cameraState
	      };
	      _snapshotRenderViewRecordPool.set(snapshot, record);
	    }
	    record.id = snapshot.id;
	    record.label = snapshot.label;
	    record.colors = snapshot.colors;
	    record.transparency = snapshot.transparency;
	    record.centroidPositions = snapshot.centroidPositions;
	    record.centroidColors = snapshot.centroidColors;
	    record.centroidTransparencies =
	      snapshot.centroidTransparencies;
	    record.centroidCount = snapshot.centroidPositions
	      ? snapshot.centroidPositions.length / 3
	      : 0;
	    record.cameraState = snapshot.cameraState;
	    return record;
	  }
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
	    lightingStrength: 0,
	    lightDir,
	    navigationMode: 'orbit'
	  };

  let positionsArray = null;
  let colorsArray = null;
  let transparencyArray = null;

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
    getViewIdAtCanvasPoint: getPresentedViewIdAtCssPoint,
    getRenderContext: () => getHighlightContext(),
    getNavigationState: () => ({ navigationMode, isDragging }),
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
  // Studio backdrop state. The palette is the last studio background shown, so
  // a fade-out after switching away keeps its own marks; the surface it fades
  // over is always the current clear colour.
  let showStudio = false;
  let studioOpacity = 0;
  let studioPalette = STUDIO_PALETTES.studio;
  let studioGlowColor = studioColor01(STUDIO_PALETTES.studio.glow);
  let studioInkColor = studioColor01(STUDIO_PALETTES.studio.ink);
  // Whether a pane drawn in the last frame was still crossing between the
  // floor and the dot surface, so the next frame is still owed.
  let studioSurfaceInTransition = false;
  // Scientific grayscale axis colors (no distracting colors)
  let axisXColor = [0.35, 0.35, 0.35];  // Neutral gray for all axes
  let axisYColor = [0.35, 0.35, 0.35];
  let axisZColor = [0.35, 0.35, 0.35];

  // Interaction
  const initialCameraPose = createDefaultCameraPose();
  let radius = initialCameraPose.orbit.radius;
  let theta = initialCameraPose.orbit.theta;
  let phi = initialCameraPose.orbit.phi;
  const target = vec3.fromValues(...initialCameraPose.orbit.target);
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
	  let animationHandle = null;
	  let renderPaused = false;
	  let disposed = false;
	  let disposalSettled = false;
	  let disposalInProgress = false;
	  let contextLossTransitioning = false;
	  let disposalRequestedDuringContextLoss = false;
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
  // WASD navigation works in all modes (free, orbit, planar). Zoom keys: Equal
  // (=) and Minus (-), also BracketRight (]) and BracketLeft ([). Shift only
  // speeds a movement key up, so on its own it moves nothing.
  const MOVEMENT_KEY_CODES = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
    'Equal', 'Minus', 'BracketLeft', 'BracketRight'
  ]);
  const NAVIGATION_KEY_CODES = new Set([...MOVEMENT_KEY_CODES, 'ShiftLeft', 'ShiftRight']);
  // Only navigation keys are held here. Any key left in the set would read as
  // camera motion and keep the frame loop running until its keyup, which a
  // shortcut or a focus change can swallow.
  const activeKeys = new Set();
  function isMovementKeyHeld() {
    for (const code of activeKeys) {
      if (MOVEMENT_KEY_CODES.has(code)) return true;
    }
    return false;
  }
  function releaseHeldKeys() {
    if (activeKeys.size === 0) return;
    activeKeys.clear();
    invalidateFrame();
  }
  let freeflyPosition = vec3.fromValues(...initialCameraPose.freefly.position);
  let freeflyVelocity = vec3.create();
  let freeflyYaw = initialCameraPose.freefly.yaw;
  let freeflyPitch = initialCameraPose.freefly.pitch;
  let pointerLockEnabled = false;
  let pointerLockActive = false;
  let pointerLockChangeHandler = null;
  let pointerLockRequestGeneration = 0;
  let pointerLockRequestPending = false;
  let pendingShot = false;
  let pendingShotViewportInfo = null;  // Cached viewport info for pointer lock shots
  let projectileBuildGeneration = 0;
  let projectileBuildCompletion = null;
  const PROJECTILE_CONTEXT_LOSS_MESSAGE =
    'Projectile preparation was cancelled because the WebGL context was lost.';
  let lookActive = false;
  let lastFrameTime = performance.now();
  let renderFrameId = 0;
  let frameInvalidated = true;
  // The frame loop runs only while something can change what is drawn: it
  // stops once the scene has settled and an invalidation (or a frame-phase
  // request, a resize, a held key) starts it again. Started by `start()`.
  let frameLoopStarted = false;
  // Bumped by every change that can alter what any pane draws, but not by a
  // camera change alone: a pane whose camera did not move and whose scene
  // generation is unchanged keeps the pixels it drew (retained panes).
  let sceneGeneration = 0;
  let lastFrameCauseTime = -Infinity;
  let framesDrawnSinceCause = 0;
  // Whether a pane drawn in the last frame left its LOD short of the level its
  // camera asks for (hysteresis steps one level per frame).
  let lodConvergingInLastFrame = false;
  // What last started a settle window: 'invalidated', 'resize', or the
  // time-driven effect's name (see sceneAnimationCause). Diagnostics only.
  let lastFrameCause = null;
  // Opt-in tracing of what invalidates frames (setFrameInvalidationTracing).
  let frameInvalidationTracing = false;
  let lastFrameInvalidationTrace = null;
  let lastDrawnCanvasWidth = 0;
  let lastDrawnCanvasHeight = 0;

  let velocityTheta = 0;
  let velocityPhi = 0;
  let velocityPanX = 0;
  let velocityPanY = 0;
  let velocityPanZ = 0;
  let lastMoveTime = 0;
  let lastDx = 0;
  let lastDy = 0;

  const INERTIA_FRICTION = 0.92;
  // The longest frame camera motion integrates in one step. Every integrator
  // below is exact for any step, so a slow frame (a large dataset at a low
  // frame rate) advances the camera by its real duration instead of in slow
  // motion; only a stall longer than this (a background tab, a debugger
  // pause) is cut short, so the camera never leaps on resume.
  const MAX_FRAME_DT = 0.25;
  const INERTIA_MIN_VELOCITY = 0.0001;
  const VELOCITY_SMOOTHING = 0.3;
  const PHYSICS_TICK_RATE = 60;          // Reference frame rate for frame-independent physics (Hz)
  const SMOOTH_ZOOM_RATE = 0.15;         // Fraction of the remaining zoom closed per reference tick

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
    centroidProgram,
    centroidAttribLocations,
    centroidUniformLocations,
    // For charge indicator
    getLassoCtx: () => highlightTools?.getLassoCtx?.() || null,
    getPointerLockActive: () => pointerLockActive,
    getNavigationMode: () => navigationMode,
    // The surfaces projectiles bounce off: what the live view's backdrop shows
    getCollisionStage: getLiveCollisionStage,
    // For dimension-aware spatial index collision queries
    getCurrentDimensionLevel: () => getPublishedDimensionLevel(LIVE_VIEW_ID),
  });

  // Reused stage records, so a physics step allocates nothing.
  const gridCollisionStage = { kind: 'box', min: -GRID_SIZE, max: GRID_SIZE };
  const floorCollisionStage = { kind: 'floor', y: 0, centerX: 0, centerZ: 0, radius: STUDIO_STAGE.outerRadius };

  /**
   * The solid surfaces of the live view's backdrop, or null when it shows
   * none: the grid's box, or the studio floor of a 3D view navigated in
   * orbit or free-fly (a 1D, 2D or planar view sits on a dot surface, which
   * stands behind the data and is not something to land on). A backdrop
   * still fading in or out counts once it is a tenth visible.
   *
   * Projectiles fly in the live view's world (its positions and tree), so the
   * stage is the live view's own: its representation's dimension and its own
   * navigation mode, whichever view has focus.
   */
  function getLiveCollisionStage() {
    if (showGrid && gridOpacity > 0.1) return gridCollisionStage;
    if (!showStudio || studioOpacity <= 0.1) return null;
    const dimensionLevel = getPublishedDimensionLevel(LIVE_VIEW_ID);
    // Read without cloning: this runs every physics step.
    const liveNavigationMode = cameraFollowers.has(LIVE_VIEW_ID)
      ? navigationMode
      : liveCameraState.navigationMode;
    if (studioSurfacePlanarity(dimensionLevel, liveNavigationMode) !== 0) return null;
    const state = getStudioPaneState(LIVE_VIEW_ID);
    floorCollisionStage.y = state.floorY;
    floorCollisionStage.centerX = state.stageX;
    floorCollisionStage.centerZ = state.stageZ;
    return floorCollisionStage;
  }

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
  const contextEventCleanupFns = [];
  function addEventListenerWithCleanup(
    target,
    event,
    handler,
    options,
    allowAfterContextLoss = false
  ) {
    const guardedHandler = function viewerEventHandler(...args) {
      if (
        disposed ||
        (webglContextLost && !allowAfterContextLoss)
      ) {
        return;
      }
      invalidateFrame();
      return Reflect.apply(handler, this, args);
    };
    target.addEventListener(event, guardedHandler, options);
    eventCleanupFns.push(
      () => target.removeEventListener(event, guardedHandler, options)
    );
  }

  /**
   * A viewer listener that sees many events it does not act on: page-wide
   * (`window`) pointer movement over the sidebar and other panels, keystrokes
   * into a text field, and the canvas's own pointer events for a mouse, which
   * the mouse listeners handle instead. Unlike
   * `addEventListenerWithCleanup` it does not invalidate the frame on its own;
   * the handler calls `invalidateFrame()` on the paths that change what is on
   * screen. An invalidation keeps the scene drawing for a settle window
   * (FRAME_SETTLE_MIN_FRAMES frames), so a blanket one here made
   * merely moving the mouse anywhere on the page redraw the full scene at the
   * display rate.
   */
  function addPageInputListenerWithCleanup(target, event, handler, options) {
    const guardedHandler = function viewerPageInputHandler(...args) {
      if (disposed || webglContextLost) return;
      return Reflect.apply(handler, this, args);
    };
    target.addEventListener(event, guardedHandler, options);
    eventCleanupFns.push(
      () => target.removeEventListener(event, guardedHandler, options)
    );
  }

  function addContextEventListenerWithCleanup(
    target,
    event,
    handler,
    options
  ) {
    const guardedHandler = function viewerContextEventHandler(...args) {
      if (disposalSettled) return;
      return Reflect.apply(handler, this, args);
    };
    target.addEventListener(event, guardedHandler, options);
    contextEventCleanupFns.push(
      () => target.removeEventListener(event, guardedHandler, options)
    );
  }

  // === WebGL context loss handling (WebGL2-only policy) ===
  let webglContextLost = false;
  let webglContextOverlay = null;
  let webglContextOverlayMessage = null;
  let webglContextOverlayAction = null;
  const webglContextOverlayCleanupFns = [];
  const hpRendererFacade = createViewerRendererFacade(
    hpRenderer,
    () => (
      disposed
        ? 'disposed'
        : webglContextLost
          ? 'context-lost'
          : null
    ),
    invalidateFrame
  );

  function ensureWebglContextOverlay() {
    if (webglContextOverlay) return webglContextOverlay;

    const overlay = document.createElement('div');
    const overlayIdentity = nextWebglContextOverlayIdentity++;
    const titleId =
      `cellucid-webgl-context-overlay-title-${overlayIdentity}`;
    const messageId =
      `cellucid-webgl-context-overlay-message-${overlayIdentity}`;
    overlay.id = 'cellucid-webgl-context-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', titleId);
    overlay.setAttribute('aria-describedby', messageId);
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
    title.id = titleId;
    title.style.cssText = 'font-size: 16px; font-weight: 700; margin-bottom: 10px;';
    title.textContent = 'WebGL Context Lost';

    const message = document.createElement('div');
    message.id = messageId;
    message.style.cssText = 'font-size: 13px; line-height: 1.5; opacity: 0.95; margin-bottom: 14px;';
    message.textContent = 'WebGL context lost. Reload required.';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = 'Reload';
    btn.style.cssText = 'cursor: pointer;';
    const handleReload = () => window.location.reload();
    const containDialogFocus = event => {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      btn.focus({ preventScroll: true });
    };
    btn.addEventListener('click', handleReload);
    overlay.addEventListener('keydown', containDialogFocus);
    webglContextOverlayCleanupFns.push(
      () => btn.removeEventListener('click', handleReload),
      () => overlay.removeEventListener('keydown', containDialogFocus)
    );

    panel.appendChild(title);
    panel.appendChild(message);
    panel.appendChild(btn);
    overlay.appendChild(panel);

    document.body.appendChild(overlay);
    webglContextOverlay = overlay;
    webglContextOverlayMessage = message;
    webglContextOverlayAction = btn;
    return overlay;
  }

  function showWebglContextOverlay(message) {
    const overlay = ensureWebglContextOverlay();
    if (webglContextOverlayMessage) {
      webglContextOverlayMessage.textContent = message;
    }
    overlay.style.display = 'flex';
    webglContextOverlayAction?.focus({ preventScroll: true });
  }

  function invalidateViewerWebGLOwnersAfterContextLoss() {
    // WebGL has already invalidated every handle. Drop those invalid owners
    // directly; routing them through ordinary retirement would itself issue
    // illegal/no-op GL calls on some browser backends.
    centroidPositionBuffer = null;
    centroidColorBuffer = null;
    centroidPositionCapacity = 0;
    centroidColorCapacity = 0;
    centroidVao = null;
    centroidCount = 0;
    gridProgram = null;
    studioProgram = null;
    studioVao = null;
    studioCornerBuffer = null;
    backdropLooks.abandon();
    centroidProgram = null;
    for (const locations of [
      gridUniformLocations,
      studioUniformLocations,
      centroidUniformLocations,
    ]) {
      for (const key of Object.keys(locations)) {
        locations[key] = null;
      }
    }
    centroidSnapshotBuffers.clear();
    pendingCentroidSnapshotRetirements.clear();
    for (const key of Object.keys(gridPlaneBuffers)) {
      gridPlaneBuffers[key] = null;
    }

    edgeLayer.abandon();
    useInstancedEdges = false;
  }

  function retireCleanupCallbacks(callbacks, owner) {
    const retiring = callbacks.splice(0, callbacks.length);
    const failedCallbacks = [];
    const failures = [];
    for (const cleanup of retiring) {
      try {
        cleanup();
      } catch (error) {
        failedCallbacks.push(cleanup);
        failures.push(error);
      }
    }
    callbacks.push(...failedCallbacks);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${owner} retirement was incomplete.`
      );
    }
  }

  function retireViewTitleOwners() {
    const failedEntries = [];
    const failures = [];
    for (const entry of viewTitleEntries) {
      try {
        entry.el?.remove();
      } catch (error) {
        failedEntries.push(entry);
        failures.push(error);
      }
    }
    viewTitleEntries = failedEntries;
    lastTitleLayout = null;
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Viewer title-chip retirement was incomplete.'
      );
    }
  }

  function retireCentroidLabelOwners() {
    const failures = [];
    const ownedViewIds = new Set([
      ...viewCentroidLabels.keys(),
      ...pendingCentroidLabelRetirements.keys(),
    ]);
    for (const viewId of ownedViewIds) {
      try {
        removeLabelsForView(viewId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Viewer centroid-label retirement was incomplete.'
      );
    }
  }

  function retireViewerCpuCaches() {
    retireRenderViewRecord(_liveRenderViewRecord);
    cachedViewMatrices.clear();
    renderParamsByView.clear();
    studioPaneStates.clear();
    overlayCtxByView.clear();
    overlayCtxOptionsByView.clear();
    viewDimensionLevels.clear();
    viewLayoutKeys.clear();
    viewPositionsCache.clear();
    viewDataGenerations.clear();
    viewCentroidFlags.clear();
    hiddenCentroidLabelViews.clear();
    publishedLodCertificates.clear();
    lodChangeListeners.clear();
    presentedViewStateListeners.clear();
    presentedFrameState.initialized = false;
    presentedFrameState.pending = false;
    presentedLayout = null;
    presentedPaneProjections.length = 0;
    presentedLayoutListeners.clear();
    activeKeys.clear();
    _renderAllViews.length = 0;
    _renderVelocityViewIds.length = 0;
    snapshotViews.length = 0;
    snapshotViewsById.clear();
    pendingSnapshotCleanupIds.clear();
    positionsArray = null;
    colorsArray = null;
    transparencyArray = null;
    pointCount = 0;
    centroidCount = 0;
    navigationModeOwnership.clear();
    viewFocusHandler = null;
    sidebarFocusPending = false;
    if (sidebarFocusTimer !== null) {
      clearTimeout(sidebarFocusTimer);
      sidebarFocusTimer = null;
    }
    navigationModeChangeHandler = null;
    highlightRenderFailureHandler = null;
    smokeRenderFailureHandler = null;
    smokeSourceChangeHandler = null;
    velocityRenderFailureHandler = null;
    if (labelLayer) labelLayer.style.display = 'none';
    if (viewTitleLayerEl) viewTitleLayerEl.style.display = 'none';
  }

  // === Event Listeners ===
  const handleContextMenu = (e) => { e.preventDefault(); return false; };
  addEventListenerWithCleanup(canvas, 'contextmenu', handleContextMenu);

  addContextEventListenerWithCleanup(canvas, 'webglcontextlost', (e) => {
    // Do not prevent the default action. Some engines will physically restore
    // this context, but Cellucid's logical renderer generation remains
    // terminal and only a reload may construct a coherent replacement.
    if (webglContextLost) return;
    webglContextLost = true;
    renderPaused = true;
    contextLossTransitioning = true;
    if (disposed && !disposalSettled) {
      disposalRequestedDuringContextLoss = true;
    }
    const contextLossFailures = [];
    const attemptContextLossStep = (operation, disposalStep = null) => {
      try {
        operation();
        if (disposalStep !== null) {
          completedDisposalSteps.add(disposalStep);
        }
      } catch (error) {
        contextLossFailures.push(
          error instanceof Error
            ? error
            : new Error('WebGL context-loss cleanup threw a non-Error value.')
        );
      }
    };
    let projectileBuildCompletionToPublish = null;
    try {
      // Fence asynchronous work first, but defer its external completion
      // observer until every GPU owner below is terminal.
      const scheduledAnimationHandle = animationHandle;
      animationHandle = null;
      if (scheduledAnimationHandle !== null) {
        attemptContextLossStep(
          () => cancelAnimationFrame(scheduledAnimationHandle)
        );
      }
      attemptContextLossStep(() => reconcileFramePhases());
      attemptContextLossStep(() => {
        projectileBuildCompletionToPublish =
          detachPendingProjectileBuild();
      });

      // Terminalize the complete GPU ownership graph before any DOM or
      // application callback can re-enter viewer.dispose().
      attemptContextLossStep(handleHpRendererContextLost);
      attemptContextLossStep(
        () => sceneMsaaTarget.handleContextLost()
      );
      attemptContextLossStep(
        () => projectileSystem.handleContextLost()
      );
      attemptContextLossStep(
        () => orbitAnchorRenderer.handleContextLost()
      );
      attemptContextLossStep(() => smokeRenderer.handleContextLost());
      attemptContextLossStep(() => {
        if (overlayManager !== null) {
          overlayManager.handleContextLost();
        } else {
          vectorFieldOverlay?.handleContextLost?.();
        }
      });
      attemptContextLossStep(() => {
        const owner = highlightTools;
        if (owner !== null) {
          owner.handleContextLost?.();
          highlightTools = null;
        }
      });
      attemptContextLossStep(
        invalidateViewerWebGLOwnersAfterContextLoss
      );

      // A context-lost overlay can now be semantically disposed without any
      // WebGL calls. This also retires detached retry owners.
      attemptContextLossStep(() => {
        if (overlayManager !== null) {
          overlayManager.dispose();
          overlayManager = null;
        }
        vectorFieldOverlay = null;
      }, 'overlay manager retirement');

      // Remove all ordinary input/application listeners while retaining the
      // dedicated context pair until disposal has fully settled.
      attemptContextLossStep(
        () => retireCleanupCallbacks(
          eventCleanupFns,
          'Viewer event-listener'
        ),
        'event listener retirement'
      );
      attemptContextLossStep(
        () => canvasResizeObserver.disconnect(),
        'resize observer retirement'
      );

      attemptContextLossStep(
        retireViewTitleOwners,
        'view-title retirement'
      );
      attemptContextLossStep(
        retireCentroidLabelOwners,
        'centroid-label retirement'
      );
      attemptContextLossStep(
        () => retirePointerLockLifecycle(null),
        'pointer-lock retirement'
      );
      attemptContextLossStep(
        () => projectileSystem.retireContextLostUI?.()
      );
      attemptContextLossStep(
        retireViewerCpuCaches,
        'viewer cache retirement'
      );

      // All GPU and semantic owners are fenced. Observers and reload UI are
      // now safe even if they synchronously request disposal.
      attemptContextLossStep(() => {
        publishProjectileBuildResult(
          projectileBuildCompletionToPublish,
          'cancelled',
          PROJECTILE_CONTEXT_LOSS_MESSAGE
        );
        projectileBuildCompletionToPublish = null;
      }, 'projectile build cancellation');
      attemptContextLossStep(() => {
        showWebglContextOverlay(
          'WebGL context lost. Reload required to continue.'
        );
      });
    } finally {
      contextLossTransitioning = false;
      if (disposalRequestedDuringContextLoss) {
        disposalRequestedDuringContextLoss = false;
        queueMicrotask(() => publicApi.dispose());
      }
    }
    if (contextLossFailures.length > 0) {
      const cleanupError = new AggregateError(
        contextLossFailures,
        'WebGL context loss was fenced, but cleanup was incomplete.'
      );
      try {
        console.error(
          '[Viewer] WebGL context-loss cleanup was incomplete.',
          cleanupError
        );
      } catch {
        // Terminal diagnostics cannot reopen the lost generation.
      }
    }
  });

  addContextEventListenerWithCleanup(
    canvas,
    'webglcontextrestored',
    () => {
      // Firefox may physically restore the underlying context. The viewer,
      // renderer facade, animation loop, and all ownership records deliberately
      // remain terminal.
      if (!webglContextLost || disposed) return;
      renderPaused = true;
      try {
        showWebglContextOverlay(
          'WebGL context restored, but Cellucid requires a reload to reinitialize GPU resources.'
        );
      } catch (error) {
        try {
          console.error(
            '[Viewer] WebGL restoration notice could not be displayed.',
            error
          );
        } catch {
          // Logical context loss remains authoritative.
        }
      }
    }
  );

  /**
   * In grid mode, a camera press in a different view's area focuses that view,
   * so the representation picker and every other view-specific operation
   * target the view the user pressed, and the camera and navigation mode
   * become that view's. Mouse and touch presses share this so a finger in
   * multiview moves the view it touches, not whichever view last had focus.
   */
  function focusViewAtScreenPosition(clientX, clientY, commit = 'release') {
    if (viewLayoutMode !== 'grid') return;
    if (highlightTools?.isInteractionActive?.()) return;
    const clickedViewId = getViewIdAtScreenPosition(clientX, clientY);
    if (clickedViewId && clickedViewId !== focusedViewId) {
      // The camera follows the pane at once; the sidebar's switch to it
      // (`viewFocusHandler`: its legend, counts and controls) waits until the
      // gesture ends, so starting a drag or a wheel zoom in another pane
      // never waits for the sidebar to rebuild.
      transferViewFocus(clickedViewId, { saveOutgoing: true });
      publishPresentedViewStateChange('focus', focusedViewId);
      deferSidebarFocus(commit);
    }
  }

  let sidebarFocusPending = false;
  let sidebarFocusTimer = null;
  // A wheel gesture has no release: it ends when the wheel has rested this long.
  const WHEEL_GESTURE_REST_MS = 150;

  /** Publish the focused pane to the sidebar now, if a gesture deferred it. */
  function commitSidebarFocus() {
    if (sidebarFocusTimer !== null) {
      clearTimeout(sidebarFocusTimer);
      sidebarFocusTimer = null;
    }
    if (!sidebarFocusPending) return;
    sidebarFocusPending = false;
    if (disposed || webglContextLost) return;
    // Notify UI (always, so dimension buttons target the focused view)
    if (viewFocusHandler) viewFocusHandler(focusedViewId);
  }

  /**
   * Defer the sidebar's switch to the focused pane to the end of the
   * gesture: the release of a press (`'release'`), or a rest of the wheel
   * (`'wheel'`).
   */
  function deferSidebarFocus(commit) {
    sidebarFocusPending = true;
    if (commit === 'wheel') {
      if (sidebarFocusTimer !== null) clearTimeout(sidebarFocusTimer);
      sidebarFocusTimer = setTimeout(commitSidebarFocus, WHEEL_GESTURE_REST_MS);
    }
  }

  /** Start one camera drag at a screen point. */
  function beginCameraDrag(clientX, clientY, mode) {
    isDragging = true;
    dragMode = mode;
    lastX = clientX;
    lastY = clientY;
    lastMoveTime = performance.now();
    velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
    lastDx = lastDy = 0;
  }

  function rotateCameraByScreenDelta(dx, dy) {
    const rotateSpeed = 0.005;
    const { xSign, ySign } = getOrbitSigns();
    theta -= dx * rotateSpeed * xSign;
    phi -= dy * rotateSpeed * ySign;
    const EPS = 0.05;
    phi = Math.max(EPS, Math.min(Math.PI - EPS, phi));
    while (theta > Math.PI * 2) theta -= Math.PI * 2;
    while (theta < 0) theta += Math.PI * 2;
  }

  function panCameraByScreenDelta(dx, dy) {
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

  /** Move the camera drag in progress to a new screen point. */
  function moveCameraDrag(clientX, clientY) {
    const dx = clientX - lastX;
    const dy = clientY - lastY;
    lastDx = dx * VELOCITY_SMOOTHING + lastDx * (1 - VELOCITY_SMOOTHING);
    lastDy = dy * VELOCITY_SMOOTHING + lastDy * (1 - VELOCITY_SMOOTHING);
    lastMoveTime = performance.now();
    if (dragMode === 'rotate') {
      rotateCameraByScreenDelta(dx, dy);
    } else if (dragMode === 'pan') {
      panCameraByScreenDelta(dx, dy);
    }
    lastX = clientX;
    lastY = clientY;
  }

  /** End the camera drag in progress, handing a fast release to inertia. */
  function releaseCameraDrag() {
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
  }

  /** Save the live camera to the focused view. */
  function saveFocusedViewCamera() {
    setViewCameraState(focusedViewId, getCurrentCameraStateInternal());
  }

  /**
   * The pane a projectile is aimed in, captured at the press: its render
   * rectangle, the exact projection it is drawn with, and its camera. The
   * shot keeps this pane for its whole charge, so it leaves from the pane it
   * was aimed in even if the pointer strays across a pane edge.
   */
  function captureProjectileViewport(clientX, clientY) {
    const vpInfo = getViewportInfoAtScreen(clientX, clientY);
    if (vpInfo === -1) return null;
    // Use getCameraForView which correctly handles non-focused views via cached view matrix
    const { position: cameraPosition, axes: cameraAxes } = getCameraForView(vpInfo.viewId);
    return {
      viewId: vpInfo.viewId,
      vpWidth: vpInfo.vpWidth,
      vpHeight: vpInfo.vpHeight,
      vpOffsetX: vpInfo.vpOffsetX,
      vpOffsetY: vpInfo.vpOffsetY,
      vpAspect: vpInfo.vpAspect,
      projectionMatrix: vpInfo.projectionMatrix,
      projectionCenterNdcX: vpInfo.projectionCenterNdcX,
      cameraPosition,
      cameraAxes
    };
  }

  // A camera press with the mouse captures the pointer until it is released:
  // a drag that crosses the sidebar or a plot keeps going to the canvas, so
  // the page does not hit-test hover styles and plot tooltips under it at
  // every move (the release ends the capture by itself). Selection gestures
  // are not captured: where they are let go decides whether they commit.
  let lastMousePointerId = null;
  addPageInputListenerWithCleanup(canvas, 'pointerdown', (e) => {
    if (e.pointerType === 'mouse') lastMousePointerId = e.pointerId;
  });
  function captureCameraPointer() {
    if (lastMousePointerId === null || typeof canvas.setPointerCapture !== 'function') return;
    try {
      canvas.setPointerCapture(lastMousePointerId);
    } catch {
      // The pointer is gone already; there is nothing to capture.
    }
  }

  addEventListenerWithCleanup(canvas, 'mousedown', (e) => {
    if (highlightTools && highlightTools.handlePointerDown(e)) {
      return;
    }
    captureCameraPointer();

    focusViewAtScreenPosition(e.clientX, e.clientY);

    if (navigationMode === 'free') {
      const wantsShot = e.button === 0;
      // Only request pointer lock if user has enabled it via checkbox
      if (pointerLockEnabled && !pointerLockActive) {
        // Pointer lock enabled but not yet active - request it and queue the shot
        // Capture viewport info NOW (before pointer lock changes cursor behavior)
        if (wantsShot) {
          pendingShotViewportInfo = captureProjectileViewport(
            e.clientX,
            e.clientY
          );
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
          const shotViewport = captureProjectileViewport(e.clientX, e.clientY);
          if (shotViewport !== null) {
            projectileSystem.startCharging(shotViewport);
          }
        }
      }
      canvas.classList.add('dragging');
      canvas.style.cursor = pointerLockActive ? 'none' : 'crosshair';
      e.preventDefault();
      return;
    }
    if (navigationMode === 'planar') {
      // Planar mode: always pan (no rotation)
      beginCameraDrag(e.clientX, e.clientY, 'pan');
      canvas.style.cursor = 'move';
    } else if (e.button === 2 || e.shiftKey) {
      beginCameraDrag(e.clientX, e.clientY, 'pan');
      canvas.style.cursor = 'move';
    } else {
      beginCameraDrag(e.clientX, e.clientY, 'rotate');
      canvas.style.cursor = 'grabbing';
    }
    canvas.classList.add('dragging');
  });

  const handleMouseUp = (e) => {
    // The press that focused a pane has ended: the sidebar follows now.
    if (sidebarFocusPending && sidebarFocusTimer === null) commitSidebarFocus();
    if (highlightTools && highlightTools.handlePointerUp(e.target)) {
      invalidateFrame();
      return;
    }
    // A release ends a gesture the viewer owns: a drag, a look, a charged
    // shot. Anywhere else on the page (a click in the sidebar) it changes
    // nothing drawn, and redrawing the scene for a settle window after every
    // such click was a full GPU pass per frame for nothing.
    if (isDragging || lookActive || projectileSystem.isCharging()) {
      invalidateFrame();
    }

    // Fire charged projectile on release, from the pane it was charged in
    // (captured at the press; under pointer lock the cursor no longer moves).
    if (projectileSystem.isCharging() && e.button === 0) {
      projectileSystem.stopChargingAndFire({
        navigationMode,
        pointerLockActive,
        viewportInfo: projectileSystem.getChargeViewportInfo()
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
    releaseCameraDrag();
    canvas.classList.remove('dragging');
    updateSelectionCursor();

    // Save camera state to active view when unlocked
    saveFocusedViewCamera();
  };
  addPageInputListenerWithCleanup(window, 'mouseup', handleMouseUp);

  const handleMouseMove = (e) => {
    // Always track cursor position for aiming (when not in pointer lock)
    if (!pointerLockActive) {
      cursorX = e.clientX;
      cursorY = e.clientY;
    }

    if (highlightTools && highlightTools.handlePointerMove(e)) {
      invalidateFrame();
      return;
    }

    if (navigationMode === 'free') {
      if (!lookActive) return;
      invalidateCameraFrame();
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
    if (e.buttons === 0) {
      invalidateFrame();
      // The release landed where the page could not see it (another window, a
      // system overlay). End the drag, without inertia, instead of steering
      // the camera with no button held.
      isDragging = false;
      velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
      canvas.classList.remove('dragging');
      updateSelectionCursor();
      return;
    }
    invalidateCameraFrame();
    moveCameraDrag(e.clientX, e.clientY);
  };
  addPageInputListenerWithCleanup(window, 'mousemove', handleMouseMove);

  // Invalidates only when the wheel moved the camera (a free-fly wheel, or
  // one against a zoom limit, changes nothing and draws nothing).
  addPageInputListenerWithCleanup(canvas, 'wheel', (e) => {
    e.preventDefault();
    // The wheel zooms the pane under the cursor, as a press would act on it.
    const previousFocus = focusedViewId;
    focusViewAtScreenPosition(e.clientX, e.clientY, 'wheel');
    if (focusedViewId !== previousFocus) invalidateFrame();
    else if (sidebarFocusPending && sidebarFocusTimer !== null) {
      // Still wheeling: the gesture's end moves on.
      clearTimeout(sidebarFocusTimer);
      sidebarFocusTimer = setTimeout(commitSidebarFocus, WHEEL_GESTURE_REST_MS);
    }
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
    if (targetRadius === oldRadius) return;
    invalidateCameraFrame();

    // Planar zoom-to-cursor: adjust target so cursor stays at same world position
    const vpInfo = navigationMode === 'planar' && planarZoomToCursor
      ? getViewportInfoAtScreen(e.clientX, e.clientY)
      : -1;
    if (vpInfo !== -1) {
      // Pane-local coordinates of the pane under the cursor, which the wheel
      // has just focused, against the projection that pane is drawn with.
      // Normalized device coords (-1 to 1) relative to the viewport
      const rawNdcX = (vpInfo.vpLocalX / vpInfo.vpWidth) * 2 - 1;
      const ndcX = rawNdcX - vpInfo.projectionCenterNdcX;
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

    // Save the camera to the focused view.
    setViewCameraState(focusedViewId, getCurrentCameraStateInternal());
  }, { passive: false });

  function updateSelectionCursor() {
    if (highlightTools) {
      highlightTools.updateSelectionCursor();
    }
  }

  const handleAltKeyDown = (e) => {
    if (isTypingTarget(e.target)) return;
    if (e.key === 'Alt') {
      invalidateFrame();
      highlightTools?.handleAltKeyDown?.();
    }
  };
  addPageInputListenerWithCleanup(window, 'keydown', handleAltKeyDown);

  const handleAltKeyUp = (e) => {
    if (isTypingTarget(e.target)) return;
    if (e.key === 'Alt') {
      invalidateFrame();
      highlightTools?.handleAltKeyUp?.();
    }
  };
  addPageInputListenerWithCleanup(window, 'keyup', handleAltKeyUp);

  // Losing focus ends the input the page will never see released: an Alt-armed
  // or in-progress selection (Alt may be let go elsewhere) and held navigation
  // keys. Focus also moves for reasons that change nothing (another window, a
  // system dialog), so the frame is redrawn only when one of those was live:
  // a blanket invalidation redrew the scene for a whole settle window on every
  // focus change.
  const handleWindowBlur = () => {
    const interactionWasLive = highlightTools?.isInteractionActive?.() === true;
    highlightTools?.handleWindowBlur?.();
    if (interactionWasLive) invalidateFrame();
    releaseHeldKeys();
  };
  addPageInputListenerWithCleanup(window, 'blur', handleWindowBlur);

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
      updateSelectionCursor();
    }
    publishPointerLockState(false, errorMessage);
  }

  function retirePointerLockLifecycle(errorMessage = null) {
    // Detach semantic state and the observer before any user-observable DOM
    // or browser callback can re-enter the viewer.
    pointerLockRequestGeneration += 1;
    pointerLockRequestPending = false;
    pointerLockActive = false;
    pointerLockEnabled = false;
    lookActive = false;
    pendingShot = false;
    pendingShotViewportInfo = null;
    activeKeys.clear();
    const handler = pointerLockChangeHandler;
    pointerLockChangeHandler = null;

    const failures = [];
    const attempt = operation => {
      try {
        operation();
      } catch (error) {
        failures.push(error);
      }
    };
    attempt(() => projectileSystem.cancelCharging());
    attempt(() => {
      canvas.classList.remove('dragging', 'free-nav', 'planar-nav');
    });
    attempt(() => {
      canvas.style.cursor = '';
    });
    attempt(() => {
      if (
        document.pointerLockElement === canvas &&
        typeof document.exitPointerLock === 'function'
      ) {
        const result = document.exitPointerLock();
        if (result?.catch) {
          result.catch((error) => {
            try {
              console.error(
                '[Viewer] Pointer-lock exit failed during terminal cleanup.',
                error
              );
            } catch {
              // The synchronous lifecycle is already terminal.
            }
          });
        }
      }
    });
    attempt(() => handler?.(false, errorMessage));
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Pointer-lock retirement was incomplete.'
      );
    }
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

  function isWebGLContextLostForAsyncCommit() {
    if (webglContextLost) return true;
    try {
      return gl.isContextLost() === true;
    } catch {
      // A context whose loss state is no longer queryable is not safe for a
      // new GPU-backed publication. The later context event still owns the
      // complete terminal cleanup graph.
      return true;
    }
  }

  function publishProjectileContextLossCancellation(completion) {
    projectileSystem.setEnabled(false);
    publishProjectileBuildResult(
      completion,
      'cancelled',
      PROJECTILE_CONTEXT_LOSS_MESSAGE
    );
  }

  function settleProjectileBuildAsReady(completion) {
    // Some engines publish physical loss through isContextLost() before they
    // dispatch webglcontextlost. Fence both sides of the local enable commit so
    // that pre-event window can never escape as a successful preparation.
    if (isWebGLContextLostForAsyncCommit()) {
      publishProjectileContextLossCancellation(completion);
      return false;
    }
    projectileSystem.setEnabled(true);
    if (isWebGLContextLostForAsyncCommit()) {
      publishProjectileContextLossCancellation(completion);
      return false;
    }
    publishProjectileBuildResult(completion, 'ready', null);
    return true;
  }

  function detachPendingProjectileBuild() {
    projectileBuildGeneration += 1;
    const completion = projectileBuildCompletion;
    projectileBuildCompletion = null;
    return completion;
  }

  function cancelPendingProjectileBuild(message) {
    const completion = detachPendingProjectileBuild();
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
    invalidateFrame();
    const code = e.code;
    if (pointerLockActive && code === 'Escape') {
      if (document.exitPointerLock) document.exitPointerLock();
      clearPointerLockIntent(null);
      return;
    }
    if (!NAVIGATION_KEY_CODES.has(code)) return;
    // A Cmd or Ctrl chord is a browser or system shortcut (Cmd+Minus, the
    // screenshot keys), not navigation, and macOS sends no keyup for a key
    // pressed while Cmd is held.
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    activeKeys.add(code);
    // A held key moves the camera every frame: the loop must be running.
    ensureFrameScheduled();
  };
  addPageInputListenerWithCleanup(window, 'keydown', handleNavigationKeyDown);

  const handleKeyUp = (e) => {
    // Releasing a held key ends its acceleration; the inertia it leaves keeps
    // the frame drawing through sceneAnimationCause().
    if (activeKeys.delete(e.code)) invalidateFrame();
    // Keys released while Cmd was held never sent their keyup on macOS.
    if (e.key === 'Meta') releaseHeldKeys();
  };
  addPageInputListenerWithCleanup(window, 'keyup', handleKeyUp);
  // A key released while the page was hidden never sends its keyup either.
  // (Blur releases them too, in handleWindowBlur.)
  const handleHeldKeysVisibility = () => {
    if (document.visibilityState === 'hidden') releaseHeldKeys();
  };
  addPageInputListenerWithCleanup(document, 'visibilitychange', handleHeldKeysVisibility);

  // === Touch and pen input ===
  //
  // Fingers and pens arrive as PointerEvents; the mouse keeps the mouse
  // listeners above. Both feed the same highlight pipeline, so a finger arms a
  // selection gesture under exactly the rule an Alt press does
  // (`resolveSelectionGestureCombine`): with select mode on, or a pen pressed
  // with Alt held, one pointer runs the active tool. Otherwise one pointer
  // orbits (pans in planar mode), and two pointers pinch to zoom and move their
  // midpoint to pan, whatever select mode says. A second pointer landing
  // during a selection abandons it rather than committing a half-drawn shape.
  //
  // `touch-action: none` on the canvas keeps the browser from claiming these
  // pointers for page scrolling or zoom, and cancelling the press keeps it
  // from replaying the touch as mouse events the mouse path would also act on.
  // A touch pointer is implicitly captured by the canvas it lands on, so its
  // moves and release keep arriving here even over the sidebar; that is why
  // the release is located with `elementFromPoint` rather than by its target.
  const touchPointers = new Map();
  /** @type {'idle'|'select'|'camera'|'two-pointer'|'spent'} */
  let touchGesture = 'idle';
  let selectPointerId = null;
  let twoPointerLast = null;

  function measureTwoPointers() {
    const [a, b] = touchPointers.values();
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return {
      dist: Math.sqrt(dx * dx + dy * dy),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2
    };
  }

  function beginOnePointerGesture(e) {
    if (highlightTools && highlightTools.handlePointerDown(e)) {
      touchGesture = 'select';
      selectPointerId = e.pointerId;
      return;
    }
    if (navigationMode === 'free') {
      touchGesture = 'spent';
      return;
    }
    focusViewAtScreenPosition(e.clientX, e.clientY);
    // Planar mode: always pan (no rotation)
    beginCameraDrag(
      e.clientX,
      e.clientY,
      navigationMode === 'planar' ? 'pan' : 'rotate'
    );
    touchGesture = 'camera';
  }

  function beginTwoPointerGesture() {
    if (touchGesture === 'select') {
      highlightTools.interruptPointerGesture();
      selectPointerId = null;
    }
    isDragging = false;
    velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
    lastDx = lastDy = 0;
    if (navigationMode === 'free') {
      touchGesture = 'spent';
      return;
    }
    touchGesture = 'two-pointer';
    twoPointerLast = measureTwoPointers();
  }

  addPageInputListenerWithCleanup(canvas, 'pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    invalidateFrame();
    e.preventDefault();
    touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchPointers.size === 1) {
      beginOnePointerGesture(e);
    } else if (touchPointers.size === 2) {
      beginTwoPointerGesture();
    }
  }, { passive: false });

  addPageInputListenerWithCleanup(canvas, 'pointermove', (e) => {
    if (e.pointerType === 'mouse') return;
    const pointer = touchPointers.get(e.pointerId);
    if (pointer === undefined) return;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    if (touchGesture === 'select') {
      invalidateFrame();
      if (e.pointerId === selectPointerId) highlightTools.handlePointerMove(e);
      return;
    }
    // A camera gesture moves only its pane's camera.
    invalidateCameraFrame();
    if (touchGesture === 'camera') {
      moveCameraDrag(e.clientX, e.clientY);
    } else if (touchGesture === 'two-pointer' && touchPointers.size >= 2) {
      const next = measureTwoPointers();
      if (twoPointerLast.dist > 0 && next.dist > 0) {
        targetRadius *= twoPointerLast.dist / next.dist;
        targetRadius = Math.max(minOrbitRadius, Math.min(100.0, targetRadius));
      }
      panCameraByScreenDelta(
        next.midX - twoPointerLast.midX,
        next.midY - twoPointerLast.midY
      );
      twoPointerLast = next;
    }
  });

  const handleTouchPointerEnd = (e) => {
    if (e.pointerType === 'mouse') return;
    if (!touchPointers.has(e.pointerId)) return;
    invalidateFrame();
    touchPointers.delete(e.pointerId);
    if (touchGesture === 'select' && e.pointerId === selectPointerId) {
      selectPointerId = null;
      if (e.type === 'pointercancel') {
        highlightTools.interruptPointerGesture();
      } else {
        highlightTools.handlePointerUp(
          canvas.ownerDocument.elementFromPoint(e.clientX, e.clientY)
        );
      }
      touchGesture = 'spent';
    } else if (touchGesture === 'camera') {
      if (e.type === 'pointercancel') isDragging = false;
      else releaseCameraDrag();
      saveFocusedViewCamera();
      touchGesture = 'spent';
    } else if (touchGesture === 'two-pointer' && touchPointers.size < 2) {
      twoPointerLast = null;
      saveFocusedViewCamera();
      touchGesture = 'spent';
    }
    // Lifting fingers one at a time never turns what is left of a gesture
    // into a new one: the next gesture starts when every finger is up.
    if (touchPointers.size === 0) {
      touchGesture = 'idle';
      if (sidebarFocusPending && sidebarFocusTimer === null) commitSidebarFocus();
    }
  };
  addPageInputListenerWithCleanup(canvas, 'pointerup', handleTouchPointerEnd);
  addPageInputListenerWithCleanup(canvas, 'pointercancel', handleTouchPointerEnd);

  // === Helper Functions ===
  function computePointBoundsFromPositions(positions, dimension) {
    projectileSystem.computePointBoundsFromPositions(positions, dimension);
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
    return _freeflyAxes;
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
    // The focused view and its linked followers use the global state.
    if (isFocused || cameraFollowers.has(vid)) {
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
      vec3.scaleAndAdd(freeflyPosition, freeflyPosition, freeflyVelocity, dt);
    } else {
      // Coasting: each tick decays the velocity, then moves by it, so the
      // distance over the step is the geometric sum from the first decayed
      // velocity (velocity is per second; one tick is 1 / PHYSICS_TICK_RATE
      // seconds). Exact for any step length, and one decayed velocity's tick
      // at exactly one tick.
      const friction = Math.pow(INERTIA_FRICTION, dt * PHYSICS_TICK_RATE);
      const travelSeconds = INERTIA_FRICTION * (1 - friction)
        / (1 - INERTIA_FRICTION) / PHYSICS_TICK_RATE;
      vec3.scaleAndAdd(freeflyPosition, freeflyPosition, freeflyVelocity, travelSeconds);
      vec3.scale(freeflyVelocity, freeflyVelocity, friction);
      if (vec3.length(freeflyVelocity) < INERTIA_MIN_VELOCITY) {
        vec3.set(freeflyVelocity, 0, 0, 0);
      }
    }
  }

  // WASD navigation and zoom for orbit/planar modes
  // Uses velocity system for smooth inertia (same as mouse drag)
  function updateOrbitPlanarKeys(dt) {
    const sprint = (activeKeys.has('ShiftLeft') || activeKeys.has('ShiftRight')) ? 3.0 : 1.0;
    // Key acceleration is specified per reference tick, so a held key builds
    // the same velocity per second at any display rate.
    const ticks = dt * PHYSICS_TICK_RATE;

    if (navigationMode === 'planar') {
      // Planar mode: WASD pans the view using velocity for smooth inertia
      // Respects "Invert axes" checkbox (same as mouse drag)
      const panAccel = radius * 0.15 * planarPanSpeed * sprint * ticks;
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
      const orbitAccel = 0.008 * orbitKeySpeed * sprint * ticks;
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

  /**
   * Advance orbit and pan inertia by `dt` seconds.
   *
   * Velocities are in units per reference tick (PHYSICS_TICK_RATE), and both
   * the motion and the friction scale with the elapsed ticks, as freefly's
   * already do. Applying them once per frame made the camera coast, and a held
   * key accelerate, twice as fast in wall-clock time on a 120 Hz display as on
   * a 60 Hz one, and slower than intended whenever frames ran long. At exactly
   * one tick per frame this is the per-frame update it replaces.
   */
  function updateInertia(dt) {
    const ticks = dt * PHYSICS_TICK_RATE;
    const friction = Math.pow(INERTIA_FRICTION, ticks);
    // Distance covered over `ticks` ticks of a velocity decaying by the
    // friction each tick: the geometric sum, exact for a fractional or long
    // step and exactly one velocity at one tick.
    const travel = (1 - friction) / (1 - INERTIA_FRICTION);
    if (Math.abs(velocityTheta) > INERTIA_MIN_VELOCITY || Math.abs(velocityPhi) > INERTIA_MIN_VELOCITY) {
      theta += velocityTheta * travel;
      phi += velocityPhi * travel;
      const EPS = 0.05;
      phi = Math.max(EPS, Math.min(Math.PI - EPS, phi));
      while (theta > Math.PI * 2) theta -= Math.PI * 2;
      while (theta < 0) theta += Math.PI * 2;
      velocityTheta *= friction;
      velocityPhi *= friction;
      if (Math.abs(velocityTheta) < INERTIA_MIN_VELOCITY) velocityTheta = 0;
      if (Math.abs(velocityPhi) < INERTIA_MIN_VELOCITY) velocityPhi = 0;
    }

    const panVelocityMag = Math.sqrt(velocityPanX * velocityPanX + velocityPanY * velocityPanY + velocityPanZ * velocityPanZ);
    if (panVelocityMag > INERTIA_MIN_VELOCITY) {
      target[0] += velocityPanX * travel;
      target[1] += velocityPanY * travel;
      target[2] += velocityPanZ * travel;
      velocityPanX *= friction;
      velocityPanY *= friction;
      velocityPanZ *= friction;
      if (panVelocityMag * friction < INERTIA_MIN_VELOCITY) {
        velocityPanX = velocityPanY = velocityPanZ = 0;
      }
    }
  }

  /**
   * Ease the orbit radius toward its target: 15 % of the remaining distance
   * per reference tick, compounded over the ticks `dt` spans, so a zoom takes
   * the same time at any display rate.
   */
  function updateSmoothZoom(dt) {
    const diff = targetRadius - radius;
    if (Math.abs(diff) > 0.001) {
      radius += diff * (1 - Math.pow(1 - SMOOTH_ZOOM_RATE, dt * PHYSICS_TICK_RATE));
    } else {
      radius = targetRadius;
    }
  }

  /**
   * The presented layout: every pane's place on the canvas, resolved from the
   * canvas size, the sidebar's left occlusion, the layout mode, and the
   * presented view inventory. It is recomputed only when one of those inputs
   * changes; between changes every caller receives the same frozen object, so
   * per-frame use is a handful of scalar comparisons.
   *
   * Returns null while the canvas has no area.
   */
  function getPresentedLayout() {
    const size = canvasResizeObserver.getSize();
    const width = size.width;
    const height = size.height;
    const cssWidth = size.cssWidth;
    const cssHeight = size.cssHeight;
    if (!(width > 0 && height > 0 && cssWidth > 0 && cssHeight > 0)) {
      return null;
    }
    const snapshotCount = snapshotViews.length;
    let inventoryMatches =
      presentedLayout !== null &&
      presentedLayoutKey.liveViewHidden === liveViewHidden &&
      presentedLayoutKey.snapshotIds.length === snapshotCount;
    if (inventoryMatches) {
      for (let index = 0; index < snapshotCount; index += 1) {
        if (presentedLayoutKey.snapshotIds[index] !== snapshotViews[index].id) {
          inventoryMatches = false;
          break;
        }
      }
    }
    if (
      inventoryMatches &&
      presentedLayoutKey.width === width &&
      presentedLayoutKey.height === height &&
      presentedLayoutKey.cssWidth === cssWidth &&
      presentedLayoutKey.cssHeight === cssHeight &&
      presentedLayoutKey.leftOcclusionRatio === viewportLeftOcclusionRatio &&
      presentedLayoutKey.mode === viewLayoutMode &&
      presentedLayoutKey.focusedViewId === focusedViewId
    ) {
      return presentedLayout;
    }
    const viewIds = [];
    if (!liveViewHidden) viewIds.push(LIVE_VIEW_ID);
    for (const snapshot of snapshotViews) viewIds.push(snapshot.id);
    const layout = resolvePresentedLayout({
      canvasHeight: height,
      canvasWidth: width,
      cssHeight,
      cssWidth,
      focusedViewId,
      leftOcclusionRatio: viewportLeftOcclusionRatio,
      mode: viewLayoutMode,
      viewIds
    });
    presentedPaneProjections.length = 0;
    for (const pane of layout.panes) {
      presentedPaneProjections.push(
        configurePaneProjection(mat4.create(), pane)
      );
    }
    presentedLayout = layout;
    presentedLayoutKey.width = width;
    presentedLayoutKey.height = height;
    presentedLayoutKey.cssWidth = cssWidth;
    presentedLayoutKey.cssHeight = cssHeight;
    presentedLayoutKey.leftOcclusionRatio = viewportLeftOcclusionRatio;
    presentedLayoutKey.mode = viewLayoutMode;
    presentedLayoutKey.focusedViewId = focusedViewId;
    presentedLayoutKey.liveViewHidden = liveViewHidden;
    presentedLayoutKey.snapshotIds.length = 0;
    for (const snapshot of snapshotViews) {
      presentedLayoutKey.snapshotIds.push(snapshot.id);
    }
    // Observers (e.g. the selection bar) place themselves from the same
    // resolved layout the panes are drawn with. An observer failure is
    // reported without interrupting the frame that resolved the layout.
    for (const listener of presentedLayoutListeners) {
      try {
        listener(layout);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
    return layout;
  }

  /** The projection one pane renders with: its aspect, its principal point. */
  function configurePaneProjection(output, pane) {
    mat4.perspective(
      output,
      fov,
      pane.viewportWidth / pane.viewportHeight,
      near,
      far
    );
    applyHorizontalProjectionCenter(output, pane.projectionCenterNdcX);
    return output;
  }

  /** The cached projection of one pane of the current presented layout. */
  function getPresentedPaneProjection(layout, paneIndex) {
    if (layout !== presentedLayout) {
      throw new Error('Pane projection requested for a superseded presented layout.');
    }
    const matrix = presentedPaneProjections[paneIndex];
    if (matrix === undefined) {
      throw new RangeError(`Presented pane ${paneIndex} does not exist.`);
    }
    return matrix;
  }

  /**
   * The full-canvas projection: the single-view projection, whose principal
   * point sits at the centre of the presented area. It is the viewer's
   * ambient projection outside grid panes.
   */
  function configureFullCanvasProjection(output, aspect) {
    mat4.perspective(output, fov, aspect, near, far);
    const layout = getPresentedLayout();
    applyHorizontalProjectionCenter(
      output,
      layout === null
        ? 0
        : layout.presentedArea.cssLeft / layout.cssWidth
    );
    return output;
  }

  function updateCamera(width, height) {
    configureFullCanvasProjection(projectionMatrix, width / height);
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

  /**
   * The positions a pane's connectivity edges are drawn from: the renderer's
   * published source-order positions of that view, with their geometry
   * generation (the edge layer uploads a position texture the first time a
   * pane draws new positions).
   */
  function getCertifiedEdgeGeometry(viewId) {
    const vid = assertViewId(viewId);
    const generationBefore =
      hpRenderer.getViewGeometryGeneration(vid);
    const positions = vid === LIVE_VIEW_ID
      ? hpRenderer.getPositions()
      : hpRenderer.getSnapshotPositions(vid);
    const dimension = hpRenderer.getViewPositionDimension(vid);
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
      ![1, 2, 3].includes(dimension) ||
      positions.length % dimension !== 0
    ) {
      throw new Error(
        `Renderer published invalid connectivity positions for view "${vid}".`
      );
    }
    const nCells = positions.length / dimension;
    if (
      !Number.isSafeInteger(nCells) ||
      nCells <= 0 ||
      (pointCount > 0 && nCells !== pointCount)
    ) {
      throw new RangeError(
        `Renderer connectivity geometry for view "${vid}" has an incompatible cell count.`
      );
    }
    return {
      dimension,
      generation: generationAfter,
      nCells,
      positions,
    };
  }

		  function drawGrid() {
		    // Allow fade-out transition to complete before stopping render
		    if (gridOpacity <= 0) return;
		    gl.useProgram(gridProgram);
		    gl.uniformMatrix4fv(gridUniformLocations.mvpMatrix, false, mvpMatrix);
		    gl.uniformMatrix4fv(gridUniformLocations.modelMatrix, false, modelMatrix);
		    gl.uniform3fv(gridUniformLocations.gridColor, gridColor);
		    gl.uniform3fv(gridUniformLocations.bgColor, gridBgColor);
		    gl.uniform1f(gridUniformLocations.gridSpacing, gridSpacing);
		    gl.uniform1f(gridUniformLocations.gridLineWidth, gridLineWidth);
		    gl.uniform1f(gridUniformLocations.gridOpacity, gridOpacity);
		    gl.uniform1f(gridUniformLocations.gridSize, GRID_SIZE);

    // Scientific axis colors (RGB for XYZ)
    gl.uniform3fv(gridUniformLocations.axisXColor, axisXColor);
    gl.uniform3fv(gridUniformLocations.axisYColor, axisYColor);
    gl.uniform3fv(gridUniformLocations.axisZColor, axisZColor);

    configureStraightAlphaBlending(gl);

    try {
      gl.depthMask(false);

      // Extract view direction from view matrix (works correctly in multiview unlocked camera mode)
      // The view matrix's third row (column-major indices 2, 6, 10) gives the camera's forward axis
      // This is the direction from camera toward target, which is what we need for plane visibility
      const viewDirX = -viewMatrix[2];
      const viewDirY = -viewMatrix[6];
      const viewDirZ = -viewMatrix[10];
      // The view matrix's rotation part is orthonormal, so viewDir is already normalized

      // Plane normals (outward facing from box center) are generation-owned by
      // gridPlaneDescriptors so multiview frames allocate no transient records.
      // We want to show planes that are "behind" the data (facing away from camera)
      // A plane is visible when dot(viewDir, planeNormal) > 0 (camera looking toward plane)

      // Render planes with smooth alpha based on viewing angle
      for (
        let planeIndex = 0;
        planeIndex < gridPlaneDescriptors.length;
        planeIndex++
      ) {
        const plane = gridPlaneDescriptors[planeIndex];
        // Dot product: positive = camera looking toward this plane (plane is visible)
        const dot =
          viewDirX * plane.normalX +
          viewDirY * plane.normalY +
          viewDirZ * plane.normalZ;

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
        gl.bindBuffer(
          gl.ARRAY_BUFFER,
          gridPlaneBuffers[plane.bufferKey]
        );
        gl.enableVertexAttribArray(gridAttribLocations.position);
        gl.vertexAttribPointer(gridAttribLocations.position, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    } finally {
      // Depth writes are a viewer-owned baseline even when a grid uniform,
      // buffer publication, or draw fails partway through a pane.
      gl.depthMask(true);
    }
  }

  /**
   * The studio backdrop's record for one view. Its geometry is derived from
   * the view's published positions and re-derived only when they are
   * replaced, so a steady frame reads it without scanning or allocating.
   */
  function getStudioPaneState(viewId) {
    const { positions, dimension } = getExactViewPositionRecord(viewId);
    let state = studioPaneStates.get(viewId);
    if (state === undefined) {
      state = {
        positions: null,
        dimension: 0,
        floorY: 0,
        flat: false,
        centerY: 0,
        extentY: 0,
        stageX: 0,
        stageZ: 0,
        extentX: 0,
        extentZ: 0,
        // Unset until the first draw, which starts on the target surface.
        planarity: -1,
      };
      studioPaneStates.set(viewId, state);
    }
    if (state.positions !== positions || state.dimension !== dimension) {
      resolveStudioPaneGeometry(
        positions.length === 0 ? null : readPositionBounds(positions, dimension),
        dimension,
        state
      );
      state.positions = positions;
      state.dimension = dimension;
    }
    return state;
  }

  /**
   * Paint one pane's studio backdrop: background, floor and dot surface in a
   * single opaque full-pane pass, drawn first with the pane's current
   * matrices. Panes crossfade between the floor and the dot surface when
   * their dimension or navigation mode changes; while one does, the next
   * frame is owed (`sceneAnimationCause`).
   */
  function drawStudioBackdrop(
    viewId,
    pixelRatio,
    glowCenterX,
    paneNavigationMode,
    dtSeconds
  ) {
    if (studioOpacity <= 0) return;
    const state = getStudioPaneState(viewId);
    const target = studioSurfacePlanarity(state.dimension, paneNavigationMode);
    if (state.planarity < 0) {
      state.planarity = target;
    } else if (state.planarity !== target) {
      const step = prefersReducedMotion()
        ? Infinity
        : dtSeconds / STUDIO_SURFACE_TRANSITION_SECONDS;
      state.planarity = target > state.planarity
        ? Math.min(target, state.planarity + step)
        : Math.max(target, state.planarity - step);
      if (state.planarity !== target) studioSurfaceInTransition = true;
    }
    // A singular camera has no rays to cast; the pane keeps its clear colour.
    if (
      mat4.invert(_studioInvMvpMatrix, mvpMatrix) === null ||
      mat4.invert(_studioInvViewMatrix, viewMatrix) === null
    ) {
      return;
    }
    // The model matrix is the identity, so the camera's world position is
    // also its position in the model space the floor is defined in.
    _studioEye[0] = _studioInvViewMatrix[12];
    _studioEye[1] = _studioInvViewMatrix[13];
    _studioEye[2] = _studioInvViewMatrix[14];

    const locations = studioUniformLocations;
    gl.useProgram(studioProgram);
    gl.bindVertexArray(studioVao);
    gl.uniformMatrix4fv(locations.invMvpMatrix, false, _studioInvMvpMatrix);
    gl.uniform3fv(locations.eye, _studioEye);
    gl.uniform1f(locations.pixelRatio, pixelRatio);
    gl.uniform3fv(locations.surfaceColor, bgColor);
    gl.uniform3fv(locations.glowColor, studioGlowColor);
    gl.uniform1f(locations.glowCenterX, glowCenterX);
    gl.uniform3fv(locations.inkColor, studioInkColor);
    gl.uniform1f(locations.lineMinorAlpha, studioPalette.lineMinorAlpha);
    gl.uniform1f(locations.lineMajorAlpha, studioPalette.lineMajorAlpha);
    gl.uniform1f(locations.dotMinorAlpha, studioPalette.dotMinorAlpha);
    gl.uniform1f(locations.dotMajorAlpha, studioPalette.dotMajorAlpha);
    gl.uniform1f(locations.opacity, studioOpacity);
    const weights = resolveStudioSurfaceWeights(
      state.planarity,
      _studioSurfaceWeights
    );
    const floorWeight = weights.floor;
    gl.uniform1f(locations.floorWeight, floorWeight);
    gl.uniform1f(locations.floorY, state.floorY);
    gl.uniform2f(locations.stageCenter, state.stageX, state.stageZ);
    gl.uniform1f(locations.backdropWeight, weights.backdrop);
    const plane = resolveStudioBackdropPlane(viewMatrix, state, _studioBackPlane);
    gl.uniform3f(locations.backNormal, plane.normalX, plane.normalY, plane.normalZ);
    gl.uniform1f(locations.backOffset, plane.offset);
    gl.uniform3f(locations.backU, plane.uX, plane.uY, plane.uZ);
    gl.uniform3f(locations.backV, plane.vX, plane.vY, plane.vZ);
    // The pool belongs to the floor and fades with it.
    resolveStudioPool(mvpMatrix, _studioEye, state, _studioPool);
    const poolStrength =
      _studioPool.gate * studioPalette.poolAlpha * floorWeight;
    if (poolStrength > 0) {
      const pool = _studioPool;
      const determinant = pool.axisAX * pool.axisBY - pool.axisBX * pool.axisAY;
      _studioPoolInverse[0] = pool.axisBY / determinant;
      _studioPoolInverse[1] = -pool.axisAY / determinant;
      _studioPoolInverse[2] = -pool.axisBX / determinant;
      _studioPoolInverse[3] = pool.axisAX / determinant;
      gl.uniform2f(locations.poolCenter, pool.centerX, pool.centerY);
      gl.uniformMatrix2fv(locations.poolInverse, false, _studioPoolInverse);
    }
    gl.uniform1f(locations.poolStrength, poolStrength);
    try {
      gl.depthMask(false);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } finally {
      gl.depthMask(true);
      gl.bindVertexArray(null);
    }
  }

  /**
   * Paint one pane's backdrop look (rendering/backdrops/), when one is
   * active: one opaque full-pane pass drawn right after the studio slot and
   * before the grid and points.
   */
  function drawBackdropLook(
    viewId,
    pixelRatio,
    glowCenterX,
    paneNavigationMode,
    viewportWidth,
    viewportHeight
  ) {
    if (!backdropLooks.isActive()) return;
    const state = getStudioPaneState(viewId);
    if (
      mat4.invert(_studioInvMvpMatrix, mvpMatrix) === null ||
      mat4.invert(_studioInvViewMatrix, viewMatrix) === null
    ) {
      return;
    }
    _studioEye[0] = _studioInvViewMatrix[12];
    _studioEye[1] = _studioInvViewMatrix[13];
    _studioEye[2] = _studioInvViewMatrix[14];
    backdropLooks.draw({
      viewId,
      invMvp: _studioInvMvpMatrix,
      mvp: mvpMatrix,
      projection: projectionMatrix,
      eye: _studioEye,
      pixelRatio,
      glowCenterX,
      viewportWidth,
      viewportHeight,
      planar: studioSurfacePlanarity(state.dimension, paneNavigationMode),
      geometry: state,
    });
  }

  /** `value` moved toward `target` by at most `step`, landing on it exactly. */
  function moveToward(value, target, step) {
    if (value < target) return Math.min(target, value + step);
    if (value > target) return Math.max(target, value - step);
    return value;
  }

  // Decorative transitions (backdrop fades and crossfades) complete at once
  // when the user asked the system for reduced motion.
  const reducedMotionQuery =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
  function prefersReducedMotion() {
    return reducedMotionQuery !== null && reducedMotionQuery.matches === true;
  }

  // Smoothstep helper for smooth transitions
  function smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  function drawConnectivityLines(
    widthPx,
    heightPx,
    viewId,
    paneFogNear,
    paneFogFar
  ) {
    if (!showConnectivity || !useInstancedEdges || !edgeLayer.hasView(viewId)) {
      return;
    }
    if (
      !Number.isFinite(paneFogNear) ||
      paneFogNear < 0 ||
      !Number.isFinite(paneFogFar) ||
      paneFogFar < paneFogNear
    ) {
      throw new RangeError(
        `Connectivity fog range for view "${viewId}" is invalid.`
      );
    }
    mat4.multiply(edgeModelViewMatrix, viewMatrix, modelMatrix);
    edgeFrame.mvpMatrix = mvpMatrix;
    edgeFrame.widthPx = widthPx;
    edgeFrame.heightPx = heightPx;
    edgeFrame.lineWidth = connectivityLineWidth;
    edgeFrame.lineColor[0] = connectivityColorBytes[0] / 255;
    edgeFrame.lineColor[1] = connectivityColorBytes[1] / 255;
    edgeFrame.lineColor[2] = connectivityColorBytes[2] / 255;
    edgeFrame.lineAlpha = connectivityAlpha;
    edgeFrame.fogDensity = fogDensity;
    edgeFrame.fogNear = paneFogNear;
    edgeFrame.fogFar = paneFogFar;
    edgeLayer.draw(viewId, edgeFrame);
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

    // The live buffers are replaced on every centroid publication, so the
    // pointers are re-recorded into the pass's own vertex array per draw.
    gl.bindVertexArray(centroidVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, centroidPositionBuffer);
    gl.enableVertexAttribArray(centroidAttribLocations.position);
    gl.vertexAttribPointer(centroidAttribLocations.position, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, centroidColorBuffer);
    gl.enableVertexAttribArray(centroidAttribLocations.color);
    gl.vertexAttribPointer(centroidAttribLocations.color, 4, gl.UNSIGNED_BYTE, true, 0, 0); // RGBA uint8 normalized

    configureStraightAlphaBlending(gl);
    gl.drawArrays(gl.POINTS, 0, numPoints);
    gl.bindVertexArray(null);
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
   */
  function createCentroidSnapshotBuffer(viewId, positions, colors) {
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

    const existing = centroidSnapshotBuffers.get(vid) ?? null;
    if (existing !== null && buffer.byteLength <= existing.byteCapacity) {
      // Accepted storage that holds the new centroids is written in place:
      // no allocation, so only a lost context refuses it and no error is
      // read back (a GPU round trip). Its vertex array still describes it.
      requireLiveContext(gl, 'Centroid snapshot publication');
      gl.bindBuffer(gl.ARRAY_BUFFER, existing.buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, buffer);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      requireLiveContext(gl, 'Centroid snapshot publication');
      existing.count = count;
      existing.colorsOwner = colors;
      existing.positionsOwner = positions;
      return true;
    }

    // Create GPU buffer (STATIC_DRAW - uploaded once)
    requireLiveContext(gl, 'Centroid snapshot publication');
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
      // The one read: a refused allocation must not stay resident.
      requireCleanWebGLState(gl, 'Candidate centroid snapshot publication');
    } catch (error) {
      const rollbackFailures = [];
      for (const operation of [
        () => gl.bindVertexArray(null),
        () => gl.bindBuffer(gl.ARRAY_BUFFER, null),
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
      byteCapacity: buffer.byteLength,
      count,
      colorsOwner: colors,
      positionsOwner: positions,
    };
    const previous = existing;
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
   * Check whether the exact immutable centroid data owners lack a matching VAO.
   * @param {string} viewId - View identifier
   * @param {Float32Array} positions - Exact published position owner
   * @param {Uint8Array} colors - Exact published color owner
   * @returns {boolean} True if buffer needs to be (re)created
   */
  function centroidBufferNeedsUpdate(viewId, positions, colors) {
    const vid = String(viewId);
    const existing = centroidSnapshotBuffers.get(vid);
    return !centroidSnapshotBufferOwnsData(
      existing,
      positions,
      colors
    );
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
    configureStraightAlphaBlending(gl);
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

  /**
   * The presented pane under one client point, with everything an
   * interaction needs to map that point into the pane's view: the pane's
   * render rectangle (`vpOffset*`, `vpWidth`, `vpHeight`, canvas-local CSS
   * pixels) and the point inside it (`vpLocal*`), the presented part of that
   * rectangle (`visible*`), and the exact camera and projection the pane is
   * drawn with. Returns -1 over an empty grid slot. Every screen-to-view
   * mapping (picking, focus, highlight tools, projectiles, zoom-to-cursor)
   * goes through here, so all of them follow the presented layout.
   */
  function getViewportInfoAtScreen(screenX, screenY) {
    const layout = getPresentedLayout();
    if (layout === null) return -1;
    // Read the camera as it is now, not as the last frame drew it: the view
    // matrix is otherwise refreshed only when a frame renders, so a pointer
    // read right after the camera moved landed on the previous picture.
    const canvasSize = canvasResizeObserver.getSize();
    updateCamera(canvasSize.width, canvasSize.height);
    const rect = canvas.getBoundingClientRect();
    const localX = screenX - rect.left;
    const localY = screenY - rect.top;
    const pane = getPresentedPaneAtCssPoint(layout, localX, localY);
    if (pane === null) return -1;
    const paneIndex = layout.panes.indexOf(pane);
    const clickedViewId = pane.viewId;
    const vpWidth = pane.cssWidth;
    const vpHeight = pane.cssHeight;
    const vpOffsetX = pane.cssLeft;
    const vpOffsetY = pane.cssTop;
    const viewCount = layout.viewCount;

    // Get effective view matrix for the viewport
    let effectiveViewMatrix = null;
    let effectiveTargetRadius = targetRadius;
    if (!cameraFollowers.has(clickedViewId) && viewCount > 1) {
      const cameraState = assertCameraState(
        getViewCameraState(clickedViewId),
        `Viewport camera state for view "${clickedViewId}"`
      );
      effectiveTargetRadius = cameraState.orbit.targetRadius;
      const cached = cachedViewMatrices.get(clickedViewId);
      if (cached && cached.viewMatrix) {
        effectiveViewMatrix = cached.viewMatrix;
      } else {
        effectiveViewMatrix = mat4.create();
        computeViewMatrixFromState(cameraState, effectiveViewMatrix);
      }
    }

    const projectionCenterNdcX = pane.projectionCenterNdcX;
    const viewportProjectionMatrix = mat4.clone(
      getPresentedPaneProjection(layout, paneIndex)
    );
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
      vpLocalX: localX - vpOffsetX,
      vpLocalY: localY - vpOffsetY,
      visibleOffsetX: pane.visibleCssLeft,
      visibleOffsetY: pane.visibleCssTop,
      visibleWidth: pane.visibleCssWidth,
      visibleHeight: pane.visibleCssHeight,
      viewId: clickedViewId,
      effectiveViewMatrix,
      // The framebuffer aspect: the one the pane is rendered with.
      vpAspect: pane.viewportWidth / pane.viewportHeight,
      framebufferHeight: pane.viewportHeight,
      projectionCenterNdcX,
      projectionMatrix: viewportProjectionMatrix,
      cameraForward,
      cameraTargetRadius: effectiveTargetRadius
    };
  }

  /**
   * @param {number} screenX
   * @param {number} screenY
   * @param {boolean} buildIndex - Build a large pane's spatial index now if it
   *   is missing (a click: the user asked, and waits). A hover reader passes
   *   false: a large pane without an index answers null rather than blocking
   *   the page for the build.
   */
  const pickMvpScratch = mat4.create();

  function pickCellRecordWith(screenX, screenY, buildIndex) {
    const viewport = getViewportInfoAtScreen(screenX, screenY);
    if (viewport === -1) return null;
    // Only what the pane presents can be picked: nothing under the sidebar,
    // nothing in the slack between grid cells.
    const canvasX = viewport.vpOffsetX + viewport.vpLocalX;
    const canvasY = viewport.vpOffsetY + viewport.vpLocalY;
    if (
      canvasX < viewport.visibleOffsetX ||
      canvasX >= viewport.visibleOffsetX + viewport.visibleWidth ||
      canvasY < viewport.visibleOffsetY ||
      canvasY >= viewport.visibleOffsetY + viewport.visibleHeight
    ) {
      return null;
    }
    const {
      vpLocalX,
      vpLocalY,
      vpWidth,
      vpHeight,
      framebufferHeight,
      effectiveViewMatrix,
      projectionMatrix: paneProjectionMatrix,
      viewId: clickedViewId
    } = viewport;

    // A large pane's click before its tree lands scans every point (the
    // same exact pick, a few milliseconds a million cells) and asks for the
    // tree off the main thread; a hover read waits for the tree. Small panes
    // always scan.
    const queryOwner = getSpatialQueryOwner(clickedViewId, buildIndex);
    const positions = queryOwner.positions;
    if (
      !buildIndex
      && queryOwner.spatialIndex === null
      && positions.length / queryOwner.dimensionLevel
        >= INTERACTIVE_SPATIAL_INDEX_POINT_THRESHOLD
    ) {
      return null;
    }
    const lodMembership = hpRenderer.getCurrentLodMembership(
      clickedViewId,
      queryOwner.dimensionLevel
    );

    // The pane exactly as drawn: its projection, its camera, the model matrix,
    // and the point-size uniforms the vertex shader sizes every dot with.
    const paneMvp = mat4.multiply(
      pickMvpScratch,
      paneProjectionMatrix,
      // A pane without a camera of its own is drawn with the shared one.
      effectiveViewMatrix ?? viewMatrix
    );
    mat4.multiply(paneMvp, paneMvp, modelMatrix);
    const pick = findScreenSpacePick({
      dimension: queryOwner.dimensionLevel,
      lodMembership,
      positions,
      transparency: queryOwner.transparency,
      spatialIndex: queryOwner.spatialIndex,
      mvpMatrix: paneMvp,
      cursor: { x: vpLocalX, y: vpLocalY },
      pane: { cssWidth: vpWidth, cssHeight: vpHeight, framebufferHeight },
      pointSize: basePointSize,
      sizeAttenuation,
      fov
    });
    if (pick.cellIndex === -1) return null;

    const [x, y, z] = readPositionXYZ(
      positions,
      queryOwner.dimensionLevel,
      pick.cellIndex,
      [0, 0, 0]
    );
    const position = Object.freeze({ x, y, z });
    return Object.freeze({
      viewId: clickedViewId,
      cellIndex: pick.cellIndex,
      position
    });
  }

  function pickCellRecordAtScreen(screenX, screenY) {
    return pickCellRecordWith(screenX, screenY, true);
  }

  function pickReadyCellRecordAtScreen(screenX, screenY) {
    return pickCellRecordWith(screenX, screenY, false);
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

  function shouldShowCentroidPoints(viewId) {
    const flags = viewCentroidFlags.get(assertViewId(viewId));
    return flags?.points ?? defaultShowCentroidPoints;
  }

  function shouldShowCentroidLabels(viewId) {
    const flags = viewCentroidFlags.get(assertViewId(viewId));
    return flags?.labels ?? defaultShowCentroidLabels;
  }

  function setViewFlags(viewId, partial) {
    const key = assertKnownViewId(viewId);
    const prev = viewCentroidFlags.get(key) || {};
    const previousPoints = prev.points ?? defaultShowCentroidPoints;
    const previousLabels = prev.labels ?? defaultShowCentroidLabels;
    const nextPoints = partial.points != null
      ? partial.points
      : previousPoints;
    const nextLabels = partial.labels != null
      ? partial.labels
      : previousLabels;
    if (
      nextPoints === previousPoints &&
      nextLabels === previousLabels
    ) {
      return false;
    }
    viewCentroidFlags.set(key, {
      points: nextPoints,
      labels: nextLabels
    });
    return true;
  }

  function getLabelsForView(viewId) {
    return (
      viewCentroidLabels.get(assertViewId(viewId)) ??
      EMPTY_CENTROID_LABELS
    );
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
    const labels =
      viewCentroidLabels.get(assertViewId(viewId)) ??
      EMPTY_CENTROID_LABELS;
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
    hiddenCentroidLabelViews.delete(key);
    const labels =
      viewCentroidLabels.get(key) ??
      EMPTY_CENTROID_LABELS;
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
    const key = assertViewId(viewId);
    if (hiddenCentroidLabelViews.has(key)) return;
    const labels = getLabelsForView(key);
    for (const item of labels) {
      const element = item?.el;
      if (!element) continue;
      let previous = centroidLabelPresentation.get(element);
      if (!previous) {
        previous = {
          visible: null,
          screenX: Number.NaN,
          screenY: Number.NaN
        };
        centroidLabelPresentation.set(element, previous);
      }
      if (
        previous.visible !== false ||
        element.style.display !== 'none'
      ) {
        element.style.display = 'none';
      }
      previous.visible = false;
    }
    hiddenCentroidLabelViews.add(key);
  }

  function updateLabelLayerVisibility() {
    labelLayerAnyVisible = false;
    labelLayerSingleMode = viewLayoutMode === 'single';
    labelLayerFocusKey = String(focusedViewId || LIVE_VIEW_ID);
    // forEach with a hoisted callback rather than an entries() iterator: this
    // runs on every drawn frame.
    viewCentroidLabels.forEach(updateLabelLayerVisibilityForView);
    if (labelLayer) {
      const display = labelLayerAnyVisible ? 'block' : 'none';
      if (labelLayer.style.display !== display) {
        labelLayer.style.display = display;
      }
    }
  }

  let labelLayerAnyVisible = false;
  let labelLayerSingleMode = false;
  let labelLayerFocusKey = '';
  function updateLabelLayerVisibilityForView(labels, viewId) {
    // In single mode the first visible label settles the layer.
    if (labelLayerAnyVisible && labelLayerSingleMode) return;
    if (!shouldShowCentroidLabels(viewId) || !labels.length) return;
    const isActiveView = String(viewId) === labelLayerFocusKey;
    if (labelLayerSingleMode && !isActiveView) {
      hideLabelsForView(viewId);
      return;
    }
    if (labelLayerAnyVisible) return;
    for (let index = 0; index < labels.length; index++) {
      const item = labels[index];
      if (item?.el && item.el.style.display !== 'none') {
        labelLayerAnyVisible = true;
        return;
      }
    }
  }

  /**
   * Update view title chips: one per grid pane, centred on the top edge of
   * the pane's presented rectangle.
   * @param {Array} views - Array of view objects with id and label
   * @param {Object} layout - The presented layout the panes belong to
   */
  // What each pane's title chip says before its field: the view's number and
  // what it shows ("2 · PCA 2D"), published by the view controls.
  const viewTitlePrefixes = new Map();
  function viewTitleText(view) {
    const label = view.label || view.id;
    const prefix = viewTitlePrefixes.get(view.id) ?? null;
    return prefix === null ? label : `${prefix} · ${label}`;
  }

  function updateViewTitles(views, layout) {
    if (!viewTitleLayerEl) return;

    let inventoryMatches =
      viewTitleEntries.length === views.length;
    if (inventoryMatches) {
      for (let index = 0; index < views.length; index++) {
        const view = views[index];
        const entry = viewTitleEntries[index];
        const label = viewTitleText(view);
        if (
          entry.viewId !== view.id ||
          entry.label !== label
        ) {
          inventoryMatches = false;
          break;
        }
      }
    }
    if (inventoryMatches) {
      // Just update positions (in case the layout changed)
      repositionViewTitles(layout);
      return;
    }

    // Clear existing chips
    for (const entry of viewTitleEntries) {
      entry.el?.remove();
    }
    viewTitleEntries = [];

    for (let i = 0; i < views.length; i++) {
      const view = views[i];
      const viewId = view.id;
      const label = viewTitleText(view);
      const chip = document.createElement('div');
      chip.className = 'view-title-chip';
      // Mark active view
      if (viewId === focusedViewId) {
        chip.classList.add('active');
      }
      chip.textContent = label;
      chip.title = label;
      chip.dataset.viewId = viewId;

      // Click handler to focus this view
      chip.addEventListener('click', () => {
        if (viewId !== focusedViewId) {
          transferViewFocus(viewId, { saveOutgoing: true });
          publishPresentedViewStateChange(
            'focus',
            focusedViewId
          );
        }
        // An explicit choice of pane: the sidebar follows at once.
        sidebarFocusPending = false;
        if (sidebarFocusTimer !== null) {
          clearTimeout(sidebarFocusTimer);
          sidebarFocusTimer = null;
        }
        if (viewFocusHandler) viewFocusHandler(viewId);
      });

      viewTitleLayerEl.appendChild(chip);
      viewTitleEntries.push({
        el: chip,
        viewId,
        label
      });
    }
    lastTitleLayout = null;
    repositionViewTitles(layout);
  }

  function repositionViewTitles(layout) {
    // Positions change only with the layout, which is one stable object
    // between geometry changes.
    if (layout === lastTitleLayout) return;
    lastTitleLayout = layout;

    for (let i = 0; i < viewTitleEntries.length; i++) {
      const entry = viewTitleEntries[i];
      const pane = layout.panes[i];
      if (!entry.el || pane === undefined) continue;
      const x = pane.visibleCssLeft + pane.visibleCssWidth / 2;
      const y = pane.visibleCssTop + VIEW_TITLE_TOP_OFFSET_PX;
      entry.el.style.setProperty('--view-title-x', `${x}px`);
      entry.el.style.setProperty('--view-title-y', `${y}px`);
      entry.el.style.setProperty('--view-title-pane-width', `${pane.visibleCssWidth}px`);
    }
  }

  function hideViewTitles() {
    for (const entry of viewTitleEntries) {
      if (
        entry.el &&
        entry.el.style.display !== 'none'
      ) {
        entry.el.style.display = 'none';
      }
    }
  }

  function showViewTitles() {
    for (const entry of viewTitleEntries) {
      if (
        entry.el &&
        entry.el.style.display !== ''
      ) {
        entry.el.style.display = '';
      }
    }
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

  /**
   * Place one pane's centroid labels. Projection maps NDC onto the pane's
   * render rectangle; a label is shown only inside its presented part, so no
   * label sits under the sidebar or over a neighbouring grid cell.
   */
  function updateCentroidLabelPositions(labels, pane, viewId) {
    hiddenCentroidLabelViews.delete(viewId);
    // Pane rectangles are canvas-local CSS pixels resolved from the
    // ResizeObserver-owned canvas size: no per-label layout read.
    const vpX = pane.cssLeft;
    const vpY = pane.cssTop;
    const vpW = pane.cssWidth;
    const vpH = pane.cssHeight;
    const visibleLeft = pane.visibleCssLeft;
    const visibleTop = pane.visibleCssTop;
    const visibleRight = visibleLeft + pane.visibleCssWidth;
    const visibleBottom = visibleTop + pane.visibleCssHeight;
    // Small margin to hide labels that are partially outside (avoids text clipping at edges)
    const margin = 5;

    for (const item of labels) {
      if (!item?.el || !item.position) continue;
      const element = item.el;
      let previous = centroidLabelPresentation.get(element);
      if (!previous) {
        previous = {
          visible: null,
          screenX: Number.NaN,
          screenY: Number.NaN
        };
        centroidLabelPresentation.set(element, previous);
      }

      let visible = !(
        item.alpha != null &&
        item.alpha < POINT_VISIBILITY_THRESHOLD
      );
      let screenX = previous.screenX;
      let screenY = previous.screenY;
      if (visible) {
        vec4.set(
          tempVec4,
          item.position[0],
          item.position[1],
          item.position[2],
          1
        );
        vec4.transformMat4(tempVec4, tempVec4, mvpMatrix);
        visible = tempVec4[3] > 0;
      }
      if (visible) {
        const ndcX = tempVec4[0] / tempVec4[3];
        const ndcY = tempVec4[1] / tempVec4[3];
        // NDC x: -1 = left, +1 = right
        screenX = vpX + (ndcX * 0.5 + 0.5) * vpW;
        // NDC y: -1 = bottom, +1 = top; CSS y: 0 = top
        screenY = vpY + (0.5 - ndcY * 0.5) * vpH;
        visible =
          Number.isFinite(screenX) &&
          Number.isFinite(screenY) &&
          screenX >= visibleLeft + margin &&
          screenX <= visibleRight - margin &&
          screenY >= visibleTop + margin &&
          screenY <= visibleBottom - margin;
      }

      if (!visible) {
        if (
          previous.visible !== false ||
          element.style.display !== 'none'
        ) {
          element.style.display = 'none';
        }
        previous.visible = false;
        continue;
      }

      if (
        previous.visible !== true ||
        element.style.display !== 'block'
      ) {
        element.style.display = 'block';
        previous.visible = true;
      }
      if (previous.screenX !== screenX) {
        element.style.left = `${screenX}px`;
        previous.screenX = screenX;
      }
      if (previous.screenY !== screenY) {
        element.style.top = `${screenY}px`;
        previous.screenY = screenY;
      }
    }
  }

  /**
   * Draw one frame into the scene target and resolve it onto the canvas.
   *
   * The target is bound once here rather than at each of the four places the
   * frame body clears and draws, and resolved in a `finally` so a pane that
   * throws still puts its partial frame on screen instead of leaving the canvas
   * showing the frame before it. With antialiasing off both calls are no-ops and
   * the body draws straight to the default framebuffer, exactly as it did before
   * the target existed.
   */
  function invalidateFrame() {
    frameInvalidated = true;
    sceneGeneration += 1;
    ensureFrameScheduled();
    if (frameInvalidationTracing) {
      // Diagnostics only: who asked for the next frame. Off by default, and a
      // single boolean test when off.
      lastFrameInvalidationTrace = new Error('frame invalidated').stack ?? null;
    }
  }

  // What each grid pane last drew, for retained panes: a pane whose scene
  // generation, camera, projection, rectangle and navigation mode are all
  // unchanged keeps the pixels it drew in the scene target and is skipped.
  const paneDrawRecords = new Map();
  // Whether this frame changed any pixel of the scene target; a frame that
  // changed none skips the resolve (the canvas already shows it).
  let sceneTargetChangedThisFrame = true;
  let retainedSceneTarget = null;
  let retainedLayoutKey = '';

  /**
   * Whether the scene target still holds what the last frame drew there: the
   * same framebuffer (the multisampled target or the default one), sampled the
   * same way, at the same size. Anything else starts every pane afresh.
   */
  function sceneTargetRetained(width, height) {
    const framebuffer = sceneMsaaTarget.getSceneFramebuffer();
    const multisampled = sceneMsaaTarget.isMultisampledThisFrame();
    const previous = retainedSceneTarget;
    retainedSceneTarget = { framebuffer, multisampled, width, height };
    return previous !== null
      && previous.framebuffer === framebuffer
      && previous.multisampled === multisampled
      && previous.width === width
      && previous.height === height;
  }

  function paneIsUnchanged(record, mvp, pane, paneNavigationMode) {
    if (
      record === undefined
      || record.generation !== sceneGeneration
      || record.navigationMode !== paneNavigationMode
      || record.x !== pane.viewportX
      || record.y !== pane.viewportY
      || record.width !== pane.viewportWidth
      || record.height !== pane.viewportHeight
    ) {
      return false;
    }
    for (let index = 0; index < 16; index++) {
      if (record.mvp[index] !== mvp[index]) return false;
    }
    return true;
  }

  function recordPaneDraw(viewId, mvp, pane, paneNavigationMode) {
    let record = paneDrawRecords.get(viewId);
    if (record === undefined) {
      record = { mvp: new Float32Array(16) };
      paneDrawRecords.set(viewId, record);
    }
    record.mvp.set(mvp);
    record.generation = sceneGeneration;
    record.navigationMode = paneNavigationMode;
    record.x = pane.viewportX;
    record.y = pane.viewportY;
    record.width = pane.viewportWidth;
    record.height = pane.viewportHeight;
  }

  /** Arm the frame loop for the next animation frame, unless it is armed. */
  function ensureFrameScheduled() {
    if (
      !frameLoopStarted
      || animationHandle !== null
      || disposed
      || webglContextLost
      || renderPaused
    ) {
      return;
    }
    animationHandle = requestAnimationFrame(render);
  }

  /**
   * Ask for a frame for a camera change alone (a drag, a wheel zoom, a
   * pinch): only the panes whose camera moved are redrawn; every other pane
   * keeps its pixels.
   */
  function invalidateCameraFrame() {
    frameInvalidated = true;
    ensureFrameScheduled();
    if (frameInvalidationTracing) {
      lastFrameInvalidationTrace = new Error('frame invalidated (camera)').stack ?? null;
    }
  }

  /**
   * Whether a time-driven effect other than the camera's own motion changes
   * what panes draw this frame (fades, smoke, overlays, the highlight pulse,
   * projectiles, LOD still converging). While one is, every pane is redrawn.
   */
  function sceneWideAnimationActive() {
    return (
      gridOpacity !== (showGrid ? targetGridOpacity : 0)
      || studioOpacity !== (showStudio ? 1 : 0)
      || studioSurfaceInTransition
      || (renderMode === 'smoke' && smokeRenderer.needsContinuousFrames())
      || overlayManager?.needsContinuousFrames() === true
      || (highlightTools !== null && highlightTools.isHighlightAnimating())
      || projectileSystem.isAnimating()
      || lodConvergingInLastFrame
      || backdropLooks.frameCause() !== null
    );
  }

  /**
   * Build the spatial index of every presented large pane in a worker, so a
   * hover reader or a selection tool never pays for it on the main thread.
   * Panes below the interactive-index threshold keep their direct scan and
   * build nothing. Resolves once every requested build has settled; a failed
   * build is reported and leaves that pane to its press-time build.
   */
  function prepareSpatialQueryIndices() {
    const layout = getPresentedLayout();
    if (layout === null) return Promise.resolve();
    const builds = [];
    for (const pane of layout.panes) {
      const dimensionLevel = getPublishedDimensionLevel(pane.viewId);
      const count = getExactViewPositions(pane.viewId).length / dimensionLevel;
      if (count < INTERACTIVE_SPATIAL_INDEX_POINT_THRESHOLD) continue;
      builds.push(
        hpRenderer.buildSpatialIndexInBackground(pane.viewId).catch(error => {
          console.warn('[Viewer] Background spatial index failed:', error);
        })
      );
    }
    return Promise.all(builds).then(() => undefined);
  }

  /**
   * The first time-driven effect that still changes the next frame, by name,
   * or null. One list serves the frame loop and the schedule diagnostics, so
   * a report can never disagree with the loop.
   */
  function sceneAnimationCause() {
    if (isMovementKeyHeld()) return 'movement-key';
    if (
      Math.abs(velocityTheta) > INERTIA_MIN_VELOCITY ||
      Math.abs(velocityPhi) > INERTIA_MIN_VELOCITY
    ) {
      return 'orbit-inertia';
    }
    if (Math.hypot(velocityPanX, velocityPanY, velocityPanZ) > INERTIA_MIN_VELOCITY) {
      return 'pan-inertia';
    }
    if (vec3.length(freeflyVelocity) > 0) return 'freefly-coast';
    if (radius !== targetRadius) return 'zoom-easing';
    if (gridOpacity !== (showGrid ? targetGridOpacity : 0)) return 'grid-fade';
    if (studioOpacity !== (showStudio ? 1 : 0)) return 'studio-fade';
    if (studioSurfaceInTransition) return 'studio-surface';
    const backdropLookCause = backdropLooks.frameCause();
    if (backdropLookCause !== null) return backdropLookCause;
    if (renderMode === 'smoke' && smokeRenderer.needsContinuousFrames()) return 'smoke';
    if (overlayManager?.needsContinuousFrames() === true) return 'overlay';
    if (highlightTools !== null && highlightTools.isHighlightAnimating()) return 'highlight';
    if (projectileSystem.isAnimating()) return 'projectile';
    if (presentedCameraSettlement.isPending()) return 'camera-settlement';
    if (lodConvergingInLastFrame) return 'lod';
    return null;
  }


  /**
   * What starts a settle window on a frame of `frameSize`: an invalidation, a
   * canvas resize, or a time-driven effect, by name; null when none. The frame
   * loop and getFrameScheduleState() both ask here, so the diagnostics can
   * never disagree with the loop.
   */
  function nextFrameCause(frameSize) {
    if (frameInvalidated) return 'invalidated';
    if (
      frameSize.width !== lastDrawnCanvasWidth ||
      frameSize.height !== lastDrawnCanvasHeight
    ) {
      return 'resize';
    }
    return sceneAnimationCause();
  }

  /** Whether the settle frames after the last cause have been drawn. */
  function settleWindowElapsed() {
    return framesDrawnSinceCause >= FRAME_SETTLE_MIN_FRAMES;
  }

  function render() {
    // This callback is the armed frame; it re-arms only while drawing goes on.
    animationHandle = null;
    if (disposed || webglContextLost || renderPaused) {
      // Stopped: queued phase work runs from a frame of its own.
      reconcileFramePhases();
      return;
    }
    // A context can be physically gone before `webglcontextlost` is delivered,
    // which is exactly the window a forced loss lands in and the reason the
    // asynchronous commits above fence on the same question. A frame drawn in
    // that window reaches the renderer's GL preflight, which refuses a lost
    // context by design; the refusal is terminal, the event that follows owns
    // the cleanup, and there is nothing to draw either way.
    if (isWebGLContextLostForAsyncCommit()) return;
    // Coalesced input first, so what it changes is drawn in this frame.
    drainBeforeFramePhase();
    const frameSize = canvasResizeObserver.getSize();
    const now = performance.now();
    const frameCause = nextFrameCause(frameSize);
    if (frameCause !== null) {
      lastFrameCauseTime = now;
      lastFrameCause = frameCause;
      framesDrawnSinceCause = 0;
    } else if (settleWindowElapsed()) {
      // Nothing on screen can change: the presented frame stays as it is,
      // and the loop stops until something asks for a frame.
      lastFrameTime = now;
      drainAfterFramePhase();
      return;
    }
    // A drawn frame keeps the loop armed for its settle frames and running
    // effects. Armed before drawing, as the always-running loop was, so a
    // callback requested during the frame still runs behind the viewer's.
    ensureFrameScheduled();
    frameInvalidated = false;
    framesDrawnSinceCause += 1;
    lastDrawnCanvasWidth = frameSize.width;
    lastDrawnCanvasHeight = frameSize.height;
    renderFrameId = renderFrameId === Number.MAX_SAFE_INTEGER
      ? 0
      : renderFrameId + 1;
    if (sceneWideAnimationActive()) sceneGeneration += 1;
    sceneTargetChangedThisFrame = true;
    sceneMsaaTarget.beginFrame(frameSize.width, frameSize.height);
    lodConvergingInLastFrame = false;
    try {
      renderSceneFrame();
    } catch (error) {
      // The loss can also happen *inside* the frame, after the check above
      // passed. The renderer identifies that refusal so this boundary can tell
      // it from a defect: rethrowing here reaches `window.onerror` and reports
      // a handled loss as a crash, which is what a page-error assertion in the
      // terminal-disposal contract caught. Anything else is a real failure and
      // still propagates untouched.
      if (!isContextLostError(error)) {
        // The canvas holds a partial frame; the next frame redraws it, every
        // pane afresh (nothing drawn this frame can be retained).
        retainedLayoutKey = '';
        paneDrawRecords.clear();
        invalidateFrame();
        throw error;
      }
      const scheduledAnimationHandle = animationHandle;
      animationHandle = null;
      if (scheduledAnimationHandle !== null) {
        cancelAnimationFrame(scheduledAnimationHandle);
      }
      // Stop driving frames now. `webglcontextlost` still owns the terminal
      // ownership graph and runs whether or not it has been delivered yet.
      renderPaused = true;
    } finally {
      if (sceneTargetChangedThisFrame) {
        sceneMsaaTarget.resolveFrame(frameSize.width, frameSize.height);
      } else {
        sceneMsaaTarget.endFrameUnchanged();
      }
    }
    // What only reflects the drawn frame (readouts, observers) runs now.
    drainAfterFramePhase();
  }

  /** The frame-phase driver: this viewer while its loop runs. */
  const framePhaseDriver = Object.freeze({
    isRunning: () => (
      frameLoopStarted && !disposed && !webglContextLost && !renderPaused
    ),
    requestFrame: () => ensureFrameScheduled(),
  });

  /**
   * Tell the frame phases whether this viewer drives them now (after the loop
   * starts or stops), so queued work is never stranded.
   */
  function reconcileFramePhases() {
    setFramePhaseDriver(disposed ? null : framePhaseDriver);
  }

  function renderSceneFrame() {
    hpRenderer.beginFrame();
    const now = performance.now();
    const timeSeconds = now / 1000;
    const dt = Math.min(MAX_FRAME_DT, Math.max(0.001, (now - lastFrameTime) / 1000));
    lastFrameTime = now;

    if (navigationMode === 'free') {
      updateFreefly(dt);
    } else {
      updateOrbitPlanarKeys(dt);
      updateSmoothZoom(dt);
      updateInertia(dt);
    }

    projectileSystem.update(dt);

    // Update charge indicator UI (handled by projectile system)
    projectileSystem.updateChargeUI();

    // Backdrop fades move toward their target in either direction: a grid
    // whose target dropped (Grid light 0.85 to Grid dark 0.75) used to stay
    // above it, and the scheduler then redrew every frame for good. With
    // reduced motion requested they complete at once.
    const fadeStep = prefersReducedMotion() ? Infinity : gridTransitionSpeed * dt;
    gridOpacity = moveToward(gridOpacity, showGrid ? targetGridOpacity : 0, fadeStep);
    // The studio backdrop fades at the grid's rate. Panes still crossing
    // between floor and dot surface report themselves while this frame draws.
    studioOpacity = moveToward(studioOpacity, showStudio ? 1 : 0, fadeStep);
    studioSurfaceInTransition = false;
    backdropLooks.advance(dt);

    const canvasSize = canvasResizeObserver.getSize();
    const width = canvasSize.width;
    const height = canvasSize.height;
    if (presentedViewStateListeners.size !== 0) {
      trackPresentedFrameState(now, width, height);
    }

    if (!pointCount) {
      retainedLayoutKey = '';
      _renderVelocityViewIds.length = 0;
      prepareVelocityFrame(_renderVelocityViewIds);
      gl.viewport(0, 0, width, height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      return;
    }

    updateCamera(width, height);
    mat4.multiply(mvpMatrix, projectionMatrix, viewMatrix);
    mat4.multiply(mvpMatrix, mvpMatrix, modelMatrix);

		    if (renderMode === 'smoke') {
		      // Smoke draws the live view alone: every kept view is dormant.
		      _presentedViewIdsScratch.length = 1;
		      _presentedViewIdsScratch[0] = LIVE_VIEW_ID;
		      hpRenderer.setPresentedViews(_presentedViewIdsScratch);
		      retainedLayoutKey = '';
		      _renderVelocityViewIds.length = 0;
		      prepareVelocityFrame(_renderVelocityViewIds);
		      gl.viewport(0, 0, width, height);
		      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		      // Draw the background layers first (render during fade-out too)
		      const smokeLayout = getPresentedLayout();
		      if (smokeLayout !== null) {
		        drawStudioBackdrop(
		          LIVE_VIEW_ID,
		          width / smokeLayout.cssWidth,
		          smokeLayout.presentedArea.cssLeft / smokeLayout.cssWidth,
		          navigationMode,
		          dt
		        );
		        drawBackdropLook(
		          LIVE_VIEW_ID,
		          width / smokeLayout.cssWidth,
		          smokeLayout.presentedArea.cssLeft / smokeLayout.cssWidth,
		          navigationMode,
		          width,
		          height
		        );
		      }
		      if (gridOpacity > 0) {
		        drawGrid();
		      }
      // Compute inverse view-projection matrix for smoke ray marching
      mat4.multiply(viewProjMatrix, projectionMatrix, viewMatrix);
      mat4.invert(invViewProjMatrix, viewProjMatrix);
      // Render smoke with alpha blending on top of grid
      try {
        _smokeRenderParams.eye = eye;
        _smokeRenderParams.width = width;
        _smokeRenderParams.height = height;
        _smokeRenderParams.sceneFramebuffer =
          sceneMsaaTarget.getSceneFramebuffer();
        smokeRenderer.render(_smokeRenderParams);
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

    // Determine views to render (include centroid data for each view).
    // The preallocated array is overwritten in place and then truncated:
    // `length = 0` would release its backing store, and the pushes after it
    // would allocate a new one every frame.
    let renderViewCount = 0;

    // Add live view only if not hidden
    if (!liveViewHidden) {
      _liveRenderViewRecord.label = liveViewLabel;
      _liveRenderViewRecord.colors = colorsArray;
      _liveRenderViewRecord.transparency =
        transparencyArray;
      _liveRenderViewRecord.centroidCount = centroidCount;
      _liveRenderViewRecord.cameraState = liveCameraState;
      _renderAllViews[renderViewCount++] = _liveRenderViewRecord;
    }

    for (let index = 0; index < snapshotViews.length; index++) {
      _renderAllViews[renderViewCount++] =
        getSnapshotRenderViewRecord(snapshotViews[index]);
    }
    _renderAllViews.length = renderViewCount;

    const layout = getPresentedLayout();
    if (layout === null) {
      retainedLayoutKey = '';
      _renderVelocityViewIds.length = 0;
      prepareVelocityFrame(_renderVelocityViewIds);
      gl.viewport(0, 0, width, height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      return;
    }

    // Single view: one pane over the whole canvas, its projection centred on
    // the presented area (updateCamera already configured exactly that).
    // The views drawn this frame; a kept view that is not is dormant (its
    // stores are the first released when memory runs out).
    _presentedViewIdsScratch.length = layout.panes.length;
    for (let index = 0; index < layout.panes.length; index++) {
      _presentedViewIdsScratch[index] = layout.panes[index].viewId;
    }
    hpRenderer.setPresentedViews(_presentedViewIdsScratch);
    if (!layout.gridMultiview) {
      const pane = layout.panes[0];
      const view = _renderAllViews[pane.viewIndex];
      if (!view || view.id !== pane.viewId) {
        throw new Error(
          `Focused view "${pane.viewId}" is absent from the published render layout.`
        );
      }
      // One pane over the whole canvas: a frame that would draw exactly what
      // the scene target already holds (the settle frame after a change)
      // draws nothing.
      const singleKey = `single:${pane.viewId}:${pane.viewportX},${pane.viewportY},${pane.viewportWidth},${pane.viewportHeight};`;
      const retainSingle = sceneTargetRetained(width, height) && singleKey === retainedLayoutKey;
      retainedLayoutKey = singleKey;
      if (!retainSingle) paneDrawRecords.clear();
      if (retainSingle && paneIsUnchanged(paneDrawRecords.get(view.id), mvpMatrix, pane, navigationMode)) {
        sceneTargetChangedThisFrame = false;
        return;
      }
      recordPaneDraw(view.id, mvpMatrix, pane, navigationMode);
      gl.viewport(0, 0, width, height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      _renderVelocityViewIds[0] = view.id;
      _renderVelocityViewIds.length = 1;
      prepareVelocityFrame(_renderVelocityViewIds);
      ensureCentroidSnapshotBuffer(view);

      const snapshotId = requireSnapshotBufferId(view.id);
      renderSingleView(
        pane,
        view.id,
        view.centroidCount,
        snapshotId,
        dt,
        timeSeconds,
        navigationMode
      );
      hideViewTitles(); // No titles in single/fullscreen mode
      updateLabelLayerVisibility();
      return;
    }

    // Grid mode: render multiple viewports, one scissored pane per view, all
    // inside the presented area. A pane that has not changed since it was
    // drawn keeps its pixels in the scene target: orbiting one pane of four
    // redraws one pane. The whole target is cleared and every pane drawn only
    // when the target, the layout or the inventory changed.
    let layoutKey = '';
    for (const pane of layout.panes) {
      layoutKey += `${pane.viewId}:${pane.viewportX},${pane.viewportY},${pane.viewportWidth},${pane.viewportHeight};`;
    }
    const retainPanes = sceneTargetRetained(width, height) && layoutKey === retainedLayoutKey;
    retainedLayoutKey = layoutKey;
    if (!retainPanes) {
      paneDrawRecords.clear();
      gl.viewport(0, 0, width, height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
    let panesDrawn = retainPanes ? 0 : 1;

    const viewCount = _renderAllViews.length;
    if (viewCount !== layout.panes.length) {
      throw new Error('The presented layout does not match the render inventory.');
    }
    for (let index = 0; index < viewCount; index++) {
      _renderVelocityViewIds[index] = _renderAllViews[index].id;
    }
    _renderVelocityViewIds.length = viewCount;
    prepareVelocityFrame(_renderVelocityViewIds);

    // Update view title chips
    updateViewTitles(_renderAllViews, layout);
    showViewTitles();

    // Store active view's matrices (computed once in updateCamera before this loop)
    // Use preallocated scratch matrix to avoid per-frame allocation
    mat4.copy(_activeViewMatrixScratch, viewMatrix);
    const activeRadius = radius;

    // Frustum culling and LOD work per-view: each renderSingleView call receives
    // the correct mvpMatrix and cameraDistance for that view's camera

    try {
      gl.enable(gl.SCISSOR_TEST);
      try {
        for (let i = 0; i < viewCount; i++) {
        const view = _renderAllViews[i];
        const pane = layout.panes[i];
        if (pane.viewId !== view.id) {
          throw new Error(
            `Presented pane ${i} belongs to "${pane.viewId}", not "${view.id}".`
          );
        }

        const followsCamera = cameraFollowers.has(view.id);
        let paneNavigationMode = navigationMode;

        // OPTIMIZATION: Use cached view matrices instead of per-frame recalculation
        // No global state modification, no applyCameraStateTemporarily, no updateCamera
        if (followsCamera) {
          // The focused view and its linked followers: the freshly computed
          // active view matrix.
          mat4.copy(viewMatrix, _activeViewMatrixScratch);
          radius = activeRadius;
        } else {
          const cached = cachedViewMatrices.get(view.id);
          const cameraState = getViewCameraState(view.id);
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
        }

        mat4.copy(projectionMatrix, getPresentedPaneProjection(layout, i));
        mat4.multiply(mvpMatrix, projectionMatrix, viewMatrix);
        mat4.multiply(mvpMatrix, mvpMatrix, modelMatrix);

          if (retainPanes && paneIsUnchanged(paneDrawRecords.get(view.id), mvpMatrix, pane, paneNavigationMode)) {
            continue;
          }
          panesDrawn += 1;

          // Set viewport and clear this pane (a retained frame keeps the
          // other panes' pixels, so the pane clears its own colour too).
          gl.viewport(
            pane.viewportX,
            pane.viewportY,
            pane.viewportWidth,
            pane.viewportHeight
          );
          gl.scissor(
            pane.viewportX,
            pane.viewportY,
            pane.viewportWidth,
            pane.viewportHeight
          );
          gl.clear(retainPanes ? gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT : gl.DEPTH_BUFFER_BIT);
          recordPaneDraw(view.id, mvpMatrix, pane, paneNavigationMode);

          // Recreate only when the immutable position/color publication changes.
          ensureCentroidSnapshotBuffer(view);

          const snapshotId = requireSnapshotBufferId(view.id);
          renderSingleView(
            pane,
            view.id,
            view.centroidCount,
            snapshotId,
            dt,
            timeSeconds,
            paneNavigationMode
          );
        }
      } finally {
          // The next frame clears the full canvas before re-entering grid
          // panes. A failed pane must never clip that clear or later draws.
          gl.disable(gl.SCISSOR_TEST);
      }
    } finally {
      // Restore the active camera/matrix ownership even when one pane throws;
      // the already-scheduled next frame then starts from coherent state.
      mat4.copy(viewMatrix, _activeViewMatrixScratch);
      radius = activeRadius;
      configureFullCanvasProjection(
        projectionMatrix,
        width / height
      );
      mat4.multiply(mvpMatrix, projectionMatrix, viewMatrix);
      mat4.multiply(mvpMatrix, mvpMatrix, modelMatrix);
    }

	    // Aggregate label layer visibility once per frame (after all views render).
	    updateLabelLayerVisibility();
	    if (panesDrawn === 0) sceneTargetChangedThisFrame = false;
	  }

  /** Recreate a view's centroid buffer only when its publication changed. */
  function ensureCentroidSnapshotBuffer(view) {
    if (
      view.centroidPositions?.length > 0 &&
      view.centroidColors &&
      centroidBufferNeedsUpdate(
        view.id,
        view.centroidPositions,
        view.centroidColors
      )
    ) {
      createCentroidSnapshotBuffer(
        view.id,
        view.centroidPositions,
        view.centroidColors
      );
    }
  }

  /**
   * Draw one view into one presented pane. The caller has bound the pane's
   * viewport (and scissor, for grid cells) and its projection.
   */
  function renderSingleView(
    pane,
    viewId,
    overrideCentroidCount,
    snapshotBufferId = null,
    dtSeconds = 0.016,
    timeSeconds = 0,
    paneNavigationMode
  ) {
    const width = pane.viewportWidth;
    const height = pane.viewportHeight;
    const viewportX = pane.viewportX;
    const viewportY = pane.viewportY;
    const scissorEnabled = pane.scissorEnabled;
		    const vid = assertViewId(viewId);
		    const exactPaneNavigationMode = assertNavigationMode(
		      paneNavigationMode
		    );
		    if (pane.viewId !== vid) {
		      throw new Error(
		        `View "${vid}" cannot render into the pane of "${pane.viewId}".`
		      );
		    }
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

			    // Draw the background layers first
			    drawStudioBackdrop(
			      vid,
			      width / pane.cssWidth,
			      pane.projectionCenterNdcX,
			      exactPaneNavigationMode,
			      dtSeconds
			    );
			    drawBackdropLook(
			      vid,
			      width / pane.cssWidth,
			      pane.projectionCenterNdcX,
			      exactPaneNavigationMode,
			      width,
			      height
			    );
			    drawGrid();

	    // Render params shared by both render paths
	    // Get dimension level for this view (used for LOD and frustum culling calculations)
	    const dimLevel = getPublishedDimensionLevel(vid);
	    // Camera distance calculation: use per-view cached distance when available (for multiview support)
	    // For focused view or locked cameras, global state is authoritative; otherwise use cached per-view value
	    let camDist;
	    const followsCamera = cameraFollowers.has(vid);
	    if (followsCamera) {
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
	    renderParams.multisampled = sceneMsaaTarget.isMultisampledThisFrame();

	    // Camera position is used for fog/lighting; avoid per-view mat4.invert in the render loop.
	    const cameraPosition = renderParams.cameraPosition;
	    if (followsCamera) {
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
	      hpRenderer.renderWithSnapshot(snapshotBufferId, renderParams, false);
	    } else {
      hpRenderer.render(renderParams, false);
    }
    if (hpRenderer.isViewLodConverging(vid)) lodConvergingInLastFrame = true;
	    // Capture this point pass's exact range before any overlay or later
	    // pane can reuse the shared HighPerfRenderer fog scalars.
	    const paneFogNear = hpRenderer.getFogNear();
	    const paneFogFar = hpRenderer.getFogFar();
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
		          layoutKey: viewLayoutKeys.get(vid) ?? null,
		          devicePixelRatio: window.devicePixelRatio,
		          viewportX,
		          viewportY,
		          scissorEnabled,
		          outputFramebuffer: sceneMsaaTarget.getSceneFramebuffer(),
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
		        overlayOpts.layoutKey = viewLayoutKeys.get(vid) ?? null;
		        overlayOpts.devicePixelRatio = window.devicePixelRatio;
		        overlayOpts.viewportX = viewportX;
		        overlayOpts.viewportY = viewportY;
		        overlayOpts.scissorEnabled = scissorEnabled;
		        overlayOpts.outputFramebuffer =
		          sceneMsaaTarget.getSceneFramebuffer();
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
    try {
      highlightTools.syncHighlightBufferForLod(
        viewPos,
        vid,
        viewTransp,
        dimLevel
      );
    } catch (error) {
      reportHighlightRenderFailure(error, vid);
    }
    try {
      // A failed replacement upload leaves the last accepted generation
      // authoritative and drawable. Its draw failure boundary is independent
      // so connectivity, centroids, projectiles, and later panes still run.
      highlightTools.drawHighlights(renderParams, timeSeconds);
    } catch (error) {
      reportHighlightRenderFailure(error, vid);
    }

    // Draw connectivity lines (pass viewId for per-view position/visibility textures)
    drawConnectivityLines(
      width,
      height,
      vid,
      paneFogNear,
      paneFogFar
    );

    // Draw centroids
    const showCentroidPoints = shouldShowCentroidPoints(vid);
    const showCentroidLabels = shouldShowCentroidLabels(vid);
	    if (showCentroidPoints && numCentroids > 0) {
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
      if (!cameraFollowers.has(vid)) {
        const camState = getViewCameraState(vid);
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
	      _orbitAnchorDrawParams.use3D =
	        SHADER_QUALITY_TRAITS[currentShaderQuality].sphere;
	      _orbitAnchorDrawParams.fogDensity = fogDensity;
	      _orbitAnchorDrawParams.lightingStrength = lightingStrength;
		      _orbitAnchorDrawParams.navigationMode = exactPaneNavigationMode;
	      orbitAnchorRenderer.draw(_orbitAnchorDrawParams);
	    }

    // Update labels
		    if (showCentroidLabels) {
		      const labels = getLabelsForView(vid);
		      if (labels.length) {
		        updateCentroidLabelPositions(labels, pane, vid);
		      }
	    } else {
	      hideLabelsForView(vid);
	    }
	  }

  function setBackground(mode) {
    const exactMode = assertViewerBackground(mode);
    showGrid = false;
    showStudio = false;
    backdropLooks.setLook(isBackdropLook(exactMode) ? exactMode : null);
    if (isBackdropLook(exactMode)) {
      // A baked look: the clear colour is its surface (and the CSS page
      // colour), shown until its bake lands and the look fades in.
      const surface = backdropLookSurface01(exactMode);
      gl.clearColor(surface[0], surface[1], surface[2], 1);
      bgColor = surface;
      fogColor = [...surface];
      gridBgColor = [...surface];
    }
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
	        break;
      case 'studio':
      case 'studio-dark': {
        // Floor and dot surface over a neutral stage; the clear colour is the
        // backdrop's edge colour and the exact CSS page colour.
        showStudio = true;
        studioPalette = STUDIO_PALETTES[exactMode];
        const surface = studioColor01(studioPalette.surface);
        studioGlowColor = studioColor01(studioPalette.glow);
        studioInkColor = studioColor01(studioPalette.ink);
        gl.clearColor(surface[0], surface[1], surface[2], 1);
        bgColor = surface;
        fogColor = [...surface];
        // Keep a fading box grid on the new surface.
        gridBgColor = [...surface];
        break;
      }
      case 'black':
        gl.clearColor(0, 0, 0, 1);
        bgColor = [0, 0, 0];
        fogColor = [0.05, 0.05, 0.08];
        // Match grid bg to main bg for clean fade-out
        gridBgColor = [0, 0, 0];
        gridColor = [0.3, 0.3, 0.3];
        break;
      case 'white':
        gl.clearColor(1, 1, 1, 1);
        bgColor = [1, 1, 1];
        fogColor = [1, 1, 1];
        // Match grid bg to main bg for clean fade-out
        gridBgColor = [1, 1, 1];
        gridColor = [0.7, 0.7, 0.7];
    }
    publishPresentedViewStateChange(
      'background',
      focusedViewId
    );
  }

  // === Per-view camera helpers ===
  function getStoredViewCameraState(
    exactViewId,
    boundary = undefined
  ) {
    let cameraState;
    if (exactViewId === LIVE_VIEW_ID) {
      cameraState = liveCameraState
        ? liveCameraState
        : getCurrentCameraStateInternal();
    } else {
      const snap = snapshotViewsById.get(exactViewId);
      cameraState = snap?.cameraState;
      if (!cameraState) {
        throw new TypeError(
          `Camera state is missing for view "${exactViewId}".`
        );
      }
    }
    if (certifiedCameraStateOwners.has(cameraState)) {
      return cameraState;
    }
    return certifyCameraStateOwner(
      cameraState,
      boundary ?? `Camera state for view "${exactViewId}"`
    );
  }

  function getViewCameraState(viewId, boundary = undefined) {
    const exactViewId = assertKnownViewId(viewId);
    // The focused pane and its linked followers are rendered from the live
    // global camera scalars. Public/session/snapshot capture must observe that
    // same authoritative state rather than an older stored record.
    if (cameraFollowers.has(exactViewId)) {
      return certifyCameraStateOwner(
        getCurrentCameraStateInternal(),
        boundary ?? `Camera state for view "${exactViewId}"`
      );
    }
    return getStoredViewCameraState(exactViewId, boundary);
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
      const snap = snapshotViewsById.get(exactViewId);
      snap.cameraState = ownedState;
    }
    certifiedCameraStateOwners.add(ownedState);

    // The cached matrix draws the view whenever it does not follow the
    // focused camera; keeping it current makes any focus or link change
    // publication-ready.
    updateCachedViewMatrix(exactViewId, ownedState);
    return ownedState;
  }

  function viewExists(viewId) {
    return viewId === LIVE_VIEW_ID || snapshotViewsById.has(viewId);
  }

  /**
   * The views drawn from the focused camera: the focused view, and with
   * linked cameras every view showing the same representation (layout).
   * A view with no published layout links with no other view.
   */
  function computeCameraFollowers() {
    const followers = new Set([focusedViewId]);
    if (!camerasLocked) return followers;
    const layoutKey = viewLayoutKeys.get(focusedViewId) ?? null;
    if (layoutKey === null) return followers;
    for (const [viewId, viewLayoutKey] of viewLayoutKeys) {
      if (viewLayoutKey === layoutKey && viewExists(viewId)) followers.add(viewId);
    }
    return followers;
  }

  /**
   * Store the live camera in every view that follows it now, so a view that
   * stops following keeps exactly what it showed.
   */
  function persistFocusedCamera() {
    const current = getCurrentCameraStateInternal();
    for (const viewId of cameraFollowers) {
      if (viewExists(viewId)) setViewCameraState(viewId, current);
    }
  }

  /**
   * Recompute the followers after focus, linking, a layout or the view
   * inventory changed. Callers persist the live camera first
   * (`persistFocusedCamera`) while the old followers still describe it.
   */
  function refreshCameraFollowers() {
    cameraFollowers = computeCameraFollowers();
  }

  /**
   * With linked cameras, give every group of views that show one
   * representation one camera: the focused group follows the live camera; any
   * other group takes the stored camera of its first view (the live view
   * first, then kept views in order).
   */
  function unifyLinkedCameras() {
    if (!camerasLocked) return;
    const focusedLayoutKey = viewLayoutKeys.get(focusedViewId) ?? null;
    const groups = new Map();
    const ordered = [LIVE_VIEW_ID, ...snapshotViews.map(snapshot => snapshot.id)];
    for (const viewId of ordered) {
      const layoutKey = viewLayoutKeys.get(viewId) ?? null;
      if (layoutKey === null || layoutKey === focusedLayoutKey) continue;
      if (!groups.has(layoutKey)) groups.set(layoutKey, []);
      groups.get(layoutKey).push(viewId);
    }
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const shared = getStoredViewCameraState(members[0]);
      for (const viewId of members.slice(1)) setViewCameraState(viewId, shared);
    }
  }

  /**
   * The one transfer of camera ownership between panes. The focused pane (and
   * its linked followers) is drawn from the global camera scalars, so a focus
   * change must (1) store the live camera in every view that follows it while
   * those views still exist, (2) stop motion so inertia never glides the
   * incoming pane, and (3) load the incoming pane's own camera and navigation
   * mode. A pane that is being removed is not saved: its camera dies with it.
   */
  function transferViewFocus(nextViewId, { saveOutgoing }) {
    if (saveOutgoing) {
      persistFocusedCamera();
    } else {
      // The outgoing pane is being removed; its linked followers keep the
      // live camera.
      const current = getCurrentCameraStateInternal();
      for (const viewId of cameraFollowers) {
        if (viewId !== focusedViewId && viewExists(viewId)) {
          setViewCameraState(viewId, current);
        }
      }
    }
    const incomingCamera = assertCameraState(
      getStoredViewCameraState(nextViewId),
      `Camera state for focused view "${nextViewId}"`
    );
    velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
    vec3.set(freeflyVelocity, 0, 0, 0);
    focusedViewId = nextViewId;
    refreshCameraFollowers();
    const previousMode = navigationMode;
    applyCameraStateTemporarily(incomingCamera);
    if (navigationMode !== previousMode) {
      navigationModeChangeHandler?.(focusedViewId, navigationMode);
    }
    updateViewTitleActiveState();
  }

  // === Per-view navigation mode helpers ===
  function getViewNavigationMode(viewId) {
    const exactViewId = assertKnownViewId(viewId);
    if (cameraFollowers.has(exactViewId)) {
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

  /**
   * Set one view's navigation mode. A view drawn from the focused camera (the
   * focused view and its linked followers) changes the live mode, which every
   * follower shares; any other view changes its stored camera.
   */
  function applyViewNavigationMode(viewId, mode) {
    const exactMode = assertNavigationMode(mode);
    const exactViewId = assertKnownViewId(viewId);
    if (cameraFollowers.has(exactViewId)) {
      applyNavigationModeWithSync(exactMode);
      const current = getCurrentCameraStateInternal();
      for (const follower of cameraFollowers) {
        if (viewExists(follower)) setViewCameraState(follower, current);
      }
      return;
    }
    const stored = cloneCameraState(
      getStoredViewCameraState(exactViewId),
      `Camera state for view "${exactViewId}"`
    );
    // When switching to free-fly, ensure freefly data is synced from orbit
    if (exactMode === 'free') {
      syncFreeflyInCameraState(stored);
    }
    stored.navigationMode = exactMode;
    setViewCameraState(exactViewId, stored);
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
      updateSelectionCursor();
    } else {
      // orbit mode
      lookActive = false;
      // Exit pointer lock when switching away from freefly
      if (document.pointerLockElement === canvas && document.exitPointerLock) {
        document.exitPointerLock();
      }
      updateSelectionCursor();
    }
  }

  /**
   * Record or release the user's navigation choice for one view at the
   * dimension it shows. A mode that equals that dimension's default is not a
   * choice, whoever applied it.
   *
   * @param {string} viewId
   * @param {'orbit'|'planar'|'free'} mode
   */
  function settleViewNavigationOwnership(viewId, mode) {
    const exactViewId = assertViewId(viewId);
    const dimensionLevel = getPublishedDimensionLevel(exactViewId);
    if (mode === getDefaultNavigationMode(dimensionLevel)) {
      navigationModeOwnership.release(exactViewId, dimensionLevel);
      return;
    }
    navigationModeOwnership.record(exactViewId, dimensionLevel, mode);
  }

  /**
   * Put one view's camera at the default framing, in the navigation mode its
   * dimension (or the user's choice for it there) implies. The focused view
   * and its linked followers take it through the live camera.
   */
  function resetViewCameraForDimension(viewId, dimensionLevel) {
    const exactViewId = assertKnownViewId(viewId);
    const pose = createDefaultCameraPose();
    const camState = {
      navigationMode: navigationModeOwnership.choiceFor(exactViewId, dimensionLevel)
        ?? getDefaultNavigationMode(dimensionLevel),
      orbit: {
        radius: pose.orbit.radius,
        targetRadius: pose.orbit.radius,
        theta: pose.orbit.theta,
        phi: pose.orbit.phi,
        target: [...pose.orbit.target],
      },
      freefly: {
        position: [...pose.freefly.position],
        yaw: pose.freefly.yaw,
        pitch: pose.freefly.pitch,
      },
    };
    if (cameraFollowers.has(exactViewId)) {
      velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
      vec3.set(freeflyVelocity, 0, 0, 0);
      applyCameraStateTemporarily(camState, { applyNavMode: false });
      for (const follower of cameraFollowers) {
        if (viewExists(follower)) setViewCameraState(follower, getCurrentCameraStateInternal());
      }
    } else {
      setViewCameraState(exactViewId, camState);
    }
  }

  /**
   * A view now shows a representation of `dimensionLevel`: it navigates the
   * way the user last chose for it at that dimension, else by the dimension's
   * default (orbit in 3D, planar in 1D and 2D).
   */
	  function applyDimensionNavigationDefault(viewId, dimensionLevel) {
	    const exactViewId = assertViewId(viewId);
    const mode = navigationModeOwnership.choiceFor(exactViewId, dimensionLevel)
      ?? getDefaultNavigationMode(dimensionLevel);
    const previousMode = navigationMode;
    applyViewNavigationMode(exactViewId, mode);
    if (navigationMode !== previousMode) {
      const observer = navigationModeChangeHandler;
      const publishedMode = navigationMode;
      if (observer !== null) {
        // UI synchronization remains synchronous on the normal path. It is an
        // observer, not a publication veto, so only a thrown observer error is
        // reported outside the caller's reversible dimension transaction.
        try {
          observer(focusedViewId, publishedMode);
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
      updateSelectionCursor();
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
      updateSelectionCursor();
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

  function getViewIdAtScreenPosition(screenX, screenY) {
    const viewport = getViewportInfoAtScreen(screenX, screenY);
    return viewport === -1 ? focusedViewId : viewport.viewId;
  }

  /**
   * The view presented under one canvas-local CSS point, or null over an
   * empty grid slot or a canvas with no area. Unlike
   * `getViewportInfoAtScreen` it reads no layout and builds no matrices, so a
   * pointer-move reader (the armed selection cursor) can afford it per move.
   */
  function getPresentedViewIdAtCssPoint(cssX, cssY) {
    const layout = getPresentedLayout();
    if (layout === null) return null;
    const pane = getPresentedPaneAtCssPoint(layout, cssX, cssY);
    return pane === null ? null : pane.viewId;
  }

  // === Public API ===
  const publicApi = {
    setData(payload) {
      const {
        positions,
        colors,
        transparency,
        dimensionLevel,
        layoutKey,
        pointCount: nextPointCount
      } = assertViewerDataPayload(payload);
      // Load data into HP renderer (alpha is packed in colors as RGBA uint8)
      // Pass dimension level so the renderer can build the appropriate spatial index (BinaryTree/Quadtree/Octree)
      hpRenderer.loadData(positions, colors, {
        alphaValues: transparency,
        dimensionLevel
      });

      // The renderer generation is authoritative once loadData returns. The
      // connectivity graph and every pane's edge records belong to the
      // superseded dataset, so they go before any later viewer work can
      // render or throw.
      edgeLayer.clear();
      useInstancedEdges = false;

      highlightTools.retireSpatialInteractions(LIVE_VIEW_ID);
      cancelPendingProjectileBuild(
        'Projectile preparation was cancelled because the dataset changed.'
      );
      projectileSystem.setEnabled(false);
      pointCount = nextPointCount;
      positionsArray = positions;
      colorsArray = colors;
      transparencyArray = new Uint8Array(transparency);
      hpRenderer._adoptCurrentAlphasOwner(transparencyArray);
      computePointBoundsFromPositions(positions, dimensionLevel);
      viewDimensionLevels.set(LIVE_VIEW_ID, dimensionLevel);
      viewLayoutKeys.set(LIVE_VIEW_ID, layoutKey);
      publishViewPositions(LIVE_VIEW_ID, positions, dimensionLevel);
      publishViewDataGeneration(LIVE_VIEW_ID);
      // A pose belongs to the cells it framed. The outgoing dataset's camera
      // (its own preset's close-up, say) says nothing about the incoming
      // cells, and kept as it was it framed a 28,000-cell 2D file from
      // inside the cloud a 562,000-cell 3D preset had placed it in: a canvas
      // of giant points. A new scene starts from the default framing of its
      // dimension, which fits every normalized embedding; a session or a
      // published preset replayed afterwards still sets its own camera.
      resetViewCameraForDimension(LIVE_VIEW_ID, dimensionLevel);
      applyDimensionNavigationDefault(LIVE_VIEW_ID, dimensionLevel);
      vectorFieldOverlay?.markGeometryDirty?.(LIVE_VIEW_ID);
      publishSmokeSourceChange();
    },

    updateColors(colors) {
      assertExactUint8Array(colors, pointCount * 4, 'Viewer live colors');
      hpRenderer.updateColors(colors);
      colorsArray = colors;
      publishViewDataGeneration(LIVE_VIEW_ID);
      publishSmokeSourceChange();
    },

    updateTransparency(alphaArray) {
      assertExactUint8Array(
        alphaArray,
        pointCount,
        'Viewer live transparency'
      );
      highlightTools.retireSpatialInteractions(LIVE_VIEW_ID);
      if (
        !(transparencyArray instanceof Uint8Array) ||
        transparencyArray.length !== pointCount
      ) {
        throw new Error(
          'Viewer live transparency has no exact prior publication.'
        );
      }
      let rendererPublished = false;
      let alphaGenerationMoved = false;
      try {
        alphaGenerationMoved = hpRenderer.updateAlphas(alphaArray);
        rendererPublished = true;
        // A filter interaction republishes the whole transparency array even
        // when it moves no cell across the visible boundary, and invalidating
        // the highlight generation repacks and re-uploads one compact buffer of
        // every selected cell, per view. Both things the highlight publication
        // boundary owns -- the per-view packed buffer and the KNN traversal
        // cache -- admit a cell by exactly `alpha >= POINT_VISIBILITY_THRESHOLD`,
        // which is exactly `Math.round(alpha * 255) >= MIN_VISIBLE_ALPHA_BYTE`.
        // `updateAlphas` compares those bytes, so an unmoved R8 generation
        // certifies that neither owner can observe a difference.
        if (alphaGenerationMoved) {
          highlightTools.handleTransparencyChange(LIVE_VIEW_ID);
        }
      } catch (publicationError) {
        const restorationFailures = [];
        if (rendererPublished) {
          try {
            hpRenderer.updateAlphas(transparencyArray);
          } catch (restorationError) {
            restorationFailures.push(restorationError);
          }
        }
        try {
          // Application state commonly reuses and mutates its Uint8 owner
          // before calling this method. Restore that caller owner as part of
          // the same failed publication so state and rendering cannot diverge.
          alphaArray.set(transparencyArray);
        } catch (restorationError) {
          restorationFailures.push(restorationError);
        }
        if (restorationFailures.length > 0) {
          throw new AggregateError(
            [publicationError, ...restorationFailures],
            'Live point visibility publication failed with incomplete restoration.'
          );
        }
        throw publicationError;
      }

      transparencyArray.set(alphaArray);
      hpRenderer._adoptCurrentAlphasOwner(transparencyArray);
      if (alphaGenerationMoved && edgeLayer.hasView(LIVE_VIEW_ID)) {
        // Shown edges follow the published visibility: the first K visible
        // edges of the fixed order, re-selected now; the count follows in
        // slices. An unmoved generation (same bytes) shows the same edges.
        edgeLayer.publishVisibility(
          LIVE_VIEW_ID,
          createLodFilteredVisibilityOwner(
            transparencyArray,
            hpRenderer.getCurrentLodMembership(
              LIVE_VIEW_ID,
              getPublishedDimensionLevel(LIVE_VIEW_ID)
            )
          )
        );
        edgeLayer.refresh(LIVE_VIEW_ID);
      }
      publishViewDataGeneration(LIVE_VIEW_ID);
      // Let overlays (e.g., vector field particles) rebuild spawn sources lazily when visibility changes.
      if (vectorFieldOverlay?.enabled) {
        vectorFieldOverlay.markVisibilityDirty(LIVE_VIEW_ID);
      }
    },

    /**
     * Update positions for dimension switching (maintains same point count and indices).
     * Connectivity edges read the new positions on their next draw.
     * @param {Float32Array} positions - New positions (n_points * dimensionLevel)
     * @param {number} dimensionLevel - Dimension owned by this position generation.
     */
    updatePositions(positions, dimensionLevel) {
      getDefaultNavigationMode(dimensionLevel);
      assertFiniteFloat32Array(
        positions,
        pointCount * dimensionLevel,
        'Viewer live positions'
      );
      const previousDimensionLevel =
        getPublishedDimensionLevel(LIVE_VIEW_ID);
      const previousPositions = positionsArray;
      let rendererPublished = false;
      try {
        hpRenderer.updatePositions(positions, dimensionLevel);
        rendererPublished = true;
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
      publishViewPositions(LIVE_VIEW_ID, positions, dimensionLevel);
      computePointBoundsFromPositions(positions, dimensionLevel);
      publishViewDataGeneration(LIVE_VIEW_ID);
      vectorFieldOverlay?.markGeometryDirty?.(LIVE_VIEW_ID);
      publishSmokeSourceChange();
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
      const record = getExactViewPositionRecord(assertKnownViewId(viewId));
      const [x, y, z] = readPositionXYZ(
        record.positions,
        record.dimension,
        cellIndex,
        [0, 0, 0]
      );
      return Object.freeze({ x, y, z });
    },

    /**
     * Get point count
     * @returns {number}
     */
    getPointCount() {
      return pointCount;
    },

    /**
     * Publish the embedding a view shows: its dimension and the layout key
     * its positions belong to. The positions themselves were already
     * published through updatePositions / setViewPositions; this call
     * exposes their layout through viewer state.
     *
     * The layout, not the dimension, is the identity of a view's geometry:
     * switching between two layouts of one dimension changes LOD membership,
     * frustum culling, picking and vector spawn sources exactly as a
     * dimension switch does, so every per-view cache derived from the
     * geometry is invalidated whenever the layout key changes. The
     * navigation default follows only a dimension change; every layout is
     * normalized to the same extent, so the camera stays valid.
     *
     * @param {string} viewId - View identifier
     * @param {{ dimension: number, layoutKey: string }} embedding
     */
    setViewEmbedding(viewId, embedding) {
      const vid = assertViewId(viewId);
      if (
        embedding === null ||
        typeof embedding !== 'object' ||
        Array.isArray(embedding) ||
        Object.keys(embedding).sort().join(',') !== 'dimension,layoutKey'
      ) {
        throw new TypeError(
          'A view embedding must contain exactly dimension and layoutKey.'
        );
      }
      const level = embedding.dimension;
      getDefaultNavigationMode(level);
      const layoutKey = assertViewLayoutKey(
        embedding.layoutKey,
        `View "${vid}" embedding`
      );
      if (layoutKey === null) {
        throw new TypeError(
          `View "${vid}" embedding must name the layout of its positions.`
        );
      }
      const oldLevel = getPublishedDimensionLevel(vid);
      const oldLayoutKey = viewLayoutKeys.get(vid) ?? null;
      const layoutChanged = oldLayoutKey !== layoutKey;
      if (vid === LIVE_VIEW_ID && layoutChanged) {
        cancelPendingProjectileBuild(
          'Projectile preparation was cancelled because the live embedding changed.'
        );
        projectileSystem.setEnabled(false);
      }
      const snap = snapshotViewsById.get(vid);

      const positionDimension = hpRenderer.getViewPositionDimension(vid);
      if (
        positionDimension !== level ||
        getExactViewPositionDimension(vid) !== level
      ) {
        throw new Error(
          `View "${vid}" publishes ${positionDimension}D positions; publish ${level}D positions before its ${level}D dimension.`
        );
      }
      // Per-view LOD/frustum/picking caches describe the previous geometry.
      if (layoutChanged) {
        hpRenderer.invalidateViewState(vid);
        highlightTools.retireSpatialInteractions(vid);
      }

      // Linked cameras group views by representation: store the live camera
      // in its followers while they still follow it, so a view leaving the
      // group keeps what it showed.
      persistFocusedCamera();
      viewDimensionLevels.set(vid, level);
      viewLayoutKeys.set(vid, layoutKey);
      if (snap) {
        snap.dimensionLevel = level;
      }
      let joinedLinkedGroup = false;
      if (camerasLocked && layoutChanged && vid !== focusedViewId) {
        // A view that joins a linked group of another representation takes
        // that group's camera; one that joins the focused group follows the
        // live camera.
        const member = [LIVE_VIEW_ID, ...snapshotViews.map(snapshot => snapshot.id)].find(
          viewId => viewId !== vid && viewLayoutKeys.get(viewId) === layoutKey
        );
        if (member !== undefined) {
          joinedLinkedGroup = true;
          if (viewLayoutKeys.get(focusedViewId) !== layoutKey) {
            setViewCameraState(vid, getStoredViewCameraState(member));
          }
        }
      }
      refreshCameraFollowers();
      if (oldLevel !== level && !joinedLinkedGroup) {
        // A pose framed for one dimension does not frame another: a planar
        // close-up seen as an orbit sits inside the cloud. A view that changes
        // dimension starts from the default framing of its new dimension.
        resetViewCameraForDimension(vid, level);
      }

      // Invalidate cached view matrix since camera behavior may differ per dimension
      cachedViewMatrices.delete(vid);
      if (!cameraFollowers.has(vid)) {
        updateCachedViewMatrix(vid, getStoredViewCameraState(vid));
      }
      if (oldLevel !== level) {
        applyDimensionNavigationDefault(vid, level);
      }
      if (layoutChanged) {
        vectorFieldOverlay?.markLayoutDirty?.(vid);
      }
    },

    /**
     * Get the layout key of the embedding a view shows.
     * @param {string} viewId - View identifier
     * @returns {string|null} Null while the view shows no dataset.
     */
    getViewLayoutKey(viewId) {
      const vid = assertKnownViewId(viewId);
      if (!viewLayoutKeys.has(vid)) {
        throw new RangeError(
          `Layout state is not published for view "${vid}".`
        );
      }
      return viewLayoutKeys.get(vid);
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
     * Connectivity edges read the new positions on their next draw.
     * @param {string} viewId - View identifier
     * @param {Float32Array} positions - Positions (n_points * dimensionLevel)
     * @param {number} dimensionLevel - Dimension owned by this position generation.
     */
    setViewPositions(viewId, positions, dimensionLevel) {
      const vid = assertKnownViewId(viewId);
      getDefaultNavigationMode(dimensionLevel);
      assertFiniteFloat32Array(
        positions,
        pointCount * dimensionLevel,
        `Positions for view "${vid}"`
      );
      let publishedPositions = positions;
      const previousPositions = getExactViewPositions(vid);
      const previousDimensionLevel = getPublishedDimensionLevel(vid);
      let rendererPublished = false;

      // If this is the live view, update the main positions
      if (vid === LIVE_VIEW_ID) {
        try {
          hpRenderer.updatePositions(positions, dimensionLevel);
          rendererPublished = true;
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
        computePointBoundsFromPositions(positions, dimensionLevel);
      } else {
        try {
          hpRenderer.updateSnapshotPositions(
            vid,
            positions,
            dimensionLevel
          );
          rendererPublished = true;
          publishedPositions = hpRenderer.getSnapshotPositions(vid);
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
              publishViewPositions(
                vid,
                hpRenderer.getSnapshotPositions(vid),
                previousDimensionLevel
              );
            } catch (restorationError) {
              restorationFailures.push(restorationError);
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
      publishViewPositions(vid, publishedPositions, dimensionLevel);
      publishViewDataGeneration(vid);
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
      return new Uint8Array(getExactViewColors(viewId));
    },

    /**
     * Get transparency array for a specific view.
     * Used by selection tools to respect per-view filtering in multi-view mode.
     * @param {string} viewId - View identifier
     * @returns {Uint8Array|null} Transparency array (0 = hidden, 1 = visible)
     */
    getViewTransparency(viewId) {
      return getExactViewTransparency(viewId);
    },

    /**
     * Borrow the exact renderer-facing point arrays for one synchronous
     * calculation. The callback must treat all three arrays as read-only and
     * must not retain them after returning. Any Promise/thenable result, or
     * any point-data/dimension/LOD publication made from inside the callback,
     * invalidates the boundary and throws before this method returns.
     *
     * @param {string} viewId
     * @param {Function} callback
     * @returns {*} the callback's non-thenable result
     */
    withBorrowedViewData(viewId, callback) {
      const owner = captureExactViewDataOwnership(viewId);
      const payload = Object.freeze({
        positions: owner.positions,
        colors: owner.colors,
        transparency: owner.transparency,
        pointCount: owner.pointCount,
        dimensionLevel: owner.dimensionLevel,
        geometryGeneration: owner.geometryGeneration,
        lodMembership: owner.lodMembership,
        drawOrder: owner.drawOrder
      });
      return runSynchronousBorrowedViewDataCallback(
        callback,
        payload,
        () => assertViewDataOwnershipCurrent(owner)
      );
    },

    updateHighlight(highlightData, highlightedIndices = null) {
      // A selection preview republishes on every pointer move, mostly
      // unchanged; only a changed highlight redraws the scene.
      if (highlightTools.updateHighlight(highlightData, highlightedIndices)) {
        invalidateFrame();
      }
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

    /** Like pickCellRecordAtScreen, but never builds a missing large index. */
    pickReadyCellRecordAtScreen(screenX, screenY) {
      return pickReadyCellRecordAtScreen(screenX, screenY);
    },

    /**
     * Record the call stack of every frame invalidation (diagnostics; off by
     * default). Read it back through getFrameScheduleState().
     */
    setFrameInvalidationTracing(enabled) {
      frameInvalidationTracing = assertExactBoolean(
        enabled,
        'Frame invalidation tracing'
      );
      lastFrameInvalidationTrace = null;
    },

    /**
     * Why the frame loop would draw the next frame, for diagnostics: whether
     * the scene has settled (the loop draws nothing more until something
     * changes), whether a mutation or input invalidated it, the time-driven
     * effect still running (null when none), whether the canvas size differs
     * from the last drawn frame, and how far the loop is into its settle
     * window. Reading it changes nothing.
     */
    getFrameScheduleState() {
      const size = canvasResizeObserver.getSize();
      const now = performance.now();
      return Object.freeze({
        // The loop's own stop condition: true once nothing has started a
        // settle window and the last one has run out, so the next frame draws
        // nothing until something changes. This, not a wall-clock wait with
        // no draw in it, is when a scene is quiet: a renderer that takes
        // longer per frame than such a wait draws nothing in it while it is
        // still settling.
        settled: nextFrameCause(size) === null && settleWindowElapsed(),
        invalidated: frameInvalidated,
        animationCause: sceneAnimationCause(),
        canvasResized:
          size.width !== lastDrawnCanvasWidth || size.height !== lastDrawnCanvasHeight,
        lastCause: lastFrameCause,
        msSinceCause: now - lastFrameCauseTime,
        framesDrawnSinceCause,
        // Whether a frame callback is requested: false once the loop has
        // stopped on a settled scene, until something asks for a frame.
        frameArmed: animationHandle !== null,
        // With tracing on: the call stack of the last invalidation, so a
        // frame that should not have been drawn names who asked for it.
        lastInvalidationTrace: lastFrameInvalidationTrace,
      });
    },

    /**
     * Whether the camera is moving or being moved right now: a drag or a
     * touch gesture in progress, held navigation keys, inertia, a zoom still
     * easing toward its target, or a presented camera still settling. A pick
     * taken in that window describes a frame that is already gone, so hover
     * readers wait for it to end.
     */
    isCameraInMotion() {
      return (
        isDragging ||
        touchGesture === 'camera' ||
        touchGesture === 'two-pointer' ||
        isMovementKeyHeld() ||
        Math.abs(velocityTheta) > INERTIA_MIN_VELOCITY ||
        Math.abs(velocityPhi) > INERTIA_MIN_VELOCITY ||
        Math.hypot(velocityPanX, velocityPanY, velocityPanZ) >
          INERTIA_MIN_VELOCITY ||
        vec3.length(freeflyVelocity) > 0 ||
        radius !== targetRadius ||
        presentedCameraSettlement.isPending()
      );
    },

    /**
     * Build the spatial index of every presented large pane in a worker
     * (`prepareSpatialQueryIndices`).
     */
    prepareCellPicking() {
      return prepareSpatialQueryIndices();
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

    /**
     * Where the annotation tool reads each pane's field kind from:
     * `source(viewId)` returns 'none', 'continuous' or 'categorical' for the
     * field that pane is colored by. See `HighlightTools.setViewFieldKindSource`.
     */
    setViewFieldKindSource(source) {
      highlightTools.setViewFieldKindSource(source);
    },

    // Select mode: the on-screen stand-in for a held Alt key, so a finger (or
    // a plain click) runs the active highlight tool. See rendering/select-mode.js.
    setSelectMode(selectMode) {
      highlightTools.setSelectMode(selectMode);
    },

    getSelectMode() {
      return highlightTools.getSelectMode();
    },

    // Lasso selection API
    setLassoEnabled(enabled) {
      highlightTools.setLassoEnabled(enabled);
      // An armed tool's first press finds its index built off the main thread.
      if (enabled) void prepareSpatialQueryIndices();
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
      if (enabled === true) void prepareSpatialQueryIndices();
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
      if (enabled === true) void prepareSpatialQueryIndices();
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

    // Load the k-NN tool's graph: the edge payload's adjacency over the
    // published cells (`ConnectivityEdges`).
    loadKnnEdges(edgeData) {
      return highlightTools.loadKnnEdges(edgeData, pointCount);
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
    // The buffers keep their storage when a field has no centroids: the next
    // field's usually fit, and drawing reads only `centroidCount` points.
    if (nextCentroidCount === 0) {
      centroidCount = 0;
      return;
    }
    if (
      positions.byteLength <= centroidPositionCapacity &&
      colors.byteLength <= centroidColorCapacity
    ) {
      // Writes into accepted storage allocate nothing: only a lost context
      // refuses them, so no error is read back.
      requireLiveContext(gl, 'Viewer centroid publication');
      gl.bindBuffer(gl.ARRAY_BUFFER, centroidPositionBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
      gl.bindBuffer(gl.ARRAY_BUFFER, centroidColorBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, colors);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      requireLiveContext(gl, 'Viewer centroid publication');
      centroidCount = nextCentroidCount;
      return;
    }
    requireLiveContext(gl, 'Viewer centroid publication');
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
      // The one read: a refused allocation must not stay resident.
      requireCleanWebGLState(gl, 'Viewer candidate centroid publication');
    } catch (error) {
      const rollbackFailures = [];
      try {
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
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
    centroidPositionCapacity = positions.byteLength;
    centroidColorCapacity = colors.byteLength;
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

      const previousLabels =
        viewCentroidLabels.get(targetId) ??
        EMPTY_CENTROID_LABELS;
      const ownedEntries = entries.map(createOwnedCentroidLabel);
      cancelCentroidLabelRetirements(targetId, candidateElements);
      viewCentroidLabels.set(targetId, ownedEntries);
      hiddenCentroidLabelViews.delete(targetId);
      for (const element of candidateElements) {
        centroidLabelOwners.set(element, targetId);
      }
      queueCentroidLabelRetirements(
        targetId,
        previousLabels,
        candidateElements
      );
      if (!shouldShowCentroidLabels(targetId)) {
        hideLabelsForView(targetId);
      }

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
      const next = assertFiniteNumberInRange(
        size,
        MINIMUM_POINT_SIZE,
        MAXIMUM_POINT_SIZE,
        'Point size'
      );
      if (next === basePointSize) return;
      basePointSize = next;
      publishPresentedViewStateChange('style', focusedViewId);
    },
    setSizeAttenuation(value) {
      const next = assertFiniteNumberInRange(
        value,
        0,
        1,
        'Perspective size scaling'
      );
      if (next === sizeAttenuation) return;
      sizeAttenuation = next;
      publishPresentedViewStateChange('style', focusedViewId);
    },
    setLightingStrength(value) {
      const next =
        assertFiniteNumberInRange(value, 0, 1, 'Lighting strength');
      if (next === lightingStrength) return;
      lightingStrength = next;
      publishPresentedViewStateChange('style', focusedViewId);
    },
    setFogDensity(value) {
      const next =
        assertFiniteNumberInRange(value, 0, 1, 'Fog density');
      if (next === fogDensity) return;
      fogDensity = next;
      publishPresentedViewStateChange('style', focusedViewId);
    },
    setShowCentroidPoints(show, viewId) {
      const exactShow = assertExactBoolean(show, 'Centroid point visibility');
      const key = assertKnownViewId(viewId);
      if (setViewFlags(key, { points: exactShow })) {
        publishPresentedViewStateChange('overlay', key);
      }
    },

    setShowCentroidLabels(show, viewId) {
      const exactShow = assertExactBoolean(show, 'Centroid label visibility');
      const key = assertKnownViewId(viewId);
      const changed = setViewFlags(key, { labels: exactShow });
      if (!exactShow) hideLabelsForView(key);
      updateLabelLayerVisibility();
      if (changed) {
        publishPresentedViewStateChange('overlay', key);
      }
    },

    getCentroidFlags(viewId) { return getViewFlags(viewId); },
    setBackground,
    /** Diagnostics of the backdrop looks: bakes, slices, GPU bytes. */
    getBackdropLookDiagnostics: () => backdropLooks.getDiagnostics(),
    /**
     * Star twinkle and mote drift: off by default; when on, at most 30 Hz, and
     * never while the tab is hidden or the user prefers reduced motion.
     */
    setBackdropAmbientMotion: (enabled) => backdropLooks.setAmbientMotion(enabled),
    setViewportLeftOcclusionRatio(value) {
      const exactRatio = assertFiniteNumberInRange(
        value,
        0,
        1,
        'Viewport left occlusion ratio'
      );
      if (exactRatio === viewportLeftOcclusionRatio) return;
      viewportLeftOcclusionRatio = exactRatio;
      publishPresentedViewStateChange(
        'viewport',
        focusedViewId
      );
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
    setHighlightRenderFailureHandler(fn) {
      highlightRenderFailureHandler = assertExactFunction(
        fn,
        'Highlight render failure handler'
      );
    },
    setSmokeRenderFailureHandler(fn) {
      smokeRenderFailureHandler = assertExactFunction(
        fn,
        'Smoke render failure handler'
      );
    },
    setSmokeSourceChangeHandler(fn) {
      smokeSourceChangeHandler = assertExactFunction(
        fn,
        'Smoke source change handler'
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
      // The focused view's mode, shared by the views linked to its camera.
      for (const viewId of cameraFollowers) {
        if (viewExists(viewId)) settleViewNavigationOwnership(viewId, exactMode);
      }
      applyViewNavigationMode(focusedViewId, exactMode);
      if (navigationMode !== previousMode) {
        navigationModeChangeHandler?.(focusedViewId, navigationMode);
      }
      publishPresentedViewStateChange(
        'navigation',
        focusedViewId
      );
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
        settleProjectileBuildAsReady(completion);
        return;
      }

      const generation = projectileBuildGeneration;
      projectileBuildCompletion = completion;
      const stale = () => (
        generation !== projectileBuildGeneration ||
        getPublishedDimensionLevel(LIVE_VIEW_ID) !== dimLevel
      );
      const fail = detail => {
        const ownedCompletion = projectileBuildCompletion;
        projectileBuildCompletion = null;
        projectileSystem.setEnabled(false);
        if (isWebGLContextLostForAsyncCommit()) {
          publishProjectileBuildResult(
            ownedCompletion,
            'cancelled',
            PROJECTILE_CONTEXT_LOSS_MESSAGE
          );
          return;
        }
        publishProjectileBuildResult(
          ownedCompletion,
          'error',
          `Projectile preparation failed: ${detail}`
        );
      };
      // The collision tree is built off the main thread; projectiles are
      // ready when it lands.
      Promise.resolve().then(
        () => hpRenderer.buildSpatialIndexInBackground(LIVE_VIEW_ID)
      ).then(installed => {
        if (stale()) return;
        if (isWebGLContextLostForAsyncCommit()) {
          const ownedCompletion = projectileBuildCompletion;
          projectileBuildCompletion = null;
          publishProjectileContextLossCancellation(ownedCompletion);
          return;
        }
        if (!installed || !hpRenderer.hasSpatialIndex(dimLevel)) {
          fail(`the ${dimLevel}D spatial index could not be built.`);
          return;
        }
        const ownedCompletion = projectileBuildCompletion;
        projectileBuildCompletion = null;
        settleProjectileBuildAsReady(ownedCompletion);
      }, error => {
        if (generation !== projectileBuildGeneration) return;
        fail(error instanceof Error && error.message.length > 0 ? error.message : String(error));
      });
    },
    isProjectileSpatialIndexReady() {
      const dimLevel = getPublishedDimensionLevel(LIVE_VIEW_ID);
      return !!(hpRenderer && hpRenderer.hasSpatialIndex(dimLevel));
    },

    /** World positions of the projectiles in flight, as [x, y, z] copies. */
    getProjectilePositions() {
      return projectileSystem.getProjectilePositions();
    },

    // Orbit anchor visibility control
    setShowOrbitAnchor(show) {
      orbitAnchorRenderer.setShowAnchor(
        assertExactBoolean(show, 'Orbit anchor visibility')
      );
    },
    getShowOrbitAnchor() { return orbitAnchorRenderer.getShowAnchor(); },

    // Smoke renderer API (delegates to SmokeRenderer)
    clearSmokeVolume() { smokeRenderer.clearVolume(); },
    buildSmokeVolumeGPU(positions, options = {}) { return smokeRenderer.buildVolumeGPU(positions, options); },
    hasSmokeVolume() { return smokeRenderer.hasVolume(); },
    getSmokeSupport() { return smokeRenderer.getSupport(); },
    setSmokeParams(params) { smokeRenderer.setParams(params); },
    setCloudResolutionScale(scale) { smokeRenderer.setResolutionScale(scale); },
    getCloudResolutionScale() { return smokeRenderer.getResolutionScale(); },
    setNoiseTextureResolution(size) { smokeRenderer.setNoiseTextureResolution(size); },
    getNoiseTextureResolution() { return smokeRenderer.getNoiseTextureResolution(); },
    hasPendingSmokeNoiseGeneration() {
      return smokeRenderer.hasPendingNoiseGeneration();
    },
    hasSmokeNoiseTextures() { return smokeRenderer.hasNoiseTextures(); },

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
    hasConnectivityData() { return edgeLayer.hasGraph(); },
    getEdgeCount() { return edgeLayer.getEdgeCount(); },

    // ========================================================================
    // CONNECTIVITY EDGES (connectivity-edge-layer.js)
    // ========================================================================

    /**
     * Publish one connectivity graph and show it in the live pane. Endpoints
     * and Float32 relative strengths are kept as loaded (no copy, no
     * shuffle). Nothing is shown until the edge target is set
     * (`setEdgeVisibleTarget`).
     * @param {import('../data/connectivity-edges.js').ConnectivityEdges} edgeData
     */
    setupEdgesV2(edgeData) {
      if (
        edgeData === null ||
        typeof edgeData !== 'object' ||
        edgeData.nCells !== pointCount
      ) {
        throw new TypeError(
          'Connectivity edges must cover exactly the published cells.'
        );
      }
      edgeLayer.setGraph(edgeData);
      edgeLayer.addView(LIVE_VIEW_ID);
      useInstancedEdges = true;
      return true;
    },

    /**
     * Publish the live pane's edge visibility from its transparency and LOD
     * admission (no combined per-cell mask is built).
     */
    updateEdgeVisibilityV2FromLod(transparency, lodMembership) {
      if (!edgeLayer.hasView(LIVE_VIEW_ID)) return false;
      return edgeLayer.publishVisibility(
        LIVE_VIEW_ID,
        createLodFilteredVisibilityOwner(transparency, lodMembership)
      );
    },

    /** Publish one kept pane's edge visibility. */
    updateEdgeVisibilityV2ForViewFromLod(viewId, transparency, lodMembership) {
      const vid = assertViewId(viewId);
      if (!edgeLayer.hasView(vid)) return false;
      return edgeLayer.publishVisibility(
        vid,
        createLodFilteredVisibilityOwner(transparency, lodMembership)
      );
    },

    /**
     * Re-select a pane's shown edges if its visibility or the target moved,
     * and start counting its visible edges. Returns its statistics
     * (`visibleCount` is null until the count lands; see
     * `onConnectivityVisibleCount`).
     */
    refreshEdgeSelectionForView(viewId) {
      return edgeLayer.refresh(assertViewId(viewId));
    },

    /** Show the first `target` visible edges in every pane. */
    setEdgeVisibleTarget(target) {
      return edgeLayer.setVisibleTarget(target);
    },

    getEdgeSelectionStatsForView(viewId) {
      return edgeLayer.getStats(assertViewId(viewId));
    },

    /**
     * Subscribe to visible-edge counts as they land, pane by pane.
     * @param {(viewId: string, stats: object) => void} listener
     * @returns {() => void} Unsubscribe.
     */
    onConnectivityVisibleCount(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('Connectivity count listener must be a function.');
      }
      edgeVisibleCountListeners.add(listener);
      return () => edgeVisibleCountListeners.delete(listener);
    },

    isUsingInstancedEdges() {
      return useInstancedEdges;
    },

    clearEdgesV2() {
      edgeLayer.clear();
      useInstancedEdges = false;
    },

    /** Show the published graph in one more pane (a kept view). */
    setupEdgesV2ForView(viewId) {
      const vid = assertViewId(viewId);
      if (!edgeLayer.hasGraph() || !useInstancedEdges) return false;
      return edgeLayer.addView(vid);
    },

    hasConnectivityView(viewId) {
      return edgeLayer.hasView(assertViewId(viewId));
    },

    deleteConnectivityView(viewId) {
      return edgeLayer.deleteView(assertViewId(viewId));
    },

    /** GPU and CPU bytes the connectivity layer holds, by pane. */
    getConnectivityMemoryStats() {
      return edgeLayer.describeMemory();
    },

    resetCamera() {
      velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
      // One pose for both modes: free-fly sits where the orbit camera sits,
      // looking at the same target, so R frames the data in either mode.
      const pose = createDefaultCameraPose();
      radius = targetRadius = pose.orbit.radius;
      theta = pose.orbit.theta;
      phi = pose.orbit.phi;
      vec3.set(target, ...pose.orbit.target);
      vec3.set(freeflyPosition, ...pose.freefly.position);
      vec3.set(freeflyVelocity, 0, 0, 0);
      freeflyYaw = pose.freefly.yaw;
      freeflyPitch = pose.freefly.pitch;
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
      // Cinematic playback calls setCameraState() at frame cadence. The
      // allocation-free scalar tracker publishes one camera-changing event
      // for the whole burst and one camera-settled event after it, rather than
      // allocating and dispatching an event for every interpolated frame.
    },

    stopInertia() {
      velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
      vec3.set(freeflyVelocity, 0, 0, 0);
    },

    /**
     * Link cameras: views that show the same representation share one camera
     * and navigation mode; views of different representations always keep
     * their own. Linking gives every such group one camera (see
     * `unifyLinkedCameras`); unlinking leaves every view with what it shows.
     */
    setCamerasLocked(locked) {
      if (typeof locked !== 'boolean') {
        throw new TypeError('Camera lock state must be an exact boolean.');
      }
      if (locked === camerasLocked) return;
      persistFocusedCamera();
      camerasLocked = locked;
      unifyLinkedCameras();
      refreshCameraFollowers();
      publishPresentedViewStateChange(
        'camera-lock',
        focusedViewId
      );
    },

    /**
     * The views whose cameras are linked: one array of view ids per group of
     * two or more views that show the same representation, while cameras are
     * linked; empty otherwise.
     * @returns {string[][]}
     */
    getCameraLinkGroups() {
      if (!camerasLocked) return [];
      const groups = new Map();
      for (const viewId of [LIVE_VIEW_ID, ...snapshotViews.map(snapshot => snapshot.id)]) {
        if (viewId === LIVE_VIEW_ID && liveViewHidden) continue;
        const layoutKey = viewLayoutKeys.get(viewId) ?? null;
        if (layoutKey === null) continue;
        if (!groups.has(layoutKey)) groups.set(layoutKey, []);
        groups.get(layoutKey).push(viewId);
      }
      return [...groups.values()].filter(group => group.length > 1);
    },

    getCamerasLocked() { return camerasLocked; },

    /**
     * Set what each pane's title chip says before the view's field, or clear
     * it with null: the view controls publish "2 · PCA 2D" for every view
     * while several are open.
     * @param {Map<string, string|null>|Object<string, string|null>} prefixes
     */
    setViewTitlePrefixes(prefixes) {
      viewTitlePrefixes.clear();
      for (const [viewId, prefix] of prefixes instanceof Map ? prefixes : Object.entries(prefixes)) {
        if (prefix === null) continue;
        if (typeof prefix !== 'string' || prefix.length === 0) {
          throw new TypeError('A view title prefix must be a non-empty string or null.');
        }
        viewTitlePrefixes.set(String(viewId), prefix);
      }
      publishPresentedViewStateChange('titles', focusedViewId);
    },

    /**
     * Drop the GPU geometry kept for one representation's positions (their
     * CPU copy was evicted), or for every representation no view shows.
     */
    releaseRepresentationGeometry(positions) {
      return hpRenderer.releaseRetainedGeometryFor(positions);
    },
    releaseRetainedGeometry() {
      return hpRenderer.evictRetainedGeometry(Infinity);
    },
    /** Bytes of GPU geometry kept for representations no view shows. */
    getRetainedGeometryBytes() {
      return hpRenderer.getRetainedGeometryBytes();
    },
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
      settleViewNavigationOwnership(exactViewId, exactMode);
      const ownedState =
        setViewCameraState(exactViewId, exactState);
      if (cameraFollowers.has(exactViewId)) {
        const previousMode = navigationMode;
        // This explicit external/session publication supersedes active
        // interaction inertia. Internal focus/mouse persistence continues to
        // use the store-only helper above and never cancels a release glide.
        velocityTheta = velocityPhi =
          velocityPanX = velocityPanY = velocityPanZ = 0;
        vec3.set(freeflyVelocity, 0, 0, 0);
        applyCameraStateTemporarily(ownedState);
        if (navigationMode !== previousMode) {
          navigationModeChangeHandler?.(
            exactViewId,
            navigationMode
          );
        }
      }
      publishPresentedViewStateChange(
        'camera',
        exactViewId
      );
    },

    // Per-view navigation mode: each view's own, shared only by views linked
    // to one camera.
    getViewNavigationMode(viewId) { return getViewNavigationMode(viewId); },
    setViewNavigationMode(viewId, mode) {
      const exactViewId = assertKnownViewId(viewId);
      const exactMode = assertNavigationMode(mode);
      const previousMode = navigationMode;
      settleViewNavigationOwnership(exactViewId, exactMode);
      applyViewNavigationMode(exactViewId, exactMode);
      if (navigationMode !== previousMode) {
        navigationModeChangeHandler?.(exactViewId, navigationMode);
      }
      publishPresentedViewStateChange(
        'navigation',
        exactViewId
      );
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
      const nextLabel = assertNonEmptyTrimmedString(label, 'Live view label');
      // The label is drawn as the pane's title chip; an unchanged one changes
      // nothing on screen (see SELF_INVALIDATING_VIEWER_METHODS).
      if (nextLabel === liveViewLabel) return;
      liveViewLabel = nextLabel;
      invalidateFrame();
    },
    getLiveViewLabel() { return liveViewLabel; },

    // Snapshot API - stores view configs for multiview
    createSnapshotView(config) {
      if (renderMode === 'smoke') {
        throw new RangeError(
          'Snapshot creation is unavailable in smoke render mode.'
        );
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
      const sourceRecord = getExactViewPositionRecord(sourceViewId);
      const sourcePositions = sourceRecord.positions;
      const exactConfig = assertSnapshotConfig(
        config,
        sourcePositions.length / sourceRecord.dimension
      );
      if (exactConfig.dimensionLevel !== sourceRecord.dimension) {
        throw new RangeError(
          `Snapshot dimensionLevel ${exactConfig.dimensionLevel} does not match the ${sourceRecord.dimension}D positions of source view "${sourceViewId}".`
        );
      }
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
      let edgeViewAttempted = false;
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
            snapshot.centroidColors
          );
        }

        if (useInstancedEdges && edgeLayer.hasGraph()) {
          edgeViewAttempted = true;
          edgeLayer.addView(id);
          edgeLayer.publishVisibility(
            id,
            createLodFilteredVisibilityOwner(snapshot.transparency, null)
          );
          edgeLayer.refresh(id);
        }

        updateCachedViewMatrix(id, exactConfig.cameraState);
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
        if (edgeViewAttempted) {
          rollback(() => edgeLayer.deleteView(id));
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
      snapshotViewsById.set(id, snapshot);
      certifiedCameraStateOwners.add(snapshot.cameraState);
      viewDimensionLevels.set(id, initialDimLevel);
      viewLayoutKeys.set(id, viewLayoutKeys.get(sourceViewId) ?? null);
      publishViewPositions(id, snapshotPositions, initialDimLevel);
      // A kept view navigates as its source does, in every dimension.
      navigationModeOwnership.copyView(sourceViewId, id);
      settleViewNavigationOwnership(id, inheritedMode);
      refreshCameraFollowers();
      publishViewDataGeneration(id);
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
      const snap = snapshotViewsById.get(exactId);
      const pointCountForSnapshot =
        getExactViewPositions(exactId).length /
        getExactViewPositionDimension(exactId);
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

      // Colors are adopted by reference, as at creation (see
      // assertSnapshotConfig). Transparency is published from the caller's
      // array and copied into the view's own owner (made at creation) only
      // once the publication succeeded, so a failed one leaves the accepted
      // generation intact without a new array per update.
      const nextColors = colorsChanged
        ? assertExactUint8Array(
            attrs.colors,
            pointCountForSnapshot * 4,
            'Snapshot colors'
          )
        : snap.colors;
      const nextTransparency = transparencyChanged
        ? assertTransparencyArray(
            attrs.transparency,
            pointCountForSnapshot,
            'Snapshot transparency'
          )
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

      // A point or centroid buffer write changes the frame, and so can a
      // failed one whose restoration is incomplete, so either invalidates
      // before any GPU work. Of the descriptive attributes only the label is
      // drawn (the pane's title chip); the field descriptor and the filter
      // metadata are read back through getSnapshotViews(), never by a frame.
      // A label push that repeats the current label leaves the frame alone
      // (see SELF_INVALIDATING_VIEWER_METHODS).
      if (colorsChanged || transparencyChanged || centroidPositionsChanged) {
        invalidateFrame();
      }
      const labelChanged = nextLabel !== snap.label;

      if (transparencyChanged) {
        highlightTools.retireSpatialInteractions(exactId);
      }
      // Whether any alpha byte moved: an alpha-only publication reports it
      // (the bytes it compared), so an unmoved one skips the highlight, edge
      // and overlay work that follows visibility.
      let visibilityMoved = transparencyChanged;
      if (colorsChanged || transparencyChanged) {
        const publishSnapshotPointAttributes = (colors, transparency) => {
          if (colorsChanged && transparencyChanged) {
            hpRenderer.updateSnapshotBuffer(
              exactId,
              colors,
              transparency,
              getExactViewPositions(exactId),
              getPublishedDimensionLevel(exactId)
            );
            return true;
          }
          if (colorsChanged) {
            hpRenderer.updateSnapshotColors(exactId, colors);
            return false;
          }
          return hpRenderer.updateSnapshotAlphas(exactId, transparency);
        };
        let rendererPublished = false;
        try {
          const moved = publishSnapshotPointAttributes(nextColors, nextTransparency);
          rendererPublished = true;
          visibilityMoved = transparencyChanged && moved;
          if (visibilityMoved) {
            highlightTools.handleTransparencyChange(exactId);
          }
        } catch (publicationError) {
          if (rendererPublished) {
            const restorationFailures = [];
            try {
              publishSnapshotPointAttributes(
                snap.colors,
                snap.transparency
              );
            } catch (restorationError) {
              restorationFailures.push(restorationError);
            }
            if (restorationFailures.length > 0) {
              throw new AggregateError(
                [publicationError, ...restorationFailures],
                `Snapshot "${exactId}" point publication failed with incomplete restoration.`
              );
            }
          }
          throw publicationError;
        }
      }

      if (centroidPositionsChanged) {
        createCentroidSnapshotBuffer(
          exactId,
          nextCentroidPositions,
          nextCentroidColors
        );
      }

      snap.colors = nextColors;
      if (transparencyChanged) snap.transparency.set(nextTransparency);
      if (visibilityMoved && edgeLayer.hasView(exactId)) {
        edgeLayer.publishVisibility(
          exactId,
          createLodFilteredVisibilityOwner(
            snap.transparency,
            hpRenderer.getCurrentLodMembership(
              exactId,
              getPublishedDimensionLevel(exactId)
            )
          )
        );
        edgeLayer.refresh(exactId);
      }
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

      if (colorsChanged || transparencyChanged) {
        publishViewDataGeneration(exactId);
      }
      if (
        visibilityMoved &&
        vectorFieldOverlay !== null &&
        vectorFieldOverlay.enabled
      ) {
        vectorFieldOverlay.markVisibilityDirty(exactId);
      }
      if (labelChanged) invalidateFrame();
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
        retry(() => edgeLayer.deleteView(exactId));
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
        snapshotViewsById.delete(exactId);
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
        cleanup(() => edgeLayer.deleteView(exactId));
        cleanup(() => orbitAnchorRenderer.deleteViewState(exactId));
        cachedViewMatrices.delete(exactId);
        renderParamsByView.delete(exactId);
        studioPaneStates.delete(exactId);
        backdropLooks.forgetView(exactId);
        overlayCtxByView.delete(exactId);
        overlayCtxOptionsByView.delete(exactId);
        viewDimensionLevels.delete(exactId);
        viewLayoutKeys.delete(exactId);
        viewPositionsCache.delete(exactId);
        viewDataGenerations.delete(exactId);
        publishedLodCertificates.delete(exactId);
        cleanup(() => vectorFieldOverlay?.disposeView?.(exactId));
        cleanup(() => navigationModeOwnership.deleteView(exactId));
        const key = exactId;
        if (key !== LIVE_VIEW_ID) {
          cleanup(() => removeLabelsForView(key));
          viewCentroidFlags.delete(key);
        }
        if (focusedViewId === exactId) {
          cleanup(() => transferViewFocus(LIVE_VIEW_ID, { saveOutgoing: false }));
        }
        cleanup(() => refreshCameraFollowers());
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
      snapshotViewsById.clear();
      for (const snapshot of removedSnapshots) {
        pendingSnapshotCleanupIds.add(snapshot.id);
      }
      const cleanupIds = Array.from(pendingSnapshotCleanupIds);
      liveViewHidden = false;
      const cleanupFailures = [];
      const cleanup = operation => {
        try {
          operation();
        } catch (error) {
          cleanupFailures.push(error);
        }
      };
      if (focusedViewId !== LIVE_VIEW_ID) {
        // The focused snapshot's camera dies with it; the live pane gets its
        // own camera back rather than inheriting the removed pane's globals.
        cleanup(() => transferViewFocus(LIVE_VIEW_ID, { saveOutgoing: false }));
      }
      focusedViewId = LIVE_VIEW_ID;
      cameraFollowers = new Set([LIVE_VIEW_ID]);

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
      for (const id of edgeLayer.getViewIds()) {
        if (id !== LIVE_VIEW_ID) {
          cleanup(() => edgeLayer.deleteView(id));
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
      for (const viewId of cleanupIds) {
        cleanup(() => highlightTools.clearViewState(viewId));
        cachedViewMatrices.delete(viewId);
        renderParamsByView.delete(viewId);
        studioPaneStates.delete(viewId);
        backdropLooks.forgetView(viewId);
        overlayCtxByView.delete(viewId);
        overlayCtxOptionsByView.delete(viewId);
        viewDimensionLevels.delete(viewId);
        viewLayoutKeys.delete(viewId);
        viewPositionsCache.delete(viewId);
        viewDataGenerations.delete(viewId);
        publishedLodCertificates.delete(viewId);
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
      const changesLayout = mode !== viewLayoutMode;
      const changesFocus = exactActiveId !== focusedViewId;

      viewLayoutMode = mode;
      if (changesFocus) {
        transferViewFocus(exactActiveId, { saveOutgoing: true });
      }
      if (viewLayoutMode === 'single') {
        for (const key of viewCentroidLabels.keys()) {
          if (key !== focusedViewId) {
            hideLabelsForView(key);
          }
        }
      }
      updateLabelLayerVisibility();
      if (changesLayout || changesFocus) {
        publishPresentedViewStateChange(
          'layout',
          focusedViewId
        );
      }
    },

    getViewLayout() { return { mode: viewLayoutMode, activeId: focusedViewId, liveViewHidden }; },

    /**
     * The presented layout: where every presented view sits on the canvas.
     *
     * One frozen object, stable until the canvas size, device pixel ratio,
     * sidebar occlusion (setViewportLeftOcclusionRatio), layout mode, focus
     * (single layout), or view inventory changes. `presentedArea` is the part
     * of the canvas the sidebar leaves uncovered; each of `panes` (in render
     * order) carries its WebGL viewport (`viewport*`, framebuffer pixels,
     * bottom-left origin), its render rectangle (`css*`) and presented
     * rectangle (`visibleCss*`) in canvas-local CSS pixels (top-left
     * origin), and the horizontal NDC of its principal point
     * (`projectionCenterNdcX`). Grid cells all have the same size and lie
     * inside the presented area; a single view renders the whole canvas with
     * its principal point at the presented area's centre. Null while the
     * canvas has no area.
     *
     * @returns {Object|null}
     */
    getPresentedLayout() {
      return getPresentedLayout();
    },

    /**
     * Observe the presented layout. The listener receives the current layout
     * at once (when the canvas has an area) and every newly resolved layout
     * after it: one call per geometry change, never per frame. Returns the
     * unsubscribe function.
     *
     * @param {(layout: Object) => void} listener
     * @returns {() => void}
     */
    onPresentedLayoutChange(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('Presented-layout listener must be a function.');
      }
      const current = getPresentedLayout();
      presentedLayoutListeners.add(listener);
      if (current !== null) listener(current);
      return () => {
        presentedLayoutListeners.delete(listener);
      };
    },

    setLiveViewHidden(hidden) {
      const exactHidden = assertExactBoolean(hidden, 'Live view visibility');
      if (exactHidden === liveViewHidden) return;
      if (exactHidden) {
        if (snapshotViews.length === 0) {
          throw new Error(
            'The live view cannot be hidden without a published snapshot.'
          );
        }
        if (
          focusedViewId === LIVE_VIEW_ID ||
          !snapshotViewsById.has(focusedViewId)
        ) {
          throw new Error(
            'The live view can be hidden only while a published snapshot has focus.'
          );
        }
      }
      liveViewHidden = exactHidden;
      publishPresentedViewStateChange(
        'layout',
        focusedViewId
      );
    },

    getLiveViewHidden() {
      return liveViewHidden;
    },

    getGLContext() { return gl; },
    getHPRenderer() { return hpRendererFacade; },
    isWebGL2() { return true; },

    /**
     * Draw the scene antialiased, or stop.
     *
     * Takes effect on the next frame. Returns what is actually in force, which
     * is not always what was asked for: a device that cannot multisample answers
     * `false` to a request for `true`, and the control is entitled to say so
     * rather than showing a setting that does nothing.
     *
     * @param {boolean} enabled
     * @returns {boolean}
     */
    setAntialiasing(enabled) {
      return sceneMsaaTarget.setEnabled(
        assertExactBoolean(enabled, 'Scene antialiasing')
      );
    },

    /** Whether the scene is being drawn antialiased right now. */
    getAntialiasing() { return sceneMsaaTarget.isEnabled(); },

    /**
     * Whether this device can multisample at all.
     *
     * False means the setting cannot be honoured on this hardware, which is a
     * refusal to report rather than a state to keep offering.
     */
    isAntialiasingAvailable() { return sceneMsaaTarget.isAvailable(); },

    /** Samples per pixel while antialiasing is on, or 0 when unavailable. */
    getAntialiasingSampleCount() {
      return sceneMsaaTarget.getSampleCount();
    },

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

    setVectorFieldData(fieldId, layoutKey, fieldData) {
      if (vectorFieldOverlay !== null) {
        vectorFieldOverlay.setVectorFieldData(
          fieldId,
          layoutKey,
          fieldData
        );
        return;
      }
      overlayManager?.retryRetirement(VELOCITY_OVERLAY_ID);
      const candidate = new VelocityOverlay(gl);
      candidate.setFailureHandler(reportVelocityRenderFailure);
      candidate.setPositionRetention(positions => hpRenderer.holdsGeometryFor(positions));
      try {
        candidate.setVectorFieldData(fieldId, layoutKey, fieldData);
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

    hasVectorFieldForLayout(fieldId, layoutKey) {
      const exactFieldId = validateVelocityFieldId(fieldId);
      if (assertViewLayoutKey(layoutKey, 'Vector field') === null) {
        throw new TypeError('Vector field layoutKey must be a non-empty string.');
      }
      if (vectorFieldOverlay === null) return false;
      return vectorFieldOverlay.hasFieldForLayout(
        exactFieldId,
        layoutKey
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
      const canvasSize = canvasResizeObserver.getSize();
      const width = canvasSize.width;
      const height = canvasSize.height;
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
      const canvasSize = canvasResizeObserver.getSize();
      const canvasW = canvasSize.width;
      const canvasH = canvasSize.height;
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

    /**
     * Capture the exact state currently presented for one visible pane.
     *
     * Unlike getViewRenderState(), this derives the real framebuffer pane,
     * sidebar-aware projection, and camera owner used by the live render loop.
     * It is observational: the active camera and HighPerfRenderer fog scalars
     * are never mutated.
     *
     * @param {string} viewId
     * @returns {{
     *   renderState: Object,
     *   cameraState: Object,
     *   dimensionLevel: number,
     *   geometryGeneration: number,
     *   lodMembership: Object|null,
     *   lodSizeMultiplier: number,
     *   certificate: Object
     * }}
     */
    getPresentedViewState(viewId) {
      const owner = captureExactViewDataOwnership(viewId);
      const layout = getPresentedLayout();
      if (layout === null) {
        throw new Error('The viewer presents no pane while its canvas has no area.');
      }
      const pane = getPresentedPane(layout, owner.viewId);
      const paneIndex = layout.panes.indexOf(pane);

      const followsFocusedCamera = cameraFollowers.has(owner.viewId);
      const useStoredCamera = layout.gridMultiview && !followsFocusedCamera;
      const globalCameraState = getCurrentCameraStateInternal();
      const storedCameraState = useStoredCamera
        ? getViewCameraState(owner.viewId)
        : null;
      const cameraState = selectPresentedCameraState({
        followsFocusedCamera,
        globalCameraState,
        gridMultiview: layout.gridMultiview,
        storedCameraState,
        viewId: owner.viewId
      });

      const viewMtx = mat4.create();
      computeViewMatrixFromState(cameraState, viewMtx);
      const projMtx = mat4.clone(
        getPresentedPaneProjection(layout, paneIndex)
      );
      const projectionCenterNdcX = pane.projectionCenterNdcX;
      const mvpMtx = mat4.create();
      mat4.multiply(mvpMtx, projMtx, viewMtx);
      mat4.multiply(mvpMtx, mvpMtx, modelMatrix);

      const invView = mat4.create();
      if (mat4.invert(invView, viewMtx) === null) {
        throw new Error(
          `Presented camera matrix for view "${owner.viewId}" is not invertible.`
        );
      }
      const cameraPosition = [
        invView[12],
        invView[13],
        invView[14]
      ];
      const cameraDistance =
        cameraState.navigationMode === 'free'
          ? Math.sqrt(
              cameraState.freefly.position[0] ** 2 +
              cameraState.freefly.position[1] ** 2 +
              cameraState.freefly.position[2] ** 2
            )
          : cameraState.orbit.radius;
      const fogRange = hpRenderer.getViewFogRange(
        owner.viewId,
        cameraPosition
      );
      // Everything the studio backdrop of this pane is drawn from besides the
      // matrices, so figure export can reproduce it. The surface is the
      // settled one for the presented camera.
      const studioState = getStudioPaneState(owner.viewId);
      const backdrop = Object.freeze({
        centerY: studioState.centerY,
        extentX: studioState.extentX,
        extentY: studioState.extentY,
        extentZ: studioState.extentZ,
        flat: studioState.flat,
        floorY: studioState.floorY,
        glowCenterX: projectionCenterNdcX,
        pixelRatio: pane.viewportWidth / pane.cssWidth,
        planarity: studioSurfacePlanarity(
          owner.dimensionLevel,
          cameraState.navigationMode
        ),
        stageX: studioState.stageX,
        stageZ: studioState.stageZ,
        // The active backdrop look as this pane shows it, frozen for figure
        // export (rendering/backdrops/); null without one.
        look: backdropLooks.getExportState(owner.viewId)
      });

      // No user callback or await occurs above, but retain the same exact
      // ownership fence as the borrowed-data path so future helper changes
      // cannot silently create a mixed presentation snapshot.
      assertViewDataOwnershipCurrent(
        owner,
        'Presented point data'
      );

      const cameraKey = JSON.stringify({
        cameraState,
        viewMatrix: Array.from(viewMtx)
      });
      // The whole resolved layout: canvas size, sidebar occlusion, mode,
      // inventory, and every pane rectangle.
      const layoutKey = JSON.stringify({
        camerasLocked,
        cameraFollowers: [...cameraFollowers],
        focusedViewId,
        layout
      });
      const renderKey = JSON.stringify({
        background: bgColor,
        fogColor,
        fogDensity,
        fov,
        lightingStrength,
        lightDir: Array.from(lightDir),
        modelMatrix: Array.from(modelMatrix),
        near,
        far,
        pointSize: basePointSize,
        projectionMatrix: Array.from(projMtx),
        shaderQuality: currentShaderQuality,
        sizeAttenuation
      });
      const lodGenerationToken =
        owner.lodMembership?.generationToken ?? null;
      const presentedLodMembership =
        createPresentedLodMembership(owner.lodMembership);
      const lodGenerationId = getPresentedLodGenerationId(
        lodGenerationToken
      );
      const certificate = Object.freeze({
        cacheKey: [
          owner.viewId,
          owner.dataGeneration,
          owner.dimensionLevel,
          owner.geometryGeneration,
          owner.lodLevel,
          owner.lodSizeMultiplier,
          lodGenerationId,
          cameraKey,
          layoutKey,
          renderKey
        ].join('|'),
        cameraKey,
        dataGeneration: owner.dataGeneration,
        dimensionLevel: owner.dimensionLevel,
        geometryGeneration: owner.geometryGeneration,
        layoutKey,
        lodGenerationId,
        lodGenerationToken,
        lodLevel: owner.lodLevel,
        lodSizeMultiplier: owner.lodSizeMultiplier,
        renderKey,
        viewId: owner.viewId
      });
      const renderState = {
        backdrop,
        bgColor: new Float32Array(bgColor),
        cameraDistance,
        cameraPosition,
        canvasHeight: layout.canvasHeight,
        canvasWidth: layout.canvasWidth,
        far,
        fogColor: new Float32Array(fogColor),
        fogDensity,
        fogFar: fogRange.fogFar,
        fogNear: fogRange.fogNear,
        fov,
        lightingStrength,
        lightDir: new Float32Array(lightDir),
        modelMatrix: new Float32Array(modelMatrix),
        mvpMatrix: new Float32Array(mvpMtx),
        near,
        // The presented pane (frozen): render and visible rectangles in
        // canvas-local CSS pixels, framebuffer viewport, principal point.
        pane,
        pointSize: basePointSize,
        projectionCenterNdcX,
        projectionMatrix: new Float32Array(projMtx),
        scissorEnabled: pane.scissorEnabled,
        shaderQuality: currentShaderQuality,
        sizeAttenuation,
        viewId: owner.viewId,
        viewMatrix: new Float32Array(viewMtx),
        viewportHeight: pane.viewportHeight,
        viewportWidth: pane.viewportWidth,
        viewportX: pane.viewportX,
        viewportY: pane.viewportY
      };

      return Object.freeze({
        renderState,
        cameraState,
        dimensionLevel: owner.dimensionLevel,
        geometryGeneration: owner.geometryGeneration,
        lodMembership: presentedLodMembership,
        lodSizeMultiplier: owner.lodSizeMultiplier,
        certificate
      });
    },

    // HP renderer controls
    setShaderQuality(quality) {
      if (quality === currentShaderQuality) return;
      hpRenderer.setQuality(quality);
      highlightTools.setQuality(quality);
      currentShaderQuality = quality;
      publishPresentedViewStateChange(
        'style',
        focusedViewId
      );
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

    // Compact shared LOD membership for filtering/highlight/export consumers.
    getCurrentLodMembership(viewId, dimensionLevel) {
      return hpRenderer.getCurrentLodMembership(
        assertKnownViewId(viewId),
        dimensionLevel
      );
    },
    getCurrentLODLevel(viewId) {
      return hpRenderer.getCurrentLODLevel(assertKnownViewId(viewId));
    },
    /**
     * Whether every presented view draws from its final geometry: no spatial
     * tree is still to land and no store still to adopt a draw order. The
     * benchmark starts a measurement window only once this holds.
     */
    isPresentedGeometrySettled() {
      return hpRenderer.isPresentedGeometrySettled();
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
        if (
          !viewPositionsCache.has(viewId) ||
          publishedLodCertificates.has(viewId)
        ) continue;
        const certificate = createLodPublicationCertificate(viewId);
        publishedLodCertificates.set(viewId, certificate);
      }
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        lodChangeListeners.delete(exactListener);
      };
    },
    onPresentedViewStateChanged(listener) {
      const exactListener = assertExactFunction(
        listener,
        'Presented-state change listener'
      );
      presentedViewStateListeners.add(exactListener);
      // The next frame establishes a scalar baseline. No initial event is
      // emitted because subscribers already build their initial state.
      presentedFrameState.initialized = false;
      presentedFrameState.pending = false;
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        presentedViewStateListeners.delete(exactListener);
        if (presentedViewStateListeners.size === 0) {
          presentedFrameState.initialized = false;
          presentedFrameState.pending = false;
        }
      };
    },
    start() {
      if (disposed || webglContextLost) return;
      if (renderPaused) return;
      frameLoopStarted = true;
      invalidateFrame();
      reconcileFramePhases();
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
      reconcileFramePhases();
    },

    /**
     * Resume after `pause()`.
     */
    resume() {
      if (disposed || webglContextLost) return;
      renderPaused = false;
      frameLoopStarted = true;
      invalidateFrame();
      reconcileFramePhases();
    },

    isPaused() {
      return renderPaused;
    },

    isDisposed() {
      return disposed;
    },

    isContextLost() {
      return webglContextLost;
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
	      if (contextLossTransitioning) {
	        disposalRequestedDuringContextLoss = true;
	        return;
	      }
	      if (disposalInProgress) return;
	      disposalInProgress = true;
	      try {
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
	        reconcileFramePhases();
	        // The overlay manager becomes the sole retry owner immediately.
	        vectorFieldOverlay = null;
	      }

	      attempt('projectile build cancellation', () => {
	        cancelPendingProjectileBuild(
	          'Projectile preparation was cancelled because the viewer was disposed.'
	        );
	      });
	      attempt('pointer-lock retirement', () => {
	        retirePointerLockLifecycle(null);
	      });
	      attempt('projectile activity fence', () => {
	        projectileSystem.setEnabled(false);
	      });
	      attempt('event listener retirement', () => {
	        retireCleanupCallbacks(
	          eventCleanupFns,
	          'Viewer event-listener'
	        );
	      });
	      attempt('resize observer retirement', () => {
	        canvasResizeObserver.disconnect();
	      });
	      attempt('context overlay retirement', () => {
	        const overlayFailures = [];
	        try {
	          retireCleanupCallbacks(
	            webglContextOverlayCleanupFns,
	            'Viewer WebGL context-overlay listener'
	          );
	        } catch (error) {
	          overlayFailures.push(error);
	        }
	        const ownedOverlay = webglContextOverlay;
	        if (ownedOverlay?.parentNode) {
	          try {
	            ownedOverlay.parentNode.removeChild(ownedOverlay);
	          } catch (error) {
	            if (ownedOverlay.parentNode !== null) {
	              overlayFailures.push(error);
	            }
	          }
	        }
	        if (!ownedOverlay || ownedOverlay.parentNode === null) {
	          webglContextOverlay = null;
	          webglContextOverlayMessage = null;
	          webglContextOverlayAction = null;
	        }
	        if (overlayFailures.length > 0) {
	          throw new AggregateError(
	            overlayFailures,
	            'Viewer WebGL context overlay retirement was incomplete.'
	          );
	        }
	      });
	      attempt('view-title retirement', () => {
	        retireViewTitleOwners();
	      });
	      attempt('centroid-label retirement', () => {
	        retireCentroidLabelOwners();
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
	      attempt('connectivity edge retirement', () => {
	        edgeLayer.dispose();
	      });
	      attempt('high-performance renderer retirement', () => {
	        disposeHpRenderer();
	      });
	      attempt('scene multisample target retirement', () => {
	        sceneMsaaTarget.dispose();
	      });
	      attempt('highlight tools retirement', () => {
	        highlightTools?.dispose?.();
	        highlightTools = null;
	      });
	      attempt('smoke renderer retirement', () => {
	        smokeRenderer.dispose();
	      });

	      attempt('grid program', () => {
	        if (!webglContextLost && gridProgram) {
	          deleteProgramReleasingUse(gl, gridProgram);
	        }
	        gridProgram = null;
	        for (const key of Object.keys(gridUniformLocations)) {
	          gridUniformLocations[key] = null;
	        }
	      });
	      attempt('studio backdrop program', () => {
	        if (!webglContextLost && studioProgram) {
	          deleteProgramReleasingUse(gl, studioProgram);
	        }
	        studioProgram = null;
	        for (const key of Object.keys(studioUniformLocations)) {
	          studioUniformLocations[key] = null;
	        }
	      });
	      attempt('studio backdrop vertex array', () => {
	        if (!webglContextLost && studioVao) {
	          gl.deleteVertexArray(studioVao);
	        }
	        studioVao = null;
	      });
	      attempt('backdrop looks', () => {
	        if (webglContextLost) backdropLooks.abandon();
	        else backdropLooks.dispose();
	      });
	      attempt('studio backdrop corner buffer', () => {
	        if (!webglContextLost && studioCornerBuffer) {
	          gl.deleteBuffer(studioCornerBuffer);
	        }
	        studioCornerBuffer = null;
	      });
	      attempt('centroid program', () => {
	        if (!webglContextLost && centroidProgram) {
	          deleteProgramReleasingUse(gl, centroidProgram);
	        }
	        centroidProgram = null;
	        for (const key of Object.keys(centroidUniformLocations)) {
	          centroidUniformLocations[key] = null;
	        }
	      });
	      attempt('centroid position buffer', () => {
	        if (centroidPositionBuffer) {
	          gl.deleteBuffer(centroidPositionBuffer);
	          centroidPositionBuffer = null;
	        }
	        centroidPositionCapacity = 0;
	        centroidColorCapacity = 0;
	      });
	      attempt('centroid color buffer', () => {
	        if (centroidColorBuffer) {
	          gl.deleteBuffer(centroidColorBuffer);
	          centroidColorBuffer = null;
	        }
	      });
	      attempt('centroid vertex array', () => {
	        if (centroidVao) {
	          gl.deleteVertexArray(centroidVao);
	          centroidVao = null;
	        }
	      });
	      attempt('viewer cache retirement', () => {
	        retireViewerCpuCaches();
	      });

	      if (failures.length > 0) {
	        throw new AggregateError(
	          failures,
	          `Viewer disposal remains pending for ${failures.length} owner(s).`
	        );
	      }
	      pendingSnapshotCleanupIds.clear();
	      retireCleanupCallbacks(
	        contextEventCleanupFns,
	        'Viewer WebGL context-listener'
	      );
	      disposalSettled = true;
	      } finally {
	        disposalInProgress = false;
	      }
	    }
  };

  // Disposal is a terminal lifecycle boundary. Keep only the explicit
  // diagnostics, retryable disposal, and inert loop controls callable after
  // either terminal transition. Guarding the returned methods here prevents
  // a stale callback from reaching any CPU/GPU/DOM owner, including owners
  // whose first retirement attempt failed. Wrapper identities remain stable.
  for (const [methodName, method] of Object.entries(publicApi)) {
    if (TERMINAL_SAFE_VIEWER_METHODS.has(methodName)) continue;
    const invalidatesFrame =
      !isFrameReaderMethodName(methodName) &&
      !SELF_INVALIDATING_VIEWER_METHODS.has(methodName);
    publicApi[methodName] = function guardedViewerMethod(...args) {
      if (disposed) {
        throw createViewerDisposedError(methodName);
      }
      if (webglContextLost) {
        throw createViewerContextLostError(
          `Viewer method "${methodName}"`
        );
      }
      if (invalidatesFrame) invalidateFrame();
      return Reflect.apply(method, publicApi, args);
    };
  }

  return publicApi;
}
