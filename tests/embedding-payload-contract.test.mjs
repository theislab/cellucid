/**
 * Embedding and vector payloads made in the reader worker
 * (`data/embedding-payload.js`): one pass of checks and bounds, one pass of
 * float32 output, the same refusals as the load-time checks, the same
 * coordinates the app has always shown, and the vectors scaled once.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EmbeddingPayloads,
  embeddingPayloadOf,
  vectorPayloadOf,
} from '../assets/js/data/embedding-payload.js';
import {
  EmbeddingLoadError,
  MappingLoadError,
  embeddingLoadDefect,
  valueLoadDefect,
} from '../assets/js/data/data-mapping-candidates.js';
import { normalizePositions } from '../assets/js/rendering/gl-utils.js';
import { readPositionBounds } from '../assets/js/rendering/position-layout.js';

function bits(values) {
  return Array.from(new Uint32Array(values.buffer, values.byteOffset, values.length));
}

/** The format's rule, written out: centred per axis, one 2 / max range scale, float32 once. */
function formatRule(values, width) {
  const mins = new Array(width).fill(Infinity);
  const maxs = new Array(width).fill(-Infinity);
  values.forEach((value, index) => {
    mins[index % width] = Math.min(mins[index % width], value);
    maxs[index % width] = Math.max(maxs[index % width], value);
  });
  const maxRange = Math.max(...mins.map((min, axis) => maxs[axis] - min));
  const centers = mins.map((min, axis) => (min + maxs[axis]) / 2);
  return { positions: Float32Array.from(values, (value, index) => (value - centers[index % width]) * (2 / maxRange)), scale: 2 / maxRange };
}

test('refusals name the first offending cell exactly as the load-time checks do', () => {
  const cases = [
    [[0, 0, Number.NaN, 1], 2],
    [[Number.POSITIVE_INFINITY, 0, 0, 1], 2],
    [[0, 0, 0, Number.NEGATIVE_INFINITY], 2],
    [[1e308, 0, 0, 1], 2],
    [[0, 0, 1e-60, 1], 2],
    [[2, 3, 2, 3], 2],
    [[1, 2, 3], 1],
  ];
  for (const [values, width] of cases) {
    for (const Type of [Float64Array, Float32Array]) {
      const array = Type.from(values);
      if (Type === Float32Array && !values.every(value => Object.is(Math.fround(value), value) || Number.isNaN(value))) continue;
      assert.equal(embeddingPayloadOf(array, width, true).defect, embeddingLoadDefect(array, width), `${values} normalized`);
      assert.equal(embeddingPayloadOf(array, width, false).defect, valueLoadDefect(array, width), `${values} as stored`);
    }
  }
});

test('normalized coordinates follow the format rule bit for bit, with an identity transform and exact bounds', () => {
  const raw = Float64Array.from([0.1, -3, 7.25, 2, -1.5, 9, 4.125, 0.3, 1e-3, -2.5, 6, 6]);
  for (const width of [1, 2, 3]) {
    const payload = embeddingPayloadOf(raw, width, true);
    assert.deepEqual(bits(payload.positions), bits(formatRule(raw, width).positions), `${width}D`);
    assert.deepEqual(payload.transform, { center: [0, 0, 0], scale: 1 });
    assert.deepEqual(payload.bounds, structuredClone(readPositionBounds(new Float32Array(payload.positions), width)));
    // The payload is a fixed point of fitting it to the view.
    assert.deepEqual(normalizePositions(new Float32Array(payload.positions), width), { center: [0, 0, 0], scale: 1 });
  }
});

test('coordinates kept as stored are fitted exactly as the renderer fits any coordinates', () => {
  const raw = Float64Array.from([0.1, -3, 7.25, 2, -1.5, 9, 4.125, 0.3]);
  const payload = embeddingPayloadOf(raw, 2, false);
  const expected = Float32Array.from(raw);
  const transform = normalizePositions(expected, 2);
  assert.deepEqual(bits(payload.positions), bits(expected));
  assert.deepEqual(payload.transform, transform);
  // A constant layout is shown, not refused, at unit range.
  assert.equal(embeddingPayloadOf(Float32Array.from([2, 3, 2, 3]), 2, false).defect, null);
});

test('vectors are scaled once, as the coordinates they move were', () => {
  const embedding = Float64Array.from([0, 0, 4, 2, 2, 1]);
  const raw = Float64Array.from([0.1, 0.2, -0.3, 0.4, 3, -4]);
  const { vectorTransform } = embeddingPayloadOf(embedding, 2, true);
  const scaled = vectorPayloadOf(raw, 2, vectorTransform);
  assert.deepEqual(bits(scaled.vectors), bits(Float32Array.from(raw, value => value * formatRule(embedding, 2).scale)));
  assert.equal(scaled.maxMagnitude, Math.hypot(scaled.vectors[4], scaled.vectors[5]));

  const own = embeddingPayloadOf(embedding, 2, false);
  const stored = vectorPayloadOf(raw, 2, own.vectorTransform);
  assert.deepEqual(bits(stored.vectors), bits(Float32Array.from(raw, value => Math.fround(value) * own.transform.scale)));
});

test('a vector a value cannot be drawn is named before any overflow', () => {
  const transform = { vectorScale: 1e300, roundFirst: false };
  const overflow = vectorPayloadOf(Float64Array.from([1, 2, 0, 0]), 2, transform);
  assert.equal(overflow.overflow, 0);
  const named = vectorPayloadOf(Float64Array.from([1, 2, Number.NaN, 0]), 2, transform);
  assert.equal(named.defect, 'NaN at cell 1');
  assert.equal(named.overflow, null);
});

function payloadsOver(arrays) {
  const reads = [];
  let generation = 0;
  const payloads = new EmbeddingPayloads(async (key, columns) => {
    reads.push(key);
    const { values, width } = arrays[key];
    return Float64Array.from({ length: (values.length / width) * columns.length }, (_, index) =>
      values[Math.floor(index / columns.length) * width + columns[index % columns.length]]);
  }, { cellCount: () => 3, generation: () => generation });
  return { payloads, reads, advance: () => { generation++; } };
}

const ARRAYS = {
  X_umap: { values: [0, 0, 4, 2, 2, 1], width: 2 },
  velocity_umap: { values: [1, 1, 2, 2, 3, 3], width: 2 },
  X_bad: { values: [0, 0, Number.NaN, 1, 1, 1], width: 2 },
};
const UMAP = { key: 'X_umap', columns: [0, 1] };

test('a vector field reuses its embedding\'s transform, and an embedding read for a vector field is handed on', async () => {
  const shown = payloadsOver(ARRAYS);
  await shown.payloads.embedding('X_umap', [0, 1], true);
  await shown.payloads.vectors('velocity_umap', [0, 1], UMAP, true);
  assert.deepEqual(shown.reads, ['X_umap', 'velocity_umap'], 'the embedding is read once');

  const first = payloadsOver(ARRAYS);
  const vectors = await first.payloads.vectors('velocity_umap', [0, 1], UMAP, true);
  const embedding = await first.payloads.embedding('X_umap', [0, 1], true);
  assert.deepEqual([...first.reads].sort(), ['X_umap', 'velocity_umap']);
  assert.deepEqual(Array.from(vectors.vectors), [0.5, 0.5, 1, 1, 1.5, 1.5]);
  assert.deepEqual(Array.from(embedding.positions), [-1, -0.5, 1, 0.5, 0, 0]);

  // A cleared reader forgets the transform: its vectors read the embedding again.
  first.advance();
  await first.payloads.vectors('velocity_umap', [0, 1], UMAP, true);
  assert.equal(first.reads.filter(key => key === 'X_umap').length, 2);
});

test('refusals arrive as the errors the adapter passes on', async () => {
  const { payloads } = payloadsOver({ ...ARRAYS, velocity_bad: { values: [1, 1, Number.NaN, 2, 3, 3], width: 2 } });
  await assert.rejects(payloads.embedding('X_bad', [0, 1], true), error =>
    error instanceof EmbeddingLoadError && error.reason === 'NaN at cell 1' && error.key === 'X_bad');
  await assert.rejects(payloads.vectors('velocity_bad', [0, 1], UMAP, true), error =>
    error instanceof MappingLoadError && error.message === "Vector field 'velocity_bad' cannot be drawn: NaN at cell 1.");
  await assert.rejects(payloads.vectors('velocity_umap', [0, 1], { key: 'X_bad', columns: [0, 1] }, true), EmbeddingLoadError);
});
