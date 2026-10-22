/**
 * `getError()` is a synchronous round trip to the GPU process that waits for
 * every queued command. Writes into storage WebGL has already accepted (a
 * filter tick's alpha rows, a recolour, a kept view's alpha, a draw order's
 * rows after its checked allocation) read nothing back: they fail
 * synchronously or not at all, and only fence on a lost context. Allocations
 * keep their check, and only OUT_OF_MEMORY is retried there.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../assets/js/rendering/high-perf-renderer.js', import.meta.url), 'utf8');

function method(name) {
  const start = source.indexOf(`\n  ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n  }\n', start);
  return source.slice(start, end);
}

test('writes into accepted storage read no WebGL error back', () => {
  for (const name of [
    '_uploadAlphaRegions',
    '_publishLiveColors',
    '_writeOrderedColors',
    '_createDrawOrderRecord',
    '_withNeutralTextureUnpackState',
  ]) {
    const body = method(name);
    assert.doesNotMatch(body, /requireCleanWebGLState|getError\(/, name);
    assert.match(body, /requireLiveContext\(/, name);
  }
});

test('an allocation retries only a refusal for memory', () => {
  const body = method('_allocateGpu');
  assert.match(body, /code === gl\.OUT_OF_MEMORY &&/);
});
