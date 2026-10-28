/**
 * @fileoverview The Dataset box at the top of the Session panel.
 *
 * It describes the dataset that is open, and only that one: every value is
 * written from the dataset's own identity (`metadata`), where it is stored
 * (`data/anndata-storage.js`), what its data mapping uses, and -- for data
 * read in place from a host -- how much of it has been read
 * (`data/transfer-log.js`). Showing a dataset, a load in progress or no
 * dataset rewrites the whole box, so nothing of an earlier dataset is ever
 * left in it.
 *
 * Layout: the name; one summary line (cells, genes); where it is read from
 * (format and host); for a format read once into this browser (an `.rds`, a
 * MatrixMarket folder), one line saying where it is kept and how many parts
 * were not read; the description, two lines with "More"; the bytes read
 * so far while it is read in place; and a "Details" disclosure with the rest
 * (source, citation, format, size, where it is kept, what was not read, obs
 * fields, embeddings, layers, raw, neighbour graph, latent space, vector
 * fields). Long values wrap; nothing is cut with an ellipsis.
 *
 * A request for in-place data that fails for a moment and is made again is
 * said once, calmly, as a notification that closes when bytes arrive again
 * (while the dataset is still opening, its opening progress says so instead).
 *
 * @module ui/modules/dataset-card
 */

import { formatCompactCount } from '../components/display-format.js';
import { getTransferLog } from '../../../data/transfer-log.js';
import { INPUT_FORMATS, inputFormat } from '../../../data/input-formats.js';
import { getNotificationCenter } from '../../notification-center.js';
import { getOpeningProgress } from '../../../data/opening-progress.js';
import { READ_IN_PARTS_INSTEAD, wholeReadKept, wholeReadLine } from '../../../data/whole-read-notice.js';
import { formatBytes, formatCount, formatCountOf, countNoun } from '../../../utils/format-units.js';
import { describeSubsampleMethod } from '../../../data/subsample.js';

const CARD_DOM_KEYS = Object.freeze([
  'root',
  'spinner',
  'name',
  'summary',
  'cells',
  'genes',
  'origin',
  'conversion',
  'descriptionBlock',
  'description',
  'descriptionToggle',
  'read',
  'details',
  'detailsList',
]);

/**
 * The names a file opened without a source of its own is given: its input
 * format's label (`data/anndata-file-source.js`), "AnnData (.h5ad)", "R
 * object (.rds)".
 */
const GENERIC_SOURCE_NAMES = new Set(INPUT_FORMATS.map(format => format.label));

/** A description longer than this many characters is shown two lines at a time. */
const DESCRIPTION_FOLD_CHARS = 120;

/** Bytes that arrived this recently mean the dataset is being read now. */
const RECEIVING_MS = 1500;

function requireDom(dom) {
  if (dom === null || typeof dom !== 'object') {
    throw new TypeError('The Dataset box requires its DOM elements.');
  }
  for (const key of CARD_DOM_KEYS) {
    if (dom[key] === null || typeof dom[key] !== 'object') {
      throw new TypeError(`The Dataset box requires its ${key} element.`);
    }
  }
  return dom;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * How a stored dataset is named, by its input format (`input-formats.js`):
 * "h5ad file", "Zarr v2 folder", "Zarr ZIP", "Loom (.loom)", "MuData Zarr
 * v3 folder", "Cell Ranger outs/ folder", "R object (.rds)" (that one read
 * once into this browser says so on a line of its own: `describeConversion`).
 *
 * @param {import('../../../data/anndata-storage.js').AnnDataStorage} storage
 * @returns {string}
 */
export function describeStorageFormat(storage) {
  const format = inputFormat(storage.format);
  if (format.id === 'h5ad') return 'h5ad file';
  if (format.container === 'zarr') {
    const version = storage.zarrVersion === null ? '' : ` v${storage.zarrVersion}`;
    const name = format.id === 'zarr' ? 'Zarr' : format.label;
    return storage.layout === 'zip' ? `${name}${version} ZIP` : `${name}${version} folder`;
  }
  return format.label;
}

/** Whether a stored dataset is AnnData as written, or another format read as AnnData. */
function isStoredAnnData(storage) {
  return storage.format === 'h5ad' || storage.format === 'zarr';
}

/**
 * Where a dataset is read from, as one short line: "h5ad file · this
 * computer", "Zarr v2 folder · theislab.github.io", and for a dataset a host
 * program serves its viewer, the program: "Seurat object (.rds) · R",
 * "h5ad file · Jupyter".
 *
 * @param {import('../../../data/anndata-storage.js').AnnDataStorage|null} storage
 * @param {string|null} [host] - The program serving the viewer ("Python",
 *   "Jupyter", "R"), or null
 * @returns {string}
 */
export function describeOrigin(storage, host = null) {
  if (storage === null) {
    return host ?? '';
  }
  const where = host ?? (storage.remote ? (hostOf(storage.url) ?? storage.url) : 'this computer');
  return `${describeStorageFormat(storage)} · ${where}`;
}

/**
 * How a dataset read once into this browser was read, where it is kept, and
 * how many parts of it were not read, as one short line; '' for any other
 * dataset (`data/whole-read-notice.js`).
 *
 * @param {import('../../../data/anndata-storage.js').AnnDataStorage|null} storage
 * @returns {string}
 */
export function describeConversion(storage) {
  const conversion = storage?.conversion ?? null;
  if (conversion === null) return '';
  const kept = wholeReadLine(conversion);
  const skipped = conversion.notes.length;
  return skipped === 0 ? kept : `${kept} · ${formatCountOf(skipped, 'part')} not read`;
}

/**
 * The bytes read in place so far, as one line.
 *
 * @param {{bytes: number, requests: number}} entry
 * @param {boolean} receiving
 * @returns {string}
 */
export function describeRead(entry, receiving) {
  const amount = `${formatBytes(entry.bytes)} read in ${formatCountOf(entry.requests, 'request')}`;
  return receiving ? `Reading… ${amount}` : amount;
}

function listNames(names) {
  if (names.length === 0) return 'None';
  return names.join(', ');
}

/**
 * The detail rows of one dataset, label and value, from what is known about
 * it. A row whose fact is unknown is left out. A row of several facts (what
 * was not read) has `lines`, one per fact, and `value` them joined.
 *
 * @param {Object} metadata - The dataset identity
 * @param {Object|null} storage
 * @param {Object|null} mapping - `describeMapping()`'s facts, or null
 * @param {number|null} [countedEdges] - The graph's edges, once they were read
 * @param {Object|null} [cells] - The cells open (`getCellSubset()`)
 * @param {{kept: number, of: number}|null} [graphShare] - How much of the
 *   graph a subsample keeps, once it was read (`subsampleGraphShare`)
 * @returns {Array<{label: string, value: string, href?: string, lines?: string[]}>}
 */
export function describeDetails(metadata, storage, mapping, countedEdges = null, cells = null, graphShare = null) {
  const rows = [];
  const source = metadata.source ?? null;
  // A format's label ("AnnData (.h5ad)") says no more than Format does, and
  // a source that is the file itself says no more than File does.
  const sourceIsFile = source !== null && storage !== null && (
    (source.url !== undefined && source.url === storage.url) ||
    (source.url === undefined && source.name === storage.name)
  );
  if (source !== null && !sourceIsFile && (source.url || !GENERIC_SOURCE_NAMES.has(source.name))) {
    rows.push({ label: 'Source', value: source.name, ...(source.url ? { href: source.url } : {}) });
  }
  if (metadata.citation !== undefined) {
    rows.push({
      label: 'Citation',
      value: metadata.citation.text,
      ...(metadata.citation.url ? { href: metadata.citation.url } : {}),
    });
  }
  if (storage !== null) {
    rows.push({ label: 'File', value: storage.name, ...(storage.remote ? { href: storage.url } : {}) });
    rows.push({ label: 'Format', value: isStoredAnnData(storage) ? `AnnData, ${describeStorageFormat(storage)}` : describeStorageFormat(storage) });
    if (storage.bytes !== null) rows.push({ label: 'Size', value: formatBytes(storage.bytes) });
    const conversion = storage.conversion ?? null;
    let read;
    if (conversion !== null) {
      const how = conversion.whole === false
        ? 'Its structure once, its arrays in place'
        : 'Whole, once, from start to end (it cannot be read in parts)';
      read = storage.remote
        ? `${how}, from ${hostOf(storage.url) ?? storage.url}`
        : `${how}, from this computer; nothing is uploaded`;
    } else {
      read = storage.remote
        ? `In place from ${hostOf(storage.url) ?? storage.url}, as views need it`
        : 'From this computer; nothing is uploaded';
    }
    rows.push({ label: 'Read', value: read });
    if (conversion !== null) {
      rows.push({ label: 'Kept', value: wholeReadKept(conversion) });
      if (conversion.whole !== false) rows.push({ label: 'Read in parts', value: READ_IN_PARTS_INSTEAD });
      if (conversion.notes.length > 0) {
        rows.push({ label: 'Not read', value: conversion.notes.join('\n'), lines: [...conversion.notes] });
      }
    }
  }
  const stats = metadata.stats;
  // A subsample: how many of the file's cells are open, and how they were chosen.
  rows.push(cells?.kept != null
    ? { label: 'Cells', value: `${formatCount(cells.kept.length)} of ${formatCount(cells.nObs)} (${describeSubsampleMethod(cells.spec)}${cells.autoFit !== null ? ', fitted to this device' : ''})` }
    : { label: 'Cells', value: formatCount(cells?.nObs ?? stats.n_cells) });
  rows.push({ label: 'Genes', value: formatCount(mapping?.genes ?? stats.n_genes) });
  rows.push({
    label: 'Obs fields',
    value: `${formatCount(stats.n_obs_fields)} (${formatCount(stats.n_categorical_fields)} categorical, `
      + `${formatCount(stats.n_continuous_fields)} continuous)`,
  });
  if (mapping !== null) {
    rows.push({
      label: 'Embeddings',
      value: mapping.embeddings.shown.length === 0
        ? 'None'
        : `${listNames(mapping.embeddings.shown)}`
          + (mapping.embeddings.arrays > mapping.embeddings.shown.length
            ? ` (${formatCount(mapping.embeddings.shown.length)} of ${formatCountOf(mapping.embeddings.arrays, 'obsm array')})`
            : ''),
    });
    if (mapping.modality !== undefined && mapping.modality !== null) rows.push({ label: 'Modality', value: mapping.modality });
    if (mapping.layers !== null) rows.push({ label: 'Layers', value: listNames(mapping.layers) });
    if (mapping.raw !== null) {
      rows.push({ label: 'Raw', value: mapping.raw === false ? 'None' : formatCountOf(mapping.raw, 'gene') });
    }
  }
  const graph = mapping === null ? graphOf(stats) : mapping.graph;
  const graphValue = describeGraph(graph !== null && graph.edges === null && countedEdges !== null ? { edges: countedEdges } : graph);
  rows.push({
    label: 'Neighbour graph',
    value: graph !== null && cells?.kept != null && graphShare !== null
      ? `${graphValue} (${describeGraphShare(graphShare)})`
      : graphValue,
  });
  if (mapping !== null) {
    rows.push({ label: 'Latent space', value: mapping.latent ?? 'None' });
    rows.push({ label: 'Vector fields', value: listNames(mapping.vectorFields) });
  }
  return rows;
}

function graphOf(stats) {
  return stats.has_connectivity ? { edges: stats.n_edges } : null;
}

/**
 * How much of its neighbour graph a subsample keeps: the share of the open
 * cells' edges that join two open cells (the others lead to cells left out,
 * and cannot be drawn).
 *
 * @param {{kept: number, of: number}} share
 * @returns {string}
 */
export function describeGraphShare({ kept, of }) {
  if (of === 0) return 'no edge of the open cells';
  const percent = (100 * kept) / of;
  const shown = percent >= 10 || percent === 0 ? Math.round(percent) : Number(percent.toPrecision(2));
  return `${shown} % of the open cells' edges; the others lead to cells not open`;
}

/**
 * @param {{edges: number|null}|null} graph
 * @returns {string}
 */
export function describeGraph(graph) {
  if (graph === null) return 'None';
  if (graph.edges === null) return 'Present, counted when it is first drawn';
  return `${formatCompactCount(graph.edges)} ${countNoun(graph.edges, 'edge')}`;
}

/**
 * @param {Object} options
 * @param {Object} options.dom - The box's elements (`CARD_DOM_KEYS`)
 * @param {(sourceType: string, datasetId: string) => Object|null} options.describeStorage
 *   Where the dataset is stored, or null when its source does not say
 * @param {(sourceType: string) => string|null} [options.describeHost] - The
 *   program serving the viewer a source belongs to ("Python", "Jupyter",
 *   "R"), or null for any other source
 * @param {() => Object|null} options.describeMapping - What the open
 *   dataset's mapping uses (`{genes, graph, embeddings: {shown, arrays},
 *   layers, raw, latent, vectorFields}`), or null without a mapping
 * @param {Object} [options.log] - The Transfers log
 * @param {Object} [options.notifications]
 * @param {{active: boolean}} [options.opening] - The page's opening progress
 */
export function initDatasetCard({
  dom,
  describeStorage,
  describeMapping,
  describeHost = () => null,
  describeCells = () => null,
  describeGraphShare = () => Promise.resolve(null),
  log = getTransferLog(),
  notifications = getNotificationCenter(),
  opening = getOpeningProgress(),
}) {
  const elements = requireDom(dom);
  if (typeof describeStorage !== 'function' || typeof describeMapping !== 'function') {
    throw new TypeError('The Dataset box requires describeStorage and describeMapping.');
  }
  const ownerDocument = elements.root.ownerDocument;
  const view = ownerDocument.defaultView;
  const lifecycle = new AbortController();
  /** What the box shows: null for no dataset. */
  let shown = null;
  let readUrl = null;
  let retryNotice = null;
  let readFrame = null;
  let descriptionOpen = false;
  let loadedEdges = null;
  /** How much of the graph in use the subsample keeps, once it was read. */
  let graphShare = null;
  let graphShareRequest = 0;

  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  function setDescription(text) {
    const has = text.length > 0;
    elements.descriptionBlock.hidden = !has;
    setText(elements.description, text);
    const folds = text.length > DESCRIPTION_FOLD_CHARS;
    elements.descriptionToggle.hidden = !folds;
    descriptionOpen = false;
    applyDescriptionFold(folds);
  }

  function applyDescriptionFold(folds) {
    elements.description.dataset.folded = String(folds && !descriptionOpen);
    elements.descriptionToggle.setAttribute('aria-expanded', String(descriptionOpen));
    setText(elements.descriptionToggle, descriptionOpen ? 'Less' : 'More');
  }

  elements.descriptionToggle.addEventListener('click', () => {
    descriptionOpen = !descriptionOpen;
    applyDescriptionFold(true);
  }, { signal: lifecycle.signal });

  function renderDetails(metadata, storage, cells = null) {
    let mapping = null;
    try {
      mapping = describeMapping();
    } catch {
      mapping = null;
    }
    const rows = describeDetails(metadata, storage, mapping, loadedEdges, cells, graphShare);
    const nodes = [];
    for (const row of rows) {
      const term = ownerDocument.createElement('dt');
      term.textContent = row.label;
      const value = ownerDocument.createElement('dd');
      if (row.label === 'Neighbour graph') value.id = 'dataset-connectivity';
      if (row.lines !== undefined) {
        // Several facts take the box's whole width, under their label.
        term.className = 'dataset-card-facts-wide';
        value.className = 'dataset-card-facts-wide';
        for (const line of row.lines) {
          const fact = ownerDocument.createElement('div');
          fact.textContent = line;
          value.appendChild(fact);
        }
      } else if (row.href !== undefined) {
        const link = ownerDocument.createElement('a');
        link.href = row.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = row.value;
        value.appendChild(link);
      } else {
        value.textContent = row.value;
      }
      nodes.push(term, value);
    }
    elements.detailsList.replaceChildren(...nodes);
    setText(elements.genes, formatCompactCount(mapping?.genes ?? metadata.stats.n_genes));
  }

  /** Each dataset starts with its Details closed. */
  function collapseDetails() {
    const header = elements.details.querySelector('.disclosure-header');
    const content = elements.detailsList.parentElement;
    header?.setAttribute('aria-expanded', 'false');
    if (content !== null) content.hidden = true;
  }

  function clearRetryNotice() {
    if (retryNotice === null) return;
    try {
      notifications.dismiss(retryNotice);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
    retryNotice = null;
  }

  function renderRead() {
    readFrame = null;
    // The card was destroyed while this frame waited: a notice posted now
    // would outlive it, with nothing left to dismiss it.
    if (lifecycle.signal.aborted) return;
    const entry = readUrl === null ? null : log.entryFor(readUrl);
    if (entry === null || entry.bytes === 0) {
      elements.read.hidden = true;
      setText(elements.read, '');
      clearRetryNotice();
      return;
    }
    const age = entry.lastArrivalAt === null ? Infinity : view.performance.now() - entry.lastArrivalAt;
    const receiving = age < RECEIVING_MS;
    elements.read.hidden = false;
    setText(elements.read, describeRead(entry, receiving));
    // While the dataset opens, its opening progress says it is retrying.
    if (entry.retrying !== null && !opening.active) {
      const message = `Reading ${entry.label} again: a request did not complete. Cellucid keeps trying.`;
      if (retryNotice === null) {
        retryNotice = notifications.info(message, { category: 'data', duration: 0, title: 'Retrying a read' });
      }
    } else {
      clearRetryNotice();
    }
    // "Reading…" becomes the plain total once bytes stop arriving: the box
    // redraws when the last arrival is `RECEIVING_MS` old, and a redraw that
    // finds a later arrival waits for what is left of that one's window.
    // Waiting a whole window from this redraw instead left "Reading…" up for
    // nearly two windows whenever bytes arrived just after it (a first gene
    // read settled 1.5 s late in some runs and not others).
    if (receiving) scheduleRead(RECEIVING_MS - age);
  }

  function scheduleRead(delay = 0) {
    if (readFrame !== null) return;
    const timer = view.setTimeout(() => {
      readFrame = { frame: view.requestAnimationFrame(renderRead) };
    }, delay);
    readFrame = { timer };
  }

  function cancelRead() {
    if (readFrame === null) return;
    if (readFrame.timer !== undefined) view.clearTimeout(readFrame.timer);
    if (readFrame.frame !== undefined) view.cancelAnimationFrame(readFrame.frame);
    readFrame = null;
  }

  const unsubscribeLog = log.subscribe(() => scheduleRead());
  lifecycle.signal.addEventListener('abort', unsubscribeLog, { once: true });

  function setState(state) {
    elements.root.dataset.state = state;
    elements.root.setAttribute('aria-busy', String(state === 'loading'));
    elements.spinner.hidden = state !== 'loading';
  }

  function hideFacts() {
    elements.summary.hidden = true;
    elements.origin.hidden = true;
    elements.descriptionBlock.hidden = true;
    elements.read.hidden = true;
    elements.details.hidden = true;
    setText(elements.cells, '');
    setText(elements.genes, '');
    setText(elements.origin, '');
    elements.conversion.hidden = true;
    setText(elements.conversion, '');
    setText(elements.description, '');
    elements.detailsList.replaceChildren();
  }

  /** No dataset is open. */
  function showNone() {
    shown = null;
    readUrl = null;
    loadedEdges = null;
    graphShare = null;
    clearRetryNotice();
    hideFacts();
    setText(elements.name, 'No dataset open');
    setState('empty');
  }

  /**
   * A dataset is being opened; `label` says which ("Opening data.h5ad…").
   *
   * @param {string} label
   */
  function showLoading(label) {
    if (typeof label !== 'string' || label.length === 0) {
      throw new TypeError('A loading Dataset box needs its label.');
    }
    shown = null;
    readUrl = null;
    loadedEdges = null;
    graphShare = null;
    clearRetryNotice();
    hideFacts();
    setText(elements.name, label);
    setState('loading');
  }

  /**
   * Show one open dataset.
   *
   * @param {Object} metadata - Its identity
   * @param {string} sourceType
   */
  function show(metadata, sourceType) {
    const sameDataset = shown !== null && shown.metadata.id === metadata.id && shown.sourceType === sourceType;
    if (!sameDataset) {
      loadedEdges = null;
      graphShare = null;
    }
    let storage = null;
    try {
      storage = describeStorage(sourceType, metadata.id);
    } catch {
      storage = null;
    }
    let cells = null;
    try {
      cells = describeCells(sourceType, metadata.id);
    } catch {
      cells = null;
    }
    shown = { metadata, sourceType, storage, cells };
    setText(elements.name, metadata.name);
    // A subsample: the cells open of the cells in the file.
    setText(elements.cells, cells?.kept != null
      ? `${formatCompactCount(cells.kept.length)} of ${formatCompactCount(cells.nObs)}`
      : formatCompactCount(cells?.nObs ?? metadata.stats.n_cells));
    elements.summary.hidden = false;
    const origin = describeOrigin(storage, describeHost(sourceType));
    setText(elements.origin, origin);
    elements.origin.hidden = origin.length === 0;
    const conversion = describeConversion(storage);
    setText(elements.conversion, conversion);
    elements.conversion.hidden = conversion.length === 0;
    if (!sameDataset) {
      setDescription(metadata.description);
      collapseDetails();
    }
    elements.details.hidden = false;
    renderDetails(metadata, storage, cells);
    readUrl = storage?.remote ? storage.url : null;
    if (!sameDataset) clearRetryNotice();
    renderRead();
    setState('ready');
  }

  /** The mapping changed (another graph, gene list, latent space): rewrite the facts. */
  function refreshFacts() {
    if (shown === null) return;
    renderDetails(shown.metadata, shown.storage, shown.cells);
  }

  /**
   * The edges of the graph in use were read and counted.
   *
   * @param {number} edges
   */
  function showLoadedConnectivityEdges(edges) {
    if (!Number.isSafeInteger(edges) || edges < 0) {
      throw new TypeError('Connectivity edge count must be a non-negative integer.');
    }
    loadedEdges = edges;
    graphShare = null;
    refreshFacts();
    // A subsample: how much of the graph it keeps, now that it was read.
    if (shown?.cells?.kept == null) return;
    const request = ++graphShareRequest;
    const { metadata, sourceType } = shown;
    Promise.resolve(describeGraphShare(sourceType, metadata.id)).then(share => {
      if (request !== graphShareRequest || shown?.metadata !== metadata) return;
      graphShare = share;
      refreshFacts();
    }, () => {});
  }

  showNone();

  return Object.freeze({
    show,
    showLoading,
    showNone,
    refreshFacts,
    showLoadedConnectivityEdges,
    destroy() {
      lifecycle.abort();
      cancelRead();
      clearRetryNotice();
    },
  });
}
