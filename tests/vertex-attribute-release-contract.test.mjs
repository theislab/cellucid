/**
 * No vertex attribute is ever pointed at no buffer.
 *
 * Chromium's command-buffer client does not send `vertexAttribPointer` /
 * `vertexAttribIPointer` to the GPU process while no `ARRAY_BUFFER` is bound
 * (it keeps such a pointer as a client-side array), so there that call
 * leaves the vertex array holding the buffer it read: the buffer stays alive
 * after `deleteBuffer`, and while the vertex array is bound a
 * transform-feedback pass writing it fails ("A transform feedback buffer that
 * would be written to is also bound to a non-transform-feedback target").
 * Kept views of more than one store segment stopped recolouring on Chromium
 * that way. An attribute is released with `releaseVertexAttribute`
 * (`rendering/gl-utils.js`), onto a buffer the vertex array may keep.
 *
 * Every attribute pointer call in the web app is checked against the
 * `ARRAY_BUFFER` binding made before it in the same file.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { releaseVertexAttribute } from '../assets/js/rendering/gl-utils.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCES = [join(ROOT, 'assets', 'js'), join(ROOT, 'assets', 'workers')];

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.js')) yield path;
  }
}

const BIND_ARRAY_BUFFER = /\.bindBuffer\(\s*[\w.]*\.ARRAY_BUFFER\s*,\s*([^)]*?)\s*\)/g;
const ATTRIBUTE_POINTER = /\.vertexAttribI?Pointer\(/g;

/** Every attribute pointer whose last `ARRAY_BUFFER` binding before it binds `null`. */
function nullPointers(source) {
  const binds = [...source.matchAll(BIND_ARRAY_BUFFER)].map(match => ({ at: match.index, bound: match[1] }));
  const found = [];
  for (const pointer of source.matchAll(ATTRIBUTE_POINTER)) {
    let last = null;
    for (const bind of binds) {
      if (bind.at > pointer.index) break;
      last = bind;
    }
    if (last !== null && last.bound === 'null') {
      found.push(source.slice(0, pointer.index).split('\n').length);
    }
  }
  return found;
}

test('the source check finds an attribute pointed at no buffer', () => {
  assert.deepEqual(nullPointers([
    'gl.bindBuffer(gl.ARRAY_BUFFER, store);',
    'gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 4, 0);',
    'gl.bindBuffer(gl.ARRAY_BUFFER, null);',
    'gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 4, 0);',
  ].join('\n')), [4]);
});

test('no attribute in the web app is pointed at no buffer', () => {
  const offenders = [];
  let pointers = 0;
  for (const directory of SOURCES) {
    for (const path of sourceFiles(directory)) {
      const source = readFileSync(path, 'utf8');
      pointers += [...source.matchAll(ATTRIBUTE_POINTER)].length;
      for (const line of nullPointers(source)) offenders.push(`${relative(ROOT, path)}:${line}`);
    }
  }
  assert.ok(pointers > 0, 'the check reads the attribute pointers it guards');
  assert.deepEqual(offenders, [], 'release the attribute with releaseVertexAttribute (rendering/gl-utils.js)');
});

test('releaseVertexAttribute points the attribute at its holder, disables it and leaves no ARRAY_BUFFER bound', () => {
  const calls = [];
  const gl = {
    ARRAY_BUFFER: 0x8892,
    UNSIGNED_BYTE: 0x1401,
    bindBuffer: (target, buffer) => calls.push(['bindBuffer', target, buffer]),
    vertexAttribPointer: (...args) => calls.push(['vertexAttribPointer', ...args]),
    disableVertexAttribArray: location => calls.push(['disableVertexAttribArray', location]),
  };
  const holder = { holder: true };
  releaseVertexAttribute(gl, 3, holder);
  assert.deepEqual(calls, [
    ['bindBuffer', gl.ARRAY_BUFFER, holder],
    ['vertexAttribPointer', 3, 1, gl.UNSIGNED_BYTE, false, 0, 0],
    ['disableVertexAttribArray', 3],
    ['bindBuffer', gl.ARRAY_BUFFER, null],
  ]);
  assert.throws(() => releaseVertexAttribute(gl, 3, null), /never onto none/);
});
