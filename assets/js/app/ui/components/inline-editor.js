/**
 * InlineEditor - reusable click-to-edit helper.
 *
 * Usage:
 *   InlineEditor.create(targetEl, currentValue, { onSave, validate })
 *
 * Notes:
 * - Works with typical text elements and also with `<select>` (we hide it temporarily).
 * - Enter or leaving the box saves; Escape cancels. A value `validate` refuses
 *   is said on the box (its validity message) and the box stays open.
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
    input.className = 'obs-select inline-rename-input';
    input.style.width = `${Math.max((rect.width || 0) + 20, minWidth)}px`;

    const wasHidden = targetEl.hidden;
    targetEl.hidden = true;
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
        targetEl.hidden = wasHidden;
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
              // Said on the box, as the browser says a refused entry (and
              // read out), until the name is changed; the box stays open.
              const reason = typeof result === 'string' ? result : 'Invalid value';
              input.setAttribute('aria-invalid', 'true');
              input.title = reason;
              input.setCustomValidity(reason);
              input.reportValidity();
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

    // A refusal said on the box goes as the name is changed.
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') !== 'true') return;
      input.removeAttribute('aria-invalid');
      input.title = '';
      input.setCustomValidity('');
    });

    // Leaving the box names it, as Enter does (a view's and a highlight
    // page's names work so too); Escape leaves it as it was. Click handlers
    // (a dialog's buttons) run first.
    input.addEventListener('blur', () => {
      setTimeout(() => finish(true), 0);
    });

    requestAnimationFrame(() => {
      if (finished) return;
      input.focus();
      input.select();
    });

    return input;
  }
}
