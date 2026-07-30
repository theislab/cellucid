import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRESENTED_CAMERA_SETTLEMENT_CONTRACT,
  PresentedCameraSettlementTracker,
} from '../assets/js/rendering/presented-camera-settlement.js';

test('slow frames cannot split one camera motion burst', () => {
  const tracker = new PresentedCameraSettlementTracker();
  const events = [];
  const observe = (changed, now, burstEligible = true) => {
    const event = tracker.observeFrame(changed, now, burstEligible);
    if (event !== null) events.push(event);
    return event;
  };

  // The first exact state is only the subscriber's baseline.
  assert.equal(observe(true, 0, false), null);
  assert.equal(observe(true, 200), 'camera-changing');

  // Each 250 ms renderer gap exceeds the wall-clock threshold. Nevertheless,
  // an animation publisher that changes state after that first unchanged frame
  // still owns the same logical burst.
  let now = 200;
  for (let step = 0; step < 8; step += 1) {
    now += 250;
    assert.equal(observe(false, now), null);
    now += 1;
    assert.equal(observe(true, now), null);
  }
  assert.deepEqual(events, ['camera-changing']);

  now += 250;
  assert.equal(observe(false, now), null);
  now += 250;
  assert.equal(observe(false, now), 'camera-settled');
  assert.deepEqual(events, ['camera-changing', 'camera-settled']);
});

test('camera settlement has time and frame-count liveness bounds', () => {
  const timed = new PresentedCameraSettlementTracker();
  assert.equal(timed.observeFrame(true, 0, false), null);
  assert.equal(timed.observeFrame(true, 1, true), 'camera-changing');
  assert.equal(timed.observeFrame(false, 121, true), null);
  assert.equal(timed.observeFrame(false, 122, true), 'camera-settled');

  const frozenClock = new PresentedCameraSettlementTracker();
  assert.equal(frozenClock.observeFrame(true, 0, false), null);
  assert.equal(
    frozenClock.observeFrame(true, 0, true),
    'camera-changing',
  );
  for (
    let frame = 1;
    frame < PRESENTED_CAMERA_SETTLEMENT_CONTRACT.maximumUnchangedFrames;
    frame += 1
  ) {
    assert.equal(frozenClock.observeFrame(false, 0, true), null);
  }
  assert.equal(
    frozenClock.observeFrame(false, 0, true),
    'camera-settled',
  );
});

test('camera settlement reset retires the pending burst exactly', () => {
  const tracker = new PresentedCameraSettlementTracker();
  tracker.observeFrame(true, 0, false);
  assert.equal(tracker.observeFrame(true, 1, true), 'camera-changing');
  tracker.reset();
  for (
    let frame = 0;
    frame < PRESENTED_CAMERA_SETTLEMENT_CONTRACT.maximumUnchangedFrames;
    frame += 1
  ) {
    assert.equal(tracker.observeFrame(false, 1, true), null);
  }

  assert.throws(
    () => tracker.observeFrame('yes', 1, true),
    /exact boolean/,
  );
  assert.throws(
    () => tracker.observeFrame(false, Number.NaN, true),
    /finite non-negative/,
  );
  assert.throws(
    () => tracker.observeFrame(false, 1, null),
    /eligibility.*exact boolean/,
  );
});
