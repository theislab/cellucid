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

test('a pending debounced save is written when the page is hidden or unloaded', () => {
  const previous = {
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    window: globalThis.window,
    document: globalThis.document,
  };
  const storage = createMemoryStorage();
  const windowListeners = new Map();
  const documentListeners = new Map();
  const addTo = registry => (type, listener) => {
    if (!registry.has(type)) registry.set(type, []);
    registry.get(type).push(listener);
  };
  globalThis.localStorage = storage;
  globalThis.sessionStorage = storage;
  globalThis.window = {
    addEventListener: addTo(windowListeners),
    removeEventListener(type, listener) {
      const list = windowListeners.get(type) ?? [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    },
  };
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: addTo(documentListeners),
    removeEventListener() {},
  };
  const scope = {
    datasetId: 'flush-on-hide',
    repoRef: 'owner/repo@main',
    userId: 42,
  };
  const key = toSessionStorageKey(scope);
  const session = new CommunityAnnotationSession();
  try {
    session.setCacheContext(scope);
    const profile = displayName => session.setProfile({
      username: 'ghid_42',
      login: 'researcher',
      githubUserId: 42,
      displayName,
    });
    const persistedName = () =>
      JSON.parse(storage.getItem(key)).profile.displayName;

    profile('Before hide');
    assert.notEqual(session._saveTimer, null);
    globalThis.document.visibilityState = 'hidden';
    for (const listener of documentListeners.get('visibilitychange')) listener();
    assert.equal(session._saveTimer, null);
    assert.equal(persistedName(), 'Before hide');

    globalThis.document.visibilityState = 'visible';
    profile('Before unload');
    assert.notEqual(session._saveTimer, null);
    // The session's listener precedes the scope lock's release listener, so
    // the write still holds the lock it requires.
    const pagehide = windowListeners.get('pagehide');
    assert.ok(pagehide.length >= 2);
    for (const listener of [...pagehide]) listener();
    assert.equal(session._saveTimer, null);
    assert.equal(persistedName(), 'Before unload');
    assert.equal(session._scopeLock.getScopeKey(), null);
  } finally {
    if (session._saveTimer !== null) clearTimeout(session._saveTimer);
    session._scopeLock.release();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
});
