import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function moduleSource(relativePath) {
  return readFileSync(
    new URL(`../assets/js/app/ui/modules/${relativePath}`, import.meta.url),
    'utf8'
  );
}

const source = moduleSource('community-annotation-controls.js');
const domSource = moduleSource('community-annotation/dom.js');
const modalShellSource = moduleSource('community-annotation/modal-shell.js');
const identityProfileModalSource = moduleSource(
  'community-annotation/identity-profile-modal.js'
);
const connectionFlowSource = moduleSource(
  'community-annotation/github-connection-flow.js'
);
const controlsPanelSource = moduleSource(
  'community-annotation/controls-panel.js'
);

function slice(text, name, nextName) {
  const start = text.indexOf(name);
  assert.ok(start >= 0, `${name} must exist`);
  if (nextName === null) return text.slice(start);
  const end = text.indexOf(nextName, start + name.length);
  assert.ok(end > start, `${nextName} must follow ${name}`);
  return text.slice(start, end);
}

function functionSlice(name, nextName) {
  return slice(source, name, nextName);
}

test('persistent auto-pull belongs to controls context rather than setup modal', () => {
  const openSetup = slice(
    connectionFlowSource,
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
    functionSlice('function destroy()', 'async function pullFromGitHub'),
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
  const transaction = slice(
    connectionFlowSource,
    'const commitAutoPullPreference',
    'const toRepoFullName'
  );
  const durableCommit = transaction.indexOf(
    'writeAutoPullPreferences(nextPrefs)'
  );
  const localCommit = transaction.indexOf(
    'autoPullEnabled = enabled'
  );
  const timerCommit = transaction.indexOf(
    'ensureAutoPullTimer()'
  );
  const durableRollback = transaction.indexOf(
    'writeAutoPullPreferences(previousPrefs)'
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

  const handlers = slice(
    connectionFlowSource,
    "autoPullCheckbox.addEventListener('change'",
    "pullBtn.addEventListener('click'"
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
  const backHandler = slice(
    connectionFlowSource,
    "prevBtn.addEventListener('click'",
    "nextBtn.addEventListener('click'"
  );
  assert.doesNotMatch(backHandler, /clearAnnotationRepoForDataset/);
  assert.doesNotMatch(backHandler, /disconnectAnnotationRepo/);
  assert.match(
    backHandler,
    /uiStep = Math\.max\(1, \(Number\(uiStep\) \|\| 1\) - 1\)/
  );

  const disconnectHandler = slice(
    connectionFlowSource,
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

  const render = slice(controlsPanelSource, 'function render()', 'return {');
  const gating = render.slice(
    0,
    render.indexOf('// GitHub sync')
  );
  assert.match(gating, /const online =[\s\S]*?navigator\.onLine !== false/);
  assert.match(
    gating,
    /text: 'Offline: GitHub actions are disabled\.'/
  );
  assert.match(
    gating,
    /disabled: controller\.isSyncBusy\(\) \|\| !online/
  );
});

test('every async confirmation is physically owned by the exact context signal', () => {
  const calls = [
    ...source.matchAll(/await confirmAsync\(\{([\s\S]*?)\n\s*\}\);/g),
    ...controlsPanelSource.matchAll(
      /await confirmAsync\(\{([\s\S]*?)\n\s*\}\);/g
    ),
  ];
  assert.ok(calls.length >= 4);
  for (const call of calls) {
    assert.match(call[1], /signal: (?:opAbort|owner)\.signal/);
  }
  const confirm = slice(modalShellSource, 'function confirmAsync', null);
  assert.match(confirm, /cancelDialog = showConfirmDialog/);
  assert.match(confirm, /signal\?\.addEventListener\('abort', onAbort/);
  assert.match(confirm, /cancelDialog\(\)/);
});

test('repository discovery stays serial while its active DOM is bounded and memoized', () => {
  assert.match(
    connectionFlowSource,
    /const GITHUB_REPOSITORY_DISCOVERY_MAX_ITEMS = 10_000;/
  );
  assert.match(
    connectionFlowSource,
    /const GITHUB_REPOSITORY_PAGE_SIZE = 100;/
  );
  assert.match(
    connectionFlowSource,
    /className: 'community-annotation-repo-pagination',\s*role: 'group'/
  );

  const rendering = slice(
    connectionFlowSource,
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

  const discovery = slice(
    connectionFlowSource,
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
  const profile = slice(
    identityProfileModalSource,
    'async function editIdentityFlow',
    null
  );
  assert.match(
    profile,
    /Typing 3 or more characters in Name or ORCID searches the [\s\S]*?public ORCID registry\. Requests omit credentials and referrer information\./
  );
  assert.match(
    profile,
    /const orcidDisclosureId =[\s\S]*?'aria-describedby': orcidDisclosureId,[\s\S]*?'aria-label': 'ORCID',[\s\S]*?'aria-describedby': orcidDisclosureId/
  );
  const threshold = slice(
    domSource,
    'function hasAtLeastUnicodeCodePoints',
    'function downloadJsonAsFile'
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

  const settingsUi = controlsPanelSource;
  assert.match(
    settingsUi,
    /Object\.hasOwn\(annotatableSettingsDraft, selectedFieldKey\)/
  );
  for (const moduleSource of [source, settingsUi]) {
    assert.doesNotMatch(
      moduleSource,
      /!annotatableSettingsDraft\[selectedFieldKey\]/
    );
    assert.doesNotMatch(
      moduleSource,
      /annotatableSettingsDraft\[selectedFieldKey\] \|\| applied/
    );
  }
});
