/**
 * @fileoverview The community annotation cluster modal shell.
 *
 * Owns the overlay/focus-trap/Escape plumbing for the *cluster* dialogs — the
 * identity profile editor and the GitHub connection flow — the two symbols
 * that carry per-overlay ownership on the DOM nodes themselves, and the
 * promise-shaped confirmation wrapper.
 *
 * `COMMUNITY_MODAL_LOCAL_CLOSE` and `COMMUNITY_MODAL_ESCAPE_OWNER` are module
 * identity: every module that reads or writes them must import them from here,
 * or an overlay written by one copy is invisible to the other.
 *
 * ## Why this is not the only community annotation modal shell
 *
 * `community-annotation-voting-modal.js` carries its own `showModal()` and
 * `showSecondaryModal()`. That is deliberate, not an oversight, and merging
 * them would lose behaviour rather than remove duplication:
 *
 * - **Close ordering differs and is load-bearing.** Here the content cleanup
 *   runs from `content.__cellucidCleanup` inside the teardown sequence; the
 *   voting shell must retire its owned render lifecycle (`onClose`) *first*,
 *   before the focus trap and before the overlay leaves the DOM, because its
 *   content holds abortable field loads that must not observe a detached tree.
 * - **The nested-Escape protocols differ.** This shell resolves Escape through
 *   `COMMUNITY_MODAL_ESCAPE_OWNER` on the event target, so an inline editor can
 *   claim Escape and report whether it handled it. The voting shell resolves it
 *   through an `escCancelSelector`, because its cancellable regions are marked
 *   declaratively (`data-esc-cancel`) by content it does not own.
 * - **The voting shell owns a cascade this one has no concept of**
 *   (`activeVotingModal` / `activeSecondaryModal`), and its secondary shell
 *   owns a session-driven re-render loop with focus capture and restore across
 *   each rebuild. Folding that into a shell whose contract is "build once" would
 *   add a second, mostly-dead code path here.
 * - **Only this shell publishes `COMMUNITY_MODAL_LOCAL_CLOSE`**, which is how
 *   content built by `identity-profile-modal.js` and `github-connection-flow.js`
 *   closes the dialog that owns it.
 *
 * What the two shells *do* owe each other is the accessibility contract:
 * `role="dialog"`, `aria-modal`, a generated `aria-labelledby`, focus into the
 * dialog on open, focus restored on close, Escape, and Tab wrapping in both
 * directions. That agreement is pinned by
 * `tests/community-annotation-modal-shell-parity-contract.test.mjs`, which
 * fails when either shell drifts from the other. Read that test before changing
 * focus, Escape, or labelling behaviour in either file.
 *
 * @module ui/modules/community-annotation/modal-shell
 */

import { showConfirmDialog } from '../../components/confirm-dialog.js';
import { claimModalDocumentLayer } from '../../components/modal-background-owner.js';
import { claimCommunityAnnotationModal } from '../community-annotation-modal-owner.js';
import { el } from './dom.js';
import { createDomId } from '../../components/dom-id.js';
import { releaseExactModalDocumentLayer, runExactCleanup } from './cleanup.js';

export const COMMUNITY_MODAL_LOCAL_CLOSE = Symbol('communityModalLocalClose');
export const COMMUNITY_MODAL_ESCAPE_OWNER = Symbol('communityModalEscapeOwner');

export function removeOwningCommunityModal(content) {
  if (!content || typeof content.closest !== 'function') {
    throw new TypeError('Community annotation modal content must expose closest()');
  }
  const overlay = content.closest('.community-annotation-modal-overlay');
  if (!overlay) {
    throw new Error('Community annotation modal overlay is unavailable');
  }
  const close = overlay[COMMUNITY_MODAL_LOCAL_CLOSE];
  if (typeof close !== 'function') {
    throw new Error('Community annotation modal close owner is unavailable');
  }
  close();
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
  const overlay = el('div', { className: 'community-annotation-modal-overlay', role: 'dialog', 'aria-modal': 'true' });
  const cls = String(modalClassName || '').trim();
  const modal = el('div', { className: `community-annotation-modal${cls ? ` ${cls}` : ''}`, role: 'document' });

  const header = el('div', { className: 'community-annotation-modal-header' });
  const titleEl = el('div', { className: 'community-annotation-modal-title', text: title || 'Community annotation' });
  titleEl.id = createDomId('community-annotation-modal-title');
  overlay.setAttribute('aria-labelledby', titleEl.id);
  header.appendChild(titleEl);
  const closeBtn = el('button', { type: 'button', className: 'btn-small community-annotation-modal-close', text: 'Close' });
  header.appendChild(closeBtn);

  const content = el('div', { className: 'community-annotation-modal-body' });
  try {
    buildContent(content);
  } catch (primaryError) {
    const errors = [primaryError];
    try {
      const cleanup = content.__cellucidCleanup;
      if (cleanup !== undefined && cleanup !== null) {
        if (typeof cleanup !== 'function') {
          throw new TypeError(
            'Community annotation modal content cleanup must be a function'
          );
        }
        cleanup();
      }
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    if (errors.length === 1) throw primaryError;
    throw new AggregateError(
      errors,
      'Community annotation content creation and cleanup both failed'
    );
  }

  modal.appendChild(header);
  modal.appendChild(content);
  overlay.appendChild(modal);

  const prevFocus = returnFocusTo ?? document.activeElement;
  let closed = false;
  let closing = false;
  let releaseClaim = null;
  let releaseDocumentLayer = null;
  const releaseDocumentOwnership = () => {
    if (releaseDocumentLayer === null) return;
    const exactRelease = releaseDocumentLayer;
    releaseExactModalDocumentLayer(
      exactRelease,
      'Community annotation modal'
    );
    if (releaseDocumentLayer === exactRelease) {
      releaseDocumentLayer = null;
    }
  };
  const listFocusable = () => {
    const selectors = [
      'a[href]',
      'area[href]',
      'button:not([disabled])',
      'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    const nodes = Array.from(modal.querySelectorAll(selectors));
    return nodes.filter((node) => {
      if (!(node instanceof HTMLElement)) return false;
      if (typeof window.getComputedStyle !== 'function') {
        throw new TypeError('Community annotation focus management requires getComputedStyle()');
      }
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return node.getClientRects().length > 0;
    });
  };

  const close = ({ restoreFocus: shouldRestoreFocus = true } = {}) => {
    if (closed) return;
    if (closing) return;
    if (typeof shouldRestoreFocus !== 'boolean') {
      throw new TypeError(
        'Community annotation modal focus restoration flag must be boolean'
      );
    }
    closing = true;
    const restorePreviousFocus = () => {
      if (!shouldRestoreFocus) return;
      const previousFocusAvailable =
        prevFocus instanceof HTMLElement &&
        prevFocus.isConnected &&
        !(
          prevFocus instanceof HTMLButtonElement &&
          prevFocus.disabled
        );
      const target =
        previousFocusAvailable
          ? prevFocus
          : returnFocusResolver?.() ?? null;
      if (target === null) return;
      if (
        !(target instanceof HTMLElement) ||
        !target.isConnected ||
        typeof target.focus !== 'function'
      ) {
        throw new TypeError(
          'Previous community annotation focus target must expose focus()'
        );
      }
      target.focus();
    };
    try {
      runExactCleanup('Community annotation modal teardown', [
        ['modal keydown listener', () => overlay.removeEventListener('keydown', onKeyDown, true)],
        [
          'modal content',
          () => {
            const cleanup = content.__cellucidCleanup;
            if (cleanup === undefined || cleanup === null) return;
            if (typeof cleanup !== 'function') {
              throw new TypeError(
                'Community annotation modal content cleanup must be a function'
              );
            }
            cleanup();
          }
        ],
        ['modal overlay', () => overlay.remove()],
        ['modal document layer', releaseDocumentOwnership],
        ['previous focus target', restorePreviousFocus]
      ]);
    } finally {
      closing = false;
    }
    closed = true;
    runExactCleanup('Community annotation modal close settlement', [
      ['shared modal owner', () => {
        if (
          typeof releaseClaim !== 'function' ||
          releaseClaim() !== true
        ) {
          throw new Error(
            'Community annotation modal lost its exact owner before teardown'
          );
        }
      }],
      ['modal close owner', () => {
        overlay[COMMUNITY_MODAL_LOCAL_CLOSE] = null;
      }],
      ['modal close settlement', onClosed]
    ]);
  };
  const requestClose = () => close();

  const onKeyDown = (e) => {
    if (!e || typeof e.preventDefault !== 'function' || typeof e.stopPropagation !== 'function') {
      throw new TypeError('Community annotation modal key events require exact event methods');
    }
    if (e.key === 'Escape') {
      const escapeOwner = e.target?.[COMMUNITY_MODAL_ESCAPE_OWNER] ?? null;
      if (escapeOwner !== null) {
        if (typeof escapeOwner !== 'function') {
          throw new TypeError(
            'Community annotation Escape owner must be a function or null'
          );
        }
        const handled = escapeOwner();
        if (typeof handled !== 'boolean') {
          throw new TypeError(
            'Community annotation Escape owner must return a boolean'
          );
        }
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = listFocusable();
    if (!focusables.length) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const containsActive = active && modal.contains(active);
    if (e.shiftKey) {
      if (!containsActive || active === first) {
        if (typeof last.focus !== 'function') {
          throw new TypeError('Community annotation focus target must expose focus()');
        }
        e.preventDefault();
        last.focus();
      }
      return;
    }
    if (!containsActive || active === last) {
      if (typeof first.focus !== 'function') {
        throw new TypeError('Community annotation focus target must expose focus()');
      }
      e.preventDefault();
      first.focus();
    }
  };

  closeBtn.addEventListener('click', requestClose);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) requestClose();
  });
  overlay.addEventListener('keydown', onKeyDown, true);
  overlay[COMMUNITY_MODAL_LOCAL_CLOSE] = requestClose;

  let ownerClaimed = false;
  try {
    releaseClaim = claimCommunityAnnotationModal(requestClose);
    ownerClaimed = true;
    releaseDocumentLayer = claimModalDocumentLayer(overlay);
    document.body.appendChild(overlay);
    closeBtn.focus();
    return { close, overlay, modal, content };
  } catch (primaryError) {
    const errors = [primaryError];
    try {
      if (ownerClaimed) {
        close({ restoreFocus: false });
      } else {
        runExactCleanup(
          'Unclaimed community annotation modal rollback',
          [
            [
              'modal keydown listener',
              () => overlay.removeEventListener(
                'keydown',
                onKeyDown,
                true
              )
            ],
            [
              'modal content',
              () => {
                const cleanup = content.__cellucidCleanup;
                if (cleanup === undefined || cleanup === null) return;
                if (typeof cleanup !== 'function') {
                  throw new TypeError(
                    'Community annotation modal content cleanup must be a function'
                  );
                }
                cleanup();
              }
            ],
            ['modal overlay', () => overlay.remove()],
            [
              'modal close owner',
              () => {
                overlay[COMMUNITY_MODAL_LOCAL_CLOSE] = null;
              }
            ]
          ]
        );
      }
    } catch (rollbackError) {
      errors.push(rollbackError);
    }
    if (errors.length === 1) throw primaryError;
    throw new AggregateError(
      errors,
      'Community annotation modal creation and rollback failed'
    );
  }
}

export function confirmAsync({ title, message, confirmText, signal = null }) {
  if (
    signal !== null &&
    (
      typeof signal !== 'object' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function' ||
      typeof signal.aborted !== 'boolean'
    )
  ) {
    throw new TypeError(
      'Community annotation confirmation signal must be an AbortSignal or null'
    );
  }
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let cancelDialog = null;
    const settle = value => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      if (cancelDialog !== null) cancelDialog();
      else settle(false);
    };
    cancelDialog = showConfirmDialog({
      title,
      message,
      confirmText,
      onConfirm: () => settle(true),
      onCancel: () => settle(false)
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
