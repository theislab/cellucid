import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../assets/js/app/community-annotations/_worker-code.js';
import { parseExactJson } from '../assets/js/app/community-annotations/wire-contract.js';
import { WORKER_EXPOSED_RESPONSE_HEADERS } from '../assets/js/app/community-annotations/worker-contract.js';

const ENV = Object.freeze({
  ALLOWED_ORIGINS: 'https://app.example,http://localhost:8000',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});
const OPERATION_ID =
  '018f5e3a-7b9c-4d2e-8f10-123456789abc';

function request(path, options = {}) {
  return new Request(`https://worker.example${path}`, options);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function responseJson(response) {
  return parseExactJson(await response.text(), {
    path: `worker HTTP ${response.status} response`,
  });
}

function applyResponseCookies(jar, response) {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair, ...attributes] = cookie.split(';');
    const separator = pair.indexOf('=');
    assert.notEqual(separator, -1);
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const maxAge = attributes
      .map(attribute => attribute.trim())
      .find(attribute => /^Max-Age=/i.test(attribute));
    if (maxAge?.toLowerCase() === 'max-age=0') {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
}

function cookieHeader(jar) {
  return Array.from(
    jar,
    ([name, value]) => `${name}=${value}`
  ).join('; ');
}

async function beginOAuth(returnTo) {
  const response = await worker.fetch(
    request(
      `/auth/login?return_to=${encodeURIComponent(returnTo)}`
    ),
    ENV
  );
  const location = response.headers.get('location');
  return {
    response,
    location: location === null ? null : new URL(location),
  };
}

async function pkceChallenge(verifier) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(verifier)
    )
  );
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

test('worker exposes only the exact current route inventory', async () => {
  const response = await worker.fetch(request('/'), ENV);
  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson(response), {
    status: 'ok',
    service: 'Cellucid GitHub Auth',
    contractVersion: 3,
    endpoints: [
      '/auth/login',
      '/auth/callback',
      '/auth/revoke',
      '/auth/user',
      '/auth/installations',
      '/auth/installation-repos',
      '/cap/lookup-cells',
      '/graphql/snapshot',
      '/graphql/blobs',
      '/api/repos/*',
    ],
  });

  const removed = await worker.fetch(
    request('/auth/installation-token', { method: 'POST' }),
    ENV
  );
  assert.equal(removed.status, 404);

  const removedCapRoute = await worker.fetch(
    request('/cap/search-datasets', { method: 'POST' }),
    ENV
  );
  assert.equal(removedCapRoute.status, 404);

  const removedMethod = await worker.fetch(
    request('/api/repos/owner/repo/git/refs/heads/topic', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    }),
    ENV
  );
  assert.equal(removedMethod.status, 405);
});

test('every Worker route requires the complete exact environment', async () => {
  for (const key of [
    'ALLOWED_ORIGINS',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
  ]) {
    const env = { ...ENV };
    delete env[key];
    const response = await worker.fetch(request('/'), env);
    assert.equal(response.status, 500);
    assert.deepEqual(await responseJson(response), {
      error: `Missing or invalid worker secret: ${key}`,
    });
  }
});

test('worker rejects disallowed CORS origins without reflecting another origin', async () => {
  const response = await worker.fetch(
    request('/auth/user', {
      headers: {
        Authorization: 'Bearer token',
        Origin: 'https://evil.example',
      },
    }),
    ENV
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await responseJson(response), {
    error: 'Origin is not allowed: https://evil.example',
  });
});

test('authenticated reads forward only safe GitHub retry metadata', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        message: 'rate limited',
        documentation_url: 'https://docs.github.com/rest',
      }),
      {
        status: 429,
        headers: {
          'Retry-After': '7',
          'X-RateLimit-Reset': '2000000000',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Limit': '5000',
          'X-RateLimit-Used': '5000',
          'X-RateLimit-Resource': 'core',
          ETag: 'W/"abc"',
          'X-GitHub-Request-Id': 'ABCD:1234:5678:9ABC:DEF0',
          'Set-Cookie': 'github-secret=must-not-leak',
          'X-OAuth-Scopes': 'repo',
        },
      }
    );
  try {
    const response = await worker.fetch(
      request('/auth/user', {
        headers: {
          Authorization: 'Bearer token',
          Origin: 'https://app.example',
        },
      }),
      ENV
    );
    assert.equal(response.status, 429);
    assert.deepEqual(await responseJson(response), {
      error: 'rate limited',
    });
    assert.equal(response.headers.get('Retry-After'), '7');
    assert.equal(
      response.headers.get('X-RateLimit-Reset'),
      '2000000000'
    );
    assert.equal(
      response.headers.get('X-GitHub-Request-Id'),
      'ABCD:1234:5678:9ABC:DEF0'
    );
    assert.equal(response.headers.get('X-RateLimit-Remaining'), '0');
    assert.equal(response.headers.get('X-RateLimit-Limit'), '5000');
    assert.equal(response.headers.get('X-RateLimit-Used'), '5000');
    assert.equal(response.headers.get('X-RateLimit-Resource'), 'core');
    assert.equal(response.headers.get('ETag'), 'W/"abc"');
    assert.deepEqual(
      response.headers.get('Access-Control-Expose-Headers').split(', '),
      [...WORKER_EXPOSED_RESPONSE_HEADERS]
    );
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.equal(response.headers.get('X-OAuth-Scopes'), null);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('worker preflight exposes only the current mutation methods and headers', async () => {
  const response = await worker.fetch(
    request('/api/repos/owner/repo/contents/annotations/config.json', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example',
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
      },
    }),
    ENV
  );
  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get('access-control-allow-origin'),
    'https://app.example'
  );
  assert.equal(
    response.headers.get('access-control-allow-methods'),
    'GET, POST, PUT, PATCH, OPTIONS'
  );
  assert.equal(
    response.headers.get('access-control-allow-headers'),
    'authorization, content-type, if-none-match, x-cellucid-operation-id'
  );
  // Chromium keeps a preflight 2 hours at most: every route asks for that.
  assert.equal(response.headers.get('access-control-max-age'), '7200');

  for (const [path, method] of [
    ['/graphql/snapshot', 'POST'],
    ['/graphql/blobs', 'POST'],
    ['/api/repos/owner/repo/git/blobs/' + 'a'.repeat(40), 'GET'],
    ['/auth/user', 'GET'],
  ]) {
    const preflight = await worker.fetch(
      request(path, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example',
          'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': 'authorization, if-none-match',
        },
      }),
      ENV
    );
    assert.equal(preflight.status, 204, path);
    assert.equal(preflight.headers.get('access-control-max-age'), '7200', path);
  }

  const removedDelete = await worker.fetch(
    request('/api/repos/owner/repo/pulls/1', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example',
        'Access-Control-Request-Method': 'DELETE',
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
      },
    }),
    ENV
  );
  assert.equal(removedDelete.status, 400);
});

test('worker rejects inexact origin allowlists instead of normalizing them', async () => {
  const response = await worker.fetch(request('/'), {
    ...ENV,
    ALLOWED_ORIGINS: 'https://app.example, http://localhost:8000',
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await responseJson(response), {
    error:
      'ALLOWED_ORIGINS entries must be exact HTTPS origins or loopback ' +
      'HTTP development origins:  http://localhost:8000',
  });
});

test('worker permits HTTP only for exact loopback development origins', async (t) => {
  for (const origin of [
    'http://localhost:8000',
    'http://viewer.localhost:8000',
    'http://127.0.0.1:8000',
    'http://127.0.0.2:8000',
    'http://[::1]:8000',
  ]) {
    await t.test(origin, async () => {
      const response = await worker.fetch(request('/'), {
        ...ENV,
        ALLOWED_ORIGINS: origin,
      });
      assert.equal(response.status, 200);
    });
  }

  for (const origin of [
    'http://app.example',
    'http://192.168.1.5:8000',
    'http://0.0.0.0:8000',
  ]) {
    await t.test(`reject ${origin}`, async () => {
      const response = await worker.fetch(request('/'), {
        ...ENV,
        ALLOWED_ORIGINS: origin,
      });
      assert.equal(response.status, 500);
      assert.deepEqual(await responseJson(response), {
        error:
          'ALLOWED_ORIGINS entries must be exact HTTPS origins or loopback ' +
          `HTTP development origins: ${origin}`,
      });
    });
  }
});

test('OAuth login requires one explicit allowed return_to URL', async () => {
  const missing = await worker.fetch(request('/auth/login'), ENV);
  assert.equal(missing.status, 400);
  assert.equal(missing.headers.get('location'), null);
  assert.deepEqual(await responseJson(missing), { error: 'Missing return_to' });

  const duplicate = await worker.fetch(
    request(
      '/auth/login?return_to=https%3A%2F%2Fapp.example%2Fa' +
      '&return_to=https%3A%2F%2Fapp.example%2Fb'
    ),
    ENV
  );
  assert.equal(duplicate.status, 400);
  assert.deepEqual(await responseJson(duplicate), {
    error: 'return_to must occur at most once',
  });
});

test('OAuth flows own independent cookies in both callback orders', async () => {
  const previousFetch = globalThis.fetch;
  const exchanges = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://github.com/login/oauth/access_token');
    const body = parseExactJson(options.body);
    exchanges.push(body);
    return new Response(
      JSON.stringify({
        access_token: `oauth-token-${body.code}`,
        expires_in: 28_800,
        refresh_token: 'refresh-token',
        refresh_token_expires_in: 15_897_600,
        scope: '',
        token_type: 'bearer',
      }),
      { status: 200 }
    );
  };
  try {
    for (const order of [[0, 1], [1, 0]]) {
      const jar = new Map();
      const flows = [];
      for (const [index, path] of ['/one', '/two'].entries()) {
        const login = await beginOAuth(
          `https://app.example${path}?flow=${index + 1}`
        );
        assert.equal(login.response.status, 302);
        const state = login.location.searchParams.get('state');
        const challenge =
          login.location.searchParams.get('code_challenge');
        assert.match(state, /^[0-9a-f]{64}$/);
        assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
        applyResponseCookies(jar, login.response);
        flows.push({
          challenge,
          ownerCookie:
            `cellucid_gh_oauth_owner_${state}`,
          path,
          state,
        });
      }

      assert.equal(jar.size, 2);
      for (const flow of flows) {
        assert.equal(jar.has(flow.ownerCookie), true);
      }

      for (const flowIndex of order) {
        const flow = flows[flowIndex];
        const otherFlow = flows[1 - flowIndex];
        const exchangeCount = exchanges.length;
        const callback = await worker.fetch(
          request(
            `/auth/callback?code=code-${flowIndex + 1}` +
              `&state=${encodeURIComponent(flow.state)}`,
            { headers: { Cookie: cookieHeader(jar) } }
          ),
          ENV
        );
        assert.equal(callback.status, 302);
        assert.equal(
          new URL(callback.headers.get('location')).pathname,
          flow.path
        );
        assert.equal(exchanges.length, exchangeCount + 1);
        const exchange = exchanges.at(-1);
        assert.equal(exchange.code, `code-${flowIndex + 1}`);
        assert.equal(
          await pkceChallenge(exchange.code_verifier),
          flow.challenge
        );
        const cleared = callback.headers.getSetCookie();
        assert.equal(cleared.length, 1);
        assert.match(
          cleared[0],
          new RegExp(`^${flow.ownerCookie}=; `)
        );
        assert.match(cleared[0], /Max-Age=0/);
        applyResponseCookies(jar, callback);
        assert.equal(jar.has(flow.ownerCookie), false);
        if (order.indexOf(1 - flowIndex) > order.indexOf(flowIndex)) {
          assert.equal(jar.has(otherFlow.ownerCookie), true);
        }
      }
      assert.equal(jar.size, 0);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OAuth denial and success flows remain isolated in both orders', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = parseExactJson(options.body);
    return new Response(
      JSON.stringify({
        access_token: `oauth-token-${body.code}`,
        expires_in: 28_800,
        refresh_token: 'refresh-token',
        refresh_token_expires_in: 15_897_600,
        scope: '',
        token_type: 'bearer',
      }),
      { status: 200 }
    );
  };
  try {
    for (const deniedIndex of [0, 1]) {
      const successIndex = 1 - deniedIndex;
      for (const actionOrder of [
        ['denial', 'success'],
        ['success', 'denial'],
      ]) {
        const jar = new Map();
        const flows = [];
        for (const path of ['/one', '/two']) {
          const login = await beginOAuth(
            `https://app.example${path}`
          );
          const state = login.location.searchParams.get('state');
          flows.push({
            ownerCookie:
              `cellucid_gh_oauth_owner_${state}`,
            path,
            state,
          });
          applyResponseCookies(jar, login.response);
        }

        for (const [actionIndex, action] of actionOrder.entries()) {
          const isDenial = action === 'denial';
          const flowIndex = isDenial ? deniedIndex : successIndex;
          const callback = await worker.fetch(
            request(
              isDenial
                ? '/auth/callback?error=access_denied' +
                    '&error_description=User%20denied' +
                    `&state=${flows[flowIndex].state}`
                : `/auth/callback?code=code-${flowIndex}` +
                    `&state=${flows[flowIndex].state}`,
              { headers: { Cookie: cookieHeader(jar) } }
            ),
            ENV
          );
          assert.equal(callback.status, 302);
          const location = new URL(
            callback.headers.get('location')
          );
          assert.equal(location.pathname, flows[flowIndex].path);
          const fragment = new URLSearchParams(
            location.hash.slice(1)
          );
          if (isDenial) {
            assert.equal(
              fragment.get('cellucid_github_error'),
              'GitHub error: User denied'
            );
          } else {
            assert.equal(
              fragment.get('cellucid_github_token'),
              `oauth-token-code-${flowIndex}`
            );
          }
          applyResponseCookies(jar, callback);
          assert.equal(jar.has(flows[flowIndex].ownerCookie), false);
          if (actionIndex === 0) {
            assert.equal(
              jar.has(
                flows[isDenial ? successIndex : deniedIndex]
                  .ownerCookie
              ),
              true
            );
          }
        }
        assert.equal(jar.size, 0);
      }
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OAuth malformed callbacks cannot clear unrelated live owners', async () => {
  const jar = new Map();
  const flows = [];
  for (const path of ['/one', '/two']) {
    const login = await beginOAuth(`https://app.example${path}`);
    assert.equal(login.response.status, 302);
    const state = login.location.searchParams.get('state');
    flows.push({
      ownerCookie: `cellucid_gh_oauth_owner_${state}`,
      path,
      state,
    });
    applyResponseCookies(jar, login.response);
  }
  assert.equal(jar.size, 2);

  for (const callbackPath of [
    '/auth/callback?code=code-without-state',
    `/auth/callback?code=code&state=${flows[0].state}` +
      `&state=${flows[1].state}`,
    '/auth/callback?code=code&state=not-canonical',
  ]) {
    const before = new Map(jar);
    const response = await worker.fetch(
      request(callbackPath, {
        headers: { Cookie: cookieHeader(jar) },
      }),
      ENV
    );
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.getSetCookie().length, 0);
    applyResponseCookies(jar, response);
    assert.deepEqual(jar, before);
  }

  const malformedOwned = await worker.fetch(
    request(
      '/auth/callback?code=code' +
        '&error=access_denied' +
        '&error_description=User%20denied' +
        `&state=${flows[0].state}`,
      { headers: { Cookie: cookieHeader(jar) } }
    ),
    ENV
  );
  assert.equal(malformedOwned.status, 302);
  const malformedLocation = new URL(
    malformedOwned.headers.get('location')
  );
  assert.equal(malformedLocation.pathname, flows[0].path);
  assert.match(
    new URLSearchParams(malformedLocation.hash.slice(1)).get(
      'cellucid_github_error'
    ),
    /requires exactly one code or error/
  );
  applyResponseCookies(jar, malformedOwned);
  assert.equal(jar.has(flows[0].ownerCookie), false);
  assert.equal(jar.has(flows[1].ownerCookie), true);

  const denial = await worker.fetch(
    request(
      '/auth/callback?error=access_denied' +
        '&error_description=User%20denied' +
        `&state=${flows[1].state}`,
      { headers: { Cookie: cookieHeader(jar) } }
    ),
    ENV
  );
  assert.equal(denial.status, 302);
  assert.equal(
    new URL(denial.headers.get('location')).pathname,
    flows[1].path
  );
  applyResponseCookies(jar, denial);
  assert.equal(jar.size, 0);
});

test('OAuth owner corruption expiry replay and upstream failure are target-isolated', async () => {
  const jar = new Map();
  const flows = [];
  for (const path of ['/one', '/two', '/three']) {
    const login = await beginOAuth(`https://app.example${path}`);
    const state = login.location.searchParams.get('state');
    flows.push({
      ownerCookie: `cellucid_gh_oauth_owner_${state}`,
      path,
      state,
    });
    applyResponseCookies(jar, login.response);
  }
  assert.equal(jar.size, 3);

  const duplicateOwnerHeader =
    `${cookieHeader(jar)}; ` +
    `${flows[0].ownerCookie}=${jar.get(flows[0].ownerCookie)}`;
  const duplicateOwner = await worker.fetch(
    request(
      `/auth/callback?code=code&state=${flows[0].state}`,
      { headers: { Cookie: duplicateOwnerHeader } }
    ),
    ENV
  );
  assert.equal(duplicateOwner.status, 400);
  assert.equal(duplicateOwner.headers.get('location'), null);
  assert.equal(duplicateOwner.headers.getSetCookie().length, 1);
  applyResponseCookies(jar, duplicateOwner);
  assert.equal(jar.has(flows[0].ownerCookie), false);
  assert.equal(jar.has(flows[1].ownerCookie), true);
  assert.equal(jar.has(flows[2].ownerCookie), true);

  jar.delete(flows[1].ownerCookie);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const expiredOrReplay = await worker.fetch(
      request(
        `/auth/callback?code=code&state=${flows[1].state}`,
        { headers: { Cookie: cookieHeader(jar) } }
      ),
      ENV
    );
    assert.equal(expiredOrReplay.status, 400);
    assert.equal(expiredOrReplay.headers.get('location'), null);
    assert.equal(expiredOrReplay.headers.getSetCookie().length, 1);
    applyResponseCookies(jar, expiredOrReplay);
    assert.equal(jar.has(flows[2].ownerCookie), true);
  }

  const corruptLogin = await beginOAuth(
    'https://app.example/corrupt'
  );
  const corruptState =
    corruptLogin.location.searchParams.get('state');
  const corruptOwner =
    `cellucid_gh_oauth_owner_${corruptState}`;
  applyResponseCookies(jar, corruptLogin.response);
  jar.set(
    corruptOwner,
    encodeURIComponent(
      JSON.stringify({
        return_to: 'https://app.example/corrupt',
        code_verifier: 'a'.repeat(64),
        extra: true,
      })
    )
  );
  const corrupt = await worker.fetch(
    request(
      `/auth/callback?code=code&state=${corruptState}`,
      { headers: { Cookie: cookieHeader(jar) } }
    ),
    ENV
  );
  assert.equal(corrupt.status, 400);
  assert.equal(corrupt.headers.get('location'), null);
  applyResponseCookies(jar, corrupt);
  assert.equal(jar.has(corruptOwner), false);
  assert.equal(jar.has(flows[2].ownerCookie), true);

  async function addFlow(path) {
    const login = await beginOAuth(`https://app.example${path}`);
    const state = login.location.searchParams.get('state');
    const flow = {
      ownerCookie: `cellucid_gh_oauth_owner_${state}`,
      path,
      state,
    };
    applyResponseCookies(jar, login.response);
    return flow;
  }

  const previousFetch = globalThis.fetch;
  try {
    const failureSchedules = [
      {
        expectedError: 'GitHub rejected the authorization code',
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: 'bad_verification_code',
              error_description:
                'GitHub rejected the authorization code',
              error_uri: 'https://docs.github.com/apps/oauth',
            }),
            { status: 400 }
          ),
        label: 'rejected',
      },
      {
        expectedError:
          'GitHub sign-in outcome is unknown. Start a new sign-in; do not retry this callback.',
        fetch: async () => {
          throw new TypeError('Synthetic network failure');
        },
        label: 'network',
      },
      {
        expectedError:
          'GitHub sign-in outcome is unknown. Start a new sign-in; do not retry this callback.',
        fetch: async () =>
          new Response(
            // A token that never expires: a GitHub App without "Expire user
            // authorization tokens" is refused.
            JSON.stringify({
              access_token: 'oauth-token',
              scope: '',
              token_type: 'bearer',
            }),
            { status: 200 }
          ),
        label: 'malformed-success',
      },
    ];

    for (const failureSchedule of failureSchedules) {
      const target = await addFlow(
        `/upstream-${failureSchedule.label}`
      );
      const survivor = await addFlow(
        `/survivor-${failureSchedule.label}`
      );
      let failurePending = true;
      globalThis.fetch = async (...args) => {
        if (failurePending) {
          failurePending = false;
          return await failureSchedule.fetch(...args);
        }
        const body = parseExactJson(args[1].body);
        return new Response(
          JSON.stringify({
            access_token: `oauth-token-${body.code}`,
            expires_in: 28_800,
            refresh_token: 'refresh-token',
            refresh_token_expires_in: 15_897_600,
            scope: '',
            token_type: 'bearer',
          }),
          { status: 200 }
        );
      };

      const upstreamFailure = await worker.fetch(
        request(
          `/auth/callback?code=failure&state=${target.state}`,
          { headers: { Cookie: cookieHeader(jar) } }
        ),
        ENV
      );
      assert.equal(upstreamFailure.status, 302);
      const failureLocation = new URL(
        upstreamFailure.headers.get('location')
      );
      assert.equal(failureLocation.pathname, target.path);
      assert.equal(
        new URLSearchParams(failureLocation.hash.slice(1)).get(
          'cellucid_github_error'
        ),
        failureSchedule.expectedError
      );
      applyResponseCookies(jar, upstreamFailure);
      assert.equal(jar.has(target.ownerCookie), false);
      assert.equal(jar.has(survivor.ownerCookie), true);

      const survivorSuccess = await worker.fetch(
        request(
          `/auth/callback?code=survivor&state=${survivor.state}`,
          { headers: { Cookie: cookieHeader(jar) } }
        ),
        ENV
      );
      assert.equal(survivorSuccess.status, 302);
      assert.equal(
        new URL(survivorSuccess.headers.get('location')).pathname,
        survivor.path
      );
      applyResponseCookies(jar, survivorSuccess);
      assert.equal(jar.has(survivor.ownerCookie), false);
    }
    assert.equal(jar.size, 1);
    applyResponseCookies(
      jar,
      await worker.fetch(
        request(
          `/auth/callback?error=access_denied` +
            `&error_description=Finished&state=${flows[2].state}`,
          { headers: { Cookie: cookieHeader(jar) } }
        ),
        ENV
      )
    );
    assert.equal(jar.size, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OAuth owner cookies enforce an exact serialized byte boundary', async () => {
  async function assertBoundary(unit) {
    let acceptedCount = 0;
    let rejectedCount = 5000;
    const responseFor = count =>
      beginOAuth(
        'https://app.example/view?padding=' +
          unit.repeat(count)
      );
    const startsSignIn = result => result.location.origin === 'https://github.com';
    assert.equal(startsSignIn(await responseFor(acceptedCount)), true);
    assert.equal(startsSignIn(await responseFor(rejectedCount)), false);

    while (rejectedCount - acceptedCount > 1) {
      const candidate =
        Math.floor((acceptedCount + rejectedCount) / 2);
      if (startsSignIn(await responseFor(candidate))) {
        acceptedCount = candidate;
      } else {
        rejectedCount = candidate;
      }
    }

    const accepted = await responseFor(acceptedCount);
    const rejected = await responseFor(rejectedCount);
    const cookies = accepted.response.headers.getSetCookie();
    assert.equal(cookies.length, 1);
    assert.ok(
      new TextEncoder().encode(cookies[0]).byteLength <= 4096
    );
    assert.equal(rejectedCount, acceptedCount + 1);
    // A top-level navigation: the page comes back with the reason, no cookie is set.
    assert.equal(rejected.response.status, 302);
    assert.equal(rejected.response.headers.getSetCookie().length, 0);
    const back = new URL(rejected.response.headers.get('location'));
    assert.equal(back.origin, 'https://app.example');
    assert.equal(back.pathname, '/view');
    assert.match(
      new URLSearchParams(back.hash.slice(1)).get('cellucid_github_error'),
      /^GitHub sign-in could not start: this page address is [0-9,]+ characters long, more than the 4,096 bytes a browser keeps/
    );
  }

  await assertBoundary('a');
  await assertBoundary('😀');
  // Only what a cookie value cannot hold is escaped: a plain address costs its own length.
  await assertBoundary('/');
});

test('OAuth state and callback token exchange use one exact flow', async () => {
  const returnToHash =
    'x=%2f&x=%2F&space=%20&bare' +
    '&cellucid_github_auth=stale' +
    '&%63ellucid_github_token=stale-secret' +
    '&tail=%FF';
  const login = await worker.fetch(
    request(
      '/auth/login?return_to=' +
      encodeURIComponent(
        `https://app.example/view?dataset=synthetic#${returnToHash}`
      )
    ),
    ENV
  );
  assert.equal(login.status, 302);
  const githubLocation = new URL(login.headers.get('location'));
  const state = githubLocation.searchParams.get('state');
  assert.match(state, /^[0-9a-f]{64}$/);
  assert.equal(
    githubLocation.searchParams.get('code_challenge_method'),
    'S256'
  );
  assert.match(
    githubLocation.searchParams.get('code_challenge'),
    /^[A-Za-z0-9_-]{43}$/
  );

  const ownerCookieName = `cellucid_gh_oauth_owner_${state}`;
  const loginCookies = login.headers.getSetCookie();
  assert.equal(loginCookies.length, 1);
  assert.match(
    loginCookies[0],
    new RegExp(`^${ownerCookieName}=`)
  );
  assert.match(
    loginCookies[0],
    /; Path=\/auth\/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/
  );
  assert.doesNotMatch(loginCookies[0], /;\s*Domain=/i);
  const ownerPair = loginCookies[0].split(';', 1)[0];
  const ownerValue = ownerPair.slice(ownerPair.indexOf('=') + 1);
  // The PKCE verifier, a dot, and the return address with only `%`, `"`,
  // `,`, `;` and `\` escaped (what a cookie value cannot hold, RFC 6265 4.1.1).
  assert.match(ownerValue, /^[a-f0-9]{64}\.[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/);
  const ownerDocument = {
    code_verifier: ownerValue.slice(0, 64),
    return_to: decodeURIComponent(ownerValue.slice(65)),
  };
  assert.equal(
    ownerDocument.return_to,
    `https://app.example/view?dataset=synthetic#${returnToHash}`
  );
  const cookies = ownerPair;

  const previousFetch = globalThis.fetch;
  let tokenRequest = null;
  globalThis.fetch = async (url, options) => {
    tokenRequest = { url: String(url), options };
    return new Response(
      JSON.stringify({
        access_token: 'oauth-token',
        expires_in: 28_800,
        refresh_token: 'refresh-token',
        refresh_token_expires_in: 15_897_600,
        scope: '',
        token_type: 'bearer',
      }),
      { status: 200 }
    );
  };
  try {
    const callback = await worker.fetch(
      request(
        `/auth/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookies } }
      ),
      ENV
    );
    assert.equal(callback.status, 302);
    const clearedCookies = callback.headers.getSetCookie();
    assert.equal(clearedCookies.length, 1);
    assert.equal(
      clearedCookies[0].startsWith(`${ownerCookieName}=`),
      true
    );
    assert.match(
      clearedCookies[0],
      /; Path=\/auth\/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax$/
    );
    assert.doesNotMatch(clearedCookies[0], /;\s*Domain=/i);
    const appLocation = new URL(callback.headers.get('location'));
    assert.equal(
      appLocation.hash,
      '#x=%2f&x=%2F&space=%20&bare&tail=%FF' +
        '&cellucid_github_auth=1&cellucid_github_token=oauth-token' +
        '&cellucid_github_token_expires_in=28800'
    );
    const fragment = new URLSearchParams(appLocation.hash.slice(1));
    assert.equal(fragment.get('cellucid_github_auth'), '1');
    assert.equal(fragment.get('cellucid_github_token'), 'oauth-token');
    assert.equal(fragment.get('cellucid_github_token_expires_in'), '28800');
    assert.doesNotMatch(appLocation.hash, /refresh/, 'the refresh token never leaves the worker');
    assert.equal(fragment.get('cellucid_github_error'), null);
    assert.equal(
      `${appLocation.origin}${appLocation.pathname}${appLocation.search}`,
      'https://app.example/view?dataset=synthetic'
    );
    assert.equal(tokenRequest.url, 'https://github.com/login/oauth/access_token');
    assert.equal(tokenRequest.options.method, 'POST');
    const tokenBody = parseExactJson(tokenRequest.options.body);
    assert.match(tokenBody.code_verifier, /^[a-f0-9]{64}$/);
    const challengeBytes = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(tokenBody.code_verifier)
      )
    );
    const expectedChallenge = btoa(
      String.fromCharCode(...challengeBytes)
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    assert.equal(
      githubLocation.searchParams.get('code_challenge'),
      expectedChallenge
    );
    assert.equal(
      tokenBody.code_verifier,
      ownerDocument.code_verifier
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OAuth denial preserves unrelated return fragment bytes', async () => {
  const login = await worker.fetch(
    request(
      '/auth/login?return_to=' +
      encodeURIComponent(
        'https://app.example/view#x=%2f&bare' +
          '&cellucid_github_error=stale&tail=%FF'
      )
    ),
    ENV
  );
  assert.equal(login.status, 302);
  const githubLocation = new URL(login.headers.get('location'));
  const state = githubLocation.searchParams.get('state');
  const cookies = login.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

  const callback = await worker.fetch(
    request(
      '/auth/callback?error=access_denied' +
        '&error_description=User%20denied' +
        `&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: cookies } }
    ),
    ENV
  );
  assert.equal(callback.status, 302);
  const appLocation = new URL(callback.headers.get('location'));
  assert.equal(
    appLocation.hash,
    '#x=%2f&bare&tail=%FF' +
      '&cellucid_github_auth=1' +
      '&cellucid_github_error=GitHub+error%3A+User+denied'
  );
  assert.equal(
    new URLSearchParams(appLocation.hash.slice(1)).get(
      'cellucid_github_error'
    ),
    'GitHub error: User denied'
  );
});

test('OAuth redirect preserves a sole empty fragment component', async () => {
  const login = await worker.fetch(
    request(
      '/auth/login?return_to=' +
      encodeURIComponent(
        'https://app.example/view' +
          '#&cellucid_github_error=stale'
      )
    ),
    ENV
  );
  assert.equal(login.status, 302);
  const githubLocation = new URL(login.headers.get('location'));
  const state = githubLocation.searchParams.get('state');
  const cookies = login.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

  const callback = await worker.fetch(
    request(
      '/auth/callback?error=access_denied' +
        '&error_description=User%20denied' +
        `&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: cookies } }
    ),
    ENV
  );
  assert.equal(callback.status, 302);
  assert.equal(
    new URL(callback.headers.get('location')).hash,
    '#&cellucid_github_auth=1' +
      '&cellucid_github_error=GitHub+error%3A+User+denied'
  );
});

test('OAuth refuses a token that never expires (a GitHub App without token expiration)', async () => {
  const login = await worker.fetch(
    request(
      '/auth/login?return_to=' +
      encodeURIComponent('https://app.example/view')
    ),
    ENV
  );
  const githubLocation = new URL(login.headers.get('location'));
  const cookies = login.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        access_token: 'oauth-token',
        scope: '',
        token_type: 'bearer',
      }),
      { status: 200 }
    );
  try {
    const callback = await worker.fetch(
      request(
        '/auth/callback?code=authorization-code&state=' +
          encodeURIComponent(githubLocation.searchParams.get('state')),
        { headers: { Cookie: cookies } }
      ),
      ENV
    );
    assert.equal(callback.status, 302);
    const location = new URL(callback.headers.get('location'));
    assert.equal(location.origin, 'https://app.example');
    assert.equal(location.pathname, '/view');
    const fragment = new URLSearchParams(location.hash.slice(1));
    assert.equal(fragment.get('cellucid_github_auth'), '1');
    assert.equal(
      fragment.get('cellucid_github_error'),
      'GitHub sign-in outcome is unknown. Start a new sign-in; do not retry this callback.'
    );
    assert.equal(callback.headers.getSetCookie().length, 1);
    assert.match(callback.headers.getSetCookie()[0], /Max-Age=0/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OAuth callback never substitutes an allowlist origin for missing cookies', async () => {
  const state = 'a'.repeat(64);
  const response = await worker.fetch(
    request(`/auth/callback?code=code&state=${state}`),
    ENV
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('location'), null);
  assert.deepEqual(await responseJson(response), {
    error:
      `Missing cellucid_gh_oauth_owner_${state} cookie`,
  });
  assert.equal(response.headers.getSetCookie().length, 1);
  assert.match(
    response.headers.getSetCookie()[0],
    new RegExp(`^cellucid_gh_oauth_owner_${state}=; `)
  );
});

test('installation repository requests reject coerced and unknown fields', async (t) => {
  for (const [path, body] of [
    ['/auth/installation-repos?page=1', '{"installation_id":"42"}'],
    ['/auth/installation-repos?page=1', '{"installation_id":42.5}'],
    ['/auth/installation-repos?page=1', '{"installation_id":42,"unknown":true}'],
    ['/auth/installation-repos', '{"installation_id":42}'],
    ['/auth/installation-repos?page=0', '{"installation_id":42}'],
    ['/auth/installation-repos?page=01', '{"installation_id":42}'],
    ['/auth/installation-repos?page=1&page=2', '{"installation_id":42}'],
    ['/auth/installation-repos?page=1&per_page=100', '{"installation_id":42}'],
  ]) {
    await t.test(`${path} ${body}`, async () => {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        throw new Error('An invalid request must not reach GitHub');
      };
      try {
        const response = await worker.fetch(
          request(path, {
            method: 'POST',
            headers: {
              Authorization: 'Bearer token',
              'Content-Type': 'application/json',
              Origin: 'https://app.example',
            },
            body,
          }),
          ENV
        );
        assert.equal(response.status, 400);
      } finally {
        globalThis.fetch = previousFetch;
      }
    });
  }
});

test('worker projects installation repositories to the browser contract', async () => {
  const previousFetch = globalThis.fetch;
  let githubRequest = null;
  globalThis.fetch = async (url, options) => {
    githubRequest = { url: String(url), options };
    return new Response(
      JSON.stringify({
        total_count: 1,
        repositories: [
          {
            id: 7,
            full_name: 'owner/annotations',
            private: true,
            unused_remote_field: 'not forwarded',
          },
        ],
      }),
      { status: 200, headers: { 'X-RateLimit-Remaining': '4321' } }
    );
  };
  try {
    const response = await worker.fetch(
      request('/auth/installation-repos?page=3', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
          Origin: 'https://app.example',
        },
        body: '{"installation_id":42}',
      }),
      ENV
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await responseJson(response), {
      items: [
        { id: 7, full_name: 'owner/annotations', private: true },
      ],
      nextPage: null,
    });
    assert.equal(response.headers.get('X-RateLimit-Remaining'), '4321');
    assert.equal(
      githubRequest.url,
      'https://api.github.com/user/installations/42/repositories?per_page=100&page=3'
    );
    assert.equal(
      githubRequest.options.headers.get('authorization'),
      'Bearer token'
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

// Cloudflare Free allows 50 subrequests per request: a collection is one
// GitHub page per Worker request, however large it is (repro r05: 10,000
// installations were 100 subrequests in one request).
test('a collection is one GitHub page per Worker request, paged by GitHub\'s Link header', async () => {
  const previousFetch = globalThis.fetch;
  const githubRequests = [];
  const pages = 101;
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    githubRequests.push({ url: parsed.toString(), ifNoneMatch: options.headers.get('If-None-Match') });
    const page = Number(parsed.searchParams.get('page'));
    const installations = Array.from({ length: page === pages ? 1 : 100 }, (_, index) => ({
      id: (page - 1) * 100 + index + 1,
      account: { login: `account-${(page - 1) * 100 + index + 1}` },
      unused_remote_field: 'not forwarded',
    }));
    const link = [
      ...(page < pages ? [`<https://api.github.com/user/installations?per_page=100&page=${page + 1}>; rel="next"`] : []),
      `<https://api.github.com/user/installations?per_page=100&page=${pages}>; rel="last"`,
    ].join(', ');
    return new Response(
      JSON.stringify({ total_count: 10_001, installations }),
      { status: 200, headers: { Link: link, ETag: `"page-${page}"` } }
    );
  };
  try {
    let page = 1;
    let seen = 0;
    while (page !== null) {
      const before = githubRequests.length;
      const response = await worker.fetch(
        request(`/auth/installations?page=${page}`, {
          headers: {
            Authorization: 'Bearer token',
            Origin: 'https://app.example',
          },
        }),
        ENV
      );
      assert.equal(response.status, 200);
      assert.equal(githubRequests.length, before + 1, 'one subrequest per Worker request');
      assert.equal(response.headers.get('ETag'), `"page-${page}"`);
      const document = await responseJson(response);
      assert.deepEqual(Object.keys(document), ['items', 'nextPage']);
      assert.deepEqual(document.items[0], {
        id: (page - 1) * 100 + 1,
        account: { login: `account-${(page - 1) * 100 + 1}` },
      });
      seen += document.items.length;
      assert.equal(document.nextPage, page < pages ? page + 1 : null);
      page = document.nextPage;
    }
    assert.equal(seen, 10_001, 'no item limit: every installation is listed');
    assert.equal(githubRequests[0].url, 'https://api.github.com/user/installations?per_page=100&page=1');
    assert.equal(githubRequests.at(-1).url, `https://api.github.com/user/installations?per_page=100&page=${pages}`);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('a collection page passes a conditional request on and answers 304 with the GitHub headers', async () => {
  const previousFetch = globalThis.fetch;
  let forwardedTag = null;
  globalThis.fetch = async (_url, options) => {
    forwardedTag = options.headers.get('If-None-Match');
    return new Response(null, {
      status: 304,
      headers: { ETag: '"same"', 'X-RateLimit-Remaining': '4999' },
    });
  };
  try {
    const response = await worker.fetch(
      request('/auth/installations?page=1', {
        headers: {
          Authorization: 'Bearer token',
          Origin: 'https://app.example',
          'If-None-Match': '"same"',
        },
      }),
      ENV
    );
    assert.equal(forwardedTag, '"same"');
    assert.equal(response.status, 304);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('ETag'), '"same"');
    assert.equal(response.headers.get('X-RateLimit-Remaining'), '4999');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://app.example');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('a collection page is checked whole and named next page must follow it', async (t) => {
  const installation = index => ({ id: index, account: { login: `account-${index}` } });
  const scenarios = [
    {
      name: 'repeated id',
      document: { total_count: 2, installations: [installation(1), { id: 1, account: { login: 'other' } }] },
      error: 'GitHub installations page repeats 1',
    },
    {
      name: 'repeated account, other case',
      document: { total_count: 2, installations: [installation(1), { id: 2, account: { login: 'ACCOUNT-1' } }] },
      error: 'GitHub installations page repeats account-1',
    },
    {
      name: 'more than a page',
      document: { total_count: 101, installations: Array.from({ length: 101 }, (_, index) => installation(index + 1)) },
      error: 'GitHub installations page holds more than 100 items',
    },
    {
      name: 'invalid total_count',
      document: { total_count: -1, installations: [] },
      error: 'GitHub installations response has an invalid total_count',
    },
    {
      name: 'next page skips one',
      document: { total_count: 300, installations: [installation(1)] },
      link: '<https://api.github.com/user/installations?per_page=100&page=3>; rel="next"',
      error: 'GitHub installations names a next page that is not page 2',
    },
    {
      name: 'malformed Link',
      document: { total_count: 300, installations: [installation(1)] },
      link: 'https://api.github.com/user/installations?page=2; rel=next',
      error: 'GitHub installations Link header is malformed',
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(JSON.stringify(scenario.document), {
          status: 200,
          headers: scenario.link === undefined ? {} : { Link: scenario.link },
        });
      try {
        const response = await worker.fetch(
          request('/auth/installations?page=1', {
            headers: { Authorization: 'Bearer token', Origin: 'https://app.example' },
          }),
          ENV
        );
        assert.equal(response.status, 502);
        assert.deepEqual(await responseJson(response), { error: scenario.error });
      } finally {
        globalThis.fetch = previousFetch;
      }
    });
  }
});

test('GitHub responses are parsed natively: a repeated key keeps its last value, which is what is checked and relayed', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('{"id":42,"\\u0069d":43,"login":"researcher"}', {
      status: 200,
    });
  try {
    const response = await worker.fetch(
      request('/auth/user', {
        headers: {
          Authorization: 'Bearer token',
          Origin: 'https://app.example',
        },
      }),
      ENV
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await responseJson(response), { id: 43, login: 'researcher' });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('worker method allowlist rejects unsupported methods before proxying', async () => {
  const previousFetch = globalThis.fetch;
  let forwarded = false;
  globalThis.fetch = async () => {
    forwarded = true;
    throw new Error('Unsupported methods must not be forwarded');
  };
  try {
    const response = await worker.fetch(
      request('/api/repos/owner/repo/pulls/1', {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
          Origin: 'https://app.example',
        },
        body: '{"state":"open"}',
      }),
      ENV
    );
    assert.equal(response.status, 405);
    assert.deepEqual(await responseJson(response), {
      error: 'Method is not allowed: DELETE',
    });
    // PATCH is allowed only on the caller's own contribution branch ref.
    const patchPull = await worker.fetch(
      request('/api/repos/owner/repo/pulls/1', {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
          Origin: 'https://app.example',
        },
        body: '{"state":"open"}',
      }),
      ENV
    );
    assert.equal(patchPull.status, 404);
    assert.equal(forwarded, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('GitHub API proxy requires auth and the current /repos route family', async () => {
  const unauthorized = await worker.fetch(
    request('/api/repos/owner/repo', {
      headers: { Origin: 'https://app.example' },
    }),
    ENV
  );
  assert.equal(unauthorized.status, 401);

  const unsupported = await worker.fetch(
    request('/api/user', {
      headers: {
        Authorization: 'Bearer token',
        Origin: 'https://app.example',
      },
    }),
    ENV
  );
  assert.equal(unsupported.status, 404);
});

test('GitHub API proxy exposes only exact annotation operations and bodies', async () => {
  const previousFetch = globalThis.fetch;
  let forwarded = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === 'https://api.github.com/user') {
      return new Response('{"id":42,"login":"researcher"}', { status: 200 });
    }
    forwarded += 1;
    if (options.method === 'PUT') {
      return new Response(JSON.stringify({
        content: {
          sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          unknown_upstream_field: true,
        },
        commit: {
          sha: 'cccccccccccccccccccccccccccccccccccccccc',
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      type: 'file',
      encoding: 'base64',
      content: 'e30=\n',
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      unknown_upstream_field: true,
    }), { status: 200 });
  };
  const headers = {
    Authorization: 'Bearer token',
    Origin: 'https://app.example',
  };
  try {
    const rejectedRequests = [
      request('/api/repos/owner/repo/issues', { headers }),
      request('/api/repos/owner/repo/contents/README.md?ref=main', {
        headers,
      }),
      request('/api/repos/owner/repo/contents/annotations/config.json', {
        headers,
      }),
      // Cellucid never creates a fork (that needs the app's Administration permission).
      request('/api/repos/owner/repo/forks', {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'X-Cellucid-Operation-Id': OPERATION_ID,
        },
        body: '{}',
      }),
      request('/api/repos/owner/repo/contents/annotations/config.json', {
        method: 'PUT',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'X-Cellucid-Operation-Id': OPERATION_ID,
        },
        body: JSON.stringify({
          message: 'Update annotations',
          content: 'e30=',
          branch: 'main',
          sha: 'short-sha',
        }),
      }),
      request('/api/repos/owner/repo/contents/annotations/schema.json', {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Mutate schema',
          content: 'e30=',
          branch: 'main',
        }),
      }),
    ];
    for (const rejected of rejectedRequests) {
      const response = await worker.fetch(rejected, ENV);
      assert.ok(
        response.status === 400 ||
          response.status === 404 ||
          response.status === 405,
        `unexpected rejection status ${response.status}`
      );
    }
    assert.equal(forwarded, 0);

    const valid = await worker.fetch(
      request(
        '/api/repos/owner/repo/contents/annotations/config.json?ref=main',
        { headers }
      ),
      ENV
    );
    assert.equal(valid.status, 200);
    assert.deepEqual(await responseJson(valid), {
      type: 'file',
      encoding: 'base64',
      content: 'e30=\n',
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      unknown_upstream_field: true,
    });
    assert.equal(forwarded, 1);

    const validSchemaRead = await worker.fetch(
      request(
        '/api/repos/owner/repo/contents/annotations/moderation/merges.schema.json?ref=main',
        { headers }
      ),
      ENV
    );
    assert.equal(validSchemaRead.status, 200);
    assert.deepEqual(await responseJson(validSchemaRead), {
      type: 'file',
      encoding: 'base64',
      content: 'e30=\n',
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      unknown_upstream_field: true,
    });
    assert.equal(forwarded, 2);

    const validMutation = await worker.fetch(
      request(
        '/api/repos/owner/repo/contents/annotations/users/ghid_42.json',
        {
          method: 'PUT',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            'X-Cellucid-Operation-Id': OPERATION_ID,
          },
          body: JSON.stringify({
            message: 'Publish annotations',
            content: 'e30=',
            branch: 'main',
          }),
        }
      ),
      ENV
    );
    assert.equal(validMutation.status, 200);
    assert.deepEqual(await responseJson(validMutation), {
      content: {
        sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    });
    assert.equal(forwarded, 3);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('GitHub API proxy streams malformed upstream base64 exactly for browser validation', async () => {
  const previousFetch = globalThis.fetch;
  const headers = {
    Authorization: 'Bearer token',
    Origin: 'https://app.example',
  };
  try {
    for (const content of ['\n', 'e30= ']) {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({
          type: 'file',
          encoding: 'base64',
          content,
          sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }), { status: 200 });
      const response = await worker.fetch(
        request(
          '/api/repos/owner/repo/contents/annotations/config.json?ref=main',
          { headers }
        ),
        ENV
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await responseJson(response), {
        type: 'file',
        encoding: 'base64',
        content,
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      });
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('GitHub repository metadata is projected to one exact browser contract', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      full_name: 'owner/repo',
      default_branch: 'main',
      private: false,
      allow_forking: true,
      permissions: {
        pull: true,
        triage: false,
        push: false,
        maintain: false,
        admin: false,
        unknown_upstream_permission: true,
      },
      unknown_upstream_field: true,
    }), { status: 200 });
  try {
    const response = await worker.fetch(
      request('/api/repos/owner/repo', {
        headers: {
          Authorization: 'Bearer token',
          Origin: 'https://app.example',
        },
      }),
      ENV
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await responseJson(response), {
      full_name: 'owner/repo',
      default_branch: 'main',
      private: false,
      allow_forking: true,
      permissions: {
        pull: true,
        triage: false,
        push: false,
        maintain: false,
        admin: false,
      },
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('GitHub fork identity is ancestry-projected without forwarding its Worker query', async () => {
  const previousFetch = globalThis.fetch;
  const upstreamUrls = [];
  const headers = {
    Authorization: 'Bearer token',
    Origin: 'https://app.example',
  };
  globalThis.fetch = async rawUrl => {
    upstreamUrls.push(new URL(rawUrl));
    return new Response(JSON.stringify({
      full_name: 'researcher/renamed-repo',
      fork: true,
      parent: {
        full_name: 'owner/repo',
        unknown_parent_field: true,
      },
      unknown_upstream_field: true,
    }), { status: 200 });
  };
  try {
    const response = await worker.fetch(
      request(
        '/api/repos/researcher/repo?fork_identity=1',
        { headers }
      ),
      ENV
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await responseJson(response), {
      full_name: 'researcher/renamed-repo',
      fork: true,
      parent: { full_name: 'owner/repo' },
    });
    assert.equal(upstreamUrls.length, 1);
    assert.equal(
      upstreamUrls[0].toString(),
      'https://api.github.com/repos/researcher/repo',
      'the browser-only projection query must never reach GitHub',
    );

    for (const query of [
      'fork_identity=0',
      'fork_identity=1&extra=1',
      'fork_identity=1&fork_identity=1',
    ]) {
      const rejected = await worker.fetch(
        request(`/api/repos/researcher/repo?${query}`, { headers }),
        ENV
      );
      assert.equal(rejected.status, 400);
    }
    assert.equal(upstreamUrls.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('GitHub fork identity requires a coherent fork flag and parent', async () => {
  const previousFetch = globalThis.fetch;
  const headers = {
    Authorization: 'Bearer token',
    Origin: 'https://app.example',
  };
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        full_name: 'researcher/repo',
        fork: false,
      }), { status: 200 });
    const nonFork = await worker.fetch(
      request(
        '/api/repos/researcher/repo?fork_identity=1',
        { headers }
      ),
      ENV
    );
    assert.equal(nonFork.status, 200);
    assert.deepEqual(await responseJson(nonFork), {
      full_name: 'researcher/repo',
      fork: false,
      parent: null,
    });

    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        full_name: 'researcher/repo',
        fork: true,
      }), { status: 200 });
    const missingParent = await worker.fetch(
      request(
        '/api/repos/researcher/repo?fork_identity=1',
        { headers }
      ),
      ENV
    );
    assert.equal(missingParent.status, 502);

    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        full_name: 'researcher/repo',
        fork: false,
        parent: { full_name: 'owner/repo' },
      }), { status: 200 });
    const contradictoryParent = await worker.fetch(
      request(
        '/api/repos/researcher/repo?fork_identity=1',
        { headers }
      ),
      ENV
    );
    assert.equal(contradictoryParent.status, 502);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('GitHub fork listing accepts only newest-first bounded pages', async () => {
  const previousFetch = globalThis.fetch;
  const upstreamUrls = [];
  const headers = {
    Authorization: 'Bearer token',
    Origin: 'https://app.example',
  };
  globalThis.fetch = async rawUrl => {
    upstreamUrls.push(new URL(rawUrl));
    return new Response('[]', { status: 200 });
  };
  try {
    const response = await worker.fetch(
      request(
        '/api/repos/owner/repo/forks?sort=newest&per_page=100&page=1',
        { headers }
      ),
      ENV
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await responseJson(response), []);
    assert.equal(
      upstreamUrls[0].toString(),
      'https://api.github.com/repos/owner/repo/forks?sort=newest&per_page=100&page=1',
    );

    for (const query of [
      'per_page=100&page=1',
      'sort=oldest&per_page=100&page=1',
      'sort=newest&per_page=99&page=1',
      'sort=newest&per_page=100&page=0',
    ]) {
      const rejected = await worker.fetch(
        request(`/api/repos/owner/repo/forks?${query}`, { headers }),
        ENV
      );
      assert.equal(rejected.status, 400);
    }
    assert.equal(upstreamUrls.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Sign out revokes the token at GitHub with the app\'s own credentials; the token never reaches the page again', async () => {
  const previousFetch = globalThis.fetch;
  const asked = [];
  let answer = 204;
  globalThis.fetch = async (url, options) => {
    asked.push({ url: String(url), options });
    return new Response(null, { status: answer });
  };
  try {
    const revoke = () => worker.fetch(
      request('/auth/revoke', {
        method: 'POST',
        headers: { Authorization: 'Bearer user-token', Origin: 'https://app.example' },
      }),
      ENV
    );
    const response = await revoke();
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.example');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), '');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].url, 'https://api.github.com/applications/client-id/token');
    assert.equal(asked[0].options.method, 'DELETE');
    assert.equal(asked[0].options.headers.Authorization, `Basic ${btoa('client-id:client-secret')}`);
    assert.deepEqual(parseExactJson(asked[0].options.body), { access_token: 'user-token' });

    // A token GitHub no longer knows (expired, revoked already) is gone too.
    for (const status of [404, 422]) {
      answer = status;
      assert.equal((await revoke()).status, 204, `HTTP ${status}`);
    }
    answer = 500;
    assert.equal((await revoke()).status, 502);

    // No token, or another origin: nothing is asked of GitHub.
    const before = asked.length;
    const anonymous = await worker.fetch(
      request('/auth/revoke', { method: 'POST', headers: { Origin: 'https://app.example' } }),
      ENV
    );
    assert.equal(anonymous.status, 401);
    const foreign = await worker.fetch(
      request('/auth/revoke', {
        method: 'POST',
        headers: { Authorization: 'Bearer user-token', Origin: 'https://attacker.example' },
      }),
      ENV
    );
    assert.equal(foreign.status, 403);
    assert.equal((await worker.fetch(request('/auth/revoke', { method: 'GET' }), ENV)).status, 405);
    assert.equal(asked.length, before);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
