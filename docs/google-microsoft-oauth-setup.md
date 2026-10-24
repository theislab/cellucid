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
in `cellucid-python`; the privacy policy is `privacy.html`.

## Google (about 30 minutes)

1. In the [Google Cloud console](https://console.cloud.google.com/), create
   the project **Cellucid**. Note its **project number** (Dashboard → Project
   info): it is `google.projectNumber`.
2. **APIs & Services → Library**: enable **Google Drive API** and **Google
   Picker API**.
3. **Google Auth Platform → Branding**:
   - App name **Cellucid**, a support email, a logo (optional; a logo triggers
     Google's brand review, 2-3 days).
   - Home page `https://www.cellucid.com`.
   - Privacy policy `https://www.cellucid.com/privacy.html`.
   - Authorized domain `cellucid.com`, verified in Google Search Console with a
     DNS TXT record.
4. **Audience**: user type **External**, publishing status **In production**.
   With only `drive.file`, a non-sensitive scope, there is no review and no
   user cap.
5. **Data access**: add the one scope
   `https://www.googleapis.com/auth/drive.file`. Nothing else.
6. **Clients → Create client → Web application**, named "Cellucid web":
   - Authorized JavaScript origins: `https://www.cellucid.com`,
     `http://127.0.0.1:8765`, `http://localhost:8765` (the default port of
     `cellucid serve`; Google matches ports exactly, so other local ports
     cannot sign in to Google, and the app says so).
   - No redirect URIs (the popup token model needs none).
   - Copy the **Client ID** into `google.clientId`. Do not copy the client
     secret.
7. **APIs & Services → Credentials → Create credentials → API key**, named
   "Cellucid web":
   - Application restrictions: **Websites**:
     `https://www.cellucid.com/*`, `http://127.0.0.1:8765/*`,
     `http://localhost:8765/*`, `https://docs.google.com/*` (the Picker
     needs this one).
   - API restrictions: **Google Drive API** and **Google Picker API**.
   - Copy the key into `google.apiKey`.
8. **Billing → Budgets & alerts**: set a budget alert. Every Drive read by any
   Cellucid user counts against this one project (projects created after
   2026-05-01: 1 TB of egress a day, 400 M quota units a day; Google plans to
   charge for overage later in 2026). Watch **APIs & Services → Google Drive
   API → Quotas** after launch.

## Microsoft (about 30 minutes; publisher verification separately)

1. Sign in to [entra.microsoft.com](https://entra.microsoft.com) with a
   **work or school** account in a tenant you control (an app registered with
   a personal Microsoft account can never be publisher verified). Add and
   verify the custom domain `cellucid.com` (DNS TXT).
2. **App registrations → New registration**:
   - Name **Cellucid**.
   - Supported account types: **Accounts in any organizational directory and
     personal Microsoft accounts**.
   - Redirect URI: platform **Single-page application**, value
     `https://www.cellucid.com/assets/auth/callback.html`.
3. **Authentication**:
   - Add the single-page application redirect URI
     `http://localhost/assets/auth/callback.html` (Microsoft ignores the port
     of `localhost`, so every `cellucid serve` port works).
   - In **Manifest**, add to `replyUrlsWithType`:
     `{"url": "http://127.0.0.1/assets/auth/callback.html", "type": "Spa"}`
     (`127.0.0.1` can only be added there; it is `cellucid serve`'s default
     host).
   - Leave implicit grant and public client flows **off**.
   - Do not create a client secret or a certificate.
4. **API permissions → Microsoft Graph → Delegated**: `Files.Read`,
   `Files.Read.All`, `offline_access`, `openid`. Do not grant admin consent
   for your own tenant unless you mean to; `Files.Read.All` is asked for only
   when a work account opens a colleague's file.
5. **Branding & properties**: publisher domain `cellucid.com`, home page
   `https://www.cellucid.com`, privacy statement
   `https://www.cellucid.com/privacy.html`, a logo.
6. **Publisher verification** (recommended, for work accounts): join the
   Microsoft AI Cloud Partner Program (free), complete its business
   verification, then enter the Partner One ID under **Branding & properties →
   Publisher verification** (needs Application Administrator plus Partner
   Admin, and MFA). Without it, organisations with risk-based step-up consent
   block their users from consenting.
7. Copy the **Application (client) ID** into `microsoft.clientId`.

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
6. Microsoft: `/shares/{id}/driveItem` with `Files.Read` and `Prefer:
   redeemSharingLink` (personal and work); the file appears in "Shared with
   me"; CORS and `Range` on the `@microsoft.graph.downloadUrl` host for
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
