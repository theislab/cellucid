# The slots of every S4 class the transcoders read (data/anndata/transcode/
# seurat.js and sce.js), as the installed SeuratObject, SingleCellExperiment,
# SummarizedExperiment and S4Vectors define them, for drift.mjs to compare
# with known-slots.json: a slot a new package release adds or removes is a
# slot the transcoders have not been checked against.
#
# Usage: Rscript slots.R <out.json>

args <- commandArgs(TRUE)
out <- args[1]
suppressPackageStartupMessages({
  library(methods)
  library(jsonlite)
  library(SeuratObject)
  library(SingleCellExperiment)
})

classes <- list(
  SeuratObject = c("Seurat", "Assay", "StdAssay", "Assay5", "LogMap", "DimReduc", "Graph", "Neighbor", "SpatialImage", "FOV", "Centroids", "Segmentation"),
  SingleCellExperiment = "SingleCellExperiment",
  SummarizedExperiment = c("SummarizedExperiment", "RangedSummarizedExperiment"),
  S4Vectors = "DFrame"
)

slots <- list()
versions <- list(R = paste(R.version$major, R.version$minor, sep = "."))
for (package in names(classes)) {
  versions[[package]] <- as.character(packageVersion(package))
  for (name in classes[[package]]) {
    definition <- getClassDef(name, package = package)
    if (is.null(definition)) stop("The installed ", package, " defines no class ", name, ".", call. = FALSE)
    slots[[name]] <- I(sort(names(definition@slots), method = "radix"))
  }
}
write(toJSON(list(versions = versions, slots = slots), auto_unbox = TRUE, pretty = TRUE), out)
