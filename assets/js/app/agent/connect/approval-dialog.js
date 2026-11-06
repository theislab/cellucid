/**
 * @fileoverview The question a connection asks: "Connect Claude?", who asks
 * (the agent and the host that vouches for it), where the answer goes, the
 * warnings the person needs, the connect code to compare with the page that
 * asked, and Allow / Deny. An approval that expires while it waits leaves
 * the dialog (the panel says so).
 *
 * Approvals wait in arrival order; one is asked at a time. Closing the
 * dialog without an answer (Escape, a click beside it) denies, so nothing
 * stays half-answered;
 * an approval whose code expires meanwhile leaves the queue and says so.
 * A native `<dialog>` (`components/app-dialog.js`): focus trap, Escape and
 * the return of focus come from the browser.
 *
 * @module app/agent/connect/approval-dialog
 */

import { wireAppDialog } from '../../ui/components/app-dialog.js';
import { describeApproval } from './model.js';

/**
 * @param {{dialog: HTMLDialogElement, title: HTMLElement, who: HTMLElement, where: HTMLElement,
 *   warnings: HTMLElement, code: HTMLElement, status: HTMLElement, allow: HTMLButtonElement,
 *   deny: HTMLButtonElement}} dom
 * @param {{decide: (code: string, allow: boolean) => Promise<void>,
 *   decided: (approval: object, allow: boolean) => void,
 *   failed: (approval: object, error: Error) => void}} handlers - `decide`: answer at the relay;
 *   `decided`: it was answered; `failed`: the answer did not reach the relay
 * @returns {{ask: (approval: object) => void, expire: (code: string) => void, readonly pending: number, destroy: () => void}}
 */
export function createApprovalDialog(dom, { decide, decided, failed }) {
  for (const key of ['dialog', 'title', 'who', 'where', 'warnings', 'code', 'status', 'allow', 'deny']) {
    if (!dom?.[key]) throw new TypeError(`The connection approval dialog needs its ${key}.`);
  }
  const doc = dom.dialog.ownerDocument;
  const app = wireAppDialog(dom.dialog);
  const controller = new AbortController();
  const { signal } = controller;
  /** Approvals waiting, by code, in arrival order; the first is the one shown. */
  const queue = new Map();
  let shown = null;
  let answering = false;

  function render(approval) {
    const text = describeApproval(approval);
    dom.title.textContent = text.title;
    dom.who.textContent = text.who;
    dom.where.textContent = text.where;
    dom.warnings.replaceChildren(...text.warnings.map(warning => {
      const item = doc.createElement('li');
      item.textContent = warning;
      return item;
    }));
    dom.warnings.hidden = text.warnings.length === 0;
    dom.code.textContent = approval.display;
    dom.status.textContent = '';
    dom.status.hidden = true;
    dom.allow.disabled = false;
    dom.deny.disabled = false;
    dom.allow.textContent = `Allow ${approval.client.agent}`;
  }

  function showNext() {
    shown = queue.values().next().value ?? null;
    if (shown === null) {
      app.close();
      return;
    }
    render(shown);
    // Deny first in the focus order: allowing takes a deliberate move.
    app.open(null);
    dom.deny.focus({ preventScroll: true });
  }

  async function answer(allow) {
    const approval = shown;
    if (approval === null || answering) return;
    answering = true;
    dom.allow.disabled = true;
    dom.deny.disabled = true;
    dom.status.textContent = allow ? 'Allowing…' : 'Denying…';
    dom.status.hidden = false;
    try {
      await decide(approval.code, allow);
      queue.delete(approval.code);
      decided(approval, allow);
      showNext();
    } catch (error) {
      queue.delete(approval.code);
      failed(approval, error instanceof Error ? error : new Error(String(error)));
      showNext();
    } finally {
      answering = false;
    }
  }

  dom.allow.addEventListener('click', () => void answer(true), { signal });
  dom.deny.addEventListener('click', () => void answer(false), { signal });
  // Closed with a question open (Escape, a click beside it) denies it: the
  // safe answer, and the app that asked can ask again.
  dom.dialog.addEventListener('close', () => {
    if (shown !== null && !answering) void answer(false);
  }, { signal });

  return {
    /** Ask about `approval` (after those already waiting). */
    ask(approval) {
      if (queue.has(approval.code)) return;
      queue.set(approval.code, approval);
      if (shown === null) showNext();
    },
    /** The approval of `code` expired (or was answered elsewhere): it leaves the queue. */
    expire(code) {
      if (!queue.has(code) || (shown?.code === code && answering)) return;
      queue.delete(code);
      if (shown?.code === code) showNext();
    },
    get pending() {
      return queue.size;
    },
    destroy() {
      controller.abort();
      app.destroy();
      queue.clear();
    },
  };
}
