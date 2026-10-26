/**
 * The Session panel's Dataset box describes the open dataset and nothing
 * else: every show rewrites it from that dataset alone, so nothing of an
 * earlier dataset is ever left in it, and nothing in it is cut mid-word.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeConversion,
  describeDetails,
  describeGraph,
  describeOrigin,
  describeRead,
  describeStorageFormat,
  initDatasetCard,
} from '../assets/js/app/ui/modules/dataset-card.js';
import { TransferLog } from '../assets/js/data/transfer-log.js';
import { describeAnnDataStorage } from '../assets/js/data/anndata-storage.js';

/** A view whose timers wait to be run: the box redraws on its own clock. */
function fakeView() {
  return {
    performance,
    setTimeout: () => 1,
    clearTimeout() {},
    requestAnimationFrame: fn => fn(),
  };
}

function fakeDocument(view = fakeView()) {
  const documentOwner = {
    defaultView: view,
    createElement: tag => element(documentOwner, tag),
  };
  return documentOwner;
}

function element(ownerDocument, tag = 'div') {
  const listeners = new Map();
  const node = {
    tagName: tag.toUpperCase(),
    ownerDocument,
    hidden: false,
    dataset: {},
    attributes: new Map(),
    children: [],
    textContent: '',
    parentElement: null,
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    click() {
      listeners.get('click')?.();
    },
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      return child;
    },
    replaceChildren(...children) {
      this.children = [];
      for (const child of children) this.appendChild(child);
    },
    querySelector() {
      return header;
    },
  };
  const header = { attributes: new Map(), setAttribute(name, value) { this.attributes.set(name, value); } };
  return node;
}

function makeCard({ storage = null, mapping = null, log = new TransferLog({ console: null }), view = fakeView() } = {}) {
  const documentOwner = fakeDocument(view);
  const make = () => element(documentOwner);
  const dom = {
    root: make(),
    spinner: make(),
    name: make(),
    summary: make(),
    cells: make(),
    genes: make(),
    origin: make(),
    conversion: make(),
    descriptionBlock: make(),
    description: make(),
    descriptionToggle: make(),
    read: make(),
    details: make(),
    detailsList: make(),
  };
  const content = make();
  content.appendChild(dom.detailsList);
  const notices = [];
  const card = initDatasetCard({
    dom,
    describeStorage: () => storage,
    describeMapping: () => mapping,
    log,
    notifications: {
      info: message => {
        notices.push(message);
        return `notice-${notices.length}`;
      },
      dismiss() {},
    },
    opening: { active: false },
  });
  return { card, dom, notices, log };
}

function identity(name, overrides = {}) {
  return {
    id: name.toLowerCase().replace(/\W+/g, '-'),
    name,
    description: '',
    stats: {
      n_cells: 561947,
      n_genes: 5103,
      n_obs_fields: 16,
      n_categorical_fields: 14,
      n_continuous_fields: 2,
      has_connectivity: true,
      n_edges: null,
    },
    embeddings: { default_dimension: 2, defaults: {}, items: {} },
    obs_fields: [],
    ...overrides,
  };
}

const ZARR_FOLDER = Object.freeze({
  format: 'zarr',
  zarrVersion: 2,
  layout: 'folder',
  remote: true,
  url: 'https://theislab.github.io/cellucid-datasets/anndata/suo.zarr/',
  name: 'suo.zarr',
  bytes: null,
  conversion: null,
});
const LOCAL_H5AD = Object.freeze({
  format: 'h5ad',
  zarrVersion: null,
  layout: 'file',
  remote: false,
  url: null,
  name: 'cells.h5ad',
  bytes: 1_260_000_000,
  conversion: null,
});
const NOT_READ = Object.freeze([
  'assays$RNA@scale.data (15 KB): Cellucid does not use it.',
  'commands (7.4 KB): Cellucid does not use it.',
]);
/** A Seurat object read once into this browser's storage (`describeAnnDataStorage`). */
const LOCAL_RDS = Object.freeze({
  format: 'rds',
  zarrVersion: null,
  layout: 'file',
  remote: false,
  url: null,
  name: 'pbmc_small.rds',
  bytes: 512_000,
  conversion: Object.freeze({ kept: 'opfs', reused: false, notes: NOT_READ }),
});

test('where a dataset is read from is one short line', () => {
  assert.equal(describeStorageFormat(ZARR_FOLDER), 'Zarr v2 folder');
  assert.equal(describeStorageFormat({ ...ZARR_FOLDER, layout: 'zip', zarrVersion: 3 }), 'Zarr v3 ZIP');
  assert.equal(describeStorageFormat(LOCAL_H5AD), 'h5ad file');
  assert.equal(describeOrigin(ZARR_FOLDER), 'Zarr v2 folder · theislab.github.io');
  assert.equal(describeOrigin(LOCAL_H5AD), 'h5ad file · this computer');
  // A host program's viewer names the program, never its loopback address.
  assert.equal(describeOrigin({ ...LOCAL_H5AD, remote: true, url: 'http://127.0.0.1:8765/_cellucid/anndata/x.h5ad' }, 'R'), 'h5ad file · R');
  assert.equal(describeOrigin(null, 'Jupyter'), 'Jupyter');
  assert.equal(describeOrigin(null), '');
  assert.equal(describeRead({ bytes: 5_767_168, requests: 43 }, false), '5.5 MB read in 43 requests');
  assert.equal(describeRead({ bytes: 1024, requests: 1 }, true), 'Reading… 1.0 KB read in 1 request');
  assert.equal(describeGraph(null), 'None');
  assert.equal(describeGraph({ edges: null }), 'Present, counted when it is first drawn');
  assert.equal(describeGraph({ edges: 1234 }), '1.2K edges');
});

test('details list what the reader knows, links where there is an address', () => {
  const rows = describeDetails(
    identity('Suo', {
      source: { name: 'E-MTAB-11343', url: 'https://www.ebi.ac.uk/biostudies/arrayexpress/studies/E-MTAB-11343' },
      citation: { text: 'Suo et al. 2022', url: 'https://doi.org/10.1126/science.abo0510' },
    }),
    ZARR_FOLDER,
    {
      genes: 5103,
      graph: { edges: null },
      embeddings: { shown: ['UMAP 2D', 'UMAP 3D'], arrays: 5 },
      layers: [],
      raw: false,
      latent: 'scanvi',
      vectorFields: [],
    },
    2_000_000,
  );
  const byLabel = Object.fromEntries(rows.map(row => [row.label, row]));
  assert.deepEqual(Object.keys(byLabel), [
    'Source', 'Citation', 'File', 'Format', 'Read', 'Cells', 'Genes', 'Obs fields',
    'Embeddings', 'Layers', 'Raw', 'Neighbour graph', 'Latent space', 'Vector fields',
  ]);
  assert.equal(byLabel.Source.href, 'https://www.ebi.ac.uk/biostudies/arrayexpress/studies/E-MTAB-11343');
  assert.equal(byLabel.Citation.href, 'https://doi.org/10.1126/science.abo0510');
  assert.equal(byLabel.File.href, ZARR_FOLDER.url);
  assert.equal(byLabel.Format.value, 'AnnData, Zarr v2 folder');
  assert.equal(byLabel.Cells.value, '561,947');
  assert.equal(byLabel['Obs fields'].value, '16 (14 categorical, 2 continuous)');
  assert.equal(byLabel.Embeddings.value, 'UMAP 2D, UMAP 3D (2 of 5 obsm arrays)');
  assert.equal(byLabel['Neighbour graph'].value, '2M edges');
  assert.equal(byLabel['Latent space'].value, 'scanvi');
  assert.equal(byLabel['Vector fields'].value, 'None');
});

test('a file opened without a source of its own names no generic source', () => {
  const rows = describeDetails(identity('cells', { source: { name: 'AnnData (.h5ad)', filename: 'cells.h5ad' } }), LOCAL_H5AD, null);
  assert.equal(rows.some(row => row.label === 'Source'), false);
  assert.equal(rows.find(row => row.label === 'Size').value, '1.2 GB');
  assert.equal(rows.find(row => row.label === 'Read').value, 'From this computer; nothing is uploaded');
});

test('every show rewrites the box: nothing of an earlier dataset stays', () => {
  const log = new TransferLog({ console: null });
  const entry = log.begin({ key: ZARR_FOLDER.url, label: 'Suo', why: 'reading on demand' });
  log.record(ZARR_FOLDER.url, { bytes: 5_767_168, requests: 43, absolute: true });
  const harness = makeCard({ storage: ZARR_FOLDER, log });
  const { card, dom } = harness;
  assert.equal(dom.name.textContent, 'No dataset open');
  assert.equal(dom.root.dataset.state, 'empty');

  card.show(identity('Developing human immune system (Suo)', { description: 'Mapping the developing human immune system across organs' }), 'local-demo');
  assert.equal(dom.root.dataset.state, 'ready');
  assert.equal(dom.cells.textContent, '562K');
  assert.equal(dom.origin.textContent, 'Zarr v2 folder · theislab.github.io');
  assert.equal(dom.read.hidden, false);
  assert.match(dom.read.textContent, /(^|… )5\.5 MB read in 43 requests$/);
  assert.equal(dom.description.textContent, 'Mapping the developing human immune system across organs');
  log.finish(entry);

  card.showLoading('Opening cells.h5ad…');
  assert.equal(dom.root.dataset.state, 'loading');
  assert.equal(dom.spinner.hidden, false);
  assert.equal(dom.name.textContent, 'Opening cells.h5ad…');
  for (const part of ['summary', 'origin', 'conversion', 'descriptionBlock', 'read', 'details']) {
    assert.equal(dom[part].hidden, true, `${part} is hidden while a dataset opens`);
  }
  assert.equal(dom.detailsList.children.length, 0);

  card.showNone();
  assert.equal(dom.name.textContent, 'No dataset open');
  assert.equal(dom.spinner.hidden, true);
  assert.equal(dom.read.hidden, true);
});

test('a file read at an address with a query string (Google Drive) still has its read line', () => {
  const url = 'https://www.googleapis.com/drive/v3/files/1DDCowUuZ7PPFUSZsjvSqntWkYJMjf1Na?alt=media&supportsAllDrives=true';
  const storage = describeAnnDataStorage({ file: { url, size: 109_000_000 } }, { format: 'h5ad', layout: 'file', name: 'placenta_adata.h5ad' });
  // The box names the file by its address alone; the log keys it as read.
  assert.equal(storage.url, 'https://www.googleapis.com/drive/v3/files/1DDCowUuZ7PPFUSZsjvSqntWkYJMjf1Na');
  const log = new TransferLog({ console: null });
  log.begin({ key: url, label: 'placenta_adata', why: 'reading on demand' });
  log.record(url, { bytes: 1_900_000, requests: 22, absolute: true });
  const { card, dom } = makeCard({ storage, log });
  card.show(identity('placenta_adata'), 'link');
  assert.equal(dom.read.hidden, false);
  assert.match(dom.read.textContent, /(^|… )1\.8 MB read in 22 requests$/);
});

test('a long description folds to two lines with More', () => {
  const { card, dom } = makeCard({ storage: LOCAL_H5AD });
  card.show(identity('Atlas', { description: 'x '.repeat(100) }), 'local-user');
  assert.equal(dom.descriptionToggle.hidden, false);
  assert.equal(dom.description.dataset.folded, 'true');
  dom.descriptionToggle.click();
  assert.equal(dom.description.dataset.folded, 'false');
  assert.equal(dom.descriptionToggle.textContent, 'Less');
});

test('a dataset read once into this browser says where it is kept and how much was not read, in one line', () => {
  assert.equal(describeConversion(null), '');
  assert.equal(describeConversion(LOCAL_H5AD), '', 'an AnnData file has no such line');
  assert.equal(describeConversion(LOCAL_RDS), "Read once into this browser's storage for this tab · 2 parts not read");
  const one = { ...LOCAL_RDS, conversion: { ...LOCAL_RDS.conversion, notes: NOT_READ.slice(0, 1) } };
  assert.equal(describeConversion(one), "Read once into this browser's storage for this tab · 1 part not read");
  const whole = { ...LOCAL_RDS, conversion: { kept: 'opfs', reused: false, notes: [] } };
  assert.equal(describeConversion(whole), "Read once into this browser's storage for this tab");
  const reused = { ...LOCAL_RDS, conversion: { kept: 'opfs', reused: true, notes: [] } };
  assert.equal(describeConversion(reused), "Opened from this browser's storage, read earlier in this tab");
  const memory = { ...LOCAL_RDS, conversion: { kept: 'memory', reused: false, notes: NOT_READ } };
  assert.equal(describeConversion(memory), 'Read once into memory for this tab · 2 parts not read');
  // The format is named as it is; the line above says it was read once.
  assert.equal(describeStorageFormat(LOCAL_RDS), 'R object (.rds)');
  assert.equal(describeOrigin(LOCAL_RDS), 'R object (.rds) · this computer');
});

test('the details of a converted dataset say how it was read, where it is kept, and each part not read', () => {
  const rows = describeDetails(identity('pbmc_small', { source: { name: 'R object (.rds)', filename: 'pbmc_small.rds' } }), LOCAL_RDS, null);
  const byLabel = Object.fromEntries(rows.map(row => [row.label, row]));
  assert.deepEqual(Object.keys(byLabel).slice(0, 6), ['File', 'Format', 'Size', 'Read', 'Kept', 'Not read']);
  assert.equal(byLabel.Format.value, 'R object (.rds)');
  assert.equal(byLabel.Read.value, 'Once, from start to end, from this computer; nothing is uploaded');
  assert.equal(byLabel.Kept.value, "In this browser's storage (the origin-private file system) until this tab closes");
  assert.deepEqual(byLabel['Not read'].lines, NOT_READ);
  assert.equal(byLabel['Not read'].value, NOT_READ.join('\n'));

  const remote = { ...LOCAL_RDS, remote: true, url: 'https://ftp.ncbi.nlm.nih.gov/geo/series/pbmc_small.rds' };
  const remoteRows = describeDetails(identity('pbmc_small'), remote, null);
  assert.equal(remoteRows.find(row => row.label === 'Read').value, 'Once, from start to end, from ftp.ncbi.nlm.nih.gov');

  const reused = describeDetails(identity('pbmc_small'), { ...LOCAL_RDS, conversion: { kept: 'opfs', reused: true, notes: [] } }, null);
  assert.equal(reused.find(row => row.label === 'Kept').value, "In this browser's storage until this tab closes; read when it was first opened in this tab, not again");
  assert.equal(reused.some(row => row.label === 'Not read'), false, 'nothing left out, no row');

  const memory = describeDetails(identity('pbmc_small'), { ...LOCAL_RDS, conversion: { kept: 'memory', reused: false, notes: [] } }, null);
  assert.equal(memory.find(row => row.label === 'Kept').value, 'In memory until this tab closes: this browser gives this page no storage (as in a private window)');

  // An AnnData file has neither row.
  const plain = describeDetails(identity('cells'), LOCAL_H5AD, null);
  assert.equal(plain.some(row => row.label === 'Kept' || row.label === 'Not read'), false);
});

test('the box shows the conversion line and one Details line per part not read, and drops both for the next dataset', () => {
  const harness = makeCard({ storage: LOCAL_RDS });
  const { card, dom } = harness;
  card.show(identity('pbmc_small'), 'local-user');
  assert.equal(dom.conversion.hidden, false);
  assert.equal(dom.conversion.textContent, "Read once into this browser's storage for this tab · 2 parts not read");
  assert.equal(dom.origin.textContent, 'R object (.rds) · this computer');
  const terms = dom.detailsList.children;
  const index = terms.findIndex(node => node.tagName === 'DT' && node.textContent === 'Not read');
  assert.ok(index >= 0, 'a Not read row');
  const value = terms[index + 1];
  assert.deepEqual(value.children.map(line => [line.tagName, line.textContent]), NOT_READ.map(note => ['DIV', note]));

  card.showLoading('Opening cells.h5ad…');
  assert.equal(dom.conversion.hidden, true);
  assert.equal(dom.conversion.textContent, '');
});

/** A view whose timers and frames run when the test says. */
function steppedView() {
  const timers = [];
  const frames = [];
  return {
    performance,
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout(handle) { timers[handle - 1] = null; },
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
    cancelAnimationFrame(handle) { frames[handle - 1] = null; },
    runTimers() { for (const fn of timers.splice(0)) fn?.(); },
    runFrames() { for (const fn of frames.splice(0)) fn?.(); },
  };
}

test('a read redraw queued when the box is destroyed posts nothing', () => {
  const log = new TransferLog({ console: null });
  log.begin({ key: ZARR_FOLDER.url, label: 'Suo', why: 'reading on demand' });
  log.record(ZARR_FOLDER.url, { bytes: 1024, requests: 1, absolute: true });
  const view = steppedView();
  const { card, notices } = makeCard({ storage: ZARR_FOLDER, log, view });
  card.show(identity('Suo'), 'local-demo');
  // A read is retried: the box redraws on its next frame.
  log.retrying(ZARR_FOLDER.url, 'a request did not complete');
  view.runTimers();
  // The frame is queued; the box is destroyed before it runs.
  card.destroy();
  view.runFrames();
  assert.deepEqual(notices, [], 'no "Retrying a read" notice outlives the box');
});

/**
 * A view on a clock the test moves: a timer runs when the clock reaches it,
 * and the frame it asks for right after it, as a browser runs them.
 */
function clockedView() {
  let now = 0;
  const timers = [];
  const frames = [];
  return {
    performance: { now: () => now },
    setTimeout(fn, delay = 0) {
      timers.push({ fn, at: now + Math.max(0, delay) });
      return timers.length;
    },
    clearTimeout(handle) {
      if (timers[handle - 1] !== undefined) timers[handle - 1].fn = null;
    },
    requestAnimationFrame(fn) {
      frames.push(fn);
      return frames.length;
    },
    cancelAnimationFrame(handle) { frames[handle - 1] = null; },
    get now() { return now; },
    /** Move the clock to `time`, running each timer due by then, and its frame, in order. */
    advanceTo(time) {
      for (;;) {
        const due = timers.filter(timer => timer.fn !== null && timer.at <= time)
          .sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        now = due.at;
        const fn = due.fn;
        due.fn = null;
        fn();
        for (const frame of frames.splice(0)) frame?.();
      }
      now = time;
    },
  };
}

test('"Reading…" ends one window after the last bytes, wherever the redraws fall', () => {
  const RECEIVING = 1500;
  const log = new TransferLog({ console: null });
  log.begin({ key: ZARR_FOLDER.url, label: 'Suo', why: 'reading on demand' });
  const view = clockedView();
  const { card, dom } = makeCard({ storage: ZARR_FOLDER, log, view });
  card.show(identity('Suo'), 'local-demo');
  const arrive = (bytes, at) => {
    view.advanceTo(at);
    log.record(ZARR_FOLDER.url, { bytes, requests: 1, absolute: true });
    // The log stamps arrivals on the page's clock; here that is the view's.
    log.entryFor(ZARR_FOLDER.url).lastArrivalAt = at;
  };
  arrive(1024, 0);
  view.advanceTo(0);
  assert.match(dom.read.textContent, /^Reading… /);
  // Bytes arrive just after each redraw that leaves "Reading…" up.
  arrive(2048, 10);
  view.advanceTo(RECEIVING + 5);
  assert.match(dom.read.textContent, /^Reading… /, 'bytes arrived 1495 ms ago');
  arrive(4096, RECEIVING + 6);
  const last = RECEIVING + 6;
  view.advanceTo(last + RECEIVING - 1);
  assert.match(dom.read.textContent, /^Reading… /, 'within the window of the last bytes');
  view.advanceTo(last + RECEIVING);
  assert.equal(dom.read.textContent, '4.0 KB read in 1 request', 'the plain total once the last bytes are a window old');
  card.destroy();
});
