import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, '..');
const PRODUCTION_ROOTS = [
  path.join(REPOSITORY_ROOT, 'assets/js'),
  path.join(REPOSITORY_ROOT, 'assets/css'),
  path.join(REPOSITORY_ROOT, 'docs'),
];
const PRODUCTION_FILES = [
  path.join(REPOSITORY_ROOT, 'README.md'),
  path.join(REPOSITORY_ROOT, 'index.html'),
];
const TEXT_EXTENSIONS = new Set(['.js', '.css', '.html', '.md']);
const RETIRED_PATH_LANGUAGE =
  /\bfallback\b|fall(?:ing)?\s+back|best.?effort|\blegacy\b|\bdeprecated\b|deprecation|backward.?compat|backwards.?compat|\bshim\b/i;
const RETIRED_CONTRACT_SYMBOLS =
  /fetchWithExportsBridge|bridge\.html|bridge\.js|searchParams\.(?:get|getAll|has)\(\s*['"]exports['"]/;

function collectProductionFiles(directory, result = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'vendor') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectProductionFiles(absolute, result);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      result.push(absolute);
    }
  }
  return result;
}

test('production source and documentation contain no retired-path implementation or narrative', () => {
  const violations = [];
  const filenames = [
    ...PRODUCTION_ROOTS.flatMap(root => collectProductionFiles(root)),
    ...PRODUCTION_FILES,
  ];
  for (const filename of filenames) {
    const source = fs.readFileSync(filename, 'utf8');
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (
        RETIRED_PATH_LANGUAGE.test(lines[index]) ||
        RETIRED_CONTRACT_SYMBOLS.test(lines[index])
      ) {
        violations.push(
          `${path.relative(REPOSITORY_ROOT, filename)}:${index + 1}: ${lines[index].trim()}`
        );
      }
    }
  }
  assert.deepEqual(violations, []);
});
