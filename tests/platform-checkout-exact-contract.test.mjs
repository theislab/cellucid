import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('all text artifacts keep exact LF bytes on every checkout platform', async () => {
  const attributes = await readFile(
    new URL('../.gitattributes', import.meta.url),
    'utf8'
  );
  assert.equal(attributes, '* text=auto eol=lf\n');
});
