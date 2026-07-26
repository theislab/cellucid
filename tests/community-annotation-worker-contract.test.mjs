import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../assets/js/app/community-annotations/_worker-code.js';
import { parseExactJson } from '../assets/js/app/community-annotations/wire-contract.js';

const ENV = Object.freeze({
  ALLOWED_ORIGINS: 'https://app.example,http://localhost:8000',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});

function request(path, options = {}) {
  return new Request(`https://worker.example${path}`, options);
}

async function responseJson(response) {
  return parseExactJson(await response.text(), {
    path: `worker HTTP ${response.status} response`,
  });
}

test('worker exposes only the exact current route inventory', async () => {
  const response = await worker.fetch(request('/'), ENV);
  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson(response), {
    status: 'ok',
    service: 'Cellucid GitHub Auth',
    endpoints: [
      '/auth/login',
      '/auth/callback',
      '/auth/user',
      '/auth/installations',
      '/auth/installation-repos',
      '/api/repos/*',
    ],
  });

  const removed = await worker.fetch(
    request('/auth/installation-token', { method: 'POST' }),
    ENV
  );
  assert.equal(removed.status, 404);

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
  assert.match(
    response.headers.get('access-control-allow-methods'),
    /(?:^|, )PUT(?:,|$)/
  );
  assert.doesNotMatch(
    response.headers.get('access-control-allow-methods'),
    /(?:^|, )PATCH(?:,|$)/
  );
  assert.doesNotMatch(
    response.headers.get('access-control-allow-headers'),
    /x-github-api-version/i
  );

  const removedPatch = await worker.fetch(
    request('/api/repos/owner/repo/pulls/1', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example',
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
      },
    }),
    ENV
  );
  assert.equal(removedPatch.status, 400);
});

test('worker rejects inexact origin allowlists instead of normalizing them', async () => {
  const response = await worker.fetch(request('/'), {
    ...ENV,
    ALLOWED_ORIGINS: 'https://app.example, http://localhost:8000',
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await responseJson(response), {
    error:
      'ALLOWED_ORIGINS entry must be an exact HTTP(S) origin:  http://localhost:8000',
  });
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

test('OAuth state and callback token exchange use one exact flow', async () => {
  const login = await worker.fetch(
    request(
      '/auth/login?return_to=' +
      encodeURIComponent('https://app.example/view?dataset=synthetic')
    ),
    ENV
  );
  assert.equal(login.status, 302);
  const githubLocation = new URL(login.headers.get('location'));
  const state = githubLocation.searchParams.get('state');
  assert.match(state, /^[0-9a-f-]{36}$/);
  assert.equal(
    githubLocation.searchParams.get('code_challenge_method'),
    'S256'
  );
  assert.match(
    githubLocation.searchParams.get('code_challenge'),
    /^[A-Za-z0-9_-]{43}$/
  );

  const cookies = login.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
  assert.match(cookies, /cellucid_gh_oauth_state=/);
  assert.match(cookies, /cellucid_gh_oauth_return_to=/);
  assert.match(cookies, /cellucid_gh_oauth_code_verifier=/);

  const previousFetch = globalThis.fetch;
  let tokenRequest = null;
  globalThis.fetch = async (url, options) => {
    tokenRequest = { url: String(url), options };
    return new Response(
      JSON.stringify({
        access_token: 'oauth-token',
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
    assert.equal(clearedCookies.length, 3);
    for (const cookieName of [
      'cellucid_gh_oauth_state',
      'cellucid_gh_oauth_return_to',
      'cellucid_gh_oauth_code_verifier',
    ]) {
      assert.equal(
        clearedCookies.some(
          (cookie) =>
            cookie.startsWith(`${cookieName}=`) &&
            cookie.includes('Max-Age=0')
        ),
        true
      );
    }
    const appLocation = new URL(callback.headers.get('location'));
    const fragment = new URLSearchParams(appLocation.hash.slice(1));
    assert.equal(fragment.get('cellucid_github_auth'), '1');
    assert.equal(fragment.get('cellucid_github_token'), 'oauth-token');
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
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OAuth rejects expiring token documents required by a misconfigured GitHub App', async () => {
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
        expires_in: 28_800,
        refresh_token: 'refresh-token',
        refresh_token_expires_in: 15_897_600,
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
    assert.equal(callback.status, 502);
    assert.equal(callback.headers.get('location'), null);
    assert.deepEqual(await responseJson(callback), {
      error:
        'GitHub OAuth success response must contain exactly access_token, token_type, scope',
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OAuth callback never substitutes an allowlist origin for missing cookies', async () => {
  const response = await worker.fetch(
    request('/auth/callback?code=code&state=state'),
    ENV
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('location'), null);
  assert.deepEqual(await responseJson(response), {
    error: 'Missing cellucid_gh_oauth_return_to cookie',
  });
});

test('installation repository requests reject coerced and unknown fields', async (t) => {
  for (const body of [
    '{"installation_id":"42"}',
    '{"installation_id":42.5}',
    '{"installation_id":42,"unknown":true}',
    '{"installation_id":42,"\\u0069nstallation_id":43}',
  ]) {
    await t.test(body, async () => {
      const response = await worker.fetch(
        request('/auth/installation-repos', {
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
      { status: 200 }
    );
  };
  try {
    const response = await worker.fetch(
      request('/auth/installation-repos', {
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
      repositories: [
        { id: 7, full_name: 'owner/annotations', private: true },
      ],
    });
    assert.equal(
      githubRequest.url,
      'https://api.github.com/user/installations/42/repositories?per_page=100&page=1'
    );
    assert.equal(
      githubRequest.options.headers.get('authorization'),
      'Bearer token'
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('worker returns every GitHub installation page without truncation', async () => {
  const previousFetch = globalThis.fetch;
  const githubRequests = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    githubRequests.push(parsed.toString());
    const page = parsed.searchParams.get('page');
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      account: { login: `account-${index + 1}` },
    }));
    const installations =
      page === '1'
        ? firstPage
        : [{ id: 101, account: { login: 'account-101' } }];
    return new Response(
      JSON.stringify({ total_count: 101, installations }),
      { status: 200 }
    );
  };
  try {
    const response = await worker.fetch(
      request('/auth/installations', {
        headers: {
          Authorization: 'Bearer token',
          Origin: 'https://app.example',
        },
      }),
      ENV
    );
    assert.equal(response.status, 200);
    const document = await responseJson(response);
    assert.equal(document.installations.length, 101);
    assert.deepEqual(document.installations[100], {
      id: 101,
      account: { login: 'account-101' },
    });
    assert.deepEqual(githubRequests, [
      'https://api.github.com/user/installations?per_page=100&page=1',
      'https://api.github.com/user/installations?per_page=100&page=2',
    ]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('worker rejects duplicate-key JSON returned by GitHub', async () => {
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
    assert.equal(response.status, 502);
    assert.deepEqual(await responseJson(response), {
      error: 'GitHub API GET /user response contains invalid JSON',
    });
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
    assert.equal(response.status, 405);
    assert.deepEqual(await responseJson(response), {
      error: 'Method is not allowed: PATCH',
    });
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
  globalThis.fetch = async (_url, options = {}) => {
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
      request('/api/repos/owner/repo/forks', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: '{"organization":"alias-owner"}',
      }),
      request('/api/repos/owner/repo/contents/annotations/config.json', {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
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
    });
    assert.equal(forwarded, 2);

    const validMutation = await worker.fetch(
      request(
        '/api/repos/owner/repo/contents/annotations/users/ghid_42.json',
        {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
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

test('GitHub API proxy rejects malformed upstream base64 instead of repairing it', async () => {
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
      assert.equal(response.status, 502);
      assert.match((await responseJson(response)).error, /base64 payload/);
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
