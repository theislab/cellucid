/**
 * Short, readable names for representations (the embeddings a view can
 * show), for pickers, view rows, badges and toasts.
 *
 * A name that is an array key ("X_umap_3d", "X_draw_graph_fa", "X_pca[0,2]") is turned into a
 * short name: the `X_` prefix and a dimension suffix go (the dimension is
 * shown beside the name), the usual method names are spelled the usual way,
 * and a column selection of a wider array is shown as 1-based components
 * ("PCA 1,3"). The exact key and columns stay available as the layout label.
 *
 * @module data/representation-names
 */

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
  emb: 'Embedding',
  latent: 'Latent',
});
const DRAW_GRAPH = /^draw_graph_(fa|fr)$/i;
const IDENTIFIER = /^[A-Za-z0-9_.\-]+(\[[0-9,]+\])?$/;
const DIMENSION_TOKEN = /^[123]d$/i;

/**
 * A short name for one array key.
 *
 * @param {string} key - An AnnData obsm key.
 * @returns {string}
 */
export function representationKeyName(key) {
  const bare = key.replace(/\[[0-9,]+\]$/, '').replace(/^x_/i, '');
  if (DRAW_GRAPH.test(bare)) {
    return bare.toLowerCase().endsWith('fa') ? 'ForceAtlas2' : 'Fruchterman–Reingold';
  }
  const tokens = bare
    .split(/[_\s]+/)
    .filter(token => token.length > 0 && !DIMENSION_TOKEN.test(token))
    .map(token => KNOWN_TOKENS[token.toLowerCase()] ?? token);
  return tokens.length > 0 ? tokens.join(' ') : key;
}

/**
 * A short name for one registered layout.
 *
 * @param {{label: string, layoutKey: string, provenance: {key: string, columns: readonly number[]|null}|null, width?: number}} layout
 *   `width` is the column count of the source array, when known.
 * @returns {string}
 */
export function representationName(layout) {
  const label = String(layout.label);
  if (!IDENTIFIER.test(label)) return label;
  const provenance = layout.provenance;
  const key = provenance?.key ?? label;
  const name = representationKeyName(key);
  const columns = provenance?.columns ?? null;
  const bracketed = /\[([0-9,]+)\]$/.exec(label);
  const shown = columns ?? (bracketed === null ? null : bracketed[1].split(',').map(Number));
  if (shown === null) return name;
  const isLeading = shown.every((column, index) => column === index);
  const wider = typeof layout.width === 'number' && layout.width > shown.length;
  if (isLeading && !wider && bracketed === null) return name;
  return `${name} ${shown.map(column => column + 1).join(',')}`;
}
