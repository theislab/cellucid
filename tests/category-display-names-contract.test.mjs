/**
 * One display rule for a category with no name: an empty category is shown as `(empty)` and
 * one of white space alone as `(blank)`, quietly, and one with white space at
 * an end in quotes, wherever a category is
 * named (legend, hover card, menus, filters, figure legends, analysis
 * groups, agent reads); the value itself is unchanged, and a step naming the
 * category by what it is shown as finds it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { BLANK_CATEGORY_NAME, EMPTY_CATEGORY_NAME, categoryDisplayName, categoryLabel, isUnnamedCategory } from '../assets/js/app/actions/targets/names.js';
import { resolveCategory } from '../assets/js/app/actions/targets/fields.js';
import { formatCellValue } from '../assets/js/app/ui/modules/cell-info.js';

test('a category with no name is shown as (empty) or (blank); any other as its identity text', () => {
  assert.equal(categoryDisplayName(''), EMPTY_CATEGORY_NAME);
  assert.equal(categoryDisplayName('  '), BLANK_CATEGORY_NAME);
  assert.equal(categoryDisplayName('\t'), BLANK_CATEGORY_NAME);
  for (const value of ['T cell', 0, 2.5, true, false]) assert.equal(categoryDisplayName(value), categoryLabel(value));
  // White space at an end is shown, in quotes, so ' x ' is told from 'x'.
  assert.equal(categoryDisplayName(' x '), '" x "');
  assert.equal(isUnnamedCategory(''), true);
  assert.equal(isUnnamedCategory(' '), true);
  assert.equal(isUnnamedCategory('a'), false);
  assert.equal(isUnnamedCategory(0), false);
  // The identity is unchanged: actions, sessions and annotation keys still name it by itself.
  assert.equal(categoryLabel(''), '');
});

test('a step names a category with no name by what it is shown as, unless a category is named so', () => {
  const field = { key: 'tissue', categories: ['', ' ', 'lung'] };
  assert.equal(resolveCategory(field, '(empty)'), 0);
  assert.equal(resolveCategory(field, '(blank)'), 1);
  assert.equal(resolveCategory(field, ''), 0);
  assert.equal(resolveCategory({ key: 'k', categories: [' x ', 'x'] }, '" x "'), 0);
  assert.equal(resolveCategory({ key: 'k', categories: ['', '(empty)'] }, '(empty)'), 1);
  assert.throws(() => resolveCategory({ key: 'k', categories: ['lung'] }, 'liver'), /the categories are 'lung'|the categories are "lung"|lung/);
});

test('a missing value is "Missing" in the hover card, never NaN', () => {
  assert.equal(formatCellValue(Number.NaN), 'Missing');
});

test('every place that names a category to a person or an agent names it through categoryDisplayName', () => {
  const surfaces = [
    'app/ui/modules/legend/categorical-legend.js',
    'app/ui/modules/cell-info.js',
    'app/ui/modules/group-categories-dialog.js',
    'app/ui/modules/figure-export/components/legend-builder.js',
    'app/state/domains/filters.js',
    'app/state/managers/filter-manager.js',
    'app/state/managers/highlight-manager.js',
    'app/analysis/ui/analysis-types/field-groups.js',
    'app/analysis/ui/analysis-types/composition-ui.js',
    'app/analysis/ui/analysis-types/dotplot-ui.js',
    'app/reads/dataset.js',
    'app/reads/framing.js',
    'app/reads/vector-field.js',
    'app/ui/modules/highlight/annotation-cells.js',
    'app/ui/modules/highlight/highlight-actions.js',
  ];
  for (const file of surfaces) {
    const source = readFileSync(new URL(`../assets/js/${file}`, import.meta.url), 'utf8');
    assert.match(source, /categoryDisplayName\(/, file);
  }
});
