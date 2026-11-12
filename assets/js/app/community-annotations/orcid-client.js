/**
 * Exact client for the public ORCID endpoints used by the identity UI.
 *
 * The public API is an external trust boundary: a response is read through
 * the app's one transport (`formats/io/byte-source.js` `fetchOnce` /
 * `withRetries`: a stall timeout from the measured link, never a total
 * deadline; ORCID's request budget; busy answers asked again), refused above
 * a byte ceiling, and parsed with duplicate-key rejection before its small UI
 * projection is validated.
 */

import {
  assertExactOptionalProfileText,
  assertExactOrcidId,
  parseOrcidExpandedSearch,
  parseOrcidPersonName,
} from './profile-identifiers.js';
import { parseExactJson } from './wire-contract.js';
import { throwIfAborted, requireSignalOrNull } from '../../utils/abort.js';
import {
  fetchOnce,
  isTransientAnswer,
  spreadOf,
  transientStatusError,
  withRetries,
} from '../../formats/io/byte-source.js';
import { ResponseClock } from '../../formats/io/link.js';
import { realmHosts } from '../../formats/io/hosts.js';

export const ORCID_RESPONSE_MAX_UTF8_BYTES = 256 * 1024;
const ORCID_EXPANDED_SEARCH_MAX_RESULTS = 8;

const ORCID_API_ORIGIN = 'https://pub.orcid.org';

/** The link to ORCID, measured across every request of this page. */
let orcidLink = null;

/** The transport ORCID requests go through: the page's fetch, the realm's book of hosts, one measured link. */
function defaultOrcidTransport() {
  orcidLink ??= new ResponseClock();
  return { fetch: (url, init) => globalThis.fetch(url, init), hosts: realmHosts, clock: orcidLink };
}

function createResponseError(message, code, cause = undefined) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * One ORCID JSON body: at most `ORCID_RESPONSE_MAX_UTF8_BYTES`, UTF-8, exact
 * JSON (duplicate keys refused).
 *
 * @param {Uint8Array} bytes
 * @param {string} label
 * @returns {any}
 */
export function decodeOrcidJson(bytes, label) {
  if (bytes.byteLength > ORCID_RESPONSE_MAX_UTF8_BYTES) {
    throw createResponseError(
      `${label} exceeds ${ORCID_RESPONSE_MAX_UTF8_BYTES} bytes`,
      'ORCID_RESPONSE_TOO_LARGE'
    );
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause) {
    throw createResponseError(`${label} is not valid UTF-8`, 'ORCID_RESPONSE_INVALID', cause);
  }
  try {
    if (!text) throw new Error('empty response body');
    return parseExactJson(text, { path: label });
  } catch (cause) {
    throw createResponseError(
      `${label} returned invalid JSON: ${cause?.message || cause}`,
      'ORCID_RESPONSE_INVALID',
      cause
    );
  }
}

async function fetchSuccessfulJson(url, { label, signal, transport = null }) {
  const ownerSignal = requireSignalOrNull(signal, 'ORCID request signal');
  throwIfAborted(ownerSignal);
  const { fetch: fetchImpl, hosts, clock } = transport ?? defaultOrcidTransport();
  const { response, bytes } = await withRetries(async () => {
    const answer = await fetchOnce(url, {
      method: 'GET',
      headers: { Accept: 'application/vnd.orcid+json' },
      cache: 'no-store',
      credentials: 'omit',
      mode: 'cors',
      referrerPolicy: 'no-referrer',
    }, { fetchImpl, signal: ownerSignal, clock, hosts, label });
    if (!answer.response.ok && isTransientAnswer(answer.response, answer.said)) {
      throw transientStatusError(answer.response, label, answer.said);
    }
    return answer;
  }, { signal: ownerSignal, clock, random: spreadOf(url) });
  throwIfAborted(ownerSignal);
  if (!response.ok || bytes === null) {
    throw new Error(`${label} failed (HTTP ${response.status})`);
  }
  return decodeOrcidJson(bytes, `${label} response`);
}

export async function fetchOrcidPerson(orcidId, { signal = null, transport = null } = {}) {
  const id = assertExactOrcidId(orcidId);
  const document = await fetchSuccessfulJson(
    `${ORCID_API_ORIGIN}/v3.0/${encodeURIComponent(id)}/person`,
    { label: 'ORCID lookup', signal, transport }
  );
  return {
    name: parseOrcidPersonName(document),
    orcid: id,
  };
}

export async function fetchOrcidExpandedSearch(
  query,
  { signal = null, transport = null } = {}
) {
  const exactQuery = assertExactOptionalProfileText(query, 'ORCID search query');
  if (!exactQuery) return [];
  const document = await fetchSuccessfulJson(
    (
      `${ORCID_API_ORIGIN}/v3.0/expanded-search/?q=` +
      `${encodeURIComponent(exactQuery)}` +
      `&rows=${ORCID_EXPANDED_SEARCH_MAX_RESULTS}`
    ),
    { label: 'ORCID search', signal, transport }
  );
  return parseOrcidExpandedSearch(document, {
    maximumResults: ORCID_EXPANDED_SEARCH_MAX_RESULTS,
  });
}
