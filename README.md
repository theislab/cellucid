<p>
  <img src="https://raw.githubusercontent.com/theislab/cellucid-python/main/cellucid-logo.svg" alt="Cellucid logo" width="360">
</p>

# Cellucid

See every cell. Query any gene. Fly through millions. Zero friction. 

GPU-powered atlas viewer with real-time filtering, velocity overlays, and collaborative community annotation.

**Live:** [cellucid.com](https://www.cellucid.com)

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
2. Expand **Session** in the sidebar.
3. Choose **Prepared**, **H5AD**, or **Zarr ZIP**.
4. Select a prepared export folder, one `.h5ad` file, or one `.zarr.zip` /
   `.zip` archive containing an AnnData Zarr v2 store.

### Option 2: Python CLI

```bash
pip install cellucid

# Direct AnnData input requires an explicit dataset identity
cellucid serve /path/to/data.h5ad --dataset-name "My dataset" --dataset-id my-dataset
cellucid serve /path/to/data.zarr --dataset-name "My dataset" --dataset-id my-dataset

# A prepared generation already contains its identity
cellucid serve ./my_export
```

### Option 3: Jupyter Notebook

```python
from cellucid import show_anndata

viewer = show_anndata(
    adata,
    dataset_name="My dataset",
    dataset_id="my-dataset",
)
```

## Figure Export (SVG/PNG)

Use the **Figure Export** accordion in the sidebar to export the current view:

- **SVG**: choose Full Vector (editable circles), Optimized Vector (density-preserving editable circles at the entered target count), or Hybrid (shader-rendered points + vector annotations). The choice is required, honored exactly, and never changed automatically.
- **PNG**: best compatibility; choose DPI (150/300/600).
- **Axes**: use denormalized embedding coordinates in planar views and camera-space bounds in 3D orbit views; missing transforms or visible bounds block export instead of substituting generic `-1…1` axes.

## Compare Views

**Keep view** creates an independent panel with its own coloring and filter stack. Filters always belong to the selected panel: switching that panel from one color field to another preserves its filtered cells, while other panels remain unchanged. Select a panel before editing its filters; Cellucid never synchronizes filters across panels implicitly.

## Community Annotation (GitHub Sync)

- Enable per-field voting: right-click the categorical field dropdown → “Enable community annotation”.
- Open **Community Annotation** accordion to sign in with GitHub, select an installed repo, and `Pull`/`Publish` votes/suggestions.
- Annotation repo template: `cellucid-annotation/README.md`.
- Detailed repo + auth setup: `cellucid/assets/js/app/community-annotations/REPO_SETUP.md`.

## 14 Loading Workflows

“Lazy genes” means that the browser requests expression one gene at a time.
It does not mean that every source format is opened lazily by Python.

| # | Where | Trigger | Data | Lazy genes | Source loading |
|---:|---|---|---|---|---|
| 1 | Web app | Built-in sample picker | Prepared | Yes | Browser fetches prepared files on demand |
| 2 | Web app | Public GitHub export (`?github=...`) | Prepared | Yes | Browser fetches prepared files on demand |
| 3 | Web app | Browser **Prepared** picker | Prepared folder | Yes | Browser reads selected prepared files on demand |
| 4 | Web app | Browser **H5AD** picker | `.h5ad` | No | Browser holds the selected file in memory |
| 5 | Web app | Browser **Zarr ZIP picker** | `.zarr.zip` / `.zip` containing one Zarr v2 store | Yes | Browser indexes the archive, then reads gene-expression chunks on demand |
| 6 | CLI | `cellucid serve <export_dir>` | Prepared | Yes | Server streams prepared files |
| 7 | CLI | `cellucid serve data.h5ad --dataset-name "My dataset" --dataset-id my-dataset` | `.h5ad` | Yes | AnnData is opened read-only-backed |
| 8 | CLI | `cellucid serve data.zarr --dataset-name "My dataset" --dataset-id my-dataset` | `.zarr` | Yes | Zarr is materialized eagerly |
| 9 | Python | `cellucid.serve(<export_dir>)` | Prepared | Yes | Server streams prepared files |
| 10 | Python | `cellucid.serve_anndata(<data.h5ad>, dataset_name="My dataset", dataset_id="my-dataset")` | `.h5ad` | Yes | AnnData is opened read-only-backed |
| 11 | Python | `cellucid.serve_anndata(<data.zarr>, dataset_name="My dataset", dataset_id="my-dataset")` | `.zarr` | Yes | Zarr is materialized eagerly |
| 12 | Jupyter | `cellucid.show(<export_dir>)` | Prepared | Yes | Notebook server streams prepared files |
| 13 | Jupyter | `cellucid.show_anndata(<data.h5ad>, dataset_name="My dataset", dataset_id="my-dataset")` | `.h5ad` | Yes | AnnData is opened read-only-backed |
| 14 | Jupyter | `cellucid.show_anndata(<data.zarr or AnnData>, dataset_name="My dataset", dataset_id="my-dataset")` | `.zarr` / in-memory | Yes | Zarr and in-memory AnnData are materialized eagerly |

Prepared data is the fastest path for production and sharing. Browser H5AD is
intended for files within the UI’s documented 512 MiB limit. Browser Zarr
accepts one ZIP archive; Python accepts a complete Zarr v2 directory and loads
it eagerly.

## h5ad / Zarr Requirements

- **Required:** at least one exact embedding key:
  `obsm['X_umap_1d']` with shape `(n_cells, 1)`,
  `obsm['X_umap_2d']` with shape `(n_cells, 2)`, or
  `obsm['X_umap_3d']` with shape `(n_cells, 3)`.
- **Optional:** `obs` (cell metadata), `X` (expression matrix), `obsp['connectivities']` (KNN graph)

## Vector Field Overlay (Velocity / Drift)

Cellucid can render an animated particle-flow overlay from **per-cell displacement vectors** (e.g. scVelo velocity, CellRank drift).

- **AnnData**: store vectors in `adata.obsm` under exact dimension-suffixed
  keys such as `velocity_umap_1d`, `velocity_umap_2d`,
  `velocity_umap_3d`, or `T_fwd_umap_2d` (shape: `n_cells × dimension`).
- **Prepared exports**: include binary vector files under `vectors/` and a `vector_fields` block in `dataset_identity.json`.

Naming, dimensions, controls, and troubleshooting:
[Vector field and velocity documentation](https://cellucid.readthedocs.io/en/latest/user_guide/web_app/i_vector_field_velocity/index.html)

### Saving as zarr

```python
# Save AnnData as zarr store
adata.write_zarr("data.zarr")
```

## Pre-export for Performance

For best performance, especially with large datasets:

```python
from cellucid import prepare

embedding = adata.obsm["X_umap_2d"]
prepare(
    latent_space=embedding,
    obs=adata.obs,
    out_dir="./my_export",
    obs_categorical_dtype="uint16",
    dataset_name="My dataset",
    dataset_id="my-dataset",
    X_umap_2d=embedding,
    compression=6,
)
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
├── scripts/                 # Dev/validation scripts
└── types/                   # Editor-only type defs (design tokens)
```

Sample datasets (prepared exports) live in a separate repo/site:

```
cellucid-datasets/
└── exports/                 # CORS-enabled datasets.json + dataset folders
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
```

Visit http://localhost:8000 in a supported browser.

## Python Package

See [theislab/cellucid-python](https://github.com/theislab/cellucid-python) for the companion Python package.

## Community

- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Code of Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- Security: [SECURITY.md](SECURITY.md)
- Support: [SUPPORT.md](SUPPORT.md)
- Citation: [CITATION.cff](CITATION.cff)

## License

BSD 3-Clause License - see [LICENSE](LICENSE) for details.
