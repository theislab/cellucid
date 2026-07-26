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

test('listener failure propagates unchanged and stops partial delivery', () => {
  const emitter = new EventEmitter();
  const failure = new Error('required listener rejected');
  const deliveries = [];

  emitter.on('changed', payload => {
    deliveries.push(['first', payload]);
    throw failure;
  });
  emitter.on('changed', payload => {
    deliveries.push(['second', payload]);
  });

  const payload = Object.freeze({ version: 1 });
  assert.throws(
    () => emitter.emit('changed', payload),
    error => error === failure,
  );
  assert.deepEqual(deliveries, [['first', payload]]);
});

test('once removes its listener before propagating callback failure', () => {
  const emitter = new EventEmitter();
  const failure = new Error('one-time listener rejected');
  let calls = 0;

  emitter.once('changed', () => {
    calls += 1;
    throw failure;
  });

  assert.throws(
    () => emitter.emit('changed'),
    error => error === failure,
  );
  assert.equal(emitter.listenerCount('changed'), 0);
  emitter.emit('changed');
  assert.equal(calls, 1);
});
