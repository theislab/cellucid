/**
 * @fileoverview Strikingly beautiful 3D velocity flow visualization.
 *
 * ARCHITECTURE:
 * =============
 * This implements a premium Windy.com-style visualization with:
 *
 * 1. 3D COMET PARTICLES - Velocity-aligned with head-to-tail gradients
 * 2. TEMPORAL PERSISTENCE - Chromatic frame fading for beautiful trails
 * 3. MULTI-LAYER GLOW - Core + inner + outer + ambient glow layers
 * 4. ANAMORPHIC BLOOM - Cinematic horizontal-stretched bloom
 * 5. HDR COMPOSITING - Filmic tone mapping with advanced color grading
 *
 * RENDERING PIPELINE:
 * 1. SIMULATION: Transform feedback advances particles with curl noise
 * 2. FADE: Chromatic multiply of previous frame (differential RGB decay)
 * 3. DRAW: Render velocity-aligned comet particles with layered glow
 * 4. BLOOM: Multi-pass anamorphic bloom for cinematic glow
 * 5. OUTPUT: HDR tone mapping + color grading + film grain
 *
 * @module rendering/overlays/velocity/velocity-overlay
 */

import { OverlayBase } from '../overlay-base.js';
import { createProgram, createTransformFeedbackProgram } from '../../gl-utils.js';
import { getNotificationCenter } from '../../../app/notification-center.js';
import { getColormap } from '../../../data/palettes.js';
import {
  PARTICLE_UPDATE_VS,
  PARTICLE_UPDATE_FS,
  FULLSCREEN_VS,
  TRAIL_FADE_FS,
  PARTICLE_RENDER_VS,
  PARTICLE_RENDER_FS,
  BLUR_FS,
  COMPOSITE_FS,
  THRESHOLD_FS,
  ANAMORPHIC_BLUR_FS
} from './velocity-shaders.js';
import { createOrUpdatePackedFloatTexture, createOrUpdatePackedUintTexture } from '../shared/packed-texture.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = Object.freeze({
  // Particle system
  particleCapacity: 500_000,
  particleCount: 15_000,       // Default to 15K (screenshot value)
  speedMultiplier: 3.0,        // Default to 3.0x (screenshot value)
  lifetime: 8.0,               // Default to 8.0s (screenshot value)

  // Respawn behavior (Windy.com style: slow particles drop faster)
  dropRate: 0.003,
  dropRateBump: 0.015,

  // Organic motion
  turbulence: 0.3,

  // Particle appearance
  particleSize: 1.0,
  minSize: 0.5,
  maxSize: 30.0,
  intensity: 0.25,             // LOW - prevents washout
  glowAmount: 0.3,             // Subtle glow
  coreSharpness: 0.7,
  cometStretch: 0.6,

  // Trail persistence (THE KEY PARAMETER!)
  // Higher = longer trails. 0.92-0.98 is good range.
  trailFade: 0.925,
  trailResolution: 1.0,
  chromaticFade: 0,

  // Camera motion compensation
  // When camera moves, fade trails faster to prevent smearing
  cameraMotionFade: 0.80,
  cameraMotionThreshold: 0.001,

  // HDR & Bloom
  bloomEnabled: true,
  bloomStrength: 0.08,         // VERY subtle bloom
  bloomThreshold: 0.75,        // Higher threshold - only brightest pixels bloom
  bloomBlurSize: 4.0,
  bloomKnee: 0.3,
  anamorphicRatio: 1.2,
  exposure: 0.5,               // LOW exposure - key fix for washout
  contrast: 1.05,
  saturation: 1.15,
  gamma: 1.0,

  // Advanced color grading
  highlights: 0.85,            // Reduce highlights
  shadows: 1.05,
  colorTint: [1.0, 1.0, 1.0],

  // Cinematic effects
  vignette: 0,
  filmGrain: 0,
  chromaticAberration: 0,

  // Output
  opacity: 0.7,                // Slightly higher opacity for visibility

  // Colormap
  colormapId: 'viridis',      // Default to viridis (screenshot value)

  // System
  spawnTableSize: 65_536,
  syncWithLOD: true
});

// Particle data layout: position (vec3) + velocity (vec3) + age (float) + cellIndex (uint)
// = 3 + 3 + 1 + 1 = 8 floats worth (28 bytes with padding)
const FLOATS_PER_PARTICLE = 8;
const BYTES_PER_PARTICLE = FLOATS_PER_PARTICLE * 4;

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampArray(value, fallback) {
  if (!Array.isArray(value) || value.length !== 3) return fallback;
  return value.map((v, i) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : fallback[i];
  });
}

function createRNG(seed) {
  let state = seed >>> 0;
  return {
    next() {
      state ^= (state << 13) >>> 0;
      state ^= (state >>> 17) >>> 0;
      state ^= (state << 5) >>> 0;
      return state >>> 0;
    },
    nextInt(max) {
      return (this.next() % Math.max(1, max | 0)) | 0;
    }
  };
}

// =============================================================================
// VELOCITY OVERLAY CLASS
// =============================================================================

export class VelocityOverlay extends OverlayBase {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {object} [options]
   */
  constructor(gl, options = {}) {
    super(gl, { id: 'velocity', priority: 30, ...options });

    // Configuration
    this.config = {
      particleCapacity: clamp(options.particleCapacity, 1000, 500_000, CONFIG.particleCapacity),
      particleCount: clamp(options.particleCount, 0, 500_000, CONFIG.particleCount),
      speedMultiplier: clamp(options.speedMultiplier, 0.1, 20.0, CONFIG.speedMultiplier),
      lifetime: clamp(options.lifetime, 0.5, 30.0, CONFIG.lifetime),
      dropRate: clamp(options.dropRate, 0.0, 0.1, CONFIG.dropRate),
      dropRateBump: clamp(options.dropRateBump, 0.0, 0.1, CONFIG.dropRateBump),
      turbulence: clamp(options.turbulence, 0.0, 2.0, CONFIG.turbulence),

      particleSize: clamp(options.particleSize, 1.0, 50.0, CONFIG.particleSize),
      minSize: clamp(options.minSize, 0.5, 10.0, CONFIG.minSize),
      maxSize: clamp(options.maxSize, 5.0, 100.0, CONFIG.maxSize),
      intensity: clamp(options.intensity, 0.1, 5.0, CONFIG.intensity),
      glowAmount: clamp(options.glowAmount, 0.0, 1.0, CONFIG.glowAmount),
      coreSharpness: clamp(options.coreSharpness, 0.0, 1.0, CONFIG.coreSharpness),
      cometStretch: clamp(options.cometStretch, 0.0, 2.0, CONFIG.cometStretch),

      trailFade: clamp(options.trailFade, 0.5, 0.999, CONFIG.trailFade),
      trailResolution: clamp(options.trailResolution, 0.25, 2.0, CONFIG.trailResolution),
      chromaticFade: clamp(options.chromaticFade, 0.0, 1.0, CONFIG.chromaticFade),

      cameraMotionFade: clamp(options.cameraMotionFade, 0.5, 1.0, CONFIG.cameraMotionFade),
      cameraMotionThreshold: clamp(options.cameraMotionThreshold, 0.0001, 0.1, CONFIG.cameraMotionThreshold),

      bloomEnabled: options.bloomEnabled !== undefined ? Boolean(options.bloomEnabled) : CONFIG.bloomEnabled,
      bloomStrength: clamp(options.bloomStrength, 0.0, 2.0, CONFIG.bloomStrength),
      bloomThreshold: clamp(options.bloomThreshold, 0.0, 1.0, CONFIG.bloomThreshold),
      bloomBlurSize: clamp(options.bloomBlurSize, 1.0, 16.0, CONFIG.bloomBlurSize),
      bloomKnee: clamp(options.bloomKnee, 0.0, 1.0, CONFIG.bloomKnee),
      anamorphicRatio: clamp(options.anamorphicRatio, 1.0, 3.0, CONFIG.anamorphicRatio),
      exposure: clamp(options.exposure, 0.5, 4.0, CONFIG.exposure),
      contrast: clamp(options.contrast, 0.5, 2.0, CONFIG.contrast),
      saturation: clamp(options.saturation, 0.0, 2.0, CONFIG.saturation),
      gamma: clamp(options.gamma, 0.5, 2.5, CONFIG.gamma),

      highlights: clamp(options.highlights, 0.5, 2.0, CONFIG.highlights),
      shadows: clamp(options.shadows, 0.5, 2.0, CONFIG.shadows),
      colorTint: clampArray(options.colorTint, CONFIG.colorTint),

      vignette: clamp(options.vignette, 0.0, 1.0, CONFIG.vignette),
      filmGrain: clamp(options.filmGrain, 0.0, 0.5, CONFIG.filmGrain),
      chromaticAberration: clamp(options.chromaticAberration, 0.0, 2.0, CONFIG.chromaticAberration),

      opacity: clamp(options.opacity, 0.0, 1.0, CONFIG.opacity),
      colormapId: String(options.colormapId || CONFIG.colormapId),
      spawnTableSize: clamp(options.spawnTableSize, 1024, 1_048_576, CONFIG.spawnTableSize),
      syncWithLOD: options.syncWithLOD !== undefined ? Boolean(options.syncWithLOD) : CONFIG.syncWithLOD
    };

    // Vector field storage: fieldId -> dimensionLevel -> field data
    this._fieldsById = new Map();
    this._activeFieldId = null;

    // Position texture pool (shared across views)
    this._positionTexturePool = new Map();
    this._positionsRefByView = new Map();

    // Spawn table per view
    this._spawnByView = new Map();

    // Shader programs
    this._programUpdate = null;
    this._programRender = null;
    this._programFade = null;
    this._programThreshold = null;
    this._programBlur = null;
    this._programAnamorphic = null;
    this._programComposite = null;

    // Uniform caches
    this._uniformsUpdate = null;
    this._uniformsRender = null;
    this._uniformsFade = null;
    this._uniformsThreshold = null;
    this._uniformsBlur = null;
    this._uniformsAnamorphic = null;
    this._uniformsComposite = null;

    // Particle buffers (ping-pong for transform feedback)
    this._particleBuffers = [null, null];
    this._particleVAOs = [null, null];
    this._currentBuffer = 0;
    this._activeParticleCount = 0;

    // Transform feedback
    this._transformFeedback = null;

    // Colormap texture
    this._colormapTexture = null;

    // FBOs per view
    this._fboByView = new Map();

    // Texture format detection
    this._floatTextureFormat = null;

    // Empty VAO for fullscreen passes
    this._emptyVAO = null;

    // Camera motion tracking for trail fade compensation
    this._lastCameraPosition = null;
    this._lastViewMatrix = null;
    this._cameraMotionAmount = 0;
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  setActiveField(fieldId) {
    this._activeFieldId = fieldId ? String(fieldId) : null;
  }

  getActiveFieldId() {
    return this._activeFieldId;
  }

  setVectorFieldData(fieldId, dimensionLevel, fieldData) {
    const id = String(fieldId || '');
    if (!id) throw new Error('VelocityOverlay: fieldId required');

    const dim = Math.max(1, Math.min(3, Math.floor(dimensionLevel || 3)));
    const { vectors, components, cellCount, maxMagnitude } = fieldData || {};

    if (!(vectors instanceof Float32Array)) {
      throw new Error('VelocityOverlay: vectors must be Float32Array');
    }
    if (components !== 1 && components !== 2 && components !== 3) {
      throw new Error(`VelocityOverlay: invalid components=${components}`);
    }
    if (!cellCount || cellCount <= 0) {
      throw new Error('VelocityOverlay: cellCount must be > 0');
    }
    if (vectors.length !== cellCount * components) {
      throw new Error(`VelocityOverlay: vectors length mismatch`);
    }

    this.init();

    let perField = this._fieldsById.get(id);
    if (!perField) {
      perField = new Map();
      this._fieldsById.set(id, perField);
    }

    const existing = perField.get(dim);
    const textureInfo = createOrUpdatePackedFloatTexture(this.gl, {
      texture: existing?.texture || null,
      data: vectors,
      itemCount: cellCount,
      components
    });

    perField.set(dim, {
      ...textureInfo,
      cellCount,
      maxMagnitude: Math.max(1e-8, Number(maxMagnitude) || 1)
    });

    if (!this._activeFieldId) {
      this._activeFieldId = id;
    }

    // Mark spawn tables dirty
    for (const state of this._spawnByView.values()) {
      state.dirty = true;
      state.version++;
    }
  }

  hasFieldForDimension(fieldId, dimensionLevel) {
    const id = String(fieldId || '');
    const dim = Math.max(1, Math.min(3, Math.floor(dimensionLevel || 3)));
    return Boolean(this._fieldsById.get(id)?.has(dim));
  }

  markVisibilityDirty(viewId) {
    const key = String(viewId || 'live');
    const state = this._spawnByView.get(key);
    if (state) {
      state.dirty = true;
      state.version++;
    }
  }

  disposeView(viewId) {
    const key = String(viewId || 'live');
    const gl = this.gl;

    // Clean spawn table
    const spawn = this._spawnByView.get(key);
    if (spawn?.textureInfo?.texture) {
      gl.deleteTexture(spawn.textureInfo.texture);
    }
    this._spawnByView.delete(key);

    // Clean position texture ref
    const posRef = this._positionsRefByView.get(key);
    if (posRef) {
      this._releasePositionTexture(posRef);
    }
    this._positionsRefByView.delete(key);

    // Clean FBOs
    this._disposeFBOs(key);
  }

  setConfig(key, value) {
    if (!key) return;
    this.init();

    const cfg = this.config;
    switch (key) {
      case 'particleCount':
        cfg.particleCount = clamp(value, 0, cfg.particleCapacity, cfg.particleCount);
        break;
      case 'speedMultiplier':
        cfg.speedMultiplier = clamp(value, 0.1, 20.0, cfg.speedMultiplier);
        break;
      case 'lifetime':
        cfg.lifetime = clamp(value, 0.5, 30.0, cfg.lifetime);
        break;
      case 'dropRate':
        cfg.dropRate = clamp(value, 0.0, 0.1, cfg.dropRate);
        break;
      case 'dropRateBump':
        cfg.dropRateBump = clamp(value, 0.0, 0.1, cfg.dropRateBump);
        break;
      case 'turbulence':
        cfg.turbulence = clamp(value, 0.0, 2.0, cfg.turbulence);
        break;
      case 'particleSize':
        cfg.particleSize = clamp(value, 1.0, 50.0, cfg.particleSize);
        break;
      case 'minSize':
        cfg.minSize = clamp(value, 0.5, 10.0, cfg.minSize);
        break;
      case 'maxSize':
        cfg.maxSize = clamp(value, 5.0, 100.0, cfg.maxSize);
        break;
      case 'intensity':
        cfg.intensity = clamp(value, 0.1, 5.0, cfg.intensity);
        break;
      case 'glowAmount':
        cfg.glowAmount = clamp(value, 0.0, 1.0, cfg.glowAmount);
        break;
      case 'coreSharpness':
        cfg.coreSharpness = clamp(value, 0.0, 1.0, cfg.coreSharpness);
        break;
      case 'cometStretch':
        cfg.cometStretch = clamp(value, 0.0, 2.0, cfg.cometStretch);
        break;
      case 'trailFade':
        cfg.trailFade = clamp(value, 0.5, 0.999, cfg.trailFade);
        break;
      case 'trailResolution':
        cfg.trailResolution = clamp(value, 0.25, 2.0, cfg.trailResolution);
        for (const k of this._fboByView.keys()) this._disposeFBOs(k);
        break;
      case 'chromaticFade':
        cfg.chromaticFade = clamp(value, 0.0, 1.0, cfg.chromaticFade);
        break;
      case 'cameraMotionFade':
        cfg.cameraMotionFade = clamp(value, 0.5, 1.0, cfg.cameraMotionFade);
        break;
      case 'cameraMotionThreshold':
        cfg.cameraMotionThreshold = clamp(value, 0.0001, 0.1, cfg.cameraMotionThreshold);
        break;
      case 'bloomEnabled':
        cfg.bloomEnabled = Boolean(value);
        break;
      case 'bloomStrength':
        cfg.bloomStrength = clamp(value, 0.0, 2.0, cfg.bloomStrength);
        break;
      case 'bloomThreshold':
        cfg.bloomThreshold = clamp(value, 0.0, 1.0, cfg.bloomThreshold);
        break;
      case 'bloomBlurSize':
        cfg.bloomBlurSize = clamp(value, 1.0, 16.0, cfg.bloomBlurSize);
        break;
      case 'bloomKnee':
        cfg.bloomKnee = clamp(value, 0.0, 1.0, cfg.bloomKnee);
        break;
      case 'anamorphicRatio':
        cfg.anamorphicRatio = clamp(value, 1.0, 3.0, cfg.anamorphicRatio);
        break;
      case 'exposure':
        cfg.exposure = clamp(value, 0.5, 4.0, cfg.exposure);
        break;
      case 'contrast':
        cfg.contrast = clamp(value, 0.5, 2.0, cfg.contrast);
        break;
      case 'saturation':
        cfg.saturation = clamp(value, 0.0, 2.0, cfg.saturation);
        break;
      case 'gamma':
        cfg.gamma = clamp(value, 0.5, 2.5, cfg.gamma);
        break;
      case 'highlights':
        cfg.highlights = clamp(value, 0.5, 2.0, cfg.highlights);
        break;
      case 'shadows':
        cfg.shadows = clamp(value, 0.5, 2.0, cfg.shadows);
        break;
      case 'colorTint':
        cfg.colorTint = clampArray(value, cfg.colorTint);
        break;
      case 'vignette':
        cfg.vignette = clamp(value, 0.0, 1.0, cfg.vignette);
        break;
      case 'filmGrain':
        cfg.filmGrain = clamp(value, 0.0, 0.5, cfg.filmGrain);
        break;
      case 'chromaticAberration':
        cfg.chromaticAberration = clamp(value, 0.0, 2.0, cfg.chromaticAberration);
        break;
      case 'opacity':
        cfg.opacity = clamp(value, 0.0, 1.0, cfg.opacity);
        break;
      case 'colormapId':
        cfg.colormapId = String(value || CONFIG.colormapId);
        this._updateColormap();
        break;
      case 'spawnTableSize':
        cfg.spawnTableSize = clamp(value, 1024, 1_048_576, cfg.spawnTableSize);
        for (const s of this._spawnByView.values()) { s.dirty = true; s.version++; }
        break;
      case 'syncWithLOD':
        cfg.syncWithLOD = Boolean(value);
        for (const s of this._spawnByView.values()) { s.dirty = true; s.version++; }
        break;
    }
  }

  // ===========================================================================
  // OVERLAY LIFECYCLE
  // ===========================================================================

  _doInit() {
    const gl = this.gl;

    // Create simulation program with transform feedback
    this._programUpdate = createTransformFeedbackProgram(
      gl,
      PARTICLE_UPDATE_VS,
      PARTICLE_UPDATE_FS,
      ['v_position', 'v_velocity', 'v_age', 'v_cellIndex']
    );

    // Create rendering programs
    this._programRender = createProgram(gl, PARTICLE_RENDER_VS, PARTICLE_RENDER_FS);
    this._programFade = createProgram(gl, FULLSCREEN_VS, TRAIL_FADE_FS);
    this._programThreshold = createProgram(gl, FULLSCREEN_VS, THRESHOLD_FS);
    this._programBlur = createProgram(gl, FULLSCREEN_VS, BLUR_FS);
    this._programAnamorphic = createProgram(gl, FULLSCREEN_VS, ANAMORPHIC_BLUR_FS);
    this._programComposite = createProgram(gl, FULLSCREEN_VS, COMPOSITE_FS);

    this._cacheUniforms();
    this._createParticleBuffers();

    this._transformFeedback = gl.createTransformFeedback();

    this._colormapTexture = gl.createTexture();
    this._updateColormap(true);

    this._emptyVAO = gl.createVertexArray();

    this._bindSamplers();
  }

  _doUpdate(dt, ctx) {
    const dim = Math.max(1, Math.min(3, Math.floor(ctx?.dimensionLevel || 3)));
    const field = this._activeFieldId
      ? this._fieldsById.get(this._activeFieldId)?.get(dim)
      : null;

    if (!field) {
      this.visible = false;
      return;
    }
    this.visible = true;

    // Detect camera motion for trail fade compensation
    this._updateCameraMotion(ctx);

    // LOD-aware particle count
    let targetCount = this.config.particleCount;
    if (this.config.syncWithLOD && typeof ctx?.getLodLevel === 'function') {
      const lod = ctx.getLodLevel();
      if (lod >= 0) {
        const factor = lod >= 6 ? 0 : lod >= 3 ? 0.25 : lod >= 1 ? 0.5 : 1.0;
        targetCount = Math.floor(targetCount * factor);
      }
    }
    this._activeParticleCount = Math.min(targetCount, this.config.particleCapacity);
    if (this._activeParticleCount <= 0) return;

    const viewId = String(ctx?.viewId || 'live');
    const positions = ctx?.getViewPositions?.();
    if (!(positions instanceof Float32Array) || positions.length === 0) return;

    const posTexture = this._ensurePositionTexture(viewId, positions);
    const spawnState = this._ensureSpawnTable(viewId, ctx, field.cellCount);
    if (!spawnState?.textureInfo || spawnState.tableSize <= 0) return;

    this._simulate(dt, ctx, field, posTexture, spawnState);
  }

  _doRender(ctx) {
    const dim = Math.max(1, Math.min(3, Math.floor(ctx?.dimensionLevel || 3)));
    const field = this._activeFieldId
      ? this._fieldsById.get(this._activeFieldId)?.get(dim)
      : null;

    if (!field || this._activeParticleCount <= 0) return;

    const viewId = String(ctx?.viewId || 'live');
    this._renderFlow(ctx, field, viewId);
  }

  _doDispose() {
    const gl = this.gl;

    // Buffers
    for (let i = 0; i < 2; i++) {
      if (this._particleBuffers[i]) gl.deleteBuffer(this._particleBuffers[i]);
      if (this._particleVAOs[i]) gl.deleteVertexArray(this._particleVAOs[i]);
    }
    this._particleBuffers = [null, null];
    this._particleVAOs = [null, null];

    if (this._transformFeedback) gl.deleteTransformFeedback(this._transformFeedback);
    this._transformFeedback = null;

    // Programs
    const programs = [
      '_programUpdate', '_programRender', '_programFade',
      '_programThreshold', '_programBlur', '_programAnamorphic', '_programComposite'
    ];
    for (const name of programs) {
      if (this[name]) gl.deleteProgram(this[name]);
      this[name] = null;
    }

    // Colormap
    if (this._colormapTexture) gl.deleteTexture(this._colormapTexture);
    this._colormapTexture = null;

    // Empty VAO
    if (this._emptyVAO) gl.deleteVertexArray(this._emptyVAO);
    this._emptyVAO = null;

    // Fields
    for (const perField of this._fieldsById.values()) {
      for (const entry of perField.values()) {
        if (entry?.texture) gl.deleteTexture(entry.texture);
      }
    }
    this._fieldsById.clear();
    this._activeFieldId = null;

    // Position textures
    for (const entry of this._positionTexturePool.values()) {
      if (entry?.textureInfo?.texture) gl.deleteTexture(entry.textureInfo.texture);
    }
    this._positionTexturePool.clear();
    this._positionsRefByView.clear();

    // Spawn tables
    for (const state of this._spawnByView.values()) {
      if (state?.textureInfo?.texture) gl.deleteTexture(state.textureInfo.texture);
    }
    this._spawnByView.clear();

    // FBOs
    for (const key of this._fboByView.keys()) {
      this._disposeFBOs(key);
    }
    this._fboByView.clear();
  }

  // ===========================================================================
  // PARTICLE BUFFER MANAGEMENT
  // ===========================================================================

  _createParticleBuffers() {
    const gl = this.gl;
    const capacity = this.config.particleCapacity;
    const bufferSize = capacity * BYTES_PER_PARTICLE;

    // Initialize with expired particles (age = 1.0)
    const initData = new ArrayBuffer(bufferSize);
    const floatView = new Float32Array(initData);
    const uintView = new Uint32Array(initData);

    for (let i = 0; i < capacity; i++) {
      const base = i * FLOATS_PER_PARTICLE;
      // position (0,0,0)
      floatView[base + 0] = 0;
      floatView[base + 1] = 0;
      floatView[base + 2] = 0;
      // velocity (0,0,0)
      floatView[base + 3] = 0;
      floatView[base + 4] = 0;
      floatView[base + 5] = 0;
      // age = 1.0 (expired, will respawn immediately)
      floatView[base + 6] = 1.0;
      // cellIndex = 0
      uintView[base + 7] = 0;
    }

    for (let i = 0; i < 2; i++) {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, initData, gl.DYNAMIC_COPY);
      this._particleBuffers[i] = buffer;

      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

      const stride = BYTES_PER_PARTICLE;

      // location 0: position (vec3)
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);

      // location 1: velocity (vec3)
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);

      // location 2: age (float)
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 24);

      // location 3: cellIndex (uint)
      gl.enableVertexAttribArray(3);
      gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, stride, 28);

      this._particleVAOs[i] = vao;
    }

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  // ===========================================================================
  // GPU SIMULATION
  // ===========================================================================

  _simulate(dt, ctx, field, posTexture, spawnState) {
    const gl = this.gl;

    const readIdx = this._currentBuffer;
    const writeIdx = 1 - readIdx;

    // Bind textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, field.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, posTexture.texture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, spawnState.textureInfo.texture);

    // Set uniforms
    const u = this._uniformsUpdate;
    gl.useProgram(this._programUpdate);
    gl.uniform1f(u.u_dt, dt);
    gl.uniform1f(u.u_time, ctx.time || 0);
    gl.uniform1f(u.u_speedMultiplier, this.config.speedMultiplier);
    gl.uniform1f(u.u_lifetime, this.config.lifetime);
    gl.uniform1f(u.u_dropRate, this.config.dropRate);
    gl.uniform1f(u.u_dropRateBump, this.config.dropRateBump);
    gl.uniform1f(u.u_turbulence, this.config.turbulence);
    gl.uniform1i(u.u_velocityTexWidth, field.width);
    gl.uniform1i(u.u_positionTexWidth, posTexture.width);
    gl.uniform1i(u.u_spawnTableWidth, spawnState.tableWidth);
    gl.uniform1i(u.u_spawnTableSize, spawnState.tableSize);

    // Run transform feedback
    gl.bindVertexArray(this._particleVAOs[readIdx]);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this._transformFeedback);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this._particleBuffers[writeIdx]);

    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, this._activeParticleCount);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);

    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindVertexArray(null);

    this._currentBuffer = writeIdx;
  }

  // ===========================================================================
  // RENDERING PIPELINE
  // ===========================================================================

  _renderFlow(ctx, field, viewId) {
    const gl = this.gl;
    const fbos = this._ensureFBOs(viewId, ctx.viewportWidth, ctx.viewportHeight);
    if (!fbos) return;

    const savedFBO = gl.getParameter(gl.FRAMEBUFFER_BINDING);

    // PASS 1: Chromatic fade previous frame (creates trail persistence)
    this._passFade(fbos);

    // PASS 2: Render particles to trail buffer
    this._passRenderParticles(ctx, field, fbos);

    // PASS 3 & 4: Anamorphic Bloom (if enabled)
    if (this.config.bloomEnabled && this.config.bloomStrength > 0) {
      this._passBloom(fbos);
    }

    // PASS 5: Final composite with HDR and color grading
    gl.bindFramebuffer(gl.FRAMEBUFFER, savedFBO);
    this._passComposite(ctx, fbos);
  }

  _passFade(fbos) {
    const gl = this.gl;

    const readIdx = fbos.trailIdx;
    const writeIdx = 1 - readIdx;

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbos.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbos.trail[writeIdx], 0);

    gl.viewport(0, 0, fbos.width, fbos.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    gl.useProgram(this._programFade);
    // Use dynamic trail fade that adjusts based on camera motion
    gl.uniform1f(this._uniformsFade.u_fadeAmount, this._getEffectiveTrailFade());
    gl.uniform1f(this._uniformsFade.u_chromaticFade, this.config.chromaticFade);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fbos.trail[readIdx]);
    gl.uniform1i(this._uniformsFade.u_previousFrame, 0);

    gl.bindVertexArray(this._emptyVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    fbos.trailIdx = writeIdx;
  }

  _passRenderParticles(ctx, field, fbos) {
    const gl = this.gl;

    // Render to current trail texture
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbos.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbos.trail[fbos.trailIdx], 0);

    gl.viewport(0, 0, fbos.width, fbos.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // Additive blending

    gl.useProgram(this._programRender);
    const u = this._uniformsRender;

    // Matrices
    gl.uniformMatrix4fv(u.u_mvpMatrix, false, ctx.mvpMatrix);
    gl.uniformMatrix4fv(u.u_viewMatrix, false, ctx.viewMatrix);
    gl.uniformMatrix4fv(u.u_modelMatrix, false, ctx.modelMatrix);

    // Camera
    gl.uniform3fv(u.u_cameraPosition, ctx.cameraPosition || [0, 0, 5]);
    gl.uniform1f(u.u_viewportHeight, fbos.height);
    gl.uniform1f(u.u_fov, ctx.fov ?? 1);
    gl.uniform1f(u.u_sizeAttenuation, ctx.sizeAttenuation ?? 1);

    // Particle appearance
    gl.uniform1f(u.u_particleSize, this.config.particleSize * (ctx.devicePixelRatio || 1));
    gl.uniform1f(u.u_minSize, this.config.minSize);
    gl.uniform1f(u.u_maxSize, this.config.maxSize);
    gl.uniform1f(u.u_intensity, this.config.intensity);
    gl.uniform1f(u.u_glowAmount, this.config.glowAmount);
    gl.uniform1f(u.u_coreSharpness, this.config.coreSharpness);
    gl.uniform1f(u.u_cometStretch, this.config.cometStretch);

    // Velocity normalization
    gl.uniform1f(u.u_invMaxMagnitude, 1.0 / Math.max(1e-8, field.maxMagnitude));

    // Visibility
    const useAlpha = Boolean(ctx.useAlphaTexture && ctx.alphaTexture && ctx.alphaTexWidth > 0);
    gl.uniform1i(u.u_useAlphaTex, useAlpha ? 1 : 0);
    gl.uniform1i(u.u_alphaTexWidth, useAlpha ? ctx.alphaTexWidth : 0);

    // Fog
    gl.uniform1f(u.u_fogNear, ctx.fogNear ?? 0);
    gl.uniform1f(u.u_fogFar, ctx.fogFar ?? 100);
    gl.uniform1f(u.u_fogDensity, ctx.fogDensity ?? 0.5);
    gl.uniform3fv(u.u_fogColor, ctx.fogColor || [0.02, 0.02, 0.04]);

    // Bind textures
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, ctx.alphaTexture || null);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this._colormapTexture);

    // Draw particles
    gl.bindVertexArray(this._particleVAOs[this._currentBuffer]);
    gl.drawArrays(gl.POINTS, 0, this._activeParticleCount);
    gl.bindVertexArray(null);

    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  _passBloom(fbos) {
    const gl = this.gl;

    // Extract bright areas with soft knee threshold
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbos.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbos.bloom[0], 0);
    gl.viewport(0, 0, fbos.bloomWidth, fbos.bloomHeight);
    gl.disable(gl.BLEND);

    gl.useProgram(this._programThreshold);
    gl.uniform1f(this._uniformsThreshold.u_threshold, this.config.bloomThreshold);
    gl.uniform1f(this._uniformsThreshold.u_softness, 0.1);
    gl.uniform1f(this._uniformsThreshold.u_knee, this.config.bloomKnee);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fbos.trail[fbos.trailIdx]);
    gl.uniform1i(this._uniformsThreshold.u_source, 0);

    gl.bindVertexArray(this._emptyVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Horizontal blur
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbos.bloom[1], 0);

    gl.useProgram(this._programBlur);
    gl.uniform2f(this._uniformsBlur.u_direction, 1.0, 0.0);
    gl.uniform1f(this._uniformsBlur.u_blurSize, this.config.bloomBlurSize);

    gl.bindTexture(gl.TEXTURE_2D, fbos.bloom[0]);
    gl.uniform1i(this._uniformsBlur.u_source, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Vertical blur
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbos.bloom[0], 0);

    gl.uniform2f(this._uniformsBlur.u_direction, 0.0, 1.0);
    gl.bindTexture(gl.TEXTURE_2D, fbos.bloom[1]);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Anamorphic pass for cinematic horizontal stretch
    if (this.config.anamorphicRatio > 1.0) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbos.bloom[1], 0);

      gl.useProgram(this._programAnamorphic);
      gl.uniform1f(this._uniformsAnamorphic.u_anamorphicRatio, this.config.anamorphicRatio);
      gl.uniform1f(this._uniformsAnamorphic.u_blurSize, this.config.bloomBlurSize * 0.5);

      gl.bindTexture(gl.TEXTURE_2D, fbos.bloom[0]);
      gl.uniform1i(this._uniformsAnamorphic.u_source, 0);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Copy back to bloom[0]
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbos.bloom[0], 0);

      gl.useProgram(this._programBlur);
      gl.uniform2f(this._uniformsBlur.u_direction, 0.0, 0.0);
      gl.uniform1f(this._uniformsBlur.u_blurSize, 0.0);

      gl.bindTexture(gl.TEXTURE_2D, fbos.bloom[1]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    gl.bindVertexArray(null);
  }

  _passComposite(ctx, fbos) {
    const gl = this.gl;

    gl.viewport(0, 0, ctx.viewportWidth, ctx.viewportHeight);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);

    gl.useProgram(this._programComposite);
    const u = this._uniformsComposite;

    gl.uniform1f(u.u_opacity, this.config.opacity);
    gl.uniform1f(u.u_gamma, this.config.gamma);
    gl.uniform1f(u.u_bloomStrength, this.config.bloomEnabled ? this.config.bloomStrength : 0);
    gl.uniform1f(u.u_exposure, this.config.exposure);
    gl.uniform1f(u.u_contrast, this.config.contrast);
    gl.uniform1f(u.u_saturation, this.config.saturation);
    gl.uniform1f(u.u_time, ctx.time || 0);

    // Advanced color grading
    gl.uniform1f(u.u_highlights, this.config.highlights);
    gl.uniform1f(u.u_shadows, this.config.shadows);
    gl.uniform3fv(u.u_colorTint, this.config.colorTint);

    // Cinematic effects
    gl.uniform1f(u.u_vignette, this.config.vignette);
    gl.uniform1f(u.u_filmGrain, this.config.filmGrain);
    gl.uniform1f(u.u_chromaticAberration, this.config.chromaticAberration);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fbos.trail[fbos.trailIdx]);
    gl.uniform1i(u.u_trailTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fbos.bloom[0]);
    gl.uniform1i(u.u_bloomTex, 1);

    gl.bindVertexArray(this._emptyVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    gl.depthMask(true);
  }

  // ===========================================================================
  // FBO MANAGEMENT
  // ===========================================================================

  _detectTextureFormat() {
    if (this._floatTextureFormat) return this._floatTextureFormat;

    const gl = this.gl;
    const formats = [
      { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, ext: 'EXT_color_buffer_half_float' },
      { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, ext: 'EXT_color_buffer_float' },
      { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, ext: null }
    ];

    for (const fmt of formats) {
      if (fmt.ext && !gl.getExtension(fmt.ext)) continue;

      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, 4, 4, 0, fmt.format, fmt.type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);

      if (status === gl.FRAMEBUFFER_COMPLETE) {
        this._floatTextureFormat = fmt;
        return fmt;
      }
    }

    this._floatTextureFormat = formats[2];
    return this._floatTextureFormat;
  }

  _ensureFBOs(viewId, vpWidth, vpHeight) {
    const gl = this.gl;
    const key = String(viewId || 'live');

    const scale = this.config.trailResolution;
    const w = Math.max(1, Math.floor(vpWidth * scale));
    const h = Math.max(1, Math.floor(vpHeight * scale));
    const bloomW = Math.max(1, Math.floor(w / 2));
    const bloomH = Math.max(1, Math.floor(h / 2));

    let fbos = this._fboByView.get(key);

    if (fbos && (fbos.width !== w || fbos.height !== h)) {
      this._disposeFBOs(key);
      fbos = null;
    }

    if (fbos) return fbos;

    const fmt = this._detectTextureFormat();

    const fbo = gl.createFramebuffer();

    // Trail textures (ping-pong)
    const trail = [null, null];
    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, fmt.format, fmt.type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      trail[i] = tex;

      // Clear
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    // Bloom textures
    const bloom = [null, null];
    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, bloomW, bloomH, 0, fmt.format, fmt.type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      bloom[i] = tex;
    }

    // Verify
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, trail[0], 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo);
      for (const t of trail) if (t) gl.deleteTexture(t);
      for (const t of bloom) if (t) gl.deleteTexture(t);
      return null;
    }

    fbos = {
      fbo,
      trail,
      bloom,
      width: w,
      height: h,
      bloomWidth: bloomW,
      bloomHeight: bloomH,
      trailIdx: 0
    };

    this._fboByView.set(key, fbos);
    return fbos;
  }

  _disposeFBOs(viewId) {
    const gl = this.gl;
    const key = String(viewId || 'live');
    const fbos = this._fboByView.get(key);
    if (!fbos) return;

    if (fbos.fbo) gl.deleteFramebuffer(fbos.fbo);
    for (const t of fbos.trail) if (t) gl.deleteTexture(t);
    for (const t of fbos.bloom) if (t) gl.deleteTexture(t);

    this._fboByView.delete(key);
  }

  // ===========================================================================
  // INTERNAL UTILITIES
  // ===========================================================================

  _cacheUniforms() {
    const gl = this.gl;

    this._uniformsUpdate = {
      u_dt: gl.getUniformLocation(this._programUpdate, 'u_dt'),
      u_time: gl.getUniformLocation(this._programUpdate, 'u_time'),
      u_speedMultiplier: gl.getUniformLocation(this._programUpdate, 'u_speedMultiplier'),
      u_lifetime: gl.getUniformLocation(this._programUpdate, 'u_lifetime'),
      u_dropRate: gl.getUniformLocation(this._programUpdate, 'u_dropRate'),
      u_dropRateBump: gl.getUniformLocation(this._programUpdate, 'u_dropRateBump'),
      u_turbulence: gl.getUniformLocation(this._programUpdate, 'u_turbulence'),
      u_velocityTex: gl.getUniformLocation(this._programUpdate, 'u_velocityTex'),
      u_velocityTexWidth: gl.getUniformLocation(this._programUpdate, 'u_velocityTexWidth'),
      u_positionTex: gl.getUniformLocation(this._programUpdate, 'u_positionTex'),
      u_positionTexWidth: gl.getUniformLocation(this._programUpdate, 'u_positionTexWidth'),
      u_spawnTableTex: gl.getUniformLocation(this._programUpdate, 'u_spawnTableTex'),
      u_spawnTableWidth: gl.getUniformLocation(this._programUpdate, 'u_spawnTableWidth'),
      u_spawnTableSize: gl.getUniformLocation(this._programUpdate, 'u_spawnTableSize')
    };

    this._uniformsRender = {
      u_mvpMatrix: gl.getUniformLocation(this._programRender, 'u_mvpMatrix'),
      u_viewMatrix: gl.getUniformLocation(this._programRender, 'u_viewMatrix'),
      u_modelMatrix: gl.getUniformLocation(this._programRender, 'u_modelMatrix'),
      u_cameraPosition: gl.getUniformLocation(this._programRender, 'u_cameraPosition'),
      u_viewportHeight: gl.getUniformLocation(this._programRender, 'u_viewportHeight'),
      u_fov: gl.getUniformLocation(this._programRender, 'u_fov'),
      u_sizeAttenuation: gl.getUniformLocation(this._programRender, 'u_sizeAttenuation'),
      u_particleSize: gl.getUniformLocation(this._programRender, 'u_particleSize'),
      u_minSize: gl.getUniformLocation(this._programRender, 'u_minSize'),
      u_maxSize: gl.getUniformLocation(this._programRender, 'u_maxSize'),
      u_intensity: gl.getUniformLocation(this._programRender, 'u_intensity'),
      u_glowAmount: gl.getUniformLocation(this._programRender, 'u_glowAmount'),
      u_coreSharpness: gl.getUniformLocation(this._programRender, 'u_coreSharpness'),
      u_cometStretch: gl.getUniformLocation(this._programRender, 'u_cometStretch'),
      u_invMaxMagnitude: gl.getUniformLocation(this._programRender, 'u_invMaxMagnitude'),
      u_alphaTex: gl.getUniformLocation(this._programRender, 'u_alphaTex'),
      u_alphaTexWidth: gl.getUniformLocation(this._programRender, 'u_alphaTexWidth'),
      u_useAlphaTex: gl.getUniformLocation(this._programRender, 'u_useAlphaTex'),
      u_colormapTex: gl.getUniformLocation(this._programRender, 'u_colormapTex'),
      u_fogNear: gl.getUniformLocation(this._programRender, 'u_fogNear'),
      u_fogFar: gl.getUniformLocation(this._programRender, 'u_fogFar'),
      u_fogDensity: gl.getUniformLocation(this._programRender, 'u_fogDensity'),
      u_fogColor: gl.getUniformLocation(this._programRender, 'u_fogColor')
    };

    this._uniformsFade = {
      u_previousFrame: gl.getUniformLocation(this._programFade, 'u_previousFrame'),
      u_fadeAmount: gl.getUniformLocation(this._programFade, 'u_fadeAmount'),
      u_chromaticFade: gl.getUniformLocation(this._programFade, 'u_chromaticFade')
    };

    this._uniformsThreshold = {
      u_source: gl.getUniformLocation(this._programThreshold, 'u_source'),
      u_threshold: gl.getUniformLocation(this._programThreshold, 'u_threshold'),
      u_softness: gl.getUniformLocation(this._programThreshold, 'u_softness'),
      u_knee: gl.getUniformLocation(this._programThreshold, 'u_knee')
    };

    this._uniformsBlur = {
      u_source: gl.getUniformLocation(this._programBlur, 'u_source'),
      u_direction: gl.getUniformLocation(this._programBlur, 'u_direction'),
      u_blurSize: gl.getUniformLocation(this._programBlur, 'u_blurSize')
    };

    this._uniformsAnamorphic = {
      u_source: gl.getUniformLocation(this._programAnamorphic, 'u_source'),
      u_anamorphicRatio: gl.getUniformLocation(this._programAnamorphic, 'u_anamorphicRatio'),
      u_blurSize: gl.getUniformLocation(this._programAnamorphic, 'u_blurSize')
    };

    this._uniformsComposite = {
      u_trailTex: gl.getUniformLocation(this._programComposite, 'u_trailTex'),
      u_bloomTex: gl.getUniformLocation(this._programComposite, 'u_bloomTex'),
      u_opacity: gl.getUniformLocation(this._programComposite, 'u_opacity'),
      u_gamma: gl.getUniformLocation(this._programComposite, 'u_gamma'),
      u_bloomStrength: gl.getUniformLocation(this._programComposite, 'u_bloomStrength'),
      u_exposure: gl.getUniformLocation(this._programComposite, 'u_exposure'),
      u_contrast: gl.getUniformLocation(this._programComposite, 'u_contrast'),
      u_saturation: gl.getUniformLocation(this._programComposite, 'u_saturation'),
      u_time: gl.getUniformLocation(this._programComposite, 'u_time'),
      u_vignette: gl.getUniformLocation(this._programComposite, 'u_vignette'),
      u_filmGrain: gl.getUniformLocation(this._programComposite, 'u_filmGrain'),
      u_chromaticAberration: gl.getUniformLocation(this._programComposite, 'u_chromaticAberration'),
      u_colorTint: gl.getUniformLocation(this._programComposite, 'u_colorTint'),
      u_highlights: gl.getUniformLocation(this._programComposite, 'u_highlights'),
      u_shadows: gl.getUniformLocation(this._programComposite, 'u_shadows')
    };
  }

  _bindSamplers() {
    const gl = this.gl;

    gl.useProgram(this._programUpdate);
    gl.uniform1i(this._uniformsUpdate.u_velocityTex, 0);
    gl.uniform1i(this._uniformsUpdate.u_positionTex, 1);
    gl.uniform1i(this._uniformsUpdate.u_spawnTableTex, 2);

    gl.useProgram(this._programRender);
    gl.uniform1i(this._uniformsRender.u_alphaTex, 1);
    gl.uniform1i(this._uniformsRender.u_colormapTex, 3);
  }

  /**
   * Detect camera motion by comparing current position/orientation with previous frame.
   * Sets _cameraMotionAmount which is used to accelerate trail fade during movement.
   */
  _updateCameraMotion(ctx) {
    const camPos = ctx?.cameraPosition;
    const viewMatrix = ctx?.viewMatrix;

    if (!camPos || !viewMatrix) {
      this._cameraMotionAmount = 0;
      return;
    }

    let motion = 0;

    // Check camera position change
    if (this._lastCameraPosition) {
      const dx = camPos[0] - this._lastCameraPosition[0];
      const dy = camPos[1] - this._lastCameraPosition[1];
      const dz = camPos[2] - this._lastCameraPosition[2];
      const posDelta = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // Normalize by camera distance for scale-independent motion detection
      const camDist = Math.max(0.1, ctx.cameraDistance || 1);
      motion = posDelta / camDist;
    }

    // Check view matrix rotation change (use first row to detect rotation)
    if (this._lastViewMatrix) {
      let rotDelta = 0;
      for (let i = 0; i < 9; i++) {
        // Check 3x3 rotation part of view matrix
        const row = Math.floor(i / 3);
        const col = i % 3;
        const idx = col * 4 + row; // Column-major
        const diff = viewMatrix[idx] - this._lastViewMatrix[idx];
        rotDelta += diff * diff;
      }
      motion = Math.max(motion, Math.sqrt(rotDelta) * 0.5);
    }

    // Smooth the motion amount with temporal filtering
    const targetMotion = motion > this.config.cameraMotionThreshold ? 1.0 : 0.0;
    this._cameraMotionAmount = this._cameraMotionAmount * 0.7 + targetMotion * 0.3;

    // Store current values for next frame comparison
    this._lastCameraPosition = [camPos[0], camPos[1], camPos[2]];
    if (!this._lastViewMatrix) {
      this._lastViewMatrix = new Float32Array(16);
    }
    this._lastViewMatrix.set(viewMatrix);
  }

  /**
   * Calculate effective trail fade based on camera motion.
   * Returns a lower fade value (faster decay) when camera is moving.
   */
  _getEffectiveTrailFade() {
    const baseFade = this.config.trailFade;
    const motionFade = this.config.cameraMotionFade;
    const motion = this._cameraMotionAmount;

    // Blend between base fade and faster motion fade based on camera motion
    return baseFade * (1.0 - motion * (1.0 - motionFade));
  }

  _updateColormap(firstInit = false) {
    const gl = this.gl;
    const tex = this._colormapTexture;
    if (!tex) return;

    const colormap = getColormap(this.config.colormapId);
    const size = 256;
    const data = new Uint8Array(size * 3);

    for (let i = 0; i < size; i++) {
      const t = i / (size - 1);
      const rgb = colormap.sample(t);
      const base = i * 3;
      data[base] = Math.round(Math.max(0, Math.min(255, rgb[0] * 255)));
      data[base + 1] = Math.round(Math.max(0, Math.min(255, rgb[1] * 255)));
      data[base + 2] = Math.round(Math.max(0, Math.min(255, rgb[2] * 255)));
    }

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    if (firstInit) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, size, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, data);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, 1, gl.RGB, gl.UNSIGNED_BYTE, data);
    }

    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  _ensurePositionTexture(viewId, positions3D) {
    const key = String(viewId || 'live');
    const prev = this._positionsRefByView.get(key);

    if (prev === positions3D) {
      const entry = this._positionTexturePool.get(positions3D);
      return entry?.textureInfo || null;
    }

    if (prev) {
      this._releasePositionTexture(prev);
    }

    this._positionsRefByView.set(key, positions3D);

    let entry = this._positionTexturePool.get(positions3D);
    if (!entry) {
      const textureInfo = createOrUpdatePackedFloatTexture(this.gl, {
        texture: null,
        data: positions3D,
        itemCount: Math.floor(positions3D.length / 3),
        components: 3
      });
      entry = { textureInfo, refs: 0 };
      this._positionTexturePool.set(positions3D, entry);
    }
    entry.refs++;
    return entry.textureInfo;
  }

  _releasePositionTexture(posRef) {
    const entry = this._positionTexturePool.get(posRef);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;

    if (entry.textureInfo?.texture) {
      this.gl.deleteTexture(entry.textureInfo.texture);
    }
    this._positionTexturePool.delete(posRef);
  }

  _ensureSpawnTable(viewId, ctx, cellCount) {
    const key = String(viewId || 'live');
    let state = this._spawnByView.get(key);

    if (!state) {
      state = { dirty: true, version: 0, building: false, textureInfo: null, tableSize: 0, tableWidth: 1, lastLod: null };
      this._spawnByView.set(key, state);
    }

    // Check LOD change
    const lod = typeof ctx?.getLodLevel === 'function' ? ctx.getLodLevel() : -1;
    if (this.config.syncWithLOD && state.lastLod !== null && lod !== state.lastLod) {
      state.dirty = true;
      state.version++;
    }
    state.lastLod = lod;

    if (!state.dirty || state.building) return state;

    const scheduledVersion = state.version;
    state.building = true;

    const notifications = getNotificationCenter();
    const showNotif = !state.textureInfo;
    const notifId = showNotif ? notifications.loading('Preparing velocity overlay...', { category: 'render' }) : null;

    const schedule = typeof requestIdleCallback === 'function'
      ? fn => requestIdleCallback(fn, { timeout: 500 })
      : fn => setTimeout(fn, 0);

    schedule(() => {
      if (this._disposed) {
        state.building = false;
        return;
      }

      let success = false;
      try {
        const transparency = ctx?.getViewTransparency?.();
        if (!(transparency instanceof Float32Array) || transparency.length < cellCount) {
          state.tableSize = 0;
          state.tableWidth = 1;
          state.textureInfo = null;
          return;
        }

        const lodIndices = this.config.syncWithLOD && typeof ctx?.getLodIndices === 'function'
          ? ctx.getLodIndices()
          : null;

        const table = this._buildSpawnTable(transparency, cellCount, lodIndices);
        if (table.length <= 0) {
          state.tableSize = 0;
          state.tableWidth = 1;
          state.textureInfo = null;
          return;
        }

        const textureInfo = createOrUpdatePackedUintTexture(this.gl, {
          texture: state.textureInfo?.texture || null,
          data: table,
          itemCount: table.length
        });

        state.textureInfo = textureInfo;
        state.tableSize = table.length;
        state.tableWidth = textureInfo.width;
        success = true;
      } catch (err) {
        console.warn('[VelocityOverlay] spawn table error:', err);
        state.textureInfo = null;
        state.tableSize = 0;
        state.tableWidth = 1;
      } finally {
        state.building = false;
        state.dirty = !(success && state.version === scheduledVersion);

        if (notifId) {
          if (state.tableSize > 0) {
            notifications.complete(notifId, 'Velocity overlay ready');
          } else {
            notifications.fail(notifId, 'Velocity overlay unavailable');
          }
        }
      }
    });

    return state;
  }

  _buildSpawnTable(transparency, cellCount, lodIndices) {
    const maxSize = Math.min(this.config.spawnTableSize, cellCount);
    const table = new Uint32Array(maxSize);
    const threshold = 0.01;

    const rng = createRNG((Date.now() ^ (cellCount * 2654435761)) >>> 0);
    const candidates = lodIndices instanceof Uint32Array && lodIndices.length > 0 ? lodIndices : null;
    const candidateCount = candidates ? candidates.length : cellCount;

    let filled = 0;
    const maxAttempts = maxSize * 24;

    for (let attempt = 0; attempt < maxAttempts && filled < maxSize; attempt++) {
      const pick = rng.nextInt(candidateCount);
      const idx = candidates ? candidates[pick] : pick;
      if (idx >= cellCount) continue;
      if ((transparency[idx] || 0) > threshold) {
        table[filled++] = idx >>> 0;
      }
    }

    if (filled === maxSize) return table;

    // Fallback: sequential fill
    if (candidates) {
      for (let i = 0; i < candidates.length && filled < maxSize; i++) {
        const idx = candidates[i];
        if (idx >= cellCount) continue;
        if ((transparency[idx] || 0) > threshold) {
          table[filled++] = idx >>> 0;
        }
      }
    } else {
      for (let idx = 0; idx < cellCount && filled < maxSize; idx++) {
        if ((transparency[idx] || 0) > threshold) {
          table[filled++] = idx >>> 0;
        }
      }
    }

    return filled === maxSize ? table : table.subarray(0, filled);
  }
}
