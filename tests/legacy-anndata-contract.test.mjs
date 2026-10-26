/**
 * AnnData files in the layout anndata wrote before 0.8 read exactly as the
 * same data in the current layout.
 *
 * The fixtures were written by anndata 0.7.8 itself
 * (`scripts/generate-legacy-anndata-fixtures.py`), plus the two variants found
 * in published files: SeuratDisk's partial `column-order` and the h5sparse
 * sparse markers. Their twin was written from the same data by a current
 * anndata (`scripts/generate-legacy-anndata-twin.py`). Every reader output the
 * app uses is compared with the twin's, value for value: what the dataset
 * says about itself, every cell field (categories, codes with missing values,
 * order), gene names, every gene, the embeddings and the neighbour graph.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';

const FIXTURES = new URL('./browser/fixtures/', import.meta.url);

function fixtureFile(name) {
  return new File([readFileSync(new URL(name, FIXTURES))], name);
}

async function openH5ad(name) {
  const source = new AnnDataFileSource();
  await source.loadFile(fixtureFile(name), { preferFileName: true });
  return source;
}

async function openZarr(name) {
  const source = new AnnDataFileSource();
  await source.loadFile(fixtureFile(name), { preferFileName: true });
  return source;
}

/** Everything the app reads from a dataset, in comparable form. */
async function readAll(source) {
  const [metadata] = await source.listDatasets();
  const adapter = source._adapter;
  const obsFields = adapter.getObsFields();
  const fields = {};
  for (const field of adapter._obsFieldsMetadata) {
    const data = await adapter.getObsFieldData(field.key);
    fields[field.key] = JSON.parse(JSON.stringify(data, (_key, value) =>
      ArrayBuffer.isView(value) ? Array.from(value) : value));
  }
  const geneList = await adapter.getGeneList();
  const genes = [];
  for (const gene of geneList.fields) {
    genes.push(Array.from(await adapter.getGeneValues(gene.path)));
  }
  const embeddings = {};
  for (const [key, columns] of [['X_umap', [0, 1]], ['X_pca', [0, 1, 2]]]) {
    embeddings[key] = Array.from(await adapter.getEmbeddingForRef({ key, columns }));
  }
  const edges = metadata.stats.has_connectivity ? await adapter.getConnectivityEdges() : null;
  return {
    name: metadata.name,
    stats: metadata.stats,
    obsFields,
    fields,
    geneList,
    genes,
    embeddings,
    edges: JSON.parse(JSON.stringify(edges, (_key, value) =>
      ArrayBuffer.isView(value) ? Array.from(value) : value)),
  };
}

const twins = {
  '0.7': readAll(await openH5ad('legacy-twin-current.h5ad')),
  '0.6': readAll(await openH5ad('legacy-0.6-twin-current.h5ad')),
};

/** The fields an obs field list holds, by kind, whatever their order. */
function fieldsByKind(list) {
  const keys = kind => list.fields.filter(field => field.kind === kind).map(field => field.key).sort();
  return { continuous: keys('continuous'), categorical: keys('category') };
}

for (const [name, open, era, orderKnown] of [
  ['legacy-0.7-csr.h5ad', openH5ad, '0.7', true],
  ['legacy-0.7-dense.h5ad', openH5ad, '0.7', true],
  // SeuratDisk lists only some columns in column-order, so the order of the
  // others is not recorded; every column is still read.
  ['legacy-seuratdisk.h5ad', openH5ad, '0.7', false],
  ['legacy-h5sparse.h5ad', openH5ad, '0.7', true],
  ['legacy-0.7.zarr.zip', openZarr, '0.7', true],
  // Compound obs and var, categories in uns, raw as root raw.* entries, and
  // one-element uns scalars; then the same with a compound obsm.
  ['legacy-0.6.h5ad', openH5ad, '0.6', true],
  ['legacy-0.6-compound-obsm.h5ad', openH5ad, '0.6', true],
]) {
  test(`${name} reads exactly as the same data in the current layout`, async () => {
    const legacy = await readAll(await open(name));
    const current = await twins[era];
    assert.equal(legacy.name, `Legacy AnnData ${era} fixture`, 'the title it gives itself');
    assert.deepEqual(legacy.stats, current.stats);
    if (orderKnown) {
      assert.deepEqual(legacy.obsFields, current.obsFields);
    } else {
      assert.deepEqual(fieldsByKind(legacy.obsFields), fieldsByKind(current.obsFields));
    }
    assert.deepEqual(Object.keys(legacy.fields).sort(), Object.keys(current.fields).sort());
    for (const key of Object.keys(current.fields)) {
      assert.deepEqual(legacy.fields[key], current.fields[key], `cell field ${key}`);
    }
    assert.deepEqual(legacy.geneNames, current.geneNames);
    assert.deepEqual(legacy.genes, current.genes);
    assert.deepEqual(legacy.embeddings, current.embeddings);
    assert.deepEqual(legacy.edges, current.edges);
  });
}

test('the legacy fixtures carry what the comparison relies on', async () => {
  const current = await twins['0.7'];
  // Categories, an ordered categorical, missing codes, a boolean, numbers.
  const kinds = Object.fromEntries(Object.entries(current.fields).map(([key, data]) =>
    [key, Array.isArray(data?.categories) ? 'categorical' : 'continuous']));
  assert.equal(kinds.cell_type, 'categorical');
  assert.equal(kinds.batch, 'categorical');
  assert.equal(kinds.stage, 'categorical');
  assert.equal(kinds.n_counts, 'continuous');
  assert.equal(current.stats.n_cells, 120);
  assert.equal(current.stats.n_genes, 6);
});
