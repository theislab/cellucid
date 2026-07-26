function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isAbortSignal(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' &&
    typeof value.removeEventListener === 'function'
  );
}

/**
 * Require the exact internal cancellation value used between loader owners.
 * Undefined is not an alias for no signal: callers must pass either the
 * owning AbortSignal or explicit null.
 *
 * @param {unknown} signal
 * @param {string} label
 * @returns {AbortSignal|null}
 */
export function validateAbortSignalOrNull(signal, label) {
  if (signal !== null && !isAbortSignal(signal)) {
    throw new TypeError(
      `${label} must be an AbortSignal or exact null`
    );
  }
  return signal;
}

/**
 * Validate the one exact options seam shared by public metadata loaders.
 *
 * @param {unknown} options
 * @param {string} label
 * @returns {AbortSignal|null}
 */
export function getMetadataLoadSignal(options, label) {
  if (!isPlainObject(options)) {
    throw new TypeError(`${label} options must be an object`);
  }
  const unexpected = Object.keys(options).filter(key => key !== 'signal');
  if (unexpected.length > 0) {
    throw new TypeError(
      `${label} options contain unexpected key(s): ${unexpected.join(', ')}`
    );
  }
  const signal = Object.hasOwn(options, 'signal')
    ? options.signal
    : null;
  return validateAbortSignalOrNull(
    signal,
    `${label} options.signal`
  );
}

export function createMetadataAbortError(label) {
  const error = new Error(`${label} was cancelled`);
  error.name = 'AbortError';
  return error;
}

export function throwIfMetadataAborted(signal, label) {
  if (signal?.aborted) {
    throw createMetadataAbortError(label);
  }
}

/**
 * Observe a direct metadata promise while allowing its consumer to cancel.
 * Both result handlers stay attached so late completion is never unhandled.
 *
 * @template T
 * @param {Promise<T>|T} value
 * @param {AbortSignal|null} signal
 * @param {string} label
 * @returns {Promise<T>}
 */
export function waitForMetadata(value, signal, label) {
  if (!signal) {
    return Promise.resolve(value);
  }
  throwIfMetadataAborted(signal, label);

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createMetadataAbortError(label));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      result => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}
