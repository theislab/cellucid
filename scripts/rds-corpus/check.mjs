/**
 * The checks of one R object or MatrixMarket corpus file against what R (or
 * scanpy) read back from it (`<name>.expected.json`): opened through the
 * real `openDatasetStore` and the transcoders, value for value. Shared by
 * `tests/rds-corpus-conformance.test.mjs` (the committed corpus) and
 * `drift.mjs` (a corpus written with the current CRAN and Bioconductor
 * packages), so both hold a file to the same rules.
 *
 * A corpus is read through `{paths, read(path)}`: every file path (`rds/…`,
 * `mtx/…`) and a reader of one file's bytes.
 *
 * @module scripts/rds-corpus/check
 */
import assert from 'node:assert/strict';

import { openDatasetStore } from '../../assets/js/data/anndata/open.js';
import { AnnDataReader } from '../../assets/js/data/anndata/reader.js';

const CACHE_BYTES = 64 * 1024 * 1024;

/** One corpus file as a `File`, or one folder as a picked folder's files. */
async function sourceOf({ paths, read }, corpus, name) {
  const prefix = `${corpus}/${name}/`;
  const inside = paths.filter(path => path.startsWith(prefix));
  if (inside.length === 0) return { file: new File([await read(`${corpus}/${name}`)], name) };
  const files = new Map();
  for (const path of inside) files.set(path.slice(prefix.length), new File([await read(path)], path.split('/').pop()));
  return { files, rootName: name };
}

async function open(access, corpus, name, transcoding = {}) {
  return openDatasetStore({ source: await sourceOf(access, corpus, name) }, { decodedChunkCacheBytes: CACHE_BYTES, transcoding });
}

function sameNumber(actual, expected) {
  if (expected === null) return Number.isNaN(actual);
  if (expected === 'NaN') return Number.isNaN(actual);
  return actual === expected;
}

/** An expected R column against the stored one. */
async function assertColumn(node, expected, where) {
  assert.ok(node !== null, `${where} is stored`);
  if (expected.kind === 'categorical') {
    const codes = await node.get('codes').read();
    const categories = await node.get('categories').read();
    assert.deepEqual([...categories], expected.categories, `${where}: categories`);
    assert.deepEqual(Array.from(codes), expected.codes, `${where}: codes`);
    assert.equal(node.attrs.ordered === true, expected.ordered === true, `${where}: ordered`);
    return;
  }
  const encoding = node.attrs['encoding-type'];
  let values;
  let mask = null;
  if (encoding === 'nullable-integer' || encoding === 'nullable-boolean') {
    values = await node.get('values').read();
    mask = await node.get('mask').read();
  } else {
    values = await node.read();
  }
  assert.equal(values.length, expected.values.length, `${where}: length`);
  expected.values.forEach((want, i) => {
    if (want === null && mask !== null) {
      assert.equal(mask[i], 1, `${where}[${i}] is missing`);
      return;
    }
    if (mask !== null) assert.equal(mask[i], 0, `${where}[${i}] is not missing`);
    const got = typeof want === 'boolean' ? values[i] === 1 : Number(values[i]);
    assert.ok(typeof want === 'boolean' ? got === want : sameNumber(got, want), `${where}[${i}]: ${values[i]} where R read ${want}`);
  });
}

/** The first cells' rows of a cells × features matrix against R's. */
async function assertMatrix(node, expected, where, { float32 = false } = {}) {
  const shape = node.attrs.shape ?? node.shape;
  assert.deepEqual([...shape], expected.shape, `${where}: shape`);
  const convert = float32 ? Math.fround : value => value;
  if (node.kind === 'array') {
    const dense = await node.read([[0, Math.min(3, shape[0])]]);
    for (const row of expected.rows) {
      const values = dense.subarray(row.cell * shape[1], (row.cell + 1) * shape[1]);
      row.indices.forEach((index, k) => assert.equal(values[index], convert(row.values[k]), `${where}[${row.cell}, ${index}]`));
      const nonZero = Array.from(values).filter(value => value !== 0).length;
      assert.equal(nonZero, row.indices.length, `${where}: row ${row.cell} non-zeros`);
    }
    return;
  }
  // Stored as the entries arrived: by cell (csr_matrix), or by feature
  // (csc_matrix, a kb-python or alevin-fry matrix).
  const encoding = node.attrs['encoding-type'];
  assert.ok(encoding === 'csr_matrix' || encoding === 'csc_matrix', `${where} is ${encoding}`);
  const indptr = await node.get('indptr').read();
  const indices = await node.get('indices').read();
  const data = await node.get('data').read();
  const major = encoding === 'csr_matrix' ? shape[0] : shape[1];
  assert.equal(Number(indptr[major]), expected.nnz, `${where}: entries`);
  let sum = 0;
  for (let k = 0; k < data.length; k++) sum += data[k];
  assert.ok(Math.abs(sum - expected.sum) <= 1e-9 * Math.max(1, Math.abs(expected.sum)), `${where}: sum ${sum} where R summed ${expected.sum}`);
  for (const row of expected.rows) {
    let entries;
    if (encoding === 'csr_matrix') {
      const start = Number(indptr[row.cell]);
      const end = Number(indptr[row.cell + 1]);
      entries = Array.from({ length: end - start }, (_, k) => ({ feature: indices[start + k], value: data[start + k] }));
    } else {
      entries = [];
      for (let feature = 0; feature < shape[1]; feature++) {
        for (let k = Number(indptr[feature]); k < Number(indptr[feature + 1]); k++) {
          if (indices[k] === row.cell) entries.push({ feature, value: data[k] });
        }
      }
    }
    entries.sort((a, b) => a.feature - b.feature);
    assert.deepEqual(entries.map(entry => entry.feature), row.indices, `${where}: row ${row.cell} features`);
    assert.deepEqual(entries.map(entry => entry.value), row.values.map(convert), `${where}: row ${row.cell} values`);
  }
  return encoding;
}

/**
 * Check one corpus file against its expected values; throws an assertion
 * error naming the first value that differs.
 *
 * @param {{paths: string[], read: (path: string) => Promise<Uint8Array>}} access
 * @param {string} corpus - `rds` or `mtx`
 * @param {string} name - The file or folder name inside the corpus
 * @param {Object} expected - Its `.expected.json`
 */
export async function checkCorpusEntry(access, corpus, name, expected) {
  if (expected.outcome === 'refuse') {
    await assert.rejects(open(access, corpus, name), error => {
      assert.equal(error.details?.explained, true, `explained: ${error.message}`);
      assert.equal(error.details?.reason ?? error.cause?.reason, expected.reason, error.message);
      return true;
    });
    return;
  }
  if (expected.outcome === 'choose') {
    await assert.rejects(open(access, corpus, name), /holds 2 single-cell objects/);
    for (let index = 0; index < expected.objects.length; index++) {
      const asked = [];
      const opened = await open(access, corpus, name, { choose: async choice => { asked.push(choice); return index; } });
      assert.equal(asked.length, 1);
      assert.deepEqual(asked[0].options.map(label => label.split(' ')[0]), expected.objects);
      assert.equal(opened.root.get('obs/_index').shape[0], expected.nObs[index]);
      opened.root.close?.();
    }
    return;
  }
  const opened = await open(access, corpus, name);
  const root = opened.root;
  try {
    const reader = new AnnDataReader();
    await reader.open(root, { format: opened.readerFormat, name: opened.name, link: opened.link });
    if (expected.values === false) {
      assert.ok(reader.nObs > 0, 'it opens');
      return;
    }
    assert.equal(reader.nObs, expected.nObs);
    assert.deepEqual([...await root.get('obs/_index').read()], expected.obsNames, 'obs names');
    for (const [column, values] of Object.entries(expected.obs)) {
      await assertColumn(root.get(`obs/${column}`), values, `obs['${column}']`);
    }
    for (const [key, values] of Object.entries(expected.obsm)) {
      const node = root.get(`obsm/${key}`);
      assert.ok(node !== null, `obsm['${key}']`);
      const [rows, columns] = node.shape;
      const stored = await node.read();
      assert.equal(rows * columns, values.length, `obsm['${key}'] size`);
      for (let c = 0; c < columns; c++) {
        for (let r = 0; r < rows; r++) {
          assert.ok(sameNumber(stored[r * columns + c], values[c * rows + r]), `obsm['${key}'][${r}, ${c}]`);
        }
      }
    }
    for (const [key, graph] of Object.entries(expected.obsp ?? {})) {
      const node = root.get(`obsp/${key}`);
      assert.ok(node !== null, `obsp['${key}']`);
      const data = await node.get('data').read();
      assert.equal(data.length, graph.nnz, `obsp['${key}'] entries`);
      let sum = 0;
      for (const value of data) sum += value;
      assert.ok(Math.abs(sum - graph.sum) < 1e-9 * Math.max(1, graph.sum), `obsp['${key}'] sum`);
    }
    const probe = await reader.probeMapping();
    const modalities = expected.modalities;
    if (modalities.length > 1) {
      assert.deepEqual(probe.modalities.map(item => item.name), modalities.map(item => item.name), 'modalities, the default first');
    }
    const main = modalities[0];
    const float32 = corpus === 'mtx';
    assert.deepEqual([...await root.get('var/_index').read()], main.varNames, 'var names');
    const stored = await assertMatrix(root.get('X'), main.X, 'X', { float32 });
    // A matrix whose entries arrive by feature (kb-python) is kept as it
    // arrived, by feature; one that arrives by cell, by cell.
    if (name === 'kb') assert.equal(stored, 'csc_matrix', 'kb-python, sorted by gene, is kept by feature');
    if (name === 'cellranger3' || name === 'cellranger2') assert.equal(stored, 'csr_matrix');
    if (main.counts) await assertMatrix(root.get('layers/counts'), main.counts, "layers['counts']");
    for (const [column, values] of Object.entries(expected.varColumns ?? {})) {
      const node = root.get(`var/${column}`);
      const codes = await node.get('codes').read();
      const categories = await node.get('categories').read();
      assert.deepEqual(Array.from(codes, code => categories[code]), values, `var['${column}']`);
    }
    if (expected.uns?.cellucid) {
      for (const [key, value] of Object.entries(expected.uns.cellucid)) {
        assert.equal(await root.get(`uns/cellucid/${key}`).read(), value, `uns['cellucid']['${key}']`);
      }
    }
    reader.close();
  } finally {
    root.close?.();
  }
}
