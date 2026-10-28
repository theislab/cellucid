/**
 * Gene names read from a `var` column, in the words `cellucid serve` uses.
 *
 * The data-mapping gene-name rule (design §1.3): a column of strings,
 * categories or integers names the genes; an empty or missing value takes the
 * gene's var-index name, and the list is then made unique with
 * `makeUniqueNames` (`data-mapping.js`). A value is turned into text exactly
 * as `cellucid.data_mapping` (`gene_name_text`) does with Python's
 * `str()`, so a file read in the browser and the same file served list the
 * same names.
 *
 * @module data/gene-names
 */

/**
 * The text of one gene-name value, or null when it is missing.
 *
 * - a string is itself (an empty string is "missing" for `makeUniqueNames`);
 * - null, undefined and NaN are missing;
 * - an integer (number or bigint) is its decimal digits, as `str(5)`;
 * - a boolean is `True` or `False`, as `str(True)`;
 * - a value stored as a float (`isFloat`, e.g. float categories) keeps
 *   Python's `.0` on whole numbers (`str(5.0)` is `5.0`);
 * - any other number is its shortest round-trip text.
 *
 * @param {unknown} value
 * @param {{isFloat?: boolean}} [options]
 * @returns {string|null}
 */
export function geneNameText(value, { isFloat = false } = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return null;
    if (isFloat && Number.isInteger(value)) return `${value}.0`;
    return String(value);
  }
  throw new TypeError(`A gene name must be text, a number or missing; got ${typeof value}.`);
}

/**
 * Whether one gene name is a database identifier rather than a symbol: an
 * accession of letters and at least five digits, optionally versioned
 * (Ensembl `ENSG00000168484`, `ENSMUSG00000064370.1`, FlyBase `FBgn0000008`,
 * WormBase `WBGene00000001`), a RefSeq accession (`NM_000546`), a UniProt
 * accession (`P04637`), `HGNC:5`-style ids, or a bare number (Entrez / NCBI
 * Gene ids). Symbols such as `SFTPC`, `Sftpc`, `MT-CO1` or `HLA-DRB1` are
 * not; a few symbols are (`LINC01128`, `Gm12345`), which is why identifiers
 * are judged by share (`namesAreIdentifiers`), never by one name.
 *
 * @param {string|null} text
 * @returns {boolean}
 */
export function looksLikeGeneIdentifier(text) {
  if (typeof text !== 'string') return false;
  return /^(?:[A-Za-z]{2,}[A-Za-z_]*\d{5,}(?:\.\d+)?|[A-Z]{2}_\d{6,}(?:\.\d+)?|[OPQ]\d[A-Z0-9]{3}\d|[A-NR-Z]\d[A-Z][A-Z0-9]{2}\d(?:[A-Z][A-Z0-9]{2}\d)?|[A-Za-z]+:\d+|\d+)$/.test(text);
}

/** A genomic interval (`chr1:1000-1050`, `1-1000-1050`): a peak, not a gene. */
function looksLikeInterval(text) {
  return /^(?:chr)?[A-Za-z0-9._]{1,12}[:_-]\d{2,}[-_:]\d{2,}$/i.test(text);
}

/**
 * A value shaped like a gene symbol: one token starting with a letter (as
 * symbols of every organism do: `SFTPC`, `Sftpc`, `si:ch211-1`, `CG1234`),
 * not an interval.
 */
function symbolShaped(text) {
  return typeof text === 'string' && /^[A-Za-z][A-Za-z0-9._\-@/:()']*$/.test(text) && !looksLikeInterval(text);
}

/**
 * Var column names that conventionally hold gene symbols, most specific
 * first: CELLxGENE (`feature_name`), Scanpy's `read_10x_*` with
 * `var_names='gene_ids'` (`gene_symbols`), Seurat / SCE conversions
 * (`gene_name`, `symbol`), Monocle (`gene_short_name`).
 */
export const GENE_SYMBOL_COLUMN_NAMES = Object.freeze([
  'feature_name', 'gene_symbols', 'gene_symbol', 'symbols', 'symbol', 'gene_name', 'gene_names',
  'gene_short_name', 'feature_names', 'genes', 'gene', 'names', 'name',
]);

/** Up to `size` names spread evenly over `names`: what a share is judged on. */
function sampleOf(names, size = 1000) {
  if (names.length <= size) return names;
  const step = names.length / size;
  return Array.from({ length: size }, (_, i) => names[Math.floor(i * step)]);
}

/**
 * Share of `values` for which `test(value)` holds, over the non-missing ones
 * (0 when there are none).
 */
function shareOf(values, test) {
  let present = 0;
  let hits = 0;
  for (const value of values) {
    if (value === null || value === '') continue;
    present++;
    if (test(value)) hits++;
  }
  return present === 0 ? 0 : hits / present;
}

/**
 * Whether gene names are database identifiers, not symbols: at least 90 %
 * of an even sample of them look like one (`looksLikeGeneIdentifier`). The
 * one rule for it: what the gene-name default, the gene search's empty state
 * and the data-mapping hint all ask.
 *
 * @param {ReadonlyArray<string|null>} names
 * @returns {boolean}
 */
export function namesAreIdentifiers(names) {
  return names.length > 0 && shareOf(sampleOf(names), looksLikeGeneIdentifier) >= 0.9;
}

/**
 * How well a var column names genes by symbol, from 0 to 1, or null when it
 * does not hold symbols: at least half of the genes have a value, at least
 * half of those are distinct (a biotype or a species column is not), at most
 * half look like identifiers, at least 90 % are symbol-shaped (one token
 * starting with a letter, not a genomic interval), and it is not the index
 * again. The score is the symbol-shaped share.
 *
 * @param {ReadonlyArray<string>} index
 * @param {ReadonlyArray<string|null>} values
 * @returns {number|null}
 */
export function symbolColumnScore(index, values) {
  if (values.length !== index.length || index.length === 0) return null;
  const present = [];
  let sameAsIndex = 0;
  for (let gene = 0; gene < values.length; gene++) {
    const value = values[gene];
    if (value === null || value === '') continue;
    present.push(value);
    if (value === index[gene]) sameAsIndex++;
  }
  if (present.length < index.length / 2) return null;
  if (new Set(present).size < present.length / 2) return null;
  if (sameAsIndex > present.length / 2) return null;
  const sample = sampleOf(present);
  if (shareOf(sample, looksLikeGeneIdentifier) > 0.5) return null;
  const shaped = shareOf(sample, symbolShaped);
  return shaped >= 0.9 ? shaped : null;
}

/**
 * The gene-name default (design §1.3, "Gene names"): the var index names the
 * genes, unless it holds identifiers (`namesAreIdentifiers`) while a var
 * column holds their symbols (`symbolColumnScore`), as a CELLxGENE file does
 * (Ensembl ids in the index, symbols in the categorical `feature_name`).
 * Then that column names the genes, and the identifiers stay searchable
 * beside them.
 *
 * Columns are read lazily, only for an index of identifiers: the
 * conventionally named ones first (`GENE_SYMBOL_COLUMN_NAMES` order, any
 * case), the first that holds symbols chosen; else every other column, in
 * the file's order, the one most symbol-shaped chosen. A column that cannot
 * be read (`readValues` resolves null) is passed over.
 *
 * @param {ReadonlyArray<string>} index - The var index names
 * @param {ReadonlyArray<string>} columns - Var columns that may name genes
 * @param {(key: string) => Promise<ReadonlyArray<string|null>|null>} readValues -
 *   A column's values as gene-name text
 * @returns {Promise<string|null>} The column that names the genes, or null for the index
 */
export async function inferGeneNameColumn(index, columns, readValues) {
  if (!namesAreIdentifiers(index)) return null;
  const rank = key => GENE_SYMBOL_COLUMN_NAMES.indexOf(key.toLowerCase());
  const conventional = columns.filter(key => rank(key) >= 0).sort((a, b) => rank(a) - rank(b));
  for (const key of conventional) {
    const values = await readValues(key);
    if (values !== null && symbolColumnScore(index, values) !== null) return key;
  }
  let best = null;
  for (const key of columns.filter(key => rank(key) < 0)) {
    const values = await readValues(key);
    const score = values === null ? null : symbolColumnScore(index, values);
    if (score !== null && (best === null || score > best.score)) best = { key, score };
  }
  return best?.key ?? null;
}
