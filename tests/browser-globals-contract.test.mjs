/**
 * Browser code never names a Node-only global.
 *
 * Every module under `assets/js` runs in a browser page or worker; the Node
 * contract suite runs the same modules in Node, where `process`, `require`,
 * `Buffer`, `__dirname` and `__filename` exist. A bare reference to one of
 * them passes every Node test and throws a `ReferenceError` in every browser
 * the moment it runs: a debugging line reading `process.env` in the share
 * planner once stopped every converted store from opening in browsers while
 * the whole Node suite stayed green.
 *
 * Code that must reach a Node facility asks for it as a property of
 * `globalThis` behind a check (`globalThis.process?.getBuiltinModule`), which
 * is `undefined` in a browser rather than an error; `typeof process` is safe
 * too. esbuild's `define` replaces exactly the free (unbound) references of a
 * name, never a local binding, a property, a comment or a string, so the
 * markers it leaves are the references a browser cannot resolve.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { transformSync } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Globals Node defines and browsers do not. */
const NODE_ONLY = ['process', 'require', 'Buffer', '__dirname', '__filename', 'global', 'module', 'exports'];

function scripts(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...scripts(location));
    else if (/\.m?js$/.test(entry.name)) found.push(location);
  }
  return found;
}

const marker = name => `__cellucid_node_global_${name}__`;

/** The Node-only globals `source` references unguarded, as `name:line` strings. */
function nodeGlobals(source, file) {
  const define = Object.fromEntries(NODE_ONLY.map(name => [name, marker(name)]));
  const { code } = transformSync(source, {
    format: 'esm', loader: 'js', logLevel: 'silent', sourcefile: file, define,
  });
  const found = [];
  code.split('\n').forEach((line, index) => {
    for (const name of NODE_ONLY) {
      const pattern = new RegExp(`(typeof\\s+)?${marker(name)}`, 'g');
      for (const match of line.matchAll(pattern)) {
        if (match[1] === undefined) found.push(`${name}:${index + 1}`);
      }
    }
  });
  return found;
}

test('the detector finds free references and nothing else', () => {
  for (const source of [
    'if (process.env.DEBUG) console.log(1);',
    'const fs = require("node:fs");',
    'export const bytes = Buffer.from([1]);',
    'export const here = __dirname;',
    'export function f() { return process.argv; }',
  ]) {
    assert.notEqual(nodeGlobals(source, 'probe.js').length, 0, source);
  }
  for (const source of [
    'const fs = globalThis.process?.getBuiltinModule?.("node:fs");',
    'export const node = typeof process !== "undefined";',
    'export function f(process) { return process.next(); }',
    'const require = name => name; require("x");',
    '// process.env.DEBUG\nexport const text = "process.env and require(x) and Buffer";',
    'export const step = { process: 1 }.process;',
    'class A { process() {} } new A().process();',
  ]) {
    assert.deepEqual(nodeGlobals(source, 'probe.js'), [], source);
  }
});

test('no browser module references a Node-only global', () => {
  const files = scripts(path.join(ROOT, 'assets', 'js'));
  assert.ok(files.length > 100, 'the application sources are found');
  const found = files.flatMap(file => nodeGlobals(readFileSync(file, 'utf8'), file)
    .map(where => `${path.relative(ROOT, file)} ${where}`));
  assert.deepEqual(found, [], 'browser modules reference Node-only globals (a ReferenceError in every browser)');
});
