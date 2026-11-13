/**
 * Cellucid's own category colors (`data/palettes.js` `getCategoryColor`, as
 * drawn) are what cellucid-python and cellucid-r write as a user field's
 * colors when a session gives it none: the shared fixture
 * `category-default-colors.json` (`scripts/generate-category-default-colors.mjs`)
 * holds the first 1,024, byte for byte the same in the three repositories
 * (`tests/shared-files-contract.test.mjs` compares the copies).
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CATEGORY_DEFAULT_COLORS_PATH, categoryDefaultColorsText } from '../scripts/generate-category-default-colors.mjs';

test('the fixture is the colors the viewer gives', async () => {
  const bytes = await readFile(CATEGORY_DEFAULT_COLORS_PATH);
  assert.equal(bytes.toString('utf8'), categoryDefaultColorsText(),
    'Run node scripts/generate-category-default-colors.mjs (it writes the three copies).');
});
