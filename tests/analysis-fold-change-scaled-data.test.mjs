import assert from 'node:assert/strict';
import test from 'node:test';

import { computeDifferential } from '../assets/js/app/analysis/compute/operation-handlers.js';

const ramp = (start, length = 20, step = 0.01) =>
  Float32Array.from({ length }, (_, index) => start + index * step);

function meanOf(values) {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

test('DE fold change keeps the published formula for non-negative expression', () => {
  const groupAValues = ramp(2);
  const groupBValues = ramp(0.5);
  const result = computeDifferential({ groupAValues, groupBValues, method: 'wilcox' });
  const expected = Math.log2((result.meanA + 0.01) / (result.meanB + 0.01));
  assert.equal(result.log2FoldChange, expected);
});

for (const [label, startA, startB] of [
  ['both means negative', -1.5, -0.5],
  ['means of opposite sign', -0.5, 0.5],
  ['both means negative, A higher', -0.2, -1.4],
]) {
  test(`DE fold change on scaled data is finite with the sign of meanA - meanB (${label})`, () => {
    const groupAValues = ramp(startA);
    const groupBValues = ramp(startB);
    for (const method of ['wilcox', 'ttest']) {
      const result = computeDifferential({ groupAValues, groupBValues, method });
      assert.ok(Number.isFinite(result.log2FoldChange), String(result.log2FoldChange));
      assert.equal(
        Math.sign(result.log2FoldChange),
        Math.sign(meanOf(groupAValues) - meanOf(groupBValues)),
      );
      // Shifting by the minimum of the compared cells makes it a fold change
      // of non-negative means.
      let minimum = Infinity;
      for (const value of [...groupAValues, ...groupBValues]) {
        minimum = Math.min(minimum, value);
      }
      const shift = Math.min(0, minimum);
      assert.ok(
        Math.abs(
          result.log2FoldChange -
          Math.log2((result.meanA - shift + 0.01) / (result.meanB - shift + 0.01))
        ) < 1e-12,
      );
    }
  });
}

test('marker worker fold change on scaled data matches DE and keeps its sign', async () => {
  const messages = [];
  globalThis.self = { postMessage: message => messages.push(message) };
  try {
    await import('../assets/js/app/analysis/compute/data-worker.js?scaled-fold-change');
    const runWorker = (type, payload, requestId) => {
      globalThis.self.onmessage({ data: { type, payload, requestId } });
      const message = messages.at(-1);
      assert.equal(message.requestId, requestId);
      assert.equal(message.success, true, message.error);
      return message.result;
    };

    const groupA = ramp(-2, 10, 0.02);
    const groupB = ramp(-0.5, 10, 0.02);
    const groupC = ramp(0.3, 10, 0.02);
    const values = Float32Array.from([...groupA, ...groupB, ...groupC]);
    runWorker('MARKERS_SET_CONTEXT', {
      codes: Uint16Array.from(values, (_, index) => Math.floor(index / 10)),
      codeToGroupIndex: Int32Array.from([0, 1, 2]),
      groupCount: 3,
      tested: Uint8Array.of(1, 1, 1),
      reference: -1,
    }, 'scaled-context');
    const result = runWorker('MARKERS_COMPUTE_GENES', {
      columns: [values],
      method: 'wilcox',
      minCells: 2,
      pConvention: 'exact',
      foldChange: { mode: 'stored' },
    }, 'scaled-gene');

    const groups = [groupA, groupB, groupC];
    for (let group = 0; group < 3; group++) {
      const rest = groups.filter((_, index) => index !== group).flatMap(g => [...g]);
      const reference = computeDifferential({
        groupAValues: groups[group],
        groupBValues: Float32Array.from(rest),
        method: 'wilcox',
      });
      const foldChange = result.log2FoldChange[group];
      assert.ok(Number.isFinite(foldChange), `group ${group}: ${foldChange}`);
      assert.equal(Math.sign(foldChange), Math.sign(reference.meanA - reference.meanB));
      assert.ok(
        Math.abs(foldChange - reference.log2FoldChange) < 1e-5,
        `group ${group}: ${foldChange} vs ${reference.log2FoldChange}`,
      );
    }
  } finally {
    delete globalThis.self;
  }
});

test('markers against a reference group shift a stored fold change by the two groups\' minimum, as DE does (NS-15)', async () => {
  const { createGroupingContext, geneSampleOf, groupMarkers } = await import('../assets/js/app/analysis/compute/gene-statistics.js');
  // Scaled data: group 2 (not compared) holds the lowest value.
  const a = ramp(-0.5);
  const b = ramp(0.2);
  const c = ramp(-3);
  const values = Float32Array.from([...a, ...b, ...c]);
  const groups = Int16Array.from([...a.map(() => 0), ...b.map(() => 1), ...c.map(() => 2)]);
  const context = createGroupingContext(groups, 3, { tested: Uint8Array.of(1, 0, 1), reference: 1 });
  const markers = groupMarkers(geneSampleOf(values, 0), context, { method: 'wilcox', minCells: 2, foldChange: { mode: 'stored' } });
  const de = computeDifferential({ groupAValues: a, groupBValues: b, method: 'wilcox' });
  assert.equal(markers.log2FoldChange[0], Math.fround(de.log2FoldChange));
});

// A file that records log1p (uns['log1p']) over values that are not logged —
// EBI SCEA E-ANND-5 (911,873 cells) stores per-million values, non-zero
// entries 252–1,118, with an empty uns['log1p'] — takes "Automatic" to the
// log1p fold change, whose expm1 of such means overflows float64: the ratio
// was ±Infinity (one mean above ~709.78) or NaN (both), and the volcano plot
// refused the DE result ("log2FoldChange … must be a finite number or
// unavailable"). The formula's value is finite; it is taken in log space.
const LOG1P = { mode: 'log1p', base: null };
// Per-million-shaped columns: group A's means above expm1's overflow, B's below.
const perMillion = (count, low, high, zeroEvery) => Float32Array.from(
  { length: count },
  (_, index) => (zeroEvery > 0 && index % zeroEvery === 0 ? 0 : low + ((index * 37) % 101) * (high - low) / 100),
);
const logTerm = mean => (Math.expm1(mean) < Infinity
  ? Math.log(Math.expm1(mean) + 1e-9)
  : mean + Math.log1p((1e-9 - 1) * Math.exp(-mean)));

test('log1p fold change of means past expm1 overflow is the formula\'s finite value (E-ANND-5 shape)', () => {
  for (const [label, groupAValues, groupBValues] of [
    ['A above overflow, B below', perMillion(40, 760, 1118, 0), perMillion(40, 252, 450, 2)],
    ['both above overflow', perMillion(40, 900, 1118, 0), perMillion(40, 720, 800, 0)],
    ['B above overflow, A zero-heavy', perMillion(40, 252, 300, 3), perMillion(40, 760, 1118, 0)],
  ]) {
    for (const method of ['wilcox', 'ttest']) {
      const result = computeDifferential({ groupAValues, groupBValues, method, foldChange: LOG1P });
      assert.ok(Number.isFinite(result.log2FoldChange), `${label} ${method}: ${result.log2FoldChange}`);
      const expected = (logTerm(result.meanA) - logTerm(result.meanB)) / Math.LN2;
      assert.ok(Math.abs(result.log2FoldChange - expected) <= 1e-12 * Math.abs(expected), `${label}: ${result.log2FoldChange} vs ${expected}`);
      assert.equal(Math.sign(result.log2FoldChange), Math.sign(result.meanA - result.meanB));
    }
  }
});

test('log1p fold change below overflow keeps scanpy\'s formula exactly, and the log-space form meets it at the boundary', async () => {
  const { foldChangeOfMeans } = await import('../assets/js/app/analysis/compute/gene-statistics.js');
  for (const [a, b] of [[2.5, 0.1], [0, 0], [300, 1], [709, 0.5], [0.3, 709.7]]) {
    assert.equal(
      foldChangeOfMeans(a, b, 0, LOG1P),
      Math.log2((Math.expm1(a) + 1e-9) / (Math.expm1(b) + 1e-9)),
    );
  }
  // Either side of the overflow (709.78 natural log units) the value is continuous.
  const below = foldChangeOfMeans(709.7, 3, 0, LOG1P);
  const above = foldChangeOfMeans(709.8, 3, 0, LOG1P);
  assert.ok(Number.isFinite(above));
  assert.ok(Math.abs((above - below) - 0.1 / Math.LN2) < 1e-9, `${below} → ${above}`);
  // A base-2 log1p overflows at a larger mean, in its own units.
  assert.ok(Math.abs(foldChangeOfMeans(2000, 1000, 0, { mode: 'log1p', base: 2 }) - 1000) < 1e-9);
  // Undefined only where the formula is: a non-positive term.
  assert.ok(Number.isNaN(foldChangeOfMeans(-1, 2, -1, LOG1P)));
});

test('markers and pseudobulk take the same finite log1p fold change past overflow', async () => {
  const { createGroupingContext, geneSampleOf, groupMarkers } = await import('../assets/js/app/analysis/compute/gene-statistics.js');
  const { pseudobulkLimma } = await import('../assets/js/app/analysis/stats/pseudobulk.js');
  const a = perMillion(30, 760, 1118, 0);
  const b = perMillion(30, 252, 450, 2);
  const c = perMillion(30, 900, 1000, 0);
  const values = Float32Array.from([...a, ...b, ...c]);
  const groups = Int16Array.from(values, (_, index) => Math.floor(index / 30));
  for (const options of [{}, { tested: Uint8Array.of(1, 0, 1), reference: 1 }]) {
    const context = createGroupingContext(groups, 3, options);
    const markers = groupMarkers(geneSampleOf(values, 0), context, { method: 'wilcox', minCells: 2, foldChange: LOG1P });
    for (const g of options.reference === 1 ? [0, 2] : [0, 1, 2]) {
      assert.ok(Number.isFinite(markers.log2FoldChange[g]), `group ${g}: ${markers.log2FoldChange[g]}`);
    }
  }
  // Two units a side, per-million unit means on both sides of the overflow.
  const { genes } = pseudobulkLimma({
    sums: Float64Array.of(800 * 10, 900 * 10, 300 * 10, 350 * 10),
    expressing: Float64Array.of(10, 10, 10, 10),
    measured: Float64Array.of(10, 10, 10, 10),
    geneCount: 1,
    units: { unitCount: 4, unitSide: Uint8Array.of(1, 1, 2, 2), unitSample: Int32Array.of(0, 1, 2, 3) },
    counts: false,
    minCellsPerSample: 1,
    foldChange: LOG1P
  });
  const log2FoldChange = genes.log2FoldChange[0];
  assert.ok(Number.isFinite(log2FoldChange), String(log2FoldChange));
  assert.ok(Math.abs(log2FoldChange - (850 - Math.log(Math.expm1(325) + 1e-9)) / Math.LN2) < 1e-9);
});
