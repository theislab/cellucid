# Google Drive and OneDrive setup

Google Drive and OneDrive files open in Cellucid with no server: the browser
signs in to Google or Microsoft and reads the file itself. What Cellucid needs
from Google and Microsoft is four public identifiers, kept in one module:

```
assets/js/data/sources/provider-config.js
  google.clientId        OAuth client ID (Web application)
  google.apiKey          API key, restricted to this site and to the Drive and Picker APIs
  google.projectNumber   Google Cloud project number (the Picker's app id)
  microsoft.clientId     Entra application (client) ID, single-page application
```

None of them is a secret. **No client secret is created, copied or stored
anywhere**: Google shows one for a Web client, and it is never used. While a
value is empty the app says "not configured on this site yet" for what needs
it; public Figshare items need nothing.

The design, with the facts it rests on, is
`cellucid-private/plans/drive-onedrive-figshare-2026-10-23.md`. The user-facing
page is `docs/user_guide/web_app/b_data_loading/16_private_drive_onedrive.md`
in `cellucid-python`; the privacy policy is `privacy.html` and the terms of use
`terms.html`, both linked from the home page's footer. The same setup, click by click for the site owner, is
`cellucid-private/guides/google-drive-and-onedrive-setup.md`.

## Google (about 40 minutes, plus DNS for brand verification)

1. In the [Google Cloud console](https://console.cloud.google.com/), create
   the project **Cellucid** (no organization, no billing account). Its
   **project number** (Welcome page, or IAM & Admin → Settings) is
   `google.projectNumber`; not the project ID.
2. **APIs & Services → Library**: enable **Google Drive API** and **Google
   Picker API**.
3. **APIs & Services → Credentials → Create credentials → API key**, named
   "Cellucid web", no service account:
   - Application restrictions: **Websites**:
     `https://www.cellucid.com/*`, `http://127.0.0.1:8765/*`,
     `http://localhost:8765/*`, `https://docs.google.com/*` (the Picker
     needs this one).
   - API restrictions: **Google Drive API** and **Google Picker API**.
   - Copy the key into `google.apiKey`.
4. **Google Auth Platform → Get started**: app name **Cellucid**, a support
   email, audience **External**, a contact email.
5. **Branding**: no logo (a logo forces a brand review), home page
   `https://www.cellucid.com`, privacy policy
   `https://www.cellucid.com/privacy.html`, terms of service
   `https://www.cellucid.com/terms.html`, authorized domain `cellucid.com`, a
   developer contact.
6. **Data Access**: add the one scope
   `https://www.googleapis.com/auth/drive.file`, listed under non-sensitive
   scopes. Nothing else.
7. **Audience → Publish app**: **In production**. With only `drive.file`
   there is no app verification and no user cap; *Testing* admits listed test
   users only, for 7 days.
8. **Clients → Create client → Web application**, named "Cellucid web":
   - Authorized JavaScript origins: `https://www.cellucid.com`,
     `http://127.0.0.1:8765`, `http://localhost:8765`, no trailing `/`.
   - No redirect URIs (the popup token model needs none).
   - Copy the **Client ID** into `google.clientId`. Do not copy the client
     secret. Google deletes a client unused for six months.
9. **Brand verification** (the consent screen names "Cellucid" instead of
   "cellucid.com"): verify `cellucid.com` as a **Domain** property in
   [Search Console](https://search.google.com/search-console) with the
   project owner's account (DNS TXT record at `@`, kept for good); then
   **Branding → Verify branding**, and **Publish branding** within 7 days of
   "Ready to publish". Google checks that the home page describes the app and
   links the privacy policy (the sidebar footer's **Privacy**), on the same
   domain.

The API key and the client share `provider-config.js`'s
`google.registeredOrigins`: Google matches an origin exactly, port included,
and has no port wildcard, so a public file and a sign-in work on the same
pages. On any other page Cellucid says where Drive works (a local
`cellucid serve` on another port, a notebook viewer on its free port, another
host) before any request.

Quotas: no billing account is needed. Every Drive read by any Cellucid user
counts against this one project (projects created after 2026-05-01: 1 TB of
egress and 400 M quota units a day; Google plans to charge above that later
in 2026, with 90 days' notice). If a billing account is ever added, set a
budget alert (**Billing → Budgets & alerts**). Watch **APIs & Services →
Google Drive API → Quotas** after launch.

## Microsoft (about 60 minutes; publisher verification separately)

1. A tenant you administer: for an individual, the one Microsoft offers is an
   Azure free account (card check; the tenant and the registration outlive the
   30-day subscription). In it, create a **work account** with the Global
   Administrator role and register with it: an app registered by a personal
   Microsoft account can never be publisher verified.
2. [entra.microsoft.com](https://entra.microsoft.com) → **Entra ID → App
   registrations → New registration**:
   - Name **Cellucid**.
   - Supported account types: **Any Entra ID Tenant + Personal Microsoft
     accounts** (older label: "Accounts in any organizational directory … and
     personal Microsoft accounts").
   - Redirect URI: platform **Single-page application**, value
     `https://www.cellucid.com/assets/auth/callback.html`.
3. **Authentication**:
   - Add the single-page application redirect URI
     `http://localhost/assets/auth/callback.html` (Microsoft ignores the port
     of `localhost`, so every `cellucid serve` port works).
   - In **Manifest**, add `"http://127.0.0.1/assets/auth/callback.html"` to
     `spa.redirectUris` (`127.0.0.1`, `cellucid serve`'s default host, can only
     be added there; the Microsoft Graph manifest replaced
     `replyUrlsWithType` in January 2025).
   - Leave implicit grant (access and ID tokens) and public client flows
     **off**.
   - Do not create a client secret or a certificate.
4. **API permissions → Microsoft Graph → Delegated**: `Files.Read`,
   `Files.Read.All`, `offline_access`, `openid` (`User.Read` stays). No
   `Files.ReadWrite…`, no application permissions, and no admin consent for
   your own tenant; `Files.Read.All` is asked for only when a work account
   opens a colleague's file.
5. **Branding & properties**: home page `https://www.cellucid.com`, terms of
   service `https://www.cellucid.com/terms.html`, privacy statement
   `https://www.cellucid.com/privacy.html`; a logo is optional.
6. Copy the **Application (client) ID** into `microsoft.clientId` (not the
   directory or object ID).
7. **Publisher verification** (optional, for work accounts): verify the custom
   domain `cellucid.com` in the tenant (DNS TXT), set it as the app's
   publisher domain, join the Microsoft AI Cloud Partner Program (an
   organisation, with an email at that domain), then enter the Partner One ID
   under **Branding & properties**, signed in with the work account and MFA.
   Without it, organisations with risk-based step-up consent block their users
   from consenting; `Files.Read.All` needs an administrator under Microsoft's
   default consent policy either way.

Microsoft accepts plain `http://` only for `localhost` and `127.0.0.1`, and a
browser computes PKCE only on a secure page, so a plain `http://` page on
another host is refused before the popup. The popup reports back over a
`BroadcastChannel`, which a page embedded in another site (a notebook at
`localhost` showing a viewer at `127.0.0.1`) cannot hear: Cellucid refuses
that case before the popup when the sites can be told apart, and a popup
closed without a sign-in ends the attempt.

## After both

1. Paste the four values into `assets/js/data/sources/provider-config.js`,
   regenerate the asset inventory (`node scripts/generate-web-asset-inventory.mjs`)
   and run `npm test`.
2. Run the checks below with real accounts.
3. If the real Picker needs a host the fakes did not (a `gstatic.com` script, a
   frame host), add it to the `Content-Security-Policy` in `index.html` and to
   `tests/seo-head-contract.test.mjs` in the same change.
4. Record in `cellucid-private/plans/measurements/` the measured OneDrive
   download-URL lifetime, the Drive quota units per range read, and the
   cold-open round trips.

## Checks only real accounts can make

1. Consent screens and their wording, Google's and Microsoft's.
2. Google: the Picker opens already showing the pasted file
   (`DocsView.setFileIds`); **Select** grants it; the CSP lets the Picker
   load (scripts and frames); Safari with tracking prevention; a file in a
   shared drive (`supportsAllDrives`).
3. Google: a `drive.file` grant persists after the tab is closed and a new
   token is issued (the file then opens without the Picker); whether picking a
   folder grants its files (folders are refused either way).
4. Google: whether a ranged `files.get?alt=media` counts 5 or 200 quota units
   (Cloud console metrics), and the egress counter.
5. Google: a public file opens with no sign-in on www.cellucid.com, and is
   refused with the referrer restriction from another origin.
6. Microsoft: `/shares/{id}/driveItem` with `Files.Read` alone and `Prefer:
   redeemSharingLink` (personal and work). The Graph reference names
   `Files.ReadWrite` as its least permission; if `Files.Read` is refused, the
   scopes change in code, docs and the registration together. The file
   appears in "Shared with me"; CORS and `Range` on the `@microsoft.graph.downloadUrl` host for
   personal (`*.microsoftpersonalcontent.com`) and work
   (`<tenant>-my.sharepoint.com`); how long a download URL works.
7. Microsoft, work tenant with the default consent policy: a colleague's file
   asks for **Ask for access**, Microsoft shows "Need admin approval", and the
   administrator's consent then lets it open; a guest opening another
   organisation's file.
8. Microsoft: a personal "anyone" link opened by a work account, and the
   reverse.
9. Microsoft: the sign-in renews without a click within 24 hours (the access
   token expires after about an hour), and asks for **Sign in again** after.
10. Both: reload the tab (still signed in), close it and open a new one
    (signed out); a session saved with a Drive or OneDrive file reopens after
    signing in; `?data=gdrive:<id>` and `?data=onedrive:<drive>/<item>` links
    open for a collaborator the file is shared with, and are refused, with the
    reason, for an account it is not shared with.
11. Where each works: `cellucid serve` at `http://127.0.0.1:8765` (Microsoft
    only if the `127.0.0.1` manifest entry saved), another port, a notebook
    viewer on its free port and with `AnnDataViewer(data, port=8765)`, from a
    notebook at `localhost` and at `127.0.0.1`; each refusal is the message
    `google.js` / `microsoft.js` give for that page.
