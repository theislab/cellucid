/**
 * L18-1 (live pass 5): an agent asked "show me where the cells are heading"
 * turned the vector field overlay on, tuned it blind ("pictures leave the
 * overlay out, so I can't see the streaks myself") and left a flow blown to
 * white. `view.picture` drew only what the figure export draws. It now takes
 * `source: 'screen'`, the view's pane as the screen shows it (the overlay
 * included), and a figure picture taken while an overlay is on says so.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createViewReads } from '../assets/js/app/reads/views.js';
import { getActionCatalog } from '../assets/js/app/actions/index.js';

// A PNG header saying 640 × 457 (`pngSidesOf` reads the IHDR width and height).
function pngBytes(width, height) {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function setUp({ overlayOn = true, panes = [{ viewId: 'live', visibleCssLeft: 300, visibleCssTop: 0, visibleCssWidth: 700, visibleCssHeight: 500 }] } = {}) {
  const drawn = [];
  const glcanvas = { width: 2000, height: 1000, getBoundingClientRect: () => ({ width: 1000, height: 500 }) };
  const overlay = { checked: overlayOn };
  const field = { value: 'velocity' };
  const documentRef = {
    getElementById: id => ({ glcanvas, 'velocity-overlay-enabled': overlay, 'velocity-field': field })[id] ?? null,
    createElement: () => {
      const out = { width: 0, height: 0 };
      out.getContext = () => ({ drawImage: (...args) => drawn.push(args) });
      out.toBlob = (done, type) => {
        assert.equal(type, 'image/png');
        done(new Blob([pngBytes(out.width, out.height)]));
      };
      return out;
    },
  };
  const viewer = {
    getPresentedLayout: () => ({ panes }),
    getLiveViewLabel: () => 'cell_type',
    getSnapshotViews: () => [],
    getLiveViewHidden: () => false,
    getViewName: () => null,
    getShowConnectivity: () => false,
    hasConnectivityData: () => false,
  };
  const state = { pointCount: 3696, getActiveViewId: () => 'live' };
  let figureCalls = 0;
  const getFigureExport = () => ({
    renderFigure: async () => {
      figureCalls++;
      return { blob: new Blob([pngBytes(700, 500)]), plot: { width: 600, height: 480 } };
    },
  });
  const reads = createViewReads({ state, viewer, documentRef, getFigureExport });
  return { reads, drawn, glcanvas, figureCalls: () => figureCalls };
}

const previousFrame = globalThis.requestAnimationFrame;
test.before(() => { globalThis.requestAnimationFrame = callback => setTimeout(callback, 0); });
test.after(() => { globalThis.requestAnimationFrame = previousFrame; });

test('source "screen" is the view\'s pane of the canvas after a frame, fitted into the box asked for', async () => {
  const { reads, drawn, glcanvas, figureCalls } = setUp();
  const out = await reads.picture({ source: 'screen', width: 640, height: 480, legend: false }, { signal: new AbortController().signal });
  // The pane right of the sidebar (CSS 300..1000 of 1000) on a canvas of two pixels per CSS pixel.
  assert.deepEqual(drawn, [[glcanvas, 600, 0, 1400, 1000, 0, 0, 640, 457]]);
  assert.equal(out.width, 640);
  assert.equal(out.height, 457);
  assert.deepEqual(out.plot, { width: 640, height: 457 });
  assert.equal(out.view, 'View 1');
  assert.deepEqual(out.notes, []);
  assert.equal(figureCalls(), 0);
  assert.equal(typeof out.png, 'string');
});

test('a view not on screen is refused with what to do', async () => {
  const hidden = setUp({ panes: [] });
  await assert.rejects(
    hidden.reads.picture({ source: 'screen', width: 640, height: 480, legend: false }, {}),
    /not on the screen now.*source "figure"/,
  );
});

test('a figure picture taken while the flow is shown says it is drawn as arrows, and how to see the particles (R9V-10)', async () => {
  const { reads, figureCalls } = setUp({ overlayOn: true });
  const out = await reads.picture({ width: 640, height: 480, legend: true }, {});
  assert.equal(figureCalls(), 1);
  assert.doesNotMatch(out.notes.join('\n'), /not exported/);
  assert.match(out.notes.join('\n'), /The vector field velocity is drawn as arrows on a grid.*source "screen" shows its moving particles/);
  const off = setUp({ overlayOn: false });
  const plain = await off.reads.picture({ width: 640, height: 480, legend: true }, {});
  assert.doesNotMatch(plain.notes.join('\n'), /source "screen"/);
});

test('the catalog offers the screen picture', () => {
  const action = getActionCatalog().get('view.picture');
  assert.deepEqual(action.params.properties.source.enum, ['figure', 'screen', 'export']);
  assert.equal(action.params.properties.source.default, 'figure');
});
