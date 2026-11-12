/**
 * One quoting rule for every CSV the app writes (`compute/csv-export.js`
 * `csvText`): a cell holding a quote, a comma or a line break, `\n` or `\r`,
 * is quoted. The composition and dot plot tables had their own copies, which
 * left a `\r` (a label read from a file with Windows line endings) unquoted,
 * so the row broke in two for every CSV reader; and wrote a missing value as
 * `NA` where every other CSV writes an empty cell (`toCSVCell`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { csvText, toCSVCell } from '../assets/js/app/analysis/compute/csv-export.js';
import { csvCell } from '../assets/js/app/exports/cell-exports.js';
import { sourceFiles } from './helpers/source-files.mjs';

test('a quote, a comma, a line feed or a carriage return makes a quoted cell', () => {
  for (const [text, expected] of [
    ['plain', 'plain'], ['a,b', '"a,b"'], ['say "x"', '"say ""x"""'], ['B\ncell', '"B\ncell"'], ['B\rcell', '"B\rcell"'],
  ]) {
    assert.equal(csvText(text), expected);
    assert.equal(toCSVCell(text), expected);
    assert.equal(csvCell(text), expected);
  }
});

test('no module but the CSV writer quotes CSV text itself', () => {
  const quoting = sourceFiles('assets/js')
    .filter(file => /replace\(\/"\/g, '""'\)/.test(readFileSync(file.path, 'utf8')))
    .map(file => file.relative);
  assert.deepEqual(quoting.filter(file => !file.startsWith('dev/')), ['app/analysis/compute/csv-export.js']);
});

test('a missing value is an empty cell in every CSV, never NA', () => {
  assert.equal(toCSVCell(null), '');
  assert.equal(toCSVCell(Number.NaN), '');
  assert.equal(toCSVCell(Number.POSITIVE_INFINITY), '');
  const writesNa = sourceFiles('assets/js/app')
    .filter(file => /: 'NA'\)|\? 'NA' :|'NA'\s*[,;)]/.test(readFileSync(file.path, 'utf8')))
    .map(file => file.relative);
  assert.deepEqual(writesNa, []);
});
