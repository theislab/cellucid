/**
 * A request asked again after a transient failure says so on whatever
 * progress line owns it: a community annotation Pull against repeated 502s
 * must not read "Checking the repository… 5%" while the shared transport
 * retries in silence. Every retrying transport repeats through
 * `withRetries`, which tells each repeat in one sentence
 * (`hostRetrySentence`) through the request's `onWait` (or the link it runs
 * on, `clock.onWait`), and takes it back once the request settles.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { hostRetrySentence, withRetries, ByteSourceError, BYTE_SOURCE_FAILURES } from '../assets/js/formats/io/byte-source.js';
import { ResponseClock } from '../assets/js/formats/io/link.js';
import { requestWorker } from '../assets/js/app/community-annotations/worker-request.js';
import { virtualTransport } from './helpers/community-annotation-worker.mjs';

test('the retry sentence names the host, what it answered and when it is asked again', () => {
  assert.equal(
    hostRetrySentence({ host: 'api.example.org', status: 502, service: 'GitHub', waitMs: 2000, attempt: 2 }),
    'GitHub (api.example.org) is answering with errors (HTTP 502, a gateway error); trying again in 2.0 s (attempt 2)…',
  );
  assert.equal(
    hostRetrySentence({ host: 'files.example.org', stalled: true, attempt: 3 }),
    'files.example.org stopped sending; trying again (attempt 3)…',
  );
  assert.equal(
    hostRetrySentence({ host: null, waitMs: 400, attempt: 2 }),
    'The host did not answer; trying again (attempt 2)…',
  );
});

test('a community annotation request against repeated 502s says GitHub is answering with errors, then takes it back', async () => {
  let asked = 0;
  const { time, transport } = virtualTransport(async () => {
    asked += 1;
    if (asked <= 2) return new Response('Bad gateway', { status: 502, headers: { 'Content-Type': 'text/plain' } });
    return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const said = [];
  const answer = await time.run(requestWorker(transport, 'https://annotations.example.org/repos', { method: 'GET' }, {
    label: 'Checking the repository',
    origin: 'https://annotations.example.org',
    onWait: wait => said.push(wait === null ? null : wait.text),
  }));
  assert.equal(answer.response.status, 200);
  assert.equal(asked, 3);
  const lines = said.filter(line => line !== null);
  assert.equal(lines.length, 2, `each repeat is said (${JSON.stringify(said)})`);
  assert.match(lines[0], /^GitHub is answering with errors \(HTTP 502, a gateway error\); trying again.* \(attempt 2\)…$/);
  assert.match(lines[1], /\(attempt 3\)…$/);
  assert.equal(said.at(-1), null, 'the line is given back once the request is answered');
});

test('a request with no onWait of its own tells the link it runs on', async () => {
  const clock = new ResponseClock({ after: (ms, callback) => { const id = setTimeout(callback, 0); return () => clearTimeout(id); } });
  const heard = [];
  clock.onWait = wait => heard.push(wait === null ? null : wait.text);
  let n = 0;
  const value = await withRetries(async () => {
    n += 1;
    if (n === 1) throw new ByteSourceError(BYTE_SOURCE_FAILURES.UNAVAILABLE, 'busy', { host: 'data.example.org', status: 503 });
    return 'read';
  }, { clock, random: () => 0, delivered: () => true });
  assert.equal(value, 'read');
  assert.equal(heard.length, 2);
  assert.match(heard[0], /^data\.example\.org is answering with errors \(HTTP 503, service unavailable\); trying again/);
  assert.equal(heard[1], null);
});
