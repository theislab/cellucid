/**
 * The byte layer under every format reader: sources serve exact ranges, and
 * the reader batches, coalesces, splits, parallelises, caches and cancels.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BYTE_SOURCE_FAILURES,
  ByteSourceError,
  blobByteSource,
  bytesByteSource,
  httpByteSource,
  probeHttpResource,
} from '../assets/js/formats/io/byte-source.js';
import { createByteReader, planMergeGap } from '../assets/js/formats/io/byte-reader.js';
import { InflateError, inflate } from '../assets/js/formats/io/inflate.js';

function pattern(size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
  return bytes;
}

/** A memory source that records every read and can hold them open. */
function recordingSource(bytes, policy = {}) {
  const base = bytesByteSource(bytes, { name: 'recorded', policy });
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let gate = null;
  const source = {
    ...base,
    calls,
    get maxInFlight() { return maxInFlight; },
    hold() {
      let release;
      gate = new Promise(resolve => { release = resolve; });
      return () => { gate = null; release(); };
    },
    async read(offset, length, options = {}) {
      calls.push([offset, length]);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (gate) await gate;
        if (options.signal?.aborted) throw options.signal.reason;
        return await base.read(offset, length, options);
      } finally {
        inFlight--;
      }
    },
  };
  return source;
}

const POLICY = { blockBytes: 1024, mergeGapBytes: 256, maxRequestBytes: 4096, concurrency: 2, cacheBytes: 8192 };

test('reads asked for together are planned together and coalesced', async () => {
  const bytes = pattern(100_000);
  const source = recordingSource(bytes, POLICY);
  const reader = createByteReader(source);
  const results = await Promise.all([
    reader.read(100, 50),
    reader.read(200, 50),   // 50 bytes after the first: merged
    reader.read(5000, 10),  // far away: its own request
  ]);
  assert.deepEqual(results[0], bytes.subarray(100, 150));
  assert.deepEqual(results[1], bytes.subarray(200, 250));
  assert.deepEqual(results[2], bytes.subarray(5000, 5010));
  assert.deepEqual(source.calls, [[100, 150], [5000, 10]]);
});

test('reads from promise continuations of one task land in one plan', async () => {
  const bytes = pattern(100_000);
  const source = recordingSource(bytes, POLICY);
  const reader = createByteReader(source);
  const later = Promise.resolve().then(() => Promise.resolve()).then(() => reader.read(300, 10));
  const first = reader.read(250, 10);
  await Promise.all([first, later]);
  assert.deepEqual(source.calls, [[250, 60]]);
});

test('a long read is split into pieces that run in parallel, never past the concurrency', async () => {
  const bytes = pattern(100_000);
  const source = recordingSource(bytes, POLICY);
  const reader = createByteReader(source);
  const result = await reader.read(10, 20_000);
  assert.deepEqual(result, bytes.subarray(10, 20_010));
  // Planned before anything was measured: pieces of the prior's size. The
  // first two run at once; the link measured by then may join the waiting
  // pieces into requests of its own size.
  assert.deepEqual(source.calls.slice(0, 2), [[10, 4096], [4106, 4096]]);
  assert.ok(source.calls.length <= Math.ceil(20_000 / 4096));
  assert.ok(source.calls.every(([, length]) => length <= reader.link.maxRequestBytes));
  // Never more in flight than the link's concurrency (the prior's two, or
  // more where the measured link showed more paid: this source is no
  // HTTP/1.1 host).
  assert.ok(source.maxInFlight >= 2 && source.maxInFlight <= reader.link.concurrency);
});

test('cached reads fetch aligned blocks once and serve neighbours from the cache', async () => {
  const bytes = pattern(100_000);
  const source = recordingSource(bytes, POLICY);
  const reader = createByteReader(source);
  assert.deepEqual(await reader.read(1030, 8, { cache: true }), bytes.subarray(1030, 1038));
  assert.deepEqual(await reader.read(1500, 100, { cache: true }), bytes.subarray(1500, 1600));
  assert.deepEqual(await reader.read(2040, 20, { cache: true }), bytes.subarray(2040, 2060));
  assert.deepEqual(source.calls, [[1024, 1024], [2048, 1024]]);
  assert.ok(reader.stats().cacheHits >= 2);
});

test('the block cache keeps to its budget', async () => {
  const bytes = pattern(100_000);
  const source = recordingSource(bytes, POLICY);
  const reader = createByteReader(source);
  for (let block = 0; block < 20; block++) await reader.read(block * 1024, 1, { cache: true });
  await reader.read(0, 1, { cache: true });
  assert.equal(source.calls.length, 21, 'the first block was evicted and fetched again');
});

test('an aborted read rejects at once and its request is cancelled', async () => {
  const bytes = pattern(100_000);
  const source = recordingSource(bytes, POLICY);
  const reader = createByteReader(source);
  const release = source.hold();
  const controller = new AbortController();
  const pending = reader.read(0, 100, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  release();
  // The reader keeps working afterwards.
  assert.deepEqual(await reader.read(0, 4), bytes.subarray(0, 4));
});

test('a block whose request was cancelled is fetched again for the next reader', async () => {
  const bytes = pattern(100_000);
  const source = recordingSource(bytes, POLICY);
  const reader = createByteReader(source);
  const release = source.hold();
  const controller = new AbortController();
  const pending = reader.read(0, 10, { signal: controller.signal, cache: true });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  release();
  assert.deepEqual(await reader.read(5, 10, { cache: true }), bytes.subarray(5, 15));
});

test('a failed request rejects every read that waits on it', async () => {
  const source = {
    ...bytesByteSource(pattern(1000), { policy: POLICY }),
    async read() { throw new ByteSourceError(BYTE_SOURCE_FAILURES.HTTP, 'boom'); },
  };
  const reader = createByteReader(source);
  const results = await Promise.allSettled([reader.read(0, 10), reader.read(20, 10), reader.read(0, 5, { cache: true })]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'http'));
});

test('reads outside the file are refused', async () => {
  const reader = createByteReader(bytesByteSource(pattern(10)));
  await assert.rejects(reader.read(5, 6), RangeError);
});

test('blob sources read slices without copying the file', async () => {
  const bytes = pattern(10_000);
  const source = blobByteSource(new Blob([bytes]), { name: 'local.h5ad' });
  assert.equal(source.size, 10_000);
  assert.deepEqual(await source.read(123, 456), bytes.subarray(123, 579));
});

/** A fetch stand-in serving `bytes` with HTTP semantics chosen per test. */
function fakeHost(bytes, behave = () => null) {
  const requests = [];
  const fetch = async (url, { headers, signal }) => {
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(headers.Range);
    requests.push({ url, start: Number(start), end: Number(end) });
    const override = behave({ url, start: Number(start), end: Number(end), count: requests.length });
    if (override) return override;
    if (signal?.aborted) throw signal.reason;
    return new Response(bytes.slice(Number(start), Number(end) + 1), { status: 206 });
  };
  return { fetch, requests };
}

test('http sources read ranges and refuse hosts that ignore them', async () => {
  const bytes = pattern(5000);
  const ok = fakeHost(bytes);
  const source = httpByteSource({ url: 'https://example.org/a.h5ad', size: 5000 }, { fetch: ok.fetch });
  assert.deepEqual(await source.read(10, 20), bytes.subarray(10, 30));

  const ignoring = fakeHost(bytes, () => new Response(bytes, { status: 200 }));
  const refused = httpByteSource({ url: 'https://example.org/a.h5ad', size: 5000 }, { fetch: ignoring.fetch });
  await assert.rejects(refused.read(10, 20), { code: BYTE_SOURCE_FAILURES.RANGE_IGNORED });
  // A whole-file read may be answered with 200.
  assert.deepEqual(await refused.read(0, 5000), bytes);
});

test('http sources are named and identified by their URL, and refuse what they cannot read', async () => {
  const bytes = pattern(100);
  const source = httpByteSource({ url: 'https://example.org/data/file.h5ad', size: 100 }, { fetch: fakeHost(bytes).fetch });
  assert.equal(source.name, 'file.h5ad');
  assert.deepEqual(source.identity, { kind: 'url', url: 'https://example.org/data/file.h5ad', size: 100 });
  assert.throws(() => httpByteSource({ url: 'ftp://example.org/x', size: 1 }), /http\(s\) URLs only/);
  assert.throws(() => httpByteSource({ url: 'https://example.org/x' }), /exact size/);
  // A host that keeps refusing for load is named as such once the retries are spent.
  const busy = fakeHost(bytes, () => new Response('', { status: 429, headers: { 'Retry-After': '0' } }));
  const limited = httpByteSource({ url: 'https://example.org/a', size: 100 }, { fetch: busy.fetch });
  await assert.rejects(limited.read(0, 4), { code: BYTE_SOURCE_FAILURES.RATE_LIMITED });
});

test('http sources wait as the host asks when it is busy, then read', async () => {
  const bytes = pattern(100);
  const host = fakeHost(bytes, ({ count }) => (count === 1
    ? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
    : null));
  const source = httpByteSource({ url: 'https://example.org/a', size: 100 }, { fetch: host.fetch });
  assert.deepEqual(await source.read(0, 10), bytes.subarray(0, 10));
  assert.equal(host.requests.length, 2);
});

test('http sources refuse a file that changed while it was open', async () => {
  const bytes = pattern(100);
  const host = fakeHost(bytes, ({ start, end, count }) => new Response(bytes.slice(start, end + 1), {
    status: 206,
    headers: { ETag: count === 1 ? '"one"' : '"two"' },
  }));
  const source = httpByteSource({ url: 'https://example.org/a', size: 100 }, { fetch: host.fetch });
  await source.read(0, 10);
  await assert.rejects(source.read(10, 10), { code: BYTE_SOURCE_FAILURES.CHANGED });
});

test('http sources refuse a short answer', async () => {
  const bytes = pattern(100);
  const host = fakeHost(bytes, () => new Response(bytes.slice(0, 3), { status: 206 }));
  const source = httpByteSource({ url: 'https://example.org/a', size: 100 }, { fetch: host.fetch });
  await assert.rejects(source.read(0, 10), { code: BYTE_SOURCE_FAILURES.SHORT_READ });
});

test('inflate decompresses zlib, gzip and raw DEFLATE, exactly to the declared size', async () => {
  const plain = new TextEncoder().encode('cellucid '.repeat(500));
  for (const format of ['deflate', 'gzip', 'deflate-raw']) {
    const compressed = new Uint8Array(await new Response(
      new Blob([plain]).stream().pipeThrough(new CompressionStream(format))
    ).arrayBuffer());
    assert.deepEqual(await inflate(compressed, { format }), plain);
    assert.deepEqual(await inflate(compressed, { format, expectedSize: plain.length }), plain);
    await assert.rejects(inflate(compressed, { format, expectedSize: plain.length - 1 }), InflateError);
    await assert.rejects(inflate(compressed, { format, expectedSize: plain.length + 1 }), InflateError);
  }
  await assert.rejects(inflate(Uint8Array.of(1, 2, 3, 4)), InflateError);
  const compressed = new Uint8Array(await new Response(
    new Blob([plain]).stream().pipeThrough(new CompressionStream('gzip'))
  ).arrayBuffer());
  assert.deepEqual(await inflate(compressed, { format: 'gzip', maxSize: plain.length }), plain);
  await assert.rejects(inflate(compressed, { format: 'gzip', maxSize: plain.length - 1 }), InflateError);
});

test('activities count the requests they caused, once each, and the cache hits they got', async () => {
  const { ReadActivity } = await import('../assets/js/formats/io/activity.js');
  const bytes = pattern(100_000);
  const source = recordingSource(bytes, POLICY);
  const reader = createByteReader(source);
  const first = new ReadActivity({ label: 'first', kind: 'field' });
  const second = new ReadActivity({ label: 'second', kind: 'field' });
  await Promise.all([
    reader.read(0, 100, { activity: first }),
    reader.read(150, 10, { activity: second }), // merged into the first's request
    reader.read(9000, 10, { activity: second }),
  ]);
  await reader.read(1030, 4, { cache: true, activity: second });
  await reader.read(1040, 4, { cache: true, activity: second });
  assert.equal(first.requests, 1);
  assert.equal(first.bytesFetched, 160);
  assert.equal(second.requests, 2);
  assert.equal(second.bytesFetched, 10 + 1024);
  assert.equal(second.cacheHits, 1);
  first.finish();
  assert.equal(first.snapshot().status, 'done');
  second.finish(new DOMException('stop', 'AbortError'));
  assert.equal(second.snapshot().status, 'cancelled');
});

test('http sources send one single-range header and nothing else (no CORS preflight), past the HTTP cache', async () => {
  const bytes = pattern(100);
  const seen = [];
  const fetch = async (url, init) => {
    seen.push(init);
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    return new Response(bytes.slice(Number(start), Number(end) + 1), { status: 206 });
  };
  const source = httpByteSource({ url: 'https://example.org/a', size: 100 }, { fetch });
  await source.read(5, 10);
  assert.deepEqual(Object.keys(seen[0].headers), ['Range']);
  assert.equal(seen[0].headers.Range, 'bytes=5-14');
  assert.equal(seen[0].method, undefined, 'a plain GET');
  // Chromium lets one request of a URL through its HTTP cache at a time:
  // ranges of one file asked for together would go out one after another.
  assert.equal(seen[0].cache, 'no-store');
});

test('http sources reuse the final URL after a redirect and ask the original again once it fails', async () => {
  const bytes = pattern(100);
  const asked = [];
  let signedExpired = false;
  const fetch = async (url, init) => {
    asked.push(url);
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    if (url === 'https://cdn.example.org/signed' && signedExpired) return new Response('', { status: 403 });
    const response = new Response(bytes.slice(Number(start), Number(end) + 1), { status: 206 });
    Object.defineProperty(response, 'url', { value: 'https://cdn.example.org/signed' });
    return response;
  };
  const source = httpByteSource({ url: 'https://example.org/a', size: 100 }, { fetch });
  await source.read(0, 4);
  await source.read(4, 4);
  signedExpired = true;
  assert.deepEqual(await source.read(8, 4), bytes.subarray(8, 12));
  assert.deepEqual(asked, [
    'https://example.org/a',
    'https://cdn.example.org/signed',
    'https://cdn.example.org/signed',
    'https://example.org/a',
  ]);
});

test('probeHttpResource takes the size from a ranged HEAD, else from a one-byte range', async () => {
  const headers = values => ({ get: name => values[name] ?? null });
  // A host that answers the ranged HEAD: one request, the stored size.
  const oneRequest = [];
  const ranged = async (url, init = {}) => {
    oneRequest.push([init.method ?? 'GET', init.headers?.Range ?? null]);
    return { ok: true, status: 206, url, headers: headers({ 'Content-Length': '45360', ETag: '"abc"' }) };
  };
  assert.deepEqual(await probeHttpResource('https://example.org/f.h5ad', { fetchImpl: ranged }), {
    url: 'https://example.org/f.h5ad',
    size: 45360,
    etag: '"abc"',
    lastModified: null,
    rangeSupported: true,
    head: null,
  });
  assert.deepEqual(oneRequest, [['HEAD', 'bytes=0-']], 'one request, asking for the whole range');
  // GitHub Pages: a plain HEAD would report the gzipped length (5514) and
  // hide Content-Encoding; the ranged HEAD reports the stored size.
  const pages = async (url, init = {}) => (init.headers?.Range === 'bytes=0-'
    ? { ok: true, status: 206, url, headers: headers({ 'Content-Length': '45360' }) }
    : { ok: true, status: 200, url, headers: headers({ 'Content-Length': '5514' }) });
  assert.equal((await probeHttpResource('https://theislab.github.io/x.h5ad', { fetchImpl: pages })).size, 45360);
  // A host that ignores the range on HEAD: its length, then a one-byte range proves ranges.
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(init.method ?? 'GET');
    if (init.method === 'HEAD') {
      return { ok: true, status: 200, headers: headers({ 'Content-Length': '4096', ETag: '"abc"' }) };
    }
    return { ok: true, status: 206, url, headers: headers({}), arrayBuffer: async () => new ArrayBuffer(1) };
  };
  assert.deepEqual(await probeHttpResource('https://example.org/f.h5ad', { fetchImpl }), {
    url: 'https://example.org/f.h5ad',
    size: 4096,
    etag: '"abc"',
    lastModified: null,
    rangeSupported: true,
    head: null,
  });
  assert.deepEqual(calls, ['HEAD', 'GET']);
  const noHead = async (url, init = {}) => {
    if (init.method === 'HEAD') throw new TypeError('blocked');
    return { ok: true, status: 206, url, headers: headers({ 'Content-Range': 'bytes 0-0/777' }), arrayBuffer: async () => new ArrayBuffer(1) };
  };
  assert.equal((await probeHttpResource('https://example.org/f', { fetchImpl: noHead })).size, 777);
  const hidden = async (url, init = {}) => {
    if (init.method === 'HEAD') throw new TypeError('blocked');
    return { ok: true, status: 206, url, headers: headers({}), arrayBuffer: async () => new ArrayBuffer(1) };
  };
  await assert.rejects(
    probeHttpResource('https://example.org/f', { fetchImpl: hidden }),
    error => error.code === BYTE_SOURCE_FAILURES.SIZE_UNKNOWN
  );
  const missing = async (url, init = {}) => ({ ok: false, status: 404, url, headers: headers({}), arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(
    probeHttpResource('https://example.org/f', { fetchImpl: missing }),
    error => error.code === BYTE_SOURCE_FAILURES.HTTP && error.status === 404
  );
});

test('probeHttpResource reads a file\'s head in the same round trip as its size', async () => {
  const bytes = pattern(3000);
  const headers = values => ({ get: name => values[name] ?? null });
  const answer = (init, { headSize = true, exposeRange = true } = {}) => {
    if (init.method === 'HEAD') {
      return headSize ? { ok: true, status: 206, headers: headers({ 'Content-Length': '3000', ETag: '"v1"' }) } : null;
    }
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const body = bytes.slice(Number(start), Math.min(3000, Number(end) + 1));
    return {
      ok: true,
      status: 206,
      headers: headers({ ETag: '"v1"', ...(exposeRange ? { 'Content-Range': `bytes ${start}-${start + body.length - 1}/3000` } : {}) }),
      arrayBuffer: async () => body.buffer,
    };
  };
  // Both requests are on the wire before either is answered.
  const sent = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const held = async (url, init = {}) => {
    sent.push([init.method ?? 'GET', init.headers.Range]);
    if (sent.length === 2) release();
    await gate;
    return answer(init);
  };
  const probed = await probeHttpResource('https://example.org/f.h5ad', { fetchImpl: held, headBytes: 1024 });
  assert.deepEqual(sent, [['GET', 'bytes=0-1023'], ['HEAD', 'bytes=0-']]);
  assert.equal(probed.size, 3000);
  assert.deepEqual(probed.head.bytes, bytes.subarray(0, 1024));
  assert.equal(probed.head.etag, '"v1"');
  assert.ok(probed.head.ms >= 0);
  // A file shorter than the head is read whole.
  const whole = await probeHttpResource('https://example.org/f.h5ad', { fetchImpl: async (url, init = {}) => answer(init), headBytes: 4096 });
  assert.deepEqual(whole.head.bytes, bytes);
  // No HEAD: the head's Content-Range names the size, with no third request.
  const gets = [];
  const noHead = await probeHttpResource('https://example.org/f.h5ad', {
    headBytes: 1024,
    fetchImpl: async (url, init = {}) => {
      gets.push(init.method ?? 'GET');
      if (init.method === 'HEAD') throw new TypeError('blocked');
      return answer(init);
    },
  });
  assert.equal(noHead.size, 3000);
  assert.deepEqual(noHead.head.bytes, bytes.subarray(0, 1024));
  assert.deepEqual(gets.sort(), ['GET', 'HEAD']);
  // A host that ignores ranges is never read whole: the body is let go of.
  let cancelled = 0;
  const ignoring = await probeHttpResource('https://example.org/f.h5ad', {
    headBytes: 1024,
    fetchImpl: async (url, init = {}) => (init.method === 'HEAD'
      ? { ok: true, status: 200, headers: headers({ 'Content-Length': '3000' }) }
      : {
          ok: true,
          status: 200,
          headers: headers({ 'Content-Length': '3000' }),
          body: { cancel: async () => { cancelled++; } },
          arrayBuffer: async () => assert.fail('a whole response is never read'),
        }),
  });
  assert.equal(ignoring.rangeSupported, false);
  assert.equal(ignoring.head, null);
  assert.equal(cancelled, 1);
});

test('a byte reader starts from a head read already: cached, counted once, and measuring the link', async () => {
  const bytes = pattern(10_000);
  const source = recordingSource(bytes, POLICY);
  const reader = createByteReader(source, { head: { bytes: bytes.slice(0, 4096), ms: 40 } });
  assert.deepEqual(await reader.read(0, 100, { cache: true }), bytes.subarray(0, 100));
  assert.deepEqual(await reader.read(2000, 2096), bytes.subarray(2000, 4096), 'a data read inside the head too');
  assert.deepEqual(source.calls, [], 'nothing more is fetched');
  assert.equal(reader.cachedEnd(10), 4096);
  assert.equal(reader.cachedEnd(5000), 5000);
  assert.deepEqual(reader.stats(), { bytes: 4096, requests: 1, cacheHits: 2 });
  assert.equal(reader.link.latencyMs, 40);
  assert.equal(reader.link.bytesPerMs, 4096 / 40);
  // Only whole blocks are kept, unless the head holds the file to its end.
  const partial = createByteReader(recordingSource(bytes, POLICY), { head: { bytes: bytes.slice(0, 1500), ms: 1 } });
  assert.equal(partial.cachedEnd(0), 1024);
  const all = createByteReader(recordingSource(bytes, { ...POLICY, cacheBytes: 16_384 }), { head: { bytes: bytes.slice(), ms: 1 } });
  assert.equal(all.cachedEnd(0), 10_000);
});

test('an exact read whose bytes came in with cached metadata is answered from the cache', async () => {
  const bytes = pattern(100_000);
  const source = recordingSource(bytes, POLICY);
  const reader = createByteReader(source);
  await reader.read(1100, 8, { cache: true });
  await reader.read(2100, 8, { cache: true });
  const calls = source.calls.length;
  assert.deepEqual(await reader.read(1500, 1000), bytes.subarray(1500, 2500), 'spans two cached blocks');
  assert.equal(source.calls.length, calls);
  assert.deepEqual(await reader.read(3000, 200), bytes.subarray(3000, 3200), 'not cached: fetched');
  assert.equal(source.calls.length, calls + 1);
});

test('an activity knows how much is left: requests count when planned and when they arrive', async () => {
  const { ReadActivity } = await import('../assets/js/formats/io/activity.js');
  const source = recordingSource(pattern(100_000), POLICY);
  const reader = createByteReader(source);
  const activity = new ReadActivity({ kind: 'genes', label: 'two genes' });
  const release = source.hold();
  const reads = Promise.all([
    reader.read(10_000, 3000, { activity }),
    reader.read(50_000, 3000, { activity }),
  ]);
  await new Promise(resolve => setTimeout(resolve, 5));
  let snapshot = activity.snapshot();
  assert.equal(snapshot.bytesFetched, 0, 'nothing has arrived yet');
  assert.equal(snapshot.bytesPlanned, 6000, 'both requests are planned before any byte arrives');
  assert.equal(snapshot.bytesTotal, 6000);
  release();
  await reads;
  snapshot = activity.snapshot();
  assert.equal(snapshot.bytesFetched, 6000);
  assert.equal(snapshot.bytesTotal, 6000);

  // An operation that streams a whole array says so up front; the time left
  // comes from steps when it counts them, else from bytes and the rate.
  const streaming = new ReadActivity({ kind: 'index', label: 'X, indexed by gene' });
  streaming.expect(1_000_000);
  streaming.startedAt -= 2000;
  streaming.fetched(250_000);
  let estimate = streaming.snapshot();
  assert.equal(estimate.bytesTotal, 1_000_000);
  assert.ok(Math.abs(estimate.remainingMs - 6000) < 100, `bytes: 3/4 left at the measured rate (${estimate.remainingMs})`);
  streaming.progress(50, 100);
  estimate = streaming.snapshot();
  assert.ok(Math.abs(estimate.remainingMs - 2000) < 100, `steps: half done in 2 s (${estimate.remainingMs})`);
  streaming.finish();
  assert.equal(streaming.snapshot().remainingMs, null, 'nothing is left once it ends');
});

test('a planned request cancelled before it is sent no longer counts as left to read', async () => {
  const { ReadActivity } = await import('../assets/js/formats/io/activity.js');
  const source = recordingSource(pattern(100_000), { ...POLICY, concurrency: 1 });
  const reader = createByteReader(source);
  const activity = new ReadActivity({ kind: 'genes', label: 'a gene' });
  const release = source.hold();
  const controller = new AbortController();
  const first = reader.read(0, 3000, { activity });
  const second = reader.read(60_000, 3000, { activity, signal: controller.signal });
  second.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(activity.snapshot().bytesPlanned, 6000);
  controller.abort();
  await assert.rejects(second);
  assert.equal(activity.snapshot().bytesPlanned, 3000);
  release();
  await first;
  assert.equal(activity.snapshot().bytesTotal, 3000);
});

test('a read a view waits for goes ahead of queued background work, which never takes the last slot', async () => {
  const { ReadActivity } = await import('../assets/js/formats/io/activity.js');
  const source = recordingSource(pattern(1_000_000), { ...POLICY, concurrency: 3, mergeGapBytes: 0 });
  const reader = createByteReader(source);
  const index = new ReadActivity({ kind: 'index', label: 'X, indexed by gene', background: true });
  const release = source.hold();
  const background = [0, 1, 2, 3, 4].map(i => reader.read(i * 100_000, 1000, { activity: index }));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(source.calls.length, 2, 'background work leaves one slot free');
  const view = reader.read(900_000, 1000, { activity: new ReadActivity({ kind: 'field', label: 'a field' }) });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(source.calls.at(-1), [900_000, 1000], 'the view read starts at once, ahead of queued background reads');
  release();
  await Promise.all([...background, view]);
  assert.equal(source.calls.length, 6);
});

test('a web host starts at its streams; background work keeps under its HTTP/1.1 connections until it is known to multiplex', async () => {
  const { ReadActivity } = await import('../assets/js/formats/io/activity.js');
  const recorded = recordingSource(pattern(16_000_000), { ...POLICY, concurrency: 6, streams: 100, mergeGapBytes: 0 });
  // A round trip of a few milliseconds, so the link is measured.
  const source = { ...recorded, read: async (offset, length, options) => {
    await new Promise(resolve => setTimeout(resolve, 2));
    return recorded.read(offset, length, options);
  } };
  Object.defineProperty(source, 'calls', { get: () => recorded.calls });
  source.hold = () => recorded.hold();
  const reader = createByteReader(source);
  assert.equal(reader.link.concurrency, 100);
  // Measured: one read of half a megabyte.
  await reader.read(15_400_000, 500_000);
  source.calls.length = 0;
  const release = source.hold();
  // Forty small scattered reads a view waits for: every one on the wire at once.
  const views = Array.from({ length: 40 }, (_, i) => reader.read(i * 50_000, 100));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(source.calls.length, 40);
  release();
  await Promise.all(views);
  assert.equal(reader.link.multiplexed, true, 'forty answered within a round trip: the host multiplexes');
  // On another link to a host not yet known to multiplex, large reads beyond
  // six wait while those in flight carry two round trips' worth of bytes.
  const other = createByteReader(source);
  await other.read(15_400_000, 500_000);
  source.calls.length = 0;
  const big = source.hold();
  const size = Math.ceil(other.link.roundTripBytes / 2);
  const step = size + other.link.mergeGapBytes + 1000;
  const large = Array.from({ length: 12 }, (_, i) => other.read(i * step, size));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(source.calls.length >= 6 && source.calls.length < 12, `${source.calls.length} large requests in flight`);
  big();
  await Promise.all(large);
  // Background work on a host not known to multiplex: no more than five
  // requests, whatever the queue.
  source.calls.length = 0;
  const hold = source.hold();
  const index = new ReadActivity({ kind: 'index', label: 'X, indexed by gene', background: true });
  // Apart by more than the merge gap, so each is its own request.
  const apart = other.link.mergeGapBytes + 1000;
  const background = Array.from({ length: 12 }, (_, i) => other.read(i * apart, 100, { activity: index }));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(source.calls.length, 5);
  const view = other.read(15_990_000, 100);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(source.calls.at(-1), [15_990_000, 100], 'the view read starts at once');
  hold();
  await Promise.all([...background, view]);
});

test('a Zarr web host that answers a range with the whole object is asked for it once', async () => {
  const { httpStore } = await import('../assets/js/formats/zarr/stores/http.js');
  const object = pattern(10_000);
  const requests = [];
  const store = httpStore('https://host.example/store.zarr/', {
    fetch: async (url, init = {}) => {
      requests.push(init.headers?.Range ?? null);
      return new Response(object.slice(), { status: 200 });
    },
  });
  const [index] = await store.getRanges('X/c/0', [{ suffix: 16 }]);
  assert.deepEqual(index, object.subarray(10_000 - 16));
  const parts = await store.getRanges('X/c/0', [{ offset: 100, length: 50 }, { offset: 5000, length: 10 }]);
  assert.deepEqual(parts, [object.subarray(100, 150), object.subarray(5000, 5010)]);
  assert.equal(requests.length, 1, 'the whole shard was kept, not fetched again');
});

/** A memory source behind a link with a `latency` ms round trip and `rate` bytes per ms. */
function linkSource(bytes, { latency = 20, rate = 1000, concurrency = 2 } = {}) {
  const base = bytesByteSource(bytes, {
    name: 'link',
    policy: { blockBytes: 1024, mergeGapBytes: 0, maxRequestBytes: 1 << 20, concurrency, cacheBytes: 8192, bytesPerMs: 0 },
  });
  const calls = [];
  let gate = null;
  return {
    ...base,
    calls,
    hold() {
      let release;
      gate = new Promise(resolve => { release = resolve; });
      return () => { gate = null; release(); };
    },
    async read(offset, length, options = {}) {
      calls.push([offset, length]);
      if (gate) await gate;
      await new Promise(resolve => setTimeout(resolve, latency + length / rate));
      return base.read(offset, length, options);
    },
  };
}

/** Measure the link: a small read (the round trip), then a large one (the bandwidth). */
async function measureLink(reader) {
  await reader.read(0, 10);
  await reader.read(10_000, 50_000);
}

test('request shaping follows the measured link: priors until measured, then merge gap and request size from it', async () => {
  const bytes = pattern(200_000);
  const source = linkSource(bytes);
  const reader = createByteReader(source);
  assert.equal(reader.link.measured, false);
  assert.equal(reader.link.mergeGapBytes, 0, 'the prior');
  assert.equal(reader.link.maxRequestBytes, 1 << 20, 'the prior');
  assert.equal(reader.link.readsAhead, false, 'a host assumed nothing of is not read ahead before it is measured');
  await measureLink(reader);
  const link = reader.link;
  assert.equal(link.measured, true);
  assert.ok(link.latencyMs >= 20 && link.latencyMs < 40, `round trip ${link.latencyMs}`);
  assert.ok(link.bytesPerMs > 500 && link.bytesPerMs <= 1100, `bandwidth ${link.bytesPerMs}`);
  // A gap is worth what transfers in the share of a round trip one request costs.
  assert.equal(link.mergeGapBytes, Math.floor(link.bytesPerMs * link.latencyMs / 2));
  // A request carries a round trip's worth for every request in flight, and
  // never less than the prior.
  assert.equal(link.maxRequestBytes, Math.max(1 << 20, Math.floor(link.bytesPerMs * link.latencyMs * 2)));
  assert.equal(link.readsAhead, false, 'a 1 MB/s link is fetched on demand');

  // Reads within the measured merge gap are one request.
  source.calls.length = 0;
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => reader.read(100_000 + i * 150, 100)));
  results.forEach((result, i) => assert.deepEqual(result, bytes.subarray(100_000 + i * 150, 100_000 + i * 150 + 100)));
  assert.deepEqual(source.calls, [[100_000, 39 * 150 + 100]]);
});

test('a plan fetches the gaps that make it quickest under every concurrency the host may have', () => {
  // Thirty 10 kB reads 100 kB apart (each gap a little wider than the last),
  // over an 80 ms, 50 kB/ms link.
  const spans = Array.from({ length: 30 }, (_, i) => {
    const start = i * 110_000 + (i * (i - 1)) / 2;
    return { start, end: start + 10_000, background: false };
  });
  const gaps = spans.slice(1).map((span, i) => span.start - spans[i].end);
  const link = concurrencies => ({ measured: true, latencyMs: 80, bytesPerMs: 50_000, concurrencies, mergeGapBytes: 1 });
  const requestsOf = threshold => 1 + gaps.filter(gap => gap > threshold).length;
  // Over HTTP/1.1 a gap (2 ms) is cheaper than a sixth of a round trip (13 ms): every gap is fetched.
  assert.equal(requestsOf(planMergeGap(spans, link([6]), 1 << 30)), 1);
  // A host answering a hundred at once: a request costs 0.8 ms of a round trip, less than any gap.
  assert.equal(planMergeGap(spans, link([100]), 1 << 30), 0);
  // Either, not known yet: the plan nearest the best under both, within a
  // few round trips over HTTP/1.1 and a few gaps over HTTP/2.
  const either = requestsOf(planMergeGap(spans, link([6, 100]), 1 << 30));
  assert.ok(either > 1 && either < 30, `${either} requests`);
  // Background spans never pay for a gap.
  assert.equal(planMergeGap(spans.map(span => ({ ...span, background: true })), link([6]), 1 << 30), 0);
  // Until measured, the prior holds.
  assert.equal(planMergeGap(spans, { ...link([6]), measured: false, mergeGapBytes: 123 }, 1 << 30), 123);
});

test('a fast link reads ahead; a large read over it is split by its bandwidth-delay product', async () => {
  const { LinkMeter, READ_AHEAD_BYTES_PER_MS } = await import('../assets/js/formats/io/link.js');
  let clock = 0;
  const meter = new LinkMeter({ blockBytes: 1024, mergeGapBytes: 0, maxRequestBytes: 4096, concurrency: 6 }, { clock: () => clock });
  assert.equal(meter.maxRequestBytes, 4096, 'the prior until measured');
  assert.equal(meter.readsAhead, false, 'no bandwidth assumed: not read ahead until measured');
  assert.equal(new LinkMeter({ blockBytes: 1024, mergeGapBytes: 0, maxRequestBytes: 4096, concurrency: 4, bytesPerMs: 1_000_000 }).readsAhead,
    true, 'a disk is read ahead from the start');
  // A 0.5 ms round trip, then 10 MB in 10 ms on one request.
  let started = meter.begin();
  clock += 0.5;
  meter.end(started, 100);
  started = meter.begin();
  clock += 10.5;
  meter.end(started, 10_000_000);
  assert.equal(meter.latencyMs, 0.5);
  assert.equal(meter.bytesPerMs, 1_000_000);
  assert.ok(meter.bytesPerMs >= READ_AHEAD_BYTES_PER_MS);
  assert.equal(meter.readsAhead, true);
  assert.equal(meter.maxRequestBytes, 3_000_000);
  assert.equal(meter.roundTripBytes, 500_000);
  // A local file is read ahead whatever a small read measures.
  const disk = new LinkMeter({ blockBytes: 1024, mergeGapBytes: 0, maxRequestBytes: 4096, concurrency: 4, bytesPerMs: 1_000_000 }, { clock: () => clock });
  const read = disk.begin();
  clock += 1;
  disk.end(read, 62_700);
  assert.equal(disk.measured, true);
  assert.equal(disk.readsAhead, true);
  // A failed request measures nothing.
  started = meter.begin();
  clock += 0.01;
  meter.end(started, null);
  assert.equal(meter.latencyMs, 0.5);
});

test('requests waiting for a slot are merged with their neighbours across plans while round trips cost more than bytes', async () => {
  const bytes = pattern(400_000);
  const source = linkSource(bytes, { latency: 20, rate: 1000, concurrency: 2 });
  const reader = createByteReader(source);
  await measureLink(reader);
  const gap = reader.link.mergeGapBytes;
  assert.ok(gap > 1000, `merge gap ${gap}`);
  source.calls.length = 0;
  const release = source.hold();
  // Two reads take both slots; then forty reads, one plan each, wait.
  const busy = [reader.read(300_000, 10), reader.read(350_000, 10)];
  await new Promise(resolve => setImmediate(resolve));
  const waiting = [];
  for (let i = 0; i < 40; i++) {
    waiting.push(reader.read(100_000 + i * 1000, 100));
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(source.calls.length, 2);
  release();
  const results = await Promise.all(waiting);
  await Promise.all(busy);
  results.forEach((result, i) => {
    const start = 100_000 + i * 1000;
    assert.deepEqual(result, bytes.subarray(start, start + 100));
  });
  // Each read was its own plan; waiting in the queue, they are fetched with
  // far fewer requests than reads.
  assert.ok(source.calls.length - 2 <= 8, `${source.calls.length - 2} requests for 40 reads`);
});

test('thousands of reads under one signal add one abort listener to it, and an abort still rejects each at once', async () => {
  const { abortListenerCount, abortWaiterCount } = await import('../assets/js/formats/io/abort.js');
  const bytes = pattern(400_000);
  const source = recordingSource(bytes, POLICY);
  const reader = createByteReader(source);
  const controller = new AbortController();
  let added = 0;
  const addEventListener = controller.signal.addEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { added++; return addEventListener(...args); };
  // Every read settles normally: the signal is left with nothing on it.
  const results = await Promise.all(Array.from({ length: 20_000 }, (_, i) => reader.read((i * 17) % 399_000, 8, { signal: controller.signal })));
  assert.equal(results.length, 20_000);
  assert.equal(added, 1, 'one listener for every read');
  assert.equal(abortWaiterCount(controller.signal), 0);
  assert.equal(abortListenerCount(controller.signal), 0);

  // Held reads under the signal: the abort rejects every one, and their requests stop.
  const release = source.hold();
  const pending = Array.from({ length: 5000 }, (_, i) => reader.read(200_000 + i * 31, 4, { signal: controller.signal }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(abortListenerCount(controller.signal), 1);
  controller.abort(new DOMException('stop', 'AbortError'));
  const outcomes = await Promise.allSettled(pending);
  assert.ok(outcomes.every(outcome => outcome.status === 'rejected' && outcome.reason.name === 'AbortError'));
  release();
  // Another signal's read is untouched.
  assert.deepEqual(await reader.read(10, 4, { signal: new AbortController().signal }), bytes.subarray(10, 14));
});

test('onAbort calls every waiting callback once, in order, and a released one never', async () => {
  const { onAbort, abortWaiterCount } = await import('../assets/js/formats/io/abort.js');
  const controller = new AbortController();
  const calls = [];
  const stops = Array.from({ length: 5 }, (_, i) => onAbort(controller.signal, () => calls.push(i)));
  stops[2]();
  stops[2]();
  assert.equal(abortWaiterCount(controller.signal), 4);
  controller.abort();
  assert.deepEqual(calls, [0, 1, 3, 4]);
  controller.signal.dispatchEvent(new Event('abort'));
  assert.deepEqual(calls, [0, 1, 3, 4], 'once');
  assert.equal(typeof onAbort(null, () => {}), 'function');
});

test('the concurrency follows the protocol: six over HTTP/1.1, doubled while it pays otherwise', async () => {
  const { LinkMeter } = await import('../assets/js/formats/io/link.js');
  // A local file's prior (no streams): the disk multiplexes from the start.
  const prior = { blockBytes: 1024, mergeGapBytes: 0, maxRequestBytes: 4096, concurrency: 6, bytesPerMs: 0 };
  let clock = 0;
  const meter = new LinkMeter(prior, { clock: () => clock });
  assert.equal(meter.multiplexed, true);
  /** `count` requests completing in `ms` while others wait. */
  const wave = (count, ms, target = meter) => {
    const started = Array.from({ length: count }, () => target.begin());
    target.waiting(100);
    clock += ms;
    for (const at of started) target.end(at, 1000);
  };
  // A level is weighed over two waves of its requests.
  wave(6, 100);
  wave(6, 100);
  assert.equal(meter.concurrency, 12, 'the first level measured, the next is tried');
  wave(12, 100);
  wave(12, 100);
  assert.equal(meter.concurrency, 24, 'twice the requests per round trip: kept, and doubled again');
  assert.equal(meter.backgroundConcurrency, 11, 'background work stays under the level known to pay');
  wave(24, 200);
  wave(24, 200);
  assert.equal(meter.concurrency, 12, 'no more requests per millisecond: back to the last level that paid');
  wave(12, 50);
  wave(12, 50);
  assert.equal(meter.concurrency, 12, 'and it stays');

  // A backlog that ends before the window fills says nothing.
  const quiet = new LinkMeter(prior, { clock: () => clock });
  const at = quiet.begin();
  quiet.waiting(3);
  clock += 10;
  quiet.waiting(0);
  quiet.end(at, 10);
  assert.equal(quiet.concurrency, 6);

  // A web host: its streams from the start, background work under its
  // HTTP/1.1 connections until it is known to multiplex.
  const remote = { ...prior, streams: 100 };
  const host = () => {
    const link = new LinkMeter(remote, { clock: () => clock });
    // One request completes first: a connection is open.
    const first = link.begin();
    clock += 80;
    link.end(first, 100);
    return link;
  };
  /** A burst of `count` requests begun together, completing at `ends(i)` ms after it began. */
  const burst = (link, count, ends) => {
    const began = clock;
    const started = Array.from({ length: count }, () => link.begin());
    const order = started.map((startedAt, i) => [ends(i), startedAt]).sort((a, b) => a[0] - b[0]);
    for (const [after, startedAt] of order) {
      clock = began + after;
      link.end(startedAt, 1000);
    }
  };
  const fresh = host();
  assert.equal(fresh.concurrency, 100);
  assert.equal(fresh.multiplexed, null);
  assert.equal(fresh.backgroundConcurrency, 5);
  assert.equal(fresh.snapshot().backgroundConcurrency, 5);
  assert.equal(fresh.shapingConcurrency, 6, 'reads are shaped for six until the host is known to multiplex');

  // Twenty requests answered within a round trip: HTTP/1.1 cannot do that.
  const multiplexed = host();
  burst(multiplexed, 20, i => 80 + i);
  assert.equal(multiplexed.multiplexed, true);
  assert.equal(multiplexed.concurrency, 100);
  assert.equal(multiplexed.backgroundConcurrency, 99);
  assert.equal(multiplexed.shapingConcurrency, 100);

  // Six at a time, a round trip apart, with bytes that transfer at once:
  // the browser's queue. Twice in a row, and the host is HTTP/1.1.
  const queued = host();
  burst(queued, 20, i => 80 * (1 + Math.floor(i / 6)));
  assert.equal(queued.multiplexed, null, 'one burst is not enough');
  burst(queued, 20, i => 80 * (1 + Math.floor(i / 6)));
  assert.equal(queued.multiplexed, false);
  assert.equal(queued.concurrency, 6);
  assert.equal(queued.backgroundConcurrency, 5);
  // The first requests of a link (no connection open yet) say nothing.
  const cold = new LinkMeter(remote, { clock: () => clock });
  burst(cold, 20, i => 240 + 80 * Math.floor(i / 6));
  assert.equal(cold.multiplexed, null);

  // HTTP/1.1, as the browser reports it: six, never more.
  const http1 = new LinkMeter(remote, { clock: () => clock });
  http1.noteProtocol('http/1.1');
  for (let i = 0; i < 24; i++) {
    const started = http1.begin();
    http1.waiting(100);
    clock += 10;
    http1.end(started, 1000);
  }
  assert.equal(http1.concurrency, 6);
  assert.equal(http1.snapshot().protocol, 'http/1.1');
  const h2 = new LinkMeter(remote, { clock: () => clock });
  h2.noteProtocol('h2');
  assert.equal(h2.multiplexed, true);
  assert.equal(h2.concurrency, 100);
});
