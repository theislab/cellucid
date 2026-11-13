// Every way a GitHub sign-in through the community-annotation Worker can end
// has a defined outcome the person sees, among them token-endpoint errors
// under HTTP 200, the install-time authorization redirect without `state`
// and a long return address.

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../assets/js/app/community-annotations/_worker-code.js';
import { withMockedFetch } from './helpers/worker-fetch.mjs';

const ENV = Object.freeze({
  ALLOWED_ORIGINS: 'https://app.example,http://localhost:8000',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});

function request(path, options = {}) {
  return new Request(`https://worker.example${path}`, options);
}

async function beginLogin(returnTo = 'https://app.example/view') {
  const login = await worker.fetch(
    request(`/auth/login?return_to=${encodeURIComponent(returnTo)}`),
    ENV
  );
  const location = new URL(login.headers.get('location'));
  const cookies = login.headers.getSetCookie();
  return {
    login,
    location,
    state: location.searchParams.get('state'),
    cookie: cookies.length === 0 ? null : cookies[0].split(';', 1)[0],
  };
}

function appError(response) {
  return new URLSearchParams(new URL(response.headers.get('location')).hash.slice(1))
    .get('cellucid_github_error');
}

async function withConsoleErrors(operation) {
  const previous = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    await operation();
  } finally {
    console.error = previous;
  }
  return logged;
}

for (const [error, description] of [
  ['bad_verification_code', 'The code passed is incorrect or expired.'],
  ['incorrect_client_credentials', 'The client_id and/or client_secret passed are incorrect.'],
  ['invalid_grant', 'The code_verifier does not match the code_challenge supplied in the authorization request for PKCE.'],
]) {
  test(`a token exchange GitHub refuses under HTTP 200 (${error}) shows GitHub's reason and logs its code`, async () => {
    const { state, cookie } = await beginLogin();
    let response;
    const logged = await withConsoleErrors(() => withMockedFetch(
      async () => new Response(JSON.stringify({
        error,
        error_description: description,
        error_uri: 'https://docs.github.com/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      async () => {
        response = await worker.fetch(
          request(`/auth/callback?code=the-code&state=${state}`, { headers: { Cookie: cookie } }),
          ENV
        );
      }
    ));
    assert.equal(response.status, 302);
    assert.equal(appError(response), description);
    assert.match(response.headers.getSetCookie()[0], /Max-Age=0/);
    // The operator can see what to fix; nothing secret is logged.
    assert.equal(logged.length, 1);
    assert.deepEqual(logged[0][1], { error, status: 200 });
    const text = JSON.stringify(logged);
    for (const secret of ['client-secret', 'the-code', cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf('=') + 65)]) {
      assert.equal(text.includes(secret), false);
    }
  });
}

test('a refusal without a description shows its code; a malformed refusal is an unknown outcome', async () => {
  for (const [document, expected] of [
    [{ error: 'access_denied' }, 'access_denied'],
    [{ error: 'access_denied', unexpected: true }, 'GitHub sign-in outcome is unknown. Start a new sign-in; do not retry this callback.'],
    [{ error: '' }, 'GitHub sign-in outcome is unknown. Start a new sign-in; do not retry this callback.'],
  ]) {
    const { state, cookie } = await beginLogin();
    let response;
    await withConsoleErrors(() => withMockedFetch(
      async () => new Response(JSON.stringify(document), { status: 200 }),
      async () => {
        response = await worker.fetch(
          request(`/auth/callback?code=c&state=${state}`, { headers: { Cookie: cookie } }),
          ENV
        );
      }
    ));
    assert.equal(response.status, 302);
    assert.equal(appError(response), expected, JSON.stringify(document));
  }
});

for (const [action, title] of [
  ['install', 'The Cellucid GitHub App is installed'],
  ['update', 'The Cellucid GitHub App installation is updated'],
  ['request', 'Your request to install the Cellucid GitHub App was sent'],
]) {
  test(`GitHub's install-time redirect without state (setup_action=${action}) ends on a page that says what to do`, async () => {
    const calls = [];
    await withMockedFetch(async (url) => {
      calls.push(String(url));
      throw new Error('the install redirect exchanges nothing');
    }, async () => {
      const response = await worker.fetch(
        request(`/auth/callback?code=abc&installation_id=42&setup_action=${action}`),
        ENV
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
      assert.match(response.headers.get('Content-Security-Policy'), /default-src 'none'/);
      assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
      assert.deepEqual(response.headers.getSetCookie(), []);
      const html = await response.text();
      assert.match(html, new RegExp(`<h1[^>]*>${title}</h1>`));
      assert.match(html, /Cellucid/);
      assert.doesNotMatch(html, /abc/, 'the authorization code is not echoed');
    });
    assert.deepEqual(calls, []);
  });
}

test('a callback without state is otherwise refused as before', async () => {
  for (const [path, error] of [
    ['/auth/callback?code=abc', 'Missing state'],
    ['/auth/callback?code=abc&setup_action=delete', 'setup_action must be install, update or request'],
    ['/auth/callback?code=abc&setup_action=install&setup_action=update', 'setup_action must occur at most once'],
  ]) {
    const response = await worker.fetch(request(path), ENV);
    assert.equal(response.status, 400, path);
    assert.deepEqual(await response.json(), { error }, path);
  }
});

test('a long, percent-heavy return address signs in up to the cookie limit, and past it comes back with the reason', async () => {
  // A Cellucid link to a presigned object: its query is percent-encoded once
  // in the page address and once more in return_to.
  const make = length =>
    'https://app.example/?data=' +
    encodeURIComponent(
      'https://s3.example/bucket/key?' +
        'X-Amz-Signature=%2F%2B'.repeat(Math.ceil(length / 22)).slice(0, length)
    );
  // An encodeURIComponent of a JSON document would hold only addresses up
  // to its own, shorter, limit: this measures that length for comparison.
  const formerSerializedLength = returnTo => {
    const value = encodeURIComponent(JSON.stringify({ return_to: returnTo, code_verifier: 'a'.repeat(64) }));
    return `cellucid_gh_oauth_owner_${'a'.repeat(64)}=${value}; Path=/auth/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax`.length;
  };
  let accepted = 0;
  let refused = 6000;
  while (refused - accepted > 1) {
    const candidate = Math.floor((accepted + refused) / 2);
    const { location } = await beginLogin(make(candidate));
    if (location.origin === 'https://github.com') accepted = candidate;
    else refused = candidate;
  }
  assert.ok(formerSerializedLength(make(accepted)) > 4096, 'the old encoding refused what now signs in');

  const past = await beginLogin(make(refused));
  assert.equal(past.login.status, 302);
  assert.equal(past.cookie, null);
  assert.equal(past.location.origin, 'https://app.example');
  assert.equal(past.location.searchParams.get('data'), new URL(make(refused)).searchParams.get('data'));
  assert.match(
    new URLSearchParams(past.location.hash.slice(1)).get('cellucid_github_error'),
    /^GitHub sign-in could not start: this page address is [0-9,]+ characters long/
  );
});

test('the return address survives the owner cookie exactly, whatever characters it holds', async () => {
  const returnTo =
    'https://app.example/a%2Cb;c/?q=%22x%22,y;z%5C&e=%25%25&s=\'"&u=%F0%9F%98%80#frag=%2C,;"\\';
  const { state, cookie } = await beginLogin(returnTo);
  const value = cookie.slice(cookie.indexOf('=') + 1);
  assert.match(value, /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/, 'only cookie-octets (RFC 6265 4.1.1)');
  const response = await worker.fetch(
    request(`/auth/callback?error=access_denied&error_description=No&state=${state}`, { headers: { Cookie: cookie } }),
    ENV
  );
  const back = new URL(response.headers.get('location'));
  const expected = new URL(returnTo);
  assert.equal(`${back.origin}${back.pathname}${back.search}`, `${expected.origin}${expected.pathname}${expected.search}`);
  assert.ok(back.hash.startsWith(`${expected.hash}&cellucid_github_auth=1`));
});
