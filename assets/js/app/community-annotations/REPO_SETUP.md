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
     - A colon-free raw field key must not start with exact lowercase `fk~` and
       also contain `%3A` or `%3a`; that narrow form is reserved for Cellucid's
       bucket encoding. Similar keys such as `fk~field`, `FK~field%3Aname`,
       `field%3Aname`, and `fk~field%253Aname` remain valid.
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
- Cellucid verifies that the signed-in user's same-name repository is an exact
  fork of the connected source before using it. If that fork was renamed,
  Cellucid attempts creation first, then searches at most the newest 1,000
  source forks for 10 seconds. If GitHub cannot expose the renamed fork within
  that bound, rename it to the source repository name and publish again.

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
- Category labels may contain `:` and remain exact.
- To keep local `<bucket>:<suggestionId>` vote keys unambiguous, suggestion ids
  must not contain the ASCII `:` character. This applies to suggestion
  definitions and every reference in `votes`, `comments`,
  `deletedSuggestions`, and moderation `fromSuggestionId` /
  `intoSuggestionId`. A literal string such as `suggestion%3A1` is valid;
  comment ids and ontology ids are separate fields and may contain `:`.

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

Every active annotation JSON file has an exact maximum of **1,000,000 UTF-8
bytes**, matching the GitHub Contents API boundary at which the complete
JSON/base64 contract is available. Cellucid checks canonical publication bytes
before each mutation request; user-file publication performs this check before
its authentication lookup, while config publication first needs the bounded
remote config in order to construct the final document. Pull and reconciliation
also check decoded remote bytes. If an active file approaches the limit, archive
historical material outside `annotations/`, then reduce obsolete suggestions,
votes, or comments while preserving a valid current document; never rely on
truncation. See GitHub's
[repository Contents API](https://docs.github.com/en/rest/repos/contents).

### About consensus compilation

This template does **not** commit a pre-merged consensus artifact (like `merged.json`) to the repo.

Instead, on **Pull** Cellucid:

- Lists `annotations/users/*.json` and the optional `annotations/moderation/merges.json`
- Downloads only files whose GitHub `sha` changed since your last Pull (cached locally per `datasetId + owner/repo@branch + user.id`)
- Compiles the merged suggestions + consensus view in the browser

The browser enforces the same current contract at every boundary. One invalid
remote document fails the Pull; Cellucid never compiles a partial set. Validated
changed raw files may be committed to the scoped cache before the complete
cached set is re-read and compiled. If that later complete-set or session
application fails, scoped cache recovery may retain the validated files or clear
a corrupt cache, but the visible session is restored exactly: moderation,
merged suggestions, settings, access metadata, and remote SHAs
publish synchronously through one session transaction and one change notification.

One Pull accepts at most **10,000 active user files** and **64,000,000 total
decoded UTF-8 bytes** across those files. The recursive tree's exact blob sizes
are checked before any user blob is downloaded and rechecked against every
fetched blob. The tree must prove an exact `annotations/users` inventory through
its directory entry or a valid direct child. The pristine template's one-byte
`annotations/users/.gitkeep` blob (Git SHA
`8b137891791fe96927ad78e64b0aad7bded08bdc`) is accepted only in that exact
form; it is never downloaded or included in user SHAs, counts, or decoded-byte
limits. An absent inventory or an inexact, renamed, or nested sentinel fails the
Pull. Unrelated valid Git submodules are ignored; a submodule or directory under
`annotations/users/` is invalid. If one concurrent blob fails, Cellucid stops
assigning work, cancels the rest of the active eight-request window, awaits its
settlement, and reports the first failure. Archive old user documents outside
`annotations/users/` or split the repository before retrying a Pull that
exceeds either aggregate limit.

The Worker streams successful Contents, Git blob, and recursive-tree responses
without first retaining their complete bodies in the shared isolate. It enforces
route-specific byte ceilings and UTF-8 validity while streaming; the browser
then applies duplicate-key, base64, tree, and annotation-schema validation
before admitting each changed document to the raw cache. After it verifies the
complete cached file set, visible session application is transactional and
cannot expose a partially applied Pull.

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

The deployed endpoint must advertise `"contractVersion": 1` and the exact route
inventory documented below. Cellucid performs that capability check before
OAuth or any token-bearing request and stops with a deployment-mismatch message
when the live Worker is older than the checked-in client. Increment the Worker
and client contract version together for a required semantic change that would
otherwise leave an older same-route deployment looking compatible.

This worker is an **auth and bounded data proxy**:

- `/auth/login` starts the GitHub OAuth flow for the **Cellucid GitHub App**
- `/auth/callback` completes OAuth state and PKCE validation
- `/auth/user`, `/auth/installations`, `/auth/installation-repos` expose minimal “who am I” + “which repos did I install the app on” queries
- `/api/repos/*` proxies the repository requests used by Cellucid to
  `api.github.com/repos/*`
- `/cap/lookup-cells` and `/cap/search-datasets` run only Cellucid's fixed
  persisted CAP operations and return bounded, minimal result projections

Every successful CAP response contains exactly the pinned contract version
alongside its data: `{ "contractVersion": 1, "results": [...],
"omittedInvalidCount": number }`. Lookup kinds map to fixed APQ search fields:
`name` and `feedback` use the default name search, `ontology` searches only
`ontologyTermId`, and `marker` searches only `markerGenes` and
`canonicalMarkerGenes`.

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
- The worker uses `ALLOWED_ORIGINS` as an exact browser CORS allowlist.
- Before OAuth or any token-bearing request, the UI verifies the Worker's exact
  current health contract version and route inventory with a bounded tokenless
  request and fails visibly if the deployment is stale.
- CAP searches never carry the GitHub token or cookies. They require an exact
  allowed browser origin, accept only the documented bounded search objects,
  and cannot forward arbitrary GraphQL.
- Name and ORCID profile autosuggestions send the trimmed field text to the
  public `pub.orcid.org` expanded-search endpoint after three typed characters.
  The browser omits credentials and the referrer, but the query leaves
  Cellucid; no GitHub token, annotation content, or CAP state is attached.
- A successful CAP preflight permits only `POST` and `Content-Type` and is
  cached for exactly 600 seconds; each actual request still rechecks Origin.

An `Origin` header is not authentication and can be forged by a non-browser
client. Fixed CAP operations prevent arbitrary GraphQL forwarding, but the CORS
allowlist does not prevent anonymous request or billing abuse. Public
deployments should apply a Cloudflare rate-limiting rule to `/cap/*` based on
expected interactive traffic and monitor usage without recording search text.

After every Worker deployment, verify the root response reports
`"contractVersion": 1`, then run these live UI smoke checks from an allowlisted
Cellucid origin:

1. Search CAP for `T cell` and confirm a bounded T-cell result.
2. Search Ontology for `CL:0000084` and confirm that exact ontology ID.
3. Search Markers for `CD3D` and confirm a result containing `CD3D` in its
   general or canonical markers.

### Self-Hosting / Using Your Own Worker

If you want to run your own worker + GitHub App (recommended for organizations), follow:

- `docs/github-oauth-cloudflare-setup.md`

The current strict Worker contract requires Cloudflare Workers Paid with the
Standard usage model; the checked-in Wrangler configuration owns the exact CPU
ceiling. A Free-plan deployment is not supported for the complete annotation
document boundary.

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
  origin. Production origins must use HTTPS; HTTP is accepted only for
  canonical loopback development hosts.
- The self-hosting guide includes the GitHub App permissions, token-expiration
  setting, required Worker secrets, deploy commands, executable contract tests,
  live acceptance test, and exact failure diagnosis.

This lets you keep the same repo template and UI while controlling the auth infrastructure.
