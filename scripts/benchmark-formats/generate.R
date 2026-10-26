# The R objects `npm run bench:formats` measures, built from the arrays
# generate.py writes (`cells-<n>-r-arrays/`): a Seurat v5 object (counts and
# log-normalised data, PCA, UMAP, an SNN graph of 30 neighbours per cell,
# clusters) saved with saveRDS() and with save(), and a SingleCellExperiment
# (counts, logcounts, PCA, UMAP, colData) saved with saveRDS(). R's defaults
# (gzip), as GEO and most shared objects come.
#
# Usage: Rscript generate.R <arrays-dir> <out-dir> [seurat,sce,rda] [counts-only]
# `counts-only` leaves the log-normalised layer out (an object of half the
# size, for sizes whose two layers R cannot hold at once on the machine).
args <- commandArgs(TRUE)
arrays <- args[1]
out <- args[2]
which <- if (length(args) > 2) strsplit(args[3], ",")[[1]] else c("seurat", "sce", "rda")
counts_only <- length(args) > 3 && identical(args[4], "counts-only")
suppressPackageStartupMessages({ library(Matrix); library(jsonlite) })
shape <- fromJSON(file.path(arrays, "shape.json"))
C <- shape$cells
G <- shape$genes
read <- function(name, what, n, size) readBin(file.path(arrays, name), what, n = n, size = size, endian = "little")
cells <- readLines(file.path(arrays, "barcodes.txt"))
genes <- readLines(file.path(arrays, "genes.txt"))
counts <- new("dgCMatrix",
  p = read("p.bin", "integer", C + 1, 4), i = read("i.bin", "integer", shape$nnz, 4),
  x = read("x.bin", "double", shape$nnz, 8), Dim = c(as.integer(G), as.integer(C)), Dimnames = list(genes, cells))
umap <- matrix(read("umap.bin", "double", C * 2, 8), C, 2, dimnames = list(cells, c("umap_1", "umap_2")))
pca <- matrix(read("pca.bin", "double", C * 30, 8), C, 30, dimnames = list(cells, paste0("PC_", 1:30)))
clusters <- factor(paste0("c", read("clusters.bin", "integer", C, 4)))
# unname(): rep() of the named colSums() would leave one name per stored
# value on @x, which no real object carries.
logcounts <- NULL
if (!counts_only) {
  logcounts <- counts
  logcounts@x <- log1p(logcounts@x / rep(unname(colSums(counts)), diff(counts@p)) * 1e4)
}
manifest_path <- file.path(out, "manifest.json")
manifest <- if (file.exists(manifest_path)) fromJSON(manifest_path, simplifyVector = FALSE) else list(files = list())
stamp <- function(label, path, seconds) {
  force(seconds)
  bytes <- file.size(path)
  cat(sprintf("  %s: %s, %.0f MB (%.1f s)\n", label, basename(path), bytes / 1e6, seconds))
  manifest$files[[basename(path)]] <<- list(format = label, cells = C, genes = G, nnz = shape$nnz, bytes = bytes)
  write(toJSON(manifest, auto_unbox = TRUE, pretty = TRUE, digits = NA), manifest_path)
}

if (any(c("seurat", "rda") %in% which)) {
  suppressPackageStartupMessages(library(SeuratObject))
  options(Seurat.object.assay.version = "v5")
  set.seed(42)
  seu <- CreateSeuratObject(counts = counts, project = "bench")
  if (!is.null(logcounts)) LayerData(seu, layer = "data") <- logcounts
  seu[["pca"]] <- CreateDimReducObject(embeddings = pca, key = "PC_", assay = "RNA")
  seu[["umap"]] <- CreateDimReducObject(embeddings = umap, key = "umap_", assay = "RNA")
  k <- 30L
  gi <- as.integer(vapply(seq_len(C), function(j) sort(sample.int(C, k)) - 1L, integer(k)))
  snn <- new("dgCMatrix", i = gi, p = as.integer(seq(0, C * k, by = k)), x = sample(1:39, C * k, TRUE) / 39,
             Dim = c(as.integer(C), as.integer(C)), Dimnames = list(cells, cells))
  seu[["RNA_snn"]] <- as.Graph(snn)
  rm(gi, snn)
  seu$seurat_clusters <- clusters
  Idents(seu) <- "seurat_clusters"
  if ("seurat" %in% which) {
    path <- file.path(out, sprintf("cells-%d.seurat.rds", C))
    stamp("seurat", path, system.time(saveRDS(seu, path))[["elapsed"]])
  }
  if ("rda" %in% which) {
    path <- file.path(out, sprintf("cells-%d.seurat.rda", C))
    stamp("rda", path, system.time(save(seu, file = path))[["elapsed"]])
  }
  rm(seu)
  invisible(gc())
}

if ("sce" %in% which) {
  suppressPackageStartupMessages(library(SingleCellExperiment))
  sce <- SingleCellExperiment(
    assays = if (is.null(logcounts)) list(counts = counts) else list(counts = counts, logcounts = logcounts),
    colData = S4Vectors::DataFrame(cluster = clusters, row.names = cells),
    reducedDims = list(PCA = pca, UMAP = umap)
  )
  path <- file.path(out, sprintf("cells-%d.sce.rds", C))
  stamp("sce", path, system.time(saveRDS(sce, path))[["elapsed"]])
}
