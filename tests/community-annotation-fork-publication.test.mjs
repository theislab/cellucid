/**
 * Publishing a contributor's file without write access: the contributor's
 * own fork (made on GitHub; Cellucid only finds it), one head
 * branch per contributor and base branch, reset to the upstream tip before
 * every write, one pull request carrying every dataset (B1). And the
 * direct-mode create race (two devices creating the file at once).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CommunityAnnotationGitHubSync,
  toAnnotationHeadBranch,
} from '../assets/js/app/community-annotations/github-sync.js';
import {
  configFor,
  createVirtualTime,
  gitBlobSha,
  MockAnnotationGitHub,
  publishedJson,
  virtualTransport,
  WORKER_ORIGIN,
} from './helpers/community-annotation-worker.mjs';
import { ANNOTATION_USER_FILE_VERSION } from '../assets/js/app/community-annotations/wire-contract.js';

const T0 = '2026-07-25T01:02:03.456Z';
const USER_PATH = 'annotations/users/ghid_42.json';
const FORK_ONLY = { pull: true, triage: false, push: false, maintain: false, admin: false };

/** The dataset view the session builds for ghid_42, with one suggestion labeled `label`. */
function view(label) {
  const id = `ghid_42_${label.replace(/\W/g, '')}`;
  return {
    version: 1,
    username: 'ghid_42',
    githubUserId: 42,
    login: 'researcher',
    updatedAt: T0,
    suggestions: { 'leiden:0': [{ id, label, proposedBy: 'ghid_42', proposedAt: T0 }] },
    votes: { [id]: 'up' },
  };
}

function setup({ permissions = FORK_ONLY, files = {}, fork = 'all' } = {}) {
  const github = new MockAnnotationGitHub({
    permissions,
    files: { 'annotations/config.json': configFor('datasetA'), 'annotations/users/.gitkeep': '\n', ...files },
  });
  if (!permissions.push && fork !== null) github.forkOnGitHub({ branches: fork });
  const time = createVirtualTime();
  const { transport } = virtualTransport(github.fetch, time);
  const sync = (datasetId) => new CommunityAnnotationGitHubSync({
    datasetId,
    owner: 'owner',
    repo: 'repo',
    token: 'token',
    branch: 'main',
    workerOrigin: WORKER_ORIGIN,
    transport,
  });
  const publish = (datasetId, userDoc, expectedSha = null) => time.run(sync(datasetId).pushMyUserFile({
    userDoc,
    conflictIfRemoteShaNotEqual: expectedSha,
    publicationMode: permissions.push ? 'direct' : 'fork-pull-request',
  }));
  const userFileOn = (fullName, branch) => {
    const text = github.filesAt(fullName, branch)?.get(USER_PATH);
    return text === undefined ? null : JSON.parse(text);
  };
  return { github, time, publish, userFileOn };
}

const HEAD = toAnnotationHeadBranch({ baseBranch: 'main', fileUser: 'ghid_42' });

test('one head branch per contributor and base branch, whatever the dataset', () => {
  assert.match(HEAD, /^cellucid-annotations\/ghid_42\/[0-9a-z]+$/);
  assert.notEqual(HEAD, toAnnotationHeadBranch({ baseBranch: 'develop', fileUser: 'ghid_42' }));
});

test('two datasets published in turn end up in one pull request holding both', async () => {
  const { github, publish, userFileOn } = setup();
  const first = await publish('datasetA', view('A label'));
  const second = await publish('datasetB', view('B label'));
  assert.equal(first.mode, 'fork-pull-request');
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.prNumber, first.prNumber);
  assert.equal(github.pulls.filter((pr) => pr.state === 'open').length, 1);
  const headFile = userFileOn('researcher/repo', HEAD);
  assert.deepEqual(Object.keys(headFile.datasets).sort(), ['datasetA', 'datasetB']);
  const diff = github.pullRequestDiff(first.prNumber);
  assert.deepEqual(diff.changed, [USER_PATH], 'the pull request changes the user file alone');
  assert.equal(diff.basedOnTip, true);
});

test('after a squash merge, the next publication is based on the upstream tip and never conflicts', async () => {
  const { github, publish, userFileOn } = setup();
  const first = await publish('datasetA', view('A label'));
  github.squashMerge(first.prNumber);
  // Others publish meanwhile: the upstream moves on.
  github.commitFiles({ 'annotations/users/ghid_7.json': '{"other":true}\n' });
  const upstreamSha = gitBlobSha(github.filesAt().get(USER_PATH));
  const second = await publish('datasetB', view('B label'), upstreamSha);
  assert.equal(second.reused, false, 'a new pull request: the merged one is closed');
  const diff = github.pullRequestDiff(second.prNumber);
  assert.equal(diff.basedOnTip, true, 'the head branch was reset to the upstream tip');
  assert.deepEqual(diff.changed, [USER_PATH]);
  const headFile = userFileOn('researcher/repo', HEAD);
  assert.deepEqual(Object.keys(headFile.datasets).sort(), ['datasetA', 'datasetB'],
    'the merged dataset is kept from the upstream file');
  assert.ok(github.log.some((line) => line.startsWith('PATCH /api/repos/researcher/repo/git/refs/heads/')),
    'the existing head branch was moved with the force update route');
});

test('a stale head branch from an earlier pull request is reset, never reused at its old tip', async () => {
  const { github, publish } = setup();
  const first = await publish('datasetA', view('first'));
  github.squashMerge(first.prNumber);
  const fork = github.repos.get('researcher/repo');
  const staleTip = fork.branches.get(HEAD);
  github.commitFiles({ 'annotations/users/ghid_8.json': '{"x":1}\n' });
  const upstreamSha = gitBlobSha(github.filesAt().get(USER_PATH));
  await publish('datasetA', view('second'), upstreamSha);
  const parent = github.commits.get(fork.branches.get(HEAD)).parent;
  assert.notEqual(parent, staleTip);
  assert.equal(parent, github.tipOf());
});

test('publishing an unchanged view with an open pull request writes nothing', async () => {
  const { github, publish } = setup();
  await publish('datasetA', view('A label'));
  const before = github.log.length;
  const again = await publish('datasetA', view('A label'));
  assert.equal(again.changed, false);
  assert.equal(again.reused, true);
  assert.ok(!github.log.slice(before).some((line) => /^(PUT|PATCH|POST) \/api/.test(line)), 'no write');
});

test('a renamed fork is found by paging the forks until GitHub has no more (no page cap)', async () => {
  const { github, publish } = setup({ fork: null });
  // 250 other forks, newest first, then the contributor's renamed fork on page 3;
  // a non-fork repository holds the canonical name.
  for (let index = 0; index < 250; index++) {
    github.repos.set(`user${index}/repo`, { fullName: `user${index}/repo`, fork: true, parent: 'owner/repo', branches: new Map(github.repos.get('owner/repo').branches) });
  }
  github.repos.set('researcher/repo-annotations', {
    fullName: 'researcher/repo-annotations',
    fork: true,
    parent: 'owner/repo',
    branches: new Map(github.repos.get('owner/repo').branches),
  });
  github.repos.set('researcher/repo', { fullName: 'researcher/repo', fork: false, parent: null, branches: new Map() });
  const result = await publish('datasetA', view('A label'));
  assert.equal(result.mode, 'fork-pull-request');
  assert.ok(github.log.some((line) => line.includes('/forks?') && line.includes('page=3')));
  assert.equal(github.pulls[0].headRepo, 'researcher/repo-annotations');
});

test('without a fork, Publish stops at once with a link to fork on GitHub, and writes nothing', async () => {
  const { github, publish, time } = setup({ fork: null });
  const error = await publish('datasetA', view('A label')).catch((e) => e);
  assert.equal(error.code, 'GITHUB_FORK_MISSING');
  assert.equal(error.forkUrl, 'https://github.com/owner/repo/fork');
  const [headline, ...rest] = error.message.split('\n');
  assert.equal(headline, 'You have no fork of owner/repo yet: fork it on GitHub, then Publish again.');
  assert.match(rest.join('\n'), /^Fork it at https:\/\/github\.com\/owner\/repo\/fork\. /);
  assert.match(rest.join('\n'), /installed on your GitHub account with access to your fork/);
  assert.ok(!github.log.some((line) => /^(PUT|PATCH|POST) \/api/.test(line)), 'Cellucid never creates a fork or writes');
  assert.equal(time.now(), 0, 'no waiting');
});

test('a fork GitHub is still copying stops Publish with a plain sentence, no fixed wait', async () => {
  const { github, publish, time } = setup({ fork: 'copying' });
  const error = await publish('datasetA', view('A label')).catch((e) => e);
  assert.equal(error.code, 'GITHUB_FORK_NOT_READY');
  assert.equal(error.message, 'GitHub is still copying your fork researcher/repo; Publish again in a minute.');
  assert.ok(!github.log.some((line) => /^(PUT|PATCH|POST) \/api/.test(line)));
  assert.equal(time.now(), 0, 'no waiting');
  // Copied now: the same Publish goes through.
  github.repos.get('researcher/repo').branches = new Map(github.repos.get('owner/repo').branches);
  const result = await publish('datasetA', view('A label'));
  assert.equal(result.mode, 'fork-pull-request');
});

test('a fork copied with its default branch only publishes against another base branch', async () => {
  const github = new MockAnnotationGitHub({
    permissions: FORK_ONLY,
    files: { 'annotations/config.json': configFor('datasetA'), 'annotations/users/.gitkeep': '\n' },
  });
  const upstream = github.repos.get('owner/repo');
  upstream.branches.set('annotations', upstream.branches.get('main'));
  github.forkOnGitHub({ branches: 'default' });
  const time = createVirtualTime();
  const { transport } = virtualTransport(github.fetch, time);
  const sync = new CommunityAnnotationGitHubSync({
    datasetId: 'datasetA', owner: 'owner', repo: 'repo', token: 'token', branch: 'annotations', workerOrigin: WORKER_ORIGIN, transport,
  });
  const result = await time.run(sync.pushMyUserFile({ userDoc: view('A label'), publicationMode: 'fork-pull-request' }));
  assert.equal(result.mode, 'fork-pull-request');
  assert.equal(github.pulls[0].base, 'annotations');
});

test('a fork the app cannot write to (not installed on the account) says to install the app there', async () => {
  const { github, publish } = setup();
  github.intercept = async (request) => {
    if (request.method === 'POST' && request.path === '/api/repos/researcher/repo/git/refs') {
      return new Response(JSON.stringify({ error: 'Resource not accessible by integration' }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'X-Cellucid-Operation-Id': request.headers.get('X-Cellucid-Operation-Id'),
          'X-Cellucid-Operation-Outcome': 'not-applied',
        },
      });
    }
    return undefined;
  };
  const error = await publish('datasetA', view('A label')).catch((e) => e);
  assert.equal(error.code, 'GITHUB_FORK_NOT_WRITABLE');
  assert.equal(error.status, undefined, 'not taken for a lost access to the source repository');
  assert.match(error.message.split('\n')[0], /^Cellucid cannot write to your fork researcher\/repo: install Cellucid's GitHub App/);
  assert.equal(github.pulls.length, 0);
});

test('direct mode: a file created by another device between read and write is a conflict', async () => {
  const { github, time } = setup({ permissions: { pull: true, triage: false, push: true, maintain: false, admin: false } });
  const otherDevice = publishedJson({ version: ANNOTATION_USER_FILE_VERSION, username: 'ghid_42', githubUserId: 42, updatedAt: T0, datasets: {} });
  let created = false;
  github.intercept = async (request) => {
    // The file appears just before our create lands (GitHub: 422, "sha" wasn't supplied).
    if (request.method === 'PUT' && !created) {
      created = true;
      github.commitFiles({ [USER_PATH]: otherDevice });
    }
    return undefined;
  };
  const { transport } = virtualTransport(github.fetch, time);
  const sync = new CommunityAnnotationGitHubSync({
    datasetId: 'datasetA', owner: 'owner', repo: 'repo', token: 'token', branch: 'main', workerOrigin: WORKER_ORIGIN, transport,
  });
  const error = await time.run(sync.pushMyUserFile({ userDoc: view('A label'), publicationMode: 'direct' })).catch((e) => e);
  assert.equal(error.code, 'COMMUNITY_ANNOTATION_CONFLICT');
  assert.equal(error.path, USER_PATH);
  assert.equal(error.status, 422);
});

test('direct mode: a file changed between read and write (409) is a conflict', async () => {
  const existing = publishedJson({ version: ANNOTATION_USER_FILE_VERSION, username: 'ghid_42', githubUserId: 42, updatedAt: T0, datasets: {} });
  const { github, time } = setup({
    permissions: { pull: true, triage: false, push: true, maintain: false, admin: false },
    files: { [USER_PATH]: existing },
  });
  let changed = false;
  github.intercept = async (request) => {
    if (request.method === 'PUT' && !changed) {
      changed = true;
      github.commitFiles({ [USER_PATH]: existing.replace(T0, '2026-07-26T00:00:00.000Z') });
    }
    return undefined;
  };
  const { transport } = virtualTransport(github.fetch, time);
  const sync = new CommunityAnnotationGitHubSync({
    datasetId: 'datasetA', owner: 'owner', repo: 'repo', token: 'token', branch: 'main', workerOrigin: WORKER_ORIGIN, transport,
  });
  const error = await time.run(sync.pushMyUserFile({
    userDoc: view('A label'),
    conflictIfRemoteShaNotEqual: gitBlobSha(existing),
    publicationMode: 'direct',
  })).catch((e) => e);
  assert.equal(error.code, 'COMMUNITY_ANNOTATION_CONFLICT');
  assert.equal(error.status, 409);
});

test('an invalid published own file is never overwritten silently', async () => {
  const { time, github } = setup({
    permissions: { pull: true, triage: false, push: true, maintain: false, admin: false },
    files: { [USER_PATH]: '{"version": 3, "username": "ghid_42"}\n' },
  });
  const { transport } = virtualTransport(github.fetch, time);
  const sync = new CommunityAnnotationGitHubSync({
    datasetId: 'datasetA', owner: 'owner', repo: 'repo', token: 'token', branch: 'main', workerOrigin: WORKER_ORIGIN, transport,
  });
  const error = await time.run(sync.pushMyUserFile({
    userDoc: view('A label'),
    conflictIfRemoteShaNotEqual: gitBlobSha('{"version": 3, "username": "ghid_42"}\n'),
    publicationMode: 'direct',
  })).catch((e) => e);
  assert.equal(error.code, 'COMMUNITY_ANNOTATION_OWN_FILE_INVALID');
  assert.match(error.message, /will not overwrite/);
  assert.ok(!github.log.some((line) => line.startsWith('PUT ')));
});
