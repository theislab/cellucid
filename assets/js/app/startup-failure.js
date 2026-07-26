/**
 * @fileoverview Sole visible owner for terminal application-startup failure.
 */

/**
 * Convert JavaScript's unrestricted thrown-value channel into the sole
 * current Error contract used by startup reporting.
 *
 * @param {unknown} thrown
 * @returns {Error}
 */
export function normalizeStartupError(thrown) {
  if (
    thrown instanceof Error &&
    typeof thrown.message === 'string' &&
    thrown.message.length > 0
  ) {
    return thrown;
  }
  const error = new TypeError(
    thrown instanceof Error
      ? 'Application startup failed without an error message.'
      : 'Application startup rejected with a non-Error value.'
  );
  error.cause = thrown;
  return error;
}

function requireStartupFailureOptions(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).length !== 3 ||
    !Object.hasOwn(options, 'documentOwner') ||
    !Object.hasOwn(options, 'error') ||
    !Object.hasOwn(options, 'statsElement')
  ) {
    throw new TypeError(
      'Startup failure publication requires exactly documentOwner, error, and statsElement.'
    );
  }
  if (!(options.error instanceof Error)) {
    throw new TypeError(
      'Startup failure publication requires one Error.'
    );
  }
  const documentOwner = options.documentOwner;
  if (
    documentOwner === null ||
    typeof documentOwner !== 'object' ||
    typeof documentOwner.createElement !== 'function' ||
    typeof documentOwner.getElementById !== 'function' ||
    documentOwner.body === null ||
    typeof documentOwner.body !== 'object' ||
    typeof documentOwner.body.appendChild !== 'function'
  ) {
    throw new TypeError(
      'Startup failure publication requires the current document body.'
    );
  }
  if (
    options.statsElement !== null &&
    (
      typeof options.statsElement !== 'object' ||
      !('textContent' in options.statsElement)
    )
  ) {
    throw new TypeError(
      'Startup failure statsElement must be null or expose textContent.'
    );
  }
  return options;
}

function applyStyles(element, styles) {
  for (const [property, value] of Object.entries(styles)) {
    element.style[property] = value;
  }
}

/**
 * Publish one persistent, accessible terminal startup surface.
 *
 * @param {{
 *   documentOwner: Document,
 *   error: Error,
 *   statsElement: HTMLElement|null
 * }} options
 * @returns {HTMLElement}
 */
export function publishStartupFailure(options) {
  const {
    documentOwner,
    error,
    statsElement
  } = requireStartupFailureOptions(options);
  if (documentOwner.getElementById('cellucid-startup-failure') !== null) {
    throw new Error(
      'Terminal startup failure already has a visible owner.'
    );
  }

  const surface = documentOwner.createElement('section');
  surface.id = 'cellucid-startup-failure';
  surface.setAttribute('role', 'alert');
  surface.setAttribute('aria-live', 'assertive');
  surface.setAttribute('aria-atomic', 'true');
  applyStyles(surface, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    display: 'grid',
    placeItems: 'center',
    padding: '24px',
    background: '#f4f6f8',
    color: '#18212b',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif'
  });

  const card = documentOwner.createElement('div');
  applyStyles(card, {
    width: 'min(680px, 100%)',
    padding: '28px',
    border: '2px solid #18212b',
    borderRadius: '14px',
    background: '#ffffff',
    boxShadow: '10px 10px 0 #18212b'
  });

  const title = documentOwner.createElement('h1');
  title.textContent = 'Cellucid could not start';
  applyStyles(title, {
    margin: '0 0 12px',
    fontSize: '28px',
    lineHeight: '1.15'
  });

  const message = documentOwner.createElement('p');
  message.textContent = error.message;
  applyStyles(message, {
    margin: '0',
    fontSize: '16px',
    lineHeight: '1.55',
    overflowWrap: 'anywhere'
  });

  const action = documentOwner.createElement('p');
  action.textContent =
    'Correct the launch configuration or server response, then reload this page.';
  applyStyles(action, {
    margin: '16px 0 0',
    fontSize: '14px',
    lineHeight: '1.45',
    color: '#4b5968'
  });

  card.append(title, message, action);
  surface.appendChild(card);
  documentOwner.body.appendChild(surface);
  if (statsElement !== null) {
    statsElement.textContent = `Startup failed: ${error.message}`;
  }
  return surface;
}
