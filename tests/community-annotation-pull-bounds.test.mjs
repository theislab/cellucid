import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  COMMUNITY_ANNOTATION_MAX_PULL_USER_FILES,
  COMMUNITY_ANNOTATION_MAX_PULL_UTF8_BYTES,
  CommunityAnnotationGitHubSync,
} from '../assets/js/app/community-annotations/github-sync.js';

const SHA = 'a'.repeat(40);
const USERS_DIRECTORY_SHA = 'b'.repeat(40);
const EMPTY_USERS_SENTINEL_PATH = 'annotations/users/.gitkeep';
const EMPTY_USERS_SENTINEL_SHA =
  '8b137891791fe96927ad78e64b0aad7bded08bdc';
const setupGuide = readFileSync(
  new URL(
    '../assets/js/app/community-annotations/REPO_SETUP.md',
    import.meta.url
  ),
  'utf8'
);

function createSync() {
  return new CommunityAnnotationGitHubSync({
    datasetId: 'synthetic',
    owner: 'owner',
    repo: 'repo',
    token: 'test-token',
    branch: 'main',
    workerOrigin: 'https://worker.example',
  });
}

function userTreeEntry(id, { size = 2 } = {}) {
  return {
    type: 'blob',
    path: `annotations/users/ghid_${id}.json`,
    sha: SHA,
    size,
  };
}

function usersDirectoryEntry() {
  return {
    type: 'tree',
    path: 'annotations/users',
    sha: USERS_DIRECTORY_SHA,
  };
}

function emptyUsersSentinelEntry(overrides = {}) {
  return {
    type: 'blob',
    path: EMPTY_USERS_SENTINEL_PATH,
    sha: EMPTY_USERS_SENTINEL_SHA,
    size: 1,
    ...overrides,
  };
}

async function pullFromTree(tree, options = {}) {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (rawUrl) => {
    requests.push(String(rawUrl));
    return new Response(JSON.stringify({
      tree,
      truncated: false,
    }), { status: 200 });
  };
  try {
    return {
      requests,
      result: await createSync().pullAllUsers(options),
    };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test('the pristine template sentinel is exact inventory metadata, never a user blob', async () => {
  const { requests, result } = await pullFromTree([
    {
      type: 'tree',
      path: 'annotations',
      sha: 'c'.repeat(40),
    },
    usersDirectoryEntry(),
    emptyUsersSentinelEntry(),
  ]);

  assert.equal(requests.length, 1, 'the sentinel must not trigger a blob fetch');
  assert.deepEqual(result, {
    docs: [],
    shas: {},
    fetchedCount: 0,
    totalCount: 0,
    concurrency: 8,
  });
  assert.equal(
    Object.hasOwn(result.shas, EMPTY_USERS_SENTINEL_PATH),
    false
  );
});

test('the template sentinel is excluded from user-count and decoded-byte bounds', async (t) => {
  await t.test('user count', async () => {
    const users = Array.from(
      { length: COMMUNITY_ANNOTATION_MAX_PULL_USER_FILES },
      (_, index) => userTreeEntry(index + 1, { size: 0 })
    );
    const knownShas = Object.fromEntries(
      users.map(({ path, sha }) => [path, sha])
    );
    const { requests, result } = await pullFromTree(
      [emptyUsersSentinelEntry(), ...users],
      { knownShas }
    );
    assert.equal(requests.length, 1);
    assert.equal(result.fetchedCount, 0);
    assert.equal(
      result.totalCount,
      COMMUNITY_ANNOTATION_MAX_PULL_USER_FILES
    );
    assert.equal(Object.keys(result.shas).length, result.totalCount);
    assert.equal(
      Object.hasOwn(result.shas, EMPTY_USERS_SENTINEL_PATH),
      false
    );
  });

  await t.test('decoded bytes', async () => {
    const users = [];
    let remaining = COMMUNITY_ANNOTATION_MAX_PULL_UTF8_BYTES;
    for (let id = 1; remaining > 0; id += 1) {
      const size = Math.min(1_000_000, remaining);
      users.push(userTreeEntry(id, { size }));
      remaining -= size;
    }
    const knownShas = Object.fromEntries(
      users.map(({ path, sha }) => [path, sha])
    );
    const { requests, result } = await pullFromTree(
      [emptyUsersSentinelEntry(), ...users],
      { knownShas }
    );
    assert.equal(requests.length, 1);
    assert.equal(result.fetchedCount, 0);
    assert.equal(result.totalCount, users.length);
    assert.equal(Object.keys(result.shas).length, users.length);
    assert.equal(
      Object.hasOwn(result.shas, EMPTY_USERS_SENTINEL_PATH),
      false
    );
  });
});

test('users inventory evidence accepts an exact parent tree or canonical user child', async (t) => {
  await t.test('parent tree', async () => {
    const { requests, result } = await pullFromTree([
      usersDirectoryEntry(),
    ]);
    assert.equal(requests.length, 1);
    assert.equal(result.totalCount, 0);
  });

  await t.test('canonical user child without parent entries', async () => {
    const user = userTreeEntry(7, { size: 0 });
    const { requests, result } = await pullFromTree(
      [user],
      { knownShas: { [user.path]: user.sha } }
    );
    assert.equal(requests.length, 1);
    assert.deepEqual(result.shas, { [user.path]: user.sha });
    assert.equal(result.fetchedCount, 0);
    assert.equal(result.totalCount, 1);
  });
});

test('users inventory rejects an inexact sentinel and complete absence', async (t) => {
  for (const scenario of [
    {
      name: 'wrong SHA',
      tree: [
        usersDirectoryEntry(),
        emptyUsersSentinelEntry({ sha: SHA }),
      ],
    },
    {
      name: 'wrong type',
      tree: [
        usersDirectoryEntry(),
        emptyUsersSentinelEntry({ type: 'tree', size: undefined }),
      ],
    },
    {
      name: 'wrong size',
      tree: [
        usersDirectoryEntry(),
        emptyUsersSentinelEntry({ size: 0 }),
      ],
    },
    {
      name: 'wrong case',
      tree: [
        usersDirectoryEntry(),
        emptyUsersSentinelEntry({
          path: 'annotations/users/.GITKEEP',
        }),
      ],
    },
    {
      name: 'nested sentinel',
      tree: [
        usersDirectoryEntry(),
        emptyUsersSentinelEntry({
          path: 'annotations/users/nested/.gitkeep',
        }),
      ],
    },
    {
      name: 'absent inventory',
      tree: [{
        type: 'commit',
        path: 'vendor/reference-atlas',
        sha: SHA,
      }],
    },
  ]) {
    await t.test(scenario.name, async () => {
      await assert.rejects(
        () => pullFromTree(scenario.tree),
        /annotations\/users|user-file/i
      );
    });
  }
});

test('setup guide states the bounded empty-users inventory contract', () => {
  assert.match(
    setupGuide,
    /tree must prove an exact `annotations\/users` inventory through\s+its directory entry or a valid direct child\./
  );
  assert.match(setupGuide, new RegExp(EMPTY_USERS_SENTINEL_SHA));
  assert.match(
    setupGuide,
    /never downloaded or included in user SHAs, counts, or decoded-byte\s+limits\./
  );
  assert.match(
    setupGuide,
    /absent inventory or an inexact, renamed, or nested sentinel fails/
  );
});

test('an unrelated canonical Git submodule does not break annotation Pull', async () => {
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({
      tree: [
        usersDirectoryEntry(),
        {
          type: 'commit',
          path: 'vendor/reference-atlas',
          sha: SHA,
        },
      ],
      truncated: false,
    }), { status: 200 });
  };
  try {
    assert.deepEqual(await createSync().pullAllUsers(), {
      docs: [],
      shas: {},
      fetchedCount: 0,
      totalCount: 0,
      concurrency: 8,
    });
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('user-file count and aggregate decoded bytes are bounded from the tree before blob reads', async t => {
  for (const scenario of [
    {
      name: 'user-file count',
      tree: Array.from(
        { length: COMMUNITY_ANNOTATION_MAX_PULL_USER_FILES + 1 },
        (_, index) => userTreeEntry(index + 1, { size: 0 })
      ),
      kind: 'user-files',
      actual: COMMUNITY_ANNOTATION_MAX_PULL_USER_FILES + 1,
      maximum: COMMUNITY_ANNOTATION_MAX_PULL_USER_FILES,
    },
    {
      name: 'aggregate decoded bytes',
      tree: Array.from(
        {
          length:
            Math.floor(
              COMMUNITY_ANNOTATION_MAX_PULL_UTF8_BYTES / 1_000_000
            ) + 1,
        },
        (_, index) => userTreeEntry(index + 1, { size: 1_000_000 })
      ),
      kind: 'decoded-bytes',
      actual: COMMUNITY_ANNOTATION_MAX_PULL_UTF8_BYTES + 1_000_000,
      maximum: COMMUNITY_ANNOTATION_MAX_PULL_UTF8_BYTES,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const previousFetch = globalThis.fetch;
      let requests = 0;
      globalThis.fetch = async () => {
        requests += 1;
        return new Response(JSON.stringify({
          tree: scenario.tree,
          truncated: false,
        }), { status: 200 });
      };
      try {
        await assert.rejects(
          () => createSync().pullAllUsers(),
          error => {
            assert.equal(
              error?.code,
              'COMMUNITY_ANNOTATION_PULL_LIMIT'
            );
            assert.equal(error?.phase, 'remote-tree-preflight');
            assert.equal(error?.kind, scenario.kind);
            assert.equal(error?.actual, scenario.actual);
            assert.equal(error?.maximum, scenario.maximum);
            return true;
          }
        );
        assert.equal(requests, 1);
      } finally {
        globalThis.fetch = previousFetch;
      }
    });
  }
});

test('one invalid blob stops claims, aborts its active batch, and retains the first error', async () => {
  const previousFetch = globalThis.fetch;
  const entries = Array.from(
    { length: 24 },
    (_, index) => userTreeEntry(index + 1)
  );
  let blobRequests = 0;
  let abortedRequests = 0;
  const activeSignals = [];

  globalThis.fetch = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname.includes('/git/trees/')) {
      return new Response(JSON.stringify({
        tree: entries,
        truncated: false,
      }), { status: 200 });
    }
    assert.match(url.pathname, /\/git\/blobs\//);
    blobRequests += 1;
    activeSignals.push(options.signal);
    if (blobRequests === 1) {
      return new Response(JSON.stringify({
        encoding: 'base64',
        content: Buffer.from('{}', 'utf8').toString('base64'),
      }), { status: 200 });
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        abortedRequests += 1;
        reject(new DOMException('synthetic peer abort', 'AbortError'));
      };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    });
  };

  try {
    await assert.rejects(
      () => createSync().pullAllUsers(),
      error => {
        assert.equal(
          error?.code,
          'COMMUNITY_ANNOTATION_CONTRACT_INVALID'
        );
        assert.match(String(error), /missing required field "version"/);
        return true;
      }
    );
    assert.equal(blobRequests, 8);
    assert.equal(abortedRequests, 7);
    assert.equal(activeSignals.length, 8);
    assert.equal(activeSignals[0].aborted, false);
    assert.equal(
      activeSignals.slice(1).every(signal => signal.aborted),
      true
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});
