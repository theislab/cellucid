/**
 * @fileoverview The community consensus column: building it, and telling
 * whether one built is still the consensus.
 *
 * Building turns the per-category consensus the session computes into a
 * user-defined categorical field through the `field.consensus` action (a
 * step of the history like any other): its parameters name the outcome of
 * each category (an agreed label, disputed or pending), the rule it was
 * built with and where the votes came from, and the action derives the cells'
 * codes from the annotated column (`community-annotations/consensus-codes.js`),
 * so the step replays by name on another dataset with the same column.
 *
 * The session is keyed on the dataset's names of the column and its
 * categories (`community-annotations/field-names.js`): a local rename is a
 * display name only. The step names the column and its categories as shown.
 *
 * A column built is a snapshot: a Pull (or a vote) that changes the
 * consensus of its column makes it **stale** (`consensusColumnStatus`); the
 * panel says so and offers to build it again under its name.
 *
 * @module ui/modules/community-annotation/consensus-column
 */

import { annotationCategories, annotationKeyable, annotationFieldKey, fieldByAnnotationKey } from '../../../community-annotations/field-names.js';
import { categoryLabel } from '../../../actions/targets/names.js';
import { exactLabelForCompare } from '../../../community-annotations/wire-contract.js';
import { failureDetails, joinFailure, sayFailure } from '../../../../utils/errors.js';

/**
 * Where the votes the session holds came from: the repository and branch it
 * is connected to (`owner/name@branch`) and when it was last pulled.
 * @param {object} session
 * @returns {{repository: string|null, branch: string|null, commit: string|null, pulledAt: string|null}}
 */
export function consensusProvenanceOf(session) {
  const ref = typeof session.getRepoRef === 'function' ? session.getRepoRef() : null;
  const text = typeof ref === 'string' && ref.length > 0 ? ref : null;
  const at = text === null ? -1 : text.indexOf('@');
  const pulledAt = session.getLastPullAt();
  return {
    repository: text === null ? null : (at === -1 ? text : text.slice(0, at)) || null,
    branch: at === -1 ? null : text.slice(at + 1) || null,
    // The commit pulled is not known to the session yet.
    commit: null,
    pulledAt: typeof pulledAt === 'string' && pulledAt.length > 0 ? pulledAt : null,
  };
}

/**
 * The consensus rule of a column: the one its repository sets for it, else
 * the session's defaults (`session.getAnnotatableConsensusSettings`).
 * @param {object} session
 * @param {string} fieldKey - the dataset's key of the column
 * @returns {{minAnnotators: number, threshold: number}}
 */
export function repositoryConsensusSettings(session, fieldKey) {
  const settings = session.getAnnotatableConsensusSettings?.(fieldKey) ?? null;
  if (settings !== null) return { minAnnotators: settings.minAnnotators, threshold: settings.threshold };
  // A column the repository gives no rule: the rule `computeConsensus` applies then
  // (`session.js` DEFAULT_MIN_ANNOTATORS, DEFAULT_CONSENSUS_THRESHOLD).
  return { minAnnotators: 1, threshold: 0.5 };
}

/** The default name of a column's consensus column: `community_<column as shown>`. */
export function defaultConsensusColumnKey(field) {
  return `community_${field.key}`;
}

/**
 * The outcome of each category of the column `fieldKey` now, in the
 * dataset's names, as `{category, status, label, voters}`.
 * @param {object} session
 * @param {string} fieldKey
 * @param {unknown[]} originalCategories
 * @param {{minAnnotators: number, threshold: number}} settings
 */
function outcomesNow(session, fieldKey, originalCategories, settings) {
  return originalCategories.map((category, index) => {
    const result = session.computeConsensus(fieldKey, index, settings);
    const status = result.status === 'consensus' && result.label ? 'consensus' : result.status === 'disputed' ? 'disputed' : 'pending';
    return { category: categoryLabel(category), status, label: status === 'consensus' ? result.label : null, voters: result.voters ?? 0 };
  });
}

/**
 * The consensus columns built on the open dataset, each with whether its
 * consensus still holds: `stale` when the session's consensus of its column
 * (under the rule it was built with) gives another outcome to some category
 * now, `missing` when its column is not shown here. Cheap (one consensus per
 * category); the panel asks on each of its renders, which follow every
 * change of the session (a Pull, a vote).
 *
 * @param {{getFields: () => object[]}} state
 * @param {object} session
 * @returns {Array<{key: string, fieldKey: string, of: string|null, stale: boolean, missing: boolean, changed: number}>}
 */
export function consensusColumnStatus(state, session) {
  const out = [];
  for (const column of state.getFields?.() ?? []) {
    const operation = column?._operation;
    if (column?._isUserDefined !== true || column._isDeleted === true || operation?.type !== 'community-consensus') continue;
    if (!Array.isArray(operation.outcomes) || operation.settings === undefined) continue;
    const source = fieldByAnnotationKey(state, operation.fieldKey);
    if (source === null || !session.isFieldAnnotated?.(operation.fieldKey)) {
      out.push({ key: column.key, fieldKey: operation.fieldKey, of: source?.field.key ?? null, stale: false, missing: source === null, changed: 0 });
      continue;
    }
    const categories = annotationCategories(source.field);
    // Categories the repository cannot key (`annotationKeyable`): nothing it holds is of them.
    if (!annotationKeyable(categories)) continue;
    session.setFieldCategories(operation.fieldKey, categories);
    const now = outcomesNow(session, operation.fieldKey, categories, operation.settings);
    const built = new Map(operation.outcomes.map(entry => [entry.category, entry]));
    let changed = 0;
    for (const entry of now) {
      const before = built.get(entry.category);
      const beforeStatus = before?.status ?? 'pending';
      const beforeLabel = before?.label ?? null;
      if (beforeStatus !== entry.status || exactLabelForCompare(beforeLabel) !== exactLabelForCompare(entry.label)) changed++;
    }
    out.push({ key: column.key, fieldKey: operation.fieldKey, of: source.field.key, stale: changed > 0, missing: false, changed });
  }
  return out;
}

/**
 * @param {object} deps
 * @param {object} deps.state Visualization state manager.
 * @param {object} deps.session Community annotation session singleton.
 * @param {object} deps.notifications Notification center.
 * @param {{dispatch: Function}|null} deps.actions The action dispatcher the column is built through
 *   (the controls' own, injected); null for controls that are not the page's own (they build none).
 * @returns {(readSettings: () => {sourceFieldKey: string|null, columnKey: string, minAnnotators: number, threshold: number}) => Promise<void>}
 *   `applyConsensusColumn`; `sourceFieldKey` is the dataset's key of the annotated column
 */
export function createConsensusColumnApplier({ state, session, notifications, actions }) {
  if (
    (actions !== null && typeof actions?.dispatch !== 'function') ||
    state === null ||
    typeof state !== 'object' ||
    session === null ||
    typeof session !== 'object' ||
    notifications === null ||
    typeof notifications !== 'object'
  ) {
    throw new TypeError(
      'The community consensus column requires the visualization state, the annotation session, the notification center and the action dispatcher'
    );
  }

  async function applyConsensusColumn(readSettings) {
    if (typeof readSettings !== 'function') {
      throw new TypeError(
        'Building the community consensus column requires a settings reader'
      );
    }
    const { sourceFieldKey, columnKey } = readSettings();
    if (!sourceFieldKey) return;
    if (actions === null) {
      notifications.error('The consensus column is built from the page\'s own Community annotation controls.', { category: 'annotation' });
      return;
    }
    const targetKey = String(columnKey || '').trim();
    if (!targetKey) {
      notifications.error('Consensus column key is required', { category: 'annotation', duration: 2600 });
      return;
    }

    const found = fieldByAnnotationKey(state, sourceFieldKey);
    if (found === null || found.field.kind !== 'category') return;

    try {
      await state.ensureFieldLoaded?.(found.index, { silent: true });
    } catch (err) {
      notifications.error(`${joinFailure(`The field for the consensus could not be loaded`, sayFailure(err))}`, { category: 'annotation', ...failureDetails(err) });
      return;
    }

    const field = state.getFields?.()?.[found.index] || null;
    const shown = Array.isArray(field?.categories) ? field.categories : [];
    if (!shown.length) return;
    const fieldKey = annotationFieldKey(field);
    const originalCategories = annotationCategories(field);
    session.setFieldCategories(fieldKey, originalCategories);

    // Read after the column is loaded: the rule in force at that moment.
    const { minAnnotators, threshold } = readSettings();
    const settings = { minAnnotators, threshold };
    const now = outcomesNow(session, fieldKey, originalCategories, settings);
    // The step names the categories as shown (as every action does), so it replays by name.
    const mapping = now.map((entry, index) => ({ ...entry, category: categoryLabel(shown[index]) }));

    const { outcome } = await actions.dispatch('field.consensus', {
      key: targetKey,
      field: { source: 'obs', key: field.key },
      mapping,
      settings,
      provenance: consensusProvenanceOf(session),
    });

    const suffix = outcome.replaced || outcome.name === targetKey ? '' : ` (created as "${outcome.name}")`;
    notifications.success(`Updated consensus column: ${outcome.name}${suffix}`, { category: 'annotation', duration: 2600 });
  }

  return applyConsensusColumn;
}
