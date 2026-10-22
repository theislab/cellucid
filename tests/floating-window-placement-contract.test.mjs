/**
 * A window the user opens never covers the header of a window already open
 * (dockable-accordions/geometry.js `clearOfOpenHeaders`): the header holds
 * the older window's dock, copy and close buttons.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampFloatingPosition,
  clearOfOpenHeaders
} from '../assets/js/app/dockable-accordions/geometry.js';

const VIEWPORT = { viewportWidth: 1440, viewportHeight: 900 };
const header = (left, top, width = 300, height = 28) => ({
  left, top, right: left + width, bottom: top + height
});

test('a free spot is kept as asked', () => {
  assert.deepEqual(
    clearOfOpenHeaders({
      left: 400, top: 100, width: 300, height: 400, minHeight: 100, ...VIEWPORT,
      headers: [header(800, 100)], step: 28
    }),
    { x: 400, y: 100, height: 400 }
  );
});

test('a window opened on another one steps down until that header shows', () => {
  const placed = clearOfOpenHeaders({
    left: 400, top: 100, width: 300, height: 400, minHeight: 100, ...VIEWPORT,
    headers: [header(400, 100)], step: 28
  });
  assert.deepEqual(placed, { x: 428, y: 128, height: 400 });
  const covered = header(400, 100);
  assert.ok(placed.y >= covered.bottom, 'the older header stays above the new window');
});

test('stacked windows cascade past every header in turn', () => {
  const placed = clearOfOpenHeaders({
    left: 400, top: 100, width: 300, height: 400, minHeight: 100, ...VIEWPORT,
    headers: [header(400, 100), header(428, 128)], step: 28
  });
  assert.deepEqual(placed, { x: 456, y: 156, height: 400 });
});

test('on a short screen the window starts under the header and gets shorter', () => {
  // A phone on its side: the new window steps right to the edge but cannot
  // step past the header, so it starts below it and shrinks to the room left.
  const short = { viewportWidth: 844, viewportHeight: 390 };
  const placed = clearOfOpenHeaders({
    left: 8, top: 8, width: 600, height: 374, minHeight: 100, ...short,
    headers: [header(8, 8, 600, 36)], step: 36
  });
  assert.deepEqual(placed, { x: 236, y: 52, height: 330 });
});

test('a window that cannot fit under the header keeps its place and size', () => {
  const tiny = { viewportWidth: 390, viewportHeight: 150 };
  const box = { width: 374, height: 134, minHeight: 100, ...tiny };
  const corner = clampFloatingPosition({ left: 0, top: 0, ...box });
  const placed = clearOfOpenHeaders({
    left: 0, top: 0, ...box,
    headers: [header(8, 8, 374, 36)], step: 36
  });
  assert.deepEqual(placed, { ...corner, height: 134 });
});

test('placement requires its inputs', () => {
  assert.throws(
    () => clearOfOpenHeaders({ left: 0, top: 0, width: 1, height: 1, minHeight: 1, ...VIEWPORT, headers: null, step: 28 }),
    TypeError
  );
  assert.throws(
    () => clearOfOpenHeaders({ left: 0, top: 0, width: 1, height: 1, minHeight: 1, ...VIEWPORT, headers: [], step: 0 }),
    TypeError
  );
  assert.throws(
    () => clearOfOpenHeaders({ left: 0, top: 0, width: 1, height: 1, minHeight: -1, ...VIEWPORT, headers: [], step: 28 }),
    TypeError
  );
  // A window with no minimum of its own still keeps one header of height.
  assert.deepEqual(
    clearOfOpenHeaders({ left: 8, top: 8, width: 300, height: 200, minHeight: 0, viewportWidth: 316, viewportHeight: 216, headers: [header(8, 8, 300, 28)], step: 28 }),
    { x: 8, y: 44, height: 164 }
  );
});
