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
  // Deliberately zero, in CI as well as locally, matching the policy stated in
  // the browser job of `.github/workflows/`: tests are neither retried nor
  // skipped, mocked, or given more time. A retry that turns a red gate green
  // buys nothing here — this suite is the only thing standing between a
  // renderer defect and the published site, and a failure it absorbed is a
  // failure nobody read.
  //
  // The cost is real and worth naming: a push runs this suite 27 times — three
  // engines, three operating systems, three shards — and a single stall on a
  // shared runner marks the whole gate red. When that happens the failure is a
  // timeout in a spec unrelated to the change, on a different engine and shard
  // each time. Re-run the job and read what it says the second time; if the
  // same spec fails twice, it is the code.
  retries: 0,
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
