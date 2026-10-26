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
import { confirmSourceUnreadable, resolveSourceAccess } from '../assets/js/data/sources/access.js';
import { HEAD_BYTES } from '../assets/js/formats/io/byte-source.js';
import { openableNamesText } from '../assets/js/data/input-formats.js';

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
    const call = { url: String(url), method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) }, cache: init.cache ?? null };
    calls.push(call);
    const answer = (await routes(call)) ?? { status: 404, json: {} };
    // An answer the page is not let read (no CORS headers): fetch rejects.
    if (answer.unreadable === true) throw new TypeError('Failed to fetch');
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
    // gdown's links often carry the account index.
    [`https://drive.google.com/u/0/uc?id=${DRIVE_ID}&export=download`, `gdrive:${DRIVE_ID}`],
    [`https://drive.usercontent.google.com/download?id=${DRIVE_ID}&export=download`, `gdrive:${DRIVE_ID}`],
    [`gdrive:${DRIVE_ID}`, `gdrive:${DRIVE_ID}`],
    ['https://1drv.ms/u/c/12a1b84edebf20f7/EVjJu5abc', `onedrive:${shareIdOf('https://1drv.ms/u/c/12a1b84edebf20f7/EVjJu5abc')}`],
    ['https://contoso-my.sharepoint.com/:u:/g/personal/a_contoso_com/EabcXYZ?e=1', `onedrive:${shareIdOf('https://contoso-my.sharepoint.com/:u:/g/personal/a_contoso_com/EabcXYZ?e=1')}`],
    ['https://onedrive.live.com/?id=ABC%21101&cid=ABC123', 'onedrive:abc123/ABC!101'],
    // Where a 1drv.ms link lands in the browser.
    ['https://onedrive.live.com/:u:/g/personal/7E4D9DF0F86D712D/s!Ai1x?resid=7E4D9DF0F86D712D!33354&e=k&redeem=a',
      `onedrive:${shareIdOf('https://onedrive.live.com/:u:/g/personal/7E4D9DF0F86D712D/s!Ai1x?resid=7E4D9DF0F86D712D!33354&e=k&redeem=a')}`],
    ['onedrive:b!drive/01ITEM', 'onedrive:b!drive/01ITEM'],
  ];
  for (const [input, locator] of cases) assert.equal(registry.resolve(input).locator, locator, input);
});

test('folders, documents, private Figshare links and bare download links are refused with the reason', async () => {
  const google = fakeGoogle();
  const drive = createDriveProvider({ google });
  const onedrive = createOneDriveProvider({ microsoft: fakeMicrosoft() });
  await assert.rejects(drive.open(drive.match(`https://drive.google.com/drive/folders/${DRIVE_ID}`, { explicit: false })),
    error => error.message.startsWith('This link is a Google Drive folder. Cellucid opens single files from Google Drive: share the file itself ' +
      `(${openableNamesText({ layouts: ['file', 'zip'] })})`));
  await assert.rejects(drive.open(drive.match(`https://docs.google.com/document/d/${DRIVE_ID}/edit`, { explicit: false })),
    /a Google document, not a file Cellucid opens/);
  await assert.rejects(onedrive.open(onedrive.match('https://1drv.ms/f/s!AhMqVPD44cDOhkPsOU2S', { explicit: false })),
    /OneDrive folder\. Cellucid opens single files from OneDrive/);
  // A page of OneDrive or SharePoint, not a share link: said so, before any sign-in.
  for (const page of ['https://contoso-my.sharepoint.com/personal/a_contoso_com/_layouts/15/onedrive.aspx?id=%2Fpersonal%2Fa',
    'https://onedrive.live.com/?view=0']) {
    await assert.rejects(onedrive.open(onedrive.match(page, { explicit: false })),
      /the address of a OneDrive page, not a link to a file\. In OneDrive, select the file, click Share, then Copy link/);
  }
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
  // The signed link's lifetime is counted on the wall clock: held still here.
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
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
  // Its 10 s, from when its request was sent, less the time it took to answer.
  assert.equal(target.expiresAt, 1_000_000 + 10_000);
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
  const opened = await figshare.open('doi:10.25446/oxford.1');
  assert.equal(opened.file.name, 'squidpy-visium.h5ad');
  // Named from then on by the item, as `?data=` and sessions record it.
  assert.equal(opened.locator, '16566057');
  // A Figshare reference is its own name already.
  assert.equal((await figshare.open('16566057')).locator, undefined);
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
  assert.deepEqual(Object.keys(opened.file.resource.access).sort(), ['provider', 'ref', 'stale', 'unreadable']);
  // A read Google holds back from the key is said for what it is.
  assert.match(opened.file.resource.access.unreadable, /without a Google sign-in for now/);
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

test('Drive: a public file whose bytes Google holds back from the key opens after a sign-in and the picker', async t => {
  let granted = false;
  const calls = installFetch(t, ({ url, headers }) => {
    const signed = typeof headers.Authorization === 'string';
    // Google's "unusual traffic" page: HTTP 403 without CORS headers, for the key's downloads only.
    if (!signed) return isMetadata(url) ? { status: 200, json: DRIVE_ITEM } : { unreadable: true };
    if (!granted) return { status: 404, json: { error: { errors: [{ reason: 'notFound' }] } } };
    return isMetadata(url) ? { status: 200, json: DRIVE_ITEM } : { status: 206 };
  });
  const google = fakeGoogle();
  const texts = [];
  const authorize = google.authorize;
  google.authorize = async request => {
    texts.push(request.text);
    return authorize(request);
  };
  google.pick = async id => {
    google.picked.push(id);
    granted = true;
    return id;
  };
  const opened = await createDriveProvider({ google }).open(DRIVE_ID);
  assert.deepEqual(texts, ['Google Drive sends this file only with a Google sign-in for now.']);
  assert.deepEqual(google.picked, [DRIVE_ID]);
  const target = await resolveSourceAccess(opened.file.resource.access.ref);
  assert.equal(target.headers.Authorization, `Bearer ${google.token}`);
  assert.ok(!target.url.includes('key='));
  // The key's head was asked once, then confirmed with one byte: no loop.
  assert.deepEqual(calls.filter(call => isMedia(call.url) && !call.headers.Authorization).map(call => call.headers.Range),
    [`bytes=0-${HEAD_BYTES - 1}`, 'bytes=0-0']);
  noSecrets({ opened });
});

test('Drive: a head read that fails once while its one-byte confirm is answered opens the public file, without its head', async t => {
  let failed = false;
  const calls = installFetch(t, ({ url, headers }) => {
    if (isMetadata(url)) return { status: 200, json: DRIVE_ITEM };
    if (!failed && headers.Range === `bytes=0-${HEAD_BYTES - 1}`) {
      failed = true;
      return { unreadable: true };
    }
    return { status: 206 };
  });
  const google = fakeGoogle();
  const opened = await createDriveProvider({ google }).open(DRIVE_ID);
  assert.equal(google.authorized, 0);
  assert.equal(opened.file.resource.head, undefined);
  // The head asked once, then the confirm: no generic repeats.
  assert.deepEqual(calls.filter(call => isMedia(call.url)).map(call => call.headers.Range), [`bytes=0-${HEAD_BYTES - 1}`, 'bytes=0-0']);
});

test('Drive: held back where no sign-in is possible, the refusal says what Google does and what to do', async t => {
  installFetch(t, ({ url }) => (isMetadata(url) ? { status: 200, json: DRIVE_ITEM } : { unreadable: true }));
  const google = fakeGoogle({ signIn: 'Signing in to Google is not configured on this site yet.' });
  await assert.rejects(createDriveProvider({ google }).open(DRIVE_ID), error => {
    assert.match(error.message, /^Google Drive is not sending this file to this browser without a Google sign-in for now/);
    assert.match(error.message, /Try again in a few minutes, or download the file from Google Drive/);
    assert.doesNotMatch(error.message, /CORS/);
    return true;
  });
  assert.equal(google.authorized, 0);
});

test('Drive, opened: a later read is held back only when the details answer while one byte fails', async t => {
  let state = 'open';
  const calls = installFetch(t, ({ url }) => {
    if (state === 'offline') return { unreadable: true };
    if (isMetadata(url)) return { status: 200, json: DRIVE_ITEM };
    return state === 'held' ? { unreadable: true } : { status: 206 };
  });
  const opened = await createDriveProvider({ google: fakeGoogle() }).open(DRIVE_ID);
  const { ref } = opened.file.resource.access;
  // Google holds the address's downloads back: the details answer, the byte does not.
  state = 'held';
  calls.length = 0;
  assert.equal(await confirmSourceUnreadable(ref), true);
  assert.deepEqual(calls.filter(call => isMedia(call.url)).map(call => call.headers.Range), ['bytes=0-0']);
  assert.ok(calls.every(call => call.url.includes(`key=${KEY}`) && !call.headers.Authorization));
  // The byte answers: not held back, whatever the read that failed met.
  state = 'open';
  assert.equal(await confirmSourceUnreadable(ref), false);
  // Nothing answers: a lost connection, not a hold.
  state = 'offline';
  assert.equal(await confirmSourceUnreadable(ref), false);
});

test('Drive, signed in already: a granted public file is read with the sign-in, not the key', async t => {
  const calls = installFetch(t, ({ url }) => (isMetadata(url) ? { status: 200, json: DRIVE_ITEM } : { status: 206 }));
  const google = fakeGoogle({ token: `${TOKEN}-held` });
  const opened = await createDriveProvider({ google }).open(DRIVE_ID);
  const target = await resolveSourceAccess(opened.file.resource.access.ref);
  assert.equal(target.headers.Authorization, `Bearer ${TOKEN}-held`);
  assert.ok(!target.url.includes('key='));
  assert.equal(opened.file.resource.access.unreadable, null);
  // Its head was read once, signed in.
  assert.equal(calls.filter(call => isMedia(call.url)).length, 1);
  assert.ok(calls.filter(call => isMedia(call.url)).every(call => call.headers.Authorization));
});

/**
 * Google's answers for one file in one state: the key reads a public file
 * (its downloads held back or not), a `drive.file` sign-in reads only a file
 * granted to Cellucid (chosen once in the picker; any other is "not found",
 * public or not), and a hold never touches signed requests.
 */
function driveWorld(t, { visibility, hold, granted }) {
  const world = { granted, calls: null };
  world.calls = installFetch(t, ({ url, headers }) => {
    const signed = typeof headers.Authorization === 'string';
    if (signed) {
      if (!world.granted) return { status: 404, json: { error: { errors: [{ reason: 'notFound' }] } } };
      return isMetadata(url) ? { status: 200, json: DRIVE_ITEM } : { status: 206 };
    }
    if (visibility === 'private') return { status: 404, json: { error: { errors: [{ reason: 'notFound' }] } } };
    if (isMetadata(url)) return { status: 200, json: DRIVE_ITEM };
    return hold ? { unreadable: true } : { status: 206 };
  });
  return world;
}

/** The fake sign-in of a world: picking the file grants it there. */
function worldGoogle(world, { signedIn, pickCancelled = false }) {
  const google = fakeGoogle({ token: signedIn ? `${TOKEN}-held` : null });
  google.texts = [];
  const authorize = google.authorize;
  google.authorize = async request => {
    google.texts.push(request.text);
    return authorize(request);
  };
  google.pick = async id => {
    google.picked.push(id);
    if (pickCancelled) {
      const error = new Error('Google\'s file picker was closed without choosing the file.');
      error.code = 'NOT_PICKED';
      throw error;
    }
    world.granted = true;
    return id;
  };
  return google;
}

for (const signedIn of [false, true]) {
  for (const granted of [false, true]) {
    for (const visibility of ['public', 'private']) {
      for (const hold of [false, true]) {
        const cell = `${signedIn ? 'signed in' : 'signed out'}, ${granted ? 'granted' : 'not granted'}, ${visibility}, ${hold ? 'held back' : 'not held back'}`;
        test(`Drive state matrix: ${cell}`, async t => {
          const world = driveWorld(t, { visibility, hold, granted });
          const google = worldGoogle(world, { signedIn });
          const steps = [];
          const opened = await createDriveProvider({ google }).open(DRIVE_ID, { onStep: step => steps.push(step) });
          const target = await resolveSourceAccess(opened.file.resource.access.ref);
          const keyed = !signedIn && visibility === 'public' && !hold;
          // Read with the key only when nobody is signed in and Google lets the key through.
          assert.equal(target.url.includes(`key=${KEY}`), keyed);
          assert.equal(target.headers.Authorization === undefined, keyed);
          // A sign-in is asked for only when nobody is signed in and the key cannot read it.
          assert.equal(google.authorized, !signedIn && !keyed ? 1 : 0);
          if (google.authorized === 1) {
            assert.deepEqual(google.texts, [visibility === 'public'
              ? 'Google Drive sends this file only with a Google sign-in for now.'
              : 'Private file on Google Drive.']);
          }
          // The picker opens exactly when a signed read needs a file not granted yet.
          assert.deepEqual(google.picked, !keyed && !granted ? [DRIVE_ID] : []);
          // Someone signed in is never asked to sign in, and never read with the key.
          if (signedIn) {
            assert.ok(steps.every(step => !/sign in/i.test(step)), steps.join(' | '));
            assert.ok(world.calls.filter(call => isMedia(call.url)).every(call => call.headers.Authorization),
              'a signed-in reader sends no keyed download a hold could stop');
          }
          // The first bytes are read once on the way that reads the file.
          assert.equal(opened.file.resource.head?.bytes.length, HEAD_BYTES);
          assert.equal(opened.file.resource.identity.key, `gdrive:${DRIVE_ID}`);
          assert.equal(opened.file.resource.identity.version, `md5:d41d:${SIZE}`);
          noSecrets({ opened, steps });
        });
      }
    }
  }
}

test('Drive, signed in: the picker closed on a public file reads it with the key, unless Google holds it back', async t => {
  for (const hold of [false, true]) {
    const world = driveWorld(t, { visibility: 'public', hold, granted: false });
    const google = worldGoogle(world, { signedIn: true, pickCancelled: true });
    const opening = createDriveProvider({ google }).open(DRIVE_ID);
    if (!hold) {
      const opened = await opening;
      assert.ok((await resolveSourceAccess(opened.file.resource.access.ref)).url.includes(`key=${KEY}`));
    } else {
      await assert.rejects(opening, error => {
        assert.match(error.message, /^Google Drive is not sending this file to this browser without a Google sign-in for now/);
        assert.match(error.message, /Choose the file in Google's file picker to read it with your Google account/);
        assert.doesNotMatch(error.message, /Sign in to Google/);
        return true;
      });
    }
    assert.equal(google.authorized, 0);
    assert.deepEqual(google.picked, [DRIVE_ID]);
  }
  // A private file closed in the picker says why it cannot be read.
  const world = driveWorld(t, { visibility: 'private', hold: false, granted: false });
  const google = worldGoogle(world, { signedIn: true, pickCancelled: true });
  await assert.rejects(createDriveProvider({ google }).open(DRIVE_ID), /closed without choosing the file/);
});

test('Drive, signed in with a token Google refuses: signed out, the key reads a public file, a hold asks for a sign-in', async t => {
  for (const hold of [false, true]) {
    let signedAnswers = 0;
    const calls = installFetch(t, ({ url, headers }) => {
      if (headers.Authorization === `Bearer ${TOKEN}-held`) {
        signedAnswers += 1;
        return { status: 401, json: { error: { code: 401 } } };
      }
      if (headers.Authorization) return isMetadata(url) ? { status: 200, json: DRIVE_ITEM } : { status: 206 };
      if (isMetadata(url)) return { status: 200, json: DRIVE_ITEM };
      return hold ? { unreadable: true } : { status: 206 };
    });
    const google = fakeGoogle({ token: `${TOKEN}-held` });
    const opened = await createDriveProvider({ google }).open(DRIVE_ID);
    assert.deepEqual(google.refusedTokens, [`${TOKEN}-held`]);
    assert.ok(signedAnswers >= 1);
    const target = await resolveSourceAccess(opened.file.resource.access.ref);
    assert.equal(target.url.includes(`key=${KEY}`), !hold);
    assert.equal(google.authorized, hold ? 1 : 0);
    // The key's head is asked for once the token is refused, and a hold is confirmed with one byte.
    assert.deepEqual(calls.filter(call => isMedia(call.url) && !call.headers.Authorization).map(call => call.headers.Range),
      hold ? [`bytes=0-${HEAD_BYTES - 1}`, 'bytes=0-0'] : [`bytes=0-${HEAD_BYTES - 1}`]);
  }
});

test('Drive: a keyed read held back later says to open the file again with the Google account, signed in or not', async t => {
  installFetch(t, ({ url }) => (isMetadata(url) ? { status: 200, json: DRIVE_ITEM } : { status: 206 }));
  const opened = await createDriveProvider({ google: fakeGoogle() }).open(DRIVE_ID);
  assert.match(opened.file.resource.access.unreadable, /Open the file again to read it with your Google account, or try again in a few minutes\.$/);
  assert.doesNotMatch(opened.file.resource.access.unreadable, /Sign in to Google/);
});

test('Drive: signed and keyed reads of one file take the same path: one target, one URL per lane, one identity', async t => {
  const { httpByteSource } = await import('../assets/js/formats/io/byte-source.js');
  // The media address a read goes to, signed (no key) or keyed.
  const target = world => world.calls[0].url.replace(/&lane=\d+$/, '');
  const identities = [];
  for (const signedIn of [false, true]) {
    const world = driveWorld(t, { visibility: 'public', hold: false, granted: true });
    const google = worldGoogle(world, { signedIn });
    const opened = await createDriveProvider({ google }).open(DRIVE_ID);
    identities.push(opened.file.resource.identity);
    const { access } = opened.file.resource;
    let targets = 0;
    const source = httpByteSource(opened.file.resource, {
      access: {
        target: async request => {
          targets += 1;
          return resolveSourceAccess(access.ref, request);
        },
        unreadable: access.unreadable,
        confirmUnreadable: () => confirmSourceUnreadable(access.ref),
      },
    });
    world.calls.length = 0;
    await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(index => source.read(index * 65536, 1000)));
    const first = world.calls.map(call => call.url);
    world.calls.length = 0;
    await Promise.all([8, 9, 10, 11, 12, 13, 14, 15].map(index => source.read(index * 65536, 1000)));
    const second = world.calls.map(call => call.url);
    assert.equal(targets, 1, 'every read shares one target: no token asked for per request');
    assert.equal(first.length, 8, 'one request per range, nothing else');
    if (signedIn) {
      // Preflighted: each request in flight has its own stable URL, whose
      // preflight the browser keeps (cache 'default'); the next requests reuse them.
      assert.deepEqual(new Set(first), new Set([0, 1, 2, 3, 4, 5, 6, 7].map(lane => `${target(world)}&lane=${lane}`)));
      assert.deepEqual(new Set(second), new Set(first));
      assert.ok(world.calls.every(call => call.cache === 'default'));
    } else {
      // Safelisted (Range only): no preflight, one URL, past the HTTP cache.
      assert.deepEqual(new Set([...first, ...second]), new Set([target(world)]));
      assert.ok(world.calls.every(call => call.cache === 'no-store'));
    }
    for (const call of world.calls) {
      assert.deepEqual(Object.keys(call.headers).sort(), signedIn ? ['Authorization', 'Range'] : ['Range']);
    }
  }
  // The same file, whoever reads it: what is kept of it (an R object's copy) is found again.
  assert.deepEqual(identities[0], identities[1]);
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

/**
 * Graph's answer for one drive item, as Graph gives it: a `$select` keeps
 * only the plain fields it names and drops `@microsoft.graph.downloadUrl`
 * even when it names it (seen on a personal OneDrive, 2026-10-25).
 */
function graphAnswer(url, item) {
  const select = new URL(url).searchParams.get('$select');
  if (select === null) return { status: 200, json: item };
  const named = new Set(select.split(','));
  return { status: 200, json: Object.fromEntries(Object.entries(item).filter(([key]) => named.has(key) && !key.startsWith('@'))) };
}

test('OneDrive: not configured says so; every file asks for a Microsoft sign-in', async () => {
  const onedrive = createOneDriveProvider({ microsoft: fakeMicrosoft({ signIn: 'Signing in to Microsoft is not configured on this site yet.' }) });
  await assert.rejects(onedrive.open(onedrive.match(SHARE, { explicit: false })),
    /OneDrive files open only after a Microsoft sign-in\. Signing in to Microsoft is not configured on this site yet\./);
});

test('OneDrive: a share link is redeemed durably, then read from its download URL with Range only', async t => {
  const calls = installFetch(t, ({ url }) => {
    if (url.startsWith('https://graph.microsoft.com/')) return graphAnswer(url, GRAPH_ITEM);
    if (url === DOWNLOAD) return { status: 206 };
    return null;
  });
  const microsoft = fakeMicrosoft();
  const onedrive = createOneDriveProvider({ microsoft });
  const value = onedrive.match(SHARE, { explicit: false });
  const opened = await onedrive.open(value);
  assert.deepEqual(microsoft.calls, [{ kind: 'sign-in', more: false }]);
  const [graph, head] = calls;
  // The whole item: Graph names the download URL only in an answer whose fields are not selected.
  assert.equal(graph.url, `https://graph.microsoft.com/v1.0/shares/${value}/driveItem`);
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
      return graphAnswer(url, { ...GRAPH_ITEM, cTag, '@microsoft.graph.downloadUrl': `${DOWNLOAD}-${renewals}` });
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

test('OneDrive: an answer without a download address is said as Graph\'s, and a renewal asks for the whole item too', async t => {
  const calls = installFetch(t, ({ url }) => {
    if (url.startsWith('https://graph.microsoft.com/')) {
      const { '@microsoft.graph.downloadUrl': _url, ...withoutUrl } = GRAPH_ITEM;
      return graphAnswer(url, withoutUrl);
    }
    return { status: 206 };
  });
  await assert.rejects(createOneDriveProvider({ microsoft: fakeMicrosoft() }).open('drive1/item1'), error => {
    assert.match(error.message, /^Microsoft Graph described atlas\.h5ad without a download address, so Cellucid cannot read it\./);
    assert.doesNotMatch(error.message, /OneDrive lets/);
    return true;
  });
  assert.ok(calls.every(call => !call.url.includes('$select')));
  // A drive item with no file content is said for what it is.
  installFetch(t, () => ({ status: 200, json: { id: 'x', name: 'Notes', package: { type: 'oneNote' }, parentReference: { driveId: 'd' } } }));
  await assert.rejects(createOneDriveProvider({ microsoft: fakeMicrosoft() }).open('drive1/item1'),
    /^DataSourceError: Notes is not a file on OneDrive \(it is a oneNote with no file content\)|Notes is not a file on OneDrive \(it is a oneNote with no file content\)/);
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
    return url.startsWith('https://graph.microsoft.com/') ? graphAnswer(url, GRAPH_ITEM) : { status: 206 };
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
