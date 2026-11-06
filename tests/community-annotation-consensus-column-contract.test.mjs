import assert from 'node:assert/strict';
import test from 'node:test';

import {
  consensusColumnStatus,
  consensusProvenanceOf,
  createConsensusColumnApplier,
  defaultConsensusColumnKey,
  repositoryConsensusSettings,
} from '../assets/js/app/ui/modules/community-annotation/consensus-column.js';
import { consensusColumnOf, statusCategoryName } from '../assets/js/app/community-annotations/consensus-codes.js';

const SOURCE_KEY = 'cell_type';
const TARGET_KEY = 'community_cell_type';

const agreed = label => ({ status: 'consensus', label });
const disputed = { status: 'disputed', label: null };
const pending = { status: 'pending', label: null };

// ---------------------------------------------------------------- the codes

test('a fully resolved consensus column declares no empty Pending category', () => {
  const column = consensusColumnOf({ outcomes: [agreed('Consensus 0'), agreed('Consensus 1'), agreed('Consensus 2')], codes: Uint8Array.from([0, 1, 2, 1, 0]) });
  assert.deepEqual(column.categories, ['Consensus 0', 'Consensus 1', 'Consensus 2'],
    'a derived column with nothing pending must not carry a zero-cell "Pending" category');
  assert.deepEqual([...column.codes], [0, 1, 2, 1, 0]);
});

test('a missing source code still resolves to Pending', () => {
  // 255 is the Uint8Array "missing category" sentinel.
  const column = consensusColumnOf({ outcomes: [agreed('Resolved'), agreed('Resolved')], codes: Uint8Array.from([0, 255, 1]) });
  assert.deepEqual(column.categories, ['Resolved', 'Pending']);
  assert.deepEqual([...column.codes], [0, 1, 0]);
});

test('a disputed or pending category keeps its status exactly once; a category with no outcome is pending', () => {
  const column = consensusColumnOf({ outcomes: [agreed('Resolved'), disputed, pending, null, disputed], codes: Uint8Array.from([0, 1, 2, 3, 4]) });
  assert.deepEqual(column.categories, ['Resolved', 'Disputed', 'Pending']);
  assert.deepEqual([...column.codes], [0, 1, 2, 2, 1]);
});

test('a label agreed as literally "Pending" or "Disputed" never merges with a status', () => {
  // The audit's repro (consensus-sentinels.mjs): the community agreed on "Pending" for one category,
  // nobody voted on another, and agreed on "Disputed" for a third.
  const column = consensusColumnOf({ outcomes: [agreed('Pending'), pending, agreed('Disputed'), disputed], codes: Uint8Array.from([0, 1, 2, 3]) });
  assert.deepEqual(column.categories, ['Pending', 'Disputed', 'Disputed (status)', 'Pending (status)']);
  const codes = [...column.codes];
  assert.equal(new Set(codes).size, 4, 'four outcomes, four categories');
  assert.equal(column.categories[codes[0]], 'Pending');
  assert.equal(column.categories[codes[1]], 'Pending (status)');
  assert.equal(column.categories[codes[2]], 'Disputed');
  assert.equal(column.categories[codes[3]], 'Disputed (status)');
  // A label taking the first fallback too: the status moves on again.
  assert.equal(statusCategoryName('pending', new Set(['Pending', 'Pending (status)'])), 'Pending (status 2)');
  assert.equal(statusCategoryName('disputed', new Set(['T cell'])), 'Disputed');
});

test('labels that differ only in Unicode form are one category, named as the first category spells it', () => {
  const composed = 'Ependymal cell \u00e9';
  const decomposed = 'Ependymal cell e\u0301';
  assert.notEqual(composed, decomposed);
  const column = consensusColumnOf({ outcomes: [agreed(composed), agreed(decomposed), agreed('Ependymal cell E\u0301')], codes: Uint8Array.from([0, 1, 2]) });
  // Case is not folded: "É" stays its own label.
  assert.deepEqual(column.categories, [composed, 'Ependymal cell E\u0301']);
  assert.deepEqual([...column.codes], [0, 0, 1]);
  // A label agreed as "Pending" in another Unicode form still never merges with the status.
  const status = consensusColumnOf({ outcomes: [agreed('Pending'), pending], codes: Uint8Array.from([0, 1]) });
  assert.deepEqual(status.categories, ['Pending', 'Pending (status)']);
});

test('the widest Uint8 consensus column is built rather than refused', () => {
  // 255 resolved labels is exactly the widest field a Uint8Array can carry
  // while keeping 255 free as the missing-category sentinel.
  const n = 255;
  const column = consensusColumnOf({
    outcomes: Array.from({ length: n }, (_unused, index) => agreed(`Resolved ${index}`)),
    codes: Uint8Array.from({ length: n }, (_unused, index) => index),
  });
  assert.equal(column.categories.length, n);
  assert.ok(column.codes instanceof Uint8Array, '255 categories still fit a Uint8Array');
  assert.deepEqual([...column.codes], Array.from({ length: n }, (_unused, index) => index));
});

test('a Uint16 source field folds to the width its own derived inventory needs', () => {
  const n = 300;
  const codes = Uint16Array.from({ length: n + 1 }, (_unused, index) => (index === n ? 65535 : index));
  const column = consensusColumnOf({ outcomes: Array.from({ length: n }, () => agreed('Resolved')), codes });
  assert.deepEqual(column.categories, ['Resolved', 'Pending']);
  assert.ok(column.codes instanceof Uint8Array, 'a two-category derived column is a Uint8 field however wide its source was');
  assert.equal(column.codes[n], 1, 'the missing cell is Pending');
  assert.ok(column.codes.slice(0, n).every(code => code === 0));
});

test('a code outside the categories is refused', () => {
  assert.throws(() => consensusColumnOf({ outcomes: [agreed('A')], codes: [0, 3] }), /cell 1 is outside/);
});

// ---------------------------------------------------------------- building it

/**
 * The applier with a source column (renamed here when `renamed`), a session
 * with a scripted consensus per category, and a dispatcher that keeps what
 * it is asked to build.
 */
function harness({ categories = ['a', 'b', 'c'], consensusFor, renamed = false, settings = { minAnnotators: 2, threshold: 0.6 } } = {}) {
  const field = renamed
    ? { kind: 'category', key: 'Cell type', _originalKey: SOURCE_KEY, categories: categories.map(label => `${label}!`), _originalCategories: categories }
    : { kind: 'category', key: SOURCE_KEY, categories };
  const dispatched = [];
  const asked = [];
  const notices = { error: [], success: [] };
  const session = {
    registered: null,
    setFieldCategories(key, list) { this.registered = { key, list: [...list] }; },
    computeConsensus(key, index, rule) {
      asked.push({ key, index, rule });
      return { ...consensusFor(index), voters: index + 1 };
    },
    getAnnotatableConsensusSettings: key => (key === SOURCE_KEY ? settings : null),
    getRepoRef: () => 'lab/annotations@main',
    getLastPullAt: () => '2026-11-05T10:00:00.000Z',
    isFieldAnnotated: key => key === SOURCE_KEY,
  };
  const state = { getFields: () => [field], ensureFieldLoaded: async () => {} };
  const actions = {
    async dispatch(type, params) {
      assert.equal(type, 'field.consensus');
      dispatched.push(params);
      return { outcome: { name: params.key, of: params.field.key, replaced: false }, step: null };
    },
  };
  const apply = createConsensusColumnApplier({
    state,
    session,
    notifications: { error: message => notices.error.push(message), success: message => notices.success.push(message) },
    actions,
  });
  return { apply, dispatched, asked, notices, session, state, field };
}

test('building names the outcome of each category, the rule and where the votes came from', async () => {
  const h = harness({ consensusFor: index => [agreed('T cell'), disputed, pending][index] });
  await h.apply(() => ({ sourceFieldKey: SOURCE_KEY, columnKey: TARGET_KEY, minAnnotators: 2, threshold: 0.6 }));
  assert.deepEqual(h.dispatched, [{
    key: TARGET_KEY,
    field: { source: 'obs', key: SOURCE_KEY },
    mapping: [
      { category: 'a', status: 'consensus', label: 'T cell', voters: 1 },
      { category: 'b', status: 'disputed', label: null, voters: 2 },
      { category: 'c', status: 'pending', label: null, voters: 3 },
    ],
    settings: { minAnnotators: 2, threshold: 0.6 },
    provenance: { repository: 'lab/annotations', branch: 'main', commit: null, pulledAt: '2026-11-05T10:00:00.000Z' },
  }]);
  assert.ok(h.asked.every(({ rule }) => rule.minAnnotators === 2 && rule.threshold === 0.6));
  assert.deepEqual(h.notices.success, [`Updated consensus column: ${TARGET_KEY}`]);
});

test('a local rename is a display name: the session is keyed on the dataset\'s names, the step names what is shown', async () => {
  const h = harness({ renamed: true, consensusFor: () => agreed('T cell') });
  await h.apply(() => ({ sourceFieldKey: SOURCE_KEY, columnKey: TARGET_KEY, minAnnotators: 1, threshold: 0.5 }));
  assert.deepEqual(h.session.registered, { key: SOURCE_KEY, list: ['a', 'b', 'c'] });
  assert.ok(h.asked.every(({ key }) => key === SOURCE_KEY));
  assert.deepEqual(h.dispatched[0].field, { source: 'obs', key: 'Cell type' });
  assert.deepEqual(h.dispatched[0].mapping.map(entry => entry.category), ['a!', 'b!', 'c!']);
});

test('the controls that are not the page\'s own build no column, and say so', async () => {
  const notices = [];
  const apply = createConsensusColumnApplier({
    state: { getFields: () => [] },
    session: {},
    notifications: { error: message => notices.push(message), success: () => {} },
    actions: null,
  });
  await apply(() => ({ sourceFieldKey: SOURCE_KEY, columnKey: TARGET_KEY, minAnnotators: 1, threshold: 0.5 }));
  assert.equal(notices.length, 1);
  assert.throws(() => createConsensusColumnApplier({ state: {}, session: {}, notifications: {}, actions: {} }), /action dispatcher/);
});

test('the defaults are the column\'s repository rule and community_<column>', () => {
  const session = { getAnnotatableConsensusSettings: key => (key === SOURCE_KEY ? { minAnnotators: 3, threshold: 0.25 } : null) };
  assert.deepEqual(repositoryConsensusSettings(session, SOURCE_KEY), { minAnnotators: 3, threshold: 0.25 });
  assert.deepEqual(repositoryConsensusSettings(session, 'other'), { minAnnotators: 1, threshold: 0.5 });
  assert.equal(defaultConsensusColumnKey({ key: 'leiden' }), 'community_leiden');
  assert.deepEqual(consensusProvenanceOf({ getRepoRef: () => null, getLastPullAt: () => null }),
    { repository: null, branch: null, commit: null, pulledAt: null });
});

// ---------------------------------------------------------------- stale

test('a column built is stale once the consensus of its column changes (a Pull, a vote)', async () => {
  let outcomes = [agreed('T cell'), pending, pending];
  const h = harness({ renamed: true, consensusFor: index => outcomes[index] });
  const built = {
    key: TARGET_KEY, kind: 'category', _isUserDefined: true,
    _operation: {
      type: 'community-consensus', fieldKey: SOURCE_KEY,
      outcomes: [{ category: 'a', status: 'consensus', label: 'T cell' }, { category: 'b', status: 'pending', label: null }, { category: 'c', status: 'pending', label: null }],
      settings: { minAnnotators: 1, threshold: 0.5 }, provenance: {},
    },
  };
  const state = { getFields: () => [h.field, built] };
  assert.deepEqual(consensusColumnStatus(state, h.session), [{ key: TARGET_KEY, fieldKey: SOURCE_KEY, of: 'Cell type', stale: false, missing: false, changed: 0 }]);
  // A Pull brings votes that settle "b" and change "a".
  outcomes = [agreed('CD4 T cell'), agreed('B cell'), pending];
  assert.deepEqual(consensusColumnStatus(state, h.session), [{ key: TARGET_KEY, fieldKey: SOURCE_KEY, of: 'Cell type', stale: true, missing: false, changed: 2 }]);
  assert.ok(h.asked.slice(-3).every(({ rule }) => rule.minAnnotators === 1 && rule.threshold === 0.5), 'judged by the rule it was built with');
  // Its column gone: not stale, missing.
  const without = { getFields: () => [built] };
  assert.equal(consensusColumnStatus(without, h.session)[0].missing, true);
});
