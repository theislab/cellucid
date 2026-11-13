/**
 * @fileoverview What a reading of the same dataset with other cells keeps
 * (Open data › Cells to open, `ui/modules/subsample-control.js`
 * `reopenKeeping`, which is also how the `cells` state domain is put back):
 * every state domain but the open cells themselves, captured before the
 * cells are read again and restored after, in domain order, through each
 * domain's owner (`app/state/domains/`). Each value names cells by original
 * position, so it applies to whatever cells are open now.
 *
 * Highlights and labels are not carried here but by `cell-subset-carry.js`,
 * which also lets the cells newly open join what is derived from the file
 * (a group made from a category, a label made from a column).
 *
 * @module session/view-carry
 */

import { DOMAIN_IDS, PER_VIEW_DOMAINS, domainName } from '../actions/domains.js';

/** The domains a reading of other cells keeps here (the cells are what changes; highlights and labels go by `cell-subset-carry.js`). */
const CARRIED_DOMAINS = Object.freeze(DOMAIN_IDS.filter(id => !['cells', 'field-overlays', 'highlights'].includes(id)));

/**
 * The domains a kept view's own state is held in (its coloring, filters,
 * cells hidden by hand and camera, and the views themselves): what the open
 * cells grown or cut in place keep of the kept views they retire
 * (`app/open-cells-resize.js`). Their owners capture at once, so they are
 * taken inside the one synchronous step that replaces the cells.
 */
const KEPT_VIEW_DOMAINS = Object.freeze(['views', ...PER_VIEW_DOMAINS]);

/**
 * @param {{domains: ReturnType<typeof import('../actions/domains.js').createDomainRegistry>}} options -
 *   the page's state-domain registry (`getStateDomains()`)
 * @returns {{
 *   capture: () => Promise<Record<string, unknown>>,
 *   captureKeptViews: () => Record<string, unknown>,
 *   restore: (carry: Record<string, unknown>, options?: {heavy?: Function|null}) => Promise<string[]>,
 * }}
 */
export function createViewCarry({ domains }) {
  if (typeof domains?.owner !== 'function') throw new TypeError('The view carry needs the state-domain registry.');
  return Object.freeze({
    /** Every carried domain's value now. */
    async capture() {
      const carry = {};
      for (const id of CARRIED_DOMAINS) carry[id] = await domains.owner(id).capture();
      return carry;
    },
    /** The kept views' domains' values now, at once (`KEPT_VIEW_DOMAINS`). */
    captureKeptViews() {
      const carry = {};
      for (const id of KEPT_VIEW_DOMAINS) {
        const value = domains.owner(id).capture();
        if (typeof value?.then === 'function') throw new TypeError(`The ${id} domain cannot be captured at once.`);
        carry[id] = value;
      }
      return carry;
    },
    /**
     * Give the carried values back to the dataset read again, in domain
     * order. Each domain is put back on its own: one the new reading cannot
     * take (a filter on a category none of its cells has) is skipped and
     * named, the rest are put back. Each owner is given the other values
     * carried (`target`) and `heavy` (an action's `ctx.heavy`: heavy work a
     * restore finds, the cells' totals of normalized values, is asked for).
     *
     * @param {Record<string, unknown>} carry
     * @param {{heavy?: ((estimate: Object) => Promise<void>)|null}} [options]
     * @returns {Promise<string[]>} the parts that could not be kept, and why
     */
    async restore(carry, { heavy = null } = {}) {
      const failures = [];
      const target = id => (Object.hasOwn(carry, id) ? carry[id] : undefined);
      for (const id of DOMAIN_IDS) {
        if (!Object.hasOwn(carry, id)) continue;
        try {
          await domains.owner(id).restore(carry[id], { signal: null, heavy, target });
        } catch (error) {
          failures.push(`${domainName(id).toLowerCase()}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return failures;
    },
  });
}
