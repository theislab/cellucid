// The community-annotation Worker's wire contract version 3: the GraphQL
// reads, the content-addressed tree read, conditional requests, the relayed
// GitHub headers, the ref force update and the caller binding of every
// write. Each test drives `worker.fetch` directly with GitHub stubbed; nothing
// reaches the network. Repros r02 and r04 of the 2026-11-05 backend audit are
// kept here.

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../assets/js/app/community-annotations/_worker-code.js';
import { WORKER_EXPOSED_RESPONSE_HEADERS } from '../assets/js/app/community-annotations/worker-contract.js';
import { withMockedFetch } from './helpers/worker-fetch.mjs';

const ENV = Object.freeze({
  ALLOWED_ORIGINS: 'https://app.example',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});
const ORIGIN = 'https://app.example';
const OPERATION_ID = '018f5e3a-7b9c-4d2e-8f10-123456789abc';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const CALLER = Object.freeze({ id: 42, login: 'Researcher' });
const RATE_HEADERS = Object.freeze({
  'X-RateLimit-Limit': '5000',
  'X-RateLimit-Remaining': '4321',
  'X-RateLimit-Reset': '2000000000',
  'X-RateLimit-Used': '679',
  'X-RateLimit-Resource': 'core',
  'X-GitHub-Request-Id': 'ABCD:1234:5678:9ABC:DEF0',
});

const SNAPSHOT_QUERY = `query CellucidAnnotationSnapshot($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) {
      target {
        oid
        ... on Commit {
          annotations: file(path: "annotations") {
            oid type
            object { ... on Tree { entries { name type oid object { ... on Blob { byteSize } } } } }
          }
          moderation: file(path: "annotations/moderation") {
            oid type
            object { ... on Tree { entries { name type oid object { ... on Blob { byteSize } } } } }
          }
        }
      }
    }
  }
  rateLimit { cost limit remaining resetAt }
}`;

function request(path, options = {}) {
  return new Request(`https://worker.example${path}`, options);
}

function readHeaders(extra = {}) {
  return { Authorization: 'Bearer token', Origin: ORIGIN, ...extra };
}

function jsonHeaders(extra = {}) {
  return readHeaders({ 'Content-Type': 'application/json', ...extra });
}

function mutationHeaders(extra = {}) {
  return jsonHeaders({ 'X-Cellucid-Operation-Id': OPERATION_ID, ...extra });
}

/** A GitHub stub that records every request and answers `GET /user` as CALLER. */
function github(answer) {
  const calls = [];
  return {
    calls,
    mutations: () => calls.filter(call => call.url !== 'https://api.github.com/user'),
    async fetch(url, options = {}) {
      const call = {
        url: String(url),
        method: options.method ?? 'GET',
        headers: new Headers(options.headers),
        body: options.body,
        signal: options.signal,
      };
      calls.push(call);
      if (call.url === 'https://api.github.com/user') {
        return new Response(JSON.stringify(CALLER), { status: 200, headers: RATE_HEADERS });
      }
      return answer(call);
    },
  };
}

async function responseBytes(response) {
  return new Uint8Array(await response.arrayBuffer());
}

// -- GraphQL ---------------------------------------------------------------

test('/graphql/snapshot sends the Worker\'s own query with variables and relays GitHub\'s answer unparsed', async () => {
  // Not JSON at all: the Worker never parses the answer, so any bytes pass.
  const answerBytes = new Uint8Array([0x7b, 0xff, 0x00, 0x22, 0x7d]);
  const stub = github(() => new Response(answerBytes, {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...RATE_HEADERS, 'Set-Cookie': 'secret=1' },
  }));
  await withMockedFetch(stub.fetch, async () => {
    const response = await worker.fetch(request('/graphql/snapshot', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ owner: 'theislab', repo: 'cellucid-annotation', branch: 'release/v1' }),
    }), ENV);
    assert.equal(response.status, 200);
    assert.deepEqual(await responseBytes(response), answerBytes);
    assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.deepEqual(
      response.headers.get('Access-Control-Expose-Headers').split(', '),
      [...WORKER_EXPOSED_RESPONSE_HEADERS]
    );
    for (const [name, value] of Object.entries(RATE_HEADERS)) {
      assert.equal(response.headers.get(name), value, name);
    }
    assert.equal(response.headers.get('Set-Cookie'), null);
  });
  assert.equal(stub.calls.length, 1);
  const [call] = stub.calls;
  assert.equal(call.url, 'https://api.github.com/graphql');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.get('Authorization'), 'Bearer token');
  assert.equal(call.headers.get('Content-Type'), 'application/json');
  assert.equal(call.headers.get('User-Agent'), 'Cellucid-GitHub-App');
  assert.deepEqual(JSON.parse(call.body), {
    query: SNAPSHOT_QUERY,
    variables: { owner: 'theislab', name: 'cellucid-annotation', ref: 'refs/heads/release/v1' },
  });
});

test('GraphQL answers of every status are relayed as GitHub sent them', async () => {
  for (const [status, body, contentType] of [
    [200, '{"data":null,"errors":[{"type":"NOT_FOUND","message":"Could not resolve"}]}', 'application/json; charset=utf-8'],
    [401, '{"message":"Bad credentials"}', 'application/json; charset=utf-8'],
    [502, '<html>Unicorn!</html>', 'text/html'],
  ]) {
    const stub = github(() => new Response(body, {
      status,
      headers: { 'Content-Type': contentType, 'Retry-After': '30', 'X-RateLimit-Remaining': '17' },
    }));
    await withMockedFetch(stub.fetch, async () => {
      const response = await worker.fetch(request('/graphql/blobs', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ owner: 'o', repo: 'r', oids: [SHA_A] }),
      }), ENV);
      assert.equal(response.status, status);
      assert.equal(await response.text(), body);
      assert.equal(response.headers.get('Content-Type'), contentType);
      assert.equal(response.headers.get('Retry-After'), '30');
      assert.equal(response.headers.get('X-RateLimit-Remaining'), '17');
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    });
  }
});

test('/graphql/blobs names each object by a variable, with aliases in request order', async () => {
  const stub = github(() => new Response('{}', { status: 200 }));
  const oids = [SHA_B, SHA_A, 'c'.repeat(40)];
  await withMockedFetch(stub.fetch, async () => {
    const response = await worker.fetch(request('/graphql/blobs', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ owner: 'o', repo: 'r', oids }),
    }), ENV);
    assert.equal(response.status, 200);
  });
  const sent = JSON.parse(stub.calls[0].body);
  assert.equal(
    sent.query,
    'query CellucidAnnotationBlobs($owner: String!, $name: String!, $o0: GitObjectID!, $o1: GitObjectID!, $o2: GitObjectID!) {\n' +
      '  repository(owner: $owner, name: $name) {\n' +
      '    b0: object(oid: $o0) { ... on Blob { oid byteSize isBinary isTruncated text } }\n' +
      '    b1: object(oid: $o1) { ... on Blob { oid byteSize isBinary isTruncated text } }\n' +
      '    b2: object(oid: $o2) { ... on Blob { oid byteSize isBinary isTruncated text } }\n' +
      '  }\n' +
      '  rateLimit { cost limit remaining resetAt }\n' +
      '}'
  );
  assert.deepEqual(sent.variables, { owner: 'o', name: 'r', o0: SHA_B, o1: SHA_A, o2: 'c'.repeat(40) });
});

test('/graphql/blobs has no count cap: only the request-body bound decides', async () => {
  const stub = github(() => new Response('{}', { status: 200 }));
  const oids = Array.from({ length: 20_000 }, (_, index) => index.toString(16).padStart(40, '0'));
  await withMockedFetch(stub.fetch, async () => {
    const response = await worker.fetch(request('/graphql/blobs', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ owner: 'o', repo: 'r', oids }),
    }), ENV);
    assert.equal(response.status, 200);
    const tooLarge = await worker.fetch(request('/graphql/blobs', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        owner: 'o',
        repo: 'r',
        oids: Array.from({ length: 40_000 }, (_, index) => index.toString(16).padStart(40, '0')),
      }),
    }), ENV);
    assert.equal(tooLarge.status, 413);
  });
  assert.equal(stub.calls.length, 1);
  assert.equal(Object.keys(JSON.parse(stub.calls[0].body).variables).length, 20_002);
});

test('GraphQL routes refuse anything but their exact request before asking GitHub', async () => {
  const stub = github(() => new Response('{}', { status: 200 }));
  const snapshot = body => ({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
  const cases = [
    ['/graphql/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: '{"owner":"o","repo":"r","branch":"main"}' }, 401],
    ['/graphql/snapshot', { method: 'POST', headers: readHeaders({ 'Content-Type': 'text/plain' }), body: '{"owner":"o","repo":"r","branch":"main"}' }, 415],
    ['/graphql/snapshot', snapshot({ owner: 'o', repo: 'r' }), 400],
    ['/graphql/snapshot', snapshot({ owner: 'o', repo: 'r', branch: 'main', query: 'query { viewer { login } }' }), 400],
    ['/graphql/snapshot', snapshot({ owner: '-o', repo: 'r', branch: 'main' }), 400],
    ['/graphql/snapshot', snapshot({ owner: 'o', repo: 'r.git', branch: 'main' }), 400],
    ['/graphql/snapshot', snapshot({ owner: 'o', repo: 'r', branch: 'refs/heads/main' }), 400],
    ['/graphql/snapshot', snapshot({ owner: 'o', repo: 'r', branch: '../main' }), 400],
    ['/graphql/snapshot?x=1', snapshot({ owner: 'o', repo: 'r', branch: 'main' }), 400],
    ['/graphql/snapshot', { method: 'POST', headers: jsonHeaders({ 'If-None-Match': '"x"' }), body: '{"owner":"o","repo":"r","branch":"main"}' }, 400],
    ['/graphql/snapshot', { method: 'POST', headers: jsonHeaders({ 'X-Cellucid-Operation-Id': OPERATION_ID }), body: '{"owner":"o","repo":"r","branch":"main"}' }, 400],
    ['/graphql/snapshot', { method: 'GET', headers: readHeaders() }, 405],
    ['/graphql/blobs', snapshot({ owner: 'o', repo: 'r', oids: [] }), 400],
    ['/graphql/blobs', snapshot({ owner: 'o', repo: 'r', oids: [SHA_A, SHA_A] }), 400],
    ['/graphql/blobs', snapshot({ owner: 'o', repo: 'r', oids: [SHA_A.toUpperCase()] }), 400],
    ['/graphql/blobs', snapshot({ owner: 'o', repo: 'r', oids: [42] }), 400],
    ['/graphql/blobs', snapshot({ owner: 'o', repo: 'r', oids: SHA_A }), 400],
    ['/graphql/blobs', snapshot({ owner: 'o', repo: 'r', oids: [SHA_A], ref: 'main' }), 400],
    ['/graphql/query', snapshot({ query: 'query { viewer { login } }' }), 404],
  ];
  await withMockedFetch(stub.fetch, async () => {
    for (const [path, options, status] of cases) {
      const response = await worker.fetch(request(path, options), ENV);
      assert.equal(response.status, status, `${path} ${options.body ?? ''}`);
    }
  });
  assert.equal(stub.calls.length, 0);
});

// -- Trees (repro r02) -------------------------------------------------------

test('a tree is read by object id, non-recursively, and relayed whole without a byte cut (repro r02)', async () => {
  // About 230 bytes per entry: 100,000 entries are some 23 MB, three times the
  // 7,500,000-byte cut the Worker used to make after its 200.
  const entry = index => JSON.stringify({
    path: `ghid_${100_000_000 + index}.json`,
    mode: '100644',
    type: 'blob',
    sha: index.toString(16).padStart(40, '0'),
    size: 4096,
    url: `https://api.github.com/repos/o/r/git/blobs/${index.toString(16).padStart(40, '0')}`,
  });
  const text =
    `{"sha":"${SHA_A}","url":"https://api.github.com/x","tree":[` +
    Array.from({ length: 100_000 }, (_, index) => entry(index)).join(',') +
    '],"truncated":false}';
  const bytes = new TextEncoder().encode(text);
  assert.ok(bytes.byteLength > 20_000_000);
  const stub = github(() => new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += 65_536) {
        controller.enqueue(bytes.subarray(offset, offset + 65_536));
      }
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ETag: '"tree"' } }));
  await withMockedFetch(stub.fetch, async () => {
    const response = await worker.fetch(request(`/api/repos/o/r/git/trees/${SHA_A}`, { headers: readHeaders() }), ENV);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('ETag'), '"tree"');
    const relayed = await responseBytes(response);
    assert.equal(relayed.byteLength, bytes.byteLength);
    assert.deepEqual(relayed, bytes);
  });
  assert.equal(stub.calls[0].url, `https://api.github.com/repos/o/r/git/trees/${SHA_A}`);
});

test('the branch and recursive tree read is gone; a tree read takes exactly one object id', async () => {
  const stub = github(() => new Response('{}', { status: 200 }));
  await withMockedFetch(stub.fetch, async () => {
    for (const path of [
      '/api/repos/o/r/git/trees/main?recursive=1',
      '/api/repos/o/r/git/trees/main',
      `/api/repos/o/r/git/trees/${SHA_A}?recursive=1`,
      `/api/repos/o/r/git/trees/${SHA_A.toUpperCase()}`,
      `/api/repos/o/r/git/trees/${SHA_A}/x`,
    ]) {
      const response = await worker.fetch(request(path, { headers: readHeaders() }), ENV);
      assert.ok(response.status === 400 || response.status === 404, `${path}: ${response.status}`);
    }
  });
  assert.equal(stub.calls.length, 0);
});

// -- Relayed headers (repro r04) and conditional requests ------------------

test('every GitHub answer carries its rate-limit headers to the page, failures included (repro r04)', async () => {
  const scenarios = [
    ['JSON 503', 503, '{"message":"Service Unavailable"}', 'Service Unavailable'],
    ['HTML 503', 503, '<html>Unicorn!</html>', 'GitHub API GET /repos/o/r failed: GitHub answered HTTP 503'],
    ['404', 404, '{"message":"Not Found"}', 'Not Found'],
  ];
  for (const [label, status, body, error] of scenarios) {
    const stub = github(() => new Response(body, { status, headers: { ...RATE_HEADERS, 'Retry-After': '30', ETag: 'W/"e"' } }));
    await withMockedFetch(stub.fetch, async () => {
      const response = await worker.fetch(request('/api/repos/o/r', { headers: readHeaders() }), ENV);
      assert.equal(response.status, status, label);
      assert.deepEqual(await response.json(), { error }, label);
      for (const [name, value] of Object.entries(RATE_HEADERS)) {
        assert.equal(response.headers.get(name), value, `${label} ${name}`);
      }
      assert.equal(response.headers.get('Retry-After'), '30', label);
      assert.equal(response.headers.get('ETag'), 'W/"e"', label);
      assert.match(response.headers.get('Access-Control-Expose-Headers'), /X-RateLimit-Remaining/);
    });
  }
});

test('relayed GitHub headers keep only values in their grammar', async () => {
  const stub = github(() => new Response('{"message":"x"}', {
    status: 429,
    headers: {
      'X-RateLimit-Remaining': '-1',
      'X-RateLimit-Reset': '1e9',
      'X-RateLimit-Resource': 'Core Search',
      'Retry-After': 'soon',
      ETag: 'abc',
      'X-GitHub-Request-Id': 'a b',
    },
  }));
  await withMockedFetch(stub.fetch, async () => {
    const response = await worker.fetch(request('/api/repos/o/r', { headers: readHeaders() }), ENV);
    assert.equal(response.status, 429);
    for (const name of ['X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-RateLimit-Resource', 'Retry-After', 'ETag', 'X-GitHub-Request-Id']) {
      assert.equal(response.headers.get(name), null, name);
    }
  });
});

test('GitHub reads pass If-None-Match on and answer 304 with no body and the GitHub headers', async () => {
  const paths = [
    '/api/repos/o/r',
    '/api/repos/o/r?fork_identity=1',
    '/api/repos/o/r/contents/annotations/config.json?ref=main',
    `/api/repos/o/r/git/trees/${SHA_A}`,
    `/api/repos/o/r/git/blobs/${SHA_A}`,
    '/api/repos/o/r/git/ref/heads/main',
    '/auth/user',
    '/auth/installations?page=1',
  ];
  for (const path of paths) {
    const stub = { calls: [] };
    stub.fetch = async (url, options = {}) => {
      stub.calls.push({ url: String(url), headers: new Headers(options.headers) });
      return new Response(null, { status: 304, headers: { ETag: '"v1"', ...RATE_HEADERS } });
    };
    await withMockedFetch(stub.fetch, async () => {
      const response = await worker.fetch(request(path, {
        headers: readHeaders({ 'If-None-Match': 'W/"v0", "v1"' }),
      }), ENV);
      assert.equal(response.status, 304, path);
      assert.equal(await response.text(), '', path);
      assert.equal(response.headers.get('ETag'), '"v1"', path);
      assert.equal(response.headers.get('X-RateLimit-Remaining'), '4321', path);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN, path);
    });
    assert.equal(stub.calls.length, 1, path);
    assert.equal(stub.calls[0].headers.get('If-None-Match'), 'W/"v0", "v1"', path);
  }
});

test('If-None-Match must be an entity-tag list, and only GitHub reads accept one', async () => {
  const stub = github(() => new Response('{}', { status: 200 }));
  await withMockedFetch(stub.fetch, async () => {
    const malformed = await worker.fetch(request('/api/repos/o/r', {
      headers: readHeaders({ 'If-None-Match': 'v1' }),
    }), ENV);
    assert.equal(malformed.status, 400);
    const onWrite = await worker.fetch(request('/api/repos/o/r/contents/annotations/config.json', {
      method: 'PUT',
      headers: mutationHeaders({ 'If-None-Match': '"v1"' }),
      body: JSON.stringify({ message: 'm', content: 'e30=', branch: 'main' }),
    }), ENV);
    assert.equal(onWrite.status, 400);
    assert.equal(onWrite.headers.get('X-Cellucid-Operation-Outcome'), 'not-applied');
  });
  assert.equal(stub.calls.length, 0);
});

// -- Ref force update and caller binding ------------------------------------

const CONTRIBUTION_BRANCH = 'cellucid-annotations/ghid_42/0123abcd';

function contentsPut(path, body) {
  return request(path, { method: 'PUT', headers: mutationHeaders(), body: JSON.stringify(body) });
}

function gitResponse(call) {
  if (call.method === 'PATCH') {
    return new Response(JSON.stringify({ ref: 'refs/heads/x', object: { sha: SHA_B, type: 'commit' } }), { status: 200, headers: RATE_HEADERS });
  }
  if (call.url.endsWith('/git/refs')) return new Response('{"ref":"refs/heads/x"}', { status: 201 });
  if (call.url.endsWith('/pulls')) return new Response(JSON.stringify({ number: 7, html_url: 'https://github.com/o/r/pull/7' }), { status: 201 });
  return new Response(JSON.stringify({ content: { sha: SHA_B } }), { status: 200, headers: RATE_HEADERS });
}

test('PATCH moves the caller\'s own contribution branch in the caller\'s own repository with force', async () => {
  const stub = github(gitResponse);
  await withMockedFetch(stub.fetch, async () => {
    const response = await worker.fetch(request(
      `/api/repos/researcher/cellucid-annotation/git/refs/heads/${CONTRIBUTION_BRANCH}`,
      { method: 'PATCH', headers: mutationHeaders(), body: JSON.stringify({ sha: SHA_A, force: true }) }
    ), ENV);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { object: { sha: SHA_B } });
    assert.equal(response.headers.get('X-Cellucid-Operation-Id'), OPERATION_ID);
    assert.equal(response.headers.get('X-Cellucid-Operation-Outcome'), 'applied');
    assert.equal(response.headers.get('X-RateLimit-Remaining'), '4321');
  });
  assert.deepEqual(stub.calls.map(call => `${call.method} ${call.url}`), [
    'GET https://api.github.com/user',
    `PATCH https://api.github.com/repos/researcher/cellucid-annotation/git/refs/heads/${CONTRIBUTION_BRANCH}`,
  ]);
  assert.equal(stub.calls[1].body, `{"sha":"${SHA_A}","force":true}`);
});

test('PATCH refuses another branch, another repository owner and any other body', async () => {
  const patch = (path, body) => request(path, { method: 'PATCH', headers: mutationHeaders(), body: JSON.stringify(body) });
  const own = `/api/repos/researcher/r/git/refs/heads/${CONTRIBUTION_BRANCH}`;
  const cases = [
    [patch('/api/repos/researcher/r/git/refs/heads/main', { sha: SHA_A, force: true }), 403],
    [patch('/api/repos/researcher/r/git/refs/heads/cellucid-annotations/ghid_43/x', { sha: SHA_A, force: true }), 403],
    [patch('/api/repos/researcher/r/git/refs/heads/cellucid-annotations/ghid_4/x', { sha: SHA_A, force: true }), 403],
    [patch('/api/repos/researcher/r/git/refs/heads/cellucid-annotations/ghid_42', { sha: SHA_A, force: true }), 403],
    [patch(`/api/repos/theislab/r/git/refs/heads/${CONTRIBUTION_BRANCH}`, { sha: SHA_A, force: true }), 403],
    [patch(own, { sha: SHA_A }), 400],
    [patch(own, { sha: SHA_A, force: false }), 400],
    [patch(own, { sha: SHA_A, force: true, extra: 1 }), 400],
    [patch(own, { sha: 'short', force: true }), 400],
    [patch(`${own}?force=true`, { sha: SHA_A, force: true }), 400],
    [patch('/api/repos/researcher/r/git/refs/tags/v1', { sha: SHA_A, force: true }), 404],
    [patch('/api/repos/researcher/r/pulls', { title: 'x' }), 405],
  ];
  const stub = github(gitResponse);
  await withMockedFetch(stub.fetch, async () => {
    for (const [patchRequest, status] of cases) {
      const url = patchRequest.url;
      const response = await worker.fetch(patchRequest, ENV);
      assert.equal(response.status, status, url);
      assert.equal(response.headers.get('X-Cellucid-Operation-Outcome'), 'not-applied', url);
    }
  });
  assert.deepEqual(stub.mutations(), [], 'nothing refused reaches GitHub');
});

test('the repository owner matches the caller\'s login whatever its case', async () => {
  const stub = github(gitResponse);
  await withMockedFetch(stub.fetch, async () => {
    const response = await worker.fetch(request(
      `/api/repos/RESEARCHER/r/git/refs/heads/${CONTRIBUTION_BRANCH}`,
      { method: 'PATCH', headers: mutationHeaders(), body: JSON.stringify({ sha: SHA_A, force: true }) }
    ), ENV);
    assert.equal(response.status, 200);
  });
});

test('a user file is written only by its own user, after one caller lookup', async () => {
  const stub = github(gitResponse);
  await withMockedFetch(stub.fetch, async () => {
    const other = await worker.fetch(contentsPut('/api/repos/o/r/contents/annotations/users/ghid_43.json', {
      message: 'm', content: 'e30=', branch: 'main',
    }), ENV);
    assert.equal(other.status, 403);
    assert.deepEqual(await other.json(), { error: 'The signed-in user may write only annotations/users/ghid_42.json' });
    assert.equal(other.headers.get('X-Cellucid-Operation-Outcome'), 'not-applied');
    // The lookup spent GitHub budget: its headers come back too (its ETag does not).
    assert.equal(other.headers.get('X-RateLimit-Remaining'), '4321');
    assert.equal(other.headers.get('ETag'), null);

    const own = await worker.fetch(contentsPut('/api/repos/o/r/contents/annotations/users/ghid_42.json', {
      message: 'm', content: 'e30=', branch: 'main',
    }), ENV);
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('X-Cellucid-Operation-Outcome'), 'applied');
  });
  assert.deepEqual(stub.calls.map(call => `${call.method} ${call.url}`), [
    'GET https://api.github.com/user',
    'GET https://api.github.com/user',
    'PUT https://api.github.com/repos/o/r/contents/annotations/users/ghid_42.json',
  ]);
});

test('a contribution branch is written only as the caller\'s own; other writes need no lookup', async () => {
  const stub = github(gitResponse);
  await withMockedFetch(stub.fetch, async () => {
    const config = await worker.fetch(contentsPut('/api/repos/o/r/contents/annotations/config.json', {
      message: 'm', content: 'e30=', branch: 'main',
    }), ENV);
    assert.equal(config.status, 200);
    assert.equal(stub.calls.length, 1, 'a config write to main asks GitHub nothing else');

    for (const branch of ['cellucid-annotations/ghid_43/x', 'cellucid-annotations/x', 'cellucid-annotations/ghid_420/x']) {
      const response = await worker.fetch(contentsPut('/api/repos/o/r/contents/annotations/moderation/merges.json', {
        message: 'm', content: 'e30=', branch,
      }), ENV);
      assert.equal(response.status, 403, branch);
    }
    const own = await worker.fetch(contentsPut('/api/repos/researcher/r/contents/annotations/users/ghid_42.json', {
      message: 'm', content: 'e30=', branch: CONTRIBUTION_BRANCH, sha: SHA_A,
    }), ENV);
    assert.equal(own.status, 200);
  });
  assert.equal(stub.mutations().length, 2);
});

test('a branch is created only as the caller\'s own, in the caller\'s own repository', async () => {
  const create = (path, ref) => request(path, {
    method: 'POST',
    headers: mutationHeaders(),
    body: JSON.stringify({ ref, sha: SHA_A }),
  });
  const stub = github(gitResponse);
  await withMockedFetch(stub.fetch, async () => {
    for (const [path, ref] of [
      ['/api/repos/researcher/r/git/refs', 'refs/heads/main'],
      ['/api/repos/researcher/r/git/refs', 'refs/heads/cellucid-annotations/ghid_43/x'],
      ['/api/repos/theislab/r/git/refs', `refs/heads/${CONTRIBUTION_BRANCH}`],
    ]) {
      const response = await worker.fetch(create(path, ref), ENV);
      assert.equal(response.status, 403, `${path} ${ref}`);
    }
    const own = await worker.fetch(create('/api/repos/researcher/r/git/refs', `refs/heads/${CONTRIBUTION_BRANCH}`), ENV);
    assert.equal(own.status, 201);
  });
  assert.equal(stub.mutations().length, 1);
});

test('a Pull Request is opened only from the caller\'s own contribution branch', async () => {
  const open = head => request('/api/repos/theislab/r/pulls', {
    method: 'POST',
    headers: mutationHeaders(),
    body: JSON.stringify({ title: 't', head, base: 'main', body: 'b', maintainer_can_modify: true }),
  });
  const stub = github(gitResponse);
  await withMockedFetch(stub.fetch, async () => {
    for (const head of ['someone:cellucid-annotations/ghid_42/x', 'researcher:cellucid-annotations/ghid_43/x', 'researcher:main']) {
      const response = await worker.fetch(open(head), ENV);
      assert.equal(response.status, 403, head);
    }
    const own = await worker.fetch(open(`researcher:${CONTRIBUTION_BRANCH}`), ENV);
    assert.equal(own.status, 201);
  });
  assert.equal(stub.mutations().length, 1);
});

test('a failed caller lookup answers with its own status and never writes', async () => {
  for (const [status, body, error] of [
    [401, '{"message":"Bad credentials"}', 'The signed-in GitHub user could not be identified: Bad credentials'],
    [503, '<html>down</html>', 'The signed-in GitHub user could not be identified: GitHub user lookup failed: GitHub answered HTTP 503'],
  ]) {
    const calls = [];
    await withMockedFetch(async (url) => {
      calls.push(String(url));
      return new Response(body, { status, headers: { 'X-RateLimit-Remaining': '9' } });
    }, async () => {
      const response = await worker.fetch(contentsPut('/api/repos/o/r/contents/annotations/users/ghid_42.json', {
        message: 'm', content: 'e30=', branch: 'main',
      }), ENV);
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error });
      assert.equal(response.headers.get('X-Cellucid-Operation-Outcome'), 'not-applied');
      assert.equal(response.headers.get('X-RateLimit-Remaining'), '9');
    });
    assert.deepEqual(calls, ['https://api.github.com/user']);
  }
});

test('what GitHub receives is re-serialised from the checked values, never the bytes sent', async () => {
  const stub = github(gitResponse);
  await withMockedFetch(stub.fetch, async () => {
    // A repeated key keeps its last value under native JSON parsing; that
    // value is the one checked (here: refused) and the one that would be sent.
    const smuggled = await worker.fetch(request('/api/repos/o/r/contents/annotations/config.json', {
      method: 'PUT',
      headers: mutationHeaders(),
      body: `{"message":"m","content":"e30=","branch":"main","\\u0062ranch":"cellucid-annotations/ghid_43/x"}`,
    }), ENV);
    assert.equal(smuggled.status, 403);

    const spaced = await worker.fetch(request('/api/repos/o/r/contents/annotations/config.json', {
      method: 'PUT',
      headers: mutationHeaders(),
      body: `{ "branch" : "main", "content":"e30=", "message":"m", "sha":"${SHA_A}" }`,
    }), ENV);
    assert.equal(spaced.status, 200);
  });
  const forwarded = stub.mutations();
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].body, `{"message":"m","content":"e30=","branch":"main","sha":"${SHA_A}"}`);
});

test('commit, Pull Request and annotation text have no length caps in the Worker', async () => {
  const stub = github(gitResponse);
  const long = 'x'.repeat(100_000);
  await withMockedFetch(stub.fetch, async () => {
    const put = await worker.fetch(contentsPut('/api/repos/o/r/contents/annotations/config.json', {
      message: long, content: 'e30=', branch: 'main',
    }), ENV);
    assert.equal(put.status, 200);
    const pull = await worker.fetch(request('/api/repos/theislab/r/pulls', {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({ title: long, head: `researcher:${CONTRIBUTION_BRANCH}`, base: 'main', body: long, maintainer_can_modify: true }),
    }), ENV);
    assert.equal(pull.status, 201);
  });
});

test('a file\'s base64 must be canonical: no whitespace, no nonzero pad bits, no stray padding', async () => {
  const stub = github(gitResponse);
  await withMockedFetch(stub.fetch, async () => {
    for (const content of ['', 'e30', 'e30= ', 'e3\n0=', 'e31=', 'eB==', 'e30=e30=', 'e===', 'e30*', 'é30=']) {
      const response = await worker.fetch(contentsPut('/api/repos/o/r/contents/annotations/config.json', {
        message: 'm', content, branch: 'main',
      }), ENV);
      assert.equal(response.status, 400, JSON.stringify(content));
    }
    for (const content of ['e30=', 'eA==', 'eHk=', 'eHl6']) {
      const response = await worker.fetch(contentsPut('/api/repos/o/r/contents/annotations/config.json', {
        message: 'm', content, branch: 'main',
      }), ENV);
      assert.equal(response.status, 200, content);
    }
  });
});
