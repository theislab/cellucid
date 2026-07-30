/**
 * Stack-aware document ownership for modal overlays.
 *
 * The top registered overlay remains interactive. Every other body child,
 * including lower modal layers and children appended while a modal is open,
 * is hidden from assistive technology and made inert. Exact pre-modal
 * attributes are restored when the final layer releases ownership.
 */

const layers = [];
const originalStates = new Map();
const auxiliaryLayers = new Map();
let bodyObserver = null;

function isAttributeOwner(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.getAttribute === 'function' &&
    typeof value.hasAttribute === 'function' &&
    typeof value.removeAttribute === 'function' &&
    typeof value.setAttribute === 'function'
  );
}

function requireOverlay(overlay) {
  if (!isAttributeOwner(overlay)) {
    throw new TypeError(
      'Modal document owner must expose exact attribute methods'
    );
  }
  return overlay;
}

function captureOriginalState(element) {
  if (!isAttributeOwner(element) || originalStates.has(element)) return;
  originalStates.set(element, {
    element,
    hadAriaHidden: element.hasAttribute('aria-hidden'),
    ariaHidden: element.getAttribute('aria-hidden'),
    hadInert: element.hasAttribute('inert'),
    inert: element.getAttribute('inert')
  });
}

function restoreAttribute(element, name, hadAttribute, value) {
  if (hadAttribute) {
    element.setAttribute(name, value ?? '');
  } else {
    element.removeAttribute(name);
  }
}

function restoreOriginalState(state) {
  restoreAttribute(
    state.element,
    'aria-hidden',
    state.hadAriaHidden,
    state.ariaHidden
  );
  restoreAttribute(
    state.element,
    'inert',
    state.hadInert,
    state.inert
  );
}

function activateElement(element) {
  element.removeAttribute('aria-hidden');
  element.removeAttribute('inert');
}

function suspendElement(element) {
  element.setAttribute('aria-hidden', 'true');
  element.setAttribute('inert', '');
}

function documentBody() {
  const body = document.body;
  if (!body || typeof body !== 'object') {
    throw new TypeError('Modal document ownership requires a document body');
  }
  return body;
}

function requireAppendOwner(value, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.appendChild !== 'function'
  ) {
    throw new TypeError(`${label} must expose appendChild()`);
  }
  return value;
}

function captureAuxiliaryPlacement(state) {
  if (state.placement !== null) return;
  const parent = state.element.parentNode;
  requireAppendOwner(parent, 'Modal auxiliary parent');
  captureOriginalState(state.element);
  state.placement = {
    parent,
    previousSibling: state.element.previousSibling ?? null,
    nextSibling: state.element.nextSibling ?? null
  };
}

function resolveAuxiliaryHost(overlay) {
  let host = overlay;
  if (typeof overlay.querySelector === 'function') {
    const documentHost = overlay.querySelector('[role="document"]');
    if (documentHost !== null) host = documentHost;
  }
  return requireAppendOwner(host, 'Modal auxiliary host');
}

function placeAuxiliaryLayers(top) {
  if (top === null || auxiliaryLayers.size === 0) return;
  let host = null;
  const errors = [];
  for (const state of auxiliaryLayers.values()) {
    if (state.releasing) continue;
    try {
      host ??= resolveAuxiliaryHost(top);
      captureAuxiliaryPlacement(state);
      if (state.element.parentNode !== host) {
        host.appendChild(state.element);
      }
      activateElement(state.element);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Modal auxiliary placement failed for ${errors.length} elements`
    );
  }
}

function restoreAuxiliaryPlacement(state) {
  if (state.placement === null) return;
  const { parent, previousSibling, nextSibling } = state.placement;
  requireAppendOwner(parent, 'Modal auxiliary original parent');
  if (
    nextSibling !== null &&
    nextSibling.parentNode === parent &&
    typeof parent.insertBefore === 'function'
  ) {
    parent.insertBefore(state.element, nextSibling);
  } else if (
    previousSibling !== null &&
    previousSibling.parentNode === parent &&
    typeof parent.insertBefore === 'function'
  ) {
    const insertionPoint = previousSibling.nextSibling ?? null;
    if (insertionPoint === null) parent.appendChild(state.element);
    else parent.insertBefore(state.element, insertionPoint);
  } else {
    parent.appendChild(state.element);
  }
  state.placement = null;
}

function restoreAllAuxiliaryPlacements() {
  const errors = [];
  for (const state of [...auxiliaryLayers.values()].reverse()) {
    try {
      restoreAuxiliaryPlacement(state);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Modal auxiliary restoration failed for ${errors.length} elements`
    );
  }
}

function reconcileBody() {
  const body = documentBody();
  const top = layers.at(-1)?.overlay ?? null;
  placeAuxiliaryLayers(top);
  const errors = [];
  for (const element of Array.from(body.children ?? [])) {
    if (!isAttributeOwner(element)) continue;
    captureOriginalState(element);
    try {
      if (element === top) {
        activateElement(element);
      } else {
        suspendElement(element);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Modal document reconciliation failed for ${errors.length} elements`
    );
  }
}

function reportObserverFailure(error) {
  if (typeof globalThis.reportError === 'function') {
    globalThis.reportError(error);
    return;
  }
  try {
    console.error('Modal document ownership failed', error);
  } catch {
    // No further reporting channel is available.
  }
}

function startObserver() {
  if (bodyObserver !== null || typeof MutationObserver !== 'function') return;
  bodyObserver = new MutationObserver(() => {
    try {
      reconcileBody();
    } catch (error) {
      reportObserverFailure(error);
    }
  });
  bodyObserver.observe(documentBody(), { childList: true });
}

function restoreAllOriginalStates() {
  bodyObserver?.disconnect();
  bodyObserver = null;
  const errors = [];
  try {
    restoreAllAuxiliaryPlacements();
  } catch (error) {
    errors.push(error);
  }
  for (const state of [...originalStates.values()].reverse()) {
    try {
      restoreOriginalState(state);
      originalStates.delete(state.element);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Modal document restoration failed for ${errors.length} elements`
    );
  }
}

/**
 * Keep a global auxiliary surface, such as the notification live region, inside
 * the currently active dialog. Its exact parent/sibling placement is restored
 * when the final modal layer closes.
 *
 * @param {Element|object} element
 * @returns {() => boolean} identity-bound release callback
 */
export function registerModalDocumentAuxiliary(element) {
  const exactElement = requireOverlay(element);
  if (auxiliaryLayers.has(exactElement)) {
    throw new Error('Modal document auxiliary is already registered');
  }
  const state = {
    element: exactElement,
    placement: null,
    releasing: false
  };
  auxiliaryLayers.set(exactElement, state);
  try {
    if (layers.length > 0) reconcileBody();
  } catch (primaryError) {
    auxiliaryLayers.delete(exactElement);
    try {
      restoreAuxiliaryPlacement(state);
      if (layers.length > 0) reconcileBody();
    } catch (rollbackError) {
      throw new AggregateError(
        [primaryError, rollbackError],
        'Modal document auxiliary registration and rollback failed'
      );
    }
    throw primaryError;
  }

  let releaseState = 'active';
  return () => {
    if (releaseState === 'complete') return false;
    if (auxiliaryLayers.get(exactElement) !== state) return false;
    if (releaseState === 'active') {
      state.releasing = true;
      try {
        restoreAuxiliaryPlacement(state);
      } catch (error) {
        state.releasing = false;
        throw error;
      }
      releaseState = 'pending';
    }
    if (layers.length > 0) reconcileBody();
    auxiliaryLayers.delete(exactElement);
    state.releasing = false;
    releaseState = 'complete';
    return true;
  };
}

/**
 * Register one modal layer before appending it to `document.body`.
 *
 * @param {Element|object} overlay
 * @returns {() => boolean} identity-bound release callback
 */
export function claimModalDocumentLayer(overlay) {
  const exactOverlay = requireOverlay(overlay);
  if (layers.some((layer) => layer.overlay === exactOverlay)) {
    throw new Error('Modal document layer is already registered');
  }

  captureOriginalState(exactOverlay);
  const layer = { overlay: exactOverlay };
  layers.push(layer);
  try {
    startObserver();
    reconcileBody();
  } catch (primaryError) {
    layers.pop();
    try {
      if (layers.length === 0) restoreAllOriginalStates();
      else reconcileBody();
    } catch (rollbackError) {
      throw new AggregateError(
        [primaryError, rollbackError],
        'Modal document claim and rollback failed'
      );
    }
    throw primaryError;
  }

  let releaseState = 'active';
  return () => {
    if (releaseState === 'complete') return false;
    if (releaseState === 'active') {
      const index = layers.indexOf(layer);
      if (index < 0) return false;
      layers.splice(index, 1);
      releaseState = 'pending';
    }
    if (layers.length === 0) {
      restoreAllOriginalStates();
    } else {
      reconcileBody();
    }
    releaseState = 'complete';
    return true;
  };
}
