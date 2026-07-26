/**
 * Plotly Hints Manager
 *
 * Captures Plotly's built-in notifier toasts (".plotly-notifier") and forwards
 * their messages to the app's NotificationCenter so the UX stays consistent.
 *
 * Implementation detail:
 * Plotly calls an internal notifier function that appends ".notifier-note"
 * elements under ".plotly-notifier" on document.body. Patching Plotly internals
 * is brittle because some modules hold local references; observing the DOM is
 * reliable for all plot creation paths (PlotFactory and BasePlot).
 *
 * @module plots/plotly-hints
 */

import { getNotificationCenter } from '../../notification-center.js';

let enabled = true;
let observer = null;
let cssHidden = false;

const DEDUPE_WINDOW_MS = 1200;
const recentMessages = new Map(); // message -> timestamp

const WARNING_PATTERNS = [
  /no data/i,
  /empty/i,
  /invalid/i,
  /error/i,
  /warning/i,
  /failed/i,
  /cannot/i
];

function canUseDOM() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function shouldDedupe(text) {
  const now = Date.now();
  const last = recentMessages.get(text);
  if (last && (now - last) < DEDUPE_WINDOW_MS) return true;
  recentMessages.set(text, now);

  // Opportunistic cleanup to keep map small
  if (recentMessages.size > 200) {
    for (const [key, ts] of recentMessages) {
      if ((now - ts) > 10_000) {
        recentMessages.delete(key);
      }
    }
  }

  return false;
}

function inferLevel(text) {
  return WARNING_PATTERNS.some((re) => re.test(text)) ? 'warn' : 'info';
}

function extractNotifierText(noteEl) {
  if (!noteEl) return '';
  const p = noteEl.querySelector('p');
  const rawText = p === null ? noteEl.textContent : p.textContent;
  if (rawText === null) return '';
  const raw = rawText.trim();
  // Plotly includes a close button "×" as a separate node; prefer <p> but keep a guard.
  return raw.replace(/^×\s*/, '').trim();
}

function forward(message) {
  if (!enabled || !message) return;
  if (typeof message !== 'string') {
    throw new TypeError('Plotly notification message must be a string');
  }
  const text = message.trim();
  if (!text) return;
  if (shouldDedupe(text)) return;

  const nc = getNotificationCenter();
  if (typeof nc.show !== 'function' || typeof nc.registerCategory !== 'function') {
    throw new TypeError('NotificationCenter show and registerCategory are required');
  }
  nc.registerCategory('plot', '📊');

  const level = inferLevel(text);
  const type = level === 'warn' ? 'warning' : 'info';

  nc.show({
    type,
    category: 'plot',
    message: `Plot: ${text}`,
    duration: type === 'warning' ? 5000 : 3000,
    dismissible: true
  });
}

function handleAddedNode(node) {
  // Use numeric nodeType to avoid relying on global `Node` (safer across contexts).
  if (!node || node.nodeType !== 1) return;
  const el = /** @type {HTMLElement} */ (node);

  if (el.classList.contains('notifier-note')) {
    const text = extractNotifierText(el);
    if (text) forward(text);
    return;
  }

  // Common containers that may include notes.
  if (el.classList.contains('plotly-notifier') || el.classList.contains('notifier-container')) {
    const notes = el.querySelectorAll('.notifier-note');
    for (const note of notes) {
      const text = extractNotifierText(note);
      if (text) forward(text);
    }
    return;
  }

  // Generic: scan subtree for notes.
  const notes = el.querySelectorAll('.notifier-note');
  for (const note of notes) {
    const text = extractNotifierText(note);
    if (text) forward(text);
  }
}

function ensureObserver() {
  if (!canUseDOM()) return;
  if (observer) return;
  if (typeof MutationObserver === 'undefined') {
    throw new TypeError('MutationObserver is required for Plotly notification routing');
  }

  const root = document.body === null ? document.documentElement : document.body;
  if (!root) {
    throw new TypeError('A document root is required for Plotly notification routing');
  }

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        handleAddedNode(node);
      }
    }
  });

  observer.observe(root, { childList: true, subtree: true });
}

/**
 * Hide Plotly's native notifier UI (we show via NotificationCenter instead).
 */
export function hidePlotlyNativeHints() {
  if (!canUseDOM()) return;
  if (!enabled) return;
  ensureObserver();
  if (!observer) {
    throw new Error('Plotly notification observer was not created');
  }
  if (cssHidden) return;

  const styleId = 'plotly-notif-hide';
  if (!document.getElementById(styleId)) {
    if (!document.head) {
      throw new TypeError('document.head is required to hide native Plotly notifications');
    }
    const style = document.createElement('style');
    style.id = styleId;
    // Plotly uses ".plotly-notifier" with ".notifier-note" children.
    style.textContent = `.plotly-notifier, .notifier-container, .notifier-note { display: none !important; }`;
    document.head.appendChild(style);
  }

  cssHidden = true;
}

/**
 * Attach hint forwarding (safe to call multiple times).
 * @param {HTMLElement} [container]
 * @param {Object} [_options]
 */
export function attachPlotlyHints(container) {
  // Container is optional; DOM observer captures global Plotly notifier messages.
  // If container exists, we can opportunistically scan it for already-rendered notes.
  ensureObserver();
  if (container !== undefined && container !== null) {
    if (typeof container.querySelectorAll !== 'function') {
      throw new TypeError('Plotly hint container must support querySelectorAll');
    }
    handleAddedNode(container);
  }
}

/**
 * Enable/disable forwarding.
 */
export function setPlotlyHintsEnabled(value) {
  if (typeof value !== 'boolean') {
    throw new TypeError('Plotly hint enabled state must be boolean');
  }
  enabled = value;
}


/**
 * Destroy and restore native behavior (stop forwarding + show native toasts again).
 */
export function restorePlotlyNotifications() {
  enabled = false;
  if (canUseDOM()) {
    const style = document.getElementById('plotly-notif-hide');
    if (style !== null) style.remove();
  }
  cssHidden = false;
  if (observer !== null) observer.disconnect();
  observer = null;
}

export const getPlotlyHintsManager = () => ({
  attach: attachPlotlyHints,
  setEnabled: setPlotlyHintsEnabled,
  destroy: restorePlotlyNotifications
});

export default {
  attach: attachPlotlyHints,
  hideNative: hidePlotlyNativeHints,
  setEnabled: setPlotlyHintsEnabled,
  restore: restorePlotlyNotifications
};
