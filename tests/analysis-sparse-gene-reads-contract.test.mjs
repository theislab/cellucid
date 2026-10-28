/**
 * Analyses read a gene the views do not show as its entries, never as a
 * column of every open cell (lane P's scale check: a dense column per gene
 * held 20 GB for 50 genes at 100M cells):
 *
 * - a page's values of a gene (Detailed, Quick Insights, Correlation:
 *   `getDataForPages`) are gathered from the gene's entries
 *   (`readGeneColumn`), bit for bit the dense column's values at the page's
 *   cells, and the gene is not installed in field state; a gene a view shows
 *   is read from its loaded column as before.
 *
 * The reader's own cell-subset read (Differential expression, Marker genes,
 * a first pass's sample) is held to the columns' values in
 * `analysis-subsample-differential.test.mjs` and `open-cells-rows-contract.test.mjs`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DataLayer } from '../assets/js/app/analysis/data/data-layer.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';

const N = 5000;

function geneLayer({ dense, loaded }) {
  const random = createMulberry32(0x5ba);
  const layer = Object.create(DataLayer.prototype);
  const indices = [];
  const values = [];
  dense.forEach((value, cell) => { if (value !== 0) { indices.push(cell); values.push(value); } });
  let sparseReads = 0;
  let installs = 0;
  const field = { key: 'G1', kind: 'continuous', loaded, values: loaded ? dense : null };
  layer.state = {
    obsData: { fields: [] },
    varData: { fields: [field] },
    readVarSparseColumn: async () => {
      sparseReads++;
      return { length: N, indices: Uint32Array.from(indices), values: Float32Array.from(values) };
    },
  };
  layer._datasetGeneration = 0;
  layer._destroyed = false;
  layer._notifications = null;
  layer._fieldLoadLifecycle = new AbortController();
  layer.getVariableInfo = () => ({ key: 'G1', kind: 'continuous', _fieldIndex: 0 });
  layer._getGeneFieldIndexMap = () => new Map([['G1', 0]]);
  layer.getPageInfo = pageId => ({ id: pageId, name: pageId });
  const pages = {
    all: Uint32Array.from({ length: N }, (_, i) => i),
    some: Uint32Array.from({ length: N }, (_, i) => i).filter(() => random() < 0.3),
    none: new Uint32Array(0),
  };
  layer._getVersionedCellIndices = pageId => pages[pageId];
  layer._ensureFieldLoaded = async () => { installs++; };
  return { layer, pages, counts: () => ({ sparseReads, installs }) };
}

test('a gene the views do not show is gathered from its entries, as its dense column holds it', async () => {
  const random = createMulberry32(0x9e);
  const dense = Float32Array.from({ length: N }, () => (random() < 0.8 ? 0 : Math.fround(random() * 10)));
  dense[17] = Number.NaN;
  const { layer, pages, counts } = geneLayer({ dense, loaded: false });
  const result = await layer._fetchDataForPages({ type: 'gene_expression', variableKey: 'G1', pageIds: ['all', 'some', 'none'], silent: true });
  for (const page of result) {
    const want = Float32Array.from(pages[page.pageId], cell => dense[cell]);
    assert.ok(page.values instanceof Float32Array, page.pageId);
    assert.deepEqual(Buffer.from(page.values.buffer), Buffer.from(want.buffer), `${page.pageId}: bit for bit`);
    assert.equal(page.cellCount, pages[page.pageId].length);
  }
  assert.deepEqual(counts(), { sparseReads: 1, installs: 0 }, 'one read of its entries; nothing installed');
});

test('a gene a view shows is read from its loaded column', async () => {
  const dense = Float32Array.from({ length: N }, (_, i) => (i % 7 === 0 ? i / 4 : 0));
  const { layer, pages, counts } = geneLayer({ dense, loaded: true });
  const [page] = await layer._fetchDataForPages({ type: 'gene_expression', variableKey: 'G1', pageIds: ['some'], silent: true });
  assert.deepEqual(Array.from(page.values), Array.from(pages.some, cell => dense[cell]));
  assert.deepEqual(counts(), { sparseReads: 0, installs: 1 });
});
