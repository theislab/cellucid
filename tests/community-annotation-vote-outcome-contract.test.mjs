/**
 * `session.vote()` reports `false` when the vote could not be recorded. This
 * pins both halves of that contract: that the failure is reachable from a
 * rendered card (so it may not be ignored), and that the voting modal consumes
 * the outcome instead of discarding it.
 *
 * The reachable case is not only "a Pull deleted the suggestion". The card
 * carries a *numeric* `catIdx`, which `vote()` resolves late against
 * `_categoriesByFieldKey` — registration state that other modules
 * (`ui/modules/legend/categorical-legend.js`, `community-annotation/
 * consensus-column.js`) overwrite through `setFieldCategories()`, which
 * deliberately emits no `changed` event. So the bucket a card votes into can
 * move with no re-render and no lifecycle invalidation at all: the button
 * stays live and every click is discarded.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CommunityAnnotationSession,
} from '../assets/js/app/community-annotations/session.js';

const VOTING_MODAL = fileURLToPath(new URL(
  '../assets/js/app/ui/modules/community-annotation-voting-modal.js',
  import.meta.url
));

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

function withStorage(run) {
  const previousLocalStorage = globalThis.localStorage;
  const previousSessionStorage = globalThis.sessionStorage;
  const storage = createMemoryStorage();
  globalThis.localStorage = storage;
  globalThis.sessionStorage = storage;
  try {
    return run();
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
}

function connectedSession() {
  const session = new CommunityAnnotationSession();
  session.setCacheContext({
    datasetId: 'vote-outcome-dataset',
    repoRef: 'owner/repo@main',
    userId: 42,
  });
  session.setProfile({
    username: 'ghid_42',
    login: 'voter',
    githubUserId: 42,
  });
  return session;
}

test(
  'a category re-registration reroutes a rendered card and silently discards its vote',
  () => {
    withStorage(() => {
      const session = connectedSession();
      session.setFieldCategories('cell_type', ['B cell', 'T cell', 'NK cell']);
      const suggestionId = session.addSuggestion('cell_type', 1, {
        label: 'CD8 T cell',
      });

      // Baseline: the card at index 1 votes into the bucket it rendered from.
      assert.equal(session.vote('cell_type', 1, suggestionId, 'down'), true);
      assert.equal(
        session.getMyVoteDirect('cell_type', 'T cell', suggestionId),
        'down'
      );

      let changedEvents = 0;
      session.on('changed', () => { changedEvents += 1; });

      // Another module re-registers this field's categories with one removed,
      // so index 1 now names 'NK cell'. This is registration, not annotation
      // state, so it emits nothing — which is exactly why the modal that is
      // showing 'T cell' cards never learns that its index moved.
      session.setFieldCategories('cell_type', ['B cell', 'NK cell']);
      assert.equal(
        changedEvents,
        0,
        'setFieldCategories must stay silent; a re-render would mask the defect'
      );

      // The rendered card still carries (fieldKey, 1, suggestionId).
      assert.equal(session.vote('cell_type', 1, suggestionId, 'up'), false);

      // Proof it was a no-op rather than a partial write.
      assert.equal(changedEvents, 0);
      assert.equal(
        session.getMyVoteDirect('cell_type', 'T cell', suggestionId),
        'down'
      );
      assert.equal(
        session.getMyVoteDirect('cell_type', 'NK cell', suggestionId),
        null
      );
    });
  }
);

test('a vote on a suggestion removed since render is refused, not partially applied', () => {
  withStorage(() => {
    const session = connectedSession();
    session.setFieldCategories('cell_type', ['T cell']);
    const keptId = session.addSuggestion('cell_type', 0, { label: 'Kept' });
    const removedId = session.addSuggestion('cell_type', 0, {
      label: 'Removed by a Pull',
    });
    assert.equal(session.deleteMySuggestion('cell_type', 0, removedId), true);

    assert.equal(session.vote('cell_type', 0, removedId, 'up'), false);
    assert.equal(session.vote('cell_type', 0, keptId, 'up'), true);
  });
});

test(
  'a rerouted category would file a new suggestion under a cluster nobody chose',
  () => {
    withStorage(() => {
      const session = connectedSession();
      session.setFieldCategories('cell_type', ['B cell', 'T cell', 'NK cell']);
      session.addSuggestion('cell_type', 1, { label: 'CD8 T cell' });

      session.setFieldCategories('cell_type', ['B cell', 'NK cell']);

      // Unlike every id-based mutation, creation cannot fail to find anything.
      // It succeeds against whichever bucket the position now names, which is
      // why the voting panel pins its bucket at render time and refuses.
      session.addSuggestion('cell_type', 1, { label: 'Filed by position' });
      assert.deepEqual(
        session.getSuggestions('cell_type', 'NK cell').map(s => s.label),
        ['Filed by position'],
        'the session resolves the position, so the UI owns the invariant that ' +
        'a panel mutates the bucket it rendered'
      );
      assert.deepEqual(
        session.getSuggestions('cell_type', 'T cell').map(s => s.label),
        ['CD8 T cell']
      );
    });
  }
);

test('the voting panel refuses to create against a bucket it did not render', () => {
  const source = readFileSync(VOTING_MODAL, 'utf8');
  assert.match(
    source,
    /const renderedBucket = bucketKey\(session, fieldKey, catIdx\);/,
    'the detail panel must pin the bucket it rendered'
  );
  const addHandler = source.slice(
    source.indexOf("addBtn.addEventListener('click'"),
    source.indexOf('session.addSuggestion(')
  );
  assert.ok(
    addHandler.length > 0 && addHandler.length < 1200,
    'the add handler should have been located, not guessed'
  );
  assert.match(
    addHandler,
    /if \(!rendersCurrentBucket\(\)\) \{/,
    'creating a suggestion must be refused when the rendered bucket moved; ' +
    'unlike the id-based mutations, creation cannot fail on its own'
  );
  assert.match(
    addHandler,
    /Suggestion not added: the categories of this field changed/,
    'the refusal must say what happened and what to do next'
  );
});

test('every voting-modal vote call site consumes the recorded outcome', () => {
  const source = readFileSync(VOTING_MODAL, 'utf8');
  const lines = source.split('\n');
  const callSites = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes('session.vote(')) {
      callSites.push({ line: index + 1, text: lines[index] });
    }
  }
  assert.ok(
    callSites.length > 0,
    'the voting modal must still cast votes through session.vote()'
  );

  const discarded = callSites.filter(site => /^\s*session\.vote\(/.test(site.text));
  assert.deepEqual(
    discarded,
    [],
    'session.vote() returns false when the vote was refused; a call site that ' +
    'drops that value leaves a live-looking button discarding every click'
  );

  assert.match(
    source,
    /Vote not recorded: this suggestion is no longer part of the/,
    'a refused vote must tell the user it was refused and what to do next'
  );
});
