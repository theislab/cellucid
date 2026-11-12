/**
 * L18-8 (live pass 5): coloring by a Loom `ClusterID` (integer categories, as
 * velocyto writes it) failed — "Could not load the field: [CommunityAnnotationSession]
 * category at index 0 must be nonblank" — in every dataset, connected to a
 * repository or not: the legend handed the annotation session the numbers.
 * The repository keys categories by their text, as the legend shows them; a
 * field whose categories it cannot key is not open to it and is still shown.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { annotationCategories, annotationKeyable, hasLocalNames } from '../assets/js/app/community-annotations/field-names.js';
import { CommunityAnnotationSession } from '../assets/js/app/community-annotations/session.js';

test('categories are keyed by their text: numbers and booleans as the legend shows them', () => {
  assert.deepEqual(annotationCategories({ key: 'ClusterID', categories: [0, 1, 2, 3] }), ['0', '1', '2', '3']);
  assert.deepEqual(annotationCategories({ key: 'flag', categories: [true, false] }), ['true', 'false']);
  // A rename keeps the dataset's labels, as text.
  assert.deepEqual(annotationCategories({ key: 'c', categories: ['early', 'one'], _originalCategories: [0, 1] }), ['0', '1']);
  assert.equal(hasLocalNames({ key: 'ClusterID', categories: [0, 1] }), false);
  assert.equal(hasLocalNames({ key: 'c', categories: ['early', 1], _originalCategories: [0, 1] }), true);
});

test('the session takes them; what it cannot key is said before it is asked', () => {
  const session = new CommunityAnnotationSession();
  assert.equal(session.setFieldCategories('ClusterID', annotationCategories({ key: 'ClusterID', categories: [0, 1, 2] })), true);
  assert.equal(annotationKeyable(['0', '1']), true);
  for (const bad of [['', 'a'], [' a', 'b'], ['a', 'a']]) {
    assert.equal(annotationKeyable(bad), false, JSON.stringify(bad));
    assert.throws(() => session.setFieldCategories('f', bad));
  }
});

test('every caller of the session keys through annotationCategories or checks first', async () => {
  const { readFile } = await import('node:fs/promises');
  const legend = await readFile(new URL('../assets/js/app/ui/modules/legend/categorical-legend.js', import.meta.url), 'utf8');
  assert.match(legend, /const keyable = annotationKeyable\(repositoryCategories\);\n\s*if \(keyable\) annotationSession\.setFieldCategories\(fieldKey, repositoryCategories\);/);
  const consensus = await readFile(new URL('../assets/js/app/ui/modules/community-annotation/consensus-column.js', import.meta.url), 'utf8');
  assert.doesNotMatch(consensus, /catch \{\s*\/\/ Categories the session cannot key/);
});
