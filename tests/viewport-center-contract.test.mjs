import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  applyHorizontalProjectionCenter,
  computeLeftOcclusionRatio,
} from '../assets/js/rendering/viewport-center.js';
import {
  getPresentedPane,
  getPresentedPaneAtCssPoint,
  resolvePresentedLayout,
} from '../assets/js/rendering/viewer/presented-view-layout.js';
import { placeSelectBar } from '../assets/js/app/ui/modules/select-bar-placement.js';

const VIEWER_URL = new URL(
  '../assets/js/rendering/viewer.js',
  import.meta.url,
);
const SIDEBAR_LAYOUT_URL = new URL(
  '../assets/js/app/ui/core/sidebar-layout.js',
  import.meta.url,
);
const SIDEBAR_CONTROLS_URL = new URL(
  '../assets/js/app/ui/modules/sidebar-controls.js',
  import.meta.url,
);

test('sidebar geometry publishes one device-independent canvas occlusion ratio', () => {
  assert.equal(
    computeLeftOcclusionRatio({
      canvasLeft: 0,
      canvasWidth: 1440,
      sidebarLeft: 10,
      sidebarWidth: 280,
      sidebarVisible: true,
    }),
    290 / 1440,
  );
  assert.equal(
    computeLeftOcclusionRatio({
      canvasLeft: 0,
      canvasWidth: 1440,
      sidebarLeft: 10,
      sidebarWidth: 280,
      sidebarVisible: false,
    }),
    0,
  );
  for (const sidebarWidth of [280, 420, 560]) {
    const ratio = computeLeftOcclusionRatio({
      canvasLeft: 0,
      canvasWidth: 1440,
      sidebarLeft: 10,
      sidebarWidth,
      sidebarVisible: true,
    });
    const projectedTargetX = ((ratio + 1) * 1440) / 2;
    assert.equal(projectedTargetX, (10 + sidebarWidth + 1440) / 2);
  }

  const cssRatio = computeLeftOcclusionRatio({
    canvasLeft: 24,
    canvasWidth: 1440,
    sidebarLeft: 34,
    sidebarWidth: 420,
    sidebarVisible: true,
  });
  const backingPixelRatio = computeLeftOcclusionRatio({
    canvasLeft: 48,
    canvasWidth: 2880,
    sidebarLeft: 68,
    sidebarWidth: 840,
    sidebarVisible: true,
  });
  assert.equal(cssRatio, backingPixelRatio);
});

function layoutFor(overrides = {}) {
  return resolvePresentedLayout({
    canvasHeight: 1800,
    canvasWidth: 2880,
    cssHeight: 900,
    cssWidth: 1440,
    focusedViewId: 'live',
    leftOcclusionRatio: 290 / 1440,
    mode: 'grid',
    viewIds: ['live', 'snap_1'],
    ...overrides,
  });
}

test('single view keeps the full canvas and centres its principal point on the presented area', () => {
  const layout = layoutFor({ mode: 'single' });
  assert.equal(layout.panes.length, 1);
  const pane = layout.panes[0];
  assert.equal(pane.viewId, 'live');
  assert.deepEqual(
    [pane.viewportX, pane.viewportY, pane.viewportWidth, pane.viewportHeight],
    [0, 0, 2880, 1800],
  );
  assert.equal(pane.scissorEnabled, false);
  assert.equal(pane.visibleCssLeft, 290);
  assert.equal(pane.visibleCssWidth, 1150);
  // The principal point lands on the presented area's centre.
  const principalX = ((pane.projectionCenterNdcX + 1) / 2) * pane.cssWidth;
  assert.ok(Math.abs(principalX - (290 + 1440) / 2) < 1e-9);
  assert.deepEqual(layout.presentedArea, {
    cssHeight: 900,
    cssLeft: 290,
    cssTop: 0,
    cssWidth: 1150,
  });

  const collapsed = layoutFor({ leftOcclusionRatio: 0, mode: 'single' });
  assert.equal(collapsed.panes[0].projectionCenterNdcX, 0);
  assert.equal(collapsed.panes[0].visibleCssLeft, 0);
});

test('grid cells are equal and lie entirely inside the presented area', () => {
  for (const viewCount of [2, 3, 4, 5, 6]) {
    for (const leftOcclusionRatio of [0, 290 / 1440, 0.25, 0.3125]) {
      const viewIds = Array.from({ length: viewCount }, (_, i) => `view_${i}`);
      const layout = layoutFor({
        focusedViewId: viewIds[0],
        leftOcclusionRatio,
        viewIds,
      });
      assert.equal(layout.panes.length, viewCount);
      const first = layout.panes[0];
      const presentedLeftPx = leftOcclusionRatio * 2880;
      for (const pane of layout.panes) {
        assert.equal(pane.viewportWidth, first.viewportWidth);
        assert.equal(pane.viewportHeight, first.viewportHeight);
        assert.ok(pane.viewportX >= presentedLeftPx - 1e-9);
        assert.ok(pane.viewportX + pane.viewportWidth <= 2880);
        assert.ok(pane.viewportY >= 0);
        assert.ok(pane.viewportY + pane.viewportHeight <= 1800);
        assert.equal(pane.projectionCenterNdcX, 0);
        assert.equal(pane.scissorEnabled, true);
        assert.equal(pane.visibleCssLeft, pane.cssLeft);
        assert.equal(pane.visibleCssWidth, pane.cssWidth);
        assert.ok(pane.cssLeft >= leftOcclusionRatio * 1440 - 1e-9);
      }
      // The grid fills the presented width to within one cell per column.
      const last = layout.panes[layout.cols - 1];
      assert.ok(
        2880 - (last.viewportX + last.viewportWidth) < layout.cols,
      );
    }
  }
});

test('pane hit testing follows the presented layout, not the full canvas', () => {
  const layout = layoutFor({
    viewIds: ['live', 'snap_1', 'snap_2', 'snap_3'],
  });
  for (const pane of layout.panes) {
    const hit = getPresentedPaneAtCssPoint(
      layout,
      pane.cssLeft + pane.cssWidth / 2,
      pane.cssTop + pane.cssHeight / 2,
    );
    assert.equal(hit, pane);
    assert.equal(getPresentedPane(layout, pane.viewId), pane);
  }
  // The full-canvas quarter point lies under the sidebar-aware left column,
  // not on the old full-canvas boundary.
  assert.equal(getPresentedPaneAtCssPoint(layout, 900, 200).viewId, 'snap_1');
  assert.equal(getPresentedPaneAtCssPoint(layout, 800, 200).viewId, 'live');
  // A press left of the first column snaps to it.
  assert.equal(getPresentedPaneAtCssPoint(layout, 100, 200).viewId, 'live');

  const three = layoutFor({
    viewIds: ['live', 'snap_1', 'snap_2', 'snap_3', 'snap_4'],
  });
  const emptySlot = three.panes[2];
  assert.equal(
    getPresentedPaneAtCssPoint(
      three,
      emptySlot.cssLeft + emptySlot.cssWidth / 2,
      emptySlot.cssTop + emptySlot.cssHeight * 1.5,
    ),
    null,
  );
  assert.throws(
    () => getPresentedPane(layoutFor({ mode: 'single' }), 'snap_1'),
    /not presented/i,
  );
});

test('presented layout respects a sidebar covering nearly the whole canvas', () => {
  const grid = layoutFor({ leftOcclusionRatio: 1 });
  for (const pane of grid.panes) {
    assert.ok(pane.viewportWidth >= 1);
    assert.ok(pane.viewportX + pane.viewportWidth <= 2880);
  }
  const single = layoutFor({ leftOcclusionRatio: 1, mode: 'single' });
  assert.ok(single.panes[0].projectionCenterNdcX < 1);
  assert.ok(single.panes[0].visibleCssWidth > 0);
});

test('the viewer resolves its layout only on geometry change and maps every pane through it', async () => {
  const source = await readFile(VIEWER_URL, 'utf8');
  assert.doesNotMatch(source, /cachedGridProjection/);
  assert.doesNotMatch(source, /computePaneCenterNdcX|getProjectionCenterNdcX/);
  assert.doesNotMatch(source, /Math\.ceil\(Math\.sqrt\(viewCount\)\)/);
  assert.match(source, /function getPresentedLayout\(\)/);
  assert.match(
    source,
    /presentedLayoutKey\.leftOcclusionRatio === viewportLeftOcclusionRatio/,
  );
  assert.match(source, /getPresentedPaneAtCssPoint\(layout, localX, localY\)/);
});

test('the sidebar keeps the open presented area until its slide animation ends', async () => {
  const source = await readFile(SIDEBAR_CONTROLS_URL, 'utf8');
  assert.match(source, /sidebar\.getAnimations\(\)\.length > 0/);
  assert.match(
    source,
    /\(!sidebar\.classList\.contains\('hidden'\) \|\| isSidebarTransitionRunning\(\)\)/,
  );
  assert.match(source, /requestAnimationFrame\(\s*awaitSidebarTransitionEnd\s*\)/);
  assert.match(source, /sidebar\.offsetWidth < occlusionGeometry\.canvasWidth/);
});

test('the selection bar is placed from the presented layout, not its own occlusion math', async () => {
  const properties = new Map();
  const bar = { style: { setProperty: (name, value) => properties.set(name, value) } };
  const layout = layoutFor();
  placeSelectBar(bar, layout);
  assert.deepEqual(Object.fromEntries(properties), {
    '--select-bar-presented-left': `${layout.presentedArea.cssLeft}px`,
    '--select-bar-presented-width': `${layout.presentedArea.cssWidth}px`,
  });
  assert.equal(layout.presentedArea.cssLeft, layout.panes[0].cssLeft);
  assert.throws(() => placeSelectBar(bar, 0.2), /presented layout/i);

  const sidebarLayout = await readFile(SIDEBAR_LAYOUT_URL, 'utf8');
  assert.match(
    sidebarLayout,
    /viewer\.onPresentedLayoutChange\(\s*layout => selectBarPlacement\.place\(layout\)/,
  );
  assert.match(
    sidebarLayout,
    /onViewportOcclusionChange: viewer\.setViewportLeftOcclusionRatio,/,
  );
});

test('the hidden sidebar is inert', async () => {
  const source = await readFile(SIDEBAR_CONTROLS_URL, 'utf8');
  assert.match(source, /sidebar\.inert = isHidden;/);
});
