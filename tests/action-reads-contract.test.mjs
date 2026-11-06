/**
 * Declared inputs (History v2 §3.4, §6 test 2): every action of the
 * catalogue says what its result is computed from beyond its parameters and
 * the domains it touches (`reads`, its result inputs) and where its
 * parameters' names resolve (`context`, its name context), so a step's
 * staleness (result inputs only, for every action) and a deleted step's
 * dependent re-apply (both) follow from the catalogue alone.
 *
 * Here: the declarations themselves (required, distinct, known, never a
 * touched domain, empty for an action that records no step), refused by
 * `defineAction` when they are wrong, written in the catalogue document; and
 * the inputs every parameter naming something implies (a field by its name
 * reads the fields' overlays, a gene the data mapping's gene names, a view
 * by its name the views, a highlight page the highlights, cells by original
 * position the open cells), derived from the parameter schemas so a new
 * action that names one cannot leave it out.
 *
 * The property the declarations promise, that an action applied in two
 * states that differ only in domains it neither touches nor reads gives the
 * same after-values, needs the real owners of the state, so it is checked on
 * the real page: `tests/browser/action-reads.spec.mjs`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getActionCatalog } from '../assets/js/app/actions/index.js';
import { ACTION_READ_INPUTS, catalogDocument, defineAction, isSteplessEffect } from '../assets/js/app/actions/catalog.js';
import { SHOWN_FIELD_READS, VISIBLE_CELLS_READS } from '../assets/js/app/actions/definitions/params.js';
import { DOMAIN_IDS } from '../assets/js/app/actions/domains.js';

const definitions = getActionCatalog().list();

test('every action declares its inputs: distinct, known, empty for one that records no step', () => {
  assert.ok(definitions.length > 100, 'the catalogue holds every area');
  for (const definition of definitions) {
    const { type, reads } = definition;
    assert.ok(Array.isArray(reads) && Object.isFrozen(reads), `${type} declares reads`);
    assert.equal(new Set(reads).size, reads.length, `${type} reads are distinct`);
    for (const input of reads) assert.ok(ACTION_READ_INPUTS.includes(input), `${type} reads ${input}`);
    if (isSteplessEffect(definition.effect)) assert.deepEqual(reads, [], `${type} records no step, so no inputs`);
  }
});

test('an action never declares a domain it touches: the step keeps its before-value already', () => {
  // A touched domain's value before the step is part of the step, so the
  // re-apply after a delete sees it changed through `touches`; declared as
  // read too, it would differ from the step's own after-value and every
  // such step would read as stale the moment it is recorded.
  for (const definition of definitions) {
    const both = definition.reads.filter(input => definition.touches.includes(input));
    assert.deepEqual(both, [], `${definition.type} touches and reads ${both.join(', ')}`);
  }
});

test('the inputs ACTION_READ_INPUTS names are the domains and the history, and the shared sets use them', () => {
  assert.deepEqual([...ACTION_READ_INPUTS], [...DOMAIN_IDS, 'history']);
  for (const input of [...VISIBLE_CELLS_READS, ...SHOWN_FIELD_READS]) assert.ok(DOMAIN_IDS.includes(input), input);
  // Only a view of another branch reads the history (and a revert, which puts a step's before-values back).
  const readers = definitions.filter(definition => definition.reads.includes('history')).map(definition => definition.type);
  for (const type of readers) assert.ok(['view.keep'].includes(type), `${type} reads the history`);
  assert.ok(readers.includes('view.keep'));
});

/** Every sub-schema of a parameter schema (properties, items, alternatives). */
function* subSchemas(schema) {
  if (schema === null || typeof schema !== 'object') return;
  yield schema;
  for (const child of Object.values(schema.properties ?? {})) yield* subSchemas(child);
  if (schema.items !== undefined) yield* subSchemas(schema.items);
  for (const key of ['oneOf', 'anyOf']) for (const child of schema[key] ?? []) yield* subSchemas(child);
}

/** The inputs a parameter schema's names imply (`app/actions/targets/`). */
function impliedInputs(params) {
  const implied = new Set();
  for (const schema of subSchemas(params)) {
    const source = schema.properties?.source;
    if (schema.type === 'object' && source !== undefined && schema.properties.key !== undefined) {
      // A field by the name it is shown under: renames, deletions and user
      // fields are the overlays; a gene's names are the mapping's.
      implied.add('field-overlays');
      const sources = source.const !== undefined ? [source.const] : source.enum ?? [];
      if (sources.includes('var')) implied.add('mapping');
    }
    if (schema.pattern === '^View [1-9][0-9]*$') implied.add('views');
    if (schema.description === 'A highlight page, by its name as its tab shows it.') implied.add('highlights');
    if (schema['x-cells'] === true) implied.add('cells');
  }
  return implied;
}

test('an action that names a field, a gene, a view, a page or cells reads where that name resolves', () => {
  let checked = 0;
  for (const definition of definitions) {
    if (isSteplessEffect(definition.effect)) continue;
    for (const input of impliedInputs(definition.params)) {
      if (definition.touches.includes(input)) continue;
      checked += 1;
      assert.ok(definition.reads.includes(input) || definition.context.includes(input), `${definition.type} names something resolved in ${input}, so it reads ${input} or resolves names in it`);
    }
  }
  assert.ok(checked > 30, `the names of many actions are checked (${checked})`);
});

test('the view in focus: an action on it reads the views unless it changes them', () => {
  // Colours, filters, hidden cells and the colouring belong to a view; an
  // action without a view parameter acts on the view in focus.
  const perView = ['active-field', 'filters', 'colors', 'visibility'];
  for (const definition of definitions) {
    if (isSteplessEffect(definition.effect) || definition.touches.includes('views')) continue;
    if (!definition.touches.some(domain => perView.includes(domain))) continue;
    if (definition.type.startsWith('field.') || definition.type === 'mapping.set') continue;
    assert.ok(definition.reads.includes('views') || definition.context.includes('views'), `${definition.type} acts on the view in focus, so it reads views or resolves in them`);
  }
});

test('defineAction refuses a missing, unknown, repeated or stepless input', () => {
  const base = {
    type: 'test.thing', title: 'A thing', summary: 'Does a thing.', group: 'Test',
    params: { type: 'object', additionalProperties: false, properties: {} },
    touches: ['filters'], effect: 'state', describe: () => 'Did a thing', code: () => 'thing()',
  };
  assert.throws(() => defineAction(base), /reads must list distinct inputs/);
  assert.throws(() => defineAction({ ...base, reads: null }), /reads must list distinct inputs/);
  assert.throws(() => defineAction({ ...base, reads: ['cells', 'cells'] }), /distinct/);
  assert.throws(() => defineAction({ ...base, reads: ['weather'] }), /unknown input "weather"/);
  assert.throws(
    () => defineAction({ ...base, touches: [], effect: 'read', result: { type: 'object' }, reads: ['cells'] }),
    /records no step/,
  );
  assert.deepEqual(defineAction({ ...base, reads: [] }).reads, []);
  assert.deepEqual(defineAction({ ...base, reads: ['history', 'cells'] }).reads, ['history', 'cells']);
  // The name context: distinct, known, never an input it reads or touches, none for a stepless action.
  assert.deepEqual(defineAction({ ...base, reads: [] }).context, []);
  assert.deepEqual(defineAction({ ...base, reads: ['cells'], context: ['views'] }).context, ['views']);
  assert.throws(() => defineAction({ ...base, reads: [], context: ['views', 'views'] }), /context must list distinct/);
  assert.throws(() => defineAction({ ...base, reads: [], context: ['weather'] }), /unknown input "weather"/);
  assert.throws(() => defineAction({ ...base, reads: ['views'], context: ['views'] }), /as context and as an input/);
  assert.throws(() => defineAction({ ...base, reads: [], context: ['filters'] }), /as context and as an input/);
  assert.throws(
    () => defineAction({ ...base, touches: [], effect: 'read', result: { type: 'object' }, reads: [], context: ['views'] }),
    /no name context/,
  );
});

test('a result input is what a result is computed from; a name it only resolves is context', () => {
  // A rename or a focus change makes no result stale: what only names something reads it as context.
  const catalog = getActionCatalog();
  const resultOf = type => [...catalog.get(type).reads];
  const contextOf = type => [...catalog.get(type).context];
  assert.deepEqual(contextOf('color.by'), ['field-overlays', 'mapping', 'views']);
  assert.deepEqual(resultOf('color.by'), []);
  assert.deepEqual(resultOf('highlight.category'), [...VISIBLE_CELLS_READS], 'the cells the view shows decide the highlight');
  assert.deepEqual(resultOf('analysis.run').sort(), [...VISIBLE_CELLS_READS, 'highlights'].sort());
  assert.deepEqual(resultOf('field.create-from-pages').sort(), ['cells', 'highlights']);
  assert.deepEqual(resultOf('view.keep'), ['history']);
  assert.deepEqual(contextOf('history.step.revert'), ['history']);
  assert.deepEqual(resultOf('camera-path.keyframe.add'), ['camera']);
  for (const definition of catalog.list()) {
    assert.deepEqual(definition.context.filter(input => definition.reads.includes(input)), [], `${definition.type}: no input is both`);
  }
});

test('the catalogue document writes every action\'s inputs', () => {
  const document = catalogDocument(getActionCatalog());
  for (const entry of document.actions) {
    assert.ok(Array.isArray(entry.reads), `${entry.type} reads in the document`);
    assert.deepEqual(entry.reads, [...getActionCatalog().get(entry.type).reads]);
    assert.deepEqual(entry.context, [...getActionCatalog().get(entry.type).context]);
  }
});
