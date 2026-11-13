import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { expect, test } from './helpers/test.mjs';
import { APP_ORIGIN, ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

/**
 * The collapsed panels, but not the Session panel's sections: an opening that
 * waits for a sign-in leaves Cellucid starting, and its section headers do
 * not open until it is ready. Nothing here uses them.
 */
const openPanels = page => openCollapsedPanels(page, { sessionSections: false });

// Google Drive and OneDrive against fake hosts (Figshare is held by the
// provider contract tests): Google's Drive API, Identity Services and Picker (small stubs in
// place of Google's scripts), and Microsoft's sign-in page, token endpoint,
// Graph and download host. Each answers as the real one does (CORS headers
// included), from the same fixture file. The site's provider configuration
// is replaced by test values, which name this page's origin.

const FIXTURE = fileURLToPath(new URL('./fixtures/current-ui-smoke.h5ad', import.meta.url));
const PINNED = `sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&`;
const DRIVE_ID = '1AbCdEfGhIjKlMnOpQrStUv';
const TOKEN = 'ya29.TOKEN-MARKER';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,range,prefer', 'Access-Control-Expose-Headers': 'Content-Range' };

const CONFIG = `export const PROVIDER_CONFIG = Object.freeze({
  google: Object.freeze({ clientId: 'test.apps.googleusercontent.com', apiKey: 'test-key', projectNumber: '42', registeredOrigins: Object.freeze([${JSON.stringify(APP_ORIGIN)}]) }),
  microsoft: Object.freeze({ clientId: 'test-microsoft-client', authority: 'common' }),
});`;

// Google Identity Services: the token client answers the click with a token.
const GIS = `window.google = window.google || {};
window.google.accounts = { oauth2: {
  initTokenClient(options) {
    const client = { callback: options.callback, requestAccessToken() {
      setTimeout(() => client.callback({ access_token: ${JSON.stringify(TOKEN)}, expires_in: 3599, scope: 'https://www.googleapis.com/auth/drive.file' }), 0);
    } };
    return client;
  },
  revoke(token, done) { done(); },
} };`;

// The Picker: shows nothing, and "selects" the one file it was set to.
const GAPI = `window.gapi = { load(name, options) {
  let fileIds = null;
  window.google.picker = {
    Response: { ACTION: 'action', DOCUMENTS: 'docs' }, Action: { PICKED: 'picked', CANCEL: 'cancel' },
    Document: { ID: 'id' }, ViewId: { DOCS: 'all' }, DocsViewMode: { LIST: 'list' },
    DocsView: class { setFileIds(ids) { fileIds = ids; return this; } setMode() { return this; } },
    PickerBuilder: class {
      addView() { return this; } setOAuthToken() { return this; } setDeveloperKey() { return this; }
      setAppId() { return this; } setTitle() { return this; }
      setCallback(callback) { this.callback = callback; return this; }
      build() { const callback = this.callback; return { setVisible() {
        fetch('https://picker.fake.test/picked?id=' + encodeURIComponent(fileIds), { mode: 'no-cors' })
          .finally(() => callback({ action: 'picked', docs: [{ id: fileIds }] }));
      } }; }
    },
  };
  options.callback();
} };`;

async function fixtureBytes() {
  return new Uint8Array(await readFile(FIXTURE));
}

/** Answer a ranged GET of the fixture, as a host that serves ranges does. */
function serveRange(route, bytes, extraHeaders = {}) {
  const range = route.request().headers().range ?? '';
  const match = /bytes=(\d+)-(\d+)/.exec(range);
  if (match === null) return route.fulfill({ status: 200, headers: { ...CORS, ...extraHeaders }, body: Buffer.from(bytes) });
  const start = Number(match[1]);
  const end = Math.min(Number(match[2]), bytes.length - 1);
  return route.fulfill({
    status: 206,
    headers: { ...CORS, ...extraHeaders, 'Content-Range': `bytes ${start}-${end}/${bytes.length}` },
    body: Buffer.from(bytes.subarray(start, end + 1)),
  });
}

async function useTestConfig(context) {
  // The page asks for it at the URL naming its bytes (index.html,
  // CELLUCID_MODULE_VERSIONS), a module worker at its plain path.
  await context.route('**/assets/js/data/sources/provider-config.js{,?v=*}', route => route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
    body: CONFIG,
  }));
}

function watchErrors(page, { expected404 = false } = {}) {
  const errors = [];
  page.on('console', message => {
    // A private file answers the public attempt with 404, as Drive does.
    const expected = expected404 && /status of 404/.test(message.text());
    if (message.type() === 'error' && !expected) errors.push(message.text());
    if (message.text().includes(TOKEN)) errors.push(`token in console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(error.message));
  return errors;
}


/** How many lines the sign-in line's words take. */
function statusLines(page) {
  return page.locator('#data-sign-in-text').evaluate(element => (
    Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight))
  ));
}

/**
 * Drive's API: the item and the bytes, public (key) or for a token once the
 * picker granted it. `heldBack`: the key's downloads fail as Google's answer
 * to a network it holds back does (an HTML 403 without CORS headers).
 */
async function routeDrive(context, bytes, { isPublic, heldBack = false }) {
  const state = { picked: false, requests: [] };
  await context.route('https://picker.fake.test/**', route => {
    state.picked = true;
    return route.fulfill({ status: 204, headers: CORS });
  });
  await context.route('https://accounts.google.com/gsi/client', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: GIS }));
  // Sign out takes the token back: answered here, as every host a spec reads from.
  await context.route('https://oauth2.googleapis.com/revoke', route => route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
  await context.route('https://apis.google.com/js/api.js', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: GAPI }));
  await context.route(`https://www.googleapis.com/drive/v3/files/${DRIVE_ID}?**`, route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: CORS });
    const url = new URL(request.url());
    const headers = request.headers();
    state.requests.push({ url: request.url(), authorization: headers.authorization ?? null });
    const keyed = url.searchParams.get('key') === 'test-key';
    if (keyed && heldBack && url.searchParams.get('alt') === 'media') {
      // The browser lets the page read nothing of it: the request fails.
      return route.abort('failed');
    }
    const allowed = keyed ? isPublic : headers.authorization === `Bearer ${TOKEN}` && state.picked;
    if (!allowed) {
      return route.fulfill({ status: 404, headers: CORS, contentType: 'application/json', body: JSON.stringify({ error: { code: 404, errors: [{ reason: 'notFound' }] } }) });
    }
    if (url.searchParams.get('alt') === 'media') return serveRange(route, bytes);
    return route.fulfill({
      status: 200,
      headers: CORS,
      contentType: 'application/json',
      body: JSON.stringify({ id: DRIVE_ID, name: 'atlas.h5ad', size: String(bytes.length), md5Checksum: 'abc', mimeType: 'application/octet-stream', capabilities: { canDownload: true } }),
    });
  });
  return state;
}

test('a public Google Drive file opens with the key, no sign-in and no header but Range', async ({ page }) => {
  const bytes = await fixtureBytes();
  await useTestConfig(page.context());
  const drive = await routeDrive(page.context(), bytes, { isPublic: true });
  const errors = watchErrors(page);
  await page.goto(`/?${PINNED}data=${encodeURIComponent(`https://drive.google.com/file/d/${DRIVE_ID}/view?usp=sharing`)}`, { waitUntil: 'domcontentloaded' });
  await openPanels(page);
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  await expect(page.locator('#data-link-connection-target')).toHaveAttribute('title', `gdrive:${DRIVE_ID}`);
  // The address names the file in Drive's form, not the sharing link pasted.
  expect(new URL(page.url()).searchParams.get('data')).toBe(`gdrive:${DRIVE_ID}`);
  expect(drive.requests.every(request => request.authorization === null && request.url.includes('key=test-key'))).toBe(true);
  // Google's scripts are never loaded for a public file.
  expect(await page.evaluate(() => typeof window.google)).toBe('undefined');
  await expect(page.locator('#data-sign-in-step')).toBeHidden();
  expect(errors).toEqual([]);
});

test('a private Google Drive file: Sign in to Google, the picker on that file, then it opens; a reload keeps the sign-in', async ({ page }) => {
  const bytes = await fixtureBytes();
  await useTestConfig(page.context());
  const drive = await routeDrive(page.context(), bytes, { isPublic: false });
  const errors = watchErrors(page, { expected404: true });
  await page.goto(`/?${PINNED}data=gdrive:${DRIVE_ID}`, { waitUntil: 'domcontentloaded' });
  await openPanels(page);
  const step = page.locator('#data-sign-in-step');
  await expect(step).toBeVisible();
  await expect(page.locator('#data-sign-in-text')).toHaveText('Private file on Google Drive.');
  await expect(page.locator('#data-sign-in-btn')).toHaveText('Sign in to Google');
  await expect(page.locator('#data-sign-in-btn')).toBeEnabled();
  // One status line (beside its button it does not wrap into a column of two to four lines).
  expect(await statusLines(page)).toBe(1);
  // The same step as a notification, for a closed panel.
  await expect(page.locator('#notification-center .notification-action', { hasText: 'Sign in to Google' })).toHaveCount(1);
  await page.locator('#data-sign-in-btn').click();
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  // No step waits any more: the line says who is signed in, with Sign out.
  await expect(page.locator('#data-sign-in-text')).toHaveText('Signed in to Google');
  await expect(page.locator('#data-sign-in-btn')).toHaveText('Sign out');
  expect(drive.picked).toBe(true);
  // Signed requests go to googleapis.com only, without the key.
  const signed = drive.requests.filter(request => request.authorization !== null);
  expect(signed.length).toBeGreaterThan(0);
  expect(signed.every(request => !request.url.includes('key='))).toBe(true);
  // The token is the tab's: in sessionStorage, never in the address or localStorage.
  expect(page.url()).not.toContain(TOKEN);
  await expect(page.locator('#data-link-connection-target')).toHaveAttribute('title', `gdrive:${DRIVE_ID}`);
  const storage = await page.evaluate(() => ({
    session: Object.keys(sessionStorage),
    local: JSON.stringify({ ...localStorage }),
  }));
  expect(storage.session).toContain('cellucid:google-auth:session');
  expect(storage.local).not.toContain(TOKEN);

  // A reload of the tab opens it again with no step: signed in, and granted.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openPanels(page);
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  await expect(page.locator('#data-sign-in-text')).toHaveText('Signed in to Google');
  expect(errors).toEqual([]);
  // Sign out forgets it: the line goes.
  await page.locator('#data-sign-in-btn').click();
  await expect(step).toBeHidden();
  expect(await page.evaluate(() => Object.keys(sessionStorage))).not.toContain('cellucid:google-auth:session');
  expect(errors).toEqual([]);
});

test('a public Google Drive file whose download Google holds back opens after Sign in to Google and the picker', async ({ page }) => {
  const bytes = await fixtureBytes();
  await useTestConfig(page.context());
  const drive = await routeDrive(page.context(), bytes, { isPublic: true, heldBack: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.text().includes(TOKEN)) errors.push(`token in console: ${message.text()}`);
  });
  await page.goto(`/?${PINNED}data=gdrive:${DRIVE_ID}`, { waitUntil: 'domcontentloaded' });
  await openPanels(page);
  await expect(page.locator('#data-sign-in-text')).toHaveText('Google Drive sends this file only with a Google sign-in for now.');
  await expect(page.locator('#data-sign-in-btn')).toHaveText('Sign in to Google');
  await page.locator('#data-sign-in-btn').click();
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  expect(drive.picked).toBe(true);
  // The bytes came with the sign-in; the key's head was asked once, then confirmed with one byte.
  const keyedMedia = drive.requests.filter(request => request.authorization === null && request.url.includes('alt=media'));
  expect(keyedMedia).toHaveLength(2);
  expect(drive.requests.filter(request => request.authorization !== null && request.url.includes('alt=media')).length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('a sign-in that takes longer than the startup deadline: the opening waits for it, and signing in opens the file', async ({ page }) => {
  // The person's time in Google's sign-in window is not a request's
  // silence: the opening neither fails ("nothing arrived for 60 s") nor needs
  // a reload once the sign-in is done.
  const bytes = await fixtureBytes();
  await useTestConfig(page.context());
  const drive = await routeDrive(page.context(), bytes, { isPublic: true, heldBack: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  await page.goto(`/?${PINNED}data=gdrive:${DRIVE_ID}`, { waitUntil: 'domcontentloaded' });
  await openPanels(page);
  await expect(page.locator('#data-sign-in-btn')).toHaveText('Sign in to Google');
  // Three startup deadlines pass while the person reads the step.
  await page.clock.fastForward('03:00');
  await expect(page.locator('#data-sign-in-btn')).toHaveText('Sign in to Google');
  await expect(page.locator('#cellucid-startup-failure')).toHaveCount(0);
  await expect(page.locator('.notification-error')).toHaveCount(0);
  await page.locator('#data-sign-in-btn').click();
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  expect(drive.picked).toBe(true);
  expect(errors).toEqual([]);
});

/**
 * Microsoft's sign-in page, token endpoint, Graph and download host for one
 * OneDrive file. The sign-in page sends its window back with a code after
 * `returnAfterMs`, from a page that sets `headers` (a Cross-Origin-Opener-
 * Policy that cuts the window off from Cellucid).
 */
async function routeOneDrive(context, bytes, { returnAfterMs = 0, headers = {} } = {}) {
  const seen = { tokenBodies: [], downloads: [], graph: [], authorize: [] };
  await context.route('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?**', route => {
    const url = new URL(route.request().url());
    seen.authorize.push(url);
    const back = `${url.searchParams.get('redirect_uri')}#code=CODE-1&state=${encodeURIComponent(url.searchParams.get('state'))}`;
    return route.fulfill({
      status: 200,
      headers,
      contentType: 'text/html',
      body: `<!doctype html><script>setTimeout(() => location.replace(${JSON.stringify(back)}), ${returnAfterMs});</script>`,
    });
  });
  await context.route('https://login.microsoftonline.com/common/oauth2/v2.0/token', route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: CORS });
    seen.tokenBodies.push(Object.fromEntries(new URLSearchParams(route.request().postData() ?? '')));
    return route.fulfill({
      status: 200,
      headers: CORS,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: TOKEN, refresh_token: 'REFRESH-MARKER', expires_in: 3600, scope: 'Files.Read openid' }),
    });
  });
  await context.route('https://graph.microsoft.com/v1.0/**', route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: CORS });
    seen.graph.push({ url: route.request().url(), headers: route.request().headers() });
    const item = {
      id: 'ITEM!101', name: 'atlas.h5ad', size: bytes.length, file: {}, cTag: 'c1',
      parentReference: { driveId: 'drive1' }, webUrl: 'https://onedrive.live.com/?id=x',
      '@microsoft.graph.downloadUrl': 'https://dl.fake.test/download.aspx?tempauth=TEMPAUTH-MARKER',
    };
    // As Graph answers: a $select keeps only the plain fields it names, and
    // drops the download URL even when it names it.
    const select = new URL(route.request().url()).searchParams.get('$select');
    const body = select === null
      ? item
      : Object.fromEntries(Object.entries(item).filter(([key]) => select.split(',').includes(key) && !key.startsWith('@')));
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await context.route('https://dl.fake.test/**', route => {
    seen.downloads.push(route.request().headers());
    return serveRange(route, bytes);
  });
  return seen;
}

/** Record every `window.open` the page makes, and what it asked for. */
async function recordWindowOpens(page) {
  await page.addInitScript(() => {
    const open = window.open.bind(window);
    window.__cellucidOpens = [];
    window.open = (...args) => {
      window.__cellucidOpens.push({ url: String(args[0] ?? ''), name: args[1] ?? '' });
      return open(...args);
    };
  });
  return () => page.evaluate(() => window.__cellucidOpens);
}

test('a OneDrive share link: Sign in with Microsoft (PKCE popup), then read from its download URL by drive and item', async ({ page }) => {
  const bytes = await fixtureBytes();
  const context = page.context();
  await useTestConfig(context);
  // Microsoft's sign-in page sends the popup back with a code at once.
  const seen = await routeOneDrive(context, bytes);
  const opens = await recordWindowOpens(page);
  const errors = watchErrors(page);
  const share = 'https://1drv.ms/u/c/12a1b84edebf20f7/EVjJu5abc';
  await page.goto(`/?${PINNED}data=${encodeURIComponent(share)}`, { waitUntil: 'domcontentloaded' });
  await openPanels(page);
  await expect(page.locator('#data-sign-in-text')).toHaveText('OneDrive files open after a sign-in.');
  expect(await statusLines(page)).toBe(1);
  await expect(page.locator('#data-sign-in-btn')).toBeEnabled();
  // The opening asks for the click; it opens nothing by itself.
  expect(await opens()).toEqual([]);
  const popup = page.waitForEvent('popup');
  await page.locator('#data-sign-in-btn').click();
  const signInWindow = await popup;
  // The sign-in window opens on this site inside the click, never before it,
  // then goes to Microsoft. Opened at no address of Microsoft's: Safari gives
  // a window opened at login.microsoftonline.com to a Mac's single sign-on
  // extension (Company Portal), which signs in where nobody sees and closes
  // the window.
  expect(await opens()).toEqual([{ url: '', name: 'cellucid-microsoft-sign-in' }]);
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  expect(seen.authorize).toHaveLength(1);
  // The return page closed once this page answered that it had the code.
  await expect.poll(() => signInWindow.isClosed()).toBe(true);
  // The code was redeemed in the page, with the verifier and no secret.
  expect(seen.tokenBodies).toHaveLength(1);
  expect(seen.tokenBodies[0].grant_type).toBe('authorization_code');
  expect(seen.tokenBodies[0].code).toBe('CODE-1');
  expect(seen.tokenBodies[0].code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect('client_secret' in seen.tokenBodies[0]).toBe(false);
  expect(seen.graph[0].headers.prefer).toBe('redeemSharingLink');
  expect(seen.graph[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  // The download host gets no token.
  expect(seen.downloads.every(headers => headers.authorization === undefined)).toBe(true);
  // Named from now on by drive and item (sessions, Share), never by the
  // share link or a token.
  await expect(page.locator('#data-link-connection-target')).toHaveAttribute('title', 'onedrive:drive1/ITEM!101');
  expect(new URL(page.url()).searchParams.get('data')).toBe('onedrive:drive1/ITEM!101');
  expect(page.url()).not.toContain('TEMPAUTH');
  expect(page.url()).not.toContain(TOKEN);
  expect(errors).toEqual([]);
});

test('a Microsoft sign-in window cut off from Cellucid (Cross-Origin-Opener-Policy) still signs in when it returns', async ({ page, browserName }) => {
  const bytes = await fixtureBytes();
  const context = page.context();
  await useTestConfig(context);
  // The sign-in page cuts its window off from the opener, and the person
  // takes a while: the opener may find the window "closed" meanwhile.
  const seen = await routeOneDrive(context, bytes, { returnAfterMs: 2500, headers: { 'Cross-Origin-Opener-Policy': 'same-origin' } });
  // Every line the sign-in step shows, in order.
  await page.addInitScript(() => {
    window.__cellucidSignInLines = [];
    document.addEventListener('DOMContentLoaded', () => {
      const text = document.getElementById('data-sign-in-text');
      new MutationObserver(() => window.__cellucidSignInLines.push(text.textContent))
        .observe(text, { childList: true, characterData: true, subtree: true });
    });
  });
  const errors = watchErrors(page);
  await page.goto(`/?${PINNED}data=${encodeURIComponent('https://1drv.ms/u/c/12a1b84edebf20f7/EVjJu5abc')}`, { waitUntil: 'domcontentloaded' });
  await openPanels(page);
  await expect(page.locator('#data-sign-in-btn')).toBeEnabled();
  const popup = page.waitForEvent('popup');
  await page.locator('#data-sign-in-btn').click();
  await popup;
  await expect.poll(() => seen.authorize.length).toBe(1);
  // The window's return page reaches this page all the same.
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  const lines = await page.evaluate(() => window.__cellucidSignInLines);
  const closed = 'OneDrive files open after a sign-in. Microsoft\'s sign-in window was closed before it finished.';
  // Chromium and Firefox report a window cut off this way as closed
  // (WebKit does not): the step says so and offers the
  // button again, and the sign-in finished in that window still counts.
  if (browserName !== 'webkit') expect(lines).toContain(closed);
  expect(lines.at(-1)).toBe('Signed in to Microsoft');
  expect(seen.tokenBodies).toHaveLength(1);
  expect(seen.tokenBodies[0].code).toBe('CODE-1');
  await expect(page.locator('#data-sign-in-step')).toBeVisible();
  await expect(page.locator('#data-sign-in-text')).toHaveText('Signed in to Microsoft');
  expect(errors).toEqual([]);
});

test('a Microsoft sign-in window closed without signing in ends the attempt, and the button offers it again', async ({ page }) => {
  const context = page.context();
  await useTestConfig(context);
  // The person closes Microsoft's window: it never returns to the callback.
  // Its sign-in page is refused, so the window never shows an http(s) page:
  // macOS WebKit can end its browser process when a window is closed moments
  // after it showed one (its Screen Time observer, `helpers/downloads.mjs`).
  // What this page does is the same either way: it only watches the window close.
  await context.route('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?**', route => route.abort());
  const errors = watchErrors(page);
  await page.goto(`/?${PINNED}data=${encodeURIComponent('https://1drv.ms/u/c/12a1b84edebf20f7/EVjJu5abc')}`, { waitUntil: 'domcontentloaded' });
  await openPanels(page);
  await expect(page.locator('#data-sign-in-btn')).toBeEnabled();
  const opened = page.waitForEvent('popup');
  await page.locator('#data-sign-in-btn').click();
  const popup = await opened;
  await expect(page.locator('#data-sign-in-text')).toContainText('Finish signing in in the window that opened.');
  await popup.close();
  await expect(page.locator('#data-sign-in-text')).toHaveText(
    'OneDrive files open after a sign-in. Microsoft\'s sign-in window was closed before it finished.'
  );
  await expect(page.locator('#data-sign-in-btn')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('a work account whose organization lets only an administrator approve Cellucid: the step says so, links the steps, offers another account', async ({ page }) => {
  const context = page.context();
  await useTestConfig(context);
  const prompts = [];
  // Microsoft answers as a tenant does that lets only an administrator approve an app.
  await context.route('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?**', route => {
    const url = new URL(route.request().url());
    prompts.push(url.searchParams.get('prompt'));
    const description = 'AADSTS90094: An administrator of Helmholtz Zentrum München has set a policy that prevents you from granting Cellucid the permissions it is requesting.';
    const back = `${url.searchParams.get('redirect_uri')}#error=access_denied&error_description=${encodeURIComponent(description)}&state=${encodeURIComponent(url.searchParams.get('state'))}`;
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><script>location.replace(${JSON.stringify(back)});</script>` });
  });
  const errors = watchErrors(page);
  await page.goto(`/?${PINNED}data=${encodeURIComponent('https://hmgu-my.sharepoint.com/:u:/g/personal/x/EVjJu5abc')}`, { waitUntil: 'domcontentloaded' });
  await openPanels(page);
  await expect(page.locator('#data-sign-in-btn')).toBeEnabled();
  const first = page.waitForEvent('popup');
  await page.locator('#data-sign-in-btn').click();
  // The return page closes once this page answered that it had Microsoft's answer.
  const firstWindow = await first;
  await expect.poll(() => firstWindow.isClosed()).toBe(true);
  await expect(page.locator('#data-sign-in-text')).toContainText(
    'Your organization (Helmholtz Zentrum München) lets only an administrator approve Cellucid.'
  );
  await expect(page.locator('#data-sign-in-btn')).toHaveText('Use another account');
  const help = page.locator('#data-sign-in-help');
  await expect(help).toBeVisible();
  await expect(help).toHaveText('How an administrator approves Cellucid');
  await expect(help).toHaveAttribute('href', /16_private_drive_onedrive\.html#work-and-school-accounts-administrator-approval$/);
  // Beside a help link and "Use another account" the reason is not squeezed to a
  // column one letter wide; it takes the line's first row whole.
  const widths = await page.evaluate(() => ({
    line: document.getElementById('data-sign-in-step').getBoundingClientRect().width,
    text: document.getElementById('data-sign-in-text').getBoundingClientRect().width,
  }));
  expect(widths.text).toBeGreaterThan(widths.line * 0.9);
  // The opening waits for the person: no stall, no failure.
  await expect(page.locator('#cellucid-startup-failure')).toHaveCount(0);
  // Another account: Microsoft's account chooser.
  const second = page.waitForEvent('popup');
  await page.locator('#data-sign-in-btn').click();
  const secondWindow = await second;
  await expect.poll(() => secondWindow.isClosed()).toBe(true);
  await expect.poll(() => prompts.length).toBe(2);
  expect(prompts).toEqual([null, 'select_account']);
  expect(errors).toEqual([]);
});
