/**
 * @fileoverview Session save/load UI wiring.
 *
 * Wires the session buttons to the new `.cellucid-session` bundle system and
 * surfaces success/error status via `NotificationCenter`.
 *
 * @module ui/modules/session-controls
 */

import { getNotificationCenter } from '../../notification-center.js';

export function initSessionControls({
  dom,
  sessionSerializer,
  onAfterLoad
}) {
  const { saveBtn: saveStateBtn, loadBtn: loadStateBtn } = dom || {};
  const lifecycleController = new AbortController();
  const activeOperations = new Set();
  let destroyed = false;
  let generation = 0;
  let destructionPromise = null;

  function ownsOperation(operationGeneration) {
    return !destroyed && generation === operationGeneration;
  }

  function listen(target, eventName, listener) {
    target.addEventListener(eventName, (...args) => {
      if (destroyed) return undefined;
      return listener(...args);
    }, { signal: lifecycleController.signal });
  }

  function trackOperation(task) {
    activeOperations.add(task);
    void task.then(
      () => activeOperations.delete(task),
      () => activeOperations.delete(task)
    );
    return task;
  }

  function showSessionStatus(message, isError = false) {
    if (destroyed) return;
    const notifications = getNotificationCenter();
    if (isError) {
      notifications.error(message, { category: 'session' });
    } else {
      notifications.success(message, { category: 'session' });
    }
  }

  if (saveStateBtn && sessionSerializer) {
    listen(saveStateBtn, 'click', () => {
      const operationGeneration = generation;
      const operation = (async () => {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        await sessionSerializer.downloadSession(`cellucid-session-${timestamp}.cellucid-session`);
        if (!ownsOperation(operationGeneration)) return;
        showSessionStatus('Session saved successfully');
      } catch (err) {
        if (!ownsOperation(operationGeneration)) return;
        console.error('Failed to save state:', err);
        showSessionStatus('Failed to save session', true);
      }
      })();
      return trackOperation(operation);
    });
  }

  if (loadStateBtn && sessionSerializer) {
    listen(loadStateBtn, 'click', () => {
      // IMPORTANT:
      // File pickers must be opened synchronously in the click handler (without
      // awaiting other work) or some browsers will block the dialog.
      const operationGeneration = generation;
      const operation = (async () => {
      try {
        const picked = await sessionSerializer.loadSessionFromFile();
        if (!picked || !ownsOperation(operationGeneration)) return;
        showSessionStatus('Session loaded successfully');
        if (typeof onAfterLoad === 'function') {
          await onAfterLoad();
        }
      } catch (err) {
        if (!ownsOperation(operationGeneration)) return;
        console.error('Failed to load state:', err);
        const message = (
          err instanceof Error && err.message.length > 0
        )
          ? err.message
          : 'Failed to load session';
        showSessionStatus(message, true);
      }
      })();
      return trackOperation(operation);
    });
  }

  function destroy() {
    if (destructionPromise !== null) return destructionPromise;
    destroyed = true;
    generation += 1;
    lifecycleController.abort();
    const ownedOperations = [...activeOperations];
    destructionPromise = Promise.allSettled(ownedOperations).then(() => {});
    return destructionPromise;
  }

  return { showSessionStatus, destroy };
}
