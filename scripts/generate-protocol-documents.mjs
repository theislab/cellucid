/**
 * The two shared documents that are a module's own text:
 *
 * - `tests/fixtures/input-formats.json`: the input-format registry
 *   (`assets/js/data/input-formats.js` `inputFormatsJson`);
 * - `tests/fixtures/viewer-protocol.json`: the viewer protocol
 *   (`assets/js/data/viewer-protocol.js` `viewerProtocolJson`).
 *
 *   node scripts/generate-protocol-documents.mjs           # write both
 *   node scripts/generate-protocol-documents.mjs --check   # exit 1 when one is stale
 *
 * It writes this repository's files; `node scripts/sync-shared-files.mjs`
 * runs it and copies them into cellucid-python and cellucid-r.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inputFormatsJson } from '../assets/js/data/input-formats.js';
import { viewerProtocolJson } from '../assets/js/data/viewer-protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Each document: its file here and the text its module makes now. */
export const PROTOCOL_DOCUMENTS = Object.freeze([
  Object.freeze({ file: 'tests/fixtures/input-formats.json', render: inputFormatsJson }),
  Object.freeze({ file: 'tests/fixtures/viewer-protocol.json', render: viewerProtocolJson }),
]);

async function main() {
  const flags = process.argv.slice(2);
  const unknown = flags.filter(flag => flag !== '--check');
  if (unknown.length > 0) throw new Error(`Unknown argument ${unknown[0]}; the only one is --check`);
  const check = flags.includes('--check');
  let stale = 0;
  for (const document of PROTOCOL_DOCUMENTS) {
    const target = path.join(ROOT, document.file);
    const text = document.render();
    const current = await readFile(target, 'utf8').catch(error => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
    if (current === text) {
      console.log(`current ${document.file}`);
    } else if (check) {
      console.log(`stale   ${document.file}`);
      stale += 1;
    } else {
      await writeFile(target, text);
      console.log(`wrote   ${document.file}`);
    }
  }
  if (stale > 0) {
    console.log('Run node scripts/sync-shared-files.mjs.');
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
