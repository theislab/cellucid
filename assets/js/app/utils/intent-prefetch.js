/**
 * @fileoverview Prefetch on intent.
 *
 * An option the pointer rests on, or the keyboard keeps active, for a moment
 * is loaded before it is chosen, so choosing it draws at once instead of after
 * a round trip and a decode. One option at a time: moving on cancels the
 * previous prefetch. A prefetch that fails or is cancelled has no one to tell —
 * choosing the option loads it again and reports any failure then — and the
 * load it starts is the shared field load, so choosing the same option joins
 * it rather than starting another.
 *
 * @module utils/intent-prefetch
 */

import { cancelled } from '../../utils/abort.js';
import { debounce } from '../../utils/debounce.js';

/**
 * How long an option has to stay under the pointer or active before it is
 * prefetched: long enough that sweeping across a list starts nothing, short
 * against the time it takes to decide and click.
 */
const INTENT_PREFETCH_DWELL_MS = 150;

/**
 * @template Key
 * @param {(key: Key, signal: AbortSignal) => Promise<unknown>} prefetch
 * @param {number} [dwellMs]
 * @returns {{ intend: (key: Key) => void, cancel: () => void, current: () => Key|undefined }}
 */
export function createIntentPrefetcher(prefetch, dwellMs = INTENT_PREFETCH_DWELL_MS) {
  if (typeof prefetch !== 'function') {
    throw new TypeError('Intent prefetcher requires a prefetch function');
  }
  let controller = null;
  /** @type {Key|undefined} */
  let intended;
  // An option is prefetched once it stayed intended for `dwellMs`.
  const prefetchAfterDwell = debounce(key => {
    const own = new AbortController();
    controller = own;
    void Promise.resolve()
      .then(() => prefetch(key, own.signal))
      .catch(() => {})
      .finally(() => {
        if (controller === own) controller = null;
      });
  }, dwellMs);

  function cancel() {
    prefetchAfterDwell.cancel();
    controller?.abort(cancelled('superseded', 'The prefetch was superseded.'));
    controller = null;
    intended = undefined;
  }

  function intend(key) {
    if (key === intended) return;
    cancel();
    intended = key;
    prefetchAfterDwell(key);
  }

  return { intend, cancel, current: () => intended };
}
