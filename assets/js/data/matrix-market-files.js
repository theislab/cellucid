/**
 * MatrixMarket datasets by their file names: which matrix goes with which
 * feature and barcode lists, in a folder on this computer or in a listing on
 * a host (a GEO series). Names only; nothing is read.
 *
 * A matrix `<prefix>matrix.mtx[.gz]` (or `count_matrix`, `DGE`) takes the
 * lists of its own prefix (`GSM5008737_RNA_3P-features.tsv.gz`): the
 * uploads of GEO, where every sample's three files share one prefix. When
 * its own prefix has no list of a kind, a shorter prefix ending at a
 * separator (`_`, `-`, `.`) is tried (`GSE1_RNA_matrix.mtx.gz` with
 * `GSE1_barcodes.tsv.gz`, a CITE-seq upload sharing its cells), but never
 * one that has a matrix of its own: those lists are that matrix's.
 *
 * The result names, for every matrix, its lists or what is wrong: a list
 * missing (with the names that would have been taken), or two lists where
 * one was expected (`features.tsv.gz` and `genes.tsv.gz` beside one
 * matrix; a matrix both compressed and not). A list may serve several
 * matrices (`shared`).
 *
 * @module data/matrix-market-files
 */

/** The compressions a list or matrix may carry, the one GEO uses first. */
const COMPRESSIONS = Object.freeze(['.gz', '', '.bz2', '.xz']);

/** Feature and barcode list names after the prefix, in order of preference. */
export const FEATURE_LISTS = Object.freeze(['features.tsv', 'genes.tsv', 'features.txt', 'genes.txt', 'all_genes.csv']);
export const CELL_LISTS = Object.freeze(['barcodes.tsv', 'barcodes.txt', 'cell_metadata.csv']);

const MATRIX_NAME = /^(.*?)(count_matrix|matrix|DGE)\.mtx(\.gz|\.bz2|\.xz)?$/i;
const SEPARATOR = /[_.-]/;

/** The folder and file name of one path. */
function splitPath(path) {
  const text = String(path).replace(/\\/g, '/');
  const slash = text.lastIndexOf('/');
  return slash < 0 ? { folder: '', name: text } : { folder: text.slice(0, slash + 1), name: text.slice(slash + 1) };
}

/**
 * `prefix` and every shorter prefix of it that ends at a separator, longest
 * first, down to the empty prefix.
 */
export function prefixesOf(prefix) {
  const found = [prefix];
  for (let index = prefix.length - 2; index >= 0; index--) {
    if (SEPARATOR.test(prefix[index])) found.push(prefix.slice(0, index + 1));
  }
  if (prefix !== '') found.push('');
  return found;
}

/**
 * The matrix sets of a list of paths.
 *
 * @param {Iterable<string>} paths - File paths (or bare names of one listing)
 * @returns {{sets: Array<{matrix: string, prefix: string, features: string, cells: string,
 *   shared: {features: string[], cells: string[]}}>,
 *   problems: Array<{matrix: string, prefix: string, missing: string[], ambiguous: string[], message: string}>}}
 *   `sets`, complete; `problems`, a matrix that cannot be opened and why.
 *   Both in the order of the matrices' paths.
 */
export function matrixMarketFileSets(paths) {
  const byFolder = new Map();
  for (const path of paths) {
    const { folder, name } = splitPath(path);
    if (!byFolder.has(folder)) byFolder.set(folder, new Map());
    byFolder.get(folder).set(name.toLowerCase(), name);
  }
  const sets = [];
  const problems = [];
  for (const [folder, names] of byFolder) {
    // Every matrix of this folder, by its prefix (lower case).
    const matrices = new Map();
    for (const name of names.values()) {
      const match = MATRIX_NAME.exec(name);
      if (match === null) continue;
      const key = match[1].toLowerCase();
      if (!matrices.has(key)) matrices.set(key, []);
      matrices.get(key).push(name);
    }
    const listsAt = (prefix, kinds) => {
      const found = [];
      for (const kind of kinds) {
        for (const compression of COMPRESSIONS) {
          const name = names.get(`${prefix}${kind}${compression}`);
          if (name !== undefined) {
            found.push(name);
            break;
          }
        }
      }
      return found;
    };
    for (const [key, own] of [...matrices].sort(([a], [b]) => a.localeCompare(b))) {
      const prefix = MATRIX_NAME.exec(own[0])[1];
      const matrixPath = `${folder}${own[0]}`;
      if (own.length > 1) {
        problems.push(problem(matrixPath, prefix, [], own.map(name => `${folder}${name}`),
          `${own.join(' and ')} are two matrices of one sample. Open the folder that holds only the one you mean, with its feature and barcode files.`));
        continue;
      }
      const resolve = kinds => {
        for (const candidate of prefixesOf(key)) {
          // A shorter prefix with a matrix of its own keeps its lists.
          if (candidate !== key && matrices.has(candidate)) return { found: [], at: candidate };
          const found = listsAt(candidate, kinds);
          if (found.length > 0) return { found, at: candidate };
        }
        return { found: [], at: key };
      };
      const features = resolve(FEATURE_LISTS);
      const cells = resolve(CELL_LISTS);
      const missing = [];
      if (features.found.length === 0) missing.push(`${prefix}features.tsv.gz (or ${prefix}genes.tsv.gz)`);
      if (cells.found.length === 0) missing.push(`${prefix}barcodes.tsv.gz`);
      if (missing.length > 0) {
        problems.push(problem(matrixPath, prefix, missing, [],
          `${own[0]} has no ${missing.join(' and no ')} beside it, so its ${missing.length === 2 ? 'rows and columns are' : features.found.length === 0 ? 'features are' : 'cells are'} not named. ` +
          `Download the missing file${missing.length === 2 ? 's' : ''} from where the matrix came from, put ${missing.length === 2 ? 'them' : 'it'} beside the matrix, and open the folder with Open… › Folder….`));
        continue;
      }
      // Two feature lists of different kinds (features and genes) at one
      // prefix: which names the rows cannot be told from the names.
      const featureKinds = features.found.filter(name => /^(features|genes)\.(tsv|txt)/i.test(name.slice(features.at.length)));
      if (featureKinds.length > 1) {
        problems.push(problem(matrixPath, prefix, [], featureKinds.map(name => `${folder}${name}`),
          `${own[0]} has both ${featureKinds.join(' and ')} beside it, and either could name its rows. ` +
          'Download the matrix, its barcodes and the one feature list you mean into a folder of their own, and open it with Open… › Folder….'));
        continue;
      }
      sets.push({
        matrix: matrixPath,
        prefix,
        features: `${folder}${features.found[0]}`,
        cells: `${folder}${cells.found[0]}`,
        shared: { features: [], cells: [] },
      });
    }
  }
  // A list taken by several matrices is shared; each set says with which.
  for (const kind of ['features', 'cells']) {
    const users = new Map();
    for (const set of sets) {
      if (!users.has(set[kind])) users.set(set[kind], []);
      users.get(set[kind]).push(set.matrix);
    }
    for (const set of sets) set.shared[kind] = users.get(set[kind]).filter(matrix => matrix !== set.matrix);
  }
  const order = (a, b) => a.matrix.localeCompare(b.matrix);
  return { sets: sets.sort(order), problems: problems.sort(order) };
}

function problem(matrix, prefix, missing, ambiguous, message) {
  return { matrix, prefix, missing, ambiguous, message };
}

/** Whether a name is a MatrixMarket matrix this module groups. */
export function isMatrixMarketMatrix(name) {
  return MATRIX_NAME.test(splitPath(name).name);
}

/**
 * The cell tables each MatrixMarket set may be joined with, in one listing:
 * the tables of its own prefix (`GSM1_metadata.csv.gz`), or of a shorter
 * one (`GSE1_cell_annotations.tsv.gz`), apart from the lists any set takes.
 * One pass over the paths, then over each folder's tables.
 *
 * @param {Iterable<string>} paths
 * @param {ReadonlyArray<{matrix: string, prefix: string, features: string, cells: string}>} sets
 * @returns {Map<string, string[]>} By each set's matrix
 */
export function cellTablesBySet(paths, sets) {
  const taken = new Set(sets.flatMap(set => [set.features, set.cells]));
  const tablesByFolder = new Map();
  for (const path of paths) {
    if (taken.has(path)) continue;
    const { folder, name } = splitPath(path);
    if (!/\.(csv|tsv)(\.gz|\.bz2|\.xz)?$/i.test(name)) continue;
    if (!tablesByFolder.has(folder)) tablesByFolder.set(folder, []);
    tablesByFolder.get(folder).push({ path, lower: name.toLowerCase() });
  }
  const found = new Map();
  for (const set of sets) {
    const prefixes = prefixesOf(set.prefix.toLowerCase()).filter(prefix => prefix !== '');
    const tables = tablesByFolder.get(splitPath(set.matrix).folder) ?? [];
    found.set(set.matrix, tables.filter(table => prefixes.some(prefix => table.lower.startsWith(prefix))).map(table => table.path));
  }
  return found;
}
