/**
 * The R object and MatrixMarket corpora (`tests/fixtures/rds/corpus.zip`,
 * written by `scripts/rds-corpus/generate.R` with SeuratObject 4 and 5 and
 * SingleCellExperiment, and by `scripts/mtx-corpus/generate.py` in each
 * producer's layout; packed by `scripts/rds-corpus/pack.py`), each file
 * opened through the real `openDatasetStore` (the transcoders,
 * `data/anndata/transcode/`) and read back value for value against what R
 * (`readRDS` and the packages' accessors) or scanpy read from the same file:
 * the cells, every obs column (categories and codes, NA kept apart from
 * values), every embedding, the first cells' expression rows of X, the
 * counts layer, the graphs, the modalities and `uns['cellucid']`. Files R
 * refuses to be shown (no embedding, a matrix kept outside the file, a
 * Seurat v2 object, a symmetric matrix) are refused with their reason, and a
 * `save()` file of several objects asks which to open.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { openDatasetStore } from '../assets/js/data/anndata/open.js';
import { checkCorpusEntry } from '../scripts/rds-corpus/check.mjs';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { openZipArchive } from '../assets/js/formats/zip/index.js';

const ARCHIVE = new URL('./fixtures/rds/corpus.zip', import.meta.url);
const CACHE_BYTES = 64 * 1024 * 1024;

const archive = await openZipArchive(createByteReader(bytesByteSource(new Uint8Array(readFileSync(ARCHIVE)), { name: 'corpus.zip' })));
const paths = archive.entries.map(entry => entry.path);
const read = async path => (await archive.entry(path).read()).slice();
const json = async path => JSON.parse(new TextDecoder().decode(await read(path)));

const expectations = paths.filter(path => path.endsWith('.expected.json'));

test('the corpus holds R objects of every writer and compression, and MatrixMarket folders of every producer', () => {
  const rds = expectations.filter(path => path.startsWith('rds/'));
  const mtx = expectations.filter(path => path.startsWith('mtx/'));
  assert.ok(rds.length >= 20, `${rds.length} R files`);
  assert.ok(mtx.length >= 5, `${mtx.length} MatrixMarket folders`);
  for (const name of ['seurat5_gzip.rds', 'seurat5_bzip2.rds', 'seurat5_xz.rds', 'seurat5_none.rds', 'seurat5_v2.rds',
    'seurat5_split.rds', 'seurat5_multi.rds', 'seurat4.rds', 'seurat4_v2_none.rds', 'sce.rds', 'two_objects.rda']) {
    assert.ok(paths.includes(`rds/${name}`), name);
  }
});

for (const path of expectations) {
  const corpus = path.split('/')[0];
  const name = path.slice(corpus.length + 1, -'.expected.json'.length);
  test(`${corpus}/${name} reads as R or scanpy read it`, async () => {
    await checkCorpusEntry({ paths, read }, corpus, name, await json(path));
  });
}

test('the same object compressed three ways is the same stream once decompressed', async () => {
  // The gzip file was saved first, while the factor levels were still a
  // deferred string (ALTREP); saving expanded them, so the later three
  // serialize the same bytes.
  const { decompressed, readInOrder } = await import('../assets/js/formats/rds/index.js');
  const plain = await read('rds/seurat5_none.rds');
  for (const name of ['seurat5_bzip2.rds', 'seurat5_xz.rds']) {
    const bytes = await read(`rds/${name}`);
    const file = { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) };
    const { pieces, compressions } = await decompressed(readInOrder(file, { pieceBytes: 4099 }));
    const parts = [];
    for await (const piece of pieces) parts.push(piece);
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    assert.equal(compressions.length, 1, name);
    assert.deepEqual(out, plain, `${name} decompresses to the uncompressed file's bytes`);
  }
});

test('an h5Seurat file is recognised and refused with the line that converts it', async () => {
  // SeuratDisk's layout (`assays`, `cell.names`, `meta.data`, root
  // `active.assay`/`project`/`version`), written with h5py.
  const bytes = readFileSync(new URL('./fixtures/rds/layout.h5Seurat', import.meta.url));
  await assert.rejects(
    openDatasetStore({ source: { file: new File([bytes], 'pbmc.h5Seurat') } }, { decodedChunkCacheBytes: CACHE_BYTES }),
    error => error.details?.explained === true && error.details?.reason === 'h5seurat' && /SeuratDisk::LoadH5Seurat/.test(error.message)
  );
});

test('the monthly drift check knows the slots of every class slots.R records, and runs on a schedule', () => {
  const slotsR = readFileSync(new URL('../scripts/rds-corpus/slots.R', import.meta.url), 'utf8');
  const block = /classes <- list\(([\s\S]*?)\n\)/.exec(slotsR)[1];
  const named = [...block.matchAll(/"([A-Za-z0-9]+)"/g)].map(match => match[1]);
  assert.ok(named.includes('Assay5') && named.includes('SingleCellExperiment'), named.join(', '));
  const known = JSON.parse(readFileSync(new URL('../scripts/rds-corpus/known-slots.json', import.meta.url), 'utf8'));
  for (const name of named) assert.ok(Array.isArray(known.slots[name]) && known.slots[name].length > 0, `known-slots.json lists ${name}`);
  const workflow = readFileSync(new URL('../.github/workflows/r-corpus-drift.yml', import.meta.url), 'utf8');
  assert.match(workflow, /schedule:\n\s+- cron: "[^"]+ 1 \* \*"/, 'monthly');
  assert.match(workflow, /sh scripts\/rds-corpus\/drift\.sh Rscript/);
});
