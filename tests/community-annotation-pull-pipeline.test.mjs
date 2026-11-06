/**
 * The Pull pipeline (`github-sync.js`: snapshot, users tree, blob batches,
 * the file cache) against an in-memory GitHub behind the Worker (contract
 * 3), on virtual time: requests per Pull, resumption, per-file exclusion,
 * stall timeouts without a total deadline, retries paced by the host.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CommunityAnnotationGitHubSync,
  foldCachedFiles,
} from '../assets/js/app/community-annotations/github-sync.js';
import { CommunityAnnotationFileCache } from '../assets/js/app/community-annotations/file-cache.js';
import { ANNOTATION_USER_FILE_VERSION } from '../assets/js/app/community-annotations/wire-contract.js';
import { createFakeIndexedDB, FakeKeyRange } from './helpers/fake-indexeddb.mjs';
import {
  configFor,
  createVirtualTime,
  MockAnnotationGitHub,
  opaqueBlob,
  publishedJson,
  treeOidOf,
  virtualTransport,
  WORKER_ORIGIN,
} from './helpers/community-annotation-worker.mjs';

const T0 = '2026-01-01T00:00:00Z';
const userPath = (id) => `annotations/users/ghid_${id}.json`;

/** A user file with one suggestion (owner-prefixed id) and its vote, for dataset `ds`. */
function userFile(id, { label = 'T cell', datasetId = 'ds', sections = null } = {}) {
  const suggestionId = `ghid_${id}_s1`;
  return publishedJson({
    version: ANNOTATION_USER_FILE_VERSION,
    username: `ghid_${id}`,
    githubUserId: id,
    updatedAt: T0,
    datasets: sections ?? {
      [datasetId]: {
        fieldsToAnnotate: ['leiden'],
        lastAccessedAt: T0,
        suggestions: { 'leiden:0': [{ id: suggestionId, label, proposedBy: `ghid_${id}`, proposedAt: T0 }] },
        votes: { [suggestionId]: 'up' },
      },
    },
  });
}

function repositoryOf(count, extra = {}) {
  const files = { 'annotations/config.json': configFor('ds'), 'annotations/users/.gitkeep': '\n' };
  for (let id = 1; id <= count; id++) files[userPath(id)] = userFile(id);
  return new MockAnnotationGitHub({ files: { ...files, ...extra } });
}

function harness(github, { fetch = github.fetch, time = createVirtualTime() } = {}) {
  const { transport } = virtualTransport(fetch, time);
  const fileCache = new CommunityAnnotationFileCache({ indexedDB: createFakeIndexedDB(), keyRange: FakeKeyRange });
  const cacheScope = { datasetId: 'ds', repoRef: 'owner/repo@main', userId: 42 };
  const sync = () => new CommunityAnnotationGitHubSync({
    datasetId: 'ds',
    owner: 'owner',
    repo: 'repo',
    token: 'token',
    branch: 'main',
    workerOrigin: WORKER_ORIGIN,
    transport,
  });
  /** One Pull as the controls run it: snapshot and config, then the files. */
  const pull = async ({ signal = null, onProgress = null } = {}) => {
    const s = sync();
    const opened = await s.validateAndLoadConfig({ datasetId: 'ds', signal });
    const files = await s.pullFiles({ snapshot: opened.snapshot, fileCache, cacheScope, ownUserKey: 'ghid_42', signal, onProgress });
    return { opened, files };
  };
  const fold = async () => {
    const added = [];
    const remoteUserFiles = { add: (view) => added.push(view) };
    const folded = await foldCachedFiles({ fileCache, cacheScope, remoteUserFiles });
    return { ...folded, added };
  };
  return { time, transport, fileCache, cacheScope, sync, pull: (options) => time.run(pull(options)), fold };
}

const requestsOf = (log, from) => log.slice(from).map((line) => line.replace(/\?.*$/, ''));

test('a first Pull of 5,000 users reads the repository in a handful of requests', async () => {
  const github = repositoryOf(5000);
  const h = harness(github);
  const { files } = await h.pull();
  assert.equal(files.unchanged, false);
  assert.equal(files.userCount, 5000);
  assert.equal(files.fetchedCount, 5000);
  const requests = requestsOf(github.log, 0);
  // metadata, snapshot, the config blob, the users tree, then the blob batches.
  assert.equal(requests[0], 'GET /api/repos/owner/repo');
  assert.equal(requests[1], 'POST /graphql/snapshot');
  const blobBatches = requests.filter((line) => line === 'POST /graphql/blobs').length;
  assert.ok(requests.length <= 20, `first Pull used ${requests.length} requests: ${requests.join(', ')}`);
  assert.ok(blobBatches >= 2, 'the batches grow from a first, smaller one');
  const { added, excluded } = await h.fold();
  assert.equal(added.length, 5000);
  assert.deepEqual(excluded, []);
});

test('a Pull where nothing changed asks for metadata (304) and the snapshot only', async () => {
  const github = repositoryOf(50);
  const h = harness(github);
  await h.pull();
  const before = github.log.length;
  const hitsBefore = github.etagHits;
  const { files } = await h.pull();
  assert.equal(files.unchanged, true);
  assert.deepEqual(requestsOf(github.log, before), ['GET /api/repos/owner/repo', 'POST /graphql/snapshot']);
  assert.equal(github.etagHits, hitsBefore + 1, 'the metadata was answered 304 against its kept ETag');
});

test('a Pull after one file changed reads the users tree and that one file', async () => {
  const github = repositoryOf(50);
  const h = harness(github);
  await h.pull();
  github.commitFiles({ [userPath(7)]: userFile(7, { label: 'B cell' }) });
  const before = github.log.length;
  const { files } = await h.pull();
  assert.equal(files.fetchedCount, 1);
  assert.deepEqual(requestsOf(github.log, before), [
    'GET /api/repos/owner/repo',
    'POST /graphql/snapshot',
    `GET /api/repos/owner/repo/git/trees/${treeOidOf(github.filesAt(), 'annotations/users/')}`,
    'POST /graphql/blobs',
  ]);
});

test('a commit that changes nothing under annotations/ stops at the snapshot', async () => {
  const github = repositoryOf(10);
  const h = harness(github);
  await h.pull();
  github.commitFiles({ 'README.md': 'docs\n' });
  const before = github.log.length;
  const { files } = await h.pull();
  assert.equal(files.unchanged, true);
  assert.equal(github.log.length - before, 2);
});

test('a config change reads the config blob and no users tree', async () => {
  const github = repositoryOf(10);
  const h = harness(github);
  await h.pull();
  github.commitFiles({ 'annotations/config.json': configFor('ds', ['leiden', 'cell_type']) });
  const before = github.log.length;
  const { opened, files } = await h.pull();
  assert.deepEqual(opened.datasetConfig.fieldsToAnnotate, ['leiden', 'cell_type']);
  assert.equal(files.fetchedCount, 0);
  assert.deepEqual(requestsOf(github.log, before), ['GET /api/repos/owner/repo', 'POST /graphql/snapshot', 'POST /graphql/blobs']);
});

test('every hostile file is excluded on its own; the Pull completes and reports it', async () => {
  const good = 20;
  const invalidSection = JSON.parse(userFile(903));
  invalidSection.datasets.ds.suggestions['leiden:0'][0].label = ' leading space';
  const otherDatasetInvalid = JSON.parse(userFile(904));
  otherDatasetInvalid.datasets.other = {
    fieldsToAnnotate: ['leiden'],
    lastAccessedAt: T0,
    suggestions: { 'leiden:0': [{ id: 'ghid_904_x', label: ' leading space', proposedBy: 'ghid_904', proposedAt: T0 }] },
    votes: {},
  };
  const github = repositoryOf(good, {
    'annotations/users/README.md': '# hi\n',
    'annotations/users/old/ghid_5.json': userFile(5),
    'annotations/users/GHID_6.json': userFile(6),
    [userPath(901)]: '{"version":3,',
    [userPath(902)]: `${JSON.stringify(JSON.parse(userFile(902))).slice(0, -1)}${' '.repeat(1_000_001)}}`,
    [userPath(903)]: publishedJson(invalidSection),
    [userPath(904)]: publishedJson(otherDatasetInvalid),
    [userPath(905)]: opaqueBlob('e'.repeat(40), 64),
    // A key spelled twice once its escapes are decoded, and a UTF-8 BOM: exact JSON refuses both.
    [userPath(906)]: userFile(906).replace('{\n  "version":', '{\n  "\\u0076ersion": 3,\n  "version":'),
    [userPath(907)]: `\uFEFF${userFile(907)}`,
    'annotations/Users/ghid_7.json': userFile(7),
  });
  const h = harness(github);
  const { files } = await h.pull();
  assert.deepEqual(
    files.ignored.map((entry) => entry.path).sort(),
    ['annotations/Users', 'annotations/users/GHID_6.json', 'annotations/users/README.md', 'annotations/users/old'].sort()
  );
  const { added, excluded } = await h.fold();
  const excludedPaths = excluded.map((entry) => entry.path).sort();
  assert.ok(excludedPaths.includes(userPath(901)), 'malformed JSON');
  assert.ok(excludedPaths.includes(userPath(902)), 'over 1,000,000 bytes');
  assert.ok(excludedPaths.includes(userPath(903)), 'an invalid section of the open dataset');
  assert.ok(excludedPaths.includes(userPath(905)), 'a binary blob');
  assert.ok(excludedPaths.includes(userPath(906)), 'a decoded duplicate key');
  assert.ok(excludedPaths.includes(userPath(907)), 'a UTF-8 BOM');
  for (const entry of excluded) assert.ok(entry.reason.length > 0);
  assert.equal(excluded.find((entry) => entry.path === userPath(902)).reason.includes('1000000'), true);
  // Every good file is in the consensus.
  const users = new Set(added.map((view) => view.username));
  for (let id = 1; id <= good; id++) assert.ok(users.has(`ghid_${id}`), `ghid_${id} folded`);
  assert.ok(!users.has('ghid_901') && !users.has('ghid_902') && !users.has('ghid_903'));
});

test('an excluded file is kept as excluded by its blob id and not read again until it changes', async () => {
  const github = repositoryOf(5, { [userPath(9)]: '{not json' });
  const h = harness(github);
  await h.pull();
  github.commitFiles({ [userPath(3)]: userFile(3, { label: 'NK cell' }) });
  const blobRequests = [];
  github.intercept = async (request) => {
    if (request.path === '/graphql/blobs') blobRequests.push(...request.body.oids);
    return undefined;
  };
  await h.pull();
  assert.equal(blobRequests.length, 1, 'only the changed file is read again');
  const { excluded } = await h.fold();
  assert.deepEqual(excluded.map((entry) => entry.path), [userPath(9)]);
});

test('a file the session refuses when folding is left out on its own', async () => {
  const github = repositoryOf(3);
  const h = harness(github);
  await h.pull();
  const added = [];
  const refused = new Error('ghid_2 uses an id owned by ghid_1');
  refused.code = 'COMMUNITY_ANNOTATION_FILE_REJECTED';
  const remoteUserFiles = {
    add(view) {
      if (view.username === 'ghid_2') throw refused;
      added.push(view.username);
    },
  };
  const { excluded } = await foldCachedFiles({ fileCache: h.fileCache, cacheScope: h.cacheScope, remoteUserFiles });
  assert.deepEqual(added, ['ghid_1', 'ghid_3']);
  assert.deepEqual(excluded.map((entry) => entry.path), [userPath(2)]);
});

test('a rate limit late in a first Pull of 5,000 users waits for the reset and completes', async () => {
  const github = repositoryOf(5000);
  let batches = 0;
  github.intercept = async (request) => {
    if (request.path !== '/graphql/blobs') return undefined;
    batches += 1;
    if (batches === 4) {
      return new Response(JSON.stringify({ error: 'API rate limit exceeded' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1800000600' },
      });
    }
    return undefined;
  };
  const h = harness(github);
  const { files } = await h.pull();
  assert.equal(files.userCount, 5000);
  assert.ok(h.time.now() >= 600_000, `waited for the stated reset (${h.time.now()} ms)`);
  const { added } = await h.fold();
  assert.equal(added.length, 5000);
});

test('an interrupted first Pull keeps every batch it read, and the next Pull reads only the rest', async () => {
  const github = repositoryOf(3000);
  const controller = new AbortController();
  const h = harness(github);
  let progressed = 0;
  await assert.rejects(h.pull({
    signal: controller.signal,
    onProgress: ({ done }) => {
      progressed = done;
      if (done >= 1000) controller.abort();
    },
  }), (error) => error?.name === 'AbortError');
  const kept = (await h.fileCache.getKnownShas(h.cacheScope)).size;
  assert.ok(kept >= 1000 && kept < 3000, `kept ${kept} of 3000 (progress ${progressed})`);
  assert.equal(await h.fileCache.getPullMarker(h.cacheScope), null, 'an interrupted Pull is not complete');
  const oids = [];
  github.intercept = async (request) => {
    if (request.path === '/graphql/blobs') oids.push(...request.body.oids);
    return undefined;
  };
  const { files } = await h.pull();
  assert.equal(files.fetchedCount, 3000 - kept);
  assert.equal(oids.length, 3000 - kept, 'nothing read twice');
  assert.notEqual(await h.fileCache.getPullMarker(h.cacheScope), null);
});

test('a steadily streaming 21 s answer is delivering, not stalled: no total deadline', async () => {
  const github = repositoryOf(3);
  const time = createVirtualTime();
  const slowFetch = async (url, init) => {
    const answer = await github.fetch(url, init);
    if (!String(url).endsWith('/graphql/snapshot')) return answer;
    const text = await answer.text();
    const pieces = 21;
    const size = Math.ceil(text.length / pieces);
    let index = 0;
    const body = new ReadableStream({
      pull(controller) {
        return new Promise((resolve) => {
          time.after(1000, () => {
            controller.enqueue(new TextEncoder().encode(text.slice(index * size, (index + 1) * size)));
            index += 1;
            if (index >= pieces) controller.close();
            resolve();
          });
        });
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const h = harness(github, { fetch: slowFetch, time });
  const { files } = await h.pull();
  assert.equal(files.userCount, 3);
  assert.ok(time.now() >= 21_000, `the answer took ${time.now()} ms of virtual time`);
});

test('an answer that falls silent is stalled, asked again, and the Pull completes', async () => {
  const github = repositoryOf(3);
  const time = createVirtualTime();
  let silenced = 0;
  const silentOnce = async (url, init) => {
    if (String(url).endsWith('/graphql/snapshot') && silenced === 0) {
      silenced += 1;
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    }
    return github.fetch(url, init);
  };
  const h = harness(github, { fetch: silentOnce, time });
  const { files } = await h.pull();
  assert.equal(files.userCount, 3);
  assert.equal(silenced, 1);
});

test('a body cut after its headers is COMMUNITY_ANNOTATION_RESPONSE_CUT, not an unreachable Worker', async () => {
  const github = repositoryOf(2);
  const cutFetch = async (url, init) => {
    if (!String(url).endsWith('/graphql/snapshot')) return github.fetch(url, init);
    let sent = false;
    const body = new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode('{"data":'));
          return;
        }
        controller.error(new TypeError('network connection lost'));
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const h = harness(github, { fetch: cutFetch });
  await assert.rejects(h.pull(), (error) => error.code === 'COMMUNITY_ANNOTATION_RESPONSE_CUT' && error.transient === true);
});

test('a Worker that answered before and now sends nothing readable is said apart from one never reached', async () => {
  const github = repositoryOf(2);
  let answering = true;
  const fetchImpl = async (url, init) => {
    if (!answering) throw new TypeError('Failed to fetch');
    return github.fetch(url, init);
  };
  const h = harness(github, { fetch: fetchImpl });
  await h.pull();
  answering = false;
  github.commitFiles({ [userPath(1)]: userFile(1, { label: 'B cell' }) });
  await assert.rejects(h.pull(), (error) => error.code === 'GITHUB_WORKER_UNREACHABLE' && error.answeredBefore === true);
  const never = harness(github, { fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(never.pull(), (error) => error.code === 'GITHUB_WORKER_UNREACHABLE' && error.answeredBefore === false);
});

test('a 503 carrying X-RateLimit-Reset with budget left is asked again soon, not held until the reset', async () => {
  const github = repositoryOf(2);
  let refused = 0;
  github.intercept = async (request) => {
    if (request.path === '/graphql/snapshot' && refused === 0) {
      refused += 1;
      return new Response(JSON.stringify({ error: 'unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'X-RateLimit-Remaining': '4000', 'X-RateLimit-Reset': '1800003600' },
      });
    }
    return undefined;
  };
  const h = harness(github);
  await h.pull();
  assert.equal(refused, 1);
  assert.ok(h.time.now() < 30_000, `asked again after ${h.time.now()} ms, not after the hour-long reset`);
});

test('blob batches are halved when refused for their size, and a truncated blob is read through REST', async () => {
  const github = repositoryOf(400);
  let refusals = 0;
  github.intercept = async (request) => {
    if (request.path !== '/graphql/blobs') return undefined;
    if (request.body.oids.length > 50) {
      refusals += 1;
      return new Response(JSON.stringify({ error: 'GitHub answered HTTP 502' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
    const answer = await github._blobs(request.body);
    const document = await answer.json();
    // GitHub truncates the text of the first blob of every batch.
    document.data.repository.b0.isTruncated = true;
    document.data.repository.b0.text = document.data.repository.b0.text.slice(0, 5);
    return new Response(JSON.stringify(document), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const h = harness(github);
  const { files } = await h.pull();
  assert.equal(files.userCount, 400);
  assert.ok(refusals >= 1);
  assert.ok(github.log.some((line) => line.includes('/git/blobs/')), 'truncated blobs were read through REST');
  const { added, excluded } = await h.fold();
  assert.equal(added.length, 400);
  assert.deepEqual(excluded, []);
});

test('the repository layout is checked from the snapshot: schemas by blob id, users folder, truncated tree', async () => {
  const wrongSchema = repositoryOf(1, { 'annotations/schema.json': opaqueBlob('f'.repeat(40)) });
  await assert.rejects(harness(wrongSchema).pull(), (error) =>
    error.code === 'COMMUNITY_ANNOTATION_REPOSITORY_LAYOUT_INVALID' &&
    error.message.includes('annotations/schema.json') &&
    error.message.includes('cellucid-annotation'));

  const noUsers = new MockAnnotationGitHub({ files: { 'annotations/config.json': configFor('ds') } });
  await assert.rejects(harness(noUsers).pull(), (error) =>
    error.code === 'COMMUNITY_ANNOTATION_REPOSITORY_LAYOUT_INVALID' && error.message.includes('annotations/users/'));

  const truncated = repositoryOf(2);
  truncated.intercept = async (request) => {
    if (!request.path.includes('/git/trees/')) return undefined;
    return new Response(JSON.stringify({ sha: request.path.split('/').pop(), url: 'x', tree: [], truncated: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  await assert.rejects(harness(truncated).pull(), (error) =>
    error.code === 'COMMUNITY_ANNOTATION_REPOSITORY_LAYOUT_INVALID' && /truncated/.test(error.message));
});

test('files gone from the repository are pruned from the cache', async () => {
  const github = repositoryOf(5);
  const h = harness(github);
  await h.pull();
  github.commitFiles({ [userPath(2)]: null, [userPath(4)]: null });
  await h.pull();
  const known = await h.fileCache.getKnownShas(h.cacheScope);
  assert.deepEqual([...known.keys()].sort(), [userPath(1), userPath(3), userPath(5)]);
});
