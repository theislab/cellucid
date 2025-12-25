# GitHub App + Cloudflare Worker Setup Guide

This document describes setting up GitHub App authentication for Cellucid's community annotations feature.

## Why GitHub App (not OAuth App)?

| Feature | OAuth App | GitHub App |
|---------|-----------|------------|
| Repo access | All or nothing | User chooses specific repos |
| Permissions | Coarse (repo = everything) | Fine-grained (read-only contents, etc.) |
| Private repos | Requires full `repo` scope | Works with minimal permissions |
| User experience | "Access all your repos" | "Install on these repos" |

---

## Overview

```
┌─────────────┐     ┌──────────────────┐     ┌────────────┐
│  Cellucid   │────▶│ Cloudflare Worker│────▶│   GitHub   │
│  Frontend   │◀────│  (Auth Proxy)    │◀────│    API     │
└─────────────┘     └──────────────────┘     └────────────┘
```

**Flow:**
1. User clicks "Sign in with GitHub"
2. Popup opens → GitHub login/authorization
3. User installs app on specific repos (first time only)
4. Token returned to frontend
5. Frontend can now access those repos via the worker

---

## Part 1: Create Cloudflare Worker

### Step 1.1: Create Cloudflare Account
1. Go to https://dash.cloudflare.com
2. Sign up or log in

### Step 1.2: Create Worker
1. Left sidebar → **Workers & Pages**
2. Click **Create** → **Create Worker**
3. Select **"Start with Hello World!"**
4. Change name to: `cellucid-github-auth`
5. Click **Deploy**

### Step 1.3: Note Your Worker URL
```
https://cellucid-github-auth.benkemalim.workers.dev
```

---

## Part 2: Create GitHub App

### Step 2.1: Go to GitHub App Settings
1. Go to https://github.com/settings/apps
2. Click **New GitHub App**

### Step 2.2: Fill in Basic Information

| Field | Value |
|-------|-------|
| GitHub App name | `Cellucid Community Annotations` |
| Description | `Enables community annotations for single-cell datasets` |
| Homepage URL | `https://cellucid.com` |

### Step 2.3: Identifying and authorizing users

| Field | Value |
|-------|-------|
| Callback URL | `https://cellucid-github-auth.benkemalim.workers.dev/auth/callback` |
| ✅ Expire user authorization tokens | Checked (recommended) |
| ✅ Request user authorization (OAuth) during installation | Checked |
| ☐ Enable Device Flow | Unchecked |

### Step 2.4: Post installation

| Field | Value |
|-------|-------|
| Setup URL (optional) | Leave empty |
| ☐ Redirect on update | Unchecked |

### Step 2.5: Webhook

| Field | Value |
|-------|-------|
| ✅ Active | **Uncheck this** (we don't need webhooks) |
| Webhook URL | Leave empty |

### Step 2.6: Permissions

Click **Repository permissions** and set:

| Permission | Access |
|------------|--------|
| **Contents** | **Read and write** |
| **Metadata** | **Read-only** (auto-selected) |
| **Pull requests** | **Read and write** |

Leave all other permissions as "No access".

**Explanation:**
- **Contents**: Read files, write annotation files
- **Metadata**: Basic repo info (required)
- **Pull requests**: Create PRs for contributors without write access

### Step 2.7: Where can this GitHub App be installed?

Select: **Any account**

(This allows other users to install it on their repos)

### Step 2.8: Create the App

Click **Create GitHub App**

---

## Part 3: Get App Credentials

After creating the app, you'll be on the app settings page.

### Step 3.1: Note the App ID
At the top of the page, find and copy:
- **App ID**: (a number like `123456`)

### Step 3.2: Get Client ID and Secret
Scroll to **"Client secrets"** section (under "Client ID"):
1. Copy the **Client ID** (starts with `Iv1.` or `Iv23.`)
2. Click **Generate a new client secret**
3. Copy the **Client Secret** immediately (only shown once!)

### Step 3.3: Generate Private Key
Scroll to **"Private keys"** section:
1. Click **Generate a private key**
2. A `.pem` file will download
3. Keep this file safe - you'll need its contents

### Step 3.4: Save All Credentials

You should now have:
```
App ID:          123456
Client ID:       Iv1.abc123...
Client Secret:   secret123...
Private Key:     (contents of .pem file)
```

---

## Part 4: Configure Cloudflare Worker Secrets

### Step 4.1: Go to Worker Settings
1. Cloudflare Dashboard → Workers & Pages
2. Click `cellucid-github-auth`
3. Go to **Settings** → **Variables and Secrets**

### Step 4.2: Add Variables

Add these **5 variables** (all as Type: `Secret`):

| Variable name | Value |
|---------------|-------|
| `GITHUB_APP_ID` | Your App ID (e.g., `123456`) |
| `GITHUB_CLIENT_ID` | Your Client ID (e.g., `Iv1.abc123...`) |
| `GITHUB_CLIENT_SECRET` | Your Client Secret |
| `GITHUB_PRIVATE_KEY` | Contents of .pem file (paste entire file including BEGIN/END lines) |
| `ALLOWED_ORIGINS` | `https://cellucid.com,https://www.cellucid.com` |

### Step 4.3: Save
Click **Save** or **Deploy**

---

## Part 5: Deploy Worker Code

### Step 5.1: Edit Worker Code
1. Go to your worker → **Edit Code** (or Quick Edit)
2. Delete all existing code
3. Paste the code below
4. Click **Save and deploy**

### Step 5.2: Worker Code

```javascript
/**
 * Cloudflare Worker: GitHub App Auth for Cellucid
 *
 * Handles:
 * - User authentication via GitHub App OAuth
 * - Installation token generation for repo access
 * - API proxying with proper authentication
 */

const GITHUB_API = 'https://api.github.com';
const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

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
        '/auth/login': () => handleLogin(url, env),
        '/auth/callback': () => handleCallback(url, env, corsHeaders),
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
  const allowedOrigins = (env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim());
  const isAllowed = allowedOrigins.includes('*') || allowedOrigins.includes(origin);

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigins[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}

// =============================================================================
// AUTH ROUTES
// =============================================================================

/**
 * Start OAuth flow - redirects to GitHub
 */
function handleLogin(url, env) {
  const redirectUri = `${url.origin}/auth/callback`;

  const authUrl = new URL(GITHUB_AUTH_URL);
  authUrl.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', crypto.randomUUID());

  return Response.redirect(authUrl.toString(), 302);
}

/**
 * OAuth callback - exchanges code for token
 */
async function handleCallback(url, env, corsHeaders) {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    return createCallbackHtml({ error: `GitHub error: ${error}` }, corsHeaders);
  }

  if (!code) {
    return createCallbackHtml({ error: 'Missing authorization code' }, corsHeaders);
  }

  // Exchange code for token
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
    }),
  });

  const tokenData = await tokenRes.json();

  if (tokenData.error) {
    return createCallbackHtml({ error: tokenData.error_description || tokenData.error }, corsHeaders);
  }

  return createCallbackHtml({
    token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_in: tokenData.expires_in,
  }, corsHeaders);
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

/**
 * Create HTML response that posts result to opener window
 */
function createCallbackHtml(data, corsHeaders) {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Cellucid Auth</title>
  <style>
    body {
      font-family: system-ui, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #0d1117;
      color: #c9d1d9;
    }
    .message { text-align: center; padding: 2rem; }
    .error { color: #f85149; }
    .success { color: #3fb950; }
  </style>
</head>
<body>
  <div class="message">
    <div id="status">Completing authentication...</div>
  </div>
  <script>
    const data = ${JSON.stringify(data)};

    if (window.opener) {
      window.opener.postMessage({ type: 'cellucid-github-auth', ...data }, '*');
      document.getElementById('status').innerHTML =
        '<span class="success">Authentication complete. This window will close.</span>';
      setTimeout(() => window.close(), 1000);
    } else {
      document.getElementById('status').innerHTML = data.error
        ? '<span class="error">Error: ' + data.error + '</span>'
        : '<span class="success">Authentication successful. You can close this window.</span>';
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { ...corsHeaders, 'Content-Type': 'text/html' },
  });
}
```

---

## Part 6: Test the Setup

### Step 6.1: Test Worker Health
Open in browser:
```
https://cellucid-github-auth.benkemalim.workers.dev/
```

Should return JSON with status "ok".

### Step 6.2: Test Login Flow
Open in browser:
```
https://cellucid-github-auth.benkemalim.workers.dev/auth/login
```

Should redirect to GitHub authorization page showing:
- Your app name
- **Only the permissions you configured** (Contents, Metadata, Pull requests)
- Option to select which repos to install on

### Step 6.3: Test from Cellucid
Open https://cellucid.com, open browser console, run:

```javascript
// Listen for auth result
window.addEventListener('message', (e) => {
  if (e.data.type === 'cellucid-github-auth') {
    console.log('Auth result:', e.data);
    if (e.data.token) {
      // Test: get user info
      fetch('https://cellucid-github-auth.benkemalim.workers.dev/auth/user', {
        headers: { 'Authorization': `Bearer ${e.data.token}` }
      })
      .then(r => r.json())
      .then(user => console.log('User:', user));
    }
  }
});

// Open login popup
window.open(
  'https://cellucid-github-auth.benkemalim.workers.dev/auth/login',
  'github-auth',
  'width=600,height=700'
);
```

---

## Part 7: Understanding the Flow

### User Authentication Flow
```
1. Frontend calls /auth/login
2. User redirected to GitHub
3. User authorizes app (first time: also installs on repos)
4. GitHub redirects to /auth/callback with code
5. Worker exchanges code for user token
6. Token sent to frontend via postMessage
```

### Accessing Repos Flow
```
1. Frontend calls /auth/installations with user token
2. Gets list of installations (where user installed the app)
3. Frontend calls /auth/installation-repos with installation_id
4. Gets list of repos in that installation
5. Frontend calls /api/repos/{owner}/{repo}/contents/...
   with user token to read/write files
```

---

## API Reference

### Authentication

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/login` | GET | Start OAuth flow (redirects to GitHub) |
| `/auth/callback` | GET | OAuth callback (handled automatically) |
| `/auth/user` | GET | Get authenticated user info |
| `/auth/installations` | GET | List user's app installations |
| `/auth/installation-repos` | POST | List repos for an installation |
| `/auth/installation-token` | POST | Get installation token (for app-level API access) |

### API Proxy

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/*` | ANY | Proxies to `api.github.com/*` with auth |

**Examples:**
```
GET /api/user                           → GET api.github.com/user
GET /api/repos/owner/repo/contents/path → GET api.github.com/repos/owner/repo/contents/path
PUT /api/repos/owner/repo/contents/path → PUT api.github.com/repos/owner/repo/contents/path
```

---

## Configuration Summary

### Worker URL
```
https://cellucid-github-auth.benkemalim.workers.dev
```

### GitHub App Settings
- **App settings**: https://github.com/settings/apps/cellucid-community-annotations
- **Callback URL**: `https://cellucid-github-auth.benkemalim.workers.dev/auth/callback`

### Cloudflare Secrets
| Name | Description |
|------|-------------|
| `GITHUB_APP_ID` | App ID from GitHub App settings |
| `GITHUB_CLIENT_ID` | Client ID from GitHub App settings |
| `GITHUB_CLIENT_SECRET` | Generated client secret |
| `GITHUB_PRIVATE_KEY` | Contents of downloaded .pem file |
| `ALLOWED_ORIGINS` | Comma-separated allowed origins |

---

## Troubleshooting

### "redirect_uri mismatch"
- Check callback URL in GitHub App matches exactly:
  `https://cellucid-github-auth.benkemalim.workers.dev/auth/callback`

### "Bad credentials"
- Verify GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are correct
- Check secrets were saved in Cloudflare

### "Could not verify JWT"
- Private key may be malformed
- Make sure you pasted the ENTIRE .pem file including `-----BEGIN/END-----` lines

### CORS errors
- Check ALLOWED_ORIGINS includes your frontend domain
- Make sure there are no trailing slashes

---

## Security Notes

1. **User tokens** are short-lived (8 hours) and can be refreshed
2. **Installation tokens** expire in 1 hour
3. **Private key** never leaves Cloudflare Worker
4. **Client secret** never exposed to frontend
5. Users can revoke access anytime from GitHub settings

---

## Next Steps

After testing works:
1. Integrate into Cellucid frontend (replace PAT input)
2. Build repo selection UI
3. Implement annotation read/write via API proxy
4. Add branch/PR flow for contributors without write access

---

*Setup guide created: 2025-12-24*
*Auth method: GitHub App (not OAuth App)*
