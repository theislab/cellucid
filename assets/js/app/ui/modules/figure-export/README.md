## Figure Export module

This folder implements **publication-grade SVG/PNG export** for Cellucid without touching the main render loop.

### Design goals

- **WYSIWYG**: exports reproduce the *current* interactive view (zoom/rotation/filters/colors).
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
  - **Full vector** (`full-vector`)
  - **Optimized vector** (`optimized-vector`, density-preserving reduction)
  - **Hybrid** (`hybrid`, points rasterized into `<image>`, annotations remain vector)
- `renderers/png-renderer.js`: Canvas2D exporter (OffscreenCanvas when available) with embedded PNG `tEXt` metadata.
  - Points are rasterized via WebGL2 using the same shader variants as the viewer, so 3D “sphere” shading exports correctly (not as flat dots).

### Components (shared building blocks)

- `components/axes-builder.js`: nice ticks + axis labels (for 1D/2D, and for planar camera mode).
- `components/legend-builder.js`: categorical + continuous legends (sourced from `DataState.getLegendModel()` for color consistency).
- `components/orientation-indicator.js`: 3D orientation widget (axis triad + angles).
- `components/centroid-overlay.js`: centroid points + centroid text overlay (WYSIWYG with viewer state).
- `components/large-dataset-dialog.js`: forces explicit user choice for large SVG exports.
- `components/citation-modal.js`: post-export citation helper.

### Utilities

- `utils/layout.js`: consistent plot/legend/title layout (SVG + PNG share this).
- `utils/point-projector.js`: hot-path projection helper (supports optional depth sorting).
- `utils/density-reducer.js`: viewport-space density-preserving reduction (reservoir sampling).
- `utils/coordinate-mapper.js`: reverse normalization for real-coordinate axes.
- `utils/png-metadata.js`: inject PNG `tEXt` chunks (Software/Source/Creation Time/Description).
- `utils/colorblindness.js`: preview-only colorblind simulation (matrix transform).
- `utils/webgl-point-rasterizer.js`: shader-accurate point rasterization for PNG + Hybrid SVG.

### Performance notes

- SVG export is **string-based** to avoid DOM overhead at 50k+ points.
- Large dataset SVG export requires a user choice; `optimized-vector`/`hybrid` are the recommended paths.
- Preview uses a **small downsampled sample** and debounced redraw to avoid UI jank.
