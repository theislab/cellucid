/**
 * @fileoverview What a categorical field of the cells is likely to hold,
 * read from its name, and the coloring a dataset opens with.
 *
 * Annotation names follow a few wide conventions: CELLxGENE and scanpy
 * (`cell_type`, `leiden`, `louvain`), Tabula Sapiens (`cell_ontology_class`,
 * `free_annotation`), the HLCA (`ann_level_1` … `ann_finest_level`), Seurat
 * and Azimuth (`seurat_clusters`, `seurat_annotations`, `ident`,
 * `predicted.celltype.l2`, `RNA_snn_res.0.8`), CellTypist
 * (`majority_voting`, `predicted_labels`) and SingleR (`labels`,
 * `pruned.labels`). A name is compared in one spelling
 * ({@link normalizedFieldName}: lower case, every run of other characters
 * one `_`), so `Cell Type`, `cell.type` and `CellType` are alike.
 *
 * {@link COLOR_FIELD_TIERS} ranks what reads best as the first coloring:
 * the cell types, then other annotations, then lineages and compartments,
 * then clusters, then the tissue, then a condition, then the cell-cycle
 * phase. Names that are never a first coloring
 * ({@link isNeverFirstColoring}) are the sample-like ones
 * ({@link SAMPLE_FIELD_TIERS}: donor, sample, library, batch, …), ids and
 * barcodes, and quality-control flags. With no ranked name, a dataset opens
 * colored by its first other categorical field with 2 to
 * {@link modestCategoryCount} categories, the colors the category palette
 * designs (`data/palettes.js`); beyond them its colors are generated and
 * harder to tell apart (owner, 2026-11-10: "a priority order of stuff, not
 * only a couple").
 *
 * The analyses read the same ranks for their defaults (the cell types of a
 * composition or a dot plot, its samples: `analysis/options/composition-options.js`).
 *
 * @module app/utils/field-roles
 */

import { getCategoryColorSeedCount } from '../../data/palettes.js';

/**
 * A field name in one spelling: lower case, each run of characters other
 * than letters and digits one `_`, none at either end.
 *
 * @param {string} key
 * @returns {string}
 */
export function normalizedFieldName(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * The first coloring, best first: each tier's patterns in order, matched
 * against the normalized name.
 */
export const COLOR_FIELD_TIERS = Object.freeze([
  Object.freeze({ role: 'cell type', patterns: Object.freeze([/^cell_types?$/, /^celltypes?$/]) }),
  Object.freeze({
    role: 'cell type',
    patterns: Object.freeze([/(^|_)cell_types?($|_)/, /^cell_ontology_class$/, /(^|_)celltypes?($|_)/]),
  }),
  Object.freeze({
    role: 'annotation',
    patterns: Object.freeze([
      /(^|_)annotations?($|_)/, /^ann_(level|finest)/, /^majority_voting$/, /^predicted_labels$/,
      /^(pruned_)?labels?$/, /^cell_(labels?|identity|states?|subtypes?)$/, /(^|_)subtypes?($|_)/,
    ]),
  }),
  Object.freeze({
    role: 'lineage',
    patterns: Object.freeze([
      /(^|_)lineages?($|_)/, /(^|_)compartments?($|_)/, /^cell_(class|category|group|compartment)$/,
      /^(broad|major|coarse|main)_(cell_)?(class|category|group|type)s?$/,
    ]),
  }),
  Object.freeze({
    role: 'cluster',
    patterns: Object.freeze([
      /^(active_)?ident$/, /^leiden($|_)/, /^louvain($|_)/, /^seurat_clusters$/, /^clusters?$/,
      /(^|_)clusters?($|_)/, /_snn_res($|_)/, /^res_?\d/, /(^|_)(phenograph|kmeans|walktrap|infomap|metacells?)($|_)/,
    ]),
  }),
  Object.freeze({
    role: 'tissue',
    patterns: Object.freeze([/^(tissue|organ|anatomical_(site|region|entity)|region)($|_)/]),
  }),
  Object.freeze({
    role: 'condition',
    patterns: Object.freeze([
      /^(condition|disease|diagnosis|treatment|stimulation|stim|genotype|perturbation|time_?point|development_stage|stage)($|_)/,
    ]),
  }),
  Object.freeze({ role: 'cell cycle', patterns: Object.freeze([/^(phase|cell_cycle(_phase)?|cc_phase)$/]) }),
]);

/** The roles that name the cells' identity: what a composition or a dot plot groups by. */
export const IDENTITY_ROLES = Object.freeze(new Set(['cell type', 'annotation', 'lineage', 'cluster']));

/**
 * Names that read as the sample a cell came from, best replicate first: the
 * person, the sample, Seurat's original identity, then the library and the
 * technical batch.
 */
export const SAMPLE_FIELD_TIERS = Object.freeze([
  /(^|_)(donors?|patients?|individuals?|subjects?)($|_)/,
  /(^|_)samples?($|_)/,
  /^orig_ident$/,
  /(^|_)(library|libraries|library_id)($|_)/,
  /(^|_)(batch(es)?|plates?|lanes?|wells?|runs?|chips?|flowcells?|channels?|gem_wells?|replicates?|datasets?|studies|study|assays?|suspensions?)($|_)/,
]);

/** Ids, barcodes and quality-control flags: never a first coloring. */
const NOT_A_COLORING = Object.freeze([
  /(^|_)(ids?|uuids?|barcodes?|index|obs_names|cell_?names?)$/,
  /ontology_term_id/,
  /(^|_)(doublets?|scrublet|qc|pass(ed|es)?_qc|filtered|outliers?|low_quality)($|_)/,
  /^(is|has|keep)_/,
]);

/** Where one level of an annotation hierarchy reads best: the second, then the first, then deeper. */
function levelOrder(name) {
  const level = name.match(/(?:^|_)(?:l|lvl|level)_?(\d+)$/);
  if (level === null) return 0;
  const n = Number(level[1]);
  return n === 2 ? 1 : n === 1 ? 2 : n + 1;
}

/**
 * The rank of a sample-like name in {@link SAMPLE_FIELD_TIERS}, or null.
 *
 * @param {string} key
 * @returns {number|null}
 */
export function sampleFieldRank(key) {
  const name = normalizedFieldName(key);
  const rank = SAMPLE_FIELD_TIERS.findIndex(pattern => pattern.test(name));
  return rank === -1 ? null : rank;
}

/**
 * Whether a field is never a first coloring: named like a sample, an id or
 * barcode, or a quality-control flag.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isNeverFirstColoring(key) {
  const name = normalizedFieldName(key);
  return sampleFieldRank(key) !== null || NOT_A_COLORING.some(pattern => pattern.test(name));
}

/**
 * Where a field's name stands in {@link COLOR_FIELD_TIERS}:
 * `{tier, pattern, level, role}` (lower first), or null for a name the tiers
 * do not hold or one never a first coloring.
 *
 * @param {string} key
 * @returns {{tier: number, pattern: number, level: number, role: string}|null}
 */
export function colorFieldRank(key) {
  if (isNeverFirstColoring(key)) return null;
  const name = normalizedFieldName(key);
  for (let tier = 0; tier < COLOR_FIELD_TIERS.length; tier++) {
    const pattern = COLOR_FIELD_TIERS[tier].patterns.findIndex(candidate => candidate.test(name));
    if (pattern !== -1) return { tier, pattern, level: levelOrder(name), role: COLOR_FIELD_TIERS[tier].role };
  }
  return null;
}

function compareRanks(a, b) {
  return a.tier - b.tier || a.pattern - b.pattern || a.level - b.level;
}

/**
 * The most categories a field that only its order recommends opens with:
 * the colors the category palette designs.
 *
 * @returns {number}
 */
export function modestCategoryCount() {
  return getCategoryColorSeedCount();
}

/**
 * The categorical fields in the order a dataset's first coloring tries
 * them: the ranked names best first (ties in the file's order), each with
 * `ranked: true`; then the others that are not never-first, in the file's
 * order, `ranked: false`, which open only with 2 to
 * {@link modestCategoryCount} categories. A field known to hold fewer than
 * two categories is left out (one color says nothing).
 *
 * @template {{key: string, categoryCount: number|null}} F
 * @param {F[]} fields the categorical fields, in the file's order
 * @returns {Array<F & {ranked: boolean, role: string|null}>}
 */
export function firstColoringCandidates(fields) {
  const several = fields.filter(field => field.categoryCount === null || field.categoryCount >= 2);
  const ranked = several
    .map((field, order) => ({ field, order, rank: colorFieldRank(field.key) }))
    .filter(entry => entry.rank !== null)
    .sort((a, b) => compareRanks(a.rank, b.rank) || a.order - b.order)
    .map(entry => ({ ...entry.field, ranked: true, role: entry.rank.role }));
  const others = several
    .filter(field => colorFieldRank(field.key) === null && !isNeverFirstColoring(field.key))
    .filter(field => field.categoryCount === null || field.categoryCount <= modestCategoryCount())
    .map(field => ({ ...field, ranked: false, role: null }));
  return [...ranked, ...others];
}

/**
 * Whether a field that only its order recommends opens with this many
 * categories.
 *
 * @param {number} categoryCount
 * @returns {boolean}
 */
export function isModestCategoryCount(categoryCount) {
  return categoryCount >= 2 && categoryCount <= modestCategoryCount();
}

/**
 * The field of the cells' identity among categorical fields (a composition's
 * or a dot plot's cell types): the best-ranked identity name ({@link IDENTITY_ROLES}),
 * else the first not never-first, else the first; '' for none.
 *
 * @param {Array<{key: string, categoryCount: number|null}>} fields
 * @returns {string}
 */
export function identityField(fields) {
  if (fields.length === 0) return '';
  const several = fields.filter(field => field.categoryCount === null || field.categoryCount >= 2);
  const identity = firstColoringCandidates(several).find(field => field.ranked && IDENTITY_ROLES.has(field.role));
  return (identity ?? several.find(field => !isNeverFirstColoring(field.key)) ?? several[0] ?? fields[0]).key;
}

/**
 * The best-ranked clustering among categorical fields (role "cluster":
 * leiden, louvain, clusters, seurat_clusters, …): what annotating names with
 * cell types; '' for none. A field known to hold one category is passed over.
 *
 * @param {Array<{key: string, categoryCount: number|null}>} fields
 * @returns {string}
 */
export function clusterField(fields) {
  return firstColoringCandidates(fields).find(field => field.ranked && field.role === 'cluster')?.key ?? '';
}

/**
 * The best-ranked sample-like field ({@link SAMPLE_FIELD_TIERS}) other than
 * `except`, or ''.
 *
 * @param {Array<{key: string}>} fields
 * @param {string} [except]
 * @returns {string}
 */
export function sampleField(fields, except = '') {
  const ranked = fields
    .map((field, order) => ({ field, order, rank: sampleFieldRank(field.key) }))
    .filter(entry => entry.rank !== null && entry.field.key !== except)
    .sort((a, b) => a.rank - b.rank || a.order - b.order);
  return ranked[0]?.field.key ?? '';
}

/**
 * Names of a continuous field holding each cell's total count (its library
 * size), best first: scanpy's `calculate_qc_metrics` (`total_counts`), its
 * older recipes and `normalize_total(key_added=…)` (`n_counts`), Seurat's
 * RNA assay (`nCount_RNA`), Drop-seq and 10x-era tables (`nUMI`,
 * `total_umis`, `umi_count`), then a plain library size. A size factor
 * (`size_factor`, scran, DESeq2) is a total already scaled, not one.
 */
export const LIBRARY_SIZE_FIELD_TIERS = Object.freeze([
  /^total_counts$/,
  /^n_counts$/,
  /^n_count_rna$/,
  /^(n_?umis?|total_umis?|umi_counts?)$/,
  /^(library_size|lib_size|libsize)$/,
]);

/**
 * The continuous fields named like a cell's total count
 * ({@link LIBRARY_SIZE_FIELD_TIERS}), best first.
 *
 * @param {Array<{key: string}>} fields
 * @returns {string[]}
 */
export function librarySizeFields(fields) {
  return fields
    .map((field, order) => ({ key: field.key, order, rank: LIBRARY_SIZE_FIELD_TIERS.findIndex(pattern => pattern.test(normalizedFieldName(field.key))) }))
    .filter(entry => entry.rank !== -1)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(entry => entry.key);
}
