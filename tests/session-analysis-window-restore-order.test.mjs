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
import * as highlightsMeta from '../assets/js/app/session/contributors/highlights-meta.js';

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
  return {
    exportSessionWindows: () => opened.map(entry => entry.descriptor),
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

const WINDOW = {
  modeId: 'differential',
  rect: { left: 10, top: 10, width: 400, height: 300 },
  settings: { selectedPages: ['page_1', 'page_2'] },
  headerTitle: 'Differential expression',
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
  await analysisWindows.restore(ctx, { id: 'analysis/windows' }, { windows: [WINDOW] });
  await highlightsMeta.restore(ctx, { id: 'highlights/meta' }, HIGHLIGHTS);
  await ctx.restoreTransaction.commit();

  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].pageIds, ['page_1', 'page_2']);
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
  await analysisWindows.restore(ctx, { id: 'analysis/windows' }, { windows: [missingPageWindow] });
  await highlightsMeta.restore(ctx, { id: 'highlights/meta' }, HIGHLIGHTS);
  await assert.rejects(ctx.restoreTransaction.commit(), /page "page_9" was not found/);

  assert.equal(state.highlightPages, previousPages);
  assert.deepEqual(opened.map(entry => entry.descriptor), [previousWindow]);
});
