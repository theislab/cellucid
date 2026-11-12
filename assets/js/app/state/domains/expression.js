/**
 * @fileoverview The `expression` state domain: the expression values the
 * genes are shown and analyzed in (Session › Data mapping › Expression
 * values, `data/expression-transform.js`).
 *
 * Value: `{normalize, log1p}`, the transform asked (both false: the values
 * as stored, the default). A matrix that does not take it (not counts, or
 * `log1p` already) shows its values as stored while the value is kept
 * (`DataState.expressionTransformOffer`). A session or history without it
 * holds the values as stored.
 *
 * Restored right after the data mapping (`app/actions/domains.js`): the
 * matrix the mapping names is the one it applies to, and the views,
 * colors and filters restored after it read the genes in its values. A
 * mapping restored with these values beside it shows its matrix in them at
 * once (`mapping.js`), so a matrix is never summed for values the restore
 * does not end on. Restoring a normalized value reads the cells' totals
 * first (an obs column, else every gene once), asked for as heavy work by
 * the restoring action's `heavy`. A saved state without the field means the
 * values as stored (`absent`).
 *
 * @module app/state/domains/expression
 */

import { RAW_VALUES, requireExpressionTransform, transformKey, transformWords } from '../../../data/expression-transform.js';

/**
 * @param {{state: object, refreshUi: () => void}} options
 */
export function createExpressionDomain({ state, refreshUi }) {
  return {
    capture() {
      const asked = state.getExpressionTransform?.() ?? RAW_VALUES;
      return { normalize: asked.normalize, log1p: asked.log1p };
    },
    // A saved state without the field means the values as stored (plan §3):
    // restored onto an open dataset, it puts them back (`history.js` `readSaved`).
    absent() {
      return { normalize: false, log1p: false };
    },
    // `heavy`: the running action's `ctx.heavy` (an agent's history move or
    // saved state opened): asked before the cells' totals are summed.
    async restore(value, { signal = null, heavy = null } = {}) {
      const asked = requireExpressionTransform(value, 'The expression values to restore');
      if (transformKey(asked) === transformKey(state.getExpressionTransform())) return;
      await state.setExpressionTransform(asked, { signal, heavy });
      refreshUi();
    },
    describe(a, b) {
      return [`Expression values: ${transformWords(requireExpressionTransform(b)).toLowerCase()}${transformKey(a) === 'raw' ? '' : ` (was ${transformWords(a).toLowerCase()})`}`];
    },
  };
}
