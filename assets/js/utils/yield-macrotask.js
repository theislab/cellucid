/**
 * @fileoverview Yield to the event loop for one macrotask, without the
 * setTimeout clamping a long loop would otherwise accrue.
 *
 * One MessageChannel, held by this module for the life of the realm, carries
 * every yield; the resolvers wait in order. A channel made per yield and
 * referenced only by its own handler can be garbage-collected with its
 * message still pending in WebKit, which leaves the awaiting loop -- and
 * everything queued behind it -- waiting forever. A channel this module
 * holds cannot be collected.
 *
 * @module utils/yield-macrotask
 */

/** @type {{port1: MessagePort, port2: MessagePort}|null} */
let channel = null;
/** @type {Array<() => void>} The callbacks waiting, in order. */
const waiting = [];

function sharedChannel() {
  if (channel !== null) return channel;
  channel = new MessageChannel();
  channel.port1.onmessage = () => {
    const next = waiting.shift();
    next?.();
  };
  return channel;
}

/**
 * Run `callback` on a later macrotask: after the current task and every
 * promise continuation it queued (so every read asked for in one task joins
 * one burst, one gesture's events are told from the next one's). The one
 * scheduler of the page and its workers; `setTimeout(…, 0)` is clamped to
 * 4 ms once nested, and a `MessageChannel` made per call can be collected
 * with its message pending in WebKit (above).
 *
 * @param {() => void} callback
 */
export function onNextMacrotask(callback) {
  // Node drains a port's queue within one callback, so there a yield over
  // the channel would never let timers run; setImmediate is its macrotask.
  if (typeof setImmediate === 'function') {
    setImmediate(callback);
    return;
  }
  if (typeof MessageChannel !== 'function') {
    setTimeout(callback, 0);
    return;
  }
  const { port2 } = sharedChannel();
  waiting.push(callback);
  port2.postMessage(null);
}

/**
 * Resolve after one macrotask (`onNextMacrotask`).
 *
 * @returns {Promise<void>}
 */
export function yieldToMacrotask() {
  return new Promise(resolve => onNextMacrotask(resolve));
}
