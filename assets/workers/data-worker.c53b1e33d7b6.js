// assets/js/app/analysis/compute/operations.js
var OperationType = {
  COMPUTE_CORRELATION: "COMPUTE_CORRELATION",
  COMPUTE_DIFFERENTIAL: "COMPUTE_DIFFERENTIAL",
  SET_TWO_GROUP_CONTEXT: "SET_TWO_GROUP_CONTEXT",
  COMPUTE_DIFFERENTIAL_OF_COLUMNS: "COMPUTE_DIFFERENTIAL_OF_COLUMNS",
  CLEAR_TWO_GROUP_CONTEXT: "CLEAR_TWO_GROUP_CONTEXT",
  COMPUTE_DIFFERENTIAL_OF_SUBSET: "COMPUTE_DIFFERENTIAL_OF_SUBSET",
  COMPUTE_KERNEL_DENSITY: "COMPUTE_KERNEL_DENSITY",
  COMPUTE_BOX_STATISTICS: "COMPUTE_BOX_STATISTICS",
  COMPUTE_VIOLIN_DENSITY: "COMPUTE_VIOLIN_DENSITY",
  COMPUTE_SUMMARY_STATISTICS: "COMPUTE_SUMMARY_STATISTICS",
  COMPUTE_STATISTICAL_TESTS: "COMPUTE_STATISTICAL_TESTS",
  COMPUTE_ORDER_STATISTICS: "COMPUTE_ORDER_STATISTICS",
  COMPUTE_HISTOGRAM_SAMPLES: "COMPUTE_HISTOGRAM_SAMPLES",
  COMPUTE_DENSITY_PLAN: "COMPUTE_DENSITY_PLAN",
  COMPUTE_PAIRWISE_DISTANCES: "COMPUTE_PAIRWISE_DISTANCES",
  COMPUTE_AGGLOMERATION: "COMPUTE_AGGLOMERATION",
  COMPUTE_CSV_EXPORT: "COMPUTE_CSV_EXPORT",
  COMPUTE_GENE_MOMENTS: "COMPUTE_GENE_MOMENTS",
  // --- composition and dot plot ---
  COMPOSITION_COUNTS: "COMPOSITION_COUNTS",
  GROUP_SUMMARY_SET_CONTEXT: "GROUP_SUMMARY_SET_CONTEXT",
  GROUP_SUMMARY_COMPUTE_GENES: "GROUP_SUMMARY_COMPUTE_GENES",
  GROUP_SUMMARY_CLEAR_CONTEXT: "GROUP_SUMMARY_CLEAR_CONTEXT"
};
var Operations = {
  [OperationType.COMPUTE_CORRELATION]: {
    id: OperationType.COMPUTE_CORRELATION,
    name: "Compute Correlation",
    description: "Compute Pearson or Spearman correlation coefficient with p-value",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.COMPUTE_DIFFERENTIAL]: {
    id: OperationType.COMPUTE_DIFFERENTIAL,
    name: "Compute Differential Expression",
    description: "Compute differential expression statistics (Mann-Whitney U or Welch t-test)",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.SET_TWO_GROUP_CONTEXT]: {
    id: OperationType.SET_TWO_GROUP_CONTEXT,
    name: "Set Two-Group Context",
    description: "Hold the two groups of a differential expression run, cell by cell, for its genes",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.COMPUTE_DIFFERENTIAL_OF_COLUMNS]: {
    id: OperationType.COMPUTE_DIFFERENTIAL_OF_COLUMNS,
    name: "Compute Differential Expression of Gene Columns",
    description: "Differential expression of a batch of whole gene columns between the two held groups",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.CLEAR_TWO_GROUP_CONTEXT]: {
    id: OperationType.CLEAR_TWO_GROUP_CONTEXT,
    name: "Clear Two-Group Context",
    description: "Release the two groups held for a differential expression run",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.COMPUTE_DIFFERENTIAL_OF_SUBSET]: {
    id: OperationType.COMPUTE_DIFFERENTIAL_OF_SUBSET,
    name: "Compute Differential Expression of a Cell Subset",
    description: "Differential expression of a run of genes read in the cells of the two held groups",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.COMPUTE_KERNEL_DENSITY]: {
    id: OperationType.COMPUTE_KERNEL_DENSITY,
    name: "Compute Kernel Density",
    description: "Evaluate a Gaussian kernel density at a slice of evaluation points",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.COMPUTE_BOX_STATISTICS]: {
    id: OperationType.COMPUTE_BOX_STATISTICS,
    name: "Compute Box Statistics",
    description: "Box-plot statistics and drawn points, as Plotly computes them from raw values",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.COMPUTE_VIOLIN_DENSITY]: {
    id: OperationType.COMPUTE_VIOLIN_DENSITY,
    name: "Compute Violin Density",
    description: "A slice of the kernel density grid a violin draws, as Plotly computes it",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.COMPUTE_SUMMARY_STATISTICS]: {
    id: OperationType.COMPUTE_SUMMARY_STATISTICS,
    name: "Compute Summary Statistics",
    description: "Count, mean, median, standard deviation, minimum and maximum of one page",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.COMPUTE_STATISTICAL_TESTS]: {
    id: OperationType.COMPUTE_STATISTICAL_TESTS,
    name: "Compute Statistical Tests",
    description: "The two-group or multi-group tests of continuous pages",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.COMPUTE_ORDER_STATISTICS]: {
    id: OperationType.COMPUTE_ORDER_STATISTICS,
    name: "Compute Order Statistics",
    description: "Values at given positions of the ascending order of finite values",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.COMPUTE_HISTOGRAM_SAMPLES]: {
    id: OperationType.COMPUTE_HISTOGRAM_SAMPLES,
    name: "Compute Histogram Samples",
    description: "Shared histogram bins and each page's representative sample",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.COMPUTE_DENSITY_PLAN]: {
    id: OperationType.COMPUTE_DENSITY_PLAN,
    name: "Compute Density Plan",
    description: "A page's density curve, or the plan its kernel sum is split by",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.COMPUTE_PAIRWISE_DISTANCES]: {
    id: OperationType.COMPUTE_PAIRWISE_DISTANCES,
    name: "Compute Pairwise Distances",
    description: "A block of rows of the condensed distance matrix of a clustering",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.COMPUTE_AGGLOMERATION]: {
    id: OperationType.COMPUTE_AGGLOMERATION,
    name: "Compute Agglomeration",
    description: "Hierarchical clustering merges and leaf order from condensed distance blocks",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.COMPUTE_CSV_EXPORT]: {
    id: OperationType.COMPUTE_CSV_EXPORT,
    name: "Compute CSV Export",
    description: "The lines of a range of rows of a per-cell CSV file, as a Blob",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.COMPUTE_GENE_MOMENTS]: {
    id: OperationType.COMPUTE_GENE_MOMENTS,
    name: "Compute Gene Moments",
    description: "Sum, sum of squares and non-zero count of each of a batch of gene columns over every cell",
    workerCapable: true,
    cpuCapable: true
  },
  // --- composition and dot plot ---
  [OperationType.COMPOSITION_COUNTS]: {
    id: OperationType.COMPOSITION_COUNTS,
    name: "Composition Counts",
    description: "Cells of each cell type in each sample or condition, in one pass over the cells",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.GROUP_SUMMARY_SET_CONTEXT]: {
    id: OperationType.GROUP_SUMMARY_SET_CONTEXT,
    name: "Set Group Summary Context",
    description: "Hold the group of every cell for a dot plot run",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.GROUP_SUMMARY_COMPUTE_GENES]: {
    id: OperationType.GROUP_SUMMARY_COMPUTE_GENES,
    name: "Group Summary of Genes",
    description: "Per-group sum, cells above the expression cutoff and their sum, for a run of genes",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.GROUP_SUMMARY_CLEAR_CONTEXT]: {
    id: OperationType.GROUP_SUMMARY_CLEAR_CONTEXT,
    name: "Clear Group Summary Context",
    description: "Release the groups of a dot plot run",
    workerCapable: true,
    cpuCapable: true
  }
};
var WORKER_CAPABLE_OPERATIONS = new Set(
  Object.values(Operations).filter((op) => op.workerCapable).map((op) => op.id)
);
var CPU_CAPABLE_OPERATIONS = new Set(
  Object.values(Operations).filter((op) => op.cpuCapable).map((op) => op.id)
);

// assets/js/app/analysis/compute/math-utils.js
function mean(arr) {
  if (!arr || arr.length === 0) return NaN;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}
function variance(arr, ddof = 0) {
  if (!arr || arr.length <= ddof) return NaN;
  const m = mean(arr);
  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) sumSq += (arr[i] - m) ** 2;
  return sumSq / (arr.length - ddof);
}
function std(arr, ddof = 0) {
  return Math.sqrt(variance(arr, ddof));
}
function sampleMoments(values) {
  const n = values.length;
  if (n < 2) return { mean: n === 1 ? values[0] : NaN, variance: NaN, n };
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const m = sum / n;
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += (values[i] - m) ** 2;
  return { mean: m, variance: sumSq / (n - 1), n };
}
function normalSurvival(z) {
  if (Number.isNaN(z)) return NaN;
  if (z === Infinity) return 0;
  if (z === -Infinity) return 1;
  const positiveTail = 0.5 * regularizedGammaQ(0.5, z * z / 2);
  return z >= 0 ? positiveTail : 1 - positiveTail;
}
function normalCDF(z) {
  return normalSurvival(-z);
}
function tCDF(t, df) {
  if (Number.isNaN(t) || df <= 0 || Number.isNaN(df)) return NaN;
  if (t === -Infinity) return 0;
  if (t === Infinity) return 1;
  if (df === Infinity) return normalCDF(t);
  if (!Number.isFinite(t) || !Number.isFinite(df)) return NaN;
  const x = df / (df + t * t);
  const lowerTail = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return t < 0 ? lowerTail : 1 - lowerTail;
}
function tTwoSidedPValue(t, df) {
  if (Number.isNaN(t)) return NaN;
  const pValue = 2 * tCDF(-Math.abs(t), df);
  return Number.isNaN(pValue) ? NaN : Math.min(1, Math.max(0, pValue));
}
function incompleteBeta(x, a, b) {
  if (x === 0) return 0;
  if (x === 1) return 1;
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - incompleteBeta(1 - x, b, a);
  }
  const bt = Math.exp(
    gammaLn(a + b) - gammaLn(a) - gammaLn(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
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
function gammaLn(z) {
  const g = 7;
  const c = [
    0.9999999999998099,
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9984369578019572e-21,
    15056327351493116e-23
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
var GAMMA_EPSILON = 1e-14;
var GAMMA_MIN_ITERATIONS = 1e3;
var GAMMA_MAX_ITERATIONS = 1e5;
var GAMMA_FPMIN = 1e-300;
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
function regularizedGammaQ(a, x) {
  if (!(a > 0) || x < 0 || Number.isNaN(x)) return NaN;
  if (x === 0) return 1;
  if (x === Infinity) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(x)) return NaN;
  const value = x < a + 1 ? 1 - regularizedGammaSeries(a, x) : regularizedGammaContinuedFraction(a, x);
  return Math.min(1, Math.max(0, value));
}
function chiSquaredPValue(statistic, df) {
  if (!Number.isFinite(df) || df <= 0 || Number.isNaN(statistic)) return NaN;
  if (statistic <= 0) return 1;
  if (statistic === Infinity) return 0;
  const probability = regularizedGammaQ(df / 2, statistic / 2);
  if (!Number.isNaN(probability)) return probability;
  const z = (Math.cbrt(statistic / df) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  return normalSurvival(z);
}
function fDistributionPValue(f, df1, df2) {
  if (!Number.isFinite(df1) || !Number.isFinite(df2) || df1 <= 0 || df2 <= 0) {
    return NaN;
  }
  if (Number.isNaN(f)) return NaN;
  if (f <= 0) return 1;
  if (f === Infinity) return 0;
  const x = df2 / (df2 + df1 * f);
  return incompleteBeta(x, df2 / 2, df1 / 2);
}
var RADIX_MIN_LENGTH = 1024;
var NATIVE_SORT_MAX_LENGTH = 131072;
var SIGN_BIT = 2147483648;
var LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
function holdsFloat32Values(values) {
  if (values instanceof Float32Array || values instanceof Int8Array || values instanceof Uint8Array || values instanceof Uint8ClampedArray || values instanceof Int16Array || values instanceof Uint16Array) {
    return true;
  }
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (Math.fround(value) !== value && value === value) return false;
  }
  return true;
}
function float32Keys(values) {
  const n = values.length;
  const floats = new Float32Array(n);
  if (values instanceof Float32Array) floats.set(values);
  else for (let i = 0; i < n; i++) floats[i] = values[i];
  const keys = new Uint32Array(floats.buffer);
  for (let i = 0; i < n; i++) {
    let bits = keys[i];
    if ((bits & 2147483647) > 2139095040) bits = 2143289344;
    keys[i] = bits & SIGN_BIT ? ~bits : bits | SIGN_BIT;
  }
  return keys;
}
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
    const magnitude = high & 2147483647;
    if (magnitude > 2146435072 || magnitude === 2146435072 && low !== 0) {
      high = 2146959360;
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
function radixSort32(keys, payload, scratch = null) {
  const n = keys.length;
  let fromKeys = keys;
  let toKeys = scratch ?? new Uint32Array(n);
  let fromPayload = payload;
  let toPayload = payload === null ? null : new Uint32Array(n);
  const counts = new Uint32Array(2048);
  for (let shift = 0; shift < 32; shift += 11) {
    const mask = shift === 22 ? 1023 : 2047;
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[fromKeys[i] >>> shift & mask]++;
    if (counts[fromKeys[0] >>> shift & mask] === n) continue;
    let total = 0;
    for (let digit = 0; digit <= mask; digit++) {
      const count = counts[digit];
      counts[digit] = total;
      total += count;
    }
    if (fromPayload === null) {
      for (let i = 0; i < n; i++) {
        const key = fromKeys[i];
        toKeys[counts[key >>> shift & mask]++] = key;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const key = fromKeys[i];
        const at = counts[key >>> shift & mask]++;
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
function radixSort64(lo, hi, payload) {
  const n = lo.length;
  const counts = new Uint32Array(4 * 65536);
  for (let i = 0; i < n; i++) {
    const low = lo[i];
    const high = hi[i];
    counts[low & 65535]++;
    counts[65536 + (low >>> 16)]++;
    counts[131072 + (high & 65535)]++;
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
    if (counts[base + (digitWord[0] >>> shift & 65535)] === n) continue;
    let total = 0;
    for (let digit = 0; digit < 65536; digit++) {
      const count = counts[base + digit];
      counts[base + digit] = total;
      total += count;
    }
    for (let i = 0; i < n; i++) {
      const at = counts[base + (digitWord[i] >>> shift & 65535)]++;
      toLo[at] = fromLo[i];
      toHi[at] = fromHi[i];
      if (fromPayload !== null) toPayload[at] = fromPayload[i];
    }
    let swap = fromLo;
    fromLo = toLo;
    toLo = swap;
    swap = fromHi;
    fromHi = toHi;
    toHi = swap;
    if (fromPayload !== null) {
      swap = fromPayload;
      fromPayload = toPayload;
      toPayload = swap;
    }
  }
  return { lo: fromLo, hi: fromHi, payload: fromPayload };
}
function sortedAscending(values) {
  const n = values.length;
  if (n < NATIVE_SORT_MAX_LENGTH || !LITTLE_ENDIAN) {
    const copy = new Float64Array(n);
    for (let i = 0; i < n; i++) copy[i] = values[i];
    return copy.sort();
  }
  const sorted = new Float64Array(n);
  if (holdsFloat32Values(values)) {
    const scratch = new Uint32Array(sorted.buffer, 0, n);
    const keys = radixSort32(float32Keys(values), null, scratch).keys;
    const bits = new Uint32Array(1);
    const float = new Float32Array(bits.buffer);
    if (keys === scratch) {
      for (let i = n - 1; i >= 0; i--) {
        const key = keys[i];
        bits[0] = key & SIGN_BIT ? key ^ SIGN_BIT : ~key;
        sorted[i] = float[0];
      }
    } else {
      for (let i = 0; i < n; i++) {
        const key = keys[i];
        bits[0] = key & SIGN_BIT ? key ^ SIGN_BIT : ~key;
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
var selectScratch = new Float64Array(1);
var selectScratchWords = new Uint32Array(selectScratch.buffer);
var selectScratch32 = new Float32Array(1);
var selectScratch32Bits = new Uint32Array(selectScratch32.buffer);
function radixSelect(values, positions) {
  const n = values.length;
  const requested = positions.length;
  const float32 = holdsFloat32Values(values);
  const bits32 = values instanceof Float32Array ? new Uint32Array(values.buffer, values.byteOffset, n) : null;
  const passes = float32 ? 2 : 4;
  const keyDigits = new Uint32Array(4);
  const digitsOf = (i) => {
    if (float32) {
      let bits;
      if (bits32 !== null) bits = bits32[i];
      else {
        selectScratch32[0] = values[i];
        bits = selectScratch32Bits[0];
      }
      const key = bits & SIGN_BIT ? ~bits : bits | SIGN_BIT;
      keyDigits[0] = key >>> 16;
      keyDigits[1] = key & 65535;
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
    keyDigits[1] = high & 65535;
    keyDigits[2] = low >>> 16;
    keyDigits[3] = low & 65535;
  };
  const rank = Float64Array.from(positions);
  const chosen = new Uint32Array(requested * 4);
  const groupOf = new Int32Array(requested);
  for (let pass = 0; pass < passes; pass++) {
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
      const tops = leaders.map((leader) => chosen[leader * 4]);
      for (let i = 0; i < n; i++) {
        const bits = bits32[i];
        const key = bits & SIGN_BIT ? ~bits : bits | SIGN_BIT;
        if (pass === 0) {
          histograms[0][key >>> 16]++;
          continue;
        }
        const top = key >>> 16;
        for (let g = 0; g < tops.length; g++) {
          if (tops[g] === top) {
            histograms[g][key & 65535]++;
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
    const high = (chosen[j * 4] << 16 | chosen[j * 4 + 1]) >>> 0;
    if (float32) {
      selectScratch32Bits[0] = high & SIGN_BIT ? high ^ SIGN_BIT : ~high;
      selected[j] = selectScratch32[0];
    } else {
      const low = (chosen[j * 4 + 2] << 16 | chosen[j * 4 + 3]) >>> 0;
      const positive = (high & SIGN_BIT) !== 0;
      selectScratchWords[LITTLE_ENDIAN ? 0 : 1] = positive ? low : ~low;
      selectScratchWords[LITTLE_ENDIAN ? 1 : 0] = positive ? high ^ SIGN_BIT : ~high;
      selected[j] = selectScratch[0];
    }
  }
  return selected;
}
function ascendingOrder(values) {
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
var MAX_TABULATED_DISTINCT_VALUES = 4096;
var DISTINCT_INDEX_SLOTS = 8192;
var DISTINCT_INDEX_MASK = DISTINCT_INDEX_SLOTS - 1;
var hashScratch = new Float64Array(1);
var hashWords = new Uint32Array(hashScratch.buffer);
var DistinctValueIndex = class {
  constructor() {
    this._keys = new Float64Array(DISTINCT_INDEX_SLOTS);
    this._numbers = new Int32Array(DISTINCT_INDEX_SLOTS).fill(-1);
    this._slots = new Uint16Array(MAX_TABULATED_DISTINCT_VALUES);
    this.values = new Float64Array(MAX_TABULATED_DISTINCT_VALUES);
    this.size = 0;
  }
  /**
   * Forget every value, in time proportional to how many were numbered: a
   * kernel that tabulates a handful of values per gene reuses one index
   * instead of allocating and clearing its 8,192 slots for every gene.
   */
  clear() {
    const numbers = this._numbers;
    const slots = this._slots;
    for (let number = 0; number < this.size; number++) numbers[slots[number]] = -1;
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
    let slot = Math.imul(hashWords[0] ^ Math.imul(hashWords[1], 2654435761), 2246822519) >>> 19 & DISTINCT_INDEX_MASK;
    const keys = this._keys;
    const numbers = this._numbers;
    for (; ; ) {
      const number = numbers[slot];
      if (number === -1) {
        if (this.size === MAX_TABULATED_DISTINCT_VALUES) return -1;
        const assigned = this.size++;
        keys[slot] = value;
        numbers[slot] = assigned;
        this._slots[assigned] = slot;
        this.values[assigned] = value;
        return assigned;
      }
      if (keys[slot] === value) return number;
      slot = slot + 1 & DISTINCT_INDEX_MASK;
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
};
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
function selectSorted(values, positions) {
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
    let low = 0;
    let high = ascending.length - 1;
    while (low < high) {
      const mid = low + high >>> 1;
      if (cumulative[mid] <= position) low = mid + 1;
      else high = mid;
    }
    let value = index.values[ascending[low]];
    if (value === 0) {
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
function computeRanks(values) {
  return computeRanksWithTies(values).ranks;
}
function computeRanksWithTies(values) {
  const n = values.length;
  if (n === 0) return { ranks: new Float64Array(0), tieTerm: 0 };
  const tabulated = tabulateValueNumbers(values);
  if (tabulated !== null) {
    const { index, numbers, counts } = tabulated;
    const ascending = index.ascendingNumbers();
    const averageRank = new Float64Array(ascending.length);
    let ranked = 0;
    for (let i2 = 0; i2 < ascending.length; i2++) {
      const number = ascending[i2];
      const count = counts[number];
      averageRank[number] = ranked + (count + 1) / 2;
      ranked += count;
    }
    const ranks2 = new Float64Array(n);
    for (let i2 = 0; i2 < n; i2++) ranks2[i2] = averageRank[numbers[i2]];
    let tieTerm2 = 0;
    for (let number = 0; number < index.size; number++) {
      const count = counts[number];
      if (count > 1) tieTerm2 += count ** 3 - count;
    }
    return { ranks: ranks2, tieTerm: tieTerm2 };
  }
  const order = ascendingOrder(values);
  const ranks = new Float64Array(n);
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
var exactMannWhitneyCache = /* @__PURE__ */ new Map();
function getExactMannWhitneyDistribution(nSmall, nLarge) {
  const key = `${nSmall}:${nLarge}`;
  const cached = exactMannWhitneyCache.get(key);
  if (cached) return cached;
  const n = nSmall + nLarge;
  const minRankSum = nSmall * (nSmall + 1) / 2;
  const maxRankSum = nSmall * (2 * n - nSmall + 1) / 2;
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
function mannWhitneyPValue(n1, n2, statistic, options = {}) {
  const { tieTerm = 0, allowExact = true } = options;
  const n = n1 + n2;
  const hasTies = tieTerm > 0;
  const canUseExact = allowExact && !hasTies && n1 < 50 && n2 < 50;
  if (canUseExact) {
    const nSmall = Math.min(n1, n2);
    const nLarge = Math.max(n1, n2);
    const maxU = nSmall * nLarge;
    const observedU = Math.max(0, Math.min(maxU, Math.round(statistic)));
    const lowerU = Math.min(observedU, maxU - observedU);
    const { cumulative, total } = getExactMannWhitneyDistribution(nSmall, nLarge);
    const pValue2 = Math.min(1, 2 * cumulative[lowerU] / total);
    return { pValue: pValue2, pValueMethod: "exact" };
  }
  const mu = n1 * n2 / 2;
  const tieAdjustment = n > 1 ? tieTerm / (n * (n - 1)) : 0;
  const variance2 = n1 * n2 / 12 * (n + 1 - tieAdjustment);
  if (!(variance2 > 0)) {
    if (statistic === mu) {
      return { pValue: 1, pValueMethod: "asymptotic" };
    }
    throw new RangeError(
      "Mann-Whitney variance is zero for a non-null statistic"
    );
  }
  const z = Math.max(0, (Math.abs(statistic - mu) - 0.5) / Math.sqrt(variance2));
  const pValue = Math.min(1, Math.max(0, 2 * normalSurvival(z)));
  return { pValue, pValueMethod: "asymptotic" };
}
function mannWhitneyPValueScanpy(z) {
  if (Number.isNaN(z)) return NaN;
  return Math.min(1, 2 * normalSurvival(Math.abs(z)));
}
var TwoSampleRankSum = class {
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
    this.rankSumA += countA * (this.ranked + (tieCount + 1) / 2);
    this.ranked += tieCount;
  }
};
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
function mergeTwoSampleBlocks(group1, group2, sums) {
  const n1 = group1.length;
  const n2 = group2.length;
  const sortedA = sortedAscending(group1);
  const sortedB = sortedAscending(group2);
  let indexA = 0;
  let indexB = 0;
  while (indexA < n1 || indexB < n2) {
    const value = indexA < n1 && (indexB >= n2 || sortedA[indexA] <= sortedB[indexB]) ? sortedA[indexA] : sortedB[indexB];
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
function mannWhitneyU(group1, group2) {
  const n1 = group1.length;
  const n2 = group2.length;
  if (n1 === 0 || n2 === 0) {
    return {
      statistic: NaN,
      pValue: NaN,
      pValueMethod: "asymptotic",
      u1: NaN,
      u2: NaN
    };
  }
  const sums = new TwoSampleRankSum();
  if (!tabulateTwoSampleBlocks(group1, group2, sums)) {
    mergeTwoSampleBlocks(group1, group2, sums);
  }
  const R1 = sums.rankSumA;
  const tieTerm = sums.tieTerm;
  const U1 = R1 - n1 * (n1 + 1) / 2;
  const U2 = n1 * n2 - U1;
  const U = Math.min(U1, U2);
  const { pValue, pValueMethod } = mannWhitneyPValue(n1, n2, U, { tieTerm });
  return { statistic: U, pValue, pValueMethod, u1: U1, u2: U2 };
}
function welchTTestFromMoments(mean1, variance1, n1, mean22, variance2, n2) {
  if (n1 < 2 || n2 < 2 || !Number.isFinite(mean1) || !Number.isFinite(mean22) || !Number.isFinite(variance1) || !Number.isFinite(variance2) || variance1 < 0 || variance2 < 0) {
    return { statistic: NaN, pValue: NaN, df: NaN };
  }
  const se = Math.sqrt(variance1 / n1 + variance2 / n2);
  if (se === 0) {
    const difference = mean1 - mean22;
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
  const t = (mean1 - mean22) / se;
  const num = Math.pow(variance1 / n1 + variance2 / n2, 2);
  const denom = Math.pow(variance1 / n1, 2) / (n1 - 1) + Math.pow(variance2 / n2, 2) / (n2 - 1);
  const df = num / denom;
  const pValue = tTwoSidedPValue(t, df);
  return { statistic: t, pValue, df };
}
function isValidNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function pairedCentredMoments(xs, ys) {
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
function pearsonFromCentredMoments({ sxx, syy, sxy }) {
  if (!(sxx > 0) || !(syy > 0)) return 0;
  const r = sxy / Math.sqrt(sxx * syy);
  return Math.max(-1, Math.min(1, r));
}
function pearsonCorrelation(xs, ys) {
  return pearsonFromCentredMoments(pairedCentredMoments(xs, ys));
}
var LOG2_FOLD_CHANGE_PSEUDOCOUNT = 0.01;
function log2FoldChangeOfMeans(meanA, meanB, minimum, pseudocount = LOG2_FOLD_CHANGE_PSEUDOCOUNT) {
  if (!Number.isFinite(meanA) || !Number.isFinite(meanB) || !Number.isFinite(minimum)) {
    throw new RangeError("Fold change requires finite means and minimum");
  }
  if (!Number.isFinite(pseudocount) || pseudocount <= 0) {
    throw new RangeError("Fold change pseudocount must be a positive finite number");
  }
  const shift = minimum < 0 ? -minimum : 0;
  return Math.log2(
    (meanA + shift + pseudocount) / (meanB + shift + pseudocount)
  );
}
function kernelDensityAt(support, weights, xs, bandwidth, count) {
  const density = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) {
    const xi = xs[i];
    let sum = 0;
    if (weights === null) {
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

// assets/js/utils/format-units.js
var BYTE_UNITS = Object.freeze(["B", "KB", "MB", "GB", "TB", "PB"]);
var GROUPED_INTEGER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});
function formatCount(value) {
  requireCount(value);
  return GROUPED_INTEGER.format(value);
}
function requireCount(value) {
  if (typeof value === "bigint") return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Count must be a finite number");
  }
}
function formatCountOf(value, singular, plural = `${singular}s`) {
  return `${formatCount(value)} ${countNoun(value, singular, plural)}`;
}
function countNoun(value, singular, plural = `${singular}s`) {
  if (typeof singular !== "string" || singular.length === 0) {
    throw new TypeError("A counted noun must be non-empty text");
  }
  requireCount(value);
  return Number(value) === 1 ? singular : plural;
}

// assets/js/app/analysis/compute/gene-statistics.js
function isGeneSample(value) {
  return value !== null && typeof value === "object" && !ArrayBuffer.isView(value) && !Array.isArray(value) && value.indices instanceof Uint32Array && (value.values instanceof Float32Array || value.values instanceof Float64Array) && value.indices.length === value.values.length && Number.isSafeInteger(value.length) && value.length >= value.indices.length;
}
var SampleScratch = class {
  constructor() {
    this.indices = new Uint32Array(0);
    this.values32 = new Float32Array(0);
    this.values64 = new Float64Array(0);
  }
  /** @param {number} capacity */
  reserve(capacity, wide) {
    if (this.indices.length < capacity) {
      const size = Math.max(capacity, this.indices.length * 2);
      this.indices = new Uint32Array(size);
    }
    if (wide) {
      if (this.values64.length < capacity) {
        this.values64 = new Float64Array(Math.max(capacity, this.values64.length * 2));
      }
      return this.values64;
    }
    if (this.values32.length < capacity) {
      this.values32 = new Float32Array(Math.max(capacity, this.values32.length * 2));
    }
    return this.values32;
  }
};
var scratchSlots = [new SampleScratch(), new SampleScratch(), new SampleScratch()];
function geneSampleOf(values, slot = 0) {
  if (isGeneSample(values)) return values;
  if (values === null || typeof values !== "object" || !Array.isArray(values) && !ArrayBuffer.isView(values) || values instanceof DataView || values instanceof BigInt64Array || values instanceof BigUint64Array) {
    throw new TypeError("A gene must be a numeric array or a sample {length, indices, values}");
  }
  const scratch = scratchSlots[slot];
  const length = values.length;
  const out = scratch.reserve(length, !(values instanceof Float32Array));
  const indices = scratch.indices;
  let count = 0;
  if (values instanceof Float32Array) {
    const bits = new Uint32Array(values.buffer, values.byteOffset, length);
    const blocked = length & ~7;
    let i = 0;
    for (; i < blocked; i += 8) {
      if ((bits[i] | bits[i + 1] | bits[i + 2] | bits[i + 3] | bits[i + 4] | bits[i + 5] | bits[i + 6] | bits[i + 7]) << 1 === 0) {
        continue;
      }
      for (let j = i; j < i + 8; j++) {
        if (bits[j] << 1 === 0) continue;
        indices[count] = j;
        out[count++] = values[j];
      }
    }
    for (; i < length; i++) {
      if (bits[i] << 1 === 0) continue;
      indices[count] = i;
      out[count++] = values[i];
    }
  } else if (Array.isArray(values)) {
    for (let i = 0; i < length; i++) {
      const value = values[i];
      if (value === 0) continue;
      indices[count] = i;
      out[count++] = typeof value === "number" ? value : NaN;
    }
  } else {
    for (let i = 0; i < length; i++) {
      const value = values[i];
      if (value === 0) continue;
      indices[count] = i;
      out[count++] = value;
    }
  }
  return { length, indices: indices.subarray(0, count), values: out.subarray(0, count) };
}
function sampleOrderError(owner) {
  return new RangeError(`${owner}: sample indices must be strictly ascending and within its length`);
}
function describeSample(sample, owner) {
  const { length, indices, values } = sample;
  let nonFinite = 0;
  let nonZero = 0;
  let sum = 0;
  let minimum = Infinity;
  let previous = -1;
  for (let k = 0; k < indices.length; k++) {
    const position = indices[k];
    if (position <= previous || position >= length) throw sampleOrderError(owner);
    previous = position;
    const value = values[k];
    if (!Number.isFinite(value)) {
      nonFinite++;
      continue;
    }
    if (value === 0) continue;
    nonZero++;
    sum += value;
    if (value < minimum) minimum = value;
  }
  const n = length - nonFinite;
  const zeros = n - nonZero;
  if (zeros > 0 && minimum > 0) minimum = 0;
  return { n, zeros, nonZero, sum, minimum };
}
function nonZeroValues(sample, count) {
  const out = new Float64Array(count);
  const values = sample.values;
  let k = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value !== 0 && Number.isFinite(value)) out[k++] = value;
  }
  return out;
}
function centredSumOfSquares(sample, mean3) {
  const { length, indices, values } = sample;
  const zeroTerm = (0 - mean3) ** 2;
  let sumSquares = 0;
  let position = 0;
  for (let k = 0; k < indices.length; k++) {
    const stored = indices[k];
    for (; position < stored; position++) sumSquares += zeroTerm;
    position = stored + 1;
    const value = values[k];
    if (!Number.isFinite(value)) continue;
    sumSquares += (value - mean3) ** 2;
  }
  for (; position < length; position++) sumSquares += zeroTerm;
  return sumSquares;
}
var twoSampleIndex = new DistinctValueIndex();
var twoSampleCountA = new Float64Array(MAX_TABULATED_DISTINCT_VALUES);
var twoSampleCountB = new Float64Array(MAX_TABULATED_DISTINCT_VALUES);
function feedTwoSampleBlocks(sampleA, sampleB, a, b, sums) {
  const zeroBlock = a.zeros + b.zeros;
  const index = twoSampleIndex;
  index.clear();
  const tabulate = (values, counts) => {
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (value === 0 || !Number.isFinite(value)) continue;
      const number = index.numberOf(value);
      if (number === -1) return false;
      counts[number] += 1;
    }
    return true;
  };
  const tabulated = tabulate(sampleA.values, twoSampleCountA) && tabulate(sampleB.values, twoSampleCountB);
  if (tabulated) {
    const ascending = index.ascendingNumbers();
    let zeroFed2 = zeroBlock === 0;
    for (let block = 0; block < ascending.length; block++) {
      const number = ascending[block];
      if (!zeroFed2 && index.values[number] > 0) {
        sums.addBlock(a.zeros, b.zeros);
        zeroFed2 = true;
      }
      sums.addBlock(twoSampleCountA[number], twoSampleCountB[number]);
    }
    if (!zeroFed2) sums.addBlock(a.zeros, b.zeros);
  }
  twoSampleCountA.fill(0, 0, index.size);
  twoSampleCountB.fill(0, 0, index.size);
  if (tabulated) return;
  const sortedA = sortedAscending(nonZeroValues(sampleA, a.nonZero));
  const sortedB = sortedAscending(nonZeroValues(sampleB, b.nonZero));
  let indexA = 0;
  let indexB = 0;
  let zeroFed = zeroBlock === 0;
  while (indexA < sortedA.length || indexB < sortedB.length) {
    const value = indexA < sortedA.length && (indexB >= sortedB.length || sortedA[indexA] <= sortedB[indexB]) ? sortedA[indexA] : sortedB[indexB];
    if (!zeroFed && value > 0) {
      sums.addBlock(a.zeros, b.zeros);
      zeroFed = true;
    }
    let blockA = 0;
    while (indexA < sortedA.length && sortedA[indexA] === value) {
      blockA++;
      indexA++;
    }
    let blockB = 0;
    while (indexB < sortedB.length && sortedB[indexB] === value) {
      blockB++;
      indexB++;
    }
    sums.addBlock(blockA, blockB);
  }
  if (!zeroFed) sums.addBlock(a.zeros, b.zeros);
}
function twoSampleDifferential(sampleA, sampleB, method, options = {}) {
  if (!TEST_METHODS.includes(method)) {
    throw new RangeError("Differential expression method must be wilcox, ttest or ttest_overestim_var");
  }
  const { pConvention = "exact", foldChange = { mode: "stored" } } = options;
  if (!P_CONVENTIONS.includes(pConvention)) throw new RangeError(`Unknown p-value convention ${pConvention}`);
  const a = describeSample(sampleA, "Group A");
  const b = describeSample(sampleB, "Group B");
  const nA = a.n;
  const nB = b.n;
  const pctA = nA > 0 ? a.nonZero / nA * 100 : NaN;
  const pctB = nB > 0 ? b.nonZero / nB * 100 : NaN;
  if (nA < 2 || nB < 2) {
    return {
      meanA: NaN,
      meanB: NaN,
      pctA,
      pctB,
      log2FoldChange: NaN,
      pValue: NaN,
      statistic: NaN,
      score: NaN,
      auroc: NaN,
      nA,
      nB
    };
  }
  const meanA = a.sum / nA;
  const meanB = b.sum / nB;
  const log2FoldChange = foldChangeOfMeans(meanA, meanB, Math.min(a.minimum, b.minimum), foldChange);
  let pValue;
  let statistic;
  let score;
  let auroc = NaN;
  if (method === "wilcox") {
    const sums = new TwoSampleRankSum();
    feedTwoSampleBlocks(sampleA, sampleB, a, b, sums);
    const U1 = sums.rankSumA - nA * (nA + 1) / 2;
    const U2 = nA * nB - U1;
    statistic = Math.min(U1, U2);
    const comparison = rankSumComparison(sums.rankSumA, nA, nB, sums.tieTerm, pConvention);
    ({ pValue, score, auroc } = comparison);
  } else {
    const m2A = centredSumOfSquares(sampleA, meanA);
    const m2B = centredSumOfSquares(sampleB, meanB);
    const test = welchComparison(meanA, m2A, nA, meanB, m2B, nB, method);
    statistic = test.score;
    score = test.score;
    pValue = test.pValue;
  }
  return { meanA, meanB, pctA, pctB, log2FoldChange, pValue, statistic, score, auroc, nA, nB, method };
}
function createTwoGroupContext(groupOfCell) {
  if (!(groupOfCell instanceof Uint8Array) || groupOfCell.length === 0) {
    throw new TypeError("Two-group context needs a non-empty Uint8Array of group memberships");
  }
  const length = groupOfCell.length;
  const positionInGroup = new Uint32Array(length);
  let sizeA = 0;
  let sizeB = 0;
  for (let cell = 0; cell < length; cell++) {
    const group = groupOfCell[cell];
    if (group === 1) positionInGroup[cell] = sizeA++;
    else if (group === 2) positionInGroup[cell] = sizeB++;
    else if (group !== 0) {
      throw new RangeError(`Cell ${cell} has group ${group}; memberships are 0, 1 or 2`);
    }
  }
  return { length, groupOfCell, positionInGroup, sizeA, sizeB };
}
function splitTwoGroups(column, context) {
  const sample = geneSampleOf(column, 2);
  if (sample.length !== context.length) {
    throw new RangeError(
      `Gene column has ${formatCountOf(sample.length, "value")}; the groups were defined over ${formatCountOf(context.length, "cell")}`
    );
  }
  const { indices, values } = sample;
  const { groupOfCell, positionInGroup } = context;
  const wide = values instanceof Float64Array;
  let countA = 0;
  let countB = 0;
  let previous = -1;
  for (let k = 0; k < indices.length; k++) {
    const cell = indices[k];
    if (cell <= previous || cell >= sample.length) throw sampleOrderError("Gene column");
    previous = cell;
    const group = groupOfCell[cell];
    if (group === 1) countA++;
    else if (group === 2) countB++;
  }
  const outA = scratchSlots[0].reserve(countA, wide);
  const outB = scratchSlots[1].reserve(countB, wide);
  const indicesA = scratchSlots[0].indices;
  const indicesB = scratchSlots[1].indices;
  let a = 0;
  let b = 0;
  for (let k = 0; k < indices.length; k++) {
    const cell = indices[k];
    const group = groupOfCell[cell];
    if (group === 1) {
      indicesA[a] = positionInGroup[cell];
      outA[a++] = values[k];
    } else if (group === 2) {
      indicesB[b] = positionInGroup[cell];
      outB[b++] = values[k];
    }
  }
  return {
    sampleA: { length: context.sizeA, indices: indicesA.subarray(0, a), values: outA.subarray(0, a) },
    sampleB: { length: context.sizeB, indices: indicesB.subarray(0, b), values: outB.subarray(0, b) }
  };
}
var LOG1P_FOLD_CHANGE_EPSILON = 1e-9;
function foldChangeOfMeans(meanA, meanB, minimum, foldChange) {
  if (foldChange.mode === "log1p") {
    const scale = foldChange.base == null ? 1 : Math.log(foldChange.base);
    return Math.log2(
      (Math.expm1(meanA * scale) + LOG1P_FOLD_CHANGE_EPSILON) / (Math.expm1(meanB * scale) + LOG1P_FOLD_CHANGE_EPSILON)
    );
  }
  return log2FoldChangeOfMeans(meanA, meanB, minimum, foldChange.pseudocount);
}
var P_CONVENTIONS = Object.freeze(["exact", "normal", "normal_tie"]);
var TEST_METHODS = Object.freeze(["wilcox", "ttest", "ttest_overestim_var"]);
function rankSumComparison(rankSum, n, m, tieTerm, convention) {
  const total = n + m;
  const u = rankSum - n * (n + 1) / 2;
  const auroc = u / (n * m);
  const tieFactor = convention === "normal" || total < 2 ? 1 : 1 - tieTerm / (total ** 3 - total);
  const sd = Math.sqrt(n * m * (total + 1) / 12 * tieFactor);
  const score = sd > 0 ? (rankSum - n * (total + 1) / 2) / sd : 0;
  let pValue;
  if (convention === "exact") {
    ({ pValue } = mannWhitneyPValue(n, m, Math.min(u, n * m - u), { tieTerm, allowExact: true }));
  } else {
    pValue = sd > 0 ? mannWhitneyPValueScanpy(score) : 1;
  }
  return { score, auroc, pValue: Number.isFinite(pValue) ? pValue : NaN };
}
function welchComparison(meanA, m2A, nA, meanB, m2B, nB, method) {
  const nForB = method === "ttest_overestim_var" ? nA : nB;
  const test = welchTTestFromMoments(meanA, m2A / (nA - 1), nA, meanB, m2B / (nB - 1), nForB);
  return {
    score: test.statistic,
    pValue: Number.isFinite(test.pValue) ? test.pValue : NaN
  };
}
function createGroupingContext(cellGroupIndex, groupCount, { tested = null, reference = -1 } = {}) {
  const groupSize = new Uint32Array(groupCount);
  for (let cell = 0; cell < cellGroupIndex.length; cell++) {
    const group = cellGroupIndex[cell];
    if (group >= 0) groupSize[group]++;
  }
  const testedMask = tested ?? new Uint8Array(groupCount).fill(1);
  if (!(testedMask instanceof Uint8Array) || testedMask.length !== groupCount) {
    throw new TypeError("Tested groups must be a Uint8Array of one flag per group");
  }
  if (!Number.isSafeInteger(reference) || reference < -1 || reference >= groupCount) {
    throw new RangeError("The reference must be -1 (the rest) or a group index");
  }
  return {
    groupCount,
    cellGroupIndex,
    groupSize,
    tested: testedMask,
    reference,
    valueIndex: new DistinctValueIndex(),
    /** Rows of per-group counts, one row per distinct non-zero value. */
    countsByValue: new Uint32Array(64 * groupCount)
  };
}
function groupMarkers(sample, context, { method, minCells, pConvention = "exact", foldChange }) {
  const { groupCount, cellGroupIndex, groupSize, tested, reference } = context;
  if (sample.length !== cellGroupIndex.length) {
    throw new RangeError("Marker gene values must cover exactly the grouped cells");
  }
  if (!TEST_METHODS.includes(method)) throw new RangeError(`Unknown marker method ${method}`);
  if (!P_CONVENTIONS.includes(pConvention)) throw new RangeError(`Unknown p-value convention ${pConvention}`);
  const { indices, values } = sample;
  const wilcox = method === "wilcox";
  const nonFinite = new Uint32Array(groupCount);
  const nonZero = new Uint32Array(groupCount);
  const sumIn = new Float64Array(groupCount);
  let sumAll = 0;
  let nonZeroAll = 0;
  let minimumNonZero = Infinity;
  const valueIndex = wilcox ? context.valueIndex : null;
  valueIndex?.clear();
  let tabulated = wilcox;
  let counts = context.countsByValue;
  let columnSum = 0;
  let columnSumSq = 0;
  let columnNonZero = 0;
  let columnNonFinite = 0;
  let previous = -1;
  for (let k = 0; k < indices.length; k++) {
    const cell = indices[k];
    if (cell <= previous || cell >= sample.length) throw sampleOrderError("Marker gene");
    previous = cell;
    const value = values[k];
    if (!Number.isFinite(value)) columnNonFinite++;
    else if (value !== 0) {
      columnNonZero++;
      columnSum += value;
      columnSumSq += value * value;
    }
    const group = cellGroupIndex[cell];
    if (group < 0) continue;
    if (!Number.isFinite(value)) {
      nonFinite[group]++;
      continue;
    }
    if (value === 0) continue;
    nonZero[group]++;
    nonZeroAll++;
    sumIn[group] += value;
    sumAll += value;
    if (value < minimumNonZero) minimumNonZero = value;
    if (tabulated) {
      const row = valueIndex.numberOf(value);
      if (row === -1) {
        tabulated = false;
      } else {
        const at = row * groupCount + group;
        if (at >= counts.length) {
          const grown = new Uint32Array(Math.max(counts.length * 2, (row + 1) * groupCount));
          grown.set(counts);
          counts = grown;
          context.countsByValue = grown;
        }
        counts[at]++;
      }
    }
  }
  const nIn = new Uint32Array(groupCount);
  const nOut = new Uint32Array(groupCount);
  const zeros = new Float64Array(groupCount);
  let nAll = 0;
  let zerosAll = 0;
  for (let g = 0; g < groupCount; g++) {
    nIn[g] = groupSize[g] - nonFinite[g];
    zeros[g] = nIn[g] - nonZero[g];
    nAll += nIn[g];
    zerosAll += zeros[g];
  }
  const restMode = reference < 0;
  for (let g = 0; g < groupCount; g++) nOut[g] = restMode ? nAll - nIn[g] : nIn[reference];
  const minAll = zerosAll > 0 ? Math.min(minimumNonZero, 0) : minimumNonZero;
  const pValues = new Float64Array(groupCount).fill(NaN);
  const scores = new Float32Array(groupCount).fill(NaN);
  const auroc = new Float32Array(groupCount).fill(NaN);
  const log2FoldChange = new Float32Array(groupCount).fill(NaN);
  const meanInGroup = new Float32Array(groupCount).fill(NaN);
  const meanOutGroup = new Float32Array(groupCount).fill(NaN);
  const percentInGroup = new Float32Array(groupCount);
  const percentOutGroup = new Float32Array(groupCount);
  const meanIn = new Float64Array(groupCount).fill(NaN);
  const meanOut = new Float64Array(groupCount).fill(NaN);
  for (let g = 0; g < groupCount; g++) {
    if (nIn[g] > 0) meanIn[g] = sumIn[g] / nIn[g];
  }
  for (let g = 0; g < groupCount; g++) {
    const nA = nIn[g];
    const nB = nOut[g];
    if (nA > 0) {
      meanInGroup[g] = meanIn[g];
      percentInGroup[g] = nonZero[g] / nA * 100;
    }
    if (nB > 0) {
      meanOut[g] = restMode ? (sumAll - sumIn[g]) / nB : meanIn[reference];
      meanOutGroup[g] = meanOut[g];
      percentOutGroup[g] = restMode ? (nonZeroAll - nonZero[g]) / nB * 100 : percentInGroup[reference];
    }
    if (nA > 0 && nB > 0) {
      log2FoldChange[g] = foldChangeOfMeans(meanIn[g], meanOut[g], minAll, foldChange);
    }
  }
  const result = {
    nAll,
    column: { sum: columnSum, sumSq: columnSumSq, nonZero: columnNonZero, n: sample.length - columnNonFinite },
    pValues,
    scores,
    auroc,
    log2FoldChange,
    meanInGroup,
    meanOutGroup,
    percentInGroup,
    percentOutGroup,
    nIn,
    nOut
  };
  const minPerSide = Math.max(2, minCells);
  const testable = (g) => tested[g] === 1 && g !== reference && nIn[g] >= minPerSide && nOut[g] >= minPerSide;
  if (!wilcox) {
    const meanAll = nAll > 0 ? sumAll / nAll : 0;
    const m2In = new Float64Array(groupCount);
    let m2All = 0;
    for (let k = 0; k < indices.length; k++) {
      const group = cellGroupIndex[indices[k]];
      if (group < 0) continue;
      const value = values[k];
      if (value === 0 || !Number.isFinite(value)) continue;
      m2In[group] += (value - meanIn[group]) ** 2;
      m2All += (value - meanAll) ** 2;
    }
    m2All += zerosAll * meanAll ** 2;
    for (let g = 0; g < groupCount; g++) {
      if (nIn[g] > 0) m2In[g] += zeros[g] * meanIn[g] ** 2;
    }
    for (let g = 0; g < groupCount; g++) {
      if (!testable(g)) continue;
      const nA = nIn[g];
      const nB = nOut[g];
      let m2Out;
      if (restMode) {
        const betweenM2 = (meanIn[g] - meanOut[g]) ** 2 * nA * nB / nAll;
        m2Out = m2All - m2In[g] - betweenM2;
        const m2Scale = Math.max(1, Math.abs(m2All), Math.abs(m2In[g]), Math.abs(betweenM2));
        if (m2Out < 0 && m2Out >= -32 * Number.EPSILON * m2Scale) m2Out = 0;
      } else {
        m2Out = m2In[reference];
      }
      const test = welchComparison(meanIn[g], m2In[g], nA, meanOut[g], m2Out, nB, method);
      scores[g] = test.score;
      pValues[g] = test.pValue;
    }
    return result;
  }
  if (restMode) {
    const rankSum2 = new Float64Array(groupCount);
    let tieTerm2 = 0;
    let ranked2 = 0;
    const addZeroBlock2 = () => {
      if (zerosAll === 0) return;
      if (zerosAll > 1) tieTerm2 += zerosAll ** 3 - zerosAll;
      const averageRank = ranked2 + (zerosAll + 1) / 2;
      for (let g = 0; g < groupCount; g++) rankSum2[g] += zeros[g] * averageRank;
      ranked2 += zerosAll;
    };
    walkTieBlocks(context, counts, valueIndex, tabulated, sample, nonZero, addZeroBlock2, (rowCounts, rowStart, owner, from, to, order) => {
      let tieCount;
      if (rowCounts !== null) {
        tieCount = 0;
        for (let g = 0; g < groupCount; g++) tieCount += rowCounts[rowStart + g];
      } else {
        tieCount = to - from;
      }
      if (tieCount > 1) tieTerm2 += tieCount ** 3 - tieCount;
      const averageRank = ranked2 + (tieCount + 1) / 2;
      if (rowCounts !== null) {
        for (let g = 0; g < groupCount; g++) rankSum2[g] += rowCounts[rowStart + g] * averageRank;
      } else {
        for (let k = from; k < to; k++) rankSum2[owner[order[k]]] += averageRank;
      }
      ranked2 += tieCount;
    });
    for (let g = 0; g < groupCount; g++) {
      if (!testable(g)) continue;
      const comparison = rankSumComparison(rankSum2[g], nIn[g], nOut[g], tieTerm2, pConvention);
      scores[g] = comparison.score;
      auroc[g] = comparison.auroc;
      pValues[g] = comparison.pValue;
    }
    return result;
  }
  const r = reference;
  const pairs = [];
  for (let g = 0; g < groupCount; g++) if (testable(g)) pairs.push(g);
  const rankSum = new Float64Array(groupCount);
  const tieTerm = new Float64Array(groupCount);
  const ranked = new Float64Array(groupCount);
  const addZeroBlock = () => {
    for (const g of pairs) {
      const block = zeros[g] + zeros[r];
      if (block === 0) continue;
      if (block > 1) tieTerm[g] += block ** 3 - block;
      rankSum[g] += zeros[g] * (ranked[g] + (block + 1) / 2);
      ranked[g] += block;
    }
  };
  walkTieBlocks(context, counts, valueIndex, tabulated, sample, nonZero, addZeroBlock, (rowCounts, rowStart, owner, from, to, order) => {
    for (const g of pairs) {
      let inG;
      let inR;
      if (rowCounts !== null) {
        inG = rowCounts[rowStart + g];
        inR = rowCounts[rowStart + r];
      } else {
        inG = 0;
        inR = 0;
        for (let k = from; k < to; k++) {
          const group = owner[order[k]];
          if (group === g) inG++;
          else if (group === r) inR++;
        }
      }
      const block = inG + inR;
      if (block === 0) continue;
      if (block > 1) tieTerm[g] += block ** 3 - block;
      rankSum[g] += inG * (ranked[g] + (block + 1) / 2);
      ranked[g] += block;
    }
  });
  for (const g of pairs) {
    const comparison = rankSumComparison(rankSum[g], nIn[g], nOut[g], tieTerm[g], pConvention);
    scores[g] = comparison.score;
    auroc[g] = comparison.auroc;
    pValues[g] = comparison.pValue;
  }
  return result;
}
function walkTieBlocks(context, counts, valueIndex, tabulated, sample, nonZero, addZeroBlock, visit) {
  const { groupCount, cellGroupIndex } = context;
  let zeroFed = false;
  if (tabulated) {
    const ascending = valueIndex.ascendingNumbers();
    for (let k = 0; k < ascending.length; k++) {
      const number = ascending[k];
      if (!zeroFed && valueIndex.values[number] > 0) {
        addZeroBlock();
        zeroFed = true;
      }
      visit(counts, number * groupCount, null, 0, 0, null);
    }
    clearCounts(context, counts, valueIndex);
  } else {
    clearCounts(context, counts, valueIndex);
    const { indices, values } = sample;
    let measuredCount = 0;
    for (let g = 0; g < groupCount; g++) measuredCount += nonZero[g];
    const measured = values instanceof Float32Array ? new Float32Array(measuredCount) : new Float64Array(measuredCount);
    const owner = new Int32Array(measuredCount);
    let m = 0;
    for (let k = 0; k < indices.length; k++) {
      const group = cellGroupIndex[indices[k]];
      if (group < 0) continue;
      const value = values[k];
      if (value === 0 || !Number.isFinite(value)) continue;
      measured[m] = value;
      owner[m++] = group;
    }
    const order = ascendingOrder(measured);
    let i = 0;
    while (i < measuredCount) {
      const value = measured[order[i]];
      if (!zeroFed && value > 0) {
        addZeroBlock();
        zeroFed = true;
      }
      let j = i + 1;
      while (j < measuredCount && measured[order[j]] === value) j++;
      visit(null, 0, owner, i, j, order);
      i = j;
    }
  }
  if (!zeroFed) addZeroBlock();
}
function clearCounts(context, counts, valueIndex) {
  counts.fill(0, 0, valueIndex.size * context.groupCount);
  valueIndex.clear();
}

// assets/js/app/utils/number-utils.js
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// assets/js/app/analysis/shared/number-utils.js
var mean2 = mean;
var std2 = std;
function computeStats(values) {
  const valid = finiteNumbers(values);
  const n = valid.length;
  if (n === 0) {
    return { count: 0, mean: NaN, median: NaN, std: NaN, min: NaN, max: NaN };
  }
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = valid[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const meanVal = sum / n;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    sumSq += (valid[i] - meanVal) ** 2;
  }
  const stdVal = Math.sqrt(sumSq / n);
  const mid = Math.floor(n / 2);
  const [lower, upper] = selectSorted(valid, [mid > 0 ? mid - 1 : 0, mid]);
  const medianVal = n % 2 === 0 ? (lower + upper) / 2 : upper;
  return {
    count: n,
    mean: meanVal,
    median: medianVal,
    std: stdVal,
    min,
    max
  };
}
var finiteNumbersByValues = /* @__PURE__ */ new WeakMap();
function finiteNumbers(values) {
  if (!values) return new Float64Array(0);
  const cached = finiteNumbersByValues.get(values);
  if (cached !== void 0) return cached;
  let finiteCount = 0;
  for (let i = 0; i < values.length; i++) {
    if (isFiniteNumber(values[i])) finiteCount++;
  }
  let finite = values;
  if (finiteCount !== values.length) {
    finite = values instanceof Float32Array ? new Float32Array(finiteCount) : new Float64Array(finiteCount);
    let write = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (isFiniteNumber(v)) finite[write++] = v;
    }
  }
  finiteNumbersByValues.set(values, finite);
  if (finite !== values) finiteNumbersByValues.set(finite, finite);
  return finite;
}
function finiteNumbersReport(values) {
  const finite = finiteNumbers(values);
  return { finiteCount: finite.length, finite: finite === values ? null : finite };
}
function getFiniteMinMax(values) {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  if (!values) return { min: NaN, max: NaN, count: 0 };
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isFiniteNumber(v)) continue;
    count++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (count === 0) return { min: NaN, max: NaN, count: 0 };
  return { min, max, count };
}

// assets/js/app/analysis/shared/category-counts.js
var countsByValues = /* @__PURE__ */ new WeakMap();
function categoryCounts(values) {
  let counts = countsByValues.get(values);
  if (counts === void 0) {
    counts = /* @__PURE__ */ new Map();
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    countsByValues.set(values, counts);
  }
  return counts;
}

// assets/js/utils/exact-record.js
var EMPTY_KEYS = Object.freeze([]);
function typeFailure(message) {
  return new TypeError(message);
}
function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function requireClonedRecord(value, label, fail = typeFailure) {
  if (isPlainRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return (
      /** @type {T & Record<string, unknown>} */
      value
    );
  }
  throw fail(`${label} must be a plain object; got ${describeValue(value)}.`, {
    reason: "type",
    missing: [],
    unexpected: []
  });
}
function describeValue(value) {
  if (value === null || value === void 0) return String(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") {
    const name = Object.getPrototypeOf(value)?.constructor?.name;
    return name ? `a ${name}` : "an object";
  }
  return `a ${typeof value}`;
}

// assets/js/app/analysis/stats/statistical-tests.js
function getSignificance(pValue) {
  if (!isFiniteNumber(pValue)) return "N/A";
  if (pValue < 1e-3) return "***";
  if (pValue < 0.01) return "**";
  if (pValue < 0.05) return "*";
  return "ns";
}
function requireNumericArrayLike(values, label) {
  const isTypedArray = ArrayBuffer.isView(values) && !(values instanceof DataView);
  const supported = Array.isArray(values) || isTypedArray;
  if (!supported || !Number.isSafeInteger(values.length)) {
    throw new TypeError(`${label} must be an Array or TypedArray`);
  }
  if (isTypedArray) {
    if (values instanceof BigInt64Array || values instanceof BigUint64Array) {
      throw new TypeError(`${label} must contain a numeric value at every index`);
    }
    return values;
  }
  for (let index = 0; index < values.length; index++) {
    if (!Object.hasOwn(values, index) || typeof values[index] !== "number") {
      throw new TypeError(`${label} must contain a numeric value at every index`);
    }
  }
  return values;
}
function finiteValues(values, label = "Statistical values") {
  requireNumericArrayLike(values, label);
  let filtered = null;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (isFiniteNumber(value)) {
      if (filtered) filtered.push(value);
    } else if (!filtered) {
      filtered = [];
      for (let prior = 0; prior < index; prior++) filtered.push(values[prior]);
    }
  }
  return filtered ?? values;
}
var CATEGORY_TYPE_ORDER = /* @__PURE__ */ new Map([
  ["boolean", 0],
  ["number", 1],
  ["string", 2]
]);
function requireCategoricalValue(value, groupIndex = null, valueIndex = null) {
  const type = typeof value;
  if (type !== "string" && type !== "number" && type !== "boolean" || type === "number" && !Number.isFinite(value)) {
    const location = groupIndex === null ? "" : ` at group ${groupIndex + 1}, value ${valueIndex + 1}`;
    throw new TypeError(
      `Categorical statistical value${location} must be a string, finite number, or boolean`
    );
  }
  return type;
}
function categoryText(value) {
  requireCategoricalValue(value);
  return String(value);
}
function compareCategoryValues(left, right) {
  const leftType = requireCategoricalValue(left);
  const rightType = requireCategoricalValue(right);
  const typeDifference = CATEGORY_TYPE_ORDER.get(leftType) - CATEGORY_TYPE_ORDER.get(rightType);
  if (typeDifference !== 0) return typeDifference;
  if (leftType === "boolean") return Number(left) - Number(right);
  if (leftType === "number") {
    return left - right;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}
function buildCategoricalTable(pageData) {
  if (!Array.isArray(pageData)) {
    throw new TypeError("Categorical statistical page data must be an array");
  }
  const pageCounts = [];
  for (let groupIndex = 0; groupIndex < pageData.length; groupIndex++) {
    const page = pageData[groupIndex];
    if (page === null || typeof page !== "object" || Array.isArray(page) || Object.getPrototypeOf(page) !== Object.prototype || typeof page.pageName !== "string" || page.pageName.length === 0 || page.pageName !== page.pageName.trim() || !Array.isArray(page.values) && !(ArrayBuffer.isView(page.values) && !(page.values instanceof DataView))) {
      throw new TypeError(
        `Categorical statistical group ${groupIndex + 1} requires a trimmed pageName and array-like values`
      );
    }
    const values = page.values;
    const counts = categoryCounts(values);
    for (const value of counts.keys()) {
      try {
        requireCategoricalValue(value);
      } catch {
        for (let valueIndex = 0; valueIndex < values.length; valueIndex++) {
          requireCategoricalValue(values[valueIndex], groupIndex, valueIndex);
        }
      }
    }
    pageCounts.push(counts);
  }
  const nonEmptyPageIndices = [];
  for (let index = 0; index < pageData.length; index++) {
    if (pageData[index].values.length > 0) nonEmptyPageIndices.push(index);
  }
  const categories = /* @__PURE__ */ new Set();
  for (const index of nonEmptyPageIndices) {
    for (const value of pageCounts[index].keys()) categories.add(value);
  }
  const categoryValues = Array.from(categories).sort(compareCategoryValues);
  const rowLabels = nonEmptyPageIndices.map((index) => pageData[index].pageName);
  const observed = nonEmptyPageIndices.map((index) => {
    const counts = pageCounts[index];
    return categoryValues.map((category) => counts.get(category) ?? 0);
  });
  const rowTotals = observed.map((row) => row.reduce((sum, count) => sum + count, 0));
  const colTotals = categoryValues.map(
    (_, column) => observed.reduce((sum, row) => sum + row[column], 0)
  );
  const grandTotal = rowTotals.reduce((sum, count) => sum + count, 0);
  return { categoryValues, rowLabels, observed, rowTotals, colTotals, grandTotal };
}
function invalidCategoricalResult(testName, interpretation) {
  return {
    testName,
    statistic: NaN,
    pValue: NaN,
    significance: "N/A",
    effectSize: null,
    effectSizeType: null,
    interpretation
  };
}
function hasExpectedCountBelow(table, minimum) {
  const { observed, rowTotals, colTotals, grandTotal } = table;
  if (grandTotal === 0) return false;
  for (let row = 0; row < observed.length; row++) {
    for (let column = 0; column < colTotals.length; column++) {
      const expected = rowTotals[row] * colTotals[column] / grandTotal;
      if (expected < minimum) return true;
    }
  }
  return false;
}
function chiSquaredTestFromTable(table) {
  const { categoryValues, observed, rowTotals, colTotals, grandTotal } = table;
  if (grandTotal === 0) {
    return invalidCategoricalResult("Chi-squared test", "No data available");
  }
  if (observed.length < 2) {
    return invalidCategoricalResult(
      "Chi-squared test",
      "Need at least 2 non-empty groups for comparison"
    );
  }
  if (categoryValues.length < 2) {
    return invalidCategoricalResult(
      "Chi-squared test",
      "Need at least 2 observed categories for comparison"
    );
  }
  if (hasExpectedCountBelow(table, 5)) {
    return invalidCategoricalResult(
      "Chi-squared test",
      "Pearson chi-squared inference is unavailable because an expected count is below 5; use an exact test or combine sparse categories"
    );
  }
  let chiSq = 0;
  for (let row = 0; row < observed.length; row++) {
    for (let column = 0; column < categoryValues.length; column++) {
      const expected = rowTotals[row] * colTotals[column] / grandTotal;
      if (expected > 0) {
        chiSq += (observed[row][column] - expected) ** 2 / expected;
      }
    }
  }
  const df = (observed.length - 1) * (categoryValues.length - 1);
  const pValue = chiSquaredPValue(chiSq, df);
  const k = Math.min(observed.length, categoryValues.length);
  const cramersV = k > 1 ? Math.sqrt(chiSq / (grandTotal * (k - 1))) : 0;
  let effectInterpretation = "";
  if (cramersV < 0.1) effectInterpretation = "negligible";
  else if (cramersV < 0.2) effectInterpretation = "small";
  else if (cramersV < 0.4) effectInterpretation = "medium";
  else effectInterpretation = "large";
  const significance = getSignificance(pValue);
  return {
    testName: "Chi-squared test",
    statistic: chiSq,
    pValue,
    significance,
    effectSize: cramersV,
    effectSizeType: "Cramér's V",
    df,
    interpretation: pValue < 0.05 ? `Significant difference in distributions (${effectInterpretation} effect)` : "No significant difference in distributions"
  };
}
function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return gammaLn(n + 1) - gammaLn(k + 1) - gammaLn(n - k + 1);
}
function fisherExactTwoSided(observed) {
  const [[a, b], [c, d]] = observed;
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const total = row1 + row2;
  const denominator = logChoose(total, col1);
  const logProbability = (value) => logChoose(row1, value) + logChoose(row2, col1 - value) - denominator;
  const observedLogProbability = logProbability(a);
  const minA = Math.max(0, col1 - row2);
  const maxA = Math.min(row1, col1);
  const included = [];
  let maxLogProbability = -Infinity;
  for (let value = minA; value <= maxA; value++) {
    const logP = logProbability(value);
    if (logP <= observedLogProbability + 1e-12) {
      included.push(logP);
      if (logP > maxLogProbability) maxLogProbability = logP;
    }
  }
  const scaledSum = included.reduce(
    (sum, logP) => sum + Math.exp(logP - maxLogProbability),
    0
  );
  return Math.min(1, Math.exp(maxLogProbability) * scaledSum);
}
function fisherExactTestFromTable(table) {
  const { categoryValues, rowLabels, observed, grandTotal } = table;
  if (grandTotal === 0) {
    return invalidCategoricalResult("Fisher's exact test", "No data available");
  }
  if (observed.length !== 2 || categoryValues.length !== 2) {
    return invalidCategoricalResult(
      "Fisher's exact test",
      "Fisher's exact test requires exactly 2 groups and 2 categories"
    );
  }
  const [[a, b], [c, d]] = observed;
  const crossProducts = { numerator: a * d, denominator: b * c };
  const oddsRatio = crossProducts.denominator > 0 ? crossProducts.numerator / crossProducts.denominator : crossProducts.numerator > 0 ? Infinity : NaN;
  const pValue = fisherExactTwoSided(observed);
  const significance = getSignificance(pValue);
  const oddsRatioContrast = `${rowLabels[0]} vs ${rowLabels[1]}; ${categoryText(categoryValues[0])} vs ${categoryText(categoryValues[1])}`;
  return {
    testName: "Fisher's exact test",
    statistic: oddsRatio,
    pValue,
    significance,
    effectSize: Number.isNaN(oddsRatio) ? null : oddsRatio,
    effectSizeType: `sample OR (${oddsRatioContrast})`,
    pValueMethod: "Exact (two-sided)",
    interpretation: pValue < 0.05 ? "Significant association between group and category" : "No significant association between group and category"
  };
}
function shouldUseFisherExact(table) {
  const { categoryValues, observed, grandTotal } = table;
  if (observed.length !== 2 || categoryValues.length !== 2 || grandTotal === 0) {
    return false;
  }
  return hasExpectedCountBelow(table, 5);
}
function tTest(group1, group2) {
  const values1 = finiteValues(group1);
  const values2 = finiteValues(group2);
  const n1 = values1.length;
  const n2 = values2.length;
  if (n1 < 2 || n2 < 2) {
    return {
      testName: "Welch's t-test",
      statistic: NaN,
      pValue: NaN,
      significance: "N/A",
      effectSize: null,
      effectSizeType: null,
      interpretation: "Need at least 2 samples in each group"
    };
  }
  const momentsA = sampleMoments(values1);
  const momentsB = sampleMoments(values2);
  const m1 = momentsA.mean;
  const m2 = momentsB.mean;
  const v1 = momentsA.variance;
  const v2 = momentsB.variance;
  const {
    statistic: t,
    pValue,
    df
  } = welchTTestFromMoments(m1, v1, n1, m2, v2, n2);
  if (!isFiniteNumber(pValue)) {
    return {
      testName: "Welch's t-test",
      statistic: t,
      pValue,
      significance: "N/A",
      effectSize: null,
      effectSizeType: null,
      df,
      interpretation: "Welch inference is undefined because the sample moments are not finite"
    };
  }
  const pooledStd = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2));
  const cohensD = pooledStd > 0 ? (m1 - m2) / pooledStd : m1 === m2 ? 0 : null;
  let effectInterpretation = "";
  if (cohensD === null) {
    effectInterpretation = "effect size undefined because within-group variance is zero";
  } else {
    const absD = Math.abs(cohensD);
    if (absD < 0.2) effectInterpretation = "negligible effect";
    else if (absD < 0.5) effectInterpretation = "small effect";
    else if (absD < 0.8) effectInterpretation = "medium effect";
    else effectInterpretation = "large effect";
  }
  const significance = getSignificance(pValue);
  return {
    testName: "Welch's t-test",
    statistic: t,
    pValue,
    significance,
    effectSize: cohensD,
    effectSizeType: "Cohen's d",
    df,
    interpretation: pValue < 0.05 ? `Significant difference between means (${effectInterpretation})` : `No significant difference between means`
  };
}
function mannWhitneyU2(group1, group2) {
  const values1 = finiteValues(group1);
  const values2 = finiteValues(group2);
  const n1 = values1.length;
  const n2 = values2.length;
  if (n1 < 1 || n2 < 1) {
    return {
      testName: "Mann-Whitney U",
      statistic: NaN,
      pValue: NaN,
      significance: "N/A",
      effectSize: null,
      effectSizeType: null,
      interpretation: "Need at least 1 sample in each group"
    };
  }
  const {
    statistic: U,
    pValue,
    pValueMethod,
    u1
  } = mannWhitneyU(values1, values2);
  const rbc = 2 * u1 / (n1 * n2) - 1;
  let effectInterpretation = "";
  const absR = Math.abs(rbc);
  if (absR < 0.1) effectInterpretation = "negligible";
  else if (absR < 0.3) effectInterpretation = "small";
  else if (absR < 0.5) effectInterpretation = "medium";
  else effectInterpretation = "large";
  const significance = getSignificance(pValue);
  return {
    testName: "Mann-Whitney U",
    statistic: U,
    pValue,
    significance,
    effectSize: rbc,
    effectSizeType: "rank-biserial r (group 1 vs 2)",
    pValueMethod: pValueMethod === "exact" ? "Exact" : "Asymptotic (tie/continuity corrected)",
    interpretation: pValue < 0.05 ? `Significant difference in distributions (${effectInterpretation} effect)` : `No significant difference in distributions`
  };
}
function oneWayANOVA(groups) {
  if (!Array.isArray(groups)) {
    throw new TypeError("One-way ANOVA groups must be an array");
  }
  const k = groups.length;
  if (k < 2) {
    return {
      testName: "One-way ANOVA",
      statistic: NaN,
      pValue: NaN,
      significance: "N/A",
      effectSize: null,
      effectSizeType: null,
      interpretation: "Need at least 2 groups"
    };
  }
  const validGroups = groups.map((group, index) => finiteValues(group, `ANOVA group ${index + 1}`)).filter((group) => group.length > 0);
  if (validGroups.length < 2) {
    return {
      testName: "One-way ANOVA",
      statistic: NaN,
      pValue: NaN,
      significance: "N/A",
      effectSize: null,
      effectSizeType: null,
      interpretation: "Need at least 2 non-empty groups"
    };
  }
  const groupMeans = validGroups.map((g) => mean(g));
  const groupSizes = validGroups.map((g) => g.length);
  const N = groupSizes.reduce((a, b) => a + b, 0);
  const firstValue = validGroups[0][0];
  let allValuesIdentical = true;
  for (const group of validGroups) {
    for (const value of group) {
      if (value !== firstValue) {
        allValuesIdentical = false;
        break;
      }
    }
    if (!allValuesIdentical) break;
  }
  let grandSum = 0;
  for (const group of validGroups) {
    for (const value of group) grandSum += value;
  }
  const grandMean = grandSum / N;
  let SSB = 0;
  for (let i = 0; i < validGroups.length; i++) {
    SSB += groupSizes[i] * Math.pow(groupMeans[i] - grandMean, 2);
  }
  let SSW = 0;
  for (let i = 0; i < validGroups.length; i++) {
    for (const x of validGroups[i]) {
      SSW += Math.pow(x - groupMeans[i], 2);
    }
  }
  const dfB = validGroups.length - 1;
  const dfW = N - validGroups.length;
  if (dfW <= 0) {
    return {
      testName: "One-way ANOVA",
      statistic: NaN,
      pValue: NaN,
      significance: "N/A",
      effectSize: null,
      effectSizeType: null,
      interpretation: "Insufficient degrees of freedom"
    };
  }
  const MSB = SSB / dfB;
  const MSW = SSW / dfW;
  if (allValuesIdentical || MSW === 0 && MSB === 0) {
    return {
      testName: "One-way ANOVA",
      statistic: NaN,
      pValue: NaN,
      significance: "N/A",
      effectSize: null,
      effectSizeType: null,
      df: [dfB, dfW],
      interpretation: "ANOVA is undefined because all groups have identical constant values"
    };
  }
  const F = MSW > 0 ? MSB / MSW : Infinity;
  const pValue = fDistributionPValue(F, dfB, dfW);
  const SST = SSB + SSW;
  const etaSquared = SST > 0 ? SSB / SST : 0;
  let effectInterpretation = "";
  if (etaSquared < 0.01) effectInterpretation = "negligible";
  else if (etaSquared < 0.06) effectInterpretation = "small";
  else if (etaSquared < 0.14) effectInterpretation = "medium";
  else effectInterpretation = "large";
  const significance = getSignificance(pValue);
  return {
    testName: "One-way ANOVA",
    statistic: F,
    pValue,
    significance,
    effectSize: etaSquared,
    effectSizeType: "η²",
    df: [dfB, dfW],
    interpretation: pValue < 0.05 ? `Significant difference among group means (${effectInterpretation} effect)` : `No significant difference among group means`
  };
}
function kruskalWallis(groups) {
  if (!Array.isArray(groups)) {
    throw new TypeError("Kruskal-Wallis groups must be an array");
  }
  const k = groups.length;
  if (k < 2) {
    return {
      testName: "Kruskal-Wallis H",
      statistic: NaN,
      pValue: NaN,
      significance: "N/A",
      effectSize: null,
      effectSizeType: null,
      interpretation: "Need at least 2 groups"
    };
  }
  const validGroups = groups.map((group, index) => finiteValues(group, `Kruskal-Wallis group ${index + 1}`)).filter((group) => group.length > 0);
  if (validGroups.length < 2) {
    return {
      testName: "Kruskal-Wallis H",
      statistic: NaN,
      pValue: NaN,
      significance: "N/A",
      effectSize: null,
      effectSizeType: null,
      interpretation: "Need at least 2 non-empty groups"
    };
  }
  const groupSizes = validGroups.map((g) => g.length);
  let N = 0;
  for (const size of groupSizes) N += size;
  const values = new Float64Array(N);
  let write = 0;
  for (let i = 0; i < validGroups.length; i++) {
    const group = validGroups[i];
    for (let j = 0; j < group.length; j++) values[write++] = group[j];
  }
  const { ranks, tieTerm } = computeRanksWithTies(values);
  const rankSums = new Array(validGroups.length).fill(0);
  let read = 0;
  for (let i = 0; i < validGroups.length; i++) {
    const size = groupSizes[i];
    let sum = 0;
    for (let j = 0; j < size; j++) sum += ranks[read++];
    rankSums[i] = sum;
  }
  let H = 0;
  for (let i = 0; i < validGroups.length; i++) {
    if (groupSizes[i] > 0) {
      H += Math.pow(rankSums[i], 2) / groupSizes[i];
    }
  }
  H = 12 / (N * (N + 1)) * H - 3 * (N + 1);
  const tieCorrection = 1 - tieTerm / (N ** 3 - N);
  if (!(tieCorrection > 0)) {
    return {
      testName: "Kruskal-Wallis H",
      statistic: NaN,
      pValue: NaN,
      significance: "N/A",
      effectSize: null,
      effectSizeType: null,
      df: validGroups.length - 1,
      interpretation: "Kruskal-Wallis is undefined because all values are tied"
    };
  }
  H /= tieCorrection;
  H = Math.max(0, H);
  const df = validGroups.length - 1;
  const pValue = chiSquaredPValue(H, df);
  const epsilonSquared = Math.min(1, Math.max(0, H / (N - 1)));
  let effectInterpretation = "";
  if (epsilonSquared < 0.01) effectInterpretation = "negligible";
  else if (epsilonSquared < 0.06) effectInterpretation = "small";
  else if (epsilonSquared < 0.14) effectInterpretation = "medium";
  else effectInterpretation = "large";
  const significance = getSignificance(pValue);
  return {
    testName: "Kruskal-Wallis H",
    statistic: H,
    pValue,
    significance,
    effectSize: epsilonSquared,
    effectSizeType: "ε²",
    df,
    interpretation: pValue < 0.05 ? `Significant difference among group distributions (${effectInterpretation} effect)` : `No significant difference among group distributions`
  };
}
var CATEGORICAL_DATA_TYPES = /* @__PURE__ */ new Set(["categorical", "categorical_obs"]);
var CONTINUOUS_DATA_TYPES = /* @__PURE__ */ new Set([
  "continuous",
  "continuous_obs",
  "gene_expression"
]);
function requireContinuousPageData(pageData) {
  if (!Array.isArray(pageData)) {
    throw new TypeError("Continuous statistical page data must be an array");
  }
  for (let index = 0; index < pageData.length; index++) {
    const page = requireClonedRecord(
      pageData[index],
      `Continuous statistical group ${index + 1}`
    );
    if (typeof page.pageName !== "string" || page.pageName.length === 0 || page.pageName !== page.pageName.trim()) {
      throw new TypeError(
        `Continuous statistical group ${index + 1} requires a trimmed pageName`
      );
    }
    requireNumericArrayLike(
      page.values,
      `Continuous statistical group ${index + 1} values`
    );
  }
  return pageData;
}
function runStatisticalTests(pageData, dataType) {
  if (!CATEGORICAL_DATA_TYPES.has(dataType) && !CONTINUOUS_DATA_TYPES.has(dataType)) {
    throw new TypeError(`Unsupported statistical data type: ${String(dataType)}`);
  }
  const categoricalTable = CATEGORICAL_DATA_TYPES.has(dataType) ? buildCategoricalTable(pageData) : null;
  if (categoricalTable === null) {
    requireContinuousPageData(pageData);
  }
  const results = [];
  if (pageData.length < 2) {
    return [{
      testName: "Statistical Analysis",
      statistic: NaN,
      pValue: NaN,
      significance: "N/A",
      effectSize: null,
      effectSizeType: null,
      interpretation: "Select at least 2 pages to compare"
    }];
  }
  if (categoricalTable !== null) {
    results.push(
      shouldUseFisherExact(categoricalTable) ? fisherExactTestFromTable(categoricalTable) : chiSquaredTestFromTable(categoricalTable)
    );
  } else {
    const groups = pageData.map(
      (page, index) => finiteValues(page.values, `Continuous statistical group ${index + 1} values`)
    );
    if (groups.length === 2) {
      results.push(tTest(groups[0], groups[1]));
      results.push(mannWhitneyU2(groups[0], groups[1]));
    } else {
      results.push(oneWayANOVA(groups));
      results.push(kruskalWallis(groups));
    }
  }
  return results;
}

// assets/js/app/analysis/plots/plotly-box-statistics.js
var FIND_BIN_ROUNDING = 1e-9;
function interp(sorted, fraction) {
  const n = fraction * sorted.length - 0.5;
  if (n < 0) return sorted[0];
  if (n > sorted.length - 1) return sorted[sorted.length - 1];
  const frac = n % 1;
  return frac * sorted[Math.ceil(n)] + (1 - frac) * sorted[Math.floor(n)];
}
function findBin(value, edges, strict = false) {
  let low = 0;
  let high = edges.length;
  let steps = 0;
  const slope = high > 1 ? (edges[high - 1] - edges[0]) / (high - 1) : 1;
  let compare;
  if (slope >= 0) compare = strict ? (a, b) => a < b : (a, b) => a <= b;
  else compare = strict ? (a, b) => a >= b : (a, b) => a > b;
  const target = value + slope * FIND_BIN_ROUNDING * (strict ? -1 : 1) * (slope >= 0 ? 1 : -1);
  while (low < high && steps++ < 100) {
    const middle = Math.floor((low + high) / 2);
    if (compare(edges[middle], target)) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}
function sortLikePlotly(values) {
  const sorted = sortedAscending(values);
  let zeroStart = -1;
  let zeroEnd = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] === 0) {
      if (zeroStart === -1) zeroStart = i;
      zeroEnd = i + 1;
    } else if (zeroStart !== -1) {
      break;
    }
  }
  if (zeroStart !== -1) {
    let write = zeroStart;
    for (let i = 0; i < values.length && write < zeroEnd; i++) {
      if (values[i] === 0) sorted[write++] = values[i];
    }
  }
  return sorted;
}
function plotlyBoxStatistics(values) {
  if (values.length === 0) {
    throw new RangeError("Box statistics require at least one value");
  }
  return statisticsOfSorted(sortLikePlotly(values));
}
function statisticsOfSorted(sorted) {
  const count = sorted.length;
  const median = interp(sorted, 0.5);
  const q1 = interp(sorted, 0.25);
  const q3 = interp(sorted, 0.75);
  let sum = 0;
  for (let i = 0; i < count; i++) sum = sum + sorted[i];
  const mean3 = sum / count;
  let squares = 0;
  for (let i = 0; i < count; i++) squares = squares + Math.pow(sorted[i] - mean3, 2);
  const sd = Math.sqrt(squares / count);
  const sampleSd = Math.sqrt(squares / (count - 1 || count));
  const lowerfence = Math.min(
    q1,
    sorted[Math.min(findBin(2.5 * q1 - 1.5 * q3, sorted, true) + 1, count - 1)]
  );
  const upperfence = Math.max(
    q3,
    sorted[Math.max(findBin(2.5 * q3 - 1.5 * q1, sorted), 0)]
  );
  const notchspan = 1.57 * (q3 - q1) / Math.sqrt(count);
  return { q1, median, q3, lowerfence, upperfence, mean: mean3, sd, sampleSd, notchspan, sorted };
}
var COINCIDENT_OUTLIER_COPIES = 16;
function plotlyBoxPoints(statistics, points) {
  const { sorted, lowerfence, upperfence } = statistics;
  if (points === "all") return sorted;
  let below = 0;
  while (below < sorted.length && sorted[below] < lowerfence) below++;
  let above = sorted.length;
  while (above > below && sorted[above - 1] > upperfence) above--;
  const outliers = new Float64Array(below + sorted.length - above);
  let count = 0;
  const keep = (from, to) => {
    let run = 0;
    for (let i = from; i < to; i++) {
      run = i > from && sorted[i] === sorted[i - 1] ? run + 1 : 0;
      if (run < COINCIDENT_OUTLIER_COPIES) outliers[count++] = sorted[i];
    }
  };
  keep(0, below);
  keep(above, sorted.length);
  return count === outliers.length ? outliers : outliers.slice(0, count);
}
function plotlyBoxSummary(values, points) {
  const statistics = plotlyBoxStatistics(values);
  return {
    q1: statistics.q1,
    median: statistics.median,
    q3: statistics.q3,
    lowerfence: statistics.lowerfence,
    upperfence: statistics.upperfence,
    mean: statistics.mean,
    sd: statistics.sd,
    notchspan: statistics.notchspan,
    points: plotlyBoxPoints(statistics, points)
  };
}
function plotlyViolinBox(sorted, points) {
  if (!(sorted instanceof Float64Array) || sorted.length === 0) {
    throw new RangeError("A violin box needs at least one value in Plotly order");
  }
  if (points !== "outliers" && points !== "none") {
    throw new RangeError("A precomputed violin draws outliers or no points");
  }
  const statistics = statisticsOfSorted(sorted);
  const { q1, q3, median: med, lowerfence: lf, upperfence: uf } = statistics;
  const pts = [];
  if (points === "outliers") {
    const keep = (from, to) => {
      let run = 0;
      for (let i = from; i < to; i++) {
        run = i > from && sorted[i] === sorted[i - 1] ? run + 1 : 0;
        if (run < COINCIDENT_OUTLIER_COPIES) pts.push({ v: sorted[i], i });
      }
    };
    let below = 0;
    while (below < sorted.length && sorted[below] < lf) below++;
    let above = sorted.length;
    while (above > below && sorted[above - 1] > uf) above--;
    keep(0, below);
    keep(above, sorted.length);
  }
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: statistics.mean,
    sd: statistics.sd,
    sampleSd: statistics.sampleSd,
    med,
    q1,
    q3,
    lf,
    uf,
    lo: 4 * q1 - 3 * q3,
    uo: 4 * q3 - 3 * q1,
    ln: med - statistics.notchspan,
    un: med + statistics.notchspan,
    pts
  };
}

// assets/js/app/analysis/plots/plotly-histogram-bins.js
var FIND_BIN_ROUNDING2 = 1e-9;
var DIRECT_BINS = 1024;
function plotlyHistogramSample(values, bins) {
  const { start, size } = bins;
  if (!Number.isFinite(start) || !(size > 0) || !Number.isFinite(size)) {
    throw new RangeError("Histogram bins need a finite start and a positive finite size");
  }
  const count = new Float64Array(DIRECT_BINS);
  const first = new Float64Array(DIRECT_BINS);
  const min = new Float64Array(DIRECT_BINS);
  const max = new Float64Array(DIRECT_BINS);
  const others = /* @__PURE__ */ new Map();
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const bin = Math.floor((value - start) / size + FIND_BIN_ROUNDING2);
    if (bin >= 0 && bin < DIRECT_BINS) {
      if (count[bin] === 0) {
        first[bin] = value;
        min[bin] = value;
        max[bin] = value;
      } else {
        if (value < min[bin]) min[bin] = value;
        if (value > max[bin]) max[bin] = value;
      }
      count[bin]++;
      continue;
    }
    const group = others.get(bin);
    if (group === void 0) {
      others.set(bin, { first: value, min: value, max: value, count: 1 });
    } else {
      group.count++;
      if (value < group.min) group.min = value;
      if (value > group.max) group.max = value;
    }
  }
  const x = [];
  const y = [];
  const emit = (binFirst, binMin, binMax, binCount) => {
    x.push(binFirst);
    y.push(binCount);
    if (!Object.is(binMin, binFirst)) {
      x.push(binMin);
      y.push(0);
    }
    if (!Object.is(binMax, binFirst) && !Object.is(binMax, binMin)) {
      x.push(binMax);
      y.push(0);
    }
  };
  for (let bin = 0; bin < DIRECT_BINS; bin++) {
    if (count[bin] > 0) emit(first[bin], min[bin], max[bin], count[bin]);
  }
  for (const group of others.values()) {
    emit(group.first, group.min, group.max, group.count);
  }
  return { x: Float64Array.from(x), y: Float64Array.from(y) };
}
function histogramSamples(pages, nbins) {
  let min = Infinity;
  let max = -Infinity;
  const finitePages = pages.map(finiteNumbers);
  for (const values of finitePages) {
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new RangeError("Plot range requires at least one finite numeric value");
  }
  const size = (max - min) / nbins;
  const binned = size > 0 && Number.isFinite(size);
  const samples = finitePages.map((values) => values.length > 0 && binned ? plotlyHistogramSample(values, { start: min, size }) : null);
  return { min, max, size, samples };
}

// assets/js/app/analysis/plots/density-curve.js
function densityPlan(data, bandwidth = "auto", nPoints = 100) {
  if (!data || data.length === 0) return { curve: { x: [], y: [] } };
  const validData = finiteNumbers(data);
  if (validData.length === 0) return { curve: { x: [], y: [] } };
  const n = validData.length;
  const { min, max } = getFiniteMinMax(validData);
  const range = max - min;
  if (range === 0) return { curve: { x: [min], y: [1] } };
  let h = bandwidth;
  if (bandwidth === "auto") {
    const stdVal = std2(validData);
    h = 1.06 * stdVal * Math.pow(n, -0.2);
    if (h <= 0 || !Number.isFinite(h)) h = range / 10;
  }
  const padding = h * 3;
  const x = [];
  const step = (range + 2 * padding) / (nPoints - 1);
  for (let i = 0; i < nPoints; i++) x.push(min - padding + i * step);
  const { values: support, weights } = weightedSupport(validData);
  return { x, support, weights, h, n };
}
function weightedSupport(data) {
  const index = new DistinctValueIndex();
  const counts = new Float64Array(MAX_TABULATED_DISTINCT_VALUES);
  for (let i = 0; i < data.length; i++) {
    const number = index.numberOf(data[i]);
    if (number === -1) {
      return {
        values: data instanceof Float32Array || data instanceof Float64Array ? data : Float64Array.from(data),
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
function planDensity(values, bandwidthMult) {
  if (bandwidthMult === 1 || values.length === 0) {
    return densityPlan(values, "auto");
  }
  const h = 1.06 * std2(values) * Math.pow(values.length, -0.2) * bandwidthMult;
  return densityPlan(values, h);
}
function curveOf(plan, density) {
  return { x: plan.x, y: Array.from(density) };
}
function densityCurveOrPlan(pageValues, bandwidthMult, maxKernelTerms) {
  const finite = finiteNumbers(pageValues);
  const pageMean = finite.length === 0 ? NaN : mean2(finite);
  const plan = planDensity(finite, bandwidthMult);
  if (plan.curve !== void 0) return { mean: pageMean, curve: plan.curve };
  if (plan.support.length * plan.x.length < maxKernelTerms) {
    return {
      mean: pageMean,
      curve: curveOf(plan, kernelDensityAt(plan.support, plan.weights, plan.x, plan.h, plan.n))
    };
  }
  return { mean: pageMean, plan };
}

// assets/js/app/analysis/compute/hierarchical-clustering.js
var DISTANCE_METRICS = Object.freeze(["correlation", "euclidean", "cosine"]);
var LINKAGE_METHODS = Object.freeze(["average", "complete", "single"]);
function pairsBefore(n, row) {
  return row * n - row * (row + 1) / 2;
}
function itemTerms(values, nItems, nFeatures, metric, fromItem) {
  const terms = new Float64Array((nItems - fromItem) * nFeatures);
  const squares = new Float64Array(nItems - fromItem);
  for (let item = fromItem; item < nItems; item++) {
    const source = item * nFeatures;
    const target = (item - fromItem) * nFeatures;
    if (metric === "correlation") {
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (let k = 0; k < nFeatures; k++) {
        const x = values[source + k];
        sum += x;
        if (x < min) min = x;
        if (x > max) max = x;
      }
      if (min === max) continue;
      const mean3 = sum / nFeatures;
      let sxx = 0;
      for (let k = 0; k < nFeatures; k++) {
        const dx = values[source + k] - mean3;
        terms[target + k] = dx;
        sxx += dx * dx;
      }
      squares[item - fromItem] = sxx;
    } else {
      let sxx = 0;
      for (let k = 0; k < nFeatures; k++) {
        const x = values[source + k];
        terms[target + k] = x;
        sxx += x * x;
      }
      squares[item - fromItem] = sxx;
    }
  }
  return { terms, squares };
}
function distanceOfDot(metric, dot, squaresA, squaresB) {
  if (metric === "correlation") {
    if (!(squaresA > 0) || !(squaresB > 0)) return 1;
    const r = dot / Math.sqrt(squaresA * squaresB);
    return 1 - Math.max(-1, Math.min(1, r));
  }
  const denominator = Math.sqrt(squaresA) * Math.sqrt(squaresB);
  if (denominator === 0) return 1;
  return 1 - dot / denominator;
}
function requireDistanceInputs(values, nItems, nFeatures, metric) {
  if (!ArrayBuffer.isView(values) || values instanceof DataView) {
    throw new TypeError("Clustering values must be a typed array");
  }
  if (!Number.isSafeInteger(nItems) || nItems < 2) {
    throw new RangeError("Clustering needs at least two items");
  }
  if (!Number.isSafeInteger(nFeatures) || nFeatures < 1) {
    throw new RangeError("Clustering items need at least one feature");
  }
  if (values.length !== nItems * nFeatures) {
    throw new RangeError("Clustering value count must equal items × features");
  }
  if (!DISTANCE_METRICS.includes(metric)) {
    throw new RangeError(`Unknown distance metric: ${String(metric)}`);
  }
}
function pairwiseDistanceRows(values, nItems, nFeatures, metric, rowFrom, rowTo) {
  requireDistanceInputs(values, nItems, nFeatures, metric);
  if (!Number.isSafeInteger(rowFrom) || !Number.isSafeInteger(rowTo) || rowFrom < 0 || rowFrom >= rowTo || rowTo > nItems - 1) {
    throw new RangeError("Distance rows must be a non-empty range of the items that own pairs");
  }
  const m = nFeatures;
  const { terms: c, squares } = itemTerms(values, nItems, nFeatures, metric, rowFrom);
  const out = new Float64Array(pairsBefore(nItems, rowTo) - pairsBefore(nItems, rowFrom));
  const euclidean = metric === "euclidean";
  let p = 0;
  for (let i = rowFrom; i < rowTo; i++) {
    const oi = (i - rowFrom) * m;
    const si = squares[i - rowFrom];
    let j = i + 1;
    for (; j + 3 < nItems; j += 4) {
      const o0 = (j - rowFrom) * m;
      const o1 = o0 + m;
      const o2 = o1 + m;
      const o3 = o2 + m;
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      if (euclidean) {
        for (let k = 0; k < m; k++) {
          const x = c[oi + k];
          let d = x - c[o0 + k];
          s0 += d * d;
          d = x - c[o1 + k];
          s1 += d * d;
          d = x - c[o2 + k];
          s2 += d * d;
          d = x - c[o3 + k];
          s3 += d * d;
        }
        out[p++] = Math.sqrt(s0);
        out[p++] = Math.sqrt(s1);
        out[p++] = Math.sqrt(s2);
        out[p++] = Math.sqrt(s3);
      } else {
        for (let k = 0; k < m; k++) {
          const x = c[oi + k];
          s0 += x * c[o0 + k];
          s1 += x * c[o1 + k];
          s2 += x * c[o2 + k];
          s3 += x * c[o3 + k];
        }
        const base = j - rowFrom;
        out[p++] = distanceOfDot(metric, s0, si, squares[base]);
        out[p++] = distanceOfDot(metric, s1, si, squares[base + 1]);
        out[p++] = distanceOfDot(metric, s2, si, squares[base + 2]);
        out[p++] = distanceOfDot(metric, s3, si, squares[base + 3]);
      }
    }
    for (; j < nItems; j++) {
      const oj = (j - rowFrom) * m;
      let s = 0;
      if (euclidean) {
        for (let k = 0; k < m; k++) {
          const d = c[oi + k] - c[oj + k];
          s += d * d;
        }
        out[p++] = Math.sqrt(s);
      } else {
        for (let k = 0; k < m; k++) s += c[oi + k] * c[oj + k];
        out[p++] = distanceOfDot(metric, s, si, squares[j - rowFrom]);
      }
    }
  }
  return out;
}
function agglomerate(blocks, ranges, n, linkage) {
  if (!Number.isSafeInteger(n) || n < 2) {
    throw new RangeError("Agglomeration needs at least two items");
  }
  if (!LINKAGE_METHODS.includes(linkage)) {
    throw new RangeError(`Unknown linkage method: ${String(linkage)}`);
  }
  if (!Array.isArray(blocks) || !Array.isArray(ranges) || blocks.length !== ranges.length) {
    throw new TypeError("Agglomeration needs one distance block per row range");
  }
  const rows = new Array(n);
  const base = new Float64Array(n);
  let expectedFrom = 0;
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b];
    const range = ranges[b];
    if (!(block instanceof Float64Array) || !Array.isArray(range) || range.length !== 2) {
      throw new TypeError("Agglomeration blocks must be Float64Array with [rowFrom, rowTo) ranges");
    }
    const [from, to] = range;
    if (from !== expectedFrom || !(to > from) || to > n - 1) {
      throw new RangeError("Agglomeration row ranges must be contiguous from the first item");
    }
    if (block.length !== pairsBefore(n, to) - pairsBefore(n, from)) {
      throw new RangeError("Agglomeration block length does not match its row range");
    }
    const offset = pairsBefore(n, from);
    for (let k = from; k < to; k++) {
      rows[k] = block;
      base[k] = pairsBefore(n, k) - offset - k - 1;
    }
    expectedFrom = to;
  }
  if (expectedFrom !== n - 1) {
    throw new RangeError("Agglomeration row ranges must cover every item that owns pairs");
  }
  for (const block of blocks) {
    for (let index = 0; index < block.length; index++) {
      if (!Number.isFinite(block[index])) {
        throw new TypeError("Agglomeration distances must be finite");
      }
    }
  }
  const active = new Uint8Array(n).fill(1);
  const size = new Float64Array(n).fill(1);
  const node = new Int32Array(n);
  for (let k = 0; k < n; k++) node[k] = k;
  const nearest = new Int32Array(n).fill(-1);
  const nearestDistance = new Float64Array(n).fill(Infinity);
  const rescan = (k) => {
    const row = rows[k];
    const b = base[k];
    let best = -1;
    let bestDistance = Infinity;
    for (let m = k + 1; m < n; m++) {
      const d = row[b + m];
      if (d < bestDistance) {
        bestDistance = d;
        best = m;
      }
    }
    nearest[k] = best;
    nearestDistance[k] = bestDistance;
  };
  for (let k = 0; k < n - 1; k++) rescan(k);
  const average = linkage === "average";
  const single = linkage === "single";
  const left = new Int32Array(n - 1);
  const right = new Int32Array(n - 1);
  const height = new Float64Array(n - 1);
  for (let step = 0; step < n - 1; step++) {
    let i = -1;
    let best = Infinity;
    for (let k = 0; k < n; k++) {
      const d = nearestDistance[k];
      if (d < best) {
        best = d;
        i = k;
      }
    }
    if (i < 0) {
      throw new Error("Agglomeration found no pair to merge");
    }
    const j = nearest[i];
    left[step] = node[i];
    right[step] = node[j];
    height[step] = best;
    const sizeI = size[i];
    const sizeJ = size[j];
    const merged = sizeI + sizeJ;
    active[j] = 0;
    nearest[j] = -1;
    nearestDistance[j] = Infinity;
    const rowI = rows[i];
    const baseI = base[i];
    const rowJ = rows[j];
    const baseJ = base[j];
    for (let k = 0; k < i; k++) {
      if (!active[k]) continue;
      const row = rows[k];
      const a = base[k] + i;
      const bj = base[k] + j;
      const x = row[a];
      const y = row[bj];
      const d = average ? (x * sizeI + y * sizeJ) / merged : single ? x < y ? x : y : x > y ? x : y;
      row[a] = d;
      row[bj] = Infinity;
      const neighbour = nearest[k];
      if (neighbour === i || neighbour === j) {
        rescan(k);
      } else if (d < nearestDistance[k] || d === nearestDistance[k] && i < neighbour) {
        nearest[k] = i;
        nearestDistance[k] = d;
      }
    }
    for (let k = i + 1; k < j; k++) {
      if (!active[k]) continue;
      const a = baseI + k;
      const bj = base[k] + j;
      const x = rowI[a];
      const y = rows[k][bj];
      rowI[a] = average ? (x * sizeI + y * sizeJ) / merged : single ? x < y ? x : y : x > y ? x : y;
      rows[k][bj] = Infinity;
      if (nearest[k] === j) rescan(k);
    }
    rowI[baseI + j] = Infinity;
    for (let k = j + 1; k < n; k++) {
      if (!active[k]) continue;
      const a = baseI + k;
      const x = rowI[a];
      const y = rowJ[baseJ + k];
      rowI[a] = average ? (x * sizeI + y * sizeJ) / merged : single ? x < y ? x : y : x > y ? x : y;
    }
    size[i] = merged;
    node[i] = n + step;
    if (i < n - 1) rescan(i);
  }
  return { left, right, height };
}
function dendrogramLeafOrder(left, right, n) {
  const order = new Int32Array(n);
  if (n === 1) return order;
  let position = 0;
  const stack = [2 * n - 2];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id < n) {
      order[position++] = id;
    } else {
      stack.push(right[id - n], left[id - n]);
    }
  }
  if (position !== n) {
    throw new Error("Dendrogram leaf order is not a permutation of the leaves");
  }
  return order;
}

// assets/js/app/analysis/compute/csv-export.js
function toCSVCell(value) {
  if (value === null || value === void 0) return "";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
var BATCH_CHARACTERS = 1 << 20;
var CsvBlobWriter = class {
  constructor() {
    this._encoder = new TextEncoder();
    this._parts = [];
    this._pending = [];
    this._pendingCharacters = 0;
  }
  line(text) {
    this._pending.push(text);
    this._pendingCharacters += text.length + 1;
    if (this._pendingCharacters >= BATCH_CHARACTERS) this._flush();
  }
  _flush() {
    if (this._pending.length === 0) return;
    const text = (this._parts.length === 0 ? "" : "\n") + this._pending.join("\n");
    this._parts.push(this._encoder.encode(text));
    this._pending = [];
    this._pendingCharacters = 0;
  }
  blob() {
    this._flush();
    return new Blob(this._parts, { type: "text/csv" });
  }
};
function pageValueReader(page) {
  const { values, categories = null, missingCode = null } = page;
  if (categories === null) return (i) => values[i];
  return (i) => {
    const code = values[i];
    return code === missingCode ? null : categories[code];
  };
}
function requirePages(pages) {
  if (!Array.isArray(pages)) {
    throw new TypeError("CSV export pages must be an array");
  }
  for (const page of pages) {
    if (page === null || typeof page !== "object" || typeof page.pageName !== "string" || !page.values || !Number.isSafeInteger(page.values.length)) {
      throw new TypeError("Each CSV export page needs a name and values");
    }
    if (page.categories !== void 0 && page.categories !== null && !Array.isArray(page.categories)) {
      throw new TypeError("CSV export page categories must be an array of labels");
    }
  }
}
function perCellCSVRows(layout, pages) {
  requirePages(pages);
  const writer = new CsvBlobWriter();
  if (layout === "page-data") {
    for (const page of pages) {
      const pageName = toCSVCell(page.pageName);
      const valueAt = pageValueReader(page);
      const cells = page.cellIndices ?? null;
      const firstRow = page.firstRow ?? 0;
      for (let i = 0; i < page.values.length; i++) {
        const cell = cells?.[i] ?? firstRow + i;
        writer.line(`${pageName},${toCSVCell(cell)},${toCSVCell(valueAt(i))}`);
      }
    }
  } else if (layout === "signature-scores") {
    for (const page of pages) {
      const prefix = `${toCSVCell(page.pageName)},${toCSVCell(page.setName ?? "")}`;
      const { values } = page;
      const cells = page.cellIndices ?? null;
      const firstRow = page.firstRow ?? 0;
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (!Number.isFinite(value)) continue;
        const cell = cells?.[i] ?? firstRow + i;
        writer.line(`${prefix},${toCSVCell(cell)},${String(value)}`);
      }
    }
  } else {
    throw new RangeError(`Unknown CSV export layout: ${String(layout)}`);
  }
  return writer.blob();
}
function markerStatisticsCSV(markers) {
  const { genes, groups, scores, logfoldchanges, pvals, pvalsAdj, pctIn, pctRef, auroc } = markers;
  const writer = new CsvBlobWriter();
  writer.line("group,names,scores,logfoldchanges,pvals,pvals_adj,pct_nz_group,pct_nz_reference,auroc,small_group,tested");
  const names = genes.map((gene) => toCSVCell(gene));
  groups.forEach((group, g) => {
    const groupCell = toCSVCell(group.name);
    const small = group.small ? "true" : "false";
    const tested = group.tested ? "true" : "false";
    for (let i = 0; i < genes.length; i++) {
      writer.line([
        groupCell,
        names[i],
        toCSVCell(scores[g][i]),
        toCSVCell(logfoldchanges[g][i]),
        toCSVCell(pvals[g][i]),
        toCSVCell(pvalsAdj[g][i]),
        toCSVCell(pctIn[g][i] / 100),
        toCSVCell(pctRef[g][i] / 100),
        toCSVCell(auroc[g][i]),
        small,
        tested
      ].join(","));
    }
  });
  return writer.blob();
}

// assets/js/app/analysis/plots/plotly-violin-density.js
var FP_SAFE = 1e-4 * Number.MAX_VALUE;
function kernel(t) {
  return 1 / Math.sqrt(2 * Math.PI) * Math.exp(-0.5 * t * t);
}
function interp2(sorted, fraction) {
  const n = fraction * sorted.length - 0.5;
  if (n < 0) return sorted[0];
  if (n > sorted.length - 1) return sorted[sorted.length - 1];
  const frac = n % 1;
  return frac * sorted[Math.ceil(n)] + (1 - frac) * sorted[Math.floor(n)];
}
function plotlyViolinPlan(values) {
  if (values.length === 0) {
    throw new RangeError("A violin density needs at least one value");
  }
  const sorted = sortLikePlotly(values);
  const n = sorted.length;
  const min = sorted[0];
  const max = sorted[n - 1];
  const spread = max - min;
  if (!spread) return { sorted, bandwidth: 0, count: 0, start: min, step: 0 };
  let sum = 0;
  for (let i = 0; i < n; i++) sum = sum + sorted[i];
  const mean3 = sum / n;
  let squares = 0;
  for (let i = 0; i < n; i++) squares = squares + Math.pow(sorted[i] - mean3, 2);
  const stdev = Math.sqrt(squares / (n - 1 || n));
  const q1 = interp2(sorted, 0.25);
  const q3 = interp2(sorted, 0.75);
  const bandwidth = Math.max(
    1.059 * Math.min(stdev, (q3 - q1) / 1.349) * Math.pow(n, -0.2),
    spread / 100
  );
  const span = [min - 2 * bandwidth, max + 2 * bandwidth];
  for (let i = 0; i < 2; i++) {
    if (span[i] < -FP_SAFE) span[i] = -FP_SAFE;
    else if (span[i] > FP_SAFE) span[i] = FP_SAFE;
  }
  if (span[0] === span[1]) {
    const widen = Math.max(1, Math.abs(1e-6 * span[0]));
    span[0] -= widen;
    span[1] += widen;
  }
  const width = span[1] - span[0];
  const slots = Math.ceil(width / (bandwidth / 3));
  const step = width / slots;
  if (!Number.isFinite(step) || !Number.isFinite(slots)) {
    throw new RangeError("The violin span is not finite");
  }
  let count = 0;
  for (let t = span[0]; t < span[1] + step / 2; t += step) count++;
  return { sorted, bandwidth, count, start: span[0], step, end: span[1] };
}
function plotlyViolinKernelDensity(sorted, bandwidth) {
  const n = sorted.length;
  const scale = 1 / (n * bandwidth);
  let runs = 0;
  for (let j = 0, k; j < n; j = k) {
    const v = sorted[j];
    for (k = j + 1; k < n && sorted[k] === v; ) k++;
    runs++;
  }
  if (2 * runs > n) {
    return (t) => {
      let e = 0;
      for (let i = 0; i < n; i++) e += kernel((t - sorted[i]) / bandwidth);
      return scale * e;
    };
  }
  let windowed = bandwidth > 0 && bandwidth < Infinity;
  const runValues = new Float64Array(runs);
  const runCounts = new Float64Array(runs);
  runs = 0;
  for (let j = 0, k; j < n; j = k) {
    const v = sorted[j];
    for (k = j + 1; k < n && sorted[k] === v; ) k++;
    if (runs > 0 && !(v > runValues[runs - 1])) windowed = false;
    runValues[runs] = v;
    runCounts[runs++] = k - j;
  }
  return (t) => {
    let e = 0;
    let l = 0;
    let h = runs;
    if (windowed) {
      for (let m = runs; l < m; ) {
        const x2 = l + m >> 1;
        if ((t - runValues[x2]) / bandwidth < 39) m = x2;
        else l = x2 + 1;
      }
      let x = l;
      for (let m = runs; x < m; ) {
        const y = x + m >> 1;
        if ((t - runValues[y]) / bandwidth > -39) x = y + 1;
        else m = y;
      }
      h = x;
    }
    for (; l < h; l++) {
      const term = kernel((t - runValues[l]) / bandwidth);
      if (term !== 0) for (let y = runCounts[l]; y > 0; y--) e += term;
    }
    return scale * e;
  };
}
function plotlyViolinDensitySlice(plan, from, to) {
  const end = Math.min(to, plan.count);
  const size = Math.max(0, end - from);
  const t = new Float64Array(size);
  const v = new Float64Array(size);
  if (size === 0) return { t, v };
  const density = plotlyViolinKernelDensity(plan.sorted, plan.bandwidth);
  let point = plan.start;
  for (let k = 0; k < end; k++, point += plan.step) {
    if (k >= from) {
      t[k - from] = point;
      v[k - from] = density(point);
    }
  }
  return { t, v };
}

// assets/js/data/categorical-storage-contract.js
var STORAGE_BY_DTYPE = Object.freeze({
  uint8: Object.freeze({
    dtype: "uint8",
    TypedArrayClass: Uint8Array,
    missingValue: 255,
    maxCategories: 255
  }),
  uint16: Object.freeze({
    dtype: "uint16",
    TypedArrayClass: Uint16Array,
    missingValue: 65535,
    maxCategories: 65535
  }),
  uint32: Object.freeze({
    dtype: "uint32",
    TypedArrayClass: Uint32Array,
    missingValue: 4294967295,
    maxCategories: 4294967295
  })
});
var CATEGORICAL_CODE_DTYPES = Object.freeze(["uint8", "uint16", "uint32"]);
var MAX_CATEGORICAL_CATEGORIES = STORAGE_BY_DTYPE.uint32.maxCategories;
function categoricalStorageForCodes(codes, label) {
  if (typeof label !== "string" || label.length === 0) {
    throw new TypeError("Categorical storage label must be a non-empty string");
  }
  if (codes instanceof Uint8Array) return STORAGE_BY_DTYPE.uint8;
  if (codes instanceof Uint16Array) return STORAGE_BY_DTYPE.uint16;
  if (codes instanceof Uint32Array) return STORAGE_BY_DTYPE.uint32;
  throw new TypeError(
    `${label} codes must be one of the exact categorical code widths ${CATEGORICAL_CODE_DTYPES.join(", ")}`
  );
}
function isCategoricalCodes(codes) {
  return codes instanceof Uint8Array || codes instanceof Uint16Array || codes instanceof Uint32Array;
}
function missingCategoryCode(codes) {
  return categoricalStorageForCodes(codes, "Categorical codes").missingValue;
}

// assets/js/app/analysis/compute/composition-counts.js
function requireCodeMap(map, label) {
  if (!(map instanceof Int32Array) || map.length === 0) {
    throw new TypeError(`${label} must be a non-empty Int32Array (code to index, -1 to leave out)`);
  }
  return map;
}
function requireCodes(codes, cellCount, label) {
  if (!isCategoricalCodes(codes) || codes.length !== cellCount) {
    throw new TypeError(`${label} must be categorical codes of one per cell`);
  }
  return codes;
}
function compositionCounts(payload) {
  if (payload === null || typeof payload !== "object") {
    throw new TypeError("Composition counts need a payload object");
  }
  const { typeCount, sampleCount, conditionCount, scope } = payload;
  for (const [name, value] of [
    ["typeCount", typeCount],
    ["sampleCount", sampleCount],
    ["conditionCount", conditionCount]
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`Composition ${name} must be a positive integer`);
    }
  }
  const typeCodes = payload.typeCodes;
  if (!isCategoricalCodes(typeCodes)) {
    throw new TypeError("Composition type codes must be categorical codes");
  }
  const cellCount = typeCodes.length;
  const typeIndexOfCode = requireCodeMap(payload.typeIndexOfCode, "Composition type map");
  const hasSamples = payload.sampleCodes !== null;
  const hasConditions = payload.conditionCodes !== null;
  const sampleCodes = hasSamples ? requireCodes(payload.sampleCodes, cellCount, "Composition sample codes") : null;
  const conditionCodes = hasConditions ? requireCodes(payload.conditionCodes, cellCount, "Composition condition codes") : null;
  const sampleIndexOfCode = hasSamples ? requireCodeMap(payload.sampleIndexOfCode, "Composition sample map") : null;
  const conditionIndexOfCode = hasConditions ? requireCodeMap(payload.conditionIndexOfCode, "Composition condition map") : null;
  if (!hasSamples && sampleCount !== 1) throw new RangeError("Composition without samples has one sample");
  if (!hasConditions && conditionCount !== 1) throw new RangeError("Composition without a condition has one condition");
  if (scope !== null && (!(scope instanceof Uint8Array) || scope.length !== cellCount)) {
    throw new TypeError("Composition scope must be null or one byte a cell");
  }
  const unitCount = sampleCount * conditionCount;
  if (!Number.isSafeInteger(typeCount * unitCount)) {
    throw new RangeError("Composition table is too large to address");
  }
  const counts = new Uint32Array(typeCount * unitCount);
  const missingType = missingCategoryCode(typeCodes);
  const missingSample = hasSamples ? missingCategoryCode(sampleCodes) : -1;
  const missingCondition = hasConditions ? missingCategoryCode(conditionCodes) : -1;
  const typeMapLength = typeIndexOfCode.length;
  const sampleMapLength = hasSamples ? sampleIndexOfCode.length : 0;
  const conditionMapLength = hasConditions ? conditionIndexOfCode.length : 0;
  for (let cell = 0; cell < cellCount; cell++) {
    if (scope !== null && scope[cell] === 0) continue;
    const typeCode = typeCodes[cell];
    if (typeCode === missingType || typeCode >= typeMapLength) continue;
    const type = typeIndexOfCode[typeCode];
    if (type < 0) continue;
    let sample = 0;
    if (hasSamples) {
      const code = sampleCodes[cell];
      if (code === missingSample || code >= sampleMapLength) continue;
      sample = sampleIndexOfCode[code];
      if (sample < 0) continue;
    }
    let condition = 0;
    if (hasConditions) {
      const code = conditionCodes[cell];
      if (code === missingCondition || code >= conditionMapLength) continue;
      condition = conditionIndexOfCode[code];
      if (condition < 0) continue;
    }
    counts[type * unitCount + sample * conditionCount + condition] += 1;
  }
  return { counts, typeCount, unitCount };
}

// assets/js/app/analysis/compute/group-expression-summary.js
function createGroupSummaryContext(cellGroup, groupCount) {
  if (!(cellGroup instanceof Int16Array) && !(cellGroup instanceof Int32Array)) {
    throw new TypeError("Group summary cell groups must be an Int16Array or Int32Array");
  }
  if (!Number.isSafeInteger(groupCount) || groupCount < 1) {
    throw new RangeError("Group summary needs at least one group");
  }
  const sizes = new Uint32Array(groupCount);
  for (let cell = 0; cell < cellGroup.length; cell++) {
    const group = cellGroup[cell];
    if (group < -1 || group >= groupCount) {
      throw new RangeError(`Group summary cell ${cell} names group ${group} of ${groupCount}`);
    }
    if (group >= 0) sizes[group] += 1;
  }
  return { cellGroup, groupCount, sizes };
}
function summarizeGenesByGroup(context, genes, cutoff, bins = 0) {
  if (!Array.isArray(genes)) throw new TypeError("Group summary genes must be an array");
  if (!Number.isFinite(cutoff)) throw new TypeError("Group summary cutoff must be finite");
  if (!Number.isSafeInteger(bins) || bins < 0) throw new RangeError("Group summary bins must be a whole number");
  const { cellGroup, groupCount, sizes } = context;
  const geneCount = genes.length;
  const sum = new Float64Array(geneCount * groupCount);
  const expressing = new Uint32Array(geneCount * groupCount);
  const sumExpressing = new Float64Array(geneCount * groupCount);
  const nonZero = new Uint32Array(groupCount);
  const zeroExpressed = 0 > cutoff;
  const range = new Float64Array(bins > 0 ? geneCount * 2 : 0);
  const histogram = new Uint32Array(bins > 0 ? geneCount * groupCount * bins : 0);
  let grouped = 0;
  for (let group = 0; group < groupCount; group++) grouped += sizes[group];
  for (let gene = 0; gene < geneCount; gene++) {
    const sample = geneSampleOf(genes[gene], 0);
    if (sample.length !== cellGroup.length) {
      throw new RangeError(`Group summary gene ${gene} has ${formatCountOf(sample.length, "cell")}, not ${cellGroup.length}`);
    }
    const base = gene * groupCount;
    nonZero.fill(0);
    const { indices, values } = sample;
    for (let entry = 0; entry < indices.length; entry++) {
      const group = cellGroup[indices[entry]];
      if (group < 0) continue;
      const value = values[entry];
      if (value === 0) continue;
      nonZero[group] += 1;
      sum[base + group] += value;
      if (value > cutoff) {
        expressing[base + group] += 1;
        sumExpressing[base + group] += value;
      }
    }
    if (zeroExpressed) {
      for (let group = 0; group < groupCount; group++) {
        expressing[base + group] += sizes[group] - nonZero[group];
      }
    }
    if (bins > 0) binGene(gene);
  }
  function binGene(gene) {
    const sample = geneSampleOf(genes[gene], 0);
    const { indices, values } = sample;
    let stored = 0;
    let low = Infinity;
    let high = -Infinity;
    for (let entry = 0; entry < indices.length; entry++) {
      if (cellGroup[indices[entry]] < 0) continue;
      const value = values[entry];
      if (value === 0) continue;
      stored += 1;
      if (value < low) low = value;
      if (value > high) high = value;
    }
    if (stored < grouped) {
      low = Math.min(low, 0);
      high = Math.max(high, 0);
    }
    if (!(high > low)) {
      low = Number.isFinite(low) ? low : 0;
      high = low + 1;
    }
    range[2 * gene] = low;
    range[2 * gene + 1] = high;
    const scale = bins / (high - low);
    const binOf = (value) => Math.min(bins - 1, Math.max(0, Math.floor((value - low) * scale)));
    const zeroBin = binOf(0);
    const base = gene * groupCount;
    const counted = new Uint32Array(groupCount);
    for (let entry = 0; entry < indices.length; entry++) {
      const group = cellGroup[indices[entry]];
      if (group < 0) continue;
      const value = values[entry];
      if (value === 0) continue;
      counted[group] += 1;
      histogram[(base + group) * bins + binOf(value)] += 1;
    }
    for (let group = 0; group < groupCount; group++) {
      histogram[(base + group) * bins + zeroBin] += sizes[group] - counted[group];
    }
  }
  return {
    sum,
    expressing,
    sumExpressing,
    sizes: sizes.slice(),
    geneCount,
    groupCount,
    bins,
    range,
    histogram
  };
}

// assets/js/app/analysis/compute/operation-handlers.js
function computeCorrelation(payload) {
  const { xValues, yValues, method = "pearson" } = payload;
  const len = Math.min(xValues?.length || 0, yValues?.length || 0);
  if (len === 0) {
    return { r: NaN, pValue: NaN, n: 0, method };
  }
  const moments = pairedCentredMoments(xValues, yValues);
  const { n } = moments;
  if (n < 3) {
    return { r: NaN, pValue: NaN, n, method };
  }
  const slope = moments.sxx > 0 ? moments.sxy / moments.sxx : 0;
  const intercept = moments.meanY - slope * moments.meanX;
  let r;
  if (method === "spearman") {
    if (n === len) {
      r = pearsonCorrelation(computeRanks(xValues), computeRanks(yValues));
    } else {
      const xValid = new Float32Array(n);
      const yValid = new Float32Array(n);
      let k = 0;
      for (let i = 0; i < len; i++) {
        const x = xValues[i];
        const y = yValues[i];
        if (!isValidNumber(x) || !isValidNumber(y)) continue;
        xValid[k] = x;
        yValid[k] = y;
        k++;
      }
      r = pearsonCorrelation(computeRanks(xValid), computeRanks(yValid));
    }
  } else {
    r = pearsonFromCentredMoments(moments);
  }
  if (!Number.isFinite(r)) {
    throw new RangeError("Correlation coefficient must be finite.");
  }
  const rSquared = r * r;
  const denomT = 1 - rSquared;
  const pValue = denomT <= 0 ? 0 : tTwoSidedPValue(r * Math.sqrt((n - 2) / denomT), n - 2);
  return {
    r,
    rSquared,
    pValue,
    n,
    method,
    slope,
    intercept
  };
}
function computeDifferential(payload) {
  const { groupAValues, groupBValues, method = "wilcox" } = payload;
  return twoSampleDifferential(
    geneSampleOf(groupAValues, 0),
    geneSampleOf(groupBValues, 1),
    method,
    differentialOptions(payload)
  );
}
function differentialOptions(payload) {
  const options = {};
  if (payload.pConvention !== void 0) options.pConvention = payload.pConvention;
  if (payload.foldChange !== void 0) options.foldChange = payload.foldChange;
  return options;
}
var twoGroupContexts = /* @__PURE__ */ new Map();
function requireContextId(contextId) {
  if (typeof contextId !== "string" || contextId.length === 0) {
    throw new TypeError("Two-group context id must be a non-empty string");
  }
  return contextId;
}
function setTwoGroupContext(payload) {
  const contextId = requireContextId(payload.contextId);
  if (twoGroupContexts.has(contextId)) {
    throw new Error(`Two-group context "${contextId}" is already held`);
  }
  const context = createTwoGroupContext(payload.groupOfCell);
  twoGroupContexts.set(contextId, context);
  return { sizeA: context.sizeA, sizeB: context.sizeB };
}
function heldTwoGroupContext(contextId) {
  const context = twoGroupContexts.get(requireContextId(contextId));
  if (context === void 0) {
    throw new Error(`Two-group context "${contextId}" is not held`);
  }
  return context;
}
function differentialBatch(genes, method) {
  return {
    meanA: new Float64Array(genes),
    meanB: new Float64Array(genes),
    pctA: new Float64Array(genes),
    pctB: new Float64Array(genes),
    log2FoldChange: new Float64Array(genes),
    pValue: new Float64Array(genes),
    statistic: new Float64Array(genes),
    score: new Float64Array(genes),
    auroc: new Float64Array(genes),
    nA: new Uint32Array(genes),
    nB: new Uint32Array(genes),
    method
  };
}
function storeDifferential(out, gene, result) {
  out.meanA[gene] = result.meanA;
  out.meanB[gene] = result.meanB;
  out.pctA[gene] = result.pctA;
  out.pctB[gene] = result.pctB;
  out.log2FoldChange[gene] = result.log2FoldChange;
  out.pValue[gene] = result.pValue;
  out.statistic[gene] = result.statistic;
  out.score[gene] = result.score;
  out.auroc[gene] = result.auroc;
  out.nA[gene] = result.nA;
  out.nB[gene] = result.nB;
}
function computeDifferentialOfColumns(payload) {
  const context = heldTwoGroupContext(payload.contextId);
  const { columns, method } = payload;
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new TypeError("Differential expression columns must be a non-empty array");
  }
  const options = differentialOptions(payload);
  const out = differentialBatch(columns.length, method);
  columns.forEach((values, gene) => {
    const { sampleA, sampleB } = splitTwoGroups(values, context);
    storeDifferential(out, gene, twoSampleDifferential(sampleA, sampleB, method, options));
  });
  return out;
}
function computeDifferentialOfSubset(payload) {
  const context = heldTwoGroupContext(payload.contextId);
  const { block, method } = payload;
  const { pointers, positions, values } = block ?? {};
  if (!(pointers instanceof Float64Array) || pointers.length < 1 || pointers[0] !== 0) {
    throw new TypeError("Subset pointers must be a Float64Array starting at 0");
  }
  if (!(positions instanceof Uint32Array) || !(values instanceof Float32Array) || positions.length !== values.length || pointers[pointers.length - 1] !== values.length) {
    throw new TypeError("Subset entries must be matching Uint32Array positions and Float32Array values");
  }
  const genes = pointers.length - 1;
  const options = differentialOptions(payload);
  const out = differentialBatch(genes, method);
  for (let gene = 0; gene < genes; gene++) {
    const from = pointers[gene];
    const to = pointers[gene + 1];
    const { sampleA, sampleB } = splitTwoGroups({
      length: context.length,
      indices: positions.subarray(from, to),
      values: values.subarray(from, to)
    }, context);
    storeDifferential(out, gene, twoSampleDifferential(sampleA, sampleB, method, options));
  }
  return out;
}
function clearTwoGroupContext(payload) {
  return { released: twoGroupContexts.delete(requireContextId(payload.contextId)) };
}
function computeKernelDensity(payload) {
  const { support, weights, xs, bandwidth, count } = payload;
  if (!(support instanceof Float64Array) && !(support instanceof Float32Array)) {
    throw new TypeError("Kernel density support must be a Float64Array or Float32Array");
  }
  if (weights !== null && !(weights instanceof Float64Array)) {
    throw new TypeError("Kernel density weights must be a Float64Array or null (unit weights)");
  }
  if (!(xs instanceof Float64Array)) {
    throw new TypeError("Kernel density xs must be a Float64Array");
  }
  if (weights !== null && weights.length !== support.length) {
    throw new RangeError("Kernel density weights must align with the support");
  }
  if (!(bandwidth > 0) || !Number.isFinite(bandwidth)) {
    throw new RangeError("Kernel density bandwidth must be a positive finite number");
  }
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new RangeError("Kernel density count must be a positive safe integer");
  }
  return { density: kernelDensityAt(support, weights, xs, bandwidth, count) };
}
function computeBoxStatistics(payload) {
  const { values, points } = payload;
  if (!(values instanceof Float32Array) && !(values instanceof Float64Array)) {
    throw new TypeError("Box statistics values must be a Float32Array or Float64Array");
  }
  if (points !== "outliers" && points !== "all") {
    throw new RangeError('Box statistics points must be "outliers" or "all"');
  }
  const report = finiteNumbersReport(values);
  if (report.finiteCount === 0) return { summary: null, ...report };
  return { summary: plotlyBoxSummary(finiteNumbers(values), points), ...report };
}
function computeViolinDensity(payload) {
  const { values, from, to, includeSorted } = payload;
  if (!(values instanceof Float32Array) && !(values instanceof Float64Array)) {
    throw new TypeError("Violin density values must be a Float32Array or Float64Array");
  }
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) {
    throw new RangeError("Violin density slice bounds must be ordered non-negative integers");
  }
  if (typeof includeSorted !== "boolean") {
    throw new TypeError("Violin density includeSorted must be exactly boolean");
  }
  const finite = finiteNumbers(values);
  if (finite.length === 0) {
    return { bandwidth: 0, count: 0, t: new Float64Array(0), v: new Float64Array(0), empty: true };
  }
  const plan = plotlyViolinPlan(finite);
  const { t, v } = plotlyViolinDensitySlice(plan, from, to);
  const result = { bandwidth: plan.bandwidth, count: plan.count, t, v };
  if (includeSorted) {
    Object.assign(
      result,
      { sorted: plan.sorted, box: plotlyViolinBox(plan.sorted, "outliers") },
      finiteNumbersReport(values)
    );
  }
  return result;
}
function requireTypedValues(values, label) {
  if (!ArrayBuffer.isView(values) || values instanceof DataView) {
    throw new TypeError(`${label} values must be a typed array`);
  }
  return values;
}
function computeSummaryStatistics(payload) {
  return computeStats(requireTypedValues(payload.values, "Summary statistics"));
}
function computeStatisticalTests(payload) {
  const { pages, dataType } = payload;
  if (!Array.isArray(pages)) {
    throw new TypeError("Statistical tests need an array of pages");
  }
  for (const page of pages) requireTypedValues(page.values, "Statistical test");
  return { results: runStatisticalTests(pages, dataType) };
}
function computeOrderStatistics(payload) {
  const values = requireTypedValues(payload.values, "Order statistics");
  const { positions } = payload;
  if (!Array.isArray(positions) || positions.some((p) => !Number.isSafeInteger(p) || p < 0 || p >= values.length)) {
    throw new RangeError("Order statistic positions must lie within the values");
  }
  return { selected: selectSorted(values, positions) };
}
function computeHistogramSamples(payload) {
  const { pages, nbins } = payload;
  if (!Array.isArray(pages)) throw new TypeError("Histogram samples need an array of pages");
  for (const values of pages) requireTypedValues(values, "Histogram");
  if (!Number.isSafeInteger(nbins) || nbins <= 0) {
    throw new RangeError("Histogram bin count must be a positive integer");
  }
  return { ...histogramSamples(pages, nbins), finite: pages.map(finiteNumbersReport) };
}
function computeDensityPlan(payload) {
  const { values, bandwidthMult, maxKernelTerms } = payload;
  requireTypedValues(values, "Density");
  if (!(bandwidthMult > 0) || !Number.isFinite(bandwidthMult)) {
    throw new RangeError("Density bandwidth multiplier must be a positive finite number");
  }
  if (!Number.isSafeInteger(maxKernelTerms) || maxKernelTerms <= 0) {
    throw new RangeError("Density kernel-term bound must be a positive integer");
  }
  return {
    ...densityCurveOrPlan(values, bandwidthMult, maxKernelTerms),
    ...finiteNumbersReport(values)
  };
}
function computePairwiseDistances(payload) {
  const { values, nItems, nFeatures, metric, rowFrom, rowTo } = payload;
  return { distances: pairwiseDistanceRows(values, nItems, nFeatures, metric, rowFrom, rowTo) };
}
function computeAgglomeration(payload) {
  const { blocks, ranges, nItems, linkage } = payload;
  const { left, right, height } = agglomerate(blocks, ranges, nItems, linkage);
  return { left, right, height, order: dendrogramLeafOrder(left, right, nItems) };
}
function computeCsvExport(payload) {
  const { layout, pages } = payload;
  if (layout === "marker-statistics") return { rows: markerStatisticsCSV(payload.markers) };
  return { rows: perCellCSVRows(layout, pages) };
}
function geneMomentsOf(column) {
  const sample = geneSampleOf(column, 0);
  let sum = 0;
  let sumSq = 0;
  let nonZero = 0;
  let nonFinite = 0;
  const { values } = sample;
  for (let k = 0; k < values.length; k++) {
    const value = values[k];
    if (!Number.isFinite(value)) {
      nonFinite++;
      continue;
    }
    if (value === 0) continue;
    nonZero++;
    sum += value;
    sumSq += value * value;
  }
  return { sum, sumSq, nonZero, n: sample.length - nonFinite };
}
function computeGeneMoments(payload) {
  const { columns } = payload;
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new TypeError("Gene moment columns must be a non-empty array");
  }
  const moments = new Float64Array(columns.length * 4);
  columns.forEach((column, gene) => {
    const { sum, sumSq, nonZero, n } = geneMomentsOf(column);
    moments.set([sum, sumSq, nonZero, n], gene * 4);
  });
  return { moments };
}
function executeOperation(operationType, payload) {
  switch (operationType) {
    case OperationType.COMPUTE_CORRELATION:
      return computeCorrelation(payload);
    case OperationType.COMPUTE_DIFFERENTIAL:
      return computeDifferential(payload);
    case OperationType.SET_TWO_GROUP_CONTEXT:
      return setTwoGroupContext(payload);
    case OperationType.COMPUTE_DIFFERENTIAL_OF_COLUMNS:
      return computeDifferentialOfColumns(payload);
    case OperationType.CLEAR_TWO_GROUP_CONTEXT:
      return clearTwoGroupContext(payload);
    case OperationType.COMPUTE_DIFFERENTIAL_OF_SUBSET:
      return computeDifferentialOfSubset(payload);
    case OperationType.COMPUTE_KERNEL_DENSITY:
      return computeKernelDensity(payload);
    case OperationType.COMPUTE_BOX_STATISTICS:
      return computeBoxStatistics(payload);
    case OperationType.COMPUTE_VIOLIN_DENSITY:
      return computeViolinDensity(payload);
    case OperationType.COMPUTE_SUMMARY_STATISTICS:
      return computeSummaryStatistics(payload);
    case OperationType.COMPUTE_STATISTICAL_TESTS:
      return computeStatisticalTests(payload);
    case OperationType.COMPUTE_ORDER_STATISTICS:
      return computeOrderStatistics(payload);
    case OperationType.COMPUTE_HISTOGRAM_SAMPLES:
      return computeHistogramSamples(payload);
    case OperationType.COMPUTE_DENSITY_PLAN:
      return computeDensityPlan(payload);
    case OperationType.COMPUTE_PAIRWISE_DISTANCES:
      return computePairwiseDistances(payload);
    case OperationType.COMPUTE_AGGLOMERATION:
      return computeAgglomeration(payload);
    case OperationType.COMPUTE_CSV_EXPORT:
      return computeCsvExport(payload);
    case OperationType.COMPUTE_GENE_MOMENTS:
      return computeGeneMoments(payload);
    // --- composition and dot plot ---
    case OperationType.COMPOSITION_COUNTS:
      return compositionCounts(payload);
    case OperationType.GROUP_SUMMARY_SET_CONTEXT:
      return setGroupSummaryContext(payload);
    case OperationType.GROUP_SUMMARY_COMPUTE_GENES:
      return computeGroupSummaryOfGenes(payload);
    case OperationType.GROUP_SUMMARY_CLEAR_CONTEXT:
      return clearGroupSummaryContext(payload);
    default:
      throw new Error(`Unknown operation type: ${operationType}`);
  }
}
var groupSummaryContexts = /* @__PURE__ */ new Map();
function requireGroupSummaryId(contextId) {
  if (typeof contextId !== "string" || contextId.length === 0) {
    throw new TypeError("Group summary context id must be a non-empty string");
  }
  return contextId;
}
function setGroupSummaryContext(payload) {
  const contextId = requireGroupSummaryId(payload?.contextId);
  const context = createGroupSummaryContext(payload.cellGroup, payload.groupCount);
  groupSummaryContexts.set(contextId, context);
  return { groups: context.groupCount, cells: context.cellGroup.length };
}
function computeGroupSummaryOfGenes(payload) {
  const contextId = requireGroupSummaryId(payload?.contextId);
  const context = groupSummaryContexts.get(contextId);
  if (context === void 0) throw new Error(`Group summary context "${contextId}" is not held`);
  return summarizeGenesByGroup(context, payload.columns, payload.cutoff, payload.bins);
}
function clearGroupSummaryContext(payload) {
  return { released: groupSummaryContexts.delete(requireGroupSummaryId(payload?.contextId)) };
}

// assets/js/app/analysis/compute/ucell.js
function ucellSetValues(cellCount, S, parts) {
  const setValues = new Float32Array(cellCount * S);
  for (const { slots, ranges } of parts) {
    const { pointers, cells, values } = ranges;
    if (pointers.length - 1 !== slots.length) {
      throw new RangeError("UCell set gene entries must name one set slot per gene");
    }
    for (let gene = 0; gene < slots.length; gene++) {
      const slot = slots[gene];
      if (!Number.isSafeInteger(slot) || slot < 0 || slot >= S) throw new RangeError("UCell set slot outside the set genes");
      for (let k = pointers[gene]; k < pointers[gene + 1]; k++) {
        const cell = cells[k];
        if (cell >= cellCount) throw new RangeError("UCell entry outside the cell range");
        setValues[cell * S + slot] = values[k];
      }
    }
  }
  return setValues;
}
function createUcellContext({ cellCount, setValues, setGeneCount, geneCount, sets, maxRank }) {
  const S = setGeneCount;
  if (!(setValues instanceof Float32Array) || setValues.length !== cellCount * S) {
    throw new TypeError("UCell set values must be a Float32Array of cells × set genes");
  }
  const sorted = new Float32Array(cellCount * S);
  const slotOf = new Uint16Array(cellCount * S);
  const order = new Array(S);
  for (let c = 0; c < cellCount; c++) {
    const base = c * S;
    for (let s = 0; s < S; s++) order[s] = s;
    order.sort((x, y) => setValues[base + x] - setValues[base + y] || x - y);
    for (let k = 0; k < S; k++) {
      sorted[base + k] = setValues[base + order[k]];
      slotOf[base + order[k]] = k;
    }
  }
  return {
    cellCount,
    S,
    geneCount,
    sets,
    maxRank,
    sorted,
    slotOf,
    setValues,
    greaterDiff: new Int32Array(cellCount * (S + 1)),
    equalDiff: new Int32Array(cellCount * (S + 1)),
    stored: new Uint32Array(cellCount)
  };
}
function bound(sorted, base, S, v, strict) {
  let lo = 0;
  let hi = S;
  while (lo < hi) {
    const mid = lo + hi >> 1;
    const u = sorted[base + mid];
    if (strict ? u < v : u <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function ucellAddGenes(context, { pointers, cells, values }) {
  const { S, sorted, greaterDiff, equalDiff, stored, cellCount } = context;
  const width = S + 1;
  const last = pointers[pointers.length - 1];
  for (let e = 0; e < last; e++) {
    const c = cells[e];
    if (c >= cellCount) throw new RangeError("UCell entry outside the cell range");
    const v = values[e];
    stored[c]++;
    if (!Number.isFinite(v)) continue;
    const base = c * S;
    const a = bound(sorted, base, S, v, true);
    const b = a === S || sorted[base + a] !== v ? a : bound(sorted, base, S, v, false);
    const row = c * width;
    if (a > 0) {
      greaterDiff[row]++;
      greaterDiff[row + a]--;
    }
    if (b > a) {
      equalDiff[row + a]++;
      equalDiff[row + b]--;
    }
  }
}
function ucellFinish(context) {
  const { S, sorted, slotOf, greaterDiff, equalDiff, stored, cellCount, geneCount, sets, maxRank, setValues } = context;
  const width = S + 1;
  const scores = new Float32Array(cellCount * sets.length);
  const greater = new Float64Array(S);
  const equal = new Float64Array(S);
  for (let c = 0; c < cellCount; c++) {
    const base = c * S;
    const row = c * width;
    const zeros = geneCount - stored[c];
    const a0 = bound(sorted, base, S, 0, true);
    const b0 = bound(sorted, base, S, 0, false);
    let runningGreater = 0;
    let runningEqual = 0;
    for (let k = 0; k < S; k++) {
      runningGreater += greaterDiff[row + k] + (k < a0 ? zeros : 0);
      runningEqual += equalDiff[row + k];
      greater[k] = runningGreater;
      equal[k] = runningEqual + (k >= a0 && k < b0 ? zeros : 0);
    }
    for (let set = 0; set < sets.length; set++) {
      const members = sets[set];
      let rankSum = 0;
      let missing = false;
      for (const s of members) {
        if (!Number.isFinite(setValues[base + s])) {
          missing = true;
          break;
        }
        const k = slotOf[base + s];
        let rank = greater[k] + (equal[k] + 1) / 2;
        if (rank > maxRank) rank = maxRank + 1;
        rankSum += rank;
      }
      const size = members.length;
      scores[c * sets.length + set] = missing ? NaN : 1 - (rankSum - size * (size + 1) / 2) / (size * maxRank);
    }
  }
  return scores;
}

// assets/js/app/analysis/compute/data-worker.js
var workerId = null;
var geneRoutes = /* @__PURE__ */ new Map();
function openGeneRoute(payload) {
  const { route, generation, port } = payload ?? {};
  if (typeof route !== "string" || route.length === 0 || !Number.isSafeInteger(generation) || generation < 0 || !(port instanceof MessagePort)) {
    throw new TypeError("GENE_ROUTE_OPEN: payload must be {route, generation, port}");
  }
  closeGeneRoute({ route });
  const inbox = { generation, port, delivered: /* @__PURE__ */ new Map(), waiting: /* @__PURE__ */ new Map() };
  port.onmessage = (event) => {
    const { id, generation: sentFor, ...data } = event.data;
    if (geneRoutes.get(route) !== inbox || sentFor !== inbox.generation) return;
    const waiter = inbox.waiting.get(id);
    if (waiter === void 0) {
      inbox.delivered.set(id, data);
    } else {
      inbox.waiting.delete(id);
      waiter.resolve(data);
    }
  };
  geneRoutes.set(route, inbox);
  return { route, generation };
}
function closeGeneRoute(payload) {
  const route = payload?.route;
  const inbox = geneRoutes.get(route);
  if (inbox === void 0) return { released: false };
  geneRoutes.delete(route);
  inbox.port.close();
  for (const { reject } of inbox.waiting.values()) {
    reject(new Error(`The gene route '${route}' was closed before its genes arrived`));
  }
  return { released: true };
}
function takeDelivery(delivery) {
  const { route, id, generation } = delivery ?? {};
  const inbox = geneRoutes.get(route);
  if (inbox === void 0) {
    return Promise.reject(new Error(`No gene route '${String(route)}' is open in this worker`));
  }
  if (generation !== inbox.generation) return Promise.resolve(null);
  const data = inbox.delivered.get(id);
  if (data !== void 0) {
    inbox.delivered.delete(id);
    return Promise.resolve(data);
  }
  return new Promise((resolve, reject) => inbox.waiting.set(id, { resolve, reject }));
}
var markerContext = null;
function setMarkerContext(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("MARKERS_SET_CONTEXT: payload must be an object");
  }
  const { codes, codeToGroupIndex, groupCount, tested, reference } = payload;
  if (!(tested instanceof Uint8Array) || tested.length !== groupCount) {
    throw new TypeError("MARKERS_SET_CONTEXT: tested must be a Uint8Array of one flag per group");
  }
  if (!Number.isSafeInteger(reference) || reference < -1 || reference >= groupCount) {
    throw new RangeError("MARKERS_SET_CONTEXT: reference must be -1 or a group index");
  }
  if (!isCategoricalCodes(codes) || codes.length === 0) {
    throw new TypeError(
      "MARKERS_SET_CONTEXT: codes must be non-empty categorical codes"
    );
  }
  if (!(codeToGroupIndex instanceof Int32Array) || codeToGroupIndex.length === 0) {
    throw new TypeError(
      "MARKERS_SET_CONTEXT: codeToGroupIndex must be a non-empty Int32Array"
    );
  }
  if (!Number.isSafeInteger(groupCount) || groupCount <= 0) {
    throw new RangeError(
      "MARKERS_SET_CONTEXT: groupCount must be a positive integer"
    );
  }
  for (let i = 0; i < codeToGroupIndex.length; i++) {
    const groupIndex = codeToGroupIndex[i];
    if (groupIndex < -1 || groupIndex >= groupCount) {
      throw new RangeError(
        `MARKERS_SET_CONTEXT: code ${i} maps outside groupCount`
      );
    }
  }
  const nCells = codes.length;
  const cellGroupIndex = groupCount <= 32767 ? new Int16Array(nCells) : new Int32Array(nCells);
  cellGroupIndex.fill(-1);
  const missingCode = missingCategoryCode(codes);
  const mapLen = codeToGroupIndex.length;
  for (let i = 0; i < nCells; i++) {
    const code = codes[i];
    if (code !== missingCode && code < mapLen) {
      const gi = codeToGroupIndex[code];
      cellGroupIndex[i] = gi;
    }
  }
  markerContext = createGroupingContext(cellGroupIndex, groupCount, { tested, reference });
  return { ok: true, cells: nCells, groups: groupCount };
}
function computeMarkerGenes(payload) {
  if (!markerContext?.cellGroupIndex) {
    throw new Error("MARKERS_COMPUTE_GENES: marker context not set");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("MARKERS_COMPUTE_GENES: payload must be an object");
  }
  const {
    columns,
    method,
    minCells,
    pConvention,
    foldChange
  } = payload;
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new TypeError("MARKERS_COMPUTE_GENES: columns must be a non-empty array");
  }
  for (const values of columns) {
    if (!(values instanceof Float32Array) && !isGeneSample(values)) {
      throw new TypeError(
        "MARKERS_COMPUTE_GENES: each column must be a Float32Array or a sample {length, indices, values}"
      );
    }
    if (values.length !== markerContext.cellGroupIndex.length) {
      throw new RangeError(
        "MARKERS_COMPUTE_GENES: column length must exactly match marker context"
      );
    }
  }
  if (!TEST_METHODS.includes(method)) {
    throw new RangeError(
      `MARKERS_COMPUTE_GENES: method must be one of ${TEST_METHODS.join(", ")}`
    );
  }
  if (!P_CONVENTIONS.includes(pConvention)) {
    throw new RangeError(
      `MARKERS_COMPUTE_GENES: pConvention must be one of ${P_CONVENTIONS.join(", ")}`
    );
  }
  if (foldChange === null || typeof foldChange !== "object" || foldChange.mode !== "stored" && foldChange.mode !== "log1p") {
    throw new TypeError("MARKERS_COMPUTE_GENES: foldChange must name a mode, stored or log1p");
  }
  if (!Number.isSafeInteger(minCells) || minCells <= 0) {
    throw new RangeError(
      "MARKERS_COMPUTE_GENES: minCells must be a positive integer"
    );
  }
  const genes = columns.length;
  const { groupCount } = markerContext;
  const packed = {
    genes,
    groupCount,
    pValues: new Float64Array(genes * groupCount),
    scores: new Float32Array(genes * groupCount),
    auroc: new Float32Array(genes * groupCount),
    log2FoldChange: new Float32Array(genes * groupCount),
    meanInGroup: new Float32Array(genes * groupCount),
    meanOutGroup: new Float32Array(genes * groupCount),
    percentInGroup: new Float32Array(genes * groupCount),
    percentOutGroup: new Float32Array(genes * groupCount),
    nIn: new Uint32Array(genes * groupCount),
    nOut: new Uint32Array(genes * groupCount),
    nAll: new Uint32Array(genes),
    moments: new Float64Array(genes * 4)
  };
  const options = {
    method,
    minCells,
    pConvention,
    foldChange: { pseudocount: LOG2_FOLD_CHANGE_PSEUDOCOUNT, ...foldChange }
  };
  for (let gene = 0; gene < genes; gene++) {
    const result = groupMarkers(geneSampleOf(columns[gene], 0), markerContext, options);
    const at = gene * groupCount;
    packed.pValues.set(result.pValues, at);
    packed.scores.set(result.scores, at);
    packed.auroc.set(result.auroc, at);
    packed.log2FoldChange.set(result.log2FoldChange, at);
    packed.meanInGroup.set(result.meanInGroup, at);
    packed.meanOutGroup.set(result.meanOutGroup, at);
    packed.percentInGroup.set(result.percentInGroup, at);
    packed.percentOutGroup.set(result.percentOutGroup, at);
    packed.nIn.set(result.nIn, at);
    packed.nOut.set(result.nOut, at);
    packed.nAll[gene] = result.nAll;
    const { sum, sumSq, nonZero, n } = result.column;
    packed.moments.set([sum, sumSq, nonZero, n], gene * 4);
  }
  return packed;
}
var ucellContext = null;
function requireUcellContext(type) {
  if (ucellContext === null) throw new Error(`${type}: no UCell context is held`);
  return ucellContext;
}
function resultBuffers(result) {
  const buffers = [];
  const collect = (value, depth) => {
    if (ArrayBuffer.isView(value)) {
      if (value.buffer instanceof ArrayBuffer && !buffers.includes(value.buffer)) {
        buffers.push(value.buffer);
      }
      return;
    }
    if (depth === 0 || value === null || typeof value !== "object") return;
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      collect(item, depth - 1);
    }
  };
  collect(result, 3);
  return buffers;
}
function runTask(type, payload) {
  switch (type) {
    case "GENE_ROUTE_OPEN":
      return openGeneRoute(payload);
    case "GENE_ROUTE_CLOSE":
      return closeGeneRoute(payload);
    // Genes Panel (marker genes) specialized operations (stateful per worker)
    case "MARKERS_SET_CONTEXT":
      return setMarkerContext(payload);
    case "MARKERS_CLEAR_CONTEXT": {
      const released = markerContext !== null;
      markerContext = null;
      return { released };
    }
    case "MARKERS_COMPUTE_GENES":
      return computeMarkerGenes(payload);
    case "UCELL_SET_CONTEXT": {
      const { cellCount, setGeneCount, geneCount, sets, maxRank, slots = null, ranges = null, inline = null } = payload;
      const parts = [];
      if (ranges !== null) parts.push({ slots, ranges });
      if (inline !== null) parts.push(inline);
      ucellContext = createUcellContext({
        cellCount,
        setValues: ucellSetValues(cellCount, setGeneCount, parts),
        setGeneCount,
        geneCount,
        sets,
        maxRank
      });
      return { cells: ucellContext.cellCount };
    }
    case "UCELL_ADD_GENES":
      ucellAddGenes(requireUcellContext(type), payload.ranges);
      return { added: payload.ranges.pointers.length - 1 };
    case "UCELL_CLEAR": {
      const released = ucellContext !== null;
      ucellContext = null;
      return { released };
    }
    case "UCELL_FINISH": {
      const scores = ucellFinish(requireUcellContext(type));
      ucellContext = null;
      return { scores };
    }
    default:
      return executeOperation(type, payload);
  }
}
function answer(requestId, run) {
  let result;
  try {
    result = run();
  } catch (error) {
    self.postMessage({ requestId, success: false, error: error.message });
    return;
  }
  self.postMessage({ requestId, success: true, result }, resultBuffers(result));
}
self.onmessage = function(e) {
  const { type, payload, requestId } = e.data;
  if (type === "INIT") {
    if (payload === null || typeof payload !== "object" || !Number.isSafeInteger(payload.id) || payload.id < 0) {
      throw new TypeError("DataWorker INIT requires an exact non-negative id");
    }
    workerId = payload.id;
    self.postMessage({ type: "INIT_ACK", workerId });
    return;
  }
  if (payload !== null && typeof payload === "object" && payload.delivery !== void 0) {
    const { delivery, ...rest } = payload;
    takeDelivery(delivery).then(
      (delivered) => answer(requestId, () => delivered === null ? { lost: true } : runTask(type, { ...rest, ...delivered })),
      (error) => self.postMessage({ requestId, success: false, error: error.message })
    );
    return;
  }
  answer(requestId, () => runTask(type, payload));
};
self.onerror = function(error) {
  console.error("[DataWorker] Unhandled error:", error);
};
//# sourceMappingURL=data-worker.c53b1e33d7b6.js.map
