/**
 * @fileoverview edgeR's normalization of pseudobulk samples: TMM factors
 * and log-CPM (Robinson & Oshlack 2010, Genome Biol 11:R25; Robinson,
 * McCarthy & Smyth 2010, Bioinformatics 26:139), as pseudobulk differential
 * expression applies them to each sample's summed counts
 * (`stats/pseudobulk.js`).
 *
 * - `tmmNormFactors`: `edgeR::calcNormFactors(y, method = "TMM")`
 *   (`normLibSizes`, edgeR 4.10): genes with no count in any sample are
 *   left out; the reference sample is the one whose upper quartile over its
 *   library size is closest to the mean of them (or, when their median is
 *   under 1e-20, the one with the largest sum of square-root counts); each
 *   sample's factor is the weighted mean of its log-ratios to the reference
 *   (`logratioTrim` 0.3 of M trimmed, `sumTrim` 0.05 of A, weights the
 *   inverse of their asymptotic variances, `Acutoff` -1e10); the factors
 *   are scaled to a geometric mean of 1.
 * - `logCpm`: `edgeR::cpm(y, log = TRUE, prior.count = 2)` on the effective
 *   library sizes (library size × factor): `log2((y + p) / (L + 2p) · 10⁶)`,
 *   the prior `p = 2 · L / mean(L)` scaled by the library, so a gene no
 *   sample counts has one value in every sample.
 *
 * Counts are genes × samples, gene-major (a gene's samples contiguous).
 *
 * @module analysis/stats/edger-normalization
 */

import { computeRanksWithTies } from '../compute/math-utils.js';
import { rMean, rMedian, rQuantile7 } from './limma.js';

/** edgeR's prior count of `cpm(log = TRUE)`. */
export const LOG_CPM_PRIOR_COUNT = 2;

/**
 * edgeR's `.calcFactorTMM` of one sample against the reference.
 *
 * @returns {number}
 */
function tmmFactor(counts, geneRows, sampleCount, sample, reference, libraryOf, referenceLibrary, { logratioTrim, sumTrim, doWeighting, Acutoff }) {
  const nO = libraryOf;
  const nR = referenceLibrary;
  const logR = [];
  const absE = [];
  const variance = [];
  for (const gene of geneRows) {
    const obs = counts[gene * sampleCount + sample];
    const ref = counts[gene * sampleCount + reference];
    const m = Math.log2((obs / nO) / (ref / nR));
    const a = (Math.log2(obs / nO) + Math.log2(ref / nR)) / 2;
    if (!Number.isFinite(m) || !Number.isFinite(a) || !(a > Acutoff)) continue;
    logR.push(m);
    absE.push(a);
    variance.push((nO - obs) / nO / obs + (nR - ref) / nR / ref);
  }
  let largest = -Infinity;
  for (const m of logR) largest = Math.max(largest, Math.abs(m));
  if (largest < 1e-6) return 1;
  const n = logR.length;
  const loL = Math.floor(n * logratioTrim) + 1;
  const hiL = n + 1 - loL;
  const loS = Math.floor(n * sumTrim) + 1;
  const hiS = n + 1 - loS;
  const rankM = computeRanksWithTies(Float64Array.from(logR)).ranks;
  const rankA = computeRanksWithTies(Float64Array.from(absE)).ranks;
  let numerator = 0;
  let denominator = 0;
  let total = 0;
  let kept = 0;
  for (let i = 0; i < n; i++) {
    if (!(rankM[i] >= loL && rankM[i] <= hiL && rankA[i] >= loS && rankA[i] <= hiS)) continue;
    if (doWeighting) {
      const term = logR[i] / variance[i];
      const weight = 1 / variance[i];
      if (!Number.isNaN(term)) numerator += term;
      if (!Number.isNaN(weight)) denominator += weight;
    } else {
      total += logR[i];
      kept += 1;
    }
  }
  let f = doWeighting ? numerator / denominator : total / kept;
  if (Number.isNaN(f)) f = 0;
  return 2 ** f;
}

/**
 * edgeR's TMM normalization factors.
 *
 * @param {ArrayLike<number>} counts - genes × samples, gene-major; finite, ≥ 0
 * @param {number} geneCount
 * @param {number} sampleCount
 * @param {ArrayLike<number>} librarySizes - Each sample's library size (> 0)
 * @param {{logratioTrim?: number, sumTrim?: number, doWeighting?: boolean, Acutoff?: number}} [options]
 * @returns {{factors: Float64Array, reference: number, genesUsed: number}}
 *   `reference` the reference sample (-1: none, every factor 1), `genesUsed`
 *   the genes with a count in some sample
 */
export function tmmNormFactors(counts, geneCount, sampleCount, librarySizes, {
  logratioTrim = 0.3, sumTrim = 0.05, doWeighting = true, Acutoff = -1e10
} = {}) {
  if (counts.length !== geneCount * sampleCount) throw new RangeError('TMM counts are genes × samples');
  if (librarySizes.length !== sampleCount) throw new RangeError('TMM needs one library size a sample');
  for (let i = 0; i < counts.length; i++) {
    if (!(counts[i] >= 0) || counts[i] === Infinity) throw new RangeError('TMM counts must be finite and not negative');
  }
  for (let s = 0; s < sampleCount; s++) {
    if (!(librarySizes[s] > 0) || librarySizes[s] === Infinity) throw new RangeError('Every sample needs a library size above 0');
  }
  const geneRows = [];
  for (let gene = 0; gene < geneCount; gene++) {
    for (let s = 0; s < sampleCount; s++) {
      if (counts[gene * sampleCount + s] > 0) {
        geneRows.push(gene);
        break;
      }
    }
  }
  const factors = new Float64Array(sampleCount).fill(1);
  if (geneRows.length === 0 || sampleCount === 1) return { factors, reference: -1, genesUsed: geneRows.length };
  // The reference: upper quartile over library size closest to their mean.
  const upperQuartile = new Float64Array(sampleCount);
  const column = new Float64Array(geneRows.length);
  for (let s = 0; s < sampleCount; s++) {
    geneRows.forEach((gene, k) => { column[k] = counts[gene * sampleCount + s]; });
    upperQuartile[s] = rQuantile7(Float64Array.from(column).sort(), 0.75) / librarySizes[s];
  }
  let reference = 0;
  if (rMedian(upperQuartile) < 1e-20) {
    let best = -Infinity;
    for (let s = 0; s < sampleCount; s++) {
      let sum = 0;
      for (const gene of geneRows) sum += Math.sqrt(counts[gene * sampleCount + s]);
      if (sum > best) {
        best = sum;
        reference = s;
      }
    }
  } else {
    const mean = rMean(upperQuartile);
    let best = Infinity;
    for (let s = 0; s < sampleCount; s++) {
      const distance = Math.abs(upperQuartile[s] - mean);
      if (distance < best) {
        best = distance;
        reference = s;
      }
    }
  }
  const options = { logratioTrim, sumTrim, doWeighting, Acutoff };
  for (let s = 0; s < sampleCount; s++) {
    factors[s] = tmmFactor(counts, geneRows, sampleCount, s, reference, librarySizes[s], librarySizes[reference], options);
  }
  const logs = Float64Array.from(factors, Math.log);
  const geometricMean = Math.exp(rMean(logs));
  for (let s = 0; s < sampleCount; s++) factors[s] /= geometricMean;
  return { factors, reference, genesUsed: geneRows.length };
}

/**
 * edgeR's `cpm(log = TRUE, prior.count)` with the effective library sizes.
 *
 * @param {ArrayLike<number>} counts - genes × samples, gene-major
 * @param {number} geneCount
 * @param {number} sampleCount
 * @param {ArrayLike<number>} effectiveLibrarySizes - library size × norm factor
 * @param {number} [priorCount=LOG_CPM_PRIOR_COUNT]
 * @returns {Float64Array} genes × samples, gene-major
 */
export function logCpm(counts, geneCount, sampleCount, effectiveLibrarySizes, priorCount = LOG_CPM_PRIOR_COUNT) {
  if (counts.length !== geneCount * sampleCount) throw new RangeError('log-CPM counts are genes × samples');
  let total = 0;
  for (let s = 0; s < sampleCount; s++) total += effectiveLibrarySizes[s];
  const meanLibrary = total / sampleCount;
  const prior = new Float64Array(sampleCount);
  const logLibrary = new Float64Array(sampleCount);
  for (let s = 0; s < sampleCount; s++) {
    prior[s] = (priorCount * effectiveLibrarySizes[s]) / meanLibrary;
    logLibrary[s] = Math.log(effectiveLibrarySizes[s] + 2 * prior[s]);
  }
  const logMillion = Math.log(1e6);
  const out = new Float64Array(counts.length);
  for (let gene = 0; gene < geneCount; gene++) {
    const base = gene * sampleCount;
    for (let s = 0; s < sampleCount; s++) {
      out[base + s] = (Math.log(counts[base + s] + prior[s]) - logLibrary[s] + logMillion) / Math.LN2;
    }
  }
  return out;
}
