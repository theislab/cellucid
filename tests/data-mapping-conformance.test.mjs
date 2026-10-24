// The shared data-mapping conformance fixture, run against the web rules.
//
// tests/fixtures/data-mapping-conformance.json is kept byte-for-byte in the
// web app, cellucid-python (tests/fixtures/data_mapping_conformance.json) and
// cellucid-r (tests/testthat/fixtures/data_mapping_conformance.json). The
// rules it pins -- making names unique, the best-guess ranking, the
// embedding-column checks, canonical embedding ids, the default expression,
// the vector-field key rule and the default vector bindings, the
// representations enabled when a dataset opens, the "nothing to plot" text and
// DataMapping validation -- are the ones every reader and writer must apply
// identically, so a change to
// any of them changes the fixture, the pin, and the other two implementations
// together.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DataMappingError,
  DIMENSION_SLOTS,
  bestGuessOrder,
  bestGuessTier,
  canonicalEmbeddingId,
  compareCodePoints,
  compareEmbeddingRefs,
  defaultEnabledEmbeddings,
  defaultExpression,
  defaultVectorBindings,
  describeObsmEntry,
  makeUniqueNames,
  nothingPlottableMessage,
  obsmEntryDefect,
  parseVectorFieldKey,
  resolveEmbeddingSlots,
  uniqueNamesNote,
  validateDataMapping,
  validateEmbeddingColumns,
  vectorFieldKeys,
} from '../assets/js/data/data-mapping.js';
import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { DataSourceErrorCode } from '../assets/js/data/data-source.js';
import { withObsmPayloads } from './helpers/anndata-mapping-mocks.mjs';

const FIXTURE_URL = new URL('./fixtures/data-mapping-conformance.json', import.meta.url);

// cellucid-python (tests/test_data_mapping_conformance.py) and cellucid-r
// (tests/testthat/test-data-mapping-conformance.R) pin this same digest.
// Update all three together.
const FIXTURE_SHA256 =
  'a84646cb66451a4ef86d965c9d65ef1dab41276592274fc9fa5f343344640241';

/**
 * A JSON number literal written with a fraction or an exponent, such as
 * `1.0`. JSON.parse folds `1.0` into the integer 1, while Python and R keep
 * it a float that an integer rule must reject, so the fixture loader keeps
 * such literals distinguishable as this non-number value.
 */
class JsonFloatLiteral {
  constructor(source) {
    this.source = source;
    Object.freeze(this);
  }
}

const FLOAT_MARKER = '$jsonFloatLiteral';
const NUMBER_TOKEN = /-?\d+(\.\d+)?([eE][+-]?\d+)?/y;

function parseKeepingFloatLiterals(text) {
  assert.equal(text.includes(FLOAT_MARKER), false);
  let rewritten = '';
  let position = 0;
  while (position < text.length) {
    const character = text[position];
    if (character === '"') {
      let end = position + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      rewritten += text.slice(position, end + 1);
      position = end + 1;
      continue;
    }
    if (character === '-' || (character >= '0' && character <= '9')) {
      NUMBER_TOKEN.lastIndex = position;
      const [token, fraction, exponent] = NUMBER_TOKEN.exec(text);
      rewritten += fraction || exponent
        ? `{"${FLOAT_MARKER}":"${token}"}`
        : token;
      position += token.length;
      continue;
    }
    rewritten += character;
    position += 1;
  }
  return JSON.parse(rewritten, (_key, value) =>
    value !== null && typeof value === 'object' && Object.hasOwn(value, FLOAT_MARKER)
      ? new JsonFloatLiteral(value[FLOAT_MARKER])
      : value
  );
}

const FIXTURE_BYTES = readFileSync(FIXTURE_URL);
const FIXTURE = parseKeepingFloatLiterals(FIXTURE_BYTES.toString('utf8'));

function cases(section) {
  return FIXTURE[section];
}

function assertDataMappingError(callback, code) {
  assert.throws(callback, error => {
    assert.ok(error instanceof DataMappingError, `expected DataMappingError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('the fixture is the pinned shared copy', () => {
  assert.equal(
    createHash('sha256').update(FIXTURE_BYTES).digest('hex'),
    FIXTURE_SHA256
  );
  assert.equal(FIXTURE.version, 4);
  assert.deepEqual(Object.keys(FIXTURE), [
    '_about',
    'version',
    'makeUniqueNames',
    'uniqueNamesNote',
    'bestGuessTier',
    'embeddingSlots',
    'enabledEmbeddings',
    'embeddingColumns',
    'canonicalEmbeddingId',
    'defaultExpression',
    'vectorFieldKeys',
    'defaultVectorBindings',
    'nothingPlottable',
    'dataMapping',
  ]);
  for (const section of Object.keys(FIXTURE).slice(2)) {
    assert.ok(FIXTURE[section].length > 0, section);
  }
  // The loader changes exactly the one float literal the fixture holds.
  assert.deepEqual(
    JSON.parse(FIXTURE_BYTES.toString('utf8')),
    JSON.parse(JSON.stringify(FIXTURE, (_key, value) =>
      value instanceof JsonFloatLiteral ? Number(value.source) : value
    ))
  );
});

for (const testCase of cases('makeUniqueNames')) {
  test(`makeUniqueNames: ${testCase.name}`, () => {
    const expected = testCase.expected;
    const run = () =>
      makeUniqueNames(testCase.names, { index: testCase.index, join: testCase.join });
    if (Object.hasOwn(expected, 'error')) {
      assertDataMappingError(run, expected.error);
      return;
    }
    const result = run();
    assert.deepEqual(result.names, expected.names);
    assert.deepEqual(result.renamed, expected.renamed);
    assert.equal(result.filledFromIndex, expected.filledFromIndex);
    assert.equal(new Set(result.names).size, result.names.length);
  });
}

cases('uniqueNamesNote').forEach((testCase, position) => {
  test(`uniqueNamesNote #${position}`, () => {
    assert.equal(
      uniqueNamesNote({
        filledFromIndex: testCase.filledFromIndex,
        renamed: testCase.renamed,
        source: testCase.source,
      }),
      testCase.expected
    );
  });
});

for (const testCase of cases('bestGuessTier')) {
  test(`bestGuessTier: ${testCase.key}`, () => {
    assert.equal(bestGuessTier(testCase.key), testCase.tier);
  });
}

for (const testCase of cases('embeddingSlots')) {
  test(`embeddingSlots: ${testCase.name}`, () => {
    const entries = testCase.obsm.map(entry => ({
      key: entry.key,
      width: entry.width,
      usable: entry.usable,
      reason: null,
    }));
    const failures = testCase.loadFailures;
    const checked = [];
    const loadCheck = (key, columns) => {
      checked.push([key, [...columns]]);
      return Object.hasOwn(failures, key) ? failures[key] : null;
    };
    const guess = resolveEmbeddingSlots(entries, {
      latentKey: testCase.latentKey,
      loadCheck,
    });
    assert.deepEqual(guess.slots, testCase.expected.slots);
    assert.deepEqual(guess.guessed, testCase.expected.guessed);
    assert.deepEqual(guess.rejected, testCase.expected.rejected);
    // A candidate is load-checked at most once, so the guess is bounded by the
    // candidate count.
    assert.equal(new Set(checked.map(([key]) => key)).size, checked.length);
  });
}

/**
 * The browser adapter resolves a file's slots with the same rule, running the
 * load-time check asynchronously on the values it reads, and enables the
 * representations the shared rule enables beside them. Every case must
 * resolve to the fixture's slots and guess, each failing candidate must be
 * read exactly once and never adopted, and a file with nothing plottable must
 * be refused.
 */
for (const testCase of cases('embeddingSlots')) {
  test(`embeddingSlots through the browser adapter: ${testCase.name}`, async () => {
    const nObs = 20;
    const widthByKey = new Map(testCase.obsm.map(entry => [entry.key, entry.width]));
    const reads = [];
    const loader = {
      nObs,
      nVars: 0,
      obsKeys: [],
      varNames: [],
      async getDatasetMetadata() {
        return {
          stats: { n_cells: nObs, n_genes: 0, n_obs_fields: 0 },
          probes: {
            nObs,
            nVars: 0,
            obsm: testCase.obsm.map(entry => (entry.usable
              ? { key: entry.key, storage: 'dense', shape: [nObs, entry.width], dtype: 'float32', numeric: true }
              : { key: entry.key, storage: 'dataframe', shape: null, dtype: 'object', numeric: false })),
            obsp: [],
            varColumns: [],
            X: null,
            layers: [],
            raw: null,
            log1p: null,
          },
          obs_fields: [],
        };
      },
      async readObsmColumns(key, columns) {
        reads.push(key);
        const width = widthByKey.get(key);
        assert.ok(columns.every(column => column < width));
        const values = new Float64Array(nObs * columns.length);
        for (let cell = 0; cell < nObs; cell++) {
          columns.forEach((column, index) => {
            values[cell * columns.length + index] = cell * (column + 1);
          });
        }
        const failure = testCase.loadFailures[key];
        if (failure !== undefined) {
          const [, kind, cell] = /^(NaN|-?Infinity) at cell (\d+)$/.exec(failure);
          values[Number(cell) * columns.length] = Number(kind);
        }
        return values;
      },
      close() {},
    };
    const adapter = new BaseAnnDataAdapter(withObsmPayloads(loader));
    const expected = testCase.expected;
    const filled = Object.values(expected.slots).some(ref => ref !== null);
    if (!filled) {
      await assert.rejects(
        adapter.initialize(),
        error => error.code === DataSourceErrorCode.NO_PLOTTABLE_EMBEDDING &&
          /^Cellucid found nothing to plot\./.test(error.message)
      );
      assert.deepEqual(reads, []);
      return;
    }
    await adapter.initialize();
    assert.deepEqual({ ...adapter._slots }, expected.slots);
    const candidates = adapter.getMappingCandidates();
    assert.deepEqual(candidates.guessed, expected.guessed);
    // The slots are the catalog's defaults, and the shared rule enables every
    // other narrow array beside them. A file read in the browser names no
    // latent space, so none is excluded as one.
    assert.deepEqual(candidates.defaults.embeddings.defaults, expected.slots);
    assert.deepEqual(
      candidates.defaults.embeddings.enabled,
      defaultEnabledEmbeddings(testCase.obsm, expected.slots, {
        latentKey: null,
        rejected: expected.rejected.map(([key]) => key),
      })
    );
    // A candidate is read at most once, and a rejected one is read and dropped.
    assert.equal(new Set(reads).size, reads.length);
    for (const [key] of expected.rejected) {
      assert.ok(reads.includes(key), `${key} was load-checked`);
      assert.ok(Object.values(adapter._slots).every(ref => ref?.key !== key));
    }
    if (expected.guessed.length === 0) {
      // The default rule is never load-checked: only the default dimension's
      // embedding is read, to validate it before the file is adopted.
      assert.equal(reads.length, 1);
    }
  });
}

cases('embeddingColumns').forEach((testCase, position) => {
  test(`embeddingColumns #${position}`, () => {
    const expected = testCase.expected;
    const run = () =>
      validateEmbeddingColumns(testCase.columns, {
        dimension: testCase.dimension,
        width: testCase.width,
      });
    if (Object.hasOwn(expected, 'error')) {
      assertDataMappingError(run, expected.error);
      return;
    }
    assert.deepEqual(run(), expected.columns);
  });
});

cases('canonicalEmbeddingId').forEach((testCase, position) => {
  test(`canonicalEmbeddingId #${position}: ${testCase.expected}`, () => {
    assert.equal(
      canonicalEmbeddingId(testCase.key, testCase.columns, { width: testCase.width }),
      testCase.expected
    );
  });
});

cases('defaultExpression').forEach((testCase, position) => {
  test(`defaultExpression #${position}`, () => {
    assert.deepEqual(
      defaultExpression({
        hasX: testCase.hasX,
        hasRaw: testCase.hasRaw,
        layers: testCase.layers,
      }),
      testCase.expected
    );
  });
});

for (const testCase of cases('vectorFieldKeys')) {
  test(`vectorFieldKeys: ${testCase.name}`, () => {
    const found = [...vectorFieldKeys(testCase.keys)]
      .map(([key, { field, basis }]) => ({ key, field, basis }));
    assert.deepEqual(found, testCase.expected);
    const keys = new Set(testCase.keys);
    for (const key of testCase.keys) {
      const parsed = parseVectorFieldKey(key, keys);
      const expected = testCase.expected.find(entry => entry.key === key);
      if (expected === undefined) {
        assert.equal(parsed, null, key);
      } else {
        assert.deepEqual(parsed, {
          field: expected.field,
          basis: expected.basis,
          embeddingKey: `X_${expected.basis}`,
        });
        assert.equal(`${parsed.field}_${parsed.basis}`, key);
      }
    }
  });
}

for (const testCase of cases('defaultVectorBindings')) {
  test(`defaultVectorBindings: ${testCase.name}`, () => {
    const bindings = defaultVectorBindings(testCase.obsm, testCase.enabled);
    assert.deepEqual(bindings, testCase.expected);
    assert.equal(JSON.stringify(bindings), JSON.stringify(testCase.expected));
    // The bindings are valid in a mapping that enables those embeddings.
    const enabled = [...testCase.enabled].sort(compareEmbeddingRefs);
    const defaults = { '1d': null, '2d': null, '3d': null };
    defaults[`${enabled[0].columns.length}d`] = enabled[0];
    const mapping = {
      kind: 'anndata',
      embeddings: { enabled, defaults },
      knn: null,
      geneNames: 'index',
      expression: null,
      log1p: {},
      highlyVariable: null,
      latent: null,
      vectorFields: bindings,
    };
    assert.deepEqual(validateDataMapping(mapping).vectorFields, bindings);
  });
}

cases('nothingPlottable').forEach((testCase, position) => {
  test(`nothingPlottable #${position}`, () => {
    const descriptions = testCase.obsm.map(entry => describeObsmEntry(entry));
    assert.equal(
      nothingPlottableMessage({ nObs: testCase.nObs, descriptions }),
      testCase.expected
    );
  });
});

for (const testCase of cases('enabledEmbeddings')) {
  test(`enabledEmbeddings: ${testCase.name}`, () => {
    const failures = testCase.loadFailures;
    const guess = resolveEmbeddingSlots(testCase.obsm, {
      latentKey: testCase.latentKey,
      loadCheck: key => failures[key] ?? null,
    });
    assert.deepEqual(
      defaultEnabledEmbeddings(testCase.obsm, guess.slots, {
        latentKey: testCase.latentKey,
        rejected: guess.rejected.map(([key]) => key),
      }),
      testCase.expected
    );
  });
}

for (const testCase of cases('dataMapping')) {
  test(`dataMapping: ${testCase.name}`, () => {
    const expected = testCase.expected;
    if (Object.hasOwn(expected, 'error')) {
      assertDataMappingError(() => validateDataMapping(testCase.value), expected.error);
      return;
    }
    const canonical = validateDataMapping(testCase.value);
    assert.deepEqual(canonical, expected);
    // The canonical form is a fixed point and is serialized key-for-key.
    assert.deepEqual(validateDataMapping(canonical), canonical);
    assert.deepEqual(Object.keys(canonical), Object.keys(expected));
    assert.equal(JSON.stringify(canonical), JSON.stringify(expected));
    // It is a fresh copy that shares nothing with its input.
    assert.notEqual(canonical.embeddings, testCase.value.embeddings);
    assert.notEqual(canonical.vectorFields, testCase.value.vectorFields);
  });
}

test('the best guess skips vector keys and the latent space by role', () => {
  const entries = [
    { key: 'velocity_scvi', width: 2, usable: true, reason: null },
    { key: 'X_scvi', width: 2, usable: true, reason: null },
  ];
  const guess = resolveEmbeddingSlots(entries, { latentKey: 'X_scvi' });
  assert.deepEqual(guess.slots, { '1d': null, '2d': null, '3d': null });
  const described = [
    { key: 'velocity_scvi', storage: 'dense', shape: [5, 2], usable: true, reason: null },
    { key: 'X_scvi', storage: 'dense', shape: [5, 2], usable: true, reason: null },
  ];
  const vectorKeys = vectorFieldKeys(described.map(item => item.key));
  const defects = described.map(item =>
    obsmEntryDefect(item, { latentKey: 'X_scvi', rejected: {}, vectorKeys })
  );
  assert.deepEqual(defects, ['a vector field', 'the latent space']);
});

// --- Rules where JavaScript's defaults differ from Python's -------------------

test('compareCodePoints orders astral characters by code point, as Python does', () => {
  const bmpHigh = '￿';
  const astral = '\u{1F600}';
  // UTF-16 code-unit order puts the surrogate pair first; code-point order
  // does not.
  assert.equal(astral < bmpHigh, true);
  assert.equal(compareCodePoints(bmpHigh, astral) < 0, true);
  assert.equal(compareCodePoints(astral, bmpHigh) > 0, true);
  assert.equal(compareCodePoints('a\u{1F600}', 'a\u{1F601}') < 0, true);
  assert.equal(compareCodePoints('ab', 'abc') < 0, true);
  assert.equal(compareCodePoints('abc', 'abc'), 0);
  assert.deepEqual(
    ['\u{10000}', '', 'b', 'a'].sort(compareCodePoints),
    ['a', 'b', '', '\u{10000}']
  );
  assert.deepEqual(
    bestGuessOrder(['X_tsne_\u{10000}', 'X_tsne_￿', 'X_umap']),
    ['X_umap', 'X_tsne_￿', 'X_tsne_\u{10000}']
  );
});

test('the vector key rule splits at any character, line breaks and astral ones included', () => {
  const keys = new Set(['X_umap', 'X_\u{1F600}']);
  assert.deepEqual(parseVectorFieldKey('a\r_umap', keys), { field: 'a\r', basis: 'umap', embeddingKey: 'X_umap' });
  assert.deepEqual(parseVectorFieldKey('a\n b_umap', keys), { field: 'a\n b', basis: 'umap', embeddingKey: 'X_umap' });
  assert.deepEqual(
    parseVectorFieldKey('\u{1F600}_\u{1F600}', keys),
    { field: '\u{1F600}', basis: '\u{1F600}', embeddingKey: 'X_\u{1F600}' }
  );
  assert.equal(parseVectorFieldKey('velocity_umap\n', keys), null);
  assert.equal(parseVectorFieldKey('X_umap', keys), null);
  assert.deepEqual([...DIMENSION_SLOTS], ['1d', '2d', '3d']);
});

// --- makeUniqueNames properties -----------------------------------------------

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

test('makeUniqueNames: random names come back distinct, stable and deterministic', () => {
  // A tiny alphabet with ready-made suffixes forces collisions with produced
  // and pre-existing `name-k` values.
  const alphabet = ['A', 'B', 'A-1', 'A-2', 'B-1', 'A-1-1', '', null, 'α', '\u{1F600}'];
  const random = seededRandom(20261019);
  for (let round = 0; round < 500; round += 1) {
    const length = Math.floor(random() * 30);
    const names = Array.from(
      { length },
      () => alphabet[Math.floor(random() * alphabet.length)]
    );
    const index = names.map((_, position) => `idx${position % 7}`);
    const result = makeUniqueNames(names, { index });

    assert.equal(result.names.length, names.length);
    assert.equal(new Set(result.names).size, result.names.length, JSON.stringify(names));

    const seen = new Set();
    let renamedCount = 0;
    result.filled.forEach((name, position) => {
      if (!seen.has(name)) {
        seen.add(name);
        assert.equal(result.names[position], name, 'a first occurrence keeps its name');
      } else {
        assert.notEqual(result.names[position], name);
        assert.ok(result.names[position].startsWith(`${name}-`));
        assert.deepEqual(result.renamed[renamedCount], [name, result.names[position]]);
        renamedCount += 1;
      }
    });
    assert.equal(renamedCount, result.renamed.length);
    assert.equal(
      result.filledFromIndex,
      names.filter(name => name === '' || name === null).length
    );

    assert.deepEqual(makeUniqueNames(names, { index }), result);
    // Making a unique list unique again changes nothing.
    assert.deepEqual(makeUniqueNames(result.names).names, result.names);
  }
});
