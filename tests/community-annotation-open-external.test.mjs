/**
 * `openExternal` reports whether a window opened. `window.open` with the
 * `noopener` feature always returns null, so a call that took the null for a
 * refusal would report every successful open as a failure.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { openExternal } from '../assets/js/app/ui/modules/community-annotation/browser-integration.js';

function withWindow(open, run) {
  const previous = globalThis.window;
  globalThis.window = { open };
  try {
    return run();
  } finally {
    globalThis.window = previous;
  }
}

test('an opened window is reported as opened, without an opener, at the exact URL', () => {
  const calls = [];
  const child = { opener: { fake: 'parent' }, location: { replace: (url) => calls.push(['replace', url]) } };
  const result = withWindow((url, target, features) => {
    calls.push(['open', url, target, features]);
    return child;
  }, () => openExternal('https://github.com/apps/cellucid-community-annotations/installations/new'));
  assert.equal(result, true);
  assert.equal(child.opener, null);
  assert.deepEqual(calls, [
    ['open', 'about:blank', '_blank', undefined],
    ['replace', 'https://github.com/apps/cellucid-community-annotations/installations/new'],
  ]);
});

test('a blocked popup is reported as not opened', () => {
  assert.equal(withWindow(() => null, () => openExternal('https://github.com/settings/installations')), false);
});

test('only exact https URLs are opened', () => {
  let opened = 0;
  const open = () => { opened += 1; return { opener: null, location: { replace() {} } }; };
  for (const url of ['http://github.com/', ' https://github.com/', 'https://github.com', 'javascript:alert(1)', '']) {
    assert.equal(withWindow(open, () => openExternal(url)), false, url);
  }
  assert.equal(opened, 0);
});
