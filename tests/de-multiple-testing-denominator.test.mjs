/**
 * Multiple-testing denominator contract.
 *
 * Two guarantees are asserted here:
 *
 * 1. Differential expression reports the Benjamini-Hochberg denominator it
 *    actually used. A gene that failed the min-cell check has no p-value and is
 *    not part of the corrected family, so it must never be counted as a tested
 *    gene. A reader must be able to reconstruct "Significant (FDR <= 0.05)" from
 *    the counts on screen.
 *
 * 2. The single surviving Benjamini-Hochberg implementation reproduces, value
 *    for value, what each of the three implementations it replaced produced for
 *    its own caller — including ties and the boundary p-values 0 and 1.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  benjaminiHochbergAdjusted,
  benjaminiHochbergTestable,
} from '../assets/js/app/analysis/stats/statistical-tests.js';
import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';

// =============================================================================
// NUMERIC HELPERS
// =============================================================================

/**
 * Compare with a relative tolerance so extreme tails (p ~ 1e-300) are compared
 * meaningfully rather than being swallowed by an absolute epsilon.
 */
function assertClose(actual, expected, label, tolerance = 1e-12) {
  assert.equal(
    typeof actual,
    'number',
    `${label} must be a number, received ${String(actual)}`,
  );
  if (expected === 0) {
    assert.equal(actual, 0, `${label} must be exactly 0`);
    return;
  }
  const difference = Math.abs(actual - expected);
  assert.ok(
    difference <= tolerance * Math.abs(expected),
    `${label}: ${actual} is not within ${tolerance} relative of ${expected}`,
  );
}

function assertAllClose(actual, expected, label, tolerance = 1e-12) {
  assert.equal(
    actual.length,
    expected.length,
    `${label} length ${actual.length} !== ${expected.length}`,
  );
  for (let index = 0; index < expected.length; index++) {
    assertClose(actual[index], expected[index], `${label}[${index}]`, tolerance);
  }
}

// =============================================================================
// REPLACED IMPLEMENTATIONS, KEPT VERBATIM AS EQUIVALENCE REFERENCES
// =============================================================================

/**
 * Pre-consolidation `stats/statistical-tests.js` step-up adjustment.
 */
function legacyCoreBenjaminiHochberg(pValues) {
  const n = pValues.length;
  const indexed = Array.from(pValues, (p, i) => ({ pValue: p, originalIndex: i }));
  const m = indexed.length;
  indexed.sort((a, b) => a.pValue - b.pValue);
  const adjustedValid = new Array(m);
  adjustedValid[m - 1] = indexed[m - 1].pValue;
  for (let i = m - 2; i >= 0; i--) {
    const rawAdjusted = indexed[i].pValue * m / (i + 1);
    adjustedValid[i] = Math.min(rawAdjusted, adjustedValid[i + 1]);
  }
  for (let i = 0; i < m; i++) {
    adjustedValid[i] = Math.min(adjustedValid[i], 1);
  }
  const adjustedPValues = new Array(n).fill(null);
  for (let i = 0; i < m; i++) {
    adjustedPValues[indexed[i].originalIndex] = adjustedValid[i];
  }
  return { adjustedPValues };
}

/**
 * Pre-consolidation `genes-panel/marker-discovery-engine.js` step-up, verbatim.
 */
function legacyMarkerBenjaminiHochberg(pValues) {
  const n = pValues.length;
  const out = new Float64Array(n);
  const ordered = [];
  for (let i = 0; i < n; i++) ordered.push({ index: i, p: pValues[i] });
  if (ordered.length === 0) return out;
  ordered.sort((a, b) => a.p - b.p || a.index - b.index);
  const m = ordered.length;
  let nextAdj = ordered[m - 1].p;
  out[ordered[m - 1].index] = Math.min(nextAdj, 1);
  for (let i = m - 2; i >= 0; i--) {
    const raw = (ordered[i].p * m) / (i + 1);
    nextAdj = Math.min(raw, nextAdj);
    out[ordered[i].index] = Math.min(nextAdj, 1);
  }
  return out;
}

/**
 * Pre-consolidation `stats/multi-variable-analysis.js` step-up, verbatim.
 * Skips non-finite p-values and mutates rows in place.
 */
function legacyMvaBenjaminiHochberg(results) {
  for (let i = 0; i < results.length; i++) results[i].adjustedPValue = null;
  const valid = [];
  for (let i = 0; i < results.length; i++) {
    const pValue = results[i]?.pValue;
    if (Number.isFinite(pValue)) valid.push({ index: i, pValue });
  }
  if (valid.length === 0) return results;
  valid.sort((a, b) => a.pValue - b.pValue);
  const m = valid.length;
  let nextAdj = valid[m - 1].pValue;
  results[valid[m - 1].index].adjustedPValue = Math.min(nextAdj, 1);
  for (let i = m - 2; i >= 0; i--) {
    const rawP = valid[i].pValue * m / (i + 1);
    nextAdj = Math.min(rawP, nextAdj);
    results[valid[i].index].adjustedPValue = Math.min(nextAdj, 1);
  }
  return results;
}

/**
 * Fixtures every implementation must agree on. Ties, both boundary p-values,
 * extreme finite tails, a saturating tail, singletons and the empty family.
 */
const DENSE_FIXTURES = [
  { label: 'unsorted small family', pValues: [0.01, 0.04, 0.03] },
  { label: 'ties and both boundaries', pValues: [0, 0.001, 0.001, 0.5, 1, 0.75] },
  { label: 'all tied', pValues: [0.02, 0.02, 0.02, 0.02] },
  { label: 'all at the upper boundary', pValues: [1, 1, 1] },
  { label: 'all at the lower boundary', pValues: [0, 0, 0] },
  { label: 'extreme finite tails', pValues: [1e-300, 1e-298, 0.5] },
  { label: 'saturating step-up', pValues: [0.9, 0.95, 0.99, 1] },
  { label: 'already sorted', pValues: [0.01, 0.02, 0.03, 0.04, 0.05] },
  { label: 'single gene', pValues: [0.7] },
  { label: 'empty family', pValues: [] },
];

// =============================================================================
// FINDING 2 — NUMERICAL EQUIVALENCE OF THE CONSOLIDATED IMPLEMENTATION
// =============================================================================

test('Benjamini-Hochberg matches R p.adjust(method = "BH") on hand-checked families', () => {
  // p.adjust(c(0.01, 0.04, 0.03), "BH") -> 0.030 0.040 0.040
  assertAllClose(
    benjaminiHochbergAdjusted(Float64Array.from([0.01, 0.04, 0.03])).adjustedPValues,
    [0.03, 0.04, 0.04],
    'unsorted family',
  );
  // p.adjust(c(0, 0.001, 0.001, 0.5, 1, 0.75), "BH") -> 0 0.002 0.002 0.75 1 0.90
  assertAllClose(
    benjaminiHochbergAdjusted(Float64Array.from([0, 0.001, 0.001, 0.5, 1, 0.75])).adjustedPValues,
    [0, 0.002, 0.002, 0.75, 1, 0.9],
    'ties and boundaries',
  );
  // p.adjust(c(0.01, 0.02, 0.03, 0.04, 0.05), "BH") -> all 0.05
  assertAllClose(
    benjaminiHochbergAdjusted(Float64Array.from([0.01, 0.02, 0.03, 0.04, 0.05])).adjustedPValues,
    [0.05, 0.05, 0.05, 0.05, 0.05],
    'uniformly critical family',
  );
});

test('the surviving Benjamini-Hochberg reproduces the replaced core implementation', () => {
  for (const { label, pValues } of DENSE_FIXTURES) {
    const expected = pValues.length === 0
      ? []
      : legacyCoreBenjaminiHochberg(pValues).adjustedPValues;
    assertAllClose(
      benjaminiHochbergAdjusted(Float64Array.from(pValues)).adjustedPValues,
      expected,
      `${label} adjusted`,
    );
  }
});

test('the surviving Benjamini-Hochberg reproduces the replaced marker implementation', () => {
  for (const { label, pValues } of DENSE_FIXTURES) {
    const input = Float64Array.from(pValues);
    const expected = legacyMarkerBenjaminiHochberg(input);
    const actual = benjaminiHochbergAdjusted(input).adjustedPValues;

    assert.ok(
      actual instanceof Float64Array,
      `${label} must stay a Float64Array for the marker hot path`,
    );
    assertAllClose(actual, expected, `${label} marker adjusted`);
    assert.equal(
      benjaminiHochbergAdjusted(input).testedCount,
      pValues.length,
      `${label} dense fixture is entirely testable`,
    );
    assert.equal(benjaminiHochbergAdjusted(input).untestableCount, 0, label);
  }

  // The marker path exists because Float32 would collapse finite extreme tails
  // into each other; the replacement must keep them distinguishable.
  const { adjustedPValues: tails } = benjaminiHochbergAdjusted(
    Float64Array.from([1e-300, 1e-298, 0.5]),
  );
  assert.ok(tails[0] > 0, 'extreme tail must not be flushed to zero');
  assert.ok(tails[1] > tails[0], 'extreme tails must stay ordered and distinct');
  assertClose(tails[0], 3e-300, 'smallest adjusted tail');
  assertClose(tails[1], 1.5e-298, 'second adjusted tail');
});

test('the surviving Benjamini-Hochberg reproduces the replaced DE implementation', () => {
  const sparseFixtures = [
    {
      label: 'no untestable genes',
      pValues: [0.01, 0.04, 0.03],
    },
    {
      label: 'untestable genes interleaved',
      pValues: [NaN, 0.01, NaN, 0.04, 0.03, NaN],
    },
    {
      label: 'untestable genes with ties and boundaries',
      pValues: [NaN, 0, 0.001, NaN, 0.001, 1, 0.75, 0.5],
    },
    {
      label: 'every gene untestable',
      pValues: [NaN, NaN, NaN],
    },
    {
      label: 'a single testable gene',
      pValues: [NaN, 0.42, NaN],
    },
    {
      label: 'no genes at all',
      pValues: [],
    },
  ];

  for (const { label, pValues } of sparseFixtures) {
    const legacyRows = pValues.map((pValue, index) => ({
      gene: `G${index}`,
      pValue,
    }));
    legacyMvaBenjaminiHochberg(legacyRows);

    const rows = pValues.map((pValue, index) => ({
      gene: `G${index}`,
      pValue,
    }));
    const counts = benjaminiHochbergTestable(rows.map(row => row.pValue));
    rows.forEach((row, index) => { row.adjustedPValue = counts.adjustedPValues[index]; });

    for (let index = 0; index < rows.length; index++) {
      const expected = legacyRows[index].adjustedPValue;
      if (expected === null) {
        assert.equal(
          rows[index].adjustedPValue,
          null,
          `${label}[${index}] untestable gene must keep a null adjusted p-value`,
        );
      } else {
        assertClose(
          rows[index].adjustedPValue,
          expected,
          `${label}[${index}] adjusted`,
        );
      }
    }

    const expectedTested = pValues.filter(p => Number.isFinite(p)).length;
    assert.equal(counts.testedCount, expectedTested, `${label} testedCount`);
    assert.equal(
      counts.untestableCount,
      pValues.length - expectedTested,
      `${label} untestableCount`,
    );
  }
});

test('the DE correction uses the testable subset, not the panel size, as m', () => {
  // Six panel genes, three of them untestable. With m = 3 the smallest p-value
  // adjusts to 0.03; with the panel size m = 6 it would adjust to 0.06 and the
  // gene would drop out at FDR < 0.05. The denominator is load-bearing.
  const rows = [
    { gene: 'UNTESTABLE_1', pValue: NaN },
    { gene: 'BEST', pValue: 0.01 },
    { gene: 'UNTESTABLE_2', pValue: NaN },
    { gene: 'WORST', pValue: 0.04 },
    { gene: 'MIDDLE', pValue: 0.03 },
    { gene: 'UNTESTABLE_3', pValue: NaN },
  ];
  const counts = benjaminiHochbergTestable(rows.map(row => row.pValue));
  rows.forEach((row, index) => { row.adjustedPValue = counts.adjustedPValues[index]; });

  assert.equal(counts.testedCount, 3);
  assert.equal(counts.untestableCount, 3);
  assertClose(rows[1].adjustedPValue, 0.03, 'BEST adjusted with m = 3');
  assertClose(rows[4].adjustedPValue, 0.04, 'MIDDLE adjusted with m = 3');
  assertClose(rows[3].adjustedPValue, 0.04, 'WORST adjusted with m = 3');
  assert.ok(
    rows[1].adjustedPValue < 0.05,
    'the top gene must stay significant under the denominator actually used',
  );
});

test('the testable correction rejects a finite p-value outside [0, 1]', () => {
  assert.throws(
    () => benjaminiHochbergTestable([0.1, 1.5]),
    /p-value 2.*finite and between/i,
  );
  assert.throws(
    () => benjaminiHochbergTestable([0.1, null]),
    /numeric value at every index/i,
  );
});

// =============================================================================
// THE REPORTED COUNTS ARE THE CORRECTION'S OWN NUMBERS
// =============================================================================

test('a DE run reports the family it corrected over: untested genes are not in it', async () => {
  // Gene U is measured in one cell of group A only (the rest of its values
  // are NaN), so it cannot be tested; genes T1 and T2 can.
  const columns = {
    T1: Float32Array.of(1, 2, 3, 7, 8, 9),
    T2: Float32Array.of(4, 4, 5, 1, 1, 2),
    U: Float32Array.of(1, NaN, NaN, 2, 3, 4),
  };
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    state: { pointCount: 6 },
    resolveExpressionMatrix: () => ({ matrix: 'X', read: null, label: 'Mapped (X)' }),
    async getGeneKeys() { return this.getAvailableVariables('gene_expression').map(gene => gene.key); },
    getAvailableVariables: () => Object.keys(columns).map(key => ({ key })),
    async readGeneColumn(gene) {
      return { fieldIndex: 0, values: columns[gene], owned: false };
    },
    performCacheCleanup() {},
  };
  const { computeDifferentialOfColumns, setTwoGroupContext } = await import('../assets/js/app/analysis/compute/operation-handlers.js');
  analysis._getComputeManager = async () => ({
    selectBackend: () => 'cpu',
    async broadcast(operation, payloadFor) {
      if (operation === 'SET_TWO_GROUP_CONTEXT') return [setTwoGroupContext(payloadFor(0))];
      return [{ released: true }];
    },
    async execute(operation, payload) {
      return computeDifferentialOfColumns(payload);
    },
  });
  const result = await analysis.differentialExpression({
    groupA: { name: 'A', cells: Uint32Array.of(0, 1, 2) },
    groupB: { name: 'B', cells: Uint32Array.of(3, 4, 5) },
    minCells: 10,
  });
  assert.equal(result.summary.genesTested, 2);
  assert.equal(result.summary.genesUntestable, 1);
  const untested = result.results.find(row => row.gene === 'U');
  assert.ok(Number.isNaN(untested.pValue));
  assert.equal(untested.adjustedPValue, null);
  assert.deepEqual(result.summary.lowN, ['A', 'B'], 'groups under the minimum of 10 are flagged, not refused');
});
