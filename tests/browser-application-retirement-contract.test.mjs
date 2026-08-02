import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const browserDir = path.join(rootDir, 'tests', 'browser');

test('every browser spec owns production application retirement', async () => {
  const specFiles = (await readdir(browserDir))
    .filter(name => name.endsWith('.spec.mjs'))
    .sort();
  assert.ok(specFiles.length > 0);

  for (const filename of specFiles) {
    const source = await readFile(path.join(browserDir, filename), 'utf8');
    assert.match(
      source,
      /from ['"]\.\/helpers\/test\.mjs['"];?/,
      `${filename} must use the application-retiring Playwright fixture`,
    );
    assert.doesNotMatch(
      source,
      /from ['"]@playwright\/test['"];?/,
      `${filename} bypasses application retirement`,
    );
  }
});

test('the browser fixture retires even a failed test through the stable owner', async () => {
  const source = await readFile(
    path.join(browserDir, 'helpers', 'test.mjs'),
    'utf8',
  );
  assert.match(
    source,
    /finally\s*\{[\s\S]*retireContextApplications\(context\)/,
  );
  assert.match(source, /applicationRetirement:[\s\S]*auto:\s*true/);
  assert.match(source, /window\._cellucidDispose/);
  assert.match(source, /secondTask\s*!==\s*firstTask/);
  assert.match(
    source,
    /context\.pages\(\)\.map\(page\s*=>\s*retirePageApplication\(page\)\)/,
  );
});

test('application retirement is installed before asynchronous bootstrap', async () => {
  const source = await readFile(
    path.join(rootDir, 'assets', 'js', 'app', 'main.js'),
    'utf8',
  );
  const disposePublication = source.indexOf(
    'window._cellucidDispose = destroyApplication;',
  );
  const firstBootstrapAwait = source.indexOf(
    'await githubAuthSession.completeSignInFromRedirect();',
  );
  assert.ok(disposePublication >= 0);
  assert.ok(firstBootstrapAwait >= 0);
  assert.ok(
    disposePublication < firstBootstrapAwait,
    'application disposal must exist before startup can suspend',
  );
  assert.match(
    source,
    /getOperations:\s*\(\)\s*=>\s*\[[\s\S]*ui\.destroy\(\)[\s\S]*viewer\.dispose\(\)/,
  );
  assert.match(
    source,
    /catch \(thrown\)[\s\S]*destroyApplication\(\)/,
    'terminal startup failures must retire their partial application',
  );
});
