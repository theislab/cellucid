/**
 * @fileoverview One line under Open data saying what files that cannot be
 * read in parts are kept in this browser for later visits
 * (`data/anndata/transcode/space.js`: R objects, MatrixMarket folders,
 * files a host serves only whole), and of which files stored cell by cell
 * the gene index is kept (`data/anndata/kept-column-index.js`), with Clear.
 *
 * Hidden while nothing is kept. Refreshed when the app starts, whenever an
 * opening ends (it may have kept a file), and whenever this page starts
 * holding something newly kept (a gene index run kept in the background
 * after its opening ended: `space.js` `onKeptStoresChange`). Clear is
 * offered while anything kept is used by no open tab, and removes all of
 * that; what an open tab uses stays until that tab closes, and the line
 * says how many files that is.
 *
 * @module ui/modules/kept-stores-line
 */

import { clearKeptStores, keptStoresUsage, onKeptStoresChange } from '../../../data/anndata/transcode/space.js';
import { getOpeningProgress } from '../../../data/opening-progress.js';
import { formatBytes, formatCount, formatCountOf } from '../../../utils/format-units.js';

/** How many of `count` things an open tab uses, as words after them ('' for none). */
function inUse(count, held) {
  if (held === 0) return '';
  if (held === count) return ` (${count === 1 ? 'in use by an open tab' : 'all in use by open tabs'})`;
  return ` (${formatCount(held)} of them in use by open tabs)`;
}

/**
 * What the line says about the kept files and gene indexes, or '' when
 * there are none.
 *
 * @param {{stores: number, bytes: number, held: number, indexes?: number, indexBytes?: number, indexesHeld?: number}} usage
 * @returns {string}
 */
export function describeKeptStores({ stores, bytes, held, indexes = 0, indexBytes = 0, indexesHeld = 0 }) {
  const parts = [];
  if (stores > 0) {
    parts.push(`${formatCountOf(stores, 'file')} kept in this browser (${formatBytes(bytes)}): opened again, ${stores === 1 ? 'it is' : 'they are'} not read again${inUse(stores, held)}`);
  }
  if (indexes > 0) {
    parts.push(`the gene index of ${formatCountOf(indexes, 'file')} stored cell by cell kept in this browser (${formatBytes(indexBytes)}): opened again with the same cells, ${indexes === 1 ? 'its genes' : 'their genes'} are read at once${inUse(indexes, indexesHeld)}`);
  }
  const text = parts.join('; ');
  return text === '' ? '' : `${text[0].toUpperCase()}${text.slice(1)}`;
}

/**
 * What the line adds once Clear ran: the files an open tab uses, which
 * stayed ('' when none did).
 *
 * @param {{held: number}} result - `clearKeptStores`
 * @returns {string}
 */
export function describeCleared({ held }) {
  if (held === 0) return '';
  return held === 1 ? 'The file in use by an open tab stays until that tab closes.' : `${formatCountOf(held, 'file')} in use by open tabs stay until those tabs close.`;
}

/**
 * @param {{root: HTMLElement, text: HTMLElement, clear: HTMLButtonElement}} dom
 * @param {{opening?: Object, usage?: Function, clear?: Function, changes?: (listener: () => void) => (() => void)}} [options]
 * @returns {{refresh: () => Promise<void>, destroy: () => void}}
 */
export function initKeptStoresLine(dom, { opening = getOpeningProgress(), usage = keptStoresUsage, clear = clearKeptStores, changes = onKeptStoresChange } = {}) {
  if (!dom?.root || !dom?.text || !dom?.clear) throw new TypeError('The kept-files line needs its root, text and Clear button.');
  let generation = 0;
  let lastState = null;

  async function refresh() {
    const mine = ++generation;
    const now = await usage();
    if (mine !== generation) return;
    const text = describeKeptStores(now);
    dom.text.textContent = text;
    dom.root.hidden = text === '';
    // Offered while anything kept is used by no open tab.
    dom.clear.disabled = !(now.clearable > 0);
  }

  async function onClear() {
    dom.clear.disabled = true;
    const result = await clear();
    await refresh();
    const stayed = describeCleared(result);
    if (stayed !== '' && dom.text.textContent !== '') dom.text.textContent = `${dom.text.textContent}. ${stayed}`;
  }

  dom.clear.addEventListener('click', onClear);
  const stopChanges = changes(() => void refresh());
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
      dom.clear.removeEventListener('click', onClear);
    },
  };
}
