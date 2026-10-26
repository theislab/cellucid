import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deleteGlObject,
  deleteProgramReleasingUse,
  deleteTextureTracked,
  restorableTexture,
} from '../assets/js/rendering/gl-utils.js';

/**
 * Re-binding a deleted object raises INVALID_OPERATION (0x502), and nothing
 * reads it where it happens: the next owner to read the error queue (a
 * dataset switch's renderer load) fails with it. Two ways a deleted object
 * came back:
 *
 * WebGL keeps a deleted program current, and `CURRENT_PROGRAM` keeps naming
 * it. An owner that saves and restores the current program then hands a
 * deleted object to `useProgram`: INVALID_OPERATION (0x502), unread there,
 * so the next owner to read the error queue fails with it.
 */
function fakeGl(current) {
  const calls = [];
  return {
    CURRENT_PROGRAM: 0x8b8d,
    calls,
    getParameter(parameter) {
      assert.equal(parameter, 0x8b8d);
      return current;
    },
    useProgram(program) {
      calls.push(['useProgram', program]);
      current = program;
    },
    deleteProgram(program) {
      calls.push(['deleteProgram', program]);
    },
  };
}

test('deleting the current program unbinds it first', () => {
  const program = { id: 'p' };
  const gl = fakeGl(program);
  deleteProgramReleasingUse(gl, program);
  assert.deepEqual(gl.calls, [['useProgram', null], ['deleteProgram', program]]);
});

test('deleting another program leaves the current one in use', () => {
  const current = { id: 'current' };
  const other = { id: 'other' };
  const gl = fakeGl(current);
  deleteProgramReleasingUse(gl, other);
  deleteProgramReleasingUse(gl, null);
  assert.deepEqual(gl.calls, [['deleteProgram', other]]);
});

test('a saved binding of a deleted texture is not restored', () => {
  // Chrome keeps reporting a texture bound to TEXTURE_3D or TEXTURE_2D_ARRAY
  // on a unit after it is deleted, when that unit is beyond the last one it
  // counts as holding a 2D or cube-map texture (measured on Metal Chromium).
  const live = { id: 'live' };
  const gone = { id: 'gone' };
  const deleted = [];
  const gl = { deleteTexture: texture => deleted.push(texture) };
  deleteTextureTracked(gl, gone);
  deleteTextureTracked(gl, null);
  assert.deepEqual(deleted, [gone]);
  assert.equal(restorableTexture(gone), null);
  assert.equal(restorableTexture(live), live);
  assert.equal(restorableTexture(null), null);
});

test('objects deleted by method name go through the same owners', () => {
  const program = { id: 'program' };
  const texture = { id: 'texture' };
  const buffer = { id: 'buffer' };
  const calls = [];
  const gl = {
    CURRENT_PROGRAM: 0x8b8d,
    getParameter: () => program,
    useProgram: value => calls.push(['useProgram', value]),
    deleteProgram: value => calls.push(['deleteProgram', value]),
    deleteTexture: value => calls.push(['deleteTexture', value]),
    deleteBuffer: value => calls.push(['deleteBuffer', value]),
  };
  deleteGlObject(gl, 'deleteProgram', program);
  deleteGlObject(gl, 'deleteTexture', texture);
  deleteGlObject(gl, 'deleteBuffer', buffer);
  assert.deepEqual(calls, [
    ['useProgram', null],
    ['deleteProgram', program],
    ['deleteTexture', texture],
    ['deleteBuffer', buffer],
  ]);
  assert.equal(restorableTexture(texture), null);
});

test('renderers delete programs and textures only through the helpers', () => {
  const root = fileURLToPath(new URL('../assets/js/rendering/', import.meta.url));
  const files = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.js')) files.push(full);
    }
  };
  walk(root);
  walk(fileURLToPath(new URL('../assets/js/app/ui/modules/figure-export/', import.meta.url)));
  const direct = [];
  for (const file of files) {
    const relative = path.relative(root, file);
    // gl-utils owns both deletions (and deletes programs it has just created
    // and never used); the point renderer unbinds its own programs before
    // retiring them (`_markProgramUnbindIfOwned`).
    if (relative === 'gl-utils.js') continue;
    const source = readFileSync(file, 'utf8');
    const pattern = relative === 'high-perf-renderer.js'
      ? /\bgl\.deleteTexture\(/g
      : /\bgl\.delete(?:Program|Texture)\(/g;
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      direct.push(`${relative}:${line}`);
    }
  }
  assert.deepEqual(direct, []);
});
