// What the person has published, what is not published yet, and a vote
// published alone (B1 and should-fix 4 of the community annotation UI audit,
// 2026-11-05): an agent's vote writes the file as published plus that vote,
// never the person's drafts; a vote that changes nothing writes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  differingMerges,
  ownUserFilePath,
  pendingChangesOf,
  pendingDetail,
  pendingLine,
  publishedBaseline,
  sameJson,
  setPublishedBaseline,
  withOneSuggestion,
  withOneVote,
} from '../assets/js/app/ui/modules/community-annotation/published-baseline.js';
import { assertUserDocument, composeUserFile } from '../assets/js/app/community-annotations/wire-contract.js';

const AT = '2026-07-29T00:00:00.000Z';
const NOW = '2026-11-05T12:00:00.000Z';
const SCOPE = { datasetId: 'pancreas', repoRef: 'team/labels@main', userId: 42 };

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function view(extra = {}) {
  return {
    version: 1, username: 'ghid_42', githubUserId: 42, login: 'tester', displayName: 'Tess', updatedAt: AT,
    suggestions: {
      'cell_type:alpha': [{ id: 'ghid_42_own', label: 'Alpha cell', proposedBy: 'ghid_42', proposedAt: AT, ontologyId: null, evidence: null, editedAt: null, markers: null }],
    },
    votes: { 'ghid_42_own': 'up', 'ghid_7_other': 'down' },
    ...extra,
  };
}

test('a vote alone is the published view plus that vote, nothing else', () => {
  const published = view();
  const up = withOneVote(published, { githubUserId: 42, login: 'tester', suggestionId: 'ghid_7_other', direction: 'up', now: NOW });
  assert.deepEqual(up.votes, { 'ghid_42_own': 'up', 'ghid_7_other': 'up' });
  assert.equal(up.updatedAt, NOW);
  assert.deepEqual(up.suggestions, published.suggestions, 'the suggestions stay as published');
  assert.equal(up.displayName, 'Tess', 'the profile stays as published');
  assertUserDocument(up, { path: '$ vote', filename: 'ghid_42.json' });

  const withdrawn = withOneVote(published, { githubUserId: 42, login: 'tester', suggestionId: 'ghid_7_other', direction: null, now: NOW });
  assert.deepEqual(withdrawn.votes, { 'ghid_42_own': 'up' });

  // Already so: the view comes back unchanged, updatedAt included, so the
  // composed file equals the published one and nothing is written.
  const same = withOneVote(published, { githubUserId: 42, login: 'tester', suggestionId: 'ghid_42_own', direction: 'up', now: NOW });
  assert.equal(same, published);
});

test('a first vote of a person with no file makes a file of that vote and their login only', () => {
  const first = withOneVote(null, { githubUserId: 42, login: 'tester', suggestionId: 'ghid_7_other', direction: 'down', now: NOW });
  assert.deepEqual(first, {
    version: 1, username: 'ghid_42', githubUserId: 42, login: 'tester', updatedAt: NOW, suggestions: {}, votes: { 'ghid_7_other': 'down' },
  });
  const file = composeUserFile(null, 'pancreas', first, { path: 'annotations/users/ghid_42.json', filename: 'ghid_42.json' });
  assert.deepEqual(file.datasets.pancreas.votes, { 'ghid_7_other': 'down' });
});

test('what is not published is counted item by item against the published view', () => {
  const published = view();
  const local = view({
    displayName: 'Tess T.',
    votes: { 'ghid_42_own': 'up', 'ghid_7_other': 'up', 'ghid_42_new': 'down' },
    suggestions: {
      'cell_type:alpha': published.suggestions['cell_type:alpha'],
      'cell_type:gamma': [{ id: 'ghid_42_draft', label: 'Draft', proposedBy: 'ghid_42', proposedAt: NOW, ontologyId: null, evidence: null, editedAt: null, markers: null }],
    },
    comments: { 'ghid_7_other': [{ id: 'c1', text: 'why?', createdAt: NOW }] },
    deletedSuggestions: { 'cell_type:beta': ['ghid_7_gone'] },
  });
  const counts = pendingChangesOf({ local, published, settingsChanged: true, mergesChanged: 2 });
  assert.deepEqual(counts, { votes: 2, suggestions: 1, comments: 1, deletions: 1, profile: 1, settings: 1, merges: 2, total: 9 });
  assert.equal(pendingLine(counts), '9 changes not published');
  assert.equal(pendingDetail(counts), '2 votes, 1 suggestion, 1 comment, 1 deletion, 1 profile change, 1 repository setting change, 2 merges');

  assert.equal(pendingChangesOf({ local: published, published }).total, 0);
  assert.equal(pendingLine(pendingChangesOf({ local: published, published })), null);
  // Not known (no Pull since the cache was cleared): no count at all, never a wrong one.
  assert.equal(pendingChangesOf({ local, published: undefined }), null);
  // Nothing published yet: everything of the person's counts (1 suggestion, 2 votes, the profile).
  assert.equal(pendingChangesOf({ local: view(), published: null }).total, 4);
});

test('key order never makes two equal values differ', () => {
  assert.equal(sameJson({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }), true);
  assert.equal(sameJson({ a: 1 }, { a: 2 }), false);
  const merge = { bucket: 'cell_type:alpha', fromSuggestionId: 'x', intoSuggestionId: 'y', by: 'ghid_1', at: AT, note: null };
  assert.equal(differingMerges([merge], [{ ...merge }]), 0);
  assert.equal(differingMerges([merge], []), 1);
  assert.equal(differingMerges([{ ...merge, note: 'n' }], [merge]), 1);
});

test('the published view counts only while its SHA is the one the session knows', () => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  try {
    const path = ownUserFilePath(42);
    assert.equal(path, 'annotations/users/ghid_42.json');
    assert.equal(publishedBaseline(SCOPE, {}), undefined, 'nothing kept: not known');
    setPublishedBaseline(SCOPE, { sha: 'a'.repeat(40), view: view() });
    assert.deepEqual(publishedBaseline(SCOPE, { [path]: 'a'.repeat(40) }), view());
    // Published from another device (a newer SHA), or the cache cleared (no SHA): not known.
    assert.equal(publishedBaseline(SCOPE, { [path]: 'b'.repeat(40) }), undefined);
    assert.equal(publishedBaseline(SCOPE, {}), undefined);
    // Nothing published yet is known too.
    setPublishedBaseline(SCOPE, { sha: null, view: null });
    assert.equal(publishedBaseline(SCOPE, {}), null);
    // Another scope keeps its own.
    assert.equal(publishedBaseline({ ...SCOPE, repoRef: 'team/other@main' }, {}), undefined);
  } finally {
    globalThis.localStorage = previous;
  }
});

test('a suggestion alone is the published view plus that suggestion and its upvote', () => {
  const published = view();
  const added = { id: 'ghid_42_new', label: 'Gamma cell', proposedBy: 'ghid_42', proposedAt: NOW, ontologyId: null, evidence: null, editedAt: null, markers: null };
  const next = withOneSuggestion(published, { githubUserId: 42, login: 'tester', bucket: 'cell_type:gamma', suggestion: added, now: NOW });
  assert.deepEqual(next.suggestions['cell_type:gamma'], [added]);
  assert.deepEqual(next.suggestions['cell_type:alpha'], published.suggestions['cell_type:alpha']);
  assert.deepEqual(next.votes, { ...published.votes, 'ghid_42_new': 'up' });
  assertUserDocument(next, { path: '$ suggestion', filename: 'ghid_42.json' });
  assert.equal(withOneSuggestion(next, { githubUserId: 42, login: 'tester', bucket: 'cell_type:gamma', suggestion: added, now: '2027-01-01T00:00:00.000Z' }), next, 'already there: unchanged');
  const first = withOneSuggestion(null, { githubUserId: 42, login: 'tester', bucket: 'cell_type:gamma', suggestion: added, now: NOW });
  assert.deepEqual(Object.keys(first.suggestions), ['cell_type:gamma']);
});
