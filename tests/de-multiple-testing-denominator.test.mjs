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
  benjaminiHochberg,
  benjaminiHochbergAdjusted,
  benjaminiHochbergTestable,
} from '../assets/js/app/analysis/stats/statistical-tests.js';
import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';
import { DEAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/de-analysis-ui.js';

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
 * Pre-consolidation `stats/statistical-tests.js` step-up, verbatim.
 */
function legacyCoreBenjaminiHochberg(pValues, alpha = 0.05) {
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
  let threshold = null;
  for (let i = 0; i < m; i++) {
    const criticalValue = (i + 1) * alpha / m;
    if (indexed[i].pValue <= criticalValue) threshold = indexed[i].pValue;
  }
  const adjustedPValues = new Array(n).fill(null);
  const significant = new Array(n).fill(false);
  for (let i = 0; i < m; i++) {
    const origIdx = indexed[i].originalIndex;
    adjustedPValues[origIdx] = adjustedValid[i];
    significant[origIdx] = adjustedValid[i] <= alpha;
  }
  return {
    adjustedPValues,
    significant,
    threshold,
    significantCount: significant.filter(s => s).length,
  };
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
    benjaminiHochberg([0.01, 0.04, 0.03]).adjustedPValues,
    [0.03, 0.04, 0.04],
    'unsorted family',
  );
  // p.adjust(c(0, 0.001, 0.001, 0.5, 1, 0.75), "BH") -> 0 0.002 0.002 0.75 1 0.90
  assertAllClose(
    benjaminiHochberg([0, 0.001, 0.001, 0.5, 1, 0.75]).adjustedPValues,
    [0, 0.002, 0.002, 0.75, 1, 0.9],
    'ties and boundaries',
  );
  // p.adjust(c(0.01, 0.02, 0.03, 0.04, 0.05), "BH") -> all 0.05
  assertAllClose(
    benjaminiHochberg([0.01, 0.02, 0.03, 0.04, 0.05]).adjustedPValues,
    [0.05, 0.05, 0.05, 0.05, 0.05],
    'uniformly critical family',
  );
});

test('the surviving Benjamini-Hochberg reproduces the replaced core implementation', () => {
  for (const { label, pValues } of DENSE_FIXTURES) {
    for (const alpha of [0.01, 0.05, 0.1]) {
      const expected = pValues.length === 0
        ? {
          adjustedPValues: [],
          significant: [],
          threshold: null,
          significantCount: 0,
        }
        : legacyCoreBenjaminiHochberg(pValues, alpha);
      const actual = benjaminiHochberg(pValues, alpha);

      assertAllClose(
        actual.adjustedPValues,
        expected.adjustedPValues,
        `${label} @ alpha=${alpha} adjusted`,
      );
      assert.deepEqual(
        actual.significant,
        expected.significant,
        `${label} @ alpha=${alpha} significance flags diverged`,
      );
      assert.equal(
        actual.significantCount,
        expected.significantCount,
        `${label} @ alpha=${alpha} significant count diverged`,
      );
      if (expected.threshold === null) {
        assert.equal(actual.threshold, null, `${label} @ alpha=${alpha} threshold`);
      } else {
        assertClose(
          actual.threshold,
          expected.threshold,
          `${label} @ alpha=${alpha} threshold`,
        );
      }
    }
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

    const analysis = Object.create(MultiVariableAnalysis.prototype);
    const rows = pValues.map((pValue, index) => ({
      gene: `G${index}`,
      pValue,
    }));
    const counts = analysis._applyBenjaminiHochberg(rows);

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
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  const counts = analysis._applyBenjaminiHochberg(rows);

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
// FINDING 1 — THE REPORTED COUNTS ARE THE CORRECTION'S OWN NUMBERS
// =============================================================================

/**
 * Twenty panel genes; eight fail the min-cell check and carry no p-value, so
 * Benjamini-Hochberg ran at m = 12. This is the audited scenario in miniature.
 */
function untestableGeneFixture() {
  const results = [];
  for (let index = 0; index < 12; index++) {
    const pValue = (index + 1) / 1000;
    results.push({
      gene: `TESTED_${index}`,
      pValue,
      adjustedPValue: pValue * 12 / (index + 1),
      log2FoldChange: index % 2 === 0 ? 2 : -2,
      nA: 12,
      nB: 12,
    });
  }
  for (let index = 0; index < 8; index++) {
    results.push({
      gene: `UNTESTABLE_${index}`,
      error: 'Insufficient valid cells (A: 3, B: 4)',
      pValue: NaN,
      adjustedPValue: null,
      log2FoldChange: NaN,
      nA: 3,
      nB: 4,
    });
  }
  const upregulated = results.filter(
    row => Number.isFinite(row.adjustedPValue)
      && row.adjustedPValue < 0.05
      && row.log2FoldChange > 0,
  ).length;
  const downregulated = results.filter(
    row => Number.isFinite(row.adjustedPValue)
      && row.adjustedPValue < 0.05
      && row.log2FoldChange < 0,
  ).length;

  return {
    results,
    summary: {
      genesTested: 12,
      genesUntestable: 8,
      minCells: 10,
      significantGenes: upregulated + downregulated,
      upregulated,
      downregulated,
      method: 'wilcox',
      pageA: 'page-A',
      pageB: 'page-B',
      duration: 1234,
      throughput: 10,
      batchConfig: {
        preloadCount: 4,
        memoryBudgetMB: 8,
        networkConcurrency: 2,
      },
    },
    metadata: {
      pageAName: 'Treated',
      pageBName: 'Control',
      recommendedSettings: {},
    },
  };
}

test('the DE modal reports the FDR denominator, not the panel size', () => {
  const data = untestableGeneFixture();
  const ui = Object.create(DEAnalysisUI.prototype);
  ui._lastResult = {
    type: 'differential',
    plotType: 'volcanoplot',
    data,
    options: {
      pValueThreshold: 0.05,
      foldChangeThreshold: 1.0,
      useAdjustedPValue: true,
      labelTopN: 15,
    },
    title: 'Differential Expression',
    subtitle: 'Treated vs Control',
  };

  const container = { innerHTML: '' };
  ui._renderModalStats(container);
  const html = container.innerHTML;

  assert.equal(
    data.results.length,
    20,
    'fixture must carry more panel genes than tested genes',
  );
  assert.match(
    html,
    /Genes tested \(FDR denominator\)<\/td>\s*<td><strong>12<\/strong>/,
    'the modal must report the 12 genes the correction actually used',
  );
  assert.doesNotMatch(
    html,
    /Genes tested \(FDR denominator\)<\/td>\s*<td><strong>20<\/strong>/,
    'the panel size must never be labelled as the tested-gene count',
  );
  assert.match(
    html,
    /Not tested \(&lt; 10 cells with a value\)<\/td>\s*<td><strong>8<\/strong>/,
    'the untestable remainder must be reported distinctly',
  );
  // The significance threshold is inclusive everywhere in the analysis module,
  // so the label must read the comparison the count actually used.
  assert.match(
    html,
    /Significant \(FDR \u2264 0\.05, \|log\u2082FC\| \u2265 1\)/,
    'the significance row must state the inclusive comparison it used',
  );
  assert.doesNotMatch(
    html,
    /Significant \(FDR (&lt;|<) 0\.05/,
    'a strict comparison must never be shown for an inclusive rule',
  );
});

test('the DE modal refuses to render counts the correction did not supply', () => {
  const data = untestableGeneFixture();
  delete data.summary.genesTested;
  const ui = Object.create(DEAnalysisUI.prototype);
  ui._lastResult = {
    data,
    options: { pValueThreshold: 0.05, foldChangeThreshold: 1.0, useAdjustedPValue: true },
  };

  assert.throws(
    () => ui._renderModalStats({ innerHTML: '' }),
    /genesTested, genesUntestable and minCells/,
  );
});

/**
 * Pull the modal statistics table apart into [label, count] pairs, in the order
 * the rows are emitted. The label cell is matched non-greedily so the raw "<" in
 * "Significant (FDR <= 0.05, ...)" does not truncate it.
 */
function modalStatRows(html) {
  return [
    ...html.matchAll(
      /<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*><strong>([\d,]+)<\/strong>/g,
    ),
  ].map(([, label, value]) => [
    label.trim(),
    Number(value.replaceAll(',', '')),
  ]);
}

test('the DE modal reports every count row and never counts an untestable gene', () => {
  // The summary grid this replaced guarded the "significant cannot exceed
  // tested" invariant with an explicit throw. On the live path the guarantee is
  // structural rather than asserted: the modal tallies significance from the
  // result rows, and a gene with no p-value is skipped. To prove the skip is
  // real, the eight untestable genes here carry a large *finite* fold change —
  // only the missing p-value keeps them out. A renderer that treated a missing
  // p-value as passing would report 20 significant genes in a 12-gene corrected
  // family, which is exactly the impossible state the old throw existed to stop.
  const data = untestableGeneFixture();
  for (const row of data.results) {
    if (row.gene.startsWith('UNTESTABLE_')) row.log2FoldChange = 5;
  }
  const ui = Object.create(DEAnalysisUI.prototype);
  ui._lastResult = {
    type: 'differential',
    plotType: 'volcanoplot',
    data,
    options: {
      pValueThreshold: 0.05,
      foldChangeThreshold: 1.0,
      useAdjustedPValue: true,
      labelTopN: 15,
    },
    title: 'Differential Expression',
    subtitle: 'Treated vs Control',
  };

  const container = { innerHTML: '' };
  ui._renderModalStats(container);
  const rows = modalStatRows(container.innerHTML);

  assert.deepEqual(
    rows.map(([label]) => label),
    [
      'Genes tested (FDR denominator)',
      'Not tested (&lt; 10 cells with a value)',
      'Significant (FDR ≤ 0.05, |log₂FC| ≥ 1)',
      'Upregulated',
      'Downregulated',
    ],
    'every count row must be present, in order, with its denominator labelled',
  );

  const counts = Object.fromEntries(
    rows.map(([, value], index) => [
      ['genesTested', 'genesUntestable', 'significant', 'up', 'down'][index],
      value,
    ]),
  );

  assert.equal(counts.genesTested, 12, 'the denominator must be the tested-gene count');
  assert.equal(counts.genesUntestable, 8, 'the untestable remainder must be reported');
  assert.equal(
    counts.significant,
    counts.up + counts.down,
    'the significant total must be the sum of the two directions shown beside it',
  );
  assert.ok(
    counts.significant <= counts.genesTested,
    `significant (${counts.significant}) exceeded the FDR denominator (${counts.genesTested}): `
      + 'a gene with no p-value was counted as significant',
  );
  assert.equal(
    counts.significant,
    12,
    'all twelve tested genes are significant here and none of the eight untestable ones are',
  );
});
