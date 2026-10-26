#!/bin/sh
# The R object drift check, as .github/workflows/r-corpus-drift.yml runs it
# monthly: write the corpus with the R packages R_LIBS (or the default
# library) holds, record the slots those packages define, then read every
# file with the transcoders and compare the slots (drift.mjs).
#
# Usage: sh scripts/rds-corpus/drift.sh [Rscript] [out-dir]
#   R_LIBS=/path/to/lib sh scripts/rds-corpus/drift.sh /path/to/Rscript
# It needs Matrix, jsonlite, SeuratObject and SingleCellExperiment (with
# SummarizedExperiment and S4Vectors) installed, and Node.js.
set -eu
RSCRIPT=${1:-Rscript}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${2:-$(mktemp -d "${TMPDIR:-/tmp}/cellucid-r-drift.XXXXXX")}
mkdir -p "$OUT"
"$RSCRIPT" "$HERE/generate.R" "$OUT/rds" so5
"$RSCRIPT" "$HERE/slots.R" "$OUT/slots.json"
node "$HERE/drift.mjs" "$OUT/rds" "$OUT/slots.json"
