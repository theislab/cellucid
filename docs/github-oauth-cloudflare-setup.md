# GitHub OAuth and Cloudflare Worker Setup

Cellucid community annotations use a GitHub App user access token. A Cloudflare
Worker performs the OAuth code exchange, proxies the repository API calls used
by the browser, runs two GraphQL reads it writes itself (`/graphql/snapshot`,
`/graphql/blobs`), and exposes one fixed Cell Annotation Platform (CAP) lookup
(`/cap/lookup-cells`).
The GitHub client secret is never shipped with Cellucid, and the browser never
sends arbitrary GraphQL documents to GitHub or CAP.

This guide describes the complete checked-in source contract. A deployed
Worker is compatible only after its live health response and browser lifecycle
checks match that source. The configuration and executable contract tests are:

- `assets/js/app/community-annotations/_worker-code.js`
- `assets/js/app/community-annotations/worker-contract.js` (the version, route
  inventory, headers and callback fragment the Worker and the page share)
- `assets/js/app/community-annotations/wire-contract.js`
- `assets/js/utils/origin-allowlist.js`
- `wrangler.community-annotations.jsonc`
- `tests/community-annotation-worker*.test.mjs`
- `tests/community-annotation-cap-worker-contract.test.mjs`
- `tests/community-annotation-cap-client-contract.test.mjs`

## Current HTTP contract

The Worker exposes only these routes:

| Route | Method | Authentication | Purpose |
| --- | --- | --- | --- |
| `/` | `GET` | None | Health response, contract version, and route inventory |
| `/auth/login` | `GET` | None | Start OAuth with an explicit `return_to` URL |
| `/auth/callback` | `GET` | OAuth state, PKCE verifier, and GitHub code | Complete OAuth |
| `/auth/revoke` | `POST` | GitHub bearer token; exact allowed `Origin` | Revoke that token at GitHub with the app's credentials (`DELETE /applications/{client_id}/token`); answers `204`, also for a token GitHub no longer knows |
| `/auth/user` | `GET` | GitHub bearer token | Return `{id, login}` |
| `/auth/installations?page=N` | `GET` | GitHub bearer token | Return one page of the accessible app installations: `{items, nextPage}` |
| `/auth/installation-repos?page=N` | `POST` | GitHub bearer token | Return one page of the repositories of installation `{installation_id}`: `{items, nextPage}` |
| `/cap/lookup-cells` | `POST` | None; exact allowed `Origin` required | Run the fixed persisted CAP cell lookup and return a bounded projection |
| `/graphql/snapshot` | `POST` | GitHub bearer token | `{owner, repo, branch}`: the branch's commit and the `annotations/` and `annotations/moderation/` listings, in one GraphQL query the Worker writes |
| `/graphql/blobs` | `POST` | GitHub bearer token | `{owner, repo, oids}`: the text of those blobs, aliased `b0`, `b1`, ... in request order, in one GraphQL query the Worker writes |
| `/api/repos/*` | `GET`, `POST`, `PUT`, or `PATCH` | GitHub bearer token | Proxy the repository API calls used by Cellucid |

The root health document and every successful CAP response carry
`"contractVersion": 3`. Both sides take that value, the service identity and
the ordered route inventory from `worker-contract.js`. A client meeting an
older Worker says that its owner must redeploy it; a newer Worker asks for a
reload of Cellucid. Increment the version whenever a required Worker semantic
change would make an older deployment incompatible.

The repository proxy exposes exactly these operations (any other path, method
or query is refused before GitHub is asked):

- `GET /api/repos/{o}/{r}` (metadata, projected; `?fork_identity=1` projects
  the fork ancestry), `GET .../contents/{annotation document or schema}?ref=`,
  `GET .../git/trees/{object id}` (one tree, not recursive),
  `GET .../git/blobs/{object id}`, `GET .../git/ref/heads/{branch}`,
  `GET .../forks?sort=newest&per_page=100&page=N`,
  `GET .../pulls?state=open&head=&base=&per_page=100`;
- `PUT .../contents/{annotation document}`, `POST .../git/refs`,
  `PATCH .../git/refs/heads/{branch}` (body exactly `{"sha", "force": true}`),
  `POST .../pulls`. There is no fork creation: a contributor forks on GitHub.

Contents, blob and tree reads and both GraphQL routes are relayed as GitHub
sends them (status, `Content-Type`, body bytes), without being parsed or cut:
the browser checks them. GraphQL reports query errors under HTTP 200 in an
`errors` array, which the browser reads. Every answer that relays GitHub
carries GitHub's `ETag`, `Retry-After`, `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, `X-RateLimit-Reset`, `X-RateLimit-Used`,
`X-RateLimit-Resource` and `X-GitHub-Request-Id`, success or failure, and
exposes them to the page. A GitHub read accepts `If-None-Match` and passes it
on; GitHub's `304` comes back with no body. Every route answers a CORS
preflight with `Access-Control-Max-Age: 7200`, the longest Chromium keeps one
(Firefox keeps 86400).

A write is bound to the signed-in user, whom the Worker looks up with one
`GET https://api.github.com/user` before forwarding it: a user file
`annotations/users/ghid_<n>.json` is written only by user `n`; a branch under
`cellucid-annotations/` is written, created (`POST git/refs`) or moved
(`PATCH`) only as the user's own `cellucid-annotations/ghid_<id>/...`, and
created or moved only in a repository the user owns; a Pull Request is opened
only from `<login>:cellucid-annotations/ghid_<id>/...`. A refused write is
`403` with outcome `not-applied`. The Worker cannot know which branch a page
has connected (that lives in the browser), so it does not bind writes to it.

Each sign-in stores its random 256-bit state in the name of one secure,
HTTP-only, host-only, `SameSite=Lax` callback cookie for ten minutes. That
cookie's strict JSON value owns the exact return URL and PKCE verifier. The
callback returns exactly one access token with its lifetime
(`cellucid_github_token_expires_in`, seconds: 8 hours for a GitHub App with
token expiration), or one error, in the Cellucid URL fragment. GitHub's refresh
token is never used and never leaves the Worker. Cellucid removes that fragment
immediately and stores the token and when it expires in the tab's
`sessionStorage`: a reload keeps the sign-in until the token expires, and then
it is forgotten. **Sign out** sends the token to `/auth/revoke`, so it stops
working at GitHub, and forgets it.

Request bodies are JSON objects of exactly the documented fields, parsed
natively; a repeated key keeps its last value, and what reaches GitHub is
re-serialised from the checked values, never the bytes received. Unknown
fields, wrong JSON types, malformed GitHub responses, disallowed origins,
unsupported routes and unsupported methods fail visibly. A GitHub error answer
keeps GitHub's status, with GitHub's `message` (or, for a page that is not
JSON, the status) as `{ "error": ... }`.

The CAP route accepts only this exact request object:

- `/cap/lookup-cells`: `{ "kind": "name|ontology|marker", "term": "...",
  "limit": 1..25 }`

The Worker maps the lookup `kind` to fixed upstream APQ variables:

- `name` uses `{ "name": term }`.
- `ontology` uses `{ "name": term, "fields": ["ontologyTermId"] }`.
- `marker` uses `{ "name": term,
  "fields": ["markerGenes", "canonicalMarkerGenes"] }`.

CAP request bodies are limited to 4 KiB. Name and ontology search text is
limited to 256 Unicode code points. A marker lookup permits at
most 3,249 code points so the UI can send one deterministic signature made from
as many as 50 individually validated 64-code-point marker genes plus their
comma separators; the 4 KiB serialized-body limit remains authoritative.
The Worker supplies the known operation name and persisted-query hash itself;
it never accepts a query, operation, variables object, bearer token, cookie, or
caller-selected upstream. It follows no upstream redirect and sends no
credentials.

Both routes return `{ "contractVersion": 3, "results": [...],
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
and caches a successful browser preflight for 7200 seconds, as every route
does. CAP responses are `no-store`.

Profile enrichment is a separate browser-to-ORCID flow. After three typed
characters, the Name and ORCID suggestion fields send the current trimmed text
to the public `https://pub.orcid.org` expanded-search endpoint. Those requests
omit credentials and suppress the referrer, but the query still leaves
Cellucid and is visible to ORCID and the network path. Cellucid never attaches
the GitHub token, annotation content, or CAP search state to an ORCID request.

`Origin` is browser CORS metadata, not authentication: a non-browser client can
forge an allowlisted value. The fixed routes and APQ variables prevent callers
from turning the Worker into an arbitrary GraphQL relay, but the Origin check
does not stop anonymous requests. On the Workers Free plan, abuse cannot create
a bill: it can only use up the account's daily request allowance (100,000
requests, reset at midnight UTC), after which Cloudflare answers with an error
(1027) until the next day. Cloudflare's rate-limiting rules belong to a zone, a
domain you have on Cloudflare, so they cover the Worker's custom domain
(production: `api.cellucid.com`, in the `cellucid.com` zone) and never a
`*.workers.dev` hostname. To limit requests, add a WAF rate-limiting rule for
`/cap/*` on that zone ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)).
Monitor Worker usage without logging search text.

Active annotation files are limited to exactly 1,000,000 decoded UTF-8 bytes.
The browser rejects an oversized canonical document before its mutation
request. User-file publication performs that check before its authentication
lookup; config publication first reads the bounded remote config needed to
construct the final document. Both Pull and mutation reconciliation reject
oversized remote content. This matches the boundary for the GitHub Contents
API's complete JSON/base64 response contract.

Installation and installation-repository discovery is one GitHub page (100
items) per Worker request: the browser asks `?page=1`, `?page=2`, ... until
`nextPage` is `null` (taken from GitHub's `Link: rel="next"`). A collection of
any size is listed this way, and no request of the Worker ever needs more than
two GitHub subrequests (the Workers Free plan allows 50 per request). Each page
is validated and projected to the minimal browser contract; a page that
repeats an id or an account, or names a next page that is not the following
one, fails.

A request has no total deadline. It is stopped (`504`) only when nothing moved
for 13 seconds, GitHub's own 10-second request timeout plus a 3-second
connection set-up: no request-body bytes from the browser, no answer and no
body bytes from GitHub. A slow upload or download that keeps moving is never
cut, and time spent waiting for the browser to read what was already relayed
is not waiting on anything. When the browser goes away (`enable_request_signal`),
the GitHub request is stopped too.

## 1. Prepare Cloudflare

The production Worker runs on the Cloudflare Workers Free plan, and the
checked-in Wrangler configuration sets no CPU limit: a configured limit is a
Workers Paid feature, and Cloudflare refuses to deploy one on Free. Free gives
each request about 10 ms of CPU time. The Worker stays well inside it at any
repository size: file contents, blobs, trees and GraphQL answers are relayed
without being parsed, and a write is checked with native JSON parsing and a
native base64 check (a publish of a 1,000,000-byte annotation file costs a
few milliseconds; `tests/community-annotation-worker-cpu-contract.test.mjs`
holds it to a few native parses of its body).

Production serves the Worker on a custom domain, `https://api.cellucid.com`:
`routes` in `wrangler.community-annotations.jsonc` names it with
`custom_domain: true`, so a deploy creates its DNS record and certificate in
the `cellucid.com` zone, which is on the same Cloudflare account. The custom
domain is the Worker's only address (`"workers_dev": false`).

1. Sign in to Cloudflare and add the domain you will serve the Worker on as a
   zone of the account (production: `cellucid.com`).
2. Keep the Worker name in `wrangler.community-annotations.jsonc` as
   `cellucid-github-auth`, or choose one final account-local name, and set the
   `routes` pattern to your host (production: `api.cellucid.com`). Without a
   domain of your own, remove `routes` and set `"workers_dev": true` to use the
   account's `workers.dev` address instead (enable a `workers.dev` subdomain
   first); rate-limiting rules then cannot cover it (above).
3. The Worker origin is `https://` followed by that host.
4. The OAuth callback URL is that exact origin followed by `/auth/callback`
   (production: `https://api.cellucid.com/auth/callback`).

Use one final origin consistently in the GitHub App callback, Cellucid frontend
configuration (`DEFAULT_WORKER_ORIGIN`), and live verification.

## 2. Register the GitHub App

In GitHub, open **Settings → Developer settings → GitHub Apps → New GitHub
App**, then configure:

1. Set **Homepage URL** to the production Cellucid site.
2. Set **User authorization callback URL** to the exact Worker callback URL
   established above.
3. Select **Request user authorization (OAuth) during installation**. After an
   installation GitHub then sends the person to the Worker's callback with
   `setup_action` and no sign-in `state`; the Worker answers with a short page
   saying the app is installed (or the installation request was sent) and to go
   back to the Cellucid tab and sign in there. That sign-in then completes at
   once, as the app is authorized already. The installation's own code is not
   exchanged.
4. Clear **Webhook active**. This Worker has no webhook route.
5. Keep **Expire user authorization tokens** on (GitHub's default for a new
   GitHub App; in an existing app, under **Optional Features**, opt in to
   **User-to-server token expiration**). The Worker accepts only an expiring
   user token (`access_token`, `expires_in`, `refresh_token`,
   `refresh_token_expires_in`, `scope`, `token_type`) and refuses a token that
   never expires, so a sign-in lasts hours, not until the authorization is
   revoked.
6. Set repository permissions:
   - **Metadata: Read-only**
   - **Contents: Read and write**
   - **Pull requests: Read and write**

   No Administration permission: Cellucid never creates a fork.
7. Leave account permissions unset.
8. Choose the installation policy appropriate for the deployment, create the
   app, and generate one client secret.

Creating a fork through the API needs `Administration: Read and write`, so
Cellucid does not create forks: a contributor without source-repo write access
forks the repository on GitHub, then publishes through the
`fork-pull-request` route.

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
Otherwise (a renamed fork) Cellucid pages through the source repository's
forks, newest first, until it finds the user's fork or GitHub has no more (one
page of 100 per request). Without a fork, Publish stops and links to
`https://github.com/<owner>/<repo>/fork`. A fork GitHub is still copying (it
has neither the base branch nor the source's default branch yet) stops Publish
with "Publish again in a minute"; Cellucid does not wait on a deadline.

The user access token can perform an action only when both the GitHub App and
the signed-in user have the required permission. Cellucid does not use a GitHub
App private key, App JWT, or installation access token.

Official GitHub references:

- [Generating a GitHub App user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Choosing GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) (creating a fork needs Administration write)
- [Authenticating on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user) (a user token reaches only accounts where the app is installed)
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

Use Node.js 22.15 or newer (`package.json` `engines.node`) for the source
contracts and the pinned Wrangler bundle gate, which runs under Node.js 24 in
CI. The tests
execute the Worker directly with mocked GitHub responses and do not modify
Cloudflare or GitHub:

```text
npm ci
node --test tests/community-annotation-worker*.test.mjs
node --test tests/community-annotation-wire-contract.test.mjs
node --test tests/community-annotation-cap-worker-contract.test.mjs
node --test tests/community-annotation-cap-client-contract.test.mjs
npm run test:worker-bundle
```

The Worker suites (`tests/community-annotation-worker*.test.mjs`) cover route
inventory, methods, CORS and preflight caching, OAuth state, PKCE, callback
cookies and every sign-in outcome, exact request bodies and their
re-serialisation, page-by-page collections, the GraphQL queries, relayed reads
without a byte cut, relayed GitHub headers and conditional requests, the ref
force update and the caller binding of writes, read-only schema enforcement,
fixed CAP persisted queries and item projection, caller cancellation, the
stall clock on a virtual clock (a slow upload or download is never cut), the
CPU of a 1 MB publish, and the shared contract module.

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
  "contractVersion": 3,
  "endpoints": [
    "/auth/login",
    "/auth/callback",
    "/auth/revoke",
    "/auth/user",
    "/auth/installations",
    "/auth/installation-repos",
    "/cap/lookup-cells",
    "/graphql/snapshot",
    "/graphql/blobs",
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
3. For contributor fork publishing, the contributor forks the source on
   GitHub and installs the app on their own account with access to that fork
   (*All repositories*, or *Only select repositories* with the fork selected).
   The head branch and the user file are written in the fork with the user
   token, which reaches only repositories in accounts where the app is
   installed.
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
4. Select **Connect repo**, then **Continue with GitHub**.
5. Complete GitHub authorization and confirm that the browser returns to the
   same Cellucid dataset URL.
6. Confirm that the address bar contains no
   `cellucid_github_token`, `cellucid_github_token_expires_in`,
   `cellucid_github_error`, or `cellucid_github_auth` fragment.
7. In the connection dialog, confirm that every expected installation and
   repository appears.
8. Select the annotation repository, **Connect**, then **Pull latest**.
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
    publish once without a fork and confirm the **Fork on GitHub** message;
    fork on GitHub, publish again through the preselected `fork-pull-request`
    route and verify the deterministic branch, commit, and one new open Pull
    Request. Confirm that no source-repository write was attempted.
15. Sign out and confirm that the session token and user identity disappear
    from `sessionStorage`, that the browser sent `POST /auth/revoke` (answered
    `204`), and that the old token now fails at GitHub
    (`curl -H "Authorization: Bearer <token>" https://api.github.com/user`
    answers `401`).

The OAuth flow uses top-level redirects rather than pop-up APIs. Worker cookies
are secure, HTTP-only, host-only, short-lived, and used only on the callback
path. Each sign-in owns one state-specific cookie containing its exact return
URL and PKCE verifier, so concurrent tabs cannot overwrite or clear one
another's flow. The return URL is stored as it is, with only the characters a
cookie value cannot hold escaped. A browser keeps a cookie of at least 4,096
bytes (RFC 6265 6.1); when the complete owner cookie would be longer (a page
address of about 3,800 characters or more), the Worker does not start the
sign-in and sends the browser back to the page with the reason in the
callback fragment. These choices avoid browser pop-up and cookie-size failure
modes while keeping the flow consistent across the supported desktop
browsers.

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
again from Cellucid and complete it in the same browser session. (GitHub's
redirect right after installing the app carries no state by design; it ends on
the Worker's "installed" page, not here.)

### Sign-in reports GitHub's reason (for example "The code passed is incorrect or expired")

GitHub refused the code exchange; it answers such refusals under HTTP 200 with
an `error` document. The Worker shows GitHub's description and logs only the
error code (`Cellucid GitHub OAuth token exchange refused`, with the code and
status). `incorrect_client_credentials` means the `GITHUB_CLIENT_ID` or
`GITHUB_CLIENT_SECRET` secret does not match the GitHub App: re-enter both.
Any other code: start a new sign-in.

### No installations appear

Confirm that the signed-in GitHub user can access the installation, that the app
is installed on the intended account, and that the user authorized this exact
GitHub App. Cellucid lists every page, one GitHub page per Worker request; a
malformed page fails visibly rather than shortening the list.

### An installation appears but a repository does not

Confirm that the installation includes the repository and grants Metadata read
permission. For selected-repository installations, add the repository in the
GitHub App installation settings.

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

### Direct publish is denied

Confirm Contents write permission on the app, user Write access or higher on the
repository, branch rules, and the connected branch.

### Pull Request publish is denied

Confirm Pull requests write and Contents read/write permission, the app's
installation on the source account and on the contributor's account with
access to their fork, and the source repository's forking policy. The
operation remains on the preselected `fork-pull-request` route; correct the
reported permission or repository condition and start a new publish.

If the error says the same-name repository is not a fork of the source,
rename that unrelated repository (or rename your fork to the source's name).
Cellucid will not publish through a repository whose parent does not match
the connected source.

### Worker returns `502` or `504`

An upstream GitHub or CAP request could not be reached or returned a response
outside the current JSON contract (`502`), or nothing moved for 13 seconds
(`504`: GitHub's own request timeout plus a connection set-up). Check the
corresponding provider status and the Worker request outcome. The Worker does
not turn a partial or malformed response into a successful result. A GitHub
error keeps GitHub's own status (`401`, `403`, `404`, `409`, `422`, `429`,
`5xx`), with its rate-limit headers.

### A write is refused with `403` and outcome `not-applied`

The Worker binds writes to the signed-in user: a user file
`annotations/users/ghid_<n>.json` only by user `n`, a branch under
`cellucid-annotations/` only as the user's own
`cellucid-annotations/ghid_<id>/...` (created or moved only in the user's own
repository), a Pull Request only from such a branch of the user. Publishing
from Cellucid always meets these rules; a refusal means the request did not
come from Cellucid's publish flow for this user.

### Cloudflare reports `exceededCpu`

The request needed more CPU time than the plan allows (about 10 ms per request
on Workers Free). The checked-in Worker stays far below that (relayed reads are
not parsed; a 1,000,000-byte publish costs a few milliseconds), so first check
that the deployed source is the checked-in one. Retain the failing request
identity from the Worker logs. If the deployment must exceed the Free plan,
move the account to Workers Paid and add `"limits": { "cpu_ms": 1000 }` to
`wrangler.community-annotations.jsonc`.

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
- Revoke a user's GitHub App authorization when every token it issued must
  stop working (a single sign-in's token is revoked by **Sign out**, and
  expires by itself after 8 hours).
- Inspect Cloudflare logs without recording authorization headers, OAuth codes,
  access tokens, or cookie values.
- Keep the GitHub App callback list and `ALLOWED_ORIGINS` limited to active,
  HTTPS production and staging deployments plus intentional local origins.
