/**
 * An enabled overlay keeps frames going only while it draws something that
 * moves (rendering/overlays): the velocity overlay with no field for the
 * layout, nothing visible, particles off at this level of detail, or no view
 * presented (smoke mode) lets a still scene settle.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { OverlayManager } from '../assets/js/rendering/overlays/overlay-manager.js';
import { VelocityOverlay } from '../assets/js/rendering/overlays/velocity/velocity-overlay.js';

function velocity({ presented = ['live'], particles = {}, spawns = {} } = {}) {
  return Object.assign(Object.create(VelocityOverlay.prototype), {
    id: 'velocity',
    enabled: true,
    visible: true,
    _initialized: true,
    _disposed: false,
    _disposeRequested: false,
    _disposePending: false,
    _contextLost: false,
    _presentedViewIds: new Set(presented),
    _particleByView: new Map(Object.entries(particles)),
    _spawnByView: new Map(Object.entries(spawns)),
  });
}

test('the velocity overlay needs frames only while particles flow or a table is being built', () => {
  assert.equal(velocity().needsContinuousFrames(), false, 'no field: nothing to draw');
  assert.equal(velocity({ particles: { live: { activeParticleCount: 512 } } }).needsContinuousFrames(), true);
  // A particle state that does not flow is owed the update that disposes it.
  assert.equal(velocity({ particles: { live: { activeParticleCount: 0 } } }).needsContinuousFrames(), true);
  assert.equal(velocity({ spawns: { live: { building: true, dirty: false, targetCount: 1000 } } }).needsContinuousFrames(), true);
  assert.equal(velocity({ spawns: { live: { building: false, dirty: true, targetCount: 1000 } } }).needsContinuousFrames(), true);
  assert.equal(
    velocity({ spawns: { live: { building: false, dirty: true, targetCount: 0 } } }).needsContinuousFrames(),
    false,
    'a table its view no longer wants (no field, particles off) keeps no frames going',
  );
  assert.equal(
    velocity({ spawns: { live: { building: false, dirty: false, ready: true, tableSize: 0, targetCount: 1000 } } }).needsContinuousFrames(),
    false,
    'a published empty table (nothing visible) draws nothing',
  );
  assert.equal(
    velocity({ presented: [], particles: { live: { activeParticleCount: 512 } } }).needsContinuousFrames(),
    false,
    'no presented view (smoke mode)',
  );
  assert.equal(
    velocity({ presented: ['a'], spawns: { b: { building: false, dirty: true, targetCount: 1000 } } }).needsContinuousFrames(),
    false,
    'a dormant view never runs, so it never keeps frames going',
  );
  // A table just published asks for frames until its particles exist; with
  // particles off at this level of detail it does not.
  const published = targetCount => ({ live: { building: false, dirty: false, ready: true, tableSize: 40, targetCount } });
  assert.equal(velocity({ spawns: published(1000) }).needsContinuousFrames(), true);
  assert.equal(velocity({ spawns: published(0) }).needsContinuousFrames(), false);
  const disabled = velocity({ particles: { live: { activeParticleCount: 512 } } });
  disabled.enabled = false;
  assert.equal(disabled.needsContinuousFrames(), false);
});

test('the manager asks each enabled overlay, and the viewer asks the manager', () => {
  const manager = new OverlayManager({});
  const overlay = {
    id: 'o', priority: 0, enabled: true, visible: true,
    init() {}, update() {}, render() {}, dispose() {},
    animating: false,
    needsContinuousFrames() { return this.animating; },
  };
  manager.register(overlay);
  assert.equal(manager.hasEnabledOverlays(), true);
  assert.equal(manager.needsContinuousFrames(), false);
  overlay.animating = true;
  assert.equal(manager.needsContinuousFrames(), true);
  overlay.enabled = false;
  assert.equal(manager.needsContinuousFrames(), false);
  assert.throws(
    () => manager.register({ ...overlay, id: 'p', needsContinuousFrames: undefined }),
    /needsContinuousFrames lifecycle/,
  );
  const viewer = readFileSync(new URL('../assets/js/rendering/viewer.js', import.meta.url), 'utf8');
  assert.match(viewer, /if \(overlayManager\?\.needsContinuousFrames\(\) === true\) return 'overlay';/);
  assert.match(viewer, /\|\| overlayManager\?\.needsContinuousFrames\(\) === true\n/);
  const cause = viewer.slice(viewer.indexOf('function sceneAnimationCause'), viewer.indexOf('function nextFrameCause'));
  assert.doesNotMatch(cause, /hasEnabledOverlays/);
});
