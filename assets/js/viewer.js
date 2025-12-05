/**
 * WebGL2 Viewer with High-Performance Renderer
 * =============================================
 * Uses HighPerfRenderer for scatter points with WebGL2 only.
 * Keeps smoke, grid, and line rendering.
 */

import { LINE_VS_SOURCE, LINE_FS_SOURCE, GRID_VS_SOURCE, GRID_FS_SOURCE } from './shaders.js';
import { createProgram, resizeCanvasToDisplaySize } from './gl-utils.js';
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

// Simple centroid shader (WebGL2) - for small number of centroid points
const CENTROID_VS = `#version 300 es
precision highp float;

in vec3 a_position;
in vec3 a_color;
in float a_alpha;

uniform mat4 u_mvpMatrix;
uniform float u_pointSize;

out vec3 v_color;
out float v_alpha;

void main() {
  gl_Position = u_mvpMatrix * vec4(a_position, 1.0);
  gl_PointSize = u_pointSize;
  if (a_alpha < 0.01) gl_PointSize = 0.0;
  v_color = a_color;
  v_alpha = a_alpha;
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

  const mat4 = glMatrix.mat4;
  const vec3 = glMatrix.vec3;
  const vec4 = glMatrix.vec4;

  // === HIGH-PERFORMANCE RENDERER FOR SCATTER POINTS ===
  const hpRenderer = new HighPerfRenderer(gl, {
    USE_LOD: true,
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

  // === LINE PROGRAM ===
  const lineProgram = createProgram(gl, LINE_VS_SOURCE, LINE_FS_SOURCE);
  const lineAttribLocations = {
    position: gl.getAttribLocation(lineProgram, 'a_position'),
    otherPosition: gl.getAttribLocation(lineProgram, 'a_otherPosition'),
    side: gl.getAttribLocation(lineProgram, 'a_side'),
  };
  const lineUniformLocations = {
    mvpMatrix:    gl.getUniformLocation(lineProgram, 'u_mvpMatrix'),
    viewMatrix:   gl.getUniformLocation(lineProgram, 'u_viewMatrix'),
    modelMatrix:  gl.getUniformLocation(lineProgram, 'u_modelMatrix'),
    lineColor:    gl.getUniformLocation(lineProgram, 'u_lineColor'),
    lineAlpha:    gl.getUniformLocation(lineProgram, 'u_lineAlpha'),
    lineWidth:    gl.getUniformLocation(lineProgram, 'u_lineWidth'),
    viewportSize: gl.getUniformLocation(lineProgram, 'u_viewportSize'),
    fogDensity:   gl.getUniformLocation(lineProgram, 'u_fogDensity'),
    fogNearMean:  gl.getUniformLocation(lineProgram, 'u_fogNearMean'),
    fogFarMean:   gl.getUniformLocation(lineProgram, 'u_fogFarMean'),
    fogColor:     gl.getUniformLocation(lineProgram, 'u_fogColor'),
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
    color: gl.getAttribLocation(centroidProgram, 'a_color'),
    alpha: gl.getAttribLocation(centroidProgram, 'a_alpha'),
  };
  const centroidUniformLocations = {
    mvpMatrix: gl.getUniformLocation(centroidProgram, 'u_mvpMatrix'),
    pointSize: gl.getUniformLocation(centroidProgram, 'u_pointSize'),
  };

  // === BUFFERS ===
  // Centroid buffers (small count, separate from main points)
  const centroidPositionBuffer = gl.createBuffer();
  const centroidColorBuffer = gl.createBuffer();
  const centroidAlphaBuffer = gl.createBuffer();

  // Edge buffer for connectivity lines
  const edgeStripBuffer = gl.createBuffer();

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
  mat4.identity(modelMatrix);

  const tempVec4 = vec4.create();
  const lightDir = vec3.normalize(vec3.create(), [0.5, 0.7, 0.5]);

  let positionsArray = null;
  let colorsArray = null;
  let transparencyArray = null;
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
  let edgeCount = 0;
  let edgeStripVertexCount = 0;
  let edgeIndicesArray = null;
  let showConnectivity = false;
  let connectivityLineWidth = 1.0;
  let connectivityAlpha = 0.15;
  const connectivityColor = vec3.fromValues(0.3, 0.3, 0.3);
  const EDGE_STRIDE_BYTES = 7 * 4;
  const EDGE_OTHER_OFFSET = 3 * 4;
  const EDGE_SIDE_OFFSET = 6 * 4;

  // Camera
  const near = 0.1;
  const far = 1000.0;
  const fov = 45 * Math.PI / 180;

  let basePointSize = 5.0;
  let lightingStrength = 0.6;
  let fogDensity = 0.5;
  let sizeAttenuation = 0.0;
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

  let isDragging = false;
  let dragMode = 'rotate';
  let lastX = 0;
  let lastY = 0;
  let targetRadius = radius;
  let lastTouchDist = 0;
  let animationHandle = null;

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

  // === Event Listeners ===
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); return false; });

  canvas.addEventListener('mousedown', (e) => {
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

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      const timeDelta = performance.now() - lastMoveTime;
      if (timeDelta < 50 && (Math.abs(lastDx) > 0.5 || Math.abs(lastDy) > 0.5)) {
        const rotateSpeed = 0.005;
        if (dragMode === 'rotate') {
          velocityTheta = -lastDx * rotateSpeed * 0.5;
          velocityPhi = -lastDy * rotateSpeed * 0.5;
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
    canvas.style.cursor = 'grab';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastDx = dx * VELOCITY_SMOOTHING + lastDx * (1 - VELOCITY_SMOOTHING);
    lastDy = dy * VELOCITY_SMOOTHING + lastDy * (1 - VELOCITY_SMOOTHING);
    lastMoveTime = performance.now();
    const rotateSpeed = 0.005;

    if (dragMode === 'rotate') {
      theta -= dx * rotateSpeed;
      phi -= dy * rotateSpeed;
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
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 16;
    else if (e.deltaMode === 2) delta *= 100;
    delta = Math.max(-100, Math.min(100, delta));
    const sensitivity = 0.001 * targetRadius;
    targetRadius += delta * sensitivity;
    targetRadius = Math.max(0.1, Math.min(100.0, targetRadius));
  }, { passive: false });

  // Touch events
  canvas.addEventListener('touchstart', (e) => {
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
    e.preventDefault();
    if (e.touches.length === 1 && isDragging) {
      const dx = e.touches[0].clientX - lastX;
      const dy = e.touches[0].clientY - lastY;
      lastDx = dx * VELOCITY_SMOOTHING + lastDx * (1 - VELOCITY_SMOOTHING);
      lastDy = dy * VELOCITY_SMOOTHING + lastDy * (1 - VELOCITY_SMOOTHING);
      lastMoveTime = performance.now();
      const rotateSpeed = 0.005;
      theta -= dx * rotateSpeed;
      phi -= dy * rotateSpeed;
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
        targetRadius = Math.max(0.1, Math.min(100.0, targetRadius));
      }
      lastTouchDist = dist;
    }
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    if (isDragging && e.touches.length === 0) {
      const timeDelta = performance.now() - lastMoveTime;
      if (timeDelta < 50 && (Math.abs(lastDx) > 0.5 || Math.abs(lastDy) > 0.5)) {
        velocityTheta = -lastDx * 0.005 * 0.5;
        velocityPhi = -lastDy * 0.005 * 0.5;
      }
    }
    isDragging = false;
    lastTouchDist = 0;
  });

  // === Helper Functions ===
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
    eye[0] = target[0] + radius * Math.sin(phi) * Math.cos(theta);
    eye[1] = target[1] + radius * Math.cos(phi);
    eye[2] = target[2] + radius * Math.sin(phi) * Math.sin(theta);
    mat4.lookAt(viewMatrix, eye, target, up);
  }

  function computeFogAnchors() {
    fogNearMean = Math.max(0, radius - 2);
    fogFarMean = radius + 2;
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

  function rebuildEdgeStripBuffer() {
    if (!edgeIndicesArray || !positionsArray) {
      edgeStripVertexCount = 0;
      return;
    }
    const numEdges = edgeIndicesArray.length / 2;
    if (numEdges === 0) {
      edgeStripVertexCount = 0;
      return;
    }
    // 6 vertices per edge (2 triangles)
    const data = new Float32Array(numEdges * 6 * 7);
    let offset = 0;
    for (let e = 0; e < numEdges; e++) {
      const i0 = edgeIndicesArray[e * 2];
      const i1 = edgeIndicesArray[e * 2 + 1];
      const x0 = positionsArray[i0 * 3], y0 = positionsArray[i0 * 3 + 1], z0 = positionsArray[i0 * 3 + 2];
      const x1 = positionsArray[i1 * 3], y1 = positionsArray[i1 * 3 + 1], z1 = positionsArray[i1 * 3 + 2];
      // Two triangles forming a quad
      const verts = [
        [x0, y0, z0, x1, y1, z1, -1],
        [x0, y0, z0, x1, y1, z1, 1],
        [x1, y1, z1, x0, y0, z0, -1],
        [x0, y0, z0, x1, y1, z1, 1],
        [x1, y1, z1, x0, y0, z0, -1],
        [x1, y1, z1, x0, y0, z0, 1],
      ];
      for (const v of verts) {
        data[offset++] = v[0]; data[offset++] = v[1]; data[offset++] = v[2];
        data[offset++] = v[3]; data[offset++] = v[4]; data[offset++] = v[5];
        data[offset++] = v[6];
      }
    }
    edgeStripVertexCount = numEdges * 6;
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeStripBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
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
    if (!showConnectivity || edgeCount === 0 || edgeStripVertexCount === 0) return;
    gl.useProgram(lineProgram);
    gl.uniformMatrix4fv(lineUniformLocations.mvpMatrix, false, mvpMatrix);
    gl.uniformMatrix4fv(lineUniformLocations.viewMatrix, false, viewMatrix);
    gl.uniformMatrix4fv(lineUniformLocations.modelMatrix, false, modelMatrix);
    gl.uniform3fv(lineUniformLocations.lineColor, connectivityColor);
    gl.uniform1f(lineUniformLocations.lineAlpha, connectivityAlpha);
    gl.uniform1f(lineUniformLocations.lineWidth, connectivityLineWidth);
    gl.uniform2f(lineUniformLocations.viewportSize, widthPx, heightPx);
    gl.uniform1f(lineUniformLocations.fogDensity, fogDensity);
    gl.uniform1f(lineUniformLocations.fogNearMean, fogNearMean);
    gl.uniform1f(lineUniformLocations.fogFarMean, fogFarMean);
    gl.uniform3fv(lineUniformLocations.fogColor, fogColor);

    gl.bindBuffer(gl.ARRAY_BUFFER, edgeStripBuffer);
    gl.enableVertexAttribArray(lineAttribLocations.position);
    gl.vertexAttribPointer(lineAttribLocations.position, 3, gl.FLOAT, false, EDGE_STRIDE_BYTES, 0);
    gl.enableVertexAttribArray(lineAttribLocations.otherPosition);
    gl.vertexAttribPointer(lineAttribLocations.otherPosition, 3, gl.FLOAT, false, EDGE_STRIDE_BYTES, EDGE_OTHER_OFFSET);
    gl.enableVertexAttribArray(lineAttribLocations.side);
    gl.vertexAttribPointer(lineAttribLocations.side, 1, gl.FLOAT, false, EDGE_STRIDE_BYTES, EDGE_SIDE_OFFSET);
    gl.drawArrays(gl.TRIANGLES, 0, edgeStripVertexCount);
  }

  function drawCentroids(count) {
    const numPoints = count !== undefined ? count : centroidCount;
    if (numPoints === 0) return;
    gl.useProgram(centroidProgram);
    gl.uniformMatrix4fv(centroidUniformLocations.mvpMatrix, false, mvpMatrix);
    // Make centroids stand out by rendering them much larger than regular points
    gl.uniform1f(centroidUniformLocations.pointSize, basePointSize * 4.0);

    gl.bindBuffer(gl.ARRAY_BUFFER, centroidPositionBuffer);
    gl.enableVertexAttribArray(centroidAttribLocations.position);
    gl.vertexAttribPointer(centroidAttribLocations.position, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, centroidColorBuffer);
    gl.enableVertexAttribArray(centroidAttribLocations.color);
    gl.vertexAttribPointer(centroidAttribLocations.color, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, centroidAlphaBuffer);
    gl.enableVertexAttribArray(centroidAttribLocations.alpha);
    gl.vertexAttribPointer(centroidAttribLocations.alpha, 1, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.POINTS, 0, numPoints);
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
    for (const [viewId, labels] of viewCentroidLabels.entries()) {
      const flags = getViewFlags(viewId);
      if (!flags.labels || !labels.length) continue;
      if (labels.some(item => item?.el && item.el.style.display !== 'none')) { anyVisible = true; break; }
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
    updateSmoothZoom();
    updateInertia();

    const [width, height] = resizeCanvasToDisplaySize(canvas);

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
    const allViews = [{
      id: LIVE_VIEW_ID,
      label: liveViewLabel,
      colors: colorsArray,
      transparency: transparencyArray,
      centroidPositions: null, // Use current buffers
      centroidColors: null,
      centroidTransparencies: null,
      centroidCount: centroidCount
    }];
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

    // In single mode or no snapshots, render full screen
    if (viewLayoutMode === 'single' || snapshotViews.length === 0) {
      gl.viewport(0, 0, width, height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      renderSingleView(width, height, { x: 0, y: 0, w: 1, h: 1 });
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

      // Load this view's data into HP renderer
      if (view.colors && view.transparency) {
        hpRenderer.updateColors(view.colors);
        hpRenderer.updateAlphas(view.transparency);
      }

      // Load centroid data for this view (if snapshot has its own)
      if (view.centroidPositions && view.centroidColors && view.centroidTransparencies) {
        gl.bindBuffer(gl.ARRAY_BUFFER, centroidPositionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, view.centroidPositions, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, centroidColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, view.centroidColors, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, centroidAlphaBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, view.centroidTransparencies, gl.DYNAMIC_DRAW);
      }

      // Render this viewport with view-specific centroid count
      renderSingleView(vw, vh, { x: col / cols, y: row / rows, w: 1 / cols, h: 1 / rows }, view.id, view.centroidCount);

      gl.disable(gl.SCISSOR_TEST);
    }

    // Restore projection matrix for full canvas aspect and live view data
    mat4.perspective(projectionMatrix, fov, width / height, near, far);
    mat4.multiply(mvpMatrix, projectionMatrix, viewMatrix);
    mat4.multiply(mvpMatrix, mvpMatrix, modelMatrix);
    if (colorsArray && transparencyArray) {
      hpRenderer.updateColors(colorsArray);
      hpRenderer.updateAlphas(transparencyArray);
    }
  }

  function renderSingleView(width, height, viewport, viewId, overrideCentroidCount) {
    const vid = viewId || focusedViewId || LIVE_VIEW_ID;
    const numCentroids = overrideCentroidCount !== undefined ? overrideCentroidCount : centroidCount;

    // Draw grid first
    drawGrid();

    // Get camera position for HP renderer
    const invView = mat4.create();
    mat4.invert(invView, viewMatrix);
    const cameraPosition = [invView[12], invView[13], invView[14]];

    // Render scatter points with HP renderer
    hpRenderer.render({
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
    });

    // Draw connectivity lines
    drawConnectivityLines(width, height);

    // Draw centroids
    const flags = getViewFlags(vid);
    if (flags.points && numCentroids > 0) {
      drawCentroids(numCentroids);
    }

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

      // Load data into HP renderer
      hpRenderer.loadData(positions, colors, transparency);

      // Rebuild edge buffer if edges exist
      if (edgeCount > 0 && edgeIndicesArray) rebuildEdgeStripBuffer();
    },

    updateColors(colors) {
      colorsArray = colors;
      hpRenderer.updateColors(colors);
    },

    updateTransparency(alphaArray) {
      transparencyArray = alphaArray;
      hpRenderer.updateAlphas(alphaArray);
    },

    updateOutlierQuantiles(outliers) {
      // HP renderer doesn't use outlier quantiles directly
      // Filtering should be done via transparency array
    },

    setCentroids({ positions, colors, outlierQuantiles, transparency }) {
      centroidCount = positions ? positions.length / 3 : 0;
      gl.bindBuffer(gl.ARRAY_BUFFER, centroidPositionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, positions || new Float32Array(), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, centroidColorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, colors || new Float32Array(), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, centroidAlphaBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, transparency || new Float32Array(), gl.STATIC_DRAW);
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

    setConnectivityEdges(edgeIndices) {
      if (!edgeIndices || edgeIndices.length === 0) {
        edgeCount = 0;
        edgeStripVertexCount = 0;
        edgeIndicesArray = null;
        return;
      }
      edgeIndicesArray = edgeIndices instanceof Uint32Array ? edgeIndices : new Uint32Array(edgeIndices);
      edgeCount = edgeIndicesArray.length / 2;
      rebuildEdgeStripBuffer();
    },

    setShowConnectivity(show) { showConnectivity = !!show; },
    getShowConnectivity() { return showConnectivity; },
    setConnectivityLineWidth(width) { connectivityLineWidth = Math.max(0.1, Math.min(10, width)); },
    getConnectivityLineWidth() { return connectivityLineWidth; },
    setConnectivityAlpha(alpha) { connectivityAlpha = Math.max(0.01, Math.min(1, alpha)); },
    getConnectivityAlpha() { return connectivityAlpha; },
    setConnectivityColor(r, g, b) { connectivityColor[0] = r; connectivityColor[1] = g; connectivityColor[2] = b; },
    getConnectivityColor() { return [connectivityColor[0], connectivityColor[1], connectivityColor[2]]; },
    hasConnectivityData() { return edgeCount > 0; },
    getEdgeCount() { return edgeCount; },

    resetCamera() {
      velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
      radius = targetRadius = 3.0;
      theta = phi = Math.PI / 4;
      vec3.set(target, 0, 0, 0);
    },

    stopInertia() {
      velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;
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
        colors: config.colors ? new Float32Array(config.colors) : null,
        transparency: config.transparency ? new Float32Array(config.transparency) : null,
        outlierQuantiles: config.outlierQuantiles ? new Float32Array(config.outlierQuantiles) : null,
        centroidPositions: config.centroidPositions ? new Float32Array(config.centroidPositions) : null,
        centroidColors: config.centroidColors ? new Float32Array(config.centroidColors) : null,
        centroidOutliers: config.centroidOutliers ? new Float32Array(config.centroidOutliers) : null,
        centroidTransparencies: config.centroidTransparencies ? new Float32Array(config.centroidTransparencies) : null,
        outlierThreshold: config.outlierThreshold ?? 1.0,
        meta: config.meta || {}
      };
      snapshotViews.push(snapshot);
      return { id, label: snapshot.label };
    },

    updateSnapshotAttributes(id, attrs) {
      const snap = snapshotViews.find(s => s.id === id);
      if (!snap) return false;
      if (attrs.colors) snap.colors = new Float32Array(attrs.colors);
      if (attrs.transparency) snap.transparency = new Float32Array(attrs.transparency);
      if (attrs.outlierQuantiles) snap.outlierQuantiles = new Float32Array(attrs.outlierQuantiles);
      if (attrs.centroidPositions) snap.centroidPositions = new Float32Array(attrs.centroidPositions);
      if (attrs.centroidColors) snap.centroidColors = new Float32Array(attrs.centroidColors);
      if (attrs.centroidOutliers) snap.centroidOutliers = new Float32Array(attrs.centroidOutliers);
      if (attrs.centroidTransparencies) snap.centroidTransparencies = new Float32Array(attrs.centroidTransparencies);
      if (typeof attrs.outlierThreshold === 'number') snap.outlierThreshold = attrs.outlierThreshold;
      if (attrs.label) snap.label = attrs.label;
      if (attrs.meta) snap.meta = { ...snap.meta, ...attrs.meta };
      // If this is the focused view in single mode, update HP renderer
      if (viewLayoutMode === 'single' && focusedViewId === id) {
        if (snap.colors) hpRenderer.updateColors(snap.colors);
        if (snap.transparency) hpRenderer.updateAlphas(snap.transparency);
      }
      return true;
    },

    removeSnapshotView(id) {
      const idx = snapshotViews.findIndex(s => s.id === id);
      if (idx >= 0) {
        snapshotViews.splice(idx, 1);
        if (focusedViewId === id) focusedViewId = LIVE_VIEW_ID;
      }
    },

    clearSnapshotViews() {
      snapshotViews.length = 0;
      focusedViewId = LIVE_VIEW_ID;
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
    },

    getViewLayout() { return { mode: viewLayoutMode, activeId: focusedViewId }; },

    getGLContext() { return gl; },
    isWebGL2() { return true; },

    getRenderState() {
      const [width, height] = resizeCanvasToDisplaySize(canvas);
      updateCamera(width, height);
      mat4.multiply(mvpMatrix, projectionMatrix, viewMatrix);
      mat4.multiply(mvpMatrix, mvpMatrix, modelMatrix);
      const invView = mat4.create();
      mat4.invert(invView, viewMatrix);
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
        cameraDistance: radius
      };
    },

    // HP renderer is always used now, these are no-ops
    setExternalRenderer(renderer) {},
    clearExternalRenderer() {},

    // HP renderer controls
    setShaderQuality(quality) { hpRenderer.setQuality(quality); },
    setFrustumCulling(enabled) { hpRenderer.setFrustumCulling(enabled); },
    setAdaptiveLOD(enabled) { hpRenderer.setAdaptiveLOD(enabled); },
    getRendererStats() { return hpRenderer.getStats(); },

    start() {
      if (!animationHandle) animationHandle = requestAnimationFrame(render);
    }
  };
}
