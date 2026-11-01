/**
 * @fileoverview Every gene's moments over every cell of the open dataset —
 * the mean and centred sum of squares of its finite values
 * (`gene-statistics.js` `columnMoments`: a constant gene's sum of squares is
 * exactly 0), its non-zero values, its finite values — kept for the load
 * they were read from.
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

/** @type {{generation: unknown, matrix: string, moments: Map<string, {mean: number, m2: number, nonZero: number, n: number}>}|null} */
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
      const { mean, m2, nonZero, n } = value;
      // A gene with no finite value has no mean (NaN).
      if (!Number.isSafeInteger(nonZero) || !Number.isSafeInteger(n) || (n > 0 && !(Number.isFinite(mean) && m2 >= 0))) {
        throw new TypeError(`Gene moments of "${gene}" must be counts, a finite mean and a non-negative sum of squares`);
      }
      moments.set(gene, { mean, m2, nonZero, n });
    },
    /** The genes of `genes` not kept yet. */
    missing: genes => genes.filter(gene => !moments.has(gene)),
    get size() {
      return moments.size;
    },
  };
}

/** Mean of a gene's finite values over every cell. */
export function momentsMean({ mean, n }) {
  return n > 0 ? mean : NaN;
}

/**
 * Standard deviation (ddof 1) of a gene's finite values over every cell:
 * exactly 0 for a constant gene, which then has no z-score.
 */
export function momentsStd({ m2, n }) {
  return n < 2 ? NaN : Math.sqrt(m2 / (n - 1));
}
