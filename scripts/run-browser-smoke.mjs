/**
 * `npm run test:browser:smoke -- [--project=<engine>] [Playwright arguments]`:
 * the smoke specs (`scripts/test-suites.mjs`) in the engines named, or in
 * every engine one after another. It sets `CELLUCID_BROWSER_SET=smoke`, which
 * `playwright.config.mjs` reads, and starts Playwright with the arguments it
 * was given: a script, so that the variable is set the same way on every
 * system.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const playwright = path.join(path.dirname(createRequire(import.meta.url).resolve('@playwright/test/package.json')), 'cli.js');

const child = spawn(process.execPath, [playwright, 'test', ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, CELLUCID_BROWSER_SET: 'smoke' },
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => child.kill(signal));
}
child.on('close', (code, signal) => {
  process.exitCode = signal === null ? code : 1;
});
