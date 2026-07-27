<p>
  <img src="https://raw.githubusercontent.com/theislab/cellucid-python/main/cellucid-logo.svg" alt="Cellucid logo" width="360">
</p>

# Cellucid

**See every cell. Query any gene. Fly through millions.**

Cellucid is a browser-first, GPU-accelerated workspace for exploring large
single-cell datasets in real time. Move naturally through 1D, 2D, and 3D
embeddings, compare populations side by side, follow cellular dynamics, and
turn an exploratory view into a reproducible figure or shared session.

**[Explore Cellucid](https://www.cellucid.com)**

---

## About this npm package

**This package is a name reservation. There is nothing to run here yet.**

Cellucid is a web application, not a JavaScript library. It is hosted at
[www.cellucid.com](https://www.cellucid.com) and driven from Python or R, which
serve your data locally and open it in the browser. No npm install is involved
in normal use.

The `cellucid` name is held on npm for one specific future purpose: a
local-serving CLI (`npx cellucid`) for offline, air-gapped, or firewalled
environments that cannot reach `www.cellucid.com`. If that ships, it will
appear here and this README will describe it.

## How to actually use Cellucid

| You have | Do this |
|----------|---------|
| A browser | Go to [www.cellucid.com](https://www.cellucid.com) |
| Python / Jupyter | `pip install cellucid` |
| R | `install.packages("cellucid")` |

Installation, data preparation, every loading path, UI controls, examples, and
troubleshooting are covered in the
[complete Cellucid documentation](https://cellucid.readthedocs.io/en/latest/).

## Features

- Fast WebGL rendering with adaptive detail for million-cell atlases
- Interactive gene-expression and cell-metadata coloring, filtering, and highlighting
- Independent multiview comparisons with per-view colors and filter stacks
- Animated RNA-velocity and drift overlays, KNN connectivity, and volumetric smoke
- Built-in differential expression, correlation, gene-signature, and quick-insight workflows
- Orbit, Planar, and Free Fly navigation with reproducible Camera Path animation
- Community annotation, voting, and consensus with optional GitHub collaboration
- Shareable session state plus publication-ready SVG and high-DPI PNG export
- Direct H5AD and Zarr loading, prepared datasets, local or remote servers, Jupyter, Python, and R

## Links

| Resource | URL |
|----------|-----|
| Application | https://www.cellucid.com |
| Documentation | https://cellucid.readthedocs.io/en/latest/ |
| Web app source | https://github.com/theislab/cellucid |
| Python package | https://pypi.org/project/cellucid/ |
| R package | https://github.com/theislab/cellucid-r |
| Issues | https://github.com/theislab/cellucid/issues |

## License

BSD 3-Clause. See [LICENSE](./LICENSE).
