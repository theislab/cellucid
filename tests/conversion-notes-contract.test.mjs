/**
 * A format read once into this browser (an R object, a MatrixMarket folder)
 * says what became of it, as the Dataset box shows it
 * (`app/ui/modules/dataset-card.js`): where its store is kept (this
 * browser's storage, for later visits when the file's identity names its
 * version, or memory where there is none), whether the file was read whole,
 * whether an earlier opening had kept it, and every part that was not read.
 *
 * The facts travel from the transcoder (`transcode/session.js`) through
 * `openDatasetStore` and the reader to the storage description
 * (`anndata-storage.js`); an AnnData file has none. A dropped part of an R
 * object is named only when it held something: R writes an empty
 * `scale.data` matrix and empty `commands`/`neighbors` lists into every
 * Seurat object.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { openDatasetStore } from '../assets/js/data/anndata/open.js';
import { TRANSCODERS } from '../assets/js/data/anndata/transcode/index.js';
import { R_OBJECT_PLAN, passedOverNotes } from '../assets/js/data/anndata/transcode/r-object.js';
import { describeAnnDataStorage } from '../assets/js/data/anndata-storage.js';
import { readRFile } from '../assets/js/formats/rds/index.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { blobByteSource, bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { openZipArchive } from '../assets/js/formats/zip/index.js';
import { opfsOnDisk } from './helpers/opfs-on-disk.mjs';

const archive = await openZipArchive(createByteReader(bytesByteSource(
  new Uint8Array(readFileSync(new URL('./fixtures/rds/corpus.zip', import.meta.url))),
  { name: 'corpus.zip' },
)));
const read = async path => (await archive.entry(path).read()).slice();
const rFile = async name => new File([await read(`rds/${name}`)], name, { lastModified: 1 });
const byteReaderOf = file => createByteReader(blobByteSource(file));

async function mtxFolder(name) {
  const prefix = `mtx/${name}/`;
  const files = new Map();
  for (const entry of archive.entries) {
    if (!entry.path.startsWith(prefix) || entry.path.endsWith('/')) continue;
    files.set(entry.path.slice(prefix.length), new File([await read(entry.path)], entry.path.split('/').pop()));
  }
  return { files, rootName: name };
}

const open = (source, transcoding = {}) => openDatasetStore({ source }, { decodedChunkCacheBytes: 1 << 24, transcoding });

/** What SeuratObject's pbmc_small carries that Cellucid passes over. */
const PBMC_SMALL_NOT_READ = Object.freeze([
  'assays$RNA@scale.data (15 KB): Cellucid does not use it.',
  'reductions$pca@feature.loadings (3.5 KB): Cellucid does not use it.',
  'reductions$pca@feature.loadings.projected (3.5 KB): Cellucid does not use it.',
  'reductions$pca@jackstraw (4.8 KB): Cellucid does not use it.',
  'commands (7.4 KB): Cellucid does not use it.',
]);

test('a dropped part of an R object keeps the bytes it spanned and whether it held anything', async () => {
  const parsed = await readRFile(byteReaderOf(await rFile('seurat4.rds')), { plan: R_OBJECT_PLAN });
  const [assay] = parsed.root.attributes.assays.items;
  const scaleData = assay.attributes['scale.data'];
  assert.equal(scaleData.kind, 'skipped');
  assert.equal(scaleData.empty, true, 'the empty matrix every unscaled assay carries');
  assert.ok(scaleData.bytes > 0);
  assert.equal(parsed.root.attributes.commands.empty, true);
  assert.deepEqual(passedOverNotes(parsed.root), [], 'nothing of an object that left nothing out');

  const saved = await readRFile(byteReaderOf(await rFile('SeuratObject_5.4.0_pbmc_small.rda')), { plan: R_OBJECT_PLAN });
  const pbmc = saved.root.items[0].value;
  const scaled = pbmc.attributes.assays.items[0].attributes['scale.data'];
  assert.equal(scaled.empty, false);
  assert.equal(scaled.bytes, 14_925);
  assert.deepEqual(passedOverNotes(pbmc), PBMC_SMALL_NOT_READ);
});

test('an object read into memory says so, and names every part it did not read', async () => {
  const opened = await open({ file: await rFile('SeuratObject_5.4.0_pbmc_small.rda') }, { memory: true });
  assert.deepEqual(opened.conversion, { kept: 'memory', persistent: false, whole: true, reused: false, notes: PBMC_SMALL_NOT_READ });
  assert.ok(Object.isFrozen(opened.conversion) && Object.isFrozen(opened.conversion.notes));

  const whole = await open({ file: await rFile('seurat5_gzip.rds') }, { memory: true });
  assert.deepEqual(whole.conversion, { kept: 'memory', persistent: false, whole: true, reused: false, notes: [] });
});

test('kept in this browser\'s storage for later visits, then reopened from it', async t => {
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  const file = await rFile('SeuratObject_5.4.0_pbmc_small.rda');
  const first = await TRANSCODERS.rda.transcode({ file }, { byteReaderOf, environment: disk.environment });
  assert.deepEqual(first.conversion, { kept: 'opfs', persistent: true, whole: true, reused: false, notes: PBMC_SMALL_NOT_READ });
  const again = await TRANSCODERS.rda.transcode({ file }, { byteReaderOf, environment: disk.environment });
  assert.deepEqual(again.conversion, { kept: 'opfs', persistent: true, whole: true, reused: true, notes: PBMC_SMALL_NOT_READ },
    'the notes are kept with the store, so a reopening says the same');
});

test('a MatrixMarket folder converts as an R object does', async () => {
  const opened = await open(await mtxFolder('kb'), { memory: true });
  assert.equal(opened.format, 'mtx');
  assert.deepEqual(opened.conversion, { kept: 'memory', persistent: false, whole: true, reused: false, notes: [] });
});

test('an AnnData file is read in place and has no conversion', async () => {
  const bytes = readFileSync(new URL('./browser/fixtures/catalog/current-ui.h5ad', import.meta.url));
  const opened = await open({ file: new File([bytes], 'current-ui.h5ad') });
  assert.equal(opened.conversion, undefined);
});

test('the storage description carries the conversion, checked, and null for every other format', () => {
  const file = new File([new Uint8Array(4)], 'pbmc_small.rds');
  const conversion = { kept: 'opfs', persistent: true, whole: true, reused: false, notes: ['commands (7.4 KB): Cellucid does not use it.'] };
  const storage = describeAnnDataStorage({ file }, { format: 'rds', layout: 'file', name: 'pbmc_small.rds', conversion });
  assert.deepEqual(storage.conversion, conversion);
  assert.ok(Object.isFrozen(storage.conversion) && Object.isFrozen(storage.conversion.notes));

  const h5ad = describeAnnDataStorage({ file: new File([new Uint8Array(4)], 'cells.h5ad') }, { format: 'h5ad', layout: 'file', name: 'cells.h5ad' });
  assert.equal(h5ad.conversion, null);
  const folder = describeAnnDataStorage({ files: new Map([['matrix.mtx', file]]), rootName: 'kb' }, {
    format: 'mtx', layout: 'folder', name: 'kb', conversion: { kept: 'memory', persistent: false, whole: true, reused: false, notes: [] },
  });
  assert.equal(folder.conversion.kept, 'memory');

  const good = { kept: 'opfs', persistent: true, whole: true, reused: false, notes: [] };
  for (const bad of [{ ...good, kept: 'disk' }, { ...good, reused: 'no' }, { ...good, notes: [1] }, { ...good, persistent: undefined }, { ...good, whole: 1 }]) {
    assert.throws(() => describeAnnDataStorage({ file }, { format: 'rds', layout: 'file', name: 'x.rds', conversion: bad }), TypeError);
  }
});
