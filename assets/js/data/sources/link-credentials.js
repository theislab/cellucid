/**
 * A link's two forms: what it is read with, and what it may be shown or kept
 * as. The read target (the link as pasted, with any signature, token or
 * access key) is held in memory and handed to the byte layer only; the page
 * address keeps it so a reload opens the same file. Everywhere else a link
 * goes (sessions, Share links, badges and embeds, figure metadata, the
 * dataset card, notifications, the console, the notebook kernel) it goes as
 * its public form, `publicLink`.
 *
 * The public form keeps only what names a file: the address, and query
 * parameters on an allow-list of those that name a file or its version and
 * grant nothing. Everything else is left out: a user name and password, the
 * fragment, and every other parameter, known credential or not.
 *
 * What a link *is* (a dataset id, a kept store's key, the page's memory of
 * bytes, a served store's key) is `linkIdentity`: the public form, plus a
 * short digest of the parameters it left out that are not known credentials,
 * so two files that differ only by such a parameter (`download?uuid=a`,
 * `download?uuid=b`) stay two datasets. Known credential and signing
 * parameters are never part of either form, nor of the digest, so a link
 * signed again names the same file.
 *
 * @module data/sources/link-credentials
 */

import { sha256HexWithoutWebCrypto } from '../../app/utils/sha256.js';

/**
 * Query parameters that only name a file or its version and grant nothing
 * (compared without case): an S3 object version, a Cloud Storage
 * generation or `alt=media`, download switches, and the usual names of a
 * file, its path, id, revision or version on a download endpoint.
 */
const NAMING_PARAMETERS = new Set([
  'versionid', 'generation', 'alt', 'download', 'dl', 'raw', 'format',
  'ref', 'revision', 'version', 'v', 'path', 'file', 'filename', 'name', 'id',
]);

/**
 * Query parameters that sign a link or carry a credential: AWS signatures
 * (V2 and V4), Google Cloud Storage signatures (V2 and V4) and API keys,
 * Azure shared access signatures, CloudFront and Akamai tokens, bearer,
 * OAuth and JSON Web Tokens, share keys (Dropbox `rlkey`, Google Drive
 * `resourcekey`, OSF `view_only`), passwords and client secrets. Left out
 * of both forms, and of the identity's digest.
 */
const CREDENTIAL_PARAMETER = /^(x-amz-.*|x-goog-.*|awsaccesskeyid|googleaccessid|signature|sig|se|sp|sv|sr|st|si|spr|srt|ss|skoid|sktid|skt|ske|sks|skv|ses|sdd|key-pair-id|policy|expires|hdnts|__token__|token|access_token|id_token|refresh_token|auth|authorization|api_key|apikey|key|rlkey|resourcekey|view_only|password|passwd|pwd|jwt|client_secret|access_key|secret_key|secret|security-token)$/i;

/** Hex characters of the digest an identity carries for left-out parameters. */
const IDENTITY_DIGEST_LENGTH = 16;

function parseLink(href) {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

/**
 * The public form of a link: its address with only the allow-listed query
 * parameters, without a user name, password or fragment (itself when it is
 * no URL).
 *
 * @param {string} href
 * @returns {string}
 */
export function publicLink(href) {
  const url = parseLink(href);
  if (url === null) return href;
  url.username = '';
  url.password = '';
  url.hash = '';
  for (const name of new Set(url.searchParams.keys())) {
    if (!NAMING_PARAMETERS.has(name.toLowerCase())) url.searchParams.delete(name);
  }
  return url.href;
}

/**
 * What a link is: its public form, and, when it carried parameters that
 * are neither allow-listed nor known credentials, a fragment holding a
 * digest of them (in any order), so they still tell files apart without
 * being kept (itself when it is no URL).
 *
 * @param {string} href
 * @returns {string}
 */
export function linkIdentity(href) {
  const url = parseLink(href);
  if (url === null) return href;
  const other = [...url.searchParams]
    .filter(([name]) => !NAMING_PARAMETERS.has(name.toLowerCase()) && !CREDENTIAL_PARAMETER.test(name))
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  const address = publicLink(href);
  if (other.length === 0) return address;
  const digest = sha256HexWithoutWebCrypto(new TextEncoder().encode(JSON.stringify(other)));
  return `${address}#${digest.slice(0, IDENTITY_DIGEST_LENGTH)}`;
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
