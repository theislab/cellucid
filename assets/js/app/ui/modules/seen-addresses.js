/**
 * @fileoverview The addresses the person has seen in this tab: what an agent
 * may make the tab request without asking them.
 *
 * An agent reads text others wrote (a category label, a dataset's
 * description, a community annotation, a tool result). Misled by it, it could
 * open "https://host/?q=<what it read>", and the request alone would carry
 * what it read to any host. So an action that fetches an address its
 * parameters name (`opensLinks`: `dataset.open` with a link, an accession or
 * a server) asks the person first (`ctx.confirmLink`, the permission kind
 * `unseen-link`) unless the address is one they have seen here:
 *
 * - **typed or pasted** into the address bar (Session › Open data) and
 *   submitted, or into the agent chat's message they sent (`noteSeenAddress`,
 *   `noteSeenAddressesIn`);
 * - **open now** or **listed** in My datasets (`isSeenAddress`'s `shown`:
 *   the opening's own record, which a link the person clicked to open this
 *   page is too).
 *
 * Addresses are compared exactly, in one spelling (`addressKeyOf`: a server
 * by its address, a web address by its normalized href, anything else as
 * typed): another query, path or host is another address. What is noted
 * lives as long as the page (this tab), never stored.
 *
 * @module ui/modules/seen-addresses
 */

import { routeAddress } from './address-routing.js';

/** Every address noted as seen in this tab, by `addressKeyOf`. */
const seen = new Set();

/** An address a person writes: `https://…`, `localhost:8765`, `GSE123456`, `hf:user/repo` (no spaces). */
const WEB_ADDRESS = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/**
 * The one spelling an address is compared in, or null when the text names
 * nothing the address bar opens: a server by its address
 * (`http://localhost:8765`), a web address by its href (scheme and host in
 * lower case, the default port dropped), anything else (an accession, a
 * provider's short form) as written, trimmed.
 * @param {string} text
 * @param {{registry?: object}} [options]
 * @returns {string|null}
 */
function addressKeyOf(text, options = {}) {
  if (typeof text !== 'string') return null;
  const route = routeAddress(text, options);
  if (route.kind === 'invalid') return null;
  const value = route.kind === 'server' ? route.url : route.value;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    // Not a web address: kept as written.
  }
  return value;
}

/**
 * Note an address the person typed or pasted and submitted (the address
 * bar).
 * @param {string} text
 */
export function noteSeenAddress(text) {
  const key = addressKeyOf(text);
  if (key !== null) seen.add(key);
}

/**
 * Note every address in a message the person wrote (the chat): each web
 * address in it, and each word that the address bar would open (an
 * accession, `localhost:8765`), with the punctuation around it left off.
 * @param {string} text
 */
export function noteSeenAddressesIn(text) {
  if (typeof text !== 'string') return;
  for (const match of text.matchAll(WEB_ADDRESS)) noteSeenAddress(match[0].replace(/[.,;:!?)\]}>]+$/, ''));
  for (const word of text.split(/\s+/)) {
    const bare = word.replace(/^[([{<"'`]+/, '').replace(/[.,;:!?)\]}>"'`]+$/, '');
    if (bare.length > 0) noteSeenAddress(bare);
  }
}

/**
 * Whether `text` names an address the person has seen in this tab: noted
 * (typed or pasted), or one of `shown` (the dataset open now, My datasets'
 * links and servers).
 * @param {string} text
 * @param {Iterable<string>} [shown]
 */
export function isSeenAddress(text, shown = []) {
  const key = addressKeyOf(text);
  if (key === null) return false;
  if (seen.has(key)) return true;
  for (const each of shown) {
    if (addressKeyOf(each) === key) return true;
  }
  return false;
}

/** Forget what was noted (a test's fresh page). */
export function forgetSeenAddresses() {
  seen.clear();
}
