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

export const DEFAULT_VELOCITY_PARTICLE_CAPACITY = CONFIG.particleCapacity;

// Particle data layout: position (vec3) + velocity (vec3) + age (float) + cellIndex (uint)
// = 3 + 3 + 1 + 1 = 8 floats worth (28 bytes with padding)
const FLOATS_PER_PARTICLE = 8;
const BYTES_PER_PARTICLE = FLOATS_PER_PARTICLE * 4;

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function requireNumber(value, key, min, max, integer = false) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (integer && !Number.isInteger(value))
  ) {
    const numberKind = integer ? 'integer number' : 'number';
    throw new TypeError(`VelocityOverlay ${key} must be an exact ${numberKind}.`);
  }
  if (value < min || value > max) {
    throw new RangeError(
      `VelocityOverlay ${key} must be between ${min} and ${max}; received ${value}.`
    );
  }
  return value;
}

function readNumberOption(options, key, min, max, integer = false) {
  if (!Object.hasOwn(options, key)) return CONFIG[key];
  return requireNumber(options[key], key, min, max, integer);
}

function requireBoolean(value, key) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`VelocityOverlay ${key} must be an exact boolean.`);
  }
  return value;
}

function readBooleanOption(options, key) {
  if (!Object.hasOwn(options, key)) return CONFIG[key];
  return requireBoolean(options[key], key);
}

function requireColorTint(value) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError(
      'VelocityOverlay colorTint must be an exact three-number array.'
    );
  }
  for (const entry of value) {
    requireNumber(entry, 'colorTint channel', 0, 2);
  }
  return value.slice();
}

function readColorTintOption(options) {
  return Object.hasOwn(options, 'colorTint')
    ? requireColorTint(options.colorTint)
    : CONFIG.colorTint.slice();
}

function requireNonEmptyString(value, key) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new TypeError(
      `VelocityOverlay ${key} must be an exact non-empty trimmed string.`
    );
  }
  return value;
}

/**
 * Validate one public velocity-overlay configuration update without creating
 * an overlay or allocating GPU resources.
 *
 * @param {unknown} key
 * @param {unknown} value
 * @param {unknown} particleCapacity
 * @returns {{ key: string; value: unknown }}
 */
export function validateVelocityOverlayConfig(
  key,
  value,
  particleCapacity
) {
  const exactKey = requireNonEmptyString(key, 'configuration key');
  const exactCapacity = requireNumber(
    particleCapacity,
    'particleCapacity',
    1000,
    500_000,
    true
  );
  let exactValue;
  switch (exactKey) {
    case 'particleCount':
      exactValue = requireNumber(value, exactKey, 0, exactCapacity, true);
      break;
    case 'speedMultiplier':
      exactValue = requireNumber(value, exactKey, 0.05, 20);
      break;
    case 'lifetime':
      exactValue = requireNumber(value, exactKey, 0.1, 30);
      break;
    case 'dropRate':
    case 'dropRateBump':
      exactValue = requireNumber(value, exactKey, 0, 0.1);
      break;
    case 'turbulence':
      exactValue = requireNumber(value, exactKey, 0, 2);
      break;
    case 'particleSize':
      exactValue = requireNumber(value, exactKey, 0.5, 50);
      break;
    case 'minSize':
      exactValue = requireNumber(value, exactKey, 0.5, 10);
      break;
    case 'maxSize':
      exactValue = requireNumber(value, exactKey, 5, 100);
      break;
    case 'intensity':
      exactValue = requireNumber(value, exactKey, 0.05, 5);
      break;
    case 'glowAmount':
    case 'coreSharpness':
      exactValue = requireNumber(value, exactKey, 0, 1);
      break;
    case 'cometStretch':
      exactValue = requireNumber(value, exactKey, 0, 2);
      break;
    case 'trailFade':
      exactValue = requireNumber(value, exactKey, 0.5, 0.999);
      break;
    case 'trailResolution':
      exactValue = requireNumber(value, exactKey, 0.25, 2);
      break;
    case 'chromaticFade':
      exactValue = requireNumber(value, exactKey, 0, 1);
      break;
    case 'cameraMotionFade':
      exactValue = requireNumber(value, exactKey, 0.5, 1);
      break;
    case 'cameraMotionThreshold':
      exactValue = requireNumber(value, exactKey, 0.0001, 0.1);
      break;
    case 'bloomEnabled':
      exactValue = requireBoolean(value, exactKey);
      break;
    case 'bloomStrength':
      exactValue = requireNumber(value, exactKey, 0, 2);
      break;
    case 'bloomThreshold':
    case 'bloomKnee':
      exactValue = requireNumber(value, exactKey, 0, 1);
      break;
    case 'bloomBlurSize':
      exactValue = requireNumber(value, exactKey, 1, 16);
      break;
    case 'anamorphicRatio':
      exactValue = requireNumber(value, exactKey, 1, 3);
      break;
    case 'exposure':
      exactValue = requireNumber(value, exactKey, 0.1, 4);
      break;
    case 'contrast':
      exactValue = requireNumber(value, exactKey, 0.5, 2);
      break;
    case 'saturation':
      exactValue = requireNumber(value, exactKey, 0, 2);
      break;
    case 'gamma':
      exactValue = requireNumber(value, exactKey, 0.5, 2.5);
      break;
    case 'highlights':
      exactValue = requireNumber(value, exactKey, 0.5, 2);
      break;
    case 'shadows':
      exactValue = requireNumber(value, exactKey, 0.5, 2);
      break;
    case 'colorTint':
      exactValue = requireColorTint(value);
      break;
    case 'vignette':
      exactValue = requireNumber(value, exactKey, 0, 1);
      break;
    case 'filmGrain':
      exactValue = requireNumber(value, exactKey, 0, 0.5);
      break;
    case 'chromaticAberration':
      exactValue = requireNumber(value, exactKey, 0, 2);
      break;
    case 'opacity':
      exactValue = requireNumber(value, exactKey, 0, 1);
      break;
    case 'colormapId': {
      exactValue = requireNonEmptyString(value, exactKey);
      if (getColormap(exactValue).id !== exactValue) {
        throw new RangeError(
          `VelocityOverlay colormapId "${exactValue}" is unknown.`
        );
      }
      break;
    }
    case 'spawnTableSize':
      exactValue = requireNumber(value, exactKey, 1024, 1_048_576, true);
      break;
    case 'syncWithLOD':
      exactValue = requireBoolean(value, exactKey);
      break;
    default:
      throw new RangeError(
        `VelocityOverlay configuration key "${exactKey}" is unknown.`
      );
  }
  return { key: exactKey, value: exactValue };
}

export function validateVelocityFieldId(fieldId) {
  return requireNonEmptyString(fieldId, 'fieldId');
}

export function validateActiveVelocityFieldId(fieldId) {
  return fieldId === null ? null : validateVelocityFieldId(fieldId);
}

export function validateVelocityFieldData(
  fieldId,
  dimensionLevel,
  fieldData
) {
  const id = validateVelocityFieldId(fieldId);
  const dimension = requireDimensionLevel(dimensionLevel);
  if (
    fieldData === null ||
    typeof fieldData !== 'object' ||
    Array.isArray(fieldData) ||
    Object.getPrototypeOf(fieldData) !== Object.prototype ||
    Object.keys(fieldData).sort().join(',') !==
      'cellCount,components,maxMagnitude,vectors'
  ) {
    throw new TypeError(
      'VelocityOverlay fieldData must contain exactly cellCount, components, maxMagnitude, and vectors.'
    );
  }
  const {
    vectors,
    components,
    cellCount,
    maxMagnitude
  } = fieldData;
  if (!(vectors instanceof Float32Array)) {
    throw new TypeError('VelocityOverlay vectors must be a Float32Array.');
  }
  if (components !== 1 && components !== 2 && components !== 3) {
    throw new RangeError(
      'VelocityOverlay components must be exactly 1, 2, or 3.'
    );
  }
  requireNumber(cellCount, 'cellCount', 1, Number.MAX_SAFE_INTEGER, true);
  if (vectors.length !== cellCount * components) {
    throw new RangeError(
      `VelocityOverlay vectors must contain exactly ${cellCount * components} values; received ${vectors.length}.`
    );
  }
  for (let index = 0; index < vectors.length; index += 1) {
    if (!Number.isFinite(vectors[index])) {
      throw new RangeError(
        `VelocityOverlay vector value ${index} must be finite.`
      );
    }
  }
  requireNumber(maxMagnitude, 'maxMagnitude', 0, Number.MAX_VALUE);
  return {
    id,
    dimension,
    vectors,
    components,
    cellCount,
    maxMagnitude
  };
}

function readStringOption(options, key) {
  return Object.hasOwn(options, key)
    ? requireNonEmptyString(options[key], key)
    : CONFIG[key];
}

function requireDimensionLevel(value) {
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new RangeError(
      `VelocityOverlay dimensionLevel must be exactly 1, 2, or 3; received ${String(value)}.`
    );
  }
  return value;
}

function requireViewId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('VelocityOverlay viewId must be a non-empty string.');
  }
  return value;
}

function createRNG(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x6d2b79f5;
  return {
    next() {
      state ^= (state << 13) >>> 0;
      state ^= (state >>> 17) >>> 0;
      state ^= (state << 5) >>> 0;
      return state >>> 0;
    },
    nextInt(max) {
      if (!Number.isSafeInteger(max) || max <= 0 || max > 0x1_0000_0000) {
        throw new RangeError('VelocityOverlay random sample bound must be an integer from 1 through 2^32.');
      }
      return Math.floor((this.next() / 0x1_0000_0000) * max);
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
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('VelocityOverlay options must be an object.');
    }
    super(gl, { id: 'velocity', priority: 30, ...options });

    // Configuration
    const particleCapacity = readNumberOption(
      options,
      'particleCapacity',
      1000,
      500_000,
      true
    );
    this.config = {
      particleCapacity,
      particleCount: readNumberOption(
        options,
        'particleCount',
        0,
        particleCapacity,
        true
      ),
      speedMultiplier: readNumberOption(options, 'speedMultiplier', 0.05, 20),
      lifetime: readNumberOption(options, 'lifetime', 0.1, 30),
      dropRate: readNumberOption(options, 'dropRate', 0, 0.1),
      dropRateBump: readNumberOption(options, 'dropRateBump', 0, 0.1),
      turbulence: readNumberOption(options, 'turbulence', 0, 2),

      particleSize: readNumberOption(options, 'particleSize', 0.5, 50),
      minSize: readNumberOption(options, 'minSize', 0.5, 10),
      maxSize: readNumberOption(options, 'maxSize', 5, 100),
      intensity: readNumberOption(options, 'intensity', 0.05, 5),
      glowAmount: readNumberOption(options, 'glowAmount', 0, 1),
      coreSharpness: readNumberOption(options, 'coreSharpness', 0, 1),
      cometStretch: readNumberOption(options, 'cometStretch', 0, 2),

      trailFade: readNumberOption(options, 'trailFade', 0.5, 0.999),
      trailResolution: readNumberOption(options, 'trailResolution', 0.25, 2),
      chromaticFade: readNumberOption(options, 'chromaticFade', 0, 1),

      cameraMotionFade: readNumberOption(options, 'cameraMotionFade', 0.5, 1),
      cameraMotionThreshold: readNumberOption(
        options,
        'cameraMotionThreshold',
        0.0001,
        0.1
      ),

      bloomEnabled: readBooleanOption(options, 'bloomEnabled'),
      bloomStrength: readNumberOption(options, 'bloomStrength', 0, 2),
      bloomThreshold: readNumberOption(options, 'bloomThreshold', 0, 1),
      bloomBlurSize: readNumberOption(options, 'bloomBlurSize', 1, 16),
      bloomKnee: readNumberOption(options, 'bloomKnee', 0, 1),
      anamorphicRatio: readNumberOption(options, 'anamorphicRatio', 1, 3),
      exposure: readNumberOption(options, 'exposure', 0.1, 4),
      contrast: readNumberOption(options, 'contrast', 0.5, 2),
      saturation: readNumberOption(options, 'saturation', 0, 2),
      gamma: readNumberOption(options, 'gamma', 0.5, 2.5),

      highlights: readNumberOption(options, 'highlights', 0.5, 2),
      shadows: readNumberOption(options, 'shadows', 0.5, 2),
      colorTint: readColorTintOption(options),

      vignette: readNumberOption(options, 'vignette', 0, 1),
      filmGrain: readNumberOption(options, 'filmGrain', 0, 0.5),
      chromaticAberration: readNumberOption(options, 'chromaticAberration', 0, 2),

      opacity: readNumberOption(options, 'opacity', 0, 1),
      colormapId: readStringOption(options, 'colormapId'),
      spawnTableSize: readNumberOption(
        options,
        'spawnTableSize',
        1024,
        1_048_576,
        true
      ),
      syncWithLOD: readBooleanOption(options, 'syncWithLOD')
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
    this._textureFormat = null;

    // Fullscreen passes use gl_VertexID, but Firefox desktop OpenGL still
    // requires an enabled attribute-zero array to avoid emulation.
    this._fullscreenVAO = null;
    this._fullscreenAttrib0Buffer = null;

    // Camera motion tracking for trail fade compensation
    this._lastCameraPosition = null;
    this._lastViewMatrix = null;
    this._cameraMotionAmount = 0;
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  setActiveField(fieldId) {
    this._activeFieldId = validateActiveVelocityFieldId(fieldId);
  }

  getActiveFieldId() {
    return this._activeFieldId;
  }

  setVectorFieldData(fieldId, dimensionLevel, fieldData) {
    const validated = validateVelocityFieldData(
      fieldId,
      dimensionLevel,
      fieldData
    );
    this.init();

    let perField = this._fieldsById.get(validated.id);
    if (!perField) {
      perField = new Map();
    }

    const existing = perField.get(validated.dimension);
    const textureInfo = createOrUpdatePackedFloatTexture(this.gl, {
      texture: null,
      data: validated.vectors,
      itemCount: validated.cellCount,
      components: validated.components
    });

    perField.set(validated.dimension, {
      ...textureInfo,
      cellCount: validated.cellCount,
      maxMagnitude: validated.maxMagnitude
    });
    this._fieldsById.set(validated.id, perField);
    if (existing !== undefined) {
      this.gl.deleteTexture(existing.texture);
    }

    if (this._activeFieldId === null) {
      this._activeFieldId = validated.id;
    }

    // Mark spawn tables dirty
    for (const state of this._spawnByView.values()) {
      state.dirty = true;
      state.version++;
    }
  }

  hasFieldForDimension(fieldId, dimensionLevel) {
    const id = validateVelocityFieldId(fieldId);
    const dim = requireDimensionLevel(dimensionLevel);
    const fields = this._fieldsById.get(id);
    return fields !== undefined && fields.has(dim);
  }

  markVisibilityDirty(viewId) {
    const key = requireViewId(viewId);
    const state = this._spawnByView.get(key);
    if (state) {
      state.dirty = true;
      state.version++;
    }
  }

  disposeView(viewId) {
    const key = requireViewId(viewId);
    const gl = this.gl;

    // Clean spawn table
    const spawn = this._spawnByView.get(key);
    if (spawn && spawn.notificationId !== null) {
      getNotificationCenter().dismiss(spawn.notificationId);
      spawn.notificationId = null;
    }
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
    const validated = validateVelocityOverlayConfig(
      key,
      value,
      this.config.particleCapacity
    );
    this.init();

    const cfg = this.config;
    cfg[validated.key] = validated.value;
    if (validated.key === 'trailResolution') {
      for (const viewId of this._fboByView.keys()) this._disposeFBOs(viewId);
    } else if (validated.key === 'colormapId') {
      this._updateColormap();
    } else if (
      validated.key === 'spawnTableSize' ||
      validated.key === 'syncWithLOD'
    ) {
      for (const spawn of this._spawnByView.values()) {
        spawn.dirty = true;
        spawn.version += 1;
      }
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

    this._createFullscreenGeometry();

    this._bindSamplers();
  }

  _doUpdate(dt, ctx) {
    if (!ctx || typeof ctx !== 'object') {
      throw new TypeError('VelocityOverlay update context is required.');
    }
    requireNumber(dt, 'update delta', 0, Number.MAX_VALUE);
    const dim = requireDimensionLevel(ctx.dimensionLevel);
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
    if (this.config.syncWithLOD) {
      if (typeof ctx.getLodLevel !== 'function') {
        throw new TypeError('VelocityOverlay context getLodLevel() is required.');
      }
      const lod = ctx.getLodLevel();
      if (!Number.isInteger(lod) || lod < -1) {
        throw new RangeError(
          'VelocityOverlay context LOD level must be an integer greater than or equal to -1.'
        );
      }
      if (lod >= 0) {
        const factor = lod >= 6 ? 0 : lod >= 3 ? 0.25 : lod >= 1 ? 0.5 : 1.0;
        targetCount = Math.floor(targetCount * factor);
      }
    }
    this._activeParticleCount = targetCount;
    if (this._activeParticleCount <= 0) return;

    const viewId = requireViewId(ctx.viewId);
    if (typeof ctx.getViewPositions !== 'function') {
      throw new TypeError('VelocityOverlay context getViewPositions() is required.');
    }
    const positions = ctx.getViewPositions();
    if (
      !(positions instanceof Float32Array) ||
      positions.length !== field.cellCount * 3
    ) {
      throw new TypeError(
        `VelocityOverlay positions for view "${viewId}" must be a Float32Array with exactly three values for each field cell.`
      );
    }

    const posTexture = this._ensurePositionTexture(viewId, positions);
    const spawnState = this._ensureSpawnTable(viewId, ctx, field.cellCount);
    if (!spawnState?.textureInfo || spawnState.tableSize <= 0) return;

    this._simulate(dt, ctx, field, posTexture, spawnState);
  }

  _doRender(ctx) {
    if (!ctx || typeof ctx !== 'object') {
      throw new TypeError('VelocityOverlay render context is required.');
    }
    const dim = requireDimensionLevel(ctx.dimensionLevel);
    const field = this._activeFieldId
      ? this._fieldsById.get(this._activeFieldId)?.get(dim)
      : null;

    if (!field || this._activeParticleCount <= 0) return;

    const viewId = requireViewId(ctx.viewId);
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

    // Fullscreen geometry
    if (this._fullscreenVAO) gl.deleteVertexArray(this._fullscreenVAO);
    if (this._fullscreenAttrib0Buffer) {
      gl.deleteBuffer(this._fullscreenAttrib0Buffer);
    }
    this._fullscreenVAO = null;
    this._fullscreenAttrib0Buffer = null;

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
      if (state?.notificationId !== null) {
        getNotificationCenter().dismiss(state.notificationId);
        state.notificationId = null;
      }
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

  _createFullscreenGeometry() {
    const gl = this.gl;
    if (
      this._fullscreenVAO !== null ||
      this._fullscreenAttrib0Buffer !== null
    ) {
      throw new Error(
        'VelocityOverlay fullscreen geometry is already initialized.'
      );
    }

    const vao = gl.createVertexArray();
    if (vao === null) {
      throw new Error(
        'VelocityOverlay could not allocate the fullscreen vertex array.'
      );
    }
    const buffer = gl.createBuffer();
    if (buffer === null) {
      gl.deleteVertexArray(vao);
      throw new Error(
        'VelocityOverlay could not allocate the fullscreen attribute-zero buffer.'
      );
    }

    try {
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([0, 1, 2, 3]),
        gl.STATIC_DRAW
      );
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    } catch (error) {
      const cleanupErrors = [];
      for (const cleanup of [
        () => gl.bindVertexArray(null),
        () => gl.bindBuffer(gl.ARRAY_BUFFER, null),
        () => gl.deleteBuffer(buffer),
        () => gl.deleteVertexArray(vao),
      ]) {
        try {
          cleanup();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          'VelocityOverlay fullscreen geometry setup and cleanup both failed.'
        );
      }
      throw error;
    }

    this._fullscreenVAO = vao;
    this._fullscreenAttrib0Buffer = buffer;
  }

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
    gl.uniform1f(u.u_time, ctx.time);
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

    gl.bindVertexArray(this._fullscreenVAO);
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
    gl.uniform3fv(u.u_cameraPosition, ctx.cameraPosition);
    gl.uniform1f(u.u_viewportHeight, fbos.height);
    gl.uniform1f(u.u_fov, ctx.fov);
    gl.uniform1f(u.u_sizeAttenuation, ctx.sizeAttenuation);

    // Particle appearance
    gl.uniform1f(u.u_particleSize, this.config.particleSize * ctx.devicePixelRatio);
    gl.uniform1f(u.u_minSize, this.config.minSize);
    gl.uniform1f(u.u_maxSize, this.config.maxSize);
    gl.uniform1f(u.u_intensity, this.config.intensity);
    gl.uniform1f(u.u_glowAmount, this.config.glowAmount);
    gl.uniform1f(u.u_coreSharpness, this.config.coreSharpness);
    gl.uniform1f(u.u_cometStretch, this.config.cometStretch);

    // Velocity normalization
    gl.uniform1f(
      u.u_invMaxMagnitude,
      field.maxMagnitude === 0 ? 0 : 1.0 / field.maxMagnitude
    );

    // Visibility
    const useAlpha = ctx.useAlphaTexture;
    gl.uniform1i(u.u_useAlphaTex, useAlpha ? 1 : 0);
    gl.uniform1i(u.u_alphaTexWidth, useAlpha ? ctx.alphaTexWidth : 0);

    // Fog
    gl.uniform1f(u.u_fogNear, ctx.fogNear);
    gl.uniform1f(u.u_fogFar, ctx.fogFar);
    gl.uniform1f(u.u_fogDensity, ctx.fogDensity);
    gl.uniform3fv(u.u_fogColor, ctx.fogColor);

    // Bind textures
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, ctx.alphaTexture);
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

    gl.bindVertexArray(this._fullscreenVAO);
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
    gl.uniform1f(u.u_time, ctx.time);

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

    gl.bindVertexArray(this._fullscreenVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    gl.depthMask(true);
  }

  // ===========================================================================
  // FBO MANAGEMENT
  // ===========================================================================

  _detectTextureFormat() {
    if (this._textureFormat) return this._textureFormat;

    const gl = this.gl;
    const colorBufferFloat = gl.getExtension('EXT_color_buffer_float');
    const textureFloatLinear = gl.getExtension('OES_texture_float_linear');
    const floatBlend = gl.getExtension('EXT_float_blend');
    const formats = [];
    if (
      colorBufferFloat !== null &&
      textureFloatLinear !== null &&
      floatBlend !== null
    ) {
      formats.push(
        {
          internal: gl.RGBA16F,
          format: gl.RGBA,
          type: gl.HALF_FLOAT,
        },
        {
          internal: gl.RGBA32F,
          format: gl.RGBA,
          type: gl.FLOAT,
        }
      );
    }
    formats.push({
      internal: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
    });

    for (const fmt of formats) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, 4, 4, 0, fmt.format, fmt.type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);

      if (status === gl.FRAMEBUFFER_COMPLETE) {
        this._textureFormat = fmt;
        return fmt;
      }
    }

    throw new Error(
      'VelocityOverlay requires a complete renderable trail texture format.'
    );
  }

  _ensureFBOs(viewId, vpWidth, vpHeight) {
    const gl = this.gl;
    const key = requireViewId(viewId);
    requireNumber(vpWidth, 'viewportWidth', Number.MIN_VALUE, Number.MAX_VALUE);
    requireNumber(vpHeight, 'viewportHeight', Number.MIN_VALUE, Number.MAX_VALUE);

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
      throw new Error(
        `VelocityOverlay framebuffer is incomplete for view "${key}" (status ${status}).`
      );
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
    const key = requireViewId(viewId);
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
    const camPos = ctx.cameraPosition;
    const viewMatrix = ctx.viewMatrix;

    let motion = 0;

    // Check camera position change
    if (this._lastCameraPosition) {
      const dx = camPos[0] - this._lastCameraPosition[0];
      const dy = camPos[1] - this._lastCameraPosition[1];
      const dz = camPos[2] - this._lastCameraPosition[2];
      const posDelta = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // Normalize by camera distance for scale-independent motion detection
      motion = posDelta / ctx.cameraDistance;
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
    const key = requireViewId(viewId);
    const prev = this._positionsRefByView.get(key);

    if (prev === positions3D) {
      const entry = this._positionTexturePool.get(positions3D);
      if (!entry?.textureInfo) {
        throw new Error(
          `VelocityOverlay position texture ownership is invalid for view "${key}".`
        );
      }
      return entry.textureInfo;
    }

    let entry = this._positionTexturePool.get(positions3D);
    if (!entry) {
      const textureInfo = createOrUpdatePackedFloatTexture(this.gl, {
        texture: null,
        data: positions3D,
        itemCount: positions3D.length / 3,
        components: 3
      });
      entry = { textureInfo, refs: 0 };
      this._positionTexturePool.set(positions3D, entry);
    }
    if (prev) {
      this._releasePositionTexture(prev);
    }
    this._positionsRefByView.set(key, positions3D);
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
    const key = requireViewId(viewId);
    let state = this._spawnByView.get(key);

    if (!state) {
      state = {
        dirty: true,
        version: 0,
        building: false,
        notificationId: null,
        textureInfo: null,
        tableSize: 0,
        tableWidth: 1,
        lastLod: null
      };
      this._spawnByView.set(key, state);
    }

    // Check LOD change
    if (typeof ctx.getLodLevel !== 'function') {
      throw new TypeError('VelocityOverlay context getLodLevel() is required.');
    }
    const lod = ctx.getLodLevel();
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
    state.notificationId = notifId;

    const schedule = typeof requestIdleCallback === 'function'
      ? fn => requestIdleCallback(fn, { timeout: 500 })
      : fn => setTimeout(fn, 0);

    schedule(() => {
      const ownsState = this._spawnByView.get(key) === state;
      if (
        this._disposed ||
        !ownsState ||
        state.version !== scheduledVersion
      ) {
        if (ownsState) {
          state.building = false;
          state.dirty = true;
        }
        if (state.notificationId === notifId && notifId !== null) {
          notifications.dismiss(notifId);
          state.notificationId = null;
        }
        return;
      }

      let success = false;
      try {
        if (typeof ctx.getViewTransparency !== 'function') {
          throw new TypeError(
            'VelocityOverlay context getViewTransparency() is required.'
          );
        }
        const transparency = ctx.getViewTransparency();
        if (
          !(transparency instanceof Float32Array) ||
          transparency.length !== cellCount
        ) {
          throw new TypeError(
            `VelocityOverlay transparency for view "${key}" must contain exactly one Float32 value per field cell.`
          );
        }

        if (typeof ctx.getLodIndices !== 'function') {
          throw new TypeError('VelocityOverlay context getLodIndices() is required.');
        }
        const lodIndices = this.config.syncWithLOD ? ctx.getLodIndices() : null;

        const table = this._buildSpawnTable(transparency, cellCount, lodIndices);
        if (table.length <= 0) {
          if (state.textureInfo !== null) {
            this.gl.deleteTexture(state.textureInfo.texture);
          }
          state.tableSize = 0;
          state.tableWidth = 1;
          state.textureInfo = null;
          success = true;
          return;
        }

        const existingTexture = state.textureInfo === null
          ? null
          : state.textureInfo.texture;
        const textureInfo = createOrUpdatePackedUintTexture(this.gl, {
          texture: existingTexture,
          data: table,
          itemCount: table.length
        });

        state.textureInfo = textureInfo;
        state.tableSize = table.length;
        state.tableWidth = textureInfo.width;
        success = true;
      } catch (err) {
        this.enabled = false;
        notifications.error(
          `Velocity overlay preparation failed: ${err.message}`,
          { category: 'render' }
        );
      } finally {
        state.building = false;
        state.dirty = !(success && state.version === scheduledVersion);

        if (notifId) {
          if (success) {
            notifications.complete(
              notifId,
              state.tableSize > 0
                ? 'Velocity overlay ready'
                : 'Velocity overlay ready (no visible cells)'
            );
          } else {
            notifications.fail(notifId, 'Velocity overlay unavailable');
          }
        }
        if (state.notificationId === notifId) {
          state.notificationId = null;
        }
      }
    });

    return state;
  }

  _buildSpawnTable(transparency, cellCount, lodIndices) {
    if (
      !(transparency instanceof Float32Array) ||
      !Number.isSafeInteger(cellCount) ||
      cellCount < 0 ||
      transparency.length !== cellCount
    ) {
      throw new TypeError(
        'VelocityOverlay spawn sampling requires exactly one Float32 transparency value per cell.'
      );
    }
    if (lodIndices !== null && !(lodIndices instanceof Uint32Array)) {
      throw new TypeError(
        'VelocityOverlay LOD spawn candidates must be a Uint32Array or null.'
      );
    }
    const candidates = lodIndices;
    const candidateCount = candidates ? candidates.length : cellCount;
    const maxSize = Math.min(this.config.spawnTableSize, candidateCount);
    const table = new Uint32Array(maxSize);
    const threshold = 0.01;
    const seed = (
      0x9e3779b9
      ^ Math.imul(cellCount, 0x85ebca6b)
      ^ Math.imul(candidateCount, 0xc2b2ae35)
    ) >>> 0;
    const rng = createRNG(seed);
    let filled = 0;
    let visibleCount = 0;

    for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex++) {
      const idx = candidates ? candidates[candidateIndex] : candidateIndex;
      if (idx >= cellCount) {
        throw new RangeError(
          `VelocityOverlay LOD spawn index ${idx} exceeds the ${cellCount}-cell field.`
        );
      }
      if (transparency[idx] <= threshold) continue;

      visibleCount++;
      if (filled < maxSize) {
        table[filled++] = idx;
        continue;
      }

      const replacementIndex = rng.nextInt(visibleCount);
      if (replacementIndex < maxSize) {
        table[replacementIndex] = idx;
      }
    }

    return filled === table.length ? table : table.slice(0, filled);
  }
}
