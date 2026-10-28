/**
 * Segmented per-point stores (`assets/js/rendering/high-perf/point-store-segments.js`):
 * a store of any size is consecutive segments of at most `segmentPoints`
 * slots, one buffer each, so no single WebGL buffer limits the cell count.
 * Bytes written and read through segments equal one buffer's; a slot range
 * split at segment boundaries visits the same slots in the same order; the
 * vertex arrays bind one segment each; refusals and deletions leave exactly
 * what the owner must still retire.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  POINT_STORE_SEGMENT_POINTS,
  PointStore,
  SegmentedVertexArray,
  forEachSegmentRange,
  planStoreSegments,
  requireStoreSegments,
  splitRangesBySegment,
  unchangedSegments,
} from '../assets/js/rendering/high-perf/point-store-segments.js';
import { MAX_VERTICES_PER_DRAW, deleteGlObject, isGlObjectAlive } from '../assets/js/rendering/gl-utils.js';

/** A WebGL stand-in that keeps every buffer's bytes and every VAO's attributes. */
function createGl({ refuseAllocationAt = -1, failDeleteBuffer = false } = {}) {
  let nextId = 1;
  let bound = null;
  let boundVao = null;
  let allocations = 0;
  const stores = new Map();
  const attributes = new Map();
  const deleted = [];
  const gl = {
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    failDeleteBuffer,
    createBuffer: () => ({ id: nextId++, kind: 'buffer' }),
    createVertexArray: () => {
      const vao = { id: nextId++, kind: 'vao' };
      attributes.set(vao, new Map());
      return vao;
    },
    bindBuffer(_target, buffer) { bound = buffer; },
    bindVertexArray(vao) { boundVao = vao; },
    bufferData(_target, dataOrSize, _usage, srcOffset = 0, length) {
      allocations += 1;
      if (allocations === refuseAllocationAt) throw new Error('refused');
      if (typeof dataOrSize === 'number') {
        stores.set(bound, new Uint8Array(dataOrSize));
        return;
      }
      const width = dataOrSize.BYTES_PER_ELEMENT;
      const count = length ?? dataOrSize.length - srcOffset;
      stores.set(bound, new Uint8Array(dataOrSize.buffer, dataOrSize.byteOffset + srcOffset * width, count * width).slice());
    },
    bufferSubData(_target, offset, data, srcOffset = 0, length) {
      const width = data.BYTES_PER_ELEMENT;
      const count = length ?? data.length - srcOffset;
      stores.get(bound).set(new Uint8Array(data.buffer, data.byteOffset + srcOffset * width, count * width), offset);
    },
    getBufferSubData(_target, offset, out, dstOffset = 0, length) {
      const width = out.BYTES_PER_ELEMENT;
      const count = length ?? out.length - dstOffset;
      new Uint8Array(out.buffer, out.byteOffset + dstOffset * width, count * width)
        .set(stores.get(bound).subarray(offset, offset + count * width));
    },
    enableVertexAttribArray(index) { attributes.get(boundVao).set(index, { ...attributes.get(boundVao).get(index), enabled: true }); },
    disableVertexAttribArray(index) { attributes.get(boundVao).set(index, { ...attributes.get(boundVao).get(index), enabled: false }); },
    // What the GPU process holds: Chromium's command-buffer client never
    // sends a pointer made with no ARRAY_BUFFER bound, so the vertex array
    // keeps the buffer it read (`releaseVertexAttribute`).
    vertexAttribPointer(index, size, type, normalized, stride, offset) {
      if (bound === null) return;
      attributes.get(boundVao).set(index, { ...attributes.get(boundVao).get(index), buffer: bound, size, type, normalized, stride, offset });
    },
    deleteBuffer(buffer) {
      if (gl.failDeleteBuffer) throw new Error('synthetic delete failure');
      deleted.push(buffer);
      stores.delete(buffer);
    },
    deleteVertexArray(vao) { deleted.push(vao); attributes.delete(vao); },
    _state: { stores, attributes, deleted, get bound() { return bound; }, get boundVao() { return boundVao; } },
  };
  return gl;
}

const run = (_refusal, allocate) => allocate();

test('the default segment is the point draw split, and a store of up to one segment is one buffer', () => {
  assert.equal(POINT_STORE_SEGMENT_POINTS, MAX_VERTICES_PER_DRAW);
  assert.deepEqual(planStoreSegments(0), []);
  assert.deepEqual(planStoreSegments(POINT_STORE_SEGMENT_POINTS), [{ first: 0, count: POINT_STORE_SEGMENT_POINTS }]);
  // 200M cells: 12 segments, the last partial; 192 MiB of 3-D positions a segment.
  const plan = planStoreSegments(200_000_000);
  assert.equal(plan.length, 12);
  assert.equal(plan.at(-1).first + plan.at(-1).count, 200_000_000);
  assert.ok(plan.every(segment => segment.count * 12 <= 192 * 1024 * 1024));
  assert.deepEqual(planStoreSegments(10, 4), [{ first: 0, count: 4 }, { first: 4, count: 4 }, { first: 8, count: 2 }]);
  assert.throws(() => planStoreSegments(-1, 4), RangeError);
  assert.throws(() => planStoreSegments(3, 0), RangeError);
});

test('growing a store keeps every full segment (append)', () => {
  assert.equal(unchangedSegments(10, 25, 4), 2);
  assert.equal(unchangedSegments(8, 25, 4), 2);
  assert.equal(unchangedSegments(0, 5, 4), 0);
  const before = planStoreSegments(10, 4);
  const after = planStoreSegments(25, 4);
  for (let index = 0; index < unchangedSegments(10, 25, 4); index++) assert.deepEqual(after[index], before[index]);
  assert.throws(() => unchangedSegments(5, 4, 4), RangeError);
});

test('a slot range split at segment boundaries visits the same slots in order', () => {
  const segments = planStoreSegments(103, 10);
  let state = 7;
  const random = limit => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state % limit;
  };
  for (let trial = 0; trial < 500; trial++) {
    const first = random(103);
    const count = random(104 - first);
    const slots = [];
    forEachSegmentRange(segments, first, count, (index, localFirst, localCount) => {
      assert.ok(localCount > 0 && localFirst + localCount <= segments[index].count);
      for (let local = localFirst; local < localFirst + localCount; local++) slots.push(segments[index].first + local);
    });
    assert.deepEqual(slots, Array.from({ length: count }, (_, offset) => first + offset));
  }
  assert.equal(forEachSegmentRange(segments, 5, 0, () => assert.fail('nothing to visit')), 0);
});

test('culled ranges split by segment are the same slots, grouped by segment in slot order', () => {
  const segments = planStoreSegments(1_000, 64);
  let state = 11;
  const random = limit => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state % limit;
  };
  const out = {};
  for (let trial = 0; trial < 200; trial++) {
    const starts = [];
    const counts = [];
    let at = random(20);
    while (at < 1_000) {
      const count = Math.min(1 + random(150), 1_000 - at);
      starts.push(at);
      counts.push(count);
      at += count + random(40);
    }
    const expected = [];
    starts.forEach((start, range) => { for (let slot = start; slot < start + counts[range]; slot++) expected.push(slot); });
    const got = [];
    const visited = [];
    splitRangesBySegment(segments, Int32Array.from(starts), Int32Array.from(counts), starts.length, out, (segment, localStarts, localCounts, rangeCount) => {
      visited.push(segment);
      for (let range = 0; range < rangeCount; range++) {
        assert.ok(localStarts[range] + localCounts[range] <= segments[segment].count);
        for (let local = localStarts[range]; local < localStarts[range] + localCounts[range]; local++) {
          got.push(segments[segment].first + local);
        }
      }
    });
    assert.deepEqual(got, expected);
    assert.deepEqual(visited, [...visited].sort((a, b) => a - b), 'each segment once, in order');
    assert.equal(new Set(visited).size, visited.length);
  }
});

test('bytes written through segments are the bytes of one buffer, read back exactly', () => {
  for (const segmentPoints of [1, 3, 7, 64, POINT_STORE_SEGMENT_POINTS]) {
    const gl = createGl();
    const data = Float32Array.from({ length: 50 * 3 }, (_, index) => index * 0.37 - 11);
    const store = new PointStore(gl, segmentPoints);
    assert.equal(store.allocate(50, 12, gl.STATIC_DRAW, run, 'positions', data), 600);
    assert.equal(store.segments.length, Math.ceil(50 / segmentPoints));
    assert.deepEqual(store.read(new Float32Array(150)), data);
    // Written at an offset, across segment boundaries.
    const patch = Float32Array.from({ length: 9 * 3 }, (_, index) => -index);
    store.write(patch, 20);
    const expected = data.slice();
    expected.set(patch, 60);
    assert.deepEqual(store.read(new Float32Array(150)), expected);
    assert.equal(gl._state.bound, null, 'no ARRAY_BUFFER is left bound');
    assert.throws(() => store.write(patch, 45), RangeError);
    // Re-allocated smaller: segments past the new layout are deleted.
    const buffers = store.segments.map(segment => segment.buffer);
    store.allocate(10, 4, gl.STATIC_DRAW, run, 'colours');
    const kept = store.segments.map(segment => segment.buffer);
    assert.deepEqual(kept, buffers.slice(0, kept.length));
    for (const buffer of buffers.slice(kept.length)) assert.ok(gl._state.deleted.includes(buffer));
  }
});

test('a refused segment leaves the buffers made so far in the store for its owner to retire', () => {
  const gl = createGl({ refuseAllocationAt: 3 });
  const store = new PointStore(gl, 4);
  assert.throws(() => store.allocate(20, 4, gl.STATIC_DRAW, run, 'colours'), /refused/);
  assert.equal(store.pointCount, 0);
  assert.equal(store.segments.length, 3);
  assert.equal(isGlObjectAlive(gl, 'isBuffer', store), true);
  deleteGlObject(gl, 'deleteBuffer', store);
  assert.equal(store.segments.length, 0);
  assert.equal(isGlObjectAlive(gl, 'isBuffer', store), false);
});

test('a deletion that throws leaves the segments not yet deleted, and a retry deletes exactly those', () => {
  const gl = createGl();
  const store = new PointStore(gl, 4);
  store.allocate(12, 4, gl.STATIC_DRAW, run, 'colours');
  const buffers = store.segments.map(segment => segment.buffer);
  gl.failDeleteBuffer = true;
  assert.throws(() => deleteGlObject(gl, 'deleteBuffer', store), /synthetic/);
  assert.equal(isGlObjectAlive(gl, 'isBuffer', store), true);
  assert.equal(store.segments.length, 3);
  gl.failDeleteBuffer = false;
  deleteGlObject(gl, 'deleteBuffer', store);
  assert.deepEqual([...gl._state.deleted].sort((a, b) => a.id - b.id), buffers);
});

test('the vertex arrays bind each segment\'s positions and colours, and draw a range one segment at a time', () => {
  const gl = createGl();
  const positions = new PointStore(gl, 4);
  positions.allocate(10, 8, gl.STATIC_DRAW, run, 'positions');
  const colors = new PointStore(gl, 4);
  colors.allocate(10, 4, gl.STATIC_DRAW, run, 'colours');
  const arrays = new SegmentedVertexArray(gl);
  arrays.setStores(positions, colors, 2);
  assert.equal(arrays.vaos.length, 3);
  arrays.vaos.forEach((vao, index) => {
    const bound = gl._state.attributes.get(vao);
    assert.deepEqual(bound.get(0), { enabled: true, buffer: positions.segments[index].buffer, size: 2, type: gl.FLOAT, normalized: false, stride: 8, offset: 0 });
    assert.deepEqual(bound.get(1), { enabled: true, buffer: colors.segments[index].buffer, size: 4, type: gl.UNSIGNED_BYTE, normalized: true, stride: 4, offset: 0 });
  });
  assert.equal(gl._state.boundVao, null);
  const draws = [];
  const bases = [];
  const calls = arrays.drawRange(3, 6, base => bases.push(base), (_gl, first, count) => {
    draws.push([gl._state.boundVao, first, count]);
    return 1;
  });
  // Slots 3..8 span segments 0 (slot 3), 1 (slots 4-7) and 2 (slot 8).
  assert.equal(calls, 3);
  assert.deepEqual(draws, [[arrays.vaos[0], 3, 1], [arrays.vaos[1], 0, 4], [arrays.vaos[2], 0, 1]]);
  assert.deepEqual(bases, [0, 4, 8]);
  // Colours detached: the VAO keeps no reference to a store being deleted.
  // The attribute reads the VAO's own position buffer, disabled: pointed at
  // no buffer, Chromium would leave it holding the colour store.
  arrays.setColors(null);
  arrays.vaos.forEach((vao, index) => {
    const colour = gl._state.attributes.get(vao).get(1);
    assert.equal(colour.buffer, positions.segments[index].buffer);
    assert.equal(colour.enabled, false);
  });
  assert.equal(gl._state.bound, null, 'no ARRAY_BUFFER is left bound');
  for (const segment of colors.segments) {
    assert.ok(arrays.vaos.every(vao => gl._state.attributes.get(vao).get(1).buffer !== segment.buffer));
  }
  const mismatched = new PointStore(gl, 5);
  mismatched.allocate(10, 4, gl.STATIC_DRAW, run, 'colours');
  assert.throws(() => arrays.setStores(positions, mismatched, 2), RangeError);
  const vaos = [...arrays.vaos];
  deleteGlObject(gl, 'deleteVertexArray', arrays);
  for (const vao of vaos) assert.ok(gl._state.deleted.includes(vao));
  assert.equal(isGlObjectAlive(gl, 'isVertexArray', arrays), false);
});

test('a gather target is a store, its segments, or one buffer', () => {
  const gl = createGl();
  const store = new PointStore(gl, 4);
  store.allocate(9, 4, gl.STATIC_DRAW, run, 'colours');
  assert.equal(requireStoreSegments(store, 9), store.segments);
  const buffer = gl.createBuffer();
  assert.deepEqual(requireStoreSegments(buffer, 9), [{ buffer, first: 0, count: 9 }]);
  assert.throws(() => requireStoreSegments(store, 10), RangeError);
  assert.throws(() => requireStoreSegments([{ buffer, first: 1, count: 3 }], 4), TypeError);
});
