/**
 * The session kept through a graphics reset.
 *
 * When the browser takes the WebGL context away, the viewer fences its GPU
 * owners and waits for the context back (`viewer.onGraphicsReset`,
 * `rendering/viewer.js`, "Lost and restored graphics"). Nothing the person
 * made lives on the GPU, so a restored context shows it all again; this
 * module guards the case where it does not come back. At the loss it
 * captures the session at once (the same `.cellucid-session` bundle Save
 * session writes, read from CPU state), offers it in the viewer's notice,
 * and writes it to disk by itself if restoring fails, before Reload is
 * offered. A restored context drops it.
 *
 * @module app/graphics-reset-session
 */

import { downloadBlob } from './utils/download.js';

/**
 * @param {object} options
 * @param {{onGraphicsReset: Function, setGraphicsResetSessionSaver: Function}} options.viewer
 * @param {{createSessionBundle: () => Promise<Blob>}} options.sessionSerializer
 * @param {{error: Function, info: Function}} options.notifications
 * @returns {() => void} Stop following the viewer.
 */
export function keepSessionThroughGraphicsReset({ viewer, sessionSerializer, notifications }) {
  /** @type {Promise<Blob|null>|null} */
  let captured = null;
  let written = false;

  const write = async () => {
    const bundle = captured === null ? null : await captured;
    if (bundle === null) {
      throw new Error('No session was captured when the graphics were lost.');
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(bundle, `cellucid-session-${timestamp}.cellucid-session`);
    written = true;
  };

  viewer.setGraphicsResetSessionSaver(write);
  const unsubscribe = viewer.onGraphicsReset(phase => {
    if (phase === 'lost') {
      written = false;
      captured = sessionSerializer.createSessionBundle().catch(error => {
        console.error('[GraphicsReset] The session could not be captured at the graphics reset.', error);
        notifications.error(
          `The session could not be captured when the graphics were reset: ${error instanceof Error ? error.message : String(error)}`,
          { category: 'session' }
        );
        return null;
      });
    } else if (phase === 'restored') {
      captured = null;
      notifications.info('The graphics were reset by the browser and restored; nothing was lost.', { category: 'render' });
    } else if (phase === 'failed' && !written) {
      write().catch(error => {
        console.error('[GraphicsReset] The captured session could not be written.', error);
      });
    }
  });
  return () => {
    unsubscribe();
    viewer.setGraphicsResetSessionSaver(null);
  };
}
