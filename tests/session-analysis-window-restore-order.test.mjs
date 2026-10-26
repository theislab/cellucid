/**
 * Floating analysis windows are a view of restored state: their settings name
 * highlight pages, and opening one validates those pages against the live
 * page inventory. The highlight contributor stages pages and publishes them
 * only when the restore transaction commits, so windows have to be reopened
 * after that publication, not while their own (earlier) chunk is applied.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionRestoreTransaction } from '../assets/js/app/session/session-context.js';
import * as analysisWindows from '../assets/js/app/session/contributors/analysis-windows.js';
import * as analysisDocked from '../assets/js/app/session/contributors/analysis-docked.js';
import * as highlightsMeta from '../assets/js/app/session/contributors/highlights-meta.js';
import { encodeTypedJson } from '../assets/js/app/session/codecs/typed-json.js';

function createState() {
  return {
    pointCount: 10,
    highlightPages: [{ id: 'page_1', name: 'Page 1', color: '#ff0000', highlightedGroups: [] }],
    activePageId: 'page_1',
    _highlightPageIdCounter: 1,
    _highlightIdCounter: 0,
    obsData: { fields: [] },
    varData: { fields: [] },
    getHighlightPages() {
      return this.highlightPages;
    },
    _recomputeHighlightArray() {},
    _notifyHighlightPageChange() {},
    _notifyHighlightChange() {},
  };
}

function createManager(state, opened) {
  let sizes = NO_SIZES;
  return {
    exportSessionWindows: () => opened.map(entry => entry.descriptor),
    exportViewSizes: () => sizes,
    importViewSizes(next) {
      sizes = next;
    },
    async closeAll() {
      opened.length = 0;
    },
    async createFromSessionDescriptor(descriptor) {
      const pageIds = state.getHighlightPages().map(page => page.id);
      for (const pageId of descriptor.settings.selectedPages) {
        if (!pageIds.includes(pageId)) {
          throw new RangeError(`page "${pageId}" was not found`);
        }
      }
      opened.push({ descriptor, pageIds });
    },
  };
}

const NO_SIZES = { window: {}, expandedView: {} };

const WINDOW = {
  modeId: 'differential',
  open: true,
  rect: { left: 10, top: 10, width: 400, height: 300 },
  z: 91,
  settings: { selectedPages: ['page_1', 'page_2'] },
  headerTitle: 'Differential expression',
  // A result's numeric columns travel as their bytes (typed JSON).
  result: { genes: ['CD3E', 'MS4A1'], log2FoldChange: Float32Array.from([1.5, -2.25]) },
};

const HIGHLIGHTS = {
  pages: [
    { id: 'page_1', name: 'A', color: '#ff0000', highlightedGroups: [] },
    { id: 'page_2', name: 'B', color: '#00ff00', highlightedGroups: [] },
  ],
  activePageId: 'page_2',
};

test('analysis windows reopen against the restored highlight pages', async () => {
  const state = createState();
  const opened = [];
  const ctx = {
    state,
    analysisWindowManager: createManager(state, opened),
    restoreTransaction: createSessionRestoreTransaction(),
  };

  // Chunk order of a saved bundle: analysis/windows precedes highlights/meta.
  await analysisWindows.restore(ctx, { id: 'analysis/windows' }, encodeTypedJson({ windows: [WINDOW], sizes: NO_SIZES }));
  await highlightsMeta.restore(ctx, { id: 'highlights/meta' }, HIGHLIGHTS);
  await ctx.restoreTransaction.commit();

  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].pageIds, ['page_1', 'page_2']);
  assert.ok(opened[0].descriptor.result.log2FoldChange instanceof Float32Array);
  assert.deepEqual([...opened[0].descriptor.result.log2FoldChange], [1.5, -2.25]);
  assert.deepEqual(state.getHighlightPages().map(page => page.id), ['page_1', 'page_2']);
});

test('a failed window reopen rolls the restored pages and windows back', async () => {
  const state = createState();
  const previousPages = state.highlightPages;
  const opened = [];
  const previousWindow = { ...WINDOW, settings: { selectedPages: ['page_1'] } };
  const manager = createManager(state, opened);
  await manager.createFromSessionDescriptor(previousWindow);
  const ctx = {
    state,
    analysisWindowManager: manager,
    restoreTransaction: createSessionRestoreTransaction(),
  };

  const missingPageWindow = { ...WINDOW, settings: { selectedPages: ['page_9'] } };
  await analysisWindows.restore(ctx, { id: 'analysis/windows' }, encodeTypedJson({ windows: [missingPageWindow], sizes: NO_SIZES }));
  await highlightsMeta.restore(ctx, { id: 'highlights/meta' }, HIGHLIGHTS);
  await assert.rejects(ctx.restoreTransaction.commit(), /page "page_9" was not found/);

  assert.equal(state.highlightPages, previousPages);
  assert.deepEqual(opened.map(entry => entry.descriptor), [previousWindow]);
});

test('the docked analysis panel round-trips its open mode, settings and typed result, and rolls back', async () => {
  const saved = {
    openMode: 'differential',
    modes: {
      differential: {
        settings: { selectedPages: ['page_1', 'page_2'] },
        result: { genes: ['CD3E'], pValue: Float64Array.from([1e-12]) },
      },
      simple: { settings: { selectedPages: ['page_1'] }, result: null },
    },
  };
  let current = { openMode: null, modes: {} };
  const imported = [];
  const comparisonModule = {
    exportSessionState: () => structuredClone(current),
    async importSessionState(state) {
      imported.push(state);
      current = structuredClone(state);
    },
  };
  const [chunk] = analysisDocked.capture({ comparisonModule: { exportSessionState: () => saved } });
  assert.equal(chunk.kind, 'binary');
  assert.ok(chunk.payload instanceof Uint8Array);

  const ctx = { comparisonModule, restoreTransaction: createSessionRestoreTransaction() };
  await analysisDocked.restore(ctx, { id: 'analysis/docked' }, chunk.payload);
  assert.deepEqual(imported, [], 'the panel is restored at commit, after the pages it names');
  await ctx.restoreTransaction.commit();
  assert.equal(imported.length, 1);
  assert.deepEqual(imported[0], saved);
  assert.ok(imported[0].modes.differential.result.pValue instanceof Float64Array);

  // A later commit failure puts the panel back as the restore found it.
  const before = structuredClone(current);
  const failing = { comparisonModule, restoreTransaction: createSessionRestoreTransaction() };
  await analysisDocked.restore(failing, { id: 'analysis/docked' }, encodeTypedJson({
    openMode: null,
    modes: { simple: { settings: { selectedPages: [] }, result: null } },
  }));
  failing.restoreTransaction.register('test/late-failure', {
    value: null,
    stage: 'presentation',
    prepare() {},
    commit() {
      throw new Error('late presentation failure');
    },
    rollback() {},
  });
  await assert.rejects(failing.restoreTransaction.commit(), /late presentation failure/);
  assert.deepEqual(current, before);

  // An open mode with no record of its own is refused before anything runs.
  await assert.rejects(
    async () => analysisDocked.restore(
      { comparisonModule, restoreTransaction: createSessionRestoreTransaction() },
      { id: 'analysis/docked' },
      encodeTypedJson({ openMode: 'signature', modes: {} }),
    ),
    /open mode "signature" has no record/,
  );
});
