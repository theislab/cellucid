/**
 * A gene is read, end to end, from every place a dataset opens from: each
 * link provider against a fake of its host (a web address, CELLxGENE, GEO,
 * Zenodo, Figshare, Hugging Face, Google Drive public and private, OneDrive,
 * Dropbox, GitHub plain and LFS), a Zarr store folder and zip over HTTP, and
 * a local file; and from every layout a gene is read from (CSR, CSC, dense
 * in row chunks, Zarr). The file is shaped as CELLxGENE publishes its Census
 * `.h5ad` files (`scripts/generate-gene-read-fixtures.py`): an Ensembl var
 * index with the symbols in the categorical `feature_name`, a CSR `X` with
 * int64 indices in small gzip chunks.
 *
 * For every one:
 * - the genes are named by their symbols, chosen by content, each keeping
 *   its Ensembl id, and a symbol search (`SFTPC`, `EPCAM`) and an id search
 *   both find the gene;
 * - before the first gene of a cell-major matrix, the read is said to cost
 *   the whole matrix, in its stored bytes (`geneReadPlan`); a gene-major one
 *   is said to cost nothing more than the gene;
 * - every gene's values equal numpy's, float32 for float32.
 *
 * The same holds for a store `cellucid serve` serves (a file, a Zarr zip, a
 * Zarr folder), for the viewer host a notebook's `show_anndata()` opens, and
 * over a link slower than a disk (values read per gene). Every format a
 * person brings that is not AnnData (Loom, MuData `.h5mu` and Zarr, Seurat
 * and SingleCellExperiment `.rds` and `.rda`, MatrixMarket and Cell Ranger
 * `outs/` folders) gives, by link or from a host, the genes the same file
 * gives on this computer; the corpus tests (`formats-corpus-conformance`,
 * `rds-corpus-conformance`) hold those to the format's own library.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { rankedMatchIndices } from '../assets/js/app/utils/text-match.js';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import { describeGeneReadPlan } from '../assets/js/data/gene-read-plan.js';
import { LinkDataSource } from '../assets/js/data/link-source.js';
import { RemoteDataSource } from '../assets/js/data/remote-source.js';
import { ViewerHostDataSource } from '../assets/js/data/viewer-host-source.js';
import { viewerProtocolDocument } from '../assets/js/data/viewer-protocol.js';
import './helpers/fake-host-socket.mjs';
import { DEFAULT_PROVIDERS, ProviderRegistry } from '../assets/js/data/sources/registry.js';
import { CENSUS_BUCKET_URL } from '../assets/js/data/sources/providers/cellxgene.js';
import { createDriveProvider } from '../assets/js/data/sources/providers/gdrive.js';
import { createOneDriveProvider, shareIdOf } from '../assets/js/data/sources/providers/onedrive.js';
import { zippedStoreEntries } from './helpers/zarr-corpus.mjs';

const FIXTURES = new URL('./fixtures/gene-read/', import.meta.url);
const EXPECTED = JSON.parse(readFileSync(new URL('cellxgene-shaped.expected.json', FIXTURES), 'utf8'));
const FILES = {
  csr: new Uint8Array(readFileSync(new URL('cellxgene-shaped.h5ad', FIXTURES))),
  csc: new Uint8Array(readFileSync(new URL('cellxgene-shaped-csc.h5ad', FIXTURES))),
  dense: new Uint8Array(readFileSync(new URL('cellxgene-shaped-dense.h5ad', FIXTURES))),
  zarrZip: new Uint8Array(readFileSync(new URL('cellxgene-shaped.zarr.zip', FIXTURES))),
};
const STORE = await zippedStoreEntries(new URL('cellxgene-shaped.zarr.zip', FIXTURES).pathname);
const CENSUS_ID = '9f222629-9e39-47d0-b83f-e08d610c7479';
const DRIVE_ID = '1l_5RK28JRL19wpT22B-DY9We3TVXnnQQ';
const TOKEN = 'TOKEN-MARKER-gene-read';
const DOWNLOAD = 'https://my.microsoftpersonalcontent.com/personal/x/download.aspx?tempauth=T';
const PROTOCOL = Object.freeze(viewerProtocolDocument());
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function quiet(t) {
  const notifications = getNotificationCenter();
  const names = ['loading', 'complete', 'fail', 'dismiss', 'progress', 'updateProgress', 'warning', 'error', 'info',
    'startDownload', 'updateDownload', 'completeDownload', 'failDownload', 'dismissDownload'];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  let next = 0;
  for (const name of names) notifications[name] = () => `gene-read-${++next}`;
  const { log, warn, info } = console;
  console.log = () => {};
  console.warn = () => {};
  console.info = () => {};
  t.after(() => {
    for (const [name, method] of originals) notifications[name] = method;
    Object.assign(console, { log, warn, info });
  });
}

/** One file's bytes as a static host answers: HEAD, a ranged GET (206), a whole GET. */
function bytesAnswer(bytes, init, headers = {}) {
  const base = { 'Accept-Ranges': 'bytes', ETag: `"${sha256(bytes).slice(0, 16)}"`, ...headers };
  const method = init?.method ?? 'GET';
  const range = new Headers(init?.headers ?? {}).get('Range');
  if (method === 'HEAD') {
    return new Response(null, { status: 200, headers: { ...base, 'Content-Length': String(bytes.length) } });
  }
  if (range !== null) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = Number(match[1]);
    const end = match[2] === '' ? bytes.length - 1 : Math.min(Number(match[2]), bytes.length - 1);
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1) },
    });
  }
  return new Response(bytes.slice(), { status: 200, headers: { ...base, 'Content-Length': String(bytes.length) } });
}

function jsonAnswer(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Replace fetch with `route(url, init)`; what it does not answer is a 404. */
function host(t, route) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers ?? {})) });
    if (init.signal?.aborted) throw init.signal.reason;
    const answer = await route(url, init);
    if (answer === null || answer === undefined) return new Response('not found', { status: 404 });
    if (answer.redirected) Object.defineProperty(answer.response, 'url', { value: answer.redirected });
    return answer.response ?? answer;
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/** A Google sign-in that answers from memory (as the provider contract's fake). */
function fakeGoogle({ signedIn = false } = {}) {
  const state = { token: signedIn ? `${TOKEN}-0` : null, picked: [] };
  return Object.assign(state, {
    apiKey: 'AIza-PUBLIC-KEY',
    whyNoPublicAccess: () => null,
    whyNoSignIn: () => null,
    loadScripts: async () => {},
    validToken: () => state.token,
    authorize: async () => {
      state.token = `${TOKEN}-1`;
      return state.token;
    },
    pick: async id => {
      state.picked.push(id);
      return id;
    },
    refused: () => {},
    signOut: () => {},
    signedIn: () => state.token !== null,
  });
}

function fakeMicrosoft() {
  const state = { token: null };
  return Object.assign(state, {
    whyNoSignIn: () => null,
    hasWideAccess: () => false,
    silentToken: async () => state.token,
    authorize: async () => {
      state.token = `${TOKEN}-ms`;
      return state.token;
    },
    refused: () => {},
    signOut: () => {},
    signedIn: () => state.token !== null,
  });
}

/**
 * Every link provider, its link, and its host faked: what it answers about
 * the file, then the file's bytes over ranges, wherever the provider reads
 * them from.
 */
function providerCases() {
  const csr = FILES.csr;
  const size = csr.length;
  const oid = `sha256:${sha256(csr)}`;
  const commit = 'a'.repeat(40);
  const driveItem = { id: DRIVE_ID, name: 'hlca.h5ad', size: String(size), md5Checksum: 'd41d', mimeType: 'application/octet-stream', capabilities: { canDownload: true } };
  const share = 'https://1drv.ms/u/c/12a1b84edebf20f7/EVjJu5abc';
  const graphItem = {
    id: '12A1B84EDEBF20F7!101',
    name: 'hlca.h5ad',
    size,
    file: {},
    cTag: 'c1',
    webUrl: 'https://onedrive.live.com/?id=x',
    parentReference: { driveId: '12a1b84edebf20f7' },
    '@microsoft.graph.downloadUrl': DOWNLOAD,
  };
  return [
    {
      name: 'a web address',
      link: 'https://data.example.org/atlas/hlca.h5ad',
      route: (url, init) => (url === 'https://data.example.org/atlas/hlca.h5ad' ? bytesAnswer(csr, init) : null),
    },
    {
      name: 'CELLxGENE (the Census copy)',
      link: `cellxgene:${CENSUS_ID}`,
      route: (url, init) => {
        if (url.endsWith('/cell-census/release.json')) {
          return jsonAnswer({
            stable: '2025-01-30',
            latest: '2025-11-10',
            '2025-11-10': { release_build: '2025-11-10', h5ads: { relative_uri: '/cell-census/2025-11-10/h5ads/' } },
          });
        }
        return url === `${CENSUS_BUCKET_URL}/cell-census/2025-11-10/h5ads/${CENSUS_ID}.h5ad` ? bytesAnswer(csr, init) : null;
      },
    },
    {
      name: 'GEO',
      link: 'geo:GSE351300',
      route: (url, init) => {
        if (url === 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE351nnn/GSE351300/suppl/') {
          return new Response('<a href="GSE351300_hlca.h5ad">GSE351300_hlca.h5ad</a>', { status: 200 });
        }
        return url.endsWith('/GSE351300_hlca.h5ad') ? bytesAnswer(csr, init) : null;
      },
    },
    {
      name: 'Zenodo',
      link: 'zenodo:7',
      route: (url, init) => {
        if (url === 'https://zenodo.org/api/records/7') {
          return jsonAnswer({
            id: 9,
            conceptrecid: '7',
            doi: '10.5281/zenodo.9',
            metadata: { title: 'Atlas', license: { id: 'cc-by-4.0' } },
            files: [{ key: 'hlca.h5ad', size, checksum: 'md5:bb' }],
          });
        }
        return url === 'https://zenodo.org/api/records/9/files/hlca.h5ad/content' ? bytesAnswer(csr, init) : null;
      },
    },
    {
      name: 'Figshare (a signed S3 link, renewed through the page)',
      link: 'figshare:16566057',
      route: (url, init) => {
        if (url === 'https://api.figshare.com/v2/articles/16566057') {
          return jsonAnswer({
            id: 16566057,
            version: 1,
            title: 'hlca.h5ad',
            doi: '10.6084/m9.figshare.16566057.v1',
            figshare_url: 'https://figshare.com/articles/dataset/hlca/16566057',
            license: { name: 'CC BY 4.0' },
            files: [{ id: 30639279, name: 'hlca.h5ad', size, computed_md5: 'abc', is_link_only: false }],
          });
        }
        if (url === 'https://ndownloader.figshare.com/files/30639279') {
          return { response: bytesAnswer(csr, init), redirected: 'https://s3.example.org/f?X-Amz-Expires=3600&X-Amz-Signature=sig' };
        }
        return url.startsWith('https://s3.example.org/f?') ? bytesAnswer(csr, init) : null;
      },
    },
    {
      name: 'Hugging Face',
      link: 'hf:lab/atlas/hlca.h5ad',
      route: (url, init) => {
        if (url.startsWith('https://huggingface.co/api/datasets/lab/atlas/revision/main')) {
          return jsonAnswer({ sha: commit, siblings: [{ rfilename: 'hlca.h5ad', size: 10, lfs: { size, sha256: sha256(csr) } }] });
        }
        return url === `https://huggingface.co/datasets/lab/atlas/resolve/${commit}/hlca.h5ad` ? bytesAnswer(csr, init) : null;
      },
    },
    {
      name: 'Dropbox',
      link: 'https://www.dropbox.com/scl/fi/abc/hlca.h5ad?rlkey=k&dl=0',
      route: (url, init) => (url.startsWith('https://dl.dropboxusercontent.com/scl/fi/abc/hlca.h5ad') ? bytesAnswer(csr, init) : null),
    },
    {
      name: 'GitHub',
      link: 'gh:owner/repo/data/hlca.h5ad',
      route: (url, init) => (url === 'https://raw.githubusercontent.com/owner/repo/HEAD/data/hlca.h5ad' ? bytesAnswer(csr, init) : null),
    },
    {
      name: 'GitHub, stored in LFS',
      link: 'gh:owner/repo/lfs/hlca.h5ad',
      route: (url, init) => {
        if (url === 'https://raw.githubusercontent.com/owner/repo/HEAD/lfs/hlca.h5ad') {
          return bytesAnswer(new TextEncoder().encode(`version https://git-lfs.github.com/spec/v1\noid ${oid}\nsize ${size}\n`), init);
        }
        return url === 'https://media.githubusercontent.com/media/owner/repo/HEAD/lfs/hlca.h5ad' ? bytesAnswer(csr, init) : null;
      },
    },
    {
      name: 'Google Drive, public',
      link: `gdrive:${DRIVE_ID}`,
      providers: { gdrive: createDriveProvider({ google: fakeGoogle() }) },
      route: (url, init) => {
        if (url.includes(`/files/${DRIVE_ID}?fields=`)) return jsonAnswer(driveItem);
        return url.includes(`/files/${DRIVE_ID}?alt=media`) && url.includes('key=') ? bytesAnswer(csr, init) : null;
      },
    },
    {
      name: 'Google Drive, private (sign-in and the picker)',
      link: `gdrive:${DRIVE_ID}`,
      providers: { gdrive: createDriveProvider({ google: fakeGoogle() }) },
      private: true,
      route: (url, init) => {
        const signed = new Headers(init?.headers ?? {}).get('Authorization')?.startsWith(`Bearer ${TOKEN}`) === true;
        if (!signed) return jsonAnswer({ error: { errors: [{ reason: 'notFound' }] } }, 404);
        if (url.includes(`/files/${DRIVE_ID}?fields=`)) return jsonAnswer(driveItem);
        return url.includes(`/files/${DRIVE_ID}?alt=media`) ? bytesAnswer(csr, init) : null;
      },
    },
    {
      name: 'OneDrive (Microsoft sign-in)',
      link: share,
      providers: { onedrive: createOneDriveProvider({ microsoft: fakeMicrosoft() }) },
      private: true,
      route: (url, init) => {
        if (url.startsWith('https://graph.microsoft.com/')) {
          const select = new URL(url).searchParams.get('$select');
          if (select === null) return jsonAnswer(graphItem);
          const named = new Set(select.split(','));
          return jsonAnswer(Object.fromEntries(Object.entries(graphItem).filter(([key]) => named.has(key) && !key.startsWith('@'))));
        }
        return url === DOWNLOAD ? bytesAnswer(csr, init) : null;
      },
    },
  ];
}

function registryWith(overrides = {}) {
  return new ProviderRegistry(DEFAULT_PROVIDERS.map(provider => overrides[provider.id] ?? provider));
}

async function openLink(t, link, registry = registryWith()) {
  const source = new LinkDataSource({ registry });
  const connection = await source.connect(link);
  t.after(() => source.disconnect());
  const id = connection.defaultDatasetId ?? connection.datasets[0].id;
  // The dataset is opened as the app opens it, then read through its adapter.
  await source.getMetadata(id);
  return source.getAnnDataSource(id).getAdapter();
}

async function openLocal(t, bytes, name) {
  const source = new AnnDataFileSource();
  t.after(() => source.clear());
  await source.loadFile(new File([bytes], name));
  return source.getAdapter();
}

/**
 * What every path must give: the genes named by symbols, each keeping its
 * id; both found by a search; the first gene's cost said before it is read;
 * every gene's values exact.
 */
async function assertGenesRead(adapter, where, { cellMajor, listed = false }) {
  // Opening read no gene name: the shown axis's default is pending (unless
  // a gene route was asked for since).
  if (!listed) assert.equal(adapter.getMappingCandidates().defaults.geneNames, null, `${where}: gene names pending at opening`);
  const list = await adapter.getGeneList();
  // Listing the genes guessed them.
  const candidates = adapter.getMappingCandidates();
  assert.equal(candidates.defaults.geneNames, 'column:feature_name', `${where}: named by feature_name`);
  assert.ok(candidates.guessed.includes('geneNames'), `${where}: the choice is marked guessed`);

  const names = list.fields.map(field => field.key);
  assert.deepEqual(names, EXPECTED.symbols, `${where}: the symbols name the genes`);
  assert.equal(list.geneNames.source, 'feature_name');
  assert.deepEqual(list.geneNames.ids, EXPECTED.ids, `${where}: every gene keeps its Ensembl id`);

  // The gene search: by symbol, best match first, and by id.
  const keys = names.map(name => name.toLowerCase());
  const ids = list.geneNames.ids.map(id => id.toLowerCase());
  for (const symbol of ['SFTPC', 'EPCAM']) {
    const found = rankedMatchIndices(keys, symbol.toLowerCase(), ids);
    assert.equal(names[found[0]], symbol, `${where}: ${symbol} is found by its symbol`);
    const byId = rankedMatchIndices(keys, EXPECTED.genes[symbol].id.toLowerCase(), ids);
    assert.equal(names[byId[0]], symbol, `${where}: ${symbol} is found by its id`);
  }

  // What the first gene costs is told before it is read.
  const plan = await adapter.getGeneReadPlan('var/0');
  // A gene-major matrix (once opened) reads only the gene: nothing to weigh.
  assert.equal(plan.cellMajor === true, cellMajor, `${where}: the layout`);
  if (cellMajor) {
    assert.equal(plan.built, false);
    // Stored bytes where the store states them; a Zarr folder over HTTP
    // lists no sizes, and its cost is said in bytes as values.
    assert.ok(plan.scan.storedBytes > 0 || (plan.scan.storedBytes === null && plan.scan.valueBytes > 0),
      `${where}: what the first gene reads`);
    assert.ok(plan.index !== null && ['memory', 'disk'].includes(plan.index.placement));
    assert.match(describeGeneReadPlan(plan), /stored cell by cell, so the first gene reads every cell's entries: \d/);
  } else {
    assert.equal(describeGeneReadPlan(plan), null, `${where}: a gene-major gene reads only itself`);
  }

  for (const [symbol, gene] of Object.entries(EXPECTED.genes)) {
    const values = await adapter.getGeneValues(`var/${gene.position}`);
    assert.deepEqual(Array.from(values), gene.values.map(Math.fround), `${where}: ${symbol}'s values`);
  }
  if (cellMajor) {
    const after = await adapter.getGeneReadPlan('var/1');
    assert.equal(describeGeneReadPlan(after), null, `${where}: once indexed, a gene reads only itself`);
  }
}

for (const provider of providerCases()) {
  test(`${provider.name}: genes are found by symbol and id, their cost said, their values exact`, async t => {
    quiet(t);
    const calls = host(t, provider.route);
    const adapter = await openLink(t, provider.link, registryWith(provider.providers ?? {}));
    await assertGenesRead(adapter, provider.name, { cellMajor: true });
    if (provider.private) {
      // A sign-in's token goes only to the host it was issued for.
      for (const call of calls.filter(item => item.headers.authorization)) {
        assert.ok(['www.googleapis.com', 'graph.microsoft.com'].includes(new URL(call.url).host), call.url);
      }
    }
  });
}

test('a gene is read from every layout: CSC, dense in row chunks, a Zarr zip and a Zarr folder over HTTP', async t => {
  quiet(t);
  const prefix = 'https://data.example.org/layouts/';
  host(t, (url, init) => {
    if (!url.startsWith(prefix)) return null;
    const path = decodeURIComponent(url.slice(prefix.length));
    if (path === 'csc.h5ad') return bytesAnswer(FILES.csc, init);
    if (path === 'dense.h5ad') return bytesAnswer(FILES.dense, init);
    if (path === 'hlca.zarr.zip') return bytesAnswer(FILES.zarrZip, init);
    if (path.startsWith('hlca.zarr/')) {
      const entry = STORE.get(path.slice('hlca.zarr/'.length));
      return entry === undefined ? null : bytesAnswer(entry, init);
    }
    return null;
  });
  await assertGenesRead(await openLink(t, `${prefix}csc.h5ad`), 'CSC', { cellMajor: false });
  // Chunks of whole rows, but a whole column strip of them fits the decoded
  // chunk budget: a gene reads its strip, as a gene-major one does.
  await assertGenesRead(await openLink(t, `${prefix}dense.h5ad`), 'dense in row chunks', { cellMajor: false });
  await assertGenesRead(await openLink(t, `${prefix}hlca.zarr.zip`), 'Zarr zip', { cellMajor: true });
  await assertGenesRead(await openLink(t, `${prefix}hlca.zarr/`), 'Zarr folder', { cellMajor: true });
});

test('a local file: CSR, CSC and dense, read as the browser reads a picked file', async t => {
  quiet(t);
  await assertGenesRead(await openLocal(t, FILES.csr, 'hlca.h5ad'), 'local CSR', { cellMajor: true });
  await assertGenesRead(await openLocal(t, FILES.csc, 'hlca-csc.h5ad'), 'local CSC', { cellMajor: false });
  await assertGenesRead(await openLocal(t, FILES.dense, 'hlca-dense.h5ad'), 'local dense', { cellMajor: false });
  await assertGenesRead(await openLocal(t, FILES.zarrZip, 'hlca.zarr.zip'), 'local Zarr zip', { cellMajor: true });
});

test('raw.X of a CELLxGENE file is named by its own feature_name, and a modality switch keeps the rule', async t => {
  quiet(t);
  const adapter = await openLocal(t, FILES.csr, 'hlca.h5ad');
  assert.deepEqual(adapter.getMappingCandidates().geneNameColumns, {}, 'no axis is guessed at opening');
  // Each axis is guessed when it is first asked for, on its own.
  const raw = await adapter.guessGeneNames('raw');
  assert.deepEqual(raw.geneNameColumns, { raw: 'feature_name' });
  assert.equal(raw.defaults.geneNames, null, 'the shown axis (X) is still pending');
  const both = await adapter.guessGeneNames('X');
  assert.deepEqual(both.geneNameColumns, { raw: 'feature_name', X: 'feature_name' });
  assert.equal(both.defaults.geneNames, 'column:feature_name');
  await assert.rejects(adapter.guessGeneNames('mod/rna'), RangeError);
});

test('the identifier rule: ids by share of a sample, symbols by content, columns read lazily', async () => {
  const { inferGeneNameColumn, looksLikeGeneIdentifier, namesAreIdentifiers } = await import('../assets/js/data/gene-names.js');
  for (const id of ['ENSG00000168484', 'ENSMUSG00000064370.1', 'FBgn0000008', 'WBGene00000001', 'HGNC:5', '7157', 'NM_000546', 'P04637', 'A0A024RBG1']) {
    assert.ok(looksLikeGeneIdentifier(id), id);
  }
  for (const symbol of ['SFTPC', 'Sftpc', 'MT-CO1', 'HLA-DRB1', 'CD3E', 'TP53', 'P2RX7', 'C1QTNF1', 'S100A8', 'E2F1', 'H2AZ1']) {
    assert.ok(!looksLikeGeneIdentifier(symbol), symbol);
  }
  // A symbol index with LINC/LOC/Gm/clone names is not one of identifiers:
  // the rule is a share (90 %), never one name.
  const symbolIndex = Array.from({ length: 1000 }, (_, i) => (i % 10 === 0 ? `LINC${String(i).padStart(5, '0')}` : `GENE${i}X`));
  assert.equal(namesAreIdentifiers(symbolIndex), false);
  const ids = Array.from({ length: 20 }, (_, i) => `ENSG${String(i + 1).padStart(11, '0')}`);
  const syms = ids.map((_, i) => `SYM${i}A`);
  const columns = {
    interval: ids.map((_, i) => `chr1:${1000 + i * 100}-${1050 + i * 100}`),
    uniprot_id: ids.map((_, i) => `P0${4600 + i}`),
    biotype: ids.map(() => 'gene'),
    description: ids.map((_, i) => `protein ${i} kinase`),
    gene_ids: ids,
    hgnc_symbol: syms,
    feature_name: syms,
  };
  const reads = [];
  const read = key => {
    reads.push(key);
    return Promise.resolve(columns[key] ?? null);
  };
  // Nothing is read for an index of symbols.
  assert.equal(await inferGeneNameColumn(symbolIndex, Object.keys(columns), read), null);
  assert.deepEqual(reads, []);
  // A conventional name first: only it is read.
  assert.equal(await inferGeneNameColumn(ids, Object.keys(columns), read), 'feature_name');
  assert.deepEqual(reads, ['feature_name']);
  // Otherwise by content: intervals, accessions, biotypes, sentences and the
  // index again are not symbols.
  reads.length = 0;
  const others = ['interval', 'uniprot_id', 'biotype', 'description', 'gene_ids', 'hgnc_symbol'];
  assert.equal(await inferGeneNameColumn(ids, others, read), 'hgnc_symbol');
  assert.equal(await inferGeneNameColumn(ids, ['interval', 'uniprot_id', 'biotype'], read), null);
  // A column that cannot be read is passed over.
  assert.equal(await inferGeneNameColumn(ids, ['broken', 'hgnc_symbol'], key => (key === 'broken' ? Promise.resolve(null) : read(key))), 'hgnc_symbol');
});

test('the first gene of an atlas stored cell by cell is said to cost the whole matrix, before it is read', () => {
  // The Human Lung Cell Atlas's Census copy, as `geneReadPlan` describes it
  // over a 1.4 MB/s link: 4.0 billion stored values whose int64 indices
  // store 4.7 GB, and no gene index this browser can keep.
  const hlca = {
    label: 'X',
    cellMajor: true,
    layout: 'csr',
    entries: 4_033_400_260,
    built: false,
    scan: { storedBytes: 4.7 * 2 ** 30, valueBytes: 4_033_400_260 * 8 },
    index: {
      residentBytes: 4_033_400_260 * 4,
      passes: 2,
      storeBytes: 4_033_400_260 * 8,
      secondPassStoredBytes: 12 * 2 ** 30,
      placement: null,
      refusal: 'the gene index needs 30 GB: more than the 3.0 GB of memory this browser keeps for it, and 20 GB of disk storage is left to this site',
    },
    bytesPerSecond: 1.4 * 2 ** 20,
  };
  assert.equal(
    describeGeneReadPlan(hlca),
    "X is stored cell by cell, so the first gene reads every cell's entries: 4.7 GB (~57 min 18 s at the measured 1.4 MB/s). " +
    'No gene index of it can be kept (the gene index needs 30 GB: more than the 3.0 GB of memory this browser keeps ' +
    'for it, and 20 GB of disk storage is left to this site), so every gene reads it again; opening a subsample of ' +
    'the cells makes the index fit.'
  );
  // Kept on disk after a second pass: said with that pass's bytes.
  assert.match(
    describeGeneReadPlan({ ...hlca, index: { ...hlca.index, placement: 'disk', refusal: null } }),
    /Then 12 GB is read once more to keep a gene index on disk; later genes read only it\.$/
  );
  // Before the link is measured: the bytes, without a time.
  assert.match(describeGeneReadPlan({ ...hlca, bytesPerSecond: null }), /entries: 4\.7 GB\. /);
  // A built index, or a gene-major matrix: nothing to say.
  assert.equal(describeGeneReadPlan({ ...hlca, built: true }), null);
  assert.equal(describeGeneReadPlan({ ...hlca, cellMajor: false }), null);
});

/**
 * The Python server (`cellucid serve`, `serve_anndata()`, `show_anndata()`)
 * as it answers, for one served store: its health, its dataset list, and
 * the store's bytes in place (a file by ranges, a Zarr folder key by key).
 */
function pythonServer(t, store) {
  return host(t, (url, init) => {
    const path = decodeURIComponent(new URL(url).pathname.slice(1));
    const counts = { n_cells: EXPECTED.n_obs, n_genes: EXPECTED.n_vars };
    if (path === '_cellucid/health') return jsonAnswer({ status: 'ok', type: 'anndata', version: '1.2.3', format: store.file.kind, ...counts });
    if (path === '_cellucid/info') return jsonAnswer({ version: '1.2.3', type: 'anndata', format: store.file.kind, host: '127.0.0.1', port: 8765, ...counts, runtime: 'python' });
    if (path === '_cellucid/protocol') return jsonAnswer(PROTOCOL);
    if (path === '_cellucid/datasets') return jsonAnswer({ datasets: [{ id: 'cells', name: 'Served cells', anndata: { file: store.file, defaults: {} } }] });
    if (store.bytes !== undefined && path === store.file.url) return bytesAnswer(store.bytes, init);
    if (store.keys !== undefined && path.startsWith(store.file.url)) {
      const bytes = store.keys.get(path.slice(store.file.url.length));
      return bytes === undefined ? null : bytesAnswer(bytes, init);
    }
    return null;
  });
}

const SERVED = [
  // Each file listed with the ETag its bytes are answered with (`bytesAnswer`).
  { layout: 'file', file: { url: '_cellucid/anndata/hlca.h5ad', kind: 'h5ad', layout: 'file', size: FILES.csr.length, etag: `"${sha256(FILES.csr).slice(0, 16)}"` }, bytes: FILES.csr },
  { layout: 'zip', file: { url: '_cellucid/anndata/hlca.zarr.zip', kind: 'zarr', layout: 'zip', size: FILES.zarrZip.length, etag: `"${sha256(FILES.zarrZip).slice(0, 16)}"` }, bytes: FILES.zarrZip },
  { layout: 'folder', file: { url: '_cellucid/anndata/hlca.zarr/', kind: 'zarr', layout: 'folder' }, keys: STORE },
];

for (const store of SERVED) {
  test(`cellucid serve, a served ${store.layout}: genes are found by symbol and id, their cost said, their values exact`, async t => {
    quiet(t);
    pythonServer(t, store);
    const source = new RemoteDataSource();
    await source.connect({ url: 'http://127.0.0.1:8765' });
    t.after(() => source.disconnect());
    await source.listDatasets();
    await source.getMetadata('cells');
    await assertGenesRead(source.getAnnDataSource().getAdapter(), `served ${store.layout}`, { cellMajor: true });
  });
}

test('the viewer host (show_anndata in a notebook): genes are found by symbol and id, their cost said, their values exact', async t => {
  quiet(t);
  pythonServer(t, SERVED[0]);
  const previousWindow = globalThis.window;
  globalThis.window = { location: new URL('http://127.0.0.1:8765/?viewer=true&viewerId=viewer-1&viewerToken=secret-1&anndata=true') };
  t.after(() => {
    globalThis.window = previousWindow;
  });
  const source = new ViewerHostDataSource({ serverUrl: 'http://127.0.0.1:8765', viewerId: 'viewer-1', viewerToken: 'secret-1' });
  assert.equal(await source.initialize(), true);
  t.after(() => source.disconnect());
  await source.listDatasets();
  await source.getMetadata('cells');
  await assertGenesRead(source.getAnnDataSource().getAdapter(), 'viewer host', { cellMajor: true });
});

test('over a link slower than a disk, a CSR gene reads the indices once and its own values, and is said to', async t => {
  quiet(t);
  // 8 ms a round trip, 4 MB/s: slower than the reader turns bytes into an
  // index, so the values stay in the file until a gene needs them.
  const calls = host(t, async (url, init) => {
    if (url !== 'https://slow.example.org/hlca.h5ad') return null;
    const answer = bytesAnswer(FILES.csr, init);
    const length = Number(answer.headers.get('Content-Length') ?? 0);
    await new Promise(resolve => setTimeout(resolve, 8 + (init?.method === 'HEAD' ? 0 : length / 4000)));
    return answer;
  });
  const adapter = await openLink(t, 'https://slow.example.org/hlca.h5ad');
  const before = await adapter.getGeneReadPlan('var/0');
  // The measured link, and a first pass of the row pointers and int64
  // column indices only: the values are not part of it.
  assert.ok(before.bytesPerSecond > 0 && before.bytesPerSecond < 64e6, `measured slow, got ${before.bytesPerSecond}`);
  assert.equal(before.scan.valueBytes, (EXPECTED.n_obs + 1) * 8 + EXPECTED.nnz * 8);
  assert.equal(before.index.passes, 1, 'the indices kept are the index: no second pass');
  assert.match(describeGeneReadPlan(before), / at the measured [\d.]+ [KM]B\/s\)\. Later genes read the gene index it builds\.$/);
  await assertGenesRead(adapter, 'a slow link', { cellMajor: true, listed: true });
  const plan = await adapter.getGeneReadPlan('var/0');
  assert.equal(plan.built, true);
  assert.ok(calls.length > 0);
});

/** One file of a format corpus archive (`tests/fixtures/<folder>/<archive>.zip`). */
async function corpusFile(archive, inside) {
  const { openZipArchive } = await import('../assets/js/formats/zip/index.js');
  const { createByteReader } = await import('../assets/js/formats/io/byte-reader.js');
  const { bytesByteSource } = await import('../assets/js/formats/io/byte-source.js');
  const zip = await openZipArchive(createByteReader(bytesByteSource(
    new Uint8Array(readFileSync(new URL(`./fixtures/${archive}`, import.meta.url))), { name: archive }
  )), { name: archive });
  return (await zip.entry(inside).read()).slice();
}

/** The first genes of a dataset's own gene list, names and values. */
async function firstGenes(adapter, count = 3) {
  const list = await adapter.getGeneList();
  assert.ok(list.fields.length > 0, 'the dataset lists genes');
  const genes = [];
  for (let gene = 0; gene < Math.min(count, list.fields.length); gene++) {
    genes.push({ name: list.fields[gene].key, values: Array.from(await adapter.getGeneValues(`var/${gene}`)) });
  }
  return genes;
}

// Every format a person brings that is not AnnData, opened by a link: the
// genes read are those the same file gives on this computer (whose values
// the corpus tests hold to the format's own library).
const FORMATS_BY_LINK = [
  ['Loom', 'loom/loompy-3.0.8.zip', 'basic.loom'],
  ['MuData .h5mu', 'mudata/mudata-0.4.1.zip', 'citeseq-subset.h5mu'],
  ['MuData Zarr (zip)', 'mudata/mudata-0.4.1.zip', 'citeseq-subset.zarr.zip'],
  ['Seurat .rds', 'rds/corpus.zip', 'rds/seurat5_gzip.rds'],
  ['SingleCellExperiment .rds', 'rds/corpus.zip', 'rds/sce.rds'],
  ['Seurat .rda', 'rds/corpus.zip', 'rds/SeuratObject_5.4.0_pbmc_small.rda'],
];

for (const [format, archive, inside] of FORMATS_BY_LINK) {
  test(`${format} by link: the genes read are those the file gives on this computer`, async t => {
    quiet(t);
    const bytes = await corpusFile(archive, inside);
    const name = inside.split('/').at(-1);
    const local = await firstGenes(await openLocal(t, bytes, name));
    host(t, (url, init) => (url === `https://data.example.org/formats/${name}` ? bytesAnswer(bytes, init) : null));
    const linked = await firstGenes(await openLink(t, `https://data.example.org/formats/${name}`));
    assert.deepEqual(linked, local);
  });
}

/** Every file below `prefix` in a corpus archive, by its path inside the folder. */
async function corpusFolder(archive, prefix) {
  const { openZipArchive } = await import('../assets/js/formats/zip/index.js');
  const { createByteReader } = await import('../assets/js/formats/io/byte-reader.js');
  const { bytesByteSource } = await import('../assets/js/formats/io/byte-source.js');
  const zip = await openZipArchive(createByteReader(bytesByteSource(
    new Uint8Array(readFileSync(new URL(`./fixtures/${archive}`, import.meta.url))), { name: archive }
  )), { name: archive });
  const files = new Map();
  for (const entry of zip.entries) {
    if (entry.path.startsWith(prefix) && !entry.path.endsWith('/')) files.set(entry.path.slice(prefix.length), (await entry.read()).slice());
  }
  assert.ok(files.size > 0, `${prefix} is in ${archive}`);
  return files;
}

// Folders: a MatrixMarket folder and a Cell Ranger outs/ folder, picked on
// this computer and served as a set of files on a host (`cellucid serve`, a
// GEO series' files): the same genes.
for (const [format, archive, prefix] of [
  ['MatrixMarket folder', 'rds/corpus.zip', 'mtx/kb/'],
  ['Cell Ranger outs/ folder', 'tenx/tenx.zip', 'v3-citeseq-outs/'],
]) {
  test(`${format}: the genes read from a host are those the folder gives on this computer`, async t => {
    quiet(t);
    const files = await corpusFolder(archive, prefix);
    const root = prefix.split('/').at(-2);
    const picked = [...files].map(([path, bytes]) => {
      const file = new File([bytes], path.split('/').at(-1));
      Object.defineProperty(file, 'webkitRelativePath', { value: `${root}/${path}` });
      return file;
    });
    const localSource = new AnnDataFileSource();
    t.after(() => localSource.clear());
    await localSource.loadFolder(picked);
    const local = await firstGenes(localSource.getAdapter());
    const remote = new Map();
    for (const [path, bytes] of files) {
      remote.set(path, { url: `https://data.example.org/${root}/${path}`, size: bytes.length, name: path.split('/').at(-1) });
    }
    host(t, (url, init) => {
      const path = url.startsWith(`https://data.example.org/${root}/`) ? url.slice(`https://data.example.org/${root}/`.length) : null;
      return path !== null && files.has(path) ? bytesAnswer(files.get(path), init) : null;
    });
    const served = new AnnDataFileSource();
    t.after(() => served.clear());
    await served.loadRemoteFileSet({ files: remote, rootName: root });
    assert.deepEqual(await firstGenes(served.getAdapter()), local);
  });
}

test('stored-value positions past 2^31 and 2^32 read exactly, as a CSR scan and a gene\'s values read them', async () => {
  const { openHdf5 } = await import('../assets/js/formats/hdf5/index.js');
  const { createByteReader } = await import('../assets/js/formats/io/byte-reader.js');
  const { bytesByteSource } = await import('../assets/js/formats/io/byte-source.js');
  const { readIntegers, readNumbers } = await import('../assets/js/data/anndata/values.js');
  const { sparseIndexPlan } = await import('../assets/js/data/sparse-column-index.js');
  const bytes = new Uint8Array(readFileSync(new URL('positions-beyond-2-32.h5', FIXTURES)));
  const root = await openHdf5(createByteReader(bytesByteSource(bytes, { name: 'positions-beyond-2-32.h5' })));
  const indices = root.get('indices');
  const data = root.get('data');
  assert.equal(indices.shape[0], 5_000_000_000);
  for (const boundary of [2 ** 31, 2 ** 32]) {
    // A range inside the written chunk: every value its own position, exactly.
    const start = boundary - 3;
    const read = await readIntegers(indices, start, boundary + 3, 'indices');
    assert.deepEqual(Array.from(read), Array.from({ length: 6 }, (_, i) => start + i), `int64 indices at ${boundary}`);
    const values = await readNumbers(data, start, boundary + 3, 'data');
    assert.deepEqual(Array.from(values), Array.from({ length: 6 }, (_, i) => Math.fround(start + i)), `float32 values at ${boundary}`);
    // Across into a chunk never written: the fill value.
    const chunkEnd = Math.ceil((boundary + 1) / 1000) * 1000;
    const across = await readIntegers(indices, chunkEnd - 2, chunkEnd + 2, 'indices');
    assert.deepEqual(Array.from(across), [chunkEnd - 2, chunkEnd - 1, 0, 0]);
  }
  // The same in a Zarr array whose chunk keys pass 2^31 and 2^32.
  const { memoryStore, openZarr } = await import('../assets/js/formats/zarr/index.js');
  const entries = new Map([
    ['.zgroup', new TextEncoder().encode('{"zarr_format": 2}')],
    ['indices/.zarray', new TextEncoder().encode(JSON.stringify({
      zarr_format: 2, shape: [5e9], chunks: [1000], dtype: '<i8', compressor: null, fill_value: 0, order: 'C', filters: null,
    }))],
  ]);
  for (const boundary of [2 ** 31, 2 ** 32]) {
    const chunk = Math.floor(boundary / 1000);
    entries.set(`indices/${chunk}`, new Uint8Array(BigInt64Array.from({ length: 1000 }, (_, i) => BigInt(chunk * 1000 + i)).buffer));
  }
  const zarr = await openZarr(memoryStore(entries), { consolidated: false });
  for (const boundary of [2 ** 31, 2 ** 32]) {
    const read = await readIntegers(zarr.get('indices'), boundary - 3, boundary + 3, 'indices');
    assert.deepEqual(Array.from(read), Array.from({ length: 6 }, (_, i) => boundary - 3 + i), `Zarr int64 at ${boundary}`);
  }
  // The lung atlas's index plan: 4,033,400,260 entries keep 32-bit positions
  // (under 2^32); past 2^32 they take 64 bits, never a wrapped 32.
  const hlca = sparseIndexPlan({ nnz: 4_033_400_260, nCols: 55_329, nRows: 2_282_447, valuesOnDemand: true, retainIndicesBytes: 3 * 2 ** 30 });
  assert.equal(hlca.keepsIndices, false, '8 GB of uint16 indices do not fit 3 GB');
  assert.equal(hlca.passes, 2);
  assert.equal(hlca.storeBytes, 4_033_400_260 * 8 + 55_329 * 16);
  assert.equal(hlca.structureBytes, 4_033_400_260 * 4 + (2_282_447 + 1 + 55_329 + 1) * 8);
  assert.equal(sparseIndexPlan({ nnz: 5e9, nCols: 10, nRows: 10, valuesOnDemand: true, retainIndicesBytes: 0 }).structureBytes, 5e9 * 8 + 22 * 8);
});

test('the stated cost is exact: the stored bytes of each pass, as the plan reads them', async t => {
  quiet(t);
  const { openHdf5 } = await import('../assets/js/formats/hdf5/index.js');
  const { createByteReader } = await import('../assets/js/formats/io/byte-reader.js');
  const { bytesByteSource } = await import('../assets/js/formats/io/byte-source.js');
  const { sparseIndexPlan } = await import('../assets/js/data/sparse-column-index.js');
  const { residencyBudgetBytes } = await import('../assets/js/data/memory-budget.js');
  const root = await openHdf5(createByteReader(bytesByteSource(FILES.csr, { name: 'hlca.h5ad' })));
  const stored = await Promise.all(['indptr', 'indices', 'data'].map(name => root.get(`X/${name}`).storedBytes()));
  const [indptr, indices, data] = stored;
  const adapter = await openLocal(t, FILES.csr, 'hlca.h5ad');
  const plan = await adapter.getGeneReadPlan('var/0');
  // A local file reads ahead: pass 1 reads pointers, indices and values.
  assert.equal(plan.scan.storedBytes, indptr + indices + data);
  const expected = sparseIndexPlan({
    nnz: EXPECTED.nnz, nCols: EXPECTED.n_vars, nRows: EXPECTED.n_obs, valuesOnDemand: false,
    retainIndicesBytes: residencyBudgetBytes('columnIndex'),
  });
  assert.equal(plan.index.passes, expected.passes);
  // Pass 2 reads the pointers again, and what pass 1 did not keep.
  assert.equal(plan.index.secondPassStoredBytes,
    indptr + (expected.keepsIndices ? 0 : indices) + (expected.keepsValues ? 0 : data));
});

test('a launch geneIdColumn names the genes of the matrix it opens with; raw keeps its own guess', async t => {
  quiet(t);
  const source = new AnnDataFileSource();
  t.after(() => source.clear());
  // A launch may name any column that can name genes, even one of few values.
  await source.loadFile(new File([FILES.csr], 'hlca.h5ad'), { defaults: { geneIdColumn: 'feature_biotype' } });
  const opened = source.getAdapter().getMappingCandidates();
  // Named by the launch: nothing to guess, nothing pending.
  assert.equal(opened.defaults.geneNames, 'column:feature_biotype');
  assert.equal(opened.geneNameColumns.X, 'feature_biotype');
  assert.equal(Object.hasOwn(opened.geneNameColumns, 'raw'), false, 'raw.X is guessed when it is chosen');
  const candidates = await source.getAdapter().guessGeneNames('raw');
  assert.equal(candidates.geneNameColumns.raw, 'feature_name', 'raw.X keeps its own default');
  assert.equal(candidates.defaults.geneNames, 'column:feature_biotype');
  assert.ok(!candidates.guessed.includes('geneNames'), 'a launch choice is not a guess');
});

test('a gene-name guess whose index cannot be read fails that guess alone, and is tried again', async () => {
  const { BaseAnnDataAdapter, GeneNameGuesses } = await import('../assets/js/data/base-anndata-adapter.js');
  const ids = Array.from({ length: 30 }, (_, i) => `ENSG${String(i + 1).padStart(11, '0')}`);
  const reads = [];
  const loader = {
    readVarNames: async (axis, column) => {
      reads.push([axis, column]);
      if (axis === 'raw') throw new Error('raw.var index could not be read');
      if (column === null) return { index: ids, values: ids };
      if (column === 'feature_name') return { index: ids, values: ids.map((_, i) => `SYM${i}A`) };
      throw new Error(`no column ${column}`);
    },
  };
  const textColumn = key => ({ key, dtype: 'categorical', usable: true, reason: null });
  const described = {
    modalities: null,
    X: { storage: 'csr', dtype: 'float32' },
    layers: [],
    var: { columns: [textColumn('notes'), textColumn('feature_name'), { key: 'feature_length', dtype: 'int64', usable: true, reason: null }] },
    raw: { X: { storage: 'csr', dtype: 'float32' }, var: { columns: [textColumn('feature_name')] } },
  };
  // An adapter as `initialize()` leaves it, with the catalog stubbed.
  const adapter = Object.assign(Object.create(BaseAnnDataAdapter.prototype), {
    _loader: loader,
    _closed: false,
    _lifecycleGeneration: 0,
    _geneNameGuesses: new GeneNameGuesses(),
    _catalogInputs: { described },
    getMappingCandidates: () => 'the catalog',
  });
  assert.equal(await adapter.guessGeneNames('X'), 'the catalog');
  assert.deepEqual(adapter._geneNameGuesses.settled(), { X: 'feature_name' });
  // A var index that cannot be read is no guess of the index: the guess
  // fails, nothing is kept, and the next ask reads again.
  await assert.rejects(adapter.guessGeneNames('raw'), /raw.var index could not be read/);
  assert.deepEqual(adapter._geneNameGuesses.settled(), { X: 'feature_name' });
  await assert.rejects(adapter.guessGeneNames('raw'), /raw.var index could not be read/);
  assert.equal(reads.filter(([axis]) => axis === 'raw').length, 2);
  // The conventional column is read first, and nothing after it; the
  // integer column never.
  assert.deepEqual(reads.filter(([axis]) => axis === 'X'), [['X', null], ['X', 'feature_name']]);
});
