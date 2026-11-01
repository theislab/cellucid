"""Serve a dataset with cellucid-python's server, as `serve_anndata` and the
notebook widget serve it, for the `served` plan of `scripts/efficiency-floor.mjs`
and `efficiency-floor/app-run.mjs`: a synthetic AnnData object of `--cells`
cells (2,000 genes, `--per-cell` values a cell in CSR, the obs columns of a
typical object, a 2-D UMAP and a PCA), or a file (`--file`). Prints one JSON
line per phase (`built_s`: the object; `server_made_s`: the store, before
the first answer; `laid_out_s`: every expression matrix laid out, unless
`--no-wait`), then `READY`, and serves until killed.

    python -I scripts/efficiency-floor/served.py PORT --cells 1000000 --per-cell 100 [--no-wait] [--source SRC]
    python -I scripts/efficiency-floor/served.py PORT --file data.h5ad

`--source` puts another checkout's `src` first (an earlier revision, to compare).
"""

from __future__ import annotations

import argparse
import json
import resource
import sys
import threading
import time


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("port", type=int)
    parser.add_argument("--cells", type=int, default=0)
    parser.add_argument("--per-cell", type=int, default=10)
    parser.add_argument("--genes", type=int, default=2000)
    parser.add_argument("--file")
    parser.add_argument("--no-wait", action="store_true")
    parser.add_argument("--source")
    args = parser.parse_args()
    if args.source:
        sys.path.insert(0, args.source)
    import numpy as np

    def rss_mb() -> int:
        # ru_maxrss: bytes on macOS, kilobytes on Linux.
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return round(peak / 1e6) if sys.platform == "darwin" else round(peak / 1e3)

    started = time.perf_counter()
    if args.file:
        data = args.file
    else:
        import anndata as ad
        import pandas as pd
        from scipy import sparse

        n, k, g = args.cells, args.per_cell, args.genes
        rng = np.random.default_rng(0)
        cols = np.empty(n * k, dtype=np.int32)
        for start in range(0, n, 1 << 20):
            end = min(n, start + (1 << 20))
            base = rng.integers(0, g, end - start)
            step = rng.integers(1, g // k, end - start)
            cols[start * k : end * k] = np.sort((base[:, None] + np.arange(k)[None, :] * step[:, None]) % g, axis=1).ravel()
        X = sparse.csr_matrix(
            (rng.geometric(0.5, n * k).astype(np.float32), cols, np.arange(n + 1, dtype=np.int64) * k), shape=(n, g)
        )
        obs = pd.DataFrame(
            {
                "cluster": pd.Categorical.from_codes((np.arange(n, dtype=np.uint64) * 2654435761 % 30).astype(np.int64), [f"type {i}" for i in range(30)]),
                "sample": pd.Categorical.from_codes(np.arange(n) % 12, [f"s{i}" for i in range(12)]),
                "n_genes": rng.integers(200, 5000, n).astype(np.int32),
                "total_counts": rng.gamma(2.0, 2000.0, n).astype(np.float32),
                "score": rng.normal(size=n),
                "doublet": rng.random(n) < 0.05,
            },
            index=pd.Index(np.char.add("c", np.arange(n).astype(str)).astype(object)),
        )
        data = ad.AnnData(X=X, obs=obs, var=pd.DataFrame(index=[f"G{i}" for i in range(g)]))
        data.obsm["X_umap"] = rng.normal(size=(n, 2)).astype(np.float32)
        data.obsm["X_pca"] = rng.normal(size=(n, 50 if n <= 2_000_000 else 30)).astype(np.float32)
    print(json.dumps({"built_s": round(time.perf_counter() - started, 2), "rss_mb": rss_mb()}), flush=True)
    from cellucid.anndata_server import AnnDataServer

    started = time.perf_counter()
    server = AnnDataServer(data, port=args.port, quiet=True, serve_web_ui=False, dataset_name="served", dataset_id="served")
    made = time.perf_counter() - started
    server.start_background()
    print(json.dumps({"server_made_s": round(made, 2), "rss_mb": rss_mb()}), flush=True)
    priority = getattr(server._served, "priority", None)
    if priority is not None and not args.no_wait:
        started = time.perf_counter()
        priority.laid_out()
        print(json.dumps({"laid_out_s": round(time.perf_counter() - started, 2), "rss_mb": rss_mb()}), flush=True)
    print("READY", flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
