/**
 * What opening a public link costs before its first byte of data, per
 * source: dependent round trips (a request sent only once an earlier answer
 * arrived is one round later) and requests. Each is the floor of that
 * source's layout -- what the source must be asked to name the file, its
 * size and its version -- and a change that adds a round or a request to a
 * source shows here. Measured on the real hosts (efficiency-floor plan,
 * "Public-link sources at the floor"): a round trip is 0.15-0.7 s from
 * Europe to these hosts, a request one of a rate-limited host's budget
 * (Zenodo: 133 a minute).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import cellxgene from '../assets/js/data/sources/providers/cellxgene.js';
import geo from '../assets/js/data/sources/providers/geo.js';
import http from '../assets/js/data/sources/providers/http.js';
import huggingface from '../assets/js/data/sources/providers/huggingface.js';
import zenodo from '../assets/js/data/sources/providers/zenodo.js';
import dropbox from '../assets/js/data/sources/providers/dropbox.js';
import github from '../assets/js/data/sources/providers/github.js';

import { virtualTime } from './helpers/virtual-time.mjs';

const ID = 'a49d9109-1d0c-4b36-8139-19aa9a83428c';
const COMMIT = '1'.repeat(40);

/** One file of `size` bytes, served with HEAD and range GETs, its `ETag` exposed. */
function file(size) {
  return (url, init) => {
    const headers = { ETag: '"v1"', 'Access-Control-Expose-Headers': 'ETag' };
    if (init.method === 'HEAD') return { status: 206, headers: { ...headers, 'Content-Length': String(size), 'Content-Range': `bytes 0-${size - 1}/${size}` } };
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? `bytes=0-${size - 1}`);
    const last = Math.min(size - 1, Number(end));
    return { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${last}/${size}` }, body: new Uint8Array(last - Number(start) + 1) };
  };
}

/**
 * `fetch` answering `routes`, each answer a few milliseconds later, with
 * the round of every request: 1 for one sent before any answer arrived,
 * else one more than the latest round answered before it was sent. The
 * answers wait on a virtual clock (`helpers/virtual-time.mjs`), which moves
 * only once every request the opening would send at this instant is sent:
 * a round counts dependent requests, never how long the machine took
 * between two sibling requests.
 */
function roundCounting(t, routes) {
  const original = globalThis.fetch;
  const time = virtualTime();
  const asked = [];
  let answered = 0;
  globalThis.fetch = async (url, init = {}) => {
    const round = answered + 1;
    const text = String(url);
    asked.push({ round, method: init.method ?? 'GET', url: text });
    const answer = routes(text, init) ?? { status: 404 };
    await time.sleep(5);
    answered = Math.max(answered, round);
    const body = init.method === 'HEAD' ? null : answer.body ?? (answer.json !== undefined ? JSON.stringify(answer.json) : answer.text ?? '');
    const response = new Response(body, { status: answer.status, headers: answer.headers ?? {} });
    Object.defineProperty(response, 'url', { value: text });
    return response;
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return {
    rounds: () => Math.max(0, ...asked.map(request => request.round)),
    requests: () => asked.length,
    asked,
  };
}

const census = {
  status: 200,
  json: { latest: '2025-11-10', '2025-11-10': { release_build: '2025-11-10', h5ads: { relative_uri: '/cell-census/2025-11-10/h5ads/' } } },
};

const SOURCES = [
  {
    // A first visit: the release list names the build the file is probed
    // in (a later visit probes the release it read last beside the list).
    // Probing a release shipped with the app beside the list was measured
    // and not adopted: two cold connections at once ended the probe 0.2 s
    // later in Node than the list's warm connection reused.
    name: 'CELLxGENE dataset id',
    open: () => cellxgene.open(ID),
    routes: (url, init) => (url.endsWith('/release.json') ? census : url.endsWith(`${ID}.h5ad`) ? file(1 << 20)(url, init) : null),
    rounds: 2,
    requests: 3,
  },
  {
    name: 'Census copy by its bucket address',
    open: () => cellxgene.open(cellxgene.match(`s3://cellxgene-census-public-us-west-2/cell-census/2025-11-10/h5ads/${ID}.h5ad`)),
    routes: (url, init) => (url.endsWith(`${ID}.h5ad`) ? file(1 << 20)(url, init) : null),
    rounds: 1,
    requests: 2,
  },
  {
    // A HEAD (its size and version) beside the head read (the file's first read).
    name: 'web address of one file',
    open: () => http.open('https://lab.example/atlas.h5ad'),
    routes: (url, init) => (url === 'https://lab.example/atlas.h5ad' ? file(1 << 20)(url, init) : null),
    rounds: 1,
    requests: 2,
  },
  {
    // The series' listing names the file, its filelist.txt beside it the
    // members of its _RAW.tar (read from their sample folders); then the
    // file's probe.
    name: 'GEO series',
    open: () => geo.open('GSE351300'),
    routes: (url, init) => (url.endsWith('/suppl/')
      ? { status: 200, text: '<a href="GSE351300_counts.h5ad">GSE351300_counts.h5ad</a>' }
      : url.endsWith('.h5ad') ? file(1 << 20)(url, init) : null),
    rounds: 2,
    requests: 4,
  },
  {
    // The record names the file, its size and checksum: nothing else is asked.
    name: 'Zenodo record',
    open: () => zenodo.open('7'),
    routes: url => (url === 'https://zenodo.org/api/records/7'
      ? { status: 200, json: { id: 9, conceptrecid: '7', metadata: { title: 'Atlas' }, files: [{ key: 'atlas.h5ad', size: 4096, checksum: 'md5:bb' }] } }
      : null),
    rounds: 1,
    requests: 1,
  },
  {
    // The revision's commit beside the path's own entry (its size and content name).
    name: 'Hugging Face file',
    open: () => huggingface.open('lab/atlas/one.h5ad'),
    routes: (url, init) => {
      if (url.includes('/api/datasets/lab/atlas/revision/')) return { status: 200, json: { sha: COMMIT } };
      if (url.includes('/api/datasets/lab/atlas/paths-info/') && init.method === 'POST') {
        return { status: 200, json: [{ type: 'file', path: 'one.h5ad', size: 2048, oid: '0'.repeat(40), lfs: { oid: 'f'.repeat(64), size: 2048 }, lastCommit: { id: COMMIT } }] };
      }
      return null;
    },
    rounds: 1,
    requests: 2,
  },
  {
    // GitHub's API names the commit that last wrote the file; then its probe at that commit.
    name: 'GitHub file',
    open: () => github.open('owner/repo/data/plain.h5ad'),
    routes: (url, init) => {
      if (new URL(url).host === 'api.github.com') return { status: 200, json: [{ sha: COMMIT }] };
      return url === `https://raw.githubusercontent.com/owner/repo/${COMMIT}/data/plain.h5ad` ? file(1 << 20)(url, init) : null;
    },
    rounds: 2,
    requests: 3,
  },
  {
    // The share link is read from its content host directly: no redirect is followed.
    name: 'Dropbox share link',
    open: () => dropbox.open('https://www.dropbox.com/scl/fi/abc/atlas.h5ad?rlkey=k&dl=0'),
    routes: (url, init) => (url.startsWith('https://dl.dropboxusercontent.com/') ? file(1 << 20)(url, init) : null),
    rounds: 1,
    requests: 2,
  },
];

for (const source of SOURCES) {
  test(`opening a ${source.name} costs ${source.rounds} round trip${source.rounds === 1 ? '' : 's'} and ${source.requests} request${source.requests === 1 ? '' : 's'} before its data`, async t => {
    // A first visit: nothing remembered, nothing kept.
    const storage = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });
    t.after(() => Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true }));
    const counted = roundCounting(t, source.routes);
    const opened = await source.open();
    assert.ok(opened.file?.resource?.size > 0, 'the file is described');
    const asked = counted.asked.map(request => `${request.round} ${request.method} ${request.url}`).join('\n');
    assert.equal(counted.rounds(), source.rounds, asked);
    assert.equal(counted.requests(), source.requests, asked);
  });
}
