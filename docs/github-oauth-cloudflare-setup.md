# GitHub OAuth and Cloudflare Worker Setup

Cellucid community annotations use a GitHub App user access token. A Cloudflare
Worker performs the OAuth code exchange and proxies the repository API calls
used by the browser. The GitHub client secret is never shipped with Cellucid.

This guide describes the complete current deployment. The checked-in source,
configuration, and executable contract tests are:

- `assets/js/app/community-annotations/_worker-code.js`
- `assets/js/app/community-annotations/wire-contract.js`
- `wrangler.community-annotations.jsonc`
- `tests/community-annotation-worker-contract.test.mjs`

## Current HTTP contract

The Worker exposes only these routes:

| Route | Method | Authentication | Purpose |
| --- | --- | --- | --- |
| `/` | `GET` | None | Health response and route inventory |
| `/auth/login` | `GET` | None | Start OAuth with an explicit `return_to` URL |
| `/auth/callback` | `GET` | OAuth state, PKCE verifier, and GitHub code | Complete OAuth |
| `/auth/user` | `GET` | GitHub bearer token | Return `{id, login}` |
| `/auth/installations` | `GET` | GitHub bearer token | Return every accessible app installation |
| `/auth/installation-repos` | `POST` | GitHub bearer token | Return every repository in one installation |
| `/api/repos/*` | `GET`, `POST`, or `PUT` | GitHub bearer token | Proxy the repository API calls used by Cellucid |

OAuth state, return URL, and PKCE verifier are stored in secure, HTTP-only,
`SameSite=Lax` cookies for ten minutes. The callback returns exactly one access
token or error in the Cellucid URL fragment. Cellucid removes that fragment
immediately and stores the token in `sessionStorage`.

All request and response bodies are JSON with duplicate-key detection. Unknown
installation-request fields, wrong JSON types, malformed GitHub responses,
incomplete pagination, disallowed origins, unsupported routes, and unsupported
methods fail visibly.

## 1. Prepare Cloudflare

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

The user access token can perform an action only when both the GitHub App and
the signed-in user have the required permission. Cellucid does not use a GitHub
App private key, App JWT, or installation access token.

Official GitHub references:

- [Generating a GitHub App user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Choosing GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [Create a fork endpoint permissions](https://docs.github.com/en/rest/repos/forks?apiVersion=2026-03-10#create-a-fork)

## 3. Configure Worker secrets

The Worker requires exactly three Cloudflare bindings:

| Binding | Value |
| --- | --- |
| `ALLOWED_ORIGINS` | Comma-separated Cellucid HTTP(S) origins |
| `GITHUB_CLIENT_ID` | Client ID from the GitHub App settings page |
| `GITHUB_CLIENT_SECRET` | Client secret generated for the GitHub App |

`ALLOWED_ORIGINS` is exact:

- Include only origins: scheme, host, and explicit non-default port.
- Do not include a path, query, fragment, credentials, or trailing slash.
- Separate multiple origins with commas and no surrounding whitespace.
- Do not use `*`.
- Include each local Cellucid origin that will call the deployed Worker.

From the `cellucid` repository root, authenticate Wrangler and enter the actual
value when each command prompts:

```text
npx wrangler login
npx wrangler secret put ALLOWED_ORIGINS --config wrangler.community-annotations.jsonc
npx wrangler secret put GITHUB_CLIENT_ID --config wrangler.community-annotations.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --config wrangler.community-annotations.jsonc
```

Wrangler stores all three values as remote encrypted secrets rather than in the
configuration file or repository. The Worker validates all three bindings on
every request, including the health route, and returns `500` when any value is
missing or inexact. A dry run validates the source and configuration but cannot
retrieve or validate remote secret values.

Official Cloudflare references:

- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## 4. Run the local contract gates

Use Node.js 20 or newer. The tests execute the Worker directly with mocked
GitHub responses and do not modify Cloudflare or GitHub:

```text
node --test tests/community-annotation-worker-contract.test.mjs
node --test tests/community-annotation-wire-contract.test.mjs
npx wrangler deploy --dry-run --config wrangler.community-annotations.jsonc
```

The Worker suite covers route inventory, methods, CORS, OAuth state, PKCE,
callback cookies, exact request bodies, duplicate JSON keys, complete
pagination, response projections, repository proxy authorization, and
read-only schema enforcement.

For a local Worker process, create an untracked `.dev.vars` file beside the
Wrangler configuration. Put exactly the three binding assignments listed
above, with their real values, in dotenv syntax. Then run:

```text
npx wrangler dev --config wrangler.community-annotations.jsonc
```

`.dev.vars*` and `.env*` are ignored by this repository. Do not commit either
file. OAuth itself uses the callback URL registered in GitHub, so use the
deployed Worker for the final browser test.

## 5. Deploy

From the `cellucid` repository root:

```text
npx wrangler deploy --config wrangler.community-annotations.jsonc
```

Record the exact HTTPS URL printed by Wrangler. Opening its root route must
return:

```json
{
  "status": "ok",
  "service": "Cellucid GitHub Auth",
  "endpoints": [
    "/auth/login",
    "/auth/callback",
    "/auth/user",
    "/auth/installations",
    "/auth/installation-repos",
    "/api/repos/*"
  ]
}
```

A source edit does not update a running Worker. Run this deployment after every
accepted Worker-source change, then execute the root-route and browser checks
against the printed production URL. Do not describe the live Worker as updated
until those checks pass against that URL.

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
9. Add one annotation and run **Publish** with a user who can write directly.
   Confirm the result reports the `direct` route.
10. Pull again and confirm the new user document.
11. With a contributor account that cannot write to the source repository,
    publish through the preselected `fork-pull-request` route and verify the
    resulting fork, deterministic branch, commit, and one new open Pull
    Request. Confirm that no source-repository write was attempted.
12. Sign out and confirm that the session token and user identity disappear
    from `sessionStorage`.

The OAuth flow uses top-level redirects rather than pop-up APIs. Worker cookies
are secure, HTTP-only, short-lived, and used only on the callback path. These
choices avoid browser pop-up policies and keep the flow consistent across the
supported desktop browsers.

## Exact failure diagnosis

### Worker root returns `500`

One or more required bindings is missing or inexact. Re-enter all three secrets.
For `ALLOWED_ORIGINS`, remove spaces, paths, trailing slashes, duplicates, and
wildcards.

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
sets.

### An installation appears but a repository does not

Confirm that the installation includes the repository and grants Metadata read
permission. For selected-repository installations, add the repository in the
GitHub App installation settings.

### Pull is denied

Confirm Metadata read and Contents read access for both the app and the user.
For a private organization repository, also confirm the user's organization and
SSO access.

### Direct publish is denied

Confirm Contents write permission on the app, user Write access or higher on the
repository, branch rules, and the connected branch.

### Pull Request publish is denied

Confirm Pull requests write permission, Administration write and Contents
read/write, app installation on source and destination accounts,
source-repository forking policy, and destination repository access. The
operation remains on the preselected `fork-pull-request` route; correct the
reported permission or repository condition and start a new publish.

### Worker returns `502`

The GitHub request failed, timed out, or returned a response outside the current
JSON contract. Inspect Cloudflare Worker logs and the GitHub API status. The
Worker does not turn a partial or malformed response into a successful result.

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
