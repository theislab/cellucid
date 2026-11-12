/**
 * @fileoverview The Stored row under Open data: what is kept in this browser
 * for later visits (`data/anndata/transcode/space.js`: files that cannot be
 * read in parts, converted once — R objects, MatrixMarket folders — files a
 * host serves only whole, and the gene indexes of matrices stored cell by
 * cell, `data/anndata/kept-column-index.js`), in one short summary, with
 * Manage…, which opens the Stored dialog (`kept-stores-dialog.js`) listing
 * every item by dataset, the saved states of histories
 * (`app/history/autosave.js`), My datasets (`app/library/my-datasets.js`,
 * listed in its own dialog; it has its own control above, so this line does
 * not count it) and the connection speeds remembered per host
 * (`data/host-link-memory.js`).
 *
 * Hidden while nothing is kept, except in a window that gives the site no
 * storage that lasts (a private window): there it says so, and Manage…
 * shows where data is kept (`keptStoragePlace`). Refreshed when the app starts, whenever an
 * opening ends (it may have kept a file), and whenever what this page holds
 * or removed changed (`space.js` `onKeptStoresChange`).
 *
 * @module ui/modules/kept-stores-line
 */

import { keptStoragePlace, listKeptStores, onKeptStoresChange } from '../../../data/anndata/transcode/space.js';
import { rememberedHosts } from '../../../data/host-link-memory.js';
import { listSavedStates, onSavedStatesChange } from '../../history/autosave.js';
import { getOpeningProgress } from '../../../data/opening-progress.js';
import { formatBytes, formatCountOf } from '../../../utils/format-units.js';

/**
 * The summary of what is kept, beside Manage… on one line at the narrowest
 * panel (`text`), and the whole of it (`title`); both '' when nothing is.
 * The line names the datasets something is kept of (a converted copy, its
 * download, gene indexes and downloaded parts of one file are one dataset)
 * and the bytes all of it takes ("2 datasets · 540 MB kept"); the rest --
 * saved states of histories, hosts whose connection speed is remembered --
 * are named in the title and listed by Manage… (a count of unlike things,
 * "· 23 more", said nothing and ran under Manage…: found 2026-11-10); with
 * no dataset, the one kind kept ("1 connection speed") or how many items
 * ("3 items"). The title names each ("2 datasets · 540 MB · 2 saved states
 * · 1 connection speed").
 *
 * @param {ReadonlyArray<import('../../../data/anndata/transcode/space.js').KeptItem>} items
 * @param {number} [hosts] - the hosts whose connection speed is remembered
 * @param {number} [saved] - the saved states kept
 * @returns {{text: string, title: string}}
 */
export function summarizeKeptStores(items, hosts = 0, saved = 0) {
  const also = [
    ...(saved > 0 ? [formatCountOf(saved, 'saved state')] : []),
    ...(hosts > 0 ? [formatCountOf(hosts, 'connection speed')] : []),
  ];
  const others = saved + hosts;
  if (items.length === 0) {
    if (also.length === 0) return { text: '', title: '' };
    return { text: also.length === 1 ? also[0] : formatCountOf(others, 'item'), title: also.join(' · ') };
  }
  const datasets = new Set(items.map(item => item.file)).size;
  const bytes = items.reduce((sum, item) => sum + item.bytes, 0);
  const kept = `${formatCountOf(datasets, 'dataset')} · ${formatBytes(bytes)}`;
  if (also.length === 0) return { text: `${kept} kept`, title: `${kept} kept` };
  return { text: `${kept} kept`, title: [kept, ...also].join(' · ') };
}

/** What the row says in a window that gives the site no storage that lasts. */
const KEPT_UNTIL_TAB_CLOSES = 'Kept for this tab only';

/**
 * @param {{root: HTMLElement, text: HTMLElement, manage: HTMLButtonElement}} dom
 * @param {{opening?: Object, list?: () => Promise<Array>, place?: () => Promise<{available: boolean}>,
 *   hosts?: () => Array, savedStates?: () => Promise<Array>, changes?: (listener: () => void) => (() => void),
 *   savedChanges?: (listener: () => void) => (() => void), onManage?: (opener: HTMLElement) => void}} [options] -
 *   `hosts`: the connection speeds remembered; `savedStates`: the saved states of histories; `onManage`: open the
 *   Stored dialog
 * @returns {{refresh: () => Promise<void>, destroy: () => void}}
 */
export function initKeptStoresLine(dom, {
  opening = getOpeningProgress(), list = listKeptStores, place = keptStoragePlace, hosts = rememberedHosts,
  savedStates = listSavedStates, changes = onKeptStoresChange, savedChanges = onSavedStatesChange, onManage = () => {},
} = {}) {
  if (!dom?.root || !dom?.text || !dom?.manage) throw new TypeError('The Stored row needs its root, text and Manage button.');
  let generation = 0;
  let lastState = null;

  async function refresh() {
    const mine = ++generation;
    const [items, where, savedList] = await Promise.all([list(), place(), savedStates()]);
    if (mine !== generation) return;
    // A window that keeps nothing says so instead of what it holds for this visit.
    const summary = where.available ? summarizeKeptStores(items, hosts().length, savedList.length) : { text: KEPT_UNTIL_TAB_CLOSES, title: KEPT_UNTIL_TAB_CLOSES };
    dom.text.textContent = summary.text;
    dom.text.title = summary.title;
    dom.root.hidden = summary.text === '';
  }

  const manage = () => onManage(dom.manage);
  dom.manage.addEventListener('click', manage);
  const stopChanges = changes(() => void refresh());
  const stopSavedChanges = savedChanges(() => void refresh());
  const unsubscribe = opening.subscribe(snapshot => {
    const state = snapshot?.state ?? null;
    if (state !== lastState && state !== 'running') void refresh();
    lastState = state;
  });
  void refresh();
  return {
    refresh,
    destroy() {
      unsubscribe();
      stopChanges();
      stopSavedChanges();
      dom.manage.removeEventListener('click', manage);
    },
  };
}
