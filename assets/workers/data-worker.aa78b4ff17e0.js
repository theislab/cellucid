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
  GROUP_SUMMARY_CLEAR_CONTEXT: "GROUP_SUMMARY_CLEAR_CONTEXT",
  // --- a run's values: its cells' factors (task-values.js) ---
  SET_CELL_SCALE: "SET_CELL_SCALE",
  CLEAR_CELL_SCALE: "CLEAR_CELL_SCALE"
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
    description: "Per-group cells with a value, sum, cells above the expression cutoff and their sum, for a run of genes",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.GROUP_SUMMARY_CLEAR_CONTEXT]: {
    id: OperationType.GROUP_SUMMARY_CLEAR_CONTEXT,
    name: "Clear Group Summary Context",
    description: "Release the groups of a dot plot run",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.SET_CELL_SCALE]: {
    id: OperationType.SET_CELL_SCALE,
    name: "Set Cell Scale",
    description: "Hold a run's per-cell library-size factors, which its tasks that name them normalize their delivered genes by",
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.CLEAR_CELL_SCALE]: {
    id: OperationType.CLEAR_CELL_SCALE,
    name: "Clear Cell Scale",
    description: "Release a run's per-cell library-size factors",
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
function compensatedMean(values, pivot) {
  const n = values.length;
  if (n === 0) return NaN;
  let sum = 0;
  let compensation = 0;
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < n; i++) {
    const raw = values[i];
    const value = raw - pivot;
    const total = sum + value;
    compensation += Math.abs(sum) >= Math.abs(value) ? sum - total + value : value - total + sum;
    sum = total;
    if (raw < low) low = raw;
    if (raw > high) high = raw;
  }
  return low === high ? low - pivot + 0 : (sum + compensation) / n;
}
function centredMoments(values, pivot = 0) {
  const n = values.length;
  if (n === 0) return { n, mean: NaN, shifted: NaN, m2: NaN };
  const shifted = compensatedMean(values, pivot);
  let m2 = 0;
  for (let i = 0; i < n; i++) m2 += (values[i] - pivot - shifted) ** 2;
  return { n, mean: pivot + shifted, shifted, m2 };
}
function mean(arr) {
  if (!arr || arr.length === 0) return NaN;
  return compensatedMean(arr, 0);
}
function variance(arr, ddof = 0) {
  if (!arr || arr.length <= ddof) return NaN;
  return centredMoments(arr).m2 / (arr.length - ddof);
}
function std(arr, ddof = 0) {
  return Math.sqrt(variance(arr, ddof));
}
function sampleMoments(values, pivot = 0) {
  const n = values.length;
  if (n < 2) return { mean: n === 1 ? values[0] : NaN, shifted: n === 1 ? values[0] - pivot : NaN, variance: NaN, n };
  const moments = centredMoments(values, pivot);
  return { mean: moments.mean, shifted: moments.shifted, variance: moments.m2 / (n - 1), n };
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
      const count2 = counts[digit];
      counts[digit] = total;
      total += count2;
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
      const count2 = counts[base + digit];
      counts[base + digit] = total;
      total += count2;
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
      const positive2 = (high & SIGN_BIT) !== 0;
      selectScratchWords[LITTLE_ENDIAN ? 0 : 1] = positive2 ? low : ~low;
      selectScratchWords[LITTLE_ENDIAN ? 1 : 0] = positive2 ? high ^ SIGN_BIT : ~high;
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
      const count2 = counts[number];
      averageRank[number] = ranked + (count2 + 1) / 2;
      ranked += count2;
    }
    const ranks2 = new Float64Array(n);
    for (let i2 = 0; i2 < n; i2++) ranks2[i2] = averageRank[numbers[i2]];
    let tieTerm2 = 0;
    for (let number = 0; number < index.size; number++) {
      const count2 = counts[number];
      if (count2 > 1) tieTerm2 += count2 ** 3 - count2;
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
    const count2 = j - i;
    if (count2 > 1) {
      const term = count2 ** 3 - count2;
      tieTerm += term;
      if (term > Number.MAX_SAFE_INTEGER) orderIndependent = false;
      blockFirst.push(first);
      blockSize.push(count2);
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
    const count2 = blockSize[block];
    tieTerm += count2 ** 3 - count2;
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
  if (!(sxx > 0) || !(syy > 0)) return NaN;
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
function kernelDensityAt(support, weights, xs, bandwidth, count2) {
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
    density[i] = sum / (count2 * bandwidth);
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
  let count2 = 0;
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
        indices[count2] = j;
        out[count2++] = values[j];
      }
    }
    for (; i < length; i++) {
      if (bits[i] << 1 === 0) continue;
      indices[count2] = i;
      out[count2++] = values[i];
    }
  } else if (Array.isArray(values)) {
    for (let i = 0; i < length; i++) {
      const value = values[i];
      if (value === 0) continue;
      indices[count2] = i;
      out[count2++] = typeof value === "number" ? value : NaN;
    }
  } else {
    for (let i = 0; i < length; i++) {
      const value = values[i];
      if (value === 0) continue;
      indices[count2] = i;
      out[count2++] = value;
    }
  }
  return { length, indices: indices.subarray(0, count2), values: out.subarray(0, count2) };
}
function sampleOrderError(owner) {
  return new RangeError(`${owner}: sample indices must be strictly ascending and within its length`);
}
function describeSample(sample, owner) {
  const { length, indices, values } = sample;
  let nonFinite = 0;
  let nonZero = 0;
  let sum = 0;
  let compensation = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
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
    const total = sum + value;
    compensation += Math.abs(sum) >= Math.abs(value) ? sum - total + value : value - total + sum;
    sum = total;
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  const n = length - nonFinite;
  const zeros = n - nonZero;
  const constant = zeros === n || zeros === 0 && minimum === maximum;
  const mean3 = n === 0 ? NaN : constant ? zeros === n ? 0 : minimum : (sum + compensation) / n;
  if (zeros > 0 && minimum > 0) minimum = 0;
  return { n, zeros, nonZero, mean: mean3, constant, minimum };
}
function nonZeroValues(sample, count2) {
  const out = new Float64Array(count2);
  const values = sample.values;
  let k = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value !== 0 && Number.isFinite(value)) out[k++] = value;
  }
  return out;
}
function sampleSumOfSquares(sample, described) {
  return described.constant ? 0 : sumOfSquaresAbout(sample.values, described.zeros, described.mean);
}
function sumOfSquaresAbout(values, zeros, mean3) {
  let squares = 0;
  for (let k = 0; k < values.length; k++) {
    const value = values[k];
    if (value === 0 || !Number.isFinite(value)) continue;
    squares += (value - mean3) ** 2;
  }
  return squares + zeros * (mean3 * mean3);
}
function columnMoments(sample) {
  const described = describeSample(sample, "Gene column");
  return { mean: described.mean, m2: sampleSumOfSquares(sample, described), nonZero: described.nonZero, n: described.n };
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
  const meanA = a.mean;
  const meanB = b.mean;
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
    const test = welchComparison(meanA, sampleSumOfSquares(sampleA, a), nA, meanB, sampleSumOfSquares(sampleB, b), nB, method);
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
    const a = meanA * scale;
    const b = meanB * scale;
    const termA = Math.expm1(a) + LOG1P_FOLD_CHANGE_EPSILON;
    const termB = Math.expm1(b) + LOG1P_FOLD_CHANGE_EPSILON;
    const ratio = termA / termB;
    if (ratio > 0 && ratio < Infinity) return Math.log2(ratio);
    if (!(termA > 0) || !(termB > 0)) return NaN;
    return (logExpm1PlusEpsilon(a, termA) - logExpm1PlusEpsilon(b, termB)) / Math.LN2;
  }
  return log2FoldChangeOfMeans(meanA, meanB, minimum, foldChange.pseudocount);
}
function logExpm1PlusEpsilon(y, term) {
  if (term < Infinity) return Math.log(term);
  return y + Math.log1p((LOG1P_FOLD_CHANGE_EPSILON - 1) * Math.exp(-y));
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
  const compensationIn = new Float64Array(groupCount);
  const minimumIn = new Float64Array(groupCount).fill(Infinity);
  let nonZeroAll = 0;
  let minimumNonZero = Infinity;
  const valueIndex = wilcox ? context.valueIndex : null;
  valueIndex?.clear();
  let tabulated = wilcox;
  let counts = context.countsByValue;
  let previous = -1;
  for (let k = 0; k < indices.length; k++) {
    const cell = indices[k];
    if (cell <= previous || cell >= sample.length) throw sampleOrderError("Marker gene");
    previous = cell;
    const value = values[k];
    const group = cellGroupIndex[cell];
    if (group < 0) continue;
    if (!Number.isFinite(value)) {
      nonFinite[group]++;
      continue;
    }
    if (value === 0) continue;
    nonZero[group]++;
    nonZeroAll++;
    const running = sumIn[group];
    const total = running + value;
    compensationIn[group] += Math.abs(running) >= Math.abs(value) ? running - total + value : value - total + running;
    sumIn[group] = total;
    if (value < minimumNonZero) minimumNonZero = value;
    if (value < minimumIn[group]) minimumIn[group] = value;
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
  const minimumOf = (g) => zeros[g] > 0 ? Math.min(minimumIn[g], 0) : minimumIn[g];
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
    if (nIn[g] > 0) meanIn[g] = (sumIn[g] + compensationIn[g]) / nIn[g];
  }
  const rest = restMode ? restMoments(nIn, meanIn, null) : null;
  for (let g = 0; g < groupCount; g++) {
    const nA = nIn[g];
    const nB = nOut[g];
    if (nA > 0) {
      meanInGroup[g] = meanIn[g];
      percentInGroup[g] = nonZero[g] / nA * 100;
    }
    if (nB > 0) {
      meanOut[g] = restMode ? rest.mean[g] : meanIn[reference];
      meanOutGroup[g] = meanOut[g];
      percentOutGroup[g] = restMode ? (nonZeroAll - nonZero[g]) / nB * 100 : percentInGroup[reference];
    }
    if (nA > 0 && nB > 0) {
      const minimum = restMode ? minAll : Math.min(minimumOf(g), minimumOf(reference));
      log2FoldChange[g] = foldChangeOfMeans(meanIn[g], meanOut[g], minimum, foldChange);
    }
  }
  const result = {
    nAll,
    // The whole column's moments over every cell, grouped or not
    // (`shared/gene-moments-cache.js`), for the module score.
    column: columnMoments(sample),
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
    const m2In = new Float64Array(groupCount);
    for (let k = 0; k < indices.length; k++) {
      const group = cellGroupIndex[indices[k]];
      if (group < 0) continue;
      const value = values[k];
      if (value === 0 || !Number.isFinite(value)) continue;
      m2In[group] += (value - meanIn[group]) ** 2;
    }
    for (let g = 0; g < groupCount; g++) {
      if (nIn[g] > 0) m2In[g] += zeros[g] * meanIn[g] ** 2;
    }
    const restM2 = restMode ? restMoments(nIn, meanIn, m2In).m2 : null;
    for (let g = 0; g < groupCount; g++) {
      if (!testable(g)) continue;
      const m2Out = restMode ? restM2[g] : m2In[reference];
      const test = welchComparison(meanIn[g], m2In[g], nIn[g], meanOut[g], m2Out, nOut[g], method);
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
function restMoments(n, mean3, m2) {
  const groupCount = n.length;
  const withSquares = m2 !== null;
  const beforeN = new Float64Array(groupCount + 1);
  const beforeMean = new Float64Array(groupCount + 1);
  const beforeM2 = new Float64Array(groupCount + 1);
  const afterN = new Float64Array(groupCount + 1);
  const afterMean = new Float64Array(groupCount + 1);
  const afterM2 = new Float64Array(groupCount + 1);
  const merge = (nA, meanA, m2A, nB, meanB, m2B, into, at) => {
    if (nB === 0) {
      into[0][at] = nA;
      into[1][at] = meanA;
      into[2][at] = m2A;
      return;
    }
    if (nA === 0) {
      into[0][at] = nB;
      into[1][at] = meanB;
      into[2][at] = m2B;
      return;
    }
    const total = nA + nB;
    const delta = meanB - meanA;
    into[0][at] = total;
    into[1][at] = meanA + delta * (nB / total);
    into[2][at] = withSquares ? m2A + m2B + delta * delta * (nA * nB / total) : 0;
  };
  const before = [beforeN, beforeMean, beforeM2];
  const after = [afterN, afterMean, afterM2];
  for (let g = 0; g < groupCount; g++) {
    merge(beforeN[g], beforeMean[g], beforeM2[g], n[g], mean3[g], withSquares ? m2[g] : 0, before, g + 1);
  }
  for (let g = groupCount - 1; g >= 0; g--) {
    merge(n[g], mean3[g], withSquares ? m2[g] : 0, afterN[g + 1], afterMean[g + 1], afterM2[g + 1], after, g);
  }
  const restMean = new Float64Array(groupCount).fill(NaN);
  const restM2 = new Float64Array(groupCount).fill(NaN);
  const out = [new Float64Array(1), new Float64Array(1), new Float64Array(1)];
  for (let g = 0; g < groupCount; g++) {
    merge(beforeN[g], beforeMean[g], beforeM2[g], afterN[g + 1], afterMean[g + 1], afterM2[g + 1], out, 0);
    if (out[0][0] === 0) continue;
    restMean[g] = out[1][0];
    restM2[g] = out[2][0];
  }
  return { mean: restMean, m2: restM2 };
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
  let finite2 = values;
  if (finiteCount !== values.length) {
    finite2 = values instanceof Float32Array ? new Float32Array(finiteCount) : new Float64Array(finiteCount);
    let write = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (isFiniteNumber(v)) finite2[write++] = v;
    }
  }
  finiteNumbersByValues.set(values, finite2);
  if (finite2 !== values) finiteNumbersByValues.set(finite2, finite2);
  return finite2;
}
function finiteNumbersReport(values) {
  const finite2 = finiteNumbers(values);
  return { finiteCount: finite2.length, finite: finite2 === values ? null : finite2 };
}
function getFiniteMinMax(values) {
  let min = Infinity;
  let max = -Infinity;
  let count2 = 0;
  if (!values) return { min: NaN, max: NaN, count: 0 };
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isFiniteNumber(v)) continue;
    count2++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (count2 === 0) return { min: NaN, max: NaN, count: 0 };
  return { min, max, count: count2 };
}

// assets/js/app/analysis/stats/categorical-tests.js
var FISHER_RELATIVE_TOLERANCE = 1e-7;
function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return gammaLn(n + 1) - gammaLn(k + 1) - gammaLn(n - k + 1);
}
function fisherExact2x2(a, b, c, d) {
  for (const count2 of [a, b, c, d]) {
    if (!Number.isSafeInteger(count2) || count2 < 0) throw new RangeError("Fisher table counts must be whole numbers");
  }
  const oddsRatio = b * c > 0 ? a * d / (b * c) : a * d > 0 ? Infinity : NaN;
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const total = row1 + row2;
  if (total === 0) return { oddsRatio, pValue: 1 };
  const lowest = Math.max(0, col1 - row2);
  const highest = Math.min(row1, col1);
  const threshold = Math.log1p(FISHER_RELATIVE_TOLERANCE);
  let scaled = 1;
  let log = 0;
  for (let x = a; x < highest; x++) {
    log += Math.log((row1 - x) * (col1 - x)) - Math.log((x + 1) * (row2 - col1 + x + 1));
    if (log <= threshold) scaled += Math.exp(log);
  }
  log = 0;
  for (let x = a; x > lowest; x--) {
    log += Math.log(x * (row2 - col1 + x)) - Math.log((row1 - x + 1) * (col1 - x + 1));
    if (log <= threshold) scaled += Math.exp(log);
  }
  const observed = logChoose(row1, a) + logChoose(row2, c) - logChoose(total, col1);
  return { oddsRatio, pValue: Math.min(1, Math.exp(observed + Math.log(scaled))) };
}
function chiSquaredIndependence(table) {
  const rows = table.filter((row) => row.some((value) => value > 0));
  const columnCount = rows[0]?.length ?? 0;
  const keep = [];
  for (let column = 0; column < columnCount; column++) {
    if (rows.some((row) => row[column] > 0)) keep.push(column);
  }
  const observed = rows.map((row) => keep.map((column) => row[column]));
  const r = observed.length;
  const c = keep.length;
  const rowTotals = observed.map((row) => row.reduce((sum, value) => sum + value, 0));
  const columnTotals = keep.map((_, j) => observed.reduce((sum, row) => sum + row[j], 0));
  const total = rowTotals.reduce((sum, value) => sum + value, 0);
  if (r < 2 || c < 2) {
    return { statistic: NaN, pearson: NaN, corrected: false, df: 0, pValue: NaN, minExpected: NaN, rows: r, columns: c, total };
  }
  const df = (r - 1) * (c - 1);
  const corrected = df === 1;
  let statistic = 0;
  let pearson = 0;
  let minExpected = Infinity;
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      const expected = rowTotals[i] * columnTotals[j] / total;
      minExpected = Math.min(minExpected, expected);
      const difference = Math.abs(observed[i][j] - expected);
      pearson += difference * difference / expected;
      const yates = corrected ? Math.max(0, difference - 0.5) : difference;
      statistic += yates * yates / expected;
    }
  }
  return { statistic, pearson, corrected, df, pValue: chiSquaredPValue(statistic, df), minExpected, rows: r, columns: c, total };
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
  const rowTotals = observed.map((row) => row.reduce((sum, count2) => sum + count2, 0));
  const colTotals = categoryValues.map(
    (_, column) => observed.reduce((sum, row) => sum + row[column], 0)
  );
  const grandTotal = rowTotals.reduce((sum, count2) => sum + count2, 0);
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
function chiSquaredTestFromTable(table) {
  const { categoryValues, observed, grandTotal } = table;
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
  const test = chiSquaredIndependence(observed);
  if (test.minExpected < 5) {
    return invalidCategoricalResult(
      "Chi-squared test",
      "Pearson chi-squared inference is unavailable because an expected count is below 5; use an exact test or combine sparse categories"
    );
  }
  const { statistic: chiSq, df, pValue } = test;
  const testName = test.corrected ? "Chi-squared test (Yates's correction)" : "Chi-squared test";
  const k = Math.min(observed.length, categoryValues.length);
  const cramersV = k > 1 ? Math.sqrt(test.pearson / (grandTotal * (k - 1))) : 0;
  let effectInterpretation = "";
  if (cramersV < 0.1) effectInterpretation = "negligible";
  else if (cramersV < 0.2) effectInterpretation = "small";
  else if (cramersV < 0.4) effectInterpretation = "medium";
  else effectInterpretation = "large";
  const significance = getSignificance(pValue);
  return {
    testName,
    statistic: chiSq,
    pValue,
    significance,
    effectSize: cramersV,
    effectSizeType: "Cramér's V",
    df,
    interpretation: pValue < 0.05 ? `Significant difference in distributions (${effectInterpretation} effect)` : "No significant difference in distributions"
  };
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
  const { oddsRatio, pValue } = fisherExact2x2(a, b, c, d);
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
  return chiSquaredIndependence(observed).minExpected < 5;
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
  const pivot = values1[0];
  const momentsA = sampleMoments(values1, pivot);
  const momentsB = sampleMoments(values2, pivot);
  const m1 = momentsA.shifted;
  const m2 = momentsB.shifted;
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
  const pivot = validGroups[0][0];
  const groupMoments = validGroups.map((g) => centredMoments(g, pivot));
  const groupMeans = groupMoments.map((moments) => moments.shifted);
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
  let weighted = 0;
  for (let i = 0; i < validGroups.length; i++) weighted += groupSizes[i] * groupMeans[i];
  const grandMean = weighted / N;
  let SSB = 0;
  for (let i = 0; i < validGroups.length; i++) {
    SSB += groupSizes[i] * Math.pow(groupMeans[i] - grandMean, 2);
  }
  let SSW = 0;
  for (const moments of groupMoments) SSW += moments.m2;
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
  const count2 = sorted.length;
  const median = interp(sorted, 0.5);
  const q1 = interp(sorted, 0.25);
  const q3 = interp(sorted, 0.75);
  let sum = 0;
  for (let i = 0; i < count2; i++) sum = sum + sorted[i];
  const mean3 = sum / count2;
  let squares = 0;
  for (let i = 0; i < count2; i++) squares = squares + Math.pow(sorted[i] - mean3, 2);
  const sd = Math.sqrt(squares / count2);
  const sampleSd = Math.sqrt(squares / (count2 - 1 || count2));
  const lowerfence = Math.min(
    q1,
    sorted[Math.min(findBin(2.5 * q1 - 1.5 * q3, sorted, true) + 1, count2 - 1)]
  );
  const upperfence = Math.max(
    q3,
    sorted[Math.max(findBin(2.5 * q3 - 1.5 * q1, sorted), 0)]
  );
  const notchspan = 1.57 * (q3 - q1) / Math.sqrt(count2);
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
  let count2 = 0;
  const keep = (from, to) => {
    let run = 0;
    for (let i = from; i < to; i++) {
      run = i > from && sorted[i] === sorted[i - 1] ? run + 1 : 0;
      if (run < COINCIDENT_OUTLIER_COPIES) outliers[count2++] = sorted[i];
    }
  };
  keep(0, below);
  keep(above, sorted.length);
  return count2 === outliers.length ? outliers : outliers.slice(0, count2);
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
  const count2 = new Float64Array(DIRECT_BINS);
  const first = new Float64Array(DIRECT_BINS);
  const min = new Float64Array(DIRECT_BINS);
  const max = new Float64Array(DIRECT_BINS);
  const others = /* @__PURE__ */ new Map();
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const bin = Math.floor((value - start) / size + FIND_BIN_ROUNDING2);
    if (bin >= 0 && bin < DIRECT_BINS) {
      if (count2[bin] === 0) {
        first[bin] = value;
        min[bin] = value;
        max[bin] = value;
      } else {
        if (value < min[bin]) min[bin] = value;
        if (value > max[bin]) max[bin] = value;
      }
      count2[bin]++;
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
    if (count2[bin] > 0) emit(first[bin], min[bin], max[bin], count2[bin]);
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
  const finite2 = finiteNumbers(pageValues);
  const pageMean = finite2.length === 0 ? NaN : mean2(finite2);
  const plan = planDensity(finite2, bandwidthMult);
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
  return csvText(String(value));
}
function csvText(text) {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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
function geneNameColumns(genes, ids) {
  if (ids.length !== genes.length) throw new RangeError("Every gene of an analysis table needs its identifier");
  const symbols = ids.some((id, i) => String(id) !== String(genes[i]));
  return {
    header: symbols ? "names,symbols" : "names",
    cells: (index) => symbols ? `${toCSVCell(ids[index])},${toCSVCell(genes[index])}` : toCSVCell(ids[index])
  };
}
function markerStatisticsCSV(markers) {
  const { genes, ids, groups, scores, logfoldchanges, pvals, pvalsAdj, pctIn, pctRef, auroc } = markers;
  const writer = new CsvBlobWriter();
  const columns = geneNameColumns(genes, ids);
  writer.line(`group,${columns.header},scores,logfoldchanges,pvals,pvals_adj,pct_nz_group,pct_nz_reference,auroc,small_group,tested`);
  const names = genes.map((_, i) => columns.cells(i));
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

// assets/js/formats/io/byte-order.js
var HOST_LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

// assets/js/formats/zip/crc32.js
var TABLES = (() => {
  const tables = new Uint32Array(16 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    tables[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = tables[n];
    for (let t = 1; t < 16; t++) {
      c = tables[c & 255] ^ c >>> 8;
      tables[t * 256 + n] = c >>> 0;
    }
  }
  return tables;
})();

// assets/js/formats/io/read-witness.js
var WITNESS_BYTES = 64 * 1024;

// assets/js/utils/listener-set.js
function reportListenerFailure(name, error) {
  console.error(`[cellucid] A listener of ${name} failed:`, error);
}
function createListenerSet(name) {
  if (typeof name !== "string" || name.trim() === "") throw new TypeError("A listener set has a name.");
  const listeners = /* @__PURE__ */ new Map();
  function tell(isCurrent, args) {
    if (listeners.size === 0) return true;
    for (const [listener, subscription] of [...listeners]) {
      if (listeners.get(listener) !== subscription) continue;
      try {
        listener(...args);
      } catch (error) {
        reportListenerFailure(name, error);
      }
      if (isCurrent !== null && !isCurrent()) return false;
    }
    return true;
  }
  return Object.freeze({
    add(listener) {
      if (typeof listener !== "function") throw new TypeError(`A listener of ${name} is a function.`);
      let subscription = listeners.get(listener);
      if (subscription === void 0) {
        subscription = {};
        listeners.set(listener, subscription);
      }
      const own = subscription;
      return () => {
        if (listeners.get(listener) === own) listeners.delete(listener);
      };
    },
    delete(listener) {
      return listeners.delete(listener);
    },
    notify(...args) {
      tell(null, args);
    },
    notifyWhile(isCurrent, ...args) {
      if (typeof isCurrent !== "function") throw new TypeError(`What keeps a notice of ${name} current is a function.`);
      return tell(isCurrent, args) && isCurrent();
    },
    clear() {
      listeners.clear();
    },
    get size() {
      return listeners.size;
    }
  });
}

// assets/js/utils/abort.js
var CANCEL_KINDS = Object.freeze(["user", "superseded", "closed", "released", "page-left"]);
var KINDS = new Set(CANCEL_KINDS);
function cancelled(kind, words, cause = void 0) {
  if (!KINDS.has(kind)) throw new RangeError(`Unknown cancellation kind '${String(kind)}'.`);
  if (typeof words !== "string" || words.length === 0) throw new TypeError("A cancellation says what stopped.");
  const error = new DOMException(words, "AbortError");
  Object.defineProperty(error, "kind", { value: kind, enumerable: true, configurable: true });
  if (cause !== void 0) Object.defineProperty(error, "cause", { value: cause, configurable: true, writable: true });
  return error;
}
function isCancellation(error) {
  return error?.name === "AbortError";
}
function cancellationKind(error) {
  if (!isCancellation(error)) return null;
  return KINDS.has(error.kind) ? error.kind : "user";
}
function abortReason(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error || typeof reason?.name === "string" && typeof reason?.message === "string") return reason;
  return cancelled("user", "The work was canceled.", reason);
}
var SIGNAL_ABORTED = typeof AbortSignal === "function" ? Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get ?? null : null;
var registries = /* @__PURE__ */ new WeakMap();
var NOTHING = () => {
};
function onAbort(signal, callback) {
  if (signal === null || signal === void 0) return NOTHING;
  if (signal.aborted) {
    callback();
    return NOTHING;
  }
  let registry = registries.get(signal);
  if (registry === void 0) {
    const entries = /* @__PURE__ */ new Set();
    const fire = () => {
      if (registries.get(signal) === registry) registries.delete(signal);
      for (const entry2 of [...entries]) {
        try {
          entry2.callback();
        } catch (error) {
          reportListenerFailure("a signal aborting", error);
        }
      }
      entries.clear();
    };
    registry = { entries, fire };
    registries.set(signal, registry);
    signal.addEventListener("abort", fire, { once: true });
  }
  const entry = { callback };
  const owner = registry;
  owner.entries.add(entry);
  return () => {
    if (!owner.entries.delete(entry) || owner.entries.size > 0) return;
    if (registries.get(signal) === owner) registries.delete(signal);
    signal.removeEventListener("abort", owner.fire);
  };
}

// assets/js/utils/byte-text.js
var HEX = Array.from({ length: 256 }, (_unused, byte) => byte.toString(16).padStart(2, "0"));

// assets/js/utils/sha256.js
var ROUND_CONSTANTS = new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var INITIAL_STATE = new Uint32Array([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// assets/js/workers/worker-script.js
var THIS_MACHINE_HOSTS = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);
var THIS_MACHINE = new Set(THIS_MACHINE_HOSTS);
var failureListeners = createListenerSet("a worker's script failing");
var handed = /* @__PURE__ */ new Map();
var HANDED_MARK = "#handed=";
function handToWorkers(key, read) {
  if (typeof key !== "string" || key === "") throw new TypeError("What is handed to workers has a key.");
  if (typeof read !== "function") throw new TypeError("What is handed to workers is read when one starts: a function.");
  handed.set(key, read);
}
function handedByStarter(key, scope = globalThis) {
  const Scope = scope.DedicatedWorkerGlobalScope;
  if (typeof Scope !== "function" || !(scope instanceof Scope)) return void 0;
  const fragment = scope.location?.hash;
  if (typeof fragment !== "string" || !fragment.startsWith(HANDED_MARK)) return void 0;
  const record = JSON.parse(decodeURIComponent(fragment.slice(HANDED_MARK.length)));
  return Object.hasOwn(record, key) ? record[key] : void 0;
}

// assets/js/utils/machine.js
var finite = (value) => typeof value === "number" && Number.isFinite(value);
var positive = (value) => finite(value) && value > 0;
var notNegative = (value) => finite(value) && value >= 0;
var INDEX_PASS_KINDS = Object.freeze(["index", "view", "placeWhole", "placeOwn"]);
var MEASURES = Object.freeze({
  link: Object.freeze({
    holds: (value) => value !== null && typeof value === "object" && Object.keys(value).every((key) => key === "latencyMs" || key === "bytesPerMs") && notNegative(value.latencyMs) && positive(value.bytesPerMs),
    is: "{latencyMs, bytesPerMs}: a round trip of 0 or more milliseconds and a rate above 0 bytes a millisecond"
  }),
  decodeBytesPerMs: Object.freeze({ holds: positive, is: "a number of bytes a millisecond above 0" }),
  orderMadeMs: Object.freeze({ holds: notNegative, is: "0 or more milliseconds" }),
  keptReadBytesPerMs: Object.freeze({ holds: (value) => value === null || positive(value), is: "a number of bytes a millisecond above 0, or null" }),
  indexPassMs: Object.freeze({
    holds: (value) => value === null || typeof value === "object" && Object.keys(value).every((key) => INDEX_PASS_KINDS.includes(key) && positive(value[key])),
    is: `null, or milliseconds an entry above 0 under any of ${INDEX_PASS_KINDS.join(", ")}`
  }),
  shownCellMs: Object.freeze({ holds: (value) => value === null || notNegative(value), is: "0 or more milliseconds a cell, or null" }),
  cores: Object.freeze({ holds: (value) => Number.isInteger(value) && value >= 1, is: "a whole number of cores, 1 or more" })
});
var MACHINE_MEASURES = Object.freeze(Object.keys(MEASURES));
var HANDED_KEY = "machine";
function checked(measures) {
  if (measures === null || measures === void 0) return null;
  if (typeof measures !== "object" || Array.isArray(measures)) throw new TypeError("A held machine is an object of measures, or null.");
  const held = {};
  for (const [name, value] of Object.entries(measures)) {
    const measure = MEASURES[name];
    if (measure === void 0) throw new TypeError(`Unknown machine measure "${name}" (the measures: ${MACHINE_MEASURES.join(", ")}).`);
    if (!measure.holds(value)) throw new RangeError(`A held ${name} is ${measure.is} (got ${JSON.stringify(value) ?? String(value)}).`);
    held[name] = value !== null && typeof value === "object" ? Object.freeze({ ...value }) : value;
  }
  return Object.keys(held).length === 0 ? null : Object.freeze(held);
}
var holds = checked(handedByStarter(HANDED_KEY) ?? null);
handToWorkers(HANDED_KEY, () => holds ?? void 0);

// assets/js/formats/io/link.js
var READ_AHEAD_BYTES_PER_MS = 64 * 1e3;
var MIN_STALL_TIMEOUT_MS = 1e3;

// assets/js/utils/loopback.js
function bareHost(hostname) {
  return String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
}
function isSecureContextLoopbackHost(hostname) {
  const host = bareHost(hostname);
  return host === "localhost" || host.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(host) || host === "::1";
}
function isLoopbackHostname(hostname) {
  return isSecureContextLoopbackHost(hostname) || bareHost(hostname) === "0.0.0.0";
}
function isLoopbackUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHostname(url.hostname);
}

// assets/js/formats/io/hosts.js
var DELIVERY_TOLD_EVERY_MS = MIN_STALL_TIMEOUT_MS / 2;
var MAX_QUIET_MS = 6e4;
var PACE_WINDOW_MS = 6e4;
var RESET_RESOLUTION_MS = 1e3;
var EPOCH_SECONDS_FROM = 1e9;
var HostNotAnswering = class extends Error {
  /** @param {string} host */
  constructor(host) {
    super(`${host} gave no answer to the requests before this one; it was not sent.`);
    this.name = "HostNotAnswering";
    this.host = host;
  }
};
var HOSTS_CHANNEL = "cellucid-hosts";
function addressOf(url) {
  const at = String(url).indexOf("#");
  return at === -1 ? String(url) : String(url).slice(0, at);
}
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
function siteOf(origin) {
  const name = new URL(origin).hostname;
  if (/^[\d.]+$/.test(name) || name.includes(":")) return name;
  return name.split(".").slice(-2).join(".");
}
function count(value) {
  if (typeof value !== "string" || !/^\s*\d+\s*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
function structuredItems(value) {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value.split(",").map((item) => {
    const parameters = {};
    for (const match of item.matchAll(/;\s*([a-z][a-z0-9_-]*)\s*=\s*(\d+)/gi)) parameters[match[1].toLowerCase()] = Number(match[2]);
    return parameters;
  });
}
function budgetOf(headers, epochNow = Date.now()) {
  const get = (name) => headers?.get?.(name) ?? null;
  let limit = count(get("X-RateLimit-Limit")) ?? count(get("RateLimit-Limit"));
  let remaining = count(get("X-RateLimit-Remaining")) ?? count(get("RateLimit-Remaining"));
  let resetInMs = null;
  const legacyReset = count(get("X-RateLimit-Reset"));
  if (legacyReset !== null) {
    resetInMs = legacyReset >= EPOCH_SECONDS_FROM ? Math.max(0, legacyReset * 1e3 - epochNow) : legacyReset * 1e3;
  } else {
    const reset = count(get("RateLimit-Reset"));
    if (reset !== null) resetInMs = reset * 1e3;
  }
  if (remaining === null) {
    const items = structuredItems(get("RateLimit")).filter((item) => Number.isSafeInteger(item.r));
    if (items.length > 0) {
      const tightest = items.reduce((left, right) => right.r < left.r ? right : left);
      remaining = tightest.r;
      if (Number.isSafeInteger(tightest.t)) resetInMs = tightest.t * 1e3;
      const policies = structuredItems(get("RateLimit-Policy")).filter((item) => Number.isSafeInteger(item.q));
      if (limit === null && policies.length > 0) limit = Math.min(...policies.map((item) => item.q));
    }
  }
  if (limit === null && remaining === null && resetInMs === null) return null;
  return { limit, remaining, resetInMs };
}
function createHostBook({
  now = () => performance.now(),
  after = (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
  epoch = () => Date.now(),
  channel = null,
  online = () => globalThis.navigator?.onLine !== false
} = {}) {
  const hosts = /* @__PURE__ */ new Map();
  const lostAt = /* @__PURE__ */ new Map();
  let answeredAt = -Infinity;
  const paceWatchers = createListenerSet("a host's pace");
  function hostOf(origin) {
    let host = hosts.get(origin);
    if (host === void 0) {
      host = {
        origin,
        answeredMs: null,
        deliveries: 0,
        toldAt: -Infinity,
        limit: null,
        remaining: null,
        resetAt: null,
        windowAsked: false,
        holdUntil: -Infinity,
        // The window a budget is counted over, as far as it is known (the
        // longest reset stated with a window's whole count), and whether a
        // request has waited for the budget (`requestCostMs`).
        windowMs: null,
        bound: false,
        // What each address of the host lost (`lose`), by address: an
        // address it answers again is forgotten.
        losses: /* @__PURE__ */ new Map(),
        inFlight: 0,
        cap: Infinity,
        capCeiling: Infinity,
        queue: [],
        wake: null,
        wakeAt: Infinity,
        // When each recent request was sent (the latest `PACE_WINDOW_MS`),
        // the least time between two requests the host was found to bear
        // (`learnPace`; 0: none known), and when the last one was sent.
        sentAt: [],
        answeredAt: [],
        paceMs: 0,
        lastSentAt: -Infinity,
        // The quickest answer it gave (from its request sent to the answer):
        // no answer of it comes sooner, so a request lost sooner than half of
        // it never reached it (`lostOnThisSide`).
        fastestAnswerMs: Infinity
      };
      hosts.set(origin, host);
    }
    return host;
  }
  function tell(message) {
    if (channel === null) return;
    try {
      channel.postMessage(message);
    } catch {
    }
  }
  function nextFree(host) {
    const at = now();
    if (at < host.holdUntil) return host.holdUntil;
    if (host.paceMs > 0 && at < host.lastSentAt + host.paceMs) return host.lastSentAt + host.paceMs;
    if (host.resetAt !== null && at >= host.resetAt) {
      host.remaining = host.limit === null ? null : 1;
      host.windowAsked = host.limit !== null;
      host.resetAt = null;
    }
    if (host.inFlight >= Math.floor(host.cap)) return Infinity;
    if (host.remaining !== null && host.remaining - host.inFlight <= 0) {
      if (host.inFlight > 0) return Infinity;
      if (host.resetAt !== null) return host.resetAt;
    }
    return at;
  }
  function pump(host) {
    host.wake?.();
    host.wake = null;
    host.wakeAt = Infinity;
    while (host.queue.length > 0) {
      const free = nextFree(host);
      if (free > now()) {
        if (Number.isFinite(free)) {
          host.wakeAt = free;
          host.wake = after(free - now(), () => {
            host.wake = null;
            pump(host);
          });
        }
        for (const waiter2 of host.queue) waiter2.waiting(free);
        if (host.remaining !== null && host.remaining - host.inFlight <= 0) host.bound = true;
        return;
      }
      const waiter = host.queue.shift();
      waiter.admitted();
    }
  }
  function learnBudget(host, said, { limiting = false, waitMs = null } = {}) {
    const at = now();
    if (host.windowAsked && (said === null || said.remaining === null)) {
      host.windowAsked = false;
      host.remaining = host.limit;
    }
    if (said !== null) {
      if (said.limit !== null) host.limit = said.limit;
      if (said.remaining !== null) {
        const resetAt = said.resetInMs === null ? null : at + said.resetInMs;
        const sameWindow = !host.windowAsked && host.remaining !== null && (resetAt === null || host.resetAt === null || resetAt <= host.resetAt + RESET_RESOLUTION_MS);
        host.windowAsked = false;
        if (sameWindow) {
          host.remaining = Math.min(host.remaining, said.remaining);
          if (resetAt !== null) host.resetAt = host.resetAt === null ? resetAt : Math.max(host.resetAt, resetAt);
        } else {
          host.remaining = said.remaining;
          host.resetAt = resetAt;
          if (said.resetInMs !== null && said.resetInMs > 0) host.windowMs = Math.max(host.windowMs ?? 0, said.resetInMs);
        }
      }
    }
    if (waitMs !== null && waitMs > 0) host.holdUntil = Math.max(host.holdUntil, at + waitMs);
    if (limiting && said?.remaining === 0 && said.resetInMs !== null && said.resetInMs < RESET_RESOLUTION_MS) {
      host.holdUntil = Math.max(host.holdUntil, at + RESET_RESOLUTION_MS);
    }
    if (limiting) slowDown(host);
  }
  function lossesOf(host, address) {
    let loss = host.losses.get(address);
    if (loss === void 0) {
      loss = { streak: 0, round: 0, quietUntil: -Infinity };
      host.losses.set(address, loss);
    }
    return loss;
  }
  function lose(host, address, onThisSide = false) {
    const loss = lossesOf(host, address);
    loss.thisSide = loss.streak === 0 ? onThisSide : loss.thisSide || onThisSide;
    const offline = !online();
    loss.offline = loss.streak === 0 ? offline : loss.offline && offline;
    loss.round++;
    loss.streak++;
    if (loss.streak < 2) return;
    loss.quietUntil = now() + Math.min(MAX_QUIET_MS, MIN_STALL_TIMEOUT_MS * 2 ** (loss.streak - 2));
    if (loss.streak === 2 && host.deliveries > 0 && !loss.thisSide) learnPace(host);
    const refused = host.queue.filter((waiter) => waiter.address === address);
    host.queue = host.queue.filter((waiter) => waiter.address !== address);
    for (const waiter of refused) waiter.refused();
  }
  function lostOnThisSide(host, elapsedMs) {
    if (!online()) return true;
    return elapsedMs !== null && Number.isFinite(host.fastestAnswerMs) && elapsedMs < host.fastestAnswerMs / 2;
  }
  function sent(host) {
    const at = now();
    host.inFlight++;
    host.lastSentAt = at;
    host.sentAt.push(at);
    let old = 0;
    while (old < host.sentAt.length && host.sentAt[old] < at - PACE_WINDOW_MS) old++;
    if (old > 0) host.sentAt.splice(0, old);
  }
  function learnPace(host) {
    if (isLoopbackUrl(host.origin)) return;
    const at = now();
    const recent = host.sentAt.filter((time) => time >= at - PACE_WINDOW_MS).length;
    const answered = host.answeredAt.filter((time) => time >= at - PACE_WINDOW_MS).length;
    if (recent < 2 || answered * 2 <= recent) return;
    const refusedMs = PACE_WINDOW_MS / recent;
    const paceMs = Math.max(2 * refusedMs, host.paceMs > 0 ? 2 * host.paceMs : 0);
    setPace(host, paceMs, true);
  }
  function setPace(host, paceMs, tellOthers) {
    if (!(paceMs > host.paceMs) || !Number.isFinite(paceMs)) return;
    host.paceMs = paceMs;
    if (tellOthers) tell({ pace: { origin: host.origin, paceMs } });
    paceWatchers.notify(host.origin, paceMs);
    pump(host);
  }
  function slowDown(host) {
    host.capCeiling = Math.max(1, host.inFlight + 1);
    host.cap = Math.max(1, Math.floor((host.inFlight + 1) / 2));
  }
  function tellBudget(host) {
    const at = now();
    const wall = epoch();
    tell({
      budget: {
        origin: host.origin,
        limit: host.limit,
        remaining: host.remaining,
        resetEpoch: host.resetAt === null ? null : wall + (host.resetAt - at),
        holdEpoch: host.holdUntil > at ? wall + (host.holdUntil - at) : null
      }
    });
  }
  if (channel !== null) {
    channel.onmessage = (event) => {
      const message = event?.data ?? {};
      const origin = message.delivered ?? message.budget?.origin ?? message.pace?.origin ?? null;
      if (typeof origin !== "string") return;
      const host = hostOf(origin);
      if (typeof message.delivered === "string") {
        host.deliveries++;
        return;
      }
      if (message.pace !== void 0) {
        setPace(host, Number(message.pace.paceMs), false);
        return;
      }
      const { limit, remaining, resetEpoch, holdEpoch } = message.budget;
      const wall = epoch();
      learnBudget(host, {
        limit: Number.isSafeInteger(limit) ? limit : null,
        remaining: Number.isSafeInteger(remaining) ? remaining : null,
        resetInMs: Number.isFinite(resetEpoch) ? Math.max(0, resetEpoch - wall) : null
      }, { waitMs: Number.isFinite(holdEpoch) ? holdEpoch - wall : null });
      pump(host);
    };
  }
  return Object.freeze({
    /** Remember that the host of `url` answered a request in `waitedMs`. */
    rememberAnswer(url, waitedMs) {
      const origin = originOf(url);
      if (origin === null || !(waitedMs >= 0)) return;
      hostOf(origin).answeredMs = waitedMs;
    },
    /** How long the host of `url` last took to answer here, or null. */
    rememberedAnswer(url) {
      const origin = originOf(url);
      return origin === null ? null : hosts.get(origin)?.answeredMs ?? null;
    },
    /** Something arrived from the host of `url` (an answer, or a piece of a body). */
    delivered(url) {
      const origin = originOf(url);
      if (origin === null) return;
      const host = hostOf(origin);
      host.deliveries++;
      host.deliveredUrl = String(url);
      const at = now();
      if (at - host.toldAt >= DELIVERY_TOLD_EVERY_MS) {
        host.toldAt = at;
        tell({ delivered: origin });
      }
    },
    /**
     * Whether the host of `url` answered this site so a page could read it
     * (a delivery of any realm of this site): a request to it that gets no
     * such answer now is not refused for CORS.
     */
    answeredBefore(url) {
      const origin = originOf(url);
      return origin !== null && (hosts.get(origin)?.deliveries ?? 0) > 0;
    },
    /**
     * The address of the host of `url` that last delivered to this realm, or
     * null: asked again, it tells a host that still serves this site (and
     * lets it read some of its files, not `url`) from one refusing it.
     */
    deliveredAddress(url) {
      const origin = originOf(url);
      return origin === null ? null : hosts.get(origin)?.deliveredUrl ?? null;
    },
    /**
     * Whether the connection on this side, not the host of `url`, is the
     * likely reason it gave no answer: at least two unrelated sites
     * (`siteOf`) that had answered this site before (so neither CORS nor a
     * mistyped name is why) lost a request within one maximum
     * retransmission timeout (`MAX_QUIET_MS`, RFC 6298 2.5: a request not
     * answered within it is lost by TCP's own measure), and no host has
     * answered since the earliest of those losses. One host's outage leaves
     * the others answering; a dropped connection silences every host at once.
     */
    connectionDown(url) {
      if (originOf(url) === null) return false;
      const at = now();
      const recent = [...lostAt.values()].filter((when) => at - when <= MAX_QUIET_MS);
      return recent.length >= 2 && answeredAt < Math.min(...recent);
    },
    /** Whether this computer says it is online (`navigator.onLine`; the book's `online`). */
    online() {
      return online();
    },
    /** How many deliveries of the host of `url` this realm knows of: a watch compares two counts. */
    deliveries(url) {
      const origin = originOf(url);
      return origin === null ? 0 : hosts.get(origin)?.deliveries ?? 0;
    },
    /**
     * Wait until the host of `url` may be sent one more request
     * (`signal` ends the wait), then count it as on its way. Answers what to
     * call once it is answered -- at once when the host may be asked now
     * (nothing waits, so a request goes out in the task that asked for it),
     * else a promise of it: `answered(response, {limiting,
     * waitMs, lost})` with the answer (null: none came), `limiting` when it
     * refused the request for the host's limit, `waitMs` the wait it named
     * for the whole host, `lost` when no answer a page may read came (not
     * a request canceled or ended as stalled). `onWait(info)` hears when the request waits
     * (`{host, untilMs}`, `untilMs` from now, null: until an answer) and
     * `onWait(null)` when it no longer does.
     *
     * `waits` false: a request whose answer is optional (GitHub's commit of a
     * file, without which it is read at its branch) is not held for the
     * budget: null when the host may not be asked now.
     *
     * `burst`: one of many requests to its address, sent without a person
     * asking each: `true`, a file's range reads, whose address is the URL;
     * a URL, the address the request is one of (a store folder's root, for
     * each of its objects). Its losses are counted by address, and while
     * the address is left unasked it fails unsent (`HostNotAnswering`). A
     * provider's request (a record, a file's details) is asked as the
     * person asked (`withRetries`: twice).
     *
     * @param {string} url
     * @param {{signal?: AbortSignal|null, onWait?: ((info: {host: string, untilMs: number|null, limit: number|null}|null) => void)|null,
     *   waits?: boolean, burst?: boolean|string}} [options]
     * @returns {Answered|Promise<Answered>|null} `Answered`: `(response: Response|null,
     *   options?: {limiting?: boolean, waitMs?: number|null}) => void`
     */
    admit(url, { signal = null, onWait = null, waits = true, burst = false } = {}) {
      const origin = originOf(url);
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      if (origin === null) return () => {
      };
      const host = hostOf(origin);
      const address = addressOf(typeof burst === "string" ? burst : url);
      let round = null;
      let sentMs = null;
      let probe = false;
      const answered = (response, { limiting = false, waitMs = null, lost = false } = {}) => {
        host.inFlight = Math.max(0, host.inFlight - 1);
        const elapsedMs = sentMs === null ? null : now() - sentMs;
        if (probe) {
          const loss2 = host.losses.get(address);
          if (loss2 !== void 0) loss2.probing = false;
        }
        if (response === null && lost) {
          if (burst && round === (host.losses.get(address)?.round ?? 0)) lose(host, address, lostOnThisSide(host, elapsedMs));
          if (host.deliveries > 0) lostAt.set(siteOf(origin), now());
        } else if (response !== null) {
          answeredAt = now();
          lostAt.delete(siteOf(origin));
          host.losses.delete(address);
          if (elapsedMs !== null) host.fastestAnswerMs = Math.min(host.fastestAnswerMs, elapsedMs);
          const at = now();
          host.answeredAt.push(at);
          let old = 0;
          while (old < host.answeredAt.length && host.answeredAt[old] < at - PACE_WINDOW_MS) old++;
          if (old > 0) host.answeredAt.splice(0, old);
        }
        const said = response === null ? null : budgetOf(response.headers, epoch());
        if (response !== null && !limiting && host.cap !== Infinity) {
          host.cap += 1 / host.cap;
          if (host.cap >= host.capCeiling) {
            host.cap = Infinity;
            host.capCeiling = Infinity;
          }
        }
        learnBudget(host, said, { limiting, waitMs });
        if (said !== null || limiting || (waitMs ?? 0) > 0) tellBudget(host);
        pump(host);
      };
      const loss = burst ? host.losses.get(address) : void 0;
      if (loss !== void 0 && loss.offline && online() && loss.quietUntil > now()) {
        loss.quietUntil = -Infinity;
        loss.probing = false;
      }
      if (loss !== void 0 && (now() < (loss.quietUntil ?? -Infinity) || loss.streak >= 2 && loss.probing === true)) {
        return waits ? Promise.reject(new HostNotAnswering(new URL(origin).host)) : null;
      }
      if (loss !== void 0 && loss.streak >= 2) {
        loss.probing = true;
        probe = true;
      }
      const free = nextFree(host);
      if (host.queue.length === 0 && free <= now()) {
        sent(host);
        sentMs = now();
        round = host.losses.get(address)?.round ?? 0;
        return answered;
      }
      if (!waits) return null;
      return new Promise((resolve, reject) => {
        let told = false;
        const waiter = {
          admitted: () => {
            stopWaiting();
            if (told) onWait?.(null);
            sent(host);
            sentMs = now();
            round = host.losses.get(address)?.round ?? 0;
            resolve(answered);
          },
          address: burst ? address : null,
          refused: () => {
            stopWaiting();
            if (told) onWait?.(null);
            reject(new HostNotAnswering(new URL(origin).host));
          },
          waiting: (untilAt) => {
            if (told) return;
            told = true;
            onWait?.({ host: new URL(origin).host, untilMs: Number.isFinite(untilAt) ? Math.max(0, untilAt - now()) : null, limit: host.limit });
          }
        };
        host.queue.push(waiter);
        const stopWaiting = onAbort(signal, () => {
          const at = host.queue.indexOf(waiter);
          if (at >= 0) host.queue.splice(at, 1);
          if (told) onWait?.(null);
          reject(abortReason(signal));
        });
        pump(host);
      });
    },
    /**
     * What one more request to the host of `url` costs in time, as its
     * request budget prices it: 0 while the host has stated no budget (or
     * no window). Otherwise the budget's interval, its window over its limit
     * (Zenodo: 60 s / 133, 0.45 s; the window learned from the longest reset
     * stated whole), in the share of this window already spent: a request
     * is nearly free while most of the window remains, so early reads stay
     * exact, and costs the whole interval once nothing remains for what is
     * asked, or once a request has waited for the budget. Readers price a
     * request at no less (`link.js` `requestCostMs`, which `requestMs` and the
     * byte reader's `planMergeGap` read): as the budget runs down
     * they read through larger gaps, so an opening fits the window in fewer,
     * larger requests instead of waiting for the next one.
     */
    requestCostMs(url) {
      const origin = originOf(url);
      const host = origin === null ? void 0 : hosts.get(origin);
      if (host === void 0) return 0;
      if (!(host.limit > 0) || !(host.windowMs > 0)) return host.paceMs;
      const interval = host.windowMs / host.limit;
      const left = host.remaining === null ? host.limit : host.remaining - host.inFlight - host.queue.length;
      if (host.bound || left <= 0) return Math.max(interval, host.paceMs);
      return Math.max(host.paceMs, interval * Math.min(1, Math.max(0, 1 - left / host.limit)));
    },
    /** The least time between two requests to the host of `url` it was found to bear (0: none known). */
    pace(url) {
      const origin = originOf(url);
      return origin === null ? 0 : hosts.get(origin)?.paceMs ?? 0;
    },
    /**
     * Start the host of `url` (a URL or an origin) at a pace kept from an
     * earlier visit (`data/host-link-memory.js`): its requests are spaced
     * at least `paceMs` apart. Never makes a known pace faster.
     */
    seedPace(url, paceMs) {
      const origin = originOf(url);
      if (origin === null || !(paceMs > 0)) return;
      setPace(hostOf(origin), paceMs, false);
    },
    /** Hear every host's pace as it is learned or told (`(origin, paceMs) => void`); returns what stops it. */
    watchPace(listener) {
      return paceWatchers.add(listener);
    },
    /**
     * How long the host of `url` is held now (milliseconds; 0 when it may be
     * asked): a wait it named, or, with nothing of its budget left and
     * nothing on its way, its reset.
     */
    heldForMs(url) {
      const origin = originOf(url);
      const host = origin === null ? void 0 : hosts.get(origin);
      if (host === void 0) return 0;
      const at = now();
      let until = host.holdUntil;
      if (host.remaining !== null && host.remaining - host.inFlight <= 0 && host.inFlight === 0 && host.resetAt !== null) {
        until = Math.max(until, host.resetAt);
      }
      return Math.max(0, until - at);
    },
    /** What this realm knows of the host of `url`'s budget (tests, the Transfers log). */
    budget(url) {
      const origin = originOf(url);
      const host = origin === null ? void 0 : hosts.get(origin);
      if (host === void 0) return null;
      const at = now();
      return {
        limit: host.limit,
        remaining: host.remaining,
        resetInMs: host.resetAt === null ? null : Math.max(0, host.resetAt - at),
        heldForMs: Math.max(0, host.holdUntil - at),
        inFlight: host.inFlight,
        cap: host.cap,
        waiting: host.queue.length
      };
    }
  });
}
function realmChannel() {
  if (typeof BroadcastChannel !== "function") return null;
  try {
    const channel = new BroadcastChannel(HOSTS_CHANNEL);
    channel.unref?.();
    return channel;
  } catch {
    return null;
  }
}
var realmHosts = createHostBook({ channel: realmChannel() });

// assets/js/formats/io/page-checks.js
var CHECK_PAGE_BYTES = 16 * 1024;

// assets/js/formats/io/byte-source.js
var BYTE_SOURCE_FAILURES = Object.freeze({
  NETWORK: "network",
  STALLED: "stalled",
  RANGE_IGNORED: "range-ignored",
  RATE_LIMITED: "rate-limited",
  UNAVAILABLE: "unavailable",
  HTTP: "http",
  SHORT_READ: "short-read",
  CHANGED: "changed",
  UNREADABLE: "unreadable",
  SIZE_UNKNOWN: "size-unknown",
  /** A copy kept in this browser whose bytes do not match their checksums (`page-checks.js`). */
  DAMAGED: "damaged"
});
var KiB = 1024;
var MiB = 1024 * KiB;
var REMOTE_POLICY = Object.freeze({
  blockBytes: 16 * KiB,
  mergeGapBytes: 64 * KiB,
  maxRequestBytes: 8 * MiB,
  concurrency: 6,
  streams: 100,
  cacheBytes: 64 * MiB,
  // Nothing is assumed of a web host: it is read ahead only once measured.
  bytesPerMs: 0
});
var LOCAL_POLICY = Object.freeze({
  blockBytes: 64 * KiB,
  mergeGapBytes: 4 * KiB,
  maxRequestBytes: 32 * MiB,
  concurrency: 4,
  cacheBytes: 32 * MiB,
  // A disk (1 GB/s), read ahead from the start.
  bytesPerMs: 1e6
});
var HEAD_BYTES = 512 * KiB;
var HOST_FAULTS = Object.freeze(["failing", "limiting", "refusing", "silent", "refused", "missing", "offline", "connection"]);
var TRANSIENT_FAILURES = /* @__PURE__ */ new Set([
  BYTE_SOURCE_FAILURES.NETWORK,
  BYTE_SOURCE_FAILURES.STALLED,
  BYTE_SOURCE_FAILURES.RATE_LIMITED,
  BYTE_SOURCE_FAILURES.UNAVAILABLE
]);

// assets/js/data/memory-budget.js
var GIB = 1024 ** 3;
var DEVICE_MEMORY_TOP_BUCKET_GIB = 8;
var HEAP_TO_PHYSICAL_RATIO = 4;
var UNREPORTED_DEVICE_BYTES = DEVICE_MEMORY_TOP_BUCKET_GIB * GIB;
var ALLOWANCE_OF_DEVICE = 1 / 2;
var RESIDENCY_SHARES = Object.freeze({
  /**
   * A gene-column index held in memory before it spills to disk (8 bytes per
   * stored entry), with the row pointers of the cell-major matrices it is
   * built from (8 bytes a stored row).
   */
  columnIndex: 3 / 8,
  /** Decoded embedding positions of layouts no view shows. */
  positions: 1 / 8,
  /** Loaded but unused field arrays kept for fast re-selection. */
  inactiveFields: 1 / 8,
  /**
   * An analysis run's memory: the genes it buffers (marker discovery,
   * differential expression, dot plots), the per-cell context each analysis
   * worker keeps for it (its groups), and the marker results kept for the
   * next look.
   */
  analysis: 1 / 16,
  /**
   * The values analysis windows read for their pages, kept for the next read
   * (`app/analysis/data/data-layer.js`), with the page cell lists made for
   * them (unions of groups, "rest of" pages, first-pass samples).
   */
  analysisPages: 1 / 16,
  /**
   * The AnnData adapter's cached copies: normalized coordinates, obs field
   * payloads not handed to a view, and the neighbor graph read last while
   * no view shows its edges.
   */
  adapterCache: 1 / 16,
  /** A latent space the reader worker holds for outlier quantiles. */
  latentHold: 1 / 16,
  /**
   * Decoded chunks of the open store, every cache of them together (`formats/io/decoded-budget.js`):
   * the store's own (dense strips shared by their genes, chunks read in part) and the whole chunks a
   * subsample is read through (`anndata/decoded-chunks.js`), every open store together.
   */
  decodedBlocks: 1 / 32,
  /**
   * Bytes of remote files kept for the reader workers: the page's byte-range cache (`byte-range-cache.js`), whichever
   * worker fetched them, and each worker's own held reads (`heldReaderBytes`, registered by `anndata-reader-worker.js`).
   */
  fetchedRanges: 1 / 32,
  /** Decode workers while they decompress chunks (`formats/io/decode-pool.js`). */
  decodeWorkers: 1 / 32,
  /** Earlier selection steps a highlight tool can undo to (every tool together). */
  undoHistory: 1 / 32
});
var RELEASE_ORDER = Object.freeze([
  "decodedBlocks",
  "fetchedRanges",
  "decodeWorkers",
  "adapterCache",
  "inactiveFields",
  "analysisPages",
  "analysis",
  "positions",
  "latentHold",
  "columnIndex",
  "undoHistory"
]);
var RELEASE_LEVELS = Object.freeze({
  caches: Object.freeze(RELEASE_ORDER.filter((name) => name !== "columnIndex" && name !== "undoHistory")),
  all: Object.freeze(RELEASE_ORDER.filter((name) => name !== "undoHistory"))
});
if (RELEASE_ORDER.length !== Object.keys(RESIDENCY_SHARES).length || !RELEASE_ORDER.every((name) => Object.hasOwn(RESIDENCY_SHARES, name))) {
  throw new Error("Every residency share has one place in the release order.");
}
function requireShare(name) {
  if (!Object.hasOwn(RESIDENCY_SHARES, name)) throw new TypeError(`Unknown residency budget '${String(name)}'`);
  return name;
}
var handed2 = null;
var allowanceScale = 1;
var refusedBytes = 0;
var otherInstances = { count: 0, heldBytes: 0 };
var workingSet = /* @__PURE__ */ new Map();
var openCells = 0;
function estimatedDeviceMemory(environment = globalThis) {
  if (handed2 !== null && environment === globalThis) return { bytes: handed2.deviceBytes, source: handed2.deviceSource };
  const deviceMemory = environment?.navigator?.deviceMemory;
  const reported = typeof deviceMemory === "number" && Number.isFinite(deviceMemory) && deviceMemory > 0 ? Math.floor(deviceMemory * GIB) : null;
  const heapLimit = environment?.performance?.memory?.jsHeapSizeLimit;
  const fromHeap = typeof heapLimit === "number" && Number.isFinite(heapLimit) && heapLimit > 0 ? Math.floor(heapLimit * HEAP_TO_PHYSICAL_RATIO) : null;
  if (reported !== null && (reported < DEVICE_MEMORY_TOP_BUCKET_GIB * GIB || fromHeap === null || fromHeap <= reported)) {
    return { bytes: reported, source: "deviceMemory" };
  }
  if (fromHeap !== null) return { bytes: fromHeap, source: "jsHeapSizeLimit" };
  return { bytes: UNREPORTED_DEVICE_BYTES, source: "unreported" };
}
function currentScale() {
  return handed2 === null ? allowanceScale : handed2.scale;
}
function currentOthers() {
  return handed2 === null ? otherInstances : handed2.otherInstances;
}
function memoryAllowanceBytes(environment = globalThis) {
  const device = estimatedDeviceMemory(environment).bytes * ALLOWANCE_OF_DEVICE * currentScale();
  const others = currentOthers();
  const shared = others.count === 0 ? device : Math.max(device / (others.count + 1), device - others.heldBytes);
  return Math.floor(shared);
}
function workingSetBytes() {
  if (handed2 !== null) return handed2.workingSetBytes;
  let total = 0;
  for (const bytes of workingSet.values()) total += bytes;
  return total;
}
function cacheRoomBytes({ workingSetBytes: drawn = workingSetBytes(), environment = globalThis } = {}) {
  return Math.max(0, memoryAllowanceBytes(environment) - drawn);
}
function residencyBudgetBytes(name, environment = globalThis, { workingSetBytes: drawn = workingSetBytes() } = {}) {
  requireShare(name);
  return Math.floor(cacheRoomBytes({ workingSetBytes: drawn, environment }) * RESIDENCY_SHARES[name]);
}
var holders = /* @__PURE__ */ new Set();
var workerHeld = /* @__PURE__ */ new Map();
function holderBytes(entry) {
  const bytes = entry.bytes();
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}
function localHeld(share) {
  let total = 0;
  for (const entry of holders) if (entry.share === share) total += holderBytes(entry);
  return total;
}
function heldByShare() {
  const shares = {};
  for (const name of RELEASE_ORDER) shares[name] = localHeld(name);
  for (const report2 of workerHeld.values()) {
    for (const [name, bytes] of Object.entries(report2)) if (Object.hasOwn(shares, name)) shares[name] += bytes;
  }
  return shares;
}
function heldBytes() {
  let total = 0;
  for (const bytes of Object.values(heldByShare())) total += bytes;
  return total;
}
function wordsOf(result) {
  if (typeof result === "string") return result.length > 0 ? [result] : [];
  if (Array.isArray(result)) return result.filter((item) => typeof item === "string" && item.length > 0);
  return [];
}
function trimShare(share, budget, released) {
  const entries = [...holders].filter((entry) => entry.share === share);
  let held = entries.reduce((sum, entry) => sum + holderBytes(entry), 0);
  if (held <= budget) return;
  for (const entry of entries) {
    if (held <= budget) break;
    const own = holderBytes(entry);
    released.push(...wordsOf(entry.trim(Math.max(0, budget - (held - own)))));
    held += holderBytes(entry) - own;
  }
}
function settleMemory(reason = "settle") {
  const released = [];
  for (const share of RELEASE_ORDER) trimShare(share, residencyBudgetBytes(share), released);
  announceRelease(reason, released);
  return released;
}
function recordAllocationFailure(bytes, environment = globalThis) {
  if (!(bytes > 0) || bytes >= memoryAllowanceBytes(environment)) return false;
  if (handed2 !== null) {
    handed2 = Object.freeze({ ...handed2, scale: handed2.scale / 2, refusedBytes: bytes });
    report({ refused: bytes });
    settleMemory("refused");
    return true;
  }
  allowanceScale /= 2;
  refusedBytes = bytes;
  stateChanged("refused");
  return true;
}
function recordAllocationSuccess(bytes) {
  const refused = handed2 === null ? refusedBytes : handed2.refusedBytes;
  if (refused === 0 || !(bytes >= refused)) return;
  if (handed2 !== null) {
    report({ granted: bytes });
    return;
  }
  if (workingSetBytes() + heldBytes() + bytes < memoryAllowanceBytes()) return;
  raiseAllowance("granted");
}
function raiseAllowance(reason) {
  allowanceScale = Math.min(1, allowanceScale * 2);
  if (allowanceScale === 1) refusedBytes = 0;
  stateChanged(reason);
}
var changeListeners = createListenerSet("the memory budgets");
var releaseListeners = createListenerSet("memory released");
function announceRelease(reason, released) {
  if (released.length === 0) return;
  if (handed2 !== null) report({ released, reason });
  releaseListeners.notify({ reason, released: [...released] });
}
function stateChanged(reason) {
  settleMemory(reason);
  const state = memoryState();
  for (const connection of connections) connection.post({ memoryState: state, reason });
  changeListeners.notify(reason);
  noteMemoryChanged();
}
function memoryState() {
  const device = estimatedDeviceMemory();
  return Object.freeze({
    deviceBytes: device.bytes,
    deviceSource: device.source,
    scale: allowanceScale,
    refusedBytes,
    otherInstances,
    workingSetBytes: workingSetBytes(),
    openCells
  });
}
var connections = /* @__PURE__ */ new Set();
var reporter = null;
var reportScheduled = false;
function report(extra) {
  if (reporter === null) return;
  if (extra !== void 0) {
    reporter({ event: "memory", held: localHeldByShare(), ...extra });
    return;
  }
  reporter({ event: "memory", held: localHeldByShare() });
}
function localHeldByShare() {
  const shares = {};
  for (const name of RELEASE_ORDER) {
    const bytes = localHeld(name);
    if (bytes > 0) shares[name] = bytes;
  }
  return shares;
}
var heldListeners = createListenerSet("the memory this page holds");
function noteMemoryChanged() {
  if (reportScheduled) return;
  reportScheduled = true;
  setTimeout(() => {
    reportScheduled = false;
    if (reporter !== null) report();
    else if (heldListeners.size > 0) heldListeners.notify(workingSetBytes() + heldBytes());
  }, 0);
}

// assets/js/utils/large-arrays.js
var MEMORY_PAGE_BYTES = 65536;
var MEMORY_MAX_BYTES = 2 ** 32;
var ARRAY_PIECE_BYTES = 2 ** 24 * 3 * 4;
var TYPED_ARRAYS = Object.freeze({
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array
});
var memoryBuffers = /* @__PURE__ */ new WeakSet();
function allocateInMemory(ArrayType, length) {
  const bytes = length * ArrayType.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`A typed array holds a non-negative whole number of elements, not ${length}.`);
  }
  if (bytes > MEMORY_MAX_BYTES) {
    throw new RangeError(
      `${formatCountOf(bytes, "byte")} is more than one WebAssembly memory holds (${formatCountOf(MEMORY_MAX_BYTES, "byte")}), the largest array a browser page can allocate.`
    );
  }
  const pages = Math.ceil(bytes / MEMORY_PAGE_BYTES);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
  memoryBuffers.add(memory.buffer);
  return new ArrayType(memory.buffer, 0, length);
}
function allocateLargeArray(ArrayType, length) {
  try {
    return new ArrayType(length);
  } catch (refused) {
    if (!(refused instanceof RangeError) || typeof WebAssembly?.Memory !== "function" || !(length * ArrayType.BYTES_PER_ELEMENT <= MEMORY_MAX_BYTES)) throw refused;
    try {
      return allocateInMemory(ArrayType, length);
    } catch {
      throw refused;
    }
  }
}

// assets/js/formats/store.js
var INTEGER_NAMES = Object.freeze({
  int: Object.freeze({ 1: "int8", 2: "int16", 4: "int32", 8: "int64" }),
  uint: Object.freeze({ 1: "uint8", 2: "uint16", 4: "uint32", 8: "uint64" })
});
var FLOAT_NAMES = Object.freeze({ 2: "float16", 4: "float32", 8: "float64" });
var INTEGER_ARRAYS = Object.freeze({
  int: Object.freeze({ 1: Int8Array, 2: Int16Array, 4: Int32Array, 8: BigInt64Array }),
  uint: Object.freeze({ 1: Uint8Array, 2: Uint16Array, 4: Uint32Array, 8: BigUint64Array })
});
var BOOL_DTYPE = Object.freeze({ kind: "bool", name: "bool", bytes: 1, littleEndian: null });

// assets/js/data/anndata/elements.js
var H5AD_FORMAT = Object.freeze({ storage: "HDF5", file: "H5AD" });
var ZARR_FORMAT = Object.freeze({ storage: "Zarr", file: "AnnData Zarr" });
var ANNDATA_OPENING_PATHS = Object.freeze([
  Object.freeze({ path: "", depth: 2 }),
  Object.freeze({ path: "X", depth: Infinity }),
  Object.freeze({ path: "layers", depth: Infinity }),
  Object.freeze({ path: "raw", depth: 2 }),
  Object.freeze({ path: "raw/X", depth: Infinity }),
  Object.freeze({ path: "uns/cellucid", depth: Infinity })
]);
var NULLABLE_ENCODINGS = Object.freeze(/* @__PURE__ */ new Set([
  "nullable-integer",
  "nullable-boolean",
  "nullable-string-array"
]));

// assets/js/data/sparse-column-index.js
var SEGMENT_ELEMENTS = 2 ** 27;
function allocateTypedArray(ArrayType, length, label) {
  let array;
  try {
    array = allocateLargeArray(ArrayType, length);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const bytes = length * ArrayType.BYTES_PER_ELEMENT;
    recordAllocationFailure(bytes);
    const failure = new RangeError(
      `${label} needs ${formatCountOf(bytes, "byte")}, more memory than the browser could allocate.`
    );
    failure.code = "TOO_LARGE";
    failure.bytes = bytes;
    throw failure;
  }
  recordAllocationSuccess(length * ArrayType.BYTES_PER_ELEMENT);
  return array;
}
var PRIOR_COSTS = Object.freeze({
  mergeGapBytes: REMOTE_POLICY.mergeGapBytes,
  roundTripBytes: null,
  shapingConcurrency: REMOTE_POLICY.concurrency
});
var WHOLE_VALUES_STEP = 1 << 20;
var DISK_GROUP_BUFFER_ENTRIES = 1 << 18;
var DISK_BUFFER_BUDGET_ENTRIES = 1 << 24;
var KEPT_PIECE_BYTES = 16 * 1024 * 1024;
var KEPT_TYPES = Object.freeze({ f64: Float64Array, u32: Uint32Array, f32: Float32Array });
var KEPT_READ_GAP_BYTES = 1 << 20;

// assets/js/data/expression-transform.js
var RAW_VALUES = Object.freeze({ normalize: false, log1p: false });
var TRANSFORM_KEYS = Object.freeze(["log1p", "normalize"]);
function transformValue(value, factor, log1p) {
  if (value === 0 || !Number.isFinite(value)) return value;
  const scaled = factor === null ? value : value * factor;
  return Math.fround(log1p ? Math.log1p(scaled) : scaled);
}
function requireFactors(factors, length, what) {
  if (factors === null) return;
  if (!(factors instanceof Float32Array)) throw new TypeError("Cell factors are a Float32Array of one factor a position");
  if (length > factors.length) {
    throw new RangeError(`A transformed ${what} has ${formatCountOf(length, "position")}; the factors cover ${factors.length}`);
  }
}
function isEntries(column) {
  return column !== null && typeof column === "object" && !ArrayBuffer.isView(column) && !Array.isArray(column) && Number.isSafeInteger(column.length) && column.indices instanceof Uint32Array && ArrayBuffer.isView(column.values);
}
function transformColumn(column, factors, log1p) {
  if (isEntries(column)) {
    requireFactors(factors, column.length, "gene");
    const { indices, values } = column;
    const out2 = allocateTypedArray(Float32Array, values.length, "A transformed gene");
    for (let k = 0; k < values.length; k++) out2[k] = transformValue(values[k], factors === null ? null : factors[indices[k]], log1p);
    return { length: column.length, indices, values: out2 };
  }
  if (!ArrayBuffer.isView(column) && !Array.isArray(column)) {
    throw new TypeError("A transformed gene is a numeric array or its entries {length, indices, values}");
  }
  requireFactors(factors, column.length, "gene");
  const out = allocateTypedArray(Float32Array, column.length, "A transformed gene");
  for (let p = 0; p < column.length; p++) out[p] = transformValue(column[p], factors === null ? null : factors[p], log1p);
  return out;
}
function transformBlock(block, factors, log1p) {
  const positions = block.positions ?? block.cellIndex;
  const { values } = block;
  const out = allocateTypedArray(Float32Array, values.length, "A transformed gene");
  for (let k = 0; k < values.length; k++) {
    const position = positions[k];
    if (factors !== null && position >= factors.length) {
      throw new RangeError(`A transformed block names position ${position}; the factors cover ${factors.length}`);
    }
    out[k] = transformValue(values[k], factors === null ? null : factors[position], log1p);
  }
  return { ...block, values: out };
}

// assets/js/app/analysis/compute/task-values.js
var heldScales = /* @__PURE__ */ new Map();
function requireScaleId(scaleId) {
  if (typeof scaleId !== "string" || scaleId.length === 0) {
    throw new TypeError("A cell scale id must be a non-empty string");
  }
  return scaleId;
}
function setCellScale(payload) {
  const scaleId = requireScaleId(payload?.scaleId);
  if (!(payload.scale instanceof Float32Array)) throw new TypeError("A cell scale is a Float32Array of one factor a position");
  heldScales.set(scaleId, payload.scale);
  return { positions: payload.scale.length };
}
function clearCellScale(payload) {
  return { released: heldScales.delete(requireScaleId(payload?.scaleId)) };
}
function transformedTask(payload) {
  if (payload === null || typeof payload !== "object" || payload.transform === void 0) return payload;
  const { transform, ...rest } = payload;
  if (transform === null) return rest;
  if (typeof transform !== "object" || typeof transform.log1p !== "boolean" || transform.scale !== null && typeof transform.scale !== "string") {
    throw new TypeError("A task's transform is {scale: string|null, log1p: boolean}");
  }
  let factors = null;
  if (transform.scale !== null) {
    factors = heldScales.get(requireScaleId(transform.scale)) ?? null;
    if (factors === null) throw new Error(`Cell scale "${transform.scale}" is not held`);
  }
  if (Array.isArray(rest.columns)) return { ...rest, columns: rest.columns.map((column) => transformColumn(column, factors, transform.log1p)) };
  if (rest.block !== void 0 && rest.block !== null) return { ...rest, block: transformBlock(rest.block, factors, transform.log1p) };
  throw new TypeError("A transformed task carries its genes as columns or a block");
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
  let count2 = 0;
  for (let t = span[0]; t < span[1] + step / 2; t += step) count2++;
  return { sorted, bandwidth, count: count2, start: span[0], step, end: span[1] };
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
  const measured = new Uint32Array(geneCount * groupCount);
  const nonZero = new Uint32Array(groupCount);
  const missing = new Uint32Array(groupCount);
  const zeroExpressed = 0 > cutoff;
  const range = new Float64Array(bins > 0 ? geneCount * 2 : 0);
  const histogram = new Uint32Array(bins > 0 ? geneCount * groupCount * bins : 0);
  for (let gene = 0; gene < geneCount; gene++) {
    const sample = geneSampleOf(genes[gene], 0);
    if (sample.length !== cellGroup.length) {
      throw new RangeError(`Group summary gene ${gene} has ${formatCountOf(sample.length, "cell")}, not ${cellGroup.length}`);
    }
    const base = gene * groupCount;
    nonZero.fill(0);
    missing.fill(0);
    const { indices, values } = sample;
    for (let entry = 0; entry < indices.length; entry++) {
      const group = cellGroup[indices[entry]];
      if (group < 0) continue;
      const value = values[entry];
      if (value === 0) continue;
      if (!Number.isFinite(value)) {
        missing[group] += 1;
        continue;
      }
      nonZero[group] += 1;
      sum[base + group] += value;
      if (value > cutoff) {
        expressing[base + group] += 1;
        sumExpressing[base + group] += value;
      }
    }
    let measuredCells = 0;
    for (let group = 0; group < groupCount; group++) {
      measured[base + group] = sizes[group] - missing[group];
      measuredCells += measured[base + group];
      if (zeroExpressed) expressing[base + group] += measured[base + group] - nonZero[group];
    }
    if (bins > 0) binGene(gene, measuredCells);
  }
  function binGene(gene, measuredCells) {
    const sample = geneSampleOf(genes[gene], 0);
    const { indices, values } = sample;
    let stored = 0;
    let low = Infinity;
    let high = -Infinity;
    for (let entry = 0; entry < indices.length; entry++) {
      if (cellGroup[indices[entry]] < 0) continue;
      const value = values[entry];
      if (value === 0 || !Number.isFinite(value)) continue;
      stored += 1;
      if (value < low) low = value;
      if (value > high) high = value;
    }
    if (stored < measuredCells) {
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
      if (value === 0 || !Number.isFinite(value)) continue;
      counted[group] += 1;
      histogram[(base + group) * bins + binOf(value)] += 1;
    }
    for (let group = 0; group < groupCount; group++) {
      histogram[(base + group) * bins + zeroBin] += measured[base + group] - counted[group];
    }
  }
  return {
    sum,
    expressing,
    sumExpressing,
    measured,
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
  const constant = !(moments.sxx > 0) && !(moments.syy > 0) ? "both" : !(moments.sxx > 0) ? "x" : !(moments.syy > 0) ? "y" : null;
  if (constant !== null) {
    return { r: NaN, rSquared: NaN, pValue: NaN, n, method, slope, intercept, constant };
  }
  let r;
  if (method === "spearman") {
    if (n === len) {
      r = pearsonCorrelation(computeRanks(xValues), computeRanks(yValues));
    } else {
      const xValid = new Float64Array(n);
      const yValid = new Float64Array(n);
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
  const { support, weights, xs, bandwidth, count: count2 } = payload;
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
  if (!Number.isSafeInteger(count2) || count2 <= 0) {
    throw new RangeError("Kernel density count must be a positive safe integer");
  }
  return { density: kernelDensityAt(support, weights, xs, bandwidth, count2) };
}
function computeBoxStatistics(payload) {
  const { values, points } = payload;
  if (!(values instanceof Float32Array) && !(values instanceof Float64Array)) {
    throw new TypeError("Box statistics values must be a Float32Array or Float64Array");
  }
  if (points !== "outliers" && points !== "all") {
    throw new RangeError('Box statistics points must be "outliers" or "all"');
  }
  const report2 = finiteNumbersReport(values);
  if (report2.finiteCount === 0) return { summary: null, ...report2 };
  return { summary: plotlyBoxSummary(finiteNumbers(values), points), ...report2 };
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
  const finite2 = finiteNumbers(values);
  if (finite2.length === 0) {
    return { bandwidth: 0, count: 0, t: new Float64Array(0), v: new Float64Array(0), empty: true };
  }
  const plan = plotlyViolinPlan(finite2);
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
function geneMomentsOf(column, readCells = null) {
  const sample = geneSampleOf(column, 0);
  if (readCells === null || readCells >= sample.length) return columnMoments(sample);
  const indices = sample.indices;
  let count2 = indices.length;
  while (count2 > 0 && indices[count2 - 1] >= readCells) count2--;
  return columnMoments({ length: readCells, indices: indices.subarray(0, count2), values: sample.values.subarray(0, count2) });
}
function computeGeneMoments(payload) {
  const { columns, readCells = null } = payload;
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new TypeError("Gene moment columns must be a non-empty array");
  }
  if (readCells !== null && !(Number.isSafeInteger(readCells) && readCells >= 0)) {
    throw new TypeError("Gene moments read cells must be a count of open cells or null");
  }
  const moments = new Float64Array(columns.length * 4);
  columns.forEach((column, gene) => {
    const { mean: mean3, m2, nonZero, n } = geneMomentsOf(column, readCells);
    moments.set([mean3, m2, nonZero, n], gene * 4);
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
    case OperationType.SET_CELL_SCALE:
      return setCellScale(payload);
    case OperationType.CLEAR_CELL_SCALE:
      return clearCellScale(payload);
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
  const rankCap = Math.min(maxRank, geneCount);
  for (const members of sets) {
    if (!(rankCap > (members.length + 1) / 2)) {
      throw new RangeError(`UCell's max rank (${rankCap}) must exceed half of one more than a set's ${formatCountOf(members.length, "gene")}`);
    }
  }
  const sorted = new Float32Array(cellCount * S);
  const slotOf = new Uint16Array(cellCount * S);
  const order = new Array(S);
  for (let c = 0; c < cellCount; c++) {
    const base = c * S;
    for (let s = 0; s < S; s++) order[s] = s;
    order.sort((x, y) => {
      const vx = setValues[base + x];
      const vy = setValues[base + y];
      const missingX = vx !== vx;
      const missingY = vy !== vy;
      if (missingX || missingY) return missingX - missingY || x - y;
      return vx - vy || x - y;
    });
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
    maxRank: rankCap,
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
        const rank = greater[k] + (equal[k] + 1) / 2;
        rankSum += rank >= maxRank ? maxRank : rank;
      }
      const size = members.length;
      const fewest = size * (size + 1) / 2;
      scores[c * sets.length + set] = missing ? NaN : 1 - (rankSum - fewest) / (size * maxRank - fewest);
    }
  }
  return scores;
}

// assets/js/utils/errors.js
var REPORTED = /* @__PURE__ */ Symbol.for("cellucid.failureReported");
function isReported(error) {
  return error !== null && typeof error === "object" && error[REPORTED] === true;
}

// assets/js/utils/error-wire.js
var KEPT = ["code", "key", "reason", "bytes", "details", "columns", "feature", "offset", "status", "url"];
function toWire(error, seen = /* @__PURE__ */ new Set()) {
  if (error === null || typeof error !== "object" || typeof error.message !== "string") {
    return { name: "Error", message: String(error) };
  }
  const record = { name: typeof error.name === "string" ? error.name : "Error", message: error.message };
  seen.add(error);
  const kind = cancellationKind(error);
  if (kind !== null) record.kind = kind;
  if (isReported(error)) record.reported = true;
  if (typeof error.source === "string") record.sourceType = error.source;
  for (const key of KEPT) {
    if (key === "code" && typeof DOMException === "function" && error instanceof DOMException) continue;
    if (error[key] === void 0) continue;
    try {
      record[key] = structuredClone(error[key]);
    } catch {
      record[key] = String(error[key]);
    }
  }
  if (error.cause !== void 0 && !seen.has(error.cause)) record.cause = toWire(error.cause, seen);
  if (Array.isArray(error.errors)) record.errors = error.errors.filter((item) => !seen.has(item)).map((item) => toWire(item, seen));
  return record;
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
    const { mean: mean3, m2, nonZero, n } = result.column;
    packed.moments.set([mean3, m2, nonZero, n], gene * 4);
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
function runTask(type, task) {
  const payload = transformedTask(task);
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
    self.postMessage({ requestId, success: false, error: toWire(error) });
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
      (error) => self.postMessage({ requestId, success: false, error: toWire(error) })
    );
    return;
  }
  answer(requestId, () => runTask(type, payload));
};
self.onerror = function(error) {
  console.error("[DataWorker] Unhandled error:", error);
};
//# sourceMappingURL=data-worker.aa78b4ff17e0.js.map
