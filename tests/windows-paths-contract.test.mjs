/**
 * A file URL is turned into a path of this system with `fileURLToPath()`,
 * never by its `pathname`: on Windows that is `/D:/a/...`, which
 * `path.join()` and `path.resolve()` make `D:\D:\a\...`, so three contracts
 * read no file there and four more compared `\`-separated names with
 * `'app/...'` (CI run 43106620008). The contracts that read every module of a
 * folder do it through `tests/helpers/source-files.mjs`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { sourceFiles } from './helpers/source-files.mjs';

/** A file URL's pathname taken for a path: of `import.meta.url`, or inside path.join()/path.resolve(). */
const PATHNAME_AS_PATH = /import\.meta\.url\)+\.pathname|path\.(?:join|resolve)\(\s*new URL\([^)]*\)\.pathname/;

test('no test or script takes a file URL\'s pathname for a path', () => {
  const keep = name => name.endsWith('.mjs') || name.endsWith('.js');
  const offenders = [];
  for (const folder of ['tests', 'scripts']) {
    for (const file of sourceFiles(folder, { keep, enter: name => name !== 'node_modules' })) {
      readFileSync(file.path, 'utf8').split('\n').forEach((line, index) => {
        if (PATHNAME_AS_PATH.test(line)) offenders.push(`${folder}/${file.relative}:${index + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(offenders, [], 'use fileURLToPath() (or tests/helpers/source-files.mjs)');
});

test('the source files are named with \'/\' from their folder, sorted', () => {
  const files = sourceFiles('assets/js/utils');
  assert.ok(files.some(file => file.relative === 'hex-color.js'));
  assert.ok(files.every(file => !file.relative.includes('\\')));
  assert.deepEqual(files.map(file => file.relative), files.map(file => file.relative).sort());
});
