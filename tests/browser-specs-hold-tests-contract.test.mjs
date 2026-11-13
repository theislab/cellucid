/**
 * Every browser spec file declares tests. Playwright says nothing about a
 * spec file that holds none (an edit that cuts a file to its imports goes
 * unnoticed: its tests gone and the run still green), so each
 * spec file under `tests/browser/` must call `test(…)`, `test.describe(…)`
 * (or one of their modifiers) or hand `test` to a helper that declares them
 * (`declareWalkTests(test, …)`), and end as a whole file does (a newline).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const BROWSER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'browser');
const DECLARES = /\btest(?:\.describe)?(?:\.(?:serial|parallel|only|skip|fixme|fail))?\s*\(|\bdeclare\w*\(\s*test\b/;

function specFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return specFiles(full);
    return entry.name.endsWith('.spec.mjs') ? [full] : [];
  });
}

test('every browser spec file declares tests and ends with a newline', () => {
  const files = specFiles(BROWSER);
  assert.ok(files.length > 50, 'the browser specs are found');
  const empty = [];
  const cut = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (!DECLARES.test(code)) empty.push(path.relative(BROWSER, file));
    if (!text.endsWith('\n')) cut.push(path.relative(BROWSER, file));
  }
  assert.deepEqual(empty, [], 'spec files that declare no test');
  assert.deepEqual(cut, [], 'spec files that do not end with a newline (cut?)');
});
