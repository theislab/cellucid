/**
 * Cloudflare Worker: GitHub App Auth for Cellucid
 * CRITICAL: IT IS HERE FOR DEV PURPOSE. 
 * THE CODE HERE IS NOT FUNCTIONING, IT IS EXACT REPLICA OF THE WORKER.
 *
 * Handles:
 * - User authentication via GitHub App OAuth
 * - Installation token generation for repo access
 * - API proxying with proper authentication
 */

const GITHUB_API = 'https://api.github.com';
const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

const OAUTH_STATE_COOKIE = 'cellucid_gh_oauth_state';
const OAUTH_RETURN_TO_COOKIE = 'cellucid_gh_oauth_return_to';
const OAUTH_COOKIE_MAX_AGE_S = 10 * 60;

const APP_AUTH_FLAG_PARAM = 'cellucid_github_auth';
const APP_AUTH_TOKEN_PARAM = 'cellucid_github_token';
const APP_AUTH_ERROR_PARAM = 'cellucid_github_error';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS handling
    const corsHeaders = getCorsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const routes = {
        '/auth/login': () => handleLogin(request, url, env),
        '/auth/callback': () => handleCallback(request, url, env),
        '/auth/user': () => handleGetUser(request, corsHeaders),
        '/auth/installations': () => handleGetInstallations(request, corsHeaders),
        '/auth/installation-token': () => handleGetInstallationToken(request, env, corsHeaders),
        '/auth/installation-repos': () => handleGetInstallationRepos(request, env, corsHeaders),
      };

      // Check exact routes
      if (routes[url.pathname]) {
        return routes[url.pathname]();
      }

      // API proxy route
      if (url.pathname.startsWith('/api/')) {
        return handleApiProxy(request, url, env, corsHeaders);
      }

      // Health check
      if (url.pathname === '/') {
        return new Response(JSON.stringify({
          status: 'ok',
          service: 'Cellucid GitHub Auth',
          endpoints: Object.keys(routes)
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};

// =============================================================================
// CORS
// =============================================================================

function getCorsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = String(env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
  if (!allowedOrigins.length) throw new Error('Missing ALLOWED_ORIGINS');
  if (allowedOrigins.includes('*')) throw new Error('ALLOWED_ORIGINS must not include "*"');
  const isAllowed = Boolean(origin && allowedOrigins.includes(origin));

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigins[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-GitHub-Api-Version',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };
}

// =============================================================================
// AUTH ROUTES
// =============================================================================

/**
 * Start OAuth flow - redirects to GitHub
 */
function getAllowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function serializeCookie(name, value, { path = '/', maxAge = null } = {}) {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${path}`);
  if (typeof maxAge === 'number') parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  parts.push('HttpOnly');
  parts.push('Secure');
  parts.push('SameSite=Lax');
  return parts.join('; ');
}

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const [k, ...rest] = part.split('=');
    if (String(k || '').trim() !== name) continue;
    return rest.join('=').trim() || null;
  }
  return null;
}

function clearOauthCookies(headers) {
  headers.append('Set-Cookie', serializeCookie(OAUTH_STATE_COOKIE, '', { path: '/auth/callback', maxAge: 0 }));
  headers.append('Set-Cookie', serializeCookie(OAUTH_RETURN_TO_COOKIE, '', { path: '/auth/callback', maxAge: 0 }));
}

function validateReturnToOrThrow(rawReturnTo, env) {
  const allowedOrigins = getAllowedOrigins(env);
  if (!allowedOrigins.length) throw new Error('Missing ALLOWED_ORIGINS');
  if (allowedOrigins.includes('*')) {
    throw new Error('ALLOWED_ORIGINS must not include "*" when using OAuth redirects');
  }

  const candidate = String(rawReturnTo || '').trim() || allowedOrigins[0];
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Invalid return_to URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Invalid return_to protocol');
  }
  if (!allowedOrigins.includes(parsed.origin)) {
    throw new Error(`Disallowed return_to origin: ${parsed.origin}`);
  }
  return parsed.toString();
}

function redirectToApp(returnTo, { token = null, error = null } = {}, headers = null) {
  const dest = new URL(returnTo);
  const hashParams = new URLSearchParams(String(dest.hash || '').replace(/^#/, ''));
  hashParams.set(APP_AUTH_FLAG_PARAM, '1');
  if (token) hashParams.set(APP_AUTH_TOKEN_PARAM, token);
  if (error) hashParams.set(APP_AUTH_ERROR_PARAM, error);
  dest.hash = hashParams.toString();

  const h = new Headers(headers || undefined);
  h.set('Location', dest.toString());
  h.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers: h });
}

function handleLogin(request, url, env) {
  const returnTo = validateReturnToOrThrow(url.searchParams.get('return_to'), env);
  const state = crypto.randomUUID();
  const redirectUri = `${url.origin}/auth/callback`;

  const authUrl = new URL(GITHUB_AUTH_URL);
  authUrl.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);

  const headers = new Headers();
  headers.set('Location', authUrl.toString());
  headers.set('Cache-Control', 'no-store');
  headers.append('Set-Cookie', serializeCookie(OAUTH_STATE_COOKIE, state, { path: '/auth/callback', maxAge: OAUTH_COOKIE_MAX_AGE_S }));
  headers.append('Set-Cookie', serializeCookie(OAUTH_RETURN_TO_COOKIE, encodeURIComponent(returnTo), { path: '/auth/callback', maxAge: OAUTH_COOKIE_MAX_AGE_S }));

  return new Response(null, { status: 302, headers });
}

/**
 * OAuth callback - exchanges code for token
 */
async function handleCallback(request, url, env) {
  const headers = new Headers();
  clearOauthCookies(headers);

  const rawReturnTo = getCookie(request, OAUTH_RETURN_TO_COOKIE);
  const decodedReturnTo = rawReturnTo ? decodeURIComponent(rawReturnTo) : '';
  const returnTo = (() => {
    try {
      return validateReturnToOrThrow(decodedReturnTo, env);
    } catch {
      return validateReturnToOrThrow('', env);
    }
  })();

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const errorDescription = url.searchParams.get('error_description');
  const returnedState = String(url.searchParams.get('state') || '').trim();
  const expectedState = String(getCookie(request, OAUTH_STATE_COOKIE) || '').trim();

  if (error) {
    const msg = String(errorDescription || error).trim();
    return redirectToApp(returnTo, { error: `GitHub error: ${msg || 'OAuth failed'}` }, headers);
  }

  if (!code) {
    return redirectToApp(returnTo, { error: 'Missing authorization code' }, headers);
  }

  if (!returnedState || !expectedState || returnedState !== expectedState) {
    return redirectToApp(returnTo, { error: 'Invalid OAuth state' }, headers);
  }

  // Exchange code for token
  const redirectUri = `${url.origin}/auth/callback`;
  const tokenRes = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const tokenData = await tokenRes.json();

  if (tokenData.error || !tokenData.access_token) {
    const msg = String(tokenData.error_description || tokenData.error || 'Token exchange failed').trim();
    return redirectToApp(returnTo, { error: msg }, headers);
  }

  return redirectToApp(returnTo, { token: tokenData.access_token }, headers);
}

/**
 * Get authenticated user info
 */
async function handleGetUser(request, corsHeaders) {
  const token = getTokenFromRequest(request);
  if (!token) {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  const res = await githubFetch('/user', token);
  const data = await res.json();
  return jsonResponse(data, res.status, corsHeaders);
}

/**
 * Get user's app installations
 */
async function handleGetInstallations(request, corsHeaders) {
  const token = getTokenFromRequest(request);
  if (!token) {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  const res = await githubFetch('/user/installations', token);
  const data = await res.json();
  return jsonResponse(data, res.status, corsHeaders);
}

/**
 * Get installation access token for a specific installation
 * POST /auth/installation-token { installation_id: 123 }
 */
async function handleGetInstallationToken(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  const userToken = getTokenFromRequest(request);
  if (!userToken) {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  const body = await request.json();
  const installationId = body.installation_id;

  if (!installationId) {
    return jsonResponse({ error: 'Missing installation_id' }, 400, corsHeaders);
  }

  // Verify user has access to this installation
  const installRes = await githubFetch('/user/installations', userToken);
  const installData = await installRes.json();

  const hasAccess = installData.installations?.some(i => i.id === installationId);
  if (!hasAccess) {
    return jsonResponse({ error: 'No access to this installation' }, 403, corsHeaders);
  }

  // Generate JWT and get installation token
  const jwt = await createAppJwt(env);
  const tokenRes = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Cellucid-GitHub-App',
    },
  });

  const tokenData = await tokenRes.json();
  return jsonResponse(tokenData, tokenRes.status, corsHeaders);
}

/**
 * Get repositories for an installation
 * POST /auth/installation-repos { installation_id: 123 }
 */
async function handleGetInstallationRepos(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  const userToken = getTokenFromRequest(request);
  if (!userToken) {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  const body = await request.json();
  const installationId = body.installation_id;

  if (!installationId) {
    return jsonResponse({ error: 'Missing installation_id' }, 400, corsHeaders);
  }

  // Get repos accessible to user for this installation
  const res = await githubFetch(
    `/user/installations/${installationId}/repositories`,
    userToken
  );

  const data = await res.json();
  return jsonResponse(data, res.status, corsHeaders);
}

// =============================================================================
// API PROXY
// =============================================================================

/**
 * Proxy requests to GitHub API
 * Supports both user tokens and installation tokens
 */
async function handleApiProxy(request, url, env, corsHeaders) {
  const token = getTokenFromRequest(request);
  const githubPath = url.pathname.replace('/api', '');

  const githubUrl = new URL(githubPath, GITHUB_API);
  githubUrl.search = url.search;

  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Cellucid-GitHub-App',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let body = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    body = await request.text();
    if (body) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const res = await fetch(githubUrl.toString(), {
    method: request.method,
    headers,
    body,
  });

  const data = await res.text();

  return new Response(data, {
    status: res.status,
    headers: {
      ...corsHeaders,
      'Content-Type': res.headers.get('Content-Type') || 'application/json',
    },
  });
}

// =============================================================================
// HELPERS
// =============================================================================

function getTokenFromRequest(request) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  return null;
}

async function githubFetch(path, token) {
  return fetch(`${GITHUB_API}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Cellucid-GitHub-App',
    },
  });
}

function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Create JWT for GitHub App authentication
 * Used to generate installation tokens
 */
async function createAppJwt(env) {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  const payload = {
    iat: now - 60,           // Issued 60 seconds ago (clock skew)
    exp: now + (10 * 60),    // Expires in 10 minutes
    iss: env.GITHUB_APP_ID,  // App ID
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  // Import private key and sign
  const privateKey = await importPrivateKey(env.GITHUB_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signatureInput)
  );

  const encodedSignature = base64UrlEncode(signature);
  return `${signatureInput}.${encodedSignature}`;
}

async function importPrivateKey(pem) {
  // Remove PEM header/footer and newlines
  const pemContents = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, '')
    .replace(/-----END RSA PRIVATE KEY-----/, '')
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');

  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  return crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

function base64UrlEncode(data) {
  let base64;
  if (typeof data === 'string') {
    base64 = btoa(data);
  } else {
    // ArrayBuffer
    base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}