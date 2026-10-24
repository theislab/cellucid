/**
 * Dot plot values match scanpy's `pl.dotplot` (`dot_color_df`,
 * `dot_size_df`; `tests/fixtures/analysis/scanpy-reference.json`, key
 * `dotplot`): the mean per group, the fraction of cells above the
 * expression cutoff, `standard_scale='var'`, `mean_only_expressed`, a
 * cutoff above 0, and a layer with negative values — from the per-group
 * sums of one O(nnz) pass (`compute/group-expression-summary.js`), fed with
 * sparse samples and with dense columns alike. Also the dot size rule
 * (area ∝ fraction^1.5 up to the largest fraction rounded up to 10%).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createGroupSummaryContext,
  groupSummaryValues,
  scaleByGene,
  summarizeGenesByGroup
} from '../assets/js/app/analysis/compute/group-expression-summary.js';
import { dotDiameter, dotMaxFraction } from '../assets/js/app/analysis/plots/types/dotplot.js';

const reference = JSON.parse(readFileSync(new URL('./fixtures/analysis/scanpy-reference.json', import.meta.url), 'utf8'));
const { data, dotplot } = reference;

// scanpy averages float32 values in float32; the sums here are float64.
const TOLERANCE = 1e-6;

function column(gene, offset = 0) {
  const at = data.var_names.indexOf(gene);
  return Float32Array.from(data.X, row => row[at] + offset);
}

function sparse(dense) {
  const indices = [];
  const values = [];
  dense.forEach((value, cell) => {
    if (value !== 0) {
      indices.push(cell);
      values.push(value);
    }
  });
  return { length: dense.length, indices: Uint32Array.from(indices), values: Float32Array.from(values) };
}

function context() {
  const index = new Map(dotplot.groups.map((name, i) => [name, i]));
  return createGroupSummaryContext(Int16Array.from(data.obs.group, name => index.get(name)), dotplot.groups.length);
}

function compare(actual, expected, label) {
  const groups = dotplot.groups.length;
  expected.forEach((row, group) => row.forEach((value, gene) => {
    const got = actual[gene * groups + group];
    assert.ok(Math.abs(got - value) <= TOLERANCE, `${label} ${dotplot.groups[group]} ${dotplot.genes[gene]}: ${got} vs ${value}`);
  }));
}

function run(name, { cutoff = 0, offset = 0, dense = false } = {}) {
  const genes = dotplot.genes.map(gene => {
    const values = column(gene, offset);
    return dense ? values : sparse(values);
  });
  const summary = summarizeGenesByGroup(context(), genes, cutoff);
  return { summary, values: groupSummaryValues(summary), expected: dotplot.cases[name] };
}

test('mean and fraction expressing per group, sparse and dense alike', () => {
  for (const dense of [false, true]) {
    const { values, expected } = run('plain', { dense });
    compare(values.mean, expected.color, `mean (${dense ? 'dense' : 'sparse'})`);
    compare(values.fraction, expected.size, `fraction (${dense ? 'dense' : 'sparse'})`);
  }
});

test('standard_scale var scales each gene to 0–1 over the groups', () => {
  const { summary, values, expected } = run('var');
  compare(scaleByGene(values.mean, summary.geneCount, summary.groupCount, 'var'), expected.color, 'scaled');
});

test('mean of expressing cells only, and a cutoff above zero', () => {
  const expressing = run('expressing');
  compare(expressing.values.meanExpressing, expressing.expected.color, 'mean of expressing');
  const cutoff = run('cutoff', { cutoff: 1.5 });
  compare(cutoff.values.mean, cutoff.expected.color, 'mean, cutoff 1.5');
  compare(cutoff.values.fraction, cutoff.expected.size, 'fraction above 1.5');
});

test('negative values (a scaled layer): zeros are not expressed, means include negatives', () => {
  const { values, expected } = run('scaled', { offset: -1, dense: true });
  compare(values.mean, expected.color, 'scaled mean');
  compare(values.fraction, expected.size, 'scaled fraction');
});

test('z per gene uses the population SD; a flat gene is 0', () => {
  const z = scaleByGene(Float64Array.from([1, 2, 3, 5, 5, 5]), 2, 3, 'z');
  const sd = Math.sqrt(2 / 3);
  assert.deepEqual([...z].map(v => Number(v.toFixed(12))), [-1 / sd, 0, 1 / sd, 0, 0, 0].map(v => Number(v.toFixed(12))));
  assert.throws(() => scaleByGene(new Float64Array(1), 1, 1, 'rank'), /Unknown dot plot scale/);
});

test('dot sizes: area grows as fraction^1.5 up to the largest fraction rounded up to 10%', () => {
  assert.equal(dotMaxFraction(Float64Array.from([0.05, 0.42, NaN])), 0.5);
  assert.equal(dotMaxFraction(Float64Array.from([0, 0])), 1);
  assert.equal(dotMaxFraction(Float64Array.from([0.3])), 0.3);
  assert.equal(dotDiameter(0, 0.5, 20), 0);
  assert.equal(dotDiameter(0.5, 0.5, 20), 20);
  const quarter = dotDiameter(0.125, 0.5, 20);
  assert.ok(Math.abs((quarter / 20) ** 2 - 0.25 ** 1.5) < 1e-12, 'area ratio is the fraction ratio to the 1.5');
});

test('a group summary context refuses a cell in no declared group', () => {
  assert.throws(() => createGroupSummaryContext(Int16Array.from([0, 3]), 2), /names group 3 of 2/);
  assert.throws(() => summarizeGenesByGroup(context(), [new Float32Array(3)], 0), /has 3 cells/);
});

test('a stacked violin\'s bins: every grouped cell once, zeros in the bin holding 0', () => {
  const genes = dotplot.genes.map(gene => sparse(column(gene)));
  const ctx = context();
  const bins = 40;
  const summary = summarizeGenesByGroup(ctx, genes, 0, bins);
  const groups = dotplot.groups.length;
  dotplot.genes.forEach((gene, g) => {
    const dense = column(gene);
    const low = summary.range[2 * g];
    const high = summary.range[2 * g + 1];
    assert.equal(low, Math.min(0, ...dense));
    assert.equal(high, Math.max(...dense));
    const expected = new Uint32Array(groups * bins);
    dense.forEach((value, cell) => {
      const group = ctx.cellGroup[cell];
      const bin = Math.min(bins - 1, Math.max(0, Math.floor((value - low) * bins / (high - low))));
      expected[group * bins + bin] += 1;
    });
    assert.deepEqual(
      [...summary.histogram.subarray(g * groups * bins, (g + 1) * groups * bins)],
      [...expected],
      gene
    );
  });
  // Without bins nothing is binned.
  assert.equal(summarizeGenesByGroup(ctx, genes, 0).histogram.length, 0);
});
