/**
 * The page's whole action catalog (`assets/js/app/actions/definitions/`):
 * every action, whatever area defines it, has parameters whose own example
 * is valid (what an agent's tool description and the docs show), a one-line
 * past-tense label and pseudocode for that example, known domains, and a
 * result schema when it reads. An area's own tests check its semantics; this
 * one fails when a new action anywhere falls behind.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getActionCatalog } from '../assets/js/app/actions/index.js';
import { DOMAIN_IDS } from '../assets/js/app/actions/domains.js';
import { ACTION_CONFIRMS, isSteplessEffect } from '../assets/js/app/actions/catalog.js';
import { exampleOf, schemaProblem } from '../assets/js/app/actions/schema.js';

test('every action\'s own example is valid and labelled in one line with one line of pseudocode', () => {
  const catalog = getActionCatalog();
  const definitions = catalog.list();
  assert.ok(definitions.length > 100, 'the catalogue holds every area');
  for (const definition of definitions) {
    const example = exampleOf(definition.params);
    assert.equal(schemaProblem(definition.params, example), null, `${definition.type} example ${JSON.stringify(example)}`);
    for (const [what, text] of [['describe', definition.describe(example, null)], ['code', definition.code(example)]]) {
      assert.equal(typeof text, 'string', `${definition.type} ${what}`);
      assert.ok(text.length > 0 && !text.includes('\n') && text.trim() === text, `${definition.type} ${what}: ${JSON.stringify(text)}`);
    }
    for (const domain of definition.touches) assert.ok(DOMAIN_IDS.includes(domain), `${definition.type} touches ${domain}`);
    if (isSteplessEffect(definition.effect)) {
      // A read, a move of the history (undo, redo, a jump) or another
      // dataset opened: no step, so no domain, and its answer is its result.
      assert.equal(definition.touches.length, 0, `${definition.type} records no step, so it touches nothing`);
      assert.notEqual(definition.result, null, `${definition.type} says what it returns`);
    } else {
      assert.ok(definition.touches.length > 0, `${definition.type} changes state, so it names what`);
    }
  }
});

test('the history\'s moves are actions every surface reaches: undo, redo and a jump to a step', () => {
  const catalog = getActionCatalog();
  const moves = catalog.list().filter(definition => definition.effect === 'history').map(definition => definition.type);
  for (const move of ['history.jump', 'history.redo', 'history.undo']) assert.ok(moves.includes(move), move);
  // Only the history's own actions move or edit it (tests/history-actions-contract.test.mjs lists them).
  assert.deepEqual(moves.filter(type => !type.startsWith('history.')), []);
  assert.equal(schemaProblem(catalog.get('history.jump').params, { step: 's12' }), null);
  assert.notEqual(schemaProblem(catalog.get('history.jump').params, { step: 'S12' }), null);
  assert.notEqual(schemaProblem(catalog.get('history.jump').params, { step: 's012' }), null);
});

/**
 * What a person does in the app that an agent, a notebook and a replay do
 * too, through the same action and the same permissions (the person-only
 * list), each with its actions and how an agent's
 * call is asked. No camera-path video is on it: the app makes none, for a
 * person either.
 */
const PERSON_FEATURES = Object.freeze({
  'the guided tour (State › History › Tour)': { 'history.tour.start': null, 'history.tour.stop': null },
  'Print report (State › History)': { 'history.report': 'writes-file' },
  'My datasets › All…: Forget, and the sizes it shows': { 'my-datasets.forget': 'deletes-saved', 'datasets.list': null },
  'Stored › Manage…: the list and its removals': { 'stored.list': null, 'stored.remove': 'deletes-saved' },
  'Figure export: its settings and Download': { 'figure-export.set': null, 'figure.export': 'writes-file' },
  'the highlighted cells and a field as a file': { 'cells.export': 'writes-file', 'field.export': 'writes-file' },
  'community annotation: the suggestions, votes, suggestions and Publish': { 'annotation.suggestions': null, 'annotation.publish': 'publishes' },
  'Share (Open data): the link, the badge, the embed': { 'dataset.share-link': 'publishes' },
  'Share and Save of the history': { 'history.share': 'writes-file', 'history.save': null, 'history.saved.delete': 'deletes-saved' },
});

test('no person-only feature of the list is left: each is an action, asked of an agent as the list says', () => {
  const catalog = getActionCatalog();
  for (const [feature, actions] of Object.entries(PERSON_FEATURES)) {
    for (const [type, confirm] of Object.entries(actions)) {
      assert.ok(catalog.has(type), `${feature}: ${type} is not an action, so an agent cannot do it`);
      assert.equal(catalog.get(type).confirm, confirm, `${feature}: ${type} is asked as ${confirm}`);
    }
  }
  // My datasets' sizes are read with the list of datasets to open.
  const mine = catalog.get('datasets.list').result.properties.my_datasets.items.properties;
  for (const key of ['size', 'saved_states_bytes', 'kept_bytes']) assert.ok(Object.hasOwn(mine, key), `datasets_list names ${key}`);
});

test('every permission kind governs real tools: each confirmation kind is asked by an action of the catalogue', () => {
  const catalog = getActionCatalog();
  const used = new Set(catalog.list().map(definition => definition.confirm).filter(confirm => confirm !== null));
  assert.deepEqual([...ACTION_CONFIRMS].filter(kind => !used.has(kind)), [], 'a kind no action asks is a setting that governs nothing');
  const publishes = catalog.list().filter(definition => definition.confirm === 'publishes').map(definition => definition.type).sort();
  assert.deepEqual(publishes, ['annotation.publish', 'dataset.share-link']);
});

// An action's example never tells the agent to "Ask the person first.": a chat model would ask in its
// own words (`ask_person`), its turn would end on the question, and the action would never be called,
// while Cellucid asks the person itself as their settings say (`confirm`).
test('no description tells an agent to ask the person itself: an action Cellucid asks about says so by its confirm', () => {
  const told = getActionCatalog().list()
    .filter(definition => /\b(ask|confirm with|check with)\b[^.]*\b(the person|them)\b[^.]*\bfirst\b/i.test(definition.summary))
    .map(definition => `${definition.type}: ${definition.summary}`);
  assert.deepEqual(told, []);
});

// An example never merges a category into itself (both parameters taking the label's one example): a
// model given it would merge a category into itself and be refused, and the reference docs would show
// it too. The same for a rename's example renamed to the same name.
test('no action\'s example names one value for two of its parameters (a merge into itself, a rename to its own name)', () => {
  const doubled = [];
  for (const definition of getActionCatalog().list()) {
    const example = exampleOf(definition.params);
    if (example === null || typeof example !== 'object') continue;
    const seen = new Map();
    for (const [key, value] of Object.entries(example)) {
      // A placeholder ("x", a schema's bare string) is not a value an example chose.
      if (typeof value !== 'string' || /^x+$/.test(value)) continue;
      if (seen.has(value)) doubled.push(`${definition.type}: ${seen.get(value)} and ${key} are both ${JSON.stringify(value)}`);
      else seen.set(value, key);
    }
  }
  assert.deepEqual(doubled, []);
});
