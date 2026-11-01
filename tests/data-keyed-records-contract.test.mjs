/**
 * A key a file names is data, never an object's prototype: a member of
 * `uns` or an HDF5 attribute called `__proto__` becomes an own key of the
 * record built from it (`utils/exact-record.js` `setOwnDataProperty`), so the
 * key-exact checks see it, no later read inherits a value through it, and
 * `Object.prototype` is never touched.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { Hdf5Group } from '../assets/js/formats/hdf5/nodes.js';
import { array, mapping, minimalAnnData, openReader } from './helpers/anndata-store.mjs';

const scalarString = text => array([text], {
  dtype: '|O',
  shape: [],
  chunks: [],
  attrs: { 'encoding-type': 'string', 'encoding-version': '0.2.0' },
});

test('a uns member named __proto__ is a key of uns, not its prototype', async () => {
  const tree = minimalAnnData({
    nObs: 2,
    extra: {
      uns: mapping({
        cellucid: mapping({
          ['__proto__']: mapping({ id: scalarString('smuggled') }),
          name: scalarString('Dataset'),
        }),
      }),
    },
  });
  const { reader } = await openReader(tree);
  const { cellucid } = await reader.getDatasetMetadata();
  assert.equal(Object.getPrototypeOf(cellucid), Object.prototype);
  assert.ok(Object.hasOwn(cellucid, '__proto__'), 'the member is an own key the exact checks see');
  assert.deepEqual(Object.keys(cellucid).sort(), ['__proto__', 'name']);
  assert.equal(cellucid.id, undefined, 'nothing is inherited through it');
  assert.equal(({}).id, undefined, 'Object.prototype is untouched');
});

test('an HDF5 attribute named __proto__ is an attribute, not the map\'s prototype', () => {
  const type = { class: 'fixed-point', size: 4, signed: true, littleEndian: true };
  const attribute = (name, value) => ({ name, value, error: null, type, space: { dims: [] } });
  const node = new Hdf5Group(null, {
    attributes: [attribute('__proto__', { 'encoding-type': 'smuggled' }), attribute('n', 3)],
    links: [],
  }, '/', '');
  assert.equal(Object.getPrototypeOf(node.attrs), Object.prototype);
  assert.ok(Object.hasOwn(node.attrs, '__proto__'));
  assert.deepEqual(Object.keys(node.attrs).sort(), ['__proto__', 'n']);
  assert.equal(node.attrs['encoding-type'], undefined, 'nothing is inherited through it');
  assert.equal(({})['encoding-type'], undefined);
});
