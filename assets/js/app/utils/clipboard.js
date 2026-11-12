/**
 * @fileoverview Copying text for the person: the one way the page writes the
 * clipboard, and it always says how it went — copied, or why not and what to
 * do (round 9: five callers wrote the clipboard themselves, one swallowed a
 * refusal in silence). Contract: `tests/one-implementation-contract.test.mjs`
 * (no other module calls `clipboard.writeText`).
 *
 * @module app/utils/clipboard
 */

import { getNotificationCenter } from '../notification-center.js';
import { upperFirst } from '../../utils/text-case.js';

/** How long a button says "Copied" / "Copy failed" before its own label comes back. */
const BUTTON_FEEDBACK_MS = 1400;

/**
 * Why the browser did not copy, in the person's words.
 *
 * @param {unknown} error
 * @returns {string}
 */
function whyNotCopied(error) {
  if (error === null) {
    return 'this page has no clipboard to write to (an http:// page other than localhost has none)';
  }
  if (error?.name === 'NotAllowedError') {
    return 'the browser did not allow it (the page must be in front and focused)';
  }
  return 'the browser refused it';
}

/**
 * Copy `text` and say so.
 *
 * Copied: `success` as a notification (none when null: the caller says it in
 * its own place), or, given a `button`, "Copied" on it for a moment. Not
 * copied: "Copy failed" on the button, and always a notification of why,
 * with `failure` after it (the text itself, to select by hand, when short).
 *
 * @param {string} text
 * @param {{what: string, success?: string|null, failure?: string|null,
 *   button?: HTMLButtonElement|null, category?: string,
 *   notifications?: {success: Function, error: Function}}} options -
 *   `what`: what is copied, as it reads in a sentence ("the link")
 * @returns {Promise<boolean>} Whether it was copied
 */
export async function copyText(text, {
  what,
  success = `Copied ${what}.`,
  failure = null,
  button = null,
  category = 'data',
  notifications = getNotificationCenter(),
} = {}) {
  if (typeof text !== 'string') throw new TypeError('Copying takes text.');
  if (typeof what !== 'string' || what.trim() === '') throw new TypeError('Copying names what is copied.');
  let refusal = null;
  const clipboard = globalThis.navigator?.clipboard ?? null;
  if (clipboard === null || typeof clipboard.writeText !== 'function') {
    refusal = { error: null };
  } else {
    try {
      await clipboard.writeText(text);
    } catch (error) {
      refusal = { error };
    }
  }
  if (button !== null) {
    const label = button.dataset.label ?? button.textContent;
    button.dataset.label = label;
    button.textContent = refusal === null ? 'Copied' : 'Copy failed';
    globalThis.setTimeout(() => {
      button.textContent = button.dataset.label;
    }, BUTTON_FEEDBACK_MS);
  }
  if (refusal === null) {
    if (button === null && success !== null) notifications.success(success, { category });
    return true;
  }
  const said = `${upperFirst(what)} could not be copied: ${whyNotCopied(refusal.error)}.`;
  notifications.error(failure === null ? said : `${said} ${failure}`, { category });
  return false;
}
