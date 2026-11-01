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
    value: '#view=umap&cellucid_github_auth=1&cellucid_github_token=TOKEN&cellucid_github_token_expires_in=28800',
    writable: false,
  });
  globalThis.fetch = async () => new Response('{"id":42,"login":"researcher"}', { status: 200 });
  try {
    const { GitHubAuthSession } = await import('../assets/js/app/community-annotations/github-auth.js');
    const auth = new GitHubAuthSession();
    auth._verifiedWorkerOrigin = auth.getWorkerOrigin();
    const result = await auth.completeSignInFromRedirect();
    assert.equal(result.token, 'TOKEN');
    assert.deepEqual(replacements, ['https://app.example/view?dataset=x#view=umap']);
    assert.equal(Object.hasOwn(globalThis.window, 'cellucidGitHubAuthFragment'), false, 'read once');
    assert.equal(await auth.completeSignInFromRedirect(), null, 'nothing left to adopt');
  } finally {
    Object.assign(globalThis, previous);
  }
});
