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
 * (format and host); the description, two lines with "More"; the bytes read
 * so far while it is read in place; and a "Details" disclosure with the rest
 * (source, citation, format, size, obs fields, embeddings, layers, raw,
 * neighbour graph, latent space, vector fields). Long values wrap; nothing is
 * cut with an ellipsis.
 *
 * A request for in-place data that fails for a moment and is made again is
 * said once, calmly, as a notification that closes when bytes arrive again
 * (while the dataset is still opening, its opening progress says so instead).
 *
 * @module ui/modules/dataset-card
 */

import {
  formatCompactCount,
  formatCount,
  formatCountOf,
} from '../components/display-format.js';
import { formatTransferBytes, getTransferLog } from '../../../data/transfer-log.js';
import { getNotificationCenter } from '../../notification-center.js';
import { getOpeningProgress } from '../../../data/opening-progress.js';

const CARD_DOM_KEYS = Object.freeze([
  'root',
  'spinner',
  'name',
  'summary',
  'cells',
  'genes',
  'origin',
  'descriptionBlock',
  'description',
  'descriptionToggle',
  'read',
  'details',
  'detailsList',
]);

/** The names a file opened without a source of its own is given. */
const GENERIC_SOURCE_NAMES = new Set([
  'H5AD file',
  'Zarr ZIP archive',
  'Zarr store folder',
  'Zarr store',
  'Zarr directory',
]);

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
 * How a stored dataset is named: "h5ad file", "Zarr v2 folder", "Zarr ZIP".
 *
 * @param {import('../../../data/anndata-storage.js').AnnDataStorage} storage
 * @returns {string}
 */
export function describeStorageFormat(storage) {
  if (storage.format === 'h5ad') return 'h5ad file';
  const version = storage.zarrVersion === null ? '' : ` v${storage.zarrVersion}`;
  return storage.container === 'zip' ? `Zarr${version} ZIP` : `Zarr${version} folder`;
}

/**
 * Where a dataset is read from, as one short line: "h5ad file · this
 * computer", "Zarr v2 folder · theislab.github.io".
 *
 * @param {import('../../../data/anndata-storage.js').AnnDataStorage|null} storage
 * @param {string} sourceType
 * @returns {string}
 */
export function describeOrigin(storage, sourceType) {
  if (storage === null) {
    return sourceType === 'jupyter' ? 'Jupyter' : '';
  }
  const where = storage.remote ? (hostOf(storage.url) ?? storage.url) : 'this computer';
  return `${describeStorageFormat(storage)} · ${where}`;
}

/**
 * The bytes read in place so far, as one line.
 *
 * @param {{bytes: number, requests: number}} entry
 * @param {boolean} receiving
 * @returns {string}
 */
export function describeRead(entry, receiving) {
  const amount = `${formatTransferBytes(entry.bytes)} read in ${formatCountOf(entry.requests, 'request')}`;
  return receiving ? `Reading… ${amount}` : amount;
}

function listNames(names) {
  if (names.length === 0) return 'None';
  return names.join(', ');
}

/**
 * The detail rows of one dataset, label and value, from what is known about
 * it. A row whose fact is unknown is left out.
 *
 * @param {Object} metadata - The dataset identity
 * @param {Object|null} storage
 * @param {Object|null} mapping - `describeMapping()`'s facts, or null
 * @param {number|null} [countedEdges] - The graph's edges, once they were read
 * @returns {Array<{label: string, value: string, href?: string}>}
 */
export function describeDetails(metadata, storage, mapping, countedEdges = null) {
  const rows = [];
  const source = metadata.source ?? null;
  // "H5AD file" and its kind say no more than Format does, and a source that
  // is the file itself says no more than File does.
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
    rows.push({ label: 'Format', value: `AnnData, ${describeStorageFormat(storage)}` });
    if (storage.bytes !== null) rows.push({ label: 'Size', value: formatTransferBytes(storage.bytes) });
    rows.push({
      label: 'Read',
      value: storage.remote
        ? `In place from ${hostOf(storage.url) ?? storage.url}, as views need it`
        : 'From this computer; nothing is uploaded',
    });
  }
  const stats = metadata.stats;
  rows.push({ label: 'Cells', value: formatCount(stats.n_cells) });
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
    if (mapping.layers !== null) rows.push({ label: 'Layers', value: listNames(mapping.layers) });
    if (mapping.raw !== null) {
      rows.push({ label: 'Raw', value: mapping.raw === false ? 'None' : formatCountOf(mapping.raw, 'gene') });
    }
  }
  const graph = mapping === null ? graphOf(stats) : mapping.graph;
  rows.push({
    label: 'Neighbour graph',
    value: describeGraph(graph !== null && graph.edges === null && countedEdges !== null ? { edges: countedEdges } : graph),
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
 * @param {{edges: number|null}|null} graph
 * @returns {string}
 */
export function describeGraph(graph) {
  if (graph === null) return 'None';
  if (graph.edges === null) return 'Present, counted when it is first drawn';
  return `${formatCompactCount(graph.edges)} edges`;
}

/**
 * @param {Object} options
 * @param {Object} options.dom - The box's elements (`CARD_DOM_KEYS`)
 * @param {(sourceType: string, datasetId: string) => Object|null} options.describeStorage
 *   Where the dataset is stored, or null when its source does not say
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

  function renderDetails(metadata, storage) {
    let mapping = null;
    try {
      mapping = describeMapping();
    } catch {
      mapping = null;
    }
    const rows = describeDetails(metadata, storage, mapping, loadedEdges);
    const nodes = [];
    for (const row of rows) {
      const term = ownerDocument.createElement('dt');
      term.textContent = row.label;
      const value = ownerDocument.createElement('dd');
      if (row.label === 'Neighbour graph') value.id = 'dataset-connectivity';
      if (row.href !== undefined) {
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
    const entry = readUrl === null ? null : log.entryFor(readUrl);
    if (entry === null || entry.bytes === 0) {
      elements.read.hidden = true;
      setText(elements.read, '');
      clearRetryNotice();
      return;
    }
    const receiving = entry.lastArrivalAt !== null &&
      view.performance.now() - entry.lastArrivalAt < RECEIVING_MS;
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
    // "Reading…" becomes the plain total once bytes stop arriving.
    if (receiving) scheduleRead(RECEIVING_MS);
  }

  function scheduleRead(delay = 0) {
    if (readFrame !== null) return;
    readFrame = view.setTimeout(() => view.requestAnimationFrame(renderRead), delay);
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
    setText(elements.description, '');
    elements.detailsList.replaceChildren();
  }

  /** No dataset is open. */
  function showNone() {
    shown = null;
    readUrl = null;
    loadedEdges = null;
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
    if (!sameDataset) loadedEdges = null;
    let storage = null;
    try {
      storage = describeStorage(sourceType, metadata.id);
    } catch {
      storage = null;
    }
    shown = { metadata, sourceType, storage };
    setText(elements.name, metadata.name);
    setText(elements.cells, formatCompactCount(metadata.stats.n_cells));
    elements.summary.hidden = false;
    const origin = describeOrigin(storage, sourceType);
    setText(elements.origin, origin);
    elements.origin.hidden = origin.length === 0;
    if (!sameDataset) {
      setDescription(metadata.description);
      collapseDetails();
    }
    elements.details.hidden = false;
    renderDetails(metadata, storage);
    readUrl = storage?.remote ? storage.url : null;
    if (!sameDataset) clearRetryNotice();
    renderRead();
    setState('ready');
  }

  /** The mapping changed (another graph, gene list, latent space): rewrite the facts. */
  function refreshFacts() {
    if (shown === null) return;
    renderDetails(shown.metadata, shown.storage);
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
    refreshFacts();
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
      clearRetryNotice();
      if (readFrame !== null) view.clearTimeout(readFrame);
    },
  });
}
