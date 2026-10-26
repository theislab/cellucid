/**
 * The 1D/2D/3D spatial tree (binary tree, quadtree or octree) that LOD,
 * frustum culling and cell picking walk. Pure functions over typed arrays, so
 * the same code builds the tree on the main thread (`SpatialIndex`) and in
 * `spatial-tree-worker.js`, which builds it off the main thread for a hover
 * reader that must never block the page.
 */

import { formatCountOf } from '../../utils/format-units.js';

function createIndexArray(count) {
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;
  return indices;
}

function calculateBounds(tree) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  const positions = tree.positions;
  const count = tree.pointCount;
  const stride = tree.dimensionLevel;

  for (let i = 0; i < count; i++) {
    const x = positions[i * stride];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  if (stride >= 2) {
    for (let i = 0; i < count; i++) {
      const y = positions[i * stride + 1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  } else {
    // An axis the embedding does not have is exactly zero.
    minY = 0;
    maxY = 0;
  }
  if (stride >= 3) {
    for (let i = 0; i < count; i++) {
      const z = positions[i * stride + 2];
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  } else {
    minZ = 0;
    maxZ = 0;
  }

  // Calculate extents
  const extentX = maxX - minX;
  const extentY = maxY - minY;
  const extentZ = maxZ - minZ;

  // Use dynamic padding based on max extent - ensures flat dimensions get meaningful padding
  // This is critical for 1D/2D data where one or more dimensions are essentially zero
  const maxExtent = Math.max(extentX, extentY, extentZ, 0.001);
  const basePad = maxExtent * 0.001; // 0.1% of largest extent

  // For flat dimensions (extent < 1% of max), use LARGE padding (50% of max extent)
  // This ensures frustum culling doesn't clip quadtree nodes at different Z depths
  // causing grid artifacts in 2D views. The large Z padding ensures all nodes
  // span the full camera near-to-far range.
  const flatThreshold = maxExtent * 0.01;
  const flatPad = maxExtent * 0.5; // 50% padding for flat dimensions

  const padX = extentX < flatThreshold ? flatPad : basePad;
  const padY = extentY < flatThreshold ? flatPad : basePad;
  const padZ = extentZ < flatThreshold ? flatPad : basePad;

  return {
    minX: minX - padX, minY: minY - padY, minZ: minZ - padZ,
    maxX: maxX + padX, maxY: maxY + padY, maxZ: maxZ + padZ
  };
}

function buildNode(tree, indices, bounds, depth) {
  const node = {
    bounds,
    indices: null,
    children: null,
    pointCount: indices.length
  };

  if (indices.length <= tree.maxPointsPerNode || depth >= tree.maxDepth) {
    node.indices = indices;
    return node;
  }

  const midX = (bounds.minX + bounds.maxX) * 0.5;
  const midY = (bounds.minY + bounds.maxY) * 0.5;
  const midZ = (bounds.minZ + bounds.maxZ) * 0.5;

  const dimLevel = tree.dimensionLevel;
  const numChildren = tree.childCount; // 2, 4, or 8

  // Generate child bounds based on dimension level
  // 1D: 2 children (left/right on X)
  // 2D: 4 children (quadtree on XY)
  // 3D: 8 children (octree on XYZ)
  const childBounds = [];
  for (let c = 0; c < numChildren; c++) {
    const xSplit = (c & 1) !== 0;
    const ySplit = dimLevel >= 2 ? ((c & 2) !== 0) : false;
    const zSplit = dimLevel >= 3 ? ((c & 4) !== 0) : false;

    // For dimensions being split: divide at mid point (upper/lower halves)
    // For dimensions NOT being split: children inherit FULL parent range
    // This is critical for correct frustum culling in lower dimensions
    //
    // When splitting a dimension (e.g., Y in 2D mode):
    //   - split=true means upper half: [mid, max]
    //   - split=false means lower half: [min, mid]
    // When NOT splitting a dimension (e.g., Y in 1D mode):
    //   - full range: [min, max]
    childBounds.push({
      minX: xSplit ? midX : bounds.minX,
      maxX: xSplit ? bounds.maxX : midX,
      // Y bounds: split into halves if dimLevel >= 2, otherwise inherit full range
      minY: ySplit ? midY : bounds.minY,
      maxY: (dimLevel >= 2) ? (ySplit ? bounds.maxY : midY) : bounds.maxY,
      // Z bounds: split into halves if dimLevel >= 3, otherwise inherit full range
      minZ: zSplit ? midZ : bounds.minZ,
      maxZ: (dimLevel >= 3) ? (zSplit ? bounds.maxZ : midZ) : bounds.maxZ
    });
  }

  const positions = tree.positions;
  const n = indices.length;

  // Count first, then recompute the child during distribution. Retaining one
  // byte per point at every recursive level creates a large transient-memory
  // multiplier, especially for degenerate inputs.
  const childCounts = new Uint32Array(numChildren);
  let occupiedChildCount = 0;
  let onlyOccupiedChild = -1;

  for (let i = 0; i < n; i++) {
    const idx = indices[i];
    const base = idx * dimLevel;

    // Compute child index based on dimension level (branchless for perf)
    let childIdx = (positions[base] >= midX) | 0;
    if (dimLevel >= 2) childIdx += ((positions[base + 1] >= midY) | 0) << 1;
    if (dimLevel >= 3) childIdx += ((positions[base + 2] >= midZ) | 0) << 2;

    if (childCounts[childIdx] === 0) {
      occupiedChildCount++;
      onlyOccupiedChild = childIdx;
    }
    childCounts[childIdx]++;
  }

  // A unary partition must preserve the exact index owner. Allocating and
  // copying N indices at every depth turns identical-coordinate datasets
  // into O(N * maxDepth) allocation/copy work for no semantic benefit.
  if (occupiedChildCount === 1) {
    node.children = new Array(numChildren).fill(null);
    node.children[onlyOccupiedChild] = buildNode(tree, 
      indices,
      childBounds[onlyOccupiedChild],
      depth + 1
    );
    return node;
  }

  // Pre-allocate child arrays based on counts
  const childIndices = childBounds.map((_, i) =>
    childCounts[i] > 0 ? new Uint32Array(childCounts[i]) : null
  );
  const childOffsets = new Uint32Array(numChildren);

  // Second pass: recompute the child and distribute into exact-size owners.
  // The additional sequential position reads are cheaper than allocating,
  // filling, and collecting an N-byte routing owner per internal node.
  for (let i = 0; i < n; i++) {
    const idx = indices[i];
    const base = idx * dimLevel;
    let childIdx = (positions[base] >= midX) | 0;
    if (dimLevel >= 2) {
      childIdx += ((positions[base + 1] >= midY) | 0) << 1;
    }
    if (dimLevel >= 3) {
      childIdx += ((positions[base + 2] >= midZ) | 0) << 2;
    }
    childIndices[childIdx][childOffsets[childIdx]++] = idx;
  }

  node.children = childBounds.map((cb, i) =>
    childIndices[i] !== null
      ? buildNode(tree, childIndices[i], cb, depth + 1)
      : null
  );

  return node;
}

/**
 * The padded bounds the tree is built in.
 *
 * @param {Float32Array} positions
 * @param {1|2|3} dimensionLevel
 * @returns {{minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number}}
 */
export function calculateSpatialBounds(positions, dimensionLevel) {
  return calculateBounds({ positions, dimensionLevel, pointCount: positions.length / dimensionLevel });
}

/**
 * Build the tree over `positions` (`dimensionLevel` components per point).
 *
 * @param {Float32Array} positions
 * @param {1|2|3} dimensionLevel
 * @param {number} maxPointsPerNode
 * @param {number} maxDepth
 * @returns {{ bounds: object, root: object }}
 */
export function buildSpatialTree(positions, dimensionLevel, maxPointsPerNode, maxDepth) {
  const tree = {
    positions,
    dimensionLevel,
    pointCount: positions.length / dimensionLevel,
    childCount: 1 << dimensionLevel,
    maxPointsPerNode,
    maxDepth,
  };
  const bounds = calculateBounds(tree);
  const root = buildNode(tree, createIndexArray(tree.pointCount), bounds, 0);
  return { bounds, root };
}

/**
 * A tree handed back from the worker must cover exactly the point set it is
 * installed over.
 *
 * @param {unknown} tree
 * @param {number} pointCount
 */
export function requirePrebuiltSpatialTree(tree, pointCount) {
  const bounds = tree?.bounds;
  if (
    tree === null || typeof tree !== 'object'
    || bounds === null || typeof bounds !== 'object'
    || !['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'].every(key => Number.isFinite(bounds[key]))
    || tree.root === null || typeof tree.root !== 'object'
    || tree.root.pointCount !== pointCount
  ) {
    throw new TypeError(
      `A prebuilt spatial tree must have finite bounds and a root over exactly ${formatCountOf(pointCount, 'point')}.`
    );
  }
}

/**
 * The tree as a few typed arrays, for the worker's reply: a structured clone
 * of the node objects costs about a microsecond a node on the receiving
 * thread (38,568 nodes of a 10M-point octree: 35 ms in one task), while the
 * arrays are transferred, not copied. `decodeSpatialTree` rebuilds the same
 * tree. Call it after the draw order numbered the tree (`leafStart`,
 * `leafEnd`, `drawUnit`) and after its leaves' ids were packed into one
 * buffer (`spatial-tree-job.js`).
 *
 * @param {{bounds: object, root: object}} tree
 * @param {1|2|3} dimensionLevel
 * @returns {{encoded: object, transfer: ArrayBuffer[]}}
 */
export function encodeSpatialTree(tree, dimensionLevel) {
  const childCount = 1 << dimensionLevel;
  const nodes = [];
  const stack = [tree.root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null) continue;
    nodes.push(node);
    if (node.children) for (const child of node.children) stack.push(child);
  }
  const count = nodes.length;
  const ids = new Map();
  for (let id = 0; id < count; id++) ids.set(nodes[id], id);
  const bounds = new Float64Array(count * 6);
  const pointCounts = new Float64Array(count);
  // -1: not numbered (below a draw unit); drawUnit -1/0/1 for absent/false/true.
  const leafRanges = new Float64Array(count * 2).fill(-1);
  const drawUnits = new Int8Array(count).fill(-1);
  // -1 for an empty child slot; a node without children has no slots
  // (hasChildren 0).
  const hasChildren = new Uint8Array(count);
  const children = new Int32Array(count * childCount).fill(-1);
  const indexStarts = new Float64Array(count).fill(-1);
  let packed = null;
  for (let id = 0; id < count; id++) {
    const node = nodes[id];
    const b = node.bounds;
    bounds.set([b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ], id * 6);
    pointCounts[id] = node.pointCount;
    if (node.leafStart !== undefined) {
      leafRanges[id * 2] = node.leafStart;
      leafRanges[id * 2 + 1] = node.leafEnd;
    }
    if (node.drawUnit !== undefined) drawUnits[id] = node.drawUnit ? 1 : 0;
    if (node.children) {
      hasChildren[id] = 1;
      for (let slot = 0; slot < node.children.length; slot++) {
        const child = node.children[slot];
        if (child !== null) children[id * childCount + slot] = ids.get(child);
      }
    }
    if (node.indices) {
      if (packed === null) packed = node.indices.buffer;
      if (node.indices.buffer !== packed) {
        throw new Error('A spatial tree to encode must keep every leaf\'s ids in one buffer.');
      }
      indexStarts[id] = node.indices.byteOffset / 4;
    }
  }
  const indices = packed === null ? new Uint32Array(0) : new Uint32Array(packed);
  const encoded = {
    nodeCount: count, childCount,
    bounds, pointCounts, leafRanges, drawUnits, hasChildren, children, indexStarts, indices,
  };
  const transfer = [bounds, pointCounts, leafRanges, drawUnits, hasChildren, children, indexStarts, indices]
    .map(array => array.buffer);
  return { encoded, transfer };
}

/**
 * The tree `encodeSpatialTree` encoded: the same nodes, bounds, children,
 * numbering and leaf ids (views of one buffer).
 *
 * @param {ReturnType<typeof encodeSpatialTree>['encoded']} encoded
 * @returns {{bounds: object, root: object}}
 */
export function decodeSpatialTree(encoded) {
  const {
    nodeCount, childCount,
    bounds, pointCounts, leafRanges, drawUnits, hasChildren, children, indexStarts, indices,
  } = encoded;
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 1 || !(indices instanceof Uint32Array)) {
    throw new TypeError('An encoded spatial tree needs at least its root and its leaf ids.');
  }
  const nodes = new Array(nodeCount);
  for (let id = 0; id < nodeCount; id++) {
    const at = id * 6;
    const start = indexStarts[id];
    const count = pointCounts[id];
    const numbered = leafRanges[id * 2] >= 0;
    const unit = drawUnits[id];
    nodes[id] = {
      bounds: {
        minX: bounds[at], minY: bounds[at + 1], minZ: bounds[at + 2],
        maxX: bounds[at + 3], maxY: bounds[at + 4], maxZ: bounds[at + 5],
      },
      indices: start >= 0 ? indices.subarray(start, start + count) : null,
      children: null,
      pointCount: count,
      leafStart: numbered ? leafRanges[id * 2] : undefined,
      drawUnit: unit < 0 ? undefined : unit === 1,
      leafEnd: numbered ? leafRanges[id * 2 + 1] : undefined,
    };
  }
  for (let id = 0; id < nodeCount; id++) {
    if (hasChildren[id] !== 1) continue;
    const list = new Array(childCount);
    for (let slot = 0; slot < childCount; slot++) {
      const child = children[id * childCount + slot];
      list[slot] = child < 0 ? null : nodes[child];
    }
    nodes[id].children = list;
  }
  const root = nodes[0];
  return { bounds: root.bounds, root };
}
