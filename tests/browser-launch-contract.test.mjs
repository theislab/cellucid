/**
 * Every measuring script launches its browser one way
 * (`scripts/lib/browser-launch.mjs`): on the machine's GPU, recording the
 * renderer it drew with and refusing a software rasterizer unless the run
 * asked for one (`--software-gl`). `app-run.mjs` and `scale-browser.mjs`
 * once launched Chromium on SwiftShader, and the app timings taken with them
 * measured the CPU rasterizer (frames of millions of points, and the main
 * thread held by synchronous GL calls), not the app.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  browserLaunchOptions,
  requireHardwareRenderer,
  softwareGlRequested,
} from '../scripts/lib/browser-launch.mjs';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

/** A stand-in for a Playwright page whose WebGL reports `identity`. */
function pageReporting(identity) {
  return { evaluate: async () => identity };
}

test('Chromium starts on the GPU, and on SwiftShader only when asked', () => {
  const gpu = browserLaunchOptions('chromium', { args: ['--remote-debugging-port=1'], softwareGl: false });
  assert.ok(gpu.args.includes('--enable-gpu') && gpu.args.includes('--ignore-gpu-blocklist'));
  assert.equal(gpu.args.includes('--use-angle=metal'), process.platform === 'darwin');
  assert.ok(!gpu.args.includes('--enable-unsafe-swiftshader'));
  assert.ok(gpu.args.includes('--remote-debugging-port=1'), 'extra switches kept');
  const software = browserLaunchOptions('chromium', { softwareGl: true });
  assert.ok(software.args.includes('--enable-unsafe-swiftshader'));
  assert.ok(!software.args.includes('--enable-gpu'));
  assert.equal(browserLaunchOptions('firefox', { softwareGl: false }).firefoxUserPrefs['webgl.force-enabled'], true);
  assert.deepEqual(browserLaunchOptions('webkit', { headless: false }), { headless: false });
  assert.throws(() => browserLaunchOptions('netscape'), /Unknown browser engine/);
  assert.equal(softwareGlRequested(['node', 'x.mjs', '--software-gl']), true);
  assert.equal(softwareGlRequested(['node', 'x.mjs']), false);
});

test('a run on a software or unidentified rasteriser is refused, and a hardware one names itself', async () => {
  const metal = { unmaskedRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)', unmaskedVendor: 'Google Inc. (Apple)', maskedRenderer: 'WebKit WebGL' };
  assert.equal(await requireHardwareRenderer(pageReporting(metal), { softwareGl: false }), metal.unmaskedRenderer);
  const swiftShader = { unmaskedRenderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', unmaskedVendor: 'Google Inc. (Google)', maskedRenderer: 'WebKit WebGL' };
  await assert.rejects(requireHardwareRenderer(pageReporting(swiftShader), { softwareGl: false }), /swiftshader/i);
  assert.equal(await requireHardwareRenderer(pageReporting(swiftShader), { softwareGl: true }), swiftShader.unmaskedRenderer);
  const masked = { unmaskedRenderer: null, unmaskedVendor: null, maskedRenderer: 'WebKit WebGL' };
  await assert.rejects(requireHardwareRenderer(pageReporting(masked), { softwareGl: false }), /cannot be identified/);
  await assert.rejects(requireHardwareRenderer(pageReporting(null), { softwareGl: false }), /no WebGL 2/);
});

test('every script that launches a browser launches it through browser-launch.mjs', () => {
  const files = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name === 'node_modules' || name.startsWith('.')) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(mjs|js)$/.test(name)) files.push(full);
    }
  };
  walk(SCRIPTS);
  const launchers = [];
  for (const file of files) {
    const relative = path.relative(SCRIPTS, file);
    const source = readFileSync(file, 'utf8');
    if (relative === path.join('lib', 'browser-launch.mjs')) continue;
    assert.doesNotMatch(source, /--enable-unsafe-swiftshader|--use-angle=|--enable-gpu\b/, `${relative} sets GPU switches of its own`);
    const calls = [...source.matchAll(/\.(launch|launchServer|launchPersistentContext)\(([^)]*)/g)];
    if (calls.length === 0) continue;
    launchers.push(relative);
    for (const [call, , argument] of calls) {
      // `launchPersistentContext(profile, { ...options, ...browserLaunchOptions(...) })`.
      assert.match(argument + source.slice(source.indexOf(call), source.indexOf(call) + 200), /browserLaunchOptions\(/, `${relative}: ${call.trim()} launches without browserLaunchOptions`);
    }
  }
  for (const expected of ['render-scenarios.mjs', 'benchmark-analysis.mjs', 'benchmark-real-links.mjs', path.join('efficiency-floor', 'app-run.mjs'), path.join('efficiency-floor', 'scale-app.mjs'), path.join('efficiency-floor', 'scale-browser.mjs')]) {
    assert.ok(launchers.includes(expected), `${expected} is among the scripts checked`);
  }
});
