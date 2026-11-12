/**
 * Copying always says how it went (round 9, one-implementation lane): copied,
 * or why not. The Marker genes "Copy genes" button swallowed a refusal in
 * silence; five callers wrote the clipboard each their own way.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { copyText } from '../assets/js/app/utils/clipboard.js';

function center() {
  const said = [];
  return { said, success: (message, options) => said.push(['success', message, options.category]), error: (message, options) => said.push(['error', message, options.category]) };
}

function withClipboard(clipboard, run) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: clipboard === undefined ? {} : { clipboard } });
  return Promise.resolve(run()).finally(() => {
    if (before === undefined) delete globalThis.navigator; else Object.defineProperty(globalThis, 'navigator', before);
  });
}

test('copied: said as asked, or by the caller (success null)', async () => {
  const written = [];
  await withClipboard({ writeText: async text => { written.push(text); } }, async () => {
    const notifications = center();
    assert.equal(await copyText('G1\nG2', { what: '2 genes', success: 'Copied 2 genes.', category: 'analysis', notifications }), true);
    assert.equal(await copyText('x', { what: 'the report', success: null, notifications }), true);
    assert.deepEqual(notifications.said, [['success', 'Copied 2 genes.', 'analysis']]);
  });
  assert.deepEqual(written, ['G1\nG2', 'x']);
});

test('refused or unavailable: why, and what to do, always said', async () => {
  const denied = Object.assign(new Error('Document is not focused.'), { name: 'NotAllowedError' });
  await withClipboard({ writeText: async () => { throw denied; } }, async () => {
    const notifications = center();
    assert.equal(await copyText('a link', { what: 'the link', success: null, failure: 'The link: a link', notifications }), false);
    assert.deepEqual(notifications.said, [['error', 'The link could not be copied: the browser did not allow it (the page must be in front and focused). The link: a link', 'data']]);
  });
  await withClipboard(undefined, async () => {
    const notifications = center();
    assert.equal(await copyText('code', { what: 'the code', notifications }), false);
    assert.match(notifications.said[0][1], /^The code could not be copied: this page has no clipboard/);
  });
});

test('a button says it on itself for a moment; a refusal is said in a notification too', async () => {
  const button = { textContent: 'Copy', dataset: {} };
  await withClipboard({ writeText: async () => { throw new Error('no'); } }, async () => {
    const notifications = center();
    await copyText('t', { what: 'the reference', button, notifications });
    assert.equal(button.textContent, 'Copy failed');
    assert.equal(notifications.said.length, 1);
  });
  await withClipboard({ writeText: async () => {} }, async () => {
    const notifications = center();
    await copyText('t', { what: 'the reference', button, notifications });
    assert.equal(button.textContent, 'Copied');
    assert.deepEqual(notifications.said, [], 'the button says it; no card besides');
  });
});
