import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const VALIDATOR_PATH = fileURLToPath(
  new URL('../scripts/validate-tokens.js', import.meta.url),
);
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('the complete CSS token inventory accepts every declared runtime custom property', () => {
  const result = spawnSync(process.execPath, [VALIDATOR_PATH], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });

  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(
    result.status,
    0,
    `design-token validation failed:\n${result.stderr}${result.stdout}`,
  );
  assert.match(
    result.stdout,
    /^\[validate-tokens\] OK \(\d+ tokens, \d+ files scanned\)\n$/,
  );
  assert.equal(result.stderr, '');
});
