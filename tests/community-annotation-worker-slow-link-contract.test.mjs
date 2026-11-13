// A slow link that keeps moving is never cut by the community-annotation
// Worker; only silence for a whole stall window is (a 1,000,000-byte publish
// on a 500 kbit/s uplink takes 21 s and must not meet a total deadline).
// Time is virtual:
// setTimeout runs on a clock the test advances, so no test waits for real.

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../assets/js/app/community-annotations/_worker-code.js';
import { withMockedFetch } from './helpers/worker-fetch.mjs';

const ENV = Object.freeze({
  ALLOWED_ORIGINS: 'https://app.example',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});
const OPERATION_ID = '018f5e3a-7b9c-4d2e-8f10-123456789abc';
// GitHub's own 10 s request timeout plus a 3 s connection set-up.
const STALL_MS = 13_000;
// 500 kbit/s.
const BYTES_PER_SECOND = 62_500;

/** setTimeout and clearTimeout on a clock that moves only when the test advances it. */
function installVirtualClock() {
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  let now = 0;
  const timers = new Set();
  let fired = 0;
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const timer = { at: now + delay, callback, args };
    timers.add(timer);
    return timer;
  };
  globalThis.clearTimeout = timer => {
    timers.delete(timer);
  };
  return {
    get now() {
      return now;
    },
    get fired() {
      return fired;
    },
    pending: () => timers.size,
    advance(ms) {
      now += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at > now || !timers.has(timer)) continue;
        timers.delete(timer);
        fired += 1;
        timer.callback(...timer.args);
      }
    },
    restore() {
      globalThis.setTimeout = previousSetTimeout;
      globalThis.clearTimeout = previousClearTimeout;
    },
  };
}

/** Let queued work run until `condition` holds (a bounded number of macrotasks). */
async function until(condition, label) {
  for (let turn = 0; turn < 200; turn += 1) {
    if (condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`never reached: ${label}`);
}

/** A byte stream that hands out one piece each time the test lets it. */
function gatedStream(bytes, pieceBytes) {
  let offset = 0;
  let release = null;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      return new Promise(resolve => {
        release = () => {
          release = null;
          if (offset >= bytes.byteLength) controller.close();
          else {
            controller.enqueue(bytes.slice(offset, offset + pieceBytes));
            offset += pieceBytes;
          }
          resolve();
        };
      });
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    waiting: () => release !== null,
    step() {
      release();
    },
    done: () => offset >= bytes.byteLength,
    cancelled: () => cancelled,
  };
}

function publishBody() {
  const content = btoa('a'.repeat(1_000_000));
  return new TextEncoder().encode(JSON.stringify({ message: 'Publish annotations', content, branch: 'main' }));
}

function publishRequest(body) {
  return new Request('https://worker.example/api/repos/o/r/contents/annotations/users/ghid_1.json', {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer token',
      'Content-Type': 'application/json',
      'X-Cellucid-Operation-Id': OPERATION_ID,
    },
    body,
    duplex: 'half',
  });
}

function github(forwarded) {
  return async (url, options = {}) => {
    if (String(url) === 'https://api.github.com/user') {
      return new Response('{"id":1,"login":"owner"}', { status: 200 });
    }
    forwarded.push(options.body);
    return new Response(JSON.stringify({ content: { sha: 'b'.repeat(40) } }), { status: 200 });
  };
}

test('a 1,000,000-byte publish uploaded at 500 kbit/s (22 s) is published', async () => {
  const bytes = publishBody();
  const upload = gatedStream(bytes, BYTES_PER_SECOND);
  const clock = installVirtualClock();
  const forwarded = [];
  try {
    await withMockedFetch(github(forwarded), async () => {
      const pending = worker.fetch(publishRequest(upload.stream), ENV);
      while (!upload.done()) {
        await until(upload.waiting, 'the Worker asks for the next piece');
        clock.advance(1000);
        upload.step();
      }
      await until(upload.waiting, 'the Worker reads the end');
      upload.step();
      const response = await pending;
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('X-Cellucid-Operation-Outcome'), 'applied');
    });
    assert.ok(clock.now > 20_000, `the upload took ${clock.now} ms of link time`);
    assert.equal(clock.fired, 0, 'no stall: the upload kept moving');
    assert.equal(clock.pending(), 0, 'no stall clock outlives the request');
    assert.equal(forwarded.length, 1);
    assert.equal(JSON.parse(forwarded[0]).content.length, 1_333_336);
  } finally {
    clock.restore();
  }
});

test('an upload silent for a whole stall window is stopped with 504, before anything is written', async () => {
  const bytes = publishBody();
  const upload = gatedStream(bytes, BYTES_PER_SECOND);
  const clock = installVirtualClock();
  const forwarded = [];
  try {
    await withMockedFetch(github(forwarded), async () => {
      const pending = worker.fetch(publishRequest(upload.stream), ENV);
      for (let piece = 0; piece < 3; piece += 1) {
        await until(upload.waiting, 'the Worker asks for the next piece');
        clock.advance(1000);
        upload.step();
      }
      await until(upload.waiting, 'the Worker asks for the fourth piece');
      clock.advance(STALL_MS - 1);
      assert.equal(clock.fired, 0, 'one millisecond short of the window is not a stall');
      clock.advance(1);
      assert.equal(clock.fired, 1);
      const response = await pending;
      assert.equal(response.status, 504);
      assert.deepEqual(await response.json(), { error: 'Worker request stalled: nothing moved for 13 s' });
      assert.equal(response.headers.get('X-Cellucid-Operation-Outcome'), 'not-applied');
      await until(upload.cancelled, 'the upload is cancelled');
    });
    assert.deepEqual(forwarded, []);
  } finally {
    clock.restore();
  }
});

function blobRequest() {
  return new Request(`https://worker.example/api/repos/o/r/git/blobs/${'a'.repeat(40)}`, {
    headers: { Authorization: 'Bearer token' },
  });
}

function blobBytes() {
  return new TextEncoder().encode(JSON.stringify({
    sha: 'a'.repeat(40),
    size: 1_000_000,
    encoding: 'base64',
    content: btoa('a'.repeat(1_000_000)),
  }));
}

test('a download the browser reads slowly is never cut: waiting for the browser is not a stall', async () => {
  const bytes = blobBytes();
  const clock = installVirtualClock();
  try {
    await withMockedFetch(async () => new Response(new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.byteLength; offset += BYTES_PER_SECOND) {
          controller.enqueue(bytes.slice(offset, offset + BYTES_PER_SECOND));
        }
        controller.close();
      },
    }), { status: 200 }), async () => {
      const response = await worker.fetch(blobRequest(), ENV);
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      const received = [];
      for (;;) {
        // The browser takes a minute per piece: far past the stall window.
        clock.advance(60_000);
        const { done, value } = await reader.read();
        if (done) break;
        received.push(value);
      }
      const total = received.reduce((sum, piece) => sum + piece.byteLength, 0);
      assert.equal(total, bytes.byteLength);
    });
    assert.equal(clock.fired, 0);
    assert.equal(clock.pending(), 0);
  } finally {
    clock.restore();
  }
});

test('a download GitHub trickles at 500 kbit/s is relayed whole; one silent for a stall window ends in 504', async () => {
  for (const stallAfter of [null, 5]) {
    const bytes = blobBytes();
    const source = gatedStream(bytes, BYTES_PER_SECOND);
    const clock = installVirtualClock();
    try {
      await withMockedFetch(async () => new Response(source.stream, { status: 200 }), async () => {
        const response = await worker.fetch(blobRequest(), ENV);
        assert.equal(response.status, 200);
        const reading = response.arrayBuffer().then(
          buffer => ({ bytes: buffer.byteLength }),
          error => ({ error })
        );
        let pieces = 0;
        while (!source.done()) {
          await until(source.waiting, 'the relay asks GitHub for more');
          if (pieces === stallAfter) {
            clock.advance(STALL_MS);
            break;
          }
          clock.advance(1000);
          source.step();
          pieces += 1;
        }
        if (stallAfter === null) {
          await until(source.waiting, 'the relay reads the end');
          source.step();
          assert.deepEqual(await reading, { bytes: bytes.byteLength });
          assert.ok(clock.now > 20_000);
          assert.equal(clock.fired, 0);
        } else {
          const outcome = await reading;
          assert.equal(outcome.error?.status, 504);
          assert.equal(clock.fired, 1);
          await until(source.cancelled, 'the GitHub body is cancelled');
        }
        assert.equal(clock.pending(), 0);
      });
    } finally {
      clock.restore();
    }
  }
});
