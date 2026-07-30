/**
 * Exact current public-profile identifier contracts.
 *
 * UI callers may display validation errors, but must not rewrite aliases such
 * as ORCID URLs, compact ORCID values, LinkedIn URLs, or @handles.
 */

const ORCID_ID = /^[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9X]$/;
const LINKEDIN_HANDLE = /^[a-z0-9-]{3,120}$/;
const PROFILE_NAME_MAX_CODEPOINTS = 120;

function exceedsCodePointLimit(value, maximum) {
  if (value.length <= maximum) return false;
  if (value.length > maximum * 2) return true;
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return true;
  }
  return false;
}

function assertRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function optionalExactString(
  value,
  label,
  maximumLength = PROFILE_NAME_MAX_CODEPOINTS
) {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'string' ||
    /^\s|\s$/.test(value) ||
    exceedsCodePointLimit(value, maximumLength)
  ) {
    throw new Error(
      `${label} must be null or an exact string of at most ` +
      `${maximumLength} characters`
    );
  }
  return value || null;
}

function joinOrcidName(parts, label) {
  if (parts.length === 0) return null;
  const name = parts.join(' ');
  if (exceedsCodePointLimit(name, PROFILE_NAME_MAX_CODEPOINTS)) {
    throw new Error(
      `${label} must be at most ${PROFILE_NAME_MAX_CODEPOINTS} characters`
    );
  }
  return name;
}

export function isExactOrcidId(value) {
  if (typeof value !== 'string' || !ORCID_ID.test(value)) return false;
  const compact = value.replaceAll('-', '');
  let total = 0;
  for (let index = 0; index < 15; index += 1) {
    total = (total + Number(compact[index])) * 2;
  }
  const result = (12 - (total % 11)) % 11;
  const expected = result === 10 ? 'X' : `${result}`;
  return compact[15] === expected;
}

export function assertExactOrcidId(value, { allowEmpty = false } = {}) {
  if (allowEmpty && value === '') return '';
  if (!isExactOrcidId(value)) {
    throw new Error('ORCID must be an exact checksum-valid iD such as 0000-0002-1825-0097');
  }
  return value;
}

export function assertExactLinkedInHandle(value, { allowEmpty = false } = {}) {
  if (allowEmpty && value === '') return '';
  if (typeof value !== 'string' || !LINKEDIN_HANDLE.test(value)) {
    throw new Error('LinkedIn must be an exact lowercase handle without @ or a URL');
  }
  return value;
}

export function assertExactOptionalProfileText(value, label, maximumLength) {
  if (
    typeof value !== 'string' ||
    /^\s|\s$/.test(value) ||
    exceedsCodePointLimit(value, maximumLength)
  ) {
    throw new Error(
      `${label} must be an exact string of at most ${maximumLength} characters`
    );
  }
  return value;
}

export function parseOrcidPersonName(document) {
  const root = assertRecord(document, 'ORCID person response');
  if (root.name === null) return null;
  const name = assertRecord(root.name, 'ORCID person response.name');
  const givenNode = name['given-names'];
  const familyNode = name['family-name'];
  const given =
    givenNode === null
      ? null
      : optionalExactString(
          assertRecord(givenNode, 'ORCID person response.name.given-names').value,
          'ORCID person response.name.given-names.value'
        );
  const family =
    familyNode === null
      ? null
      : optionalExactString(
          assertRecord(familyNode, 'ORCID person response.name.family-name').value,
          'ORCID person response.name.family-name.value'
        );
  const parts = [given, family].filter((part) => part !== null);
  return joinOrcidName(parts, 'ORCID person response name');
}

export function parseOrcidExpandedSearch(document, { maximumResults = 8 } = {}) {
  const root = assertRecord(document, 'ORCID expanded-search response');
  const results = root['expanded-result'];
  if (!Array.isArray(results)) {
    throw new Error('ORCID expanded-search response.expanded-result must be an array');
  }
  if (results.length > maximumResults) {
    throw new Error(
      `ORCID expanded-search returned more than the requested ${maximumResults} results`
    );
  }
  const seen = new Set();
  return results.map((entry, index) => {
    const record = assertRecord(
      entry,
      `ORCID expanded-search response.expanded-result[${index}]`
    );
    const orcid = assertExactOrcidId(record['orcid-id']);
    if (seen.has(orcid)) {
      throw new Error(`ORCID expanded-search returned duplicate iD ${orcid}`);
    }
    seen.add(orcid);
    const given = optionalExactString(
      record['given-names'],
      `ORCID expanded-search response.expanded-result[${index}].given-names`
    );
    const family = optionalExactString(
      record['family-names'],
      `ORCID expanded-search response.expanded-result[${index}].family-names`
    );
    const parts = [given, family].filter((part) => part !== null);
    return {
      orcid,
      name: joinOrcidName(
        parts,
        `ORCID expanded-search response.expanded-result[${index}] name`
      ),
    };
  });
}
