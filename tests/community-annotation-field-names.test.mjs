// Community annotation keys a field and its categories on the dataset's
// names, never on a local rename: a rename, a history jump, a session or the autosave never
// moves a vote or a suggestion in the shared repository.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  annotationCategories, annotationFieldKey, fieldByAnnotationKey, hasLocalNames,
} from '../assets/js/app/community-annotations/field-names.js';

test('a renamed field and category are keyed on the dataset\'s names', () => {
  const plain = { key: 'cluster', categories: ['alpha', 'beta'] };
  assert.equal(annotationFieldKey(plain), 'cluster');
  assert.deepEqual(annotationCategories(plain), plain.categories);
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
