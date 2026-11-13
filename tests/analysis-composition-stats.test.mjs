/**
 * Composition matches SciPy (`tests/fixtures/analysis/scanpy-reference.json`,
 * key `composition`, made by `scripts/generate-analysis-fixtures.py`):
 *
 * - the cell counts per type and unit, from the per-cell codes, in one pass
 *   (`compute/composition-counts.js`), with a sample split across two
 *   conditions counted as two units;
 * - per type, Welch's t / one-way ANOVA on logit proportions and on CLR,
 *   Wilcoxon / Kruskal-Wallis on proportions, BH and Bonferroni;
 * - without samples, χ² of type × condition and per type, Fisher's exact
 *   test for a 2 × 2 table with an expected count below 5.
 *
 * Counts are exact; statistics and p-values agree to a relative 1e-9.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  compositionCounts,
  presentCompositionUnits
} from '../assets/js/app/analysis/compute/composition-counts.js';
import {
  MIN_PAIRS_WITH_CELLS, TOO_FEW_PAIRS, testComposition, transformedProportions, wilcoxonSignedRank
} from '../assets/js/app/analysis/stats/composition-tests.js';
import { benjaminiHochbergAdjusted, pairedTTest } from '../assets/js/app/analysis/stats/statistical-tests.js';
import { chiSquaredIndependence, fisherExact2x2 } from '../assets/js/app/analysis/stats/categorical-tests.js';

const FIXTURE = new URL('./fixtures/analysis/scanpy-reference.json', import.meta.url);
const text = readFileSync(FIXTURE, 'utf8');
const reference = JSON.parse(text);
const { data, composition } = reference;

function close(actual, expected, label, tolerance = 1e-9) {
  if (expected === null) {
    assert.ok(!Number.isFinite(actual), `${label}: expected not finite, got ${actual}`);
    return;
  }
  const scale = Math.max(Math.abs(expected), 1e-300);
  assert.ok(
    Math.abs(actual - expected) / scale <= tolerance || Math.abs(actual - expected) <= 1e-15,
    `${label}: ${actual} vs ${expected}`
  );
}

function codesOf(values, categories) {
  const index = new Map(categories.map((name, i) => [name, i]));
  return Uint8Array.from(values, value => index.get(value));
}

function countCase(kase) {
  const typeCodes = codesOf(data.obs.group, composition.types);
  const sampleCodes = codesOf(data.obs.sample, composition.samples);
  const conditionCodes = codesOf(kase.condition, kase.conditionNames);
  const identity = n => Int32Array.from({ length: n }, (_, i) => i);
  const counted = compositionCounts({
    typeCodes,
    typeIndexOfCode: identity(composition.types.length),
    typeCount: composition.types.length,
    sampleCodes: kase.samples ? sampleCodes : null,
    sampleIndexOfCode: kase.samples ? identity(composition.samples.length) : null,
    sampleCount: kase.samples ? composition.samples.length : 1,
    conditionCodes,
    conditionIndexOfCode: identity(kase.conditionNames.length),
    conditionCount: kase.conditionNames.length,
    scope: null
  });
  return presentCompositionUnits(counted, kase.conditionNames.length);
}

test('counts per type and unit are exact, a split sample is two units', () => {
  for (const kase of composition.cases) {
    const present = countCase(kase);
    assert.deepEqual([...present.counts], kase.counts.flat(), `${kase.name} counts`);
    assert.deepEqual([...present.unitCondition], kase.unitCondition, `${kase.name} unit conditions`);
    if (kase.samples) assert.deepEqual([...present.unitSample], kase.unitSample, `${kase.name} unit samples`);
    if (kase.samples) {
      assert.deepEqual(present.splitSamples, kase.name === 'split' ? [5] : [], `${kase.name} split samples`);
    }
  }
});

test('a scope and a cell-type subset leave the other cells out, renormalising the rest', () => {
  const typeCodes = codesOf(data.obs.group, composition.types);
  const scope = new Uint8Array(typeCodes.length);
  for (let cell = 0; cell < scope.length; cell += 2) scope[cell] = 1;
  const typeIndexOfCode = Int32Array.from([0, 1, -1, -1, -1, -1]);
  const counted = compositionCounts({
    typeCodes, typeIndexOfCode, typeCount: 2,
    sampleCodes: null, sampleIndexOfCode: null, sampleCount: 1,
    conditionCodes: null, conditionIndexOfCode: null, conditionCount: 1,
    scope
  });
  const expected = [0, 0];
  data.obs.group.forEach((group, cell) => {
    if (cell % 2 === 0 && (group === 'g0' || group === 'g1')) expected[group === 'g0' ? 0 : 1] += 1;
  });
  assert.deepEqual([...counted.counts], expected);
});

test('per-type tests across samples match SciPy', () => {
  for (const kase of composition.cases.filter(c => c.samples)) {
    const present = countCase(kase);
    const k = kase.conditionNames.length;
    for (const method of ['logit', 'clr', 'rank']) {
      const expected = kase.tests[method];
      for (const correction of ['bh', 'bonferroni']) {
        const out = testComposition({
          counts: present.counts,
          typeCount: composition.types.length,
          unitCount: present.unitCount,
          conditionOfUnit: present.unitCondition,
          conditionCount: k,
          samples: true,
          method,
          correction
        });
        expected.pvalue.forEach((p, type) => {
          const label = `${kase.name} ${method} ${composition.types[type]}`;
          close(out.pValue[type], p, `${label} p`);
          close(out.adjustedP[type], expected[correction][type], `${label} ${correction}`);
          if (method === 'rank' && k === 2) {
            // SciPy reports U of the first sample; R and Cellucid may report
            // either tail. The two are U and n1·n2 − U.
            const n1 = [...present.unitCondition].filter(c => c === 0).length;
            const n2 = present.unitCount - n1;
            const u = out.statistic[type];
            assert.ok(
              Math.abs(u - expected.statistic[type]) < 1e-9 || Math.abs(n1 * n2 - u - expected.statistic[type]) < 1e-9,
              `${label} U ${u} vs ${expected.statistic[type]}`
            );
          } else {
            close(out.statistic[type], expected.statistic[type], `${label} statistic`);
          }
        });
      }
    }
  }
});

test('without samples: χ² of type × condition, and per type χ² or Fisher', () => {
  for (const kase of composition.cases.filter(c => !c.samples)) {
    const present = countCase(kase);
    const out = testComposition({
      counts: present.counts,
      typeCount: composition.types.length,
      unitCount: present.unitCount,
      conditionOfUnit: present.unitCondition,
      conditionCount: kase.conditionNames.length,
      samples: false,
      method: 'logit',
      correction: 'bh'
    });
    close(out.overall.statistic, kase.overall.statistic, `${kase.name} overall χ²`);
    assert.equal(out.overall.df, kase.overall.df);
    close(out.overall.pValue, kase.overall.pvalue, `${kase.name} overall p`);
    kase.perType.forEach((row, type) => {
      const label = `${kase.name} ${composition.types[type]}`;
      assert.equal(out.typeTest[type], row.test === 'fisher' ? "Fisher's exact" : 'χ²', label);
      close(out.statistic[type], row.statistic, `${label} statistic`);
      close(out.pValue[type], row.pvalue, `${label} p`);
    });
  }
  assert.ok(
    composition.cases.some(c => !c.samples && c.perType.some(row => row.test === 'fisher')),
    'the fixture exercises Fisher\'s exact test'
  );
});

test('the small tests by hand: Fisher two-sided, Yates on 2 × 2, empty rows dropped', () => {
  // SciPy: fisher_exact([[1, 9], [11, 3]]) = (0.0303..., 0.002759...).
  const fisher = fisherExact2x2(1, 9, 11, 3);
  close(fisher.oddsRatio, 3 / 99, 'odds ratio');
  close(fisher.pValue, 0.0027594561852200836, 'Fisher p', 1e-12);
  // chi2_contingency([[10, 20], [20, 10]]): 5.4, df 1, p 0.020136751550346364.
  const yates = chiSquaredIndependence([[10, 20], [20, 10]]);
  close(yates.statistic, 5.4, 'Yates χ²');
  close(yates.pValue, 0.020136751550346364, 'Yates p', 1e-12);
  const dropped = chiSquaredIndependence([[10, 20, 0], [20, 10, 0], [0, 0, 0]]);
  assert.equal(dropped.df, 1);
});

test('a type with no cells is not tested and leaves every other type as without it', () => {
  // Units of very different sizes (one condition's samples are fifty times the other's) make an absent type's transformed
  // proportion differ between conditions; it must not be tested at all.
  for (const kase of composition.cases) {
    const present = countCase(kase);
    const typeCount = composition.types.length;
    const unitCount = present.unitCount;
    const withAbsent = new Uint32Array((typeCount + 1) * unitCount);
    withAbsent.set(present.counts, unitCount);
    for (const method of ['logit', 'clr', 'rank']) {
      for (const correction of ['bh', 'bonferroni']) {
        const input = {
          unitCount,
          conditionOfUnit: present.unitCondition,
          conditionCount: kase.conditionNames.length,
          samples: kase.samples,
          method,
          correction
        };
        const without = testComposition({ ...input, counts: present.counts, typeCount });
        const out = testComposition({ ...input, counts: withAbsent, typeCount: typeCount + 1 });
        const label = `${kase.name} ${method} ${correction}`;
        assert.equal(out.typeTest[0], 'no cells', `${label}: the absent type's test`);
        for (const lane of ['statistic', 'pValue', 'adjustedP', 'log2Ratio']) {
          assert.ok(Number.isNaN(out[lane][0]), `${label}: the absent type's ${lane} is NaN`);
          assert.deepEqual([...out[lane].subarray(1)], [...without[lane]], `${label}: ${lane} of the present types`);
        }
        assert.deepEqual(out.typeTest.slice(1), without.typeTest, `${label}: tests of the present types`);
        assert.deepEqual(out.overall, without.overall, `${label}: overall χ²`);
      }
    }
  }
});

test('paired, a type whose cells are all in units outside the pairs is not tested', () => {
  // One Langerhans cell in a spleen-only donor (liver vs spleen, 7 donors with both): in the
  // pairs its logit pseudo-proportions are the units' sizes alone, every liver unit larger
  // than its spleen, so a paired t would call it a change.
  // Units: 4 donors × (liver, spleen), liver 10× the spleen, then one spleen-only donor.
  const unitCount = 9;
  const unitSample = Int32Array.of(0, 0, 1, 1, 2, 2, 3, 3, 4);
  const conditionOfUnit = Int32Array.of(0, 1, 0, 1, 0, 1, 0, 1, 1);
  const common = [
    [400, 40, 380, 42, 410, 37, 390, 45, 30],
    [600, 50, 610, 61, 590, 55, 620, 52, 20],
  ];
  const rare = [0, 0, 0, 0, 0, 0, 0, 0, 1];
  const input = { unitCount, conditionOfUnit, conditionCount: 2, samples: true, unitSample, paired: true, correction: 'bh' };
  for (const method of ['logit', 'clr', 'rank']) {
    const out = testComposition({ ...input, method, counts: Uint32Array.from([...rare, ...common.flat()]), typeCount: 3 });
    const without = testComposition({ ...input, method, counts: Uint32Array.from(common.flat()), typeCount: 2 });
    assert.equal(out.pairs, 4);
    assert.equal(out.typeTest[0], 'no cells', `${method}: no cell of it in the pairs`);
    for (const lane of ['statistic', 'pValue', 'adjustedP']) {
      assert.ok(Number.isNaN(out[lane][0]), `${method}: its ${lane} is NaN`);
      assert.deepEqual([...out[lane].subarray(1)], [...without[lane]], `${method}: ${lane} of the others as without it`);
    }
    // Its mean proportions are over the pairs, as the test reads them: none there. Where its
    // cell is, the table's per-sample proportions say (the spleen-only donor's column).
    assert.deepEqual([out.meanProportion[0], out.meanProportion[1]], [0, 0]);
  }
});

test('paired, a type is tested over the pairs holding its cells, and not below 3 of them', () => {
  // Myelocytes (liver vs spleen, seven donors with both), cells in one donor's spleen
  // only, must not come out significant. In each pair without one on either side the two
  // logit pseudo-proportions are the units' sizes alone, every liver unit larger than its
  // spleen, so the differences agree in sign and a paired t calls a change of a type that
  // is not there. Units: seven donors × (liver, spleen), liver ten times the spleen.
  const pairCount = 7;
  const unitCount = 2 * pairCount;
  const unitSample = Int32Array.from({ length: unitCount }, (_, unit) => unit >> 1);
  const conditionOfUnit = Int32Array.from({ length: unitCount }, (_, unit) => unit & 1);
  const perPair = (liver, spleen) => Array.from({ length: pairCount }, (_, pair) => [liver[pair], spleen[pair]]).flat();
  const common = [
    perPair([400, 380, 410, 390, 405, 395, 385], [40, 42, 37, 45, 41, 39, 44]),
    perPair([600, 610, 590, 620, 595, 605, 615], [50, 61, 55, 52, 58, 49, 57]),
  ];
  // Cells in two pairs (spleen of donors 0 and 1): not tested.
  const twoPairs = perPair([0, 0, 0, 0, 0, 0, 0], [3, 2, 0, 0, 0, 0, 0]);
  // Cells in four pairs: tested over those four only.
  const fourPairs = perPair([1, 0, 2, 0, 0, 3, 0], [4, 0, 5, 0, 0, 2, 6]);
  const counts = Uint32Array.from([...twoPairs, ...fourPairs, ...common.flat()]);
  const typeCount = 4;
  const input = { counts, typeCount, unitCount, conditionOfUnit, conditionCount: 2, samples: true, unitSample, paired: true, correction: 'bh' };
  const totals = new Float64Array(unitCount);
  for (let type = 0; type < typeCount; type++) for (let unit = 0; unit < unitCount; unit++) totals[unit] += counts[type * unitCount + unit];
  assert.equal(MIN_PAIRS_WITH_CELLS, 3);
  for (const method of ['logit', 'clr', 'rank']) {
    const out = testComposition({ ...input, method });
    assert.equal(out.pairs, pairCount);
    assert.deepEqual([...out.pairsTested], [2, 4, 7, 7], `${method}: the pairs holding each type's cells`);
    assert.equal(out.typeTest[0], TOO_FEW_PAIRS, `${method}: cells in two pairs`);
    for (const lane of ['statistic', 'pValue', 'adjustedP']) assert.ok(Number.isNaN(out[lane][0]), `${method}: its ${lane} is NaN`);
    // Still a type with cells: its mean proportion shows where they are.
    assert.ok(out.meanProportion[1] > 0);
    // The four-pair type's test is the paired test of exactly those four pairs' values
    // (the transformed proportions themselves are unchanged: it has cells, so it counts
    // in the CLR center and the pseudo-proportions' K).
    const values = transformedProportions(method, counts, typeCount, unitCount, totals, Uint8Array.of(1, 1, 1, 1));
    const withCells = [0, 2, 5, 6];
    const a = withCells.map(pair => values[1 * unitCount + 2 * pair]);
    const b = withCells.map(pair => values[1 * unitCount + 2 * pair + 1]);
    const expected = method === 'rank' ? wilcoxonSignedRank(a, b) : pairedTTest(a, b);
    assert.equal(out.statistic[1], expected.statistic, `${method}: statistic over its four pairs`);
    assert.equal(out.pValue[1], expected.pValue, `${method}: p over its four pairs`);
    // The family is the three tested types: the two-pair type is out of the correction.
    const tested = [...out.pValue].filter(Number.isFinite);
    assert.equal(tested.length, 3, `${method}: three types tested`);
    assert.deepEqual([...out.adjustedP.subarray(1)], [...benjaminiHochbergAdjusted(tested).adjustedPValues], `${method}: a family of three`);
  }
  // Without the rule the two-pair type was "significant" on the logit scale: its seven
  // differences are the units' size ratios, all one sign.
  const logit = transformedProportions('logit', counts, typeCount, unitCount, totals, Uint8Array.of(1, 1, 1, 1));
  const all = pairedTTest(
    Array.from({ length: pairCount }, (_, pair) => logit[2 * pair]),
    Array.from({ length: pairCount }, (_, pair) => logit[2 * pair + 1])
  );
  assert.ok(all.pValue < 0.05, `the artefact the rule removes (p ${all.pValue})`);
});

test('one categorical kernel: the Detailed view and Composition give one answer for one table', async () => {
  const { runStatisticalTests } = await import('../assets/js/app/analysis/stats/statistical-tests.js');
  // The table [[30, 70], [45, 55]]: SciPy chi2_contingency 4.181333333333333, p 0.04087153408900611.
  const page = (pageName, a, b) => ({ pageName, values: [...new Array(a).fill('in'), ...new Array(b).fill('out')] });
  const detailed = runStatisticalTests([page('P1', 30, 70), page('P2', 45, 55)], 'categorical_obs')[0];
  const kernel = chiSquaredIndependence([[30, 70], [45, 55]]);
  close(kernel.statistic, 4.181333333333333, 'Yates χ²', 1e-12);
  close(kernel.pValue, 0.04087153408900611, 'Yates p', 1e-12);
  assert.equal(detailed.statistic, kernel.statistic);
  assert.equal(detailed.pValue, kernel.pValue);
  close(kernel.pearson, 4.8, 'uncorrected χ²', 1e-12);
  // Composition, cells as replicates: the same 2 x 2 for a type against the rest.
  const result = testComposition({
    counts: Uint32Array.of(30, 45, 70, 55),
    typeCount: 2,
    unitCount: 2,
    conditionOfUnit: Int32Array.of(0, 1),
    conditionCount: 2,
    samples: false,
    method: 'logit',
    correction: 'bh'
  });
  assert.equal(result.statistic[0], kernel.statistic);
  assert.equal(result.pValue[0], kernel.pValue);
});

test("Fisher's exact test equals the exact rational two-sided p (R's relative 1e-7 for ties)", () => {
  // Python fractions: Σ p(x) over p(x) ≤ p(observed)(1 + 1e-7). SciPy agrees
  // within 1.3e-10 (its 500,000-cell table) and below.
  for (const [table, exact] of [
    [[1, 9, 11, 3], 0.0027594561852200836],
    [[3, 7, 9, 2], 0.029973122852379817],
    [[10, 10, 10, 10], 1],
    [[1, 2, 2, 1], 1],
    [[2, 7, 7, 2], 0.05668449197860963],
    [[0, 50, 50, 0], 1.9823306042836678e-29],
    [[5, 1000, 2, 3000], 0.012993989665978494],
    [[3, 500000, 40, 600000], 4.2470438244025424e-08],
    [[0, 500, 500, 0], 7.399507995628054e-300]
  ]) {
    close(fisherExact2x2(...table).pValue, exact, `Fisher ${table}`, 1e-9);
  }
  assert.throws(() => fisherExact2x2(1.5, 2, 3, 4), /whole numbers/);
});
