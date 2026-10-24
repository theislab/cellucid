/**
 * @fileoverview Which markers a group shows: the genes passing the filters,
 * ranked, the top N. Applied to the full statistics of a run
 * (`MarkerStatistics`), so changing a filter, the ranking or N never tests
 * again.
 *
 * - **Direction**: Up keeps genes scored above zero (higher in the group than
 *   its reference), Down below zero, Both either.
 * - **Filters**: adjusted p ≤ max, |log2FC| ≥ min, % of the group's cells
 *   non-zero ≥ min, % of the reference's ≤ max. An untested gene never
 *   passes.
 * - **Ranking**: by score (scanpy's order), adjusted p, log2FC, AUROC or
 *   %in − %ref, in the direction's sense (Up: largest first; Down: most
 *   negative first; Both: largest magnitude first; adjusted p: smallest
 *   first); ties by gene order in the dataset.
 *
 * @module genes-panel/marker-selection
 */

export const RANK_KEYS = Object.freeze(['score', 'padj', 'log2fc', 'auroc', 'pct_diff']);
export const DIRECTIONS = Object.freeze(['up', 'down', 'both']);

/**
 * The display options of the marker options record.
 *
 * @typedef {Object} MarkerDisplay
 * @property {'up'|'down'|'both'} direction
 * @property {number} maxAdjP
 * @property {number} minLog2FC
 * @property {number} minPctIn
 * @property {number} maxPctRef
 * @property {'score'|'padj'|'log2fc'|'auroc'|'pct_diff'} rankBy
 * @property {number} topN
 */

function rankValue(rankBy, stats, g, i) {
  switch (rankBy) {
    case 'score': return stats.scoresByGroup[g][i];
    case 'padj': return stats.adjustedPValuesByGroup[g][i];
    case 'log2fc': return stats.log2FoldChangeByGroup[g][i];
    case 'auroc': return stats.aurocByGroup[g][i] - 0.5;
    case 'pct_diff': return stats.pctInByGroup[g][i] - stats.pctRefByGroup[g][i];
    default: throw new RangeError(`Unknown marker ranking ${rankBy}`);
  }
}

/**
 * The genes of group `g` passing the filters, ranked.
 *
 * @param {Object} stats - MarkerStatistics
 * @param {number} g - Group index
 * @param {MarkerDisplay} display
 * @returns {Uint32Array} Gene indices, best first
 */
export function rankGroupGenes(stats, g, display) {
  const { direction, maxAdjP, minLog2FC, minPctIn, maxPctRef, rankBy } = display;
  if (!DIRECTIONS.includes(direction)) throw new RangeError(`Unknown marker direction ${direction}`);
  if (!RANK_KEYS.includes(rankBy)) throw new RangeError(`Unknown marker ranking ${rankBy}`);
  const scores = stats.scoresByGroup[g];
  const adjusted = stats.adjustedPValuesByGroup[g];
  const fold = stats.log2FoldChangeByGroup[g];
  const pctIn = stats.pctInByGroup[g];
  const pctRef = stats.pctRefByGroup[g];
  const geneCount = scores.length;
  const keep = new Uint32Array(geneCount);
  const keys = new Float64Array(geneCount);
  let count = 0;
  for (let i = 0; i < geneCount; i++) {
    const p = adjusted[i];
    if (!(p <= maxAdjP)) continue; // NaN (untested) never passes
    const score = scores[i];
    if (direction === 'up' && !(score > 0)) continue;
    if (direction === 'down' && !(score < 0)) continue;
    if (!(Math.abs(fold[i]) >= minLog2FC)) continue;
    if (!(pctIn[i] >= minPctIn)) continue;
    if (!(pctRef[i] <= maxPctRef)) continue;
    let key = rankValue(rankBy, stats, g, i);
    if (!Number.isFinite(key)) key = rankBy === 'padj' ? Infinity : 0;
    // One ascending sort for every sense: larger is better except for p.
    if (rankBy === 'padj') {
      keys[i] = key;
    } else if (direction === 'up') {
      keys[i] = -key;
    } else if (direction === 'down') {
      keys[i] = key;
    } else {
      keys[i] = -Math.abs(key);
    }
    keep[count++] = i;
  }
  const order = keep.subarray(0, count);
  order.sort((a, b) => keys[a] - keys[b] || a - b);
  return order;
}

/**
 * Every group's shown markers.
 *
 * @param {Object} stats - MarkerStatistics (with `groups`)
 * @param {MarkerDisplay} display
 * @returns {{groups: Array<{group: Object, passing: number, markers: Object[]}>, shownGenes: string[]}}
 */
export function selectMarkers(stats, display) {
  const { topN } = display;
  if (!Number.isSafeInteger(topN) || topN < 1) throw new RangeError('Top genes per group must be a positive integer');
  const out = [];
  const shown = new Set();
  stats.groups.forEach((group, g) => {
    if (!group.tested) {
      out.push({ group, passing: 0, markers: [] });
      return;
    }
    const order = rankGroupGenes(stats, g, display);
    const markers = [];
    for (let k = 0; k < Math.min(topN, order.length); k++) {
      const i = order[k];
      const gene = stats.genes[i];
      shown.add(gene);
      markers.push({
        gene,
        geneIndex: i,
        rank: k + 1,
        score: stats.scoresByGroup[g][i],
        log2FoldChange: stats.log2FoldChangeByGroup[g][i],
        pValue: stats.pValuesByGroup[g][i],
        adjustedPValue: stats.adjustedPValuesByGroup[g][i],
        percentInGroup: stats.pctInByGroup[g][i],
        percentOutGroup: stats.pctRefByGroup[g][i],
        auroc: stats.aurocByGroup[g][i],
        meanInGroup: stats.meanInGroupByGroup[g][i],
      });
    }
    out.push({ group, passing: order.length, markers });
  });
  return { groups: out, shownGenes: [...shown] };
}

/** The display keys of the marker options (`options/marker-options.js`). */
export const MARKER_DISPLAY_KEYS = Object.freeze([
  'direction', 'maxAdjP', 'minLog2FC', 'minPctIn', 'maxPctRef', 'rankBy', 'topN'
]);

/** The display options of an options record. */
export function markerDisplayOf(options) {
  return Object.fromEntries(MARKER_DISPLAY_KEYS.map(key => [key, options[key]]));
}
