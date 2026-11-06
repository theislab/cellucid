/**
 * Community annotation as a person and an agent meet it, against a stateful
 * stand-in for the GitHub Worker and repository
 * (`helpers/community-annotation-github.mjs`: every write recorded with its
 * content). The walks of the UI audit of 2026-11-05, kept:
 *
 * - a vote in the dialog shows as not published, and Publish writes it;
 * - without write access and without a fork, Publish links to forking on
 *   GitHub (Cellucid never creates a fork); forked, it opens the pull request;
 * - an agent's vote or suggestion publishes only itself (never the person's
 *   drafts or an author's staged settings), asks with what it is and where
 *   it goes, publishes nothing when nothing changes, and never opens a dialog;
 * - Stop while a vote is written says honestly what happened, and the next
 *   Publish works;
 * - a category or field renamed here is a display name: votes and
 *   suggestions stay under the dataset's names, for the person, the agent and
 *   across a history jump, and the field stays locked;
 * - a second tab on the same dataset pauses annotation ("Use here"), and the
 *   dataset controls go on working;
 * - another dataset shown while connected, and back;
 * - a dropped connection while publishing, and a sign-in GitHub refuses
 *   (expired): signed out, the repository and the unpublished vote kept.
 */
import { closePageWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { waitForHistory } from './helpers/state-history.mjs';
import {
  installScriptedModel, observeProductErrors, openChat, queueReplies, resultJson, waitForTurnEnd,
} from './helpers/agent-chat.mjs';
import {
  AUTH_USER, AUTH_USER_KEY, REPO, configDocument, installAnnotationRepository, remoteUserFile, signedIn, suggestion,
  userDocument,
} from './helpers/community-annotation-github.mjs';

const DATASET = 'current-ui';
const FIELD = Object.freeze({ source: 'obs', key: 'cell_type' });
const OWN_FILE = `annotations/users/${AUTH_USER_KEY}.json`;

function deepLink({ repo = true, dataset = DATASET } = {}) {
  return `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=${dataset}`
    + (repo ? `&annotations=${encodeURIComponent(`${REPO}@main`)}` : '') + '&acceptance=community-annotation-walk';
}

function config({ minAnnotators = 2 } = {}) {
  return configDocument([{ id: DATASET, name: 'Current UI fixture', field: 'cell_type', minAnnotators, threshold: 0.5 }]);
}

function communityUsers() {
  return {
    ghid_51: userDocument(51, 'l-marchetti', DATASET, {
      'cell_type:alpha': [suggestion('ghid_51_alpha-1', 'Alpha cell', 51, { ontologyId: 'CL:0000171', evidence: 'Gcg high.' })],
      'cell_type:beta': [suggestion('ghid_51_beta-1', 'Beta cell', 51)],
    }, { 'ghid_51_alpha-1': 'up', 'ghid_51_beta-1': 'up' }),
    ghid_77: userDocument(77, 's-abadi', DATASET, { 'cell_type:alpha': [suggestion('ghid_77_alpha-2', 'Alpha (immature)', 77)] }, { 'ghid_77_alpha-2': 'up', 'ghid_51_alpha-1': 'down' }),
    ghid_88: userDocument(88, 'm-haddad', DATASET, {}, { 'ghid_51_alpha-1': 'up', 'ghid_51_beta-1': 'up' }),
  };
}

const section = page => page.locator('#community-annotation-section');

async function openSection(page) {
  const root = section(page);
  if (!(await root.evaluate(element => element.open))) await root.locator(':scope > summary').click();
  return root;
}

/** Open the dataset connected to the repository, the panel open on it. */
async function openConnected(page, { url = deepLink() } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await waitForHistory(page);
  const root = await openSection(page);
  await expect(root).toContainText(REPO);
  return root;
}

async function syncModal(page) {
  await section(page).getByRole('button', { name: 'GitHub sync…', exact: true }).click();
  return page.locator('.community-annotation-modal-overlay').last();
}

async function pull(page) {
  const modal = await syncModal(page);
  await modal.getByRole('button', { name: /Pull/ }).first().click();
  await expect(modal).toContainText('Pulled latest annotations.');
  await modal.getByRole('button', { name: 'Close' }).first().click();
  await expect(modal).toBeHidden();
}

async function colourBy(page, key) {
  const option = page.locator('#categorical-field option').filter({ hasText: key }).first();
  await page.locator('#categorical-field').selectOption({ label: await option.innerText() });
  await expect(page.locator('[aria-label^="Vote on category"]').first()).toBeVisible();
}

const voteButton = (page, label, direction) => page.locator(
  `.community-annotation-vote-btn.vote-${direction}[aria-label^="${direction === 'up' ? 'Upvote' : 'Downvote'} ${label};"]`,
);

/** What the agent's last tool call answered: its text. */
async function lastToolText(page) {
  return page.evaluate(() => window.__agentRequests.at(-1).messages.at(-1).results?.[0]?.content?.[0]?.text ?? null);
}

async function dispatchAsAgent(page, type, params, turn) {
  return page.evaluate(async ({ type: actionType, params: actionParams, turn: turnId }) => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    try {
      const { outcome } = await getActions().dispatch(actionType, actionParams, { origin: 'agent', agent: 'Claude', turn: turnId });
      return { outcome };
    } catch (error) {
      return { code: error.code ?? null, message: error.message };
    }
  }, { type, params, turn });
}

/** The person's profile filled in, so their own Publish does not ask for it ("Your identity"). */
async function fillProfile(page) {
  await page.evaluate(async () => {
    const { getCommunityAnnotationSession } = await import('/assets/js/app/community-annotations/session.js');
    const session = getCommunityAnnotationSession();
    session.setProfile({ ...session.getProfile(), displayName: 'Tess Tester' });
  });
}

/** Product errors, without the 404 a browser logs for a file the repository does not hold yet (the person's own, before their first Publish). */
function productErrors(errors) {
  return errors.filter(line => !/Failed to load resource: the server responded with a status of 404/.test(line));
}

async function allowPublishing(page) {
  await page.evaluate(() => window._cellucidUi.agents.presence.permissions.set({ kinds: { publishes: 'allow' } }));
}

test.describe('community annotation walk', () => {
  test.describe.configure({ timeout: 120_000 });

  test('a vote in the dialog shows as not published, and Publish writes only the person\'s file', async ({ page }) => {
    const errors = observeProductErrors(page);
    await signedIn(page);
    const repository = await installAnnotationRepository(page, { config: config(), users: communityUsers(), author: false });
    const root = await openConnected(page);
    await pull(page);
    await fillProfile(page);
    await expect(root.locator('.community-annotation-pending')).toContainText('1 change not published');
    await root.locator('.community-annotation-pending').getByRole('button', { name: 'Publish' }).click();
    await expect(root.locator('.community-annotation-pending')).toHaveCount(0);
    await colourBy(page, 'cell_type');
    await page.locator('[aria-label="Vote on category alpha"]').click();
    await voteButton(page, 'Alpha cell', 'up').click();
    await expect(voteButton(page, 'Alpha cell', 'up')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    const pending = root.locator('.community-annotation-pending');
    await expect(pending).toContainText('1 change not published');
    const before = repository.mutations.length;
    await pending.getByRole('button', { name: 'Publish' }).click();
    await expect(pending).toHaveCount(0);
    const writes = repository.mutations.slice(before);
    expect(writes.map(write => write.contentPath)).toEqual([OWN_FILE]);
    expect(remoteUserFile(repository).datasets[DATASET].votes).toEqual({ 'ghid_51_alpha-1': 'up' });
    expect(productErrors(errors)).toEqual([]);
  });

  test('without write access and without a fork, Publish links to forking on GitHub; once forked, it opens the pull request', async ({ page }) => {
    const errors = observeProductErrors(page);
    await signedIn(page);
    const repository = await installAnnotationRepository(page, { config: config(), users: communityUsers(), author: false, push: false });
    const root = await openConnected(page);
    await pull(page);
    await fillProfile(page);
    const pending = root.locator('.community-annotation-pending');
    await expect(pending).toContainText('1 change not published');
    await pending.getByRole('button', { name: 'Publish' }).click();
    await expect(root).toContainText(`You have no fork of ${REPO} yet: fork it on GitHub, then Publish again.`);
    const link = root.getByRole('link', { name: 'Fork on GitHub' });
    await expect(link).toHaveAttribute('href', `https://github.com/${REPO}/fork`);
    await expect(link).toHaveAttribute('target', '_blank');
    // Cellucid never creates the fork, nor writes anything.
    expect(repository.github.log.filter(line => /^(PUT|PATCH|POST) \/api\//.test(line))).toEqual([]);
    expect(repository.github.pulls).toEqual([]);

    // The person forks on GitHub, then publishes again.
    repository.github.forkOnGitHub();
    await pending.getByRole('button', { name: 'Publish' }).click();
    await expect(link).toHaveCount(0);
    // A pull request from the fork (the change counts as published once it is merged).
    await expect.poll(() => repository.github.pulls.map(pr => pr.headRepo)).toEqual([`${AUTH_USER.login}/${REPO.split('/')[1]}`]);
    await expect(root).not.toContainText('You have no fork');
    expect(productErrors(errors)).toEqual([]);
  });

  test('an agent\'s vote publishes only itself, asks with what it is, and nothing when nothing changes', async ({ page }) => {
    await page.addInitScript(installScriptedModel);
    await signedIn(page);
    const repository = await installAnnotationRepository(page, { config: config(), users: communityUsers() });
    await openConnected(page);
    await pull(page);
    // Unpublished work of the person: a draft suggestion, and (an author) staged settings.
    await page.evaluate(async () => {
      const { getCommunityAnnotationSession } = await import('/assets/js/app/community-annotations/session.js');
      const session = getCommunityAnnotationSession();
      session.setFieldCategories('cell_type', ['alpha', 'beta', 'gamma']);
      session.addSuggestion('cell_type', 'gamma', { label: 'UNPUBLISHED DRAFT label' });
      session.setAnnotatableConsensusSettings('cell_type', { minAnnotators: 5, threshold: 0.9 });
    });
    await expect(section(page).locator('.community-annotation-pending')).toContainText('not published');
    await openChat(page);
    await queueReplies(page, [
      { text: 'Voting.', calls: [{ name: 'annotation_vote', args: { field: FIELD, category: 'alpha', suggestion: 'Alpha cell', vote: 'up' } }] },
      { text: 'Done.' },
    ]);
    const before = repository.mutations.length;
    await page.locator('#agent-chat-input').fill('upvote Alpha cell for alpha');
    await page.locator('#agent-chat-input').press('Enter');
    const card = page.locator('#agent-presence .agent-confirm');
    await expect(card).toHaveCount(1);
    // The question names the vote and where it goes, and that nothing else is published.
    await expect(card).toContainText('Alpha cell');
    await expect(card).toContainText(`publishes this one vote to ${REPO}@main`);
    await expect(card).toContainText('Nothing else is published');
    await card.locator('.agent-confirm-allow').click();
    await waitForTurnEnd(page);
    const writes = repository.mutations.slice(before);
    expect(writes.map(write => write.contentPath)).toEqual([OWN_FILE]);
    expect(writes[0].decoded).not.toContain('UNPUBLISHED DRAFT');
    expect(remoteUserFile(repository).datasets[DATASET].votes).toEqual({ 'ghid_51_alpha-1': 'up' });
    const result = resultJson(await lastToolText(page));
    expect(result).toMatchObject({ published: 'repository', pull_request: null, suggestion: 'Alpha cell', vote: 'up' });
    expect(result.not_published).toBeGreaterThanOrEqual(2);
    // The draft and the settings are still the person's, not published.
    await expect(section(page).locator('.community-annotation-pending')).toContainText('not published');

    // The same vote again: nothing is asked, nothing is written.
    const settled = repository.mutations.length;
    await queueReplies(page, [{ calls: [{ name: 'annotation_vote', args: { field: FIELD, category: 'alpha', suggestion: 'Alpha cell', vote: 'up' } }] }, { text: 'ok' }]);
    await page.locator('#agent-chat-input').fill('upvote it again');
    await page.locator('#agent-chat-input').press('Enter');
    await waitForTurnEnd(page);
    expect(repository.mutations.length).toBe(settled);
    expect(resultJson(await lastToolText(page))).toMatchObject({ published: 'unchanged', vote: 'up' });
  });

  test('an agent reads the consensus, the people and its own vote, in pages; a label two people proposed is one suggestion', async ({ page }) => {
    await signedIn(page);
    const users = communityUsers();
    users.ghid_88.datasets[DATASET].suggestions = { 'cell_type:alpha': [suggestion('ghid_88_alpha-dup', 'Alpha cell', 88)] };
    const repository = await installAnnotationRepository(page, { config: config({ minAnnotators: 2 }), users });
    await openConnected(page);
    await pull(page);
    const read = await dispatchAsAgent(page, 'annotation.suggestions', { field: FIELD, category: 'alpha' }, 'read');
    const alpha = read.outcome.categories[0];
    expect(read.outcome.pulled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(read.outcome.next).toBeNull();
    expect(alpha.consensus).toMatchObject({ status: expect.stringMatching(/^(consensus|disputed|pending)$/), voters: 3 });
    // The same label proposed twice is one suggestion, shown as the earliest proposal.
    expect(alpha.suggestions.filter(entry => entry.label === 'Alpha cell').map(entry => entry.id)).toEqual(['ghid_51_alpha-1']);
    const first = alpha.suggestions.find(entry => entry.id === 'ghid_51_alpha-1');
    expect(first.by).toContain('@l-marchetti');
    expect(first.by).not.toMatch(/ghid_/);
    expect(first).toMatchObject({ mine: null, mine_delegated: false });
    // Named by its label, the vote goes to that one suggestion.
    await allowPublishing(page);
    const voted = await dispatchAsAgent(page, 'annotation.vote', { field: FIELD, category: 'alpha', suggestion: 'Alpha cell', vote: 'up' }, 'vote');
    expect(voted, JSON.stringify(voted)).toHaveProperty('outcome');
    expect(voted.outcome).toMatchObject({ published: 'repository', suggestion: 'Alpha cell', vote: 'up' });
    expect(remoteUserFile(repository).datasets[DATASET].votes).toEqual({ 'ghid_51_alpha-1': 'up' });
  });

  test('an agent\'s vote never opens the identity dialog', async ({ page }) => {
    await signedIn(page);
    const repository = await installAnnotationRepository(page, { config: config(), users: communityUsers() });
    await openConnected(page);
    await pull(page);
    await allowPublishing(page);
    const voted = await dispatchAsAgent(page, 'annotation.vote', { field: FIELD, category: 'beta', suggestion: 'ghid_51_beta-1', vote: 'down' }, 'no-profile');
    expect(voted, JSON.stringify(voted)).toHaveProperty('outcome');
    expect(voted.outcome).toMatchObject({ published: 'repository', vote: 'down' });
    await expect(page.locator('.community-annotation-modal-overlay')).toHaveCount(0);
    const file = remoteUserFile(repository);
    expect(file.login).toBe(AUTH_USER.login);
    expect(file.datasets[DATASET].votes).toEqual({ 'ghid_51_beta-1': 'down' });
  });

  test('an agent\'s suggestion publishes only itself, with the person\'s upvote; a label already there is refused', async ({ page }) => {
    await signedIn(page);
    const repository = await installAnnotationRepository(page, { config: config(), users: communityUsers() });
    await openConnected(page);
    await pull(page);
    await allowPublishing(page);
    await page.evaluate(async () => {
      const { getCommunityAnnotationSession } = await import('/assets/js/app/community-annotations/session.js');
      const session = getCommunityAnnotationSession();
      session.setFieldCategories('cell_type', ['alpha', 'beta', 'gamma']);
      session.vote('cell_type', 'beta', 'ghid_51_beta-1', 'down');
    });
    const suggested = await dispatchAsAgent(page, 'annotation.suggest', { field: FIELD, category: 'gamma', label: 'Gamma cell', ontology_id: 'CL:0000173' }, 'suggest');
    expect(suggested, JSON.stringify(suggested)).toHaveProperty('outcome');
    expect(suggested.outcome).toMatchObject({ published: 'repository', label: 'Gamma cell', not_published: 1 });
    const own = remoteUserFile(repository).datasets[DATASET];
    expect(own.suggestions['cell_type:gamma'].map(entry => entry.label)).toEqual(['Gamma cell']);
    expect(own.votes).toEqual({ [suggested.outcome.id]: 'up' }, 'the unpublished vote on beta stays unpublished');
    const again = await dispatchAsAgent(page, 'annotation.suggest', { field: FIELD, category: 'alpha', label: 'Alpha cell' }, 'suggest');
    expect(again.code).toBe('exists');
    expect(again.message).toContain('ghid_51_alpha-1');
  });

  test('Stop while a vote is written says what happened, and the next Publish works', async ({ page }) => {
    await signedIn(page);
    const repository = await installAnnotationRepository(page, { config: config(), users: communityUsers() });
    const root = await openConnected(page);
    await pull(page);
    await fillProfile(page);
    await allowPublishing(page);
    const held = repository.hold();
    const voting = dispatchAsAgent(page, 'annotation.vote', { field: FIELD, category: 'alpha', suggestion: 'ghid_51_alpha-1', vote: 'down' }, 'turn-stop');
    await held.waiting;
    await page.evaluate(async () => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      const { cancelled } = await import('/assets/js/utils/abort.js');
      getActions().stop({ turn: 'turn-stop' }, cancelled('user', 'The person stopped Claude.'));
    });
    held.release();
    const told = await voting;
    const remote = remoteUserFile(repository)?.datasets?.[DATASET]?.votes ?? {};
    if (remote['ghid_51_alpha-1'] === 'down') {
      // GitHub has it: never said as not published.
      expect(told.outcome?.published ?? told.code).toMatch(/repository|may-be-published/);
    } else {
      expect(told.code).toMatch(/not-published|may-be-published/);
    }
    // What this browser knows of the file is GitHub's again: the next Publish is not refused.
    await expect.poll(async () => page.evaluate(async () => {
      const { getCommunityAnnotationSession } = await import('/assets/js/app/community-annotations/session.js');
      return getCommunityAnnotationSession().getRemoteFileShas()['annotations/users/ghid_4242.json'] ?? null;
    })).toBe(repository.files.get(OWN_FILE)?.sha ?? null);
    const modal = await syncModal(page);
    await modal.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(modal).toContainText(/Published\.|Nothing new to publish/);
    await expect(modal).not.toContainText('Pull first');
    await modal.getByRole('button', { name: 'Close' }).first().click();
    await expect(root).not.toContainText('Annotation sync aborted');
  });

  test('a category renamed here is a display name: votes and suggestions stay under the dataset\'s names', async ({ page }) => {
    await page.addInitScript(installScriptedModel);
    await signedIn(page);
    const repository = await installAnnotationRepository(page, { config: config(), users: communityUsers() });
    // Renamed before the repository is connected, when nothing locks it.
    await page.goto(deepLink({ repo: false }), { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await waitForHistory(page);
    const renamed = await page.evaluate(async () => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      await getActions().dispatch('category.rename', { field: { source: 'obs', key: 'cell_type' }, category: 'alpha', name: 'Alpha renamed' });
      return window._cellucidState.getFields().find(field => field._originalKey === 'cell_type' || field.key === 'cell_type').categories;
    });
    expect(renamed).toContain('Alpha renamed');
    await page.evaluate(async repo => {
      const { setAnnotationRepoForDataset } = await import('/assets/js/app/community-annotations/repo-store.js');
      setAnnotationRepoForDataset('current-ui', repo, 'ghid_4242', { branchMode: 'explicit' });
    }, `${REPO}@main`);
    const root = await openSection(page);
    await expect(root).toContainText(REPO);
    await pull(page);
    await colourBy(page, 'cell_type');
    await page.locator('[aria-label="Vote on category Alpha renamed"]').click();
    const dialog = page.locator('.community-annotation-modal-overlay').last();
    // The other people's suggestions for alpha are there, under the local name.
    await expect(dialog).toContainText('Alpha cell');
    await expect(dialog).toContainText('Alpha (immature)');
    await expect(dialog).toContainText('in the repository: cell_type • alpha');
    await page.keyboard.press('Escape');

    // The agent names the category as shown; the vote goes to alpha's suggestion.
    await allowPublishing(page);
    const read = await dispatchAsAgent(page, 'annotation.suggestions', { field: FIELD, category: 'Alpha renamed' }, 'r1');
    expect(read.outcome.categories[0]).toMatchObject({ category: 'Alpha renamed', repository_category: 'alpha' });
    expect(read.outcome.categories[0].suggestions.map(entry => entry.id).sort()).toEqual(['ghid_51_alpha-1', 'ghid_77_alpha-2']);
    const voted = await dispatchAsAgent(page, 'annotation.vote', { field: FIELD, category: 'Alpha renamed', suggestion: 'Alpha cell', vote: 'up' }, 'r1');
    expect(voted.outcome).toMatchObject({ published: 'repository', vote: 'up' });
    const own = remoteUserFile(repository).datasets[DATASET];
    expect(own.votes).toEqual({ 'ghid_51_alpha-1': 'up' });
    expect(Object.keys(own.suggestions ?? {})).not.toContain('cell_type:Alpha renamed');

    // A jump back over the rename: the field is still the annotated one, still locked.
    const jumped = await page.evaluate(async () => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      const history = window._cellucidHistories.current();
      const rename = [...history.active.steps.values()].find(step => step.type === 'category.rename');
      await history.jump(rename.parent);
      const field = window._cellucidState.getFields().find(entry => entry.key === 'cell_type' || entry._originalKey === 'cell_type');
      let locked;
      try {
        await getActions().dispatch('category.rename', { field: { source: 'obs', key: field.key }, category: 'beta', name: 'Beta X' });
        locked = false;
      } catch (error) {
        locked = /cannot be edited/.test(error.message);
      }
      return { categories: field.categories, locked };
    });
    expect(jumped.categories).toContain('alpha');
    expect(jumped.locked).toBe(true);
    await colourBy(page, 'cell_type');
    await page.locator('[aria-label="Vote on category alpha"]').click();
    await expect(voteButton(page, 'Alpha cell', 'up')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a field renamed here is a display name: the vote goes under the dataset\'s field', async ({ page }) => {
    await signedIn(page);
    const repository = await installAnnotationRepository(page, { config: config(), users: communityUsers() });
    await page.goto(deepLink({ repo: false }), { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await waitForHistory(page);
    await page.evaluate(async () => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      await getActions().dispatch('field.rename', { field: { source: 'obs', key: 'cell_type' }, name: 'Cell type (mine)' });
    });
    await page.evaluate(async repo => {
      const { setAnnotationRepoForDataset } = await import('/assets/js/app/community-annotations/repo-store.js');
      setAnnotationRepoForDataset('current-ui', repo, 'ghid_4242', { branchMode: 'explicit' });
    }, `${REPO}@main`);
    const root = await openSection(page);
    await expect(root).toContainText(REPO);
    await pull(page);
    // The pull did not refuse the renamed field as missing, and the field is annotated (🗳️) under its local name.
    await expect(page.locator('#categorical-field option').filter({ hasText: 'Cell type (mine)' })).toContainText('🗳️');
    await allowPublishing(page);
    const read = await dispatchAsAgent(page, 'annotation.suggestions', { field: { source: 'obs', key: 'Cell type (mine)' }, category: 'beta' }, 'f1');
    expect(read.outcome).toMatchObject({ annotated: true, repository_field: 'cell_type' });
    const voted = await dispatchAsAgent(page, 'annotation.vote', { field: { source: 'obs', key: 'Cell type (mine)' }, category: 'beta', suggestion: 'Beta cell', vote: 'down' }, 'f1');
    expect(voted.outcome).toMatchObject({ published: 'repository', vote: 'down' });
    expect(remoteUserFile(repository).datasets[DATASET].votes).toEqual({ 'ghid_51_beta-1': 'down' });
    // Locked under its local name too.
    const lock = await dispatchAsAgent(page, 'field.rename', { field: { source: 'obs', key: 'Cell type (mine)' }, name: 'Other' }, 'f1');
    expect(lock.message).toMatch(/cannot be edited/);
  });

  test('a second tab pauses annotation, keeps its dataset controls, and Use here takes it over', async ({ page, context }) => {
    await signedIn(context);
    await installAnnotationRepository(context, { config: config(), users: communityUsers() });
    const first = await openConnected(page);
    await pull(page);
    const other = await context.newPage();
    const errors = observeProductErrors(other);
    await other.goto(deepLink(), { waitUntil: 'domcontentloaded' });
    await dismissWelcome(other);
    await expect(other.locator('#dataset-name')).toHaveText('Current UI fixture');
    const second = await openSection(other);
    await expect(second).toContainText('Open in another tab — annotation paused here');
    await expect(other.getByText('Dataset controls unavailable')).toHaveCount(0);
    // The dataset controls work here.
    await other.locator('#categorical-field').selectOption({ label: await other.locator('#categorical-field option').filter({ hasText: 'cell_type' }).first().innerText() });
    await expect(other.locator('#legend')).toContainText('alpha');
    // The first tab is untouched and still connected.
    await expect(first).toContainText(REPO);
    await expect(first).not.toContainText('paused here');

    await second.getByRole('button', { name: 'Use here' }).click();
    await expect(second).not.toContainText('paused here');
    await expect(second).toContainText(REPO);
    await expect(first).toContainText('Open in another tab — annotation paused here');
    expect(productErrors(errors)).toEqual([]);
    await closePageWithApplicationRetirement(other);
  });

  test('another dataset shown while connected, and back: each with its own connection, nothing lost', async ({ page }) => {
    const errors = observeProductErrors(page);
    await signedIn(page);
    await installAnnotationRepository(page, { config: config(), users: communityUsers() });
    await page.route('**/tests/browser/fixtures/catalog/datasets.json', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ schema: 2, default: DATASET, datasets: [{ id: DATASET, path: 'current-ui.h5ad' }, { id: 'current-ui-vector', path: 'current-ui-vector.h5ad' }] }),
    }));
    const root = await openConnected(page);
    await pull(page);
    await colourBy(page, 'cell_type');
    await page.locator('[aria-label="Vote on category beta"]').click();
    await voteButton(page, 'Beta cell', 'down').click();
    await expect(voteButton(page, 'Beta cell', 'down')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(root.locator('.community-annotation-pending')).toContainText('1 change not published');

    await page.locator('#dataset-select').selectOption('dataset:local-demo:current-ui-vector');
    await expect(page.locator('#dataset-name')).toHaveText('Current UI vector fixture');
    await expect(root).toContainText('Not connected.');
    await expect(page.locator('.community-annotation-modal-overlay')).toHaveCount(0);

    await page.locator('#dataset-select').selectOption('dataset:local-demo:current-ui');
    await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
    await expect(root).toContainText(REPO);
    await expect(root.locator('.community-annotation-pending')).toContainText('1 change not published');
    expect(productErrors(errors)).toEqual([]);
  });

  test('a dropped connection while publishing is never said as not published; a refused sign-in signs out and keeps the work', async ({ page }) => {
    await signedIn(page);
    const repository = await installAnnotationRepository(page, { config: config(), users: communityUsers() });
    const root = await openConnected(page);
    await pull(page);
    await fillProfile(page);
    await page.evaluate(async () => {
      const { getCommunityAnnotationSession } = await import('/assets/js/app/community-annotations/session.js');
      const session = getCommunityAnnotationSession();
      session.setFieldCategories('cell_type', ['alpha', 'beta', 'gamma']);
      session.vote('cell_type', 'beta', 'ghid_51_beta-1', 'down');
    });
    // The write leaves and the connection drops: GitHub may have it.
    repository.onMutation = () => 'abort';
    let modal = await syncModal(page);
    await modal.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(modal).toContainText('GitHub may already have applied this change');
    await modal.getByRole('button', { name: 'Close' }).first().click();
    await expect(root).toContainText(REPO);

    // GitHub refuses the sign-in (it expired), the operation id echoed as the Worker does.
    repository.onMutation = () => ({ status: 401, body: { error: 'Bad credentials' } });
    modal = await syncModal(page);
    await modal.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(root).toContainText('Your GitHub sign-in expired or was revoked');
    // Signed out here; the repository stays connected for this GitHub user and the vote stays.
    const kept = await page.evaluate(async () => {
      const { getAnnotationRepoForDataset } = await import('/assets/js/app/community-annotations/repo-store.js');
      const { getGitHubAuthSession } = await import('/assets/js/app/community-annotations/github-auth.js');
      return { repo: getAnnotationRepoForDataset('current-ui', 'ghid_4242'), signedIn: getGitHubAuthSession().isAuthenticated() };
    });
    expect(kept).toEqual({ repo: `${REPO}@main`, signedIn: false });
    // Signed in again (a reload restores the sign-in): connected, and the vote still waits to be published.
    repository.onMutation = null;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    const again = await openSection(page);
    await expect(again).toContainText(REPO);
    const vote = await page.evaluate(async () => {
      const { getCommunityAnnotationSession } = await import('/assets/js/app/community-annotations/session.js');
      const session = getCommunityAnnotationSession();
      session.setFieldCategories('cell_type', ['alpha', 'beta', 'gamma']);
      return session.getMyVoteDirect('cell_type', 'beta', 'ghid_51_beta-1');
    });
    expect(vote).toBe('down');
  });
});
