/**
 * Figshare, Google Drive and OneDrive against fake Figshare, Google, Microsoft,
 * S3 and doi.org endpoints: the links each provider claims and the canonical
 * value it gives them, the refusals and their reasons, the requests each
 * opening makes and in what order (its round trips), the headers each
 * request carries, and that no token or pre-authenticated URL reaches what a
 * session, a link or a message records.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getProviderRegistry } from '../assets/js/data/sources/registry.js';
import figshare from '../assets/js/data/sources/providers/figshare.js';
import { createDriveProvider } from '../assets/js/data/sources/providers/gdrive.js';
import { createOneDriveProvider, shareIdOf } from '../assets/js/data/sources/providers/onedrive.js';
import { resolveSourceAccess } from '../assets/js/data/sources/access.js';
import { HEAD_BYTES } from '../assets/js/formats/io/byte-source.js';

const TOKEN = 'TOKEN-MARKER-7f3a';
const DOWNLOAD = 'https://my.microsoftpersonalcontent.com/personal/x/download.aspx?tempauth=TEMPAUTH-MARKER-1';
const KEY = 'AIza-PUBLIC-KEY';
const DRIVE_ID = '1l_5RK28JRL19wpT22B-DY9We3TVXnnQQ';
const SIZE = 3 * 1024 * 1024;

/**
 * Replace fetch with one answering from `routes(url, init)`; each call is
 * recorded with its headers and the time it was made, and a route may hold
 * its answer (`wait`) to show what went out before it.
 */
function installFetch(t, routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) } };
    calls.push(call);
    const answer = (await routes(call)) ?? { status: 404, json: {} };
    let body = null;
    if (answer.status === 206) {
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(call.headers.Range);
      body = new Uint8Array(Math.min(SIZE, Number(end) + 1) - Number(start));
    } else if (answer.json !== undefined) {
      body = JSON.stringify(answer.json);
    }
    const response = new Response(body, { status: answer.status, headers: answer.headers ?? {} });
    Object.defineProperty(response, 'url', { value: answer.url ?? String(url) });
    return response;
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function noSecrets(value) {
  const text = JSON.stringify(value, (key, item) => (item instanceof Uint8Array ? `<${item.length} bytes>` : item));
  for (const marker of [TOKEN, 'TEMPAUTH-MARKER', 'X-Amz-Signature']) {
    assert.ok(!text.includes(marker), `${marker} leaked into ${text.slice(0, 200)}`);
  }
}

test('each provider claims its links and names them canonically', () => {
  const registry = getProviderRegistry();
  const cases = [
    ['https://figshare.com/articles/dataset/squidpy-visium_h5ad/16566057', 'figshare:16566057'],
    ['https://figshare.com/articles/dataset/x/16540047/2?file=30594477', 'figshare:16540047v2/30594477'],
    ['https://uni.figshare.com/articles/dataset/a/123', 'figshare:123'],
    ['10.6084/m9.figshare.16566057.v1', 'figshare:16566057v1'],
    ['https://doi.org/10.6084/m9.figshare.16566057', 'figshare:16566057'],
    ['https://api.figshare.com/v2/articles/16566057/versions/1', 'figshare:16566057v1'],
    ['10.1038/s41586-020-2157-4', 'figshare:doi:10.1038/s41586-020-2157-4'],
    ['figshare:16566057/squidpy-visium.h5ad', 'figshare:16566057/squidpy-visium.h5ad'],
    // Zenodo's DOIs stay Zenodo's.
    ['10.5281/zenodo.123', 'zenodo:123'],
    [`https://drive.google.com/file/d/${DRIVE_ID}/view?usp=sharing`, `gdrive:${DRIVE_ID}`],
    [`https://drive.google.com/file/d/${DRIVE_ID}/view?resourcekey=0-abc`, `gdrive:${DRIVE_ID}~0-abc`],
    [`https://drive.google.com/open?id=${DRIVE_ID}`, `gdrive:${DRIVE_ID}`],
    [`https://drive.google.com/uc?id=${DRIVE_ID}&export=download`, `gdrive:${DRIVE_ID}`],
    [`https://docs.google.com/uc?id=${DRIVE_ID}`, `gdrive:${DRIVE_ID}`],
    [`https://drive.usercontent.google.com/download?id=${DRIVE_ID}&export=download`, `gdrive:${DRIVE_ID}`],
    [`gdrive:${DRIVE_ID}`, `gdrive:${DRIVE_ID}`],
    ['https://1drv.ms/u/c/12a1b84edebf20f7/EVjJu5abc', `onedrive:${shareIdOf('https://1drv.ms/u/c/12a1b84edebf20f7/EVjJu5abc')}`],
    ['https://contoso-my.sharepoint.com/:u:/g/personal/a_contoso_com/EabcXYZ?e=1', `onedrive:${shareIdOf('https://contoso-my.sharepoint.com/:u:/g/personal/a_contoso_com/EabcXYZ?e=1')}`],
    ['https://onedrive.live.com/?id=ABC%21101&cid=ABC123', 'onedrive:abc123/ABC!101'],
    ['onedrive:b!drive/01ITEM', 'onedrive:b!drive/01ITEM'],
  ];
  for (const [input, locator] of cases) assert.equal(registry.resolve(input).locator, locator, input);
});

test('folders, documents, private Figshare links and bare download links are refused with the reason', async () => {
  const google = fakeGoogle();
  const drive = createDriveProvider({ google });
  const onedrive = createOneDriveProvider({ microsoft: fakeMicrosoft() });
  await assert.rejects(drive.open(drive.match(`https://drive.google.com/drive/folders/${DRIVE_ID}`, { explicit: false })),
    /Google Drive folder\. Cellucid opens single files from Google Drive: share the \.h5ad or \.zarr\.zip file itself/);
  await assert.rejects(drive.open(drive.match(`https://docs.google.com/document/d/${DRIVE_ID}/edit`, { explicit: false })),
    /a Google document, not a file Cellucid opens/);
  await assert.rejects(onedrive.open(onedrive.match('https://1drv.ms/f/s!AhMqVPD44cDOhkPsOU2S', { explicit: false })),
    /OneDrive folder\. Cellucid opens single files from OneDrive/);
  await assert.rejects(figshare.open(figshare.match('https://figshare.com/s/abcdef', { explicit: false })),
    /private Figshare link .* Figshare offers no way for a browser to read a private link/s);
  await assert.rejects(figshare.open(figshare.match('https://ndownloader.figshare.com/files/1', { explicit: false })),
    /Figshare file download link\. Paste the item's page or DOI/);
});

const ITEM = {
  id: 16566057,
  version: 1,
  title: 'squidpy-visium.h5ad',
  doi: '10.6084/m9.figshare.16566057.v1',
  figshare_url: 'https://figshare.com/articles/dataset/squidpy-visium_h5ad/16566057',
  license: { name: 'CC BY 4.0' },
  files: [
    { id: 30639279, name: 'squidpy-visium.h5ad', size: SIZE, computed_md5: 'abc', is_link_only: false },
    { id: 1, name: 'notes.pdf', size: 10, is_link_only: false },
  ],
};

test('Figshare: the item names size and checksum, then the file\'s first read; nothing is probed', async t => {
  const calls = installFetch(t, ({ url }) => (url === 'https://api.figshare.com/v2/articles/16566057'
    ? { status: 200, json: ITEM, headers: { 'Access-Control-Allow-Origin': '*' } }
    : url === 'https://ndownloader.figshare.com/files/30639279'
      ? { status: 206, url: 'https://s3.example.org/f?X-Amz-Expires=10&X-Amz-Signature=sig' }
      : null));
  const opened = await figshare.open('16566057');
  assert.deepEqual(calls.map(call => [call.method, call.url]), [
    ['GET', 'https://api.figshare.com/v2/articles/16566057'],
    ['GET', 'https://ndownloader.figshare.com/files/30639279'],
  ]);
  assert.equal(opened.file.resource.head.bytes.length, HEAD_BYTES);
  assert.equal(opened.file.resource.url, 'https://ndownloader.figshare.com/files/30639279');
  assert.equal(opened.file.resource.size, SIZE);
  assert.equal(opened.file.resource.identity.version, 'figshare:16566057v1:abc');
  assert.equal(opened.file.id, 'figshare:16566057:squidpy-visium.h5ad');
  assert.equal(opened.attribution.licence, 'CC BY 4.0');
  assert.equal(opened.attribution.citation, 'doi:10.6084/m9.figshare.16566057.v1');
  // The reader reads the signed S3 link the page got, not ndownloader (whose
  // bot check refuses some workers), and asks the page for a new one.
  assert.deepEqual([...opened.file.resource.access.stale], [403]);
  const target = await resolveSourceAccess(opened.file.resource.access.ref);
  assert.equal(target.url, 'https://s3.example.org/f?X-Amz-Expires=10&X-Amz-Signature=sig');
  assert.ok(target.expiresAt > Date.now() && target.expiresAt <= Date.now() + 10_000);
  const renewed = await resolveSourceAccess(opened.file.resource.access.ref, { refresh: true });
  assert.equal(calls.at(-1).headers.Range, 'bytes=0-0', 'a renewal asks for one byte');
  assert.equal(renewed.url, target.url);
});

test('Figshare: a file named by id is read beside the item (one round trip), only with Range', async t => {
  let release;
  const itemHeld = new Promise(resolve => {
    release = resolve;
  });
  const calls = installFetch(t, async ({ url }) => {
    if (url.startsWith('https://api.figshare.com/')) {
      await itemHeld;
      return { status: 200, json: ITEM };
    }
    if (url === 'https://ndownloader.figshare.com/files/30639279') {
      // The head went out before the item answered.
      release();
      return { status: 206, url: 'https://s3.example.org/f?X-Amz-Expires=10&X-Amz-Signature=sig' };
    }
    return null;
  });
  const opened = await figshare.open('16566057v1/30639279');
  assert.equal(opened.file.resource.head.bytes.length, HEAD_BYTES);
  const head = calls.find(call => call.url.startsWith('https://ndownloader'));
  assert.deepEqual(head.headers, { Range: `bytes=0-${HEAD_BYTES - 1}` });
  noSecrets(opened);
});

test('Figshare: another repository\'s DOI is resolved by doi.org and refused, naming its host', async t => {
  installFetch(t, ({ url }) => (url === 'https://doi.org/api/handles/10.1038/x'
    ? { status: 200, json: { responseCode: 1, values: [{ type: 'URL', data: { value: 'https://www.nature.com/articles/x' } }] } }
    : null));
  await assert.rejects(figshare.open('doi:10.1038/x'), /names a record on www\.nature\.com, which is not a Figshare item/);
});

test('Figshare: an institutional DOI opens the item it resolves to', async t => {
  installFetch(t, ({ url }) => {
    if (url === 'https://doi.org/api/handles/10.25446/oxford.1') {
      return { status: 200, json: { responseCode: 1, values: [{ type: 'URL', data: { value: 'https://ora.figshare.com/articles/dataset/a/16566057' } }] } };
    }
    if (url === 'https://api.figshare.com/v2/articles/16566057') return { status: 200, json: ITEM };
    if (url.startsWith('https://ndownloader.figshare.com/')) return { status: 206, url: 'https://s3.example.org/f?X-Amz-Expires=10' };
    return null;
  });
  assert.equal((await figshare.open('doi:10.25446/oxford.1')).file.name, 'squidpy-visium.h5ad');
});

/** A Google sign-in that answers from memory. */
function fakeGoogle({ apiKey = KEY, signIn = null, token = null, picks = [] } = {}) {
  const state = { token, authorized: 0, picked: [], refusedTokens: [] };
  return Object.assign(state, {
    apiKey,
    whyNoPublicAccess: () => (apiKey ? null : 'Google Drive is not configured on this site yet.'),
    whyNoSignIn: () => signIn,
    loadScripts: async () => {},
    validToken: () => state.token,
    authorize: async ({ kind }) => {
      state.authorized += 1;
      state.lastKind = kind;
      state.token = `${TOKEN}-${state.authorized}`;
      return state.token;
    },
    pick: async id => {
      state.picked.push(id);
      return picks.shift() ?? id;
    },
    refused: given => {
      state.refusedTokens.push(given);
      if (state.token === given) state.token = null;
    },
    signOut: () => {},
    signedIn: () => state.token !== null,
  });
}

const DRIVE_ITEM = { id: DRIVE_ID, name: 'atlas.h5ad', size: String(SIZE), md5Checksum: 'd41d', mimeType: 'application/octet-stream', capabilities: { canDownload: true } };
const isMetadata = url => url.includes(`/files/${DRIVE_ID}?fields=`);
const isMedia = url => url.includes(`/files/${DRIVE_ID}?alt=media`);

test('Drive, public: item and head go out together with the key, with no header but Range (no preflight)', async t => {
  let release;
  const held = new Promise(resolve => {
    release = resolve;
  });
  const calls = installFetch(t, async ({ url }) => {
    if (isMetadata(url)) {
      await held;
      return { status: 200, json: DRIVE_ITEM };
    }
    if (isMedia(url)) {
      release();
      return { status: 206 };
    }
    return null;
  });
  const drive = createDriveProvider({ google: fakeGoogle() });
  const opened = await drive.open(DRIVE_ID);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.url.includes(`key=${KEY}`));
    assert.deepEqual(Object.keys(call.headers).filter(name => name !== 'Range'), []);
  }
  assert.equal(opened.file.resource.head.bytes.length, HEAD_BYTES);
  // The display link carries no key; the reads get it from the page.
  assert.ok(!opened.file.resource.url.includes('key='));
  assert.deepEqual(Object.keys(opened.file.resource.access).sort(), ['provider', 'ref', 'stale']);
  const target = await resolveSourceAccess(opened.file.resource.access.ref);
  assert.ok(target.url.includes(`key=${KEY}`) && target.url.includes('alt=media'));
  assert.deepEqual(target.headers, {});
  assert.equal(opened.file.resource.identity.key, `gdrive:${DRIVE_ID}`);
  assert.equal(opened.file.resource.identity.version, `md5:d41d:${SIZE}`);
});

test('Drive: a resource key goes in its header only on files whose link had one', async t => {
  const calls = installFetch(t, ({ url }) => (isMetadata(url) ? { status: 200, json: DRIVE_ITEM } : isMedia(url) ? { status: 206 } : null));
  const drive = createDriveProvider({ google: fakeGoogle() });
  await drive.open(`${DRIVE_ID}~0-rk`);
  for (const call of calls) assert.equal(call.headers['X-Goog-Drive-Resource-Keys'], `${DRIVE_ID}/0-rk`);
});

test('Drive: rate limits (403) are asked again, a download quota is said, Google documents are refused', async t => {
  let limited = 1;
  installFetch(t, ({ url }) => {
    if (!isMetadata(url)) return { status: 206 };
    if (limited-- > 0) return { status: 403, json: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } };
    return { status: 200, json: DRIVE_ITEM };
  });
  const drive = createDriveProvider({ google: fakeGoogle() });
  assert.equal((await drive.open(DRIVE_ID)).file.name, 'atlas.h5ad');
});

test('Drive: Google\'s per-file download quota and Google documents are refused with the reason', async t => {
  let answer = { status: 403, json: { error: { errors: [{ reason: 'downloadQuotaExceeded' }] } } };
  installFetch(t, ({ url }) => (isMetadata(url) ? answer : { status: 403 }));
  const drive = createDriveProvider({ google: fakeGoogle() });
  await assert.rejects(drive.open(DRIVE_ID), /Google has limited downloads of this file for now/);
  answer = { status: 200, json: { ...DRIVE_ITEM, mimeType: 'application/vnd.google-apps.spreadsheet', name: 'Sheet' } };
  await assert.rejects(drive.open(DRIVE_ID), /Sheet is a Google document, not a file Cellucid opens/);
  answer = { status: 200, json: { ...DRIVE_ITEM, mimeType: 'application/vnd.google-apps.folder' } };
  await assert.rejects(drive.open(DRIVE_ID), /Google Drive folder/);
});

test('Drive: not configured on this site says so; a private file without sign-in names why', async t => {
  await assert.rejects(createDriveProvider({ google: fakeGoogle({ apiKey: '' }) }).open(DRIVE_ID),
    /Google Drive is not configured on this site yet/);
  installFetch(t, () => ({ status: 404, json: { error: { errors: [{ reason: 'notFound' }] } } }));
  const google = fakeGoogle({ signIn: 'Signing in to Google is not configured on this site yet.' });
  await assert.rejects(createDriveProvider({ google }).open(DRIVE_ID),
    /This file is private on Google Drive, or the link is wrong\. Signing in to Google is not configured on this site yet\./);
  assert.equal(google.authorized, 0);
});

test('Drive, private: sign in, the picker on this one file, then the token goes to googleapis.com only', async t => {
  let granted = false;
  const calls = installFetch(t, ({ url, headers }) => {
    const signed = typeof headers.Authorization === 'string';
    if (!signed) return { status: 404, json: { error: { errors: [{ reason: 'notFound' }] } } };
    if (!granted) return { status: 404, json: { error: { errors: [{ reason: 'notFound' }] } } };
    return isMetadata(url) ? { status: 200, json: DRIVE_ITEM } : { status: 206 };
  });
  const google = fakeGoogle();
  google.pick = async id => {
    google.picked.push(id);
    granted = true;
    return id;
  };
  const steps = [];
  const opened = await createDriveProvider({ google }).open(DRIVE_ID, { onStep: step => steps.push(step) });
  assert.equal(google.authorized, 1);
  assert.equal(google.lastKind, 'sign-in');
  assert.deepEqual(google.picked, [DRIVE_ID]);
  assert.ok(steps.some(step => /file picker/.test(step)));
  for (const call of calls.filter(item => item.headers.Authorization)) {
    assert.equal(new URL(call.url).host, 'www.googleapis.com');
    assert.ok(!call.url.includes('key='), 'a signed request carries no key');
  }
  noSecrets({ opened, steps });
  const target = await resolveSourceAccess(opened.file.resource.access.ref);
  assert.equal(target.headers.Authorization, `Bearer ${google.token}`);
  // A refused token is forgotten and a new one asked for.
  const before = google.token;
  const renewed = await resolveSourceAccess(opened.file.resource.access.ref, { refresh: true });
  assert.deepEqual(google.refusedTokens, [before]);
  assert.equal(google.lastKind, 'expired');
  assert.notEqual(renewed.headers.Authorization, `Bearer ${before}`);
});

test('Drive, signed in already: a granted private file opens in the same round trips, no picker', async t => {
  installFetch(t, ({ url, headers }) => {
    if (!headers.Authorization) return { status: 404, json: {} };
    return isMetadata(url) ? { status: 200, json: DRIVE_ITEM } : { status: 206 };
  });
  const google = fakeGoogle({ token: `${TOKEN}-held` });
  const opened = await createDriveProvider({ google }).open(DRIVE_ID);
  assert.equal(google.authorized, 0);
  assert.deepEqual(google.picked, []);
  assert.equal(opened.file.resource.head.bytes.length, HEAD_BYTES);
});

/** A Microsoft sign-in that answers from memory. */
function fakeMicrosoft({ signIn = null } = {}) {
  const state = { calls: [], wide: false, token: null, refusedTokens: [] };
  return Object.assign(state, {
    whyNoSignIn: () => signIn,
    hasWideAccess: () => state.wide,
    silentToken: async () => state.token,
    authorize: async ({ kind, more = false }) => {
      state.calls.push({ kind, more });
      if (more) state.wide = true;
      state.token = `${TOKEN}-${state.calls.length}`;
      return state.token;
    },
    refused: token => state.refusedTokens.push(token),
    signOut: () => {},
    signedIn: () => state.token !== null,
  });
}

const SHARE = 'https://1drv.ms/u/c/12a1b84edebf20f7/EVjJu5abc';
const GRAPH_ITEM = {
  id: '12A1B84EDEBF20F7!101',
  name: 'atlas.h5ad',
  size: SIZE,
  file: {},
  cTag: 'c1',
  webUrl: 'https://onedrive.live.com/?id=x',
  parentReference: { driveId: '12a1b84edebf20f7' },
  '@microsoft.graph.downloadUrl': DOWNLOAD,
};

test('OneDrive: not configured says so; every file asks for a Microsoft sign-in', async () => {
  const onedrive = createOneDriveProvider({ microsoft: fakeMicrosoft({ signIn: 'Signing in to Microsoft is not configured on this site yet.' }) });
  await assert.rejects(onedrive.open(onedrive.match(SHARE, { explicit: false })),
    /OneDrive files open only after a Microsoft sign-in\. Signing in to Microsoft is not configured on this site yet\./);
});

test('OneDrive: a share link is redeemed durably, then read from its download URL with Range only', async t => {
  const calls = installFetch(t, ({ url }) => {
    if (url.startsWith('https://graph.microsoft.com/')) return { status: 200, json: GRAPH_ITEM };
    if (url === DOWNLOAD) return { status: 206 };
    return null;
  });
  const microsoft = fakeMicrosoft();
  const onedrive = createOneDriveProvider({ microsoft });
  const value = onedrive.match(SHARE, { explicit: false });
  const opened = await onedrive.open(value);
  assert.deepEqual(microsoft.calls, [{ kind: 'sign-in', more: false }]);
  const [graph, head] = calls;
  assert.ok(graph.url.startsWith(`https://graph.microsoft.com/v1.0/shares/${value}/driveItem?$select=`));
  assert.equal(graph.headers.Prefer, 'redeemSharingLink');
  assert.equal(graph.headers.Authorization, `Bearer ${microsoft.token}`);
  assert.equal(head.url, DOWNLOAD);
  assert.deepEqual(head.headers, { Range: `bytes=0-${HEAD_BYTES - 1}` });
  // Named from now on by drive and item, never by the share link.
  assert.equal(opened.locator, '12a1b84edebf20f7/12A1B84EDEBF20F7!101');
  assert.equal(opened.file.resource.url, 'https://graph.microsoft.com/v1.0/drives/12a1b84edebf20f7/items/12A1B84EDEBF20F7!101/content');
  assert.deepEqual([...opened.file.resource.access.stale], [401, 403, 404]);
  noSecrets(opened);
  assert.equal((await resolveSourceAccess(opened.file.resource.access.ref)).url, DOWNLOAD);
});

test('OneDrive: a stale download URL is renewed through Graph; a changed file is refused, not mixed', async t => {
  let cTag = 'c1';
  let renewals = 0;
  installFetch(t, ({ url }) => {
    if (url.startsWith('https://graph.microsoft.com/')) {
      renewals += 1;
      return { status: 200, json: { ...GRAPH_ITEM, cTag, '@microsoft.graph.downloadUrl': `${DOWNLOAD}-${renewals}` } };
    }
    return { status: 206 };
  });
  const onedrive = createOneDriveProvider({ microsoft: fakeMicrosoft() });
  const opened = await onedrive.open('drive1/item1');
  const fresh = await resolveSourceAccess(opened.file.resource.access.ref, { refresh: true });
  assert.equal(fresh.url, `${DOWNLOAD}-2`);
  assert.ok(Number.isFinite(fresh.expiresAt), 'once seen to expire, the URL is renewed ahead of time');
  cTag = 'c2';
  await assert.rejects(resolveSourceAccess(opened.file.resource.access.ref, { refresh: true }), error => {
    assert.equal(error.code, 'changed');
    assert.match(error.message, /atlas\.h5ad changed on OneDrive while it was open/);
    return true;
  });
});

test('OneDrive: a colleague\'s file asks for Files.Read.All once, then names why it cannot be opened', async t => {
  installFetch(t, () => ({ status: 403, json: { error: { code: 'accessDenied' } } }));
  const microsoft = fakeMicrosoft();
  const onedrive = createOneDriveProvider({ microsoft });
  await assert.rejects(onedrive.open('drive1/item1'), /Your Microsoft account cannot open this file/);
  assert.deepEqual(microsoft.calls, [{ kind: 'sign-in', more: false }, { kind: 'more-access', more: true }]);
});

test('Graph\'s 429 is asked again as long as Retry-After asks', async t => {
  let busy = 1;
  installFetch(t, ({ url }) => {
    if (url.startsWith('https://graph.microsoft.com/') && busy-- > 0) {
      return { status: 429, json: {}, headers: { 'Retry-After': '0' } };
    }
    return url.startsWith('https://graph.microsoft.com/') ? { status: 200, json: GRAPH_ITEM } : { status: 206 };
  });
  const opened = await createOneDriveProvider({ microsoft: fakeMicrosoft() }).open('drive1/item1');
  assert.equal(opened.file.name, 'atlas.h5ad');
});

test('Drive: a token refused while opening is renewed, and the picker is still offered after it', async t => {
  let granted = false;
  let refusedOnce = false;
  installFetch(t, ({ url, headers }) => {
    if (!headers.Authorization) return { status: 404, json: {} };
    if (!refusedOnce && isMetadata(url)) {
      refusedOnce = true;
      return { status: 401, json: {} };
    }
    if (!granted) return { status: 404, json: {} };
    return isMetadata(url) ? { status: 200, json: DRIVE_ITEM } : { status: 206 };
  });
  const google = fakeGoogle();
  google.pick = async id => {
    google.picked.push(id);
    granted = true;
    return id;
  };
  const opened = await createDriveProvider({ google }).open(DRIVE_ID);
  assert.equal(opened.file.name, 'atlas.h5ad');
  assert.equal(google.authorized, 2);
  assert.deepEqual(google.picked, [DRIVE_ID]);
});

test('Figshare: a bot challenge from the file host is said for what it is', async t => {
  installFetch(t, ({ url }) => (url.startsWith('https://api.figshare.com/')
    ? { status: 200, json: ITEM }
    : { status: 202, headers: { 'x-amzn-waf-action': 'challenge' } }));
  await assert.rejects(figshare.open('16566057'), error => {
    assert.equal(error.message, "Figshare's file host refused this browser with a bot check, so squidpy-visium.h5ad cannot be read here. Try again in a minute, open it in another browser, or download it from Figshare and open it from your computer.");
    assert.ok(!error.message.includes('ndownloader'));
    return true;
  });
});
