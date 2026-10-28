/**
 * A dataset catalog (`datasets.json`, schema 2) and the AnnData files it
 * lists: the shape it must have (`validateAnnDataCatalog`), how its files are
 * listed from their metadata alone (`AnnDataCatalog.describe`) and opened
 * when chosen (`AnnDataCatalog.open`).
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
import { openableNamesText } from '../assets/js/data/input-formats.js';

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

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
    checked.datasets.map(entry => [entry.id, entry.url, entry.name, entry.form.format, entry.form.layout]),
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
        "Invalid datasets.json: the catalog must contain exactly: datasets, default, schema (missing: schema)."
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
    [{ schema: 2, datasets: [entry] }, /must contain exactly: datasets, default, schema \(missing: default\)/],
    [{ schema: 2, default: 'suo', datasets: [entry], extra: 1 }, /\(unexpected: extra\)/],
    [catalog([]), /datasets must list one dataset or more/],
    [{ schema: 2, default: 'he', datasets: [entry] }, /default "he" must be the id of a listed dataset/],
    [catalog([{ ...entry, name: 'Suo' }]), /must contain id, path and may also contain session \(unexpected: name\)/],
    [catalog([{ id: 'a/b', path: 'a.h5ad' }]), /1 to 180 ASCII letters/],
    [catalog([entry, { id: 'suo', path: 'b.h5ad' }]), /listed twice/],
    [catalog([entry, { id: 'b', path: 'suo.h5ad' }]), /path is listed twice/],
    [catalog([{ id: 'x', path: '../x.h5ad' }]), /without '\.' or '\.\.'/],
    [catalog([{ id: 'x', path: '/x.h5ad' }]), /relative address/],
    [catalog([{ id: 'x', path: 'https://elsewhere.test/x.h5ad' }]), /relative address/],
    [catalog([{ id: 'x', path: 'x.h5ad?v=1' }]), /relative address/],
    [catalog([{ id: 'x', path: 'cell atlas.h5ad' }]), /relative address/],
    [catalog([{ id: 'x', path: 'a%2Fb.h5ad' }]), /canonically/],
    // Every single-file format the registry opens is named, by the registry.
    [catalog([{ id: 'x', path: 'x.csv' }]), new RegExp(`store folder \\(ending in "/"\\) or ${escape(openableNamesText({ layouts: ['file', 'zip'] }))}`)],
    [catalog([{ ...entry, session: { path: 'a.json', bytes: 1, sha256: SHA } }]), /\.cellucid-session file/],
    [catalog([{ ...entry, session: { path: 'a.cellucid-session', bytes: 0, sha256: SHA } }]), /exact positive byte length/],
    [catalog([{ ...entry, session: { path: 'a.cellucid-session', bytes: 1, sha256: SHA.toUpperCase() } }]), /lowercase SHA-256/],
    [catalog([{ ...entry, session: { path: 'a.cellucid-session', bytes: 1 } }]), /session must contain exactly: bytes, path, sha256 \(missing: sha256\)/],
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
  assert.equal(source.getBaseUrl('tiny-ready'), 'anndata://tiny-ready/');
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

test('a listing given up because another file failed leaves an opening of the same file reading', async t => {
  // The listing reads every file; when one fails it gives up on the others.
  // An opening of a file the listing was still describing waits for the same
  // description, which must not be stopped with the listing.
  quiet(t);
  serveFixtureHost(t, { prefix: BASE, root: FIXTURES });
  const served = globalThis.fetch;
  let release;
  const released = new Promise(resolve => { release = resolve; });
  let reached;
  const reachedFile = new Promise(resolve => { reached = resolve; });
  let held = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/ready.h5ad') && !held) {
      held = true;
      reached();
      await Promise.race([
        released,
        new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true })),
      ]);
    }
    return served(input, init);
  };
  t.after(() => {
    globalThis.fetch = served;
  });
  const owner = new AnnDataCatalog({
    baseUrl: BASE,
    catalog: validateAnnDataCatalog(catalog([
      { id: 'tiny-ready', path: 'ready.h5ad' },
      { id: 'missing', path: 'missing.h5ad' },
    ]), BASE, 'local-demo'),
    sourceType: 'local-demo',
    sourceName: 'Samples',
  });
  t.after(() => owner.close());
  const listing = owner.describe(null);
  listing.catch(() => {});
  await reachedFile;
  const opening = owner.open('tiny-ready');
  await assert.rejects(listing, /Dataset 'missing' \(missing\.h5ad\) cannot be listed/);
  release();
  const { metadata } = await opening;
  assert.equal(metadata.id, 'tiny-ready');
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

test('a catalog file on a host that serves only whole files is never downloaded by the listing; an opening downloads it', async t => {
  quiet(t);
  const bytes = new Uint8Array(readFileSync(new URL('ready.h5ad', FIXTURES)));
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init.method ?? 'GET';
    requests.push({ url, method });
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException('Aborted', 'AbortError');
    // Ranges ignored: every answer is the whole file.
    const headers = { 'Content-Length': String(bytes.length), ETag: '"whole-1"' };
    return new Response(method === 'HEAD' ? null : bytes.slice(), { status: 200, headers });
  };
  t.after(() => { globalThis.fetch = original; });
  const owner = new AnnDataCatalog({
    baseUrl: BASE,
    catalog: validateAnnDataCatalog(catalog([{ id: 'tiny-ready', path: 'ready.h5ad' }]), BASE, 'link'),
    sourceType: 'link',
    sourceName: 'catalog.test',
  });
  t.after(() => owner.close());
  await assert.rejects(owner.describe(null), error => /serves ready\.h5ad only whole .* cannot read what it holds without downloading all of it/.test(error.message));
  const downloads = () => requests.filter(request => request.method === 'GET').length;
  // The probe reads the head once (and stops); no whole download follows.
  assert.ok(downloads() <= 2, `${downloads()} GETs`);
  const before = downloads();
  const { metadata } = await owner.open('tiny-ready');
  assert.equal(metadata.id, 'tiny-ready');
  assert.equal(downloads(), before + 1, 'the opening downloads it, once');
});

test('a listed file that changed on an ETag-less host after it was described fails as changed, and opening it again describes it anew', async t => {
  quiet(t);
  // Larger than the head read beside the probe: opening reads past it.
  const bytes = new Uint8Array(readFileSync(new URL('./browser/fixtures/uint32-categories.h5ad', import.meta.url)));
  let modified = 'Mon, 26 Oct 2026 10:00:00 GMT';
  let probes = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const headers = { 'Last-Modified': modified, 'Accept-Ranges': 'bytes' };
    if (!url.endsWith('/ready.h5ad')) return new Response(null, { status: 404 });
    if ((init.method ?? 'GET') === 'HEAD') {
      probes++;
      return new Response(null, { status: 206, headers: { ...headers, 'Content-Length': String(bytes.length), 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}` } });
    }
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? init.headers?.get?.('Range') ?? '');
    const last = Math.min(bytes.length - 1, Number(end));
    return new Response(bytes.slice(Number(start), last + 1), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${last}/${bytes.length}` } });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const owner = new AnnDataCatalog({
    baseUrl: BASE,
    catalog: validateAnnDataCatalog(catalog([{ id: 'uint32-categories', path: 'ready.h5ad' }]), BASE, 'link'),
    sourceType: 'link',
    sourceName: 'catalog.test',
  });
  t.after(() => owner.close());
  // Described (its probe and head), then replaced on the host before the
  // rest of it is read.
  const changing = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const answer = await changing(input, init);
    if ((init.method ?? 'GET') !== 'HEAD' && probes > 0) modified = 'Tue, 27 Oct 2026 10:00:00 GMT';
    return answer;
  };
  await assert.rejects(owner.open('uint32-categories'), /changed on the host/);
  const described = probes;
  globalThis.fetch = changing;
  const { metadata } = await owner.open('uint32-categories');
  assert.equal(metadata.id, 'uint32-categories');
  assert.ok(probes > described, 'the file was described again');
});
