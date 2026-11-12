/**
 * @fileoverview The Cellucid pages of one origin divide the device's memory
 * (`memory-budget.js` `setOtherInstances`): each page counts how many others
 * are open and what they hold, drawn and kept, so it uses what the others do
 * not (and at least an equal share).
 *
 * - **Who is open** is known from Web Locks: each page holds one exclusive
 *   lock named for it (`cellucid-memory:<id>`) for its life, and asks for
 *   every other page's lock as soon as it hears of it; the browser grants
 *   that request when the other page is gone (closed, crashed, discarded),
 *   with no timer. A page frozen in the back/forward cache keeps its lock.
 * - **What each holds** is told on a `BroadcastChannel`: a page announces
 *   itself and what it holds whenever that changes (`onHeldChange`), says
 *   goodbye when it is left, and answers a newcomer's hello.
 *
 * Pages see each other only within one storage partition: tabs of one site,
 * or the notebook widgets of one notebook page (each widget an `<iframe>` of
 * the same site, partitioned under the notebook's). A Cellucid tab and a
 * notebook widget, or pages on different hosts, each count only themselves.
 * Where Web Locks or `BroadcastChannel` are missing (a page that is not a
 * secure context), a page counts only itself.
 *
 * @module data/memory-census
 */

import { onHeldChange, setOtherInstances } from './memory-budget.js';
import { createOpaqueId } from '../utils/opaque-id.js';

const CHANNEL = 'cellucid-memory';
const LOCK_PREFIX = 'cellucid-memory:';

/**
 * Join the census of this origin's Cellucid pages, for this page's life.
 *
 * @param {Object} [environment] - `globalThis`, or a stand-in in tests
 * @returns {(() => void)|null} Leave the census (the page is left), or null
 *   where this browser offers no way to count the others
 */
export function joinMemoryCensus(environment = globalThis) {
  const locks = environment.navigator?.locks;
  const Channel = environment.BroadcastChannel;
  if (typeof locks?.request !== 'function' || typeof Channel !== 'function') return null;

  const id = createOpaqueId();
  const channel = new Channel(CHANNEL);
  /** The other pages and what each holds, by id. @type {Map<string, number>} */
  const others = new Map();
  let held = 0;
  let left = false;

  // This page's lock, held until it is left.
  let releaseOwn = null;
  const own = new Promise(resolve => { releaseOwn = resolve; });
  void locks.request(`${LOCK_PREFIX}${id}`, { mode: 'exclusive' }, () => own).catch(() => {});

  const publish = () => {
    let total = 0;
    for (const bytes of others.values()) total += bytes;
    setOtherInstances({ count: others.size, heldBytes: total });
  };

  const say = message => {
    if (!left) channel.postMessage({ id, ...message });
  };

  /** Hear of another page: counted until the browser grants its lock (it is gone). */
  const meet = (other, bytes) => {
    const known = others.has(other);
    others.set(other, bytes);
    publish();
    if (known) return;
    void locks.request(`${LOCK_PREFIX}${other}`, { mode: 'exclusive' }, () => {
      // Granted: the other page is gone.
      if (others.delete(other)) publish();
    }).catch(() => {});
  };

  channel.onmessage = event => {
    const message = event.data;
    if (left || message === null || typeof message !== 'object' || typeof message.id !== 'string' || message.id === id) return;
    if (message.bye === true) {
      if (others.delete(message.id)) publish();
      return;
    }
    const bytes = Number.isFinite(message.held) && message.held >= 0 ? message.held : 0;
    meet(message.id, bytes);
    // A newcomer is told what this page holds.
    if (message.hello === true) say({ held });
  };

  const stopHearing = onHeldChange(bytes => {
    held = bytes;
    say({ held });
  });
  say({ hello: true, held });

  return () => {
    if (left) return;
    say({ bye: true });
    left = true;
    stopHearing();
    channel.close();
    releaseOwn();
    others.clear();
    setOtherInstances({ count: 0, heldBytes: 0 });
  };
}
