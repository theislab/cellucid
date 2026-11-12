/**
 * One number format for every measured value the app shows (audit NS-3):
 * the legends' color bars, the filter list and figure provenance, exported
 * figures' axes and legends, cell info, range labels and analysis summaries
 * all write a value through `formatSignificant` (`utils/format-units.js`).
 * Three significant figures by default — in every range, where the two
 * former formatters gave one or two in [0.01, 1) and in their mantissas —
 * with the notation chosen after rounding, so a value that rounds into the
 * next decade is written in that decade's form, never "10.0e-3".
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BOUND_FIGURES,
  formatBound,
  formatSignificant,
  tickFigures
} from '../assets/js/utils/format-units.js';
import { tickLabels } from '../assets/js/app/ui/modules/figure-export/components/axes-builder.js';
import { niceNumbers } from '../assets/js/utils/nice-ticks.js';
import { formatCellValue } from '../assets/js/app/ui/modules/cell-info.js';

test('three significant figures in every range; scientific outside 0.01 to 10,000', () => {
  const cases = [
    [0.0149, '0.0149'],
    [0.0123, '0.0123'],
    [0.0851, '0.0851'],
    [0.123456, '0.123'],
    [1.23456, '1.23'],
    [12.345, '12.3'],
    [123.456, '123'],
    [1234.5, '1230'],
    [0.00123, '1.23e-3'],
    [1234567.891, '1.23e6'],
    [0.001, '1e-3'],
    [-0.0851, '-0.0851'],
    [-98765, '-9.88e4'],
    [0.1 + 0.2, '0.3'],
    [5e-324, '4.94e-324'],
    [1.7976931348623157e308, '1.8e308']
  ];
  for (const [value, text] of cases) assert.equal(formatSignificant(value), text, String(value));
});

test('decade boundaries: the rounded value picks the notation, the mantissa is renormalised', () => {
  // The former formatters wrote these "1e-2"/"10.0e-3", "10.0e4" and "1e4" or worse.
  assert.equal(formatSignificant(0.00996), '9.96e-3');
  assert.equal(formatSignificant(0.009996), '0.01');
  assert.equal(formatSignificant(9999.6), '1e4');
  assert.equal(formatSignificant(9994), '9990');
  assert.equal(formatSignificant(99960), '1e5');
  assert.equal(formatSignificant(0.099996), '0.1');
  assert.equal(formatSignificant(9.9996e-5), '1e-4');
});

test('no value, zero, and the figures asked for', () => {
  for (const missing of [NaN, Infinity, -Infinity, null, undefined]) assert.equal(formatSignificant(missing), '—');
  assert.equal(formatSignificant(0), '0');
  assert.equal(formatSignificant(-0), '0');
  assert.equal(formatSignificant(123456, 6), '123456');
  assert.equal(formatSignificant(1234567, 6), '1.23457e6');
  assert.equal(formatSignificant(0.012345678, 6), '0.0123457');
  assert.throws(() => formatSignificant(1, 0), /1 to 17/);
  assert.throws(() => formatSignificant(1, 18), /1 to 17/);
});

test('a range bound is written exactly when typed or set by a slider', () => {
  assert.equal(BOUND_FIGURES, 6);
  for (const [bound, text] of [[1500, '1500'], [1234, '1234'], [0.012, '0.012'], [0.0135, '0.0135'], [1, '1'], [12345, '12345'], [99900, '99900']]) {
    assert.equal(formatBound(bound), text);
  }
  // A filter of 0.012 to 0.014 is no longer "0.01 – 0.01".
  assert.notEqual(formatBound(0.012), formatBound(0.014));
});

test('axis tick labels tell their ticks apart and agree with the screen', () => {
  assert.deepEqual(tickLabels(niceNumbers(0, 1, 5)), ['0', '0.2', '0.4', '0.6', '0.8', '1']);
  assert.deepEqual(tickLabels(niceNumbers(100, 102, 4)), ['100', '100.5', '101', '101.5', '102']);
  assert.deepEqual(tickLabels(niceNumbers(0, 100000, 5)), ['0', '2e4', '4e4', '6e4', '8e4', '1e5']);
  assert.deepEqual(tickLabels(niceNumbers(0.001, 0.003, 4)), ['1e-3', '1.5e-3', '2e-3', '2.5e-3', '3e-3']);
  assert.equal(tickFigures(101, 0.5), 4);
  assert.equal(tickFigures(1, 0.2), 3);
  for (const labels of [tickLabels(niceNumbers(-3.3, 7.7, 6)), tickLabels(niceNumbers(12000, 12500, 5))]) {
    assert.equal(new Set(labels).size, labels.length, `distinct: ${labels.join(', ')}`);
  }
});

test('cell info writes a cell value to six figures, a count whole', () => {
  assert.equal(formatCellValue(12345), '12345');
  assert.equal(formatCellValue(1.6094379124341003), '1.60944');
  assert.equal(formatCellValue(0.000123), '1.23e-4');
  assert.equal(formatCellValue(NaN), 'Missing', 'the word the legend and the filters use (R9D-9)');
});

test('no other module writes a shown value with its own significant-figure rule', () => {
  // The deleted formatters: figure export's formatTick, the selection range
  // label's, the range highlight's and cell info's own rules.
  const root = fileURLToPath(new URL('../assets/js/', import.meta.url));
  const files = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.js')) files.push(path);
    }
  };
  walk(root);
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    assert.doesNotMatch(text, /export function formatTick\b/, path);
    assert.doesNotMatch(text, /mantissa\.toFixed\(1\)/, path);
    assert.doesNotMatch(text, /Math\.abs\(v(alue)?\) >= 1000 \|\| \(Math\.abs\(v(alue)?\) > 0 && Math\.abs\(v(alue)?\) < 0\.01\)/, path);
  }
});
