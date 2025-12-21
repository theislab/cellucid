/**
 * InlineEditor - reusable click-to-edit helper.
 *
 * Usage:
 *   InlineEditor.create(targetEl, currentValue, { onSave, validate })
 *
 * Notes:
 * - Works with typical text elements and also with `<select>` (we hide it temporarily).
 * - Styling is handled by CSS (`.inline-rename-input`).
 */

export class InlineEditor {
  /**
   * @param {HTMLElement} targetEl
   * @param {string} currentValue
   * @param {object} options
   * @param {(newValue: string) => void} options.onSave
   * @param {() => void} [options.onCancel]
   * @param {(value: string) => true|string} [options.validate]
   * @param {number} [options.minWidth=120]
   * @returns {HTMLInputElement|null}
   */
  static create(targetEl, currentValue, options) {
    if (!targetEl) return null;
    const { onSave, onCancel, validate, minWidth = 120 } = options || {};
    if (typeof onSave !== 'function') return null;

    const rect = targetEl.getBoundingClientRect?.() || { width: minWidth };
    const input = document.createElement('input');
    input.type = 'text';
    input.value = String(currentValue ?? '');
    input.className = 'inline-rename-input';
    input.style.width = `${Math.max((rect.width || 0) + 20, minWidth)}px`;

    const originalDisplay = targetEl.style.display;
    targetEl.style.display = 'none';
    targetEl.parentNode?.insertBefore(input, targetEl.nextSibling);

    let finished = false;

    const cleanup = () => {
      input.remove();
      targetEl.style.display = originalDisplay || '';
    };

    const finish = (shouldSave) => {
      if (finished) return;
      finished = true;

      const nextValue = input.value.trim();

      if (shouldSave && nextValue && nextValue !== String(currentValue ?? '').trim()) {
        if (validate) {
          const result = validate(nextValue);
          if (result !== true) {
            input.classList.add('error');
            input.title = typeof result === 'string' ? result : 'Invalid value';
            finished = false;
            input.focus();
            return;
          }
        }
        onSave(nextValue);
      } else {
        onCancel?.();
      }

      cleanup();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });

    input.addEventListener('blur', () => {
      // Allow click handlers (e.g., on dialog buttons) to run before canceling.
      setTimeout(() => finish(false), 0);
    });

    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });

    return input;
  }
}

