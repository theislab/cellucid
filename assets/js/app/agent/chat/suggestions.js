/**
 * @fileoverview What the empty chat offers to start with, made from the
 * dataset shown: a first look; annotating the clusters of its first
 * categorical field (one known to have a single category is passed over);
 * comparing that field's two largest groups; and, once the history holds
 * steps, explaining them.
 *
 * Only what the dataset says of itself is read (`fields.list`, as the
 * person, which records nothing): no field's values are read for a
 * suggestion, so opening the chat costs no download, and the agent reads
 * the groups when it is asked.
 *
 * @module app/agent/chat/suggestions
 */

/**
 * @param {{field?: string|null, steps?: number}} facts - `field`: the key of the first categorical field
 *   not known to have a single category; `steps`: steps in the history shown
 * @returns {string[]}
 */
export function suggestionsFor({ field = null, steps = 0 } = {}) {
  const out = ['Give me a first look at this dataset'];
  if (field !== null) {
    out.push(`Annotate the clusters of ${field}`);
    out.push(`Compare the two largest groups of ${field}`);
  }
  if (steps > 0) out.push('Explain what was done so far and write a methods paragraph');
  return out;
}

/**
 * The facts the suggestions are made from, read from the page; a null field
 * when there is no dataset or no categorical field.
 * @param {{dispatch: Function}} actions
 * @param {number} steps
 */
export async function readSuggestionFacts(actions, steps) {
  try {
    const { outcome } = await actions.dispatch('fields.list', { kind: 'categorical' });
    // A field's categories are counted only once it was read: an uncounted one may have several.
    const first = (outcome?.fields ?? []).find(candidate => candidate.categories === undefined || candidate.categories > 1);
    return { field: first?.key ?? null, steps };
  } catch {
    return { field: null, steps };
  }
}
