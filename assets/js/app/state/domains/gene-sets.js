/**
 * @fileoverview The `gene-sets` state domain: the gene sets the viewer holds
 * as its own (`registries/derived-results.js`, owner `notebook`: pushed by a
 * Python or R notebook, the `gene-set.save` action).
 *
 * Value: `{sets: [{name, description, genes: [gene, …]}, …]}`, in the order
 * they were made, each gene by its name as given. The sets an analysis shows
 * (its markers, a gene signature's) are that analysis's result, in the
 * `analysis` domain, and are not repeated here.
 *
 * Python and R read this shape from a saved history to apply gene sets to an
 * AnnData (`apply_cellucid_session_to_anndata`, `cellucid_apply_session`).
 *
 * @module app/state/domains/gene-sets
 */

import { formatCountOf } from '../../../utils/format-units.js';

/**
 * @param {{state: object}} options
 */
export function createGeneSetsDomain({ state }) {
  const registry = () => state.getDerivedResults();
  return {
    capture() {
      return { sets: registry().toSessionRecord() };
    },
    restore(value) {
      if (value === null || typeof value !== 'object' || !Array.isArray(value.sets)) {
        throw new TypeError('The gene sets to restore must be a list of sets.');
      }
      if (JSON.stringify(registry().toSessionRecord()) === JSON.stringify(value.sets)) return;
      registry().restoreSessionRecord(value.sets);
    },
    describe(a, b) {
      const before = new Map(a.sets.map(set => [set.name, set]));
      const after = new Map(b.sets.map(set => [set.name, set]));
      const lines = [];
      for (const [name, set] of after) {
        const was = before.get(name);
        if (was === undefined) lines.push(`Gene set ${name} added (${formatCountOf(set.genes.length, 'gene')})`);
        else if (JSON.stringify(was) !== JSON.stringify(set)) lines.push(`Gene set ${name} changed (${formatCountOf(set.genes.length, 'gene')})`);
      }
      for (const name of before.keys()) if (!after.has(name)) lines.push(`Gene set ${name} removed`);
      return lines;
    },
  };
}
