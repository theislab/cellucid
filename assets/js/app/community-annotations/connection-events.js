/**
 * @fileoverview Community annotation connection change events.
 *
 * Used to keep UI modules in sync when the annotation repo connection state
 * changes (connect/disconnect, dev simulate toggles).
 *
 * @module community-annotations/connection-events
 */

export const ANNOTATION_CONNECTION_CHANGED_EVENT = 'cellucid:annotation-connection-changed';

export function dispatchAnnotationConnectionChanged(detail = null) {
  try {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return false;
    try {
      window.dispatchEvent(new CustomEvent(ANNOTATION_CONNECTION_CHANGED_EVENT, { detail: detail || null }));
      return true;
    } catch {
      window.dispatchEvent(new Event(ANNOTATION_CONNECTION_CHANGED_EVENT));
      return true;
    }
  } catch {
    return false;
  }
}

