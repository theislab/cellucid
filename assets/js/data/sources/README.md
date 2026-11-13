# `data/sources/`: links, providers, sign-in, file identity

What a link or a catalog entry names, how its bytes are reached, and which
version of it is being read. The data-source classes that use these
(`link-source.js`, `local-demo-source.js`, `remote-source.js`,
`viewer-host-source.js`, `anndata-file-source.js`) live one folder up in
`data/`.

| Module | Owns |
| --- | --- |
| `registry.js` | The providers and the `?data=` locators that name them (`ProviderRegistry`, `getProviderRegistry`, `formatLocator`, `publicLocatorOf`). Add a host here and in `providers/`. |
| `providers/<host>.js` | One host each: `cellxgene` (Census S3 `.h5ad` copies), `dropbox`, `figshare`, `gdrive`, `geo` (NCBI FTP over HTTPS), `github`, `http` (any address), `huggingface`, `onedrive`, `zenodo`. A provider resolves a locator to files (address, size, version) and never reads matrix bytes itself. |
| `remote-file.js` | One file on a web host described without downloading it (`describeRemoteFile`: format, exact size, identity, whether ranges are served); `downloadRemoteFile` for hosts that serve no ranges (resumes a cut body from its byte). |
| `anndata-catalog.js` | A dataset catalog (`datasets.json` and the files it lists). |
| `identity.js` | **The** identity and version rule every keeper files under (kept stores, kept parts, the page's range cache, Zarr store objects): `fileIdentityOf`, `persistsAcrossVisits`, `strongEtag`. |
| `link-credentials.js` | A link's two forms: what it is read with, and what it may be shown or kept as (`publicLink`, `linkIdentity`): tokens and signatures never reach logs, sessions or identities. What a kept directory is filed under, so the code fingerprints of kept data cover it: only what says what a link is lives here. |
| `link-text.js` | What a message says of a link, built on the public form: `textWithPublicLinks` (every address in a text made public), `linkLeavesOutParts`. Apart from `link-credentials.js`, so that wording a link changes no code fingerprint. |
| `access.js` | Access of files behind a sign-in or an expiring link, owned by the page; registered once a file is described, released with the source that reads it (or an opening not adopted); revocation. |
| `api-request.js` | One JSON request to a provider API (Drive, Graph, Figshare) with the byte layer's retry rules. |
| `auth/` | Google and Microsoft sign-in with no server (`google.js`, `microsoft.js`, `pkce.js`), the tab's token store (`token-store.js`, `sessionStorage` only), sign-in steps waiting on the person (`sign-in.js`). |
| `provider-config.js` | Public client identifiers for Drive and OneDrive. |

## Invariants

- Only a file whose identity names a version is kept across visits
  (`persistsAcrossVisits`); a file known by its size alone may change under it.
- Credentials (tokens, signed query parameters) never enter an identity, a
  log, a URL the page shows, `localStorage` or a session.
- Feature state never goes into URL parameters; a link names a dataset (and
  optionally the cells to open), nothing else.
- Be gentle with public hosts: one request stream per host, pacing by the
  host's own rate-limit headers (`formats/io/hosts.js`).

## Tests

`tests/data-link-providers-contract`, `tests/link-*`, `tests/source-*`
(access, providers, sign-in, sign-out); find others with
`grep -l "data/sources/" tests/*.test.mjs`. Developer doc 09 (data loading)
has the per-source pipeline.

## Decision records

Why this code is the way it is (dated decisions, measurements per engine,
what was tried and reverted, open items): `cellucid-python/docs/user_guide/web_app/p_developer_docs/22_decisions_link_model_and_request_planning.md`. Update them in the same change as the code.
