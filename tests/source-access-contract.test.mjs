import assert from 'node:assert/strict';
import test from 'node:test';

import { REMOTE_POLICY, httpByteSource, statedLifetimeMs } from '../assets/js/formats/io/byte-source.js';
import { LinkMeter } from '../assets/js/formats/io/link.js';
import { createAnnDataReaderHandler } from '../assets/js/data/anndata-reader-worker.js';
import {
  confirmSourceUnreadable,
  onSourceAccessRevoked,
  registerSourceAccess,
  resolveSourceAccess,
  revokeSourceAccess,
} from '../assets/js/data/sources/access.js';

import { virtualTime } from './helpers/virtual-time.mjs';

const SIZE = 1 << 20;
const DISPLAY = 'https://graph.microsoft.com/v1.0/drives/d1/items/i1/content';
const SECRET = 'SECRET-TOKEN-MARKER';

/** A host answering ranges of a SIZE-byte file, deciding each answer with `decide(url, headers)`. */
function host(decide = () => 206) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const headers = { ...(init.headers ?? {}) };
    calls.push({ url: String(url), headers });
    const outcome = decide(String(url), headers, calls.length);
    const status = typeof outcome === 'object' ? outcome.status : outcome;
    const finalUrl = typeof outcome === 'object' && outcome.url ? outcome.url : String(url);
    let body = null;
    if (status === 206) {
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(headers.Range);
      body = new Uint8Array(Number(end) - Number(start) + 1).fill(7);
    }
    const response = new Response(body, { status });
    Object.defineProperty(response, 'url', { value: finalUrl });
    return response;
  };
  return { calls, fetchImpl };
}

test('without access a read sends only Range to the resource URL', async () => {
  const { calls, fetchImpl } = host();
  const source = httpByteSource({ url: 'https://files.example.org/a.h5ad', size: SIZE }, { fetch: fetchImpl });
  await source.read(0, 10);
  assert.deepEqual(calls, [{ url: 'https://files.example.org/a.h5ad', headers: { Range: 'bytes=0-9' } }]);
});

test('parallel reads share one target; the display URL is never fetched', async () => {
  const { calls, fetchImpl } = host();
  let asked = 0;
  const access = {
    target: async ({ refresh }) => {
      asked += 1;
      assert.equal(refresh, false);
      await new Promise(resolve => setTimeout(resolve, 5));
      return { url: `https://dl.example.org/x?tempauth=${SECRET}`, headers: { Authorization: `Bearer ${SECRET}` } };
    },
  };
  const source = httpByteSource({ url: DISPLAY, size: SIZE, name: 'atlas.h5ad' }, { fetch: fetchImpl, access });
  await Promise.all(Array.from({ length: 20 }, (_, i) => source.read(i * 100, 50)));
  assert.equal(asked, 1);
  assert.equal(calls.length, 20);
  assert.ok(calls.every(call => call.url.startsWith('https://dl.example.org/') && call.headers.Authorization === `Bearer ${SECRET}`));
  assert.equal(source.url, DISPLAY);
});

test('a 401 renews the target once for every read that saw it, and is not a counted repeat', async () => {
  let token = 'old';
  const { calls, fetchImpl } = host((url, headers) => (headers.Authorization === 'Bearer old' ? 401 : 206));
  const refreshes = [];
  const access = {
    target: async ({ refresh }) => {
      refreshes.push(refresh);
      const answer = { url: 'https://www.googleapis.com/drive/v3/files/f?alt=media', headers: { Authorization: `Bearer ${token}` } };
      token = 'new';
      return answer;
    },
  };
  const source = httpByteSource({ url: 'https://www.googleapis.com/drive/v3/files/f?alt=media', size: SIZE }, { fetch: fetchImpl, access });
  const reads = await Promise.all(Array.from({ length: 20 }, (_, i) => source.read(i * 10, 10)));
  assert.equal(reads.length, 20);
  assert.deepEqual(refreshes, [false, true]);
  assert.equal(calls.filter(call => call.headers.Authorization === 'Bearer old').length, 20);
  assert.equal(calls.filter(call => call.headers.Authorization === 'Bearer new').length, 20);
});

test('a second stale answer fails with its status, naming the display link only', async () => {
  const { fetchImpl } = host(() => 403);
  const access = {
    target: async () => ({ url: `https://dl.example.org/x?tempauth=${SECRET}` }),
    isStale: status => status === 403,
  };
  const source = httpByteSource({ url: DISPLAY, size: SIZE }, { fetch: fetchImpl, access });
  await assert.rejects(source.read(0, 10), error => {
    assert.equal(error.status, 403);
    assert.match(error.message, /after its access was renewed/);
    assert.ok(!JSON.stringify({ m: error.message, d: error.details }).includes(SECRET));
    return true;
  });
});

test('a failed connection names the display link, never the target URL', async () => {
  const fetchImpl = async () => {
    throw new TypeError('Failed to fetch');
  };
  const access = { target: async () => ({ url: `https://dl.example.org/x?tempauth=${SECRET}` }) };
  const source = httpByteSource({ url: DISPLAY, size: SIZE }, { fetch: fetchImpl, access });
  // The repeats after a network failure wait, on the link's timers: here a
  // virtual clock's, which does not wait.
  const time = virtualTime();
  const link = new LinkMeter(REMOTE_POLICY, { clock: time.now, after: time.after });
  await assert.rejects(source.read(0, 10, { link }), error => {
    assert.ok(error.message.includes(DISPLAY));
    assert.ok(!JSON.stringify({ m: error.message, d: error.details }).includes(SECRET));
    return true;
  });
});

/**
 * A host that answers each request only after `ms` with a page this one is
 * not let read (Google Drive's held-back downloads: a 403 without CORS
 * headers about seven seconds later), on virtual time.
 */
function heldBackHost(time, ms = 7500) {
  const calls = [];
  const fetchImpl = (url, init = {}) => new Promise((resolve, reject) => {
    calls.push({ url: String(url), at: time.now() });
    const cancel = time.after(ms, () => reject(new TypeError('Failed to fetch')));
    init.signal?.addEventListener('abort', () => {
      cancel();
      reject(init.signal.reason);
    }, { once: true });
  });
  return { calls, fetchImpl };
}

/** How long one read takes to fail, on virtual time, and how; `onTime` is given the clock first. */
async function failureOf(access, onTime = () => {}) {
  const time = virtualTime();
  onTime(time);
  const { calls, fetchImpl } = heldBackHost(time);
  const source = httpByteSource({ url: DISPLAY, size: SIZE, name: 'a.h5ad' }, { fetch: fetchImpl, access });
  const link = new LinkMeter(REMOTE_POLICY, { clock: time.now, after: time.after });
  const error = await source.read(0, 10, { link }).then(() => null, failure => failure);
  return { error, ms: time.now(), requests: calls.length, time };
}

const HELD_TEXT = 'The host holds back downloads without a sign-in for now.';

test('a read the provider confirms unreadable fails at once in its words, without the generic repeats', async () => {
  let checks = 0;
  let checkTime = null;
  const generic = await failureOf({ target: async () => ({ url: `https://dl.example.org/x?key=${SECRET}` }) });
  const confirmed = await failureOf({
    target: async () => ({ url: `https://dl.example.org/x?key=${SECRET}` }),
    unreadable: HELD_TEXT,
    confirmUnreadable: async () => {
      checks += 1;
      // The provider's own one-byte confirm waits as long as the host takes.
      await checkTime.sleep(7500);
      return true;
    },
  }, time => {
    checkTime = time;
  });
  assert.equal(checks, 1);
  assert.equal(confirmed.error.code, 'unreadable');
  assert.equal(confirmed.error.message, `a.h5ad: ${HELD_TEXT}`);
  assert.ok(!JSON.stringify({ m: confirmed.error.message, d: confirmed.error.details }).includes(SECRET));
  // The first request stalls (1 s, the link's first timeout), the check then
  // answers 7.5 s later; the generic repeats run their whole course.
  assert.equal(confirmed.ms, 8500);
  assert.ok(generic.ms > 2 * confirmed.ms, `generic ${generic.ms} ms, confirmed ${confirmed.ms} ms`);
  assert.ok(confirmed.requests < generic.requests);
  assert.notEqual(generic.error.code, 'unreadable');
  assert.doesNotMatch(generic.error.message, /holds back/);
});

test('a read the provider does not confirm fails exactly as it would without the check', async () => {
  let checks = 0;
  let checkTime = null;
  const generic = await failureOf({ target: async () => ({ url: 'https://dl.example.org/x' }) });
  const unconfirmed = await failureOf({
    target: async () => ({ url: 'https://dl.example.org/x' }),
    unreadable: HELD_TEXT,
    confirmUnreadable: async () => {
      checks += 1;
      await checkTime.sleep(100);
      return false;
    },
  }, time => {
    checkTime = time;
  });
  assert.equal(checks, 1);
  assert.equal(unconfirmed.error.code, generic.error.code);
  assert.equal(unconfirmed.error.message, generic.error.message);
  assert.equal(unconfirmed.ms, generic.ms);
  assert.equal(unconfirmed.requests, generic.requests);
  // A check that fails confirms nothing either.
  const failedCheck = await failureOf({
    target: async () => ({ url: 'https://dl.example.org/x' }),
    unreadable: HELD_TEXT,
    confirmUnreadable: async () => {
      throw new Error('the check could not run');
    },
  });
  assert.equal(failedCheck.error.message, generic.error.message);
});

test('reads failing together share one check; an access naming an unreadable text must confirm it', async () => {
  const time = virtualTime();
  const { fetchImpl } = heldBackHost(time);
  let checks = 0;
  const source = httpByteSource({ url: DISPLAY, size: SIZE, name: 'a.h5ad' }, {
    fetch: fetchImpl,
    access: {
      target: async () => ({ url: 'https://dl.example.org/x' }),
      unreadable: HELD_TEXT,
      confirmUnreadable: async () => {
        checks += 1;
        await time.sleep(7500);
        return true;
      },
    },
  });
  const link = new LinkMeter(REMOTE_POLICY, { clock: time.now, after: time.after });
  const failures = await Promise.all([0, 100, 200].map(offset => source.read(offset, 10, { link }).catch(error => error)));
  assert.deepEqual(failures.map(error => error.code), ['unreadable', 'unreadable', 'unreadable']);
  assert.equal(checks, 1);
  assert.throws(
    () => httpByteSource({ url: DISPLAY, size: SIZE }, { access: { target: async () => ({ url: 'https://x.test/' }), unreadable: HELD_TEXT } }),
    /needs confirmUnreadable/
  );
});

test('a target past its expiresAt is replaced before a request is sent', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { calls, fetchImpl } = host();
  let issued = 0;
  const access = {
    target: async () => {
      issued += 1;
      return { url: `https://dl.example.org/${issued}`, expiresAt: Date.now() + 1000 };
    },
  };
  const source = httpByteSource({ url: DISPLAY, size: SIZE }, { fetch: fetchImpl, access });
  await source.read(0, 10);
  t.mock.timers.tick(999);
  await source.read(0, 10);
  t.mock.timers.tick(1);
  await source.read(0, 10);
  assert.deepEqual(calls.map(call => call.url), [
    'https://dl.example.org/1',
    'https://dl.example.org/1',
    'https://dl.example.org/2',
  ]);
});

test('a sign-out (generation change) drops the target held', async () => {
  const { calls, fetchImpl } = host();
  let issued = 0;
  const access = {
    generation: 0,
    target: async () => ({ url: `https://dl.example.org/${++issued}` }),
  };
  const source = httpByteSource({ url: DISPLAY, size: SIZE }, { fetch: fetchImpl, access });
  await source.read(0, 10);
  access.generation += 1;
  await source.read(0, 10);
  assert.deepEqual(calls.map(call => call.url), ['https://dl.example.org/1', 'https://dl.example.org/2']);
});

test('a redirect that states its lifetime is reused within it, then the original is asked again (no failed request)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 5_000_000 });
  const ORIGINAL = 'https://ndownloader.figshare.com/files/26098397';
  let signed = 0;
  const { calls, fetchImpl } = host(url => (url === ORIGINAL
    ? { status: 206, url: `https://s3.example.org/f?X-Amz-Expires=10&n=${++signed}` }
    : 206));
  const source = httpByteSource({ url: ORIGINAL, size: SIZE }, { fetch: fetchImpl });
  await source.read(0, 10);
  t.mock.timers.tick(9_000);
  await source.read(10, 10);
  t.mock.timers.tick(1_000);
  await source.read(20, 10);
  assert.deepEqual(calls.map(call => call.url), [
    ORIGINAL,
    'https://s3.example.org/f?X-Amz-Expires=10&n=1',
    ORIGINAL,
  ]);
  assert.equal(statedLifetimeMs('https://s3.example.org/f?X-Amz-Expires=10'), 10_000);
  assert.equal(statedLifetimeMs('https://cdn.example.org/f'), null);
});

test('a redirect that states no lifetime is reused until it fails once', async () => {
  const ORIGINAL = 'https://huggingface.co/datasets/a/b/resolve/c/x.h5ad';
  let failNext = false;
  const { calls, fetchImpl } = host(url => {
    if (url === ORIGINAL) return { status: 206, url: 'https://cdn.example.org/x' };
    if (failNext) {
      failNext = false;
      return 403;
    }
    return 206;
  });
  const source = httpByteSource({ url: ORIGINAL, size: SIZE }, { fetch: fetchImpl });
  await source.read(0, 10);
  await source.read(0, 10);
  failNext = true;
  await source.read(0, 10);
  assert.deepEqual(calls.map(call => call.url), [ORIGINAL, 'https://cdn.example.org/x', 'https://cdn.example.org/x', ORIGINAL]);
});

test('the page owns each access; a sign-out reaches every listener by ref', async () => {
  const descriptor = registerSourceAccess({
    provider: 'onedrive',
    stale: [403, 404],
    target: async ({ refresh }) => ({ url: `https://dl.example.org/${refresh ? 'fresh' : 'first'}` }),
  });
  assert.deepEqual(Object.keys(descriptor).sort(), ['provider', 'ref', 'stale', 'unreadable']);
  assert.equal(descriptor.unreadable, null);
  assert.throws(() => registerSourceAccess({ provider: 'gdrive', target: async () => ({ url: 'https://x.test/' }), unreadable: { text: ' ', confirm: async () => true } }),
    /unreadable text is a sentence/);
  assert.throws(() => registerSourceAccess({ provider: 'gdrive', target: async () => ({ url: 'https://x.test/' }), unreadable: { text: 'Held back.' } }),
    /confirms it/);
  // The provider's check: one at a time, shared; a failed one confirms nothing.
  let release;
  const answer = new Promise(resolve => { release = resolve; });
  let checks = 0;
  const held = registerSourceAccess({
    provider: 'held-host',
    target: async () => ({ url: 'https://x.test/' }),
    unreadable: {
      text: 'Held back.',
      confirm: () => {
        checks += 1;
        return answer;
      },
    },
  });
  assert.equal(held.unreadable, 'Held back.');
  const asked = [confirmSourceUnreadable(held.ref), confirmSourceUnreadable(held.ref)];
  release(true);
  assert.deepEqual(await Promise.all(asked), [true, true]);
  assert.equal(checks, 1);
  assert.equal(await confirmSourceUnreadable(descriptor.ref), false);
  assert.equal(await confirmSourceUnreadable('unknown'), false);
  const failing = registerSourceAccess({
    provider: 'held-host',
    target: async () => ({ url: 'https://x.test/' }),
    unreadable: { text: 'Held back.', confirm: async () => { throw new Error('no answer'); } },
  });
  assert.equal(await confirmSourceUnreadable(failing.ref), false);
  assert.ok(!JSON.stringify(descriptor).includes('dl.example.org'));
  assert.equal((await resolveSourceAccess(descriptor.ref)).url, 'https://dl.example.org/first');
  assert.equal((await resolveSourceAccess(descriptor.ref, { refresh: true })).url, 'https://dl.example.org/fresh');
  const heard = [];
  const stop = onSourceAccessRevoked(ref => heard.push(ref));
  revokeSourceAccess('gdrive');
  revokeSourceAccess('onedrive');
  stop();
  assert.deepEqual(heard, [descriptor.ref]);
  await assert.rejects(resolveSourceAccess('unknown'), /no longer held/);
});

test('the worker asks the page for targets and drops them on a revoke message', async () => {
  const posted = [];
  let asked;
  const asking = new Promise(resolve => { asked = resolve; });
  const handle = createAnnDataReaderHandler({
    post: message => {
      posted.push(message);
      if (message.event === 'source-access') asked(message);
    },
  });
  // An open of a remote file that names an access: the worker asks for its
  // target (the test waits for that message, not for a while).
  const opening = handle({
    id: 1,
    method: 'open',
    args: [{ source: { file: { url: DISPLAY, size: SIZE, name: 'a.h5ad', access: { provider: 'onedrive', ref: 'r1', stale: [403] } } } }],
  });
  const ask = await asking;
  assert.deepEqual({ ...ask, request: typeof ask.request }, {
    event: 'source-access', request: 'number', provider: 'onedrive', ref: 'r1', refresh: false,
  });
  // The page refuses: the open fails with the page's reason, never a target.
  assert.equal(await handle({ sourceAccess: ask.request, error: { name: 'Error', message: 'Sign in to OneDrive.', code: 'SIGN_IN' } }), null);
  const reply = await opening;
  assert.match(reply.reply.error.message, /Sign in to OneDrive/);
  assert.equal(await handle({ sourceAccessRevoked: 'r1' }), null);
});

test('the worker asks the page whether a read that got no answer is unreadable, by ref', async () => {
  const posted = [];
  let asked;
  const asking = new Promise(resolve => { asked = resolve; });
  const handle = createAnnDataReaderHandler({
    post: message => {
      posted.push(message);
      if (message.event === 'source-access') {
        // The page's target: a host that never answers this page.
        void handle({ sourceAccess: message.request, target: { url: 'https://dl.example.org/x' } });
      }
      if (message.event === 'source-unreadable') asked(message);
    },
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  try {
    const opening = handle({
      id: 1,
      method: 'open',
      args: [{ source: { file: { url: DISPLAY, size: SIZE, name: 'a.h5ad', access: { provider: 'gdrive', ref: 'r2', stale: [], unreadable: HELD_TEXT } } } }],
    });
    const ask = await asking;
    assert.deepEqual({ ...ask, request: typeof ask.request }, {
      event: 'source-unreadable', request: 'number', provider: 'gdrive', ref: 'r2',
    });
    assert.equal(await handle({ sourceUnreadable: ask.request, unreadable: true }), null);
    const reply = await opening;
    assert.match(reply.reply.error.message, /holds back downloads without a sign-in/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a reader client answers the worker from the provider\'s check: an unanswered open fails in the provider\'s words', async t => {
  await import('./helpers/anndata-reader-in-process.mjs');
  const { AnnDataReaderClient } = await import('../assets/js/data/anndata-reader-client.js');
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  let checks = 0;
  const access = registerSourceAccess({
    provider: 'held-host',
    target: async () => ({ url: `https://dl.example.org/x?key=${SECRET}` }),
    unreadable: {
      text: HELD_TEXT,
      confirm: async () => {
        checks += 1;
        return true;
      },
    },
  });
  const client = new AnnDataReaderClient();
  t.after(() => client.close());
  await assert.rejects(client.open({ file: { url: DISPLAY, size: SIZE, name: 'a.h5ad', access } }), error => {
    assert.match(error.message, /holds back downloads without a sign-in/);
    assert.ok(!error.message.includes(SECRET));
    return true;
  });
  assert.equal(checks, 1);
});

test('a preflighted target with a lane: each request in flight its own stable URL under the HTTP cache, a lane freed when its request ends', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), cache: init.cache });
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const response = new Response(new Uint8Array(Number(end) - Number(start) + 1), { status: 206 });
    Object.defineProperty(response, 'url', { value: String(url) });
    return response;
  };
  const base = 'https://www.googleapis.com/drive/v3/files/F?alt=media&supportsAllDrives=true';
  const source = httpByteSource({ url: base, size: SIZE }, {
    fetch: fetchImpl,
    access: { target: async () => ({ url: base, headers: { Authorization: `Bearer ${SECRET}` }, lane: 'lane' }) },
  });
  await Promise.all([0, 1, 2].map(index => source.read(index * 1000, 10)));
  assert.deepEqual(calls.map(call => call.url).sort(), [0, 1, 2].map(lane => `${base}&lane=${lane}`));
  assert.ok(calls.every(call => call.cache === 'default'), 'a lane URL keeps its preflight: the HTTP cache mode');
  // One at a time: lane 0 every time, its preflight asked for once.
  calls.length = 0;
  for (const index of [3, 4, 5]) await source.read(index * 1000, 10);
  assert.deepEqual(calls.map(call => call.url), [0, 0, 0].map(lane => `${base}&lane=${lane}`));
  // A lane is a query parameter's name, nothing else.
  const bad = httpByteSource({ url: base, size: SIZE }, {
    fetch: fetchImpl,
    access: { target: async () => ({ url: base, headers: { Authorization: 'Bearer x' }, lane: 'a&b=' }) },
  });
  await assert.rejects(bad.read(0, 10), /lane is the name of a query parameter/);
  // Without a header beyond Range nothing is preflighted: one URL, past the HTTP cache.
  calls.length = 0;
  const plain = httpByteSource({ url: base, size: SIZE }, {
    fetch: fetchImpl,
    access: { target: async () => ({ url: base, lane: 'lane' }) },
  });
  await Promise.all([0, 1].map(index => plain.read(index * 1000, 10)));
  assert.deepEqual(calls, [{ url: base, cache: 'no-store' }, { url: base, cache: 'no-store' }]);
});
