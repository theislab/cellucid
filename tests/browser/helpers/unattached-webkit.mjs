/**
 * A page opened in the WebKit build Playwright installs, launched without
 * Playwright attached, which reports its own result over HTTP.
 *
 * Playwright drives WebKit through its Web Inspector, and the inspector's
 * network agent runs on the page's main thread for every chunk of every
 * response, a worker's included (WebKit carries a worker's loads through
 * its page). On the Linux CI runners that work held the page's main thread
 * for 50 to 64 ms during one 15 MB read, which the same WebKit build without
 * the inspector carried in 20 ms or less (`analysis-no-long-tasks.spec.mjs`
 * gives the measurements). A spec that bounds how long the page's main
 * thread is held measures WebKit here, so the bound is the browser's and
 * not the harness's.
 *
 * The page posts its result as the body of a request to `reportUrl` (a
 * no-cors `fetch` is enough: the body arrives, the answer is not read).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { webkit } from '@playwright/test';

/** Stop the browser and every process it started (the launcher script's MiniBrowser among them). */
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The group has already exited.
  }
}

/**
 * Open the page `pageUrl(reportUrl)` in WebKit without Playwright attached
 * and wait for the result it posts.
 *
 * @param {(reportUrl: string) => string} pageUrl
 * @param {{timeoutMs: number}} options
 * @returns {Promise<{result: string|null, browserOutput: string}>} `result`:
 *   the body the page posted, or null when none arrived in `timeoutMs`
 */
export async function reportFromUnattachedWebKit(pageUrl, { timeoutMs }) {
  let deliver;
  const posted = new Promise(resolve => {
    deliver = resolve;
  });
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
    });
    request.on('end', () => {
      response.end();
      deliver(body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = mkdtempSync(path.join(os.tmpdir(), 'cellucid-unattached-webkit-'));
  let browserOutput = '';
  let child = null;
  let timer = null;
  try {
    const reportUrl = `http://127.0.0.1:${server.address().port}/`;
    // Playwright's own WebKit arguments, less the inspector pipe.
    const args = ['--headless', `--user-data-dir=${profile}`];
    if (process.platform === 'win32') args.push('--disable-accelerated-compositing');
    child = spawn(webkit.executablePath(), [...args, pageUrl(reportUrl)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const keep = chunk => {
      browserOutput = (browserOutput + chunk).slice(-8_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const exited = new Promise(resolve => {
      child.on('error', error => resolve(`could not start: ${error.message}`));
      child.on('exit', (code, signal) => resolve(`exited (${signal ?? code}) before reporting`));
    });
    const timedOut = new Promise(resolve => {
      timer = setTimeout(() => resolve(`reported nothing within ${timeoutMs} ms`), timeoutMs);
    });
    const outcome = await Promise.race([
      posted.then(body => ({ result: body })),
      exited.then(why => ({ result: null, why })),
      timedOut.then(why => ({ result: null, why })),
    ]);
    if (outcome.result === null) browserOutput = `${outcome.why}\n${browserOutput}`;
    return { result: outcome.result, browserOutput };
  } finally {
    clearTimeout(timer);
    if (child !== null) stop(child);
    server.closeAllConnections();
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
}
