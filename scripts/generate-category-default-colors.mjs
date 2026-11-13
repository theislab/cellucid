#!/usr/bin/env node
/**
 * Write the colors Cellucid gives the categories of a field that brings none
 * (`data/palettes.js` `getCategoryColor`, as drawn: `hexOfRgb01`), the first
 * 1,024 as `#rrggbb`, so cellucid-python (`_category_colors.py`) and
 * cellucid-r (`R/category-colors.R`) give the same colors to a user field a
 * session applies without colors of its own:
 *
 * - `tests/fixtures/category-default-colors.json` (this repository);
 * - `tests/fixtures/category_default_colors.json` in cellucid-python;
 * - `tests/testthat/fixtures/category_default_colors.json` in cellucid-r;
 *
 * byte for byte the same (`scripts/shared-files.mjs` lists the copies).
 *
 *   node scripts/generate-category-default-colors.mjs           # write
 *   node scripts/generate-category-default-colors.mjs --check   # exit 1 when one differs
 *
 * The packages are found beside this repository, or at CELLUCID_PYTHON_ROOT
 * and CELLUCID_R_ROOT.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getCategoryColor, getCategoryColorSeedCount } from '../assets/js/data/palettes.js';
import { hexOfRgb01 } from '../assets/js/utils/hex-color.js';
import { copyPaths, sharedFile } from './shared-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CATEGORY_DEFAULT_COLORS_PATH = path.join(ROOT, 'tests', 'fixtures', 'category-default-colors.json');
const COUNT = 1024;

/** The fixture's text. */
export function categoryDefaultColorsText() {
  const colors = Array.from({ length: COUNT }, (_, index) => hexOfRgb01(getCategoryColor(index)));
  return `${JSON.stringify({
    about: 'The colors Cellucid gives categories 0, 1, 2... of a field that brings none (data/palettes.js getCategoryColor, as drawn). '
      + 'Written by cellucid/scripts/generate-category-default-colors.mjs; the same bytes in cellucid, cellucid-python and cellucid-r.',
    designed: getCategoryColorSeedCount(),
    colors,
  }, null, 2)}\n`;
}

async function readOrNull(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function main() {
  const check = process.argv.includes('--check');
  const unknown = process.argv.slice(2).filter(argument => argument !== '--check');
  if (unknown.length > 0) throw new Error(`Unknown argument ${unknown[0]}; the only one is --check`);
  const text = categoryDefaultColorsText();
  const targets = [
    { repository: 'cellucid', file: CATEGORY_DEFAULT_COLORS_PATH },
    ...copyPaths(sharedFile('tests/fixtures/category-default-colors.json')).map(copy => ({ repository: copy.repository, env: copy.env, file: copy.path })),
  ];
  let stale = 0;
  for (const target of targets) {
    if (target.file === null) {
      console.log(`skipped ${target.repository}: not found (set ${target.env})`);
      continue;
    }
    if (check) {
      const same = (await readOrNull(target.file)) === text;
      console.log(`${same ? 'current' : 'stale  '} ${target.repository}`);
      if (!same) stale += 1;
      continue;
    }
    await writeFile(target.file, text);
    console.log(`wrote   ${target.repository}`);
  }
  if (stale > 0) {
    console.log('Run node scripts/generate-category-default-colors.mjs.');
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
