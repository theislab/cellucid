/**
 * History v2 §6 test 3: the State panel takes the one path agents, Python and
 * R take (C1). Every operation it does on the history is a `history.*`
 * catalog action, dispatched; a static scan fails on a call of one of the
 * history's mutators from `ui/modules/state/**`; and every operation that
 * loses work asks an agent first (`confirm: 'deletes-saved'`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { historyActions } from '../assets/js/app/actions/definitions/history.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, 'assets/js/app/ui/modules/state');

/**
 * The history's methods that change it (`app/history/history.js`): each is
 * what a `history.*` action runs, and the panel dispatches the action.
 */
const MUTATORS = [
  'undo', 'redo', 'jump', 'deleteStep', 'undoTurn', 'useTracker', 'startTracker', 'setRecording', 'replay',
  'importTrackers', 'load', 'settlePaused', 'restorePausedDraft', 'reconcile', 'showValues',
];

/** Mutator names other objects have too (a picture loads, a tour replays): matched only on a history's names. */
const GENERIC = new Set(['load', 'replay', 'reconcile']);

/**
 * The panel's modules as code: comments blanked (line numbers kept), so a
 * doc comment naming a read (`history.active`) or the method an action runs
 * is not taken for a call or a dispatch.
 */
async function stateSources() {
  const out = [];
  for (const name of await readdir(STATE_DIR)) {
    if (!name.endsWith('.js')) continue;
    const text = (await readFile(path.join(STATE_DIR, name), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '))
      .replace(/^(\s*)\/\/.*$/gm, '$1');
    out.push({ name, text });
  }
  return out;
}

test('the State panel calls no mutator of the history: it dispatches the history\'s actions', async () => {
  // Names only the history has are matched on any object but the panel's own operations (`ops`, each
  // dispatching its action); generic ones (load, replay, reconcile) on the names the panel holds a history by.
  const own = MUTATORS.filter(name => !GENERIC.has(name));
  const pattern = new RegExp(
    `\\b(?!ops\\b)\\w+(\\(\\))?\\??\\.(${own.join('|')})\\(|\\b(history|current|hist|owned|shown)(\\(\\))?\\??\\.(${[...GENERIC].join('|')})\\(`, 'g',
  );
  const found = [];
  for (const { name, text } of await stateSources()) {
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      found.push(`${name}:${line} calls ${match[0]}…; dispatch its history.* action instead (history-source.js createHistoryActions)`);
    }
  }
  assert.deepEqual(found, []);
});

test('every history action the State panel names is in the catalogue, however it dispatches it', async () => {
  // Any quoted action type of the history (act('…'), dispatch('…'), a type held in a
  // variable or a table): every one must be a catalog action, so no way of dispatching can miss one.
  const types = new Set(historyActions.map(definition => definition.type));
  const used = new Map();
  for (const { name, text } of await stateSources()) {
    for (const match of text.matchAll(/['"`](history\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*)['"`]/g)) {
      if (!used.has(match[1])) used.set(match[1], name);
    }
  }
  assert.ok(used.size >= 8, `the panel dispatches the history's actions (${[...used.keys()].join(', ')})`);
  for (const [type, name] of used) assert.ok(types.has(type), `${name} names ${type}, which is not a catalogue action`);
});

test('every operation that loses work asks an agent first', () => {
  const losing = ['history.branch.delete', 'history.step.delete', 'history.tracker.remove', 'history.journal.empty', 'history.squash', 'history.clear'];
  for (const type of losing) {
    const definition = historyActions.find(each => each.type === type);
    assert.ok(definition, `${type} is defined`);
    assert.equal(definition.confirm, 'deletes-saved', `${type} asks an agent before it runs`);
  }
  // A move or an edit kept in the journal loses nothing, so it asks nothing.
  for (const type of ['history.undo', 'history.redo', 'history.jump', 'history.branch.rename', 'history.note.add', 'history.group.create']) {
    assert.equal(historyActions.find(each => each.type === type).confirm, null, `${type} asks nothing`);
  }
});
