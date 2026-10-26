import assert from 'node:assert/strict';
import test from 'node:test';

import { DataStateColorMethods } from '../assets/js/app/state/managers/color-manager.js';
import { requireCategoryCodesInInventory } from '../assets/js/app/state/managers/category-codes.js';
import { NEUTRAL_GRAY_UINT8 } from '../assets/js/app/state/core/constants.js';

test('category codes are proven per array and category count', () => {
  const codes = Uint8Array.from([0, 2, 255, 1]);
  assert.doesNotThrow(() => requireCategoryCodesInInventory(codes, 3, i => `bad ${i}`));
  // A smaller inventory is proven afresh, not trusted from the earlier proof.
  assert.throws(
    () => requireCategoryCodesInInventory(codes, 2, i => `bad ${i}`),
    /bad 1/
  );
  assert.throws(
    () => requireCategoryCodesInInventory(Uint16Array.from([0, 65_534]), 3, i => `bad ${i}`),
    /bad 1/
  );
  assert.doesNotThrow(
    () => requireCategoryCodesInInventory(Uint16Array.from([0, 65_535]), 1, i => `bad ${i}`)
  );
});

function referenceColors(field, n, missingCode) {
  const colors = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const code = field.codes[i];
    let rgb;
    let alpha;
    if (code === missingCode) {
      rgb = [NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8];
      alpha = 1;
    } else if (!field._categoryVisible[code]) {
      rgb = [128, 128, 128];
      alpha = 0;
    } else {
      rgb = field._categoryColors[code].map(c => Math.round(c * 255));
      alpha = 1;
    }
    colors.set([...rgb, Math.round(alpha * 255)], i * 4);
  }
  return { colors };
}

for (const [Codes, missingCode] of [
  [Uint8Array, 0xff],
  [Uint16Array, 0xffff],
  [Uint32Array, 0xffffffff],
]) for (const aligned of [true, false]) {
  test(`table-driven category colors match the per-cell rule (${Codes.name}, ${aligned ? 'aligned' : 'unaligned'} buffer)`, () => {
    const n = 1_000;
    const codes = new Codes(n);
    for (let i = 0; i < n; i++) codes[i] = i % 7 === 6 ? missingCode : (i * 7919) % 5;
    const field = {
      kind: 'category',
      categories: ['a', 'b', 'c', 'd', 'e'],
      codes,
      _categoryColors: [
        [0.1, 0.2, 0.3], [0.9, 0.05, 0.5], [0.333, 0.666, 0.999], [0, 0, 0], [1, 1, 1],
      ],
      _categoryVisible: [true, false, true, true, false],
    };
    const buffer = new ArrayBuffer(n * 4 + 1);
    const state = {
      pointCount: n,
      colorsArray: new Uint8Array(buffer, aligned ? 0 : 1, n * 4),
      // A byte no visibility can hold, so a write to it would show.
      categoryTransparency: new Uint8Array(n).fill(7),
    };
    const expected = referenceColors(field, n, missingCode);

    DataStateColorMethods.prototype._writeCategoryColors.call(state, field);
    assert.deepEqual(state.colorsArray, expected.colors);
    // Visibility is the visibility pass's to publish: the table writes colors only.
    assert.ok(state.categoryTransparency.every(alpha => alpha === 7));
  });
}
