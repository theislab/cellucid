/**
 * Decoding throughput of each codec in this runtime, on real chunks of the
 * corpus: the app's decoder (the one the readers call) against the fastest
 * native decoder Node has for the codec (zlib for DEFLATE and gzip, zlib's
 * Zstandard), and, with `--python`, the C libraries next to the data
 * (numcodecs: Blosc, Zstd, GZip, Zlib) as the machine's reference. Also the
 * page-cache read rate of a local file through `Blob` slices. Writes
 * `codecs.json` in the corpus; the floor decodes at the best rate this
 * runtime offers for each codec (`runtime.decodeBytesPerMs`).
 *
 *   node scripts/efficiency-floor/codecs.mjs CORPUS [--python /path/to/python]
 *
 * @module scripts/efficiency-floor/codecs
 */

import { execFileSync } from 'node:child_process';
import { openAsBlob, openSync, readSync, readFileSync, writeFileSync, closeSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { codecOf, loadLayout } from './floor.mjs';
import { inflate } from '../../assets/js/formats/io/inflate.js';
import { lzfDecompress } from '../../assets/js/formats/hdf5/lzf.js';
import { bloscDecode } from '../../assets/js/formats/zarr/codecs/blosc.js';
import { zstdDecompress } from '../../assets/js/formats/zarr/codecs/zstd.js';

const corpus = path.resolve(process.argv[2]);
const pythonIndex = process.argv.indexOf('--python');
const python = pythonIndex === -1 ? null : process.argv[pythonIndex + 1];
const manifest = JSON.parse(readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));

/** Up to `count` whole chunks of large numeric arrays stored with `codec`. */
function samples(codec, count = 24) {
  const out = [];
  for (const name of Object.keys(manifest.files)) {
    let layout;
    try {
      layout = loadLayout(corpus, name);
    } catch {
      continue;
    }
    for (const arrayPath of ['/X/data', '/X/indices', '/obsm/X_pca']) {
      const array = layout.arrays[arrayPath];
      if (!array || array.layout !== 'chunked' || codecOf(array) !== codec) continue;
      const item = array.itemsize ?? (/64/.test(array.dtype) ? 8 : 4);
      const decoded = array.chunks.reduce((a, b) => a * b, 1) * item;
      const full = array.chunkMap.filter(entry => entry[0].every((offset, axis) => offset + array.chunks[axis] <= array.shape[axis]));
      for (const entry of full.slice(0, count - out.length)) {
        const file = layout.kind === 'zarr' ? path.join(corpus, name, entry[3]) : path.join(corpus, name);
        const start = layout.kind === 'zarr' ? 0 : entry[1];
        const bytes = new Uint8Array(entry[2]);
        const fd = openSync(file, 'r');
        readSync(fd, bytes, 0, bytes.length, start);
        closeSync(fd);
        // A ZIP entry's local header comes first.
        if (layout.kind === 'zarr-zip') {
          const view = new DataView(bytes.buffer);
          const skip = 30 + view.getUint16(26, true) + view.getUint16(28, true);
          out.push({ bytes: bytes.subarray(skip), decoded, shuffle: (array.filters ?? []).includes('shuffle'), item });
        } else out.push({ bytes, decoded, shuffle: (array.filters ?? []).includes('shuffle'), item });
      }
      if (out.length >= count) return out;
    }
  }
  return out;
}

async function rate(chunks, decode, rounds = 5) {
  let decoded = 0;
  for (const chunk of chunks) await decode(chunk); // warm
  const started = performance.now();
  for (let round = 0; round < rounds; round++) {
    for (const chunk of chunks) {
      await decode(chunk);
      decoded += chunk.decoded;
    }
  }
  return decoded / (performance.now() - started);
}

const results = {};
const decoders = {
  gzip: {
    app: chunk => inflate(chunk.bytes, { format: chunk.bytes[0] === 0x1f ? 'gzip' : 'deflate', expectedSize: chunk.decoded }),
    nodeNative: chunk => (chunk.bytes[0] === 0x1f ? zlib.gunzipSync(chunk.bytes) : zlib.inflateSync(chunk.bytes)),
  },
  zstd: {
    app: chunk => zstdDecompress(chunk.bytes, chunk.decoded),
    nodeNative: typeof zlib.zstdDecompressSync === 'function' ? chunk => zlib.zstdDecompressSync(chunk.bytes) : null,
  },
  'blosc-lz4': { app: chunk => bloscDecode(chunk.bytes, chunk.decoded), nodeNative: null },
  lzf: { app: chunk => lzfDecompress(chunk.bytes, chunk.decoded), nodeNative: null },
};
for (const [codec, { app, nodeNative }] of Object.entries(decoders)) {
  const chunks = samples(codec);
  if (chunks.length === 0) continue;
  const stored = chunks.reduce((sum, chunk) => sum + chunk.bytes.length, 0);
  const decoded = chunks.reduce((sum, chunk) => sum + chunk.decoded, 0);
  results[codec] = {
    chunks: chunks.length,
    meanChunkDecodedKB: Math.round(decoded / chunks.length / 1024),
    ratio: Math.round((decoded / stored) * 100) / 100,
    appMBps: Math.round(await rate(chunks, app)) / 1e3,
    nodeNativeMBps: nodeNative === null ? null : Math.round(await rate(chunks, nodeNative)) / 1e3,
  };
}

// The C libraries next to the data, on the same chunks (numcodecs).
if (python !== null) {
  const script = `
import json, sys, time, numcodecs, zlib
chunks = json.load(sys.stdin)
out = {}
for codec, files in chunks.items():
    data = [bytes.fromhex(h) for h in files]
    dec = {"gzip": lambda b: zlib.decompress(b, 47), "zstd": numcodecs.Zstd().decode, "blosc-lz4": numcodecs.Blosc().decode}.get(codec)
    if dec is None: continue
    for b in data: dec(b)
    t = time.perf_counter(); total = 0
    for _ in range(5):
        for b in data: total += len(dec(b))
    out[codec] = total / (time.perf_counter() - t) / 1e6
print(json.dumps(out))`;
  const input = {};
  for (const codec of ['gzip', 'zstd', 'blosc-lz4']) input[codec] = samples(codec, 12).map(chunk => Buffer.from(chunk.bytes).toString('hex'));
  const native = JSON.parse(execFileSync(python, ['-I', '-c', script], { input: JSON.stringify(input), maxBuffer: 1 << 28 }).toString());
  for (const [codec, mbps] of Object.entries(native)) if (results[codec]) results[codec].cMBps = Math.round(mbps);
}

// The page cache through Blob slices, as a picked file is read.
let diskBytesPerMs;
{
  const biggest = Object.entries(manifest.files).filter(([name]) => !name.endsWith('.zarr') && !name.endsWith('-mtx')).sort((a, b) => b[1].bytes - a[1].bytes)[0][0];
  const blob = await openAsBlob(path.join(corpus, biggest));
  await blob.arrayBuffer();
  const started = performance.now();
  let total = 0;
  for (let at = 0; at < blob.size; at += 1 << 20) total += (await blob.slice(at, at + (1 << 20)).arrayBuffer()).byteLength;
  diskBytesPerMs = total / (performance.now() - started);
}

const decodeBytesPerMs = {};
for (const [codec, result] of Object.entries(results)) {
  decodeBytesPerMs[codec] = Math.max(result.appMBps, result.nodeNativeMBps ?? 0) * 1e3;
}
const output = { runtime: { name: `node ${process.version}`, decodeBytesPerMs, diskBytesPerMs }, codecs: results };
writeFileSync(path.join(corpus, 'codecs.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
