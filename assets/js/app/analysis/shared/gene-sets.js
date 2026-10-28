/**
 * @fileoverview Gene lists as people paste and import them, and their names
 * matched to a dataset's genes.
 *
 * Shared by Gene signature and Dot plot. Nothing here throws on what a user
 * typed or imported: a name the dataset does not have is reported, never an
 * error, and the analysis leaves it out and says so.
 *
 * @module analysis/shared/gene-sets
 */

/** Separators between gene names in typed or pasted text. */
const GENE_SEPARATOR = /[\s,;]+/;

/**
 * The gene names in typed or pasted text, in order, each once: separated by
 * commas, semicolons, spaces, tabs or new lines.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseGeneText(text) {
  if (typeof text !== 'string') throw new TypeError('Gene text must be a string');
  const seen = new Set();
  const genes = [];
  for (const token of text.split(GENE_SEPARATOR)) {
    const gene = token.trim().replace(/^["']|["']$/g, '');
    if (gene.length === 0 || seen.has(gene)) continue;
    seen.add(gene);
    genes.push(gene);
  }
  return genes;
}

/**
 * Gene sets of a GMT file: one set per line, `name<TAB>description<TAB>gene…`
 * (MSigDB). One rule with cellucid-python's `read_gmt` and cellucid-r's
 * `cellucid_read_gmt`: cells are tab-separated and trimmed; blank lines are
 * skipped; a line without a name is `Set <n>` (its place among the sets); a
 * name used again is `name (2)`, `name (3)`… (`uniqueGeneSetName`); each
 * gene is kept once; a line with a name and no genes is a set with no genes.
 *
 * @param {string} text
 * @returns {Array<{name: string, description: string, genes: string[]}>}
 */
export function parseGmt(text) {
  if (typeof text !== 'string') throw new TypeError('GMT text must be a string');
  const sets = [];
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const cells = line.split('\t');
    const name = uniqueGeneSetName(cells[0].trim() || `Set ${sets.length + 1}`, names);
    const description = (cells[1] ?? '').trim();
    const genes = [...new Set(cells.slice(2).map(cell => cell.trim()).filter(gene => gene.length > 0))];
    sets.push({ name, description, genes });
  }
  return sets;
}

/**
 * Gene sets as a GMT file (MSigDB): one set per line, `name<TAB>description
 * <TAB>gene…`, each run of tabs and line breaks inside a name, description
 * or gene written as one space, a name that then reads as an earlier one's
 * written `name (2)` (as `parseGmt` names a repeated name), each gene once,
 * and the file ending with a new line. What `parseGmt` reads back, and what
 * cellucid-python's `write_gmt`/`read_gmt` and cellucid-r's
 * `cellucid_write_gmt`/`cellucid_read_gmt` write and read.
 *
 * @param {Array<{name: string, description?: string, genes: string[]}>} sets
 * @returns {string}
 */
export function formatGmt(sets) {
  if (!Array.isArray(sets)) throw new TypeError('GMT gene sets must be a list');
  const clean = value => String(value).replace(/[\t\r\n]+/g, ' ').trim();
  const names = new Set();
  const lines = sets.map(set => {
    const name = clean(set.name);
    if (name.length === 0) throw new TypeError('A GMT gene set needs a name');
    const genes = [...new Set(set.genes.map(clean).filter(gene => gene.length > 0))];
    return [uniqueGeneSetName(name, names), clean(set.description ?? ''), ...genes].join('\t');
  });
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/**
 * `name`, or `name (2)`, `name (3)`… -- the first not in `names` -- added to
 * `names`: the one rule for a gene set name used twice, in the web app,
 * cellucid-python and cellucid-r alike.
 *
 * @param {string} name
 * @param {Set<string>} names
 * @returns {string}
 */
export function uniqueGeneSetName(name, names) {
  let candidate = name;
  for (let n = 2; names.has(candidate); n++) candidate = `${name} (${n})`;
  names.add(candidate);
  return candidate;
}

function splitRow(line, delimiter) {
  // Quoted cells as spreadsheets write them ("a, b"), with "" for a quote.
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.length === 0) {
      quoted = true;
    } else if (char === delimiter) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

const SET_HEADER = /^(set|gene[ _]?set|signature|term|pathway|module|group|cluster)$/i;
const GENE_HEADER = /^(gene|genes|symbol|gene[ _]?symbol|gene[ _]?name|names?|feature)$/i;

/**
 * Gene sets of a CSV or TSV table, in any of the shapes such tables come in:
 *
 * - one column: one set of every gene listed (a header naming genes is
 *   skipped);
 * - a set column and a gene column (long format, headed e.g. `set,gene` or
 *   `cluster,names` as scanpy writes it): one set per set value;
 * - otherwise each column is a set named by its header (wide format).
 *
 * @param {string} text
 * @param {{name?: string}} [options] - `name`: the set name of a one-column
 *   table (the file name)
 * @returns {Array<{name: string, genes: string[]}>}
 */
export function parseGeneTable(text, { name = 'Imported genes' } = {}) {
  if (typeof text !== 'string') throw new TypeError('Gene table text must be a string');
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) return [];
  const delimiter = lines[0].includes('\t') ? '\t' : (lines[0].includes(',') ? ',' : (lines[0].includes(';') ? ';' : '\t'));
  const rows = lines.map(line => splitRow(line, delimiter));
  // A loop, not Math.max(...): one argument per row exceeds the engine's
  // argument limit for a table of a whole genome's rows.
  let width = 0;
  for (const row of rows) if (row.length > width) width = row.length;
  const header = rows[0];
  if (width === 1) {
    const body = GENE_HEADER.test(header[0]) ? rows.slice(1) : rows;
    return [{ name, genes: parseGeneText(body.map(row => row[0]).join('\n')) }];
  }
  const setColumn = header.findIndex(cell => SET_HEADER.test(cell));
  const geneColumn = header.findIndex(cell => GENE_HEADER.test(cell));
  if (setColumn >= 0 && geneColumn >= 0 && setColumn !== geneColumn) {
    const bySet = new Map();
    for (const row of rows.slice(1)) {
      const set = row[setColumn] ?? '';
      const gene = row[geneColumn] ?? '';
      if (set.length === 0 || gene.length === 0) continue;
      if (!bySet.has(set)) bySet.set(set, []);
      bySet.get(set).push(gene);
    }
    return [...bySet].map(([setName, genes]) => ({ name: setName, genes: parseGeneText(genes.join('\n')) }));
  }
  const names = new Set();
  const sets = [];
  for (let column = 0; column < width; column++) {
    const setName = uniqueGeneSetName((header[column] ?? '').trim() || `Set ${column + 1}`, names);
    const genes = parseGeneText(rows.slice(1).map(row => row[column] ?? '').join('\n'));
    if (genes.length > 0) sets.push({ name: setName, genes });
  }
  return sets;
}

/**
 * How the genes of the gene list in use are identified across a boundary
 * (the viewer protocol, GMT files, a notebook): by their var index name, the
 * identifier (`geneNames.ids` when a var column of symbols names them, else
 * the name itself), with the name shown beside it. `idOf(name)` is a gene's
 * identifier (a name of no gene of the list stays as it is); `ids` maps each
 * identifier to its shown name. Made once per gene list.
 *
 * @param {{fields?: Array<Object>, geneNames?: {ids?: string[]|null}}|null} varData
 * @returns {{idOf: (name: string) => string, ids: Map<string, string>}}
 */
export function geneIdentities(varData) {
  if (varData === null || varData === undefined) return EMPTY_IDENTITIES;
  const known = identities.get(varData);
  if (known !== undefined) return known;
  const list = varData.geneNames?.ids ?? null;
  const ids = new Map();
  const byName = new Map();
  for (const field of varData.fields ?? []) {
    if (field?._isUserDefined === true || typeof field?.path !== 'string') continue;
    const match = /\/(0|[1-9][0-9]*)$/.exec(field.path);
    const id = list === null || match === null ? field.key : (list[Number(match[1])] ?? field.key);
    ids.set(id, field.key);
    byName.set(field.key, id);
  }
  const result = Object.freeze({ idOf: name => byName.get(name) ?? name, ids });
  identities.set(varData, result);
  return result;
}

const identities = new WeakMap();
const EMPTY_IDENTITIES = Object.freeze({ idOf: name => name, ids: new Map() });

/**
 * Index a dataset's gene names for matching: each name, each name lower-cased
 * (`byLower`), and, with `identities` (`geneIdentities`), each gene's
 * identifier, so a request may name a gene either way.
 *
 * @param {string[]} available
 * @param {ReturnType<typeof geneIdentities>|null} [identities]
 * @returns {{exact: Set<string>, byLower: Map<string, string[]>, ids: Map<string, string>, idsByLower: Map<string, string[]>, names: string[], lowered: string[], size: number}}
 */
export function createGeneIndex(available, identities = null) {
  if (!Array.isArray(available)) throw new TypeError('Available genes must be an array');
  const exact = new Set(available);
  const byLower = new Map();
  const lowered = new Array(available.length);
  for (let index = 0; index < available.length; index++) {
    const gene = available[index];
    const lower = gene.toLowerCase();
    lowered[index] = lower;
    const list = byLower.get(lower);
    if (list === undefined) byLower.set(lower, [gene]);
    else list.push(gene);
  }
  // Identifiers of the genes listed here, when they differ from the names.
  const ids = new Map();
  const idsByLower = new Map();
  for (const [id, name] of identities?.ids ?? []) {
    if (id === name || !exact.has(name)) continue;
    ids.set(id, name);
    const lower = id.toLowerCase();
    const list = idsByLower.get(lower);
    if (list === undefined) idsByLower.set(lower, [name]);
    else if (!list.includes(name)) list.push(name);
  }
  return { exact, byLower, ids, idsByLower, names: available, lowered, size: available.length };
}

/**
 * Match requested genes to a dataset's genes, each request by the gene's
 * identifier or its name (ids first): the exact identifier, else the exact
 * name, else the one gene whose identifier or name matches ignoring case. A
 * request two genes answer is reported, never guessed. Never throws.
 *
 * @param {string[]} requested
 * @param {string[]|ReturnType<typeof createGeneIndex>} available
 * @returns {{
 *   resolved: string[],
 *   unmatched: string[],
 *   ambiguous: Array<{requested: string, candidates: string[]}>,
 *   renamed: Array<{requested: string, gene: string}>
 * }} `resolved`: the dataset's names, in request order, each once;
 *   `renamed`: requests matched by case (`Cd3e` → `CD3E`)
 */
export function resolveGenes(requested, available) {
  const index = Array.isArray(available) ? createGeneIndex(available) : available;
  const ids = index.ids ?? new Map();
  const idsByLower = index.idsByLower ?? new Map();
  const resolved = [];
  const seen = new Set();
  const unmatched = [];
  const ambiguous = [];
  const renamed = [];
  for (const name of Array.isArray(requested) ? requested : []) {
    if (typeof name !== 'string' || name.length === 0) continue;
    let gene = null;
    if (ids.has(name)) {
      gene = ids.get(name);
    } else if (index.exact.has(name)) {
      gene = name;
    } else {
      const lower = name.toLowerCase();
      const candidates = [...new Set([...(idsByLower.get(lower) ?? []), ...(index.byLower.get(lower) ?? [])])];
      if (candidates.length === 1) {
        gene = candidates[0];
        renamed.push({ requested: name, gene });
      } else if (candidates.length > 1) {
        ambiguous.push({ requested: name, candidates });
        continue;
      }
    }
    if (gene === null) {
      unmatched.push(name);
      continue;
    }
    if (seen.has(gene)) continue;
    seen.add(gene);
    resolved.push(gene);
  }
  return { resolved, unmatched, ambiguous, renamed };
}

/**
 * The gene sets of an imported file, by its name: `.gmt` as GMT, `.csv` /
 * `.tsv` as a table, anything else as a gene list.
 *
 * @param {string} fileName
 * @param {string} text
 * @returns {Array<{name: string, genes: string[]}>}
 */
export function parseGeneFile(fileName, text) {
  const base = String(fileName).replace(/\.[^.]+$/, '') || 'Imported genes';
  const extension = /\.([^.]+)$/.exec(String(fileName))?.[1]?.toLowerCase() ?? '';
  if (extension === 'gmt') return parseGmt(text).map(({ name, genes }) => ({ name, genes }));
  if (extension === 'csv' || extension === 'tsv') return parseGeneTable(text, { name: base });
  return [{ name: base, genes: parseGeneText(text) }];
}

/**
 * Gene families a marker or DE run can leave out (scanpy's `mask_var` use):
 * mitochondrial, ribosomal protein and hemoglobin genes, by the human and
 * mouse symbol conventions.
 */
export const GENE_FAMILIES = Object.freeze({
  mito: Object.freeze({ label: 'Mitochondrial', pattern: /^(MT|mt|Mt)-/ }),
  ribo: Object.freeze({ label: 'Ribosomal', pattern: /^(RP[SL]\d|Rp[sl]\d)/ }),
  hemo: Object.freeze({ label: 'Hemoglobin', pattern: /^(HB(A1|A2|B|D|E1|G1|G2|M|Q1|Z)|Hb(a|b)-?\w*)$/ }),
});

/**
 * How many of `genes` each family matches.
 * @param {string[]} genes
 * @returns {{mito: number, ribo: number, hemo: number}}
 */
export function countGeneFamilies(genes) {
  const counts = { mito: 0, ribo: 0, hemo: 0 };
  for (const gene of genes) {
    for (const key of Object.keys(GENE_FAMILIES)) {
      if (GENE_FAMILIES[key].pattern.test(gene)) counts[key]++;
    }
  }
  return counts;
}

/**
 * A custom exclusion pattern as a RegExp, or the reason it is not one.
 * @param {string} source
 * @returns {{regex: RegExp|null, error: string|null}}
 */
export function compileGenePattern(source) {
  if (source.length === 0) return { regex: null, error: null };
  try {
    return { regex: new RegExp(source), error: null };
  } catch (error) {
    return { regex: null, error: `Not a valid pattern: ${error.message}` };
  }
}

/**
 * The genes a run tests: every gene, less the excluded families and the
 * custom pattern, within "only genes in" (null: every gene).
 *
 * @param {string[]} genes - The dataset's genes, in order
 * @param {{exclude: string[], pattern: string, only: Set<string>|null}} filters
 * @returns {string[]}
 */
export function filterGenes(genes, { exclude, pattern, only }) {
  const families = exclude.map(key => {
    const family = GENE_FAMILIES[key];
    if (family === undefined) throw new RangeError(`Unknown gene family ${key}`);
    return family.pattern;
  });
  const { regex, error } = compileGenePattern(pattern);
  if (error !== null) throw new TypeError(error);
  return genes.filter(gene =>
    (only === null || only.has(gene)) &&
    !families.some(family => family.test(gene)) &&
    (regex === null || !regex.test(gene))
  );
}

/**
 * The gene sets a notebook pushed to the viewer (`registries/derived-results.js`),
 * as the gene set editor's "From notebook" adds them; null when there is none.
 *
 * @param {{getDerivedResults: () => import('../../registries/derived-results.js').DerivedResultsRegistry}} state
 * @returns {Array<{name: string, genes: string[]}>|null}
 */
export function notebookGeneSets(state) {
  const sets = state.getDerivedResults().getGeneSets()
    .filter(entry => entry.owner === 'notebook')
    .map(entry => ({ name: entry.set.name, genes: [...entry.set.genes] }));
  return sets.length > 0 ? sets : null;
}
