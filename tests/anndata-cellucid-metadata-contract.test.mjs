/**
 * What a Cellucid-ready AnnData file says about itself (`uns['cellucid']`):
 * how it is checked (`data/anndata-cellucid-metadata.js`) and how the
 * adapter applies it to the dataset identity and the launch defaults. The
 * fixtures are written by `scripts/generate-cellucid-ready-fixtures.py`.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CELLUCID_UNS_SCHEMA,
  isPortableDatasetId,
  requireCellucidFileMetadata,
} from '../assets/js/data/anndata-cellucid-metadata.js';
import { H5adDataSource } from '../assets/js/data/h5ad.js';
import { ZarrDataSource } from '../assets/js/data/zarr.js';

const FIXTURES = new URL('./fixtures/cellucid-ready/', import.meta.url);

function fixtureFile(name) {
  return new File([readFileSync(new URL(name, FIXTURES))], name);
}

function quiet(t) {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  t.after(() => {
    console.log = log;
    console.warn = warn;
  });
}

test('a file without uns[\'cellucid\'] states nothing', () => {
  assert.deepEqual(requireCellucidFileMetadata(null, 'h5ad'), {
    id: null, name: null, description: null, citation: null, source: null, defaults: {}, outlierQuantiles: null,
  });
});

test('every key is read as it is stored, and a single text may be a one-element list', () => {
  const metadata = requireCellucidFileMetadata({
    schema: 1,
    id: ['atlas-1'],
    name: 'Atlas',
    description: '',
    citation: { text: ['Doe 2026'], url: 'https://doi.org/10.1/x' },
    source: { name: 'Lab' },
    defaults: { embedding2d: ['X_umap'], obsKeys: ['cell_type'], embedding3d: { key: 'X_pca', columns: [0, 1, 2] } },
    session: { anything: 'is never read' },
  }, 'h5ad');
  assert.equal(CELLUCID_UNS_SCHEMA, 1);
  assert.equal(metadata.id, 'atlas-1');
  assert.equal(metadata.name, 'Atlas');
  assert.equal(metadata.description, '');
  assert.deepEqual(metadata.citation, { text: 'Doe 2026', url: 'https://doi.org/10.1/x' });
  assert.deepEqual(metadata.source, { name: 'Lab', url: null });
  assert.deepEqual(metadata.defaults, {
    embedding2d: 'X_umap',
    obsKeys: ['cell_type'],
    embedding3d: { key: 'X_pca', columns: [0, 1, 2] },
  });
  // Every key is optional.
  assert.equal(requireCellucidFileMetadata({}, 'h5ad').id, null);
});

test('a key not in the contract, or a value of the wrong shape, refuses the file with a clear message', () => {
  const refusals = [
    [{ colour: 'blue' }, /unknown key 'colour'/],
    [{ schema: 2 }, /schema.*this viewer reads schema 1, so open the file in a newer Cellucid/],
    [{ schema: 0 }, /this viewer reads schema 1/],
    [{ id: 'with/slash' }, /1 to 180 ASCII letters/],
    [{ id: '.hidden' }, /starting with a letter or digit/],
    [{ id: 'ends.' }, /not ending with '\.'/],
    [{ id: ['a', 'b'] }, /non-empty text/],
    [{ name: '' }, /non-empty text/],
    [{ name: ' padded' }, /white space/],
    [{ name: 'zero​width' }, /no glyph/],
    [{ citation: { url: 'https://x.org' } }, /citation'\]\['text'\]/],
    [{ citation: { text: 'x', url: 'ftp://x.org' } }, /http\(s\) address/],
    [{ citation: { text: 'x', doi: '10.1' } }, /unknown key 'doi'/],
    [{ source: { name: 'Lab', homepage: 'x' } }, /unknown key 'homepage'/],
    [{ source: 'Lab' }, /must be a mapping/],
    [{ defaults: ['X_umap'] }, /defaults'\] must be a mapping/],
  ];
  for (const [value, message] of refusals) {
    assert.throws(
      () => requireCellucidFileMetadata(value, 'h5ad'),
      error => {
        assert.match(error.message, message);
        assert.match(error.message, /cellucid\.prepare\(\)|cellucid_prepare\(\)/);
        assert.equal(error.details?.explained, true);
        return true;
      },
      JSON.stringify(value)
    );
  }
});

test('the portable id rule is the writers\' dataset id rule', () => {
  for (const id of ['suo', 'Atlas_2.v1', 'a-b', '9', 'x'.repeat(180)]) assert.equal(isPortableDatasetId(id), true, id);
  for (const id of ['', 'x'.repeat(181), '-a', '_a', 'a b', 'a/b', 'é', 'a.', null, 3]) {
    assert.equal(isPortableDatasetId(id), false, String(id));
  }
});

test('an opened file is identified, named, described, cited and sourced by uns[\'cellucid\']', async t => {
  quiet(t);
  for (const [label, open] of [
    ['h5ad', async () => {
      const source = new H5adDataSource();
      await source.loadFromFile(fixtureFile('ready.h5ad'), {
        showProgress: false,
        preferFileName: true,
        source: { name: 'H5AD file', filename: 'ready.h5ad' },
      });
      return source;
    }],
    ['zarr.zip', async () => {
      const source = new ZarrDataSource();
      await source.loadFromArchiveFile(fixtureFile('ready.zarr.zip'), {
        showProgress: false,
        preferFileName: true,
        source: { name: 'Zarr ZIP archive', filename: 'ready.zarr.zip' },
      });
      return source;
    }],
  ]) {
    await t.test(label, async () => {
      const source = await open();
      t.after(() => source.clear());
      assert.equal(source.datasetId, 'tiny-ready', 'the file\'s id is the dataset id');
      const metadata = await source.getMetadata('tiny-ready');
      assert.equal(metadata.id, 'tiny-ready');
      assert.equal(metadata.name, 'Tiny ready dataset', 'uns[\'cellucid\'][\'name\'] over uns[\'title\']');
      assert.equal(metadata.description, 'Six cells written for the Cellucid web contract tests.');
      assert.deepEqual(metadata.citation, { text: 'Doe et al. 2026', url: 'https://doi.org/10.0000/tiny' });
      assert.equal(metadata.source.name, 'Example lab');
      assert.equal(metadata.source.url, 'https://example.org/tiny');
      assert.equal(metadata.source.filename, label === 'h5ad' ? 'ready.h5ad' : 'ready.zarr.zip');
      // The file's defaults: X_umap in 2D, and only `cluster` listed.
      const adapter = source.getAdapter();
      assert.deepEqual(adapter._defaults.obsKeys, ['cluster']);
      assert.equal(adapter._defaults.centroidMinPoints, 2);
      assert.deepEqual(metadata.obs_fields.map(field => field.key), ['cluster']);
      assert.equal(metadata.embeddings.defaults['2d'], 'X_umap');
    });
  }
});

test('a caller\'s explicit id, name and defaults stand over the file\'s', async t => {
  quiet(t);
  const source = new H5adDataSource();
  t.after(() => source.clear());
  await source.loadFromFile(fixtureFile('ready.h5ad'), {
    showProgress: false,
    datasetId: 'served-id',
    name: 'Served name',
    defaults: { obsKeys: ['score', 'cluster'] },
  });
  const metadata = await source.getMetadata('served-id');
  assert.equal(metadata.id, 'served-id');
  assert.equal(metadata.name, 'Served name');
  // The description is the file's whoever names the dataset.
  assert.equal(metadata.description, 'Six cells written for the Cellucid web contract tests.');
  assert.deepEqual(metadata.obs_fields.map(field => field.key), ['score', 'cluster']);
  // A launch default the caller does not name keeps the file's.
  assert.equal(source.getAdapter()._defaults.centroidMinPoints, 2);
});

test('a file without a name of its own is named by uns[\'title\'] only when it may name itself', async t => {
  quiet(t);
  const source = new H5adDataSource();
  t.after(() => source.clear());
  await source.loadFromFile(fixtureFile('ready.h5ad'), { showProgress: false });
  const metadata = await source.getMetadata('tiny-ready');
  assert.equal(metadata.name, 'ready', 'without preferFileName the caller\'s name (the file name) stands');
});

test('an unknown key in uns[\'cellucid\'] refuses the file when it opens', async t => {
  quiet(t);
  const source = new H5adDataSource();
  t.after(() => source.clear());
  await assert.rejects(
    source.loadFromFile(fixtureFile('unknown-key.h5ad'), { showProgress: false }),
    /uns\['cellucid'\] has unknown key 'colour'/
  );
  assert.equal(source.datasetId, null);
});
