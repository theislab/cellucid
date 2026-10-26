# R object and MatrixMarket corpora

The fixtures of `tests/rds-corpus-conformance.test.mjs`
(`tests/fixtures/rds/corpus.zip`): R objects written by the real writers,
and MatrixMarket folders in each producer's layout, each with what R or
scanpy reads back from it (`<name>.expected.json`).

| Script | Writes |
| --- | --- |
| `generate.R <out> so5` | SeuratObject 5 (`Assay5`, split layers, two assays, the v3 `Assay` class), SingleCellExperiment (sparse, dense, uncompressed, `altExps`, `colPairs`), a SummarizedExperiment, a `save()` file of two objects, an `.RData`; every compression (`gzip`, `bzip2`, `xz`, none) and serialization version 2; refusals (no embedding, a BPCells layer, a Seurat v2 object) |
| `generate.R <out> so4` | SeuratObject 4.1.4 (`Assay`), compressed and uncompressed version 2 |
| `generate.R <out> samples <file.rda>…` | the packages' own MIT-licensed samples (SeuratObject's `pbmc_small`) as they ship, with what R reads from them |
| `../mtx-corpus/generate.py <out>` | Cell Ranger 3 (gzip, `features.tsv`, a metadata table), Cell Ranger 2 (plain, `genes.tsv`, `analysis/` projection and clusters), kb-python (cells × genes, entries sorted by gene), refusals (no embedding, a symmetric matrix) |
| `pack.py <rds> <mtx> <zip>` | the archive, the same bytes for the same files |
| `materialize.mjs <zip> <out>` and `verify_with_python.py <out>` | every transcoded store as a Zarr folder, read with anndata (and mudata for several modalities) and checked against the expected values |
| `make_bench.R <cells> <out.rds>` | a large Seurat v5 object for timing the pass (not committed) |
| `check.mjs` | the checks of one corpus file against its expected values, shared by the conformance test and the drift check |
| `slots.R <out.json>` | the slots of every class the transcoders read, as the installed packages define them |
| `drift.mjs <corpus> <slots.json>` and `drift.sh [Rscript] [out]` | the drift check: a corpus written with the installed (current) packages, read by the transcoders, and their slots against `known-slots.json` |

Each R set runs with its packages first on the library path, in an R of its
own (none is installed into a repository or a shared environment):

```sh
RS=/path/to/Rscript
R_LIBS=/scratch/rlib/so5 $RS scripts/rds-corpus/generate.R /scratch/corpus so5   # SeuratObject 5.x + SingleCellExperiment
R_LIBS=/scratch/rlib/so4 $RS scripts/rds-corpus/generate.R /scratch/corpus so4   # SeuratObject 4.1.4
R_LIBS=/scratch/rlib/so5 $RS scripts/rds-corpus/generate.R /scratch/corpus samples \
  SeuratObject/data/pbmc_small.rda Seurat_3.0.0/Seurat/data/pbmc_small.rda
python -I scripts/mtx-corpus/generate.py /scratch/mtx                             # numpy, scipy, pandas, scanpy
python -I scripts/rds-corpus/pack.py /scratch/corpus /scratch/mtx tests/fixtures/rds/corpus.zip
node scripts/rds-corpus/materialize.mjs tests/fixtures/rds/corpus.zip /scratch/stores
python -I scripts/rds-corpus/verify_with_python.py /scratch/stores                # anndata, mudata
```

Seurat 3.0.0's `pbmc_small` needs Seurat's own classes for R to read it;
without Seurat installed it is recorded as a file that must open, without
values.

Last generated with R 4.5.3, SeuratObject 5.4.0 and 4.1.4,
SingleCellExperiment 1.32.0, scipy 1.18.0 and scanpy 1.11.5.

## Drift

`.github/workflows/r-corpus-drift.yml` runs `drift.sh` once a month (and
when the R readers or these scripts change) with the current CRAN
SeuratObject and Matrix and the current Bioconductor SingleCellExperiment: it
writes the `so5` set again, reads every file with the transcoders as the
conformance test does (`check.mjs`), and compares the slots those packages
define with `known-slots.json`. A new or removed slot fails it: list the slot
in the table of `assets/js/data/anndata/transcode/seurat.js` or `sce.js` (read,
or deliberately not read), then record it in `known-slots.json`
(`checkedWith` names the versions it was last checked against). Locally:

```sh
R_LIBS=/scratch/rlib/current sh scripts/rds-corpus/drift.sh /path/to/Rscript
```
