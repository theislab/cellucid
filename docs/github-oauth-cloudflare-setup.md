# GitHub OAuth and Cloudflare Worker Setup

Cellucid community annotations use a GitHub App user access token. A Cloudflare
Worker performs the OAuth code exchange, proxies the repository API calls used
by the browser, and exposes two fixed Cell Annotation Platform (CAP) lookups.
The GitHub client secret is never shipped with Cellucid, and the browser never
sends arbitrary GraphQL documents to CAP.

This guide describes the complete checked-in source contract. A deployed
Worker is compatible only after its live health response and browser lifecycle
checks match that source. The configuration and executable contract tests are:

- `assets/js/app/community-annotations/_worker-code.js`
- `assets/js/app/community-annotations/wire-contract.js`
- `wrangler.community-annotations.jsonc`
- `tests/community-annotation-worker-contract.test.mjs`
- `tests/community-annotation-cap-worker-contract.test.mjs`
- `tests/community-annotation-cap-client-contract.test.mjs`

## Current HTTP contract

The Worker exposes only these routes:

| Route | Method | Authentication | Purpose |
| --- | --- | --- | --- |
| `/` | `GET` | None | Health response, contract version, and route inventory |
| `/auth/login` | `GET` | None | Start OAuth with an explicit `return_to` URL |
| `/auth/callback` | `GET` | OAuth state, PKCE verifier, and GitHub code | Complete OAuth |
| `/auth/user` | `GET` | GitHub bearer token | Return `{id, login}` |
| `/auth/installations` | `GET` | GitHub bearer token | Return every accessible app installation |
| `/auth/installation-repos` | `POST` | GitHub bearer token | Return every repository in one installation |
| `/api/repos/*` | `GET`, `POST`, or `PUT` | GitHub bearer token | Proxy the repository API calls used by Cellucid |
| `/cap/lookup-cells` | `POST` | None; exact allowed `Origin` required | Run the fixed persisted CAP cell lookup and return a bounded projection |
| `/cap/search-datasets` | `POST` | None; exact allowed `Origin` required | Run the fixed persisted CAP dataset lookup and return a bounded projection |

The root health document and every successful CAP response carry
`"contractVersion": 1`. The checked-in client pins that exact value as well as
the service identity and ordered route inventory. Increment the Worker and
client contract version together whenever a required Worker semantic change
would make an older deployment incompatible without changing its routes.

Each sign-in stores its random 256-bit state in the name of one secure,
HTTP-only, host-only, `SameSite=Lax` callback cookie for ten minutes. That
cookie's strict JSON value owns the exact return URL and PKCE verifier. The
callback returns exactly one access token or error in the Cellucid URL
fragment. Cellucid removes that fragment immediately and stores the token in
`sessionStorage`.

All request and response bodies are JSON with duplicate-key detection. Unknown
installation-request fields, wrong JSON types, malformed GitHub responses,
incomplete pagination, disallowed origins, unsupported routes, and unsupported
methods fail visibly.

The CAP routes accept only the following exact request objects:

- `/cap/lookup-cells`: `{ "kind": "name|ontology|marker|feedback",
  "term": "...", "limit": 1..25 }`
- `/cap/search-datasets`: `{ "search": "..." | null, "limit": 1..10 }`

The Worker maps the lookup `kind` to fixed upstream APQ variables:

- `name` and `feedback` use `{ "name": term }`.
- `ontology` uses `{ "name": term, "fields": ["ontologyTermId"] }`.
- `marker` uses `{ "name": term,
  "fields": ["markerGenes", "canonicalMarkerGenes"] }`.

CAP request bodies are limited to 4 KiB. Name, ontology, feedback, and dataset
search text is limited to 256 Unicode code points. A marker lookup permits at
most 3,249 code points so the UI can send one deterministic signature made from
as many as 50 individually validated 64-code-point marker genes plus their
comma separators; the 4 KiB serialized-body limit remains authoritative.
The Worker supplies the known operation name and persisted-query hash itself;
it never accepts a query, operation, variables object, bearer token, cookie, or
caller-selected upstream. It follows no upstream redirect and sends no
credentials.

Both routes return `{ "contractVersion": 1, "results": [...],
"omittedInvalidCount": number }`. Results contain only the fields required by
Cellucid. A malformed or oversized item is omitted as a whole and increments
`omittedInvalidCount`; scientific strings or marker arrays are never clipped or
repaired. The client keeps valid items and visibly reports any omission. A
malformed GraphQL envelope, non-empty GraphQL error list, non-success upstream
status, unknown persisted query, network failure, or response above 8 MiB fails
generically without forwarding upstream payloads, headers, or cookies.

CAP routes deliberately require a present, exact `Origin` from
`ALLOWED_ORIGINS`, even though they do not require GitHub authentication. Their
preflight permits only `POST` and `Content-Type`, does not enable credentials,
and caches a successful browser preflight for exactly 600 seconds. CAP
responses are `no-store`.

Profile enrichment is a separate browser-to-ORCID flow. After three typed
characters, the Name and ORCID suggestion fields send the current trimmed text
to the public `https://pub.orcid.org` expanded-search endpoint. Those requests
omit credentials and suppress the referrer, but the query still leaves
Cellucid and is visible to ORCID and the network path. Cellucid never attaches
the GitHub token, annotation content, or CAP search state to an ORCID request.

`Origin` is browser CORS metadata, not authentication: a non-browser client can
forge an allowlisted value. The fixed routes and APQ variables prevent callers
from turning the Worker into an arbitrary GraphQL relay, but the Origin check
does not prevent anonymous request or billing abuse. A public deployment should
apply a Cloudflare rate-limiting rule to `/cap/*`, sized for its expected
interactive traffic, and monitor rejects and Worker usage without logging
search text.

Active annotation files are limited to exactly 1,000,000 decoded UTF-8 bytes.
The browser rejects an oversized canonical document before its mutation
request. User-file publication performs that check before its authentication
lookup; config publication first reads the bounded remote config needed to
construct the final document. Both Pull and mutation reconciliation reject
oversized remote content. This matches the boundary for the GitHub Contents
API's complete JSON/base64 response contract.

Installation and installation-repository discovery fetches GitHub pages with
at most six simultaneous upstream connections, preserves exact page order, and
supports a declared maximum of 10,000 results per collection. A larger
`total_count`, a changing total, or an incomplete page fails before Cellucid
publishes a partial repository list. Each page is validated and projected to
the minimal browser contract before the next page assigned to that worker is
requested, so ignored GitHub metadata is not retained across the collection.

Successful Contents, Git blob, and recursive-tree reads are bounded UTF-8
streams. The Worker does not buffer or project their full documents in its
shared isolate; the browser performs exact duplicate-key, base64, tree, and
annotation-schema validation before state changes. Caller cancellation and the
15-second Worker deadline continue to own the stream until it completes or is
cancelled.

The browser additionally bounds one repository Pull to 10,000 active user
files and 64,000,000 aggregate decoded UTF-8 bytes. It preflights exact blob
sizes from the recursive tree, verifies each fetched blob still has that size,
and ignores valid Git submodules outside `annotations/users/`. The eight-wide
blob reader stops assigning work on the first failure, cancels and awaits the
remaining active reads, and retains the first error.

## 1. Prepare Cloudflare

The checked-in Worker contract requires the Cloudflare Workers Paid plan with
the Standard usage model. Its Wrangler configuration sets `limits.cpu_ms` to
`1000` so strict duplicate-key request parsing, bounded collection-page
projection, OAuth validation, and mutation validation remain available for the
complete supported contract. Read-heavy repository documents are streamed to
the browser, but a Free-plan deployment is still unsupported: its CPU ceiling
cannot execute every accepted request reliably, even though small development
fixtures may appear to work. The one-second limit is a runtime ceiling, not an
expected per-request cost.

1. Sign in to Cloudflare and enable a `workers.dev` subdomain for the account.
2. Keep the Worker name in `wrangler.community-annotations.jsonc` as
   `cellucid-github-auth`, or choose one final account-local name before
   registering the GitHub App.
3. Determine the resulting HTTPS Worker origin from the Worker name and the
   account's `workers.dev` subdomain.
4. The OAuth callback URL is that exact origin followed by `/auth/callback`.

An HTTPS custom domain is also valid. Use one final origin consistently in the
GitHub App callback, Cellucid frontend configuration, and live verification.

## 2. Register the GitHub App

In GitHub, open **Settings → Developer settings → GitHub Apps → New GitHub
App**, then configure:

1. Set **Homepage URL** to the production Cellucid site.
2. Set **User authorization callback URL** to the exact Worker callback URL
   established above.
3. Select **Request user authorization (OAuth) during installation**.
4. Clear **Webhook active**. This Worker has no webhook route.
5. In **Optional Features**, opt out of **User-to-server token expiration**.
   The current Cellucid session contract accepts one non-expiring user access
   token and does not accept refresh-token documents.
6. Set repository permissions:
   - **Metadata: Read-only**
   - **Contents: Read and write**
   - **Pull requests: Read and write**
   - **Administration: Read and write**
7. Leave account permissions unset.
8. Choose the installation policy appropriate for the deployment, create the
   app, and generate one client secret.

`Administration: Read and write` and `Contents: Read` are required by GitHub's
create-fork endpoint. They are needed when contributors without source-repo
write access publish through the `fork-pull-request` route.

Cellucid selects exactly one route from repository metadata before making any
mutation:

- `direct` when GitHub reports source-repository push permission.
- `fork-pull-request` when direct push permission is absent and the source
  repository permits forking.

A route failure is terminal for that publish operation. Cellucid does not
switch from direct publication to a branch, Pull Request, or fork, and it does
not switch from fork publication to a source-repository write.

Fork publication checks the signed-in user's same-name repository first and
uses it only when GitHub identifies the connected source as its exact parent.
When no same-name repository exists, Cellucid requests fork creation
immediately. A creation conflict can mean that the user's fork was renamed, so
Cellucid searches newest-first for at most 1,000 source forks and 10 seconds.
If the renamed fork falls outside that recovery bound, rename it to the source
repository name before publishing again.

The user access token can perform an action only when both the GitHub App and
the signed-in user have the required permission. Cellucid does not use a GitHub
App private key, App JWT, or installation access token.

Official GitHub references:

- [Generating a GitHub App user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Choosing GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [Create a fork endpoint permissions](https://docs.github.com/en/rest/repos/forks?apiVersion=2026-03-10#create-a-fork)
- [List forks ordering and pagination](https://docs.github.com/en/rest/repos/forks?apiVersion=2026-03-10#list-forks)

## 3. Configure Worker secrets

The Worker requires exactly three Cloudflare bindings:

| Binding | Value |
| --- | --- |
| `ALLOWED_ORIGINS` | Comma-separated Cellucid HTTPS origins; loopback HTTP is allowed only for local development |
| `GITHUB_CLIENT_ID` | Client ID from the GitHub App settings page |
| `GITHUB_CLIENT_SECRET` | Client secret generated for the GitHub App |

`ALLOWED_ORIGINS` is exact:

- Include only origins: scheme, host, and explicit non-default port.
- Do not include a path, query, fragment, credentials, or trailing slash.
- Separate multiple origins with commas and no surrounding whitespace.
- Do not use `*`.
- Use HTTPS outside local development. Plain HTTP is accepted only for
  canonical loopback hosts (`localhost`, its subdomains, `127.0.0.0/8`, and
  `[::1]`) so an OAuth token is never returned to a remote plaintext origin.
- Include each local Cellucid origin that will call the deployed Worker.

The static page CSP permits `http:` and `ws:` connection schemes so localhost,
IPv4 loopback, IPv6 loopback, and intentional LAN data/Worker endpoints can use
arbitrary development ports; CSP host-source syntax cannot represent every
IPv6 literal/port combination consistently across engines. An HTTPS Cellucid
page still cannot make insecure mixed-content requests. Separately, the client
accepts a non-default Worker override only on a recognized development host,
and the Worker refuses plain-HTTP origins outside canonical loopback.

Using Node.js 22 or newer, from the `cellucid` repository root, install the
exact lockfile dependencies, then authenticate Wrangler and enter the actual
value when each command prompts. `npx` resolves the repository-pinned Wrangler
release:

```text
npm ci
npx --yes wrangler@4.115.0 login
npx --yes wrangler@4.115.0 secret put ALLOWED_ORIGINS --config wrangler.community-annotations.jsonc
npx --yes wrangler@4.115.0 secret put GITHUB_CLIENT_ID --config wrangler.community-annotations.jsonc
npx --yes wrangler@4.115.0 secret put GITHUB_CLIENT_SECRET --config wrangler.community-annotations.jsonc
```

Wrangler stores all three values as remote encrypted secrets rather than in the
configuration file or repository. The Worker validates all three bindings on
every request, including the health route, and returns `500` when any value is
missing or inexact. A dry run validates the source and configuration but cannot
retrieve or validate remote secret values.

Official Cloudflare references:

- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

Official GitHub reference:

- [Repository Contents API](https://docs.github.com/en/rest/repos/contents)

## 4. Run the local contract gates

Use Node.js 20 or newer for the source contracts. The pinned Wrangler bundle
gate requires Node.js 22 or newer and runs under Node.js 24 in CI. The tests
execute the Worker directly with mocked GitHub responses and do not modify
Cloudflare or GitHub:

```text
npm ci
node --test tests/community-annotation-worker-contract.test.mjs
node --test tests/community-annotation-wire-contract.test.mjs
node --test tests/community-annotation-cap-worker-contract.test.mjs
node --test tests/community-annotation-cap-client-contract.test.mjs
npm run test:worker-bundle
```

The Worker suite covers route inventory, methods, CORS, OAuth state, PKCE,
callback cookies, exact request bodies, duplicate JSON keys, complete
pagination, immediate collection-page projection, bounded streaming ownership,
repository proxy authorization, read-only schema enforcement, fixed CAP
persisted queries, contract pinning, preflight caching, item projection,
omission accounting, early upstream-response cancellation, body/response
limits, and caller/deadline cancellation.

For a local Worker process, create an untracked `.dev.vars` file beside the
Wrangler configuration. Put exactly the three binding assignments listed
above, with their real values, in dotenv syntax. Then run:

```text
npx --yes wrangler@4.115.0 dev --config wrangler.community-annotations.jsonc
```

`.dev.vars*` and `.env*` are ignored by this repository. Do not commit either
file. OAuth itself uses the callback URL registered in GitHub, so use the
deployed Worker for the final browser test.

## 5. Deploy

From the `cellucid` repository root:

```text
npx --yes wrangler@4.115.0 deploy --config wrangler.community-annotations.jsonc
```

Record the exact HTTPS URL printed by Wrangler. Opening its root route must
return:

```json
{
  "status": "ok",
  "service": "Cellucid GitHub Auth",
  "contractVersion": 1,
  "endpoints": [
    "/auth/login",
    "/auth/callback",
    "/auth/user",
    "/auth/installations",
    "/auth/installation-repos",
    "/cap/lookup-cells",
    "/cap/search-datasets",
    "/api/repos/*"
  ]
}
```

A source edit does not update a running Worker. Run this deployment after every
accepted Worker-source change, then execute the root-route and browser checks
against the printed production URL. Do not describe the live Worker as updated
until those checks pass against that URL.

Before starting OAuth or sending a stored GitHub token, the Cellucid client
performs a tokenless, bounded `GET /` capability check and requires this exact
service identity, contract version, and ordered endpoint inventory. A stale
deployment, missing CORS allowlist entry, oversized response, or incompatible
contract stops before redirect or token disclosure and reports how to deploy
the matching Worker.

If the deployed origin differs from the callback URL in the GitHub App,
correct the GitHub App callback before testing sign-in.

## 6. Point Cellucid at the Worker

Production uses the exact `DEFAULT_WORKER_ORIGIN` constant in
`assets/js/app/community-annotations/github-auth.js`. Set it to the deployed
Worker origin, rebuild Cellucid, and deploy the rebuilt site.

Local Cellucid pages may set
`window.__CELLUCID_GITHUB_WORKER_ORIGIN__` to an exact HTTP(S) Worker origin
before the application modules load. A production page rejects a different
runtime origin because sending its token to another proxy would disclose the
credential.

The Cellucid page origin must also appear exactly in `ALLOWED_ORIGINS`. The
current Content Security Policy permits HTTPS connections. If a hosting layer
adds a narrower `connect-src` policy, add the exact Worker origin there.

## 7. Install and authorize the GitHub App

1. Install the GitHub App on every account that owns an annotation repository.
2. When selecting individual repositories, explicitly select each annotation
   repository.
3. For contributor fork publishing, install the app on the contributor's
   destination account with access to all repositories. GitHub requires the app
   on the source account and on the destination account for app-driven fork
   creation.
4. A user must have explicit access to an installation before GitHub returns it
   from the user-installations endpoint.
5. For organizations using SAML SSO, establish an active SAML session before
   authorizing the GitHub App.

## 8. Complete the browser acceptance test

Run this test in current Chrome, Safari, Firefox, and Edge. Run at least one
desktop browser on macOS, Windows, and Linux when those platforms are release
targets.

1. Open Cellucid at an origin in `ALLOWED_ORIGINS`.
2. Load the intended dataset.
3. Open **Community annotation**.
4. Select **Sign in with GitHub**.
5. Complete GitHub authorization and confirm that the browser returns to the
   same Cellucid dataset URL.
6. Confirm that the address bar contains no
   `cellucid_github_token`, `cellucid_github_error`, or
   `cellucid_github_auth` fragment.
7. Open **Choose repo** and confirm that every expected installation and
   repository appears.
8. Select the annotation repository and run **Pull**.
9. Open the annotation suggestion form, enter `T cell`, select **Search CAP**,
   and confirm a bounded result identifies T cell.
10. Enter `CL:0000084`, select **Search Ontology**, and confirm the result owns
    that exact ontology ID.
11. Enter `CD3D`, select **Search Markers**, and confirm a returned result
    includes `CD3D` in its general or canonical markers.
12. Add one annotation and run **Publish** with a user who can write directly.
    Confirm the result reports the `direct` route.
13. Pull again and confirm the new user document.
14. With a contributor account that cannot write to the source repository,
    publish through the preselected `fork-pull-request` route and verify the
    resulting fork, deterministic branch, commit, and one new open Pull
    Request. Confirm that no source-repository write was attempted.
15. Sign out and confirm that the session token and user identity disappear
    from `sessionStorage`.

The OAuth flow uses top-level redirects rather than pop-up APIs. Worker cookies
are secure, HTTP-only, host-only, short-lived, and used only on the callback
path. Each sign-in owns one state-specific cookie containing its exact return
URL and PKCE verifier, so concurrent tabs cannot overwrite or clear one
another's flow. The Worker rejects a sign-in before redirect when the complete
serialized owner cookie would exceed 4,096 bytes. These choices avoid browser
pop-up and cookie-size failure modes while keeping the flow consistent across
the supported desktop browsers.

## Exact failure diagnosis

### Worker root returns `500`

One or more required bindings is missing or inexact. Re-enter all three secrets.
For `ALLOWED_ORIGINS`, remove spaces, paths, trailing slashes, duplicates,
wildcards, and non-loopback plain-HTTP origins.

### Cellucid receives `403 Origin is not allowed`

The browser's exact origin is absent from `ALLOWED_ORIGINS`. Ports are part of
an origin. Add the origin and redeploy the secret value.

### GitHub reports an invalid callback

The GitHub App callback must equal the deployed Worker origin plus
`/auth/callback`. Confirm scheme, hostname, port, and path.

### Callback reports missing state, return URL, or PKCE verifier

The ten-minute OAuth window expired, the callback was opened without starting
at `/auth/login`, or browser policy removed the callback cookies. Start sign-in
again from Cellucid and complete it in the same browser session.

### No installations appear

Confirm that the signed-in GitHub user can access the installation, that the app
is installed on the intended account, and that the user authorized this exact
GitHub App. The Worker fetches every GitHub page and rejects incomplete page
sets. A user with more than 10,000 visible installations must reduce the
GitHub App installation set before using the current discovery contract.

### An installation appears but a repository does not

Confirm that the installation includes the repository and grants Metadata read
permission. For selected-repository installations, add the repository in the
GitHub App installation settings. One installation may expose at most 10,000
repositories through the current discovery contract; narrow a larger
installation's repository selection rather than accepting a truncated list.

### Pull is denied

Confirm Metadata read and Contents read access for both the app and the user.
For a private organization repository, also confirm the user's organization and
SSO access.

### Cellucid reports an annotation file is too large

The active file exceeds 1,000,000 UTF-8 bytes, so the complete GitHub Contents
JSON/base64 contract is no longer available. Do not retry the same publication:
archive historical material outside `annotations/`, then reduce obsolete
suggestions, votes, or comments while preserving the current schema and file
ownership. A repository maintainer must replace an already-oversized remote
active document with a valid bounded document before Cellucid can Pull it.

### Cellucid reports that a Pull exceeds its aggregate safety limit

The repository has more than 10,000 active `annotations/users/*.json` files or
their decoded sizes total more than 64,000,000 bytes. Archive inactive user
documents outside `annotations/users/` or split the annotation community across
repositories. Cellucid does not download or compile a partial prefix.

### Direct publish is denied

Confirm Contents write permission on the app, user Write access or higher on the
repository, branch rules, and the connected branch.

### Pull Request publish is denied

Confirm Pull requests write permission, Administration write and Contents
read/write, app installation on source and destination accounts,
source-repository forking policy, and destination repository access. The
operation remains on the preselected `fork-pull-request` route; correct the
reported permission or repository condition and start a new publish.

If the error says that renamed-fork discovery reached its bound, rename your
fork to the connected source repository name on GitHub, then publish again. If
that name is occupied by an unrelated repository, rename the unrelated
repository first. Cellucid will not publish through a repository whose parent
does not match the connected source.

### Worker returns `502` or `504`

An upstream GitHub or CAP request failed or returned a response outside the
current JSON contract (`502`), or the bounded upstream deadline expired
(`504`). Check the corresponding provider status and the bounded Worker request
outcome. The Worker does not turn a partial or malformed response into a
successful result or forward an upstream error body.

### Cloudflare reports `exceededCpu`

Confirm that the Worker uses the Paid Standard usage model and that the
deployed version retains the checked-in `limits.cpu_ms = 1000` setting.
Workers Free cannot satisfy the complete supported document contract. If a
paid deployment still reaches the limit, retain the failing request identity
from the Worker logs, verify the repository document is within the current
contract, and investigate before increasing the ceiling.

### Cellucid reports storage failure

Community annotation authentication requires working `sessionStorage`.
Repository connection and cache state also require the storage boundaries
described in `assets/js/app/community-annotations/REPO_SETUP.md`. Browser modes
or enterprise policies that disable those stores are unsupported and produce an
explicit error.

## Security operations

- Keep `GITHUB_CLIENT_SECRET` only in Cloudflare secrets.
- Keep `.dev.vars*` and `.env*` untracked.
- Use the smallest GitHub App installation repository set compatible with the
  publishing paths offered by the deployment.
- Rotate the client secret in GitHub, update the Cloudflare secret, verify
  sign-in, and then remove the superseded GitHub secret.
- Revoke a user's GitHub App authorization when its token must stop working.
- Inspect Cloudflare logs without recording authorization headers, OAuth codes,
  access tokens, or cookie values.
- Keep the GitHub App callback list and `ALLOWED_ORIGINS` limited to active,
  HTTPS production and staging deployments plus intentional local origins.
