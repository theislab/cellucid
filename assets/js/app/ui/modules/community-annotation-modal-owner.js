/**
 * Exact cross-module owner for the single primary community-annotation modal.
 *
 * A close callback remains the owner until it either releases itself after a
 * successful teardown or a later claimant successfully invokes it. If teardown
 * throws, the failed owner stays published so a second modal cannot overlap it.
 */

/** @type {((options?: object) => void)|null} */
let activeClose = null;

function assertClose(close) {
  if (typeof close !== 'function') {
    throw new TypeError(
      'Community annotation modal close owner must be a function'
    );
  }
  return close;
}

/**
 * Claim the primary modal slot.
 *
 * @param {(options?: object) => void} close
 * @returns {() => boolean} identity-bound release callback
 */
export function claimCommunityAnnotationModal(close) {
  const exactClose = assertClose(close);
  const previous = activeClose;
  if (previous !== null && previous !== exactClose) {
    previous();
    if (activeClose !== null) {
      throw new Error(
        'Previous community annotation modal close returned without ' +
        'releasing its exact owner'
      );
    }
  }
  activeClose = exactClose;
  return () => releaseCommunityAnnotationModal(exactClose);
}

/**
 * Release only when `close` is still the exact published owner.
 *
 * @param {(options?: object) => void} close
 * @returns {boolean}
 */
export function releaseCommunityAnnotationModal(close) {
  const exactClose = assertClose(close);
  if (activeClose !== exactClose) return false;
  activeClose = null;
  return true;
}

/**
 * Close the currently published primary modal, if any.
 *
 * @param {object} [options]
 * @returns {boolean} whether an owner existed
 */
export function closeActiveCommunityAnnotationModal(options) {
  const close = activeClose;
  if (close === null) return false;
  close(options);
  return true;
}
