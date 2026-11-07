/**
 * relay/server.json: the entry for the official MCP Registry
 * (registry.modelcontextprotocol.io), which Claude, ChatGPT, VS Code and the
 * other MCP directories read to find servers. It is published by hand with
 * `mcp-publisher publish relay/server.json` (the owner's step; the relay
 * README says how), so this suite keeps it true between publishes:
 *
 * - The shape of schema 2025-12-11 that the registry enforces: `name`
 *   (`<namespace>/<name>`, one slash), a description of 100 characters at most,
 *   an exact version (no range), HTTPS icons of the allowed types.
 * - The namespace is the domain, `com.cellucid/`, proven by a DNS TXT record on
 *   cellucid.com (the apex redirects to www, so the registry's HTTP proof, which
 *   follows no redirect, cannot work there).
 * - The remote is the address the relay is deployed at (wrangler.relay.jsonc),
 *   Streamable HTTP, and the version is the release the web app declares.
 * - Every icon is a file this site serves, at the size it declares.
 */
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFile(path.join(ROOT, name), 'utf8');
const SERVER = JSON.parse(await read('relay/server.json'));
const INDEX = await read('index.html');
const SITE = 'https://www.cellucid.com/';

test('the registry entry has the shape schema 2025-12-11 requires', () => {
  assert.equal(SERVER.$schema, 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
  for (const key of ['name', 'description', 'version']) assert.equal(typeof SERVER[key], 'string', key);
  const allowed = ['$schema', '_meta', 'description', 'icons', 'name', 'packages', 'remotes', 'repository', 'title', 'version', 'websiteUrl'];
  for (const key of Object.keys(SERVER)) assert.ok(allowed.includes(key), `${key} is a server.json property`);
  assert.match(SERVER.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  assert.ok(SERVER.name.length >= 3 && SERVER.name.length <= 200);
  assert.ok(SERVER.description.length >= 1 && SERVER.description.length <= 100, `description is ${SERVER.description.length} characters`);
  assert.ok(SERVER.title.length >= 1 && SERVER.title.length <= 100);
  assert.match(SERVER.version, /^\d+\.\d+\.\d+$/, 'an exact version, never a range');
  // Only this _meta key is kept by the registry, up to 4 KB.
  assert.deepEqual(Object.keys(SERVER._meta), ['io.modelcontextprotocol.registry/publisher-provided']);
  assert.ok(Buffer.byteLength(JSON.stringify(SERVER._meta['io.modelcontextprotocol.registry/publisher-provided'])) <= 4096);
});

test('the entry names the cellucid.com namespace, the deployed relay and this release', async () => {
  assert.equal(SERVER.name, 'com.cellucid/cellucid');
  assert.equal(SERVER.title, 'Cellucid');
  const route = /"pattern":\s*"([^"]+)",\s*"custom_domain":\s*true/.exec(await read('wrangler.relay.jsonc'))[1];
  assert.deepEqual(SERVER.remotes, [{ type: 'streamable-http', url: `https://${route}` }]);
  assert.equal('packages' in SERVER, false, 'a remote server: nothing to install');
  const version = /<meta name="cellucid-version" content="([^"]+)" \/> <!-- CELLUCID_VERSION -->/.exec(INDEX)[1];
  assert.equal(SERVER.version, version);
  // JSON has no comments: the version sweep finds the marker as a field, as it
  // does in npm/package.json.
  assert.deepEqual(SERVER._meta['io.modelcontextprotocol.registry/publisher-provided'], { 'cellucid-version-marker': 'CELLUCID_VERSION' });
  assert.equal(SERVER.websiteUrl, SITE);
  assert.deepEqual(SERVER.repository, { url: 'https://github.com/theislab/cellucid', source: 'github', subfolder: 'relay' });
  await stat(path.join(ROOT, SERVER.repository.subfolder, 'worker.js'));
  // The relay's own serverInfo names the same server.
  const mcp = await read('relay/mcp.js');
  assert.match(mcp, /const SERVER_INFO = Object\.freeze\(\{\n  name: 'cellucid',\n  title: 'Cellucid',/);
});

test('every icon is a file this site serves, of the type and size it declares', async () => {
  assert.ok(SERVER.icons.length > 0);
  for (const icon of SERVER.icons) {
    assert.ok(icon.src.startsWith(SITE) && icon.src.length <= 255, icon.src);
    assert.ok(['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp'].includes(icon.mimeType));
    for (const size of icon.sizes) assert.match(size, /^(\d+x\d+|any)$/);
    const bytes = await readFile(path.join(ROOT, icon.src.slice(SITE.length)));
    if (icon.mimeType === 'image/png') {
      assert.deepEqual(icon.sizes, [`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`], icon.src);
    } else {
      assert.equal(icon.mimeType, 'image/svg+xml');
      assert.deepEqual(icon.sizes, ['any']);
      assert.match(bytes.toString('utf8'), /<svg\b/);
    }
  }
});
