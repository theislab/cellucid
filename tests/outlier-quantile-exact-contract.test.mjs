/**
 * Latent-space outlier quantiles (`data/latent-outliers.js`) are the numbers
 * `cellucid-python` computes, bit for bit:
 * - read from a real `.h5ad` and Zarr ZIP through the browser adapter's
 *   mapping route, every usable `obsm` array as the latent space and every
 *   categorical obs field gives the bytes `cellucid serve` sends
 *   (`data-mapping-full.expected.json`, written from cellucid itself);
 * - a latent space with a NaN is refused in the server's words;
 * - the stated rule holds on a hand-checked case: ties share the larger rank,
 *   missing codes and small categories are NaN.
 *
 * The reader worker runs in-process here (`helpers/anndata-reader-in-process`),
 * so the latent space is streamed from the file exactly as in a browser.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { H5adDataSource } from '../assets/js/data/h5ad.js';
import { ZarrDataSource } from '../assets/js/data/zarr.js';
import {
  MappingLoadError,
  mappingLatentOutlierPath,
} from '../assets/js/data/data-mapping-candidates.js';
import {
  computeLatentOutlierQuantiles,
  LatentOutlierQuantiles,
} from '../assets/js/data/latent-outliers.js';
import { LatentOutlierReader } from '../assets/js/data/latent-outliers-stream.js';

// The fixture cellucid-python writes and cellucid-r keeps byte for byte, under
// the same pin (scripts/generate_latent_outlier_conformance.py).
const CONFORMANCE_BYTES = await readFile(new URL('./fixtures/latent-outlier-conformance.json', import.meta.url));
const CONFORMANCE_SHA256 = '46ea30291fc2d1fc51fc2021837eb8914062f8080b6ad51995cacaa1875b9d80';

const EXPECTED = JSON.parse(
  await readFile(new URL('./browser/fixtures/data-mapping-full.expected.json', import.meta.url), 'utf8')
);

function silenceNotifications(t) {
  const notifications = getNotificationCenter();
  const names = ['startDownload', 'updateDownload', 'completeDownload', 'failDownload', 'dismissDownload', 'warning', 'error', 'info', 'loading', 'complete', 'fail', 'dismiss'];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  let next = 0;
  for (const name of names) notifications[name] = () => `${name}-${++next}`;
  t.after(() => {
    for (const [name, method] of originals) {
      if (method === undefined) delete notifications[name];
      else notifications[name] = method;
    }
  });
}

async function open(t, format) {
  silenceNotifications(t);
  if (format === 'H5AD') {
    const file = new File([await readFile(new URL('./browser/fixtures/data-mapping-full.h5ad', import.meta.url))], 'data-mapping-full.h5ad');
    const source = new H5adDataSource();
    t.after(() => source.clear());
    await source.loadFromFile(file);
    return source.getAdapter();
  }
  const file = new File([await readFile(new URL('./browser/fixtures/data-mapping-full.zarr.zip', import.meta.url))], 'data-mapping-full.zarr.zip');
  const source = new ZarrDataSource();
  t.after(() => source.clear());
  await source.loadFromArchiveFile(file);
  return source.getAdapter();
}

function sha256(view) {
  return createHash('sha256').update(Buffer.from(view.buffer, view.byteOffset, view.byteLength)).digest('hex');
}

for (const format of ['H5AD', 'Zarr ZIP']) {
  test(`${format}: outlier quantiles in every latent space equal the server's bytes`, async t => {
    const adapter = await open(t, format);
    const obsm = adapter.getMappingCandidates().obsm.map(item => item.key);
    const fields = adapter.getObsManifest()._categoricalFields.map(([index, key]) => [key, index]);
    assert.deepEqual(fields.map(([key]) => key).sort(), ['batch', 'cell_type']);
    let compared = 0;
    for (const [key, expected] of Object.entries(EXPECTED.latent)) {
      const obsmIndex = obsm.indexOf(key);
      if (Object.hasOwn(expected, 'refused')) {
        await assert.rejects(
          adapter.getLatentOutlierQuantiles(mappingLatentOutlierPath(obsmIndex, fields[0][1])),
          error => error instanceof MappingLoadError && error.key === key && error.reason === expected.refused
        );
        continue;
      }
      for (const [fieldKey, fieldIndex] of fields) {
        const quantiles = await adapter.getLatentOutlierQuantiles(mappingLatentOutlierPath(obsmIndex, fieldIndex));
        assert.ok(quantiles instanceof Float32Array);
        assert.equal(sha256(quantiles), expected[fieldKey], `${key} / ${fieldKey}`);
        compared += 1;
      }
    }
    assert.equal(compared, 14);
  });
}

test('the rule: centre, distance, the share at that distance or closer', () => {
  // Category 0: four cells on a line at 0, 1, 1, 4 (centre 1.5, distances
  // 1.5, 0.5, 0.5, 2.5); the tie at 0.5 shares the larger rank.
  // Category 1: two cells, under minPoints. Code 9: missing.
  const latent = Float32Array.from([0, 0, 1, 0, 1, 0, 4, 0, 7, 7, 8, 8, 3, 3]);
  const quantiles = computeLatentOutlierQuantiles({
    latent,
    width: 2,
    codes: Uint8Array.from([0, 0, 0, 0, 1, 1, 9]),
    nCategories: 2,
    minPoints: 3,
  });
  assert.deepEqual([...quantiles.slice(0, 4)], [0.75, 0.5, 0.5, 1]);
  assert.ok(quantiles.slice(4).every(Number.isNaN));
  assert.throws(
    () => computeLatentOutlierQuantiles({ latent, width: 3, codes: [], nCategories: 1, minPoints: 1 }),
    /whole cells/
  );
});

/** A loader stand-in serving one row-major latent space in slabs of `slabRows`. */
function slabLoader(values, width, slabRows, reads = { count: 0 }) {
  const nObs = values.length / width;
  return {
    nObs,
    reads,
    async forEachObsmRowSlab(key, visit) {
      reads.count += 1;
      for (let rowStart = 0; rowStart < nObs; rowStart += slabRows) {
        const rowEnd = Math.min(nObs, rowStart + slabRows);
        await Promise.resolve();
        visit(values.slice(rowStart * width, rowEnd * width), rowStart, rowEnd);
      }
      return width;
    },
  };
}

test('streamed in row slabs, the quantiles are the in-memory bytes; a small latent space is kept', async () => {
  let seed = 11;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const width = 4;
  const nCells = 5_000;
  const values = new Float64Array(nCells * width);
  for (let i = 0; i < values.length; i++) values[i] = (random() - 0.5) * 9;
  const codes = Int32Array.from({ length: nCells }, () => Math.floor(random() * 7) - 1);
  const field = { codes, nCategories: 6, minPoints: 20 };
  const expected = computeLatentOutlierQuantiles({ latent: Float32Array.from(values), width, ...field });

  // Above the budget: never held, read once per pass.
  const streamed = slabLoader(values, width, 333);
  const large = new LatentOutlierReader(streamed, { budgetBytes: nCells * width * 4 - 1 });
  assert.equal(sha256(await large.quantiles('X_latent', width, field)), sha256(expected));
  assert.equal(streamed.reads.count, 2);
  assert.equal(large.heldKey, null);

  // Within the budget: read once, kept, and the next field reads nothing.
  const kept = slabLoader(values, width, 1_024);
  const small = new LatentOutlierReader(kept, { budgetBytes: nCells * width * 4 });
  assert.equal(sha256(await small.quantiles('X_latent', width, field)), sha256(expected));
  assert.equal(sha256(await small.quantiles('X_latent', width, field)), sha256(expected));
  assert.equal(kept.reads.count, 1);
  assert.equal(small.heldKey, 'X_latent');
  small.clear();
  assert.equal(small.heldKey, null);
});

test('a value past float32 is refused at its own cell, wherever its slab falls', async () => {
  const width = 2;
  const values = new Float64Array(40 * width).fill(0.5);
  values[27 * width + 1] = Number.NaN;
  const reader = new LatentOutlierReader(slabLoader(values, width, 8), { budgetBytes: 0 });
  await assert.rejects(
    reader.quantiles('X_bad', width, { codes: new Int32Array(40), nCategories: 1, minPoints: 1 }),
    error => error instanceof MappingLoadError && error.key === 'X_bad' && error.reason === 'NaN at cell 27'
  );
  // No category scored: nothing is read.
  const untouched = slabLoader(values, width, 8);
  const quantiles = await new LatentOutlierReader(untouched).quantiles('X_bad', width, {
    codes: new Int32Array(40).fill(-1), nCategories: 1, minPoints: 1,
  });
  assert.ok(quantiles.every(Number.isNaN));
  assert.equal(untouched.reads.count, 0);
});

test('slabs must arrive in order and cover every cell once per pass', () => {
  const outliers = new LatentOutlierQuantiles({
    nCells: 4, width: 1, codes: [0, 0, 0, 0], nCategories: 1, minPoints: 1,
  });
  assert.throws(() => outliers.addCentroidRows(Float32Array.of(1), 1), /arrive in order/);
  outliers.addCentroidRows(Float32Array.of(1, 2), 0);
  assert.throws(() => outliers.finishCentroids(), /every cell once/);
});

test('the shared conformance cases give the bytes cellucid-python and cellucid-r give', () => {
  assert.equal(createHash('sha256').update(CONFORMANCE_BYTES).digest('hex'), CONFORMANCE_SHA256);
  const { cases } = JSON.parse(CONFORMANCE_BYTES.toString('utf8'));
  assert.equal(cases.length, 4);
  for (const entry of cases) {
    const latent = Float32Array.from(entry.latent);
    assert.deepEqual([...latent], entry.latent, `${entry.name}: float32 values`);
    const quantiles = computeLatentOutlierQuantiles({
      latent,
      width: entry.width,
      codes: entry.codes,
      nCategories: entry.nCategories,
      minPoints: entry.minPoints,
    });
    assert.equal(Buffer.from(quantiles.buffer).toString('hex'), entry.quantilesHex, entry.name);
  }
});

/**
 * The rule as the module states it, step by step: column sums in cell order,
 * squared differences accumulated column by column, a sorted copy and one
 * `searchsorted(..., side="right")` per cell.
 */
function quantilesByTheRule({ latent, width, codes, nCategories, minPoints }) {
  const nCells = latent.length / width;
  const quantiles = new Float32Array(nCells).fill(Number.NaN);
  for (let code = 0; code < nCategories; code++) {
    const members = [];
    for (let cell = 0; cell < nCells; cell++) if (codes[cell] === code) members.push(cell);
    const n = members.length;
    if (n < minPoints) continue;
    const squared = new Float64Array(n);
    for (let column = 0; column < width; column++) {
      let sum = 0;
      for (const cell of members) sum += latent[cell * width + column];
      const centroid = sum / n;
      members.forEach((cell, k) => {
        const difference = latent[cell * width + column] - centroid;
        squared[k] += difference * difference;
      });
    }
    const distances = squared.map(Math.sqrt);
    const sorted = Float64Array.from(distances).sort();
    members.forEach((cell, k) => {
      let low = 0;
      let high = n;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (sorted[middle] <= distances[k]) low = middle + 1;
        else high = middle;
      }
      quantiles[cell] = Math.fround(Math.fround(low) / Math.fround(n));
    });
  }
  return quantiles;
}

test('large categories, ranked by radix ordering, give the rule bit for bit', () => {
  let seed = 7;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const nCells = 60_000;
  const cases = [
    // Continuous values: almost every distance distinct.
    { width: 5, value: () => (random() - 0.5) * 6 },
    // Integer values: long runs of tied distances.
    { width: 2, value: () => Math.round((random() - 0.5) * 4) },
    // An infinite coordinate makes NaN distances in its category.
    { width: 3, value: () => (random() < 1e-4 ? Infinity : random()) },
  ];
  for (const { width, value } of cases) {
    const latent = new Float32Array(nCells * width);
    for (let i = 0; i < latent.length; i++) latent[i] = value();
    // One category above the radix bound, smaller ones below it and under
    // minPoints, and missing codes.
    const codes = new Int16Array(nCells);
    for (let cell = 0; cell < nCells; cell++) {
      const r = random();
      codes[cell] = r < 0.6 ? 0 : r < 0.9 ? 1 : r < 0.99 ? 2 + Math.floor(random() * 50) : -1;
    }
    const task = { latent, width, codes, nCategories: 52, minPoints: 30 };
    const actual = computeLatentOutlierQuantiles(task);
    const expected = quantilesByTheRule(task);
    assert.equal(sha256(actual), sha256(expected), `width ${width}`);
  }
});
