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
import { equivalentS3Urls } from '../assets/js/formats/io/s3.js';

import { settle, virtualTime } from './helpers/virtual-time.mjs';

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

test('http sources refuse an answer of another range, or of a file whose size changed', async () => {
  const bytes = pattern(100);
  const shifted = fakeHost(bytes, ({ start, end }) => new Response(bytes.slice(start + 1, end + 2), {
    status: 206,
    headers: { 'Content-Range': `bytes ${start + 1}-${end + 1}/100` },
  }));
  const source = httpByteSource({ url: 'https://example.org/a', size: 100 }, { fetch: shifted.fetch });
  await assert.rejects(source.read(10, 10), { code: BYTE_SOURCE_FAILURES.RANGE_IGNORED, message: /bytes 10-19.*bytes 11-20/ });
  const grown = fakeHost(bytes, ({ start, end }) => new Response(bytes.slice(start, end + 1), {
    status: 206,
    headers: { 'Content-Range': `bytes ${start}-${end}/120` },
  }));
  const regrown = httpByteSource({ url: 'https://example.org/a', size: 100 }, { fetch: grown.fetch });
  await assert.rejects(regrown.read(10, 10), { code: BYTE_SOURCE_FAILURES.CHANGED, message: /now 120 bytes/ });
  // A range named exactly, or an unknown total, is read.
  const exact = fakeHost(bytes, ({ start, end }) => new Response(bytes.slice(start, end + 1), {
    status: 206,
    headers: { 'Content-Range': `bytes ${start}-${end}/*` },
  }));
  assert.deepEqual(await httpByteSource({ url: 'https://example.org/a', size: 100 }, { fetch: exact.fetch }).read(10, 10), bytes.subarray(10, 20));
});

test('http sources without an ETag tell a new version by its Last-Modified', async () => {
  const bytes = pattern(100);
  const host = fakeHost(bytes, ({ start, end, count }) => new Response(bytes.slice(start, end + 1), {
    status: 206,
    headers: { 'Last-Modified': count === 1 ? 'Mon, 26 Oct 2026 10:00:00 GMT' : 'Tue, 27 Oct 2026 10:00:00 GMT' },
  }));
  const source = httpByteSource({ url: 'https://example.org/a', size: 100 }, { fetch: host.fetch });
  await source.read(0, 10);
  await assert.rejects(source.read(10, 10), { code: BYTE_SOURCE_FAILURES.CHANGED });
});

test('a public S3 object has its other addresses; a signed one, or another host, has none', () => {
  const key = '/cell-census/2025-11-10/h5ads/x.h5ad';
  const virtual = `https://bucket-1.s3.us-west-2.amazonaws.com${key}`;
  assert.deepEqual(equivalentS3Urls(virtual), [
    `https://s3.us-west-2.amazonaws.com/bucket-1${key}`,
    `https://s3.dualstack.us-west-2.amazonaws.com/bucket-1${key}`,
    `https://bucket-1.s3.dualstack.us-west-2.amazonaws.com${key}`,
  ]);
  assert.deepEqual(equivalentS3Urls(`https://s3.eu-central-1.amazonaws.com/bucket-1${key}?versionId=3`), [
    `https://s3.dualstack.eu-central-1.amazonaws.com/bucket-1${key}?versionId=3`,
    `https://bucket-1.s3.eu-central-1.amazonaws.com${key}?versionId=3`,
    `https://bucket-1.s3.dualstack.eu-central-1.amazonaws.com${key}?versionId=3`,
  ]);
  // A dotted bucket has no virtual-hosted HTTPS address its certificate covers.
  assert.deepEqual(equivalentS3Urls(`https://s3.us-east-1.amazonaws.com/my.bucket${key}`), [
    `https://s3.dualstack.us-east-1.amazonaws.com/my.bucket${key}`,
  ]);
  assert.deepEqual(equivalentS3Urls(`${virtual}?X-Amz-Signature=abc&X-Amz-Credential=k`), []);
  assert.deepEqual(equivalentS3Urls(`https://example.org${key}`), []);
  assert.deepEqual(equivalentS3Urls(`http://bucket-1.s3.us-west-2.amazonaws.com${key}`), []);
  assert.deepEqual(equivalentS3Urls('https://bucket-1.s3.us-west-2.amazonaws.com/'), []);
});

test('mirrors spread requests over their hosts, six connections to each, and one that fails is dropped', async () => {
  const bytes = pattern(1000);
  const urls = ['https://a.example/f', 'https://b.example/f', 'https://c.example/f'];
  let held = [];
  const asked = [];
  const fetch = (url, { headers }) => {
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(headers.Range);
    asked.push(new URL(url).host);
    return new Promise(resolve => held.push(() => resolve(new Response(bytes.slice(Number(start), Number(end) + 1), {
      status: 206,
      headers: { ETag: '"v1"' },
    }))));
  };
  const source = httpByteSource({ url: urls[0], size: 1000, mirrors: urls.slice(1) }, { fetch });
  assert.equal(source.policy.concurrency, 18, 'six connections to each of three hosts');
  const reads = Array.from({ length: 6 }, (_, i) => source.read(i * 100, 50));
  await settle();
  assert.deepEqual(asked.slice().sort(), ['a.example', 'a.example', 'b.example', 'b.example', 'c.example', 'c.example']);
  for (const release of held) release();
  held = [];
  const answers = await Promise.all(reads);
  answers.forEach((answer, i) => assert.deepEqual(answer, bytes.subarray(i * 100, i * 100 + 50)));

  // A mirror that answers another version is dropped at once; one that
  // cannot be reached at the second failure in a row; one that is busy
  // (503) is kept: a busy answer says nothing against it. The read is answered by
  // the file's own URL meanwhile, and no failure reaches the caller.
  const seen = [];
  let busy = true;
  const flaky = async (url, { headers }) => {
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(headers.Range);
    const host = new URL(url).host;
    seen.push(host);
    const answer = () => new Response(bytes.slice(Number(start), Number(end) + 1), { status: 206, headers: { ETag: '"v1"' } });
    if (host === 'b.example') return new Response(bytes.slice(Number(start), Number(end) + 1), { status: 206, headers: { ETag: '"other"' } });
    if (host === 'c.example') throw new TypeError('Failed to fetch');
    if (host === 'd.example' && busy) return new Response('<Error><Code>SlowDown</Code></Error>', { status: 503 });
    return answer();
  };
  const four = [...urls, 'https://d.example/f'];
  const mirrored = httpByteSource({ url: four[0], size: 1000, mirrors: four.slice(1), etag: '"v1"' }, { fetch: flaky });
  const wave = async at => {
    seen.length = 0;
    const answers = await Promise.all(Array.from({ length: 4 }, (_, i) => mirrored.read(at + i * 10, 10)));
    answers.forEach((answer, i) => assert.deepEqual(answer, bytes.subarray(at + i * 10, at + i * 10 + 10)));
    return seen.slice();
  };
  const first = await wave(0);
  assert.deepEqual(first.filter(host => host !== 'a.example').sort(), ['b.example', 'c.example', 'd.example']);
  const second = await wave(100);
  assert.ok(!second.includes('b.example'), 'another version: dropped at once');
  assert.ok(second.includes('c.example') && second.includes('d.example'), 'unreachable or busy once: asked again');
  busy = false;
  const third = await wave(200);
  assert.ok(!third.includes('c.example'), 'unreachable twice in a row: dropped');
  assert.ok(third.includes('d.example'), 'busy twice, then answering: kept');

  assert.throws(() => httpByteSource({ url: urls[0], size: 10, mirrors: ['ftp://x/y'] }), /mirrors/);
  assert.throws(() => httpByteSource({ url: urls[0], size: 10, mirrors: [urls[1]] }, { access: { target: async () => ({ url: urls[0] }) } }), /without mirrors/);
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
    contentCoded: false,
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
    contentCoded: false,
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

test('probeHttpResource tells a host that content-codes a file even in ranges, and reads that file whole', async () => {
  const headers = values => ({ get: name => values[name] ?? null });
  // NCBI's Apache: the HEAD answers (CORS allowed), every range read of the
  // gzip-coded .rds fails as a browser fails it (Chromium: a network error;
  // Firefox and Safari: an empty body), the whole file arrives decoded.
  const decoded = new Uint8Array([0x58, 0x0a, 0, 0, 0, 3]);
  const coded = rangeFailure => async (url, init = {}) => {
    if (init.method === 'HEAD') return { ok: true, status: 206, url, headers: headers({ 'Content-Range': 'bytes 0-999/1000', 'Content-Length': '1000' }) };
    if (init.headers?.Range) {
      if (rangeFailure === 'network') throw new TypeError('Failed to fetch');
      return { ok: true, status: 206, url, headers: headers({ 'Content-Range': 'bytes 0-0/1000' }), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return new Response(decoded, { status: 200 });
  };
  for (const failure of ['network', 'empty']) {
    const probed = await probeHttpResource('https://ftp.example.org/x.rds', { fetchImpl: coded(failure), checkRange: true });
    assert.equal(probed.contentCoded, true, failure);
    assert.equal(probed.rangeSupported, false, failure);
    assert.equal(probed.size, 1000);
  }
  // Chromium fails even the ranged HEAD of such a file: the whole file still answers.
  const chromium = async (url, init = {}) => {
    if (init.method === 'HEAD' || init.headers?.Range) throw new TypeError('Failed to fetch');
    return new Response(decoded, { status: 200, headers: { 'Content-Length': '1000' } });
  };
  const fromWhole = await probeHttpResource('https://ftp.example.org/x.rds', { fetchImpl: chromium, checkRange: true });
  assert.equal(fromWhole.contentCoded, true);
  assert.equal(fromWhole.size, 1000, 'the coded length the host states');
  // A host whose ranges work is read in place; without checkRange no range is asked for.
  const asked = [];
  const ranged = async (url, init = {}) => {
    asked.push(init.method ?? 'GET');
    if (init.method === 'HEAD') return { ok: true, status: 206, url, headers: headers({ 'Content-Range': 'bytes 0-999/1000' }) };
    return { ok: true, status: 206, url, headers: headers({ 'Content-Range': 'bytes 0-0/1000' }), arrayBuffer: async () => new ArrayBuffer(1) };
  };
  const plain = await probeHttpResource('https://example.org/x.rds', { fetchImpl: ranged, checkRange: true });
  assert.equal(plain.contentCoded, false);
  assert.equal(plain.rangeSupported, true);
  assert.deepEqual(asked.sort(), ['GET', 'HEAD']);
  // Neither a range nor the whole file: not content-coding, opening says what fails.
  const blocked = async (url, init = {}) => {
    if (init.method === 'HEAD') return { ok: true, status: 206, url, headers: headers({ 'Content-Range': 'bytes 0-999/1000' }) };
    throw new TypeError('Failed to fetch');
  };
  const unreadable = await probeHttpResource('https://example.org/x.rds', { fetchImpl: blocked, checkRange: true });
  assert.equal(unreadable.contentCoded, false);
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
  // Counted half a tick of this realm's clock longer than measured (`clockTickMs`).
  const { clockTickMs } = await import('../assets/js/formats/io/link.js');
  assert.equal(reader.link.latencyMs, 40 + clockTickMs() / 2);
  assert.equal(reader.link.bytesPerMs, 4096 / (40 + clockTickMs() / 2));
  // The head's answer seeds how long a request may stay silent: a host that
  // took longer than a second to answer it is not taken for stalled at one.
  const slow = createByteReader(recordingSource(bytes, POLICY), { head: { bytes: bytes.slice(0, 4096), ms: 2500 } });
  assert.ok(slow.link.responses.timeoutMs >= 2500, `${slow.link.responses.timeoutMs} ms`);
  // Only whole blocks are kept, unless the head holds the file to its end.
  const partial = createByteReader(recordingSource(bytes, POLICY), { head: { bytes: bytes.slice(0, 1500), ms: 1 } });
  assert.equal(partial.cachedEnd(0), 1024);
  const all = createByteReader(recordingSource(bytes, { ...POLICY, cacheBytes: 16_384 }), { head: { bytes: bytes.slice(), ms: 1 } });
  assert.equal(all.cachedEnd(0), 10_000);
});

test('a read whose start the head holds fetches only the rest (an R object read whole is not fetched twice)', async () => {
  // Google Drive and OneDrive read a file's head beside its details before
  // its format is known; a file then read whole from its start (an R
  // object's stream, in pieces longer than the head) fetched the head again.
  const bytes = pattern(10_000);
  const source = recordingSource(bytes, POLICY);
  const reader = createByteReader(source, { head: { bytes: bytes.slice(0, 4096), ms: 40 } });
  assert.deepEqual(await reader.read(0, 6000), bytes.subarray(0, 6000));
  assert.deepEqual(source.calls, [[4096, 1904]], 'only the bytes past the head, from a block\'s start');
  // Across the head's end, inside it, and past it.
  source.calls.length = 0;
  assert.deepEqual(await reader.read(3000, 3000), bytes.subarray(3000, 6000));
  assert.deepEqual(source.calls, [[4096, 1904]]);
  source.calls.length = 0;
  assert.deepEqual(await reader.read(7000, 100), bytes.subarray(7000, 7100));
  assert.deepEqual(source.calls, [[7000, 100]], 'a read the head does not reach is fetched as asked');
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
  await settle();
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
  await settle();
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
  await settle();
  assert.equal(source.calls.length, 2, 'background work leaves one slot free');
  const view = reader.read(900_000, 1000, { activity: new ReadActivity({ kind: 'field', label: 'a field' }) });
  await settle();
  assert.deepEqual(source.calls.at(-1), [900_000, 1000], 'the view read starts at once, ahead of queued background reads');
  release();
  await Promise.all([...background, view]);
  assert.equal(source.calls.length, 6);
});

test('a web host starts at its streams; background work keeps under its HTTP/1.1 connections until it is known to multiplex', async () => {
  const { ReadActivity } = await import('../assets/js/formats/io/activity.js');
  // A web host's prior: nothing assumed of its bandwidth (`REMOTE_POLICY`).
  const recorded = recordingSource(pattern(16_000_000), { ...POLICY, concurrency: 6, streams: 100, mergeGapBytes: 0, bytesPerMs: 0 });
  // A 20 ms round trip on a virtual clock, so the link is measured, and
  // forty answers landing together are told from a queue's waves (within
  // half a round trip). A request is recorded when the reader sends it and
  // answered a round trip later: what is in flight is what the reader sent.
  const time = virtualTime();
  const source = { ...recorded, read: async (offset, length, options) => {
    const bytes = await recorded.read(offset, length, options);
    await time.sleep(20);
    return bytes;
  } };
  Object.defineProperty(source, 'calls', { get: () => recorded.calls });
  source.hold = () => recorded.hold();
  const reader = createByteReader(source, { clock: time.now });
  assert.equal(reader.link.concurrency, 100);
  // Measured: one read of half a megabyte.
  await reader.read(15_400_000, 500_000);
  source.calls.length = 0;
  const release = source.hold();
  // Forty small scattered reads a view waits for: every one on the wire at once.
  const views = Array.from({ length: 40 }, (_, i) => reader.read(i * 50_000, 100));
  await settle();
  assert.equal(source.calls.length, 40);
  release();
  await Promise.all(views);
  assert.equal(reader.link.multiplexed, true, 'forty answered within a round trip: the host multiplexes');
  // On another link to a host not yet known to multiplex, large reads beyond
  // six wait while those in flight carry two round trips' worth of bytes.
  // Its measuring read is one request: split into a burst, the burst's
  // completions could already show the host multiplexing.
  const other = createByteReader(source, { policy: { maxRequestBytes: 500_000 }, clock: time.now });
  await other.read(15_400_000, 500_000);
  assert.equal(other.link.multiplexed, null, 'one request shows nothing of the protocol');
  source.calls.length = 0;
  const big = source.hold();
  const size = Math.ceil(other.link.roundTripBytes / 2);
  const step = size + other.link.mergeGapBytes + 1000;
  const large = Array.from({ length: 12 }, (_, i) => other.read(i * step, size));
  await settle();
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
  await settle();
  assert.equal(source.calls.length, 5);
  const view = other.read(15_990_000, 100);
  await settle();
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

/**
 * A memory source behind a link with a `latency` ms round trip and `rate`
 * bytes per ms, on a virtual clock (`source.time`) its reader measures with
 * (`linkReader`): what the link measures is what the source stands for.
 */
function linkSource(bytes, { latency = 20, rate = 1000, concurrency = 2 } = {}) {
  const base = bytesByteSource(bytes, {
    name: 'link',
    policy: { blockBytes: 1024, mergeGapBytes: 0, maxRequestBytes: 1 << 20, concurrency, cacheBytes: 8192, bytesPerMs: 0 },
  });
  const calls = [];
  let gate = null;
  const time = virtualTime();
  return {
    ...base,
    calls,
    time,
    hold() {
      let release;
      gate = new Promise(resolve => { release = resolve; });
      return () => { gate = null; release(); };
    },
    async read(offset, length, options = {}) {
      calls.push([offset, length]);
      if (gate) await gate;
      await time.sleep(latency + length / rate);
      return base.read(offset, length, options);
    },
  };
}

const linkReader = source => createByteReader(source, { clock: source.time.now });

/** Measure the link: a small read (the round trip), then a large one (the bandwidth). */
async function measureLink(reader) {
  await reader.read(0, 10);
  await reader.read(10_000, 50_000);
}

test('request shaping follows the measured link: priors until measured, then merge gap and request size from it', async () => {
  const bytes = pattern(200_000);
  const source = linkSource(bytes);
  const reader = linkReader(source);
  assert.equal(reader.link.measured, false);
  assert.equal(reader.link.mergeGapBytes, 0, 'the prior');
  assert.equal(reader.link.maxRequestBytes, 1 << 20, 'the prior');
  assert.equal(reader.link.readsAhead, false, 'a host assumed nothing of is not read ahead before it is measured');
  await measureLink(reader);
  const link = reader.link;
  assert.equal(link.measured, true);
  // The round trip is the small read's (20 ms and its 10 bytes); the
  // bandwidth, the large read's bytes over its time less a round trip.
  assert.ok(Math.abs(link.latencyMs - 20.01) < 1e-9, `round trip ${link.latencyMs}`);
  assert.ok(Math.abs(link.bytesPerMs - 1000) < 1, `bandwidth ${link.bytesPerMs}`);
  // A gap is worth what transfers in the share of a round trip one request costs.
  assert.equal(link.mergeGapBytes, Math.floor(link.bytesPerMs * link.latencyMs / 2));
  // A request carries one round trip's worth of the whole link's bandwidth
  // (more would only serialise on one connection), never less than the prior.
  assert.equal(link.maxRequestBytes, Math.max(1 << 20, Math.floor(link.bytesPerMs * link.latencyMs)));
  assert.equal(link.readsAhead, false, 'a 1 MB/s link is fetched on demand');

  // Reads within the measured merge gap are one request.
  source.calls.length = 0;
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => reader.read(100_000 + i * 150, 100)));
  results.forEach((result, i) => assert.deepEqual(result, bytes.subarray(100_000 + i * 150, 100_000 + i * 150 + 100)));
  assert.deepEqual(source.calls, [[100_000, 39 * 150 + 100]]);
});

test('background reads asked for together are coalesced across their gaps when that saves time, never with a read a view waits for', async () => {
  const { ReadActivity } = await import('../assets/js/formats/io/activity.js');
  const bytes = pattern(400_000);
  const source = recordingSource(bytes, { ...POLICY, concurrency: 6, maxRequestBytes: 1 << 20, cacheBytes: 1 << 20 });
  const reader = createByteReader(source);
  // A measured link where a request costs far more than a 2 kB gap.
  reader.link.recordRequest(80, 4000);
  reader.link.bytesPerMs = 50_000;
  const index = new ReadActivity({ kind: 'index', label: 'X, kept rows', background: true });
  const kept = Array.from({ length: 20 }, (_, i) => reader.read(i * 3000, 1000, { activity: index }));
  const results = await Promise.all(kept);
  results.forEach((result, i) => assert.deepEqual(result, bytes.subarray(i * 3000, i * 3000 + 1000)));
  assert.ok(source.calls.length <= 2, `${source.calls.length} requests for twenty background reads 2 kB apart`);
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
  // Background spans (an index built over a subsample's kept rows, a gene
  // waiting for it) are priced the same: a gap is fetched when it saves time.
  assert.equal(planMergeGap(spans.map(span => ({ ...span, background: true })), link([6]), 1 << 30), planMergeGap(spans, link([6]), 1 << 30));
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
  // One round trip's worth of the link (1,000,000 bytes/ms x 0.5 ms), not
  // that for each of its six connections.
  assert.equal(meter.maxRequestBytes, 500_000);
  assert.equal(meter.roundTripBytes, 500_000);
  // Twenty-four connections at 50 MB/s and 150 ms: requests of 7.5 MB, not
  // 180 MB that one HTTP/1.1 connection would carry alone.
  const wide = new LinkMeter({ blockBytes: 1024, mergeGapBytes: 0, maxRequestBytes: 4096, concurrency: 24 }, { clock: () => clock });
  wide.recordRequest(150, 1000);
  wide.bytesPerMs = 50_000;
  assert.equal(wide.maxRequestBytes, 7_500_000);
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

test('a link timed by a clock of whole milliseconds counts each request half a tick longer: its round trip is never 0', async () => {
  const { LinkMeter, clockTickMs, performanceNow } = await import('../assets/js/formats/io/link.js');
  const tick = clockTickMs();
  assert.ok(tick > 0 && tick < 1, `this realm's clock resolution is measured (${tick} ms)`);
  assert.equal(clockTickMs(), tick, 'measured once per realm');
  // Timed by `performance.now`, a link is given its resolution; a virtual clock is exact.
  assert.equal(new LinkMeter({ blockBytes: 1024, mergeGapBytes: 0, maxRequestBytes: 4096, concurrency: 6 })._halfTick, tick / 2);
  assert.equal(new LinkMeter({ blockBytes: 1024, mergeGapBytes: 0, maxRequestBytes: 4096, concurrency: 6 }, { clock: performanceNow })._halfTick, tick / 2);
  assert.equal(new LinkMeter({ blockBytes: 1024, mergeGapBytes: 0, maxRequestBytes: 4096, concurrency: 6 }, { clock: () => 0 })._halfTick, 0);
  assert.throws(() => new LinkMeter({ blockBytes: 1024, mergeGapBytes: 0, maxRequestBytes: 4096, concurrency: 6 }, { tickMs: -1 }), TypeError);
  // WebKit's and Firefox's clocks in a worker tick in whole milliseconds. A
  // server on the same machine answers within one: the request ends on the
  // tick it began on and measures 0 ms.
  let clock = 0;
  const coarse = new LinkMeter({ blockBytes: 1024, mergeGapBytes: 65_536, maxRequestBytes: 4096, concurrency: 6, streams: 100 }, { clock: () => clock, tickMs: 1 });
  let started = coarse.begin();
  coarse.end(started, 38);
  started = coarse.begin();
  clock += 2;
  coarse.end(started, 100_000);
  // The shortest request lies in [0, 1) ms: counted at its middle, not at 0
  // (a round trip of 0 priced every request at nothing: no gap merged, and
  // the page's range cache given no time to answer).
  assert.equal(coarse.latencyMs, 0.5);
  // The busy period (2 ms measured, half a tick longer) past its first round trip.
  assert.equal(coarse.bytesPerMs, 50_000);
  assert.equal(coarse.mergeGapBytes, Math.floor(50_000 * 0.5 / 6));
  assert.ok(coarse.roundTripBytes > 0);
  // The same requests on an exact clock: as measured.
  clock = 0;
  const exact = new LinkMeter({ blockBytes: 1024, mergeGapBytes: 65_536, maxRequestBytes: 4096, concurrency: 6, streams: 100 }, { clock: () => clock });
  started = exact.begin();
  clock += 0.5;
  exact.end(started, 38);
  started = exact.begin();
  clock += 2.5;
  exact.end(started, 100_000);
  assert.equal(exact.latencyMs, 0.5);
  assert.equal(exact.bytesPerMs, 50_000);
});

test('requests waiting for a slot are merged with their neighbours across plans while round trips cost more than bytes', async () => {
  const bytes = pattern(400_000);
  const source = linkSource(bytes, { latency: 20, rate: 1000, concurrency: 2 });
  const reader = linkReader(source);
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
  const bytes = pattern(600_000);
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
  // Past every byte the reads above fetched (as their gaps too), so none is
  // answered from what they kept.
  const pending = Array.from({ length: 5000 }, (_, i) => reader.read(420_000 + i * 31, 4, { signal: controller.signal }));
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

test('shared work goes on for the waiters left, stops when none is, and is started anew for the next', async () => {
  const { SharedWork, SharedWorks, sharedOnce } = await import('../assets/js/formats/io/abort.js');
  const aborted = reason => new DOMException(reason, 'AbortError');
  // Work that ends only when told, or when its own signal aborts.
  const pending = () => {
    const made = [];
    const start = options => {
      const signal = options?.signal ?? options;
      const one = { signal };
      one.promise = new Promise((resolve, reject) => {
        one.finish = resolve;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      made.push(one);
      return one.promise;
    };
    return { made, start };
  };

  // One waiter withdraws: the other still gets the result, never an AbortError.
  const { made, start } = pending();
  const shared = new SharedWork(start);
  const a = new AbortController();
  const b = new AbortController();
  const first = shared.join(a.signal);
  const second = shared.join(b.signal);
  const third = shared.join(null);
  a.abort(aborted('A'));
  await assert.rejects(first, error => error.message === 'A', 'the waiter that withdrew gets its own reason');
  assert.equal(made[0].signal.aborted, false, 'others wait: the work goes on');
  made[0].finish('result');
  assert.equal(await second, 'result');
  assert.equal(await third, 'result');
  assert.equal(shared.joins, 3);

  // Every waiter withdraws: the work stops; a waiter without a signal never withdraws.
  const alone = new SharedWork(pending().start);
  const c = new AbortController();
  const d = new AbortController();
  const only = [alone.join(c.signal), alone.join(d.signal)];
  c.abort(aborted('C'));
  assert.equal(alone.abandoned, false);
  d.abort(aborted('D'));
  await assert.rejects(only[0], error => error.message === 'C');
  await assert.rejects(only[1], error => error.message === 'D');
  assert.equal(alone.abandoned, true, 'the last waiter gone, the work stops');
  await assert.rejects(alone.join(null), TypeError, 'abandoned work is not joined again');
  // Held waiters (followed elsewhere) withdraw by calling what hold returned.
  const held = new SharedWork(pending().start);
  const leaveA = held.hold();
  const leaveB = held.hold();
  leaveA();
  leaveA();
  assert.equal(held.abandoned, false, 'a waiter withdraws once');
  leaveB();
  assert.equal(held.abandoned, true);

  // By key: a waiter arriving after the others withdrew starts the work anew,
  // and gets its result, not the abandoned work's AbortError.
  const keyed = pending();
  const works = new SharedWorks();
  const e = new AbortController();
  const early = works.run('k', keyed.start, { signal: e.signal, activity: 'first' });
  e.abort(aborted('E'));
  await assert.rejects(early, error => error.message === 'E');
  assert.equal(keyed.made.length, 1);
  const late = works.run('k', keyed.start, { signal: new AbortController().signal });
  assert.equal(keyed.made.length, 2, 'started again');
  const joined = works.run('k', keyed.start, {});
  assert.equal(keyed.made.length, 2, 'a running work is joined');
  keyed.made[1].finish('again');
  assert.equal(await late, 'again');
  assert.equal(await joined, 'again');
  assert.equal(works.has('k'), false, 'done work is forgotten (not kept)');

  // A memo keeps its result; a failure is forgotten and asked again.
  let calls = 0;
  const once = sharedOnce(async () => {
    calls++;
    if (calls === 1) throw new Error('transient');
    return calls;
  });
  await assert.rejects(once(), /transient/);
  assert.equal(await once(), 2);
  assert.equal(await once({ signal: new AbortController().signal }), 2);
  assert.equal(calls, 2);
});

test('a local file is priced at no less than its prior bandwidth: reads of a few hundred bytes never make a gap look dearer than a read', async () => {
  const { LinkMeter } = await import('../assets/js/formats/io/link.js');
  const { LOCAL_POLICY, REMOTE_POLICY } = await import('../assets/js/formats/io/byte-source.js');
  let clock = 0;
  const measure = (prior, reads) => {
    const link = new LinkMeter(prior, { clock: () => clock });
    for (const [ms, bytes] of reads) {
      const started = link.begin();
      clock += ms;
      link.end(started, bytes);
    }
    return link;
  };
  // Reads of 100 bytes in 1/16 ms measure 1.6 MB/s of a disk: a lower bound.
  const local = measure(LOCAL_POLICY, Array.from({ length: 20 }, () => [0.0625, 100]));
  assert.ok(local.bytesPerMs < LOCAL_POLICY.bytesPerMs);
  assert.equal(local.mergeGapBytes, Math.floor(LOCAL_POLICY.bytesPerMs * 0.0625 / local.shapingConcurrency));
  assert.equal(local.roundTripBytes, LOCAL_POLICY.bytesPerMs * 0.0625);
  // A read of no measurable time never makes another read free.
  assert.equal(measure(LOCAL_POLICY, [[0, 100], [1, 64_000]]).mergeGapBytes, LOCAL_POLICY.mergeGapBytes);
  // A web host is priced as measured.
  const remote = measure(REMOTE_POLICY, Array.from({ length: 20 }, () => [50, 100]));
  assert.equal(remote.roundTripBytes, remote.bytesPerMs * 50);
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
  // Requests whose round trip is timed from later than they began (a read
  // that first asked the page's byte cache) stay in the burst they began in.
  const asked = host();
  const askedBurst = () => {
    const began = clock;
    const started = Array.from({ length: 20 }, () => asked.begin());
    started.map((startedAt, i) => [80 * (1 + Math.floor(i / 6)), startedAt]).sort((a, b) => a[0] - b[0]).forEach(([after, startedAt]) => {
      clock = began + after;
      asked.end(startedAt + 3, 1000, startedAt);
    });
  };
  askedBurst();
  askedBurst();
  assert.equal(asked.multiplexed, false, 'HTTP/1.1 learnt from bursts of reads timed from the host');
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

test('the byte reader ends each request in the burst it began in, however late its source timed it', async () => {
  const inner = bytesByteSource(new Uint8Array(4096));
  // A source that asks memory first (as `range-cache.js` does) times the
  // request from when it goes to the host.
  const source = { ...inner, read: async (offset, length, options) => {
    await new Promise(resolve => setTimeout(resolve, 2));
    options.onFetch?.();
    return inner.read(offset, length, options);
  } };
  const reader = createByteReader(source);
  const begun = [];
  const ended = [];
  const begin = reader.link.begin.bind(reader.link);
  const end = reader.link.end.bind(reader.link);
  reader.link.begin = () => { const at = begin(); begun.push(at); return at; };
  reader.link.end = (started, bytes, token) => { ended.push([started, token]); return end(started, bytes, token); };
  await Promise.all([reader.read(0, 10), reader.read(2048, 10)]);
  assert.ok(ended.length >= 1);
  for (const [started, token] of ended) {
    assert.ok(begun.includes(token), 'the token begin() gave');
    assert.ok(started > token, 'its round trip timed from when it reached the host');
  }
});

test('a source read through the page range cache fetches only what the page does not hold, and the page keeps to its budget', async t => {
  const { createByteRangeCache } = await import('../assets/js/data/byte-range-cache.js');
  const { adoptRangeCachePort, rangeCacheKey, withRangeCache } = await import('../assets/js/formats/io/range-cache.js');
  const bytes = pattern(100_000);
  const cache = createByteRangeCache({ budgetBytes: 30_000 });
  const { port1, port2 } = new MessageChannel();
  cache.connect(port1);
  adoptRangeCachePort(port2);
  t.after(() => {
    adoptRangeCachePort(null);
    port1.close();
  });
  const key = rangeCacheKey({ url: 'https://example.org/a', size: 100_000, identity: { key: 'a', version: '"v1"' } });
  assert.equal(rangeCacheKey({ url: 'https://example.org/a', size: 100_000, identity: { key: 'a', version: 'size:100000' } }), null,
    'a file known by its size alone may change under it: nothing is kept');
  const source = recordingSource(bytes, POLICY);
  const cached = withRangeCache(source, key);
  // A link measured at a 1 s round trip: the page is asked for up to that long.
  const link = { latencyMs: 1000 };
  assert.deepEqual(await cached.read(10_000, 5000, { link }), bytes.subarray(10_000, 15_000));
  await new Promise(resolve => setTimeout(resolve, 10));
  // Held in part: only the rest is fetched, and the read says it was held.
  let held = false;
  let fetchedAt = null;
  assert.deepEqual(await cached.read(12_000, 6000, { link, onHeld: () => { held = true; }, onFetch: () => { fetchedAt = performance.now(); } }), bytes.subarray(12_000, 18_000));
  assert.ok(fetchedAt !== null, 'the request was timed from when it went to the host');
  assert.ok(held);
  assert.deepEqual(source.calls, [[10_000, 5000], [15_000, 3000]]);
  // Held whole: no request.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(await cached.read(11_000, 7000, { link }), bytes.subarray(11_000, 18_000));
  assert.equal(source.calls.length, 2);
  // Past its budget the page lets the least recently used ranges go.
  for (let at = 40_000; at < 100_000; at += 10_000) await cached.read(at, 10_000, { link });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(cache.stats().bytes <= 30_000, `${cache.stats().bytes} bytes kept`);
  // Another file's key never sees these bytes.
  const otherKey = rangeCacheKey({ url: 'https://example.org/a', size: 100_000, identity: { key: 'a', version: '"v2"' } });
  const other = recordingSource(bytes, POLICY);
  await withRangeCache(other, otherKey).read(90_000, 1000, { link });
  assert.deepEqual(other.calls, [[90_000, 1000]], 'another version is fetched, not taken from the first');
});

test('a page that does not answer holds a read for at most one round trip of the link, once a file; a cancelled read stops waiting at once', async t => {
  const { adoptRangeCachePort, withRangeCache } = await import('../assets/js/formats/io/range-cache.js');
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = () => {};
  adoptRangeCachePort(port2);
  t.after(() => {
    adoptRangeCachePort(null);
    port1.close();
  });
  const bytes = pattern(1000);
  const source = recordingSource(bytes, POLICY);
  const cached = withRangeCache(source, 'key');
  let started = performance.now();
  assert.deepEqual(await cached.read(0, 10, { link: { latencyMs: 40 } }), bytes.subarray(0, 10));
  const waited = performance.now() - started;
  assert.ok(waited >= 35 && waited < 1000, `waited ${waited} ms for a page that never answers`);
  // What the page holds of a file is asked once: a read of ranges it is not
  // known to hold goes to the host at once.
  started = performance.now();
  await cached.read(30, 10, { link: { latencyMs: 40 } });
  assert.ok(performance.now() - started < 30, 'no second wait for the page');
  // Without a link the page is not asked at all.
  started = performance.now();
  await cached.read(10, 10, {});
  assert.ok(performance.now() - started < 30);
  // Cancelled while it waits for the page: stops at once.
  const controller = new AbortController();
  started = performance.now();
  const reading = withRangeCache(source, 'another key').read(20, 10, { link: { latencyMs: 5000 }, signal: controller.signal });
  setTimeout(() => controller.abort(new DOMException('stop', 'AbortError')), 20);
  await assert.rejects(reading, /stop/);
  assert.ok(performance.now() - started < 1000, 'the cancel ended the wait');
});

test('a reader asks the page only for ranges the page holds of the file: what it holds, then what the reader hands it', async t => {
  const { createByteRangeCache } = await import('../assets/js/data/byte-range-cache.js');
  const { adoptRangeCachePort, withRangeCache } = await import('../assets/js/formats/io/range-cache.js');
  const bytes = pattern(50_000);
  const cache = createByteRangeCache({ budgetBytes: 1_000_000 });
  cache.keep('file', 1000, bytes.slice(1000, 2000));
  const { port1, port2 } = new MessageChannel();
  cache.connect(port1);
  const asked = [];
  const answer = port1.onmessage;
  port1.onmessage = event => {
    asked.push(Object.keys(event.data).find(name => name !== 'id'));
    answer(event);
  };
  adoptRangeCachePort(port2);
  t.after(() => {
    adoptRangeCachePort(null);
    port1.close();
  });
  const source = recordingSource(bytes, POLICY);
  const cached = withRangeCache(source, 'file');
  const link = { latencyMs: 1000 };
  // Held by the page from before: asked for and taken.
  assert.deepEqual(await cached.read(1000, 1000, { link }), bytes.subarray(1000, 2000));
  assert.deepEqual(source.calls, []);
  // Not held: fetched without asking.
  assert.deepEqual(await cached.read(10_000, 1000, { link }), bytes.subarray(10_000, 11_000));
  // Handed to the page by this reader: asked for next time.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(await cached.read(10_000, 1000, { link }), bytes.subarray(10_000, 11_000));
  assert.deepEqual(source.calls, [[10_000, 1000]]);
  assert.deepEqual(asked.filter(name => name !== 'keep'), ['holds', 'lookup', 'lookup'], 'the holds once; a lookup only for held ranges');
});

test('a file described from an ETag-less host is refused when its first read says it changed since, and its description carries what the host said', async t => {
  const bytes = pattern(100);
  const host = fakeHost(bytes, ({ start, end }) => new Response(bytes.slice(start, end + 1), {
    status: 206,
    headers: { 'Last-Modified': 'Tue, 27 Oct 2026 10:00:00 GMT' },
  }));
  const source = httpByteSource({ url: 'https://example.org/a', size: 100, lastModified: 'Mon, 26 Oct 2026 10:00:00 GMT' }, { fetch: host.fetch });
  await assert.rejects(source.read(0, 10), { code: BYTE_SOURCE_FAILURES.CHANGED });

  const { describeRemoteFile } = await import('../assets/js/data/sources/remote-file.js');
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const headers = { 'Last-Modified': 'Mon, 26 Oct 2026 10:00:00 GMT', 'Content-Range': 'bytes 0-99/100', 'Content-Length': '100' };
    if (init.method === 'HEAD') return new Response(null, { status: 206, headers });
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    return new Response(bytes.slice(Number(start), Math.min(99, Number(end)) + 1), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${Math.min(99, Number(end))}/100` } });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const described = await describeRemoteFile({ url: 'https://example.org/files/a.h5ad', id: 'a', name: 'a.h5ad', attribution: { title: 'a', url: 'https://example.org' } });
  assert.equal(described.resource.lastModified, 'Mon, 26 Oct 2026 10:00:00 GMT');
  assert.equal(described.resource.identity.version, 'modified:Mon, 26 Oct 2026 10:00:00 GMT', 'its modification time is its version');
  // A size given without a probe: the host's last answer here seeds the
  // reader's stall timeout.
  const known = await describeRemoteFile({ url: 'https://example.org/files/b.h5ad', id: 'b', name: 'b.h5ad', size: 100, attribution: { title: 'b', url: 'https://example.org' } });
  assert.ok(Number.isFinite(known.resource.answeredMs), 'the answer of an earlier request to the host is carried');
});
