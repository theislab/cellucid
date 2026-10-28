/**
 * The scale check of one store at one share, in its own process: the reader
 * worker's handler reads, as the app does, the first view (the embedding and
 * the field it is coloured by), a first gene, 100 genes, and one analysis (a
 * differential expression's read: every cell of the two largest groups by
 * the 50 genes after the first 100), over a link (`--transport remote`:
 * `link.mjs`) or from a picked file (`local`). Prints one JSON line: each
 * step's time, bytes and requests, and the process's peak resident memory
 * and peak ArrayBuffer bytes (what the worker holds).
 *
 *   node --max-old-space-size=8192 scale-run.mjs --store PATH [--transport remote|local]
 *     [--latency 20] [--bandwidth 50] [--protocol h2] [--subsample JSON]
 *
 * @module scripts/efficiency-floor/scale-run
 */

import { openAsBlob, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FLOOR_HOST, Recorder, installLocalRecorder, installRemoteLink } from './link.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
console.log = console.info = console.debug = (...parts) => process.stderr.write(`${parts.join(' ')}\n`);

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

// A store on disk (`--store`), or a store a server serves (`--url`: a
// Python or R served store, reached through the same throttled link).
const servedUrl = argument('--url');
const store = servedUrl === null ? path.resolve(argument('--store')) : null;
const transport = argument('--transport', 'remote');
const cellSubset = JSON.parse(argument('--subsample', '{"mode":"all"}'));
const root = path.join(HERE, '..', '..');
const name = servedUrl === null ? path.basename(store) : new URL(servedUrl).pathname.split('/').filter(Boolean).at(-1);
const isFolder = servedUrl !== null || statSync(store).isDirectory();
const recorder = new Recorder();
const local = transport === 'local' ? installLocalRecorder(recorder) : null;
const remote = transport === 'remote'
  ? installRemoteLink({ root: store === null ? '/' : path.dirname(store), latencyMs: Number(argument('--latency', '20')), bandwidthMBps: Number(argument('--bandwidth', '50')), protocol: argument('--protocol', 'h2'), recorder })
  : null;

// Peak memory, sampled: resident set and ArrayBuffer bytes.
let peakArrayBuffers = 0;
const sampler = setInterval(() => { peakArrayBuffers = Math.max(peakArrayBuffers, process.memoryUsage().arrayBuffers); }, 50);

const worker = await import(pathToFileURL(path.join(root, 'assets/js/data/anndata-reader-worker.js')).href);
const { PieceReceiver } = await import(pathToFileURL(path.join(root, 'assets/js/utils/large-arrays.js')).href);
const { byteRangeCachePort } = await import(pathToFileURL(path.join(root, 'assets/js/data/byte-range-cache.js')).href);
const { adoptRangeCachePort } = await import(pathToFileURL(path.join(root, 'assets/js/formats/io/range-cache.js')).href);
const rangeCache = byteRangeCachePort();
adoptRangeCachePort(rangeCache.port);
// Arrays posted in pieces before a reply (`utils/large-arrays.js`), by request.
const pieces = new Map();
const handle = worker.createAnnDataReaderHandler({
  post: message => {
    if (message.event !== 'piece') return;
    if (!pieces.has(message.id)) pieces.set(message.id, new PieceReceiver());
    pieces.get(message.id).receive(message);
  },
});
let nextId = 1;
async function call(method, ...args) {
  const id = nextId++;
  const { reply } = await handle({ id, method, args });
  const received = pieces.get(id) ?? new PieceReceiver();
  pieces.delete(id);
  if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
  return received.resolve(reply.result);
}

const steps = [];
async function step(label, operation) {
  const mark = recorder.mark();
  const started = performance.now();
  const value = await operation();
  const reads = recorder.since(mark);
  const memory = process.memoryUsage();
  steps.push({ step: label, ms: Math.round(performance.now() - started), bytes: reads.reduce((s, r) => s + r.bytes, 0), requests: reads.length, rssMB: Math.round(memory.rss / 1e6), arrayBuffersMB: Math.round(memory.arrayBuffers / 1e6), heapMB: Math.round(memory.heapUsed / 1e6) });
  return value;
}

const result = { store: servedUrl ?? name, transport, subsample: cellSubset, steps, error: null };
try {
  let source;
  if (transport === 'remote') {
    if (servedUrl !== null) source = { url: servedUrl, name };
    else if (isFolder) source = { url: `${FLOOR_HOST}${encodeURIComponent(name)}/`, name };
    else {
      const { describeRemoteFile } = await import(pathToFileURL(path.join(root, 'assets/js/data/sources/remote-file.js')).href);
      const entry = await step('probe', () => describeRemoteFile({ url: `${FLOOR_HOST}${encodeURIComponent(name)}`, id: name, name, attribution: { title: name, url: FLOOR_HOST } }));
      source = { file: entry.resource };
    }
  } else if (isFolder) {
    const files = new Map();
    const walk = async (absolute, relative) => {
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        const child = path.join(absolute, entry.name);
        const key = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(child, key);
        else files.set(key, local.tag(new File([await openAsBlob(child)], entry.name), `${name}/${key}`));
      }
    };
    await walk(store, '');
    source = { files, rootName: name };
  } else {
    source = { file: local.tag(new File([await openAsBlob(store)], name), name) };
  }
  const opened = await step('open', () => call('open', { source, cellSubset }));
  result.cells = { open: opened.nObs, of: opened.cellSubset?.nObs ?? opened.nObs };
  const field = opened.obsKeys.includes('cluster') ? 'cluster' : opened.obsKeys[0];
  // The first two-dimensional embedding (`X_umap` as Python names it, `X_umap` or `UMAP` from R).
  const probes = await call('probeMapping');
  const embedding = probes.obsm.find(entry => entry.storage === 'dense' && entry.shape?.[1] === 2)?.key ?? 'X_umap';
  const [, codes] = await step('first view (X_umap + cluster)', () => Promise.all([
    call('readEmbedding', embedding, [0, 1], true),
    call('getObsField', field),
  ]));
  const nVars = opened.nVars;
  // Distinct genes spread over the var axis (as many as it has, up to 151).
  const genes = [...new Set(Array.from({ length: 151 }, (_, i) => Math.floor((i * 7919 + 13) % nVars)))];
  const hundred = genes.slice(1, Math.min(101, genes.length));
  const analysed = genes.length > 101 ? genes.slice(101) : genes;
  await step('first gene', () => call('getMatrixColumn', 'X', genes[0]));
  // Many genes at once as an analysis takes them: sparse (a dense column per
  // gene of 100M cells is 400 MB; 100 of them would hold 40 GB of zeros).
  await step('100 genes', () => call('getMatrixColumnsSparse', 'X', hundred));
  const sizes = new Float64Array(codes.categories.length);
  for (const code of codes.codes) if (code >= 0) sizes[code]++;
  const [a, b] = Array.from(sizes.keys()).sort((x, y) => sizes[y] - sizes[x] || x - y);
  const cells = [];
  codes.codes.forEach((code, cell) => { if (code === a || code === b) cells.push(cell); });
  await step('DE read (two largest groups x 50 genes)', () => call('getMatrixCellSubset', 'X', cells, analysed));
  result.deCells = cells.length;
} catch (error) {
  result.error = error.stack ?? error.message;
}
clearInterval(sampler);
result.peakRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
result.peakArrayBuffersMB = Math.round(peakArrayBuffers / 1e6);
result.totalBytes = recorder.bytes;
result.totalRequests = recorder.requests;
local?.close();
remote?.close();
adoptRangeCachePort(null);
rangeCache.close();
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);
