/**
 * Builds a spatial tree and its draw order off the main thread. The renderer
 * sends a copy of a geometry's positions in slices (`kind: 'positions'`,
 * each transferred), then the build request (`kind: 'build'`); the tree and
 * its draw order (banded by LOD when asked) come back with their buffers
 * transferred, not copied. The renderer installs a tree only if the positions
 * it was built over are still the ones it asked for. See `buildSpatialTreeJob`.
 */
import { buildSpatialTreeJob, spatialTreeJobTransferList } from './spatial-tree-job.js';

const pendingPositions = new Map();

self.onmessage = ({ data }) => {
  const { id } = data;
  try {
    if (data.kind === 'positions') {
      let positions = pendingPositions.get(id);
      if (positions === undefined) {
        positions = new Float32Array(data.total);
        pendingPositions.set(id, positions);
      }
      positions.set(data.slice, data.offset);
      return;
    }
    const positions = pendingPositions.get(id);
    pendingPositions.delete(id);
    if (positions === undefined) throw new Error('build request arrived without its positions');
    const request = { ...data, positions };
    delete request.kind;
    const result = buildSpatialTreeJob(request);
    self.postMessage({ id, ...result }, spatialTreeJobTransferList(result));
  } catch (error) {
    pendingPositions.delete(id);
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
