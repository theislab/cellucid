/**
 * What a message says of a link, built on its public form
 * (`link-credentials.js` `publicLink`): text with every web address in it
 * made public (`textWithPublicLinks`), and whether a link's public form
 * leaves something of it out (`linkLeavesOutParts`).
 *
 * Kept apart from `link-credentials.js` on purpose. That module says what a
 * link *is* (`linkIdentity`), which is what a directory kept in this browser
 * is filed under, so the code fingerprints of kept data cover it
 * (`scripts/kept-code-fingerprints.mjs`): a change to its code makes every
 * browser make again what it kept. How a message words a link is not what
 * is kept, and changes here change no fingerprint.
 *
 * @module data/sources/link-text
 */

import { publicLink } from './link-credentials.js';

/** A link as a URL, or null when it is none. */
function parseLink(href) {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

/** A web address inside text, up to whitespace or a quote or bracket. */
const LINK_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;

/** Punctuation that ends a sentence rather than the address before it. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

/**
 * Text with every web address in it in its public form (`publicLink`): the
 * one rule for what a message, an error, a notification or the console says
 * about a link. An anchor that holds no `=` (a documentation section) is
 * kept; any other fragment is not.
 *
 * @param {string} text
 * @returns {string}
 */
export function textWithPublicLinks(text) {
  if (typeof text !== 'string') return text;
  return text.replace(LINK_IN_TEXT, found => {
    const trailing = TRAILING_PUNCTUATION.exec(found)?.[0] ?? '';
    const href = found.slice(0, found.length - trailing.length);
    const url = parseLink(href);
    if (url === null) return found;
    const anchor = url.hash !== '' && !url.hash.includes('=') ? url.hash : '';
    const shown = `${publicLink(href)}${anchor}`;
    // A link that loses nothing is said as it was written: its parsed
    // spelling would change what the person typed (`http://host:8765`
    // said as `http://host:8765/`, an upper-case host lowered).
    return `${shown === url.href ? href : shown}${trailing}`;
  });
}

/**
 * Whether a link's public form (`publicLink`) leaves something out of it: a
 * user name or password, a fragment, a parameter off the allow-list. Its
 * spelling alone (a trailing slash, the case of its host) is not.
 *
 * @param {string} href
 * @returns {boolean}
 */
export function linkLeavesOutParts(href) {
  const url = parseLink(href);
  return url !== null && publicLink(href) !== url.href;
}
