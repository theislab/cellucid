/**
 * @fileoverview Pointer capture for a drag that has to keep its pointer when
 * it leaves the element.
 *
 * `setPointerCapture` and `releasePointerCapture` throw `NotFoundError` for a
 * pointer the browser no longer tracks (it ended before the call, or the
 * event was synthesized); the drag then goes on without capture. Any other
 * failure is a defect and is thrown.
 *
 * @module ui/pointer-capture
 */

/**
 * @param {Element} element
 * @param {number} pointerId
 * @returns {boolean} Whether the pointer is captured.
 */
export function capturePointer(element, pointerId) {
  try {
    element.setPointerCapture(pointerId);
    return true;
  } catch (error) {
    if (error?.name === 'NotFoundError') return false;
    throw error;
  }
}

/**
 * @param {Element} element
 * @param {number} pointerId
 */
export function releasePointer(element, pointerId) {
  try {
    element.releasePointerCapture(pointerId);
  } catch (error) {
    if (error?.name !== 'NotFoundError') throw error;
  }
}
