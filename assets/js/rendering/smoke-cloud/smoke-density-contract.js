export const MAX_SMOKE_GRID_SIZE = 128;

export const SMOKE_GRID_SIZES = Object.freeze([
  32,
  48,
  64,
  96,
  MAX_SMOKE_GRID_SIZE,
]);

export class SmokeDensityBuildError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'SmokeDensityBuildError';
  }
}
