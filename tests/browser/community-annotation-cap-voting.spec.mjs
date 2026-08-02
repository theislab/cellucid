import { expect, test } from '@playwright/test';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const PREPARED_DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=cap-voting-ci`;

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      errors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return errors;
}

async function prepareVotingHarness(page, { suggestionCount = 27 } = {}) {
  await page.evaluate(async count => {
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
      login: 'cap-voting-tester',
      displayName: 'CAP voting tester',
      title: '',
      orcid: '',
      linkedin: '',
    });
    const fieldKey = 'cap_contract_field';
    session.setFieldCategories(fieldKey, ['Cluster']);
    const existing = session.getSuggestions(fieldKey, 0);
    if (!existing.length) {
      for (let index = 0; index < count; index += 1) {
        session.addSuggestion(fieldKey, 0, {
          label: `Contract label ${String(index).padStart(3, '0')}`,
          evidence:
            index === 0
              ? 'Long evidence '.repeat(30).trim()
              : null,
          markers:
            index === 0
              ? [{ gene: 'STAT1', logFC: 2.5, pval: 0.001 }]
              : null,
        });
      }
    }
    const firstSuggestion = session.getSuggestions(fieldKey, 0)[0];
    if (
      firstSuggestion &&
      session.getComments(fieldKey, 0, firstSuggestion.id).length === 0
    ) {
      for (let index = 0; index < 31; index += 1) {
        session.addComment(
          fieldKey,
          0,
          firstSuggestion.id,
          `Contract comment ${String(index).padStart(2, '0')}`
        );
      }
    }
    const field = {
      _isDeleted: false,
      categories: ['Cluster'],
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
    const openingContext = {
      datasetId: session.getDatasetId(),
      repoRef: session.getRepoRef(),
      userId: session.getCacheUserId(),
    };
    const open = () => {
      const modal = openCommunityAnnotationVotingModal({
        defaultCatIdx: 0,
        defaultFieldKey: fieldKey,
        state,
      });
      window.__capVotingModal = modal;
      return modal !== null;
    };
    window.__capVotingHarness = {
      fieldKey,
      open,
      openingContext,
    };
    window.__capVotingBackgroundSnapshot = [...document.body.children].map(
      element => ({
        element,
        parent: element.parentNode,
        nextSibling: element.nextSibling,
        hadAriaHidden: element.hasAttribute('aria-hidden'),
        ariaHidden: element.getAttribute('aria-hidden'),
        hadInert: element.hasAttribute('inert'),
        inert: element.getAttribute('inert'),
      })
    );
    if (!open()) throw new Error('CAP voting harness did not open');
  }, suggestionCount);
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
        token: 'browser-contract-token',
        user: { id: 42, login: 'cap-voting-tester' },
      })
    );
  });
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );
});

test('CAP voting exposes every bounded item and applies current results atomically', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  let releaseSlow;
  const lookupBodies = [];
  const slowGate = new Promise(resolve => {
    releaseSlow = resolve;
  });
  await page.route('**/cap/lookup-cells', async route => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-headers': 'content-type',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-origin': '*',
        },
        body: '',
      });
      return;
    }
    const body = route.request().postDataJSON();
    lookupBodies.push(body);
    if (body.term === 'Slow cell') {
      await slowGate;
    }
    const isQuick = body.term === 'Quick cell';
    const isUnicodeBoundary = body.term === 'Unicode boundary';
    const fullName = isQuick
      ? 'Quick cell'
      : isUnicodeBoundary
        ? '😀'.repeat(120)
        : 'X'.repeat(121);
    try {
      await route.fulfill({
        status: 200,
        headers: {
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-origin': '*',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          contractVersion: 1,
          results: [{
            id: isQuick
              ? 'quick'
              : isUnicodeBoundary
                ? 'unicode-boundary'
                : 'fallback',
            name: isQuick
              ? 'Quick cell'
              : isUnicodeBoundary
                ? 'Unicode boundary'
                : 'Fallback short name',
            fullName,
            ontologyTerm: isQuick
              ? 'Quick cell'
              : isUnicodeBoundary
                ? 'Unicode ontology'
                : 'Fallback ontology term',
            ontologyTermId: isUnicodeBoundary
              ? '𐐀'.repeat(64)
              : 'CL:0000084',
            synonyms: [],
            canonicalMarkerGenes: ['LOCAL0', 'CANONICAL-A', 'CANONICAL-B'],
            markerGenes: ['GENERAL-A', 'GENERAL-B'],
            count: 10,
            scores: { agree: 7, disagree: 2, idk: 1 },
          }],
          omittedInvalidCount: 1,
        }),
      });
    } catch {
      // A superseded client request may already have closed its route.
    }
  });

  await prepareVotingHarness(page);
  const primary = page.locator('.community-annotation-modal-overlay');
  expect(await page.evaluate(() => (
    window.__capVotingBackgroundSnapshot.every(({ element }) => {
      if (element.id === 'notification-center') {
        const activeDocument = document.querySelector(
          '.community-annotation-modal-overlay [role="document"]'
        );
        return (
          activeDocument?.contains(element) === true &&
          !element.hasAttribute('aria-hidden') &&
          !element.hasAttribute('inert')
        );
      }
      return (
        element.getAttribute('aria-hidden') === 'true' &&
        element.hasAttribute('inert')
      );
    })
  ))).toBe(true);
  await page.evaluate(() => {
    const sentinel = document.createElement('button');
    sentinel.id = 'modal-dynamic-background-contract';
    sentinel.setAttribute('aria-hidden', 'false');
    sentinel.setAttribute('inert', 'sentinel-owned');
    document.body.appendChild(sentinel);
  });
  const dynamicBackground = page.locator(
    '#modal-dynamic-background-contract'
  );
  await expect(dynamicBackground).toHaveAttribute('aria-hidden', 'true');
  await expect(dynamicBackground).toHaveAttribute('inert', '');
  await page.evaluate(async () => {
    const { getNotificationCenter } = await import(
      '/assets/js/app/notification-center.js'
    );
    getNotificationCenter().error('Modal-owned feedback contract', {
      category: 'annotation',
      duration: 30_000,
      id: 'modal-owned-feedback-contract',
    });
  });
  const modalNotification = primary.locator(
    '#modal-owned-feedback-contract'
  );
  await expect(modalNotification).toBeVisible();
  const modalNotificationDismiss = modalNotification.getByRole('button', {
    name: 'Dismiss',
  });
  await modalNotificationDismiss.focus();
  await expect(modalNotificationDismiss).toBeFocused();
  await modalNotificationDismiss.press('Enter');
  await expect(modalNotification).toHaveCount(0);
  const initialPrimaryClose = primary.getByRole('button', {
    name: 'Close',
    exact: true,
  });
  await initialPrimaryClose.focus();
  await page.evaluate(async () => {
    const { showConfirmDialog } = await import(
      '/assets/js/app/ui/components/confirm-dialog.js'
    );
    showConfirmDialog({
      title: 'Accessible note contract',
      message: 'Confirm textarea labels remain exact.',
      inputLabel: 'Optional merge note',
      inputPlaceholder: 'Why are these equivalent? (optional)',
      onConfirm() {},
      onCancel() {},
    });
  });
  await expect(page.locator('.confirm-dialog-textarea')).toHaveAccessibleName(
    'Optional merge note'
  );
  await expect(
    page.locator('.confirm-dialog #notification-center')
  ).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.confirm-dialog-overlay')).toHaveCount(0);
  await expect(primary.locator('#notification-center')).toHaveCount(1);
  await expect(initialPrimaryClose).toBeFocused();
  const cards = primary.locator('.community-annotation-suggestion-card');
  await expect(cards).toHaveCount(25);
  await expect(primary.getByText(/Page 1 of 2 · 27 suggestions/)).toBeVisible();
  await primary.getByRole('button', { name: 'Next suggestions' }).click();
  await expect(cards).toHaveCount(2);
  await expect(primary.getByRole('button', {
    name: 'Previous suggestions',
  })).toBeFocused();
  await primary.getByRole('button', { name: 'Previous suggestions' }).click();
  await expect(cards).toHaveCount(25);
  await expect(primary.getByRole('button', {
    name: 'Next suggestions',
  })).toBeFocused();
  await expect(cards.first().locator('.community-annotation-vote-btn').first())
    .toHaveAttribute('aria-pressed', 'true');
  await expect(cards.first().getByRole('button', { name: 'Merge…' }))
    .toBeVisible();
  await expect(
    cards.first().locator('.community-annotation-comment-preview-item')
  ).toHaveCount(5);
  await cards.first().getByRole('button', {
    name: 'View all 31 comments',
  }).click();
  let secondary = page.locator('.community-annotation-secondary-overlay');
  await expect(secondary.locator('.community-annotation-comment'))
    .toHaveCount(25);
  await expect(
    secondary.locator('[role="document"] #notification-center')
  ).toHaveCount(1);
  await expect(secondary.getByText(/Page 1 of 2 · 31 comments/)).toBeVisible();
  await secondary.getByRole('button', { name: 'Next' }).click();
  await expect(secondary.locator('.community-annotation-comment'))
    .toHaveCount(6);
  await expect(secondary.getByRole('button', {
    name: 'Previous',
  })).toBeFocused();
  await secondary.getByRole('button', { name: 'Previous' }).click();
  await expect(secondary.getByRole('button', { name: 'Next' })).toBeFocused();
  const firstExpandedComment = secondary.locator(
    '.community-annotation-comment'
  ).first();
  await firstExpandedComment.getByRole('button', {
    name: 'Edit',
    exact: true,
  }).click();
  await firstExpandedComment.getByPlaceholder('Edit comment...')
    .fill('Edited expanded contract comment');
  await firstExpandedComment.getByRole('button', {
    name: 'Save',
    exact: true,
  }).click();
  await expect(secondary.locator('.community-annotation-comment').first()
    .getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
  await secondary.getByRole('button', { name: 'Next' }).click();
  await expect(secondary.getByRole('button', {
    name: 'Previous',
  })).toBeFocused();
  await page.evaluate(async () => {
    const { getCommunityAnnotationSession } = await import(
      '/assets/js/app/community-annotations/session.js'
    );
    const session = getCommunityAnnotationSession();
    const suggestion = session.getSuggestions(
      window.__capVotingHarness.fieldKey,
      0
    )[0];
    session.addComment(
      window.__capVotingHarness.fieldKey,
      0,
      suggestion.id,
      'Contract comment added while the secondary modal is open'
    );
  });
  await expect(secondary.getByText(/Page 2 of 2 · 32 comments/)).toBeVisible();
  const rebuiltCommentsOpener = primary.getByRole('button', {
    name: /View all 32 comments/,
    includeHidden: true
  });
  await expect(rebuiltCommentsOpener).toBeVisible();
  await secondary.getByRole('button', { name: 'Close' }).click();
  await expect(primary).not.toHaveAttribute('aria-hidden');
  await expect(rebuiltCommentsOpener).toBeFocused();

  let firstCard = cards.first();
  await firstCard.locator('.community-annotation-suggestion-actions').first()
    .getByRole('button', { name: 'Edit', exact: true }).click();
  let editBox = firstCard.locator('.community-annotation-dashed-box')
    .filter({ hasText: 'Edit suggestion' });
  await editBox.getByRole('button', { name: 'Save' }).click();
  await expect(cards.first().locator(
    '.community-annotation-suggestion-actions'
  ).first().getByRole('button', {
    name: 'Edit',
    exact: true,
  })).toBeFocused();
  const unchangedMarkers = await page.evaluate(async () => {
    const { getCommunityAnnotationSession } = await import(
      '/assets/js/app/community-annotations/session.js'
    );
    return getCommunityAnnotationSession()
      .getSuggestions(window.__capVotingHarness.fieldKey, 0)[0].markers;
  });
  expect(unchangedMarkers).toEqual([
    { gene: 'STAT1', logFC: 2.5, pval: 0.001 },
  ]);

  firstCard = cards.first();
  await firstCard.locator('.community-annotation-suggestion-actions').first()
    .getByRole('button', { name: 'Edit', exact: true }).click();
  editBox = firstCard.locator('.community-annotation-dashed-box')
    .filter({ hasText: 'Edit suggestion' });
  await editBox.getByPlaceholder(
    'Marker genes (optional, comma-separated)'
  ).fill('STAT2');
  await editBox.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.confirm-dialog-title')).toHaveText(
    'Remove marker statistics?'
  );
  await page.locator('.confirm-dialog-confirm').click();
  const convertedMarkers = await page.evaluate(async () => {
    const { getCommunityAnnotationSession } = await import(
      '/assets/js/app/community-annotations/session.js'
    );
    return getCommunityAnnotationSession()
      .getSuggestions(window.__capVotingHarness.fieldKey, 0)[0].markers;
  });
  expect(convertedMarkers).toEqual(['STAT2']);

  const label = primary.getByPlaceholder('Label (required)').last();
  const ontology = primary.getByPlaceholder(
    'Ontology id (optional, e.g. CL:0000625)'
  ).last();
  const markers = primary.getByPlaceholder(
    'Marker genes (optional, comma-separated)'
  ).last();
  await label.fill('Slow cell');
  await primary.getByRole('button', { name: 'Search CAP' }).click();
  await label.fill('Quick cell');
  await primary.getByRole('button', { name: 'Search CAP' }).click();
  const quickResult = primary.getByRole('button', {
    name: 'Use CAP result Quick cell',
  });
  await expect(quickResult).toBeVisible();
  releaseSlow();
  await expect(quickResult).toBeVisible();
  await expect(primary.locator('.cap-search-results')).toHaveCount(1);
  await primary.locator('.cap-search-close').click();
  await expect(primary.locator('.cap-search-results')).toHaveCount(0);
  await expect(primary.getByRole('button', { name: 'Search CAP' }))
    .toBeFocused();
  expect(lookupBodies).toContainEqual({
    kind: 'name',
    limit: 25,
    term: 'Slow cell',
  });
  expect(lookupBodies).toContainEqual({
    kind: 'name',
    limit: 25,
    term: 'Quick cell',
  });

  await label.fill('Unicode boundary');
  await primary.getByRole('button', { name: 'Search CAP' }).click();
  const unicodeResult = primary.locator('.cap-search-item');
  try {
    await expect(unicodeResult).toBeVisible({
      timeout: 10_000,
    });
  } catch (error) {
    const messages = await page.locator(
      '#notification-center .notification-message'
    ).allTextContents();
    throw new Error(
      `Unicode CAP search produced no usable result; requests=` +
      `${JSON.stringify(lookupBodies)}; notifications=${messages.join(' | ')}; ` +
      `panel=${await primary.locator('.cap-search-results').allTextContents()}`,
      { cause: error }
    );
  }
  await unicodeResult.click();
  await expect(label).toHaveValue('😀'.repeat(120));
  await expect(ontology).toHaveValue('𐐀'.repeat(64));
  expect(lookupBodies).toContainEqual({
    kind: 'name',
    limit: 25,
    term: 'Unicode boundary',
  });

  await ontology.fill('CL:0000084');
  await primary.getByRole('button', { name: 'Search Ontology' }).click();
  await expect(primary.locator('.cap-search-results')).toBeVisible();
  expect(lookupBodies).toContainEqual({
    kind: 'ontology',
    limit: 25,
    term: 'CL:0000084',
  });
  await primary.locator('.cap-search-close').click();
  await expect(primary.getByRole('button', {
    name: 'Search Ontology',
  })).toBeFocused();

  await markers.fill('MS4A1, CD3D, LST1');
  await primary.getByRole('button', { name: 'Search Markers' }).click();
  await expect(primary.locator('.cap-search-results')).toBeVisible();
  expect(lookupBodies).toContainEqual({
    kind: 'marker',
    limit: 25,
    term: 'CD3D,LST1,MS4A1',
  });
  await primary.locator('.cap-search-close').click();
  await expect(primary.getByRole('button', {
    name: 'Search Markers',
  })).toBeFocused();

  const localMarkers = Array.from(
    { length: 49 },
    (_, index) => `LOCAL${index}`
  );
  await markers.fill(localMarkers.join(', '));
  await label.fill('Fallback');
  await primary.getByRole('button', { name: 'Search CAP' }).click();
  await expect(primary.locator('.cap-search-warning')).toHaveText(
    'CAP omitted 1 invalid upstream result.'
  );
  const result = primary.getByRole('button', {
    name: 'Use CAP result ' + 'X'.repeat(121),
  });
  await result.press('Enter');
  await expect(primary.getByRole('button', { name: 'Search CAP' }))
    .toBeFocused();
  await expect(label).toHaveValue('Fallback ontology term');
  await expect(markers).toHaveValue(/LOCAL48, CANONICAL-A$/);
  await expect(primary.locator('.cap-import-status')).toContainText(
    'Used the ontology term'
  );
  await expect(primary.locator('.cap-import-status')).toContainText(
    '1 duplicate CAP marker: LOCAL0'
  );
  await expect(primary.locator('.cap-import-status')).toContainText(
    '3 CAP markers omitted at the 50-marker limit: CANONICAL-B, GENERAL-A, GENERAL-B'
  );

  firstCard = cards.first();
  await firstCard.getByRole('button', { name: 'Merge…' }).click();
  await firstCard.locator('.community-annotation-merge-form select')
    .selectOption({ index: 1 });
  await firstCard.getByRole('button', {
    name: 'Merge suggestion',
  }).click();
  await expect(primary).toHaveAttribute('aria-hidden', 'true');
  await expect(primary).toHaveAttribute('inert', '');
  await expect(
    page.locator('.confirm-dialog #notification-center')
  ).toHaveCount(1);
  await page.locator('.confirm-dialog-confirm').click();
  await expect(page.locator('.confirm-dialog-overlay')).toHaveCount(0);
  await expect(primary).not.toHaveAttribute('aria-hidden');
  await expect(primary.locator('#notification-center')).toHaveCount(1);
  const viewMerged = primary.getByRole('button', {
    name: 'View merged (1)',
  });
  await expect(viewMerged).toBeVisible();
  await viewMerged.click();
  await expect(primary).toHaveAttribute('aria-hidden', 'true');
  await expect(primary).toHaveAttribute('inert', '');
  secondary = page.locator('.community-annotation-secondary-overlay');
  await expect(secondary).toBeVisible();
  let detachButton = secondary.getByRole('button', { name: 'Detach' });
  await detachButton.click();
  await expect(secondary).toHaveAttribute('aria-hidden', 'true');
  await expect(secondary).toHaveAttribute('inert', '');
  await expect(primary).toHaveAttribute('aria-hidden', 'true');
  await expect(
    page.locator('.confirm-dialog #notification-center')
  ).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.confirm-dialog-overlay')).toHaveCount(0);
  await expect(secondary).toBeVisible();
  await expect(secondary).not.toHaveAttribute('aria-hidden');
  await expect(secondary).not.toHaveAttribute('inert');
  await expect(primary).toHaveAttribute('aria-hidden', 'true');
  await expect(
    secondary.locator('[role="document"] #notification-center')
  ).toHaveCount(1);
  await expect(detachButton).toBeFocused();
  await secondary.getByRole('button', { name: 'Close' }).click();
  await expect(primary).not.toHaveAttribute('aria-hidden');
  await expect(primary).not.toHaveAttribute('inert');
  await expect(primary.locator('#notification-center')).toHaveCount(1);
  await expect(viewMerged).toBeFocused();

  await viewMerged.click();
  secondary = page.locator('.community-annotation-secondary-overlay');
  detachButton = secondary.getByRole('button', { name: 'Detach' });
  await detachButton.click();
  await page.locator('.confirm-dialog-confirm').click();
  await expect(page.locator('.confirm-dialog-overlay')).toHaveCount(0);
  await expect(primary.getByRole('button', {
    name: 'View merged (1)'
  })).toHaveCount(0);
  const primaryClose = primary.getByRole('button', {
    name: 'Close',
    exact: true
  });
  await secondary.getByRole('button', { name: 'Close' }).click();
  await expect(primaryClose).toBeFocused();
  expect(await page.evaluate(() => document.activeElement !== document.body))
    .toBe(true);
  await primaryClose.click();
  await expect(primary).toHaveCount(0);
  const backgroundRestorationMismatches = await page.evaluate(() => (
    window.__capVotingBackgroundSnapshot.flatMap((state, index) => {
      const auxiliaryPlacementRestored = (
        state.element.id !== 'notification-center' ||
        (
          state.element.parentNode === state.parent &&
          state.element.nextSibling === state.nextSibling
        )
      );
      const exact = (
        auxiliaryPlacementRestored &&
        state.element.hasAttribute('aria-hidden') === state.hadAriaHidden &&
        state.element.getAttribute('aria-hidden') === state.ariaHidden &&
        state.element.hasAttribute('inert') === state.hadInert &&
        state.element.getAttribute('inert') === state.inert
      );
      if (exact) return [];
      return [{
        id: state.element.id,
        index,
        parentRestored: state.element.parentNode === state.parent,
        nextSiblingRestored:
          state.element.nextSibling === state.nextSibling,
        ariaHidden: state.element.getAttribute('aria-hidden'),
        expectedAriaHidden: state.ariaHidden,
        inert: state.element.getAttribute('inert'),
        expectedInert: state.inert,
      }];
    })
  ));
  expect(backgroundRestorationMismatches).toEqual([]);
  await expect(dynamicBackground).toHaveAttribute('aria-hidden', 'false');
  await expect(dynamicBackground).toHaveAttribute('inert', 'sentinel-owned');
  await dynamicBackground.evaluate(element => element.remove());
  expect(productErrors).toEqual([]);
});

test('owned confirms cannot survive destroy, replacement, sign-out, or dataset switch', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  let releasePendingCap;
  let markPendingCapStarted;
  const pendingCapGate = new Promise(resolve => {
    releasePendingCap = resolve;
  });
  const pendingCapStarted = new Promise(resolve => {
    markPendingCapStarted = resolve;
  });
  await page.route('**/cap/lookup-cells', async route => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-headers': 'content-type',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-origin': '*',
        },
        body: '',
      });
      return;
    }
    markPendingCapStarted();
    await pendingCapGate;
    try {
      await route.fulfill({
        status: 200,
        headers: {
          'access-control-allow-origin': '*',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          contractVersion: 1,
          results: [],
          omittedInvalidCount: 0,
        }),
      });
    } catch {
      // Context retirement owns and aborts this request.
    }
  });
  await prepareVotingHarness(page, { suggestionCount: 1 });

  const openDeleteConfirm = async () => {
    const primary = page.locator('.community-annotation-modal-overlay');
    await expect(primary).toBeVisible();
    await primary.locator('.community-annotation-suggestion-card').first()
      .locator('.community-annotation-suggestion-actions').first()
      .getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.confirm-dialog-overlay')).toBeVisible();
    await expect(primary).toHaveAttribute('aria-hidden', 'true');
  };
  const expectNoTransientDialogs = async () => {
    await expect(page.locator('.confirm-dialog-overlay')).toHaveCount(0);
    await expect(
      page.locator('.community-annotation-secondary-overlay')
    ).toHaveCount(0);
  };
  const reopen = async () => {
    const opened = await page.evaluate(() => (
      window.__capVotingHarness.open()
    ));
    expect(opened).toBe(true);
    await expect(
      page.locator('.community-annotation-voting-detail')
    ).toBeVisible();
  };

  await openDeleteConfirm();
  await page.evaluate(() => window.__capVotingModal.close());
  await expectNoTransientDialogs();
  await expect(page.locator('.community-annotation-modal-overlay'))
    .toHaveCount(0);

  await reopen();
  await openDeleteConfirm();
  await reopen();
  await expectNoTransientDialogs();
  await expect(page.locator('.community-annotation-modal-overlay'))
    .toHaveCount(1);

  await openDeleteConfirm();
  await page.evaluate(async () => {
    const { ANNOTATION_CONNECTION_CHANGED_EVENT } = await import(
      '/assets/js/app/community-annotations/connection-events.js'
    );
    window._simulate_repo_connected = false;
    window.dispatchEvent(new CustomEvent(
      ANNOTATION_CONNECTION_CHANGED_EVENT
    ));
  });
  await expectNoTransientDialogs();
  await expect(page.locator('.community-annotation-modal-overlay'))
    .toHaveCount(0);

  await page.evaluate(async () => {
    const { ANNOTATION_CONNECTION_CHANGED_EVENT } = await import(
      '/assets/js/app/community-annotations/connection-events.js'
    );
    window._simulate_repo_connected = true;
    window.dispatchEvent(new CustomEvent(
      ANNOTATION_CONNECTION_CHANGED_EVENT
    ));
  });
  await reopen();
  const finalPrimary = page.locator('.community-annotation-modal-overlay');
  await finalPrimary.getByPlaceholder('Label (required)').last()
    .fill('Pending context CAP');
  await finalPrimary.getByRole('button', { name: 'Search CAP' }).click();
  await pendingCapStarted;
  await openDeleteConfirm();
  await page.evaluate(async () => {
    const { getCommunityAnnotationSession } = await import(
      '/assets/js/app/community-annotations/session.js'
    );
    getCommunityAnnotationSession().setCacheContext({
      datasetId: 'cap-voting-retired-dataset',
      repoRef: null,
      userId: null,
    });
  });
  releasePendingCap();
  await expectNoTransientDialogs();
  await expect(page.locator('.community-annotation-modal-overlay'))
    .toHaveCount(0);
  await expect(page.locator('.cap-search-results')).toHaveCount(0);

  await page.evaluate(async () => {
    const { getCommunityAnnotationSession } = await import(
      '/assets/js/app/community-annotations/session.js'
    );
    const session = getCommunityAnnotationSession();
    session.setCacheContext(window.__capVotingHarness.openingContext);
    session.setProfile({
      username: 'ghid_42',
      githubUserId: 42,
      login: 'cap-voting-tester',
      displayName: 'CAP voting tester',
      title: '',
      orcid: '',
      linkedin: '',
    });
  });
  await reopen();
  await openDeleteConfirm();
  await page.evaluate(async () => {
    const { getGitHubAuthSession } = await import(
      '/assets/js/app/community-annotations/github-auth.js'
    );
    getGitHubAuthSession().signOut();
  });
  await expectNoTransientDialogs();
  await expect(page.locator('.community-annotation-modal-overlay'))
    .toHaveCount(0);
  expect(productErrors).toEqual([]);
});
