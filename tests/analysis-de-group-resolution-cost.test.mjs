/**
 * Differential expression resolves its two groups (a pass over every cell)
 * to say whether Run can start, and Run's state is asked on every option,
 * highlight and page change, several times each (8 ms a pass at 2M cells).
 * The answer is kept while the options choosing the groups, the highlights
 * and the fields they read are the same (0.01 ms).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/de-analysis-ui.js';

function makeUi() {
  const ui = Object.create(DEAnalysisUI.prototype);
  const described = {
    codes: Uint8Array.of(0, 1, 2, 0, 1, 2, 0),
    categories: ['a', 'b', 'c'],
    groups: [{ optionId: 'a' }, { optionId: 'b' }, { optionId: 'c' }],
  };
  let codeReads = 0;
  // Counts the cell passes: every resolution reads the codes.
  Object.defineProperty(described, 'codes', {
    get() {
      codeReads += 1;
      return Uint8Array.of(0, 1, 2, 0, 1, 2, 0);
    },
  });
  Object.assign(ui, {
    _fieldGroups: new Map([['cluster', described]]),
    _fieldGroupFailures: new Map(),
    _resolvedGroups: null,
    _replicateBlocker: null,
    _highlightRevision: 0,
  });
  return { ui, reads: () => codeReads };
}

const OPTIONS = Object.freeze({
  compare: 'categories',
  field: 'cluster',
  categoriesA: { mode: 'some', ids: ['a'] },
  categoriesB: { mode: 'some', ids: ['b', 'c'] },
  within: 'all',
  withinField: '',
  withinCategories: { mode: 'all', ids: [] },
  pageA: '',
  pageB: '',
  replicates: '',
});

test('the groups are resolved once for the same options, highlights and fields', () => {
  const { ui, reads } = makeUi();
  const first = ui._resolveGroups(OPTIONS);
  assert.deepEqual([...first.a.cells], [0, 3, 6]);
  assert.deepEqual([...first.b.cells], [1, 2, 4, 5]);
  assert.ok(first.a.cells instanceof Uint32Array);
  const passes = reads();
  // Run's state asked again (another option that does not choose the groups).
  assert.equal(ui._getRunBlocker({ ...OPTIONS, method: 'ttest' }), null);
  assert.equal(ui._resolveGroups({ ...OPTIONS }), first);
  assert.equal(reads(), passes);

  // A highlight change or another group choice resolves again.
  ui._highlightRevision += 1;
  assert.notEqual(ui._resolveGroups(OPTIONS), first);
  const swapped = ui._resolveGroups({ ...OPTIONS, categoriesA: OPTIONS.categoriesB, categoriesB: OPTIONS.categoriesA });
  assert.deepEqual([...swapped.a.cells], [1, 2, 4, 5]);
  assert.ok(reads() > passes);
});

test('a field whose categories could not be read says so, once, until the field changes', () => {
  const ui = Object.create(DEAnalysisUI.prototype);
  const reads = [];
  const notices = [];
  let fail = null;
  Object.assign(ui, {
    _fieldGroups: new Map(),
    _fieldGroupFailures: new Map(),
    _pendingFields: new Set(),
    _resolvedGroups: null,
    _replicateBlocker: null,
    _highlightRevision: 0,
    _isDestroyed: false,
    _notifications: { error: message => notices.push(message) },
    _refreshOptionsContext: () => {},
    _helperController: () => ({
      describeGroups: field => {
        reads.push(field);
        return new Promise((_, reject) => { fail = reject; });
      },
    }),
  });
  assert.equal(ui._getRunBlocker(OPTIONS), 'Reading the categories…');
  fail(new Error('the read failed'));
  return new Promise(resolve => setTimeout(resolve, 0)).then(() => {
    for (let redraw = 0; redraw < 5; redraw++) {
      assert.equal(ui._getRunBlocker(OPTIONS), 'The categories of cluster could not be read: the read failed');
    }
    assert.deepEqual(reads, ['cluster'], 'read once, not on every redraw');
    assert.equal(notices.length, 1);
  });
});
