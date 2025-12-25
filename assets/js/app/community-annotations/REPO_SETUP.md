# Community Annotation Repo Setup (GitHub App Model)

Cellucid syncs community annotations via the GitHub REST API (contents endpoints) using **GitHub App authentication** (OAuth user tokens), proxied through a Cloudflare Worker.

- Users click **Sign in with GitHub** (no token paste)
- Repos are selectable only if the **Cellucid GitHub App is installed** on them
- Tokens are stored only in **sessionStorage** (cleared on tab close)

## Repo Requirements

Your annotation repository must contain:

```
annotations/
  config.json
  schema.json
  users/
    (one JSON file per contributor)
  consensus/
    merged.json   (optional; written by GitHub Actions)
  moderation/
    merges.json   (optional; written by authors via Cellucid)
.github/
  workflows/
    validate.yml        (recommended)
    build-consensus.yml (recommended)
scripts/
  validate_user_files.py
  build_consensus.py
```

The folder `cellucid-annotation/` in this workspace is a ready-to-use template you can copy into a new GitHub repo.

## Setup

### 1) Create or prepare the repo

Option A (recommended):
1. Create a new GitHub repository (public or private).
2. Copy the contents of `cellucid-annotation/` into the root of that repo.
3. Update `annotations/config.json`:
   - Set your dataset id in `supportedDatasets[].datasetId`
   - Optionally set `fieldsToAnnotate`
4. Commit and push.

Option B:
1. Add the required folders/files listed in “Repo Requirements”.
2. Commit and push.

### 2) Install the GitHub App on the repo owner (user/org)

Install the Cellucid GitHub App and grant it access to the annotation repo.

- For org repos: an org admin may need to approve the installation.
- If you choose “Only select repositories”, make sure the annotation repo is selected.

### 3) Connect from Cellucid

1. Load your dataset in Cellucid.
2. Open the **Community annotation** panel.
3. Click **Sign in**.
4. Click **Choose repo** and select the repo (only installed repos appear).
5. Click **Pull** to fetch latest annotations.
6. Make local changes, then **Publish**.

### Shareable links

You can share a link that pre-selects the annotation repo:

- `?annotations=owner/repo`
- `?annotations=owner/repo@branch`

## Permissions model

### Read access (Pull)

- Any signed-in user can Pull from repos where the app is installed for them.

### Write access (Publish)

- If you have **push** access to the repo, Cellucid writes directly to:
  - `annotations/users/{your-username}.json`
- If you do **not** have push access, Cellucid uses a **fork + Pull Request** flow.

Fork + PR notes:
- The fork must also be accessible to the GitHub App token.
- Easiest setup: install the app on your personal account with **All repositories**, so new forks are included automatically.

## Author vs Annotator

- **Annotator**: can Pull and submit their own `annotations/users/{username}.json` (direct push if allowed; otherwise fork + PR).
- **Author** (**maintain/admin** access to repo): additionally can:
  - Control which categorical obs columns are annotatable (stored in `annotations/config.json`)
  - Merge suggestions (stored in `annotations/moderation/merges.json`; votes are summed; history notes recorded)

In the Cellucid UI, **Publish** (for authors) pushes:
- Your user file (`annotations/users/{you}.json`)
- The current annotatable-column selection (`annotations/config.json`)
- Any recorded merges (`annotations/moderation/merges.json`)

## Token Storage (Security)

- Tokens are stored only in `sessionStorage` (cleared on tab close).
- No tokens are written to `localStorage`.

## GitHub Actions (Recommended)

The template includes:

- `validate.yml`: validates `annotations/config.json` and all `annotations/users/*.json`
- `build-consensus.yml`: builds `annotations/consensus/merged.json` on each push

These workflows run entirely in GitHub and keep the repo consistent for all collaborators.

---

## GitHub App Authentication Setup (How Cellucid Signs In)

This section explains the GitHub authentication infrastructure used by the Cellucid UI when you click **Sign in** in the Community Annotation panel.

### The Worker (Auth + API Proxy)

By default, Cellucid uses a Cloudflare Worker named:

- Worker name: `cellucid-github-auth`
- Worker endpoint: `https://cellucid-github-auth.benkemalim.workers.dev`

This worker is an **auth proxy**:

- `/auth/login` starts the GitHub OAuth flow for the **Cellucid GitHub App**
- `/auth/user`, `/auth/installations`, `/auth/installation-repos` expose minimal “who am I” + “which repos did I install the app on” queries
- `/api/*` proxies requests to `api.github.com/*` so the frontend never needs GitHub App secrets

### Why This Is Safer Than PATs

Compared to Personal Access Tokens, the GitHub App model:

- Lets users install the app on **only specific repos**
- Avoids asking for broad OAuth scopes like full `repo` access
- Keeps GitHub App secrets (client secret, private key) **server-side only** (Cloudflare Worker secrets)

### Security Notes (Frontend + Worker)

Cellucid is designed so your GitHub credentials and tokens are not casually exposed:

- The Cellucid UI never asks you to paste a token (no PAT handling in the UI).
- The OAuth access token is stored only in `sessionStorage` (cleared when the tab closes).
- All GitHub REST calls are sent through the worker using `Authorization: Bearer <token>`.
- The worker uses `ALLOWED_ORIGINS` to restrict which website origins can call it (CORS allowlist).

### Self-Hosting / Using Your Own Worker

If you want to run your own worker + GitHub App (recommended for organizations), follow:

- `cellucid/docs/github-oauth-cloudflare-setup.md`

Then configure Cellucid to point at your worker origin (build/deploy-time injection):

- `window.__CELLUCID_GITHUB_WORKER_ORIGIN__ = 'https://your-worker.example.workers.dev'`

This lets you keep the same repo template and UI while controlling the auth infrastructure.
