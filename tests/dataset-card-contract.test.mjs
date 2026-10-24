/**
 * The Session panel's Dataset box describes the open dataset and nothing
 * else: every show rewrites it from that dataset alone, so nothing of an
 * earlier dataset is ever left in it, and nothing in it is cut mid-word.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeDetails,
  describeGraph,
  describeOrigin,
  describeRead,
  describeStorageFormat,
  initDatasetCard,
} from '../assets/js/app/ui/modules/dataset-card.js';
import { TransferLog } from '../assets/js/data/transfer-log.js';

/** A view whose timers wait to be run: the box redraws on its own clock. */
function fakeView() {
  return {
    performance,
    setTimeout: () => 1,
    clearTimeout() {},
    requestAnimationFrame: fn => fn(),
  };
}

function fakeDocument() {
  const view = fakeView();
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

function makeCard({ storage = null, mapping = null, log = new TransferLog({ console: null }) } = {}) {
  const documentOwner = fakeDocument();
  const make = () => element(documentOwner);
  const dom = {
    root: make(),
    spinner: make(),
    name: make(),
    summary: make(),
    cells: make(),
    genes: make(),
    origin: make(),
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
});
const LOCAL_H5AD = Object.freeze({
  format: 'h5ad',
  zarrVersion: null,
  layout: 'file',
  remote: false,
  url: null,
  name: 'cells.h5ad',
  bytes: 1_260_000_000,
});

test('where a dataset is read from is one short line', () => {
  assert.equal(describeStorageFormat(ZARR_FOLDER), 'Zarr v2 folder');
  assert.equal(describeStorageFormat({ ...ZARR_FOLDER, layout: 'zip', zarrVersion: 3 }), 'Zarr v3 ZIP');
  assert.equal(describeStorageFormat(LOCAL_H5AD), 'h5ad file');
  assert.equal(describeOrigin(ZARR_FOLDER, 'local-demo'), 'Zarr v2 folder · theislab.github.io');
  assert.equal(describeOrigin(LOCAL_H5AD, 'local-user'), 'h5ad file · this computer');
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
  const rows = describeDetails(identity('cells', { source: { name: 'H5AD file', filename: 'cells.h5ad' } }), LOCAL_H5AD, null);
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
  for (const part of ['summary', 'origin', 'descriptionBlock', 'read', 'details']) {
    assert.equal(dom[part].hidden, true, `${part} is hidden while a dataset opens`);
  }
  assert.equal(dom.detailsList.children.length, 0);

  card.showNone();
  assert.equal(dom.name.textContent, 'No dataset open');
  assert.equal(dom.spinner.hidden, true);
  assert.equal(dom.read.hidden, true);
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
