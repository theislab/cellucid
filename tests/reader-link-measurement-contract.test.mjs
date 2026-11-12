/**
 * What the reader reports about the link a dataset is read over, for the
 * work that tunes itself to it: `{latencyMs, bytesPerMs,
 * backgroundConcurrency, protocol}` posted by the reader worker whenever it
 * changes and kept by the client (`linkMeasurement()`), null before the first
 * measurement; a local file has no round trip (latency 0) and reports how
 * fast its chunks decode, which the decode pool measures
 * (`decodePoolStats().decodedBytesPerMs`).
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { AnnDataReaderClient } from '../assets/js/data/anndata-reader-client.js';
import { linkMeasurementOf } from '../assets/js/data/anndata-reader-worker.js';
import { decodeChunkBytes, decodePoolStats } from '../assets/js/formats/io/decode-pool.js';
import { LinkMeter, READ_AHEAD_BYTES_PER_MS, RECENT_REQUESTS, loadedRoundTripMs } from '../assets/js/formats/io/link.js';
import { pricingLink } from '../assets/js/data/host-link-memory.js';
import { linkReadMs } from '../assets/js/data/anndata/subsample-plan.js';
import { LOCAL_POLICY, REMOTE_POLICY } from '../assets/js/formats/io/byte-source.js';
import { until } from './helpers/until.mjs';

test('the decode pool measures decoded bytes per millisecond', async () => {
  await decodeChunkBytes({
    kind: 'zarr',
    description: {},
    input: new Uint8Array(4),
    size: 1 << 20,
    revive: data => new Error(data.message),
    inThread: () => new Promise(resolve => setTimeout(() => resolve(new Uint8Array(1 << 20)), 5)),
  });
  const rate = decodePoolStats().decodedBytesPerMs;
  assert.ok(Number.isFinite(rate) && rate > 0, `a measured rate, got ${rate}`);
});

test('a remote link is reported as measured, and not before', () => {
  let now = 0;
  const link = new LinkMeter(REMOTE_POLICY, { clock: () => now });
  const source = { file: { url: 'https://host.test/a.h5ad' } };
  assert.equal(linkMeasurementOf(source, link), null);
  const started = link.begin();
  now = 120;
  link.end(started, 60_000);
  assert.deepEqual(linkMeasurementOf(source, link), {
    latencyMs: 120,
    // No round trip under load yet: the one request set up its connection.
    loadedLatencyMs: null,
    bytesPerMs: 500,
    backgroundConcurrency: 5,
    protocol: null,
    // What the measurement rests on (`host-link-memory.js` weighs it).
    deliveredBytes: 60_000,
    // The time a request was in flight: the rate it sustained rests on it.
    busyMs: 120,
  });
  // A request on the connection now open: its round trip under load.
  const again = link.begin();
  now = 220;
  link.end(again, 100);
  assert.equal(linkMeasurementOf(source, link).loadedLatencyMs, 100);
});

test('a read is priced at the link\'s round trip under load, not its shortest; large reads sharing the bandwidth do not lengthen it', () => {
  // S3 us-west-2 from Europe: the shortest request 230 ms, a small request
  // 0.35-0.5 s with 42 in flight. Priced at the shortest, an .h5ad export of
  // 21,285 cells said 198 s and took 271-386 s (`linkReadMs`). The object
  // on its seven S3 addresses: 42 connections, every request on one.
  let now = 0;
  const link = new LinkMeter({ ...REMOTE_POLICY, concurrency: 42 }, { clock: () => now });
  // A first read measures the round trip and a rate (3 MB/s).
  const at = link.begin();
  now = 230;
  link.end(at, 690_000);
  assert.equal(link.latencyMs, 230);
  // Under load: 41 small requests in flight together, each 400-460 ms.
  const begun = Array.from({ length: 41 }, () => link.begin());
  begun.forEach((started, i) => {
    now = started + 400 + (i % 7) * 10;
    link.end(started, 2_000);
  });
  // The link now answers no request in less than 400 ms: its round trip now
  // (the shortest of the latest requests) follows, as the median does.
  assert.equal(link.latencyMs, 400, 'the round trip follows the link as it is now');
  assert.ok(link.loadedLatencyMs >= 400 && link.loadedLatencyMs <= 460, `under load ${link.loadedLatencyMs} ms`);
  assert.equal(loadedRoundTripMs(link.snapshot()), link.loadedLatencyMs);
  const priced = { bytes: 0, requests: 4_200 };
  const snapshot = link.snapshot();
  const shortest = linkReadMs(priced, { ...snapshot, loadedLatencyMs: null });
  assert.ok(linkReadMs(priced, snapshot) >= 1.7 * linkReadMs(priced, { ...snapshot, latencyMs: 230, loadedLatencyMs: null }), 'priced at the round trip under load');
  assert.ok(linkReadMs(priced, snapshot) >= shortest);
  // The load gone, the first request answered in 230 ms is the round trip again.
  const idle = link.begin();
  now += 230;
  link.end(idle, 2_000);
  assert.equal(link.latencyMs, 230);
  // Large reads that share the bandwidth (each waits for the bytes before
  // it) are priced by their bytes, not as longer round trips.
  const bulk = new LinkMeter(REMOTE_POLICY, { clock: () => now });
  const first = bulk.begin();
  now += 120;
  bulk.end(first, 600_000);
  const rate = bulk.bytesPerMs;
  const together = Array.from({ length: 6 }, () => bulk.begin());
  const start = now;
  together.forEach((started, i) => {
    now = start + 120 + (i + 1) * 600_000 / rate;
    bulk.end(started, 600_000);
  });
  assert.ok(bulk.loadedLatencyMs <= 1.5 * bulk.latencyMs, `bandwidth-bound reads: ${bulk.loadedLatencyMs} ms against ${bulk.latencyMs}`);
});

/**
 * `n` requests of `bytes` each asked together at `now` over a link of round
 * trip `rtt` ms and `rate` bytes a millisecond shared by them (each request's
 * last byte after the round trip and every byte asked before it): returns
 * when the last ended.
 */
function wave(meter, now, { n, bytes, rtt, rate }, clock) {
  const begun = Array.from({ length: n }, () => meter.begin());
  begun.forEach((started, i) => {
    clock.now = now + rtt + (i + 1) * bytes / rate;
    meter.end(started, bytes);
  });
  return clock.now;
}

test('the link is measured as it is now: a slower or faster connection is followed within a window of requests, one odd request moves nothing', () => {
  const clock = { now: 0 };
  const meter = new LinkMeter(REMOTE_POLICY, { clock: () => clock.now });
  const fast = { rtt: 20, rate: 100_000 };
  const slow = { rtt: 300, rate: 1_000 };
  // Fast: small requests (round trips) and full waves of large ones.
  let now = 0;
  for (let w = 0; w < 4; w++) {
    now = wave(meter, now, { n: 6, bytes: 2_000, ...fast }, clock);
    now = wave(meter, now, { n: 6, bytes: 4_000_000, ...fast }, clock);
  }
  assert.ok(meter.latencyMs >= 20 && meter.latencyMs < 25, `fast round trip ${meter.latencyMs}`);
  assert.ok(meter.bytesPerMs > 0.8 * fast.rate && meter.bytesPerMs <= 1.01 * fast.rate, `fast bandwidth ${meter.bytesPerMs}`);
  assert.equal(meter.readsAhead, fast.rate >= READ_AHEAD_BYTES_PER_MS);
  assert.equal(meter.bandwidthMeasured, true);
  const fastGap = meter.mergeGapBytes;
  const fastRequest = meter.maxRequestBytes;
  // One odd slow request (a stall of 5 s) moves neither the round trip nor the bandwidth.
  const odd = meter.begin();
  clock.now = now += 5_000;
  meter.end(odd, 2_000);
  assert.ok(meter.latencyMs < 25 && meter.bytesPerMs > 0.8 * fast.rate, 'one stall moves nothing');
  // The connection gets slow: within a window of requests the link is the slow one.
  for (let w = 0; w < RECENT_REQUESTS; w++) {
    now = wave(meter, now, { n: 2, bytes: 1_000, ...slow }, clock);
    now = wave(meter, now, { n: 2, bytes: 400_000, ...slow }, clock);
  }
  assert.ok(meter.latencyMs >= slow.rtt, `slow round trip ${meter.latencyMs}`);
  assert.ok(meter.bytesPerMs <= 1.2 * slow.rate, `slow bandwidth ${meter.bytesPerMs}`);
  assert.equal(meter.readsAhead, false, 'a slow link is not read ahead');
  assert.ok(meter.mergeGapBytes < fastGap && meter.maxRequestBytes <= fastRequest, 'shaping follows the link');
  assert.ok(loadedRoundTripMs(meter.snapshot()) >= slow.rtt, 'reads are priced at the slow round trip');
  // Small requests alone (a subsample's kept rows) do not take a slow
  // bandwidth for the link's: their deliveries are lower bounds only.
  const before = meter.bytesPerMs;
  for (let w = 0; w < RECENT_REQUESTS; w++) now = wave(meter, now, { n: 1, bytes: 100, ...slow }, clock);
  assert.equal(meter.bytesPerMs, before, 'lower bounds never lower the bandwidth');
  // Fast again: the first fast round trip is the round trip, and a full wave the bandwidth.
  now = wave(meter, now, { n: 1, bytes: 2_000, ...fast }, clock);
  assert.ok(meter.latencyMs < 25, `fast again ${meter.latencyMs}`);
  now = wave(meter, now, { n: 6, bytes: 4_000_000, ...fast }, clock);
  assert.ok(meter.bytesPerMs > 0.8 * fast.rate, `fast bandwidth again ${meter.bytesPerMs}`);
  assert.ok(Math.abs(meter.mergeGapBytes - fastGap) <= 0.01 * fastGap, `merge gap ${meter.mergeGapBytes} against ${fastGap}`);
});

test('a local file\'s snapshot carries the bandwidth its reads are priced at: never below its prior\'s, its small reads being a lower bound; a web host\'s as measured', () => {
  let now = 0;
  const local = new LinkMeter(LOCAL_POLICY, { clock: () => now });
  const web = new LinkMeter(REMOTE_POLICY, { clock: () => now });
  // A few hundred bytes a read, each mostly the reader's own fixed cost.
  for (let i = 0; i < 8; i++) {
    for (const meter of [local, web]) {
      const started = meter.begin();
      now += 2;
      meter.end(started, 400);
    }
  }
  assert.ok(local.bytesPerMs > 0 && local.bytesPerMs < LOCAL_POLICY.bytesPerMs, `measured a lower bound (${local.bytesPerMs})`);
  const snapshot = local.snapshot();
  assert.equal(snapshot.bytesPerMs, LOCAL_POLICY.bytesPerMs, 'priced at the prior, as its merge gap and round trip are');
  assert.equal(snapshot.roundTripBytes, snapshot.bytesPerMs * snapshot.latencyMs, 'the snapshot prices one rate throughout');
  assert.equal(snapshot.readsAhead, true);
  // Priced at it, every cell's read is the reads' bytes over a disk, not over the opening's reads.
  const read = { bytes: 600e6, requests: 300 };
  assert.ok(linkReadMs(read, snapshot) < linkReadMs(read, { ...snapshot, bytesPerMs: local.bytesPerMs }) / 100);
  // A web host is priced as measured (`host-link-memory.js` lifts one on this machine).
  assert.equal(web.snapshot().bytesPerMs, web.bytesPerMs);
  assert.equal(web.snapshot().readsAhead, false);
});

test('a remembered host link seeds the first guess only: the visit\'s own measurement replaces it once it fills the link', () => {
  const clock = { now: 0 };
  const meter = new LinkMeter(REMOTE_POLICY, { clock: () => clock.now });
  // Remembered: a fast day on this host (same round trip, 50x the rate), resting on a long read.
  const remembered = { latencyMs: 300, loadedLatencyMs: 320, bytesPerMs: 50_000, evidenceBytes: 5e9 };
  let now = wave(meter, 0, { n: 1, bytes: 1_000, rtt: 300, rate: 1_000 }, clock);
  now = wave(meter, now, { n: 2, bytes: 1_000, rtt: 300, rate: 1_000 }, clock);
  // Only round trips measured yet: the record's rate stands.
  assert.equal(pricingLink(meter.snapshot(), remembered).remembered, true);
  // One wave that fills the link: today's slow rate is the price, not the record's.
  now = wave(meter, now, { n: 6, bytes: 600_000, rtt: 300, rate: 1_000 }, clock);
  const priced = pricingLink(meter.snapshot(), remembered);
  assert.equal(priced.remembered, undefined);
  assert.ok(priced.bytesPerMs <= 1_200, `priced at ${priced.bytesPerMs} bytes/ms`);
});

test('a file on seven addresses (six connections each) is measured at its round trip: time waiting for a connection is no round trip, and the host is not taken to multiplex', () => {
  // A public S3 object: its own host and six mirrors, HTTP/1.1, 235 ms.
  // Requests dispatched at the streams (100) wait in the browser for one of
  // the 42 connections; measured from dispatch, they looked like 0.6-1.3 s
  // round trips and a multiplexing host (Genes read for at 100% priced ~10x).
  let now = 0;
  const meter = new LinkMeter({ ...REMOTE_POLICY, concurrency: 6 * 7 }, { clock: () => now });
  const slots = new Array(42).fill(0);
  for (let wave = 0; wave < 6; wave++) {
    const n = meter.admitted;
    const begun = Array.from({ length: n }, () => meter.begin());
    const ends = begun.map((started, i) => {
      const slot = i % 42;
      slots[slot] = Math.max(slots[slot], started) + 235;
      return [slots[slot], i];
    }).sort((a, b) => a[0] - b[0]);
    for (const [at, i] of ends) {
      now = at;
      meter.end(begun[i], 20_000);
    }
  }
  assert.equal(meter.latencyMs, 235);
  assert.equal(meter.loadedLatencyMs, 235);
  assert.equal(meter.multiplexed, false, 'seven addresses of six connections each are not one multiplexing host');
  assert.equal(meter.concurrency, 42);
  // Priced as rounds of 42 requests a round trip each, not as 100 slow ones.
  const snapshot = meter.snapshot();
  assert.equal(linkReadMs({ bytes: 0, requests: 420 }, snapshot), 10 * 235);
});

test('the client keeps the latest measurement of a local file: no round trip, its decode rate', async t => {
  const name = 'data-mapping-full.zarr.zip';
  const file = new File([await readFile(new URL(`./browser/fixtures/${name}`, import.meta.url))], name);
  const client = new AnnDataReaderClient();
  t.after(() => client.close());
  assert.equal(client.linkMeasurement(), null);
  await client.open({ file });
  await client.readEmbedding('X_pca', [0, 1], true);
  // The measurement comes from the worker as its messages do, after the read.
  await until(() => client.linkMeasurement() !== null, 'measured once chunks decoded');
  const measurement = client.linkMeasurement();
  assert.equal(measurement.latencyMs, 0);
  assert.ok(measurement.bytesPerMs > 0);
  assert.equal(measurement.protocol, null);
});

test('the var field loader reaches the open dataset\'s measurement through its adapter, else null', async t => {
  const { createVarFieldLoader } = await import('../assets/js/data/data-loaders.js');
  const { AnnDataFileSource } = await import('../assets/js/data/anndata-file-source.js');
  // No dataset is open at that address.
  assert.equal(createVarFieldLoader('anndata://nothing-open/var').linkMeasurement(), null);
  const name = 'data-mapping-full.zarr.zip';
  const file = new File([await readFile(new URL(`./browser/fixtures/${name}`, import.meta.url))], name);
  const source = new AnnDataFileSource();
  t.after(() => source.clear());
  const { getNotificationCenter } = await import('../assets/js/app/notification-center.js');
  const notifications = getNotificationCenter();
  const info = notifications.info;
  notifications.info = () => 'info';
  t.after(() => {
    notifications.info = info;
  });
  await source.loadFile(file, {});
  await until(() => source.getAdapter().linkMeasurement() !== null, 'the open dataset measured');
  const measurement = source.getAdapter().linkMeasurement();
  assert.ok(measurement !== null && measurement.latencyMs === 0 && measurement.bytesPerMs > 0);
});

test('connection setup is no part of the round trip under load, and a host that completes only so many requests a second prices each at its rate', () => {
  // CELLxGENE's S3 mirrors from Europe, as an export measured them: 42
  // connections, 365 ms a small request once they are open, the first
  // requests 883 ms (each also set up its connection).
  let now = 0;
  const link = new LinkMeter({ ...REMOTE_POLICY, concurrency: 42 }, { clock: () => now });
  // One of them a large read: the bandwidth (4 MB/s) is known, and a small
  // request's bytes take no time worth counting.
  const cold = Array.from({ length: 42 }, () => link.begin());
  now = 883;
  cold.forEach((started, i) => link.end(started, i === 0 ? 3_500_000 : 200));
  assert.equal(link.snapshot().loadedLatencyMs, null, 'every request so far set up its connection');
  const warm = Array.from({ length: 42 }, () => link.begin());
  now += 365;
  for (const started of warm) link.end(started, 200);
  assert.ok(Math.abs(link.loadedLatencyMs - 365) < 1, `round trip under load ${link.loadedLatencyMs} ms, from requests on open connections`);
  // Every slot busy, the host completes 70 small requests a second whatever
  // the connections: each ends 1000 / 70 ms after the one before.
  const roundTripShare = link.latencyMs / link.shapingConcurrency;
  const slots = [];
  for (let i = 0; i < 42; i++) slots.push(link.begin());
  // Reads wait for a slot all along (the scheduler says so).
  link.waiting(100);
  for (let i = 0; i < 200; i++) {
    now += 1000 / 70;
    link.end(slots.shift(), 200);
    slots.push(link.begin());
  }
  assert.ok(Math.abs(link.loadedRequestMs - 1000 / 70) < 1, `a request under load costs ${link.loadedRequestMs} ms`);
  assert.ok(link.requestMs >= 1000 / 70 - 1 && link.requestMs > roundTripShare, `priced ${link.requestMs} ms, not the round trip's share (${roundTripShare} ms)`);
  assert.equal(link.snapshot().requestCostMs, link.requestCostMs);
  // A merge gap is priced at that rate: what one more request costs in bytes.
  assert.ok(link.mergeGapBytes >= Math.floor(link.bytesPerMs * (1000 / 70 - 1)));
  // A break in the load (nothing waiting) starts the window again: the rate rests on load only.
  link.waiting(0);
  for (const started of slots) link.end(started, 200);
  assert.equal(link.loadedRequestMs, 0);
  // Reads one after another (a slot always free for the next, nothing
  // waiting) time their own pauses, never the host's rate.
  for (let i = 0; i < 40; i++) {
    const started = link.begin();
    now += 500;
    link.end(started, 200);
  }
  assert.equal(link.loadedRequestMs, 0);
});

test('on a host whose throughput is per connection, a plan\'s long requests are split so every connection works, and it ends sooner', async () => {
  const { requestPieceBytes } = await import('../assets/js/formats/io/byte-reader.js');
  // Amazon S3 as seen from a page: 42 connections (its host and six mirrors,
  // six each), 250 ms round trips, each connection 0.5 MB/s (500 bytes a ms).
  const RTT = 250;
  const PER_CONNECTION = 500;
  let now = 0;
  const meter = new LinkMeter({ ...REMOTE_POLICY, concurrency: 42 }, { clock: () => now });
  const request = bytes => {
    const token = meter.begin();
    now += RTT + bytes / PER_CONNECTION;
    meter.end(token, bytes);
  };
  for (let i = 0; i < 16; i++) request(1_000);
  // Every connection at once: together they deliver 42 times one's rate,
  // which is how the link shows that one connection carries only part of it.
  const together = [];
  for (let i = 0; i < 42; i++) together.push(meter.begin());
  now += RTT + 1_000_000 / PER_CONNECTION;
  for (const token of together) meter.end(token, 1_000_000);
  for (let i = 0; i < 16; i++) request(1_000_000);
  assert.ok(Math.abs(meter.connectionBytesPerMs - PER_CONNECTION) / PER_CONNECTION < 0.2, `one connection measured at ${meter.connectionBytesPerMs} bytes a ms`);
  assert.ok(meter.connectionRoundTripBytes > 0);
  // A slab of edges: three contiguous ranges, 15 MB in all.
  const plan = [{ start: 0, end: 5e6 }, { start: 6e6, end: 11e6 }, { start: 12e6, end: 17e6 }];
  const piece = requestPieceBytes(plan, meter, 16 * 1024);
  assert.ok(piece < meter.maxRequestBytes, `split below the link's ${meter.maxRequestBytes}: ${piece}`);
  assert.ok(piece >= meter.connectionRoundTripBytes && piece >= meter.mergeGapBytes, 'never shorter than a connection\'s round trip of bytes or a request\'s cost');
  // The plan's time over 42 connections, each request a round trip and its bytes at one connection's rate.
  const timeOf = size => {
    const pieces = plan.flatMap(({ start, end }) => Array.from({ length: Math.ceil((end - start) / size) }, (_, i) => Math.min(size, end - start - i * size)));
    const slots = new Array(42).fill(0);
    for (const bytes of pieces) {
      const slot = slots.indexOf(Math.min(...slots));
      slots[slot] += RTT + bytes / PER_CONNECTION;
    }
    return { ms: Math.max(...slots), requests: pieces.length };
  };
  const before = timeOf(meter.maxRequestBytes);
  const after = timeOf(piece);
  assert.ok(after.requests <= 2 * 42, `${after.requests} requests, about one a connection`);
  assert.ok(after.ms * 4 < before.ms, `${after.ms} ms split, ${before.ms} ms in requests of ${meter.maxRequestBytes} bytes`);
  // A source read ahead (a disk), or a link not measured, keeps the link's size.
  const fresh = new LinkMeter({ ...REMOTE_POLICY, concurrency: 42 }, { clock: () => 0 });
  assert.equal(requestPieceBytes(plan, fresh, 16 * 1024), fresh.maxRequestBytes);
});

test('one fast delivery never makes a link split its plans: a connection is weighed against deliveries the link showed again and again', async () => {
  const { requestPieceBytes } = await import('../assets/js/formats/io/byte-reader.js');
  // A local web host: one connection carries the link (200,000 bytes a ms), 2 ms round trips.
  const RTT = 2;
  const RATE = 200_000;
  let now = 0;
  const meter = new LinkMeter({ ...REMOTE_POLICY, concurrency: 6 }, { clock: () => now });
  const lone = bytes => {
    const token = meter.begin();
    now += RTT + bytes / RATE;
    meter.end(token, bytes);
  };
  for (let i = 0; i < 16; i++) lone(1_000);
  for (let i = 0; i < 16; i++) lone(4_000_000);
  const plan = [{ start: 0, end: 8e6 }];
  assert.equal(requestPieceBytes(plan, meter, 16 * 1024), meter.maxRequestBytes, 'a connection carries the link: not split');
  // Two requests together whose ends are timed short (bytes a cache had, a
  // stretch little longer than the clock's tick): deliveries of any rate.
  const a = meter.begin();
  const b = meter.begin();
  now += 3 * RTT;
  meter.end(a, 40_000_000);
  now += 1;
  meter.end(b, 1_000_000);
  for (let i = 0; i < 16; i++) lone(4_000_000);
  assert.equal(meter.connectionRoundTripBytes, null, 'two ends are no evidence of a link faster than a connection');
  assert.equal(requestPieceBytes(plan, meter, 16 * 1024), meter.maxRequestBytes, 'plans stay whole');
  // (A link that carries more than a connection shows it at every end of its
  // requests together, and its plans are split: the per-connection host above.)
});

test('on a link its requests share, a request\'s delivery is never taken for a connection\'s: plans are not split finer and finer', async () => {
  const { requestPieceBytes } = await import('../assets/js/formats/io/byte-reader.js');
  // One HTTP/2 connection of 30 MB/s (30,000 bytes a ms), 100 ms round trips:
  // requests in flight share its bandwidth, each delivering 30,000 / k.
  const RTT = 100;
  const LINK = 30_000;
  let now = 0;
  const meter = new LinkMeter({ ...REMOTE_POLICY, concurrency: 200, streams: 200 }, { clock: () => now });
  const round = (k, bytes) => {
    const tokens = Array.from({ length: k }, () => meter.begin());
    now += RTT + (k * bytes) / LINK;
    for (const token of tokens) meter.end(token, bytes);
  };
  for (let i = 0; i < 16; i++) round(1, 1_000);
  // A read as a plan split by the rule would make it: more requests each
  // round, every one transfer-bound, every round the link's whole bandwidth.
  const pieces = [];
  for (const k of [7, 14, 28, 56, 112, 200, 200, 200]) {
    round(k, Math.round(8e6 / k));
    pieces.push([requestPieceBytes([{ start: 0, end: 8e6 }], meter, 16 * 1024), meter.maxRequestBytes]);
  }
  assert.equal(meter.connectionBytesPerMs, 0, 'no request measured one connection: the link held them back');
  assert.equal(meter.connectionRoundTripBytes, null);
  for (const [piece, max] of pieces) assert.equal(piece, max, `a plan kept in requests of the link's size (${max}), not split to ${piece} bytes`);
  // The bandwidth is still measured from the same deliveries (the link's, together).
  assert.ok(Math.abs(meter.bytesPerMs - LINK) / LINK < 0.25, `link measured at ${meter.bytesPerMs} bytes a ms`);
});

test('a round trip is worth the same bytes to every read price: measured, else a merge gap per connection that runs at once, never per stream', async () => {
  const { roundTripBytesOf } = await import('../assets/js/formats/io/link.js');
  // A web host not measured yet: dispatched at 100 streams, six HTTP/1.1 connections run.
  const fresh = new LinkMeter(REMOTE_POLICY, { clock: () => 0 });
  assert.equal(fresh.roundTripBytes, null);
  assert.ok(fresh.concurrency > fresh.shapingConcurrency, 'requests dispatched past the connections that run them');
  assert.equal(roundTripBytesOf(fresh), REMOTE_POLICY.mergeGapBytes * fresh.shapingConcurrency);
  assert.equal(roundTripBytesOf(fresh.snapshot()), roundTripBytesOf(fresh), 'its snapshot prices the same');
  // Costs of the same names (the gene index's), and no link at all.
  assert.equal(roundTripBytesOf({ mergeGapBytes: 1000, roundTripBytes: null, shapingConcurrency: 6 }), 6000);
  assert.equal(roundTripBytesOf(null), 0);
  // Measured: bandwidth x latency, whatever the concurrency.
  let now = 0;
  const meter = new LinkMeter({ ...REMOTE_POLICY, concurrency: 6 }, { clock: () => now });
  for (let i = 0; i < 20; i++) {
    const token = meter.begin();
    now += 100 + 400_000 / 2000;
    meter.end(token, 400_000);
  }
  assert.ok(meter.measured);
  assert.equal(roundTripBytesOf(meter), meter.roundTripBytes);
});
