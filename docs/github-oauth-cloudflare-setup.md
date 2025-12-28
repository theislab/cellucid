# GitHub OAuth + Cloudflare Worker Setup (Cellucid Community Annotations)

Cellucid’s community annotation UI uses a Cloudflare Worker as an **auth + GitHub API proxy** so the frontend never needs GitHub App secrets.

This doc describes what you need to self-host that worker for your own domain/org.

## Overview

- Cellucid UI calls the worker:
  - `/auth/login` → GitHub OAuth redirect
  - `/auth/callback` → exchanges code → returns token to the UI (URL fragment)
  - `/auth/user`, `/auth/installations`, `/auth/installation-repos` → minimal identity/repo discovery
  - `/api/*` → proxies `https://api.github.com/*`
- The UI stores the OAuth token in `sessionStorage` only.

## Prerequisites

- A GitHub App (not a PAT) with OAuth enabled.
- A Cloudflare account + Workers deployment (e.g. `wrangler`).
- Your Cellucid site origin(s) you want to allow (prod + staging + local dev).

## Worker configuration

The worker needs these environment variables (Cloudflare secrets recommended):

- `ALLOWED_ORIGINS`: comma-separated allowlist of site origins, e.g. `https://www.cellucid.com,https://staging.cellucid.com`
- `GITHUB_APP_ID`: GitHub App numeric id (used for installation JWT)
- `GITHUB_PRIVATE_KEY`: GitHub App private key (PEM)
- `GITHUB_CLIENT_ID`: GitHub App OAuth client id
- `GITHUB_CLIENT_SECRET`: GitHub App OAuth client secret

Reference implementation (dev-only copy) lives at `cellucid/assets/js/app/community-annotations/_worker-code.js`.

## GitHub App notes

Your GitHub App must be able to support the UI flows Cellucid uses:

- Read repo info + permissions (role inference)
- Read git tree/blobs and repo contents (`annotations/**`)
- Write repo contents for direct publish (user files + author files)
- Create forks and Pull Requests for PR-based publish

Use the minimum permissions necessary for your org’s policy and verify by running:

- Sign in → Choose repo → Pull → Publish (direct + PR fallback).

## Point Cellucid at your worker

- **Production builds**: set `DEFAULT_WORKER_ORIGIN` in `cellucid/assets/js/app/community-annotations/github-auth.js` and rebuild/deploy Cellucid.
- **Local dev**: you may set `window.__CELLUCID_GITHUB_WORKER_ORIGIN__ = 'https://your-worker.example.workers.dev'`.
  - Non-local builds intentionally refuse untrusted overrides to prevent token exfiltration.

## Troubleshooting

- **CORS / “couldn’t reach GitHub sign-in server”**: ensure your current site origin is listed in `ALLOWED_ORIGINS`.
- **OAuth redirect rejected**: verify the GitHub App callback URL points to `https://<your-worker-origin>/auth/callback`.
- **Publishing denied**:
  - If you have push access, ensure the app is installed on the repo and has contents write permissions.
  - Otherwise ensure forking is enabled; Cellucid will fall back to fork + PR.

