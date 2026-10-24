/**
 * @fileoverview The control genes of scanpy's module score
 * (`scanpy.tl.score_genes`).
 *
 * Every gene with a finite mean over all cells is binned by the rank of its
 * mean: `n_items = round(genes / (bins − 1))` (half to even, as numpy),
 * bin = `rank_min // n_items`. For each bin a set gene falls in,
 * `controlSize` genes are drawn from the bin (all of them when the bin holds
 * no more), and the set's own genes are removed from what was drawn — scanpy
 * 1.10's `ctrl_as_ref=True`. The union over bins is the control set.
 *
 * The draw uses mulberry32 seeded with `seed`, not numpy's generator, so a
 * draw from a bin larger than `controlSize` is not bit-identical to scanpy's;
 * with `controlSize` at least every bin's population the control set is the
 * same (the parity test uses that).
 *
 * @module stats/module-score
 */

/** mulberry32: a 32-bit seeded generator of floats in [0, 1). */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Round half to even, as numpy's `round`. */
export function roundHalfEven(value) {
  const floor = Math.floor(value);
  const difference = value - floor;
  if (difference > 0.5) return floor + 1;
  if (difference < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Each gene's expression bin, null for a gene without a finite mean.
 *
 * @param {number[]} means - Every gene's mean over all cells
 * @param {number} bins
 * @returns {(number|null)[]}
 */
export function expressionBins(means, bins) {
  const finite = [];
  for (let i = 0; i < means.length; i++) {
    if (Number.isFinite(means[i])) finite.push(i);
  }
  const nItems = Math.max(1, roundHalfEven(finite.length / (bins - 1)));
  const sorted = finite.map(i => means[i]).sort((a, b) => a - b);
  // rank 'min': one more than the count of strictly smaller means.
  const lowerBound = value => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return means.map(mean => (Number.isFinite(mean) ? Math.floor((lowerBound(mean) + 1) / nItems) : null));
}

/**
 * The control genes of one set.
 *
 * @param {object} options
 * @param {string[]} options.genes - Every gene of the dataset, in order
 * @param {number[]} options.means - Their means over all cells
 * @param {string[]} options.setGenes
 * @param {number} options.controlSize
 * @param {number} options.bins
 * @param {number} options.seed
 * @returns {string[]} In dataset order
 */
export function moduleScoreControls({ genes, means, setGenes, controlSize, bins, seed }) {
  const bin = expressionBins(means, bins);
  const position = new Map(genes.map((gene, index) => [gene, index]));
  const inSet = new Set(setGenes);
  const setBins = [...new Set(setGenes.map(gene => bin[position.get(gene)]).filter(value => value !== null))]
    .sort((a, b) => a - b);
  const random = mulberry32(seed);
  const chosen = new Set();
  for (const cut of setBins) {
    const members = [];
    for (let i = 0; i < genes.length; i++) if (bin[i] === cut) members.push(i);
    let drawn = members;
    if (controlSize < members.length) {
      // A partial Fisher–Yates shuffle: the first controlSize of a seeded
      // permutation.
      const pool = members.slice();
      for (let k = 0; k < controlSize; k++) {
        const j = k + Math.floor(random() * (pool.length - k));
        [pool[k], pool[j]] = [pool[j], pool[k]];
      }
      drawn = pool.slice(0, controlSize);
    }
    for (const index of drawn) {
      if (!inSet.has(genes[index])) chosen.add(index);
    }
  }
  return [...chosen].sort((a, b) => a - b).map(index => genes[index]);
}
