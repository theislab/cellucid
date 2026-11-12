# `rendering/`: WebGL2 viewer, point renderer, overlays

Draws what the page state hands it. Knows positions, colors (with the alpha
byte naming a cell's layer), sizes and visibility; never reads files.
Developer doc 07 (rendering pipeline) is the long-form reference.

Layer: L3. Imports `utils/` and a few `data/` contracts. Known wrong-way
imports to remove, not copy: `gl-errors.js` → `app/notification-center.js`,
`read-cell-layer.js` → `app/state/core/constants.js` (listed in
`cellucid-private/plans/audit-2026-10-28/tidiness-2026-10-30.md`).

| Module / folder | Owns |
| --- | --- |
| `viewer.js` | `createViewer`: the viewer object (camera, panes and kept views, input, frame loop, labels, overlays). One closure of about 11,000 lines; it is split by stage 5f of the reorganization plan, so keep new concerns in their own module and pass them in. |
| `viewer/` | What the viewer's public boundary enforces (`viewer-contracts.js`), the renderer facade it hands out (`renderer-facade.js`), presented layout and field of view. |
| `high-perf-renderer.js` | `HighPerfRenderer`: the point renderer (LOD, frustum culling, GPU stores, passes, read-cell draw). |
| `high-perf/` | Its parts: spatial tree and index (`spatial-tree.js`, `spatial-index.js`, built off thread by `spatial-tree-worker.js`), draw order and LOD ladder (`draw-order.js`, `lod-levels.js`), segmented GPU stores (`point-store-segments.js`, `store-order.js`, `gpu-permute.js`), the read cells at every level (`read-cell-index.js`), input contracts. |
| `alpha-visibility.js` | The alpha-byte contract shared by CPU and GPU: for a field's colors (`'layer'`), 255 colored on top, `BENEATH_ALPHA_BYTE` (254) the no-value gray beneath, `UNREAD_ALPHA_BYTE` (253) a cell not read; for markers (`'opacity'`) the alpha is opacity. |
| `read-cell-layer.js` | How a field read for a gene sample is drawn on a map of all open cells: gray for 0 from the theme, the fade of unread cells, read cells larger by density, unread drawn first. |
| `highlight-renderer.js`, `selection-gesture-queries.js`, `select-mode.js` | Highlights and selection gestures (lasso, proximity, k-NN). A highlighted cell is a dot of `HIGHLIGHT_COLOR` inside a ring of `highlightRingColorFor` it (black), on screen and in every figure format (`shaders/high-perf-shaders.js`), so it reads against any coloring. |
| `connectivity-edge-layer.js`, `connectivity-edge-selection.js` | Neighbor-graph edges drawn per pane. |
| `picking.js` | Screen-space picking: the cell drawn under the pointer, at its drawn size. |
| `point-sprite.js` | How every cell's sprite is sized, one rule for the shaders (GLSL), picking and figure export: its size and cap (160 px within the GPU's largest point). No fade or shrink by camera distance: a cell near the camera is drawn whole and picked. |
| `smoke-cloud/`, `overlays/` (velocity), `backdrops/`, `studio-backdrop.js`, `projectiles.js`, `orbit-anchor.js` | Optional passes and looks. |
| `shaders/` | GLSL sources. |
| `gl-errors.js`, `gl-state-shadow.js`, `gl-utils.js`, `linear-texture.js`, `scene-msaa-target.js` | WebGL plumbing: the one error boundary, state shadow, textures past engine limits, MSAA. |
| `full-detail-frame-cost.js`, `frame-phases.js`, `ambient-frame-pacing.js`, `pulse-*.js` | Frame cost and pacing. |
| `navigation-keys.js` | The camera keys by movement (`NAVIGATION_KEYS`, the modes each answers) and the held-key ledger (`createHeldKeys`): a key moves the camera for the share of each frame it was held. The shortcut table lists these keys. |
| `camera-state-contract.js`, `point-size-scale.js`, `shader-quality.js`, `viewer-backgrounds.js`, `position-layout.js`, `unplaced-positions.js`, `viewport-center.js` | Small shared contracts. |

## Invariants

- No per-frame allocation on hot paths; per-cell data lives in typed arrays
  and GPU stores, never in per-cell JS objects.
- Every surface that draws cells (viewer, figure export, smoke) takes the
  layer colors from `read-cell-layer.js` and the alpha meanings from
  `alpha-visibility.js`.
- Pixel-parity specs compare after the camera settles and assert equality,
  never a tolerance.
- Timing runs use the real GPU (Chromium on macOS: `--use-angle=metal`).

## Tests

`tests/high-perf-*`, `tests/highlight-*`, `tests/camera-*`, `tests/viewer-*`,
`tests/alpha-*`; browser specs `tests/browser/renderer-smoke.spec.mjs` and the `*-parity.spec.mjs` specs;
find others with `grep -l "rendering/<module>" tests/*.test.mjs`.

## Decision records

Why this code is the way it is (dated decisions, measurements per engine,
what was tried and reverted, open items): `cellucid-python/docs/user_guide/web_app/p_developer_docs/28_decisions_rendering_layers.md`, `cellucid-python/docs/user_guide/web_app/p_developer_docs/24_decisions_graph_edges_at_scale.md`. Update them in the same change as the code.
