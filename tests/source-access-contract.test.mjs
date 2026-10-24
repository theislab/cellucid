import assert from 'node:assert/strict';
import test from 'node:test';

import { httpByteSource, statedLifetimeMs } from '../assets/js/formats/io/byte-source.js';
import { createAnnDataReaderHandler } from '../assets/js/data/anndata-reader-worker.js';
import {
  onSourceAccessRevoked,
  registerSourceAccess,
  resolveSourceAccess,
  revokeSourceAccess,
} from '../assets/js/data/sources/access.js';

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
  const realTimeout = globalThis.setTimeout;
  // The repeats after a network failure wait; skip the waits.
  globalThis.setTimeout = (fn, ms, ...rest) => realTimeout(fn, ms > 100 && ms < 10_000 ? 0 : ms, ...rest);
  try {
    await assert.rejects(source.read(0, 10), error => {
      assert.ok(error.message.includes(DISPLAY));
      assert.ok(!JSON.stringify({ m: error.message, d: error.details }).includes(SECRET));
      return true;
    });
  } finally {
    globalThis.setTimeout = realTimeout;
  }
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
  assert.deepEqual(Object.keys(descriptor).sort(), ['provider', 'ref', 'stale']);
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
  const handle = createAnnDataReaderHandler({ post: message => posted.push(message) });
  // An open of a remote file that names an access: the worker asks for its target.
  const opening = handle({
    id: 1,
    method: 'open',
    args: [{ kind: 'h5ad', source: { url: DISPLAY, size: SIZE, name: 'a.h5ad', access: { provider: 'onedrive', ref: 'r1', stale: [403] } } }],
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  const ask = posted.find(message => message.event === 'source-access');
  assert.deepEqual({ ...ask, request: typeof ask.request }, {
    event: 'source-access', request: 'number', provider: 'onedrive', ref: 'r1', refresh: false,
  });
  // The page refuses: the open fails with the page's reason, never a target.
  assert.equal(await handle({ sourceAccess: ask.request, error: { name: 'Error', message: 'Sign in to OneDrive.', code: 'SIGN_IN' } }), null);
  const reply = await opening;
  assert.match(reply.reply.error.message, /Sign in to OneDrive/);
  assert.equal(await handle({ sourceAccessRevoked: 'r1' }), null);
});
