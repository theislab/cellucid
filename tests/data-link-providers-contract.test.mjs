import assert from 'node:assert/strict';
import test from 'node:test';

import { HEAD_BYTES } from '../assets/js/formats/io/byte-source.js';

import {
  DEFAULT_PROVIDERS,
  ProviderRegistry,
  getProviderRegistry,
  requireProvider,
} from '../assets/js/data/sources/registry.js';
import cellxgene, { CENSUS_BUCKET_URL } from '../assets/js/data/sources/providers/cellxgene.js';
import geo, {
  geoSupplementaryUrl,
  parseGeoListing,
} from '../assets/js/data/sources/providers/geo.js';
import http, { fileNameOfUrl } from '../assets/js/data/sources/providers/http.js';
import huggingface from '../assets/js/data/sources/providers/huggingface.js';
import zenodo from '../assets/js/data/sources/providers/zenodo.js';
import dropbox from '../assets/js/data/sources/providers/dropbox.js';
import github from '../assets/js/data/sources/providers/github.js';
import { downloadRemoteFile } from '../assets/js/data/sources/remote-file.js';
import { fileFormatOfName, titleOfName } from '../assets/js/data/input-formats.js';
import { fetchCatalogFile, fetchWhenNotBusy } from '../assets/js/data/data-source.js';
import { RETRY_AT_LEAST, RETRY_FOR_MS } from '../assets/js/formats/io/byte-source.js';
import { ResponseClock } from '../assets/js/formats/io/link.js';
import { virtualTime } from './helpers/virtual-time.mjs';

const ID = '0819e386-e7fd-4212-b732-60e468689f89';

/**
 * Replace fetch with one answering from `routes(url, init)`, with real
 * `Response`s: a body, a JSON document or a text, and the answer's headers.
 */
function installFetch(t, routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, cache: init.cache ?? 'default' });
    const answer = routes(String(url), init) ?? { status: 404 };
    const bodiless = init.method === 'HEAD' || [204, 304].includes(answer.status);
    const body = bodiless
      ? null
      : answer.body !== undefined
        ? answer.body.slice()
        : answer.json !== undefined
          ? JSON.stringify(answer.json)
          : answer.text ?? '';
    const response = new Response(body, { status: answer.status, headers: answer.headers ?? {} });
    Object.defineProperty(response, 'url', { value: String(url) });
    return response;
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/** A host serving one file of `size` bytes with HEAD and ranged GET. */
function fileRoute(size, extra = {}) {
  return (url, init) => {
    if (init.method === 'HEAD') return { status: 200, headers: { 'Content-Length': String(size), ...extra } };
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? 'bytes=0-0');
    return { status: 206, headers: { ...extra }, body: new Uint8Array(Math.min(size, Number(end) + 1) - Number(start)) };
  };
}

test('every built-in provider meets the contract and no id repeats', () => {
  const ids = DEFAULT_PROVIDERS.map(provider => requireProvider(provider).id);
  assert.deepEqual(ids, ['cellxgene', 'geo', 'zenodo', 'figshare', 'hf', 'gdrive', 'onedrive', 'dropbox', 'gh', 'url']);
  assert.throws(
    () => new ProviderRegistry([http, http]),
    /already registered/
  );
  assert.throws(
    () => requireProvider({ ...http, capabilities: { ...http.capabilities, private: 'sign-in' } }),
    /sign-in provider needs auth/
  );
  for (const provider of DEFAULT_PROVIDERS) {
    // Google Drive and OneDrive read private files behind a sign-in.
    const signIn = provider.id === 'gdrive' || provider.id === 'onedrive';
    assert.equal(provider.capabilities.private, signIn ? 'sign-in' : 'none', provider.id);
    // Every file GEO and the CELLxGENE Census serve is public: a refusal is
    // their host refusing this network, never a link's permissions.
    assert.equal(provider.capabilities.public, provider.id === 'geo' || provider.id === 'cellxgene', provider.id);
  }
  assert.throws(
    () => requireProvider({ ...http, capabilities: { folders: false, private: 'none', versions: false, write: false } }),
    /capabilities must state folders, private, public, versions and write/
  );
});

test('pasted text and ?data= values resolve to one canonical locator', () => {
  const registry = getProviderRegistry();
  const cases = [
    ['theislab/cellucid-datasets/anndata', 'gh:theislab/cellucid-datasets/anndata'],
    ['owner/repo@dev/catalog', 'gh:owner/repo@dev/catalog'],
    // A github.com link names its branch; shorthand without one reads the
    // default branch (HEAD).
    ['https://github.com/owner/repo/tree/main/catalog', 'gh:owner/repo@main/catalog'],
    ['owner/repo@HEAD/catalog', 'gh:owner/repo/catalog'],
    ['https://raw.githubusercontent.com/owner/repo/dev/x', 'gh:owner/repo@dev/x'],
    ['gh:owner/repo/catalog', 'gh:owner/repo/catalog'],
    // A file link from github.com, and the Raw button's refs/heads form.
    ['https://github.com/owner/repo/blob/main/data/a.h5ad', 'gh:owner/repo@main/data/a.h5ad'],
    // github.com's Raw button (it redirects without CORS), either form.
    ['https://github.com/owner/repo/raw/dev/data/a.h5ad', 'gh:owner/repo@dev/data/a.h5ad'],
    ['https://github.com/owner/repo/raw/refs/heads/dev/a.h5ad', 'gh:owner/repo@dev/a.h5ad'],
    ['https://raw.githubusercontent.com/owner/repo/refs/heads/dev/a.zip', 'gh:owner/repo@dev/a.zip'],
    ['https://raw.githubusercontent.com/owner/repo/refs/tags/v1/x', 'gh:owner/repo@v1/x'],
    [ID, `cellxgene:${ID}`],
    [`https://cellxgene.cziscience.com/e/${ID}.cxg/`, `cellxgene:${ID}`],
    [`cellxgene:${ID.toUpperCase()}`, `cellxgene:${ID}`],
    [`https://cellxgene.cziscience.com/collections/${ID}`, `cellxgene:collection/${ID}`],
    ['gse351300', 'geo:GSE351300'],
    ['geo:GSE351300/counts.h5ad', 'geo:GSE351300/counts.h5ad'],
    ['https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE351300', 'geo:GSE351300'],
    [
      'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE351nnn/GSE351300/suppl/a%20b.h5ad',
      'geo:GSE351300/a b.h5ad',
    ],
    ['https://example.org/data/atlas.h5ad#x', 'https://example.org/data/atlas.h5ad'],
    ['https://example.org/catalog/', 'https://example.org/catalog/'],
    ['hf:lab/atlas', 'hf:lab/atlas'],
    ['hf:lab/atlas@v2/catalog', 'hf:lab/atlas@v2/catalog'],
    ['https://huggingface.co/datasets/lab/atlas/blob/main/a.h5ad', 'hf:lab/atlas/a.h5ad'],
    ['https://huggingface.co/datasets/lab/atlas/tree/v2/catalog', 'hf:lab/atlas@v2/catalog'],
    ['10.5281/zenodo.123', 'zenodo:123'],
    ['https://doi.org/10.5281/zenodo.123', 'zenodo:123'],
    ['https://zenodo.org/records/123/files/a.zip', 'zenodo:123/a.zip'],
    ['zenodo:123', 'zenodo:123'],
    [
      'https://www.dropbox.com/scl/fi/abc/atlas.h5ad?rlkey=k&dl=0',
      'dropbox:https://www.dropbox.com/scl/fi/abc/atlas.h5ad?rlkey=k',
    ],
    // A content-host address pasted is named by its share link too.
    [
      'https://dl.dropboxusercontent.com/s/abc/atlas.h5ad?dl=1',
      'dropbox:https://www.dropbox.com/s/abc/atlas.h5ad',
    ],
  ];
  for (const [input, locator] of cases) {
    assert.equal(registry.resolve(input).locator, locator, input);
    assert.equal(registry.resolve(locator).locator, locator, `${locator} round trip`);
  }
  assert.throws(() => registry.resolve('not a link'), /does not recognise/);
  // Ambiguous short forms belong to a provider only after its scheme: a bare
  // number is not a Zenodo record, `user/repo` stays GitHub's shorthand.
  assert.throws(() => registry.resolve('123'), /does not recognise/);
  assert.equal(registry.resolve('lab/atlas').locator, 'gh:lab/atlas');
  assert.throws(() => registry.resolve('   '), /Paste a link/);
  assert.throws(() => registry.resolve('geo:not-an-accession'), /not a valid NCBI GEO reference/);
});

test('file names and formats are read from the URL, Zenodo-style /content included', () => {
  assert.equal(fileNameOfUrl(new URL('https://zenodo.org/api/records/1/files/x.h5ad/content')), 'x.h5ad');
  assert.equal(fileNameOfUrl(new URL('https://h.org/a/My%20Atlas.h5ad?dl=1')), 'My Atlas.h5ad');
  assert.deepEqual(fileFormatOfName('a.H5AD'), { format: 'h5ad', layout: 'file' });
  assert.deepEqual(fileFormatOfName('a.zarr.zip'), { format: 'zarr', layout: 'zip' });
  assert.deepEqual(fileFormatOfName('a.rds'), { format: 'rds', layout: 'file' });
  assert.equal(fileFormatOfName('a.qs'), null);
  // A file that does not name itself is called by its name without the
  // format's extension, Zarr ZIP included.
  assert.equal(titleOfName('atlas.h5ad'), 'atlas');
  assert.equal(titleOfName('atlas.zarr.zip'), 'atlas');
  assert.equal(titleOfName('atlas.ZIP'), 'atlas');
  assert.equal(titleOfName('atlas.v2.h5ad'), 'atlas.v2');
});

test('a web address opens a dataset catalog folder or one AnnData file', async t => {
  const folder = await http.open('https://example.org/catalog/');
  assert.deepEqual(folder.catalog, { baseUrl: 'https://example.org/catalog/' });
  const catalog = await http.open('https://example.org/catalog/datasets.json');
  assert.deepEqual(catalog.catalog, { baseUrl: 'https://example.org/catalog/' });

  installFetch(t, fileRoute(4096, { ETag: '"v1"' }));
  const opened = await http.open('https://example.org/data/atlas.h5ad');
  assert.deepEqual(opened.file.format, { format: 'h5ad', layout: 'file' });
  assert.equal(opened.file.title, 'atlas');
  assert.equal(opened.file.resource.size, 4096);
  assert.equal(opened.file.resource.identity.version, 'written:4096 etag:"v1"');
  assert.equal(opened.file.resource.etag, '"v1"', 'every read must answer the version the identity names');
  assert.ok(!opened.file.id.includes('/'), 'the id becomes anndata://<id>/');

  await assert.rejects(
    http.open('https://example.org/data/atlas.qs'),
    /not a file Cellucid opens from a link/
  );
});

test('a signed link is one dataset however it is signed: no credential in its id, attribution or kept key', async t => {
  installFetch(t, fileRoute(4096, { ETag: '"v1"' }));
  const signed = signature => `https://bucket.s3.amazonaws.com/data/atlas.h5ad?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA${signature}&X-Amz-Signature=${signature}&X-Amz-Expires=3600&v=2`;
  const first = await http.open(signed('SECRETONE'));
  const again = await http.open(signed('SECRETTWO'));
  assert.equal(first.file.id, again.file.id, 'signed again: the same dataset');
  assert.equal(first.file.resource.identity.key, again.file.resource.identity.key);
  for (const text of [first.file.id, first.file.attribution.url, first.file.resource.identity.key, JSON.stringify(first.attribution)]) {
    assert.ok(!/SECRET|X-Amz-(Signature|Credential)/i.test(decodeURIComponent(text)), text);
  }
  assert.equal(decodeURIComponent(first.file.id), 'url:https://bucket.s3.amazonaws.com/data/atlas.h5ad?v=2', 'other parameters still name the file');
  // The address is read with its credentials, which only the request carries.
  assert.match(first.file.resource.url, /X-Amz-Signature=SECRETONE/);
  // A token or a user name and password in a link: never part of what the file is.
  const tokened = await http.open('https://example.org/data/atlas.h5ad?access_token=ya29.SECRET&token=SECRET');
  assert.equal(decodeURIComponent(tokened.file.id), 'url:https://example.org/data/atlas.h5ad');
  assert.equal(tokened.file.attribution.url, 'https://example.org/data/atlas.h5ad');
  // A Zarr folder by a signed link likewise.
  const folder = await http.open('https://bucket.s3.amazonaws.com/data/atlas.zarr/?X-Amz-Signature=SECRET&sig=SECRET');
  assert.ok(!/SECRET/.test(decodeURIComponent(folder.store.id)) && !/SECRET/.test(folder.store.attribution.url));
  assert.match(folder.store.url, /SECRET/, 'read with its credentials');
});

test('a host that ignores ranges is downloaded whole, with its progress', async t => {
  installFetch(t, (url, init) => (init.method === 'HEAD'
    ? { status: 200, headers: { 'Content-Length': '10' } }
    : { status: 200, headers: { 'Content-Length': '10' }, body: new Uint8Array(10) }));
  const opened = await http.open('https://example.org/a.h5ad');
  assert.equal(opened.file.transport, 'download');
  assert.equal(opened.file.resource.size, 10);
  const received = [];
  const { file } = await downloadRemoteFile(opened.file.resource, { onBytes: bytes => received.push(bytes) });
  assert.equal(file.size, 10);
  assert.equal(file.name, 'a.h5ad');
  assert.equal(received.at(-1), 10);
});

test('an R file its host content-codes even in ranges is downloaded whole, decoded, not refused as CORS', async t => {
  // NCBI's Apache sends GEO's gzip .rds with Content-Encoding: gzip on every
  // answer, ranges included; Chromium cannot decode a range and fails it as a
  // network error. The whole file arrives decoded (an uncompressed R stream).
  const decoded = new Uint8Array([0x58, 0x0a, 0, 0, 0, 3, 0, 4]);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'HEAD') {
      return new Response(null, { status: 206, headers: { 'Content-Range': 'bytes 0-24999/25000', 'Content-Length': '25000' } });
    }
    if (init.headers?.Range) throw new TypeError('Failed to fetch');
    return new Response(decoded.slice(), { status: 200 });
  };
  const opened = await http.open('https://ftp.example.org/geo/GSE1_seurat.rds');
  assert.deepEqual(opened.file.format, { format: 'rds', layout: 'file' });
  assert.equal(opened.file.transport, 'download');
  assert.equal(opened.file.resource.contentCoded, true);
  const { file } = await downloadRemoteFile(opened.file.resource);
  assert.equal(file.size, decoded.length, 'the decoded file, whatever size the host stated');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), decoded);
});

function censusRelease() {
  return {
    status: 200,
    json: {
      stable: '2025-01-30',
      latest: '2025-11-10',
      '2025-11-10': {
        release_build: '2025-11-10',
        h5ads: { relative_uri: '/cell-census/2025-11-10/h5ads/' },
      },
    },
  };
}

test('CELLxGENE opens the Census copy of a dataset at the latest release', async t => {
  const calls = installFetch(t, (url, init) => {
    if (url.endsWith('/cell-census/release.json')) return censusRelease();
    if (url === `${CENSUS_BUCKET_URL}/cell-census/2025-11-10/h5ads/${ID}.h5ad`) {
      return fileRoute(30040170)(url, init);
    }
    return null;
  });
  const opened = await cellxgene.open(ID);
  assert.equal(opened.file.id, `cellxgene:${ID}`);
  assert.equal(opened.file.resource.size, 30040170);
  assert.equal(opened.file.resource.identity.version, 'census:2025-11-10');
  assert.equal(opened.file.attribution.licence, 'CC BY 4.0');
  assert.equal(opened.file.attribution.url, `https://cellxgene.cziscience.com/e/${ID}.cxg/`);
  assert.ok(calls.every(call => Object.keys(call.headers).every(key => key === 'Range')),
    'no request carries a header that would need a preflight');
});

test('CELLxGENE says why a dataset or link cannot be opened', async t => {
  installFetch(t, url => (url.endsWith('/cell-census/release.json') ? censusRelease() : null));
  await assert.rejects(cellxgene.open(ID), /not in the Census release 2025-11-10/);
  await assert.rejects(cellxgene.open(`collection/${ID}`), /choose a dataset/);
  await assert.rejects(cellxgene.open(`version/${ID}`), /"Explore" link/);
});

const GEO_LISTING = `<html><body>
<a href="/geo/series/GSE351nnn/GSE351300/">Parent</a>
<a href="GSE351300_counts.h5ad">GSE351300_counts.h5ad</a>
<a href="GSE351300_RAW.tar">GSE351300_RAW.tar</a>
<a href="https://www.hhs.gov/vulnerability-disclosure-policy/index.html">HHS</a>
</body></html>`;

test('GEO lists a series and opens its one .h5ad, or names the choices', async t => {
  assert.equal(geoSupplementaryUrl('GSE351300'), 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE351nnn/GSE351300/suppl/');
  assert.equal(geoSupplementaryUrl('GSE123'), 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSEnnn/GSE123/suppl/');
  assert.deepEqual(parseGeoListing(GEO_LISTING), ['GSE351300_counts.h5ad', 'GSE351300_RAW.tar']);

  let listing = GEO_LISTING;
  installFetch(t, (url, init) => {
    if (url.endsWith('/suppl/')) return { status: 200, text: listing };
    if (url.endsWith('.h5ad')) return fileRoute(287709670)(url, init);
    if (url.endsWith('.h5ad.gz')) return fileRoute(61584205)(url, init);
    return null;
  });
  const opened = await geo.open('GSE351300');
  assert.equal(opened.file.id, 'geo:GSE351300:GSE351300_counts.h5ad');
  assert.equal(opened.file.resource.size, 287709670);

  listing = GEO_LISTING.replace('</body>', '<a href="GSE351300_b.h5ad">b</a></body>');
  await assert.rejects(geo.open('GSE351300'), /has 2 datasets Cellucid opens.*geo:GSE351300\/GSE351300_counts\.h5ad/);
  // A gzip-compressed copy, as GEO ships many: opened, read whole once.
  listing = '<a href="GSE351300_x.h5ad.gz">x</a>';
  const compressed = await geo.open('GSE351300');
  assert.equal(compressed.file.transport, 'download');
  assert.deepEqual(compressed.file.format, { format: 'h5ad', layout: 'file', compression: 'gzip' });
  assert.equal(compressed.file.title, 'GSE351300 GSE351300_x');
  listing = '<a href="GSE351300_RAW.tar">x</a>';
  await assert.rejects(geo.open('GSE351300'), /no supplementary file Cellucid opens \(it has: GSE351300_RAW\.tar\)/);
});

test('Zenodo opens the one openable file of a record, with the listing\'s size and no probe', async t => {
  const calls = installFetch(t, url => {
    if (url === 'https://zenodo.org/api/records/7') {
      return {
        status: 200,
        json: {
          id: 9,
          conceptrecid: '7',
          doi: '10.5281/zenodo.9',
          metadata: { title: 'Atlas', license: { id: 'cc-by-4.0' } },
          files: [
            { key: 'notes.csv.gz', size: 10, checksum: 'md5:aa' },
            { key: 'atlas.h5ad', size: 4096, checksum: 'md5:bb' },
          ],
        },
      };
    }
    return null;
  });
  const opened = await zenodo.open('7');
  assert.equal(opened.file.resource.url, 'https://zenodo.org/api/records/9/files/atlas.h5ad/content');
  assert.equal(opened.file.resource.size, 4096);
  assert.equal(opened.file.id, 'zenodo:7:atlas.h5ad', 'the concept id follows the deposit across versions');
  assert.equal(opened.file.resource.identity.version, 'zenodo:9:md5:bb');
  assert.equal(opened.file.attribution.citation, 'doi:10.5281/zenodo.9');
  assert.equal(calls.length, 1, 'one request: the record listing');
  await assert.rejects(zenodo.open('7/missing.h5ad'), /no file named missing\.h5ad/);
});

/**
 * A Hugging Face Hub serving `files` (`{path, size, lfs?: {oid, size}, oid?}`)
 * of dataset `lab/atlas` at commit `sha`, as the provider asks it: the
 * revision's commit and licence, `paths-info` (a form POST) for named
 * paths with the commit that last wrote each, and `tree` one level at a
 * commit. Folders' git tree ids are made from what they hold.
 */
function fakeHub(state) {
  const API = 'https://huggingface.co/api/datasets/lab/atlas';
  const folderOid = prefix => {
    let hash = 0x811c9dc5;
    for (const file of state.files) {
      if (!file.path.startsWith(prefix)) continue;
      for (const char of `${file.path}:${file.lfs?.oid ?? file.oid ?? ''}`) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0').repeat(5);
  };
  const entryOf = path => {
    const file = state.files.find(item => item.path === path);
    if (file !== undefined) return { type: 'file', oid: file.oid ?? '0'.repeat(40), size: file.size, ...(file.lfs ? { lfs: file.lfs } : {}), path };
    if (state.files.some(item => item.path.startsWith(`${path}/`))) return { type: 'directory', oid: folderOid(`${path}/`), size: 0, path };
    return null;
  };
  return (url, init) => {
    if (url.startsWith(`${API}/revision/`)) {
      return { status: 200, json: { sha: state.sha, ...(state.license ? { cardData: { license: state.license } } : {}) } };
    }
    if (url.startsWith(`${API}/paths-info/`) && init.method === 'POST') {
      state.asked?.push(url);
      const paths = new URLSearchParams(init.body).getAll('paths');
      return { status: 200, json: paths.map(entryOf).filter(entry => entry !== null).map(entry => ({ ...entry, lastCommit: { id: state.sha } })) };
    }
    const tree = new RegExp(`^${API}/tree/([0-9a-f]{40})(?:/(.*?))?\\?`).exec(url);
    if (tree !== null) {
      const prefix = tree[2] ? `${decodeURIComponent(tree[2])}/` : '';
      const seen = new Map();
      for (const file of state.files) {
        if (!file.path.startsWith(prefix)) continue;
        const rest = file.path.slice(prefix.length);
        const name = rest.split('/')[0];
        const path = `${prefix}${name}`;
        if (!seen.has(path)) seen.set(path, entryOf(path));
      }
      return { status: 200, json: [...seen.values()] };
    }
    return null;
  };
}

test('Hugging Face pins the commit and opens a catalog, a file, or names the choices', async t => {
  const commit = 'a'.repeat(40);
  const calls = installFetch(t, fakeHub({
    sha: commit,
    license: 'cc-by-4.0',
    files: [
      { path: '.gitattributes', size: 10 },
      { path: 'catalog/datasets.json', size: 100 },
      { path: 'one.h5ad', size: 2048, lfs: { oid: 'f'.repeat(64), size: 2048 } },
      { path: 'two.zip', size: 4096, oid: '2'.repeat(40) },
    ],
  }));
  const catalog = await huggingface.open('lab/atlas/catalog');
  assert.equal(catalog.catalog.baseUrl, `https://huggingface.co/datasets/lab/atlas/resolve/${commit}/catalog/`);
  const file = await huggingface.open('lab/atlas/one.h5ad');
  assert.equal(file.file.resource.url, `https://huggingface.co/datasets/lab/atlas/resolve/${commit}/one.h5ad`);
  assert.equal(file.file.resource.size, 2048);
  assert.equal(file.file.attribution.licence, 'cc-by-4.0');
  await assert.rejects(huggingface.open('lab/atlas'), /2 files Cellucid opens.*hf:lab\/atlas\/one\.h5ad, hf:lab\/atlas\/two\.zip/);
  // Only the path asked for, never the repository's listing; a file opens in one round trip.
  assert.ok(calls.every(call => !call.url.includes('blobs=true')), 'no whole-repository listing');
  calls.length = 0;
  await huggingface.open('lab/atlas/one.h5ad');
  assert.deepEqual(calls.map(call => call.method).sort(), ['GET', 'POST'], 'the commit and the path, together');
  await assert.rejects(huggingface.open('lab/atlas/missing.h5ad'), /has no missing\.h5ad/);
});

/** GitHub's API naming the commit that last wrote a path on a ref (`commits?sha=&path=&per_page=1`). */
function lastCommitRoute(commits) {
  return url => {
    const asked = new URL(url);
    if (asked.host !== 'api.github.com') return null;
    const sha = commits[asked.searchParams.get('path')];
    return sha === undefined ? { status: 200, json: [] } : { status: 200, json: [{ sha }] };
  };
}

test('GitHub opens a catalog folder, or one file in place at the commit that last wrote it, from LFS when it is stored there', async t => {
  const folder = await github.open('owner/repo/catalog');
  assert.deepEqual(folder.catalog, {
    baseUrl: 'https://raw.githubusercontent.com/owner/repo/HEAD/catalog/',
  });

  const plainCommit = '1'.repeat(40);
  const bigCommit = '2'.repeat(40);
  const oid = 'sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393';
  const pointer = new TextEncoder().encode(
    'version https://git-lfs.github.com/spec/v1\n' +
    `oid ${oid}\n` +
    'size 123456789\n'
  );
  const api = lastCommitRoute({ 'data/plain.h5ad': plainCommit, 'data/big.h5ad': bigCommit });
  const calls = installFetch(t, (url, init) => {
    if (url === `https://raw.githubusercontent.com/owner/repo/${plainCommit}/data/plain.h5ad`) {
      return fileRoute(4096)(url, init);
    }
    if (url === `https://raw.githubusercontent.com/owner/repo/${bigCommit}/data/big.h5ad`) {
      return init.method === 'HEAD'
        ? { status: 200, headers: { 'Content-Length': String(pointer.length) } }
        : { status: 206, headers: {}, body: pointer };
    }
    return api(url);
  });

  const plain = await github.open('owner/repo/data/plain.h5ad');
  assert.deepEqual(plain.file.format, { format: 'h5ad', layout: 'file' });
  assert.equal(plain.file.title, 'plain');
  assert.equal(plain.file.resource.url, `https://raw.githubusercontent.com/owner/repo/${plainCommit}/data/plain.h5ad`);
  assert.equal(plain.file.resource.size, 4096);
  assert.equal(plain.file.resource.identity.version, `commit:${plainCommit}`, 'the commit and path name its bytes');
  assert.ok(!plain.file.id.includes('/'), 'the id becomes anndata://<id>/');
  // Two round trips: GitHub's API names the commit (asked now, never a
  // cached answer), then a HEAD whose open range asks for the unencoded
  // length (GitHub Pages states a compressed one otherwise) and, beside it,
  // the file's head, its first read, which opening starts from. Nothing
  // probes ranges: GitHub's hosts serve them.
  assert.deepEqual(
    calls.map(call => [call.method, new URL(call.url).host, call.headers.Range ?? null, call.cache]),
    [
      ['GET', 'api.github.com', null, 'no-cache'],
      ['GET', 'raw.githubusercontent.com', `bytes=0-${HEAD_BYTES - 1}`, 'no-store'],
      ['HEAD', 'raw.githubusercontent.com', 'bytes=0-', 'no-store'],
    ]
  );
  assert.equal(new URL(calls[0].url).searchParams.get('sha'), 'HEAD');
  assert.equal(new URL(calls[0].url).searchParams.get('path'), 'data/plain.h5ad');
  assert.equal(plain.file.resource.head.bytes.length, 4096, 'the whole of a file shorter than its head');

  calls.length = 0;
  const lfs = await github.open('owner/repo/data/big.h5ad');
  assert.equal(lfs.file.resource.url, `https://media.githubusercontent.com/media/owner/repo/${bigCommit}/data/big.h5ad`,
    'the object is read at the commit whose pointer named it');
  assert.equal(lfs.file.resource.size, 123456789, 'the size the pointer states');
  assert.equal(lfs.file.resource.identity.version, oid, 'the object hash names its bytes');
  assert.equal(lfs.file.id, plain.file.id.replace('plain', 'big'));
  // The commit, then the pointer's HEAD and, beside it, its head, which
  // holds the pointer whole; the media host is never probed, and its head is
  // not the pointer's.
  assert.deepEqual(
    calls.map(call => [call.method, new URL(call.url).host]),
    [['GET', 'api.github.com'], ['GET', 'raw.githubusercontent.com'], ['HEAD', 'raw.githubusercontent.com']]
  );
  assert.equal(lfs.file.resource.head, undefined);

  // A link naming a commit is read at it, and asks GitHub's API nothing.
  calls.length = 0;
  const pinned = await github.open(`owner/repo@${plainCommit}/data/plain.h5ad`);
  assert.equal(pinned.file.resource.identity.version, `commit:${plainCommit}`);
  assert.ok(calls.every(call => new URL(call.url).host !== 'api.github.com'));

  // A file a branch does not hold is named, with what to check.
  await assert.rejects(
    github.open('owner/repo@dev/data/missing.h5ad'),
    error => error.code === 'NOT_FOUND' && /missing\.h5ad was not found at raw\.githubusercontent\.com \(HTTP 404\)/.test(error.message)
  );
});

test('a GitHub Zarr folder is read at the commit that last wrote below it: that commit is its version, its address the link\'s', async t => {
  const commit = '3'.repeat(40);
  const calls = installFetch(t, lastCommitRoute({ 'data/atlas.zarr': commit }));
  const folder = await github.open('owner/repo/data/atlas.zarr');
  assert.equal(folder.store.url, `https://raw.githubusercontent.com/owner/repo/${commit}/data/atlas.zarr/`);
  assert.equal(folder.store.version, `commit:${commit}`, 'what it holds there never changes: kept across visits');
  assert.equal(folder.store.key, folder.store.id, 'filed under the link\'s address, so another commit\'s kept objects are stale');
  assert.deepEqual(calls.map(call => new URL(call.url).host), ['api.github.com'], 'one request, before the store\'s metadata');
  // GitHub's API refuses (its hourly limit): read at its ref, with no version (kept for this tab only).
  installFetch(t, url => (new URL(url).host === 'api.github.com' ? { status: 403, json: { message: 'API rate limit exceeded' } } : null));
  const unnamed = await github.open('owner/repo/data/atlas.zarr');
  assert.equal(unnamed.store.url, 'https://raw.githubusercontent.com/owner/repo/HEAD/data/atlas.zarr/');
  assert.equal(unnamed.store.version, undefined);
  assert.equal(unnamed.store.key, undefined);
});

test('a GitHub file changed by a push is a new version; one the push left alone keeps its own', async t => {
  let commit = 'a'.repeat(40);
  let oid = `sha256:${'b'.repeat(64)}`;
  const pointer = () => new TextEncoder().encode(`version https://git-lfs.github.com/spec/v1\noid ${oid}\nsize 9000\n`);
  installFetch(t, (url, init) => {
    const asked = new URL(url);
    if (asked.host === 'api.github.com') return { status: 200, json: [{ sha: commit }] };
    if (url === `https://raw.githubusercontent.com/o/r/${commit}/a.h5ad`) return fileRoute(4096)(url, init);
    if (url === `https://raw.githubusercontent.com/o/r/${commit}/big.h5ad`) {
      return init.method === 'HEAD'
        ? { status: 200, headers: { 'Content-Length': String(pointer().length) } }
        : { status: 206, headers: {}, body: pointer() };
    }
    return null;
  });
  const versions = async () => [
    (await github.open('o/r/a.h5ad')).file.resource.identity.version,
    (await github.open('o/r/big.h5ad')).file.resource.identity.version,
  ];
  const first = await versions();
  assert.deepEqual(await versions(), first, 'opened again unchanged: the same versions');
  // A push that rewrites both: the plain file's last commit and the object both change.
  commit = 'c'.repeat(40);
  oid = `sha256:${'d'.repeat(64)}`;
  const pushed = await versions();
  assert.notEqual(pushed[0], first[0]);
  assert.notEqual(pushed[1], first[1]);
  // A push that leaves the LFS object as it was (another commit, the same pointer): its version stands.
  commit = 'e'.repeat(40);
  assert.equal((await versions())[1], pushed[1]);
});

test('a GitHub file whose commit GitHub\'s API will not name (its hourly limit) is read at its ref with no version', async t => {
  const oid = `sha256:${'b'.repeat(64)}`;
  const pointer = new TextEncoder().encode(`version https://git-lfs.github.com/spec/v1\noid ${oid}\nsize 9000\n`);
  installFetch(t, (url, init) => {
    if (new URL(url).host === 'api.github.com') return { status: 403, json: { message: 'API rate limit exceeded' } };
    if (url === 'https://raw.githubusercontent.com/o/r/HEAD/a.h5ad') return fileRoute(4096, { ETag: '"hidden"' })(url, init);
    if (url === 'https://raw.githubusercontent.com/o/r/HEAD/big.h5ad') {
      return init.method === 'HEAD'
        ? { status: 200, headers: { 'Content-Length': String(pointer.length) } }
        : { status: 206, headers: {}, body: pointer };
    }
    return null;
  });
  const plain = await github.open('o/r/a.h5ad');
  assert.equal(plain.file.resource.url, 'https://raw.githubusercontent.com/o/r/HEAD/a.h5ad');
  assert.equal(plain.file.resource.identity.version, 'size:4096', 'no version: nothing kept of it is used');
  // The pointer and the object, read apart at a moving ref, may be of two versions.
  const lfs = await github.open('o/r/big.h5ad');
  assert.equal(lfs.file.resource.url, 'https://media.githubusercontent.com/media/o/r/HEAD/big.h5ad');
  assert.equal(lfs.file.resource.identity.version, 'size:9000');
});

test('GitHub asks a busy host again, as long as it asks to wait', async t => {
  let busy = 2;
  const calls = installFetch(t, url => {
    if (new URL(url).host === 'api.github.com') return { status: 200, json: [{ sha: 'f'.repeat(40) }] };
    if (busy > 0) {
      busy--;
      return { status: 429, headers: { 'Retry-After': '0' } };
    }
    return { status: 200, headers: { 'Content-Length': '2048' } };
  });
  const opened = await github.open('owner/repo/a.h5ad');
  assert.equal(opened.file.resource.size, 2048);
  // The HEAD and the head read, each answered busy once, each asked again.
  const raw = calls.filter(call => new URL(call.url).host === 'raw.githubusercontent.com');
  assert.equal(raw.length, 4, 'two busy answers, then the size and the head');
  assert.deepEqual(raw.map(call => call.method).sort(), ['GET', 'GET', 'HEAD', 'HEAD']);
});

test('a busy host is asked again, then answered as it is: catalog files included', async t => {
  let busy = 1;
  const calls = installFetch(t, () => {
    if (busy > 0) {
      busy--;
      return { status: 503, headers: { 'Retry-After': '0' } };
    }
    return { status: 200, json: { schema: 2 } };
  });
  const response = await fetchCatalogFile('https://owner.github.io/repo/catalog/datasets.json');
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2, 'one busy answer (GitHub Pages sheds a burst with 503), then the file');

  // A person's "Try again" asks once: the busy answer is theirs to see now,
  // not a schedule of requests running behind the notice they are reading.
  const onceCalls = installFetch(t, () => ({ status: 503, headers: { 'Retry-After': '0' } }));
  const once = await fetchCatalogFile('https://owner.github.io/repo/catalog/datasets.json', undefined, { askOnce: true });
  assert.equal(once.status, 503);
  assert.equal(onceCalls.length, 1, 'one request, answered as it is');
  await assert.rejects(
    fetchCatalogFile('https://owner.github.io/repo/catalog/datasets.json', undefined, { askOnce: 'yes' }),
    /askOnce must be a boolean/
  );

  // Still busy once asked again three times (RFC 1122's R1, a few seconds on
  // a virtual clock, never R2's 100 s: nothing was delivered, and the person
  // is waiting): the last answer, for the caller to report with Try again.
  const time = virtualTime();
  const stillBusy = installFetch(t, () => ({ status: 429, headers: { 'Retry-After': '0' } }));
  const gaveUp = await fetchWhenNotBusy('https://raw.githubusercontent.com/o/r/HEAD/a', {}, { clock: new ResponseClock({ clock: time.now, after: time.after }) });
  assert.equal(gaveUp.status, 429);
  assert.equal(stillBusy.length, RETRY_AT_LEAST + 1);
  assert.ok(time.now() < RETRY_FOR_MS, `asked again for ${time.now()} ms`);

  // A wait is cancelled with the request.
  installFetch(t, () => ({ status: 429, headers: { 'Retry-After': '60' } }));
  const controller = new AbortController();
  const pending = fetchWhenNotBusy('https://raw.githubusercontent.com/o/r/HEAD/a', { signal: controller.signal });
  controller.abort(new DOMException('stop', 'AbortError'));
  await assert.rejects(pending, error => error.name === 'AbortError');
});

test('Dropbox reads a file link from its content host and refuses a folder link', async t => {
  installFetch(t, (url, init) => (url.startsWith('https://dl.dropboxusercontent.com/') ? fileRoute(512)(url, init) : null));
  const opened = await dropbox.open('https://www.dropbox.com/scl/fi/abc/atlas.h5ad?rlkey=k&dl=0');
  assert.equal(opened.file.resource.url, 'https://dl.dropboxusercontent.com/scl/fi/abc/atlas.h5ad?rlkey=k');
  // The share key reads the file; where it is said to come from (figure
  // provenance, the dataset card) is the share link without it.
  assert.equal(opened.file.attribution.url, 'https://www.dropbox.com/scl/fi/abc/atlas.h5ad');
  await assert.rejects(dropbox.open('folder:https://www.dropbox.com/scl/fo/abc/x'), /folder link/);
});

test('a Zarr store folder opens as a store from a web address, GitHub or Hugging Face', async t => {
  const fromUrl = await http.open('https://lab.example.org/data/atlas.zarr');
  assert.equal(fromUrl.store.url, 'https://lab.example.org/data/atlas.zarr/');
  assert.equal(fromUrl.store.title, 'atlas');
  const signed = await http.open('https://bucket.example.org/atlas.zarr/?sig=abc');
  assert.equal(signed.store.url, 'https://bucket.example.org/atlas.zarr/?sig=abc', 'a signed query is kept');
  const catalogFolder = await http.open('https://lab.example.org/catalog/');
  assert.ok(catalogFolder.catalog && !catalogFolder.store, 'a plain folder is still a catalog');

  const fromGitHub = await github.open('lab/atlas/files/pbmc.zarr');
  assert.equal(fromGitHub.store.url, 'https://raw.githubusercontent.com/lab/atlas/HEAD/files/pbmc.zarr/');
  // The id of a store that states none becomes anndata://<id>/: no "/" in
  // it; it names the ref, so two refs are two datasets.
  assert.equal(fromGitHub.store.id, `gh:${encodeURIComponent('lab/atlas@HEAD/files/pbmc.zarr')}`);
  const onBranch = await github.open('https://github.com/lab/atlas/tree/v2/files/pbmc.zarr');
  assert.equal(onBranch.store.url, 'https://raw.githubusercontent.com/lab/atlas/v2/files/pbmc.zarr/');
  assert.equal(onBranch.store.id, `gh:${encodeURIComponent('lab/atlas@v2/files/pbmc.zarr')}`);
  assert.equal(onBranch.store.version, undefined, 'a folder read by a branch names no content: kept for its opening only');

  const commit = 'b'.repeat(40);
  const hub = {
    sha: commit,
    files: [
      { path: 'stores/pbmc.zarr/.zmetadata', size: 100, oid: '1'.repeat(40) },
      { path: 'stores/pbmc.zarr/X/data/0', size: 10, oid: '2'.repeat(40) },
      { path: 'stores/v3.zarr/zarr.json', size: 100, oid: '3'.repeat(40) },
    ],
  };
  installFetch(t, fakeHub(hub));
  const fromHub = await huggingface.open('lab/atlas/stores/pbmc.zarr');
  assert.equal(fromHub.store.url, `https://huggingface.co/datasets/lab/atlas/resolve/${commit}/stores/pbmc.zarr/`, 'pinned to the commit');
  assert.equal(fromHub.store.id, `hf:${encodeURIComponent('lab/atlas@main/stores/pbmc.zarr')}`);
  assert.match(fromHub.store.version ?? '', /^hf-tree:[0-9a-f]{40}$/, 'named by its git tree, its files\' content names: its objects are kept under it');
  hub.files.push({ path: 'stores/other.zarr/zarr.json', size: 5, oid: '4'.repeat(40) });
  assert.equal((await huggingface.open('lab/atlas/stores/pbmc.zarr')).store.version, fromHub.store.version, 'a commit elsewhere keeps the folder\'s version');
  hub.files[1] = { ...hub.files[1], oid: '5'.repeat(40) };
  assert.notEqual((await huggingface.open('lab/atlas/stores/pbmc.zarr')).store.version, fromHub.store.version, 'a chunk rewritten: a new version');
  for (const opened of [fromUrl, fromGitHub, fromHub]) assert.ok(!opened.store.id.includes('/'), opened.store.id);
  const v3 = await huggingface.open('lab/atlas/stores/v3.zarr');
  assert.equal(v3.store.title, 'v3');
});

test('a web file\'s version is its size with its Last-Modified date and strong ETag, asked of the host at each opening', async t => {
  let headers = {};
  const calls = installFetch(t, (url, init) => fileRoute(4096, headers)(url, init));
  const versionNow = async () => (await http.open('https://bucket.example.org/atlas.h5ad')).file.resource.identity.version;
  headers = { ETag: '"v1"', 'Last-Modified': 'Mon, 26 Oct 2026 10:00:00 GMT' };
  const first = await versionNow();
  assert.equal(first, 'written:4096 modified:Mon, 26 Oct 2026 10:00:00 GMT etag:"v1"');
  assert.equal(await versionNow(), first, 'unchanged: the same version');
  headers = { ETag: '"v2"', 'Last-Modified': 'Mon, 26 Oct 2026 10:00:00 GMT' };
  assert.notEqual(await versionNow(), first, 'rewritten within the second, a new strong ETag: a new version');
  headers = { 'Last-Modified': 'Tue, 27 Oct 2026 10:00:00 GMT' };
  assert.equal(await versionNow(), 'written:4096 modified:Tue, 27 Oct 2026 10:00:00 GMT');
  // A weak ETag says two answers mean the same, never that their bytes are.
  headers = { ETag: 'W/"v1"' };
  assert.equal(await versionNow(), 'size:4096', 'no validator: no version, nothing kept is used');
  headers = {};
  assert.equal(await versionNow(), 'size:4096');
  // Every request of the probe passes the browser's HTTP cache by.
  assert.ok(calls.every(call => call.cache === 'no-store'), calls.map(call => `${call.method} ${call.cache}`).join(', '));
});

test('a whole download that answers another version than the one described is refused, never kept under it', async t => {
  let etag = '"v1"';
  installFetch(t, (url, init) => (init.method === 'HEAD'
    ? { status: 200, headers: { 'Content-Length': '10', ETag: etag } }
    : { status: 200, headers: { 'Content-Length': '10', ETag: etag }, body: new Uint8Array(10) }));
  const opened = await http.open('https://example.org/whole.h5ad');
  assert.equal(opened.file.transport, 'download');
  etag = '"v2"';
  await assert.rejects(downloadRemoteFile(opened.file.resource), error => error.code === 'changed' && /changed on example\.org/.test(error.message));
});

test('CELLxGENE names the Census build its file is read from, asked of the release list at each opening', async t => {
  let build = '2025-11-10';
  const calls = installFetch(t, (url, init) => {
    if (url.endsWith('/cell-census/release.json')) {
      return { status: 200, json: { latest: build, [build]: { release_build: build, h5ads: { relative_uri: `/cell-census/${build}/h5ads/` } } } };
    }
    if (url === `${CENSUS_BUCKET_URL}/cell-census/${build}/h5ads/${ID}.h5ad`) return fileRoute(1000)(url, init);
    return null;
  });
  const first = await cellxgene.open(ID);
  assert.equal(first.file.resource.identity.version, 'census:2025-11-10');
  assert.equal((await cellxgene.open(ID)).file.resource.identity.version, 'census:2025-11-10');
  // A new release republishes the dataset in its own build folder.
  build = '2026-04-01';
  const republished = await cellxgene.open(ID);
  assert.equal(republished.file.resource.identity.version, 'census:2026-04-01');
  assert.equal(republished.file.resource.url, `${CENSUS_BUCKET_URL}/cell-census/2026-04-01/h5ads/${ID}.h5ad`);
  assert.ok(calls.filter(call => call.url.endsWith('release.json')).every(call => call.cache === 'no-cache'));
});

test('Zenodo names the version record and the file\'s checksum, Hugging Face the file\'s own content name, asked of them at each opening', async t => {
  let record = { id: 9, sha: 'a'.repeat(40), checksum: 'md5:bb', blob: 'f'.repeat(64) };
  const calls = installFetch(t, (url, init) => {
    if (url === 'https://zenodo.org/api/records/7') {
      return { status: 200, json: { id: record.id, conceptrecid: '7', files: [{ key: 'atlas.h5ad', size: 4096, checksum: record.checksum }] } };
    }
    return fakeHub({ sha: record.sha, files: [{ path: 'one.h5ad', size: 2048, lfs: { oid: record.blob, size: 2048 } }] })(url, init);
  });
  const versions = async () => [
    (await zenodo.open('7')).file.resource.identity.version,
    (await huggingface.open('lab/atlas/one.h5ad')).file.resource.identity.version,
  ];
  const first = await versions();
  assert.deepEqual(first, ['zenodo:9:md5:bb', `hf:${'f'.repeat(64)}`]);
  assert.deepEqual(await versions(), first, 'unchanged: the same versions');
  // A commit that changes other files of the repository: the file is as it was.
  record = { ...record, sha: 'b'.repeat(40) };
  assert.equal((await versions())[1], first[1], 'a commit elsewhere keeps the file\'s version (and what is kept of it)');
  record = { id: 10, sha: 'c'.repeat(40), checksum: 'md5:cc', blob: 'e'.repeat(64) };
  const next = await versions();
  assert.notEqual(next[0], first[0], 'a new Zenodo version record');
  assert.notEqual(next[1], first[1], 'the file rewritten: its content name moves');
  assert.ok(calls.every(call => call.cache === 'no-cache'), 'the record and the revision are asked of the host, never a cached answer');
});

test('a Dropbox file\'s version is its host\'s validators, so a replaced file is a new version', async t => {
  let etag = '"1"';
  installFetch(t, (url, init) => fileRoute(4096, { ETag: etag })(url, init));
  const link = 'https://www.dropbox.com/scl/fi/abc/atlas.h5ad?rlkey=k&dl=0';
  const first = (await dropbox.open(link)).file.resource.identity.version;
  assert.equal(first, 'written:4096 etag:"1"');
  assert.equal((await dropbox.open(link)).file.resource.identity.version, first);
  etag = '"2"';
  assert.notEqual((await dropbox.open(link)).file.resource.identity.version, first);
});

test('a whole download rides out a busy host, and a body cut short by a host that ignores ranges is downloaded again from its start', async t => {
  const bytes = new Uint8Array(4096).map((_, i) => i & 255);
  let asked = 0;
  const ranges = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init = {}) => {
    asked++;
    ranges.push(init.headers?.Range ?? null);
    if (asked === 1) return new Response('busy', { status: 503 });
    if (asked === 2) {
      // Half of it, then the connection drops.
      let sent = false;
      const body = new ReadableStream({
        pull(controller) {
          if (sent) {
            controller.error(new TypeError('network connection was lost'));
            return;
          }
          sent = true;
          controller.enqueue(bytes.slice(0, 2048));
        },
      });
      return new Response(body, { status: 200 });
    }
    return new Response(bytes.slice(), { status: 200 });
  };
  const retried = [];
  const received = [];
  const { file } = await downloadRemoteFile(
    { url: 'https://ftp.example.org/geo/a.rds', name: 'a.rds', size: bytes.length, identity: { kind: 'remote', key: 'geo:a', version: 'size:4096' } },
    { onBytes: total => received.push(total), onRetry: error => retried.push(error.code) }
  );
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
  assert.equal(asked, 4, 'a busy answer, a body cut short, its rest asked for (answered whole: not resumable), then the whole file');
  assert.deepEqual(ranges, [null, null, 'bytes=2048-', null]);
  assert.deepEqual(retried, ['unavailable', 'network'], 'each failure asked again is said: the busy answer, then the cut body');
  assert.equal(received.at(-1), 2048 + 4096, 'every byte that arrived is counted, the cut attempt included');
});

test('a whole download cut short goes on from the byte it stopped at where the host serves ranges, under the version it started with', async t => {
  // A compressed copy is read whole (a gzip stream has no index): on an
  // unsteady link, every drop used to start it over.
  const bytes = new Uint8Array(8192).map((_, i) => (i * 7) & 255);
  const headers = { ETag: '"v1"', 'Last-Modified': 'Wed, 01 Oct 2025 00:00:00 GMT' };
  let tag = '"v1"';
  const asked = [];
  let served = 0;
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const cutAfter = (from, count) => {
    let sent = false;
    return new ReadableStream({
      pull(controller) {
        if (sent) {
          controller.error(new TypeError('network connection was lost'));
          return;
        }
        sent = true;
        served += count;
        controller.enqueue(bytes.slice(from, from + count));
      },
    });
  };
  globalThis.fetch = async (url, init = {}) => {
    const range = init.headers?.Range ?? null;
    asked.push(range);
    if (range === null) return new Response(cutAfter(0, 3000), { status: 200, headers });
    const from = Number(/bytes=(\d+)-/.exec(range)[1]);
    if (from === 3000) return new Response(cutAfter(3000, 2000), { status: 206, headers: { ...headers, ETag: tag, 'Content-Range': `bytes 3000-8191/8192` } });
    served += bytes.length - from;
    return new Response(bytes.slice(from), { status: 206, headers: { ...headers, ETag: tag, 'Content-Range': `bytes ${from}-8191/8192` } });
  };
  const resource = { url: 'https://ftp.example.org/geo/a.h5ad', name: 'a.h5ad', size: bytes.length, identity: { kind: 'remote', key: 'geo:a', version: 'size:8192' } };
  const received = [];
  const { file } = await downloadRemoteFile(resource, { onBytes: total => received.push(total) });
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
  assert.deepEqual(asked, [null, 'bytes=3000-', 'bytes=5000-'], 'cut twice, each time the rest only');
  assert.equal(served, bytes.length, 'no byte asked for twice');
  assert.equal(received.at(-1), bytes.length);

  // The rest of another version is never joined to what arrived.
  asked.length = 0;
  served = 0;
  tag = '"v2"';
  await assert.rejects(downloadRemoteFile(resource), error => error.code === 'changed' && /changed on ftp\.example\.org while it was downloaded/.test(error.message));
});

test('s3:// and gs:// addresses are read at their HTTPS address; a Census copy\'s address is the CELLxGENE dataset, one identity by either route', async t => {
  assert.equal(http.match('s3://lab-bucket/atlas/pbmc.h5ad'), 'https://lab-bucket.s3.amazonaws.com/atlas/pbmc.h5ad');
  assert.equal(http.match('s3://lab.bucket/pbmc.zarr/'), 'https://s3.amazonaws.com/lab.bucket/pbmc.zarr/', 'a dotted bucket, path-style');
  assert.equal(http.match('gs://lab-data/atlas.h5ad'), 'https://storage.googleapis.com/lab-data/atlas.h5ad');
  const build = '2025-11-10';
  const copy = `s3://cellxgene-census-public-us-west-2/cell-census/${build}/h5ads/${ID}.h5ad`;
  assert.equal(cellxgene.match(copy), `census/${build}/${ID}`);
  assert.equal(cellxgene.match(`https://cellxgene-census-public-us-west-2.s3.us-west-2.amazonaws.com/cell-census/${build}/h5ads/${ID}.h5ad`), `census/${build}/${ID}`);
  assert.equal(cellxgene.match(`https://s3.us-west-2.amazonaws.com/cellxgene-census-public-us-west-2/cell-census/${build}/h5ads/${ID}.h5ad`), `census/${build}/${ID}`);
  installFetch(t, (url, init) => {
    if (url.endsWith('/cell-census/release.json')) return censusRelease();
    if (url === `${CENSUS_BUCKET_URL}/cell-census/${build}/h5ads/${ID}.h5ad`) return fileRoute(1000)(url, init);
    return null;
  });
  const byCopy = await cellxgene.open(cellxgene.match(copy));
  const byId = await cellxgene.open(ID);
  assert.deepEqual(byCopy.file.resource.identity, byId.file.resource.identity, 'the same bytes, one identity');
  assert.equal(byCopy.file.id, byId.file.id, 'one dataset: sessions and annotations carry over');
});
