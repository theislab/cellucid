import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL(
    '../assets/js/app/ui/modules/community-annotation-controls.js',
    import.meta.url
  ),
  'utf8'
);

function functionSlice(name, nextName) {
  const start = source.indexOf(name);
  const end = source.indexOf(nextName, start + name.length);
  assert.ok(start >= 0, `${name} must exist`);
  assert.ok(end > start, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

test('persistent auto-pull belongs to controls context rather than setup modal', () => {
  const openSetup = functionSlice(
    'async function openGitHubConnectionFlow',
    'async function connectRepoFlow'
  );
  assert.doesNotMatch(openSetup, /setInterval\s*\(/);
  assert.match(
    source,
    /let autoPullTimer = null;[\s\S]*?function refreshAutoPullScheduler/
  );
  assert.match(
    functionSlice(
      'function applySessionCacheContext',
      'function disconnectAnnotationRepo'
    ),
    /refreshAutoPullScheduler\(\)/
  );
  assert.match(
    functionSlice('function destroy()', 'async function applyConsensusColumn'),
    /stopAutoPullScheduler\(\)/
  );
});

test('setInterval replacement failure preserves the prior timer and runtime', () => {
  const scheduler = functionSlice(
    'function refreshAutoPullScheduler',
    'function reportBackgroundTaskFailure'
  );
  assert.match(
    scheduler,
    /const previousTimer = autoPullTimer;[\s\S]*?const previousRuntime = autoPullRuntime;[\s\S]*?replacementTimer = setInterval\(/
  );
  assert.match(
    scheduler,
    /catch \(error\) \{[\s\S]*?autoPullTimer = previousTimer;[\s\S]*?autoPullRuntime = previousRuntime;[\s\S]*?throw error;/
  );
  const replacement = scheduler.indexOf(
    'replacementTimer = setInterval('
  );
  const oldTimerClear = scheduler.indexOf(
    'clearInterval(previousTimer)'
  );
  assert.ok(replacement >= 0 && oldTimerClear > replacement);
});

test('auto-pull preference commits storage, runtime, and modal state transactionally', () => {
  const transaction = functionSlice(
    'const commitAutoPullPreference',
    'const toRepoFullName'
  );
  const durableCommit = transaction.indexOf(
    'writeAutoPullPrefs(nextPrefs)'
  );
  const localCommit = transaction.indexOf(
    'autoPullEnabled = enabled'
  );
  const timerCommit = transaction.indexOf(
    'ensureAutoPullTimer()'
  );
  const durableRollback = transaction.indexOf(
    'writeAutoPullPrefs(previousPrefs)'
  );
  const localRollback = transaction.indexOf(
    'autoPullEnabled = previousEnabled'
  );
  const timerRollback = transaction.lastIndexOf(
    'ensureAutoPullTimer()'
  );
  assert.ok(durableCommit >= 0);
  assert.ok(localCommit > durableCommit);
  assert.ok(timerCommit > localCommit);
  assert.ok(durableRollback > timerCommit);
  assert.ok(localRollback > durableRollback);
  assert.ok(timerRollback > localRollback);

  const handlers = source.slice(
    source.indexOf("autoPullCheckbox.addEventListener('change'"),
    source.indexOf("pullBtn.addEventListener('click'")
  );
  assert.match(
    handlers,
    /syncAutoPullFromStorage\(\{ force: true \}\)/
  );
  assert.match(handlers, /commitAutoPullPreference\(\{/);
  assert.doesNotMatch(handlers, /stopAutoPullScheduler\(\)/);
  assert.doesNotMatch(handlers, /autoPullEnabled = false/);
});

test('an incompatible Worker preserves repository ownership in role, pull, and publish paths', () => {
  const roleResolution = functionSlice(
    'async function resolveConnectedRoleOrDisconnect',
    'function disconnectAnnotationRepo'
  );
  const incompatibleRole = roleResolution.indexOf(
    'if (isWorkerCompatibilityFailure(err))'
  );
  const roleDisconnect = roleResolution.indexOf(
    'disconnectAnnotationRepo({',
    incompatibleRole
  );
  assert.ok(incompatibleRole >= 0);
  assert.ok(roleDisconnect > incompatibleRole);
  assert.match(
    roleResolution.slice(incompatibleRole, roleDisconnect),
    /repository connection was preserved[\s\S]*?Deploy the matching Cellucid Worker[\s\S]*?return false;/
  );

  const pull = functionSlice(
    'async function pullFromGitHub',
    'async function pushToGitHub'
  );
  assert.match(
    pull,
    /!workerCompatibilityFailure[\s\S]*?\(access\.getRole\?\.\(\) \|\| 'unknown'\) === 'unknown'/
  );
  const push = source.slice(source.indexOf('async function pushToGitHub'));
  assert.match(
    push,
    /!workerCompatibilityFailure[\s\S]*?\(access\.getRole\?\.\(\) \|\| 'unknown'\) === 'unknown'/
  );
});

test('wizard Back preserves a connected repo while the dedicated action disconnects it', () => {
  const backHandler = functionSlice(
    "prevBtn.addEventListener('click'",
    "nextBtn.addEventListener('click'"
  );
  assert.doesNotMatch(backHandler, /clearAnnotationRepoForDataset/);
  assert.doesNotMatch(backHandler, /disconnectAnnotationRepo/);
  assert.match(
    backHandler,
    /uiStep = Math\.max\(1, \(Number\(uiStep\) \|\| 1\) - 1\)/
  );

  const disconnectHandler = functionSlice(
    "disconnectRepoBtn.addEventListener('click'",
    "disconnectGitHubBtn.addEventListener('click'"
  );
  assert.match(disconnectHandler, /disconnectAnnotationRepo\(\{/);
  assert.match(
    disconnectHandler,
    /message: 'Disconnected annotation repository\.'/
  );
});

test('offline transition retires network owners and synchronously renders both gating branches', () => {
  const offline = functionSlice(
    'const reconcileOfflineEvent',
    'window.addEventListener'
  );
  assert.match(offline, /stopAutoPullScheduler\(\)/);
  assert.match(offline, /abortActiveSync\('Network connection was lost\.'\)/);
  assert.match(offline, /closeActiveGitHubConnectionModal\(\)/);
  assert.match(offline, /render\(\)/);

  const render = functionSlice('function render()', 'return {');
  const gating = render.slice(
    0,
    render.indexOf('// GitHub sync')
  );
  assert.match(gating, /const online =[\s\S]*?navigator\.onLine !== false/);
  assert.match(
    gating,
    /text: 'Offline: GitHub actions are disabled\.'/
  );
  assert.match(gating, /disabled: syncBusy \|\| !online/);
});

test('every async confirmation is physically owned by the exact context signal', () => {
  const calls = [...source.matchAll(/await confirmAsync\(\{([\s\S]*?)\n\s*\}\);/g)];
  assert.ok(calls.length >= 4);
  for (const call of calls) {
    assert.match(call[1], /signal: (?:opAbort|owner)\.signal/);
  }
  const confirm = functionSlice(
    'function confirmAsync',
    'function httpStatusOrNull'
  );
  assert.match(confirm, /cancelDialog = showConfirmDialog/);
  assert.match(confirm, /signal\?\.addEventListener\('abort', onAbort/);
  assert.match(confirm, /cancelDialog\(\)/);
});

test('repository discovery stays serial while its active DOM is bounded and memoized', () => {
  assert.match(
    source,
    /const GITHUB_REPOSITORY_DISCOVERY_MAX_ITEMS = 10_000;/
  );
  assert.match(source, /const GITHUB_REPOSITORY_PAGE_SIZE = 100;/);
  assert.match(
    source,
    /className: 'community-annotation-repo-pagination',\s*role: 'group'/
  );

  const rendering = functionSlice(
    'const renderRepoCards',
    'const updateUi'
  );
  assert.match(rendering, /const activeStep =/);
  assert.match(
    rendering,
    /clearRepoView\(repoGridStep2, repoPagerStep2\)[\s\S]*?clearRepoView\(repoGridStep3, repoPagerStep3\)/
  );
  assert.match(rendering, /repoRenderSnapshot !== null/);
  assert.match(rendering, /document\.createDocumentFragment\(\)/);
  assert.match(rendering, /source\.slice\(pageStart, pageEnd\)/);
  assert.match(rendering, /grid\.replaceChildren\(fragment\)/);
  assert.match(rendering, /repoFocusRequestFullName = full;/);
  assert.match(rendering, /replacement\.focus\(\)/);
  assert.match(rendering, /'aria-pressed': isSelected \? 'true' : 'false'/);

  const discovery = functionSlice(
    'const loadRepoList',
    'const connectSelectedRepo'
  );
  assert.match(
    discovery,
    /if \(!isModalOwnerCurrent\(\) \|\| isReloadingRepos\) return;/
  );
  assert.match(
    discovery,
    /for \(const inst of installations\) \{[\s\S]*?await githubAuth\.listInstallationRepos/
  );
  assert.doesNotMatch(discovery, /Promise\.all/);
  assert.match(
    discovery,
    /repos\.length >=[\s\S]*?GITHUB_REPOSITORY_DISCOVERY_MAX_ITEMS/
  );
  assert.match(discovery, /searchKey: nameKey/);
  assert.match(
    discovery,
    /catch \(err\) \{\s*if \(!isModalOwnerCurrent\(\)\) return;/
  );
  assert.match(
    discovery,
    /finally \{[\s\S]*?if \(isModalOwnerCurrent\(\)\) updateUi\(\);/
  );
});

test('profile visibly discloses the external ORCID lookup to both inputs', () => {
  const profile = functionSlice(
    'async function editIdentityFlow',
    'async function ensureIdentityForUserKey'
  );
  assert.match(
    profile,
    /Typing 3 or more characters in Name or ORCID searches the [\s\S]*?public ORCID registry\. Requests omit credentials and referrer information\./
  );
  assert.match(
    profile,
    /const orcidDisclosureId =[\s\S]*?'aria-describedby': orcidDisclosureId,[\s\S]*?'aria-label': 'ORCID',[\s\S]*?'aria-describedby': orcidDisclosureId/
  );
  const threshold = functionSlice(
    'function hasAtLeastUnicodeCodePoints',
    'function runExactCleanup'
  );
  assert.match(threshold, /for \(const _codePoint of value\)/);
  assert.doesNotMatch(threshold, /Array\.from|spread|\[\.\.\./);
  assert.match(
    profile,
    /!hasAtLeastUnicodeCodePoints\(q, 3\)/
  );
});

test('author consensus drafts preserve legal prototype-named field identities', () => {
  const draftOwner = functionSlice(
    'const annotatableSettingsDraft',
    'const lifecycleAbort'
  );
  assert.match(
    draftOwner,
    /const annotatableSettingsDraft = Object\.create\(null\);/
  );

  const settingsUi = source;
  assert.match(
    settingsUi,
    /Object\.hasOwn\(annotatableSettingsDraft, selectedFieldKey\)/
  );
  assert.doesNotMatch(
    settingsUi,
    /!annotatableSettingsDraft\[selectedFieldKey\]/
  );
  assert.doesNotMatch(
    settingsUi,
    /annotatableSettingsDraft\[selectedFieldKey\] \|\| applied/
  );
});
