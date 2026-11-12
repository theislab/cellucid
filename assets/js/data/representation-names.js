/**
 * Short, readable names for representations (the embeddings a view can
 * show), for pickers, view rows, badges and toasts.
 *
 * A name that is an array key ("X_umap_3d", "X_draw_graph_fa", "X_pca[0,2]") is turned into a
 * short name: the `X_` prefix and a dimension suffix go (the dimension is
 * shown beside the name), the usual method names are spelled the usual way,
 * and a column selection of a wider array is shown as 1-based components
 * ("PCA 1,3"). A MuData modality's array (`rna:X_umap`, `obsmNamespace`)
 * is named as its own array, its modality after it ("UMAP (rna)"); a
 * Seurat-style key with dots (`X_wnn.umap`) is split at them too ("WNN
 * UMAP"). Two keys of a dataset that would share a name are each named
 * with their key ("UMAP (X_umap)", "UMAP (X_umap_2d)"). The exact key and
 * columns stay available as the layout label.
 *
 * @module data/representation-names
 */

import { obsmNamespace } from './data-mapping.js';

const KNOWN_TOKENS = Object.freeze({
  umap: 'UMAP',
  tsne: 't-SNE',
  pca: 'PCA',
  phate: 'PHATE',
  diffmap: 'Diffusion map',
  draw: 'Draw',
  graph: 'graph',
  fa: 'FA',
  fr: 'FR',
  mde: 'MDE',
  scvi: 'scVI',
  scanvi: 'scANVI',
  pacmap: 'PaCMAP',
  trimap: 'TriMap',
  spatial: 'Spatial',
  harmony: 'Harmony',
  wnn: 'WNN',
  emb: 'Embedding',
  latent: 'Latent',
});
const DRAW_GRAPH = /^draw_graph_(fa|fr)$/i;
const IDENTIFIER = /^[A-Za-z0-9_.:\-]+(\[[0-9,]+\])?$/;
const DIMENSION_TOKEN = /^[123]d$/i;

/** The short name of a key without its namespace or a column selection. */
function bareKeyName(key) {
  const bare = key.replace(/\[[0-9,]+\]$/, '').replace(/^x_/i, '');
  if (DRAW_GRAPH.test(bare)) {
    return bare.toLowerCase().endsWith('fa') ? 'ForceAtlas2' : 'Fruchterman–Reingold';
  }
  const tokens = bare
    .split(/[_.\s]+/)
    .filter(token => token.length > 0 && !DIMENSION_TOKEN.test(token))
    .map(token => KNOWN_TOKENS[token.toLowerCase()] ?? token);
  return tokens.length > 0 ? tokens.join(' ') : key;
}

/**
 * What follows a name in parentheses: the key itself when another array of
 * the dataset (`arrays`) would be listed the same way -- the same short name
 * in the same namespace, at the same width (a menu says the dimension beside
 * the name, so `X_umap_1d` and `X_umap_3d` are told apart by it) --, so
 * "UMAP (X_umap)" and "UMAP (X_umap_2d)" are never both "UMAP · 2D"; else a
 * modality's name for its own arrays ("UMAP (rna)"); else nothing.
 */
function qualifierOf(key, arrays) {
  const { prefix, local } = obsmNamespace(key);
  const shortName = bareKeyName(local);
  const width = arrays.find(array => array.key === key)?.width ?? null;
  const collides = arrays.some(other => {
    if (other.key === key) return false;
    const otherSpace = obsmNamespace(other.key);
    if (otherSpace.prefix !== prefix || bareKeyName(otherSpace.local) !== shortName) return false;
    return width === null || other.width === null || other.width === undefined || other.width === width;
  });
  if (collides) return key;
  return prefix === '' ? null : prefix.slice(0, -1);
}

/**
 * A short name for one array key.
 *
 * @param {string} key - An AnnData obsm key.
 * @param {{arrays?: ReadonlyArray<{key: string, width: number|null}>}} [options] -
 *   `arrays`: every `obsm` array of the dataset (key and column count), so a
 *   name two of them would share names its key
 * @returns {string}
 */
export function representationKeyName(key, { arrays = [] } = {}) {
  const bare = key.replace(/\[[0-9,]+\]$/, '');
  const qualifier = qualifierOf(bare, arrays);
  const name = bareKeyName(obsmNamespace(bare).local);
  return qualifier === null ? name : `${name} (${qualifier})`;
}

/**
 * A short name for one registered layout, unique among the dataset's arrays
 * (`arrays`): every menu, the Data mapping checklist, the agents' reads and a
 * figure's title name a representation by this one function
 * (`DataState.representationNameOf` passes the dataset's arrays).
 *
 * @param {{label: string, layoutKey: string, provenance: {key: string, columns: readonly number[]|null}|null, width?: number}} layout
 *   `width` is the column count of the source array, when known.
 * @param {{arrays?: ReadonlyArray<{key: string, width: number|null}>}} [options] -
 *   Every `obsm` array of the dataset
 * @returns {string}
 */
export function representationName(layout, { arrays = [] } = {}) {
  const label = String(layout.label);
  if (!IDENTIFIER.test(label)) return label;
  const provenance = layout.provenance;
  const key = (provenance?.key ?? label).replace(/\[[0-9,]+\]$/, '');
  const qualifier = qualifierOf(key, arrays);
  let name = bareKeyName(obsmNamespace(key).local);
  const columns = provenance?.columns ?? null;
  const bracketed = /\[([0-9,]+)\]$/.exec(label);
  const shown = columns ?? (bracketed === null ? null : bracketed[1].split(',').map(Number));
  if (shown !== null) {
    const isLeading = shown.every((column, index) => column === index);
    const wider = typeof layout.width === 'number' && layout.width > shown.length;
    if (!(isLeading && !wider && bracketed === null)) name = `${name} ${shown.map(column => column + 1).join(',')}`;
  }
  return qualifier === null ? name : `${name} (${qualifier})`;
}

/**
 * The text a representation is shown by wherever a person picks or reads
 * one (the **View N shows** picker, the vector-field block): its short name
 * and its dimension ("UMAP · 2D", "PCA 1,3 · 2D").
 *
 * @param {{name: string, dimension: number}} representation
 * @returns {string}
 */
export function representationOptionText(representation) {
  return `${representation.name} · ${representation.dimension}D`;
}
