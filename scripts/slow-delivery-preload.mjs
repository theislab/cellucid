/**
 * A machine where asynchronous delivery is slow and timers are coarse, as a
 * loaded Windows CI runner is: preloaded into the contract suite, it shows
 * the tests that pass only because a message, a worker's answer or a timer
 * came quickly.
 *
 *   NODE_OPTIONS="--import ./scripts/slow-delivery-preload.mjs" npm test
 *
 * - Every `message` and `close` event of a `MessagePort` or a
 *   `BroadcastChannel` (and so of `worker_threads` ports) reaches its
 *   listeners a random 0..`SLOW_DELIVERY_MS` (default 25) ms late, in the
 *   order it arrived on its port, as the platform keeps it; the messages of
 *   one drain of a port (posted in one task) are handed over in one task,
 *   as the platform does. (Unlike the platform, no microtask checkpoint
 *   runs between them.) Messages still pending when their port is closed
 *   on this side are dropped.
 * - Every timer comes due when Node says, in Node's order, and its callback
 *   then waits for the next `SLOW_TIMER_TICK_MS` (default 16) ms boundary,
 *   where every callback that came due since runs in the order it came due:
 *   Windows' default timer resolution is 15.6 ms, so a `setTimeout(…, 1)`
 *   there takes up to 16 ms.
 *
 * A test that fails under it waits a fixed time for something it should
 * wait for the event of (`tests/helpers/until.mjs`); the rule and its
 * classes are in the web developer docs ("Contract tests that hold on every
 * Node version and operating system").
 */
import module from 'node:module';
import timers from 'node:timers';
import timersPromises from 'node:timers/promises';

const DELAY_MS = Number(process.env.SLOW_DELIVERY_MS ?? 25);
const TICK_MS = Number(process.env.SLOW_TIMER_TICK_MS ?? 16);
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const realClearTimeout = globalThis.clearTimeout;
const realClearInterval = globalThis.clearInterval;

/** A callback's error, thrown where Node would have: uncaught, on its own. */
function rethrow(error) {
  process.nextTick(() => { throw error; });
}

// ---- coarse timers ---------------------------------------------------------

/** Callbacks of timers that came due, waiting for the next tick. */
const due = [];
let tick = null;
/** A timer (or its numeric id) -> its entry, until it ran or was cleared. */
const entryOf = new Map();

function runTick() {
  tick = null;
  for (const entry of due.splice(0)) {
    if (entry.cancelled) continue;
    if (!entry.repeat) forget(entry);
    try {
      entry.callback.apply(entry.timer, entry.args);
    } catch (error) {
      rethrow(error);
    }
  }
}

function cameDue(entry) {
  due.push(entry);
  if (tick !== null) return;
  const now = performance.now();
  tick = realSetTimeout(runTick, Math.max(1, Math.ceil(now / TICK_MS) * TICK_MS - now));
}

function forget(entry) {
  entryOf.delete(entry.timer);
  entryOf.delete(entry.id);
}

function coarse(real, repeat) {
  return function coarseTimer(callback, ms, ...args) {
    // A delay past what a timer holds (2^31 - 1 ms) is Node's to handle.
    if (typeof callback !== 'function' || !(Number(ms) < 2 ** 31 - 1)) return real(callback, ms, ...args);
    const entry = { callback, args, repeat, cancelled: false, timer: null, id: NaN };
    entry.timer = real(() => cameDue(entry), ms);
    entry.id = Number(entry.timer[Symbol.toPrimitive]?.() ?? NaN);
    entryOf.set(entry.timer, entry);
    if (Number.isFinite(entry.id)) entryOf.set(entry.id, entry);
    return entry.timer;
  };
}

function coarseClear(real) {
  return function clearCoarseTimer(timer) {
    const entry = entryOf.get(timer) ?? entryOf.get(Number(timer));
    if (entry === undefined) return real(timer);
    entry.cancelled = true;
    forget(entry);
    return real(entry.timer);
  };
}

const coarseSetTimeout = coarse(realSetTimeout, false);
const coarseSetInterval = coarse(realSetInterval, true);
const realPromiseTimeout = timersPromises.setTimeout;
const coarsePromiseTimeout = async (ms, value, options) => {
  const result = await realPromiseTimeout(ms, value, options);
  await new Promise(resolve => coarseSetTimeout(resolve, 0));
  return result;
};
Object.defineProperty(coarseSetTimeout, Symbol.for('nodejs.util.promisify.custom'), { get: () => coarsePromiseTimeout });
globalThis.setTimeout = timers.setTimeout = coarseSetTimeout;
globalThis.setInterval = timers.setInterval = coarseSetInterval;
globalThis.clearTimeout = timers.clearTimeout = coarseClear(realClearTimeout);
globalThis.clearInterval = timers.clearInterval = coarseClear(realClearInterval);
timersPromises.setTimeout = coarsePromiseTimeout;
module.syncBuiltinESMExports();

// ---- slow, ordered delivery ------------------------------------------------

/** A port -> the events it delivers late: `{items, last, timer, drain}`. */
const queues = new WeakMap();
/** An event (or, to a Node-style listener, its data) -> when it is handed over. */
const releaseOf = new WeakMap();
const closedHere = new WeakSet();

function deliverLate(target, event, run, droppable) {
  let queue = queues.get(target);
  if (queue === undefined) {
    queue = { items: [], last: 0, timer: null, drain: null };
    queues.set(target, queue);
  }
  const keyed = event !== null && typeof event === 'object';
  let release = keyed ? releaseOf.get(event) : undefined;
  // The events of one drain of the port go together; the next drain is
  // delayed on its own, never before this one.
  if (release === undefined && queue.drain !== null) release = queue.drain;
  if (release === undefined) {
    release = Math.max(queue.last, performance.now() + Math.random() * DELAY_MS);
    queue.drain = release;
    setImmediate(() => { queue.drain = null; });
  }
  if (keyed) releaseOf.set(event, release);
  queue.last = Math.max(queue.last, release);
  queue.items.push({ release, run, droppable });
  handOver(target, queue);
}

function handOver(target, queue) {
  if (queue.timer !== null || queue.items.length === 0) return;
  queue.timer = realSetTimeout(() => {
    queue.timer = null;
    const now = performance.now();
    while (queue.items.length > 0 && queue.items[0].release <= now + 0.5) {
      const item = queue.items.shift();
      if (item.droppable && closedHere.has(target)) continue;
      try {
        item.run();
      } catch (error) {
        rethrow(error);
      }
    }
    handOver(target, queue);
  }, Math.max(0, queue.items[0].release - performance.now()));
}

const isChannel = target => target instanceof MessagePort || target instanceof BroadcastChannel;
/** A listener -> a port -> a type -> the listener registered in its place. */
const standIns = new WeakMap();
const addEventListener = EventTarget.prototype.addEventListener;
const removeEventListener = EventTarget.prototype.removeEventListener;

EventTarget.prototype.addEventListener = function (type, listener, options) {
  if (listener == null || (type !== 'message' && type !== 'close') || !isChannel(this)) {
    return addEventListener.call(this, type, listener, options);
  }
  if (!standIns.has(listener)) standIns.set(listener, new Map());
  const byPort = standIns.get(listener);
  if (!byPort.has(this)) byPort.set(this, new Map());
  const byType = byPort.get(this);
  if (!byType.has(type)) {
    const port = this;
    byType.set(type, function lateListener(event) {
      deliverLate(port, event, () => {
        if (typeof listener === 'function') listener.call(this, event);
        else listener.handleEvent(event);
      }, type === 'message');
    });
  }
  return addEventListener.call(this, type, byType.get(type), options);
};

EventTarget.prototype.removeEventListener = function (type, listener, options) {
  const standIn = listener == null ? undefined : standIns.get(listener)?.get(this)?.get(type);
  return removeEventListener.call(this, type, standIn ?? listener, options);
};

for (const Channel of [MessagePort, BroadcastChannel]) {
  const close = Channel.prototype.close;
  Channel.prototype.close = function (...args) {
    closedHere.add(this);
    return close.apply(this, args);
  };
}
