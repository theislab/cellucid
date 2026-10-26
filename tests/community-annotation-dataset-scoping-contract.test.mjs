import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertMergesFile,
  assertUserFile,
  composeMergesFile,
  composeUserFile,
  projectMergesFile,
  projectUserFile,
} from '../assets/js/app/community-annotations/wire-contract.js';

// Two datasets in one annotation repository can share a field and a category
// label ("leiden" / "0"). Everything a contributor writes is kept per
// dataset, so neither dataset ever sees the other's suggestions, votes or
// merges, and publishing one never drops the other.

const AT = '2026-10-22T10:00:00.000Z';

function view(datasetId, label, vote = 'up') {
  const id = `${datasetId}-suggestion`;
  return {
    version: 1,
    username: 'ghid_7',
    githubUserId: 7,
    login: 'researcher',
    updatedAt: AT,
    datasets: { [datasetId]: { fieldsToAnnotate: ['leiden'], lastAccessedAt: AT } },
    suggestions: {
      'leiden:0': [{ id, label, proposedBy: 'ghid_7', proposedAt: AT }],
    },
    votes: { [id]: vote },
  };
}

test('a user file keeps each dataset in its own section', () => {
  const first = composeUserFile(null, 'atlas-a', view('atlas-a', 'T cell'));
  const both = composeUserFile(first, 'atlas-b', view('atlas-b', 'B cell', 'down'));
  assertUserFile(both);
  assert.equal(both.version, 2);
  assert.deepEqual(Object.keys(both.datasets).sort(), ['atlas-a', 'atlas-b']);
  assert.deepEqual(both.datasets['atlas-a'], first.datasets['atlas-a'],
    'publishing dataset B keeps dataset A byte for byte');

  const a = projectUserFile(both, 'atlas-a');
  const b = projectUserFile(both, 'atlas-b');
  assert.deepEqual(a.suggestions['leiden:0'].map(s => s.label), ['T cell']);
  assert.deepEqual(b.suggestions['leiden:0'].map(s => s.label), ['B cell']);
  assert.deepEqual(a.votes, { 'atlas-a-suggestion': 'up' });
  assert.deepEqual(b.votes, { 'atlas-b-suggestion': 'down' });

  const other = projectUserFile(both, 'atlas-c');
  assert.deepEqual(other.suggestions, {});
  assert.deepEqual(other.votes, {});
  assert.equal(Object.hasOwn(other, 'datasets'), false);
  assert.equal(other.login, 'researcher', 'the profile is shared by every dataset');
});

test('republishing a dataset replaces only its own section', () => {
  const both = composeUserFile(
    composeUserFile(null, 'atlas-a', view('atlas-a', 'T cell')),
    'atlas-b',
    view('atlas-b', 'B cell'),
  );
  const cleared = { ...view('atlas-a', 'T cell'), suggestions: {}, votes: {} };
  const next = composeUserFile(both, 'atlas-a', cleared);
  assert.deepEqual(next.datasets['atlas-a'].suggestions, {});
  assert.deepEqual(next.datasets['atlas-b'], both.datasets['atlas-b']);
});

test('a view cannot be composed onto another contributor\'s file', () => {
  const someone = composeUserFile(null, 'atlas-a', view('atlas-a', 'T cell'));
  const other = { ...view('atlas-a', 'T cell'), username: 'ghid_8', githubUserId: 8 };
  other.suggestions['leiden:0'][0].proposedBy = 'ghid_8';
  assert.throws(() => composeUserFile(someone, 'atlas-a', other), /same contributor/);
});

test('a version 1 user file is refused, not read as one dataset', () => {
  const legacy = { ...view('atlas-a', 'T cell') };
  assert.throws(() => assertUserFile(legacy), /unknown field|must equal 2/);
});

function mergesView(from, into) {
  return {
    version: 1,
    updatedAt: AT,
    merges: [{ bucket: 'leiden:0', fromSuggestionId: from, intoSuggestionId: into, by: 'ghid_7', at: AT }],
  };
}

test('merges are kept per dataset and never applied to another', () => {
  const a = composeMergesFile(null, 'atlas-a', mergesView('x', 'y'));
  const both = composeMergesFile(a, 'atlas-b', mergesView('y', 'x'));
  // The same bucket merged in opposite directions is a cycle only within one
  // dataset; across datasets the two merges are independent.
  assertMergesFile(both);
  assert.deepEqual(projectMergesFile(both, 'atlas-a').merges, mergesView('x', 'y').merges);
  assert.deepEqual(projectMergesFile(both, 'atlas-b').merges, mergesView('y', 'x').merges);
  assert.deepEqual(projectMergesFile(both, 'atlas-c').merges, []);

  const cycle = { ...both, merges: [...both.merges, { ...both.merges[0], fromSuggestionId: 'y', intoSuggestionId: 'x' }] };
  assert.throws(() => assertMergesFile(cycle), /cycle/);
  assert.throws(
    () => assertMergesFile({ ...both, merges: [{ ...mergesView('x', 'y').merges[0] }] }),
    /datasetId/,
  );
});
