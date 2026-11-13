/**
 * The relay stays in step with the web app it serves.
 *
 * `relay/generated/bundle.js` is what the deployed relay knows of the web
 * app: the wire protocol shared with the tab, the action catalog as MCP
 * tools (its answer while no tab is connected), the agent instructions, the
 * Cellucid version. It is generated (`scripts/generate-relay-bundle.mjs`) and
 * must equal what the sources make now: an action added or changed, an
 * instruction edited or a version bumped without regenerating fails here,
 * naming the command. The deployment configuration and the relay's
 * independence from the browser tree are pinned too.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RELAY_BUNDLE_PATH, renderRelayBundle } from '../scripts/generate-relay-bundle.mjs';
import { RELAY_BUNDLE } from '../relay/generated/bundle.js';
import * as relayWorker from '../relay/worker.js';
import { DEFAULT_RELAY_ORIGIN } from '../assets/js/app/agent/bridge/relay-client.js';
import { parseExactJson } from '../assets/js/app/community-annotations/wire-contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFileSync(path.join(ROOT, relative), 'utf8');

function jsonc(text) {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
}

test('the relay bundle is what the web sources make now', async () => {
  const expected = await renderRelayBundle();
  const current = readFileSync(RELAY_BUNDLE_PATH, 'utf8');
  assert.ok(current === expected, 'relay/generated/bundle.js is stale: run node scripts/generate-relay-bundle.mjs');
  const index = read('index.html');
  assert.ok(index.includes(`<meta name="cellucid-version" content="${RELAY_BUNDLE.appVersion}" /> <!-- CELLUCID_VERSION -->`));
  assert.equal(RELAY_BUNDLE.appOrigin, 'https://www.cellucid.com');
  assert.ok(Object.isFrozen(RELAY_BUNDLE) && Object.isFrozen(RELAY_BUNDLE.tools));
});

test('the relay is deployed from its own folder with its Durable Objects, and never imports the browser tree', () => {
  const config = jsonc(read('wrangler.relay.jsonc'));
  assert.equal(config.name, 'cellucid-relay');
  assert.equal(config.main, 'relay/worker.js');
  assert.deepEqual(config.compatibility_flags, ['enable_request_signal']);
  // The hibernation API answers close frames itself from 2026-04-07.
  assert.ok(config.compatibility_date >= '2026-04-07');
  assert.equal(config.preview_urls, false, 'one address: OAuth issuer and MCP resource are its URL');
  // Served on its own Cloudflare custom domain only: the connector address is
  // https://mcp.cellucid.com, and the OAuth issuer is the one address it answers at.
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.routes, [{ pattern: 'mcp.cellucid.com', custom_domain: true }]);
  assert.equal(Object.hasOwn(config, 'limits'), false, 'a CPU limit is a paid-plan setting');
  assert.equal(Object.hasOwn(config, 'vars'), false, 'settings are secrets');
  const bindings = config.durable_objects.bindings;
  assert.deepEqual(bindings, [{ name: 'PAIRING', class_name: 'RelayPairing' }, { name: 'APPROVAL', class_name: 'RelayApproval' }]);
  // The Workers Free plan has Durable Objects on SQLite storage only.
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['RelayPairing', 'RelayApproval'] }]);
  for (const { class_name: name } of bindings) assert.equal(typeof relayWorker[name], 'function', `${name} is exported by relay/worker.js`);
  assert.equal(typeof relayWorker.default.fetch, 'function');

  for (const file of readdirSync(path.join(ROOT, 'relay'), { recursive: true })) {
    if (!String(file).endsWith('.js')) continue;
    const source = read(path.join('relay', String(file)));
    for (const match of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/gm)) {
      assert.ok(match[1].startsWith('./'), `relay/${file} imports ${match[1]}: the relay depends on its own folder only (the web sources reach it through the bundle)`);
    }
  }
  // The tab talks to the relay this configuration deploys.
  assert.equal(DEFAULT_RELAY_ORIGIN, `https://${config.routes[0].pattern}`);
});

test('the relay bundle check is an npm script pinned to the annotation Worker\'s Wrangler, run in CI', () => {
  const manifest = parseExactJson(read('package.json'), { path: 'Web package manifest' });
  const worker = manifest.scripts['test:worker-bundle'];
  const relay = manifest.scripts['test:relay-bundle'];
  assert.equal(relay, 'npx --yes wrangler@4.115.0 deploy --dry-run --config wrangler.relay.jsonc');
  assert.equal(relay.match(/wrangler@[\d.]+/)[0], worker.match(/wrangler@[\d.]+/)[0]);
  assert.match(read('.github/workflows/test.yml'), /if: matrix\.os == 'ubuntu-latest' && matrix\.node == '24'\n\s+run: npm run test:relay-bundle/);
  const readme = read('relay/README.md');
  assert.ok(readme.includes('npx --yes wrangler@4.115.0'));
});

test('the relay README lists every route the Worker answers', () => {
  const readme = read('relay/README.md');
  const worker = read('relay/worker.js');
  const routes = [...worker.matchAll(/case '(\/[^']*)':/g)].map(match => match[1]);
  assert.ok(routes.length >= 10);
  for (const route of new Set(['/', ...routes])) assert.ok(readme.includes(`\`${route}\``), `relay/README.md documents ${route}`);
  // MCP is answered at the root (the connector address is the bare origin); `/mcp` is gone.
  assert.ok(!routes.includes('/mcp') && !readme.includes('`/mcp`'), 'relay/README.md names no /mcp route');
});
