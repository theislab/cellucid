#!/usr/bin/env node
/**
 * Write the history model (`historyModelDocument` of
 * `assets/js/app/history/model.js`: every record a history, a saved state and
 * a session file hold, with their fields, types, enumerations and rules, as a
 * JSON Schema) as canonical JSON, the one file Python and R build their
 * reading model of a session from:
 *
 * - `tests/fixtures/history-model.schema.json` (this repository),
 * - `src/cellucid/history_model.schema.json` in cellucid-python,
 * - `inst/history_model.schema.json` in cellucid-r,
 *
 * byte for byte the same, each pinned by SHA-256 in its repository's tests
 * (`tests/history-model-schema.test.mjs` here; the session reader tests of
 * the two packages, which also fail on a field of the schema their reading
 * model does not expose).
 *
 *   node scripts/generate-history-model.mjs           # write all three
 *   node scripts/generate-history-model.mjs --check   # exit 1 when one is stale
 *
 * The sibling repositories are found next to this one, or where
 * `CELLUCID_PYTHON_ROOT` and `CELLUCID_R_ROOT` say; one that is not there is
 * named and skipped. After writing, put the printed digest in the three
 * tests. Canonical as the action catalogue is: object keys sorted, two-space
 * indent, one trailing newline.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { historyModelDocument } from '../assets/js/app/history/model.js';
import { sortedKeys } from './generate-action-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HISTORY_MODEL_PATH = path.join(ROOT, 'tests', 'fixtures', 'history-model.schema.json');

/** Where each package keeps its copy, relative to its repository. */
export const HISTORY_MODEL_MIRRORS = Object.freeze([
  Object.freeze({ repository: 'cellucid-python', env: 'CELLUCID_PYTHON_ROOT', file: 'src/cellucid/history_model.schema.json' }),
  Object.freeze({ repository: 'cellucid-r', env: 'CELLUCID_R_ROOT', file: 'inst/history_model.schema.json' }),
]);

/** The model document's canonical text, as this checkout's model makes it. */
export function renderHistoryModel() {
  return `${JSON.stringify(sortedKeys(historyModelDocument()), null, 2)}\n`;
}

/** The SHA-256 of the canonical text (what the three tests pin). */
export function historyModelDigest(text = renderHistoryModel()) {
  return createHash('sha256').update(text).digest('hex');
}

/** Each mirror's absolute path, or null when its repository is not there. */
export function historyModelMirrorPaths(env = process.env) {
  return HISTORY_MODEL_MIRRORS.map(mirror => {
    const root = env[mirror.env] ?? path.join(ROOT, '..', mirror.repository);
    const target = path.join(root, mirror.file);
    return { ...mirror, path: existsSync(path.dirname(target)) ? target : null };
  });
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
  const text = renderHistoryModel();
  const targets = [
    { repository: 'cellucid', path: HISTORY_MODEL_PATH },
    ...historyModelMirrorPaths(),
  ];
  let stale = 0;
  for (const target of targets) {
    if (target.path === null) {
      console.log(`skipped ${target.repository}: not found (set ${target.env})`);
      continue;
    }
    const current = await readOrNull(target.path);
    if (current === text) {
      console.log(`current ${path.relative(path.join(ROOT, '..'), target.path)}`);
      continue;
    }
    if (check) {
      stale += 1;
      console.log(`stale   ${path.relative(path.join(ROOT, '..'), target.path)}`);
      continue;
    }
    await writeFile(target.path, text);
    console.log(`wrote   ${path.relative(path.join(ROOT, '..'), target.path)}`);
  }
  console.log(`sha256  ${historyModelDigest(text)}`);
  if (stale > 0) {
    console.log('Run node scripts/generate-history-model.mjs and pin the digest above in the three repositories.');
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
