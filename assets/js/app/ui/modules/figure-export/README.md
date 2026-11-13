# `ui/modules/figure-export/`: publication-grade SVG and PNG export

Draws the view as a figure (SVG or PNG, one or a grid of views) without touching the main render
loop: nothing runs until the person previews or exports, and every per-cell pass and encode runs
in the export's worker. The reference is developer doc 12 (`12_figure_export_architecture.md`);
why the figure comes out as it does is `36_decisions_figure_export.md`.

## What the folder guarantees

- **Exact request semantics.** A format and an SVG point strategy are never inferred, changed,
  retried or substituted: `full-vector`, `optimized-vector` and `hybrid` are the person's choice,
  never moved by data size, dimension, renderer or a failure. PNG-only requests carry no strategy;
  SVG jobs carry `dpi: null`, PNG jobs an exact DPI. A batch is rendered and checked whole before
  any file is downloaded.
- **Exactly as framed on screen.** A plot takes its source's aspect (the pane's viewport, or the
  framing crop) as the largest rectangle of that aspect inside the requested width and height, and
  the view fills it with the screen's own projection: no letterbox, points at their on-screen
  size. Every layer takes its placement from `utils/plot-fit.js`.
- **One plan, two drawers.** The layout (`utils/layout.js`), the legend plan and the axes plan are
  made once from measured text; the SVG and Canvas builders draw the plan and measure nothing, so
  the two formats cannot differ.
- **Nothing is cut or capped by the app.** A legend is as large as its entries need and the figure
  grows around it; the only size limit is the browser's canvas (`utils/figure-canvas.js`).
- **Fidelity is disclosed.** What the figure cannot reproduce blocks the export before rendering
  (`components/fidelity-warning-dialog.js`); interaction chrome (orbit compass, lasso and radius
  indicators, multiview title chips, the projectile sandbox) is never exported and never blocks.

## Entry points

| Module | Owns |
| --- | --- |
| `index.js` | `initFigureExport({state, viewer, dom, dataSourceManager})`: wires the panel and the engine |
| `figure-export-ui.js` | The sidebar panel: collects the settings, previews, exports; observes its own settings for the history (`observeSettings`) |
| `figure-export-engine.js` | Snapshots the view's buffers, builds the payload, drives the renderers, the download and the notifications; also the figure `view.picture` and the printable report draw (`renderFigure`) |
| `figure-export-contract.js` | Exact validators of a request and a payload: nothing is coerced, clamped, defaulted or repaired |

## Renderers

| Module | Owns |
| --- | --- |
| `renderers/svg-renderer.js` | The SVG (no DOM): the page writes annotations as strings, the worker writes the points and returns them as one Blob, and the file is assembled from Blob parts, never one string |
| `renderers/svg-point-markup.js` | The `<circle>` markup of the two vector strategies, encoded in the worker into a reused 1 MiB buffer whose contents become Blob parts |
| `renderers/png-renderer.js` | The Canvas composer; `buildPngTextMetadata()` publishes the chunk map the SVG's description is compared with |

Strategies: Full vector draws every visible point as a circle; Optimized vector draws a
density-preserving reduction to the target count the person entered; Hybrid embeds the
shader-rendered point pass as a PNG and keeps every annotation vector.

## The worker

`utils/figure-export-worker.js` and `utils/figure-export-worker-client.js`. Each rendered file
opens a session: a typed array is copied to the worker once however many passes read it, and
closing the session releases it. The worker holds its WebGL2 contexts while it lives (one per
antialiasing setting); with no session open it and the page's drawing host end after the idle
lifetime of `workers/idle-retirement.js`. Before the first point pass the client asks once whether
the worker can create a WebGL2 context (`webgl2`); where it cannot (WebKitGTK and WPE, WebKit bug
209809; Safari 16.4 to 16.6, and 17.0 to 17.1 on macOS Ventura, WebKit bug 183720) the same handler
(`createFigureExportWorkerHandler`) runs on the page for the point passes only, and every other
operation stays in the worker. `setFigureExportWorkerWebgl2(false)` states the answer for tests, and
`tests/helpers/figure-export-worker-in-process.mjs` runs the handler in Node. A request outliving
its export's abort rejects at once and the late answer is discarded.

Images cross to the worker as pixels, never as an ImageBitmap of a page canvas (the composed
figure in bands of rows, `pagePixelsInBands`; a backdrop look's raster; a Hybrid point pass).

## Components

| Module | Owns |
| --- | --- |
| `components/axes-builder.js` | Axes, drawn only where they are rulers (`figureViewHasAxes()`: a 1-D or 2-D view in planar navigation, looked at straight down its plane); `computeSourceAxisBounds()`, `planAxisTicks()` (nice ticks 1, 2, 2.5, 4, 5 x 10^n whose labels keep half an em apart, at most five), `planFigureAxes()` (every line, tick, label and the margins), `placeFigureAxes()`, and the SVG and Canvas drawers |
| `components/legend-builder.js` | `planLegend()` (entries, columns, rows, the box; a color bar's labels and note), `legendEntries()`, `resolveSharedGridLegend()`, the highlight entry, the two drawers; the model is `DataState.getLegendModel()` |
| `components/reference-grid.js` | The viewer's grid box as `<line>` rules and Canvas strokes (`buildReferenceGridModel()`), also the entry for a studio backdrop |
| `components/studio-backdrop-export.js` | The studio backdrops as vectors from the viewer's own functions and constants (`rendering/studio-backdrop.js`) |
| `components/backdrop-look-export.js` | The backdrop looks (`rendering/backdrops/`) as one raster per pane, redrawn by `rendering/backdrops/backdrop-look-raster.js` from the look frozen in `renderState.backdrop.look` |
| `components/orientation-indicator.js` | The 3-D axis triad, laid out in viewport pixels and scaled by `plotScale` |
| `components/centroid-overlay.js` | Centroid points and labels |
| `components/vector-field-figure.js` | The velocity field as a still picture of arrows on a grid (`planVectorFieldFigure`, drawn by SVG, PNG and the preview alike; the engine reads the arrays in `readFigureVectorFields`) |
| `components/fidelity-warning-dialog.js`, `components/modal.js` | The blockers, in an app dialog |

## Utilities

| Module | Owns |
| --- | --- |
| `utils/layout.js` | Every rectangle: `computeFigureLayout(payload)`, `computeSingleViewLayout()`, `computeGridFigureLayout()` and `composeGrid()`; the plot padding (`PLOT_PADDING`) and the least a plot keeps when legends take room (`PANEL_LEGEND_SHARE`, `PANEL_PLOT_MIN_WIDTH` and `PANEL_PLOT_MIN_HEIGHT`) |
| `utils/plot-fit.js`, `utils/plot-projection.js` | The one placement every layer uses (`figureSourceRect`, `fitPlotSize`, `createPlotPlacement`, `projectIntoSource`, `planPlotRaster`) and model space to plot space for the vector reference layers |
| `utils/figure-size.js` | A figure's size as one model: millimetres and points, figure pixels of 1/96 inch, PNG at D dpi, SVG in millimetres |
| `utils/crop.js`, `utils/cells-frame.js` | The framing crop in viewport fractions, and the frame that fits the cells |
| `utils/text-measure.js` | The one text measurement (an `OffscreenCanvas` context, or a conservative per-character estimate in Node) |
| `utils/figure-canvas.js` | The PNG canvas, or a refusal in one sentence before anything renders |
| `utils/panel-label.js`, `utils/figure-title.js`, `utils/selection-badge.js`, `utils/highlight-legend.js` | Panel letters and titles, the automatic title, the `n = N selected` badge and the highlight's legend entry |
| `utils/figure-provenance.js`, `utils/png-metadata.js` | The provenance record of every exported panel (`meta.views`), embedded in both formats from one builder; the worker's PNG validation, `pHYs` and `iTXt` chunks |
| `utils/point-size.js`, `utils/point-projector.js`, `utils/density-reducer.js`, `utils/coordinate-mapper.js`, `utils/lod-membership.js` | The point diameter the screen draws, projection and the O(N) depth sort, the density reduction, real-coordinate axes, the cells drawn at a reduced level of detail |
| `utils/webgl-point-rasterizer.js` | Shader-accurate point rasterization for PNG and Hybrid, on the worker's OffscreenCanvas (or the page's where a worker has no WebGL2) with the antialiasing the viewer draws with at the moment of the export |
| `utils/fog.js`, `utils/figure-ink.js`, `utils/render-mode.js`, `utils/viewer-background.js`, `utils/overlay-fidelity.js`, `utils/colorblindness.js` | The viewer's atmospheric fog for the vector strategies; annotation ink from the figure's background luminance; the render mode and the background read from their controls (an unreadable one is a fidelity blocker); the data-overlay gates; the preview-only colorblind simulation |
| `utils/session-settings.js` | The panel's settings as a session records them (`exportSessionSettings()` and `importSessionSettings()`), and the parameters of the action `figure-export.set` (`FIGURE_EXPORT_PARAMS`) |
| `utils/zip-archive.js`, `utils/export-helpers.js`, `utils/legend-model-equality.js` | The deterministic batch archive (the app's one ZIP writer, `formats/zip/writer.js`), file names, legend model equality |

## Invariants

- The layout plans; the renderers draw. Neither renderer measures or places anything of its own,
  and a plan is placed on a plot only of the size it was made for.
- A legend or a hidden category is never dropped to save room: a hidden category keeps its entry
  as a hollow gray outline marked `(hidden)`, so a filtered view is never mistaken for a complete
  one. A colored panel is never exported without a legend: panels share one only when every panel
  uses the same field and publishes an equal legend model.
- Axes exist only where they are rulers; a 3-D or orbited view has none and shows its orientation
  widget.
- PNG and SVG consume one geometry model for the reference layers, one point-size rule
  (`utils/point-size.js`) and one provenance builder, so they cannot disagree.
- Provenance and PNG metadata hold no session identifier, page URL, user agent or credential.
- The settings are one record of the `settings` state domain (`figureExport`,
  `app/state/domains/settings.js`): a person's change is one history step by observation, an
  agent, a notebook or a replay uses the action, which applies the record whole.

## Tests

`tests/figure-export-*` contract tests (`tests/figure-export-viewer-layer-fidelity.test.mjs` reads
`rendering/viewer.js` and the grid shader, `tests/studio-backdrop-contract.test.mjs` the studio
shader) and the browser specs `tests/browser/figure-export*.spec.mjs`.

## Decision records

Why this code is the way it is (dated decisions, measurements, what was tried and reverted, open
items): `cellucid-python/docs/user_guide/web_app/p_developer_docs/36_decisions_figure_export.md`.
Update it in the same change as the code.
