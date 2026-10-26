import assert from 'node:assert/strict';
import test from 'node:test';

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

const ID = '0819e386-e7fd-4212-b732-60e468689f89';

/**
 * Replace fetch with one answering from `routes(url, init)`, with real
 * `Response`s: a body, a JSON document or a text, and the answer's headers.
 */
function installFetch(t, routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {} });
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
  }
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
  assert.equal(opened.file.resource.identity.version, '"v1"');
  assert.ok(!opened.file.id.includes('/'), 'the id becomes anndata://<id>/');

  await assert.rejects(
    http.open('https://example.org/data/atlas.qs'),
    /not a file Cellucid opens from a link/
  );
});

test('a host that ignores ranges is downloaded whole, with its progress', async t => {
  installFetch(t, (url, init) => (init.method === 'HEAD'
    ? { status: 200, headers: { 'Content-Length': '10' } }
    : { status: 200, headers: { 'Content-Length': '10' }, body: new Uint8Array(10) }));
  const opened = await http.open('https://example.org/a.h5ad');
  assert.equal(opened.file.transport, 'download');
  assert.equal(opened.file.resource.size, 10);
  const received = [];
  const file = await downloadRemoteFile(opened.file.resource, { onBytes: bytes => received.push(bytes) });
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
  const file = await downloadRemoteFile(opened.file.resource);
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
    return null;
  });
  const opened = await geo.open('GSE351300');
  assert.equal(opened.file.id, 'geo:GSE351300:GSE351300_counts.h5ad');
  assert.equal(opened.file.resource.size, 287709670);

  listing = GEO_LISTING.replace('</body>', '<a href="GSE351300_b.h5ad">b</a></body>');
  await assert.rejects(geo.open('GSE351300'), /has 2 datasets Cellucid opens.*geo:GSE351300\/GSE351300_counts\.h5ad/);
  listing = '<a href="GSE351300_x.h5ad.gz">x</a>';
  await assert.rejects(geo.open('GSE351300'), /only gzip-compressed/);
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

test('Hugging Face pins the commit and opens a catalog, a file, or names the choices', async t => {
  const commit = 'a'.repeat(40);
  installFetch(t, url => {
    if (url.startsWith('https://huggingface.co/api/datasets/lab/atlas/revision/main')) {
      return {
        status: 200,
        json: {
          sha: commit,
          cardData: { license: 'cc-by-4.0' },
          siblings: [
            { rfilename: '.gitattributes', size: 10 },
            { rfilename: 'catalog/datasets.json', size: 100 },
            { rfilename: 'one.h5ad', size: 10, lfs: { size: 2048, sha256: 'f'.repeat(64) } },
            { rfilename: 'two.zip', size: 4096 },
          ],
        },
      };
    }
    return null;
  });
  const catalog = await huggingface.open('lab/atlas/catalog');
  assert.equal(catalog.catalog.baseUrl, `https://huggingface.co/datasets/lab/atlas/resolve/${commit}/catalog/`);
  const file = await huggingface.open('lab/atlas/one.h5ad');
  assert.equal(file.file.resource.url, `https://huggingface.co/datasets/lab/atlas/resolve/${commit}/one.h5ad`);
  assert.equal(file.file.resource.size, 2048);
  assert.equal(file.file.attribution.licence, 'cc-by-4.0');
  await assert.rejects(huggingface.open('lab/atlas'), /2 files Cellucid opens.*hf:lab\/atlas\/one\.h5ad, hf:lab\/atlas\/two\.zip/);
});

test('GitHub opens a catalog folder, or one file in place, from LFS when it is stored there', async t => {
  const folder = await github.open('owner/repo/catalog');
  assert.deepEqual(folder.catalog, {
    baseUrl: 'https://raw.githubusercontent.com/owner/repo/HEAD/catalog/',
  });

  const oid = 'sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393';
  const pointer = new TextEncoder().encode(
    'version https://git-lfs.github.com/spec/v1\n' +
    `oid ${oid}\n` +
    'size 123456789\n'
  );
  const calls = installFetch(t, (url, init) => {
    if (url === 'https://raw.githubusercontent.com/owner/repo/HEAD/data/plain.h5ad') {
      return fileRoute(4096, { ETag: '"blob"' })(url, init);
    }
    if (url === 'https://raw.githubusercontent.com/owner/repo/HEAD/data/big.h5ad') {
      return init.method === 'HEAD'
        ? { status: 200, headers: { 'Content-Length': String(pointer.length) } }
        : { status: 206, headers: {}, body: pointer };
    }
    return null;
  });

  const plain = await github.open('owner/repo/data/plain.h5ad');
  assert.deepEqual(plain.file.format, { format: 'h5ad', layout: 'file' });
  assert.equal(plain.file.title, 'plain');
  assert.equal(plain.file.resource.url, 'https://raw.githubusercontent.com/owner/repo/HEAD/data/plain.h5ad');
  assert.equal(plain.file.resource.size, 4096);
  assert.equal(plain.file.resource.identity.version, '"blob"');
  assert.ok(!plain.file.id.includes('/'), 'the id becomes anndata://<id>/');
  // One round trip: a HEAD whose open range asks for the unencoded length
  // (GitHub Pages states a compressed one otherwise) and, beside it, the
  // file's head, its first read, which opening starts from. Nothing probes
  // ranges: GitHub's hosts serve them.
  assert.deepEqual(
    calls.map(call => [call.method, call.headers.Range ?? null]),
    [['GET', 'bytes=0-524287'], ['HEAD', 'bytes=0-']]
  );
  assert.equal(plain.file.resource.head.bytes.length, 4096, 'the whole of a file shorter than its head');
  assert.equal(plain.file.resource.head.etag, '"blob"');

  calls.length = 0;
  const lfs = await github.open('owner/repo/data/big.h5ad');
  assert.equal(lfs.file.resource.url, 'https://media.githubusercontent.com/media/owner/repo/HEAD/data/big.h5ad');
  assert.equal(lfs.file.resource.size, 123456789, 'the size the pointer states');
  assert.equal(lfs.file.resource.identity.version, oid, 'the object hash names its bytes');
  assert.equal(lfs.file.id, plain.file.id.replace('plain', 'big'));
  // The pointer's HEAD and, beside it, its head, which holds the pointer
  // whole; the media host is never probed, and its head is not the pointer's.
  assert.deepEqual(
    calls.map(call => [call.method, new URL(call.url).host]),
    [['GET', 'raw.githubusercontent.com'], ['HEAD', 'raw.githubusercontent.com']]
  );
  assert.equal(lfs.file.resource.head, undefined);

  // A file a branch does not hold is named, with what to check.
  await assert.rejects(
    github.open('owner/repo@dev/data/missing.h5ad'),
    error => error.code === 'NOT_FOUND' && /missing\.h5ad was not found at raw\.githubusercontent\.com \(HTTP 404\)/.test(error.message)
  );
});

test('GitHub asks a busy host again, as long as it asks to wait', async t => {
  let busy = 2;
  const calls = installFetch(t, () => {
    if (busy > 0) {
      busy--;
      return { status: 429, headers: { 'Retry-After': '0' } };
    }
    return { status: 200, headers: { 'Content-Length': '2048' } };
  });
  const opened = await github.open('owner/repo/a.h5ad');
  assert.equal(opened.file.resource.size, 2048);
  // The HEAD and the head read, each answered busy once, each asked again.
  assert.equal(calls.length, 4, 'two busy answers, then the size and the head');
  assert.deepEqual(calls.map(call => call.method).sort(), ['GET', 'GET', 'HEAD', 'HEAD']);
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

  // Still busy after every wait: the last answer, for the caller to report.
  calls.length = 0;
  installFetch(t, () => ({ status: 429, headers: { 'Retry-After': '0' } }));
  const gaveUp = await fetchWhenNotBusy('https://raw.githubusercontent.com/o/r/HEAD/a');
  assert.equal(gaveUp.status, 429);

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
  assert.equal(opened.file.attribution.url, 'https://www.dropbox.com/scl/fi/abc/atlas.h5ad?rlkey=k');
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
  // The id of a store that states none becomes anndata://<id>/: no "/" in it.
  assert.equal(fromGitHub.store.id, `gh:${encodeURIComponent('lab/atlas/files/pbmc.zarr')}`);
  const onBranch = await github.open('https://github.com/lab/atlas/tree/v2/files/pbmc.zarr');
  assert.equal(onBranch.store.url, 'https://raw.githubusercontent.com/lab/atlas/v2/files/pbmc.zarr/');

  const commit = 'b'.repeat(40);
  installFetch(t, url => (url.startsWith('https://huggingface.co/api/datasets/lab/atlas/revision/main')
    ? {
        status: 200,
        json: {
          sha: commit,
          siblings: [
            { rfilename: 'stores/pbmc.zarr/.zmetadata', size: 100 },
            { rfilename: 'stores/pbmc.zarr/X/data/0', size: 10 },
            { rfilename: 'stores/v3.zarr/zarr.json', size: 100 },
          ],
        },
      }
    : null));
  const fromHub = await huggingface.open('lab/atlas/stores/pbmc.zarr');
  assert.equal(fromHub.store.url, `https://huggingface.co/datasets/lab/atlas/resolve/${commit}/stores/pbmc.zarr/`, 'pinned to the commit');
  assert.equal(fromHub.store.id, `hf:${encodeURIComponent('lab/atlas/stores/pbmc.zarr')}`);
  for (const opened of [fromUrl, fromGitHub, fromHub]) assert.ok(!opened.store.id.includes('/'), opened.store.id);
  const v3 = await huggingface.open('lab/atlas/stores/v3.zarr');
  assert.equal(v3.store.title, 'v3');
});
