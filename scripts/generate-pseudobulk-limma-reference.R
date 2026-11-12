# Pseudobulk differential expression references: edgeR TMM + log-CPM and
# limma lmFit + eBayes(trend = TRUE), on fixed small fixtures.
#
# Writes tests/fixtures/analysis/pseudobulk-limma-reference.json and its
# SHA-256 (pseudobulk-limma-reference.json.sha256). The web app's pseudobulk
# fit (assets/js/app/analysis/stats/pseudobulk.js, limma.js,
# edger-normalization.js) is held to every number in it at 1e-6 by
# tests/analysis-pseudobulk-limma.test.mjs.
#
# Run from the web repository with Bioconductor edgeR and limma installed
# (the workspace's R environment has them: .environments/bootstrap.sh r):
#
#     Rscript scripts/generate-pseudobulk-limma-reference.R
#
# Pinned: R 4.5.3, edgeR 4.10.7, limma 3.68.5 (the script refuses others,
# so a changed reference is a deliberate change).
#
# Each case gives what the web app has after its gene stream — each unit's
# sum, measured cells and expressing cells per gene — and what edgeR and
# limma make of it, as the app fits it:
#
# - counts: DGEList(sums of the fit's units, lib.size = the units' stored
#   totals, or NULL: colSums), normLibSizes(method = "TMM") (calcNormFactors),
#   cpm(log = TRUE, prior.count = 2); otherwise each unit's mean;
# - a unit with fewer measured cells than the minimum is NA for that gene;
# - genes no observed unit expresses are left out (the minimal filter);
# - lmFit(~ group) or lmFit(~ donor + group) (paired: donors in both groups
#   only), eBayes(trend = TRUE, legacy = TRUE). legacy = TRUE is limma's
#   default when every gene has the same residual df (checked below); with
#   unequal df (NA units) limma >= 3.61 would switch to
#   fitFDistUnequalDF1's loess trend, which the app does not replicate.

suppressPackageStartupMessages({
  library(edgeR)
  library(limma)
  library(jsonlite)
})

stopifnot(
  as.character(getRversion()) == "4.5.3",
  as.character(packageVersion("edgeR")) == "4.10.7",
  as.character(packageVersion("limma")) == "3.68.5"
)

args <- commandArgs(trailingOnly = FALSE)
script <- normalizePath(sub("^--file=", "", args[grep("^--file=", args)]))
root <- dirname(dirname(script))
out <- file.path(root, "tests", "fixtures", "analysis", "pseudobulk-limma-reference.json")

num <- function(x) {
  # JSON keeps NA as null and infinities as strings.
  x <- as.numeric(x)
  lapply(x, function(v) if (is.na(v)) NULL else if (is.infinite(v)) if (v > 0) "Infinity" else "-Infinity" else v)
}

# --- Fixtures ---------------------------------------------------------------

# Counts: genes x units. Gene means log-normal, unit depths unequal, some
# genes up in A, unexpressed genes, and 15 genes counted once in the same
# unit (a third of the expressed genes at the lowest mean: the trend's
# lower knot sits on its boundary and is shoved inside, as ns() does).
make_counts <- function(seed, genes, sides, depth) {
  set.seed(seed)
  units <- length(sides)
  mu <- rlnorm(genes, meanlog = 3, sdlog = 1.5)
  effect <- rep(1, genes)
  effect[1:8] <- c(4, 3, 0.25, 2.5, 0.3, 5, 0.5, 2)
  counts <- matrix(0, genes, units)
  for (u in seq_len(units)) {
    m <- mu * depth[u] * ifelse(sides[u] == "A", effect, 1)
    counts[, u] <- rnbinom(genes, mu = m, size = 8)
  }
  counts[(genes - 21):genes, ] <- 0
  counts[(genes - 36):(genes - 22), ] <- 0
  counts[(genes - 36):(genes - 22), 1] <- 1
  counts
}

expressing_of <- function(counts, measured) pmin(counts, measured)

fit_case <- function(name, sums, measured, expressing, sides, samples, paired, counts, libraries, minimum) {
  units <- ncol(sums)
  if (paired) {
    both <- intersect(samples[sides == "A"], samples[sides == "B"])
    fit_units <- which(samples %in% both)
  } else {
    fit_units <- seq_len(units)
  }
  S <- sums[, fit_units, drop = FALSE]
  M <- measured[, fit_units, drop = FALSE]
  E <- expressing[, fit_units, drop = FALSE]
  group <- factor(sides[fit_units], levels = c("B", "A"))
  result <- list(name = name)
  if (counts) {
    y <- DGEList(counts = S, lib.size = if (is.null(libraries)) NULL else libraries[fit_units])
    y <- normLibSizes(y, method = "TMM")
    values <- cpm(y, log = TRUE, prior.count = 2)
    result$librarySizes <- num(y$samples$lib.size)
    result$normFactors <- num(y$samples$norm.factors)
  } else {
    values <- S / M
  }
  observed <- M >= minimum
  values[!observed] <- NA
  result$values <- num(t(values))
  keep <- rowSums(E * observed) > 0
  result$keep <- which(keep) - 1L
  if (paired) {
    donor <- factor(samples[fit_units])
    design <- model.matrix(~ donor + group)
  } else {
    design <- model.matrix(~ group)
  }
  fit <- lmFit(values[keep, , drop = FALSE], design)
  eb <- eBayes(fit, trend = TRUE, legacy = TRUE)
  dfs <- fit$df.residual[fit$df.residual > 0]
  if (length(unique(dfs)) == 1L) {
    # Equal residual df: limma's default is this same fit.
    default <- eBayes(fit, trend = TRUE)
    stopifnot(isTRUE(all.equal(default$p.value, eb$p.value, tolerance = 0)))
  }
  result$equalDf <- length(unique(dfs)) == 1L
  result$fitUnits <- fit_units - 1L
  result$coefficient <- num(fit$coefficients[, "groupA"])
  result$stdevUnscaled <- num(fit$stdev.unscaled[, "groupA"])
  result$sigma <- num(fit$sigma)
  result$dfResidual <- num(fit$df.residual)
  result$Amean <- num(fit$Amean)
  result$s2Prior <- num(rep_len(eb$s2.prior, nrow(fit)))
  result$s2Post <- num(eb$s2.post)
  result$dfPrior <- num(eb$df.prior)
  result$t <- num(eb$t[, "groupA"])
  result$dfTotal <- num(eb$df.total)
  result$pValue <- num(eb$p.value[, "groupA"])
  result
}

input_of <- function(sums, measured, expressing, sides, samples, paired, counts, libraries, minimum) {
  list(
    genes = nrow(sums), units = ncol(sums),
    sums = num(t(sums)), measured = num(t(measured)), expressing = num(t(expressing)),
    sides = ifelse(sides == "A", 1L, 2L), samples = samples,
    paired = paired, counts = counts,
    unitLibraries = if (is.null(libraries)) NULL else num(libraries),
    minCellsPerSample = minimum
  )
}

case <- function(name, sums, measured, expressing, sides, samples, paired, counts, libraries, minimum) {
  list(
    name = name,
    input = input_of(sums, measured, expressing, sides, samples, paired, counts, libraries, minimum),
    expected = fit_case(name, sums, measured, expressing, sides, samples, paired, counts, libraries, minimum)
  )
}

cases <- list()

# A: unpaired counts, libraries the units' column sums, every unit measured.
sides_a <- c("A", "A", "A", "A", "B", "B", "B", "B", "B")
counts_a <- make_counts(11, 60, sides_a, c(1, 2.5, 0.6, 1.4, 0.8, 3, 1.1, 0.5, 2))
measured_a <- matrix(30, nrow(counts_a), ncol(counts_a))
cases[[length(cases) + 1L]] <- case("unpaired counts, column sums", counts_a, measured_a, expressing_of(counts_a, measured_a),
  sides_a, 0:8, FALSE, TRUE, NULL, 10L)

# B: the same counts with stored library sizes and missing units: one unit
# of gene 3, two of gene 7, gene 10 measured in one unit a side (no residual
# df: moderated to the prior alone), gene 12 measured nowhere.
measured_b <- measured_a
measured_b[3, 2] <- 4
measured_b[7, c(1, 6)] <- 0
measured_b[10, c(2, 3, 4, 6, 7, 8, 9)] <- 2
measured_b[12, ] <- 0
libraries_b <- colSums(counts_a) * c(1.3, 1.1, 1.6, 1.2, 1.25, 1.05, 1.4, 1.5, 1.15)
cases[[length(cases) + 1L]] <- case("unpaired counts, stored libraries, missing units", counts_a, measured_b, expressing_of(counts_a, measured_b),
  sides_a, 0:8, FALSE, TRUE, libraries_b, 5L)

# C: paired counts: donors 0-4 in A, 0-3 and 5 in B; donor 4 (A only) and 5
# (B only) are left out; donor 2's B unit is missing for gene 4.
sides_c <- c("A", "A", "A", "A", "A", "B", "B", "B", "B", "B")
samples_c <- c(0, 1, 2, 3, 4, 0, 1, 2, 3, 5)
counts_c <- make_counts(23, 50, sides_c, c(1, 2, 0.7, 1.5, 1.2, 1.1, 1.8, 0.6, 1.4, 0.9))
# Donor effects shared by both of a donor's units.
set.seed(5)
donor_effect <- matrix(rlnorm(50 * 6, 0, 0.6), 50, 6)
counts_c <- round(counts_c * donor_effect[, samples_c + 1])
measured_c <- matrix(25, nrow(counts_c), ncol(counts_c))
measured_c[4, 8] <- 3
cases[[length(cases) + 1L]] <- case("paired counts, one missing unit", counts_c, measured_c, expressing_of(counts_c, measured_c),
  sides_c, samples_c, TRUE, TRUE, NULL, 10L)

# D: the same paired, complete, stored libraries.
measured_d <- matrix(25, nrow(counts_c), ncol(counts_c))
cases[[length(cases) + 1L]] <- case("paired counts, stored libraries", counts_c, measured_d, expressing_of(counts_c, measured_d),
  sides_c, samples_c, TRUE, TRUE, colSums(counts_c) * seq(1.1, 2, length.out = 10), 10L)

# E: values that are not counts (a normalized matrix): each unit's mean.
set.seed(31)
sides_e <- c("A", "A", "A", "B", "B", "B", "B")
genes_e <- 40
level <- rexp(genes_e, 0.5)
means_e <- matrix(0, genes_e, length(sides_e))
for (u in seq_along(sides_e)) {
  means_e[, u] <- pmax(level * (1 + ifelse(sides_e[u] == "A", c(rep(0.8, 5), rep(0, genes_e - 5)), 0)) + rnorm(genes_e, 0, 0.3 * sqrt(level + 0.1)), 0)
}
means_e[38:40, ] <- 0
measured_e <- matrix(12, genes_e, length(sides_e))
measured_e[2, 5] <- 0
sums_e <- means_e * measured_e
expressing_e <- ifelse(means_e > 0, pmin(measured_e, 5), 0)
cases[[length(cases) + 1L]] <- case("unpaired means, one missing unit", sums_e, measured_e, expressing_e,
  sides_e, 0:6, FALSE, FALSE, NULL, 3L)

# F: means whose residual variances are all equal: the variances spread no
# more than chance (an infinite prior df), each gene's variance the prior.
sides_f <- c("A", "A", "A", "B", "B", "B")
pattern <- c(0.3, -0.1, -0.2, 0.25, -0.05, -0.2)
genes_f <- 12
means_f <- outer(seq(1, 4, length.out = genes_f), rep(1, 6)) + outer(rep(1, genes_f), pattern)
means_f[1:3, 1:3] <- means_f[1:3, 1:3] + 1
measured_f <- matrix(10, genes_f, 6)
cases[[length(cases) + 1L]] <- case("unpaired means, equal variances", means_f * measured_f, measured_f, matrix(5, genes_f, 6),
  sides_f, 0:5, FALSE, FALSE, NULL, 3L)

# G: two genes: too few to moderate (squeezeVar leaves them as they are).
means_g <- rbind(c(1, 1.4, 1.1, 0.4, 0.6, 0.5), c(2, 2.1, 1.7, 2.2, 1.9, 2.4))
measured_g <- matrix(10, 2, 6)
cases[[length(cases) + 1L]] <- case("two genes, no moderation", means_g * measured_g, measured_g, matrix(4, 2, 6),
  sides_f, 0:5, FALSE, FALSE, NULL, 3L)

document <- list(
  generator = "scripts/generate-pseudobulk-limma-reference.R",
  versions = list(R = as.character(getRversion()), edgeR = as.character(packageVersion("edgeR")), limma = as.character(packageVersion("limma"))),
  cases = cases
)
text <- toJSON(document, auto_unbox = TRUE, digits = NA, null = "null", na = "null", pretty = FALSE)
dir.create(dirname(out), recursive = TRUE, showWarnings = FALSE)
writeLines(text, out, sep = "")
digest <- sub(" .*", "", system2("shasum", c("-a", "256", shQuote(out)), stdout = TRUE))
writeLines(paste0(digest, "  ", basename(out)), paste0(out, ".sha256"))
cat("wrote", out, digest, "\n")
