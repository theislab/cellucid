/**
 * @fileoverview Small pieces the State panel's modules share: glyphs, the
 * undo key as this platform writes it, every question of the history asked
 * in the app's one confirmation dialog (a delete, a squash, the paused card,
 * a name), and the one way a history operation that failed is told.
 *
 * @module ui/modules/state/shared
 */

import { showConfirmDialog } from '../../components/confirm-dialog.js';
import { getNotificationCenter } from '../../../notification-center.js';
import { failureDetails, isReported, sayFailure } from '../../../../utils/errors.js';
import { ActionRefused } from '../../../actions/dispatcher.js';

/** Decorative glyphs (the buttons are named by their labels). */
export const STATE_ICONS = Object.freeze({
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"/></svg>',
  compare: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><rect x="3" y="4" width="8" height="16"/><rect x="13" y="4" width="8" height="16"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><polygon points="8,5 19,12 8,19"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><rect x="6" y="6" width="12" height="12"/></svg>',
  previous: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><rect x="5" y="5" width="2.5" height="14"/><polygon points="19,5 9,12 19,19"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><polygon points="5,5 15,12 5,19"/><rect x="16.5" y="5" width="2.5" height="14"/></svg>',
});

/** Whether this is a Mac, where the undo key is Command. */
export function isApplePlatform(navigatorOwner = globalThis.navigator) {
  const platform = navigatorOwner?.userAgentData?.platform ?? navigatorOwner?.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * A Ctrl/⌘ shortcut as this platform writes it: "⌘G" and "⇧⌘B" on a Mac,
 * "Ctrl+G" and "Ctrl+Shift+B" elsewhere.
 *
 * @param {string} key - the letter
 * @param {{shift?: boolean}} [options]
 */
export function commandKey(key, { shift = false } = {}, navigatorOwner = globalThis.navigator) {
  return isApplePlatform(navigatorOwner)
    ? `${shift ? '⇧' : ''}⌘${key}`
    : `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}

/** The undo and redo keys as this platform writes them. */
export function undoKeys(navigatorOwner = globalThis.navigator) {
  return { undo: commandKey('Z', {}, navigatorOwner), redo: commandKey('Z', { shift: true }, navigatorOwner) };
}

/**
 * Ask one question of the history (a delete, a squash, the paused card, a
 * name) in the app's one confirmation dialog (`confirm-dialog.js`): a
 * title, what will happen (a sentence, then a list), an optional name to
 * type (checked by `input.validate` before it is taken), an optional
 * checkbox whose answer may change the sentences, and one or two answers
 * besides Cancel. Resolves the answer chosen, or null when it was canceled.
 *
 * @param {{title: string, lines: string[] | ((option: boolean) => string[]),
 *   input?: {label: string, value?: string, validate?: (value: string) => (string|null)}|null,
 *   option?: {label: string, checked?: boolean}|null,
 *   answers: Array<{value: string, label: string, tone?: 'primary'|'danger'|'secondary'}>}} question -
 *   `answers`: the last is the confirming one; a first of two is the other way on
 * @returns {Promise<{answer: string, option: boolean, value: string}|null>}
 */
export function askHistory({ title, lines, input = null, option = null, answers }) {
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > 2) throw new TypeError('A history question has one or two answers');
  const confirm = answers[answers.length - 1];
  const other = answers.length === 2 ? answers[0] : null;
  const linesOf = checked => (typeof lines === 'function' ? lines(checked) : lines);
  // Asked from a dialog (the branch map, Recently deleted), the question
  // opens over it, and focus goes back into it after.
  return new Promise(resolve => {
    showConfirmDialog({
      title,
      describe: checked => {
        const [message = '', ...details] = linesOf(checked);
        return { message, details };
      },
      option,
      confirmText: confirm.label,
      tone: confirm.tone === 'danger' ? 'danger' : 'primary',
      inputKind: 'line',
      inputLabel: input?.label ?? null,
      inputDefaultValue: input?.value ?? '',
      inputMaxLength: null,
      validate: input?.validate ?? null,
      alternativeText: other?.label ?? null,
      onConfirm: (value, checked) => resolve({ answer: confirm.value, option: checked, value: value ?? '' }),
      ...(other === null ? {} : { onAlternative: checked => resolve({ answer: other.value, option: checked, value: '' }) }),
      onCancel: () => resolve(null),
    });
  });
}

/** The id of the last edit's toast, dismissed when the next one comes. */
let lastEditToast = null;

/**
 * Tell the person an edit of the history happened, with Undo for a while
 * ("Squashed 6 steps · Undo", 8 s; Recently deleted keeps
 * it after that). Each edit's toast replaces the one before, so a run of
 * edits (and a phone's narrow stack) shows one card: the latest, whose Undo
 * is the one that applies.
 *
 * @param {string} text
 * @param {(() => void)|null} undo
 */
export function toastEdit(text, undo) {
  const center = getNotificationCenter();
  if (lastEditToast !== null) center.dismiss(lastEditToast);
  lastEditToast = center.success(text, {
    category: 'session',
    duration: 8000,
    ...(undo === null ? {} : { action: { label: 'Undo', run: undo } }),
  });
}

/**
 * Tell the person a history operation failed, once, in one sentence; a broken
 * invariant of the code is said as that, its text under Details and its stack
 * in the console. A refusal (`ActionRefused`: the action
 * said why it cannot be done) is the answer, not a fault of the page: it is
 * told and not logged as an error, as every control's refusal is
 * (`actions/control-dispatch.js`).
 *
 * @param {string} what - What was being done ("Undo", "Deleting the step")
 * @param {unknown} error
 */
export function reportHistoryFailure(what, error) {
  if (!(error instanceof ActionRefused)) console.error(`[state] ${what} failed`, error);
  if (isReported(error)) return;
  // A refusal that says a problem inside Cellucid in its sentence (a replayed step's, its `reason`)
  // keeps that problem's words under Details, as the problem said on its own does (`failureDetails`).
  getNotificationCenter().error(`${what} failed: ${sayFailure(error)}`, { category: 'session', ...failureDetails(error) });
}
