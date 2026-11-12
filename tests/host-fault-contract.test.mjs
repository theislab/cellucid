/**
 * Whenever a data host does not give what was asked for, the person is told
 * who is at fault (`HOST_FAULTS`): the host failing on its side (5xx, 408),
 * limiting this network (429, with the wait it names), refusing this network
 * for now (a 401/403 of a provider whose files are all public, or of a host
 * that answered before), the link's permissions (401/403), nothing at the
 * address (404/410), or this computer offline; named with the provider the
 * host serves, with the status, and Try again first where it may help.
 *
 * Measured on NCBI GEO on 2026-10-31 (16:47-17:07 CET): every file under
 * `ftp.ncbi.nlm.nih.gov/geo/` answered HTTP 500 (`geo/README.txt` and every
 * `filelist.txt` included), while its folder listings answered 200 with no
 * files, or only some. The live app then said "GEO GSE327505 has no
 * supplementary file Cellucid opens." and "GEO GSE336826 has no file named
 * GSM9843410_12hpf_scRNA_matrix.mtx.gz.", and for a file link
 * "ftp.ncbi.nlm.nih.gov failed to give ….h5ad. Try again later.".
 */

import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BYTE_SOURCE_FAILURES,
  ByteSourceError,
  HOST_FAULTS,
  fetchOnce,
  hostFaultOfStatus,
  hostFaultSentence,
  isHostSideStatus,
  transientStatusError,
  withRetries,
} from '../assets/js/formats/io/byte-source.js';
import {
  DataSourceErrorCode,
  hostFaultFailure,
  hostFaultOf,
  hostFaultOfResponse,
  isExplainedFailure,
} from '../assets/js/data/data-source.js';
import { describeOpeningFailure } from '../assets/js/app/ui/modules/dataset-connections.js';
import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { LinkDataSource } from '../assets/js/data/link-source.js';
import { ResponseClock } from '../assets/js/formats/io/link.js';
import { createHostBook } from '../assets/js/formats/io/hosts.js';
import geo from '../assets/js/data/sources/providers/geo.js';
import { virtualTime } from './helpers/virtual-time.mjs';

const NOT_OURS = 'not with the link or with Cellucid. It usually passes; try again later.';
const esc = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replace fetch with `routes(url, init)` → `{status, text?, headers?}` (404 when it answers nothing). */
function installFetch(t, routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET', range: new Headers(init.headers ?? {}).get('Range') });
    if (init.signal?.aborted) throw init.signal.reason;
    const answer = routes(url, init) ?? { status: 404, text: 'Not Found' };
    const text = init.method === 'HEAD' ? null : answer.text ?? '';
    const response = new Response(text, {
      status: answer.status,
      headers: { 'Content-Length': String((answer.text ?? '').length), ...(answer.headers ?? {}) },
    });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function silenceNotifications(t) {
  const notifications = getNotificationCenter();
  const original = { loading: notifications.loading, complete: notifications.complete, fail: notifications.fail };
  notifications.loading = () => 'host-failing-test';
  notifications.complete = () => {};
  notifications.fail = () => {};
  const { log, warn, error } = console;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  t.after(() => {
    Object.assign(notifications, original);
    Object.assign(console, { log, warn, error });
  });
}

/** NCBI's answers during its 2026-10-31 outage: folders listed (`listing`), every file HTTP 500. */
const NCBI_ERROR = '<html><head><title>Server error!</title></head><body>The server encountered an internal error</body></html>';
function ncbiOutage(listing = '<html><body><h1>Index of /geo/series/GSE327nnn/GSE327505/suppl</h1><hr></body></html>') {
  return url => (url.endsWith('/')
    ? { status: 200, text: listing }
    : { status: 500, text: NCBI_ERROR, headers: { 'Content-Type': 'text/html' } });
}

test('each host fault is one sentence: who is at fault, the status, what to do', () => {
  for (const status of [500, 502, 503, 504, 520, 408]) assert.equal(hostFaultOfStatus(status), 'failing', String(status));
  assert.equal(hostFaultOfStatus(429), 'limiting');
  for (const status of [200, 206, 400, 401, 403, 404, 410, 416, null, '500']) assert.equal(hostFaultOfStatus(status), null, String(status));
  for (const status of [500, 503, 408, 429]) assert.equal(isHostSideStatus(status), true);
  assert.deepEqual(HOST_FAULTS, ['failing', 'limiting', 'refusing', 'silent', 'refused', 'missing', 'offline', 'connection']);

  const say = fault => hostFaultSentence({ host: 'zenodo.org', service: 'Zenodo', what: 'record 1', ...fault });
  assert.equal(say({ kind: 'failing', status: 503 }),
    `Zenodo (zenodo.org) is not answering (HTTP 503, service unavailable) for record 1: a problem on Zenodo's side, ${NOT_OURS}`);
  assert.equal(say({ kind: 'limiting', status: 429, retryAfterMs: 30_000 }),
    'Zenodo (zenodo.org) is limiting requests from this network (HTTP 429, too many requests) for record 1: Zenodo\'s ' +
    'own limit, not a problem with the link or with Cellucid. Try again in 30 s, as Zenodo asks.');
  assert.match(say({ kind: 'limiting', status: 429 }), /Try again in a few minutes\.$/);
  assert.equal(say({ kind: 'refusing', status: 403 }),
    'Zenodo (zenodo.org) is refusing requests from this network for now (HTTP 403, forbidden) for record 1, which it ' +
    'gives everyone: a problem on Zenodo\'s side (an outage, or a block after many requests from one network), not ' +
    'with the link or with Cellucid. Try again later.');
  // A host that answered this site before, now silent: no status, three possible reasons, no address.
  assert.equal(say({ kind: 'silent' }),
    'Zenodo (zenodo.org) stopped answering this site, which it answered before (record 1): it may be refusing ' +
    'requests from this network for now (hosts do so for a while after many requests from one network), or failing, ' +
    'or this computer lost its connection. Try again later.');
  assert.equal(say({ kind: 'refused', status: 403 }),
    'Zenodo (zenodo.org) refused record 1 (HTTP 403, forbidden): it is private or deleted, or the link has expired. ' +
    'This is the link\'s permissions, not a fault of Zenodo or Cellucid. Ask its owner for a public link.');
  assert.equal(say({ kind: 'missing', status: 404 }),
    'record 1 was not found at Zenodo (zenodo.org) (HTTP 404, not found): the link or record does not exist, or it ' +
    'moved. Check the link, or ask its owner.');
  assert.equal(say({ kind: 'offline' }),
    'This computer is offline, so record 1 cannot be read from Zenodo (zenodo.org): the connection on this side, not ' +
    'Zenodo or Cellucid. Connect, then try again.');
  // A host met by its address alone is its own owner.
  assert.match(hostFaultSentence({ kind: 'failing', host: 'data.example.org', status: 500, what: 'a.h5ad' }),
    /^data\.example\.org is not answering \(HTTP 500, a server error\) for a\.h5ad: a problem on data\.example\.org's side/);

  // Codes and settling: what may pass offers Try again first; permissions and a missing file are settled.
  const expected = { failing: ['NETWORK_ERROR', false], limiting: ['NETWORK_ERROR', false], refusing: ['NETWORK_ERROR', false], silent: ['NETWORK_ERROR', false],
    refused: ['PERMISSION_DENIED', true], missing: ['NOT_FOUND', true], offline: ['NETWORK_ERROR', false] };
  for (const [kind, [code, settled]] of Object.entries(expected)) {
    const failure = hostFaultFailure({ kind, host: 'h.test', status: kind === 'offline' || kind === 'silent' ? null : 403, what: 'a.h5ad' });
    assert.equal(failure.code, DataSourceErrorCode[code], kind);
    assert.equal(isExplainedFailure(failure), true, kind);
    assert.equal(describeOpeningFailure('x.', failure, { withoutLink: true }).settled, settled, kind);
    assert.equal(describeOpeningFailure('x.', failure, { withoutLink: true }).summary, failure.message, kind);
    assert.equal(hostFaultOf(failure).kind, kind);
  }
  // A failure that carries a host-side status and its address is one too (a catalog's datasets.json).
  assert.deepEqual(hostFaultOf({ details: { url: 'https://h.test/c/datasets.json', status: 503 } }),
    { kind: 'failing', host: 'h.test', status: 503, service: null, retryAfterMs: null });
  assert.equal(hostFaultOf({ details: { url: 'https://h.test/c/datasets.json', status: 404 } }), null);
  // A provider's answer: its status and the wait it names.
  const limited = hostFaultOfResponse(new Response('slow down', { status: 429, headers: { 'Retry-After': '120' } }), 'record 7', { url: 'https://zenodo.org/api/records/7' });
  assert.deepEqual(limited.details.hostFault, { kind: 'limiting', host: 'zenodo.org', status: 429, what: 'record 7', service: null, retryAfterMs: 120_000 });
  assert.match(limited.message, /Try again in 2 min 0 s, as zenodo\.org asks\.$/);
  assert.equal(hostFaultOfResponse(new Response('', { status: 404 }), 'x', { url: 'https://h.test/x' }), null);
});

test('a read whose host keeps failing or limiting is said as the host\'s, its requests under Details', async () => {
  const time = virtualTime();
  const clock = new ResponseClock({ clock: time.now, after: time.after });
  let asked = 0;
  await assert.rejects(withRetries(async () => {
    asked++;
    throw transientStatusError(new Response(NCBI_ERROR, { status: 500, headers: { 'Content-Length': '113' } }),
      'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE350nnn/GSE350831/suppl/GSE350831_Flex.h5ad');
  }, { clock, random: () => 0 }), error => {
    assert.ok(error instanceof ByteSourceError);
    assert.equal(error.code, BYTE_SOURCE_FAILURES.UNAVAILABLE);
    assert.equal(error.message, `ftp.ncbi.nlm.nih.gov is not answering (HTTP 500, a server error) for GSE350831_Flex.h5ad: ` +
      `a problem on ftp.ncbi.nlm.nih.gov's side, ${NOT_OURS}`);
    assert.equal(error.details.explained, true);
    assert.deepEqual(error.details.hostFault, { kind: 'failing', host: 'ftp.ncbi.nlm.nih.gov', status: 500, what: 'GSE350831_Flex.h5ad', service: null, retryAfterMs: null });
    assert.match(error.cause.message, /GSE350831_Flex\.h5ad: the host could not answer \(HTTP 500\)\. Asked 2 times\./);
    return true;
  });
  assert.equal(asked, 2, 'the same 500 twice is a host failing: reported after one repeat');

  // A rate limit that outlasts its repeats: limiting.
  await assert.rejects(withRetries(async () => {
    throw transientStatusError(new Response('', { status: 429 }), 'https://huggingface.co/api/datasets/u/r');
  }, { clock, random: () => 0 }), error => {
    assert.equal(error.details.hostFault.kind, 'limiting');
    assert.match(error.message, /^huggingface\.co is limiting requests from this network \(HTTP 429, too many requests\) for r: /);
    return true;
  });

  // A failure that is not the host's own (a CORS refusal) keeps its message.
  await assert.rejects(withRetries(async () => {
    throw new ByteSourceError(BYTE_SOURCE_FAILURES.NETWORK, 'https://h.test/a: no answer this page may read', { phase: 'answer', host: 'h.test' });
  }, { clock, random: () => 0 }), error => {
    assert.equal(error.details.hostFault, undefined);
    assert.match(error.message, /no answer this page may read.*Asked 2 times\./);
    return true;
  });
});

test('GEO: a listing NCBI answers while its file service fails is never taken for a missing file', async t => {
  // A series with a _RAW.tar: its filelist.txt answers 500, said at once.
  const calls = installFetch(t, ncbiOutage());
  await assert.rejects(geo.open('GSE328433'), error => {
    assert.equal(error.message, 'ftp.ncbi.nlm.nih.gov is not answering (HTTP 500, a server error) for the file list of ' +
      `GSE328433 (its folder listed no files): a problem on ftp.ncbi.nlm.nih.gov's side, ${NOT_OURS}`);
    assert.equal(error.details.hostFault.kind, 'failing');
    return true;
  });
  assert.ok(!calls.some(call => call.url.endsWith('/geo/README.txt')), 'the file list said it: nothing more is asked');

  // A series without one (filelist.txt 404), a sample and a named matrix: NCBI's own README answers 500.
  for (const [value, missing] of [
    ['GSE327505', 'no files'],
    ['GSM9843410', 'no files'],
    ['GSE336826/GSM9843410_12hpf_scRNA_matrix.mtx.gz', 'no GSM9843410_12hpf_scRNA_matrix.mtx.gz'],
  ]) {
    const seen = installFetch(t, (url, init) => (url.endsWith('/filelist.txt') ? { status: 404, text: 'Not Found' } : ncbiOutage()(url, init)));
    await assert.rejects(geo.open(value), error => {
      assert.match(error.message, new RegExp(`^ftp\\.ncbi\\.nlm\\.nih\\.gov is not answering \\(HTTP 500, a server error\\) for its own geo/README\\.txt, asked because the folder of ${value.split('/')[0]} listed ${esc(missing)}:`));
      return true;
    });
    const probe = seen.find(call => call.url === 'https://ftp.ncbi.nlm.nih.gov/geo/README.txt');
    assert.equal(probe?.range, 'bytes=0-0', 'one byte of NCBI\'s README is asked, once');
    assert.equal(seen.filter(call => call.url.endsWith('/geo/README.txt')).length, 1);
  }

  // The folder listing itself failing.
  installFetch(t, () => ({ status: 500, text: NCBI_ERROR }));
  await assert.rejects(geo.open('GSE1'), { message: `ftp.ncbi.nlm.nih.gov is not answering (HTTP 500, a server error) for the file list of GSE1: a problem on ftp.ncbi.nlm.nih.gov's side, ${NOT_OURS}` });
});

test('GEO: while NCBI answers, a listing without the file is the series\' own answer, as before', async t => {
  installFetch(t, url => {
    if (url.endsWith('/suppl/')) return { status: 200, text: '<a href="GSE1_RAW.tar">x</a>' };
    if (url.endsWith('/geo/README.txt')) return { status: 206, text: 'G' };
    return null;
  });
  await assert.rejects(geo.open('GSE1'), { message: 'GEO GSE1 has no supplementary file Cellucid opens (it has: GSE1_RAW.tar).' });
  await assert.rejects(geo.open('GSE1/GSM1_matrix.mtx.gz'), { message: 'GEO GSE1 has no file named GSM1_matrix.mtx.gz.' });
});

/**
 * One link of each provider shape, every request answered `status`: what
 * the link source says, by provider (`LinkDataSource.connect`).
 */
const SHAPES = [
  ['NCBI GEO', 'geo:GSE350831/GSE350831_Flex.h5ad', 'GSE350831_Flex.h5ad', 'ftp.ncbi.nlm.nih.gov', true],
  ['NCBI GEO', 'geo:GSE328433', 'the file list of GSE328433', 'ftp.ncbi.nlm.nih.gov', true],
  ['CELLxGENE', 'cellxgene:0819e386-e7fd-4212-b732-60e468689f89', 'the Census release list', 'cellxgene-census-public-us-west-2.s3.us-west-2.amazonaws.com', true],
  ['Zenodo', 'zenodo:7/atlas.h5ad', 'record 7', 'zenodo.org', false],
  ['Figshare', 'figshare:22577536', 'Figshare item 22577536', 'api.figshare.com', false],
  ['Hugging Face', 'hf:user/repo', 'dataset user/repo', 'huggingface.co', false],
  ['Dropbox', 'https://www.dropbox.com/s/abc/atlas.h5ad?dl=1', 'atlas.h5ad', 'dl.dropboxusercontent.com', false],
  [null, 'https://data.example.org/lab/atlas.h5ad', 'atlas.h5ad', 'data.example.org', false],
];

test('every provider says a host failing on its side as that host\'s, named with the provider', async t => {
  silenceNotifications(t);
  const source = new LinkDataSource();
  for (const [service, link, what, host] of SHAPES) {
    installFetch(t, () => ({ status: 500, text: NCBI_ERROR }));
    await assert.rejects(source.connect(link), error => {
      const where = service === null ? host : `${service} (${host})`;
      assert.equal(error.message, `${where} is not answering (HTTP 500, a server error) for ${what}: a problem on ${service ?? host}'s side, ${NOT_OURS}`, link);
      assert.equal(error.details.hostFault.kind, 'failing', link);
      assert.equal(describeOpeningFailure('x.', error, { withoutLink: true }).settled, false, link);
      return true;
    });
  }
});

test('a refusal is the link\'s permissions, except from a provider whose files are all public; a missing file says so', async t => {
  silenceNotifications(t);
  const source = new LinkDataSource();
  // GEO and the Census serve only public files: a 403 is their host refusing this network (NCBI, 2026-10-31).
  installFetch(t, () => ({ status: 403, text: 'Forbidden' }));
  await assert.rejects(source.connect('geo:GSE350831/GSE350831_Flex.h5ad'), error => {
    assert.match(error.message, /^NCBI GEO \(ftp\.ncbi\.nlm\.nih\.gov\) is refusing requests from this network for now \(HTTP 403, forbidden\) for GSE350831_Flex\.h5ad, which it gives everyone: a problem on NCBI GEO's side/);
    assert.equal(describeOpeningFailure('x.', error, { withoutLink: true }).settled, false);
    return true;
  });
  // A web address that refuses: the link's permissions, settled.
  await assert.rejects(source.connect('https://private.example.net/lab/atlas.h5ad'), error => {
    assert.match(error.message, /^private\.example\.net refused atlas\.h5ad \(HTTP 403, forbidden\): it is private or deleted, or the link has expired\. This is the link's permissions/);
    assert.equal(error.code, 'PERMISSION_DENIED');
    assert.equal(describeOpeningFailure('x.', error, { withoutLink: true }).settled, true);
    return true;
  });
  installFetch(t, () => ({ status: 404, text: 'Not Found' }));
  await assert.rejects(source.connect('https://www.dropbox.com/s/abc/atlas.h5ad?dl=1'), error => {
    assert.match(error.message, /^atlas\.h5ad was not found at Dropbox \(dl\.dropboxusercontent\.com\) \(HTTP 404, not found\): the link or record does not exist/);
    assert.equal(error.code, 'NOT_FOUND');
    return true;
  });
});

test('a provider host that gives no answer, while this computer is offline, is said as this side\'s connection', async t => {
  silenceNotifications(t);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => ({ onLine: false }) });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const source = new LinkDataSource();
  await assert.rejects(source.connect('zenodo:7/atlas.h5ad'), error => {
    assert.match(error.message, /^This computer is offline, so it cannot be read from Zenodo \(zenodo\.org\): the connection on this side, not Zenodo or Cellucid\./);
    assert.equal(error.details.hostFault.kind, 'offline');
    return true;
  });
  await assert.rejects(source.connect('https://data.example.org/lab/atlas.h5ad'), error => {
    assert.match(error.message, /^This computer is offline, so atlas\.h5ad cannot be read from data\.example\.org: the connection on this side/);
    return true;
  });
});

test('a link whose host fails names the provider, and keeps the requests under Details', async t => {
  silenceNotifications(t);
  installFetch(t, ncbiOutage());
  const source = new LinkDataSource();
  await assert.rejects(source.connect('geo:GSE350831/GSE350831_Flex_pilot_paper_annotated_bbknn.h5ad'), error => {
    assert.equal(error.message,
      'NCBI GEO (ftp.ncbi.nlm.nih.gov) is not answering (HTTP 500, a server error) for ' +
      `GSE350831_Flex_pilot_paper_annotated_bbknn.h5ad: a problem on NCBI GEO's side, ${NOT_OURS}`);
    assert.equal(error.details.hostFault.service, 'NCBI GEO');
    assert.match(error.details.cause.message, /GSE350831_Flex_pilot_paper_annotated_bbknn\.h5ad: the host could not answer \(HTTP 500\)\. Asked 2 times\./);
    return true;
  });
  await assert.rejects(source.connect('geo:GSE328433'), error => {
    assert.match(error.message, /^NCBI GEO \(ftp\.ncbi\.nlm\.nih\.gov\) is not answering \(HTTP 500, a server error\) for the file list of GSE328433/);
    assert.equal(error.details.cause.message,
      'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE328nnn/GSE328433/suppl/filelist.txt: HTTP 500; ' +
      'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE328nnn/GSE328433/suppl/ listed no files.');
    return true;
  });
});

test('a Retry-After on a successful answer is a budget header, never a wait (Zenodo sends one on every 200)', async () => {
  // zenodo.org answered its record (HTTP 200) with `Retry-After: 60` on 2026-10-31.
  const hosts = createHostBook({});
  const url = 'https://zenodo.org/api/records/13255338';
  const answer = () => new Response('{"id":13255338}', { status: 200, headers: { 'Retry-After': '60', 'Content-Type': 'application/json' } });
  const waits = [];
  for (let i = 0; i < 3; i++) {
    const { response } = await fetchOnce(url, {}, { fetchImpl: async () => answer(), hosts, wantsBody: () => true, onWait: wait => waits.push(wait) });
    assert.equal(response.status, 200);
  }
  assert.equal(hosts.heldForMs(url), 0, 'the host is not held');
  assert.deepEqual(waits, [], 'nothing waited');
  // The same header on a 429 holds the host for what it names.
  await fetchOnce(url, {}, { fetchImpl: async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } }), hosts, wantsBody: () => false });
  assert.ok(hosts.heldForMs(url) > 50_000, `held for ${hosts.heldForMs(url)} ms`);
});

test('a request no answer arrived for says whose problem it is where that is known, and keeps its own words', async () => {
  const { unansweredFault, BYTE_SOURCE_FAILURES } = await import('../assets/js/formats/io/byte-source.js');
  const { describeDataSourceFailure } = await import('../assets/js/app/ui/modules/dataset-connections.js');
  const lost = (answeredBefore) => Object.assign(new Error('https://127.0.0.1:54683/anndata/garcia.zarr/.zmetadata: no answer'), {
    code: BYTE_SOURCE_FAILURES.NETWORK,
    details: { host: '127.0.0.1:54683', url: 'https://127.0.0.1:54683/anndata/garcia.zarr/.zmetadata', answeredBefore },
  });
  // The book of hosts says whether this computer is online (`hosts.online`, the one source).
  const quiet = { connectionDown: () => false, online: () => true };
  assert.equal(unansweredFault(lost(true), quiet).kind, 'silent');
  assert.equal(unansweredFault(lost(true), { ...quiet, online: () => false }).kind, 'offline');
  assert.equal(unansweredFault(lost(false), quiet), null, 'a host never answered: a typo or a site others may not read');
  assert.equal(unansweredFault(lost(false), { connectionDown: () => true, online: () => true }).kind, 'connection');
  assert.equal(unansweredFault(Object.assign(lost(true), { code: BYTE_SOURCE_FAILURES.HTTP }), quiet), null);
  // Said in the samples' notice by its fault, never by its address (F51, F58).
  const error = Object.assign(lost(true), { details: { ...lost(true).details, hostFault: unansweredFault(lost(true), quiet) } });
  const sentence = describeDataSourceFailure('Sample datasets', 'could not be loaded', error);
  assert.match(sentence, /^Sample datasets could not be loaded: 127\.0\.0\.1:54683 stopped answering this site, which it answered before \(garcia\.zarr\/\.zmetadata\)/);
  assert.doesNotMatch(sentence, /https?:/);
});
