"""Write one writer's fixtures of the layout-view corpus, and what they hold.

Runs inside one writer's virtual environment (`generate.py` makes them):

    python write_fixtures.py <writer> <output folder>

`<writer>` is one of `WRITERS` below. Each fixture is written with the
writer's own library where it writes that layout (loompy, mudata), or with
h5py exactly as the producer writes it where the producer is not a Python
library (Cell Ranger, SCope, loomR); then it is read back with the reading
library of its ecosystem (loompy, `scanpy.read_10x_h5`, `mudata.read`) and
what that library read is stored beside it as `<file>.expected.json`. The
browser's layout views (`assets/js/data/anndata/views/`) are tested value for
value against those files (`tests/formats-corpus-conformance.test.mjs`).

Every array is drawn from a seeded generator, so a writer writes the same
values on every run.

Expected values (JSON; NaN as "NaN"):

    format        the input format id the browser must find
    refusal       null, or the reason of the refusal the browser must give
    nObs          the cells
    obsNames      every cell name, in order
    obs           {key: {"values": [...]} | {"categories": [...], "codes": [...]}}
    obsm          {key: {"shape": [n, k], "values": [...]}} row-major
    obsp          {key: {"indptr": [...], "indices": [...], "data": [...]}} CSR, sorted
    varNames      the default feature space's feature names, as stored
    X             the default feature space's values, cells x features, row-major
    modalities    null, or {"default": name, "order": [...], "items":
                  {name: {"varNames": [...], "X": [...], "nCells": int}}}, X on
                  the dataset's cells (NaN where the modality did not measure one)
"""

from __future__ import annotations

import html
import json
import math
import sys
from importlib import metadata
from pathlib import Path
from typing import Any

import h5py
import numpy as np
from scipy import sparse

# ---------------------------------------------------------------------------
# Shared values
# ---------------------------------------------------------------------------


def rng(seed: int) -> np.random.Generator:
    return np.random.default_rng(seed)


def counts(generator: np.random.Generator, cells: int, genes: int, density: float = 0.3) -> np.ndarray:
    """A cells x genes integer count matrix with about `density` non-zeros."""
    values = generator.integers(1, 30, size=(cells, genes))
    mask = generator.random((cells, genes)) < density
    return (values * mask).astype(np.int64)


def number(value: Any) -> Any:
    value = float(value)
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    return value


def numbers(values: Any) -> list[Any]:
    return [number(value) for value in np.asarray(values, dtype=np.float64).ravel()]


def text(value: Any) -> str:
    return value.decode("utf-8") if isinstance(value, bytes) else str(value)


def obs_column(values: Any) -> dict[str, Any]:
    """One obs column as the browser shows it: text, a category list, or numbers."""
    array = np.asarray(values)
    if hasattr(values, "cat"):
        categories = [text(item) for item in values.cat.categories]
        return {"categories": categories, "codes": [int(code) for code in values.cat.codes]}
    if array.dtype.kind in "OSU":
        return {"values": [None if item is None else text(item) for item in array]}
    return {"values": numbers(array)}


def csr_of(matrix: Any) -> dict[str, Any]:
    csr = sparse.csr_matrix(matrix)
    csr.sort_indices()
    return {
        "indptr": [int(value) for value in csr.indptr],
        "indices": [int(value) for value in csr.indices],
        "data": numbers(csr.data),
    }


def dense(matrix: Any) -> np.ndarray:
    return np.asarray(matrix.toarray() if sparse.issparse(matrix) else matrix, dtype=np.float64)


def write_expected(path: Path, expected: dict[str, Any]) -> None:
    Path(f"{path}.expected.json").write_text(json.dumps(expected, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def base_expected(fmt: str, **values: Any) -> dict[str, Any]:
    return {
        "format": fmt,
        "refusal": None,
        "nObs": None,
        "obsNames": [],
        "obs": {},
        "obsm": {},
        "obsp": {},
        "varNames": [],
        "X": [],
        "modalities": None,
        **values,
    }


def refused(path: Path, fmt: str, reason: str) -> None:
    write_expected(path, {**base_expected(fmt), "refusal": reason})


# ---------------------------------------------------------------------------
# Loom
# ---------------------------------------------------------------------------

CELLS = 48
GENES = 36


def loom_expected(path: Path, *, obs_keys: dict[str, str], obsm: dict[str, list[str]], obsp: list[str]) -> dict[str, Any]:
    """What loompy reads from a Loom file, named as the browser presents it.

    `obs_keys`: presented obs key -> column attribute; `obsm`: presented key
    -> the column attributes stacked into it (one name for a two-dimensional
    attribute); `obsp`: the column graphs.
    """
    import loompy

    # loompy 3.0.8 drops the non-ASCII characters of the UTF-8 text it reads
    # (`cell_0_é` reads as `cell_0_`), so text is read with h5py, as stored
    # (Loom 2's character references decoded); numbers are loompy's.
    with h5py.File(path, "r") as file:
        def stored_text(group: str, key: str) -> list[str]:
            values = [text(item) for item in file[group][key][:]]
            return [html.unescape(value) for value in values] if file[group][key].dtype.kind == "S" else values

        cell_ids = stored_text("col_attrs", "CellID")
        genes = stored_text("row_attrs", "Gene")
        text_columns = {
            key: stored_text("col_attrs", attribute)
            for key, attribute in obs_keys.items()
            if file["col_attrs"][attribute].dtype.kind in "OSU"
        }
    with loompy.connect(str(path), "r", validate=False) as ds:
        matrix = np.asarray(ds[:, :], dtype=np.float64).T
        expected = base_expected(
            "loom",
            nObs=matrix.shape[0],
            obsNames=cell_ids,
            varNames=genes,
            X=numbers(matrix),
        )
        for key, attribute in obs_keys.items():
            expected["obs"][key] = {"values": text_columns[key]} if key in text_columns else obs_column(ds.ca[attribute])
        for key, attributes in obsm.items():
            stacked = (
                np.asarray(ds.ca[attributes[0]], dtype=np.float64)
                if len(attributes) == 1
                else np.column_stack([np.asarray(ds.ca[name], dtype=np.float64) for name in attributes])
            )
            expected["obsm"][key] = {"shape": list(stacked.shape), "values": numbers(stacked)}
        for key in obsp:
            graph = ds.col_graphs[key].tocsr()
            expected["obsp"][key] = csr_of(graph)
        layers = {}
        for layer in ds.layers.keys():
            if layer != "":
                layers[layer] = numbers(np.asarray(ds.layers[layer][:, :], dtype=np.float64).T)
        expected["layers"] = layers
    return expected


def write_loompy_3(out: Path) -> list[Path]:
    import loompy

    written = []
    generator = rng(30)
    matrix = counts(generator, CELLS, GENES)
    cells = np.array([f"cell_{index}_é" for index in range(CELLS)], dtype=object)
    genes = np.array([f"Gene{index}" for index in range(GENES)], dtype=object)
    genes[5] = genes[4]  # a repeated gene name, as Loom allows
    clusters = np.array([f"c{value}" for value in generator.integers(0, 4, CELLS)], dtype=object)
    umap = generator.normal(size=(CELLS, 2))

    # Plain: a two-dimensional X_umap, text and numeric attributes, a layer.
    path = out / "basic.loom"
    loompy.create(
        str(path),
        {"": matrix.T.astype(np.float32), "counts": matrix.T.astype(np.int32)},
        {"Gene": genes, "Accession": np.array([f"ENSG{index:011d}" for index in range(GENES)], dtype=object)},
        {"CellID": cells, "ClusterName": clusters, "nUMI": matrix.sum(axis=1).astype(np.float64), "X_umap": umap},
    )
    write_expected(path, loom_expected(
        path,
        obs_keys={"ClusterName": "ClusterName", "nUMI": "nUMI"},
        obsm={"X_umap": ["X_umap"]},
        obsp=[],
    ))
    written.append(path)

    # velocyto: spliced/unspliced/ambiguous layers, the embedding as _X/_Y.
    path = out / "velocyto.loom"
    loompy.create(
        str(path),
        {"": matrix.T.astype(np.uint32), "spliced": matrix.T.astype(np.uint32),
         "unspliced": (matrix.T // 3).astype(np.uint32), "ambiguous": (matrix.T // 7).astype(np.uint32)},
        {"Gene": genes, "Accession": np.array([f"ENSG{index:011d}" for index in range(GENES)], dtype=object)},
        {"CellID": cells, "_X": umap[:, 0].astype(np.float32), "_Y": umap[:, 1].astype(np.float32),
         "ClusterID": generator.integers(0, 4, CELLS)},
    )
    write_expected(path, loom_expected(
        path, obs_keys={"ClusterID": "ClusterID"}, obsm={"X_embedding": ["_X", "_Y"]}, obsp=[],
    ))
    written.append(path)

    # A neighbour graph, and a t-SNE stored as _tSNE1/_tSNE2 (LoomExperiment's names).
    path = out / "graphs.loom"
    knn = sparse.random(CELLS, CELLS, density=0.1, random_state=31, format="coo")
    knn = ((knn + knn.T) / 2).tocoo()
    loompy.create(
        str(path),
        matrix.T.astype(np.float32),
        {"Gene": genes},
        {"CellID": cells, "_tSNE1": umap[:, 0], "_tSNE2": umap[:, 1]},
    )
    with loompy.connect(str(path)) as ds:
        ds.col_graphs["KNN"] = knn
    write_expected(path, loom_expected(path, obs_keys={}, obsm={"X_tSNE": ["_tSNE1", "_tSNE2"]}, obsp=["KNN"]))
    written.append(path)

    # SCope / pySCENIC: compound embeddings, written as pySCENIC's export does.
    path = out / "scope.loom"
    loompy.create(str(path), matrix.T.astype(np.float32), {"Gene": genes}, {"CellID": cells})
    with h5py.File(path, "a") as file:
        default = np.zeros(CELLS, dtype=[("_X", "<f4"), ("_Y", "<f4")])
        default["_X"], default["_Y"] = umap[:, 0], umap[:, 1]
        file["col_attrs"].create_dataset("Embedding", data=default)
        more_x = np.zeros(CELLS, dtype=[("-1", "<f4"), ("1", "<f4")])
        more_y = np.zeros(CELLS, dtype=[("-1", "<f4"), ("1", "<f4")])
        more_x["-1"], more_y["-1"] = umap[:, 0], umap[:, 1]
        more_x["1"], more_y["1"] = umap[:, 1], -umap[:, 0]
        file["col_attrs"].create_dataset("Embeddings_X", data=more_x)
        file["col_attrs"].create_dataset("Embeddings_Y", data=more_y)
    expected = loom_expected(path, obs_keys={}, obsm={}, obsp=[])
    for key, (x, y) in {
        "X_embedding": (umap[:, 0], umap[:, 1]),
        "X_embedding_-1": (umap[:, 0], umap[:, 1]),
        "X_embedding_1": (umap[:, 1], -umap[:, 0]),
    }.items():
        stacked = np.column_stack([x.astype(np.float32), y.astype(np.float32)]).astype(np.float64)
        expected["obsm"][key] = {"shape": [CELLS, 2], "values": numbers(stacked)}
    write_expected(path, expected)
    written.append(path)

    # No embedding: refused, saying what to do.
    path = out / "no-embedding.loom"
    loompy.create(str(path), matrix.T.astype(np.float32), {"Gene": genes}, {"CellID": cells, "ClusterName": clusters})
    refused(path, "loom", "no-embedding")
    written.append(path)
    return written


def write_loomr(out: Path) -> list[Path]:
    """loomR's orientation: the matrix stored cells x genes, attributes as usual."""
    generator = rng(33)
    matrix = counts(generator, CELLS, GENES)
    umap = generator.normal(size=(CELLS, 2))
    path = out / "loomr-orientation.loom"
    string = h5py.string_dtype("utf-8")
    with h5py.File(path, "w") as file:
        file.attrs["LOOM_SPEC_VERSION"] = "3.0.0"
        file.create_dataset("matrix", data=matrix.astype(np.float64), chunks=(16, 16), compression="gzip")
        file.create_group("layers")
        file.create_group("row_graphs")
        file.create_group("col_graphs")
        rows = file.create_group("row_attrs")
        rows.create_dataset("Gene", data=np.array([f"G{index}" for index in range(GENES)], dtype=object), dtype=string)
        cols = file.create_group("col_attrs")
        cols.create_dataset("CellID", data=np.array([f"c{index}" for index in range(CELLS)], dtype=object), dtype=string)
        cols.create_dataset("umap_1", data=umap[:, 0])
        cols.create_dataset("umap_2", data=umap[:, 1])
    expected = base_expected(
        "loom",
        nObs=CELLS,
        obsNames=[f"c{index}" for index in range(CELLS)],
        varNames=[f"G{index}" for index in range(GENES)],
        X=numbers(matrix),
    )
    expected["obsm"]["X_umap"] = {"shape": [CELLS, 2], "values": numbers(umap)}
    expected["layers"] = {}
    write_expected(path, expected)
    return [path]


def write_loompy_2(out: Path) -> list[Path]:
    """Loom 2.0.1: global attributes on the root, text as ASCII with XML character references."""
    import loompy

    generator = rng(32)
    matrix = counts(generator, CELLS, GENES)
    umap = generator.normal(size=(CELLS, 2))
    path = out / "basic.loom"
    loompy.create(
        str(path),
        matrix.T.astype(np.float32),
        {"Gene": np.array([f"Gène{index}" for index in range(GENES)])},
        {"CellID": np.array([f"cell_{index}_é" for index in range(CELLS)]),
         "Tissue": np.array(["brain" if index % 2 else "liver" for index in range(CELLS)]),
         "X_umap": umap},
        file_attrs={"title": "Loom 2 sample"},
    )
    expected = loom_expected(path, obs_keys={"Tissue": "Tissue"}, obsm={"X_umap": ["X_umap"]}, obsp=[])
    expected["title"] = "Loom 2 sample"
    write_expected(path, expected)
    return [path]


# ---------------------------------------------------------------------------
# 10x Cell Ranger HDF5
# ---------------------------------------------------------------------------


def ascii_dataset(group: h5py.Group, name: str, values: list[str], *, compression: bool = True) -> None:
    """A Cell Ranger string dataset: fixed-length ASCII (cr_h5.create_hdf5_string_dataset)."""
    width = max([1, *(len(value) for value in values)])
    array = np.array([value.encode("ascii") for value in values], dtype=f"S{width}")
    if compression:
        group.create_dataset(name, data=array, compression="gzip", compression_opts=4, shuffle=True)
    else:
        group.create_dataset(name, data=array)


def matrix_arrays(group: h5py.Group, by_cell: sparse.csr_matrix, features: int) -> None:
    """data/indices/indptr/shape as Cell Ranger 3+ writes them (CountMatrix.save_h5_group)."""
    by_cell = by_cell.copy()
    by_cell.sort_indices()
    for name, values, dtype in (
        ("data", by_cell.data, np.int32),
        ("indices", by_cell.indices, np.int64),
        ("indptr", by_cell.indptr, np.int64),
        ("shape", np.array([features, by_cell.shape[0]]), np.int32),
    ):
        group.create_dataset(
            name, data=np.asarray(values, dtype=dtype), chunks=(80000,), maxshape=(None,),
            compression="gzip", compression_opts=4, shuffle=True,
        )


def tenx_v3(path: Path, by_cell: sparse.csr_matrix, barcodes: list[str], features: list[tuple[str, str, str]]) -> None:
    """A Cell Ranger 3+ filtered_feature_bc_matrix.h5: features (id, name, type)."""
    with h5py.File(path, "w") as file:
        file.attrs["filetype"] = "matrix"
        file.attrs["version"] = 2
        file.attrs["chemistry_description"] = "Single Cell 3' v3"
        file.attrs["library_ids"] = np.array([b"sample"])
        file.attrs["original_gem_groups"] = np.array([1])
        file.attrs["software_version"] = "cellranger-7.1.0"
        group = file.create_group("matrix")
        ascii_dataset(group, "barcodes", barcodes)
        reference = group.create_group("features")
        ascii_dataset(reference, "id", [item[0] for item in features])
        ascii_dataset(reference, "name", [item[1] for item in features])
        ascii_dataset(reference, "feature_type", [item[2] for item in features])
        ascii_dataset(reference, "genome", ["GRCh38" if item[2] == "Gene Expression" else "" for item in features])
        ascii_dataset(reference, "_all_tag_keys", ["genome"], compression=False)
        matrix_arrays(group, by_cell, len(features))


def tenx_expected(path: Path, *, genome: str | None = None) -> dict[str, Any]:
    """What scanpy.read_10x_h5 reads (every feature type), split by type."""
    import scanpy as sc

    adata = sc.read_10x_h5(str(path), genome=genome, gex_only=False)
    names = [text(item) for item in adata.var_names]
    values = dense(adata.X)
    expected = base_expected("tenx-h5", nObs=adata.n_obs, obsNames=[text(item) for item in adata.obs_names])
    types = list(adata.var["feature_types"]) if "feature_types" in adata.var else ["Gene Expression"] * adata.n_vars
    order = list(dict.fromkeys(types))
    if len(order) == 1:
        expected["varNames"] = names
        expected["X"] = numbers(values)
        return expected
    items = {}
    for kind in order:
        columns = [index for index, item in enumerate(types) if item == kind]
        items[kind] = {
            "varNames": [names[index] for index in columns],
            "X": numbers(values[:, columns]),
            "nCells": adata.n_obs,
        }
    default = "Gene Expression" if "Gene Expression" in order else order[0]
    expected["varNames"] = items[default]["varNames"]
    expected["X"] = items[default]["X"]
    expected["modalities"] = {"default": default, "order": order, "items": items}
    return expected


def write_tenx(out: Path) -> list[Path]:
    written = []
    generator = rng(40)
    cells = 40
    gex = counts(generator, cells, 30, 0.25)
    adt = counts(generator, cells, 6, 0.9)
    barcodes = [f"{''.join(generator.choice(list('ACGT'), 16))}-1" for _ in range(cells)]
    gene_features = [(f"ENSG{index:011d}", f"GENE{index}", "Gene Expression") for index in range(30)]
    gene_features[7] = (gene_features[7][0], "GENE6", "Gene Expression")  # a repeated symbol
    adt_features = [(f"CD{index}_TotalSeqB", f"CD{index}", "Antibody Capture") for index in range(6)]

    # Cell Ranger 3+, gene expression only; refused alone (no embedding), opened in outs/.
    path = out / "v3-gex.h5"
    tenx_v3(path, sparse.csr_matrix(gex), barcodes, gene_features)
    refused(path, "tenx-h5", "no-embedding")
    written.append(path)

    # CITE-seq: Gene Expression then Antibody Capture, one modality each.
    outs = out / "v3-citeseq-outs"
    outs.mkdir()
    path = outs / "filtered_feature_bc_matrix.h5"
    tenx_v3(path, sparse.csr_matrix(np.hstack([gex, adt])), barcodes, gene_features + adt_features)
    expected = tenx_expected(path)
    expected["format"] = "tenx-outs"
    # Cell Ranger's analysis: a UMAP, a t-SNE, a 10-component PCA and two
    # clusterings, one listing a cell the matrix does not have and missing one.
    analysis = outs / "analysis"
    umap = generator.normal(size=(cells, 2))
    tsne = generator.normal(size=(cells, 2))
    pca = generator.normal(size=(cells, 10))
    clusters = generator.integers(1, 5, cells)
    order = generator.permutation(cells)  # rows are matched by barcode, not by order
    for kind, folder, values, header in (
        ("umap", "gene_expression_2_components", umap, "UMAP"),
        ("tsne", "gene_expression_2_components", tsne, "TSNE"),
        ("pca", "gene_expression_10_components", pca, "PC"),
    ):
        target = analysis / kind / folder
        target.mkdir(parents=True)
        lines = ["Barcode," + ",".join(f"{header}-{index + 1}" for index in range(values.shape[1]))]
        lines += [barcodes[cell] + "," + ",".join(repr(float(value)) for value in values[cell]) for cell in order]
        (target / "projection.csv").write_text("\n".join(lines) + "\n", encoding="ascii")
        expected["obsm"][f"X_{kind}"] = {"shape": list(values.shape), "values": numbers(values)}
    target = analysis / "clustering" / "gene_expression_graphclust"
    target.mkdir(parents=True)
    lines = ["Barcode,Cluster"] + [f"{barcodes[cell]},{clusters[cell]}" for cell in order[1:]] + ["AAAAAAAAAAAAAAAA-9,1"]
    (target / "clusters.csv").write_text("\n".join(lines) + "\n", encoding="ascii")
    labels = sorted({int(value) for value in clusters[order[1:]]} | {1})
    codes = [labels.index(int(clusters[cell])) for cell in range(cells)]
    codes[order[0]] = -1
    expected["obs"]["gene_expression_graphclust"] = {"categories": [str(label) for label in labels], "codes": codes}
    write_expected(out / "v3-citeseq-outs", expected)
    written.append(outs)

    # The same CITE-seq matrix as a bare .h5: refused, pointing at outs/.
    path = out / "v3-citeseq.h5"
    tenx_v3(path, sparse.csr_matrix(np.hstack([gex, adt])), barcodes, gene_features + adt_features)
    refused(path, "tenx-h5", "no-embedding")
    written.append(path)

    # A molecule table: refused, naming the matrix to open.
    path = out / "molecule_info.h5"
    with h5py.File(path, "w") as file:
        file.attrs["filetype"] = "molecule"
        file.create_dataset("barcode_idx", data=np.arange(4, dtype=np.uint64))
    refused(path, "tenx-h5", "molecule-table")
    written.append(path)
    return written


def write_tenx_v2(out: Path, scanpy_data: Path) -> list[Path]:
    """Cell Ranger 1.2 files from scanpy's test data (BSD-3-Clause), read in an outs/ folder each."""
    written = []
    for source, folder in (
        ("1.2.0_filtered_gene_bc_matrices_h5.h5", "v2-outs"),
        ("1.2.0_multiple_genomes.h5", "v2-genomes-outs"),
    ):
        outs = out / folder
        outs.mkdir()
        path = outs / "filtered_gene_bc_matrices_h5.h5"
        path.write_bytes((scanpy_data / source).read_bytes())
        with h5py.File(path, "r") as file:
            genomes = [key for key in file.keys() if isinstance(file[key], h5py.Group)]
            barcodes = [text(item) for item in file[genomes[0]]["barcodes"][:]]
        import scanpy as sc

        if len(genomes) == 1:
            expected = tenx_expected(path)
        else:
            reads = {genome: sc.read_10x_h5(str(path), genome=genome) for genome in genomes}
            first = reads[genomes[0]]
            expected = base_expected("tenx-outs", nObs=first.n_obs, obsNames=[text(item) for item in first.obs_names])
            items = {
                genome: {
                    "varNames": [text(item) for item in adata.var_names],
                    "X": numbers(dense(adata.X)),
                    "nCells": adata.n_obs,
                }
                for genome, adata in reads.items()
            }
            expected["modalities"] = {"default": genomes[0], "order": genomes, "items": items}
            expected["varNames"] = items[genomes[0]]["varNames"]
            expected["X"] = items[genomes[0]]["X"]
        expected["format"] = "tenx-outs"
        projection = rng(41).normal(size=(len(barcodes), 2))
        target = outs / "analysis" / "tsne" / "2_components"
        target.mkdir(parents=True)
        lines = ["Barcode,TSNE-1,TSNE-2"] + [f"{barcode},{x!r},{y!r}" for barcode, (x, y) in zip(barcodes, projection.tolist())]
        (target / "projection.csv").write_text("\n".join(lines) + "\n", encoding="ascii")
        expected["obsm"]["X_tsne"] = {"shape": [len(barcodes), 2], "values": numbers(projection)}
        write_expected(out / folder, expected)
        written.append(outs)
    return written


# ---------------------------------------------------------------------------
# MuData
# ---------------------------------------------------------------------------


def mudata_expected(mdata: Any, fmt: str) -> dict[str, Any]:
    """What mudata reads, placed on the global cells as the browser presents it."""
    names = list(mdata.mod.keys())
    order = names
    obs_names = [text(item) for item in mdata.obs_names]
    position = {name: index for index, name in enumerate(obs_names)}
    expected = base_expected(fmt, nObs=mdata.n_obs, obsNames=obs_names)
    items = {}
    for name in order:
        modality = mdata.mod[name]
        values = dense(modality.X)
        placed = np.full((mdata.n_obs, modality.n_vars), np.nan)
        rows = [position[text(item)] for item in modality.obs_names]
        placed[rows, :] = values
        items[name] = {
            "varNames": [text(item) for item in modality.var_names],
            "X": numbers(placed),
            "nCells": modality.n_obs,
        }
        for key in modality.obs.columns:
            column = modality.obs[key]
            presented = f"{name}:{key}"
            if presented in mdata.obs.columns:
                continue
            if hasattr(column, "cat"):
                codes = np.full(mdata.n_obs, -1)
                codes[rows] = column.cat.codes.to_numpy()
                expected["obs"][presented] = {"categories": [text(item) for item in column.cat.categories], "codes": [int(code) for code in codes]}
            elif np.asarray(column).dtype.kind in "iuf":
                placed_column = np.full(mdata.n_obs, np.nan)
                placed_column[rows] = np.asarray(column, dtype=np.float64)
                expected["obs"][presented] = {"values": numbers(placed_column)}
        for key in modality.obsm.keys():
            array = np.asarray(modality.obsm[key], dtype=np.float64)
            placed_array = np.full((mdata.n_obs, array.shape[1]), np.nan)
            placed_array[rows, :] = array
            expected["obsm"][f"{name}:{key}"] = {"shape": list(placed_array.shape), "values": numbers(placed_array)}
    for key in mdata.obs.columns:
        expected["obs"][key] = obs_column(mdata.obs[key])
    for key in mdata.obsm.keys():
        if key in names:
            continue
        array = np.asarray(mdata.obsm[key], dtype=np.float64)
        expected["obsm"][key] = {"shape": list(array.shape), "values": numbers(array)}
    default = default_modality(order)
    expected["modalities"] = {"default": default, "order": order, "items": items}
    expected["varNames"] = items[default]["varNames"]
    expected["X"] = items[default]["X"]
    return expected


#: The data-mapping rule `defaultModality` (`assets/js/data/data-mapping.js`,
#: pinned by `tests/fixtures/data-mapping-conformance.json`), so the expected
#: values need no Cellucid package.
GENE_EXPRESSION_MODALITIES = ("rna", "gex", "gene expression", "gene_expression", "sct")


def default_modality(names: list[str]) -> str:
    return next((name for name in names if name.lower() in GENE_EXPRESSION_MODALITIES), names[0])


def citeseq_mudata(subset: bool) -> Any:
    import anndata as ad
    import mudata as md
    import pandas as pd

    generator = rng(50)
    cells = 44
    rna = ad.AnnData(sparse.csr_matrix(counts(generator, cells, 28, 0.25).astype(np.float32)))
    rna.obs_names = [f"cell{index}" for index in range(cells)]
    rna.var_names = [f"GENE{index}" for index in range(28)]
    rna.obs["leiden"] = pd.Categorical([f"{value}" for value in generator.integers(0, 3, cells)])
    rna.obs["n_counts"] = np.asarray(rna.X.sum(axis=1)).ravel().astype(np.float64)
    rna.obsm["X_umap"] = generator.normal(size=(cells, 2))
    rna.layers["counts"] = rna.X.copy()
    measured = cells - 8 if subset else cells
    protein = ad.AnnData(generator.normal(size=(measured, 5)).astype(np.float32))
    protein.obs_names = [f"cell{index}" for index in range(measured)]
    protein.var_names = [f"CD{index}" for index in range(5)]
    mdata = md.MuData({"prot": protein, "rna": rna})
    mdata.obsm["X_wnn_umap"] = generator.normal(size=(mdata.n_obs, 2))
    return mdata


def write_mudata(out: Path) -> list[Path]:
    import mudata as md

    written = []
    for name, subset in (("citeseq", False), ("citeseq-subset", True)):
        mdata = citeseq_mudata(subset)
        h5mu = out / f"{name}.h5mu"
        mdata.write(str(h5mu))
        write_expected(h5mu, mudata_expected(md.read_h5mu(str(h5mu)), "h5mu"))
        written.append(h5mu)
        store = out / f"{name}.zarr"
        mdata.write_zarr(str(store))
        write_expected(store, mudata_expected(md.read_zarr(str(store)), "mudata-zarr"))
        written.append(store)
    return written


# ---------------------------------------------------------------------------

WRITERS = {
    "loompy-3": lambda out, extra: write_loompy_3(out) + write_loomr(out),
    "loompy-2": lambda out, extra: write_loompy_2(out),
    "tenx": lambda out, extra: write_tenx(out) + write_tenx_v2(out, Path(extra)),
    "mudata": lambda out, extra: write_mudata(out),
}

LIBRARIES = ("loompy", "scanpy", "mudata", "anndata", "h5py", "numpy", "zarr")


def main() -> int:
    writer, out = sys.argv[1], Path(sys.argv[2])
    extra = sys.argv[3] if len(sys.argv) > 3 else ""
    out.mkdir(parents=True, exist_ok=True)
    written = WRITERS[writer](out, extra)
    versions = {}
    for name in LIBRARIES:
        try:
            versions[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            continue
    (out / "_writer.json").write_text(
        json.dumps({"writer": writer, "python": sys.version.split()[0], "packages": versions,
                    "fixtures": sorted(path.name for path in written)}, indent=1) + "\n",
        encoding="utf-8",
    )
    print(f"{writer}: {len(written)} fixtures")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
