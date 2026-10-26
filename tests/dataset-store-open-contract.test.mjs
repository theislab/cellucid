/**
 * The one entry that opens a dataset's store (`openDatasetStore` in
 * `data/anndata/open.js`): what a source is is decided from its content
 * first, then from what the caller was told, then from its name; the
 * container is opened, and a layout view (`views/`) presents a root it
 * recognises (`presentStore`), every other root being AnnData as stored.
 * Formats that Phase 1 adds plug in here: a registry entry
 * (`input-formats.js`) and a view or a transcoder.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { openDatasetStore, presentStore } from '../assets/js/data/anndata/open.js';
import { H5AD_FORMAT, ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { INPUT_FORMATS } from '../assets/js/data/input-formats.js';
import { viewGroup } from '../assets/js/data/anndata/views/view-nodes.js';

const FIXTURES = new URL('./browser/fixtures/', import.meta.url);
const H5AD = readFileSync(new URL('data-mapping-full.h5ad', FIXTURES));
const ZARR_ZIP = readFileSync(new URL('data-mapping-full.zarr.zip', FIXTURES));
const OPTIONS = { decodedChunkCacheBytes: 0 };

async function opened(request) {
  const store = await openDatasetStore(request, OPTIONS);
  const summary = { format: store.format, layout: store.layout, readerFormat: store.readerFormat, zarrVersion: store.zarrVersion, name: store.name };
  store.root.close?.();
  return summary;
}

test('a file is what its first bytes say, whatever its name', async () => {
  assert.deepEqual(await opened({ source: { file: new File([H5AD], 'cells.h5ad') } }), {
    format: 'h5ad', layout: 'file', readerFormat: H5AD_FORMAT, zarrVersion: null, name: 'cells.h5ad',
  });
  assert.deepEqual(await opened({ source: { file: new File([ZARR_ZIP], 'cells.zarr.zip') } }), {
    format: 'zarr', layout: 'zip', readerFormat: ZARR_FORMAT, zarrVersion: 2, name: 'cells.zarr.zip',
  });
  // Misnamed both ways: the content decides.
  assert.equal((await opened({ source: { file: new File([H5AD], 'cells.zip') } })).format, 'h5ad');
  const zipNamedH5ad = await opened({ source: { file: new File([ZARR_ZIP], 'cells.h5ad') } });
  assert.deepEqual([zipNamedH5ad.format, zipNamedH5ad.layout], ['zarr', 'zip']);
  // A server's or a catalog's word stands in for a name the content does not overrule.
  assert.equal((await opened({ source: { file: new File([H5AD], 'route-without-ending') }, expect: { format: 'h5ad', layout: 'file' } })).format, 'h5ad');
});

test('a file neither its name nor its bytes place is refused, naming what Cellucid reads', async () => {
  await assert.rejects(
    openDatasetStore({ source: { file: new File(['plain text'], 'notes.txt') } }, OPTIONS),
    error => {
      assert.equal(error.details?.explained, true);
      for (const format of INPUT_FORMATS) assert.ok(error.message.includes(format.label), format.label);
      return true;
    }
  );
  await assert.rejects(openDatasetStore({ source: {} }, OPTIONS), /A dataset source is a file \{file\}/);
});

test('a remote file without a head is placed by its name, without a request', async t => {
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    throw new Error('no network in this test');
  };
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(
    openDatasetStore({ source: { file: { url: 'https://example.org/a.txt', size: 10, name: 'a.txt' } } }, OPTIONS),
    /not a file Cellucid opens/
  );
  assert.equal(fetches, 0, 'placing a file by its name reads nothing');
});

test('a layout view presents a root it recognises; any other root is the container\'s AnnData as stored', async () => {
  const formats = [
    { id: 'test-view', label: 'Test view', container: 'hdf5', access: 'ranges', names: { file: ['.tv'] } },
    ...INPUT_FORMATS,
  ];
  const real = viewGroup({ path: '/', attrs: { marker: 'tv' }, children: new Map(), close: () => { closed++; } });
  let closed = 0;
  const views = {
    'test-view': {
      recognize: root => root.attrs.marker === 'tv',
      view: (root, context) => viewGroup({
        path: '/',
        attrs: { 'encoding-type': 'anndata', 'encoding-version': '0.1.0', from: context.name },
        children: new Map(),
        real: root,
        close: () => root.close(),
      }),
      readerFormat: Object.freeze({ storage: 'HDF5', file: 'Test view' }),
    },
  };
  const presented = await presentStore(real, { container: 'hdf5', layout: 'file', name: 'x.tv' }, { formats, views });
  assert.equal(presented.format, 'test-view');
  assert.equal(presented.root.attrs.from, 'x.tv');
  assert.equal(presented.readerFormat.file, 'Test view');
  presented.root.close();
  assert.equal(closed, 1, 'the view closes the real store');

  const plain = viewGroup({ path: '/', attrs: {}, children: new Map() });
  const stored = await presentStore(plain, { container: 'hdf5', layout: 'file', name: 'x.h5ad' }, { formats, views });
  assert.deepEqual([stored.format, stored.root, stored.readerFormat], ['h5ad', plain, H5AD_FORMAT]);
  assert.equal((await presentStore(plain, { container: 'zarr', layout: 'zip', name: 'x.zarr.zip' })).format, 'zarr');

  const leaky = { ...views, 'test-view': { ...views['test-view'], view: () => viewGroup({ path: '/', attrs: {}, children: new Map() }) } };
  await assert.rejects(
    presentStore(real, { container: 'hdf5', layout: 'file', name: 'x.tv' }, { formats, views: leaky }),
    /must close the store it presents/
  );
});
