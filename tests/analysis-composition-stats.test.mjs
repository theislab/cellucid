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
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  compositionCounts,
  presentCompositionUnits
} from '../assets/js/app/analysis/compute/composition-counts.js';
import {
  chiSquaredIndependence,
  fisherExact2x2,
  testComposition
} from '../assets/js/app/analysis/stats/composition-tests.js';

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

test('the fixture is the generator\'s output', () => {
  const recorded = readFileSync(new URL('./fixtures/analysis/scanpy-reference.json.sha256', import.meta.url), 'utf8');
  assert.equal(recorded.split(/\s+/)[0], createHash('sha256').update(text).digest('hex'));
});

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
