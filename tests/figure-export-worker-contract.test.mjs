/**
 * Figure export keeps every per-cell pass and every encode off the page's
 * main thread (`utils/figure-export-worker.js`) -- the point passes too,
 * wherever a worker can create a WebGL2 context -- writes vector markup as Blob
 * parts rather than one string, checksums with the shared slicing CRC, and
 * honours a requested depth sort at every point count.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createFigureExportZip } from '../assets/js/app/ui/modules/figure-export/utils/zip-archive.js';
import { embedPngTextChunks } from '../assets/js/app/ui/modules/figure-export/utils/png-metadata.js';
import { forEachProjectedPoint } from '../assets/js/app/ui/modules/figure-export/utils/point-projector.js';
import { computeVisibleCameraBounds } from '../assets/js/app/ui/modules/figure-export/utils/coordinate-mapper.js';
import { writeSvgPointMarkup } from '../assets/js/app/ui/modules/figure-export/renderers/svg-point-markup.js';
import {
  figureExportRasterizesOnPage,
  openFigureExportWorkerSession,
  requestVisibleBounds,
} from '../assets/js/app/ui/modules/figure-export/utils/figure-export-worker-client.js';
import { createInProcessFigureExportWorker } from './helpers/figure-export-worker-in-process.mjs';
import { setFigureExportWorkerFactory } from '../assets/js/app/ui/modules/figure-export/utils/figure-export-worker-client.js';

const figureExportRoot = new URL('../assets/js/app/ui/modules/figure-export/', import.meta.url);
const source = path => readFile(new URL(path, figureExportRoot), 'utf8');

const IDENTITY = Float32Array.from([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

/** CRC-32 one byte at a time: the reference the fast checksum must equal. */
function referenceCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pseudoRandomBytes(length, seed) {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = state >>> 24;
  }
  return bytes;
}

test('the renderers run no per-cell pass and no encode on the page', async () => {
  const [png, svg] = await Promise.all([
    source('renderers/png-renderer.js'),
    source('renderers/svg-renderer.js'),
  ]);
  for (const [name, text] of [['png-renderer', png], ['svg-renderer', svg]]) {
    for (const module of [
      'coordinate-mapper.js',
      'point-projector.js',
      'density-reducer.js',
      'webgl-point-rasterizer.js',
      'png-metadata.js',
      'svg-point-markup.js',
    ]) {
      assert.doesNotMatch(text, new RegExp(`from '[^']*${module.replace('.', '\\.')}'`), `${name} imports ${module}`);
    }
    assert.doesNotMatch(text, /\.toBlob\(|\.toDataURL\(|parts\.join\(/, name);
    assert.match(text, /openFigureExportWorkerSession\(\{ signal \}\)/, name);
    assert.match(text, /\}\s*finally\s*\{[^}]*session\.close\(\);/, name);
  }
});

test('the PNG figure is composed in one task, after every worker answer', async () => {
  const png = await source('renderers/png-renderer.js');
  const start = png.indexOf('// ── The composition: one synchronous run of canvas commands.');
  const end = png.indexOf('const frame = await createImageBitmap(canvas);');
  assert.ok(start > 0 && end > start);
  // A composition split across tasks is flushed in pieces, and the browser
  // rasterizes antialiased rules differently in pieces (measured on Suo:
  // ~1,400 pixels of the reference grid differed by up to 21 levels).
  assert.doesNotMatch(png.slice(start, end), /\bawait\b/);
  const prepare = png.slice(png.indexOf('async function preparePanel('), start);
  assert.doesNotMatch(prepare, /ctx\.(fill|stroke|draw|clip|beginPath|rect)\w*\(/);
});

test('the worker module is the one place the rasterizer and encoders run', async () => {
  const worker = await source('utils/figure-export-worker.js');
  assert.match(worker, /from '\.\/webgl-point-rasterizer\.js'/);
  assert.match(worker, /from '\.\/png-metadata\.js'/);
  assert.match(worker, /from '\.\.\/renderers\/svg-point-markup\.js'/);
  assert.match(worker, /convertToBlob\(\{ type: 'image\/png' \}\)/);
  const client = await source('utils/figure-export-worker-client.js');
  assert.match(client, /new URL\('\.\/figure-export-worker\.js', import\.meta\.url\)/);
  assert.match(client, /\{ type: 'module' \}/);
  // The page loads the handler only where a worker cannot draw.
  assert.match(client, /await import\('\.\/figure-export-worker\.js'\)/);
  assert.doesNotMatch(client, /^import [^;]*figure-export-worker\.js'/m);
});

/** A worker that answers `webgl2` with `drawing` and records every request. */
function answeringWorker(drawing) {
  const worker = {
    onmessage: null,
    requests: [],
    postMessage(message) {
      worker.requests.push(message);
      if (message.op === 'close') return;
      const result = message.op === 'webgl2' ? drawing : 4;
      queueMicrotask(() => worker.onmessage?.({ data: { id: message.id, result } }));
    },
    terminate() {},
  };
  return worker;
}

test('the worker is asked once whether it can draw, and a worker that can draws every point pass', async () => {
  const worker = answeringWorker(true);
  setFigureExportWorkerFactory(() => worker);
  try {
    assert.equal(figureExportRasterizesOnPage(), null, 'nothing is assumed before the worker answers');
    const first = openFigureExportWorkerSession();
    assert.equal(await first.request('spriteZoomLimit', {}), 4);
    first.close();
    const second = openFigureExportWorkerSession();
    assert.equal(await second.request('spriteZoomLimit', {}), 4);
    second.close();
    assert.deepEqual(
      worker.requests.filter(message => message.op !== 'close').map(message => message.op),
      ['webgl2', 'spriteZoomLimit', 'spriteZoomLimit'],
    );
    assert.equal(figureExportRasterizesOnPage(), false);
  } finally {
    setFigureExportWorkerFactory(null);
  }
});

test('where the worker cannot draw, the point passes run on the page and everything else stays in the worker', async () => {
  // Node has no OffscreenCanvas: the in-process worker answers `webgl2` with
  // false, as a WebKitGTK or WPE worker does.
  const worker = createInProcessFigureExportWorker();
  setFigureExportWorkerFactory(() => worker);
  try {
    const positions = Float32Array.from([0, 0, 0, 0.5, 0.5, 0.5]);
    const session = openFigureExportWorkerSession();
    await requestVisibleBounds(session, {
      camera: true,
      positions,
      dimension: 3,
      transparency: null,
      lodMembership: null,
      renderState: { mvpMatrix: IDENTITY, viewMatrix: IDENTITY, viewportWidth: 10, viewportHeight: 10 },
      crop: null,
      normTransform: null,
    });
    // The page's pass reports the page's own validation, as the worker would.
    await assert.rejects(
      session.request('rasterizePoints', {
        positions: session.share(positions),
        dimension: 4,
        colors: Uint8Array.from([255, 255, 255, 255]),
        renderState: {},
        outputWidthPx: 4,
        outputHeightPx: 4,
        pointSizePx: 1,
        lodMembership: null,
      }),
      error => error instanceof RangeError && /dimension must be exactly 1, 2, or 3/.test(error.message)
    );
    session.close();
    assert.equal(figureExportRasterizesOnPage(), true);
    assert.deepEqual(
      worker.requests.map(message => message.op ?? null),
      ['visibleBounds', 'webgl2', 'close'],
      'the worker never receives a point pass',
    );
    assert.equal(worker.requests[0].uploads.length, 1, 'the positions travel to the worker once');
  } finally {
    setFigureExportWorkerFactory(null);
  }
});

test('PNG chunks and ZIP entries use the shared slicing CRC', async () => {
  for (const file of ['utils/png-metadata.js', 'utils/zip-archive.js']) {
    const text = await source(file);
    assert.match(text, /import \{ crc32 \} from '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/formats\/zip\/crc32\.js';/, file);
    assert.doesNotMatch(text, /crcTable|getCrcTable/, file);
  }
});

test('a ZIP entry checksummed slice by slice carries the CRC of its whole bytes', async () => {
  // Larger than one checksum slice and not a multiple of it, at an odd size.
  const big = pseudoRandomBytes(9 * 1024 * 1024 + 7, 17);
  const small = pseudoRandomBytes(1001, 3);
  const zip = await createFigureExportZip([
    { filename: 'big.svg', blob: new Blob([big]) },
    { filename: 'small.png', blob: new Blob([small]) },
  ]);
  const bytes = Buffer.from(await zip.arrayBuffer());
  const bigCrc = bytes.readUInt32LE(14);
  assert.equal(bigCrc, referenceCrc32(big));
  const secondHeader = 30 + 'big.svg'.length + big.length;
  assert.equal(bytes.readUInt32LE(secondHeader), 0x04034b50);
  assert.equal(bytes.readUInt32LE(secondHeader + 14), referenceCrc32(small));
  assert.deepEqual(
    bytes.subarray(30 + 'big.svg'.length, secondHeader),
    Buffer.from(big),
    'the entry bytes are stored exactly'
  );
});

test('PNG text chunks are checksummed exactly', async () => {
  const onePixelPng = new Blob([
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    ),
  ], { type: 'image/png' });
  const annotated = Buffer.from(await (await embedPngTextChunks(onePixelPng, {
    Comment: 'hücre',
  })).arrayBuffer());
  const at = annotated.indexOf(Buffer.from('iTXt'));
  const length = annotated.readUInt32BE(at - 4);
  const stored = annotated.readUInt32BE(at + 4 + length);
  assert.equal(stored, referenceCrc32(annotated.subarray(at, at + 4 + length)));
});

test('a requested depth sort is honoured above 200,000 points', () => {
  const n = 200_003;
  const positions = new Float32Array(n * 3);
  const colors = new Uint8Array(n * 4).fill(255);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = ((i * 7919) % 1000) / 1000 - 0.5;
    positions[i * 3 + 1] = ((i * 104729) % 1000) / 1000 - 0.5;
    positions[i * 3 + 2] = ((i * 15485863) % 997) / 997 - 0.5;
  }
  const depths = [];
  const result = forEachProjectedPoint({
    positions,
    dimension: 3,
    colors,
    renderState: { mvpMatrix: IDENTITY, viewportWidth: 100, viewportHeight: 100 },
    plotRect: { x: 0, y: 0, width: 100, height: 100 },
    sortByDepth: true,
    onPoint: (_x, _y, _r, _g, _b, _a, _radius, index) => depths.push(positions[index * 3 + 2]),
  });
  assert.equal(result.drawn, n);
  // Back to front: depth bins never increase along the drawing order.
  const bin = z => Math.min(255, Math.floor(((z + 1) / 2) * 256));
  for (let i = 1; i < depths.length; i++) {
    assert.ok(bin(depths[i]) <= bin(depths[i - 1]), `point ${i} drawn out of depth order`);
  }
});

test('vector point markup leaves as Blob parts with the bytes of one string', async () => {
  const n = 40_000;
  const positions = new Float32Array(n * 2);
  const colors = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    positions[i * 2] = ((i * 7919) % 2000) / 1000 - 1;
    positions[i * 2 + 1] = ((i * 104729) % 2000) / 1000 - 1;
    colors.set([i % 256, (i * 3) % 256, (i * 7) % 256, 255], i * 4);
  }
  const renderState = {
    mvpMatrix: IDENTITY,
    viewMatrix: IDENTITY,
    modelMatrix: IDENTITY,
    viewportWidth: 400,
    viewportHeight: 300,
    shaderQuality: 'ultralight',
    fogDensity: 0,
    fogNear: 0,
    fogFar: 1,
    fogColor: Float32Array.from([1, 1, 1]),
  };
  const plotRect = { x: 10, y: 20, width: 400, height: 300 };
  const blob = writeSvgPointMarkup({
    strategy: 'full-vector',
    positions,
    dimension: 2,
    colors,
    transparency: null,
    lodMembership: null,
    drawOrder: null,
    renderState,
    fogRenderState: renderState,
    highlightArray: null,
    emphasizeSelection: false,
    selectionMutedOpacity: 0.15,
    plotRect,
    crop: null,
    pointRadiusViewportPx: 1.5,
    radiusPx: 1.5,
    sortByDepth: false,
  });
  // The expected markup, written the way the renderer wrote it as one string.
  const expected = [];
  forEachProjectedPoint({
    positions,
    dimension: 2,
    colors,
    renderState,
    plotRect,
    radiusPx: 1.5,
    onPoint: (x, y, r, g, b, _a, radius) => {
      expected.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="rgb(${r},${g},${b})"/>`);
    },
  });
  assert.ok(expected.join('').length > 1024 * 1024, 'the fixture spans several markup pieces');
  assert.equal(await blob.text(), expected.join(''));
});

test('a session sends each typed array to the worker once', async () => {
  const worker = createInProcessFigureExportWorker();
  setFigureExportWorkerFactory(() => worker);
  try {
    const positions = Float32Array.from([0, 0, 0, 0.5, 0.5, 0.5, -0.25, 0.1, -0.5]);
    const transparency = Uint8Array.from([1, 1, 0]);
    const renderState = {
      mvpMatrix: IDENTITY,
      viewMatrix: IDENTITY,
      viewportWidth: 100,
      viewportHeight: 100,
    };
    const session = openFigureExportWorkerSession();
    const options = {
      camera: true,
      positions,
      dimension: 3,
      transparency,
      lodMembership: null,
      renderState,
      crop: null,
      normTransform: null,
    };
    const first = await requestVisibleBounds(session, options);
    const second = await requestVisibleBounds(session, options);
    session.close();
    const direct = computeVisibleCameraBounds({
      positions,
      dimension: 3,
      transparency,
      mvpMatrix: IDENTITY,
      viewMatrix: IDENTITY,
      viewportWidth: 100,
      viewportHeight: 100,
    });
    assert.deepEqual(first, direct);
    assert.deepEqual(second, direct);
    const [a, b, close] = worker.requests;
    assert.equal(a.uploads.length, 2, 'positions and transparency travel with the first request');
    assert.equal(b.uploads.length, 0, 'the second request names them by id');
    assert.deepEqual(b.args.positions, a.args.positions);
    assert.deepEqual(close, { op: 'close', session: a.session });
  } finally {
    setFigureExportWorkerFactory(null);
  }
});

test('a worker error keeps its class and message', async () => {
  const worker = createInProcessFigureExportWorker();
  setFigureExportWorkerFactory(() => worker);
  try {
    const session = openFigureExportWorkerSession();
    await assert.rejects(
      session.request('rasterizePoints', {
        positions: Float32Array.from([0, 0, 0]),
        dimension: 4,
        colors: Uint8Array.from([255, 255, 255, 255]),
        renderState: {},
        outputWidthPx: 4,
        outputHeightPx: 4,
        pointSizePx: 1,
        lodMembership: null,
      }),
      error => error instanceof RangeError && /dimension must be exactly 1, 2, or 3/.test(error.message)
    );
    session.close();
  } finally {
    setFigureExportWorkerFactory(null);
  }
});
