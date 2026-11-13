/**
 * @fileoverview What the empty chat offers to start with, made from the
 * dataset shown: a first look; labeling its clustering with cell types when
 * it has one (`utils/field-roles.js` `clusterField`: leiden, louvain,
 * clusters, …), else finding the marker genes of its field of the cells'
 * identity (`identityField`: a cell type, annotation, lineage or cluster
 * name first; never a sample, batch, id or quality flag; one known to have a
 * single category is passed over); comparing that field's two largest
 * groups; and, once the history holds steps, explaining them. The
 * clustering and the identity field are chosen by name, never as the first
 * categorical field (that offered "Annotate the clusters of sample_ID").
 *
 * Only what the dataset says of itself is read (`fields.list`, as the
 * person, which records nothing): no field's values are read for a
 * suggestion, so opening the chat costs no download, and the agent reads
 * the groups when it is asked.
 *
 * @module app/agent/chat/suggestions
 */
import { clusterField, identityField, isNeverFirstColoring } from '../../utils/field-roles.js';

/** What the empty chat offers with no dataset open: the agent opens one. */
const NO_DATASET_SUGGESTION = 'Open a sample dataset and give me a first look at it';

/**
 * @param {{identity?: string|null, cluster?: string|null, steps?: number, dataset?: boolean}} facts -
 *   `identity`: the field of the cells' identity, `cluster`: the clustering
 *   (`readSuggestionFacts`); `steps`: steps in the history shown; `dataset`:
 *   whether a dataset is open (none: "a first look at this dataset" would
 *   ask about nothing)
 * @returns {string[]}
 */
export function suggestionsFor({ identity = null, cluster = null, steps = 0, dataset = true } = {}) {
  if (!dataset) return [NO_DATASET_SUGGESTION];
  const out = ['Give me a first look at this dataset'];
  if (cluster !== null) out.push(`Label each cluster in "${cluster}" with a cell type`);
  else if (identity !== null) out.push(`Find the marker genes of each group in "${identity}"`);
  if (identity !== null) out.push(`Compare the two largest groups in "${identity}"`);
  if (steps > 0) out.push('Explain what was done so far and write a methods paragraph');
  return out;
}

/**
 * The facts the suggestions are made from, read from the page: null fields
 * when there is no dataset, no categorical field or no clustering.
 * @param {{dispatch: Function}} actions
 * @param {number} steps
 */
export async function readSuggestionFacts(actions, steps) {
  try {
    const { outcome } = await actions.dispatch('fields.list', { kind: 'categorical' });
    // A field's categories are counted only once it was read: an uncounted one may have several.
    const fields = (outcome?.fields ?? []).map(candidate => ({
      key: candidate.key,
      categoryCount: Number.isInteger(candidate.categories) ? candidate.categories : null,
    })).filter(candidate => candidate.categoryCount === null || candidate.categoryCount > 1);
    const identity = identityField(fields);
    const cluster = clusterField(fields);
    return {
      identity: identity === '' || isNeverFirstColoring(identity) ? null : identity,
      cluster: cluster === '' ? null : cluster,
      steps,
    };
  } catch {
    return { identity: null, cluster: null, steps };
  }
}
