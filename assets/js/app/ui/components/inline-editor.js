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

const activeEditorCancelers = new WeakMap();
const activeTargetCancelers = new WeakMap();

export class InlineEditor {
  /**
   * Cancel one exact active editor without invoking its save callback.
   *
   * @param {HTMLInputElement} input
   * @returns {boolean} Whether the input still owned an active editor
   */
  static cancel(input) {
    const cancel = activeEditorCancelers.get(input);
    if (cancel === undefined) return false;
    cancel();
    return true;
  }

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

    const previousCancel = activeTargetCancelers.get(targetEl);
    if (previousCancel !== undefined) {
      previousCancel();
    }

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
    let cancelEditor = null;

    const cleanup = () => {
      activeEditorCancelers.delete(input);
      if (activeTargetCancelers.get(targetEl) === cancelEditor) {
        activeTargetCancelers.delete(targetEl);
      }
      let failure = null;
      try {
        input.remove();
      } catch (error) {
        failure = error;
      }
      try {
        targetEl.style.display = originalDisplay || '';
      } catch (error) {
        failure = failure === null
          ? error
          : new AggregateError(
              [failure, error],
              'Inline editor DOM cleanup failed.'
            );
      }
      if (failure !== null) throw failure;
    };

    const finish = (shouldSave) => {
      if (finished) return;
      finished = true;

      const nextValue = input.value.trim();
      let callbackFailure = null;
      try {
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
      } catch (error) {
        callbackFailure = error;
      }

      let cleanupFailure = null;
      try {
        cleanup();
      } catch (error) {
        cleanupFailure = error;
      }
      if (callbackFailure !== null && cleanupFailure !== null) {
        throw new AggregateError(
          [callbackFailure, cleanupFailure],
          'Inline editor callback and cleanup both failed.'
        );
      }
      if (callbackFailure !== null) throw callbackFailure;
      if (cleanupFailure !== null) throw cleanupFailure;
    };
    cancelEditor = () => finish(false);
    activeEditorCancelers.set(input, cancelEditor);
    activeTargetCancelers.set(targetEl, cancelEditor);

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
      if (finished) return;
      input.focus();
      input.select();
    });

    return input;
  }
}
