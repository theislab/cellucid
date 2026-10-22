import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { describeSyncOutcome } from '../assets/js/app/ui/modules/community-annotation/github-connection-flow.js';

function moduleSource(relativePath) {
  return readFileSync(
    new URL(`../assets/js/app/ui/modules/${relativePath}`, import.meta.url),
    'utf8'
  );
}

const controlsSource = moduleSource('community-annotation-controls.js');
const flowSource = moduleSource('community-annotation/github-connection-flow.js');

function slice(text, start, end) {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `${start} must exist`);
  const to = text.indexOf(end, from + start.length);
  assert.ok(to > from, `${end} must follow ${start}`);
  return text.slice(from, to);
}

test('only a completed sync outcome produces the success text', () => {
  assert.equal(
    describeSyncOutcome({ status: 'done' }, 'Publish complete.'),
    'Publish complete.'
  );
  assert.match(
    describeSyncOutcome({ status: 'skipped' }, 'Publish complete.'),
    /Another GitHub sync is still running/
  );
  assert.equal(
    describeSyncOutcome({ status: 'cancelled' }, 'Publish complete.'),
    'Cancelled.'
  );
  assert.equal(
    describeSyncOutcome(
      { status: 'failed', error: 'Sign in required.' },
      'Publish complete.'
    ),
    '⚠ Sign in required.'
  );
  assert.throws(
    () => describeSyncOutcome(undefined, 'Publish complete.'),
    /explicit outcome/
  );
  assert.throws(
    () => describeSyncOutcome({ status: 'failed' }, 'Publish complete.'),
    /error message/
  );
  assert.throws(
    () => describeSyncOutcome({ ok: true }, 'Publish complete.'),
    /Unknown GitHub sync outcome/
  );
});

test('Pull and Publish acquire and release syncBusy inside one try/finally', () => {
  const runner = slice(
    controlsSource,
    'async function runExclusiveSync',
    'async function pullFromGitHub'
  );
  assert.match(runner, /if \(syncBusy\) return Object\.freeze\(\{ status: 'skipped' \}\);/);
  const tryIndex = runner.indexOf('try {');
  const acquire = runner.indexOf('syncBusy = true;');
  const finallyIndex = runner.indexOf('} finally {');
  const release = runner.indexOf('syncBusy = false;');
  assert.ok(tryIndex >= 0 && acquire > tryIndex && finallyIndex > acquire);
  assert.ok(release > finallyIndex);
  assert.match(runner.slice(finallyIndex), /notifySyncBusyChange\(\);/);

  // Exactly one place in the controls sets or clears the flag.
  assert.equal([...controlsSource.matchAll(/syncBusy = true;/g)].length, 1);
  assert.equal([...controlsSource.matchAll(/(?<!let )syncBusy = false;/g)].length, 1);
  assert.match(
    controlsSource,
    /async function pullFromGitHub\(\{ signal = null, \.\.\.options \} = \{\}\) \{\s*return runExclusiveSync\(/
  );
  assert.match(
    controlsSource,
    /async function pushToGitHub\(\{ signal = null \} = \{\}\) \{\s*return runExclusiveSync\(/
  );
  const publish = controlsSource.slice(
    controlsSource.indexOf('async function publishExclusive')
  );
  assert.match(
    publish,
    /await handlePublishResult\(result\);\s*return \{ status: 'done' \};/
  );
  assert.match(
    publish,
    /notifications\.fail\(trackerId, msg\);\s*return \{ status: 'failed', error: syncError \|\| msg \};\s*\}\s*\}/
  );
});

test('the wizard derives status from outcomes and follows sync-busy transitions', () => {
  assert.doesNotMatch(flowSource, /getSyncError/);
  assert.doesNotMatch(flowSource, /result\?\.ok/);
  assert.match(
    flowSource,
    /controller\.subscribeSyncBusy\(\(\) => \{\s*if \(isModalOwnerCurrent\(\)\) updateUi\(\);/
  );
  assert.match(
    flowSource,
    /modalAbort\.signal\.addEventListener\('abort', unsubscribeSyncBusy/
  );
  assert.match(
    flowSource,
    /status\.textContent = describeSyncOutcome\(outcome, doneText\);/
  );
});

test('wizard busy flags are acquired inside the try that releases them', () => {
  for (const [start, end, flag] of [
    ['const loadRepoList = async', 'const connectSelectedRepo = async', 'isReloadingRepos'],
    ['const connectSelectedRepo = async', 'const signIn = async', 'isConnectingRepo'],
    ['const signIn = async', 'const closeModal =', 'isSigningIn'],
  ]) {
    const body = slice(flowSource, start, end);
    const tryIndex = body.indexOf('try {');
    const acquire = body.indexOf(`${flag} = true;`);
    const finallyIndex = body.indexOf('} finally {');
    const release = body.indexOf(`${flag} = false;`, finallyIndex);
    assert.ok(tryIndex >= 0 && acquire > tryIndex, `${flag} must be set inside try`);
    assert.ok(finallyIndex > acquire && release > finallyIndex, `${flag} must be cleared in finally`);
    assert.equal(
      [...body.matchAll(new RegExp(`${flag} = false;`, 'g'))].length,
      1,
      `${flag} has exactly one release`
    );
  }
});

test('the wizard opener has no unused mode, focus, or pull-now options', () => {
  const opener = slice(
    flowSource,
    'async function openGitHubConnectionFlow',
    'const appInstallUrl'
  );
  assert.doesNotMatch(opener, /\bmode\b|\bfocus\b|defaultPullNow/);
  assert.doesNotMatch(flowSource, /mode === 'auth'/);
  assert.doesNotMatch(moduleSource('community-annotation/controls-panel.js'), /defaultPullNow|focus: 'overview'/);
});
