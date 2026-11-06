/**
 * The catalogue is complete on a real page: once a dataset is open, every
 * action of the catalogue has its implementation (`getActions().provide`
 * by the module that owns the state), every state domain has its owner
 * (`getStateDomains().provide`), and every method of the live DataState and
 * of the live viewer is classified (`app/actions/classification.js`), the
 * same lists the Node contracts read from the sources. An action defined
 * without an implementation, a domain without an owner or a method added
 * without a classification fails here, by name.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { waitForDatasetReady, waitForPageAtRest } from './helpers/dataset-ready.mjs';
import { waitForHistory } from './helpers/state-history.mjs';

const FIXTURE_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui`;

test('once a dataset is open, every action is provided, every domain owned and every method classified', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await waitForDatasetReady(page, 120);
  await waitForHistory(page);
  await waitForPageAtRest(page);

  const facts = await page.evaluate(async () => {
    const { getActions, getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint } = await import('/assets/js/app/state/domains/fingerprint.js');
    const {
      DATA_STATE_METHODS, VIEWER_METHODS, unclassified, staleClassifications,
    } = await import('/assets/js/app/actions/classification.js');
    const state = window._cellucidState;
    const prototype = Object.getPrototypeOf(state);
    const stateNames = Object.getOwnPropertyNames(prototype).filter(name => name !== 'constructor' && !name.startsWith('_'));
    const viewerNames = Object.keys(window._cellucidViewer);
    const first = await stateFingerprint(getStateDomains());
    const second = await stateFingerprint(getStateDomains());
    const unprovided = getActions().unprovided();
    return {
      unprovided,
      missing: getStateDomains().missing(),
      catalogue: getActions().catalog.list().length,
      unclassifiedState: unclassified(stateNames, DATA_STATE_METHODS),
      staleState: staleClassifications(stateNames, DATA_STATE_METHODS),
      unclassifiedViewer: unclassified(viewerNames, VIEWER_METHODS),
      staleViewer: staleClassifications(viewerNames, VIEWER_METHODS),
      viewerCount: viewerNames.length,
      stable: first.digest === second.digest,
    };
  });

  expect(facts.catalogue).toBeGreaterThan(100);
  expect(facts.unprovided, 'actions of the catalogue with no implementation on the page: provide each from the module that owns its state (getActions().provide)').toEqual([]);
  expect(facts.missing, 'state domains with no owner on the page: provide each from the module that owns it (getStateDomains().provide)').toEqual([]);
  expect(facts.unclassifiedState, 'DataState methods with no classification: add each to DATA_STATE_METHODS (app/actions/classification.js)').toEqual([]);
  expect(facts.staleState, 'classified DataState methods the page does not have: remove them from DATA_STATE_METHODS').toEqual([]);
  expect(facts.unclassifiedViewer, 'viewer methods with no classification: add each to VIEWER_METHODS (app/actions/classification.js)').toEqual([]);
  expect(facts.staleViewer, 'classified viewer methods the page does not have: remove them from VIEWER_METHODS').toEqual([]);
  expect(facts.viewerCount).toBeGreaterThan(100);
  expect(facts.stable, 'a page at rest has one fingerprint').toBe(true);
  expect(errors).toEqual([]);
});
