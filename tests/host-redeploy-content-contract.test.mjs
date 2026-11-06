/**
 * "Changed on the host" means the bytes changed. GitHub Pages gives every file
 * of a site new validators at every deployment although its bytes are the
 * same, so a validator that moved is a question the bytes answer
 * (`formats/io/read-witness.js`): the same bytes are read on, silently, and any
 * other bytes are refused, never mixed with what was read before. Both
 * directions, for a store's objects and for a file.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { httpStore } from '../assets/js/formats/zarr/index.js';
import { BYTE_SOURCE_FAILURES, httpByteSource } from '../assets/js/formats/io/byte-source.js';
import { ReadWitness, WITNESS_BYTES, witnessHolds } from '../assets/js/formats/io/read-witness.js';
import { releaseResidentMemory } from '../assets/js/data/memory-budget.js';

let stores = 0;
const CHANGED = error => error?.code === BYTE_SOURCE_FAILURES.CHANGED && /changed on the host/.test(error.message);

const OPENED_AT = new Date(Date.now() - 86_400_000).toUTCString();
const DEPLOYED_AT = new Date(Date.now() + 86_400_000).toUTCString();

function bytesOf(seed, length = 2000) {
  return Uint8Array.from({ length }, (_, i) => (i * seed + seed) % 251);
}

/** A static host of a store's objects: each read logged; `deploy()` gives every file new validators. */
function storeHost(objects = { '.zmetadata': bytesOf(3, 300), 'obs/a/0': bytesOf(5), 'obs/b/0': bytesOf(7), 'X/data/0': bytesOf(11), 'X/data/1': bytesOf(13) }) {
  const host = { objects: { ...objects }, generation: 1, modified: OPENED_AT, log: [] };
  host.deploy = () => {
    host.generation++;
    host.modified = DEPLOYED_AT;
  };
  host.fetch = async (url, init = {}) => {
    const key = decodeURIComponent(new URL(url).pathname.replace(/^\/data\/\d+\/store\.zarr\//, ''));
    const method = init.method ?? 'GET';
    host.log.push(`${method} ${key}`);
    const body = host.objects[key];
    if (body === undefined) return new Response(null, { status: 404 });
    const headers = { ETag: `"${key}-${host.generation}"`, 'Last-Modified': host.modified, 'Content-Length': String(body.length) };
    if (method === 'HEAD') return new Response(null, { status: 200, headers });
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers ?? {}).get('Range') ?? '');
    if (range !== null) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), body.length - 1);
      return new Response(body.slice(start, end + 1), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': String(end - start + 1) } });
    }
    return new Response(body.slice(), { status: 200, headers });
  };
  return host;
}

/** A store at an address of its own: the page's kept objects are per address and version. */
function storeOn(host) {
  stores += 1;
  return httpStore(`https://lab.github.io/data/${stores}/store.zarr/`, { fetch: host.fetch, name: 'store.zarr' });
}

async function openedStore(host) {
  const store = storeOn(host);
  await store.get('.zmetadata');
  await store.get('obs/a/0');
  await store.get('X/data/0');
  return store;
}

const reads = (host, from) => host.log.slice(from);

test('a witness is a read\'s first bytes, and any change of a read is told', () => {
  const witness = new ReadWitness();
  const large = bytesOf(9, WITNESS_BYTES * 3);
  witness.note('X/data/0', 0, large);
  assert.equal(witness.compare('X/data/0', 0, large), 'same');
  const lastByte = large.slice();
  lastByte[lastByte.length - 1] ^= 1;
  assert.equal(witness.compare('X/data/0', 0, lastByte), 'different', 'a change past the first bytes');
  assert.equal(witness.compare('X/data/0', 1, large), 'unknown', 'a range never read');
  const asked = witness.witnessOf('X/data/0');
  assert.equal(asked.length, WITNESS_BYTES);
  assert.equal(witnessHolds(asked, large.subarray(0, WITNESS_BYTES)), true);
  assert.equal(witnessHolds(asked, null), false, 'an object gone');
});

test('a redeploy of the same bytes: every read goes on, re-read or never read, and it costs a few requests once', async () => {
  const host = storeHost();
  const store = await openedStore(host);
  const original = host.objects['obs/a/0'];
  host.deploy();

  const from = host.log.length;
  // Never read: nothing of its own to compare, the store is asked once.
  assert.deepEqual(await store.get('obs/b/0'), host.objects['obs/b/0']);
  const asked = reads(host, from);
  assert.ok(asked.includes('HEAD .zmetadata') || asked.includes('GET .zmetadata'), `the store is checked: ${asked}`);
  assert.ok(asked.length <= 6, `a few requests: ${asked}`);

  // The next never-read object asks nothing more: the deployment is known.
  const next = host.log.length;
  assert.deepEqual(await store.get('X/data/1'), host.objects['X/data/1']);
  assert.deepEqual(reads(host, next), ['GET X/data/1']);

  // Read again: its own bytes compared, at the cost of the store's one HEAD.
  releaseResidentMemory('caches', 'hidden');
  const again = host.log.length;
  assert.deepEqual(await store.get('obs/a/0'), original);
  assert.deepEqual(reads(host, again), ['GET obs/a/0', 'HEAD .zmetadata']);
  assert.equal(await store.unchanged(), true, 'the store reads as the one it was opened as');
});

test('a metadata HEAD alone tells the store it was deployed again and is the same: a growth takes it over', async () => {
  const host = storeHost();
  const store = await openedStore(host);
  const opened = store.version();
  host.deploy();
  assert.equal(await store.unchanged(), true);
  assert.equal(store.version(), opened, 'its version, which names what it keeps, stays');
  host.deploy();
  host.objects['.zmetadata'] = bytesOf(4, 300);
  assert.equal(await store.unchanged(), false, 'new metadata is another store');
});

test('a re-read that holds other bytes is refused, and so is everything after it: nothing is mixed', async () => {
  const host = storeHost();
  const store = await openedStore(host);
  host.deploy();
  host.objects['obs/a/0'] = bytesOf(6);
  releaseResidentMemory('caches', 'hidden');
  await assert.rejects(() => store.get('obs/a/0'), CHANGED);
  // A later read of the same store is refused, identical or not.
  await assert.rejects(() => store.get('X/data/0'), CHANGED);
  await assert.rejects(() => store.get('obs/b/0'), CHANGED);
  assert.equal(await store.unchanged(), false);
});

test('a re-read of another size is refused', async () => {
  const host = storeHost();
  const store = await openedStore(host);
  host.deploy();
  host.objects['obs/a/0'] = bytesOf(5, 2001);
  releaseResidentMemory('caches', 'hidden');
  await assert.rejects(() => store.get('obs/a/0'), CHANGED);
});

test('a never-read object after a deployment that changed something read: its witness tells, and it is refused', async () => {
  for (const changed of ['.zmetadata', 'obs/a/0', 'X/data/0']) {
    const host = storeHost();
    const store = await openedStore(host);
    host.deploy();
    host.objects[changed] = bytesOf(17, host.objects[changed].length);
    await assert.rejects(() => store.get('obs/b/0'), CHANGED, `${changed} changed`);
  }
});

test('an object already read changed under a re-read of the same bytes elsewhere: the store is asked, and refused', async () => {
  const host = storeHost();
  const store = await openedStore(host);
  host.deploy();
  host.objects['X/data/0'] = bytesOf(19);
  releaseResidentMemory('caches', 'hidden');
  await assert.rejects(() => store.get('obs/a/0'), CHANGED);
});

test('a chunk gone from the host after a deployment that holds it: a witness that is absent is a change', async () => {
  const host = storeHost();
  const store = await openedStore(host);
  host.deploy();
  delete host.objects['obs/a/0'];
  await assert.rejects(() => store.get('obs/b/0'), CHANGED);
});

test('an older object than the store was opened at asks nothing: reads are as cheap as before', async () => {
  const host = storeHost();
  const store = await openedStore(host);
  const from = host.log.length;
  await store.get('obs/b/0');
  await store.get('X/data/1');
  assert.deepEqual(reads(host, from), ['GET obs/b/0', 'GET X/data/1']);
});

test('ranges of a shard: the same range is compared, a range never read asks for one read before', async () => {
  const shard = bytesOf(23, 100_000);
  const host = storeHost({ '.zmetadata': bytesOf(3, 300), 'X/data/c/0': shard });
  const store = storeOn(host);
  await store.get('.zmetadata');
  const [first] = await store.getRanges('X/data/c/0', [{ offset: 0, length: 5000 }]);
  assert.deepEqual(first, shard.subarray(0, 5000));
  host.deploy();
  const [other] = await store.getRanges('X/data/c/0', [{ offset: 50_000, length: 5000 }]);
  assert.deepEqual(other, shard.subarray(50_000, 55_000), 'the same bytes under a new validator read on');
  host.deploy();
  host.objects['X/data/c/0'] = bytesOf(29, 100_000);
  await assert.rejects(() => store.getRanges('X/data/c/0', [{ offset: 70_000, length: 5000 }]), CHANGED);
});

test('whatever is held, once a store was found rewritten every read is refused: a whole object, a suffix, an absent one', async () => {
  const shard = bytesOf(23, 100_000);
  const host = storeHost({ '.zmetadata': bytesOf(3, 300), 'obs/a/0': bytesOf(5), 'obs/b/0': bytesOf(7), 'X/data/c/0': shard });
  const store = storeOn(host);
  await store.get('.zmetadata');
  await store.get('obs/a/0');
  host.deploy();
  host.objects['obs/a/0'] = bytesOf(6);
  // Still held in this page, never asked of the host; the refusal comes from what the read next to it found.
  await assert.rejects(() => store.get('obs/b/0'), CHANGED);
  await assert.rejects(() => store.get('obs/a/0'), CHANGED, 'a held object');
  await assert.rejects(() => store.get('nothing/there/0'), CHANGED, 'an absent object is no fill value now');
  await assert.rejects(() => store.getRanges('X/data/c/0', [{ offset: 0, length: 10 }]), CHANGED, 'a range');
  await assert.rejects(() => store.getRanges('X/data/c/0', [{ suffix: 10 }]), CHANGED, 'a suffix');
});

test('an object read before and gone is a rewrite, never its fill value', async () => {
  const host = storeHost();
  const store = await openedStore(host);
  delete host.objects['obs/a/0'];
  releaseResidentMemory('caches', 'hidden');
  await assert.rejects(() => store.get('obs/a/0'), CHANGED);
  await assert.rejects(() => store.get('obs/b/0'), CHANGED);
});

test('an object never read and absent is only absent: its array\'s fill value', async () => {
  const host = storeHost();
  const store = await openedStore(host);
  assert.equal(await store.get('obs/a/1'), null);
});

test('a suffix under a new validator is compared like any read: the same reads on, other bytes are refused', async () => {
  const shard = bytesOf(23, 100_000);
  const host = storeHost({ '.zmetadata': bytesOf(3, 300), 'X/data/c/0': shard });
  const fetchWithSuffix = host.fetch;
  const suffixHost = async (url, init = {}) => {
    const suffix = /^bytes=-(\d+)$/.exec(new Headers(init.headers ?? {}).get('Range') ?? '');
    if (suffix === null) return fetchWithSuffix(url, init);
    host.log.push(`GET suffix ${suffix[1]}`);
    const body = host.objects['X/data/c/0'];
    const start = body.length - Number(suffix[1]);
    return new Response(body.slice(start), {
      status: 206,
      headers: { ETag: `"shard-${host.generation}"`, 'Last-Modified': host.modified, 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`, 'Content-Length': suffix[1] },
    });
  };
  stores += 1;
  const store = httpStore(`https://lab.github.io/data/${stores}/store.zarr/`, { fetch: suffixHost, name: 'store.zarr' });
  await store.get('.zmetadata');
  const [first] = await store.getRanges('X/data/c/0', [{ suffix: 100 }]);
  assert.deepEqual(first, shard.subarray(99_900));
  host.deploy();
  host.objects['X/data/c/0'] = bytesOf(29, 100_000);
  await assert.rejects(() => store.getRanges('X/data/c/0', [{ offset: 99_900, length: 100 }]), CHANGED);
  await assert.rejects(() => store.getRanges('X/data/c/0', [{ suffix: 100 }]), CHANGED);
});

test('a host that ignores ranges: bytes of a refused read are not held for the next read', async () => {
  const host = storeHost({ '.zmetadata': bytesOf(3, 300), 'X/data/c/0': bytesOf(23, 100_000), 'X/data/c/1': bytesOf(29, 100_000) });
  const whole = async (url, init = {}) => {
    const { headers: _ignored, ...rest } = init;
    return host.fetch(url, rest);
  };
  stores += 1;
  const store = httpStore(`https://lab.github.io/data/${stores}/store.zarr/`, { fetch: whole, name: 'store.zarr' });
  await store.get('.zmetadata');
  await store.getRanges('X/data/c/0', [{ offset: 0, length: 100 }]);
  host.deploy();
  host.objects['X/data/c/0'] = bytesOf(31, 100_000);
  await assert.rejects(() => store.getRanges('X/data/c/1', [{ offset: 0, length: 100 }]), CHANGED);
  await assert.rejects(() => store.getRanges('X/data/c/1', [{ offset: 0, length: 100 }]), CHANGED, 'never answered from what the refused read fetched');
});

test('an answer of another size refuses every later read of the store too, on a host naming no write time', async () => {
  const host = storeHost({ '.zmetadata': bytesOf(3, 300), 'obs/a/0': bytesOf(5), 'obs/b/0': bytesOf(7) });
  const store = storeOn(host);
  await store.get('.zmetadata');
  await store.get('obs/a/0');
  releaseResidentMemory('caches', 'hidden');
  const grown = bytesOf(5, 2500);
  const direct = store;
  host.objects['obs/a/0'] = grown;
  // Whole answers state their size by their length; a range by its Content-Range.
  await assert.rejects(() => direct.getRanges('obs/a/0', [{ offset: 10, length: 10 }]), CHANGED);
  await assert.rejects(() => direct.get('obs/b/0'), CHANGED, 'never read, and refused');
});

// ---------------------------------------------------------------------------
// A file

function fileHost(length = 300_000) {
  const host = { bytes: bytesOf(31, length), generation: 1, log: [] };
  host.fetch = async (url, init = {}) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers ?? {}).get('Range') ?? '');
    host.log.push(range === null ? 'whole' : `${range[1]}-${range[2]}`);
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), host.bytes.length - 1);
    return new Response(host.bytes.slice(start, end + 1), {
      status: 206,
      headers: { ETag: `"file-${host.generation}"`, 'Content-Range': `bytes ${start}-${end}/${host.bytes.length}`, 'Content-Length': String(end - start + 1) },
    });
  };
  return host;
}

function openedFile(host) {
  return httpByteSource({ url: 'https://lab.github.io/data/atlas.h5ad', size: host.bytes.length, name: 'atlas.h5ad', etag: '"file-1"' }, { fetch: host.fetch });
}

test('a file redeployed with the same bytes reads on; its range read again and one never read', async () => {
  const host = fileHost();
  const file = openedFile(host);
  await file.read(0, 1000);
  await file.read(200_000, 1000);
  host.generation = 2;
  assert.deepEqual(await file.read(100_000, 1000), host.bytes.subarray(100_000, 101_000));
  assert.deepEqual(await file.read(0, 1000), host.bytes.subarray(0, 1000));
  // Known now: nothing more is asked for it.
  const from = host.log.length;
  await file.read(150_000, 1000);
  assert.deepEqual(host.log.slice(from), ['150000-150999']);
});

test('a file rewritten at the same size is refused when what was read differs, and stays refused', async () => {
  const host = fileHost();
  const file = openedFile(host);
  await file.read(0, 1000);
  await file.read(200_000, 1000);
  host.generation = 2;
  host.bytes = host.bytes.slice();
  host.bytes[200_500] ^= 1;
  await assert.rejects(() => file.read(100_000, 1000), CHANGED);
  host.bytes[200_500] ^= 1;
  await assert.rejects(() => file.read(0, 1000), CHANGED, 'never mixed: refused from then on');
});

test('a file whose first read is under a new validator is compared with the head read beside its probe', async () => {
  const host = fileHost();
  const head = host.bytes.slice(0, 5000);
  const file = httpByteSource({ url: 'https://lab.github.io/data/atlas.h5ad', size: host.bytes.length, name: 'atlas.h5ad', etag: '"file-1"', head }, { fetch: host.fetch });
  host.generation = 2;
  assert.deepEqual(await file.read(100_000, 1000), host.bytes.subarray(100_000, 101_000), 'the same head: reads on');
  const other = httpByteSource({ url: 'https://lab.github.io/data/atlas.h5ad', size: host.bytes.length, name: 'atlas.h5ad', etag: '"file-1"', head }, { fetch: host.fetch });
  host.bytes = host.bytes.map(byte => byte ^ 0x5a);
  await assert.rejects(() => other.read(100_000, 1000), CHANGED);
});

test('one read\'s Stop does not end another read waiting on the same comparison', async () => {
  const host = fileHost();
  const file = openedFile(host);
  await file.read(0, 1000);
  host.generation = 2;
  const stop = new AbortController();
  const first = file.read(100_000, 1000, { signal: stop.signal });
  const second = file.read(110_000, 1000);
  stop.abort();
  await first.catch(() => {});
  assert.deepEqual(await second, host.bytes.subarray(110_000, 111_000));
});

test('a file with nothing read yet to compare is refused: nothing proves it the same', async () => {
  const host = fileHost();
  const file = openedFile(host);
  host.generation = 2;
  await assert.rejects(() => file.read(0, 1000), CHANGED);
});

test('a file answering another size is refused without any compare', async () => {
  const host = fileHost();
  const file = openedFile(host);
  await file.read(0, 1000);
  host.generation = 2;
  const size = host.bytes.length;
  host.bytes = new Uint8Array(size + 10);
  await assert.rejects(() => file.read(0, 1000), error => error.code === BYTE_SOURCE_FAILURES.CHANGED);
});
