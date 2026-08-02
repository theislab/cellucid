/**
 * One definition of "the cells of a highlight page".
 *
 * The number the interface displays for a page, the set the renderer is asked
 * to paint, and the set a page combination reads must all be the same set. The
 * highlight manager derives every one of them from a single collector, and an
 * index that does not name a cell in the current dataset stops the operation
 * instead of quietly leaving the result short.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { highlightStateMethods } from '../assets/js/app/state/managers/highlight-manager.js';
import { highlightAccessorMethods } from '../assets/js/app/state/managers/highlight-accessors.js';

function createHighlightState({ pointCount, pages, activePageId }) {
  const publications = [];
  const state = Object.create(highlightStateMethods);
  Object.assign(state, {
    pointCount,
    highlightPages: pages,
    activePageId,
    highlightArray: null,
    _highlightedCellIndices: null,
    _highlightMembershipScratch: null,
    _highlightIdCounter: 0,
    _highlightPageIdCounter: pages.length,
    _cachedHighlightCount: null,
    _cachedTotalHighlightCount: null,
    _cachedHighlightLodMembership: null,
    viewer: {
      updateHighlight(highlightData, highlightedIndices) {
        publications.push({
          painted: [...highlightData].reduce(
            (cells, value, index) => {
              if (value !== 0) cells.push(index);
              return cells;
            },
            []
          ),
          highlightedIndices: highlightedIndices === null
            ? null
            : [...highlightedIndices],
        });
      },
    },
    emit() {},
  });
  return { state, publications };
}

function createPage(id, groups) {
  return { id, name: id, color: '#ff0000', highlightedGroups: groups };
}

function createGroup(id, cellIndices, enabled = true) {
  return {
    id,
    type: 'lasso',
    label: id,
    enabled,
    cellIndices,
    cellCount: cellIndices.length,
  };
}

test('the displayed page count is the set the renderer is asked to paint', () => {
  const { state, publications } = createHighlightState({
    pointCount: 12,
    activePageId: 'page_1',
    pages: [createPage('page_1', [
      createGroup('highlight_1', [1, 3, 5, 7]),
      // Overlapping membership must be counted once and painted once.
      createGroup('highlight_2', [5, 7, 9]),
      // A disabled group is neither counted nor painted.
      createGroup('highlight_3', [0, 2, 4], false),
    ])],
  });

  state._recomputeHighlightArray();

  const displayedCount = state.getHighlightedCellCountForPage('page_1');
  const publication = publications.at(-1);

  assert.deepEqual(publication.painted, [1, 3, 5, 7, 9]);
  assert.deepEqual(
    [...publication.highlightedIndices].sort((a, b) => a - b),
    publication.painted
  );
  assert.equal(
    displayedCount,
    publication.painted.length,
    'the count shown for a page must equal the number of cells painted for it'
  );
  assert.equal(displayedCount, 5);
});

test('a page can never be counted larger than the set it renders', () => {
  // The membership a page claims and the membership the renderer can honour
  // are the same question asked twice. Whatever a page holds -- including a
  // cell index that belongs to a dataset that is no longer loaded -- the two
  // answers must agree, or both must refuse.
  for (const cellIndices of [
    [1, 3, 5],
    [1, 1, 3],
    [1, 8, 3],
    [1, 3, 12],
    [1, 3, -1],
  ]) {
    const { state, publications } = createHighlightState({
      pointCount: 8,
      activePageId: 'page_1',
      pages: [createPage('page_1', [createGroup('highlight_1', cellIndices)])],
    });

    let countError = null;
    let count = null;
    try {
      count = state.getHighlightedCellCountForPage('page_1');
    } catch (error) {
      countError = error;
    }

    let paintError = null;
    try {
      state._recomputeHighlightArray();
    } catch (error) {
      paintError = error;
    }

    assert.equal(
      countError === null,
      paintError === null,
      `counting and painting must agree on whether ${JSON.stringify(cellIndices)} `
      + 'is renderable'
    );
    if (countError === null) {
      assert.equal(
        count,
        publications.at(-1).painted.length,
        `page counted ${count} cells but only `
        + `${publications.at(-1).painted.length} were painted for `
        + JSON.stringify(cellIndices)
      );
    }
  }
});

test('counting one page never leaks membership into the next count', () => {
  const { state } = createHighlightState({
    pointCount: 12,
    activePageId: 'page_1',
    pages: [
      createPage('page_1', [createGroup('highlight_1', [1, 2, 3])]),
      createPage('page_2', [createGroup('highlight_2', [1, 2, 3, 4])]),
    ],
  });

  assert.equal(state.getHighlightedCellCountForPage('page_1'), 3);
  assert.equal(state.getHighlightedCellCountForPage('page_2'), 4);
  assert.equal(state.getHighlightedCellCountForPage('page_1'), 3);
  assert.equal(state.getHighlightedCellCountForPage('page_2'), 4);
});

test('a page cell outside the dataset stops the repaint instead of vanishing', () => {
  const { state, publications } = createHighlightState({
    pointCount: 8,
    activePageId: 'page_1',
    pages: [createPage('page_1', [createGroup('highlight_1', [1, 8, 3])])],
  });

  assert.throws(
    () => state._recomputeHighlightArray(),
    (error) => (
      error instanceof RangeError
      && /cell index 8 is outside the current dataset of 8 cells/.test(error.message)
    ),
    'an out-of-dataset cell must be reported, not silently left unpainted'
  );
  assert.equal(
    publications.length,
    0,
    'nothing may be published from a membership the manager could not honour'
  );
});

test('a page cell outside the dataset stops the count instead of inflating it', () => {
  const { state } = createHighlightState({
    pointCount: 8,
    activePageId: 'page_1',
    pages: [createPage('page_1', [createGroup('highlight_1', [1, 8, 3])])],
  });

  assert.throws(
    () => state.getHighlightedCellCountForPage('page_1'),
    RangeError,
    'a count must never report cells the renderer would refuse to paint'
  );
  // The partially filled deduplication buffer is retired, so a later valid
  // page still counts exactly.
  state.highlightPages[0].highlightedGroups = [createGroup('highlight_1', [1, 3])];
  assert.equal(state.getHighlightedCellCountForPage('page_1'), 2);
});

test('a preview cell outside the dataset stops the publication instead of vanishing', () => {
  const { state, publications } = createHighlightState({
    pointCount: 8,
    activePageId: 'page_1',
    pages: [createPage('page_1', [])],
  });

  assert.throws(
    () => state.setPreviewHighlightFromIndices([2, 4, 8]),
    (error) => (
      error instanceof RangeError
      && /Preview highlight cell index 8 is outside the current dataset of 8 cells/
        .test(error.message)
    ),
    'a preview cell from another dataset must be reported, not dropped'
  );
  assert.equal(publications.length, 0);

  assert.throws(
    () => state.setPreviewHighlightFromIndices([2, -1]),
    RangeError
  );
  assert.throws(
    () => state.setPreviewHighlightFromIndices([2, 1.5]),
    RangeError
  );
  assert.throws(
    () => state.setPreviewHighlightFromIndices(new Set([1, 2])),
    TypeError,
    'only an indexed cell collection can be a preview'
  );
});

test('a preview publishes the active page underneath the in-progress selection', () => {
  const { state, publications } = createHighlightState({
    pointCount: 12,
    activePageId: 'page_1',
    pages: [createPage('page_1', [
      createGroup('highlight_1', [0, 1]),
      createGroup('highlight_9', [10], false),
    ])],
  });

  state.setPreviewHighlightFromIndices([1, 4, 5]);
  const publication = publications.at(-1);

  assert.deepEqual(publication.painted, [0, 1, 4, 5]);
  assert.deepEqual(
    publication.highlightedIndices,
    [0, 1, 4, 5],
    'the published index list must contain every painted cell exactly once'
  );
  assert.ok(
    state._highlightedCellIndices instanceof Uint32Array,
    'the published index list is a Uint32Array: a selection can be the whole dataset, and copying it into a plain array costs eight bytes per cell'
  );
  assert.deepEqual([...state._highlightedCellIndices], [0, 1, 4, 5]);
});

test('combining pages reads the same membership the pages render', () => {
  const { state } = createHighlightState({
    pointCount: 12,
    activePageId: 'page_1',
    pages: [
      createPage('page_1', [
        createGroup('highlight_1', [1, 2, 3]),
        createGroup('highlight_2', [7], false),
      ]),
      createPage('page_2', [createGroup('highlight_3', [3, 4, 7])]),
    ],
  });

  const intersection = state.combineHighlightPages(
    'page_1',
    'page_2',
    'intersection'
  );
  assert.deepEqual(intersection.highlightedGroups[0].cellIndices, [3]);

  const union = state.combineHighlightPages('page_1', 'page_2', 'union');
  assert.deepEqual(
    [...union.highlightedGroups[0].cellIndices].sort((a, b) => a - b),
    [1, 2, 3, 4, 7],
    'a disabled group contributes to neither the count nor the combination'
  );
});

test('clearing highlights empties exactly the active page', () => {
  const { state } = createHighlightState({
    pointCount: 12,
    activePageId: 'page_2',
    pages: [
      createPage('page_1', [createGroup('highlight_1', [1, 2])]),
      createPage('page_2', [createGroup('highlight_2', [3, 4]), createGroup('highlight_3', [5])]),
    ],
  });

  assert.equal(state.clearAllHighlights(), 2);
  assert.equal(state.getHighlightedCellCountForPage('page_2'), 0);
  assert.equal(
    state.getHighlightedCellCountForPage('page_1'),
    2,
    'other pages keep their highlights; the operation is active-page scoped'
  );

  state.activePageId = 'page_missing';
  assert.throws(
    () => state.clearAllHighlights(),
    RangeError,
    'a named-but-missing active page is a violated invariant, not a no-op'
  );

  state.highlightPages = [];
  state.activePageId = null;
  assert.equal(
    state.clearAllHighlights(),
    0,
    'an empty page inventory truthfully removes nothing'
  );
});

test('a preview replaces the previous preview instead of accumulating it', () => {
  // A multi-step add/subtract gesture republishes the whole in-progress
  // selection on every pointer event. Each publication must stand alone: a
  // cell dropped from the selection has to leave the highlight array, or a
  // subtraction could never be seen.
  const { state, publications } = createHighlightState({
    pointCount: 12,
    activePageId: 'page_1',
    pages: [createPage('page_1', [createGroup('highlight_1', [0])])],
  });

  state.setPreviewHighlightFromIndices([2, 3, 4, 5]);
  assert.deepEqual(publications.at(-1).painted, [0, 2, 3, 4, 5]);

  // The same gesture, now subtracting 4 and 5 from its candidates.
  state.setPreviewHighlightFromIndices([2, 3]);
  assert.deepEqual(
    publications.at(-1).painted,
    [0, 2, 3],
    'cells removed from the in-progress selection must stop being painted'
  );

  // Retiring the preview leaves exactly the page's own highlights.
  state.clearPreviewHighlight();
  assert.deepEqual(publications.at(-1).painted, [0]);
});

test('highlight accessors expose no second definition of page membership', () => {
  assert.equal(
    Object.hasOwn(highlightAccessorMethods, 'getAllHighlightedCellIndices'),
    false,
    'a page-membership reader that ignored disabled groups has been removed'
  );
  assert.deepEqual(
    Object.keys(highlightAccessorMethods).sort(),
    ['getCategoryForCell', 'getCellAtScreenPosition', 'getValueForCell']
  );
});
