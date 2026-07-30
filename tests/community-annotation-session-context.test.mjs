import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CommunityAnnotationSession,
} from '../assets/js/app/community-annotations/session.js';
import {
  toSessionStorageKey,
} from '../assets/js/app/community-annotations/cache-scope.js';

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      const exactKey = String(key);
      return values.has(exactKey) ? values.get(exactKey) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    },
  };
}

test(
  'an empty authenticated scope is valid to synchronous listeners and cancels the prior scope save',
  () => {
    const previousLocalStorage = globalThis.localStorage;
    const previousSessionStorage = globalThis.sessionStorage;
    const storage = createMemoryStorage();
    globalThis.localStorage = storage;
    globalThis.sessionStorage = storage;

    const firstScope = {
      datasetId: 'scope-transition',
      repoRef: 'owner/first@main',
      userId: 42,
    };
    const secondScope = {
      datasetId: 'scope-transition',
      repoRef: 'owner/second@main',
      userId: 42,
    };
    const session = new CommunityAnnotationSession();
    const synchronousProfiles = [];
    let integrityErrors = 0;
    try {
      session.setCacheContext(firstScope);
      session.setProfile({
        username: 'ghid_42',
        login: 'researcher',
        githubUserId: 42,
        displayName: 'Repo-scoped profile',
      });
      assert.notEqual(session._saveTimer, null);

      session.on('integrity:error', () => {
        integrityErrors += 1;
      });
      session.on('changed', ({ reason }) => {
        if (
          reason !== 'load' ||
          session.getRepoRef() !== secondScope.repoRef
        ) {
          return;
        }
        synchronousProfiles.push(session.getProfile());
        session._saveNow();
      });

      assert.doesNotThrow(() => session.setCacheContext(secondScope));
      assert.equal(session._saveTimer, null);
      assert.equal(integrityErrors, 0);
      assert.deepEqual(synchronousProfiles, [{
        username: 'ghid_42',
        login: '',
        githubUserId: 42,
        displayName: '',
        title: '',
        orcid: '',
        linkedin: '',
      }]);

      const firstPersisted = JSON.parse(
        storage.getItem(toSessionStorageKey(firstScope))
      );
      const secondPersisted = JSON.parse(
        storage.getItem(toSessionStorageKey(secondScope))
      );
      assert.equal(firstPersisted.profile.displayName, 'Repo-scoped profile');
      assert.deepEqual(secondPersisted.profile, synchronousProfiles[0]);
    } finally {
      if (session._saveTimer !== null) {
        clearTimeout(session._saveTimer);
      }
      session._scopeLock.release();
      if (previousLocalStorage === undefined) {
        delete globalThis.localStorage;
      } else {
        globalThis.localStorage = previousLocalStorage;
      }
      if (previousSessionStorage === undefined) {
        delete globalThis.sessionStorage;
      } else {
        globalThis.sessionStorage = previousSessionStorage;
      }
    }
  }
);
