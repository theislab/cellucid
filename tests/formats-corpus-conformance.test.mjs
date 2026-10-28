/**
 * Every file of the layout-view corpus (`tests/fixtures/{loom,tenx,mudata}/`,
 * written by loompy 2 and 3, as Cell Ranger writes, and by mudata 0.2, 0.3
 * and 0.4: `scripts/formats-corpus/`) opened through `openDatasetStore` and
 * read through the AnnData reader, value for value against what the
 * format's own library read back (loompy, `scanpy.read_10x_h5`,
 * `mudata.read`): the format found, the cells and their names, the obs
 * columns, the embeddings and graphs, every value of the default feature
 * space and of each modality (NaN where a modality did not measure a cell),
 * and the refusal a file Cellucid does not show must give.
 *
 * Files are read as a local file and as a remote one (HTTP ranges); MuData
 * Zarr stores as a `.zarr.zip` and as a picked folder; Cell Ranger `outs/`
 * folders as a picked folder. Values the app holds as float32 (genes, obs
 * columns) are compared with the nearest float32; embeddings and graphs
 * exactly.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { openDatasetStore } from '../assets/js/data/anndata/open.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { blobByteSource, bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { openZipArchive } from '../assets/js/formats/zip/index.js';

const FORMATS = ['loom', 'tenx', 'mudata'];
const CACHE_BYTES = 64 * 1024 * 1024;

const archives = new Map();
function writerArchive(folder, writer) {
  const key = `${folder}/${writer}`;
  if (!archives.has(key)) {
    const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/${folder}/${writer}.zip`, import.meta.url)));
    archives.set(key, openZipArchive(createByteReader(bytesByteSource(bytes, { name: `${writer}.zip` }))));
  }
  return archives.get(key);
}

/** The entries of a corpus path (`writer/name`): one file, or every file below a folder. */
async function corpusEntries(folder, corpusPath) {
  const [writer, ...rest] = corpusPath.split('/');
  const archive = await writerArchive(folder, writer);
  const inside = rest.join('/');
  const file = archive.entry(inside);
  if (file) return { bytes: (await file.read()).slice() };
  const files = new Map();
  for (const entry of archive.entries) {
    if (entry.path.startsWith(`${inside}/`)) {
      files.set(entry.path.slice(inside.length + 1), new File([(await entry.read()).slice()], entry.path.split('/').at(-1)));
    }
  }
  assert.ok(files.size > 0, `${corpusPath} is in ${writer}.zip`);
  return { files };
}

async function expectedOf(folder, corpusPath) {
  const { bytes } = await corpusEntries(folder, corpusPath);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Remote files by URL, served over HTTP range requests. */
const served = new Map();
globalThis.fetch = async (url, init = {}) => {
  const bytes = served.get(String(url));
  if (bytes === undefined) return new Response(null, { status: 404 });
  const range = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? '');
  if (range === null) return new Response(bytes, { status: 200 });
  const start = Number(range[1]);
  const end = Math.min(Number(range[2]), bytes.length - 1);
  return new Response(bytes.slice(start, end + 1), { status: 206 });
};

async function sourcesOf(folder, fixture) {
  const entries = await corpusEntries(folder, fixture.path);
  const name = fixture.path.split('/').at(-1);
  if (entries.files) {
    // The same folder served (`cellucid serve outs/`, `cellucid_serve()`):
    // each file a remote file, the analysis CSVs read over HTTP too.
    const remote = new Map();
    for (const [path, file] of entries.files) {
      const url = `https://corpus.example/${folder}/${encodeURIComponent(fixture.path)}/${path.split('/').map(encodeURIComponent).join('/')}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      served.set(url, bytes);
      remote.set(path, { url, size: bytes.length, name: file.name });
    }
    return [
      { how: 'folder', source: { files: entries.files, rootName: name } },
      { how: 'served folder', source: { files: remote, rootName: name } },
    ];
  }
  const file = new File([entries.bytes], name);
  if (fixture.layout === 'zip') {
    const archive = await openZipArchive(createByteReader(blobByteSource(file)), { name });
    const files = new Map();
    for (const entry of archive.entries) files.set(entry.path, new File([(await entry.read()).slice()], entry.path.split('/').at(-1)));
    return [
      { how: 'zip', source: { file } },
      { how: 'folder', source: { files, rootName: name.replace(/\.zip$/, '') } },
    ];
  }
  const url = `https://corpus.example/${folder}/${encodeURIComponent(fixture.path)}`;
  served.set(url, entries.bytes);
  return [
    { how: 'local', source: { file } },
    { how: 'remote', source: { file: { url, size: entries.bytes.length, name } } },
  ];
}

function numberOf(value) {
  if (value === null) return Number.NaN;
  if (typeof value === 'number') return value;
  if (value === 'NaN') return Number.NaN;
  if (value === 'Infinity') return Number.POSITIVE_INFINITY;
  if (value === '-Infinity') return Number.NEGATIVE_INFINITY;
  throw new TypeError(`Not a corpus number: ${JSON.stringify(value)}`);
}

function assertNumbers(actual, expected, convert, where) {
  assert.equal(actual.length, expected.length, `${where}: length`);
  for (let i = 0; i < expected.length; i++) {
    const want = convert(numberOf(expected[i]));
    const got = Number(actual[i]);
    if (!(got === want || (Number.isNaN(got) && Number.isNaN(want)))) {
      assert.fail(`${where}[${i}]: ${got} where the library read ${JSON.stringify(expected[i])}`);
    }
  }
}

/** Every value of one matrix, cells x genes, read gene by gene. */
async function readDense(reader, element, nObs, nVars) {
  const columns = await reader.getMatrixColumns(element, Array.from({ length: nVars }, (_, gene) => gene));
  const dense = new Float32Array(nObs * nVars);
  columns.forEach((column, gene) => {
    assert.equal(column.length, nObs, `${element} gene ${gene}: one value per cell`);
    for (let cell = 0; cell < nObs; cell++) dense[cell * nVars + gene] = column[cell];
  });
  return dense;
}

/** Rows and a cell subset agree with the columns (NaN where not measured, absent from rows). */
async function checkAccessPaths(reader, element, dense, nObs, nVars, where) {
  const cells = Array.from({ length: nObs }, (_, cell) => cell);
  const rows = await reader.getMatrixRows(element, cells);
  rows.forEach((row, cell) => {
    const expected = Array.from(dense.subarray(cell * nVars, (cell + 1) * nVars));
    if (expected.every(Number.isNaN)) {
      assert.equal(row.genes.length, 0, `${where}: a cell not measured has no genes`);
      return;
    }
    const values = new Float32Array(nVars);
    row.genes.forEach((gene, i) => { values[gene] = row.values[i]; });
    assertNumbers(values, expected, x => x, `${where}: cell ${cell} by row`);
  });
  const genes = Array.from({ length: Math.min(nVars, 4) }, (_, gene) => gene);
  const picked = cells.filter(cell => cell % 3 === 0);
  const block = await reader.getMatrixCellSubset(element, picked, genes);
  genes.forEach((gene, g) => {
    const values = new Float32Array(picked.length);
    for (let entry = block.pointers[g]; entry < block.pointers[g + 1]; entry++) values[block.cellIndex[entry]] = block.values[entry];
    assertNumbers(values, picked.map(cell => dense[cell * nVars + gene]), x => x, `${where}: gene ${gene} of a cell subset`);
  });
  const sparse = await reader.getMatrixColumnsSparse(element, genes);
  sparse.forEach((column, g) => {
    const values = new Float32Array(nObs);
    column.indices.forEach((cell, i) => { values[cell] = column.values[i]; });
    assertNumbers(values, cells.map(cell => dense[cell * nVars + genes[g]]), x => x, `${where}: sparse gene ${genes[g]}`);
  });
}

async function checkOpened(opened, expected, where) {
  assert.equal(opened.format, expected.format, `${where}: opens as ${expected.format}`);
  const reader = new AnnDataReader();
  await reader.open(opened.root, { format: opened.readerFormat, name: opened.name, decodedChunkBytes: CACHE_BYTES, link: opened.link });
  try {
    assert.equal(reader.nObs, expected.nObs, `${where}: cells`);
    const obs = opened.root.get('obs');
    const indexNode = obs.get(obs.attrs._index);
    // anndata 0.13 writes an index as a nullable string array.
    const names = await (indexNode.kind === 'group' ? indexNode.get('values') : indexNode).read();
    assert.deepEqual(Array.from(names, String), expected.obsNames, `${where}: obs names`);
    for (const [key, column] of Object.entries(expected.obs)) {
      const field = await reader.getObsField(key);
      if (column.categories) {
        assert.equal(field.dtype, 'categorical', `${where}: obs['${key}'] is categorical`);
        assert.deepEqual(Array.from(field.categories, String), column.categories, `${where}: obs['${key}'] categories`);
        assert.deepEqual(Array.from(field.codes), column.codes, `${where}: obs['${key}'] codes`);
      } else if (column.values.some(value => typeof value === 'string' && value !== 'NaN')) {
        assert.deepEqual(Array.from(field.values), column.values, `${where}: obs['${key}']`);
      } else {
        assertNumbers(field.values, column.values, Math.fround, `${where}: obs['${key}']`);
      }
    }
    for (const [key, { shape, values }] of Object.entries(expected.obsm)) {
      const width = shape[1] ?? 1;
      const read = await reader.readObsmColumns(key, Array.from({ length: width }, (_, column) => column));
      assertNumbers(read, values, x => (read instanceof Float32Array ? Math.fround(x) : x), `${where}: obsm['${key}']`);
    }
    for (const [key, graph] of Object.entries(expected.obsp)) {
      const read = await reader.getConnectivities(key);
      assert.equal(read.format, 'csr', `${where}: obsp['${key}'] by row`);
      assert.deepEqual(Array.from(read.indptr), graph.indptr, `${where}: obsp['${key}'] indptr`);
      assert.deepEqual(Array.from(read.indices), graph.indices, `${where}: obsp['${key}'] indices`);
      assertNumbers(read.data, graph.data, x => x, `${where}: obsp['${key}'] data`);
    }
    const probe = await reader.probeMapping();
    const nVars = expected.varNames.length;
    if (expected.modalities === null) {
      assert.equal(probe.modalities, null, `${where}: one feature space`);
      assert.deepEqual((await reader.readVarNames('X', null)).index, expected.varNames, `${where}: var names`);
      const dense = await readDense(reader, 'X', reader.nObs, nVars);
      assertNumbers(dense, expected.X, Math.fround, `${where}: X`);
      await checkAccessPaths(reader, 'X', dense, reader.nObs, nVars, `${where}: X`);
      for (const [layer, values] of Object.entries(expected.layers ?? {})) {
        assertNumbers(await readDense(reader, `layers/${layer}`, reader.nObs, nVars), values, Math.fround, `${where}: layers['${layer}']`);
      }
    } else {
      const { default: chosen, order, items } = expected.modalities;
      assert.deepEqual(probe.modalities.map(item => item.name), order, `${where}: modalities in order`);
      assert.equal(probe.defaultModality, chosen, `${where}: default modality`);
      for (const name of order) {
        const item = items[name];
        const { index } = await reader.readVarNames(`mod/${name}`, null);
        assert.deepEqual(index, item.varNames, `${where}: var names of ${name}`);
        const modality = probe.modalities.find(entry => entry.name === name);
        assert.equal(modality.nVars, item.varNames.length, `${where}: ${name} features`);
        assert.equal(modality.nCells, item.nCells, `${where}: ${name} cells measured`);
        const dense = await readDense(reader, `mod/${name}/X`, reader.nObs, item.varNames.length);
        assertNumbers(dense, item.X, Math.fround, `${where}: X of ${name}`);
        await checkAccessPaths(reader, `mod/${name}/X`, dense, reader.nObs, item.varNames.length, `${where}: ${name}`);
      }
      // The default modality is presented at the root when it measured every cell.
      if (items[chosen].nCells === reader.nObs) {
        assert.deepEqual((await reader.readVarNames('X', null)).index, expected.varNames, `${where}: root var is the default modality's`);
        assertNumbers(await readDense(reader, 'X', reader.nObs, nVars), expected.X, Math.fround, `${where}: root X`);
      }
    }
  } finally {
    reader.close();
  }
}

for (const folder of FORMATS) {
  const index = JSON.parse(readFileSync(new URL(`./fixtures/${folder}/index.json`, import.meta.url), 'utf8'));
  for (const fixture of index.fixtures) {
    test(`${folder}: ${fixture.path}`, async () => {
      const expected = await expectedOf(folder, fixture.expected);
      for (const { how, source } of await sourcesOf(folder, fixture)) {
        const where = `${fixture.path} (${how})`;
        if (expected.refusal !== null) {
          await assert.rejects(
            openDatasetStore({ source }, { decodedChunkCacheBytes: CACHE_BYTES }),
            error => {
              assert.equal(error.details?.explained, true, `${where}: the refusal is explained`);
              assert.equal(error.details?.reason, expected.refusal, `${where}: refused as ${expected.refusal}: ${error.message}`);
              return true;
            }
          );
          continue;
        }
        const opened = await openDatasetStore({ source }, { decodedChunkCacheBytes: CACHE_BYTES });
        await checkOpened(opened, expected, where);
      }
    });
  }
}

test('the corpus covers every format version the views read', () => {
  const paths = FORMATS.flatMap(folder => JSON.parse(readFileSync(new URL(`./fixtures/${folder}/index.json`, import.meta.url), 'utf8')).fixtures.map(item => item.path));
  for (const writer of ['loompy-2.0.17/', 'loompy-3.0.8/', 'tenx/v2-', 'tenx/v3-', 'mudata-0.2.4/', 'mudata-0.3.2/', 'mudata-0.4.1/']) {
    assert.ok(paths.some(path => path.startsWith(writer)), `${writer} is in the corpus`);
  }
});

test('a 10x refusal advises what can be done from where the file was opened', async () => {
  // A file on this computer is beside its outs/ folder; a link opens one
  // file and never a folder, so the folder is downloaded and opened here.
  const index = JSON.parse(readFileSync(new URL('./fixtures/tenx/index.json', import.meta.url), 'utf8'));
  const refused = index.fixtures.filter(fixture => fixture.refusal === 'molecule-table' || fixture.refusal === 'no-embedding');
  assert.ok(refused.some(fixture => fixture.refusal === 'no-embedding'), 'the corpus holds a matrix with no embedding');
  for (const fixture of refused) {
    const [{ source }] = await sourcesOf('tenx', fixture);
    const here = await openDatasetStore({ source, fromLink: false }, { decodedChunkCacheBytes: CACHE_BYTES }).then(() => null, error => error);
    const linked = await openDatasetStore({ source, fromLink: true }, { decodedChunkCacheBytes: CACHE_BYTES }).then(() => null, error => error);
    assert.equal(here?.details?.reason, fixture.refusal, `${fixture.path}: refused from this computer`);
    assert.equal(linked?.details?.reason, fixture.refusal, `${fixture.path}: refused from a link`);
    assert.doesNotMatch(here.message, /download/, `${fixture.path}: nothing to download from this computer`);
    assert.match(linked.message, /download the whole outs\/ folder and open it from this computer \(Open… › Folder…\)/, `${fixture.path}: ${linked.message}`);
    assert.doesNotMatch(linked.message, /open the whole outs\/ folder \(Open… › Folder…\)|or the whole outs\/ folder\./, `${fixture.path}: no folder opened from a link`);
  }
});
