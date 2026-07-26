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
  if (typeof window === 'undefined') return false;
  if (typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') {
    throw new Error('CustomEvent dispatch is required for annotation connection updates');
  }
  window.dispatchEvent(
    new CustomEvent(ANNOTATION_CONNECTION_CHANGED_EVENT, { detail })
  );
  return true;
}
