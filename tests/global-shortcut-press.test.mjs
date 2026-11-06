/**
 * The page's global keys (`ui/onboarding/keyboard-shortcuts.js`) take a
 * plain press only: a key typed into a field, a chord with Ctrl, ⌘ or Alt
 * (the browser's and the system's keys: ⌘P prints, ⌘F finds, ⌘1 picks a
 * tab) and the auto-repeat of a held key change nothing, so typing on the
 * page records no step beyond what each shortcut's own action records
 * (History v2 §2.6 item 8; the keyboard walk, `tests/browser/history-keyboard-chrome.spec.mjs`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { isShortcutPress } from '../assets/js/app/ui/onboarding/keyboard-shortcuts.js';

const canvas = { tagName: 'CANVAS', isContentEditable: false };
const press = (extra = {}) => ({ target: canvas, ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...extra });

test('a plain press on the page is a shortcut press', () => {
  assert.equal(isShortcutPress(press()), true);
  assert.equal(isShortcutPress(press({ shiftKey: true })), true, 'Shift is part of a key (?)');
  assert.equal(isShortcutPress(press({ target: null })), true);
});

test('a chord, a held key repeating, and typing into a field are not', () => {
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    assert.equal(isShortcutPress(press({ [modifier]: true })), false, modifier);
  }
  assert.equal(isShortcutPress(press({ repeat: true })), false);
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(isShortcutPress(press({ target: { tagName } })), false, tagName);
  }
  assert.equal(isShortcutPress(press({ target: { tagName: 'DIV', isContentEditable: true } })), false);
});
