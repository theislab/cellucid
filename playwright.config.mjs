import { defineConfig, devices } from '@playwright/test';

import { resolveBrowserTestPorts } from './scripts/browser-test-ports.mjs';

// The server this config launches reads the same environment, so both halves of
// a run agree on the address without the port appearing twice.
const { origin, port } = resolveBrowserTestPorts();

const firefoxWebGLPreferences = Object.freeze({
  'webgl.disabled': false,
  'webgl.enable-webgl2': true,
  'webgl.forbid-software': false,
  'webgl.force-enabled': true,
});

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  forbidOnly: true,
  // A push runs this suite 27 times — three engines, three operating systems,
  // three shards — for roughly 2,700 browser test executions against shared CI
  // runners, headed, over software WebGL. The failures that result are timeouts
  // in unrelated specs: a startup that took longer than 60 s to reveal the
  // welcome modal, a directory-picker load that never reported its dataset.
  // They land on a different engine, shard and spec every time, and none has
  // ever reproduced locally. With no retry, one such stall marks the whole
  // 39-job gate red and says nothing about the change that triggered it, which
  // is the gate reporting on the runner rather than on the code.
  //
  // This does not hide a defect. A test that is actually broken fails all three
  // attempts, and a test that passes on retry is reported as flaky by the
  // reporter below — the bounded runner inherits its stdio, so that line reaches
  // the job log. Locally there is no retry, so a flake surfaces while it is
  // still cheap to investigate.
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['line']],
  timeout: 90_000,
  // Failure artifacts are keyed by port so concurrent runs cannot delete each
  // other's evidence: Playwright empties outputDir when a run starts. The path
  // stays under the git-ignored test-results tree.
  outputDir: `./test-results/${port}`,
  expect: {
    timeout: 60_000,
  },
  use: {
    baseURL: origin,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'off',
    video: 'off',
    viewport: { width: 1440, height: 1000 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: firefoxWebGLPreferences,
        },
      },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: {
    command: 'node scripts/serve-browser-tests.mjs',
    url: `${origin}/`,
    // A second run must not adopt the first run's server: that server is torn
    // down when its own run ends, which would strand the adopter mid-suite.
    // Refusing here reports the collision instead of blocking on the address.
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
