import assert from 'node:assert/strict';
import test from 'node:test';

import { EventEmitter } from '../assets/js/app/utils/event-emitter.js';

test('event subscriptions require exact event and callback ownership', () => {
  const emitter = new EventEmitter();
  const callback = () => {};

  for (const event of [null, undefined, 7, '', ' changed ', '\n']) {
    assert.throws(
      () => emitter.on(event, callback),
      /event.*non-empty.*trimmed string/i,
    );
    assert.throws(
      () => emitter.once(event, callback),
      /event.*non-empty.*trimmed string/i,
    );
    assert.throws(
      () => emitter.emit(event),
      /event.*non-empty.*trimmed string/i,
    );
    assert.throws(
      () => emitter.listenerCount(event),
      /event.*non-empty.*trimmed string/i,
    );
  }

  assert.throws(
    () => emitter.on('changed', null),
    /callback.*function/i,
  );
  assert.throws(
    () => emitter.once('changed', {}),
    /callback.*function/i,
  );
  assert.throws(
    () => emitter.off('changed', 'callback'),
    /callback.*function/i,
  );
});

/** Run `body` with `console.error` collected; returns what it was given. */
function withReports(body) {
  const reports = [];
  const original = console.error;
  console.error = (...args) => reports.push(args);
  try {
    body();
  } finally {
    console.error = original;
  }
  return reports;
}

test('a throwing listener is reported once and the others still hear the event', () => {
  const emitter = new EventEmitter();
  const failure = new Error('one listener failed');
  const deliveries = [];

  emitter.on('changed', payload => {
    deliveries.push(['first', payload]);
    throw failure;
  });
  emitter.on('changed', payload => {
    deliveries.push(['second', payload]);
  });

  const payload = Object.freeze({ version: 1 });
  const reports = withReports(() => emitter.emit('changed', payload));
  assert.deepEqual(deliveries, [['first', payload], ['second', payload]]);
  assert.equal(reports.length, 1);
  assert.match(reports[0][0], /EventEmitter "changed"/);
  assert.equal(reports[0][1], failure);
});

test('once removes its listener before it runs, even when it throws', () => {
  const emitter = new EventEmitter();
  let calls = 0;

  emitter.once('changed', () => {
    calls += 1;
    throw new Error('one-time listener failed');
  });

  const reports = withReports(() => emitter.emit('changed'));
  assert.equal(reports.length, 1);
  assert.equal(emitter.listenerCount('changed'), 0);
  emitter.emit('changed');
  assert.equal(calls, 1);
});

test('emitWhile stops the older event once a listener made it stale', () => {
  const emitter = new EventEmitter();
  let generation = 1;
  const heard = [];
  emitter.on('changed', value => {
    heard.push(['first', value]);
    if (value === 1) {
      generation = 2;
      emitter.emitWhile('changed', 2, () => generation === 2);
    }
  });
  emitter.on('changed', value => heard.push(['second', value]));
  assert.equal(emitter.emitWhile('changed', 1, () => generation === 1), false);
  assert.deepEqual(heard, [['first', 1], ['first', 2], ['second', 2]]);
  const unsubscribe = emitter.on('other', () => {});
  unsubscribe();
  unsubscribe();
  assert.equal(emitter.listenerCount('other'), 0);
});
