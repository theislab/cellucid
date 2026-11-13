#!/usr/bin/env node
/**
 * Write the action catalog document (`catalogDocument` of every action
 * definition, `assets/js/app/actions/`) as canonical JSON, the one file
 * Python and R generate their viewer methods from:
 *
 * - `tests/fixtures/action-catalog.json` (this repository),
 * - `src/cellucid/action_catalog.json` in cellucid-python,
 * - `inst/action_catalog.json` in cellucid-r,
 *
 * byte for byte the same, compared by `tests/shared-files-contract.test.mjs` and held
 * (`tests/action-catalog-document-contract.test.mjs`, cellucid-python's
 * `tests/test_action_catalog.py`, cellucid-r's
 * `tests/testthat/test-actions.R`).
 *
 * Beside it, the same run writes the catalog as the tools of a local agent
 * connection (`cellucid mcp`; `app/agent/bridge/local-agents.js`
 * `mcpToolsDocument`: the tools, the instructions, the status tool, the app
 * names) as canonical JSON: `tests/fixtures/mcp-tools.json`,
 * `src/cellucid/mcp_tools.json` and `inst/mcp_tools.json`, made from that
 * catalog text, so the two stay one pair wherever they are regenerated
 * (`tests/mcp-tools-document-contract.test.mjs`, cellucid-python's
 * `tests/test_mcp.py`, cellucid-r's `tests/testthat/test-mcp.R`).
 *
 *   node scripts/generate-action-catalog.mjs           # write all three
 *   node scripts/generate-action-catalog.mjs --check   # exit 1 when one is stale
 *
 * The sibling repositories are found next to this one, or where
 * `CELLUCID_PYTHON_ROOT` and `CELLUCID_R_ROOT` say; one that is not there is
 * named and skipped (`scripts/shared-files.mjs` lists the copies). After
 * writing, regenerate what the two packages build from it:
 * `python scripts/generate_actions.py` (cellucid-python) and
 * `Rscript tools/generate-actions.R` (cellucid-r).
 *
 * Canonical: object keys sorted, two-space indent, one trailing newline, so
 * the bytes depend on the catalog alone, never on the order a definition
 * lists its keys in.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { catalogDocument, createActionCatalog } from '../assets/js/app/actions/catalog.js';
import { ACTION_DEFINITIONS } from '../assets/js/app/actions/definitions/index.js';
import { mcpToolsDocument } from '../assets/js/app/agent/bridge/local-agents.js';
import { copyPaths, sharedFile } from './shared-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ACTION_CATALOG_PATH = path.join(ROOT, 'tests', 'fixtures', 'action-catalog.json');


/** `value` with every object's keys sorted (arrays keep their order). */
export function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])]));
  }
  return value;
}

/** The catalog document's canonical text, as this checkout's definitions make it. */
export function renderActionCatalog() {
  const document = catalogDocument(createActionCatalog(ACTION_DEFINITIONS));
  return `${JSON.stringify(sortedKeys(document), null, 2)}\n`;
}

/** The SHA-256 of the canonical text: the `catalogDigest` the agents' tools document names its catalog by. */
export function actionCatalogDigest(text = renderActionCatalog()) {
  return createHash('sha256').update(text).digest('hex');
}

export const MCP_TOOLS_PATH = path.join(ROOT, 'tests', 'fixtures', 'mcp-tools.json');


/**
 * The local agent tools document's canonical text, made from a catalog's
 * canonical text (this checkout's by default): the tools of exactly that
 * catalog, and its digest.
 */
export function renderMcpTools(catalogText = renderActionCatalog()) {
  const document = mcpToolsDocument(JSON.parse(catalogText), actionCatalogDigest(catalogText));
  return `${JSON.stringify(sortedKeys(document), null, 2)}\n`;
}


async function readOrNull(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function main() {
  const check = process.argv.includes('--check');
  const unknown = process.argv.slice(2).filter(argument => argument !== '--check');
  if (unknown.length > 0) throw new Error(`Unknown argument ${unknown[0]}; the only one is --check`);
  const text = renderActionCatalog();
  const tools = renderMcpTools(text);
  const targets = [
    { repository: 'cellucid', path: ACTION_CATALOG_PATH, text },
    ...copyPaths(sharedFile('tests/fixtures/action-catalog.json')).map(target => ({ ...target, text })),
    { repository: 'cellucid', path: MCP_TOOLS_PATH, text: tools },
    ...copyPaths(sharedFile('tests/fixtures/mcp-tools.json')).map(target => ({ ...target, text: tools })),
  ];
  let stale = 0;
  for (const target of targets) {
    if (target.path === null) {
      console.log(`skipped ${target.repository}: not found (set ${target.env})`);
      continue;
    }
    const current = await readOrNull(target.path);
    if (current === target.text) {
      console.log(`current ${path.relative(path.join(ROOT, '..'), target.path)}`);
      continue;
    }
    if (check) {
      stale += 1;
      console.log(`stale   ${path.relative(path.join(ROOT, '..'), target.path)}`);
      continue;
    }
    await writeFile(target.path, target.text);
    console.log(`wrote   ${path.relative(path.join(ROOT, '..'), target.path)}`);
  }
  if (stale > 0) {
    console.log('Run node scripts/generate-action-catalog.mjs and regenerate the packages\' methods.');
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
