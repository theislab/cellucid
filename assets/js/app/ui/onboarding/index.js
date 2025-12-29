/**
 * @fileoverview Onboarding entrypoint.
 * @module ui/onboarding
 */

import { initKeyboardShortcuts } from './keyboard-shortcuts.js';
import { initWelcomeModal } from './welcome-modal.js';

export { initKeyboardShortcuts } from './keyboard-shortcuts.js';
export {
  initWelcomeModal,
  showWelcomeModal,
  hideWelcomeModal,
  isWelcomeModalVisible,
  shouldShowWelcome
} from './welcome-modal.js';

export function initOnboarding(config = {}) {
  const { welcomeCallbacks = {}, shortcutCallbacks = {} } = config;
  initWelcomeModal(welcomeCallbacks);
  initKeyboardShortcuts(shortcutCallbacks);
}

