import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const {
  assertNavigationMode,
  createNavigationModeOwnership,
  getDefaultNavigationMode
} = await import('../assets/js/rendering/viewer.js');

const navigationSettingsSource = await readFile(
  new URL('../assets/js/app/ui/modules/navigation-settings.js', import.meta.url),
  'utf8'
);

test('fresh 1D/2D views use planar navigation and fresh 3D views use orbit', () => {
  assert.equal(getDefaultNavigationMode(1), 'planar');
  assert.equal(getDefaultNavigationMode(2), 'planar');
  assert.equal(getDefaultNavigationMode(3), 'orbit');
});

test('unsupported dimensions and navigation modes reject without normalization', () => {
  for (const invalidDimension of [undefined, null, 0, 4, '2', Number.NaN, 2.5]) {
    assert.throws(
      () => getDefaultNavigationMode(invalidDimension),
      /dimension/i
    );
  }

  for (const validMode of ['orbit', 'planar', 'free']) {
    assert.equal(assertNavigationMode(validMode), validMode);
  }
  for (const invalidMode of [undefined, null, '', 'Orbit', 'teleport', 3]) {
    assert.throws(
      () => assertNavigationMode(invalidMode),
      /navigation mode/i
    );
  }
});

test('camera range inputs reject coercive or partial numeric strings', async () => {
  const { parseRangeInput } = await import(
    '../assets/js/app/ui/core/numeric-input-contract.js'
  );

  assert.equal(
    parseRangeInput('5', { minimum: 1, maximum: 30, label: 'Look sensitivity' }),
    5
  );
  assert.equal(
    parseRangeInput('0.25', { minimum: 0.1, maximum: 1, label: 'Speed' }),
    0.25
  );

  for (const invalid of [
    '',
    ' ',
    '5px',
    '5 trailing',
    ' 5',
    '5 ',
    '0x10',
    'Infinity',
    Number.NaN,
    5,
    null,
    undefined
  ]) {
    assert.throws(
      () => parseRangeInput(
        invalid,
        { minimum: 1, maximum: 30, label: 'Look sensitivity' }
      ),
      /look sensitivity/i,
      `must reject ${String(invalid)}`
    );
  }

  assert.throws(
    () => parseRangeInput(
      '0',
      { minimum: 1, maximum: 30, label: 'Look sensitivity' }
    ),
    /from 1 through 30/i
  );
  assert.throws(
    () => parseRangeInput(
      '31',
      { minimum: 1, maximum: 30, label: 'Look sensitivity' }
    ),
    /from 1 through 30/i
  );
  assert.throws(
    () => parseRangeInput(
      '5',
      {
        minimum: 1,
        maximum: 30,
        label: 'Look sensitivity',
        legacyDefault: 5
      }
    ),
    /exactly/i
  );
});

test('a navigation choice is recorded per view and per dimension', () => {
  // Every view navigates by its own dimension; a choice that differs from the
  // default belongs to one view at the dimension it was made for, so a view
  // set to free-fly in 3D flies again whenever it shows a 3D representation
  // and pans whenever it shows a 2D one.
  const owner = createNavigationModeOwnership();
  assert.equal(owner.choiceFor('live', 3), null);
  owner.record('live', 3, 'free');
  assert.equal(owner.choiceFor('live', 3), 'free');
  assert.equal(owner.choiceFor('live', 2), null, 'a 3D choice says nothing about 2D');
  assert.equal(owner.choiceFor('snap_1', 3), null, 'a choice belongs to one view');
  owner.record('live', 2, 'orbit');
  assert.equal(owner.choiceFor('live', 2), 'orbit');
  assert.equal(owner.choiceFor('live', 3), 'free', 'dimensions are independent');

  assert.throws(() => owner.record('live', 3, 'teleport'), /navigation mode/i);
  assert.throws(() => owner.record('', 3, 'orbit'), /view id/i);
  for (const dimension of [0, 4, 2.5, '3', null]) {
    assert.throws(() => owner.record('live', dimension, 'orbit'), /dimension/i);
    assert.throws(() => owner.choiceFor('live', dimension), /dimension/i);
    assert.throws(() => owner.release('live', dimension), /dimension/i);
  }
});

test('releasing a choice hands that view and dimension back to the dimension rule', () => {
  const owner = createNavigationModeOwnership();
  owner.record('live', 3, 'free');
  owner.record('live', 2, 'orbit');
  owner.record('snap_1', 3, 'planar');
  owner.release('live', 3);
  assert.equal(owner.choiceFor('live', 3), null);
  assert.equal(owner.choiceFor('live', 2), 'orbit', 'releasing one dimension keeps the other');
  assert.equal(owner.choiceFor('snap_1', 3), 'planar', 'releasing one view keeps its neighbors');
  // Releasing what was never chosen is a no-op, not an error.
  owner.release('snap_2', 1);
  assert.equal(owner.choiceFor('snap_2', 1), null);
  assert.throws(() => owner.release('', 3), /view id/i);
});

test('a kept view inherits the choices of its source view, and a removed view loses its own', () => {
  const owner = createNavigationModeOwnership();
  owner.record('live', 3, 'free');
  owner.record('live', 2, 'orbit');
  owner.copyView('live', 'snap_1');
  assert.equal(owner.choiceFor('snap_1', 3), 'free');
  assert.equal(owner.choiceFor('snap_1', 2), 'orbit');
  // The copy is the kept view's own: changing it leaves the source alone.
  owner.record('snap_1', 3, 'planar');
  assert.equal(owner.choiceFor('live', 3), 'free');
  // A source without choices leaves its copy without any, even over a stale
  // record for the same id.
  owner.copyView('snap_9', 'snap_1');
  assert.equal(owner.choiceFor('snap_1', 3), null);
  assert.equal(owner.choiceFor('snap_1', 2), null);

  owner.deleteView('live');
  assert.equal(owner.choiceFor('live', 3), null);
  owner.record('snap_2', 1, 'orbit');
  owner.clear();
  assert.equal(owner.choiceFor('snap_2', 1), null);
  assert.throws(() => owner.copyView('', 'snap_1'), /view id/i);
  assert.throws(() => owner.copyView('live', ''), /view id/i);
  assert.throws(() => owner.deleteView(''), /view id/i);
});
