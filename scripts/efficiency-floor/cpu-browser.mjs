/**
 * CPU stages of reading, measured in the browser (Chromium, Playwright), on
 * real chunks of the efficiency-floor corpus: what each stage reaches
 * against the fastest way this browser offers.
 *
 * - Decompression, per codec, in a worker (where the readers decode): the
 *   app's decoder (`inflate`: `DecompressionStream` fed in slices; the
 *   JavaScript Zstandard, Blosc/LZ4 and LZF decoders) against a whole-chunk
 *   `DecompressionStream`, and whether this browser's `DecompressionStream`
 *   takes `zstd` at all.
 * - Typed-array copies: `TypedArray.prototype.set` and `slice` of 64 MB.
 * - Worker transfer: a 64 MB `Float32Array` posted to a worker and back,
 *   transferred against copied (structured clone).
 * - Main-thread blocking: the longest task while a worker decodes 64 MB.
 *
 *   node scripts/efficiency-floor/cpu-browser.mjs CORPUS [--port 4575] [--out cpu.json]
 *
 * Run it alone (`heavy.sh`): it starts a browser.
 */

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { openSync, readFileSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codecOf, loadLayout } from './floor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPOSITORY, 'package.json'));
const { chromium } = require('playwright');

const corpus = path.resolve(process.argv[2]);
const port = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 4575);
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
const manifest = JSON.parse(readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));

/** Up to 24 whole chunks of X's arrays per codec, as stored (ZIP headers removed). */
function samples() {
  const byCodec = {};
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
      const codec = codecOf(array);
      if (codec === 'none') continue;
      byCodec[codec] ??= [];
      const item = array.itemsize ?? (/64/.test(array.dtype) ? 8 : 4);
      const decoded = array.chunks.reduce((a, b) => a * b, 1) * item;
      for (const entry of array.chunkMap.filter(e => e[0][0] + array.chunks[0] <= array.shape[0]).slice(0, 24 - byCodec[codec].length)) {
        const file = layout.kind === 'zarr' ? path.join(corpus, name, entry[3]) : path.join(corpus, name);
        const bytes = Buffer.alloc(entry[2]);
        const fd = openSync(file, 'r');
        readSync(fd, bytes, 0, bytes.length, layout.kind === 'zarr' ? 0 : entry[1]);
        closeSync(fd);
        let start = 0;
        if (layout.kind === 'zarr-zip') start = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
        byCodec[codec].push({ hex: bytes.subarray(start).toString('base64'), decoded, shuffle: (array.filters ?? []).includes('shuffle') });
      }
    }
  }
  return byCodec;
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>cpu</title><script type="module">
window.__ready = true;
</script>`;

const WORKER = `
import { inflate } from '/assets/js/formats/io/inflate.js';
import { lzfDecompress } from '/assets/js/formats/hdf5/lzf.js';
import { bloscDecode } from '/assets/js/formats/zarr/codecs/blosc.js';
import { zstdDecompress } from '/assets/js/formats/zarr/codecs/zstd.js';
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
async function wholeStream(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function rate(chunks, decode) {
  for (const chunk of chunks) await decode(chunk);
  let decoded = 0;
  const started = performance.now();
  for (let round = 0; round < 5; round++) for (const chunk of chunks) { await decode(chunk); decoded += chunk.decoded; }
  return Math.round(decoded / (performance.now() - started) / 1e3);
}
self.onmessage = async ({ data }) => {
  if (data.kind === 'echo') { self.postMessage(data.payload, data.transfer ? [data.payload.buffer] : []); return; }
  if (data.kind === 'spin') {
    // Decode 64 MB of gzip the app's way, to see the page stays free.
    const chunk = data.chunk;
    let decoded = 0;
    const started = performance.now();
    while (decoded < 64e6) { await inflate(chunk.bytes, { format: chunk.format, expectedSize: chunk.decoded }); decoded += chunk.decoded; }
    self.postMessage({ ms: performance.now() - started });
    return;
  }
  const out = {};
  for (const [codec, list] of Object.entries(data.samples)) {
    const chunks = list.map(c => ({ bytes: fromBase64(c.hex), decoded: c.decoded }));
    const format = chunks[0].bytes[0] === 0x1f ? 'gzip' : 'deflate';
    const row = { chunks: chunks.length };
    if (codec === 'gzip') {
      row.appMBps = await rate(chunks, c => inflate(c.bytes, { format, expectedSize: c.decoded }));
      row.wholeStreamMBps = await rate(chunks, c => wholeStream(c.bytes, format));
    } else if (codec === 'zstd') {
      row.appMBps = await rate(chunks, c => zstdDecompress(c.bytes, c.decoded));
      try { await wholeStream(chunks[0].bytes, 'zstd'); row.nativeZstd = true; row.wholeStreamMBps = await rate(chunks, c => wholeStream(c.bytes, 'zstd')); }
      catch (error) { row.nativeZstd = false; row.nativeZstdError = String(error).slice(0, 120); }
    } else if (codec === 'blosc-lz4') {
      row.appMBps = await rate(chunks, c => bloscDecode(c.bytes, c.decoded));
    } else if (codec === 'lzf') {
      row.appMBps = await rate(chunks, c => lzfDecompress(c.bytes, c.decoded));
    }
    out[codec] = row;
  }
  self.postMessage(out);
};`;

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/__cpu.html') {
    response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
    return;
  }
  if (url.pathname === '/__cpu-worker.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(WORKER);
    return;
  }
  const file = path.join(REPOSITORY, decodeURIComponent(url.pathname));
  if (!file.startsWith(REPOSITORY) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const browser = await chromium.launch();
const result = { browser: `chromium ${browser.version()}` };
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/__cpu.html`);
  await page.waitForFunction(() => window.__ready === true);
  const sampled = samples();
  result.decode = await page.evaluate(async payload => {
    const worker = new Worker('/__cpu-worker.js', { type: 'module' });
    const answer = new Promise(resolve => { worker.onmessage = event => resolve(event.data); });
    worker.postMessage({ kind: 'decode', samples: payload });
    const value = await answer;
    worker.terminate();
    return value;
  }, sampled);
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
  const gzip = sampled.gzip?.[0];
  if (gzip) {
    result.mainThread = await page.evaluate(async chunk => {
      const bytes = Uint8Array.from(atob(chunk.hex), c => c.charCodeAt(0));
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
      worker.postMessage({ kind: 'spin', chunk: { bytes, decoded: chunk.decoded, format: bytes[0] === 0x1f ? 'gzip' : 'deflate' } });
      const { ms } = await done;
      running = false;
      worker.terminate();
      return { workerDecodeMs: Math.round(ms), longestMainThreadGapMs: Math.round(longest) };
    }, gzip);
  }
} finally {
  await browser.close();
  server.close();
}
console.log(JSON.stringify(result, null, 2));
if (out !== null) writeFileSync(out, JSON.stringify(result, null, 2));
