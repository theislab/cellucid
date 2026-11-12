/**
 * The input format registry (`assets/js/data/input-formats.js`) is the one
 * place that knows what a file or folder is from its name or its first
 * bytes. This suite pins it four ways:
 *
 * - `tests/fixtures/input-formats.json` is its document byte for byte, and
 *   cellucid-python (`src/cellucid/input_formats.json`) and cellucid-r
 *   (`inst/input_formats.json`) keep the same bytes,
 *   pinned there by this digest, so the three name formats the same way;
 * - names, folder markers and signatures decide as stated;
 * - every entry point that takes a name (served stores, catalogs, drops, the
 *   address bar, the File… picker, the info tips) follows the registry;
 * - no other module of the app tests a file name against a format's ending
 *   (the container packages under `formats/` name their own stores and are
 *   not entry points).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CELLUCID_FILES,
  INPUT_FORMATS,
  cellucidFileOfName,
  compressedFormatOfName,
  defaultDatasetIdOf,
  fileFormatOfName,
  filePickerAccept,
  folderFormatOfName,
  folderFormatOfPaths,
  inputFormat,
  inputFormatsJson,
  isInputFormatId,
  layoutOfHead,
  layoutsOf,
  openableNamePhrases,
  openableNamesText,
  readsFromHead,
  titleOfName,
} from '../assets/js/data/input-formats.js';
import { requireServedAnnData } from '../assets/js/data/served-anndata.js';
import { catalogEntryForm } from '../assets/js/data/sources/anndata-catalog.js';
import { localFileLayout } from '../assets/js/app/ui/modules/dataset-drop.js';
import { routeAddress } from '../assets/js/app/ui/modules/address-routing.js';
import { LAYOUT_VIEWS } from '../assets/js/data/anndata/views/index.js';
import { TRANSCODERS } from '../assets/js/data/anndata/transcode/index.js';
import { INFO_TIPS } from '../assets/js/app/ui/components/info-tips.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/input-formats.json');

/**
 * The digest of `input-formats.json`. cellucid-python
 * (`tests/test_input_formats.py`) and cellucid-r
 * (`tests/testthat/test-input-formats.R`) pin the same one.
 */
const INPUT_FORMATS_SHA256 = '31a4853465dd05ec412f4645f9a9efdfb6a14393f0932b4c26883648ad01f6f9';

/** A dataset's structure for its default id (`defaultDatasetIdOf`), and its pinned digits. */
const PBMC = Object.freeze({ nObs: 2700, nVars: 3, varNames: Object.freeze(['CD3E', 'MS4A1', 'LYZ']) });
const PBMC_STRUCTURE = '1bd42f4e';

test('input-formats.json is the registry document, byte for byte, at the pinned digest', async () => {
  const bytes = await readFile(FIXTURE, 'utf8');
  assert.equal(
    bytes,
    inputFormatsJson(),
    'Regenerate it: node --input-type=module -e "import(\'./assets/js/data/input-formats.js\')' +
    '.then(m => process.stdout.write(m.inputFormatsJson()))" > tests/fixtures/input-formats.json, ' +
    'then copy it to cellucid-python and cellucid-r and update the three digests.'
  );
  assert.equal(createHash('sha256').update(bytes).digest('hex'), INPUT_FORMATS_SHA256);
});

test('every format is well formed, and each container and layout has one format read as stored', () => {
  const ids = new Set();
  for (const format of INPUT_FORMATS) {
    assert.match(format.id, /^[a-z0-9][a-z0-9-]*$/, `${format.id}: a stable lower-case id`);
    assert.ok(!ids.has(format.id), `${format.id} is listed once`);
    ids.add(format.id);
    assert.ok(['python', 'r', 'any'].includes(format.ecosystem), `${format.id}: ecosystem`);
    assert.ok(['ranges', 'stream'].includes(format.access), `${format.id}: access`);
    assert.ok(layoutsOf(format.id).length > 0, `${format.id}: arrives in some layout`);
    for (const [layout, names] of Object.entries(format.names)) {
      assert.ok(['file', 'zip', 'folder'].includes(layout), `${format.id}: layout ${layout}`);
      for (const name of names) assert.match(name, /^\.[a-z0-9.]+$/, `${format.id}: ${name} is a lower-case ending`);
      assert.deepEqual([...names], [...names].sort((a, b) => b.length - a.length), `${format.id}: longest ending first`);
    }
    assert.equal(typeof format.writeAgain, 'string');
    assert.equal(inputFormat(format.id), format);
    // A format is a layout view, a transcoder, or AnnData as stored: never two.
    assert.ok(!(LAYOUT_VIEWS[format.id] && TRANSCODERS[format.id]), `${format.id}: one way in`);
    assert.equal(TRANSCODERS[format.id] !== undefined, format.access === 'stream', `${format.id}: stream formats are transcoded`);
  }
  for (const key of [...Object.keys(LAYOUT_VIEWS), ...Object.keys(TRANSCODERS)]) {
    assert.ok(isInputFormatId(key), `${key}: a view or transcoder belongs to a registry format`);
  }
  const stored = new Map();
  for (const format of INPUT_FORMATS) {
    if (LAYOUT_VIEWS[format.id] || TRANSCODERS[format.id]) continue;
    for (const layout of layoutsOf(format.id)) {
      const key = `${format.container}/${layout}`;
      assert.ok(!stored.has(key), `${key}: one format is read as stored (${stored.get(key)}, ${format.id})`);
      stored.set(key, format.id);
    }
  }
  assert.throws(() => inputFormat('loom-v9'), /Unknown input format 'loom-v9'/);
  assert.equal(isInputFormatId('h5ad'), true);
  assert.equal(isInputFormatId('anndata'), false);
});

test('a name says its format and layout; the longest ending wins', () => {
  assert.deepEqual(fileFormatOfName('a.H5AD'), { format: 'h5ad', layout: 'file' });
  assert.deepEqual(fileFormatOfName('a.zarr.zip'), { format: 'zarr', layout: 'zip' });
  assert.deepEqual(fileFormatOfName('a.ZIP'), { format: 'zarr', layout: 'zip' });
  assert.deepEqual(fileFormatOfName('https://host/x/a.h5ad'), { format: 'h5ad', layout: 'file' });
  assert.deepEqual(fileFormatOfName('pbmc.rds'), { format: 'rds', layout: 'file' });
  assert.deepEqual(fileFormatOfName('objects.RData'), { format: 'rda', layout: 'file' });
  assert.deepEqual(fileFormatOfName('objects.rda'), { format: 'rda', layout: 'file' });
  assert.deepEqual(fileFormatOfName('pbmc.h5Seurat'), { format: 'h5seurat', layout: 'file' });
  // GEO gzips supplementary files: R objects arrive as .rds.gz, .rda.gz, .RData.gz.
  assert.deepEqual(fileFormatOfName('GSM1_seurat.rds.gz'), { format: 'rds', layout: 'file' });
  assert.deepEqual(fileFormatOfName('GSE1_objects.RData.gz'), { format: 'rda', layout: 'file' });
  assert.deepEqual(fileFormatOfName('GSE1_objects.rda.gz'), { format: 'rda', layout: 'file' });
  assert.equal(titleOfName('GSM1_seurat.rds.gz'), 'GSM1_seurat');
  assert.match(defaultDatasetIdOf('rds', 'GSM1_seurat.rds.gz', PBMC), /^rds_GSM1_seurat_[0-9a-f]{8}$/);
  assert.equal(fileFormatOfName('matrix.mtx.gz'), null);
  // A table of cells is read inside a MatrixMarket folder, never as a dataset of its own.
  assert.equal(fileFormatOfName('cells.csv.gz'), null);
  assert.equal(fileFormatOfName('pbmc.qs'), null);
  assert.equal(fileFormatOfName('notes.txt.gz'), null);
  assert.match(defaultDatasetIdOf('rds', 'pbmc.rds', PBMC), /^rds_pbmc_[0-9a-f]{8}$/);
  assert.deepEqual(fileFormatOfName('pbmc.loom'), { format: 'loom', layout: 'file' });
  assert.deepEqual(fileFormatOfName('filtered_feature_bc_matrix.h5'), { format: 'tenx-h5', layout: 'file' });
  assert.deepEqual(fileFormatOfName('citeseq.H5MU'), { format: 'h5mu', layout: 'file' });
  assert.match(defaultDatasetIdOf('loom', 'pbmc.loom', PBMC), /^loom_pbmc_[0-9a-f]{8}$/);
  assert.deepEqual(fileFormatOfName('a.h5ad.gz'), { format: 'h5ad', layout: 'file', compression: 'gzip' }, 'a compressed copy, read whole');
  assert.equal(fileFormatOfName('a.zarr'), null, 'a folder name is not a file name');
  assert.deepEqual(folderFormatOfName('atlas.zarr'), { format: 'zarr', layout: 'folder' });
  assert.deepEqual(folderFormatOfName('/a/b/atlas.ZARR/'), { format: 'zarr', layout: 'folder' });
  assert.equal(folderFormatOfName('atlas'), null);
  assert.deepEqual(compressedFormatOfName('x.h5ad.gz'), { format: 'h5ad', layout: 'file', compression: 'gzip' });
  assert.equal(compressedFormatOfName('x.h5ad'), null);

  assert.equal(titleOfName('atlas.h5ad'), 'atlas');
  assert.equal(titleOfName('atlas.zarr.zip'), 'atlas');
  assert.equal(titleOfName('atlas.ZIP'), 'atlas');
  assert.equal(titleOfName('atlas.zarr/'), 'atlas');
  assert.equal(titleOfName('atlas.v2.h5ad'), 'atlas.v2');
  assert.equal(titleOfName('.zarr'), '.zarr', 'nothing would be left');
  assert.equal(titleOfName('notes.txt'), 'notes.txt');
  // The ids every session saved on a dataset that states none records:
  // its format, its name and what it holds.
  const structure = defaultDatasetIdOf('h5ad', 'pbmc.h5ad', PBMC).slice('h5ad_pbmc_'.length);
  assert.match(structure, /^[0-9a-f]{8}$/);
  assert.equal(defaultDatasetIdOf('h5ad', 'pbmc.h5ad', PBMC), `h5ad_pbmc_${structure}`);
  assert.equal(defaultDatasetIdOf('zarr', 'pbmc.zarr.zip', PBMC), `zarr_pbmc_${structure}`);
  assert.equal(defaultDatasetIdOf('zarr', 'pbmc.zarr', PBMC), `zarr_pbmc_${structure}`);
  // Pinned: the same data named alike in every release.
  assert.equal(structure, PBMC_STRUCTURE);
  // Another cell count, gene count, gene name or gene order: another dataset.
  for (const other of [
    { ...PBMC, nObs: PBMC.nObs + 1 },
    { nObs: PBMC.nObs, nVars: 2, varNames: ['CD3E', 'MS4A1'] },
    { ...PBMC, varNames: ['CD3E', 'MS4A1', 'LYZx'] },
    { ...PBMC, varNames: ['MS4A1', 'CD3E', 'LYZ'] },
  ]) {
    assert.notEqual(defaultDatasetIdOf('h5ad', 'pbmc.h5ad', other), `h5ad_pbmc_${structure}`, JSON.stringify(other));
  }
  assert.throws(() => defaultDatasetIdOf('h5ad', 'pbmc.h5ad', { nObs: 3, nVars: 2, varNames: ['a'] }), /one name per gene/);
  assert.equal(readsFromHead({ format: 'h5ad', layout: 'file' }), true);
  assert.equal(readsFromHead({ format: 'zarr', layout: 'zip' }), false);
  assert.equal(readsFromHead(null), false);
});

test('Cellucid\'s own files are named, are no dataset, and say what they are and where they go', () => {
  assert.deepEqual(CELLUCID_FILES.map(file => [file.id, file.label, [...file.names]]), [
    ['library', 'Cellucid library file', ['.cellucid-library']],
    ['session', 'Cellucid session file', ['.cellucid-session']],
  ]);
  assert.equal(cellucidFileOfName('My work.Cellucid-Library')?.id, 'library');
  assert.equal(cellucidFileOfName('cellucid-session-2026-11-04.cellucid-session')?.id, 'session');
  assert.equal(cellucidFileOfName('cells.h5ad'), null);
  for (const file of CELLUCID_FILES) {
    for (const name of file.names) {
      assert.equal(fileFormatOfName(`x${name}`), null, `${name} is no dataset`);
      assert.equal(localFileLayout({ name: `x${name}` }), null);
    }
  }
  assert.match(cellucidFileOfName('x.cellucid-library').said, /library file.*Session › Open data › My datasets › All… › Import…\.$/);
  // A session file opens in the web app, its dataset with it (L25-8): no "open its dataset first".
  assert.match(cellucidFileOfName('x.cellucid-session').said, /session file.*drop it on the page, or choose it with State › Session › Load… › Open a session file…; its dataset opens with it\..*cellucid\.read_session\(\).*cellucid_read_session\(\)\.$/);
  assert.doesNotMatch(cellucidFileOfName('x.cellucid-session').said, /Open its dataset, then/);
  // Python and R read them from the document.
  assert.deepEqual(JSON.parse(inputFormatsJson()).cellucidFiles, CELLUCID_FILES.map(file => ({ ...file, names: [...file.names] })));
});

test('a folder is a store by its name or by a marker file anywhere below it', () => {
  assert.deepEqual(folderFormatOfPaths(['cells.zarr/X/0']), { format: 'zarr', layout: 'folder' });
  assert.deepEqual(folderFormatOfPaths(['cells/.zgroup']), { format: 'zarr', layout: 'folder' });
  assert.deepEqual(folderFormatOfPaths(['cells/obs/.zattrs']), { format: 'zarr', layout: 'folder' });
  assert.deepEqual(folderFormatOfPaths(['cells/zarr.json']), { format: 'zarr', layout: 'folder' });
  assert.deepEqual(folderFormatOfPaths(['.zmetadata']), { format: 'zarr', layout: 'folder' });
  // A Cell Ranger outs/ folder, by its matrix file, wins over anything below it.
  assert.deepEqual(
    folderFormatOfPaths(['outs/filtered_feature_bc_matrix/matrix.mtx.gz', 'outs/filtered_feature_bc_matrix.h5', 'outs/analysis/umap/2_components/projection.csv']),
    { format: 'tenx-outs', layout: 'folder' }
  );
  assert.deepEqual(folderFormatOfPaths(['filtered_gene_bc_matrices_h5.h5']), { format: 'tenx-outs', layout: 'folder' });
  // A MatrixMarket folder: a .mtx file, whatever its producer named it (its
  // lists are the transcoder's to pair, a missing one refused by name).
  assert.deepEqual(folderFormatOfPaths(['GSE1/GSM1_matrix.mtx.gz', 'GSE1/GSM1_barcodes.tsv.gz']), { format: 'mtx', layout: 'folder' });
  assert.deepEqual(folderFormatOfPaths(['d/GSM1_RNA_3P-matrix.mtx.gz', 'd/GSM1_RNA_3P-features.tsv.gz']), { format: 'mtx', layout: 'folder' });
  assert.deepEqual(folderFormatOfPaths(['GSM1_count_matrix.mtx', 'GSM1_all_genes.csv']), { format: 'mtx', layout: 'folder' });
  assert.deepEqual(folderFormatOfPaths(['GSE158055/GSE158055_covid19_counts.mtx.gz', 'GSE158055/GSE158055_covid19_features.tsv.gz']), { format: 'mtx', layout: 'folder' });
  assert.deepEqual(folderFormatOfPaths(['k/cells_x_genes.MTX']), { format: 'mtx', layout: 'folder' }, 'compared without case');
  assert.deepEqual(folderFormatOfPaths(['GSE1/GSM1_matrix.mtx.gz']), { format: 'mtx', layout: 'folder' }, 'a matrix alone: refused naming its missing lists');
  assert.equal(folderFormatOfPaths(['d/notes.mtx.txt', 'd/.mtx']), null, 'an ending, not a part of a name');
  // A sci-RNA-seq3 matrix under a .txt name (GEO GSE119945) on this computer,
  // as from a link; any other .txt is no matrix.
  assert.deepEqual(
    folderFormatOfPaths(['GSE119945/GSE119945_gene_count.txt.gz', 'GSE119945/GSE119945_cell_annotate.csv.gz', 'GSE119945/GSE119945_gene_annotate.csv.gz']),
    { format: 'mtx', layout: 'folder' }
  );
  assert.deepEqual(folderFormatOfPaths(['m/GSE1_gene_count.run_13.TXT']), { format: 'mtx', layout: 'folder' }, 'a part, compared without case');
  assert.equal(folderFormatOfPaths(['d/GSE131907_Lung_Cancer_raw_UMI_matrix.txt.gz', 'd/notes.txt']), null);
  assert.equal(folderFormatOfPaths(['cells/notes.txt', 'cells/a/b.csv']), null);
  assert.equal(folderFormatOfPaths([]), null);
});

test('the first bytes decide the layout and container whatever the name says', () => {
  const hdf5 = Uint8Array.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  assert.deepEqual(layoutOfHead(hdf5), { layout: 'file', container: 'hdf5' });
  assert.deepEqual(layoutOfHead(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 9])), { layout: 'zip', container: 'zarr' });
  assert.deepEqual(layoutOfHead(Uint8Array.from([0x50, 0x4b, 0x05, 0x06])), { layout: 'zip', container: 'zarr' });
  const userBlock = new Uint8Array(520);
  userBlock.set(hdf5.subarray(0, 8), 512);
  assert.deepEqual(layoutOfHead(userBlock), { layout: 'file', container: 'hdf5' }, 'after a 512-byte user block');
  // Any user block HDF5 allows (a power of two from 512) within the head the
  // HDF5 reader reads first: 4 KiB, 256 KiB; never between them.
  for (const size of [4096, 65536, 262144]) {
    const head = new Uint8Array(size + 8);
    head.set(hdf5.subarray(0, 8), size);
    assert.deepEqual(layoutOfHead(head), { layout: 'file', container: 'hdf5' }, `after a ${size}-byte user block`);
  }
  const between = new Uint8Array(3000 + 8);
  between.set(hdf5.subarray(0, 8), 3000);
  assert.equal(layoutOfHead(between), null, 'not at a power of two');
  assert.equal(layoutOfHead(Uint8Array.from([0x89, 0x48])), null, 'too short to carry a signature');
  assert.equal(layoutOfHead(new TextEncoder().encode('not-an-hdf5-file')), null);
  assert.equal(layoutOfHead(null), null);
});

test('a server may state every format in every layout it arrives in, and nothing else', () => {
  // A folder that is not a Zarr store lists its files (a browser cannot list
  // a folder); a Zarr store folder is listed by its own metadata.
  const served = (kind, layout) => requireServedAnnData({
    file: layout === 'folder'
      ? {
        url: '_cellucid/anndata/x/',
        kind,
        layout,
        ...(INPUT_FORMATS.find(format => format.id === kind)?.container === 'zarr'
          ? {}
          : { files: [{ path: 'matrix.mtx.gz', size: 10, etag: '"a-1"' }] }),
      }
      : { url: '_cellucid/anndata/x', kind, layout, size: 10, etag: '"a-1"' },
    defaults: {},
  }, 'dataset');
  for (const format of INPUT_FORMATS) {
    for (const layout of layoutsOf(format.id)) {
      assert.equal(served(format.id, layout).file.kind, format.id);
    }
  }
  assert.throws(() => served('h5ad', 'zip'), /must name an input format this viewer reads and one of its layouts/);
  assert.throws(() => served('loom-v9', 'file'), /must name an input format/);
});

test('catalogs, drops, the picker and the address bar take exactly the names the registry knows', () => {
  assert.deepEqual(catalogEntryForm('a/b.h5ad'), { format: 'h5ad', layout: 'file' });
  assert.deepEqual(catalogEntryForm('b.zarr.zip'), { format: 'zarr', layout: 'zip' });
  assert.deepEqual(catalogEntryForm('b.zarr/'), { format: 'zarr', layout: 'folder' });
  assert.deepEqual(catalogEntryForm('suo/'), { format: null, layout: 'folder' });
  assert.deepEqual(catalogEntryForm('b.rds'), { format: 'rds', layout: 'file' });
  assert.equal(catalogEntryForm('b.qs'), null);

  assert.equal(localFileLayout({ name: 'cells.h5ad' }), 'file');
  assert.equal(localFileLayout({ name: 'cells.zarr.zip' }), 'zip');
  assert.equal(localFileLayout({ name: 'cells.csv' }), null);

  // A two-part ending is offered by its last part only when that part is an
  // ending of its own (`.zip` covers `.zarr.zip`); otherwise whole
  // (`.rds.gz`), never as a bare `.gz` that would offer every gzip file.
  assert.equal(filePickerAccept(), '.h5ad,.zip,.loom,.h5,.h5mu,.rds.gz,.rds,.rdata.gz,.rda.gz,.rdata,.rda,.h5seurat,.cellucid-library,.h5ad.gz,.loom.gz,.h5.gz,.h5mu.gz');
  assert.ok(!filePickerAccept().split(',').includes('.gz'));
  assert.deepEqual(localFileLayout({ name: 'GSM1_seurat.rds.gz' }), 'file');
  assert.deepEqual(openableNamePhrases(), [
    '.h5ad file', '.loom file', '.h5 file', '.h5mu file', '.rds file', '.rda/.rdata file',
    '.zarr folder', 'Cell Ranger outs/ folder', 'MatrixMarket folder',
    '.zarr.zip archive',
  ]);

  const fake = { get: () => null, resolve: () => ({ provider: { id: 'url' } }) };
  for (const format of INPUT_FORMATS) {
    for (const [layout, names] of Object.entries(format.names)) {
      for (const name of names) {
        const route = routeAddress(`https://example.org/data/x${name}${layout === 'folder' ? '/' : ''}`, { registry: fake });
        assert.equal(route.kind, 'link', `${name} is linked data`);
      }
    }
  }
  assert.equal(routeAddress('https://example.org/data/x.qs', { registry: fake }).kind, 'ask');
});

test('the Open data info tips name every format ending the registry knows', () => {
  const text = ['open-data', 'local-files', 'data-address']
    .flatMap(key => INFO_TIPS[key].body.map(block => (typeof block === 'string' ? block : block.list.join('\n'))))
    .join('\n');
  for (const format of INPUT_FORMATS) {
    for (const names of Object.values(format.names)) {
      // A format known by its content or its files has no ending: its name is.
      const named = names.length === 0
        ? text.includes(format.label)
        : names.some(name => text.includes(`\`${name}`));
      assert.ok(named, `${format.id}: the tips name ${names.length === 0 ? format.label : names.join(' or ')}`);
    }
  }
});

/** Every `.js` file below `assets/js`, relative to the repository. */
async function appModules(directory = path.join(ROOT, 'assets/js')) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await appModules(full));
    else if (entry.name.endsWith('.js')) found.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
  return found;
}

test('no module but the registry tests a name against a format ending', async () => {
  // An ending by its last part when that part is an ending of its own
  // (`.zarr.zip`: `zip`), else whole (`.rds.gz`: `rds.gz`, not every `.gz`).
  const all = [...new Set(INPUT_FORMATS.flatMap(format => Object.values(format.names).flat()))];
  const endings = all.map(name => {
    const last = name.slice(name.lastIndexOf('.'));
    // A dot inside an ending, written plain or escaped in a regular expression.
    return (all.includes(last) ? last : name).slice(1).replace(/\./g, '\\\\?\\.');
  });
  const ending = `(${endings.join('|')})`;
  // A name test: an endsWith/includes/startsWith call on an ending, or a
  // regular expression matching one.
  const rule = new RegExp(
    `(endsWith|includes)\\(\\s*['"\`][^'"\`]*\\.${ending}\\b|\\\\\\.${ending}\\b`,
    'i'
  );
  const offenders = [];
  for (const file of await appModules()) {
    if (file === 'assets/js/data/input-formats.js' || file.startsWith('assets/js/formats/')) continue;
    const lines = (await readFile(path.join(ROOT, file), 'utf8')).split('\n');
    lines.forEach((line, index) => {
      const code = line.replace(/^\s*(\*|\/\/).*$/, '');
      if (rule.test(code)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'Ask data/input-formats.js instead');
});

test('the retired per-format sources and schemes are gone', async () => {
  const retired = /\b(h5ad|zarr):\/\/|H5adDataSource|ZarrDataSource|isH5adFile|isZarrDirectory|isZarrZipArchive|openAnnDataStore/;
  const offenders = [];
  for (const file of await appModules()) {
    const text = await readFile(path.join(ROOT, file), 'utf8');
    if (retired.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
  for (const gone of ['assets/js/data/h5ad.js', 'assets/js/data/zarr.js']) {
    await assert.rejects(readFile(path.join(ROOT, gone)), { code: 'ENOENT' });
  }
});

test('the Link or server tip names every link provider the registry holds', async () => {
  // The tip was written by hand and fell behind the registry (Figshare,
  // Google Drive and OneDrive were missing): every provider a pasted link can
  // reach is named, by the label the registry gives it.
  const { DEFAULT_PROVIDERS } = await import('../assets/js/data/sources/registry.js');
  const text = INFO_TIPS['data-address'].body
    .map(block => (typeof block === 'string' ? block : block.list.join('\n')))
    .join('\n');
  for (const provider of DEFAULT_PROVIDERS) {
    // A plain web address is the bullets about addresses, not a name.
    if (provider.id === 'url') continue;
    assert.ok(text.includes(provider.label), `the data-address tip names ${provider.label}`);
  }
});

test('a folder on this computer and a listing on a host tell a MatrixMarket matrix by the same names', async () => {
  const { matrixMarketFileSets } = await import('../assets/js/data/matrix-market-files.js');
  const { matrixMarketSets } = await import('../assets/js/data/anndata/transcode/matrix-market.js');
  const names = [
    'matrix.mtx.gz', 'GSM1_matrix.mtx.gz', 'GSE158055_covid19_counts.mtx.gz', 'GSM1_count_matrix.MTX', 'cells_x_genes.mtx',
    'GSE119945_gene_count.txt.gz', 'GSE228590_gene_count.run_13.mtx.gz', 'GSE1_gene_count.run_2.txt',
    'GSE131907_Lung_Cancer_raw_UMI_matrix.txt.gz', 'notes.mtx.txt', 'barcodes.tsv.gz', 'GSE1_cell_annotate.csv.gz',
  ];
  for (const name of names) {
    const local = folderFormatOfPaths([`d/${name}`])?.format === 'mtx';
    // The transcoder of a picked folder and a host's listing (GEO) each name
    // the matrix, as a set or as a problem saying what it lacks.
    const transcoder = matrixMarketSets(new Map([[`d/${name}`, {}]])).some(set => set.matrix === `d/${name}`);
    const listing = matrixMarketFileSets([name]);
    const listed = [...listing.sets, ...listing.problems].some(item => item.matrix === name) || /^(cells_x_genes|quants_mat)\./i.test(name);
    assert.equal(transcoder, local, `${name}: the transcoder and the folder rule`);
    assert.equal(listed, local, `${name}: a listing and the folder rule`);
  }
});

test('the single files Cellucid opens are named in one sentence, the packages\' too', () => {
  // cellucid-python's openable_files_text() and cellucid-r's .openable_files_text()
  // pin the same words: each refuses a file it does not open with them (R9Y-4).
  assert.equal(
    openableNamesText({ layouts: ['file', 'zip'] }),
    'an .h5ad file, a .loom file, an .h5 file, an .h5mu file, an .rds file, an .rda/.rdata file or a .zarr.zip archive'
  );
});
