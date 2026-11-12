/**
 * What this realm knows of each web host (by origin), shared by every
 * request any reader, store or provider makes to it (`fetchOnce`,
 * `byte-source.js`, is the one place a request to a web host is sent).
 *
 * - **How long it takes to answer** (`rememberAnswer`): a link to a file on
 *   that host starts its stall timeout from it (`ResponseClock.answered`)
 *   when nothing of the file itself was measured yet. A provider's own
 *   request (Zenodo's record, Hugging Face's path) answers before the
 *   file's first read, so a host slower to answer than the initial second
 *   is not taken for stalled on every first read.
 *
 * - **Whether it is delivering** (`delivered`, `deliveries`): a browser
 *   keeps six connections to an HTTP/1.1 host, shared by every request of
 *   every tab of this site (the connection pool is the browser's, keyed by
 *   the host and the site that asks), so a request of one reader waits
 *   behind another reader's requests to the same host -- a catalog listing
 *   several files of one host, GEO's three MatrixMarket files, an old and a
 *   new reader worker of one file, a store and the files beside it. Such a
 *   request is queued, not stalled: a request is taken for stalled only when
 *   neither it, nor its link, nor any request to its host anywhere in this
 *   site received anything for a whole timeout. Every piece that arrives
 *   counts a delivery of its host here, and is told to the other realms of
 *   this site (the page, its reader workers, other tabs: a
 *   `BroadcastChannel`) at most once per half of the shortest stall timeout
 *   (RFC 6298's one second), so a watch that looks once per timeout always
 *   sees a host that delivered meanwhile.
 *
 * - **Its request budget** (`admit`, read by `budget`): a host that limits how many
 *   requests it answers per window says so on its answers, and where it lets
 *   the page read the headers, requests to it are paced by them instead of
 *   being refused by it:
 *   - `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
 *     (Zenodo: 133 a minute, every range read counted; GitHub's API: 60 an
 *     hour without a sign-in), the reset in epoch seconds or, from a host
 *     that counts it so, in seconds from now (a value under 10^9 seconds,
 *     2001, is no epoch time);
 *   - the IETF fields, `RateLimit-Limit/Remaining/Reset` (seconds from
 *     now), and their structured form `RateLimit: "api";r=499;t=227` with
 *     `RateLimit-Policy: "api";q=500;w=300` (Hugging Face: 500 API requests
 *     and 3,000 file resolutions per five minutes);
 *   - `Retry-After` on a `429` (or on Google's `403` naming a rate limit),
 *     which holds every request to the host until then.
 *
 *   Within one window (answers whose resets agree to within the headers'
 *   one-second resolution) the lowest count seen stands: answers arrive out
 *   of order, and the count only falls. A request is sent while the
 *   remaining count exceeds the requests already on their way (each may be
 *   counted already); once it does not, requests wait for an answer to tell
 *   more, or, with none on its way, for the reset, when the window's whole
 *   limit is available again -- asked first with one request, whose answer
 *   states the new window (this machine's clock may run ahead of the
 *   host's, which would refuse a whole limit sent at once). A count without
 *   a reset says nothing of when it refills: nothing waits for it. A host
 *   that answers that it is
 *   limiting (a `429`) is also asked less at once: the requests let run to
 *   it are halved, from those on their way, and grow back by one for every
 *   round of requests it answers (additive increase, multiplicative
 *   decrease), so the requests after its wait do not meet the limit again.
 *   What a host's answers say of its budget, and a wait it named, are told
 *   to the other realms of this site, whose requests to it count against the
 *   same budget. A `503` that names a wait (a server preparing what was
 *   asked for, `cellucid serve` laying a matrix out) holds that request
 *   only (`byte-source.js` `withRetries`), never the host.
 *
 * - **Its pace** (`pace`, `seedPace`, `watchPace`): a host that blocks a
 *   network for sending too many requests (a host that answered and then
 *   sends nothing a page may read to two rounds in a row: Zenodo's
 *   and Google's "unusual traffic" pages, which Zenodo sent this machine
 *   after about 550 range reads in a few minutes, within the 133 a minute
 *   its headers state) is a host whose real limit is lower than anything it
 *   says. When it answered most of the requests sent in the minute before
 *   the block (`PACE_WINDOW_MS`), those requests are what it refused, however
 *   fast they went (one that answered few of them refuses outright: no pace
 *   mends that); from
 *   then on requests to it are spaced so a minute holds half as many (`paceMs`:
 *   multiplicative decrease, as TCP halves its window on a loss), whatever
 *   its headers allow, and a further block halves the rate again. Readers
 *   price a request at no less (`requestCostMs`), so a plan reads through
 *   larger gaps in fewer requests instead of meeting the limit. The pace is
 *   told to the other realms of this site and to whoever watches it (the
 *   page keeps it per origin across visits: `data/host-link-memory.js`),
 *   and an opening starts from what was kept (`seedPace`), so a visit never
 *   sends the burst that blocked an earlier one. A host on this machine
 *   (`utils/loopback.js`) learns no pace: it blocks no network, and its
 *   silence is a server restarting or down. Nor do requests lost on this
 *   side of the link (`lostOnThisSide`: this computer offline, or a request
 *   failing in less than half the host's quickest answer, which a refusal,
 *   being an answer, never does): a connection that drops for a moment is
 *   no block, and a pace learned from it would slow the host for a day.
 *
 * - **Whether it answers at all** (`answeredBefore`): a request that gets
 *   no answer a page may read (no connection, or an answer without CORS
 *   headers) is a lost request. The range reads of a file and the object
 *   reads of a store folder (`burst`, many requests no person asked one by
 *   one) count their losses by address (a file's URL: every range of one
 *   file is one address; a folder's root: every object of it is one, so a
 *   folder on a refusing host is not asked twice for each of its objects;
 *   Drive's file and its details are two, as Google holds back only the
 *   first, and a provider's own requests are never held), as TCP
 *   backs its retransmission timer off: requests on their way together are
 *   one round, lost once; a second round in a row (their retries:
 *   `withRetries` reports a request so, once asked again), and the address
 *   is left unasked for RFC 6298's
 *   retransmission timeout, doubled for every further round up to its
 *   60 s: requests to it fail at once, unsent (`HostNotAnswering`), then
 *   one asks again. A momentary failure (GitHub Pages' 503 without CORS
 *   headers) costs one round, answered on its retries; a file whose host
 *   refuses this network is asked a few requests, then about one a minute,
 *   never by every waiting read (a read of a file that delivered ranges
 *   before waits through it: `byte-source.js` `refusesForNow`). Its first readable answer ends that. A
 *   host that answered this site before and now sends nothing a page may
 *   read is not one that refuses other websites (CORS): it refuses this
 *   network for now -- Zenodo and Google answer a network that sent them
 *   many requests with an HTML "unusual traffic" page (HTTP 403) without
 *   CORS headers for a while -- or it is failing, and its failure says so
 *   (`byte-source.js` `fetchOnce`).
 *
 * Times are this realm's monotonic clock; a reset stated in epoch seconds is
 * taken from this machine's clock at the answer (a host's `Date` is not one
 * a page may read): a clock that runs ahead of the host's waits that much
 * less, and the host's next refusal names the rest.
 *
 * @module formats/io/hosts
 */

import { onAbort, abortReason } from '../../utils/abort.js';
import { MIN_STALL_TIMEOUT_MS } from './link.js';
import { isLoopbackUrl } from '../../utils/loopback.js';
import { createListenerSet } from '../../utils/listener-set.js';

/** Half the shortest stall timeout (RFC 6298's floor, `link.js`): the most a delivery is told to other realms late. */
const DELIVERY_TOLD_EVERY_MS = MIN_STALL_TIMEOUT_MS / 2;

/**
 * The longest a host that stopped answering is left unasked: the maximum
 * RFC 6298 (2.5) lets a retransmission timer be held to.
 */
export const MAX_QUIET_MS = 60_000;

/**
 * The stretch of requests a block is taken to have refused: the rate they
 * were sent at over the minute before it (`learnPace`). A minute is the
 * window hosts state their budgets over (Zenodo, GitHub's search, Hugging
 * Face's shortest), and RFC 6298's longest retransmission timer.
 */
const PACE_WINDOW_MS = 60_000;

/** The resolution of every reset a host states (whole seconds). */
const RESET_RESOLUTION_MS = 1000;

/** An `X-RateLimit-Reset` this large is epoch seconds (10^9 s is 2001); below it, seconds from now. */
const EPOCH_SECONDS_FROM = 1e9;

/**
 * A request not sent: its address gave no answer a page may read to two
 * rounds of requests in a row, and is left unasked for now (`answeredBefore`).
 */
export class HostNotAnswering extends Error {
  /** @param {string} host */
  constructor(host) {
    super(`${host} gave no answer to the requests before this one; it was not sent.`);
    this.name = 'HostNotAnswering';
    this.host = host;
  }
}

/** The name of the channel the realms of this site tell each other what they learned of hosts on. */
export const HOSTS_CHANNEL = 'cellucid-hosts';

/** An address requests are counted by: the URL without its fragment (its query names what is asked: Drive's file and its details). */
function addressOf(url) {
  const at = String(url).indexOf('#');
  return at === -1 ? String(url) : String(url).slice(0, at);
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The site an origin belongs to, so hosts of one operator count once (the
 * Census bucket's six S3 addresses are one site): an IP address as it is,
 * else the last two labels of the name (`s3.us-west-2.amazonaws.com` →
 * `amazonaws.com`).
 */
function siteOf(origin) {
  const name = new URL(origin).hostname;
  if (/^[\d.]+$/.test(name) || name.includes(':')) return name;
  return name.split('.').slice(-2).join('.');
}

/** A non-negative whole number a header states, or null. */
function count(value) {
  if (typeof value !== 'string' || !/^\s*\d+\s*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/**
 * Milliseconds a `Retry-After` header asks for (seconds, or an HTTP date),
 * or null. A cross-origin page sees the header only where the host exposes
 * it (`Access-Control-Expose-Headers`).
 *
 * @param {string|null} value
 * @param {number} [epochNow]
 * @returns {number|null}
 */
export function retryAfterMilliseconds(value, epochNow = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - epochNow) : null;
}

/**
 * The parameters of the most constraining item of a structured `RateLimit`
 * field (`"api";r=499;t=227, "burst";r=4;t=1`): its `r` and `t`, or of a
 * `RateLimit-Policy` (`"api";q=500;w=300`): its `q`. Null when none.
 */
function structuredItems(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value.split(',').map(item => {
    const parameters = {};
    for (const match of item.matchAll(/;\s*([a-z][a-z0-9_-]*)\s*=\s*(\d+)/gi)) parameters[match[1].toLowerCase()] = Number(match[2]);
    return parameters;
  });
}

/**
 * What one answer's headers say of its host's request budget:
 * `{limit, remaining, resetInMs}` (each null when not said), or null when
 * they say nothing.
 *
 * @param {Headers} headers
 * @param {number} [epochNow]
 * @returns {{limit: number|null, remaining: number|null, resetInMs: number|null}|null}
 */
export function budgetOf(headers, epochNow = Date.now()) {
  const get = name => headers?.get?.(name) ?? null;
  let limit = count(get('X-RateLimit-Limit')) ?? count(get('RateLimit-Limit'));
  let remaining = count(get('X-RateLimit-Remaining')) ?? count(get('RateLimit-Remaining'));
  let resetInMs = null;
  const legacyReset = count(get('X-RateLimit-Reset'));
  if (legacyReset !== null) {
    resetInMs = legacyReset >= EPOCH_SECONDS_FROM ? Math.max(0, legacyReset * 1000 - epochNow) : legacyReset * 1000;
  } else {
    const reset = count(get('RateLimit-Reset'));
    if (reset !== null) resetInMs = reset * 1000;
  }
  if (remaining === null) {
    // The structured form: the item that leaves fewest requests.
    const items = structuredItems(get('RateLimit')).filter(item => Number.isSafeInteger(item.r));
    if (items.length > 0) {
      const tightest = items.reduce((left, right) => (right.r < left.r ? right : left));
      remaining = tightest.r;
      if (Number.isSafeInteger(tightest.t)) resetInMs = tightest.t * 1000;
      const policies = structuredItems(get('RateLimit-Policy')).filter(item => Number.isSafeInteger(item.q));
      if (limit === null && policies.length > 0) limit = Math.min(...policies.map(item => item.q));
    }
  }
  if (limit === null && remaining === null && resetInMs === null) return null;
  return { limit, remaining, resetInMs };
}

/**
 * The hosts this realm reads: a book of what it knows of each (the module
 * doc). One per realm (`realmHosts`); tests make their own on a virtual
 * clock.
 *
 * @param {{now?: () => number, after?: (ms: number, callback: () => void) => () => void,
 *   epoch?: () => number, channel?: {postMessage: Function, onmessage: Function|null}|null,
 *   online?: () => boolean}} [options]
 *   `now`, the monotonic clock in milliseconds every time here is kept on,
 *   and `after`, its timers; `epoch`, the wall clock a reset in epoch
 *   seconds is read against; `channel`, what tells the other realms;
 *   `online`, whether this computer says it is online (`navigator.onLine`)
 */
export function createHostBook({
  now = () => performance.now(),
  after = (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
  epoch = () => Date.now(),
  channel = null,
  online = () => globalThis.navigator?.onLine !== false,
} = {}) {
  /** @type {Map<string, Object>} */
  const hosts = new Map();
  // When a request to each site last got no answer a page may read (`lost`),
  // and when any host last answered: hosts of unrelated sites all losing
  // requests while none answers is this computer's connection
  // (`connectionDown`).
  /** @type {Map<string, number>} */
  const lostAt = new Map();
  let answeredAt = -Infinity;
  /** Who hears a host's pace learned here or told by another realm (`watchPace`). */
  const paceWatchers = createListenerSet('a host\'s pace');

  function hostOf(origin) {
    let host = hosts.get(origin);
    if (host === undefined) {
      host = {
        origin,
        answeredMs: null,
        deliveries: 0,
        toldAt: -Infinity,
        limit: null,
        remaining: null,
        resetAt: null,
        windowAsked: false,
        holdUntil: -Infinity,
        // The window a budget is counted over, as far as it is known (the
        // longest reset stated with a window's whole count), and whether a
        // request has waited for the budget (`requestCostMs`).
        windowMs: null,
        bound: false,
        // What each address of the host lost (`lose`), by address: an
        // address it answers again is forgotten.
        losses: new Map(),
        inFlight: 0,
        cap: Infinity,
        capCeiling: Infinity,
        queue: [],
        wake: null,
        wakeAt: Infinity,
        // When each recent request was sent (the latest `PACE_WINDOW_MS`),
        // the least time between two requests the host was found to bear
        // (`learnPace`; 0: none known), and when the last one was sent.
        sentAt: [],
        answeredAt: [],
        paceMs: 0,
        lastSentAt: -Infinity,
        // The quickest answer it gave (from its request sent to the answer):
        // no answer of it comes sooner, so a request lost sooner than half of
        // it never reached it (`lostOnThisSide`).
        fastestAnswerMs: Infinity,
      };
      hosts.set(origin, host);
    }
    return host;
  }

  function tell(message) {
    if (channel === null) return;
    try {
      channel.postMessage(message);
    } catch {
      // A realm without the channel any more: nothing is told.
    }
  }

  /** Whether one more request to `host` may be sent now; else when to look again (Infinity: on an answer). */
  function nextFree(host) {
    const at = now();
    if (at < host.holdUntil) return host.holdUntil;
    if (host.paceMs > 0 && at < host.lastSentAt + host.paceMs) return host.lastSentAt + host.paceMs;
    if (host.resetAt !== null && at >= host.resetAt) {
      // A new window, by this machine's clock: one request asks the host
      // what it has (a host whose clock is behind still counts the old
      // window, and would refuse a whole limit sent at once), and its
      // answer releases the rest.
      host.remaining = host.limit === null ? null : 1;
      host.windowAsked = host.limit !== null;
      host.resetAt = null;
    }
    if (host.inFlight >= Math.floor(host.cap)) return Infinity;
    if (host.remaining !== null && host.remaining - host.inFlight <= 0) {
      if (host.inFlight > 0) return Infinity;
      if (host.resetAt !== null) return host.resetAt;
    }
    return at;
  }

  /** Let waiting requests go while the budget allows, and look again when it may allow more. */
  function pump(host) {
    host.wake?.();
    host.wake = null;
    host.wakeAt = Infinity;
    while (host.queue.length > 0) {
      const free = nextFree(host);
      if (free > now()) {
        if (Number.isFinite(free)) {
          host.wakeAt = free;
          host.wake = after(free - now(), () => {
            host.wake = null;
            pump(host);
          });
        }
        for (const waiter of host.queue) waiter.waiting(free);
        if (host.remaining !== null && host.remaining - host.inFlight <= 0) host.bound = true;
        return;
      }
      const waiter = host.queue.shift();
      waiter.admitted();
    }
  }

  /** What an answer of `host` says of its budget; `limiting`: the answer refused for the host's limit (a 429). */
  function learnBudget(host, said, { limiting = false, waitMs = null } = {}) {
    const at = now();
    if (host.windowAsked && (said === null || said.remaining === null)) {
      // The host answered the new window's first request without its count.
      host.windowAsked = false;
      host.remaining = host.limit;
    }
    if (said !== null) {
      if (said.limit !== null) host.limit = said.limit;
      if (said.remaining !== null) {
        const resetAt = said.resetInMs === null ? null : at + said.resetInMs;
        // The first answer of a new window states it whole.
        const sameWindow = !host.windowAsked && host.remaining !== null && (resetAt === null || host.resetAt === null ||
          resetAt <= host.resetAt + RESET_RESOLUTION_MS);
        host.windowAsked = false;
        if (sameWindow) {
          host.remaining = Math.min(host.remaining, said.remaining);
          if (resetAt !== null) host.resetAt = host.resetAt === null ? resetAt : Math.max(host.resetAt, resetAt);
        } else {
          host.remaining = said.remaining;
          host.resetAt = resetAt;
          // A window stated whole: its reset is (at most) the window's length.
          if (said.resetInMs !== null && said.resetInMs > 0) host.windowMs = Math.max(host.windowMs ?? 0, said.resetInMs);
        }
      }
    }
    if (waitMs !== null && waitMs > 0) host.holdUntil = Math.max(host.holdUntil, at + waitMs);
    if (limiting && said?.remaining === 0 && said.resetInMs !== null && said.resetInMs < RESET_RESOLUTION_MS) {
      // Refused under a reset already past by this machine's clock: the
      // host's runs behind. It is asked again a step of its resolution later,
      // not at once and again.
      host.holdUntil = Math.max(host.holdUntil, at + RESET_RESOLUTION_MS);
    }
    // A `429` is an answer: the host is asked fewer at once, for as long as
    // it names. Only a block (no answer at all) sets a pace (`lose`).
    if (limiting) slowDown(host);
  }

  /**
   * What an address of `host` lost: `streak`, the rounds in a row whose
   * requests got no answer a page may read (a round: the requests sent
   * before a loss was known, so requests on their way together count once,
   * and their retries once more); `round`, the round now; `quietUntil`,
   * until when it is not asked.
   */
  function lossesOf(host, address) {
    let loss = host.losses.get(address);
    if (loss === undefined) {
      loss = { streak: 0, round: 0, quietUntil: -Infinity };
      host.losses.set(address, loss);
    }
    return loss;
  }

  /**
   * A round of requests to an address of `host` got no answer a page may
   * read; a second round in a row, and the address is not asked for a
   * while -- RFC 6298's
   * retransmission timer, from its one-second floor, doubled for every
   * further round and kept under its 60 s maximum -- and what waits for it
   * fails unsent (`HostNotAnswering`).
   */
  function lose(host, address, onThisSide = false) {
    const loss = lossesOf(host, address);
    // Whether a round of this streak was lost on this side of the link
    // (`lostOnThisSide`): the streak then says nothing of the host.
    loss.thisSide = loss.streak === 0 ? onThisSide : loss.thisSide || onThisSide;
    // Whether every round of this streak was lost while this computer said
    // it was offline: then its quiet ends when it is online again (`admit`).
    const offline = !online();
    loss.offline = loss.streak === 0 ? offline : loss.offline && offline;
    loss.round++;
    loss.streak++;
    if (loss.streak < 2) return;
    loss.quietUntil = now() + Math.min(MAX_QUIET_MS, MIN_STALL_TIMEOUT_MS * 2 ** (loss.streak - 2));
    // A host that answered this site and now refuses it blocks this network:
    // it is sent no faster than half the rate that met the block. Not when
    // the requests were lost on this side (this computer offline, its link
    // down for a moment): no pace mends that, and a pace learned from it
    // would slow every read of the host for the rest of the visit and, kept,
    // the next day's (round 9, R9P-5: a flapping link read Suo at 70 KB/s
    // over a fast one, "theislab.github.io limits how many requests it
    // answers").
    if (loss.streak === 2 && host.deliveries > 0 && !loss.thisSide) learnPace(host);
    const refused = host.queue.filter(waiter => waiter.address === address);
    host.queue = host.queue.filter(waiter => waiter.address !== address);
    for (const waiter of refused) waiter.refused();
  }

  /**
   * Whether a request to `host` that got no answer was lost on this side of
   * the link, not refused by the host: this computer says it is offline, or
   * it failed in less than half the quickest answer the host ever gave -- a
   * host's refusal (Zenodo's "unusual traffic" page, read as no answer for
   * its missing CORS headers) is an answer, and comes no sooner than its
   * answers do. A loss that took longer (a stall, a timeout) may be either,
   * and counts as the host's.
   *
   * @param {Object} host
   * @param {number|null} elapsedMs - From the request's sending to its loss
   */
  function lostOnThisSide(host, elapsedMs) {
    if (!online()) return true;
    return elapsedMs !== null && Number.isFinite(host.fastestAnswerMs) && elapsedMs < host.fastestAnswerMs / 2;
  }

  /** One more request to `host` is on its way now. */
  function sent(host) {
    const at = now();
    host.inFlight++;
    host.lastSentAt = at;
    host.sentAt.push(at);
    let old = 0;
    while (old < host.sentAt.length && host.sentAt[old] < at - PACE_WINDOW_MS) old++;
    if (old > 0) host.sentAt.splice(0, old);
  }

  /**
   * `host` blocked this network for its requests: its pace lets a window
   * (`PACE_WINDOW_MS`) hold half the requests sent in the window before, and
   * is never faster than a pace known already (a second block halves again).
   * Only a host that answered most of them is taken to refuse their rate.
   */
  function learnPace(host) {
    // A host on this machine blocks no network: its silence is a server restarting or down, which
    // no pace mends (and a pace kept from it would slow every later visit).
    if (isLoopbackUrl(host.origin)) return;
    const at = now();
    const recent = host.sentAt.filter(time => time >= at - PACE_WINDOW_MS).length;
    // A host that answered most of the window's requests before refusing
    // refused their rate; one that answered few of them refuses outright
    // (a failing host, another network's rule), which no pace mends.
    const answered = host.answeredAt.filter(time => time >= at - PACE_WINDOW_MS).length;
    if (recent < 2 || answered * 2 <= recent) return;
    // The window's count was refused, however fast it was sent: the window
    // bears at most half of it.
    const refusedMs = PACE_WINDOW_MS / recent;
    const paceMs = Math.max(2 * refusedMs, host.paceMs > 0 ? 2 * host.paceMs : 0);
    setPace(host, paceMs, true);
  }

  /** `host`'s pace is `paceMs` (never lowered here); `tellOthers`: learned in this realm. */
  function setPace(host, paceMs, tellOthers) {
    if (!(paceMs > host.paceMs) || !Number.isFinite(paceMs)) return;
    host.paceMs = paceMs;
    if (tellOthers) tell({ pace: { origin: host.origin, paceMs } });
    paceWatchers.notify(host.origin, paceMs);
    pump(host);
  }

  /** Ask a host less at once from now on: half of what was on its way (multiplicative decrease). */
  function slowDown(host) {
    host.capCeiling = Math.max(1, host.inFlight + 1);
    host.cap = Math.max(1, Math.floor((host.inFlight + 1) / 2));
  }

  function tellBudget(host) {
    const at = now();
    const wall = epoch();
    tell({
      budget: {
        origin: host.origin,
        limit: host.limit,
        remaining: host.remaining,
        resetEpoch: host.resetAt === null ? null : wall + (host.resetAt - at),
        holdEpoch: host.holdUntil > at ? wall + (host.holdUntil - at) : null,
      },
    });
  }

  if (channel !== null) {
    channel.onmessage = event => {
      const message = event?.data ?? {};
      const origin = message.delivered ?? message.budget?.origin ?? message.pace?.origin ?? null;
      if (typeof origin !== 'string') return;
      const host = hostOf(origin);
      if (typeof message.delivered === 'string') {
        host.deliveries++;
        return;
      }
      if (message.pace !== undefined) {
        setPace(host, Number(message.pace.paceMs), false);
        return;
      }
      const { limit, remaining, resetEpoch, holdEpoch } = message.budget;
      const wall = epoch();
      learnBudget(host, {
        limit: Number.isSafeInteger(limit) ? limit : null,
        remaining: Number.isSafeInteger(remaining) ? remaining : null,
        resetInMs: Number.isFinite(resetEpoch) ? Math.max(0, resetEpoch - wall) : null,
      }, { waitMs: Number.isFinite(holdEpoch) ? holdEpoch - wall : null });
      pump(host);
    };
  }

  return Object.freeze({
    /** Remember that the host of `url` answered a request in `waitedMs`. */
    rememberAnswer(url, waitedMs) {
      const origin = originOf(url);
      if (origin === null || !(waitedMs >= 0)) return;
      hostOf(origin).answeredMs = waitedMs;
    },

    /** How long the host of `url` last took to answer here, or null. */
    rememberedAnswer(url) {
      const origin = originOf(url);
      return origin === null ? null : hosts.get(origin)?.answeredMs ?? null;
    },

    /** Something arrived from the host of `url` (an answer, or a piece of a body). */
    delivered(url) {
      const origin = originOf(url);
      if (origin === null) return;
      const host = hostOf(origin);
      host.deliveries++;
      host.deliveredUrl = String(url);
      const at = now();
      if (at - host.toldAt >= DELIVERY_TOLD_EVERY_MS) {
        host.toldAt = at;
        tell({ delivered: origin });
      }
    },

    /**
     * Whether the host of `url` answered this site so a page could read it
     * (a delivery of any realm of this site): a request to it that gets no
     * such answer now is not refused for CORS.
     */
    answeredBefore(url) {
      const origin = originOf(url);
      return origin !== null && (hosts.get(origin)?.deliveries ?? 0) > 0;
    },

    /**
     * The address of the host of `url` that last delivered to this realm, or
     * null: asked again, it tells a host that still serves this site (and
     * lets it read some of its files, not `url`) from one refusing it.
     */
    deliveredAddress(url) {
      const origin = originOf(url);
      return origin === null ? null : hosts.get(origin)?.deliveredUrl ?? null;
    },

    /**
     * Whether the connection on this side, not the host of `url`, is the
     * likely reason it gave no answer: at least two unrelated sites
     * (`siteOf`) that had answered this site before (so neither CORS nor a
     * mistyped name is why) lost a request within one maximum
     * retransmission timeout (`MAX_QUIET_MS`, RFC 6298 2.5: a request not
     * answered within it is lost by TCP's own measure), and no host has
     * answered since the earliest of those losses. One host's outage leaves
     * the others answering; a dropped connection silences every host at once.
     */
    connectionDown(url) {
      if (originOf(url) === null) return false;
      const at = now();
      const recent = [...lostAt.values()].filter(when => at - when <= MAX_QUIET_MS);
      return recent.length >= 2 && answeredAt < Math.min(...recent);
    },

    /** Whether this computer says it is online (`navigator.onLine`; the book's `online`). */
    online() {
      return online();
    },

    /** How many deliveries of the host of `url` this realm knows of: a watch compares two counts. */
    deliveries(url) {
      const origin = originOf(url);
      return origin === null ? 0 : hosts.get(origin)?.deliveries ?? 0;
    },

    /**
     * Wait until the host of `url` may be sent one more request
     * (`signal` ends the wait), then count it as on its way. Answers what to
     * call once it is answered -- at once when the host may be asked now
     * (nothing waits, so a request goes out in the task that asked for it),
     * else a promise of it: `answered(response, {limiting,
     * waitMs, lost})` with the answer (null: none came), `limiting` when it
     * refused the request for the host's limit, `waitMs` the wait it named
     * for the whole host, `lost` when no answer a page may read came (not
     * a request canceled or ended as stalled). `onWait(info)` hears when the request waits
     * (`{host, untilMs}`, `untilMs` from now, null: until an answer) and
     * `onWait(null)` when it no longer does.
     *
     * `waits` false: a request whose answer is optional (GitHub's commit of a
     * file, without which it is read at its branch) is not held for the
     * budget: null when the host may not be asked now.
     *
     * `burst`: one of many requests to its address, sent without a person
     * asking each: `true`, a file's range reads, whose address is the URL;
     * a URL, the address the request is one of (a store folder's root, for
     * each of its objects). Its losses are counted by address, and while
     * the address is left unasked it fails unsent (`HostNotAnswering`). A
     * provider's request (a record, a file's details) is asked as the
     * person asked (`withRetries`: twice).
     *
     * @param {string} url
     * @param {{signal?: AbortSignal|null, onWait?: ((info: {host: string, untilMs: number|null, limit: number|null}|null) => void)|null,
     *   waits?: boolean, burst?: boolean|string}} [options]
     * @returns {Answered|Promise<Answered>|null} `Answered`: `(response: Response|null,
     *   options?: {limiting?: boolean, waitMs?: number|null}) => void`
     */
    admit(url, { signal = null, onWait = null, waits = true, burst = false } = {}) {
      const origin = originOf(url);
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      if (origin === null) return () => {};
      const host = hostOf(origin);
      // The address lost requests are counted by (one file's ranges are one,
      // one folder's objects are one), and the round this request is sent
      // in (`lossesOf`).
      const address = addressOf(typeof burst === 'string' ? burst : url);
      let round = null;
      // When this request was sent (null until then).
      let sentMs = null;
      // Whether this request is the one probe asked of an address that stopped answering.
      let probe = false;
      const answered = (response, { limiting = false, waitMs = null, lost = false } = {}) => {
        host.inFlight = Math.max(0, host.inFlight - 1);
        const elapsedMs = sentMs === null ? null : now() - sentMs;
        if (probe) {
          const loss = host.losses.get(address);
          if (loss !== undefined) loss.probing = false;
        }
        if (response === null && lost) {
          if (burst && round === (host.losses.get(address)?.round ?? 0)) lose(host, address, lostOnThisSide(host, elapsedMs));
          // Only a host that answered this site before is a witness: a new
          // host's silence may be CORS or a mistyped name, not the connection.
          if (host.deliveries > 0) lostAt.set(siteOf(origin), now());
        } else if (response !== null) {
          answeredAt = now();
          lostAt.delete(siteOf(origin));
          host.losses.delete(address);
          if (elapsedMs !== null) host.fastestAnswerMs = Math.min(host.fastestAnswerMs, elapsedMs);
          const at = now();
          host.answeredAt.push(at);
          let old = 0;
          while (old < host.answeredAt.length && host.answeredAt[old] < at - PACE_WINDOW_MS) old++;
          if (old > 0) host.answeredAt.splice(0, old);
        }
        const said = response === null ? null : budgetOf(response.headers, epoch());
        if (response !== null && !limiting && host.cap !== Infinity) {
          // A host answering again earns back one request at once per round.
          host.cap += 1 / host.cap;
          if (host.cap >= host.capCeiling) {
            host.cap = Infinity;
            host.capCeiling = Infinity;
          }
        }
        learnBudget(host, said, { limiting, waitMs });
        if (said !== null || limiting || (waitMs ?? 0) > 0) tellBudget(host);
        pump(host);
      };
      // A host that stopped answering is not asked until its quiet ends, and
      // then by one request, the probe, until it is answered or lost: the
      // reads waiting it out (`byte-source.js` `refusesForNow`) never send
      // one each when they wake.
      const loss = burst ? host.losses.get(address) : undefined;
      // Requests lost while this computer was offline say nothing of the
      // host: once it is online again, the address is asked at once, not
      // after the rest of a quiet meant for a host.
      if (loss !== undefined && loss.offline && online() && loss.quietUntil > now()) {
        loss.quietUntil = -Infinity;
        loss.probing = false;
      }
      if (loss !== undefined && (now() < (loss.quietUntil ?? -Infinity) || (loss.streak >= 2 && loss.probing === true))) {
        return waits ? Promise.reject(new HostNotAnswering(new URL(origin).host)) : null;
      }
      if (loss !== undefined && loss.streak >= 2) {
        loss.probing = true;
        probe = true;
      }
      const free = nextFree(host);
      if (host.queue.length === 0 && free <= now()) {
        sent(host);
        sentMs = now();
        round = host.losses.get(address)?.round ?? 0;
        return answered;
      }
      if (!waits) return null;
      return new Promise((resolve, reject) => {
        let told = false;
        const waiter = {
          admitted: () => {
            stopWaiting();
            if (told) onWait?.(null);
            sent(host);
            sentMs = now();
            round = host.losses.get(address)?.round ?? 0;
            resolve(answered);
          },
          address: burst ? address : null,
          refused: () => {
            stopWaiting();
            if (told) onWait?.(null);
            reject(new HostNotAnswering(new URL(origin).host));
          },
          waiting: untilAt => {
            if (told) return;
            told = true;
            onWait?.({ host: new URL(origin).host, untilMs: Number.isFinite(untilAt) ? Math.max(0, untilAt - now()) : null, limit: host.limit });
          },
        };
        // Queued first: a signal stopped already takes it out again at once.
        host.queue.push(waiter);
        const stopWaiting = onAbort(signal, () => {
          const at = host.queue.indexOf(waiter);
          if (at >= 0) host.queue.splice(at, 1);
          if (told) onWait?.(null);
          reject(abortReason(signal));
        });
        pump(host);
      });
    },

    /**
     * What one more request to the host of `url` costs in time, as its
     * request budget prices it: 0 while the host has stated no budget (or
     * no window). Otherwise the budget's interval, its window over its limit
     * (Zenodo: 60 s / 133, 0.45 s; the window learned from the longest reset
     * stated whole), in the share of this window already spent: a request
     * is nearly free while most of the window remains, so early reads stay
     * exact, and costs the whole interval once nothing remains for what is
     * asked, or once a request has waited for the budget. Readers price a
     * request at no less (`link.js` `requestCostMs`, which `requestMs` and the
     * byte reader's `planMergeGap` read): as the budget runs down
     * they read through larger gaps, so an opening fits the window in fewer,
     * larger requests instead of waiting for the next one.
     */
    requestCostMs(url) {
      const origin = originOf(url);
      const host = origin === null ? undefined : hosts.get(origin);
      if (host === undefined) return 0;
      // A pace learned from a block binds every request (`learnPace`).
      if (!(host.limit > 0) || !(host.windowMs > 0)) return host.paceMs;
      const interval = host.windowMs / host.limit;
      const left = host.remaining === null ? host.limit : host.remaining - host.inFlight - host.queue.length;
      if (host.bound || left <= 0) return Math.max(interval, host.paceMs);
      return Math.max(host.paceMs, interval * Math.min(1, Math.max(0, 1 - left / host.limit)));
    },

    /** The least time between two requests to the host of `url` it was found to bear (0: none known). */
    pace(url) {
      const origin = originOf(url);
      return origin === null ? 0 : hosts.get(origin)?.paceMs ?? 0;
    },

    /**
     * Start the host of `url` (a URL or an origin) at a pace kept from an
     * earlier visit (`data/host-link-memory.js`): its requests are spaced
     * at least `paceMs` apart. Never makes a known pace faster.
     */
    seedPace(url, paceMs) {
      const origin = originOf(url);
      if (origin === null || !(paceMs > 0)) return;
      setPace(hostOf(origin), paceMs, false);
    },

    /** Hear every host's pace as it is learned or told (`(origin, paceMs) => void`); returns what stops it. */
    watchPace(listener) {
      return paceWatchers.add(listener);
    },
    /**
     * How long the host of `url` is held now (milliseconds; 0 when it may be
     * asked): a wait it named, or, with nothing of its budget left and
     * nothing on its way, its reset.
     */
    heldForMs(url) {
      const origin = originOf(url);
      const host = origin === null ? undefined : hosts.get(origin);
      if (host === undefined) return 0;
      const at = now();
      let until = host.holdUntil;
      if (host.remaining !== null && host.remaining - host.inFlight <= 0 && host.inFlight === 0 && host.resetAt !== null) {
        until = Math.max(until, host.resetAt);
      }
      return Math.max(0, until - at);
    },

    /** What this realm knows of the host of `url`'s budget (tests, the Transfers log). */
    budget(url) {
      const origin = originOf(url);
      const host = origin === null ? undefined : hosts.get(origin);
      if (host === undefined) return null;
      const at = now();
      return {
        limit: host.limit,
        remaining: host.remaining,
        resetInMs: host.resetAt === null ? null : Math.max(0, host.resetAt - at),
        heldForMs: Math.max(0, host.holdUntil - at),
        inFlight: host.inFlight,
        cap: host.cap,
        waiting: host.queue.length,
      };
    },
  });
}

function realmChannel() {
  if (typeof BroadcastChannel !== 'function') return null;
  try {
    const channel = new BroadcastChannel(HOSTS_CHANNEL);
    // Node keeps an open channel's process alive; a browser never does.
    channel.unref?.();
    return channel;
  } catch {
    return null;
  }
}

/** This realm's book of hosts: every request of the page, or of one worker, is counted in it. */
export const realmHosts = createHostBook({ channel: realmChannel() });
