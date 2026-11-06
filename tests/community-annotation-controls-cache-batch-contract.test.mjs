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

test('a Pull reads changed files into the cache by batch and folds the cache as it streams', () => {
  const start = source.indexOf('async function pullFromGitHub');
  const end = source.indexOf('async function pushToGitHub', start);
  assert.ok(start >= 0 && end > start);
  const pull = source.slice(start, end);
  // The files are read and cached by the sync (`pullFiles`), batch by batch;
  // the controls never hold them.
  assert.equal([...pull.matchAll(/sync\.pullFiles\(\{/g)].length, 1);
  assert.match(pull, /sync\.pullFiles\(\{[\s\S]*?fileCache,[\s\S]*?cacheScope,[\s\S]*?signal: opAbort\.signal/);
  assert.doesNotMatch(pull, /setManyJson|getKnownShas|getAllJsonForRepo/);
  // The merge input is folded from one cache cursor, never collected first.
  assert.match(pull, /const remoteUserFiles = session\.createRemoteUserFiles\(\);/);
  assert.match(pull, /foldCachedFiles\(\{ fileCache, cacheScope, remoteUserFiles \}\)/);
  assert.match(pull, /session\.applyPulledRepositoryState\(\{\s*remoteUserFiles,/);
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
  const fileDownload = pull.indexOf('sync.pullFiles({', cacheInit);
  assert.ok(fieldValidation >= 0);
  assert.ok(rejection > fieldValidation);
  assert.ok(cacheContext > rejection);
  assert.ok(cacheInit > cacheContext);
  assert.ok(fileDownload > cacheInit);
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

test('a Pull reports what it left out once, with the files and reasons under Details', () => {
  const report = source.slice(
    source.indexOf('function reportPullExclusions('),
    source.indexOf('async function pullFromGitHub')
  );
  assert.match(report, /if \(quiet && signature === lastReportedExclusions\) return;/);
  assert.match(report, /Your published file \$\{ownPath\} is not a valid annotation file[\s\S]*?Publish will not overwrite it/);
  assert.match(report, /notifications\.warning\(lines\.join\('\\n'\), \{[\s\S]*?details: \[\.\.\.excluded, \.\.\.ignored\]/);
  const pull = source.slice(source.indexOf('async function pullExclusive'), source.indexOf('async function pushToGitHub'));
  assert.match(pull, /reportPullExclusions\(\{\s*excluded,\s*ignored: filesResult\.ignored,/);
  assert.match(pull, /excluded: lastAppliedPull\?\.excluded \?\? \[\]/);
});

test('an unchanged Pull folds nothing again only while the session still holds that Pull', () => {
  const pull = source.slice(source.indexOf('async function pullExclusive'), source.indexOf('async function pushToGitHub'));
  assert.match(
    pull,
    /filesResult\.unchanged &&\s*lastAppliedPull !== null &&\s*lastAppliedPull\.key === appliedKey &&\s*lastAppliedPull\.identity === entryOwner\.identity &&\s*JSON\.stringify\(session\.getRemoteFileShas\(\)\) === JSON\.stringify\(pulledFileShas\)/
  );
  // The session keeps only the SHAs it publishes onto: config, merges, its own file.
  assert.match(pull, /const pulledFileShas = \{ 'annotations\/config\.json': configSha \};/);
  assert.doesNotMatch(pull, /remoteUserShas/);
});

test('a Pull can be cancelled from its progress, and a failure that may pass keeps the connection', () => {
  const pull = source.slice(source.indexOf('async function pullExclusive'), source.indexOf('async function pushToGitHub'));
  assert.match(pull, /notifications\.progress\([\s\S]*?onCancel: \(\) => \{[\s\S]*?abortActiveSync\(/);
  assert.match(pull, /onWait: \(wait\) => updateProgress\(progressPct, \{ message: wait === null \? progressMessage : wait\.text \}\)/);
  for (const flow of [pull, source.slice(source.indexOf('async function publishExclusive'))]) {
    // A failure that may pass, or a sign-in GitHub refused, keeps the repository.
    assert.match(flow, /!isTransientRoleResolutionFailure\(err\) &&\s*!isTokenAuthFailure\(err\) &&\s*\(access\.getRole\?\.\(\) \|\| 'unknown'\) === 'unknown'/);
    assert.doesNotMatch(flow, /statusCode === 30[1278]/, 'no dead redirect branches: the Worker never relays a 3xx');
  }
  // A role resolution that may pass is asked again after the shared back-off
  // (the Worker link's retransmission timeout, doubled, at most RFC 6298's
  // 60 s), never a second copy of the retry rules nor an attempt cap.
  assert.doesNotMatch(source, /roleRetryDelay|maxRetryAfterMs|roleRetryDelaysMs|exhausted/);
  const retry = source.slice(source.indexOf('function scheduleTransientRoleRetry('), source.indexOf('function retryConnectedRoleImmediately('));
  assert.match(retry, /Math\.min\(MAX_QUIET_MS, retryWaitMs\(attempt, link\.timeoutMs\)\)/);
});
