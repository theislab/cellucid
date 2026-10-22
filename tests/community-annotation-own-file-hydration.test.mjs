/**
 * Pulling hydrates local state from the user's own published file only when
 * that file holds something this device has not seen: a file whose SHA is the
 * one this session last published or pulled is already reflected locally, and
 * a vote retracted or a comment deleted since then must stay retracted.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CommunityAnnotationSession } from '../assets/js/app/community-annotations/session.js';

const MY_PATH = 'annotations/users/ghid_42.json';
const OTHER_PATH = 'annotations/users/ghid_7.json';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_OTHER = 'c'.repeat(40);

function otherUserDocument(votes = {}) {
  return {
    version: 1,
    username: 'ghid_7',
    githubUserId: 7,
    login: 'reviewer',
    updatedAt: '2026-07-30T01:02:03.456Z',
    suggestions: {
      'cell_type:Alpha': [{
        id: 'remote-suggestion',
        label: 'T cell',
        proposedBy: 'ghid_7',
        proposedAt: '2026-07-30T01:02:03.456Z',
      }],
    },
    votes,
  };
}

/** One Pull's remote user files, folded for `session` as a Pull folds them. */
function remoteFiles(session, docs) {
  const files = session.createRemoteUserFiles();
  for (const doc of docs) files.add(doc);
  return files;
}

function pull(session, docs, remoteFileShas) {
  session.applyPulledRepositoryState({
    remoteUserFiles: remoteFiles(session, docs),
    moderationDocument: null,
    categoricalFieldKeys: ['cell_type'],
    fieldsToAnnotate: ['cell_type'],
    annotatableSettings: { cell_type: { minAnnotators: 1, threshold: 0.5 } },
    closedFields: [],
    datasetId: 'dataset',
    remoteFileShas,
  });
}

function createSession() {
  const session = new CommunityAnnotationSession();
  session.setProfile({ username: 'ghid_42', githubUserId: 42, login: 'me' });
  session.setFieldCategories('cell_type', ['Alpha']);
  pull(session, [otherUserDocument()], { [OTHER_PATH]: SHA_OTHER });
  return session;
}

function dispose(session) {
  if (session._saveTimer) clearTimeout(session._saveTimer);
}

/** Simulate a direct Publish: the file lands remotely at `sha`. */
function publish(session, sha) {
  const document = session.buildUserFileDocument({ githubUserId: 42 });
  session.setRemoteFileSha(MY_PATH, sha);
  return document;
}

test('a vote retracted after Publish stays retracted across the next Pull', (t) => {
  const session = createSession();
  t.after(() => dispose(session));

  session.vote('cell_type', 0, 'remote-suggestion', 'up');
  const published = publish(session, SHA_A);
  assert.deepEqual(published.votes, { 'remote-suggestion': 'up' });

  // Clicking the same arrow again removes the vote.
  session.vote('cell_type', 0, 'remote-suggestion', 'up');
  assert.equal(session.getMyVote('cell_type', 0, 'remote-suggestion'), null);

  pull(session, [otherUserDocument(), published], {
    [OTHER_PATH]: SHA_OTHER,
    [MY_PATH]: SHA_A,
  });

  assert.equal(session.getMyVote('cell_type', 0, 'remote-suggestion'), null);
  assert.deepEqual(session.getSuggestions('cell_type', 0)[0].upvotes, []);
  assert.deepEqual(
    session.buildUserFileDocument({ githubUserId: 42 }).votes,
    {}
  );
});

test('a comment deleted after Publish stays deleted across the next Pull', (t) => {
  const session = createSession();
  t.after(() => dispose(session));

  const created = session.addComment(
    'cell_type',
    0,
    'remote-suggestion',
    'oops, wrong cluster'
  );
  const commentId = typeof created === 'string' ? created : created.id;
  const published = publish(session, SHA_A);
  assert.equal(Object.keys(published.comments).length, 1);

  session.deleteComment('cell_type', 0, 'remote-suggestion', commentId);
  pull(session, [otherUserDocument(), published], {
    [OTHER_PATH]: SHA_OTHER,
    [MY_PATH]: SHA_A,
  });

  assert.deepEqual(session.getComments('cell_type', 0, 'remote-suggestion'), []);
  assert.deepEqual(
    session.buildUserFileDocument({ githubUserId: 42 }).comments,
    {}
  );
});

test('a file published from another device still hydrates this device', (t) => {
  const elsewhere = createSession();
  t.after(() => dispose(elsewhere));
  elsewhere.vote('cell_type', 0, 'remote-suggestion', 'down');
  const publishedElsewhere = publish(elsewhere, SHA_B);

  const session = createSession();
  t.after(() => dispose(session));
  pull(session, [otherUserDocument(), publishedElsewhere], {
    [OTHER_PATH]: SHA_OTHER,
    [MY_PATH]: SHA_B,
  });
  assert.equal(session.getMyVote('cell_type', 0, 'remote-suggestion'), 'down');

  // Once seen, that same file is no longer a source of new intent.
  session.vote('cell_type', 0, 'remote-suggestion', 'down');
  pull(session, [otherUserDocument(), publishedElsewhere], {
    [OTHER_PATH]: SHA_OTHER,
    [MY_PATH]: SHA_B,
  });
  assert.equal(session.getMyVote('cell_type', 0, 'remote-suggestion'), null);
});

test('reloading the profile file applies the same own-file hydration gate', async () => {
  const { readFile } = await import('node:fs/promises');
  const controls = await readFile(
    new URL(
      '../assets/js/app/ui/modules/community-annotation-controls.js',
      import.meta.url
    ),
    'utf8'
  );
  const merges = controls.match(/session\.mergeFromUserFiles\([\s\S]*?\}\);/g) ?? [];
  assert.equal(merges.length, 1);
  assert.match(merges[0], /hydrateFromOwnFile: [\s\S]*ownUserFileNeedsHydration\(/);

  const session = createSession();
  try {
    session.setRemoteFileSha(MY_PATH, SHA_A);
    assert.equal(session.ownUserFileNeedsHydration({ [MY_PATH]: SHA_A }), false);
    assert.equal(session.ownUserFileNeedsHydration({ [MY_PATH]: SHA_B }), true);
    assert.equal(session.ownUserFileNeedsHydration({}), true);
  } finally {
    dispose(session);
  }
});
