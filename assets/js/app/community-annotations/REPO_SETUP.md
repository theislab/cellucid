# Community Annotation Repo Setup (GitHub App Model)

Cellucid syncs community annotations with GitHub through a Cloudflare Worker,
using **GitHub App authentication** (OAuth user tokens): the GitHub REST API
for repository metadata, a users-folder listing, file contents and writes, and
two GraphQL reads the Worker writes itself (`/graphql/snapshot`,
`/graphql/blobs`).

- Users click **Continue with GitHub** (no token paste)
- Repos are selectable only if the **Cellucid GitHub App is installed** on them
- Tokens are stored only in **sessionStorage** (cleared on tab close) and
  expire after 8 hours

The complete user documentation is the
[community annotation guide](https://docs.cellucid.com/en/latest/user_guide/web_app/j_community_annotation/index.html);
this page is the developer summary.

## Repo Requirements

Your annotation repository must contain:

```
annotations/
  config.json
  config.schema.json
  schema.json
  users/
    .gitkeep            (one LF byte)
    (one ghid_<GitHub user id>.json per contributor)
  moderation/
    merges.schema.json
    merges.json         (optional; written by authors via Cellucid)
.github/
  workflows/
    validate.yml        (recommended)
scripts/
  validate_user_files.py
.gitattributes
```

[theislab/cellucid-annotation](https://github.com/theislab/cellucid-annotation)
is the template. Copy exactly these layout files from it, at the same paths:
`annotations/`, `scripts/validate_user_files.py`,
`.github/workflows/validate.yml` and `.gitattributes`. Its `tests/`,
`scripts/generate_contract_corpus.py`, `.github/workflows/tests.yml`, licence
and policy files test and govern the template itself and are not copied.

**The three schema files must be the template's, byte for byte.** Cellucid
identifies them by content: `ANNOTATION_SCHEMA_BLOB_OIDS` in
`wire-contract.js` holds their Git blob ids (user file version 3, merges
version 3, config version 1), and a Pull compares them with the blob ids the
repository snapshot names, without downloading the schemas. A schema that
differs stops the Pull with `COMMUNITY_ANNOTATION_REPOSITORY_LAYOUT_INVALID`
and a message naming the file to copy again. `.gitattributes` keeps every file
LF on every platform, so a Windows checkout commits the same bytes.

## Setup

### 1) Create or prepare the repo

1. Create a new GitHub repository (public or private).
2. Copy the layout files listed above into its root, unchanged.
3. Update `annotations/config.json`:
   - Add one complete entry per dataset id in `supportedDatasets`
   - Set a nonempty `name`
   - Set a nonempty `fieldsToAnnotate` array of categorical obs field keys
     - A colon-free raw field key must not start with exact lowercase `fk~` and
       also contain `%3A` or `%3a`; that narrow form is reserved for Cellucid's
       bucket encoding. Similar keys such as `fk~field`, `FK~field%3Aname`,
       `field%3Aname`, and `fk~field%253Aname` remain valid.
   - Set exactly one `annotatableSettings` object per listed field, containing
     `minAnnotators` (a whole number from 0 to 9,007,199,254,740,991) and
     `threshold` (-1 to 1)
   - Set `closedFields` to a unique subset of `fieldsToAnnotate`; use `[]` when
     no fields are closed
4. Run `python scripts/validate_user_files.py`, then commit and push.

### 2) Install the GitHub App on the repo owner (user/org)

Install the Cellucid GitHub App and grant it access to the annotation repo.

- For org repos: an org admin may need to approve the installation.
- If you choose “Only select repositories”, make sure the annotation repo is selected.

### 3) Connect from Cellucid

1. Load your dataset in Cellucid.
2. Open the **Community annotation** panel and click **Connect repo**.
3. Click **Continue with GitHub**.
4. Use **Add repo** and **Reload** if the repository is not listed, select it
   and click **Connect** (only installed repos appear).
5. Click **Pull latest** to fetch the latest annotations.
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
- The GitHub App needs Contents read/write, Pull requests read/write and
  Metadata read; no Administration. **Cellucid never creates a fork**
  (creating one through the API needs Administration write): the contributor
  forks the repository on GitHub (`https://github.com/<owner>/<repo>/fork`).
- The contributor installs the app on their own account with access to the
  fork: *All repositories*, or *Only select repositories* with the fork
  selected. A user token reaches only repositories in an account where the
  app is installed, and the head branch and the user file are written in the
  fork; the pull request is opened through the app's installation on the
  source repository.
- The source repository must permit forking.
- Cellucid verifies that the signed-in user's same-name repository is an exact
  fork of the connected source before using it; otherwise (renamed) it finds
  the fork among the source's forks (newest first, page by page). Without a
  fork, Publish stops with `You have no fork of <owner>/<repo> yet: fork it on
  GitHub, then Publish again.` and a **Fork on GitHub** link to
  `https://github.com/<owner>/<repo>/fork`. A fork whose branches GitHub has
  not copied yet (it copies a new fork asynchronously) stops Publish with
  `GitHub is still copying your fork <login>/<repo>; Publish again in a
  minute.`; there is no fixed wait. A fork the app cannot write to (403 or 404 on the fork's writes)
  says to install the app on the account with access to it (**Install the
  app**).
- **One head branch per contributor and base branch**,
  `cellucid-annotations/ghid_<id>/<hash of the base branch>`
  (`toAnnotationHeadBranch` in `github-sync.js`), so one contributor has one
  pull request per base branch carrying their whole user file (every dataset).
  Each Publish composes onto the open pull request's file (it holds sections
  not merged yet), else onto the base branch's file, **resets the head branch
  to the base branch's current tip** (created with `POST git/refs`, or moved
  with a forced `PATCH git/refs/heads/...`) and writes the file on it. The
  pull request's diff is that one file, and a squash-merged earlier pull
  request never makes it conflict. An open pull request is reused.

The Worker binds every write to the signed-in user (one
`GET https://api.github.com/user` before forwarding it): a user file
`annotations/users/ghid_<n>.json` only by user `n`; a branch under
`cellucid-annotations/` only as the user's own `cellucid-annotations/ghid_<id>/...`,
created or moved only in a repository the user owns; a pull request only from
such a branch. A refused write is `403` with outcome `not-applied`.

## Author vs Annotator

- **Annotator**: can Pull and submit their own
  `annotations/users/ghid_<id>.json` through the direct or Pull Request path
  selected by their exact GitHub permissions.
- **Author** (**maintain/admin** access to repo): additionally can:
  - Control which categorical obs columns are annotatable (stored in `annotations/config.json`)
  - Set per-field consensus settings (`minAnnotators`, `threshold`) and optionally close fields (`closedFields`)
  - Merge suggestions (stored in `annotations/moderation/merges.json`). Votes
    across a merged bundle are de-duplicated per user: a user's vote on the
    merge target wins, otherwise the majority of that user's votes on the
    members counts (a tie is no vote). Merge notes are recorded and editable.

In the Cellucid UI, **Publish** (for authors) pushes:
- Your user file (`annotations/users/ghid_<id>.json`)
- The current annotatable settings (`annotations/config.json`)
- Any recorded merges (`annotations/moderation/merges.json`)

## Timestamps and edits

- Suggestions in `annotations/users/ghid_<id>.json` always have `proposedAt`, and may have `editedAt` if you edit the suggestion later.
- Comments always have `createdAt`, and may have `editedAt` if you edit the comment later.
- Moderation merges in `annotations/moderation/merges.json` always have `at`, and may have `editedAt` if you edit the merge note later; `by` is stored as `ghid_<githubUserId>`.
- Every timestamp is UTC, `YYYY-MM-DDTHH:MM:SSZ` or `YYYY-MM-DDTHH:MM:SS.sssZ`,
  and is compared as a parsed instant.

## Per-dataset sections and suggestion ids (Developer note)

A repository can annotate several datasets, and two datasets can share a field
and a category label (`leiden` / `0`). So a user file (version 3) keeps the
profile once and everything else per dataset:

```json
{
  "version": 3,
  "username": "ghid_42",
  "githubUserId": 42,
  "updatedAt": "2026-10-22T10:00:00.000Z",
  "datasets": {
    "my_atlas_v1": {
      "fieldsToAnnotate": ["cell_type"],
      "lastAccessedAt": "2026-10-22T10:00:00.000Z",
      "suggestions": {
        "cell_type:T": [
          {
            "id": "ghid_42_3f2c9a4e-8b1d-4c7a-9e5f-0a6b2d1c4e8f",
            "label": "T cell",
            "proposedBy": "ghid_42",
            "proposedAt": "2026-10-22T10:00:00.000Z"
          }
        ]
      },
      "votes": { "ghid_42_3f2c9a4e-8b1d-4c7a-9e5f-0a6b2d1c4e8f": "up" },
      "comments": {},
      "deletedSuggestions": {}
    }
  }
}
```

and every merge in `annotations/moderation/merges.json` (version 3) names its
`datasetId`. For the open dataset Cellucid reads a user file's profile and
that dataset's section only (`projectUserFile`), and the merges of that
dataset (`projectMergesFile`); publishing replaces only that dataset's part of
a file (`composeUserFile`), and a contributor's other datasets are kept as they
were. The dataset id is the dataset's identity id (the id its AnnData file
states in `uns['cellucid']['id']`, else the stable id a data link gives a
file, such as `cellxgene:<dataset id>`), the same whether the dataset was
opened from a sample, a link, a server, a notebook or a local file.

**Suggestion ids name their owner:** `ghid_<id>_<rest>`, where the prefix is
the suggestion's own `proposedBy` followed by `_`, and `<rest>` is nonempty
exact text without `:` (Cellucid writes `${ownGhid}_${crypto.randomUUID()}`).
The digits of `ghid_<id>` end at that `_`, so `ghid_1_` never prefixes
`ghid_12_...`: no contributor can write an id that collides with, or claims to
be, another contributor's suggestion (`annotationSuggestionIdOwner` in
`wire-contract.js`). Votes, comments and merges may name anyone's suggestion;
`deletedSuggestions` names only the file owner's own.

**Equal labels are one suggestion.** Inside a bucket, after moderation merges,
suggestions whose labels are equal after `normalize('NFC')` (nothing else
folded) form one bundle: its main suggestion is the earliest proposed (then
the lowest id in code units), and each user's vote is the majority of that
user's votes across the bundle (a tie is no vote). `addSuggestion` and a
rename refuse a label already shown in the bucket under the same
normalization. A bucket with zero voters is always `pending`.

## Bucket keys (Developer note)

In a dataset's section of `annotations/users/ghid_<id>.json`, the `suggestions` and `deletedSuggestions` maps are keyed by a **bucket key**:

- Format: `<fieldKey>:<categoryLabel>`
- If `fieldKey` contains `:`, Cellucid encodes it as `fk~<urlencoded>` to keep the delimiter unambiguous.
  - Example: `fieldKey="celltype:coarse"` → bucket key starts with `fk~celltype%3Acoarse:...`
- Category labels may contain `:` and remain exact.
- To keep local `<bucket>:<suggestionId>` vote keys unambiguous, suggestion ids
  must not contain the ASCII `:` character. This applies to suggestion
  definitions and every reference in `votes`, `comments`,
  `deletedSuggestions`, and moderation `fromSuggestionId` /
  `intoSuggestionId`. Comment ids and ontology ids are separate fields and may
  contain `:`.

## Text, numbers and size (Developer note)

- **No text has a length limit**: labels, evidence, ontology ids, marker
  genes, comments, merge notes, profile fields, dataset ids and names, field
  keys and ids. Every text is exact: its first and last characters are not
  whitespace (`ANNOTATION_WHITESPACE_CLASS`, the union of ECMAScript `\s` and
  Python's `str.isspace()`, shared by the schemas, `wire-contract.js`,
  `session.js` and the validator), and it is never trimmed.
- **Integers** are at most 9,007,199,254,740,991 (`Number.MAX_SAFE_INTEGER`).
- **JSON nesting** is at most 512 levels in both validators, tied to Python's
  recursion limit; no valid file nests deeper than 7.
- **Every active annotation file is at most 1,000,000 UTF-8 bytes**
  (`ANNOTATION_FILE_MAX_UTF8_BYTES`), the most GitHub's
  [repository Contents API](https://docs.github.com/en/rest/repos/contents#get-repository-content)
  returns as JSON. One contributor's file holds every dataset they annotate in
  the repository. Cellucid checks canonical publication bytes before each
  mutation request; a Pull checks the size the tree states before reading a
  file. If an active file approaches the limit, archive historical material
  outside `annotations/`, then reduce obsolete suggestions, votes, or comments
  while preserving a valid current document; never rely on truncation.

## Token Storage (Security)

- Tokens are stored only in `sessionStorage` (cleared on tab close) with their
  expiry; the GitHub App must keep **Expire user authorization tokens** on (the
  Worker refuses a token that never expires).
- No tokens are written to `localStorage`.

## GitHub Actions (Recommended)

The template's `validate.yml` (the workflow authors copy) runs one command,
`python scripts/validate_user_files.py`, on every push and pull request with
`permissions: contents: read`. It needs nothing but the layout files. The
validator checks that the three schemas are the canonical ones byte for byte,
`annotations/config.json`, every entry under `annotations/users/` (only
`ghid_<id>.json` user files and the `.gitkeep` sentinel), the optional
`annotations/moderation/merges.json`, and that no path is a case variant of a
layout path (`annotations/Users/`). It reports every input as an error, never a
crash (huge integers and deep nesting included).

Validation is exact: unknown fields, wrong JSON types, duplicate JSON keys,
invalid filenames or ownership, malformed timestamps, missing settings,
duplicate mappings and cycles fail the workflow. Nothing is truncated, coerced,
migrated, skipped, or repaired. One shared accept/reject corpus
(`tests/fixtures/community-annotation-contract-corpus.json`, byte for byte the
template's `tests/fixtures/contract-corpus.json`, pinned by SHA-256 in both
suites) holds the validator and `wire-contract.js` to the same verdict.

CI is a gate for pull requests and a report for everything else: a direct
publish lands before CI runs. The browser therefore never trusts the
repository to be valid (next section).

### About consensus compilation

This template does **not** commit a pre-merged consensus artifact (like `merged.json`) to the repo.

Instead, on **Pull** Cellucid (`github-sync.js`, `openSnapshot` /
`validateAndLoadConfig` / `pullFiles`):

1. Asks the repository metadata with `If-None-Match` (an unchanged answer is a
   `304`).
2. Reads `POST /graphql/snapshot` at the resolved branch: the commit and every
   entry of `annotations/` and `annotations/moderation/` with its blob id and
   size. Everything after is read by object id from this one commit, never at
   the branch name, so one Pull never mixes two commits. When the
   `annotations` tree id equals the last completed Pull's (kept in IndexedDB
   per cache scope), nothing changed and the Pull stops there: one or two
   requests in all.
3. Checks the three schema blob ids against `ANNOTATION_SCHEMA_BLOB_OIDS`.
4. Lists `annotations/users/` by its tree id (`GET git/trees/{oid}`, not
   recursive; skipped when it is the last completed Pull's tree). GitHub
   documents a limit of 100,000 entries or 7 MB for a tree listing
   ([GitHub: get a tree](https://docs.github.com/en/rest/git/trees#get-a-tree));
   a listing GitHub reports as truncated stops the Pull.
5. Reads the changed files (user files, the merges file, the config) through
   `POST /graphql/blobs`, in batches packed by their sizes in the tree (a
   scheduling size that doubles after a batch succeeds and halves when GitHub
   or the Worker refuses one for its size or time); a blob whose text GitHub
   truncated is read alone through the REST blob route.
6. Validates each file and projects it onto the open dataset as its batch
   arrives, and keeps it in the file cache with the batch, so an interrupted
   Pull resumes from there.
7. Prunes files gone from the repository, then marks the Pull complete.

**Per-file quarantine.** A user or merges file that fails the contract (not
UTF-8 JSON text, over 1,000,000 bytes, failing its schema, an id another
contributor owns) is excluded on its own: kept in the cache as excluded, with
its reason, by blob id (not read again until it changes), left out of the
consensus, and reported in one warning with each file and its reason under its
details. A path under `annotations/users/` that is not `ghid_<id>.json`, and a
case variant of an annotation path, is ignored and listed. A Pull never stops
for one file. It does stop for a schema that is not the template's, a missing
`annotations/config.json` or `annotations/users/`, a missing branch, an
invalid config, a truncated users listing, or a configured categorical field
the open dataset lacks (checked before the file-cache scope is selected).

The pristine template's one-byte `annotations/users/.gitkeep` blob (Git SHA
`8b137891791fe96927ad78e64b0aad7bded08bdc`) is never downloaded. Each file's
size stated by the tree is checked against the blob GitHub returns.

The merged view is compiled by streaming the cache one file at a time
(`foldCachedFiles`), so a Pull has no limit on the number of active user files
or their total size and never holds every file at once.
Validated changed raw files may be committed to the scoped cache before the complete
cached set is re-read and compiled. If that later compile or session
application fails, the cache keeps those files (a corrupt cache is cleared for
its exact scope), but the visible session is restored exactly: moderation,
merged suggestions, settings, access metadata, and the remote SHAs the session
keeps (its own user file, the config and the merges file only) publish synchronously through one
session transaction and one change notification.

**Requests.** Every request to the Worker goes through `worker-request.js`,
the app's one transport (`formats/io/byte-source.js`): no total deadline, only
a stall timeout measured from the link; retries per request for transient
failures; pacing by GitHub's `X-RateLimit-*` and `Retry-After` headers, which
the Worker relays (`formats/io/hosts.js`). The Worker itself stops a request
only when nothing moved for 13 seconds.

The raw-file cache (IndexedDB `cellucid_community_annotation_file_cache`:
store `files`, one record per path and blob id holding the file's dataset view
or its exclusion; store `pulls`, the last completed Pull per scope) has no
`localStorage` index. If IndexedDB is unavailable, corrupt, or cannot persist a
write, Cellucid reports the failure; it does not switch to an in-memory cache.

From the sidebar you can download a locally-built
`cellucid-consensus.json` snapshot for downstream usage.

## Limits

These come from GitHub, Cloudflare or the browser, not from Cellucid:

- One file per contributor, at most 1,000,000 UTF-8 bytes (GitHub's Contents
  API, above).
- A users listing of at most 100,000 entries or 7 MB (GitHub's tree listing,
  above).
- GitHub's hourly REST and GraphQL budgets of the signed-in user
  ([REST](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
  [GraphQL](https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api)).
- **Direct-mode trust:** anyone with push access can write any file with Git
  or GitHub's web editor, including another contributor's user file. The
  Worker refuses such a write made through Cellucid, but the client reads files
  by content and cannot verify who committed them.
- **The Worker cannot bind a write to the connected branch:** which branch a
  page has connected lives in the browser, so writes are bound to the
  signed-in user only.
- **Cloudflare Workers Free plan:** about 10 ms of CPU and 50 subrequests per
  request ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).
  The Worker relays reads without parsing them and needs at most two GitHub
  subrequests per request. A request over the CPU budget is answered by
  Cloudflare with an HTML `503` without CORS headers, which the browser can
  only report as an unreachable Worker.

---

## GitHub App Authentication Setup (How Cellucid Signs In)

This section explains the GitHub authentication infrastructure used by the
Cellucid UI when you click **Continue with GitHub** in the Community Annotation
panel.

### The Worker (Auth + API Proxy)

By default, Cellucid uses a Cloudflare Worker named:

- Worker name: `cellucid-github-auth`
- Worker endpoint: `https://api.cellucid.com` (a Cloudflare custom domain, `routes`
  in `wrangler.community-annotations.jsonc`)
- GitHub App callback: `https://api.cellucid.com/auth/callback`

The deployed endpoint must advertise `"contractVersion": 3` and the exact route
inventory below (`worker-contract.js`, shared by the Worker and the page).
Cellucid performs that capability check before OAuth or any token-bearing
request. An older Worker is reported as "… runs an older version (contract N)
than this Cellucid (contract 3); its owner must redeploy the Worker."
(`GITHUB_WORKER_OUTDATED`); a newer one asks for a reload of Cellucid; a
Worker that cannot be reached is reported as unreachable, not incompatible.
Increment the Worker and client contract version together for a required
semantic change that would otherwise leave an older same-route deployment
looking compatible.

This worker is an **auth and bounded data proxy**:

- `/auth/login` starts the GitHub OAuth flow for the **Cellucid GitHub App**
- `/auth/callback` completes OAuth state and PKCE validation and hands the
  page an expiring user token (8 hours) and its lifetime; the refresh token
  stays in the worker, unused
- `/auth/revoke` revokes a token at GitHub with the app's credentials
  (**Sign out**)
- `/auth/user` answers “who am I”; `/auth/installations` and
  `/auth/installation-repos` answer “which repos did I install the app on”,
  one GitHub page per request (`?page=N` → `{items, nextPage}`)
- `/cap/lookup-cells` runs only Cellucid's fixed persisted CAP cell-type
  lookup and returns a bounded, minimal result projection
- `/graphql/snapshot` and `/graphql/blobs` run the two GraphQL queries the
  Worker writes itself (a branch's commit and annotation listings; blobs by id)
- `/api/repos/*` proxies the repository requests used by Cellucid to
  `api.github.com/repos/*`

Every successful CAP response contains exactly the pinned contract version
alongside its data: `{ "contractVersion": 3, "results": [...],
"omittedInvalidCount": number }`. Lookup kinds map to fixed APQ search fields:
`name` uses the default name search, `ontology` searches only
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
- The OAuth access token expires after 8 hours (GitHub's user tokens with
  expiration). It is stored with its expiry only in the tab's `sessionStorage`:
  a reload keeps the sign-in until it expires, then it is forgotten. Browsers
  write `sessionStorage` to the profile on disk for session restore, which is
  why the token is short-lived. **Sign out** revokes it at GitHub through the
  worker and forgets it.
- All GitHub calls are sent through the worker using `Authorization: Bearer <token>`.
- The worker uses `ALLOWED_ORIGINS` as an exact browser CORS allowlist.
- Before OAuth or any token-bearing request, the UI verifies the Worker's exact
  current health contract version and route inventory with a tokenless
  request and fails visibly if the deployment is stale.
- CAP searches never carry the GitHub token or cookies. They require an exact
  allowed browser origin, accept only the documented bounded search objects,
  and cannot forward arbitrary GraphQL.
- Name and ORCID profile autosuggestions send the field text to the public
  `pub.orcid.org` expanded-search endpoint after three typed characters.
  The browser omits credentials and the referrer, but the query leaves
  Cellucid; no GitHub token, annotation content, or CAP state is attached.
- Every route caches a successful CORS preflight for 7200 seconds
  (`Access-Control-Max-Age`); each actual request still rechecks Origin.

An `Origin` header is not authentication and can be forged by a non-browser
client. Fixed CAP operations prevent arbitrary GraphQL forwarding, but the CORS
allowlist does not stop anonymous requests. On the Workers Free plan, abuse
cannot create a bill: it can only use up the account's daily request allowance
(100,000 requests, reset at midnight UTC), after which Cloudflare answers with
an error (1027) until the next day. Cloudflare's rate-limiting rules belong to
a zone, a domain you have on Cloudflare, so they cover a custom domain
(`api.cellucid.com`, in the `cellucid.com` zone) and never a `*.workers.dev`
hostname; a limit is a WAF rate-limiting rule for `/cap/*` on that zone (a
self-hosted deployment serves its Worker on its own Cloudflare domain to have
one)
([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)).
Monitor usage without recording search text.

After every Worker deployment, verify the root response reports
`"contractVersion": 3`, then run these live UI smoke checks from an allowlisted
Cellucid origin:

1. Search CAP for `T cell` and confirm a bounded T-cell result.
2. Search ontology for `CL:0000084` and confirm that exact ontology ID.
3. Search markers for `CD3D` and confirm a result containing `CD3D` in its
   general or canonical markers.

### Self-Hosting / Using Your Own Worker

If you want to run your own worker + GitHub App (recommended for organizations), follow:

- `docs/github-oauth-cloudflare-setup.md`

The checked-in Wrangler configuration deploys on the Cloudflare Workers Free
plan (see *Limits* above). The setup guide explains the CPU diagnosis and when
to move to Workers Paid with a configured CPU limit.

Two values are compiled into the client; set both, rebuild Cellucid, and
deploy the rebuilt site:

- `DEFAULT_WORKER_ORIGIN` in
  `assets/js/app/community-annotations/github-auth.js`: the Worker origin.
- `appInstallUrl` in
  `assets/js/app/ui/modules/community-annotation/github-connection-flow.js`:
  the **Add repo** link,
  `https://github.com/apps/cellucid-community-annotations/installations/new`,
  which names cellucid.com's GitHub App by its slug. Replace the slug with your
  own app's, or **Add repo** opens the wrong app's installation page.

Local development pages may set
`window.__CELLUCID_GITHUB_WORKER_ORIGIN__` to an exact HTTP(S) origin before
Cellucid's application modules load.

Notes:

- Non-local builds refuse a runtime origin different from the compiled
  `DEFAULT_WORKER_ORIGIN`.
- The Worker `ALLOWED_ORIGINS` secret must contain the exact Cellucid page
  origin. Production origins must use HTTPS; HTTP is accepted only for
  canonical loopback development hosts.
- The GitHub App must keep **Expire user authorization tokens** on; the
  Worker refuses a token that never expires.
- The self-hosting guide includes the GitHub App permissions, token-expiration
  setting, required Worker secrets, deploy commands, executable contract tests,
  live acceptance test, and exact failure diagnosis.

This lets you keep the same repo template and UI while controlling the auth infrastructure.
