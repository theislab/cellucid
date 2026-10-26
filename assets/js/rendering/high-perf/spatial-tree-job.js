/**
 * One spatial-tree build: the tree over a geometry's positions and its draw
 * order (banded by LOD when `buildLOD`), as the worker computes it
 * (`spatial-tree-worker.js`) and as the renderer computes it inline where no
 * worker can take the job (`createInlineSpatialTreeBuilder`).
 */
import { buildSpatialTree, decodeSpatialTree, encodeSpatialTree } from './spatial-tree.js';
import { computeTreeDrawOrder, drawOrderTransferList } from './draw-order.js';

/**
 * @param {{positions: Float32Array, dimensionLevel: number, maxPointsPerNode: number, maxDepth: number, buildLOD: boolean}} request
 * @returns {{tree: {bounds: object, root: object}, order: object}}
 */
export function buildSpatialTreeJob({ positions, dimensionLevel, maxPointsPerNode, maxDepth, buildLOD }) {
  const tree = buildSpatialTree(positions, dimensionLevel, maxPointsPerNode, maxDepth);
  packLeafIndices(tree, positions.length / dimensionLevel);
  const order = computeTreeDrawOrder(positions, tree, dimensionLevel, buildLOD === true);
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
