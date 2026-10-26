/**
 * Every module of the web app links: no module imports a name another does
 * not export, or a file that is not there. One such import stops the whole
 * page from starting ("The requested module … does not provide an export
 * named …"), whatever module it is in, so every module is linked, not only
 * the ones a test happens to import.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, 'helpers', 'module-graph-link.mjs');

function link(folder) {
  const output = execFileSync(process.execPath, [CHECK, folder], { encoding: 'utf8', timeout: 120_000 });
  return JSON.parse(output.trim().split('\n').at(-1));
}

test('the check reports an import of a name that is not exported', t => {
  const folder = mkdtempSync(path.join(tmpdir(), 'cellucid-link-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(path.join(folder, 'a.js'), "export const KEPT = 1;\n");
  writeFileSync(path.join(folder, 'b.js'), "import { RENAMED } from './a.js';\nexport const B = RENAMED;\n");
  writeFileSync(path.join(folder, 'c.js'), "globalThis.window.document;\n");
  const result = link(folder);
  assert.equal(result.modules, 3);
  assert.deepEqual(result.failures.map(failure => failure.module), ['b.js']);
  assert.match(result.failures[0].message, /RENAMED/);
});

test('every module under assets/js links', () => {
  const result = link(path.join(HERE, '..', 'assets', 'js'));
  assert.ok(result.modules > 100, `found ${result.modules} modules`);
  assert.deepEqual(result.failures, []);
});
