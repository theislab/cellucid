import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as numberUtils from '../assets/js/app/utils/number-utils.js';

test('finite range parsing accepts only one exact decimal string in range', () => {
  assert.equal(
    numberUtils.parseFiniteNumberInRange('0.15', 0, 1, 'Non-selected opacity'),
    0.15,
  );
  assert.equal(
    numberUtils.parseFiniteNumberInRange('1e-3', 0, 1, 'Non-selected opacity'),
    0.001,
  );

  for (const value of ['', ' ', ' 0.15', '0.15 ', '12px', 'Infinity', 'NaN']) {
    assert.throws(
      () => numberUtils.parseFiniteNumberInRange(
        value,
        0,
        1,
        'Non-selected opacity',
      ),
      /Non-selected opacity.*exact finite decimal/i,
    );
  }
  for (const value of [null, undefined, 0.15, false, {}, []]) {
    assert.throws(
      () => numberUtils.parseFiniteNumberInRange(
        value,
        0,
        1,
        'Non-selected opacity',
      ),
      /Non-selected opacity.*exact finite decimal/i,
    );
  }
  for (const value of ['-0.01', '1.01']) {
    assert.throws(
      () => numberUtils.parseFiniteNumberInRange(
        value,
        0,
        1,
        'Non-selected opacity',
      ),
      /Non-selected opacity.*between 0 and 1/i,
    );
  }
});

test('removed fallback parser is absent from the current utility surface', () => {
  assert.equal(Object.hasOwn(numberUtils, 'parseNumberOr'), false);
});

test('figure export requires exact muted opacity instead of substituting 0.15', async () => {
  const source = await readFile(
    new URL(
      '../assets/js/app/ui/modules/figure-export/figure-export-ui.js',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    source,
    /parseFiniteNumberInRange\(\s*selectionMutedOpacityInput\.value,\s*0,\s*1,\s*'Non-selected opacity'/,
  );
  assert.doesNotMatch(source, /parseNumberOr|selectionMutedOpacityInput\.value,\s*0\.15/);
});
