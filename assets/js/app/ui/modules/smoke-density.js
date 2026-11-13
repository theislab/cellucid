/**
 * @fileoverview The smoke volume, built again from the cells the dataset
 * shows: their positions, colors and visibility as the state publishes them
 * (`getSmokeDensitySource`), at the grid size the smoke controls ask for.
 *
 * It owns only that rebuild. When it runs (switching to smoke, a change of
 * grid size or of the cells shown) is the render controls' (`initUI`'s
 * `smoke.rebuildSmokeDensity`); the volume itself is the viewer's.
 *
 * @module app/ui/modules/smoke-density
 */

import { MAX_SMOKE_GRID_SIZE } from '../../../rendering/smoke-cloud/smoke-density-contract.js';
import { debug } from '../../../utils/debug.js';

/**
 * @param {{
 *   state: {getSmokeDensitySource: () => object|null},
 *   viewer: {clearSmokeVolume: () => void, buildSmokeVolumeGPU: (positions: Float32Array, options: object) => void},
 * }} options
 * @returns {(gridSize: number) => void} Rebuild the volume at `gridSize` (8 through `MAX_SMOKE_GRID_SIZE`).
 */
export function createSmokeDensityRebuild({ state, viewer }) {
  function rebuildSmokeDensity(gridSize) {
    if (
      !Number.isInteger(gridSize)
      || gridSize < 8
      || gridSize > MAX_SMOKE_GRID_SIZE
    ) {
      throw new RangeError(
        `Smoke density rebuild requires an exact gridSize integer from 8 through ${MAX_SMOKE_GRID_SIZE}.`
      );
    }
    if (typeof state.getSmokeDensitySource !== 'function') {
      throw new TypeError(
        'Smoke density rebuild requires getSmokeDensitySource().'
      );
    }
    const source = state.getSmokeDensitySource();
    if (
      source === null
      || typeof source !== 'object'
      || Array.isArray(source)
      || Object.getPrototypeOf(source) !== Object.prototype
      || Object.keys(source).sort().join(',') !==
        'alpha,colors,dimension,outlierQuantiles,outlierThreshold,positions,writes'
      || !(source.positions instanceof Float32Array)
      || ![1, 2, 3].includes(source.dimension)
      || source.positions.length % source.dimension !== 0
    ) {
      throw new TypeError(
        'Smoke density rebuild requires one exact zero-copy dataset source.'
      );
    }
    if (source.positions.length === 0) {
      viewer.clearSmokeVolume();
      debug.log('Cleared smoke volume because the dataset is empty.');
      return;
    }

    debug.log(
      `Building smoke volume at ${gridSize}^3 from ` +
      `${source.positions.length / source.dimension} dataset points with bounded ` +
      `visibility streaming (GPU)…`
    );
    viewer.buildSmokeVolumeGPU(source.positions, {
      colors: source.colors,
      dimension: source.dimension,
      gridSize,
      gamma: 0.7,
      visibility: {
        alpha: source.alpha,
        outlierQuantiles: source.outlierQuantiles,
        outlierThreshold: source.outlierThreshold,
      },
      writes: source.writes,
    });
  }
  return rebuildSmokeDensity;
}
