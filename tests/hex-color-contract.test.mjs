/**
 * One implementation of hex colors (`assets/js/utils/hex-color.js`).
 *
 * A color is read from or written as `#rrggbb` text in sessions, exports,
 * color inputs, Scanpy's `uns['<key>_colors']` and plot colors. The parse and
 * the format are written once: a copy of either in another module (the legend,
 * figure export, the analysis plots, state domains, cell exports, palettes,
 * the dataset read, the connectivity color input, the dot plot and Plot theme
 * parsers, or a `#rrggbb` pattern) would carry its own strictness. This
 * contract keeps the helpers exact and the source free of new copies.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  HEX_COLOR, bytesOfHex, hexOfBytes, hexOfRgb01, isHexColor, rgb01OfHex,
} from '../assets/js/utils/hex-color.js';
import { sourceFiles } from './helpers/source-files.mjs';

function sources() {
  return sourceFiles('assets/js', { enter: name => name !== 'vendor' })
    .filter(file => file.relative !== 'utils/hex-color.js');
}

/**
 * The forms a hand-written hex color takes: a regular-expression literal of a
 * hex color, a byte written as two hex digits into a `#…` string, and two hex
 * digits read at a color's channel offsets.
 */
const COPIES = [
  { what: 'a hex color pattern literal', pattern: /\/\^#\??\(?(\?:)?\[(0-9a-f|a-f\\d)/i },
  { what: 'a byte formatted into a "#…" color', pattern: /#.*toString\(16\)\.padStart\(2|toString\(16\)\.padStart\(2.*['"`]#/ },
  { what: 'a byte rounded and formatted as hex', pattern: /round\(.*\)\.toString\(16\)/ },
  { what: 'two hex digits parsed', pattern: /parseInt\([^)]*\.slice\([^)]*\),\s*16\)|parseInt\([^)]*\.slice\(\s*1\s*\),\s*16\)/ },
];

/** Hex text that is not a color, by file and line text. */
const NOT_COLORS = new Map([
  ['data/input-formats.js', /signature\.hex/], // a file signature's bytes
]);

test('no module parses or formats a hex color outside utils/hex-color.js', async () => {
  const found = [];
  for (const file of sources()) {
    const lines = (await readFile(file.path, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      for (const { what, pattern } of COPIES) {
        if (pattern.test(line) && !NOT_COLORS.get(file.relative)?.test(line)) found.push(`${file.relative}:${index + 1}: ${what}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(found, [], `Use utils/hex-color.js:\n${found.join('\n')}`);
});

test('hexOfBytes and hexOfRgb01 write lowercase #rrggbb, the bytes as drawn', () => {
  assert.equal(hexOfBytes(0, 15, 255), '#000fff');
  assert.equal(hexOfRgb01([1, 0.5, 0]), '#ff8000');
  assert.equal(hexOfRgb01(new Float32Array([0.2, 0.4, 0.6])), '#336699');
  // Rounding noise of a mix stays inside the byte it is drawn in.
  assert.equal(hexOfRgb01([1 + 1e-12, -1e-12, 0]), '#ff0000');
  assert.match(hexOfRgb01([0.123, 0.456, 0.789]), HEX_COLOR);
  for (const bad of [[256, 0, 0], [-1, 0, 0], [1.5, 0, 0], [Number.NaN, 0, 0]]) {
    assert.throws(() => hexOfBytes(...bad), TypeError);
  }
  for (const bad of [[2, 0, 0], [Number.NaN, 0, 0], [0, 0], [0, 0, 0, 1], null]) {
    assert.throws(() => hexOfRgb01(bad), TypeError);
  }
});

test('bytesOfHex and rgb01OfHex read #rgb, #rrggbb and #rrggbbaa in either case, null otherwise', () => {
  assert.deepEqual(bytesOfHex('#FF8000'), [255, 128, 0]);
  assert.deepEqual(bytesOfHex('#f80'), [255, 136, 0]);
  assert.deepEqual(bytesOfHex('#ff800080'), [255, 128, 0]);
  assert.deepEqual(rgb01OfHex('#336699'), [0.2, 0.4, 0.6]);
  for (const bad of ['ff8000', '#ff80', '#ff80000', '#gg8000', ' #ff8000', '', null, undefined, 0xff8000]) {
    assert.equal(bytesOfHex(bad), null, String(bad));
    assert.equal(rgb01OfHex(bad), null, String(bad));
  }
  for (let byte = 0; byte < 256; byte++) {
    const hex = hexOfBytes(byte, 255 - byte, byte);
    assert.deepEqual(bytesOfHex(hex), [byte, 255 - byte, byte]);
    assert.equal(hexOfRgb01(rgb01OfHex(hex)), hex);
  }
});

test('isHexColor takes #rrggbb in either case; HEX_COLOR only the lowercase form Cellucid writes', () => {
  assert.equal(isHexColor('#AbCdEf'), true);
  assert.equal(isHexColor('#abc'), false);
  assert.equal(isHexColor(null), false);
  assert.equal(HEX_COLOR.test('#abcdef'), true);
  assert.equal(HEX_COLOR.test('#ABCDEF'), false);
});
