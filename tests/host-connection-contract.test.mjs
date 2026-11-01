/**
 * "Every host failing at once": unrelated sites all losing requests within
 * one maximum retransmission timeout, with no host answering meanwhile, is
 * said as this computer's connection, never as one host's outage
 * (`hosts.js` `connectionDown`, `HOST_FAULTS` `connection`). Its own process:
 * an answer still on its way from another test's host would be a host
 * answering, as it would be in the browser.
 */

import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHostBook } from '../assets/js/formats/io/hosts.js';
import { describeOpeningFailure } from '../assets/js/app/ui/modules/dataset-connections.js';
import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { LinkDataSource } from '../assets/js/data/link-source.js';

function silenceNotifications(t) {
  const notifications = getNotificationCenter();
  const original = { loading: notifications.loading, complete: notifications.complete, fail: notifications.fail };
  notifications.loading = () => 'host-connection-test';
  notifications.complete = () => {};
  notifications.fail = () => {};
  const { log, warn, error } = console;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  t.after(() => {
    Object.assign(notifications, original);
    Object.assign(console, { log, warn, error });
  });
}

test('unrelated hosts all silent at once is said as this computer\'s connection, never as one host', () => {
  let at = 1_000;
  const hosts = createHostBook({ now: () => at });
  const ask = url => hosts.admit(url);
  // Each host answered this site before: a later silence is not CORS or a mistyped name.
  for (const url of ['https://zenodo.org/', 'https://s3.us-west-2.amazonaws.com/', 'https://cellxgene-census-public-us-west-2.s3.amazonaws.com/',
    'https://figshare.com/', 'https://ncbi.nlm.nih.gov/', 'https://dropbox.com/']) {
    hosts.delivered(url);
  }
  // One host losing a request is that host: its outage, or its block.
  ask('https://zenodo.org/api/records/7')(null, { lost: true });
  assert.equal(hosts.connectionDown('https://zenodo.org/api/records/7'), false);
  // Another address of the same operator is the same site, never a second witness.
  at += 1_000;
  ask('https://s3.us-west-2.amazonaws.com/a')(null, { lost: true });
  ask('https://cellxgene-census-public-us-west-2.s3.amazonaws.com/b')(null, { lost: true });
  assert.equal(hosts.connectionDown('https://s3.us-west-2.amazonaws.com/a'), true,
    'zenodo.org and amazonaws.com both lost requests within a minute, and nothing answered');
  assert.equal(hosts.connectionDown('https://huggingface.co/x'), true, 'a host asked next is behind the same connection');
  // Any host answering since shows the connection works: each silent host is its own.
  at += 1_000;
  ask('https://huggingface.co/x')(new Response('ok'));
  assert.equal(hosts.connectionDown('https://zenodo.org/api/records/7'), false);
  // Losses further apart than RFC 6298's longest retransmission timeout (60 s) are not one event.
  at += 1_000;
  ask('https://figshare.com/a')(null, { lost: true });
  at += 61_000;
  ask('https://ncbi.nlm.nih.gov/geo/x')(null, { lost: true });
  assert.equal(hosts.connectionDown('https://ncbi.nlm.nih.gov/geo/x'), false);
  at += 2_000;
  ask('https://dropbox.com/s/a')(null, { lost: true });
  assert.equal(hosts.connectionDown('https://dropbox.com/s/a'), true);
  // A failing host answers: its 500 is the host's, and it ends a suspicion it took part in.
  ask('https://ncbi.nlm.nih.gov/geo/x')(new Response('', { status: 500 }));
  assert.equal(hosts.connectionDown('https://dropbox.com/s/a'), false);
  // Hosts that never answered this site are no witnesses (CORS, a mistyped name).
  at += 120_000;
  ask('https://never-answered.example/a')(null, { lost: true });
  ask('https://typo-host.invalid/a')(null, { lost: true });
  assert.equal(hosts.connectionDown('https://typo-host.invalid/a'), false);
});

test('a link whose provider host gives no answer while other sites that answered are silent too says this side\'s connection', async t => {
  silenceNotifications(t);
  const realFetch = globalThis.fetch;
  // Both hosts answer once (a 404: they are reachable and let this site read them) ...
  globalThis.fetch = async () => new Response('', { status: 404 });
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const source = new LinkDataSource();
  await assert.rejects(source.connect('figshare:22577536'));
  await assert.rejects(source.connect('hf:user/repo'));
  // ... then the connection drops.
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  // The first silent site is said as that provider's.
  await assert.rejects(source.connect('figshare:22577536'), error => {
    assert.match(error.message, /^Figshare \(api\.figshare\.com\) is not answering this site: no answer arrived\./);
    return true;
  });
  // A second, unrelated one within the minute, with nothing answering: this side.
  await assert.rejects(source.connect('hf:user/repo'), error => {
    assert.match(error.message, /^Hugging Face \(huggingface\.co\) gave no answer for it, and neither did the other hosts asked in the last minute: most likely this computer's connection/);
    assert.equal(error.details.hostFault.kind, 'connection');
    assert.equal(describeOpeningFailure('x.', error, { withoutLink: true }).settled, false);
    return true;
  });
});
