/**
 * Builds a spatial tree and its draw order off the main thread. The renderer
 * sends a copy of a geometry's positions in slices (`kind: 'positions'`,
 * each transferred), assembled here into one array that may exceed an
 * `ArrayBuffer` (`ArrayAssembly`, `utils/large-arrays.js`: 3-D positions
 * above 178.8M cells on Chromium), then the build request (`kind: 'build'`); the tree and
 * its draw order (banded by LOD when asked) come back as typed arrays, every
 * buffer transferred, not copied (`encodeSpatialTreeJobResult`). The
 * renderer installs a tree only if the positions it was built over are still
 * the ones it asked for. See `buildSpatialTreeJob`.
 */
import { buildSpatialTreeJob, encodeSpatialTreeJobResult } from './spatial-tree-job.js';
import { ArrayAssembly } from '../../utils/large-arrays.js';

const pendingPositions = new Map();

self.onmessage = ({ data }) => {
  const { id } = data;
  try {
    if (data.kind === 'positions') {
      let positions = pendingPositions.get(id);
      if (positions === undefined) {
        positions = new ArrayAssembly(Float32Array, data.total);
        pendingPositions.set(id, positions);
      }
      if (data.slice.length > 0) positions.put(data.offset, data.slice);
      return;
    }
    // The request alone holds the positions, so the build lets go of them
    // once its tree is built (`buildSpatialTreeJob`).
    const assembly = pendingPositions.get(id);
    pendingPositions.delete(id);
    if (assembly === undefined) throw new Error('build request arrived without its positions');
    const request = { ...data, positions: assembly.result };
    delete request.kind;
    const { reply, transfer } = encodeSpatialTreeJobResult(
      buildSpatialTreeJob(request, { releasePositions: true }),
      request.dimensionLevel
    );
    self.postMessage({ id, ...reply }, transfer);
  } catch (error) {
    pendingPositions.delete(id);
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
