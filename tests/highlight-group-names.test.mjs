/**
 * A highlight group is named by what it holds, once: an annotation
 * selection by the categories of its cells or the range of their values
 * (`annotationGroupName`), the other tools by the tool; the list shows the
 * count beside the name, so no name carries one.
 *
 * On Suo, NK (Alt+click) and ILCP (Shift+Alt+click), confirmed, must not read
 * "Annotation (2 steps) (36,214 cells) (36,214)": the count twice, the content
 * nowhere, and "Create categorical" would make a category of that name.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { annotationGroupName } from '../assets/js/app/ui/modules/highlight/annotation-cells.js';

const categorical = (codes, categories) => ({ kind: 'category', key: 'cell_type', categories, codes });

test('an annotation selection on a categorical field is named by its categories, most cells first', () => {
  const field = categorical(Uint8Array.of(0, 1, 1, 2, 2, 2, 3, 4, 0xff), ['B', 'NK', 'ILCP', 'T', 'DC']);
  assert.equal(annotationGroupName(field, [1, 2]), 'NK');
  assert.equal(annotationGroupName(field, [0, 1, 2, 3, 4, 5]), 'ILCP + NK + B');
  assert.equal(annotationGroupName(field, [0, 1, 2, 3, 4, 5, 6, 7]), 'ILCP, NK, B +2 more');
  // Equal counts keep the categories' own order.
  assert.equal(annotationGroupName(field, [6, 7]), 'T + DC');
  // A cell without a category, or a field its gestures were not read on: no name from it.
  assert.equal(annotationGroupName(field, [0, 8]), null);
  assert.equal(annotationGroupName(null, [0]), null);
  assert.equal(annotationGroupName(field, []), null);
});

test('an annotation selection on a continuous field is named by its field and the range of its values', () => {
  const field = { kind: 'continuous', key: 'n_genes', values: Float32Array.of(120, 340.5, 200, Number.NaN) };
  assert.equal(annotationGroupName(field, [0, 1, 2]), 'n_genes 120 – 340.5');
  assert.equal(annotationGroupName(field, [2]), 'n_genes 200 – 200');
  assert.equal(annotationGroupName(field, [0, 3]), null, 'a value it cannot state names nothing');
});

test('no tool names a group by its count', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const tool of ['annotation', 'lasso', 'proximity', 'knn']) {
    const source = await readFile(new URL(`../assets/js/app/ui/modules/highlight/${tool}-selection.js`, import.meta.url), 'utf8');
    const labels = [...source.matchAll(/label: ([^\n]+),\n/g)].map(match => match[1]);
    assert.ok(labels.length > 0, `${tool} confirms a label`);
    for (const label of labels) assert.doesNotMatch(label, /formatCount|steps?\b/, `${tool}: ${label}`);
  }
});
