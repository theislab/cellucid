/**
 * Programs created together compile each distinct shader once, link every
 * program before reading any status, and roll the whole batch back on any
 * failure (gl-utils `createProgramBatch`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createProgramBatch } from '../assets/js/rendering/gl-utils.js';

function fakeGl({ failLink = null } = {}) {
  const log = [];
  const live = { shaders: new Set(), programs: new Set() };
  let next = 1;
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, INTERLEAVED_ATTRIBS: 5,
    createShader(type) { const s = { id: next++, type }; live.shaders.add(s); return s; },
    shaderSource() {},
    compileShader(shader) { log.push(['compile', shader.type]); },
    getShaderParameter() { log.push(['shaderStatus']); return true; },
    getShaderInfoLog: () => '',
    deleteShader(shader) { live.shaders.delete(shader); },
    createProgram() { const p = { id: next++ }; live.programs.add(p); return p; },
    attachShader() {},
    transformFeedbackVaryings(program, varyings) { log.push(['varyings', varyings.length]); },
    linkProgram() { log.push(['link']); },
    getProgramParameter(program) { log.push(['linkStatus']); return program !== failLink?.(); },
    getProgramInfoLog: () => 'link error',
    deleteProgram(program) { live.programs.delete(program); },
  };
  return { gl, log, live };
}

test('shared shaders compile once; every link precedes every status read', () => {
  const { gl, log, live } = fakeGl();
  const programs = createProgramBatch(gl, [
    { label: 'a', vs: 'VS', fs: 'FS1', varyings: ['v'] },
    { label: 'b', vs: 'VS', fs: 'FS2' },
    { label: 'c', vs: 'VS', fs: 'FS1' },
  ]);
  assert.equal(programs.length, 3);
  assert.equal(log.filter(([name]) => name === 'compile').length, 3);
  const lastLink = log.map(([name]) => name).lastIndexOf('link');
  const firstStatus = log.map(([name]) => name).indexOf('linkStatus');
  assert.ok(lastLink < firstStatus);
  assert.equal(log.some(([name]) => name === 'shaderStatus'), false);
  assert.equal(live.shaders.size, 0, 'shaders are deleted once linked');
  assert.equal(live.programs.size, 3);
});

test('a failed link rolls back the whole batch and names the program', () => {
  let second = null;
  const { gl, live } = fakeGl({ failLink: () => second });
  const createProgram = gl.createProgram;
  let count = 0;
  gl.createProgram = () => {
    const program = createProgram();
    count += 1;
    if (count === 2) second = program;
    return program;
  };
  assert.throws(
    () => createProgramBatch(gl, [
      { label: 'first', vs: 'VS', fs: 'FS1' },
      { label: 'second', vs: 'VS', fs: 'FS2' },
    ]),
    /Could not link the second program/,
  );
  assert.equal(live.programs.size, 0);
  assert.equal(live.shaders.size, 0);
});

test('the viewer and the velocity overlay create their programs in batches', () => {
  const viewer = readFileSync(new URL('../assets/js/rendering/viewer.js', import.meta.url), 'utf8');
  assert.match(viewer, /createProgramBatch\(gl, \[\n\s*\{ label: 'grid'/);
  const velocity = readFileSync(new URL('../assets/js/rendering/overlays/velocity/velocity-overlay.js', import.meta.url), 'utf8');
  assert.match(velocity, /\] = createProgramBatch\(gl, \[/);
  assert.doesNotMatch(velocity, /createProgram\(gl,/);
});
