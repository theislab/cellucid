# A Seurat v5 object of a given size for the transcoder benchmark
# (scripts/rds-corpus/README.md): counts and log-normalised data
# (dgCMatrix), scale.data for 2,000 variable genes, PCA (50), UMAP, an SNN
# graph of 30 neighbours per cell, and meta.data. Not committed.
#
# Usage: Rscript make_bench.R <cells> <out.rds> [genes-per-cell]
args <- commandArgs(TRUE)
C <- as.integer(args[1])
out <- args[2]
per_cell <- if (length(args) > 2) as.integer(args[3]) else 1500L
suppressPackageStartupMessages({ library(Matrix); library(SeuratObject) })
options(Seurat.object.assay.version = "v5")
set.seed(42)
G <- 25000L
H <- 2000L
genes <- sprintf("GENE%05d", seq_len(G))
cells <- sprintf("CELL%07d-1", seq_len(C))
k <- pmax(1L, rbinom(C, G, per_cell / G))
p <- c(0L, cumsum(k))
i <- integer(p[C + 1])
for (j in seq_len(C)) i[(p[j] + 1):p[j + 1]] <- sort(sample.int(G, k[j])) - 1L
counts <- new("dgCMatrix", i = i, p = as.integer(p), x = as.numeric(rgeom(length(i), 0.55) + 1), Dim = c(G, C), Dimnames = list(genes, cells))
rm(i); invisible(gc())
seu <- CreateSeuratObject(counts = counts, project = "bench")
data <- counts
data@x <- log1p(data@x / rep(unname(colSums(counts)), diff(counts@p)) * 1e4)
LayerData(seu, layer = "data") <- data
rm(data, counts); invisible(gc())
hv <- sort(sample.int(G, H))
LayerData(seu, layer = "scale.data") <- matrix(pmin(rnorm(H * C), 10), H, C, dimnames = list(genes[hv], cells))
VariableFeatures(seu) <- genes[hv]
seu[["pca"]] <- CreateDimReducObject(embeddings = matrix(rnorm(C * 50), C, 50, dimnames = list(cells, paste0("PC_", 1:50))), key = "PC_", assay = "RNA")
seu[["umap"]] <- CreateDimReducObject(embeddings = matrix(rnorm(C * 2) * 5, C, 2, dimnames = list(cells, c("umap_1", "umap_2"))), key = "umap_", assay = "RNA")
kk <- 30L
gi <- integer(C * kk)
for (j in seq_len(C)) gi[((j - 1) * kk + 1):(j * kk)] <- sort(sample.int(C, kk)) - 1L
snn <- new("dgCMatrix", i = gi, p = as.integer(seq(0, C * kk, by = kk)), x = sample(1:39, C * kk, TRUE) / 39, Dim = c(C, C), Dimnames = list(cells, cells))
seu[["RNA_snn"]] <- as.Graph(snn)
seu$seurat_clusters <- factor(sample(0:19, C, TRUE))
seu$percent.mt <- runif(C, 0, 10)
Idents(seu) <- "seurat_clusters"
t <- system.time(saveRDS(seu, out))[["elapsed"]]
cat(sprintf("%d cells, %.0f MB, saveRDS %.1f s\n", C, file.size(out) / 1e6, t))
t <- system.time(invisible(readRDS(out)))[["elapsed"]]
cat(sprintf("readRDS %.1f s\n", t))
