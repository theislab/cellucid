/**
 * @fileoverview Agents › Manage…: the agents connected through this
 * browser, one compact row each (who, the host that vouches for it, since
 * when, last used) with Remove, and Forget this browser, which asks in
 * place first (what goes: every connection; what happens: every Cellucid tab
 * of this browser disconnects, agents must be approved again).
 *
 * A native `<dialog>` (`components/app-dialog.js`).
 *
 * @module app/agent/connect/connections-dialog
 */

import { wireAppDialog } from '../../ui/components/app-dialog.js';
import { createButton } from '../../ui/components/controls.js';
import { describeConnection } from './model.js';

/**
 * @param {{dialog: HTMLDialogElement, status: HTMLElement, list: HTMLElement, empty: HTMLElement,
 *   forget: HTMLButtonElement, forgetConfirm: HTMLElement, forgetYes: HTMLButtonElement,
 *   forgetNo: HTMLButtonElement}} dom
 * @param {{remove: (grant: string) => Promise<void>, forget: () => Promise<void>, now?: () => number}} handlers
 * @returns {{open: (opener?: HTMLElement|null) => void, render: (connections: object[]|null, problem?: string|null) => void,
 *   readonly isOpen: boolean, destroy: () => void}}
 */
export function createConnectionsDialog(dom, { remove, forget, now = () => Date.now() }) {
  for (const key of ['dialog', 'status', 'list', 'empty', 'forget', 'forgetConfirm', 'forgetYes', 'forgetNo']) {
    if (!dom?.[key]) throw new TypeError(`The agent connections dialog needs its ${key}.`);
  }
  const doc = dom.dialog.ownerDocument;
  const app = wireAppDialog(dom.dialog);
  const controller = new AbortController();
  const { signal } = controller;

  function say(text) {
    dom.status.textContent = text;
    dom.status.hidden = text.length === 0;
  }

  function row(connection) {
    const item = doc.createElement('li');
    item.className = 'agent-connection-row';
    const text = describeConnection(connection, now());
    const body = doc.createElement('div');
    body.className = 'agent-connection-text';
    const title = doc.createElement('span');
    title.className = 'agent-connection-title';
    title.textContent = text.title;
    const meta = doc.createElement('span');
    meta.className = 'agent-connection-meta';
    meta.textContent = text.meta;
    meta.title = text.meta;
    body.append(title, meta);
    // A row of the list: its action is quiet.
    const button = createButton({ label: 'Remove', variant: 'quiet', ariaLabel: `Remove ${text.title}` });
    button.addEventListener('click', async () => {
      button.disabled = true;
      say(`Removing ${text.title}…`);
      try {
        await remove(connection.grant);
        say(`${text.title} was removed: it must be approved again to work here.`);
      } catch (error) {
        button.disabled = false;
        say(`${text.title} could not be removed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, { signal });
    item.append(body, button);
    return item;
  }

  function showConfirm(asking) {
    dom.forgetConfirm.hidden = !asking;
    dom.forget.hidden = asking;
    if (asking) dom.forgetNo.focus({ preventScroll: true });
  }

  dom.forget.addEventListener('click', () => showConfirm(true), { signal });
  dom.forgetNo.addEventListener('click', () => {
    showConfirm(false);
    dom.forget.focus({ preventScroll: true });
  }, { signal });
  dom.forgetYes.addEventListener('click', async () => {
    dom.forgetYes.disabled = true;
    say('Forgetting this browser…');
    try {
      await forget();
    } finally {
      dom.forgetYes.disabled = false;
      showConfirm(false);
    }
  }, { signal });
  dom.dialog.addEventListener('close', () => showConfirm(false), { signal });

  return {
    open(opener = null) {
      say('');
      showConfirm(false);
      app.open(opener);
    },
    /**
     * Draw the connections (null: not known, the relay unreachable, `problem` says why).
     * @param {object[]|null} connections
     * @param {string|null} [problem]
     */
    render(connections, problem = null) {
      if (connections === null) {
        dom.list.replaceChildren();
        dom.list.hidden = true;
        dom.empty.hidden = true;
        if (problem !== null) say(problem);
        return;
      }
      dom.list.replaceChildren(...connections.map(row));
      dom.list.hidden = connections.length === 0;
      dom.empty.hidden = connections.length > 0;
    },
    get isOpen() {
      return dom.dialog.open;
    },
    destroy() {
      controller.abort();
      app.destroy();
    },
  };
}
