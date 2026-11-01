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
 * uses cannot be ticked, and says so. Under the datasets, the drafts of
 * unsaved highlights (`app/highlight-draft.js`, in IndexedDB: one row per
 * dataset, its size and when it was last saved, chosen and removed like the
 * others), the files and folders of this computer kept to reopen
 * (`app/local-file-handles.js`, in IndexedDB: one row per file, whether it
 * is a file or a folder and when it was last opened, chosen and forgotten
 * like the others), then the connection
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
import { listHighlightDrafts, onHighlightDraftsChange, removeHighlightDrafts } from '../../highlight-draft.js';
import { forgetLocalFiles, listLocalFiles, localHandlesAvailable, onLocalFilesChange } from '../../local-file-handles.js';
import { describeSubsampleMethod } from '../../../data/subsample.js';
import { formatBytes, formatCountOf, formatDuration } from '../../../utils/format-units.js';
import { createSelectItem, renderFactList } from '../components/controls.js';
import { wireAppDialog } from '../components/app-dialog.js';

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

/** The id a draft's row carries (`draft:` and its dataset's key), apart from kept items' ids. */
const DRAFT_ID = 'draft:';

/**
 * A draft of unsaved highlights as a row: its dataset, its size, and what it
 * is, how many highlights it holds and when it was last saved.
 *
 * @param {{key: string, name: string|null, highlights: number, bytes: number, savedAt: number}} draft - `listHighlightDrafts`
 * @param {number} [now]
 * @returns {{name: string, size: string, meta: string}}
 */
export function describeHighlightDraft(draft, now = Date.now()) {
  return {
    name: draft.name ?? 'Unnamed dataset',
    size: formatBytes(draft.bytes),
    meta: ['Unsaved highlights draft', formatCountOf(draft.highlights, 'highlight'), describeWhen('saved', draft.savedAt, now)].filter(Boolean).join(' · '),
  };
}

/** The id a kept handle's row carries (`local:` and its dataset's key), apart from the other rows' ids. */
const LOCAL_ID = 'local:';

/**
 * A file or folder of this computer kept to reopen as a row: its name, and
 * what it is and when it was last opened.
 *
 * @param {{key: string, name: string, kind: 'file'|'folder', openedAt: number}} file - `listLocalFiles`
 * @param {number} [now]
 * @returns {{name: string, meta: string}}
 */
export function describeLocalFile(file, now = Date.now()) {
  return {
    name: file.name,
    meta: [file.kind === 'folder' ? 'Folder to reopen' : 'File to reopen', describeWhen('opened', file.openedAt, now)].filter(Boolean).join(' · '),
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
      value: handles ? 'files, highlight drafts, files to reopen, connection speeds' : 'files, highlight drafts, connection speeds',
      title: handles
        ? 'Files in its private file system, unsaved highlight drafts, the browser\'s handles of files to reopen and the decoder choices in its IndexedDB, connection speeds in its localStorage: all of them this site\'s storage in this browser.'
        : 'Files in its private file system, unsaved highlight drafts and the decoder choices in its IndexedDB, connection speeds in its localStorage: all of them this site\'s storage in this browser.',
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
 * @param {{removed: number, held: number, hosts?: number, decoders?: number}} result - `removeKeptStores` (with
 *   the drafts removed counted as items), the hosts whose connection speed was forgotten, and
 *   the decoder choices forgotten
 * @returns {string}
 */
export function describeRemoval({ removed, held, hosts = 0, decoders = 0 }) {
  const parts = [];
  if (removed > 0) parts.push(`Removed ${formatCountOf(removed, 'item')}.`);
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
 *   drafts?: () => Promise<Array>, removeDrafts?: (keys: string[]|null) => Promise<number>,
 *   draftChanges?: (listener: () => void) => (() => void),
 *   localFiles?: () => Promise<Array>, forgetLocal?: (keys: string[]|null) => Promise<number>,
 *   localChanges?: (listener: () => void) => (() => void),
 *   decoders?: () => Promise<number>, forgetDecoders?: () => Promise<boolean>,
 *   onRemoved?: () => void}} [options] - `hosts`/`forgetHosts`: the connection speeds
 *   remembered per host; `decoders`/`forgetDecoders`: the decoder choices kept;
 *   `drafts`/`removeDrafts`/`draftChanges`: the highlight drafts;
 *   `localFiles`/`forgetLocal`/`localChanges`: the files of this computer kept to reopen;
 *   `onRemoved`: after anything was removed (the Stored row follows)
 * @returns {{open: (opener?: HTMLElement|null) => Promise<void>, refresh: () => Promise<void>, destroy: () => void}}
 */
export function initKeptStoresDialog(dom, {
  list = listKeptStores, remove = removeKeptStores, changes = onKeptStoresChange, now = Date.now,
  place = keptStoragePlace, persist = keepKeptStoresWhenSpaceIsLow,
  hosts = rememberedHosts, forgetHosts = forgetHostLinks,
  drafts = listHighlightDrafts, removeDrafts = removeHighlightDrafts, draftChanges = onHighlightDraftsChange,
  localFiles = listLocalFiles, forgetLocal = forgetLocalFiles, localChanges = onLocalFilesChange,
  decoders = countDecoderDecisions, forgetDecoders = forgetDecoderDecisions,
  onRemoved = () => {},
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
  /** The highlight drafts (`listHighlightDrafts`). */
  let draftList = [];
  /** The files of this computer kept to reopen (`listLocalFiles`). */
  let localList = [];
  /** The decoder choices kept (`countDecoderDecisions`). */
  let decoderCount = 0;
  let busy = false;
  let generation = 0;
  // Where it is kept, as last asked, and the browser's answer to keeping it when space is low.
  let where = null;
  let asked = null;

  const removableIds = within => within.filter(item => item.held === 'none').map(item => item.id);
  const draftIds = () => draftList.map(draft => DRAFT_ID + draft.key);
  const localIds = () => localList.map(file => LOCAL_ID + file.key);

  function syncButtons() {
    dom.removeSelected.disabled = busy || chosen.size === 0;
    dom.removeAll.disabled = busy || (removableIds(items).length === 0 && remembered.length === 0 && draftList.length === 0 && localList.length === 0 && decoderCount === 0);
    for (const button of dom.list.querySelectorAll('[data-dataset-remove]')) {
      button.disabled = busy || button.dataset.removable !== 'true';
    }
    for (const button of dom.list.querySelectorAll('[data-hosts-remove], [data-decoders-remove], [data-drafts-remove], [data-local-remove]')) button.disabled = busy;
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

  /** The highlight drafts: a row per dataset, chosen like kept items, and Remove for all of them. */
  function draftsSection() {
    const section = doc.createElement('div');
    section.className = 'kept-dataset kept-drafts';
    section.setAttribute('role', 'group');
    section.setAttribute('aria-labelledby', 'kept-drafts-title');
    const removeButton = doc.createElement('button');
    removeButton.dataset.draftsRemove = 'true';
    removeButton.setAttribute('aria-label', `Remove ${formatCountOf(draftList.length, 'highlights draft')}`);
    const total = draftList.reduce((sum, draft) => sum + draft.bytes, 0);
    section.appendChild(sectionHead('kept-drafts-title', 'Unsaved highlights', `not saved in a session · ${formatBytes(total)}`, removeButton).head);
    for (const draft of draftList) {
      const words = describeHighlightDraft(draft, now());
      const id = DRAFT_ID + draft.key;
      const { root, checkbox } = createSelectItem({ name: words.name, size: words.size, meta: words.meta });
      root.dataset.itemId = id;
      checkbox.checked = chosen.has(id);
      checkbox.setAttribute('aria-label', `Highlights draft of ${words.name}, ${words.size}, ${words.meta}`);
      section.appendChild(root);
    }
    return section;
  }

  /** The files of this computer kept to reopen: a row per file, chosen like kept items, and Remove for all of them. */
  function localSection() {
    const section = doc.createElement('div');
    section.className = 'kept-dataset kept-local-files';
    section.setAttribute('role', 'group');
    section.setAttribute('aria-labelledby', 'kept-local-title');
    const removeButton = doc.createElement('button');
    removeButton.dataset.localRemove = 'true';
    removeButton.setAttribute('aria-label', `Forget ${formatCountOf(localList.length, 'file to reopen', 'files to reopen')}`);
    section.appendChild(sectionHead('kept-local-title', 'Files to reopen', 'on this computer · reopened with one click', removeButton).head);
    for (const file of localList) {
      const words = describeLocalFile(file, now());
      const id = LOCAL_ID + file.key;
      const { root, checkbox } = createSelectItem({ name: words.name, meta: words.meta });
      root.dataset.itemId = id;
      checkbox.checked = chosen.has(id);
      checkbox.setAttribute('aria-label', `${words.name}, ${words.meta}`);
      section.appendChild(root);
    }
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
    if (draftList.length > 0) sections.push(draftsSection());
    if (localList.length > 0) sections.push(localSection());
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

  async function refresh() {
    const mine = ++generation;
    const [next, nextPlace, nextDrafts, nextLocal, nextDecoders] = await Promise.all([list(), place(), drafts(), localFiles(), decoders()]);
    if (mine !== generation) return;
    items = next;
    decoderCount = nextDecoders;
    draftList = nextDrafts;
    localList = nextLocal;
    remembered = hosts();
    where = nextPlace;
    renderWhere();
    const live = new Set([...removableIds(items), ...draftIds(), ...localIds()]);
    for (const id of [...chosen]) if (!live.has(id)) chosen.delete(id);
    render();
  }

  /**
   * Remove the rows `ids` -- kept items, highlight drafts and files to
   * reopen (null: every kept item no tab uses, every draft and every file)
   * -- and, with `forgetSpeeds`, the connection speeds remembered, with
   * `forgetDecoderChoices` the decoder choices kept.
   */
  async function removeChosen(ids, { forgetSpeeds = false, forgetDecoderChoices = false } = {}) {
    if (busy) return;
    busy = true;
    syncButtons();
    try {
      const forgotten = forgetSpeeds ? remembered.length : 0;
      if (forgetSpeeds) forgetHosts();
      const decodersForgotten = forgetDecoderChoices && decoderCount > 0 && await forgetDecoders() ? decoderCount : 0;
      const keptIds = ids === null ? null : ids.filter(id => !id.startsWith(DRAFT_ID) && !id.startsWith(LOCAL_ID));
      const draftKeys = ids === null ? null : ids.filter(id => id.startsWith(DRAFT_ID)).map(id => id.slice(DRAFT_ID.length));
      const localKeys = ids === null ? null : ids.filter(id => id.startsWith(LOCAL_ID)).map(id => id.slice(LOCAL_ID.length));
      const result = keptIds === null || keptIds.length > 0 ? await remove(keptIds) : { removed: 0, held: 0 };
      const draftsRemoved = draftKeys === null || draftKeys.length > 0 ? await removeDrafts(draftKeys) : 0;
      const localForgotten = localKeys === null || localKeys.length > 0 ? await forgetLocal(localKeys) : 0;
      dom.status.textContent = describeRemoval({ ...result, removed: result.removed + draftsRemoved + localForgotten, hosts: forgotten, decoders: decodersForgotten });
      dom.status.hidden = false;
      if (ids === null) chosen.clear();
      else for (const id of ids) chosen.delete(id);
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
    if (event.target?.closest?.('[data-drafts-remove]')?.disabled === false) {
      void removeChosen(draftIds());
      return;
    }
    if (event.target?.closest?.('[data-local-remove]')?.disabled === false) {
      void removeChosen(localIds());
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
  const whileOpen = () => {
    if (dom.dialog.open) void refresh();
  };
  const stopChanges = changes(whileOpen);
  const stopDraftChanges = draftChanges(whileOpen);
  const stopLocalChanges = localChanges(whileOpen);

  return {
    async open(opener = null) {
      dom.status.textContent = '';
      dom.status.hidden = true;
      chosen.clear();
      await refresh();
      owner.open(opener);
    },
    refresh,
    destroy() {
      stopChanges();
      stopDraftChanges();
      stopLocalChanges();
      lifecycle.abort();
      owner.destroy();
    },
  };
}
