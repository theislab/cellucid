/**
 * Resizing a floating window or the expanded view
 * (`app/dockable-accordions/geometry.js`): which edges move, the limits that
 * stop them, the lines they snap to, what an arrow key stands for, and where
 * a maximized window goes. There is no fabricated size cap: the limits are
 * the content's least size and the viewport.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FLOATING_MARGIN,
  RESIZE_EDGES,
  floatingSnapTargets,
  keyboardResizeTravel,
  maximizedFloatingRect,
  resizeFloatingRect
} from '../assets/js/app/dockable-accordions/geometry.js';

const VIEWPORT = { viewportWidth: 1440, viewportHeight: 900 };
const START = { left: 400, top: 100, width: 320, height: 400 };
const LIMITS = { minWidth: 220, minHeight: 120 };

function resize(edge, dx, dy, extra = {}) {
  return resizeFloatingRect({ start: START, edge, dx, dy, ...LIMITS, ...VIEWPORT, ...extra });
}

test('eight handles: each moves only its own edges', () => {
  assert.deepEqual([...RESIZE_EDGES].sort(), ['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w']);
  assert.deepEqual(resize('e', 50, 30).rect, { left: 400, top: 100, width: 370, height: 400 });
  assert.deepEqual(resize('s', 50, 30).rect, { left: 400, top: 100, width: 320, height: 430 });
  assert.deepEqual(resize('w', -50, 30).rect, { left: 350, top: 100, width: 370, height: 400 });
  assert.deepEqual(resize('n', 50, -30).rect, { left: 400, top: 70, width: 320, height: 430 });
  assert.deepEqual(resize('se', 10, 20).rect, { left: 400, top: 100, width: 330, height: 420 });
  assert.deepEqual(resize('nw', -10, -20).rect, { left: 390, top: 80, width: 330, height: 420 });
  assert.deepEqual(resize('ne', 10, -20).rect, { left: 400, top: 80, width: 330, height: 420 });
  assert.deepEqual(resize('sw', -10, 20).rect, { left: 390, top: 100, width: 330, height: 420 });
  assert.throws(() => resize('middle', 0, 0), /Unknown resize edge/);
});

test('an edge stops at the least size without moving the opposite edge', () => {
  assert.deepEqual(resize('e', -1000, 0).rect, { left: 400, top: 100, width: 220, height: 400 });
  // The left edge stops where the width reaches its minimum: the right edge
  // stays at 720.
  assert.deepEqual(resize('w', 1000, 0).rect, { left: 500, top: 100, width: 220, height: 400 });
  assert.deepEqual(resize('n', 0, 1000).rect, { left: 400, top: 380, width: 320, height: 120 });
});

test('the only greatest size is the viewport less its margin (no 500 px cap)', () => {
  const tall = resize('s', 0, 5000).rect;
  assert.equal(tall.top + tall.height, VIEWPORT.viewportHeight - FLOATING_MARGIN);
  assert.ok(tall.height > 500, 'a window grows past 500 px');
  const wide = resize('e', 5000, 0).rect;
  assert.equal(wide.left + wide.width, VIEWPORT.viewportWidth - FLOATING_MARGIN);
  const up = resize('nw', -5000, -5000).rect;
  assert.equal(up.left, FLOATING_MARGIN);
  assert.equal(up.top, FLOATING_MARGIN);
});

test('a moving edge snaps to the nearest line within the distance, and names it', () => {
  const snap = { xs: [760], ys: [], widths: [], heights: [], distance: 12 };
  // 400 + 320 + 31 = 751, 9 px from 760.
  const near = resize('e', 31, 0, { snap });
  assert.equal(near.rect.width, 360);
  assert.deepEqual(near.guides, { x: 760, y: null });
  // 400 + 320 + 20 = 740, 20 px away: no snap.
  const far = resize('e', 20, 0, { snap });
  assert.equal(far.rect.width, 340);
  assert.deepEqual(far.guides, { x: null, y: null });
  // A snap size is measured from the fixed edge: the sidebar's width.
  const sized = resize('w', -15, 0, { snap: { widths: [330], distance: 12 } });
  assert.equal(sized.rect.width, 330);
  assert.equal(sized.guides.x, 390);
  // The content's height, from the top edge.
  const content = resize('s', 0, 95, { snap: { heights: [500], distance: 12 } });
  assert.equal(content.rect.height, 500);
  // A line past the least size is never snapped to.
  const tooSmall = resize('e', -95, 0, { snap: { xs: [600], distance: 12 } });
  assert.equal(tooSmall.rect.width, 225);
});

test('snap lines: viewport, sidebar, the middle of the free area and other windows', () => {
  const targets = floatingSnapTargets({
    ...VIEWPORT,
    sidebarRight: 320,
    sidebarWidth: 320,
    others: [{ left: 900, top: 50, right: 1200, bottom: 600 }],
    contentHeight: 640,
    distance: 20
  });
  assert.ok(targets.xs.includes(FLOATING_MARGIN));
  assert.ok(targets.xs.includes(1432));
  assert.ok(targets.xs.includes(328), 'beside the sidebar');
  assert.ok(targets.xs.includes((328 + 1432) / 2), 'half the free area');
  assert.ok(targets.xs.includes(900) && targets.xs.includes(1200));
  assert.ok(targets.ys.includes(50) && targets.ys.includes(600) && targets.ys.includes(892));
  assert.deepEqual(targets.widths, [320]);
  assert.deepEqual(targets.heights, [640]);
  assert.equal(targets.distance, 20);
  const hidden = floatingSnapTargets({
    ...VIEWPORT, sidebarRight: 0, sidebarWidth: 0, others: [], contentHeight: 0, distance: 12
  });
  assert.deepEqual(hidden.widths, []);
  assert.deepEqual(hidden.heights, []);
});

test('arrow keys move a handle in their own direction; Home and End go to the limits', () => {
  const step = 16;
  assert.deepEqual(keyboardResizeTravel('e', 'ArrowRight', step, VIEWPORT), { dx: 16, dy: 0 });
  assert.deepEqual(keyboardResizeTravel('w', 'ArrowLeft', step, VIEWPORT), { dx: -16, dy: 0 });
  assert.equal(keyboardResizeTravel('e', 'ArrowUp', step, VIEWPORT), null, 'a side edge has no vertical keys');
  assert.equal(keyboardResizeTravel('n', 'ArrowLeft', step, VIEWPORT), null);
  assert.deepEqual(keyboardResizeTravel('se', 'ArrowDown', step, VIEWPORT), { dx: 0, dy: 16 });
  assert.equal(keyboardResizeTravel('se', 'Enter', step, VIEWPORT), null);
  const home = resizeFloatingRect({
    start: START, edge: 'se', ...keyboardResizeTravel('se', 'Home', step, VIEWPORT), ...LIMITS, ...VIEWPORT
  }).rect;
  assert.deepEqual([home.width, home.height], [220, 120]);
  const end = resizeFloatingRect({
    start: START, edge: 'w', ...keyboardResizeTravel('w', 'End', step, VIEWPORT), ...LIMITS, ...VIEWPORT
  }).rect;
  assert.equal(end.left, FLOATING_MARGIN);
  assert.equal(end.left + end.width, 720);
});

test('a maximized window fills the free area beside the sidebar, else the viewport', () => {
  assert.deepEqual(
    maximizedFloatingRect({ sidebarRight: 320, minWidth: 220, ...VIEWPORT }),
    { left: 328, top: 8, width: 1104, height: 884 }
  );
  assert.deepEqual(
    maximizedFloatingRect({ sidebarRight: 0, minWidth: 220, ...VIEWPORT }),
    { left: 8, top: 8, width: 1424, height: 884 }
  );
  // Too little room beside the sidebar: the whole viewport.
  assert.deepEqual(
    maximizedFloatingRect({ sidebarRight: 320, minWidth: 220, viewportWidth: 500, viewportHeight: 600 }),
    { left: 8, top: 8, width: 484, height: 584 }
  );
});
