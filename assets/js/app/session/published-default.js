/**
 * @fileoverview A dataset's published starting view, and the publish step
 * that makes one from a saved session.
 *
 * A starting view (the `session` a dataset catalog names, applied when the
 * dataset opens from it, `catalog-default-session.js`) is a format-4
 * session file with **one tracker of one root and no content a person
 * made**: the state the dataset opens in, not a history. Its profile
 * ({@link assertPublishedDefaultProfile}) is checked on the manifest before
 * any chunk is read:
 *
 * - one tracker of one branch, whose root is its head and its only step (no
 *   step was ever made: `nextStep` 1), with no journal and no conversation;
 * - every chunk eager (the root's values are all it holds);
 * - its page chrome (the selection tool) as the capture carried it;
 * - no `source` (it ships beside its dataset), no `cells` and no `genes`
 *   (it is captured on every cell and applies to any subsample of its
 *   dataset, `verifySessionFingerprint`);
 * - its root holds no `cells` (the cells open are the person's choice) and
 *   no `layout`: the person's own panels, sidebar and theme stay theirs; its
 *   viewer background is not applied either ({@link keepShownControls}).
 *
 * Publishing ({@link trimToPublishedDefault}) turns a Save of the dataset
 * into that file: the active tracker's head becomes the one root, every step
 * and conversation goes, and the fingerprint is bound to the identity the
 * catalog serves the dataset under ({@link rebindPublishedDefaultFingerprint}).
 * It refuses, naming it, a capture whose steps made content: highlights, gene
 * sets, a camera path, cells hidden one by one, or field and category edits
 * (renames, deleted fields, user-defined fields) — the domains of
 * {@link STARTING_VIEW_CONTENT_DOMAINS} must hold at the head the value they
 * held at the tracker's root, the dataset as it opened. Dropping the steps is
 * the point of publishing; dropping content would lose it silently, so it is
 * refused instead.
 *
 * The publishing repository (`cellucid-datasets`,
 * `scripts/publish_session_preset.mjs`) imports these functions rather than
 * restating the rule, so what it publishes is what this app accepts.
 *
 * @module session/published-default
 */

import { readHistoryFile, valuesAtStep, writeHistoryFile } from './history-file.js';
import { assertDatasetFingerprint } from './session-context.js';
import { domainDescription } from '../actions/domains.js';
import { FIRST_BRANCH_ID, ROOT_STEP_ID, createBy, createTracker } from '../history/model.js';

/** The domains a starting view may not change from the dataset as it opened: what a person makes. */
export const STARTING_VIEW_CONTENT_DOMAINS = Object.freeze([
  'field-overlays', 'gene-sets', 'visibility', 'highlights', 'camera-path',
]);

/**
 * The domains a starting view does not hold: which cells are open (the
 * person's or the link's choice; a starting view applies to any subsample of
 * its dataset), the Expression values the genes are shown in (the person's
 * setting, as stored until they choose: `app/state/domains/expression.js`)
 * and the person's own workspace.
 */
export const STARTING_VIEW_OMITTED_DOMAINS = Object.freeze(['cells', 'expression', 'layout']);

/**
 * The settings a starting view holds but leaves as shown: the viewer's
 * background, the person's own look as the theme is (a background never
 * chosen follows the theme, `rendering/viewer-backgrounds.js`
 * `backgroundForTheme`). The settings value lists every
 * control, so the file still holds one; it is not applied.
 */
export const STARTING_VIEW_SHOWN_CONTROL_IDS = Object.freeze(['background-select']);

/**
 * The starting view's values with {@link STARTING_VIEW_SHOWN_CONTROL_IDS} as
 * shown now: the `keepShown` of `history.showValues`.
 *
 * @param {Record<string, unknown>} values the root's values, by domain
 * @param {(domainId: string) => any} shownOf a domain's value as shown now
 * @returns {Record<string, unknown>}
 */
export function keepShownControls(values, shownOf) {
  if (!Object.hasOwn(values, 'settings')) return values;
  const shown = shownOf('settings').controls;
  const controls = { ...values.settings.controls };
  for (const id of STARTING_VIEW_SHOWN_CONTROL_IDS) {
    if (Object.hasOwn(controls, id)) controls[id] = shown[id];
  }
  return { ...values, settings: { ...values.settings, controls } };
}

/** The name of a starting view's one tracker. */
const STARTING_VIEW_TRACKER_NAME = 'Starting view';

function refuse(what) {
  return new TypeError(`This is not a starting view: ${what}`);
}

/**
 * Check that a format-4 manifest (already checked as a session file,
 * `assertHistoryManifest`) is a starting view: what the app's starting-view
 * restore and the publish step both run.
 *
 * @param {object} manifest
 * @returns {object} the same manifest
 */
export function assertPublishedDefaultProfile(manifest) {
  if (manifest.source !== null) throw refuse('it names a source; a starting view ships beside its dataset.');
  if (Object.hasOwn(manifest, 'cells') || Object.hasOwn(manifest, 'genes')) {
    throw refuse('it names the cells it was saved on; a starting view applies to every cell.');
  }
  if (manifest.trackers.length !== 1) throw refuse(`it holds ${manifest.trackers.length} trackers, not one.`);
  const [tracker] = manifest.trackers;
  if (tracker.headId !== ROOT_STEP_ID || tracker.nextStep !== 1 || tracker.branches.length !== 1) {
    throw refuse('it holds steps; a starting view is one state.');
  }
  if (tracker.chats.length !== 0) throw refuse('it holds a conversation.');
  if (tracker.journal !== null) throw refuse('it holds Recently deleted.');
  if (manifest.chunks.some(chunk => chunk.priority !== 'eager')) throw refuse('it holds values beyond its one state.');
  return manifest;
}

/**
 * Check a starting view's one root, once its steps are read: it holds no
 * value of a domain a starting view leaves to the person.
 *
 * @param {{after: Record<string, string>}} root
 * @returns {object} the same root
 */
export function assertPublishedDefaultRoot(root) {
  const omitted = STARTING_VIEW_OMITTED_DOMAINS.filter(id => Object.hasOwn(root.after, id));
  if (omitted.length > 0) throw refuse(`it sets ${omitted.map(domainLabel).join('; ')}, which stay the person's own.`);
  return root;
}

/**
 * Bind a capture's fingerprint to the identity it will be published under.
 *
 * A starting view is authored by opening the dataset and framing a view,
 * often from a locally served or differently named copy. The published file
 * must name the dataset it ships beside, because the app compares the
 * dataset id: a starting view carrying another id would be refused every
 * time the sample is opened. Renaming is safe only because the fields that
 * describe the data are *verified* rather than replaced; a mismatch means
 * the capture was taken against other data, and is refused, naming the
 * field. `cellOrder.digest` is carried from the capture: the publishing
 * repository recomputes it from the published coordinates before calling
 * here.
 *
 * @param {object} captured - the capture's `datasetFingerprint`
 * @param {object} published - the fingerprint the dataset is served under
 * @returns {object} the fingerprint the starting view carries
 */
export function rebindPublishedDefaultFingerprint(captured, published) {
  assertDatasetFingerprint(captured, 'Captured dataset fingerprint');
  assertDatasetFingerprint(published, 'Published dataset fingerprint');
  if (typeof published.datasetId !== 'string' || published.datasetId === '') {
    throw new TypeError('A starting view must name the dataset it ships beside.');
  }
  const describing = /** @type {const} */ ([
    [fingerprint => fingerprint.cellCount, 'cell count'],
    [fingerprint => fingerprint.varCount, 'gene count'],
    [fingerprint => JSON.stringify(fingerprint.cellOrder.embedding), 'cell-order embedding'],
    [fingerprint => fingerprint.cellOrder.dimension, 'embedding dimension'],
    [fingerprint => fingerprint.cellOrder.digest, 'cell-order digest'],
    [fingerprint => JSON.stringify(fingerprint.dataMapping), 'data mapping'],
  ]);
  for (const [read, label] of describing) {
    if (read(captured) !== read(published)) {
      throw new Error(
        `This capture cannot be published as "${published.datasetId}": it was taken against data with a `
        + `${label} of ${JSON.stringify(read(captured))}, and that dataset publishes ${JSON.stringify(read(published))}. `
        + 'Publishing renames a capture; it cannot restate what the capture was taken against. '
        + 'Capture the view again on the dataset being published.'
      );
    }
  }
  return {
    datasetId: published.datasetId,
    name: published.name,
    cellCount: captured.cellCount,
    varCount: captured.varCount,
    cellOrder: {
      embedding: structuredClone(captured.cellOrder.embedding),
      dimension: captured.cellOrder.dimension,
      digest: captured.cellOrder.digest,
    },
    dataMapping: structuredClone(captured.dataMapping),
  };
}

function domainLabel(id) {
  return domainDescription(id).replace(/\.$/, '').toLowerCase();
}

/**
 * Turn a Save of a dataset into its starting view, or refuse.
 *
 * @param {Blob} source - a `.cellucid-session` written by Save
 * @param {object} publishedIdentity - the fingerprint the dataset is served
 *   under, in the shape `getDatasetFingerprint()` produces
 * @returns {Promise<Blob>} the starting view
 */
export async function trimToPublishedDefault(source, publishedIdentity) {
  // Checked first, so a caller that omitted the identity is told so.
  assertDatasetFingerprint(publishedIdentity, 'Published dataset fingerprint');
  const { manifest: header, history, values } = await readHistoryFile(source);
  const tracker = history.trackers.find(candidate => candidate.id === history.activeTracker);
  const rootValues = tracker.steps.find(step => step.id === ROOT_STEP_ID).after;
  const headValues = valuesAtStep(tracker.steps, tracker.headId);
  const made = STARTING_VIEW_CONTENT_DOMAINS.filter(id => headValues[id] !== rootValues[id]);
  if (made.length > 0) {
    throw new Error(
      `Publishing would carry content made in the capture (${made.map(domainLabel).join('; ')}). `
      + 'A starting view holds no content a person made. Undo it in the application, or capture the '
      + 'view again on the dataset as it opens, then publish.'
    );
  }
  const at = Date.parse(header.createdAt);
  const after = Object.fromEntries(Object.entries(headValues).filter(([id]) => !STARTING_VIEW_OMITTED_DOMAINS.includes(id)));
  const fingerprint = rebindPublishedDefaultFingerprint(header.datasetFingerprint, publishedIdentity);
  const view = createTracker({
    id: tracker.id,
    name: STARTING_VIEW_TRACKER_NAME,
    dataset: { id: fingerprint.datasetId, name: fingerprint.name, cellOrder: fingerprint.cellOrder },
    createdAt: at,
    by: createBy({ origin: 'startup' }),
    rootValues: after,
  });
  return writeHistoryFile({
    header: { createdAt: header.createdAt, datasetFingerprint: fingerprint, source: null, requires: header.requires },
    // The page chrome the capture carried (its selection tool), as it was.
    chrome: header.chrome,
    // What wrote the capture wrote this: the starting view holds no step, so no action.
    app: header.app,
    actions: [],
    scope: {
      trackers: [view.id], branches: [{ tracker: view.id, branches: [FIRST_BRANCH_ID] }], content: 'history', results: 'include',
      notes: false, chats: false, journal: false, times: 'exact', source: 'name',
    },
    history: { activeTracker: view.id, trackers: [view] },
    valueOf: hash => values.get(hash),
  });
}
