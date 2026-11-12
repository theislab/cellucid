/**
 * A group smaller than "Min cells per group" is a policy, never an error
 * (`GenesPanelController.plan`):
 *
 * - **Skip and list**: the group is not tested; it stays a column, so its
 *   cells are still part of the rest, and it is listed as skipped;
 * - **Pool into one group**: the small groups become one column, tested when
 *   it reaches the minimum and skipped (listed) when it does not;
 * - **Test anyway, flagged**: the group is tested and listed as low n, down
 *   to two cells (one cell has no variance and is skipped).
 *
 * A run is refused only with its reason (`blocker`): too few groups, no
 * reference group, a reference group too small, no group to test.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GenesPanelController,
  POOLED_GROUP_ID,
  groupsInGeneSample,
} from '../assets/js/app/analysis/genes-panel/genes-panel-controller.js';
import { MARKER_OPTIONS } from '../assets/js/app/analysis/options/marker-options.js';

const SIZES = { T: 300, B: 120, NK: 60, DC: 9, Mast: 4, Plasma: 1 };

/** `describeGroups` output for the sizes (sorted largest first). */
function described(sizes = SIZES) {
  const categories = Object.keys(sizes);
  const groups = categories
    .map((label, code) => ({
      groupId: `category:${code}`,
      optionId: label,
      groupName: label,
      code,
      count: sizes[label],
      color: '#000000',
    }))
    .sort((a, b) => b.count - a.count || a.code - b.code);
  return { codes: new Uint8Array(0), categories, groups };
}

function optionsWith(partial, sizes = SIZES) {
  const context = {
    categoricalFields: [{ key: 'cell_type' }],
    groupsFor: () => Object.keys(sizes).map(label => ({ id: label, name: label, count: sizes[label] })),
  };
  return MARKER_OPTIONS.withDefaults({ groupBy: 'cell_type', ...partial }, context);
}

function plan(partial, sizes = SIZES) {
  const controller = Object.create(GenesPanelController.prototype);
  return controller.plan(optionsWith(partial, sizes), described(sizes));
}

const names = groups => groups.map(group => group.groupName);
const tested = result => names(result.columns.filter(column => column.tested));

test('skip: small groups are listed and stay in the rest as untested columns', () => {
  const result = plan({ smallGroups: 'skip' });
  assert.equal(result.blocker, null);
  assert.deepEqual(tested(result), ['T', 'B', 'NK']);
  assert.deepEqual(names(result.skipped), ['DC', 'Mast', 'Plasma']);
  assert.deepEqual(names(result.columns), ['T', 'B', 'NK', 'DC', 'Mast', 'Plasma'], 'every cell stays in a column');
  for (const column of result.columns.filter(column => !column.tested)) {
    assert.equal(column.small, true);
    assert.equal(column.smallFate, 'skipped');
  }
  assert.deepEqual(result.lowN, []);
  assert.deepEqual(result.pooled, []);
  assert.equal(result.minCellsPerSide, 10);
  assert.equal(result.testedCount, 3);
  assert.equal(result.referenceIndex, -1);
});

test('pool: the small groups are one column holding exactly their categories', () => {
  const result = plan({ smallGroups: 'pool' });
  assert.equal(result.blocker, null);
  const pooled = result.columns.find(column => column.groupId === POOLED_GROUP_ID);
  // 9 + 4 + 1 = 14 cells: at the minimum of 10, so the pool is tested.
  assert.equal(pooled.count, 14);
  assert.equal(pooled.tested, true);
  assert.equal(pooled.smallFate, 'pooled');
  assert.equal(pooled.groupName, 'Other small groups (3)');
  assert.deepEqual(pooled.members.toSorted(), [3, 4, 5], 'the codes of DC, Mast and Plasma');
  assert.deepEqual(names(result.pooled), ['DC', 'Mast', 'Plasma']);
  assert.deepEqual(names(result.columns), ['T', 'B', 'NK', 'Other small groups (3)']);
  assert.deepEqual(result.skipped, []);
  for (const column of result.columns.filter(column => column !== pooled)) {
    assert.deepEqual(column.members, [column.code]);
  }
});

test('pool: a pool still under the minimum is listed as skipped, and its cells stay in the rest', () => {
  const result = plan({ smallGroups: 'pool', minCells: 20 });
  const pooled = result.columns.find(column => column.groupId === POOLED_GROUP_ID);
  assert.equal(pooled.count, 14);
  assert.equal(pooled.tested, false);
  assert.equal(pooled.smallFate, 'skipped');
  assert.deepEqual(names(result.skipped), ['Other small groups (3)']);
  assert.equal(result.blocker, null);
});

test('test anyway: small groups are tested and flagged low n, down to two cells', () => {
  const result = plan({ smallGroups: 'test' });
  assert.equal(result.blocker, null);
  assert.deepEqual(tested(result), ['T', 'B', 'NK', 'DC', 'Mast']);
  assert.deepEqual(names(result.lowN), ['DC', 'Mast']);
  assert.deepEqual(names(result.skipped), ['Plasma'], 'one cell has no variance to test');
  assert.equal(result.minCellsPerSide, 2);
});

test('a chosen subset tests only its groups; the rest can be every other cell or the chosen groups only', () => {
  const all = plan({ testGroups: { mode: 'subset', ids: ['B', 'DC'] } });
  assert.deepEqual(tested(all), ['B']);
  assert.deepEqual(names(all.skipped), ['DC']);
  assert.deepEqual(names(all.columns), ['T', 'B', 'NK', 'DC', 'Mast', 'Plasma']);

  const only = plan({ testGroups: { mode: 'subset', ids: ['B', 'NK'] }, restIncludes: 'selected' });
  assert.deepEqual(names(only.columns), ['B', 'NK']);
  assert.deepEqual(tested(only), ['B', 'NK']);
});

test('against a reference group: the reference is a column, never tested, and sized by the policy', () => {
  const result = plan({ compareAgainst: 'group', referenceGroup: 'NK' });
  assert.equal(result.blocker, null);
  assert.deepEqual(tested(result), ['T', 'B']);
  assert.equal(result.columns[result.referenceIndex].groupName, 'NK');
  assert.equal(result.columns[result.referenceIndex].tested, false);

  // No reference chosen is the largest group.
  const largest = plan({ compareAgainst: 'group', referenceGroup: '' });
  assert.equal(largest.columns[largest.referenceIndex].groupName, 'T');
  assert.deepEqual(tested(largest), ['B', 'NK']);

  const small = plan({ compareAgainst: 'group', referenceGroup: 'DC' });
  assert.equal(small.blocker, 'The reference group has fewer than 10 cells');
  // Test anyway holds the reference to two cells only.
  const anyway = plan({ compareAgainst: 'group', referenceGroup: 'Mast', smallGroups: 'test' });
  assert.equal(anyway.blocker, null);
  const single = plan({ compareAgainst: 'group', referenceGroup: 'Plasma', smallGroups: 'test' });
  assert.equal(single.blocker, 'The reference group has fewer than 2 cells');

  // A reference the field no longer has (its groups changed under a saved
  // record) is asked for again, not guessed.
  const stale = { ...optionsWith({ compareAgainst: 'group', referenceGroup: 'NK' }), referenceGroup: 'Gone' };
  const unknown = Object.create(GenesPanelController.prototype).plan(stale, described());
  assert.equal(unknown.blocker, 'Choose the reference group');
});

test('a run without two columns or without a group to test is refused with its reason', () => {
  const one = plan({}, { T: 300 });
  assert.match(one.blocker, /\b1\b/);
  assert.equal(one.columns.length, 1);

  const allSmall = plan({}, { DC: 9, Mast: 4 });
  assert.equal(allSmall.blocker, 'No group to test has 10 cells or more');

  const none = plan({ testGroups: { mode: 'subset', ids: [] } });
  assert.equal(none.blocker, 'Choose groups to test');

  // Restricted to one chosen group, there is nothing to compare it with.
  const alone = plan({ testGroups: { mode: 'subset', ids: ['B'] }, restIncludes: 'selected' });
  assert.equal(alone.columns.length, 1);
  assert.match(alone.blocker, /\b1\b/);

  // Pooling everything small into one column beside one group still runs.
  const pooledPair = plan({ smallGroups: 'pool' }, { T: 300, DC: 9, Mast: 4 });
  assert.equal(pooledPair.blocker, null);
  assert.deepEqual(tested(pooledPair), ['T', 'Other small groups (2)']);
});

// Genes read for a sample of the open cells (the walk of 2026-10-31: "15
// skipped" of 50 cell types on a CELLxGENE atlas, with no reason given):
// a group is counted among the sample, and a result says each group's cells
// among it of its cells in every open cell, and that a group is skipped for
// too few sampled cells.
globalThis.HTMLElement ??= class HTMLElement {};
const { describeSkippedGroups } = await import('../assets/js/app/analysis/ui/analysis-types/genes-panel-ui.js');

test('a marker run on a gene sample records each group\'s cells among it of its cells, and why a group is skipped', async () => {
  // 20 open cells; genes are read for the first 12. T: cells 0-9, B: 10-17, NK: 18-19.
  const codes = Uint8Array.from({ length: 20 }, (_, i) => (i < 10 ? 0 : i < 18 ? 1 : 2));
  const sample = { cells: 12, of: 20 };
  const controller = Object.create(GenesPanelController.prototype);
  controller._closed = false;
  controller._getCacheIdentity = () => ({ key: 'gene-sample' });
  controller._cache = { setIdentity() {}, get: () => ({ groups: [] }) };
  controller.dataLayer = {
    state: { pointCount: 20, getGeneSample: () => sample, varFieldLoader: null },
    ensureObsFieldLoaded: async () => ({ kind: 'category', codes, categories: ['T', 'B', 'NK'] }),
    getGeneKeys: async () => ['G1', 'G2'],
    resolveExpressionMatrix: () => ({ matrix: 'X', read: null, label: 'Mapped (X)' }),
    matrixHoldsCounts: () => false,
    expressionTransformOf: () => ({ normalize: false, log1p: false }),
    runValues: async () => ({ transform: { normalize: false, log1p: false }, sizes: null, key: 'raw', record: null }),
  };
  const options = optionsWith({ smallGroups: 'skip', minCells: 3 }, { T: 10, B: 8, NK: 2 });
  const { metadata } = await controller.runAnalysis({ options });
  // Among the 12 cells genes are read for, B has 2 of its 8: skipped, for
  // too few sampled cells (every open cell would test it).
  assert.deepEqual(metadata.geneSample.groups, [{ name: 'T', used: 10, of: 10 }, { name: 'B', used: 2, of: 8 }]);
  assert.deepEqual(metadata.skippedGroups, [{ name: 'B', cells: 2 }]);
  assert.equal(describeSkippedGroups(metadata, 3).text, '1 skipped: too few sampled cells');
  assert.match(describeSkippedGroups(metadata, 3).title, /B \(2 of 8\)/);
});

test('a skipped group is said to be skipped for too few sampled cells when every open cell would test it', () => {
  const geneSample = { cells: 6_320, of: 584_944, groups: [
    { name: 'AT1', used: 412, of: 39_000 },
    { name: 'ionocyte', used: 3, of: 1_523 },
    { name: 'brush cell', used: 1, of: 6 },
  ] };
  const both = describeSkippedGroups({ skippedGroups: [{ name: 'ionocyte', cells: 3 }, { name: 'brush cell', cells: 1 }], geneSample }, 10);
  assert.equal(both.text, '2 skipped (1 for too few sampled cells)');
  assert.equal(both.title, 'Fewer than 10 cells among the 6,320 of 584,944 open cells that genes are read for, not tested (kept in the rest): '
    + 'ionocyte (3 of 1,523), brush cell (1 of 6). Read genes for more cells (Session › Subsampling: Genes read for), then run again to test them on more cells.');
  assert.equal(describeSkippedGroups({ skippedGroups: [{ name: 'ionocyte', cells: 3 }], geneSample }, 10).text, '1 skipped: too few sampled cells');
  // Every open cell's genes read: as before.
  const whole = describeSkippedGroups({ skippedGroups: [{ name: 'NK cell', cells: 4 }], geneSample: null }, 10);
  assert.deepEqual(whole, { text: '1 skipped', title: 'Fewer than 10 cells, not tested (kept in the rest): NK cell (4)' });
  assert.equal(describeSkippedGroups({ skippedGroups: [], geneSample }, 10), null);
});

test('a pooled column counts its members\' cells in every open cell', () => {
  const columns = [
    { groupName: 'T', count: 30, members: [0] },
    { groupName: 'Other small groups (2)', count: 3, members: [2, 3] },
  ];
  assert.deepEqual(groupsInGeneSample(columns, [{ code: 0, count: 300 }, { code: 2, count: 9 }, { code: 3, count: 4 }]), [
    { name: 'T', used: 30, of: 300 },
    { name: 'Other small groups (2)', used: 3, of: 13 },
  ]);
});
