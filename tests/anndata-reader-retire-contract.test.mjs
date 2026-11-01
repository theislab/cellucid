/**
 * A reader worker that is closed is asked to leave (it keeps what it
 * fetched, then ends itself), but the application's teardown waits for no
 * reader: one that never answers (its thread stuck) is ended from outside
 * when the application is torn down (`retireAnnDataReaderWorkers`), and every
 * worker ended after that is ended at once. One that left on its own is not
 * touched. Its own file: the teardown is once per page.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AnnDataReaderClient,
  retireAnnDataReaderWorkers,
  setAnnDataReaderWorkerFactory,
} from '../assets/js/data/anndata-reader-client.js';

/** A worker that takes every message and answers nothing, unless told to leave politely. */
function stubWorker({ leavesWhenAsked }) {
  const listeners = new Set();
  return {
    onmessage: null,
    onerror: null,
    messages: [],
    terminated: false,
    postMessage(message) {
      this.messages.push(message);
      if (message?.leave === true && leavesWhenAsked) {
        for (const listener of listeners) listener({ data: { event: 'left' } });
      }
    },
    terminate() {
      this.terminated = true;
    },
    addEventListener(type, listener) {
      if (type === 'message') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.delete(listener);
    },
  };
}

test('a closed reader is asked to leave; the teardown ends one that never left, and every later one at once', async () => {
  const made = [];
  let leaves = false;
  setAnnDataReaderWorkerFactory(() => {
    const worker = stubWorker({ leavesWhenAsked: leaves });
    made.push(worker);
    return worker;
  });

  // A reader that never answers: closed, it is asked to leave and left alone.
  const stuck = new AnnDataReaderClient();
  void stuck._call('getDatasetMetadata').catch(() => {});
  stuck.close();
  assert.equal(made.length, 1);
  assert.ok(made[0].messages.some(message => message?.leave === true), 'asked to leave');
  assert.equal(made[0].terminated, false, 'not ended from outside while it may still keep what it fetched');

  // One that leaves when asked says so, and is not touched again.
  leaves = true;
  const polite = new AnnDataReaderClient();
  void polite._call('getDatasetMetadata').catch(() => {});
  polite.close();
  assert.equal(made.length, 2);

  // The application is torn down: the one still leaving is ended now.
  retireAnnDataReaderWorkers();
  assert.equal(made[0].terminated, true, 'a reader that never left is ended by the teardown');
  assert.equal(made[1].terminated, false, 'a reader that left on its own is not touched');

  // Any reader ended after the teardown is ended at once.
  leaves = false;
  const late = new AnnDataReaderClient();
  void late._call('getDatasetMetadata').catch(() => {});
  late.close();
  assert.equal(made[2].terminated, true);
  assert.ok(!made[2].messages.some(message => message?.leave === true), 'not asked to leave: nothing waits for it');
});
