// The community-annotation Worker runs on the Workers Free plan: 10 ms of CPU
// per request (https://developers.cloudflare.com/workers/platform/limits/).
// A JavaScript loop over every character of a 1 MB body costs about that by
// itself (a 1 MB publish that scans its body in JavaScript is refused by
// Cloudflare; measured: 38_decisions_testing_and_hosted_runners.md). So the Worker parses JSON natively,
// checks base64 natively, and relays large reads without parsing them.
//
// That is what is held here, by counting, never by a clock on a shared runner
// (a shared runner's CPU time for one parse is more than twice a laptop's):
//
// - the blocks of JavaScript the Worker runs (`helpers/block-counts.mjs`) do
//   not grow with the body: a thousand times the bytes adds a few per chunk of
//   the stream, where a scan per character adds a million;
// - the passes of native code over the body: what its bytes went through
//   (`JSON.parse`, `atob`, a regular expression, a text codec), in bodies.

import { blocksRun } from './helpers/block-counts.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import { withMockedFetch } from './helpers/worker-fetch.mjs';

const WORKER_FILE = 'community-annotations/_worker-code.js';
const { default: worker } = await import('../assets/js/app/community-annotations/_worker-code.js');

const ENV = Object.freeze({
  ALLOWED_ORIGINS: 'https://app.example',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});
const OPERATION_ID = '018f5e3a-7b9c-4d2e-8f10-123456789abc';

/** Every native function here that walks a string or bytes it is given. */
const NATIVE_PASSES = Object.freeze([
  [JSON, 'parse', args => args[0]],
  [JSON, 'stringify', (_, result) => result],
  [globalThis, 'atob', args => args[0]],
  [globalThis, 'btoa', args => args[0]],
  [RegExp.prototype, 'test', args => args[0]],
  [RegExp.prototype, 'exec', args => args[0]],
  [String.prototype, 'replace', (_, result, self) => self],
  [String.prototype, 'replaceAll', (_, result, self) => self],
  [String.prototype, 'split', (_, result, self) => self],
  [String.prototype, 'indexOf', (_, result, self) => self],
  [TextDecoder.prototype, 'decode', args => args[0]],
  [TextEncoder.prototype, 'encode', args => args[0]],
]);

function lengthOf(value) {
  if (typeof value === 'string') return value.length;
  return Number.isSafeInteger(value?.byteLength) ? value.byteLength : 0;
}

/**
 * Run `work` and sum the lengths the native functions above were given, for
 * inputs of at least `least` long: what it costs to pass over a large body.
 */
async function nativeBytes(least, work) {
  let bytes = 0;
  const restore = NATIVE_PASSES.map(([owner, name, inputOf]) => {
    const original = owner[name];
    owner[name] = function counted(...args) {
      const result = original.apply(this, args);
      const length = lengthOf(inputOf(args, result, this));
      if (length >= least) bytes += length;
      return result;
    };
    return () => { owner[name] = original; };
  });
  try {
    await work();
  } finally {
    for (const put of restore) put();
  }
  return bytes;
}

/** A realistic annotation file: many small suggestion records. */
function annotationFile(bytes) {
  const suggestions = [];
  for (let index = 0; JSON.stringify(suggestions).length < bytes; index += 500) {
    for (let step = 0; step < 500; step += 1) {
      suggestions.push({
        id: `ghid_1_${index + step}`,
        label: `T cell subtype ${index + step}`,
        ontologyId: 'CL:0000084',
        evidence: 'CD3D CD3E high',
        proposedAt: '2026-01-01T00:00:00Z',
      });
    }
  }
  return JSON.stringify({ version: 3, datasets: { d: { suggestions } } }).slice(0, bytes);
}

function publishBody(bytes) {
  return JSON.stringify({
    message: 'Update annotations',
    content: btoa(annotationFile(bytes)),
    branch: 'main',
    sha: 'a'.repeat(40),
  });
}

const publishAnswer = async url => (
  String(url) === 'https://api.github.com/user'
    ? new Response('{"id":1,"login":"owner"}', { status: 200 })
    : new Response(JSON.stringify({ content: { sha: 'b'.repeat(40) } }), { status: 200 })
);

async function publish(body) {
  const response = await worker.fetch(new Request(
    'https://worker.example/api/repos/o/r/contents/annotations/users/ghid_1.json',
    {
      method: 'PUT',
      body,
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
        'X-Cellucid-Operation-Id': OPERATION_ID,
      },
    }
  ), ENV);
  assert.equal(response.status, 200);
  await response.text();
}

test('a 1,000,000-byte publish costs a few native parses of its body, not a scan per character', async t => {
  const small = publishBody(1000);
  const large = publishBody(1_000_000);
  await withMockedFetch(publishAnswer, async () => {
    const smallBlocks = await blocksRun(WORKER_FILE, () => publish(small));
    const largeBlocks = await blocksRun(WORKER_FILE, () => publish(large));
    const grown = largeBlocks - smallBlocks;
    t.diagnostic(`publish: ${smallBlocks} blocks of the Worker for ${small.length} bytes, ${largeBlocks} for ${large.length}`);
    // Stream chunks are the only thing that may add blocks: a scan per character adds over a million.
    assert.ok(grown <= large.length / 1000, `a thousand times the bytes ran ${grown} more blocks of the Worker`);

    const passed = await nativeBytes(large.length / 2, () => publish(large));
    const passes = passed / large.length;
    t.diagnostic(`publish: ${passes.toFixed(2)} native passes over the body`);
    assert.ok(passes > 0, 'the body is read');
    assert.ok(passes <= 8, `${passes.toFixed(2)} native passes over the body`);
  });
});

/** A GraphQL answer of about `blobs` × 8 KB. */
function graphqlAnswer(blobs) {
  return new TextEncoder().encode(JSON.stringify({
    data: {
      repository: Object.fromEntries(Array.from({ length: blobs }, (_, index) => [
        `b${index}`,
        { oid: index.toString(16).padStart(40, '0'), byteSize: 8000, isBinary: false, isTruncated: false, text: 'x'.repeat(8000) },
      ])),
    },
  }));
}

test('relaying a GraphQL answer passes over none of its bytes', async t => {
  const small = graphqlAnswer(1);
  const large = graphqlAnswer(1000);
  const oids = Array.from({ length: 1000 }, (_, index) => index.toString(16).padStart(40, '0'));
  const body = JSON.stringify({ owner: 'o', repo: 'r', oids });
  const relay = answer => withMockedFetch(async () => new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < answer.byteLength; offset += 65_536) {
        controller.enqueue(answer.subarray(offset, offset + 65_536));
      }
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }), async () => {
    const response = await worker.fetch(new Request('https://worker.example/graphql/blobs', {
      method: 'POST',
      body,
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
    }), ENV);
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    while (!(await reader.read()).done) {
      // Bytes are discarded: what the browser does with them is not the Worker's CPU.
    }
  });
  const smallBlocks = await blocksRun(WORKER_FILE, () => relay(small));
  const largeBlocks = await blocksRun(WORKER_FILE, () => relay(large));
  t.diagnostic(`relay: ${smallBlocks} blocks of the Worker for ${small.byteLength} bytes, ${largeBlocks} for ${large.byteLength}`);
  assert.ok(largeBlocks - smallBlocks <= large.byteLength / 1000, `a thousand times the bytes ran ${largeBlocks - smallBlocks} more blocks of the Worker`);
  assert.equal(await nativeBytes(large.byteLength / 16, () => relay(large)), 0, 'no native pass reads the answer');
});
