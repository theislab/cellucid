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
/** @type {Array<() => void>} */
const waiting = [];

function sharedChannel() {
  if (channel !== null) return channel;
  channel = new MessageChannel();
  channel.port1.onmessage = () => {
    const resolve = waiting.shift();
    resolve?.();
  };
  return channel;
}

/**
 * Resolve after one macrotask.
 *
 * @returns {Promise<void>}
 */
export function yieldToMacrotask() {
  // Node drains a port's queue within one callback, so there a yield over
  // the channel would never let timers run; setImmediate is its macrotask.
  if (typeof setImmediate === 'function') {
    return new Promise(resolve => setImmediate(resolve));
  }
  if (typeof MessageChannel !== 'function') {
    return new Promise(resolve => setTimeout(resolve, 0));
  }
  const { port2 } = sharedChannel();
  return new Promise(resolve => {
    waiting.push(resolve);
    port2.postMessage(null);
  });
}
