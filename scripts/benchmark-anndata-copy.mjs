/**
 * The copy benchmark: a dataset written as a Cellucid-ready AnnData
 * `.zarr.zip` by the web app's copy (`assets/js/data/anndata/write/copy.js`),
 * from any file or folder the app reads, to a file on disk.
 *
 *   node scripts/benchmark-anndata-copy.mjs --source /abs/data.h5ad|/abs/store.zarr [--out /abs/copy.zarr.zip]
 *     [--budget-mb N] [--cell-major] [--verify]
 *
 * Reports the time, the bytes read and written, the write rate (MB of the
 * archive a second, and MB of the source's values a second) and the peak
 * memory of the process (heap and array buffers, sampled every 10 ms, less
 * what the opened source held before the copy started). `--cell-major`
 * presents the source's gene-major `X` as cell-major (its entries regrouped
 * by cell, held in memory before the timing starts), so the copy transposes
 * it in passes (`gene-major.js`); `--budget-mb` is the transposition's budget
 * (the worker's: the memory model's `columnIndex` share). `--workers N`
 * encodes the chunks on N decode workers (`pool-encoder.js`, as the app's
 * reader worker does; Node worker threads here), 0 (the default) in this
 * thread. `--dense ROWSxGENES` copies a dense float32 X of that size held
 * in memory in source chunks of 8,192 rows × every gene (deflated, so each
 * is read whole), counting the source chunks read: the read amplification
 * of a dense matrix's bands (1 when each band of every gene fits the
 * budget, `layout.js` `chunkShapeOf` `maxRows`). `--verify` opens
 * the copy with the app's opener and compares it with the source, element
 * for element (`tests/helpers/anndata-copy.mjs`).
 */

import { closeSync, openSync, readdirSync, statSync, writeSync } from 'node:fs';
import { openAsBlob } from 'node:fs';
import path from 'node:path';

import { writeAnnDataCopy } from '../assets/js/data/anndata/write/copy.js';
import { openSource, compareCopy } from '../tests/helpers/anndata-copy.mjs';
import { annData, array, countingStore, openStore, sparse, stringFrame } from '../tests/helpers/anndata-store.mjs';
import { openZarr } from '../assets/js/formats/zarr/index.js';
import { viewGroup } from '../assets/js/data/anndata/views/view-nodes.js';
import { configureDecodePool } from '../assets/js/formats/io/decode-pool.js';
import { poolEncoder } from '../assets/js/data/anndata/write/pool-encoder.js';
import { createNodeDecodeWorker } from '../tests/helpers/node-decode-worker.mjs';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const sourcePath = argument('--source');
const denseSize = argument('--dense');
if (sourcePath === null && denseSize === null) {
  console.error('Usage: node scripts/benchmark-anndata-copy.mjs (--source PATH | --dense ROWSxGENES) [--out PATH] [--budget-mb N] [--workers N] [--cell-major] [--verify]');
  process.exit(2);
}
const out = argument('--out', `${process.env.TMPDIR ?? '/tmp'}/benchmark-copy.zarr.zip`);
const budgetBytes = Number(argument('--budget-mb', '256')) * 1024 * 1024;
const workers = Number(argument('--workers', '0'));
if (workers > 0) configureDecodePool({ createWorker: () => createNodeDecodeWorker(), size: workers, minBytes: 0 });

/** A file, or a folder as a picked folder (`{files, rootName}`), each file read from disk as asked. */
async function sourceOf(file) {
  if (!statSync(file).isDirectory()) return { file: new File([await openAsBlob(file)], path.basename(file)) };
  const rootName = path.basename(file);
  const files = new Map();
  const walk = async folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.set(`${rootName}/${path.relative(file, full)}`, new File([await openAsBlob(full)], entry.name));
    }
  };
  await walk(file);
  return { files, rootName };
}

const memory = () => {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
};

/** A dense X of `size` (`ROWSxGENES`) in memory, its source chunks counted as they are read. */
async function denseSource(size) {
  const [rows, genes] = size.split('x').map(Number);
  const values = Float32Array.from({ length: rows * genes }, (_, i) => (i % 97) / 8);
  const tree = annData({
    obs: stringFrame(Array.from({ length: rows }, (_, i) => `c${i}`)),
    var: stringFrame(Array.from({ length: genes }, (_, g) => `g${g}`)),
    X: array(values, { shape: [rows, genes], chunks: [8192, genes], compressed: true }),
  });
  const { store, fetched } = countingStore(tree);
  return { root: await openZarr(store, { decodedChunkCacheBytes: 0 }), fetched, sourceChunks: Math.ceil(rows / 8192) };
}

const dense = denseSize === null ? null : await denseSource(denseSize);
const opened = dense ?? await openSource(await sourceOf(sourcePath));
let root = opened.root;
await root.load();
/** The source as stored (its gene-major X), beside the cell-major presentation. */
const gm = root;
const cellMajor = process.argv.includes('--cell-major');
if (cellMajor) {
  // The source's gene-major X regrouped by cell, held in memory beside it.
  const X = root.get('X');
  const shape = X.attrs.shape.map(Number);
  const [data, indices, indptr] = await Promise.all(['data', 'indices', 'indptr'].map(key => X.get(key).read()));
  const counts = new Float64Array(shape[0] + 1);
  for (let k = 0; k < indices.length; k++) counts[indices[k] + 1]++;
  for (let row = 0; row < shape[0]; row++) counts[row + 1] += counts[row];
  const cursor = Float64Array.from(counts.subarray(0, shape[0]));
  const csrData = new Float32Array(data.length);
  const csrIndices = new Int32Array(data.length);
  for (let gene = 0; gene < shape[1]; gene++) {
    for (let k = indptr[gene]; k < indptr[gene + 1]; k++) {
      const at = cursor[indices[k]]++;
      csrData[at] = data[k];
      csrIndices[at] = gene;
    }
  }
  const { root: held } = await openStore(annData({
    X: sparse({ format: 'csr', shape, data: csrData, indices: csrIndices, indptr: Int32Array.from(counts), chunks: 1 << 20 }),
  }));
  const real = root;
  root = viewGroup({ path: '/', real, attrs: real.attrs, children: new Map(real.keys().map(key => [key, () => (key === 'X' ? held.get('X') : real.get(key))])) });
}

globalThis.gc?.();
const before = memory();
let peak = before;
const sampler = setInterval(() => {
  peak = Math.max(peak, memory());
}, 10);
const descriptor = openSync(out, 'w');
let written = 0;
const sink = {
  write(part) {
    writeSync(descriptor, part);
    written += part.length;
  },
};
let values = 0;
const started = performance.now();
const result = await writeAnnDataCopy(root, sink, {
  budgetBytes,
  ...(workers > 0 ? { encode: poolEncoder(), inFlight: 2 * workers } : {}),
  onProgress: ({ total }) => { values = total; },
});
const ms = performance.now() - started;
clearInterval(sampler);
peak = Math.max(peak, memory());
closeSync(descriptor);

const mb = bytes => (bytes / 1e6).toFixed(1);
const report = {
  source: sourcePath ?? `dense ${denseSize}`,
  cellMajor,
  layout: result.layout,
  cells: result.nObs,
  seconds: Number((ms / 1000).toFixed(2)),
  archiveMB: Number(mb(written)),
  entries: result.entries,
  zip64: result.zip64,
  archiveMBps: Number((written / 1e6 / (ms / 1000)).toFixed(1)),
  sourceValuesPerSecondM: Number((values / 1e6 / (ms / 1000)).toFixed(1)),
  peakMemoryMB: Number(mb(peak - before)),
  budgetMB: budgetBytes / 1024 / 1024,
  encodeWorkers: workers,
  ...(dense === null ? {} : {
    sourceChunks: dense.sourceChunks,
    sourceChunkReads: dense.fetched.filter(key => key.startsWith('X/')).length,
    readAmplification: Number((dense.fetched.filter(key => key.startsWith('X/')).length / dense.sourceChunks).toFixed(2)),
  }),
  notes: result.notes,
};
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes('--verify')) {
  const copy = await openSource({ file: new File([await openAsBlob(out)], path.basename(out)) });
  if (cellMajor) {
    // The transposed X against the source's own gene-major X, array by array
    // (rows ascend within each gene in both); everything else element by element.
    for (const part of ['data', 'indices', 'indptr']) {
      const [expected, actual] = await Promise.all([gm.get(`X/${part}`).read(), copy.root.get(`X/${part}`).read()]);
      const same = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)
        .equals(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength));
      if (!same) throw new Error(`X/${part} differs from the source's gene-major X`);
    }
  }
  const seen = await compareCopy(root, copy.root, { skip: at => cellMajor && at === 'X' });
  console.log(`verified: ${seen.arrays} arrays equal${cellMajor ? ', and X equal to the source\'s gene-major X' : ''}`);
}
if (workers > 0) configureDecodePool();
