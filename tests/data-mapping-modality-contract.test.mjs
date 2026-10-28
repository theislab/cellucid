/**
 * Modalities end to end, below the UI: a multimodal file (a CITE-seq MuData
 * whose proteins were measured on some cells; a 10x matrix of two feature
 * types) opens with its default modality, its catalog lists every modality's
 * expression side, its mapping names the modality, and the gene routes of
 * another modality (`var/mod-{j}:X/index`) read that modality's genes, NaN
 * where it measured no cell. A file of one feature space has no modality
 * anywhere (D7: no existing session, preset or fixture changes).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { openDatasetStore } from '../assets/js/data/anndata/open.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import {
  DataMappingError,
  requireMappingModality,
  validateDataMapping,
} from '../assets/js/data/data-mapping.js';
import {
  axisVarColumns,
  expressionAxisRoute,
  modalityScope,
  parseAxisRoute,
  parseMappingGenesPath,
} from '../assets/js/data/data-mapping-candidates.js';
import { resolveAnnDataMapping } from '../assets/js/data/dataset-mapping.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { openZipArchive } from '../assets/js/formats/zip/index.js';
import { withObsmPayloads } from './helpers/anndata-mapping-mocks.mjs';

async function corpusEntry(folder, writer, path) {
  const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/${folder}/${writer}.zip`, import.meta.url)));
  const archive = await openZipArchive(createByteReader(bytesByteSource(bytes, { name: `${writer}.zip` })));
  const entry = archive.entry(path);
  if (entry) return { file: new File([(await entry.read()).slice()], path) };
  const files = new Map();
  for (const item of archive.entries) {
    if (item.path.startsWith(`${path}/`)) files.set(item.path.slice(path.length + 1), new File([(await item.read()).slice()], item.path));
  }
  return { files, rootName: path };
}

async function openAdapter(source) {
  const opened = await openDatasetStore({ source }, { decodedChunkCacheBytes: 1 << 26 });
  const reader = new AnnDataReader();
  await reader.open(opened.root, { format: opened.readerFormat, name: opened.name, link: opened.link });
  const adapter = new BaseAnnDataAdapter(withObsmPayloads(reader));
  await adapter.initialize();
  return { adapter, reader };
}

test('a CITE-seq MuData opens with RNA; its proteins are a modality read through their cell map', async () => {
  const { adapter, reader } = await openAdapter(await corpusEntry('mudata', 'mudata-0.4.1', 'citeseq-subset.h5mu'));
  try {
    const candidates = adapter.getMappingCandidates();
    assert.deepEqual(candidates.modalities.map(item => [item.name, item.n_cells, item.var.n_vars]), [['prot', 36, 5], ['rna', 44, 28]]);
    assert.equal(candidates.defaults.modality, 'rna', 'the gene-expression modality opens first');
    assert.deepEqual(Object.keys(candidates.defaults).slice(0, 5), ['kind', 'embeddings', 'knn', 'modality', 'geneNames']);
    // Its gene names are read after the first view: pending at opening.
    const mapping = validateDataMapping(candidates.defaults, { pendingGeneNames: true });
    assert.equal(mapping.modality, 'rna');
    assert.equal(mapping.expression, 'X');
    assert.equal(mapping.geneNames, null);

    // The dataset's own gene list is RNA's, its names guessed for RNA alone.
    const own = await adapter.getGeneList('var');
    assert.equal(own.fields.length, 28);
    assert.equal(own.fields[0].key, 'GENE0');
    assert.equal(adapter.getMappingCandidates().defaults.geneNames, 'index');
    assert.deepEqual(Object.keys(adapter.getMappingCandidates().geneNameColumns), ['mod/rna']);

    // The proteins, by their route.
    const route = expressionAxisRoute(candidates, 'X', 'prot');
    assert.equal(route, 'mod-0:X');
    assert.deepEqual(parseAxisRoute(route), { modality: 0, matrix: 'X' });
    assert.deepEqual(parseMappingGenesPath(`var/${route}/index/3`), { axisRoute: route, namesRoute: 'index', gene: 3 });
    assert.deepEqual(axisVarColumns(candidates, route), modalityScope(candidates, 'prot').scope.var.columns);
    const proteins = await adapter.getGeneList(`var/${route}/index`);
    assert.deepEqual(proteins.fields.map(field => field.key), ['CD0', 'CD1', 'CD2', 'CD3', 'CD4']);
    const values = await adapter.getGeneValues(`var/${route}/index/2`);
    const column = values instanceof Float32Array ? values : new Float32Array(values.data ?? values);
    assert.equal(column.length, 44);
    assert.equal(column.slice(36).every(Number.isNaN), true, 'cells the proteins were not measured on are NaN');
    assert.equal(column.slice(0, 36).some(Number.isNaN), false);

    // A modality's obs columns and embeddings are shown on every cell.
    assert.ok(reader.obsKeys.includes('rna:leiden'));
    assert.ok(candidates.obsm.some(item => item.key === 'rna:X_umap'));
    assert.ok(!candidates.obsm.some(item => item.key === 'rna' || item.key === 'prot'), 'the measured-cell masks are no embeddings');
  } finally {
    adapter.close?.();
  }
});

test('a 10x matrix of two feature types has one modality per type, windows of one matrix', async () => {
  const { adapter } = await openAdapter(await corpusEntry('tenx', 'tenx', 'v3-citeseq-outs'));
  try {
    const candidates = adapter.getMappingCandidates();
    assert.deepEqual(candidates.modalities.map(item => [item.name, item.var.n_vars]), [['Gene Expression', 30], ['Antibody Capture', 6]]);
    assert.equal(candidates.defaults.modality, 'Gene Expression');
    const antibodies = await adapter.getGeneList(`var/${expressionAxisRoute(candidates, 'X', 'Antibody Capture')}/index`);
    assert.deepEqual(antibodies.fields.map(field => field.key), ['CD0', 'CD1', 'CD2', 'CD3', 'CD4', 'CD5']);
    // scanpy's var columns, on the window.
    assert.deepEqual(
      modalityScope(candidates, 'Antibody Capture').scope.var.columns.map(column => column.key),
      ['gene_ids', 'feature_types', 'genome']
    );
  } finally {
    adapter.close?.();
  }
});

test('a file of one feature space has no modality, and its mapping may name none', async () => {
  const { adapter } = await openAdapter(await corpusEntry('loom', 'loompy-3.0.8', 'basic.loom'));
  try {
    const candidates = adapter.getMappingCandidates();
    assert.equal(candidates.modalities, null);
    assert.equal(Object.hasOwn(candidates.defaults, 'modality'), false);
    const mapping = validateDataMapping(candidates.defaults, { pendingGeneNames: true });
    assert.equal(Object.hasOwn(mapping, 'modality'), false);
    assert.throws(
      () => requireMappingModality({ ...mapping, modality: 'rna' }, null),
      error => error instanceof DataMappingError && error.code === 'modality_unexpected'
    );
    assert.equal(expressionAxisRoute(candidates, 'X'), 'X');
    assert.equal(expressionAxisRoute(candidates, 'X', 'rna'), null);
  } finally {
    adapter.close?.();
  }
});

test('a catalog of several modalities must state the one its mapping reads', () => {
  const candidates = {
    kind: 'anndata',
    modalities: [{ name: 'rna' }, { name: 'prot' }],
    defaults: {
      kind: 'anndata',
      embeddings: { enabled: [{ key: 'X_umap', columns: [0, 1] }], defaults: { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null } },
      knn: null,
      geneNames: 'index',
      expression: 'X',
      log1p: {},
      highlyVariable: null,
      latent: null,
      vectorFields: [],
    },
  };
  const identity = { embeddings: { items: { umap: { source: { key: 'X_umap', columns: [0, 1] } } }, defaults: { '2d': 'umap' } } };
  assert.throws(() => resolveAnnDataMapping(candidates, identity), error => error.code === 'modality_missing');
  assert.equal(
    resolveAnnDataMapping({ ...candidates, defaults: { ...candidates.defaults, modality: 'prot' } }, identity).modality,
    'prot'
  );
});
