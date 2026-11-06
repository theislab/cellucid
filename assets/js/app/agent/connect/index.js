/**
 * @fileoverview Agents › Claude and ChatGPT: this page's connection to the
 * Cellucid relay (`bridge/relay-client.js`), through which Claude and
 * ChatGPT, added as a connector, work in this browser's Cellucid tabs.
 *
 * - **Status**: one line that follows the link as it changes (connecting,
 *   connected and who is, offline and when it tries again, the page to
 *   reload, a browser that keeps no site data); the whole sentence is its
 *   title.
 * - **Connector address**: what to add in Claude (Customize › Connectors ›
 *   Add custom connector) or ChatGPT, with Copy.
 * - **A code**: typed when the page that asks is on another device; the
 *   relay says who asks, and the approval dialog asks the person.
 * - **The approval link's arrival** (`#cellucid_connect=…`, taken out of the
 *   address before any module ran: `bridge/connect-fragment.js`): claimed at
 *   once, the panel opened, the approval asked; a code that cannot be
 *   claimed (expired, claimed elsewhere) is said.
 * - **Manage…**: the connections with Remove, and Forget this browser.
 * - The open dataset's name goes to the relay as it changes (what
 *   `cellucid_status` tells an agent).
 *
 * The confirm cards and the activity line of agents at work are the
 * presence layer's (`app/agent/presence/`), on the dispatcher, for every
 * agent alike.
 *
 * @module app/agent/connect
 */

import { relayOriginForPage, startRelayClientForPage } from '../bridge/relay-client.js';
import { normalizeConnectCode } from '../bridge/connect-code.js';
import { readTabSecret } from '../bridge/tab-secret.js';
import { copyWithFeedback } from '../../ui/components/app-dialog.js';
import { buildShareUrl } from '../../ui/modules/share-dialog.js';
import { getCurrentHistory } from '../../history/current.js';
import { createApprovalDialog } from './approval-dialog.js';
import { createConnectionsDialog } from './connections-dialog.js';
import { describeConnectStatus } from './model.js';

/** How often the line counts down to the next try while offline. */
const COUNTDOWN_MS = 1000;

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {{
 *   section: HTMLDetailsElement,
 *   status: HTMLElement, address: HTMLInputElement, copy: HTMLButtonElement,
 *   codeForm: HTMLFormElement, code: HTMLInputElement, codeStatus: HTMLElement,
 *   manage: HTMLButtonElement,
 *   approval: object, connections: object,
 * }} dom
 * @param {{
 *   actions: object,
 *   dataSourceManager: object|null,
 *   notifications: {success: Function, error: Function, info: Function},
 *   startClient?: typeof startRelayClientForPage,
 *   permissionFor?: (question: {kind: string, connection: {id: string, kind: string}}) => ('ask'|'allow'|'deny'|null),
 *   pairedNow?: () => boolean,
 *   now?: () => number,
 * }} options - `permissionFor`: what the person's permission settings (the
 *   presence layer, `app/agent/presence/`) make of a kind of action
 *   (`change`, or a `confirm` kind) for a connection; the tool list each
 *   connection sees says so (null: the default)
 * @returns {{client: object|null, destroy: () => void}}
 */
export function initAgentConnect(dom, {
  actions, dataSourceManager, notifications,
  startClient = startRelayClientForPage,
  permissionFor = () => null,
  pairedNow = () => { try { return readTabSecret() !== null; } catch { return false; } },
  now = () => Date.now(),
}) {
  for (const key of ['section', 'status', 'address', 'copy', 'codeForm', 'code', 'codeStatus', 'manage', 'approval', 'connections']) {
    if (!dom?.[key]) throw new TypeError(`The Connect panel needs its ${key}.`);
  }
  const controller = new AbortController();
  const { signal } = controller;
  /** The connections as last read: null before reading, or when the relay could not be asked. */
  let connections = null;
  let countdown = null;
  let client = null;

  let address = null;
  try {
    // The relay answers MCP at its root: the connector address is its origin.
    address = relayOriginForPage();
  } catch (error) {
    // A local page told to use a relay that is not an exact origin.
    dom.status.textContent = 'The relay address of this page is wrong';
    dom.status.title = errorText(error);
    dom.status.dataset.tone = 'warning';
  }
  dom.address.value = address ?? '';
  dom.copy.disabled = address === null;
  dom.copy.addEventListener('click', () => void copyWithFeedback(dom.copy, dom.address.value), { signal });
  dom.address.addEventListener('focus', () => dom.address.select(), { signal });

  function render() {
    if (client === null) return;
    const status = client.status();
    const line = describeConnectStatus(status, { paired: pairedNow(), connections, now: now() });
    dom.status.textContent = line.text;
    dom.status.title = line.detail;
    if (line.tone === null) delete dom.status.dataset.tone;
    else dom.status.dataset.tone = line.tone;
    dom.manage.disabled = status.state === 'unavailable';
    const offline = status.state === 'retrying' && status.retryAt !== null;
    if (offline && countdown === null) countdown = setInterval(render, COUNTDOWN_MS);
    if (!offline && countdown !== null) {
      clearInterval(countdown);
      countdown = null;
    }
  }

  async function readConnections() {
    if (client === null || client.status().state !== 'connected') {
      connections = null;
      connectionsDialog.render(null, client?.status().state === 'connected' ? null : 'Not connected to the relay: the list is shown once it is back.');
      render();
      return;
    }
    try {
      connections = await client.connections();
      connectionsDialog.render(connections);
    } catch (error) {
      connections = null;
      connectionsDialog.render(null, `The list could not be read: ${errorText(error)}`);
    }
    render();
  }

  /** The code's one short line; `detail`, the whole sentence, is its title. */
  function sayCode(text, tone = null, detail = text) {
    dom.codeStatus.textContent = text;
    dom.codeStatus.title = detail;
    dom.codeStatus.hidden = text.length === 0;
    if (tone === null) delete dom.codeStatus.dataset.tone;
    else dom.codeStatus.dataset.tone = tone;
  }

  const approvalDialog = createApprovalDialog(dom.approval, {
    decide: (code, allow) => (allow ? client.approve(code) : client.deny(code)),
    decided: (approval, allow) => {
      if (allow) {
        notifications.success(`${approval.client.agent} is connected. Go back to ${approval.client.agent} to continue.`, { category: 'connectivity' });
      } else {
        notifications.info(`${approval.client.agent} was not connected.`, { category: 'connectivity' });
      }
      sayCode('');
    },
    failed: (approval, error) => {
      notifications.error(`The answer to ${approval.client.agent} did not reach the relay: ${errorText(error)}`, { category: 'connectivity' });
    },
  });

  const connectionsDialog = createConnectionsDialog(dom.connections, {
    remove: async grant => {
      await client.disconnect(grant);
      await readConnections();
    },
    forget: async () => {
      const { revokedAtRelay } = await client.forget();
      connections = null;
      connectionsDialog.render([]);
      render();
      notifications.info(revokedAtRelay
        ? 'This browser was forgotten: every agent connection made through it has ended.'
        : 'This browser was forgotten. The relay could not be reached, so its connections end the next time they are used.', { category: 'connectivity' });
    },
    now,
  });

  function ask(approval) {
    dom.section.open = true;
    approvalDialog.ask(approval);
  }

  /** Approvals the client dropped (their code expired) leave the dialog. */
  function followApprovals(status) {
    const waiting = new Set(status.approvals.map(approval => approval.code));
    for (const code of [...knownApprovals]) {
      if (!waiting.has(code)) {
        knownApprovals.delete(code);
        approvalDialog.expire(code);
      }
    }
  }
  const knownApprovals = new Set();

  try {
    client = startClient({
      actions,
      permissionFor,
      datasetName: () => dataSourceManager?.getCurrentMetadata?.()?.name ?? null,
      // What Share would give: a public link that opens this dataset in Cellucid, or none.
      datasetLink: () => buildShareUrl(dataSourceManager?.getCurrentSourceType?.() ?? null, globalThis.location?.href ?? ''),
      // The step the picture is after, as the State panel's timeline names it.
      currentStep: () => {
        const tree = getCurrentHistory()?.active ?? null;
        const step = tree?.steps.get(tree.headId) ?? null;
        return step === null ? null : { id: step.id, label: step.label };
      },
      onApproval: approval => {
        knownApprovals.add(approval.code);
        ask(approval);
      },
      onApprovalError: ({ display, error }) => {
        dom.section.open = true;
        notifications.error(`The connection with code ${display} cannot be approved: ${errorText(error)}`, { category: 'connectivity' });
      },
      onStatus: status => {
        followApprovals(status);
        if (status.state === 'connected' && connections === null) void readConnections();
        if (status.state !== 'connected') connections = null;
        render();
      },
      onConnectionsChanged: () => void readConnections(),
    });
  } catch (error) {
    client = null;
    dom.status.textContent = 'Agents cannot connect on this page';
    dom.status.title = errorText(error);
    dom.status.dataset.tone = 'warning';
  }
  render();

  dom.codeForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (client === null) return;
    const code = normalizeConnectCode(dom.code.value);
    if (code === null) {
      sayCode('Codes look like ABCD-EFGH', 'warning', 'A connect code has eight letters and digits, like ABCD-EFGH.');
      return;
    }
    sayCode('Asking who it is…');
    try {
      await client.claim(code, { via: 'typed' });
      dom.code.value = '';
      sayCode('');
    } catch (error) {
      // One short line here; the relay's whole answer in a notification.
      sayCode('Code not accepted', 'warning', errorText(error));
      notifications.error(`The code ${dom.code.value} was not accepted: ${errorText(error)}`, { category: 'connectivity' });
    }
  }, { signal });
  dom.code.addEventListener('input', () => sayCode(''), { signal });

  dom.manage.addEventListener('click', () => {
    connectionsDialog.open(dom.manage);
    void readConnections();
  }, { signal });

  // The relay tells agents which dataset this tab shows.
  const reportDataset = () => client?.reportState();
  if (typeof dataSourceManager?.onDatasetChange === 'function') dataSourceManager.onDatasetChange(reportDataset);

  return {
    client,
    destroy() {
      controller.abort();
      if (countdown !== null) clearInterval(countdown);
      if (typeof dataSourceManager?.offDatasetChange === 'function') dataSourceManager.offDatasetChange(reportDataset);
      approvalDialog.destroy();
      connectionsDialog.destroy();
      client?.destroy();
    },
  };
}
