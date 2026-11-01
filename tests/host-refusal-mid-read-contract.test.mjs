/**
 * A host that refuses this network in the middle of a long read (CELLxGENE's
 * S3 after about a gigabyte in a quarter of an hour; Zenodo's "unusual
 * traffic"): the read waits it out instead of failing whole, says so in
 * plain words, asks again about once per back-off (RFC 6298, doubling to
 * 60 s), never by every waiting request, keeps what it read (no range is
 * asked twice once delivered), is paced once the host answers again
 * (`hosts.js` `learnPace`), and its signal still ends it. A file or folder
 * that never answered a read is not waited for (CORS, a host that cannot
 * serve ranges): it fails as before.
 *
 * The host is scripted: it serves ranges until `refuseAfterBytes` bytes
 * have been served, then answers nothing a page may read (`TypeError`, as
 * a browser reports an answer without CORS headers) for `refuseForMs`, then
 * serves again. Waits run on virtual time (`helpers/virtual-time.mjs`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { BYTE_SOURCE_FAILURES, REMOTE_POLICY, httpByteSource } from '../assets/js/formats/io/byte-source.js';
import { LinkMeter } from '../assets/js/formats/io/link.js';
import { createHostBook } from '../assets/js/formats/io/hosts.js';
import { httpStore } from '../assets/js/formats/zarr/stores/http.js';
import { virtualTime } from './helpers/virtual-time.mjs';

const EPOCH = 1_800_000_000_000;

function pattern(size) {
  return Uint8Array.from({ length: size }, (_, i) => (i * 13 + 7) & 255);
}

/** A host serving `bytes` by range, refusing this network for `refuseForMs` once `refuseAfterBytes` were served. */
function refusingHost(time, bytes, { refuseAfterBytes, refuseForMs, roundTripMs = 50 }) {
  const host = { served: 0, refusedFrom: null, requests: [], ranges: [] };
  host.fetch = async (url, init = {}) => {
    const at = time.now();
    host.requests.push(at);
    await time.sleep(roundTripMs);
    if (host.refusedFrom === null && host.served >= refuseAfterBytes) host.refusedFrom = at;
    if (host.refusedFrom !== null && at < host.refusedFrom + refuseForMs) throw new TypeError('Failed to fetch');
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range).map(Number);
    host.served += end - start + 1;
    host.ranges.push(`${start}-${end}`);
    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } });
  };
  return host;
}

function book(time) {
  return createHostBook({ now: time.now, after: time.after, epoch: () => EPOCH + time.now() });
}

test('a long read whose host refuses this network part way waits it out, keeps what it read, and is paced after', async () => {
  const time = virtualTime();
  const bytes = pattern(400_000);
  const url = 'https://cellxgene-census-public-us-west-2.s3.us-west-2.amazonaws.com/h5ads/atlas.h5ad';
  const s3 = refusingHost(time, bytes, { refuseAfterBytes: 120_000, refuseForMs: 600_000 });
  const hosts = book(time);
  const link = new LinkMeter(REMOTE_POLICY, { clock: time.now, after: time.after });
  const source = httpByteSource({ url, size: bytes.length }, { fetch: s3.fetch, hosts });
  const told = [];
  // Eight reads at a time, as a graph's or a gene's slabs are read.
  const pieces = 100;
  const step = bytes.length / pieces;
  let next = 0;
  const results = new Array(pieces);
  const worker = async () => {
    while (next < pieces) {
      const i = next++;
      results[i] = await source.read(i * step, step, { link, onWait: wait => { if (wait !== null) told.push(wait.text); } });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  // Every read gave its bytes: nothing failed, nothing was lost.
  results.forEach((piece, i) => assert.deepEqual(piece, bytes.subarray(i * step, (i + 1) * step), `piece ${i}`));
  assert.ok(s3.refusedFrom !== null, 'the host refused part way');
  // No range delivered was asked again.
  assert.equal(new Set(s3.ranges).size, s3.ranges.length, 'every delivered range asked once');
  assert.equal(s3.ranges.length, pieces);
  // Told in plain words, naming the host and that what was read is kept.
  assert.ok(told.some(text => /cellxgene-census-public-us-west-2\.s3\.us-west-2\.amazonaws\.com stopped answering this site, which it answered before: it may be refusing requests from this network for now .*Asking again in .*what was read is kept/.test(text)), told.join(' | '));
  // While it refused (10 minutes), asked about once per back-off, never by every waiting read.
  const during = s3.requests.filter(at => at > s3.refusedFrom && at < s3.refusedFrom + 600_000).length;
  assert.ok(during <= 8 + 20, `${during} requests in 10 minutes of refusal`);
  // Paced once it answers again: a request is priced at least at the pace.
  assert.ok(hosts.pace(url) > 0, 'a pace learnt from the refusal');
  assert.ok(hosts.requestCostMs(url) >= hosts.pace(url));
});

test('a read waiting out a refusal still ends when it is no longer wanted', async () => {
  const time = virtualTime();
  const bytes = pattern(50_000);
  const url = 'https://zenodo.org/api/records/1/files/a.h5ad/content';
  const host = refusingHost(time, bytes, { refuseAfterBytes: 10_000, refuseForMs: Infinity });
  const source = httpByteSource({ url, size: bytes.length }, { fetch: host.fetch, hosts: book(time) });
  const link = new LinkMeter(REMOTE_POLICY, { clock: time.now, after: time.after });
  for (let i = 0; i < 2; i++) await source.read(i * 5000, 5000, { link });
  const controller = new AbortController();
  const waiting = source.read(20_000, 5000, { link, signal: controller.signal });
  time.after(120_000, () => controller.abort(new Error('no longer wanted')));
  await assert.rejects(waiting, /no longer wanted/);
});

test('a file that never delivered a range is not waited for: a host that refuses this site from the start fails as before', async () => {
  const time = virtualTime();
  const bytes = pattern(10_000);
  const url = 'https://example.org/never.h5ad';
  const host = refusingHost(time, bytes, { refuseAfterBytes: 0, refuseForMs: Infinity });
  const source = httpByteSource({ url, size: bytes.length }, { fetch: host.fetch, hosts: book(time) });
  const link = new LinkMeter(REMOTE_POLICY, { clock: time.now, after: time.after });
  await assert.rejects(source.read(0, 1000, { link }), error => error.code === BYTE_SOURCE_FAILURES.NETWORK);
  assert.ok(host.requests.length <= 2, `${host.requests.length} requests`);
});

test('a Zarr folder whose host refuses part way waits it out for its objects too', async () => {
  const time = virtualTime();
  const objects = new Map(Array.from({ length: 40 }, (_, i) => [`x/c/${i}`, pattern(4000 + i)]));
  const url = 'https://example.org/store.zarr/';
  const served = { bytes: 0, refusedFrom: null, requests: [] };
  const fetchImpl = async (target, init = {}) => {
    const at = time.now();
    served.requests.push(at);
    await time.sleep(40);
    if (served.refusedFrom === null && served.bytes >= 60_000) served.refusedFrom = at;
    if (served.refusedFrom !== null && at < served.refusedFrom + 300_000) throw new TypeError('Failed to fetch');
    const key = String(target).slice(url.length);
    const body = objects.get(key);
    if (body === undefined) return new Response(null, { status: 404 });
    served.bytes += body.length;
    return new Response(body, { status: 200 });
  };
  // A measured link on the virtual clock: the store's waits run on it.
  const store = httpStore(url, { fetch: fetchImpl, hosts: book(time), concurrency: new LinkMeter(REMOTE_POLICY, { clock: time.now, after: time.after }) });
  const got = await Promise.all([...objects.keys()].map(key => store.get(key)));
  [...objects.values()].forEach((body, i) => assert.deepEqual(got[i], body, `object ${i}`));
  assert.ok(served.refusedFrom !== null, 'the host refused part way');
});
