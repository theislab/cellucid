import { defineConfig, devices } from '@playwright/test';

import { resolveBrowserTestPorts } from './scripts/browser-test-ports.mjs';
import { smokeSpecs } from './scripts/test-suites.mjs';

// The server this config launches reads the same environment, so both halves of
// a run agree on the address without the port appearing twice.
const { host, origin, port } = resolveBrowserTestPorts();

const firefoxWebGLPreferences = Object.freeze({
  'webgl.disabled': false,
  'webgl.enable-webgl2': true,
  'webgl.forbid-software': false,
  'webgl.force-enabled': true,
});

// Firefox never opens its own file picker in a run: a picker it would open
// answers `cancel` at once (`widget.disable_file_pickers`,
// `nsBaseFilePicker::MaybeBlockFilePicker`), as Playwright's replacement picker
// answers one whose chooser a spec intercepts (`helpers/file-chooser-cancel.mjs`).
//
// Playwright's Firefox (r1572, Playwright 1.65) decides twice whether a
// chooser is intercepted: in the page, when `HTMLInputElement::InitFilePicker`
// announces the picker ("file-input-picker-opening": the `filechooser` event),
// and in the parent process, when the picker is created (juggler
// `FilePickerOverride.init`, the replacement only if interception is still on).
// Between the two Firefox looks up the input's last upload folder
// (`UploadLastDir::FetchDirectoryAndDisplayPicker`, a content-preference read
// from the parent process), on every pick of an input holding no files. A
// `page.waitForEvent('filechooser')` removes its listener once the event comes,
// and Playwright then turns interception off; when that reaches the parent
// before the lookup ends, Firefox's own picker is created: on Linux under xvfb
// (headed) a GTK dialog nobody closes, on Linux headless none at all
// (`nsFilePicker::Open` refuses, and `FilePickerParent::RecvOpen` never
// answers), on macOS an open panel nobody closes. The input's picker then never
// closes (`mPickerRunning` stays set), and that input's next click returns at
// "Just one nsIFilePicker is allowed" before any `filechooser` event: My
// datasets' Import…, clicked a second time, waited 240 s for nothing (CI run
// 42317705277). Measured on macOS, headless, one input emptied and picked 3
// times in each of 40 pages: Firefox's own picker in 10 of 120 picks, and the
// pick after one had no chooser; with this preference, every picker answered.
// A fresh input per click still left those 10 pickers open: the input is not
// the defect, and a person's Firefox closes its picker when they do. With this
// preference both decisions end the same way.
const firefoxFilePickerPreferences = Object.freeze({
  'widget.disable_file_pickers': true,
});

// The control walk's spec files (`tests/browser/helpers/control-walk.mjs`).
// Its tests take minutes each, and Playwright shards by test count, so in the
// browser job's shards its few long tests would all fall into one shard
// (Chromium 3/8 ran about 50 of its 75 minutes in CI run 42334173086). CI
// runs them in a job of their own instead, a share a job: the browser job
// sets `CELLUCID_CONTROL_WALK=apart` (every spec but the walk), the walk job
// `only` (the walk's files alone, `--shard=k/<files>` a file each). Unset, a
// run holds every spec.
const CONTROL_WALK_FILES = /[\\/]control-walk-\d+-of-\d+\.spec\.mjs$/;
const controlWalk = process.env.CELLUCID_CONTROL_WALK ?? '';
if (!['', 'apart', 'only'].includes(controlWalk)) {
  throw new Error(`CELLUCID_CONTROL_WALK is "apart", "only" or unset, not "${controlWalk}".`);
}

// `CELLUCID_BROWSER_SET=smoke` (`npm run test:browser:smoke`): each engine
// runs its smoke specs only (`scripts/test-suites.mjs`), the short walk from
// start to export that answers while code is being changed. Unset, a run
// holds every spec.
const browserSet = process.env.CELLUCID_BROWSER_SET ?? '';
if (!['', 'smoke'].includes(browserSet)) {
  throw new Error(`CELLUCID_BROWSER_SET is "smoke" or unset, not "${browserSet}".`);
}
if (browserSet === 'smoke' && controlWalk !== '') {
  throw new Error('CELLUCID_BROWSER_SET=smoke and CELLUCID_CONTROL_WALK cannot both be set: the control walk is no smoke spec.');
}
const onlySmoke = engine => (browserSet === 'smoke' ? { testMatch: smokeSpecs(engine) } : {});

export default defineConfig({
  testDir: './tests/browser',
  ...(controlWalk === 'only' ? { testMatch: CONTROL_WALK_FILES } : {}),
  // The live agent specs call the real Anthropic and OpenAI APIs with the
  // owner's keys: they are never in a CI run or a plain local run, only in
  // `npm run test:live-agents` (tests/browser/live-agents/live-harness.mjs).
  testIgnore: [
    ...(process.env.CELLUCID_LIVE_AGENTS === '1' ? [] : ['**/live-agents/**']),
    ...(controlWalk === 'apart' ? [CONTROL_WALK_FILES] : []),
  ],
  fullyParallel: false,
  forbidOnly: true,
  // Deliberately zero, in CI as well as locally, matching the policy stated in
  // the browser job of `.github/workflows/`: tests are neither retried nor
  // skipped, mocked, or given more time. A retry that turns a red gate green
  // buys nothing here — this suite is the only thing standing between a
  // renderer defect and the published site, and a failure it absorbed is a
  // failure nobody read.
  //
  // The cost is real and worth naming: a push runs this suite in 36 jobs —
  // eight shards of every engine on Linux and of WebKit on macOS, and the
  // control walk's four shares — and a single stall on a shared runner marks
  // the whole gate red. When that happens the failure is a
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
    // A failed test keeps its action timeline, console, and network log --
    // which request or step stalled -- without DOM snapshots or screenshots,
    // whose capture cost would perturb timing-sensitive rendering specs.
    trace: {
      mode: 'retain-on-failure',
      snapshots: false,
      screenshots: false,
      sources: false,
    },
    video: 'off',
    viewport: { width: 1440, height: 1000 },
    // A deployed page registers the code cache (service-worker.js), whose
    // requests a spec's `page.route` cannot see. Specs run without it; the
    // spec of the code cache itself allows it (code-cache.spec.mjs).
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      ...onlySmoke('chromium'),
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      ...onlySmoke('firefox'),
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: { ...firefoxWebGLPreferences, ...firefoxFilePickerPreferences },
        },
      },
    },
    {
      name: 'webkit',
      ...onlySmoke('webkit'),
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: {
    command: 'node scripts/serve-browser-tests.mjs',
    // The address the server binds, which Node resolves too (`origin` may be
    // a `.localhost` name only browsers resolve to it).
    url: `http://${host}:${port}/`,
    // A second run must not adopt the first run's server: that server is torn
    // down when its own run ends, which would strand the adopter mid-suite.
    // Refusing here reports the collision instead of blocking on the address.
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
