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
- hosted (`https://www.cellucid.com`) vs local app (`http://localhost:4173`, `npm run serve`) vs Jupyter iframe
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
npm run serve
```

Then open:
- `http://localhost:4173` (`CELLUCID_BROWSER_TEST_PORT=8000 npm run serve` moves it)

Why:
- the app uses native ES modules (`<script type="module">`)
- `file://` access will break imports/fetches in confusing ways
- every answer is `Cache-Control: no-store`, so a reload runs the module you
  just edited. A server without cache headers (`python -m http.server`) lets
  the browser keep a module it guessed fresh, and a reload runs the old code.
- it answers byte ranges, and serves the same tree with CORS on the next port
  (`http://localhost:4174/…`) for a dataset opened by link

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
  - `app/state/`: `DataState` + managers (fields/filters/colors/highlights/views); `app/state/domains/`: the state domains (what a step captures and puts back)
  - `app/actions/`: the action catalog and dispatcher: every change a control, an agent or a Python/R host makes is one action (see `app/actions/README.md` before adding a control)
  - `app/history/`: the action history (trackers, steps, undo/redo, the autosave in this browser, pseudocode/methods/report)
  - `app/ui/`: UI coordinator + sidebar modules
  - `app/session/`: `.cellucid-session` files (session format 4: the history)
  - `app/library/`: My datasets and the kept handles of local files
  - `app/ui/modules/figure-export/`: figure export
  - `app/community-annotations/`: GitHub-backed community annotation sync/auth
- `cellucid/assets/js/data/`: data sources + loaders (AnnData `.h5ad`/Zarr/`.zarr.zip` files, links and catalogs, `cellucid serve`, Jupyter)
  - `data/anndata/`: the one AnnData reader (elements, data frames, dense and sparse matrices) over any store
  - `data/sources/`: dataset catalogs (`datasets.json`, `anndata-catalog.js`) and link providers
- `cellucid/assets/js/formats/`: file-format readers with no Cellucid knowledge — `hdf5/`, `zarr/` (v2 and v3, folder/ZIP/HTTP stores), `zip/`, `rds/` (R serialization), `text/` (MatrixMarket), and `io/` (byte sources, range reads, the link model, kept parts, the decode worker pool); see `assets/js/ARCHITECTURE.md` and the folder READMEs
- `cellucid/assets/js/rendering/`: WebGL2 viewer + shaders + overlays
- `cellucid/assets/js/workers/`: `worker-script.js`, where every worker starts from (`startWorker`)
- `cellucid/assets/workers/`: generated worker bundles and `scripts.js` (never edited; see Testing & validation)
- `cellucid/assets/page/`: the generated page bundle a deployed site loads (`scripts/build-page-bundle.mjs`; never edited)
- `cellucid/assets/wasm/`: `codecs.wasm`, the zstd, lz4 and c-blosc decoders built from pinned sources by `scripts/build-wasm-codecs.mjs` (never edited), with their licenses
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

### Comments say what the code does; history goes to the decision records

A comment says what the code does and why it must be so: the invariant it keeps, the failure it
prevents, the unit of a number, the module that owns the other half. It is written in the
present tense and stays true for as long as the code below it is unchanged.

A comment never holds:

1. a CI run number or address;
2. a finding, audit or plan id, or a path into a repository the reader cannot open;
3. a date of our own work (a date of an outside version the code depends on, such as a protocol
   revision or a browser release, stays);
4. who decided, or their words;
5. what the code used to do, what was tried, what was found or fixed;
6. numbers measured on a machine, with the machine, engine or dataset.

Each of these goes, in the same change, to the decision record of the subsystem (the table in
`assets/js/ARCHITECTURE.md` says which): a decision to "Decisions and why", numbers to
"Measurements that justify it", an attempt to "Tried and reverted". The record tells the story
in plain words, with its date and its numbers; it holds no finding, audit or plan id either.
Where a constant or a design rests on one, the comment keeps the reason in one clause and names
the page: `(measured: 24_decisions_graph_edges_at_scale.md)`.

What stays: the failure the code prevents, told as a condition ("offline, a back-off would
outlast the outage, so the read waits for the connection"); pointers to tests, modules and
pages that exist; facts about outside versions.

Tests follow the same rule. A test's name says what it pins and holds no id. A test file's
header says what the file pins and what breaks without it; the incident that led to it goes to
the record. `tests/comment-history-contract.test.mjs` holds items 1 and 2 (and a round or a bug
hunt named as a label) in every comment, test title, workflow comment and Markdown page of the code, tests,
scripts, workflows and `docs/`, in the stylesheets, in the HTML comments of the pages the site ships, and in
the `about` and `description` fields of JSON fixtures; items 3 to 6 are for review.

**Before and after: a reason told through an incident** (`assets/js/formats/io/byte-source.js`).

```js
// Before
// This computer is offline: no host refuses anything. The read waits
// for the connection, not a back-off, and is asked again the moment
// it is back (round 9: a read waited up to 20 s more after an
// 18 s outage ended).

// After
// This computer is offline: no host refuses anything. The read waits
// for the connection, not a back-off (which would outlast the outage),
// and is asked again the moment it is back.
```

Record 22, "Decisions and why", gains the row: its date; "Offline, a read waits for the
connection and not a back-off"; why: a read waited up to 20 s more after an 18 s outage ended;
rules out: a back-off while the browser reports no connection.

**Before and after: a measurement that justifies a constant** (`assets/js/app/ui/modules/connectivity-controls.js`).

```js
// Before
/**
 * Edges a millisecond one pass of `forwardEdgeRows` walks, before this page
 * has timed one (`knnRowReader`): about 100,000, measured in Node on an
 * Apple M-series laptop (20M edges: 183 ms for a 65,536-cell frontier). A
 * prior replaced by the first pass's own rate, never a limit.
 */

// After
/**
 * Edges a millisecond one pass of `forwardEdgeRows` walks, before this page
 * has timed one (`knnRowReader`): a prior replaced by the first pass's own
 * rate, never a limit (measured: 24_decisions_graph_edges_at_scale.md).
 */
```

Record 24, "Measurements that justify it", gains the row: 20M edges, 65,536-cell frontier,
183 ms, Node, Apple M-series.

## Testing & validation

Node.js 22.15 or newer is required (`package.json` sets `engines.node`): the
Zstandard contracts compress their inputs with `node:zlib`'s Zstandard encoder,
which earlier releases do not have. CI runs Node.js 22, 24 and 26. Install the exact dependencies once, then run
the suites:

```bash
npm ci
npm run check               # the type check of assets/js: about 12 seconds, 4 when run again
npm run test:core           # the core contract tests: every layer, about 15 seconds
npm run test:browser:smoke  # the smoke specs: one walk from start to export, each engine
npm test                    # every web contract in tests/*.test.mjs
npm run test:browser        # Playwright suites in tests/browser/
npm run test:browser:repeat # the browser specs a change touches, 5 times in every engine
npm run test:worker-bundle  # dry-run build of the community-annotation Cloudflare Worker
```

What to run when:

| When | Run | About |
|---|---|---|
| After a change, while working | `npm run check`, `npm run test:core`, the contract files and specs of what you changed, then `npm run test:browser:smoke -- --project=chromium` | 15 seconds, then about 6 minutes |
| Before the change is called done | `npm run test:browser:smoke` (every engine) | about 20 minutes with one worker |
| When a piece of work is complete | `npm test` and `npm run test:browser -- --project=chromium` | 2 minutes, then every spec in one engine |
| Before `main` is pushed | `npm run test:browser` in Firefox and WebKit too | CI runs the same on every push |

`npm test` and the full browser suite are the gate; the two short sets only
answer first. Both are lists in `scripts/test-suites.mjs`, held to the tree by
`tests/test-suites-contract.test.mjs`: the core tests are, for each layer, the
files that run that layer's modules and say the most for their time; the smoke
specs walk start, open each format, color, filter, select, analyze, undo, save
and export. A new test joins a short set only when it replaces one there or
covers a layer or a step that has none.

### The type check

`npm run check` (`scripts/check-types.mjs`) reads `assets/js` with the
TypeScript compiler as JavaScript with JSDoc (`tsconfig.json`; nothing is
emitted, and no page loads a compiled file). `npm test` runs it too
(`tests/type-check-contract.test.mjs`), so CI does. It is not strict typing.
A line fails it when it is:

- a syntax error;
- a diagnostic that means a defect whatever the typing style, by its code
  (`DEFECT_FAMILIES` in the script): a name that is not defined or not
  imported, an import of something a module does not export, a call with the
  wrong number of arguments, a call or `new` of something that is neither,
  the same name declared twice, an assignment to a constant or an import, a
  comparison that can never hold, a `@private` member reached from outside
  its class, a JSDoc that does not match its function, unreachable code, a
  name declared and never used, a member newer than ES2023 (the `lib` of
  `tsconfig.json`: raise it there, on purpose, to use one);
- any diagnostic at all in a fully checked folder (`FULLY_CHECKED` in the
  script).

Every other diagnostic is typing style in a folder that is not fully checked
yet: counted in the last line, never a failure. There is no baseline and no
directive comment: `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` and
`@ts-check` are refused under `assets/js`. A reported line is fixed where it
is wrong. When the code is right, its JSDoc is not: add the parameter to the
callee's signature, import the type (`import('./module.js').Name`), type a
value checked at run time by what may arrive, write a list of pairs as
`/** @type {const} */ ([...])`, take `@private` off a member another class
reaches. A global a classic script defines is declared in
`types/globals.d.ts`.

A folder becomes fully checked when it has no diagnostic left:
`node scripts/check-types.mjs --folder <path under assets/js>` prints the
ones it has, with a count by code (`--all` prints every diagnostic of the
tree). Fix them, then add the folder to `FULLY_CHECKED`. A new folder starts
there.

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

The same run writes the **code fingerprints of kept data**,
`assets/js/data/anndata/transcode/kept-code-fingerprints.js`. The app keeps
four kinds of data in the browser between visits (converted stores, gene
indexes, files downloaded whole, the downloaded parts of files), and stamps
each kept directory with a digest of the code that decides what it holds; a
directory stamped by other code is removed, never read, and made again on
the next opening. `scripts/kept-code-fingerprints.mjs` names the modules each
kind's fingerprint covers and why. There is no number to raise and no digest
to update in a test: change covered code, run the generator, commit the new
module (`npm test` and `--check` refuse a stale one,
`tests/kept-code-fingerprints-contract.test.mjs`). Comments and layout do
not count, so a comment-only change changes no fingerprint. A code change
there does make every browser convert, index or download again, so keep
the five modules a download's and a file's parts' fingerprints cover
(`kept-format.js`, `kept-journal.js`, `formats/io/page-checks.js`,
`data/sources/identity.js`, `data/sources/link-credentials.js`) to what a
kept directory is.

What search engines and link previews read — the `<head>` metadata, the JSON-LD
block and its hash in the Content-Security-Policy, the visually hidden "About
Cellucid" text, `robots.txt`, `sitemap.xml`, `404.html`, the reading pages
(`privacy.html`, `terms.html`, `accessibility.html`), `.well-known/security.txt`,
`llms.txt` and `site.webmanifest` — is pinned by
`tests/seo-head-contract.test.mjs`.

`npm test` runs `scripts/run-web-tests.mjs`, which discovers every
`tests/*.test.mjs` file and runs them under the Node.js test runner — so a new
contract file is picked up by adding it, with nothing to register. A file that
hangs is stopped once it has finished no test for 5 minutes and fails naming the
last test it finished; a slower machine that is still finishing tests never
fails for its speed. Each file runs in a process group of its own, so an
interrupted run (Ctrl-C, a canceled CI job) stops every file it started
before it ends. These are
the same commands `.github/workflows/test.yml` runs, so a green local run is the
same check CI applies:

- `npm test` runs on Ubuntu, macOS, and Windows across Node 22/24/26, with
  `cellucid-datasets` (its catalog and session presets) checked out beside the
  repository so the cross-repository session-preset contracts run, and
  `cellucid-python` and `cellucid-r` (the notebook widget's front end each
  ships) so the widget contract runs against both copies.
- On every push and pull request the browser suite runs chromium, firefox, and
  webkit on Ubuntu, plus webkit on macOS, in eight shards each. Every engine on
  every operating system runs nightly and on manual dispatch (**Actions → Web
  contracts → Run workflow**).
- The control walk (`tests/browser/control-walk-<k>-of-<n>.spec.mjs`, Chromium
  only, minutes a test) runs in a job of its own, a share a job, on the
  operating systems the browser suite runs Chromium on: Playwright shards by
  test count, so in the suite's shards its few long tests would all fall into
  one. `CELLUCID_CONTROL_WALK` (`playwright.config.mjs`) selects: `apart`
  leaves the walk out (the browser shards), `only` runs it alone (the walk
  job, `--shard=k/4`, a file each), unset runs every spec. Run a share as CI
  does with
  `CELLUCID_CONTROL_WALK=only npm run test:browser:bounded -- --project=chromium --shard=1/4`.
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

A browser spec waits for the product's state, never a fixed time:
`tests/browser-spec-fixed-waits-contract.test.mjs` fails on a new
`page.waitForTimeout(…)` or timer-resolved promise unless time itself is what
the spec checks. Before pushing a spec change, run
`npm run test:browser:repeat` (or name the specs: `-- <spec> --repeat=10`),
which runs the specs the change touches several times in each engine with no
retries and fails on any single failed run; see the developer docs' "Browser
specs that wait for state, not time".

Automated coverage does not replace manual smoke testing of the interactive
surface. Run through this checklist for any change a user can see:
- load a dataset (local-demo or local-user)
- switch categorical/continuous/gene fields
- apply filters and confirm visibility updates
- create highlights and switch highlight pages
- create a snapshot view (“Keep view”) and confirm multiview works
- undo and redo a few steps in **State › History**, and save and load a `.cellucid-session`
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
