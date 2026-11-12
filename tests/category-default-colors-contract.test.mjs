/**
 * Cellucid's own category colors (`data/palettes.js` `getCategoryColor`, as
 * drawn) are what cellucid-python and cellucid-r write as a user field's
 * colors when a session gives it none: the shared fixture
 * `category-default-colors.json` (`scripts/generate-category-default-colors.mjs`)
 * pins the first 1,024 byte for byte in the three repositories.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CATEGORY_DEFAULT_COLORS_PATH, categoryDefaultColorsText } from '../scripts/generate-category-default-colors.mjs';

const SHA256 = '66e652c560afa8aa5bbe149ed87379fd9b937e5a3ca0585d669fdc09092576e0';

test('the fixture is the colors the viewer gives, pinned', async () => {
  const bytes = await readFile(CATEGORY_DEFAULT_COLORS_PATH);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), SHA256,
    'Run node scripts/generate-category-default-colors.mjs and pin the printed digest in the three repositories.');
  assert.equal(bytes.toString('utf8'), categoryDefaultColorsText());
});
