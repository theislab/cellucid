/**
 * A link's access key never goes anywhere but the page address
 * (`data/sources/link-credentials.js`): the read target (the link as pasted,
 * with any signature, token or share key) is held in memory and given to the
 * byte layer; every other place is given its public form (an allow-list of
 * parameters that only name a file), and what a link *is* (its identity)
 * holds no credential either.
 *
 * Covered here: the two forms and the identity over every credential scheme;
 * every provider whose values can carry a key
 * (web addresses, Dropbox, Google Drive); and the sinks: the connection's
 * locator (sessions, the connection list), the page address, Share links,
 * badges and the subsample link, the debug snapshot's address, the opening
 * progress, and every read and opening failure (message, details, console).
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { captureDatasetSourceRecord } from '../assets/js/app/session/dataset-source-record.js';
import { dataLinkLeavesOutAccess, readDataSourceUrlParameters } from '../assets/js/app/url-state.js';
import { buildShareUrl } from '../assets/js/app/ui/modules/share-dialog.js';
import { DataSourceError } from '../assets/js/data/data-source.js';
import { LinkDataSource } from '../assets/js/data/link-source.js';
import { OpeningProgress, openingCancelledError } from '../assets/js/data/opening-progress.js';
import { TransferLog } from '../assets/js/data/transfer-log.js';
import { linkIdentity, publicLink } from '../assets/js/data/sources/link-credentials.js';
import { linkLeavesOutParts, textWithPublicLinks } from '../assets/js/data/sources/link-text.js';
import { getProviderRegistry, publicPageAddress } from '../assets/js/data/sources/registry.js';
import { BYTE_SOURCE_FAILURES, ByteSourceError } from '../assets/js/formats/io/byte-source.js';
import { serveFixtureHost } from './helpers/fixture-web-host.mjs';

const FIXTURES = new URL('./fixtures/cellucid-ready/', import.meta.url);
const WEB = 'https://data.example.org/anndata/';

/** One link per credential scheme a deny-list would let through. */
const SIGNED = Object.freeze({
  'AWS SigV4': 'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIASECRET&X-Amz-Signature=SECRET&X-Amz-Expires=60',
  'AWS SigV2': 'AWSAccessKeyId=AKIASECRET&Signature=SECRET&Expires=1700000000',
  'GCS V2': 'GoogleAccessId=svc%40SECRET.iam.gserviceaccount.com&Signature=SECRET&Expires=1700000000',
  'GCS V4': 'X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=SECRET&X-Goog-Signature=SECRET',
  'Azure SAS': 'sv=2024-01-01&se=2030-01-01&sp=r&sr=b&si=SECRETPOLICY&sig=SECRET',
  'Google API key': 'key=AIzaSECRET',
  'Dropbox share key': 'rlkey=SECRET',
  'OSF view-only': 'view_only=SECRET',
  password: 'password=SECRET',
  'client secret': 'client_secret=SECRET',
  JWT: 'jwt=eyJSECRET',
  'access and secret keys': 'access_key=SECRET&secret_key=SECRET',
  'bearer token': 'access_token=ya29.SECRET&token=SECRET',
  CloudFront: 'Policy=SECRET&Signature=SECRET&Key-Pair-Id=SECRET',
});

function silence(t) {
  const notifications = getNotificationCenter();
  const original = { loading: notifications.loading, complete: notifications.complete, fail: notifications.fail };
  notifications.loading = () => 'link-public-form-test';
  notifications.complete = () => {};
  notifications.fail = () => {};
  const logged = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const level of Object.keys(saved)) {
    console[level] = (...args) => logged.push(args.map(arg => (arg instanceof Error ? `${arg.message} ${JSON.stringify(arg.details ?? {})}` : String(arg))).join(' '));
  }
  t.after(() => {
    Object.assign(notifications, original);
    Object.assign(console, saved);
  });
  return logged;
}

function assertNoSecret(text, label) {
  assert.doesNotMatch(String(text), /SECRET|AKIA|eyJ/, label);
}

test('the public form keeps only the allow-listed parameters, and drops a user, a password and the fragment', () => {
  for (const [scheme, query] of Object.entries(SIGNED)) {
    const href = `https://bucket.example.org/data/atlas.h5ad?${query}&versionId=7`;
    const shown = publicLink(href);
    assertNoSecret(shown, scheme);
    assert.equal(shown, 'https://bucket.example.org/data/atlas.h5ad?versionId=7', scheme);
  }
  assert.equal(publicLink('https://user:SECRET@lab.example/a.h5ad#access_token=SECRET'), 'https://lab.example/a.h5ad');
  assert.equal(
    publicLink('https://storage.googleapis.com/storage/v1/b/bk/o/a.h5ad?alt=media&generation=12&uuid=x'),
    'https://storage.googleapis.com/storage/v1/b/bk/o/a.h5ad?alt=media&generation=12',
    'naming parameters stay; an unknown one does not'
  );
  assert.equal(publicLink('not a link'), 'not a link');
});

test('a link\'s identity holds no credential, is the same however it is signed, and tells apart what only an unknown parameter tells apart', () => {
  for (const [scheme, query] of Object.entries(SIGNED)) {
    const once = linkIdentity(`https://bucket.example.org/a.h5ad?${query}`);
    const again = linkIdentity(`https://bucket.example.org/a.h5ad?${query.replaceAll('SECRET', 'OTHERKEY')}`);
    assertNoSecret(once, scheme);
    assert.equal(once, again, `${scheme}: signed again, the same file`);
    assert.equal(once, 'https://bucket.example.org/a.h5ad', `${scheme}: a known credential is not even hashed`);
  }
  const a = linkIdentity('https://lab.example/download?uuid=a&token=SECRET');
  const b = linkIdentity('https://lab.example/download?uuid=b&token=OTHER');
  assert.notEqual(a, b, 'two files told apart by an unknown parameter stay two datasets');
  assert.match(a, /^https:\/\/lab\.example\/download#[0-9a-f]{16}$/);
  assert.doesNotMatch(a, /uuid/, 'the parameter itself is not kept');
  assert.equal(
    linkIdentity('https://lab.example/download?b=2&a=1'),
    linkIdentity('https://lab.example/download?a=1&b=2'),
    'in any order'
  );
});

test('text names every link by its public form; a documentation anchor stays', () => {
  assert.equal(
    textWithPublicLinks('https://b.example/a.h5ad?X-Amz-Signature=SECRET&versionId=3: the host answered HTTP 403.'),
    'https://b.example/a.h5ad?versionId=3: the host answered HTTP 403.'
  );
  assert.equal(
    textWithPublicLinks('See https://docs.cellucid.com/en/latest/x.html#private-files.'),
    'See https://docs.cellucid.com/en/latest/x.html#private-files.'
  );
  assert.equal(textWithPublicLinks('(https://u:SECRET@h.example/a?token=SECRET#access_token=SECRET)'), '(https://h.example/a)');
});

test('a link that loses nothing is said as it was written, and only what is left out counts as left out', () => {
  // Its parsed spelling would add a slash to a server's address and lower
  // the case of a host: a message names the address the person typed.
  for (const written of [
    'http://127.0.0.1:4174',
    'http://localhost:8765/datasets',
    'https://Lab.Example.org/Atlas.h5ad?versionId=3',
    'https://docs.cellucid.com/en/latest/x.html#private-files',
  ]) {
    assert.equal(textWithPublicLinks(`${written} answers, but it is not a Cellucid server.`), `${written} answers, but it is not a Cellucid server.`);
    assert.equal(linkLeavesOutParts(written), written.includes('#'), written);
  }
  assert.equal(linkLeavesOutParts('https://h.example/a?token=SECRET'), true);
  assert.equal(linkLeavesOutParts('https://u:p@h.example/a'), true);
  assert.equal(linkLeavesOutParts('not a link'), false);
});

test('every provider whose values can carry a key resolves to a read target and a public locator', () => {
  const registry = getProviderRegistry();
  for (const [input, read, shown] of [
    [`https://bucket.s3.amazonaws.com/a.h5ad?${SIGNED['AWS SigV4']}`, null, 'https://bucket.s3.amazonaws.com/a.h5ad'],
    ['https://www.dropbox.com/scl/fi/abc/atlas.h5ad?rlkey=SECRET&st=SECRET&dl=0', 'dropbox:https://www.dropbox.com/scl/fi/abc/atlas.h5ad?rlkey=SECRET&st=SECRET', 'dropbox:https://www.dropbox.com/scl/fi/abc/atlas.h5ad'],
    ['https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view?resourcekey=SECRETKEY', 'gdrive:1AbCdEfGhIjKlMn~SECRETKEY', 'gdrive:1AbCdEfGhIjKlMn'],
    ['gdrive:1AbCdEfGhIjKlMn~SECRETKEY', 'gdrive:1AbCdEfGhIjKlMn~SECRETKEY', 'gdrive:1AbCdEfGhIjKlMn'],
  ]) {
    const resolved = registry.resolve(input);
    if (read !== null) assert.equal(resolved.locator, read, input);
    assert.match(resolved.locator, /SECRET/, 'the read target keeps what the read needs');
    assert.equal(resolved.publicLocator, shown, input);
    assert.equal(registry.publicFormOf(input), shown);
  }
  // A provider whose values carry nothing has one form.
  const hf = registry.resolve('hf:user/repo');
  assert.equal(hf.publicLocator, hf.locator);
  // A storage URI is read at its HTTPS address, shown without its signature.
  const s3 = registry.resolve('s3://bucket/a.h5ad?X-Amz-Signature=SECRET');
  assert.equal(s3.locator, 'https://bucket.s3.amazonaws.com/a.h5ad?X-Amz-Signature=SECRET');
  assert.equal(s3.publicLocator, 'https://bucket.s3.amazonaws.com/a.h5ad');
  // Unrecognized text is shown without whatever looks like a credential.
  assert.equal(registry.publicFormOf('ftp://bucket/a.h5ad?X-Amz-Signature=SECRET'), 'ftp://bucket/a.h5ad');
  assert.throws(() => registry.resolve('ftp://bucket/a.h5ad?X-Amz-Signature=SECRET'), error => {
    assertNoSecret(error.message, 'refusal message');
    assertNoSecret(JSON.stringify(error.details), 'refusal details');
    return true;
  });
});

test('an opened link gives its public form to the connection, sessions and Share; the page address alone keeps the key', async t => {
  silence(t);
  serveFixtureHost(t, { prefix: WEB, root: FIXTURES });
  const signed = `${WEB}ready.h5ad?${SIGNED['AWS SigV4']}&versionId=2`;
  const source = new LinkDataSource();
  t.after(() => source.disconnect());
  const connection = await source.connect(signed);
  const shown = `${WEB}ready.h5ad?versionId=2`;
  assert.equal(connection.locator, shown);
  assert.equal(source.getConnectionInfo().locator, shown);
  assert.equal(source.getConnectionInfo().inputPath, shown);
  assert.equal(source.getAddressLocator(), signed, 'the page address reads the same file after a reload');
  for (const dataset of connection.datasets) assertNoSecret(JSON.stringify(dataset), 'dataset');
  assertNoSecret(JSON.stringify(source.getAttribution()), 'attribution (figure provenance)');

  // A session records the public form.
  const record = captureDatasetSourceRecord({
    getCurrentSourceType: () => 'link',
    getCurrentDatasetId: () => 'tiny-ready',
    activeSource: source,
  });
  assert.deepEqual(record, { kind: 'link', locator: shown, dataset: 'tiny-ready' });

  // Share, the badge, the embed and the subsample link take the address's
  // data parameters in public form, and the dialog says something was left out.
  const page = `https://www.cellucid.com/?data=${encodeURIComponent(signed)}&cells=100&seed=1`;
  const shared = readDataSourceUrlParameters(page);
  assert.equal(shared.get('data'), shown);
  assert.equal(shared.get('cells'), '100');
  const shareUrl = buildShareUrl('link', page);
  assertNoSecret(decodeURIComponent(shareUrl), 'share link');
  assert.equal(dataLinkLeavesOutAccess(page), true);
  assert.equal(dataLinkLeavesOutAccess(`https://www.cellucid.com/?data=${encodeURIComponent(shown)}`), false);
  assert.equal(dataLinkLeavesOutAccess('https://www.cellucid.com/?data=hf%3Auser%2Frepo'), false);
  const dropbox = 'https://www.cellucid.com/?data=' + encodeURIComponent('dropbox:https://www.dropbox.com/scl/fi/abc/a.h5ad?rlkey=SECRET');
  assertNoSecret(decodeURIComponent(buildShareUrl('link', dropbox)), 'Dropbox share link');
  assert.equal(dataLinkLeavesOutAccess(dropbox), true);

  // The debug snapshot reports where the page is with the public form.
  assert.equal(publicPageAddress(page), `https://www.cellucid.com/?data=${encodeURIComponent(shown)}&cells=100&seed=1`.replace(/%2F/g, '%2F'));
  assertNoSecret(decodeURIComponent(publicPageAddress(page)), 'debug snapshot address');
});

test('a link that fails to open is named by its public form in the failure, its details and the console', async t => {
  const logged = silence(t);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const answer of [
    () => new Response('denied', { status: 403 }),
    () => { throw new TypeError('Failed to fetch'); },
  ]) {
    globalThis.fetch = async () => answer();
    const source = new LinkDataSource();
    const signed = `https://bucket.example.org/private/atlas.h5ad?${SIGNED['AWS SigV2']}`;
    await assert.rejects(source.connect(signed), error => {
      assertNoSecret(error.message, 'message');
      assertNoSecret(JSON.stringify(error.details ?? {}), 'details');
      assertNoSecret(String(error.cause?.message ?? ''), 'cause');
      assert.match(error.message, /atlas\.h5ad/, 'still names the file');
      return true;
    });
    source.disconnect();
  }
  for (const line of logged) assertNoSecret(line, 'console');
});

test('every read and opening failure names a link by its public form, whichever site raised it', () => {
  const signed = `https://bucket.example.org/a.h5ad?${SIGNED['GCS V4']}`;
  for (const code of Object.values(BYTE_SOURCE_FAILURES)) {
    const error = new ByteSourceError(code, `${signed}: failed (${code}).`, { url: signed, status: 403, phase: 'answer' });
    assertNoSecret(error.message, code);
    assertNoSecret(error.details.url, `${code} details.url`);
    assert.equal(error.status, 403);
    assert.equal(error.details.phase, 'answer', 'other details are kept');
  }
  const opening = new DataSourceError(`Failed to open ${signed}: no`, 'NETWORK_ERROR', 'link', { input: signed, url: signed });
  assertNoSecret(opening.message, 'DataSourceError message');
  assertNoSecret(JSON.stringify(opening.details), 'DataSourceError details');
});

test('the opening progress names a link by its public form, and so does its cancellation', () => {
  const log = { subscribe: () => () => {}, record() {} };
  const progress = new OpeningProgress({ log, transfers: new TransferLog({ console: null }) });
  const seen = [];
  progress.subscribe(snapshot => seen.push(snapshot));
  const signed = `https://bucket.example.org/a.h5ad?${SIGNED['Azure SAS']}`;
  const opening = progress.begin({ title: signed, step: `Reading ${signed}` });
  opening.step(`Still reading ${signed}`);
  opening.rename(`${signed} (renamed)`);
  for (const snapshot of seen) assertNoSecret(JSON.stringify(snapshot), 'opening snapshot');
  assertNoSecret(openingCancelledError(signed).message, 'cancellation');
  opening.end();
});
