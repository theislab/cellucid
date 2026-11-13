/**
 * One rule for every color the app gives a category or a highlight page of
 * its own choosing (`data/distinct-colors.js`): it is told apart from the
 * colors beside it, else it is the next palette color that is (a
 * grouped field's two groups must not inherit amber and bright orange from
 * their first categories and read as one; Unassigned after a deletion must
 * not take a kept category's color; a new highlight page must not repeat a
 * remaining page's).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  MIN_DISTINCT_COLOR_DISTANCE,
  colorDistance,
  distinctColor,
  isDistinctColor,
  settleDistinctCategoryColors
} from '../assets/js/data/distinct-colors.js';
import { getCategoryColor } from '../assets/js/data/palettes.js';
import {
  buildDeleteToUnassignedTransform,
  buildGroupCategoriesTransform,
  carryCategoryStateByCategory,
  carryCategoryStateThroughDelete,
  carryCategoryStateThroughGroup
} from '../assets/js/app/utils/categorical-ops.js';
import { pageFieldColor, pageFieldPalette } from '../assets/js/app/registries/user-defined-fields.js';
import { PAGE_COLORS, nextPageColor } from '../assets/js/app/utils/page-colors.js';
import { rgb01OfHex } from '../assets/js/utils/hex-color.js';
import { sourceFiles } from './helpers/source-files.mjs';

const hex = text => rgb01OfHex(text);
const bytesOf = colors => Uint8Array.from(colors.flatMap(text => [...hex(text)].map(channel => Math.round(channel * 255))));
const rgbAt = (bytes, index) => [bytes[index * 3] / 255, bytes[index * 3 + 1] / 255, bytes[index * 3 + 2] / 255];
const allApart = colors => colors.every((color, index) => isDistinctColor(color, colors.filter((_, other) => other !== index)));

test('the threshold sits between the pairs that read as one and the palettes that read as many', () => {
  // A pair that reads as one (Kanemaru: amber from "Fetal atrial cardiomyocyte", bright orange from
  // "Adventitial fibroblast") and the default pages' red and rose read as one.
  assert.ok(colorDistance(hex('#ECB100'), hex('#FF9900')) < MIN_DISTINCT_COLOR_DISTANCE);
  assert.ok(colorDistance(hex('#dc2626'), hex('#e11d48')) < MIN_DISTINCT_COLOR_DISTANCE);
  // Red and orange pages read as two; Scanpy's default ten colors (tab10) all stay.
  assert.ok(colorDistance(hex('#dc2626'), hex('#ea580c')) >= MIN_DISTINCT_COLOR_DISTANCE);
  const tab10 = ['#1f77b4', '#ff7f0e', '#279e68', '#d62728', '#aa40fc', '#8c564b', '#e377c2', '#b5bd61', '#17becf', '#aec7e8'].map(hex);
  assert.ok(allApart(tab10));
  // The distance is symmetric and zero for one color.
  assert.equal(colorDistance(hex('#123456'), hex('#123456')), 0);
  assert.equal(colorDistance(hex('#ff0000'), hex('#00ff00')), colorDistance(hex('#00ff00'), hex('#ff0000')));
});

test('a color is kept when it is told apart, else the first palette color that is; with none, the farthest', () => {
  const taken = [hex('#FF9900'), hex('#0077C8')];
  assert.deepEqual(distinctColor(taken, hex('#ad50e0')), hex('#ad50e0'));
  // Amber reads as the orange taken: the palette's first color told apart from both (its third).
  assert.deepEqual(distinctColor(taken, hex('#ECB100')), [...getCategoryColor(2)]);
  // No preference: the first color told apart.
  assert.deepEqual(distinctColor([], null), [...getCategoryColor(0)]);
  // A sequence with nothing told apart gives the farthest of its colors, never fails.
  const grey = [0.5, 0.5, 0.5];
  const near = [0.52, 0.5, 0.5];
  const out = distinctColor([grey], grey, index => (index === 3 ? near : grey), 4);
  assert.deepEqual(out, near);
});

test('a grouped field: each group inherits its first category\'s color only when told apart from the kept ones and the groups before it', () => {
  // Kanemaru's cell types, grouped: atrial cardiomyocytes, the rest "diğer".
  const categories = ['Adventitial fibroblast', 'Capillary endothelial', 'Fetal atrial cardiomyocyte', 'Fetal ventricular cardiomyocyte'];
  const colors = bytesOf(['#FF9900', '#0077C8', '#ECB100', '#7080C0']);
  const visible = Uint8Array.of(1, 1, 1, 1);
  const withRest = buildGroupCategoriesTransform(categories, [{ label: 'atrial', members: [2] }], 'diğer');
  assert.deepEqual(withRest.categories, ['atrial', 'diğer']);
  const carried = carryCategoryStateThroughGroup(withRest, { colors, visible });
  // "atrial" keeps amber; "diğer" would inherit bright orange (its first), which reads as amber.
  assert.deepEqual(rgbAt(carried.colors, 0), rgbAt(colors, 2));
  assert.notDeepEqual(rgbAt(carried.colors, 1), rgbAt(colors, 0));
  assert.ok(allApart([rgbAt(carried.colors, 0), rgbAt(carried.colors, 1)]));

  // Without a rest: kept categories keep theirs, and a group is told apart from them too.
  const kept = buildGroupCategoriesTransform(categories, [{ label: 'atrial', members: [2] }], null);
  assert.deepEqual(kept.categories, ['atrial', 'Adventitial fibroblast', 'Capillary endothelial', 'Fetal ventricular cardiomyocyte']);
  assert.equal(kept.groupCount, 1);
  const keptCarried = carryCategoryStateThroughGroup(kept, { colors, visible });
  assert.deepEqual(rgbAt(keptCarried.colors, 1), rgbAt(colors, 0), 'a kept category keeps its color');
  assert.deepEqual(rgbAt(keptCarried.colors, 2), rgbAt(colors, 1));
  assert.deepEqual(rgbAt(keptCarried.colors, 3), rgbAt(colors, 3));
  assert.notDeepEqual(rgbAt(keptCarried.colors, 0), rgbAt(colors, 2), 'amber would read as the kept orange');
  assert.ok(allApart([0, 1, 2, 3].map(index => rgbAt(keptCarried.colors, index))));

  // Groups whose first categories are told apart keep them.
  const apart = buildGroupCategoriesTransform(categories, [{ label: 'endothelial', members: [1] }, { label: 'atrial', members: [2] }], 'other');
  const apartCarried = carryCategoryStateThroughGroup(apart, { colors: bytesOf(['#7080C0', '#0077C8', '#ECB100', '#7080C0']), visible });
  assert.deepEqual([0, 1].map(index => rgbAt(apartCarried.colors, index)), [hex('#0077C8'), hex('#ECB100')].map(color => color.map(channel => Math.round(channel * 255) / 255)));
});

test('a category a field gains opens in its place\'s palette color only when told apart from the others', () => {
  // Deleting B of [B, T, NK] to Unassigned: [T, NK, Unassigned]; NK keeps the palette's third
  // color, which is also Unassigned's place's: Unassigned takes the first told apart.
  const colors = Uint8Array.from([0, 1, 2].flatMap(index => [...getCategoryColor(index)].map(channel => Math.round(channel * 255))));
  const transform = buildDeleteToUnassignedTransform(['B', 'T', 'NK'], 0, { unassignedLabel: 'Unassigned' });
  const carried = carryCategoryStateThroughDelete(transform, { colors, visible: Uint8Array.of(1, 1, 1) });
  assert.deepEqual(transform.categories, ['T', 'NK', 'Unassigned']);
  assert.deepEqual(rgbAt(carried.colors, 1), rgbAt(colors, 2));
  assert.ok(allApart([0, 1, 2].map(index => rgbAt(carried.colors, index))), 'three colors for three categories');
  // By label: a new label whose place's color is a kept one's takes another.
  const byLabel = carryCategoryStateByCategory(['a', 'b'], ['b', 'x'], { colors: bytesOf(['#ff0000', '#0077c8']), visible: Uint8Array.of(1, 1) });
  assert.deepEqual(rgbAt(byLabel.colors, 0), hex('#0077c8').map(channel => Math.round(channel * 255) / 255));
  assert.ok(allApart([rgbAt(byLabel.colors, 0), rgbAt(byLabel.colors, 1)]));
});

test('settling leaves unmarked colors alone and settles the marked in order', () => {
  const colors = bytesOf(['#ff9900', '#ff9900', '#0077c8', '#ff9900']);
  settleDistinctCategoryColors(colors, index => index === 1 || index === 3);
  assert.deepEqual(rgbAt(colors, 0), rgbAt(bytesOf(['#ff9900']), 0));
  assert.deepEqual(rgbAt(colors, 2), rgbAt(bytesOf(['#0077c8']), 0));
  assert.ok(allApart([0, 1, 2, 3].map(index => rgbAt(colors, index))));
});

test('a field made from highlight pages: the categories beyond its pages are told apart from the pages and each other, the preview\'s colors its', () => {
  // Two pages in the palette's first two colors: the third category's place (2) is free, the
  // fourth's (3) too, but a page colored like the palette's third takes that place's color.
  const pages = ['#ff9900', '#ad50e0'];
  const palette = pageFieldPalette(pages, 4);
  assert.deepEqual(palette.slice(0, 2), pages.map(hex));
  assert.ok(allApart(palette));
  assert.notDeepEqual(palette[2], [...getCategoryColor(2)], 'the palette\'s third is the second page\'s');
  for (let index = 0; index < 4; index++) assert.deepEqual(pageFieldColor(pages, index), palette[index], `the preview's color ${index}`);
  assert.throws(() => pageFieldPalette(['red'], 2), /#rrggbb/);
});

test('a new highlight page takes a color told apart from every page there is', () => {
  const pages = [];
  for (let count = 0; count < 16; count++) pages.push(nextPageColor(pages));
  assert.equal(pages[0], PAGE_COLORS[0]);
  assert.deepEqual(pages.slice(0, 5), PAGE_COLORS.slice(0, 5), 'the first five as before');
  assert.ok(allApart(pages.map(hex)), pages.join(' '));
  // After a page is removed, the next one never repeats a remaining page's color
  // (it took the page count's default: green, the third page's).
  const left = [PAGE_COLORS[0], PAGE_COLORS[2]];
  const next = nextPageColor(left);
  assert.ok(isDistinctColor(hex(next), left.map(hex)), next);
  // A page the person recolored to the next default's color: the new one is told apart from it.
  assert.ok(isDistinctColor(hex(nextPageColor([PAGE_COLORS[0], PAGE_COLORS[2]])), [hex(PAGE_COLORS[0]), hex(PAGE_COLORS[2])]));
});

test('every module that gives a category or a page a palette color goes through the rule', () => {
  // A module importing the category sequence (`getCategoryColor`) to color something new also
  // imports the rule, except where a category's color must be its place's whatever else is
  // shown: a file's categories (`palettes.js`), and the categories a column turns out to hold
  // (`discovered-categories.js`: a share of the cells and all of them show one color), and the
  // AnnData copy, which writes a column's colors exactly as it is shown, by place
  // (`history/exports/anndata-copy.js`: Scanpy's `uns['<key>_colors']`).
  const PLACE_COLORED = new Set(['assets/js/data/palettes.js', 'assets/js/data/discovered-categories.js', 'assets/js/data/distinct-colors.js', 'assets/js/app/history/exports/anndata-copy.js']);
  const offenders = [];
  for (const { path, relative } of sourceFiles('assets/js')) {
    const source = readFileSync(path, 'utf8');
    const name = `assets/js/${relative}`;
    if (PLACE_COLORED.has(name)) continue;
    if (/\bgetCategoryColor\b/.test(source) && !/distinct-colors\.js/.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});
