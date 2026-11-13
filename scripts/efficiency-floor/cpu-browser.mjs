/**
 * CPU stages of reading, measured in Chromium, Firefox and WebKit
 * (Playwright), on real chunks of the efficiency-floor corpus: what each
 * stage reaches against the fastest way each browser offers.
 *
 * - **Decompression, per codec, in a worker** (where the readers decode): the
 *   app's decoder (`inflate`: `DecompressionStream` fed in slices; the
 *   JavaScript Zstandard, Blosc, LZ4, LZF, bzip2 and xz decoders) against a
 *   whole-chunk `DecompressionStream` (DEFLATE, and Zstandard where the
 *   browser takes it), and against any other decoders `--candidates` names
 *   (a module whose default export resolves to `{codec: {name: (bytes,
 *   decodedSize) => Uint8Array}}`: a WebAssembly build, a JavaScript port),
 *   each checked byte for byte against the app's output. The corpus holds
 *   DEFLATE (h5py's small chunks), Zstandard, Blosc-LZ4 and LZF chunks; with
 *   `--python`, numcodecs re-encodes the corpus's decoded Zstandard chunks
 *   with every other codec a Zarr store may use (zlib, gzip, Blosc with
 *   zlib/zstd/blosclz and bit shuffle, LZ4, bz2, LZMA), so each is measured
 *   on the same real values.
 * - **Decoding on several cores**: k workers decoding the same codec at once
 *   (k = 1, 2, 4, … up to the cores the decode pool may use), and the app's
 *   own decode pool (`decode-pool.js`) given every chunk at once from a
 *   reader-like worker: what spreading the work reaches. With
 *   `--parallel-candidates`, every other decoder that gives the app's bytes
 *   on k workers too (`parallelOthers`): a decoder fastest on one core can
 *   be slowest on many (measured: 21_decisions_decoders_and_codecs.md).
 * - **A large store's own chunks** (`--store PATH`, repeatable: a
 *   `scale.py` `.h5ad` (DEFLATE) or Zarr v3 folder (Zstandard)): up to 300
 *   chunks of `X/data` and of `X/indices` spread over the file, fetched by
 *   the page with Range requests and decoded through the app's decode pool
 *   at its steady state: chunk shapes are the writer's for that size (h5py
 *   chunks grow with the dataset), which the corpus's 40,000 cells do not show.
 * - Typed-array copies: `TypedArray.prototype.set` and `slice` of 64 MB.
 * - Worker transfer: a 64 MB `Float32Array` posted to a worker and back,
 *   transferred against copied (structured clone).
 * - Main-thread blocking: the longest task while a worker decodes 64 MB.
 *
 *   node scripts/efficiency-floor/cpu-browser.mjs CORPUS [--engines chromium,firefox,webkit]
 *        [--python /path/to/python] [--candidates DIR] [--parallel-candidates] [--port 4575] [--out cpu.json]
 *
 * Run it alone: it starts browsers, one after another.
 */

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { openSync, readFileSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codecOf, loadLayout } from './floor.mjs';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPOSITORY, 'package.json'));
const playwright = require('playwright');

function option(name, fallback = null) {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
}

const corpus = path.resolve(process.argv[2]);
const port = Number(option('--port', 4575));
const out = option('--out');
const python = option('--python');
const candidates = option('--candidates') === null ? null : path.resolve(option('--candidates'));
const engines = option('--engines', 'chromium,firefox,webkit').split(',');
const stores = process.argv.flatMap((value, index) => (value === '--store' ? [path.resolve(process.argv[index + 1])] : []));
const parallelCandidates = process.argv.includes('--parallel-candidates');
const manifest = JSON.parse(readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));

/** The stored bytes of one chunk-map entry (a ZIP entry's local header removed). */
function chunkBytes(layout, name, entry) {
  const file = layout.kind === 'zarr' ? path.join(corpus, name, entry[3]) : path.join(corpus, name);
  const bytes = Buffer.alloc(entry[2]);
  const fd = openSync(file, 'r');
  readSync(fd, bytes, 0, bytes.length, layout.kind === 'zarr' ? 0 : entry[1]);
  closeSync(fd);
  const start = layout.kind === 'zarr-zip' ? 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28) : 0;
  return bytes.subarray(start);
}

/** Corpus codec names as this harness keys them: h5py's DEFLATE chunks are small. */
const CORPUS_KEYS = { gzip: 'deflate-h5py', zstd: 'zstd', 'blosc-lz4': 'blosc-lz4', lzf: 'lzf' };

/**
 * Up to 24 whole chunks of X's arrays per codec, as stored, and the files of
 * the Zstandard ones (what `--python` re-encodes).
 */
function corpusSamples() {
  const byCodec = {};
  const zstdFiles = [];
  for (const name of Object.keys(manifest.files)) {
    let layout;
    try {
      layout = loadLayout(corpus, name);
    } catch {
      continue;
    }
    for (const arrayPath of ['/X/data', '/X/indices']) {
      const array = layout.arrays[arrayPath];
      if (!array || array.layout !== 'chunked') continue;
      const key = CORPUS_KEYS[codecOf(array)];
      if (key === undefined) continue;
      byCodec[key] ??= [];
      const item = array.itemsize ?? (/64/.test(array.dtype) ? 8 : 4);
      const decoded = array.chunks.reduce((a, b) => a * b, 1) * item;
      for (const entry of array.chunkMap.filter(e => e[0][0] + array.chunks[0] <= array.shape[0]).slice(0, 24 - byCodec[key].length)) {
        byCodec[key].push({ b64: chunkBytes(layout, name, entry).toString('base64'), decoded });
        if (key === 'zstd' && layout.kind === 'zarr') zstdFiles.push(path.join(corpus, name, entry[3]));
      }
    }
  }
  return { byCodec, zstdFiles };
}

/** The decoded corpus chunks re-encoded by numcodecs with every other codec a Zarr store may name. */
function encodedSamples(files) {
  const script = `
import base64, json, sys
import numpy as np
from numcodecs import BZ2, GZip, LZ4, LZMA, Blosc, Zlib, Zstd
files = json.load(sys.stdin)
raw = [Zstd().decode(open(f, 'rb').read()) for f in files]
codecs = {
    'zlib': Zlib(level=1), 'gzip': GZip(level=1),
    'blosc-zlib': Blosc(cname='zlib', clevel=5, shuffle=Blosc.SHUFFLE),
    'blosc-zstd': Blosc(cname='zstd', clevel=5, shuffle=Blosc.SHUFFLE),
    'blosc-blosclz': Blosc(cname='blosclz', clevel=5, shuffle=Blosc.SHUFFLE),
    'blosc-lz4-bitshuffle': Blosc(cname='lz4', clevel=5, shuffle=Blosc.BITSHUFFLE),
    'lz4': LZ4(), 'bz2': BZ2(), 'lzma': LZMA(),
}
out = {}
for key, codec in codecs.items():
    out[key] = [{'b64': base64.b64encode(codec.encode(np.frombuffer(r, dtype='<u4'))).decode(), 'decoded': len(r)} for r in raw]
print(json.dumps(out))`;
  return JSON.parse(execFileSync(python, ['-I', '-c', script], { input: JSON.stringify(files), maxBuffer: 1 << 30 }).toString());
}

/**
 * Up to `perArray` chunks of `X/data` and `X/indices` of a scale store, spread
 * over each array (its last, partial chunk left out): where each lies, its
 * decoded size and its codec as a Zarr codec list.
 */
function storeChunks(store, perArray = 300) {
  if (statSync(store).isDirectory()) {
    const out = [];
    for (const array of ['X/data', 'X/indices']) {
      const meta = JSON.parse(readFileSync(path.join(store, array, 'zarr.json'), 'utf8'));
      const chunk = meta.chunk_grid.configuration.chunk_shape[0];
      const item = /64/.test(meta.data_type) ? 8 : 4;
      const count = Math.floor(meta.shape[0] / chunk);
      const codecs = meta.codecs.filter(codec => codec.name !== 'bytes').map(codec => ({ id: codec.name, configuration: {} }));
      const step = Math.max(1, Math.floor(count / perArray));
      for (let c = 0; c < count && out.length < 2 * perArray; c += step) {
        const relative = `${array}/c/${c}`;
        out.push({ path: relative, start: 0, end: statSync(path.join(store, relative)).size, decoded: chunk * item, codecs });
      }
    }
    return out;
  }
  const script = `
import json, sys, h5py
f = h5py.File(sys.argv[1], 'r'); per = int(sys.argv[2]); out = []
for name in ('X/data', 'X/indices'):
    d = f[name]; n = d.id.get_num_chunks(); rows = d.chunks[0]; full = d.shape[0] // rows
    step = max(1, full // per)
    for i in range(0, full, step):
        info = d.id.get_chunk_info(i)
        if info.chunk_offset[0] + rows > d.shape[0]: continue
        out.append({'path': '', 'start': info.byte_offset, 'end': info.byte_offset + info.size, 'decoded': rows * d.dtype.itemsize, 'filters': [d.compression]})
        if len(out) >= 2 * per: break
print(json.dumps(out))`;
  return JSON.parse(execFileSync(python, ['-I', '-c', script, store, String(perArray)], { maxBuffer: 1 << 26 }).toString())
    .map(entry => ({ ...entry, codecs: [{ id: 'zlib', configuration: {} }] }));
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>cpu</title><script type="module">
window.__ready = true;
</script>`;

const WORKER = `
import { inflate } from '/assets/js/formats/io/inflate.js';
import { lzfDecompress } from '/assets/js/formats/hdf5/lzf.js';
import { bloscDecode } from '/assets/js/formats/zarr/codecs/blosc.js';
import { numcodecsLz4Decode } from '/assets/js/formats/zarr/codecs/lz4.js';
import { zstdDecompress } from '/assets/js/formats/zarr/codecs/zstd.js';
import { bunzip2 } from '/assets/js/formats/rds/bzip2.js';
import { unxz } from '/assets/js/formats/rds/xz.js';
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
async function gathered(decompress, bytes, decoded) {
  const output = new Uint8Array(decoded);
  let at = 0;
  for await (const piece of decompress((async function* one() { yield bytes; })())) { output.set(piece, at); at += piece.length; }
  return output;
}
const deflateFormat = bytes => (bytes[0] === 0x1f ? 'gzip' : 'deflate');
/** The app's decoder of each codec, as the readers call it. */
const APP = {
  'deflate-h5py': c => inflate(c.bytes, { format: deflateFormat(c.bytes), expectedSize: c.decoded }),
  zlib: c => inflate(c.bytes, { format: 'deflate', expectedSize: c.decoded }),
  gzip: c => inflate(c.bytes, { format: 'gzip', expectedSize: c.decoded }),
  zstd: c => zstdDecompress(c.bytes, c.decoded),
  'blosc-lz4': c => bloscDecode(c.bytes, c.decoded),
  'blosc-zlib': c => bloscDecode(c.bytes, c.decoded),
  'blosc-zstd': c => bloscDecode(c.bytes, c.decoded),
  'blosc-blosclz': c => bloscDecode(c.bytes, c.decoded),
  'blosc-lz4-bitshuffle': c => bloscDecode(c.bytes, c.decoded),
  lz4: c => numcodecsLz4Decode(c.bytes, c.decoded),
  lzf: c => lzfDecompress(c.bytes, c.decoded),
  bz2: c => gathered(bunzip2, c.bytes, c.decoded),
  lzma: c => gathered(unxz, c.bytes, c.decoded),
};
async function wholeStream(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** The platform's own decoders: a whole chunk written to a DecompressionStream at once. */
function platform() {
  const found = {};
  const deflate = c => wholeStream(c.bytes, deflateFormat(c.bytes));
  for (const key of ['deflate-h5py', 'zlib', 'gzip']) found[key] = { 'DecompressionStream (whole)': deflate };
  try {
    new DecompressionStream('zstd');
    found.zstd = { 'DecompressionStream (whole)': c => wholeStream(c.bytes, 'zstd') };
  } catch {}
  return found;
}
let others = null;
async function otherDecoders(url) {
  if (url === null) return {};
  others ??= import(url).then(module => module.default());
  return others;
}
async function rate(chunks, decode) {
  for (const chunk of chunks) await decode(chunk);
  let decoded = 0;
  let rounds = 0;
  const started = performance.now();
  while (rounds < 2 || (rounds < 6 && performance.now() - started < 400)) {
    for (const chunk of chunks) { await decode(chunk); decoded += chunk.decoded; }
    rounds += 1;
  }
  return Math.round(decoded / (performance.now() - started) / 1e3);
}
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const asBytes = value => (value instanceof Uint8Array ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
let loaded = null;
let loadedDecode = null;
self.onmessage = async ({ data }) => {
  if (data.kind === 'echo') { self.postMessage(data.payload, data.transfer ? [data.payload.buffer] : []); return; }
  if (data.kind === 'spin') {
    // Decode 64 MB of DEFLATE the app's way, to see the page stays free.
    const chunk = data.chunk;
    let decoded = 0;
    const started = performance.now();
    while (decoded < 64e6) { await inflate(chunk.bytes, { format: deflateFormat(chunk.bytes), expectedSize: chunk.decoded }); decoded += chunk.decoded; }
    self.postMessage({ ms: performance.now() - started });
    return;
  }
  if (data.kind === 'load') {
    // One codec's chunks, decoded once (warm), for a run on several workers
    // at once, by the app's decoder or another one by name (\`--parallel-candidates\`).
    loaded = data.samples.map(c => ({ bytes: fromBase64(c.b64), decoded: c.decoded }));
    loadedDecode = data.decoder === 'app' ? APP[data.codec] : { ...platform()[data.codec], ...(await otherDecoders(data.candidates))[data.codec] }[data.decoder];
    for (const chunk of loaded) await loadedDecode(chunk);
    self.postMessage('ready');
    return;
  }
  if (data.kind === 'go') {
    let decoded = 0;
    for (let round = 0; round < data.rounds; round++) for (const chunk of loaded) { await loadedDecode(chunk); decoded += chunk.decoded; }
    self.postMessage({ decoded, at: performance.now() });
    return;
  }
  const out = {};
  const extra = await otherDecoders(data.candidates);
  const native = platform();
  for (const [codec, list] of Object.entries(data.samples)) {
    const chunks = list.map(c => ({ bytes: fromBase64(c.b64), decoded: c.decoded }));
    const stored = chunks.reduce((sum, c) => sum + c.bytes.length, 0);
    const decoded = chunks.reduce((sum, c) => sum + c.decoded, 0);
    const row = { chunks: chunks.length, meanDecodedKB: Math.round(decoded / chunks.length / 1024), ratio: Math.round(decoded / stored * 100) / 100, MBps: {}, same: {} };
    try {
      row.MBps.app = await rate(chunks, APP[codec]);
    } catch (error) { row.appError = String(error).slice(0, 160); out[codec] = row; continue; }
    const reference = [];
    for (const chunk of chunks) reference.push(asBytes(await APP[codec](chunk)).slice());
    for (const [name, decode] of Object.entries({ ...native[codec], ...extra[codec] })) {
      try {
        let same = true;
        for (let i = 0; i < chunks.length; i++) same &&= sameBytes(asBytes(await decode(chunks[i])), reference[i]);
        row.same[name] = same;
        row.MBps[name] = await rate(chunks, decode);
      } catch (error) { row.MBps[name] = null; row.same[name] = String(error).slice(0, 160); }
    }
    out[codec] = row;
  }
  self.postMessage(out);
};`;

/**
 * A reader-like worker: every chunk handed to the app's decode pool at once,
 * as a read of many chunks does (Zarr descriptions; the pool sizes itself).
 */
const POOL_WORKER = `
import { configureDecodePool, decodeChunkBytes, decodePoolStats } from '/assets/js/formats/io/decode-pool.js';
import { DECODERS, choiceKey } from '/assets/js/formats/io/decoder-choice.js';
import { decodeWithCodecs, reviveZarrError } from '/assets/js/formats/zarr/codecs/pipeline.js';
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const CODECS = { zstd: [{ id: 'zstd', configuration: {} }], lz4: [{ id: 'lz4', configuration: {} }], 'blosc-lz4': [{ id: 'blosc', configuration: {} }], 'blosc-lz4-bitshuffle': [{ id: 'blosc', configuration: {} }], 'blosc-zlib': [{ id: 'blosc', configuration: {} }], zlib: [{ id: 'zlib', configuration: {} }], 'deflate-h5py': [{ id: 'zlib', configuration: {} }] };
/** The family a codec list's decoder is chosen for (decoder-choice.js; a Blosc frame of zlib streams is DEFLATE's). */
const FAMILY = { zstd: 'zstd', lz4: 'lz4', 'blosc-lz4': 'blosc', 'blosc-lz4-bitshuffle': 'blosc', 'blosc-zlib': 'deflate', zlib: 'deflate', 'deflate-h5py': 'deflate' };
self.onmessage = async ({ data }) => {
  const out = {};
  if (data.store !== undefined) {
    // A store's own chunks, fetched first (not timed), then decoded through the pool.
    const chunks = await Promise.all(data.store.chunks.map(async chunk => {
      const response = await fetch(data.store.url + chunk.path, { headers: { Range: \`bytes=\${chunk.start}-\${chunk.end - 1}\` } });
      return { bytes: new Uint8Array(await response.arrayBuffer()), decoded: chunk.decoded, codecs: chunk.codecs };
    }));
    const decode = chunk => decodeChunkBytes({
      kind: 'zarr', description: { codecs: chunk.codecs, sizes: [chunk.decoded] }, input: chunk.bytes, size: chunk.decoded, family: FAMILY[chunk.codecs[0].id] ?? chunk.codecs[0].id,
      revive: reviveZarrError, inThread: () => decodeWithCodecs(chunk.bytes, chunk.codecs, [chunk.decoded]),
    });
    const timed = async rounds => {
      const started = performance.now();
      let decoded = 0;
      const all = [];
      for (let round = 0; round < rounds; round++) for (const chunk of chunks) { all.push(decode(chunk)); decoded += chunk.decoded; }
      await Promise.all(all);
      return Math.round(decoded / (performance.now() - started) / 1e3);
    };
    const first = await timed(1);
    for (let round = 0; round < 3; round++) await timed(1);
    self.postMessage({ chunks: chunks.length, meanStoredKB: Math.round(chunks.reduce((s, c) => s + c.bytes.length, 0) / chunks.length / 1024), meanDecodedKB: Math.round(chunks.reduce((s, c) => s + c.decoded, 0) / chunks.length / 1024), firstPassMBps: first, steadyMBps: await timed(3), workers: decodePoolStats().workers });
    return;
  }
  for (const [codec, list] of Object.entries(data.samples)) {
    const codecs = CODECS[codec];
    if (codecs === undefined) continue;
    const chunks = list.map(c => ({ bytes: fromBase64(c.b64), decoded: c.decoded }));
    const decode = chunk => decodeChunkBytes({
      kind: 'zarr', description: { codecs, sizes: [chunk.decoded] }, input: chunk.bytes, size: chunk.decoded, family: FAMILY[codec],
      revive: reviveZarrError, inThread: () => decodeWithCodecs(chunk.bytes, codecs, [chunk.decoded]),
    });
    const timed = async () => {
      const started = performance.now();
      let decoded = 0;
      const all = [];
      for (let round = 0; round < data.rounds; round++) for (const chunk of chunks) { all.push(decode(chunk)); decoded += chunk.decoded; }
      await Promise.all(all);
      return Math.round(decoded / (performance.now() - started) / 1e3);
    };
    // The pool with each decoder of the family fixed (decode-pool.js \`decoders\`), warmed, then timed: what each gives the pool.
    const fixed = {};
    for (const decoder of DECODERS[FAMILY[codec]] ?? []) {
      configureDecodePool({ decoders: { [FAMILY[codec]]: decoder } });
      for (let round = 0; round < data.warmRounds; round++) await Promise.all(chunks.map(decode));
      fixed[decoder] = await timed();
    }
    // Then the probe free (nothing kept across runs): warmed, then left idle until it has decided (it measures
    // while the pool has no other work, decode-pool.js), then timed alike: the steady state a long read decodes at.
    configureDecodePool({ memory: null });
    const key = choiceKey(FAMILY[codec], chunks[0].decoded);
    let warm = 0;
    for (; warm < data.warmRounds; warm++) await Promise.all(chunks.map(decode));
    const idleUntil = performance.now() + 60_000;
    while (DECODERS[FAMILY[codec]] !== undefined && decodePoolStats().decoders[key]?.decided == null && performance.now() < idleUntil) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // With the decoders the pool measured and kept, per family and size class (decoder-choice.js), against each fixed.
    out[codec] = { MBps: await timed(), fixed, warmRounds: warm, workers: decodePoolStats().workers, decoders: decodePoolStats().decoders ?? null };
    configureDecodePool();
  }
  self.postMessage(out);
};`;

function serveFile(response, file) {
  const type = file.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(file) ? 'text/javascript' : 'application/octet-stream';
  response.writeHead(200, { 'Content-Type': type }).end(readFileSync(file));
}

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/__cpu.html') return response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
  if (url.pathname === '/__cpu-worker.js') return response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(WORKER);
  if (url.pathname === '/__pool-worker.js') return response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(POOL_WORKER);
  const storeMatch = /^\/__store\/(\d+)\/(.*)$/.exec(url.pathname);
  if (storeMatch !== null) {
    const base = stores[Number(storeMatch[1])];
    const file = statSync(base).isDirectory() ? path.join(base, decodeURIComponent(storeMatch[2])) : base;
    const plain = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    // A suffix range (`bytes=-n`), as every web host answers it.
    const suffix = /^bytes=-(\d+)$/.exec(request.headers.range ?? '');
    const range = plain ?? suffix;
    const size = statSync(file).size;
    const [start, end] = plain !== null ? [Number(plain[1]), plain[2] === '' ? size - 1 : Math.min(size - 1, Number(plain[2]))]
      : suffix !== null ? [Math.max(0, size - Number(suffix[1])), size - 1] : [0, size - 1];
    const bytes = Buffer.alloc(end - start + 1);
    const fd = openSync(file, 'r');
    readSync(fd, bytes, 0, bytes.length, start);
    closeSync(fd);
    return response.writeHead(range === null ? 200 : 206, { 'Content-Type': 'application/octet-stream' }).end(bytes);
  }
  const root = url.pathname.startsWith('/__candidates/') && candidates !== null ? candidates : REPOSITORY;
  const relative = decodeURIComponent(root === REPOSITORY ? url.pathname : url.pathname.slice('/__candidates'.length));
  let file = path.join(root, relative);
  // Extensionless relative imports, as a bundler resolves them (candidate packages).
  if (!statSync(file, { throwIfNoEntry: false })?.isFile() && statSync(`${file}.js`, { throwIfNoEntry: false })?.isFile()) file = `${file}.js`;
  if (!file.startsWith(root) || !statSync(file, { throwIfNoEntry: false })?.isFile()) return response.writeHead(404).end();
  return serveFile(response, file);
});

/** The codecs measured on k workers: every family with more than one decoder to choose from. */
const PARALLEL_CODECS = ['deflate-h5py', 'zlib', 'gzip', 'zstd', 'lz4', 'blosc-lz4', 'blosc-zstd', 'blosc-zlib', 'blosc-blosclz', 'blosc-lz4-bitshuffle'];

/** Aggregate decode rate of `k` workers decoding `codec` at once, each over every sample. */
async function parallelRate(page, codec, list, k, decoder = 'app') {
  return page.evaluate(async ({ codec, list, k, decoder, candidates }) => {
    const workers = Array.from({ length: k }, () => new Worker('/__cpu-worker.js', { type: 'module' }));
    const answer = worker => new Promise(resolve => { worker.onmessage = event => resolve(event.data); });
    await Promise.all(workers.map(worker => { const ready = answer(worker); worker.postMessage({ kind: 'load', codec, samples: list, decoder, candidates }); return ready; }));
    const rounds = 6;
    const started = performance.now();
    const done = await Promise.all(workers.map(worker => { const result = answer(worker); worker.postMessage({ kind: 'go', codec, rounds }); return result; }));
    const ms = performance.now() - started;
    for (const worker of workers) worker.terminate();
    return Math.round(done.reduce((sum, d) => sum + d.decoded, 0) / ms / 1e3);
  }, { codec, list, k, decoder, candidates: candidates === null ? null : '/__candidates/candidates.mjs' });
}

async function measure(engineName, samples) {
  // Launched as every measuring script launches it (`lib/browser-launch.mjs`);
  // it decodes in workers and draws nothing, so no renderer is checked.
  const browser = await playwright[engineName].launch(browserLaunchOptions(engineName));
  const result = { browser: `${engineName} ${browser.version()}` };
  let page = null;
  const openPage = async () => {
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/__cpu.html`);
    await page.waitForFunction(() => window.__ready === true);
  };
  /** A step's value, or its error (the page reopened, for the steps after it). */
  const guarded = async (label, step) => {
    console.error(`${engineName}: ${label}`);
    try {
      return await step();
    } catch (error) {
      await page.close().catch(() => {});
      await openPage();
      return { error: String(error).slice(0, 300) };
    }
  };
  try {
    await openPage();
    result.cores = await page.evaluate(() => navigator.hardwareConcurrency);
    // One codec at a time: a page that fails (a renderer that crashes) names its codec, and the next opens a new page.
    result.decode = {};
    for (const [codec, list] of Object.entries(samples)) {
      console.error(`${engineName}: one core, ${codec}`);
      try {
        Object.assign(result.decode, await page.evaluate(async payload => {
          const worker = new Worker('/__cpu-worker.js', { type: 'module' });
          const answer = new Promise(resolve => { worker.onmessage = event => resolve(event.data); worker.onerror = event => resolve({ [payload.codec]: { error: String(event.message) } }); });
          worker.postMessage({ kind: 'decode', samples: { [payload.codec]: payload.list }, candidates: payload.candidates });
          const value = await answer;
          worker.terminate();
          return value;
        }, { codec, list, candidates: candidates === null ? null : '/__candidates/candidates.mjs' }));
      } catch (error) {
        result.decode[codec] = { error: String(error).slice(0, 300) };
        await page.close().catch(() => {});
        await openPage();
      }
    }
    // Several cores: the app's decoders on k workers at once, then the decode pool itself.
    const most = Math.max(1, result.cores - 2);
    const ks = [...new Set([1, 2, 4, most].filter(k => k <= most))];
    result.parallel = {};
    for (const codec of PARALLEL_CODECS) {
      if (!samples[codec]) continue;
      result.parallel[codec] = {};
      for (const k of ks) result.parallel[codec][k] = await guarded(`${codec} on ${k}`, () => parallelRate(page, codec, samples[codec], k));
    }
    // The other decoders that give the app's bytes, on k workers too: a
    // decoder whose rate falls as workers are added is judged at the pool's
    // width.
    if (parallelCandidates) {
      result.parallelOthers = {};
      for (const codec of PARALLEL_CODECS) {
        const others = Object.entries(result.decode?.[codec]?.same ?? {}).filter(([, same]) => same === true).map(([name]) => name);
        for (const name of others) {
          result.parallelOthers[codec] ??= {};
          result.parallelOthers[codec][name] = {};
          for (const k of ks) result.parallelOthers[codec][name][k] = await guarded(`${codec} ${name} on ${k}`, () => parallelRate(page, codec, samples[codec], k, name));
        }
      }
    }
    result.pool = await guarded('the decode pool', () => page.evaluate(async samples => {
      const worker = new Worker('/__pool-worker.js', { type: 'module' });
      const answer = new Promise(resolve => { worker.onmessage = event => resolve(event.data); worker.onerror = event => resolve({ error: String(event.message) }); });
      worker.postMessage({ samples, rounds: 6, warmRounds: 40 });
      const value = await answer;
      worker.terminate();
      return value;
    }, Object.fromEntries(['deflate-h5py', 'zlib', 'zstd', 'lz4', 'blosc-lz4', 'blosc-lz4-bitshuffle', 'blosc-zlib'].filter(codec => samples[codec]).map(codec => [codec, samples[codec]]))));
    result.stores = {};
    for (const [index, store] of stores.entries()) {
      const chunks = storeChunks(store);
      result.stores[path.basename(store)] = await page.evaluate(async payload => {
        const worker = new Worker('/__pool-worker.js', { type: 'module' });
        const answer = new Promise(resolve => { worker.onmessage = event => resolve(event.data); worker.onerror = event => resolve({ error: String(event.message) }); });
        worker.postMessage({ store: payload });
        const value = await answer;
        worker.terminate();
        return value;
      }, { url: `/__store/${index}/`, chunks });
    }
    result.copies = await page.evaluate(() => {
      const source = new Float32Array(16e6);
      for (let i = 0; i < source.length; i++) source[i] = i;
      const target = new Float32Array(source.length);
      let started = performance.now();
      for (let r = 0; r < 5; r++) target.set(source);
      const setMBps = Math.round(5 * source.byteLength / (performance.now() - started) / 1e3);
      started = performance.now();
      for (let r = 0; r < 5; r++) source.slice();
      const sliceMBps = Math.round(5 * source.byteLength / (performance.now() - started) / 1e3);
      return { setMBps, sliceMBps };
    });
    result.transfer = await page.evaluate(async () => {
      const worker = new Worker('/__cpu-worker.js', { type: 'module' });
      const roundTrip = async transfer => {
        const payload = new Float32Array(16e6);
        const started = performance.now();
        const back = new Promise(resolve => { worker.onmessage = event => resolve(event.data); });
        worker.postMessage({ kind: 'echo', payload, transfer }, transfer ? [payload.buffer] : []);
        await back;
        return Math.round((performance.now() - started) * 10) / 10;
      };
      await roundTrip(true);
      const transferredMs = await roundTrip(true);
      const copiedMs = await roundTrip(false);
      worker.terminate();
      return { bytes: 64e6, transferredMs, copiedMs };
    });
    const deflate = samples['deflate-h5py']?.[0];
    if (deflate) {
      result.mainThread = await page.evaluate(async chunk => {
        const bytes = Uint8Array.from(atob(chunk.b64), c => c.charCodeAt(0));
        const worker = new Worker('/__cpu-worker.js', { type: 'module' });
        let longest = 0;
        let last = performance.now();
        let running = true;
        const tick = () => {
          const now = performance.now();
          longest = Math.max(longest, now - last);
          last = now;
          if (running) setTimeout(tick, 0);
        };
        tick();
        const done = new Promise(resolve => { worker.onmessage = event => resolve(event.data); });
        worker.postMessage({ kind: 'spin', chunk: { bytes, decoded: chunk.decoded } });
        const { ms } = await done;
        running = false;
        worker.terminate();
        return { workerDecodeMs: Math.round(ms), longestMainThreadGapMs: Math.round(longest) };
      }, deflate);
    }
  } finally {
    await browser.close();
  }
  return result;
}

await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const results = {};
try {
  const { byCodec, zstdFiles } = corpusSamples();
  const samples = python === null ? byCodec : { ...byCodec, ...encodedSamples(zstdFiles) };
  for (const engine of engines) {
    // An engine that fails is recorded and the next still measured; what is measured is written as it lands.
    try {
      results[engine] = await measure(engine, samples);
    } catch (error) {
      results[engine] = { error: String(error.stack ?? error).slice(0, 800) };
    }
    console.error(`${engine}: done`);
    if (out !== null) writeFileSync(out, JSON.stringify(results, null, 2));
  }
} finally {
  server.close();
}
console.log(JSON.stringify(results, null, 2));
if (out !== null) writeFileSync(out, JSON.stringify(results, null, 2));
