/**
 * Which markers a group shows is decided on the full statistics of a run
 * (`genes-panel/marker-selection.js`), so a filter, the ranking or N never
 * tests again:
 *
 * - Direction: Up keeps scores above zero, Down below, Both either;
 * - adjusted p ≤ max (inclusive), |log2FC| ≥ min, % in group ≥ min,
 *   % in reference ≤ max, every bound inclusive;
 * - an untested gene (NaN statistics) never passes, and an untested group
 *   shows nothing;
 * - ranking by score, adjusted p, log2FC, AUROC or %in − %ref in the
 *   direction's sense, ties by dataset gene order; Top N cuts the list.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DIRECTIONS,
  MARKER_DISPLAY_KEYS,
  RANK_KEYS,
  markerDisplayOf,
  rankGroupGenes,
  selectMarkers,
} from '../assets/js/app/analysis/genes-panel/marker-selection.js';
import { MARKER_OPTIONS } from '../assets/js/app/analysis/options/marker-options.js';

const GENES = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];

/** Group 0 tested; group 1 untested (skipped small group). */
function statistics() {
  const column = values => Float64Array.from(values);
  return {
    genes: GENES,
    groups: [
      { groupId: 'category:0', groupName: 'A', tested: true },
      { groupId: 'category:1', groupName: 'B', tested: false },
    ],
    //            G0     G1     G2     G3    G4     G5    G6   G7
    scoresByGroup: [
      column([5, 3, -4, 3, -1, 2, NaN, 8]),
      column(GENES.map(() => NaN)),
    ],
    adjustedPValuesByGroup: [
      column([0.001, 0.05, 0.002, 0.01, 0.04, 0.0500001, NaN, 0.03]),
      column(GENES.map(() => NaN)),
    ],
    pValuesByGroup: [
      column([0.0001, 0.01, 0.0002, 0.001, 0.004, 0.01, NaN, 0.003]),
      column(GENES.map(() => NaN)),
    ],
    log2FoldChangeByGroup: [
      column([2, 0.5, -3, 1, -0.25, 4, NaN, 0.1]),
      column(GENES.map(() => NaN)),
    ],
    pctInByGroup: [
      column([90, 40, 5, 60, 20, 80, NaN, 10]),
      column(GENES.map(() => NaN)),
    ],
    pctRefByGroup: [
      column([10, 30, 70, 20, 30, 50, NaN, 5]),
      column(GENES.map(() => NaN)),
    ],
    aurocByGroup: [
      column([0.9, 0.6, 0.2, 0.7, 0.45, 0.65, NaN, 0.95]),
      column(GENES.map(() => NaN)),
    ],
    meanInGroupByGroup: [
      column([3, 1, 0.1, 2, 0.5, 2.5, NaN, 0.2]),
      column(GENES.map(() => NaN)),
    ],
  };
}

const OPEN = Object.freeze({
  direction: 'both', maxAdjP: 1, minLog2FC: 0, minPctIn: 0, maxPctRef: 100, rankBy: 'score', topN: 100,
});

const ranked = (display, g = 0) => [...rankGroupGenes(statistics(), g, { ...OPEN, ...display })].map(i => GENES[i]);

test('the display keys are the marker options the selection reads', () => {
  assert.deepEqual(MARKER_DISPLAY_KEYS, ['direction', 'maxAdjP', 'minLog2FC', 'minPctIn', 'maxPctRef', 'rankBy', 'topN']);
  for (const key of MARKER_DISPLAY_KEYS) assert.ok(MARKER_OPTIONS.keys.includes(key), key);
  const options = MARKER_OPTIONS.defaults({ categoricalFields: [{ key: 'cell_type' }] });
  assert.deepEqual(Object.keys(markerDisplayOf(options)), [...MARKER_DISPLAY_KEYS]);
  assert.deepEqual(
    MARKER_OPTIONS.entry('direction').choices.map(choice => choice.value),
    [...DIRECTIONS],
  );
  assert.deepEqual(MARKER_OPTIONS.entry('rankBy').choices.map(choice => choice.value), [...RANK_KEYS]);
});

test('direction keeps the scores on its side of zero; an untested gene never passes', () => {
  assert.deepEqual(ranked({ direction: 'up' }), ['G7', 'G0', 'G1', 'G3', 'G5']);
  assert.deepEqual(ranked({ direction: 'down' }), ['G2', 'G4']);
  assert.deepEqual(ranked({ direction: 'both' }), ['G7', 'G0', 'G2', 'G1', 'G3', 'G5', 'G4']);
  assert.ok(!ranked({}).includes('G6'), 'NaN statistics are never shown');
});

test('every filter bound is inclusive', () => {
  // Max adjusted p 0.05 keeps G1 (exactly 0.05), not G5 (0.0500001).
  assert.deepEqual(ranked({ direction: 'up', maxAdjP: 0.05 }), ['G7', 'G0', 'G1', 'G3']);
  // Min |log2FC| 0.5 keeps G1 (0.5) and G2 (−3), drops G4 (−0.25) and G7 (0.1).
  assert.deepEqual(ranked({ minLog2FC: 0.5 }), ['G0', 'G2', 'G1', 'G3', 'G5']);
  // Min % in group 40 keeps G1 (40).
  assert.deepEqual(ranked({ direction: 'up', minPctIn: 40 }), ['G0', 'G1', 'G3', 'G5']);
  // Max % in reference 30 keeps G1 and G4 (30).
  assert.deepEqual(ranked({ maxPctRef: 30 }), ['G7', 'G0', 'G1', 'G3', 'G4']);
  // A filter nothing passes leaves the group empty.
  assert.deepEqual(ranked({ maxAdjP: 0 }), []);
});

test('ranking follows the key in the direction’s sense, ties by gene order', () => {
  // Score ties (G1 and G3 at 3) keep dataset order.
  assert.deepEqual(ranked({ direction: 'up', rankBy: 'score' }), ['G7', 'G0', 'G1', 'G3', 'G5']);
  // Adjusted p: smallest first whatever the direction.
  assert.deepEqual(ranked({ direction: 'up', rankBy: 'padj' }), ['G0', 'G3', 'G7', 'G1', 'G5']);
  assert.deepEqual(ranked({ direction: 'down', rankBy: 'padj' }), ['G2', 'G4']);
  // log2FC: largest first (Up), most negative first (Down), largest magnitude (Both).
  assert.deepEqual(ranked({ direction: 'up', rankBy: 'log2fc' }), ['G5', 'G0', 'G3', 'G1', 'G7']);
  assert.deepEqual(ranked({ direction: 'down', rankBy: 'log2fc' }), ['G2', 'G4']);
  assert.deepEqual(ranked({ direction: 'both', rankBy: 'log2fc' }), ['G5', 'G2', 'G0', 'G3', 'G1', 'G4', 'G7']);
  // AUROC around 0.5.
  assert.deepEqual(ranked({ direction: 'up', rankBy: 'auroc' }), ['G7', 'G0', 'G3', 'G5', 'G1']);
  assert.deepEqual(ranked({ direction: 'down', rankBy: 'auroc' }), ['G2', 'G4']);
  // % in group − % in reference.
  assert.deepEqual(ranked({ direction: 'up', rankBy: 'pct_diff' }), ['G0', 'G3', 'G5', 'G1', 'G7']);
  assert.deepEqual(ranked({ direction: 'both', rankBy: 'pct_diff' }), ['G0', 'G2', 'G3', 'G5', 'G1', 'G4', 'G7']);
});

test('selectMarkers cuts each tested group at Top N and shows nothing for an untested group', () => {
  const result = selectMarkers(statistics(), { ...OPEN, direction: 'up', topN: 2 });
  assert.equal(result.groups.length, 2);
  const [a, b] = result.groups;
  assert.equal(a.passing, 5, 'how many pass, before Top N');
  assert.deepEqual(a.markers.map(marker => [marker.gene, marker.rank]), [['G7', 1], ['G0', 2]]);
  assert.deepEqual(a.markers[1], {
    gene: 'G0',
    geneIndex: 0,
    rank: 2,
    score: 5,
    log2FoldChange: 2,
    pValue: 0.0001,
    adjustedPValue: 0.001,
    percentInGroup: 90,
    percentOutGroup: 10,
    auroc: 0.9,
    meanInGroup: 3,
  });
  assert.deepEqual(b, { group: statistics().groups[1], passing: 0, markers: [] });
  assert.deepEqual(result.shownGenes, ['G7', 'G0']);
});

test('the selection refuses a direction, a ranking or a Top N it does not know', () => {
  assert.throws(() => rankGroupGenes(statistics(), 0, { ...OPEN, direction: 'sideways' }), RangeError);
  assert.throws(() => rankGroupGenes(statistics(), 0, { ...OPEN, rankBy: 'mean' }), RangeError);
  assert.throws(() => selectMarkers(statistics(), { ...OPEN, topN: 0 }), RangeError);
  assert.throws(() => selectMarkers(statistics(), { ...OPEN, topN: 2.5 }), RangeError);
});
