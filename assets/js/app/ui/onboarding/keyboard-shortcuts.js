/**
 * @fileoverview Global keyboard shortcut handling used during onboarding.
 * @module ui/onboarding/keyboard-shortcuts
 */

import { isWelcomeModalVisible } from './welcome-modal.js';

let shortcutsCallbacks = {
  onResetCamera: null,
  onToggleFullscreen: null,
  onToggleSidebar: null,
  onSetDimension: null,
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

function handleGlobalKeyDown(e) {
  const tagName = String(e.target?.tagName || '');
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
    return;
  }

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
      if (shortcutsCallbacks.onSetDimension) shortcutsCallbacks.onSetDimension(1);
      break;
    case '2':
      e.preventDefault();
      if (shortcutsCallbacks.onSetDimension) shortcutsCallbacks.onSetDimension(2);
      break;
    case '3':
      e.preventDefault();
      if (shortcutsCallbacks.onSetDimension) shortcutsCallbacks.onSetDimension(3);
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

