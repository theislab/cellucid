import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertAutoPullIntervalMs,
  autoPullIntervalFromSelectValue,
  parseAutoPullPreferences,
  serializeAutoPullPreferences,
} from '../assets/js/app/community-annotations/auto-pull-preferences.js';
import {
  toCacheScopeKey,
} from '../assets/js/app/community-annotations/cache-scope.js';


const scopeKey = toCacheScopeKey({
  datasetId: 'synthetic',
  repoRef: 'owner/repo@main',
  userId: 42,
});


test('auto-pull preferences round-trip one exact cache-scoped contract', () => {
  const preferences = {
    [scopeKey]: {
      enabled: true,
      intervalMs: 900_000,
    },
  };
  assert.deepEqual(
    parseAutoPullPreferences(serializeAutoPullPreferences(preferences)),
    preferences
  );
  assert.equal(assertAutoPullIntervalMs(600_000), 600_000);
  assert.equal(autoPullIntervalFromSelectValue('3600000'), 3_600_000);
});


test('auto-pull preferences reject coercion, repair, and duplicate keys', () => {
  for (const entry of [
    { enabled: 1, intervalMs: 600_000 },
    { enabled: true, intervalMs: '600000' },
    { enabled: true, intervalMs: 60_000 },
    { enabled: true, intervalMs: 600_000, legacy: true },
  ]) {
    assert.throws(
      () => serializeAutoPullPreferences({ [scopeKey]: entry }),
      /Auto-pull/
    );
  }
  assert.throws(
    () => serializeAutoPullPreferences({
      'synthetic|owner%2Frepo|main|042': {
        enabled: true,
        intervalMs: 600_000,
      },
    }),
    /canonical/
  );
  assert.throws(
    () => parseAutoPullPreferences(
      `{"${scopeKey}":{"enabled":true,"enabled":false,"intervalMs":600000}}`
    ),
    /duplicate JSON object key/
  );
  assert.throws(() => autoPullIntervalFromSelectValue(600_000), /string/);
});
