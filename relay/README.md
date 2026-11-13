# `relay/`: the Cellucid relay (Claude and ChatGPT reach the open tab)

**Owns:** the Cloudflare Worker that makes Cellucid a connector in Claude and ChatGPT
(web, desktop, mobile): a remote MCP server at its root, `https://mcp.cellucid.com` (the
connector address a person pastes), and its own OAuth 2.1 authorization server whose consent screen is the person's Cellucid tab. It carries tool calls to the tab
the person approved and the tab's answers back. **No accounts, no stored chats, no dataset
bytes.**

**Entry points:** `worker.js` (routes; exports the Durable Object classes), `oauth.js`
(metadata, authorize, token, the bearer check), `clients.js` (client metadata documents,
registration, how a client is shown), `mcp.js` (JSON-RPC), `pairing.js` (one Durable Object
per browser: tab sockets, calls in flight, connections), `approval.js` (one Durable Object
per pending authorization), `authorize-page.js` (the waiting page), `view-app.js` (the view
card: an MCP App, `ui://cellucid/view`), `generated/bundle.js` (generated from the web sources,
never edited by hand).

**The tab's side:** `assets/js/app/agent/bridge/` (`relay-client.js`, `relay-protocol.js`,
`tab-secret.js`, `connect-code.js`, `connect-fragment.js`, `mcp-tools.js`, `mcp-content.js`).

## Routes

| Route | Method | Who calls it | What it does |
| --- | --- | --- | --- |
| `/` | POST | Claude, ChatGPT, any MCP client, with a bearer token | The MCP endpoint. Streamable HTTP, one JSON-RPC message per POST, JSON answers: `initialize`, `ping`, `server/discover`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `resources/templates/list`, `subscriptions/listen`; GET and DELETE answer 405 (no stream, no session), with a sentence that says this is the connector address |
| `/health` | GET | anyone | Health: `status`, `contractVersion`, the MCP address, Cellucid version, catalog digest, endpoints |
| `/.well-known/oauth-protected-resource` | GET | MCP clients | Protected-resource metadata (RFC 9728) for the MCP endpoint; its `resource` is the bare origin |
| `/.well-known/oauth-authorization-server` | GET | MCP clients | Authorization-server metadata (RFC 8414) |
| `/oauth/register` | POST | MCP clients | Dynamic Client Registration (RFC 7591) |
| `/oauth/authorize` | GET | the person's browser, sent by the client | Checks the request, shows the waiting page with the connect code and "Open Cellucid to approve" |
| `/oauth/authorize/wait` | POST | the waiting page only | Long poll until the person allowed or denied in Cellucid (or cancel) |
| `/oauth/claim` | POST (credentialed CORS) | a Cellucid page on an allowed origin, with the browser's cookies | Claim a connect code as this browser: the tab secret names the pairing, the approver cookie the waiting page set proves it is the browser that shows the page; answers, as a socket reply, `{ok: true, value}` (who asks) or `{ok: false, error}` (`other-browser`, `unknown`, `claimed-elsewhere`, `decided`) |
| `/oauth/assets/authorize.js`, `/oauth/assets/authorize.css` | GET | the waiting page | Its script and style (served here, so the page's CSP is `script-src 'self'`) |
| `/oauth/token` | POST | MCP clients | `authorization_code` (PKCE S256) and `refresh_token` (rotating) |
| `/tab` | GET (WebSocket) | a Cellucid page on an allowed origin | The tab's socket, proven by its tab secret |

Anything else answers 404. The MCP endpoint is the root so that the connector address is the
bare origin. The MCP specification lists `https://mcp.example.com` as a canonical server URI;
for a server at the root, the protected-resource metadata lives at
`/.well-known/oauth-protected-resource` (RFC 9728 §3.1); and Claude requires the metadata's
`resource` to equal the address as the person typed it. No other route uses `/`, and every
other route has a path of its own, so nothing collides with it. The wire between tab and relay is documented in
`assets/js/app/agent/bridge/relay-protocol.js`.

## How a connection is made

1. The person adds `https://mcp.cellucid.com` (the relay's origin) as a connector in Claude or ChatGPT. The client's
   first call is answered `401` with `WWW-Authenticate: Bearer resource_metadata=…`; it
   reads the two metadata documents and identifies itself with a Client ID Metadata
   Document (Claude, Claude Code and ChatGPT publish one) or registers.
2. The client opens `/oauth/authorize` in the person's browser. The relay checks the client
   and its redirect URI (a failure is a page, never a redirect to an unchecked address),
   then PKCE S256, `response_type=code` and the resource (the relay's origin, with or
   without a trailing slash; a failure is sent back with `error`, `state` and `iss`: at
   once to claude.ai and chatgpt.com, and for any other app by a link on a page the person
   follows, since anyone can register a redirect URI of their own and an automatic redirect
   would make the relay an open redirect, RFC 9700 §4.11.2). It keeps the request under a fresh **connect
   code** (8 symbols of Crockford base32, 40 bits, ten minutes) in an `approval:<code>`
   Durable Object and shows the waiting page: who asks (Claude, ChatGPT, or the host that
   vouches for any other app, its own name only quoted), where the answer goes, the code, and
   **Open Cellucid to approve** (`https://www.cellucid.com/#cellucid_connect=<code>`). The
   page sets this browser's **approver cookie** (`__Host-cellucid-approver`: `HttpOnly`,
   `Secure`, `SameSite=Strict`, `Path=/`, ten minutes; one kept already is reused), whose
   digest the request keeps.
3. The Cellucid tab takes the code out of the address before any module runs
   (`connect-fragment.js`), connects to `/tab` (pairing this browser first if needed) and
   **claims** it with `POST /oauth/claim` (`credentials: 'include'`, its tab secret in the
   body): the browser adds the approver cookie, since www.cellucid.com and mcp.cellucid.com
   are one site, and the relay shows the tab who asks only when the cookie is the one of
   the browser that shows the page. A code or link someone sent from their own browser
   is refused (`other-browser`): the remote phishing of a device code (RFC 8628 §5.4),
   where an attacker's Claude would be connected to the person's tab, cannot happen. A
   code typed into a Cellucid tab of the same browser is claimed the same way; another
   browser or device cannot take it. The first pairing to claim a code is the only one
   that can decide it.
4. The person allows or denies in the tab. Allowing binds the request to that browser's
   pairing and makes a one-time authorization code; the waiting page, long-polling with a
   secret only it knows, sends the browser on to the client with `code`, `state` and `iss`
   (or `error=access_denied`). The page can also cancel.
5. The client exchanges the code at `/oauth/token` with its PKCE verifier and gets an access
   token (one hour) and a refresh token (each works once). The tab's connection list shows
   the new connection.
6. `tools/call` goes to the pairing's Durable Object, which sends it to the tab of that
   browser focused last. The tab runs the action through the dispatcher as the agent
   (`origin: 'agent'`, the agent's name, a turn), so the person's history records it and
   can undo the agent's whole turn. The answer comes back as MCP content.

## The view card (MCP Apps)

`ui://cellucid/view` (`view-app.js`, MCP Apps specification 2026-01-26) is what a host that
shows MCP Apps (Claude on the web and desktop, ChatGPT) draws beside two tools' results
(`VIEW_APP.tools` in `relay-protocol.js`; their tools carry `_meta.ui.resourceUri`): a picture
of the person's view (`view_picture`) and a dataset opened (`dataset_open`, for which the card
asks for the picture itself). Refresh draws the view as it is now; Open in Cellucid opens the
dataset's public link (what Share gives, passed in the result's `_meta['cellucid/view']`, which
hosts keep from the model), or Cellucid when there is none. It is one HTML document with its
script and style inline, and declares no domain: it reaches nothing but its host, and no
dataset bytes reach it or the relay (a picture is a result the tab drew). A host without MCP
Apps reads the tool's text and image content alone.

## Security model

- **One secret.** `RELAY_SIGNING_KEY` (256 bits or more) gives a separate HMAC-SHA-256 key
  per use (`keys.js`): pairing ids, registered client ids, access tokens, refresh tokens.
  Rotating it ends every connection and every registration; tabs pair again by themselves
  (same tab secret, new pairing id), and people approve their agents again.
- **Pairing without accounts.** A tab proves its 32-byte tab secret (kept in the browser's
  localStorage) in the WebSocket subprotocol header (a browser cannot set other headers on
  a WebSocket, and a URL would put it in logs). The relay derives
  `pairingId = HMAC(key, tabSecret)` and keeps neither. Every tab of one browser profile
  shares the pairing. **Forget** in Cellucid deletes the pairing's connections at the relay,
  closes every tab of it (`4001`) and deletes the secret in the browser. A connection that
  ends (removed in Cellucid, forgotten, closed after a refresh token was used twice, expired)
  ends its calls in flight too: the tab is told to stop each, and the agent is answered at once
  that the connection was removed during the call (`pairing.js` `endCalls`).
- **Tokens.** Signed, not stored: an access token names the issuer, the audience (this
  relay's origin, RFC 8707), the pairing, the connection and its expiry; the MCP endpoint accepts it
  only in the `Authorization` header (one in the address is refused), only when its
  signature, issuer, audience and expiry hold. A refresh token also carries its rotation
  count, checked against the connection kept by the pairing: each works once, and one used
  twice ends the connection (OAuth 2.1's sign of a stolen token). A connection unused for
  30 days ends.
- **Authorization codes** are random, kept in the approval object, bound to the client, the
  redirect URI, the resource, the PKCE challenge and the pairing, valid five minutes, used
  once (any attempt, even with a wrong verifier, uses one up).
- **Clients.** A client metadata document is fetched only from an https URL on the default
  port with a DNS host (no IP literal, no special-use name), a path and no query, fragment,
  dot segment or credentials, written exactly in its canonical form; no redirect is followed;
  the answer must be 200 JSON within 5 seconds and 5 KB (the size the draft recommends).
  It must name itself as `client_id`, list redirect URIs and carry no shared secret. A
  registered client's id is its redirect URIs, signed. Redirect URIs are https or loopback
  http; a loopback one matches on any port (RFC 8252, Claude Code). The person sees the
  host that vouches for the client (the document's host, or the https redirect's host) and
  where the answer goes; a client that is neither claude.ai nor chatgpt.com carries a
  warning and is named by that host (or "An app on this computer"), never by the name it
  gives itself, which is shown only in quotes ("evil.example, which calls itself “Claude”"):
  that name is what the waiting page and the tab's approval say; a call carries the app's
  own name with `known` (a grant's), and the tab names an unvouched app's steps, activity
  line and confirm cards as Manage… does ("evil.example (calls itself “Claude”)",
  `connect/model.js` `appName`), so two such apps are told apart.
- **One browser approves.** The approver cookie binds an authorization to the browser
  that shows its waiting page: only a claim that carries it (from an allowed Cellucid
  page, with credentialed CORS: the exact origin, never `*`) is answered. The `__Host-`
  prefix keeps any other cellucid.com host from setting or reading it, `HttpOnly` keeps
  it from scripts, `SameSite=Strict` keeps every other site's requests from carrying it.
  A local relay (`wrangler dev` on `http://localhost` or `http://127.0.0.1`) sets the same
  cookie: Chromium and Firefox keep a `Secure` cookie from a loopback address, Safari does
  not (use Chromium or Firefox there), and since cookies ignore ports the page and the
  relay must use the same loopback host name (both `localhost`, or both `127.0.0.1`).
- **Browsers.** `/tab` and browser calls to the MCP endpoint are accepted only from `ALLOWED_ORIGINS`
  (an `Origin` that is present and not allowed answers 403, which also stops DNS rebinding);
  metadata, registration and token answers carry `Access-Control-Allow-Origin: *` (no
  credentials). The waiting page has a strict CSP, cannot be framed and sends no referrer.
- **A question to the person.** When Cellucid asks the person about a call (a large download),
  the tab says so (`asking`); if they have not answered when the call's time runs out (225 s),
  the agent is told the person is being asked in Cellucid and to read the history once they
  answered, and the tab keeps the question open (`detach`) rather than withdraw it. MCP
  elicitation is not used: Cellucid asks in the tab, where the person sees what it is about.
- **A pairing that cannot answer** (its Durable Object restarting under a new deployment, or
  shed) answers a tool call with a sentence that says so and to read the history, a tool list
  with the bundled one, a cancellation as done: never a failed request. Tabs reconnect by
  themselves (the socket closes; `relay-client.js` dials again with growing waits).
- **A tab reloaded.** A call in flight when its tab closes is answered at once: whether it was
  done is not known, read the history before repeating a change. When the last tab of the
  pairing closed less than `TAB_RECONNECT_WAIT_MS` (20 s) ago, a call, a tool list or a status
  waits for a tab to be back and say which dataset it shows (`pairing.js` `targetSoon`): a
  reloaded page reaches the relay again within a few seconds (measured: `34_decisions_agents.md`), so the agent's next call runs
  in it instead of being told no tab is there.
- **What passes through.** Tool calls and results exist only in memory while in flight;
  nothing of them is stored or logged (errors log a name and a message only). Stored: per
  pairing, its connections (a digest of the client id, agent name, client name and host, times, rotation
  count); per pending authorization, the request (with the digests of the page's secret and
  of the approver cookie) for at most fifteen minutes. In the browser: the approver cookie,
  for ten minutes after a waiting page was shown.
- **Bounds on hostile input** (each says why in the code): request bodies (64 KiB for OAuth,
  4 MiB for MCP), a registered client id (8 KiB, so it fits an authorization URL under
  Cloudflare's 16 KB), the client document (5 KB, 5 s), a tool result's text (150,000
  characters, Claude's limit), a picture in a result (10 MiB of base64, Claude's image limit;
  the tab also leaves out one over 8000 pixels a side), a tool call's wait (225 s, under
  Claude's 240 s).
- **Abuse.** Origin checks are not authentication. On the Workers Free plan, abuse cannot
  create a bill: it can only use up the account's daily allowance (100,000 requests, reset at
  midnight UTC), after which Cloudflare answers with an error (1027) until the next day.
  Cloudflare's rate-limiting rules belong to a zone, so they cover the relay's custom domain
  (`mcp.cellucid.com`, in the `cellucid.com` zone) and never a `*.workers.dev` hostname: limit
  requests with a WAF rate-limiting rule for `/oauth/*` and `/tab` on that zone.

## Deploy (owner)

From the `cellucid` repository root, with Node.js 22.15 or newer:

```text
npm ci
npm test
npm run test:relay-bundle
npx --yes wrangler@4.115.0 login
npx --yes wrangler@4.115.0 deploy --config wrangler.relay.jsonc
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
npx --yes wrangler@4.115.0 secret put RELAY_SIGNING_KEY --config wrangler.relay.jsonc
npx --yes wrangler@4.115.0 secret put ALLOWED_ORIGINS --config wrangler.relay.jsonc
```

- `RELAY_SIGNING_KEY`: the line the `node` command printed.
- `ALLOWED_ORIGINS`: `https://www.cellucid.com`, comma separated, exact origins. A local
  development origin (`http://localhost:8000`) may be added for `/tab` and the MCP endpoint,
  but it cannot approve a connection here: the approver cookie travels only within the
  relay's site (`SameSite=Strict`), so local development approves against a local relay on
  the same loopback host (below).
- The first deploy creates the two Durable Object classes (migration `v1`, SQLite storage,
  available on the Workers Free plan). Until both secrets are set every route answers 500.
- The deploy also attaches the custom domain `mcp.cellucid.com` (`routes` in
  `wrangler.relay.jsonc`, `custom_domain: true`): Cloudflare creates its DNS record and
  certificate in the `cellucid.com` zone, which must be on the same account. The custom
  domain is the Worker's only address (`workers_dev: false`, `preview_urls: false`). A
  deployment of your own changes that `pattern` to a host in a zone you have, or removes
  `routes` and sets `workers_dev: true` to use its `workers.dev` address.
- Check `https://mcp.cellucid.com/health`: `"status": "ok"`, `"contractVersion": 2`, `"mcp"`
  the connector address. The page's relay address is `DEFAULT_RELAY_ORIGIN` in
  `relay-client.js`; it must be this Worker's address (`tests/relay-bundle-contract.test.mjs`
  checks it against `routes`).
- The connector address to add in Claude (Customize › Connectors › Add custom connector)
  and in ChatGPT (as a custom app or connector) is the relay's origin, exactly
  `https://mcp.cellucid.com`. The OAuth issuer and resource are the address a request
  reached, which is why the Worker answers at one address only.

Regenerate the bundle after changing an action, the instructions, the protocol or the
version: `node scripts/generate-relay-bundle.mjs` (`tests/relay-bundle-contract.test.mjs`
fails until then). A local relay: `npx --yes wrangler@4.115.0 dev --config wrangler.relay.jsonc`
with the secrets in `.dev.vars`, and on a local Cellucid page on the same loopback host name
(`http://localhost:8000` with `http://localhost:8787`: the approver cookie ignores ports but not
host names) `window.__CELLUCID_RELAY_ORIGIN__ = 'http://localhost:8787'` before the bridge starts;
approve in Chromium or Firefox (Safari keeps no `Secure` cookie from `http://localhost`).

**Live check** (after a deploy; not in CI, it needs the network): `node scripts/relay-live-check.mjs
[--relay https://<relay>] [--idle 90] [--port 8000] [--out results.json]` is the MCP client of the deployed
relay and a Chromium page of this checkout is the person's tab, in the relay's site as a claim
needs: served as `https://www.cellucid.com` (an allowed origin) for the deployed relay, or on
`http://127.0.0.1:<port>` for a local relay (`--relay http://127.0.0.1:8787`):
discovery, Dynamic Client Registration, PKCE, the waiting page shown in that browser (its approver
cookie), the approval link and a typed code approved in the tab, a link from another browser refused, both protocol eras, tool calls reaching the tab and back (a dataset opened, a coloring
recorded as the agent's step, a picture as image content, one too large left out), the view
card's resource, a call after the pairing has been idle (hibernated), refresh-token rotation and
reuse, ChatGPT's and Claude Code's client metadata documents, and Forget ending every
connection. It prints PASS or FAIL per check and no token.

## Listing in MCP directories (owner)

`server.json` here is the relay's entry for the official MCP Registry
(registry.modelcontextprotocol.io, schema `2025-12-11`), which other directories (GitHub's
MCP registry, VS Code, PulseMCP, Glama) read from. It names the remote
(`streamable-http`, `https://mcp.cellucid.com`) and the release; nothing is installed.
Its name is in the domain namespace `com.cellucid/`, proven by a DNS TXT record on the apex
`cellucid.com` (the registry's HTTP proof follows no redirect, and the apex redirects to
`www`). A published version cannot be changed: publish once per release, after the release's
deploy.

```text
brew install mcp-publisher            # or a release binary of modelcontextprotocol/registry
openssl genpkey -algorithm Ed25519 -out mcp-registry.pem   # OpenSSL 3, not macOS LibreSSL; keep it secret
openssl pkey -in mcp-registry.pem -pubout -outform DER | tail -c 32 | base64
# DNS (Cloudflare, zone cellucid.com): TXT on cellucid.com
#   v=MCPv1; k=ed25519; p=<the base64 line above>
mcp-publisher login dns --domain cellucid.com --private-key "$(openssl pkey -in mcp-registry.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
mcp-publisher validate relay/server.json
mcp-publisher publish relay/server.json
```

`tests/mcp-registry-contract.test.mjs` keeps the file in the registry's shape, its remote the
deployed address and its version the release. The Claude connector directory
(claude.ai/directory/manage) and ChatGPT's (platform.openai.com) take a submission with the
privacy policy (`https://www.cellucid.com/privacy.html`), the documentation
(`https://docs.cellucid.com/en/latest/user_guide/web_app/g_agents/02_connect_claude_and_chatgpt.html`),
a support contact and reviewer instructions; every tool already carries a title and
`readOnlyHint`, `destructiveHint` and `openWorldHint` (`mcp-tools.js`).

**Tests:** `tests/relay-oauth.test.mjs`, `tests/relay-mcp.test.mjs` (the Worker on an
in-memory Workers runtime, `tests/helpers/relay-runtime.mjs`),
`tests/relay-bundle-contract.test.mjs`, `tests/agent-relay-client.test.mjs`,
`tests/agent-bridge.test.mjs`; `npm run test:relay-bundle` (Wrangler dry run).
