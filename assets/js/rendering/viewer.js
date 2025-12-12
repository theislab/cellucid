/**
 * WebGL2 Viewer with High-Performance Renderer
 * =============================================
 * Uses HighPerfRenderer for scatter points with WebGL2 only.
 * Keeps smoke, grid, and line rendering.
 */

import { GRID_VS_SOURCE, GRID_FS_SOURCE, LINE_INSTANCED_VS_SOURCE, LINE_INSTANCED_FS_SOURCE } from './shaders/edge-grid-shaders.js';
import { createProgram, createCanvasResizeObserver } from './gl-utils.js';
import { CENTROID_VS, CENTROID_FS } from './shaders/centroid-shaders.js';
import { SmokeRenderer } from './smoke-cloud/smoke-renderer.js';
import { HighPerfRenderer } from './high-perf-renderer.js';
import { HighlightTools } from './highlight-renderer.js';
import { OrbitAnchorRenderer } from './orbit-anchor.js';
import { createProjectileSystem } from './projectiles.js';

export function createViewer({ canvas, labelLayer, viewTitleLayer, sidebar, onViewFocus }) {
  // WebGL2 ONLY - no fallback
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

  // === BUFFERS ===
  // Centroid buffers (small count, separate from main points)
  // Color buffer now stores RGBA as uint8 (alpha packed in)
  const centroidPositionBuffer = gl.createBuffer();
  const centroidColorBuffer = gl.createBuffer(); // RGBA uint8

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
  let edgeTextureV2 = null;
  let positionTextureV2 = null;
  let visibilityTextureV2 = null;
  let visibilityScratchBuffer = null;  // Reusable buffer to avoid allocations
  let edgeTexDimsV2 = [0, 0];
  let posTexDimsV2 = [0, 0];
  let nEdgesV2 = 0;
  let nCellsV2 = 0;
  let useInstancedEdges = false;  // Whether to use v2 instanced rendering
  let edgeLodLimit = 0;  // LOD limit for number of edges to render (0 = all)

  // Centroid snapshot buffers - pre-uploaded GPU buffers for each snapshot view
  // Eliminates per-frame CPU→GPU uploads in multiview mode
  const centroidSnapshotBuffers = new Map(); // viewId -> { vao, buffer, count }

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

  // Small-multiples / snapshot views
  const LIVE_VIEW_ID = 'live';
  const MAX_SNAPSHOTS = 3;
  let snapshotViews = [];
  let nextSnapshotId = 1;
  let viewLayoutMode = 'grid';
  let focusedViewId = LIVE_VIEW_ID;
  let liveViewLabel = 'View 1';
  let liveViewHidden = false; // Whether to hide live view from grid
  let viewFocusHandler = typeof onViewFocus === 'function' ? onViewFocus : null;

  // Camera lock state for independent view navigation
  let camerasLocked = true;           // Default: all views share camera
  let liveCameraState = null;         // Camera state for live view when unlocked

  // Cached view matrices for unlocked camera mode (avoids per-frame recalculation)
  const cachedViewMatrices = new Map();  // viewId -> { viewMatrix: Float32Array, radius: number, dirty: boolean }
  let cachedGridProjection = null;       // { aspect: number, matrix: Float32Array } - shared by all grid cells

  // Per-view dimension tracking for multi-dimensional support
  const viewDimensionLevels = new Map();  // viewId -> dimension level (1, 2, 3, or 4)
  const viewPositionsCache = new Map();   // viewId -> Float32Array positions

  const viewTitleLayerEl = viewTitleLayer || null;
  const sidebarEl = sidebar || null;
  let viewTitleEntries = [];
  let lastTitleKey = null;

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
  const tempVec3d = vec3.create();
  const tempVec3e = vec3.create();
  const tempVec3f = vec3.create();
  const lightDir = vec3.normalize(vec3.create(), [0.5, 0.7, 0.5]);

  let positionsArray = null;
  let colorsArray = null;
  let transparencyArray = null;
  let currentLoadedViewId = null; // Track which view's data is loaded in hpRenderer (for perf optimization)
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
    // Provide view-specific positions for multi-dimensional selection support
    getViewPositions: (viewId) => {
      if (!viewId) return positionsArray;
      return viewPositionsCache.get(String(viewId)) || positionsArray;
    },
    // Provide view-specific transparency for per-view filtering support
    // Each view may have different filters, so selection tools must respect them
    getViewTransparency: (viewId) => {
      if (!viewId || viewId === LIVE_VIEW_ID) return transparencyArray;
      const snapshot = snapshotViews.find(s => s.id === viewId);
      // Use snapshot's own transparency if it doesn't share live transparency
      if (snapshot && !snapshot.sharesLiveTransparency && snapshot.transparency) {
        return snapshot.transparency;
      }
      return transparencyArray;
    },
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

  let basePointSize = 1.0;
  let lightingStrength = 0.6;
  let fogDensity = 0.5;
  let sizeAttenuation = 0.65;
  let outlierThreshold = 1.0;
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

  // Navigation (orbit + free-fly + planar)
  let navigationMode = 'orbit';
  let lookSensitivity = 0.0025; // radians per pixel
  let invertLookX = false;
  let invertLookY = false;
  // Planar mode: zoom to cursor (pinch-style) vs center zoom
  let planarZoomToCursor = true;
  // Planar mode: invert pan axes
  let planarInvertAxes = false;
  let moveSpeed = 1.0; // units per second
  const sprintMultiplier = 2.2;
  const activeKeys = new Set();
  let freeflyPosition = vec3.fromValues(0, 0, 3.0);
  let freeflyVelocity = vec3.create();
  let freeflyYaw = Math.PI / 4;
  let freeflyPitch = 0;
  let pointerLockEnabled = false;
  let pointerLockActive = false;
  let pointerLockChangeHandler = null;
  let pendingShot = false;
  let pendingShotViewportInfo = null;  // Cached viewport info for pointer lock shots
  let lookActive = false;
  let lastFrameTime = performance.now();

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
    getCurrentDimensionLevel: () => viewDimensionLevels.get(LIVE_VIEW_ID) ?? 3,
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

  // === Event Listeners ===
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); return false; });

  canvas.addEventListener('mousedown', (e) => {
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
      if (pointerLockEnabled && !pointerLockActive && canvas.requestPointerLock) {
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
        canvas.requestPointerLock();
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

  window.addEventListener('mouseup', (e) => {
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
          const forward = vec3.sub(vec3.create(), target, eye);
          vec3.normalize(forward, forward);
          const camRight = vec3.cross(vec3.create(), forward, up);
          vec3.normalize(camRight, camRight);
          const camUp = vec3.cross(vec3.create(), camRight, forward);
          vec3.normalize(camUp, camUp);
          const panSpeed = radius * 0.002 * 0.5;
          velocityPanX = -lastDx * panSpeed * camRight[0] + lastDy * panSpeed * camUp[0];
          velocityPanY = -lastDx * panSpeed * camRight[1] + lastDy * panSpeed * camUp[1];
          velocityPanZ = -lastDx * panSpeed * camRight[2] + lastDy * panSpeed * camUp[2];
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
  });

  window.addEventListener('mousemove', (e) => {
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
        const forward = vec3.sub(vec3.create(), target, eye);
        vec3.normalize(forward, forward);
        const camRight = vec3.cross(vec3.create(), forward, up);
        vec3.normalize(camRight, camRight);
        const camUp = vec3.cross(vec3.create(), camRight, forward);
        vec3.normalize(camUp, camUp);
        vec3.scaleAndAdd(target, target, camRight, -dx * panSpeed);
        vec3.scaleAndAdd(target, target, camUp, dy * panSpeed);
      }
    }
    lastX = e.clientX;
    lastY = e.clientY;
  });

  canvas.addEventListener('wheel', (e) => {
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
      const ndcX = (vpInfo.vpLocalX / vpInfo.vpWidth) * 2 - 1;
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

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Alt') {
      highlightTools?.handleAltKeyDown?.();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') {
      highlightTools?.handleAltKeyUp?.();
    }
  });

  // Also update when window loses focus (Alt might be released while window unfocused)
  window.addEventListener('blur', () => {
    highlightTools?.handleWindowBlur?.();
  });

  function handlePointerLockChange() {
    pointerLockActive = document.pointerLockElement === canvas;
    if (pointerLockActive) {
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
      lookActive = false;
      pointerLockEnabled = false;
      pendingShot = false;
      pendingShotViewportInfo = null;  // Clear stored viewport info
      // Cancel charging if pointer lock is released
      projectileSystem.cancelCharging();
      canvas.classList.remove('dragging');
      if (navigationMode === 'free') {
        canvas.style.cursor = 'crosshair';
      } else {
        updateCursorForHighlightMode();
      }
    }
    if (typeof pointerLockChangeHandler === 'function') {
      pointerLockChangeHandler(pointerLockActive);
    }
  }

  document.addEventListener('pointerlockchange', handlePointerLockChange);
  document.addEventListener('pointerlockerror', () => {
    pointerLockActive = false;
    pointerLockEnabled = false;
    if (typeof pointerLockChangeHandler === 'function') {
      pointerLockChangeHandler(false);
    }
  });

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) return;
    const code = e.code;
    if (pointerLockActive && code === 'Escape') {
      if (document.exitPointerLock) document.exitPointerLock();
      pointerLockEnabled = false;
      if (typeof pointerLockChangeHandler === 'function') pointerLockChangeHandler(false);
      return;
    }
    if (navigationMode === 'free') {
      if (code === 'KeyW' || code === 'KeyA' || code === 'KeyS' || code === 'KeyD' ||
          code === 'KeyQ' || code === 'KeyE' ||
          code === 'ShiftLeft' || code === 'ShiftRight') {
        e.preventDefault();
      }
    }
    activeKeys.add(code);
  });

  window.addEventListener('keyup', (e) => {
    activeKeys.delete(e.code);
  });

  // Touch events
  canvas.addEventListener('touchstart', (e) => {
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

  canvas.addEventListener('touchmove', (e) => {
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

  canvas.addEventListener('touchend', (e) => {
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
    const forward = vec3.fromValues(
      Math.cos(freeflyPitch) * Math.cos(freeflyYaw),
      Math.sin(freeflyPitch),
      Math.cos(freeflyPitch) * Math.sin(freeflyYaw)
    );
    vec3.normalize(forward, forward);
    const worldUp = vec3.fromValues(0, 1, 0);
    const right = vec3.cross(vec3.create(), forward, worldUp);
    if (vec3.length(right) < 1e-6) vec3.set(right, 1, 0, 0);
    vec3.normalize(right, right);
    const upVec = vec3.cross(vec3.create(), right, forward);
    vec3.normalize(upVec, upVec);
    return { forward, right, upVec };
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
    if (!camState) {
      return { position: freeflyPosition, axes: getFreeflyAxes() };
    }
    const navMode = camState.navigationMode || 'orbit';
    if (navMode === 'free' && camState.freefly) {
      const pos = camState.freefly.position || [0, 0, 5];
      const yaw = camState.freefly.yaw || 0;
      const pitch = camState.freefly.pitch || 0;
      // Compute axes from yaw/pitch - same as getFreeflyAxes()
      const forward = vec3.fromValues(
        Math.cos(pitch) * Math.cos(yaw),
        Math.sin(pitch),
        Math.cos(pitch) * Math.sin(yaw)
      );
      vec3.normalize(forward, forward);
      const worldUp = vec3.fromValues(0, 1, 0);
      const right = vec3.cross(vec3.create(), forward, worldUp);
      if (vec3.length(right) < 1e-6) vec3.set(right, 1, 0, 0);
      vec3.normalize(right, right);
      const upVec = vec3.cross(vec3.create(), right, forward);
      vec3.normalize(upVec, upVec);
      return { position: pos, axes: { forward, right, upVec } };
    }
    // For orbit mode, return current global state (projectiles only work in freefly)
    return { position: freeflyPosition, axes: getFreeflyAxes() };
  }

  // Get camera position and axes for a specific view (multiview support)
  // Uses cached view matrix for non-focused views (more reliable than camera state)
  function getCameraForView(viewId) {
    const vid = String(viewId);
    const isFocused = vid === String(focusedViewId);
    // For the focused view, use global state (always up-to-date)
    if (isFocused || camerasLocked) {
      return { position: freeflyPosition, axes: getFreeflyAxes() };
    }
    // For non-focused views, try cached view matrix first (most reliable)
    const cached = cachedViewMatrices.get(vid);
    if (cached && cached.viewMatrix) {
      const fromMatrix = getCameraFromViewMatrix(cached.viewMatrix);
      if (fromMatrix) return fromMatrix;
    }
    // Fall back to camera state
    const camState = getViewCameraState(vid);
    return getCameraFromState(camState);
  }

  function updateFreefly(dt) {
    const { forward, right, upVec } = getFreeflyAxes();
    const move = vec3.create();
    if (activeKeys.has('KeyW')) vec3.add(move, move, forward);
    if (activeKeys.has('KeyS')) vec3.sub(move, move, forward);
    if (activeKeys.has('KeyD')) vec3.add(move, move, right);
    if (activeKeys.has('KeyA')) vec3.sub(move, move, right);
    if (activeKeys.has('KeyE')) vec3.add(move, move, upVec);
    if (activeKeys.has('KeyQ')) vec3.sub(move, move, upVec);

    const hasInput = vec3.length(move) > 0.0001;
    if (hasInput) {
      vec3.normalize(move, move);
      const sprint = (activeKeys.has('ShiftLeft') || activeKeys.has('ShiftRight')) ? sprintMultiplier : 1;
      const targetVel = vec3.create();
      vec3.scale(targetVel, move, moveSpeed * sprint);
      const lerpAlpha = Math.min(1, dt * 10);
      vec3.lerp(freeflyVelocity, freeflyVelocity, targetVel, lerpAlpha);
    } else {
      vec3.scale(freeflyVelocity, freeflyVelocity, Math.pow(INERTIA_FRICTION, dt * PHYSICS_TICK_RATE));
      if (vec3.length(freeflyVelocity) < INERTIA_MIN_VELOCITY) {
        vec3.set(freeflyVelocity, 0, 0, 0);
      }
    }

    vec3.scaleAndAdd(freeflyPosition, freeflyPosition, freeflyVelocity, dt);
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

  function updateCamera(width, height) {
    const aspect = width / height;
    mat4.perspective(projectionMatrix, fov, aspect, near, far);
    if (navigationMode === 'free') {
      const { forward, upVec } = getFreeflyAxes();
      vec3.copy(eye, freeflyPosition);
      const lookTarget = vec3.add(vec3.create(), freeflyPosition, forward);
      mat4.lookAt(viewMatrix, eye, lookTarget, upVec);
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
    if (count === 0) return [1, 1];
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const width = Math.min(Math.ceil(Math.sqrt(count)), maxSize);
    const height = Math.ceil(count / width);
    return [width, Math.min(height, maxSize)];
  }

  /**
   * Create edge texture from source and destination arrays
   * @param {Uint16Array|Uint32Array} sources - Source cell indices
   * @param {Uint16Array|Uint32Array} destinations - Destination cell indices
   * @param {number} nEdges - Number of edges
   */
  function createEdgeTextureV2(sources, destinations, nEdges) {
    if (edgeTextureV2) {
      gl.deleteTexture(edgeTextureV2);
    }

    edgeTexDimsV2 = calcTextureDims(nEdges);
    const [width, height] = edgeTexDimsV2;
    const texelCount = width * height;

    // Pack edges into RG32UI texture (2 uint32 per texel)
    const data = new Uint32Array(texelCount * 2);
    for (let i = 0; i < nEdges; i++) {
      data[i * 2] = sources[i];
      data[i * 2 + 1] = destinations[i];
    }

    edgeTextureV2 = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, edgeTextureV2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32UI, width, height, 0, gl.RG_INTEGER, gl.UNSIGNED_INT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    nEdgesV2 = nEdges;
    console.log(`[Viewer] Created edge texture V2: ${nEdges} edges, ${width}x${height} texture`);
  }

  /**
   * Create position texture from positions array
   * @param {Float32Array} positions - Flat array of xyz positions
   * @param {number} nCells - Number of cells
   */
  function createPositionTextureV2(positions, nCells) {
    if (positionTextureV2) {
      gl.deleteTexture(positionTextureV2);
    }

    posTexDimsV2 = calcTextureDims(nCells);
    const [width, height] = posTexDimsV2;
    const texelCount = width * height;

    // Pack positions into RGB32F texture
    const data = new Float32Array(texelCount * 3);
    for (let i = 0; i < nCells; i++) {
      data[i * 3] = positions[i * 3];
      data[i * 3 + 1] = positions[i * 3 + 1];
      data[i * 3 + 2] = positions[i * 3 + 2];
    }

    positionTextureV2 = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, positionTextureV2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, width, height, 0, gl.RGB, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    nCellsV2 = nCells;
    console.log(`[Viewer] Created position texture V2: ${nCells} cells, ${width}x${height} texture`);
  }

  /**
   * Create or update visibility texture
   * @param {Float32Array|Uint8Array} visibility - Visibility values (0-1 per cell)
   */
  function updateVisibilityTextureV2(visibility) {
    const nCells = visibility.length;
    const [width, height] = posTexDimsV2;
    const texelCount = width * height;

    // Reuse scratch buffer if size matches, otherwise reallocate
    if (!visibilityScratchBuffer || visibilityScratchBuffer.length !== texelCount) {
      visibilityScratchBuffer = new Float32Array(texelCount);
    }

    // Copy visibility data and zero-pad remainder
    for (let i = 0; i < texelCount; i++) {
      visibilityScratchBuffer[i] = i < nCells ? visibility[i] : 0;
    }

    if (!visibilityTextureV2) {
      // First time: create texture and upload with texImage2D
      visibilityTextureV2 = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, visibilityTextureV2);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, visibilityScratchBuffer);
    } else {
      // Subsequent updates: use texSubImage2D (faster, no reallocation on GPU)
      gl.bindTexture(gl.TEXTURE_2D, visibilityTextureV2);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.FLOAT, visibilityScratchBuffer);
    }

    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Draw connectivity using instanced rendering (V2)
   */
  function drawConnectivityInstanced(widthPx, heightPx) {
    if (!showConnectivity || nEdgesV2 === 0 || !edgeTextureV2 || !positionTextureV2 || !visibilityTextureV2) {
      return;
    }

    gl.useProgram(lineInstancedProgram);

    // Set uniforms
    gl.uniformMatrix4fv(lineInstancedUniformLocations.mvpMatrix, false, mvpMatrix);
    gl.uniformMatrix4fv(lineInstancedUniformLocations.viewMatrix, false, viewMatrix);
    gl.uniformMatrix4fv(lineInstancedUniformLocations.modelMatrix, false, modelMatrix);
    gl.uniform2f(lineInstancedUniformLocations.viewportSize, widthPx, heightPx);
    gl.uniform1f(lineInstancedUniformLocations.lineWidth, connectivityLineWidth);

    // LOD: limit edges if set
    const maxEdges = edgeLodLimit > 0 ? Math.min(edgeLodLimit, nEdgesV2) : nEdgesV2;
    gl.uniform1i(lineInstancedUniformLocations.maxEdges, maxEdges);

    // Texture dimensions
    gl.uniform2i(lineInstancedUniformLocations.edgeTexDims, edgeTexDimsV2[0], edgeTexDimsV2[1]);
    gl.uniform2i(lineInstancedUniformLocations.posTexDims, posTexDimsV2[0], posTexDimsV2[1]);

    // Bind textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, edgeTextureV2);
    gl.uniform1i(lineInstancedUniformLocations.edgeTexture, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, positionTextureV2);
    gl.uniform1i(lineInstancedUniformLocations.positionTexture, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, visibilityTextureV2);
    gl.uniform1i(lineInstancedUniformLocations.visibilityTexture, 2);

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

    // Draw instanced
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, nEdgesV2);

    // Cleanup
    gl.disableVertexAttribArray(lineInstancedAttribLocations.quadPos);
    gl.activeTexture(gl.TEXTURE0);
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

  function drawConnectivityLines(widthPx, heightPx) {
    drawConnectivityInstanced(widthPx, heightPx);
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

  /**
   * Create or update a centroid snapshot buffer for a view.
   * @param {string} viewId - View identifier
   * @param {Float32Array} positions - Centroid positions
   * @param {Uint8Array} colors - Centroid colors (RGBA)
   * @param {number} [dimensionLevel] - Optional dimension level for tracking changes
   */
  function createCentroidSnapshotBuffer(viewId, positions, colors, dimensionLevel = undefined) {
    if (!positions || !colors) return false;
    const count = positions.length / 3;
    if (count === 0) return false;

    // Normalize viewId to string for consistent Map keys
    const vid = String(viewId);

    // Delete existing if updating
    deleteCentroidSnapshotBuffer(vid);

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
    const glBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, buffer, gl.STATIC_DRAW);

    // Create VAO for fast rendering
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);
    gl.enableVertexAttribArray(centroidAttribLocations.position);
    gl.vertexAttribPointer(centroidAttribLocations.position, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(centroidAttribLocations.color);
    gl.vertexAttribPointer(centroidAttribLocations.color, 4, gl.UNSIGNED_BYTE, true, STRIDE, 12);
    gl.bindVertexArray(null);

    // Store dimension level and position fingerprint to detect when buffer needs recreation
    // Fingerprint is based on count and sampled position values
    const posFingerprint = computeCentroidFingerprint(positions);
    centroidSnapshotBuffers.set(vid, { vao, buffer: glBuffer, count, dimensionLevel, posFingerprint });
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
    return `${len}:${positions[0].toFixed(4)},${positions[mid]?.toFixed(4) || 0},${positions[last]?.toFixed(4) || 0}`;
  }

  function deleteCentroidSnapshotBuffer(viewId) {
    const vid = String(viewId);
    const existing = centroidSnapshotBuffers.get(vid);
    if (existing) {
      gl.deleteVertexArray(existing.vao);
      gl.deleteBuffer(existing.buffer);
      centroidSnapshotBuffers.delete(vid);
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
    const existing = centroidSnapshotBuffers.get(vid);
    if (!existing) return true;  // Doesn't exist, need to create
    // Check if dimension changed since buffer was created
    // Also recreate if old buffer doesn't have dimensionLevel stored (legacy buffer)
    if (existing.dimensionLevel === undefined || existing.dimensionLevel !== currentDimensionLevel) {
      return true;  // Dimension unknown or changed, need to recreate
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
  function screenToRay(screenX, screenY, canvasWidth, canvasHeight, viewportAspect = null, customViewMatrix = null) {
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
      clickedViewId = allViews[viewIndex]?.id || focusedViewId;
    }

    // Get effective view matrix for the viewport
    let effectiveViewMatrix = null;
    if (!camerasLocked && viewCount > 1) {
      const cached = cachedViewMatrices.get(clickedViewId);
      if (cached && cached.viewMatrix) {
        effectiveViewMatrix = cached.viewMatrix;
      } else {
        const camState = getViewCameraState(clickedViewId);
        if (camState) {
          effectiveViewMatrix = mat4.create();
          computeViewMatrixFromState(camState, effectiveViewMatrix);
        }
      }
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
      vpAspect: vpWidth / vpHeight
    };
  }

  function pickCellAtScreen(screenX, screenY) {
    const rect = canvas.getBoundingClientRect();
    const localX = screenX - rect.left;
    const localY = screenY - rect.top;

    // Determine viewport dimensions based on view layout
    let vpLocalX = localX;
    let vpLocalY = localY;
    let vpWidth = rect.width;
    let vpHeight = rect.height;
    let clickedViewId = focusedViewId;

    // Count active views (same logic as render())
    const viewCount = (liveViewHidden ? 0 : 1) + snapshotViews.length;

    // In grid mode with multiple views, find which viewport was clicked
    if (viewLayoutMode === 'grid' && viewCount > 1) {
      const cols = viewCount <= 3 ? viewCount : Math.ceil(Math.sqrt(viewCount));
      const rows = Math.ceil(viewCount / cols);
      vpWidth = rect.width / cols;
      vpHeight = rect.height / rows;

      // Determine which viewport cell was clicked
      const col = Math.floor(localX / vpWidth);
      const row = Math.floor(localY / vpHeight);

      // Clamp to valid range
      const clampedCol = Math.max(0, Math.min(col, cols - 1));
      const clampedRow = Math.max(0, Math.min(row, rows - 1));

      // Convert to viewport-local coordinates
      vpLocalX = localX - clampedCol * vpWidth;
      vpLocalY = localY - clampedRow * vpHeight;

      // Determine which view was clicked
      const viewIndex = clampedRow * cols + clampedCol;
      const allViews = [];
      if (!liveViewHidden) allViews.push({ id: LIVE_VIEW_ID });
      snapshotViews.forEach(s => allViews.push({ id: s.id }));
      clickedViewId = allViews[viewIndex]?.id || focusedViewId;
    }

    // Get the correct view matrix for the clicked viewport
    // If cameras are unlocked, each view has its own camera
    let effectiveViewMatrix = null;
    if (!camerasLocked && viewCount > 1) {
      // Try to get cached view matrix first (faster)
      const cached = cachedViewMatrices.get(clickedViewId);
      if (cached && cached.viewMatrix) {
        effectiveViewMatrix = cached.viewMatrix;
      } else {
        // Compute view matrix from camera state
        const camState = getViewCameraState(clickedViewId);
        if (camState) {
          effectiveViewMatrix = mat4.create();
          computeViewMatrixFromState(camState, effectiveViewMatrix);
        }
      }
      // If we still don't have a view matrix, force update camera and use current
      if (!effectiveViewMatrix) {
        const [w, h] = canvasResizeObserver.getSize();
        updateCamera(w, h);
        // viewMatrix is now up to date, screenToRay will use it as fallback
      }
    }

    // Compute viewport aspect ratio for correct projection
    const vpAspect = vpWidth / vpHeight;
    const ray = screenToRay(vpLocalX, vpLocalY, vpWidth, vpHeight, vpAspect, effectiveViewMatrix);
    if (!ray) return -1;

    // Get view-specific positions for multi-dimensional support
    // Different views may have different position data (e.g., 2D vs 3D embeddings)
    const globalPositions = hpRenderer.getPositions();
    if (!globalPositions) return -1;
    const viewSpecificPositions = viewPositionsCache.get(String(clickedViewId));
    const positions = viewSpecificPositions || globalPositions;

    // Get the dimension level for this view and use spatial index if available
    // Don't force creation - use brute force fallback if no spatial index exists
    const viewDimLevel = viewDimensionLevels.get(String(clickedViewId)) ?? viewDimensionLevels.get(LIVE_VIEW_ID) ?? 3;
    const spatialIndex = hpRenderer.getSpatialIndex(viewDimLevel);

    // Get view-specific transparency array for filtering check
    // Each view may have different filters, so we need the clicked view's transparency
    let viewTransparencyArray = transparencyArray; // Default to live view
    if (clickedViewId !== LIVE_VIEW_ID) {
      const clickedSnapshot = snapshotViews.find(s => s.id === clickedViewId);
      // Use snapshot's own transparency only if it doesn't share live transparency
      if (clickedSnapshot && !clickedSnapshot.sharesLiveTransparency && clickedSnapshot.transparency) {
        viewTransparencyArray = clickedSnapshot.transparency;
      }
    }

    // Sample along the ray to find the nearest cell
    // Limit iterations to prevent lag (max 500 samples)
    const maxDistance = Math.min(radius * 4, 10); // Cap max distance
    const sampleStep = Math.max(0.02, maxDistance / 500); // Adaptive step size
    const searchRadius = 0.03; // Search radius around each sample point

    let nearestCell = -1;
    let nearestDist = Infinity;

    for (let t = 0; t < maxDistance; t += sampleStep) {
      const samplePoint = [
        ray.origin[0] + ray.direction[0] * t,
        ray.origin[1] + ray.direction[1] * t,
        ray.origin[2] + ray.direction[2] * t
      ];

      // Query cells near this point - increase limit for better coverage
      let candidates;
      if (spatialIndex) {
        candidates = spatialIndex.queryRadius(samplePoint, searchRadius, 32);
      } else {
        // Fallback: brute force search (slow)
        candidates = [];
        const r2 = searchRadius * searchRadius;
        const n = positions.length / 3;
        for (let i = 0; i < n && candidates.length < 32; i++) {
          const dx = positions[i * 3] - samplePoint[0];
          const dy = positions[i * 3 + 1] - samplePoint[1];
          const dz = positions[i * 3 + 2] - samplePoint[2];
          if (dx * dx + dy * dy + dz * dz <= r2) {
            candidates.push(i);
          }
        }
      }

      // Find the cell closest to the ray (perpendicular distance)
      for (const idx of candidates) {
        // Cell is pickable only if visible (not filtered out in this view)
        // Filtered-out cells cannot be interacted with, even if highlighted in another view
        // Use view-specific transparency so each view's filters are respected
        const isVisible = !viewTransparencyArray || viewTransparencyArray[idx] > 0;
        if (!isVisible) continue;

        const px = positions[idx * 3];
        const py = positions[idx * 3 + 1];
        const pz = positions[idx * 3 + 2];

        // Vector from ray origin to point
        const opx = px - ray.origin[0];
        const opy = py - ray.origin[1];
        const opz = pz - ray.origin[2];

        // Project onto ray direction to get closest point on ray
        const tProj = opx * ray.direction[0] + opy * ray.direction[1] + opz * ray.direction[2];

        // Skip if point is behind camera
        if (tProj < 0) continue;

        // Perpendicular distance from point to ray (cross product magnitude)
        const crossX = opy * ray.direction[2] - opz * ray.direction[1];
        const crossY = opz * ray.direction[0] - opx * ray.direction[2];
        const crossZ = opx * ray.direction[1] - opy * ray.direction[0];
        const perpDist = Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ);

        if (perpDist < nearestDist) {
          nearestDist = perpDist;
          nearestCell = idx;
        }
      }

      // If we found something, stop early
      if (nearestCell >= 0) break;
    }

    return nearestCell;
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
      // Helper to get view-specific transparency for selection operations
      // Each view may have different filters, so use this to respect per-view filtering
      getViewTransparency: (viewId) => {
        if (!viewId || viewId === LIVE_VIEW_ID) {
          return transparencyArray;
        }
        const snapshot = snapshotViews.find(s => s.id === viewId);
        // Use snapshot's own transparency only if it doesn't share live transparency
        if (snapshot && !snapshot.sharesLiveTransparency && snapshot.transparency) {
          return snapshot.transparency;
        }
        return transparencyArray;
      }
    };
  }

  function getViewFlags(viewId) {
    const key = String(viewId || LIVE_VIEW_ID);
    const flags = viewCentroidFlags.get(key);
    return {
      points: flags?.points ?? defaultShowCentroidPoints,
      labels: flags?.labels ?? defaultShowCentroidLabels
    };
  }

  function setViewFlags(viewId, partial) {
    const key = String(viewId || LIVE_VIEW_ID);
    const prev = viewCentroidFlags.get(key) || {};
    viewCentroidFlags.set(key, {
      points: partial.points != null ? partial.points : (prev.points ?? defaultShowCentroidPoints),
      labels: partial.labels != null ? partial.labels : (prev.labels ?? defaultShowCentroidLabels)
    });
  }

  function getLabelsForView(viewId) {
    return viewCentroidLabels.get(String(viewId || LIVE_VIEW_ID)) || [];
  }

  function removeLabelsForView(viewId) {
    const key = String(viewId || LIVE_VIEW_ID);
    const labels = viewCentroidLabels.get(key) || [];
    labels.forEach((item) => { if (item?.el?.parentElement) item.el.parentElement.removeChild(item.el); });
    viewCentroidLabels.delete(key);
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
    animationHandle = requestAnimationFrame(render);
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - lastFrameTime) / 1000));
    lastFrameTime = now;

    if (navigationMode === 'free') {
      updateFreefly(dt);
    } else {
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
      gl.viewport(0, 0, width, height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      return;
    }

    updateCamera(width, height);
    computeFogAnchors();
    mat4.multiply(mvpMatrix, projectionMatrix, viewMatrix);
    mat4.multiply(mvpMatrix, mvpMatrix, modelMatrix);

    if (renderMode === 'smoke') {
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
      smokeRenderer.render({
        invViewProjMatrix,
        eye,
        lightDir,
        bgColor,
        width,
        height
      });
      return;
    }

    // Determine views to render (include centroid data for each view)
    const allViews = [];

    // Add live view only if not hidden
    if (!liveViewHidden) {
      allViews.push({
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
      allViews.push({
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
    if (viewLayoutMode === 'single' || allViews.length <= 1) {
      gl.viewport(0, 0, width, height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      // If we have exactly one view (e.g., live hidden with 1 snapshot), load its data
      if (allViews.length === 1) {
        const view = allViews[0];

        // Check if this snapshot has a pre-uploaded GPU buffer
        // Same logic as grid mode to avoid inconsistent render paths
        let hasSnapshotBuffer = view.id !== LIVE_VIEW_ID && hpRenderer.hasSnapshotBuffer(view.id);

        // For snapshots without GPU buffers, lazily create one (uploaded once, not per-frame)
        if (view.id !== LIVE_VIEW_ID && !hasSnapshotBuffer && view.colors && view.transparency) {
          const viewPositions = viewPositionsCache.get(String(view.id)) || positionsArray;
          hpRenderer.createSnapshotBuffer(view.id, view.colors, view.transparency, viewPositions);
          hasSnapshotBuffer = true;
        }

        // Only update main buffer when NO snapshot buffer exists (fallback path)
        // When snapshot buffer exists, use it directly - main buffer updates are ignored
        // Live view updates are handled by state.js via viewer.updateColors/updateTransparency
        if (!hasSnapshotBuffer && view.id !== LIVE_VIEW_ID && view.id !== currentLoadedViewId) {
          if (view.colors) hpRenderer.updateColors(view.colors);
          if (view.transparency) hpRenderer.updateAlphas(view.transparency);
          currentLoadedViewId = view.id;
        } else if (view.id === LIVE_VIEW_ID && currentLoadedViewId !== null) {
          // Reset tracking when switching back to live view
          currentLoadedViewId = null;
        }

        // Pass snapshot buffer ID if available (uses immutable snapshot, consistent with grid mode)
        const snapshotId = hasSnapshotBuffer ? view.id : null;
        renderSingleView(width, height, { x: 0, y: 0, w: 1, h: 1 }, view.id, view.centroidCount, snapshotId);
      } else {
        // Multi-view mode: reset tracking since we use snapshot buffers
        if (currentLoadedViewId !== null) {
          currentLoadedViewId = null;
        }
        renderSingleView(width, height, { x: 0, y: 0, w: 1, h: 1 });
      }
      hideViewTitles(); // No titles in single/fullscreen mode
      return;
    }

    // Grid mode: render multiple viewports
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const viewCount = allViews.length;
    // Layout: 1=1x1, 2=2x1, 3=3x1, 4=2x2, 5+=grid
    const cols = viewCount <= 3 ? viewCount : Math.ceil(Math.sqrt(viewCount));
    const rows = Math.ceil(viewCount / cols);

    // Update view title chips
    updateViewTitles(allViews, cols, rows);
    showViewTitles();

    // Pre-compute viewport dimensions (same for all cells in uniform grid)
    const vw = Math.floor(width / cols);
    const vh = Math.floor(height / rows);
    const vpAspect = vw / vh;

    // OPTIMIZATION: Cache projection matrix for grid cells (all have same aspect ratio)
    if (!cachedGridProjection || cachedGridProjection.aspect !== vpAspect) {
      cachedGridProjection = {
        aspect: vpAspect,
        matrix: mat4.create()
      };
      mat4.perspective(cachedGridProjection.matrix, fov, vpAspect, near, far);
    }

    // Store active view's matrices (computed once in updateCamera before this loop)
    const activeViewMatrix = mat4.clone(viewMatrix);
    const activeRadius = radius;

    // Frustum culling and LOD work per-view: each renderSingleView call receives
    // the correct mvpMatrix and cameraDistance for that view's camera

    for (let i = 0; i < viewCount; i++) {
        const view = allViews[i];
        const col = i % cols;
        const row = Math.floor(i / cols);
        const vx = col * vw;
        const vy = (rows - 1 - row) * vh; // Flip Y for GL

        const isActiveView = view.id === focusedViewId;

        // OPTIMIZATION: Use cached view matrices instead of per-frame recalculation
        // No global state modification, no applyCameraStateTemporarily, no updateCamera
        if (isActiveView) {
          // Active view: always use the freshly computed activeViewMatrix
          mat4.copy(viewMatrix, activeViewMatrix);
          radius = activeRadius;
        } else if (!camerasLocked) {
          const cached = cachedViewMatrices.get(view.id);
          if (cached) {
            // Use pre-computed cached viewMatrix directly
            mat4.copy(viewMatrix, cached.viewMatrix);
            radius = cached.radius;
          } else {
            // No cache exists yet - compute correct matrix immediately from camera state
            // This avoids a one-frame jump where the wrong camera would be used
            const camState = getViewCameraState(view.id);
            if (camState) {
              // Compute and cache the view matrix from camera state
              const tempViewMatrix = mat4.create();
              computeViewMatrixFromState(camState, tempViewMatrix);
              mat4.copy(viewMatrix, tempViewMatrix);
              radius = camState.orbit?.radius ?? activeRadius;
              // Cache for future frames
              updateCachedViewMatrix(view.id, camState);
            } else {
              // Truly no camera state - use active view as last resort
              mat4.copy(viewMatrix, activeViewMatrix);
              radius = activeRadius;
            }
          }
        } else {
          // Locked mode: non-active views use active view's matrix
          mat4.copy(viewMatrix, activeViewMatrix);
          radius = activeRadius;
        }

        // OPTIMIZATION: Use cached projection matrix (same for all grid cells)
        mat4.copy(projectionMatrix, cachedGridProjection.matrix);
        mat4.multiply(mvpMatrix, projectionMatrix, viewMatrix);
        mat4.multiply(mvpMatrix, mvpMatrix, modelMatrix);

        // Set viewport and clear depth for this pane
        gl.viewport(vx, vy, vw, vh);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(vx, vy, vw, vh);
        gl.clear(gl.DEPTH_BUFFER_BIT);

        // Check if this snapshot has a pre-uploaded GPU buffer (avoids per-frame re-upload)
        let hasSnapshotBuffer = view.id !== LIVE_VIEW_ID && hpRenderer.hasSnapshotBuffer(view.id);

        // For snapshots without GPU buffers, lazily create one (uploaded once, not per-frame)
        // Skip live view - state.js handles updates via viewer.updateColors/updateTransparency
        if (view.id !== LIVE_VIEW_ID && !hasSnapshotBuffer && view.colors && view.transparency) {
          // CRITICAL: Pass view-specific positions from cache, not global positions
          const viewPositions = viewPositionsCache.get(String(view.id)) || positionsArray;
          hpRenderer.createSnapshotBuffer(view.id, view.colors, view.transparency, viewPositions);
          hasSnapshotBuffer = true;
        }

        // Create or recreate centroid snapshot buffer if needed (dimension change, position change, or doesn't exist)
        const viewDimLevel = viewDimensionLevels.get(view.id) ?? 3;
        if (view.centroidPositions && view.centroidColors && centroidBufferNeedsUpdate(view.id, viewDimLevel, view.centroidPositions)) {
          createCentroidSnapshotBuffer(view.id, view.centroidPositions, view.centroidColors, viewDimLevel);
        }

        // Render this viewport - use snapshot buffer if available (no data upload!)
        const snapshotId = hasSnapshotBuffer ? view.id : null;
        renderSingleView(vw, vh, { x: col / cols, y: row / rows, w: 1 / cols, h: 1 / rows }, view.id, view.centroidCount, snapshotId);

        gl.disable(gl.SCISSOR_TEST);
      }

    // Restore active view's state after grid render
    mat4.copy(viewMatrix, activeViewMatrix);
    radius = activeRadius;

    // Restore projection matrix for full canvas aspect
    mat4.perspective(projectionMatrix, fov, width / height, near, far);
    mat4.multiply(mvpMatrix, projectionMatrix, viewMatrix);
    mat4.multiply(mvpMatrix, mvpMatrix, modelMatrix);
  }

  function renderSingleView(width, height, viewport, viewId, overrideCentroidCount, snapshotBufferId = null) {
    const vid = viewId || focusedViewId || LIVE_VIEW_ID;
    const numCentroids = overrideCentroidCount !== undefined ? overrideCentroidCount : centroidCount;

    // Draw grid first
    drawGrid();

    // Get camera position for HP renderer
    mat4.invert(tempInvViewMatrix, viewMatrix);
    const cameraPosition = [tempInvViewMatrix[12], tempInvViewMatrix[13], tempInvViewMatrix[14]];

    // Check if this snapshot shares live transparency (uses alpha texture for efficient updates)
    const snapshot = snapshotViews.find(s => s.id === vid);
    const useAlphaTexture = snapshot?.sharesLiveTransparency ?? false;

    // Render params shared by both render paths
    // Get dimension level for this view (used for LOD and frustum culling calculations)
    const dimLevel = viewDimensionLevels.get(vid) ?? 3;
    const renderParams = {
      mvpMatrix,
      viewMatrix,
      modelMatrix,
      projectionMatrix,
      pointSize: basePointSize,
      sizeAttenuation,
      viewportHeight: height,
      viewportWidth: width,
      fov,
      lightingStrength,
      fogDensity,
      fogColor,
      lightDir,
      cameraPosition,
      cameraDistance: radius,
      viewId: vid,  // Per-view identifier for LOD and frustum culling state
      dimensionLevel: dimLevel,  // Current dimension level for correct 2D/3D LOD calculation
      useAlphaTexture  // For sharesLiveTransparency snapshots, sample alpha from live texture
    };

    // Render scatter points - use snapshot buffer if available (no data upload!)
    if (snapshotBufferId) {
      hpRenderer.renderWithSnapshot(snapshotBufferId, renderParams);
    } else {
      hpRenderer.render(renderParams);
    }

    // Draw highlights (selection rings) on top of scatter points
    // Use view-specific positions and transparency for multi-view support
    const viewPos = viewPositionsCache.get(vid) || positionsArray;
    // Get view-specific transparency: snapshots may have their own filters
    // Use snapshot's transparency if it exists and doesn't share live, otherwise use live
    const viewTransp = (snapshot && !snapshot.sharesLiveTransparency && snapshot.transparency)
      ? snapshot.transparency
      : transparencyArray;
    highlightTools?.renderHighlights?.(renderParams, viewPos, viewTransp);

    // Draw connectivity lines
    drawConnectivityLines(width, height);

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
    projectileSystem.draw({
      viewportHeight: height,
      mvpMatrix,
      viewMatrix,
      modelMatrix,
      basePointSize,
      sizeAttenuation,
      fov,
    });

    // Draw orbit anchor compass visualization (only in orbit navigation mode)
    // Get camera state for this view (supports per-view cameras in unlocked mode)
    let viewTheta = theta;
    let viewPhi = phi;
    let viewTarget = target;
    let viewRadius = radius;
    if (!camerasLocked && vid !== focusedViewId) {
      const camState = getViewCameraState(vid);
      if (camState && camState.orbit) {
        viewTheta = camState.orbit.theta ?? theta;
        viewPhi = camState.orbit.phi ?? phi;
        viewTarget = camState.orbit.target ?? target;
        viewRadius = camState.orbit.radius ?? radius;
      }
    }
      orbitAnchorRenderer.draw({
        viewId: vid,
        viewTheta,
        viewPhi,
        viewTarget,
        viewRadius,
        pointBoundsRadius: projectileSystem.getPointBoundsRadius(),
      bgColor,
      use3D: currentShaderQuality === 'full',
      mvpMatrix,
      viewMatrix,
      modelMatrix,
      fogDensity,
      fogColor,
      lightingStrength,
      lightDir,
      navigationMode
    });

    // Update labels
    if (flags.labels) {
      const labels = getLabelsForView(vid);
      if (labels.length) updateCentroidLabelPositions(labels, viewport);
    } else {
      hideLabelsForView(vid);
    }
    updateLabelLayerVisibility();
  }

  function setBackground(mode) {
    showGrid = false;
    switch (mode) {
      case 'grid':
        showGrid = true;
        // Light grid with subtle gray tint - reduces eye strain and improves
        // line contrast on LCD/OLED screens. Mirrors dark grid design principles.
        targetGridOpacity = 0.85;
        // Subtle warm gray tint instead of pure white
        gl.clearColor(0.965, 0.965, 0.970, 1);
        document.body.style.backgroundColor = '#f6f6f7';
        bgColor = [0.965, 0.965, 0.970];
        fogColor = [0.965, 0.965, 0.970];
        // Lighter grid lines - subtle but visible on light background
        gridColor = [0.60, 0.60, 0.60];
        gridBgColor = [0.965, 0.965, 0.970];  // Must match bgColor exactly
        gridSpacing = 0.2;
        gridLineWidth = 0.010;                // Slightly thicker for screen legibility
        // Lighter axis colors
        axisXColor = [0.45, 0.45, 0.45];
        axisYColor = [0.45, 0.45, 0.45];
        axisZColor = [0.45, 0.45, 0.45];
        gridFogDensityMultiplier = 1.0;
        break;
      case 'grid-dark':
        showGrid = true;
        targetGridOpacity = 0.75;
        gl.clearColor(0.08, 0.09, 0.1, 1);
        document.body.style.backgroundColor = '#14161a';
        bgColor = [0.08, 0.09, 0.1];
        fogColor = [0.08, 0.09, 0.1];
        gridColor = [0.38, 0.38, 0.42];   // Subtle gray lines
        gridBgColor = [0.08, 0.09, 0.1];
        gridSpacing = 0.2;
        gridLineWidth = 0.008;
        // Grayscale axis colors for scientific look
        axisXColor = [0.5, 0.5, 0.5];
        axisYColor = [0.5, 0.5, 0.5];
        axisZColor = [0.5, 0.5, 0.5];
        gridFogDensityMultiplier = 1.0;
        break;
      case 'black':
        gl.clearColor(0, 0, 0, 1);
        document.body.style.backgroundColor = '#000000';
        bgColor = [0, 0, 0];
        fogColor = [0.05, 0.05, 0.08];
        // Match grid bg to main bg for clean fade-out
        gridBgColor = [0, 0, 0];
        gridColor = [0.3, 0.3, 0.3];
        gridFogDensityMultiplier = 1.0;
        break;
      case 'white':
      default:
        gl.clearColor(1, 1, 1, 1);
        document.body.style.backgroundColor = '#ffffff';
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
    if (viewId === LIVE_VIEW_ID) {
      return liveCameraState || getCurrentCameraStateInternal();
    }
    const snap = snapshotViews.find(s => s.id === viewId);
    return snap?.cameraState || getCurrentCameraStateInternal();
  }

  function setViewCameraState(viewId, camState) {
    if (viewId === LIVE_VIEW_ID) {
      liveCameraState = camState;
    } else {
      const snap = snapshotViews.find(s => s.id === viewId);
      if (snap) snap.cameraState = camState;
    }
    // Update cached view matrix for this view (avoids per-frame recalculation)
    if (!camerasLocked) {
      updateCachedViewMatrix(viewId, camState);
    }
  }

  // === Per-view navigation mode helpers ===
  function getViewNavigationMode(viewId) {
    const camState = getViewCameraState(viewId);
    return camState?.navigationMode || navigationMode;
  }

  // Sync freefly data from orbit data within a camera state (for non-focused views)
  function syncFreeflyInCameraState(camState) {
    if (!camState || !camState.orbit) return;
    const orb = camState.orbit;
    const r = orb.radius ?? 5;
    const t = orb.theta ?? 0;
    const p = orb.phi ?? Math.PI / 2;
    const tgt = orb.target || [0, 0, 0];
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
    camState.freefly = {
      position: eyePos,
      yaw: syncedYaw,
      pitch: syncedPitch
    };
  }

  function setViewNavigationMode(viewId, mode) {
    // For the focused view, get fresh camera state that includes current global position
    const isFocused = viewId === focusedViewId;

    // Handle live view specially - ensure liveCameraState exists
    if (viewId === LIVE_VIEW_ID) {
      if (!liveCameraState || isFocused) {
        // Always refresh camera state for focused view to capture current position
        liveCameraState = getCurrentCameraStateInternal();
      }
      // When switching to free-fly, ensure freefly data is synced from orbit
      if (mode === 'free' && !isFocused) {
        syncFreeflyInCameraState(liveCameraState);
      }
      liveCameraState.navigationMode = mode;
      if (!camerasLocked) {
        updateCachedViewMatrix(viewId, liveCameraState);
      }
    } else {
      // Handle snapshot views
      const snap = snapshotViews.find(s => s.id === viewId);
      if (snap) {
        if (!snap.cameraState || isFocused) {
          // Always refresh camera state for focused view to capture current position
          snap.cameraState = getCurrentCameraStateInternal();
        }
        // When switching to free-fly, ensure freefly data is synced from orbit
        if (mode === 'free' && !isFocused) {
          syncFreeflyInCameraState(snap.cameraState);
        }
        snap.cameraState.navigationMode = mode;
        if (!camerasLocked) {
          updateCachedViewMatrix(viewId, snap.cameraState);
        }
      }
    }
    // If this is the focused view, also update the global navigation mode
    if (isFocused) {
      applyNavigationModeDirectly(mode);
    }
  }

  // Apply navigation mode directly without triggering UI sync (internal use)
  // Used when switching views - applies stored freefly params, doesn't sync from orbit
  function applyNavigationModeDirectly(mode) {
    const prev = navigationMode;
    if (mode === prev) return;
    navigationMode = mode;
    canvas.classList.remove('free-nav', 'planar-nav');

    // Reset velocities and active keys when changing modes
    velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
    vec3.set(freeflyVelocity, 0, 0, 0);
    activeKeys.clear();

    if (mode === 'free') {
      canvas.classList.add('free-nav');
      canvas.style.cursor = pointerLockActive ? 'none' : 'crosshair';
    } else if (mode === 'planar') {
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

  function getCurrentCameraStateInternal() {
    // Sync the inactive mode from the active mode before saving
    // This ensures both orbit and freefly params are current/equivalent
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
    } else {
      // In orbit mode, sync freefly from orbit so freefly params are up-to-date
      const forward = vec3.sub(vec3.create(), target, eye);
      vec3.normalize(forward, forward);
      const syncedYaw = Math.atan2(forward[2], forward[0]);
      const syncedPitch = Math.asin(Math.min(1, Math.max(-1, forward[1])));
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
          position: [eye[0], eye[1], eye[2]],
          yaw: syncedYaw,
          pitch: syncedPitch
        }
      };
    }
  }

  function applyCameraStateTemporarily(camState, { applyNavMode = true } = {}) {
    if (!camState) return;
    // Apply navigation mode if requested (when switching views with unlocked cameras)
    if (applyNavMode && camState.navigationMode) {
      applyNavigationModeDirectly(camState.navigationMode);
    }
    if (camState.orbit) {
      radius = camState.orbit.radius ?? radius;
      targetRadius = camState.orbit.targetRadius ?? targetRadius;
      theta = camState.orbit.theta ?? theta;
      phi = camState.orbit.phi ?? phi;
      if (camState.orbit.target) {
        vec3.set(target, camState.orbit.target[0], camState.orbit.target[1], camState.orbit.target[2]);
      }
    }
    if (camState.freefly) {
      if (camState.freefly.position) {
        vec3.set(freeflyPosition, camState.freefly.position[0], camState.freefly.position[1], camState.freefly.position[2]);
      }
      freeflyYaw = camState.freefly.yaw ?? freeflyYaw;
      freeflyPitch = camState.freefly.pitch ?? freeflyPitch;
    }
  }

  // Compute viewMatrix from cameraState WITHOUT modifying global state (for cached rendering)
  function computeViewMatrixFromState(camState, outViewMatrix) {
    if (!camState) return null;
    const navMode = camState.navigationMode || 'orbit';
    if (navMode === 'free' && camState.freefly) {
      const pos = camState.freefly.position || [0, 0, 5];
      const yaw = camState.freefly.yaw || 0;
      const pitch = camState.freefly.pitch || 0;
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
    } else if (navMode === 'planar' && camState.orbit) {
      // Planar mode: camera looks at XY plane from the Z axis
      const r = camState.orbit.radius ?? 5;
      const tgt = camState.orbit.target || [0, 0, 0];
      const eyePos = [tgt[0], tgt[1], tgt[2] + r];
      mat4.lookAt(outViewMatrix, eyePos, tgt, up);
    } else if (camState.orbit) {
      const r = camState.orbit.radius ?? 5;
      const t = camState.orbit.theta ?? 0;
      const p = camState.orbit.phi ?? Math.PI / 2;
      const tgt = camState.orbit.target || [0, 0, 0];
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
    const vid = String(viewId);
    if (!camState) {
      cachedViewMatrices.delete(vid);
      return;
    }
    let cached = cachedViewMatrices.get(vid);
    if (!cached) {
      cached = { viewMatrix: mat4.create(), radius: 0 };
      cachedViewMatrices.set(vid, cached);
    }
    computeViewMatrixFromState(camState, cached.viewMatrix);
    cached.radius = camState.orbit?.radius ?? radius;
  }

  // Invalidate all cached matrices (call when switching lock modes)
  function invalidateAllCachedMatrices() {
    cachedViewMatrices.clear();
    cachedGridProjection = null;
  }

  function getViewIdAtScreenPosition(screenX, screenY) {
    const rect = canvas.getBoundingClientRect();
    const localX = screenX - rect.left;
    const localY = screenY - rect.top;

    const viewCount = (liveViewHidden ? 0 : 1) + snapshotViews.length;
    if (viewLayoutMode !== 'grid' || viewCount <= 1) return focusedViewId;

    const cols = viewCount <= 3 ? viewCount : Math.ceil(Math.sqrt(viewCount));
    const rows = Math.ceil(viewCount / cols);
    const cellW = rect.width / cols;
    const cellH = rect.height / rows;
    const col = Math.floor(localX / cellW);
    const row = Math.floor(localY / cellH);
    const viewIndex = row * cols + col;

    const allViews = [];
    if (!liveViewHidden) allViews.push({ id: LIVE_VIEW_ID });
    snapshotViews.forEach(s => allViews.push({ id: s.id }));

    return allViews[viewIndex]?.id || focusedViewId;
  }

  // === Public API ===
  return {
    setData({ positions, colors, outlierQuantiles, transparency, dimensionLevel = 3 }) {
      pointCount = positions.length / 3;
      positionsArray = positions;
      colorsArray = colors;
      transparencyArray = transparency;
      computePointBoundsFromPositions(positions);

      // Initialize dimension level for live view (default 3D if not specified)
      viewDimensionLevels.set(LIVE_VIEW_ID, dimensionLevel);
      viewPositionsCache.set(LIVE_VIEW_ID, positions);

      // Load data into HP renderer (alpha is packed in colors as RGBA uint8)
      // Pass dimension level so the renderer can build the appropriate spatial index (BinaryTree/Quadtree/Octree)
      hpRenderer.loadData(positions, colors, { dimensionLevel });
    },

    updateColors(colors) {
      colorsArray = colors;
      hpRenderer.updateColors(colors);
      currentLoadedViewId = LIVE_VIEW_ID; // Mark live view as loaded
    },

    updateTransparency(alphaArray) {
      transparencyArray = alphaArray;
      hpRenderer.updateAlphas(alphaArray);
      currentLoadedViewId = LIVE_VIEW_ID; // Mark live view as loaded
      // Rebuild highlight buffer when visibility changes (filter applied/removed)
      highlightTools?.handleTransparencyChange?.(alphaArray);

      // Propagate transparency reference to snapshots that share transparency with live view
      // NOTE: We do NOT rebuild snapshot GPU buffers here - that was ~16x slower than necessary.
      // Instead, renderWithSnapshot() uses useAlphaTexture=true for these snapshots, which
      // samples alpha from the live alpha texture (already uploaded via updateAlphas above).
      // This reduces GPU uploads from N*16 bytes (full buffer) to N bytes (alpha texture only).
      for (const snap of snapshotViews) {
        if (snap.sharesLiveTransparency) {
          // Just update the transparency reference - rendering will use the live alpha texture
          snap.transparency = alphaArray;
        }
      }
    },

    updateOutlierQuantiles(outliers) {
      // HP renderer doesn't use outlier quantiles directly
      // Filtering should be done via transparency array
    },

    /**
     * Update positions for dimension switching (maintains same point count and indices)
     * @param {Float32Array} positions - New 3D positions array (n_points * 3)
     */
    updatePositions(positions) {
      if (!positions || positions.length !== pointCount * 3) {
        console.error('[Viewer] updatePositions: position count mismatch');
        return;
      }
      positionsArray = positions;
      // Also update the view positions cache to keep live view positions consistent
      // This ensures viewPositionsCache.get('live') returns the same positions as positionsArray
      viewPositionsCache.set(LIVE_VIEW_ID, positions);
      computePointBoundsFromPositions(positions);

      // Update HP renderer with new positions (keeps existing colors/transparency)
      // Pass dimension level so the renderer can update for the correct dimension
      const dimLevel = viewDimensionLevels.get(LIVE_VIEW_ID) ?? 3;
      if (hpRenderer && hpRenderer.updatePositions) {
        hpRenderer.updatePositions(positions, dimLevel);
      } else if (hpRenderer && hpRenderer.loadData) {
        // Fallback: full reload if incremental update not available
        hpRenderer.loadData(positions, colorsArray, { dimensionLevel: dimLevel });
      }
      // Note: Spatial index is rebuilt lazily by updatePositions only if LOD/frustum culling is enabled

      currentLoadedViewId = LIVE_VIEW_ID;
    },

    /**
     * Get current positions array
     * @returns {Float32Array|null}
     */
    getPositions() {
      return positionsArray;
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
     * @param {number} level - Dimension level (1, 2, 3, or 4)
     */
    setViewDimension(viewId, level) {
      const vid = String(viewId);
      const oldLevel = viewDimensionLevels.get(vid);
      viewDimensionLevels.set(vid, level);

      // Also update the snapshot object if this is a snapshot view
      const snap = snapshotViews.find(s => s.id === vid);
      if (snap) {
        snap.dimensionLevel = level;
      }

      // Invalidate per-view caches when dimension changes (LOD/frustum calculations differ)
      if (oldLevel !== level && hpRenderer) {
        hpRenderer.clearViewState(vid);
        // If this view has a snapshot buffer with spatial index, it needs rebuild
        const snapshot = hpRenderer.snapshotBuffers?.get(vid);
        if (snapshot?.spatialIndex) {
          snapshot.spatialIndex = null;
        }

        // For live view, also update the renderer's dimension level
        // This switches the renderer to use the appropriate spatial index (BinaryTree/Quadtree/Octree)
        if (vid === LIVE_VIEW_ID && hpRenderer.setDimensionLevel) {
          hpRenderer.setDimensionLevel(level);
        }
      }

      // Invalidate cached view matrix since camera behavior may differ per dimension
      cachedViewMatrices.delete(vid);
    },

    /**
     * Get dimension level for a specific view
     * @param {string} viewId - View identifier
     * @returns {number} Dimension level (defaults to 3)
     */
    getViewDimension(viewId) {
      return viewDimensionLevels.get(String(viewId)) ?? 3;
    },

    /**
     * Set positions for a specific view (for multi-dimensional support in multiview)
     * Updates the snapshot buffer with new positions if the view has one.
     * @param {string} viewId - View identifier
     * @param {Float32Array} positions - 3D positions array
     */
    setViewPositions(viewId, positions) {
      const vid = String(viewId);
      viewPositionsCache.set(vid, positions);

      // If this is the live view, update the main positions
      if (vid === LIVE_VIEW_ID) {
        positionsArray = positions;
        computePointBoundsFromPositions(positions);
        // Pass dimension level so the renderer can build the appropriate spatial index
        const dimLevel = viewDimensionLevels.get(vid) ?? 3;
        if (hpRenderer && hpRenderer.updatePositions) {
          hpRenderer.updatePositions(positions, dimLevel);
        }
      } else {
        // For snapshot views, update the snapshot buffer positions
        if (hpRenderer && hpRenderer.updateSnapshotPositions) {
          hpRenderer.updateSnapshotPositions(vid, positions);
        }
      }
    },

    /**
     * Get positions for a specific view
     * @param {string} viewId - View identifier
     * @returns {Float32Array|null} Positions array or null
     */
    getViewPositions(viewId) {
      const vid = String(viewId);
      if (vid === LIVE_VIEW_ID) {
        return positionsArray;
      }
      return viewPositionsCache.get(vid) || positionsArray;
    },

    /**
     * Get transparency array for a specific view.
     * Used by selection tools to respect per-view filtering in multi-view mode.
     * @param {string} viewId - View identifier
     * @returns {Float32Array|null} Transparency array (0 = hidden, >0 = visible)
     */
    getViewTransparency(viewId) {
      if (!viewId || viewId === LIVE_VIEW_ID) {
        return transparencyArray;
      }
      const snapshot = snapshotViews.find(s => s.id === viewId);
      // Use snapshot's own transparency if it doesn't share live transparency
      if (snapshot && !snapshot.sharesLiveTransparency && snapshot.transparency) {
        return snapshot.transparency;
      }
      return transparencyArray;
    },

    /**
     * Clear view dimension and position cache for a view (on view removal)
     * @param {string} viewId - View identifier
     */
    clearViewDimensionState(viewId) {
      const vid = String(viewId);
      viewDimensionLevels.delete(vid);
      viewPositionsCache.delete(vid);
    },

    updateHighlight(highlightData, highlightedIndices = null) {
      highlightTools?.updateHighlight?.(highlightData, null, highlightedIndices);
    },

    setHighlightStyle(options = {}) {
      highlightTools?.setHighlightStyle?.(options);
    },

    getHighlightedCount() {
      return highlightTools ? highlightTools.getHighlightedCount() : 0;
    },

    // Cell selection/picking API
    pickCellAtScreen(screenX, screenY) {
      return pickCellAtScreen(screenX, screenY);
    },

    setCellSelectionCallback(callback) {
      highlightTools?.setCellSelectionCallback?.(callback);
    },

    setSelectionStepCallback(callback) {
      highlightTools?.setSelectionStepCallback?.(callback);
    },

    setCellSelectionEnabled(enabled) {
      highlightTools?.setCellSelectionEnabled?.(enabled);
    },

    getCellSelectionEnabled() {
      return highlightTools?.getCellSelectionEnabled?.() ?? true;
    },

    setSelectionPreviewCallback(callback) {
      highlightTools?.setSelectionPreviewCallback?.(callback);
    },

    getAnnotationState() {
      return highlightTools?.getAnnotationState?.() || { inProgress: false, stepCount: 0, lastMode: 'intersect' };
    },

    confirmAnnotationSelection() {
      highlightTools?.confirmAnnotationSelection?.();
    },

    cancelAnnotationSelection() {
      highlightTools?.cancelAnnotationSelection?.();
    },

    setHighlightMode(mode) {
      highlightTools?.setHighlightMode?.(mode);
    },

    getHighlightMode() {
      return highlightTools?.getHighlightMode?.() || 'none';
    },

    // Lasso selection API
    setLassoEnabled(enabled) {
      highlightTools?.setLassoEnabled?.(enabled);
    },

    getLassoEnabled() {
      return highlightTools?.getLassoEnabled?.() ?? false;
    },

    setLassoCallback(callback) {
      highlightTools?.setLassoCallback?.(callback);
    },

    setLassoPreviewCallback(callback) {
      highlightTools?.setLassoPreviewCallback?.(callback);
    },

    clearLasso() {
      highlightTools?.clearLasso?.();
    },

    // Multi-step lasso selection API
    setLassoStepCallback(callback) {
      highlightTools?.setLassoStepCallback?.(callback);
    },

    getLassoState() {
      return highlightTools?.getLassoState?.() || { inProgress: false, stepCount: 0, candidateCount: 0 };
    },

    confirmLassoSelection() {
      highlightTools?.confirmLassoSelection?.();
    },

    cancelLassoSelection() {
      highlightTools?.cancelLassoSelection?.();
    },

    // Restore lasso state for undo/redo
    restoreLassoState(candidates, step) {
      highlightTools?.restoreLassoState?.(candidates, step);
    },

    // Proximity drag selection API
    setProximityEnabled(enabled) {
      highlightTools?.setProximityEnabled?.(enabled);
    },

    getProximityEnabled() {
      return highlightTools?.getProximityEnabled?.() ?? false;
    },

    setProximityCallback(callback) {
      highlightTools?.setProximityCallback?.(callback);
    },

    setProximityPreviewCallback(callback) {
      highlightTools?.setProximityPreviewCallback?.(callback);
    },

    setProximityStepCallback(callback) {
      highlightTools?.setProximityStepCallback?.(callback);
    },

    getProximityState() {
      return highlightTools?.getProximityState?.() || { inProgress: false, stepCount: 0, candidateCount: 0 };
    },

    confirmProximitySelection() {
      highlightTools?.confirmProximitySelection?.();
    },

    cancelProximitySelection() {
      highlightTools?.cancelProximitySelection?.();
    },

    // Restore proximity state for undo/redo
    restoreProximityState(candidates, step) {
      highlightTools?.restoreProximityState?.(candidates, step);
    },

    // KNN drag selection API
    setKnnEnabled(enabled) {
      highlightTools?.setKnnEnabled?.(enabled);
    },

    getKnnEnabled() {
      return highlightTools?.getKnnEnabled?.() ?? false;
    },

    setKnnCallback(callback) {
      highlightTools?.setKnnCallback?.(callback);
    },

    setKnnPreviewCallback(callback) {
      highlightTools?.setKnnPreviewCallback?.(callback);
    },

    setKnnStepCallback(callback) {
      highlightTools?.setKnnStepCallback?.(callback);
    },

    setKnnEdgeLoadCallback(callback) {
      highlightTools?.setKnnEdgeLoadCallback?.(callback);
    },

    getKnnState() {
      return highlightTools?.getKnnState?.() || { inProgress: false, stepCount: 0, candidateCount: 0, edgesLoaded: false };
    },

    // Load KNN edges from edge arrays and build adjacency list
    loadKnnEdges(sources, destinations) {
      return highlightTools ? highlightTools.loadKnnEdges(sources, destinations) : false;
    },

    isKnnEdgesLoaded() {
      return highlightTools?.isKnnEdgesLoaded?.() ?? false;
    },

    confirmKnnSelection() {
      highlightTools?.confirmKnnSelection?.();
    },

    cancelKnnSelection() {
      highlightTools?.cancelKnnSelection?.();
    },

    // Restore KNN state for undo/redo
    restoreKnnState(candidates, step) {
      highlightTools?.restoreKnnState?.(candidates, step);
    },

    // Unified selection API (shared state across lasso, proximity, KNN)
    // Allows switching tools mid-selection to refine with different methods
    getUnifiedSelectionState() {
      return highlightTools?.getUnifiedSelectionState?.() || { inProgress: false, stepCount: 0, candidateCount: 0, candidates: [] };
    },

    confirmUnifiedSelection(callback) {
      return highlightTools?.confirmUnifiedSelection?.(callback) || [];
    },

    cancelUnifiedSelection() {
      highlightTools?.cancelUnifiedSelection?.();
    },

    restoreUnifiedState(candidates, step) {
      highlightTools?.restoreUnifiedState?.(candidates, step);
    },

  setCentroids({ positions, colors, outlierQuantiles, transparency }) {
    centroidCount = positions ? positions.length / 3 : 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, centroidPositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions || new Float32Array(), gl.STATIC_DRAW);

    // Pack alpha into RGBA byte colors when transparency is provided
    let packedColors = colors;
    if (transparency && centroidCount > 0) {
      const byteColors = colors && colors.length >= centroidCount * 4
        ? new Uint8Array(colors)
        : new Uint8Array(centroidCount * 4).fill(255);
      const len = Math.min(centroidCount, transparency.length);
      for (let i = 0; i < len; i++) {
        byteColors[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(transparency[i] * 255)));
      }
      packedColors = byteColors;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, centroidColorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, packedColors || new Uint8Array(), gl.STATIC_DRAW); // RGBA uint8
  },

    setCentroidLabels(labels, viewId) {
      const targetId = String(viewId || focusedViewId || LIVE_VIEW_ID);
      removeLabelsForView(targetId);
      const entries = Array.isArray(labels) ? labels : [];
      entries.forEach((item) => {
        if (item?.el) {
          item.el.dataset.viewId = targetId;
          if (item.el.parentElement !== labelLayer) labelLayer.appendChild(item.el);
        }
      });
      viewCentroidLabels.set(targetId, entries);
      updateLabelLayerVisibility();
    },

    setPointSize(size) { basePointSize = size; },
    setSizeAttenuation(value) { sizeAttenuation = value; },
    setLightingStrength(value) { lightingStrength = value; },
    setFogDensity(value) { fogDensity = Math.max(0, value); },
    setOutlierThreshold(value) { outlierThreshold = value; },

    setShowCentroidPoints(show, viewId) {
      setViewFlags(viewId || focusedViewId || LIVE_VIEW_ID, { points: !!show });
    },

    setShowCentroidLabels(show, viewId) {
      const key = viewId || focusedViewId || LIVE_VIEW_ID;
      setViewFlags(key, { labels: !!show });
      if (!show) hideLabelsForView(key);
      updateLabelLayerVisibility();
    },

    getCentroidFlags(viewId) { return getViewFlags(viewId); },
    setBackground,
    setRenderMode(mode) { renderMode = mode === 'smoke' ? 'smoke' : 'points'; },
    setNavigationMode(mode) {
      const next = mode === 'free' ? 'free' : (mode === 'planar' ? 'planar' : 'orbit');
      if (next === navigationMode) return;
      if (next === 'free') {
        // Ensure orbit state is synced before switching
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
        if (pointerLockEnabled && canvas.requestPointerLock) {
          canvas.requestPointerLock();
        }
      } else if (next === 'planar') {
        // Planar mode: fix camera to look at XY plane
        if (navigationMode === 'free') {
          syncOrbitFromFreefly();
        }
        navigationMode = 'planar';
        canvas.classList.remove('free-nav');
        canvas.classList.add('planar-nav');
        lookActive = false;
        pointerLockEnabled = false;
        if (document.pointerLockElement === canvas && document.exitPointerLock) {
          document.exitPointerLock();
        }
        activeKeys.clear();
        vec3.set(freeflyVelocity, 0, 0, 0);
        velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
        updateCursorForHighlightMode();
      } else {
        // Orbit mode
        if (navigationMode === 'free') {
          syncOrbitFromFreefly();
        }
        navigationMode = 'orbit';
        canvas.classList.remove('free-nav');
        canvas.classList.remove('planar-nav');
        lookActive = false;
        pointerLockEnabled = false;
        if (document.pointerLockElement === canvas && document.exitPointerLock) {
          document.exitPointerLock();
        }
        activeKeys.clear();
        vec3.set(freeflyVelocity, 0, 0, 0);
        updateCursorForHighlightMode();
      }
    },
    getNavigationMode() { return navigationMode; },
    setLookSensitivity(value) {
      if (!Number.isFinite(value)) return;
      lookSensitivity = Math.max(0.0005, Math.min(0.02, value));
    },
    setMoveSpeed(value) {
      if (!Number.isFinite(value)) return;
      moveSpeed = Math.max(0.01, Math.min(5, value));
    },
    setInvertLook(value) { invertLookY = !!value; },
    setInvertLookY(value) { invertLookY = !!value; },
    setInvertLookX(value) { invertLookX = !!value; },
    setOrbitInvertRotation(value) { orbitInvertX = !!value; },
    setOrbitInvertX(value) { orbitInvertX = !!value; },
    setPlanarZoomToCursor(value) { planarZoomToCursor = !!value; },
    setPlanarInvertAxes(value) { planarInvertAxes = !!value; },
    setPointerLockEnabled(enabled) {
      const desired = !!enabled && navigationMode === 'free';
      pointerLockEnabled = desired;
      if (pointerLockEnabled) {
        if (canvas.requestPointerLock) {
          canvas.requestPointerLock();
        }
      } else if (document.pointerLockElement === canvas && document.exitPointerLock) {
        document.exitPointerLock();
      } else {
        lookActive = false;
        pointerLockActive = false;
        canvas.classList.remove('dragging');
        if (navigationMode === 'free') {
          canvas.style.cursor = 'crosshair';
        } else {
          updateCursorForHighlightMode();
        }
        if (typeof pointerLockChangeHandler === 'function') {
          pointerLockChangeHandler(false);
        }
      }
    },
    setPointerLockChangeHandler(fn) { pointerLockChangeHandler = typeof fn === 'function' ? fn : null; },
    setProjectilesEnabled(enabled, onReady) {
      projectileSystem.setEnabled(enabled);
      // Get the current dimension level for collision detection
      const dimLevel = viewDimensionLevels.get(LIVE_VIEW_ID) ?? 3;
      if (enabled && hpRenderer && !hpRenderer.hasSpatialIndex(dimLevel)) {
        // Defer spatial index building so UI can update first (show loading message)
        setTimeout(() => {
          hpRenderer.ensureSpatialIndex(dimLevel);
          if (typeof onReady === 'function') onReady();
        }, 10);
      } else if (typeof onReady === 'function') {
        // Already ready
        onReady();
      }
    },
    isProjectileSpatialIndexReady() {
      const dimLevel = viewDimensionLevels.get(LIVE_VIEW_ID) ?? 3;
      return !!(hpRenderer && hpRenderer.hasSpatialIndex(dimLevel));
    },

    // Orbit anchor visibility control
    setShowOrbitAnchor(show) { orbitAnchorRenderer.setShowAnchor(show); },
    getShowOrbitAnchor() { return orbitAnchorRenderer.getShowAnchor(); },

    // Smoke renderer API (delegates to SmokeRenderer)
    setSmokeVolume(volumeDesc) { smokeRenderer.setVolume(volumeDesc); },
    buildSmokeVolumeGPU(positions, options = {}) { return smokeRenderer.buildVolumeGPU(positions, options); },
    setSmokeParams(params) { smokeRenderer.setParams(params); },
    setCloudResolutionScale(scale) { smokeRenderer.setResolutionScale(scale); },
    getCloudResolutionScale() { return smokeRenderer.getResolutionScale(); },
    setNoiseTextureResolution(size) { smokeRenderer.setNoiseTextureResolution(size); },
    getNoiseTextureResolution() { return smokeRenderer.getNoiseTextureResolution(); },
    getAdaptiveScaleFactor() { return smokeRenderer.getAdaptiveScaleFactor(); },
    setSmokeHalfResolution(enabled) { smokeRenderer.setHalfResolution(enabled); },
    setSmokeQualityPreset(preset) { smokeRenderer.setQualityPreset(preset); },

    setShowConnectivity(show) { showConnectivity = !!show; },
    getShowConnectivity() { return showConnectivity; },
    setConnectivityLineWidth(width) { connectivityLineWidth = Math.max(0.1, Math.min(10, width)); },
    getConnectivityLineWidth() { return connectivityLineWidth; },
    setConnectivityAlpha(alpha) { connectivityAlpha = Math.max(0.01, Math.min(1, alpha)); },
    getConnectivityAlpha() { return connectivityAlpha; },
    setConnectivityColor(r, g, b) {
      const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));
      connectivityColorBytes[0] = clampByte(r);
      connectivityColorBytes[1] = clampByte(g);
      connectivityColorBytes[2] = clampByte(b);
    },
    // Returns byte values (0-255)
    getConnectivityColor() { return [connectivityColorBytes[0], connectivityColorBytes[1], connectivityColorBytes[2]]; },
    hasConnectivityData() { return nEdgesV2 > 0; },
    getEdgeCount() { return nEdgesV2; },

    // ========================================================================
    // V2 GPU-INSTANCED EDGE API
    // ========================================================================

    /**
     * Set up V2 instanced edge rendering with edge data
     * @param {Object} edgeData - Object with sources, destinations, nEdges, nCells
     * @param {Float32Array} positions - Cell positions (flat xyz array)
     */
    setupEdgesV2(edgeData, positions) {
      const { sources, destinations, nEdges, nCells } = edgeData;

      if (!sources || !destinations || nEdges === 0) {
        console.warn('[Viewer] Invalid edge data for V2 setup');
        return false;
      }

      // Create textures
      createEdgeTextureV2(sources, destinations, nEdges);
      createPositionTextureV2(positions, nCells);

      // Initialize visibility to all visible
      const visibility = new Float32Array(nCells);
      visibility.fill(1.0);
      updateVisibilityTextureV2(visibility);

      useInstancedEdges = true;
      edgeLodLimit = 0;  // No LOD limit by default

      console.log(`[Viewer] V2 instanced edges enabled: ${nEdges} edges, ${nCells} cells`);
      return true;
    },

    /**
     * Update visibility texture for V2 edges
     * @param {Float32Array|Uint8Array} visibility - Per-cell visibility (0-1)
     */
    updateEdgeVisibilityV2(visibility) {
      if (!useInstancedEdges || !visibilityTextureV2) {
        return false;
      }
      updateVisibilityTextureV2(visibility);
      return true;
    },

    /**
     * Set LOD limit for V2 edges (0 = no limit)
     * @param {number} limit - Maximum edges to render
     */
    setEdgeLodLimit(limit) {
      edgeLodLimit = Math.max(0, Math.floor(limit));
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
     * Disable V2 instanced edges (fall back to legacy)
     */
    disableEdgesV2() {
      useInstancedEdges = false;
    },

    /**
     * Enable V2 instanced edges (if set up)
     */
    enableEdgesV2() {
      if (nEdgesV2 > 0 && edgeTextureV2 && positionTextureV2) {
        useInstancedEdges = true;
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
      lookActive = false;
      pointerLockEnabled = false;
      projectileSystem.reset();
      if (document.pointerLockElement === canvas && document.exitPointerLock) {
        document.exitPointerLock();
      }
    },

    getCameraState() {
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
          position: [freeflyPosition[0], freeflyPosition[1], freeflyPosition[2]],
          yaw: freeflyYaw,
          pitch: freeflyPitch
        }
      };
    },

    setCameraState(camState) {
      if (!camState) return;
      console.log('[Viewer] setCameraState called:', camState.navigationMode, 'orbit:', camState.orbit?.radius?.toFixed(2), 'theta:', camState.orbit?.theta?.toFixed(2));

      // Stop any inertia
      velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
      vec3.set(freeflyVelocity, 0, 0, 0);

      // Set navigation mode directly without triggering sync functions
      if (camState.navigationMode) {
        const next = camState.navigationMode === 'free' ? 'free' : (camState.navigationMode === 'planar' ? 'planar' : 'orbit');
        navigationMode = next;
        canvas.classList.remove('free-nav', 'planar-nav');
        if (next === 'free') {
          canvas.classList.add('free-nav');
        } else if (next === 'planar') {
          canvas.classList.add('planar-nav');
        }
      }

      if (camState.orbit) {
        radius = camState.orbit.radius ?? radius;
        targetRadius = camState.orbit.targetRadius ?? targetRadius;
        theta = camState.orbit.theta ?? theta;
        phi = camState.orbit.phi ?? phi;
        if (camState.orbit.target) {
          vec3.set(target, camState.orbit.target[0], camState.orbit.target[1], camState.orbit.target[2]);
        }
      }
      if (camState.freefly) {
        if (camState.freefly.position) {
          vec3.set(freeflyPosition, camState.freefly.position[0], camState.freefly.position[1], camState.freefly.position[2]);
        }
        freeflyYaw = camState.freefly.yaw ?? freeflyYaw;
        freeflyPitch = camState.freefly.pitch ?? freeflyPitch;
      }
      console.log('[Viewer] Camera state applied. radius:', radius.toFixed(2), 'theta:', theta.toFixed(2), 'phi:', phi.toFixed(2));
    },

    stopInertia() {
      velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
      vec3.set(freeflyVelocity, 0, 0, 0);
    },

    // Camera lock API for independent view navigation
    setCamerasLocked(locked) {
      const wasLocked = camerasLocked;
      camerasLocked = Boolean(locked);

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
          applyCameraStateTemporarily(activeCam);
        }
        // Clear cached matrices (not needed in locked mode)
        invalidateAllCachedMatrices();
      }
    },

    getCamerasLocked() { return camerasLocked; },
    getFocusedViewId() { return focusedViewId; },

    getViewCameraState(viewId) { return getViewCameraState(viewId); },
    setViewCameraState(viewId, camState) { setViewCameraState(viewId, camState); },

    // Per-view navigation mode (only relevant when cameras are unlocked)
    getViewNavigationMode(viewId) { return getViewNavigationMode(viewId); },
    setViewNavigationMode(viewId, mode) { setViewNavigationMode(viewId, mode); },

    setViewFocusHandler(fn) { viewFocusHandler = typeof fn === 'function' ? fn : null; },
    setLiveViewLabel(label) { liveViewLabel = label || 'View 1'; },
    getLiveViewLabel() { return liveViewLabel; },

    // Snapshot API - stores view configs for multiview
    createSnapshotView(config) {
      if (snapshotViews.length >= MAX_SNAPSHOTS) return null;
      const id = `snap_${nextSnapshotId++}`;
      // Inherit camera from live view at snapshot time
      const inheritedCamera = config.cameraState ||
        (camerasLocked ? getCurrentCameraStateInternal() :
          JSON.parse(JSON.stringify(liveCameraState || getCurrentCameraStateInternal())));

      // Get initial dimension level from config or inherit from current live view
      const initialDimLevel = config.dimensionLevel ?? viewDimensionLevels.get(LIVE_VIEW_ID) ?? 3;

      // Track if this snapshot should share transparency with the live view
      // If sharesLiveTransparency is true, filter changes on live view propagate to this snapshot
      const sharesLiveTransparency = config.sharesLiveTransparency ?? false;

      const snapshot = {
        id,
        label: config.label || `View ${snapshotViews.length + 2}`,
        fieldKey: config.fieldKey,
        fieldKind: config.fieldKind,
        colors: config.colors ? new Uint8Array(config.colors) : null, // RGBA uint8
        transparency: config.transparency ? new Float32Array(config.transparency) : null,
        outlierQuantiles: config.outlierQuantiles ? new Float32Array(config.outlierQuantiles) : null,
        centroidPositions: config.centroidPositions ? new Float32Array(config.centroidPositions) : null,
        centroidColors: config.centroidColors ? new Uint8Array(config.centroidColors) : null, // RGBA uint8
        centroidOutliers: config.centroidOutliers ? new Float32Array(config.centroidOutliers) : null,
        outlierThreshold: config.outlierThreshold ?? 1.0,
        meta: config.meta || {},
        cameraState: inheritedCamera,  // Per-view camera state
        dimensionLevel: initialDimLevel,  // Per-view dimension level for multi-dimensional support
        sharesLiveTransparency  // If true, filter changes on live view propagate to this snapshot
      };
      snapshotViews.push(snapshot);

      // Track dimension level for this view
      viewDimensionLevels.set(id, initialDimLevel);

      // Get dimension-specific positions for this snapshot
      // Use the source view's positions (active view when "Keep View" was clicked)
      const sourceViewId = config.sourceViewId || LIVE_VIEW_ID;
      const sourcePositions = viewPositionsCache.get(String(sourceViewId)) || positionsArray;
      // Cache positions for this snapshot view (used by highlight rendering)
      viewPositionsCache.set(id, sourcePositions);

      // Create GPU buffer for this snapshot (uploaded once, not per-frame)
      // Pass dimension-specific positions so the snapshot renders correctly
      if (snapshot.colors && hpRenderer) {
        hpRenderer.createSnapshotBuffer(id, snapshot.colors, snapshot.transparency, sourcePositions);
      }

      // Create centroid GPU buffer for this snapshot (uploaded once)
      // Pass dimension level so buffer can be recreated if dimension changes
      if (snapshot.centroidPositions && snapshot.centroidColors) {
        const dimLevel = viewDimensionLevels.get(id) ?? 3;
        createCentroidSnapshotBuffer(id, snapshot.centroidPositions, snapshot.centroidColors, dimLevel);
      }

      // Pre-compute cached view matrix for this snapshot (if cameras unlocked)
      if (!camerasLocked) {
        updateCachedViewMatrix(id, inheritedCamera);
      }

      return { id, label: snapshot.label };
    },

    updateSnapshotAttributes(id, attrs) {
      const snap = snapshotViews.find(s => s.id === id);
      if (!snap) return false;
      const colorsChanged = !!attrs.colors;
      const transparencyChanged = !!attrs.transparency;
      if (attrs.colors) snap.colors = new Uint8Array(attrs.colors); // RGBA uint8
      if (attrs.transparency) snap.transparency = new Float32Array(attrs.transparency);
      if (attrs.outlierQuantiles) snap.outlierQuantiles = new Float32Array(attrs.outlierQuantiles);
      if (attrs.centroidPositions) snap.centroidPositions = new Float32Array(attrs.centroidPositions);
      if (attrs.centroidColors) snap.centroidColors = new Uint8Array(attrs.centroidColors); // RGBA uint8
      if (attrs.centroidOutliers) snap.centroidOutliers = new Float32Array(attrs.centroidOutliers);
      if (typeof attrs.outlierThreshold === 'number') snap.outlierThreshold = attrs.outlierThreshold;
      if (attrs.label) snap.label = attrs.label;
      if (attrs.meta) snap.meta = { ...snap.meta, ...attrs.meta };

      // Update snapshot's GPU buffer if colors or transparency changed
      if ((colorsChanged || transparencyChanged) && snap.colors && hpRenderer) {
        hpRenderer.updateSnapshotBuffer(id, snap.colors, snap.transparency);
      }

      // Re-upload centroid GPU buffer if changed
      // Pass dimension level so buffer can be recreated if dimension changes
      if ((attrs.centroidPositions || attrs.centroidColors) && snap.centroidPositions && snap.centroidColors) {
        const dimLevel = viewDimensionLevels.get(id) ?? 3;
        createCentroidSnapshotBuffer(id, snap.centroidPositions, snap.centroidColors, dimLevel);
      }

      // If this is the focused view in single mode, update HP renderer's main buffer too
      if (viewLayoutMode === 'single' && focusedViewId === id) {
        if (snap.colors) hpRenderer.updateColors(snap.colors);
        if (snap.transparency) hpRenderer.updateAlphas(snap.transparency);
      }
      return true;
    },

    removeSnapshotView(id) {
      const idx = snapshotViews.findIndex(s => s.id === id);
      if (idx >= 0) {
        // Delete GPU buffer for this snapshot
        if (hpRenderer) {
          hpRenderer.deleteSnapshotBuffer(id);
          hpRenderer.clearViewState(id);  // Clear per-view LOD/frustum culling state
        }
        // Delete centroid GPU buffer for this snapshot
        deleteCentroidSnapshotBuffer(id);
        // Clean up orbit anchor state for this view
        orbitAnchorRenderer.deleteViewState(id);
        // Clean up cached view matrix
        cachedViewMatrices.delete(id);
        // Clean up per-view dimension state
        viewDimensionLevels.delete(id);
        viewPositionsCache.delete(id);
        snapshotViews.splice(idx, 1);
        const key = String(id);
        if (key !== LIVE_VIEW_ID) {
          removeLabelsForView(key);
          viewCentroidFlags.delete(key);
        }
        if (focusedViewId === id) focusedViewId = LIVE_VIEW_ID;
        // If no snapshots left and live was hidden, restore it
        if (snapshotViews.length === 0 && liveViewHidden) {
          liveViewHidden = false;
        }
        updateLabelLayerVisibility();
      }
    },

    clearSnapshotViews() {
      // Delete all snapshot GPU buffers and per-view state (not live view)
      if (hpRenderer) {
        hpRenderer.deleteAllSnapshotBuffers();
        // Clear per-view state for each snapshot individually (preserve live view state)
        for (const snap of snapshotViews) {
          hpRenderer.clearViewState(snap.id);
          // Clean up orbit anchor state for this view
          orbitAnchorRenderer.deleteViewState(snap.id);
        }
      }
      // Delete all centroid snapshot GPU buffers (preserve live view)
      for (const id of centroidSnapshotBuffers.keys()) {
        if (String(id) !== LIVE_VIEW_ID) {
          deleteCentroidSnapshotBuffer(id);
        }
      }
      // Clean up cached view matrices and dimension state for snapshots (preserve live view)
      for (const snap of snapshotViews) {
        cachedViewMatrices.delete(snap.id);
        viewDimensionLevels.delete(snap.id);
        viewPositionsCache.delete(snap.id);
      }
      snapshotViews.length = 0;
      focusedViewId = LIVE_VIEW_ID;
      liveViewHidden = false; // Restore live view visibility
      for (const key of Array.from(viewCentroidLabels.keys())) {
        if (String(key) !== LIVE_VIEW_ID) {
          removeLabelsForView(key);
        }
      }
      for (const key of Array.from(viewCentroidFlags.keys())) {
        if (String(key) !== LIVE_VIEW_ID) {
          viewCentroidFlags.delete(key);
        }
      }
      updateLabelLayerVisibility();
      // Restore live view data
      if (colorsArray) hpRenderer.updateColors(colorsArray);
      if (transparencyArray) hpRenderer.updateAlphas(transparencyArray);
    },

    getSnapshotViews() {
      return snapshotViews.map(s => ({
        id: s.id,
        label: s.label,
        fieldKey: s.fieldKey,
        fieldKind: s.fieldKind,
        meta: s.meta
      }));
    },

    hasSnapshots() { return snapshotViews.length > 0; },

    setViewLayout(mode, activeId) {
      viewLayoutMode = mode === 'single' ? 'single' : 'grid';
      if (activeId && activeId !== focusedViewId) {
        // Save current camera to previous view before switching (if unlocked)
        if (!camerasLocked) {
          setViewCameraState(focusedViewId, getCurrentCameraStateInternal());
        }
        focusedViewId = activeId;
        // Update active state on title chips
        updateViewTitleActiveState();
        // Load new view's camera (if unlocked)
        if (!camerasLocked) {
          const newCam = getViewCameraState(focusedViewId);
          if (newCam) applyCameraStateTemporarily(newCam);
        }
        // In single mode, load the focused view's data into HP renderer
        if (viewLayoutMode === 'single') {
          if (activeId === LIVE_VIEW_ID) {
            if (colorsArray) hpRenderer.updateColors(colorsArray);
            if (transparencyArray) hpRenderer.updateAlphas(transparencyArray);
          } else {
            const snap = snapshotViews.find(s => s.id === activeId);
            if (snap) {
              if (snap.colors) hpRenderer.updateColors(snap.colors);
              if (snap.transparency) hpRenderer.updateAlphas(snap.transparency);
            }
          }
        }
      }
      if (viewLayoutMode === 'single') {
        for (const key of viewCentroidLabels.keys()) {
          if (String(key) !== String(focusedViewId || LIVE_VIEW_ID)) {
            hideLabelsForView(key);
          }
        }
      }
      updateLabelLayerVisibility();
    },

    getViewLayout() { return { mode: viewLayoutMode, activeId: focusedViewId, liveViewHidden }; },

    setLiveViewHidden(hidden) {
      liveViewHidden = Boolean(hidden);
    },

    getLiveViewHidden() {
      return liveViewHidden;
    },

    getGLContext() { return gl; },
    isWebGL2() { return true; },

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
        lightingStrength,
        fogDensity,
        fogColor: new Float32Array(fogColor),
        bgColor: new Float32Array(bgColor),
        lightDir: new Float32Array(lightDir),
        cameraPosition: [invView[12], invView[13], invView[14]],
        cameraDistance
      };
    },

    // HP renderer is always used now, these are no-ops
    setExternalRenderer(renderer) {},
    clearExternalRenderer() {},

    // HP renderer controls
    setShaderQuality(quality) {
      currentShaderQuality = quality || 'full';
      highlightTools?.setQuality?.(currentShaderQuality);
      hpRenderer.setQuality(currentShaderQuality);
    },
    setFrustumCulling(enabled) { hpRenderer.setFrustumCulling(enabled); },
    setAdaptiveLOD(enabled) { hpRenderer.setAdaptiveLOD(enabled); },
    setForceLOD(level) { hpRenderer.setForceLOD(level); },
    getRendererStats() { return hpRenderer.getStats(); },
    debugRendererStatus() { return hpRenderer.debugStatus(); },

    // LOD visibility for edge filtering and highlight rendering
    // These now support per-view LOD tracking in multiview mode
    getLodVisibilityArray(viewId, dimensionLevel) {
      return hpRenderer.getLodVisibilityArray(undefined, viewId, dimensionLevel);
    },
    getCurrentLODLevel(viewId) {
      return hpRenderer.getCurrentLODLevel(viewId);
    },
    // Combined LOD + alpha visibility (preferred for consumers that need filter-aware visibility)
    getCombinedVisibilityForView(viewId, alphaThreshold) {
      return hpRenderer.getCombinedVisibilityForView(viewId, alphaThreshold);
    },

    start() {
      if (!animationHandle) animationHandle = requestAnimationFrame(render);
    }
  };
}
