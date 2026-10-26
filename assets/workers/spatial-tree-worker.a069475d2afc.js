// assets/js/utils/format-units.js
var BYTE_UNITS = Object.freeze(["B", "KB", "MB", "GB", "TB", "PB"]);
var GROUPED_INTEGER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});
function formatCount(value) {
  requireCount(value);
  return GROUPED_INTEGER.format(value);
}
function requireCount(value) {
  if (typeof value === "bigint") return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Count must be a finite number");
  }
}
function formatCountOf(value, singular, plural = `${singular}s`) {
  return `${formatCount(value)} ${countNoun(value, singular, plural)}`;
}
function countNoun(value, singular, plural = `${singular}s`) {
  if (typeof singular !== "string" || singular.length === 0) {
    throw new TypeError("A counted noun must be non-empty text");
  }
  requireCount(value);
  return Number(value) === 1 ? singular : plural;
}

// assets/js/rendering/high-perf/spatial-tree.js
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
  const extentX = maxX - minX;
  const extentY = maxY - minY;
  const extentZ = maxZ - minZ;
  const maxExtent = Math.max(extentX, extentY, extentZ, 1e-3);
  const basePad = maxExtent * 1e-3;
  const flatThreshold = maxExtent * 0.01;
  const flatPad = maxExtent * 0.5;
  const padX = extentX < flatThreshold ? flatPad : basePad;
  const padY = extentY < flatThreshold ? flatPad : basePad;
  const padZ = extentZ < flatThreshold ? flatPad : basePad;
  return {
    minX: minX - padX,
    minY: minY - padY,
    minZ: minZ - padZ,
    maxX: maxX + padX,
    maxY: maxY + padY,
    maxZ: maxZ + padZ
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
  const numChildren = tree.childCount;
  const childBounds = [];
  for (let c = 0; c < numChildren; c++) {
    const xSplit = (c & 1) !== 0;
    const ySplit = dimLevel >= 2 ? (c & 2) !== 0 : false;
    const zSplit = dimLevel >= 3 ? (c & 4) !== 0 : false;
    childBounds.push({
      minX: xSplit ? midX : bounds.minX,
      maxX: xSplit ? bounds.maxX : midX,
      // Y bounds: split into halves if dimLevel >= 2, otherwise inherit full range
      minY: ySplit ? midY : bounds.minY,
      maxY: dimLevel >= 2 ? ySplit ? bounds.maxY : midY : bounds.maxY,
      // Z bounds: split into halves if dimLevel >= 3, otherwise inherit full range
      minZ: zSplit ? midZ : bounds.minZ,
      maxZ: dimLevel >= 3 ? zSplit ? bounds.maxZ : midZ : bounds.maxZ
    });
  }
  const positions = tree.positions;
  const n = indices.length;
  const childCounts = new Uint32Array(numChildren);
  let occupiedChildCount = 0;
  let onlyOccupiedChild = -1;
  for (let i = 0; i < n; i++) {
    const idx = indices[i];
    const base = idx * dimLevel;
    let childIdx = positions[base] >= midX | 0;
    if (dimLevel >= 2) childIdx += (positions[base + 1] >= midY | 0) << 1;
    if (dimLevel >= 3) childIdx += (positions[base + 2] >= midZ | 0) << 2;
    if (childCounts[childIdx] === 0) {
      occupiedChildCount++;
      onlyOccupiedChild = childIdx;
    }
    childCounts[childIdx]++;
  }
  if (occupiedChildCount === 1) {
    node.children = new Array(numChildren).fill(null);
    node.children[onlyOccupiedChild] = buildNode(
      tree,
      indices,
      childBounds[onlyOccupiedChild],
      depth + 1
    );
    return node;
  }
  const childIndices = childBounds.map(
    (_, i) => childCounts[i] > 0 ? new Uint32Array(childCounts[i]) : null
  );
  const childOffsets = new Uint32Array(numChildren);
  for (let i = 0; i < n; i++) {
    const idx = indices[i];
    const base = idx * dimLevel;
    let childIdx = positions[base] >= midX | 0;
    if (dimLevel >= 2) {
      childIdx += (positions[base + 1] >= midY | 0) << 1;
    }
    if (dimLevel >= 3) {
      childIdx += (positions[base + 2] >= midZ | 0) << 2;
    }
    childIndices[childIdx][childOffsets[childIdx]++] = idx;
  }
  node.children = childBounds.map(
    (cb, i) => childIndices[i] !== null ? buildNode(tree, childIndices[i], cb, depth + 1) : null
  );
  return node;
}
function buildSpatialTree(positions, dimensionLevel, maxPointsPerNode, maxDepth) {
  const tree = {
    positions,
    dimensionLevel,
    pointCount: positions.length / dimensionLevel,
    childCount: 1 << dimensionLevel,
    maxPointsPerNode,
    maxDepth
  };
  const bounds = calculateBounds(tree);
  const root = buildNode(tree, createIndexArray(tree.pointCount), bounds, 0);
  return { bounds, root };
}
function encodeSpatialTree(tree, dimensionLevel) {
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
  const ids = /* @__PURE__ */ new Map();
  for (let id = 0; id < count; id++) ids.set(nodes[id], id);
  const bounds = new Float64Array(count * 6);
  const pointCounts = new Float64Array(count);
  const leafRanges = new Float64Array(count * 2).fill(-1);
  const drawUnits = new Int8Array(count).fill(-1);
  const hasChildren = new Uint8Array(count);
  const children = new Int32Array(count * childCount).fill(-1);
  const indexStarts = new Float64Array(count).fill(-1);
  let packed = null;
  for (let id = 0; id < count; id++) {
    const node = nodes[id];
    const b = node.bounds;
    bounds.set([b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ], id * 6);
    pointCounts[id] = node.pointCount;
    if (node.leafStart !== void 0) {
      leafRanges[id * 2] = node.leafStart;
      leafRanges[id * 2 + 1] = node.leafEnd;
    }
    if (node.drawUnit !== void 0) drawUnits[id] = node.drawUnit ? 1 : 0;
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
        throw new Error("A spatial tree to encode must keep every leaf's ids in one buffer.");
      }
      indexStarts[id] = node.indices.byteOffset / 4;
    }
  }
  const indices = packed === null ? new Uint32Array(0) : new Uint32Array(packed);
  const encoded = {
    nodeCount: count,
    childCount,
    bounds,
    pointCounts,
    leafRanges,
    drawUnits,
    hasChildren,
    children,
    indexStarts,
    indices
  };
  const transfer = [bounds, pointCounts, leafRanges, drawUnits, hasChildren, children, indexStarts, indices].map((array) => array.buffer);
  return { encoded, transfer };
}

// assets/js/rendering/high-perf/draw-order.js
var HIERARCHICAL_RADIX_BITS = 11;
var HIERARCHICAL_RADIX_SIZE = 1 << HIERARCHICAL_RADIX_BITS;
var HIERARCHICAL_RADIX_MASK = HIERARCHICAL_RADIX_SIZE - 1;
var LOD_FULL_DETAIL_ADMISSION_LEVEL = 255;
var LOCALITY_BITS_BY_DIMENSION = Object.freeze([0, 30, 16, 10]);
var DRAW_UNIT_DEPTH_BY_DIMENSION = Object.freeze([0, 6, 3, Infinity]);
function spreadPairwise(coordinate) {
  let bits = coordinate & 65535;
  bits = (bits | bits << 8) & 16711935;
  bits = (bits | bits << 4) & 252645135;
  bits = (bits | bits << 2) & 858993459;
  bits = (bits | bits << 1) & 1431655765;
  return bits >>> 0;
}
function spreadTriplewise(coordinate) {
  let bits = coordinate & 1023;
  bits = (bits | bits << 16) & 50331903;
  bits = (bits | bits << 8) & 50393103;
  bits = (bits | bits << 4) & 51130563;
  bits = (bits | bits << 2) & 153391689;
  return bits >>> 0;
}
function buildHierarchicalOrder(positions, bounds, dimensionLevel) {
  const dimLevel = dimensionLevel;
  const n = positions.length / dimLevel;
  const axisBits = LOCALITY_BITS_BY_DIMENSION[dimLevel];
  const axisMaximum = (1 << axisBits) - 1;
  const localityBits = axisBits * dimLevel;
  const scaleX = axisMaximum / Math.max(bounds.maxX - bounds.minX, 1e-4);
  const scaleY = axisMaximum / Math.max(bounds.maxY - bounds.minY, 1e-4);
  const scaleZ = axisMaximum / Math.max(bounds.maxZ - bounds.minZ, 1e-4);
  const quantize = (value, minimum, scale) => {
    const bin = Math.floor((value - minimum) * scale);
    return bin < 0 ? 0 : bin > axisMaximum ? axisMaximum : bin;
  };
  let priorities = new Uint32Array(n);
  let sourceIds = new Uint32Array(n);
  let targetIds = new Uint32Array(n);
  let radixOffsets = new Uint32Array(HIERARCHICAL_RADIX_SIZE);
  if (dimLevel === 1) {
    for (let pointIndex = 0; pointIndex < n; pointIndex++) {
      const positionOffset = pointIndex;
      priorities[pointIndex] = quantize(
        positions[positionOffset],
        bounds.minX,
        scaleX
      );
      sourceIds[pointIndex] = pointIndex;
    }
  } else if (dimLevel === 2) {
    for (let pointIndex = 0; pointIndex < n; pointIndex++) {
      const positionOffset = pointIndex * 2;
      const x = quantize(positions[positionOffset], bounds.minX, scaleX);
      const y = quantize(positions[positionOffset + 1], bounds.minY, scaleY);
      priorities[pointIndex] = (spreadPairwise(x) | spreadPairwise(y) << 1) >>> 0;
      sourceIds[pointIndex] = pointIndex;
    }
  } else {
    for (let pointIndex = 0; pointIndex < n; pointIndex++) {
      const positionOffset = pointIndex * 3;
      const x = quantize(positions[positionOffset], bounds.minX, scaleX);
      const y = quantize(positions[positionOffset + 1], bounds.minY, scaleY);
      const z = quantize(positions[positionOffset + 2], bounds.minZ, scaleZ);
      priorities[pointIndex] = (spreadTriplewise(x) | spreadTriplewise(y) << 1 | spreadTriplewise(z) << 2) >>> 0;
      sourceIds[pointIndex] = pointIndex;
    }
  }
  for (let shift = 0; shift < localityBits; shift += HIERARCHICAL_RADIX_BITS) {
    radixOffsets.fill(0);
    for (let index = 0; index < n; index++) {
      const pointId = sourceIds[index];
      const digit = priorities[pointId] >>> shift & HIERARCHICAL_RADIX_MASK;
      radixOffsets[digit]++;
    }
    let offset = 0;
    for (let digit = 0; digit < HIERARCHICAL_RADIX_SIZE; digit++) {
      const count = radixOffsets[digit];
      radixOffsets[digit] = offset;
      offset += count;
    }
    for (let index = 0; index < n; index++) {
      const pointId = sourceIds[index];
      const digit = priorities[pointId] >>> shift & HIERARCHICAL_RADIX_MASK;
      targetIds[radixOffsets[digit]++] = pointId;
    }
    const previousSource = sourceIds;
    sourceIds = targetIds;
    targetIds = previousSource;
  }
  const reversalBits = n <= 1 ? 0 : 32 - Math.clz32(n - 1);
  if (reversalBits > 30) {
    throw new RangeError(
      `Hierarchical ordering supports at most ${formatCountOf(1 << 30, "point")}.`
    );
  }
  const reversalSpan = 1 << reversalBits;
  const highestBit = reversalSpan >>> 1;
  let rank = 0;
  let emitted = 0;
  for (let step = 0; step < reversalSpan; step++) {
    if (rank < n) targetIds[emitted++] = sourceIds[rank];
    let carry = highestBit;
    while (carry !== 0 && (rank & carry) !== 0) {
      rank ^= carry;
      carry >>>= 1;
    }
    rank |= carry;
  }
  if (emitted !== n) {
    throw new Error(
      `Hierarchical ordering emitted ${emitted} of ${formatCountOf(n, "point")}.`
    );
  }
  const hierarchicalOrder = targetIds;
  priorities = null;
  sourceIds = null;
  targetIds = null;
  radixOffsets = null;
  return hierarchicalOrder;
}
function numberDrawUnits(root, dimensionLevel) {
  const unitDepth = DRAW_UNIT_DEPTH_BY_DIMENSION[dimensionLevel];
  const units = [];
  const visit = (node, depth) => {
    node.leafStart = units.length;
    if (node.indices !== null || depth >= unitDepth) {
      if (node.indices !== null && !(node.indices instanceof Uint32Array)) {
        throw new TypeError("Spatial tree leaf membership must be an exact Uint32Array.");
      }
      node.drawUnit = true;
      units.push(node);
    } else if (node.children) {
      node.drawUnit = false;
      for (const child of node.children) {
        if (child) visit(child, depth + 1);
      }
    }
    node.leafEnd = units.length;
  };
  visit(root, 0);
  return units;
}
function buildDrawOrder(root, dimensionLevel, pointCount, hierarchy, prefixCounts) {
  const n = pointCount;
  const leaves = numberDrawUnits(root, dimensionLevel);
  const leafCount = leaves.length;
  const bandCount = prefixCounts === null ? 1 : prefixCounts.length;
  if (bandCount > LOD_FULL_DETAIL_ADMISSION_LEVEL) {
    throw new RangeError("Draw order supports at most 255 LOD bands.");
  }
  const bandEnds = new Uint32Array(bandCount);
  if (prefixCounts === null) {
    bandEnds[0] = n;
  } else {
    let previous = 0;
    for (let band = 0; band < bandCount; band++) {
      const end = prefixCounts[band];
      if (!Number.isSafeInteger(end) || end < previous || end > n) {
        throw new RangeError(`Draw order: LOD ${band} is not one monotonic prefix.`);
      }
      bandEnds[band] = end;
      previous = end;
    }
    if (previous !== n) {
      throw new RangeError("Draw order: LOD bands must end with every point.");
    }
  }
  let bandOf = null;
  if (hierarchy !== null) {
    if (!(hierarchy instanceof Uint32Array) || hierarchy.length !== n) {
      throw new Error("Draw order requires one exact full point hierarchy.");
    }
    bandOf = new Uint8Array(n);
    let rank = 0;
    for (let band = 0; band < bandCount; band++) {
      const end = bandEnds[band];
      for (; rank < end; rank++) bandOf[hierarchy[rank]] = band;
    }
  }
  const unitOf = new Uint32Array(n);
  let placed = 0;
  const assign = (node, unit) => {
    if (node.indices !== null) {
      const leafIndices = node.indices;
      for (let i = 0; i < leafIndices.length; i++) {
        const id = leafIndices[i];
        if (id >= n) {
          throw new RangeError(`Draw order: leaf contains source ID ${id} outside ${formatCountOf(n, "point")}.`);
        }
        unitOf[id] = unit;
      }
      placed += leafIndices.length;
      return;
    }
    if (node.children) {
      for (const child of node.children) {
        if (child) assign(child, unit);
      }
    }
  };
  for (let unit = 0; unit < leafCount; unit++) assign(leaves[unit], unit);
  if (placed !== n) {
    throw new Error(`Draw order: leaves own ${placed} source IDs but the dataset contains ${n}.`);
  }
  const stride = leafCount + 1;
  const leafOffsets = new Uint32Array(bandCount * stride);
  for (let id = 0; id < n; id++) {
    const band = bandOf === null ? 0 : bandOf[id];
    leafOffsets[band * stride + unitOf[id] + 1]++;
  }
  for (let band = 0; band < bandCount; band++) {
    const base = band * stride;
    let running = band === 0 ? 0 : bandEnds[band - 1];
    leafOffsets[base] = running;
    for (let unit = 1; unit <= leafCount; unit++) {
      running += leafOffsets[base + unit];
      leafOffsets[base + unit] = running;
    }
    if (running !== bandEnds[band]) {
      throw new Error(`Draw order: units place ${formatCountOf(running, "point")} in LOD band ${band}, not ${bandEnds[band]}.`);
    }
  }
  const indices = hierarchy ?? new Uint32Array(n);
  const cursors = leafOffsets.slice();
  for (let id = 0; id < n; id++) {
    const band = bandOf === null ? 0 : bandOf[id];
    indices[cursors[band * stride + unitOf[id]]++] = id;
  }
  return { indices, bandCount, bandEnds, leafCount, leafOffsets, pointCount: n };
}
var LOD_REDUCTION_FACTORS = Object.freeze([
  44,
  35,
  28,
  23,
  18,
  14.5,
  11.5,
  9.3,
  7.5,
  6,
  4.8,
  3.8,
  3,
  2.4,
  1.95,
  1.55,
  1.25,
  1
]);
function lodPrefixCounts(pointCount) {
  return LOD_REDUCTION_FACTORS.map((factor) => factor === 1 ? pointCount : Math.min(Math.max(1e3, Math.ceil(pointCount / factor)), pointCount));
}
function computeTreeDrawOrder(positions, tree, dimensionLevel, buildLOD) {
  const pointCount = positions.length / dimensionLevel;
  if (!buildLOD) return buildDrawOrder(tree.root, dimensionLevel, pointCount, null, null);
  const hierarchy = buildHierarchicalOrder(positions, tree.bounds, dimensionLevel);
  return buildDrawOrder(tree.root, dimensionLevel, pointCount, hierarchy, lodPrefixCounts(pointCount));
}
function drawOrderTransferList(order) {
  return [order.indices.buffer, order.bandEnds.buffer, order.leafOffsets.buffer];
}

// assets/js/rendering/high-perf/spatial-tree-job.js
function buildSpatialTreeJob({ positions, dimensionLevel, maxPointsPerNode, maxDepth, buildLOD }) {
  const tree = buildSpatialTree(positions, dimensionLevel, maxPointsPerNode, maxDepth);
  packLeafIndices(tree, positions.length / dimensionLevel);
  const order = computeTreeDrawOrder(positions, tree, dimensionLevel, buildLOD === true);
  return { tree, order };
}
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
function encodeSpatialTreeJobResult(result, dimensionLevel) {
  const { encoded, transfer } = encodeSpatialTree(result.tree, dimensionLevel);
  return {
    reply: { tree: encoded, order: result.order },
    transfer: [...transfer, ...drawOrderTransferList(result.order)]
  };
}

// assets/js/rendering/high-perf/spatial-tree-worker.js
var pendingPositions = /* @__PURE__ */ new Map();
self.onmessage = ({ data }) => {
  const { id } = data;
  try {
    if (data.kind === "positions") {
      let positions2 = pendingPositions.get(id);
      if (positions2 === void 0) {
        positions2 = new Float32Array(data.total);
        pendingPositions.set(id, positions2);
      }
      positions2.set(data.slice, data.offset);
      return;
    }
    const positions = pendingPositions.get(id);
    pendingPositions.delete(id);
    if (positions === void 0) throw new Error("build request arrived without its positions");
    const request = { ...data, positions };
    delete request.kind;
    const { reply, transfer } = encodeSpatialTreeJobResult(buildSpatialTreeJob(request), request.dimensionLevel);
    self.postMessage({ id, ...reply }, transfer);
  } catch (error) {
    pendingPositions.delete(id);
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
//# sourceMappingURL=spatial-tree-worker.a069475d2afc.js.map
