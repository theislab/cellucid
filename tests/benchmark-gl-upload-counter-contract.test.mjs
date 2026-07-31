import assert from 'node:assert/strict';
import test from 'node:test';

import {
  instrumentGlUploads,
  INSTRUMENTED_METHOD_NAMES,
  uploadCounterFields
} from '../assets/js/app/ui/modules/benchmark/gl-upload-counter.js';

const GL_ENUMS = Object.freeze({
  ARRAY_BUFFER: 0x8892,
  ELEMENT_ARRAY_BUFFER: 0x8893,
  DYNAMIC_DRAW: 0x88e8,
  STATIC_DRAW: 0x88e4,
  TEXTURE_2D: 0x0de1,
  RED: 0x1903,
  RED_INTEGER: 0x8d94,
  RG: 0x8227,
  RGB: 0x1907,
  RGBA: 0x1908,
  RGBA_INTEGER: 0x8d99,
  UNSIGNED_BYTE: 0x1401,
  UNSIGNED_INT: 0x1405,
  FLOAT: 0x1406,
  HALF_FLOAT: 0x140b,
  R8: 0x8229,
  POINTS: 0x0000,
  TRIANGLES: 0x0004
});

/**
 * A context whose methods live on a prototype, exactly like a real
 * `WebGL2RenderingContext`. Instrumentation must shadow the prototype methods
 * with own properties and remove those own properties on restore.
 */
class FakeWebGL2Context {
  constructor() {
    this.calls = [];
    Object.assign(this, GL_ENUMS);
  }

  bufferData(...args) {
    this.calls.push(['bufferData', args.length]);
    return 'bufferData';
  }

  bufferSubData(...args) {
    this.calls.push(['bufferSubData', args.length]);
    return 'bufferSubData';
  }

  texImage2D(...args) {
    this.calls.push(['texImage2D', args.length]);
    return 'texImage2D';
  }

  texSubImage2D(...args) {
    this.calls.push(['texSubImage2D', args.length]);
    return 'texSubImage2D';
  }

  drawArrays(...args) {
    this.calls.push(['drawArrays', args.length]);
    return 'drawArrays';
  }

  drawElements(...args) {
    this.calls.push(['drawElements', args.length]);
    return 'drawElements';
  }

  drawArraysInstanced(...args) {
    this.calls.push(['drawArraysInstanced', args.length]);
    return 'drawArraysInstanced';
  }

  drawElementsInstanced(...args) {
    this.calls.push(['drawElementsInstanced', args.length]);
    return 'drawElementsInstanced';
  }

  getError() {
    this.calls.push(['getError', 0]);
    return 0;
  }

  finish() {
    this.calls.push(['finish', 0]);
  }

  flush() {
    this.calls.push(['flush', 0]);
  }

  readPixels(...args) {
    this.calls.push(['readPixels', args.length]);
  }

  getBufferSubData(...args) {
    this.calls.push(['getBufferSubData', args.length]);
  }
}

test('instrumentation shadows the prototype and restores it exactly', () => {
  const gl = new FakeWebGL2Context();
  const prototypeMethods = new Map(
    INSTRUMENTED_METHOD_NAMES.map(name => [name, gl[name]])
  );
  for (const name of INSTRUMENTED_METHOD_NAMES) {
    assert.equal(
      Object.hasOwn(gl, name),
      false,
      `${name} must start on the prototype`
    );
  }

  const handle = instrumentGlUploads(gl);
  assert.equal(handle.installed, true);
  for (const name of INSTRUMENTED_METHOD_NAMES) {
    assert.equal(Object.hasOwn(gl, name), true, `${name} must be shadowed`);
    assert.notEqual(gl[name], prototypeMethods.get(name));
  }

  handle.restore();
  assert.equal(handle.installed, false);
  for (const name of INSTRUMENTED_METHOD_NAMES) {
    assert.equal(
      Object.hasOwn(gl, name),
      false,
      `${name} must be handed back to the prototype`
    );
    assert.equal(gl[name], prototypeMethods.get(name));
  }
  handle.restore();
});

test('the wrapped call reaches the original with its exact arity', () => {
  const gl = new FakeWebGL2Context();
  const handle = instrumentGlUploads(gl);
  const indices = new Uint32Array(64);

  assert.equal(
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW),
    'bufferData'
  );
  gl.bufferData(gl.ARRAY_BUFFER, 4096, gl.STATIC_DRAW);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, indices);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, indices, 8);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, indices, 8, 16);
  gl.drawArrays(gl.POINTS, 0, 1000);
  gl.getError();

  assert.deepEqual(gl.calls, [
    ['bufferData', 3],
    ['bufferData', 3],
    ['bufferSubData', 3],
    ['bufferSubData', 4],
    ['bufferSubData', 5],
    ['drawArrays', 3],
    ['getError', 0]
  ]);
  handle.restore();
});

test('element-buffer reallocation is counted apart from vertex traffic', () => {
  // The suspected defect is a full element-buffer store reallocation on every
  // frame of camera motion. Separating the element target from the vertex one
  // is what makes that claim checkable instead of arguable.
  const gl = new FakeWebGL2Context();
  const handle = instrumentGlUploads(gl);
  const visibleIndices = new Uint32Array(20_000_000);

  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, visibleIndices, gl.DYNAMIC_DRAW);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(300), gl.STATIC_DRAW);

  assert.equal(handle.frame.elementBufferStoreAllocations, 1);
  assert.equal(handle.frame.elementBufferStoreAllocationBytes, 80_000_000);
  assert.equal(handle.frame.bufferStoreAllocations, 2);
  assert.equal(handle.frame.bufferStoreAllocationBytes, 80_000_000 + 1200);
  handle.restore();
});

test('a sizing bufferData counts as a reallocation carrying no data', () => {
  const gl = new FakeWebGL2Context();
  const handle = instrumentGlUploads(gl);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, 80_000_000, gl.DYNAMIC_DRAW);
  assert.equal(handle.frame.elementBufferStoreAllocations, 1);
  assert.equal(handle.frame.elementBufferStoreAllocationBytes, 80_000_000);
  assert.equal(handle.frame.bufferSubUpdates, 0);
  handle.restore();
});

test('the element-range forms are measured by elements, not by view length', () => {
  const gl = new FakeWebGL2Context();
  const handle = instrumentGlUploads(gl);
  const source = new Uint32Array(1000);

  gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, source, 100, 250);
  assert.equal(handle.frame.elementBufferSubUpdateBytes, 1000);
  handle.closeFrame();

  gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, source, 100);
  assert.equal(handle.frame.elementBufferSubUpdateBytes, 3600);
  handle.closeFrame();

  gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, source);
  assert.equal(handle.frame.elementBufferSubUpdateBytes, 4000);
  assert.equal(handle.total.elementBufferSubUpdateBytes, 4600);
  handle.restore();
});

test('texture uploads are sized from the call, or declared unmeasured', () => {
  const gl = new FakeWebGL2Context();
  const handle = instrumentGlUploads(gl);

  // 16384 x 1 R8 row: the shape the alpha texture streams in.
  gl.texSubImage2D(
    gl.TEXTURE_2D, 0, 0, 5, 16384, 1, gl.RED, gl.UNSIGNED_BYTE,
    new Uint8Array(16384)
  );
  assert.equal(handle.frame.textureUploads, 1);
  assert.equal(handle.frame.textureUploadBytes, 16384);
  assert.equal(handle.frame.textureUploadsWithUnmeasuredBytes, 0);

  // An RGBA32F allocation: four bytes per channel.
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA, 1024, 512, 0, gl.RGBA, gl.FLOAT, null
  );
  assert.equal(handle.frame.textureUploadBytes, 16384 + 1024 * 512 * 16);

  // A DOM-source upload carries no width, height, format or type. It is
  // counted as an upload of unknown volume rather than guessed at.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, {});
  assert.equal(handle.frame.textureUploads, 3);
  assert.equal(handle.frame.textureUploadsWithUnmeasuredBytes, 1);
  handle.restore();
});

test('synchronous GL points are counted so a per-frame stall is visible', () => {
  const gl = new FakeWebGL2Context();
  const handle = instrumentGlUploads(gl);
  gl.getError();
  gl.getError();
  gl.finish();
  gl.flush();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  gl.getBufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(4));

  assert.equal(handle.frame.getErrorCalls, 2);
  assert.equal(handle.frame.finishCalls, 1);
  assert.equal(handle.frame.flushCalls, 1);
  assert.equal(handle.frame.readPixelsCalls, 1);
  assert.equal(handle.frame.getBufferSubDataCalls, 1);
  assert.equal(handle.frame.syncStalls, 6);
  handle.restore();
});

test('every draw entry point contributes to the same draw-call counter', () => {
  const gl = new FakeWebGL2Context();
  const handle = instrumentGlUploads(gl);
  gl.drawArrays(gl.POINTS, 0, 10);
  gl.drawElements(gl.TRIANGLES, 30, gl.UNSIGNED_INT, 0);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 100);
  gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_INT, 0, 100);
  assert.equal(handle.frame.drawCalls, 4);
  handle.restore();
});

test('closing a frame folds it into the totals and clears the frame', () => {
  const gl = new FakeWebGL2Context();
  const handle = instrumentGlUploads(gl);
  const fields = uploadCounterFields();
  assert.ok(fields.includes('elementBufferStoreAllocations'));

  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(10), gl.DYNAMIC_DRAW);
  const frameRecord = handle.frame;
  handle.closeFrame();
  assert.equal(handle.frame, frameRecord, 'the frame record is reused');
  assert.equal(handle.frame.elementBufferStoreAllocations, 0);
  assert.equal(handle.total.elementBufferStoreAllocations, 1);
  assert.equal(handle.total.elementBufferStoreAllocationBytes, 40);

  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(10), gl.DYNAMIC_DRAW);
  handle.closeFrame();
  assert.equal(handle.total.elementBufferStoreAllocations, 2);

  handle.reset();
  for (const field of fields) {
    assert.equal(handle.total[field], 0, `${field} must reset`);
    assert.equal(handle.frame[field], 0, `${field} must reset`);
  }
  handle.restore();
});

test('an own descriptor present before instrumentation is restored verbatim', () => {
  const gl = new FakeWebGL2Context();
  const prototypeBufferData = gl.bufferData;
  const ownBufferData = function ownBufferData(...args) {
    return prototypeBufferData.apply(this, args);
  };
  Object.defineProperty(gl, 'bufferData', {
    value: ownBufferData,
    writable: true,
    configurable: true,
    enumerable: false
  });

  const handle = instrumentGlUploads(gl);
  assert.notEqual(gl.bufferData, ownBufferData);
  handle.restore();
  assert.equal(gl.bufferData, ownBufferData);
});

test('instrumentation refuses anything that is not a GL context', () => {
  assert.throws(() => instrumentGlUploads(null), /WebGL rendering context/);
  assert.throws(() => instrumentGlUploads({}), /WebGL rendering context/);
  const partial = { bufferData() {}, getError() {} };
  assert.throws(
    () => instrumentGlUploads(partial),
    /requires context method/
  );
});
