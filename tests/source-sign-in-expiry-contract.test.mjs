/**
 * The token store says when a sign-in changes or ends
 * (`data/sources/auth/token-store.js`: `onSignInChange`, `setSignInExpiry`),
 * and the Session panel's signed-in line follows it
 * (`app/source-sign-in-view.js`): "Signed in to Google" with Sign out while
 * the sign-in lasts, and nothing once it has expired.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  onSignInChange,
  removeSignIn,
  setSignInExpiry,
  writeSignIn,
} from '../assets/js/data/sources/auth/token-store.js';

function installSessionStorage(t) {
  const values = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: key => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete globalThis.sessionStorage;
  });
  return values;
}

test('the store says when a sign-in is stored, removed, or reaches its end', t => {
  installSessionStorage(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const heard = [];
  const stop = onSignInChange(change => heard.push(`${change.name}:${change.change}`));
  t.after(stop);
  let now = 1_000;
  writeSignIn('google', '{}');
  setSignInExpiry('google', 4_000, () => now);
  now = 3_999;
  t.mock.timers.tick(2_999);
  assert.deepEqual(heard, ['google:stored']);
  now = 4_000;
  t.mock.timers.tick(1);
  assert.deepEqual(heard, ['google:stored', 'google:expired']);
  // A sign-in removed before its end is not said to expire later.
  setSignInExpiry('microsoft', 9_000, () => now);
  writeSignIn('microsoft', '{}');
  removeSignIn('microsoft');
  now = 10_000;
  t.mock.timers.tick(6_000);
  assert.deepEqual(heard.slice(2), ['microsoft:stored', 'microsoft:removed']);
});

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

test('the signed-in line hides once the sign-in expires', async t => {
  const values = installSessionStorage(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  // A Google sign-in of this tab, with ten seconds left.
  values.set('cellucid:google-auth:session', JSON.stringify({
    accessToken: 'TOKEN',
    expiresAt: 1_010_000,
    scope: 'https://www.googleapis.com/auth/drive.file',
  }));
  const { showSourceSignIn } = await import('../assets/js/app/source-sign-in-view.js');
  const elements = {
    'data-sign-in-step': new FakeElement(),
    'data-sign-in-text': new FakeElement(),
    'data-sign-in-btn': new FakeElement(),
  };
  const documentRef = { getElementById: id => elements[id] ?? null };
  const notifications = { hasNotification: () => false, dismiss() {}, info: () => 'n' };
  const stop = showSourceSignIn({ notifications, documentRef });
  t.after(stop);
  const line = elements['data-sign-in-step'];
  assert.equal(line.hidden, false);
  assert.equal(elements['data-sign-in-text'].textContent, 'Signed in to Google');
  assert.equal(elements['data-sign-in-btn'].textContent, 'Sign out');
  t.mock.timers.tick(10_000);
  assert.equal(line.hidden, true, 'an expired sign-in is not named');
});
