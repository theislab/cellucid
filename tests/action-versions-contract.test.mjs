/**
 * Action versions (old history files keep replaying). Every action whose steps are recorded has a
 * `version` of its parameters and an upgrader from each earlier one (a read
 * or a move of the history records no step and has none); a step records
 * the version it was made with (`Step.v`); every version keeps its shape and
 * examples using every property and every `oneOf` branch
 * (`tests/fixtures/action-versions/<type>@<version>.json`,
 * `scripts/generate-action-versions.mjs`). A params shape that changes
 * without a version bump and an upgrader fails here (rewording does not);
 * so does an older example that no longer upgrades to valid parameters. A
 * file is written once: the generator never writes over one that exists.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogDocument, createActionCatalog, defineAction, isSteplessEffect, upgradeParams } from '../assets/js/app/actions/catalog.js';
import { ACTION_DEFINITIONS } from '../assets/js/app/actions/definitions/index.js';
import { examplesOf } from '../assets/js/app/actions/schema.js';
import { readVersionFiles, renderVersionExample, versionFileName, versionProblems } from '../scripts/generate-action-versions.mjs';

test('every version of every action keeps its example, and the parameters now are the current version\'s', () => {
  const problems = versionProblems(ACTION_DEFINITIONS, readVersionFiles());
  assert.deepEqual(problems, [], problems.join('\n'));
  const files = readVersionFiles();
  const expected = createActionCatalog(ACTION_DEFINITIONS).list().filter(definition => definition.version !== null)
    .flatMap(definition => Array.from({ length: definition.version }, (_, index) => versionFileName(definition.type, index + 1)));
  assert.deepEqual(files.map(file => file.name).sort(), expected.sort(), 'one file per version of each recorded action, and no other');
  for (const definition of createActionCatalog(ACTION_DEFINITIONS).list()) {
    assert.equal(definition.version === null, isSteplessEffect(definition.effect), `${definition.type}: versioned exactly when its steps are recorded`);
  }
});

const BASE = Object.freeze({
  type: 'test.color', title: 'Color', summary: 'Color by a field.', group: 'Test',
  params: { type: 'object', additionalProperties: false, required: ['field'], properties: { field: { type: 'string', minLength: 1 } } },
  touches: ['active-field'], reads: [], effect: 'view', describe: () => 'Colored', code: () => 'color()',
});

/** The same action, its `field` now `{source, key}`: version 2, with the upgrader from 1. */
const V2 = Object.freeze({
  ...BASE,
  params: {
    type: 'object', additionalProperties: false, required: ['field'],
    properties: {
      field: {
        type: 'object', additionalProperties: false, required: ['source', 'key'],
        properties: { source: { enum: ['obs', 'var'] }, key: { type: 'string', minLength: 1 } },
      },
    },
  },
  version: 2,
  upgrade: { 1: params => ({ ...params, field: { source: 'obs', key: params.field } }) },
});

function keptFile(definition) {
  const text = renderVersionExample(definition);
  return { name: versionFileName(definition.type, definition.version), type: definition.type, version: definition.version, record: JSON.parse(text), text };
}

test('a params schema changed without a version bump and an upgrader fails, naming what to do', () => {
  const v1 = defineAction(BASE);
  const kept = [keptFile(v1)];
  assert.deepEqual(versionProblems([v1], kept), []);
  // Rewording a description is no new version.
  const reworded = defineAction({ ...BASE, params: { ...BASE.params, properties: { field: { type: 'string', minLength: 1, description: 'The field.' } } } });
  assert.deepEqual(versionProblems([reworded], kept), []);
  // The parameters changed, the version did not.
  const changed = defineAction({ ...V2, version: undefined, upgrade: undefined });
  assert.deepEqual(versionProblems([changed], kept), [
    'The parameters of "test.color" changed at version 1: bump its version to 2, add upgrade[1] (parameters of version 1 to 2), '
      + 'and run node scripts/generate-action-versions.mjs to keep examples of the new version',
  ]);
  // Bumped, with its upgrader: the new version needs its own example, and then the old one replays.
  const v2 = defineAction(V2);
  assert.deepEqual(versionProblems([v2], kept), [
    'test.color@2.json is missing: every version of "test.color" keeps examples of its parameters (run node scripts/generate-action-versions.mjs)',
  ]);
  assert.deepEqual(versionProblems([v2], [...kept, keptFile(v2)]), []);
  // An upgrader that does not reach valid parameters fails on the old examples.
  const wrong = defineAction({ ...V2, upgrade: { 1: params => params } });
  assert.match(versionProblems([wrong], [...kept, keptFile(v2)])[0], /^test\.color@1\.json: example 0 upgraded to version 2 is not valid now: /);
  // Files of an action that is gone, or of a version ahead of it, are named.
  assert.deepEqual(versionProblems([v1], [...kept, keptFile(v2)]), ['test.color@2.json is newer than "test.color" (version 1)']);
  assert.match(versionProblems([], kept)[0], /names an action whose steps the catalog does not record/);
});

test('an optional parameter renamed without its upgrader fails on the kept examples, which use every property and branch', () => {
  const OPTIONAL = Object.freeze({
    ...BASE,
    params: {
      type: 'object', additionalProperties: false, required: ['field'],
      properties: {
        field: { type: 'string', minLength: 1 },
        scale: { oneOf: [{ type: 'string', enum: ['log', 'linear'] }, { type: 'number', minimum: 0 }] },
      },
    },
  });
  const v1 = defineAction(OPTIONAL);
  assert.deepEqual(examplesOf(v1.params), [{ field: 'x', scale: 'log' }, { field: 'x', scale: 0 }], 'every property, one example per branch');
  // Version 2 renames `scale` to `transform`, and the upgrader forgets it.
  const renamed = { ...OPTIONAL.params, properties: { field: OPTIONAL.params.properties.field, transform: OPTIONAL.params.properties.scale } };
  const forgetful = defineAction({ ...OPTIONAL, params: renamed, version: 2, upgrade: { 1: params => params } });
  const kept = [keptFile(v1), keptFile(forgetful)];
  assert.deepEqual(versionProblems([forgetful], kept).map(problem => problem.replace(/: test\.color.*$/, '')), [
    'test.color@1.json: example 0 upgraded to version 2 is not valid now',
    'test.color@1.json: example 1 upgraded to version 2 is not valid now',
  ]);
  const careful = defineAction({
    ...OPTIONAL, params: renamed, version: 2,
    upgrade: { 1: ({ scale, ...rest }) => (scale === undefined ? rest : { ...rest, transform: scale }) },
  });
  assert.deepEqual(versionProblems([careful], [keptFile(v1), keptFile(careful)]), []);
});

test('defineAction: version and upgrade, checked; upgradeParams runs the upgraders in order', () => {
  assert.equal(defineAction(BASE).version, 1);
  assert.deepEqual(defineAction(BASE).upgrade, {});
  const read = { ...BASE, type: 'test.read', touches: [], effect: 'read', result: { type: 'object', additionalProperties: false, properties: {} } };
  assert.equal(defineAction(read).version, null, 'a read records no step: no version');
  assert.throws(() => defineAction({ ...read, version: 1 }), { message: 'Action "test.read" records no step, so its parameters have no version (version, upgrade)' });
  assert.throws(() => upgradeParams(defineAction(read), 1, {}), { message: '"test.read" records no step, so its parameters have no version' });
  assert.throws(() => defineAction({ ...BASE, version: 0 }), { message: 'Action "test.color" version must be a whole number from 1' });
  assert.throws(() => defineAction({ ...BASE, version: 2 }), {
    message: 'Action "test.color" is at version 2, so upgrade must hold exactly one function for each of versions 1',
  });
  assert.throws(() => defineAction({ ...BASE, upgrade: { 1: params => params } }), {
    message: 'Action "test.color" is at version 1, so upgrade must hold exactly one function for each of no earlier version',
  });
  assert.throws(() => defineAction({ ...V2, upgrade: { 1: 'x' } }), { message: 'Action "test.color" upgrade from version 1 must be a function' });
  const three = defineAction({
    ...V2, version: 3,
    upgrade: { ...V2.upgrade, 2: params => ({ field: { ...params.field, key: params.field.key.toUpperCase() } }) },
  });
  const recorded = { field: 'cd3e' };
  assert.deepEqual(upgradeParams(three, 1, recorded), { field: { source: 'obs', key: 'CD3E' } });
  assert.deepEqual(recorded, { field: 'cd3e' }, 'the recorded parameters are never changed (upgraded on a copy)');
  const mutating = defineAction({ ...V2, upgrade: { 1: params => { params.field = { source: 'obs', key: params.field }; return params; } } });
  const kept = { field: 'x' };
  upgradeParams(mutating, 1, kept);
  assert.deepEqual(kept, { field: 'x' }, 'even by an upgrader that writes in place');
  assert.deepEqual(upgradeParams(three, 3, { field: { source: 'var', key: 'X' } }), { field: { source: 'var', key: 'X' } });
  assert.throws(() => upgradeParams(three, 4, {}), { message: '"test.color" was recorded with version 4 of its parameters, newer than this catalog\'s 3' });
  assert.throws(() => upgradeParams(three, 0, {}), { message: 'An action version is a whole number from 1, not 0' });
  assert.equal(catalogDocument(createActionCatalog([three])).actions[0].version, 3, 'the catalogue (and its Python and R mirrors) carry the version');
});

test('a parameter renamed to its US spelling: a step recorded with the British name replays under the new one', () => {
  const transform = ACTION_DEFINITIONS.find(definition => definition.type === 'expression.transform.set');
  assert.equal(transform.version, 2);
  assert.deepEqual(upgradeParams(transform, 1, { normalise: true, log1p: false }), { normalize: true, log1p: false });
  assert.deepEqual(upgradeParams(transform, 1, { log1p: true }), { log1p: true }, 'a step that named log1p alone is the same step');
  assert.deepEqual(upgradeParams(transform, 2, { normalize: false }), { normalize: false });
  assert.equal(transform.params.properties.normalise, undefined, 'the current schema holds no British name');
});
