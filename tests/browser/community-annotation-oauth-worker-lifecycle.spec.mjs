import { once } from 'node:events';
import { createPrivateKey } from 'node:crypto';
import { createServer } from 'node:https';

import { expect, test } from '@playwright/test';

import worker from '../../assets/js/app/community-annotations/_worker-code.js';
import {
  parseExactJson,
} from '../../assets/js/app/community-annotations/wire-contract.js';

const APP_ORIGIN = 'https://app.example';
const ENV = Object.freeze({
  ALLOWED_ORIGINS: APP_ORIGIN,
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});

// Synthetic test-only key/certificate pair. The isolated browser context
// explicitly distrusts it so this exercises a real TLS jar without a live host.
const TLS_KEY = createPrivateKey({
  format: 'jwk',
  key: {
    crv: 'P-256',
    d: 'esRbuU_7i9xVsmprO79HZkuom9j6f7M5YQHVhse4qS8',
    kty: 'EC',
    x: '7gxQVHaI9YLpPVCiLVK87fWT7pRAmJflfDSgST4RZ2A',
    y: 'HOXXbmBermjOkScD6Lz7MWJHRlDn6-mIMJa88mrgkto',
  },
}).export({ format: 'pem', type: 'pkcs8' });

const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBmTCCAT+gAwIBAgIUdK86gbfl/kkijgIn6owDgSFLOLcwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDcyOTE1MDY0MFoXDTM2MDcyNjE1
MDY0MFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAE7gxQVHaI9YLpPVCiLVK87fWT7pRAmJflfDSgST4RZ2Ac5dduYF6uaM6R
JwPovPsxYkdGUOfr6YgwlrzyauCS2qNvMG0wHQYDVR0OBBYEFCWFNflx75Y1JHwx
TKkAk9NX7IX2MB8GA1UdIwQYMBaAFCWFNflx75Y1JHwxTKkAk9NX7IX2MA8GA1Ud
EwEB/wQFMAMBAf8wGgYDVR0RBBMwEYcEfwAAAYIJbG9jYWxob3N0MAoGCCqGSM49
BAMCA0gAMEUCIQD/cUvsrjGkohQ6hMBu5GNEwThr1n3da15R+5sCAL/nqgIgHEqp
2vGu9KrVVstW+f4BJ5phN3n61yUu1Jb/Bhn5jYg=
-----END CERTIFICATE-----`;

function cookieNames(rawCookie) {
  if (rawCookie === undefined) return [];
  return rawCookie
    .split(';')
    .map(part => part.slice(0, part.indexOf('=')).trim())
    .filter(Boolean)
    .sort();
}

function copyRequestHeaders(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

async function startWorkerServer() {
  const serverErrors = [];
  let origin = null;
  const server = createServer(
    { cert: TLS_CERT, key: TLS_KEY },
    (request, response) => {
      void (async () => {
        const workerResponse = await worker.fetch(
          new Request(new URL(request.url, origin), {
            headers: copyRequestHeaders(request),
            method: request.method,
          }),
          ENV
        );
        const result = {
          cookieNames: cookieNames(request.headers.cookie),
          error:
            workerResponse.status === 302
              ? null
              : (await workerResponse.clone().json()).error,
          location: workerResponse.headers.get('location'),
          status: workerResponse.status,
        };
        const setCookies = workerResponse.headers.getSetCookie();
        if (setCookies.length) {
          response.setHeader('Set-Cookie', setCookies);
        }
        response.statusCode = 200;
        response.setHeader(
          'Content-Type',
          'application/json; charset=utf-8'
        );
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify(result));
      })().catch(error => {
        serverErrors.push(error);
        response.statusCode = 500;
        response.end('Synthetic worker server failed');
      });
    }
  );
  server.listen(0);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Synthetic worker server has no TCP address');
  }
  origin = `https://127.0.0.1:${address.port}`;
  return {
    crossSiteOrigin: `https://localhost:${address.port}`,
    origin,
    serverErrors,
    async close() {
      await new Promise((resolve, reject) => {
        server.close(error => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

async function navigateJson(page, url) {
  const response = await page.goto(url);
  expect(response).not.toBeNull();
  expect(response.status()).toBe(200);
  return await response.json();
}

test('OAuth owner cookies preserve exact raw Set-Cookie bytes', async () => {
  const login = await worker.fetch(
    new Request(
      'https://worker.example/auth/login?return_to=' +
        encodeURIComponent(`${APP_ORIGIN}/raw-cookie-contract`),
    ),
    ENV,
  );
  expect(login.status).toBe(302);
  const state = new URL(login.headers.get('location')).searchParams.get(
    'state',
  );
  expect(state).toMatch(/^[0-9a-f]{64}$/);
  const ownerName = `cellucid_gh_oauth_owner_${state}`;
  const loginCookies = login.headers.getSetCookie();
  expect(loginCookies).toHaveLength(1);
  expect(loginCookies[0]).toMatch(
    new RegExp(
      `^${ownerName}=` +
        '[^;]+; Path=/auth/callback; Max-Age=600; ' +
        'HttpOnly; Secure; SameSite=Lax$',
    ),
  );
  expect(loginCookies[0]).not.toMatch(/;\s*Domain=/i);

  const ownerPair = loginCookies[0].split(';', 1)[0];
  const callback = await worker.fetch(
    new Request(
      'https://worker.example/auth/callback?' +
        `error=access_denied&error_description=Denied&state=${state}`,
      {
        headers: {
          Cookie: ownerPair,
        },
      },
    ),
    ENV,
  );
  expect(callback.status).toBe(302);
  expect(callback.headers.getSetCookie()).toEqual([
    `${ownerName}=; Path=/auth/callback; Max-Age=0; ` +
      'HttpOnly; Secure; SameSite=Lax',
  ]);
});

test(
  'state-specific OAuth cookies coexist and retire independently',
  async ({ browser }) => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
      const body = parseExactJson(options.body);
      return new Response(
        JSON.stringify({
          access_token: `oauth-token-${body.code}`,
          scope: '',
          token_type: 'bearer',
        }),
        { status: 200 }
      );
    };
    let workerServer = null;
    let context = null;
    try {
      workerServer = await startWorkerServer();
      context = await browser.newContext({
        ignoreHTTPSErrors: true,
      });
      const page = await context.newPage();
      for (const order of [[0, 1], [1, 0]]) {
        const flows = [];
        for (const path of ['/one', '/two']) {
          const login = await navigateJson(
            page,
            `${workerServer.origin}/auth/login?return_to=` +
              encodeURIComponent(`${APP_ORIGIN}${path}`)
          );
          expect(login).toMatchObject({
            cookieNames: [],
            error: null,
            status: 302,
          });
          const state =
            new URL(login.location).searchParams.get('state');
          expect(state).toMatch(/^[0-9a-f]{64}$/);
          flows.push({
            name: `cellucid_gh_oauth_owner_${state}`,
            path,
            state,
          });
        }

        let cookies = await context.cookies(
          `${workerServer.origin}/auth/callback`
        );
        expect(cookies).toHaveLength(2);
        expect(cookies.map(cookie => cookie.name).sort()).toEqual(
          flows.map(flow => flow.name).sort(),
        );

        for (const [callbackIndex, flowIndex] of order.entries()) {
          const flow = flows[flowIndex];
          const liveNames = cookies
            .map(cookie => cookie.name)
            .sort();
          const githubPage = await navigateJson(
            page,
            `${workerServer.crossSiteOrigin}/github`
          );
          expect(githubPage).toEqual({
            cookieNames: [],
            error: 'Route not found',
            location: null,
            status: 404,
          });
          expect(new URL(page.url()).hostname).toBe('localhost');
          const callback = await navigateJson(
            page,
            `${workerServer.origin}/auth/callback` +
              `?code=code-${flowIndex}&state=${flow.state}`
          );
          expect(callback).toMatchObject({
            cookieNames: liveNames,
            error: null,
            status: 302,
          });
          expect(new URL(callback.location).pathname).toBe(flow.path);

          cookies = await context.cookies(
            `${workerServer.origin}/auth/callback`
          );
          expect(cookies.some(cookie => cookie.name === flow.name)).toBe(
            false
          );
          expect(cookies).toHaveLength(1 - callbackIndex);

          if (callbackIndex === 0) {
            const beforeMalformed = cookies;
            const malformed = await navigateJson(
              page,
              `${workerServer.origin}/auth/callback?code=missing-state`
            );
            expect(malformed).toEqual({
              cookieNames: cookies.map(cookie => cookie.name),
              error: 'Missing state',
              location: null,
              status: 400,
            });
            cookies = await context.cookies(
              `${workerServer.origin}/auth/callback`
            );
            expect(cookies).toEqual(beforeMalformed);
          }
        }
        expect(cookies).toEqual([]);
      }
      expect(workerServer.serverErrors).toEqual([]);
    } finally {
      const cleanup = await Promise.allSettled([
        context?.close(),
        workerServer?.close(),
      ]);
      globalThis.fetch = previousFetch;
      const cleanupErrors = cleanup
        .filter(result => result.status === 'rejected')
        .map(result => result.reason);
      if (cleanupErrors.length) {
        throw new AggregateError(
          cleanupErrors,
          'OAuth lifecycle test cleanup failed'
        );
      }
    }
  }
);
