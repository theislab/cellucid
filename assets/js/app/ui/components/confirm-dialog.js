/**
 * The app's one confirmation dialog (a destructive action, a name to type, a
 * choice of two): a native `<dialog>` opened through `wireAppDialog`
 * (`app-dialog.js`), which owns the backdrop, Escape, the inert page, the
 * stacking over any dialog already open and the return of focus.
 */

import { escapeHtml } from '../utils.js';
import { wireAppDialog } from './app-dialog.js';
import { createDomId } from './dom-id.js';

/** The open question's cancel: a new question replaces it. */
let activeCancel = null;

/**
 * Ask the user to confirm an action.
 *
 * `tone` names what the confirm button does: 'danger' (the default) for an
 * action that removes or overwrites something, drawn as `.btn-danger`;
 * 'primary' for one that only adds, combines or connects, drawn as
 * `.btn-primary`.
 *
 * `alternativeText` adds a second way to go on, between Cancel and the
 * confirm button (`onAlternative`): a choice of two (undo only an agent's
 * steps, or everything since its turn began).
 *
 * What will happen can be said as a sentence and a list (`details`); an
 * `option` is one checkbox, and `describe(checked)` words the sentence and
 * the list again when it changes (delete a branch with its sub-branches).
 * `inputKind: 'line'` asks for a name on one line (Enter confirms) instead
 * of a note; `inputMaxLength: null` sets no length limit; `validate(value)`
 * says why a value cannot be taken, and the dialog stays open. Both answers
 * get `(value, optionChecked)`.
 */
export function showConfirmDialog({
  title,
  message,
  confirmText = 'Delete',
  tone = 'danger',
  inputLabel = null,
  inputPlaceholder = null,
  inputDefaultValue = '',
  inputMaxLength = 512,
  inputKind = 'text',
  details = [],
  option = null,
  describe = null,
  validate = null,
  alternativeText = null,
  onConfirm,
  onAlternative,
  onCancel
}) {
  if (tone !== 'danger' && tone !== 'primary') {
    throw new TypeError(`Confirm dialog tone must be 'danger' or 'primary' (got ${String(tone)})`);
  }
  if (alternativeText !== null && typeof onAlternative !== 'function') {
    throw new TypeError('A confirm dialog with an alternative needs onAlternative');
  }
  activeCancel?.();

  const dialog = document.createElement('dialog');
  dialog.className = 'app-dialog confirm-dialog';
  const titleId = createDomId('confirm-dialog-title');
  const inputId = createDomId('confirm-dialog-input');
  dialog.setAttribute('aria-labelledby', titleId);

  const wantsInput = Boolean(inputLabel || inputPlaceholder);
  const lengthLimit = inputMaxLength === null ? '' : `maxlength="${escapeHtml(String(inputMaxLength))}"`;
  const inputBlock = wantsInput && inputKind === 'line'
    ? `
      <div class="confirm-dialog-input">
        ${inputLabel ? `<label for="${escapeHtml(inputId)}">${escapeHtml(inputLabel)}</label>` : ''}
        <input type="text" id="${escapeHtml(inputId)}" class="obs-select confirm-dialog-textarea" autocomplete="off" spellcheck="false" ${lengthLimit}
          placeholder="${escapeHtml(inputPlaceholder || '')}" value="${escapeHtml(inputDefaultValue || '')}"
          ${inputLabel ? '' : `aria-label="${escapeHtml(inputPlaceholder || 'Name')}"`} />
      </div>
    `
    : wantsInput
    ? `
      <div class="confirm-dialog-input">
        ${inputLabel ? `<label for="${escapeHtml(inputId)}">${escapeHtml(inputLabel)}</label>` : ''}
        <div class="confirm-dialog-textarea-wrap">
          <textarea
            id="${escapeHtml(inputId)}"
            class="obs-select confirm-dialog-textarea"
            rows="3"
            ${lengthLimit}
            placeholder="${escapeHtml(inputPlaceholder || '')}"
            ${inputLabel ? '' : `aria-label="${escapeHtml(inputPlaceholder || 'Note')}"`}
          >${escapeHtml(inputDefaultValue || '')}</textarea>
          <div class="confirm-dialog-char-counter confirm-dialog-char-counter--overlay"></div>
        </div>
      </div>
    `
    : '';

  dialog.innerHTML = `
    <div class="confirm-dialog-header">
      <span class="confirm-dialog-title" id="${escapeHtml(titleId)}">${escapeHtml(title || 'Confirm')}</span>
    </div>
    <div class="confirm-dialog-body">
      <p class="confirm-dialog-message"></p>
      <ul class="confirm-dialog-list" hidden></ul>
      ${inputBlock}
      <p class="confirm-dialog-problem status-line" data-tone="danger" role="alert" hidden></p>
      ${option === null ? '' : `<label class="checkbox-inline confirm-dialog-option"><input type="checkbox" ${option.checked ? 'checked' : ''} /> ${escapeHtml(option.label)}</label>`}
    </div>
    <div class="confirm-dialog-actions">
      <button type="button" class="btn confirm-dialog-cancel">Cancel</button>
      ${alternativeText === null ? '' : `<button type="button" class="btn confirm-dialog-alternative">${escapeHtml(alternativeText)}</button>`}
      <button type="button" class="btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'} confirm-dialog-confirm">${escapeHtml(confirmText)}</button>
    </div>
  `;

  // How the question was answered; null until a button answers it, so a
  // close by Escape, the backdrop or a newer question is a cancel.
  let answered = false;
  const owner = wireAppDialog(dialog, {
    onClose: () => {
      dialog.remove();
      if (activeCancel === cancel) activeCancel = null;
      if (!answered) onCancel?.();
    }
  });
  const cancel = () => owner.close();
  /** Close, then hand the answer on (focus is back by then). */
  const answer = (then) => {
    answered = true;
    owner.close();
    then();
  };

  const cancelBtn = dialog.querySelector('.confirm-dialog-cancel');
  const confirmBtn = dialog.querySelector('.confirm-dialog-confirm');
  const alternativeBtn = dialog.querySelector('.confirm-dialog-alternative');
  const textarea = dialog.querySelector('.confirm-dialog-textarea');
  const charCounter = dialog.querySelector('.confirm-dialog-char-counter');
  const optionBox = dialog.querySelector('.confirm-dialog-option input');
  const problem = dialog.querySelector('.confirm-dialog-problem');
  const messageEl = dialog.querySelector('.confirm-dialog-message');
  const listEl = dialog.querySelector('.confirm-dialog-list');
  const checked = () => optionBox?.checked === true;
  // The sentence and the list, as text (never markup), worded again when the option changes.
  const words = () => {
    const said = typeof describe === 'function' ? describe(checked()) : { message, details };
    messageEl.textContent = said.message || '';
    listEl.replaceChildren(...(said.details ?? []).map(line => Object.assign(document.createElement('li'), { textContent: line })));
    listEl.hidden = (said.details ?? []).length === 0;
  };
  words();
  optionBox?.addEventListener('change', words);
  /** Whether the value can be taken; else the reason stays under the field. */
  const accepted = () => {
    const why = wantsInput && typeof validate === 'function' ? validate(String(textarea?.value || '')) : null;
    problem.hidden = why === null;
    problem.textContent = why ?? '';
    if (why !== null) textarea?.focus?.();
    return why === null;
  };
  if (inputKind === 'line') {
    textarea?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        confirmBtn?.click();
      }
    });
  }

  if (wantsInput && textarea && charCounter && inputMaxLength !== null) {
    const maxLen = Number.parseInt(textarea.getAttribute('maxlength') || '', 10);
    const maxLabel = Number.isFinite(maxLen) && maxLen > 0 ? maxLen : null;
    const updateCounter = () => {
      const cur = String(textarea.value || '').length;
      charCounter.textContent = `${cur}/${maxLabel ?? '—'}`;
    };
    textarea.addEventListener('input', updateCounter, { passive: true });
    updateCounter();
  }

  cancelBtn.addEventListener('click', cancel);
  confirmBtn.addEventListener('click', () => {
    if (!accepted()) return;
    const note = wantsInput ? String(textarea?.value || '') : null;
    const option = checked();
    answer(() => onConfirm?.(note, option));
  });
  alternativeBtn?.addEventListener('click', () => {
    const option = checked();
    answer(() => onAlternative(option));
  });

  document.body.append(dialog);
  try {
    owner.open(null, { focus: wantsInput ? textarea : confirmBtn });
  } catch (error) {
    dialog.remove();
    throw error;
  }
  // Closed while it opened (`wireAppDialog`): its onClose has run already.
  if (!dialog.open) return cancel;
  if (wantsInput) textarea.select();
  activeCancel = cancel;
  return cancel;
}
