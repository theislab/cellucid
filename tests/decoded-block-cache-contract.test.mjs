import assert from 'node:assert/strict';
import test from 'node:test';

import { DecodedBlockCache } from '../assets/js/data/decoded-block-cache.js';
import { residencyBudgetBytes } from '../assets/js/data/memory-budget.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('the default budget is the decoded-block residency budget', () => {
  assert.equal(new DecodedBlockCache()._maxBytes, residencyBudgetBytes('decodedBlocks'));
  assert.equal(new DecodedBlockCache().capacityBytes, residencyBudgetBytes('decodedBlocks'));
  assert.throws(() => new DecodedBlockCache(-1), RangeError);
});

test('a retained block is decoded once and returned to every later read', async () => {
  const cache = new DecodedBlockCache(1024);
  let decodes = 0;
  const decode = () => {
    decodes++;
    return new Float32Array([1, 2, 3]);
  };
  const first = await cache.read('a', 's', decode);
  const second = await cache.read('a', 's', decode);
  assert.equal(decodes, 1);
  assert.equal(second, first);
  assert.equal(cache.retainedBytes, 12);
});

test('concurrent reads of one block share a single in-flight decode', async () => {
  const cache = new DecodedBlockCache(1024);
  const gate = deferred();
  let decodes = 0;
  const decode = async () => {
    decodes++;
    await gate.promise;
    return new Uint8Array(8);
  };
  const reads = [
    cache.read('a', 's', decode),
    cache.read('a', 's', decode),
    cache.read('a', 's', decode),
  ];
  assert.equal(cache.pendingCount, 1);
  gate.resolve();
  const blocks = await Promise.all(reads);
  assert.equal(decodes, 1);
  assert.ok(blocks.every(block => block === blocks[0]));
  assert.equal(cache.pendingCount, 0);
  assert.equal(cache.size, 1);
});

test('a failed decode reaches every waiter and is never stored', async () => {
  const cache = new DecodedBlockCache(1024);
  const failure = new Error('decode failed');
  let decodes = 0;
  const failing = async () => {
    decodes++;
    throw failure;
  };
  const reads = [cache.read('a', 's', failing), cache.read('a', 's', failing)];
  for (const read of reads) await assert.rejects(read, failure);
  assert.equal(decodes, 1);
  assert.equal(cache.size, 0);
  assert.equal(cache.pendingCount, 0);

  // A synchronous throw is a failed decode too, not an escaped exception.
  await assert.rejects(
    cache.read('b', 's', () => {
      throw failure;
    }),
    failure
  );

  // The next read decodes afresh and its success is retained.
  const block = await cache.read('a', 's', () => new Uint8Array(4));
  assert.equal(block.length, 4);
  assert.equal(cache.size, 1);
});

test('clear releases every block and detaches in-flight decodes', async () => {
  const cache = new DecodedBlockCache(1024);
  await cache.read('a', 's', () => new Uint8Array(16));
  const gate = deferred();
  const inFlight = cache.read('b', 's', async () => {
    await gate.promise;
    return new Uint8Array(32);
  });
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.retainedBytes, 0);
  assert.equal(cache.pendingCount, 0);

  gate.resolve();
  // The detached waiter still receives its block, but the replaced dataset's
  // cache never stores it.
  assert.equal((await inFlight).length, 32);
  assert.equal(cache.size, 0);
  assert.equal(cache.retainedBytes, 0);

  let decodes = 0;
  await cache.read('a', 's', () => {
    decodes++;
    return new Uint8Array(16);
  });
  assert.equal(decodes, 1, 'a cleared block is decoded again');
});

test('retained bytes are bounded and least-recently-used strips leave first', async () => {
  const cache = new DecodedBlockCache(64);
  await cache.read('a0', 'A', () => new Uint8Array(16));
  await cache.read('b0', 'B', () => new Uint8Array(16));
  await cache.read('c0', 'C', () => new Uint8Array(16));
  await cache.read('a0', 'A', () => assert.fail('a0 is retained'));
  await cache.read('d0', 'D', () => new Uint8Array(32));
  assert.deepEqual([...cache._entries.keys()], ['c0', 'a0', 'd0']);
  assert.equal(cache.retainedBytes, 64);

  // A block larger than the whole budget is returned but not retained.
  const oversized = await cache.read('e0', 'E', () => new Uint8Array(65));
  assert.equal(oversized.length, 65);
  assert.equal(cache._entries.has('e0'), false);
  assert.equal(cache.retainedBytes, 64);
});

test('a strip larger than the budget keeps a stable resident prefix', async () => {
  const cache = new DecodedBlockCache(48);
  const decodes = [];
  const readStrip = async () => {
    for (let index = 0; index < 5; index++) {
      await cache.read(`s${index}`, 'S', () => {
        decodes.push(index);
        return new Uint8Array(16);
      });
    }
  };
  await readStrip();
  await readStrip();
  await readStrip();
  // Blocks 0-2 fit and stay; only 3 and 4 are decoded on each later pass.
  assert.deepEqual(decodes, [0, 1, 2, 3, 4, 3, 4, 3, 4]);
  assert.deepEqual([...cache._entries.keys()], ['s0', 's1', 's2']);
});

test('retained bytes count the whole buffer a block view keeps alive', async () => {
  const cache = new DecodedBlockCache(1024);
  const backing = new Uint8Array(512);
  await cache.read('view', 's', () => backing.subarray(0, 4));
  assert.equal(cache.retainedBytes, 512);
  await assert.rejects(
    cache.read('plain', 's', () => [1, 2, 3]),
    /typed array view/
  );
  assert.equal(cache._entries.has('plain'), false);
});
