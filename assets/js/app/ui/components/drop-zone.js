/**
 * Drop zone helper to standardize drag/drop wiring.
 *
 * This keeps drag/drop boilerplate out of feature components (e.g. CategoryBuilder).
 */

/**
 * @param {HTMLElement} el
 * @param {object} options
 * @param {(dataTransfer: DataTransfer) => void} options.onDrop
 * @param {string} [options.dragClass='dragover']
 */
export function bindDropZone(el, { onDrop, dragClass = 'dragover' } = {}) {
  if (!el || typeof onDrop !== 'function') return;

  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    el.classList.add(dragClass);
  });

  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) {
      el.classList.remove(dragClass);
    }
  });

  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove(dragClass);
    if (e.dataTransfer) onDrop(e.dataTransfer);
  });
}

