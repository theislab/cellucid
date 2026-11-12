/**
 * The tools of a local agent connection (`cellucid mcp` of the Python and R
 * packages) are the web connector's tools.
 *
 * `tests/fixtures/mcp-tools.json` is `mcpToolsDocument` of the action
 * catalog (`app/agent/bridge/local-agents.js`) as canonical JSON, written
 * by `scripts/generate-action-catalog.mjs` beside the catalog itself;
 * cellucid-python (`src/cellucid/mcp_tools.json`) and cellucid-r
 * (`inst/mcp_tools.json`) hold the one made from their own copy of the
 * catalog, and pin the same SHA-256 when their catalog is this one.
 * Its tools are exactly what the relay answers while no tab is connected
 * (the same function of the same catalog), so a connector and a local
 * connection list the same names, schemas, descriptions and annotations.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ACTION_CATALOG_MIRRORS,
  ACTION_CATALOG_PATH,
  MCP_TOOLS_MIRRORS,
  MCP_TOOLS_PATH,
  actionCatalogMirrorPaths,
  renderMcpTools,
} from '../scripts/generate-action-catalog.mjs';
import { RELAY_BUNDLE } from '../relay/generated/bundle.js';
import { catalogDocument } from '../assets/js/app/actions/catalog.js';
import { getActionCatalog } from '../assets/js/app/actions/index.js';
import { instructionsFor, toolNamesIn } from '../assets/js/app/agent/instructions.js';
import {
  LOCAL_AGENT_FALLBACK,
  LOCAL_AGENT_NAMES,
  LOCAL_STATUS_TOOL,
  MCP_TOOLS_SCHEMA,
} from '../assets/js/app/agent/bridge/local-agents.js';
import { mcpToolsOf } from '../assets/js/app/agent/bridge/mcp-tools.js';
import { RELAY_STATUS_TOOL } from '../assets/js/app/agent/bridge/relay-protocol.js';

/**
 * The digest of `mcp-tools.json`. cellucid-python (`tests/test_mcp.py`) and
 * cellucid-r (`tests/testthat/test-mcp.R`) pin the same one while their
 * catalog is this one.
 */
const MCP_TOOLS_SHA256 = '65b1e61533966676c2fb60f5c307cc00b43b0db952f044dc72fa8839297ffaa0';

const REGENERATE = 'Run node scripts/generate-action-catalog.mjs (it writes the catalogue and the local agent tools, '
  + 'here and in both packages, and prints both digests), and pin the printed digests in the three repositories\' tests.';

const sha256 = text => createHash('sha256').update(text).digest('hex');

test('mcp-tools.json is what the catalogue and the agent modules make now, at the pinned digest', () => {
  const current = readFileSync(MCP_TOOLS_PATH, 'utf8');
  assert.ok(current === renderMcpTools(readFileSync(ACTION_CATALOG_PATH, 'utf8')), `tests/fixtures/mcp-tools.json is stale. ${REGENERATE}`);
  assert.equal(sha256(current), MCP_TOOLS_SHA256, REGENERATE);
});

test('its tools are the web connector\'s: the relay\'s list while no tab is connected, name for name and field for field', () => {
  const document = JSON.parse(readFileSync(MCP_TOOLS_PATH, 'utf8'));
  assert.equal(document.schema, MCP_TOOLS_SCHEMA);
  assert.equal(document.catalogDigest, sha256(readFileSync(ACTION_CATALOG_PATH, 'utf8')));
  assert.deepEqual(document.tools, RELAY_BUNDLE.tools);
  assert.deepEqual(document.tools, mcpToolsOf(catalogDocument(getActionCatalog())));
  assert.deepEqual(document.statusTool, LOCAL_STATUS_TOOL);
  assert.equal(document.statusTool.name, RELAY_STATUS_TOOL.name, 'the status tool takes the name no action can');
  assert.ok(!document.tools.some(tool => tool.name === document.statusTool.name));
  assert.deepEqual(document.agentNames, LOCAL_AGENT_NAMES);
  assert.equal(document.agentFallback, LOCAL_AGENT_FALLBACK);
});

test('the local instructions: the shared text, a local connection section, and only tool names that exist', () => {
  const document = JSON.parse(readFileSync(MCP_TOOLS_PATH, 'utf8'));
  assert.equal(document.instructions, instructionsFor('local'));
  assert.equal(
    instructionsFor('local').split('\n\nConnection')[0],
    instructionsFor('connector').split('\n\nConnection')[0],
    'one shared text',
  );
  assert.match(document.instructions, /a Cellucid viewer on this computer/);
  assert.equal(document.instructions.includes('https://www.cellucid.com'), false, 'a local connection needs no deployed site');
  const names = new Set([...document.tools.map(tool => tool.name), document.statusTool.name]);
  for (const name of toolNamesIn(document.instructions)) assert.ok(names.has(name), `the instructions name "${name}", which is no tool`);
});

test('each package\'s copy is the document of its own catalogue copy, and the same bytes when that is this catalogue', t => {
  const catalog = readFileSync(ACTION_CATALOG_PATH, 'utf8');
  const tools = readFileSync(MCP_TOOLS_PATH, 'utf8');
  const catalogs = actionCatalogMirrorPaths(process.env, ACTION_CATALOG_MIRRORS);
  const copies = actionCatalogMirrorPaths(process.env, MCP_TOOLS_MIRRORS);
  copies.forEach((copy, index) => {
    if (copy.path === null || !existsSync(copy.path)) {
      t.diagnostic(`${copy.repository}/${copy.file} is not beside this checkout (set ${copy.env}); it is checked there`);
      return;
    }
    const own = readFileSync(catalogs[index].path, 'utf8');
    const text = readFileSync(copy.path, 'utf8');
    assert.ok(text === renderMcpTools(own), `${copy.repository}/${copy.file} is not the document of its own catalogue. ${REGENERATE}`);
    if (own === catalog) assert.ok(text === tools, `${path.basename(copy.path)} differs. ${REGENERATE}`);
  });
});
