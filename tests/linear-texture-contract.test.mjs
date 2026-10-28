/**
 * Linear textures hold one texel per item at any count an engine can
 * allocate: rows of a power-of-two width stacked in as many layers as the
 * count needs. Per-cell textures used to be one 2D texture, which refused
 * everything above MAX_TEXTURE_SIZE^2 items (67.1M where the engine reports
 * 8192, and a 3-D position gather from 22.4M points).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  LINEAR_TEXEL_GLSL,
  linearTexelOf,
  planLinearTexture,
  writeLinearTextureRows,
} from '../assets/js/rendering/linear-texture.js';

/** The GLSL `linearTexel`, transcribed with the same integer operations. */
function glslLinearTexel(index, widthShift, rowsPerLayer) {
  const row = index >> widthShift;
  const layer = Math.trunc(row / rowsPerLayer);
  return [index & ((1 << widthShift) - 1), row - layer * rowsPerLayer, layer];
}

test('the GLSL addressing is the documented shift, mask and one division', () => {
  assert.match(LINEAR_TEXEL_GLSL, /int row = index >> shape\.x;/);
  assert.match(LINEAR_TEXEL_GLSL, /int layer = row \/ shape\.y;/);
  assert.match(
    LINEAR_TEXEL_GLSL,
    /return ivec3\(index & \(\(1 << shape\.x\) - 1\), row - layer \* shape\.y, layer\);/,
  );
  // No GLSL keyword used as an identifier (Firefox rejects \`layout\`).
  const code = LINEAR_TEXEL_GLSL.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\blayout\b/);
});

test('plans are exactly as wide as one row of items or power-of-two wide, layered only when one layer is full, and never refuse below the layer limit', () => {
  const cases = [
    // [items, MAX_TEXTURE_SIZE, expected width, rows, layers]
    [0, 16384, 1, 1, 1],
    [1, 16384, 1, 1, 1],
    // One row is exactly as wide as its items: a first upload covers it all.
    [3, 16384, 3, 1, 1],
    [120, 16384, 120, 1, 1],
    [4097, 8192, 4097, 1, 1],
    [8193, 8192, 8192, 2, 1],
    [10_000_000, 16384, 16384, 611, 1],
    // Firefox (8192): 67,108,864 per layer.
    [67_108_864, 8192, 8192, 8192, 1],
    [67_108_865, 8192, 8192, 8193, 2],
    [100_000_000, 8192, 8192, 12208, 2],
    // A 3-D position gather at 100M points: 300M words.
    [300_000_000, 8192, 8192, 36622, 5],
    [300_000_000, 16384, 16384, 18311, 2],
  ];
  for (const [items, maxSize, width, rows, layers] of cases) {
    const plan = planLinearTexture(items, maxSize, 256);
    assert.equal(plan.width, width, `${items} width`);
    if (plan.rows > 1) assert.equal(2 ** plan.widthShift, plan.width);
    else assert.ok(Math.max(1, items) <= 2 ** plan.widthShift && plan.width === Math.max(1, items));
    assert.equal(plan.rows, rows, `${items} rows`);
    assert.equal(plan.layers, layers, `${items} layers`);
    assert.ok(plan.rowsPerLayer <= maxSize);
    assert.ok(plan.rowsPerLayer * plan.layers >= plan.rows);
    assert.equal(plan.texels, plan.width * plan.rowsPerLayer * plan.layers);
    // Padding is at most one row a layer beyond the rows the items need.
    assert.ok(plan.texels - Math.max(1, items) < plan.width * (plan.layers + 1));
  }
  assert.throws(() => planLinearTexture(17, 4, 1), /17 items need 2 texture layers; this GPU allows 1/);
  assert.throws(() => planLinearTexture(2 ** 31, 16384, 256), /integer index range/);
});

test('every item has its own texel, and the GLSL addressing agrees with the plan', () => {
  for (const [items, maxSize] of [[1, 4], [17, 4], [100, 8], [1000, 16], [5000, 32]]) {
    const plan = planLinearTexture(items, maxSize, 256);
    const seen = new Set();
    for (let index = 0; index < items; index++) {
      const texel = linearTexelOf(plan, index);
      assert.deepEqual(glslLinearTexel(index, plan.widthShift, plan.rowsPerLayer), texel);
      const [x, y, layer] = texel;
      assert.ok(x >= 0 && x < plan.width && y >= 0 && y < plan.rowsPerLayer && layer < plan.layers);
      const key = (layer * plan.rowsPerLayer + y) * plan.width + x;
      assert.ok(!seen.has(key));
      seen.add(key);
    }
  }
  // Exact at indices far beyond float precision.
  const big = planLinearTexture(300_000_000, 8192, 256);
  for (const index of [16_777_217, 67_108_863, 67_108_864, 199_999_999, 299_999_999]) {
    assert.deepEqual(glslLinearTexel(index, big.widthShift, big.rowsPerLayer), linearTexelOf(big, index));
  }
});

function recordingGl(plan) {
  const image = new Uint32Array(plan.texels);
  const calls = [];
  return {
    TEXTURE_2D_ARRAY: 0x8c1a,
    calls,
    image,
    texSubImage3D(target, level, x, y, z, width, height, depth, format, type, data, srcOffset) {
      assert.equal(depth, 1);
      assert.ok(x + width <= plan.width && y + height <= plan.rowsPerLayer && z < plan.layers);
      calls.push({ x, y, z, width, height, srcOffset });
      for (let row = 0; row < height; row++) {
        const from = srcOffset + row * width;
        image.set(data.subarray(from, from + width), ((z * plan.rowsPerLayer) + y + row) * plan.width + x);
      }
    },
  };
}

test('row writes place every item at its texel across layer boundaries, partial last row exact', () => {
  for (const [items, maxSize] of [[17, 4], [61, 4], [1000, 8], [4095, 16]]) {
    const plan = planLinearTexture(items, maxSize, 256);
    const data = Uint32Array.from({ length: items }, (_value, index) => index * 7 + 1);
    const gl = recordingGl(plan);
    writeLinearTextureRows(gl, plan, 0, 0, data, 1);
    for (let index = 0; index < items; index++) {
      const [x, y, layer] = linearTexelOf(plan, index);
      assert.equal(gl.image[(layer * plan.rowsPerLayer + y) * plan.width + x], data[index]);
    }
    // No call crosses a layer, and nothing past the last item is read.
    for (const call of gl.calls) {
      assert.ok(call.srcOffset + call.width * call.height <= items);
    }
    // A row range writes only those rows.
    const partial = recordingGl(plan);
    writeLinearTextureRows(partial, plan, 0, 0, data, 1, 1, 2);
    assert.equal(partial.calls.length, 1);
    assert.equal(partial.calls[0].srcOffset, plan.width);
  }
});

test('every per-cell texture of the point renderer, its permute pass, the velocity overlay and figure export is a linear texture', () => {
  const sources = [
    'assets/js/rendering/high-perf-renderer.js',
    'assets/js/rendering/high-perf/gpu-permute.js',
    'assets/js/rendering/shaders/high-perf-shaders.js',
    // The velocity overlay's per-cell textures (field, positions, visibility,
    // spawn table): linear too, so no MAX_TEXTURE_SIZE^2 cap on cells.
    'assets/js/rendering/overlays/shared/packed-texture.js',
  ].map(path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
  for (const source of sources) {
    assert.doesNotMatch(source, /texStorage2D|texImage2D\(\s*gl\.TEXTURE_2D,\s*0,\s*gl\.(R8|R32UI)/);
    assert.doesNotMatch(source, /usampler2D u_|sampler2D u_alphaTex/);
  }
  assert.doesNotMatch(sources.at(-1), /texImage2D|texSubImage2D|TEXTURE_BINDING_2D\b/);
  const velocity = readFileSync(new URL('../assets/js/rendering/overlays/velocity/velocity-shaders.js', import.meta.url), 'utf8');
  for (const sampler of ['u_velocityTex', 'u_positionTex', 'u_spawnTableTex', 'u_alphaTex']) {
    assert.match(velocity, new RegExp(`sampler2DArray ${sampler};`), sampler);
  }
  assert.doesNotMatch(velocity, /TexWidth|u_spawnTableWidth/);
});

test('a point draw leaves no per-point texture bound, so a texture deleted later is never rebound', async () => {
  // Point draws bind linear (TEXTURE_2D_ARRAY) textures on units 0 and 1. A
  // binding left behind outlives the texture's deletion, and whoever saves
  // and restores bindings around its own pass (the GPU gather) then rebinds a
  // deleted texture: INVALID_OPERATION, which failed a session restore.
  const { restorePointDrawBaseline } = await import(
    '../assets/js/rendering/high-perf/gl-point-draw-state.js'
  );
  const bound = new Map();
  let unit = 0x84c0;
  const gl = {
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE_2D: 0x0de1,
    TEXTURE_2D_ARRAY: 0x8c1a,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    activeTexture(next) { unit = next; },
    bindTexture(target, texture) { bound.set(`${unit}:${target}`, texture); },
    bindVertexArray() {},
    bindBuffer() {},
  };
  bound.set(`${gl.TEXTURE0}:${gl.TEXTURE_2D_ARRAY}`, { alpha: true });
  bound.set(`${gl.TEXTURE1}:${gl.TEXTURE_2D_ARRAY}`, { lodIndex: true });
  restorePointDrawBaseline(gl, false);
  assert.equal(bound.get(`${gl.TEXTURE0}:${gl.TEXTURE_2D_ARRAY}`), null);
  assert.equal(bound.get(`${gl.TEXTURE1}:${gl.TEXTURE_2D_ARRAY}`), null);
});

test('a texture of one row is written whole by its first upload', () => {
  // Firefox clears an image whose first upload covers only part of it.
  for (const items of [1, 3, 120, 1000, 8192]) {
    const plan = planLinearTexture(items, 8192, 256);
    const gl = recordingGl(plan);
    writeLinearTextureRows(gl, plan, 0, 0, new Uint32Array(items), 1);
    assert.equal(gl.calls.length, 1, `${items}`);
    assert.equal(gl.calls[0].width * gl.calls[0].height, plan.texels, `${items}`);
  }
});

test('no point count is refused against a square texture capacity', () => {
  // The only device refusal is the layer capacity of a linear texture.
  const renderer = readFileSync(new URL('../assets/js/rendering/high-perf-renderer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(renderer, /maxTextureSize \* maxTextureSize|alpha-texture capacity/);
  assert.match(renderer, /planLinearTextureFor\(gl, pointCount\);/);
});
