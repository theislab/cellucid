import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CommunityAnnotationSession,
} from '../assets/js/app/community-annotations/session.js';


function remoteUserDocument() {
  return {
    version: 1,
    username: 'ghid_7',
    githubUserId: 7,
    login: 'remote-researcher',
    displayName: 'Remote Researcher',
    updatedAt: '2026-07-30T01:02:03.456Z',
    suggestions: {
      'cell_type:Alpha': [{
        id: 'remote-suggestion',
        label: 'Remote T cell',
        proposedBy: 'ghid_7',
        proposedAt: '2026-07-30T01:02:03.456Z',
      }],
    },
    votes: {},
  };
}


function moderationDocument(merges = null) {
  return {
    version: 1,
    updatedAt: '2026-07-30T01:02:03.456Z',
    merges: merges ?? [{
      bucket: 'cell_type:Alpha',
      fromSuggestionId: 'remote-alias',
      intoSuggestionId: 'remote-suggestion',
      by: 'ghid_42',
      at: '2026-07-30T01:02:03.456Z',
    }],
  };
}

function createSession(SessionClass = CommunityAnnotationSession, ...args) {
  const session = new SessionClass(...args);
  session.setProfile({
    username: 'ghid_42',
    githubUserId: 42,
    login: 'local-researcher',
  });
  session.setFieldCategories('cell_type', ['Alpha']);
  session.setFieldCategories('batch', ['One']);
  session.setFieldAnnotated('batch', true);
  session.setFieldClosed('batch', true);
  const localSuggestionId = session.addSuggestion(
    'cell_type',
    0,
    { label: 'Unpublished local T cell' }
  );
  return { session, localSuggestionId };
}


function pulledStateOptions(overrides = {}) {
  return {
    remoteUserDocs: [remoteUserDocument()],
    moderationDocument: moderationDocument(),
    categoricalFieldKeys: ['cell_type', 'batch'],
    fieldsToAnnotate: ['cell_type'],
    annotatableSettings: {
      cell_type: { minAnnotators: 2, threshold: 0.75 },
    },
    closedFields: ['cell_type'],
    datasetId: 'synthetic',
    remoteFileShas: {
      'annotations/users/ghid_7.json': 'a'.repeat(40),
      'annotations/config.json': 'b'.repeat(40),
      'annotations/moderation/merges.json': 'c'.repeat(40),
    },
    ...overrides,
  };
}


function clearPendingSave(session) {
  if (session._saveTimer !== null) clearTimeout(session._saveTimer);
  session._saveTimer = null;
}

test('Pull prevalidates both raw field inventories before opening its transaction', () => {
  for (const { label, overrides } of [
    {
      label: 'categoricalFieldKeys',
      overrides: {
        categoricalFieldKeys: ['cell_type', 'fk~foo%3Abar'],
      },
    },
    {
      label: 'fieldsToAnnotate',
      overrides: {
        categoricalFieldKeys: ['cell_type'],
        fieldsToAnnotate: ['fk~foo%3Abar'],
        annotatableSettings: {},
        closedFields: [],
      },
    },
  ]) {
    let transactionEntries = 0;
    class TransactionProbeSession extends CommunityAnnotationSession {
      _runPulledRepositoryStateTransaction(...args) {
        transactionEntries += 1;
        return super._runPulledRepositoryStateTransaction(...args);
      }
    }

    const { session } = createSession(TransactionProbeSession);
    clearPendingSave(session);
    const beforeSnapshot = session.getStateSnapshot();
    const beforeProfile = session.getProfile();
    const beforeAccess = session.getDatasetAccessMap();
    const beforeSettings = session.getAnnotatableConsensusSettingsMap();
    const beforeClosed = session.getClosedAnnotatableFields();
    const beforeMerges = session.getModerationMerges();
    const beforeShas = session.getRemoteFileShas();
    let changes = 0;
    session.on('changed', () => {
      changes += 1;
    });

    assert.throws(
      () => session.applyPulledRepositoryState(
        pulledStateOptions(overrides)
      ),
      /reserved.*field-key|field.*reserved/i,
      label
    );
    assert.equal(transactionEntries, 0, `${label} must fail pre-transaction`);
    assert.deepEqual(session.getStateSnapshot(), beforeSnapshot);
    assert.deepEqual(session.getProfile(), beforeProfile);
    assert.deepEqual(session.getDatasetAccessMap(), beforeAccess);
    assert.deepEqual(
      session.getAnnotatableConsensusSettingsMap(),
      beforeSettings
    );
    assert.deepEqual(session.getClosedAnnotatableFields(), beforeClosed);
    assert.deepEqual(session.getModerationMerges(), beforeMerges);
    assert.deepEqual(session.getRemoteFileShas(), beforeShas);
    assert.equal(
      Object.hasOwn(session.getDatasetAccessMap(), 'synthetic'),
      false
    );
    assert.equal(session.getKnownUserProfile('ghid_7'), null);
    assert.equal(changes, 0);
    assert.equal(session._saveTimer, null);
  }
});

test('Pull accepts colon-bearing fields and every safe reserved-prefix lookalike', () => {
  for (const fieldKey of [
    'foo:bar',
    'fk~foo',
    'FK~foo%3Abar',
    'plain%3Afoo',
    'fk~foo%253Abar',
    'fk~literal%3A:real-colon',
  ]) {
    const { session } = createSession();
    session.setFieldCategories(fieldKey, ['Category:with:colon']);
    clearPendingSave(session);

    assert.equal(
      session.applyPulledRepositoryState(pulledStateOptions({
        remoteUserDocs: [],
        moderationDocument: null,
        categoricalFieldKeys: ['cell_type', 'batch', fieldKey],
        fieldsToAnnotate: [fieldKey],
        annotatableSettings: {
          [fieldKey]: { minAnnotators: 1, threshold: 0.5 },
        },
        closedFields: [],
        remoteFileShas: {
          'annotations/config.json': 'd'.repeat(40),
        },
      })),
      true,
      fieldKey
    );
    assert.deepEqual(session.getAnnotatedFields(), [fieldKey]);
    assert.deepEqual(
      session.getDatasetAccessMap().synthetic.fieldsToAnnotate,
      [fieldKey]
    );
    clearPendingSave(session);
  }
});


test('failed complete Pull application restores prior visible state and emits or schedules nothing', () => {
  const { session, localSuggestionId } = createSession();
  clearPendingSave(session);
  const before = session.getStateSnapshot();
  const visibleSnapshots = [];
  session.on('changed', () => {
    visibleSnapshots.push(session.getStateSnapshot());
  });

  assert.throws(
    () => session.applyPulledRepositoryState(pulledStateOptions({
      remoteFileShas: {
        'annotations/users/ghid_7.json': 'not-a-git-sha',
      },
    })),
    /invalid path or SHA/
  );

  assert.deepEqual(session.getStateSnapshot(), before);
  assert.equal(session.getKnownUserProfile('ghid_7'), null);
  assert.deepEqual(session.getModerationMerges(), []);
  assert.equal(
    session.getSuggestions('cell_type', 0)
      .some(({ id }) => id === localSuggestionId),
    true
  );
  assert.deepEqual(visibleSnapshots, []);
  assert.equal(session._saveTimer, null);
});


test('abort after complete-set rebuild rolls back before publishing any session stage', () => {
  const abortController = new AbortController();
  class AbortAfterRebuildSession extends CommunityAnnotationSession {
    rebuildMergedViewFromUserFiles(...args) {
      const result = super.rebuildMergedViewFromUserFiles(...args);
      abortController.abort(new Error('Synthetic abort after rebuild'));
      return result;
    }
  }

  const { session } = createSession(AbortAfterRebuildSession);
  clearPendingSave(session);
  const before = session.getStateSnapshot();
  let changes = 0;
  session.on('changed', () => {
    changes += 1;
  });

  assert.throws(
    () => session.applyPulledRepositoryState(pulledStateOptions({
      signal: abortController.signal,
    })),
    /Synthetic abort after rebuild/
  );

  assert.deepEqual(session.getStateSnapshot(), before);
  assert.equal(session.getKnownUserProfile('ghid_7'), null);
  assert.equal(changes, 0);
  assert.equal(session._saveTimer, null);
});


test('successful Pull application publishes the whole new session through one change', () => {
  const { session, localSuggestionId } = createSession();
  clearPendingSave(session);
  const visibleSnapshots = [];
  session.on('changed', () => {
    visibleSnapshots.push(session.getStateSnapshot());
  });

  assert.equal(
    session.applyPulledRepositoryState(pulledStateOptions()),
    true
  );

  assert.equal(visibleSnapshots.length, 1);
  assert.deepEqual(visibleSnapshots[0], session.getStateSnapshot());
  assert.deepEqual(session.getAnnotatedFields(), ['cell_type']);
  assert.deepEqual(session.getClosedAnnotatableFields(), ['cell_type']);
  assert.deepEqual(
    session.getAnnotatableConsensusSettingsMap(),
    { cell_type: { minAnnotators: 2, threshold: 0.75 } }
  );
  assert.deepEqual(session.getModerationMerges(), moderationDocument().merges);
  assert.deepEqual(
    session.getRemoteFileShas(),
    pulledStateOptions().remoteFileShas
  );
  assert.deepEqual(
    session.getDatasetAccessMap().synthetic.fieldsToAnnotate,
    ['cell_type']
  );
  const suggestions = session.getSuggestions('cell_type', 0);
  assert.equal(
    suggestions.some(({ id }) => id === localSuggestionId),
    true,
    'unpublished local intent must survive the rebuilt remote view'
  );
  assert.equal(
    suggestions.some(({ id }) => id === 'remote-suggestion'),
    true
  );
  assert.deepEqual(
    session.getKnownUserProfile('ghid_7'),
    {
      login: 'remote-researcher',
      displayName: 'Remote Researcher',
      title: '',
      orcid: '',
      linkedin: '',
    }
  );
  clearPendingSave(session);
});


test('Pull application preserves pre-existing local moderation intent', () => {
  const { session } = createSession();
  clearPendingSave(session);
  session.addModerationMerge({
    fieldKey: 'cell_type',
    catIdx: 0,
    fromSuggestionId: 'local-alias',
    intoSuggestionId: 'local-target',
    note: 'Unpublished local merge',
  });
  const localMerges = session.getModerationMerges();
  session.applyPulledRepositoryState(pulledStateOptions());
  assert.deepEqual(session.getModerationMerges(), localMerges);
  clearPendingSave(session);
});


test('committed Pull ignores observer failure and a reentrant final abort', () => {
  const { session } = createSession();
  clearPendingSave(session);
  const controller = new AbortController();
  const listenerFailure = new Error('Synthetic session observer failure');
  const reported = [];
  const previousReportError = globalThis.reportError;
  globalThis.reportError = (error) => reported.push(error);
  let laterListenerState = null;
  session.on('changed', () => {
    controller.abort(new Error('Abort from committed-state observer'));
    throw listenerFailure;
  });
  session.on('changed', () => {
    laterListenerState = session.getStateSnapshot();
  });

  try {
    assert.equal(
      session.applyPulledRepositoryState(pulledStateOptions({
        signal: controller.signal,
      })),
      true
    );
    assert.equal(reported.length, 1);
    assert.equal(reported[0], listenerFailure);
    assert.deepEqual(laterListenerState, session.getStateSnapshot());
    assert.equal(controller.signal.aborted, true);
  } finally {
    if (previousReportError === undefined) delete globalThis.reportError;
    else globalThis.reportError = previousReportError;
    clearPendingSave(session);
  }
});
