/**
 * One spatial-tree build: the tree over a geometry's positions and its draw
 * order (banded by LOD when `buildLOD`), as the worker computes it
 * (`spatial-tree-worker.js`) and as the renderer computes it inline where no
 * worker can take the job (`createInlineSpatialTreeBuilder`).
 */
import { buildSpatialTree, decodeSpatialTree, encodeSpatialTree } from './spatial-tree.js';
import { computeTreeDrawOrder, drawOrderTransferList, dropDerivableLeafIds, leafIdsFollowDrawOrder } from './draw-order.js';
import { DEFAULT_CELL_PRIORITY, reviveCellPriority } from '../../data/cell-priority.js';

/**
 * @param {{positions: Float32Array|null, dimensionLevel: number, maxPointsPerNode: number, maxDepth: number, buildLOD: boolean,
 *   priority?: {seed: number|null, originals: Uint32Array|null}}} request - `priority`: the cells'
 *   priority (`data/cell-priority.js`), the order LOD levels admit them in; by default every
 *   point ranked under the default seed.
 * @param {{releasePositions?: boolean}} [options] - `releasePositions`: set
 *   the request's `positions` to null once the tree is built (for a caller
 *   whose request is their only holder).
 * @returns {{tree: {bounds: object, root: object}, order: object}}
 */
export function buildSpatialTreeJob(request, { releasePositions = false } = {}) {
  const { dimensionLevel, maxPointsPerNode, maxDepth, buildLOD, priority = DEFAULT_CELL_PRIORITY } = request;
  const pointCount = request.positions.length / dimensionLevel;
  const tree = buildSpatialTree(request.positions, dimensionLevel, maxPointsPerNode, maxDepth);
  // Nothing after the tree reads a position. With `releasePositions` (the
  // tree worker, whose request alone holds its copy) the request lets go of
  // them, so that copy (12 bytes a point in 3D, 1.2 GB at 100M) is not held
  // through the leaf packing and the draw order, the build's peak.
  if (releasePositions) request.positions = null;
  // A tree whose leaf ids its draw order holds (3D) lets them go once the
  // order is made (`dropDerivableLeafIds`): 4 bytes a point neither
  // crosses to the page nor stays there. Any other packs them for the reply.
  const derivable = leafIdsFollowDrawOrder(dimensionLevel);
  if (!derivable) packLeafIndices(tree, pointCount);
  const order = computeTreeDrawOrder(pointCount, tree, dimensionLevel, buildLOD === true, reviveCellPriority(priority));
  if (derivable) dropDerivableLeafIds(tree.root, dimensionLevel);
  return { tree, order };
}

/**
 * Move every leaf's ids into one shared buffer (each leaf keeps a view of
 * its range), so a tree crosses to the main thread as one transferred
 * buffer instead of one per leaf: tens of thousands of transfers made the
 * receiving task cost about 50 ms at 10M points.
 *
 * @param {{root: object}} tree
 * @param {number} pointCount
 */
function packLeafIndices(tree, pointCount) {
  const packed = new Uint32Array(pointCount);
  let offset = 0;
  const stack = [tree.root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null) continue;
    if (node.indices) {
      packed.set(node.indices, offset);
      node.indices = packed.subarray(offset, offset + node.indices.length);
      offset += node.indices.length;
    }
    if (node.children) for (const child of node.children) stack.push(child);
  }
}

/**
 * A build's result as the worker sends it: the tree as typed arrays
 * (`encodeSpatialTree`) and the draw order, every buffer transferred.
 *
 * @param {{tree: object, order: object}} result
 * @param {1|2|3} dimensionLevel
 * @returns {{reply: {tree: object, order: object}, transfer: ArrayBuffer[]}}
 */
export function encodeSpatialTreeJobResult(result, dimensionLevel) {
  const { encoded, transfer } = encodeSpatialTree(result.tree, dimensionLevel);
  return {
    reply: { tree: encoded, order: result.order },
    transfer: [...transfer, ...drawOrderTransferList(result.order)],
  };
}

/**
 * The result `encodeSpatialTreeJobResult` encoded, as `buildSpatialTreeJob`
 * returned it.
 *
 * @param {{tree: object, order: object}} reply
 * @returns {{tree: {bounds: object, root: object}, order: object}}
 */
export function decodeSpatialTreeJobResult(reply) {
  return { tree: decodeSpatialTree(reply.tree), order: reply.order };
}
