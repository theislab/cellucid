/**
 * What each host delivered on earlier visits, kept in this browser: the
 * round trip and the rate its link was measured at, by origin, so that an
 * opening's sizing starts from what the host really delivered, not from
 * the few small requests of the opening itself.
 *
 * **Why.** An opening measures its link on the requests that open the file
 * (its structure: small reads, mostly a round trip each), so its rate is a
 * lower bound of the host's: HLCA from CELLxGENE measured 244 ms and about
 * 640 KB/s when opened, while its gene reads then ran at 1.5-3.4 MB/s.
 * Sized from that lower bound, the gene-time auto-fit
 * (`anndata/subsample-plan.js` `geneTimeFit`) opened two to three times
 * fewer cells than the link reads within its target.
 *
 * **What is kept.** For each origin (`hostOf`: a remote source's scheme,
 * host and port; nothing for a file on this computer), the round trip,
 * the round trip under load (`formats/io/link.js` `loadedLatencyMs`: what
 * a read's time is priced at; S3 answered a small request in 0.35-0.5 s
 * with 42 in flight against 230 ms idle), the rate the reads sustained (bytes delivered over the time any request
 * was in flight: `formats/io/link.js` `deliveredBytes`, `busyMs`; never the
 * fastest moment, which overstates what a long read gets) and the bytes it
 * rests on (`evidenceBytes`). A visit's
 * record is blended into the one kept, each weighed by the bytes it rests
 * on, the kept one at half its weight (`rememberHostLink`): older visits
 * fade, and a visit of a few requests barely moves a record of a long
 * read. A convenience across visits in `localStorage` (never required):
 * an origin (scheme, host and port: never a path, a dataset, a query or a
 * token) and five numbers (the round trip, the round trip under load, the
 * rate, the bytes they rest on, when it was last measured). At most `HOST_LINK_RECORDS` hosts are
 * kept, the least recently measured dropped first; `forgetHostLinks`
 * removes them all (the Session panel's Stored dialog).
 *
 * **How it prices** (`pricingLink`): the opening's own measurement, unless
 * it rests on fewer bytes than the record and has not yet measured its
 * bandwidth with a delivery that kept the link full (`formats/io/link.js`
 * `bandwidthMeasured`: before that its rate is only a lower bound); then the record's rate, scaled
 * down by how much longer the opening's round trip is than the record's
 * (a window-limited transfer delivers about its window per round trip: a
 * longer path, another network, delivers less), and never below the
 * opening's own rate; and the record's round trip under load, scaled the
 * same way and never below the opening's own (an opening's few requests
 * barely load a link). So a record can raise the rate only on the same path
 * and only until the opening has read as much as the record rests on; a
 * record from a faster network is scaled down by its shorter round trip.
 * A record only seeds the first guess: a path with the same round trip
 * whose bandwidth fell since (a congested link, a slow day) is priced at the
 * record's rate only until the visit's first reads that fill the link
 * measure it (a few requests: the link's window, `RECENT_REQUESTS`), and
 * from then on as the link is now, slower or faster than remembered.
 *
 * **A host on this machine** (`onThisMachine`: a loopback address --
 * `cellucid serve`, Python's and R's served stores, a web server run here)
 * delivers bytes that never cross a network, from this machine's disk or
 * memory, and so does a local file (its link's prior is a disk:
 * `formats/io/link.js` `snapshot().onThisMachine`). Either is priced as
 * this machine at rest, whatever its reads measured (`thisMachinePricing`):
 * at no less than a disk's rate (`LOCAL_POLICY`), at its shortest round
 * trip (never its round trip under load) and at no time a request beyond
 * it. What its reads measure past that is this machine's own load, not a
 * network: its opening's small reads, each mostly its fixed cost, measure
 * a fraction of it (a 10M-cell `.h5ad` on a loopback host in Chromium:
 * 45 MB/s from 0.9 MB of metadata reads, its first gene then read for
 * every cell in 5.1 s); a read slowed by the machine's work (another
 * browser starting or ending beside it) counts as one that kept the link
 * full (`bandwidthMeasured`) at 0.1-13 MB/s; and requests waiting on it
 * measured a round trip under load of 863 ms. Priced at any of these,
 * genes were read for a sample of a file whose every cell reads within the
 * gene time (5 of 6 openings of 10M-cell stores with the machine busy,
 * 19,779 to 1,947,096 of 10M cells). A tunnel to a remote server (`ssh -L`) is a loopback
 * address too and is priced so: its first gene is read for every open cell
 * unless that is past the gene time even at a disk's rate. A notebook kernel's host (the widget's,
 * `host-fetch.js` `EMBEDDED_HOST_ORIGIN`) is not one: the kernel may run
 * across the internet (Colab, a JupyterHub), and is priced as measured.
 *
 * @module data/host-link-memory
 */

import { LOCAL_POLICY } from '../formats/io/byte-source.js';
import { isHeld } from '../utils/machine.js';

/** Where the records are kept. */
export const HOST_LINK_STORAGE_KEY = 'cellucid:host-link:v1';

/**
 * Where each host's pace is kept (`formats/io/hosts.js` `paceMs`: the least
 * time between two requests a host that blocked this network was found to
 * bear), by origin: `{paceMs, learntMs, blockedAt, blocks, at}` -- the pace
 * a visit starts from, the pace its last block taught (what a refusal snaps
 * back to), when that block was and how many blocks the host has met.
 */
const HOST_PACE_STORAGE_KEY = 'cellucid:host-pace:v1';

/**
 * How long a host that blocked once must go without refusing before its
 * pace loosens (owner, 2026-10-30: "after a day without refusals"), and how
 * much each later visit loosens it: a fifth less time between requests (a
 * quarter more requests a minute). A refusal at a loosened pace snaps it
 * back to the pace the block taught and marks the host as one that blocks
 * again: it stays paced. A host that blocked twice stays paced likewise.
 */
export const PACE_RECOVERY_AFTER_MS = 24 * 60 * 60 * 1000;
export const PACE_RECOVERY_STEP = 1.25;

/** The weight an earlier record keeps when a visit is blended in (each visit's bytes count fully; older ones fade). */
const FADE = 0.5;

/**
 * The hosts kept, at most: the ones a person opens data from (a few:
 * CELLxGENE, a lab server, a notebook) with room to spare, so the record
 * of hosts visited stays short. The least recently measured go first.
 */
export const HOST_LINK_RECORDS = 32;

/**
 * The origin a source is read from, or null for a file on this computer: a
 * remote file's, a folder on a web host's, the first file of remote files
 * of one dataset.
 *
 * @param {Object|null} source
 * @returns {string|null}
 */
export function hostOf(source) {
  const url = source?.files instanceof Map
    ? source.files.values().next().value?.url
    : source?.file?.url ?? source?.url;
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Whether `origin` (`hostOf`) is a host on this machine: a loopback address
 * (`localhost` and its subdomains, `127.0.0.0/8`, `[::1]`). Its bytes never
 * cross a network (module doc).
 *
 * @param {string|null} origin
 * @returns {boolean}
 */
export function onThisMachine(origin) {
  if (typeof origin !== 'string') return false;
  let hostname;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  return hostname === 'localhost' || hostname.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(hostname) || hostname === '[::1]';
}

/**
 * A record as stored, when it is one: `{latencyMs, loadedLatencyMs,
 * bytesPerMs, evidenceBytes, at}` (`loadedLatencyMs` null when no visit
 * measured the round trip under load).
 */
function recordOf(value) {
  if (value === null || typeof value !== 'object') return null;
  const { latencyMs, bytesPerMs, evidenceBytes } = value;
  const at = Number.isFinite(value.at) ? value.at : 0;
  const loaded = value.loadedLatencyMs;
  const loadedLatencyMs = loaded > 0 && Number.isFinite(loaded) ? Math.max(loaded, latencyMs) : null;
  return latencyMs > 0 && Number.isFinite(latencyMs) && bytesPerMs > 0 && Number.isFinite(bytesPerMs) && evidenceBytes > 0 && Number.isFinite(evidenceBytes)
    ? { latencyMs, loadedLatencyMs, bytesPerMs, evidenceBytes, at }
    : null;
}

/** Two values weighed by their bytes, either when the other is unknown (null). */
function blended(a, aWeight, b, bWeight) {
  if (a === null) return b;
  if (b === null) return a;
  return (a * aWeight + b * bWeight) / (aWeight + bWeight);
}

/** Only well-formed records of origins (`scheme://host[:port]`), the most recently measured `HOST_LINK_RECORDS`. */
function bounded(all) {
  const kept = Object.entries(all)
    .filter(([origin, value]) => /^https?:\/\/[^/?#\s]+$/.test(origin) && recordOf(value) !== null)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, HOST_LINK_RECORDS);
  return Object.fromEntries(kept);
}

function readAll(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(HOST_LINK_STORAGE_KEY) ?? 'null');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The page's storage, when it has one it may use. */
function pageStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * What `origin` delivered on earlier visits, or null when nothing is kept.
 *
 * @param {string|null} origin
 * @param {Storage|null} [storage]
 * @returns {{latencyMs: number, loadedLatencyMs: number|null, bytesPerMs: number, evidenceBytes: number}|null}
 */
export function rememberedHostLink(origin, storage = pageStorage()) {
  if (typeof origin !== 'string') return null;
  return recordOf(readAll(storage)[origin]);
}

/**
 * This browser's own downlink, as far as the page's own downloads show it:
 * the fastest of the page's resources fetched over the network (its
 * document, scripts, styles and modules; the browser's Resource Timing,
 * `transferSize` over the whole fetch, round trip included: a lower bound
 * of each), in bytes a millisecond, or null when none was (every asset
 * from the browser's cache, a context with no timeline). A host across the
 * internet delivers at most about this to many requests at once, and on a
 * first visit to it the opening's own small reads measure far less (an
 * 11.4M-cell CELLxGENE atlas: 1 MB/s at its first resolve, 11.5 MB/s on its
 * first gene): what a `blocks` order's rung is sized at until the link is
 * measured (`subsample-plan.js` `blockRung`). Never stored.
 *
 * @param {{getEntriesByType?: (type: string) => Array<{transferSize?: number, duration?: number}>}|null} [timeline]
 * @returns {number|null}
 */
export function pageDownlinkBytesPerMs(timeline = globalThis.performance ?? null) {
  if (typeof timeline?.getEntriesByType !== 'function') return null;
  let best = 0;
  for (const type of ['navigation', 'resource']) {
    let entries;
    try {
      entries = timeline.getEntriesByType(type);
    } catch {
      continue;
    }
    for (const entry of entries ?? []) {
      const bytes = entry?.transferSize;
      const ms = entry?.duration;
      if (bytes > 0 && ms > 0 && Number.isFinite(bytes / ms)) best = Math.max(best, bytes / ms);
    }
  }
  return best > 0 ? best : null;
}

/**
 * What an opening of a file at `origin` is sized from before its own reads
 * measure the link (sent to the reader with the opening): what the host
 * delivered on earlier visits (`rememberedHostLink`, its fields; none when
 * nothing is kept), this browser's downlink (`downlinkBytesPerMs`,
 * `pageDownlinkBytesPerMs`) and the pace the host was found to bear
 * (`paceMs`, `rememberedHostPace`; 0 when none), and whether the host is
 * on this machine (`thisMachine`, `onThisMachine`). Null for a file on this
 * computer.
 *
 * @param {string|null} origin
 * @param {{storage?: Storage|null, timeline?: Object|null}} [where]
 * @returns {Object|null}
 */
export function hostLinkSeed(origin, { storage = pageStorage(), timeline = globalThis.performance ?? null, now = Date.now() } = {}) {
  if (typeof origin !== 'string') return null;
  return {
    ...rememberedHostLink(origin, storage),
    origin,
    downlinkBytesPerMs: pageDownlinkBytesPerMs(timeline),
    paceMs: visitPace(origin, storage, now),
    thisMachine: onThisMachine(origin),
  };
}

/**
 * The seed the reader plans with (`AnnDataReader`): `seed` (`hostLinkSeed`)
 * as it is, or, while the machine's link is held (`utils/machine.js`
 * `link`), only where the host is (`thisMachine`, which is no measurement):
 * what earlier visits measured of it and what the page's own downloads
 * measured of this browser's downlink are measurements of the link too, and
 * a held link is planned on as held.
 *
 * @param {Object|null} seed
 * @returns {Object|null}
 */
export function plannedHostLink(seed) {
  if (seed === null || seed === undefined || !isHeld('link')) return seed ?? null;
  return { origin: seed.origin, thisMachine: seed.thisMachine === true };
}

function readPaces(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(HOST_PACE_STORAGE_KEY) ?? 'null');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Keep `all` (origin -> record), the most recently changed `HOST_LINK_RECORDS`. Never throws. */
function writePaces(all, storage) {
  const kept = Object.entries(all)
    .filter(([key, value]) => /^https?:\/\/[^/?#\s]+$/.test(key) && value?.paceMs > 0 && Number.isFinite(value.paceMs))
    .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
    .slice(0, HOST_LINK_RECORDS);
  try {
    storage.setItem(HOST_PACE_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage refused: the pace is learnt again on the next block.
  }
}

/** Origins whose pace this page has loosened already: one step a visit. */
const loosenedThisVisit = new Set();

/**
 * The pace an opening of a file at `origin` starts from (`hostLinkSeed`):
 * the kept one, loosened by a step (`PACE_RECOVERY_STEP`) once per visit
 * when the host blocked only once and not for `PACE_RECOVERY_AFTER_MS`;
 * a pace loosened to under a millisecond between requests is no pace, and
 * its record goes. 0 when none is kept.
 */
function visitPace(origin, storage, now) {
  const all = readPaces(storage);
  const record = all[origin];
  const paceMs = rememberedHostPace(origin, storage);
  if (paceMs === 0 || storage === null || loosenedThisVisit.has(origin)) return paceMs;
  const blocks = Number.isSafeInteger(record.blocks) ? record.blocks : 1;
  const blockedAt = Number.isFinite(record.blockedAt) ? record.blockedAt : record.at ?? now;
  if (blocks !== 1 || now - blockedAt < PACE_RECOVERY_AFTER_MS) return paceMs;
  loosenedThisVisit.add(origin);
  const loosened = paceMs / PACE_RECOVERY_STEP;
  if (loosened < 1) delete all[origin];
  else all[origin] = { ...record, paceMs: loosened, learntMs: Math.max(record.learntMs ?? 0, paceMs), at: now };
  writePaces(all, storage);
  return loosened < 1 ? 0 : loosened;
}

/**
 * The least time between two requests `origin` was found to bear on an
 * earlier visit (`formats/io/hosts.js` `learnPace`), in milliseconds; 0
 * when none is kept.
 *
 * @param {string|null} origin
 * @param {Storage|null} [storage]
 * @returns {number}
 */
export function rememberedHostPace(origin, storage = pageStorage()) {
  if (typeof origin !== 'string') return 0;
  const paceMs = readPaces(storage)[origin]?.paceMs;
  return paceMs > 0 && Number.isFinite(paceMs) ? paceMs : 0;
}

/**
 * Keep the pace `origin` was found to bear (`hosts.js` `watchPace`, a block
 * met in this visit): an origin and a number, the most recently learnt
 * `HOST_LINK_RECORDS` kept. The pace kept is never faster than the one the
 * host's last block taught (`learntMs`): a block met at a pace loosened
 * since (`visitPace`) snaps it back, and counts as the host's second (it
 * stays paced from then on), as does a block that teaches a slower pace
 * still. The same pace heard again (learnt in one realm, told to another)
 * is not another block. Never throws.
 *
 * @param {string|null} origin
 * @param {number} paceMs
 * @param {Storage|null} [storage]
 * @param {number} [now]
 */
export function rememberHostPace(origin, paceMs, storage = pageStorage(), now = Date.now()) {
  if (typeof origin !== 'string' || !/^https?:\/\/[^/?#\s]+$/.test(origin) || !(paceMs > 0) || !Number.isFinite(paceMs) || storage === null) return;
  const all = readPaces(storage);
  const prior = all[origin] ?? null;
  const priorPace = rememberedHostPace(origin, storage);
  const learntMs = Math.max(prior?.learntMs ?? 0, priorPace);
  const loosened = priorPace > 0 && priorPace < learntMs;
  const another = prior === null || priorPace === 0 || loosened || paceMs > learntMs;
  if (!another) return;
  const blocks = prior === null || priorPace === 0 ? 1 : (Number.isSafeInteger(prior.blocks) ? prior.blocks : 1) + 1;
  const pace = Math.max(paceMs, learntMs);
  all[origin] = { paceMs: pace, learntMs: pace, blockedAt: now, blocks, at: now };
  writePaces(all, storage);
}

/** Each origin's record as it was when this page first read it: what this visit's measurements are blended into. */
const baselines = new Map();

/**
 * Keep what `origin` delivered in this visit (`measurement`, a link
 * measurement: `latencyMs`, `loadedLatencyMs`, `bytesPerMs`, `deliveredBytes`), blended into
 * the record as it was when the page first read it: called again as the
 * measurement grows, the record follows it without counting the visit
 * twice. Never throws.
 *
 * @param {string|null} origin
 * @param {{latencyMs?: number|null, loadedLatencyMs?: number|null, bytesPerMs?: number|null, deliveredBytes?: number|null}|null} measurement
 * @param {Storage|null} [storage]
 */
export function rememberHostLink(origin, measurement, storage = pageStorage()) {
  if (typeof origin !== 'string' || storage === null) return;
  // The rate the visit's reads sustained (bytes over the time any request
  // was in flight), not the link's best moment (`bytesPerMs`, the fastest
  // delivery seen): what the next opening's reads can count on. HLCA's
  // fastest delivery was 6.2 MB/s while its gene reads sustained 1.6 MB/s;
  // sized from the fastest, a later opening's first gene took three times
  // its target.
  const sustained = measurement?.busyMs > 0 && measurement?.deliveredBytes > 0 ? measurement.deliveredBytes / measurement.busyMs : null;
  const visit = recordOf({ latencyMs: measurement?.latencyMs, loadedLatencyMs: measurement?.loadedLatencyMs, bytesPerMs: sustained, evidenceBytes: measurement?.deliveredBytes, at: Date.now() });
  if (visit === null) return;
  const all = readAll(storage);
  if (!baselines.has(origin)) baselines.set(origin, recordOf(all[origin]));
  const before = baselines.get(origin);
  let record = visit;
  if (before !== null) {
    const kept = before.evidenceBytes * FADE;
    const total = kept + visit.evidenceBytes;
    record = {
      latencyMs: (before.latencyMs * kept + visit.latencyMs * visit.evidenceBytes) / total,
      loadedLatencyMs: blended(before.loadedLatencyMs, kept, visit.loadedLatencyMs, visit.evidenceBytes),
      bytesPerMs: (before.bytesPerMs * kept + visit.bytesPerMs * visit.evidenceBytes) / total,
      evidenceBytes: total,
      at: visit.at,
    };
  }
  all[origin] = record;
  try {
    storage.setItem(HOST_LINK_STORAGE_KEY, JSON.stringify(bounded(all)));
  } catch {
    // Storage refused (full, or a private window): sizing measures afresh.
  }
}

/**
 * The hosts whose speed is kept, most recently measured first: what the
 * Session panel's Stored dialog lists.
 *
 * @param {Storage|null} [storage]
 * @returns {Array<{origin: string, latencyMs: number, bytesPerMs: number, at: number}>}
 */
export function rememberedHosts(storage = pageStorage()) {
  return Object.entries(bounded(readAll(storage)))
    .map(([origin, value]) => {
      const { latencyMs, bytesPerMs, at } = recordOf(value);
      return { origin, latencyMs, bytesPerMs, at };
    });
}

/**
 * Forget every host's kept speed and pace (the Session panel's Stored
 * dialog): the next opening of each sizes from its own measurement and
 * learns its pace again. Never throws.
 *
 * @param {Storage|null} [storage]
 */
export function forgetHostLinks(storage = pageStorage()) {
  baselines.clear();
  try {
    storage?.removeItem(HOST_LINK_STORAGE_KEY);
    storage?.removeItem(HOST_PACE_STORAGE_KEY);
  } catch {
    // Storage refused: nothing to remove.
  }
}

/**
 * The link an opening's sizing prices reads at: `fresh` (a `LinkMeter`
 * snapshot) as measured, or, while it rests on fewer bytes than the
 * record `seed` carries (`hostLinkSeed`: `rememberedHostLink`'s fields), the
 * remembered rate scaled by the two round trips and never below the fresh
 * rate, and the remembered round trip under load likewise, never below the
 * fresh one (module doc). `remembered`: true when the record raised either.
 * A source on this machine -- a host (`seed.thisMachine`) or a local file
 * (`fresh.onThisMachine`, `LinkMeter.snapshot`) -- is priced as this
 * machine at rest, whatever its link measured (`thisMachinePricing`;
 * `thisMachine`: true when that changed a price). Only the primitives
 * (`latencyMs`, `bytesPerMs`, `loadedLatencyMs`, `requestCostMs`) are
 * lifted: what a `LinkMeter` derives from them (`mergeGapBytes`,
 * `roundTripBytes`, `maxRequestBytes`) stays the fresh link's.
 *
 * @param {Object|null} fresh
 * @param {{latencyMs?: number, bytesPerMs?: number, evidenceBytes?: number, thisMachine?: boolean}|null} seed
 * @returns {Object|null}
 */
export function pricingLink(fresh, seed) {
  if (fresh === null || fresh === undefined) return null;
  const lifted = rememberedPricing(fresh, recordOf(seed));
  return seed?.thisMachine === true || fresh.onThisMachine === true ? thisMachinePricing(lifted) : lifted;
}

/**
 * `link` priced as a source on this machine (module doc): a rate below a
 * disk's (`LOCAL_POLICY.bytesPerMs`) raised to it, a round trip under load
 * priced as the shortest measured (`latencyMs`), and no time a request on
 * top of it (`requestCostMs`, a remote host's budget or its time a request
 * under load) -- measured or not: what this machine's reads measure past
 * its rest is its own load (another browser starting beside it, Chromium:
 * 0.1-13 MB/s, or an 863 ms round trip under load where 1.5-7 ms is usual),
 * never a network. Prices already as good are kept.
 */
function thisMachinePricing(link) {
  const rate = !(link.bytesPerMs >= LOCAL_POLICY.bytesPerMs);
  const roundTrip = Number.isFinite(link.latencyMs) && link.loadedLatencyMs > link.latencyMs;
  const perRequest = link.requestCostMs > 0;
  if (!rate && !roundTrip && !perRequest) return link;
  return {
    ...link,
    ...(rate ? { bytesPerMs: LOCAL_POLICY.bytesPerMs, measured: link.measured === true || Number.isFinite(link.latencyMs) } : {}),
    ...(roundTrip ? { loadedLatencyMs: link.latencyMs } : {}),
    ...(perRequest ? { requestCostMs: 0 } : {}),
    thisMachine: true,
  };
}

/** `fresh` priced with the host's `record` (`pricingLink`), or as it is with none. */
function rememberedPricing(fresh, record) {
  if (record === null) return fresh;
  // The visit has measured the link itself (a delivery that kept it full),
  // or read as much as the record rests on: the link as it is now.
  if (fresh.bandwidthMeasured === true || (fresh.deliveredBytes ?? 0) >= record.evidenceBytes) return fresh;
  // Round trips compared like with like: the fresh link's on a connection
  // already made (`warmLatencyMs`), never its first requests, whose time
  // holds the connection's set-up (a revisit priced from one cold HEAD and
  // one GET read GEO at a third of its rate, measured). Until it has one,
  // the remembered rate stands as it was measured.
  const warm = fresh.warmLatencyMs > 0 && Number.isFinite(fresh.warmLatencyMs) ? fresh.warmLatencyMs : null;
  const latencyMs = warm ?? record.latencyMs;
  const scaled = record.bytesPerMs * Math.min(1, record.latencyMs / latencyMs);
  const own = fresh.bytesPerMs > 0 ? fresh.bytesPerMs : 0;
  // The round trip under load (`link.js` `loadedLatencyMs`): an opening's
  // few requests barely load the link, so the remembered one stands, on
  // this path's round trip (the same excess under load), never below the
  // opening's own.
  const ownLoaded = fresh.loadedLatencyMs > 0 && Number.isFinite(fresh.loadedLatencyMs) ? fresh.loadedLatencyMs : 0;
  const rememberedLoaded = record.loadedLatencyMs === null ? 0 : record.loadedLatencyMs * latencyMs / record.latencyMs;
  const raisesRate = scaled > own;
  const raisesLoaded = rememberedLoaded > ownLoaded;
  if (!raisesRate && !raisesLoaded) return fresh;
  return {
    ...fresh,
    ...(raisesRate ? { latencyMs, bytesPerMs: scaled } : {}),
    ...(raisesLoaded ? { loadedLatencyMs: rememberedLoaded } : {}),
    measured: fresh.measured === true || raisesRate,
    remembered: true,
  };
}
