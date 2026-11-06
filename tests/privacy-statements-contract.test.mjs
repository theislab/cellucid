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

/** Sentences the code contradicts, wherever they appear. */
const STALE = [
  /memory only/i,
  /nothing is saved to disk/i,
  /never saved to disk/i,
  /stays in (this tab's|your browser's) memory/i,
  /nothing Cellucid reads is stored/i,
  /released when the dataset closes/i,
  /in this tab only, until it is closed/i,
  /renews itself for 24 hours/i,
  /token is kept only for this tab/i,
  /draft of the highlights/i,
];

test('the privacy policy, the tips and the console never say what is read stays in memory only', async () => {
  for (const path of ['privacy.html', 'assets/js/app/ui/components/info-tips.js', 'assets/js/data/transfer-log.js']) {
    const text = await read(path);
    for (const stale of STALE) assert.doesNotMatch(text, stale, `${path}: ${stale}`);
  }
});

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

test('the privacy policy names everything kept, where, and how to remove it', async () => {
  const page = await read('privacy.html');
  for (const kept of [
    /the parts of a remote file it downloaded/,
    /the gene index it builds for a matrix stored cell by cell/,
    /the converted copy of a file it has to read whole/,
    /under the file's version, only when the source names one/,
    /none of a file's parts are kept when it is served from your own computer or a notebook/,
    /the history of what you do with each dataset, step by step as you work/,
    /the list of datasets you opened \(My datasets: each one's name, size and where it opens from, a link without any key or token it carried to grant access, never a file's path or content\)/,
    /how fast each data host answered/,
    /the browser's reference to each file or folder you opened from your computer/,
    /Session › Open data › Stored › Manage…/,
    /clearing this site's data/,
    /a private window keeps none of it/,
  ]) {
    assert.match(page, kept);
  }
});

test('the tips say what is kept of a dataset and how long each sign-in lasts', async () => {
  const source = await read('assets/js/app/ui/components/info-tips.js');
  assert.match(source, /For the next visit, this browser keeps the downloaded parts, the gene index and any converted copy, but only when the source names the file\\'s version, and never for data served from this computer or a notebook\./);
  assert.match(source, /Your GitHub sign-in is kept for this tab and expires after 8 hours; Sign out revokes it\./);
  assert.match(source, /about an hour; one click renews it/);
  assert.match(source, /Microsoft cannot revoke it: Sign out forgets it/);
});
