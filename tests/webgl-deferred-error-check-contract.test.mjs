/**
 * Deferred WebGL error checks (`rendering/gl-errors.js`): a batch made often
 * is checked in a later frame, once the GPU has passed a fence after it, so
 * the read waits for nothing; a failure is never silent and is attributed to
 * the earliest outstanding batch whose run, call by call, names it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cancelDeferredWebGLErrorChecks,
  claimWebGLErrorForDeferredChecks,
  deferWebGLErrorCheck,
  requireCleanWebGLState,
} from '../assets/js/rendering/gl-errors.js';

const INVALID_OPERATION = 0x502;

/** A context whose fences signal when the test says the GPU passed them. */
function createGl() {
  const errors = [];
  const fences = [];
  let reads = 0;
  const gl = {
    NO_ERROR: 0,
    INVALID_OPERATION,
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    SYNC_STATUS: 0x9114,
    SIGNALED: 0x9119,
    UNSIGNALED: 0x9118,
    fenceSync() {
      const fence = { signaled: false, deleted: false };
      fences.push(fence);
      return fence;
    },
    flush() {},
    getSyncParameter(fence, name) {
      assert.equal(name, gl.SYNC_STATUS);
      assert.equal(fence.deleted, false, 'a deleted fence is never polled');
      return fence.signaled ? gl.SIGNALED : gl.UNSIGNALED;
    },
    deleteSync(fence) { fence.deleted = true; },
    getError() {
      reads++;
      return errors.length > 0 ? errors.shift() : 0;
    },
    isContextLost: () => false,
    raise(code) { errors.push(code); },
    passAll() { for (const fence of fences) fence.signaled = true; },
    get reads() { return reads; },
    fences,
  };
  return gl;
}

// No requestAnimationFrame in node: polls run on timers.
const nextPoll = () => new Promise(resolve => setTimeout(resolve, 40));

test('a batch is not read until the GPU passed its fence, then read once, and a clean one reports nothing', async () => {
  const gl = createGl();
  const reported = [];
  deferWebGLErrorCheck(gl, { label: 'batch A', onError: error => reported.push(error), diagnose: () => assert.fail('not diagnosed') });
  await nextPoll();
  await nextPoll();
  assert.equal(gl.reads, 0, 'no read while the fence is unsignalled');
  gl.passAll();
  await nextPoll();
  assert.equal(gl.reads, 1);
  assert.deepEqual(reported, []);
  assert.equal(gl.fences[0].deleted, true);
});

test('a failure goes to the earliest batch whose run names it, saying which batches the read covered', async () => {
  const gl = createGl();
  const reported = { A: [], B: [], C: [] };
  const diagnosed = [];
  const batch = (label, diagnose) => deferWebGLErrorCheck(gl, {
    label,
    onError: error => reported[label.slice(-1)].push(error.message),
    diagnose: () => {
      diagnosed.push(label);
      return diagnose();
    },
  });
  batch('batch A', () => undefined);
  batch('batch B', () => {
    throw new Error('batch B: drawArrays in the pass writing slots [0, 4) raised WebGL error 0x502 (INVALID_OPERATION).');
  });
  batch('batch C', () => assert.fail('not run once B is named'));
  gl.raise(INVALID_OPERATION);
  gl.fences[0].signaled = true;
  await nextPoll();
  assert.deepEqual(diagnosed, ['batch A', 'batch B']);
  assert.deepEqual(reported.A, []);
  assert.deepEqual(reported.C, []);
  assert.deepEqual(reported.B, [
    'batch B: drawArrays in the pass writing slots [0, 4) raised WebGL error 0x502 (INVALID_OPERATION). '
      + '(found by a deferred check after batch A; batch B; batch C).',
  ]);
  assert.ok(gl.fences.every(fence => fence.deleted), 'every suspect is checked once');
  await nextPoll();
  assert.deepEqual(reported.C, []);
});

test('an error no batch names, or none can run again for, still reaches the earliest batch', async () => {
  const gl = createGl();
  const reported = [];
  deferWebGLErrorCheck(gl, { label: 'batch A', onError: error => reported.push(error.message), diagnose: () => undefined });
  deferWebGLErrorCheck(gl, { label: 'batch B', onError: () => assert.fail('the earliest batch is told'), diagnose: () => false });
  gl.raise(INVALID_OPERATION);
  gl.passAll();
  await nextPoll();
  assert.deepEqual(reported, [
    'a deferred check after batch A; batch B read WebGL error 0x502 (INVALID_OPERATION); '
      + 'batch B could not be run again (what it wrote or read is gone); '
      + 'run again with every call checked, none of the others raised it.',
  ]);
});

test('a synchronous reader hands an error its own calls did not raise to the outstanding checks', () => {
  const gl = createGl();
  const reported = [];
  assert.equal(claimWebGLErrorForDeferredChecks(gl, INVALID_OPERATION), false, 'nothing outstanding: the reader reports it');
  deferWebGLErrorCheck(gl, {
    label: 'batch A',
    onError: error => reported.push(error.message),
    diagnose: () => { throw new Error('batch A: drawArrays raised WebGL error 0x502 (INVALID_OPERATION).'); },
  });
  // A check that reads it before then names the outstanding batches.
  gl.raise(INVALID_OPERATION);
  assert.throws(() => requireCleanWebGLState(gl, 'An allocation'), /Checks deferred after batch A were still outstanding/);
  assert.equal(claimWebGLErrorForDeferredChecks(gl, INVALID_OPERATION), true);
  assert.deepEqual(reported, ['batch A: drawArrays raised WebGL error 0x502 (INVALID_OPERATION). (found by a deferred check after batch A).']);
  assert.equal(gl.fences[0].deleted, true);
});

test('a disposed owner\'s checks are dropped, with their fences', async () => {
  const gl = createGl();
  const owner = {};
  deferWebGLErrorCheck(gl, { label: 'batch A', owner, onError: () => assert.fail('dropped'), diagnose: () => assert.fail('dropped') });
  cancelDeferredWebGLErrorChecks(gl, owner);
  assert.equal(gl.fences[0].deleted, true);
  gl.raise(INVALID_OPERATION);
  gl.passAll();
  await nextPoll();
  assert.equal(gl.reads, 0);
});

test('batches that hold their read (`readAfter`) are read once, together, when their run is over, and a failure still names its batch', async () => {
  const gl = createGl();
  let over = false;
  const reported = [];
  for (const band of ['band 1', 'band 2', 'band 3']) {
    deferWebGLErrorCheck(gl, {
      label: band,
      onError: error => reported.push(error.message),
      diagnose: () => { if (band === 'band 2') throw new Error('band 2 failed'); },
      readAfter: () => over,
    });
  }
  gl.raise(INVALID_OPERATION);
  gl.passAll();
  await nextPoll();
  await nextPoll();
  assert.equal(gl.reads, 0, 'no read while the run goes on, though every fence passed');
  over = true;
  await nextPoll();
  assert.equal(gl.reads > 0, true);
  assert.equal(reported.length, 1);
  assert.match(reported[0], /band 2 failed/);
  assert.ok(gl.fences.every(fence => fence.deleted));
});
