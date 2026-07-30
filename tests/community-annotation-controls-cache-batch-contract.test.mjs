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
const setupGuide = readFileSync(
  new URL(
    '../assets/js/app/community-annotations/REPO_SETUP.md',
    import.meta.url
  ),
  'utf8'
);

test('one Pull generation commits all changed raw files through one cache batch', () => {
  const start = source.indexOf('async function pullFromGitHub');
  const end = source.indexOf('async function pushToGitHub', start);
  assert.ok(start >= 0 && end > start);
  const pull = source.slice(start, end);
  assert.equal(
    [...pull.matchAll(/fileCache\.setManyJson\s*\(/g)].length,
    1
  );
  assert.match(
    pull,
    /const changedCacheRecords = fetchedUserRecords\.map/
  );
  assert.match(
    pull,
    /changedCacheRecords\.push\(\{[\s\S]*?moderationResult\.path/
  );
  assert.match(
    pull,
    /records: changedCacheRecords,[\s\S]*?signal: opAbort\.signal/
  );
});

test('cache corruption invalidates its exact resolved scope before disconnect', () => {
  const start = source.indexOf('async function pullFromGitHub');
  const end = source.indexOf('async function pushToGitHub', start);
  assert.ok(start >= 0 && end > start);
  const pull = source.slice(start, end);
  assert.match(
    pull,
    /let resolvedCacheScope = null;[\s\S]*?resolvedCacheScope = \{[\s\S]*?datasetId,[\s\S]*?repoRef: canonicalRepoRef,[\s\S]*?userId,[\s\S]*?\};/
  );
  const recovery = pull.indexOf(
    "err?.code === 'LOCAL_RAW_CACHE_CORRUPT'"
  );
  const clear = pull.indexOf(
    'await fileCache.clearRepo(resolvedCacheScope)',
    recovery
  );
  const disconnect = pull.indexOf(
    'disconnectAnnotationRepo({',
    recovery
  );
  assert.ok(recovery >= 0);
  assert.ok(clear > recovery);
  assert.ok(disconnect > clear);
  assert.match(
    pull.slice(recovery, disconnect),
    /LOCAL_RAW_CACHE_RECOVERY_FAILED/
  );
});

test('awaited cache recovery rechecks the exact pull owner before UI or repo mutation', () => {
  const start = source.indexOf('async function pullFromGitHub');
  const end = source.indexOf('async function pushToGitHub', start);
  assert.ok(start >= 0 && end > start);
  const pull = source.slice(start, end);
  const clear = pull.indexOf(
    'await fileCache.clearRepo(resolvedCacheScope)'
  );
  const abortCheck = pull.indexOf(
    'throwIfActiveSyncAborted(opAbort)',
    clear
  );
  const ownerCheck = pull.indexOf(
    '!isContextOwnerCurrent(entryOwner)',
    abortCheck
  );
  const preserve = pull.indexOf(
    'if (preserveExisting)',
    ownerCheck
  );
  const disconnect = pull.indexOf(
    'disconnectAnnotationRepo({',
    preserve
  );
  assert.ok(clear >= 0);
  assert.ok(abortCheck > clear);
  assert.ok(ownerCheck > abortCheck);
  assert.ok(preserve > ownerCheck);
  assert.ok(disconnect > preserve);
});

test('candidate cache corruption restores the prior repo session and role', () => {
  const start = source.indexOf('async function pullFromGitHub');
  const end = source.indexOf('async function pushToGitHub', start);
  assert.ok(start >= 0 && end > start);
  const pull = source.slice(start, end);
  const recovery = pull.indexOf(
    "err?.code === 'LOCAL_RAW_CACHE_CORRUPT'"
  );
  const preserve = pull.indexOf(
    'if (preserveExisting)',
    pull.indexOf('await fileCache.clearRepo', recovery)
  );
  const disconnect = pull.indexOf(
    'disconnectAnnotationRepo({',
    preserve
  );
  assert.ok(recovery >= 0 && preserve > recovery);
  assert.match(
    pull.slice(preserve, disconnect),
    /lastRepoInfo = prevRepoInfo;[\s\S]*?lastRoleContext = prevRoleContext;[\s\S]*?access\.setRole\(prevRole\);[\s\S]*?session\.setCacheContext\(\{[\s\S]*?repoRef: storedRepoRef,[\s\S]*?userId: entryOwner\.userId,[\s\S]*?preservedExisting: true/
  );
});

test('configured field mismatch fails before cache selection or raw-file downloads', () => {
  const start = source.indexOf('async function pullFromGitHub');
  const end = source.indexOf('async function pushToGitHub', start);
  assert.ok(start >= 0 && end > start);
  const pull = source.slice(start, end);
  assert.equal(
    [...pull.matchAll(/const configuredList =/g)].length,
    1
  );
  const fieldValidation = pull.indexOf('const missingConfigured =');
  const rejection = pull.indexOf(
    'annotations/config.json references categorical field(s) absent from this dataset',
    fieldValidation
  );
  const cacheContext = pull.indexOf(
    'session.setCacheContext({ datasetId, repoRef: canonicalRepoRef, userId })'
  );
  const cacheInit = pull.indexOf('await fileCache.init()', cacheContext);
  const userDownload = pull.indexOf('sync.pullAllUsers({', cacheInit);
  const moderationDownload = pull.indexOf(
    'sync.pullModerationMerges({',
    cacheInit
  );
  assert.ok(fieldValidation >= 0);
  assert.ok(rejection > fieldValidation);
  assert.ok(cacheContext > rejection);
  assert.ok(cacheInit > cacheContext);
  assert.ok(userDownload > cacheInit);
  assert.ok(moderationDownload > cacheInit);
});

test('Pull applies all visible session stages through one synchronous commit', () => {
  const start = source.indexOf('async function pullFromGitHub');
  const end = source.indexOf('async function pushToGitHub', start);
  assert.ok(start >= 0 && end > start);
  const pull = source.slice(start, end);
  const application = pull.indexOf(
    'session.applyPulledRepositoryState({'
  );
  assert.ok(application >= 0);
  assert.doesNotMatch(
    pull,
    /session\.(?:setModerationMergesFromDoc|rebuildMergedViewFromUserFiles|setFieldAnnotated|setAnnotatableConsensusSettingsMap|setClosedAnnotatableFields|recordDatasetAccess|setRemoteFileShas|setRemoteFileSha)\(/
  );
  const precheck = pull.lastIndexOf(
    'throwIfActiveSyncAborted(opAbort);',
    application
  );
  assert.ok(precheck >= 0 && precheck < application);
  const progress = pull.indexOf(
    "updateProgress(100, { message: 'Pull complete' })",
    application
  );
  const repositoryCommit = pull.indexOf(
    '// Commit the repo connection only after a successful Pull.',
    progress
  );
  assert.ok(progress > application);
  assert.ok(repositoryCommit > progress);
  assert.doesNotMatch(
    pull.slice(application, repositoryCommit),
    /throwIfActiveSyncAborted\(opAbort\)/
  );
});

test('setup guide distinguishes validated raw-cache refresh from atomic visible application', () => {
  assert.match(
    setupGuide,
    /Validated\s+changed raw files may be committed to the scoped cache before the complete\s+cached set is re-read and compiled\./
  );
  assert.match(
    setupGuide,
    /the visible session is restored exactly:[\s\S]*publish synchronously through one\s+session transaction and one change notification\./
  );
  assert.doesNotMatch(
    setupGuide,
    /before (?:any )?cache or session mutation/
  );
});
