/**
 * @fileoverview The community annotation cluster dialog shell.
 *
 * Builds the dialog of the identity profile editor and the GitHub connection
 * flow: an app dialog (`ui/components/app-dialog.js`, which owns the
 * backdrop, Escape, the inert page, stacking and the return of focus) drawn as
 * a full-screen layer holding the community annotation card, with the title
 * band and its Close button; and the promise-shaped confirmation wrapper.
 *
 * The voting dialogs (`community-annotation-voting-modal.js`) are app dialogs
 * built the same way; what differs is theirs alone: the primary/secondary
 * cascade, retiring their render lifecycle before the dialog leaves the page,
 * and the secondary's re-render with focus kept across each rebuild. Content
 * that handles Escape itself (an inline editor, the ORCID suggestions) calls
 * `preventDefault()` on the key, and the dialog stays open.
 * `tests/community-annotation-modal-shell-parity-contract.test.mjs` pins both
 * on the one dialog implementation.
 *
 * @module ui/modules/community-annotation/modal-shell
 */

import { showConfirmDialog } from '../../components/confirm-dialog.js';
import { wireAppDialog } from '../../components/app-dialog.js';
import { claimCommunityAnnotationModal } from '../community-annotation-modal-owner.js';
import { el } from './dom.js';
import { createDomId } from '../../components/dom-id.js';
import { runExactCleanup } from './cleanup.js';
import { onAbort, requireSignalOrNull } from '../../../../utils/abort.js';

/** Each cluster dialog's close, so content can close the dialog that holds it. */
const closeOf = new WeakMap();

export function removeOwningCommunityModal(content) {
  if (!content || typeof content.closest !== 'function') {
    throw new TypeError('Community annotation modal content must expose closest()');
  }
  const close = closeOf.get(content.closest('dialog.community-annotation-dialog'));
  if (typeof close !== 'function') {
    throw new Error('Community annotation modal close owner is unavailable');
  }
  close();
}

/**
 * Run a content builder's cleanup (`content.__cellucidCleanup`), when it set one.
 * @param {HTMLElement} content
 */
function cleanUpContent(content) {
  const cleanup = content.__cellucidCleanup;
  if (cleanup === undefined || cleanup === null) return;
  if (typeof cleanup !== 'function') {
    throw new TypeError(
      'Community annotation modal content cleanup must be a function'
    );
  }
  cleanup();
}

export function showClusterModal({
  title,
  buildContent,
  modalClassName = '',
  returnFocusTo = null,
  returnFocusResolver = null,
  onClosed = null
}) {
  if (typeof buildContent !== 'function') {
    throw new TypeError('Community annotation modal requires a content builder');
  }
  if (
    returnFocusTo !== null &&
    !(returnFocusTo instanceof HTMLElement)
  ) {
    throw new TypeError(
      'Community annotation modal return focus target must be an element or null'
    );
  }
  if (
    returnFocusResolver !== null &&
    typeof returnFocusResolver !== 'function'
  ) {
    throw new TypeError(
      'Community annotation modal focus resolver must be a function or null'
    );
  }
  if (onClosed !== null && typeof onClosed !== 'function') {
    throw new TypeError(
      'Community annotation modal close settlement must be a function or null'
    );
  }
  const dialog = el('dialog', { className: 'dialog-layer community-annotation-dialog' });
  const cls = String(modalClassName || '').trim();
  const modal = el('div', { className: `community-annotation-modal${cls ? ` ${cls}` : ''}` });

  const header = el('div', { className: 'community-annotation-modal-header' });
  const titleEl = el('div', { className: 'community-annotation-modal-title', text: title || 'Community annotation' });
  titleEl.id = createDomId('community-annotation-modal-title');
  dialog.setAttribute('aria-labelledby', titleEl.id);
  header.appendChild(titleEl);
  const closeBtn = el('button', { type: 'button', className: 'btn community-annotation-modal-close', text: 'Close' });
  header.appendChild(closeBtn);

  const content = el('div', { className: 'community-annotation-modal-body' });
  try {
    buildContent(content);
  } catch (primaryError) {
    try {
      cleanUpContent(content);
    } catch (cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        'Community annotation content creation and cleanup both failed'
      );
    }
    throw primaryError;
  }

  modal.appendChild(header);
  modal.appendChild(content);
  dialog.appendChild(modal);

  // Focus goes back to the opener, or (gone, or never focused: WebKit does
  // not focus a clicked button) to what the resolver names then.
  const prevFocus = returnFocusTo ?? document.activeElement;
  const returnFocus = () => (
    prevFocus instanceof HTMLElement &&
    prevFocus !== document.body &&
    prevFocus.isConnected &&
    !(prevFocus instanceof HTMLButtonElement && prevFocus.disabled)
      ? prevFocus
      : returnFocusResolver?.() ?? null
  );
  let releaseClaim = null;
  const owner = wireAppDialog(dialog, {
    onClose: () => {
      runExactCleanup('Community annotation modal teardown', [
        ['modal content', () => cleanUpContent(content)],
        ['modal dialog', () => dialog.remove()],
        ['modal close owner', () => closeOf.delete(dialog)],
        ['shared modal owner', releaseClaim === null ? null : () => {
          if (releaseClaim() !== true) {
            throw new Error(
              'Community annotation modal lost its exact owner before teardown'
            );
          }
        }],
        ['modal close settlement', onClosed]
      ]);
    }
  });
  const close = () => owner.close();
  closeBtn.addEventListener('click', close);
  closeOf.set(dialog, close);

  try {
    releaseClaim = claimCommunityAnnotationModal(close);
    document.body.appendChild(dialog);
    owner.open(returnFocus, { focus: closeBtn });
    return { close, overlay: dialog, modal, content };
  } catch (primaryError) {
    try {
      if (dialog.open) {
        close();
      } else {
        runExactCleanup('Unopened community annotation modal rollback', [
          ['modal content', () => cleanUpContent(content)],
          ['modal dialog', () => dialog.remove()],
          ['modal close owner', () => closeOf.delete(dialog)],
          ['shared modal owner', releaseClaim === null ? null : () => releaseClaim()]
        ]);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [primaryError, rollbackError],
        'Community annotation modal creation and rollback failed'
      );
    }
    throw primaryError;
  }
}

export function confirmAsync({ title, message, confirmText, tone = 'danger', signal = null }) {
  requireSignalOrNull(signal, 'Community annotation confirmation signal');
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let cancelDialog = null;
    let stopWaiting = () => {};
    const settle = value => {
      if (settled) return;
      settled = true;
      stopWaiting();
      resolve(value);
    };
    cancelDialog = showConfirmDialog({
      title,
      message,
      confirmText,
      tone,
      onConfirm: () => settle(true),
      onCancel: () => settle(false)
    });
    stopWaiting = onAbort(signal, () => {
      if (cancelDialog !== null) cancelDialog();
      else settle(false);
    });
  });
}
