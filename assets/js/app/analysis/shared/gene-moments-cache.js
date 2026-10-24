/**
 * @fileoverview Every gene's moments over every cell of the open dataset —
 * the sum and sum of squares of its finite values, its non-zero values, its
 * finite values — kept for the load they were read from.
 *
 * The module score (scanpy `score_genes`) bins every gene by its mean over
 * all cells. Any run that reads every gene once fills these for free: a
 * marker run computes them in the same pass (`groupMarkers` reports the
 * whole column's moments); otherwise the score reads the genes it lacks once
 * (`COMPUTE_GENE_MOMENTS`). Four numbers a gene (32 bytes; 1 MB at 30,000
 * genes) is far inside the analysis budget, so nothing is evicted; a new
 * load (another dataset generation) starts empty. Nothing is saved in a
 * session.
 *
 * @module analysis/shared/gene-moments-cache
 */

/** @type {{generation: unknown, matrix: string, moments: Map<string, {sum: number, sumSq: number, nonZero: number, n: number}>}|null} */
let current = null;

function ownerOf(generation, matrix) {
  if (current === null || current.generation !== generation || current.matrix !== matrix) {
    current = { generation, matrix, moments: new Map() };
  }
  return current.moments;
}

/**
 * The moments kept for a load and matrix.
 *
 * @param {unknown} generation - The data layer's dataset generation
 * @param {string} [matrix='mapped'] - The expression matrix they are of
 */
export function geneMomentsFor(generation, matrix = 'mapped') {
  const moments = ownerOf(generation, matrix);
  return {
    get: gene => moments.get(gene) ?? null,
    set(gene, value) {
      const { sum, sumSq, nonZero, n } = value;
      if (![sum, sumSq].every(Number.isFinite) || !Number.isSafeInteger(nonZero) || !Number.isSafeInteger(n)) {
        throw new TypeError(`Gene moments of "${gene}" must be finite counts and sums`);
      }
      moments.set(gene, { sum, sumSq, nonZero, n });
    },
    /** The genes of `genes` not kept yet. */
    missing: genes => genes.filter(gene => !moments.has(gene)),
    get size() {
      return moments.size;
    },
  };
}

/** Mean of a gene's finite values over every cell. */
export function momentsMean({ sum, n }) {
  return n > 0 ? sum / n : NaN;
}

/** Standard deviation (ddof 1) of a gene's finite values over every cell. */
export function momentsStd({ sum, sumSq, n }) {
  if (n < 2) return NaN;
  const mean = sum / n;
  const m2 = Math.max(0, sumSq - n * mean * mean);
  return Math.sqrt(m2 / (n - 1));
}
