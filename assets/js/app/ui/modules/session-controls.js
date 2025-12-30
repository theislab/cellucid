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

  function showSessionStatus(message, isError = false) {
    const notifications = getNotificationCenter();
    if (isError) {
      notifications.error(message, { category: 'session' });
    } else {
      notifications.success(message, { category: 'session' });
    }
  }

  if (saveStateBtn && sessionSerializer) {
    saveStateBtn.addEventListener('click', async () => {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        await sessionSerializer.downloadSession(`cellucid-session-${timestamp}.cellucid-session`);
        showSessionStatus('Session saved successfully');
      } catch (err) {
        console.error('Failed to save state:', err);
        showSessionStatus('Failed to save session', true);
      }
    });
  }

  if (loadStateBtn && sessionSerializer) {
    loadStateBtn.addEventListener('click', async () => {
      // IMPORTANT:
      // File pickers must be opened synchronously in the click handler (without
      // awaiting other work) or some browsers will block the dialog.
      try {
        const picked = await sessionSerializer.loadSessionFromFile();
        if (!picked) return; // user canceled
        showSessionStatus('Session loaded successfully');
        await onAfterLoad?.();
      } catch (err) {
        console.error('Failed to load state:', err);
        showSessionStatus(err?.message || 'Failed to load session', true);
      }
    });
  }

  return { showSessionStatus };
}
