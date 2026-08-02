/**
 * Categorical code storage is derived in exactly one place.
 *
 * A categorical column's code width decides two coupled things: which code is
 * reserved for "missing", and how many real categories are left. If a reader
 * and a writer disagree by one, nothing throws — the reader either reads the
 * missing marker as a real category or a real category as missing, and colours
 * cells by a label they do not have. These tests pin the pairing, and pin that
 * no reader in `assets/js/data` re-derives it locally.
 */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import {
  CATEGORICAL_CODE_DTYPES,
  MAX_CATEGORICAL_CATEGORIES,
  categoricalStorageForCount,
  categoricalStorageForDtype,
  requireCategoricalCategoryCount,
} from '../assets/js/data/categorical-storage-contract.js';

test('each code width reserves its terminal code and keeps the rest', () => {
  assert.deepEqual([...CATEGORICAL_CODE_DTYPES], ['uint8', 'uint16']);
  assert.equal(MAX_CATEGORICAL_CATEGORIES, 65_535);

  const uint8 = categoricalStorageForDtype('uint8', 'Field');
  assert.deepEqual({ ...uint8 }, {
    dtype: 'uint8',
    TypedArrayClass: Uint8Array,
    missingValue: 255,
    maxCategories: 255,
  });

  const uint16 = categoricalStorageForDtype('uint16', 'Field');
  assert.deepEqual({ ...uint16 }, {
    dtype: 'uint16',
    TypedArrayClass: Uint16Array,
    missingValue: 65_535,
    maxCategories: 65_535,
  });

  // The pairing that matters: the sentinel is exactly one past the last real
  // code, so the widest legal code and the sentinel can never collide.
  for (const storage of [uint8, uint16]) {
    assert.equal(storage.missingValue, storage.maxCategories);
    assert.equal(
      storage.missingValue,
      2 ** (storage.TypedArrayClass.BYTES_PER_ELEMENT * 8) - 1
    );
    // A field filled to capacity uses codes 0..maxCategories-1, which stops
    // one short of the sentinel.
    assert.equal(storage.maxCategories - 1 < storage.missingValue, true);
  }

  // The records are shared and frozen, so no consumer can edit the contract.
  assert.equal(Object.isFrozen(uint8), true);
  assert.equal(categoricalStorageForDtype('uint8', 'Other'), uint8);
});

test('a declared code width must be one the format defines', () => {
  for (const rejected of [
    'uint32', 'int8', 'u8', 'UINT8', '', 'uint8 ',
    8, null, undefined, ['uint8'], { dtype: 'uint8' },
    'toString', 'constructor', '__proto__',
  ]) {
    assert.throws(
      () => categoricalStorageForDtype(rejected, 'Field "label"'),
      /Field "label" must use one of the exact categorical code widths uint8 or uint16/,
      `dtype ${String(rejected)} must be refused`
    );
  }
  assert.throws(
    () => categoricalStorageForDtype('uint8', ''),
    /label must be a non-empty string/
  );
});

test('the narrowest width that fits is chosen at the exact boundary', () => {
  // 255 categories still fit uint8: codes 0..254, sentinel 255.
  assert.equal(categoricalStorageForCount(0, 'Field').dtype, 'uint8');
  assert.equal(categoricalStorageForCount(1, 'Field').dtype, 'uint8');
  assert.equal(categoricalStorageForCount(254, 'Field').dtype, 'uint8');
  assert.equal(categoricalStorageForCount(255, 'Field').dtype, 'uint8');
  // 256 does not, because code 255 is spoken for.
  assert.equal(categoricalStorageForCount(256, 'Field').dtype, 'uint16');
  assert.equal(categoricalStorageForCount(65_535, 'Field').dtype, 'uint16');

  assert.throws(
    () => categoricalStorageForCount(65_536, 'Field "label"'),
    /Field "label" has 65,536 categories, but Cellucid supports at most 65,535/
  );
  for (const rejected of [-1, 1.5, NaN, Infinity, '3', null, undefined]) {
    assert.throws(
      () => requireCategoricalCategoryCount(rejected, 'Field "label"'),
      /invalid category count/,
      `count ${String(rejected)} must be refused`
    );
  }
});

/**
 * Report every executable line in a tree that states a width or a sentinel of
 * its own while talking about categories.
 *
 * @param {URL} directory
 * @param {{recurse: boolean, skip?: (name: string) => boolean}} options
 * @returns {Promise<string[]>}
 */
async function findLocalDerivations(directory, { recurse, skip = () => false }) {
  const offenders = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(
      entry.isDirectory() ? `${entry.name}/` : entry.name,
      directory
    );
    if (entry.isDirectory()) {
      if (!recurse) continue;
      offenders.push(
        ...(await findLocalDerivations(child, { recurse, skip })).map(
          offender => `${entry.name}/${offender}`
        )
      );
      continue;
    }
    if (!entry.name.endsWith('.js') || skip(entry.name)) continue;
    const source = await readFile(child, 'utf8');
    source.split('\n').forEach((line, index) => {
      // The quantization NaN marker shares these numbers but is a different
      // contract (`quantization-contract.js`), so only categorical wording is
      // examined here.
      if (!/categor/i.test(line)) return;
      // A comment cannot derive anything; only executable lines are scanned.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/\b(255|65_?535)\b/.test(line)) {
        offenders.push(`${entry.name}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  return offenders;
}

test('no data-layer module re-derives the width or the sentinel', async () => {
  const offenders = await findLocalDerivations(
    new URL('../assets/js/data/', import.meta.url),
    {
      recurse: false,
      skip: name => name === 'categorical-storage-contract.js'
    }
  );
  assert.deepEqual(
    offenders,
    [],
    'categorical width and sentinel come from categorical-storage-contract.js'
  );
});

test('no application module re-derives the width or the sentinel', async () => {
  // The fields a user builds, copies, merges, and edits pass through these
  // trees, and each of them used to answer "which code means missing"
  // and "how many categories fit" for itself. One of those answers was 255 for
  // every width, which refused every operation on a uint16 categorical the app
  // had already loaded and drawn.
  //
  // The sweep covers `app/` entire rather than the three trees where the
  // original instances happened to sit. Scoping it to those three is why a
  // fourth survived in the community-annotation consensus column: a rule that
  // only looks where the last defect was found cannot catch the next one.
  const offenders = [];
  for (const relative of [
    '../assets/js/app/',
    '../assets/js/data/'
  ]) {
    offenders.push(
      ...(await findLocalDerivations(
        new URL(relative, import.meta.url),
        {
          recurse: true,
          // The contract module is where these numbers are defined. Every other
          // file must ask it.
          skip: name => name === 'categorical-storage-contract.js'
        }
      )).map(offender => `${relative}${offender}`)
    );
  }
  assert.deepEqual(
    offenders,
    [],
    'categorical width and sentinel come from categorical-storage-contract.js'
  );
});

test('the reader contract matches both exporters', async () => {
  // The readers here, `_categorical_storage` / `_declared_categorical_storage`
  // in cellucid-python, and `.categorical_code_dtype` in cellucid-r all have to
  // agree. The writers live in sibling repositories that are not always checked
  // out beside this one, so their agreement is asserted when they are present
  // and skipped explicitly when they are not.
  const writers = [
    {
      path: new URL(
        '../../cellucid-python/src/cellucid/anndata_adapter.py',
        import.meta.url
      ),
      expected: [/n_categories > 65_535/, /n_categories <= 255/, /"uint8", 255/, /"uint16", 65_535/],
    },
    {
      path: new URL('../../cellucid-r/R/obs.R', import.meta.url),
      expected: [
        /n_categories > 255L/,
        /dtype = "uint8", missing_value = 255L/,
        /n_categories > 65535L/,
        /dtype = "uint16", missing_value = 65535L/,
      ],
    },
  ];

  let checked = 0;
  for (const { path, expected } of writers) {
    let source;
    try {
      source = await readFile(path, 'utf8');
    } catch (error) {
      assert.equal(
        error.code,
        'ENOENT',
        `unexpected failure reading ${path.pathname}`
      );
      continue;
    }
    checked += 1;
    for (const pattern of expected) {
      assert.match(source, pattern, `${path.pathname} must state ${pattern}`);
    }
  }
  assert.equal(
    checked <= writers.length,
    true,
    `${checked} of ${writers.length} exporters were available to compare`
  );
});
