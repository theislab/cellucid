/**
 * @fileoverview The Stored dialog (Session › Open data › Stored › Manage…):
 * everything kept in this browser for later visits
 * (`data/anndata/transcode/space.js` `listKeptStores`), grouped by dataset —
 * its file's name and host, never a link — with a row per kind kept of it
 * (a converted R object or MatrixMarket folder, a file downloaded whole, the
 * gene index of a matrix stored cell by cell for one cell order, and any
 * other kind the list carries), each with its size, when it was last used,
 * whether an open tab uses it and, where known, what it spares the next
 * opening. The person ticks rows and removes them, removes one dataset's
 * whole, or everything no tab uses (`removeKeptStores`). A row an open tab
 * uses cannot be ticked, and says so. Under the datasets, the saved states
 * (`app/history/autosave.js`: the histories this browser autosaved and the
 * named saves, in IndexedDB: one row per saved state, its dataset, steps,
 * size and when it was last written, chosen and removed like the others),
 * then My datasets (`app/library/my-datasets.js`: the datasets opened in this
 * browser and the handles of the files and folders of this computer among
 * them, `app/library/local-file-handles.js`) as one row: how many, Show…,
 * which opens its own dialog where each is listed (each dataset is listed
 * there and only there), and Remove, which forgets the list and the handles;
 * then the connection
 * speeds remembered per host (`data/host-link-memory.js`: an origin and its
 * measured round trip and rate, no dataset) are one row with its own Remove,
 * and the decoders measured fastest in this browser
 * (`formats/io/decoder-memory.js`: codec families and size classes, no
 * dataset) another; Remove all forgets them too.
 *
 * Its foot, *Where it's kept*, says where all of it lives, as this browser
 * says it (`keptStoragePlace`): this site's private storage in the browser
 * profile, how much the browser lets the site use, and whether it keeps it
 * when the disk runs low, with the request to (`keepKeptStoresWhenSpaceIsLow`,
 * asked only on the person's click). A window that gives the site no
 * storage says it keeps data only until the tab closes.
 *
 * An agent, a notebook and a replay list and remove the same rows with
 * `stored.list` and `stored.remove` (`app/actions/definitions/stored.js`),
 * provided here on the same listing and the same removal as the buttons.
 *
 * A native `<dialog>` (`components/app-dialog.js`): focus trap, Escape and
 * the return of focus come from the browser.
 *
 * @module ui/modules/kept-stores-dialog
 */

import {
  keepKeptStoresWhenSpaceIsLow, keptStoragePlace, listKeptStores, onKeptStoresChange, removeKeptStores,
} from '../../../data/anndata/transcode/space.js';
import { forgetHostLinks, rememberedHosts } from '../../../data/host-link-memory.js';
import { countDecoderDecisions, forgetDecoderDecisions } from '../../../formats/io/decoder-memory.js';
import { listSavedStates, onSavedStatesChange, removeSavedStates } from '../../history/autosave.js';
import { listLocalFiles, localHandlesAvailable, onLocalFilesChange } from '../../library/local-file-handles.js';
import { forgetMyDatasets, listMyDatasets, onMyDatasetsChange } from '../../library/my-datasets.js';
import { PLACES } from '../place-names.js';
import { describeSubsampleMethod } from '../../../data/subsample.js';
import { formatBytes, formatCountOf, formatDuration } from '../../../utils/format-units.js';
import { createSelectItem, renderFactList } from '../components/controls.js';
import { wireAppDialog } from '../components/app-dialog.js';
import { ActionRefused } from '../../actions/dispatcher.js';
import { listNames, quoteName } from '../../actions/targets/names.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The order a dataset's rows are listed in, by kind; a kind not named here comes last. */
const KIND_ORDER = ['parts', 'gene-index', 'converted', 'download'];

/**
 * When something was last used or saved, in words: today, yesterday, some
 * days ago, or its date, after `verb` ("used today", "saved 3 days ago");
 * '' when not known.
 *
 * @param {string} verb
 * @param {number} time - ms since the epoch (0: not known)
 * @param {number} [now]
 * @param {string|undefined} [locale]
 * @returns {string}
 */
export function describeWhen(verb, time, now = Date.now(), locale = undefined) {
  if (!(time > 0)) return '';
  const day = time => {
    const date = new Date(time);
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  };
  const days = Math.round((day(now) - day(time)) / DAY_MS);
  if (days <= 0) return `${verb} today`;
  if (days === 1) return `${verb} yesterday`;
  if (days < 7) return `${verb} ${days} days ago`;
  return `${verb} ${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(time))}`;
}

/**
 * What a kept item is, in a few words.
 *
 * @param {import('../../../data/anndata/transcode/space.js').KeptItem} item
 * @returns {string}
 */
export function describeKeptKind(item) {
  switch (item.kind) {
    case 'converted': return 'Converted copy';
    case 'download': return 'Whole download';
    case 'parts': return 'Downloaded parts';
    case 'gene-index': {
      const cells = item.order == null
        ? null
        : item.order.order === 'file' ? 'every cell' : describeSubsampleMethod(item.order);
      const of = [item.matrix, cells].filter(Boolean).join(', ');
      return of === '' ? 'Gene index' : `Gene index (${of})`;
    }
    default: return `Kept ${item.kind}`;
  }
}

/**
 * One kept item as a row of its dataset: what it is, its size, and the facts
 * under it (when last used, whether a tab uses it, what it spares).
 *
 * @param {import('../../../data/anndata/transcode/space.js').KeptItem} item
 * @param {number} [now]
 * @returns {{name: string, size: string, meta: string, removable: boolean}}
 */
export function describeKeptItem(item, now = Date.now()) {
  const held = item.held === 'this-tab'
    ? 'in use by this tab'
    : item.held === 'other-tab' ? 'in use by another tab' : '';
  const saves = Number.isFinite(item.saves) && item.saves > 0 ? `saves ${formatBytes(item.saves)} next open` : '';
  return {
    name: describeKeptKind(item),
    size: formatBytes(item.bytes),
    meta: [describeWhen('used', item.used, now), held, saves].filter(Boolean).join(' · ') || 'not used yet',
    removable: item.held === 'none',
  };
}

/** The id a saved state's row carries (`saved:` and its id), apart from kept items' ids. */
const SAVED_ID = 'saved:';

/**
 * A saved state as a row: its dataset, its size, and what it is (the
 * history this browser kept, or a save under its name), how many steps it
 * holds and when it was last written.
 *
 * @param {{kind: 'autosave'|'named', name: string|null, dataset: {name: string|null}, steps: number,
 *   bytes: number, updatedAt: number, openable: boolean}} saved - `listSavedStates`
 * @param {number} [now]
 * @returns {{name: string, size: string, meta: string}}
 */
export function describeSavedState(saved, now = Date.now()) {
  return {
    name: saved.dataset.name ?? 'Unnamed dataset',
    size: formatBytes(saved.bytes),
    meta: [
      saved.kind === 'named' ? `Saved as "${saved.name}"` : 'History kept in this browser',
      formatCountOf(saved.steps, 'step'),
      describeWhen('saved', saved.updatedAt, now),
      saved.openable ? '' : 'kept by another version',
    ].filter(Boolean).join(' · '),
  };
}

/**
 * My datasets as the dialog's row: its name, how many datasets it lists
 * and, where the browser gives handles, how many of them are files or
 * folders of this computer it keeps the handle of. Null when it holds
 * nothing.
 *
 * @param {number} datasets - `listMyDatasets`
 * @param {number} [files] - `listLocalFiles`: the handles kept
 * @returns {{name: string, facts: string}|null}
 */
export function describeMyDatasets(datasets, files = 0) {
  if (!(datasets > 0) && !(files > 0)) return null;
  return {
    name: PLACES.myDatasets.name,
    facts: [
      `${formatCountOf(datasets, 'dataset')} opened in this browser`,
      files > 0 ? formatCountOf(files, 'file to reopen', 'files to reopen') : null,
    ].filter(Boolean).join(' · '),
  };
}

/**
 * The kept items by dataset (`item.file`): its name and host, its rows in
 * kind order, its bytes, most recently used dataset first.
 *
 * @param {ReadonlyArray<import('../../../data/anndata/transcode/space.js').KeptItem>} items
 * @returns {Array<{file: string, name: string, host: string, bytes: number, used: number,
 *   items: import('../../../data/anndata/transcode/space.js').KeptItem[]}>}
 */
export function groupKeptItems(items) {
  const groups = new Map();
  for (const item of items) {
    let group = groups.get(item.file);
    if (group === undefined) {
      group = { file: item.file, name: null, host: null, bytes: 0, used: 0, items: [] };
      groups.set(item.file, group);
    }
    group.name ??= item.name;
    group.host ??= item.host;
    group.bytes += item.bytes;
    group.used = Math.max(group.used, item.used);
    group.items.push(item);
  }
  const rank = kind => (KIND_ORDER.includes(kind) ? KIND_ORDER.indexOf(kind) : KIND_ORDER.length);
  return [...groups.values()]
    .map(group => ({
      ...group,
      name: group.name ?? 'Unnamed file',
      host: group.host ?? 'this computer',
      items: group.items.sort((a, b) => rank(a.kind) - rank(b.kind) || b.used - a.used),
    }))
    .sort((a, b) => b.used - a.used || (a.file < b.file ? -1 : 1));
}

/**
 * Where what is kept lives, as rows of the dialog's *Where it's kept*
 * table (`renderFactList`).
 *
 * @param {Awaited<ReturnType<typeof keptStoragePlace>>} place
 * @param {{asked?: boolean|null, handles?: boolean}} [request] - `asked`: what the browser
 *   answered when asked to keep it when space is low (null: not asked);
 *   `handles`: whether this browser gives handles of files to reopen
 *   (`localHandlesAvailable`), the only browsers where they are named
 * @returns {import('../components/controls.js').FactRow[]}
 */
export function whereFacts(place, { asked = null, handles = false } = {}) {
  if (!place.available) {
    return [{
      label: 'Place',
      value: 'This browser window keeps data only until the tab closes',
      title: 'It gives this site no storage that lasts (a private window, or a browser without it): nothing is kept for a later visit.',
    }];
  }
  let host = null;
  try {
    host = place.origin === null ? null : new URL(place.origin).host;
  } catch {
    host = null;
  }
  const rows = [
    {
      label: 'Place',
      value: `this browser's private storage for ${host ?? 'this site'}`,
      title: `The storage of ${place.origin ?? 'this site'} in this browser (its private file system, IndexedDB and localStorage), inside this browser profile and managed by the browser: not a folder you can open from your file manager.`,
    },
    {
      label: 'Holds',
      value: `files, saved states, ${PLACES.myDatasets.name}, connection speeds`,
      title: handles
        ? `Files in its private file system, the saved states of histories, ${PLACES.myDatasets.name} with the browser's handles of files to reopen and the decoder choices in its IndexedDB, connection speeds in its localStorage: all of them this site's storage in this browser.`
        : `Files in its private file system, the saved states of histories, ${PLACES.myDatasets.name} and the decoder choices in its IndexedDB, connection speeds in its localStorage: all of them this site's storage in this browser.`,
    },
    { label: 'Removed by', value: 'this dialog, or the browser\'s Clear site data' },
  ];
  if (place.estimate !== null) {
    const left = Math.max(0, place.estimate.quota - place.estimate.usage);
    rows.push({
      label: 'Space',
      value: `${formatBytes(place.estimate.usage)} used · ${formatBytes(left)} free (browser's figures)`,
      title: 'The browser\'s own estimate for this whole site, not only what this dialog lists; the browser decides how much a site may use.',
    });
  }
  const kept = asked === true || place.persisted === true;
  rows.push({
    label: 'Kept when space is low',
    value: kept
      ? 'yes'
      : asked === false
        ? 'no (the browser declined)'
        : place.persisted === false ? 'no, the browser may clear it' : 'not said by the browser',
    title: kept
      ? 'The browser keeps this site\'s storage when the disk runs low.'
      : 'When the disk runs low the browser may clear this site\'s storage; what is kept is then read again when it is next opened.',
  });
  return rows;
}

/**
 * The connection speeds remembered per host, as the dialog's row: its name
 * ("Connection speeds remembered (2 hosts)"), the hosts, and each host's
 * figures as the tooltip. Null when none is remembered.
 *
 * @param {ReadonlyArray<{origin: string, latencyMs: number, bytesPerMs: number}>} hosts - `rememberedHosts`
 * @returns {{name: string, facts: string, title: string}|null}
 */
export function describeRememberedHosts(hosts) {
  if (hosts.length === 0) return null;
  const hostOf = origin => {
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  };
  return {
    name: `Connection speeds remembered (${formatCountOf(hosts.length, 'host')})`,
    facts: hosts.map(host => hostOf(host.origin)).join(', '),
    title: hosts
      .map(host => `${hostOf(host.origin)}: ${formatDuration(host.latencyMs)} round trip, ${formatBytes(host.bytesPerMs * 1000)}/s`)
      .join('\n'),
  };
}

/**
 * The decoders measured fastest in this browser, as the dialog's row; null
 * when none is kept.
 *
 * @param {number} count - `countDecoderDecisions`: the size classes decided
 * @returns {{name: string, facts: string, title: string}|null}
 */
export function describeDecoderDecisions(count) {
  if (!(count > 0)) return null;
  return {
    name: `Decoder choices measured (${formatCountOf(count, 'chunk size')})`,
    facts: 'This browser\'s fastest decoders, so later visits skip measuring',
    title: 'Which decoder (WebAssembly or JavaScript, the browser\'s own or fflate) decodes each compression and chunk size fastest here. No dataset is kept.',
  };
}

/**
 * What a removal did, as the dialog's status line.
 *
 * @param {{removed: number, held: number, hosts?: number, decoders?: number, datasets?: number}} result -
 *   `removeKeptStores` (with the saved states removed counted as items), the hosts whose connection speed
 *   was forgotten, the decoder choices forgotten, and the datasets My datasets forgot
 * @returns {string}
 */
export function describeRemoval({ removed, held, hosts = 0, decoders = 0, datasets = 0 }) {
  const parts = [];
  if (removed > 0) parts.push(`Removed ${formatCountOf(removed, 'item')}.`);
  if (datasets > 0) parts.push(`Forgot ${formatCountOf(datasets, 'dataset')} of ${PLACES.myDatasets.name}.`);
  if (hosts > 0) parts.push(`Forgot the connection speeds of ${formatCountOf(hosts, 'host')}.`);
  if (decoders > 0) parts.push('Forgot the decoder choices.');
  if (held > 0) parts.push(`${formatCountOf(held, 'item')} in use by an open tab ${held === 1 ? 'stays' : 'stay'} until that tab closes.`);
  return parts.length === 0 ? 'Nothing was removed.' : parts.join(' ');
}

/**
 * @param {{dialog: HTMLDialogElement, list: HTMLElement, empty: HTMLElement, status: HTMLElement,
 *   removeSelected: HTMLButtonElement, removeAll: HTMLButtonElement, where: HTMLDListElement, persist: HTMLButtonElement}} dom
 * @param {{list?: () => Promise<Array>, remove?: (ids: string[]|null) => Promise<{removed: number, held: number}>,
 *   changes?: (listener: () => void) => (() => void), now?: () => number,
 *   place?: () => Promise<Object>, persist?: () => Promise<boolean>,
 *   hosts?: () => Array<{origin: string, latencyMs: number, bytesPerMs: number}>, forgetHosts?: () => void,
 *   savedStates?: () => Promise<Array>, removeSaved?: (ids: string[]|null) => Promise<number>,
 *   savedChanges?: (listener: () => void) => (() => void),
 *   library?: () => Promise<Array>, forgetLibrary?: () => Promise<{datasets: number, handles: number}>,
 *   libraryChanges?: (listener: () => void) => (() => void),
 *   localFiles?: () => Promise<Array>, localChanges?: (listener: () => void) => (() => void),
 *   onShowLibrary?: ((opener: HTMLElement) => void)|null,
 *   decoders?: () => Promise<number>, forgetDecoders?: () => Promise<boolean>,
 *   onRemoved?: () => void,
 *   actions?: {provide: (type: string, handler: Function) => () => void}|null}} [options] - `hosts`/`forgetHosts`: the connection speeds
 *   remembered per host; `decoders`/`forgetDecoders`: the decoder choices kept;
 *   `savedStates`/`removeSaved`/`savedChanges`: the saved states of histories;
 *   `library`/`forgetLibrary`/`libraryChanges`: My datasets (forgotten whole, with the handles of its files);
 *   `localFiles`/`localChanges`: the files of this computer whose handle is kept (counted in its row);
 *   `onShowLibrary`: open My datasets' own dialog (its row's Show…);
 *   `onRemoved`: after anything was removed (the Stored row follows);
 *   `actions`: the page's dispatcher, on which the dialog provides `stored.list` and `stored.remove`
 *   (what it lists, and its buttons' removal, for an agent, a notebook and a replay)
 * @returns {{open: (opener?: HTMLElement|null) => Promise<void>, refresh: () => Promise<void>, close: () => void,
 *   destroy: () => void}}
 */
export function initKeptStoresDialog(dom, {
  list = listKeptStores, remove = removeKeptStores, changes = onKeptStoresChange, now = Date.now,
  place = keptStoragePlace, persist = keepKeptStoresWhenSpaceIsLow,
  hosts = rememberedHosts, forgetHosts = forgetHostLinks,
  savedStates = listSavedStates, removeSaved = removeSavedStates, savedChanges = onSavedStatesChange,
  library = listMyDatasets, forgetLibrary = () => forgetMyDatasets(null), libraryChanges = onMyDatasetsChange,
  localFiles = listLocalFiles, localChanges = onLocalFilesChange, onShowLibrary = null,
  decoders = countDecoderDecisions, forgetDecoders = forgetDecoderDecisions,
  onRemoved = () => {}, actions = null,
} = {}) {
  for (const key of ['dialog', 'list', 'empty', 'status', 'removeSelected', 'removeAll', 'where', 'persist']) {
    if (!dom?.[key]) throw new TypeError(`The Stored dialog needs its ${key}.`);
  }
  const doc = dom.dialog.ownerDocument;
  const owner = wireAppDialog(dom.dialog);
  const lifecycle = new AbortController();
  const { signal } = lifecycle;
  /** The ids ticked, kept across refreshes while their items stay removable. */
  const chosen = new Set();
  let items = [];
  /** The hosts whose connection speed is remembered (`rememberedHosts`). */
  let remembered = [];
  /** The saved states of histories (`listSavedStates`). */
  let savedList = [];
  /** The files of this computer kept to reopen (`listLocalFiles`). */
  let localList = [];
  /** The datasets of My datasets (`listMyDatasets`). */
  let libraryList = [];
  /** What opened the dialog: My datasets' dialog, opened from it, gives the focus back there. */
  let openedBy = null;
  /** The decoder choices kept (`countDecoderDecisions`). */
  let decoderCount = 0;
  let busy = false;
  let generation = 0;
  // Where it is kept, as last asked, and the browser's answer to keeping it when space is low.
  let where = null;
  let asked = null;

  const removableIds = within => within.filter(item => item.held === 'none').map(item => item.id);
  const savedIds = () => savedList.map(saved => SAVED_ID + saved.id);

  function syncButtons() {
    dom.removeSelected.disabled = busy || chosen.size === 0;
    dom.removeAll.disabled = busy || (removableIds(items).length === 0 && remembered.length === 0 && savedList.length === 0 && libraryList.length === 0 && localList.length === 0 && decoderCount === 0);
    for (const button of dom.list.querySelectorAll('[data-dataset-remove]')) {
      button.disabled = busy || button.dataset.removable !== 'true';
    }
    for (const button of dom.list.querySelectorAll('[data-hosts-remove], [data-decoders-remove], [data-saved-remove], [data-library-remove], [data-library-show]')) button.disabled = busy;
  }

  /** A dataset's or the hosts' head: its name, the facts under it, and Remove. */
  function sectionHead(titleId, nameText, factsText, removeButton) {
    const head = doc.createElement('div');
    head.className = 'kept-dataset-head';
    const text = doc.createElement('span');
    text.className = 'kept-dataset-text';
    const name = doc.createElement('span');
    name.className = 'kept-dataset-name';
    name.id = titleId;
    name.textContent = nameText;
    name.title = nameText;
    const facts = doc.createElement('span');
    facts.className = 'kept-dataset-facts';
    facts.textContent = factsText;
    text.append(name, facts);
    removeButton.type = 'button';
    removeButton.className = 'btn btn-compact';
    removeButton.textContent = 'Remove';
    head.append(text, removeButton);
    return { head, facts };
  }

  /** One dataset: its name, host and size, Remove (its rows no tab uses), then a row per kind kept. */
  function datasetSection(group, index) {
    const section = doc.createElement('div');
    section.className = 'kept-dataset';
    section.setAttribute('role', 'group');
    const titleId = `kept-dataset-${index}`;
    section.setAttribute('aria-labelledby', titleId);
    const removable = removableIds(group.items);
    const removeButton = doc.createElement('button');
    removeButton.dataset.datasetRemove = group.file;
    removeButton.dataset.removable = String(removable.length > 0);
    removeButton.setAttribute('aria-label', `Remove what is kept of ${group.name}`);
    if (removable.length === 0) removeButton.title = 'In use by an open tab: it can be removed once that tab closes.';
    section.appendChild(sectionHead(titleId, group.name, `${group.host} · ${formatBytes(group.bytes)}`, removeButton).head);
    for (const item of group.items) {
      const words = describeKeptItem(item, now());
      const { root, checkbox } = createSelectItem({ name: words.name, size: words.size, meta: words.meta, disabled: !words.removable });
      root.dataset.itemId = item.id;
      checkbox.checked = words.removable && chosen.has(item.id);
      checkbox.setAttribute('aria-label', `${words.name} of ${group.name}, ${words.size}, ${words.meta}`);
      if (!words.removable) root.title = 'In use by an open tab: it can be removed once that tab closes.';
      section.appendChild(root);
    }
    return section;
  }

  /** The saved states of histories: a row per saved state, chosen like kept items, and Remove for all of them. */
  function savedSection() {
    const section = doc.createElement('div');
    section.className = 'kept-dataset kept-saved-states';
    section.setAttribute('role', 'group');
    section.setAttribute('aria-labelledby', 'kept-saved-title');
    const removeButton = doc.createElement('button');
    removeButton.dataset.savedRemove = 'true';
    removeButton.setAttribute('aria-label', `Remove ${formatCountOf(savedList.length, 'saved state')}`);
    const total = savedList.reduce((sum, saved) => sum + saved.bytes, 0);
    section.appendChild(sectionHead('kept-saved-title', 'Saved states', `histories of this browser · ${formatBytes(total)}`, removeButton).head);
    for (const saved of savedList) {
      const words = describeSavedState(saved, now());
      const id = SAVED_ID + saved.id;
      const { root, checkbox } = createSelectItem({ name: words.name, size: words.size, meta: words.meta });
      root.dataset.itemId = id;
      checkbox.checked = chosen.has(id);
      checkbox.setAttribute('aria-label', `Saved state of ${words.name}, ${words.size}, ${words.meta}`);
      section.appendChild(root);
    }
    return section;
  }

  /**
   * My datasets: one row, how many it lists (each is listed in its own
   * dialog, never here), Show… (that dialog) and Remove (the list, with the
   * handles of its files).
   */
  function librarySection(words) {
    const section = doc.createElement('div');
    section.className = 'kept-dataset kept-library';
    section.setAttribute('role', 'group');
    section.setAttribute('aria-labelledby', 'kept-library-title');
    const removeButton = doc.createElement('button');
    removeButton.dataset.libraryRemove = 'true';
    removeButton.setAttribute('aria-label', `Forget every dataset of ${words.name}`);
    const { head } = sectionHead('kept-library-title', words.name, words.facts, removeButton);
    if (onShowLibrary !== null) {
      const show = doc.createElement('button');
      show.type = 'button';
      show.className = 'btn btn-compact';
      show.dataset.libraryShow = 'true';
      show.textContent = 'Show…';
      show.setAttribute('aria-label', `Show ${words.name}`);
      show.setAttribute('aria-haspopup', 'dialog');
      head.insertBefore(show, removeButton);
    }
    section.appendChild(head);
    return section;
  }

  /** The connection speeds remembered per host: one row, with Remove. */
  function hostsSection(words) {
    const section = doc.createElement('div');
    section.className = 'kept-dataset kept-hosts';
    section.setAttribute('role', 'group');
    section.setAttribute('aria-labelledby', 'kept-hosts-title');
    const removeButton = doc.createElement('button');
    removeButton.dataset.hostsRemove = 'true';
    removeButton.setAttribute('aria-label', `Forget the connection speeds of ${formatCountOf(remembered.length, 'host')}`);
    const { head, facts } = sectionHead('kept-hosts-title', words.name, words.facts, removeButton);
    facts.title = words.title;
    section.appendChild(head);
    return section;
  }

  /** The decoder choices kept: one row, with Remove. */
  function decodersSection(words) {
    const section = doc.createElement('div');
    section.className = 'kept-dataset kept-decoders';
    section.setAttribute('role', 'group');
    section.setAttribute('aria-labelledby', 'kept-decoders-title');
    const removeButton = doc.createElement('button');
    removeButton.dataset.decodersRemove = 'true';
    removeButton.setAttribute('aria-label', 'Forget the decoder choices');
    const { head, facts } = sectionHead('kept-decoders-title', words.name, words.facts, removeButton);
    facts.title = words.title;
    section.appendChild(head);
    return section;
  }

  function render() {
    const sections = groupKeptItems(items).map(datasetSection);
    if (savedList.length > 0) sections.push(savedSection());
    const libraryWords = describeMyDatasets(libraryList.length, localList.length);
    if (libraryWords !== null) sections.push(librarySection(libraryWords));
    const hostWords = describeRememberedHosts(remembered);
    if (hostWords !== null) sections.push(hostsSection(hostWords));
    const decoderWords = describeDecoderDecisions(decoderCount);
    if (decoderWords !== null) sections.push(decodersSection(decoderWords));
    dom.list.replaceChildren(...sections);
    dom.list.hidden = sections.length === 0;
    dom.empty.hidden = sections.length !== 0;
    syncButtons();
  }

  function renderWhere() {
    if (where === null) return;
    renderFactList(dom.where, whereFacts(where, { asked, handles: localHandlesAvailable(doc.defaultView) }));
    // Offered while the browser may clear it and can be asked; asked only on this click.
    dom.persist.hidden = !(where.canPersist && where.persisted !== true && asked !== true);
  }

  /** Everything the dialog lists, read once (its rows, and `stored.list`). */
  async function readStored() {
    const [kept, nextPlace, saved, local, listed, decoderTotal] = await Promise.all([list(), place(), savedStates(), localFiles(), library(), decoders()]);
    return { kept, place: nextPlace, saved, local, listed, decoders: decoderTotal, hosts: hosts() };
  }

  async function refresh() {
    const mine = ++generation;
    const read = await readStored();
    if (mine !== generation) return;
    items = read.kept;
    decoderCount = read.decoders;
    savedList = read.saved;
    localList = read.local;
    libraryList = read.listed;
    remembered = read.hosts;
    where = read.place;
    renderWhere();
    const live = new Set([...removableIds(items), ...savedIds()]);
    for (const id of [...chosen]) if (!live.has(id)) chosen.delete(id);
    render();
  }

  /**
   * Remove the rows `ids` -- kept items and saved states (null: every kept
   * item no tab uses, every saved state, and My datasets with the handles of
   * its files) -- and, with `forgetSpeeds`, the connection speeds
   * remembered, with `forgetDecoderChoices` the decoder choices kept, with
   * `forgetList` My datasets. Every button's removal and `stored.remove`'s:
   * resolves to what went and the sentence the dialog says of it (undefined
   * while another removal runs).
   */
  async function removeChosen(ids, { forgetSpeeds = false, forgetDecoderChoices = false, forgetList = false } = {}) {
    if (busy) return undefined;
    busy = true;
    syncButtons();
    try {
      const speeds = forgetSpeeds ? hosts().length : 0;
      if (forgetSpeeds) forgetHosts();
      const decoderTotal = forgetDecoderChoices ? await decoders() : 0;
      const decodersForgotten = decoderTotal > 0 && await forgetDecoders() ? decoderTotal : 0;
      const keptIds = ids === null ? null : ids.filter(id => !id.startsWith(SAVED_ID));
      const savedKeys = ids === null ? null : ids.filter(id => id.startsWith(SAVED_ID)).map(id => id.slice(SAVED_ID.length));
      const result = keptIds === null || keptIds.length > 0 ? await remove(keptIds) : { removed: 0, held: 0 };
      const savedRemoved = savedKeys === null || savedKeys.length > 0 ? await removeSaved(savedKeys) : 0;
      // My datasets goes whole (its saved states are rows above): the list and the handles of its files.
      const listForgotten = ids === null || forgetList ? await forgetLibrary() : { datasets: 0, handles: 0 };
      const said = describeRemoval({
        ...result,
        removed: result.removed + savedRemoved,
        hosts: speeds,
        decoders: decodersForgotten,
        datasets: listForgotten.datasets,
      });
      dom.status.textContent = said;
      dom.status.hidden = false;
      if (ids === null) chosen.clear();
      else for (const id of ids) chosen.delete(id);
      return {
        removed: result.removed, held: result.held, savedStates: savedRemoved, datasets: listForgotten.datasets,
        hosts: speeds, decoders: decodersForgotten, said,
      };
    } finally {
      busy = false;
      await refresh();
      onRemoved();
      // The control pressed may have gone with what it removed: focus stays in the dialog.
      if (dom.dialog.open && !dom.dialog.contains(doc.activeElement)) {
        dom.dialog.querySelector('.app-dialog-body input:not(:disabled), .app-dialog-body button:not(:disabled), [data-dialog-close]')?.focus();
      }
    }
  }

  dom.list.addEventListener('change', event => {
    const row = event.target?.closest?.('[data-item-id]');
    if (!row || event.target.type !== 'checkbox') return;
    if (event.target.checked) chosen.add(row.dataset.itemId);
    else chosen.delete(row.dataset.itemId);
    syncButtons();
  }, { signal });
  dom.list.addEventListener('click', event => {
    if (event.target?.closest?.('[data-hosts-remove]')?.disabled === false) {
      void removeChosen([], { forgetSpeeds: true });
      return;
    }
    if (event.target?.closest?.('[data-decoders-remove]')?.disabled === false) {
      void removeChosen([], { forgetDecoderChoices: true });
      return;
    }
    if (event.target?.closest?.('[data-saved-remove]')?.disabled === false) {
      void removeChosen(savedIds());
      return;
    }
    if (event.target?.closest?.('[data-library-remove]')?.disabled === false) {
      void removeChosen([], { forgetList: true });
      return;
    }
    const show = event.target?.closest?.('[data-library-show]');
    if (show?.disabled === false && onShowLibrary !== null) {
      // Its own dialog, in place of this one; closing it gives the focus back to what opened this one.
      const opener = openedBy;
      owner.close();
      onShowLibrary(opener);
      return;
    }
    const button = event.target?.closest?.('[data-dataset-remove]');
    if (!button || button.disabled) return;
    const ids = removableIds(items.filter(item => item.file === button.dataset.datasetRemove));
    if (ids.length > 0) void removeChosen(ids);
  }, { signal });
  dom.removeSelected.addEventListener('click', () => { void removeChosen([...chosen]); }, { signal });
  dom.persist.addEventListener('click', () => {
    dom.persist.disabled = true;
    void persist().then(granted => {
      asked = granted;
      dom.persist.disabled = false;
      renderWhere();
      if (dom.persist.hidden) dom.where.closest?.('.kept-stores-where')?.querySelector?.('.section-title')?.focus?.();
    });
  }, { signal });
  dom.removeAll.addEventListener('click', () => { void removeChosen(null, { forgetSpeeds: true, forgetDecoderChoices: true }); }, { signal });
  // ------------------------------------------------ as actions (`stored.list`, `stored.remove`)

  /** `stored.list`: what the dialog lists, as data. */
  async function storedList() {
    const read = await readStored();
    const savedBytes = read.saved.reduce((sum, saved) => sum + saved.bytes, 0);
    const keptBytes = read.kept.reduce((sum, item) => sum + item.bytes, 0);
    return {
      datasets: groupKeptItems(read.kept).map(group => ({
        name: group.name,
        host: group.host,
        bytes: group.bytes,
        items: group.items.map(item => ({
          id: item.id,
          kind: item.kind,
          what: describeKeptKind(item),
          bytes: item.bytes,
          last_used: item.used > 0 ? new Date(item.used).toISOString() : null,
          in_use: item.held,
          saves: Number.isSafeInteger(item.saves) ? item.saves : null,
        })),
      })),
      saved_states: { count: read.saved.length, bytes: savedBytes },
      my_datasets: { count: read.listed.length, files: read.local.length },
      connection_speeds: read.hosts.length,
      decoder_choices: read.decoders,
      bytes: keptBytes + savedBytes,
      room: {
        usage: read.place?.estimate?.usage ?? null,
        quota: read.place?.estimate?.quota ?? null,
        kept_when_space_is_low: read.place?.persisted ?? null,
      },
    };
  }

  /** `stored.remove`: the rows its parameters name, removed as the dialog's buttons remove them. */
  async function storedRemove(params) {
    const type = 'stored.remove';
    const { items: itemIds, dataset, everything } = params;
    const flags = ['saved_states', 'my_datasets', 'connection_speeds', 'decoder_choices'].filter(key => params[key] === true);
    if (itemIds === undefined && dataset === undefined && flags.length === 0 && everything !== true) {
      throw new ActionRefused('Name what to remove: items, a dataset, saved_states, my_datasets, connection_speeds, decoder_choices or everything (stored_list lists what there is).', { code: 'bad-value', type });
    }
    const read = await readStored();
    let ids = [];
    if (everything === true) {
      ids = null;
    } else {
      if (itemIds !== undefined) {
        const known = new Map(read.kept.map(item => [item.id, item]));
        const unknown = itemIds.filter(id => !known.has(id));
        if (unknown.length > 0) {
          throw new ActionRefused(`Nothing kept has the id ${listNames(unknown)}; ${read.kept.length === 0 ? 'nothing is kept' : `the ids are ${listNames(read.kept.map(item => item.id))}`} (stored_list).`, { code: 'no-target', type });
        }
        ids.push(...itemIds);
      }
      if (dataset !== undefined) {
        const groups = groupKeptItems(read.kept);
        const group = groups.find(entry => entry.name === dataset);
        if (group === undefined) {
          throw new ActionRefused(`Nothing is kept of a dataset ${quoteName(dataset)}; ${groups.length === 0 ? 'nothing is kept' : `kept are ${listNames(groups.map(entry => entry.name))}`} (stored_list).`, { code: 'no-target', type });
        }
        ids.push(...group.items.map(item => item.id));
      }
      if (params.saved_states === true) ids.push(...read.saved.map(saved => SAVED_ID + saved.id));
      ids = [...new Set(ids)];
    }
    const done = await removeChosen(ids, {
      forgetSpeeds: everything === true || params.connection_speeds === true,
      forgetDecoderChoices: everything === true || params.decoder_choices === true,
      forgetList: params.my_datasets === true,
    });
    if (done === undefined) {
      throw new ActionRefused('The Stored dialog is removing something now; try again once it has finished.', { code: 'busy', type });
    }
    return {
      removed: done.removed, held: done.held, saved_states: done.savedStates, my_datasets: done.datasets,
      connection_speeds: done.hosts, decoder_choices: done.decoders, said: done.said,
    };
  }

  const unprovide = actions === null ? [] : [
    actions.provide('stored.list', () => storedList()),
    actions.provide('stored.remove', params => storedRemove(params)),
  ];

  const whileOpen = () => {
    if (dom.dialog.open) void refresh();
  };
  const stopChanges = changes(whileOpen);
  const stopSavedChanges = savedChanges(whileOpen);
  const stopLocalChanges = localChanges(whileOpen);
  const stopLibraryChanges = libraryChanges(whileOpen);

  return {
    async open(opener = null) {
      dom.status.textContent = '';
      dom.status.hidden = true;
      chosen.clear();
      openedBy = opener ?? doc.activeElement;
      await refresh();
      owner.open(opener);
    },
    refresh,
    close: () => owner.close(),
    destroy() {
      for (const remove of unprovide) remove();
      stopChanges();
      stopSavedChanges();
      stopLocalChanges();
      stopLibraryChanges();
      lifecycle.abort();
      owner.destroy();
    },
  };
}
