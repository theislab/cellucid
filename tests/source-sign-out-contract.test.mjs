/**
 * Sign out of Google Drive and OneDrive (`app/source-sign-in-view.js`): the
 * sign-in is forgotten at once, and a sign-in the provider did not revoke is
 * said in a notification, never left silent (Google unreachable; Microsoft
 * offers no revocation). Its own process: the page's sign-ins are singletons.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

class FakeElement {
  constructor() {
    this.hidden = true;
    this.textContent = '';
    this.disabled = false;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type) {
    this.listeners.delete(type);
  }
}

test('signing out of a sign-in Google could not revoke says so', async t => {
  const values = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: key => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
  });
  t.after(() => delete globalThis.sessionStorage);
  const originalFetch = globalThis.fetch;
  const revocations = [];
  globalThis.fetch = async url => {
    revocations.push(String(url));
    throw new TypeError('Failed to fetch');
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  values.set('cellucid:google-auth:session', JSON.stringify({
    accessToken: 'TOKEN',
    expiresAt: Date.now() + 3_600_000,
    scope: 'https://www.googleapis.com/auth/drive.file',
  }));
  const { showSourceSignIn } = await import('../assets/js/app/source-sign-in-view.js');
  const elements = {
    'data-sign-in-step': new FakeElement(),
    'data-sign-in-text': new FakeElement(),
    'data-sign-in-btn': new FakeElement(),
  };
  const warnings = [];
  const notifications = {
    hasNotification: () => false,
    dismiss() {},
    info: () => 'n',
    warning: (message, options) => warnings.push({ message, options }),
  };
  const stop = showSourceSignIn({ notifications, documentRef: { getElementById: id => elements[id] ?? null } });
  t.after(stop);
  assert.equal(elements['data-sign-in-btn'].textContent, 'Sign out');
  elements['data-sign-in-btn'].listeners.get('click')();
  assert.equal(values.has('cellucid:google-auth:session'), false, 'forgotten at once');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(revocations, ['https://oauth2.googleapis.com/revoke']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /^Signed out of Google here, but Google could not be reached to revoke the sign-in: it stops working when it expires, within the hour\.$/);
});
