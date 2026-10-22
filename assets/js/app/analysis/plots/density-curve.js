/**
 * The density plot's curve: Silverman bandwidth, evaluation grid, weighted
 * support and Gaussian kernel sum, with no dependency on the page or on
 * Plotly, so the analysis workers compute it with the very code the plot
 * module runs.
 *
 * @module plots/density-curve
 */

import { finiteNumbers, getFiniteMinMax, mean, std } from '../shared/number-utils.js';
import {
  DistinctValueIndex,
  MAX_TABULATED_DISTINCT_VALUES,
  kernelDensityAt
} from '../compute/math-utils.js';

/**
 * The evaluation grid and weighted support of a Gaussian kernel density, or
 * the finished curve when no kernel sum is needed.
 *
 * @param {ArrayLike<number>} data - Data points
 * @param {number|'auto'} bandwidth - Kernel bandwidth, or Silverman's rule
 * @param {number} nPoints - Number of points for the output curve
 * @returns {{curve: {x: number[], y: number[]}}|{x: number[], support: Float64Array|Float32Array, weights: Float64Array|null, h: number, n: number}}
 */
function densityPlan(data, bandwidth = 'auto', nPoints = 100) {
  if (!data || data.length === 0) return { curve: { x: [], y: [] } };

  const validData = finiteNumbers(data);
  if (validData.length === 0) return { curve: { x: [], y: [] } };

  const n = validData.length;
  const { min, max } = getFiniteMinMax(validData);
  const range = max - min;

  if (range === 0) return { curve: { x: [min], y: [1] } };

  // Calculate bandwidth using Silverman's rule of thumb if auto
  let h = bandwidth;
  if (bandwidth === 'auto') {
    const stdVal = std(validData);
    h = 1.06 * stdVal * Math.pow(n, -0.2);
    if (h <= 0 || !Number.isFinite(h)) h = range / 10;
  }

  // Generate evaluation points
  const padding = h * 3;
  const x = [];
  const step = (range + 2 * padding) / (nPoints - 1);
  for (let i = 0; i < nPoints; i++) x.push(min - padding + i * step);

  // Every copy of a value contributes the same kernel term, so the sum runs
  // over the distinct values weighted by their counts: prepared expression has
  // at most a few hundred distinct values per gene, which turns 100 x n kernel
  // evaluations into 100 x (distinct values). The weighted sum is the same sum
  // regrouped, so it agrees with the per-value sum to floating-point rounding
  // (relative 1e-12). A sample with more distinct values than the tabulation
  // bound is summed value by value.
  const { values: support, weights } = weightedSupport(validData);
  return { x, support, weights, h, n };
}

/**
 * Distinct values of a finite sample with their multiplicities, or the sample
 * itself with unit weights (`weights: null`) when it has more distinct values
 * than the bound. The sample is then the support as it is — a page's Float32
 * values, which read as the same doubles — rather than a Float64 copy with an
 * array of ones beside it: the analysis workers each receive the support, so
 * it was four times the bytes to copy to every one of them.
 * @param {ArrayLike<number>} data
 * @returns {{ values: Float64Array|Float32Array, weights: Float64Array|null }}
 */
function weightedSupport(data) {
  const index = new DistinctValueIndex();
  const counts = new Float64Array(MAX_TABULATED_DISTINCT_VALUES);
  for (let i = 0; i < data.length; i++) {
    const number = index.numberOf(data[i]);
    if (number === -1) {
      return {
        values: data instanceof Float32Array || data instanceof Float64Array
          ? data
          : Float64Array.from(data),
        weights: null
      };
    }
    counts[number] += 1;
  }
  return {
    values: index.values.subarray(0, index.size),
    weights: counts.subarray(0, index.size)
  };
}

/**
 * Get bandwidth multiplier from option
 */
export function getBandwidthMultiplier(bandwidth) {
  if (bandwidth === 'narrow') return 0.5;
  if (bandwidth === 'wide') return 2;
  return 1;
}

/**
 * The density plan for finite data with a bandwidth multiplier.
 */
export function planDensity(values, bandwidthMult) {
  if (bandwidthMult === 1 || values.length === 0) {
    return densityPlan(values, 'auto');
  }
  const h = 1.06 * std(values) * Math.pow(values.length, -0.2) * bandwidthMult;
  return densityPlan(values, h);
}

/** @param {{x: number[]}} plan @param {ArrayLike<number>} density */
export function curveOf(plan, density) {
  return { x: plan.x, y: Array.from(density) };
}

/**
 * Everything the density plot needs for one page: the curve when the kernel
 * sum is small enough to finish here (fewer than `maxKernelTerms` terms), or
 * the plan whose kernel sum is split across the analysis workers; and the mean
 * the plot's mean line marks.
 *
 * @param {ArrayLike<number>} pageValues - A page's values, non-finite included
 * @param {number} bandwidthMult
 * @param {number} maxKernelTerms
 * @returns {{mean: number, curve?: {x: number[], y: number[]}, plan?: Object}}
 */
export function densityCurveOrPlan(pageValues, bandwidthMult, maxKernelTerms) {
  const finite = finiteNumbers(pageValues);
  const pageMean = finite.length === 0 ? NaN : mean(finite);
  const plan = planDensity(finite, bandwidthMult);
  if (plan.curve !== undefined) return { mean: pageMean, curve: plan.curve };
  if (plan.support.length * plan.x.length < maxKernelTerms) {
    return {
      mean: pageMean,
      curve: curveOf(plan, kernelDensityAt(plan.support, plan.weights, plan.x, plan.h, plan.n))
    };
  }
  return { mean: pageMean, plan };
}
