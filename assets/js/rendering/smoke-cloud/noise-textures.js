// GPU-accelerated 3D noise textures for high-performance volumetric cloud rendering
// Industry-standard approach: tileable 3D textures with Perlin-Worley blend
// Based on techniques from Horizon Zero Dawn, Frostbite, and Guerrilla Games
//
// All noise generation is performed on the GPU using fragment shaders.
// This is ~100-200x faster than CPU generation.

import { startCloudNoiseGenerationGPU } from './gpu-noise-generator.js';
import {
  MAX_SMOKE_NOISE_RESOLUTION,
  MIN_SMOKE_NOISE_RESOLUTION,
} from './smoke-density-contract.js';

// Reference resolution for adaptive parameter scaling
// Parameters are tuned to look best at this resolution
const REFERENCE_RESOLUTION = 96;

function requireNoiseResolution(value, owner) {
  if (
    !Number.isInteger(value)
    || value < MIN_SMOKE_NOISE_RESOLUTION
    || value > MAX_SMOKE_NOISE_RESOLUTION
  ) {
    throw new RangeError(
      `Smoke noise ${owner} must be an integer between ${MIN_SMOKE_NOISE_RESOLUTION} and ${MAX_SMOKE_NOISE_RESOLUTION}.`
    );
  }
  return value;
}

// Calculate scale factor for adaptive parameter adjustment
// Returns a multiplier to apply to spatial parameters (noiseScale, warpStrength, etc.)
// so they produce visually consistent results at different resolutions
export function getResolutionScaleFactor(noiseSize) {
  const exactNoiseSize = requireNoiseResolution(noiseSize, 'resolution');
  // When resolution increases, noise has more detail per unit space
  // To maintain the same visual scale, we need to reduce spatial parameters
  return REFERENCE_RESOLUTION / exactNoiseSize;
}

// Frame-batched generation used by SmokeRenderer. The returned transaction
// owns every candidate resource until exact completion and explicit transfer.
export function startCloudNoiseTextureGeneration(
  gl,
  shapeSize,
  detailSize,
  options = undefined
) {
  const exactShapeSize = requireNoiseResolution(shapeSize, 'shapeSize');
  const exactDetailSize = requireNoiseResolution(detailSize, 'detailSize');
  console.log(
    `[NoiseTextures] Starting frame-batched GPU generation `
    + `(shape=${exactShapeSize}³, detail=${exactDetailSize}³)`
  );
  return startCloudNoiseGenerationGPU(
    gl,
    exactShapeSize,
    exactDetailSize,
    options
  );
}
