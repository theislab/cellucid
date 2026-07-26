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
