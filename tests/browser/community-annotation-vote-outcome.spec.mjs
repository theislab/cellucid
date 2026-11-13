/**
 * A vote or a new suggestion the session refuses must be visible to the
 * person who made it.
 *
 * It is exercised through the real voting modal in a real DOM. GitHub is
 * mocked exactly as the rest of the community annotation browser suite mocks
 * it — the local-dev simulate flags plus a synthetic session in
 * `sessionStorage` — so no external repository or account is contacted.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const PREPARED_DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}` +
  '&dataset=current-ui&acceptance=vote-outcome-ci';

const FIELD_KEY = 'vote_outcome_field';

async function prepareVotingHarness(page) {
  await page.evaluate(async fieldKey => {
    const { getCommunityAnnotationSession } = await import(
      '/assets/js/app/community-annotations/session.js'
    );
    const { openCommunityAnnotationVotingModal } = await import(
      '/assets/js/app/ui/modules/community-annotation-voting-modal.js'
    );
    const session = getCommunityAnnotationSession();
    session.setProfile({
      username: 'ghid_42',
      githubUserId: 42,
      login: 'vote-outcome-tester',
      displayName: 'Vote outcome tester',
      title: '',
      orcid: '',
      linkedin: '',
    });
    session.setFieldCategories(fieldKey, ['B cell', 'T cell', 'NK cell']);
    if (!session.getSuggestions(fieldKey, 1).length) {
      session.addSuggestion(fieldKey, 1, { label: 'CD8 T cell' });
      session.addSuggestion(fieldKey, 1, { label: 'CD4 T cell' });
    }
    const field = {
      _isDeleted: false,
      categories: ['B cell', 'T cell', 'NK cell'],
      key: fieldKey,
      kind: 'category',
      loaded: true,
    };
    const state = {
      async ensureFieldLoaded() {},
      getFields() {
        return [field];
      },
    };
    const modal = openCommunityAnnotationVotingModal({
      defaultCatIdx: 1,
      defaultFieldKey: fieldKey,
      state,
    });
    if (modal === null) throw new Error('vote outcome harness did not open');
    window.__voteOutcomeModal = modal;
  }, FIELD_KEY);
  await expect(
    page.locator('.community-annotation-voting-detail')
  ).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window._simulate_repo_connected = true;
    window._author_mode = true;
    sessionStorage.setItem(
      'cellucid:github-app-auth:session',
      JSON.stringify({
        token: 'vote-outcome-contract-token',
        user: { id: 42, login: 'vote-outcome-tester' },
      })
    );
  });
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture'
  );
  await prepareVotingHarness(page);
});

/** Error notices only — the app posts progress and success notices of its own. */
function errorNotices(page) {
  return page.locator('#notification-center .notification-error .notification-message');
}

/**
 * Address a vote button by the suggestion it belongs to. Cards re-sort by net
 * score on every render, so positional selectors silently follow a different
 * suggestion after a vote lands.
 */
function voteButton(page, label, direction) {
  const verb = direction === 'up' ? 'Upvote' : 'Downvote';
  return page.locator(
    `.community-annotation-vote-btn.vote-${direction}` +
    `[aria-label^="${verb} ${label};"]`
  );
}

test('a category list replaced under an open dialog refuses a vote and a new suggestion, and says so', async ({
  page,
}) => {
  await test.step('a vote the session refuses tells the person who cast it', async () => {
    // Another module re-registers this field's categories with one removed, the
    // way `ui/modules/legend/categorical-legend.js` does on every legend render.
    // Index 1 now names 'NK cell', so the rendered 'T cell' cards vote into a
    // bucket that no longer holds them. `setFieldCategories()` emits nothing, so
    // nothing re-renders and the buttons stay live.
    const rerouted = await page.evaluate(async fieldKey => {
      const { getCommunityAnnotationSession } = await import(
        '/assets/js/app/community-annotations/session.js'
      );
      const session = getCommunityAnnotationSession();
      let changedEvents = 0;
      const stop = session.on('changed', () => { changedEvents += 1; });
      session.setFieldCategories(fieldKey, ['B cell', 'NK cell']);
      stop();
      return { changedEvents };
    }, FIELD_KEY);
    expect(rerouted.changedEvents).toBe(0);

    const cards = page.locator('.community-annotation-suggestion-card');
    await expect(cards.first()).toBeVisible();
    const cardCountBefore = await cards.count();
    await expect(errorNotices(page)).toHaveCount(0);

    await voteButton(page, 'CD8 T cell', 'down').click();

    await expect(errorNotices(page)).toHaveCount(1);
    await expect(errorNotices(page)).toContainText('Vote not recorded');
    await expect(errorNotices(page)).toContainText(
      'Close and reopen community voting'
    );

    // The card really did nothing: no state moved, so nothing re-rendered.
    await expect(cards).toHaveCount(cardCountBefore);
    await expect(voteButton(page, 'CD8 T cell', 'down')).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    await expect(voteButton(page, 'CD8 T cell', 'up')).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    // The person reads the notice and dismisses it; the next step has its own.
    await page
      .locator('#notification-center .notification-error .notification-dismiss')
      .click();
    await expect(errorNotices(page)).toHaveCount(0);
  });

  await test.step('a rerouted category refuses a new suggestion instead of misfiling it', async () => {
    // The category list is still the replaced one.
    // Address the New suggestion form by its stable focus identity: every
    // suggestion card also carries a hidden edit form with the same classes.
    const newSuggestion = suffix => page.locator(
      '[data-community-modal-focus-key^=\'["new-suggestion"\']' +
      `[data-community-modal-focus-key$=":${suffix}"]`
    );
    await expect(newSuggestion('label')).toBeVisible();
    await newSuggestion('label').fill('Should never be filed');
    await newSuggestion('add').click();

    await expect(errorNotices(page)).toContainText('Suggestion not added');

    const filed = await page.evaluate(async fieldKey => {
      const { getCommunityAnnotationSession } = await import(
        '/assets/js/app/community-annotations/session.js'
      );
      const session = getCommunityAnnotationSession();
      return {
        nk: session.getSuggestions(fieldKey, 'NK cell').map(s => s.label),
        t: session.getSuggestions(fieldKey, 'T cell').map(s => s.label),
      };
    }, FIELD_KEY);
    expect(filed.nk).toEqual([]);
    expect(filed.t.sort()).toEqual(['CD4 T cell', 'CD8 T cell']);
  });
});
