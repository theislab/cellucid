/**
 * @fileoverview The page's side of the memory model (`data/memory-budget.js`):
 *
 * - **Other pages**: the page joins its origin's census of Cellucid pages
 *   (`data/memory-census.js`) for as long as it is shown or hidden, and
 *   leaves it while it waits in the back/forward cache (where it holds
 *   nothing that counts, and holding a lock would keep it out of the cache).
 * - **Hidden**: a page the person does not see keeps only what it draws.
 *   Every cache cheaper to rebuild than the gene-column index is let go at
 *   once (`releaseResidentMemory('caches')`, in every thread: field data no
 *   view shows, cached copies, page values of analyses, unshown layouts, a
 *   latent hold, decoded chunks, fetched bytes), and every idle worker ends
 *   (`workers/idle-retirement.js`). Everything comes back on demand when the
 *   page is shown again; what is drawn never left.
 * - **Frozen** (the browser froze a background page: `freeze`, Chromium) or
 *   put in the back/forward cache: the gene-column index goes too
 *   (`releaseResidentMemory('all')`): the page may not come back, and a
 *   phone ends pages that hold memory first.
 * - **Short of memory**: when a refused allocation made the caches give
 *   memory back (`'refused'`, in any thread), one notice says what went.
 * - **Ended while opening**: an opening under way is marked in this tab's
 *   session storage (`OPENING_MARK`, nothing but the mark), and the mark goes
 *   when the opening ends or the page is left (a reload, a navigation: both
 *   fire `pagehide`). A browser that ends the tab itself, as a phone ends one
 *   that holds more memory than it lets it, fires nothing, and the next load
 *   of the tab finds the mark: the memory model halves its allowance
 *   (`recordInterruptedOpening`), so the opening fits half the cells, and one
 *   notice says why.
 *
 * @module app/page-memory
 */

import { onMemoryReleased, recordInterruptedOpening, releaseResidentMemory } from '../data/memory-budget.js';
import { getOpeningProgress } from '../data/opening-progress.js';
import { joinMemoryCensus } from '../data/memory-census.js';
import { retireIdleWorkers } from '../workers/idle-retirement.js';
import { PLACES, placePath } from './ui/place-names.js';

/** The notice of what a refusal made the caches give back. */
const SHORT_OF_MEMORY_NOTICE = 'memory-short';

/** The session-storage mark of an opening under way in this tab. */
export const OPENING_MARK = 'cellucid:opening-under-way';

/** Session storage, or null where the browser refuses it (a private window may). */
function sessionStorageOf(windowOwner) {
  try {
    return windowOwner.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** `a`, `a and b`, `a, b and c`. */
function joinWords(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * Wire the page to the memory model for its life.
 *
 * @param {{notifications: {show: Function, hasNotification: Function}, documentOwner?: Document, windowOwner?: Window}} options
 * @returns {() => void} Unwire (the application is retired)
 */
export function initPageMemory({ notifications, documentOwner = document, windowOwner = window, opening = getOpeningProgress() }) {
  let leaveCensus = joinMemoryCensus();

  // This tab ended while it opened a dataset, last time.
  const storage = sessionStorageOf(windowOwner);
  const mark = on => {
    try {
      if (on) storage?.setItem(OPENING_MARK, '1');
      else storage?.removeItem(OPENING_MARK);
    } catch {
      // A browser that keeps nothing for the tab: nothing is learnt.
    }
  };
  let interrupted = false;
  try {
    interrupted = storage?.getItem(OPENING_MARK) === '1';
  } catch {
    interrupted = false;
  }
  mark(false);
  if (interrupted && recordInterruptedOpening()) {
    notifications.show({
      type: 'warning',
      category: 'data',
      message:
        'This tab stopped while it was opening a dataset, most likely because the browser ran out of memory ' +
        `for it, so Cellucid now opens half as many cells. Cells to open (${placePath(PLACES.session, PLACES.subsampling)}) sets how many.`,
      duration: 0,
    });
  }
  const stopWatchingOpenings = opening.subscribe(snapshot => mark(snapshot?.state === 'running'));
  const onLeave = () => mark(false);
  windowOwner.addEventListener('pagehide', onLeave);

  const onVisibility = () => {
    if (documentOwner.visibilityState !== 'hidden') return;
    releaseResidentMemory('caches', 'hidden');
    retireIdleWorkers();
  };
  const onFreeze = () => {
    releaseResidentMemory('all', 'frozen');
    retireIdleWorkers();
  };
  const onPageHide = event => {
    if (event.persisted !== true) return;
    onFreeze();
    leaveCensus?.();
    leaveCensus = null;
  };
  const onPageShow = event => {
    if (event.persisted !== true || leaveCensus !== null) return;
    leaveCensus = joinMemoryCensus();
  };
  documentOwner.addEventListener('visibilitychange', onVisibility);
  documentOwner.addEventListener('freeze', onFreeze);
  windowOwner.addEventListener('pagehide', onPageHide);
  windowOwner.addEventListener('pageshow', onPageShow);

  // One notice per shortage, naming what every thread let go.
  let said = [];
  const stopHearing = onMemoryReleased(({ reason, released }) => {
    if (reason !== 'refused') return;
    if (!notifications.hasNotification(SHORT_OF_MEMORY_NOTICE)) said = [];
    for (const words of released) if (!said.includes(words)) said.push(words);
    notifications.show({
      id: SHORT_OF_MEMORY_NOTICE,
      type: 'info',
      category: 'data',
      message: `Memory was running short, so Cellucid let go of ${joinWords(said)}. They are read again when needed.`,
      duration: 6000,
    });
  });

  return () => {
    stopWatchingOpenings();
    windowOwner.removeEventListener('pagehide', onLeave);
    mark(false);
    documentOwner.removeEventListener('visibilitychange', onVisibility);
    documentOwner.removeEventListener('freeze', onFreeze);
    windowOwner.removeEventListener('pagehide', onPageHide);
    windowOwner.removeEventListener('pageshow', onPageShow);
    stopHearing();
    leaveCensus?.();
    leaveCensus = null;
  };
}
