<p>
  <img src="https://raw.githubusercontent.com/theislab/cellucid-python/main/cellucid-logo.svg" alt="Cellucid logo" width="360">
</p>

# Cellucid Web Viewer

WebGL-based 3D visualization for single-cell data. Explore UMAP embeddings with interactive coloring, filtering, gene expression overlays, and KNN connectivity graphs.

**Live demo:** [cellucid.com](https://www.cellucid.com)

## Features

- Real-time rendering of millions of cells with adaptive LOD
- Gene expression overlays with efficient sparse matrix handling
- Categorical and continuous cell metadata coloring
- Interactive filtering and cell selection
- Community annotation voting (🗳️) with optional GitHub sync (GitHub App)
- KNN connectivity edge visualization
- Multi-dimensional support (1D timelines, 2D, 3D)
- Animated vector field overlay (velocity / drift) with GPU particle flow
- Publication export: SVG (vector) + PNG (high-DPI)
- Works in browser without Python (file picker) or with Python (Jupyter, CLI)

## Quick Start

### Option 1: Browser File Picker (No Setup)

1. Go to [cellucid.com](https://www.cellucid.com)
2. Click "Browse local data..."
3. Select a pre-exported folder, `.h5ad` file, or `.zarr` store

### Option 2: Python CLI

```bash
pip install cellucid

# Serve any data (format auto-detected)
cellucid serve /path/to/data.h5ad
cellucid serve /path/to/data.zarr
cellucid serve ./my_export
```

### Option 3: Jupyter Notebook

```python
from cellucid import show_anndata
show_anndata(adata)  # In-memory or file path
```

## Figure Export (SVG/PNG)

Use the **Figure Export** accordion in the sidebar to export the current view:

- **SVG**: best for Illustrator/Inkscape editing; for large datasets you’ll be prompted to choose Full Vector, Optimized Vector (density-preserving), or Hybrid (points raster + vector annotations).
- **PNG**: best compatibility; choose DPI (150/300/600).
- **Axes**: only rendered for **2D planar views** (switch navigation to Planar) to avoid misleading axes on 3D projections.

## Community Annotation (GitHub Sync)

- Enable per-field voting: right-click the categorical field dropdown → “Enable community annotation”.
- Open **Community Annotation** accordion to sign in with GitHub, select an installed repo, and `Pull`/`Publish` votes/suggestions.
- Annotation repo template: `cellucid-annotation/README.md`.
- Detailed repo + auth setup: `cellucid/assets/js/app/community-annotations/REPO_SETUP.md`.

## All 14 Loading Options

Cellucid supports 6 deployment modes, each with support for pre-exported binary data, h5ad files, and zarr stores:

| # | Method | Exported | h5ad | zarr | Python | Lazy Load | Performance |
|---|--------|----------|------|------|--------|-----------|-------------|
| 1 | Local Demo (GitHub) | ✅ | - | - | No* | Yes | Best |
| 2 | Remote Demo (GitHub) | ✅ | - | - | No* | Yes | Best |
| 3 | Browser File Picker | ✅ | - | - | No | Yes | Best |
| 4 | Browser File Picker | - | ✅ | - | No | **No** | Slower |
| 5 | Browser File Picker | - | - | ✅ | No | **No** | Slower |
| 6 | Server CLI | ✅ | - | - | Yes | Yes | Best |
| 7 | Server CLI | - | ✅ | ✅ | Yes | Yes | Good |
| 8 | Python serve() | ✅ | - | - | Yes | Yes | Best |
| 9 | Python serve_anndata() | - | ✅ | ✅ | Yes | Yes | Good |
| 10 | Jupyter show() | ✅ | - | - | Yes | Yes | Best |
| 11 | Jupyter show_anndata() | - | ✅ | ✅ | Yes | Yes | Good |

\* Python required for initial export, not for viewing

**Summary by method:**
| Method | Exported | h5ad | zarr | Total |
|--------|----------|------|------|-------|
| Local/Remote Demo | ✅ | - | - | 2 |
| Browser File Picker | ✅ | ✅ | ✅ | 3 |
| Server CLI | ✅ | ✅ | ✅ | 3 |
| Python serve | ✅ | ✅ | ✅ | 3 |
| Jupyter | ✅ | ✅ | ✅ | 3 |
| **Total** | | | | **14** |

### Key Notes

- **Browser h5ad/zarr (Options 4-5)**: Entire file loaded into browser memory - no lazy loading possible due to JavaScript limitations. Best for datasets < 100k cells.
- **Python h5ad/zarr modes (Options 7, 9, 11)**: True lazy loading via AnnData backed mode (h5ad) or zarr's native chunked access. Recommended for large datasets.
- **Pre-exported data**: Always fastest - recommended for production and sharing.
- **zarr stores**: Can be a directory (.zarr) or a file - the Python server auto-detects the format.

## h5ad / zarr Requirements

- **Required:** `obsm['X_umap']` or `obsm['X_umap_3d']` (shape: n_cells × 2 or 3)
- **Optional:** `obs` (cell metadata), `X` (expression matrix), `obsp['connectivities']` (KNN graph)

## Vector Field Overlay (Velocity / Drift)

Cellucid can render an animated particle-flow overlay from **per-cell displacement vectors** (e.g. scVelo velocity, CellRank drift).

- **AnnData**: store vectors in `adata.obsm` using keys like `velocity_umap_2d`, `velocity_umap_3d`, `T_fwd_umap_2d`, etc. (shape: n_cells × dim).
- **Prepared exports**: include binary vector files under `vectors/` and a `vector_fields` block in `dataset_identity.json`.

Naming/import details: [VECTOR_FIELD_OVERLAY_CONVENTIONS.md](markdown/VECTOR_FIELD_OVERLAY_CONVENTIONS.md)

### Saving as zarr

```python
# Save AnnData as zarr store
adata.write_zarr("data.zarr")
```

## Pre-export for Performance

For best performance, especially with large datasets:

```python
from cellucid import prepare
prepare(adata, output_dir="./my_export", compress=True)
```

## Repository Structure

```
cellucid/
├── index.html              # Single-page app
├── assets/
│   ├── css/                 # CSS design system (tokens/themes/utilities/components)
│   ├── js/
│   │   ├── app/            # UI, state management
│   │   ├── data/           # Data loaders (binary, h5ad)
│   │   └── rendering/      # WebGL renderer
│   └── exports/            # Sample datasets
├── scripts/                 # Dev/validation scripts
└── types/                   # Editor-only type defs (design tokens)
```

## CSS Design System

- Entry point: `assets/css/main.css` (layered: tokens → themes → base → utilities → components → layouts)
- Documentation: `assets/css/README.md`
- Validate token usage: `node scripts/validate-tokens.js`
- Validate token types sync: `node scripts/validate-token-types.js`
- Themes: `light` (default) and `dark` only (set via the Theme dropdown)

## Development

```bash
python -m http.server 8000
open http://localhost:8000
```

## Python Package

See [theislab/cellucid-python](https://github.com/theislab/cellucid-python) for the companion Python package.

## License

Proprietary - All rights reserved
