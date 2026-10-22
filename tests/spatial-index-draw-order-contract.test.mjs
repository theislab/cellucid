/**
 * The draw order a tree publishes (`SpatialIndex#drawOrder`): the order its
 * points are stored in on the GPU. Points are grouped by LOD band, then by
 * tree leaf, then by ascending source index, so that every reduced level is
 * one prefix and every run of leaves is one contiguous range per band.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { SpatialIndex } from '../assets/js/rendering/high-perf/spatial-index.js';
import { buildDrawOrder, buildHierarchicalOrder } from '../assets/js/rendering/high-perf/draw-order.js';

function silenceCalculationNotifications(t) {
  const notifications = getNotificationCenter();
  const previous = {
    completeCalculation: notifications.completeCalculation,
    failCalculation: notifications.failCalculation,
    hasNotification: notifications.hasNotification,
    startCalculation: notifications.startCalculation,
  };
  Object.assign(notifications, {
    completeCalculation() {},
    failCalculation() {},
    hasNotification: () => true,
    startCalculation: () => 'draw-order-test',
  });
  t.after(() => Object.assign(notifications, previous));
}

function makePositions(pointCount, dimension, seed = 7) {
  let state = seed;
  const random = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 2 ** 32;
  };
  const positions = new Float32Array(pointCount * dimension);
  for (let index = 0; index < positions.length; index++) {
    positions[index] = random() * 10 - 5;
  }
  return positions;
}

function leavesOf(index) {
  const leaves = [];
  const visit = node => {
    if (node.indices !== null) {
      leaves.push(node);
      return;
    }
    for (const child of node.children) if (child) visit(child);
  };
  visit(index.root);
  return leaves;
}

/**
 * The draw units of a tree in order (`drawUnit` nodes: leaves in 3D, nodes at
 * a coarse depth in 1D and 2D), each with its source ids ascending.
 */
function unitsOf(index) {
  const units = [];
  const idsUnder = node => (node.indices !== null
    ? Array.from(node.indices)
    : node.children.filter(Boolean).flatMap(idsUnder));
  const visit = (node, depth) => {
    if (node.drawUnit === true) {
      units.push({ node, depth, ids: idsUnder(node).sort((a, b) => a - b) });
      return;
    }
    for (const child of node.children) if (child) visit(child, depth + 1);
  };
  visit(index.root, 0);
  return units;
}

const sorted = values => Array.from(values).sort((a, b) => a - b);

for (const dimension of [1, 2, 3]) {
  test(`${dimension}D: the draw order is a permutation and every level is the hierarchical order's set`, () => {
    const pointCount = 6_000;
    const positions = makePositions(pointCount, dimension);
    const index = new SpatialIndex(positions, null, dimension, 64, 8, { buildLOD: true });
    const order = index.drawOrder;
    const hierarchy = buildHierarchicalOrder(index.positions, index.bounds, index.dimensionLevel);

    assert.ok(Object.isFrozen(order));
    assert.equal(order.pointCount, pointCount);
    assert.equal(order.indices.length, pointCount);
    assert.deepEqual(sorted(order.indices), Array.from({ length: pointCount }, (_, id) => id));
    assert.equal(order.bandCount, index.lodLevels.length);

    let previous = 0;
    for (let level = 0; level < index.lodLevels.length - 1; level++) {
      const { indices, pointCount: count } = index.lodLevels[level];
      // A level is a view of the draw order's prefix ...
      assert.equal(indices.buffer, order.indices.buffer);
      assert.equal(indices.byteOffset, order.indices.byteOffset);
      assert.equal(indices.length, count);
      // ... holding exactly the points the hierarchical order admits.
      assert.deepEqual(sorted(indices), sorted(hierarchy.subarray(0, count)));
      // Band b ends where level b's prefix ends.
      assert.equal(order.bandEnds[level], count);
      assert.ok(count >= previous);
      previous = count;
    }
    assert.equal(order.bandEnds[order.bandCount - 1], pointCount);
  });
}

for (const dimension of [2, 3]) test(`${dimension}D: within a band units are contiguous and ascending, and within a unit source ids ascend`, () => {
  const pointCount = 5_000;
  const positions = makePositions(pointCount, dimension, 11);
  const index = new SpatialIndex(positions, null, dimension, 20, 8, { buildLOD: true });
  const order = index.drawOrder;
  const leaves = unitsOf(index);
  const stride = order.leafCount + 1;
  assert.equal(order.leafCount, leaves.length);
  assert.equal(order.leafOffsets.length, order.bandCount * stride);
  if (dimension === 3) {
    // 3D groups by the tree's leaves.
    assert.deepEqual(leaves.map(unit => unit.node), leavesOf(index));
  } else {
    // 2D draws without depth: points are grouped only into coarse units
    // (a quadtree at depth 3), never by leaf.
    assert.ok(leaves.length <= 64, `${leaves.length} units`);
    assert.ok(leaves.every(unit => unit.depth <= 3));
    assert.ok(leaves.length < leavesOf(index).length);
  }

  const leafOf = new Uint32Array(pointCount);
  leaves.forEach((unit, ordinal) => {
    // Every node down to the units knows the unit ordinals under it.
    assert.equal(unit.node.leafStart, ordinal);
    assert.equal(unit.node.leafEnd, ordinal + 1);
    for (const id of unit.ids) leafOf[id] = ordinal;
  });
  assert.equal(index.root.leafStart, 0);
  assert.equal(index.root.leafEnd, leaves.length);

  for (let band = 0; band < order.bandCount; band++) {
    const base = band * stride;
    const bandStart = band === 0 ? 0 : order.bandEnds[band - 1];
    assert.equal(order.leafOffsets[base], bandStart, `band ${band} starts where the previous level ends`);
    assert.equal(order.leafOffsets[base + order.leafCount], order.bandEnds[band]);
    for (let leaf = 0; leaf < order.leafCount; leaf++) {
      const start = order.leafOffsets[base + leaf];
      const end = order.leafOffsets[base + leaf + 1];
      assert.ok(end >= start, 'leaf ranges ascend');
      for (let slot = start; slot < end; slot++) {
        assert.equal(leafOf[order.indices[slot]], leaf, `slot ${slot} belongs to unit ${leaf}`);
        if (slot > start) {
          assert.ok(order.indices[slot] > order.indices[slot - 1], 'source ids ascend within a unit');
        }
      }
    }
  }
});

test('writeDrawRanges covers exactly the points of the given leaves in every band up to the limit', () => {
  const pointCount = 4_000;
  const positions = makePositions(pointCount, 3, 23);
  const index = new SpatialIndex(positions, null, 3, 40, 8, { buildLOD: true });
  const order = index.drawOrder;
  const leaves = unitsOf(index);
  const admitted = level => new Set(
    level === order.bandCount - 1
      ? order.indices
      : index.lodLevels[level].indices,
  );
  const starts = new Int32Array(4096);
  const counts = new Int32Array(4096);

  for (const runs of [
    [0, order.leafCount],
    [0, 1],
    [2, 5, 9, 10],
    [1, Math.floor(order.leafCount / 2), Math.floor(order.leafCount / 2) + 1, order.leafCount],
  ]) {
    for (const lastBand of [0, Math.floor(order.bandCount / 2), order.bandCount - 1]) {
      const { rangeCount, elementCount } = index.writeDrawRanges(
        Uint32Array.from(runs), runs.length / 2, lastBand, starts, counts,
      );
      const drawn = [];
      for (let range = 0; range < rangeCount; range++) {
        assert.ok(counts[range] > 0, 'no empty range');
        if (range > 0) {
          assert.notEqual(starts[range], starts[range - 1] + counts[range - 1], 'touching ranges merge');
        }
        drawn.push(...order.indices.subarray(starts[range], starts[range] + counts[range]));
      }
      assert.equal(elementCount, drawn.length);
      const level = admitted(lastBand);
      const expected = [];
      for (let run = 0; run < runs.length; run += 2) {
        for (let leaf = runs[run]; leaf < runs[run + 1]; leaf++) {
          for (const id of leaves[leaf].ids) if (level.has(id)) expected.push(id);
        }
      }
      assert.deepEqual(sorted(drawn), sorted(expected), `runs ${runs} band ${lastBand}`);
    }
  }

  // Every leaf at the last band is the whole cloud, one range.
  const all = index.writeDrawRanges(Uint32Array.of(0, order.leafCount), 1, order.bandCount - 1, starts, counts);
  assert.deepEqual([all.rangeCount, all.elementCount, starts[0], counts[0]], [1, pointCount, 0, pointCount]);
  // A band limit outside the order is refused.
  assert.throws(
    () => index.writeDrawRanges(Uint32Array.of(0, 1), 1, order.bandCount, starts, counts),
    /outside/,
  );
  assert.throws(
    () => index.writeDrawRanges(Uint32Array.of(0, order.leafCount), 1, order.bandCount - 1, new Int32Array(0), new Int32Array(0)),
    /capacity/,
  );
});

test('without LOD the draw order is one band in unit order; a tree built with LOD has a banded one', t => {
  silenceCalculationNotifications(t);
  const pointCount = 3_000;
  const positions = makePositions(pointCount, 2, 31);
  const index = new SpatialIndex(positions, null, 2, 64, 8, { buildLOD: false });
  assert.equal(index.drawOrder, null, 'built only on first use');

  const flat = index.ensureDrawOrder();
  assert.strictEqual(index.ensureDrawOrder(), flat, 'built once');
  assert.equal(flat.bandCount, 1);
  assert.deepEqual(Array.from(flat.bandEnds), [pointCount]);
  const unitOrder = unitsOf(index).flatMap(unit => unit.ids);
  assert.deepEqual(Array.from(flat.indices), unitOrder);

  // Levels come from a new tree built with them (the renderer replaces the
  // plain one), whose order is banded.
  const withLevels = new SpatialIndex(positions, null, 2, 64, 8, { buildLOD: true });
  const banded = withLevels.drawOrder;
  assert.notStrictEqual(banded, flat);
  assert.notStrictEqual(banded.token, flat.token);
  assert.equal(banded.bandCount, withLevels.lodLevels.length);
  assert.equal(withLevels.lodLevels[0].indices.buffer, banded.indices.buffer);
});

test('a refused band count or a leaf outside the cloud never publishes a draw order', () => {
  const positions = makePositions(100, 2, 41);
  const index = new SpatialIndex(positions, null, 2, 8, 8, { buildLOD: false });
  assert.throws(
    () => buildDrawOrder(index.root, index.dimensionLevel, index.pointCount, null, Array.from({ length: 256 }, () => 100)),
    /at most 255/,
  );
  assert.equal(index.drawOrder, null);
  const leaf = leavesOf(index)[0];
  const saved = leaf.indices[0];
  leaf.indices[0] = 100;
  assert.throws(
    () => buildDrawOrder(index.root, index.dimensionLevel, index.pointCount, buildHierarchicalOrder(index.positions, index.bounds, index.dimensionLevel), [100]),
    /outside 100 points/,
  );
  leaf.indices[0] = saved;
  assert.equal(index.drawOrder, null);
});

test('a range budget is met by bridging the gaps that hide the fewest points', () => {
  const pointCount = 200_000;
  const positions = makePositions(pointCount, 3, 97);
  const index = new SpatialIndex(positions, null, 3, 16, 10, { buildLOD: true });
  const order = index.drawOrder;
  const lastBand = order.bandCount - 1;
  // The units a zoomed frustum keeps: those whose first point is in a box.
  const units = [];
  const visit = node => {
    if (node.drawUnit) {
      units.push(node);
      return;
    }
    for (const child of node.children ?? []) if (child) visit(child);
  };
  visit(index.root);
  const firstId = node => {
    let current = node;
    while (current.indices === null) current = current.children.find(child => child);
    return current.indices[0];
  };
  const inBox = id => Math.abs(positions[id * 3] - 0.3) < 0.9
    && Math.abs(positions[id * 3 + 1] + 0.2) < 0.9;
  const runs = [];
  let open = -1;
  units.forEach((unit, ordinal) => {
    const inside = inBox(firstId(unit));
    if (inside && open < 0) open = ordinal;
    if (!inside && open >= 0) {
      runs.push(open, ordinal);
      open = -1;
    }
  });
  if (open >= 0) runs.push(open, units.length);
  const runArray = Uint32Array.from(runs);
  const runCount = runs.length / 2;
  const scratch = n => [new Int32Array(n), new Int32Array(n)];
  const exact = index.writeDrawRanges(runArray, runCount, lastBand, ...scratch(runCount * order.bandCount));

  // The gaps between runs inside each band, and the bands that hold points.
  const stride = order.leafCount + 1;
  const gaps = [];
  let bandsWithPoints = 0;
  for (let band = 0; band <= lastBand; band++) {
    let previousEnd = -1;
    for (let run = 0; run < runCount; run++) {
      const start = order.leafOffsets[band * stride + runArray[run * 2]];
      const end = order.leafOffsets[band * stride + runArray[run * 2 + 1]];
      if (end <= start) continue;
      if (previousEnd < 0) bandsWithPoints++;
      else if (start > previousEnd) gaps.push(start - previousEnd);
      previousEnd = end;
    }
  }
  gaps.sort((left, right) => left - right);

  for (const cap of [256, 1024]) {
    assert.ok(exact.rangeCount > cap, `the exact cut needs ${exact.rangeCount} ranges, over ${cap}`);
    const [starts, counts] = scratch(cap);
    const coarse = index.writeDrawRanges(runArray, runCount, lastBand, starts, counts, cap, {});
    assert.ok(coarse.rangeCount <= cap, `${coarse.rangeCount} ranges within ${cap}`);
    // Optimal for the budget: exactly the smallest gaps are bridged, so the
    // points added are the sum of the cheapest gaps the budget forces.
    const bridged = gaps.length - (cap - bandsWithPoints);
    const added = gaps.slice(0, bridged).reduce((sum, gap) => sum + gap, 0);
    assert.equal(coarse.elementCount, exact.elementCount + added);
    // Every exact range is inside a coarse one.
    const [exactStarts, exactCounts] = scratch(runCount * order.bandCount);
    index.writeDrawRanges(runArray, runCount, lastBand, exactStarts, exactCounts);
    for (let r = 0; r < exact.rangeCount; r += 37) {
      const start = exactStarts[r];
      const end = start + exactCounts[r];
      let inside = false;
      for (let c = 0; c < coarse.rangeCount && !inside; c++) {
        inside = starts[c] <= start && end <= starts[c] + counts[c];
      }
      assert.ok(inside, `exact range ${r} is drawn`);
    }
  }
});
