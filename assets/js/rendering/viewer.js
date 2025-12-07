/**
 * WebGL2 Viewer with High-Performance Renderer
 * =============================================
 * Uses HighPerfRenderer for scatter points with WebGL2 only.
 * Keeps smoke, grid, and line rendering.
 */

import { GRID_VS_SOURCE, GRID_FS_SOURCE, LINE_INSTANCED_VS_SOURCE, LINE_INSTANCED_FS_SOURCE } from './shaders.js';
import { createProgram, createCanvasResizeObserver } from './gl-utils.js';
import { SMOKE_VS_SOURCE, SMOKE_FS_SOURCE, SMOKE_COMPOSITE_VS, SMOKE_COMPOSITE_FS } from './smoke-shaders.js';
import { createDensityTexture3D, buildDensityVolumeGPU } from './smoke-density.js';
import {
  generateCloudNoiseTextures,
  setNoiseResolution,
  getNoiseResolution,
  getResolutionScaleFactor,
  REFERENCE_RESOLUTION
} from './noise-textures.js';
import { HighPerfRenderer } from './high-perf-renderer.js';
import { HP_VS_HIGHLIGHT, HP_FS_HIGHLIGHT } from './high-perf-shaders.js';

// Simple centroid shader (WebGL2) - for small number of centroid points
// Uses RGBA uint8 normalized colors (same as main points)
const CENTROID_VS = `#version 300 es
precision highp float;

in vec3 a_position;
in vec4 a_color; // RGBA packed as uint8, auto-normalized by WebGL

uniform mat4 u_mvpMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_modelMatrix;
uniform float u_pointSize;
uniform float u_sizeAttenuation;
uniform float u_viewportHeight;
uniform float u_fov;

out vec3 v_color;
out float v_alpha;

void main() {
  gl_Position = u_mvpMatrix * vec4(a_position, 1.0);

  // Compute eye-space depth for perspective scaling (matches HP_VS_FULL)
  vec4 worldPos = u_modelMatrix * vec4(a_position, 1.0);
  vec4 eyePos = u_viewMatrix * worldPos;
  float eyeDepth = -eyePos.z;

  // Perspective point size with attenuation
  float projectionFactor = u_viewportHeight / (2.0 * tan(u_fov * 0.5));
  float worldSize = u_pointSize * 0.01;
  float perspectiveSize = (worldSize * projectionFactor) / max(eyeDepth, 0.001);
  gl_PointSize = mix(u_pointSize, perspectiveSize, u_sizeAttenuation);
  gl_PointSize = clamp(gl_PointSize, 0.5, 128.0);

  if (a_color.a < 0.01) gl_PointSize = 0.0;
  v_color = a_color.rgb;
  v_alpha = a_color.a;
}
`;

const CENTROID_FS = `#version 300 es
precision highp float;

in vec3 v_color;
in float v_alpha;

out vec4 fragColor;

void main() {
  if (v_alpha < 0.01) discard;
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  if (r2 > 1.0) discard;

  // Simple sphere shading
  float z = sqrt(1.0 - r2);
  vec3 normal = vec3(coord.x, -coord.y, z);
  vec3 lightDir = normalize(vec3(0.5, 0.7, 0.5));
  float NdotL = max(dot(normal, lightDir), 0.0);
  float lighting = 0.4 + 0.6 * NdotL;

  fragColor = vec4(v_color * lighting, v_alpha);
}
`;

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

  // === SMOKE PROGRAM ===
  const smokeProgram = createProgram(gl, SMOKE_VS_SOURCE, SMOKE_FS_SOURCE);
  const compositeProgram = createProgram(gl, SMOKE_COMPOSITE_VS, SMOKE_COMPOSITE_FS);

  const smokeAttribLocations = {
    position: gl.getAttribLocation(smokeProgram, 'a_position'),
  };
  const smokeUniformLocations = {
    invViewProj:       gl.getUniformLocation(smokeProgram, 'u_invViewProj'),
    cameraPos:         gl.getUniformLocation(smokeProgram, 'u_cameraPos'),
    volumeMin:         gl.getUniformLocation(smokeProgram, 'u_volumeMin'),
    volumeMax:         gl.getUniformLocation(smokeProgram, 'u_volumeMax'),
    // Native 3D density texture
    densityTex3D:      gl.getUniformLocation(smokeProgram, 'u_densityTex3D'),
    gridSize:          gl.getUniformLocation(smokeProgram, 'u_gridSize'),
    // Pre-computed noise textures
    shapeNoise:        gl.getUniformLocation(smokeProgram, 'u_shapeNoise'),
    detailNoise:       gl.getUniformLocation(smokeProgram, 'u_detailNoise'),
    blueNoise:         gl.getUniformLocation(smokeProgram, 'u_blueNoise'),
    blueNoiseOffset:   gl.getUniformLocation(smokeProgram, 'u_blueNoiseOffset'),
    // Colors and lighting
    bgColor:           gl.getUniformLocation(smokeProgram, 'u_bgColor'),
    smokeColor:        gl.getUniformLocation(smokeProgram, 'u_smokeColor'),
    lightDir:          gl.getUniformLocation(smokeProgram, 'u_lightDir'),
    // Animation and quality
    time:              gl.getUniformLocation(smokeProgram, 'u_time'),
    animationSpeed:    gl.getUniformLocation(smokeProgram, 'u_animationSpeed'),
    densityMultiplier: gl.getUniformLocation(smokeProgram, 'u_densityMultiplier'),
    stepMultiplier:    gl.getUniformLocation(smokeProgram, 'u_stepMultiplier'),
    noiseScale:        gl.getUniformLocation(smokeProgram, 'u_noiseScale'),
    warpStrength:      gl.getUniformLocation(smokeProgram, 'u_warpStrength'),
    detailLevel:       gl.getUniformLocation(smokeProgram, 'u_detailLevel'),
    lightAbsorption:   gl.getUniformLocation(smokeProgram, 'u_lightAbsorption'),
    scatterStrength:   gl.getUniformLocation(smokeProgram, 'u_scatterStrength'),
    edgeSoftness:      gl.getUniformLocation(smokeProgram, 'u_edgeSoftness'),
    directLight:       gl.getUniformLocation(smokeProgram, 'u_directLightIntensity'),
    lightSamples:      gl.getUniformLocation(smokeProgram, 'u_lightSamples'),
  };

  const compositeAttribLocations = {
    position: gl.getAttribLocation(compositeProgram, 'a_position'),
  };
  const compositeUniformLocations = {
    smokeTex:          gl.getUniformLocation(compositeProgram, 'u_smokeTex'),
    inverseResolution: gl.getUniformLocation(compositeProgram, 'u_inverseResolution'),
    intensity:         gl.getUniformLocation(compositeProgram, 'u_intensity'),
  };

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
    planeType:    gl.getUniformLocation(gridProgram, 'u_planeType'),
    fogDensity:   gl.getUniformLocation(gridProgram, 'u_fogDensity'),
    fogNearMean:  gl.getUniformLocation(gridProgram, 'u_fogNearMean'),
    fogFarMean:   gl.getUniformLocation(gridProgram, 'u_fogFarMean'),
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

  // === HIGHLIGHT PROGRAM (for selection rings) ===
  const highlightProgram = createProgram(gl, HP_VS_HIGHLIGHT, HP_FS_HIGHLIGHT);
  const highlightAttribLocations = {
    position: gl.getAttribLocation(highlightProgram, 'a_position'),
    color: gl.getAttribLocation(highlightProgram, 'a_color'),
  };
  const highlightUniformLocations = {
    mvpMatrix: gl.getUniformLocation(highlightProgram, 'u_mvpMatrix'),
    viewMatrix: gl.getUniformLocation(highlightProgram, 'u_viewMatrix'),
    modelMatrix: gl.getUniformLocation(highlightProgram, 'u_modelMatrix'),
    pointSize: gl.getUniformLocation(highlightProgram, 'u_pointSize'),
    sizeAttenuation: gl.getUniformLocation(highlightProgram, 'u_sizeAttenuation'),
    viewportHeight: gl.getUniformLocation(highlightProgram, 'u_viewportHeight'),
    fov: gl.getUniformLocation(highlightProgram, 'u_fov'),
    highlightScale: gl.getUniformLocation(highlightProgram, 'u_highlightScale'),
    highlightColor: gl.getUniformLocation(highlightProgram, 'u_highlightColor'),
    ringWidth: gl.getUniformLocation(highlightProgram, 'u_ringWidth'),
    haloStrength: gl.getUniformLocation(highlightProgram, 'u_haloStrength'),
    haloShape: gl.getUniformLocation(highlightProgram, 'u_haloShape'),
  };

  // Highlight state
  let highlightArray = null; // Uint8Array, per-point highlight intensity
  let highlightBuffer = null; // WebGL buffer for interleaved highlight data
  let highlightPointCount = 0;
  // Golden accent (halo) with defined halo shape
  let highlightColor = [1.0, 0.85, 0.0]; // bright yellow
  let highlightScale = 2.0; // How much larger than normal points
  let highlightRingWidth = 0.22; // Ring thickness
  let highlightHaloStrength = 0.6; // Halo opacity contribution
  // 0 = circle, 1 = square
  let highlightHaloShape = 0.0;
  const highlightStylesByQuality = {
    full: { scale: 2.0, ringWidth: 0.22, haloStrength: 0.65, haloShape: 0.0 },
    light: { scale: 1.9, ringWidth: 0.24, haloStrength: 0.50, haloShape: 0.0 },
    ultralight: { scale: 1.7, ringWidth: 0.26, haloStrength: 0.40, haloShape: 1.0 } // square halo for square points
  };
  let currentShaderQuality = 'full';

  function applyHighlightStyleForQuality(quality) {
    const style = highlightStylesByQuality[quality] || highlightStylesByQuality.full;
    highlightScale = style.scale;
    highlightRingWidth = style.ringWidth;
    highlightHaloStrength = style.haloStrength;
    highlightHaloShape = style.haloShape;
  }
  applyHighlightStyleForQuality(currentShaderQuality);

  // === BUFFERS ===
  // Centroid buffers (small count, separate from main points)
  // Color buffer now stores RGBA as uint8 (alpha packed in)
  const centroidPositionBuffer = gl.createBuffer();
  const centroidColorBuffer = gl.createBuffer(); // RGBA uint8
  // Projectile buffers (tiny count, dynamic)
  // Color buffers now store RGBA as uint8 (alpha packed in)
  const projectilePositionBuffer = gl.createBuffer();
  const projectileColorBuffer = gl.createBuffer(); // RGBA uint8
  const impactPositionBuffer = gl.createBuffer();
  const impactColorBuffer = gl.createBuffer(); // RGBA uint8

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

  // Fullscreen triangle for smoke
  const smokeQuadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, smokeQuadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  // Grid plane buffers - 5 sides (bottom + 4 walls, no top)
  const GRID_SIZE = 2.0;
  const gridPlaneBuffers = {
    bottom: gl.createBuffer(),  // XZ plane at y=-s (floor)
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
  let defaultShowCentroidPoints = true;
  let defaultShowCentroidLabels = true;
  const viewCentroidFlags = new Map();
  const viewCentroidLabels = new Map();

  // Small-multiples / snapshot views
  const LIVE_VIEW_ID = 'live';
  const MAX_SNAPSHOTS = 3;
  let snapshotViews = [];
  let nextSnapshotId = 1;
  let viewLayoutMode = 'grid';
  let focusedViewId = LIVE_VIEW_ID;
  let liveViewLabel = 'Live view';
  let liveViewHidden = false; // Whether to hide live view from grid
  let viewFocusHandler = typeof onViewFocus === 'function' ? onViewFocus : null;

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

  // Volumetric smoke state
  let renderMode = 'points';
  let smokeTextureInfo = null;
  const volumeMin = vec3.fromValues(-1, -1, -1);
  const volumeMax = vec3.fromValues(1, 1, 1);
  // Tuned default values for visible, realistic volumetric clouds
  let smokeDensity = 10.6;          // UI default cloud density
  let smokeNoiseScale = getResolutionScaleFactor(); // Keep noise scale stable across resolutions
  let smokeWarpStrength = 0.2;      // 10% turbulence default
  let smokeStepMultiplier = 2.8;    // High-quality ray marching default
  let smokeAnimationSpeed = 1.0;    // Default animation rate
  let smokeDetailLevel = 3.8;       // UI default fine detail
  let smokeLightAbsorption = 1.5;   // UI default absorption
  let smokeScatterStrength = 0.0;   // UI default scattering
  let smokeEdgeSoftness = 0.3;      // Gentle edge falloff
  let smokeLightSamples = 6;        // Balanced light quality
  let smokeDirectLight = 0.17;      // UI default directional intensity
  // Bright white for visibility
  const smokeColor = vec3.fromValues(0.98, 0.98, 1.0);
  const startTime = performance.now();
  // Cloud resolution scale: 1.0 = full resolution, 0.5 = half resolution
  // Values > 1.0 render at higher internal resolution (supersampling)
  let cloudResolutionScale = 0.5; // Default to half-res for performance
  let smokeFramebuffer = null;
  let smokeColorTex = null;
  let smokeTargetWidth = 0;
  let smokeTargetHeight = 0;

  // Pre-computed noise textures for high-performance cloud rendering
  let cloudNoiseTextures = null;
  let cloudNoiseResolution = 128; // Current noise texture resolution
  let frameIndex = 0;

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
  let bgColor = [1.0, 1.0, 1.0];
  let fogColor = [1.0, 1.0, 1.0];

  // Grid state - grid is default background
  let showGrid = true;
  let gridColor = [0.7, 0.7, 0.7];
  let gridBgColor = [0.97, 0.97, 0.97];
  let gridSpacing = 0.2;
  let gridLineWidth = 0.006;
  let gridOpacity = 0.55;

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

  // Navigation (orbit + free-fly)
  let navigationMode = 'orbit';
  let lookSensitivity = 0.0025; // radians per pixel
  let invertLookX = false;
  let invertLookY = false;
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
  let projectilesEnabled = false;
  let pendingShot = false;
  let lookActive = false;
  let lastFrameTime = performance.now();

  // Helper to fetch a normalized RGB color for a point index.
  function getNormalizedColor(idx) {
    if (!colorsArray || !pointCount) return [1.0, 0.6, 0.2];
    const stride = colorsArray.length === pointCount * 4 ? 4 : 3;
    const base = idx * stride;
    const scale = colorsArray.BYTES_PER_ELEMENT === 1 ? (1 / 255) : 1;
    return [
      (colorsArray[base] || 0) * scale,
      (colorsArray[base + 1] || 0) * scale,
      (colorsArray[base + 2] || 0) * scale
    ];
  }

  // Projectile sandbox (free-fly + pointer lock)
  const projectiles = [];
  const impactFlashes = [];
  let projectileBufferDirty = true;
  let impactBufferDirty = true;
  let projectilePositions = new Float32Array();
  let projectileColors = new Uint8Array(); // RGBA packed as uint8
  let impactPositions = new Float32Array();
  let impactColors = new Uint8Array(); // RGBA packed as uint8
  let lastShotTime = 0;
  let pointBounds = {
    min: [-1, -1, -1],
    max: [1, 1, 1],
    center: [0, 0, 0],
    radius: 3
  };
  let pointCollisionRadius = 0.02;

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
  const PROJECTILE_RADIUS = 0.05;        // Bigger projectile
  const PROJECTILE_TRAIL_DELAY = 0.12;   // Seconds before trail starts
  const PROJECTILE_SPEED = 3.0;          // Snappy and responsive
  const PROJECTILE_GRAVITY = 9.8 * 0.15; // Noticeable arcs without feeling heavy
  const PROJECTILE_DRAG = 0.998;         // Slight drag for natural deceleration
  const PHYSICS_TICK_RATE = 60;          // Reference frame rate for frame-independent physics (Hz)
  const PROJECTILE_LIFETIME = 12.0;      // Reasonable lifetime
  const PROJECTILE_BOUNCE = 0.1;         // Low restitution - loses most energy on impact
  const PROJECTILE_FRICTION = 0.7;       // High tangential friction on bounce
  const PROJECTILE_TRAIL_LENGTH = 16;    // Number of trail segments
  const PROJECTILE_TRAIL_SPACING = 0.004; // Seconds between trail samples (~60fps)
  const PROJECTILE_FLASH_TIME = 0.6;
  const MAX_PROJECTILES = 32;
  const MAX_IMPACT_FLASHES = 128;
  const PROJECTILE_SPREAD = 0;          // No spread - shoots exactly where aimed
  const PROJECTILE_LOFT = 0.01;         // Upward angle bias for arcing shots
  const SHOT_COOLDOWN_SECONDS = 0.05;

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
    // Cell selection mode: Alt+click (or Alt+drag for range selection)
    // Only enter selection mode if a field is active (highlightMode is not 'none')
    if (e.altKey && cellSelectionEnabled && e.button === 0 && highlightMode !== 'none') {
      const cellIdx = pickCellAtScreen(e.clientX, e.clientY);
      if (cellIdx >= 0) {
        selectionDragStart = {
          x: e.clientX,
          y: e.clientY,
          cellIndex: cellIdx
        };
        selectionDragCurrent = { x: e.clientX, y: e.clientY };
        // Set cursor based on highlight mode
        if (highlightMode === 'continuous') {
          canvas.style.cursor = 'ns-resize';
          canvas.classList.add('selecting-continuous');
        } else if (highlightMode === 'categorical') {
          canvas.style.cursor = 'cell';
          canvas.classList.add('selecting');
        }
      }
      e.preventDefault();
      return;
    }

    if (navigationMode === 'free') {
      const wantsShot = e.button === 0;
      // Only request pointer lock if user has enabled it via checkbox
      if (pointerLockEnabled && !pointerLockActive && canvas.requestPointerLock) {
        // Pointer lock enabled but not yet active - request it and queue the shot
        pendingShot = pendingShot || wantsShot;
        canvas.requestPointerLock();
      } else {
        // Either pointer lock is disabled, or already active - use normal mouse look
        lookActive = true;
        lastX = e.clientX;
        lastY = e.clientY;
        if (wantsShot) {
          spawnProjectile();
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

    if (e.button === 2 || e.shiftKey) {
      dragMode = 'pan';
      canvas.style.cursor = 'move';
    } else {
      dragMode = 'rotate';
      canvas.style.cursor = 'grabbing';
    }
    canvas.classList.add('dragging');
  });

  window.addEventListener('mouseup', (e) => {
    // Complete cell selection if in progress
    if (selectionDragStart) {
      const dragDistance = selectionDragCurrent
        ? Math.abs(selectionDragCurrent.y - selectionDragStart.y)
        : 0;

      // Emit selection event
      if (cellSelectionCallback) {
        cellSelectionCallback({
          type: dragDistance > 10 ? 'range' : 'click',
          cellIndex: selectionDragStart.cellIndex,
          dragDeltaY: selectionDragCurrent ? selectionDragCurrent.y - selectionDragStart.y : 0,
          startX: selectionDragStart.x,
          startY: selectionDragStart.y,
          endX: selectionDragCurrent?.x ?? selectionDragStart.x,
          endY: selectionDragCurrent?.y ?? selectionDragStart.y
        });
      }

      selectionDragStart = null;
      selectionDragCurrent = null;
      canvas.classList.remove('selecting');
      canvas.classList.remove('selecting-continuous');
      updateCursorForHighlightMode();
      return;
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
  });

  window.addEventListener('mousemove', (e) => {
    // Always track cursor position for aiming (when not in pointer lock)
    if (!pointerLockActive) {
      cursorX = e.clientX;
      cursorY = e.clientY;
    }

    // Track selection drag
    if (selectionDragStart) {
      selectionDragCurrent = { x: e.clientX, y: e.clientY };
      // Emit preview event for live updating during drag
      if (selectionPreviewCallback) {
        selectionPreviewCallback({
          type: 'preview',
          cellIndex: selectionDragStart.cellIndex,
          dragDeltaY: selectionDragCurrent.y - selectionDragStart.y,
          startX: selectionDragStart.x,
          startY: selectionDragStart.y,
          endX: selectionDragCurrent.x,
          endY: selectionDragCurrent.y
        });
      }
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
      const forward = vec3.sub(vec3.create(), target, eye);
      vec3.normalize(forward, forward);
      const camRight = vec3.cross(vec3.create(), forward, up);
      vec3.normalize(camRight, camRight);
      const camUp = vec3.cross(vec3.create(), camRight, forward);
      vec3.normalize(camUp, camUp);
      const panSpeed = radius * 0.002;
      vec3.scaleAndAdd(target, target, camRight, -dx * panSpeed);
      vec3.scaleAndAdd(target, target, camUp, dy * panSpeed);
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
    targetRadius += delta * sensitivity;
    targetRadius = Math.max(minOrbitRadius, Math.min(100.0, targetRadius));
  }, { passive: false });

  // Alt key handling for highlight mode cursor
  let altKeyDown = false;

  function updateCursorForHighlightMode() {
    // Don't change cursor during free navigation or active drags
    if (navigationMode === 'free') return;
    if (isDragging) return; // orbit drag in progress
    if (selectionDragStart) return; // cell selection drag in progress

    // Set cursor based on Alt key and highlight mode
    if (altKeyDown && highlightMode === 'continuous') {
      canvas.style.cursor = 'ns-resize';
    } else if (altKeyDown && highlightMode === 'categorical') {
      canvas.style.cursor = 'cell';
    } else {
      canvas.style.cursor = 'grab';
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Alt' && !altKeyDown) {
      altKeyDown = true;
      updateCursorForHighlightMode();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') {
      altKeyDown = false;
      updateCursorForHighlightMode();
    }
  });

  // Also update when window loses focus (Alt might be released while window unfocused)
  window.addEventListener('blur', () => {
    altKeyDown = false;
    updateCursorForHighlightMode();
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
      if (pendingShot) {
        spawnProjectile();
        pendingShot = false;
      }
    } else {
      lookActive = false;
      pointerLockEnabled = false;
      pendingShot = false;
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
      if (code === 'Space' || code === 'KeyW' || code === 'KeyA' || code === 'KeyS' || code === 'KeyD' ||
          code === 'KeyQ' || code === 'KeyE' || code === 'ControlLeft' || code === 'ControlRight' ||
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
      dragMode = 'rotate';
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
    const rotateSpeed = 0.005;
      const { xSign, ySign } = getOrbitSigns();
      theta -= dx * rotateSpeed * xSign;
      phi -= dy * rotateSpeed * ySign;
      const EPS = 0.05;
      phi = Math.max(EPS, Math.min(Math.PI - EPS, phi));
      while (theta > Math.PI * 2) theta -= Math.PI * 2;
      while (theta < 0) theta += Math.PI * 2;
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
    if (!positions || positions.length < 3) return;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const count = positions.length / 3;
    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      const x = positions[idx];
      const y = positions[idx + 1];
      const z = positions[idx + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const centerX = (minX + maxX) * 0.5;
    const centerY = (minY + maxY) * 0.5;
    const centerZ = (minZ + maxZ) * 0.5;
    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    const radius = Math.max(0.0001, Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5);
    pointBounds = {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      center: [centerX, centerY, centerZ],
      radius
    };
    pointCollisionRadius = Math.max(0.01, radius * 0.01);
  }

  function queryNearbyPoints(center, radius, maxResults = 64) {
    if (!positionsArray || positionsArray.length < 3) return [];
    if (!hpRenderer?.octree) {
      hpRenderer?.ensureOctree();
    }
    if (!hpRenderer?.octree) return [];
    const indices = hpRenderer.octree.queryRadius(center, radius, maxResults);
    return indices.map((idx) => {
      const posBase = idx * 3;
      return {
        index: idx,
        position: [positionsArray[posBase], positionsArray[posBase + 1], positionsArray[posBase + 2]],
        color: getNormalizedColor(idx)
      };
    });
  }

  function pickProjectileColor() {
    if (colorsArray && pointCount > 0) {
      const idx = Math.floor(Math.random() * pointCount);
      return getNormalizedColor(idx);
    }
    return [1.0, 0.6, 0.2];
  }

  function spawnProjectile() {
    if (navigationMode !== 'free') return;
    if (!projectilesEnabled) return;
    const now = performance.now();
    if (now - lastShotTime < SHOT_COOLDOWN_SECONDS * 1000) return;
    lastShotTime = now;

    // Use cursor-based aiming when not in pointer lock mode, otherwise use camera forward
    const axes = getFreeflyAxes();
    const aimDirection = pointerLockActive
      ? axes.forward
      : getAimDirectionFromCursor();

    // Add slight random spread and upward loft for arcing shots
    const spreadDir = vec3.clone(aimDirection);
    const randRight = (Math.random() - 0.5) * 2 * PROJECTILE_SPREAD;
    const randUp = (Math.random() - 0.5) * 2 * PROJECTILE_SPREAD;
    vec3.scaleAndAdd(spreadDir, spreadDir, axes.right, randRight);
    vec3.scaleAndAdd(spreadDir, spreadDir, axes.upVec, randUp);
    // Add upward loft for higher arcing trajectory
    spreadDir[1] += PROJECTILE_LOFT;
    vec3.normalize(spreadDir, spreadDir);

    // Start projectile very close to camera for bigger initial appearance
    const start = vec3.add(vec3.create(), freeflyPosition, vec3.scale(vec3.create(), spreadDir, 0.02));
    const vel = vec3.scale(vec3.create(), spreadDir, PROJECTILE_SPEED);
    projectiles.push({
      position: start,
      velocity: vel,
      color: pickProjectileColor(),
      radius: PROJECTILE_RADIUS,
      age: 0,
      trail: [],           // Ring buffer of past positions [x,y,z, x,y,z, ...]
      trailTime: -PROJECTILE_TRAIL_DELAY  // Negative = delay before trail starts
    });
    if (projectiles.length > MAX_PROJECTILES) projectiles.shift();
    projectileBufferDirty = true;
  }

  function recordImpact(position, color) {
    impactFlashes.push({
      position: [position[0], position[1], position[2]],
      color: color || [1, 1, 1],
      age: 0,
      life: PROJECTILE_FLASH_TIME
    });
    if (impactFlashes.length > MAX_IMPACT_FLASHES) impactFlashes.shift();
    impactBufferDirty = true;
  }

  function updateImpactFlashes(dt) {
    if (!impactFlashes.length) return;
    let anyRemoved = false;
    for (let i = impactFlashes.length - 1; i >= 0; i--) {
      const flash = impactFlashes[i];
      flash.age += dt;
      if (flash.age >= flash.life) {
        impactFlashes.splice(i, 1);
        anyRemoved = true;
      }
    }
    if (anyRemoved || dt > 0) impactBufferDirty = true;
  }

  function stepProjectiles(dt) {
    if (!projectiles.length) return;
    const maxRange = pointBounds.radius * 3 + 1.0;
    const collisionRadius = PROJECTILE_RADIUS + pointCollisionRadius;

    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      p.age += dt;
      if (p.age > PROJECTILE_LIFETIME) {
        projectiles.splice(i, 1);
        projectileBufferDirty = true;
        continue;
      }

      // Sample trail position at regular intervals
      p.trailTime += dt;
      if (p.trailTime >= PROJECTILE_TRAIL_SPACING) {
        p.trailTime = 0;
        // Push current position to trail (stored as flat array for performance)
        p.trail.push(p.position[0], p.position[1], p.position[2]);
        // Trim trail to max length (each position is 3 floats)
        const maxTrailFloats = PROJECTILE_TRAIL_LENGTH * 3;
        if (p.trail.length > maxTrailFloats) {
          p.trail.splice(0, 3); // Remove oldest position
        }
      }

      // Calculate sub-steps based on velocity to prevent tunneling
      const speed = vec3.length(p.velocity);
      const moveDistance = speed * dt;
      // Keep each physics step short so the swept collision check remains robust
      const maxStepDistance = collisionRadius * 0.75;
      const numSubSteps = Math.max(2, Math.ceil(moveDistance / maxStepDistance));
      const subDt = dt / numSubSteps;
      const gravitySubStep = PROJECTILE_GRAVITY * subDt;
      const subDrag = Math.pow(PROJECTILE_DRAG, subDt * PHYSICS_TICK_RATE);

      let outOfBounds = false;

      for (let step = 0; step < numSubSteps; step++) {
        // Apply physics
        p.velocity[1] -= gravitySubStep;
        vec3.scale(p.velocity, p.velocity, subDrag);
        vec3.scaleAndAdd(p.position, p.position, p.velocity, subDt);

        // Check bounds
        const dx = p.position[0] - pointBounds.center[0];
        const dy = p.position[1] - pointBounds.center[1];
        const dz = p.position[2] - pointBounds.center[2];
        const distFromCenter = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (distFromCenter > maxRange) {
          outOfBounds = true;
          break;
        }

        // Check collisions with cells - find the closest cell for a clean bounce
        if (pointCount > 0 && !p.resting) {
          // Query nearby points around current position
          const hits = queryNearbyPoints(p.position, collisionRadius * 1.5, 32);

          // Find the closest colliding cell
          let closestHit = null;
          let closestDist = Infinity;

          for (const hit of hits) {
            vec3.sub(tempVec3, p.position, hit.position);
            const d = vec3.length(tempVec3);
            if (d < collisionRadius && d < closestDist) {
              closestDist = d;
              closestHit = hit;
            }
          }

          if (closestHit) {
            // Calculate clean surface normal from closest cell
            vec3.sub(tempVec3, p.position, closestHit.position);
            const d = vec3.length(tempVec3);
            if (d > 1e-5) {
              vec3.scale(tempVec3, tempVec3, 1 / d); // Normalize
            } else {
              // Fallback: use opposite of velocity direction
              vec3.normalize(tempVec3, p.velocity);
              vec3.scale(tempVec3, tempVec3, -1);
            }

            // Ensure normal points away from surface (opposes incoming velocity)
            const vDotN = vec3.dot(p.velocity, tempVec3);
            if (vDotN > 0) {
              vec3.scale(tempVec3, tempVec3, -1);
            }
            // Decompose velocity into normal and tangent components
            vec3.scale(tempVec3b, tempVec3, vDotN); // Normal component
            vec3.sub(tempVec3c, p.velocity, tempVec3b); // Tangent component

            // Apply restitution to normal component (bounce)
            vec3.scale(tempVec3b, tempVec3b, -PROJECTILE_BOUNCE);

            // Apply friction to tangent component (slide)
            vec3.scale(tempVec3c, tempVec3c, PROJECTILE_FRICTION);

            // Combine for new velocity
            vec3.add(p.velocity, tempVec3b, tempVec3c);

            // Push position out of collision cleanly
            const penetration = collisionRadius - d;
            vec3.scaleAndAdd(p.position, p.position, tempVec3, penetration + 0.003);

            recordImpact(closestHit.position, closestHit.color || pickProjectileColor());
          }
        }
      }

      if (outOfBounds) {
        projectiles.splice(i, 1);
        projectileBufferDirty = true;
        continue;
      }
    }

    if (projectiles.length) projectileBufferDirty = true;
  }

  // Track total projectile points for draw call
  let projectilePointCount = 0;

  function rebuildProjectileBuffers() {
    const count = projectiles.length;
    if (count === 0) {
      projectilePositions = new Float32Array();
      projectileColors = new Uint8Array();
      projectilePointCount = 0;
      gl.bindBuffer(gl.ARRAY_BUFFER, projectilePositionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, projectilePositions, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, projectileColorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, projectileColors, gl.DYNAMIC_DRAW);
      projectileBufferDirty = false;
      return;
    }

    // Count total points: head + trail for each projectile
    let totalPoints = 0;
    for (let i = 0; i < count; i++) {
      totalPoints += 1 + (projectiles[i].trail.length / 3);
    }

    projectilePositions = new Float32Array(totalPoints * 3);
    projectileColors = new Uint8Array(totalPoints * 4);
    let pointIndex = 0;

    for (let i = 0; i < count; i++) {
      const p = projectiles[i];
      const r = Math.round(p.color[0] * 255);
      const g = Math.round(p.color[1] * 255);
      const b = Math.round(p.color[2] * 255);
      const trailCount = p.trail.length / 3;

      // Write trail points first (oldest to newest, fading alpha)
      for (let t = 0; t < trailCount; t++) {
        const posBase = pointIndex * 3;
        const colBase = pointIndex * 4;
        const trailBase = t * 3;

        projectilePositions[posBase] = p.trail[trailBase];
        projectilePositions[posBase + 1] = p.trail[trailBase + 1];
        projectilePositions[posBase + 2] = p.trail[trailBase + 2];

        // Alpha fades from ~20 (oldest) to ~180 (newest)
        const alpha = Math.round(20 + (t / Math.max(1, trailCount - 1)) * 160);
        projectileColors[colBase] = r;
        projectileColors[colBase + 1] = g;
        projectileColors[colBase + 2] = b;
        projectileColors[colBase + 3] = alpha;
        pointIndex++;
      }

      // Write head point (full alpha, brightest)
      const posBase = pointIndex * 3;
      const colBase = pointIndex * 4;
      projectilePositions[posBase] = p.position[0];
      projectilePositions[posBase + 1] = p.position[1];
      projectilePositions[posBase + 2] = p.position[2];
      projectileColors[colBase] = r;
      projectileColors[colBase + 1] = g;
      projectileColors[colBase + 2] = b;
      projectileColors[colBase + 3] = 255;
      pointIndex++;
    }

    projectilePointCount = totalPoints;
    gl.bindBuffer(gl.ARRAY_BUFFER, projectilePositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, projectilePositions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, projectileColorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, projectileColors, gl.DYNAMIC_DRAW);
    projectileBufferDirty = false;
  }

  function rebuildImpactBuffers() {
    const count = impactFlashes.length;
    if (count === 0) {
      impactPositions = new Float32Array();
      impactColors = new Uint8Array();
      gl.bindBuffer(gl.ARRAY_BUFFER, impactPositionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, impactPositions, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, impactColorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, impactColors, gl.DYNAMIC_DRAW);
      impactBufferDirty = false;
      return;
    }

    impactPositions = new Float32Array(count * 3);
    impactColors = new Uint8Array(count * 4); // RGBA packed
    for (let i = 0; i < count; i++) {
      const flash = impactFlashes[i];
      const posBase = i * 3;
      const colBase = i * 4;
      const alpha = Math.max(0, 1 - (flash.age / flash.life));
      impactPositions[posBase] = flash.position[0];
      impactPositions[posBase + 1] = flash.position[1];
      impactPositions[posBase + 2] = flash.position[2];
      // Convert float 0-1 to uint8 0-255
      impactColors[colBase] = Math.round(flash.color[0] * 255);
      impactColors[colBase + 1] = Math.round(flash.color[1] * 255);
      impactColors[colBase + 2] = Math.round(flash.color[2] * 255);
      impactColors[colBase + 3] = Math.round(alpha * 255); // alpha fades over time
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, impactPositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, impactPositions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, impactColorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, impactColors, gl.DYNAMIC_DRAW);
    impactBufferDirty = false;
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

  // Compute aim direction from cursor screen position (for aiming without pointer lock)
  function getAimDirectionFromCursor() {
    const rect = canvas.getBoundingClientRect();
    // Convert cursor position to normalized device coordinates (-1 to 1)
    const ndcX = ((cursorX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((cursorY - rect.top) / rect.height) * 2 + 1;  // Flip Y for GL

    // Create ray in clip space at near plane
    const nearPoint = vec4.fromValues(ndcX, ndcY, -1, 1);
    const farPoint = vec4.fromValues(ndcX, ndcY, 1, 1);

    // Get inverse view-projection matrix
    const aspect = rect.width / rect.height;
    const tempProj = mat4.create();
    const tempViewProj = mat4.create();
    const invViewProj = mat4.create();
    mat4.perspective(tempProj, fov, aspect, near, far);

    // Build view matrix for freefly mode
    const { forward: camForward, upVec } = getFreeflyAxes();
    const tempView = mat4.create();
    const lookTarget = vec3.add(vec3.create(), freeflyPosition, camForward);
    mat4.lookAt(tempView, freeflyPosition, lookTarget, upVec);

    mat4.multiply(tempViewProj, tempProj, tempView);
    mat4.invert(invViewProj, tempViewProj);

    // Unproject to world space
    vec4.transformMat4(nearPoint, nearPoint, invViewProj);
    vec4.transformMat4(farPoint, farPoint, invViewProj);

    // Perspective divide
    vec3.set(tempVec3, nearPoint[0] / nearPoint[3], nearPoint[1] / nearPoint[3], nearPoint[2] / nearPoint[3]);
    vec3.set(tempVec3b, farPoint[0] / farPoint[3], farPoint[1] / farPoint[3], farPoint[2] / farPoint[3]);

    // Direction from near to far
    const direction = vec3.sub(vec3.create(), tempVec3b, tempVec3);
    vec3.normalize(direction, direction);
    return direction;
  }

  function updateFreefly(dt) {
    const { forward, right, upVec } = getFreeflyAxes();
    const move = vec3.create();
    if (activeKeys.has('KeyW')) vec3.add(move, move, forward);
    if (activeKeys.has('KeyS')) vec3.sub(move, move, forward);
    if (activeKeys.has('KeyD')) vec3.add(move, move, right);
    if (activeKeys.has('KeyA')) vec3.sub(move, move, right);
    if (activeKeys.has('Space') || activeKeys.has('KeyE')) vec3.add(move, move, upVec);
    if (activeKeys.has('KeyQ') || activeKeys.has('ControlLeft') || activeKeys.has('ControlRight')) vec3.sub(move, move, upVec);

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

  function ensureSmokeTarget(w, h, scale) {
    const targetW = Math.max(1, Math.floor(w * scale));
    const targetH = Math.max(1, Math.floor(h * scale));
    if (smokeFramebuffer && targetW === smokeTargetWidth && targetH === smokeTargetHeight) return;
    if (smokeFramebuffer) {
      gl.deleteFramebuffer(smokeFramebuffer);
      gl.deleteTexture(smokeColorTex);
    }
    smokeTargetWidth = targetW;
    smokeTargetHeight = targetH;
    smokeColorTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, smokeColorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, targetW, targetH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    smokeFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, smokeFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, smokeColorTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
    if (!showGrid) return;
    gl.useProgram(gridProgram);
    gl.uniformMatrix4fv(gridUniformLocations.mvpMatrix, false, mvpMatrix);
    gl.uniformMatrix4fv(gridUniformLocations.viewMatrix, false, viewMatrix);
    gl.uniformMatrix4fv(gridUniformLocations.modelMatrix, false, modelMatrix);
    gl.uniform3fv(gridUniformLocations.gridColor, gridColor);
    gl.uniform3fv(gridUniformLocations.bgColor, gridBgColor);
    gl.uniform1f(gridUniformLocations.gridSpacing, gridSpacing);
    gl.uniform1f(gridUniformLocations.gridLineWidth, gridLineWidth);
    gl.uniform1f(gridUniformLocations.gridOpacity, gridOpacity);
    gl.uniform1f(gridUniformLocations.fogDensity, fogDensity);
    gl.uniform1f(gridUniformLocations.fogNearMean, fogNearMean);
    gl.uniform1f(gridUniformLocations.fogFarMean, fogFarMean);

    gl.depthMask(false);

    // Build list of visible planes based on camera position relative to target
    // Only show planes that are "behind" the data from camera's perspective
    // planeType: 0=XY (back/front walls), 1=XZ (floor), 2=YZ (left/right walls)
    const planes = [];

    // Bottom floor (y=-s): visible when camera is above target
    if (eye[1] > target[1]) {
      planes.push({ buffer: gridPlaneBuffers.bottom, type: 1 });
    }

    // Back wall (z=-s): visible when camera is in front (z > target.z)
    if (eye[2] > target[2]) {
      planes.push({ buffer: gridPlaneBuffers.back, type: 0 });
    }

    // Front wall (z=+s): visible when camera is behind (z < target.z)
    if (eye[2] < target[2]) {
      planes.push({ buffer: gridPlaneBuffers.front, type: 0 });
    }

    // Left wall (x=-s): visible when camera is to the right (x > target.x)
    if (eye[0] > target[0]) {
      planes.push({ buffer: gridPlaneBuffers.left, type: 2 });
    }

    // Right wall (x=+s): visible when camera is to the left (x < target.x)
    if (eye[0] < target[0]) {
      planes.push({ buffer: gridPlaneBuffers.right, type: 2 });
    }

    for (const plane of planes) {
      gl.uniform1i(gridUniformLocations.planeType, plane.type);
      gl.bindBuffer(gl.ARRAY_BUFFER, plane.buffer);
      gl.enableVertexAttribArray(gridAttribLocations.position);
      gl.vertexAttribPointer(gridAttribLocations.position, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.depthMask(true);
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

  function drawProjectiles(viewportHeight) {
    if (projectilePointCount === 0) return;

    gl.useProgram(centroidProgram);
    gl.uniformMatrix4fv(centroidUniformLocations.mvpMatrix, false, mvpMatrix);
    gl.uniformMatrix4fv(centroidUniformLocations.viewMatrix, false, viewMatrix);
    gl.uniformMatrix4fv(centroidUniformLocations.modelMatrix, false, modelMatrix);
    // Use the same point size as data points so bullets match
    gl.uniform1f(centroidUniformLocations.pointSize, basePointSize);
    gl.uniform1f(centroidUniformLocations.sizeAttenuation, sizeAttenuation);
    gl.uniform1f(centroidUniformLocations.viewportHeight, viewportHeight);
    gl.uniform1f(centroidUniformLocations.fov, fov);

    gl.bindBuffer(gl.ARRAY_BUFFER, projectilePositionBuffer);
    gl.enableVertexAttribArray(centroidAttribLocations.position);
    gl.vertexAttribPointer(centroidAttribLocations.position, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, projectileColorBuffer);
    gl.enableVertexAttribArray(centroidAttribLocations.color);
    gl.vertexAttribPointer(centroidAttribLocations.color, 4, gl.UNSIGNED_BYTE, true, 0, 0); // RGBA uint8 normalized

    gl.drawArrays(gl.POINTS, 0, projectilePointCount);
  }

  function drawImpactFlashes(viewportHeight) {
    const count = impactFlashes.length;
    if (count === 0) return;

    gl.useProgram(centroidProgram);
    gl.uniformMatrix4fv(centroidUniformLocations.mvpMatrix, false, mvpMatrix);
    gl.uniformMatrix4fv(centroidUniformLocations.viewMatrix, false, viewMatrix);
    gl.uniformMatrix4fv(centroidUniformLocations.modelMatrix, false, modelMatrix);
    // Impact flashes are larger for visual pop
    gl.uniform1f(centroidUniformLocations.pointSize, basePointSize * 1.8);
    gl.uniform1f(centroidUniformLocations.sizeAttenuation, sizeAttenuation);
    gl.uniform1f(centroidUniformLocations.viewportHeight, viewportHeight);
    gl.uniform1f(centroidUniformLocations.fov, fov);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

    gl.bindBuffer(gl.ARRAY_BUFFER, impactPositionBuffer);
    gl.enableVertexAttribArray(centroidAttribLocations.position);
    gl.vertexAttribPointer(centroidAttribLocations.position, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, impactColorBuffer);
    gl.enableVertexAttribArray(centroidAttribLocations.color);
    gl.vertexAttribPointer(centroidAttribLocations.color, 4, gl.UNSIGNED_BYTE, true, 0, 0); // RGBA uint8 normalized

    gl.drawArrays(gl.POINTS, 0, count);

    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  // === HIGHLIGHT RENDERING ===
  // Rebuild the highlight buffer with positions of highlighted cells
  // Only includes cells that are both highlighted AND visible (transparency > 0)
  function rebuildHighlightBuffer(highlightData, positions, transparency) {
    if (!highlightData || !positions) {
      highlightPointCount = 0;
      return;
    }

    // Count highlighted AND visible cells
    let count = 0;
    for (let i = 0; i < highlightData.length; i++) {
      if (highlightData[i] > 0) {
        // Only count if visible (no transparency array = all visible, or transparency > 0)
        const isVisible = !transparency || transparency[i] > 0;
        if (isVisible) count++;
      }
    }

    if (count === 0) {
      highlightPointCount = 0;
      return;
    }

    // Create interleaved buffer: pos (3 floats) + color (4 uint8 packed as 1 float via view)
    // Using same layout as main points: 16 bytes per point (12 bytes pos + 4 bytes RGBA)
    const BYTES_PER_POINT = 16;
    const bufferData = new ArrayBuffer(count * BYTES_PER_POINT);
    const posView = new Float32Array(bufferData);
    const colorView = new Uint8Array(bufferData);

    let outIdx = 0;
    for (let i = 0; i < highlightData.length; i++) {
      if (highlightData[i] > 0) {
        // Only include if visible
        const isVisible = !transparency || transparency[i] > 0;
        if (!isVisible) continue;

        const posOffset = outIdx * 4; // 4 floats per point (3 pos + 1 color-as-float)
        const colorOffset = outIdx * BYTES_PER_POINT + 12; // color at byte 12

        posView[posOffset] = positions[i * 3];
        posView[posOffset + 1] = positions[i * 3 + 1];
        posView[posOffset + 2] = positions[i * 3 + 2];

        // RGBA: full alpha for visibility, use highlight intensity
        colorView[colorOffset] = 255;     // R
        colorView[colorOffset + 1] = 255; // G
        colorView[colorOffset + 2] = 255; // B
        colorView[colorOffset + 3] = highlightData[i]; // A = highlight intensity

        outIdx++;
      }
    }

    if (!highlightBuffer) {
      highlightBuffer = gl.createBuffer();
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, highlightBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, bufferData, gl.DYNAMIC_DRAW);

    highlightPointCount = count;
  }

  function drawHighlights(viewportHeight) {
    if (highlightPointCount === 0 || !highlightBuffer) return;

    gl.useProgram(highlightProgram);

    // Set uniforms
    gl.uniformMatrix4fv(highlightUniformLocations.mvpMatrix, false, mvpMatrix);
    gl.uniformMatrix4fv(highlightUniformLocations.viewMatrix, false, viewMatrix);
    gl.uniformMatrix4fv(highlightUniformLocations.modelMatrix, false, modelMatrix);
    // Adapt halo sizing for square sprites so halo grows/shrinks with actual marker size
    let effectiveScale = highlightScale;
    let effectiveRingWidth = highlightRingWidth;
    let effectiveHaloStrength = highlightHaloStrength;
    if (highlightHaloShape > 0.5) {
      const haloBoost = Math.min(1.5, Math.max(0, basePointSize * (0.01 + sizeAttenuation * 0.02)));
      effectiveScale = highlightScale + haloBoost;
      effectiveRingWidth = Math.min(0.35, highlightRingWidth + haloBoost * 0.03);
      effectiveHaloStrength = Math.min(1.0, highlightHaloStrength + haloBoost * 0.15);
    }

    gl.uniform1f(highlightUniformLocations.pointSize, basePointSize);
    gl.uniform1f(highlightUniformLocations.sizeAttenuation, sizeAttenuation);
    gl.uniform1f(highlightUniformLocations.viewportHeight, viewportHeight);
    gl.uniform1f(highlightUniformLocations.fov, fov);
    gl.uniform1f(highlightUniformLocations.highlightScale, effectiveScale);
    gl.uniform3fv(highlightUniformLocations.highlightColor, highlightColor);
    gl.uniform1f(highlightUniformLocations.ringWidth, effectiveRingWidth);
    gl.uniform1f(highlightUniformLocations.haloStrength, effectiveHaloStrength);
    gl.uniform1f(highlightUniformLocations.haloShape, highlightHaloShape);

    // Bind interleaved buffer
    const BYTES_PER_POINT = 16;
    gl.bindBuffer(gl.ARRAY_BUFFER, highlightBuffer);

    // Position attribute (3 floats at offset 0)
    gl.enableVertexAttribArray(highlightAttribLocations.position);
    gl.vertexAttribPointer(highlightAttribLocations.position, 3, gl.FLOAT, false, BYTES_PER_POINT, 0);

    // Color attribute (4 uint8 at offset 12)
    gl.enableVertexAttribArray(highlightAttribLocations.color);
    gl.vertexAttribPointer(highlightAttribLocations.color, 4, gl.UNSIGNED_BYTE, true, BYTES_PER_POINT, 12);

    // Enable additive blending for glow effect
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

    gl.drawArrays(gl.POINTS, 0, highlightPointCount);

    // Restore normal blending
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  // === CELL PICKING ===
  // Convert screen coordinates to a ray and find the nearest cell
  function screenToRay(screenX, screenY, canvasWidth, canvasHeight) {
    // Normalize to clip space (-1 to 1)
    const ndcX = (screenX / canvasWidth) * 2 - 1;
    const ndcY = 1 - (screenY / canvasHeight) * 2;

    // Create inverse view-projection matrix
    const viewProj = mat4.create();
    mat4.multiply(viewProj, projectionMatrix, viewMatrix);
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

  function pickCellAtScreen(screenX, screenY) {
    const rect = canvas.getBoundingClientRect();
    const localX = screenX - rect.left;
    const localY = screenY - rect.top;

    const ray = screenToRay(localX, localY, rect.width, rect.height);
    if (!ray) return -1;

    const positions = hpRenderer.getPositions();
    if (!positions) return -1;

    const octree = hpRenderer.octree;

    // Sample along the ray to find the nearest cell
    const maxDistance = radius * 4; // Max ray distance
    const sampleStep = 0.02; // Step size along ray
    const searchRadius = 0.03; // Search radius around each sample point

    let nearestCell = -1;
    let nearestDist = Infinity;

    for (let t = 0; t < maxDistance; t += sampleStep) {
      const samplePoint = [
        ray.origin[0] + ray.direction[0] * t,
        ray.origin[1] + ray.direction[1] * t,
        ray.origin[2] + ray.direction[2] * t
      ];

      // Query cells near this point
      let candidates;
      if (octree) {
        candidates = octree.queryRadius(samplePoint, searchRadius, 16);
      } else {
        // Fallback: brute force search (slow)
        candidates = [];
        const r2 = searchRadius * searchRadius;
        const n = positions.length / 3;
        for (let i = 0; i < n && candidates.length < 16; i++) {
          const dx = positions[i * 3] - samplePoint[0];
          const dy = positions[i * 3 + 1] - samplePoint[1];
          const dz = positions[i * 3 + 2] - samplePoint[2];
          if (dx * dx + dy * dy + dz * dz <= r2) {
            candidates.push(i);
          }
        }
      }

      // Find the closest cell to the ray origin
      for (const idx of candidates) {
        const px = positions[idx * 3];
        const py = positions[idx * 3 + 1];
        const pz = positions[idx * 3 + 2];

        // Distance from cell to ray origin
        const dist = Math.sqrt(
          (px - ray.origin[0]) ** 2 +
          (py - ray.origin[1]) ** 2 +
          (pz - ray.origin[2]) ** 2
        );

        if (dist < nearestDist) {
          nearestDist = dist;
          nearestCell = idx;
        }
      }

      // If we found something, stop early
      if (nearestCell >= 0) break;
    }

    return nearestCell;
  }

  // Cell selection state
  let cellSelectionEnabled = true;
  let cellSelectionCallback = null; // Called when user selects cells
  let selectionPreviewCallback = null; // Called during drag for live preview
  let selectionDragStart = null; // { x, y, cellIndex, value } for drag selection
  let selectionDragCurrent = null;
  let highlightMode = 'none'; // 'none', 'categorical', or 'continuous'

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

  function updateCentroidLabelPositions(labels, viewportNorm) {
    // Use CSS pixels (clientWidth/Height) not device pixels (width/height)
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
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
      // viewportNorm: x,y are top-left corner in CSS coords (normalized 0-1)
      const vpX = viewportNorm.x * width;
      const vpY = viewportNorm.y * height;
      const vpW = viewportNorm.w * width;
      const vpH = viewportNorm.h * height;
      // NDC x: -1 = left, +1 = right
      const screenX = vpX + (ndcX * 0.5 + 0.5) * vpW;
      // NDC y: -1 = bottom, +1 = top; CSS y: 0 = top, increases downward
      const screenY = vpY + (0.5 - ndcY * 0.5) * vpH;
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

    stepProjectiles(dt);
    updateImpactFlashes(dt);
    if (projectileBufferDirty) rebuildProjectileBuffers();
    if (impactBufferDirty) rebuildImpactBuffers();

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
      // Draw grid first as background reference
      if (showGrid) {
        drawGrid();
      }
      // Render smoke with alpha blending on top of grid
      renderSmoke(width, height, showGrid);
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
        centroidCount: centroidCount
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
        centroidCount: snap.centroidPositions ? snap.centroidPositions.length / 3 : 0
      });
    }

    // In single mode or only one view, render full screen
    if (viewLayoutMode === 'single' || allViews.length <= 1) {
      gl.viewport(0, 0, width, height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      // If we have exactly one view (e.g., live hidden with 1 snapshot), load its data
      if (allViews.length === 1) {
        const view = allViews[0];
        // Only update buffers when switching views (not every frame)
        // Live view updates are handled by state.js via viewer.updateColors/updateTransparency
        if (view.id !== LIVE_VIEW_ID && view.id !== currentLoadedViewId) {
          if (view.colors) hpRenderer.updateColors(view.colors);
          if (view.transparency) hpRenderer.updateAlphas(view.transparency);
          currentLoadedViewId = view.id;
        }
        renderSingleView(width, height, { x: 0, y: 0, w: 1, h: 1 }, view.id, view.centroidCount);
      } else {
        renderSingleView(width, height, { x: 0, y: 0, w: 1, h: 1 });
      }
      return;
    }

    // Grid mode: render multiple viewports
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const viewCount = allViews.length;
    // Layout: 1=1x1, 2=2x1, 3=3x1, 4=2x2, 5+=grid
    const cols = viewCount <= 3 ? viewCount : Math.ceil(Math.sqrt(viewCount));
    const rows = Math.ceil(viewCount / cols);

    for (let i = 0; i < viewCount; i++) {
      const view = allViews[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const vw = Math.floor(width / cols);
      const vh = Math.floor(height / rows);
      const vx = col * vw;
      const vy = (rows - 1 - row) * vh; // Flip Y for GL

      // Update projection matrix with correct aspect ratio for this viewport
      const vpAspect = vw / vh;
      mat4.perspective(projectionMatrix, fov, vpAspect, near, far);
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
        hpRenderer.createSnapshotBuffer(view.id, view.colors, view.transparency);
        hasSnapshotBuffer = true;
      }

      // Load centroid data for this view (if snapshot has its own)
      // centroidColors is now RGBA uint8 (alpha packed in)
      if (view.centroidPositions && view.centroidColors) {
        gl.bindBuffer(gl.ARRAY_BUFFER, centroidPositionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, view.centroidPositions, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, centroidColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, view.centroidColors, gl.DYNAMIC_DRAW);
      }

      // Render this viewport - use snapshot buffer if available (no data upload!)
      const snapshotId = hasSnapshotBuffer ? view.id : null;
      renderSingleView(vw, vh, { x: col / cols, y: row / rows, w: 1 / cols, h: 1 / rows }, view.id, view.centroidCount, snapshotId);

      gl.disable(gl.SCISSOR_TEST);
    }

    // Restore projection matrix for full canvas aspect (no need to restore buffer data -
    // live view uses main buffer which wasn't modified if snapshots used their own buffers)
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

    // Render params shared by both render paths
    const renderParams = {
      mvpMatrix,
      viewMatrix,
      modelMatrix,
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
      cameraDistance: radius
    };

    // Render scatter points - use snapshot buffer if available (no data upload!)
    if (snapshotBufferId) {
      hpRenderer.renderWithSnapshot(snapshotBufferId, renderParams);
    } else {
      hpRenderer.render(renderParams);
    }

    // Draw highlights (selection rings) on top of scatter points
    drawHighlights(height);

    // Draw connectivity lines
    drawConnectivityLines(width, height);

    // Draw centroids
    const flags = getViewFlags(vid);
    if (flags.points && numCentroids > 0) {
      drawCentroids(numCentroids, height);
    }
    drawProjectiles(height);
    drawImpactFlashes(height);

    // Update labels
    if (flags.labels) {
      const labels = getLabelsForView(vid);
      if (labels.length) updateCentroidLabelPositions(labels, viewport);
    } else {
      hideLabelsForView(vid);
    }
    updateLabelLayerVisibility();
  }

  // Track if we're generating noise textures
  let noiseGenerationInProgress = false;

  function renderSmoke(width, height) {
    if (!smokeTextureInfo) return;

    // Generate noise textures on first use (lazy initialization with parallel workers)
    if (!cloudNoiseTextures && !noiseGenerationInProgress) {
      noiseGenerationInProgress = true;
      console.log('[Viewer] Generating cloud noise textures (parallel)...');

      // Use async parallel generation (always returns Promise now)
      generateCloudNoiseTextures(gl).then(textures => {
        cloudNoiseTextures = textures;
        noiseGenerationInProgress = false;
        console.log('[Viewer] Cloud noise textures ready');
      }).catch(err => {
        console.error('[Viewer] Failed to generate noise textures:', err);
        noiseGenerationInProgress = false;
      });

      // Show loading state - render simple background
      gl.viewport(0, 0, width, height);
      gl.clearColor(bgColor[0], bgColor[1], bgColor[2], 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    // Still generating - show loading state
    if (!cloudNoiseTextures) {
      gl.viewport(0, 0, width, height);
      gl.clearColor(bgColor[0], bgColor[1], bgColor[2], 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    updateCamera(width, height);
    mat4.multiply(viewProjMatrix, projectionMatrix, viewMatrix);
    const ok = mat4.invert(invViewProjMatrix, viewProjMatrix);
    if (!ok) return;

    gl.disable(gl.DEPTH_TEST);

    // Determine if we need an off-screen render target (any scale != 1.0)
    const needsOffscreen = cloudResolutionScale !== 1.0;
    let targetW = width, targetH = height;
    if (needsOffscreen) {
      ensureSmokeTarget(width, height, cloudResolutionScale);
      targetW = smokeTargetWidth;
      targetH = smokeTargetHeight;
      gl.bindFramebuffer(gl.FRAMEBUFFER, smokeFramebuffer);
      gl.viewport(0, 0, targetW, targetH);
      // Clear to transparent for proper blending with grid
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      // Enable blending for smoke to blend with grid behind it
      gl.enable(gl.BLEND);
      // Use premultiplied alpha blend mode (smoke shader outputs premultiplied color)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    gl.useProgram(smokeProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, smokeQuadBuffer);
    gl.enableVertexAttribArray(smokeAttribLocations.position);
    gl.vertexAttribPointer(smokeAttribLocations.position, 2, gl.FLOAT, false, 0, 0);

    // Camera and volume uniforms
    gl.uniformMatrix4fv(smokeUniformLocations.invViewProj, false, invViewProjMatrix);
    gl.uniform3fv(smokeUniformLocations.cameraPos, eye);
    gl.uniform3fv(smokeUniformLocations.volumeMin, volumeMin);
    gl.uniform3fv(smokeUniformLocations.volumeMax, volumeMax);
    gl.uniform1f(smokeUniformLocations.gridSize, smokeTextureInfo.gridSize);

    // Colors and lighting
    gl.uniform3fv(smokeUniformLocations.bgColor, bgColor);
    gl.uniform3fv(smokeUniformLocations.smokeColor, smokeColor);
    gl.uniform3fv(smokeUniformLocations.lightDir, lightDir);

    // Animation and quality parameters
    const timeSeconds = (performance.now() - startTime) * 0.001;
    gl.uniform1f(smokeUniformLocations.time, timeSeconds);
    gl.uniform1f(smokeUniformLocations.animationSpeed, smokeAnimationSpeed);
    gl.uniform1f(smokeUniformLocations.densityMultiplier, smokeDensity);
    gl.uniform1f(smokeUniformLocations.stepMultiplier, smokeStepMultiplier);
    gl.uniform1f(smokeUniformLocations.noiseScale, smokeNoiseScale);
    gl.uniform1f(smokeUniformLocations.warpStrength, smokeWarpStrength);
    gl.uniform1f(smokeUniformLocations.detailLevel, smokeDetailLevel);
    gl.uniform1f(smokeUniformLocations.lightAbsorption, smokeLightAbsorption);
    gl.uniform1f(smokeUniformLocations.scatterStrength, smokeScatterStrength);
    gl.uniform1f(smokeUniformLocations.edgeSoftness, smokeEdgeSoftness);
    gl.uniform1f(smokeUniformLocations.directLight, smokeDirectLight);
    gl.uniform1i(smokeUniformLocations.lightSamples, smokeLightSamples);

    // Blue noise offset for temporal jittering (R2 sequence for better distribution)
    frameIndex++;
    const phi = 1.618033988749895;  // Golden ratio
    const blueNoiseOffsetX = ((frameIndex * phi) % 1.0) * 128.0;
    const blueNoiseOffsetY = ((frameIndex * phi * phi) % 1.0) * 128.0;
    gl.uniform2f(smokeUniformLocations.blueNoiseOffset, blueNoiseOffsetX, blueNoiseOffsetY);

    // Bind textures
    // Texture unit 0: Density volume (3D texture)
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, smokeTextureInfo.texture);
    gl.uniform1i(smokeUniformLocations.densityTex3D, 0);

    // Texture unit 1: Shape noise (3D texture)
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, cloudNoiseTextures.shape);
    gl.uniform1i(smokeUniformLocations.shapeNoise, 1);

    // Texture unit 2: Detail noise (3D texture)
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, cloudNoiseTextures.detail);
    gl.uniform1i(smokeUniformLocations.detailNoise, 2);

    // Texture unit 3: Blue noise (2D texture)
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, cloudNoiseTextures.blueNoise);
    gl.uniform1i(smokeUniformLocations.blueNoise, 3);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (needsOffscreen) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      // Enable blending for composite pass to blend with grid
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(compositeProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, smokeQuadBuffer);
      gl.enableVertexAttribArray(compositeAttribLocations.position);
      gl.vertexAttribPointer(compositeAttribLocations.position, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, smokeColorTex);
      gl.uniform1i(compositeUniformLocations.smokeTex, 0);
      gl.uniform2f(compositeUniformLocations.inverseResolution, 1 / targetW, 1 / targetH);
      gl.uniform1f(compositeUniformLocations.intensity, 1.0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // Restore default blend mode and re-enable depth test
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
  }

  function setBackground(mode) {
    showGrid = false;
    switch (mode) {
      case 'grid':
        showGrid = true;
        gl.clearColor(1, 1, 1, 1);
        document.body.style.backgroundColor = '#ffffff';
        bgColor = [1, 1, 1];
        fogColor = [1, 1, 1];
        gridColor = [0.7, 0.7, 0.7];
        gridBgColor = [0.97, 0.97, 0.97];
        gridSpacing = 0.2;
        gridLineWidth = 0.006;
        gridOpacity = 0.55;
        break;
      case 'light':
        gl.clearColor(0.96, 0.96, 0.98, 1);
        document.body.style.backgroundColor = '#f5f5fa';
        bgColor = [0.96, 0.96, 0.98];
        fogColor = [0.96, 0.96, 0.98];
        break;
      case 'dark':
        gl.clearColor(0.08, 0.09, 0.12, 1);
        document.body.style.backgroundColor = '#111319';
        bgColor = [0.08, 0.09, 0.12];
        fogColor = [0.08, 0.09, 0.12];
        break;
      case 'black':
        gl.clearColor(0, 0, 0, 1);
        document.body.style.backgroundColor = '#000000';
        bgColor = [0, 0, 0];
        fogColor = [0.05, 0.05, 0.08];
        break;
      case 'white':
      default:
        gl.clearColor(1, 1, 1, 1);
        document.body.style.backgroundColor = '#ffffff';
        bgColor = [1, 1, 1];
        fogColor = [1, 1, 1];
    }
  }

  // === Public API ===
  return {
    setData({ positions, colors, outlierQuantiles, transparency }) {
      pointCount = positions.length / 3;
      positionsArray = positions;
      colorsArray = colors;
      transparencyArray = transparency;
      computePointBoundsFromPositions(positions);

      // Load data into HP renderer (alpha is packed in colors as RGBA uint8)
      hpRenderer.loadData(positions, colors);
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
      if (highlightArray) {
        const positions = hpRenderer.getPositions ? hpRenderer.getPositions() : null;
        rebuildHighlightBuffer(highlightArray, positions, transparencyArray);
      }
    },

    updateOutlierQuantiles(outliers) {
      // HP renderer doesn't use outlier quantiles directly
      // Filtering should be done via transparency array
    },

    updateHighlight(highlightData) {
      highlightArray = highlightData;
      // Rebuild highlight buffer using current positions and transparency from HP renderer
      const positions = hpRenderer.getPositions ? hpRenderer.getPositions() : null;
      rebuildHighlightBuffer(highlightData, positions, transparencyArray);
    },

    setHighlightStyle(options = {}) {
      if (options.color) highlightColor = options.color;
      if (options.scale != null) highlightScale = options.scale;
      if (options.ringWidth != null) highlightRingWidth = options.ringWidth;
      if (options.haloStrength != null) highlightHaloStrength = options.haloStrength;
      if (options.haloShape != null) highlightHaloShape = options.haloShape;
    },

    getHighlightedCount() {
      return highlightPointCount;
    },

    // Cell selection/picking API
    pickCellAtScreen(screenX, screenY) {
      return pickCellAtScreen(screenX, screenY);
    },

    setCellSelectionCallback(callback) {
      cellSelectionCallback = callback;
    },

    setCellSelectionEnabled(enabled) {
      cellSelectionEnabled = enabled;
    },

    getCellSelectionEnabled() {
      return cellSelectionEnabled;
    },

    setSelectionPreviewCallback(callback) {
      selectionPreviewCallback = callback;
    },

    setHighlightMode(mode) {
      // mode: 'none', 'categorical', or 'continuous'
      highlightMode = mode || 'none';
      // Abort any in-progress selection when mode changes
      selectionDragStart = null;
      selectionDragCurrent = null;
      // Clear any stale selection classes (CSS !important would override cursor)
      canvas.classList.remove('selecting');
      canvas.classList.remove('selecting-continuous');
      // Update canvas classes for styling
      if (highlightMode === 'continuous') {
        canvas.classList.add('highlight-continuous');
        canvas.classList.remove('highlight-categorical');
      } else if (highlightMode === 'categorical') {
        canvas.classList.add('highlight-categorical');
        canvas.classList.remove('highlight-continuous');
      } else {
        canvas.classList.remove('highlight-categorical');
        canvas.classList.remove('highlight-continuous');
      }
      // Update cursor based on current Alt key state
      updateCursorForHighlightMode();
    },

    getHighlightMode() {
      return highlightMode;
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
      const next = mode === 'free' ? 'free' : 'orbit';
      if (next === navigationMode) return;
      if (next === 'free') {
        // Ensure orbit state is synced before switching
        const width = canvas.clientWidth || canvas.width || 1;
        const height = canvas.clientHeight || canvas.height || 1;
        updateCamera(width, height);
        syncFreeflyFromOrbit();
        navigationMode = 'free';
        canvas.classList.add('free-nav');
        canvas.style.cursor = pointerLockActive ? 'none' : 'crosshair';
        velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
        activeKeys.clear();
        if (pointerLockEnabled && canvas.requestPointerLock) {
          canvas.requestPointerLock();
        }
      } else {
        navigationMode = 'orbit';
        syncOrbitFromFreefly();
        canvas.classList.remove('free-nav');
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
    setProjectilesEnabled(enabled) { projectilesEnabled = !!enabled; },

    setSmokeVolume(volumeDesc) {
      if (!volumeDesc || !volumeDesc.data) { smokeTextureInfo = null; return; }
      if (smokeTextureInfo?.texture) gl.deleteTexture(smokeTextureInfo.texture);
      // Use native 3D texture for high-performance rendering
      smokeTextureInfo = createDensityTexture3D(gl, volumeDesc);
      console.log(`[Viewer] Created 3D density texture (${volumeDesc.gridSize}³)`);
      if (volumeDesc.boundsMin && volumeDesc.boundsMax) {
        vec3.set(volumeMin, ...volumeDesc.boundsMin);
        vec3.set(volumeMax, ...volumeDesc.boundsMax);
      } else {
        vec3.set(volumeMin, -1, -1, -1);
        vec3.set(volumeMax, 1, 1, 1);
      }
    },

    // GPU-accelerated smoke volume building (much faster for large point counts)
    buildSmokeVolumeGPU(positions, options = {}) {
      const volumeDesc = buildDensityVolumeGPU(gl, positions, options);
      this.setSmokeVolume(volumeDesc);
      return volumeDesc;
    },

    setSmokeParams(params) {
      if (!params) return;
      if (typeof params.density === 'number') smokeDensity = params.density;
      if (typeof params.noiseScale === 'number') smokeNoiseScale = params.noiseScale;
      if (typeof params.warpStrength === 'number') smokeWarpStrength = params.warpStrength;
      if (typeof params.stepMultiplier === 'number') smokeStepMultiplier = params.stepMultiplier;
      if (typeof params.animationSpeed === 'number') smokeAnimationSpeed = params.animationSpeed;
      if (typeof params.detailLevel === 'number') smokeDetailLevel = params.detailLevel;
      if (typeof params.lightAbsorption === 'number') smokeLightAbsorption = params.lightAbsorption;
      if (typeof params.scatterStrength === 'number') smokeScatterStrength = params.scatterStrength;
      if (typeof params.edgeSoftness === 'number') smokeEdgeSoftness = params.edgeSoftness;
      if (typeof params.directLightIntensity === 'number') smokeDirectLight = Math.max(0.0, Math.min(2.0, params.directLightIntensity));
      if (typeof params.lightSamples === 'number') smokeLightSamples = Math.max(1, Math.min(12, params.lightSamples));
    },

    // Cloud resolution scale: 0.25 to 2.0 (1.0 = full res, 0.5 = half res)
    setCloudResolutionScale(scale) {
      cloudResolutionScale = Math.max(0.25, Math.min(2.0, scale));
      // Force framebuffer recreation on next render
      smokeTargetWidth = 0;
      smokeTargetHeight = 0;
    },
    getCloudResolutionScale() { return cloudResolutionScale; },

    // Noise texture resolution (regenerates noise textures)
    setNoiseTextureResolution(size) {
      const prevScale = getResolutionScaleFactor();
      const newSize = Math.max(32, Math.min(256, size));
      if (newSize !== cloudNoiseResolution) {
        cloudNoiseResolution = newSize;
        setNoiseResolution(newSize, newSize);
        const newScale = getResolutionScaleFactor();
        // Keep perceived noise scale stable as resolution changes
        smokeNoiseScale *= newScale / prevScale;
        // Trigger regeneration on next render
        if (cloudNoiseTextures) {
          // Clean up old textures
          if (cloudNoiseTextures.shape) gl.deleteTexture(cloudNoiseTextures.shape);
          if (cloudNoiseTextures.detail) gl.deleteTexture(cloudNoiseTextures.detail);
          if (cloudNoiseTextures.blueNoise) gl.deleteTexture(cloudNoiseTextures.blueNoise);
          cloudNoiseTextures = null;
        }
        console.log(`[Viewer] Noise resolution changed to ${newSize}³, will regenerate`);
      }
    },
    getNoiseTextureResolution() { return cloudNoiseResolution; },

    // Get adaptive scale factor for UI sliders (based on noise resolution)
    getAdaptiveScaleFactor() { return getResolutionScaleFactor(); },

    // Backwards compatibility: setSmokeHalfResolution maps to cloudResolutionScale
    setSmokeHalfResolution(enabled) {
      cloudResolutionScale = enabled ? 0.5 : 1.0;
      smokeTargetWidth = 0;
      smokeTargetHeight = 0;
    },

    // Cloud quality presets
    setSmokeQualityPreset(preset) {
      switch (preset) {
        case 'performance':
          smokeStepMultiplier = 0.6;
          smokeDetailLevel = 1.0;
          smokeLightSamples = 3;
          cloudResolutionScale = 0.5;
          break;
        case 'balanced':
          smokeStepMultiplier = 1.0;
          smokeDetailLevel = 2.0;
          smokeLightSamples = 6;
          cloudResolutionScale = 0.5;
          break;
        case 'quality':
          smokeStepMultiplier = 1.5;
          smokeDetailLevel = 3.0;
          smokeLightSamples = 8;
          cloudResolutionScale = 1.0;
          break;
        case 'ultra':
          smokeStepMultiplier = 2.0;
          smokeDetailLevel = 4.0;
          smokeLightSamples = 12;
          cloudResolutionScale = 1.0;
          break;
      }
      // Force framebuffer recreation
      smokeTargetWidth = 0;
      smokeTargetHeight = 0;
    },

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
      projectiles.length = 0;
      impactFlashes.length = 0;
      projectileBufferDirty = true;
      impactBufferDirty = true;
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
        const next = camState.navigationMode === 'free' ? 'free' : 'orbit';
        navigationMode = next;
        if (next === 'free') {
          canvas.classList.add('free-nav');
        } else {
          canvas.classList.remove('free-nav');
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

    setViewFocusHandler(fn) { viewFocusHandler = typeof fn === 'function' ? fn : null; },
    setLiveViewLabel(label) { liveViewLabel = label || 'Live view'; },

    // Snapshot API - stores view configs for multiview
    createSnapshotView(config) {
      if (snapshotViews.length >= MAX_SNAPSHOTS) return null;
      const id = `snap_${nextSnapshotId++}`;
      const snapshot = {
        id,
        label: config.label || `View ${snapshotViews.length + 1}`,
        fieldKey: config.fieldKey,
        fieldKind: config.fieldKind,
        colors: config.colors ? new Uint8Array(config.colors) : null, // RGBA uint8
        transparency: config.transparency ? new Float32Array(config.transparency) : null,
        outlierQuantiles: config.outlierQuantiles ? new Float32Array(config.outlierQuantiles) : null,
        centroidPositions: config.centroidPositions ? new Float32Array(config.centroidPositions) : null,
        centroidColors: config.centroidColors ? new Uint8Array(config.centroidColors) : null, // RGBA uint8
        centroidOutliers: config.centroidOutliers ? new Float32Array(config.centroidOutliers) : null,
        outlierThreshold: config.outlierThreshold ?? 1.0,
        meta: config.meta || {}
      };
      snapshotViews.push(snapshot);

      // Create GPU buffer for this snapshot (uploaded once, not per-frame)
      if (snapshot.colors && hpRenderer) {
        hpRenderer.createSnapshotBuffer(id, snapshot.colors, snapshot.transparency);
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
        }
        snapshotViews.splice(idx, 1);
        const key = String(id);
        if (key !== LIVE_VIEW_ID) {
          removeLabelsForView(key);
          viewCentroidFlags.delete(key);
        }
        if (focusedViewId === id) focusedViewId = LIVE_VIEW_ID;
        updateLabelLayerVisibility();
      }
    },

    clearSnapshotViews() {
      // Delete all snapshot GPU buffers
      if (hpRenderer) {
        hpRenderer.deleteAllSnapshotBuffers();
      }
      snapshotViews.length = 0;
      focusedViewId = LIVE_VIEW_ID;
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
      if (activeId) {
        focusedViewId = activeId;
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
      applyHighlightStyleForQuality(currentShaderQuality);
      hpRenderer.setQuality(currentShaderQuality);
    },
    setFrustumCulling(enabled) { hpRenderer.setFrustumCulling(enabled); },
    setAdaptiveLOD(enabled) { hpRenderer.setAdaptiveLOD(enabled); },
    setForceLOD(level) { hpRenderer.setForceLOD(level); },
    getRendererStats() { return hpRenderer.getStats(); },

    // LOD visibility for edge filtering
    getLodVisibilityArray() { return hpRenderer.getLodVisibilityArray(); },
    getCurrentLODLevel() { return hpRenderer.getCurrentLODLevel(); },

    start() {
      if (!animationHandle) animationHandle = requestAnimationFrame(render);
    }
  };
}
