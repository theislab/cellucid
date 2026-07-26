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
  config.schema.json
  schema.json
  users/
    (one JSON file per contributor)
  moderation/
    merges.schema.json
    merges.json   (optional; written by authors via Cellucid)
.github/
  workflows/
    validate.yml        (recommended)
scripts/
  validate_user_files.py
```

The folder `cellucid-annotation/` in this workspace is a ready-to-use template you can copy into a new GitHub repo.

## Setup

### 1) Create or prepare the repo

Option A (recommended):
1. Create a new GitHub repository (public or private).
2. Copy the contents of `cellucid-annotation/` into the root of that repo.
3. Update `annotations/config.json`:
   - Add one complete entry per dataset id in `supportedDatasets`
   - Set a nonempty `name`
   - Set a nonempty `fieldsToAnnotate` array of categorical obs field keys
   - Set exactly one `annotatableSettings` object per listed field, containing
     `minAnnotators` and `threshold`
   - Set `closedFields` to a unique subset of `fieldsToAnnotate`; use `[]` when
     no fields are closed
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

### Dataset mismatch behavior

If the dataset currently loaded in Cellucid is not listed in `annotations/config.json` for the connected repo:

- **Annotators** are blocked (no Pull / no viewing or downloading annotations).
- **Authors** can connect anyway (with a confirmation) to update settings, then **Publish**.
  - After the author selects at least one annotatable field and supplies the
    complete settings, Publish adds or updates the `supportedDatasets[]` entry
    for the current dataset id in `annotations/config.json`.
  - Annotators are unblocked after this is published.

### Shareable links

You can share a link that pre-selects the annotation repo:

- `?annotations=owner/repo`
- `?annotations=owner/repo@branch`

## Permissions model

### Read access (Pull)

- Any signed-in user can Pull from repos where the app is installed for them.

### Write access (Publish)

- With **push** access to the connected branch, Cellucid writes directly to:
  - `annotations/users/ghid_<your-github-user-id>.json`
- Without source-repository write access, Cellucid uses the
  **fork + Pull Request** route only when GitHub reports that the source
  repository permits forking.

Cellucid selects `direct` or `fork-pull-request` before the first repository
mutation. A failure is reported on that selected route and never changes the
operation into the other route.

Fork + PR notes:
- The GitHub App needs Administration write, Contents read/write, and Pull
  requests write permissions.
- GitHub requires the app on the source account with access to the source repo
  and on the destination account with access to all repositories.
- The source repository must permit forking.

## Author vs Annotator

- **Annotator**: can Pull and submit their own
  `annotations/users/ghid_<id>.json` through the direct or Pull Request path
  selected by their exact GitHub permissions.
- **Author** (**maintain/admin** access to repo): additionally can:
  - Control which categorical obs columns are annotatable (stored in `annotations/config.json`)
  - Set per-field consensus settings (`minAnnotators`, `threshold`) and optionally close fields (`closedFields`)
  - Merge suggestions (stored in `annotations/moderation/merges.json`; votes are summed; merge notes are recorded and editable)

In the Cellucid UI, **Publish** (for authors) pushes:
- Your user file (`annotations/users/ghid_<id>.json`)
- The current annotatable settings (`annotations/config.json`)
- Any recorded merges (`annotations/moderation/merges.json`)

## Timestamps and edits

- Suggestions in `annotations/users/ghid_<id>.json` always have `proposedAt`, and may have `editedAt` if you edit the suggestion later.
- Comments always have `createdAt`, and may have `editedAt` if you edit the comment later.
- Moderation merges in `annotations/moderation/merges.json` always have `at`, and may have `editedAt` if you edit the merge note later; `by` is stored as `ghid_<githubUserId>`.

## Bucket keys (Developer note)

In `annotations/users/ghid_<id>.json`, the `suggestions` and `deletedSuggestions` maps are keyed by a **bucket key**:

- Format: `<fieldKey>:<categoryLabel>`
- If `fieldKey` contains `:`, Cellucid encodes it as `fk~<urlencoded>` to keep the delimiter unambiguous.
  - Example: `fieldKey="celltype:coarse"` → bucket key starts with `fk~celltype%3Acoarse:...`

## Token Storage (Security)

- Tokens are stored only in `sessionStorage` (cleared on tab close).
- No tokens are written to `localStorage`.

## GitHub Actions (Recommended)

The template includes:

- `validate.yml`: tests the validator and validates the current schemas,
  `annotations/config.json`, every `annotations/users/*.json`, and the optional
  `annotations/moderation/merges.json`

Validation is exact and all-or-nothing: unknown fields, wrong JSON types,
duplicate JSON keys, invalid filenames or ownership, malformed timestamps,
missing settings, duplicate mappings, cycles, and values over the declared
limits fail the workflow. Nothing is truncated, coerced, migrated, skipped, or
repaired.

Repository JSON must be UTF-8 without a byte-order mark. GitHub blob responses
must use the API's `base64` encoding, and a truncated Git tree fails Pull rather
than compiling only the returned prefix. Suggestion ids must remain globally
unambiguous across contributors: the same id cannot identify suggestions owned
by different users or stored in different buckets.

### About consensus compilation

This template does **not** commit a pre-merged consensus artifact (like `merged.json`) to the repo.

Instead, on **Pull** Cellucid:

- Lists `annotations/users/*.json` and the optional `annotations/moderation/merges.json`
- Downloads only files whose GitHub `sha` changed since your last Pull (cached locally per `datasetId + owner/repo@branch + user.id`)
- Compiles the merged suggestions + consensus view in the browser

The browser enforces the same current contract before changing cache or session
state. One invalid remote document fails the Pull; Cellucid never compiles a
partial set.

The raw-file cache requires both IndexedDB and localStorage. If either storage
boundary is unavailable, corrupt, or cannot persist a write, Cellucid reports
the failure and disconnects the annotation scope; it does not switch to an
in-memory cache.

From the sidebar you can download a locally-built
`cellucid-consensus.json` snapshot for downstream usage.

---

## GitHub App Authentication Setup (How Cellucid Signs In)

This section explains the GitHub authentication infrastructure used by the Cellucid UI when you click **Sign in** in the Community Annotation panel.

### The Worker (Auth + API Proxy)

By default, Cellucid uses a Cloudflare Worker named:

- Worker name: `cellucid-github-auth`
- Worker endpoint: `https://cellucid-github-auth.benkemalim.workers.dev`

This worker is an **auth proxy**:

- `/auth/login` starts the GitHub OAuth flow for the **Cellucid GitHub App**
- `/auth/callback` completes OAuth state and PKCE validation
- `/auth/user`, `/auth/installations`, `/auth/installation-repos` expose minimal “who am I” + “which repos did I install the app on” queries
- `/api/repos/*` proxies the repository requests used by Cellucid to
  `api.github.com/repos/*`

### Why This Is Safer Than PATs

Compared to Personal Access Tokens, the GitHub App model:

- Lets users install the app on **only specific repos**
- Avoids asking for broad OAuth scopes like full `repo` access
- Keeps the GitHub App client secret in Cloudflare Worker secrets
- Constrains each user token to the intersection of the app's permissions and
  the signed-in user's permissions

### Security Notes (Frontend + Worker)

Cellucid is designed so your GitHub credentials and tokens are not casually exposed:

- The Cellucid UI never asks you to paste a token (no PAT handling in the UI).
- The OAuth access token is stored only in `sessionStorage` (cleared when the tab closes).
- All GitHub REST calls are sent through the worker using `Authorization: Bearer <token>`.
- The worker uses `ALLOWED_ORIGINS` to restrict which website origins can call it (CORS allowlist).

### Self-Hosting / Using Your Own Worker

If you want to run your own worker + GitHub App (recommended for organizations), follow:

- `docs/github-oauth-cloudflare-setup.md`

For production, set the exact `DEFAULT_WORKER_ORIGIN` in
`assets/js/app/community-annotations/github-auth.js`, rebuild Cellucid, and
deploy the rebuilt site.

Local development pages may set
`window.__CELLUCID_GITHUB_WORKER_ORIGIN__` to an exact HTTP(S) origin before
Cellucid's application modules load.

Notes:

- Non-local builds refuse a runtime origin different from the compiled
  `DEFAULT_WORKER_ORIGIN`.
- The Worker `ALLOWED_ORIGINS` secret must contain the exact Cellucid page
  origin.
- The self-hosting guide includes the GitHub App permissions, token-expiration
  setting, required Worker secrets, deploy commands, executable contract tests,
  live acceptance test, and exact failure diagnosis.

This lets you keep the same repo template and UI while controlling the auth infrastructure.
