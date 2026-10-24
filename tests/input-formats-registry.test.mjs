/**
 * The input format registry (`assets/js/data/input-formats.js`) is the one
 * place that knows what a file or folder is from its name or its first
 * bytes. This suite pins it four ways:
 *
 * - `tests/fixtures/input-formats.json` is its document byte for byte, and
 *   cellucid-python (`src/cellucid/input_formats.json`) and cellucid-r
 *   (`tests/testthat/fixtures/input_formats.json`) keep the same bytes,
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
  INPUT_FORMATS,
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
const INPUT_FORMATS_SHA256 = '926cbd0c4690e2b9e2616e088141ba06c5a54c35d41f94adbaf6bbf89b31208b';

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
  assert.equal(fileFormatOfName('a.rds'), null);
  assert.equal(fileFormatOfName('a.h5ad.gz'), null);
  assert.equal(fileFormatOfName('a.zarr'), null, 'a folder name is not a file name');
  assert.deepEqual(folderFormatOfName('atlas.zarr'), { format: 'zarr', layout: 'folder' });
  assert.deepEqual(folderFormatOfName('/a/b/atlas.ZARR/'), { format: 'zarr', layout: 'folder' });
  assert.equal(folderFormatOfName('atlas'), null);
  assert.deepEqual(compressedFormatOfName('x.h5ad.gz'), { format: 'h5ad', layout: 'file' });
  assert.equal(compressedFormatOfName('x.h5ad'), null);

  assert.equal(titleOfName('atlas.h5ad'), 'atlas');
  assert.equal(titleOfName('atlas.zarr.zip'), 'atlas');
  assert.equal(titleOfName('atlas.ZIP'), 'atlas');
  assert.equal(titleOfName('atlas.zarr/'), 'atlas');
  assert.equal(titleOfName('atlas.v2.h5ad'), 'atlas.v2');
  assert.equal(titleOfName('.zarr'), '.zarr', 'nothing would be left');
  assert.equal(titleOfName('notes.txt'), 'notes.txt');
  // The ids every session saved on a dataset that states none records.
  assert.equal(defaultDatasetIdOf('h5ad', 'pbmc.h5ad'), 'h5ad_pbmc');
  assert.equal(defaultDatasetIdOf('zarr', 'pbmc.zarr.zip'), 'zarr_pbmc');
  assert.equal(defaultDatasetIdOf('zarr', 'pbmc.zarr'), 'zarr_pbmc');
  assert.equal(readsFromHead({ format: 'h5ad', layout: 'file' }), true);
  assert.equal(readsFromHead({ format: 'zarr', layout: 'zip' }), false);
  assert.equal(readsFromHead(null), false);
});

test('a folder is a store by its name or by a marker file anywhere below it', () => {
  assert.deepEqual(folderFormatOfPaths(['cells.zarr/X/0']), { format: 'zarr', layout: 'folder' });
  assert.deepEqual(folderFormatOfPaths(['cells/.zgroup']), { format: 'zarr', layout: 'folder' });
  assert.deepEqual(folderFormatOfPaths(['cells/obs/.zattrs']), { format: 'zarr', layout: 'folder' });
  assert.deepEqual(folderFormatOfPaths(['cells/zarr.json']), { format: 'zarr', layout: 'folder' });
  assert.deepEqual(folderFormatOfPaths(['.zmetadata']), { format: 'zarr', layout: 'folder' });
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
  assert.equal(layoutOfHead(Uint8Array.from([0x89, 0x48])), null, 'too short to carry a signature');
  assert.equal(layoutOfHead(new TextEncoder().encode('not-an-hdf5-file')), null);
  assert.equal(layoutOfHead(null), null);
});

test('a server may state every format in every layout it arrives in, and nothing else', () => {
  const served = (kind, layout) => requireServedAnnData({
    file: layout === 'folder'
      ? { url: '_cellucid/anndata/x/', kind, layout }
      : { url: '_cellucid/anndata/x', kind, layout, size: 10 },
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
  assert.equal(catalogEntryForm('b.rds'), null);

  assert.equal(localFileLayout({ name: 'cells.h5ad' }), 'file');
  assert.equal(localFileLayout({ name: 'cells.zarr.zip' }), 'zip');
  assert.equal(localFileLayout({ name: 'cells.csv' }), null);

  assert.equal(filePickerAccept(), '.h5ad,.zip');
  assert.deepEqual(openableNamePhrases(), ['.h5ad file', '.zarr folder', '.zarr.zip archive']);

  const fake = { get: () => null, resolve: () => ({ provider: { id: 'url' } }) };
  for (const format of INPUT_FORMATS) {
    for (const [layout, names] of Object.entries(format.names)) {
      for (const name of names) {
        const route = routeAddress(`https://example.org/data/x${name}${layout === 'folder' ? '/' : ''}`, { registry: fake });
        assert.equal(route.kind, 'link', `${name} is linked data`);
      }
    }
  }
  assert.equal(routeAddress('https://example.org/data/x.rds', { registry: fake }).kind, 'ask');
});

test('the Open data info tips name every format ending the registry knows', () => {
  const text = ['open-data', 'local-files', 'data-address']
    .flatMap(key => INFO_TIPS[key].body.map(block => (typeof block === 'string' ? block : block.list.join('\n'))))
    .join('\n');
  for (const format of INPUT_FORMATS) {
    for (const names of Object.values(format.names)) {
      assert.ok(names.some(name => text.includes(`\`${name}`)), `${format.id}: the tips name ${names.join(' or ')}`);
    }
  }
});

/** Every `.js` file below `assets/js`, relative to the repository. */
async function appModules(directory = path.join(ROOT, 'assets/js')) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await appModules(full));
    else if (entry.name.endsWith('.js')) found.push(path.relative(ROOT, full));
  }
  return found;
}

test('no module but the registry tests a name against a format ending', async () => {
  const endings = [...new Set(INPUT_FORMATS.flatMap(format => Object.values(format.names).flat()))]
    .map(name => name.slice(name.lastIndexOf('.') + 1));
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
