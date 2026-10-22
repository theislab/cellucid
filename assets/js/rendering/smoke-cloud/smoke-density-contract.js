// The density grid tops out at 128³: its RGBA32F splat atlas is then
// 1536×1408, inside WebGL2's guaranteed 2048 MAX_TEXTURE_SIZE, and its 8 MiB
// RGBA8 volume inside the guaranteed 256 MAX_3D_TEXTURE_SIZE. No device can be
// asked for a grid it cannot allocate.
export const MAX_SMOKE_GRID_SIZE = 128;

export const SMOKE_GRID_SIZES = Object.freeze([
  32,
  48,
  64,
  96,
  MAX_SMOKE_GRID_SIZE,
]);

// The two procedural noise volumes are RGBA8 with mipmaps: 18 MiB together at
// 128³. Finer noise is not visible through a 128³ density grid at a fraction
// of screen resolution, and at 256³ the pair cost 146 MiB of GPU memory.
export const MIN_SMOKE_NOISE_RESOLUTION = 32;
export const MAX_SMOKE_NOISE_RESOLUTION = 128;

export const SMOKE_NOISE_RESOLUTIONS = Object.freeze([
  MIN_SMOKE_NOISE_RESOLUTION,
  48,
  64,
  96,
  MAX_SMOKE_NOISE_RESOLUTION,
]);

export class SmokeDensityBuildError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'SmokeDensityBuildError';
  }
}

/**
 * The device lacks a WebGL capability smoke requires (smoke-capabilities.js).
 * `message` is written for the person using the app; `detail` names the
 * missing capability for the console and bug reports.
 */
export class SmokeUnsupportedError extends Error {
  constructor(support) {
    super(support.message);
    this.name = 'SmokeUnsupportedError';
    this.reason = support.reason;
    this.detail = support.detail;
  }
}
