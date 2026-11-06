/**
 * @fileoverview The page's global keys: F (fullscreen), H (the sidebar), 1,
 * 2 and 3 (a dimension's views), ? (the shortcuts), X (clear the highlight
 * page), O, P and G (the navigation mode). Each that changes state goes
 * through its action (`main.js` wires them), so a key records exactly the
 * step its control would, and a key that is no shortcut here changes nothing
 * (`isShortcutPress`).
 * @module ui/onboarding/keyboard-shortcuts
 */

import { isWelcomeModalVisible } from './welcome-modal.js';

let shortcutsCallbacks = {
  onResetCamera: null,
  onToggleFullscreen: null,
  onToggleSidebar: null,
  onCycleRepresentation: null,
  onShowHelp: null,
  onClearHighlights: null,
  onSetNavigationMode: null
};

let shortcutsListenerAttached = false;

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch((err) => {
      console.warn('Fullscreen request failed:', err);
    });
    return;
  }
  document.exitFullscreen();
}

function showShortcutsHelp() {
  const shortcutsSection = document.getElementById('shortcuts-section');
  if (!shortcutsSection) return;
  shortcutsSection.open = true;
  shortcutsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Whether a key press is one of these shortcuts' to take: not typed into a
 * field (an input, a select, anything editable), not a chord with Ctrl, ⌘ or
 * Alt (⌘P prints, ⌘F finds, ⌘1 picks a browser tab: the browser's and the
 * system's keys, never a navigation mode, the fullscreen or a view), and not
 * the auto-repeat of a key held down (H held would hide and show the sidebar
 * over and over, a step each).
 *
 * @param {{target?: object|null, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, repeat?: boolean}} event
 * @returns {boolean}
 */
export function isShortcutPress(event) {
  const target = event.target ?? null;
  const tagName = String(target?.tagName || '');
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || target?.isContentEditable === true) {
    return false;
  }
  return !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat;
}

function handleGlobalKeyDown(e) {
  if (!isShortcutPress(e)) return;

  if (isWelcomeModalVisible() && e.key !== 'Escape') {
    return;
  }

  const key = String(e.key || '').toLowerCase();
  switch (key) {
    case 'f':
      e.preventDefault();
      if (shortcutsCallbacks.onToggleFullscreen) {
        shortcutsCallbacks.onToggleFullscreen();
      } else {
        toggleFullscreen();
      }
      break;
    case 'h':
      e.preventDefault();
      if (shortcutsCallbacks.onToggleSidebar) shortcutsCallbacks.onToggleSidebar();
      break;
    case '1':
      e.preventDefault();
      if (shortcutsCallbacks.onCycleRepresentation) shortcutsCallbacks.onCycleRepresentation(1);
      break;
    case '2':
      e.preventDefault();
      if (shortcutsCallbacks.onCycleRepresentation) shortcutsCallbacks.onCycleRepresentation(2);
      break;
    case '3':
      e.preventDefault();
      if (shortcutsCallbacks.onCycleRepresentation) shortcutsCallbacks.onCycleRepresentation(3);
      break;
    case '?':
      e.preventDefault();
      if (shortcutsCallbacks.onShowHelp) {
        shortcutsCallbacks.onShowHelp();
      } else {
        showShortcutsHelp();
      }
      break;
    case 'x':
      e.preventDefault();
      if (shortcutsCallbacks.onClearHighlights) shortcutsCallbacks.onClearHighlights();
      break;
    case 'o':
      e.preventDefault();
      if (shortcutsCallbacks.onSetNavigationMode) shortcutsCallbacks.onSetNavigationMode('orbit');
      break;
    case 'p':
      e.preventDefault();
      if (shortcutsCallbacks.onSetNavigationMode) shortcutsCallbacks.onSetNavigationMode('planar');
      break;
    case 'g':
      e.preventDefault();
      if (shortcutsCallbacks.onSetNavigationMode) shortcutsCallbacks.onSetNavigationMode('free');
      break;
  }
}

export function initKeyboardShortcuts(callbacks = {}) {
  shortcutsCallbacks = { ...shortcutsCallbacks, ...callbacks };
  if (shortcutsListenerAttached) return;
  shortcutsListenerAttached = true;
  document.addEventListener('keydown', handleGlobalKeyDown);
}

