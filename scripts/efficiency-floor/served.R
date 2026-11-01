# Serve a synthetic SingleCellExperiment with cellucid-r's server, as
# cellucid_view() and cellucid_serve() serve it, for the `served` plan of
# scripts/efficiency-floor.mjs and efficiency-floor/app-run.mjs: `cells`
# cells, 2,000 genes, `per_cell` values a cell (logcounts), a 30-category
# cluster and a 2-D UMAP. Prints {"made_s"} (the store, before the first
# answer), then READY, and serves until killed. CELLUCID_R_ROOT names the
# cellucid-r checkout loaded (the one beside this repository by default).
#
#   Rscript scripts/efficiency-floor/served.R PORT CELLS PER_CELL
args <- commandArgs(TRUE)
port <- as.integer(args[[1]])
cells <- as.integer(args[[2]])
per_cell <- as.integer(args[[3]])
here <- dirname(normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))))
root <- Sys.getenv("CELLUCID_R_ROOT", file.path(here, "..", "..", "..", "cellucid-r"))
suppressMessages({
  pkgload::load_all(root, quiet = TRUE)
  library(SingleCellExperiment)
  library(Matrix)
})
genes <- 2000L
set.seed(1)
base <- sample.int(genes, cells, replace = TRUE) - 1L
step <- sample.int(genes %/% per_cell - 1L, cells, replace = TRUE)
i <- (rep(base, each = per_cell) + rep(step, each = per_cell) * rep.int(0:(per_cell - 1L), cells)) %% genes + 1L
rm(base, step)
m <- sparseMatrix(i = i, p = c(0L, seq_len(cells) * per_cell), x = as.double(rgeom(length(i), 0.5) + 1), dims = c(genes, cells))
rm(i)
rownames(m) <- paste0("G", seq_len(genes))
colnames(m) <- paste0("c", seq_len(cells))
sce <- SingleCellExperiment(assays = list(logcounts = m))
sce$cluster <- factor(paste("type", seq_len(cells) %% 30))
reducedDim(sce, "UMAP") <- matrix(rnorm(cells * 2), ncol = 2)
started <- proc.time()[["elapsed"]]
viewer <- cellucid_serve(sce, port = port, serve_web_ui = FALSE, quiet = TRUE)
cat(sprintf('{"made_s": %.3f}\n', proc.time()[["elapsed"]] - started))
cat("READY\n")
flush(stdout())
repeat later::run_now(timeoutSecs = 1)
