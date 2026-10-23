/**
 * The Transfers panel: one row per entry of the Transfers log
 * (`data/transfer-log.js`), saying what linked data is read, from where, why,
 * how much has come in, and where the bytes go. It is hidden until a link is
 * opened and only displays; the log owns the facts.
 *
 * @module app/ui/modules/transfers-panel
 */

import {
  TRANSFER_DESTINATIONS,
  formatTransferBytes,
  getTransferLog,
} from '../../../data/transfer-log.js';

const STATUS_WORDS = Object.freeze({
  active: 'reading in place',
  closed: 'closed',
  failed: 'failed',
});

function line(documentOwner, className, text) {
  const element = documentOwner.createElement('div');
  element.className = className;
  element.textContent = text;
  return element;
}

function describeAmount(entry) {
  const received = formatTransferBytes(entry.bytes);
  const of = entry.total === null ? '' : ` of a ${formatTransferBytes(entry.total)} file`;
  const requests = `${entry.requests} request${entry.requests === 1 ? '' : 's'}`;
  return `${received} read${of}, in ${requests}`;
}

/**
 * @param {{container: HTMLElement, list: HTMLElement,
 *   log?: import('../../../data/transfer-log.js').TransferLog}} options
 * @returns {() => void} Stop updating the panel
 */
export function initTransfersPanel({ container, list, log = getTransferLog() }) {
  const documentOwner = list.ownerDocument;
  const view = documentOwner.defaultView;
  let scheduled = false;
  let latest = log.entries();

  function render() {
    scheduled = false;
    container.hidden = latest.length === 0;
    list.replaceChildren(...latest.map(entry => {
      const row = documentOwner.createElement('li');
      row.className = 'transfer-row';
      row.dataset.status = entry.status;
      row.append(
        line(documentOwner, 'transfer-label', `${entry.label} · ${STATUS_WORDS[entry.status]}`),
        line(documentOwner, 'transfer-meta', `From ${entry.from}`),
        line(documentOwner, 'transfer-meta', describeAmount(entry)),
        line(documentOwner, 'transfer-meta', `Why: ${entry.why}`),
        line(documentOwner, 'transfer-meta', `Kept in ${TRANSFER_DESTINATIONS[entry.destination]}`),
      );
      if (entry.detail !== null) {
        row.append(line(documentOwner, 'transfer-meta transfer-error', entry.detail));
      }
      return row;
    }));
  }

  render();
  // Reads arrive many times a second; the panel is redrawn once per frame.
  return log.subscribe(entries => {
    latest = entries;
    if (scheduled) return;
    scheduled = true;
    if (typeof view?.requestAnimationFrame === 'function') view.requestAnimationFrame(render);
    else render();
  });
}
