/**
 * Every file of the AnnData corpus (`tests/fixtures/anndata/`, written by
 * every anndata release line from 0.6 to 0.12, `scripts/anndata-corpus/`;
 * kept as one archive per writer, read here with Cellucid's ZIP reader)
 * read through the AnnData reader, value for value against what anndata
 * itself read back: the shape, the obs and var names, every obs column, the
 * gene-name columns of var, every gene column and cell row of X, the layers
 * and raw.X, every dense embedding, every obsp graph and the title.
 *
 * Each `.h5ad` is read as a local file and as a remote one (over HTTP range
 * requests, where a cell-major matrix is indexed by its structure first);
 * each Zarr store as a `.zarr.zip` archive and as a picked folder.
 *
 * Values the app holds as float32 (obs columns, genes) are compared with the
 * nearest float32 of the stored value; embeddings and graphs exactly. A file
 * the reader may refuse (a codec or filter the browser does not have) must
 * either read exactly or refuse naming what it cannot read.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { openDatasetStore } from '../assets/js/data/anndata/open.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { blobByteSource, bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { openZipArchive } from '../assets/js/formats/zip/index.js';

const ROOT = new URL('./fixtures/anndata/', import.meta.url);
const INDEX = JSON.parse(readFileSync(new URL('index.json', ROOT), 'utf8'));

/** A writer's archive (`anndata-0.12.19.zip`), opened once. */
const writerArchives = new Map();
function writerArchive(writer) {
  if (!writerArchives.has(writer)) {
    const bytes = new Uint8Array(readFileSync(new URL(`${writer}.zip`, ROOT)));
    writerArchives.set(writer, openZipArchive(createByteReader(bytesByteSource(bytes, { name: `${writer}.zip` }))));
  }
  return writerArchives.get(writer);
}

/** The bytes of a corpus path (`anndata-0.12.19/x.h5ad`), from its writer's archive. */
async function corpusBytes(corpusPath) {
  const [writer, ...rest] = corpusPath.split('/');
  const entry = (await writerArchive(writer)).entry(rest.join('/'));
  assert.ok(entry, `${corpusPath} is in ${writer}.zip`);
  return (await entry.read()).slice();
}
const CACHE_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Expected values: the corpus JSON encoding.
// ---------------------------------------------------------------------------

/** A JSON number of the corpus as a JS number ("NaN", "Infinity", big integers as text). */
function numberOf(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === 'NaN') return Number.NaN;
  if (value === 'Infinity') return Number.POSITIVE_INFINITY;
  if (value === '-Infinity') return Number.NEGATIVE_INFINITY;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(BigInt(value));
  throw new TypeError(`Not a corpus number: ${JSON.stringify(value)}`);
}

const f32 = value => Math.fround(numberOf(value));

/** Equal as stored numbers: NaN equals NaN, and -0 equals 0 (a sparse sum loses the sign). */
function sameNumber(actual, expected) {
  return actual === expected || (Number.isNaN(actual) && Number.isNaN(expected));
}

function assertNumbers(actual, expected, convert, where) {
  assert.equal(actual.length, expected.length, `${where}: length`);
  for (let i = 0; i < expected.length; i++) {
    const want = convert(expected[i]);
    if (!sameNumber(Number(actual[i]), want)) {
      assert.fail(`${where}[${i}]: ${actual[i]} where anndata read ${JSON.stringify(expected[i])} (${want})`);
    }
  }
}

/** A list, or the `{count, first5, last5}` digest of a long one. */
function assertList(actual, expected, compare, where) {
  if (Array.isArray(expected)) {
    compare(actual, expected, where);
    return;
  }
  assert.equal(actual.length, expected.count, `${where}: length`);
  compare(Array.from(actual).slice(0, 5), expected.first5, `${where} (first 5)`);
  compare(Array.from(actual).slice(-5), expected.last5, `${where} (last 5)`);
}

const assertStrings = (actual, expected, where) => assert.deepEqual(Array.from(actual), expected, where);

/** The largest finite float32. */
const FLOAT32_MAX = 3.4028234663852886e38;

/** Whether a matrix holds a finite value float32 cannot hold (the reader refuses it, never shows Infinity). */
function overflowsFloat32(matrix) {
  const { min, max } = matrix.stats;
  return [min, max].some(value => {
    if (value === null || value === undefined) return false;
    const number = numberOf(value);
    return Number.isFinite(number) && Math.abs(number) > FLOAT32_MAX;
  });
}

/** Element types whose float32 widening to float64 is exact: the corpus hash checks every value. */
const EXACT_IN_FLOAT32 = new Set(['float32', 'float16', 'int8', 'int16', 'uint8', 'uint16', 'bool']);

function sha256OfFloat64(values) {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(values[i])) {
      view.setUint32(i * 8, 0, true);
      view.setUint32(i * 8 + 4, 0x7ff80000, true);
    } else {
      view.setFloat64(i * 8, values[i], true);
    }
  }
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Sources: a local file, a remote file, a Zarr archive or folder.
// ---------------------------------------------------------------------------

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

function remoteFile(bytes, name) {
  const url = `https://corpus.example/${encodeURIComponent(name)}`;
  served.set(url, bytes);
  return { url, size: bytes.length, name };
}

/** A picked folder: every entry of a Zarr ZIP as a `File` under the store's folder name. */
async function folderOf(file) {
  const archive = await openZipArchive(createByteReader(blobByteSource(file)), { name: file.name });
  const rootName = file.name.replace(/\.zip$/, '');
  const files = new Map();
  for (const entry of archive.entries) {
    const bytes = (await entry.read()).slice();
    files.set(`${rootName}/${entry.path}`, new File([bytes], entry.path.split('/').at(-1)));
  }
  return { files, rootName };
}

/** The ways each fixture is opened. */
async function sourcesOf(fixture) {
  const bytes = await corpusBytes(fixture.path);
  const name = fixture.path.split('/').at(-1);
  const file = new File([bytes], name);
  if (fixture.format === 'h5ad') {
    return [
      { how: 'local', source: { file } },
      { how: 'remote', source: { file: remoteFile(bytes, fixture.path) } },
    ];
  }
  return [
    { how: 'zip', source: { file } },
    { how: 'folder', source: await folderOf(file) },
  ];
}

async function openReader({ source }, format) {
  const opened = await openDatasetStore({ source }, { decodedChunkCacheBytes: CACHE_BYTES });
  // The format is told from the content and the name, as the app opens it.
  assert.equal(opened.format, format, `${opened.name} opens as ${format}`);
  const reader = new AnnDataReader();
  try {
    await reader.open(opened.root, {
      format: opened.readerFormat,
      name: opened.name,
      decodedChunkBytes: CACHE_BYTES,
      link: opened.link,
    });
  } catch (error) {
    opened.root.close?.();
    throw error;
  }
  return reader;
}

/**
 * Where Cellucid deliberately reads more than anndata did, and why. Nothing
 * else may differ.
 */
const READS_MORE = new Map([
  // SeuratDisk lists only some obs columns in column-order; anndata reads
  // those alone, Cellucid shows the listed ones first and then the rest of
  // the Seurat metadata the file holds.
  ['emulated/seuratdisk_partial_column_order.h5ad', { extraObsColumns: true }],
  // anndata 0.6 strips every '_categories' from an uns key
  // ('unused_categories_categories' -> 'unused'), so it reads this column as
  // its codes; Cellucid strips the suffix once and reads the categorical the
  // file was written from.
  ['anndata-0.6.22.post1/obs_categoricals.h5ad', { categoricalFromCodes: new Set(['unused_categories']) }],
]);

// ---------------------------------------------------------------------------
// Element checks.
// ---------------------------------------------------------------------------

async function checkObsColumn(reader, column, where, readsMore) {
  const field = await reader.getObsField(column.name);
  if (readsMore?.categoricalFromCodes?.has(column.name)) {
    assert.equal(field.dtype, 'categorical', `${where}: dtype`);
    assert.deepEqual(Array.from(field.codes), column.values, `${where}: codes`);
    return;
  }
  switch (column.kind) {
    case 'numeric':
      assert.ok(['float', 'int', 'uint'].includes(field.dtype), `${where}: dtype ${field.dtype}`);
      assertNumbers(field.values, column.values, f32, where);
      return;
    case 'bool':
      assert.equal(field.dtype, 'bool', `${where}: dtype`);
      assert.deepEqual(Array.from(field.values), column.values, where);
      return;
    case 'string':
      assert.equal(field.dtype, 'string', `${where}: dtype`);
      assert.deepEqual(Array.from(field.values), column.values, where);
      return;
    case 'categorical': {
      assert.equal(field.dtype, 'categorical', `${where}: dtype`);
      assert.equal(field.ordered, column.ordered, `${where}: ordered`);
      assert.deepEqual(Array.from(field.codes), column.codes, `${where}: codes`);
      const { kind, values } = column.categories;
      assertList(field.categories, values, (actual, expected, at) => {
        if (kind === 'string') return assertStrings(actual, expected, at);
        if (kind === 'bool') return assert.deepEqual(Array.from(actual), expected, at);
        // Numeric labels: exact numbers (-0 kept), or exact decimal text for
        // integers beyond 2^53.
        assert.equal(actual.length, expected.length, `${at}: length`);
        expected.forEach((want, i) => {
          const got = actual[i];
          if (typeof got === 'string') assert.equal(got, String(want), `${at}[${i}]`);
          else assert.ok(Object.is(got, numberOf(want)), `${at}[${i}]: ${got} where anndata read ${want}`);
        });
      }, `${where}: categories`);
      return;
    }
    case 'nullable-integer':
      assertNumbers(field.values, column.values, value => (value === null ? Number.NaN : f32(value)), where);
      return;
    case 'nullable-boolean':
    case 'nullable-string':
      assert.deepEqual(Array.from(field.values), column.values, where);
      return;
    default:
      assert.fail(`${where}: unexpected column kind ${column.kind}`);
  }
}

/** A matrix's dense row-major float32 values, read gene by gene and cell by cell, checked to agree. */
async function readMatrix(reader, element, [nRows, nCols], where) {
  const genes = Array.from({ length: nCols }, (_, i) => i);
  const columns = nCols === 0 ? [] : await reader.getMatrixColumns(element, genes);
  const dense = new Float32Array(nRows * nCols);
  columns.forEach((column, gene) => {
    assert.equal(column.length, nRows, `${where}: gene ${gene} length`);
    for (let row = 0; row < nRows; row++) dense[row * nCols + gene] = column[row];
  });
  // One gene alone, as a view asks for it, agrees with the batch.
  if (nCols > 0) {
    const last = await reader.getMatrixColumn(element, nCols - 1);
    assertNumbers(last, Array.from(columns[nCols - 1]), x => x, `${where}: gene ${nCols - 1} alone`);
  }
  // Cell rows give the same values.
  const cells = Array.from({ length: nRows }, (_, i) => i);
  if (nRows > 0 && nCols > 0) {
    const rows = await reader.getMatrixRows(element, cells);
    rows.forEach((row, cell) => {
      const values = new Float32Array(nCols);
      row.genes.forEach((gene, i) => { values[gene] = row.values[i]; });
      for (let gene = 0; gene < nCols; gene++) {
        if (!sameNumber(values[gene], dense[cell * nCols + gene])) {
          assert.fail(`${where}: cell ${cell} gene ${gene} reads ${values[gene]} by row, ${dense[cell * nCols + gene]} by gene`);
        }
      }
    });
  }
  return dense;
}

async function checkMatrix(reader, element, matrix, where) {
  const [nRows, nCols] = matrix.shape;
  if (overflowsFloat32(matrix)) {
    await assert.rejects(readMatrix(reader, element, matrix.shape, where), /Float32 range/, `${where}: a value float32 cannot hold is refused`);
    return;
  }
  const dense = await readMatrix(reader, element, matrix.shape, where);
  if (matrix.values) {
    assertNumbers(dense, matrix.values, f32, where);
  } else {
    assertNumbers(dense.subarray(0, 5), matrix.first5, f32, `${where} (first 5)`);
    assertNumbers(dense.subarray(dense.length - 5), matrix.last5, f32, `${where} (last 5)`);
    for (const [row, values] of Object.entries(matrix.rows ?? {})) {
      assertNumbers(dense.subarray(Number(row) * nCols, (Number(row) + 1) * nCols), values, f32, `${where} row ${row}`);
    }
    for (const [col, values] of Object.entries(matrix.cols ?? {})) {
      const column = Array.from({ length: nRows }, (_, row) => dense[row * nCols + Number(col)]);
      assertNumbers(column, values, f32, `${where} column ${col}`);
    }
  }
  if (EXACT_IN_FLOAT32.has(matrix.dtype)) {
    assert.equal(sha256OfFloat64(Float64Array.from(dense)), matrix.sha256_f64, `${where}: every value (sha256)`);
  }
}

async function checkEmbedding(reader, key, matrix, where) {
  const width = matrix.shape.length === 1 ? 1 : matrix.shape[1];
  const values = await reader.readObsmColumns(key, Array.from({ length: width }, (_, i) => i));
  const exact = value => numberOf(value);
  if (matrix.values) {
    assertNumbers(values, matrix.values, exact, where);
  } else {
    assertNumbers(values.subarray(0, 5), matrix.first5, exact, `${where} (first 5)`);
    assertNumbers(values.subarray(values.length - 5), matrix.last5, exact, `${where} (last 5)`);
  }
}

async function checkGraph(reader, key, matrix, where) {
  const graph = await reader.getConnectivities(key);
  assert.ok(graph !== null, `${where}: present`);
  const [nRows, nCols] = matrix.shape;
  const dense = new Float64Array(nRows * nCols);
  if (graph.format === 'dense') {
    dense.set(Array.from(graph.data, Number));
  } else {
    const csr = graph.format === 'csr';
    const outer = csr ? nRows : nCols;
    for (let i = 0; i < outer; i++) {
      for (let entry = Number(graph.indptr[i]); entry < Number(graph.indptr[i + 1]); entry++) {
        const j = Number(graph.indices[entry]);
        const at = csr ? i * nCols + j : j * nCols + i;
        dense[at] += Number(graph.data[entry]);
      }
    }
  }
  if (matrix.values) assertNumbers(dense, matrix.values, numberOf, where);
  else assert.equal(sha256OfFloat64(dense), matrix.sha256_f64, `${where}: every value (sha256)`);
}

/** Read everything the app reads and compare it with what anndata read. */
async function checkFixture(reader, expected, where, readsMore = null) {
  if (expected.X !== null) {
    assert.equal(reader.nObs, expected.n_obs, `${where}: cells`);
    assert.equal(reader.nVars, expected.n_vars, `${where}: genes`);
  }
  const columns = expected.obs.columns.map(column => column.name);
  if (readsMore?.extraObsColumns) {
    assert.deepEqual(reader.obsKeys.slice(0, columns.length), columns, `${where}: the listed obs columns first`);
    for (const key of reader.obsKeys.slice(columns.length)) await reader.getObsField(key);
  } else {
    assert.deepEqual(reader.obsKeys, columns, `${where}: obs columns`);
  }
  assert.deepEqual(reader.varNames, expected.var.index, `${where}: var names`);
  for (const column of expected.obs.columns) {
    await checkObsColumn(reader, column, `${where} obs['${column.name}']`, readsMore);
  }
  for (const column of expected.var.columns) {
    if (column.kind !== 'string' && column.kind !== 'categorical') continue;
    const names = await reader.readVarNames('X', column.name);
    const want = column.kind === 'string'
      ? column.values
      : column.codes.map(code => (code < 0 ? null : String(column.categories.values[code])));
    assert.deepEqual(Array.from(names.values), want, `${where} var['${column.name}'] as gene names`);
  }
  // The data-mapping probe describes every element without reading values.
  await reader.probeMapping();
  if (expected.X !== null) await checkMatrix(reader, 'X', expected.X, `${where} X`);
  for (const [name, layer] of Object.entries(expected.layers)) {
    if (layer.t === 'matrix') await checkMatrix(reader, `layers/${name}`, layer.v, `${where} layers['${name}']`);
  }
  if (expected.raw !== null && expected.raw.X) {
    const names = await reader.readVarNames('raw', null);
    assert.deepEqual(Array.from(names.index), expected.raw.var.index, `${where} raw.var names`);
    await checkMatrix(reader, 'raw/X', expected.raw.X, `${where} raw.X`);
  }
  for (const [key, entry] of Object.entries(expected.obsm)) {
    if (entry.t !== 'matrix' || entry.v.format !== 'dense') continue;
    if (entry.v.dtype === 'object' || /^[<>|]?[SU]/.test(entry.v.dtype)) {
      await assert.rejects(reader.readObsmColumns(key, [0]), /holds text, not numbers/, `${where} obsm['${key}'] is text`);
    } else {
      await checkEmbedding(reader, key, entry.v, `${where} obsm['${key}']`);
    }
  }
  for (const [key, entry] of Object.entries(expected.obsp)) {
    if (entry.t === 'matrix') await checkGraph(reader, key, entry.v, `${where} obsp['${key}']`);
  }
  const metadata = await reader.getDatasetMetadata();
  const title = typeof expected.uns_title === 'string' && expected.uns_title.trim().length > 0 ? expected.uns_title.trim() : null;
  assert.equal(metadata.title, title, `${where}: title`);
}

/** The words a refusal must contain, from the corpus reason ("zarr codec 'bz2'" → bz2). */
function refusalPattern(reason) {
  const named = /'([^']+)'/.exec(reason)?.[1];
  if (named) return new RegExp(named.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  if (/scale-offset/i.test(reason)) return /scale.?offset|filter 6|\b6\b/i;
  if (/awkward/i.test(reason)) return /awkward/i;
  return new RegExp(reason.split(/\s+/)[0], 'i');
}

// ---------------------------------------------------------------------------
// The corpus.
// ---------------------------------------------------------------------------

const byWriter = new Map();
for (const fixture of INDEX.fixtures) {
  if (!byWriter.has(fixture.writer)) byWriter.set(fixture.writer, []);
  byWriter.get(fixture.writer).push(fixture);
}

for (const [writer, fixtures] of byWriter) {
  test(`every ${writer} fixture reads as anndata read it`, async t => {
    for (const fixture of fixtures) {
      const expected = JSON.parse(new TextDecoder().decode(await corpusBytes(fixture.expected)));
      for (const { how, source } of await sourcesOf(fixture)) {
        await t.test(`${fixture.path} (${how})`, async () => {
          const where = `${fixture.path} (${how})`;
          const { expect, refuse_reason: reason } = fixture.reader;
          let reader = null;
          try {
            reader = await openReader({ source }, fixture.format);
            if (expect === 'refuse') {
              // The refused element is named; everything else still reads.
              await assert.rejects(async () => {
                for (const [key, entry] of Object.entries(expected.obsm)) {
                  if (entry.t !== 'matrix') await reader.readObsmColumns(key, [0]);
                }
              }, error => refusalPattern(reason).test(error.message), `${where}: refuses ${reason}`);
              const rest = { ...expected, obsm: Object.fromEntries(Object.entries(expected.obsm).filter(([, entry]) => entry.t === 'matrix')) };
              await checkFixture(reader, rest, where);
              return;
            }
            await checkFixture(reader, expected, where, READS_MORE.get(fixture.path) ?? null);
          } catch (error) {
            if (expect !== 'read-or-refuse' || !refusalPattern(reason).test(error.message)) throw error;
          } finally {
            reader?.close();
          }
        });
      }
    }
  });
}

test('the corpus covers every anndata release line and both formats', () => {
  const writers = new Set(INDEX.fixtures.map(fixture => fixture.writer.replace(/\.\d+(\.post\d+)?$/, '')));
  for (const line of ['anndata-0.6', 'anndata-0.7', 'anndata-0.8', 'anndata-0.9', 'anndata-0.10', 'anndata-0.11', 'anndata-0.12']) {
    assert.ok(writers.has(line), `${line} wrote fixtures`);
  }
  const formats = new Set(INDEX.fixtures.map(fixture => `${fixture.format}${fixture.zarr_format ?? ''}`));
  assert.deepEqual([...formats].sort(), ['h5ad', 'zarr2', 'zarr3']);
});
