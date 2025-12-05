// GPU-accelerated 3D noise textures for high-performance volumetric cloud rendering
// Industry-standard approach: tileable 3D textures with Perlin-Worley blend
// Based on techniques from Horizon Zero Dawn, Frostbite, and Guerrilla Games
//
// All noise generation is performed on the GPU using fragment shaders.
// This is ~100-200x faster than CPU generation.

import { generateCloudNoiseTexturesGPU } from './gpu-noise-generator.js';

// Default sizes - can be adjusted via setNoiseResolution
let NOISE_SIZE = 128;  // Base shape noise resolution
let DETAIL_SIZE = 128; // Detail noise resolution

// Reference resolution for adaptive parameter scaling
// Parameters are tuned to look best at this resolution
export const REFERENCE_RESOLUTION = 96;

// Get current noise sizes
export function getNoiseResolution() {
  return { shapeSize: NOISE_SIZE, detailSize: DETAIL_SIZE };
}

// Set noise resolution (will take effect on next generation)
export function setNoiseResolution(shapeSize, detailSize) {
  NOISE_SIZE = Math.max(32, Math.min(256, shapeSize || 128));
  DETAIL_SIZE = Math.max(32, Math.min(256, detailSize || NOISE_SIZE));
  console.log(`[NoiseTextures] Resolution set to shape=${NOISE_SIZE}³, detail=${DETAIL_SIZE}³`);
}

// Calculate scale factor for adaptive parameter adjustment
// Returns a multiplier to apply to spatial parameters (noiseScale, warpStrength, etc.)
// so they produce visually consistent results at different resolutions
export function getResolutionScaleFactor() {
  // When resolution increases, noise has more detail per unit space
  // To maintain the same visual scale, we need to reduce spatial parameters
  return REFERENCE_RESOLUTION / NOISE_SIZE;
}

// Main export: GPU-based generation (synchronous, very fast ~50-200ms)
export function generateCloudNoiseTextures(gl) {
  console.log(`[NoiseTextures] Using GPU-accelerated generation (${NOISE_SIZE}³)`);
  return Promise.resolve(generateCloudNoiseTexturesGPU(gl, NOISE_SIZE, DETAIL_SIZE));
}
