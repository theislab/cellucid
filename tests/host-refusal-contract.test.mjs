// What a file this site may not read from its host is refused with
// (data/sources/remote-file.js, `hostRefusal`): the cause named for what it
// is, in one sentence, with a next step that can succeed for that file, and
// the host's own answer under Details. A host that does not let other
// websites read its files (CORS) is told apart from one that cannot be
// reached; a file whose format holds no embedding is not answered with
// "download it and open it from your computer", which would be refused too.

import assert from 'node:assert/strict';
import test from 'node:test';

const { describeRemoteFile } = await import('../assets/js/data/sources/remote-file.js');

/** Answer every request with `answer(url, init)`; restored after the test. */
function serve(t, answer) {
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init = {}) => {
    asked.push({ url: String(url), mode: init.mode ?? 'cors', method: init.method ?? 'GET' });
    return answer(String(url), init);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return asked;
}

const describe = url => describeRemoteFile({
  url,
  id: 'refused',
  name: url.split('/').at(-1),
  attribution: { title: 'refused', url },
});

async function refusalOf(url) {
  try {
    await describe(url);
  } catch (error) {
    return error;
  }
  throw new Error(`${url} was described`);
}

test('a missing file says so, with its status under Details', async t => {
  serve(t, () => new Response('not here', { status: 404 }));
  const error = await refusalOf('https://files.example/missing.h5ad');
  assert.equal(error.code, 'NOT_FOUND');
  assert.equal(error.message, 'missing.h5ad was not found at files.example (HTTP 404, not found): the link or record does not ' +
    'exist, or it moved. Check the link, or ask its owner.');
  assert.equal(error.details.hostFault.kind, 'missing');
  assert.equal(error.details.status, 404);
  assert.match(error.details.cause.message, /HTTP 404/);
});

test('a refused file is private or its link expired, never "not found"', async t => {
  serve(t, () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }));
  const error = await refusalOf('https://bucket.private.example/data.h5ad');
  assert.equal(error.code, 'PERMISSION_DENIED');
  assert.equal(
    error.message,
    'bucket.private.example refused data.h5ad (HTTP 403, forbidden): it is private or deleted, or the link has ' +
      'expired. This is the link\'s permissions, not a fault of bucket.private.example or Cellucid. Ask its owner for a public link.'
  );
  assert.equal(error.details.hostFault.kind, 'refused');
});

test('a host that refuses after answering this site before is refusing this network for now', async t => {
  let refusing = false;
  serve(t, (url, init) => {
    if (refusing) return new Response('unusual traffic', { status: 403 });
    const headers = { 'Content-Range': 'bytes 0-99/100', 'Content-Length': '100' };
    if (init.method === 'HEAD') return new Response(null, { status: 206, headers });
    return new Response(new Uint8Array(100), { status: 206, headers });
  });
  await describe('https://busy.example/first.h5ad');
  refusing = true;
  const error = await refusalOf('https://busy.example/second.h5ad');
  assert.equal(error.code, 'NETWORK_ERROR');
  assert.equal(
    error.message,
    'busy.example is refusing requests from this network for now (HTTP 403, forbidden) for second.h5ad, which it ' +
      'gives everyone: a problem on busy.example\'s side (an outage, or a block after many requests from one network), ' +
      'not with the link or with Cellucid. Try again later.'
  );
  assert.equal(error.details.hostFault.kind, 'refusing');
});

test('a sign-in asked for (401) is the link\'s permissions, even from a host that answered this site before', async t => {
  // Round 9 sources lane (R9S-2): a lab server serving one public and one
  // private folder was said to refuse "this network for now, which it gives
  // everyone" for the private file. No host blocks a network with a 401.
  let signIn = false;
  serve(t, (url, init) => {
    if (signIn) return new Response('<html>Sign in</html>', { status: 401, headers: { 'Content-Type': 'text/html' } });
    const headers = { 'Content-Range': 'bytes 0-99/100', 'Content-Length': '100' };
    if (init.method === 'HEAD') return new Response(null, { status: 206, headers });
    return new Response(new Uint8Array(100), { status: 206, headers });
  });
  await describe('https://mixed.example/public/first.h5ad');
  signIn = true;
  const error = await refusalOf('https://mixed.example/private/second.h5ad');
  assert.equal(error.code, 'PERMISSION_DENIED');
  assert.equal(
    error.message,
    'mixed.example refused second.h5ad (HTTP 401, not signed in): it is private or deleted, or the link has expired. ' +
      'This is the link\'s permissions, not a fault of mixed.example or Cellucid. Ask its owner for a public link.'
  );
  assert.equal(error.details.hostFault.kind, 'refused');
});

test('a host that lets this site read one file and not another says so; one that stopped answering every file is refusing (R9S-3)', async t => {
  // A lab server whose public folder sends CORS headers and whose other
  // folder does not was said to refuse "this network for now, which it gives
  // everyone" for the second file, since the host had answered before.
  let blocked = false;
  const asked = serve(t, (url, init) => {
    if (init.mode === 'no-cors') return new Response(null, { status: 200 });
    if (blocked || url.includes('/plain/')) throw new TypeError('Failed to fetch');
    const headers = { 'Content-Range': 'bytes 0-99/100', 'Content-Length': '100' };
    if (init.method === 'HEAD') return new Response(null, { status: 206, headers });
    return new Response(new Uint8Array(100), { status: 206, headers });
  });
  await describe('https://folders.example/shared/first.h5ad');
  const cors = await refusalOf('https://folders.example/plain/second.h5ad');
  assert.equal(cors.code, 'PERMISSION_DENIED');
  assert.equal(
    cors.message,
    'folders.example does not let other websites read second.h5ad, though it lets them read other files of its, so ' +
      'this site cannot read it. Download it and open it from your computer (Open… › File…).'
  );
  // The file that answered before was asked again, once, to tell.
  assert.equal(asked.filter(request => request.url === 'https://folders.example/shared/first.h5ad' && request.method === 'HEAD').length >= 2, true);
  // Nothing of the host readable any more: refusing this network for now.
  blocked = true;
  const refusing = await refusalOf('https://folders.example/plain/third.h5ad');
  assert.equal(refusing.details.hostFault.kind, 'refusing');
});

test('a host that answers but lets no other website read it is told from one that cannot be reached', async t => {
  const asked = serve(t, (url, init) => {
    // An opaque answer: the host is there (Node has no opaque response; any answer will do).
    if (init.mode === 'no-cors') return new Response(null, { status: 200 });
    throw new TypeError('Failed to fetch');
  });
  const cors = await refusalOf('https://lab.example/atlas.h5ad');
  assert.equal(cors.code, 'PERMISSION_DENIED');
  assert.equal(
    cors.message,
    'lab.example does not let other websites read its files, so this site cannot read atlas.h5ad. ' +
      'Download it and open it from your computer (Open… › File…).'
  );
  // Asked once without reading the answer, to tell the two apart.
  assert.equal(asked.filter(request => request.mode === 'no-cors').length, 1);

  // A 10x matrix file holds no embedding: downloaded alone it is refused
  // too. Both facts at once, and what does open: the outs/ folder its
  // projections are in (the same words the file itself is refused with),
  // or an embedding made.
  const tenx = await refusalOf('https://cf.10xgenomics.example/filtered_feature_bc_matrix.h5');
  assert.match(tenx.message, /^cf\.10xgenomics\.example does not let other websites read its files, so this site cannot read filtered_feature_bc_matrix\.h5\. Downloaded alone it would be refused too: filtered_feature_bc_matrix\.h5 is a 10x Cell Ranger count matrix that has no cell embedding/);
  assert.match(tenx.message, /download the whole outs\/ folder and open it from this computer \(Open… › Folder…\)/);
  assert.doesNotMatch(tenx.message, /Download it and open it from your computer/);
  assert.match(tenx.message, /cellucid\.prepare\(path, format="h5ad", data=adata\)/);
});

test('a host that cannot be reached says to check the address and the connection', async t => {
  serve(t, () => {
    throw new TypeError('Failed to fetch');
  });
  const error = await refusalOf('https://nonexistent-host-cellucid.invalid/a.h5ad');
  assert.equal(error.code, 'NETWORK_ERROR');
  assert.equal(
    error.message,
    'nonexistent-host-cellucid.invalid could not be reached. Check the address and your connection, then try again.'
  );
  assert.doesNotMatch(error.message, /CORS|Download/);
});

test('a host that answered before and gives no answer while this computer is offline is not said to refuse', async t => {
  let offline = false;
  serve(t, (url, init) => {
    if (offline) throw new TypeError('Failed to fetch');
    const headers = { 'Content-Range': 'bytes 0-99/100', 'Content-Length': '100' };
    if (init.method === 'HEAD') return new Response(null, { status: 206, headers });
    return new Response(new Uint8Array(100), { status: 206, headers });
  });
  const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => ({ onLine: !offline }) });
  t.after(() => Object.defineProperty(globalThis, 'navigator', navigator));
  await describe('https://catalog.example/first.zarr.zip');
  offline = true;
  // Measured in a browser test: a dataset switched to after going offline
  // was said to be refused "for now, as hosts do … after many requests".
  const error = await refusalOf('https://catalog.example/second.zarr.zip');
  assert.equal(error.code, 'NETWORK_ERROR');
  assert.equal(error.message, 'This computer is offline, so second.zarr.zip cannot be read from catalog.example: the ' +
    'connection on this side, not catalog.example or Cellucid. Connect, then try again.');
  assert.equal(error.details.hostFault.kind, 'offline');
});

test('a store folder whose first read gets no readable answer is said as a file is, also across the reader worker (R9S-5)', async t => {
  // A Zarr folder on a host without CORS headers said "The linked data could
  // not be opened. Try again; if it keeps failing, check the address" with
  // the byte layer's sentence under Details; a file on the same host said
  // "does not let other websites read its files". The store's error crossed
  // the reader worker as a plain Error named ByteSourceError, which
  // `isUnanswered` did not know.
  const { ByteSourceError, BYTE_SOURCE_FAILURES, isUnanswered } = await import('../assets/js/formats/io/byte-source.js');
  const { toWire, fromWire } = await import('../assets/js/utils/error-wire.js');
  const { unreadableAtHost } = await import('../assets/js/data/sources/remote-file.js');
  const { folderFormatOfName } = await import('../assets/js/data/input-formats.js');
  const url = 'https://nocors-store.example/data/atlas.zarr/.zmetadata';
  const original = new ByteSourceError(BYTE_SOURCE_FAILURES.NETWORK, `${url}: no answer this page may read`, { url, host: 'nocors-store.example', phase: 'answer' });
  const rebuilt = fromWire(toWire(original));
  assert.equal(rebuilt instanceof ByteSourceError, false);
  assert.equal(isUnanswered(rebuilt), true, 'known on the page side of the worker');
  serve(t, (asked, init) => {
    if (init.mode === 'no-cors') return new Response(null, { status: 200 });
    throw new TypeError('Failed to fetch');
  });
  const error = await unreadableAtHost({ url, name: 'atlas.zarr', format: folderFormatOfName('atlas.zarr'), error: rebuilt });
  assert.equal(error.code, 'PERMISSION_DENIED');
  // A folder is downloaded and opened as one.
  assert.equal(error.message, 'nocors-store.example does not let other websites read its files, so this site cannot read atlas.zarr. ' +
    'Download the folder and open it from your computer (Open… › Folder…).');
});

test('a host that stops sending, or never answers, within the read\'s patience is said to stall, not to refuse CORS (R9S-11)', async () => {
  const { ByteSourceError, BYTE_SOURCE_FAILURES } = await import('../assets/js/formats/io/byte-source.js');
  const { unreadableAtHost } = await import('../assets/js/data/sources/remote-file.js');
  const url = 'https://slow.example/atlas.h5ad';
  const body = await unreadableAtHost({ url, name: 'atlas.h5ad', format: null,
    error: new ByteSourceError(BYTE_SOURCE_FAILURES.STALLED, `${url}: no more bytes for 3.0 s.`, { url, phase: 'body', silentMs: 3000 }) });
  assert.equal(body.code, 'NETWORK_ERROR');
  assert.equal(body.message, 'slow.example started sending atlas.h5ad and stopped (no more bytes for 3.0 s), also when asked again: ' +
    'the host, or the connection to it, is failing or very slow. Try again later.');
  const answer = await unreadableAtHost({ url, name: 'atlas.h5ad', format: null,
    error: new ByteSourceError(BYTE_SOURCE_FAILURES.STALLED, `${url}: no answer for 30 s.`, { url, phase: 'answer', silentMs: 30000 }) });
  assert.match(answer.message, /^slow\.example gave no answer for atlas\.h5ad for 30\.0 s, also when asked again: /);
});
