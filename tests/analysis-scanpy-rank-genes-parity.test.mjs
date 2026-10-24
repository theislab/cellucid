/**
 * Marker genes and differential expression compute the numbers scanpy and
 * SciPy compute, on the shared synthetic AnnData of
 * `tests/fixtures/analysis/scanpy-reference.json` (made by
 * `scripts/generate-analysis-fixtures.py` with pinned scanpy, SciPy, numpy;
 * its SHA-256 sidecar catches a hand edit):
 *
 * - `groupMarkers` against `sc.tl.rank_genes_groups`: Wilcoxon without and
 *   with tie correction (the `normal` and `normal_tie` conventions), t-test,
 *   t-test with overestimated variance; against the rest, against `g2`, for a
 *   subset of groups (the others stay in the rest); on negative (scaled)
 *   values; scores, log fold changes (log1p undone, scanpy's 1e-9), p-values,
 *   BH and Bonferroni adjusted p-values over every gene, and the fraction of
 *   cells with a non-zero value in the group and in the rest;
 * - `twoSampleDifferential` under the default `exact` convention against
 *   SciPy `mannwhitneyu` (exact when both sides are under 50 and untied, else
 *   asymptotic with tie and continuity correction).
 *
 * Tolerances, each for a stated reason:
 * - scanpy stores `scores` and `logfoldchanges` as float32 and the kernel
 *   keeps them in Float32Array lanes: equal within one float32 ulp (the two
 *   float64 values may round to neighbouring float32s);
 * - the fractions are float32 lanes in percent: within one float32 ulp;
 * - p-values: both sides evaluate the normal / t tail in float64 with
 *   different special-function code (SciPy cephes, our incomplete gamma and
 *   beta): rank tests within relative 1e-12 (measured: 2e-14). scanpy's
 *   t-test variance is `E[x²] − E[x]²`, which cancels, where ours is the
 *   centred sum of squares: t-test p-values within relative 1e-10
 *   (measured: 2.3e-11, on a gene whose variance is small beside its mean);
 * - every input value is a multiple of 1/4, so sums, means and rank sums are
 *   exact on both sides; the U statistic is compared exactly.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createGroupingContext,
  geneSampleOf,
  groupMarkers,
  twoSampleDifferential,
} from '../assets/js/app/analysis/compute/gene-statistics.js';
import {
  benjaminiHochbergAdjusted,
  bonferroniAdjusted,
} from '../assets/js/app/analysis/stats/statistical-tests.js';

const FIXTURE_URL = new URL('./fixtures/analysis/scanpy-reference.json', import.meta.url);
const FIXTURE_TEXT = readFileSync(FIXTURE_URL, 'utf8');
const REFERENCE = JSON.parse(FIXTURE_TEXT);

/** Relative p-value tolerances (see the header). */
const P_TOLERANCE_RANK = 1e-12;
const P_TOLERANCE_T = 1e-10;

const { var_names: GENES, obs, X } = REFERENCE.data;
const CELLS = X.length;
const GROUP_NAMES = ['g0', 'g1', 'g2', 'g3', 'g4', 'g5'];
const GROUP_OF_CELL = Int32Array.from(obs.group, name => GROUP_NAMES.indexOf(name));

/** The gene's column, dense float32 as the AnnData stores it. */
function column(gene, layer) {
  const j = GENES.indexOf(gene);
  return Float32Array.from(X, row => (layer === 'scaled' ? row[j] - 1 : row[j]));
}

function float32Ulp(value) {
  const f = Math.fround(Math.abs(value));
  if (f === 0) return 2 ** -149;
  const exponent = Math.floor(Math.log2(f));
  return 2 ** (exponent - 23);
}

function assertFloat32Close(actual, expected, label) {
  if (expected === null) {
    assert.ok(!Number.isFinite(actual), `${label}: expected no value, got ${actual}`);
    return;
  }
  assert.ok(
    Math.abs(actual - expected) <= float32Ulp(expected),
    `${label}: ${actual} vs ${expected}`,
  );
}

function assertRelative(actual, expected, tolerance, label) {
  if (expected === null) {
    assert.ok(!Number.isFinite(actual), `${label}: expected no value, got ${actual}`);
    return;
  }
  const scale = Math.max(Math.abs(expected), Number.MIN_VALUE);
  assert.ok(
    Math.abs(actual - expected) / scale <= tolerance,
    `${label}: ${actual} vs ${expected} (relative ${Math.abs(actual - expected) / scale})`,
  );
}

const METHODS = { wilcoxon: 'wilcox', 't-test': 'ttest', 't-test_overestim_var': 'ttest_overestim_var' };

/** Every gene through `groupMarkers` as the case's options say. */
function runCase(options) {
  const method = METHODS[options.method];
  const pConvention = options.tie_correct === true ? 'normal_tie' : 'normal';
  const reference = options.reference === undefined ? -1 : GROUP_NAMES.indexOf(options.reference);
  const chosen = options.groups ?? GROUP_NAMES;
  const tested = Uint8Array.from(GROUP_NAMES, name => (chosen.includes(name) && name !== options.reference ? 1 : 0));
  const context = createGroupingContext(GROUP_OF_CELL, GROUP_NAMES.length, { tested, reference });
  const lanes = GROUP_NAMES.map(() => ({
    scores: new Float64Array(GENES.length),
    logfoldchanges: new Float64Array(GENES.length),
    pvals: new Float64Array(GENES.length),
    pctIn: new Float64Array(GENES.length),
    pctRef: new Float64Array(GENES.length),
  }));
  GENES.forEach((gene, i) => {
    const result = groupMarkers(geneSampleOf(column(gene, options.layer)), context, {
      method,
      // Every group of the fixture is tested, the 4-cell one included, as
      // scanpy tests it ("Test anyway").
      minCells: 2,
      pConvention,
      foldChange: { mode: 'log1p', base: null },
    });
    GROUP_NAMES.forEach((_name, g) => {
      lanes[g].scores[i] = result.scores[g];
      lanes[g].logfoldchanges[i] = result.log2FoldChange[g];
      lanes[g].pvals[i] = result.pValues[g];
      lanes[g].pctIn[i] = result.percentInGroup[g];
      lanes[g].pctRef[i] = result.percentOutGroup[g];
    });
  });
  const correct = options.corr_method === 'bonferroni' ? bonferroniAdjusted : benjaminiHochbergAdjusted;
  for (const lane of lanes) lane.pvalsAdj = correct(lane.pvals).adjustedPValues;
  return lanes;
}

test('the fixture is the one the generator wrote', () => {
  const sidecar = readFileSync(new URL('./fixtures/analysis/scanpy-reference.json.sha256', import.meta.url), 'utf8');
  const digest = createHash('sha256').update(FIXTURE_TEXT).digest('hex');
  assert.equal(sidecar, `${digest}  scanpy-reference.json\n`);
  assert.equal(REFERENCE.versions.scanpy, '1.11.4');
  assert.equal(CELLS, 600);
  assert.equal(GENES.length, 48);
  assert.deepEqual(
    GROUP_NAMES.map(name => obs.group.filter(group => group === name).length),
    [200, 160, 130, 97, 4, 9],
  );
});

for (const [name, { options, groups }] of Object.entries(REFERENCE.rank_genes_groups)) {
  test(`rank_genes_groups ${name}: every gene of every group as scanpy computes it`, () => {
    const lanes = runCase(options);
    const pTolerance = options.method === 'wilcoxon' ? P_TOLERANCE_RANK : P_TOLERANCE_T;
    const expectedGroups = (options.groups ?? GROUP_NAMES).filter(group => group !== options.reference);
    assert.deepEqual(Object.keys(groups).sort(), expectedGroups.toSorted());
    for (const [groupName, expected] of Object.entries(groups)) {
      const lane = lanes[GROUP_NAMES.indexOf(groupName)];
      assert.equal(expected.names.length, GENES.length);
      expected.names.forEach((gene, rank) => {
        const i = GENES.indexOf(gene);
        const label = `${name} ${groupName} ${gene}`;
        assertFloat32Close(lane.scores[i], expected.scores[rank], `${label} score`);
        assertFloat32Close(lane.logfoldchanges[i], expected.logfoldchanges[rank], `${label} log2FC`);
        assertRelative(lane.pvals[i], expected.pvals[rank], pTolerance, `${label} p`);
        assertRelative(lane.pvalsAdj[i], expected.pvals_adj[rank], pTolerance, `${label} adjusted p`);
        assertFloat32Close(lane.pctIn[i] / 100, expected.pct_nz_group[rank], `${label} % in group`);
        if (expected.pct_nz_reference !== null) {
          assertFloat32Close(lane.pctRef[i] / 100, expected.pct_nz_reference[rank], `${label} % in rest`);
        }
      });
      // scanpy's order is the score's, largest first.
      const ordered = expected.names.map(gene => Math.fround(lane.scores[GENES.indexOf(gene)]));
      for (let k = 1; k < ordered.length; k++) {
        assert.ok(ordered[k - 1] >= ordered[k] || !Number.isFinite(ordered[k]), `${name} ${groupName} rank ${k}`);
      }
    }
  });
}

test('the two-sample test under the default convention equals SciPy mannwhitneyu', () => {
  const groupValues = (gene, groupName) => {
    const values = column(gene);
    return Float32Array.from(values.filter((_value, cell) => obs.group[cell] === groupName));
  };
  let exactCases = 0;
  for (const entry of REFERENCE.mannwhitneyu) {
    const x = entry.x !== undefined ? Float64Array.from(entry.x) : groupValues(entry.gene, entry.a);
    const y = entry.y !== undefined ? Float64Array.from(entry.y) : groupValues(entry.gene, entry.b);
    const label = entry.gene ? `${entry.a} vs ${entry.b} ${entry.gene}` : `${x.length} vs ${y.length} untied`;
    const result = twoSampleDifferential(geneSampleOf(x, 0), geneSampleOf(y, 1), 'wilcox');
    assert.equal(result.statistic, Math.min(entry.U, x.length * y.length - entry.U), `${label} U`);
    assert.equal(result.auroc, entry.U / (x.length * y.length), `${label} AUROC`);
    assertRelative(result.pValue, entry.p, P_TOLERANCE_RANK, `${label} p (${entry.method})`);
    if (entry.method === 'exact') exactCases++;
  }
  assert.ok(exactCases >= 3, 'the exact distribution is exercised');
});
