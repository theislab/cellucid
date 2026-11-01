/**
 * Stored outlier quantiles are accepted for a category of any size (audit
 * NS-4). The rule writes a cell's quantile as `fround(fround(r) / fround(n))`
 * (`rankShare`); above 2^24 placed cells float32 no longer tells neighbouring
 * ranks apart, so a quantile names a range of ranks, and recovering one rank
 * from it (`round(q · n)`) refused quantiles the rule wrote correctly — from
 * about 17M cells in one category every opening read and ranked the whole
 * latent space instead. The check is by ranges: the cells holding each
 * distinct quantile end at a count that must give it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { largestRankOf, rankShare, storedQuantilesDefect } from '../assets/js/data/latent-outliers.js';

/**
 * Quantiles as the rule writes them: `n` cells of category 0 (placed in a
 * scrambled order, ties in runs of three) and `small` cells of category 1.
 */
function ruleQuantiles(n, small) {
  const quantiles = new Float32Array(n + small);
  const codes = new Uint8Array(n + small);
  for (let order = 0; order < n; order++) {
    // The cell at the `order`-th distance, ties sharing their run's end.
    const cell = (order * 7919) % n;
    quantiles[cell] = rankShare(Math.min(n, order - (order % 3) + 3), n);
  }
  for (let k = 0; k < small; k++) {
    codes[n + k] = 1;
    quantiles[n + k] = rankShare(k + 1, small);
  }
  return { quantiles, codes };
}

test('a stored rank range above 2^24 cells is accepted, and a forged one refused', () => {
  const n = 2 ** 24 + 1;
  const { quantiles, codes } = ruleQuantiles(n, 50);
  // Neighbouring ranks share a quantile up here.
  assert.equal(rankShare(n - 1, n), rankShare(n, n));
  assert.equal(storedQuantilesDefect(quantiles, codes, 2, 10), null);

  // The farthest cell no longer at 1: its run of cells ends at n, which gives 1.
  const top = quantiles.indexOf(1);
  const forged = quantiles.slice();
  forged[top] = rankShare(n - 100, n);
  assert.match(storedQuantilesDefect(forged, codes, 2, 10), /category 0 does not rank/);
  // One more cell at the lowest quantile than its range allows.
  const lowest = quantiles.slice();
  lowest[quantiles.indexOf(rankShare(6, n))] = rankShare(3, n);
  assert.match(storedQuantilesDefect(lowest, codes, 2, 10), /category 0 does not rank/);

  // A subsample of these cells: every 101st open, the file's size known.
  const open = [];
  for (let cell = 0; cell < n + 50; cell += 101) open.push(cell);
  assert.equal(
    storedQuantilesDefect(Float32Array.from(open, cell => quantiles[cell]), Uint8Array.from(open, cell => codes[cell]), 2, 10, { nOriginal: n + 50 }),
    null
  );
});

test('the largest rank a quantile names, walking from round(q · n)', () => {
  for (const n of [7, 1000, 2 ** 24 - 1, 2 ** 24 + 1, 50_000_017]) {
    for (const rank of [1, 2, Math.floor(n / 3), n - 1, n]) {
      const q = rankShare(rank, n);
      const largest = largestRankOf(q, n);
      assert.equal(rankShare(largest, n), q, `${n} ${rank}`);
      assert.ok(largest >= rank, `${n} ${rank}: ${largest}`);
      assert.ok(largest === n || rankShare(largest + 1, n) > q, `${n} ${rank}: the largest`);
    }
  }
  assert.equal(largestRankOf(0, 10), 0);
  assert.equal(largestRankOf(1.5, 10), 0);
  // Below 2^24 a quantile names one rank; 0.35 names none of 10 cells.
  assert.equal(largestRankOf(Math.fround(0.35), 10), 0);
});
