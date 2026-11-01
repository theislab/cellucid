/**
 * What cellucid-python serves for data the kernel holds, read by this
 * reader: an AnnData object (and an AnnData file not in priority order) is
 * served as a Zarr store with its cells in priority order
 * (`cellucid._served_store`), every key of which the fixtures hold
 * (`scripts/generate-served-priority-fixtures.py`) with the source's values
 * in its own cell order.
 *
 * Opened as the viewer opens it, the store passes the reader's priority
 * checks (`priority-layout.js`: rows in rank order, prefix counts against
 * each gene's rows); a `uniform` subsample under the store's seed is its
 * prefix -- the same cells the specification keeps of the source, named by
 * the source's positions, each value bit for bit the source's -- and reads
 * only the chunks of that prefix (a gene of a gene-major X only its counted
 * entries); any other request reads through the permutation, the same
 * values again.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { memoryStore, openZarr } from '../assets/js/formats/zarr/index.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { subsampleUniform } from '../assets/js/data/subsample.js';

const FIXTURES = new URL('./fixtures/served/', import.meta.url);

function load(name) {
  const fixture = JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
  const entries = new Map(Object.entries(fixture.keys).map(([key, value]) => [key, new Uint8Array(Buffer.from(value, 'base64'))]));
  return { entries, source: fixture.source };
}

async function open(entries, cellSubset) {
  const inner = memoryStore(entries, { name: 'served.zarr' });
  const fetched = [];
  const isChunk = key => !/(^|\/)\.z(array|attrs|group|metadata)$/.test(key);
  const store = {
    name: 'served.zarr',
    async get(key, options) {
      const bytes = await inner.get(key, options);
      if (bytes !== null && isChunk(key)) fetched.push(key);
      return bytes;
    },
    getMany(keys, options) { return Promise.all(keys.map(key => store.get(key, options))); },
    async getRanges(key, ranges, options) {
      const result = await inner.getRanges(key, ranges, options);
      if (result !== null && isChunk(key)) fetched.push(key);
      return result;
    },
    storedSize: inner.storedSize,
    list: inner.list,
  };
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'served.zarr', decodedChunkBytes: 0, cellSubset });
  return { reader, fetched, root };
}

function decode(entries, path, Type) {
  const meta = JSON.parse(new TextDecoder().decode(entries.get(`${path}/.zarray`)));
  const out = [];
  const chunks = Math.ceil(meta.shape[0] / meta.chunks[0]);
  for (let c = 0; c < chunks; c++) {
    const bytes = entries.get(`${path}/${c}${meta.shape.length === 2 ? '.0' : ''}`);
    out.push(...new Type(bytes.buffer, bytes.byteOffset, bytes.byteLength / Type.BYTES_PER_ELEMENT));
  }
  return { meta, values: out.slice(0, meta.shape[0] * (meta.shape[1] ?? 1)) };
}

const float32 = values => Float32Array.from(values);

function sameValues(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Object.is(actual[i], expected[i]), `${label}[${i}]: ${actual[i]} where the source holds ${expected[i]}`);
  }
}

for (const name of ['object.json', 'file.json']) {
  test(`a store cellucid-python serves (${name}) opens as a prefix of the source in priority order`, async () => {
    const { entries, source } = load(name);
    const n = source.nObs;
    const nVars = source.X.length / n;
    const X = float32(source.X);
    for (const [k, seed] of [[30, undefined], [151, undefined], [n - 1, undefined], [60, 7]]) {
      const request = { mode: 'subsample', method: 'uniform', k, ...(seed === undefined ? {} : { seed }) };
      const label = `${name} k=${k}${seed === undefined ? '' : ` seed ${seed}`}`;
      const { reader, fetched } = await open(entries, request);
      const info = reader.cellSubset;
      assert.equal(info.spec.seed, seed ?? 0, `${label}: the store's seed is the default`);
      assert.deepEqual(Array.from(info.kept), Array.from(subsampleUniform(n, k, seed ?? 0)), `${label}: the specification's cells`);
      assert.equal(info.prefix, seed === undefined ? k : null, `${label}: a prefix`);
      const opened = info.openOrder;
      // Every value is the source's at the cell's original position.
      sameValues((await reader.getObsField('score')).values, Float32Array.from(opened, p => source.score[p]), `${label}: score`);
      const umap = await reader.readObsmColumns('X_umap', [0, 1]);
      sameValues(umap, Float32Array.from(Array.from(opened).flatMap(p => [source.umap[2 * p], source.umap[2 * p + 1]])), `${label}: umap`);
      const genes = Array.from({ length: nVars }, (_, g) => g);
      const columns = await reader.getMatrixColumns('X', genes);
      columns.forEach((column, g) => sameValues(column, Float32Array.from(opened, p => X[p * nVars + g]), `${label}: X gene ${g}`));
      if (seed === undefined) {
        // Only the prefix's chunks: obs and obsm rows [0, k).
        for (const path of ['obs/score', 'obsm/X_umap']) {
          const meta = JSON.parse(new TextDecoder().decode(entries.get(`${path}/.zarray`)));
          const last = Math.ceil(k / meta.chunks[0]) - 1;
          for (const key of fetched.filter(key => key.startsWith(`${path}/`))) {
            assert.ok(Number(key.slice(path.length + 1).split('.')[0]) <= last, `${label}: ${key} is past the prefix`);
          }
        }
        // A gene-major X: each gene read up to its count at the opened level.
        const encoding = JSON.parse(new TextDecoder().decode(entries.get('X/.zattrs')))['encoding-type'];
        if (encoding === 'csc_matrix') {
          const levels = decode(entries, 'uns/cellucid/priority/levels', BigInt64Array).values.map(Number);
          const level = levels.findIndex(value => value >= k);
          const indptr = decode(entries, 'X/indptr', Int32Array).values;
          // One chunk per level: the level's count of every gene.
          const column = level < 0 ? null : entries.get(`varm/cellucid_prefix_counts/0.${level}`);
          const counts = column === null ? null : new Uint32Array(column.buffer, column.byteOffset, nVars);
          const chunk = JSON.parse(new TextDecoder().decode(entries.get('X/data/.zarray'))).chunks[0];
          const allowed = new Set();
          for (let g = 0; g < nVars; g++) {
            const start = indptr[g];
            const end = counts === null ? indptr[g + 1] : start + counts[g];
            for (let c = Math.floor(start / chunk); c * chunk < end; c++) allowed.add(c);
          }
          for (const key of fetched.filter(key => key.startsWith('X/data/') || key.startsWith('X/indices/'))) {
            assert.ok(allowed.has(Number(key.split('/').pop())), `${label}: ${key} holds no counted entry`);
          }
        }
      }
      reader.close();
    }
  });
}

test('the whole served store reads as the source, every cell named by its position', async () => {
  for (const name of ['object.json', 'file.json']) {
    const { entries, source } = load(name);
    const n = source.nObs;
    const { reader, root } = await open(entries, { mode: 'all' });
    const positions = await root.get('obs/cellucid_original_position').read();
    assert.deepEqual(Array.from(positions).sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i), `${name}: every position once`);
    const names = await root.get('obs/_index').read();
    assert.deepEqual(Array.from(positions, p => source.names[p]), Array.from(names), `${name}: names travel with their cells`);
    const codes = await root.get('obs/cluster/codes').read();
    assert.deepEqual(Array.from(codes), Array.from(positions, p => source.codes[p]), `${name}: categories`);
    // The graph with both axes in priority order: the source's edges, renumbered.
    const graph = root.get('obsp/connectivities');
    const indptr = await graph.get('indptr').read();
    const indices = await graph.get('indices').read();
    const data = await graph.get('data').read();
    const row = new Uint32Array(n);
    positions.forEach((p, r) => { row[p] = r; });
    for (let p = 0; p < n; p++) {
      const r = row[p];
      const want = [];
      for (let e = source.graph.indptr[p]; e < source.graph.indptr[p + 1]; e++) want.push([row[source.graph.indices[e]], Math.fround(source.graph.data[e])]);
      want.sort((a, b) => a[0] - b[0]);
      const got = [];
      for (let e = indptr[r]; e < indptr[r + 1]; e++) got.push([indices[e], data[e]]);
      assert.deepEqual(got, want, `${name}: graph row of cell ${p}`);
    }
    reader.close();
  }
});

/**
 * A store served uncompressed is read byte-exact (`formats/zarr/array.js`):
 * a run of a chunk's elements is fetched as its bytes alone when the bytes
 * it leaves unread cost more than a request on the store's link, so a
 * subsample's prefix of a large chunk transfers the prefix. A chunk stored
 * compressed, or a part that leaves little unread, is read whole and kept.
 */
test('a run of an uncompressed chunk is read as its own bytes, when that saves more than a request costs', async () => {
  const n = 100_000;
  const values = Float32Array.from({ length: n }, (_, i) => i / 7);
  const zarray = (compressor) => new TextEncoder().encode(JSON.stringify({
    zarr_format: 2, shape: [n], chunks: [n], dtype: '<f4', compressor, fill_value: 0, filters: null, order: 'C', dimension_separator: '.',
  }));
  const raw = new Uint8Array(values.buffer);
  const zlib = new Uint8Array((await import('node:zlib')).deflateSync(raw));
  for (const [label, compressor, chunk, gap, expected] of [
    ['uncompressed, local link', null, raw, null, 1000 * 4],
    ['uncompressed, a link whose request costs more than the rest', null, raw, n * 4, n * 4],
    ['compressed', { id: 'zlib', level: 1 }, zlib, null, zlib.length],
  ]) {
    const entries = new Map([['.zgroup', new TextEncoder().encode('{"zarr_format":2}')], ['a/.zarray', zarray(compressor)], ['a/0', chunk]]);
    const inner = memoryStore(entries, { name: 'raw.zarr' });
    let fetched = 0;
    const store = {
      name: 'raw.zarr',
      async get(key, options) { const bytes = await inner.get(key, options); if (key === 'a/0' && bytes) fetched += bytes.length; return bytes; },
      getMany(keys, options) { return Promise.all(keys.map(key => store.get(key, options))); },
      async getRanges(key, ranges, options) {
        const parts = await inner.getRanges(key, ranges, options);
        if (key === 'a/0' && parts) for (const part of parts) fetched += part.length;
        return parts;
      },
      storedSize: inner.storedSize,
      list: inner.list,
      ...(gap === null ? {} : { mergeGapBytes: () => gap }),
    };
    const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
    const prefix = await root.get('a').read([[0, 1000]]);
    sameValues(prefix, values.subarray(0, 1000), label);
    assert.equal(fetched, expected, `${label}: bytes fetched`);
    const middle = await root.get('a').read([[50_000, 50_010]]);
    sameValues(middle, values.subarray(50_000, 50_010), `${label}: a later run`);
  }
});

/**
 * Foreign formats served by path (`serve_anndata('x.loom')`, `cellucid serve
 * outs/`): cellucid-python presents a Loom file, a Cell Ranger `outs/` folder
 * and a MuData file as the browser's own layout views present them
 * (`cellucid._served_formats`), with the cells in priority order. Both are
 * opened here as the app opens them (`openDatasetStore`: the file through
 * its view, the served store as a Zarr folder), every cell open: every
 * field, embedding and gene of the served store is the source's, at the
 * position `obs['cellucid_original_position']` names.
 */
async function openSource(files, name) {
  const { openDatasetStore } = await import('../assets/js/data/anndata/open.js');
  const asFiles = new Map([...files].map(([path, bytes]) => [path, new File([bytes], path.split('/').at(-1))]));
  const source = asFiles.size === 1 && asFiles.has(name) ? { file: asFiles.get(name) } : { files: asFiles, rootName: name };
  const opened = await openDatasetStore({ source }, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(opened.root, { format: opened.readerFormat, name, decodedChunkBytes: 0, cellSubset: { mode: 'all' } });
  return { reader, opened };
}

function fieldValues(field) {
  return field.codes === undefined ? Array.from(field.values) : Array.from(field.codes, code => (code < 0 ? null : field.categories[code]));
}

for (const name of ['loom.json', 'outs.json', 'h5mu.json']) {
  test(`the ${name.slice(0, -5)} source served in priority order presents what the browser presents from the source`, async () => {
    const fixture = JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
    const decodeAll = record => new Map(Object.entries(record).map(([key, value]) => [key, new Uint8Array(Buffer.from(value, 'base64'))]));
    const { compare } = fixture;
    const sourceFiles = new Map([...decodeAll(fixture.files)].filter(([path]) => path === compare.source || path.startsWith(`${compare.source}/`)));
    const servedFiles = new Map([...decodeAll(fixture.keys)].map(([key, bytes]) => [`served.zarr/${key}`, bytes]));
    const { reader: source } = await openSource(sourceFiles, compare.source);
    const { reader: served, opened } = await openSource(servedFiles, 'served.zarr');
    assert.equal(opened.format, name === 'loom.json' ? 'zarr' : 'mudata-zarr', 'the served store is the layout the source presents');
    const n = source.nObs;
    assert.equal(served.nObs, n);
    // Served row r is the source's cell at original position open[r].
    const open = served.cellSubset.openOrder;
    assert.deepEqual(Array.from(open).sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i));
    assert.deepEqual((await served.readVarNames('X', null)).index, (await source.readVarNames('X', null)).index, 'the same genes');
    assert.deepEqual([...served.obsKeys].sort(), [...source.obsKeys].sort(), 'the same obs fields (the original positions are no field)');
    for (const key of compare.fields) {
      const want = fieldValues(await source.getObsField(key));
      const got = fieldValues(await served.getObsField(key));
      assert.deepEqual(got, Array.from(open, p => want[p]), `obs['${key}']`);
    }
    for (const key of compare.obsm) {
      const want = await source.readObsmColumns(key, [0, 1]);
      const got = await served.readObsmColumns(key, [0, 1]);
      sameValues(got, got.constructor.from(Array.from(open).flatMap(p => [want[2 * p], want[2 * p + 1]])), `obsm['${key}']`);
    }
    for (const element of compare.matrices) {
      const genes = [0, 1, 2];
      const want = await source.getMatrixColumns(element, genes);
      const got = await served.getMatrixColumns(element, genes);
      genes.forEach(g => sameValues(got[g], Float32Array.from(open, p => want[g][p]), `${element} gene ${g}`));
    }
    source.close();
    served.close();
  });
}
