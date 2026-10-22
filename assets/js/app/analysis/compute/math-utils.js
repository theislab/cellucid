/**
 * Shared Mathematical Utilities for Compute Module
 *
 * Centralizes all mathematical and statistical helper functions used by:
 * - data-worker.js
 * - operation-handlers.js
 *
 * This eliminates code duplication and ensures consistent implementations.
 */

// ============================================================================
// Basic Statistical Functions
// ============================================================================

/**
 * Calculate mean of an array.
 *
 * @param {number[]} arr - Array of numeric values
 * @returns {number} Mean value, or NaN if empty
 */
export function mean(arr) {
  if (!arr || arr.length === 0) return NaN;
  // Left-to-right accumulation from 0, i.e. exactly what `reduce` performed,
  // written as an index loop so a TypedArray is not walked through a callback.
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

/**
 * Calculate variance of an array.
 *
 * @param {number[]} arr - Array of numeric values
 * @param {number} [ddof=0] - Delta degrees of freedom (0 for population, 1 for sample)
 * @returns {number} Variance, or NaN if insufficient data
 */
export function variance(arr, ddof = 0) {
  if (!arr || arr.length <= ddof) return NaN;
  const m = mean(arr);
  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) sumSq += (arr[i] - m) ** 2;
  return sumSq / (arr.length - ddof);
}

/**
 * Calculate standard deviation of an array.
 *
 * @param {number[]} arr - Array of numeric values
 * @param {number} [ddof=0] - Delta degrees of freedom (0 for population, 1 for sample)
 * @returns {number} Standard deviation
 */
export function std(arr, ddof = 0) {
  return Math.sqrt(variance(arr, ddof));
}

/**
 * Sample mean and sample variance (ddof = 1) from one pass pair.
 *
 * Two passes in the same left-to-right order `mean()` and `variance(arr, 1)`
 * use, so the moments are bit identical to calling those two functions — but
 * the mean is accumulated once instead of twice. Callers that need both moments
 * (Welch's t-test and its display wrapper) go through here so that a two-group
 * comparison walks each group exactly twice rather than four times.
 *
 * @param {ArrayLike<number>} values
 * @returns {{mean: number, variance: number, n: number}} `NaN` moments when
 *   fewer than two values are present.
 */
export function sampleMoments(values) {
  const n = values.length;
  if (n < 2) return { mean: n === 1 ? values[0] : NaN, variance: NaN, n };

  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const m = sum / n;

  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += (values[i] - m) ** 2;

  return { mean: m, variance: sumSq / (n - 1), n };
}

// ============================================================================
// Statistical Distribution Functions
// ============================================================================

/**
 * Standard-normal survival function P(Z > z).
 *
 * The gamma relationship evaluates positive tails directly, avoiding the
 * catastrophic cancellation caused by subtracting a CDF rounded to one.
 *
 * @param {number} z - Z-score value
 * @returns {number} Upper-tail probability
 */
export function normalSurvival(z) {
  if (Number.isNaN(z)) return NaN;
  if (z === Infinity) return 0;
  if (z === -Infinity) return 1;

  const positiveTail = 0.5 * regularizedGammaQ(0.5, (z * z) / 2);
  return z >= 0 ? positiveTail : 1 - positiveTail;
}

/**
 * Standard-normal cumulative distribution function P(Z <= z).
 *
 * @param {number} z - Z-score value
 * @returns {number} Cumulative probability
 */
function normalCDF(z) {
  return normalSurvival(-z);
}

/**
 * Student t-distribution CDF.
 *
 * Uses the regularized incomplete beta identity for finite degrees of freedom.
 * This remains important around common significance thresholds even at
 * moderately large df, where substituting the normal CDF can change the
 * reported significance.
 *
 * @param {number} t - T-statistic value
 * @param {number} df - Degrees of freedom
 * @returns {number} Cumulative probability
 */
export function tCDF(t, df) {
  if (Number.isNaN(t) || df <= 0 || Number.isNaN(df)) return NaN;
  if (t === -Infinity) return 0;
  if (t === Infinity) return 1;
  if (df === Infinity) return normalCDF(t);
  if (!Number.isFinite(t) || !Number.isFinite(df)) return NaN;

  const x = df / (df + t * t);
  const lowerTail = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return t < 0 ? lowerTail : 1 - lowerTail;
}

/**
 * Two-sided Student t p-value evaluated through the stable lower tail.
 *
 * @param {number} t - T statistic
 * @param {number} df - Degrees of freedom
 * @returns {number} Two-sided p-value
 */
export function tTwoSidedPValue(t, df) {
  if (Number.isNaN(t)) return NaN;
  const pValue = 2 * tCDF(-Math.abs(t), df);
  return Number.isNaN(pValue) ? NaN : Math.min(1, Math.max(0, pValue));
}

/**
 * Incomplete beta function approximation using continued fraction method.
 *
 * @param {number} x - Value in [0, 1]
 * @param {number} a - Shape parameter a
 * @param {number} b - Shape parameter b
 * @returns {number} Incomplete beta function value
 */
function incompleteBeta(x, a, b) {
  if (x === 0) return 0;
  if (x === 1) return 1;

  if (x > (a + 1) / (a + b + 2)) {
    return 1 - incompleteBeta(1 - x, b, a);
  }

  const bt = Math.exp(
    gammaLn(a + b) - gammaLn(a) - gammaLn(b) +
    a * Math.log(x) + b * Math.log(1 - x)
  );

  // Continued fraction
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= 100; m++) {
    const m2 = 2 * m;

    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    h *= d * c;

    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;

    if (Math.abs(del - 1) < 1e-10) break;
  }

  return bt * h / a;
}

/**
 * Log gamma function using Lanczos approximation.
 * Accurate to about 15 decimal places.
 *
 * @param {number} z - Input value
 * @returns {number} Natural log of gamma(z)
 */
export function gammaLn(z) {
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7
  ];

  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - gammaLn(1 - z);
  }

  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) {
    x += c[i] / (z + i);
  }

  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

const GAMMA_EPSILON = 1e-14;
const GAMMA_MIN_ITERATIONS = 1000;
const GAMMA_MAX_ITERATIONS = 100000;
const GAMMA_FPMIN = 1e-300;

function regularizedGammaSeries(a, x) {
  let sum = 1 / a;
  let term = sum;
  let ap = a;
  const maxIterations = Math.min(
    GAMMA_MAX_ITERATIONS,
    Math.max(GAMMA_MIN_ITERATIONS, Math.ceil(16 * Math.sqrt(a)))
  );

  for (let n = 1; n <= maxIterations; n++) {
    ap += 1;
    term *= x / ap;
    sum += term;
    if (Math.abs(term) <= Math.abs(sum) * GAMMA_EPSILON) {
      return sum * Math.exp(-x + a * Math.log(x) - gammaLn(a));
    }
  }
  return NaN;
}

function regularizedGammaContinuedFraction(a, x) {
  let b = x + 1 - a;
  if (Math.abs(b) < GAMMA_FPMIN) b = GAMMA_FPMIN;

  let c = 1 / GAMMA_FPMIN;
  let d = 1 / b;
  let h = d;
  const maxIterations = Math.min(
    GAMMA_MAX_ITERATIONS,
    Math.max(GAMMA_MIN_ITERATIONS, Math.ceil(16 * Math.sqrt(a)))
  );

  for (let i = 1; i <= maxIterations; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < GAMMA_FPMIN) d = GAMMA_FPMIN;
    c = b + an / c;
    if (Math.abs(c) < GAMMA_FPMIN) c = GAMMA_FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) <= GAMMA_EPSILON) {
      return Math.exp(-x + a * Math.log(x) - gammaLn(a)) * h;
    }
  }
  return NaN;
}

/**
 * Regularized upper incomplete gamma Q(a, x).
 *
 * @param {number} a - Positive shape parameter
 * @param {number} x - Non-negative evaluation point
 * @returns {number} Upper-tail probability in [0, 1]
 */
function regularizedGammaQ(a, x) {
  if (!(a > 0) || x < 0 || Number.isNaN(x)) return NaN;
  if (x === 0) return 1;
  if (x === Infinity) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(x)) return NaN;

  const value = x < a + 1
    ? 1 - regularizedGammaSeries(a, x)
    : regularizedGammaContinuedFraction(a, x);
  return Math.min(1, Math.max(0, value));
}

/**
 * Calculate chi-squared p-value (upper tail).
 *
 * @param {number} statistic - Chi-squared statistic value
 * @param {number} df - Degrees of freedom
 * @returns {number} P-value
 */
export function chiSquaredPValue(statistic, df) {
  if (!Number.isFinite(df) || df <= 0 || Number.isNaN(statistic)) return NaN;
  if (statistic <= 0) return 1;
  if (statistic === Infinity) return 0;
  const probability = regularizedGammaQ(df / 2, statistic / 2);
  if (!Number.isNaN(probability)) return probability;

  const z = (Math.cbrt(statistic / df) - (1 - 2 / (9 * df))) /
    Math.sqrt(2 / (9 * df));
  return normalSurvival(z);
}

/**
 * F-distribution p-value approximation using incomplete beta function.
 *
 * @param {number} f - F-statistic value
 * @param {number} df1 - Numerator degrees of freedom
 * @param {number} df2 - Denominator degrees of freedom
 * @returns {number} P-value (upper tail)
 */
export function fDistributionPValue(f, df1, df2) {
  if (!Number.isFinite(df1) || !Number.isFinite(df2) || df1 <= 0 || df2 <= 0) {
    return NaN;
  }
  if (Number.isNaN(f)) return NaN;
  if (f <= 0) return 1;
  if (f === Infinity) return 0;
  // Using beta function approximation
  const x = df2 / (df2 + df1 * f);
  return incompleteBeta(x, df2 / 2, df1 / 2);
}

// ============================================================================
// Correlation Functions
// ============================================================================

// ============================================================================
// Linear-time Ordering
// ============================================================================
//
// Every order statistic, rank and sorted copy in the analysis layer used to come
// from a comparison sort: the engine's native numeric sort for a sorted copy,
// and an index sort driven by a JavaScript comparator for ranks. Both are
// O(n log n), and the comparator form runs a callback per comparison — about a
// second for the ranks of one million distinct values.
//
// An IEEE-754 number maps to an unsigned key whose unsigned order is the
// number's numeric order (flip every bit of a negative, set the sign bit of a
// positive), so a least-significant-digit radix sort orders numbers in a fixed
// number of linear passes. The order it produces is exactly the native numeric
// sort's: ascending, -0 before +0 (their keys are adjacent and distinct), and
// NaN last (every NaN is given the canonical quiet-NaN key, the largest).

/**
 * Below this many values an index permutation is ordered through a comparator
 * at least as fast as by radix.
 */
const RADIX_MIN_LENGTH = 1024;

/**
 * Below this many values the engine's native numeric sort (compiled code,
 * O(n log n)) produces a sorted copy, or the few order statistics a caller
 * needs, faster than a radix pass that has not been optimized yet: they cross
 * near 200,000 values on a first call.
 */
const NATIVE_SORT_MAX_LENGTH = 131072;

const SIGN_BIT = 0x80000000;

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * Whether every value is exactly a float32 number (or NaN), so 32-bit keys
 * order it without loss.
 * @param {ArrayLike<number>} values
 */
function holdsFloat32Values(values) {
  if (
    values instanceof Float32Array ||
    values instanceof Int8Array ||
    values instanceof Uint8Array ||
    values instanceof Uint8ClampedArray ||
    values instanceof Int16Array ||
    values instanceof Uint16Array
  ) {
    return true;
  }
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (Math.fround(value) !== value && value === value) return false;
  }
  return true;
}

/**
 * Order-preserving 32-bit keys of float32-exact values.
 * @param {ArrayLike<number>} values
 * @returns {Uint32Array}
 */
function float32Keys(values) {
  const n = values.length;
  const floats = new Float32Array(n);
  if (values instanceof Float32Array) floats.set(values);
  else for (let i = 0; i < n; i++) floats[i] = values[i];
  const keys = new Uint32Array(floats.buffer);
  for (let i = 0; i < n; i++) {
    let bits = keys[i];
    if ((bits & 0x7fffffff) > 0x7f800000) bits = 0x7fc00000;
    keys[i] = (bits & SIGN_BIT) ? ~bits : (bits | SIGN_BIT);
  }
  return keys;
}

/**
 * Order-preserving 64-bit keys, as separate low and high words.
 * @param {ArrayLike<number>} values
 * @returns {{lo: Uint32Array, hi: Uint32Array}}
 */
function float64Keys(values) {
  const n = values.length;
  const doubles = new Float64Array(n);
  if (values instanceof Float64Array) doubles.set(values);
  else for (let i = 0; i < n; i++) doubles[i] = values[i];
  const words = new Uint32Array(doubles.buffer);
  const lo = new Uint32Array(n);
  const hi = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let low = words[2 * i];
    let high = words[2 * i + 1];
    const magnitude = high & 0x7fffffff;
    if (magnitude > 0x7ff00000 || (magnitude === 0x7ff00000 && low !== 0)) {
      high = 0x7ff80000;
      low = 0;
    }
    if (high & SIGN_BIT) {
      hi[i] = ~high;
      lo[i] = ~low;
    } else {
      hi[i] = high | SIGN_BIT;
      lo[i] = low;
    }
  }
  return { lo, hi };
}

/**
 * Stable least-significant-digit radix sort of 32-bit keys, carrying an
 * optional payload. Digits every key shares are skipped.
 *
 * @param {Uint32Array} keys - Reordered or replaced; use the returned arrays
 * @param {Uint32Array|null} payload
 * @param {Uint32Array|null} [scratch] - Key-sized space the sort may use
 * @returns {{keys: Uint32Array, payload: Uint32Array|null}} `keys` is either
 *   the given keys array or the scratch array
 */
function radixSort32(keys, payload, scratch = null) {
  const n = keys.length;
  let fromKeys = keys;
  let toKeys = scratch ?? new Uint32Array(n);
  let fromPayload = payload;
  let toPayload = payload === null ? null : new Uint32Array(n);
  const counts = new Uint32Array(2048);
  for (let shift = 0; shift < 32; shift += 11) {
    const mask = shift === 22 ? 0x3ff : 0x7ff;
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[(fromKeys[i] >>> shift) & mask]++;
    if (counts[(fromKeys[0] >>> shift) & mask] === n) continue;
    let total = 0;
    for (let digit = 0; digit <= mask; digit++) {
      const count = counts[digit];
      counts[digit] = total;
      total += count;
    }
    if (fromPayload === null) {
      for (let i = 0; i < n; i++) {
        const key = fromKeys[i];
        toKeys[counts[(key >>> shift) & mask]++] = key;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const key = fromKeys[i];
        const at = counts[(key >>> shift) & mask]++;
        toKeys[at] = key;
        toPayload[at] = fromPayload[i];
      }
      const swapPayload = fromPayload;
      fromPayload = toPayload;
      toPayload = swapPayload;
    }
    const swapKeys = fromKeys;
    fromKeys = toKeys;
    toKeys = swapKeys;
  }
  return { keys: fromKeys, payload: fromPayload };
}

/**
 * Stable least-significant-digit radix sort of 64-bit keys (16-bit digits),
 * carrying an optional payload. Digits every key shares are skipped. The keys
 * are unsigned: `hi` is the more significant word.
 *
 * @param {Uint32Array} lo
 * @param {Uint32Array} hi
 * @param {Uint32Array|null} payload
 * @returns {{lo: Uint32Array, hi: Uint32Array, payload: Uint32Array|null}}
 */
export function radixSort64(lo, hi, payload) {
  const n = lo.length;
  const counts = new Uint32Array(4 * 65536);
  for (let i = 0; i < n; i++) {
    const low = lo[i];
    const high = hi[i];
    counts[low & 0xffff]++;
    counts[65536 + (low >>> 16)]++;
    counts[131072 + (high & 0xffff)]++;
    counts[196608 + (high >>> 16)]++;
  }
  let fromLo = lo;
  let fromHi = hi;
  let fromPayload = payload;
  let toLo = new Uint32Array(n);
  let toHi = new Uint32Array(n);
  let toPayload = payload === null ? null : new Uint32Array(n);
  for (let pass = 0; pass < 4; pass++) {
    const base = pass * 65536;
    const digitWord = pass < 2 ? fromLo : fromHi;
    const shift = pass % 2 === 0 ? 0 : 16;
    if (counts[base + ((digitWord[0] >>> shift) & 0xffff)] === n) continue;
    let total = 0;
    for (let digit = 0; digit < 65536; digit++) {
      const count = counts[base + digit];
      counts[base + digit] = total;
      total += count;
    }
    for (let i = 0; i < n; i++) {
      const at = counts[base + ((digitWord[i] >>> shift) & 0xffff)]++;
      toLo[at] = fromLo[i];
      toHi[at] = fromHi[i];
      if (fromPayload !== null) toPayload[at] = fromPayload[i];
    }
    let swap = fromLo; fromLo = toLo; toLo = swap;
    swap = fromHi; fromHi = toHi; toHi = swap;
    if (fromPayload !== null) {
      swap = fromPayload; fromPayload = toPayload; toPayload = swap;
    }
  }
  return { lo: fromLo, hi: fromHi, payload: fromPayload };
}

/**
 * The values sorted ascending into a new Float64Array — exactly
 * `Float64Array.from(values).sort()`: numeric order, -0 before +0, NaN last —
 * in linear time.
 *
 * @param {ArrayLike<number>} values
 * @returns {Float64Array}
 */
export function sortedAscending(values) {
  const n = values.length;
  if (n < NATIVE_SORT_MAX_LENGTH || !LITTLE_ENDIAN) {
    const copy = new Float64Array(n);
    for (let i = 0; i < n; i++) copy[i] = values[i];
    return copy.sort();
  }
  const sorted = new Float64Array(n);
  if (holdsFloat32Values(values)) {
    // The output's first half is the sort's scratch space. When the sorted
    // keys end there, they are decoded in place from the last to the first:
    // value i overwrites key slots 2i and 2i+1, which are read already.
    const scratch = new Uint32Array(sorted.buffer, 0, n);
    const keys = radixSort32(float32Keys(values), null, scratch).keys;
    const bits = new Uint32Array(1);
    const float = new Float32Array(bits.buffer);
    if (keys === scratch) {
      for (let i = n - 1; i >= 0; i--) {
        const key = keys[i];
        bits[0] = (key & SIGN_BIT) ? (key ^ SIGN_BIT) : ~key;
        sorted[i] = float[0];
      }
    } else {
      for (let i = 0; i < n; i++) {
        const key = keys[i];
        bits[0] = (key & SIGN_BIT) ? (key ^ SIGN_BIT) : ~key;
        sorted[i] = float[0];
      }
    }
    return sorted;
  }
  const { lo, hi } = float64Keys(values);
  const ordered = radixSort64(lo, hi, null);
  const words = new Uint32Array(sorted.buffer);
  for (let i = 0; i < n; i++) {
    const high = ordered.hi[i];
    if (high & SIGN_BIT) {
      words[2 * i] = ordered.lo[i];
      words[2 * i + 1] = high ^ SIGN_BIT;
    } else {
      words[2 * i] = ~ordered.lo[i];
      words[2 * i + 1] = ~high;
    }
  }
  return sorted;
}

const selectScratch = new Float64Array(1);
const selectScratchWords = new Uint32Array(selectScratch.buffer);
const selectScratch32 = new Float32Array(1);
const selectScratch32Bits = new Uint32Array(selectScratch32.buffer);

/**
 * Values at given positions of the ascending order (as `sortedAscending` holds
 * them), selected in linear time without copying the values: a
 * most-significant-digit radix selection that fixes each requested key 16 bits
 * per pass — two passes for float32-exact values, four otherwise — counting
 * only the values that share the key prefix fixed so far.
 *
 * @param {ArrayLike<number>} values - At least one value
 * @param {ArrayLike<number>} positions - 0-based positions within the values
 * @returns {number[]}
 */
function radixSelect(values, positions) {
  const n = values.length;
  const requested = positions.length;
  const float32 = holdsFloat32Values(values);
  const bits32 = values instanceof Float32Array
    ? new Uint32Array(values.buffer, values.byteOffset, n)
    : null;
  const passes = float32 ? 2 : 4;

  // The order key of value i as two or four 16-bit digits, most significant
  // first. `digitsOf` fills `keyDigits` and returns nothing, so the selection
  // loop allocates nothing per value.
  const keyDigits = new Uint32Array(4);
  const digitsOf = (i) => {
    if (float32) {
      let bits;
      if (bits32 !== null) bits = bits32[i];
      else {
        selectScratch32[0] = values[i];
        bits = selectScratch32Bits[0];
      }
      const key = (bits & SIGN_BIT) ? ~bits : (bits | SIGN_BIT);
      keyDigits[0] = key >>> 16;
      keyDigits[1] = key & 0xffff;
      return;
    }
    selectScratch[0] = values[i];
    let low = selectScratchWords[LITTLE_ENDIAN ? 0 : 1];
    let high = selectScratchWords[LITTLE_ENDIAN ? 1 : 0];
    if (high & SIGN_BIT) {
      high = ~high;
      low = ~low;
    } else {
      high |= SIGN_BIT;
    }
    keyDigits[0] = high >>> 16;
    keyDigits[1] = high & 0xffff;
    keyDigits[2] = low >>> 16;
    keyDigits[3] = low & 0xffff;
  };

  const rank = Float64Array.from(positions);
  // The key digits fixed so far for each request.
  const chosen = new Uint32Array(requested * 4);
  const groupOf = new Int32Array(requested);
  for (let pass = 0; pass < passes; pass++) {
    // Requests sharing every digit fixed so far share one histogram.
    const leaders = [];
    for (let j = 0; j < requested; j++) {
      let group = -1;
      for (let g = 0; g < leaders.length && group === -1; g++) {
        const leader = leaders[g];
        let same = true;
        for (let d = 0; d < pass && same; d++) {
          same = chosen[leader * 4 + d] === chosen[j * 4 + d];
        }
        if (same) group = g;
      }
      if (group === -1) {
        group = leaders.length;
        leaders.push(j);
      }
      groupOf[j] = group;
    }
    const histograms = leaders.map(() => new Float64Array(65536));
    if (bits32 !== null) {
      // Float32 input, the common case: keys read straight from its bits.
      const tops = leaders.map(leader => chosen[leader * 4]);
      for (let i = 0; i < n; i++) {
        const bits = bits32[i];
        const key = (bits & SIGN_BIT) ? ~bits : (bits | SIGN_BIT);
        if (pass === 0) {
          histograms[0][key >>> 16]++;
          continue;
        }
        const top = key >>> 16;
        for (let g = 0; g < tops.length; g++) {
          if (tops[g] === top) {
            histograms[g][key & 0xffff]++;
            break;
          }
        }
      }
    } else for (let i = 0; i < n; i++) {
      digitsOf(i);
      for (let g = 0; g < leaders.length; g++) {
        const base = leaders[g] * 4;
        let same = true;
        for (let d = 0; d < pass && same; d++) same = keyDigits[d] === chosen[base + d];
        if (same) {
          histograms[g][keyDigits[pass]]++;
          break;
        }
      }
    }
    for (let j = 0; j < requested; j++) {
      const histogram = histograms[groupOf[j]];
      let digit = 0;
      while (rank[j] >= histogram[digit]) {
        rank[j] -= histogram[digit];
        digit++;
      }
      chosen[j * 4 + pass] = digit;
    }
  }

  const selected = new Array(requested);
  for (let j = 0; j < requested; j++) {
    const high = ((chosen[j * 4] << 16) | chosen[j * 4 + 1]) >>> 0;
    if (float32) {
      selectScratch32Bits[0] = (high & SIGN_BIT) ? (high ^ SIGN_BIT) : ~high;
      selected[j] = selectScratch32[0];
    } else {
      const low = ((chosen[j * 4 + 2] << 16) | chosen[j * 4 + 3]) >>> 0;
      const positive = (high & SIGN_BIT) !== 0;
      selectScratchWords[LITTLE_ENDIAN ? 0 : 1] = positive ? low : ~low;
      selectScratchWords[LITTLE_ENDIAN ? 1 : 0] = positive ? (high ^ SIGN_BIT) : ~high;
      selected[j] = selectScratch[0];
    }
  }
  return selected;
}

/**
 * The permutation that orders the values ascending, in linear time.
 *
 * `order[k]` is the index of the k-th smallest value. The order is the native
 * numeric sort's (-0 before +0, NaN last), and values that are otherwise equal
 * keep their index order, so the permutation is fully determined by the input.
 *
 * @param {ArrayLike<number>} values
 * @returns {Uint32Array}
 */
export function ascendingOrder(values) {
  const n = values.length;
  const indices = new Uint32Array(n);
  for (let i = 0; i < n; i++) indices[i] = i;
  if (n < RADIX_MIN_LENGTH || !LITTLE_ENDIAN) {
    return indices.sort((a, b) => {
      const x = values[a];
      const y = values[b];
      if (x < y) return -1;
      if (x > y) return 1;
      if (x !== x) return y !== y ? a - b : 1;
      if (y !== y) return -1;
      if (x === 0) {
        const negativeX = Object.is(x, -0);
        if (negativeX !== Object.is(y, -0)) return negativeX ? -1 : 1;
      }
      return a - b;
    });
  }
  if (holdsFloat32Values(values)) {
    return radixSort32(float32Keys(values), indices).payload;
  }
  const { lo, hi } = float64Keys(values);
  return radixSort64(lo, hi, indices).payload;
}

/**
 * Largest number of distinct values a rank kernel will tabulate before it
 * switches to sorting. Prepared exports quantize expression to 8 bits, so a
 * gene carries at most 256 distinct values across half a million cells and the
 * tabulated form is exact and far cheaper than any sort. `data-worker.js` bounds
 * its own per-value marker tabulation with the same constant.
 */
export const MAX_TABULATED_DISTINCT_VALUES = 4096;

/** Open-addressing slots: a power of two at most half full at the bound. */
const DISTINCT_INDEX_SLOTS = 8192;
const DISTINCT_INDEX_MASK = DISTINCT_INDEX_SLOTS - 1;
const hashScratch = new Float64Array(1);
const hashWords = new Uint32Array(hashScratch.buffer);

/**
 * Dense numbering of the distinct values of a sample, in first-seen order.
 *
 * This is the lookup every tabulating kernel performs once per cell, so it is
 * an open-addressing table over the value's IEEE-754 bits rather than a `Map`:
 * a `Map` keyed by heap numbers spent roughly 45 ns per lookup, which made the
 * lookup — not the statistic — the cost of a rank test on a 500,000-cell gene.
 * Keys are compared with `===`, and `+0` and `-0` hash alike, so two values
 * share a number exactly when `Map` (SameValueZero) would have given them one
 * key. Callers pass finite values only.
 */
export class DistinctValueIndex {
  constructor() {
    this._keys = new Float64Array(DISTINCT_INDEX_SLOTS);
    this._numbers = new Int32Array(DISTINCT_INDEX_SLOTS).fill(-1);
    /** Distinct values by number, in first-seen order. */
    this.values = new Float64Array(MAX_TABULATED_DISTINCT_VALUES);
    this.size = 0;
  }

  /**
   * The value's number, assigning the next one on first sight, or -1 when a
   * new value would exceed `MAX_TABULATED_DISTINCT_VALUES`.
   * @param {number} value
   * @returns {number}
   */
  numberOf(value) {
    hashScratch[0] = value + 0;
    let slot = (
      Math.imul(hashWords[0] ^ Math.imul(hashWords[1], 0x9e3779b1), 0x85ebca77)
        >>> 19
    ) & DISTINCT_INDEX_MASK;
    const keys = this._keys;
    const numbers = this._numbers;
    for (;;) {
      const number = numbers[slot];
      if (number === -1) {
        if (this.size === MAX_TABULATED_DISTINCT_VALUES) return -1;
        const assigned = this.size++;
        keys[slot] = value;
        numbers[slot] = assigned;
        this.values[assigned] = value;
        return assigned;
      }
      if (keys[slot] === value) return number;
      slot = (slot + 1) & DISTINCT_INDEX_MASK;
    }
  }

  /**
   * Value numbers in ascending order of the values they stand for.
   * @returns {Uint16Array}
   */
  ascendingNumbers() {
    const order = new Uint16Array(this.size);
    for (let i = 0; i < order.length; i++) order[i] = i;
    const values = this.values;
    order.sort((left, right) => values[left] - values[right]);
    return order;
  }
}

/**
 * Number every value of `values` by its distinct value, or `null` past the
 * tabulation bound. Abandons at the first value past the bound, so the wasted
 * work on a high-cardinality input is bounded by the bound and not the sample.
 *
 * @param {ArrayLike<number>} values
 * @returns {{index: DistinctValueIndex, numbers: Uint16Array, counts: Float64Array}|null}
 */
function tabulateValueNumbers(values) {
  const index = new DistinctValueIndex();
  const numbers = new Uint16Array(values.length);
  const counts = new Float64Array(MAX_TABULATED_DISTINCT_VALUES);
  for (let i = 0; i < values.length; i++) {
    const number = index.numberOf(values[i]);
    if (number === -1) return null;
    numbers[i] = number;
    counts[number] += 1;
  }
  return { index, numbers, counts };
}

/**
 * Count every distinct value of `values`, or `null` past the tabulation bound
 * — `tabulateValueNumbers` without the per-value numbering an order statistic
 * does not read.
 *
 * @param {ArrayLike<number>} values
 * @returns {{index: DistinctValueIndex, counts: Float64Array}|null}
 */
function tabulateValueCounts(values) {
  const index = new DistinctValueIndex();
  const counts = new Float64Array(MAX_TABULATED_DISTINCT_VALUES);
  for (let i = 0; i < values.length; i++) {
    const number = index.numberOf(values[i]);
    if (number === -1) return null;
    counts[number] += 1;
  }
  return { index, counts };
}

/**
 * Values at given positions of the ascending order of `values`.
 *
 * This is what an order statistic — a minimum, a median, a quartile — actually
 * needs: a handful of positions, not a fully materialized sorted array. Every
 * copy of a value is the same number, so reading position `p` from a counted
 * tabulation and reading it from a sorted copy give the same result.
 *
 * `values` must already be free of non-finite entries; every caller filters
 * first. `positions` must be within `[0, values.length)`.
 *
 * @param {ArrayLike<number>} values
 * @param {ArrayLike<number>} positions - 0-based positions in ascending order
 * @returns {number[]} One value per requested position, in the requested order
 */
export function selectSorted(values, positions) {
  const requested = positions.length;
  const selected = new Array(requested);
  if (requested === 0) return selected;

  const tabulated = tabulateValueCounts(values);
  if (tabulated === null) {
    if (values.length >= NATIVE_SORT_MAX_LENGTH && LITTLE_ENDIAN) {
      return radixSelect(values, positions);
    }
    const sorted = sortedAscending(values);
    for (let i = 0; i < requested; i++) selected[i] = sorted[positions[i]];
    return selected;
  }

  const { index, counts } = tabulated;
  const ascending = index.ascendingNumbers();
  const cumulative = new Float64Array(ascending.length);
  let running = 0;
  for (let i = 0; i < ascending.length; i++) {
    running += counts[ascending[i]];
    cumulative[i] = running;
  }

  let negativeZeros = -1;
  for (let i = 0; i < requested; i++) {
    const position = positions[i];
    // First distinct value whose cumulative count passes this position.
    let low = 0;
    let high = ascending.length - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (cumulative[mid] <= position) low = mid + 1;
      else high = mid;
    }
    let value = index.values[ascending[low]];
    if (value === 0) {
      // -0 and +0 share one tabulated value; a sorted copy holds every -0
      // before every +0, so the position within the zero block decides.
      if (negativeZeros === -1) {
        negativeZeros = 0;
        for (let k = 0; k < values.length; k++) {
          if (values[k] === 0 && 1 / values[k] < 0) negativeZeros++;
        }
      }
      const blockStart = low === 0 ? 0 : cumulative[low - 1];
      value = position < blockStart + negativeZeros ? -0 : 0;
    }
    selected[i] = value;
  }
  return selected;
}

/**
 * Median of the first `count` entries of `values`, reordering them.
 *
 * A median is two order statistics, and an order statistic is one number
 * however it is found, so selecting it in place (Hoare's selection, expected
 * linear) returns exactly what sorting and indexing returned — without a
 * comparator call per comparison. The even case averages the same two values
 * in the same order: the largest of the lower half, then the selected middle.
 *
 * @param {Float64Array} values - Finite values; the first `count` are used
 * @param {number} count
 * @returns {number} NaN when `count` is zero
 */
export function medianInPlace(values, count) {
  if (count === 0) return NaN;
  const middle = count >>> 1;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const pivot = values[(low + high) >>> 1];
    let i = low;
    let j = high;
    while (i <= j) {
      while (values[i] < pivot) i++;
      while (values[j] > pivot) j--;
      if (i <= j) {
        const swap = values[i];
        values[i] = values[j];
        values[j] = swap;
        i++;
        j--;
      }
    }
    if (middle <= j) high = j;
    else if (middle >= i) low = i;
    else break;
  }
  const upper = values[middle];
  if (count % 2 === 1) return upper;
  let lower = values[0];
  for (let i = 1; i < middle; i++) {
    if (values[i] > lower) lower = values[i];
  }
  return (lower + upper) / 2;
}

/**
 * Compute ranks with proper handling of ties (average rank method).
 *
 * @param {ArrayLike<number>} values - Finite values to rank
 * @returns {number[]} Array of ranks (1-based, fractional for ties)
 */
export function computeRanks(values) {
  return computeRanksWithTies(values).ranks;
}

/**
 * Average ranks together with the tie term `sum(t^3 - t)` over tie blocks.
 *
 * A value occupying 1-based ranks `r+1 … r+count` has average rank
 * `r + (count + 1) / 2`. Rank blocks are integers or exact halves and stay far
 * below 2^53 for any dataset that fits in memory, so this closed form is not an
 * approximation of averaging the individual ranks — it is the same number.
 *
 * The tie term is summed over the distinct values in the order they first
 * occur in `values` (the order a `Map` keyed by value enumerates them). A block
 * of more than about 208,000 equal values has a `t^3` past 2^53, where the
 * order of the additions decides the rounding; summing in first-occurrence
 * order keeps the term the same number however the blocks were found.
 *
 * Values must be finite. -0 and +0 are one tied value, as `===` has them.
 *
 * @param {ArrayLike<number>} values
 * @returns {{ranks: number[], tieTerm: number}}
 */
export function computeRanksWithTies(values) {
  const n = values.length;
  if (n === 0) return { ranks: [], tieTerm: 0 };

  const tabulated = tabulateValueNumbers(values);
  if (tabulated !== null) {
    const { index, numbers, counts } = tabulated;
    const ascending = index.ascendingNumbers();
    const averageRank = new Float64Array(ascending.length);
    let ranked = 0;
    for (let i = 0; i < ascending.length; i++) {
      const number = ascending[i];
      const count = counts[number];
      averageRank[number] = ranked + (count + 1) / 2;
      ranked += count;
    }
    const ranks = new Array(n);
    for (let i = 0; i < n; i++) ranks[i] = averageRank[numbers[i]];
    // Value numbers are assigned in first-occurrence order.
    let tieTerm = 0;
    for (let number = 0; number < index.size; number++) {
      const count = counts[number];
      if (count > 1) tieTerm += count ** 3 - count;
    }
    return { ranks, tieTerm };
  }

  // More distinct values than the tabulation bound: rank through the
  // linear-time ascending permutation. Equal values (including -0 and +0,
  // which the order places next to each other) form one block.
  const order = ascendingOrder(values);
  const ranks = new Array(n);
  /** First occurrence and size of every block of two or more equal values. */
  const blockFirst = [];
  const blockSize = [];
  let tieTerm = 0;
  let orderIndependent = true;
  let i = 0;
  while (i < n) {
    const v = values[order[i]];
    let first = order[i];
    let j = i + 1;
    while (j < n && values[order[j]] === v) {
      if (order[j] < first) first = order[j];
      j++;
    }
    const avgRank = (i + j + 1) / 2;
    for (let k = i; k < j; k++) ranks[order[k]] = avgRank;
    const count = j - i;
    if (count > 1) {
      const term = count ** 3 - count;
      tieTerm += term;
      if (term > Number.MAX_SAFE_INTEGER) orderIndependent = false;
      blockFirst.push(first);
      blockSize.push(count);
    }
    i = j;
  }
  if (orderIndependent && tieTerm <= Number.MAX_SAFE_INTEGER) {
    // Every term and every partial sum is an exact integer, so the order the
    // blocks were added in cannot change the sum.
    return { ranks, tieTerm };
  }
  const blocks = Array.from(blockFirst.keys());
  blocks.sort((a, b) => blockFirst[a] - blockFirst[b]);
  tieTerm = 0;
  for (const block of blocks) {
    const count = blockSize[block];
    tieTerm += count ** 3 - count;
  }
  return { ranks, tieTerm };
}

// ============================================================================
// Statistical Tests
// ============================================================================

const exactMannWhitneyCache = new Map();

/**
 * Build the exact null distribution for the smaller sample's U statistic.
 * The cache makes repeated comparisons with the same group sizes inexpensive.
 *
 * @param {number} nSmall
 * @param {number} nLarge
 * @returns {{cumulative: Float64Array, total: number}}
 */
function getExactMannWhitneyDistribution(nSmall, nLarge) {
  const key = `${nSmall}:${nLarge}`;
  const cached = exactMannWhitneyCache.get(key);
  if (cached) return cached;

  const n = nSmall + nLarge;
  const minRankSum = (nSmall * (nSmall + 1)) / 2;
  const maxRankSum = (nSmall * (2 * n - nSmall + 1)) / 2;
  const maxU = nSmall * nLarge;
  const rankSumCounts = Array.from(
    { length: nSmall + 1 },
    () => new Float64Array(maxRankSum + 1)
  );
  rankSumCounts[0][0] = 1;

  for (let rank = 1; rank <= n; rank++) {
    for (let selected = Math.min(rank, nSmall); selected >= 1; selected--) {
      for (let sum = maxRankSum; sum >= rank; sum--) {
        rankSumCounts[selected][sum] += rankSumCounts[selected - 1][sum - rank];
      }
    }
  }

  const cumulative = new Float64Array(maxU + 1);
  let running = 0;
  for (let u = 0; u <= maxU; u++) {
    running += rankSumCounts[nSmall][minRankSum + u];
    cumulative[u] = running;
  }

  const distribution = { cumulative, total: running };
  exactMannWhitneyCache.set(key, distribution);
  return distribution;
}

/**
 * Calculate a two-sided Mann-Whitney p-value from a U statistic.
 *
 * Exact inference is used for small, untied inputs. Otherwise this applies the
 * tie-adjusted asymptotic variance and a continuity correction.
 *
 * @param {number} n1 - First sample size
 * @param {number} n2 - Second sample size
 * @param {number} statistic - U statistic (either tail)
 * @param {{tieTerm?: number, allowExact?: boolean}} [options]
 * @returns {{pValue: number, pValueMethod: 'exact'|'asymptotic'}}
 */
export function mannWhitneyPValue(n1, n2, statistic, options = {}) {
  const { tieTerm = 0, allowExact = true } = options;
  const n = n1 + n2;
  const hasTies = tieTerm > 0;
  // Match R's long-standing automatic policy: exact only when both samples
  // contain fewer than 50 finite values and there are no ties.
  const canUseExact = allowExact && !hasTies && n1 < 50 && n2 < 50;

  if (canUseExact) {
    const nSmall = Math.min(n1, n2);
    const nLarge = Math.max(n1, n2);
    const maxU = nSmall * nLarge;
    const observedU = Math.max(0, Math.min(maxU, Math.round(statistic)));
    const lowerU = Math.min(observedU, maxU - observedU);
    const { cumulative, total } = getExactMannWhitneyDistribution(nSmall, nLarge);
    const pValue = Math.min(1, (2 * cumulative[lowerU]) / total);
    return { pValue, pValueMethod: 'exact' };
  }

  const mu = (n1 * n2) / 2;
  const tieAdjustment = n > 1 ? tieTerm / (n * (n - 1)) : 0;
  const variance = (n1 * n2 / 12) * (n + 1 - tieAdjustment);
  if (!(variance > 0)) {
    if (statistic === mu) {
      return { pValue: 1, pValueMethod: 'asymptotic' };
    }
    throw new RangeError(
      'Mann-Whitney variance is zero for a non-null statistic'
    );
  }

  const z = Math.max(0, (Math.abs(statistic - mu) - 0.5) / Math.sqrt(variance));
  const pValue = Math.min(1, Math.max(0, 2 * normalSurvival(z)));
  return { pValue, pValueMethod: 'asymptotic' };
}

/**
 * Running rank sum of the first sample and tie term, fed one tie block at a
 * time in ascending value order.
 *
 * A tie block is every copy of one value across both samples. `countA *
 * avgRank` replaces `countA` repeated additions of `avgRank`; both are exact in
 * IEEE-754 doubles because rank blocks are integers or exact halves and the
 * products and sums stay far below 2^53 for any dataset that fits in memory.
 */
class TwoSampleRankSum {
  constructor() {
    this.rankSumA = 0;
    this.tieTerm = 0;
    this.ranked = 0;
  }

  /**
   * @param {number} countA - Copies of the block's value in the first sample
   * @param {number} countB - Copies in the second sample
   */
  addBlock(countA, countB) {
    const tieCount = countA + countB;
    if (tieCount > 1) {
      this.tieTerm += tieCount ** 3 - tieCount;
    }
    // Ranks are 1-based: this block occupies ranks `ranked+1 … ranked+tieCount`.
    this.rankSumA += countA * (this.ranked + (tieCount + 1) / 2);
    this.ranked += tieCount;
  }
}

/**
 * Feed the tie blocks of both samples by counting distinct values, or return
 * `false` when the pooled sample carries more distinct values than the
 * tabulation bound (nothing has been fed then).
 *
 * Counting abandons as soon as the bound is crossed, so the wasted work on a
 * high-cardinality input is bounded by the bound itself and not by the sample
 * size.
 *
 * @param {ArrayLike<number>} group1
 * @param {ArrayLike<number>} group2
 * @param {TwoSampleRankSum} sums
 * @returns {boolean}
 */
function tabulateTwoSampleBlocks(group1, group2, sums) {
  const index = new DistinctValueIndex();
  const countA = new Float64Array(MAX_TABULATED_DISTINCT_VALUES);
  const countB = new Float64Array(MAX_TABULATED_DISTINCT_VALUES);

  for (let i = 0; i < group1.length; i++) {
    const number = index.numberOf(group1[i]);
    if (number === -1) return false;
    countA[number] += 1;
  }
  for (let i = 0; i < group2.length; i++) {
    const number = index.numberOf(group2[i]);
    if (number === -1) return false;
    countB[number] += 1;
  }

  const ascending = index.ascendingNumbers();
  for (let block = 0; block < ascending.length; block++) {
    sums.addBlock(countA[ascending[block]], countB[ascending[block]]);
  }
  return true;
}

/**
 * Feed the tie blocks of both samples by sorting each and merging them.
 *
 * Used when the pooled sample has too many distinct values to tabulate. Each
 * sample is sorted in linear time (`sortedAscending`) and the two sorted runs
 * are merged block by block, so no comparator runs per comparison and no
 * per-block table is kept.
 *
 * @param {ArrayLike<number>} group1
 * @param {ArrayLike<number>} group2
 * @param {TwoSampleRankSum} sums
 */
function mergeTwoSampleBlocks(group1, group2, sums) {
  const n1 = group1.length;
  const n2 = group2.length;
  const sortedA = sortedAscending(group1);
  const sortedB = sortedAscending(group2);
  let indexA = 0;
  let indexB = 0;

  while (indexA < n1 || indexB < n2) {
    const value = indexA < n1 && (indexB >= n2 || sortedA[indexA] <= sortedB[indexB])
      ? sortedA[indexA]
      : sortedB[indexB];

    let blockA = 0;
    while (indexA < n1 && sortedA[indexA] === value) {
      blockA++;
      indexA++;
    }
    let blockB = 0;
    while (indexB < n2 && sortedB[indexB] === value) {
      blockB++;
      indexB++;
    }
    sums.addBlock(blockA, blockB);
  }
}

/**
 * Mann-Whitney U test (Wilcoxon rank-sum test).
 * Non-parametric test for comparing two independent samples.
 *
 * @param {ArrayLike<number>} group1 - First group of values
 * @param {ArrayLike<number>} group2 - Second group of values
 * @returns {{statistic: number, pValue: number, pValueMethod: 'exact'|'asymptotic', u1: number, u2: number}} Test statistic and p-value
 */
export function mannWhitneyU(group1, group2) {
  const n1 = group1.length;
  const n2 = group2.length;

  if (n1 === 0 || n2 === 0) {
    return {
      statistic: NaN,
      pValue: NaN,
      pValueMethod: 'asymptotic',
      u1: NaN,
      u2: NaN
    };
  }

  // Rank-sum for group 1 with tie handling, walked one tie block at a time in
  // ascending value order — exactly the blocks an index sort of the pooled
  // sample produces, so the ranks, the rank sum and the tie term are the same
  // numbers.
  const sums = new TwoSampleRankSum();
  if (!tabulateTwoSampleBlocks(group1, group2, sums)) {
    mergeTwoSampleBlocks(group1, group2, sums);
  }
  const R1 = sums.rankSumA;
  const tieTerm = sums.tieTerm;

  const U1 = R1 - (n1 * (n1 + 1)) / 2;
  const U2 = n1 * n2 - U1;
  const U = Math.min(U1, U2);

  const { pValue, pValueMethod } = mannWhitneyPValue(n1, n2, U, { tieTerm });

  return { statistic: U, pValue, pValueMethod, u1: U1, u2: U2 };
}

/**
 * Welch's t-test from precomputed sample moments.
 *
 * @param {number} mean1 - First sample mean
 * @param {number} variance1 - First sample variance (ddof=1)
 * @param {number} n1 - First sample size
 * @param {number} mean2 - Second sample mean
 * @param {number} variance2 - Second sample variance (ddof=1)
 * @param {number} n2 - Second sample size
 * @returns {{statistic: number, pValue: number, df: number}} Test statistic, p-value, and degrees of freedom
 */
export function welchTTestFromMoments(mean1, variance1, n1, mean2, variance2, n2) {
  if (
    n1 < 2 ||
    n2 < 2 ||
    !Number.isFinite(mean1) ||
    !Number.isFinite(mean2) ||
    !Number.isFinite(variance1) ||
    !Number.isFinite(variance2) ||
    variance1 < 0 ||
    variance2 < 0
  ) {
    return { statistic: NaN, pValue: NaN, df: NaN };
  }

  const se = Math.sqrt(variance1 / n1 + variance2 / n2);
  if (se === 0) {
    const difference = mean1 - mean2;
    if (difference === 0) {
      return {
        statistic: 0,
        pValue: 1,
        df: n1 + n2 - 2
      };
    }
    return {
      statistic: difference < 0 ? -Infinity : Infinity,
      pValue: 0,
      df: n1 + n2 - 2
    };
  }

  const t = (mean1 - mean2) / se;

  // Welch-Satterthwaite degrees of freedom
  const num = Math.pow(variance1 / n1 + variance2 / n2, 2);
  const denom =
    Math.pow(variance1 / n1, 2) / (n1 - 1) +
    Math.pow(variance2 / n2, 2) / (n2 - 1);
  const df = num / denom;

  const pValue = tTwoSidedPValue(t, df);

  return { statistic: t, pValue, df };
}

/**
 * Welch's t-test.
 * Parametric test for comparing two independent samples with unequal variances.
 *
 * @param {number[]} group1 - First group of values
 * @param {number[]} group2 - Second group of values
 * @returns {{statistic: number, pValue: number, df: number}} Test statistic, p-value, and degrees of freedom
 */
export function welchTTest(group1, group2) {
  const n1 = group1.length;
  const n2 = group2.length;
  if (n1 < 2 || n2 < 2) {
    return { statistic: NaN, pValue: NaN, df: NaN };
  }

  const momentsA = sampleMoments(group1);
  const momentsB = sampleMoments(group2);

  return welchTTestFromMoments(
    momentsA.mean,
    momentsA.variance,
    n1,
    momentsB.mean,
    momentsB.variance,
    n2
  );
}

// This module focuses on mathematical computations only; interface number
// formatting lives in ui/components/display-format.js.

// ============================================================================
// Value Filtering Utilities
// ============================================================================

/**
 * Filter array to only valid numeric values (excludes NaN, null, undefined).
 *
 * @param {Array} values - Array of values
 * @returns {number[]} Array of valid numeric values
 */
export function filterNumeric(values) {
  return values.filter(v => typeof v === 'number' && Number.isFinite(v));
}

/**
 * Check if a value is a valid number (not NaN, not null, not undefined).
 *
 * @param {*} value - Value to check
 * @returns {boolean} True if value is a valid number
 */
export function isValidNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Centred second moments of the finite (x, y) pairs, computed in two passes.
 *
 * The one-pass form `n·Σx² − (Σx)²` cancels catastrophically: for a constant
 * variable whose value is not exactly representable (0.1, 23.4, …) it comes
 * out as a tiny negative number, so its square root is NaN, and with a large
 * offset it loses every significant digit. Centring on the mean first keeps
 * the sums non-negative and exact for a constant variable, which is detected
 * from its range and reported with a sum of squares of exactly zero.
 *
 * @param {ArrayLike<number>} xs
 * @param {ArrayLike<number>} ys
 * @returns {{ n: number, meanX: number, meanY: number, sxx: number, syy: number, sxy: number }}
 */
export function pairedCentredMoments(xs, ys) {
  const length = Math.min(xs.length, ys.length);
  let n = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < length; i++) {
    const x = xs[i];
    const y = ys[i];
    if (!isValidNumber(x) || !isValidNumber(y)) continue;
    n++;
    sumX += x;
    sumY += y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (n === 0) {
    return { n: 0, meanX: NaN, meanY: NaN, sxx: 0, syy: 0, sxy: 0 };
  }
  const xConstant = minX === maxX;
  const yConstant = minY === maxY;
  const meanX = xConstant ? minX : sumX / n;
  const meanY = yConstant ? minY : sumY / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  if (!xConstant || !yConstant) {
    for (let i = 0; i < length; i++) {
      const x = xs[i];
      const y = ys[i];
      if (!isValidNumber(x) || !isValidNumber(y)) continue;
      const dx = xConstant ? 0 : x - meanX;
      const dy = yConstant ? 0 : y - meanY;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
  }
  return { n, meanX, meanY, sxx, syy, sxy };
}

/**
 * Pearson coefficient from centred moments: exactly 0 when either variable has
 * no variance, otherwise clamped to [-1, 1] against final-bit round-off.
 *
 * @param {{ sxx: number, syy: number, sxy: number }} moments
 * @returns {number}
 */
export function pearsonFromCentredMoments({ sxx, syy, sxy }) {
  if (!(sxx > 0) || !(syy > 0)) return 0;
  const r = sxy / Math.sqrt(sxx * syy);
  return Math.max(-1, Math.min(1, r));
}

/**
 * Pearson correlation of the finite (x, y) pairs (0 for a constant variable).
 *
 * @param {ArrayLike<number>} xs
 * @param {ArrayLike<number>} ys
 * @returns {number}
 */
export function pearsonCorrelation(xs, ys) {
  return pearsonFromCentredMoments(pairedCentredMoments(xs, ys));
}

/**
 * Pseudocount added to both means of a log2 fold change.
 */
export const LOG2_FOLD_CHANGE_PSEUDOCOUNT = 0.01;

/**
 * log2 fold change of two group means.
 *
 * For non-negative expression this is exactly
 * `log2((meanA + pseudocount) / (meanB + pseudocount))`. Scaled or z-scored
 * expression can be negative, where that ratio has no meaning: it is NaN when
 * the means straddle `-pseudocount`, and its sign inverts when both are
 * negative. Such data are first shifted by the minimum of the compared cells,
 * so the ratio is taken between non-negative means, the result is always
 * finite, and its sign is always the sign of `meanA - meanB`.
 *
 * @param {number} meanA
 * @param {number} meanB
 * @param {number} minimum - Minimum value over the cells of both groups.
 * @param {number} [pseudocount=LOG2_FOLD_CHANGE_PSEUDOCOUNT]
 * @returns {number}
 */
export function log2FoldChangeOfMeans(
  meanA,
  meanB,
  minimum,
  pseudocount = LOG2_FOLD_CHANGE_PSEUDOCOUNT
) {
  if (
    !Number.isFinite(meanA)
    || !Number.isFinite(meanB)
    || !Number.isFinite(minimum)
  ) {
    throw new RangeError('Fold change requires finite means and minimum');
  }
  if (!Number.isFinite(pseudocount) || pseudocount <= 0) {
    throw new RangeError('Fold change pseudocount must be a positive finite number');
  }
  const shift = minimum < 0 ? -minimum : 0;
  return Math.log2(
    (meanA + shift + pseudocount) / (meanB + shift + pseudocount)
  );
}

/**
 * Gaussian kernel density at each evaluation point, from a weighted support.
 *
 * `density[i] = sum_k weights[k] * phi((xs[i] - support[k]) / bandwidth) / (count * bandwidth)`,
 * summed over the support in order. The density plot evaluates this on the
 * main thread and, for a large page, in disjoint slices of `xs` across the
 * analysis workers; every point's sum is the same loop either way, so the
 * curve is the same to the last bit wherever it ran.
 *
 * @param {ArrayLike<number>} support - Distinct values, or every value
 * @param {ArrayLike<number>|null} weights - Multiplicity of each support
 *   value, or null when every value is counted once
 * @param {ArrayLike<number>} xs - Evaluation points
 * @param {number} bandwidth - Kernel bandwidth
 * @param {number} count - Number of values the support stands for
 * @returns {Float64Array} One density per evaluation point
 */
export function kernelDensityAt(support, weights, xs, bandwidth, count) {
  const density = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) {
    const xi = xs[i];
    let sum = 0;
    if (weights === null) {
      // Unit weights: `1 * term` is `term`, exactly.
      for (let k = 0; k < support.length; k++) {
        const u = (xi - support[k]) / bandwidth;
        sum += Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI);
      }
    } else {
      for (let k = 0; k < support.length; k++) {
        const u = (xi - support[k]) / bandwidth;
        sum += weights[k] * (Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI));
      }
    }
    density[i] = sum / (count * bandwidth);
  }
  return density;
}
