/**
 * A GitHub sign-in's answer leaves the page address before anything else
 * runs (`app/ui/core/auth-fragment-init.js`, a classic script in the head):
 * a startup that fails before the module that adopts it never leaves the
 * token in the address bar or in that history entry. The module
 * (`github-auth.js`) reads the fragment from the page's memory once, adopts
 * the token, and puts back the part of the fragment that was not the
 * sign-in's.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const SOURCE = await readFile(new URL('../assets/js/app/ui/core/auth-fragment-init.js', import.meta.url), 'utf8');
const INDEX = await readFile(new URL('../index.html', import.meta.url), 'utf8');

function run(hash) {
  const replaced = [];
  const window = {
    location: { pathname: '/view', search: '?dataset=x', hash },
    history: { state: { kept: true }, replaceState: (state, title, url) => replaced.push({ state, url }) },
  };
  vm.runInContext(SOURCE, vm.createContext({ window }));
  return { window, replaced };
}

test('the sign-in fragment is taken out of the address at once, whole', () => {
  const hash = '#view=umap&cellucid_github_auth=1&cellucid_github_token=SECRET&cellucid_github_token_expires_in=28800';
  const { window, replaced } = run(hash);
  assert.deepEqual(replaced, [{ state: { kept: true }, url: '/view?dataset=x' }]);
  assert.equal(window.cellucidGitHubAuthFragment, hash);
  assert.equal(Object.keys(window).includes('cellucidGitHubAuthFragment'), false, 'not enumerable');
  for (const error of ['#cellucid_github_auth=1&cellucid_github_error=denied', '#cellucid_github_token=x']) {
    assert.equal(run(error).replaced.length, 1, error);
  }
});

test('any other fragment is left alone', () => {
  for (const hash of ['', '#view=umap', '#payload=cellucid_github_token%3Dnot-a-field', '#xcellucid_github_token=1']) {
    const { window, replaced } = run(hash);
    assert.deepEqual(replaced, [], hash);
    assert.equal(Object.hasOwn(window, 'cellucidGitHubAuthFragment'), false, hash);
  }
});

test('index.html runs it in the head, before analytics and before any module', () => {
  const head = INDEX.slice(0, INDEX.indexOf('</head>'));
  const at = head.indexOf('<script src="assets/js/app/ui/core/auth-fragment-init.js');
  assert.ok(at > 0, 'in the head');
  assert.ok(at < head.indexOf('<script src="assets/js/app/ui/core/ga-init.js'), 'before analytics');
  // The boot script imports the app's code once the document is parsed; no
  // module script runs before it.
  assert.equal(INDEX.indexOf('type="module"'), -1, 'no module script but the boot script\'s import');

  assert.doesNotMatch(head.slice(at, head.indexOf('</script>', at)), /\b(type="module"|async|defer)\b/);
});

test('the module adopts the token from the page memory once and restores the rest of the fragment', async () => {
  const replacements = [];
  const values = new Map();
  const previous = { window: globalThis.window, sessionStorage: globalThis.sessionStorage, fetch: globalThis.fetch };
  globalThis.sessionStorage = {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  globalThis.window = {
    location: { origin: 'https://app.example', pathname: '/view', search: '?dataset=x', hash: '', href: 'https://app.example/view?dataset=x' },
    history: { state: null, replaceState: (state, title, url) => replacements.push(url) },
  };
  Object.defineProperty(globalThis.window, 'cellucidGitHubAuthFragment', {
    configurable: true,
    enumerable: false,
    value: '#view=umap&cellucid_github_state=S1&cellucid_github_auth=1&cellucid_github_token=TOKEN&cellucid_github_token_expires_in=28800',
    writable: false,
  });
  globalThis.fetch = async () => new Response('{"id":42,"login":"researcher"}', { status: 200 });
  try {
    const { GitHubAuthSession, SIGN_IN_STATE_STORAGE_KEY } = await import('../assets/js/app/community-annotations/github-auth.js');
    // The sign-in this tab started (`signIn`) named this state.
    values.set(SIGN_IN_STATE_STORAGE_KEY, 'S1');
    const auth = new GitHubAuthSession();
    auth._verifiedWorkerOrigin = auth.getWorkerOrigin();
    const result = await auth.completeSignInFromRedirect();
    assert.equal(result.token, 'TOKEN');
    assert.deepEqual(replacements, ['https://app.example/view?dataset=x#view=umap']);
    assert.equal(Object.hasOwn(globalThis.window, 'cellucidGitHubAuthFragment'), false, 'read once');
    assert.equal(await auth.completeSignInFromRedirect(), null, 'nothing left to adopt');
    assert.equal(values.has(SIGN_IN_STATE_STORAGE_KEY), false, 'the state is used once');
  } finally {
    Object.assign(globalThis, previous);
  }
});

/**
 * LG-3 (login CSRF): the worker hands the token to the page in the address
 * fragment, which anyone can write into a link. A token is adopted only when
 * the callback names the state of a sign-in this tab started, so a link
 * carrying someone else's token cannot sign the person in as them (their
 * votes and annotations would then be written as that account).
 */
test('a token is adopted only for a sign-in this tab started (its state), once', async () => {
  const replacements = [];
  const values = new Map();
  const assigned = [];
  const previous = { window: globalThis.window, sessionStorage: globalThis.sessionStorage, fetch: globalThis.fetch };
  globalThis.sessionStorage = {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  const page = (hash = '') => ({
    location: {
      origin: 'https://app.example', pathname: '/view', search: '?dataset=x', hash,
      href: `https://app.example/view?dataset=x${hash}`, assign: url => assigned.push(url),
    },
    history: { state: null, replaceState: (state, title, url) => replacements.push(url) },
  });
  const users = [];
  globalThis.fetch = async (url, init) => {
    users.push(init?.headers?.Authorization ?? init?.headers?.authorization ?? null);
    return new Response('{"id":42,"login":"researcher"}', { status: 200 });
  };
  const TOKEN = '&cellucid_github_auth=1&cellucid_github_token=THEIRS&cellucid_github_token_expires_in=28800';
  try {
    const { GitHubAuthSession, SIGN_IN_STATE_PARAM, SIGN_IN_STATE_STORAGE_KEY } = await import('../assets/js/app/community-annotations/github-auth.js');
    // signIn() keeps a fresh state and names it in the address GitHub returns to; the rest of the fragment is kept.
    globalThis.window = page('#view=umap&cellucid_github_state=stale');
    const auth = new GitHubAuthSession();
    auth._verifiedWorkerOrigin = auth.getWorkerOrigin();
    auth._verifyWorkerForOwner = async () => {};
    await auth.signIn();
    const state = values.get(SIGN_IN_STATE_STORAGE_KEY);
    assert.match(state, /^[0-9a-f]{32}$/);
    const returnTo = new URL(assigned[0]).searchParams.get('return_to');
    assert.equal(returnTo, `https://app.example/view?dataset=x#view=umap&${SIGN_IN_STATE_PARAM}=${state}`);

    const refused = async (hash, why) => {
      if (state !== null) values.set(SIGN_IN_STATE_STORAGE_KEY, state);
      globalThis.window = page();
      await assert.rejects(auth.completeSignInFromRedirect({ url: `https://app.example/view?dataset=x#${hash}` }), { code: 'GITHUB_AUTH_NOT_STARTED_HERE' }, why);
      assert.equal(auth.isAuthenticated(), false, why);
      assert.equal(values.has(SIGN_IN_STATE_STORAGE_KEY), false, `${why}: the state is spent`);
      assert.doesNotMatch(replacements.at(-1), /THEIRS|cellucid_github/, `${why}: nothing of the callback stays in the address`);
    };
    await refused(`view=umap${TOKEN}`, 'no state (a link someone made)');
    await refused(`view=umap&${SIGN_IN_STATE_PARAM}=0123${TOKEN}`, 'another state');
    await refused(`${SIGN_IN_STATE_PARAM}=${state}&${SIGN_IN_STATE_PARAM}=${state}${TOKEN}`, 'the state twice');
    // A tab that started no sign-in adopts none, whatever the link names.
    values.delete(SIGN_IN_STATE_STORAGE_KEY);
    globalThis.window = page();
    await assert.rejects(auth.completeSignInFromRedirect({ url: `https://app.example/view?dataset=x#${SIGN_IN_STATE_PARAM}=${state}${TOKEN}` }), { code: 'GITHUB_AUTH_NOT_STARTED_HERE' });
    assert.equal(users.length, 0, 'GitHub was never asked who the refused token is');

    // The callback of the sign-in started here signs in, and its state leaves the address.
    values.set(SIGN_IN_STATE_STORAGE_KEY, state);
    const result = await auth.completeSignInFromRedirect({ url: `https://app.example/view?dataset=x#view=umap&${SIGN_IN_STATE_PARAM}=${state}${TOKEN}` });
    assert.equal(result.token, 'THEIRS');
    assert.equal(replacements.at(-1), 'https://app.example/view?dataset=x#view=umap');
    // Replayed (the same link again): the state was spent.
    await assert.rejects(auth.completeSignInFromRedirect({ url: `https://app.example/view?dataset=x#${SIGN_IN_STATE_PARAM}=${state}${TOKEN}` }), { code: 'GITHUB_AUTH_NOT_STARTED_HERE' });
  } finally {
    Object.assign(globalThis, previous);
  }
});
