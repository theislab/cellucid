/**
 * The first view reads no matrix value, whatever the source: opening a
 * dataset (`BaseAnnDataAdapter.initialize`, the reader's `getDatasetMetadata`)
 * reads the positions, the coloring field and what describes the file, never
 * a value of `X`, a layer or `raw.X`. Whether a matrix holds counts
 * (`holdsCounts`: its first stored values) is read after it, once
 * (`completeMappingCandidates`), and the catalog completed then names it.
 *
 * Why it matters: a served store (`cellucid serve`, `cellucid_serve`, a
 * notebook widget) lays an object's or a file's matrices out gene-major in
 * the background, and a link pays a request for each read: a matrix probe
 * on the opening's path made the first picture wait for a whole layout
 * (`cellucid serve` of a 1M-cell CSR `.h5ad`: 4.4 s against 1.5 s), and a
 * remote file wait one more round trip.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { annData, categorical, dense, mapping, openReader, sparse, stringFrame } from './helpers/anndata-store.mjs';

const N = 40;
const G = 6;

/** A cells x genes CSR matrix, one or two values a cell (`scale` times a whole number). */
function csr(scale = 1) {
  const indptr = [0];
  const indices = [];
  const data = [];
  for (let cell = 0; cell < N; cell++) {
    const genes = cell % 2 === 0 ? [cell % G, (cell + 3) % G] : [cell % G];
    for (const gene of genes.sort((a, b) => a - b)) {
      indices.push(gene);
      data.push((1 + ((cell + gene) % 3)) * scale);
    }
    indptr.push(indices.length);
  }
  return sparse({
    format: 'csr',
    data: Float32Array.from(data),
    indices: Int32Array.from(indices),
    indptr: Int32Array.from(indptr),
    shape: [N, G],
  });
}

function dataset() {
  const genes = Array.from({ length: G }, (_, g) => `g${g}`);
  return annData({
    obs: stringFrame(Array.from({ length: N }, (_, i) => `c${i}`), {
      cluster: categorical(Int8Array.from({ length: N }, (_, i) => i % 3), ['a', 'b', 'c']),
    }),
    var: stringFrame(genes),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: N * 2 }, (_, i) => i / 7), [N, 2]) }),
    X: csr(0.5),
    layers: mapping({ counts: csr(1) }),
    raw: mapping({ X: csr(1), var: stringFrame(genes) }),
  });
}

const MATRIX = /^(X|raw\/X|layers\/counts)\//;

test('opening a dataset reads no matrix value; whether each holds counts is read after it, once', async () => {
  const { reader, fetched, reads } = await openReader(dataset());
  fetched.length = 0;
  reads.length = 0;
  const adapter = new BaseAnnDataAdapter(reader);
  await adapter.initialize();
  assert.deepEqual(fetched.filter(key => MATRIX.test(key)), [], 'the first view fetched a matrix chunk');
  assert.deepEqual(reads.filter(read => MATRIX.test(read.path.replace(/^\//, ''))), [], 'the first view read a matrix');
  const opened = adapter.getMappingCandidates();
  assert.equal(opened.X.counts, null);
  assert.equal(opened.raw.X.counts, null);
  assert.equal(opened.layers.find(layer => layer.key === 'counts').counts, null);

  const completed = await adapter.completeMappingCandidates();
  assert.ok(fetched.some(key => key.startsWith('X/data/')), 'the counts probe reads X\'s values');
  assert.equal(completed.X.counts, false);
  assert.equal(completed.raw.X.counts, true);
  assert.equal(completed.layers.find(layer => layer.key === 'counts').counts, true);
  assert.equal(adapter.getMappingCandidates(), completed);
  // Once per opening: asked again, nothing is read again.
  const mark = fetched.length;
  assert.equal(await adapter.completeMappingCandidates(), completed);
  assert.equal(fetched.length, mark);
  // The choices are the opening's: only what is said of the matrices is new.
  assert.deepEqual(completed.defaults, opened.defaults);
});
