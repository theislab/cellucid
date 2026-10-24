/**
 * The decode pool (assets/js/formats/io/decode-pool.js), run over
 * `node:worker_threads` workers that load the real decode worker module:
 *
 * - every Zarr and HDF5 array of the conformance corpora reads the same,
 *   value for value and error for error, decoded on workers as decoded in
 *   this thread;
 * - small chunks, a missing `Worker` constructor and a worker that fails to
 *   start all decode in this thread;
 * - a damaged chunk fails with the same error class and message either way;
 * - a cancelled decode stops waiting at once (a waiting task is never sent),
 *   and the pool keeps working; idle workers are terminated.
 *
 * And the fast paths the decoders share (the LZ77 match copy, the byte
 * unshuffle, LZ4's eight- and sixteen-byte copies) against plain reference
 * implementations, at every offset, length and alignment that changes which
 * path runs.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { constants, deflateSync, zstdCompressSync } from 'node:zlib';

import {
  configureDecodePool,
  decodeChunkBytes,
  decodePoolStats,
  releaseDecodeContext,
  releaseIdleDecodeWorkers,
  retainDecodeContext,
  runOnDecodeWorker,
  warmDecodePool,
} from '../assets/js/formats/io/decode-pool.js';
import { copyMatch } from '../assets/js/formats/io/lz-match.js';
import { byteUnshuffle, byteUnshuffleInto } from '../assets/js/formats/io/shuffle.js';
import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { openHdf5 } from '../assets/js/formats/hdf5/index.js';
import { FILTER, reviveHdf5Error, unfilter } from '../assets/js/formats/hdf5/filters.js';
import { directoryStore, openZarr } from '../assets/js/formats/zarr/index.js';
import { decodeWithCodecs, reviveZarrError } from '../assets/js/formats/zarr/codecs/pipeline.js';
import { lz4DecodeBlockInto } from '../assets/js/formats/zarr/codecs/lz4.js';
import { zstdDecompress } from '../assets/js/formats/zarr/codecs/zstd.js';
import { createNodeDecodeWorker } from './helpers/node-decode-worker.mjs';
import { settle } from './helpers/virtual-time.mjs';
import { corpusFolder } from './helpers/zarr-corpus.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ZARR_STORES = ['v2/cases.zarr', 'v3/cases.zarr', 'anndata/v2.zarr', 'anndata/v3.zarr', 'anndata/v3-sharded.zarr'];
const HDF5_FILES = [
  ...readdirSync(path.join(HERE, 'fixtures', 'hdf5')).filter(name => name.endsWith('.h5')).map(name => path.join(HERE, 'fixtures', 'hdf5', name)),
  ...readdirSync(path.join(HERE, 'browser', 'fixtures')).filter(name => name.endsWith('.h5ad')).map(name => path.join(HERE, 'browser', 'fixtures', name)),
];

/**
 * A worker factory over worker_threads that counts the workers it made, those
 * alive, and the tasks they were sent. With `holdAnswers`, what the workers
 * post back reaches the pool only once `answers.release()` is called
 * (`answers.held` counts what waits): a test can tell what the pool does
 * before any worker has answered, however fast the worker decodes.
 */
function countingWorkers({ holdAnswers = false, ...options } = {}) {
  const counts = { made: 0, alive: 0, mostAlive: 0, tasks: 0 };
  const waiting = [];
  let holding = holdAnswers;
  const answers = {
    get held() {
      return waiting.length;
    },
    release() {
      holding = false;
      for (const deliver of waiting.splice(0)) deliver();
    },
  };
  const createWorker = () => {
    counts.made++;
    counts.alive++;
    counts.mostAlive = Math.max(counts.mostAlive, counts.alive);
    const worker = createNodeDecodeWorker(options);
    let terminated = false;
    return {
      ...worker,
      addEventListener(type, listener) {
        if (type !== 'message') return worker.addEventListener(type, listener);
        return worker.addEventListener(type, event => {
          if (holding) waiting.push(() => listener(event));
          else listener(event);
        });
      },
      postMessage(message, transfer) {
        counts.tasks++;
        worker.postMessage(message, transfer);
      },
      terminate() {
        if (!terminated) counts.alive--;
        terminated = true;
        worker.terminate();
      },
    };
  };
  return { counts, createWorker, answers };
}

/** Decode in this thread only (the state Node starts in: no global Worker). */
function inThreadOnly() {
  configureDecodePool({ createWorker: null });
}

after(() => configureDecodePool());

/** A deterministic pseudo-random generator (mulberry32). */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Whole corpora, on workers and in this thread.

async function openZarrFolder(store) {
  return openZarr(directoryStore(await corpusFolder(store)));
}

async function openHdf5File(file) {
  return openHdf5(createByteReader(bytesByteSource(new Uint8Array(readFileSync(file)), { name: path.basename(file) })));
}

/** Every array of a store read whole: its values, or its error's class and message. */
async function readEverything(root) {
  const results = new Map();
  // Groups by identity (an HDF5 object's address): hard links that lead back
  // up a tree are followed once.
  const seen = new Set();
  const visit = async (node, nodePath) => {
    if (node.kind === 'group') {
      const identity = node.info?.address ?? node.path;
      if (seen.has(identity)) return;
      seen.add(identity);
      for (const key of node.keys()) {
        let child;
        try {
          child = node.get(key);
        } catch (error) {
          // A link this reader does not follow (an external link).
          results.set(`${nodePath}/${key}`, { error: error.name, message: error.message, feature: error.feature });
          continue;
        }
        if (child !== null) await visit(child, `${nodePath}/${key}`);
      }
      return;
    }
    try {
      results.set(nodePath, await node.read());
    } catch (error) {
      results.set(nodePath, { error: error.name, message: error.message, feature: error.feature });
    }
  };
  await visit(root, '');
  return results;
}

test('every Zarr and HDF5 corpus array reads the same decoded on workers as in this thread', async () => {
  const opened = [
    ...ZARR_STORES.map(store => [store, () => openZarrFolder(store)]),
    ...HDF5_FILES.map(file => [path.basename(file), () => openHdf5File(file)]),
  ];
  inThreadOnly();
  const here = new Map();
  for (const [name, open] of opened) {
    const root = await open();
    here.set(name, await readEverything(root));
    root.close();
  }
  const { counts, createWorker } = countingWorkers();
  configureDecodePool({ createWorker, size: 3, minBytes: 0 });
  for (const [name, open] of opened) {
    const root = await open();
    const there = await readEverything(root);
    root.close();
    assert.deepEqual([...there.keys()], [...here.get(name).keys()], `${name}: the same arrays`);
    for (const [nodePath, value] of there) assert.deepEqual(value, here.get(name).get(nodePath), `${name}${nodePath}`);
  }
  assert.ok(counts.tasks > 100, `${counts.tasks} chunks were decoded on workers`);
  assert.ok(counts.mostAlive >= 1 && counts.mostAlive <= 3, `at most ${counts.mostAlive} workers at once`);
  // Closing a store terminated the workers it left with nothing to do.
  assert.equal(decodePoolStats().workers, 0);
  assert.equal(counts.alive, 0);
  configureDecodePool();
});

test('work on decoded values runs on the decode workers: each worker is sent a context once, results come back', async () => {
  // A module that depends on nothing: the sum of its arguments' values, scaled by the context.
  const module = `data:text/javascript,${encodeURIComponent(
    'export function scaledSum({ values }, scale) { let sum = 0; for (const v of values) sum += v; return { sum: new Float64Array([sum * scale]) }; }'
  )}`;
  const sent = [];
  configureDecodePool({
    createWorker: () => {
      const worker = createNodeDecodeWorker();
      const post = worker.postMessage;
      worker.postMessage = (message, transfer) => {
        sent.push(message.context !== undefined && message.id === undefined ? 'context' : message.release !== undefined ? 'release' : message.kind);
        post(message, transfer);
      };
      return worker;
    },
    size: 2,
    minBytes: 0,
  });
  retainDecodeContext('scale', 3);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => {
    const values = new Float64Array([i, 1]);
    return runOnDecodeWorker({
      module, name: 'scaledSum', args: { values }, transfer: [values.buffer], context: 'scale', size: 16,
      inThread: () => ({ sum: new Float64Array([(i + 1) * 3]) }),
    });
  }));
  assert.deepEqual(results.map(result => result.sum[0]), [3, 6, 9, 12, 15, 18]);
  assert.equal(sent.filter(kind => kind === 'run').length, 6, 'every task went to a worker');
  assert.equal(sent.filter(kind => kind === 'context').length, 2, 'the context went to each of the two workers once');
  releaseDecodeContext('scale');
  assert.equal(sent.filter(kind => kind === 'release').length, 2);
  // Too small to be worth a message, or with no worker to take it: done here.
  configureDecodePool({ createWorker: null });
  const here = await runOnDecodeWorker({ module, name: 'scaledSum', args: { values: new Float64Array([1]) }, size: 8, inThread: () => ({ sum: new Float64Array([42]) }) });
  assert.equal(here.sum[0], 42);
  configureDecodePool();
});

// ---------------------------------------------------------------------------
// Where a chunk is decoded.

const ZSTD = [{ id: 'zstd', configuration: {} }];

function zstdTask(input, size, extra = {}) {
  return {
    kind: 'zarr',
    description: { codecs: ZSTD, sizes: [size] },
    input,
    size,
    revive: reviveZarrError,
    inThread: () => decodeWithCodecs(input, ZSTD, [size]),
    ...extra,
  };
}

function floats(count, seed) {
  const next = random(seed);
  return new Uint8Array(new Float32Array(Array.from({ length: count }, () => (next() < 0.7 ? 0 : Math.round(next() * 40)))).buffer);
}

test('a chunk smaller than the threshold is decoded in this thread, a larger one on a worker', async () => {
  const { counts, createWorker } = countingWorkers();
  configureDecodePool({ createWorker, size: 2, minBytes: 4096 });
  const small = floats(512, 1);
  const large = floats(64 * 1024, 2);
  let here = 0;
  const decode = (data, frame) => decodeChunkBytes(zstdTask(frame, data.length, {
    inThread: () => {
      here++;
      return zstdDecompress(frame, data.length);
    },
  }));
  assert.deepEqual(await decode(small, new Uint8Array(zstdCompressSync(small))), small);
  assert.equal(here, 1);
  assert.equal(counts.made, 0, 'no worker is made for a small chunk');
  // The input is a view inside a larger buffer: only its bytes are sent, and
  // the caller's buffer is left whole.
  const frame = new Uint8Array(zstdCompressSync(large));
  const padded = new Uint8Array(frame.length + 64);
  padded.set(frame, 32);
  const view = padded.subarray(32, 32 + frame.length);
  assert.deepEqual(await decode(large, view), large);
  assert.equal(here, 1);
  assert.equal(counts.tasks, 1);
  assert.equal(padded.buffer.byteLength, frame.length + 64, 'the caller\'s buffer is not transferred');
  assert.deepEqual(view, frame);
  configureDecodePool();
});

test('without a Worker constructor, or when a worker cannot start, every chunk is decoded in this thread', async () => {
  const data = floats(32 * 1024, 3);
  const frame = new Uint8Array(zstdCompressSync(data));
  inThreadOnly();
  assert.deepEqual(await decodeChunkBytes(zstdTask(frame, data.length)), data);
  assert.equal(decodePoolStats().inThreadOnly, true);
  assert.equal(decodePoolStats().workers, 0);

  configureDecodePool({ createWorker: () => { throw new Error('nested workers are not available'); }, minBytes: 0 });
  assert.deepEqual(await decodeChunkBytes(zstdTask(frame, data.length)), data);
  assert.equal(decodePoolStats().inThreadOnly, true);

  // A worker whose script fails to load: the chunks it took are decoded here
  // (from the caller's bytes, which were never transferred), and so is every
  // chunk after.
  const { counts, createWorker } = countingWorkers({ failToLoad: true });
  configureDecodePool({ createWorker, size: 2, minBytes: 0 });
  const results = await Promise.all(Array.from({ length: 6 }, () => decodeChunkBytes(zstdTask(frame, data.length))));
  for (const result of results) assert.deepEqual(result, data);
  assert.equal(decodePoolStats().inThreadOnly, true);
  assert.ok(counts.made >= 1);
  assert.deepEqual(await decodeChunkBytes(zstdTask(frame, data.length)), data);
  configureDecodePool();
});

// ---------------------------------------------------------------------------
// Errors.

/** The error of `promise`, as class name, message and feature. */
async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return { constructor: error.constructor.name, name: error.name, message: error.message, feature: error.feature };
  }
  assert.fail('expected a failure');
}

test('a damaged chunk fails with the same error class and message on a worker as in this thread', async () => {
  const data = floats(16 * 1024, 4);
  const frame = new Uint8Array(zstdCompressSync(data));
  const damaged = frame.slice();
  damaged[damaged.length - 3] ^= 0x5a;
  // A Blosc frame that names snappy (codec 2): valid, but not decodable.
  const blosc = new Uint8Array(16 + 4 + 8);
  const view = new DataView(blosc.buffer);
  blosc.set([2, 1, 0x01 | (2 << 5), 4]);
  view.setUint32(4, 64, true);
  view.setUint32(8, 64, true);
  view.setUint32(12, blosc.length, true);
  view.setUint32(16, 20, true);
  view.setInt32(20, 4, true);
  const bloscCodecs = [{ id: 'blosc', configuration: {} }];
  // An HDF5 chunk: deflate then Fletcher-32, with a damaged checksum; and
  // one whose stream inflates past its chunk.
  const filters = [
    { id: FILTER.DEFLATE, name: 'deflate', optional: false, clientData: [6] },
    { id: FILTER.FLETCHER32, name: 'fletcher32', optional: false, clientData: [] },
  ];
  const deflated = new Uint8Array(deflateSync(data));
  const checked = new Uint8Array(deflated.length + 4);
  checked.set(deflated);
  const bomb = new Uint8Array(deflateSync(new Uint8Array(data.length * 4)));
  const hdf5Task = (input, label) => ({
    kind: 'hdf5',
    description: { filters: filters.slice(0, 1), mask: 0, chunkBytes: data.length, label },
    input,
    size: data.length,
    revive: reviveHdf5Error,
    inThread: () => unfilter(input, filters.slice(0, 1), 0, data.length, label),
  });
  const checkedTask = {
    kind: 'hdf5',
    description: { filters, mask: 0, chunkBytes: data.length, label: 'Chunk [0] of /x' },
    input: checked,
    size: data.length,
    revive: reviveHdf5Error,
    inThread: () => unfilter(checked, filters, 0, data.length, 'Chunk [0] of /x'),
  };
  const tasks = [
    zstdTask(damaged, data.length),
    zstdTask(frame, data.length + 1),
    { ...zstdTask(blosc, 64), description: { codecs: bloscCodecs, sizes: [64] }, inThread: () => decodeWithCodecs(blosc, bloscCodecs, [64]) },
    checkedTask,
    hdf5Task(bomb, 'Chunk [1] of /x'),
  ];
  inThreadOnly();
  const here = [];
  for (const task of tasks) here.push(await failure(decodeChunkBytes(task)));
  configureDecodePool({ createWorker: countingWorkers().createWorker, size: 2, minBytes: 0 });
  const there = [];
  for (const task of tasks) there.push(await failure(decodeChunkBytes({ ...task, inThread: () => assert.fail('decoded on a worker') })));
  assert.deepEqual(there, here);
  assert.deepEqual(here.map(error => error.constructor), [
    'ZarrFormatError', 'ZarrFormatError', 'ZarrUnsupportedError', 'Hdf5FormatError', 'Hdf5FormatError',
  ]);
  assert.match(here[3].message, /Fletcher-32/);
  assert.match(here[4].message, /more than the \d+ bytes it declares/);
  configureDecodePool();
});

// ---------------------------------------------------------------------------
// Cancellation and lifetime.

test('a cancelled decode stops waiting at once; a waiting one is never sent; the pool keeps working', async () => {
  // The worker's answers are held until released: the cancelled read must
  // have stopped waiting before the worker has answered anything.
  const { counts, createWorker, answers } = countingWorkers({ holdAnswers: true });
  // One worker, one task at a time in it: the second task waits in the pool.
  configureDecodePool({ createWorker, size: 1, minBytes: 0 });
  const big = floats(4 * 1024 * 1024, 5);
  const bigFrame = new Uint8Array(zstdCompressSync(big, { params: { [constants.ZSTD_c_compressionLevel]: 1 } }));
  const small = floats(64 * 1024, 6);
  const smallFrame = new Uint8Array(zstdCompressSync(small));

  const running = new AbortController();
  const waiting = new AbortController();
  const first = decodeChunkBytes(zstdTask(bigFrame, big.length, { signal: running.signal }));
  const second = decodeChunkBytes(zstdTask(bigFrame, big.length));
  const third = decodeChunkBytes(zstdTask(bigFrame, big.length, { signal: waiting.signal }));
  // The chunks asked for in one turn are sent together, after it.
  assert.equal(decodePoolStats().queued, 3);
  await null;
  // Two tasks fit in a worker; the third waits.
  assert.equal(decodePoolStats().queued, 1);
  waiting.abort();
  await assert.rejects(third, { name: 'AbortError' });
  assert.equal(decodePoolStats().queued, 0);
  let firstSettled = false;
  first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
  running.abort(new DOMException('Gone.', 'AbortError'));
  await settle();
  assert.ok(firstSettled, 'the cancelled read did not wait for the worker');
  await assert.rejects(first, { name: 'AbortError', message: 'Gone.' });
  let secondSettled = false;
  second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
  await settle();
  assert.equal(secondSettled, false, 'no worker has answered yet: the read still running waits for it');
  answers.release();
  assert.deepEqual(await second, big);
  assert.equal(counts.tasks, 2, 'the cancelled waiting task was never sent');
  assert.deepEqual(await decodeChunkBytes(zstdTask(smallFrame, small.length)), small);
  // An already-aborted signal never starts.
  await assert.rejects(decodeChunkBytes(zstdTask(smallFrame, small.length, { signal: AbortSignal.abort() })), { name: 'AbortError' });
  assert.equal(counts.tasks, 3);
  configureDecodePool();
});

test('small chunks asked for together go to a worker as one message; one alone is decoded here', async () => {
  const { counts, createWorker } = countingWorkers();
  configureDecodePool({ createWorker, size: 2, minBytes: 4096 });
  const chunks = Array.from({ length: 40 }, (_, index) => floats(256, 100 + index));
  let here = 0;
  const task = data => {
    const frame = new Uint8Array(zstdCompressSync(data));
    return zstdTask(frame, data.length, { inThread: () => { here++; return zstdDecompress(frame, data.length); } });
  };
  // 40 chunks of 1 KiB: 40 KiB together, worth 10 messages of 4 KiB; sent
  // as at most four messages' worth each, they take three messages.
  const results = await Promise.all(chunks.map(data => decodeChunkBytes(task(data))));
  results.forEach((result, index) => assert.deepEqual(result, chunks[index]));
  assert.equal(here, 0, 'none was decoded in this thread');
  assert.equal(counts.tasks, 3);
  // One small chunk alone costs less here than a message.
  assert.deepEqual(await decodeChunkBytes(task(chunks[0])), chunks[0]);
  assert.equal(here, 1);
  assert.equal(counts.tasks, 3);
  configureDecodePool();
});

test('a damaged chunk among small ones fails alone with its own error', async () => {
  const { createWorker } = countingWorkers();
  configureDecodePool({ createWorker, size: 1, minBytes: 4096 });
  const good = Array.from({ length: 8 }, (_, index) => floats(256, 200 + index));
  const frames = good.map(data => new Uint8Array(zstdCompressSync(data)));
  const damaged = frames[3].slice();
  damaged[damaged.length - 6] ^= 0xff;
  const settled = await Promise.allSettled(frames.map((frame, index) =>
    decodeChunkBytes(zstdTask(index === 3 ? damaged : frame, good[index].length))));
  settled.forEach((outcome, index) => {
    if (index === 3) assert.equal(outcome.status, 'rejected');
    else assert.deepEqual(outcome.value, good[index]);
  });
  configureDecodePool();
});

test('background chunks wait behind every other; bytes given up are transferred once a worker answers', async () => {
  const { createWorker } = countingWorkers();
  // One worker, one message at a time in it after the first two.
  configureDecodePool({ createWorker, size: 1, minBytes: 0 });
  const data = floats(64 * 1024, 300);
  const frame = new Uint8Array(zstdCompressSync(data));
  const order = [];
  const decode = (label, extra) => decodeChunkBytes(zstdTask(frame, data.length, extra)).then(result => {
    order.push(label);
    return result;
  });
  // The worker takes the first two background chunks; a foreground chunk
  // asked for later goes before the background ones still waiting.
  const all = [1, 2, 3, 4].map(n => decode(`b${n}`, { background: true }));
  await null;
  all.push(decode('f1', {}));
  await Promise.all(all);
  assert.deepEqual(order, ['b1', 'b2', 'f1', 'b3', 'b4']);

  // Owned bytes spanning their buffer go as they are to a worker that has answered.
  const owned = frame.slice();
  assert.deepEqual(await decodeChunkBytes(zstdTask(owned, data.length, { owned: true })), data);
  assert.equal(owned.byteLength, 0, 'transferred, not copied');
  // A view of a larger buffer is copied whatever the caller says.
  const padded = new Uint8Array(frame.length + 8);
  padded.set(frame, 4);
  assert.deepEqual(await decodeChunkBytes(zstdTask(padded.subarray(4, 4 + frame.length), data.length, { owned: true })), data);
  assert.equal(padded.byteLength, frame.length + 8);
  configureDecodePool();
});

test('warming makes the workers before the first chunk', async () => {
  const { counts, createWorker } = countingWorkers();
  configureDecodePool({ createWorker, size: 3, minBytes: 0, idleMs: 30 });
  warmDecodePool();
  assert.equal(counts.made, 3);
  assert.equal(decodePoolStats().workers, 3);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(decodePoolStats().workers, 0, 'unused warm workers are let go when idle');
  inThreadOnly();
  warmDecodePool();
  assert.equal(decodePoolStats().workers, 0);
  configureDecodePool();
});

test('idle workers are terminated, after a while or at once', async () => {
  const { counts, createWorker } = countingWorkers();
  configureDecodePool({ createWorker, size: 2, minBytes: 0, idleMs: 30 });
  const data = floats(32 * 1024, 7);
  const frame = new Uint8Array(zstdCompressSync(data));
  await Promise.all([decodeChunkBytes(zstdTask(frame, data.length)), decodeChunkBytes(zstdTask(frame, data.length))]);
  assert.equal(decodePoolStats().workers, 2);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(decodePoolStats().workers, 0);
  // Made again for the next chunk; released at once when asked.
  assert.deepEqual(await decodeChunkBytes(zstdTask(frame, data.length)), data);
  assert.equal(counts.made, 3);
  assert.equal(decodePoolStats().workers, 1);
  releaseIdleDecodeWorkers();
  assert.equal(decodePoolStats().workers, 0);
  configureDecodePool();
});

// ---------------------------------------------------------------------------
// Fast paths against references.

test('the shared match copy repeats every offset and length exactly, writing nothing past the match', () => {
  const next = random(8);
  for (let offset = 1; offset <= 40; offset++) {
    for (const length of [0, 1, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 33, 63, 64, 100, 255, 256, 257, 700]) {
      for (const at of [offset, offset + 1, offset + 3, 64]) {
        const size = at + length + 16;
        const out = Uint8Array.from({ length: size }, () => Math.floor(next() * 256));
        const expected = out.slice();
        for (let k = 0; k < length; k++) expected[at + k] = expected[at - offset + k];
        copyMatch(out, new DataView(out.buffer), at, offset, length);
        assert.deepEqual(out, expected, `offset ${offset}, length ${length}, at ${at}`);
      }
    }
  }
});

test('byte unshuffle matches the reference for every element size, count and alignment', () => {
  const next = random(9);
  const reference = (input, size) => {
    const count = Math.floor(input.length / size);
    const out = input.slice();
    for (let b = 0; b < size; b++) for (let i = 0; i < count; i++) out[i * size + b] = input[b * count + i];
    return out;
  };
  for (const size of [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 16]) {
    for (const count of [0, 1, 3, 4, 5, 7, 8, 13, 64, 257]) {
      for (const tail of [0, 1, size > 1 ? size - 1 : 0]) {
        const input = Uint8Array.from({ length: count * size + tail }, () => Math.floor(next() * 256));
        const expected = reference(input, size);
        assert.deepEqual(byteUnshuffle(input, size), expected, `size ${size}, count ${count}, tail ${tail}`);
        for (const at of [0, 4, 1, 2]) {
          const dest = new Uint8Array(at + input.length + 3).fill(0xee);
          byteUnshuffleInto(input, dest, at, input.length, size);
          assert.deepEqual(dest.subarray(at, at + input.length), expected, `into at ${at}: size ${size}, count ${count}`);
          assert.ok(dest.subarray(0, at).every(byte => byte === 0xee) && dest.subarray(at + input.length).every(byte => byte === 0xee));
        }
      }
    }
  }
});

/**
 * An LZ4 block built from random literal runs and matches (offsets from 1 to
 * far back, lengths with and without extension bytes), with its output.
 */
function lz4Block(seed, size) {
  const next = random(seed);
  const out = [];
  const block = [];
  const lengthBytes = extra => {
    while (extra >= 255) {
      block.push(255);
      extra -= 255;
    }
    block.push(extra);
  };
  while (out.length < size) {
    // Every sequence but the last has a match, so the first needs a literal.
    const literals = Math.max(out.length === 0 ? 1 : 0,
      next() < 0.5 ? Math.floor(next() * 4) : next() < 0.8 ? Math.floor(next() * 20) : Math.floor(next() * 400));
    const matchLength = 4 + (next() < 0.6 ? Math.floor(next() * 12) : Math.floor(next() * 600));
    const token = (Math.min(literals, 15) << 4) | Math.min(matchLength - 4, 15);
    block.push(token);
    if (literals >= 15) lengthBytes(literals - 15);
    for (let i = 0; i < literals; i++) {
      const byte = Math.floor(next() * 256);
      block.push(byte);
      out.push(byte);
    }
    const reach = Math.min(out.length, 65535);
    const offset = next() < 0.3 ? 1 + Math.floor(next() * Math.min(reach, 9)) : 1 + Math.floor(next() * reach);
    block.push(offset & 0xff, offset >> 8);
    if (matchLength - 4 >= 15) lengthBytes(matchLength - 4 - 15);
    for (let i = 0; i < matchLength; i++) out.push(out[out.length - offset]);
  }
  // The final run: literals only.
  const last = Math.floor(next() * 24);
  block.push(Math.min(last, 15) << 4);
  if (last >= 15) lengthBytes(last - 15);
  for (let i = 0; i < last; i++) {
    const byte = Math.floor(next() * 256);
    block.push(byte);
    out.push(byte);
  }
  return { block: Uint8Array.from(block), expected: Uint8Array.from(out) };
}

test('LZ4 blocks decode exactly into any part of a buffer, never writing outside it', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const { block, expected } = lz4Block(seed, 200 + seed * 97);
    for (const start of [0, 1, 3, 4, 7]) {
      const output = new Uint8Array(start + expected.length + 19).fill(0xa5);
      lz4DecodeBlockInto(block, output, start, start + expected.length);
      assert.deepEqual(output.subarray(start, start + expected.length), expected, `seed ${seed}, start ${start}`);
      assert.ok(output.subarray(0, start).every(byte => byte === 0xa5), 'nothing before the region');
      assert.ok(output.subarray(start + expected.length).every(byte => byte === 0xa5), 'nothing after the region');
    }
    // The block as a view inside a larger buffer reads only its own bytes.
    const padded = new Uint8Array(block.length + 40).fill(0x11);
    padded.set(block, 20);
    const output = new Uint8Array(expected.length);
    lz4DecodeBlockInto(padded.subarray(20, 20 + block.length), output);
    assert.deepEqual(output, expected);
  }
});

test('Zstandard: short-period repeats, long matches and unknown sizes decode exactly', () => {
  const next = random(10);
  const parts = [];
  for (let period = 1; period <= 17; period++) {
    const pattern = Uint8Array.from({ length: period }, () => Math.floor(next() * 256));
    parts.push(Uint8Array.from({ length: 300 + period * 50 }, (_, i) => pattern[i % period]));
    parts.push(Uint8Array.from({ length: 1 + Math.floor(next() * 30) }, () => Math.floor(next() * 256)));
  }
  const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    at += part.length;
  }
  for (const level of [1, 3, 19]) {
    const frame = new Uint8Array(zstdCompressSync(data, { params: { [constants.ZSTD_c_compressionLevel]: level } }));
    assert.deepEqual(zstdDecompress(frame, data.length), data);
    assert.deepEqual(zstdDecompress(frame, null), data);
    const unsized = new Uint8Array(zstdCompressSync(data, { params: { [constants.ZSTD_c_contentSizeFlag]: 0, [constants.ZSTD_c_compressionLevel]: level } }));
    const twice = new Uint8Array([...unsized, ...unsized]);
    const both = zstdDecompress(twice, null);
    assert.deepEqual(both.subarray(0, data.length), data);
    assert.deepEqual(both.subarray(data.length), data);
  }
});
