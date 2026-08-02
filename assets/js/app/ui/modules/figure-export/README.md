## Figure Export module

This folder implements **publication-grade SVG/PNG export** for Cellucid without touching the main render loop.

### Design goals

- **Exact request semantics**: export format and SVG representation are never inferred, changed, retried, or substituted.
- **View fidelity**: camera, filters, colors, framing, the reference grid, and atmospheric fog come from the current view; PNG and Hybrid preserve the shader-rendered point pass, while vector strategies preserve their explicitly documented circle representation.
- **Performance-safe**: heavy work runs only on explicit preview/export actions.
- **DRY + extensible**: shared layout/components are reused across SVG + PNG.

### Main pieces

- `index.js`: module entry point (wires UI + engine).
- `figure-export-ui.js`: sidebar panel (collects user inputs + triggers export/preview).
- `figure-export-engine.js`: snapshots current view buffers + orchestrates rendering/download/notifications.
  - Includes optional **framing crop** (photography-style overlay) so users can export a chosen sub-region of the current view without changing the camera.
  - Framing is locked to the selected plot size aspect; resizing the frame changes the exported region (zoom) without changing the camera.

### Renderers

- `renderers/svg-renderer.js`: string-based SVG generator (no DOM) with:
  - **Full vector** (`full-vector`): every visible point is an SVG circle, exactly as requested.
  - **Optimized vector** (`optimized-vector`): density-preserving reduction to the user-entered target count, exactly as requested.
  - **Hybrid** (`hybrid`): points are embedded as a shader-rendered PNG while annotations remain vectors.
- `renderers/png-renderer.js`: HTML Canvas exporter with embedded UTF-8 PNG `iTXt` metadata (`buildPngTextMetadata()` publishes the exact chunk map so it can be compared with the SVG's).
  - Points are rasterized via WebGL2 using the same shader variants as the viewer, so 3D “sphere” shading exports correctly (not as flat dots).

### Components (shared building blocks)

- `components/axes-builder.js`: ticks and exact user-entered axis labels; embedding-space bounds are used for planar views and camera-space bounds for 3D orbit views.
- `components/legend-builder.js`: categorical + continuous legends (sourced from `DataState.getLegendModel()` for color consistency).
  - Hidden categories (`model.visible[i] === false`) keep their entry but lose their color: the swatch becomes a hollow grey outline and the label is marked `(hidden)`. Dropping the entry would make a filtered view indistinguishable from a complete one; keeping a colored swatch would send a reader hunting the plot for points that were never drawn.
  - A logarithmic colorbar (`model.logEnabled`) is labelled `Log10 color scale` with its true midpoint (the geometric mean), because endpoint-only labels invite a linear read-off that is wrong by orders of magnitude.
  - SVG and Canvas emit the same text for the same model; only the fitting differs (SVG approximates width, Canvas measures it).
  - `resolveSharedGridLegend()` decides whether one legend may stand for a whole multi-panel grid: only when every panel uses the same field **and** publishes a semantically equal legend model (including which categories are hidden). Panels that disagree each get their own legend inside their cell — a colored panel is never exported without a legend.
- `components/reference-grid.js`: the viewer's reference-grid box, reproduced as vector rules.
  - `drawGrid()` (`rendering/viewer.js`) paints six quads of half-extent `GRID_SIZE` shaded by a pure line pattern — minor rules every `gridSpacing`, major every fifth, a frame at the box edges, origin-axis rules — with **no fog term**. Straight 3D lines project to straight 2D lines, so the grid is emitted as `<line>` elements and Canvas2D strokes rather than a second raster layer: a full-vector SVG stays fully editable, and PNG and SVG consume one geometry model so they cannot disagree.
  - Each rule is one opaque stroke whose colour is the shader's fragment colour already composited at the plane's effective opacity over the figure's own paper. Opaque strokes are what make crossings correct: the shader takes `max()` across the two rule families, so a crossing must be as dark as one rule, not two.
  - A rule that belongs to several classes (minor + major + frame, or minor + major + origin) is emitted as nested concentric bands, widest first, reproducing the shader's cross-section instead of flattening it.
  - Known bounded differences: the plane-surface vignette is not drawn (≤ ~1.3/255); crossings between two planes' rules are up to ~6/255 lighter than on screen; where one class's outer band crosses another's core the last-drawn class wins. None carries a data claim.
- `components/orientation-indicator.js`: 3D orientation widget (axis triad + angles).
- `components/centroid-overlay.js`: centroid points + centroid text overlay (WYSIWYG with viewer state).
- `components/fidelity-warning-dialog.js`: blocks an export before rendering when the requested representation cannot reproduce the active view.
  - Current blockers: missing WebGL2/camera matrices for shader-accurate rasterization, an enabled connectivity overlay, an enabled velocity vector field, any render mode other than Points, and an unreadable render-mode, background, or velocity control.
  - Blockers are for **data layers** only. Interaction chrome — the orbit compass, lasso and selection-radius indicators, multiview title chips, the projectile sandbox — is never exported and never blocks; the Annotations block states it up front instead, because blocking on always-on chrome would make ordinary exports impossible.

### Utilities

- `utils/layout.js`: consistent plot/legend/title layout (SVG + PNG share this); legend sizing reserves room for the `(hidden)` marker and for the margin the legend builder keeps beside each label.
  - `computeGridPaneLayout()` owns one grid cell: panel label row, plot rect, and the panel legend rect. The panel legend is carved out of the cell on the side chosen by `legendPosition`, so it can never overlap the plot or the `A. Live` label; the plot shrinks instead. A cell too small for a readable legend (`PANEL_LEGEND_MIN_WIDTH` / `PANEL_LEGEND_MIN_HEIGHT`) reports `legendRect: null`.
- `utils/panel-label.js`: the panel letters (`A`, …, `Z`, `AA`, …) shared by the drawn label and the embedded provenance, so a metadata record always names the panel it describes.
- `utils/figure-provenance.js`: the provenance record embedded into both formats. It describes **every** exported panel (`meta.views`), never only the active one — a grid stamped with one panel's field and filters is a false claim about the other panels. SVG `dc:description` and PNG `Description` come from this one builder, so the two formats of an export say the same thing.
- `utils/selection-badge.js`: the `n = N selected` badge. Single-view exports take N from DataState; each grid panel counts its own snapshot (highlighted, alpha-visible, LOD-admitted), because panels carry different filters and the active view's count is wrong for the others.
- `utils/render-mode.js`: reads the active render mode from the `#render-mode` control (the UI owner of the mode; the viewer exposes no reader) and turns anything other than Points into a fidelity blocker.
- `utils/viewer-background.js`: reads the active background from the `#background-select` control — the same pattern, because `viewer.setBackground()` derives every grid scalar from that one enum and exposes no reader — and publishes the exact reference-grid appearance for `Grid (light)` and `Grid (dark)`. `White` and `Black` set `showGrid = false` and publish none. An unreadable background is a fidelity blocker: an export that cannot tell whether the viewer draws a grid can neither include nor omit it honestly. `tests/figure-export-viewer-layer-fidelity.test.mjs` reads `rendering/viewer.js` and the grid shader, so neither side can drift silently.
- `utils/overlay-fidelity.js`: the data-overlay gates (connectivity, velocity vector field) and the list of interaction chrome the dialog discloses.
- `utils/fog.js`: the viewer's Beer-Lambert atmospheric fog, reproduced for the vector strategies. The `full` shader fades every point toward `fogColor` and thins its alpha with distance, and `fogDensity` starts at 0.5 — that is the depth cue a 3D scatter reads by. PNG and Hybrid run the shader; Full Vector and Optimized Vector project in JavaScript and would otherwise emit raw colours, flattening the depth axis. The sphere-impostor lighting term has no flat-disc equivalent and is not reproduced; it applies equally to every point regardless of depth, and the strategy hint says so.
- `utils/figure-ink.js`: the ink a figure writes its annotations in. Title, ticks, axis labels, panel letters, legend text, plot frame, selection badge, and the "No visible cells" notice used to be hard-coded near-black on a near-white frame — correct on white paper and unreadable on any dark figure, including every `Background: Match viewer` export taken from `Grid (dark)` or `Black`. Ink is now derived from the figure's own background luminance, using the same grey family mirrored across the midpoint. A transparent figure keeps the light palette, matching the assumption the centroid-label halo already makes.
- `utils/point-size.js`: the point diameter the figure is drawn with. `getEffectivePointDiameterPx()` applies the viewer's per-LOD size multiplier; `scalePointDiameterToRaster()` turns that into the diameter for a raster `s` times the on-screen viewport. `u_pointSize` is a *scale* and the rendered size is linear in it, so the only faithful answer is the exact product — a one-pixel floor inflates rather than protects (the default point size is 0.75 and the default export is half the viewport, so a 150-DPI PNG asks for 0.586 and a floor would draw 1). The shaders' own `clamp(gl_PointSize, 0.5, 128.0)` is the minimum that keeps a point visible, applied to the rendered size where it belongs. PNG and Hybrid SVG resolve every raster point size here, so they cannot disagree about how big a cell is.
- `utils/point-projector.js`: hot-path projection helper (supports optional depth sorting).
- `utils/density-reducer.js`: viewport-space density-preserving reduction (reservoir sampling).
- `utils/coordinate-mapper.js`: reverse normalization for real-coordinate axes.
- `utils/png-metadata.js`: validates the encoded PNG and injects UTF-8 `iTXt` chunks. The keyword set is built by `buildPngTextMetadata()` in `renderers/png-renderer.js`: `Software`, `Website`, `Creation Time`, `Dataset`, `Dataset ID`, `Color Field`, `Source File`, `Description`, `Comment`. Nothing else is written — no session identifier, no page URL, no user agent, no credential. `Source File` is whatever the data source published: a dataset URL, or, for a locally opened dataset, the directory or file **name** the browser exposes. Browsers never hand a page an absolute path, so none is embedded.
- `utils/colorblindness.js`: preview-only colorblind simulation (matrix transform).
- `utils/webgl-point-rasterizer.js`: shader-accurate point rasterization for PNG + Hybrid SVG. Its context is created with the antialiasing the viewer was **granted** (`viewer.getGrantedAntialiasing()`), carried through the render state. `antialias` is a context-creation attribute the user can turn off, and the viewer's own control measures the difference at 18% of pixels at the default point size and 32% with ultra-light square points, so a fixed `true` here would publish a smoother cloud than the screen ever drew.

### Performance notes

- SVG export is **string-based** to avoid DOM overhead at 50k+ points.
- Every SVG export requires an explicit point strategy. Cellucid never changes Full Vector, Optimized Vector, or Hybrid based on data size, view dimension, renderer availability, or a render failure.
- Full Vector and Optimized Vector intentionally represent points as editable circles; Hybrid intentionally preserves the WebGL shader point pass. Cellucid does not override or block a valid vector choice merely because Hybrid would look closer to a shaded 3D viewport.
- PNG-only requests carry no SVG strategy. Mixed SVG + PNG requests use the explicitly selected strategy only for the SVG job.
- SVG jobs carry `dpi: null`; PNG jobs require an exact DPI. The engine never invents a PNG resolution for SVG metadata.
- Batch jobs are rendered and validated before any file is downloaded; one failed job produces no partial batch.
- Preview uses a **small downsampled sample** and debounced redraw to avoid UI jank.
