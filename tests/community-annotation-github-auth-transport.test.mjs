/**
 * The GitHub sign-in client's requests to the Worker (contract 3):
 *
 * - a Worker of another contract version is named for what it is: an older
 *   one must be redeployed by its owner (`GITHUB_WORKER_OUTDATED`), a newer
 *   one needs a reload; a Worker not reached is unreachable, never
 *   "incompatible";
 * - collections are read one GitHub page per request until `nextPage` is
 *   null (Cloudflare Free allows 50 subrequests per request), with no count
 *   cap of their own;
 * - every request goes through the app's transport on virtual time here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubAuthSession, getGitHubWorkerOrigin } from '../assets/js/app/community-annotations/github-auth.js';
import { WORKER_ENDPOINTS } from '../assets/js/app/community-annotations/worker-contract.js';
import { createHostBook } from '../assets/js/formats/io/hosts.js';
import { ResponseClock } from '../assets/js/formats/io/link.js';
import { virtualTime } from './helpers/virtual-time.mjs';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}
globalThis.sessionStorage ??= memoryStorage();
globalThis.localStorage ??= memoryStorage();

const ORIGIN = getGitHubWorkerOrigin();

function rootDocument(overrides = {}) {
  return { status: 'ok', service: 'Cellucid GitHub Auth', contractVersion: 3, endpoints: [...WORKER_ENDPOINTS], ...overrides };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A signed-in session whose requests go to `route(url, init)` on virtual time. */
function signedInSession(route) {
  const time = virtualTime();
  const calls = [];
  const session = new GitHubAuthSession({
    transport: {
      fetch: async (url, init) => {
        calls.push({ url: String(url), method: init.method, body: init.body ?? null });
        return route(new URL(String(url)), init);
      },
      hosts: createHostBook({ now: time.now, after: time.after }),
      clock: new ResponseClock({ clock: time.now, after: time.after }),
    },
  });
  session._token = 'ghu_test';
  return { session, calls };
}

test('an older Worker is named as one its owner must redeploy; nothing else is asked', async () => {
  const { session, calls } = signedInSession(() => json(rootDocument({ contractVersion: 2, endpoints: ['/auth/login'] })));
  await assert.rejects(session.listInstallations(), (error) => {
    assert.equal(error.code, 'GITHUB_WORKER_OUTDATED');
    assert.equal(error.workerContractVersion, 2);
    assert.match(error.message, /older version \(contract 2\) than this Cellucid \(contract 3\); its owner must redeploy the Worker/);
    return true;
  });
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ['/']);
});

test('a newer Worker asks for a reload; a foreign service or a wrong inventory is incompatible', async () => {
  for (const [answer, code, words] of [
    [() => json(rootDocument({ contractVersion: 4 })), 'GITHUB_WORKER_INCOMPATIBLE', /Reload Cellucid/],
    [() => json(rootDocument({ endpoints: ['/auth/login'] })), 'GITHUB_WORKER_INCOMPATIBLE', /not compatible/],
    [() => new Response('<!doctype html><title>Not found</title>', { status: 404 }), 'GITHUB_WORKER_INCOMPATIBLE', /not compatible/],
    [() => json({ hello: 'world' }), 'GITHUB_WORKER_INCOMPATIBLE', /not compatible/],
  ]) {
    const { session } = signedInSession(answer);
    await assert.rejects(session.listInstallations(), (error) => error.code === code && words.test(error.message));
  }
});

test('a Worker never reached is unreachable, not incompatible', async () => {
  const { session } = signedInSession(() => {
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(session.listInstallations(), (error) => {
    assert.equal(error.code, 'GITHUB_WORKER_UNREACHABLE');
    assert.equal(error.answeredBefore, false);
    assert.match(error.message, /ALLOWED_ORIGINS/);
    return true;
  });
});

test('installations are read page by page until the Worker says there is none after', async () => {
  const pages = {
    1: { items: [{ id: 1, account: { login: 'alice' } }, { id: 2, account: { login: 'lab' } }], nextPage: 2 },
    // A listing that shifted while it was read: installation 2 again.
    2: { items: [{ id: 2, account: { login: 'lab' } }, { id: 3, account: { login: 'org' } }], nextPage: 3 },
    3: { items: [], nextPage: null },
  };
  const { session, calls } = signedInSession((url) => {
    if (url.pathname === '/') return json(rootDocument());
    assert.equal(url.pathname, '/auth/installations');
    return json(pages[url.searchParams.get('page')]);
  });
  const { installations } = await session.listInstallations();
  assert.deepEqual(installations.map((item) => item.id), [1, 2, 3]);
  assert.deepEqual(
    calls.slice(1).map((call) => new URL(call.url).search),
    ['?page=1', '?page=2', '?page=3'],
  );
});

test('more than ten thousand repositories are listed whole', async () => {
  const total = 10_250;
  const pageCount = Math.ceil(total / 100);
  const { session, calls } = signedInSession((url, init) => {
    if (url.pathname === '/') return json(rootDocument());
    assert.equal(url.pathname, '/auth/installation-repos');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { installation_id: 7 });
    const page = Number(url.searchParams.get('page'));
    const items = [];
    for (let id = (page - 1) * 100 + 1; id <= Math.min(total, page * 100); id += 1) {
      items.push({ id, full_name: `owner/repo-${id}`, private: false });
    }
    return json({ items, nextPage: page < pageCount ? page + 1 : null });
  });
  const { repositories } = await session.listInstallationRepos(7);
  assert.equal(repositories.length, total);
  assert.equal(calls.length, 1 + pageCount);
});

test('a page that names any page but the next is refused', async () => {
  const { session } = signedInSession((url) => {
    if (url.pathname === '/') return json(rootDocument());
    return json({ items: [], nextPage: 1 });
  });
  await assert.rejects(session.listInstallations(), /nextPage must be 2 or null/);
});
