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
import {
  configureStraightAlphaBlending,
  createProgram,
  createTransformFeedbackProgram,
} from '../../gl-utils.js';
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
import { POINT_VISIBILITY_THRESHOLD } from '../../alpha-visibility.js';

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
  // Bound all published trail/bloom targets across the active pane layout.
  // This is deliberately independent of particle/derived texture residency.
  renderTargetByteBudget: 256 * 1024 * 1024,
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
export const DEFAULT_VELOCITY_RENDER_TARGET_BYTE_BUDGET =
  CONFIG.renderTargetByteBudget;

// Particle data layout: position (vec3) + velocity (vec3) + age (float) + cellIndex (uint)
// = 3 + 3 + 1 + 1 = 8 floats worth (28 bytes with padding)
const FLOATS_PER_PARTICLE = 8;
const BYTES_PER_PARTICLE = FLOATS_PER_PARTICLE * 4;
const TRANSPARENT_BLACK = new Float32Array([0, 0, 0, 0]);
const SPAWN_BUILD_BATCH_ITEMS = 2_048;
const SPAWN_BUILD_MIN_ITEMS_PER_SLICE = 4_096;
const SPAWN_BUILD_MAX_ITEMS_PER_SLICE = 65_536;
const SPAWN_BUILD_TIME_BUDGET_MS = 4;
const SPAWN_BUILD_IDLE_FLOOR_MS = 1;
const VELOCITY_PROGRAM_KEYS = Object.freeze([
  '_programUpdate',
  '_programRender',
  '_programFade',
  '_programThreshold',
  '_programBlur',
  '_programAnamorphic',
  '_programComposite',
]);
const VELOCITY_UNIFORM_KEYS = Object.freeze([
  '_uniformsUpdate',
  '_uniformsRender',
  '_uniformsFade',
  '_uniformsThreshold',
  '_uniformsBlur',
  '_uniformsAnamorphic',
  '_uniformsComposite',
]);

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

function appendFailure(failures, error) {
  if (failures === null) return [error];
  failures.push(error);
  return failures;
}

function throwCollectedFailures(failures, message) {
  if (failures === null) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
}

function requirePositiveSafeInteger(value, key) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      `VelocityOverlay ${key} must be a positive safe integer.`
    );
  }
  return value;
}

function getVelocityFrameScale(dt, key) {
  requireNumber(dt, key, 0, Number.MAX_VALUE);
  // Match the simulation shader's elapsed-time safety cap.
  return Math.min(dt, 0.05) * 60;
}

function normalizeVelocityDropChance(probabilityAt60Hz, frameScale) {
  const probability = Math.max(0, Math.min(1, probabilityAt60Hz));
  return 1 - Math.pow(1 - probability, frameScale);
}

function nextParticleCapacity(requested, maximum) {
  requirePositiveSafeInteger(requested, 'requested particle capacity');
  requirePositiveSafeInteger(maximum, 'maximum particle capacity');
  if (requested > maximum) {
    throw new RangeError(
      `VelocityOverlay requested particle capacity ${requested} exceeds ${maximum}.`
    );
  }
  let capacity = 1;
  while (capacity < requested && capacity < maximum) {
    capacity *= 2;
  }
  return Math.min(capacity, maximum);
}

/**
 * Compute the exact bounded render-target geometry and retained byte count.
 * The aspect ratio is preserved when a requested resolution exceeds either
 * the texture or viewport limits exposed by the current WebGL2 device.
 */
export function computeVelocityRenderTargetLayout(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype ||
    Object.keys(options).sort().join(',') !==
      'bloomEnabled,byteBudget,bytesPerPixel,maxTextureSize,maxViewportHeight,maxViewportWidth,resolution,viewportHeight,viewportWidth'
  ) {
    throw new TypeError(
      'Velocity render-target layout options must contain exactly bloomEnabled, byteBudget, bytesPerPixel, maxTextureSize, maxViewportHeight, maxViewportWidth, resolution, viewportHeight, and viewportWidth.'
    );
  }
  const viewportWidth = requirePositiveSafeInteger(
    options.viewportWidth,
    'viewportWidth'
  );
  const viewportHeight = requirePositiveSafeInteger(
    options.viewportHeight,
    'viewportHeight'
  );
  const maxTextureSize = requirePositiveSafeInteger(
    options.maxTextureSize,
    'MAX_TEXTURE_SIZE'
  );
  const maxViewportWidth = requirePositiveSafeInteger(
    options.maxViewportWidth,
    'MAX_VIEWPORT_DIMS width'
  );
  const maxViewportHeight = requirePositiveSafeInteger(
    options.maxViewportHeight,
    'MAX_VIEWPORT_DIMS height'
  );
  const bytesPerPixel = requirePositiveSafeInteger(
    options.bytesPerPixel,
    'render-target bytes per pixel'
  );
  const byteBudget = requirePositiveSafeInteger(
    options.byteBudget,
    'render-target byte budget'
  );
  const resolution = requireNumber(
    options.resolution,
    'trailResolution',
    0.25,
    2
  );
  const bloomEnabled = requireBoolean(
    options.bloomEnabled,
    'render-target bloomEnabled'
  );
  // Two trail targets plus, when requested, two half-resolution bloom targets.
  // The continuous upper bound is conservative because the allocated integer
  // dimensions are floored below.
  const targetPixelFactor = bloomEnabled ? 2.5 : 2;
  const budgetScale = Math.sqrt(
    byteBudget /
      (viewportWidth * viewportHeight * bytesPerPixel * targetPixelFactor)
  );
  const effectiveScale = Math.min(
    resolution,
    budgetScale,
    maxTextureSize / viewportWidth,
    maxTextureSize / viewportHeight,
    maxViewportWidth / viewportWidth,
    maxViewportHeight / viewportHeight
  );
  if (!Number.isFinite(effectiveScale) || effectiveScale <= 0) {
    throw new Error('VelocityOverlay could not derive a renderable target scale.');
  }
  const width = Math.max(1, Math.floor(viewportWidth * effectiveScale));
  const height = Math.max(1, Math.floor(viewportHeight * effectiveScale));
  const bloomWidth = bloomEnabled ? Math.max(1, Math.floor(width / 2)) : 0;
  const bloomHeight = bloomEnabled ? Math.max(1, Math.floor(height / 2)) : 0;
  const trailPixels = 2n * BigInt(width) * BigInt(height);
  const bloomPixels = bloomEnabled
    ? 2n * BigInt(bloomWidth) * BigInt(bloomHeight)
    : 0n;
  const bytes = (trailPixels + bloomPixels) * BigInt(bytesPerPixel);
  if (bytes > BigInt(byteBudget)) {
    throw new RangeError(
      'VelocityOverlay render-target byte budget is too small for the minimum target layout.'
    );
  }
  return Object.freeze({
    bloomEnabled,
    bloomHeight,
    bloomWidth,
    bytes,
    height,
    rasterScale: height / viewportHeight,
    width,
  });
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
    case 'renderTargetByteBudget':
      exactValue = requireNumber(
        value,
        exactKey,
        1024 * 1024,
        Number.MAX_SAFE_INTEGER,
        true
      );
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
    const config = {
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
      renderTargetByteBudget: readNumberOption(
        options,
        'renderTargetByteBudget',
        1024 * 1024,
        Number.MAX_SAFE_INTEGER,
        true
      ),
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
    if (config.minSize > config.maxSize) {
      throw new RangeError(
        'VelocityOverlay minSize must be less than or equal to maxSize.'
      );
    }
    this.config = config;

    // Vector field storage: fieldId -> dimensionLevel -> field data
    this._fieldsById = new Map();
    this._activeFieldId = null;

    // Position texture pool (shared across views)
    this._positionTexturePool = new Map();
    this._positionsRefByView = new Map();
    this._pendingDerivedTextureDeletes = new Map();

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

    // Particle simulation is independent per rendered view. Buffers are
    // allocated lazily at the requested count instead of the 500K ceiling.
    this._particleByView = new Map();
    this._pendingParticleRetirements = new Set();
    this._residentParticleBytes = 0n;

    // Transform feedback
    this._transformFeedback = null;

    // Colormap texture
    this._colormapTexture = null;
    this._pendingColormapTextureDeletes = new Set();

    // FBOs per view
    this._fboByView = new Map();
    this._pendingFBORetirements = new Set();
    this._residentFBOBytes = 0n;
    this._activeRenderViewCount = 1;

    // Texture format detection
    this._textureFormat = null;
    this._renderTargetLimits = null;

    // Fullscreen passes use gl_VertexID, but Firefox desktop OpenGL still
    // requires an enabled attribute-zero array to avoid emulation.
    this._fullscreenVAO = null;
    this._fullscreenAttrib0Buffer = null;

    this._contextLost = false;
    this._disposePending = false;
    this._failureHandler = null;
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  setActiveField(fieldId) {
    this._assertMutableLifecycle('set the active velocity field');
    const nextFieldId = validateActiveVelocityFieldId(fieldId);
    if (nextFieldId === this._activeFieldId) {
      if (nextFieldId === null) {
        // A prior attempt may have detached ownership but failed one or more
        // WebGL/DOM deletions. A repeated null publication is the explicit
        // convergence point for those retry queues.
        this._releaseDisabledResources(true);
      }
      return;
    }
    this._activeFieldId = nextFieldId;

    const viewIds = new Set([
      ...this._spawnByView.keys(),
      ...this._particleByView.keys(),
      ...this._fboByView.keys(),
    ]);
    if (nextFieldId !== null) {
      const nextFieldByDimension = this._fieldsById.get(nextFieldId);
      for (const [viewId, spawn] of this._spawnByView) {
        const nextField = Number.isInteger(spawn.dimensionLevel)
          ? nextFieldByDimension?.get(spawn.dimensionLevel)
          : null;
        // Spawn indices and exact visibility are independent of vector values.
        // Preserve a ready generation whenever the next field has the same
        // cell ownership; only the particles/trails need a new generation.
        if (
          nextField &&
          Number.isSafeInteger(spawn.cellCount) &&
          spawn.cellCount !== nextField.cellCount
        ) {
          spawn.dirty = true;
          spawn.version++;
          spawn.ready = false;
        }
        viewIds.add(viewId);
      }
    }

    let failures = null;
    for (const viewId of viewIds) {
      try {
        this._invalidateViewGeneration(viewId);
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    if (nextFieldId === null) {
      try {
        this._releaseDisabledResources(true);
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    throwCollectedFailures(
      failures,
      'VelocityOverlay active-field transition was incomplete.'
    );
  }

  getActiveFieldId() {
    return this._activeFieldId;
  }

  /**
   * Return the actual retained render-target quality for one view. Requested
   * resolution can be lower in practice because of hardware limits, the
   * cross-view byte budget, or a staged lower-cost allocation candidate.
   */
  getRenderTargetStatus(viewId) {
    const key = requireViewId(viewId);
    const generation = this._fboByView.get(key);
    if (!generation) return null;
    const format = generation.textureFormat ?? this._textureFormat;
    return Object.freeze({
      bloomEnabled: generation.bloomEnabled,
      byteBudget: generation.targetByteBudget,
      bytes: generation.bytes,
      bytesPerPixel: format.bytesPerPixel,
      degraded: generation.qualityTier > 0,
      height: generation.height,
      qualityTier: generation.qualityTier,
      rasterScale: generation.rasterScale,
      requestedBloomEnabled: generation.requestedBloomEnabled,
      requestedResolution: generation.requestedResolution,
      sourceViewportHeight: generation.sourceViewportHeight,
      sourceViewportWidth: generation.sourceViewportWidth,
      width: generation.width,
    });
  }

  setFailureHandler(handler) {
    this._assertMutableLifecycle('set a failure handler');
    if (typeof handler !== 'function') {
      throw new TypeError(
        'VelocityOverlay failure handler must be an exact function.'
      );
    }
    this._failureHandler = handler;
  }

  setVectorFieldData(fieldId, dimensionLevel, fieldData) {
    this._assertMutableLifecycle('publish vector-field data');
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
    const replacedBinding =
      existing !== undefined &&
      this.gl.getParameter(this.gl.TEXTURE_BINDING_2D) === existing.texture;
    const textureInfo = createOrUpdatePackedFloatTexture(this.gl, {
      texture: null,
      data: validated.vectors,
      itemCount: validated.cellCount,
      components: validated.components
    });
    if (existing?.texture) {
      try {
        this._queueDerivedTextureDelete(
          existing,
          existing.components * 4
        );
      } catch (error) {
        let cleanupFailures = null;
        try {
          this._queueDerivedTextureDelete(
            textureInfo,
            textureInfo.components * 4
          );
        } catch (cleanupError) {
          cleanupFailures = appendFailure(
            cleanupFailures,
            cleanupError
          );
        }
        const deletionFailures =
          this._flushPendingDerivedTextureDeletes();
        if (deletionFailures !== null) {
          for (const cleanupError of deletionFailures) {
            cleanupFailures = appendFailure(
              cleanupFailures,
              cleanupError
            );
          }
        }
        if (cleanupFailures !== null) {
          throw new AggregateError(
            [error, ...cleanupFailures],
            'VelocityOverlay field staging and cleanup were incomplete.'
          );
        }
        throw error;
      }
    }

    perField.set(validated.dimension, {
      ...textureInfo,
      cellCount: validated.cellCount,
      maxMagnitude: validated.maxMagnitude
    });
    this._fieldsById.set(validated.id, perField);
    if (existing?.texture) {
      let retirementFailures = null;
      if (replacedBinding) {
        try {
          this.gl.bindTexture(
            this.gl.TEXTURE_2D,
            textureInfo.texture
          );
        } catch (error) {
          retirementFailures = appendFailure(
            retirementFailures,
            error
          );
        }
      }
      const deletionFailures =
        this._flushPendingDerivedTextureDeletes();
      if (deletionFailures !== null) {
        for (const error of deletionFailures) {
          retirementFailures = appendFailure(
            retirementFailures,
            error
          );
        }
      }
      this._reportDerivedRetirementFailures(
        retirementFailures,
        `VelocityOverlay field "${validated.id}" ${validated.dimension}D retirement was incomplete.`
      );
    }

    if (this._activeFieldId === null) {
      this.setActiveField(validated.id);
    } else if (this._activeFieldId === validated.id) {
      this._invalidateActiveFieldDimension(
        validated.dimension,
        validated.cellCount
      );
    }
  }

  hasFieldForDimension(fieldId, dimensionLevel) {
    const id = validateVelocityFieldId(fieldId);
    const dim = requireDimensionLevel(dimensionLevel);
    const fields = this._fieldsById.get(id);
    return fields !== undefined && fields.has(dim);
  }

  markVisibilityDirty(viewId) {
    this._assertMutableLifecycle('invalidate visibility');
    const key = requireViewId(viewId);
    const state = this._spawnByView.get(key);
    if (state) {
      state.dirty = true;
      state.version++;
      state.ready = false;
    }
    this._invalidateViewGeneration(key);
  }

  markDimensionDirty(viewId) {
    this._assertMutableLifecycle('invalidate a dimension');
    const key = requireViewId(viewId);
    const state = this._spawnByView.get(key);
    if (state) {
      state.dirty = true;
      state.version++;
      state.ready = false;
    }
    // Dimension/sampling transitions can change visibility and LOD ownership,
    // but the renderer-owned position snapshot remains reusable when its exact
    // Float32 identity is unchanged.
    this._invalidateViewGeneration(key);
  }

  markGeometryDirty(viewId) {
    this._assertMutableLifecycle('invalidate geometry');
    const key = requireViewId(viewId);
    const positionEntry = this._positionsRefByView.get(key);
    if (positionEntry) {
      this._positionsRefByView.delete(key);
      // The source array may have been mutated in place. Retire this
      // generation from the reusable pool before releasing the view ref so
      // another owner can keep rendering the immutable GPU snapshot while
      // this view publishes a fresh upload for the same JS identity.
      if (
        this._positionTexturePool.get(positionEntry.source) === positionEntry
      ) {
        this._positionTexturePool.delete(positionEntry.source);
      }
      this._reportDerivedRetirementFailures(
        this._releasePositionTexture(positionEntry),
        `VelocityOverlay view "${key}" position retirement was incomplete.`
      );
    }
    const spawn = this._spawnByView.get(key);
    if (spawn) {
      spawn.dirty = true;
      spawn.version++;
      spawn.ready = false;
    }
    this._invalidateViewGeneration(key);
  }

  setEnabled(enabled) {
    const nextEnabled = requireBoolean(enabled, 'enabled');
    if (
      this._disposeRequested ||
      this._disposed ||
      this._disposePending
    ) {
      throw new Error(
        'VelocityOverlay cannot change enabled state while disposal-pending or disposed.'
      );
    }
    if (nextEnabled === this.enabled) {
      if (!nextEnabled) {
        // A failed WebGL deletion remains explicitly owned and retryable.
        this._releaseDisabledResources(false);
      }
      return;
    }
    if (!nextEnabled) {
      this.enabled = false;
      this._releaseDisabledResources(true);
      return;
    }
    if (this._disposed || this._disposePending) {
      throw new Error(
        'VelocityOverlay cannot enable a disposed or disposal-pending instance.'
      );
    }
    try {
      this.init();
    } catch (error) {
      this.enabled = false;
      // _doInit owns transactional cleanup. Keep a transiently failed overlay
      // registered and retryable instead of poisoning it with `_disposed`.
      throw error;
    }
    if (!this._initialized) {
      throw new Error(
        'VelocityOverlay initialization did not publish a ready instance.'
      );
    }
    // Do not re-enable while an earlier disable still owns undeleted derived
    // textures. The retry either converges or leaves the overlay safely off.
    this._releaseDisabledResources(false);
    this.enabled = true;
    this._invalidateAllViewGenerations({ spawnDirty: true });
  }

  /**
   * Publish the exact views that will render in this frame. Dormant heavyweight
   * particle and trail targets are retired before a newly focused view can
   * allocate its generation. Active panes receive deterministic equal shares
   * of the global render-target byte budget.
   *
   * @param {string[]} viewIds
   */
  prepareFrame(viewIds) {
    if (
      this._disposeRequested ||
      this._disposed ||
      this._disposePending
    ) {
      return;
    }
    if (!Array.isArray(viewIds)) {
      throw new TypeError(
        'VelocityOverlay prepareFrame requires an exact array of view IDs.'
      );
    }
    for (let index = 0; index < viewIds.length; index++) {
      requireViewId(viewIds[index]);
      if (viewIds.indexOf(viewIds[index]) !== index) {
        throw new Error(
          `VelocityOverlay prepareFrame received duplicate view "${viewIds[index]}".`
        );
      }
    }
    if (this._contextLost) return;
    this._activeRenderViewCount = Math.max(1, viewIds.length);

    let failures = null;
    for (const key of this._fboByView.keys()) {
      if (viewIds.includes(key)) continue;
      try {
        this._disposeFBOs(key);
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    for (const key of this._particleByView.keys()) {
      if (viewIds.includes(key)) continue;
      try {
        this._disposeParticleState(key);
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    throwCollectedFailures(
      failures,
      'VelocityOverlay dormant view retirement was incomplete.'
    );
  }

  handleContextLost() {
    if (this._contextLost) return;
    if (this._disposed) return;
    this._contextLost = true;
    this._disposeRequested = true;
    this.enabled = false;
    const notifications = getNotificationCenter();
    let failures = null;
    for (const state of this._spawnByView.values()) {
      state.version++;
      state.ready = false;
      state.dirty = true;
      state.building = false;
      state.buildToken = null;
      state.tableSize = 0;
      state.tableWidth = 1;
      state.textureInfo = null;
      state.visibilityTextureInfo = null;
      if (state.notificationId !== null) {
        const notificationId = state.notificationId;
        state.notificationId = null;
        try {
          notifications.dismiss(notificationId);
        } catch (error) {
          failures = appendFailure(failures, error);
        }
      }
    }
    // A lost WebGL context invalidates every object without requiring (or
    // permitting) explicit deletion. Pending idle callbacks are fenced by the
    // context-lost flag and version increments above.
    this._particleByView.clear();
    this._pendingParticleRetirements.clear();
    this._fboByView.clear();
    this._pendingFBORetirements.clear();
    this._positionTexturePool.clear();
    this._positionsRefByView.clear();
    this._pendingDerivedTextureDeletes.clear();
    this._colormapTexture = null;
    this._getPendingColormapTextureDeletes().clear();
    this._fieldsById?.clear();
    this._spawnByView.clear();
    this._activeFieldId = null;
    this._transformFeedback = null;
    this._fullscreenVAO = null;
    this._fullscreenAttrib0Buffer = null;
    for (const name of VELOCITY_PROGRAM_KEYS) this[name] = null;
    for (const name of VELOCITY_UNIFORM_KEYS) this[name] = null;
    this._failureHandler = null;
    this._residentParticleBytes = 0n;
    this._residentFBOBytes = 0n;
    this.gl = null;
    throwCollectedFailures(
      failures,
      'VelocityOverlay context-loss notification cleanup was incomplete.'
    );
  }

  disposeView(viewId) {
    if (
      this._disposeRequested ||
      this._disposed ||
      this._disposePending
    ) {
      return;
    }
    const key = requireViewId(viewId);
    const spawn = this._spawnByView.get(key);
    this._spawnByView.delete(key);
    const positionEntry = this._positionsRefByView.get(key);
    this._positionsRefByView.delete(key);
    if (spawn) {
      spawn.version++;
      spawn.ready = false;
    }

    let failures = null;
    const attempt = operation => {
      try {
        operation();
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    };
    if (spawn && spawn.notificationId !== null) {
      const notificationId = spawn.notificationId;
      spawn.notificationId = null;
      attempt(() => getNotificationCenter().dismiss(notificationId));
    }
    if (spawn?.textureInfo?.texture) {
      attempt(() => this._queueDerivedTextureDelete(
        spawn.textureInfo,
        4
      ));
    }
    if (spawn?.visibilityTextureInfo?.texture) {
      attempt(() => this._queueDerivedTextureDelete(
        spawn.visibilityTextureInfo,
        4
      ));
    }
    if (positionEntry) {
      try {
        const releaseFailures =
          this._releasePositionTexture(positionEntry);
        if (releaseFailures !== null) {
          for (const error of releaseFailures) {
            failures = appendFailure(failures, error);
          }
        }
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    const derivedFailures = this._flushPendingDerivedTextureDeletes();
    if (derivedFailures !== null) {
      for (const error of derivedFailures) {
        failures = appendFailure(failures, error);
      }
    }

    attempt(() => this._disposeParticleState(key));
    attempt(() => this._disposeFBOs(key));
    throwCollectedFailures(
      failures,
      `VelocityOverlay view "${key}" disposal was incomplete.`
    );
  }

  setConfig(key, value) {
    this._assertMutableLifecycle('change configuration');
    const validated = validateVelocityOverlayConfig(
      key,
      value,
      this.config.particleCapacity
    );
    if (
      validated.key === 'minSize' &&
      validated.value > this.config.maxSize
    ) {
      throw new RangeError(
        'VelocityOverlay minSize must be less than or equal to maxSize.'
      );
    }
    if (
      validated.key === 'maxSize' &&
      validated.value < this.config.minSize
    ) {
      throw new RangeError(
        'VelocityOverlay maxSize must be greater than or equal to minSize.'
      );
    }
    this.init();

    const cfg = this.config;
    const previousValue = cfg[validated.key];
    if (Object.is(validated.value, previousValue)) {
      if (
        validated.key === 'colormapId' &&
        this._getPendingColormapTextureDeletes().size > 0
      ) {
        this._reportDerivedRetirementFailures(
          this._flushPendingColormapTextureDeletes(),
          'VelocityOverlay pending colormap retirement was incomplete.'
        );
      }
      return;
    }
    cfg[validated.key] = validated.value;
    if (
      validated.key === 'trailResolution' ||
      validated.key === 'renderTargetByteBudget'
    ) {
      // The next render stages a correctly sized generation before retiring
      // the current one. Repeated slider input therefore coalesces to the final
      // requested resolution without synchronous GPU allocation churn.
    } else if (validated.key === 'colormapId') {
      try {
        this._updateColormap();
      } catch (error) {
        cfg[validated.key] = previousValue;
        throw error;
      }
      this._scheduleAllTrailClears();
    } else if (
      validated.key === 'spawnTableSize' ||
      validated.key === 'syncWithLOD'
    ) {
      this._invalidateAllViewGenerations({ spawnDirty: true });
    } else if (
      validated.key === 'particleCount' &&
      validated.value !== previousValue
    ) {
      if (validated.value === 0) {
        this._releaseAllRenderResources();
      } else {
        // A larger count can expose zero-filled tail slots in an existing
        // capacity. Reset the complete generation so every newly active slot
        // is initialized through the force-respawn simulation pass, and clear
        // trails so a density change is published atomically.
        this._invalidateAllViewGenerations({ spawnDirty: false });
      }
    } else if (
      validated.key === 'particleSize' ||
      validated.key === 'minSize' ||
      validated.key === 'maxSize' ||
      validated.key === 'intensity' ||
      validated.key === 'glowAmount' ||
      validated.key === 'coreSharpness' ||
      validated.key === 'cometStretch'
    ) {
      this._scheduleAllTrailClears();
    }
  }

  // ===========================================================================
  // OVERLAY LIFECYCLE
  // ===========================================================================

  _doInit() {
    const gl = this.gl;
    // A prior failed cleanup can retain exact handles for retry. Converge that
    // ownership before publishing another initialization attempt.
    this._releaseInitializationResources();

    try {
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

      this._transformFeedback = gl.createTransformFeedback();
      if (this._transformFeedback === null) {
        throw new Error(
          'VelocityOverlay could not allocate transform-feedback ownership.'
        );
      }

      this._updateColormap();
      this._createFullscreenGeometry();
      this._bindSamplers();
    } catch (error) {
      try {
        this._releaseInitializationResources();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'VelocityOverlay initialization and cleanup were incomplete.'
        );
      }
      throw error;
    }
  }

  _doUpdate(dt, ctx) {
    if (!ctx || typeof ctx !== 'object') {
      throw new TypeError('VelocityOverlay update context is required.');
    }
    requireNumber(dt, 'update delta', 0, Number.MAX_VALUE);
    if (this._contextLost) return;
    const viewId = requireViewId(ctx.viewId);
    const frameId = ctx.frameId;
    if (!Number.isSafeInteger(frameId) || frameId < 0) {
      throw new RangeError(
        'VelocityOverlay context frameId must be a non-negative safe integer.'
      );
    }
    const dim = requireDimensionLevel(ctx.dimensionLevel);
    const field = this._activeFieldId
      ? this._fieldsById.get(this._activeFieldId)?.get(dim)
      : null;

    if (!field) {
      this._invalidateViewGeneration(viewId);
      this._disposeParticleState(viewId);
      this._disposeFBOs(viewId);
      return;
    }
    this.visible = true;

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
        // Coarseness is measured from full detail, not from zero. LOD level 0 is
        // the *coarsest* level and the last level is full detail, so comparing
        // the raw level against ascending thresholds reads the ladder backwards:
        // it awarded the full particle count to the coarsest level and disposed
        // the overlay at full detail, which is the exact inverse of the
        // documented behaviour ("the flow vanishes with the camera zoomed out").
        if (typeof ctx.getLodLevelCount !== 'function') {
          throw new TypeError(
            'VelocityOverlay context getLodLevelCount() is required.'
          );
        }
        const levelCount = ctx.getLodLevelCount();
        if (!Number.isInteger(levelCount) || levelCount < 1) {
          throw new RangeError(
            'VelocityOverlay context LOD level count must be a positive integer.'
          );
        }
        const stepsBelowFullDetail = levelCount - 1 - lod;
        const factor = stepsBelowFullDetail >= 6
          ? 0
          : stepsBelowFullDetail >= 3
            ? 0.25
            : stepsBelowFullDetail >= 1 ? 0.5 : 1.0;
        targetCount = Math.floor(targetCount * factor);
      }
    }
    if (targetCount <= 0) {
      this._disposeParticleState(viewId);
      this._disposeFBOs(viewId);
      return;
    }

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
    if (
      !spawnState?.ready ||
      spawnState.dirty ||
      !spawnState.textureInfo ||
      !spawnState.visibilityTextureInfo ||
      spawnState.tableSize <= 0
    ) {
      const existing = this._particleByView.get(viewId);
      if (spawnState?.ready && !spawnState.dirty) {
        // A published empty visibility generation cannot become useful without
        // another invalidation, so release both heavyweight particle storage
        // and the prior trail/bloom generation immediately.
        this._disposeParticleState(viewId);
        this._disposeFBOs(viewId);
      } else if (existing) {
        existing.activeParticleCount = 0;
        existing.forceRespawn = true;
      }
      return;
    }

    const particleState = this._ensureParticleState(viewId, targetCount);
    const identityChanged =
      particleState.fieldId !== this._activeFieldId ||
      particleState.dimensionLevel !== dim ||
      particleState.positionsRef !== positions ||
      particleState.readyGeneration !== spawnState.generation;
    if (identityChanged) {
      particleState.fieldId = this._activeFieldId;
      particleState.dimensionLevel = dim;
      particleState.positionsRef = positions;
      particleState.readyGeneration = spawnState.generation;
      particleState.forceRespawn = true;
      particleState.lastAdvancedFrameId = -1;
      particleState.lastCameraPosition = null;
      particleState.lastViewMatrix = null;
      particleState.cameraMotionAmount = 0;
      this._scheduleTrailClear(viewId);
    }
    if (
      !identityChanged &&
      particleState.activeParticleCount !== targetCount
    ) {
      particleState.forceRespawn = true;
      particleState.lastAdvancedFrameId = -1;
      particleState.lastCameraPosition = null;
      particleState.lastViewMatrix = null;
      particleState.cameraMotionAmount = 0;
      this._scheduleTrailClear(viewId);
    }
    particleState.activeParticleCount = targetCount;
    this._updateCameraMotion(ctx, particleState, dt);
    this._simulate(
      dt,
      ctx,
      field,
      posTexture,
      spawnState,
      particleState
    );
  }

  _doRender(ctx) {
    if (!ctx || typeof ctx !== 'object') {
      throw new TypeError('VelocityOverlay render context is required.');
    }
    if (this._contextLost) return;
    const viewId = requireViewId(ctx.viewId);
    const dim = requireDimensionLevel(ctx.dimensionLevel);
    const field = this._activeFieldId
      ? this._fieldsById.get(this._activeFieldId)?.get(dim)
      : null;
    const particleState = this._particleByView.get(viewId);
    const spawnState = this._spawnByView.get(viewId);
    if (
      !field ||
      !particleState ||
      particleState.activeParticleCount <= 0 ||
      particleState.readyGeneration !== spawnState?.generation ||
      !spawnState.ready ||
      spawnState.dirty ||
      spawnState.tableSize <= 0 ||
      !spawnState.textureInfo ||
      !spawnState.visibilityTextureInfo
    ) {
      return;
    }
    this._renderFlow(ctx, field, viewId, particleState, spawnState);
  }

  _getPendingColormapTextureDeletes() {
    if (!(this._pendingColormapTextureDeletes instanceof Set)) {
      this._pendingColormapTextureDeletes = new Set();
    }
    return this._pendingColormapTextureDeletes;
  }

  _flushPendingColormapTextureDeletes() {
    let failures = null;
    const pending = this._getPendingColormapTextureDeletes();
    for (const texture of pending) {
      try {
        this.gl.deleteTexture(texture);
        pending.delete(texture);
      } catch (error) {
        // Instrumented WebGL wrappers can delete successfully and then throw.
        // Only retain the handle when liveness is still confirmed (or cannot
        // be determined), otherwise a retry could loop forever on a texture
        // whose WebGL ownership has already ended.
        if (typeof this.gl.isTexture === 'function') {
          try {
            if (this.gl.isTexture(texture) === false) {
              pending.delete(texture);
              continue;
            }
          } catch (inspectionError) {
            failures = appendFailure(
              failures,
              new AggregateError(
                [error, inspectionError],
                'VelocityOverlay colormap texture retirement state could not be determined.'
              )
            );
            continue;
          }
        }
        failures = appendFailure(failures, error);
      }
    }
    return failures;
  }

  _releaseInitializationResources() {
    const gl = this.gl;
    let failures = null;

    if (this._transformFeedback) {
      try {
        gl.deleteTransformFeedback(this._transformFeedback);
        this._transformFeedback = null;
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    for (const name of VELOCITY_PROGRAM_KEYS) {
      const program = this[name];
      if (!program) continue;
      try {
        gl.deleteProgram(program);
        this[name] = null;
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    if (this._colormapTexture) {
      this._getPendingColormapTextureDeletes().add(
        this._colormapTexture
      );
      this._colormapTexture = null;
    }
    const colormapFailures =
      this._flushPendingColormapTextureDeletes();
    if (colormapFailures !== null) {
      for (const error of colormapFailures) {
        failures = appendFailure(failures, error);
      }
    }
    if (this._fullscreenVAO) {
      try {
        gl.deleteVertexArray(this._fullscreenVAO);
        this._fullscreenVAO = null;
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    if (this._fullscreenAttrib0Buffer) {
      try {
        gl.deleteBuffer(this._fullscreenAttrib0Buffer);
        this._fullscreenAttrib0Buffer = null;
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    for (const name of VELOCITY_UNIFORM_KEYS) this[name] = null;

    throwCollectedFailures(
      failures,
      'VelocityOverlay initialization-resource retirement was incomplete.'
    );
  }

  _doDispose() {
    this.enabled = false;
    this._disposePending = true;
    // Fence every scheduled spawn publication before releasing ownership.
    for (const state of this._spawnByView.values()) {
      state.version++;
      state.ready = false;
    }

    if (this._contextLost) {
      this._particleByView.clear();
      this._pendingParticleRetirements.clear();
      this._fboByView.clear();
      this._pendingFBORetirements.clear();
      this._fieldsById.clear();
      this._positionTexturePool.clear();
      this._positionsRefByView.clear();
      this._pendingDerivedTextureDeletes.clear();
      this._spawnByView.clear();
      this._residentParticleBytes = 0n;
      this._residentFBOBytes = 0n;
      this._transformFeedback = null;
      this._colormapTexture = null;
      this._getPendingColormapTextureDeletes().clear();
      this._fullscreenVAO = null;
      this._fullscreenAttrib0Buffer = null;
      for (const name of VELOCITY_PROGRAM_KEYS) this[name] = null;
      for (const name of VELOCITY_UNIFORM_KEYS) this[name] = null;
      this._activeFieldId = null;
      this._failureHandler = null;
      return;
    }

    let failures = null;
    const attempt = operation => {
      try {
        operation();
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    };

    for (const key of Array.from(this._particleByView.keys())) {
      attempt(() => this._disposeParticleState(key));
    }
    for (const key of Array.from(this._fboByView.keys())) {
      attempt(() => this._disposeFBOs(key));
    }
    attempt(() => this._flushPendingParticleRetirements());
    attempt(() => this._flushPendingFBORetirements());
    attempt(() => this._releaseInitializationResources());

    for (const perField of this._fieldsById.values()) {
      for (const entry of perField.values()) {
        if (!entry?.texture) continue;
        try {
          this._queueDerivedTextureDelete(
            entry,
            entry.components * 4
          );
          entry.texture = null;
        } catch (error) {
          failures = appendFailure(failures, error);
        }
      }
    }

    const positionEntries = new Set([
      ...this._positionTexturePool.values(),
      ...this._positionsRefByView.values(),
    ]);
    let positionOwnershipDetached = true;
    for (const entry of positionEntries) {
      if (entry?.textureInfo?.texture) {
        try {
          this._queueDerivedTextureDelete(
            entry.textureInfo,
            entry.textureInfo.components * 4
          );
        } catch (error) {
          positionOwnershipDetached = false;
          failures = appendFailure(failures, error);
        }
      }
    }
    if (positionOwnershipDetached) {
      this._positionTexturePool.clear();
      this._positionsRefByView.clear();
    }

    const notifications = getNotificationCenter();
    let spawnOwnershipDetached = true;
    for (const state of this._spawnByView.values()) {
      if (state.notificationId !== null) {
        const notificationId = state.notificationId;
        try {
          notifications.dismiss(notificationId);
          state.notificationId = null;
        } catch (error) {
          spawnOwnershipDetached = false;
          failures = appendFailure(failures, error);
        }
      }
      if (state.textureInfo?.texture) {
        try {
          this._queueDerivedTextureDelete(state.textureInfo, 4);
          state.textureInfo = null;
        } catch (error) {
          spawnOwnershipDetached = false;
          failures = appendFailure(failures, error);
        }
      } else {
        state.textureInfo = null;
      }
      if (state.visibilityTextureInfo?.texture) {
        try {
          this._queueDerivedTextureDelete(
            state.visibilityTextureInfo,
            4
          );
          state.visibilityTextureInfo = null;
        } catch (error) {
          spawnOwnershipDetached = false;
          failures = appendFailure(failures, error);
        }
      } else {
        state.visibilityTextureInfo = null;
      }
    }
    if (spawnOwnershipDetached) this._spawnByView.clear();
    const derivedFailures = this._flushPendingDerivedTextureDeletes();
    if (derivedFailures !== null) {
      for (const error of derivedFailures) {
        failures = appendFailure(failures, error);
      }
    }

    throwCollectedFailures(
      failures,
      'VelocityOverlay disposal was incomplete.'
    );
    this._fieldsById.clear();
    this._activeFieldId = null;
    this._positionTexturePool.clear();
    this._positionsRefByView.clear();
    this._spawnByView.clear();
    this._failureHandler = null;
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
    const previousVAO = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    const previousArrayBuffer =
      gl.getParameter(gl.ARRAY_BUFFER_BINDING);

    const vao = gl.createVertexArray();
    if (vao === null) {
      throw new Error(
        'VelocityOverlay could not allocate the fullscreen vertex array.'
      );
    }
    this._fullscreenVAO = vao;
    const buffer = gl.createBuffer();
    if (buffer === null) {
      throw new Error(
        'VelocityOverlay could not allocate the fullscreen attribute-zero buffer.'
      );
    }
    this._fullscreenAttrib0Buffer = buffer;

    let setupFailure;
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
    } catch (error) {
      setupFailure = error;
    }

    let failures = setupFailure === undefined
      ? null
      : [setupFailure];
    for (const restore of [
      () => gl.bindVertexArray(previousVAO),
      () => gl.bindBuffer(gl.ARRAY_BUFFER, previousArrayBuffer),
    ]) {
      try {
        restore();
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    throwCollectedFailures(
      failures,
      'VelocityOverlay fullscreen geometry setup or state restoration was incomplete.'
    );
  }

  _createParticleGeneration(capacity) {
    const gl = this.gl;
    requirePositiveSafeInteger(capacity, 'particle buffer capacity');
    const bufferSize = capacity * BYTES_PER_PARTICLE;
    if (!Number.isSafeInteger(bufferSize) || bufferSize <= 0) {
      throw new RangeError('VelocityOverlay particle buffer size is invalid.');
    }

    const previousVAO = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    const previousArrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    const pendingError = gl.getError();
    if (pendingError !== gl.NO_ERROR) {
      throw new Error(
        `VelocityOverlay particle allocation cannot start with WebGL error 0x${pendingError.toString(16)} pending.`
      );
    }
    const buffers = [null, null];
    const vaos = [null, null];
    const bufferBytes = [0n, 0n];
    const candidate = {
      activeParticleCount: 0,
      bufferBytes,
      buffers,
      bytes: 0n,
      cameraMotionAmount: 0,
      capacity,
      currentBuffer: 0,
      dimensionLevel: null,
      fieldId: null,
      forceRespawn: true,
      lastAdvancedFrameId: -1,
      lastCameraPosition: null,
      lastViewMatrix: null,
      positionsRef: null,
      readyGeneration: -1,
      vaos,
    };
    let allocationFailure;
    try {
      for (let index = 0; index < 2; index++) {
        const buffer = gl.createBuffer();
        if (buffer === null) {
          throw new Error(
            `VelocityOverlay could not allocate particle buffer ${index}.`
          );
        }
        buffers[index] = buffer;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        // WebGL zero-initializes sized allocations. The update shader's exact
        // force-respawn generation initializes every active particle on first use.
        gl.bufferData(gl.ARRAY_BUFFER, bufferSize, gl.DYNAMIC_COPY);
        const storageError = gl.getError();
        if (storageError !== gl.NO_ERROR) {
          throw new Error(
            `VelocityOverlay particle buffer ${index} storage failed with WebGL error 0x${storageError.toString(16)}.`
          );
        }
        bufferBytes[index] = BigInt(bufferSize);

        const vao = gl.createVertexArray();
        if (vao === null) {
          throw new Error(
            `VelocityOverlay could not allocate particle vertex array ${index}.`
          );
        }
        vaos[index] = vao;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(
          0, 3, gl.FLOAT, false, BYTES_PER_PARTICLE, 0
        );
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(
          1, 3, gl.FLOAT, false, BYTES_PER_PARTICLE, 12
        );
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(
          2, 1, gl.FLOAT, false, BYTES_PER_PARTICLE, 24
        );
        gl.enableVertexAttribArray(3);
        gl.vertexAttribIPointer(
          3, 1, gl.UNSIGNED_INT, BYTES_PER_PARTICLE, 28
        );
      }
    } catch (error) {
      allocationFailure = error;
    }

    let failures = allocationFailure === undefined
      ? null
      : [allocationFailure];
    for (const restore of [
      () => gl.bindVertexArray(previousVAO),
      () => gl.bindBuffer(gl.ARRAY_BUFFER, previousArrayBuffer),
    ]) {
      try {
        restore();
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    if (allocationFailure !== undefined || failures !== null) {
      try {
        this._deleteParticleGeneration(candidate);
      } catch (error) {
        failures = appendFailure(failures, error);
        this._retainFailedParticleCandidate(candidate);
      }
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(
        failures,
        'VelocityOverlay particle allocation and cleanup were incomplete.'
      );
    }

    candidate.bytes = 2n * BigInt(bufferSize);
    return candidate;
  }

  _ensureParticleState(viewId, requestedCount) {
    const key = requireViewId(viewId);
    requirePositiveSafeInteger(requestedCount, 'active particle count');
    const existing = this._particleByView.get(key);
    if (existing?.capacity >= requestedCount) return existing;

    const capacity = nextParticleCapacity(
      requestedCount,
      this.config.particleCapacity
    );
    const candidate = this._createParticleGeneration(capacity);
    this._particleByView.set(key, candidate);
    this._residentParticleBytes += candidate.bytes;
    if (existing) {
      this._pendingParticleRetirements.add(existing);
      this._flushPendingParticleRetirements();
    }
    return candidate;
  }

  _deleteParticleGeneration(state) {
    const gl = this.gl;
    let failures = null;
    for (let index = 0; index < state.vaos.length; index++) {
      const vao = state.vaos[index];
      if (!vao) continue;
      try {
        gl.deleteVertexArray(vao);
        state.vaos[index] = null;
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    for (let index = 0; index < state.buffers.length; index++) {
      const buffer = state.buffers[index];
      if (!buffer) continue;
      try {
        gl.deleteBuffer(buffer);
        state.buffers[index] = null;
        if (Array.isArray(state.bufferBytes)) {
          state.bufferBytes[index] = 0n;
        }
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    throwCollectedFailures(
      failures,
      'VelocityOverlay particle generation retirement was incomplete.'
    );
  }

  _retainFailedParticleCandidate(state) {
    if (this._pendingParticleRetirements.has(state)) return;
    let bytes = 0n;
    if (Array.isArray(state.bufferBytes)) {
      for (let index = 0; index < state.buffers.length; index++) {
        if (state.buffers[index]) bytes += state.bufferBytes[index];
      }
    } else {
      bytes = state.bytes;
    }
    state.bytes = bytes;
    this._pendingParticleRetirements.add(state);
    this._residentParticleBytes += bytes;
  }

  _flushPendingParticleRetirements() {
    let failures = null;
    for (const state of this._pendingParticleRetirements) {
      try {
        this._deleteParticleGeneration(state);
        this._pendingParticleRetirements.delete(state);
        this._residentParticleBytes -= state.bytes;
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    throwCollectedFailures(
      failures,
      'VelocityOverlay pending particle retirement was incomplete.'
    );
  }

  _disposeParticleState(viewId) {
    const key = requireViewId(viewId);
    const state = this._particleByView.get(key);
    if (!state) return;
    this._particleByView.delete(key);
    this._pendingParticleRetirements.add(state);
    this._flushPendingParticleRetirements();
  }

  // ===========================================================================
  // GPU SIMULATION
  // ===========================================================================

  _simulate(dt, ctx, field, posTexture, spawnState, particleState) {
    const gl = this.gl;
    if (particleState.lastAdvancedFrameId === ctx.frameId) return;

    const readIdx = particleState.currentBuffer;
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
    const frameScale = getVelocityFrameScale(
      dt,
      'particle simulation delta'
    );
    gl.useProgram(this._programUpdate);
    gl.uniform1f(u.u_dt, dt);
    gl.uniform1f(u.u_time, ctx.time);
    gl.uniform1f(u.u_speedMultiplier, this.config.speedMultiplier);
    gl.uniform1f(u.u_lifetime, this.config.lifetime);
    gl.uniform1f(
      u.u_dropChanceFast,
      normalizeVelocityDropChance(this.config.dropRate, frameScale)
    );
    gl.uniform1f(
      u.u_dropChanceSlow,
      normalizeVelocityDropChance(
        this.config.dropRate + this.config.dropRateBump,
        frameScale
      )
    );
    gl.uniform1f(u.u_turbulence, this.config.turbulence);
    gl.uniform1i(u.u_forceRespawn, particleState.forceRespawn ? 1 : 0);
    gl.uniform1f(
      u.u_velocityBlend,
      1 - Math.pow(0.75, frameScale)
    );
    gl.uniform1i(u.u_velocityTexWidth, field.width);
    gl.uniform1i(u.u_positionTexWidth, posTexture.width);
    gl.uniform1i(u.u_spawnTableWidth, spawnState.tableWidth);
    gl.uniform1i(u.u_spawnTableSize, spawnState.tableSize);

    let transformFeedbackActive = false;
    let simulationFailure;
    try {
      // Run transform feedback. Every binding is inside the cleanup boundary
      // so a failed setup call cannot leak the previous particle generation.
      gl.bindVertexArray(particleState.vaos[readIdx]);
      gl.bindTransformFeedback(
        gl.TRANSFORM_FEEDBACK,
        this._transformFeedback
      );
      gl.bindBufferBase(
        gl.TRANSFORM_FEEDBACK_BUFFER,
        0,
        particleState.buffers[writeIdx]
      );
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.beginTransformFeedback(gl.POINTS);
      transformFeedbackActive = true;
      gl.drawArrays(gl.POINTS, 0, particleState.activeParticleCount);
      gl.endTransformFeedback();
      transformFeedbackActive = false;
    } catch (error) {
      simulationFailure = error;
    }

    let restorationFailures = null;
    if (transformFeedbackActive) {
      try {
        gl.endTransformFeedback();
      } catch (error) {
        restorationFailures = appendFailure(restorationFailures, error);
      }
    }
    try {
      gl.disable(gl.RASTERIZER_DISCARD);
    } catch (error) {
      restorationFailures = appendFailure(restorationFailures, error);
    }
    try {
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    } catch (error) {
      restorationFailures = appendFailure(restorationFailures, error);
    }
    try {
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    } catch (error) {
      restorationFailures = appendFailure(restorationFailures, error);
    }
    try {
      gl.bindVertexArray(null);
    } catch (error) {
      restorationFailures = appendFailure(restorationFailures, error);
    }

    if (simulationFailure !== undefined) {
      if (restorationFailures !== null) {
        throw new AggregateError(
          [simulationFailure, ...restorationFailures],
          'Velocity simulation failed and WebGL state restoration was incomplete.'
        );
      }
      throw simulationFailure;
    }
    if (restorationFailures?.length === 1) {
      throw restorationFailures[0];
    }
    if (restorationFailures !== null) {
      throw new AggregateError(
        restorationFailures,
        'Velocity simulation WebGL state restoration was incomplete.'
      );
    }

    particleState.currentBuffer = writeIdx;
    particleState.forceRespawn = false;
    particleState.lastAdvancedFrameId = ctx.frameId;
  }

  // ===========================================================================
  // RENDERING PIPELINE
  // ===========================================================================

  _renderFlow(ctx, field, viewId, particleState, spawnState) {
    const gl = this.gl;
    let flowFailure;
    let fbos = null;
    let writeIdx = -1;
    try {
      // Pane scissor coordinates are canvas-relative and must never leak into
      // pane-sized offscreen targets.
      gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.blendEquation(gl.FUNC_ADD);
      fbos = this._ensureFBOs(
        viewId,
        ctx.viewportWidth,
        ctx.viewportHeight
      );
      writeIdx = 1 - fbos.trailIdx;
      // PASS 1: Chromatic fade previous frame (creates trail persistence), or
      // consume one coalesced history clear after an appearance/generation
      // transition without reallocating the full-resolution targets.
      if (fbos.trailClearPending) {
        this._clearTrailWriteTarget(fbos, writeIdx);
      } else {
        this._passFade(fbos, writeIdx, particleState, ctx.deltaTime);
      }

      // PASS 2: Render particles to trail buffer
      this._passRenderParticles(
        ctx,
        field,
        fbos,
        writeIdx,
        particleState,
        spawnState
      );

      // PASS 3 & 4: Anamorphic Bloom (if enabled)
      if (fbos.bloomEnabled) {
        this._passBloom(fbos, writeIdx);
      }

      // PASS 5: Final composite with HDR and color grading
      gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.outputFramebuffer);
      gl.viewport(
        ctx.viewportX,
        ctx.viewportY,
        ctx.viewportWidth,
        ctx.viewportHeight
      );
      if (ctx.scissorEnabled) {
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(
          ctx.viewportX,
          ctx.viewportY,
          ctx.viewportWidth,
          ctx.viewportHeight
        );
      } else {
        gl.disable(gl.SCISSOR_TEST);
      }
      this._passComposite(ctx, fbos, writeIdx);
    } catch (error) {
      flowFailure = error;
    }

    const restorationFailures = this._restoreRenderFlowBaseline(ctx);

    if (flowFailure !== undefined) {
      if (restorationFailures !== null) {
        throw new AggregateError(
          [flowFailure, ...restorationFailures],
          'Velocity flow failed and WebGL state restoration was incomplete.'
        );
      }
      throw flowFailure;
    }
    throwCollectedFailures(
      restorationFailures,
      'Velocity flow WebGL state restoration was incomplete.'
    );
    fbos.trailIdx = writeIdx;
    fbos.trailClearPending = false;
  }

  _clearTrailWriteTarget(fbos, writeIdx) {
    const gl = this.gl;
    gl.bindFramebuffer(
      gl.FRAMEBUFFER,
      fbos.trailFramebuffers[writeIdx]
    );
    gl.viewport(0, 0, fbos.width, fbos.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.clearBufferfv(gl.COLOR, 0, TRANSPARENT_BLACK);
  }

  _restoreRenderFlowBaseline(ctx) {
    const gl = this.gl;
    let failures = null;
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.outputFramebuffer);
    } catch (error) {
      failures = appendFailure(failures, error);
    }
    try {
      gl.viewport(
        ctx.viewportX,
        ctx.viewportY,
        ctx.viewportWidth,
        ctx.viewportHeight
      );
    } catch (error) {
      failures = appendFailure(failures, error);
    }
    try {
      if (ctx.scissorEnabled) {
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(
          ctx.viewportX,
          ctx.viewportY,
          ctx.viewportWidth,
          ctx.viewportHeight
        );
      } else {
        gl.disable(gl.SCISSOR_TEST);
      }
    } catch (error) {
      failures = appendFailure(failures, error);
    }
    try {
      gl.bindVertexArray(null);
    } catch (error) {
      failures = appendFailure(failures, error);
    }
    try {
      gl.depthMask(true);
    } catch (error) {
      failures = appendFailure(failures, error);
    }
    try {
      gl.colorMask(true, true, true, true);
    } catch (error) {
      failures = appendFailure(failures, error);
    }
    try {
      gl.enable(gl.BLEND);
    } catch (error) {
      failures = appendFailure(failures, error);
    }
    try {
      gl.blendEquation(gl.FUNC_ADD);
    } catch (error) {
      failures = appendFailure(failures, error);
    }
    try {
      gl.blendFuncSeparate(
        gl.SRC_ALPHA,
        gl.ONE_MINUS_SRC_ALPHA,
        gl.ONE,
        gl.ONE_MINUS_SRC_ALPHA
      );
    } catch (error) {
      failures = appendFailure(failures, error);
    }
    try {
      gl.enable(gl.DEPTH_TEST);
    } catch (error) {
      failures = appendFailure(failures, error);
    }
    return failures;
  }

  _passFade(fbos, writeIdx, particleState, dt) {
    const gl = this.gl;

    const readIdx = fbos.trailIdx;
    gl.bindFramebuffer(
      gl.FRAMEBUFFER,
      fbos.trailFramebuffers[writeIdx]
    );

    gl.viewport(0, 0, fbos.width, fbos.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    gl.useProgram(this._programFade);
    const frameScale = getVelocityFrameScale(dt, 'trail frame delta');
    const fadeAt60Hz = this._getEffectiveTrailFadeAt60Hz(
      particleState
    );
    const chromaticFade = this.config.chromaticFade;
    // Spatially uniform powers belong on the CPU. Evaluating these four
    // factors per fragment is prohibitive for full-resolution 4K trails.
    gl.uniform1f(
      this._uniformsFade.u_fadeR,
      Math.pow(
        Math.min(1, fadeAt60Hz * (1 + 0.025 * chromaticFade)),
        frameScale
      )
    );
    gl.uniform1f(
      this._uniformsFade.u_fadeG,
      Math.pow(
        Math.min(1, fadeAt60Hz * (1 + 0.005 * chromaticFade)),
        frameScale
      )
    );
    gl.uniform1f(
      this._uniformsFade.u_fadeB,
      Math.pow(
        Math.min(1, fadeAt60Hz * (1 - 0.035 * chromaticFade)),
        frameScale
      )
    );
    gl.uniform1f(
      this._uniformsFade.u_fadeAlpha,
      Math.pow(
        Math.min(1, fadeAt60Hz * (1 - 0.005 * chromaticFade)),
        frameScale
      )
    );
    gl.uniform1f(this._uniformsFade.u_frameScale, frameScale);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fbos.trail[readIdx]);
    gl.uniform1i(this._uniformsFade.u_previousFrame, 0);

    gl.bindVertexArray(this._fullscreenVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  _passRenderParticles(
    ctx,
    field,
    fbos,
    writeIdx,
    particleState,
    spawnState
  ) {
    const gl = this.gl;

    gl.bindFramebuffer(
      gl.FRAMEBUFFER,
      fbos.trailFramebuffers[writeIdx]
    );

    gl.viewport(0, 0, fbos.width, fbos.height);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE); // Additive blending

    gl.useProgram(this._programRender);
    const u = this._uniformsRender;

    // Matrices
    gl.uniformMatrix4fv(u.u_mvpMatrix, false, ctx.mvpMatrix);
    gl.uniformMatrix4fv(u.u_viewMatrix, false, ctx.viewMatrix);
    gl.uniformMatrix4fv(u.u_modelMatrix, false, ctx.modelMatrix);

    // Camera
    gl.uniform3fv(u.u_cameraPosition, ctx.cameraPosition);
    gl.uniform1f(u.u_viewportHeight, ctx.viewportHeight);
    gl.uniform1f(u.u_fov, ctx.fov);
    gl.uniform1f(u.u_sizeAttenuation, ctx.sizeAttenuation);
    gl.uniform1f(u.u_rasterScale, fbos.rasterScale);

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
    gl.uniform1i(u.u_useAlphaTex, 1);
    gl.uniform1i(
      u.u_alphaTexWidth,
      spawnState.visibilityTextureInfo.width
    );

    // Fog
    gl.uniform1f(u.u_fogNear, ctx.fogNear);
    gl.uniform1f(u.u_fogFar, ctx.fogFar);
    gl.uniform1f(u.u_fogDensity, ctx.fogDensity);
    gl.uniform3fv(u.u_fogColor, ctx.fogColor);

    // Bind textures
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(
      gl.TEXTURE_2D,
      spawnState.visibilityTextureInfo.texture
    );
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this._colormapTexture);

    // Draw particles
    gl.bindVertexArray(particleState.vaos[particleState.currentBuffer]);
    gl.drawArrays(
      gl.POINTS,
      0,
      particleState.activeParticleCount
    );
    gl.bindVertexArray(null);
  }

  _passBloom(fbos, trailIdx) {
    const gl = this.gl;

    // Extract bright areas with soft knee threshold
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbos.bloomFramebuffers[0]);
    gl.viewport(0, 0, fbos.bloomWidth, fbos.bloomHeight);
    gl.disable(gl.BLEND);

    gl.useProgram(this._programThreshold);
    gl.uniform1f(this._uniformsThreshold.u_threshold, this.config.bloomThreshold);
    gl.uniform1f(this._uniformsThreshold.u_softness, 0.1);
    gl.uniform1f(this._uniformsThreshold.u_knee, this.config.bloomKnee);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fbos.trail[trailIdx]);
    gl.uniform1i(this._uniformsThreshold.u_source, 0);

    gl.bindVertexArray(this._fullscreenVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Horizontal blur
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbos.bloomFramebuffers[1]);

    gl.useProgram(this._programBlur);
    gl.uniform2f(this._uniformsBlur.u_direction, 1.0, 0.0);
    gl.uniform1f(this._uniformsBlur.u_blurSize, this.config.bloomBlurSize);

    gl.bindTexture(gl.TEXTURE_2D, fbos.bloom[0]);
    gl.uniform1i(this._uniformsBlur.u_source, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Vertical blur
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbos.bloomFramebuffers[0]);

    gl.uniform2f(this._uniformsBlur.u_direction, 0.0, 1.0);
    gl.bindTexture(gl.TEXTURE_2D, fbos.bloom[1]);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Anamorphic pass for cinematic horizontal stretch
    if (this.config.anamorphicRatio > 1.0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbos.bloomFramebuffers[1]);

      gl.useProgram(this._programAnamorphic);
      gl.uniform1f(this._uniformsAnamorphic.u_anamorphicRatio, this.config.anamorphicRatio);
      gl.uniform1f(this._uniformsAnamorphic.u_blurSize, this.config.bloomBlurSize * 0.5);

      gl.bindTexture(gl.TEXTURE_2D, fbos.bloom[0]);
      gl.uniform1i(this._uniformsAnamorphic.u_source, 0);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Copy back to bloom[0]
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbos.bloomFramebuffers[0]);

      gl.useProgram(this._programBlur);
      gl.uniform2f(this._uniformsBlur.u_direction, 0.0, 0.0);
      gl.uniform1f(this._uniformsBlur.u_blurSize, 0.0);

      gl.bindTexture(gl.TEXTURE_2D, fbos.bloom[1]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    gl.bindVertexArray(null);
  }

  _passComposite(ctx, fbos, trailIdx) {
    const gl = this.gl;

    gl.viewport(
      ctx.viewportX,
      ctx.viewportY,
      ctx.viewportWidth,
      ctx.viewportHeight
    );
    configureStraightAlphaBlending(gl);
    gl.depthMask(false);

    gl.useProgram(this._programComposite);
    const u = this._uniformsComposite;

    gl.uniform1f(u.u_opacity, this.config.opacity);
    gl.uniform1f(u.u_gamma, this.config.gamma);
    gl.uniform1f(
      u.u_bloomStrength,
      fbos.bloomEnabled ? this.config.bloomStrength : 0
    );
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
    gl.bindTexture(gl.TEXTURE_2D, fbos.trail[trailIdx]);
    gl.uniform1i(u.u_trailTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(
      gl.TEXTURE_2D,
      fbos.bloomEnabled ? fbos.bloom[0] : null
    );
    gl.uniform1i(u.u_bloomTex, 1);

    gl.bindVertexArray(this._fullscreenVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    gl.depthMask(true);
  }

  // ===========================================================================
  // FBO MANAGEMENT
  // ===========================================================================

  _captureRenderTargetState() {
    const gl = this.gl;
    const viewport = gl.getParameter(gl.VIEWPORT);
    const scissorBox = gl.getParameter(gl.SCISSOR_BOX);
    const colorMask = gl.getParameter(gl.COLOR_WRITEMASK);
    return {
      activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE),
      colorMask: Array.from(colorMask),
      drawFramebuffer: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
      pixelUnpackBuffer: gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING),
      readFramebuffer: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
      scissorBox: Array.from(scissorBox),
      scissorEnabled: gl.isEnabled(gl.SCISSOR_TEST),
      texture: gl.getParameter(gl.TEXTURE_BINDING_2D),
      viewport: Array.from(viewport),
    };
  }

  _restoreRenderTargetState(state, replacements = null) {
    const gl = this.gl;
    const replace = value => (
      replacements?.has(value) ? replacements.get(value) : value
    );
    let failures = null;
    for (const restore of [
      () => gl.activeTexture(state.activeTexture),
      () => gl.bindTexture(gl.TEXTURE_2D, replace(state.texture)),
      () => gl.bindBuffer(
        gl.PIXEL_UNPACK_BUFFER,
        state.pixelUnpackBuffer
      ),
      () => gl.bindFramebuffer(
        gl.DRAW_FRAMEBUFFER,
        replace(state.drawFramebuffer)
      ),
      () => gl.bindFramebuffer(
        gl.READ_FRAMEBUFFER,
        replace(state.readFramebuffer)
      ),
      () => gl.viewport(...state.viewport),
      () => {
        if (state.scissorEnabled) {
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(...state.scissorBox);
        } else {
          gl.disable(gl.SCISSOR_TEST);
        }
      },
      () => gl.colorMask(...state.colorMask),
    ]) {
      try {
        restore();
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    return failures;
  }

  _deleteRenderTargetGeneration(generation) {
    const gl = this.gl;
    let failures = null;
    for (const framebuffers of [
      generation.trailFramebuffers,
      generation.bloomFramebuffers,
    ]) {
      for (let index = 0; index < framebuffers.length; index++) {
        const framebuffer = framebuffers[index];
        if (!framebuffer) continue;
        try {
          gl.deleteFramebuffer(framebuffer);
          framebuffers[index] = null;
        } catch (error) {
          failures = appendFailure(failures, error);
        }
      }
    }
    for (const [textures, textureBytes] of [
      [generation.trail, generation.trailTextureBytes],
      [generation.bloom, generation.bloomTextureBytes],
    ]) {
      for (let index = 0; index < textures.length; index++) {
        const texture = textures[index];
        if (!texture) continue;
        try {
          gl.deleteTexture(texture);
          textures[index] = null;
          if (Array.isArray(textureBytes)) {
            textureBytes[index] = 0n;
          }
        } catch (error) {
          failures = appendFailure(failures, error);
        }
      }
    }
    throwCollectedFailures(
      failures,
      'VelocityOverlay render-target retirement was incomplete.'
    );
  }

  _retainFailedRenderTargetCandidate(generation) {
    if (!(this._pendingFBORetirements instanceof Set)) {
      this._pendingFBORetirements = new Set();
    }
    if (typeof this._residentFBOBytes !== 'bigint') {
      this._residentFBOBytes = 0n;
    }
    if (this._pendingFBORetirements.has(generation)) return;
    const bytesPerPixel = requirePositiveSafeInteger(
      generation.textureFormat.bytesPerPixel,
      'render-target bytes per pixel'
    );
    let bytes = 0n;
    for (let index = 0; index < generation.trail.length; index++) {
      const texture = generation.trail[index];
      if (texture) {
        bytes += Array.isArray(generation.trailTextureBytes)
          ? generation.trailTextureBytes[index]
          : (
              BigInt(generation.width) *
              BigInt(generation.height) *
              BigInt(bytesPerPixel)
            );
      }
    }
    for (let index = 0; index < generation.bloom.length; index++) {
      const texture = generation.bloom[index];
      if (texture) {
        bytes += Array.isArray(generation.bloomTextureBytes)
          ? generation.bloomTextureBytes[index]
          : (
              BigInt(generation.bloomWidth) *
              BigInt(generation.bloomHeight) *
              BigInt(bytesPerPixel)
            );
      }
    }
    // This candidate was never published or accounted. Retain only the exact
    // storage whose deletion did not complete; framebuffer handles carry no
    // separately measurable texture-storage bytes.
    generation.bytes = bytes;
    this._pendingFBORetirements.add(generation);
    this._residentFBOBytes += bytes;
  }

  _detectTextureFormat() {
    if (this._textureFormat) return this._textureFormat;

    const gl = this.gl;
    const pendingError = gl.getError();
    if (pendingError !== gl.NO_ERROR) {
      throw new Error(
        `VelocityOverlay format detection cannot start with WebGL error 0x${pendingError.toString(16)} pending.`
      );
    }
    const savedState = this._captureRenderTargetState();
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
          bytesPerPixel: 8,
        },
        {
          internal: gl.RGBA32F,
          format: gl.RGBA,
          type: gl.FLOAT,
          bytesPerPixel: 16,
        }
      );
    }
    formats.push({
      internal: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      bytesPerPixel: 4,
    });

    let selected = null;
    let detectionFailure;
    for (const fmt of formats) {
      const probe = {
        bloom: [],
        bloomFramebuffers: [],
        bloomHeight: 0,
        bloomTextureBytes: [],
        bloomWidth: 0,
        bytes: 0n,
        height: 4,
        textureFormat: fmt,
        trail: [null],
        trailFramebuffers: [null],
        trailTextureBytes: [0n],
        width: 4,
      };
      let candidateFailure;
      try {
        const texture = gl.createTexture();
        if (texture === null) {
          throw new Error(
            'VelocityOverlay could not allocate a format-probe texture.'
          );
        }
        probe.trail[0] = texture;
        const framebuffer = gl.createFramebuffer();
        if (framebuffer === null) {
          throw new Error(
            'VelocityOverlay could not allocate a format-probe framebuffer.'
          );
        }
        probe.trailFramebuffers[0] = framebuffer;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texStorage2D(gl.TEXTURE_2D, 1, fmt.internal, 4, 4);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const storageError = gl.getError();
        if (storageError !== gl.NO_ERROR) {
          throw new Error(
            `VelocityOverlay format probe failed with WebGL error 0x${storageError.toString(16)}.`
          );
        }
        probe.trailTextureBytes[0] =
          16n * BigInt(fmt.bytesPerPixel);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          texture,
          0
        );
        if (
          gl.checkFramebufferStatus(gl.FRAMEBUFFER) ===
          gl.FRAMEBUFFER_COMPLETE
        ) {
          selected = fmt;
        }
      } catch (error) {
        candidateFailure = error;
      }
      let cleanupFailures = null;
      try {
        this._deleteRenderTargetGeneration(probe);
      } catch (error) {
        cleanupFailures = appendFailure(cleanupFailures, error);
        this._retainFailedRenderTargetCandidate(probe);
      }
      if (cleanupFailures !== null) {
        detectionFailure = candidateFailure === undefined
          ? new AggregateError(
              cleanupFailures,
              'VelocityOverlay format-probe cleanup was incomplete.'
            )
          : new AggregateError(
              [candidateFailure, ...cleanupFailures],
              'VelocityOverlay format probing and cleanup both failed.'
            );
        break;
      }
      if (selected) break;
      // An unsupported candidate is expected; continue to the guaranteed
      // RGBA8 candidate unless allocation itself failed catastrophically.
      if (
        candidateFailure &&
        !candidateFailure.message.includes('WebGL error')
      ) {
        detectionFailure = candidateFailure;
        break;
      }
    }

    const restorationFailures = this._restoreRenderTargetState(savedState);
    if (detectionFailure !== undefined) {
      if (restorationFailures !== null) {
        throw new AggregateError(
          [detectionFailure, ...restorationFailures],
          'VelocityOverlay format detection failed and state restoration was incomplete.'
        );
      }
      throw detectionFailure;
    }
    if (!selected) {
      const unavailable = new Error(
        'VelocityOverlay requires a complete renderable trail texture format.'
      );
      if (restorationFailures !== null) {
        throw new AggregateError(
          [unavailable, ...restorationFailures],
          'VelocityOverlay format detection and state restoration failed.'
        );
      }
      throw unavailable;
    }
    throwCollectedFailures(
      restorationFailures,
      'VelocityOverlay format-detection state restoration was incomplete.'
    );
    this._textureFormat = Object.freeze(selected);
    return this._textureFormat;
  }

  _getPerViewRenderTargetByteBudget() {
    const activeViewCount = requirePositiveSafeInteger(
      this._activeRenderViewCount,
      'active render view count'
    );
    const byteBudget = requirePositiveSafeInteger(
      this.config.renderTargetByteBudget,
      'renderTargetByteBudget'
    );
    const perViewBudget = Math.floor(byteBudget / activeViewCount);
    if (perViewBudget < 64) {
      throw new RangeError(
        'VelocityOverlay render-target byte budget cannot provide the minimum target for every active view.'
      );
    }
    return perViewBudget;
  }

  _buildRenderTargetQualityTiers(
    preferredFormat,
    wantsBloom,
    perViewBudget,
    vpWidth,
    vpHeight
  ) {
    const gl = this.gl;
    const tiers = [];
    const signatures = new Set();
    const addTier = (textureFormat, bloomEnabled, byteBudget) => {
      const layout = computeVelocityRenderTargetLayout({
        bloomEnabled,
        byteBudget,
        bytesPerPixel: textureFormat.bytesPerPixel,
        maxTextureSize: this._renderTargetLimits.maxTextureSize,
        maxViewportHeight: this._renderTargetLimits.maxViewportHeight,
        maxViewportWidth: this._renderTargetLimits.maxViewportWidth,
        resolution: this.config.trailResolution,
        viewportHeight: vpHeight,
        viewportWidth: vpWidth,
      });
      const signature = [
        textureFormat.internal,
        textureFormat.bytesPerPixel,
        layout.bloomEnabled,
        layout.width,
        layout.height,
      ].join(':');
      if (signatures.has(signature)) return;
      signatures.add(signature);
      tiers.push({
        allocationByteBudget: byteBudget,
        layout,
        qualityTier: tiers.length,
        textureFormat,
      });
    };

    addTier(preferredFormat, wantsBloom, perViewBudget);
    const primary = tiers[0].layout;
    let noBloomBudget = perViewBudget;
    if (wantsBloom) {
      noBloomBudget = Math.max(
        32,
        Math.min(
          perViewBudget,
          Number(
            2n *
            BigInt(primary.width) *
            BigInt(primary.height) *
            BigInt(preferredFormat.bytesPerPixel)
          )
        )
      );
      addTier(preferredFormat, false, noBloomBudget);
    }

    const rgba8Format =
      preferredFormat.internal === gl.RGBA8 &&
      preferredFormat.bytesPerPixel === 4
        ? preferredFormat
        : Object.freeze({
            bytesPerPixel: 4,
            format: gl.RGBA,
            internal: gl.RGBA8,
            type: gl.UNSIGNED_BYTE,
          });
    const rgba8Budget = Math.max(
      8,
      Math.min(
        perViewBudget,
        Number(
          2n *
          BigInt(primary.width) *
          BigInt(primary.height) *
          4n
        )
      )
    );
    addTier(rgba8Format, false, rgba8Budget);
    addTier(
      rgba8Format,
      false,
      Math.max(8, Math.floor(rgba8Budget / 4))
    );
    return tiers;
  }

  _ensureFBOs(viewId, vpWidth, vpHeight) {
    const gl = this.gl;
    const key = requireViewId(viewId);
    requirePositiveSafeInteger(vpWidth, 'viewportWidth');
    requirePositiveSafeInteger(vpHeight, 'viewportHeight');
    const wantsBloom =
      this.config.bloomEnabled && this.config.bloomStrength > 0;
    const targetByteBudget = this._getPerViewRenderTargetByteBudget();
    const existing = this._fboByView.get(key);
    if (
      existing &&
      existing.sourceViewportWidth === vpWidth &&
      existing.sourceViewportHeight === vpHeight &&
      existing.requestedResolution === this.config.trailResolution &&
      existing.requestedBloomEnabled === wantsBloom &&
      existing.targetByteBudget === targetByteBudget
    ) {
      return existing;
    }

    if (this._renderTargetLimits === null) {
      const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const maxViewportDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
      if (
        (!Array.isArray(maxViewportDims) &&
          !(maxViewportDims instanceof Int32Array)) ||
        maxViewportDims.length !== 2
      ) {
        throw new Error(
          'VelocityOverlay requires exact two-value MAX_VIEWPORT_DIMS.'
        );
      }
      this._renderTargetLimits = Object.freeze({
        maxTextureSize: requirePositiveSafeInteger(
          maxTextureSize,
          'MAX_TEXTURE_SIZE'
        ),
        maxViewportHeight: requirePositiveSafeInteger(
          maxViewportDims[1],
          'MAX_VIEWPORT_DIMS height'
        ),
        maxViewportWidth: requirePositiveSafeInteger(
          maxViewportDims[0],
          'MAX_VIEWPORT_DIMS width'
        ),
      });
    }
    const preferredFormat = this._detectTextureFormat();
    const qualityTiers = this._buildRenderTargetQualityTiers(
      preferredFormat,
      wantsBloom,
      targetByteBudget,
      vpWidth,
      vpHeight
    );
    const primaryTier = qualityTiers[0];
    if (
      existing &&
      existing.width === primaryTier.layout.width &&
      existing.height === primaryTier.layout.height &&
      existing.bloomEnabled === primaryTier.layout.bloomEnabled &&
      existing.textureFormat.internal === preferredFormat.internal &&
      existing.textureFormat.bytesPerPixel === preferredFormat.bytesPerPixel
    ) {
      existing.requestedBloomEnabled = wantsBloom;
      existing.requestedResolution = this.config.trailResolution;
      existing.rasterScale = primaryTier.layout.rasterScale;
      existing.sourceViewportHeight = vpHeight;
      existing.sourceViewportWidth = vpWidth;
      existing.targetByteBudget = targetByteBudget;
      existing.trailClearPending = true;
      return existing;
    }

    const pendingError = gl.getError();
    if (pendingError !== gl.NO_ERROR) {
      throw new Error(
        `VelocityOverlay render-target allocation cannot start with WebGL error 0x${pendingError.toString(16)} pending.`
      );
    }
    const savedState = this._captureRenderTargetState();
    const allocationFailures = [];
    let candidate = null;

    for (const tier of qualityTiers) {
      const layout = tier.layout;
      const textureFormat = tier.textureFormat;
      const trail = [null, null];
      const trailFramebuffers = [null, null];
      const trailTextureBytes = [0n, 0n];
      const bloom = [null, null];
      const bloomFramebuffers = [null, null];
      const bloomTextureBytes = [0n, 0n];
      const attempted = {
        ...layout,
        allocationByteBudget: tier.allocationByteBudget,
        bloom,
        bloomFramebuffers,
        bloomTextureBytes,
        qualityTier: tier.qualityTier,
        requestedBloomEnabled: wantsBloom,
        requestedResolution: this.config.trailResolution,
        sourceViewportHeight: vpHeight,
        sourceViewportWidth: vpWidth,
        targetByteBudget,
        textureFormat,
        trail,
        trailClearPending: false,
        trailFramebuffers,
        trailIdx: 0,
        trailTextureBytes,
      };
      let allocationFailure;
      try {
        const allocatePair = (
          textures,
          framebuffers,
          textureBytes,
          index,
          width,
          height,
          label
        ) => {
          const texture = gl.createTexture();
          if (texture === null) {
            throw new Error(
              `VelocityOverlay could not allocate ${label} texture ${index} for view "${key}".`
            );
          }
          textures[index] = texture;
          const framebuffer = gl.createFramebuffer();
          if (framebuffer === null) {
            throw new Error(
              `VelocityOverlay could not allocate ${label} framebuffer ${index} for view "${key}".`
            );
          }
          framebuffers[index] = framebuffer;
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texStorage2D(
            gl.TEXTURE_2D,
            1,
            textureFormat.internal,
            width,
            height
          );
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          const storageError = gl.getError();
          if (storageError !== gl.NO_ERROR) {
            throw new Error(
              `VelocityOverlay ${label} texture ${index} allocation failed with WebGL error 0x${storageError.toString(16)}.`
            );
          }
          textureBytes[index] =
            BigInt(width) *
            BigInt(height) *
            BigInt(textureFormat.bytesPerPixel);
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
          gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            texture,
            0
          );
          const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
          if (status !== gl.FRAMEBUFFER_COMPLETE) {
            throw new Error(
              `VelocityOverlay ${label} framebuffer ${index} is incomplete for view "${key}" (status ${status}).`
            );
          }
          gl.viewport(0, 0, width, height);
          gl.disable(gl.SCISSOR_TEST);
          gl.colorMask(true, true, true, true);
          gl.clearBufferfv(gl.COLOR, 0, TRANSPARENT_BLACK);
          const clearError = gl.getError();
          if (clearError !== gl.NO_ERROR) {
            throw new Error(
              `VelocityOverlay ${label} target ${index} clear failed with WebGL error 0x${clearError.toString(16)}.`
            );
          }
        };
        for (let index = 0; index < 2; index++) {
          allocatePair(
            trail,
            trailFramebuffers,
            trailTextureBytes,
            index,
            layout.width,
            layout.height,
            'trail'
          );
        }
        if (layout.bloomEnabled) {
          for (let index = 0; index < 2; index++) {
            allocatePair(
              bloom,
              bloomFramebuffers,
              bloomTextureBytes,
              index,
              layout.bloomWidth,
              layout.bloomHeight,
              'bloom'
            );
          }
        }
      } catch (error) {
        allocationFailure = error;
      }

      if (allocationFailure === undefined) {
        candidate = attempted;
        break;
      }
      allocationFailures.push(allocationFailure);
      try {
        this._deleteRenderTargetGeneration(attempted);
      } catch (cleanupError) {
        allocationFailures.push(cleanupError);
        this._retainFailedRenderTargetCandidate(attempted);
        break;
      }
    }

    const replacements = new Map();
    if (candidate && existing) {
      for (let index = 0; index < 2; index++) {
        replacements.set(existing.trail[index], candidate.trail[index]);
        replacements.set(
          existing.trailFramebuffers[index],
          candidate.trailFramebuffers[index]
        );
        if (existing.bloom[index]) {
          replacements.set(existing.bloom[index], candidate.bloom[index]);
        }
        if (existing.bloomFramebuffers[index]) {
          replacements.set(
            existing.bloomFramebuffers[index],
            candidate.bloomFramebuffers[index]
          );
        }
      }
    }
    const restorationFailures = this._restoreRenderTargetState(
      savedState,
      candidate ? replacements : null
    );
    if (candidate === null || restorationFailures !== null) {
      let cleanupFailure;
      if (candidate) {
        try {
          this._deleteRenderTargetGeneration(candidate);
        } catch (error) {
          cleanupFailure = error;
          this._retainFailedRenderTargetCandidate(candidate);
        }
      }
      const failures = allocationFailures.slice();
      if (restorationFailures !== null) failures.push(...restorationFailures);
      if (cleanupFailure !== undefined) failures.push(cleanupFailure);
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(
        failures,
        'VelocityOverlay render-target allocation, restoration, or cleanup was incomplete.'
      );
    }

    this._fboByView.set(key, candidate);
    this._residentFBOBytes += candidate.bytes;
    if (existing) {
      this._pendingFBORetirements.add(existing);
      this._flushPendingFBORetirements();
    }
    return candidate;
  }

  _flushPendingFBORetirements() {
    let failures = null;
    for (const generation of this._pendingFBORetirements) {
      try {
        this._deleteRenderTargetGeneration(generation);
        this._pendingFBORetirements.delete(generation);
        this._residentFBOBytes -= generation.bytes;
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    throwCollectedFailures(
      failures,
      'VelocityOverlay pending render-target retirement was incomplete.'
    );
  }

  _disposeFBOs(viewId) {
    const key = requireViewId(viewId);
    const fbos = this._fboByView.get(key);
    if (!fbos) return;
    this._fboByView.delete(key);
    this._pendingFBORetirements.add(fbos);
    this._flushPendingFBORetirements();
  }

  // ===========================================================================
  // INTERNAL UTILITIES
  // ===========================================================================

  _getPackedTextureBytes(textureInfo, bytesPerPixel) {
    if (
      !textureInfo ||
      typeof textureInfo !== 'object' ||
      !textureInfo.texture ||
      !Number.isSafeInteger(textureInfo.width) ||
      textureInfo.width <= 0 ||
      !Number.isSafeInteger(textureInfo.height) ||
      textureInfo.height <= 0 ||
      !Number.isSafeInteger(bytesPerPixel) ||
      bytesPerPixel <= 0
    ) {
      throw new Error(
        'VelocityOverlay derived texture byte ownership is invalid.'
      );
    }
    return (
      BigInt(textureInfo.width) *
      BigInt(textureInfo.height) *
      BigInt(bytesPerPixel)
    );
  }

  _queueDerivedTextureDelete(textureInfo, bytesPerPixel) {
    const bytes = this._getPackedTextureBytes(
      textureInfo,
      bytesPerPixel
    );
    if (!this._pendingDerivedTextureDeletes.has(textureInfo.texture)) {
      this._pendingDerivedTextureDeletes.set(textureInfo.texture, bytes);
    }
  }

  _flushPendingDerivedTextureDeletes() {
    let failures = null;
    for (const texture of this._pendingDerivedTextureDeletes.keys()) {
      try {
        this.gl.deleteTexture(texture);
        this._pendingDerivedTextureDeletes.delete(texture);
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    return failures;
  }

  _reportDerivedRetirementFailures(failures, message) {
    if (failures === null) return;
    const diagnostic = failures.length === 1
      ? failures[0]
      : new AggregateError(failures, message);
    // The replacement/visibility generation has already committed. Preserve
    // the retry queue as authoritative ownership and report cleanup separately
    // instead of making callers roll the published generation back.
    try {
      console.error(diagnostic);
    } catch {
      // Optional diagnostics cannot replace committed GPU resource state.
    }
  }

  _releaseDerivedViewTextures(fenceBuilds) {
    requireBoolean(fenceBuilds, 'derived texture build fence');
    let failures = null;
    const notifications = getNotificationCenter();
    const positionEntries = new Set([
      ...this._positionTexturePool.values(),
      ...this._positionsRefByView.values(),
    ]);
    let positionOwnershipDetached = true;
    for (const entry of positionEntries) {
      if (!entry?.textureInfo?.texture) continue;
      try {
        this._queueDerivedTextureDelete(
          entry.textureInfo,
          entry.textureInfo.components * 4
        );
      } catch (error) {
        positionOwnershipDetached = false;
        failures = appendFailure(failures, error);
      }
    }
    if (positionOwnershipDetached) {
      this._positionTexturePool.clear();
      this._positionsRefByView.clear();
    }

    for (const state of this._spawnByView.values()) {
      if (fenceBuilds) {
        state.version++;
        state.building = false;
        state.buildToken = null;
      }
      state.dirty = true;
      state.ready = false;
      state.generation = -1;
      state.tableSize = 0;
      state.tableWidth = 1;

      if (state.notificationId !== null) {
        const notificationId = state.notificationId;
        try {
          notifications.dismiss(notificationId);
          state.notificationId = null;
        } catch (error) {
          failures = appendFailure(failures, error);
        }
      }

      const spawnTextureInfo = state.textureInfo;
      const visibilityTextureInfo = state.visibilityTextureInfo;
      if (spawnTextureInfo?.texture) {
        try {
          this._queueDerivedTextureDelete(spawnTextureInfo, 4);
          state.textureInfo = null;
        } catch (error) {
          failures = appendFailure(failures, error);
        }
      } else {
        state.textureInfo = null;
      }
      if (visibilityTextureInfo?.texture) {
        try {
          this._queueDerivedTextureDelete(
            visibilityTextureInfo,
            4
          );
          state.visibilityTextureInfo = null;
        } catch (error) {
          failures = appendFailure(failures, error);
        }
      } else {
        state.visibilityTextureInfo = null;
      }
    }

    const deletionFailures = this._flushPendingDerivedTextureDeletes();
    if (deletionFailures !== null) {
      for (const error of deletionFailures) {
        failures = appendFailure(failures, error);
      }
    }
    throwCollectedFailures(
      failures,
      'VelocityOverlay derived view-texture retirement was incomplete.'
    );
  }

  _releaseDisabledResources(fenceBuilds) {
    let failures = null;
    try {
      this._releaseAllRenderResources();
    } catch (error) {
      failures = appendFailure(failures, error);
    }
    try {
      this._releaseDerivedViewTextures(fenceBuilds);
    } catch (error) {
      failures = appendFailure(failures, error);
    }
    throwCollectedFailures(
      failures,
      'VelocityOverlay disabled-resource retirement was incomplete.'
    );
  }

  _getResidentDerivedTextureBytes() {
    const bytesByTexture = new Map(this._pendingDerivedTextureDeletes);
    const positionEntries = new Set([
      ...this._positionTexturePool.values(),
      ...this._positionsRefByView.values(),
    ]);
    for (const entry of positionEntries) {
      const textureInfo = entry?.textureInfo;
      if (!textureInfo?.texture || bytesByTexture.has(textureInfo.texture)) {
        continue;
      }
      bytesByTexture.set(
        textureInfo.texture,
        this._getPackedTextureBytes(
          textureInfo,
          textureInfo.components * 4
        )
      );
    }
    for (const state of this._spawnByView.values()) {
      for (const [textureInfo, bytesPerPixel] of [
        [state.textureInfo, 4],
        [state.visibilityTextureInfo, 4],
      ]) {
        if (
          !textureInfo?.texture ||
          bytesByTexture.has(textureInfo.texture)
        ) {
          continue;
        }
        bytesByTexture.set(
          textureInfo.texture,
          this._getPackedTextureBytes(textureInfo, bytesPerPixel)
        );
      }
    }
    let total = 0n;
    for (const bytes of bytesByTexture.values()) total += bytes;
    return total;
  }

  _invalidateActiveFieldDimension(dimensionLevel, cellCount) {
    const dimension = requireDimensionLevel(dimensionLevel);
    requirePositiveSafeInteger(cellCount, 'active field cellCount');
    const viewIds = new Set();
    for (const [viewId, spawn] of this._spawnByView) {
      if (spawn.dimensionLevel !== dimension) continue;
      if (
        Number.isSafeInteger(spawn.cellCount) &&
        spawn.cellCount !== cellCount
      ) {
        spawn.dirty = true;
        spawn.version++;
        spawn.ready = false;
      }
      viewIds.add(viewId);
    }
    for (const [viewId, particle] of this._particleByView) {
      if (particle.dimensionLevel === dimension) viewIds.add(viewId);
    }

    let failures = null;
    for (const viewId of viewIds) {
      try {
        this._invalidateViewGeneration(viewId);
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    throwCollectedFailures(
      failures,
      `VelocityOverlay ${dimension}D field publication invalidation was incomplete.`
    );
  }

  _invalidateViewGeneration(viewId) {
    const key = requireViewId(viewId);
    const particleState = this._particleByView.get(key);
    if (particleState) {
      particleState.activeParticleCount = 0;
      particleState.forceRespawn = true;
      particleState.readyGeneration = -1;
      particleState.lastAdvancedFrameId = -1;
      particleState.lastCameraPosition = null;
      particleState.lastViewMatrix = null;
      particleState.cameraMotionAmount = 0;
    }
    this._scheduleTrailClear(key);
  }

  _scheduleTrailClear(viewId) {
    const key = requireViewId(viewId);
    const fbos = this._fboByView.get(key);
    if (fbos) fbos.trailClearPending = true;
  }

  _scheduleAllTrailClears() {
    for (const fbos of this._fboByView.values()) {
      fbos.trailClearPending = true;
    }
  }

  _invalidateAllViewGenerations({ spawnDirty }) {
    requireBoolean(spawnDirty, 'spawnDirty');
    const viewIds = new Set([
      ...this._spawnByView.keys(),
      ...this._particleByView.keys(),
      ...this._fboByView.keys(),
    ]);
    for (const [key, spawn] of this._spawnByView) {
      if (spawnDirty) {
        spawn.dirty = true;
        spawn.version++;
        spawn.ready = false;
      }
      viewIds.add(key);
    }
    let failures = null;
    for (const key of viewIds) {
      try {
        this._invalidateViewGeneration(key);
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    throwCollectedFailures(
      failures,
      'VelocityOverlay view-generation invalidation was incomplete.'
    );
  }

  _releaseAllRenderResources() {
    let failures = null;
    for (const key of Array.from(this._fboByView.keys())) {
      try {
        this._disposeFBOs(key);
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    for (const key of Array.from(this._particleByView.keys())) {
      try {
        this._disposeParticleState(key);
      } catch (error) {
        failures = appendFailure(failures, error);
      }
    }
    try {
      this._flushPendingFBORetirements();
    } catch (error) {
      failures = appendFailure(failures, error);
    }
    try {
      this._flushPendingParticleRetirements();
    } catch (error) {
      failures = appendFailure(failures, error);
    }
    throwCollectedFailures(
      failures,
      'VelocityOverlay render-resource release was incomplete.'
    );
  }

  _cacheUniforms() {
    const gl = this.gl;

    this._uniformsUpdate = {
      u_dt: gl.getUniformLocation(this._programUpdate, 'u_dt'),
      u_time: gl.getUniformLocation(this._programUpdate, 'u_time'),
      u_speedMultiplier: gl.getUniformLocation(this._programUpdate, 'u_speedMultiplier'),
      u_lifetime: gl.getUniformLocation(this._programUpdate, 'u_lifetime'),
      u_dropChanceFast: gl.getUniformLocation(
        this._programUpdate,
        'u_dropChanceFast'
      ),
      u_dropChanceSlow: gl.getUniformLocation(
        this._programUpdate,
        'u_dropChanceSlow'
      ),
      u_turbulence: gl.getUniformLocation(this._programUpdate, 'u_turbulence'),
      u_forceRespawn: gl.getUniformLocation(this._programUpdate, 'u_forceRespawn'),
      u_velocityBlend: gl.getUniformLocation(
        this._programUpdate,
        'u_velocityBlend'
      ),
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
      u_rasterScale: gl.getUniformLocation(this._programRender, 'u_rasterScale'),
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
      u_fadeR: gl.getUniformLocation(this._programFade, 'u_fadeR'),
      u_fadeG: gl.getUniformLocation(this._programFade, 'u_fadeG'),
      u_fadeB: gl.getUniformLocation(this._programFade, 'u_fadeB'),
      u_fadeAlpha: gl.getUniformLocation(this._programFade, 'u_fadeAlpha'),
      u_frameScale: gl.getUniformLocation(this._programFade, 'u_frameScale')
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
    const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM);
    let setupFailure;
    try {
      gl.useProgram(this._programUpdate);
      gl.uniform1i(this._uniformsUpdate.u_velocityTex, 0);
      gl.uniform1i(this._uniformsUpdate.u_positionTex, 1);
      gl.uniform1i(this._uniformsUpdate.u_spawnTableTex, 2);

      gl.useProgram(this._programRender);
      gl.uniform1i(this._uniformsRender.u_alphaTex, 1);
      gl.uniform1i(this._uniformsRender.u_colormapTex, 3);
    } catch (error) {
      setupFailure = error;
    }
    let restorationFailure;
    try {
      gl.useProgram(previousProgram);
    } catch (error) {
      restorationFailure = error;
    }
    if (setupFailure !== undefined) {
      if (restorationFailure !== undefined) {
        throw new AggregateError(
          [setupFailure, restorationFailure],
          'VelocityOverlay sampler setup and program restoration were incomplete.'
        );
      }
      throw setupFailure;
    }
    if (restorationFailure !== undefined) throw restorationFailure;
  }

  /**
   * Detect camera motion by comparing current position/orientation with previous frame.
   * Camera history is owned by one exact view generation.
   */
  _updateCameraMotion(ctx, state, dt) {
    const camPos = ctx.cameraPosition;
    const viewMatrix = ctx.viewMatrix;
    const frameScale = getVelocityFrameScale(dt, 'camera-motion delta');

    let motion = 0;

    // Check camera position change
    if (state.lastCameraPosition) {
      const dx = camPos[0] - state.lastCameraPosition[0];
      const dy = camPos[1] - state.lastCameraPosition[1];
      const dz = camPos[2] - state.lastCameraPosition[2];
      const posDelta = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // Normalize by camera distance for scale-independent motion detection
      motion = ctx.cameraDistance > 0
        ? posDelta / ctx.cameraDistance
        : posDelta;
    }

    // Check view matrix rotation change (use first row to detect rotation)
    if (state.lastViewMatrix) {
      let rotDelta = 0;
      for (let i = 0; i < 9; i++) {
        // Check 3x3 rotation part of view matrix
        const row = Math.floor(i / 3);
        const col = i % 3;
        const idx = col * 4 + row; // Column-major
        const diff = viewMatrix[idx] - state.lastViewMatrix[idx];
        rotDelta += diff * diff;
      }
      motion = Math.max(motion, Math.sqrt(rotDelta) * 0.5);
    }

    // Smooth the motion amount with temporal filtering
    const motionAt60Hz = frameScale > 0 ? motion / frameScale : 0;
    const targetMotion =
      motionAt60Hz > this.config.cameraMotionThreshold ? 1.0 : 0.0;
    const retention = Math.pow(0.7, frameScale);
    state.cameraMotionAmount =
      state.cameraMotionAmount * retention +
      targetMotion * (1 - retention);

    // Store current values for next frame comparison
    if (!state.lastCameraPosition) {
      state.lastCameraPosition = new Float32Array(3);
    }
    state.lastCameraPosition[0] = camPos[0];
    state.lastCameraPosition[1] = camPos[1];
    state.lastCameraPosition[2] = camPos[2];
    if (!state.lastViewMatrix) {
      state.lastViewMatrix = new Float32Array(16);
    }
    state.lastViewMatrix.set(viewMatrix);
  }

  /**
   * Calculate effective trail fade based on camera motion.
   * Returns a lower fade value (faster decay) when camera is moving.
   */
  _getEffectiveTrailFadeAt60Hz(state) {
    const baseFade = this.config.trailFade;
    const motionFade = this.config.cameraMotionFade;
    const motion = state.cameraMotionAmount;
    return baseFade * (1.0 - motion * (1.0 - motionFade));
  }

  _getEffectiveTrailFade(state, dt) {
    const frameScale = getVelocityFrameScale(dt, 'trail fade delta');
    // Configuration values are calibrated at 60 Hz. Exponentiating by elapsed
    // frames makes one second of decay invariant at 30/60/144 Hz.
    return Math.pow(
      this._getEffectiveTrailFadeAt60Hz(state),
      frameScale
    );
  }

  _updateColormap() {
    const gl = this.gl;
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

    const pendingError = gl.getError();
    if (pendingError !== gl.NO_ERROR) {
      throw new Error(
        `VelocityOverlay colormap upload cannot start with WebGL error 0x${pendingError.toString(16)} pending.`
      );
    }
    const existing = this._colormapTexture;
    const previousBinding = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const previousAlignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
    const previousPixelUnpackBuffer = gl.getParameter(
      gl.PIXEL_UNPACK_BUFFER_BINDING
    );
    const candidate = gl.createTexture();
    if (candidate === null) {
      throw new Error(
        'VelocityOverlay could not allocate its colormap texture.'
      );
    }
    const restoreBinding = previousBinding === existing
      ? candidate
      : previousBinding;

    try {
      gl.bindTexture(gl.TEXTURE_2D, candidate);
      // A typed-array upload is only legal when no pixel-unpack buffer owns
      // the source pointer overload.
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGB8,
        size,
        1,
        0,
        gl.RGB,
        gl.UNSIGNED_BYTE,
        data
      );
      const uploadError = gl.getError();
      if (uploadError !== gl.NO_ERROR) {
        throw new Error(
          `VelocityOverlay colormap upload failed with WebGL error 0x${uploadError.toString(16)}.`
        );
      }
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousAlignment);
      gl.bindBuffer(
        gl.PIXEL_UNPACK_BUFFER,
        previousPixelUnpackBuffer
      );
      gl.bindTexture(gl.TEXTURE_2D, restoreBinding);
    } catch (error) {
      let cleanupFailures = null;
      for (const cleanup of [
        () => gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousAlignment),
        () => gl.bindBuffer(
          gl.PIXEL_UNPACK_BUFFER,
          previousPixelUnpackBuffer
        ),
        () => gl.bindTexture(gl.TEXTURE_2D, previousBinding),
      ]) {
        try {
          cleanup();
        } catch (cleanupError) {
          cleanupFailures = appendFailure(
            cleanupFailures,
            cleanupError
          );
        }
      }
      this._getPendingColormapTextureDeletes().add(candidate);
      const deletionFailures =
        this._flushPendingColormapTextureDeletes();
      if (deletionFailures !== null) {
        for (const cleanupError of deletionFailures) {
          cleanupFailures = appendFailure(
            cleanupFailures,
            cleanupError
          );
        }
      }
      if (cleanupFailures !== null) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          'VelocityOverlay colormap upload and cleanup were incomplete.'
        );
      }
      throw error;
    }

    this._colormapTexture = candidate;
    if (existing !== null) {
      this._getPendingColormapTextureDeletes().add(existing);
      this._reportDerivedRetirementFailures(
        this._flushPendingColormapTextureDeletes(),
        'VelocityOverlay replaced-colormap retirement was incomplete.'
      );
    }
  }

  _ensurePositionTexture(viewId, positions3D) {
    const key = requireViewId(viewId);
    const prev = this._positionsRefByView.get(key);

    if (prev?.source === positions3D) {
      if (!prev.textureInfo) {
        throw new Error(
          `VelocityOverlay position texture ownership is invalid for view "${key}".`
        );
      }
      return prev.textureInfo;
    }

    let entry = this._positionTexturePool.get(positions3D);
    if (!entry) {
      const textureInfo = createOrUpdatePackedFloatTexture(this.gl, {
        texture: null,
        data: positions3D,
        itemCount: positions3D.length / 3,
        components: 3
      });
      entry = { source: positions3D, textureInfo, refs: 0 };
      this._positionTexturePool.set(positions3D, entry);
    }
    this._positionsRefByView.set(key, entry);
    entry.refs++;
    if (prev) {
      this._reportDerivedRetirementFailures(
        this._releasePositionTexture(prev),
        `VelocityOverlay view "${key}" replaced-position retirement was incomplete.`
      );
    }
    return entry.textureInfo;
  }

  _releasePositionTexture(entry) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !(entry.source instanceof Float32Array) ||
      !Number.isSafeInteger(entry.refs) ||
      entry.refs <= 0
    ) {
      throw new Error(
        'VelocityOverlay position texture reference ownership is invalid.'
      );
    }
    entry.refs--;
    if (entry.refs > 0) {
      return this._flushPendingDerivedTextureDeletes();
    }

    if (this._positionTexturePool.get(entry.source) === entry) {
      this._positionTexturePool.delete(entry.source);
    }
    if (entry.textureInfo?.texture) {
      this._queueDerivedTextureDelete(
        entry.textureInfo,
        entry.textureInfo.components * 4
      );
    }
    return this._flushPendingDerivedTextureDeletes();
  }

  _createSpawnTableBuild(transparency, cellCount, lodIndices) {
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

    const candidateCount = lodIndices ? lodIndices.length : cellCount;
    const maxSize = Math.min(this.config.spawnTableSize, candidateCount);
    const seed = (
      0x9e3779b9
      ^ Math.imul(cellCount, 0x85ebca6b)
      ^ Math.imul(candidateCount, 0xc2b2ae35)
    ) >>> 0;
    return {
      candidateCount,
      candidateIndex: 0,
      cellCount,
      filled: 0,
      lodIndices,
      // Without an indexed LOD candidate set, validation and sampling visit
      // the same cells in the same order and can share one exact pass.
      phase: lodIndices === null ? 'sample-unindexed' : 'validate',
      rng: createRNG(seed),
      table: new Uint32Array(maxSize),
      transparency,
      validationIndex: 0,
      visibleCount: 0,
    };
  }

  /**
   * Advance one bounded portion of an asynchronous spawn-table build.
   * Indexed LOD validation remains a separate first pass so error ordering and
   * the final reservoir sample are identical to _buildSpawnTable().
   *
   * @param {object} build
   * @param {IdleDeadline|null|undefined} idleDeadline
   * @returns {boolean} true once the complete table is ready
   */
  _advanceSpawnTableBuild(build, idleDeadline) {
    const startedAt = (
      typeof performance === 'object' &&
      performance !== null &&
      typeof performance.now === 'function'
    ) ? performance.now() : Date.now();
    let processed = 0;

    const shouldYield = () => {
      if (processed >= SPAWN_BUILD_MAX_ITEMS_PER_SLICE) return true;
      if (processed < SPAWN_BUILD_MIN_ITEMS_PER_SLICE) return false;

      const now = (
        typeof performance === 'object' &&
        performance !== null &&
        typeof performance.now === 'function'
      ) ? performance.now() : Date.now();
      if (now - startedAt >= SPAWN_BUILD_TIME_BUDGET_MS) return true;

      if (
        idleDeadline?.didTimeout !== true &&
        typeof idleDeadline?.timeRemaining === 'function' &&
        idleDeadline.timeRemaining() <= SPAWN_BUILD_IDLE_FLOOR_MS
      ) {
        return true;
      }
      return false;
    };

    while (build.phase !== 'complete') {
      const remainingCapacity =
        SPAWN_BUILD_MAX_ITEMS_PER_SLICE - processed;
      const batchSize = Math.min(
        SPAWN_BUILD_BATCH_ITEMS,
        remainingCapacity
      );

      if (build.phase === 'validate') {
        const start = build.validationIndex;
        const end = Math.min(
          build.transparency.length,
          build.validationIndex + batchSize
        );
        for (; build.validationIndex < end; build.validationIndex++) {
          const alpha = build.transparency[build.validationIndex];
          if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
            throw new RangeError(
              `VelocityOverlay transparency value ${build.validationIndex} must be finite and between 0 and 1.`
            );
          }
        }
        processed += end - start;
        if (build.validationIndex === build.transparency.length) {
          build.phase = 'sample';
        }
      } else {
        const end = Math.min(
          build.candidateCount,
          build.candidateIndex + batchSize
        );
        const start = build.candidateIndex;
        for (; build.candidateIndex < end; build.candidateIndex++) {
          const idx = build.lodIndices
            ? build.lodIndices[build.candidateIndex]
            : build.candidateIndex;
          if (idx >= build.cellCount) {
            throw new RangeError(
              `VelocityOverlay LOD spawn index ${idx} exceeds the ${build.cellCount}-cell field.`
            );
          }
          const alpha = build.transparency[idx];
          if (
            build.phase === 'sample-unindexed' &&
            (!Number.isFinite(alpha) || alpha < 0 || alpha > 1)
          ) {
            throw new RangeError(
              `VelocityOverlay transparency value ${idx} must be finite and between 0 and 1.`
            );
          }
          if (
            alpha < POINT_VISIBILITY_THRESHOLD
          ) {
            continue;
          }

          build.visibleCount++;
          if (build.filled < build.table.length) {
            build.table[build.filled++] = idx;
            continue;
          }

          const replacementIndex = build.rng.nextInt(build.visibleCount);
          if (replacementIndex < build.table.length) {
            build.table[replacementIndex] = idx;
          }
        }
        processed += end - start;
        if (build.candidateIndex === build.candidateCount) {
          build.phase = 'complete';
        }
      }

      if (build.phase !== 'complete' && shouldYield()) return false;
    }
    return true;
  }

  _finishSpawnTableBuild(build) {
    if (build.phase !== 'complete') {
      throw new Error(
        'VelocityOverlay cannot publish an incomplete spawn-table build.'
      );
    }
    return build.filled === build.table.length
      ? build.table
      : build.table.slice(0, build.filled);
  }

  _ensureSpawnTable(viewId, ctx, cellCount) {
    const key = requireViewId(viewId);
    let state = this._spawnByView.get(key);

    if (!state) {
      state = {
        dirty: true,
        version: 0,
        building: false,
        buildToken: null,
        notificationId: null,
        textureInfo: null,
        visibilityTextureInfo: null,
        tableSize: 0,
        tableWidth: 1,
        lastLod: null,
        ready: false,
        generation: -1,
        cellCount: null,
        dimensionLevel: null,
      };
      this._spawnByView.set(key, state);
    }
    if (
      Number.isInteger(ctx.dimensionLevel) &&
      ctx.dimensionLevel >= 1 &&
      ctx.dimensionLevel <= 3
    ) {
      state.dimensionLevel = ctx.dimensionLevel;
    }

    // Check LOD change
    if (typeof ctx.getLodLevel !== 'function') {
      throw new TypeError('VelocityOverlay context getLodLevel() is required.');
    }
    const lod = ctx.getLodLevel();
    if (this.config.syncWithLOD && state.lastLod !== null && lod !== state.lastLod) {
      state.dirty = true;
      state.version++;
      state.ready = false;
      this._invalidateViewGeneration(key);
    }
    state.lastLod = lod;

    if (!state.dirty || state.building) return state;

    const scheduledVersion = state.version;
    const buildToken = {};
    state.building = true;
    state.buildToken = buildToken;

    const notifications = getNotificationCenter();
    const showNotif = !state.textureInfo;
    const notifId = showNotif ? notifications.loading('Preparing velocity overlay...', { category: 'render' }) : null;
    state.notificationId = notifId;

    const schedule = typeof requestIdleCallback === 'function'
      ? fn => requestIdleCallback(fn, { timeout: 100 })
      : fn => setTimeout(
          () => fn({ didTimeout: true, timeRemaining: () => 0 }),
          0
        );
    let build = null;

    const ownsBuild = () => (
      this._spawnByView.get(key) === state &&
      state.buildToken === buildToken
    );

    const settle = success => {
      if (ownsBuild()) {
        state.building = false;
        state.buildToken = null;
        state.dirty = !(success && state.version === scheduledVersion);
        state.ready = success && state.version === scheduledVersion;
      }

      let notificationFailure;
      try {
        // Disabling the overlay fences a failed build and dismisses its active
        // notification. Only publish a terminal transition while this exact
        // build still owns that notification; NotificationCenter deliberately
        // rejects updates for IDs evicted under pressure or manually dismissed.
        if (
          notifId !== null &&
          state.notificationId === notifId &&
          notifications.hasNotification(notifId)
        ) {
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
      } catch (error) {
        notificationFailure = error instanceof Error
          ? error
          : new Error(
            'Velocity overlay terminal notification failed with a non-Error value.'
          );
      } finally {
        if (state.notificationId === notifId) {
          state.notificationId = null;
        }
        build = null;
      }
      if (notificationFailure !== undefined) {
        // Spawn/visibility publication is authoritative; optional UI delivery
        // must not roll a ready generation back or disable rendering.
        try {
          console.error(notificationFailure);
        } catch {
          // Optional diagnostics cannot replace the resource outcome.
        }
      }
    };

    const abortStaleBuild = () => {
      if (ownsBuild()) {
        state.building = false;
        state.buildToken = null;
        state.dirty = true;
      }
      let notificationFailure;
      try {
        if (state.notificationId === notifId && notifId !== null) {
          notifications.dismiss(notifId);
        }
      } catch (error) {
        notificationFailure = error instanceof Error
          ? error
          : new Error(
              'Velocity overlay stale-build notification dismissal failed with a non-Error value.'
            );
      } finally {
        if (state.notificationId === notifId) {
          state.notificationId = null;
        }
        build = null;
      }
      if (notificationFailure !== undefined) {
        // Cancellation is already authoritative. A notification observer must
        // not escape its idle callback and become an uncaught page error.
        try {
          console.error(notificationFailure);
        } catch {
          // Optional diagnostics cannot reopen a fenced build.
        }
      }
    };

    const reportFailure = err => {
      try {
        this.setEnabled(false);
      } catch (cleanupError) {
        try {
          console.error(
            new AggregateError(
              [err, cleanupError],
              'Velocity overlay preparation and shutdown both failed.'
            )
          );
        } catch {
          // Cleanup ownership is preserved by setEnabled(); diagnostics are
          // optional and must not prevent the build from settling below.
        }
      }
      try {
        if (this._failureHandler !== null) {
          try {
            this._failureHandler(err);
          } catch (observerError) {
            queueMicrotask(() => {
              throw observerError;
            });
          }
        } else {
          notifications.error(
            `Velocity overlay preparation failed: ${err.message}`,
            { category: 'render' }
          );
        }
      } finally {
        settle(false);
      }
    };

    const runBuildSlice = idleDeadline => {
      if (
        this._disposed ||
        this._contextLost ||
        this.enabled === false ||
        !ownsBuild() ||
        state.version !== scheduledVersion
      ) {
        abortStaleBuild();
        return;
      }

      try {
        if (build === null) {
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
            throw new TypeError(
              'VelocityOverlay context getLodIndices() is required.'
            );
          }
          const lodIndices =
            this.config.syncWithLOD ? ctx.getLodIndices() : null;
          build = this._createSpawnTableBuild(
            transparency,
            cellCount,
            lodIndices
          );
        }

        if (!this._advanceSpawnTableBuild(build, idleDeadline)) {
          schedule(runBuildSlice);
          return;
        }

        const table = this._finishSpawnTableBuild(build);
        if (table.length <= 0) {
          const previousTextureInfo = state.textureInfo;
          const previousVisibilityTextureInfo =
            state.visibilityTextureInfo;
          state.tableSize = 0;
          state.tableWidth = 1;
          state.textureInfo = null;
          state.visibilityTextureInfo = null;
          state.generation = scheduledVersion;
          state.cellCount = cellCount;
          state.ready = true;

          let retirementFailures = null;
          if (previousTextureInfo?.texture) {
            try {
              this._queueDerivedTextureDelete(
                previousTextureInfo,
                4
              );
            } catch (error) {
              retirementFailures = appendFailure(
                retirementFailures,
                error
              );
            }
          }
          if (previousVisibilityTextureInfo?.texture) {
            try {
              this._queueDerivedTextureDelete(
                previousVisibilityTextureInfo,
                4
              );
            } catch (error) {
              retirementFailures = appendFailure(
                retirementFailures,
                error
              );
            }
          }
          const deletionFailures =
            this._flushPendingDerivedTextureDeletes();
          if (deletionFailures !== null) {
            for (const error of deletionFailures) {
              retirementFailures = appendFailure(
                retirementFailures,
                error
              );
            }
          }
          this._reportDerivedRetirementFailures(
            retirementFailures,
            `VelocityOverlay view "${key}" empty-generation retirement was incomplete.`
          );
        } else {
          let visibilityTextureInfo = null;
          let textureInfo = null;
          try {
            visibilityTextureInfo = createOrUpdatePackedFloatTexture(this.gl, {
              texture: null,
              data: build.transparency,
              itemCount: cellCount,
              components: 1,
            });
            textureInfo = createOrUpdatePackedUintTexture(this.gl, {
              texture: null,
              data: table,
              itemCount: table.length
            });
          } catch (error) {
            let cleanupFailures = null;
            for (const [candidateInfo, bytesPerPixel] of [
              [visibilityTextureInfo, 4],
              [textureInfo, 4],
            ]) {
              if (!candidateInfo?.texture) continue;
              try {
                this._queueDerivedTextureDelete(
                  candidateInfo,
                  bytesPerPixel
                );
              } catch (cleanupError) {
                cleanupFailures = appendFailure(
                  cleanupFailures,
                  cleanupError
                );
              }
            }
            const deletionFailures =
              this._flushPendingDerivedTextureDeletes();
            if (deletionFailures !== null) {
              for (const cleanupError of deletionFailures) {
                cleanupFailures = appendFailure(
                  cleanupFailures,
                  cleanupError
                );
              }
            }
            if (cleanupFailures !== null) {
              throw new AggregateError(
                [error, ...cleanupFailures],
                `VelocityOverlay view "${key}" visibility publication and cleanup both failed.`
              );
            }
            throw error;
          }

          const previousTextureInfo = state.textureInfo;
          const previousVisibilityTextureInfo =
            state.visibilityTextureInfo;
          state.textureInfo = textureInfo;
          state.visibilityTextureInfo = visibilityTextureInfo;
          state.tableSize = table.length;
          state.tableWidth = textureInfo.width;
          state.generation = scheduledVersion;
          state.cellCount = cellCount;
          state.ready = true;

          let retirementFailures = null;
          if (previousTextureInfo?.texture) {
            try {
              this._queueDerivedTextureDelete(
                previousTextureInfo,
                4
              );
            } catch (error) {
              retirementFailures = appendFailure(
                retirementFailures,
                error
              );
            }
          }
          if (previousVisibilityTextureInfo?.texture) {
            try {
              this._queueDerivedTextureDelete(
                previousVisibilityTextureInfo,
                4
              );
            } catch (error) {
              retirementFailures = appendFailure(
                retirementFailures,
                error
              );
            }
          }
          const deletionFailures =
            this._flushPendingDerivedTextureDeletes();
          if (deletionFailures !== null) {
            for (const error of deletionFailures) {
              retirementFailures = appendFailure(
                retirementFailures,
                error
              );
            }
          }
          this._reportDerivedRetirementFailures(
            retirementFailures,
            `VelocityOverlay view "${key}" replaced-generation retirement was incomplete.`
          );
        }
      } catch (err) {
        reportFailure(err);
        return;
      }
      settle(true);
    };

    try {
      schedule(runBuildSlice);
    } catch (error) {
      reportFailure(error);
    }

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
    for (let index = 0; index < transparency.length; index++) {
      const alpha = transparency[index];
      if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
        throw new RangeError(
          `VelocityOverlay transparency value ${index} must be finite and between 0 and 1.`
        );
      }
    }
    const candidates = lodIndices;
    const candidateCount = candidates ? candidates.length : cellCount;
    const maxSize = Math.min(this.config.spawnTableSize, candidateCount);
    const table = new Uint32Array(maxSize);
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
      if (transparency[idx] < POINT_VISIBILITY_THRESHOLD) continue;

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
