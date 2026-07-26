/**
 * Drop zone helper to standardize drag/drop wiring.
 *
 * This keeps drag/drop boilerplate out of feature components (e.g. CategoryBuilder).
 */

/**
 * @param {HTMLElement} el
 * @param {object} options
 * @param {(dataTransfer: DataTransfer) => void} options.onDrop
 * @param {string} options.dragClass
 * @param {AbortSignal} options.signal
 */
export function bindDropZone(el, options) {
  if (el === null || typeof el !== 'object') {
    throw new TypeError(
      'Drop zone requires one document-owned HTMLElement'
    );
  }
  const ownerDocument = el.ownerDocument;
  if (ownerDocument === null || ownerDocument === undefined) {
    throw new TypeError(
      'Drop zone requires one document-owned HTMLElement'
    );
  }
  const view = ownerDocument.defaultView;
  if (
    view === null
    || view === undefined
    || !(el instanceof view.HTMLElement)
  ) {
    throw new TypeError(
      'Drop zone requires one document-owned HTMLElement'
    );
  }
  if (
    options === null
    || typeof options !== 'object'
    || Array.isArray(options)
    || Object.keys(options).sort().join(',') !==
      'dragClass,onDrop,signal'
  ) {
    throw new TypeError(
      'Drop zone options must contain exactly dragClass, onDrop, and signal'
    );
  }
  const { onDrop, dragClass, signal } = options;
  if (typeof onDrop !== 'function') {
    throw new TypeError('Drop zone onDrop must be a function');
  }
  if (
    typeof dragClass !== 'string'
    || dragClass.length === 0
    || dragClass !== dragClass.trim()
  ) {
    throw new TypeError(
      'Drop zone dragClass must be a non-empty trimmed string'
    );
  }
  if (!(signal instanceof view.AbortSignal)) {
    throw new TypeError(
      'Drop zone signal must be an AbortSignal from the owning document'
    );
  }

  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer === null) {
      throw new TypeError('Drop-zone dragover requires DataTransfer');
    }
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add(dragClass);
  }, { signal });

  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) {
      el.classList.remove(dragClass);
    }
  }, { signal });

  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove(dragClass);
    if (e.dataTransfer === null) {
      throw new TypeError('Drop-zone drop requires DataTransfer');
    }
    onDrop(e.dataTransfer);
  }, { signal });
}
