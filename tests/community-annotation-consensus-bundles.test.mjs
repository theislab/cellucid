/**
 * Consensus over bundled suggestions (audit B3 and its neighbours).
 *
 * - Equal labels (Unicode NFC, nothing else folded) are one bundle: two
 *   people who propose "T cell" independently agree, they do not tie.
 * - A majority split across duplicate suggestions is counted whole.
 * - Votes are de-duplicated per user across a bundle (majority; a tie is no vote).
 * - Zero voters never make a consensus.
 * - Derived results are memoised per session revision and follow every change.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(String(key)) ? values.get(String(key)) : null),
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
    values,
  };
}
globalThis.localStorage = memoryStorage();
globalThis.sessionStorage = memoryStorage();

const { CommunityAnnotationSession, RemoteUserFiles } = await import(
  '../assets/js/app/community-annotations/session.js'
);

const T0 = '2026-01-01T00:00:00Z';
const T1 = '2026-01-02T00:00:00Z';
const ME = 99;

function view(id, { suggestions = {}, votes = {} } = {}) {
  return {
    version: 1,
    username: `ghid_${id}`,
    githubUserId: id,
    updatedAt: T0,
    datasets: { ds: { fieldsToAnnotate: ['leiden'], lastAccessedAt: T0 } },
    suggestions,
    votes,
  };
}

function sugg(owner, key, label, at = T0) {
  return { id: `ghid_${owner}_${key}`, label, proposedBy: `ghid_${owner}`, proposedAt: at };
}

const id = (owner, key) => `ghid_${owner}_${key}`;

// No cache scope: a scoped session holds the cross-tab lock, whose renewal
// timer would keep the test process alive; the identity comes from the profile.
function session() {
  const s = new CommunityAnnotationSession();
  s.setProfile({ username: `ghid_${ME}`, login: 'me', githubUserId: ME });
  s.setFieldCategories('leiden', ['0']);
  return s;
}

const SETTINGS = { minAnnotators: 1, threshold: 0.5 };

test('two independent proposals of one label are one consensus, not a tie', () => {
  const s = session();
  s.mergeFromUserFiles([
    view(1, { suggestions: { 'leiden:0': [sugg(1, 'a', 'T cell')] }, votes: { [id(1, 'a')]: 'up' } }),
    view(2, { suggestions: { 'leiden:0': [sugg(2, 'b', 'T cell', T1)] }, votes: { [id(2, 'b')]: 'up' } }),
  ]);
  const c = s.computeConsensus('leiden', '0', SETTINGS);
  assert.equal(c.status, 'consensus');
  assert.equal(c.label, 'T cell');
  assert.equal(c.voters, 2);
  assert.equal(c.netVotes, 2);
  // The earliest proposal is the bundle's main suggestion.
  assert.equal(c.suggestionId, id(1, 'a'));
  const shown = s.getSuggestions('leiden', '0');
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0].mergedFrom.map((m) => [m.id, m.bundledBy]), [[id(2, 'b'), 'label']]);
});

test('a majority split across duplicate suggestions is counted whole', () => {
  const s = session();
  s.mergeFromUserFiles([
    view(1, { suggestions: { 'leiden:0': [sugg(1, 'a', 'T cell')] }, votes: { [id(1, 'a')]: 'up' } }),
    view(2, { suggestions: { 'leiden:0': [sugg(2, 'b', 'T cell')] }, votes: { [id(2, 'b')]: 'up' } }),
    view(3, { votes: { [id(1, 'a')]: 'up' } }),
    view(4, { votes: { [id(2, 'b')]: 'up' } }),
    view(5, { suggestions: { 'leiden:0': [sugg(5, 'c', 'NK cell')] }, votes: { [id(5, 'c')]: 'up' } }),
    view(6, { votes: { [id(5, 'c')]: 'up' } }),
    view(7, { votes: { [id(5, 'c')]: 'up' } }),
  ]);
  const c = s.computeConsensus('leiden', '0', { minAnnotators: 1, threshold: 0.4 });
  assert.equal(c.label, 'T cell');
  assert.equal(c.netVotes, 4);
  assert.equal(c.voters, 7);
  assert.equal(c.status, 'consensus');
});

test('composed and decomposed forms of one text are one label, shown once', () => {
  const s = session();
  const nfc = 'Ependymal cell é'.normalize('NFC');
  const nfd = nfc.normalize('NFD');
  assert.notEqual(nfc, nfd);
  s.mergeFromUserFiles([
    view(1, { suggestions: { 'leiden:0': [sugg(1, 'a', nfc)] }, votes: { [id(1, 'a')]: 'up' } }),
    view(2, { suggestions: { 'leiden:0': [sugg(2, 'b', nfd, T1)] }, votes: { [id(2, 'b')]: 'up' } }),
  ]);
  const c = s.computeConsensus('leiden', '0', SETTINGS);
  assert.equal(c.status, 'consensus');
  assert.equal(c.label, nfc);
});

test('labels that differ in case or inner spacing stay apart', () => {
  const s = session();
  s.mergeFromUserFiles([
    view(1, { suggestions: { 'leiden:0': [sugg(1, 'a', 'T cell')] }, votes: { [id(1, 'a')]: 'up' } }),
    view(2, { suggestions: { 'leiden:0': [sugg(2, 'b', 'T Cell')] }, votes: { [id(2, 'b')]: 'up' } }),
  ]);
  assert.equal(s.getSuggestions('leiden', '0').length, 2);
  assert.equal(s.computeConsensus('leiden', '0', SETTINGS).status, 'disputed');
});

test('a user who votes on two members of one bundle counts once, by majority', () => {
  const s = session();
  s.mergeFromUserFiles([
    view(1, { suggestions: { 'leiden:0': [sugg(1, 'a', 'B cell')] }, votes: { [id(1, 'a')]: 'up' } }),
    view(2, { suggestions: { 'leiden:0': [sugg(2, 'b', 'B cell')] }, votes: { [id(2, 'b')]: 'up' } }),
    view(3, { votes: { [id(1, 'a')]: 'up', [id(2, 'b')]: 'up' } }),
    view(4, { votes: { [id(1, 'a')]: 'up', [id(2, 'b')]: 'down' } }),
  ]);
  const [main] = s.getSuggestions('leiden', '0');
  assert.deepEqual([...main.upvotes].sort(), ['ghid_1', 'ghid_2', 'ghid_3']);
  assert.deepEqual(main.downvotes, []);
  const c = s.computeConsensus('leiden', '0', SETTINGS);
  // ghid_4's up and down cancel: no vote, so not a voter of the bucket.
  assert.equal(c.netVotes, 3);
  assert.equal(c.voters, 3);
});

test('moderation merges and equal labels bundle together', () => {
  const s = session();
  s.mergeFromUserFiles([
    view(1, { suggestions: { 'leiden:0': [sugg(1, 'a', 'Treg')] }, votes: { [id(1, 'a')]: 'up' } }),
    view(2, { suggestions: { 'leiden:0': [sugg(2, 'b', 'Regulatory T cell')] }, votes: { [id(2, 'b')]: 'up' } }),
    view(3, { suggestions: { 'leiden:0': [sugg(3, 'c', 'Regulatory T cell', T1)] }, votes: { [id(3, 'c')]: 'up' } }),
  ]);
  s.setModerationMergesFromDoc({
    version: 1,
    updatedAt: T0,
    merges: [{ bucket: 'leiden:0', fromSuggestionId: id(1, 'a'), intoSuggestionId: id(2, 'b'), by: 'ghid_2', at: T0 }],
  });
  const shown = s.getSuggestions('leiden', '0');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].id, id(2, 'b'));
  assert.deepEqual(
    shown[0].mergedFrom.map((m) => [m.id, m.bundledBy]).sort(),
    [[id(1, 'a'), 'merge'], [id(3, 'c'), 'label']],
  );
  const c = s.computeConsensus('leiden', '0', SETTINGS);
  assert.equal(c.status, 'consensus');
  assert.equal(c.netVotes, 3);
});

test('zero voters are pending whatever the settings', () => {
  const s = session();
  s.mergeFromUserFiles([
    view(1, { suggestions: { 'leiden:0': [sugg(1, 'a', 'T cell')] } }),
  ]);
  for (const threshold of [-1, -0.5, 0]) {
    const c = s.computeConsensus('leiden', '0', { minAnnotators: 0, threshold });
    assert.equal(c.status, 'pending', `threshold ${threshold}`);
    assert.equal(c.voters, 0);
  }
});

test('proposing a label already shown is refused under NFC; renaming keeps a bundled suggestion editable', () => {
  const s = session();
  s.mergeFromUserFiles([
    view(1, { suggestions: { 'leiden:0': [sugg(1, 'a', 'Café cell'.normalize('NFC'))] }, votes: { [id(1, 'a')]: 'up' } }),
  ]);
  assert.throws(() => s.addSuggestion('leiden', '0', { label: 'Café cell'.normalize('NFD') }), /already exists/);
  const mine = s.addSuggestion('leiden', '0', { label: 'Ependymal' });
  assert.match(mine, /^ghid_99_[0-9a-f-]{36}$/);
  // Another user proposes the same label later: the two are bundled.
  s.mergeFromUserFiles([
    view(1, { suggestions: { 'leiden:0': [sugg(1, 'a', 'Café cell')] }, votes: { [id(1, 'a')]: 'up' } }),
    view(2, { suggestions: { 'leiden:0': [sugg(2, 'b', 'Ependymal', T1)] }, votes: { [id(2, 'b')]: 'up' } }),
  ]);
  // Editing the evidence (label unchanged) of a bundled suggestion is not a duplicate.
  assert.equal(s.editMySuggestion('leiden', '0', mine, { label: 'Ependymal', evidence: 'FOXJ1' }), true);
  assert.throws(() => s.editMySuggestion('leiden', '0', mine, { label: 'Café cell' }), /already exists/);
});

test('a suggestion cannot be proposed without a GitHub identity', () => {
  const s = new CommunityAnnotationSession();
  s.setFieldCategories('leiden', ['0']);
  assert.throws(
    () => s.addSuggestion('leiden', '0', { label: 'T cell' }),
    (error) => error.code === 'COMMUNITY_ANNOTATION_IDENTITY_REQUIRED',
  );
});

test('memoised consensus follows votes, merges and Pulls', () => {
  const s = session();
  s.mergeFromUserFiles([
    view(1, { suggestions: { 'leiden:0': [sugg(1, 'a', 'T cell')] }, votes: { [id(1, 'a')]: 'up' } }),
    view(2, { suggestions: { 'leiden:0': [sugg(2, 'b', 'NK cell')] }, votes: { [id(2, 'b')]: 'up' } }),
  ]);
  assert.equal(s.computeConsensus('leiden', '0', SETTINGS).status, 'disputed');
  s.vote('leiden', '0', id(1, 'a'), 'up');
  assert.equal(s.computeConsensus('leiden', '0', SETTINGS).label, 'T cell');
  assert.equal(s.computeConsensus('leiden', '0', SETTINGS).netVotes, 2);
  // The same settings object twice and a different one give their own results.
  assert.equal(s.computeConsensus('leiden', '0', { minAnnotators: 5, threshold: 0.5 }).status, 'pending');
  s.addModerationMerge({ fieldKey: 'leiden', catIdx: '0', fromSuggestionId: id(2, 'b'), intoSuggestionId: id(1, 'a') });
  assert.equal(s.getSuggestions('leiden', '0').length, 1);
  assert.equal(s.computeConsensus('leiden', '0', SETTINGS).status, 'consensus');
  s.detachModerationMerge({ fieldKey: 'leiden', catIdx: '0', fromSuggestionId: id(2, 'b') });
  assert.equal(s.getSuggestions('leiden', '0').length, 2);
  // A returned result is a copy: changing it changes nothing.
  const c = s.computeConsensus('leiden', '0', SETTINGS);
  c.status = 'tampered';
  assert.notEqual(s.computeConsensus('leiden', '0', SETTINGS).status, 'tampered');
});

test('a merge that would close a cycle is refused when added', () => {
  const s = session();
  s.mergeFromUserFiles([
    view(1, { suggestions: { 'leiden:0': [sugg(1, 'a', 'A')] } }),
    view(2, { suggestions: { 'leiden:0': [sugg(2, 'b', 'B')] } }),
  ]);
  s.addModerationMerge({ fieldKey: 'leiden', catIdx: '0', fromSuggestionId: id(1, 'a'), intoSuggestionId: id(2, 'b') });
  assert.throws(
    () => s.addModerationMerge({ fieldKey: 'leiden', catIdx: '0', fromSuggestionId: id(2, 'b'), intoSuggestionId: id(1, 'a') }),
    /cycle/,
  );
  assert.equal(s.getModerationMerges().length, 1);
});

test('exports are ordered by code units, the same in every locale', () => {
  const s = session();
  s.setFieldCategories('leiden', ['0', 'b', 'B', 'ä']);
  s.mergeFromUserFiles([
    view(1, {
      suggestions: {
        'leiden:b': [sugg(1, 'x', 'X')],
        'leiden:ä': [sugg(1, 'y', 'Y')],
        'leiden:B': [sugg(1, 'z', 'Z')],
      },
    }),
  ]);
  s.setFieldAnnotated('leiden', true);
  s.setAnnotatableConsensusSettings('leiden', SETTINGS);
  const doc = s.buildConsensusDocument();
  assert.deepEqual(Object.keys(doc.suggestions), ['leiden:B', 'leiden:b', 'leiden:ä']);
});

test('a user file that does not own its suggestion ids is refused alone, with its path', () => {
  const remote = new RemoteUserFiles({ ownUsername: `ghid_${ME}` });
  remote.add(view(1, { suggestions: { 'leiden:0': [sugg(1, 'a', 'T cell')] } }), { path: 'annotations/users/ghid_1.json' });
  const forged = view(2, { suggestions: { 'leiden:0': [{ ...sugg(1, 'a', 'Forged'), proposedBy: 'ghid_2' }] } });
  assert.throws(
    () => remote.add(forged, { path: 'annotations/users/ghid_2.json' }),
    (error) => error.code === 'COMMUNITY_ANNOTATION_FILE_REJECTED' && error.path === 'annotations/users/ghid_2.json',
  );
  assert.equal(remote.count, 1);
  assert.equal(remote.suggestions.get(id(1, 'a')).suggestion.label, 'T cell');
});

test('the session keeps only the SHAs it reads', () => {
  const s = session();
  const sha = (n) => String(n).repeat(40).slice(0, 40);
  const shas = {
    'annotations/config.json': sha(1),
    'annotations/moderation/merges.json': sha(2),
    [`annotations/users/ghid_${ME}.json`]: sha(3),
  };
  for (let n = 1; n <= 500; n += 1) shas[`annotations/users/ghid_${n}.json`] = sha(4);
  s.setRemoteFileShas(shas);
  assert.deepEqual(Object.keys(s.getRemoteFileShas()).sort(), [
    'annotations/config.json',
    'annotations/moderation/merges.json',
    `annotations/users/ghid_${ME}.json`,
  ]);
});

test('bundle vote info of a suggestion in no bundle is no delegated vote', () => {
  const s = session();
  s.mergeFromUserFiles([
    view(1, { suggestions: { 'leiden:0': [sugg(1, 'a', 'T cell')] }, votes: { [id(1, 'a')]: 'up' } }),
  ]);
  assert.deepEqual(
    s.getMyBundleVoteInfo('leiden', '0', id(1, 'a')),
    { vote: null, source: 'none', delegatedUp: 0, delegatedDown: 0 },
  );
});
