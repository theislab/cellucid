/**
 * @fileoverview The state fingerprint: one digest of every state domain's
 * value. Two moments show the same state exactly when their fingerprints
 * agree, so it is what the round-trip tests compare (apply → undo →
 * fingerprint equal) and what tells a control that changed state without a
 * history step.
 *
 * Each domain's value is hashed by the value pool's content hash
 * (`app/history/value-pool.js` `hashValue`: canonical JSON, typed arrays by
 * their bytes, cached by identity), and the digest is the hash of the
 * per-domain hashes. The per-domain hashes are returned too, so a mismatch
 * names the domain that differs.
 *
 * @module app/state/domains/fingerprint
 */

import { DOMAIN_IDS } from '../../actions/domains.js';
import { hashValue } from '../../history/value-pool.js';

/**
 * Every domain's value, captured now, in domain order.
 *
 * @param {ReturnType<typeof import('../../actions/domains.js').createDomainRegistry>} domains
 * @returns {Promise<Record<string, unknown>>}
 */
export async function captureEveryDomain(domains) {
  const values = {};
  for (const id of DOMAIN_IDS) values[id] = await domains.owner(id).capture();
  return values;
}

/**
 * The fingerprint of `values` (every domain's value).
 *
 * @param {Record<string, unknown>} values
 * @returns {Promise<{digest: string, domains: Record<string, string>}>}
 */
export async function fingerprintOf(values) {
  const hashes = {};
  for (const id of DOMAIN_IDS) {
    if (!Object.hasOwn(values, id)) throw new RangeError(`A state fingerprint needs the "${id}" domain's value.`);
    hashes[id] = await hashValue(values[id]);
  }
  return { digest: await hashValue(hashes), domains: hashes };
}

/**
 * The fingerprint of the state shown now.
 *
 * @param {ReturnType<typeof import('../../actions/domains.js').createDomainRegistry>} domains
 * @returns {Promise<{digest: string, domains: Record<string, string>}>}
 */
export async function stateFingerprint(domains) {
  return fingerprintOf(await captureEveryDomain(domains));
}

/**
 * The domains whose hashes differ between two fingerprints, in domain order.
 *
 * @param {{domains: Record<string, string>}} a
 * @param {{domains: Record<string, string>}} b
 * @returns {string[]}
 */
export function differingDomains(a, b) {
  return DOMAIN_IDS.filter(id => a.domains[id] !== b.domains[id]);
}
