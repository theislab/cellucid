## Figure Export module

This folder implements **publication-grade SVG/PNG export** for Cellucid without touching the main render loop.

### Design goals

- **Exact request semantics**: export format and SVG representation are never inferred, changed, retried, or substituted.
- **View fidelity**: camera, filters, colors, and framing come from the current view; PNG and Hybrid preserve the shader-rendered point pass, while vector strategies preserve their explicitly documented circle representation.
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
- `renderers/png-renderer.js`: HTML Canvas exporter with embedded UTF-8 PNG `iTXt` metadata.
  - Points are rasterized via WebGL2 using the same shader variants as the viewer, so 3D “sphere” shading exports correctly (not as flat dots).

### Components (shared building blocks)

- `components/axes-builder.js`: ticks and exact user-entered axis labels; embedding-space bounds are used for planar views and camera-space bounds for 3D orbit views.
- `components/legend-builder.js`: categorical + continuous legends (sourced from `DataState.getLegendModel()` for color consistency).
- `components/orientation-indicator.js`: 3D orientation widget (axis triad + angles).
- `components/centroid-overlay.js`: centroid points + centroid text overlay (WYSIWYG with viewer state).
- `components/fidelity-warning-dialog.js`: blocks an export before rendering when the requested representation cannot reproduce the active view.

### Utilities

- `utils/layout.js`: consistent plot/legend/title layout (SVG + PNG share this).
- `utils/point-projector.js`: hot-path projection helper (supports optional depth sorting).
- `utils/density-reducer.js`: viewport-space density-preserving reduction (reservoir sampling).
- `utils/coordinate-mapper.js`: reverse normalization for real-coordinate axes.
- `utils/png-metadata.js`: validates the encoded PNG and injects UTF-8 `iTXt` chunks (Software/Source/Creation Time/Description).
- `utils/colorblindness.js`: preview-only colorblind simulation (matrix transform).
- `utils/webgl-point-rasterizer.js`: shader-accurate point rasterization for PNG + Hybrid SVG.

### Performance notes

- SVG export is **string-based** to avoid DOM overhead at 50k+ points.
- Every SVG export requires an explicit point strategy. Cellucid never changes Full Vector, Optimized Vector, or Hybrid based on data size, view dimension, renderer availability, or a render failure.
- Full Vector and Optimized Vector intentionally represent points as editable circles; Hybrid intentionally preserves the WebGL shader point pass. Cellucid does not override or block a valid vector choice merely because Hybrid would look closer to a shaded 3D viewport.
- PNG-only requests carry no SVG strategy. Mixed SVG + PNG requests use the explicitly selected strategy only for the SVG job.
- SVG jobs carry `dpi: null`; PNG jobs require an exact DPI. The engine never invents a PNG resolution for SVG metadata.
- Batch jobs are rendered and validated before any file is downloaded; one failed job produces no partial batch.
- Preview uses a **small downsampled sample** and debounced redraw to avoid UI jank.
