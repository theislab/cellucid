/**
 * F87 (2026-11-11): the rule the chat folds by while a camera path plays
 * (`chatFoldsForFilm`, `app/agent/dock.js`); the page wiring is
 * `tests/browser/agent-chat-film-fold.spec.mjs`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { chatFoldsForFilm } from '../assets/js/app/agent/dock.js';

const base = { playing: true, sidePanel: false, drafting: false, asking: false, kept: false };

test('the open chat folds only as the bar over a playing film, with nothing waiting on the person', () => {
  assert.equal(chatFoldsForFilm(base), true);
  // Not playing (stopped or paused): it is shown.
  assert.equal(chatFoldsForFilm({ ...base, playing: false }), false);
  // The side panel covers no cell; folding it would widen the plot mid-shot.
  assert.equal(chatFoldsForFilm({ ...base, sidePanel: true }), false);
  // A message being written, a question of the chat, or the person's own reopening keep it.
  assert.equal(chatFoldsForFilm({ ...base, drafting: true }), false);
  assert.equal(chatFoldsForFilm({ ...base, asking: true }), false);
  assert.equal(chatFoldsForFilm({ ...base, kept: true }), false);
});
