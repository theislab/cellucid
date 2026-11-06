// Community annotation keys a field and its categories on the dataset's
// names, never on a local rename (B3 of the community annotation UI audit,
// 2026-11-05): a rename, a history jump, a session or the autosave never
// moves a vote or a suggestion in the shared repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  annotationCategories, annotationFieldKey, fieldByAnnotationKey, hasLocalNames,
} from '../assets/js/app/community-annotations/field-names.js';

test('a renamed field and category are keyed on the dataset\'s names', () => {
  const plain = { key: 'cluster', categories: ['alpha', 'beta'] };
  assert.equal(annotationFieldKey(plain), 'cluster');
  assert.equal(annotationCategories(plain), plain.categories);
  assert.equal(hasLocalNames(plain), false);

  const renamed = { key: 'Cell type', _originalKey: 'cell_type', categories: ['Alpha renamed', 'beta'], _originalCategories: ['alpha', 'beta'] };
  assert.equal(annotationFieldKey(renamed), 'cell_type');
  assert.deepEqual(annotationCategories(renamed), ['alpha', 'beta']);
  assert.equal(hasLocalNames(renamed), true);
  assert.equal(hasLocalNames({ key: 'x', categories: ['a'], _originalCategories: ['a'] }), false);

  const state = { getFields: () => [{ key: 'gone', _isDeleted: true }, plain, renamed] };
  assert.deepEqual(fieldByAnnotationKey(state, 'cell_type'), { field: renamed, index: 2 });
  assert.equal(fieldByAnnotationKey(state, 'Cell type'), null, 'a local name is no key in the repository');
});

const SOURCES = [
  'ui/modules/legend/categorical-legend.js',
  'ui/modules/community-annotation-voting-modal.js',
  'ui/modules/community-annotation-controls.js',
  'ui/modules/field-selector.js',
  'ui/modules/community-annotation/controls-panel.js',
];

test('every place that reads or writes community annotation keys on the dataset\'s names', () => {
  for (const file of SOURCES) {
    const source = readFileSync(new URL(`../assets/js/app/${file}`, import.meta.url), 'utf8');
    // The session is never handed a shown key or shown categories.
    assert.doesNotMatch(source, /setFieldCategories\(\s*field\.key/, `${file} registers a shown key`);
    assert.doesNotMatch(source, /setFieldCategories\([^)]*field\.categories/, `${file} registers shown categories`);
    assert.doesNotMatch(source, /(isFieldAnnotated|isFieldClosed|setFieldAnnotated)['"]?,?\s*\(?\s*field\.key\b/, `${file} reads a flag by a shown key`);
    assert.doesNotMatch(source, /readAnnotationFlag\(\s*'[A-Za-z]+',\s*field\.key\s*\)/, `${file} locks by a shown key`);
  }
});
