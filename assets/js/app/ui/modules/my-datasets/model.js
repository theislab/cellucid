/**
 * @fileoverview What My datasets shows of the list, as plain data: each
 * dataset's kind and where it comes from, how it opens again, its menu item,
 * its row in All… (one line under its name, and the facts behind it: where
 * the data comes from, how it opens, its format, size, cells and genes, the
 * cells it opens with, when it was opened, its saved states and what is
 * stored of it), the saved state Continue opens, the filter, and what an
 * export of a library file chose and an import added. Pure
 * (importable in Node); `menu.js` and `dialog.js` draw from it.
 *
 * @module ui/modules/my-datasets/model
 */

import { describeStorageFormat } from '../dataset-card.js';
import { formatAgo, savedStateWords } from '../state/model.js';
import { formatWhen } from '../../../history/exports/report.js';
import { describeSubsampleMethod } from '../../../../data/subsample.js';
import { getProviderRegistry } from '../../../../data/sources/registry.js';
import { PLACES, placePath } from '../../place-names.js';
import { formatBytes, formatCount, formatCountOf } from '../../../../utils/format-units.js';

/** What a dataset of the list is, in one word. */
export const KIND_LABELS = Object.freeze({
  sample: 'Sample',
  link: 'Link',
  server: 'Server',
  file: 'File',
  folder: 'Folder',
});

/**
 * The kind of a dataset of the list: a sample, a link, a Cellucid server, or
 * a file or folder of this computer.
 *
 * @param {{source: {kind: string}, storage: {layout: string}|null}} entry
 * @returns {'sample'|'link'|'server'|'file'|'folder'}
 */
export function datasetKind(entry) {
  switch (entry.source.kind) {
    case 'sample': return 'sample';
    case 'link': return 'link';
    case 'remote': return 'server';
    default: return entry.storage?.layout === 'folder' ? 'folder' : 'file';
  }
}

function hostOf(address) {
  try {
    return new URL(address).host || null;
  } catch {
    return null;
  }
}

/**
 * The place a link or a server is: a link's provider ("Zenodo", "NCBI
 * GEO") or, for a plain web address, its host; a server's host. Null for a
 * sample, a file or a folder.
 *
 * @param {Object} entry
 * @returns {string|null}
 */
function placeOf(entry) {
  const kind = datasetKind(entry);
  if (kind === 'link') {
    const provider = entry.link?.provider ?? null;
    const label = provider === null || provider === 'url' ? null : getProviderRegistry().get(provider)?.label ?? null;
    return label ?? entry.storage?.host ?? hostOf(entry.source.locator);
  }
  if (kind === 'server') return hostOf(entry.source.url) ?? entry.source.url;
  return null;
}

/**
 * Where a dataset comes from, in a word or two: "Sample", a link's
 * provider ("Zenodo", "NCBI GEO") or, for a plain web address, its host,
 * "Server" and its host, "File", "Folder".
 *
 * @param {Object} entry
 * @returns {string}
 */
export function describeOrigin(entry) {
  const kind = datasetKind(entry);
  const place = placeOf(entry);
  if (kind === 'link') return place ?? KIND_LABELS.link;
  if (kind === 'server') return `${KIND_LABELS.server} ${place}`;
  return KIND_LABELS[kind];
}

/**
 * How a dataset opens again from the list, as the person's click meets it:
 * at once (`click`), after the browser asks for leave to read a file of
 * this computer (`ask`), or by choosing the file or folder again (`choose`:
 * a browser that gives no handles, or one whose handle is no longer kept).
 *
 * @param {Object} entry
 * @param {{handlesAvailable: boolean, handles: ReadonlySet<string>}} local - whether this
 *   browser gives handles (`localHandlesAvailable`), and the datasets whose handle is kept
 * @returns {'click'|'ask'|'choose'}
 */
export function reopenWay(entry, { handlesAvailable, handles }) {
  if (entry.source.kind !== 'file') return 'click';
  return handlesAvailable && handles.has(entry.source.dataset) ? 'ask' : 'choose';
}

/**
 * The saved states of a dataset (`listSavedStates`, keyed by its identity),
 * most recently written first.
 *
 * @param {{id: string}} entry
 * @param {ReadonlyArray<{dataset: {id: string|null}, updatedAt: number}>} states
 */
export function savedStatesOf(entry, states) {
  return states.filter(state => state.dataset?.id === entry.id).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * The saved state Continue opens: the most recently written one this
 * version can open, or null. The history shown now is not one to continue
 * into (it is what is shown).
 *
 * @param {{id: string}} entry
 * @param {ReadonlyArray<Object>} states
 */
export function latestSavedState(entry, states) {
  return savedStatesOf(entry, states).find(state => state.openable !== false && state.current !== true) ?? null;
}

/**
 * What the Stored machinery keeps of a dataset (`listKeptStores`), as the
 * Stored dialog names a dataset there: its file's name and host. Null when
 * nothing is kept of it.
 *
 * @param {{storage: {name: string|null, host: string|null}|null}} entry
 * @param {ReadonlyArray<{name: string|null, host: string|null, bytes: number, kind: string}>} items
 * @returns {{bytes: number, items: number}|null}
 */
export function keptOf(entry, items) {
  const name = entry.storage?.name ?? null;
  if (name === null) return null;
  const host = entry.storage.host ?? null;
  const mine = items.filter(item => item.name === name && (item.host ?? null) === host);
  if (mine.length === 0) return null;
  return { bytes: mine.reduce((sum, item) => sum + item.bytes, 0), items: mine.length };
}

/**
 * A dataset's item in the menu: its name, and under it its kind, where it
 * comes from (a link's provider or host, a server's host) and when it was
 * last opened; the one open now is marked (`current`); one to choose again
 * says so.
 *
 * @param {Object} entry
 * @param {{now: number, current: boolean, way: 'click'|'ask'|'choose'}} options
 * @returns {{label: string, hint: string, title: string}}
 */
export function describeMenuItem(entry, { now, current, way }) {
  const kind = datasetKind(entry);
  const when = current ? 'open now' : formatAgo(entry.lastOpenedAt, now).long;
  const how = way === 'choose' ? 'choose it again' : null;
  const hint = [KIND_LABELS[kind], placeOf(entry), how ?? when].filter(Boolean).join(' · ');
  return {
    label: entry.name,
    hint,
    title: current
      ? `${entry.name} is open now.`
      : way === 'choose'
        ? `Choose ${entry.name} again: this browser does not let a page reopen a file by itself.`
        : `Open ${entry.name} again (last opened ${formatAgo(entry.lastOpenedAt, now).long}).`,
  };
}

/**
 * The cells a dataset opens with, in words: every cell, or a subsample (how
 * many of how many, how they are chosen; fitted to this device when the
 * device chose them).
 *
 * @param {Object} entry
 * @returns {string}
 */
export function describeOpenCells(entry) {
  const open = entry.openCells ?? null;
  const total = open?.of ?? entry.cells;
  if (open === null || open.spec === null) return total === null ? 'Every cell' : `Every cell (${formatCount(total)})`;
  return `${formatCount(open.cells)} of ${formatCount(open.of)} (${describeSubsampleMethod(open.spec)}${open.fitted ? ', fitted to this device' : ''})`;
}

/**
 * The line under a dataset's name in All…: its format, cells and genes,
 * and its saved states.
 *
 * @param {Object} entry
 * @param {ReadonlyArray<Object>} saved - `savedStatesOf`
 * @returns {string}
 */
export function describeRowMeta(entry, saved) {
  return [
    entry.storage === null ? null : describeStorageFormat(entry.storage),
    entry.cells === null ? null : formatCountOf(entry.cells, 'cell'),
    entry.genes === null ? null : formatCountOf(entry.genes, 'gene'),
    saved.length === 0 ? null : formatCountOf(saved.length, 'saved state'),
  ].filter(Boolean).join(' · ');
}

/**
 * A saved state of a dataset as one line of its facts: what it is, its
 * steps and trackers, when it was last written, its size.
 *
 * @param {{kind: 'autosave'|'named', name: string|null, steps: number, trackers: Array<{name: string}>,
 *   updatedAt: number, bytes: number, openable?: boolean, current?: boolean}} state
 * @param {number} now
 * @returns {string}
 */
export function describeSavedStateLine(state, now) {
  const trackers = state.trackers?.length ?? 0;
  return [
    savedStateWords(state),
    formatCountOf(state.steps, 'step'),
    trackers > 1 ? `${formatCountOf(trackers, 'tracker')} (${state.trackers.map(tracker => tracker.name).join(', ')})` : null,
    `${state.kind === 'named' ? 'saved' : 'changed'} ${formatAgo(state.updatedAt, now).long}`,
    formatBytes(state.bytes),
    state.current ? 'the history shown now' : null,
    state.openable === false ? 'kept by another version' : null,
  ].filter(Boolean).join(' · ');
}

function sourceFacts(entry, way) {
  const kind = datasetKind(entry);
  const source = entry.source;
  const choose = `${kind === 'folder' ? 'Folder…' : 'File…'} in ${placePath(PLACES.session, PLACES.openData)}`;
  switch (kind) {
    case 'sample':
      return [
        { label: 'Source', value: 'Sample dataset' },
        { label: 'Opens', value: 'With one click' },
      ];
    case 'link':
      return [
        { label: 'Source', value: `Link · ${describeOrigin(entry)}` },
        { label: 'Address', value: source.locator, title: source.locator },
        {
          label: 'Opens',
          value: entry.link?.accessLeftOut ? 'With one click, while the link grants access' : 'With one click',
          ...(entry.link?.accessLeftOut
            ? { title: 'What the link carried to grant access (a key, a signature, a token) is not kept. If it is refused, paste the whole link again.' }
            : {}),
        },
      ];
    case 'server':
      return [
        { label: 'Source', value: 'Cellucid server' },
        { label: 'Address', value: source.url, title: source.url },
        { label: 'Opens', value: 'With one click, while the server runs', title: 'The server (cellucid serve) holds the data: start it again at this address first.' },
      ];
    default:
      return [
        { label: 'Source', value: `${KIND_LABELS[kind]} on this computer` },
        { label: 'Name', value: source.name, title: source.name },
        way === 'ask'
          ? { label: 'Opens', value: 'With one click; the browser may ask to read it first', title: 'This browser keeps its handle (not its content): a click reads it where it is, unless it moved or changed.' }
          : { label: 'Opens', value: `Choose it again with ${choose}`, title: 'This browser does not let a page reopen a file of this computer by itself (only Chrome and Edge keep a handle).' },
      ];
  }
}

/**
 * The facts behind a dataset of All…: where the data comes from and how it
 * opens again, its format and size, its cells and genes and the cells it
 * opens with, when it was first and last opened, its saved states (where
 * its session is) and what is stored of it in this browser.
 *
 * @param {Object} entry
 * @param {{saved: ReadonlyArray<Object>, kept: {bytes: number, items: number}|null,
 *   way: 'click'|'ask'|'choose', now: number}} context
 * @returns {import('../../components/controls.js').FactRow[]}
 */
export function describeEntryFacts(entry, { saved, kept, way, now }) {
  const rows = sourceFacts(entry, way);
  if (entry.storage !== null) {
    const format = describeStorageFormat(entry.storage);
    rows.push({ label: 'Format', value: entry.storage.format === 'h5ad' || entry.storage.format === 'zarr' ? `AnnData, ${format}` : format });
    if (entry.storage.bytes !== null) rows.push({ label: 'Size', value: formatBytes(entry.storage.bytes) });
  }
  rows.push({
    label: 'Cells',
    value: describeOpenCells(entry),
    title: entry.openCells?.spec != null && !entry.openCells.fitted
      ? 'It opens with these cells again: the same method, size and seed.'
      : 'It opens as this tab opens datasets (Cells to open).',
  });
  if (entry.genes !== null) rows.push({ label: 'Genes', value: formatCount(entry.genes) });
  rows.push({ label: 'Last opened', value: `${formatWhen(entry.lastOpenedAt)} (${formatCountOf(entry.openCount, 'time')} in all)` });
  rows.push({ label: 'First opened', value: formatWhen(entry.firstOpenedAt) });
  const savedPlace = placePath(PLACES.state, PLACES.sessionFile);
  rows.push(saved.length === 0
    ? { label: 'Saved states', value: 'None yet', title: `Its steps are kept in this browser as you work (${savedPlace}, Load…).` }
    : {
        label: 'Saved states',
        value: saved.map(state => describeSavedStateLine(state, now)).join('\n'),
        lines: saved.map(state => describeSavedStateLine(state, now)),
        title: `Kept in this browser (${savedPlace}, Load…).`,
      });
  if (kept !== null) {
    rows.push({
      label: 'Stored',
      value: `${formatBytes(kept.bytes)} (${formatCountOf(kept.items, 'item')})`,
      title: `Kept in this browser so it opens faster; ${placePath(PLACES.session, PLACES.openData, PLACES.stored)} › Manage… removes it.`,
    });
  }
  return rows;
}

/**
 * Whether a dataset matches what is typed in the filter: its name, or its
 * file's or link's name, holds every word, whatever their case.
 *
 * @param {Object} entry
 * @param {string} query
 * @returns {boolean}
 */
export function matchesFilter(entry, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [entry.name, entry.storage?.name, entry.source.name, entry.source.locator, entry.source.dataset]
    .filter(value => typeof value === 'string').join(' ').toLowerCase();
  return words.every(word => text.includes(word));
}

/**
 * The status line of All…: how many datasets, how many with saved states;
 * while filtering, how many match.
 *
 * @param {{total: number, shown: number, query: string, withSaved: number}} counts
 * @returns {string}
 */
export function describeListStatus({ total, shown, query, withSaved }) {
  if (total === 0) return '';
  const typed = String(query ?? '').trim();
  if (typed !== '') {
    return shown === 0 ? `No dataset matches "${typed}".` : `${formatCount(shown)} of ${formatCountOf(total, 'dataset')} match "${typed}".`;
  }
  return withSaved === 0
    ? `${formatCountOf(total, 'dataset')}, most recently opened first.`
    : `${formatCountOf(total, 'dataset')}, ${formatCount(withSaved)} with saved states, most recently opened first.`;
}

/**
 * What an export of a library file chose, in one line: how many datasets
 * and saved states and their size; that changes made while paused are left
 * out when a saved state ticked has some.
 *
 * @param {{datasets: number, states: ReadonlyArray<{bytes: number, paused?: boolean}>}} chosen
 * @returns {string}
 */
export function describeExportChoice({ datasets, states }) {
  if (datasets === 0 && states.length === 0) return 'Nothing is ticked.';
  const bytes = states.reduce((sum, state) => sum + state.bytes, 0);
  const sentence = `${formatCountOf(datasets, 'dataset')} and ${formatCountOf(states.length, 'saved state')}`
    + `${states.length === 0 ? '' : ` (${formatBytes(bytes)} kept here)`}.`;
  return states.some(state => state.paused)
    ? `${sentence} Changes made while recording was paused, not yet a step, are not exported.`
    : sentence;
}

/**
 * What an export wrote, in one sentence for the status line.
 *
 * @param {{datasets: number, histories: number, paused: number}} result - `exportLibrary`'s
 * @returns {string}
 */
export function describeExport({ datasets, histories, paused }) {
  const sentence = `Exported ${formatCountOf(datasets, 'dataset')} and ${formatCountOf(histories, 'saved state')}.`;
  return paused === 0
    ? sentence
    : `${sentence} Changes made while recording was paused (${formatCountOf(paused, 'saved state')}) were left out.`;
}

/**
 * What an import added, in one sentence for the status line: the datasets
 * and saved states added and the datasets already listed (an import adds
 * everything or nothing: a failure is thrown, `importLibrary`).
 *
 * @param {{datasets: {added: string[], present: string[]}, histories: {added: Array<{id: string, name: string}>}}} report -
 *   `importLibrary`'s
 * @returns {string}
 */
export function describeImport(report) {
  const { datasets, histories } = report;
  const added = [];
  if (datasets.added.length > 0) added.push(formatCountOf(datasets.added.length, 'dataset'));
  if (histories.added.length > 0) added.push(formatCountOf(histories.added.length, 'saved state'));
  const parts = [added.length === 0 ? 'Nothing was added' : `Added ${added.join(' and ')}`];
  if (datasets.present.length > 0) {
    parts.push(`${formatCountOf(datasets.present.length, 'dataset')} ${datasets.present.length === 1 ? 'was' : 'were'} already in ${PLACES.myDatasets.name}`);
  }
  return `${parts.join('; ')}.`;
}
