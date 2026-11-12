/**
 * L24-15 (live pass 6, 2026-11-11): a newcomer asked where the germ cells
 * are; the agent highlighted them, then colored by NANOS3 and, reading its
 * screen picture, said "the bright cyan patches are the cells with high
 * NANOS3". The cyan was the highlight drawn over the gene's viridis. A
 * screen picture now says what it draws over the coloring.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createViewReads } from '../assets/js/app/reads/views.js';

function pngBytes(width, height) {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function screenReads({ page, cells }) {
  const glcanvas = { width: 1000, height: 500, getBoundingClientRect: () => ({ width: 1000, height: 500 }) };
  const documentRef = {
    getElementById: id => (id === 'glcanvas' ? glcanvas : null),
    createElement: () => {
      const out = { width: 0, height: 0 };
      out.getContext = () => ({ drawImage: () => {} });
      out.toBlob = done => done(new Blob([pngBytes(out.width, out.height)]));
      return out;
    },
  };
  const viewer = {
    getPresentedLayout: () => ({ panes: [{ viewId: 'live', visibleCssLeft: 0, visibleCssTop: 0, visibleCssWidth: 1000, visibleCssHeight: 500 }] }),
    getLiveViewLabel: () => 'NANOS3', getSnapshotViews: () => [], getLiveViewHidden: () => false, getViewName: () => null,
    getShowConnectivity: () => false, hasConnectivityData: () => false,
  };
  const state = {
    pointCount: 219731, getActiveViewId: () => 'live',
    getActivePage: () => page, getHighlightedCellCountForPage: () => cells,
  };
  return createViewReads({ state, viewer, documentRef, getFigureExport: () => null });
}

const previousFrame = globalThis.requestAnimationFrame;
test.before(() => { globalThis.requestAnimationFrame = callback => setTimeout(callback, 0); });
test.after(() => { globalThis.requestAnimationFrame = previousFrame; });

test('a screen picture says the highlighted cells are drawn in the highlight\'s color, not the coloring\'s', async () => {
  const reads = screenReads({ page: { id: 'p2', name: 'Germ cells' }, cells: 10993 });
  const out = await reads.picture({ source: 'screen', width: 800, height: 600, legend: false }, { signal: new AbortController().signal });
  assert.deepEqual(out.notes, ['The 10,993 cells highlighted on page "Germ cells" are drawn over the coloring in the highlight\'s color: their color there is the highlight\'s, not the coloring\'s.']);
  const one = await screenReads({ page: { id: 'p2', name: 'One' }, cells: 1 }).picture({ source: 'screen', width: 800, height: 600, legend: false }, {});
  assert.match(one.notes[0], /^The 1 cell highlighted on page "One" is drawn/);
});

test('a figure picture and an export picture say it too: the figure draws the highlight as the screen does', async () => {
  const figureExport = {
    renderFigure: async () => ({ blob: new Blob([pngBytes(700, 500)]), plot: { width: 600, height: 480 } }),
    renderExportPicture: async () => ({ blob: new Blob([pngBytes(700, 500)]), notes: [], plot: { width: 600, height: 480 }, asked: { width: 700 }, dpi: 300 }),
  };
  const state = { pointCount: 10, getActiveViewId: () => 'live', getActivePage: () => ({ id: 'p2', name: 'Germ cells' }), getHighlightedCellCountForPage: () => 7 };
  const viewer = { getLiveViewLabel: () => 'x', getSnapshotViews: () => [], getLiveViewHidden: () => false, getViewName: () => null, getShowConnectivity: () => false, hasConnectivityData: () => false };
  const documentRef = { getElementById: () => null, createElement: () => ({ getContext: () => ({ drawImage: () => {} }), toBlob: done => done(new Blob([pngBytes(1, 1)])) }) };
  const reads = createViewReads({ state, viewer, documentRef, getFigureExport: () => figureExport });
  const previousBitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => ({ width: 700, height: 500, close() {} });
  try {
    const figure = await reads.picture({ width: 640, height: 480, legend: true }, { signal: new AbortController().signal });
    assert.match(figure.notes.at(-1), /^The 7 cells highlighted on page "Germ cells" are drawn over the coloring/);
    const exported = await reads.picture({ source: 'export', width: 1000, height: 1000, legend: true }, { signal: new AbortController().signal });
    assert.match(exported.notes.at(-1), /^The 7 cells highlighted on page "Germ cells"/);
  } finally {
    globalThis.createImageBitmap = previousBitmap;
  }
});

test('nothing highlighted, nothing said', async () => {
  for (const reads of [screenReads({ page: { id: 'p1', name: 'Page 1' }, cells: 0 }), screenReads({ page: null, cells: 0 })]) {
    const out = await reads.picture({ source: 'screen', width: 800, height: 600, legend: false }, {});
    assert.deepEqual(out.notes, []);
  }
});
