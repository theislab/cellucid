/**
 * Select mode is the on-screen stand-in for a held Alt key, and
 * `resolveSelectionGestureCombine` is the one place a press is classified as a
 * selection gesture or camera input. These cases pin that a mouse with select
 * mode off behaves exactly as before, and that select mode adds a way in
 * without taking any chord away.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  requireSelectMode,
  resolveSelectionGestureCombine,
  SELECT_MODE_COMBINES,
  SELECT_MODE_OFF,
} from '../assets/js/rendering/select-mode.js';

function press(overrides = {}) {
  return {
    button: 0,
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    ...overrides,
  };
}

test('select mode starts off and is frozen', () => {
  assert.deepEqual(SELECT_MODE_OFF, { enabled: false, combine: 'intersect' });
  assert.ok(Object.isFrozen(SELECT_MODE_OFF));
  assert.deepEqual(SELECT_MODE_COMBINES, ['intersect', 'union', 'subtract']);
});

test('a select-mode record is exact', () => {
  const exact = requireSelectMode({ enabled: true, combine: 'union' });
  assert.deepEqual(exact, { enabled: true, combine: 'union' });
  assert.ok(Object.isFrozen(exact));
  for (const malformed of [
    null,
    [],
    true,
    { enabled: true },
    { enabled: 'yes', combine: 'union' },
    { enabled: true, combine: 'replace' },
    { enabled: true, combine: 'union', extra: 1 },
    Object.assign(Object.create({ inherited: true }), {
      enabled: true,
      combine: 'union',
    }),
  ]) {
    assert.throws(() => requireSelectMode(malformed), TypeError);
  }
});

test('with select mode off, the mouse chords are exactly the Alt chords', () => {
  const off = SELECT_MODE_OFF;
  assert.equal(resolveSelectionGestureCombine(press(), off), null);
  assert.equal(resolveSelectionGestureCombine(press({ shiftKey: true }), off), null);
  assert.equal(resolveSelectionGestureCombine(press({ ctrlKey: true }), off), null);
  assert.equal(resolveSelectionGestureCombine(press({ altKey: true }), off), 'intersect');
  assert.equal(
    resolveSelectionGestureCombine(press({ altKey: true, shiftKey: true }), off),
    'union'
  );
  assert.equal(
    resolveSelectionGestureCombine(press({ altKey: true, ctrlKey: true }), off),
    'subtract'
  );
  assert.equal(
    resolveSelectionGestureCombine(press({ altKey: true, metaKey: true }), off),
    'subtract'
  );
  // Only the primary button ever selects; right-drag stays a camera pan.
  assert.equal(
    resolveSelectionGestureCombine(press({ altKey: true, button: 2 }), off),
    null
  );
});

test('select mode arms an unmodified press with its own combine', () => {
  for (const combine of SELECT_MODE_COMBINES) {
    const on = requireSelectMode({ enabled: true, combine });
    assert.equal(resolveSelectionGestureCombine(press(), on), combine);
    assert.equal(resolveSelectionGestureCombine(press({ altKey: true }), on), combine);
    assert.equal(resolveSelectionGestureCombine(press({ shiftKey: true }), on), 'union');
    assert.equal(resolveSelectionGestureCombine(press({ ctrlKey: true }), on), 'subtract');
    assert.equal(resolveSelectionGestureCombine(press({ button: 2 }), on), null);
  }
});
