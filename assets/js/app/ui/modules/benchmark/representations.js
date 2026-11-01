/**
 * Synthetic multi-representation datasets for the benchmark.
 *
 * A real dataset can carry several embeddings of one dimension (UMAP, t-SNE
 * and PCA in 2D, say). The benchmark reproduces that from one generated point
 * cloud: "five" adds representations derived from the generated positions so
 * the dataset has three in 3D and two in 2D. Each is a different geometry --
 * rotated, warped, projected -- so its spatial tree, LOD levels and frustum
 * bounds differ from the original's, as another embedding's would. Each is
 * produced only when a view first shows it (see
 * `createInMemoryDimensionManager`), like a lazy load.
 *
 * @module ui/modules/benchmark/representations
 */

import { allocateLargeArray } from '../../../../utils/large-arrays.js';

/** The choices of the benchmark's Representations select. */
export const SYNTHETIC_REPRESENTATION_SETS = Object.freeze(['one', 'five']);

function rotation3D(positions, n, { yaw, pitch }) {
  const out = new Float32Array(n * 3);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const x1 = cy * x + sy * z;
    const z1 = -sy * x + cy * z;
    out[i * 3] = x1;
    out[i * 3 + 1] = cp * y - sp * z1;
    out[i * 3 + 2] = sp * y + cp * z1;
  }
  return out;
}

function warp3D(read, n) {
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = read(i);
    out[i * 3] = x + 0.25 * Math.sin(3 * y);
    out[i * 3 + 1] = y + 0.35 * Math.sin(2.5 * x);
    out[i * 3 + 2] = 0.6 * z + 0.3 * Math.cos(2 * y);
  }
  return out;
}

function project2D(read, n, mix) {
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = read(i);
    out[i * 2] = x + mix * z;
    out[i * 2 + 1] = y - mix * x + 0.2 * z;
  }
  return out;
}

/**
 * The extra representations of one generated dataset, for
 * `createInMemoryDimensionManager({representations})`.
 *
 * @param {Float32Array} positions - The generated, normalized positions.
 * @param {number} dimension - Their components per point (2 or 3).
 * @param {'one'|'five'} set
 * @returns {Array<{layoutKey: string, label: string, dimension: number, produce: () => Float32Array}>}
 */
export function syntheticRepresentations(positions, dimension, set) {
  if (!SYNTHETIC_REPRESENTATION_SETS.includes(set)) {
    throw new RangeError(`Synthetic representation set must be one of ${SYNTHETIC_REPRESENTATION_SETS.join(', ')}.`);
  }
  if (set === 'one') return [];
  if (dimension !== 2 && dimension !== 3) {
    throw new RangeError('Synthetic representations derive from 2D or 3D points.');
  }
  const n = positions.length / dimension;
  const read = dimension === 3
    ? i => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]
    : i => {
      const x = positions[i * 2];
      const y = positions[i * 2 + 1];
      return [x, y, 0.4 * Math.sin(3 * x) * Math.cos(2 * y)];
    };
  const lifted = () => {
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const [x, y, z] = read(i);
      out[i * 3] = x;
      out[i * 3 + 1] = y;
      out[i * 3 + 2] = z;
    }
    return out;
  };
  // Three 3D and two 2D representations in all, counting the generated one.
  const threeD = [
    { layoutKey: 'tilted_3d', label: 'Tilted', produce: () => rotation3D(lifted(), n, { yaw: 0.7, pitch: 0.45 }) },
    { layoutKey: 'warped_3d', label: 'Warped', produce: () => warp3D(read, n) },
  ];
  const twoD = [
    { layoutKey: 'flat_2d', label: 'Flat', produce: () => project2D(read, n, 0) },
    { layoutKey: 'sheared_2d', label: 'Sheared', produce: () => project2D(read, n, 0.45) },
  ];
  const extras = dimension === 3
    ? [...threeD, ...twoD]
    : [...threeD, { layoutKey: 'lifted_3d', label: 'Lifted', produce: lifted }, twoD[1]];
  return extras.map(item => ({
    ...item,
    dimension: item.layoutKey.endsWith('_3d') ? 3 : 2,
  }));
}
