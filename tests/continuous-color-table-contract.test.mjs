import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COLORMAP_TABLE_BUCKETS,
  CONTINUOUS_COLORMAPS,
  getColormapByteTable,
} from '../assets/js/data/palettes.js';
import { NEUTRAL_GRAY_UINT8 } from '../assets/js/app/state/core/constants.js';
import {
  scanContinuousColumn,
  writeContinuousColors,
} from '../assets/js/app/state/managers/continuous-colors.js';

/** The per-cell rule the table-driven kernel must reproduce byte for byte. */
function referenceColors(values, transparency, domain, colormap) {
  const n = values.length;
  const colors = new Uint8Array(n * 4);
  const useLog = domain.scale === 'log';
  const logMin = useLog ? Math.log10(domain.min) : 0;
  const denom = useLog ? Math.log10(domain.max) - logMin : domain.max - domain.min;
  const sample = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const v = values[i];
    let rgb;
    if (Number.isNaN(v) || (useLog && v <= 0)) {
      rgb = [NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8];
    } else {
      const t = denom === 0
        ? 0.5
        : useLog ? (Math.log10(v) - logMin) / denom : (v - domain.min) / denom;
      colormap.sampleInto(t, sample);
      rgb = sample.map(channel => Math.round(channel * 255));
    }
    colors.set([...rgb, transparency[i] * 255], i * 4);
  }
  return colors;
}

function seededValues(n, seed, scale) {
  const values = new Float64Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    values[i] = (x / 2 ** 32) * scale - scale * 0.1;
  }
  return values;
}

test('the byte table reproduces the sampler at every bucket edge of every colormap', () => {
  const sample = [0, 0, 0];
  const buckets = COLORMAP_TABLE_BUCKETS;
  for (const colormap of CONTINUOUS_COLORMAPS) {
    const table = getColormapByteTable(colormap);
    assert.equal(table.length, (buckets + 1) * 4);
    assert.strictEqual(getColormapByteTable(colormap), table, 'built once per colormap');
    for (let bucket = 0; bucket <= buckets; bucket++) {
      colormap.sampleInto(bucket / buckets, sample);
      const j = bucket * 4;
      assert.equal(table[j], Math.round(sample[0] * 255));
      assert.equal(table[j + 1], Math.round(sample[1] * 255));
      assert.equal(table[j + 2], Math.round(sample[2] * 255));
      assert.ok(table[j + 3] === 0 || table[j + 3] === 1);
    }
  }
});

test('continuous colors equal the per-cell rule for every colormap, scale and domain', () => {
  const n = 4096;
  const transparency = new Uint8Array(n);
  for (let i = 0; i < n; i++) transparency[i] = i % 13 === 0 ? 0 : 1;
  const raw = seededValues(n, 7, 120);
  for (let i = 0; i < n; i += 97) raw[i] = Number.NaN;
  for (let i = 5; i < n; i += 31) raw[i] = raw[i - 1]; // repeated neighbours
  const domains = [
    { min: 0, max: 100, scale: 'linear' },
    { min: 20, max: 40, scale: 'linear' }, // most values outside: clamped
    { min: 3, max: 3, scale: 'linear' }, // constant domain samples 0.5
    { min: 0.5, max: 90, scale: 'log' }, // non-positive values are missing
  ];
  for (const Values of [Float32Array, Float64Array]) {
    const values = Values.from(raw);
    for (const colormap of CONTINUOUS_COLORMAPS) {
      for (const domain of domains) {
        const colors = new Uint8Array(n * 4);
        writeContinuousColors(colors, values, transparency, domain, colormap);
        assert.deepEqual(
          colors,
          referenceColors(values, transparency, domain, colormap),
          `${Values.name} ${colormap.id} ${domain.scale} [${domain.min}, ${domain.max}]`
        );
      }
    }
  }
});

test('a sparse column colors and scans exactly like its dense equivalent', () => {
  const n = 5000;
  const dense = new Float32Array(n);
  const indices = [];
  const values = [];
  for (let cell = 3; cell < n; cell += 37) {
    const value = cell % 5 === 0 ? Number.NaN : (cell % 7) * 0.75 - 1;
    if (value === 0) continue;
    dense[cell] = value;
    indices.push(cell);
    values.push(value);
  }
  const sparse = {
    length: n,
    indices: Uint32Array.from(indices),
    values: Float32Array.from(values),
  };
  const transparency = new Uint8Array(n).fill(1);
  transparency[3] = 0;
  const colormap = CONTINUOUS_COLORMAPS[0];
  for (const domain of [
    { min: -1, max: 3.5, scale: 'linear' },
    { min: 0.5, max: 3.5, scale: 'log' },
  ]) {
    const fromDense = new Uint8Array(n * 4);
    const fromSparse = new Uint8Array(n * 4);
    writeContinuousColors(fromDense, dense, transparency, domain, colormap);
    writeContinuousColors(fromSparse, sparse, transparency, domain, colormap);
    assert.deepEqual(fromSparse, fromDense, domain.scale);
  }
  assert.deepEqual(scanContinuousColumn(sparse), scanContinuousColumn(dense));

  // Every stored value positive: the implicit zeros still count.
  const positive = { length: 4, indices: Uint32Array.of(1, 3), values: Float32Array.of(2, 5) };
  assert.deepEqual(
    scanContinuousColumn(positive),
    scanContinuousColumn(Float32Array.of(0, 2, 0, 5))
  );
});

test('malformed columns and transparency are refused', () => {
  const colormap = CONTINUOUS_COLORMAPS[0];
  const domain = { min: 0, max: 1, scale: 'linear' };
  assert.throws(
    () => scanContinuousColumn({ length: 3, indices: Uint32Array.of(2, 1), values: Float32Array.of(1, 1) }),
    /increase strictly/
  );
  assert.throws(
    () => scanContinuousColumn({ length: 2, indices: Uint32Array.of(2), values: Float32Array.of(1) }),
    /stay below 2/
  );
  assert.throws(() => scanContinuousColumn([0, 1]), /Float32Array/);
  assert.throws(
    () => writeContinuousColors(new Uint8Array(8), Float32Array.of(0, 1), Uint8Array.of(1, 2), domain, colormap),
    /Transparency value 1 must be exactly 0 or 1/
  );
  const unaligned = new Uint8Array(new ArrayBuffer(9), 1, 8);
  assert.throws(
    () => writeContinuousColors(unaligned, Float32Array.of(0, 1), Uint8Array.of(1, 1), domain, colormap),
    /word-aligned/
  );
});
