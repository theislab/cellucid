/**
 * The camera's held keys (`rendering/navigation-keys.js`). Round 9, R9K-3:
 * the viewer read "is the key down now" at frame time, so on a slow frame
 * (1–8 s per frame for 562K cells in the bug hunt's browser) a tap between
 * two frames moved nothing and equal holds moved the camera by very
 * different amounts (−0.586 against +0.034 rad for the same 400 ms hold).
 * Each key is now credited with the share of each frame it was held.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MOVEMENT_KEY_CODES, NAVIGATION_KEYS, NAVIGATION_KEY_CODES, NAVIGATION_KEY_MODES, createHeldKeys, keyLabelOf,
} from '../assets/js/rendering/navigation-keys.js';

const W = NAVIGATION_KEYS.forward;

test('a key held through a frame is credited the whole frame', () => {
  const keys = createHeldKeys();
  keys.press('KeyW', 100);
  assert.equal(keys.share(W, 116, 132), 1);
  keys.endFrame(132);
  assert.equal(keys.share(W, 132, 148), 1, 'and every frame after while held');
  assert.equal(keys.isDown(W), true);
});

test('a tap between two frames still moves the camera, for its own length', () => {
  const keys = createHeldKeys();
  keys.press('KeyW', 1100);
  keys.release('KeyW', 1160);
  assert.equal(keys.isDown(W), false);
  assert.equal(keys.isMovementDown(), true, 'the next frame must run to apply it');
  assert.equal(keys.share(W, 1000, 2000), 0.06);
  keys.endFrame(2000);
  assert.equal(keys.share(W, 2000, 3000), 0, 'applied once');
  assert.equal(keys.isMovementDown(), false);
});

test('equal presses are credited equally whatever the frame phase', () => {
  // A 400 ms hold on 1 s frames: pressed early or late in a frame, the frames
  // it spans add up to the same 400 ms.
  for (const start of [1000, 1300, 1700, 1950]) {
    const keys = createHeldKeys();
    let credited = 0;
    keys.press('KeyD', start);
    for (let frame = 1000; frame < 4000; frame += 1000) {
      if (start + 400 >= frame && start + 400 < frame + 1000) keys.release('KeyD', start + 400);
      credited += keys.share(NAVIGATION_KEYS.right, frame, frame + 1000) * 1000;
      keys.endFrame(frame + 1000);
    }
    assert.ok(Math.abs(credited - 400) < 1e-9, `pressed at ${start}: ${credited} ms`);
  }
});

test('a press after the frame it is read in waits for the next one', () => {
  const keys = createHeldKeys();
  keys.press('KeyW', 150);
  assert.equal(keys.share(W, 100, 140), 0);
  assert.equal(keys.share(W, 140, 200), 50 / 60);
});

test('a repeat of a held key changes nothing; either of two keys counts once', () => {
  const keys = createHeldKeys();
  keys.press('Equal', 0);
  keys.press('Equal', 50);
  keys.press('BracketRight', 0);
  assert.equal(keys.share(NAVIGATION_KEYS.zoomIn, 0, 100), 1);
  assert.equal(keys.release('Minus', 10), false, 'a key never pressed');
});

test('clearing forgets every key (a mode change, focus lost)', () => {
  const keys = createHeldKeys();
  assert.equal(keys.clear(), false);
  keys.press('KeyW', 0);
  assert.equal(keys.clear(), true);
  assert.equal(keys.size(), 0);
  assert.equal(keys.share(W, 0, 10), 0);
});

test('Shift alone moves nothing; every camera key has a label and its modes', () => {
  assert.equal(MOVEMENT_KEY_CODES.has('ShiftLeft'), false);
  assert.equal(NAVIGATION_KEY_CODES.has('ShiftLeft'), true);
  const keys = createHeldKeys();
  keys.press('ShiftLeft', 0);
  assert.equal(keys.isMovementDown(), false);
  for (const [movement, codes] of Object.entries(NAVIGATION_KEYS)) {
    for (const code of codes) assert.match(keyLabelOf(code), /^\S+$/);
    assert.ok(NAVIGATION_KEY_MODES[movement].length > 0, movement);
  }
  assert.deepEqual(Object.keys(NAVIGATION_KEY_MODES).sort(), Object.keys(NAVIGATION_KEYS).sort());
});
