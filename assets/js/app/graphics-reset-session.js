/**
 * The graphics reset by the browser, as the person sees it, and the session
 * kept through it.
 *
 * When the browser takes the WebGL context away, the viewer fences its GPU
 * owners, waits for the context back and tells its listeners each phase
 * (`viewer.onGraphicsReset`, `rendering/viewer.js`, "Lost and restored
 * graphics"); the renderer builds no UI of its own (F146). This module shows
 * it: an app dialog (`#graphics-reset-dialog`, `wireAppDialog`) that says the
 * graphics are being restored, offers the session captured at the loss
 * (Save session) and, only once restoring failed, Reload. Nothing behind it
 * can be used meanwhile, so Escape and the backdrop leave it open; it closes
 * by itself when the graphics are back.
 *
 * Nothing the person made lives on the GPU, so a restored context shows it
 * all again; the session is the guard for the case where it does not come
 * back. It is captured at the loss (the same `.cellucid-session` bundle Save
 * session writes, read from CPU state), and written to disk by itself if
 * restoring fails, before Reload is offered. A restored context drops it.
 *
 * @module app/graphics-reset-session
 */

import { downloadBlob, fileTimestamp } from './utils/download.js';
import { SAVE_DEFAULTS } from './session/share-scope.js';
import { failureDetails, joinFailure, sayFailure } from '../utils/errors.js';
import { cancel } from '../utils/abort.js';
import { wireAppDialog } from './ui/components/app-dialog.js';

/** What the dialog says in each phase. */
export const GRAPHICS_RESET_WORDS = Object.freeze({
  lost: 'The graphics were reset by the browser. Restoring them; your filters, selections, kept views and analyses are kept.',
  failed: 'The graphics could not be restored. Save the session, then reload the page to continue.',
});

/**
 * @param {object} options
 * @param {{onGraphicsReset: Function}} options.viewer
 * @param {{createSessionBundle: (options: {choice: object}) => Promise<Blob>}} options.sessionSerializer
 * @param {{error: Function, info: Function}} options.notifications
 * @param {Document} [options.ownerDocument]
 * @returns {() => void} Stop following the viewer.
 */
export function keepSessionThroughGraphicsReset({ viewer, sessionSerializer, notifications, ownerDocument = document }) {
  const dialog = ownerDocument.getElementById('graphics-reset-dialog');
  const message = ownerDocument.getElementById('graphics-reset-message');
  const save = ownerDocument.getElementById('graphics-reset-save');
  const reload = ownerDocument.getElementById('graphics-reset-reload');
  if (dialog === null || message === null || save === null || reload === null) {
    throw new TypeError('The graphics reset needs #graphics-reset-dialog with its message, Save session and Reload.');
  }
  const owner = wireAppDialog(dialog, { dismissible: false });
  const controller = new AbortController();

  /** @type {Promise<Blob|null>|null} */
  let captured = null;
  let written = false;

  const write = async () => {
    const bundle = captured === null ? null : await captured;
    if (bundle === null) {
      throw new Error('No session was captured when the graphics were lost.');
    }
    downloadBlob(bundle, `cellucid-session-${fileTimestamp()}.cellucid-session`);
    written = true;
  };

  /** The dialog for `phase` (`lost`: restoring, no Reload; `failed`: Reload too). */
  const show = phase => {
    message.textContent = GRAPHICS_RESET_WORDS[phase];
    reload.hidden = phase !== 'failed';
    // Focus on the dialog's first offer: Save session.
    if (!dialog.open) owner.open(null, { focus: save });
  };

  save.addEventListener('click', () => {
    write().catch(error => {
      console.error('[GraphicsReset] The captured session could not be written.', error);
      notifications.error(
        joinFailure('The session captured at the graphics reset could not be saved', sayFailure(error)),
        { ...failureDetails(error), category: 'session' }
      );
    });
  }, { signal: controller.signal });
  reload.addEventListener('click', () => ownerDocument.defaultView?.location.reload(), { signal: controller.signal });

  const unsubscribe = viewer.onGraphicsReset(phase => {
    if (phase === 'lost') {
      written = false;
      // Everything, conversations included: the person's own work, kept for a reload.
      captured = sessionSerializer.createSessionBundle({ choice: { ...SAVE_DEFAULTS, chats: true } }).catch(error => {
        console.error('[GraphicsReset] The session could not be captured at the graphics reset.', error);
        notifications.error(
          `${joinFailure(`The session could not be captured when the graphics were reset`, sayFailure(error))}`,
          { ...failureDetails(error), category: 'session' }
        );
        return null;
      });
      show('lost');
    } else if (phase === 'restored') {
      captured = null;
      owner.close();
      notifications.info('The graphics were reset by the browser and restored; nothing was lost.', { category: 'render' });
    } else if (phase === 'failed') {
      show('failed');
      if (!written) {
        write().catch(error => {
          console.error('[GraphicsReset] The captured session could not be written.', error);
        });
      }
    }
  });
  return () => {
    unsubscribe();
    cancel(controller, 'closed', 'The graphics-reset dialog was taken down.');
    owner.destroy();
  };
}
