# Contributing to Cellucid (Web App)

Contributions are welcome — code, docs, bug reports, performance investigations, and UX feedback.

This file focuses on the **Cellucid web app** (the browser UI + state layer + WebGL renderer) in the `cellucid/` repo.

By participating, you agree to follow the project’s Code of Conduct:
- `CODE_OF_CONDUCT.md`

If you’re reporting a security issue, please follow:
- `SECURITY.md`

## This file is the authoritative web-app guide

Everything below — repository routing, bug reports, development setup, the code
map, the coding rules, testing, and pull requests — is specified here, in the
repository it describes.

The documentation site carries a companion page,
`cellucid-python/docs/contributing/web_app.md`. It is **not** a copy of this
file and this file is not generated from it. That page owns only what exists on
the documentation site: how to write and build the web-app documentation pages,
and the conventions that span every Cellucid repository (the canonical
`www.cellucid.com` versus bare-apex URL forms, and the `CELLUCID_VERSION`
markers). Both of those apply when you change this repository, so read that
page before touching a URL or a hardcoded version here.

Where the two files reference the same page, they write it differently on
purpose: this file is read on GitHub, so it uses repository-relative paths with
their `.md` extension, while the documentation site uses Sphinx `{doc}` roles,
which do not render on GitHub. That is a rendering difference, not a
disagreement.

---

## Which repo should I contribute to?

Cellucid is split by responsibility:

| Repo | What it is | Contribute here when you… |
|---|---|---|
| `cellucid` (this repo) | Web app (UI + state + WebGL rendering) | are fixing UI bugs, rendering/performance, figure export, sessions, or community annotation frontend |
| `cellucid-python` | Python package + CLI + Sphinx docs | are fixing `prepare`/`serve`/`show_anndata`, server endpoints, Jupyter hooks, or documentation site pages |
| `cellucid-r` | R package writing the same Cellucid-ready AnnData from R | are changing the R writer (`cellucid_prepare()`) or adding R-side docs/tests |
| `cellucid-annotation` | GitHub repo template for annotation | are changing repo schema/validation/workflows |
| `cellucid-datasets` | The published demo catalog | are correcting a published generation or its catalog entry |
| `cellucid-demo-custom-datasets` | Worked example of publishing your own datasets | are changing that guide or its synthetic examples |

If you’re unsure where a bug belongs, open an issue in the repo you’re currently using and include:
- where the UI ran (hosted app vs local app vs Jupyter iframe),
- how data was loaded (H5AD, Zarr folder, Zarr ZIP, sample dataset, link,
  remote server, or Jupyter),
- and the smallest reproduction you can share.

---

## Fast paths

### I want to report a UI/rendering bug

Include:
- browser + version, OS
- hosted (`https://www.cellucid.com`) vs local app (`http://localhost:8000`) vs Jupyter iframe
- dataset source type (local-demo/local-user/remote/github/jupyter)
- exact steps to reproduce
- expected vs actual behavior
- artifacts:
  - screenshot or screen recording (redact private paths/repo names)
  - browser console logs (enable debug: `localStorage.setItem('CELLUCID_DEBUG','true'); location.reload()`)
  - if relevant: performance profile (DevTools Performance tab)

### I want to work on docs for the web app

The main documentation site is built from `cellucid-python/docs/` and includes:
- end-user web app docs: `cellucid-python/docs/user_guide/web_app/`
- developer web app docs: `cellucid-python/docs/user_guide/web_app/p_developer_docs/`

If you change UI/behavior, prefer updating docs there (so users can find it on ReadTheDocs).

A documentation change is therefore a pull request against `cellucid-python`,
not against this repository. How to write those pages, and how to build the
site (`-W`, so warnings are errors), is in
`cellucid-python/docs/contributing/web_app.md`.

### I want to contribute code

Start with:
- `cellucid/README.md` (end-user overview)
- `cellucid/assets/js/app/README.md` (app-layer architecture)
- `cellucid/assets/css/README.md` (CSS design system)

For deep developer documentation:
- `cellucid-python/docs/user_guide/web_app/p_developer_docs/index.md`

---

## Development setup (web app)

### Run locally (static server)

From the `cellucid/` directory:

```bash
python -m http.server 8000
```

Then open:
- `http://localhost:8000`

Why:
- the app uses native ES modules (`<script type="module">`)
- `file://` access will break imports/fetches in confusing ways

### Enable debug logging (recommended)

In DevTools → Console:

```js
localStorage.setItem('CELLUCID_DEBUG', 'true');
location.reload();
```

Disable:

```js
localStorage.removeItem('CELLUCID_DEBUG');
location.reload();
```

---

## Code organization (where to change what)

High-level map:

- `cellucid/index.html`: app shell (sidebar DOM + canvas + boot scripts)
- `cellucid/assets/js/app/`: app layer (state + UI + sessions + analysis)
  - `app/main.js`: bootstrap orchestrator
  - `app/state/`: `DataState` + managers (fields/filters/colors/highlights/views)
  - `app/ui/`: UI coordinator + sidebar modules
  - `app/session/`: `.cellucid-session` save/load bundles
  - `app/ui/modules/figure-export/`: figure export
  - `app/community-annotations/`: GitHub-backed community annotation sync/auth
- `cellucid/assets/js/data/`: data sources + loaders (AnnData `.h5ad`/Zarr/`.zarr.zip` files, links and catalogs, `cellucid serve`, Jupyter)
  - `data/anndata/`: the one AnnData reader (elements, data frames, dense and sparse matrices) over any store
  - `data/sources/`: dataset catalogs (`datasets.json`, `anndata-catalog.js`) and link providers
- `cellucid/assets/js/formats/`: file-format readers with no Cellucid knowledge — `hdf5/`, `zarr/` (v2 and v3, folder/ZIP/HTTP stores), `zip/`, and `io/` (byte sources, range reads, the decode worker pool)
- `cellucid/assets/js/rendering/`: WebGL2 viewer + shaders + overlays
- `cellucid/assets/js/workers/`: `worker-script.js`, where every worker starts from (`startWorker`)
- `cellucid/assets/workers/`: generated worker bundles and `scripts.js` (never edited; see Testing & validation)
- `cellucid/assets/css/`: design system (tokens/themes/components)

---

## Coding guidelines (web app)

### Performance invariants (treat these as “hard rules”)

- Avoid per-frame DOM work.
- Avoid hot-path allocations in per-point/per-frame loops (reuse typed arrays / scratch buffers).
- Keep orchestration in `main.js`; keep heavy logic in state managers and renderer.
- Prefer incremental viewer updates (`updateColors`, `updateTransparency`, `updatePositions`) over full reloads.

### UI modularity

- UI modules should own their DOM subtree and wire events.
- Cross-module communication should prefer `DataState` events and UI coordinator callbacks.
- Add new DOM ids to the DOM cache (`app/ui/core/dom-cache.js`) rather than scattering selectors.

### CSS design system

Follow:
- `cellucid/assets/css/README.md`

Rules:
- no inline styles in `index.html`
- no raw hex outside token files
- use semantic tokens + utilities

Validation scripts:

```bash
node scripts/validate-token-types.js
node scripts/validate-tokens.js
```

---

## Testing & validation

Node.js 22.15 or newer is required (`package.json` sets `engines.node`): the
Zstandard contracts compress their inputs with `node:zlib`'s Zstandard encoder,
which Node.js 20 does not have. Install the exact dependencies once, then run
the suites:

```bash
npm ci
npm test                    # every web contract in tests/*.test.mjs
npm run test:browser        # Playwright suites in tests/browser/
npm run test:worker-bundle  # dry-run build of the community-annotation Cloudflare Worker
```

After changing any shipped file (`index.html`, `assets/`, root assets), run
`node scripts/generate-web-asset-inventory.mjs` (after `npm ci`: it builds the
worker bundles with the pinned esbuild). It rewrites
`cellucid-web-assets.json` and stamps the build id in `index.html` as
`<date>.<digest>`, a digest of every shipped file, so the footer, the situation
report and the Python web cache name the exact build. It also writes
`sitemap.xml`, whose `<lastmod>` is the date half of that build id, and
`.well-known/security.txt`, whose `Expires` is a year after it. `npm test`
fails until it has been run.

The same run gives every script a URL that names its bytes, so a deploy can
never pair a module cached from the previous build with one of the next
(GitHub Pages caches every file for ten minutes and ignores query strings).
Each page that runs ES modules declares one `<script type="importmap">`; the
generator fills it with every `assets/**/*.js` mapped to
`<path>?v=<first 12 hex digits of its SHA-256>`, adds the same `?v=` to each
`<script src>` of every shipped page, and writes the `script-src` hashes of
each page's inline scripts (the import map, the JSON-LD block) into its
Content-Security-Policy. Nothing of this needs a build step to run: a static
server ignores the query, so an edited module loads before the generator has
run; after it, every changed module has a new URL and a plain reload loads it.

Workers get no import map, so the same run builds each worker (and each module
a worker imports by URL), listed in `WORKER_ENTRIES` of
`scripts/build-worker-bundles.mjs`, into one file named by its bytes:
`assets/workers/<name>.<first 12 hex digits of its SHA-256>.js`, with a source
map back to the sources, and writes `assets/workers/scripts.js`, the URL of
each. That folder is generated only: never edit it, and commit it with the
sources (GitHub Pages builds nothing). A page served under any name but
`localhost`, `127.0.0.1` or `[::1]` starts its workers from the bundles; on this
machine they start from their sources (`assets/js/workers/worker-script.js`),
so an edited worker module is live on the next reload with nothing built, and
`http://deployed.localhost:<port>/` opens a local server's tree as a deployed
site. A new worker is started with `startWorker(<entry>Script(), …)` once its
entry is in `WORKER_ENTRIES`; `npm test` refuses a worker started any other
way, and bundles that are not exactly what the sources build
(`tests/worker-bundles-contract.test.mjs`). Run
`CELLUCID_BROWSER_TEST_APP_HOST=deployed.localhost npm run test:browser -- <specs>`
to run browser specs as a deployed site (a spec that holds a module a worker
imports by its source path runs from `127.0.0.1` only).

What search engines and link previews read — the `<head>` metadata, the JSON-LD
block and its hash in the Content-Security-Policy, the visually hidden "About
Cellucid" text, `robots.txt`, `sitemap.xml`, `404.html`, the reading pages
(`privacy.html`, `terms.html`, `accessibility.html`), `.well-known/security.txt`,
`llms.txt` and `site.webmanifest` — is pinned by
`tests/seo-head-contract.test.mjs`.

`npm test` runs `scripts/run-web-tests.mjs`, which discovers every
`tests/*.test.mjs` file and runs them under the Node.js test runner — so a new
contract file is picked up by adding it, with nothing to register. These are
the same commands `.github/workflows/test.yml` runs, so a green local run is the
same check CI applies:

- `npm test` runs on Ubuntu, macOS, and Windows across Node 22/24/26, with
  `cellucid-datasets` (its catalog and session presets) checked out beside the
  repository so the cross-repository session-preset contracts run.
- On every push and pull request the browser suite runs chromium, firefox, and
  webkit on Ubuntu, plus webkit on macOS. Every engine on every operating
  system runs nightly and on manual dispatch (**Actions → Web contracts → Run
  workflow**).
- A failed browser job uploads its Playwright screenshots and error context as
  a workflow artifact.

### Running two browser suites at once

`npm run test:browser` binds two loopback ports: `4173` for the application and
`4174` for the same tree with permissive CORS. A second run on the same machine
would collide, so it reports the taken address and stops rather than waiting on
it. Move it instead:

```bash
CELLUCID_BROWSER_TEST_PORT=4183 npm run test:browser
```

`CELLUCID_BROWSER_TEST_SAMPLE_PORT` defaults to `CELLUCID_BROWSER_TEST_PORT + 1`
and can be set separately. Both the servers and the specs resolve the address
from `scripts/browser-test-ports.mjs` — the specs through
`tests/browser/helpers/origins.mjs` — so a moved run also fetches its fixtures
from the port it was moved to. Failure artifacts go to `test-results/<port>/`,
so concurrent runs do not overwrite each other's evidence.

A new browser spec must take its origins from `tests/browser/helpers/origins.mjs`
rather than writing an address down; `tests/browser-test-port-contract.test.mjs`
fails on a reintroduced literal.

Automated coverage does not replace manual smoke testing of the interactive
surface. Run through this checklist for any change a user can see:
- load a dataset (local-demo or local-user)
- switch categorical/continuous/gene fields
- apply filters and confirm visibility updates
- create highlights and switch highlight pages
- create a snapshot view (“Keep view”) and confirm multiview works
- save and load a `.cellucid-session`
- run at least one analysis plot
- export a PNG and an SVG

More detailed checklist:
- `cellucid-python/docs/user_guide/web_app/p_developer_docs/14_testing_ci_and_release_process.md`

---

## PR guidelines

- Keep PRs small and focused (one feature/bugfix).
- Include:
  - what changed
  - why it changed
  - how to verify (exact steps, dataset if possible)
- If you changed a user-visible workflow, update docs in `cellucid-python/docs/`.
- Do not attach private datasets or tokens to PRs/issues.
