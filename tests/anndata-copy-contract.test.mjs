/**
 * The copy of an open dataset as a Cellucid-ready AnnData `.zarr.zip`
 * (`data/anndata/write/`), and the container and array writers it is made
 * of (`formats/zip/writer.js`, `formats/zarr/writer.js`):
 *
 * - the ZIP writer's archives open with the app's own ZIP reader, entry for
 *   entry and CRC for CRC; ZIP64 records are written exactly where a field
 *   overflows (65,535 entries; an entry at or past 4 GiB; an entry of 4 GiB
 *   or more), read back from a sparse archive of over 5 GiB that is never
 *   held; the bytes depend on the entries alone;
 * - the Zarr writer's arrays read back value for value through the app's
 *   Zarr reader: empty, scalar, padded edge chunks, blocks of columns,
 *   booleans, 64-bit integers, text, record arrays; its byte shuffle is the
 *   inverse of the reader's; its JSON is what the reader parses (NaN,
 *   BigInt); in the archive the chunks come first in grid order, the
 *   metadata after them and the consolidated metadata last;
 * - every file of the AnnData corpus (anndata 0.6 to 0.12, `.h5ad` and Zarr
 *   v2/v3), of the MuData corpus, the Loom corpus and the 10x corpus is
 *   copied and the copy, opened by the app's opener, holds every element of
 *   the source, attribute for attribute and value for value (a cell-major
 *   expression matrix as the same entries, gene-major); a file the reader
 *   cannot read fails the copy in the reader's words;
 * - the layout follows the specification (chunks by role, codecs), a
 *   transposition in many passes writes the same bytes as one, the prefix
 *   counts of a priority-ordered file are those of its rows, and the
 *   changes (obs columns by original position, `uns`, `uns['cellucid']`)
 *   are written where they belong and refused where they cannot be.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createZipWriter } from '../assets/js/formats/zip/writer.js';
import { openZipArchive } from '../assets/js/formats/zip/index.js';
import { crc32 } from '../assets/js/formats/zip/crc32.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { byteUnshuffle } from '../assets/js/formats/io/shuffle.js';
import { parseJson } from '../assets/js/formats/zarr/json.js';
import { memoryStore, openZarr, zipStore } from '../assets/js/formats/zarr/index.js';
import { openDatasetStore } from '../assets/js/data/anndata/open.js';
import { frameRows } from '../assets/js/data/anndata/views/modalities.js';
import { ZarrV2StoreWriter, byteShuffle, v2Codecs, zarrZipSink } from '../assets/js/formats/zarr/writer.js';
import { jsonBytes, recordDtype } from '../assets/js/formats/zarr/format-v2.js';
import { CELL_CHUNK, GENE_ENTRY_CHUNK, WHOLE_CHUNK, chunkShapeOf, codecsOf, roleOf } from '../assets/js/data/anndata/write/layout.js';
import { writeAnnDataCopy } from '../assets/js/data/anndata/write/copy.js';
import { readCopyTarget } from '../assets/js/data/anndata/write/copy-target.js';
import { currentLayoutView, isOlderAnnDataLayout } from '../assets/js/data/anndata/older-layouts.js';
import { PRIORITY_ORIGINAL_COLUMN, prefixLevels, readPriorityLayout } from '../assets/js/data/anndata/priority-layout.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { compareCopy, copyToMemory, memorySink, openCopy, openSource } from './helpers/anndata-copy.mjs';
import { annData, array, categorical, countingStore, dense, mapping, minimalAnnData, openStore, sparse, stringFrame, strings } from './helpers/anndata-store.mjs';
import { viewGroup } from '../assets/js/data/anndata/views/view-nodes.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);

/** A reader of bytes in memory, as `openZipArchive` takes one. */
function bytesReader(bytes, name = 'archive.zip') {
  return createByteReader(bytesByteSource(bytes, { name }));
}

// ---------------------------------------------------------------------------
// The ZIP writer.
// ---------------------------------------------------------------------------

test('a ZIP archive opens with the app\'s reader: every entry\'s bytes and CRC, stored, deterministic', async () => {
  const write = async () => {
    const sink = memorySink();
    const zip = createZipWriter(sink);
    await zip.add('a.txt', new TextEncoder().encode('alpha'));
    await zip.add('folder/empty', new Uint8Array(0));
    await zip.add('folder/ünïcode name.bin', Uint8Array.of(1, 2, 3, 4));
    const blob = new Blob([new Uint8Array(70_000).fill(7)]);
    await zip.add('blob.bin', blob, { crc: crc32(new Uint8Array(70_000).fill(7)) });
    const finished = await zip.finish();
    return { bytes: sink.bytes(), finished };
  };
  const first = await write();
  const second = await write();
  assert.ok(Buffer.from(first.bytes).equals(Buffer.from(second.bytes)), 'the same entries make the same bytes');
  assert.equal(first.finished.bytes, first.bytes.length);
  assert.equal(first.finished.entries, 4);
  assert.equal(first.finished.zip64, false);
  const archive = await openZipArchive(bytesReader(first.bytes));
  assert.deepEqual(archive.entries.map(entry => entry.path), ['a.txt', 'folder/empty', 'folder/ünïcode name.bin', 'blob.bin']);
  for (const entry of archive.entries) assert.equal(entry.method, 0, `${entry.path} is stored`);
  assert.equal(new TextDecoder().decode(await archive.entry('a.txt').read()), 'alpha');
  assert.equal((await archive.entry('folder/empty').read()).length, 0);
  assert.deepEqual([...await archive.entry('folder/ünïcode name.bin').read()], [1, 2, 3, 4]);
  assert.ok((await archive.entry('blob.bin').read()).every(byte => byte === 7));
  // Every entry a 0644 regular file of a Unix writer, dated 1980-01-01, its name UTF-8.
  const view = new DataView(first.bytes.buffer);
  const central = first.bytes.length - 22 - archive.entries.reduce((sum, entry) => sum + 46 + new TextEncoder().encode(entry.path).length, 0);
  assert.equal(view.getUint32(central, true), 0x02014b50);
  assert.equal(view.getUint16(central + 4, true) >> 8, 3, 'made by Unix');
  assert.equal(view.getUint16(central + 8, true), 0x0800, 'UTF-8 names');
  assert.equal(view.getUint16(central + 14, true), 0x0021, '1980-01-01');
  assert.equal(view.getUint32(central + 38, true) >>> 16, 0o100644, 'a 0644 regular file');
});

test('a ZIP writer refuses an entry it cannot write as asked', async () => {
  const zip = createZipWriter(memorySink());
  for (const name of ['', '/absolute', 'a/../b', 'a//b', 'back\\slash', 'C:/drive', 'tab\there', './dot']) {
    await assert.rejects(zip.add(name, new Uint8Array(1)), TypeError, `'${name}' is refused`);
  }
  await zip.add('one', new Uint8Array(1));
  await assert.rejects(zip.add('one', new Uint8Array(1)), /already has an entry 'one'/);
  await assert.rejects(zip.add('blob', new Blob(['x'])), /needs its CRC-32/);
  await assert.rejects(zip.add('text', 'not bytes'), /Uint8Array or a Blob/);
  await zip.finish();
  await assert.rejects(zip.add('late', new Uint8Array(1)), /finished/);
  await assert.rejects(zip.finish(), /finished already/);
  assert.throws(() => createZipWriter({}), /write\(part\)/);
});

test('a ZIP entry keeps its name exactly as given, and two names one once normalized are refused', async () => {
  const sink = memorySink();
  const zip = createZipWriter(sink);
  const decomposed = 'cafe\u0301/0';
  await zip.add('.zgroup', new TextEncoder().encode('{"zarr_format": 2}'));
  await zip.add(decomposed, Uint8Array.of(7));
  await assert.rejects(zip.add('caf\u00e9/0', Uint8Array.of(8)), /another Unicode form/);
  await zip.finish();
  const bytes = Buffer.from(sink.bytes());
  // The name's bytes as given (NFD), never normalized.
  assert.ok(bytes.includes(Buffer.from(decomposed, 'utf8')));
  assert.ok(!bytes.includes(Buffer.from(decomposed.normalize('NFC'), 'utf8')));
  // The app's reader holds names NFC; a Zarr key in either form finds the entry.
  const archive = await openZipArchive(bytesReader(sink.bytes()));
  const store = zipStore(archive);
  assert.deepEqual([...await store.get(decomposed)], [7]);
  assert.deepEqual([...await store.get(decomposed.normalize('NFC'))], [7]);
});

test('ZIP64 end records are written from 65,535 entries on, and read back', async () => {
  for (const [count, zip64] of [[65_534, false], [65_535, true], [70_001, true]]) {
    const sink = memorySink();
    const zip = createZipWriter(sink);
    for (let i = 0; i < count; i++) await zip.add(`e/${i}`, Uint8Array.of(i & 0xff));
    const finished = await zip.finish();
    assert.equal(finished.zip64, zip64, `${count} entries: ZIP64 ${zip64}`);
    const archive = await openZipArchive(bytesReader(sink.bytes()));
    assert.equal(archive.entries.length, count);
    assert.deepEqual([...await archive.entry(`e/${count - 1}`).read()], [(count - 1) & 0xff]);
  }
});

/**
 * A sink that keeps an archive's headers and records where its large
 * entries lie, never their bytes (all zeros): a "file" of many GiB a test
 * reads back through a byte reader of the same shape.
 */
function sparseSink() {
  const parts = [];
  let size = 0;
  return {
    write(part) {
      // A Blob is one of the test's large entries of zeros.
      parts.push({ at: size, bytes: part instanceof Blob ? null : part, length: part instanceof Blob ? part.size : part.length });
      size += part instanceof Blob ? part.size : part.length;
    },
    reader() {
      return {
        name: 'sparse.zip',
        size,
        async read(start, length) {
          const out = new Uint8Array(length);
          for (const part of parts) {
            if (part.bytes === null || part.at + part.length <= start || part.at >= start + length) continue;
            const from = Math.max(start, part.at);
            const to = Math.min(start + length, part.at + part.length);
            out.set(part.bytes.subarray(from - part.at, to - part.at), from - start);
          }
          return out;
        },
        stats: () => ({}),
      };
    },
  };
}

/** A Blob of zeros that says it is `size` bytes, holding none of them (`sparseSink` writes none). */
function zerosOf(size) {
  return new (class extends Blob {
    get size() {
      return size;
    }
  })([]);
}

/** The CRC-32 of `size` zero bytes, computed a piece at a time. */
function zeroCrc(size) {
  const piece = new Uint8Array(64 * 1024 * 1024);
  let crc = 0;
  for (let done = 0; done < size; done += piece.length) crc = crc32(piece.subarray(0, Math.min(piece.length, size - done)), crc);
  return crc;
}

test('ZIP64 fields are written for an entry of 4 GiB or more, and for entries at or past 4 GiB', async () => {
  const sink = sparseSink();
  const zip = createZipWriter(sink);
  const huge = 4 * 2 ** 30 + 12_345;
  await zip.add('first.bin', Uint8Array.of(1, 2, 3));
  await zip.add('huge.bin', zerosOf(huge), { crc: zeroCrc(huge) });
  await zip.add('beyond.bin', new TextEncoder().encode('past four gibibytes'));
  await zip.add('also/beyond', Uint8Array.of(9));
  const finished = await zip.finish();
  assert.equal(finished.zip64, true, 'a central directory past 4 GiB ends with the ZIP64 records');
  assert.ok(finished.bytes > huge);
  const archive = await openZipArchive(sink.reader());
  assert.deepEqual(archive.entries.map(entry => entry.path), ['first.bin', 'huge.bin', 'beyond.bin', 'also/beyond']);
  assert.equal(archive.entry('huge.bin').size, huge, 'the size past 4 GiB is read from the ZIP64 fields');
  assert.deepEqual([...await archive.entry('first.bin').read()], [1, 2, 3]);
  assert.equal(new TextDecoder().decode(await archive.entry('beyond.bin').read()), 'past four gibibytes');
  assert.deepEqual([...await archive.entry('also/beyond').read()], [9]);
  assert.deepEqual([...await archive.entry('huge.bin').readRange(huge - 3, 3)], [0, 0, 0], 'the large entry\'s end is where it says');
});

// ---------------------------------------------------------------------------
// The Zarr writer.
// ---------------------------------------------------------------------------

test('the byte shuffle is the inverse of the reader\'s, tails included', () => {
  for (const typesize of [2, 4, 8, 3]) {
    for (const count of [0, 1, 5, 64, 1001]) {
      const bytes = Uint8Array.from({ length: count * typesize + (count % 3) }, (_, i) => (i * 37 + 11) & 0xff);
      const shuffled = byteShuffle(bytes, typesize);
      assert.deepEqual([...byteUnshuffle(shuffled, typesize)], [...bytes], `${count} values of ${typesize} bytes`);
    }
  }
});

test('float16 values read as float32 are their own bits again, every one of the 65,536', async () => {
  const { float16Values } = await import('../assets/js/formats/zarr/dtypes.js');
  const { float16Bits } = await import('../assets/js/formats/zarr/writer.js');
  const values = float16Values();
  const bits = float16Bits(values);
  for (let pattern = 0; pattern < 65536; pattern++) {
    const nan = (pattern & 0x7c00) === 0x7c00 && (pattern & 0x3ff) !== 0;
    // A NaN reads as JavaScript's one NaN (its sign and payload are not kept by the reader): the quiet NaN.
    assert.equal(bits[pattern], nan ? 0x7e00 : pattern, `0x${pattern.toString(16)}`);
  }
  // Values between halves round to the nearest, ties to even.
  assert.deepEqual([...float16Bits([1 + 2 ** -11, 1 + 3 * 2 ** -11, 65520, 2 ** -25, 3 * 2 ** -26])], [0x3c00, 0x3c02, 0x7c00, 0x0000, 0x0001]);
});

test('metadata JSON is what the Zarr reader parses: NaN, infinities and 64-bit integers kept', () => {
  const value = { a: NaN, b: [Infinity, -Infinity, 1.5, -0], c: 2n ** 60n + 1n, d: { e: 'text "quoted"', f: [], g: {} }, h: null, i: true };
  const parsed = parseJson(new TextDecoder().decode(jsonBytes(value)), 'test');
  assert.ok(Number.isNaN(parsed.a));
  assert.deepEqual(parsed.b, [Infinity, -Infinity, 1.5, 0]);
  assert.equal(parsed.c, 2n ** 60n + 1n);
  assert.deepEqual(parsed.d, { e: 'text "quoted"', f: [], g: {} });
  assert.equal(parsed.h, null);
  assert.equal(parsed.i, true);
  assert.equal(new TextDecoder().decode(jsonBytes({ a: [1, 2] }, 0)), '{"a":[1,2]}');
});

test('Zarr arrays of every kind read back value for value, chunks first in grid order and the metadata last', async () => {
  const sink = memorySink();
  const zip = createZipWriter(sink);
  const store = new ZarrV2StoreWriter(zarrZipSink(zip));
  store.group('', { title: 'arrays' });
  const write = async (path, values, shape, chunks, dtype, options = {}) => {
    const array = store.array(path, { shape, chunks, dtype, ...v2Codecs(dtype, options) });
    if (shape.length === 0) await array.writeChunk([], values);
    else if (chunks.slice(1).every((extent, axis) => extent === shape[axis + 1])) {
      await array.appendRows(values);
      await array.end();
    } else {
      for (let band = 0; band * chunks[0] < shape[0]; band++) {
        const first = band * chunks[0];
        const last = Math.min(shape[0], first + chunks[0]);
        await array.writeColumnBlock(band, 0, values.subarray(first * shape[1], last * shape[1]), shape[1]);
      }
    }
  };
  const floats = Float32Array.from({ length: 1003 }, (_, i) => Math.sin(i) * 1e3);
  await write('floats', floats, [1003], [100], '<f4');
  await write('empty', new Float32Array(0), [0], [1], '<f4');
  await write('scalar', new Uint8Array(Float64Array.of(Math.PI).buffer), [], [], '<f8');
  const block = Int32Array.from({ length: 7 * 5 }, (_, i) => i - 17);
  await write('block', block, [7, 5], [3, 2], '<i4');
  const rows = Float64Array.from({ length: 9 * 4 }, (_, i) => i / 7);
  await write('rows', rows, [9, 4], [2, 4], '<f8', { shuffle: false });
  const flags = Uint8Array.from({ length: 77 }, (_, i) => i % 3 === 0 ? 1 : 0);
  await write('flags', flags, [77], [10], '|b1');
  const big = BigInt64Array.from({ length: 33 }, (_, i) => BigInt(i) * 2n ** 40n - 5n);
  await write('big', big, [33], [8], '<i8');
  const text = ['', 'a', 'ünïcode', '日本語', 'emoji 🧬', 'x'.repeat(300), 'last'];
  await write('text', text, [text.length], [3], '|O');
  await write('word', ['one string'], [], [], '|O');
  const recordType = recordDtype({ fields: [
    { name: 'names', dtype: { kind: 'string', variable: true } },
    { name: 'scores', dtype: { kind: 'float', bytes: 4 } },
    { name: 'pair', dtype: { kind: 'int', bytes: 2 }, shape: [2] },
  ] }, new Map([['names', 5]]));
  assert.deepEqual(recordType, [['names', '<U5'], ['scores', '<f4'], ['pair', '<i2', [2]]]);
  const record = new Uint8Array(3 * 28);
  const view = new DataView(record.buffer);
  ['ab', 'ünï', 'xyzzy'].forEach((name, row) => {
    [...name].forEach((character, i) => view.setUint32(row * 28 + i * 4, character.codePointAt(0), true));
    view.setFloat32(row * 28 + 20, row + 0.5, true);
    view.setInt16(row * 28 + 24, -row, true);
    view.setInt16(row * 28 + 26, row * 100, true);
  });
  await write('records', record, [3], [2], recordType);
  const consolidated = await store.finish();
  await zip.finish();

  const bytes = sink.bytes();
  const archive = await openZipArchive(bytesReader(bytes));
  const paths = archive.entries.map(entry => entry.path);
  assert.equal(paths.at(-1), '.zmetadata', 'the consolidated metadata is the last entry');
  const firstDocument = paths.findIndex(path => /(^|\/)\.z(group|attrs|array)$/.test(path));
  assert.ok(paths.slice(firstDocument).every(path => /(^|\/)\.z(group|attrs|array|metadata)$/.test(path)), 'the metadata follows every chunk');
  assert.deepEqual(paths.filter(path => /^floats\/\d/.test(path)), Array.from({ length: 11 }, (_, i) => `floats/${i}`), 'chunks in grid order');
  assert.deepEqual(paths.filter(path => /^block\/\d/.test(path)), ['0.0', '0.1', '0.2', '1.0', '1.1', '1.2', '2.0', '2.1', '2.2'].map(key => `block/${key}`));
  assert.equal(paths.filter(path => /^empty\/\d/.test(path)).length, 0, 'an empty array has no chunk');
  assert.deepEqual(consolidated.metadata['floats/.zarray'].filters, [{ id: 'shuffle', elementsize: 4 }]);
  assert.deepEqual(consolidated.metadata['floats/.zarray'].compressor, { id: 'zlib', level: 6 });
  assert.equal(consolidated.metadata['rows/.zarray'].filters, null, 'unshuffled when asked');
  assert.equal(consolidated.metadata['flags/.zarray'].filters, null, 'one-byte values are not shuffled');
  assert.deepEqual(consolidated.metadata['text/.zarray'].filters, [{ id: 'vlen-utf8' }]);
  assert.equal(consolidated.metadata['text/.zarray'].fill_value, '');
  assert.equal(consolidated.metadata['flags/.zarray'].fill_value, false);

  const root = await openZarr(zipStore(archive));
  const read = path => root.get(path).read();
  assert.deepEqual([...await read('floats')], [...floats]);
  assert.equal((await read('empty')).length, 0);
  assert.equal(await read('scalar'), Math.PI);
  assert.deepEqual([...await read('block')], [...block]);
  assert.deepEqual([...await read('rows')], [...rows]);
  assert.deepEqual([...await read('flags')], [...flags]);
  assert.deepEqual([...await read('big')], [...big]);
  assert.deepEqual(await read('text'), text);
  assert.equal(await read('word'), 'one string');
  assert.deepEqual(await root.get('records').readField('names'), ['ab', 'ünï', 'xyzzy']);
  assert.deepEqual([...await root.get('records').readField('scores')], [0.5, 1.5, 2.5]);
  assert.deepEqual([...await root.get('records').readField('pair')], [0, 0, -1, 100, -2, 200]);
  assert.deepEqual(root.attrs, { title: 'arrays' });
});

test('chunks follow the specification\'s table by role', () => {
  assert.deepEqual(chunkShapeOf('gene-entries', [10 ** 8]), [GENE_ENTRY_CHUNK]);
  assert.deepEqual(chunkShapeOf('gene-entries', [100]), [100]);
  assert.deepEqual(chunkShapeOf('cell', [10 ** 6]), [CELL_CHUNK]);
  assert.deepEqual(chunkShapeOf('whole', [10 ** 6]), [WHOLE_CHUNK]);
  assert.deepEqual(chunkShapeOf('whole', [0]), [1], 'an empty array has chunks of 1');
  assert.deepEqual(chunkShapeOf('cell-rows', [10 ** 6, 50]), [Math.floor(CELL_CHUNK / 50), 50]);
  assert.deepEqual(chunkShapeOf('cell-rows', [10 ** 6, 100_000]), [1, 100_000]);
  assert.deepEqual(chunkShapeOf('gene-strips', [10 ** 6, 2000]), [WHOLE_CHUNK, 1]);
  assert.deepEqual(chunkShapeOf('gene-strips', [1000, 2000]), [1000, 262]);
  assert.deepEqual(chunkShapeOf('columns', [5000, 48]), [5000, 1]);
  assert.deepEqual(chunkShapeOf('whole', []), []);
  assert.throws(() => chunkShapeOf('sideways', [3]), /not an array role/);
});

test('an array\'s role and codecs follow from where it sits', () => {
  const expression = relative => ['X', 'layers/counts', 'raw/X'].includes(relative);
  const role = (relative, rank = 1) => roleOf(relative, rank, expression);
  assert.deepEqual(role('X/data'), { role: 'gene-entries', expression: true });
  assert.deepEqual(role('X/indices'), { role: 'gene-entries', expression: false });
  assert.deepEqual(role('X/indptr'), { role: 'whole', expression: false });
  assert.deepEqual(role('layers/counts/data'), { role: 'gene-entries', expression: true });
  assert.deepEqual(role('raw/X/indices'), { role: 'gene-entries', expression: false });
  assert.deepEqual(role('X', 2), { role: 'gene-strips', expression: true });
  assert.deepEqual(role('obs/_index'), { role: 'cell', expression: false });
  assert.deepEqual(role('obs/kind/codes'), { role: 'cell', expression: false });
  assert.deepEqual(role('obs/kind/categories'), { role: 'whole', expression: false });
  assert.deepEqual(role('obs/flag/mask'), { role: 'cell', expression: false });
  assert.deepEqual(role('obsm/X_umap', 2), { role: 'cell-rows', expression: false });
  assert.deepEqual(role('obsmap/rna'), { role: 'cell', expression: false });
  assert.deepEqual(role('var/_index'), { role: 'whole', expression: false });
  assert.deepEqual(role('obsp/connectivities/data'), { role: 'whole', expression: false });
  assert.deepEqual(role('varm/cellucid_prefix_counts', 2), { role: 'columns', expression: false });
  assert.deepEqual(role('uns/cellucid/outlierQuantiles/fields/leiden'), { role: 'cell', expression: false });
  assert.deepEqual(role('uns/cellucid/name'), { role: 'whole', expression: false });
  assert.deepEqual(codecsOf('<f4', { expression: true }).filters, null);
  assert.deepEqual(codecsOf('<f4').filters, [{ id: 'shuffle', elementsize: 4 }]);
  assert.deepEqual(codecsOf('<i8').filters, [{ id: 'shuffle', elementsize: 8 }]);
  assert.equal(codecsOf('|b1').filters, null);
  assert.deepEqual(codecsOf('|O').filters, [{ id: 'vlen-utf8' }]);
  assert.equal(codecsOf([['a', '<U3'], ['b', '<f4']]).filters, null, 'records are not shuffled');
  assert.deepEqual(codecsOf('<f8').compressor, { id: 'zlib', level: 6 });
});

// ---------------------------------------------------------------------------
// Copies of the corpora.
// ---------------------------------------------------------------------------

/** The files of a corpus archive (`anndata-0.12.19.zip`), opened once each. */
const corpusArchives = new Map();
async function corpusEntry(folder, path) {
  const [writer, ...rest] = path.split('/');
  const key = `${folder}/${writer}`;
  if (!corpusArchives.has(key)) {
    const bytes = new Uint8Array(readFileSync(new URL(`${folder}/${writer}.zip`, FIXTURES)));
    corpusArchives.set(key, await openZipArchive(bytesReader(bytes, `${writer}.zip`)));
  }
  return { archive: corpusArchives.get(key), inside: rest.join('/') };
}

/** A corpus fixture as a source: one file, or a folder of files. */
async function corpusSource(folder, fixture) {
  const { archive, inside } = await corpusEntry(folder, fixture.path);
  if (fixture.layout === 'folder') {
    const name = inside.split('/').at(-1);
    const files = new Map();
    for (const entry of archive.entries) {
      if (!entry.path.startsWith(`${inside}/`)) continue;
      files.set(`${name}/${entry.path.slice(inside.length + 1)}`, new File([(await entry.read()).slice()], entry.path.split('/').at(-1)));
    }
    return { files, rootName: name };
  }
  return { file: new File([(await archive.entry(inside).read()).slice()], inside.split('/').at(-1)) };
}

/** Copy a source, open the copy, compare it with the source as the reader presents both. */
async function copyAndCompare(source, options = {}) {
  const opened = await openSource(source);
  const presented = isOlderAnnDataLayout(opened.root) ? await currentLayoutView(opened.root) : opened.root;
  const { bytes, result } = await copyToMemory(opened.root, options);
  const copy = await openCopy(bytes);
  const seen = await compareCopy(presented, copy.root);
  return { bytes, result, seen, copy, opened };
}

for (const [folder, expectsRead] of [
  ['anndata', fixture => fixture.reader.expect],
  ['mudata', fixture => (fixture.refusal === null ? 'read' : 'refuse')],
  ['loom', fixture => (fixture.refusal === null ? 'read' : 'refuse')],
  ['tenx', fixture => (fixture.refusal === null ? 'read' : 'refuse')],
]) {
  test(`every ${folder} corpus file the reader reads is copied whole, element for element`, async () => {
    const index = JSON.parse(readFileSync(new URL(`${folder}/index.json`, FIXTURES), 'utf8'));
    let copied = 0;
    let transposed = 0;
    for (const fixture of index.fixtures) {
      const expected = expectsRead(fixture);
      if (expected === 'refuse') continue;
      let outcome;
      try {
        outcome = await copyAndCompare(await corpusSource(folder, fixture));
      } catch (error) {
        // A file the reader may refuse (a codec the browser lacks) fails the copy in the reader's words.
        assert.equal(expected, 'read-or-refuse', `${fixture.path}: ${error.stack}`);
        assert.match(error.message, /cannot (decode|decompress)/, `${fixture.path} fails naming what cannot be read`);
        continue;
      }
      copied++;
      transposed += outcome.seen.transposed.length;
      assert.ok(outcome.seen.arrays > 0, `${fixture.path}: arrays were compared`);
    }
    assert.ok(copied >= { anndata: 500, mudata: 12, loom: 6, tenx: 3 }[folder], `${folder}: ${copied} files copied`);
    if (folder === 'anndata' || folder === 'tenx') assert.ok(transposed > 0, `${folder}: cell-major matrices were written gene-major`);
  });
}

test('every R object, MatrixMarket folder and served store the corpus holds is copied whole, element for element', async () => {
  const corpus = await openZipArchive(bytesReader(new Uint8Array(readFileSync(new URL('rds/corpus.zip', FIXTURES))), 'corpus.zip'));
  const bytesOf = async path => (await corpus.entry(path).read()).slice();
  // Transcoded in memory, as a tab without private storage keeps them; `two_objects.rda` opens its first object.
  const transcoded = { memory: true, choose: () => Promise.resolve(0) };
  const sources = [];
  for (const entry of corpus.entries) {
    if (/^rds\/[^/]+\.(rds|rda|RData)$/.test(entry.path)) {
      sources.push([entry.path, async () => ({ file: new File([await bytesOf(entry.path)], entry.path.split('/')[1], { lastModified: 1 }) })]);
    }
  }
  for (const name of ['cellranger2', 'cellranger3', 'kb']) {
    sources.push([`mtx/${name}`, async () => {
      const files = new Map();
      for (const entry of corpus.entries) {
        if (entry.path.startsWith(`mtx/${name}/`) && !entry.path.endsWith('/')) {
          files.set(`${name}/${entry.path.slice(`mtx/${name}/`.length)}`, new File([await bytesOf(entry.path)], entry.path.split('/').at(-1)));
        }
      }
      return { files, rootName: name };
    }]);
  }
  // Objects Cellucid refuses to open (no embedding, a Seurat v2, an on-disk BPCells matrix) are no source of a copy.
  const refusedToOpen = new Set(['rds/seurat2.rds', 'rds/seurat5_bpcells.rds', 'rds/seurat5_noembedding.rds', 'rds/se.rds']);
  const layouts = new Set();
  for (const [name, make] of sources) {
    if (refusedToOpen.has(name)) continue;
    const opened = await openDatasetStore({ source: await make() }, { decodedChunkCacheBytes: 1 << 26, transcoding: transcoded });
    const { bytes, result } = await copyToMemory(opened.root);
    const seen = await compareCopy(opened.root, (await openCopy(bytes)).root);
    assert.ok(seen.arrays > 10, `${name}: arrays were compared`);
    layouts.add(result.layout);
  }
  assert.deepEqual([...layouts].sort(), ['anndata', 'mudata'], 'single-assay and multi-assay objects alike');
  // A store a Python or R server presents (`cellucid serve`), held in memory as served.
  for (const name of ['file', 'h5mu', 'loom', 'object', 'outs']) {
    const doc = JSON.parse(readFileSync(new URL(`served/${name}.json`, FIXTURES), 'utf8'));
    const root = await openZarr(memoryStore(new Map(Object.entries(doc.keys).map(([key, value]) => [key, new Uint8Array(Buffer.from(value, 'base64'))])), { name }));
    const { bytes } = await copyToMemory(root);
    const seen = await compareCopy(root, (await openCopy(bytes)).root);
    assert.ok(seen.arrays > 10, `served ${name}: arrays were compared`);
  }
});

test('a copy is laid out as the specification says: gene-major X, chunks by role, codecs by kind', async () => {
  const nObs = 70_000;
  const genes = Array.from({ length: 30 }, (_, g) => `g${g}`);
  const entries = { data: [], indices: [], indptr: [0] };
  for (let cell = 0; cell < nObs; cell++) {
    for (let gene = cell % 3; gene < genes.length; gene += 7) {
      entries.data.push((cell * 31 + gene) % 11 + 1);
      entries.indices.push(gene);
    }
    entries.indptr.push(entries.data.length);
  }
  const tree = annData({
    obs: stringFrame(Array.from({ length: nObs }, (_, i) => `c${i}`), { kind: categorical(Int8Array.from({ length: nObs }, (_, i) => i % 4), ['a', 'b', 'c', 'd']) }),
    var: stringFrame(genes),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: nObs * 2 }, (_, i) => i), [nObs, 2]) }),
    X: sparse({
      format: 'csr', shape: [nObs, genes.length],
      data: Float32Array.from(entries.data), indices: Int32Array.from(entries.indices), indptr: Int32Array.from(entries.indptr),
    }),
  });
  const { root } = await openStore(tree);
  const sink = memorySink();
  await writeAnnDataCopy(root, sink);
  const archive = await openZipArchive(bytesReader(sink.bytes()));
  const metadata = parseJson(new TextDecoder().decode(await archive.entry('.zmetadata').read()), '.zmetadata').metadata;
  assert.equal(metadata['X/.zattrs']['encoding-type'], 'csc_matrix');
  assert.deepEqual(metadata['X/.zattrs'].shape, [nObs, genes.length]);
  assert.deepEqual(metadata['X/data/.zarray'].chunks, [GENE_ENTRY_CHUNK]);
  assert.equal(metadata['X/data/.zarray'].filters, null, 'expression values are not shuffled');
  assert.deepEqual(metadata['X/indices/.zarray'].filters, [{ id: 'shuffle', elementsize: 4 }]);
  assert.deepEqual(metadata['X/indptr/.zarray'].shape, [genes.length + 1]);
  assert.deepEqual(metadata['obs/_index/.zarray'].chunks, [CELL_CHUNK]);
  assert.deepEqual(metadata['obs/kind/codes/.zarray'].chunks, [CELL_CHUNK]);
  assert.deepEqual(metadata['obs/kind/categories/.zarray'].chunks, [4]);
  assert.deepEqual(metadata['obsm/X_umap/.zarray'].chunks, [CELL_CHUNK / 2, 2]);
  for (const [key, document] of Object.entries(metadata)) {
    if (key.endsWith('.zarray')) assert.deepEqual(document.compressor, { id: 'zlib', level: 6 }, `${key} is deflated`);
  }
  for (const element of ['obsm', 'obsp', 'varm', 'varp', 'layers']) {
    assert.equal(metadata[`${element}/.zattrs`]['encoding-type'], 'dict', `${element} is present`);
  }
  // The copy reads as the source: the reader opens it and the genes are the same.
  const copy = await openCopy(sink.bytes());
  const seen = await compareCopy(root, copy.root);
  assert.deepEqual(seen.transposed, ['X']);
});

/**
 * The priority-ordered fixture `prepare()` wrote (`priority/written.zarr.zip`)
 * with its gene-major X presented cell-major (the same entries as a CSR
 * matrix held in memory), every other element as stored.
 */
async function cellMajorPriorityFixture() {
  const opened = await openSource({ file: new File([readFileSync(new URL('priority/written.zarr.zip', FIXTURES))], 'written.zarr.zip') });
  const root = opened.root;
  await root.load();
  const X = root.get('X');
  const shape = X.attrs.shape.map(Number);
  const [data, indices, indptr] = await Promise.all(['data', 'indices', 'indptr'].map(key => X.get(key).read()));
  const rows = Array.from({ length: shape[0] }, () => []);
  for (let gene = 0; gene < shape[1]; gene++) {
    for (let k = indptr[gene]; k < indptr[gene + 1]; k++) rows[indices[k]].push([gene, data[k]]);
  }
  const csr = { data: [], indices: [], indptr: [0] };
  for (const row of rows) {
    for (const [gene, value] of row) {
      csr.data.push(value);
      csr.indices.push(gene);
    }
    csr.indptr.push(csr.data.length);
  }
  const { root: held } = await openStore(annData({
    X: sparse({ format: 'csr', shape, data: Float32Array.from(csr.data), indices: Int32Array.from(csr.indices), indptr: Int32Array.from(csr.indptr) }),
  }));
  const cellMajor = viewGroup({
    path: '/',
    real: root,
    attrs: root.attrs,
    children: new Map(root.keys().map(key => [key, () => (key === 'X' ? held.get('X') : root.get(key))])),
  });
  return { root, cellMajor, shape };
}

test('a cell-major X is written gene-major with the prefix counts of its priority order, the same bytes however the work is cut', async () => {
  const { root, cellMajor, shape } = await cellMajorPriorityFixture();
  const { layout } = await readPriorityLayout(root, shape[0]);
  assert.ok(layout !== null, 'the fixture is in a verified priority order');
  const whole = await copyToMemory(cellMajor);
  // Many passes (blocks of a few genes) and many windows (slabs of a few rows) against one of each.
  const cut = await copyToMemory(cellMajor, { budgetBytes: 4096, slabBytes: 2048 });
  assert.ok(Buffer.from(cut.bytes).equals(Buffer.from(whole.bytes)), 'the same bytes, however the work is cut');
  assert.equal(whole.result.priorityOrder, true);
  const copy = await openCopy(whole.bytes);
  const seen = await compareCopy(cellMajor, copy.root);
  assert.deepEqual(seen.transposed, ['X']);
  // The copy is in the same verified order, its prefix counts those prepare() wrote.
  const copied = await readPriorityLayout(copy.root, shape[0]);
  assert.ok(copied.layout !== null, 'the copy keeps the verified priority order');
  assert.deepEqual(copied.layout.levels, prefixLevels(shape[0]));
  const key = 'varm/cellucid_prefix_counts';
  assert.deepEqual([...await copy.root.get(key).read()], [...await root.get(key).read()], 'the prefix counts are those prepare() wrote');
  assert.deepEqual([...copy.root.get(key).chunks], [Math.min(shape[1], WHOLE_CHUNK), 1], 'read a column at a time');
  // The gene-major source copied as it is gives the same matrix, byte for byte.
  const direct = await copyToMemory(root);
  const directCopy = await openCopy(direct.bytes);
  for (const part of ['data', 'indices', 'indptr']) {
    assert.deepEqual([...await directCopy.root.get(`X/${part}`).read()], [...await copy.root.get(`X/${part}`).read()], `X/${part}`);
  }
});

test('changes are written where they belong: obs columns by original position, uns and uns[\'cellucid\'] by key', async () => {
  const { root, shape } = await cellMajorPriorityFixture();
  const nObs = shape[0];
  const { layout } = await readPriorityLayout(root, nObs);
  const order = await layout.order();
  const positions = Float64Array.from({ length: nObs }, (_, position) => position);
  const groups = Int8Array.from({ length: nObs }, (_, position) => (position % 5 === 0 ? -1 : position % 2));
  const firstColumn = root.get('obs').attrs['column-order'][0];
  const { bytes, result } = await copyToMemory(root, {
    changes: {
      obs: [
        { name: 'original', column: { kind: 'numbers', values: positions } },
        { name: 'cellucid_highlight__page__group', column: { kind: 'categorical', codes: groups, categories: ['out', 'in'], ordered: false } },
        { name: firstColumn, column: { kind: 'booleans', values: Uint8Array.from({ length: nObs }, (_, position) => position & 1) } },
      ],
      var: [{ name: 'in_set', column: { kind: 'booleans', values: Uint8Array.from({ length: shape[1] }, (_, gene) => gene < 3) } }],
      uns: { note: 'written by a test', removed_nothing: null },
      cellucid: {
        history_applied: '[{"tracker":"t"}]',
        gene_sets: { first: { genes: ['a', 'b'], description: '', origin: 'session' } },
        // Descriptive text is written trimmed.
        description: 'Typed by hand. ',
      },
    },
  });
  assert.equal(result.priorityOrder, true);
  const copy = await openCopy(bytes);
  const obs = copy.root.get('obs');
  const stored = await obs.get(PRIORITY_ORIGINAL_COLUMN).read();
  // A value given for a cell's original position sits at the cell's file row.
  assert.deepEqual([...await obs.get('original').read()], Array.from(stored, Number));
  assert.deepEqual([...stored].map(Number), [...order]);
  const codes = await obs.get('cellucid_highlight__page__group/codes').read();
  assert.deepEqual([...codes], [...order].map(position => groups[position]));
  assert.deepEqual(await obs.get('cellucid_highlight__page__group/categories').read(), ['out', 'in']);
  // A changed column keeps its place in the column order; a new one follows the others.
  const columnOrder = obs.attrs['column-order'];
  assert.equal(columnOrder[0], firstColumn);
  assert.deepEqual(columnOrder.slice(-2), ['original', 'cellucid_highlight__page__group']);
  assert.deepEqual([...await obs.get(firstColumn).read()], [...order].map(position => position & 1));
  assert.deepEqual([...await copy.root.get('var/in_set').read()], Array.from({ length: shape[1] }, (_, gene) => (gene < 3 ? 1 : 0)));
  assert.equal(await copy.root.get('uns/note').read(), 'written by a test');
  assert.equal(copy.root.get('uns/removed_nothing'), null);
  assert.equal(await copy.root.get('uns/cellucid/history_applied').read(), '[{"tracker":"t"}]');
  assert.deepEqual(await copy.root.get('uns/cellucid/gene_sets/first/genes').read(), ['a', 'b']);
  assert.equal(await copy.root.get('uns/cellucid/description').read(), 'Typed by hand.');
  // Every other key of the record is the source's, and the app opens the copy.
  for (const key of root.get('uns/cellucid').keys()) assert.ok(copy.root.get(`uns/cellucid/${key}`) !== null, `uns['cellucid']['${key}'] is kept`);
  const reader = new AnnDataReader();
  await reader.open(copy.root, { format: copy.readerFormat, name: 'copy.zarr.zip' });
  assert.equal(reader.nObs, nObs);
  assert.ok(reader.obsKeys.includes('original'));
});

test('an obs column renamed in place keeps its place and values; its old name is free for a new column; the plan reads the store as stored', async () => {
  const nObs = 6;
  const { root } = await openStore(minimalAnnData({
    nObs,
    obs: {
      cluster: categorical([0, 1, 0, 2, 1, -1], ['a', 'b', 'c']),
      label: strings(['x', 'y', 'x', 'z', 'y', 'x']),
      score: array(Float32Array.of(0.5, 1, 1.5, 2, 2.5, 3)),
      flag: array(Uint8Array.of(1, 0, 1, 0, 1, 0), { dtype: '|b1' }),
    },
    // Scanpy's colors of a column, and colors of another form (not text).
    extra: { uns: mapping({ cluster_colors: strings(['#111111', '#222222', '#333333']), label_colors: array(Float32Array.of(1, 2)) }) },
  }));
  await root.load();
  // What the plan reads of a store: its columns, the asked ones whole, as a copy writes columns.
  const before = await readCopyTarget(root, ['cluster', 'label', 'score', 'flag', 'absent'], {}, { colors: ['cluster', 'label', 'absent'] });
  // Its uns keys, and the colors asked for: text as stored, null for another form or none.
  assert.deepEqual(before.unsKeys.sort(), ['cluster_colors', 'label_colors']);
  assert.deepEqual(before.colors, { cluster: ['#111111', '#222222', '#333333'], label: null, absent: null });
  assert.deepEqual(before.obsColumns, ['cluster', 'label', 'score', 'flag']);
  assert.deepEqual(before.varColumns, []);
  assert.deepEqual(before.cellucid, null);
  assert.deepEqual(Object.keys(before.columns), ['cluster', 'label', 'score', 'flag']);
  assert.deepEqual({ ...before.columns.cluster, codes: [...before.columns.cluster.codes] }, { kind: 'categorical', categories: ['a', 'b', 'c'], codes: [0, 1, 0, 2, 1, -1], ordered: false });
  assert.deepEqual(before.columns.label, { kind: 'strings', values: ['x', 'y', 'x', 'z', 'y', 'x'] });
  assert.deepEqual(before.columns.score, { kind: 'numbers', values: Float32Array.of(0.5, 1, 1.5, 2, 2.5, 3) });
  assert.deepEqual(before.columns.flag, { kind: 'booleans', values: Uint8Array.of(1, 0, 1, 0, 1, 0) });

  const fresh = Float64Array.from({ length: nObs }, (_, position) => position * 2);
  const relabelled = { kind: 'categorical', codes: Int8Array.of(0, 1, 0, 0, 1, -1), categories: ['a', 'B'], ordered: false };
  const { bytes } = await copyToMemory(root, {
    changes: {
      obs: [
        { name: 'clusters', from: 'cluster', column: relabelled },
        { name: 'text', from: 'label', column: null },
        { name: 'cluster', column: { kind: 'numbers', values: fresh } },
        { name: 'mark', column: { kind: 'nullable-boolean', values: Uint8Array.of(1, 1, 0, 0, 1, 0), mask: Uint8Array.of(0, 0, 0, 1, 1, 1) } },
      ],
      // The colors follow the renamed, relabelled column (as the apply plan says: `colorChanges`).
      uns: { clusters_colors: ['#111111', '#222222'], cluster_colors: null },
      cellucid: { history_applied: '[{"step":"s1"}]', gene_sets: { Markers: { genes: ['gene'], description: '', origin: 'session', pulled_from: 'viewer', id: 'Markers' } } },
    },
  });
  const copy = await openCopy(bytes);
  assert.deepEqual(copy.root.get('obs').attrs['column-order'], ['clusters', 'text', 'score', 'flag', 'cluster', 'mark'],
    'each renamed column in its place; the old name, free, a new column after the others');
  // Read back as the plan reads a target: every column as it was given.
  const after = await readCopyTarget(copy.root, ['clusters', 'text', 'cluster', 'mark'], {}, { colors: ['clusters', 'cluster'] });
  assert.deepEqual(after.unsKeys.sort(), ['cellucid', 'clusters_colors', 'label_colors']);
  assert.deepEqual(after.colors, { clusters: ['#111111', '#222222'], cluster: null });
  assert.deepEqual({ ...after.columns.clusters, codes: Int8Array.from(after.columns.clusters.codes) }, relabelled);
  assert.deepEqual(after.columns.text, before.columns.label);
  // The packages' records, which opening leaves unread, are read for a plan: the applies before it, the gene sets.
  assert.equal(after.cellucid.history_applied, '[{"step":"s1"}]');
  assert.deepEqual(after.cellucid.gene_sets, { Markers: { genes: ['gene'], description: '', origin: 'session', pulled_from: 'viewer', id: 'Markers' } });
  assert.deepEqual(after.columns.cluster, { kind: 'numbers', values: fresh });
  assert.deepEqual(after.columns.mark, { kind: 'nullable-boolean', values: Uint8Array.of(1, 1, 0, 0, 1, 0), mask: Uint8Array.of(0, 0, 0, 1, 1, 1) });
  // A rename onto a column the frame keeps, of a column it lacks, twice, or in var, is refused before a byte is written.
  for (const [changes, pattern] of [
    [{ obs: [{ name: 'score', from: 'cluster', column: null }] }, /cannot be renamed 'score'/],
    [{ obs: [{ name: 'x', from: 'no such column', column: null }] }, /which is no column of obs/],
    [{ obs: [{ name: 'x', from: 'cluster', column: null }, { name: 'y', from: 'cluster', column: null }] }, /is renamed twice/],
    [{ var: [{ name: 'x', from: 'y', column: null }] }, /cannot rename a column/],
  ]) {
    const sink = memorySink();
    await assert.rejects(writeAnnDataCopy(root, sink, { changes }), pattern);
    assert.equal(sink.size, 0);
  }
});

test('the plan reads a priority-ordered store\'s columns by original position', async () => {
  const { root, shape } = await cellMajorPriorityFixture();
  const nObs = shape[0];
  const { layout } = await readPriorityLayout(root, nObs);
  const order = await layout.order();
  const target = await readCopyTarget(root, ['cluster']);
  const stored = await root.get('obs/cluster/codes').read();
  for (let row = 0; row < nObs; row++) assert.equal(target.columns.cluster.codes[order[row]], stored[row], `row ${row}`);
});

test('a column named in decomposed Unicode (NFD) is written under its name as given, and read back', async () => {
  const { root } = await cellMajorPriorityFixture();
  const nObs = root.get('obs/_index').shape[0];
  const name = 'cafe\u0301_score';
  const values = Float64Array.from({ length: nObs }, (_, i) => i / 2);
  const { bytes } = await copyToMemory(root, { changes: { obs: [{ name, column: { kind: 'numbers', values } }] } });
  const archive = await openZipArchive(bytesReader(bytes));
  assert.ok(archive.entries.some(entry => entry.path === `obs/${name}/0`.normalize('NFC')), 'the chunk is an entry');
  const metadata = parseJson(new TextDecoder().decode(await archive.entry('.zmetadata').read()), '.zmetadata').metadata;
  assert.ok(Object.hasOwn(metadata, `obs/${name}/.zarray`), 'its key is the name as given');
  const copy = await openCopy(bytes);
  assert.ok(copy.root.get('obs').attrs['column-order'].includes(name));
  const positions = await copy.root.get(`obs/${PRIORITY_ORIGINAL_COLUMN}`).read();
  assert.deepEqual([...await copy.root.get(`obs/${name}`).read()], Array.from(positions, position => Number(position) / 2), 'its values, never the fill');
});

test('a change a copy cannot make as asked is refused, in one sentence, before anything is written', async () => {
  const { root } = await cellMajorPriorityFixture();
  const nObs = root.get('obs/_index').shape[0];
  const nVars = root.get('var/_index').shape[0];
  const column = root.get('obs').attrs['column-order'][0];
  const numbers = (length = nObs) => ({ kind: 'numbers', values: new Float64Array(length) });
  const refused = async (changes, pattern, options = {}) => {
    const sink = memorySink();
    await assert.rejects(writeAnnDataCopy(root, sink, { changes, ...options }), pattern);
    assert.equal(sink.size, 0, `nothing was written (${pattern})`);
  };
  // What a copy changes.
  await refused({ colour: [] }, /'colour' is not a change/);
  await refused({ obs: {} }, /changes are a list of columns/);
  // Names that become paths (the specification's naming rules), and none in another case or Unicode form.
  for (const name of ['a/b', 'a\\b', 'a:b', 'tab\there', '.zattrs', 'zarr.json', '..', 'trailing ', 'trailing.', 'CON', 'lpt1.txt', '']) {
    await refused({ obs: [{ name, column: numbers() }] }, /The obs column|names must be non-empty/);
  }
  await refused({ obs: [{ name: '_index', column: numbers() }] }, /is the index of obs/);
  // The priority position column: never replaced, renamed, or taken as a new name.
  const priority = /^TypeError: obs\['cellucid_original_position'\] holds each row's original position in a file stored in priority order, so a copy keeps it as its source holds it and never writes, renames or replaces it\.$/;
  const refusedPriority = changes => refused(changes, error => priority.test(String(error)));
  await refusedPriority({ obs: [{ name: PRIORITY_ORIGINAL_COLUMN, column: numbers() }] });
  await refusedPriority({ obs: [{ name: 'positions', from: PRIORITY_ORIGINAL_COLUMN, column: null }] });
  await refusedPriority({ obs: [{ name: PRIORITY_ORIGINAL_COLUMN, from: column, column: null }] });
  await refused({ obs: [{ name: column.toUpperCase() === column ? column.toLowerCase() : column.toUpperCase(), column: numbers() }] }, /differ only in letter case or Unicode form/);
  await refused({ obs: [{ name: 'caf\u00e9', column: numbers() }, { name: 'cafe\u0301', column: numbers() }] }, /differ only in letter case or Unicode form/);
  await refused({ obs: [{ name: 'x', column: numbers() }, { name: 'x', column: numbers() }] }, /is used twice/);
  // Columns: kind, lengths, parts.
  await refused({ obs: [{ name: 'x', column: {} }] }, /has no kind/);
  await refused({ obs: [{ name: 'x', column: { kind: 'colors', values: [] } }] }, /none a copy writes/);
  await refused({ obs: [{ name: 'short', column: numbers(nObs - 1) }] }, /has \d+ values for \d+ rows/);
  await refused({ var: [{ name: 'short', column: numbers(nVars + 1) }] }, /var column 'short' has \d+ values for \d+ rows/);
  await refused({ obs: [{ name: 'x', column: { kind: 'numbers', values: Array(nObs).fill(0) } }] }, /numeric typed array/);
  await refused({ obs: [{ name: 'x', column: { kind: 'booleans', values: new Uint8Array(nObs).fill(2) } }] }, /holds 2 at row 0/);
  await refused({ obs: [{ name: 'x', column: { kind: 'nullable-integer', values: new Int32Array(nObs), mask: new Uint8Array(nObs - 1) } }] }, /mask has/);
  await refused({ obs: [{ name: 'x', column: { kind: 'categorical', codes: new Int8Array(nObs).fill(2), categories: ['a', 'b'] } }] }, /code 2 at row 0, outside its 2 categories/);
  await refused({ obs: [{ name: 'x', column: { kind: 'categorical', codes: new Int8Array(nObs), categories: ['a', 'a'] } }] }, /names the category 'a' twice/);
  await refused({ obs: [{ name: 'x', column: { kind: 'categorical', codes: new Float32Array(nObs), categories: ['a'] } }] }, /Int8Array, Int16Array or Int32Array/);
  await refused({ obs: [{ name: 'x', column: { kind: 'strings', values: Array(nObs).fill(1) } }] }, /list of text/);
  await refused({ var: [{ name: 'x', column: numbers(nVars) }], varModality: 'rna' }, /has no modalities/);
  // uns values unsValue cannot write as they are: refused, never dropped.
  await refused({ uns: { big: 2n ** 70n } }, /is a BigInt/);
  await refused({ uns: { mixed: [1, 'a'] } }, /list of number and string/);
  await refused({ uns: { nested: [[1], [2]] } }, /list of list/);
  await refused({ uns: { holes: ['a', null] } }, /list of string and null/);
  await refused({ uns: { deep: { inner: null } } }, /is null/);
  await refused({ uns: { when: new Date(0) } }, /is a Date/);
  await refused({ uns: { 'a/b': 1 } }, /The uns key 'a\/b'/);
  await refused({ uns: { deep: { 'x.': 1 } } }, /ends with a space or a dot/);
  await refused({ uns: { cellucid: {} } }, /changed key by key/);
  // uns['cellucid']: its keys, every name below them (gene sets'), and the record as written.
  await refused({ cellucid: { colour: 'red' } }, /not a key a Cellucid-ready AnnData holds/);
  await refused({ cellucid: { priority: {} } }, /keeps its source's/);
  await refused({ cellucid: { gene_sets: { 'CD4+/CD8+ T': { genes: ['CD4'] } } } }, /contains a character that cannot appear/);
  await refused({ cellucid: { id: 'not a portable id!' } }, /uns\['cellucid'\]\['id'\]/);
  await refused({ cellucid: { schema: 2 } }, /reads schema 1/);
  await refused({ cellucid: { id: ' padded' } }, /uns\['cellucid'\]\['id'\]/);
});

test('a sparse matrix kept in uns (anndata 0.7 csr_matrix, anndata 0.6 h5sparse) is presented, and copied, as the matrix it is', async () => {
  for (const path of ['emulated/uns_csr_matrix_07.h5ad', 'emulated/uns_h5sparse_06.h5ad']) {
    const opened = await openSource(await corpusSource('anndata', { path, layout: 'file' }));
    const presented = await currentLayoutView(opened.root);
    await presented.load();
    const graph = presented.get('uns/graph');
    assert.equal(graph.attrs['encoding-type'], 'csr_matrix', `${path}: uns['graph'] is a csr_matrix`);
    assert.deepEqual(plainShape(graph.attrs.shape), [3, 4]);
    assert.equal(presented.get('uns/graph/indptr').attrs['encoding-type'], undefined, `${path}: its arrays are the matrix's, not uns values`);
    const { bytes } = await copyToMemory(opened.root);
    const copy = await openCopy(bytes);
    assert.equal(copy.root.get('uns/graph').attrs['encoding-type'], 'csr_matrix');
    assert.deepEqual([...await copy.root.get('uns/graph/indptr').read()], [0, 2, 2, 3]);
    assert.deepEqual([...await copy.root.get('uns/graph/data').read()], [1.5, 2.5, 3.5]);
  }
});

/** A shape attribute as numbers (HDF5 may hold it as BigInts). */
function plainShape(shape) {
  return Array.from(shape, Number);
}

test('a MuData copy writes obs changes on the cells, var changes on the modality named, and refuses another', async () => {
  const opened = await openSource(await corpusSource('mudata', { path: 'mudata-0.4.1/citeseq.h5mu', layout: 'file' }));
  const root = opened.root;
  await root.load();
  const nObs = frameRows(root.get('obs'));
  const proteins = frameRows(root.get('mod/prot/var'));
  const genes = frameRows(root.get('mod/rna/var'));
  assert.notEqual(proteins, genes, 'the two modalities differ in features');
  const picked = Uint8Array.from({ length: nObs }, (_, cell) => cell % 2);
  const panel = Uint8Array.from({ length: proteins }, (_, feature) => (feature < 3 ? 1 : 0));
  const { bytes, result } = await copyToMemory(root, {
    changes: {
      obs: [{ name: 'picked', column: { kind: 'booleans', values: picked } }],
      var: [{ name: 'in_panel', column: { kind: 'booleans', values: panel } }],
      varModality: 'prot',
      uns: { note: 'MuData' },
    },
  });
  assert.equal(result.layout, 'mudata');
  const copy = await openCopy(bytes);
  assert.deepEqual([...await copy.root.get('obs/picked').read()], [...picked]);
  assert.deepEqual([...await copy.root.get('mod/prot/var/in_panel').read()], [...panel]);
  assert.equal(copy.root.get('mod/rna/var/in_panel'), null, 'only the modality named');
  assert.equal(await copy.root.get('uns/note').read(), 'MuData');
  // The default modality when none is named; a modality the dataset lacks, or features of another count, refused.
  const refused = async (changes, pattern) => {
    const sink = memorySink();
    await assert.rejects(writeAnnDataCopy(root, sink, { changes }), pattern);
    assert.equal(sink.size, 0);
  };
  await refused({ var: [{ name: 'x', column: { kind: 'booleans', values: new Uint8Array(genes) } }], varModality: 'atac' }, /'atac' is not a modality of the dataset \(prot, rna\)/);
  await refused({ var: [{ name: 'x', column: { kind: 'booleans', values: new Uint8Array(genes) } }], varModality: 'prot' }, /var of 'prot' column 'x' has \d+ values/);
  const byDefault = await copyToMemory(root, { changes: { var: [{ name: 'hv', column: { kind: 'booleans', values: new Uint8Array(genes) } }] } });
  assert.ok((await openCopy(byDefault.bytes)).root.get('mod/rna/var/hv') !== null, 'the default modality (rna)');
});

test('ZIP fields at exactly 0xFFFFFFFF take their ZIP64 fields, and read back', async () => {
  const sink = sparseSink();
  const zip = createZipWriter(sink);
  const size = 0xffffffff;
  // An entry of exactly 2^32 − 1 bytes: its sizes are the "see ZIP64" value, so ZIP64 holds them.
  await zip.add('exact.bin', zerosOf(size), { crc: zeroCrc(size) });
  // The next entry starts at 30 + 9 + 2^32 − 1 + its ZIP64 field: past the 32-bit offset.
  await zip.add('after.txt', new TextEncoder().encode('after'));
  await zip.finish();
  const archive = await openZipArchive(sink.reader());
  assert.equal(archive.entry('exact.bin').size, size);
  assert.equal(new TextDecoder().decode(await archive.entry('after.txt').read()), 'after');
});

test('a read made once (a copy\'s, a cell export\'s) keeps nothing in this browser\'s kept parts', async () => {
  const { withKeptParts } = await import('../assets/js/formats/io/kept-parts.js');
  const kept = [];
  const parts = { open() {}, ready: Promise.resolve(), measuredBy() {}, keep: (offset, bytes) => kept.push([offset, bytes.length]) };
  const source = withKeptParts({ read: async (offset, length) => new Uint8Array(length) }, parts);
  await source.read(0, 8, { keepInMemory: false });
  assert.deepEqual(kept, [], 'nothing kept of a read made once');
  await source.read(8, 4, {});
  assert.deepEqual(kept, [[8, 4]], 'what a view reads is kept');
});

/**
 * A dense X of `rows` × `genes` in source chunks of `[sourceRows, genes]`,
 * deflated (read whole, as a file's are), opened through a store that counts
 * the chunks it serves.
 */
async function denseSource(rows, genes, sourceRows) {
  const values = Float32Array.from({ length: rows * genes }, (_, i) => (i % 97) / 8);
  const tree = annData({
    obs: stringFrame(Array.from({ length: rows }, (_, i) => `c${i}`)),
    var: stringFrame(Array.from({ length: genes }, (_, g) => `g${g}`)),
    X: array(values, { shape: [rows, genes], chunks: [sourceRows, genes], compressed: true }),
  });
  const { store, fetched } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  return { root, fetched, values, sourceChunks: Math.ceil(rows / sourceRows) };
}

test('a dense X of more rows than one band is copied a band of every gene at a time, each source chunk read once', async () => {
  const rows = 300_000;
  const genes = 32;
  const { root, fetched, values, sourceChunks } = await denseSource(rows, genes, 8192);
  const budgetBytes = 1024 * 1024;
  const { bytes } = await copyToMemory(root, { budgetBytes });
  const reads = fetched.filter(key => key.startsWith('X/')).length;
  assert.equal(reads, sourceChunks, `each of the ${sourceChunks} source chunks read once (read ${reads})`);
  const copy = await openCopy(bytes);
  // Bands of the rows the budget holds across every gene; a chunk of 2^18 values.
  const bandRows = Math.floor(budgetBytes / (genes * 4));
  assert.deepEqual([...copy.root.get('X').chunks], [bandRows, Math.min(genes, Math.floor(WHOLE_CHUNK / bandRows))]);
  assert.ok(Buffer.from((await copy.root.get('X').read()).buffer).equals(Buffer.from(values.buffer)), 'every value');
});

// ---------------------------------------------------------------------------
// Through the reader worker: the page's sink, answered batch by batch.
// ---------------------------------------------------------------------------

test('the reader worker writes the open dataset\'s copy to the page\'s sink, a batch at a time, and a failing sink fails it', async () => {
  await import('./helpers/anndata-reader-in-process.mjs');
  const { AnnDataReaderClient } = await import('../assets/js/data/anndata-reader-client.js');
  const bytes = readFileSync(new URL('../tests/browser/fixtures/data-mapping-full.zarr.zip', import.meta.url));
  const client = new AnnDataReaderClient();
  try {
    await client.open({ file: new File([bytes], 'data-mapping-full.zarr.zip') });
    const sink = memorySink();
    let writes = 0;
    // Its progress is its read activity's, of the job that asked.
    const { getReadActivityLog } = await import('../assets/js/data/read-activity-log.js');
    const reports = [];
    const stop = getReadActivityLog().subscribe(report => {
      if (report.kind === 'cells' && report.label === 'a copy of the dataset') reports.push(report);
    });
    const result = await client.writeAnnDataCopy({
      obs: [{ name: 'picked', column: { kind: 'booleans', values: Uint8Array.from({ length: 300 }, (_, i) => i % 2) } }],
    }, {
      sink: { write: async part => { writes++; await sink.write(part); } },
      owner: 'job-save-copy',
    });
    // The log acts on what it took in with the frame's other reports: now.
    getReadActivityLog().flush();
    stop();
    assert.equal(sink.size, result.bytes, 'every byte reached the sink before the copy resolved');
    assert.ok(writes > 0);
    const last = reports.at(-1);
    assert.equal(last?.status, 'done', 'the copy\'s activity ends done');
    assert.equal(last.owner, 'job-save-copy');
    assert.ok(last.progress.total > 0 && last.progress.done === last.progress.total, 'its progress ends complete');
    // The same bytes as a copy made beside the worker.
    const opened = await openSource({ file: new File([bytes], 'data-mapping-full.zarr.zip') });
    const direct = await copyToMemory(opened.root, { changes: { obs: [{ name: 'picked', column: { kind: 'booleans', values: Uint8Array.from({ length: 300 }, (_, i) => i % 2) } }] } });
    assert.ok(Buffer.from(sink.bytes()).equals(Buffer.from(direct.bytes)), 'the worker\'s copy is the copy');
    // A sink that cannot write fails the copy with its error.
    await assert.rejects(client.writeAnnDataCopy({}, { sink: { write: () => { throw new Error('the disk is full'); } } }), /the disk is full/);
    // Stopped mid-copy (after its first batch): the copy ends as a cancellation, nothing more reaches the sink.
    const halt = new AbortController();
    let batches = 0;
    await assert.rejects(client.writeAnnDataCopy({}, {
      signal: halt.signal,
      sink: { write: () => { batches++; halt.abort(new DOMException('Stopped by the test.', 'AbortError')); } },
    }), error => error?.name === 'AbortError');
    assert.equal(batches, 1, 'no batch after the stop');
    // The reader is still open and copies again.
    const again = memorySink();
    await client.writeAnnDataCopy({}, { sink: again });
    assert.ok(again.size > 0);
  } finally {
    client.close?.();
  }
});

test('the worker\'s sink posts batches and waits for the page once a window of them is unanswered', async () => {
  const { createAcknowledgedSink } = await import('../assets/js/data/anndata/write/acknowledged-sink.js');
  const posts = [];
  const controller = new AbortController();
  const acknowledged = createAcknowledgedSink(message => posts.push(message), { ticket: 7, signal: controller.signal, batchBytes: 10, windowBytes: 20 });
  const part = () => new Uint8Array(10);
  await acknowledged.sink.write(part());
  await acknowledged.sink.write(part());
  assert.equal(posts.length, 2, 'a batch is posted once it holds its bytes');
  assert.deepEqual(posts.map(post => post.copy), [7, 7]);
  let third = false;
  const waiting = acknowledged.sink.write(part()).then(() => { third = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(third, false, 'a write waits while the window is full');
  acknowledged.acknowledge();
  await waiting;
  assert.equal(third, true, 'an answer lets it on');
  acknowledged.acknowledge();
  acknowledged.acknowledge();
  await acknowledged.drain();
  // An answer with an error fails the next write; an abort fails a write waiting.
  const failing = createAcknowledgedSink(() => {}, { ticket: 8, batchBytes: 1, windowBytes: 1 });
  const stuck = failing.sink.write(new Uint8Array(4));
  failing.acknowledge(new Error('no room'));
  await assert.rejects(stuck.then(() => failing.sink.write(new Uint8Array(1))), /no room/);
  const aborted = createAcknowledgedSink(() => {}, { ticket: 9, signal: controller.signal, batchBytes: 1, windowBytes: 1 });
  const pending = aborted.sink.write(new Uint8Array(4));
  controller.abort(new Error('stopped'));
  await assert.rejects(pending, /stopped/);
  aborted.release();
  acknowledged.release();
  failing.release();
});

test('chunks encoded on the decode workers, many at once, give the same archive as one at a time here', async t => {
  const { configureDecodePool } = await import('../assets/js/formats/io/decode-pool.js');
  const { createNodeDecodeWorker } = await import('./helpers/node-decode-worker.mjs');
  const { poolEncoder } = await import('../assets/js/data/anndata/write/pool-encoder.js');
  t.after(() => configureDecodePool());
  const { cellMajor } = await cellMajorPriorityFixture();
  const here = await copyToMemory(cellMajor);
  let tasks = 0;
  configureDecodePool({
    createWorker: () => {
      const worker = createNodeDecodeWorker();
      const post = worker.postMessage;
      worker.postMessage = (message, transfer) => {
        if (message.kind === 'run') tasks++;
        post(message, transfer);
      };
      return worker;
    },
    size: 3,
    minBytes: 0,
  });
  const pooled = await copyToMemory(cellMajor, { encode: poolEncoder(), inFlight: 6 });
  assert.ok(tasks > 10, `chunks were encoded on the workers (${tasks})`);
  assert.ok(Buffer.from(pooled.bytes).equals(Buffer.from(here.bytes)), 'the same bytes');
});

test('a table anndata 0.7 kept in uns is presented, and copied, as a current dataframe with its categoricals', async () => {
  const source = await corpusSource('anndata', { path: 'anndata-0.7.8/uns_dataframe.h5ad', layout: 'file' });
  const opened = await openSource(source);
  const presented = await currentLayoutView(opened.root);
  await presented.load();
  const table = presented.get('uns/table');
  assert.equal(table.attrs['encoding-version'], '0.2.0');
  assert.equal(presented.get('uns/table/y').attrs['encoding-type'], 'categorical');
  assert.equal(presented.get('uns/table/__categories'), null, 'the categories are the column\'s');
  const { bytes } = await copyToMemory(opened.root);
  const copy = await openCopy(bytes);
  assert.deepEqual(await copy.root.get('uns/table/y/categories').read(), ['a', 'b']);
  assert.deepEqual([...await copy.root.get('uns/table/y/codes').read()], [0, 1, 0]);
});
