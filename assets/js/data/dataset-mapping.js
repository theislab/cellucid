/**
 * The data mapping a loaded dataset is shown with, and the embedding
 * references a session uses to name one of its layouts.
 *
 * A data mapping (see `data-mapping.js`) names, for one dataset, the embeddings
 * it can be shown with and each dimension's default, the vector fields bound
 * to embeddings, the neighbour graph, gene names, expression matrix and latent
 * space. It is recorded in every session fingerprint, so a
 * session is restored only onto the same mapping.
 *
 * Every dataset is an AnnData file -- an `.h5ad` or Zarr store this viewer
 * reads, opened here, from a link or a catalog, or served by Python -- and
 * states the mapping it is shown with as the `defaults` of its candidate
 * catalog (its `candidates` route), because the graph and
 * expression matrix in use are not visible in the identity.
 *
 * An embedding reference names one layout: an AnnData `obsm` key with the
 * 0-based columns plotted.
 *
 * @module data/dataset-mapping
 */

import {
  ANNDATA_KIND,
  DIMENSION_SLOTS,
  validateDataMapping,
  validateEmbeddingRef,
} from './data-mapping.js';

/**
 * The clause a mapping-choice refusal gives for a group the open dataset
 * cannot change ("This session was saved with ..., which cannot be changed
 * for this dataset").
 */
export const UNCHANGEABLE_GROUP_CLAUSE = 'cannot be changed for this dataset';

/** The words every mapping group is named with in a sentence. */
export const MAPPING_GROUP_LABELS = Object.freeze({
  knn: 'neighbour graph',
  geneNames: 'gene names',
  expression: 'expression matrix',
  latent: 'latent space',
  vectorFields: 'vector fields',
});

/**
 * One group value as a sentence names it: `obsp['connectivities']`, `the var
 * index`, `var column 'gene_symbols'`, `layers['counts']`, `obsm['X_scVI']`,
 * `obsm['velocity_umap'] on X_umap[0,1]`, `none`.
 *
 * @param {string} group
 * @param {*} value
 * @returns {string}
 */
export function describeMappingGroupValue(group, value) {
  if (value === null) return 'none';
  if (group === 'vectorFields') {
    if (value.length === 0) return 'none';
    return value.map(binding => (
      `obsm['${binding.key}'] on ${binding.embedding.key}[${binding.embedding.columns.join(',')}]`
    )).join(', ');
  }
  if (group === 'knn') return `obsp['${value}']`;
  if (group === 'latent') return `obsm['${value}']`;
  if (group === 'geneNames') {
    return value === 'index' ? 'the var index' : `var column '${value.slice('column:'.length)}'`;
  }
  if (group === 'expression') {
    return value.startsWith('layer:') ? `layers['${value.slice('layer:'.length)}']` : value;
  }
  return JSON.stringify(value);
}

/** The route of the candidate catalog under a dataset base. */
export const MAPPING_CANDIDATES_ROUTE = 'candidates';

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The mapping an AnnData dataset is shown with, read from its candidate
 * catalog, and checked against the dataset identity published beside it.
 *
 * @param {unknown} candidates - The candidate catalog (`candidates`).
 * @param {Object} identity - The validated dataset identity.
 * @returns {Object} A canonical AnnData DataMapping.
 */
export function resolveAnnDataMapping(candidates, identity) {
  if (
    !isPlainRecord(candidates) ||
    candidates.kind !== ANNDATA_KIND ||
    !Object.hasOwn(candidates, 'defaults')
  ) {
    throw new TypeError(
      'An AnnData data-mapping catalog must be of kind "anndata" and state its defaults.'
    );
  }
  const mapping = validateDataMapping(candidates.defaults, {
    label: 'AnnData data mapping',
  });
  const items = identity.embeddings.items;
  const defaults = identity.embeddings.defaults;
  for (const slot of DIMENSION_SLOTS) {
    const ref = mapping.embeddings.defaults[slot];
    const embeddingId = Object.hasOwn(defaults, slot) ? defaults[slot] : null;
    const source = embeddingId === null ? null : items[embeddingId].source;
    const agrees = ref === null
      ? source === null
      : source !== null &&
        source.key === ref.key &&
        source.columns.length === ref.columns.length &&
        source.columns.every((column, index) => column === ref.columns[index]);
    if (!agrees) {
      throw new Error(
        `The data mapping shows ${JSON.stringify(ref)} in ${slot}, ` +
        `but the dataset identity shows ${JSON.stringify(source)}.`
      );
    }
  }
  return mapping;
}

/**
 * The embedding reference that names one registered layout: its AnnData
 * `obsm` key and the 0-based columns it plots.
 *
 * @param {{getLayout: Function}} dimensionManager
 * @param {string} layoutKey
 * @returns {{key: string, columns: number[]}}
 */
export function layoutEmbeddingRef(dimensionManager, layoutKey) {
  const layout = dimensionManager.getLayout(layoutKey);
  if (layout.provenance === null || layout.provenance.columns === null) {
    throw new TypeError(
      `Layout "${layout.layoutKey}" has no AnnData obsm provenance to name it by.`
    );
  }
  return { key: layout.provenance.key, columns: [...layout.provenance.columns] };
}

/**
 * The registered layout an embedding reference names, or null when no
 * registered layout matches it and the dataset cannot register one (see the
 * DimensionManager's layout provider). The reference is validated first.
 *
 * @param {{getLayout: Function, resolveProvenanceLayout: Function}} dimensionManager
 * @param {unknown} ref
 * @param {number|null} dimension - Required dimension, or null for any.
 * @param {string} label
 * @returns {string|null} The layout key.
 */
export function resolveEmbeddingRefLayout(dimensionManager, ref, dimension, label) {
  const valid = validateEmbeddingRef(ref, { dimension, label });
  const layoutKey = dimensionManager.resolveProvenanceLayout(valid.key, valid.columns);
  if (layoutKey === null) return null;
  if (
    dimension !== null &&
    dimensionManager.getLayout(layoutKey).dimension !== dimension
  ) {
    return null;
  }
  return layoutKey;
}

/**
 * Describe one embedding reference the way the person reading a refusal
 * would recognise it.
 *
 * @param {{key: string, columns: number[]}} ref
 * @returns {string}
 */
export function describeEmbeddingRef(ref) {
  return `obsm['${ref.key}'] columns [${ref.columns.join(', ')}]`;
}
