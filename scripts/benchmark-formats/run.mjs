/**
 * One `bench:formats` run, in its own process: one file or folder, opened
 * through the AnnData reader worker's own handler (`createAnnDataReaderHandler`)
 * with the calls the app makes for a first view, read as a browser reads a
 * picked file (`File` slices; a folder as its files). Prints one JSON line.
 *
 *   node run.mjs --file PATH [--inflate]
 *
 * Steps: `open` (for a stream format, R objects and MatrixMarket folders,
 * this is the one pass that reads and transcodes the whole file), `metadata`,
 * `embedding` (the default 2D embedding, as the first draw reads it), `obs
 * field` (the first categorical field, the first colouring), `first gene`
 * and `next gene` (`getMatrixColumn`, the first gene colouring). `firstViewMs`
 * is open + metadata + embedding. `peakRssMB` is the process's peak resident
 * memory.
 *
 * Decode workers run as `node:worker_threads` (the browser's dedicated
 * workers there), so the parse of a MatrixMarket file's entries and the
 * decoding of chunks run beside the reader thread as they do in the app.
 *
 * `--inflate` measures instead the platform's native `DecompressionStream`
 * on every gzip file of the input, fed in the same 1 MiB slices: the
 * decompression ceiling a stream format's pass is held to.
 */

import { openAsBlob, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const REPOSITORY = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const file = path.resolve(argument('--file'));
const isFolder = statSync(file).isDirectory();
const name = path.basename(file);

/** Every file below a folder, relative to it, hidden ones included. */
function filesBelow(folder, prefix = '') {
  const found = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...filesBelow(path.join(folder, entry.name), relative));
    else found.push(relative);
  }
  return found;
}

const counters = { requests: 0, bytes: 0 };
const arrayBuffer = Blob.prototype.arrayBuffer;
Blob.prototype.arrayBuffer = function countedArrayBuffer() {
  counters.requests++;
  counters.bytes += this.size;
  return arrayBuffer.call(this);
};

async function localFile(target) {
  return new File([await openAsBlob(target)], path.basename(target));
}

async function inflateCeiling() {
  const gzipped = isFolder
    ? filesBelow(file).filter(relative => relative.endsWith('.gz')).map(relative => path.join(file, relative))
    : [file];
  const SLICE = 1 << 20;
  let compressed = 0;
  let inflated = 0;
  const started = performance.now();
  for (const target of gzipped) {
    const blob = await openAsBlob(target);
    compressed += blob.size;
    const stream = new DecompressionStream('gzip');
    const writer = stream.writable.getWriter();
    const reading = (async () => {
      const reader = stream.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        inflated += value.length;
      }
    })();
    for (let offset = 0; offset < blob.size; offset += SLICE) {
      await writer.write(new Uint8Array(await arrayBuffer.call(blob.slice(offset, offset + SLICE))));
    }
    await writer.close();
    await reading;
  }
  const ms = performance.now() - started;
  return { file: name, mode: 'inflate', files: gzipped.length, compressedBytes: compressed, inflatedBytes: inflated, ms: Math.round(ms) };
}

async function firstView() {
  const worker = await import(pathToFileURL(path.join(REPOSITORY, 'assets/js/data/anndata-reader-worker.js')).href);
  // The reader thread's decode workers, as the browser's reader worker makes
  // them (as many as the cores and their memory budget allow), here as
  // `node:worker_threads` running the same decode worker module: blocks of
  // MatrixMarket entries and the background gene index are parsed and
  // decoded on them, beside the reader thread, as in the app.
  const { configureDecodePool } = await import(pathToFileURL(path.join(REPOSITORY, 'assets/js/formats/io/decode-pool.js')).href);
  const { residencyBudgetBytes } = await import(pathToFileURL(path.join(REPOSITORY, 'assets/js/data/memory-budget.js')).href);
  const { createNodeDecodeWorker } = await import(pathToFileURL(path.join(REPOSITORY, 'tests/helpers/node-decode-worker.mjs')).href);
  configureDecodePool({ createWorker: () => createNodeDecodeWorker(), memoryBytes: residencyBudgetBytes('decodeWorkers') });
  const handle = worker.createAnnDataReaderHandler({ post: () => {} });
  let nextId = 1;
  const call = async (method, ...args) => {
    const { reply } = await handle({ id: nextId++, method, args });
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result;
  };
  let source;
  if (isFolder) {
    const files = new Map();
    for (const relative of filesBelow(file)) files.set(relative, await localFile(path.join(file, relative)));
    source = { files, rootName: name };
  } else {
    source = { file: await localFile(file) };
  }
  const steps = [];
  const step = async (label, operation) => {
    const before = { ...counters };
    const started = performance.now();
    const value = await operation();
    steps.push({
      step: label,
      ms: Math.round((performance.now() - started) * 10) / 10,
      requests: counters.requests - before.requests,
      bytes: counters.bytes - before.bytes,
    });
    return value;
  };
  const result = { file: name, mode: 'first-view', steps, error: null };
  try {
    const snapshot = await step('open', () => call('open', { source }));
    await call('prepareMatrix', 'X');
    const metadata = await step('metadata', () => call('getDatasetMetadata'));
    const probes = await call('probeMapping');
    const embeddings = probes.obsm.filter(entry => entry.storage === 'dense' && entry.shape?.length === 2 && entry.shape[1] >= 2);
    const chosen = embeddings.find(entry => /umap/i.test(entry.key)) ?? embeddings[0];
    if (chosen === undefined) throw new Error('no 2D embedding');
    await step(`embedding ${chosen.key}`, () => call('readEmbedding', chosen.key, [0, 1], false));
    result.firstViewMs = Math.round(steps.reduce((sum, item) => sum + item.ms, 0));
    const fields = snapshot.obsKeys ?? [];
    if (fields.length > 0) await step(`obs field ${fields[0]}`, () => call('getObsField', fields[0]));
    const nVars = snapshot.nVars;
    await step('first gene', () => call('getMatrixColumn', 'X', Math.floor(nVars / 3)));
    await step('next gene', () => call('getMatrixColumn', 'X', Math.floor((2 * nVars) / 3)));
    result.cells = snapshot.nObs;
    result.genes = nVars;
    result.datasetName = metadata?.name ?? null;
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

const result = process.argv.includes('--inflate') ? await inflateCeiling() : await firstView();
result.peakRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);
