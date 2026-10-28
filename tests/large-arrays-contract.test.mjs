/**
 * Per-cell arrays larger than one ArrayBuffer (`utils/large-arrays.js`).
 *
 * Chromium refuses one ArrayBuffer above 2,145,386,496 bytes, so 3-D
 * positions stop at 178.8M cells there; a WebAssembly memory holds 2^32. An
 * array the engine refuses is made in a memory, and since a memory's buffer
 * can be neither transferred nor cloned piecemeal, it crosses threads in
 * pieces. Here every seam is driven at sizes that fit, with the refusal made
 * by a typed array type that refuses lengths past a small cap (the engine's
 * rule, at a size a test can afford), and with pieces of a few cells:
 *
 * - the allocator falls back to a memory exactly when the engine refuses;
 * - pieces sent by `PieceSender` (the reader, generator and figure-export
 *   seams) assemble into the same array, in a record, at any depth;
 * - embeddings and vector fields are read by row range and made in pieces
 *   (a float64 `obsm`, as a Seurat or float64 AnnData stores it), bit-equal
 *   to one whole read, with defects numbered as a whole read numbers them;
 * - CPU consumers read memory-backed positions as they read any other: the
 *   spatial tree and draw order (tree worker), the cell-order digest
 *   (sessions), the bounds and the in-place resize of layouts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARRAY_PIECE_BYTES,
  ArrayAssembly,
  MEMORY_MAX_BYTES,
  PieceReceiver,
  PieceSender,
  allocateInMemory,
  allocateLargeArray,
  arrayPieces,
  canTransfer,
  copyLargeArray,
  isMemoryBacked,
  pieceElements,
  placeArrays,
} from '../assets/js/utils/large-arrays.js';
import { COORDINATE_PIECE_CELLS, EmbeddingPayloads } from '../assets/js/data/embedding-payload.js';
import { allocateTypedArray } from '../assets/js/data/sparse-column-index.js';
import { buildSpatialTreeJob } from '../assets/js/rendering/high-perf/spatial-tree-job.js';
import { digestCellOrder } from '../assets/js/app/session/session-context.js';
import { readPositionBounds } from '../assets/js/rendering/position-layout.js';

/** A Float32Array type whose engine refuses more than `cap` elements, as Chromium refuses past its ArrayBuffer cap. */
function cappedType(Base, cap) {
  return class Capped extends Base {
    constructor(...args) {
      if (args.length === 1 && typeof args[0] === 'number' && args[0] > cap) {
        throw new RangeError('Array buffer allocation failed');
      }
      super(...args);
    }
  };
}

test('an array the engine refuses is made in a WebAssembly memory, any other in an ArrayBuffer', () => {
  const Capped = cappedType(Float32Array, 1000);
  const small = allocateLargeArray(Capped, 1000);
  assert.equal(isMemoryBacked(small), false);
  assert.equal(canTransfer(small), true);
  const large = allocateLargeArray(Capped, 1001);
  assert.equal(isMemoryBacked(large), true);
  assert.equal(large.length, 1001);
  assert.ok(large instanceof Float32Array);
  assert.ok(large.every(value => value === 0), 'zeroed as an ArrayBuffer is');
  // Never grown, so it stays attached; it cannot move by transfer.
  assert.equal(canTransfer(large), false);
  assert.throws(() => structuredClone(large, { transfer: [large.buffer] }));
  // Past what a memory holds, the engine's refusal stands.
  const Refusing = cappedType(Float64Array, 0);
  assert.throws(() => allocateLargeArray(Refusing, MEMORY_MAX_BYTES / 8 + 1), /Array buffer allocation failed/);
  assert.throws(() => allocateInMemory(Float64Array, MEMORY_MAX_BYTES / 8 + 1), /more than one WebAssembly memory holds/);
});

test('allocateTypedArray takes the memory route and reports only a refusal of both', () => {
  const Capped = cappedType(Float32Array, 10);
  const array = allocateTypedArray(Capped, 64, 'Test positions');
  assert.equal(isMemoryBacked(array), true);
  const Refusing = cappedType(Float32Array, 0);
  assert.throws(
    () => allocateTypedArray(Refusing, MEMORY_MAX_BYTES, 'Test positions'),
    error => error.code === 'TOO_LARGE' && /Test positions needs/.test(error.message)
  );
});

test('a copy of a memory-backed array is a copy at any size', () => {
  const source = allocateInMemory(Float32Array, 9);
  source.set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const copy = copyLargeArray(source);
  assert.notEqual(copy.buffer, source.buffer);
  assert.deepEqual(Array.from(copy), Array.from(source));
});

test('pieces are whole cells under ARRAY_PIECE_BYTES, and assemble in any order', () => {
  assert.equal(ARRAY_PIECE_BYTES, COORDINATE_PIECE_CELLS * 3 * 4, 'a piece is one point-store segment of 3-D positions');
  assert.equal(pieceElements(Float32Array, 3) % 3, 0);
  assert.equal(pieceElements(Float32Array, 2) * 4 <= ARRAY_PIECE_BYTES, true);
  const values = Float32Array.from({ length: 30 }, (_, i) => i * 0.5);
  const assembly = new ArrayAssembly(Float32Array, 30);
  assembly.put(12, values.slice(12, 30));
  assert.throws(() => assembly.result, /assembled from 18/);
  assembly.put(0, values.slice(0, 12));
  assert.deepEqual(Array.from(assembly.result), Array.from(values));
  // One piece that is the whole array is taken as it is.
  const whole = new ArrayAssembly(Float32Array, 30);
  whole.put(0, values);
  assert.equal(whole.result, values);
  assert.throws(() => new ArrayAssembly(Float32Array, 4).put(2, new Float32Array(3)), /outside an array of 4/);
  assert.throws(() => new ArrayAssembly(Float32Array, 4).put(0, new Uint8Array(4)), /is one too/);
  assert.deepEqual([...arrayPieces(values, 3)].map(piece => piece.offset), [0]);
});

test('a record with memory-backed arrays crosses as pieces and placeholders, and comes back equal', () => {
  const positions = allocateInMemory(Float32Array, 12);
  positions.set(Array.from({ length: 12 }, (_, i) => i + 0.25));
  const vectors = allocateInMemory(Float32Array, 6);
  vectors.set([1, 2, 3, 4, 5, 6]);
  const plain = Uint32Array.from([7, 8]);
  const posted = [];
  const sender = new PieceSender((piece, transfer) => {
    assert.equal(transfer.length, 1);
    assert.equal(transfer[0], piece.values.buffer);
    posted.push(structuredClone(piece, { transfer }));
  });
  const record = { positions, nested: { items: [{ vectors }] }, plain, n: 4 };
  const placed = placeArrays(record, view => sender.send(view));
  assert.deepEqual(placed.positions, { arrayPieces: 0 });
  assert.deepEqual(placed.nested.items[0].vectors, { arrayPieces: 1 });
  assert.equal(placed.plain, plain, 'a transferable array is left for the transfer list');
  assert.equal(record.positions, positions, 'the record itself is not changed');
  // Crosses (cloned here as postMessage would), then is assembled.
  const arrived = structuredClone(placed);
  const receiver = new PieceReceiver();
  for (const piece of posted) receiver.receive(piece);
  const resolved = receiver.resolve(arrived);
  assert.deepEqual(Array.from(resolved.positions), Array.from(positions));
  assert.deepEqual(Array.from(resolved.nested.items[0].vectors), Array.from(vectors));
  assert.deepEqual(Array.from(resolved.plain), [7, 8]);
  assert.equal(resolved.n, 4);
  // An array made piece by piece never exists whole on the sending side.
  const streamed = [];
  const stream = new PieceSender(piece => streamed.push(piece)).begin(Float32Array, 5);
  stream.put(0, Float32Array.from([1, 2]));
  stream.put(2, Float32Array.from([3, 4, 5]));
  const again = new PieceReceiver();
  for (const piece of streamed) again.receive(piece);
  assert.deepEqual(Array.from(again.resolve({ v: stream.result }).v), [1, 2, 3, 4, 5]);
  assert.throws(() => new PieceReceiver().resolve({ v: { arrayPieces: 3 } }), /never arrived/);
});

/**
 * An `obsm` reader over float64 values that records every row range it
 * read (as a Seurat reduction or a float64 AnnData `obsm` is read).
 */
function float64Obsm(arrays) {
  const reads = [];
  const read = async (key, columns, { rows = null } = {}) => {
    const { values, width } = arrays[key];
    const n = values.length / width;
    const [start, end] = rows ?? [0, n];
    reads.push({ key, rows: [start, end] });
    const out = new Float64Array((end - start) * columns.length);
    for (let row = start; row < end; row++) {
      columns.forEach((column, i) => { out[(row - start) * columns.length + i] = values[row * width + column]; });
    }
    return out;
  };
  return { read, reads };
}

function sinkRecorder() {
  const puts = [];
  const sinks = (ArrayType, length) => {
    const assembly = new ArrayAssembly(ArrayType, length);
    return {
      put(offset, values) {
        puts.push({ offset, length: values.length });
        assembly.put(offset, values);
      },
      get result() { return assembly.result; },
    };
  };
  return { sinks, puts };
}

test('a float64 obsm is read by row range and made in pieces, bit-equal to one whole read', async () => {
  const n = 11;
  const umap = Float64Array.from({ length: n * 3 }, (_, i) => Math.sin(i * 1.7) * 1e3 + i / 7);
  const velocity = Float64Array.from({ length: n * 3 }, (_, i) => Math.cos(i) / 3);
  const arrays = { X_umap: { values: umap, width: 3 }, velocity: { values: velocity, width: 3 } };
  const whole = float64Obsm(arrays);
  const pieced = float64Obsm(arrays);
  const reference = new EmbeddingPayloads(whole.read, { cellCount: () => n });
  const payloads = new EmbeddingPayloads(pieced.read, { cellCount: () => n, pieceCells: 4 });
  for (const normalize of [true, false]) {
    const expected = await new EmbeddingPayloads(whole.read, { cellCount: () => n }).embedding('X_umap', [0, 1, 2], normalize);
    const recorder = sinkRecorder();
    const got = await new EmbeddingPayloads(pieced.read, { cellCount: () => n, pieceCells: 4 })
      .embedding('X_umap', [0, 1, 2], normalize, { pieces: recorder.sinks });
    assert.deepEqual(new Uint32Array(got.positions.buffer, got.positions.byteOffset, got.positions.length),
      new Uint32Array(expected.positions.buffer, expected.positions.byteOffset, expected.positions.length), `normalize ${normalize}: same bits`);
    assert.deepEqual(got.bounds, expected.bounds);
    assert.deepEqual(got.transform, expected.transform);
    assert.deepEqual(recorder.puts, [{ offset: 0, length: 12 }, { offset: 12, length: 12 }, { offset: 24, length: 9 }], 'pieces of 4 cells, in order');
  }
  assert.ok(pieced.reads.every(read => read.rows[1] - read.rows[0] <= 4), 'no read of more than a piece');

  const expectedVectors = await reference.vectors('velocity', [0, 1, 2], { key: 'X_umap', columns: [0, 1, 2] }, true);
  const gotVectors = await payloads.vectors('velocity', [0, 1, 2], { key: 'X_umap', columns: [0, 1, 2] }, true);
  assert.deepEqual(Array.from(gotVectors.vectors), Array.from(expectedVectors.vectors));
  assert.equal(gotVectors.maxMagnitude, expectedVectors.maxMagnitude);

  // Rows of an opening grown in place: pieces over the range, same frame.
  const rows = await payloads.embedding('X_umap', [0, 1, 2], true, { rows: [2, 11] });
  const all = await reference.embedding('X_umap', [0, 1, 2], true);
  assert.deepEqual(Array.from(rows.positions), Array.from(all.positions.subarray(6)));
});

test('a defect in a later piece is named by its cell in the whole array', async () => {
  const n = 9;
  const values = Float64Array.from({ length: n * 2 }, (_, i) => i);
  values[7 * 2 + 1] = Number.NaN;
  const vectors = Float64Array.from({ length: n * 2 }, (_, i) => i);
  vectors[6 * 2] = Infinity;
  const { read } = float64Obsm({ X_bad: { values, width: 2 }, X_ok: { values: Float64Array.from({ length: n * 2 }, (_, i) => i), width: 2 }, v: { values: vectors, width: 2 } });
  const payloads = new EmbeddingPayloads(read, { cellCount: () => n, pieceCells: 3 });
  await assert.rejects(payloads.embedding('X_bad', [0, 1], true), /NaN at cell 7/);
  await assert.rejects(payloads.embedding('X_bad', [0, 1], true, { rows: [3, 9] }), /NaN at cell 7/);
  await assert.rejects(payloads.vectors('v', [0, 1], { key: 'X_ok', columns: [0, 1] }, true), /Infinity at cell 6/);
});

test('CPU consumers read memory-backed positions as any others', () => {
  const n = 500;
  const plain = Float32Array.from({ length: n * 3 }, (_, i) => Math.sin(i * 0.37) + (i % 3) * 0.1);
  const backed = copyLargeArray(plain);
  const memory = allocateInMemory(Float32Array, plain.length);
  memory.set(plain);
  assert.equal(isMemoryBacked(memory), true);
  assert.equal(digestCellOrder(memory, 3), digestCellOrder(plain, 3), 'session cell-order digest');
  assert.deepEqual(readPositionBounds(memory, 3), readPositionBounds(plain, 3), 'bounds');
  const request = positions => ({ positions, dimensionLevel: 3, maxPointsPerNode: 32, maxDepth: 12, buildLOD: true });
  const fromMemory = buildSpatialTreeJob(request(memory));
  const fromPlain = buildSpatialTreeJob(request(backed));
  assert.deepEqual(Array.from(fromMemory.order.indices), Array.from(fromPlain.order.indices), 'tree draw order');
  // The tree worker assembles the slices it is sent into one array.
  const assembly = new ArrayAssembly(Float32Array, plain.length);
  for (let offset = 0; offset < plain.length; offset += 300) assembly.put(offset, plain.slice(offset, offset + 300));
  assert.deepEqual(Array.from(assembly.result), Array.from(plain));
});

test('the reader worker never copies a memory-backed reply array whole: it crosses in pieces', async () => {
  const { ownedBuffers } = await import('../assets/js/data/anndata-reader-worker.js');
  const positions = allocateInMemory(Float32Array, 7);
  positions.set([1, 2, 3, 4, 5, 6, 7]);
  const plain = Float32Array.from([8, 9]);
  const owned = ownedBuffers({ positions, part: plain.subarray(1) });
  assert.equal(owned.positions, positions, 'not copied (a copy would need one ArrayBuffer of its size)');
  assert.equal(owned.part.length, 1);
  assert.notEqual(owned.part.buffer, plain.buffer, 'a view of part of an ordinary buffer is still copied out');
});
