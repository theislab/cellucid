# The R object corpus: small Seurat and SingleCellExperiment objects written
# by the real writers (SeuratObject 4 and 5, SingleCellExperiment), in every
# compression and serialization version R writes, each with what R itself
# reads back from it (`<name>.expected.json`, through the packages'
# accessors), for tests/rds-corpus-conformance.test.mjs.
#
# Usage: Rscript generate.R <out-dir> <set>
#   <set>: so5 (SeuratObject 5 + SingleCellExperiment), so4 (SeuratObject 4)
# Each set runs with its packages first on .libPaths(); see README.md.

args <- commandArgs(TRUE)
out <- args[1]
set <- args[2]
dir.create(out, recursive = TRUE, showWarnings = FALSE)
suppressPackageStartupMessages({
  library(Matrix)
  library(jsonlite)
  library(SeuratObject)
})
set.seed(7)

writer <- paste0("R ", R.version$major, ".", R.version$minor, ", SeuratObject ", packageVersion("SeuratObject"))
if (requireNamespace("SingleCellExperiment", quietly = TRUE)) {
  writer <- paste0(writer, ", SingleCellExperiment ", packageVersion("SingleCellExperiment"))
}

# ---------------------------------------------------------------------------
# What R reads back, as JSON.
# ---------------------------------------------------------------------------

num <- function(x) {
  x <- as.numeric(x)
  lapply(x, function(v) if (is.na(v) && !is.nan(v)) NULL else if (is.nan(v)) "NaN" else v)
}

column_json <- function(x) {
  if (is.factor(x)) {
    return(list(kind = "categorical", categories = I(levels(x)), codes = I(ifelse(is.na(x), -1L, as.integer(x) - 1L)),
                ordered = is.ordered(x)))
  }
  if (is.character(x)) {
    cats <- sort(unique(x[!is.na(x)]), method = "radix")
    return(list(kind = "categorical", categories = I(cats), codes = I(ifelse(is.na(x), -1L, match(x, cats) - 1L)), ordered = FALSE))
  }
  if (is.logical(x)) return(list(kind = "logical", values = lapply(x, function(v) if (is.na(v)) NULL else v)))
  if (is.integer(x)) return(list(kind = "integer", values = lapply(x, function(v) if (is.na(v)) NULL else v)))
  list(kind = "double", values = num(x))
}

# A sparse or dense features x cells matrix as cells x features summaries.
matrix_json <- function(m) {
  m <- as(as(m, "CsparseMatrix"), "generalMatrix")
  if (!is(m, "dMatrix")) m <- as(m, "dMatrix")
  cells <- seq_len(min(ncol(m), 3))
  list(
    shape = c(ncol(m), nrow(m)),
    nnz = length(m@x),
    sum = sum(m@x),
    rows = lapply(cells, function(j) {
      lo <- m@p[j] + 1
      hi <- m@p[j + 1]
      idx <- if (hi >= lo) lo:hi else integer(0)
      list(cell = j - 1, indices = I(m@i[idx]), values = num(m@x[idx]))
    })
  )
}

graph_json <- function(g) {
  g <- as(g, "CsparseMatrix")
  list(nnz = length(g@x), sum = sum(g@x))
}

expected <- list()
record <- function(name, value) {
  value$writer <- writer
  write(toJSON(value, auto_unbox = TRUE, digits = I(17), null = "null", na = "null", pretty = FALSE),
        file.path(out, paste0(name, ".expected.json")))
}

refusal <- function(name, reason) record(name, list(file = name, outcome = "refuse", reason = reason))

seurat_expected <- function(file, seu, extra = list()) {
  assays <- SeuratObject::Assays(seu)
  active <- DefaultAssay(seu)
  assays <- c(active, setdiff(assays, active))
  md <- seu[[]]
  obs <- lapply(md, column_json)
  if (!"active_ident" %in% names(md)) obs$active_ident <- column_json(Idents(seu))
  embeddings <- lapply(Reductions(seu), function(r) num(Embeddings(seu, r)))
  names(embeddings) <- paste0("X_", Reductions(seu))
  mods <- lapply(assays, function(a) {
    layer <- function(which) {
      if (packageVersion("SeuratObject") >= "5.0.0") {
        ls <- Layers(seu[[a]], search = which)
        if (length(ls) == 0) return(NULL)
        joined <- if (length(ls) > 1) JoinLayers(seu[[a]], layers = which) else seu[[a]]
        LayerData(joined, layer = which)
      } else {
        m <- GetAssayData(seu, assay = a, slot = which)
        if (length(m) == 0) NULL else m
      }
    }
    data <- layer("data")
    counts <- layer("counts")
    x <- if (!is.null(data)) data else counts
    list(name = a, varNames = I(rownames(seu[[a]])), X = matrix_json(x),
         counts = if (!is.null(data) && !is.null(counts)) matrix_json(counts) else NULL)
  })
  record(file, c(list(
    file = file, outcome = "open", kind = "Seurat",
    nObs = ncol(seu), obsNames = I(Cells(seu)), obs = obs,
    obsm = embeddings,
    obsp = lapply(seu@graphs, graph_json),
    modalities = mods,
    uns = if (!is.null(seu@misc$cellucid)) list(cellucid = seu@misc$cellucid) else NULL
  ), extra))
}

# ---------------------------------------------------------------------------
# Small objects.
# ---------------------------------------------------------------------------

n_cells <- 120
n_genes <- 60
genes <- paste0("Gene", seq_len(n_genes))
genes[3] <- "HLA-A"
cells <- paste0("AAAC", sprintf("%04d", seq_len(n_cells)), "-1")
counts <- rsparsematrix(n_genes, n_cells, density = 0.2, rand.x = function(n) as.numeric(rpois(n, 3) + 1))
dimnames(counts) <- list(genes, cells)

cell_metadata <- function(n) {
  group <- factor(sample(c("A", "B", "C"), n, TRUE), levels = c("A", "B", "C", "unused"))
  group[c(2, 5)] <- NA
  label <- sample(c("x", "yé"), n, TRUE)
  label[7] <- NA
  flag <- sample(c(TRUE, FALSE), n, TRUE)
  flag[4] <- NA
  count <- sample(1:50, n, TRUE)
  count[9] <- NA
  data.frame(group = group, label = label, flag = flag, count = count, score = rnorm(n),
             stage = factor(sample(c("early", "late"), n, TRUE), levels = c("early", "late"), ordered = TRUE),
             seq = seq_len(n), named = as.character(seq_len(n)), cluster = factor(sample(0:4, n, TRUE)),
             row.names = cells[seq_len(n)], stringsAsFactors = FALSE)
}

make_seurat <- function(assay_version = "v5") {
  options(Seurat.object.assay.version = assay_version)
  seu <- CreateSeuratObject(counts = counts, project = "corpus")
  seu <- AddMetaData(seu, cell_metadata(n_cells))
  data <- counts
  data@x <- log1p(data@x)
  if (packageVersion("SeuratObject") >= "5.0.0") {
    LayerData(seu, layer = "data") <- data
  } else {
    seu <- SetAssayData(seu, slot = "data", new.data = data)
  }
  pcs <- matrix(rnorm(n_cells * 5), n_cells, 5, dimnames = list(cells, paste0("PC_", 1:5)))
  seu[["pca"]] <- CreateDimReducObject(embeddings = pcs, key = "PC_", assay = "RNA")
  umap <- matrix(rnorm(n_cells * 2), n_cells, 2, dimnames = list(cells, c("umap_1", "umap_2")))
  seu[["umap"]] <- CreateDimReducObject(embeddings = umap, key = "umap_", assay = "RNA")
  um3 <- matrix(rnorm(n_cells * 3), n_cells, 3, dimnames = list(cells, paste0("UMAP3D_", 1:3)))
  seu[["UMAP3D"]] <- CreateDimReducObject(embeddings = um3, key = "UMAP3D_", assay = "RNA")
  snn <- rsparsematrix(n_cells, n_cells, density = 0.05, symmetric = TRUE)
  snn <- as(abs(snn), "generalMatrix")
  dimnames(snn) <- list(cells, cells)
  seu[["RNA_snn"]] <- as.Graph(snn)
  VariableFeatures(seu) <- genes[1:10]
  Idents(seu) <- "cluster"
  seu@misc$cellucid <- list(schema = 1L, id = "corpus-seurat", name = "Corpus Seurat object")
  seu
}

if (set == "so5") {
  seu <- make_seurat("v5")
  for (comp in c("gzip", "bzip2", "xz")) {
    file <- paste0("seurat5_", comp, ".rds")
    saveRDS(seu, file.path(out, file), compress = comp)
    seurat_expected(file, seu)
  }
  saveRDS(seu, file.path(out, "seurat5_none.rds"), compress = FALSE)
  seurat_expected("seurat5_none.rds", seu, list(random = TRUE))
  saveRDS(seu, file.path(out, "seurat5_v2.rds"), version = 2)
  seurat_expected("seurat5_v2.rds", seu)

  # Split layers (split()), and an object with two assays.
  split <- seu
  split[["RNA"]] <- split(split[["RNA"]], f = split$stage)
  saveRDS(split, file.path(out, "seurat5_split.rds"))
  seurat_expected("seurat5_split.rds", split)

  multi <- seu
  adt <- rsparsematrix(8, n_cells, density = 0.6, rand.x = function(n) as.numeric(rpois(n, 20)))
  dimnames(adt) <- list(paste0("CD", 1:8), cells)
  multi[["ADT"]] <- CreateAssay5Object(counts = adt)
  saveRDS(multi, file.path(out, "seurat5_multi.rds"))
  seurat_expected("seurat5_multi.rds", multi)

  # The v3/v4 Assay class written by SeuratObject 5.
  v3 <- make_seurat("v3")
  saveRDS(v3, file.path(out, "seurat5_assayv3.rds"))
  seurat_expected("seurat5_assayv3.rds", v3)

  # No embedding: refused.
  bare <- CreateSeuratObject(counts = counts)
  saveRDS(bare, file.path(out, "seurat5_noembedding.rds"))
  refusal("seurat5_noembedding.rds", "no-embedding")

  # A layer kept outside the file (a BPCells matrix folder): refused.
  # The class as BPCells defines it, without BPCells installed: its package
  # attribute is what a saved object carries.
  in_package <- function(object, package) {
    cls <- class(object)
    attr(cls, "package") <- package
    class(object) <- cls
    object
  }
  setClass("MatrixDir", representation(dir = "character", compressed = "logical"))
  outside <- seu
  outside@assays$RNA@layers <- list(counts = in_package(new("MatrixDir", dir = "/home/user/bpcells/counts", compressed = TRUE), "BPCells"))
  saveRDS(outside, file.path(out, "seurat5_bpcells.rds"))
  refusal("seurat5_bpcells.rds", "external-matrix")

  # A Seurat v2 object (class `seurat`): refused.
  setClass("seurat", representation(raw.data = "ANY", project.name = "character"))
  saveRDS(in_package(new("seurat", raw.data = counts, project.name = "old"), "Seurat"), file.path(out, "seurat2.rds"))
  refusal("seurat2.rds", "old-version")

  suppressPackageStartupMessages(library(SingleCellExperiment))
  logc <- counts
  logc@x <- log1p(logc@x)
  sce <- SingleCellExperiment(assays = list(counts = counts, logcounts = logc),
                              colData = DataFrame(cell_metadata(n_cells)),
                              rowData = DataFrame(symbol = tolower(genes), mean = rnorm(n_genes)))
  reducedDim(sce, "PCA") <- matrix(rnorm(n_cells * 4), n_cells, 4)
  reducedDim(sce, "UMAP") <- matrix(rnorm(n_cells * 2), n_cells, 2)
  sizeFactors(sce) <- runif(n_cells, 0.5, 2)
  adt_sce <- SingleCellExperiment(assays = list(counts = adt))
  altExp(sce, "ADT") <- adt_sce
  colPair(sce, "knn") <- SelfHits(from = rep(seq_len(n_cells), each = 2), to = c(rbind(c(2:n_cells, 1), c(3:n_cells, 1, 2))),
                                 nnode = n_cells, value = runif(n_cells * 2))
  metadata(sce)$cellucid <- list(schema = 1L, id = "corpus-sce")
  sce_expected <- function(file, sce) {
    cd <- as.data.frame(colData(sce))
    obs <- lapply(cd, column_json)
    obsm <- lapply(reducedDimNames(sce), function(r) num(reducedDim(sce, r)))
    names(obsm) <- paste0("X_", reducedDimNames(sce))
    xname <- if ("logcounts" %in% assayNames(sce)) "logcounts" else "counts"
    mods <- list(list(name = if (is.null(mainExpName(sce))) "main" else mainExpName(sce), varNames = I(rownames(sce)),
                      X = matrix_json(assay(sce, xname)),
                      counts = if (xname != "counts" && "counts" %in% assayNames(sce)) matrix_json(assay(sce, "counts")) else NULL))
    for (a in altExpNames(sce)) {
      e <- altExp(sce, a)
      mods[[length(mods) + 1]] <- list(name = a, varNames = I(rownames(e)), X = matrix_json(assay(e, 1)), counts = NULL)
    }
    record(file, list(file = file, outcome = "open", kind = "SingleCellExperiment", nObs = ncol(sce), obsNames = I(colnames(sce)),
                      obs = obs, obsm = obsm,
                      obsp = lapply(colPairs(sce, asSparse = TRUE), graph_json),
                      modalities = mods, uns = list(cellucid = metadata(sce)$cellucid)))
  }
  saveRDS(sce, file.path(out, "sce.rds"))
  sce_expected("sce.rds", sce)
  saveRDS(sce, file.path(out, "sce_none.rds"), compress = FALSE)
  sce_expected("sce_none.rds", sce)

  dense <- SingleCellExperiment(assays = list(logcounts = as.matrix(logc)), colData = DataFrame(cell_metadata(n_cells)))
  reducedDim(dense, "UMAP") <- matrix(rnorm(n_cells * 2), n_cells, 2)
  saveRDS(dense, file.path(out, "sce_dense.rds"))
  sce_expected("sce_dense.rds", dense)

  se <- SummarizedExperiment::SummarizedExperiment(assays = list(counts = counts))
  saveRDS(se, file.path(out, "se.rds"))
  refusal("se.rds", "no-embedding")

  # A save() file with two single-cell objects and a data frame: the choice.
  df <- data.frame(a = 1:3)
  save(seu, sce, df, file = file.path(out, "two_objects.rda"))
  record("two_objects.rda", list(file = "two_objects.rda", outcome = "choose", objects = c("seu", "sce"),
                                 kinds = c("Seurat", "SingleCellExperiment"), nObs = c(n_cells, n_cells)))
  pbmc <- seu
  save(pbmc, df, file = file.path(out, "one_object.RData"), compress = "xz")
  seurat_expected("one_object.RData", pbmc)
}

if (set == "so4") {
  seu <- make_seurat("v3")
  saveRDS(seu, file.path(out, "seurat4.rds"))
  seurat_expected("seurat4.rds", seu)
  saveRDS(seu, file.path(out, "seurat4_v2_none.rds"), version = 2, compress = FALSE)
  seurat_expected("seurat4_v2_none.rds", seu, list(random = TRUE))
}

# Real files the packages ship (MIT-licensed SeuratObject and Seurat data),
# copied in as they are, with what R reads back from them.
if (set == "samples") {
  for (path in args[-(1:2)]) {
    name <- paste0(basename(dirname(dirname(dirname(path)))), "_", basename(path))
    file.copy(path, file.path(out, name), overwrite = TRUE)
    env <- new.env()
    loaded <- tryCatch({
      objects <- load(path, envir = env)
      suppressWarnings(suppressMessages(UpdateSeuratObject(env[[objects[1]]])))
    }, error = function(e) NULL)
    # An object whose classes need a package not installed here (Seurat 3's
    # own classes) is recorded as one that must open, without values.
    if (is.null(loaded)) {
      record(name, list(file = name, outcome = "open", source = path, values = FALSE))
    } else {
      seurat_expected(name, loaded, list(source = path))
    }
  }
}
