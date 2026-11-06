import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertExactLinkedInHandle,
  assertExactOptionalProfileText,
  assertExactOrcidId,
  parseOrcidExpandedSearch,
  parseOrcidPersonName,
} from '../assets/js/app/community-annotations/profile-identifiers.js';
import {
  isExactLinkedInHandle,
  isExactOrcidId,
} from '../assets/js/app/community-annotations/wire-contract.js';

const ROWS = { maximumResults: 8 };
const JOSIAH = {
  'orcid-id': '0000-0002-1825-0097',
  'given-names': 'Josiah',
  'family-names': 'Carberry',
};


test('profile identifiers accept only their exact current representation', () => {
  assert.equal(assertExactOrcidId('0000-0002-1825-0097'), '0000-0002-1825-0097');
  assert.equal(isExactOrcidId('0000-0002-1825-0097'), true);
  assert.equal(isExactOrcidId('0000-0002-1694-233X'), true);
  assert.equal(assertExactLinkedInHandle('researcher-42'), 'researcher-42');
  assert.equal(assertExactOptionalProfileText('Alice Smith', 'Name'), 'Alice Smith');
  assert.equal(assertExactOptionalProfileText('', 'Name'), '');

  for (const alias of [
    'https://orcid.org/0000-0002-1825-0097',
    '0000000218250097',
    ' 0000-0002-1825-0097',
    '0000-0002-1825-0098',
  ]) {
    assert.throws(() => assertExactOrcidId(alias), /ORCID/);
  }
  for (const alias of [
    '@researcher-42',
    'Researcher-42',
    'https://www.linkedin.com/in/researcher-42',
    ' researcher-42',
    'ab',
  ]) {
    assert.throws(() => assertExactLinkedInHandle(alias), /LinkedIn/);
  }
  // The contract's whitespace class, not only ECMAScript's \s: U+0085 and
  // U+001C-U+001F are whitespace in the repository validator too.
  for (const untidy of [' Alice Smith', 'Alice Smith\n', 'Alice\u0085', '\u001cAlice', '\ufeffAlice', '   ']) {
    assert.throws(
      () => assertExactOptionalProfileText(untidy, 'Name'),
      /Name must be text without leading or trailing whitespace/
    );
  }
});

test('profile text and LinkedIn handles have no length limit', () => {
  // The only size bound is the 1,000,000-byte user file.
  assert.equal(assertExactOptionalProfileText('🧬'.repeat(5_000), 'Name'), '🧬'.repeat(5_000));
  assert.equal(assertExactLinkedInHandle('a'.repeat(500)), 'a'.repeat(500));
  assert.equal(isExactLinkedInHandle('abc'), true);
  assert.equal(isExactLinkedInHandle('a'.repeat(10_000)), true);
});


test('ORCID person lookup uses only the documented current name fields', () => {
  assert.equal(
    parseOrcidPersonName({
      name: {
        'given-names': { value: 'Alice' },
        'family-name': { value: 'Smith' },
      },
    }),
    'Alice Smith'
  );
  assert.equal(parseOrcidPersonName({ name: null }), null);
  // Alias field names are never read.
  assert.equal(
    parseOrcidPersonName({
      name: {
        givenNames: { value: 'Alias' },
        familyName: { value: 'Fields' },
      },
    }),
    null
  );
  assert.throws(() => parseOrcidPersonName(null), /ORCID person response/);
});

test('a direct ORCID lookup of an untidy record still names the person', () => {
  // ORCID names are human-entered: edge whitespace is removed, a long name is
  // kept whole, a malformed part counts as missing; none fails the lookup.
  assert.equal(
    parseOrcidPersonName({
      name: { 'given-names': { value: ' Laure' }, 'family-name': { value: 'Haak ' } },
    }),
    'Laure Haak'
  );
  assert.equal(
    parseOrcidPersonName({
      name: { 'given-names': { value: 'A'.repeat(80) }, 'family-name': { value: 'B'.repeat(60) } },
    }),
    `${'A'.repeat(80)} ${'B'.repeat(60)}`
  );
  assert.equal(
    parseOrcidPersonName({
      name: { 'given-names': { value: 'Laure\u0085' }, 'family-name': { value: 7 } },
    }),
    'Laure'
  );
  assert.equal(
    parseOrcidPersonName({
      name: { 'given-names': { value: '   ' }, 'family-name': null },
    }),
    null
  );
  assert.equal(parseOrcidPersonName({ name: 'not a record' }), null);
});


test('ORCID expanded search reads only documented fields and the requested rows', () => {
  assert.deepEqual(
    parseOrcidExpandedSearch({
      'expanded-result': [{
        'orcid-id': '0000-0002-1825-0097',
        'given-names': 'Alice',
        'family-names': 'Smith',
      }],
    }, ROWS),
    [{
      orcid: '0000-0002-1825-0097',
      name: 'Alice Smith',
    }]
  );
  // A record named by alias fields has no exact iD: it is left out.
  assert.deepEqual(
    parseOrcidExpandedSearch({
      'expanded-result': [{
        orcidId: '0000-0002-1825-0097',
        givenNames: 'Alias',
        familyNames: 'Fields',
      }],
    }, ROWS),
    []
  );
  assert.throws(
    () => parseOrcidExpandedSearch({
      'expanded-result': Array.from({ length: 9 }, () => ({ ...JOSIAH })),
    }, ROWS),
    /more than the requested 8/
  );
  // The caller states the rows it asked for; there is no default.
  assert.throws(() => parseOrcidExpandedSearch({ 'expanded-result': [] }, {}), /maximumResults/);
  assert.throws(() => parseOrcidExpandedSearch({}, ROWS), /expanded-result must be an array or null/);
  assert.throws(() => parseOrcidExpandedSearch({ 'expanded-result': {} }, ROWS), /expanded-result/);
});

test('one untidy or malformed ORCID record never empties a search', () => {
  // Repro (CA-B audit R06): each of these used to throw for the whole search.
  const laure = (given, family = 'Haak') => ({
    'orcid-id': '0000-0001-5109-3700',
    'given-names': given,
    'family-names': family,
  });
  assert.deepEqual(
    parseOrcidExpandedSearch({ 'expanded-result': [JOSIAH, laure('Laure ')], 'num-found': 2 }, ROWS),
    [
      { orcid: '0000-0002-1825-0097', name: 'Josiah Carberry' },
      { orcid: '0000-0001-5109-3700', name: 'Laure Haak' },
    ]
  );
  assert.deepEqual(
    parseOrcidExpandedSearch({ 'expanded-result': [JOSIAH, laure('A'.repeat(80), 'B'.repeat(60))] }, ROWS)[1],
    { orcid: '0000-0001-5109-3700', name: `${'A'.repeat(80)} ${'B'.repeat(60)}` }
  );
  // A record without an exact iD, a repeated iD and a non-record are left
  // out; a name part that is not text counts as missing.
  assert.deepEqual(
    parseOrcidExpandedSearch({
      'expanded-result': [
        { ...JOSIAH, 'orcid-id': '0000-0002-1825-0098' },
        { ...JOSIAH, 'orcid-id': null },
        null,
        'record',
        JOSIAH,
        { ...JOSIAH, 'given-names': 'Duplicate' },
        laure(42, ['Haak']),
        laure('\u3000', ' '),
      ],
    }, ROWS),
    [
      { orcid: '0000-0002-1825-0097', name: 'Josiah Carberry' },
      { orcid: '0000-0001-5109-3700', name: null },
    ]
  );
});

test('an ORCID search without matches answers expanded-result null', () => {
  assert.deepEqual(parseOrcidExpandedSearch({ 'expanded-result': null, 'num-found': 0 }, ROWS), []);
});
