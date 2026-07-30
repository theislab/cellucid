import assert from 'node:assert/strict';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { initSessionControls } from '../assets/js/app/ui/modules/session-controls.js';

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createButton() {
  const listeners = new Set();
  return {
    addEventListener(type, listener, options = {}) {
      assert.equal(type, 'click');
      listeners.add(listener);
      if (options.signal) {
        options.signal.addEventListener(
          'abort',
          () => listeners.delete(listener),
          { once: true }
        );
      }
    },
    click() {
      return [...listeners][0]();
    },
    listeners() {
      return [...listeners];
    }
  };
}

test('session-control destroy fences late publication and drains active work', async () => {
  const save = deferred();
  const load = deferred();
  const saveBtn = createButton();
  const loadBtn = createButton();
  const serializerCalls = [];
  const notifications = getNotificationCenter();
  const originalSuccess = notifications.success;
  const originalError = notifications.error;
  const notificationCalls = [];
  notifications.success = (...args) => notificationCalls.push(['success', ...args]);
  notifications.error = (...args) => notificationCalls.push(['error', ...args]);

  try {
    let afterLoads = 0;
    const controls = initSessionControls({
      dom: { saveBtn, loadBtn },
      sessionSerializer: {
        downloadSession(filename) {
          serializerCalls.push(['save', filename]);
          return save.promise;
        },
        loadSessionFromFile() {
          serializerCalls.push(['load']);
          return load.promise;
        }
      },
      onAfterLoad() {
        afterLoads += 1;
      }
    });
    const retainedSaveListener = saveBtn.listeners()[0];
    const retainedLoadListener = loadBtn.listeners()[0];
    const saving = saveBtn.click();
    const loading = loadBtn.click();

    const destruction = controls.destroy();
    assert.equal(controls.destroy(), destruction);
    assert.equal(saveBtn.listeners().length, 0);
    assert.equal(loadBtn.listeners().length, 0);

    let destroySettled = false;
    void destruction.then(() => {
      destroySettled = true;
    });
    await Promise.resolve();
    assert.equal(destroySettled, false);

    save.resolve();
    await saving;
    await Promise.resolve();
    assert.equal(destroySettled, false);
    load.resolve(true);
    await Promise.all([loading, destruction]);

    assert.equal(afterLoads, 0);
    assert.deepEqual(notificationCalls, []);
    assert.equal(destroySettled, true);
    assert.equal(serializerCalls.length, 2);

    assert.equal(retainedSaveListener(), undefined);
    assert.equal(retainedLoadListener(), undefined);
    controls.showSessionStatus('retained status');
    assert.equal(serializerCalls.length, 2);
    assert.deepEqual(notificationCalls, []);
  } finally {
    notifications.success = originalSuccess;
    notifications.error = originalError;
  }
});
