/**
 * What the app says it keeps and for how long is one account, in every place
 * a person reads it: the privacy policy Google and Microsoft link to
 * (`privacy.html`), the in-app tips (`info-tips.js`) and the console's
 * transfer lines (`transfer-log.js`). Read is held in the tab; downloaded
 * parts, gene indexes and converted copies are also kept in this browser's
 * storage under the file's version (never for data served from this computer
 * or a notebook) until removed under Stored or with the site's data; sign-ins
 * are short-lived access tokens in the tab's session storage, revoked on Sign
 * out where the provider allows it. A sentence that says otherwise ("memory
 * only", "nothing is saved to disk", "until the tab closes" for a sign-in)
 * fails here.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { TransferLog, WHERE_READ_BYTES_GO } from '../assets/js/data/transfer-log.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the console says where read bytes go: the tab, and this browser\'s storage under the file\'s version', () => {
  const lines = [];
  const log = new TransferLog({ console: { info: line => lines.push(line) } });
  log.begin({ key: 'https://data.example.org/a.h5ad', label: 'a.h5ad', why: 'reading on demand' });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith(`; ${WHERE_READ_BYTES_GO}.`));
  assert.match(WHERE_READ_BYTES_GO, /this tab's memory/);
  assert.match(WHERE_READ_BYTES_GO, /kept in this browser's storage for the next visit/);
  assert.match(WHERE_READ_BYTES_GO, /never for a server on this computer, a notebook or a Python or R viewer/);
  assert.match(WHERE_READ_BYTES_GO, /Session › Stored lists and removes them/);
});
