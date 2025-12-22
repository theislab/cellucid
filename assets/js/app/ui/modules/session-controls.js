/**
 * @fileoverview Session save/load UI wiring.
 *
 * Wires the session buttons to the `state-serializer` snapshot system and
 * surfaces success/error status via `NotificationCenter`.
 *
 * @module ui/modules/session-controls
 */

import { getNotificationCenter } from '../../notification-center.js';

export function initSessionControls({
  dom,
  stateSerializer,
  onAfterLoad
}) {
  const { saveBtn: saveStateBtn, loadBtn: loadStateBtn } = dom || {};

  function showSessionStatus(message, isError = false) {
    const notifications = getNotificationCenter();
    if (isError) {
      notifications.error(message, { category: 'session' });
    } else {
      notifications.success(message, { category: 'session' });
    }
  }

  if (saveStateBtn && stateSerializer) {
    saveStateBtn.addEventListener('click', () => {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        stateSerializer.downloadState(`cellucid-state-${timestamp}.json`);
        showSessionStatus('State saved successfully');
      } catch (err) {
        console.error('Failed to save state:', err);
        showSessionStatus('Failed to save state', true);
      }
    });
  }

  if (loadStateBtn && stateSerializer) {
    loadStateBtn.addEventListener('click', async () => {
      try {
        await stateSerializer.loadStateFromFile();
        showSessionStatus('State loaded successfully');
        await onAfterLoad?.();
      } catch (err) {
        console.error('Failed to load state:', err);
        showSessionStatus(err?.message || 'Failed to load state', true);
      }
    });
  }

  return { showSessionStatus };
}
