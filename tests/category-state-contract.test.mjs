/**
 * Per-category state: a categorical field's colors and visibility are
 * typed arrays never written in place (`app/utils/category-state.js`), so
 * kept views share them until one changes them, and each array (and each
 * category list) is checked once, not on every action.
 */
import { blocksRun } from './helpers/block-counts.mjs';

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DataStateColorMethods } from '../assets/js/app/state/managers/color-manager.js';
import { viewContextCoreMethods } from '../assets/js/app/state/managers/view-context-core.js';
import {
  carriedCategoryState,
  categoryCssAt,
  categoryRgbAt,
  categoryShownAt,
  defaultCategoryColors,
  fieldCategoryCss,
  hiddenCategoryBytes,
  hiddenCategoryCount,
  withCategoriesVisible,
  withCategoryChanges,
  withCategoryColor,
  withCategoryVisibility,
} from '../assets/js/app/utils/category-state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function categoryField(count) {
  return { key: 'clone', kind: 'category', categories: Array.from({ length: count }, (_, i) => `clone_${i}`), codes: new Uint32Array(4) };
}

test('a kept view shares its source\'s category arrays until either changes one, which is then its own', () => {
  const color = Object.create(DataStateColorMethods.prototype);
  const field = categoryField(5);
  color.ensureCategoryMetadata(field);
  const kept = viewContextCoreMethods._cloneFieldState.call({ _fieldCountMemo: null }, field);
  assert.equal(kept._categoryColors, field._categoryColors);
  assert.equal(kept._categoryVisible, field._categoryVisible);
  const before = field._categoryVisible;
  withCategoryVisibility(kept, 2, false);
  withCategoryColor(kept, 1, [1, 0, 0]);
  assert.equal(field._categoryVisible, before, 'the source keeps its own array');
  assert.deepEqual(Array.from(field._categoryVisible), [1, 1, 1, 1, 1]);
  assert.deepEqual(Array.from(kept._categoryVisible), [1, 1, 0, 1, 1]);
  assert.deepEqual(Array.from(kept._categoryColors.subarray(3, 6)), [255, 0, 0]);
  assert.notDeepEqual(Array.from(field._categoryColors.subarray(3, 6)), [255, 0, 0]);
  // Several changes copy each array once; hidden counts and tables follow.
  withCategoryChanges(kept, { visibility: [{ index: 0, visible: false }, { index: 2, visible: true }], colors: [{ index: 4, rgb: [0, 0, 1] }] });
  assert.deepEqual(Array.from(kept._categoryVisible), [0, 1, 1, 1, 1]);
  assert.equal(hiddenCategoryCount(kept._categoryVisible), 1);
  assert.deepEqual(Array.from(hiddenCategoryBytes(kept._categoryVisible)), [1, 0, 0, 0, 0]);
  withCategoriesVisible(kept, false, index => index > 2);
  assert.deepEqual(Array.from(kept._categoryVisible), [0, 1, 1, 0, 0]);
  // Carried to another list by position: a new category opens shown, in its color.
  const carried = carriedCategoryState({ colors: kept._categoryColors, visible: kept._categoryVisible }, 2, index => (index === 0 ? 3 : -1), () => [0, 1, 0]);
  assert.deepEqual(Array.from(carried.visible), [0, 1]);
  assert.deepEqual(Array.from(carried.colors.subarray(3, 6)), [0, 255, 0]);
});

test('a field of a million categories is checked once: a later coloring, a view and a toggle cost no pass over its categories', async () => {
  const color = Object.create(DataStateColorMethods.prototype);
  const field = categoryField(1_000_000);
  color.ensureCategoryMetadata(field);
  assert.equal(field._categoryColors.byteLength + field._categoryVisible.byteLength, 4_000_000);
  // Blocks of the app's code that ran (`helpers/block-counts.mjs`): a pass over a million categories runs a million.
  const APP = '/assets/js/';
  const later = await blocksRun(APP, () => color.ensureCategoryMetadata(field));
  const views = await blocksRun(APP, () => {
    for (let view = 0; view < 8; view++) viewContextCoreMethods._cloneFieldState.call({ _fieldCountMemo: null }, field);
  });
  withCategoryVisibility(field, 7, false);
  const afterToggle = await blocksRun(APP, () => color.ensureCategoryMetadata(field));
  assert.ok(later < 1000, `a later check ran ${later} blocks`);
  assert.ok(views < 1000, `eight views ran ${views} blocks`);
  assert.ok(afterToggle < 1000, `a check after a toggle ran ${afterToggle} blocks`);
});

test('a category list renamed in place is checked again; a wrong state is refused, never half repaired', () => {
  const color = Object.create(DataStateColorMethods.prototype);
  const field = categoryField(3);
  color.ensureCategoryMetadata(field);
  const wrong = { ...categoryField(2), _categoryVisible: new Uint8Array(1) };
  assert.throws(() => color.ensureCategoryMetadata(wrong), /every category index exactly once/);
  assert.equal(wrong._categoryColors, undefined);
  assert.throws(() => color.ensureCategoryMetadata({ ...categoryField(2), _categoryColors: new Uint8Array(3) }), /one RGB triplet per category/);
});

test('no module writes a category color or visibility in place', async () => {
  const offenders = [];
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.js')) {
        const text = await readFile(full, 'utf8');
        if (/_category(Visible|Colors)\[[^\]]+\]\s*=[^=]/.test(text)) offenders.push(path.relative(ROOT, full));
      }
    }
  };
  await walk(path.join(ROOT, 'assets/js'));
  assert.deepEqual(offenders, []);
});

test('a category is read through one set of accessors: its color as channels or CSS, whether it is shown', () => {
  const color = Object.create(DataStateColorMethods.prototype);
  const field = categoryField(3);
  color.ensureCategoryMetadata(field);
  withCategoryColor(field, 1, [1, 0.5, 0]);
  withCategoryVisibility(field, 2, false);
  assert.deepEqual(categoryRgbAt(field._categoryColors, 1), [1, 128 / 255, 0]);
  assert.equal(categoryCssAt(field._categoryColors, 1), 'rgb(255,128,0)');
  assert.equal(fieldCategoryCss(field, 1), 'rgb(255,128,0)');
  assert.deepEqual([0, 1, 2].map(index => categoryShownAt(field._categoryVisible, index)), [true, true, false]);
  // A field no view has colored is read in the color it opens with, and
  // the read makes no state for it.
  const fresh = categoryField(2);
  const opening = defaultCategoryColors(fresh);
  assert.equal(fieldCategoryCss(fresh, 1), categoryCssAt(opening, 1));
  assert.equal(fresh._categoryColors, undefined);
});

test('nothing reads category colors or visibility in a shape they no longer have, the browser specs included', async () => {
  // Colors are RGB bytes, three a category, and visibility a byte a
  // category (1 shown): an element is never an array, never a boolean, and
  // the arrays are never tested as plain arrays. A browser spec reads them
  // through the state (`getColorForCategory`, `getLegendModel`), not the
  // field's own arrays, so a change of shape cannot pass unseen there.
  const OLD_SHAPE = [
    /Array\.isArray\(\s*[\w.?]*_category(Colors|Visible)\s*\)/,
    /_category(Colors|Visible)(\?\.)?\[[^\]]+\]\s*(\?\.|\.)\s*(map|slice|length|every)\b/,
    /_categoryVisible(\?\.)?\[[^\]]+\]\s*(\?\?|[!=]==?\s*(true|false))/,
    /_categoryColors(\?\.)?\[[^\]]+\]\s*\?\?/,
    /Object\.(keys|values|entries)\(\s*[\w.?]*_categoryVisible/,
  ];
  const offenders = [];
  const walk = async (directory, rules) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full, rules);
      else if (/\.(m?js)$/.test(entry.name)) {
        const text = await readFile(full, 'utf8');
        for (const rule of rules) if (rule.test(text)) offenders.push(`${path.relative(ROOT, full)}: ${rule}`);
      }
    }
  };
  await walk(path.join(ROOT, 'assets/js'), OLD_SHAPE);
  await walk(path.join(ROOT, 'tests/browser'), [/_category(Colors|Visible)\b/]);
  assert.deepEqual(offenders, []);
});
