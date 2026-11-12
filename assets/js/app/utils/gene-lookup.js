/**
 * @fileoverview Which gene a name chooses, or why it chooses none.
 *
 * Every way a gene is chosen goes through here: the sidebar's Gene expression
 * search (typing, a pasted name, then Enter), and the exact name an analysis
 * result colors by. A choice that finds no gene is never dropped in silence:
 * `describeUnavailableGene` says why in words the person can act on.
 *
 * Matching (`rankGeneMatches`) ignores letter case and ranks the gene named
 * exactly first, then names that start with the query, then names that
 * contain it (`text-match.js`), so Enter with no option highlighted takes the
 * gene the person most likely meant. A name is compared as it is: a dot in
 * it (`AC058791.1`, `RP11-34P13.7`) is a character like any other. An
 * Ensembl accession typed with its version (`ENSG00000141510.17`) also finds
 * the same accession listed without one or with another version: the version
 * numbers a release of the annotation, not another gene.
 *
 * @module utils/gene-lookup
 */

import { rankedMatchIndices } from './text-match.js';

/**
 * An Ensembl gene accession of any species, with or without a version
 * suffix, lower-cased: the stable id (`ensg00000141510`,
 * `ensmusg00000059552`) and the version.
 */
const ENSEMBL_GENE = /^(ens[a-z]*g\d{6,})(\.\d+)?$/;

/**
 * The stable id of an Ensembl gene accession, lower-cased and without its
 * version (`ENSG00000141510.17` and `ensg00000141510` give
 * `ensg00000141510`), or null for any other name.
 *
 * @param {string} name
 * @returns {string|null}
 */
export function ensemblStableId(name) {
  if (typeof name !== 'string') throw new TypeError('A gene name must be a string.');
  return ENSEMBL_GENE.exec(name.trim().toLowerCase())?.[1] ?? null;
}

/**
 * The positions of `loweredKeys` a query finds, best match first.
 *
 * @param {string[]} loweredKeys - The gene names, lower-cased, in list order
 * @param {string} query - What was typed (any case, may be padded)
 * @returns {number[]}
 */
export function rankGeneMatches(loweredKeys, query) {
  if (!Array.isArray(loweredKeys)) throw new TypeError('Gene names to match must be an array.');
  if (typeof query !== 'string') throw new TypeError('A gene query must be a string.');
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [];
  const matches = rankedMatchIndices(loweredKeys, normalized);
  const versioned = ENSEMBL_GENE.exec(normalized);
  if (versioned === null || versioned[2] === undefined) return matches;
  // The accession without its version, after every match of the name as
  // typed: listed bare it is equal, listed with another version a prefix.
  const seen = new Set(matches);
  for (const index of rankedMatchIndices(loweredKeys, versioned[1])) {
    if (!seen.has(index)) {
      seen.add(index);
      matches.push(index);
    }
  }
  return matches;
}

/**
 * Why no gene was chosen, as a typed name or an exact one meets the gene
 * list: `null` when the list can choose one.
 *
 * @param {{pending: boolean, failure: Error|null, geneCount: number}} list
 *   `pending`: the gene names are still being read; `failure`: why they could
 *   not be; `geneCount`: the genes listed
 * @returns {'pending'|'failed'|'no-genes'|null}
 */
export function geneListRefusal({ pending, failure, geneCount }) {
  if (typeof pending !== 'boolean') throw new TypeError('Gene list pending must be a boolean.');
  if (failure !== null && !(failure instanceof Error)) throw new TypeError('Gene list failure must be an Error or null.');
  if (!Number.isSafeInteger(geneCount) || geneCount < 0) throw new TypeError('Gene count must be a non-negative safe integer.');
  if (pending) return 'pending';
  if (failure !== null) return 'failed';
  if (geneCount === 0) return 'no-genes';
  return null;
}

/**
 * The gene a typed query chooses: the best match (`rankGeneMatches`), or why
 * there is none.
 *
 * @param {string} query
 * @param {{loweredKeys: string[], pending: boolean, failure: Error|null}} list
 * @returns {{kind: 'match', position: number}|{kind: 'empty'}|{kind: 'pending'|'failed'|'no-genes'|'absent'}}
 *   `position`: the index in `loweredKeys`
 */
export function resolveTypedGene(query, { loweredKeys, pending, failure }) {
  if (typeof query !== 'string') throw new TypeError('A gene query must be a string.');
  const refusal = geneListRefusal({ pending, failure, geneCount: loweredKeys.length });
  if (refusal !== null) return { kind: refusal };
  if (query.trim().length === 0) return { kind: 'empty' };
  const matches = rankGeneMatches(loweredKeys, query);
  return matches.length === 0 ? { kind: 'absent' } : { kind: 'match', position: matches[0] };
}

/**
 * The gene named exactly `key` (an analysis result's gene, a session's), or
 * why there is none. Exact: a result names the gene of the list it was
 * computed from, so a near name is another gene.
 *
 * @param {string} key
 * @param {{keys: string[], pending: boolean, failure: Error|null}} list
 * @returns {{kind: 'match', position: number}|{kind: 'pending'|'failed'|'no-genes'|'absent'}}
 */
export function resolveExactGene(key, { keys, pending, failure }) {
  if (typeof key !== 'string' || key.length === 0) throw new TypeError('A gene to choose must be its exact non-empty name.');
  const refusal = geneListRefusal({ pending, failure, geneCount: keys.length });
  if (refusal !== null) return { kind: refusal };
  const position = keys.indexOf(key);
  return position < 0 ? { kind: 'absent' } : { kind: 'match', position };
}

/**
 * What to say when `name` chooses no gene, for an outcome of
 * `resolveTypedGene` or `resolveExactGene` other than a match.
 *
 * @param {string} name - The name as the person typed it or the result gave it
 * @param {{kind: string}} outcome
 * @param {Error|null} [failure] - Why the gene names could not be read
 * @returns {string}
 */
export function describeUnavailableGene(name, outcome, failure = null, quote = text => text) {
  // `quote`: how the sentence writes the name (an agent's refusal marks it as data, `targets/names.js` `quoteName`).
  const shown = quote(String(name).trim());
  switch (outcome?.kind) {
    case 'pending':
      return `Gene names are still being read: ${shown} can be chosen once they are listed.`;
    case 'failed':
      return `${shown} cannot be shown: the gene names of this dataset could not be read${failure instanceof Error ? ` (${failure.message})` : ''}.`;
    case 'no-genes':
      return `${shown} cannot be shown: this dataset has no gene expression.`;
    case 'absent':
      return `${shown} is not a gene in this dataset.`;
    default:
      throw new TypeError(`No gene-choice refusal is described for "${outcome?.kind}".`);
  }
}

/**
 * A gene that cannot be chosen, and why (`describeUnavailableGene`): a
 * refusal the caller says as information, not a failure of the app.
 */
export class GeneUnavailableError extends Error {
  /**
   * @param {string} name
   * @param {{kind: string}} outcome
   * @param {Error|null} [failure]
   */
  constructor(name, outcome, failure = null) {
    super(describeUnavailableGene(name, outcome, failure));
    this.name = 'GeneUnavailableError';
    this.gene = name;
    this.reason = outcome.kind;
    this.failure = failure;
  }
}
