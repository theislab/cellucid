import assert from 'node:assert/strict';
import test from 'node:test';

import { createConsensusColumnApplier } from '../assets/js/app/ui/modules/community-annotation/consensus-column.js';

const SOURCE_KEY = 'cell_type';
const TARGET_KEY = 'community_cell_type';

/**
 * Build the three collaborators the applier needs, with a source categorical
 * field and a scripted per-category consensus outcome.
 *
 * @param {object} options
 * @param {string[]} options.categories Source category labels.
 * @param {Uint8Array|Uint16Array} options.codes Per-cell source codes.
 * @param {(index: number) => object} options.consensusFor Consensus per category.
 */
function createHarness({ categories, codes, consensusFor }) {
  const upserts = [];
  const notices = { error: [], success: [] };
  const field = { kind: 'category', key: SOURCE_KEY, categories, codes };
  const state = {
    getFields: () => [field],
    ensureFieldLoaded: async () => {},
    upsertUserDefinedCategoricalField(options) {
      // Mirror the owning validator: a Uint8Array reserves 255 for "missing",
      // so a user-defined field may declare at most 255 categories.
      if (options.categories.length > 255) {
        throw new TypeError(
          'User-defined categorical upsert categories must contain from 1 through 255 values'
        );
      }
      upserts.push(options);
      return { key: options.key, updatedInPlace: false };
    },
  };
  const session = {
    setFieldCategories() {},
    computeConsensus: (_fieldKey, index) => consensusFor(index),
  };
  const notifications = {
    error: (message) => notices.error.push(message),
    success: (message) => notices.success.push(message),
  };
  const applyConsensusColumn = createConsensusColumnApplier({
    state,
    session,
    notifications,
  });
  const readSettings = () => ({
    consensusSourceFieldKey: SOURCE_KEY,
    selectedFieldKey: SOURCE_KEY,
    consensusColumnKey: TARGET_KEY,
    consensusColumnMinAnnotators: 1,
    consensusColumnThreshold: 0.5,
  });
  return {
    apply: () => applyConsensusColumn(readSettings),
    upserts,
    notices,
  };
}

test('a fully resolved consensus column declares no empty Pending category', async () => {
  const harness = createHarness({
    categories: ['a', 'b', 'c'],
    codes: Uint8Array.from([0, 1, 2, 1, 0]),
    consensusFor: (index) => ({
      status: 'consensus',
      label: `Consensus ${index}`,
    }),
  });

  await harness.apply();

  assert.equal(harness.upserts.length, 1);
  const [upsert] = harness.upserts;
  assert.deepEqual(
    upsert.categories,
    ['Consensus 0', 'Consensus 1', 'Consensus 2'],
    'a derived column with nothing pending must not carry a zero-cell "Pending" category'
  );
  assert.deepEqual(
    Array.from(upsert.codes),
    [0, 1, 2, 1, 0]
  );
});

test('a missing source code still resolves to Pending', async () => {
  const harness = createHarness({
    categories: ['a', 'b'],
    // 255 is the Uint8Array "missing category" sentinel.
    codes: Uint8Array.from([0, 255, 1]),
    consensusFor: () => ({ status: 'consensus', label: 'Resolved' }),
  });

  await harness.apply();

  const [upsert] = harness.upserts;
  assert.deepEqual(upsert.categories, ['Resolved', 'Pending']);
  assert.deepEqual(Array.from(upsert.codes), [0, 1, 0]);
});

test('a disputed or pending bucket keeps its reserved label exactly once', async () => {
  const harness = createHarness({
    categories: ['a', 'b', 'c'],
    codes: Uint8Array.from([0, 1, 2]),
    consensusFor: (index) => (
      index === 0
        ? { status: 'consensus', label: 'Resolved' }
        : index === 1
          ? { status: 'disputed', label: 'ignored' }
          : { status: 'pending', label: null }
    ),
  });

  await harness.apply();

  const [upsert] = harness.upserts;
  assert.deepEqual(upsert.categories, ['Resolved', 'Disputed', 'Pending']);
  assert.deepEqual(Array.from(upsert.codes), [0, 1, 2]);
});

test('the widest Uint8 consensus column is built rather than refused', async () => {
  // 255 resolved labels is exactly the widest field a Uint8Array can carry
  // while keeping 255 free as the missing-category sentinel. Reserving a
  // "Pending" slot that no cell uses would push this over the limit.
  const categoryCount = 255;
  const categories = Array.from(
    { length: categoryCount },
    (_unused, index) => `source-${index}`
  );
  const codes = Uint8Array.from(
    { length: categoryCount },
    (_unused, index) => index
  );
  const harness = createHarness({
    categories,
    codes,
    consensusFor: (index) => ({
      status: 'consensus',
      label: `Resolved ${index}`,
    }),
  });

  await harness.apply();

  assert.deepEqual(harness.notices.error, []);
  assert.equal(harness.upserts.length, 1);
  const [upsert] = harness.upserts;
  assert.equal(upsert.categories.length, categoryCount);
  assert.ok(
    upsert.codes instanceof Uint8Array,
    '255 categories still fit a Uint8Array'
  );
  assert.deepEqual(
    Array.from(upsert.codes),
    Array.from({ length: categoryCount }, (_unused, index) => index)
  );
});

test('a Uint16 source field folds to the width its own derived inventory needs', async () => {
  const categoryCount = 300;
  const categories = Array.from(
    { length: categoryCount },
    (_unused, index) => `source-${index}`
  );
  // One trailing cell carries the Uint16 missing-category sentinel.
  const codes = Uint16Array.from(
    { length: categoryCount + 1 },
    (_unused, index) => (index === categoryCount ? 65535 : index)
  );
  const harness = createHarness({
    categories,
    codes,
    // Fold every source category into one shared consensus label: the derived
    // width follows the derived inventory, not the source inventory.
    consensusFor: () => ({ status: 'consensus', label: 'Resolved' }),
  });

  await harness.apply();

  const [upsert] = harness.upserts;
  assert.deepEqual(upsert.categories, ['Resolved', 'Pending']);
  assert.ok(
    upsert.codes instanceof Uint8Array,
    'a two-category derived column is a Uint8 field however wide its source was'
  );
  assert.equal(upsert.codes.length, categoryCount + 1);
  assert.equal(upsert.codes[categoryCount], 1, 'the missing cell is Pending');
  assert.ok(
    upsert.codes.slice(0, categoryCount).every((code) => code === 0)
  );
});
