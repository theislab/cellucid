/**
 * A highlight page's analysis cache identity is the *set* of its cell indices —
 * never its cardinality, and never a fixed-size sample of that set.
 *
 * Regression guard for CEL-AUDIT-0019: page versions used to be built from the
 * first five, last five, and (only when the count exceeded 100) a tenth-step
 * middle sample of the page's indices, and the cache key then discarded even
 * those samples down to `pageId@count`. Replacing almost every cell in a page
 * while keeping its cardinality therefore produced a byte-identical cache key,
 * and Correlation, Detailed Analysis, Quick Insights, Gene Signature, the
 * comparison module and the bulk-gene cache all served results computed over
 * the previous cell set.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DataLayer } from '../assets/js/app/analysis/data/data-layer.js';
import { createRestOfPageId } from '../assets/js/app/analysis/shared/page-derivation-utils.js';

const POINT_COUNT = 5000;

function makeLayer(pages, pointCount = POINT_COUNT) {
  return new DataLayer(
    {
      pointCount,
      getHighlightPages: () => pages,
      obsData: { fields: [] },
      varData: { fields: [] },
    },
    {
      enableNotifications: false,
      enablePrefetch: false,
      enableVersionTracking: true,
    },
  );
}

function singleGroupPages(cellIndices, { name = 'Page 1' } = {}) {
  return [{
    id: 'page_1',
    name,
    highlightedGroups: [{
      id: 'highlight_1',
      type: 'lasso',
      label: 'Group 1',
      enabled: true,
      cellIndices: [...cellIndices],
      cellCount: cellIndices.length,
    }],
  }];
}

function keysFor(layer, pageIds = ['page_1']) {
  return {
    hash: layer._computePageHash(pageIds[0]),
    version: layer._getPageVersion(pageIds[0]),
    dataKey: layer._getCacheKey({
      type: 'gene_expression',
      variableKey: 'BRCA1',
      pageIds,
    }),
    bulkKey: layer._getBulkGeneCacheKey(pageIds),
  };
}

/**
 * Swap `replacedCount` cells out of a page while preserving:
 * - the cell count,
 * - the five lowest and five highest indices (the old first/last sample),
 * - every index the old tenth-step middle sample would have read.
 *
 * Any version derived from a bounded sample of the set is blind to this edit;
 * only a version derived from the whole set can see it.
 */
function replacePreservingOldSamples(cellIndices, replacedCount, freshBase) {
  const sorted = [...cellIndices].sort((a, b) => a - b);
  const count = sorted.length;
  const preserved = new Set();
  for (let i = 0; i < Math.min(5, count); i++) {
    preserved.add(i);
    preserved.add(count - 1 - i);
  }
  if (count > 100) {
    const step = Math.floor(count / 10);
    for (let i = step; i < count - step; i += step) preserved.add(i);
  }

  const next = [...sorted];
  let replaced = 0;
  for (let i = 0; i < count && replaced < replacedCount; i++) {
    if (preserved.has(i)) continue;
    next[i] = freshBase + replaced;
    replaced += 1;
  }
  assert.equal(
    replaced,
    replacedCount,
    'test fixture must be able to replace the requested number of cells',
  );
  return { next, replaced };
}

test('a 100-cell page whose membership is replaced gets a different cache identity', t => {
  // Sorted set: 5 low cells, 90 middle cells, 5 high cells. Count is 100, so
  // the old hash took no middle sample at all (`count > 100` was false).
  const low = [0, 1, 2, 3, 4];
  const high = [900, 901, 902, 903, 904];
  const middleBefore = Array.from({ length: 90 }, (_value, i) => 100 + i);
  const middleAfter = Array.from({ length: 90 }, (_value, i) => 300 + i);

  const pages = singleGroupPages([...low, ...middleBefore, ...high]);
  const layer = makeLayer(pages);
  t.after(() => layer.destroy());

  const before = keysFor(layer);
  layer.refreshPageVersions(['page_1']);

  pages[0].highlightedGroups[0].cellIndices = [...low, ...middleAfter, ...high];
  layer.refreshPageVersions(['page_1']);
  const after = keysFor(layer);

  assert.equal(
    layer.getCellIndicesForPage('page_1').length,
    100,
    'the scenario must keep the cell count unchanged',
  );
  assert.notEqual(
    before.hash,
    after.hash,
    'replacing 90 of 100 cells must change the page version hash',
  );
  assert.notEqual(
    before.dataKey,
    after.dataKey,
    'replacing 90 of 100 cells must change the analysis data cache key',
  );
  assert.notEqual(
    before.bulkKey,
    after.bulkKey,
    'replacing 90 of 100 cells must change the bulk-gene cache key',
  );
});

test('a 1000-cell page keeps a distinct cache identity when 297 cells are swapped', t => {
  const original = Array.from({ length: 1000 }, (_value, i) => i);
  const pages = singleGroupPages(original);
  const layer = makeLayer(pages);
  t.after(() => layer.destroy());

  const before = keysFor(layer);
  layer.refreshPageVersions(['page_1']);

  const { next, replaced } = replacePreservingOldSamples(original, 297, 4000);
  assert.equal(replaced, 297);
  pages[0].highlightedGroups[0].cellIndices = next;
  layer.refreshPageVersions(['page_1']);
  const after = keysFor(layer);

  assert.equal(layer.getCellIndicesForPage('page_1').length, 1000);
  assert.notEqual(before.hash, after.hash);
  assert.notEqual(before.dataKey, after.dataKey);
  assert.notEqual(before.bulkKey, after.bulkKey);
});

test('a single swapped cell changes the page cache identity', t => {
  const original = Array.from({ length: 400 }, (_value, i) => i);
  const pages = singleGroupPages(original);
  const layer = makeLayer(pages);
  t.after(() => layer.destroy());

  const before = keysFor(layer);
  layer.refreshPageVersions(['page_1']);

  // Index 137 is neither in the first/last five nor on the old tenth-step grid.
  const next = [...original];
  next[137] = 3000;
  pages[0].highlightedGroups[0].cellIndices = next;
  layer.refreshPageVersions(['page_1']);
  const after = keysFor(layer);

  assert.equal(layer.getCellIndicesForPage('page_1').length, 400);
  assert.notEqual(before.hash, after.hash);
  assert.notEqual(before.dataKey, after.dataKey);
  assert.notEqual(before.bulkKey, after.bulkKey);
});

test('disabling one group and enabling a disjoint group of equal size changes the cache identity', t => {
  const pages = [{
    id: 'page_1',
    name: 'Page 1',
    highlightedGroups: [
      { id: 'highlight_1', enabled: true, cellIndices: [1, 2, 3], cellCount: 3 },
      { id: 'highlight_2', enabled: false, cellIndices: [7, 8, 9], cellCount: 3 },
    ],
  }];
  const layer = makeLayer(pages);
  t.after(() => layer.destroy());

  const before = keysFor(layer);
  layer.refreshPageVersions(['page_1']);

  pages[0].highlightedGroups[0].enabled = false;
  pages[0].highlightedGroups[1].enabled = true;
  layer.refreshPageVersions(['page_1']);
  const after = keysFor(layer);

  assert.deepEqual(layer.getCellIndicesForPage('page_1'), [7, 8, 9]);
  assert.notEqual(before.hash, after.hash);
  assert.notEqual(before.dataKey, after.dataKey);
  assert.notEqual(before.bulkKey, after.bulkKey);
});

test('a derived "rest of" page tracks its base page membership, not just its size', t => {
  const pages = singleGroupPages([0, 1, 2]);
  const layer = makeLayer(pages, 1000);
  t.after(() => layer.destroy());

  const restOfId = createRestOfPageId('page_1');
  const before = layer._getPageVersion(restOfId);
  const beforeKey = layer._getCacheKey({
    type: 'gene_expression',
    variableKey: 'BRCA1',
    pageIds: [restOfId],
  });

  pages[0].highlightedGroups[0].cellIndices = [500, 501, 502];
  layer.refreshPageVersions(['page_1']);

  const after = layer._getPageVersion(restOfId);
  const afterKey = layer._getCacheKey({
    type: 'gene_expression',
    variableKey: 'BRCA1',
    pageIds: [restOfId],
  });

  assert.notEqual(
    before,
    after,
    'a "rest of" page is the complement of its base page, so a base membership '
    + 'change must change its version even when its size is unchanged',
  );
  assert.notEqual(beforeKey, afterKey);
});

test('renaming a page changes its cache identity because results carry the page name', t => {
  const pages = singleGroupPages([1, 2, 3], { name: 'Before' });
  const layer = makeLayer(pages);
  t.after(() => layer.destroy());

  const before = keysFor(layer);
  layer.refreshPageVersions(['page_1']);

  pages[0].name = 'After';
  layer.refreshPageVersions(['page_1']);
  const after = keysFor(layer);

  assert.notEqual(before.hash, after.hash);
  assert.notEqual(before.dataKey, after.dataKey);
  assert.notEqual(before.bulkKey, after.bulkKey);
});

test('page versions are stable when membership is unchanged', t => {
  const cells = Array.from({ length: 250 }, (_value, i) => i * 3);
  const pages = singleGroupPages(cells);
  const layer = makeLayer(pages);
  t.after(() => layer.destroy());

  const first = keysFor(layer);
  layer.refreshPageVersions(['page_1']);

  // Same set, expressed as two overlapping groups in a different order.
  pages[0].highlightedGroups = [
    { id: 'highlight_2', enabled: true, cellIndices: [...cells].reverse(), cellCount: cells.length },
    { id: 'highlight_3', enabled: true, cellIndices: [...cells], cellCount: cells.length },
  ];
  layer.refreshPageVersions(['page_1']);
  const second = keysFor(layer);

  assert.equal(
    first.hash,
    second.hash,
    'the version is a function of the cell set, so re-expressing the same set '
    + 'must not invalidate a still-valid cached result',
  );
  assert.equal(first.dataKey, second.dataKey);
  assert.equal(first.bulkKey, second.bulkKey);
});

test('page version components stay free of the cache key separators', t => {
  const pages = singleGroupPages([1, 2, 3], { name: 'weird: name, with | separators' });
  const layer = makeLayer(pages);
  t.after(() => layer.destroy());

  const dataKey = layer._getCacheKey({
    type: 'gene_expression',
    variableKey: 'BRCA1',
    pageIds: ['page_1'],
  });
  const bulkKey = layer._getBulkGeneCacheKey(['page_1']);

  for (const [label, key] of [['data', dataKey], ['bulk gene', bulkKey]]) {
    const parts = key.split(':');
    assert.equal(
      parts.at(-1).startsWith('v='),
      true,
      `${label} cache key must end with its version component`,
    );
    assert.match(
      parts.at(-1),
      /^v=page_1@[0-9a-f]{32}$/,
      `${label} cache key version must be an opaque hex digest`,
    );
  }
});

test('invalidatePages evicts both versioned cache families for a changed page', t => {
  const pages = singleGroupPages([1, 2, 3]);
  const layer = makeLayer(pages);
  t.after(() => layer.destroy());

  const dataKey = layer._getCacheKey({
    type: 'gene_expression',
    variableKey: 'BRCA1',
    pageIds: ['page_1'],
  });
  const bulkKey = layer._getBulkGeneCacheKey(['page_1']);

  layer._dataCache.set(dataKey, ['stale']);
  layer._setBulkGeneCache(bulkKey, { data: {}, timestamp: Date.now(), geneCount: 0 });

  layer.invalidatePages(['page_1']);

  assert.equal(layer._dataCache.has(dataKey), false, 'versioned data key must be evicted');
  assert.equal(layer._bulkGeneCache.has(bulkKey), false, 'versioned bulk key must be evicted');
});

test('bulk-gene results are not served for a page whose membership changed', async t => {
  const pages = singleGroupPages([1, 2, 3]);
  const layer = makeLayer(pages);
  t.after(() => layer.destroy());

  const staleKey = layer._getBulkGeneCacheKey(['page_1']);
  layer._setBulkGeneCache(staleKey, {
    data: {
      BRCA1: {
        page_1: {
          pageId: 'page_1',
          pageName: 'Page 1',
          values: Float32Array.from([1, 2, 3]),
          cellIndices: Uint32Array.from([1, 2, 3]),
          cellCount: 3,
        },
      },
    },
    timestamp: Date.now(),
    geneCount: 1,
  });

  // Same cardinality, entirely different cells.
  pages[0].highlightedGroups[0].cellIndices = [400, 500, 600];

  const fetched = [];
  layer.fetchBulkGeneExpression = async options => {
    fetched.push(options);
    return {};
  };

  await layer.getGeneExpressionSubset(['BRCA1'], ['page_1']);

  assert.equal(
    fetched.length,
    1,
    'the stale-membership bulk entry must not be served; a fresh fetch is required',
  );
});
