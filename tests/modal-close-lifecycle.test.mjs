import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closeModal,
  createAnalysisModal,
  openModal,
} from '../assets/js/app/analysis/ui/components/modal.js';
import {
  deferred,
  settleMicrotasks,
  waitFor,
  withControlledTimers,
  withFakeDOM,
} from './helpers/fake-analysis-modal-dom.mjs';

function createBareModal({
  beforeClose = null,
  onClose = null,
  parentNode = null,
} = {}) {
  return {
    // Never opened, so no app dialog (`openModal` wires one).
    _appDialog: null,
    _beforeClose: beforeClose,
    _cleanupDone: false,
    _cleanupFns: [],
    _closePromise: null,
    _onClose: onClose,
    classList: {
      add() {},
      remove() {},
    },
    parentNode,
  };
}

test('reentrant beforeClose executes once and observes the one stable close promise', { concurrency: false }, async () => {
  await withControlledTimers(async ({ runAllTimers }) => {
    const gate = deferred();
    let beforeCloseCalls = 0;
    let reentrantClose = null;
    const modal = createBareModal();
    modal._beforeClose = () => {
      beforeCloseCalls++;
      if (beforeCloseCalls === 1) {
        reentrantClose = closeModal(modal);
      }
      return gate.promise;
    };

    const outerClose = closeModal(modal);
    await waitFor(() => beforeCloseCalls > 0, 'reentrant beforeClose');
    const exactCallCount = beforeCloseCalls;
    const stablePromise = reentrantClose === outerClose;

    gate.resolve();
    await waitFor(() => modal._cleanupDone, 'reentrant modal cleanup');
    runAllTimers();
    await Promise.all([...new Set([outerClose, reentrantClose])]);

    assert.equal(exactCallCount, 1);
    assert.equal(stablePromise, true);
    assert.equal(closeModal(modal), outerClose);
  });
});

test('button, backdrop, Escape, and direct close share one awaited hook', { concurrency: false }, async () => {
  await withControlledTimers(async ({ runAllTimers }) => {
    await withFakeDOM(async ({ document }) => {
      const gate = deferred();
      let beforeCloseCalls = 0;
      let onCloseCalls = 0;
      const modal = createAnalysisModal({
        beforeClose() {
          beforeCloseCalls++;
          return gate.promise;
        },
        onClose() {
          onCloseCalls++;
        },
      });
      openModal(modal);

      const directClose = closeModal(modal);
      modal.querySelector('.analysis-modal-close').dispatchEvent({
        type: 'click',
      });
      modal.querySelector('.analysis-modal-backdrop').dispatchEvent({
        type: 'click',
      });
      // Escape: the browser closes the dialog (`cancel`, then `close`).
      modal.close();
      const repeatedDirectClose = closeModal(modal);

      await waitFor(() => beforeCloseCalls > 0, 'shared beforeClose');
      assert.equal(beforeCloseCalls, 1);
      assert.equal(repeatedDirectClose, directClose);
      assert.equal(modal._cleanupDone, false);
      assert.equal(onCloseCalls, 0);
      assert.equal(modal.isConnected, true);

      gate.resolve();
      await waitFor(() => modal._cleanupDone, 'modal cleanup');
      runAllTimers();
      await directClose;

      assert.equal(beforeCloseCalls, 1);
      assert.equal(onCloseCalls, 1);
      assert.equal(modal.isConnected, false);
      assert.equal(closeModal(modal), directClose);
    });
  });
});

test('analysis modal is a <dialog> opened modally (the browser holds Tab and Escape), and restores trigger focus', { concurrency: false }, async () => {
  await withControlledTimers(async ({ runAllTimers }) => {
    await withFakeDOM(async ({ document }) => {
      const trigger = document.createElement('button');
      document.body.appendChild(trigger);
      trigger.focus();

      const modal = createAnalysisModal();
      const title = modal.querySelector('.analysis-modal-title');
      const closeButton = modal.querySelector('.analysis-modal-close');
      // A real modal (the page behind inert), never `aria-modal` on a div.
      assert.equal(modal.tagName, 'DIALOG');
      assert.equal(modal.getAttribute('aria-modal'), null);
      assert.equal(modal.getAttribute('aria-labelledby'), title.id);
      assert.equal(closeButton.getAttribute('aria-label'), 'Close analysis');

      openModal(modal);
      assert.equal(modal.open, true);
      assert.equal(modal.modal, true);
      assert.equal(document.activeElement, closeButton);

      const closing = closeModal(modal);
      // Closed at once: out of the top layer (the page usable, focus back), the view inert while
      // it fades, before it is detached. Left open for the fade, it held the page inert and its
      // controls in reach after the person closed it (the control walk clicked its × twice).
      await settleMicrotasks();
      assert.equal(modal.open, false);
      assert.equal(modal.modal, false);
      assert.equal(modal.inert, true);
      assert.equal(modal.classList.contains('closing'), true);
      assert.equal(modal.isConnected, true);
      assert.equal(document.activeElement, trigger);
      runAllTimers();
      await closing;
      assert.equal(document.activeElement, trigger);
      assert.equal(modal.isConnected, false);
    });
  });
});

test('closing during edge resize, panel resize, or header drag restores exact interaction ownership', { concurrency: false }, async () => {
  await withControlledTimers(async ({ runAllTimers }) => {
    await withFakeDOM(async ({ document }) => {
      const scenarios = [
        {
          name: 'edge resize',
          selector: '.analysis-modal-edge-resize-e',
          start(element) {
            element.dispatchEvent({
              button: 0,
              clientX: 640,
              clientY: 240,
              pointerId: 17,
              preventDefault() {},
              stopPropagation() {},
              type: 'pointerdown'
            });
            return element;
          },
          expectedCursor: 'ew-resize'
        },
        {
          name: 'panel resize',
          selector: '.analysis-modal-resizer-vertical',
          start(element) {
            element.dispatchEvent({
              clientX: 400,
              clientY: 240,
              pointerId: 17,
              preventDefault() {},
              stopPropagation() {},
              type: 'pointerdown'
            });
            return element;
          },
          expectedCursor: 'col-resize'
        },
        {
          name: 'header drag',
          selector: '.analysis-modal-header',
          start(element) {
            element.dispatchEvent({
              button: 0,
              clientX: 320,
              clientY: 40,
              pointerId: 17,
              preventDefault() {},
              target: { closest: () => null },
              type: 'pointerdown'
            });
            return element;
          },
          expectedCursor: 'move'
        }
      ];

      for (const scenario of scenarios) {
        const trigger = document.createElement('button');
        document.body.appendChild(trigger);
        trigger.focus();
        document.body.style.setProperty('cursor', 'help', 'important');
        document.body.style.setProperty(
          'user-select',
          'text',
          'important'
        );
        document.body.style.setProperty(
          '-webkit-user-select',
          'contain',
          'important'
        );
        const modal = createAnalysisModal();
        openModal(modal);
        const interactionTarget = modal.querySelector(scenario.selector);
        const pointerTarget = scenario.start(interactionTarget);

        assert.equal(
          document.body.style.cursor,
          scenario.expectedCursor,
          `${scenario.name} did not acquire the cursor`
        );
        assert.equal(document.body.style.userSelect, 'none');
        assert.equal(document.body.style.WebkitUserSelect, 'none');

        const closing = closeModal(modal);
        assert.equal(document.body.style.cursor, 'help');
        assert.equal(document.body.style.userSelect, 'text');
        assert.equal(document.body.style.WebkitUserSelect, 'contain');
        assert.equal(
          document.body.style.getPropertyPriority('cursor'),
          'important'
        );
        assert.equal(
          document.body.style.getPropertyPriority('user-select'),
          'important'
        );
        assert.equal(
          document.body.style.getPropertyPriority('-webkit-user-select'),
          'important'
        );
        assert.equal(
          interactionTarget.classList.contains('resizing'),
          false
        );
        if (pointerTarget !== null) {
          assert.equal(pointerTarget.hasPointerCapture(17), false);
          assert.deepEqual(pointerTarget.releasedPointers, [17]);
        }

        runAllTimers();
        await closing;
        assert.equal(document.activeElement, trigger);
      }
    });
  });
});

test('async onClose and animated physical detach both delay close settlement', { concurrency: false }, async () => {
  await withControlledTimers(async ({ runAllTimers }) => {
    const onCloseGate = deferred();
    let onCloseCalls = 0;
    let detached = false;
    const parent = {
      removeChild(child) {
        assert.equal(child, modal);
        detached = true;
        modal.parentNode = null;
      },
    };
    const modal = createBareModal({
      beforeClose: async () => {},
      onClose() {
        onCloseCalls++;
        return onCloseGate.promise;
      },
      parentNode: parent,
    });
    let closeSettled = false;
    const closing = closeModal(modal);
    void closing.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );

    await waitFor(() => onCloseCalls === 1, 'async onClose invocation');
    await settleMicrotasks();
    const settledBeforeOnClose = closeSettled;
    const detachedBeforeTimer = detached;

    onCloseGate.resolve();
    await settleMicrotasks();
    const settledBeforeDetach = closeSettled;

    runAllTimers();
    await closing;

    assert.equal(settledBeforeOnClose, false);
    assert.equal(detachedBeforeTimer, false);
    assert.equal(settledBeforeDetach, false);
    assert.equal(detached, true);
    assert.equal(closeSettled, true);
  });
});

test('a failed close is returned as the same rejected promise forever', { concurrency: false }, async () => {
  await withControlledTimers(async ({ runAllTimers }) => {
    const exactFailure = new Error('modal owner teardown failed');
    let beforeCloseCalls = 0;
    const modal = createBareModal({
      beforeClose() {
        beforeCloseCalls++;
        throw exactFailure;
      },
    });

    const firstClose = closeModal(modal);
    await waitFor(() => modal._cleanupDone, 'failed modal cleanup');
    runAllTimers();
    const firstFailure = await firstClose.then(
      () => null,
      error => error,
    );
    const repeatedClose = closeModal(modal);
    const repeatedFailure =
      repeatedClose && typeof repeatedClose.then === 'function'
        ? await repeatedClose.then(
          () => null,
          error => error,
        )
        : null;

    assert.equal(firstFailure, exactFailure);
    assert.equal(repeatedClose, firstClose);
    assert.equal(repeatedFailure, exactFailure);
    assert.equal(beforeCloseCalls, 1);
  });
});

test('a no-hook modal still reports cleanup failure synchronously', { concurrency: false }, async () => {
  await withControlledTimers(async ({ runAllTimers }) => {
    const exactFailure = new Error('synchronous cleanup failed');
    const modal = createBareModal();
    modal._cleanupFns.push(() => {
      throw exactFailure;
    });

    assert.throws(() => closeModal(modal), error => error === exactFailure);
    assert.equal(modal._cleanupDone, true);
    runAllTimers();
  });
});
