/**
 * What each host delivered on earlier visits (`assets/js/data/host-link-memory.js`):
 * an opening's sizing starts from it while its own reads rest on fewer
 * bytes, never below its own rate, scaled down on a longer round trip;
 * records hold an origin and numbers only, fade, are bounded and clearable.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOST_LINK_RECORDS,
  HOST_LINK_STORAGE_KEY,
  forgetHostLinks,
  hostLinkSeed,
  hostOf,
  onThisMachine,
  pricingLink,
  rememberHostLink,
  rememberedHostLink,
  rememberedHosts,
} from '../assets/js/data/host-link-memory.js';

function memoryStorage() {
  const items = new Map();
  return {
    getItem: key => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: key => items.delete(key),
    raw: () => items.get(HOST_LINK_STORAGE_KEY) ?? null,
  };
}

const HLCA = { latencyMs: 244, warmLatencyMs: 244, bytesPerMs: 640, deliveredBytes: 5e6, measured: true };

test('a host is its origin only: never a path, a dataset, a query or a token', () => {
  assert.equal(hostOf({ file: { url: 'https://datasets.cellxgene.cziscience.com/cell-census/2025-11-10/h5ads/x.h5ad?token=SECRET' } }), 'https://datasets.cellxgene.cziscience.com');
  assert.equal(hostOf({ url: 'http://localhost:8765/datasets/a.zarr/' }), 'http://localhost:8765');
  assert.equal(hostOf({ file: new Blob([]) }), null, 'a file on this computer');
  const storage = memoryStorage();
  rememberHostLink(hostOf({ file: { url: 'https://host.test/private/lab.h5ad?X-Amz-Signature=SECRET' } }), { latencyMs: 50, bytesPerMs: 2000, deliveredBytes: 1e7, busyMs: 5000 }, storage);
  assert.ok(!/private|lab\.h5ad|SECRET/.test(storage.raw()), storage.raw());
  assert.deepEqual(rememberedHosts(storage).map(host => host.origin), ['https://host.test']);
});

test('the opening prices at what the host delivered before, until its own reads rest on as many bytes', () => {
  const remembered = { latencyMs: 240, bytesPerMs: 2500, evidenceBytes: 8e7 };
  const priced = pricingLink(HLCA, remembered);
  assert.equal(priced.bytesPerMs, 2500 * (240 / 244), 'scaled by the two round trips');
  assert.equal(priced.remembered, true);
  // Never below the opening's own rate.
  assert.equal(pricingLink({ ...HLCA, bytesPerMs: 4000 }, remembered).bytesPerMs, 4000);
  // A longer round trip (another network) scales the record down.
  assert.equal(pricingLink({ ...HLCA, latencyMs: 480, warmLatencyMs: 480 }, remembered).bytesPerMs, 2500 * (240 / 480));
  assert.equal(pricingLink({ ...HLCA, latencyMs: 960, warmLatencyMs: 960 }, remembered).bytesPerMs, 640, 'scaled below the opening\'s own rate: its own');
  // Round trips are compared like with like: a revisit whose requests so far
  // all opened connections (GEO: one HEAD and one GET, 376 ms with set-up)
  // has measured no round trip yet, and the remembered rate stands.
  const cold = pricingLink({ ...HLCA, latencyMs: 376, warmLatencyMs: null }, remembered);
  assert.equal(cold.bytesPerMs, 2500, 'not scaled by a cold round trip');
  assert.equal(cold.latencyMs, 240);
  // Once the opening has read as much as the record rests on: its own.
  assert.equal(pricingLink({ ...HLCA, deliveredBytes: 9e7 }, remembered).bytesPerMs, 640);
  assert.equal(pricingLink(HLCA, null), HLCA);
  assert.equal(pricingLink(null, remembered), null);
});

test('a source on this machine (a loopback host, a local file) is priced as this machine at rest whatever its link measured; a notebook kernel or a host across a network as measured', async () => {
  const { LOCAL_POLICY } = await import('../assets/js/formats/io/byte-source.js');
  const { EMBEDDED_HOST_ORIGIN } = await import('../assets/js/formats/io/host-fetch.js');
  // Loopback addresses: `cellucid serve`, Python's and R's served stores, a web server run here.
  for (const origin of ['http://127.0.0.1:8765', 'http://127.4.0.9:80', 'http://localhost:8000', 'http://viewer.localhost:3000', 'http://[::1]:9000']) {
    assert.equal(onThisMachine(origin), true, origin);
    assert.equal(onThisMachine(hostOf({ url: `${origin}/datasets/a.zarr/` })), true, `${origin}, as an opening names it`);
  }
  for (const origin of ['https://s3.us-west-2.amazonaws.com', 'http://127.0.0.1.example.org', 'http://10.0.0.5:8765', EMBEDDED_HOST_ORIGIN, null, 'not a url']) {
    assert.equal(onThisMachine(origin), false, String(origin));
  }
  const seed = origin => hostLinkSeed(origin, { storage: null, timeline: null });
  assert.equal(seed('http://127.0.0.1:8765').thisMachine, true);
  assert.equal(seed('https://s3.us-west-2.amazonaws.com').thisMachine, false);
  assert.equal(seed(EMBEDDED_HOST_ORIGIN).thisMachine, false, 'a kernel may run across the internet (Colab, a JupyterHub)');
  // A 10M-cell store on a loopback host (Chromium): its opening's 0.9 MB of
  // metadata reads measured 45 MB/s, none of them keeping the link full.
  const opening = { measured: true, latencyMs: 3.35, loadedLatencyMs: 4.85, warmLatencyMs: 2.65, bytesPerMs: 45_003, bandwidthMeasured: false, deliveredBytes: 901_120, busyMs: 33.1, mergeGapBytes: 25_126, roundTripBytes: 150_761 };
  const local = pricingLink(opening, seed('http://127.0.0.1:8765'));
  assert.equal(local.bytesPerMs, LOCAL_POLICY.bytesPerMs, 'a disk\'s rate, as a local file\'s link is priced');
  assert.equal(local.thisMachine, true);
  assert.equal(local.measured, true);
  assert.equal(local.latencyMs, opening.latencyMs, 'its shortest round trip as measured');
  assert.equal(local.loadedLatencyMs, opening.latencyMs, 'its round trip under load priced at the shortest');
  assert.equal(local.mergeGapBytes, opening.mergeGapBytes, 'what the meter derives stays its own');
  // Measured with a delivery that kept the link full: still a disk. On this
  // machine such a delivery is slowed by the machine's own load (another
  // browser starting, a run ending beside it), not by a network: a 10M-cell
  // store's opening right after another run measured a fraction of the
  // link, and its first gene was read for a sample (5 of about 40 runs).
  const full = pricingLink({ ...opening, bandwidthMeasured: true }, seed('http://127.0.0.1:8765'));
  assert.equal(full.bytesPerMs, LOCAL_POLICY.bytesPerMs);
  assert.equal(full.thisMachine, true);
  // Requests that waited on the busy machine (a round trip under load of
  // 863 ms measured where 1.5-7 ms is usual; a time a request under load):
  // priced at the shortest round trip, no time a request beyond it.
  const waited = pricingLink({ ...opening, bytesPerMs: 2e6, loadedLatencyMs: 863, requestCostMs: 40, loadedRequestMs: 40 }, seed('http://127.0.0.1:8765'));
  assert.equal(waited.bytesPerMs, 2e6, 'a rate past a disk\'s as measured');
  assert.equal(waited.loadedLatencyMs, opening.latencyMs);
  assert.equal(waited.requestCostMs, 0);
  assert.equal(waited.thisMachine, true);
  // A local file (its snapshot says so: its prior is a disk), with no seed: the same.
  const file = pricingLink({ ...opening, onThisMachine: true, bytesPerMs: 13_000, bandwidthMeasured: true, loadedLatencyMs: 863, requestCostMs: 40 }, null);
  assert.deepEqual([file.bytesPerMs, file.loadedLatencyMs, file.requestCostMs, file.thisMachine], [LOCAL_POLICY.bytesPerMs, opening.latencyMs, 0, true]);
  const { LinkMeter } = await import('../assets/js/formats/io/link.js');
  const { REMOTE_POLICY } = await import('../assets/js/formats/io/byte-source.js');
  assert.equal(new LinkMeter(LOCAL_POLICY).snapshot().onThisMachine, true);
  assert.equal(new LinkMeter(REMOTE_POLICY).snapshot().onThisMachine, false);
  // At rest already: as it is.
  const rest = { ...opening, bytesPerMs: 2e6, loadedLatencyMs: opening.latencyMs, requestCostMs: 0 };
  assert.equal(pricingLink(rest, seed('http://127.0.0.1:8765')), rest);
  // Already faster than a disk: as measured.
  assert.equal(pricingLink({ ...opening, bytesPerMs: 2e6 }, seed('http://127.0.0.1:8765')).bytesPerMs, 2e6);
  // Nothing measured yet (a revisit that read only what it kept): still no round trip to price by.
  const unmeasured = pricingLink({ ...opening, measured: false, latencyMs: null, loadedLatencyMs: null, warmLatencyMs: null, bytesPerMs: null, deliveredBytes: 0 }, seed('http://127.0.0.1:8765'));
  assert.equal(unmeasured.measured, false);
  // A host across a network, the same opening: as measured, its round trip under load and all.
  assert.equal(pricingLink(opening, seed('https://s3.us-west-2.amazonaws.com')), opening);
  const busy = { ...opening, bandwidthMeasured: true, loadedLatencyMs: 863, requestCostMs: 40 };
  assert.equal(pricingLink(busy, seed('https://s3.us-west-2.amazonaws.com')), busy);
  assert.equal(pricingLink(opening, seed(EMBEDDED_HOST_ORIGIN)), opening);
  // A remembered record and this machine together: the higher, the record's lift kept.
  const remembered = { ...seed('http://127.0.0.1:8765'), latencyMs: 3, bytesPerMs: 60_000, evidenceBytes: 4e8 };
  const both = pricingLink(opening, remembered);
  assert.equal(both.bytesPerMs, LOCAL_POLICY.bytesPerMs);
  assert.equal(both.remembered, true);
});

test('a revisit prices its first reads at the round trip under load a visit measured, on this path, never below its own', async () => {
  // S3: 230 ms idle, a small request 0.35-0.5 s with 42 in flight. A
  // revisit's opening makes a few requests that barely load the link: its
  // gene sample, Genes read for and an export are priced at the round
  // trip under load the last visit measured (`link.js` `loadedLatencyMs`).
  const { loadedRoundTripMs } = await import('../assets/js/formats/io/link.js');
  const storage = memoryStorage();
  const origin = 'https://s3.test';
  rememberHostLink(origin, { latencyMs: 230, loadedLatencyMs: 430, bytesPerMs: 3000, deliveredBytes: 6e8, busyMs: 2e5 }, storage);
  const remembered = rememberedHostLink(origin, storage);
  assert.equal(remembered.loadedLatencyMs, 430);
  const opening = { latencyMs: 232, warmLatencyMs: 230, loadedLatencyMs: 240, bytesPerMs: 4000, deliveredBytes: 3e5, measured: true };
  const priced = pricingLink(opening, remembered);
  assert.equal(priced.loadedLatencyMs, 430, 'the remembered round trip under load, same path');
  assert.equal(loadedRoundTripMs(priced), 430);
  assert.equal(priced.bytesPerMs, 4000, 'the opening\'s own rate stands (higher than remembered)');
  assert.equal(priced.remembered, true);
  // A longer path scales it as it scales the rate.
  assert.equal(pricingLink({ ...opening, warmLatencyMs: 460 }, remembered).loadedLatencyMs, 430 * 460 / 230);
  // Never below the opening's own, and its own once it rests on as many bytes.
  assert.equal(pricingLink({ ...opening, loadedLatencyMs: 600 }, remembered).loadedLatencyMs, 600);
  assert.equal(pricingLink({ ...opening, deliveredBytes: 7e8 }, remembered).loadedLatencyMs, 240);
  // Blended by bytes like the round trip; a visit that measured none keeps the record's.
  rememberHostLink('https://two.test', { latencyMs: 200, loadedLatencyMs: 400, bytesPerMs: 3000, deliveredBytes: 1e8, busyMs: 1e8 / 3000 }, storage);
  assert.equal(rememberedHostLink('https://two.test', storage).loadedLatencyMs, 400);
  forgetHostLinks(storage);
  rememberHostLink(origin, { latencyMs: 230, bytesPerMs: 3000, deliveredBytes: 1e8, busyMs: 1e8 / 3000 }, storage);
  assert.equal(rememberedHostLink(origin, storage).loadedLatencyMs, null);
});

test('a visit is kept at the rate its reads sustained, never at its fastest moment', () => {
  const storage = memoryStorage();
  // HLCA: its fastest delivery was 6.2 MB/s, its reads sustained 1.6 MB/s.
  rememberHostLink('https://census.test', { latencyMs: 232, bytesPerMs: 6232, deliveredBytes: 98e6, busyMs: 61_250 }, storage);
  assert.equal(rememberedHostLink('https://census.test', storage).bytesPerMs, 98e6 / 61_250);
  // A measurement that says nothing of its busy time is not kept.
  rememberHostLink('https://other.test', { latencyMs: 50, bytesPerMs: 9000, deliveredBytes: 1e6 }, storage);
  assert.equal(rememberedHostLink('https://other.test', storage), null);
});

test('visits are blended by the bytes they rest on, older ones fading; a visit is never counted twice', () => {
  const storage = memoryStorage();
  const origin = 'https://slow.test';
  rememberHostLink(origin, { latencyMs: 200, bytesPerMs: 3000, deliveredBytes: 1e8, busyMs: 1e8 / 3000 }, storage);
  rememberHostLink(origin, { latencyMs: 200, bytesPerMs: 3000, deliveredBytes: 1e8, busyMs: 1e8 / 3000 }, storage);
  assert.equal(rememberedHostLink(origin, storage).evidenceBytes, 1e8, 'the same visit, measured again, replaces its own record');
  // A short visit barely moves a long one's record (each weighed by its bytes).
  forgetHostLinks(storage);
  rememberHostLink(origin, { latencyMs: 200, bytesPerMs: 3000, deliveredBytes: 1e8, busyMs: 1e8 / 3000 }, storage);
  const later = rememberedHostLink(origin, storage);
  assert.equal(later.bytesPerMs, 3000);
});

test('at most HOST_LINK_RECORDS hosts are kept, the least recently measured dropped; forgetting removes them all', () => {
  const storage = memoryStorage();
  for (let i = 0; i < HOST_LINK_RECORDS + 5; i++) {
    rememberHostLink(`https://h${i}.test`, { latencyMs: 10, bytesPerMs: 100, deliveredBytes: 1000, busyMs: 10 }, storage);
  }
  const hosts = rememberedHosts(storage);
  assert.equal(hosts.length, HOST_LINK_RECORDS);
  assert.equal(rememberedHostLink('https://h0.test', storage) === null || hosts.some(host => host.origin === 'https://h0.test'), true);
  forgetHostLinks(storage);
  assert.deepEqual(rememberedHosts(storage), []);
  assert.equal(storage.raw(), null);
});

test('this browser\'s downlink is the fastest of the page\'s own downloads (Resource Timing), never stored, and seeds an opening with the host\'s kept speed and pace', async () => {
  const { pageDownlinkBytesPerMs, hostLinkSeed, rememberHostPace } = await import('../assets/js/data/host-link-memory.js');
  const timeline = {
    getEntriesByType: type => (type === 'navigation'
      ? [{ transferSize: 30_000, duration: 300 }]
      // A script from the network, one from the cache (no transfer), one cross-origin without timing (no size).
      : [{ transferSize: 3_600_000, duration: 900 }, { transferSize: 0, duration: 2 }, { transferSize: 0, duration: 0 }]),
  };
  assert.equal(pageDownlinkBytesPerMs(timeline), 4000);
  assert.equal(pageDownlinkBytesPerMs({ getEntriesByType: () => [] }), null, 'every asset from the cache: nothing measured');
  assert.equal(pageDownlinkBytesPerMs(null), null);
  const memory = new Map();
  const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)), removeItem: key => memory.delete(key) };
  assert.deepEqual(hostLinkSeed('https://h.test', { storage, timeline }), { origin: 'https://h.test', downlinkBytesPerMs: 4000, paceMs: 0, thisMachine: false });
  assert.equal(hostLinkSeed(null, { storage, timeline }), null, 'a file on this computer has no seed');
  rememberHostPace('https://h.test', 900, storage);
  rememberHostPace('https://h.test', 400, storage);
  assert.equal(hostLinkSeed('https://h.test', { storage, timeline }).paceMs, 900, 'a slower pace is never replaced by a faster one');
  rememberHostPace('https://h.test/a/path', 900, storage);
  assert.ok(!memory.get('cellucid:host-pace:v1').includes('/a/path'), 'an origin only, never a path');
  assert.ok(![...memory.keys()].some(key => key.includes('downlink')), 'the downlink is never stored');
});

test('a host\'s kept pace loosens a step a visit after a day without refusals, snaps back at the first refusal, and stays for a host that blocks again', async () => {
  // Each visit is a page of its own: a fresh instance of the module.
  let visits = 0;
  const visit = () => import(`../assets/js/data/host-link-memory.js?visit=${++visits}`);
  const memory = new Map();
  const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)), removeItem: key => memory.delete(key) };
  const origin = 'https://h.test';
  const hour = 60 * 60 * 1000;
  const t0 = 1_800_000_000_000;
  const { rememberHostPace, PACE_RECOVERY_AFTER_MS, PACE_RECOVERY_STEP } = await visit();
  assert.equal(PACE_RECOVERY_AFTER_MS, 24 * hour);
  rememberHostPace(origin, 1000, storage, t0);
  const seedAt = async (now, of = origin) => (await visit()).hostLinkSeed(of, { storage, timeline: null, now }).paceMs;
  assert.equal(await seedAt(t0 + 23 * hour), 1000, 'within a day of the block: the pace it taught');
  // A day without refusals: each later visit a step looser, once a visit.
  const page = await visit();
  assert.equal(page.hostLinkSeed(origin, { storage, timeline: null, now: t0 + 25 * hour }).paceMs, 1000 / PACE_RECOVERY_STEP);
  assert.equal(page.hostLinkSeed(origin, { storage, timeline: null, now: t0 + 25 * hour }).paceMs, 1000 / PACE_RECOVERY_STEP, 'a second opening of the same visit: no further step');
  assert.equal(await seedAt(t0 + 26 * hour), 1000 / PACE_RECOVERY_STEP ** 2);
  // The same pace told again by another realm is not another block.
  const told = await visit();
  told.rememberHostPace(origin, 1000 / PACE_RECOVERY_STEP ** 2 / 2, storage, t0 + 26 * hour);
  // A refusal at the loosened pace: back to the pace the first block taught, and kept there.
  assert.equal(told.rememberedHostPace(origin, storage), 1000, 'snapped back to the learnt pace');
  assert.equal(JSON.parse(memory.get('cellucid:host-pace:v1'))[origin].blocks, 2);
  assert.equal(await seedAt(t0 + 30 * 24 * hour), 1000, 'a host that blocks again stays paced');
  // A pace heard twice (learned here, told by the worker) counts one block.
  const other = 'https://o.test';
  const once = await visit();
  once.rememberHostPace(other, 500, storage, t0);
  once.rememberHostPace(other, 500, storage, t0);
  assert.equal(JSON.parse(memory.get('cellucid:host-pace:v1'))[other].blocks, 1);
  // Loosened far enough, it is no pace at all.
  let pace = 500;
  for (let day = 2; pace > 0 && day < 60; day++) pace = await seedAt(t0 + day * 24 * hour, other);
  assert.equal(pace, 0);
  assert.equal((await visit()).rememberedHostPace(other, storage), 0);
  // The Stored dialog forgets every pace.
  (await visit()).forgetHostLinks(storage);
  assert.equal((await visit()).rememberedHostPace(origin, storage), 0);
});

test('one test says which addresses are this machine', async () => {
  const { isLoopbackHostname, isLoopbackUrl } = await import('../assets/js/utils/loopback.js');
  for (const host of ['localhost', 'cellucid.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1', '0.0.0.0', 'LOCALHOST']) {
    assert.equal(isLoopbackHostname(host), true, host);
  }
  for (const host of ['localhost.example.com', '128.0.0.1', '10.0.0.1', '192.168.1.2', 'example.org', '']) {
    assert.equal(isLoopbackHostname(host), false, host);
  }
  assert.equal(isLoopbackUrl('http://127.0.0.1:54683'), true);
  assert.equal(isLoopbackUrl('https://localhost:4180/x'), true);
  assert.equal(isLoopbackUrl('file:///tmp/a.h5ad'), false);
  assert.equal(isLoopbackUrl('not a url'), false);
});
