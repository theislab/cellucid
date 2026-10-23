/**
 * A Zarr store picked as a folder is read as a local disk is: opening a
 * consolidated store reads one file, a read reads each chunk file it needs
 * once and no other, the folder's link is the disk's (never "measured" from
 * per-file reads, whose time is a file's open cost, not the disk's speed),
 * and copying a chunk into a read walks as few axes as the layout allows.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { directoryStore, memoryStore, openZarr } from '../assets/js/formats/zarr/index.js';
import { createLimiter } from '../assets/js/formats/zarr/stores/common.js';
import { copyBox, fillBox, mergeAxes } from '../assets/js/formats/zarr/chunks.js';
import { openAnnDataStore } from '../assets/js/data/anndata/open.js';

import { corpusFolder } from './helpers/zarr-corpus.mjs';

/** A folder whose every file read is recorded (path, start, end). */
function recordedFolder(files) {
  const reads = [];
  const byFile = new Map([...files].map(([key, file]) => [file, key]));
  const readBlob = blob => {
    reads.push(byFile.get(blob) ?? '(part of a file)');
    return blob.arrayBuffer();
  };
  return { reads, readBlob };
}

test('opening a consolidated folder reads its consolidated metadata and nothing else', async () => {
  const files = await corpusFolder('anndata/v2.zarr');
  const { reads, readBlob } = recordedFolder(files);
  const root = await openZarr(directoryStore(files, { readBlob }));
  assert.deepEqual(reads, ['v2.zarr/.zmetadata']);
  assert.ok(root.get('X/data'));
  assert.ok(root.get('obs/cell_type/codes'));
});

test('a folder read reads each chunk file it needs once, together, and no other', async () => {
  const files = await corpusFolder('v2/cases.zarr');
  const { reads, readBlob } = recordedFolder(files);
  const root = await openZarr(directoryStore(files, { readBlob }));
  reads.length = 0;
  const array = root.get('codecs/zstd');
  const all = await array.read();
  const chunkFiles = reads.slice();
  assert.equal(new Set(chunkFiles).size, chunkFiles.length, 'no chunk file is read twice');
  assert.ok(chunkFiles.every(key => key.startsWith('cases.zarr/codecs/zstd/')));
  // Two reads of the same chunks at once share each file read (the first
  // row of a [40, 30] array in [16, 12] chunks: three chunk files).
  reads.length = 0;
  const [a, b] = await Promise.all([array.read([[0, 1]]), array.read([[0, 1]])]);
  assert.deepEqual(a, b);
  assert.deepEqual(a, all.subarray(0, a.length));
  assert.deepEqual(reads, ['0.0', '0.1', '0.2'].map(name => `cases.zarr/codecs/zstd/${name}`));
});

test('a picked folder\'s link is the disk: per-file reads never make it look slow, so it reads ahead', async () => {
  const files = await corpusFolder('anndata/v2.zarr');
  const opened = await openAnnDataStore({ kind: 'zarr', source: { files, rootName: 'v2.zarr' } }, { decodedChunkCacheBytes: 1 << 20 });
  // Every chunk of every array, read file by file.
  const arrays = ['X/data', 'X/indices', 'obs/n_genes', 'obsm/X_umap', 'obsp/connectivities/data'];
  await Promise.all(arrays.map(path => opened.root.get(path).read()));
  const link = opened.link.snapshot();
  assert.equal(link.measured, false);
  assert.equal(link.readsAhead, true);
  opened.root.close();
});

test('mergeAxes drops unit axes and merges axes both sides lay out as one', () => {
  // Whole rows of a row-major [rows, 24] chunk into a [rows, 24] output: one run.
  assert.deepEqual(mergeAxes([[24, 1], [24, 1]], [100, 24]), { strides: [[1], [1]], extents: [2400] });
  // One column of a [rows, 2] chunk: one strided run, not a run per row.
  assert.deepEqual(mergeAxes([[2, 1], [1, 1]], [100, 1]), { strides: [[2], [1]], extents: [100] });
  // Part of the columns: rows stay separate runs.
  assert.deepEqual(mergeAxes([[24, 1], [3, 1]], [100, 3]), { strides: [[24, 1], [3, 1]], extents: [100, 3] });
  // A Fortran-order chunk keeps both axes.
  assert.deepEqual(mergeAxes([[1, 10], [4, 1]], [10, 4]), { strides: [[1, 10], [4, 1]], extents: [10, 4] });
  // One element.
  assert.deepEqual(mergeAxes([[5, 1], [5, 1]], [1, 1]), { strides: [[], []], extents: [] });
});

/** The copy, one element at a time, as the definition of what copyBox does. */
function naiveCopy(src, srcStart, srcStrides, dst, dstStart, dstStrides, extents, width) {
  const index = new Array(extents.length).fill(0);
  const total = extents.reduce((a, b) => a * b, 1);
  for (let n = 0; n < total; n++) {
    let s = srcStart;
    let d = dstStart;
    for (let axis = 0; axis < extents.length; axis++) {
      s += index[axis] * srcStrides[axis];
      d += index[axis] * dstStrides[axis];
    }
    for (let w = 0; w < width; w++) dst[d * width + w] = src[s * width + w];
    for (let axis = extents.length - 1; axis >= 0; axis--) {
      if (++index[axis] < extents[axis]) break;
      index[axis] = 0;
    }
  }
}

test('copyBox and fillBox give the element-by-element answer for every box shape', () => {
  let seed = 7;
  const random = n => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const strides = shape => {
    const out = new Array(shape.length);
    let stride = 1;
    for (let axis = shape.length - 1; axis >= 0; axis--) {
      out[axis] = stride;
      stride *= shape[axis];
    }
    return out;
  };
  for (let trial = 0; trial < 400; trial++) {
    const rank = 1 + random(3);
    const chunk = Array.from({ length: rank }, () => 1 + random(6));
    const fortran = random(2) === 1;
    const chunkStrides = fortran ? strides(chunk.slice().reverse()).reverse() : strides(chunk);
    const box = chunk.map(extent => 1 + random(extent));
    const origin = chunk.map((extent, axis) => random(extent - box[axis] + 1));
    const out = box.map(extent => extent + random(3));
    const outStrides = strides(out);
    const at = out.map((extent, axis) => random(extent - box[axis] + 1));
    const width = 1 + random(2);
    const count = chunk.reduce((a, b) => a * b, 1);
    const src = Uint32Array.from({ length: count * width }, (_, i) => i + 1);
    const srcStart = origin.reduce((sum, value, axis) => sum + value * chunkStrides[axis], 0);
    const dstStart = at.reduce((sum, value, axis) => sum + value * outStrides[axis], 0);
    const outCount = out.reduce((a, b) => a * b, 1) * width;
    const expected = new Uint32Array(outCount);
    const actual = new Uint32Array(outCount);
    naiveCopy(src, srcStart, chunkStrides, expected, dstStart, outStrides, box, width);
    copyBox(src, srcStart, chunkStrides, actual, dstStart, outStrides, box, width);
    assert.deepEqual(actual, expected, `copy of box ${box} at ${at} in ${out} from ${chunk}${fortran ? ' (F)' : ''}`);
    if (width === 1) {
      const filledExpected = new Uint32Array(outCount);
      naiveCopy(new Uint32Array(count).fill(9), 0, chunkStrides, filledExpected, dstStart, outStrides, box, 1);
      const filled = new Uint32Array(outCount);
      fillBox(filled, dstStart, outStrides, box, 9, null);
      assert.deepEqual(filled, filledExpected, `fill of box ${box} at ${at} in ${out}`);
    }
  }
});

test('an embedding chunked by rows is read in whole-chunk block moves', async () => {
  const rows = 1000;
  const columns = 24;
  const chunkRows = 64;
  const values = Float32Array.from({ length: rows * columns }, (_, i) => i);
  const entries = new Map([
    ['.zgroup', new TextEncoder().encode('{"zarr_format":2}')],
    ['e/.zarray', new TextEncoder().encode(JSON.stringify({
      zarr_format: 2, shape: [rows, columns], chunks: [chunkRows, columns], dtype: '<f4',
      compressor: null, fill_value: 0, order: 'C', filters: null,
    }))],
  ]);
  for (let chunk = 0; chunk * chunkRows < rows; chunk++) {
    const block = new Float32Array(chunkRows * columns);
    const part = values.subarray(chunk * chunkRows * columns, Math.min(rows, (chunk + 1) * chunkRows) * columns);
    block.set(part);
    entries.set(`e/${chunk}.0`, new Uint8Array(block.buffer));
  }
  const root = await openZarr(memoryStore(entries));
  // Count block moves on the typed arrays a copy goes through.
  let moves = 0;
  const counted = [Float32Array, Uint32Array];
  for (const Type of counted) {
    const base = Object.getPrototypeOf(Type.prototype).set;
    Type.prototype.set = function (...args) {
      moves++;
      return base.apply(this, args);
    };
  }
  let read;
  try {
    read = await root.get('e').read([[10, 990], [0, columns]]);
  } finally {
    for (const Type of counted) delete Type.prototype.set;
  }
  assert.deepEqual(read, values.subarray(10 * columns, 990 * columns));
  // One block move per chunk the rows touch, not one per row.
  assert.equal(moves, Math.ceil(990 / chunkRows) - Math.floor(10 / chunkRows));
});

/** A Zarr v3 folder with one sharded array: `n` float32 values, `inner` per inner chunk, one shard. */
function shardedFolder(n, inner) {
  const encoder = new TextEncoder();
  const count = n / inner;
  const values = Float32Array.from({ length: n }, (_, i) => i * 0.5);
  const data = new Uint8Array(values.buffer);
  const index = new DataView(new ArrayBuffer(count * 16));
  for (let k = 0; k < count; k++) {
    index.setBigUint64(k * 16, BigInt(k * inner * 4), true);
    index.setBigUint64(k * 16 + 8, BigInt(inner * 4), true);
  }
  const shard = new Uint8Array(data.length + index.byteLength);
  shard.set(data);
  shard.set(new Uint8Array(index.buffer), data.length);
  const files = new Map([
    ['s.zarr/zarr.json', new File([encoder.encode(JSON.stringify({ zarr_format: 3, node_type: 'group', attributes: {} }))], 'zarr.json')],
    ['s.zarr/a/zarr.json', new File([encoder.encode(JSON.stringify({
      zarr_format: 3, node_type: 'array', shape: [n], data_type: 'float32',
      chunk_grid: { name: 'regular', configuration: { chunk_shape: [n] } },
      chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
      fill_value: 0,
      codecs: [{ name: 'sharding_indexed', configuration: {
        chunk_shape: [inner],
        codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
        index_codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
        index_location: 'end',
      } }],
    }))], 'zarr.json')],
    ['s.zarr/a/c/0', new File([shard], '0')],
  ]);
  return { files, values };
}

test('the inner chunks of a shard a read needs are read as one slice per run of neighbours', async () => {
  const { files, values } = shardedFolder(64, 8);
  const sizes = [];
  const root = await openZarr(directoryStore(files, { readBlob: blob => { sizes.push(blob.size); return blob.arrayBuffer(); } }));
  sizes.length = 0;
  assert.deepEqual(await root.get('a').read(), values);
  // The index (8 entries of 16 bytes), then all eight inner chunks in one slice.
  assert.deepEqual(sizes, [128, 64 * 4]);
  // Two runs of neighbours (chunks 0-1 and 6-7) of a fresh store: two slices.
  const again = await openZarr(directoryStore(files, { readBlob: blob => { sizes.push(blob.size); return blob.arrayBuffer(); } }));
  const array = again.get('a');
  sizes.length = 0;
  const [head, tail] = await Promise.all([array.read([[0, 16]]), array.read([[48, 64]])]);
  assert.deepEqual(head, values.subarray(0, 16));
  assert.deepEqual(tail, values.subarray(48, 64));
  assert.deepEqual(sizes.slice(1).sort((a, b) => a - b), [64, 64]);
  assert.equal(sizes[0], 128);
});

test('the limiter serves waiting tasks in order, background work last and never in the last slot, and a flipped activity in its turn', async () => {
  const limit = createLimiter(3);
  const started = [];
  const gates = new Map();
  const task = name => () => new Promise(resolve => {
    started.push(name);
    gates.set(name, resolve);
  });
  const index = { background: true };
  const other = { background: true };
  const done = [];
  const run = (name, activity) => done.push(limit(task(name), null, activity));
  run('b1', index);
  run('b2', index);
  // Two background tasks fill every slot but one; the third waits.
  run('b3', other);
  await Promise.resolve();
  assert.deepEqual(started, ['b1', 'b2']);
  run('f1', null);
  run('b4', index);
  run('f2', null);
  await Promise.resolve();
  // A view's task takes the free slot at once.
  assert.deepEqual(started, ['b1', 'b2', 'f1']);
  // The index stops being background: its waiting task is served in the
  // order it was asked for, before f2, which came later.
  index.background = false;
  gates.get('b1')();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(started, ['b1', 'b2', 'f1', 'b4']);
  gates.get('b2')();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(started, ['b1', 'b2', 'f1', 'b4', 'f2']);
  // Only background work waits now (b3), with two slots free of it.
  for (const name of ['f1', 'b4', 'f2']) gates.get(name)();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(started, ['b1', 'b2', 'f1', 'b4', 'f2', 'b3']);
  gates.get('b3')();
  await Promise.all(done);
});

test('the limiter queues tens of thousands of tasks in linear time', async () => {
  // Choosing the next task looks at each waiting activity, not each task: a
  // pass over every waiting task per start made 25,000 background reads
  // cost 2.4 s of queue work alone, and 100,000 over a minute.
  const limit = createLimiter(64);
  const activity = { background: true };
  let calls = 0;
  const count = 50_000;
  const started = performance.now();
  await Promise.all(Array.from({ length: count }, () => limit(async () => { calls++; }, null, activity)));
  assert.equal(calls, count);
  assert.ok(performance.now() - started < 2000, `${count} tasks took ${Math.round(performance.now() - started)} ms`);
});

test('a merged slice is never longer than the store\'s merged-read size', async () => {
  const { files, values } = shardedFolder(64, 8);
  const sizes = [];
  const root = await openZarr(directoryStore(files, { maxReadBytes: 64, readBlob: blob => { sizes.push(blob.size); return blob.arrayBuffer(); } }));
  sizes.length = 0;
  assert.deepEqual(await root.get('a').read(), values);
  // The index, then eight inner chunks of 32 bytes in slices of two.
  assert.deepEqual(sizes, [128, 64, 64, 64, 64]);
});
