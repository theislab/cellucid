/**
 * What a host says of its request budget and of when to ask again is what
 * requests to it follow (`formats/io/hosts.js`, `byte-source.js`): every
 * header form hosts send (Zenodo's and GitHub's `X-RateLimit-*` with an
 * epoch reset, the IETF `RateLimit-*` fields, Hugging Face's structured
 * `RateLimit`/`RateLimit-Policy`, `Retry-After`), a `429`, Google's `403`
 * naming a rate limit, and a served store's `503` "being prepared" with its
 * own words. A wait the host names is waited for exactly and never counted
 * as a failure; a request is not stalled while its host delivers to another
 * reader; a redirect never carries a sign-in to another host; a file whose
 * HEAD and head read name two versions is probed again.
 *
 * Waits run on a virtual clock (`helpers/virtual-time.mjs`) shared by the
 * link and the book of hosts, so what is asserted on time is what the
 * requests waited for.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BYTE_SOURCE_FAILURES,
  ByteSourceError,
  REMOTE_POLICY,
  fetchOnce,
  httpByteSource,
  isLimitAnswer,
  probeHttpResource,
  transientStatusError,
  withRetries,
} from '../assets/js/formats/io/byte-source.js';
import { LinkMeter, ResponseClock } from '../assets/js/formats/io/link.js';
import { budgetOf, createHostBook } from '../assets/js/formats/io/hosts.js';
import { planMergeGap } from '../assets/js/formats/io/byte-reader.js';
import { linkReadMs } from '../assets/js/data/anndata/subsample-plan.js';
import { settle, virtualTime } from './helpers/virtual-time.mjs';

/** The wall clock the virtual time starts at (epoch milliseconds). */
const EPOCH = 1_800_000_000_000;

function setup() {
  const time = virtualTime();
  const hosts = createHostBook({ now: time.now, after: time.after, epoch: () => EPOCH + time.now() });
  const link = new LinkMeter(REMOTE_POLICY, { clock: time.now, after: time.after });
  return { time, hosts, link };
}

function pattern(size) {
  return Uint8Array.from({ length: size }, (_, i) => (i * 7) & 255);
}

/** A range answer of `bytes`, with `headers`. */
function ranged(bytes, init, headers = {}) {
  const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range).map(Number);
  return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, ...headers } });
}

test('every header form a host states its budget in is read', () => {
  const headers = values => new Headers(values);
  // Zenodo, GitHub: epoch seconds.
  assert.deepEqual(budgetOf(headers({ 'X-RateLimit-Limit': '133', 'X-RateLimit-Remaining': '130', 'X-RateLimit-Reset': String((EPOCH + 45_000) / 1000) }), EPOCH),
    { limit: 133, remaining: 130, resetInMs: 45_000 });
  // A reset in seconds from now.
  assert.deepEqual(budgetOf(headers({ 'X-RateLimit-Remaining': '4', 'X-RateLimit-Reset': '30' }), EPOCH), { limit: null, remaining: 4, resetInMs: 30_000 });
  // The IETF fields.
  assert.deepEqual(budgetOf(headers({ 'RateLimit-Limit': '100', 'RateLimit-Remaining': '7', 'RateLimit-Reset': '12' }), EPOCH), { limit: 100, remaining: 7, resetInMs: 12_000 });
  // Hugging Face's structured fields; the tightest of several policies.
  assert.deepEqual(budgetOf(headers({ RateLimit: '"api";r=499;t=227', 'RateLimit-Policy': '"fixed window";"api";q=500;w=300' }), EPOCH),
    { limit: 500, remaining: 499, resetInMs: 227_000 });
  assert.deepEqual(budgetOf(headers({ RateLimit: '"api";r=40;t=200, "burst";r=3;t=2' }), EPOCH), { limit: null, remaining: 3, resetInMs: 2000 });
  assert.equal(budgetOf(headers({ 'Content-Type': 'text/plain' }), EPOCH), null, 'a host that says nothing');
});

test('a host with a request budget (Zenodo: 133 a minute, every range counted) is paced by it: requests wait for the reset, none fails', async () => {
  const { time, hosts, link } = setup();
  const bytes = pattern(4000);
  const LIMIT = 5;
  let windowEnds = 60_000;
  let used = 0;
  let refused = 0;
  const fetch = async (url, init) => {
    if (time.now() >= windowEnds) {
      windowEnds += 60_000;
      used = 0;
    }
    const counted = {
      'X-RateLimit-Limit': String(LIMIT),
      'X-RateLimit-Reset': String((EPOCH + windowEnds) / 1000),
    };
    if (used >= LIMIT) {
      refused++;
      return new Response('', { status: 429, headers: { ...counted, 'X-RateLimit-Remaining': '0' } });
    }
    used++;
    return ranged(bytes, init, { ...counted, 'X-RateLimit-Remaining': String(LIMIT - used) });
  };
  const source = httpByteSource({ url: 'https://zenodo.org/api/records/1/files/a.h5ad/content', size: bytes.length }, { fetch, hosts });
  const waits = [];
  // Twelve reads one after another: five in the first window, five in the
  // second, two in the third.
  for (let i = 0; i < 12; i++) {
    assert.deepEqual(await source.read(i * 100, 100, { link, onWait: wait => waits.push(wait) }), bytes.subarray(i * 100, i * 100 + 100));
  }
  assert.equal(refused, 0, 'never asked past the budget');
  assert.ok(time.now() >= 120_000 && time.now() < 121_000, `read as the windows reset (${time.now()} ms)`);
  const told = waits.filter(wait => wait !== null);
  assert.equal(told.length, 2, 'each wait for a reset is said once');
  assert.match(told[0].text, /^zenodo\.org limits how many requests it answers \(5 requests a window\): the next go in /);
});

test('a host that refuses for its limit and names its reset (Zenodo hides Retry-After, not X-RateLimit-*) is waited for, uncounted, and asked less at once after', async () => {
  const { time, hosts, link } = setup();
  const bytes = pattern(1000);
  let asked = 0;
  const fetch = async (url, init) => {
    asked++;
    // Eleven refusals in a row would spend any count of repeats.
    if (asked <= 11) {
      return new Response('', {
        status: 429,
        headers: { 'X-RateLimit-Limit': '133', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(Math.ceil((EPOCH + time.now() + 2000) / 1000)) },
      });
    }
    return ranged(bytes, init);
  };
  const source = httpByteSource({ url: 'https://zenodo.org/api/records/1/files/a.h5ad/content', size: bytes.length }, { fetch, hosts });
  const retried = [];
  link.responses.onRetry = error => retried.push(error);
  assert.deepEqual(await source.read(0, 10, { link }), bytes.subarray(0, 10));
  assert.equal(asked, 12);
  assert.equal(retried.length, 0, 'a wait the host named is no failure');
  assert.ok(time.now() >= 11 * 1000, `each reset waited for (${time.now()} ms)`);
});

test('a 429 with a readable Retry-After holds every request to the host, is not counted, and the host is asked fewer at once after', async () => {
  const { time, hosts, link } = setup();
  const bytes = pattern(1000);
  let refusals = 3;
  const sentAt = [];
  const caps = [];
  const fetch = async (url, init) => {
    sentAt.push(time.now());
    caps.push(hosts.budget(url)?.cap ?? Infinity);
    if (refusals > 0) {
      refusals--;
      return new Response('', { status: 429, headers: { 'Retry-After': '5' } });
    }
    return ranged(bytes, init);
  };
  const source = httpByteSource({ url: 'https://api.example.org/f', size: bytes.length }, { fetch, hosts });
  const [a, b] = await Promise.all([source.read(0, 10, { link }), source.read(500, 10, { link })]);
  assert.deepEqual(a, bytes.subarray(0, 10));
  assert.deepEqual(b, bytes.subarray(500, 510));
  // The first two refused at once; then every request waited out the hold.
  assert.ok(sentAt.slice(2).every(at => at >= 5000), `asked again only after the host's wait (${sentAt})`);
  assert.ok(caps.slice(3).some(cap => cap < Infinity), `asked fewer at once after a refusal (${caps})`);
  assert.equal(hosts.budget('https://api.example.org/').cap, Infinity, 'and as many as before once it answers again');
});

test('a served store\'s 503 "being prepared" is waited for exactly as long as asked, in its own words, never counted, and holds only that request', async () => {
  const { time, hosts, link } = setup();
  const bytes = pattern(1000);
  const words = 'X is being laid out gene-major for the viewer (37% done, about 12 s left).';
  let preparing = 30;
  const fetch = async (url, init) => {
    const [, start] = /bytes=(\d+)-/.exec(init.headers.Range).map(Number);
    if (start === 0 && preparing > 0) {
      preparing--;
      return new Response(words, { status: 503, headers: { 'Retry-After': '12', 'Content-Type': 'text/plain', 'Content-Length': String(words.length) } });
    }
    return ranged(bytes, init);
  };
  const source = httpByteSource({ url: 'http://127.0.0.1:8765/_cellucid/anndata/x.zarr/X/0', size: bytes.length }, { fetch, hosts });
  const waits = [];
  const retried = [];
  link.responses.onRetry = error => retried.push(error);
  const prepared = source.read(0, 10, { link, onWait: wait => waits.push(wait) });
  // Another key of the store is ready: read at once, not held.
  let readyAt = null;
  const ready = await source.read(500, 10, { link }).then(read => {
    readyAt = time.now();
    return read;
  });
  assert.deepEqual(ready, bytes.subarray(500, 510));
  assert.ok(readyAt < 12_000, `the store is not held by one key being prepared (${readyAt} ms)`);
  assert.deepEqual(await prepared, bytes.subarray(0, 10));
  assert.ok(time.now() >= 30 * 12_000, `waited exactly as asked, every time (${time.now()} ms): thirty waits are no failure`);
  assert.equal(retried.length, 0, 'never counted as a failure');
  assert.equal(link.admitted, link.concurrency, 'nor taken for a busy host');
  assert.deepEqual(waits[0], { host: '127.0.0.1:8765', untilMs: 12_000, text: words });
  assert.equal(waits.at(-1), null, 'the wait ends');
});

test('Google\'s 403 naming a rate limit is a rate limit: asked again, named in the provider\'s words', async () => {
  const { hosts, link } = setup();
  const bytes = pattern(1000);
  const body = JSON.stringify({ error: { code: 403, errors: [{ reason: 'rateLimitExceeded', domain: 'usageLimits' }] } });
  const refused = (headers = {}) => new Response('', { status: 403, headers });
  assert.equal(isLimitAnswer(refused(), body), true);
  assert.equal(isLimitAnswer(refused(), JSON.stringify({ error: { errors: [{ reason: 'notFound' }] } })), false);
  assert.equal(isLimitAnswer(refused(), null), false);
  // GitHub's API answers its spent budget with 403 and the count at 0.
  assert.equal(isLimitAnswer(refused({ 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1800003600' }), null), true);
  assert.equal(isLimitAnswer(refused({ 'X-RateLimit-Remaining': '12' }), null), false);
  // GitHub's secondary rate limits: 403 with a Retry-After while the budget has requests left.
  assert.equal(isLimitAnswer(refused({ 'X-RateLimit-Remaining': '4990', 'Retry-After': '60' }), null), true);
  let refusals = 2;
  const fetch = async (url, init) => {
    if (refusals > 0) {
      refusals--;
      return new Response(body, { status: 403, headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } });
    }
    return ranged(bytes, init);
  };
  const limited = 'Google is limiting how fast public Drive files are read through this key.';
  const access = { target: async () => ({ url: 'https://www.googleapis.com/drive/v3/files/abc?alt=media&key=K' }), limited };
  const source = httpByteSource({ url: 'https://www.googleapis.com/drive/v3/files/abc?alt=media', size: bytes.length, name: 'atlas.h5ad' }, { fetch, hosts, access });
  const retried = [];
  link.responses.onRetry = error => retried.push(error.message);
  assert.deepEqual(await source.read(0, 10, { link }), bytes.subarray(0, 10));
  assert.equal(retried.length, 2);
  assert.equal(retried[0], `atlas.h5ad: ${limited}`);
});

test('the realms of one site share what they learn of a host: a budget, a named wait, and its deliveries', async () => {
  const time = virtualTime();
  const listeners = [];
  const channel = () => {
    const own = { onmessage: null, postMessage: message => listeners.filter(other => other !== own).forEach(other => other.onmessage?.({ data: structuredClone(message) })) };
    listeners.push(own);
    return own;
  };
  const page = createHostBook({ now: time.now, after: time.after, epoch: () => EPOCH + time.now(), channel: channel() });
  const worker = createHostBook({ now: time.now, after: time.after, epoch: () => EPOCH + time.now(), channel: channel() });
  const answered = page.admit('https://zenodo.org/api/records/1');
  answered(new Response('{}', { headers: { 'X-RateLimit-Limit': '133', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String((EPOCH + 30_000) / 1000) } }));
  assert.equal(worker.budget('https://zenodo.org/').remaining, 0, 'the worker knows what the page learnt');
  let admitted = false;
  const waiting = worker.admit('https://zenodo.org/api/records/1/files/a/content');
  assert.equal(typeof waiting.then, 'function', 'it waits for the reset');
  waiting.then(() => { admitted = true; });
  await settle();
  assert.equal(admitted, false);
  await waiting;
  assert.ok(time.now() >= 30_000);
  const before = worker.deliveries('https://zenodo.org/');
  page.delivered('https://zenodo.org/api/records/1');
  assert.equal(worker.deliveries('https://zenodo.org/'), before + 1, 'a delivery in one realm is one in the other');
});

test('a request queued behind another reader\'s on the same host is not stalled while the host delivers to it', async () => {
  const time = virtualTime();
  const hosts = createHostBook({ now: time.now, after: time.after });
  const bytes = pattern(100_000);
  // Reader A's request trickles for 5 s; reader B's is answered only after it (one connection).
  let release = null;
  const busy = new Promise(resolve => { release = resolve; });
  const fetch = async (url, init) => {
    if (url.endsWith('/a')) {
      const body = new ReadableStream({
        async start(controller) {
          for (let i = 0; i < 10; i++) {
            await time.sleep(500);
            controller.enqueue(bytes.slice(i * 10, i * 10 + 10));
          }
          controller.close();
          release();
        },
      });
      return new Response(body, { status: 206 });
    }
    await busy;
    return ranged(bytes, init);
  };
  const linkA = new LinkMeter(REMOTE_POLICY, { clock: time.now, after: time.after });
  const linkB = new LinkMeter(REMOTE_POLICY, { clock: time.now, after: time.after });
  const a = httpByteSource({ url: 'https://geo.example.org/a', size: 100 }, { fetch, hosts });
  const b = httpByteSource({ url: 'https://geo.example.org/b', size: bytes.length }, { fetch, hosts });
  const stalls = [];
  linkB.responses.onRetry = error => stalls.push(error.code);
  const [, read] = await Promise.all([a.read(0, 100, { link: linkA }), b.read(0, 10, { link: linkB })]);
  assert.deepEqual(read, bytes.subarray(0, 10));
  assert.deepEqual(stalls, [], 'B waited behind A without being taken for stalled');
});

test('a redirect reused on another host is asked with Range alone: a sign-in never follows a redirect', async () => {
  const bytes = pattern(1000);
  const asked = [];
  const fetch = async (url, init) => {
    asked.push({ url, headers: { ...init.headers } });
    const response = ranged(bytes, init);
    if (url.startsWith('https://api.example.org/')) Object.defineProperty(response, 'url', { value: 'https://cdn.example.net/blob?sig=1' });
    return response;
  };
  const access = { target: async () => ({ url: 'https://api.example.org/f', headers: { Authorization: 'Bearer secret' } }) };
  const source = httpByteSource({ url: 'https://api.example.org/f', size: bytes.length }, { fetch, access });
  await source.read(0, 10);
  await source.read(10, 10);
  assert.equal(asked[0].headers.Authorization, 'Bearer secret', 'the host given the sign-in is asked with it');
  assert.equal(asked[1].url, 'https://cdn.example.net/blob?sig=1');
  assert.deepEqual(Object.keys(asked[1].headers), ['Range'], 'the redirect is asked with Range alone');
});

test('a file whose HEAD and head read name two versions is probed again; one that keeps changing is refused', async () => {
  const bytes = pattern(2000);
  let version = 0;
  let flips = 1;
  const fetch = async (url, init) => {
    if (init.method === 'HEAD') {
      return new Response(null, { status: 206, headers: { 'Content-Length': String(bytes.length), 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}`, ETag: `"v${version}"` } });
    }
    // The file is rewritten between the two answers of the first probe.
    const tag = `"v${flips > 0 ? version + 1 : version}"`;
    if (flips > 0) {
      flips--;
      version++;
    }
    return ranged(bytes, init, { ETag: tag });
  };
  const probed = await probeHttpResource('https://host.example.org/f.h5ad', { fetchImpl: fetch, headBytes: 512 });
  assert.equal(probed.etag, '"v1"', 'the version both answers name');
  assert.equal(probed.head.etag, '"v1"');
  let always = 0;
  const changing = async (url, init) => {
    always++;
    if (init.method === 'HEAD') return new Response(null, { status: 206, headers: { 'Content-Length': '2000', 'Content-Range': 'bytes 0-1999/2000', ETag: `"h${always}"` } });
    return ranged(bytes, init, { ETag: `"r${always}"` });
  };
  await assert.rejects(probeHttpResource('https://host.example.org/f.h5ad', { fetchImpl: changing, headBytes: 512 }), { code: BYTE_SOURCE_FAILURES.CHANGED });
});

test('a Retry-After under a second asks again no sooner than the link would; one of a second or more is waited exactly, uncounted', async () => {
  const time = virtualTime();
  const clock = new ResponseClock({ clock: time.now, after: time.after });
  const response = (status, headers = {}) => new Response('', { status, headers });
  const named = transientStatusError(response(503, { 'Retry-After': '7' }), 'https://h.example/x');
  assert.equal(named.details.namedWaitMs, 7000);
  assert.equal(transientStatusError(response(503, { 'Retry-After': '0' }), 'https://h.example/x').details.namedWaitMs, null);
  let attempts = 0;
  const started = time.now();
  await withRetries(async () => {
    attempts++;
    if (attempts <= 20) throw named;
    return 'ok';
  }, { clock });
  assert.equal(attempts, 21, 'twenty named waits are no failure');
  assert.equal(time.now() - started, 20 * 7000, 'each waited exactly');
  attempts = 0;
  const now = time.now();
  const zero = transientStatusError(response(503, { 'Retry-After': '0' }), 'https://h.example/x');
  await withRetries(async () => {
    attempts++;
    if (attempts === 1) throw zero;
    return 'ok';
  }, { clock, random: () => 0 });
  assert.equal(time.now() - now, clock.timeoutMs, 'asked again after the link\'s own wait');
  await assert.rejects(withRetries(async () => { throw new ByteSourceError(BYTE_SOURCE_FAILURES.HTTP, 'no'); }, { clock }), /no/);
});

test('a request whose answer is optional (GitHub\'s commit of a file) is never held for a spent budget; any other waits for the reset', async () => {
  const { time, hosts } = setup();
  const reset = String((EPOCH + 3_600_000) / 1000);
  let asked = 0;
  const fetchImpl = async () => {
    asked++;
    return new Response('{"message":"API rate limit exceeded"}', {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'Content-Length': '38', 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': reset },
    });
  };
  const url = 'https://api.github.com/repos/o/r/commits?path=a.h5ad&per_page=1';
  const first = await fetchOnce(url, {}, { fetchImpl, hosts, wantsBody: () => false });
  assert.equal(first.response.status, 403);
  assert.equal(hosts.budget(url).remaining, 0, 'the budget is learnt from the refusal');
  await assert.rejects(fetchOnce(url, {}, { fetchImpl, hosts, waits: false }), { code: BYTE_SOURCE_FAILURES.RATE_LIMITED });
  assert.equal(asked, 1, 'not asked, not waited for');
  assert.equal(time.now(), 0);
  const waited = fetchOnce(url, {}, { fetchImpl, hosts, wantsBody: () => false });
  await waited;
  assert.ok(time.now() >= 3_600_000, 'a request that needs its answer waits for the reset');
});

test('a served Zarr store\'s chunk "being prepared" is waited for in the store too, its words on the read\'s activity', async () => {
  const { time, hosts, link } = setup();
  const { httpStore } = await import('../assets/js/formats/zarr/index.js');
  const { ReadActivity } = await import('../assets/js/formats/io/activity.js');
  const words = 'X is being laid out gene-major for the viewer (10% done, about 2 s left).';
  const chunk = new Uint8Array(Int32Array.of(1, 2, 3, 4).buffer);
  let preparing = 2;
  const fetch = async url => {
    if (url.endsWith('/X/0') && preparing > 0) {
      preparing--;
      return new Response(words, { status: 503, headers: { 'Retry-After': '2', 'Content-Type': 'text/plain', 'Content-Length': String(words.length) } });
    }
    return url.endsWith('/X/0') ? new Response(chunk.slice(), { status: 200 }) : new Response('', { status: 404 });
  };
  const store = httpStore('http://127.0.0.1:8765/_cellucid/anndata/x.zarr/', { fetch, concurrency: link, hosts });
  const activity = new ReadActivity({ label: 'gene CD3E', kind: 'field' });
  const seen = [];
  activity._onUpdate = () => seen.push(activity.snapshot().waiting?.text ?? null);
  const retried = [];
  link.responses.onRetry = error => retried.push(error);
  assert.deepEqual(await store.get('X/0', { activity }), chunk);
  assert.equal(time.now(), 4000, 'each wait exactly as asked');
  assert.ok(seen.includes(words), 'the server\'s words are on the read\'s activity');
  assert.equal(activity.snapshot().waiting, null, 'and gone once the bytes came');
  assert.equal(retried.length, 0);
});

test('a wait named while a file is described (its probe) is the opening\'s step, in the host\'s words', async t => {
  const { describeRemoteFile } = await import('../assets/js/data/sources/remote-file.js');
  const bytes = pattern(4096);
  const words = 'atlas.h5ad is being prepared (90% done, about 1 s left).';
  let preparing = 1;
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'HEAD') {
      return new Response(null, { status: 206, headers: { 'Content-Length': String(bytes.length), 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}`, ETag: '"p1"' } });
    }
    if (preparing > 0) {
      preparing--;
      return new Response(words, { status: 503, headers: { 'Retry-After': '1', 'Content-Type': 'text/plain', 'Content-Length': String(words.length) } });
    }
    return ranged(bytes, init, { ETag: '"p1"' });
  };
  const steps = [];
  const described = await describeRemoteFile({
    url: 'https://prepare.example.org/atlas.h5ad',
    id: 'url:prepared',
    name: 'atlas.h5ad',
    attribution: { title: 'atlas', url: 'https://prepare.example.org/atlas.h5ad' },
    onStep: step => steps.push(step),
  });
  assert.equal(described.resource.size, bytes.length);
  assert.ok(steps.includes(words), `said: ${steps.join(' | ')}`);
});

test('a new window is asked with one request before the rest go: a host whose clock is behind refuses one, not a whole limit', async () => {
  const { time, hosts, link } = setup();
  const bytes = pattern(4000);
  const LIMIT = 5;
  // The host's window ends 2 s after this machine thinks it does.
  const lag = 2000;
  let windowEnds = 10_000;
  let used = 0;
  let refused = 0;
  let windows = 0;
  const fetch = async (url, init) => {
    if (time.now() >= windowEnds + lag) {
      windowEnds += 10_000;
      used = 0;
      windows++;
    }
    const counted = { 'X-RateLimit-Limit': String(LIMIT), 'X-RateLimit-Reset': String((EPOCH + windowEnds) / 1000) };
    if (used >= LIMIT) {
      // The first burst goes before any answer told the budget: only later refusals count.
      if (time.now() > 0) refused++;
      return new Response('', { status: 429, headers: { ...counted, 'X-RateLimit-Remaining': '0' } });
    }
    used++;
    return ranged(bytes, init, { ...counted, 'X-RateLimit-Remaining': String(LIMIT - used) });
  };
  const source = httpByteSource({ url: 'https://zenodo.org/api/records/2/files/a.h5ad/content', size: bytes.length }, { fetch, hosts });
  await Promise.all(Array.from({ length: 12 }, (_, i) => source.read(i * 100, 100, { link })));
  assert.ok(windows >= 1);
  // Each new window, by this machine's clock 2 s early, is asked one request
  // at a time until the host's has turned: never its whole limit at once.
  assert.ok(refused <= 2 * (windows + 1), `${refused} refused over ${windows} new windows`);
});

test('once a host\'s request budget binds, a request is priced at its interval: plans read through gaps worth it, and an opening fits the window in fewer requests', async () => {
  const { time, hosts, link } = setup();
  const bytes = pattern(4000);
  const fetch = async (url, init) => ranged(bytes, init, {
    'X-RateLimit-Limit': '133', 'X-RateLimit-Remaining': '132', 'X-RateLimit-Reset': String((EPOCH + 60_000) / 1000),
  });
  const url = 'https://zenodo.org/api/records/1/files/a.h5ad/content';
  assert.equal(hosts.requestCostMs(url), 0, 'a host that has stated no budget costs no more than its round trips');
  const source = httpByteSource({ url, size: bytes.length }, { fetch, hosts });
  await source.read(0, 100, { link });
  // One request of a 60 s window of 133 spent: nearly free; the interval grows with what is spent.
  assert.ok(Math.abs(source.requestCostMs() - (60_000 / 133) * (1 / 133)) < 1e-9, `${source.requestCostMs()} ms`);
  const spent = httpByteSource({ url, size: bytes.length }, { fetch: async (u, init) => ranged(bytes, init, {
    'X-RateLimit-Limit': '133', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String((EPOCH + 60_000) / 1000),
  }), hosts });
  await spent.read(100, 100, { link });
  assert.ok(Math.abs(spent.requestCostMs() - 60_000 / 133) < 1e-9, 'nothing left: the whole interval');
  assert.equal(hosts.requestCostMs('https://github.com/a'), 0, 'another host is not priced by it');
  // Budget-priced plans: on a link of 0.2 s and 2 MB/s, six at once, a gap of 400 KB is read through.
  const priced = { measured: true, latencyMs: 200, pricingBytesPerMs: 2000, bytesPerMs: 2000, concurrencies: [6], mergeGapBytes: 0, requestCostMs: 60_000 / 133 };
  const spans = [{ start: 0, end: 16_384 }, { start: 416_384, end: 432_768 }, { start: 832_768, end: 849_152 }];
  assert.ok(planMergeGap(spans, priced, 8 << 20) >= 400_000, 'the gaps cost less than the requests they save');
  assert.equal(planMergeGap(spans, { ...priced, requestCostMs: 0 }, 8 << 20), 0, 'without a budget, 400 KB gaps cost more than a request');
  assert.ok(Math.abs(linkReadMs({ bytes: 1000, requests: 133 }, { ...priced, shapingConcurrency: 6 }) - 60_000) < 1e-6, '133 requests take the window');
  assert.ok(time.now() >= 0);
});

/**
 * Zenodo, emulated (no request to it is ever sent from a test): its answers
 * state 133 requests a minute, but a network sending more than `blockAt`
 * in any minute gets an "unusual traffic" page without CORS headers (a
 * page reads no answer: the fetch fails) for `lockoutMs`.
 */
function zenodoBlocking(time, bytes, { blockAt = 20, lockoutMs = 300_000, roundTripMs = 100 } = {}) {
  const sent = [];
  const host = { blockedUntil: -Infinity, blocks: 0, answered: 0, times: [] };
  host.fetch = async (url, init) => {
    const at = time.now();
    host.times.push(at);
    sent.push(at);
    while (sent.length > 0 && sent[0] <= at - 60_000) sent.shift();
    await time.sleep(roundTripMs);
    if (at < host.blockedUntil) throw new TypeError('Failed to fetch');
    if (sent.length > blockAt) {
      host.blocks++;
      host.blockedAt = at;
      host.blockedUntil = at + lockoutMs;
      throw new TypeError('Failed to fetch');
    }
    host.answered++;
    const window = Math.floor(at / 60_000) * 60_000 + 60_000;
    return ranged(bytes, init, { 'X-RateLimit-Limit': '133', 'X-RateLimit-Remaining': '120', 'X-RateLimit-Reset': String((EPOCH + window) / 1000) });
  };
  return host;
}

test('a host on this machine that goes silent (a local server restarting) learns no pace and keeps none', async () => {
  // Found 2026-11-10: lost answers from the local catalog server taught it a block pace, kept for a
  // day: Suo then read at 5-60 KB/s for 95 s on every visit.
  const { rememberHostPace, rememberedHostPace, hostLinkSeed } = await import('../assets/js/data/host-link-memory.js');
  const time = virtualTime();
  const bytes = pattern(100_000);
  const memory = new Map();
  const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)), removeItem: key => memory.delete(key) };
  for (const url of ['http://127.0.0.1:54683/anndata/suo.zarr/obsm/0.0', 'http://localhost:8765/a.h5ad', 'http://[::1]:8765/a.h5ad']) {
    const silent = zenodoBlocking(time, bytes);
    const book = createHostBook({ now: time.now, after: time.after, epoch: () => EPOCH + time.now() });
    const learnt = [];
    book.watchPace((origin, paceMs) => { learnt.push(paceMs); rememberHostPace(origin, paceMs, storage); });
    const link = new LinkMeter(REMOTE_POLICY, { clock: time.now, after: time.after });
    const source = httpByteSource({ url, size: bytes.length }, { fetch: silent.fetch, hosts: book });
    for (let i = 0; i < 60; i++) await source.read(i * 100, 100, { link });
    assert.ok(silent.blocks >= 1, `${url}: the burst met the silence`);
    assert.deepEqual(learnt, [], `${url}: no pace is learnt`);
    assert.equal(book.pace(url), 0, `${url}: requests are not spaced`);
    const origin = new URL(url).origin;
    // Even a pace written before this rule is not kept or used.
    rememberHostPace(origin, 6_000, storage);
    assert.equal(rememberedHostPace(origin, storage), 0);
    assert.equal(hostLinkSeed(origin, { storage, timeline: null }).paceMs, 0);
  }
});

test('a host that blocks this network (Zenodo\'s "unusual traffic", within the budget it states) is waited out, paced at half what met the block, kept per host, and a later visit never meets it', async () => {
  const { rememberHostPace, rememberedHostPace, hostLinkSeed, forgetHostLinks } = await import('../assets/js/data/host-link-memory.js');
  const time = virtualTime();
  const bytes = pattern(100_000);
  const url = 'https://zenodo.org/api/records/1/files/a.h5ad/content';
  const zenodo = zenodoBlocking(time, bytes);
  const memory = new Map();
  const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)), removeItem: key => memory.delete(key) };
  // First visit: reads one after another, as fast as the host answers.
  const first = createHostBook({ now: time.now, after: time.after, epoch: () => EPOCH + time.now() });
  let sentBefore = null;
  first.watchPace((origin, paceMs) => {
    sentBefore ??= zenodo.times.length;
    rememberHostPace(origin, paceMs, storage);
  });
  const firstLink = new LinkMeter(REMOTE_POLICY, { clock: time.now, after: time.after });
  const source = httpByteSource({ url, size: bytes.length }, { fetch: zenodo.fetch, hosts: first });
  // The block meets the burst; the read in progress waits it out, told so,
  // and every read gives its bytes: none fails, nothing read is lost.
  const told = [];
  for (let i = 0; i < 60; i++) {
    assert.deepEqual(await source.read(i * 100, 100, { link: firstLink, onWait: wait => { if (wait !== null) told.push(wait.text); } }), bytes.subarray(i * 100, i * 100 + 100));
  }
  assert.equal(zenodo.blocks, 1, 'the burst met the block once');
  assert.ok(told.some(text => /zenodo\.org stopped answering this site.*Asking again in .*what was read is kept/.test(text)), told.join(" | "));
  // While blocked, it is asked about once per back-off (RFC 6298: doubling to 60 s), never by every waiting read.
  const duringBlock = zenodo.times.filter(at => at > zenodo.blockedAt && at < zenodo.blockedUntil).length;
  assert.ok(duringBlock <= 12, `${duringBlock} requests while blocked for 300 s`);
  // The requests of the minute before it (the 20 answered, the one that met
  // it and its retry): a minute now holds at most half of them.
  const paceMs = first.pace(url);
  assert.equal(paceMs, 2 * 60_000 / sentBefore, `paced at ${Math.round(paceMs)} ms a request after ${sentBefore} requests`);
  assert.ok(60_000 / paceMs <= 20 / 2 + 1, 'a minute holds half what the host bears');
  assert.ok(first.requestCostMs(url) >= paceMs, 'readers price a request at its pace');
  assert.equal(rememberedHostPace('https://zenodo.org', storage), paceMs, 'kept per origin for later visits');
  assert.equal(hostLinkSeed('https://zenodo.org', { storage, timeline: null }).paceMs, paceMs);
  // A later visit, once the block has lifted: started at the kept pace.
  await time.sleep(300_000);
  const blocksBefore = zenodo.blocks;
  const later = createHostBook({ now: time.now, after: time.after, epoch: () => EPOCH + time.now() });
  later.seedPace('https://zenodo.org', rememberedHostPace('https://zenodo.org', storage));
  const laterLink = new LinkMeter(REMOTE_POLICY, { clock: time.now, after: time.after });
  const again = httpByteSource({ url, size: bytes.length }, { fetch: zenodo.fetch, hosts: later });
  const from = zenodo.times.length;
  for (let i = 0; i < 40; i++) assert.deepEqual(await again.read(i * 100, 100, { link: laterLink }), bytes.subarray(i * 100, i * 100 + 100));
  assert.equal(zenodo.blocks, blocksBefore, 'no burst that meets the block');
  const times = zenodo.times.slice(from);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= paceMs - 1e-6, `request ${i} sent ${times[i] - times[i - 1]} ms after the one before`);
  // Forgetting the hosts (the Stored dialog) forgets their pace too.
  forgetHostLinks(storage);
  assert.equal(rememberedHostPace('https://zenodo.org', storage), 0);
});

// Round 9, R9P-5: a link that dropped for a few seconds while Suo opened from GitHub Pages
// (requests failing at once: net::ERR_INTERNET_DISCONNECTED) taught theislab.github.io a block
// pace; Suo then grew at 70 KB/s over a fast link ("limits how many requests it answers: the next
// go in 2.4 s"), and the pace was kept for a day.
function droppingLink(time, bytes, { dropAt = 20, dropMs = 5_000, roundTripMs = 100, failAfterMs = 0 } = {}) {
  let downUntil = -Infinity;
  const link = { times: [], drops: 0, isDown: () => time.now() < downUntil };
  link.fetch = async (url, init) => {
    const at = time.now();
    link.times.push(at);
    if (link.times.length === dropAt + 1) { downUntil = at + dropMs; link.upAt = downUntil; link.drops++; }
    if (at < downUntil) {
      // This side's link is down: the request never leaves (or never reaches the host).
      await time.sleep(failAfterMs);
      throw new TypeError('Failed to fetch');
    }
    await time.sleep(roundTripMs);
    return ranged(bytes, init);
  };
  return link;
}

test('requests lost on this side of the link (an instant failure, or this computer offline) teach the host no pace', async () => {
  const bytes = pattern(100_000);
  const url = 'https://theislab.github.io/cellucid-datasets/anndata/suo.zarr/obsm/X_umap_3d/0.0';
  for (const [name, options, offlineWhileDown] of [
    ['failing at once', { failAfterMs: 0 }, false],
    ['failing within half the quickest answer', { failAfterMs: 40 }, false],
    ['this computer offline (failing slowly)', { failAfterMs: 150 }, true],
  ]) {
    const time = virtualTime();
    const link = droppingLink(time, bytes, options);
    const online = offlineWhileDown ? () => !link.isDown() : () => true;
    const book = createHostBook({ now: time.now, after: time.after, epoch: () => EPOCH + time.now(), online });
    const learnt = [];
    book.watchPace((origin, paceMs) => learnt.push(paceMs));
    const meter = new LinkMeter(REMOTE_POLICY, { clock: time.now, after: time.after });
    const source = httpByteSource({ url, size: bytes.length }, { fetch: link.fetch, hosts: book });
    for (let i = 0; i < 60; i++) {
      assert.deepEqual(await source.read(i * 100, 100, { link: meter }), bytes.subarray(i * 100, i * 100 + 100), `${name}: read ${i}`);
    }
    assert.equal(link.drops, 1, `${name}: the link dropped`);
    assert.deepEqual(learnt, [], `${name}: no pace is learnt`);
    assert.equal(book.pace(url), 0, `${name}: requests are not spaced once the link is back`);
  }
});

// Round 9, R9P-7: after an 18 s outage (this computer offline), Suo's opening waited up to 20 s
// more before asking again: the read's back-off and the address's quiet were a host's, and the
// read said the host "may be refusing requests from this network".
test('a read that loses requests while this computer is offline waits for the connection, says so, and asks again the moment it is back', async () => {
  const time = virtualTime();
  const bytes = pattern(100_000);
  const url = 'https://theislab.github.io/cellucid-datasets/anndata/suo.zarr/obsm/X_umap_3d/0.0';
  const link = droppingLink(time, bytes, { dropAt: 10, dropMs: 18_000, failAfterMs: 0 });
  const online = () => !link.isDown();
  const book = createHostBook({ now: time.now, after: time.after, epoch: () => EPOCH + time.now(), online });
  const meter = new LinkMeter(REMOTE_POLICY, { clock: time.now, after: time.after });
  const source = httpByteSource({ url, size: bytes.length }, { fetch: link.fetch, hosts: book });
  const told = [];
  let backAt = null;
  for (let i = 0; i < 30; i++) {
    const read = await source.read(i * 100, 100, { link: meter, onWait: wait => { if (wait !== null) told.push(wait.text); } });
    assert.deepEqual(read, bytes.subarray(i * 100, i * 100 + 100), `read ${i}`);
    if (backAt === null && link.drops === 1 && !link.isDown()) backAt = time.now();
  }
  assert.equal(link.drops, 1);
  assert.ok(told.some(text => /This computer is offline: reading goes on as soon as it is back/.test(text)), told.join(' | '));
  assert.ok(!told.some(text => /refusing requests/.test(text)), `said as a refusal: ${told.join(' | ')}`);
  // The first read after the outage went out within a poll of the connection's return.
  const firstAfter = link.times.find(at => at >= link.upAt);
  assert.ok(firstAfter - link.upAt <= 1_000, `asked ${firstAfter - link.upAt} ms after the connection was back`);
  assert.equal(book.pace(url), 0);
});
