/**
 * Exact current public-profile identifier contracts.
 *
 * UI callers may display validation errors, but must not rewrite aliases such
 * as ORCID URLs, compact ORCID values, LinkedIn URLs, or @handles. The rules
 * themselves are the annotation wire contract's (`wire-contract.js`); this
 * module words them for people and reads ORCID's public API.
 *
 * ORCID records are human-entered public data. The ORCID parsers read each
 * record on its own: a search leaves out a record without an exact iD (and a
 * repeat of one already listed), a name part that is not text counts as
 * missing, and a name's edge whitespace is removed. One untidy record never
 * empties a search, and an untidy name never fails a lookup.
 */

import { isObjectRecord, requireObjectRecord } from '../../utils/exact-record.js';
import { formatCountOf } from '../../utils/format-units.js';
import {
  ANNOTATION_WHITESPACE_CLASS,
  isAnnotationExactNonblank,
  isExactLinkedInHandle,
  isExactOrcidId,
} from './wire-contract.js';

const WHITESPACE = new RegExp(ANNOTATION_WHITESPACE_CLASS);

export function assertExactOrcidId(value, { allowEmpty = false } = {}) {
  if (allowEmpty && value === '') return '';
  if (!isExactOrcidId(value)) {
    throw new Error('ORCID must be an exact checksum-valid iD such as 0000-0002-1825-0097');
  }
  return value;
}

export function assertExactLinkedInHandle(value, { allowEmpty = false } = {}) {
  if (allowEmpty && value === '') return '';
  if (!isExactLinkedInHandle(value)) {
    throw new Error('LinkedIn must be an exact lowercase handle without @ or a URL');
  }
  return value;
}

/**
 * Optional profile text: empty, or exact nonblank text (no leading or
 * trailing whitespace). It is never trimmed for the caller.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
export function assertExactOptionalProfileText(value, label) {
  if (typeof value !== 'string' || (value !== '' && !isAnnotationExactNonblank(value))) {
    throw new Error(`${label} must be text without leading or trailing whitespace`);
  }
  return value;
}

/** One part of an ORCID name, without its edge whitespace; null when none. */
function orcidNamePart(value) {
  if (typeof value !== 'string') return null;
  let start = 0;
  let end = value.length;
  while (start < end && WHITESPACE.test(value[start])) start += 1;
  while (end > start && WHITESPACE.test(value[end - 1])) end -= 1;
  return start === end ? null : value.slice(start, end);
}

function joinOrcidName(given, family) {
  const parts = [orcidNamePart(given), orcidNamePart(family)].filter(
    (part) => part !== null
  );
  return parts.length === 0 ? null : parts.join(' ');
}

/**
 * The name of an ORCID person record (`GET /v3.0/<iD>/person`), or null when
 * the record shows none.
 *
 * @param {unknown} document
 * @returns {string|null}
 */
export function parseOrcidPersonName(document) {
  const root = requireObjectRecord(document, 'ORCID person response');
  const name = root.name;
  if (!isObjectRecord(name)) return null;
  const given = name['given-names'];
  const family = name['family-name'];
  return joinOrcidName(
    isObjectRecord(given) ? given.value : null,
    isObjectRecord(family) ? family.value : null
  );
}

/**
 * The records of an ORCID expanded search (`GET /v3.0/expanded-search/`).
 * ORCID answers a search without matches with `"expanded-result": null`.
 *
 * @param {unknown} document
 * @param {{maximumResults: number}} options - The `rows` the search asked for
 * @returns {{orcid: string, name: string|null}[]}
 */
export function parseOrcidExpandedSearch(document, { maximumResults }) {
  if (!Number.isSafeInteger(maximumResults) || maximumResults < 1) {
    throw new TypeError('ORCID expanded-search maximumResults must be the requested row count');
  }
  const root = requireObjectRecord(document, 'ORCID expanded-search response');
  const results = root['expanded-result'];
  if (results === null) return [];
  if (!Array.isArray(results)) {
    throw new Error('ORCID expanded-search response.expanded-result must be an array or null');
  }
  if (results.length > maximumResults) {
    throw new Error(
      `ORCID expanded-search returned more than the requested ${formatCountOf(maximumResults, 'result')}`
    );
  }
  const seen = new Set();
  const records = [];
  for (const entry of results) {
    if (!isObjectRecord(entry)) continue;
    const orcid = entry['orcid-id'];
    if (!isExactOrcidId(orcid) || seen.has(orcid)) continue;
    seen.add(orcid);
    records.push({
      orcid,
      name: joinOrcidName(entry['given-names'], entry['family-names']),
    });
  }
  return records;
}
