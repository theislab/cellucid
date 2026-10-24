/**
 * The sign-ins of Google Drive and OneDrive, and the token rules every
 * sign-in of the app keeps (GitHub's too):
 *
 * - a token lives in the tab's `sessionStorage`, through one module
 *   (`data/sources/auth/token-store.js`), and nowhere else: no other module
 *   touches a storage API, and none logs;
 * - Google's token model and Microsoft's PKCE flow, against fake Google
 *   Identity Services, Picker, Microsoft authorize page and token endpoint:
 *   no client secret, the verifier kept in memory, `state` checked, the code
 *   carried by the callback page only;
 * - the sign-in steps: one per account, its action run inside the click,
 *   waiting reads resumed, a failed attempt offered again.
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  TokenStoreError,
  readSignIn,
  readSignInRecord,
  removeSignIn,
  signInStorageKey,
  writeSignIn,
} from '../assets/js/data/sources/auth/token-store.js';
import { codeChallengeOf, createPkce } from '../assets/js/data/sources/auth/pkce.js';
import { SignInSteps } from '../assets/js/data/sources/auth/sign-in.js';
import { DRIVE_FILE_SCOPE, createGoogleAuth } from '../assets/js/data/sources/auth/google.js';
import {
  CALLBACK_PATH,
  FILES_READ_ALL,
  SIGN_IN_CHANNEL,
  createMicrosoftAuth,
  grantsScope,
} from '../assets/js/data/sources/auth/microsoft.js';
import { callbackMessage } from '../assets/js/data/sources/auth/callback-page.js';
import { embeddedInOtherSite, embeddingOrigin } from '../assets/js/data/sources/auth/page-context.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'TOKEN-MARKER-91c2';

function installSessionStorage(t) {
  const values = new Map();
  const storage = {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { value: storage, configurable: true, writable: true });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete globalThis.sessionStorage;
  });
  return values;
}

function jsFiles(dir) {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(relative);
    return entry.name.endsWith('.js') ? [relative] : [];
  });
}

test('only the token store touches storage; no sign-in module logs or writes elsewhere', async () => {
  const files = [
    ...jsFiles('assets/js/data/sources/auth'),
    'assets/js/data/sources/access.js',
    'assets/js/data/sources/provider-config.js',
    'assets/js/data/sources/api-request.js',
    'assets/js/data/sources/providers/gdrive.js',
    'assets/js/data/sources/providers/onedrive.js',
    'assets/js/data/sources/providers/figshare.js',
    'assets/js/app/source-sign-in-view.js',
    'assets/js/app/community-annotations/github-auth.js',
  ];
  for (const file of files) {
    const source = await readFile(path.join(ROOT, file), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\blocalStorage\b|\bindexedDB\b|document\.cookie|caches\.open/, file);
    if (file !== 'assets/js/data/sources/auth/token-store.js') {
      assert.doesNotMatch(code, /\bsessionStorage\b/, `${file} stores through token-store.js only`);
    }
    if (file !== 'assets/js/data/sources/auth/sign-in.js' && !file.endsWith('github-auth.js')) {
      assert.doesNotMatch(code, /\bconsole\./, `${file} logs nothing`);
    }
    // No secret is ever configured or sent.
    assert.doesNotMatch(code, /client_secret|clientSecret/, file);
  }
});

test('one store holds every sign-in for the tab: GitHub keeps its key, Google and Microsoft have theirs', async t => {
  const values = installSessionStorage(t);
  assert.equal(signInStorageKey('github-app'), 'cellucid:github-app-auth:session');
  assert.equal(signInStorageKey('google'), 'cellucid:google-auth:session');
  assert.equal(signInStorageKey('microsoft'), 'cellucid:microsoft-auth:session');
  writeSignIn('google', '{"x":1}');
  assert.equal(readSignIn('google'), '{"x":1}');
  removeSignIn('google');
  assert.equal(values.size, 0);
  // A record that is not what its reader accepts is forgotten.
  writeSignIn('google', '{"accessToken": 1}');
  assert.equal(readSignInRecord('google', record => typeof record.accessToken === 'string'), null);
  assert.equal(values.size, 0);
  const github = await readFile(path.join(ROOT, 'assets/js/app/community-annotations/github-auth.js'), 'utf8');
  assert.match(github, /from '\.\.\/\.\.\/data\/sources\/auth\/token-store\.js'/);
});

test('a browser that refuses storage is said as a storage failure, never a crash', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() {
      throw new Error('blocked');
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete globalThis.sessionStorage;
  });
  assert.throws(() => readSignIn('google'), TokenStoreError);
  assert.equal(readSignInRecord('google', () => true), null);
});

test('PKCE: the S256 challenge of RFC 7636\'s example, and a fresh verifier per sign-in', async () => {
  assert.equal(await codeChallengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const [a, b] = await Promise.all([createPkce(), createPkce()]);
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.state, b.state);
});

test('the callback page carries the code and state only', () => {
  assert.deepEqual(callbackMessage('#code=abc&state=s1&session_state=x'), { state: 's1', code: 'abc' });
  assert.deepEqual(
    callbackMessage('#error=access_denied&error_description=AADSTS65004&state=s2'),
    { state: 's2', error: 'access_denied', errorDescription: 'AADSTS65004' }
  );
  assert.equal(callbackMessage('#nothing=1'), null);
});

test('sign-in steps: one per account and kind, run inside the click, a failed attempt offered again', async () => {
  const steps = new SignInSteps();
  const seen = [];
  steps.subscribe(list => seen.push(list));
  let attempts = 0;
  let finish;
  const act = () => {
    attempts += 1;
    if (attempts === 1) return Promise.reject(new Error('The window was closed.'));
    return new Promise(resolve => {
      finish = resolve;
    });
  };
  const first = steps.request({ account: 'google', kind: 'expired', text: 'Google sign-in expired.', action: 'Sign in again', act });
  const second = steps.request({ account: 'google', kind: 'expired', text: 'Google sign-in expired.', action: 'Sign in again', act });
  assert.equal(steps.list().length, 1, 'parallel reads share one step');
  const [step] = steps.list();
  steps.run(step.id);
  assert.equal(attempts, 1, 'the action runs inside the click, before any await');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(steps.list()[0].problem, 'The window was closed.');
  steps.run(step.id);
  finish(TOKEN);
  assert.deepEqual(await Promise.all([first, second]), [TOKEN, TOKEN]);
  assert.equal(steps.list().length, 0);
  for (const list of seen) assert.ok(!JSON.stringify(list).includes(TOKEN), 'a step never carries its token');
});

test('sign-in steps: a step nobody waits for goes; a final failure ends it; a step waits for its script', async () => {
  const steps = new SignInSteps();
  const controller = new AbortController();
  const waiting = steps.request({ account: 'microsoft', kind: 'sign-in', text: 't', action: 'a', act: async () => 1, signal: controller.signal });
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(waiting, /cancelled/);
  assert.equal(steps.list().length, 0);
  const finalError = Object.assign(new Error('Your organisation must approve Cellucid.'), { final: true });
  const ended = steps.request({ account: 'microsoft', kind: 'more-access', text: 't', action: 'a', act: () => Promise.reject(finalError) });
  steps.run(steps.list()[0].id);
  await assert.rejects(ended, /must approve/);
  let load;
  const ready = new Promise(resolve => {
    load = resolve;
  });
  let ran = 0;
  steps.request({ account: 'google', kind: 'sign-in', text: 't', action: 'a', ready, act: async () => ran++ });
  steps.run(steps.list()[0].id);
  assert.equal(ran, 0, 'the button does nothing until the script has loaded');
  load();
  await ready;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(steps.list()[0].ready, true);
});

/** Fake Google Identity Services and Picker. */
/**
 * A page at `origin`, in its own tab, or embedded in a page at `top`: its
 * address unreadable when it is another origin, named by `ancestorOrigins`
 * (Chromium, WebKit) or only by the referrer (Firefox).
 */
function placePage(win, { origin, top = null, named = 'ancestors' }) {
  win.location = { origin };
  win.self = win;
  if (top === null) {
    win.top = win;
    return win;
  }
  win.top = top === origin
    ? { location: { origin } }
    : { location: { get origin() { throw new DOMException('Blocked a frame', 'SecurityError'); } } };
  if (named === 'ancestors') win.location.ancestorOrigins = [top];
  win.document = { ...(win.document ?? {}), referrer: named === 'referrer' ? `${top}/lab/tree/analysis.ipynb` : '' };
  return win;
}

function fakeGoogleWindow({ origin = 'https://www.cellucid.com', top = null, response = null, error = null } = {}) {
  const log = { requested: 0, revoked: [], fileIds: null, visible: false, built: null };
  const picker = {
    Response: { ACTION: 'action', DOCUMENTS: 'docs' },
    Action: { PICKED: 'picked', CANCEL: 'cancel' },
    Document: { ID: 'id' },
    ViewId: { DOCS: 'all' },
    DocsViewMode: { LIST: 'list' },
    DocsView: class {
      setFileIds(ids) {
        log.fileIds = ids;
        return this;
      }

      setMode() {
        return this;
      }
    },
    PickerBuilder: class {
      constructor() {
        this.options = {};
      }

      addView() { return this; }

      setOAuthToken(token) { this.options.token = token; return this; }

      setDeveloperKey(key) { this.options.key = key; return this; }

      setAppId(id) { this.options.appId = id; return this; }

      setTitle() { return this; }

      setCallback(callback) { this.callback = callback; return this; }

      build() {
        log.built = this.options;
        const callback = this.callback;
        return {
          setVisible(visible) {
            log.visible = visible;
            if (visible) queueMicrotask(() => callback({ action: 'picked', docs: [{ id: log.fileIds }] }));
          },
        };
      }
    },
  };
  const win = {
    location: { origin },
    google: {
      picker,
      accounts: {
        oauth2: {
          initTokenClient: options => {
            log.clientOptions = options;
            return {
              requestAccessToken: () => {
                log.requested += 1;
                const client = log.client;
                queueMicrotask(() => (error ? client.error_callback(error) : client.callback(response)));
              },
            };
          },
          revoke: (token, done) => {
            log.revoked.push(token);
            done();
          },
        },
      },
    },
    gapi: { load: (name, { callback }) => callback() },
  };
  placePage(win, { origin, top });
  // The client the module configures is the object `initTokenClient` returned.
  const init = win.google.accounts.oauth2.initTokenClient;
  win.google.accounts.oauth2.initTokenClient = options => {
    log.client = init(options);
    return log.client;
  };
  return { win, log };
}

const GOOGLE_CONFIG = Object.freeze({
  clientId: 'client.apps.googleusercontent.com',
  apiKey: 'AIza-key',
  projectNumber: '123456',
  registeredOrigins: Object.freeze(['https://www.cellucid.com', 'http://127.0.0.1:8765', 'http://localhost:8765']),
});

test('Google: not configured, or on an origin Google does not know, says so before any read or popup', () => {
  const steps = new SignInSteps();
  const empty = createGoogleAuth({ config: { ...GOOGLE_CONFIG, clientId: '', apiKey: '' }, steps, win: fakeGoogleWindow().win });
  assert.equal(empty.whyNoPublicAccess(), 'Google Drive is not configured on this site yet.');
  assert.equal(empty.whyNoSignIn(), 'Signing in to Google is not configured on this site yet.');
  const at = (origin, top = null) => createGoogleAuth({ config: GOOGLE_CONFIG, steps, win: fakeGoogleWindow({ origin, top }).win });
  // The registered origins: a public file and a sign-in both work, in a tab
  // or in a notebook on port 8765.
  for (const google of [at('https://www.cellucid.com'), at('http://localhost:8765'), at('http://127.0.0.1:8765', 'http://localhost:8888')]) {
    assert.equal(google.whyNoPublicAccess(), null);
    assert.equal(google.whyNoSignIn(), null);
  }
  // The API key's website restriction is the same list: a public file is
  // refused, with what to do, wherever a sign-in is.
  const refusals = new Map([
    [at('http://127.0.0.1:9000'),
      'Google Drive works on a local cellucid serve only on its default port, 8765 (this page is http://127.0.0.1:9000). ' +
      'Start it without --port, or open www.cellucid.com.'],
    [at('http://127.0.0.1:53124', 'http://localhost:8888'),
      'Google Drive works in a notebook viewer only on port 8765 (this one is http://127.0.0.1:53124). ' +
      'Create it with AnnDataViewer(data, port=8765), or open www.cellucid.com.'],
    [at('http://192.168.1.20:8765'), 'Google Drive works on www.cellucid.com, not on http://192.168.1.20:8765.'],
    [at('https://hub.example.org', 'https://hub.example.org'), 'Google Drive works on www.cellucid.com, not on https://hub.example.org.'],
  ]);
  for (const [google, text] of refusals) {
    assert.equal(google.whyNoPublicAccess(), text);
    assert.equal(google.whyNoSignIn(), text);
  }
});

test('the page context: where an embedded page sits, and when another site holds it', () => {
  const page = options => placePage({}, options);
  assert.equal(embeddingOrigin(page({ origin: 'https://www.cellucid.com' })), null);
  assert.equal(embeddedInOtherSite(page({ origin: 'https://www.cellucid.com' })), false);
  // JupyterLab at localhost embeds a viewer at 127.0.0.1: another site, by
  // ancestorOrigins or, in Firefox, by the referrer.
  for (const named of ['ancestors', 'referrer']) {
    const viewer = page({ origin: 'http://127.0.0.1:53124', top: 'http://localhost:8888', named });
    assert.equal(embeddingOrigin(viewer), 'http://localhost:8888');
    assert.equal(embeddedInOtherSite(viewer), true);
  }
  // The same host on another port is the same site; so is the same origin.
  assert.equal(embeddedInOtherSite(page({ origin: 'http://127.0.0.1:53124', top: 'http://127.0.0.1:8888' })), false);
  assert.equal(embeddedInOtherSite(page({ origin: 'https://hub.example.org', top: 'https://hub.example.org' })), false);
  // Another scheme is another site; two domain names cannot be told apart
  // without the public suffix list, nor a parent the browser does not name.
  assert.equal(embeddedInOtherSite(page({ origin: 'https://www.cellucid.com', top: 'http://www.cellucid.com' })), true);
  assert.equal(embeddedInOtherSite(page({ origin: 'https://www.cellucid.com', top: 'https://lab.example.org' })), null);
  assert.equal(embeddedInOtherSite(page({ origin: 'https://www.cellucid.com', top: 'https://lab.example.org', named: 'none' })), null);
});

test('Google: the click asks GIS for drive.file only; the token is kept for the tab and revoked on sign-out', async t => {
  const values = installSessionStorage(t);
  const steps = new SignInSteps();
  const { win, log } = fakeGoogleWindow({ response: { access_token: TOKEN, expires_in: 3599, scope: DRIVE_FILE_SCOPE } });
  let now = 1_000_000;
  const google = createGoogleAuth({ config: GOOGLE_CONFIG, steps, win, now: () => now });
  const authorized = google.authorize({ kind: 'sign-in', text: 'Private file on Google Drive.' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const [step] = steps.list();
  assert.deepEqual({ account: step.account, action: step.action, ready: step.ready }, { account: 'google', action: 'Sign in to Google', ready: true });
  steps.run(step.id);
  assert.equal(log.requested, 1, 'GIS opens its popup inside the click');
  assert.equal(await authorized, TOKEN);
  assert.equal(log.clientOptions.scope, DRIVE_FILE_SCOPE);
  assert.equal(log.clientOptions.client_id, GOOGLE_CONFIG.clientId);
  const stored = JSON.parse(values.get('cellucid:google-auth:session'));
  assert.deepEqual(stored, { accessToken: TOKEN, expiresAt: 1_000_000 + 3_599_000, scope: DRIVE_FILE_SCOPE });
  // A reload of the tab finds it; an expired one is not used.
  const reloaded = createGoogleAuth({ config: GOOGLE_CONFIG, steps, win, now: () => now });
  assert.equal(reloaded.validToken(), TOKEN);
  now += 3_599_000;
  assert.equal(reloaded.validToken(), null);
  // The picker opens on the one file, with the key, project number and token.
  now -= 10;
  assert.equal(await reloaded.pick('FILE-ID-1234'), 'FILE-ID-1234');
  assert.equal(log.fileIds, 'FILE-ID-1234');
  assert.deepEqual(log.built, { token: TOKEN, key: GOOGLE_CONFIG.apiKey, appId: GOOGLE_CONFIG.projectNumber });
  reloaded.signOut();
  assert.deepEqual(log.revoked, [TOKEN]);
  assert.equal(values.has('cellucid:google-auth:session'), false);
});

test('Google: a blocked popup and a refused scope are said, and the step stays to try again', async t => {
  installSessionStorage(t);
  const steps = new SignInSteps();
  const blocked = createGoogleAuth({ config: GOOGLE_CONFIG, steps, win: fakeGoogleWindow({ error: { type: 'popup_failed_to_open' } }).win });
  const waiting = blocked.authorize();
  await new Promise(resolve => setTimeout(resolve, 0));
  steps.run(steps.list()[0].id);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(steps.list()[0].problem, /blocked Google's sign-in window\. Allow pop-ups/);
  steps.dismiss(steps.list()[0].id);
  await assert.rejects(waiting, /dismissed/);
  const narrow = createGoogleAuth({
    config: GOOGLE_CONFIG,
    steps,
    win: fakeGoogleWindow({ response: { access_token: TOKEN, expires_in: 10, scope: 'email' } }).win,
  });
  const narrowed = narrow.authorize();
  await new Promise(resolve => setTimeout(resolve, 0));
  steps.run(steps.list()[0].id);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(steps.list()[0].problem, /did not grant access to the files you choose/);
  steps.dismiss(steps.list()[0].id);
  await assert.rejects(narrowed, /dismissed/);
  // Google's window closed without a token: the attempt ends, the step stays.
  const closed = createGoogleAuth({ config: GOOGLE_CONFIG, steps, win: fakeGoogleWindow({ error: { type: 'popup_closed' } }).win });
  closed.authorize().catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 0));
  steps.run(steps.list()[0].id);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(steps.list()[0].problem, 'Google\'s sign-in window was closed before it finished.');
  assert.equal(steps.list()[0].working, false);
});

/** A fake Microsoft: the popup, the callback's channel and the token endpoint. */
function fakeMicrosoftWindow(t, { tokenAnswers = [], origin = 'https://www.cellucid.com', top = null, secure = true } = {}) {
  const log = { opened: [], posts: [], received: [], popups: [] };
  const channels = new Set();
  class Channel {
    constructor(name) {
      this.name = name;
      channels.add(this);
    }

    postMessage(message) {
      log.received.push(message);
    }

    close() {
      channels.delete(this);
    }
  }
  const win = {
    isSecureContext: secure,
    open: url => {
      log.opened.push(new URL(url));
      const popup = { closed: false };
      log.popups.push(popup);
      return popup;
    },
    BroadcastChannel: Channel,
  };
  placePage(win, { origin, top });
  const deliver = message => {
    for (const channel of [...channels]) {
      if (channel.name === SIGN_IN_CHANNEL) channel.onmessage?.({ data: message });
    }
  };
  const fetchImpl = async (url, init) => {
    log.posts.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)), headers: init.headers });
    const answer = tokenAnswers.shift() ?? { status: 400, json: { error: 'invalid_grant' } };
    return new Response(JSON.stringify(answer.json), { status: answer.status });
  };
  return { win, log, deliver, fetchImpl };
}

test('Microsoft: PKCE in a popup, the code redeemed in the page with the verifier, no secret', async t => {
  const values = installSessionStorage(t);
  const steps = new SignInSteps();
  const fake = fakeMicrosoftWindow(t, {
    tokenAnswers: [{ status: 200, json: { access_token: TOKEN, refresh_token: `R-${TOKEN}`, expires_in: 3600, scope: 'Files.Read openid' } }],
  });
  let now = 5_000_000;
  const microsoft = createMicrosoftAuth({ config: { clientId: 'app-id', authority: 'common' }, steps, win: fake.win, fetchImpl: fake.fetchImpl, now: () => now });
  const authorized = microsoft.authorize({ kind: 'sign-in' });
  await new Promise(resolve => setTimeout(resolve, 10));
  const [step] = steps.list();
  assert.equal(step.ready, true);
  steps.run(step.id);
  const [opened] = fake.log.opened;
  assert.ok(opened, 'the popup opens inside the click');
  assert.equal(opened.origin + opened.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  const query = Object.fromEntries(opened.searchParams);
  assert.equal(query.response_type, 'code');
  assert.equal(query.response_mode, 'fragment');
  assert.equal(query.code_challenge_method, 'S256');
  assert.equal(query.redirect_uri, `https://www.cellucid.com${CALLBACK_PATH}`);
  assert.deepEqual(query.scope.split(' '), ['openid', 'offline_access', 'https://graph.microsoft.com/Files.Read']);
  // A message for another sign-in is ignored; this one's code is redeemed.
  fake.deliver({ state: 'someone-else', code: 'wrong' });
  fake.deliver({ state: query.state, code: 'CODE-1' });
  assert.equal(await authorized, TOKEN);
  // The page answers the window, which closes only then: no closed window
  // taken for a sign-in that did not finish.
  assert.deepEqual(fake.log.received, [{ state: query.state, received: true }]);
  fake.log.popups[0].closed = true;
  const [post] = fake.log.posts;
  assert.equal(post.url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
  assert.equal(post.body.grant_type, 'authorization_code');
  assert.equal(post.body.code, 'CODE-1');
  assert.equal(await codeChallengeOf(post.body.code_verifier), query.code_challenge);
  assert.equal('client_secret' in post.body, false);
  assert.equal(post.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const stored = JSON.parse(values.get('cellucid:microsoft-auth:session'));
  assert.equal(stored.refreshExpiresAt, 5_000_000 + 24 * 3600 * 1000);
  // An hour on, the token renews without a click, once for every caller.
  now += 3_600_000;
  const renewals = [{ status: 200, json: { access_token: `${TOKEN}-2`, refresh_token: 'R2', expires_in: 3600, scope: 'Files.Read' } }];
  fake.fetchImpl = undefined;
  const again = createMicrosoftAuth({
    config: { clientId: 'app-id', authority: 'common' },
    steps,
    win: fake.win,
    now: () => now,
    fetchImpl: async (url, init) => {
      fake.log.posts.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)) });
      const answer = renewals.shift();
      return new Response(JSON.stringify(answer.json), { status: answer.status });
    },
  });
  assert.deepEqual(await Promise.all([again.silentToken(), again.silentToken()]), [`${TOKEN}-2`, `${TOKEN}-2`]);
  assert.equal(fake.log.posts.at(-1).body.grant_type, 'refresh_token');
  assert.equal(fake.log.posts.length, 2);
  // Past the 24 hours of the first sign-in, a click is needed.
  now = 5_000_000 + 24 * 3600 * 1000 + 3_600_001;
  assert.equal(await again.silentToken(), null);
});

test('Microsoft: an organisation that requires an administrator ends the step with that reason', async t => {
  installSessionStorage(t);
  const steps = new SignInSteps();
  const fake = fakeMicrosoftWindow(t);
  const microsoft = createMicrosoftAuth({ config: { clientId: 'app-id', authority: 'common' }, steps, win: fake.win, fetchImpl: fake.fetchImpl });
  const authorized = microsoft.authorize({ kind: 'more-access', more: true });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(steps.list()[0].action, 'Ask for access');
  steps.run(steps.list()[0].id);
  const query = Object.fromEntries(fake.log.opened[0].searchParams);
  assert.ok(query.scope.split(' ').includes(FILES_READ_ALL));
  fake.deliver({ state: query.state, error: 'consent_required', errorDescription: 'AADSTS90094: Admin consent is required.' });
  await assert.rejects(authorized, /Your organisation must approve Cellucid/);
  assert.equal(steps.list().length, 0);
  assert.equal(grantsScope('Files.Read Files.Read.All', FILES_READ_ALL), true);
  assert.equal(grantsScope('Files.Read', FILES_READ_ALL), false);
});

test('Microsoft: not configured says so; a blocked popup is said', async t => {
  installSessionStorage(t);
  const steps = new SignInSteps();
  const fake = fakeMicrosoftWindow(t);
  await assert.rejects(
    createMicrosoftAuth({ config: { clientId: '', authority: 'common' }, steps, win: fake.win }).authorize(),
    /Signing in to Microsoft is not configured on this site yet/
  );
  fake.win.open = () => null;
  const microsoft = createMicrosoftAuth({ config: { clientId: 'app-id', authority: 'common' }, steps, win: fake.win, fetchImpl: fake.fetchImpl });
  microsoft.authorize();
  await new Promise(resolve => setTimeout(resolve, 10));
  steps.run(steps.list()[0].id);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(steps.list()[0].problem, /blocked Microsoft's sign-in window/);
});

test('Microsoft: a plain http:// page of another host, and a page inside another site, say so before any popup', async t => {
  installSessionStorage(t);
  const steps = new SignInSteps();
  const at = options => createMicrosoftAuth({ config: { clientId: 'app-id', authority: 'common' }, steps, win: fakeMicrosoftWindow(t, options).win });
  assert.equal(
    at({ origin: 'http://192.168.1.20:8765', secure: false }).whyNoSignIn(),
    'Microsoft sign-in needs https:// or this computer\'s own address (localhost), not http://192.168.1.20:8765. Open www.cellucid.com.'
  );
  const notebook = at({ origin: 'http://127.0.0.1:53124', top: 'http://localhost:8888' });
  assert.equal(
    notebook.whyNoSignIn(),
    'Microsoft sign-in cannot reach Cellucid inside another site\'s page (http://localhost:8888). Open Cellucid in its own tab, such as www.cellucid.com.'
  );
  await assert.rejects(notebook.authorize(), error => error.code === 'NOT_AVAILABLE' && /in its own tab/.test(error.message));
  assert.equal(steps.list().length, 0, 'no step offers a sign-in that cannot finish');
  // Same site (another port of 127.0.0.1), a tab of this computer, or a parent
  // whose site cannot be told: the popup is offered.
  assert.equal(at({ origin: 'http://127.0.0.1:53124', top: 'http://127.0.0.1:8888' }).whyNoSignIn(), null);
  assert.equal(at({ origin: 'http://localhost:9000' }).whyNoSignIn(), null);
  assert.equal(at({ origin: 'https://www.cellucid.com', top: 'https://lab.example.org' }).whyNoSignIn(), null);
});

test('Microsoft: a sign-in window closed without a sign-in ends the attempt, and the step offers it again', async t => {
  installSessionStorage(t);
  const steps = new SignInSteps();
  for (const [top, text] of [
    [null, 'Microsoft\'s sign-in window was closed before it finished.'],
    ['https://lab.example.org', 'Microsoft\'s sign-in window was closed before it finished. ' +
      'If you signed in, the browser kept the sign-in from this embedded page: open Cellucid in its own tab.'],
  ]) {
    const fake = fakeMicrosoftWindow(t, { top });
    const microsoft = createMicrosoftAuth({ config: { clientId: 'app-id', authority: 'common' }, steps, win: fake.win, fetchImpl: fake.fetchImpl });
    const waiting = microsoft.authorize();
    await new Promise(resolve => setTimeout(resolve, 10));
    const [step] = steps.list();
    steps.run(step.id);
    assert.equal(steps.list()[0].working, true);
    fake.log.popups[0].closed = true;
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(steps.list()[0].problem, text);
    assert.equal(steps.list()[0].working, false);
    assert.equal(fake.log.received.length, 0);
    // A message after the window closed is no longer listened for.
    fake.deliver({ state: Object.fromEntries(fake.log.opened[0].searchParams).state, code: 'LATE' });
    assert.equal(fake.log.posts.length, 0);
    steps.dismiss(step.id);
    await assert.rejects(waiting, /dismissed/);
  }
});

test('the provider config holds public identifiers only, empty until the owner registers Cellucid', async () => {
  const source = await readFile(path.join(ROOT, 'assets/js/data/sources/provider-config.js'), 'utf8');
  const { PROVIDER_CONFIG } = await import('../assets/js/data/sources/provider-config.js');
  assert.deepEqual(Object.keys(PROVIDER_CONFIG.google).sort(), ['apiKey', 'clientId', 'projectNumber', 'registeredOrigins']);
  assert.deepEqual(Object.keys(PROVIDER_CONFIG.microsoft).sort(), ['authority', 'clientId']);
  assert.deepEqual([...PROVIDER_CONFIG.google.registeredOrigins], ['https://www.cellucid.com', 'http://127.0.0.1:8765', 'http://localhost:8765']);
  assert.equal(PROVIDER_CONFIG.microsoft.authority, 'common');
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, ''), /secret/i, 'no secret is configured');
});

test('the privacy page says where sign-ins live and that no Cellucid server sees the data', async () => {
  const page = await readFile(path.join(ROOT, 'privacy.html'), 'utf8');
  assert.match(page, /<link rel="canonical" href="https:\/\/www\.cellucid\.com\/privacy\.html" \/>/);
  assert.match(page, /session storage/);
  assert.match(page, /deleted when the tab closes/);
  assert.match(page, /Neither the file nor your sign-in passes through a Cellucid server/);
  assert.match(page, /Limited Use requirements/);
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)" \/>/.exec(page)[1];
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(page, /style=/);
});
