/**
 * What each link provider costs before and beside the bytes: the same file
 * (a corpus `.h5ad`) reached through every provider the app opens links
 * from, each host faked as `tests/gene-read-every-source.test.mjs` fakes it
 * (a web address; CELLxGENE's Census release document and bucket; GEO's
 * listing; Zenodo's and Figshare's APIs, Figshare's signed S3 redirect;
 * Hugging Face's revision API; Dropbox; GitHub plain and LFS; Google Drive
 * public and signed in; OneDrive through Microsoft Graph), every answer
 * held to one throttled link (a round trip each, one shared bandwidth, six
 * requests at once). The app's own path: `LinkDataSource.connect`, the
 * dataset's metadata, its adapter, then a first gene. Prints one table: the
 * requests and time to the opened dataset and to the first gene, the API
 * requests before the first byte of the file, and the bytes.
 *
 *   node scripts/efficiency-floor/providers.mjs CORPUS [--file csr-gzip.h5ad] [--latency 150] [--bandwidth 5]
 *
 * @module scripts/efficiency-floor/providers
 */

import '../../tests/helpers/anndata-reader-in-process.mjs';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

import { getNotificationCenter } from '../../assets/js/app/notification-center.js';
import { LinkDataSource } from '../../assets/js/data/link-source.js';
import { DEFAULT_PROVIDERS, ProviderRegistry } from '../../assets/js/data/sources/registry.js';
import { CENSUS_BUCKET_URL } from '../../assets/js/data/sources/providers/cellxgene.js';
import { createDriveProvider } from '../../assets/js/data/sources/providers/gdrive.js';
import { createOneDriveProvider } from '../../assets/js/data/sources/providers/onedrive.js';

const argument = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const corpus = path.resolve(process.argv[2]);
const file = path.join(corpus, argument('--file', 'csr-gzip.h5ad'));
const latencyMs = Number(argument('--latency', '150'));
const bytesPerMs = Number(argument('--bandwidth', '5')) * 1e3;
const size = statSync(file).size;
const fd = openSync(file, 'r');
const etag = `"${createHash('sha256').update(String(size)).digest('hex').slice(0, 16)}"`;

for (const name of ['loading', 'complete', 'fail', 'dismiss', 'progress', 'updateProgress', 'warning', 'error', 'info',
  'startDownload', 'updateDownload', 'completeDownload', 'failDownload', 'dismissDownload']) {
  getNotificationCenter()[name] = () => 'quiet';
}
console.log = console.warn = console.info = () => {};

/** The corpus file as a static host answers it: HEAD, a ranged GET, a whole GET. */
function bytesAnswer(init) {
  const base = { 'Accept-Ranges': 'bytes', ETag: etag };
  if ((init?.method ?? 'GET') === 'HEAD') return new Response(null, { status: 200, headers: { ...base, 'Content-Length': String(size) } });
  const range = new Headers(init?.headers ?? {}).get('Range');
  const match = range === null ? null : /^bytes=(\d+)-(\d*)$/.exec(range);
  const start = match === null ? 0 : Number(match[1]);
  const end = match === null || match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  const bytes = new Uint8Array(end - start + 1);
  readSync(fd, bytes, 0, bytes.length, start);
  return new Response(bytes, {
    status: match === null ? 200 : 206,
    headers: { ...base, 'Content-Length': String(bytes.length), ...(match === null ? {} : { 'Content-Range': `bytes ${start}-${end}/${size}` }) },
  });
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const CENSUS_ID = '9f222629-9e39-47d0-b83f-e08d610c7479';
const DRIVE_ID = '1l_5RK28JRL19wpT22B-DY9We3TVXnnQQ';
const TOKEN = 'TOKEN-efficiency-floor';
const DOWNLOAD = 'https://my.microsoftpersonalcontent.com/personal/x/download.aspx?tempauth=T';
const commit = 'a'.repeat(40);

function fakeGoogle() {
  const state = { token: null };
  return Object.assign(state, {
    apiKey: 'AIza-PUBLIC-KEY', whyNoPublicAccess: () => null, whyNoSignIn: () => null, loadScripts: async () => {},
    validToken: () => state.token, authorize: async () => { state.token = `${TOKEN}-g`; return state.token; },
    pick: async id => id, refused: () => {}, signOut: () => {}, signedIn: () => state.token !== null,
  });
}
function fakeMicrosoft() {
  const state = { token: null };
  return Object.assign(state, {
    whyNoSignIn: () => null, hasWideAccess: () => false, silentToken: async () => state.token,
    authorize: async () => { state.token = `${TOKEN}-ms`; return state.token; }, refused: () => {}, signOut: () => {}, signedIn: () => state.token !== null,
  });
}

/** Each provider, its link and its host (the hosts of `gene-read-every-source`). */
function providers() {
  const driveItem = { id: DRIVE_ID, name: 'data.h5ad', size: String(size), md5Checksum: 'd41d', mimeType: 'application/octet-stream', capabilities: { canDownload: true } };
  const graphItem = { id: '12A1B84EDEBF20F7!101', name: 'data.h5ad', size, file: {}, cTag: 'c1', webUrl: 'https://onedrive.live.com/?id=x', parentReference: { driveId: '12a1b84edebf20f7' }, '@microsoft.graph.downloadUrl': DOWNLOAD };
  const fileUrl = (url, prefix) => url === prefix;
  return [
    { name: 'a web address (the baseline)', link: 'https://data.example.org/atlas/data.h5ad', route: (url, init) => (fileUrl(url, 'https://data.example.org/atlas/data.h5ad') ? bytesAnswer(init) : null) },
    {
      name: 'CELLxGENE (Census release, S3 bucket)', link: `cellxgene:${CENSUS_ID}`,
      route: (url, init) => {
        if (url.endsWith('/cell-census/release.json')) return json({ stable: '2025-01-30', latest: '2025-11-10', '2025-11-10': { release_build: '2025-11-10', h5ads: { relative_uri: '/cell-census/2025-11-10/h5ads/' } } });
        return url === `${CENSUS_BUCKET_URL}/cell-census/2025-11-10/h5ads/${CENSUS_ID}.h5ad` ? bytesAnswer(init) : null;
      },
    },
    {
      name: 'GEO (listing)', link: 'geo:GSE351300',
      route: (url, init) => (url === 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE351nnn/GSE351300/suppl/'
        ? new Response('<a href="GSE351300_data.h5ad">GSE351300_data.h5ad</a>', { status: 200 })
        : url.endsWith('/GSE351300_data.h5ad') ? bytesAnswer(init) : null),
    },
    {
      name: 'Zenodo (record API)', link: 'zenodo:7',
      route: (url, init) => (url === 'https://zenodo.org/api/records/7'
        ? json({ id: 9, conceptrecid: '7', doi: '10.5281/zenodo.9', metadata: { title: 'Atlas', license: { id: 'cc-by-4.0' } }, files: [{ key: 'data.h5ad', size, checksum: 'md5:bb' }] })
        : url === 'https://zenodo.org/api/records/9/files/data.h5ad/content' ? bytesAnswer(init) : null),
    },
    {
      name: 'Figshare (API, signed S3 redirect)', link: 'figshare:16566057',
      route: (url, init) => {
        if (url === 'https://api.figshare.com/v2/articles/16566057') {
          return json({ id: 16566057, version: 1, title: 'data.h5ad', doi: '10.6084/m9.figshare.16566057.v1', figshare_url: 'https://figshare.com/articles/dataset/x/16566057', license: { name: 'CC BY 4.0' }, files: [{ id: 30639279, name: 'data.h5ad', size, computed_md5: 'abc', is_link_only: false }] });
        }
        if (url === 'https://ndownloader.figshare.com/files/30639279') return { response: bytesAnswer(init), redirected: 'https://s3.example.org/f?X-Amz-Expires=3600&X-Amz-Signature=sig' };
        return url.startsWith('https://s3.example.org/f?') ? bytesAnswer(init) : null;
      },
    },
    {
      name: 'Hugging Face (revision API)', link: 'hf:lab/atlas/data.h5ad',
      route: (url, init) => (url.startsWith('https://huggingface.co/api/datasets/lab/atlas/revision/main')
        ? json({ sha: commit, siblings: [{ rfilename: 'data.h5ad', size: 10, lfs: { size, sha256: 'x' } }] })
        : url === `https://huggingface.co/datasets/lab/atlas/resolve/${commit}/data.h5ad` ? bytesAnswer(init) : null),
    },
    { name: 'Dropbox', link: 'https://www.dropbox.com/scl/fi/abc/data.h5ad?rlkey=k&dl=0', route: (url, init) => (url.startsWith('https://dl.dropboxusercontent.com/scl/fi/abc/data.h5ad') ? bytesAnswer(init) : null) },
    { name: 'GitHub (raw)', link: 'gh:owner/repo/data/data.h5ad', route: (url, init) => (url === 'https://raw.githubusercontent.com/owner/repo/HEAD/data/data.h5ad' ? bytesAnswer(init) : null) },
    {
      name: 'GitHub (LFS pointer, media host)', link: 'gh:owner/repo/lfs/data.h5ad',
      route: (url, init) => {
        if (url === 'https://raw.githubusercontent.com/owner/repo/HEAD/lfs/data.h5ad') {
          const pointer = new TextEncoder().encode(`version https://git-lfs.github.com/spec/v1\noid sha256:${'b'.repeat(64)}\nsize ${size}\n`);
          return new Response(pointer, { status: 200, headers: { 'Content-Length': String(pointer.length) } });
        }
        return url === 'https://media.githubusercontent.com/media/owner/repo/HEAD/lfs/data.h5ad' ? bytesAnswer(init) : null;
      },
    },
    {
      name: 'Google Drive (public, API key)', link: `gdrive:${DRIVE_ID}`, providers: () => ({ gdrive: createDriveProvider({ google: fakeGoogle() }) }),
      route: (url, init) => (url.includes(`/files/${DRIVE_ID}?fields=`) ? json(driveItem) : url.includes(`/files/${DRIVE_ID}?alt=media`) ? bytesAnswer(init) : null),
    },
    {
      name: 'OneDrive (Microsoft Graph)', link: 'https://1drv.ms/u/c/12a1b84edebf20f7/EVjJu5abc', providers: () => ({ onedrive: createOneDriveProvider({ microsoft: fakeMicrosoft() }) }),
      route: (url, init) => {
        if (url.startsWith('https://graph.microsoft.com/')) {
          const select = new URL(url).searchParams.get('$select');
          if (select === null) return json(graphItem);
          const named = new Set(select.split(','));
          return json(Object.fromEntries(Object.entries(graphItem).filter(([key]) => named.has(key) && !key.startsWith('@'))));
        }
        return url === DOWNLOAD ? bytesAnswer(init) : null;
      },
    },
  ];
}

/** `route` behind one throttled link; every request recorded. */
function throttled(route) {
  const calls = [];
  let onWire = 0;
  const waiting = [];
  let linkFreeAt = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (onWire >= 6) await new Promise(resolve => waiting.push(resolve));
    onWire++;
    try {
      if (init.signal?.aborted) throw init.signal.reason;
      const asked = performance.now();
      const answer = await route(url, init);
      const response = answer === null || answer === undefined ? new Response('not found', { status: 404 }) : (answer.response ?? answer);
      const body = new Uint8Array(await response.clone().arrayBuffer());
      const start = Math.max(asked + latencyMs, linkFreeAt);
      linkFreeAt = start + body.length / bytesPerMs;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, linkFreeAt - performance.now())));
      calls.push({ url, bytes: body.length, file: body.length > 0 && response.status === 206 });
      if (answer?.redirected) Object.defineProperty(response, 'url', { value: answer.redirected });
      return response;
    } finally {
      onWire--;
      waiting.shift()?.();
    }
  };
  return calls;
}

const rows = [];
for (const provider of providers()) {
  const calls = throttled(provider.route);
  const registry = new ProviderRegistry(DEFAULT_PROVIDERS.map(item => provider.providers?.()[item.id] ?? item));
  const source = new LinkDataSource({ registry });
  const row = { provider: provider.name };
  try {
    const started = performance.now();
    const connection = await source.connect(provider.link);
    const id = connection.defaultDatasetId ?? connection.datasets[0].id;
    await source.getMetadata(id);
    const adapter = source.getAnnDataSource(id).getAdapter();
    const firstByte = calls.findIndex(call => call.file);
    row.apiRequests = firstByte < 0 ? calls.length : firstByte;
    row.openRequests = calls.length;
    row.openMs = Math.round(performance.now() - started);
    row.openMB = +(calls.reduce((sum, call) => sum + call.bytes, 0) / 1e6).toFixed(2);
    const before = calls.length;
    const geneStarted = performance.now();
    await adapter.getGeneValues('var/0');
    row.geneMs = Math.round(performance.now() - geneStarted);
    row.geneRequests = calls.length - before;
    row.geneMB = +(calls.slice(before).reduce((sum, call) => sum + call.bytes, 0) / 1e6).toFixed(2);
    row.otherHosts = [...new Set(calls.map(call => new URL(call.url).host))].length;
  } catch (error) {
    row.error = String(error?.message ?? error).slice(0, 160);
  } finally {
    await source.disconnect?.();
  }
  rows.push(row);
  process.stderr.write(`${JSON.stringify(row)}\n`);
}
closeSync(fd);
process.stdout.write(`${JSON.stringify({ file: path.basename(file), latencyMs, bandwidthMBps: bytesPerMs / 1e3, rows })}\n`);
process.exit(0);
