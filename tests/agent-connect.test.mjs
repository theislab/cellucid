/**
 * The Connect panel's words (`app/agent/connect/model.js`): one short status
 * line per state of the relay client, with the whole sentence beside it;
 * a connection's row; the approval's sentences and warnings. And what an
 * agent receives as a picture (`app/agent/bridge/mcp-content.js`): a
 * result's base64 image, marked so by its schema, as image content; one
 * larger than a chat takes, left out with a sentence.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { describeApproval, describeConnection, describeConnectStatus } from '../assets/js/app/agent/connect/model.js';
import { hasPendingConnectCode, takeConnectCode } from '../assets/js/app/agent/bridge/connect-code.js';
import { pngSides, resultDataOf, toolResultOf } from '../assets/js/app/agent/bridge/mcp-content.js';
import { RESULT_IMAGE_MAX_BYTES, RESULT_IMAGE_MAX_SIDE, VIEW_APP } from '../assets/js/app/agent/bridge/relay-protocol.js';
import { getActionCatalog } from '../assets/js/app/actions/index.js';
import { catalogDocument } from '../assets/js/app/actions/catalog.js';
import { mcpToolsOf } from '../assets/js/app/agent/bridge/mcp-tools.js';

const status = (state, extra = {}) => ({ state, error: null, retryAt: null, approvals: [], ...extra });

test('one short line per state, the whole sentence beside it', () => {
  const now = 1_000_000;
  const at = (s, context = {}) => describeConnectStatus(s, { paired: true, connections: null, now, ...context });
  assert.deepEqual(at(status('off'), { paired: false }), {
    text: 'Not connected yet',
    detail: 'Not connected. Add the connector address to Claude or ChatGPT, then approve the connection here.',
    tone: 'muted',
  });
  assert.equal(at(status('off')).text, 'Off');
  assert.equal(at(status('connecting')).text, 'Connecting…');
  assert.equal(at(status('connected')).text, 'Connected');
  assert.equal(at(status('connected'), { connections: [] }).text, 'Ready · no agent yet');
  assert.equal(at(status('connected'), { connections: [{ agent: 'Claude' }, { agent: 'Claude' }] }).text, 'Claude connected');
  assert.equal(at(status('connected'), { connections: [{ agent: 'Claude' }, { agent: 'ChatGPT' }] }).text, 'Claude and ChatGPT connected');
  assert.equal(at(status('connected'), { connections: [{ agent: 'Claude' }, { agent: 'ChatGPT' }, { agent: 'Goose' }] }).text, '3 agents connected');
  const offline = at(status('retrying', { retryAt: now + 12_000, error: 'The Cellucid relay cannot be reached.' }));
  assert.equal(offline.text, 'Offline · retrying in ~12 s');
  assert.equal(offline.tone, 'warning');
  assert.match(offline.detail, /^The Cellucid relay cannot be reached\. Trying again in ~12 s; it reconnects by itself/);
  assert.equal(at(status('retrying', { retryAt: now + 200 })).text, 'Offline · retrying now');
  assert.equal(at(status('refused')).text, 'Reload the page to reconnect');
  assert.equal(at(status('unavailable')).text, 'Unavailable: site data is blocked');
  // One line in the sidebar: every short text stays short.
  for (const state of ['off', 'connecting', 'connected', 'retrying', 'refused', 'unavailable']) {
    assert.ok(at(status(state, { retryAt: now + 3_600_000 })).text.length <= 34, state);
  }
});

test('a connection says who, through which host, since when and when last used', () => {
  const now = Date.UTC(2026, 10, 3, 12);
  assert.deepEqual(describeConnection({
    agent: 'Claude', client: 'Claude', host: 'claude.ai', createdAt: now - 3 * 86_400_000, lastUsedAt: now - 120_000,
  }, now), { title: 'Claude', meta: 'claude.ai · connected 3 d · used 2 min' });
  assert.deepEqual(describeConnection({
    agent: 'Claude Code', client: 'Claude Code (cli)', host: null, createdAt: now, lastUsedAt: now,
  }, now), { title: 'Claude Code (Claude Code (cli))', meta: 'an app on this computer · connected now · used now' });
});

test('the approval says who asks, where the answer goes, and warns about an unknown app or a typed code', () => {
  const known = describeApproval({
    display: 'ABCD-EFGH', via: 'link',
    client: { agent: 'Claude', name: 'Claude', host: 'claude.ai', redirectHost: 'claude.ai', loopback: false, known: true },
  });
  assert.equal(known.title, 'Connect Claude?');
  assert.match(known.who, /^Claude \(claude\.ai\) asks to work in Cellucid in this browser/);
  assert.equal(known.where, 'The answer goes to claude.ai.');
  assert.deepEqual(known.warnings, []);
  const typed = describeApproval({
    display: 'ABCD-EFGH', via: 'typed',
    client: { agent: 'Notes app', name: 'Notes app', host: null, redirectHost: '127.0.0.1', loopback: true, known: false },
  });
  assert.equal(typed.where, 'The answer goes to an app on this computer (127.0.0.1).');
  assert.deepEqual(typed.warnings, [
    'Allow only if you started connecting Cellucid from this app yourself, just now.',
    'Allow only a code you see on your own screen now, never one someone sent you.',
  ]);
});

/** A PNG's first bytes (signature and IHDR) for a picture of `width` × `height`, as base64. */
function pngOf(width, height, extra = 0) {
  const bytes = new Uint8Array(33 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return Buffer.from(bytes).toString('base64');
}

test('a picture read reaches an agent as an image, not as text, and the text says where it was', async () => {
  const definition = getActionCatalog().get('view.picture');
  const png = pngOf(640, 480, 300);
  assert.deepEqual(pngSides(png), { width: 640, height: 480 });
  const result = await toolResultOf({
    definition, step: null,
    outcome: { png, width: 640, height: 480, plot: { width: 640, height: 480 }, view: 'live', notes: [] },
  });
  assert.equal(result.isError, false);
  assert.equal(result.content.length, 2);
  assert.deepEqual(result.content[1], { type: 'image', data: png, mimeType: 'image/png' });
  const body = JSON.parse(resultDataOf(result.content[0].text));
  assert.deepEqual(body.png, { image: 1, mimeType: 'image/png', bytes: 333 });
  assert.equal(body.view, 'live');
  assert.ok(!result.content[0].text.includes(png));
});

test('a picture larger than a chat takes is left out with a sentence, never sent to be refused', async () => {
  const definition = getActionCatalog().get('view.picture');
  const huge = pngOf(RESULT_IMAGE_MAX_SIDE + 1, 600);
  const wide = await toolResultOf({
    definition, step: null,
    outcome: { png: huge, width: RESULT_IMAGE_MAX_SIDE + 1, height: 600, plot: { width: 100, height: 100 }, view: 'live', notes: [] },
  });
  assert.equal(wide.content.length, 1);
  assert.match(wide.content[0].text, /\[Cellucid: picture 1 is 8,001 × 600 pixels, more than a chat takes \(8,000 a side\), so it is left out\. Ask for a smaller one\.\]$/);
  const heavy = 'A'.repeat(RESULT_IMAGE_MAX_BYTES + 4);
  const big = await toolResultOf({
    definition, step: null,
    outcome: { png: heavy, width: 10, height: 10, plot: { width: 10, height: 10 }, view: 'live', notes: [] },
  });
  assert.equal(big.content.length, 1);
  assert.match(big.content[0].text, /more than a chat takes \(10,485,760 encoded\), so it is left out/);
  assert.ok(big.content[0].text.length < 1000);
});

test('the view card draws tools the catalogue has, and only those tools name it', () => {
  const tools = mcpToolsOf(catalogDocument(getActionCatalog()));
  const names = new Set(tools.map(tool => tool.name));
  assert.ok(names.has(VIEW_APP.pictureTool));
  for (const name of VIEW_APP.tools) assert.ok(names.has(name), `${name} is a tool of the catalogue`);
  assert.deepEqual(tools.filter(tool => tool._meta !== undefined).map(tool => tool.name).sort(), [...VIEW_APP.tools].sort());
});

test('a page opened with a connect code knows it before the code is taken (no welcome over the question)', () => {
  const win = { cellucidConnectFragment: 'abcd-efgh' };
  assert.equal(hasPendingConnectCode(win), true);
  assert.deepEqual(takeConnectCode(win), { code: 'ABCDEFGH', via: 'link' });
  assert.equal(hasPendingConnectCode(win), false);
  assert.equal(hasPendingConnectCode({ cellucidConnectFragment: 'nope' }), false);
  assert.equal(hasPendingConnectCode({}), false);
  assert.equal(hasPendingConnectCode(null), false);
});
