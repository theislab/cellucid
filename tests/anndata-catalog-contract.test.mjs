/**
 * A dataset catalog (`datasets.json`, schema 2) and the AnnData files it
 * lists: the shape it must have (`validateAnnDataCatalog`), how its files are
 * listed from their metadata alone (`AnnDataCatalog.describe`) and opened
 * when chosen (`AnnDataCatalog.open`).
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AnnDataCatalog,
  CATALOG_FILENAME,
  CATALOG_SCHEMA,
  catalogEntryForm,
  fetchAnnDataCatalog,
  validateAnnDataCatalog,
} from '../assets/js/data/sources/anndata-catalog.js';
import { serveFixtureHost } from './helpers/fixture-web-host.mjs';

const BASE = 'https://catalog.test/anndata/';
const FIXTURES = new URL('./fixtures/cellucid-ready/', import.meta.url);
const SHA = 'a'.repeat(64);

function quiet(t) {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  t.after(() => {
    console.log = log;
    console.warn = warn;
  });
}

function catalog(datasets, extra = {}) {
  return { schema: 2, default: datasets[0]?.id ?? "none", datasets, ...extra };
}

test('the catalog file and schema', () => {
  assert.equal(CATALOG_FILENAME, 'datasets.json');
  assert.equal(CATALOG_SCHEMA, 2);
});

test('a valid catalog resolves every address below its folder', () => {
  const checked = validateAnnDataCatalog(catalog([
    { id: 'suo', path: 'suo.zarr/', session: { path: 'suo.cellucid-session', bytes: 12, sha256: SHA } },
    { id: 'he', path: 'files/he.h5ad' },
    { id: 'atlas', path: 'cell%20atlas.zarr.zip' },
  ], { default: 'he' }), BASE, 'local-demo');
  assert.equal(checked.default, 'he');
  assert.deepEqual(
    checked.datasets.map(entry => [entry.id, entry.url, entry.name, entry.form.kind, entry.form.layout]),
    [
      ['suo', `${BASE}suo.zarr/`, 'suo.zarr', 'zarr', 'folder'],
      ['he', `${BASE}files/he.h5ad`, 'he.h5ad', 'h5ad', 'file'],
      ['atlas', `${BASE}cell%20atlas.zarr.zip`, 'cell atlas.zarr.zip', 'zarr', 'zip'],
    ]
  );
  assert.deepEqual(checked.datasets[0].session, { url: `${BASE}suo.cellucid-session`, bytes: 12, sha256: SHA });
  assert.equal(checked.datasets[1].session, null);
  assert.equal(catalogEntryForm('x.txt'), null);
});

test('a catalog without a schema is refused with what a catalog must hold', () => {
  assert.throws(
    () => validateAnnDataCatalog({ default: 'suo', datasets: [{ id: 'suo', path: 'suo.h5ad' }] }, BASE, 'link'),
    error => {
      assert.equal(
        error.message,
        "Invalid datasets.json: the catalog is missing 'schema'; it must hold 'schema', 'default', 'datasets'."
      );
      assert.equal(error.details.explained, true);
      return true;
    }
  );
});

test('every other malformed catalog is refused before anything is read', () => {
  const entry = { id: 'suo', path: 'suo.h5ad' };
  const refusals = [
    [{ schema: 3, default: 'suo', datasets: [entry] }, /schema is 3.*newer Cellucid/],
    [{ schema: 2, datasets: [entry] }, /missing 'default'/],
    [{ schema: 2, default: 'suo', datasets: [entry], extra: 1 }, /unknown key 'extra'/],
    [catalog([]), /datasets must list one dataset or more/],
    [{ schema: 2, default: 'he', datasets: [entry] }, /default "he" must be the id of a listed dataset/],
    [catalog([{ ...entry, name: 'Suo' }]), /unknown key 'name'/],
    [catalog([{ id: 'a/b', path: 'a.h5ad' }]), /1 to 180 ASCII letters/],
    [catalog([entry, { id: 'suo', path: 'b.h5ad' }]), /listed twice/],
    [catalog([entry, { id: 'b', path: 'suo.h5ad' }]), /path is listed twice/],
    [catalog([{ id: 'x', path: '../x.h5ad' }]), /without '\.' or '\.\.'/],
    [catalog([{ id: 'x', path: '/x.h5ad' }]), /relative address/],
    [catalog([{ id: 'x', path: 'https://elsewhere.test/x.h5ad' }]), /relative address/],
    [catalog([{ id: 'x', path: 'x.h5ad?v=1' }]), /relative address/],
    [catalog([{ id: 'x', path: 'cell atlas.h5ad' }]), /relative address/],
    [catalog([{ id: 'x', path: 'a%2Fb.h5ad' }]), /canonically/],
    [catalog([{ id: 'x', path: 'x.csv' }]), /Zarr store folder.*\.h5ad file.*\.zarr\.zip/],
    [catalog([{ ...entry, session: { path: 'a.json', bytes: 1, sha256: SHA } }]), /\.cellucid-session file/],
    [catalog([{ ...entry, session: { path: 'a.cellucid-session', bytes: 0, sha256: SHA } }]), /exact positive byte length/],
    [catalog([{ ...entry, session: { path: 'a.cellucid-session', bytes: 1, sha256: SHA.toUpperCase() } }]), /lowercase SHA-256/],
    [catalog([{ ...entry, session: { path: 'a.cellucid-session', bytes: 1 } }]), /missing 'sha256'/],
  ];
  for (const [value, message] of refusals) {
    assert.throws(() => validateAnnDataCatalog(value, BASE, 'link'), message, JSON.stringify(value));
  }
});

test('a folder without datasets.json is NOT_FOUND, for its caller to explain', async t => {
  serveFixtureHost(t, { prefix: BASE, root: FIXTURES });
  await assert.rejects(
    fetchAnnDataCatalog(BASE, 'link', null),
    error => {
      // The sample catalog and a link explain a missing catalog differently
      // (link-source.js gives link advice), so the shared fetch does not.
      assert.equal(error.code, 'NOT_FOUND');
      return true;
    }
  );
});

test('listing reads each file\'s metadata and uns only; choosing one opens it', async t => {
  quiet(t);
  // One entry: a failing listing aborts the reads of its siblings, which is
  // the formats packages' cancellation to test, not this contract's.
  const document = catalog([
    { id: 'packed', path: 'ready.zarr.zip' },
  ]);
  const host = serveFixtureHost(t, {
    prefix: BASE,
    root: FIXTURES,
    files: new Map([['datasets.json', JSON.stringify(document)]]),
  });
  const checked = await fetchAnnDataCatalog(BASE, 'local-demo', null);
  const owner = new AnnDataCatalog({ baseUrl: BASE, catalog: checked, sourceType: 'local-demo', sourceName: 'Samples' });
  t.after(() => owner.close());
  // The zipped store states the id 'tiny-ready' but is listed as 'packed'.
  await assert.rejects(
    owner.describe(null),
    /Dataset 'packed' \(ready\.zarr\.zip\) cannot be listed: .*states the id 'tiny-ready'/
  );

  const single = new AnnDataCatalog({
    baseUrl: BASE,
    catalog: validateAnnDataCatalog(catalog([{ id: 'tiny-ready', path: 'ready.zarr/' }]), BASE, 'local-demo'),
    sourceType: 'local-demo',
    sourceName: 'Samples',
  });
  t.after(() => single.close());
  host.requests.length = 0;
  const [summary] = await single.describe(null);
  assert.deepEqual(summary, {
    id: 'tiny-ready',
    name: 'Tiny ready dataset',
    description: 'Six cells written for the Cellucid web contract tests.',
    stats: { n_cells: 6, n_genes: 3 },
  });
  // Metadata and uns only: no matrix chunk, no obs column, no obsm array.
  const read = host.requests.map(request => request.url.slice(BASE.length));
  assert.ok(read.includes('ready.zarr/.zmetadata'));
  // A `.zarray`/`.zattrs`/`.zgroup`/`zarr.json` describes an array; a chunk
  // is its data.
  assert.deepEqual(
    read.filter(path => /^ready\.zarr\/(X|layers|obs|obsm|obsp|var|varm|varp)\//.test(path))
      .filter(path => !/\/(\.zarray|\.zattrs|\.zgroup|zarr\.json)$/.test(path)),
    [],
    read.join(', ')
  );

  assert.equal(single.openedSource('tiny-ready'), null);
  const { source, metadata } = await single.open('tiny-ready');
  assert.equal(metadata.id, 'tiny-ready');
  assert.equal(metadata.name, 'Tiny ready dataset');
  assert.equal(metadata.source.name, 'Example lab');
  assert.equal(single.openedSource('tiny-ready'), source);
  assert.equal(source.getBaseUrl('tiny-ready'), 'zarr://tiny-ready/');
  assert.strictEqual(await single.open('tiny-ready').then(opened => opened.source), source, 'opened once');
  single.releaseExcept(null);
  assert.equal(single.openedSource('tiny-ready'), null);
});

test('a dataset being opened is listed from its opening, not read a second time', async t => {
  quiet(t);
  const host = serveFixtureHost(t, { prefix: BASE, root: FIXTURES });
  const owner = new AnnDataCatalog({
    baseUrl: BASE,
    catalog: validateAnnDataCatalog(catalog([{ id: 'tiny-ready', path: 'ready.zarr/' }]), BASE, 'local-demo'),
    sourceType: 'local-demo',
    sourceName: 'Samples',
  });
  t.after(() => owner.close());
  const opening = owner.open('tiny-ready');
  const listing = owner.describe(null);
  const { metadata } = await opening;
  const metadataReads = host.requests.filter(request => request.url.endsWith('/.zmetadata')).length;
  const [summary] = await listing;
  assert.equal(host.requests.filter(request => request.url.endsWith('/.zmetadata')).length, metadataReads);
  assert.equal(metadataReads, 1, 'the store is opened once');
  assert.deepEqual(summary, {
    id: 'tiny-ready',
    name: metadata.name,
    description: 'Six cells written for the Cellucid web contract tests.',
    stats: { n_cells: 6, n_genes: 3 },
  });
});

test('an .h5ad listed in a catalog is read in place with range requests', async t => {
  quiet(t);
  serveFixtureHost(t, { prefix: BASE, root: FIXTURES });
  const owner = new AnnDataCatalog({
    baseUrl: BASE,
    catalog: validateAnnDataCatalog(catalog([{ id: 'tiny-ready', path: 'ready.h5ad' }]), BASE, 'link'),
    sourceType: 'link',
    sourceName: 'catalog.test',
  });
  t.after(() => owner.close());
  const [summary] = await owner.describe(null);
  assert.equal(summary.stats.n_cells, 6);
  const { metadata } = await owner.open('tiny-ready');
  assert.equal(metadata.id, 'tiny-ready');
  assert.equal(metadata.source.url, 'https://example.org/tiny');
  assert.equal(metadata.source.filename, 'ready.h5ad');
});

test('a file stating another id than its catalog entry is refused when opened', async t => {
  quiet(t);
  serveFixtureHost(t, { prefix: BASE, root: FIXTURES });
  const owner = new AnnDataCatalog({
    baseUrl: BASE,
    catalog: validateAnnDataCatalog(catalog([{ id: 'tiny-ready', path: 'other-id.h5ad' }]), BASE, 'link'),
    sourceType: 'link',
    sourceName: 'catalog.test',
  });
  t.after(() => owner.close());
  await assert.rejects(owner.open('tiny-ready'), /lists other-id\.h5ad as dataset 'tiny-ready', but the file states the id\s+'other-dataset'/);
  assert.equal(owner.openedSource('tiny-ready'), null);
});

test('the entries are listed from datasets.json itself, before any file is read', async t => {
  quiet(t);
  const host = serveFixtureHost(t, { prefix: BASE, root: FIXTURES });
  const owner = new AnnDataCatalog({
    baseUrl: BASE,
    catalog: validateAnnDataCatalog(catalog([
      { id: 'tiny-ready', path: 'ready.zarr/' },
      { id: 'other', path: 'cell%20atlas.h5ad' },
    ]), BASE, 'local-demo'),
    sourceType: 'local-demo',
    sourceName: 'Samples',
  });
  t.after(() => owner.close());
  assert.deepEqual(owner.entries(), [
    { id: 'tiny-ready', name: 'ready' },
    { id: 'other', name: 'cell atlas' },
  ]);
  assert.equal(host.requests.length, 0);
});

test('an opening stops once no caller wants it, and stays once it has opened', async t => {
  quiet(t);
  serveFixtureHost(t, { prefix: BASE, root: FIXTURES });
  const owner = new AnnDataCatalog({
    baseUrl: BASE,
    catalog: validateAnnDataCatalog(catalog([{ id: 'tiny-ready', path: 'ready.zarr/' }]), BASE, 'local-demo'),
    sourceType: 'local-demo',
    sourceName: 'Samples',
  });
  t.after(() => owner.close());

  // Two dataset changes want it; the first is replaced, the second is not.
  const first = new AbortController();
  const second = new AbortController();
  const shared = owner.open('tiny-ready', first.signal);
  assert.equal(owner.open('tiny-ready', second.signal), shared);
  first.abort();
  const { metadata } = await shared;
  assert.equal(metadata.id, 'tiny-ready');
  // Opened: a later abort of the change that opened it changes nothing.
  second.abort();
  assert.equal(await owner.open('tiny-ready', null), await shared);
  owner.releaseExcept(null);

  // The only caller is replaced while it opens: it stops, and choosing it
  // again opens it afresh.
  const replaced = new AbortController();
  const stopped = owner.open('tiny-ready', replaced.signal);
  replaced.abort();
  await assert.rejects(stopped, error => error?.name === 'AbortError');
  const again = await owner.open('tiny-ready', new AbortController().signal);
  assert.equal(again.metadata.id, 'tiny-ready');
});
