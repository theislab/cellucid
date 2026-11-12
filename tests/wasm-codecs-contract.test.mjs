/**
 * The vendored decoders: the WebAssembly module (`assets/wasm/codecs.wasm`,
 * zstd 1.5.6, lz4 1.10.0, c-blosc 1.21.6 built by zig 0.13.0 from their
 * release tarballs, `scripts/build-wasm-codecs.mjs`) and fflate 0.8.2
 * (`assets/external/fflate-0.8.2/`).
 *
 * - Each shipped file is pinned by its SHA-256, licenses included: a change
 *   to any is a deliberate rebuild or re-vendoring that updates this test.
 * - The module imports nothing (no WASI, no JavaScript glue) and exports the
 *   decoders `formats/io/wasm-codecs.js` calls, and workers find it through
 *   `assets/workers/scripts.js` at the version of its bytes.
 * - Where this machine's build cache holds zig and every source tarball
 *   (`node scripts/build-wasm-codecs.mjs` fetched them once), the module is
 *   rebuilt and must come out byte for byte the same; elsewhere that test is
 *   skipped (it never reaches the network).
 * - The decoders decode what the reference encoders write, refuse what does
 *   not fit its declared size, and fflate's inflater gives the platform
 *   stream's bytes and refusals.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { constants, deflateRawSync, deflateSync, gzipSync, zstdCompressSync } from 'node:zlib';

import { LICENSES, LICENSES_DIR, MODULE_PATH, SOURCES, ZIG, ZIG_VERSION } from '../scripts/build-wasm-codecs.mjs';
import { WORKER_ASSETS } from '../scripts/build-worker-bundles.mjs';
import { contentTypeForAssetPath } from '../scripts/generate-web-asset-inventory.mjs';
import { codecsWasm } from '../assets/workers/scripts.js';
import { WasmCodecError, wasmCodecs, zstdStream } from '../assets/js/formats/io/wasm-codecs.js';
import { DECODE_WORKER_BYTES } from '../assets/js/formats/io/decode-pool.js';
import { inflate } from '../assets/js/formats/io/inflate.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const read = relative => readFileSync(path.join(ROOT, ...relative.split('/')));

/** Every shipped file of the vendored decoders, by its SHA-256. */
const PINNED = {
  'assets/wasm/codecs.wasm': 'e19ba7156cb8950ac8fb20452d963b7b7598d34c247fed356137ed71cae1427f',
  'assets/wasm/LICENSES/zstd.txt': '7055266497633c9025b777c78eb7235af13922117480ed5c674677adc381c9d8',
  'assets/wasm/LICENSES/lz4.txt': '8b58c446121a109ccf32edc094bba3010a3d85e4ee3702950db55e4d3e87736c',
  'assets/wasm/LICENSES/c-blosc.txt': '22623131a9b9f6a86a4dc6b9bccbb1d2aeb390df86bca00fc727af24735c2fae',
  'assets/wasm/LICENSES/bitshuffle.txt': 'ef357c2061cf67db298f9f1565572ee229ad9263582a9f9d0ebff5094f5d10ac',
  'assets/wasm/LICENSES/fastlz.txt': 'cf52909e6ed770fe81511ba62d4ebee13185d30a37d0fd7de2b56685e288ab38',
  // fflate 0.8.2 as npm publishes it (fflate-0.8.2.tgz, integrity
  // sha512-cPJU47OaAoCbg0pBvzsgpTPhmhqI5eJjh/JIu8tPj5q+T7iLvW/JAYUqmE7KOB4R1ZyEhzBaIQpQpardBF5z8A==):
  // `package/esm/browser.js` and `package/LICENSE`, unchanged.
  'assets/external/fflate-0.8.2/browser.js': '8cc1f687e0159e977addb6b85e274dbd11e622cf151f4fcb7b85d49622ea43e7',
  'assets/external/fflate-0.8.2/LICENSE.txt': '805f6cb28bb8b6d3a0badd83c93bccd9671fa01a3b4b92b7042b0743325ac243',
};

test('every vendored decoder file is the pinned one, with its licence beside it', () => {
  for (const [file, digest] of Object.entries(PINNED)) {
    assert.ok(existsSync(path.join(ROOT, ...file.split('/'))), `${file} is shipped`);
    assert.equal(sha256(read(file)), digest, file);
  }
  // The licenses are the ones the build copies from the pinned sources.
  assert.deepEqual(
    LICENSES.map(({ name }) => `${LICENSES_DIR}/${name}`).sort(),
    Object.keys(PINNED).filter(file => file.startsWith(`${LICENSES_DIR}/`)).sort()
  );
  for (const { name } of LICENSES) {
    assert.match(read(`${LICENSES_DIR}/${name}`).toString('utf8'), /Copyright|copyright/, name);
  }
  assert.match(read('assets/external/fflate-0.8.2/LICENSE.txt').toString('utf8'), /^MIT License/);
  // Shipped with the content types the servers send them as.
  assert.equal(contentTypeForAssetPath(MODULE_PATH), 'application/wasm');
  assert.equal(contentTypeForAssetPath(`${LICENSES_DIR}/zstd.txt`), 'text/plain; charset=utf-8');
  const inventory = JSON.parse(read('cellucid-web-assets.json').toString('utf8'));
  for (const file of Object.keys(PINNED)) {
    const listed = inventory.assets.find(asset => asset.path === file);
    if (listed === undefined) continue; // the gate regenerates the inventory
    assert.equal(listed.content_type, contentTypeForAssetPath(file), file);
    assert.equal(listed.sha256, sha256(read(file)), file);
  }
});

test('the sources and the toolchain are pinned to their release pages', () => {
  assert.equal(ZIG_VERSION, '0.13.0');
  for (const { file, sha256: digest } of Object.values(ZIG)) {
    assert.match(file, /^zig-[a-z]+-[a-z0-9_]+-0\.13\.0\.(tar\.xz|zip)$/);
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(SOURCES).map(([name, { version }]) => [name, version])),
    { zstd: '1.5.6', lz4: '1.10.0', 'c-blosc': '1.21.6' });
  for (const { url, sha256: digest } of Object.values(SOURCES)) {
    assert.match(url, /^https:\/\/github\.com\/(facebook\/zstd|lz4\/lz4|Blosc\/c-blosc)\/(releases\/download|archive\/refs\/tags)\//);
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
});

test('the module imports nothing and is found at the version of its bytes', async () => {
  const bytes = read(MODULE_PATH);
  const module = new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.deepEqual(WebAssembly.Module.exports(module).map(entry => entry.name).sort(), [
    'codecs_bitshuffle_chunk', 'codecs_bitshuffle_untranspose', 'codecs_blosc', 'codecs_blosc_unshuffle',
    'codecs_blosc_zlib_record', 'codecs_blosc_zlib_streams', 'codecs_buffers', 'codecs_lz4_block', 'codecs_output',
    'codecs_zstd', 'codecs_zstd_content_size', 'codecs_zstd_stream_begin', 'codecs_zstd_stream_consumed',
    'codecs_zstd_stream_ended', 'codecs_zstd_stream_input', 'codecs_zstd_stream_input_size', 'codecs_zstd_stream_output',
    'codecs_zstd_stream_output_size', 'codecs_zstd_stream_step', 'memory',
  ]);
  assert.deepEqual(WORKER_ASSETS.map(({ path: file }) => file), [MODULE_PATH]);
  const url = codecsWasm();
  assert.equal(fileURLToPath(url), path.join(ROOT, ...MODULE_PATH.split('/')));
  assert.equal(url.search, `?v=${sha256(bytes).slice(0, 12)}`);
});

test('the module is what the pinned zig and sources build (where the build cache holds them)', t => {
  const cache = path.join(ROOT, 'node_modules', '.cache', 'wasm-codecs');
  const host = ZIG[`${process.platform}-${process.arch}`];
  const inputs = [host, ...Object.values(SOURCES)].filter(Boolean)
    .map(input => path.join(cache, 'downloads', `${input.sha256.slice(0, 12)}-${(input.url ?? input.file).split('/').at(-1)}`));
  if (host === undefined || !inputs.every(existsSync)) {
    t.skip('zig 0.13.0 and the source tarballs are not in node_modules/.cache/wasm-codecs (node scripts/build-wasm-codecs.mjs fetches them)');
    return;
  }
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-wasm-codecs.mjs'), '--check', '--offline'], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /as built/);
});

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

/** Sparse-matrix-like values: mostly small integers stored as float32. */
function values(count, seed) {
  const next = random(seed);
  return new Uint8Array(new Float32Array(Array.from({ length: count }, () => (next() < 0.6 ? 0 : Math.round(next() * 30)))).buffer);
}

test('an instance that grew past a decode worker\'s budget is let go, and the next call makes a new one', async () => {
  const codecs = await wasmCodecs();
  const big = new Uint8Array(DECODE_WORKER_BYTES + 1024 * 1024);
  const frame = new Uint8Array(zstdCompressSync(big));
  assert.equal(codecs.zstd(frame, big.length).length, big.length);
  const next = await wasmCodecs();
  assert.notEqual(next, codecs, 'a new instance, its memory small again');
  assert.ok(next.exports.memory.buffer.byteLength < DECODE_WORKER_BYTES);
  const small = values(4096, 1);
  assert.deepEqual(next.zstd(new Uint8Array(zstdCompressSync(small)), small.length), small);
});

/** bitshuffle's bit transpose (`bshuf_trans_bit_elem`), written out: row r = bit r % 8 of byte r / 8 of each element. */
function bitTranspose(input, count, typesize) {
  const out = new Uint8Array(count * typesize);
  const rowBytes = count / 8;
  for (let element = 0; element < count; element++) {
    for (let byte = 0; byte < typesize; byte++) {
      const value = input[element * typesize + byte];
      for (let bit = 0; bit < 8; bit++) {
        if ((value >> bit) & 1) out[(byte * 8 + bit) * rowBytes + (element >> 3)] |= 1 << (element & 7);
      }
    }
  }
  return out;
}

test('bitshuffle\'s inverse transpose (the HDF5 bitshuffle filter\'s) undoes the transpose', async () => {
  const codecs = await wasmCodecs();
  for (const typesize of [1, 2, 4, 8, 3]) {
    for (const count of [8, 64, 1000, 4096]) {
      const data = values(Math.ceil((count * typesize) / 4) + 1, count + typesize).subarray(0, count * typesize);
      assert.deepEqual(codecs.bitshuffleUntranspose(bitTranspose(data, count, typesize), count, typesize), data, `${count} x ${typesize}`);
    }
  }
  assert.throws(() => codecs.bitshuffleUntranspose(new Uint8Array(12), 3, 4), WasmCodecError);
});

const DEFLATE_FORMATS = [['deflate', deflateSync], ['gzip', gzipSync], ['deflate-raw', deflateRawSync]];
/** A decoder choice naming fflate for every size class of DEFLATE. */
function fflateChoices(size) {
  return { [`deflate:${Math.floor(Math.log2(Math.max(1, size)))}`]: 'fflate' };
}

test('fflate inflates every DEFLATE format to the platform stream\'s bytes', async () => {
  for (const [format, compress] of DEFLATE_FORMATS) {
    for (const [count, seed] of [[1, 1], [9000, 2], [70_000, 3]]) {
      const data = values(count, seed);
      for (const level of [0, 1, 6, 9]) {
        const stream = new Uint8Array(compress(data, { level }));
        const native = await inflate(stream, { format, expectedSize: data.length });
        const whole = await inflate(stream, { format, expectedSize: data.length, choices: fflateChoices(data.length) });
        assert.deepEqual(whole, native, `${format} level ${level}, ${data.length} bytes`);
        assert.deepEqual(whole, data);
      }
    }
  }
});

test('fflate refuses what the platform stream refuses: a stream past or short of its size, a broken checksum', async () => {
  const data = values(20_000, 7);
  for (const [format, compress] of DEFLATE_FORMATS) {
    const stream = new Uint8Array(compress(data));
    const fflate = size => ({ format, expectedSize: size, choices: fflateChoices(size) });
    await assert.rejects(inflate(stream, fflate(data.length - 1)), /more than the/);
    await assert.rejects(inflate(stream, fflate(data.length + 1)), /not the/);
    await assert.rejects(inflate(stream.subarray(0, stream.length - 9), fflate(data.length)), { name: 'InflateError' });
    if (format === 'deflate-raw') continue;
    // The trailer: zlib's Adler-32, gzip's CRC-32.
    const damaged = stream.slice();
    damaged[damaged.length - (format === 'gzip' ? 6 : 1)] ^= 0x40;
    await assert.rejects(inflate(damaged, fflate(data.length)), /checksum|corrupt/);
    await assert.rejects(inflate(damaged, { format, expectedSize: data.length }), { name: 'InflateError' });
  }
  // A DEFLATE bomb stops at its declared size plus one byte.
  const bomb = new Uint8Array(deflateSync(new Uint8Array(32 * 1024 * 1024)));
  await assert.rejects(inflate(bomb, { format: 'deflate', expectedSize: 1024, choices: fflateChoices(1024) }), /more than the/);
});

test('Zstandard through the module: frames of every level, several frames, and a stated size the bound refuses', async () => {
  const codecs = await wasmCodecs();
  const data = values(50_000, 11);
  for (const level of [1, 3, 19]) {
    const frame = new Uint8Array(zstdCompressSync(data, { params: { [constants.ZSTD_c_compressionLevel]: level } }));
    assert.deepEqual(codecs.zstd(frame, data.length), data);
    assert.deepEqual(codecs.zstd(frame, null), data);
    assert.throws(() => codecs.zstd(frame, null, data.length - 1), /more than/);
  }
});

test('a Zstandard stream decodes piece by piece, frame after frame, and refuses one cut inside a frame', async () => {
  const data = values(800_000, 13);
  const half = data.length / 2;
  const frames = new Uint8Array([...zstdCompressSync(data.subarray(0, half)), ...zstdCompressSync(data.subarray(half), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })]);
  for (const piece of [1, 977, 65_536, frames.length]) {
    const stream = await zstdStream();
    const out = [];
    for (let at = 0; at < frames.length; at += piece) out.push(...stream.push(frames.subarray(at, at + piece)));
    stream.end();
    assert.deepEqual(new Uint8Array(Buffer.concat(out)), data, `pieces of ${piece}`);
  }
  const cut = await zstdStream();
  [...cut.push(frames.subarray(0, frames.length - 7))];
  assert.throws(() => cut.end(), /truncated/);
  const damaged = frames.slice();
  damaged[damaged.length - 2] ^= 0xff;
  const wrong = await zstdStream();
  assert.throws(() => [...wrong.push(damaged)], WasmCodecError);
});

test('a browser that does not run WebAssembly is told so, with what to do, when data needs the decoders', async () => {
  const real = globalThis.WebAssembly;
  // A module instance of its own: nothing compiled yet.
  const fresh = await import('../assets/js/formats/io/wasm-codecs.js?without-webassembly');
  globalThis.WebAssembly = {};
  try {
    await assert.rejects(fresh.wasmCodecs(), /does not run WebAssembly here \(Lockdown Mode[^)]*\)\. Allow WebAssembly for this site/);
  } finally {
    globalThis.WebAssembly = real;
  }
});

test('the JavaScript candidates give the WebAssembly reference\'s bytes on every Zstandard, LZ4 and Blosc chunk of the corpora', async () => {
  const { corpusEntries } = await import('./helpers/zarr-corpus.mjs');
  const { zstdDecompress } = await import('../assets/js/formats/zarr/codecs/zstd.js');
  const { numcodecsLz4Decode } = await import('../assets/js/formats/zarr/codecs/lz4.js');
  const { bloscDecode } = await import('../assets/js/formats/zarr/codecs/blosc.js');
  const decoders = {
    zstd: (bytes, decoder) => zstdDecompress(bytes, null, { choices: { 'zstd:0': decoder } }),
    lz4: (bytes, decoder) => numcodecsLz4Decode(bytes, null, { 'lz4:0': decoder }),
    blosc: (bytes, decoder) => bloscDecode(bytes, new DataView(bytes.buffer, bytes.byteOffset, 16).getUint32(4, true), { 'blosc:0': decoder }),
  };
  let compared = 0;
  for (const store of ['v2/cases.zarr', 'v2/blosc-delta.zarr']) {
    const entries = await corpusEntries(store);
    for (const [key, bytes] of entries) {
      const folder = key.split('/').slice(0, -1).join('/');
      if (key.split('/').at(-1).startsWith('.') || !entries.has(`${folder}/.zarray`)) continue;
      const id = JSON.parse(new TextDecoder().decode(entries.get(`${folder}/.zarray`))).compressor?.id;
      if (decoders[id] === undefined) continue;
      assert.deepEqual(await decoders[id](bytes, 'js'), await decoders[id](bytes, 'wasm'), key);
      compared++;
    }
  }
  assert.ok(compared >= 10, `${compared} chunks compared`);
  // Frames Node's zstd writes, every level.
  for (const level of [1, 9, 19]) {
    const data = values(30_000, level);
    const frame = new Uint8Array(zstdCompressSync(data, { params: { [constants.ZSTD_c_compressionLevel]: level } }));
    assert.deepEqual(await decoders.zstd(frame, 'js'), await decoders.zstd(frame, 'wasm'));
  }
});
