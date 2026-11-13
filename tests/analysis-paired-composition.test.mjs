/**
 * The paired composition tests (`stats/composition-tests.js`) and the paired
 * t-test and signed-rank test they use (`stats/statistical-tests.js`), held
 * to SciPy 1.16.3: logit and CLR proportions with `ttest_rel`, proportions
 * with `scipy.stats.wilcoxon` (exact; and the normal approximation with
 * `correction=True`, R `wilcox.test(paired = TRUE)`'s).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { compositionPairs, testComposition, wilcoxonSignedRank } from '../assets/js/app/analysis/stats/composition-tests.js';
import { pairedTTest } from '../assets/js/app/analysis/stats/statistical-tests.js';

const close = (actual, expected, tolerance, what) => {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${what}: ${actual} is not ${expected}`);
};

// Three cell types × four samples in two conditions: unit 2s + c.
const COMPOSITION = [[30, 12, 25, 8, 40, 15, 22, 9], [10, 20, 12, 25, 8, 30, 9, 28], [5, 6, 4, 9, 6, 7, 3, 8]];
const SCIPY_COMPOSITION = {
  logit: [[15.163386344124682, 0.0006227644984074805], [-8.687768182118589, 0.0032092991511395897], [-3.6215908114242077, 0.03620684429662653]],
  clr: [[13.277140434907066, 0.0009233331266672221], [-6.663494808876613, 0.006890138929737545], [-2.241399001271941, 0.11081770330614367]],
  rank: [[10, 0.125], [0, 0.125], [0, 0.125]],
};

test('a paired composition test takes each sample\'s two conditions: paired t of logit and CLR, signed-rank of proportions', () => {
  const counts = Uint32Array.from(COMPOSITION.flat());
  const unitSample = Int32Array.of(0, 0, 1, 1, 2, 2, 3, 3);
  const conditionOfUnit = Int32Array.of(0, 1, 0, 1, 0, 1, 0, 1);
  for (const method of ['logit', 'clr', 'rank']) {
    const result = testComposition({
      counts, typeCount: 3, unitCount: 8, conditionOfUnit, conditionCount: 2, samples: true,
      unitSample, paired: true, method, correction: 'bh'
    });
    assert.equal(result.pairs, 4);
    assert.equal(result.test, method === 'rank' ? 'Wilcoxon signed-rank (paired)' : 'paired t-test');
    SCIPY_COMPOSITION[method].forEach(([statistic, pValue], type) => {
      close(result.statistic[type], statistic, 1e-9, `${method} statistic of type ${type}`);
      close(result.pValue[type], pValue, 1e-9, `${method} p of type ${type}`);
    });
  }
  const unpaired = testComposition({ counts, typeCount: 3, unitCount: 8, conditionOfUnit, conditionCount: 2, samples: true, method: 'logit', correction: 'bh' });
  assert.equal(unpaired.pairs, null);
  assert.equal(unpaired.test, "Welch's t-test");
  assert.throws(() => testComposition({ counts, typeCount: 3, unitCount: 8, conditionOfUnit, conditionCount: 2, samples: false, unitSample, paired: true, method: 'logit', correction: 'bh' }), /paired/);
  const pairs = compositionPairs(Int32Array.of(0, 0, 1, 2), Int32Array.of(0, 1, 1, 0));
  assert.deepEqual({ first: [...pairs.first], second: [...pairs.second], unpaired: pairs.unpaired }, { first: [0], second: [1], unpaired: 2 });
});

test('the signed-rank test is R wilcox.test(paired = TRUE): exact without ties below 50 pairs, else normal with corrections', () => {
  // scipy.stats.wilcoxon(method='exact') on 12 pairs: min(W+, W-) = 25, here W+ (R's V), p 0.30126953125.
  const u = [2.0409191213851825, -2.5556650313141818, 0.41809884672577885, -0.5677696061279298, -0.45264929211044586, -0.2155971630897659,
    -2.019986129147251, -0.23193237764418947, -0.8652130762749417, 3.3229995166448827, 0.22578661322792176, -0.3526307943415954];
  const v = [0.11871258184864963, -0.26804634610895006, -0.6551505512051213, 0.009199022765345288, 0.8819453885067858, 0.16144639342663333,
    1.3577587029597642, 0.20019787093342004, 0.4242595650766646, 1.9458208512128121, 0.9451055226876446, -0.10522873561401802];
  const exact = wilcoxonSignedRank(u, v);
  assert.equal(exact.exact, true);
  assert.equal(exact.statistic, 25);
  close(exact.pValue, 0.30126953125, 1e-12, 'exact p');
  // Tied |differences|: scipy.stats.wilcoxon(correction=True, method='approx'), p 0.4568210578719687.
  const tied = wilcoxonSignedRank([1, 2, 3, 4, 5, 6], [0.5, 2.5, 1, 1, 2, 9]);
  assert.equal(tied.exact, false);
  close(tied.pValue, 0.4568210578719687, 1e-12, 'normal p with ties');
  assert.deepEqual(pairedTTest([1, 2], [1, 2]), { statistic: NaN, pValue: NaN, n: 2 });
});

test('paired, the mean proportions and their ratio are over the pairs the test reads, never a sample in one condition', () => {
  // Units: three donors in both conditions (0, 1), and donor 3 in condition 0 only, with 2 cells all of type 0.
  // Type 0 is more frequent in condition 1 in every pair; donor 3's unpaired unit (100% type 0) would flip
  // the mean of condition 0 above condition 1.
  const unitSample = Int32Array.from([0, 0, 1, 1, 2, 2, 3]);
  const conditionOfUnit = Int32Array.from([0, 1, 0, 1, 0, 1, 0]);
  const typeCount = 2;
  const unitCount = 7;
  // counts[type * unitCount + unit]
  const counts = Uint32Array.from([
    5, 20, 6, 22, 4, 18, 2,
    95, 80, 94, 78, 96, 82, 0,
  ]);
  const paired = testComposition({ counts, typeCount, unitCount, conditionOfUnit, conditionCount: 2, samples: true, unitSample, paired: true, method: 'logit', correction: 'bh' });
  const mean = (type, condition) => paired.meanProportion[type * 2 + condition];
  assert.ok(Math.abs(mean(0, 0) - (0.05 + 0.06 + 0.04) / 3) < 1e-12, 'condition 0 over the three pairs');
  assert.ok(Math.abs(mean(0, 1) - (0.2 + 0.22 + 0.18) / 3) < 1e-12);
  assert.ok(paired.log2Ratio[0] > 0, 'the ratio agrees with the paired test (more in condition 1)');
  assert.equal(paired.pairs, 3);
  // Unpaired, every sample counts: the one-condition donor is in condition 0's mean.
  const unpaired = testComposition({ counts, typeCount, unitCount, conditionOfUnit, conditionCount: 2, samples: true, method: 'logit', correction: 'bh' });
  assert.ok(Math.abs(unpaired.meanProportion[0] - (0.05 + 0.06 + 0.04 + 1) / 4) < 1e-12);
  assert.ok(unpaired.log2Ratio[0] < 0);
});
