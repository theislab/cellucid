/**
 * One significance convention across the analysis module.
 *
 * A p-value clears a threshold when `p <= threshold`, never `p < threshold`.
 * That is the rule the Benjamini-Hochberg step-up implements — reject the k
 * smallest ordered p-values where k* = max{k : p(k) <= k*alpha/m}, so an
 * adjusted value of exactly alpha is a rejection. The marker, volcano and
 * differential-expression filters used `p < threshold`, so a gene sitting
 * exactly on the threshold was significant by one surface and not by another.
 *
 * The boundary is not measure zero. Exact tests on discrete data land on it:
 *   scipy.stats.mannwhitneyu([100], list(range(39)), alternative='two-sided',
 *                            method='exact')
 *     -> MannwhitneyuResult(statistic=39.0, pvalue=0.05)
 * is exactly the default threshold, as a double, with no rounding anywhere.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mannWhitneyU as coreMannWhitneyU } from '../assets/js/app/analysis/compute/math-utils.js';
import {
  benjaminiHochbergAdjusted,
  mannWhitneyU,
} from '../assets/js/app/analysis/stats/statistical-tests.js';
import { rankGroupGenes } from '../assets/js/app/analysis/genes-panel/marker-selection.js';
import volcanoPlotDefinition from '../assets/js/app/analysis/plots/types/volcanoplot.js';

const ANALYSIS_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../assets/js/app/analysis',
);

const BOUNDARY_ALPHA = 0.05;

/**
 * The next representable double above a positive finite value. The point of the
 * boundary tests is that "just over the threshold" means one bit over, not a
 * comfortable margin that would pass under either convention.
 */
function nextDoubleAbove(value) {
  const buffer = new ArrayBuffer(8);
  const floats = new Float64Array(buffer);
  const bits = new BigUint64Array(buffer);
  floats[0] = value;
  bits[0] += 1n;
  return floats[0];
}

const JUST_OVER_ALPHA = nextDoubleAbove(BOUNDARY_ALPHA);

function volcanoOptions(overrides = {}) {
  return {
    pValueThreshold: BOUNDARY_ALPHA,
    foldChangeThreshold: 1,
    useAdjustedPValue: false,
    labelTopN: 0,
    pointSize: 6,
    showThresholdLines: false,
    highlightGenes: [],
    ...overrides,
  };
}

test('an exact rank test lands on the default threshold as a double', () => {
  // One observation above 39 untied observations: U = 0, and the two-sided
  // exact probability is 2 * 1 / C(40, 1) = 1/20 with no rounding at all.
  const sample = Array.from({ length: 39 }, (_unused, index) => index);
  const core = coreMannWhitneyU([100], sample);
  assert.equal(core.pValueMethod, 'exact');
  assert.equal(core.pValue, BOUNDARY_ALPHA);
  assert.equal(mannWhitneyU([100], sample).pValue, BOUNDARY_ALPHA);
});

test('the step-up adjustment keeps a lone boundary p-value exactly on alpha', () => {
  const bh = benjaminiHochbergAdjusted(Float64Array.of(BOUNDARY_ALPHA));
  assert.deepEqual(Array.from(bh.adjustedPValues), [BOUNDARY_ALPHA]);
});

test('the volcano surfaces count a boundary gene as a discovery', () => {
  const deResults = {
    results: [
      // Exactly on both thresholds.
      { gene: 'BOUNDARY_UP', pValue: BOUNDARY_ALPHA, adjustedPValue: BOUNDARY_ALPHA, log2FoldChange: 1 },
      { gene: 'BOUNDARY_DOWN', pValue: BOUNDARY_ALPHA, adjustedPValue: BOUNDARY_ALPHA, log2FoldChange: -1 },
      // One representable step above the threshold: still not significant.
      {
        gene: 'JUST_OVER',
        pValue: JUST_OVER_ALPHA,
        adjustedPValue: JUST_OVER_ALPHA,
        log2FoldChange: 3,
      },
    ],
  };

  const summary = volcanoPlotDefinition.getSummary(deResults, volcanoOptions());
  assert.equal(summary.total, 3);
  assert.equal(summary.upregulated, 1);
  assert.equal(summary.downregulated, 1);
  assert.equal(summary.notSignificant, 1);
  assert.equal(summary.untestable, 0);
  assert.equal(summary.significantTotal, 2);

  const exported = volcanoPlotDefinition.exportCSV(deResults, volcanoOptions());
  const byGene = Object.fromEntries(
    exported.rows.map(row => [row.gene, row]),
  );
  assert.equal(byGene.BOUNDARY_UP.significant, 'yes');
  assert.equal(byGene.BOUNDARY_UP.direction, 'up');
  assert.equal(byGene.BOUNDARY_DOWN.significant, 'yes');
  assert.equal(byGene.BOUNDARY_DOWN.direction, 'down');
  assert.equal(byGene.JUST_OVER.significant, 'no');
  assert.equal(byGene.JUST_OVER.direction, 'ns');
});

test('the marker filter keeps a gene whose adjusted p-value equals the threshold', () => {
  const stats = {
    genes: ['BOUNDARY', 'ABOVE'],
    groups: [{ groupId: 'g', groupName: 'g', tested: true }],
    adjustedPValuesByGroup: [Float64Array.of(BOUNDARY_ALPHA, 0.0500001)],
    pValuesByGroup: [Float64Array.of(0.01, 0.01)],
    scoresByGroup: [Float32Array.of(2, 3)],
    log2FoldChangeByGroup: [Float32Array.of(1, 1)],
    pctInByGroup: [Float32Array.of(50, 50)],
    pctRefByGroup: [Float32Array.of(10, 10)],
    aurocByGroup: [Float32Array.of(0.8, 0.8)],
    meanInGroupByGroup: [Float32Array.of(1, 1)],
  };
  const order = rankGroupGenes(stats, 0, {
    direction: 'up', maxAdjP: BOUNDARY_ALPHA, minLog2FC: 0, minPctIn: 0, maxPctRef: 100, rankBy: 'score',
  });
  assert.deepEqual(Array.from(order, i => stats.genes[i]), ['BOUNDARY']);
});

async function collectAnalysisSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectAnalysisSources(path));
    } else if (entry.name.endsWith('.js')) {
      files.push(path);
    }
  }
  return files;
}

test('no analysis surface compares a p-value to its threshold strictly', async () => {
  const files = await collectAnalysisSources(ANALYSIS_ROOT);
  assert.ok(files.length > 50, 'the analysis module must have been walked');

  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const lines = source.split('\n');
    for (const [index, line] of lines.entries()) {
      // Only the two forms that decide significance: `p < threshold` and its
      // negation `p >= threshold`. The validators compare the threshold itself
      // to a numeric literal (`pValueThreshold <= 0`), which is a different
      // statement and is not matched here.
      if (/(?:<|>=)\s*pValueThreshold\b/.test(line)) {
        offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `strict p-value threshold comparisons must not exist:\n${offenders.join('\n')}`,
  );
});
