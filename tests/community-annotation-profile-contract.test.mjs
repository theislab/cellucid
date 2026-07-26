import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertExactLinkedInHandle,
  assertExactOptionalProfileText,
  assertExactOrcidId,
  isExactOrcidId,
  parseOrcidExpandedSearch,
  parseOrcidPersonName,
} from '../assets/js/app/community-annotations/profile-identifiers.js';


test('profile identifiers accept only their exact current representation', () => {
  assert.equal(assertExactOrcidId('0000-0002-1825-0097'), '0000-0002-1825-0097');
  assert.equal(isExactOrcidId('0000-0002-1825-0097'), true);
  assert.equal(assertExactLinkedInHandle('researcher-42'), 'researcher-42');
  assert.equal(assertExactOptionalProfileText('Alice Smith', 'Name', 120), 'Alice Smith');

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
  ]) {
    assert.throws(() => assertExactLinkedInHandle(alias), /LinkedIn/);
  }
  assert.throws(
    () => assertExactOptionalProfileText(' Alice Smith', 'Name', 120),
    /exact string/
  );
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
  assert.throws(
    () => parseOrcidPersonName({
      name: {
        givenNames: { value: 'Alias' },
        familyName: { value: 'Fields' },
      },
    }),
    /given-names/
  );
});


test('ORCID expanded search rejects aliases, duplicates, and excess results', () => {
  assert.deepEqual(
    parseOrcidExpandedSearch({
      'expanded-result': [{
        'orcid-id': '0000-0002-1825-0097',
        'given-names': 'Alice',
        'family-names': 'Smith',
      }],
    }),
    [{
      orcid: '0000-0002-1825-0097',
      name: 'Alice Smith',
    }]
  );
  assert.throws(
    () => parseOrcidExpandedSearch({
      'expanded-result': [{
        orcidId: '0000-0002-1825-0097',
        givenNames: 'Alias',
        familyNames: 'Fields',
      }],
    }),
    /ORCID/
  );
  assert.throws(
    () => parseOrcidExpandedSearch({
      'expanded-result': Array.from({ length: 9 }, () => ({
        'orcid-id': '0000-0002-1825-0097',
        'given-names': null,
        'family-names': null,
      })),
    }),
    /more than the requested 8/
  );
  assert.throws(
    () => parseOrcidExpandedSearch({
      'expanded-result': [
        {
          'orcid-id': '0000-0002-1825-0097',
          'given-names': null,
          'family-names': null,
        },
        {
          'orcid-id': '0000-0002-1825-0097',
          'given-names': null,
          'family-names': null,
        },
      ],
    }),
    /duplicate/
  );
});
