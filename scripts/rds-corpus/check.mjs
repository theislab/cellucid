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
import { readPrefixCounts, readPriorityLayout, requirePrefixRows } from '../../assets/js/data/anndata/priority-layout.js';

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

/**
 * An expected R column against the stored one; `rowOf[i]` is the stored row
 * of the object's cell `i` (the store keeps its cells in priority order).
 */
async function assertColumn(node, expected, where, rowOf) {
  assert.ok(node !== null, `${where} is stored`);
  if (expected.kind === 'categorical') {
    const codes = await node.get('codes').read();
    const categories = await node.get('categories').read();
    assert.deepEqual([...categories], expected.categories, `${where}: categories`);
    assert.deepEqual(Array.from(rowOf, row => codes[row]), expected.codes, `${where}: codes`);
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
    const row = rowOf[i];
    if (want === null && mask !== null) {
      assert.equal(mask[row], 1, `${where}[${i}] is missing`);
      return;
    }
    if (mask !== null) assert.equal(mask[row], 0, `${where}[${i}] is not missing`);
    const got = typeof want === 'boolean' ? values[row] === 1 : Number(values[row]);
    assert.ok(typeof want === 'boolean' ? got === want : sameNumber(got, want), `${where}[${i}]: ${values[row]} where R read ${want}`);
  });
}

/** The first cells' rows of a cells × features matrix against R's (`rowOf`: as for `assertColumn`). */
async function assertMatrix(node, expected, where, rowOf, { float32 = false } = {}) {
  const shape = node.attrs.shape ?? node.shape;
  assert.deepEqual([...shape], expected.shape, `${where}: shape`);
  const convert = float32 ? Math.fround : value => value;
  if (node.kind === 'array') {
    const dense = await node.read();
    for (const row of expected.rows) {
      const stored = rowOf[row.cell];
      const values = dense.subarray(stored * shape[1], (stored + 1) * shape[1]);
      row.indices.forEach((index, k) => assert.equal(values[index], convert(row.values[k]), `${where}[${row.cell}, ${index}]`));
      const nonZero = Array.from(values).filter(value => value !== 0).length;
      assert.equal(nonZero, row.indices.length, `${where}: row ${row.cell} non-zeros`);
    }
    return;
  }
  // X stored by feature (csc_matrix); a layer as the object holds it
  // (csr_matrix for a dgCMatrix), its rows in priority order.
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
    const stored = rowOf[row.cell];
    if (encoding === 'csr_matrix') {
      const start = Number(indptr[stored]);
      const end = Number(indptr[stored + 1]);
      entries = Array.from({ length: end - start }, (_, k) => ({ feature: indices[start + k], value: data[start + k] }));
    } else {
      entries = [];
      for (let feature = 0; feature < shape[1]; feature++) {
        for (let k = Number(indptr[feature]); k < Number(indptr[feature + 1]); k++) {
          if (indices[k] === stored) entries.push({ feature, value: data[k] });
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
 * The store's priority layout, checked as the reader checks it: rows in
 * rank order under the seed, every original position once, and each
 * gene's prefix counts (read for every level) holding exactly its values
 * below the level. Returns the stored row of each original cell.
 */
async function assertPriorityLayout(root, nObs, ordered) {
  const { layout, notice } = await readPriorityLayout(root, nObs);
  if (!ordered) {
    // An uncompressed R file is read in place: its cells as the object holds them.
    assert.equal(layout, null, 'an uncompressed file keeps its order');
    assert.equal(notice, null, 'and records none');
    return Uint32Array.from({ length: nObs }, (_, i) => i);
  }
  assert.ok(layout !== null, `the store is in priority order${notice === null ? '' : `: ${notice}`}`);
  assert.equal(layout.seed, 0, 'under the default seed');
  // The order the reader computes from the seed, and the stored column whole.
  const originals = await layout.order();
  const stored = await root.get('obs').get('cellucid_original_position').read();
  assert.deepEqual(Array.from(stored, Number), Array.from(originals), 'the stored column is the seed\'s order');
  const rowOf = new Uint32Array(nObs);
  const seen = new Uint8Array(nObs);
  originals.forEach((position, row) => {
    assert.equal(seen[position], 0, `original position ${position} once`);
    seen[position] = 1;
    rowOf[position] = row;
  });
  const X = root.get('X');
  if (X !== null && X.attrs?.['encoding-type'] === 'csc_matrix') {
    const nVars = X.attrs.shape[1];
    const indptr = await X.get('indptr').read();
    const indices = await X.get('indices').read();
    for (let level = 0; level < layout.levels.length; level++) {
      const counts = await readPrefixCounts(root, level, nVars, {}, {
        levelRows: layout.levels[level],
        entryCounts: gene => Number(indptr[gene + 1]) - Number(indptr[gene]),
      });
      assert.ok(counts !== null, 'prefix counts beside a gene-major X');
      for (let gene = 0; gene < nVars; gene++) {
        const start = Number(indptr[gene]);
        const rows = indices.subarray(start, Number(indptr[gene + 1]));
        for (let k = 1; k < rows.length; k++) assert.ok(rows[k - 1] < rows[k], `X gene ${gene}: rows ascending`);
        requirePrefixRows(rows, rows.length, counts[gene], layout.levels[level], gene);
      }
    }
  }
  return rowOf;
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
    // Every store is in priority order but an uncompressed R file's, read in place.
    const ordered = !/_none\.rds$/.test(name);
    const rowOf = await assertPriorityLayout(root, expected.nObs, ordered);
    const names = await root.get('obs/_index').read();
    assert.deepEqual(Array.from(rowOf, row => names[row]), expected.obsNames, 'obs names');
    for (const [column, values] of Object.entries(expected.obs)) {
      await assertColumn(root.get(`obs/${column}`), values, `obs['${column}']`, rowOf);
    }
    for (const [key, values] of Object.entries(expected.obsm)) {
      const node = root.get(`obsm/${key}`);
      assert.ok(node !== null, `obsm['${key}']`);
      const [rows, columns] = node.shape;
      const stored = await node.read();
      assert.equal(rows * columns, values.length, `obsm['${key}'] size`);
      for (let c = 0; c < columns; c++) {
        for (let r = 0; r < rows; r++) {
          assert.ok(sameNumber(stored[rowOf[r] * columns + c], values[c * rows + r]), `obsm['${key}'][${r}, ${c}]`);
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
    const stored = await assertMatrix(root.get('X'), main.X, 'X', rowOf, { float32 });
    // X is kept by feature, a gene one contiguous range, whichever order its
    // entries arrived in (an uncompressed R file's, read in place, keeps the
    // file's).
    if (stored !== undefined && ordered) assert.equal(stored, 'csc_matrix', 'X is kept by feature');
    if (main.counts) await assertMatrix(root.get('layers/counts'), main.counts, "layers['counts']", rowOf);
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
    // A subsample under the store's seed opens as its prefix (the store is
    // closed with the first reader, below).
    if (ordered && expected.nObs > 1) {
      const k = Math.max(1, Math.floor(expected.nObs / 3));
      const subsampled = new AnnDataReader();
      await subsampled.open(root, { format: opened.readerFormat, name: opened.name, link: opened.link, cellSubset: { mode: 'subsample', method: 'uniform', k } });
      assert.equal(subsampled.cellSubset.prefix, k, 'a subsample is the first rows');
    }
    reader.close();
  } finally {
    root.close?.();
  }
}
