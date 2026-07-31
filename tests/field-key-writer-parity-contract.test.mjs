/**
 * The app must accept every field key the writers publish.
 *
 * A field key reaches StateValidator.validateFieldKey() from two directions:
 * the reader types one (rename, user-defined field), and a producer publishes
 * one in obs_manifest.json / var_manifest.json, which requireField() checks on
 * every overlay and rename path. The manifest reader accepts the producer's
 * key long before those paths run, so a key the writers allow and this
 * validator rejects loads fine and then throws the first time the reader
 * touches the field.
 *
 * The rule is therefore the writers' identity rule, character for character:
 * cellucid-python's _require_field_identities() and cellucid-r's
 * .require_field_identities() require a non-empty string, distinct on its
 * axis, with no leading or trailing whitespace and no character that has no
 * glyph. Nothing narrower, and nothing wider.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { StateValidator } from '../assets/js/app/utils/state-validator.js';

// Keys both writers publish without complaint. Each one is a name a real
// dataset carries.
const WRITER_ACCEPTED = [
  'A:B',
  'chr1:1000000-1000500', // an ATAC peak, the reason ':' cannot be banned
  'HLA-DRB1/2',
  'CD8+ T cell',
  'bad id!',
  'CON', // reserved as a filename, but payload names are integer indices
  'trailing.',
  'Épsilon',
  '细胞类型',
  'gene\u200Cname', // U+200C joins real text, so the writers allow it
  'a'.repeat(300), // the writers cap no identifier's length
];

// Keys both writers reject, because the stored value differs from the drawn
// one: a control character, a zero-width character, or edge whitespace.
const WRITER_REJECTED = [
  ['leading space', ' Liver'],
  ['trailing space', 'Liver '],
  ['trailing non-breaking space', 'Liver\u00A0'],
  ['ideographic space at the end', 'Liver\u3000'],
  ['tab inside', 'Li\u0009ver'],
  ['newline inside', 'Li\u000Aver'],
  ['C1 control inside', 'Li\u0085ver'],
  ['delete inside', 'Li\u007Fver'],
  ['zero width space inside', 'Li\u200Bver'],
  ['word joiner inside', 'Li\u2060ver'],
  ['byte order mark inside', 'Li\uFEFFver'],
];

test('every key the writers publish is accepted', () => {
  for (const key of WRITER_ACCEPTED) {
    assert.equal(
      StateValidator.validateFieldKey(key),
      true,
      `the writers publish ${JSON.stringify(key)} and the app rejected it`,
    );
  }
});

test('a colon is an ordinary character in a field key', () => {
  // This is the exact case that used to load and then throw: the manifest
  // reader accepted the gene, the overlay path rejected it.
  assert.equal(StateValidator.validateFieldKey('A:B'), true);
});

test('no length cap rejects a name a producer may publish', () => {
  assert.equal(StateValidator.validateFieldKey('g'.repeat(4096)), true);
});

test('every key the writers reject is rejected', () => {
  for (const [description, key] of WRITER_REJECTED) {
    assert.throws(
      () => StateValidator.validateFieldKey(key),
      /Field name/,
      `the writers reject ${description} and the app accepted it`,
    );
  }
});

test('a key that is not a non-empty string is rejected', () => {
  for (const key of ['', null, undefined, 0, 1, {}, [], Symbol('k')]) {
    assert.throws(
      () => StateValidator.validateFieldKey(key),
      /Field name must be a non-empty string/,
    );
  }
});

test('a rejected key is reported with the code point that caused it', () => {
  assert.throws(
    () => StateValidator.validateFieldKey('Li\u200Bver'),
    /zero-width character U\+200B/,
  );
  assert.throws(
    () => StateValidator.validateFieldKey('Li\u0007ver'),
    /control character U\+0007/,
  );
});
