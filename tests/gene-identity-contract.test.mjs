/**
 * Genes cross every boundary by their identifier, the var index name (as
 * cells cross by their original position). When the data mapping names the
 * genes by a var column (a person chose `feature_name` in Data mapping), the
 * name the viewer shows goes beside it: a gene set pushed from a notebook
 * with `adata.var_names[...]` resolves to the shown genes, and a gene set and
 * the gene the viewer colours by go out by identifier with the shown names
 * beside them. Named by the var index, the names are the identifiers and
 * nothing goes beside them.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createViewerHostResults } from '../assets/js/app/viewer-host/results.js';
import { createGeneIndex, geneIdentities, resolveGenes } from '../assets/js/app/analysis/shared/gene-sets.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { decodeViewerResult, encodeViewerBinaryFrame, encodeViewerResult } from '../assets/js/data/viewer-protocol.js';

const SYMBOLS = ['SFTPC', 'EPCAM', 'CD3E', 'Cd3e'];
const IDS = ['ENSG00000168484', 'ENSG00000119888', 'ENSG00000198851', 'ENSMUSG00000032093'];
const varData = () => ({
  fields: SYMBOLS.map((key, gene) => ({ key, kind: 'continuous', path: `var/${gene}` })),
  geneNames: { source: 'feature_name', filledFromIndex: 0, renamed: [], ids: IDS },
});

test('a request names a gene by its identifier or its name, identifiers first; two genes answering one request are reported', () => {
  const data = varData();
  const index = createGeneIndex(SYMBOLS, geneIdentities(data));
  const result = resolveGenes(['ENSG00000168484', 'EPCAM', 'ensg00000198851', 'cd3e', 'NOPE'], index);
  assert.deepEqual(result.resolved, ['SFTPC', 'EPCAM', 'CD3E']);
  assert.deepEqual(result.unmatched, ['NOPE']);
  // `cd3e` is CD3E and Cd3e ignoring case: reported, not guessed.
  assert.deepEqual(result.ambiguous, [{ requested: 'cd3e', candidates: ['CD3E', 'Cd3e'] }]);
  // Without identities (names from the index), names alone.
  assert.deepEqual(resolveGenes(['ENSG00000168484'], SYMBOLS).unmatched, ['ENSG00000168484']);
  // Names from the index: identifiers are the names.
  const plain = geneIdentities({ fields: [{ key: 'ENSG1', path: 'var/0' }], geneNames: { source: null, ids: null } });
  assert.equal(plain.idOf('ENSG1'), 'ENSG1');
  assert.equal(geneIdentities(data).idOf('SFTPC'), 'ENSG00000168484');
  assert.equal(geneIdentities(data).idOf('a copy of a gene'), 'a copy of a gene');
});

test('gene sets and the gene the viewer colours by go out by identifier', async () => {
  const state = new DataState({}, null);
  state.pointCount = 4;
  state.highlightArray = new Uint8Array(4);
  state.categoryTransparency = new Uint8Array(4).fill(1);
  state.obsData = { fields: [] };
  state.varData = varData();
  const sent = [];
  const source = {
    acceptsEvent: () => true,
    isConnected: () => true,
    getShownHostDataset: () => 'example',
    notifyResult(result) {
      const { header, body } = encodeViewerResult(result);
      sent.push(decodeViewerResult(encodeViewerBinaryFrame(header, body)));
      return true;
    },
    notifyResultRemoved() { return true; },
    notifyResults() { return true; },
    notifyColorBy(colorBy) { sent.push({ colorBy }); return true; },
  };
  const results = createViewerHostResults({ state, viewerHostSource: source, getCellIdentity: () => createCellIdentity({ nObs: 4 }) });
  state.getDerivedResults().replaceOwned('markers', {
    geneSets: [{ name: 'AT2', description: 'Marker genes', genes: ['SFTPC', 'EPCAM'] }],
    scores: [],
  });
  state.activeFieldSource = 'var';
  state.activeVarFieldIndex = 0;
  state.getActiveField = () => state.varData.fields[0];
  await results.resync();
  const set = sent.find(item => item.header?.id === 'markers:AT2');
  assert.deepEqual(set.header.meta.genes, ['ENSG00000168484', 'ENSG00000119888']);
  assert.deepEqual(set.header.meta.symbols, ['SFTPC', 'EPCAM']);
  // By identifier, with the name the viewer shows beside it (protocol `color_by.symbol`).
  assert.deepEqual(sent.find(item => item.colorBy)?.colorBy, { field: 'ENSG00000168484', source: 'var', symbol: 'SFTPC', cells_read: null });
  // A gene read for a sample of the open cells (the first 2 of 4): how many (`color_by.cells_read`).
  state._geneSample = Object.freeze({ cells: 2, of: 4, fit: null });
  sent.length = 0;
  await results.resync();
  assert.deepEqual(sent.find(item => item.colorBy)?.colorBy, { field: 'ENSG00000168484', source: 'var', symbol: 'SFTPC', cells_read: 2 });
  state._geneSample = null;
  results.dispose();
});

test('named by the var index, genes go out by it alone: no symbols, no colour-by symbol', async () => {
  const state = new DataState({}, null);
  state.pointCount = 4;
  state.highlightArray = new Uint8Array(4);
  state.categoryTransparency = new Uint8Array(4).fill(1);
  state.obsData = { fields: [{ key: 'cell_type', kind: 'category' }] };
  state.varData = {
    fields: IDS.map((key, gene) => ({ key, kind: 'continuous', path: `var/${gene}` })),
    geneNames: { source: null, filledFromIndex: 0, renamed: [], ids: null },
  };
  const sent = [];
  const source = {
    acceptsEvent: () => true,
    isConnected: () => true,
    getShownHostDataset: () => 'example',
    notifyResult(result) {
      const { header, body } = encodeViewerResult(result);
      sent.push(decodeViewerResult(encodeViewerBinaryFrame(header, body)));
      return true;
    },
    notifyResultRemoved() { return true; },
    notifyResults() { return true; },
    notifyColorBy(colorBy) { sent.push({ colorBy }); return true; },
  };
  const results = createViewerHostResults({ state, viewerHostSource: source, getCellIdentity: () => createCellIdentity({ nObs: 4 }) });
  state.getDerivedResults().replaceOwned('markers', {
    geneSets: [{ name: 'AT2', description: 'Marker genes', genes: [IDS[0], IDS[1]] }],
    scores: [],
  });
  state.activeFieldSource = 'var';
  state.activeVarFieldIndex = 0;
  state.getActiveField = () => state.varData.fields[0];
  await results.resync();
  const set = sent.find(item => item.header?.id === 'markers:AT2');
  assert.deepEqual(set.header.meta.genes, [IDS[0], IDS[1]]);
  assert.equal(set.header.meta.symbols, null);
  assert.deepEqual(sent.find(item => item.colorBy)?.colorBy, { field: IDS[0], source: 'var', symbol: null, cells_read: null });
  results.dispose();
});
