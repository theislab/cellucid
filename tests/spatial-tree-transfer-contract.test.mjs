/**
 * The worker's tree reply crosses as typed arrays (`encodeSpatialTree`), not
 * as node objects: a structured clone of a 10M-point octree's 38,568 nodes
 * took 35 ms in one main-thread task. The decoded tree must be the built
 * tree, node for node.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSpatialTreeJob,
  decodeSpatialTreeJobResult,
  encodeSpatialTreeJobResult,
} from '../assets/js/rendering/high-perf/spatial-tree-job.js';
import { forEachLeafRun, leafIdsFollowDrawOrder } from '../assets/js/rendering/high-perf/draw-order.js';

function positionsOf(count, dimension, seed, spread) {
  const positions = new Float32Array(count * dimension);
  let state = seed;
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 4294967296;
  for (let index = 0; index < positions.length; index++) positions[index] = Math.floor(next() * spread) / 3;
  return positions;
}

function plain(node) {
  if (node === null) return null;
  return {
    bounds: { ...node.bounds },
    indices: node.indices === null ? null : Array.from(node.indices),
    pointCount: node.pointCount,
    leafStart: node.leafStart,
    leafEnd: node.leafEnd,
    drawUnit: node.drawUnit,
    children: node.children === null ? null : node.children.map(plain),
  };
}

for (const [count, dimension, buildLOD] of [[20_000, 3, true], [12_000, 2, true], [3_000, 1, false], [1, 3, true], [5_000, 3, false]]) {
  test(`a ${dimension}D tree of ${count} points crosses as typed arrays and decodes to the built tree (LOD ${buildLOD})`, () => {
    const positions = positionsOf(count, dimension, count + dimension, 60);
    const request = { positions, dimensionLevel: dimension, maxPointsPerNode: 50, maxDepth: 8, buildLOD };
    const built = buildSpatialTreeJob(request);
    const sent = buildSpatialTreeJob(request);
    const { reply, transfer } = encodeSpatialTreeJobResult(sent, dimension);
    // Nothing but typed arrays and numbers crosses.
    for (const value of Object.values(reply.tree)) {
      assert.ok(typeof value === 'number' || ArrayBuffer.isView(value), 'flat encoding');
    }
    assert.equal(new Set(transfer).size, transfer.length, 'each buffer transferred once');
    const received = structuredClone(reply, { transfer });
    const decoded = decodeSpatialTreeJobResult(received);
    assert.deepEqual(plain(decoded.tree.root), plain(built.tree.root));
    assert.deepEqual(decoded.tree.bounds, built.tree.bounds);
    assert.strictEqual(decoded.tree.bounds, decoded.tree.root.bounds);
    assert.deepEqual(Array.from(decoded.order.indices), Array.from(built.order.indices));
    // Leaves share one buffer of ids, as the built tree's do; in 3D the
    // draw order holds them (its units are the leaves) and none cross.
    const buffers = new Set();
    const seen = new Uint8Array(count);
    const stack = [decoded.tree.root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === null) continue;
      if (node.indices) buffers.add(node.indices.buffer);
      if (node.children) {
        stack.push(...node.children);
        continue;
      }
      let cells = 0;
      forEachLeafRun(node, decoded.order, (ids, start, end) => {
        for (let i = start; i < end; i++) {
          const cell = ids[i];
          seen[cell]++;
          cells++;
          const b = node.bounds;
          const [x, y, z] = [positions[cell * dimension], dimension > 1 ? positions[cell * dimension + 1] : 0, dimension > 2 ? positions[cell * dimension + 2] : 0];
          assert.ok(x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ, `cell ${cell} lies in its leaf`);
        }
      });
      assert.equal(cells, node.pointCount, 'a leaf reads its own cells');
    }
    assert.equal(buffers.size, leafIdsFollowDrawOrder(dimension) ? 0 : 1);
    assert.ok(seen.every(times => times === 1), 'every cell in exactly one leaf');
  });
}
