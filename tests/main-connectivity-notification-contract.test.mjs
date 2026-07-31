import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const mainSource = fs.readFileSync(
  new URL('../assets/js/app/main.js', import.meta.url),
  'utf8'
);

test('KNN absence uses the exact current warning notification API', () => {
  assert.match(
    mainSource,
    /setKnnEdgeLoadCallback\(\(\) => \{[\s\S]*?connectivityManifest === null[\s\S]*?notifications\.warning\([\s\S]*?No neighbor graph available for this dataset/
  );
  assert.doesNotMatch(mainSource, /notifications\.warn\(/);
});

test('KNN absence is announced once per dataset generation', () => {
  // The renderer calls back on every KNN mode entry and every Alt+drag, so the
  // absent-capability announcement must be latched, and the latch must be
  // keyed to the publication generation so the next dataset arms it again.
  // Behaviour is covered by tests/browser/knn-missing-connectivity-warning
  // .spec.mjs; this keeps the fast suite from losing the structure silently.
  const guarded = mainSource.match(
    /setKnnEdgeLoadCallback\(\(\) => \{\s*if \(connectivityManifest === null\) \{([\s\S]*?)\n {10}return;/
  );
  assert.notEqual(guarded, null, 'KNN absence guard was not found in main.js');
  const branch = guarded[1];
  assert.match(
    branch,
    /if \(\s*announcedMissingConnectivityGeneration !==\s*datasetPublicationGeneration\s*\) \{\s*announcedMissingConnectivityGeneration =\s*datasetPublicationGeneration;/,
    'the absence branch must latch the publication generation before it warns'
  );
  const latchIndex = branch.indexOf('announcedMissingConnectivityGeneration =');
  const warningIndex = branch.indexOf('notifications.warning(');
  assert.ok(
    latchIndex >= 0 && warningIndex > latchIndex,
    'the latch must be written before the warning is published'
  );
  assert.match(
    mainSource,
    /let announcedMissingConnectivityGeneration = null;/,
    'the latch must start unannounced'
  );
});
