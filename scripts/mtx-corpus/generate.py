"""The MatrixMarket folder corpus: small count matrices laid out as each
producer lays them out, with what scanpy / scipy read back from them
(``<folder>.expected.json``), for tests/rds-corpus-conformance.test.mjs.

Usage: python -I generate.py <out-dir>   (needs numpy, scipy, pandas, scanpy)
"""

import gzip
import importlib.metadata
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import scanpy as sc
import scipy.io
import scipy.sparse as sp

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(11)
N_CELLS, N_GENES = 90, 40
counts = sp.random(N_GENES, N_CELLS, density=0.25, random_state=3, format="csc", dtype=np.float64)
counts.data = np.floor(counts.data * 20) + 1
genes = [f"ENSG{i:05d}" for i in range(N_GENES)]
symbols = [f"GENE{i}" for i in range(N_GENES)]
symbols[5] = symbols[4]  # a duplicated symbol, as real gene lists have
types = ["Gene Expression"] * (N_GENES - 4) + ["Antibody Capture"] * 4
barcodes = ["".join(rng.choice(list("ACGT"), 16)) + "-1" for _ in range(N_CELLS)]
umap = rng.normal(size=(N_CELLS, 2))
clusters = rng.integers(0, 4, N_CELLS)


def write_lines(path, rows, compress):
    text = "".join("\t".join(row) + "\n" for row in rows).encode()
    if compress:
        path = path.with_name(path.name + ".gz")
        path.write_bytes(gzip.compress(text, mtime=0))
    else:
        path.write_bytes(text)


def write_mtx(path, matrix, compress, field="integer"):
    scipy.io.mmwrite(str(path), sp.coo_matrix(matrix), field=field)
    if compress:
        data = path.read_bytes()
        path.with_name(path.name + ".gz").write_bytes(gzip.compress(data, mtime=0))
        path.unlink()


def matrix_record(x):
    x = sp.csr_matrix(x)
    rows = []
    for cell in range(min(3, x.shape[0])):
        start, end = x.indptr[cell], x.indptr[cell + 1]
        order = np.argsort(x.indices[start:end])
        rows.append({"cell": cell, "indices": x.indices[start:end][order].tolist(), "values": x.data[start:end][order].tolist()})
    return {"shape": list(x.shape), "nnz": int(x.nnz), "sum": float(x.sum()), "rows": rows}


def modalities_of(x_cells_by_genes, var_names, feature_types=None):
    """One modality per feature type (the 10x .h5 contract): named by the
    type, Gene Expression first; one type, or none named, is "RNA"."""
    x = sp.csc_matrix(x_cells_by_genes)
    names = [] if feature_types is None else list(dict.fromkeys(feature_types))
    if len(names) <= 1:
        return [{"name": "RNA", "varNames": list(var_names), "X": matrix_record(x), "counts": None}]
    names.sort(key=lambda name: name != "Gene Expression")
    out = []
    for name in names:
        keep = [i for i, t in enumerate(feature_types) if t == name]
        out.append({"name": name, "varNames": [var_names[i] for i in keep], "X": matrix_record(x[:, keep]), "counts": None})
    return out


def expected(name, x_cells_by_genes, var_names, obs, obsm, extra=None, feature_types=None):
    x = sp.csr_matrix(x_cells_by_genes)
    record = {
        "file": name,
        "outcome": "open",
        "kind": "MatrixMarket",
        "nObs": int(x.shape[0]),
        "obsNames": list(obs.index),
        "obs": {col: {"kind": "double", "values": [None if np.isnan(v) else float(v) for v in obs[col]]} if obs[col].dtype.kind == "f"
                else {"kind": "categorical", "categories": sorted(set(obs[col].astype(str))),
                      "codes": [sorted(set(obs[col].astype(str))).index(v) for v in obs[col].astype(str)], "ordered": False}
                for col in obs.columns},
        "obsm": {key: value.T.reshape(-1).tolist() for key, value in obsm.items()},
        "obsp": {},
        "modalities": modalities_of(x, var_names, feature_types),
        "writer": f"scipy {scipy.__version__}, scanpy {importlib.metadata.version('scanpy')}",
    }
    record.update(extra or {})
    (OUT / f"{name}.expected.json").write_text(json.dumps(record))


def metadata_frame(cells):
    return pd.DataFrame({"barcode": cells, "UMAP_1": umap[:, 0], "UMAP_2": umap[:, 1],
                         "cell_type": [f"type{c}" for c in clusters], "score": rng.normal(size=N_CELLS)})


# Cell Ranger 3+: matrix.mtx.gz, features.tsv.gz, barcodes.tsv.gz, and a metadata table.
folder = OUT / "cellranger3"
shutil.rmtree(folder, ignore_errors=True)
(folder / "filtered_feature_bc_matrix").mkdir(parents=True)
write_mtx(folder / "filtered_feature_bc_matrix" / "matrix.mtx", counts, True)
write_lines(folder / "filtered_feature_bc_matrix" / "features.tsv", zip(genes, symbols, types), True)
write_lines(folder / "filtered_feature_bc_matrix" / "barcodes.tsv", [[b] for b in barcodes], True)
meta = metadata_frame(barcodes)
meta.to_csv(folder / "cell_metadata.csv", index=False)
adata = sc.read_10x_mtx(folder / "filtered_feature_bc_matrix", var_names="gene_symbols", make_unique=False, gex_only=False)
obs = meta.set_index("barcode")[["cell_type", "score"]]
# Gene Expression and Antibody Capture: one modality each; the root var is
# the default (Gene Expression) modality's.
gex = [i for i, t in enumerate(types) if t == "Gene Expression"]
expected("cellranger3", adata.X, symbols, obs, {"X_umap": umap},
         {"varColumns": {"gene_ids": [genes[i] for i in gex], "feature_types": [types[i] for i in gex]}}, feature_types=types)

# Cell Ranger 2 / STARsolo: plain matrix.mtx (written `real`), genes.tsv, barcodes.tsv;
# Cell Ranger's own analysis/ projection and clusters beside it.
folder = OUT / "cellranger2"
shutil.rmtree(folder, ignore_errors=True)
(folder / "matrix").mkdir(parents=True)
write_mtx(folder / "matrix" / "matrix.mtx", counts, False, field="real")
write_lines(folder / "matrix" / "genes.tsv", zip(genes, symbols), False)
write_lines(folder / "matrix" / "barcodes.tsv", [[b] for b in barcodes], False)
(folder / "analysis" / "tsne" / "2_components").mkdir(parents=True)
pd.DataFrame({"Barcode": barcodes, "TSNE-1": umap[:, 1], "TSNE-2": umap[:, 0]}).to_csv(folder / "analysis" / "tsne" / "2_components" / "projection.csv", index=False)
(folder / "analysis" / "clustering" / "graphclust").mkdir(parents=True)
pd.DataFrame({"Barcode": barcodes, "Cluster": clusters + 1}).to_csv(folder / "analysis" / "clustering" / "graphclust" / "clusters.csv", index=False)
obs = pd.DataFrame({"graphclust": (clusters + 1).astype(str)}, index=barcodes)
expected("cellranger2", counts.T, symbols, obs, {"X_tsne": umap[:, [1, 0]]})

# kb-python: cells x genes, entries sorted by gene (not by cell).
folder = OUT / "kb"
shutil.rmtree(folder, ignore_errors=True)
folder.mkdir()
cells_by_genes = sp.coo_matrix(counts.T)
order = np.lexsort((cells_by_genes.row, cells_by_genes.col))
scipy.io.mmwrite(str(folder / "cells_x_genes.mtx"), sp.coo_matrix((cells_by_genes.data[order], (cells_by_genes.row[order], cells_by_genes.col[order])), shape=cells_by_genes.shape), field="integer")
write_lines(folder / "cells_x_genes.genes.txt", [[g] for g in genes], False)
write_lines(folder / "cells_x_genes.barcodes.txt", [[b] for b in barcodes], False)
meta = metadata_frame(barcodes)
meta.to_csv(folder / "metadata.tsv", sep="\t", index=False)
obs = meta.set_index("barcode")[["cell_type", "score"]]
expected("kb", counts.T, genes, obs, {"X_umap": umap})

# No embedding anywhere: refused.
folder = OUT / "noembedding"
shutil.rmtree(folder, ignore_errors=True)
folder.mkdir()
write_mtx(folder / "matrix.mtx", counts, True)
write_lines(folder / "features.tsv", zip(genes, symbols, types), True)
write_lines(folder / "barcodes.tsv", [[b] for b in barcodes], True)
(OUT / "noembedding.expected.json").write_text(json.dumps({"file": "noembedding", "outcome": "refuse", "reason": "no-embedding"}))

# A symmetric matrix is not a count matrix: refused.
folder = OUT / "symmetric"
shutil.rmtree(folder, ignore_errors=True)
folder.mkdir()
square = sp.random(N_CELLS, N_CELLS, density=0.05, random_state=1)
scipy.io.mmwrite(str(folder / "matrix.mtx"), square + square.T, symmetry="symmetric")
write_lines(folder / "features.tsv", [[b] for b in barcodes], False)
write_lines(folder / "barcodes.tsv", [[b] for b in barcodes], False)
(OUT / "symmetric.expected.json").write_text(json.dumps({"file": "symmetric", "outcome": "refuse", "reason": "unsupported"}))
