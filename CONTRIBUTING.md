# Contributing to Cellucid (Web App)

Contributions are welcome — code, docs, bug reports, performance investigations, and UX feedback.

This file focuses on the **Cellucid web app** (the browser UI + state layer + WebGL renderer) in the `cellucid/` repo.

---

## Which repo should I contribute to?

Cellucid is split by responsibility:

| Repo | What it is | Contribute here when you… |
|---|---|---|
| `cellucid` (this repo) | Web app (UI + state + WebGL rendering) | are fixing UI bugs, rendering/performance, figure export, sessions, or community annotation frontend |
| `cellucid-python` | Python package + CLI + Sphinx docs | are fixing `prepare`/`serve`/`show_anndata`, server endpoints, Jupyter hooks, or documentation site pages |
| `cellucid-r` | R package exporter | are changing `cellucid_prepare()` / R export format logic |
| `cellucid-annotation` | GitHub repo template for annotation | are changing repo schema/validation/workflows |

If you’re unsure where a bug belongs, open an issue in the repo you’re currently using and include:
- where the UI ran (hosted app vs local app vs Jupyter iframe),
- how data was loaded (exports vs `.h5ad`/`.zarr` vs remote server),
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
- `cellucid/assets/js/data/`: data sources + loaders (exports/h5ad/zarr/remote/github/jupyter)
- `cellucid/assets/js/rendering/`: WebGL2 viewer + shaders + overlays
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

## Testing & validation (manual is mandatory)

There is no single “unit test suite” for the web app yet; manual smoke testing is required.

Recommended checklist:
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

