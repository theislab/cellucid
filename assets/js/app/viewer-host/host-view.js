/**
 * @fileoverview The page of a viewer that Python or R opened, as the person
 * sees it: a hover and a click on a cell reach the host (through
 * `pointer-delivery.js`), and the end of the viewer channel (the host's
 * `freeze`, a stop, the viewer opened elsewhere, the host gone) leaves one
 * still picture of the last view, with the reason said on it and once as a
 * notification, and the application torn down beneath it.
 *
 * It owns the view's end and its pointer hooks. The channel itself is
 * `data/viewer-host-source.js`'s; the host's commands, results and history
 * events are `host-channel.js`'s; what tears the application down is the
 * start-up's (`destroyApplication`, `app/main.js`).
 *
 * @module app/viewer-host/host-view
 */

import { viewerStoppedMessage } from '../../data/viewer-channel.js';
import { createViewerHostPointerDelivery } from './pointer-delivery.js';

/**
 * Install the view of a host viewer on the page, once the channel is
 * initialized. Throws when the viewer cannot pick the cell records the
 * pointer hooks send, which ends start-up.
 *
 * @param {{
 *   viewerHostSource: import('../../data/viewer-host-source.js').ViewerHostDataSource,
 *   viewer: Object,
 *   canvas: HTMLCanvasElement,
 *   notifications: Object,
 *   destroyApplication: () => Promise<void>,
 *   applicationSignal: AbortSignal,
 * }} options - `applicationSignal` ends the canvas's listeners with the application.
 */
export function installViewerHostView({
  viewerHostSource,
  viewer,
  canvas,
  notifications,
  destroyApplication,
  applicationSignal
}) {

  // Freeze support: keep the last fully rendered view when Python stops.
  let viewerHostFrozen = false;
  let viewerHostPointerDelivery = null;
  let retireViewerHostPointerInputs = () => {};
  const reportViewerHostConsoleError = (...args) => {
    try {
      console.error(...args);
    } catch {
      // Terminal/error reporting is observational and cannot reopen input
      // or turn a listener path into a thrown failure.
    }
  };
  const freezeViewerHostView = () => {
    if (viewerHostFrozen) return false;
    // Publish the terminal fence before any fallible observer, renderer,
    // timer, or DOM work.
    viewerHostFrozen = true;
    const failures = [];
    const attempt = operation => {
      try {
        operation();
      } catch (error) {
        failures.push(error);
      }
    };
    attempt(() => retireViewerHostPointerInputs());
    attempt(() => viewerHostPointerDelivery?.freeze());
    attempt(() => viewer.pause());
    attempt(() => {
      let overlay = document.getElementById(
        'cellucid-viewer-host-freeze-overlay'
      );
      if (overlay === null) {
        overlay = document.createElement('div');
        overlay.id = 'cellucid-viewer-host-freeze-overlay';
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.zIndex = '999999';
        overlay.style.pointerEvents = 'all';
        overlay.style.background = 'transparent';
        overlay.setAttribute('aria-hidden', 'true');
        document.body.appendChild(overlay);
      }
      overlay.style.display = 'block';
      // The last frame stays as an image; everything that drew it goes
      // (the renderer and its WebGL context, the dataset's reader and
      // caches, every worker): a stopped viewer holds one picture.
      const still = document.createElement('img');
      const bounds = canvas.getBoundingClientRect();
      still.alt = 'The last view of the stopped viewer';
      still.src = canvas.toDataURL('image/png');
      still.style.position = 'fixed';
      still.style.left = `${bounds.left}px`;
      still.style.top = `${bounds.top}px`;
      still.style.width = `${bounds.width}px`;
      still.style.height = `${bounds.height}px`;
      overlay.appendChild(still);
    });
    attempt(() => {
      void destroyApplication()
        .then(() => viewerHostSource.destroy())
        .catch(error => reportViewerHostConsoleError('[Main] A stopped viewer could not let go of its memory:', error));
    });
    for (const failure of failures) {
      reportViewerHostConsoleError(
        '[Main] Viewer host freeze cleanup failed:',
        failure
      );
    }
    return true;
  };

  // The viewer channel ends when the host stops this viewer (or stops
  // altogether), when the viewer was opened again in another page, or
  // when the host cannot be reached any more. The host closing the
  // channel is the signal; nothing is polled. Whichever way it ends,
  // the page says so once: a host's own stop (`freeze`, then a normal
  // close) would otherwise leave a still picture with no controls and no
  // reason.
  let viewerHostEndSaid = false;
  const endViewerHostView = end => {
    freezeViewerHostView();
    if (viewerHostEndSaid) return;
    viewerHostEndSaid = true;
    // Said on the frozen picture itself: the overlay that keeps the
    // page from being used covers the notifications.
    try {
      const overlay = document.getElementById('cellucid-viewer-host-freeze-overlay');
      if (overlay !== null) {
        const caption = document.createElement('div');
        caption.id = 'cellucid-viewer-host-freeze-caption';
        Object.assign(caption.style, {
          position: 'fixed',
          left: '50%',
          bottom: '24px',
          transform: 'translateX(-50%)',
          maxWidth: 'min(560px, calc(100vw - 32px))',
          padding: '10px 14px',
          background: 'var(--color-surface-elevated)',
          color: 'var(--color-text-primary)',
          border: 'var(--border-default)',
          boxShadow: 'var(--shadow-md)',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--type-body)',
        });
        const title = document.createElement('strong');
        title.textContent = end.kind === 'replaced' ? 'Viewer opened elsewhere' : end.kind === 'stopped' ? 'Viewer stopped' : 'Viewer disconnected';
        caption.append(title, document.createTextNode(` ${end.message}`));
        overlay.appendChild(caption);
      }
    } catch (captionError) {
      reportViewerHostConsoleError('[Main] Viewer host end caption failed:', captionError);
    }
    try {
      // The frozen page takes no click: an offer or a question shown
      // before (Continue, a failure's Try again) could no longer be
      // answered, and goes; the end is said once more for assistive
      // technology, which the overlay hides from.
      notifications.dismissAll();
      const replaced = end.kind === 'replaced';
      notifications[replaced ? 'info' : 'error'](end.message, {
        category: 'connectivity',
        title: replaced
          ? 'Viewer opened elsewhere'
          : end.kind === 'stopped'
            ? 'Viewer stopped'
            : 'Viewer disconnected',
        duration: 0
      });
    } catch (notificationError) {
      reportViewerHostConsoleError(
        '[Main] Viewer host disconnect notification failed:',
        notificationError
      );
    }
  };
  viewerHostSource.onMessage(message => {
    if (message.type === 'freeze') {
      endViewerHostView({ kind: 'stopped', message: viewerStoppedMessage(viewerHostSource.getHostRuntime()) });
    }
  });
  viewerHostSource.onChannelEnd(end => {
    if (end.kind === 'closed') return;
    endViewerHostView(end);
  });

  if (
    typeof viewer.pickCellRecordAtScreen !== 'function'
  ) {
    throw new TypeError(
      'Viewer host pointer hooks require exact per-view picking records'
    );
  }

  let lastHoverAt = 0;
  const HOVER_THROTTLE_MS = 50;
  const reportViewerHostPointerError = (error, channel) => {
    reportViewerHostConsoleError(
      `[Main] Viewer host ${channel} pointer delivery failed:`,
      error
    );
  };
  viewerHostPointerDelivery = createViewerHostPointerDelivery({
    notifyHover: (cellIndex, position) =>
      viewerHostSource.notifyHover(cellIndex, position),
    notifyClick: (cellIndex, modifiers) =>
      viewerHostSource.notifyClick(cellIndex, modifiers),
    reportError: reportViewerHostPointerError,
  });
  const retireViewerHostView = event => {
    if (event.persisted === true) return;
    window.removeEventListener('pagehide', retireViewerHostView);
    freezeViewerHostView();
  };
  window.addEventListener('pagehide', retireViewerHostView);

  let pendingHoverClientX = 0;
  let pendingHoverClientY = 0;
  let hasPendingHoverPoint = false;
  let hoverSampleTimer = null;
  const clearHoverSampleTimer = () => {
    if (hoverSampleTimer !== null) {
      clearTimeout(hoverSampleTimer);
      hoverSampleTimer = null;
    }
  };
  retireViewerHostPointerInputs = () => {
    hasPendingHoverPoint = false;
    clearHoverSampleTimer();
  };
  const sampleLatestViewerHostHover = () => {
    hoverSampleTimer = null;
    try {
      if (viewerHostFrozen || !hasPendingHoverPoint) return;
      const now = performance.now();
      const remaining =
        HOVER_THROTTLE_MS - (now - lastHoverAt);
      if (remaining > 0) {
        hoverSampleTimer = setTimeout(
          sampleLatestViewerHostHover,
          remaining
        );
        return;
      }
      const clientX = pendingHoverClientX;
      const clientY = pendingHoverClientY;
      hasPendingHoverPoint = false;
      lastHoverAt = now;

      const pickRecord = viewer.pickCellRecordAtScreen(
        clientX,
        clientY
      );
      if (
        pickRecord !== null &&
        (
          !Object.isFrozen(pickRecord) ||
          typeof pickRecord.viewId !== 'string' ||
          pickRecord.viewId.length === 0 ||
          !Number.isSafeInteger(pickRecord.cellIndex) ||
          pickRecord.cellIndex < 0 ||
          pickRecord.position === null ||
          typeof pickRecord.position !== 'object'
        )
      ) {
        throw new TypeError(
          'Viewer host cell picking must return null or one exact frozen per-view record'
        );
      }
      if (pickRecord !== null) {
        const activePosition = pickRecord.position;
        if (
          !Object.isFrozen(activePosition) ||
          !Number.isFinite(activePosition.x) ||
          !Number.isFinite(activePosition.y) ||
          !Number.isFinite(activePosition.z)
        ) {
          throw new TypeError(
            'Viewer host hover requires one complete finite XYZ position'
          );
        }
      }
      viewerHostPointerDelivery.requestHover(pickRecord);
    } catch (error) {
      reportViewerHostPointerError(error, 'hover');
    }
  };

  canvas.addEventListener('mousemove', event => {
    pendingHoverClientX = event.clientX;
    pendingHoverClientY = event.clientY;
    hasPendingHoverPoint = true;
    if (hoverSampleTimer === null) {
      sampleLatestViewerHostHover();
    }
  }, { signal: applicationSignal });

  canvas.addEventListener('mouseleave', () => {
    try {
      if (!viewerHostFrozen) {
        hasPendingHoverPoint = false;
        clearHoverSampleTimer();
        viewerHostPointerDelivery.requestHover(null);
      }
    } catch (error) {
      reportViewerHostPointerError(error, 'hover');
    }
  }, { signal: applicationSignal });

  canvas.addEventListener('click', event => {
    try {
      if (viewerHostFrozen) return;
      const pickRecord = viewer.pickCellRecordAtScreen(
        event.clientX,
        event.clientY
      );
      if (
        pickRecord !== null &&
        (
          !Object.isFrozen(pickRecord) ||
          typeof pickRecord.viewId !== 'string' ||
          pickRecord.viewId.length === 0 ||
          !Number.isSafeInteger(pickRecord.cellIndex) ||
          pickRecord.cellIndex < 0
        )
      ) {
        throw new TypeError(
          'Viewer host cell picking must return null or one exact frozen per-view record'
        );
      }
      if (pickRecord === null) return;
      viewerHostPointerDelivery.requestClick({
        cellIndex: pickRecord.cellIndex,
        button: event.button,
        shift: event.shiftKey,
        ctrl: event.ctrlKey || event.metaKey,
      });
    } catch (error) {
      reportViewerHostPointerError(error, 'click');
    }
  }, { signal: applicationSignal });
}
