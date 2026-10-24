/**
 * Every request to a web host either completes, is made again, or fails
 * naming its URL; none is left hanging. The failures a static host really
 * produces are injected into a fake `fetch`: a 503 sent without CORS headers
 * (which a page sees only as a failed connection), a 429 with `Retry-After`,
 * a request that is never answered, a connection dropped mid-body, and a body
 * that stops arriving. Cancellation still ends a request at once, and the
 * bytes a range read planned are counted once whatever happened on the way.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BYTE_SOURCE_FAILURES,
  ByteSourceError,
  REMOTE_POLICY,
  fetchOnce,
  httpByteSource,
  withRetries,
  worthAskingAgain,
} from '../assets/js/formats/io/byte-source.js';
import { LinkMeter, ResponseClock } from '../assets/js/formats/io/link.js';
import { ReadActivity } from '../assets/js/formats/io/activity.js';
import { httpStore, openZarr } from '../assets/js/formats/zarr/index.js';
import { fetchWhenNotBusy } from '../assets/js/data/data-source.js';

const BASE = 'https://host.test/store.zarr/';

/** A consolidated Zarr v2 store with one int32 array `a` of four values. */
function storeFiles() {
  const zarray = { zarr_format: 2, shape: [4], chunks: [4], dtype: '<i4', compressor: null, fill_value: 0, filters: null, order: 'C' };
  const metadata = {
    zarr_consolidated_format: 1,
    metadata: { '.zgroup': { zarr_format: 2 }, 'a/.zarray': zarray, 'a/.zattrs': {} },
  };
  const text = value => new TextEncoder().encode(JSON.stringify(value));
  return new Map([
    ['.zmetadata', text(metadata)],
    ['.zgroup', text({ zarr_format: 2 })],
    ['a/.zarray', text(zarray)],
    ['a/0', new Uint8Array(Int32Array.of(1, 2, 3, 4).buffer)],
  ]);
}

/** A body that sends `bytes`, then fails as a dropped connection. */
function droppingBody(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 1));
      controller.error(new TypeError('network connection was lost'));
    },
  });
}

/** A body that sends its first byte, then nothing more until aborted. */
function stallingBody(bytes, signal) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 1));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
}

/** An answer that never comes, until the request is aborted. */
function never(signal) {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/**
 * A static host serving `files`, failing the first requests of a key as
 * `faults` says: `{key: [kind, ...]}`, one kind per request.
 */
function faultyHost(files, faults = {}) {
  const log = [];
  const left = new Map(Object.entries(faults).map(([key, kinds]) => [key, [...kinds]]));
  const fetch = async (url, init = {}) => {
    const key = decodeURIComponent(new URL(url).pathname.replace('/store.zarr/', ''));
    const kind = left.get(key)?.shift() ?? null;
    log.push({ key, kind, init });
    const bytes = files.get(key);
    switch (kind) {
      case 'cors-503': throw new TypeError('Load failed (access control checks)');
      case '429': return new Response('slow down', { status: 429, headers: { 'Retry-After': '1' } });
      case '503': return new Response('busy', { status: 503, headers: { 'Retry-After': '0' } });
      case 'hang': return never(init.signal);
      case 'drop': return new Response(droppingBody(bytes), { status: 200 });
      case 'stall-body': return new Response(stallingBody(bytes, init.signal), { status: 200 });
      default: break;
    }
    if (bytes === undefined) return new Response('not found', { status: 404 });
    return new Response(bytes.slice(), { status: 200 });
  };
  return { fetch, log };
}

test('a consolidated Zarr v2 store on a web host opens with one request, and nothing answers 404', async () => {
  const host = faultyHost(storeFiles());
  const root = await openZarr(httpStore(BASE, { fetch: host.fetch }));
  assert.deepEqual(host.log.map(entry => entry.key), ['.zmetadata']);
  assert.deepEqual([...await root.get('a').read()], [1, 2, 3, 4]);
});

test('store requests go past the HTTP cache (WebKit never delivered cached bodies to the reader worker)', async () => {
  const host = faultyHost(storeFiles());
  const root = await openZarr(httpStore(BASE, { fetch: host.fetch }));
  await root.get('a').read();
  assert.ok(host.log.every(entry => entry.init.cache === 'no-store'));
});

test('a 503 without CORS headers, a 429 with Retry-After, a hung answer, a dropped connection and a stalled body are each asked again', async () => {
  const host = faultyHost(storeFiles(), {
    '.zmetadata': ['cors-503', '429'],
    'a/0': ['hang', 'drop', 'stall-body'],
  });
  const started = performance.now();
  const root = await openZarr(httpStore(BASE, { fetch: host.fetch }));
  const opened = performance.now();
  assert.ok(opened - started >= 1000, 'the 429 is waited out as long as its Retry-After asks');
  assert.deepEqual([...await root.get('a').read()], [1, 2, 3, 4]);
  assert.deepEqual(host.log.map(entry => entry.kind), ['cors-503', '429', null, 'hang', 'drop', 'stall-body', null]);
});

test('a request is not stalled while the link delivers bytes to other requests', async () => {
  const clock = new ResponseClock();
  const slow = new Uint8Array(8);
  const fetch = async (url, init) => {
    if (url.endsWith('/waits')) {
      // Answered only after the other request's body has trickled for 2.4 s.
      await new Promise(resolve => setTimeout(resolve, 2500));
      return new Response(Uint8Array.of(7), { status: 200 });
    }
    let sent = 0;
    return new Response(new ReadableStream({
      async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 300));
        if (sent === slow.length) controller.close();
        else controller.enqueue(slow.subarray(sent, ++sent));
      },
    }), { status: 200 });
  };
  const [waits, trickles] = await Promise.all([
    fetchOnce('https://host.test/waits', {}, { fetchImpl: fetch, clock }),
    fetchOnce('https://host.test/trickles', {}, { fetchImpl: fetch, clock }),
  ]);
  assert.deepEqual([...waits.bytes], [7]);
  assert.equal(trickles.bytes.length, slow.length);
});

test('the stall timeout follows the measured answers (RFC 6298), doubles on a stall and is computed afresh after an answer', () => {
  let now = 0;
  const clock = new ResponseClock({ clock: () => now });
  assert.equal(clock.timeoutMs, 1000, 'one second until the first answer');
  clock.answered(100);
  assert.equal(clock.timeoutMs, 1000, 'never under one second');
  clock.answered(4000);
  // SRTT = 0.875 * 100 + 0.125 * 4000 = 587.5; RTTVAR = 0.75 * 50 + 0.25 * 3900 = 1012.5
  assert.equal(clock.timeoutMs, 587.5 + 4 * 1012.5);
  const before = clock.timeoutMs;
  clock.stalled();
  assert.equal(clock.timeoutMs, 2 * before);
  clock.answered(587.5);
  assert.ok(clock.timeoutMs < 2 * before);
  now = 42;
  clock.received();
  assert.equal(clock.lastActivityAt, 42);
});

test('a host that keeps failing is reported naming the URL and how many times it was asked', async () => {
  const host = faultyHost(storeFiles(), { '.zmetadata': Array(10).fill('503') });
  await assert.rejects(openZarr(httpStore(BASE, { fetch: host.fetch })), error => {
    assert.equal(error.code, BYTE_SOURCE_FAILURES.UNAVAILABLE);
    assert.match(error.message, /https:\/\/host\.test\/store\.zarr\/\.zmetadata: the host could not answer \(HTTP 503\)\. Asked 7 times\./);
    return true;
  });
  assert.equal(host.log.length, 7);
});

test('cancelling ends a hung request and a wait to ask again at once, and nothing is asked after', async () => {
  const host = faultyHost(storeFiles(), { '.zmetadata': ['hang'] });
  const controller = new AbortController();
  const opening = openZarr(httpStore(BASE, { fetch: host.fetch }), { signal: controller.signal });
  setTimeout(() => controller.abort(new DOMException('stop', 'AbortError')), 50);
  await assert.rejects(opening, { name: 'AbortError' });
  assert.equal(host.log.length, 1);

  const waiting = new AbortController();
  const asked = [];
  const retrying = withRetries(async attempt => {
    asked.push(attempt);
    throw new ByteSourceError(BYTE_SOURCE_FAILURES.RATE_LIMITED, 'busy', { retryAfter: '60' });
  }, { signal: waiting.signal });
  setTimeout(() => waiting.abort(new DOMException('stop', 'AbortError')), 50);
  const started = performance.now();
  await assert.rejects(retrying, { name: 'AbortError' });
  assert.ok(performance.now() - started < 1000, 'the 60 s wait ends with the cancel');
  assert.deepEqual(asked, [0]);
});

test('bytes a range read planned are counted once, however often its request was made', async () => {
  const files = new Map([['shard', new Uint8Array(64).map((_, i) => i)]]);
  let attempts = 0;
  const fetch = async (url, init) => {
    attempts++;
    if (attempts === 1) return never(init.signal);
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    return new Response(files.get('shard').slice(Number(a), Number(b) + 1), { status: 206 });
  };
  const store = httpStore('https://host.test/s/', { fetch });
  const activity = new ReadActivity({ label: 'shard', kind: 'field' });
  const [bytes] = await store.getRanges('shard', [{ offset: 8, length: 16 }], { activity });
  assert.deepEqual([...bytes], Array.from({ length: 16 }, (_, i) => i + 8));
  assert.equal(attempts, 2);
  assert.equal(activity.bytesPlanned, 16);
  assert.equal(activity.bytesFetched, 16);
});

test('a range read of a file is asked again after a stall, measured on its link', async () => {
  const bytes = new Uint8Array(100).map((_, i) => i);
  let attempts = 0;
  const fetch = async (url, init) => {
    attempts++;
    if (attempts === 1) return never(init.signal);
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    return new Response(bytes.slice(Number(a), Number(b) + 1), { status: 206 });
  };
  const source = httpByteSource({ url: 'https://host.test/a.h5ad', size: 100 }, { fetch });
  const link = new LinkMeter(REMOTE_POLICY);
  const retried = [];
  link.responses.onRetry = (error, count) => retried.push([error.code, count]);
  assert.deepEqual([...await source.read(10, 5, { link })], [10, 11, 12, 13, 14]);
  assert.deepEqual(retried, [[BYTE_SOURCE_FAILURES.STALLED, 1]]);
});

test('catalog and provider requests ride out a 503 without CORS headers', async t => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError('Load failed (access control checks)');
    return new Response('{"schema":2}', { status: 200 });
  };
  const response = await fetchWhenNotBusy('https://owner.github.io/repo/datasets.json');
  assert.deepEqual(await response.json(), { schema: 2 });
  assert.equal(calls, 2);
});

test('a range asked for is given the time its bytes take at the measured bandwidth before it is stalled', () => {
  let bandwidth = 0;
  const clock = new ResponseClock({ bandwidth: () => bandwidth });
  assert.equal(clock.patienceMs(8_000_000), 1000, 'nothing added before the bandwidth is measured');
  bandwidth = 5000;
  assert.equal(clock.patienceMs(8_000_000), 1000 + 1600);
  assert.equal(clock.patienceMs(0), 1000, 'a whole object of unknown size gets the timeout alone');
});

test('a long request counts its bytes into the read\'s activity as they arrive, and a failed attempt takes them back', async () => {
  const { createByteReader } = await import('../assets/js/formats/io/byte-reader.js');
  const bytes = new Uint8Array(30_000).map((_, i) => i & 0xff);
  let attempts = 0;
  let seenMidway = null;
  const activity = new ReadActivity({ label: 'slow', kind: 'field' });
  const fetch = async (url, init) => {
    attempts++;
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const body = bytes.slice(Number(a), Number(b) + 1);
    const pieces = [body.subarray(0, 10_000), body.subarray(10_000, 20_000), body.subarray(20_000)];
    const first = attempts === 1;
    return new Response(new ReadableStream({
      async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 20));
        if (first && pieces.length === 2) {
          controller.error(new TypeError('network connection was lost'));
          return;
        }
        if (!first && pieces.length === 1) seenMidway = activity.bytesFetched;
        const next = pieces.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(next);
      },
    }), { status: 206 });
  };
  const source = httpByteSource({ url: 'https://host.test/a.h5ad', size: bytes.length }, { fetch });
  const reader = createByteReader(source);
  const read = await reader.read(0, bytes.length, { activity });
  assert.equal(read.length, bytes.length);
  assert.equal(attempts, 2, 'the dropped attempt was asked again');
  assert.equal(seenMidway, 20_000, 'two pieces counted before the request completed');
  assert.equal(activity.bytesFetched, bytes.length, 'the dropped attempt\'s bytes were taken back');
  assert.equal(activity.requests, 1);
});

test('a failure that repeats exactly, or a host that never answers this site, is reported at once', async t => {
  // The same 500, the same length, every time (a record that does not exist):
  // asked a second time, then reported.
  const failing = faultyHost(storeFiles(), { '.zmetadata': Array(10).fill('500') });
  const fetch500 = async (url, init) => {
    const key = decodeURIComponent(new URL(url).pathname.replace('/store.zarr/', ''));
    failing.log.push({ key });
    return new Response('{"status":500}', { status: 500, headers: { 'Content-Length': '14' } });
  };
  const started = performance.now();
  await assert.rejects(openZarr(httpStore(BASE, { fetch: fetch500 })), error => {
    assert.match(error.message, /HTTP 500\)\. Asked 2 times\./);
    return true;
  });
  assert.equal(failing.log.length, 2);
  assert.ok(performance.now() - started < 2000, 'reported after one short wait');

  // No answer at all (CORS refused): asked once more, then reported.
  let corsAsked = 0;
  const fetchCors = async () => {
    corsAsked++;
    throw new TypeError('Load failed (access control checks)');
  };
  await assert.rejects(openZarr(httpStore(BASE, { fetch: fetchCors })), /Asked 2 times\./);
  assert.equal(corsAsked, 2);

  // Through the catalog and provider path, the repeated answer is returned as it is.
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let apiAsked = 0;
  globalThis.fetch = async () => {
    apiAsked++;
    return new Response('{"status":500}', { status: 500, headers: { 'Content-Length': '14' } });
  };
  const response = await fetchWhenNotBusy('https://zenodo.org/api/records/1');
  assert.equal(response.status, 500);
  assert.equal(apiAsked, 2);
});

test('the signs of a host that will answer later are asked again for the whole schedule', () => {
  const failure = (code, details = {}) => new ByteSourceError(code, 'x', details);
  const busyNamed = failure(BYTE_SOURCE_FAILURES.UNAVAILABLE, { status: 503, retryAfter: '0', signature: '503:4' });
  assert.equal(worthAskingAgain(busyNamed, [busyNamed, busyNamed]), true, 'a Retry-After is the host saying when');
  const dropped = failure(BYTE_SOURCE_FAILURES.NETWORK, { phase: 'body' });
  assert.equal(worthAskingAgain(dropped, [dropped, dropped]), true, 'a connection dropped mid-body');
  const stalled = failure(BYTE_SOURCE_FAILURES.STALLED);
  assert.equal(worthAskingAgain(stalled, [stalled, stalled]), true, 'a stall');
  const unanswered = failure(BYTE_SOURCE_FAILURES.NETWORK, { phase: 'answer' });
  assert.equal(worthAskingAgain(unanswered, []), true, 'no answer: asked once more');
  assert.equal(worthAskingAgain(unanswered, [unanswered]), false, 'then reported');
  const first500 = failure(BYTE_SOURCE_FAILURES.UNAVAILABLE, { status: 500, retryAfter: null, signature: '500:14' });
  const other500 = failure(BYTE_SOURCE_FAILURES.UNAVAILABLE, { status: 500, retryAfter: null, signature: '500:90' });
  assert.equal(worthAskingAgain(other500, [first500]), true, 'a different answer may change again');
  assert.equal(worthAskingAgain(first500, [first500]), false, 'the same answer twice is reported');
});
