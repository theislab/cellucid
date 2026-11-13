/**
 * @fileoverview Exact gene-expression (var field) selector UI contract.
 *
 * @module ui/modules/field-selector-gene-expression
 */

import { createIntentPrefetcher } from '../../utils/intent-prefetch.js';
import { setControlAvailability } from '../core/control-availability.js';
import { getNotificationCenter } from '../../notification-center.js';
import { isCancellation, cancelled, cancellationKind } from '../../../utils/abort.js';
import {
  explainContinuousPayloadFailure,
} from '../../../data/continuous-payload-diagnosis.js';
import { FieldSource } from '../../utils/field-constants.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { createWindowedListbox } from '../components/windowed-listbox.js';
import { StateValidator } from '../../utils/state-validator.js';
import {
  GeneUnavailableError,
  describeUnavailableGene,
  rankGeneMatches,
  resolveExactGene,
  resolveTypedGene,
} from '../../utils/gene-lookup.js';
import { requireExactKeys } from '../../../utils/exact-record.js';
import { isReported } from '../../../utils/errors.js';
import { useOpenCells } from '../../../data/open-cells-work.js';
import { PLACES, placePath } from '../place-names.js';
import { describeUnshownField, unshownChoiceReason } from './field-interaction-owner.js';
import { quoteName } from '../../actions/targets/names.js';
import { getActions } from '../../actions/index.js';
import { ActionRefused } from '../../actions/dispatcher.js';
import { isQuietFailure } from '../../actions/control-dispatch.js';

const INIT_KEYS = new Set([
  'state',
  'interactionOwner',
  'dom',
  'callbacks',
  'obsDom',
  'noneFieldValue'
]);
const DOM_TYPES = new Map([
  ['geneContainer', 'HTMLElement'],
  ['geneSearch', 'HTMLInputElement'],
  ['geneDropdown', 'HTMLElement'],
  ['geneCopyBtn', 'HTMLButtonElement'],
  ['geneRenameBtn', 'HTMLButtonElement'],
  ['geneDeleteBtn', 'HTMLButtonElement'],
  ['geneClearBtn', 'HTMLButtonElement']
]);
const OBS_DOM_TYPES = new Map([
  ['categoricalSelect', 'HTMLSelectElement'],
  ['continuousSelect', 'HTMLSelectElement']
]);
const CALLBACK_KEYS = new Set([
  'onActiveFieldChanged',
  'onStartFieldRename',
  'onStartFieldDelete',
  'onBusyChanged',
  'onActivateField',
  'onAdoptDatasetGeneration',
  'onChooseGeneNames',
  'onDuplicateField',
  'onClearColoring'
]);
const RETURN_KEYS = new Set([
  'clearGeneSelection',
  'colorByGene',
  'clearLocalSelectionUI',
  'destroy',
  'initGeneExpressionDropdown',
  'isChoosing',
  'selectGene',
  'syncFromState',
  'updateGeneActionButtons'
]);

/* ---------------------------------------------------------------------------
   Empty-state copy for gene search.

   A dataset's gene panel is decided by whoever wrote its file. Nothing in the
   file records what was left out: there is no original gene count, no
   dropped-gene list, and no symbol table. The only gene fact the viewer holds
   is the panel it was handed — `state.varData`, whose entries are equal in
   number to the dataset identity's `stats.n_genes`.

   So this copy states that count, says the panel is fixed upstream, and stops
   there. It must never assert that a searched gene was removed, nor guess how
   many genes are absent: the app cannot know either one.
   --------------------------------------------------------------------------- */
const GENE_PANEL_HELP_URL = 'https://docs.cellucid.com/en/latest/'
  + 'user_guide/web_app/d_fields_coloring_legends/'
  + '05_troubleshooting_fields_legends.html'
  + '#symptom-gene-search-returns-nothing-enter-selects-the-wrong-gene';
const GENE_PANEL_HELP_LABEL = 'Why a gene may be missing';

function requireMethod(owner, methodName, label) {
  if (
    owner === null
    || typeof owner !== 'object'
    || typeof owner[methodName] !== 'function'
  ) {
    throw new TypeError(`${label} must implement ${methodName}()`);
  }
}

function requireError(error, label) {
  if (!(error instanceof Error)) {
    throw new TypeError(`${label} must reject with an Error`);
  }
  if (typeof error.message !== 'string' || error.message.length === 0) {
    throw new TypeError(`${label} Error must have a non-empty message`);
  }
  return error;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be exactly boolean`);
  }
  return value;
}

function requireIndex(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireActiveIndex(value, label) {
  if (!Number.isSafeInteger(value) || value < -1) {
    throw new TypeError(`${label} must be -1 or a non-negative safe integer`);
  }
  return value;
}

/**
 * Genes the dataset itself published, excluding every field created inside
 * Cellucid. Duplicates add entries to the inventory and deletions never remove
 * them, so this count stays equal to the file's gene axis for the whole
 * session.
 *
 * @param {ReadonlyArray<object>} inventory
 * @returns {number}
 */
function countPublishedGenes(inventory) {
  let published = 0;
  for (const field of inventory) {
    if (field._isUserDefined !== true) published += 1;
  }
  return published;
}

/**
 * What a gene search that finds nothing says: which list it searched (the
 * gene names of the file's var index, as many as the file holds, or the
 * column Data mapping names them by), and where another names column is
 * chosen. Nothing is guessed: no column is named but the one in use.
 *
 * @param {number} publishedGeneCount
 * @param {string|null} namesColumn - The var column naming the genes, null for the var index
 * @returns {string}
 */
function formatGenePanelNote(publishedGeneCount, namesColumn) {
  const source = namesColumn === null ? 'its var index' : `var['${namesColumn}']`;
  return `Searched the ${formatCountOf(publishedGeneCount, 'gene')} of this dataset, named by ${source}; `
    + 'another var column of the file (symbols) can name them instead.';
}

// The state's var inventory is checked field by field when it is published
// and as it grows (state/managers/field/overlay-internals.js `requireFields`),
// so the gene list reads it as it is: every gene list refresh walks the genes
// once, without checking each one again.
function requireVarInventory(value) {
  if (!Array.isArray(value)) {
    throw new TypeError('Var field inventory must be an array');
  }
  return value;
}

/**
 * Each gene's lower-cased name, kept while its name stays the same: a gene
 * list refresh after one rename lower-cases that one gene.
 * @type {WeakMap<object, {key: string, lower: string}>}
 */
const searchKeys = new WeakMap();

function searchKeyOf(field) {
  const known = searchKeys.get(field);
  if (known !== undefined && known.key === field.key) return known.lower;
  const lower = field.key.toLowerCase();
  searchKeys.set(field, { key: field.key, lower });
  return lower;
}

function requireVisibleVarEntries(value, inventory) {
  if (!Array.isArray(value)) {
    throw new TypeError('Visible var fields must be an array');
  }
  const entries = new Array(value.length);
  for (let entryIndex = 0; entryIndex < value.length; entryIndex++) {
    const entry = value[entryIndex];
    const index = entry?.index;
    // The entry is the inventory's own field at its own slot, so it is a
    // checked field.
    if (
      !Number.isSafeInteger(index)
      || index < 0
      || index >= inventory.length
      || inventory[index] !== entry.field
    ) {
      throw new Error(
        `Visible var fields[${entryIndex}] must reference its exact inventory slot`
      );
    }
    if (entry.field._isDeleted === true) {
      throw new Error('Visible var fields cannot contain a deleted field');
    }
    entries[entryIndex] = { field: entry.field, originalIdx: index };
  }
  return entries;
}

function requireFieldInfo(value, field) {
  requireExactKeys(
    value,
    new Set(['field', 'pointCount', 'centroidInfo']),
    'Activate var field result'
  );
  if (value.field !== field) {
    throw new Error(
      'Activate var field result.field must equal the selected gene'
    );
  }
  if (!Number.isSafeInteger(value.pointCount) || value.pointCount < 0) {
    throw new TypeError(
      'Activate var field result.pointCount must be a non-negative safe integer'
    );
  }
  if (value.centroidInfo !== '') {
    throw new TypeError(
      'Activate var field result.centroidInfo must be the empty string'
    );
  }
  return value;
}

export function initGeneExpressionSelector(options) {
  requireExactKeys(options, INIT_KEYS, 'Gene expression selector options');
  const {
    state,
    interactionOwner,
    dom,
    callbacks,
    obsDom,
    noneFieldValue
  } = options;
  for (const methodName of [
    'ensureVarFieldLoaded',
    'getDatasetGeneration',
    'getVarFields',
    'getVisibleFields',
    'locateVarField',
    'setActiveVarField'
  ]) {
    requireMethod(state, methodName, 'Gene expression selector state');
  }
  for (const methodName of [
    'assertCurrent',
    'isCurrent',
    'isSuspended',
    'retirementOf',
    'run',
    'suspensionReason',
    'track'
  ]) {
    requireMethod(
      interactionOwner,
      methodName,
      'Gene selector interaction owner'
    );
  }
  requireExactKeys(callbacks, CALLBACK_KEYS, 'Gene selector callbacks');
  for (const callbackName of CALLBACK_KEYS) {
    if (typeof callbacks[callbackName] !== 'function') {
      throw new TypeError(
        `Gene selector callbacks.${callbackName} must be a function`
      );
    }
  }
  if (noneFieldValue !== '-1') {
    throw new TypeError(
      'Gene selector noneFieldValue must be exactly "-1"'
    );
  }
  requireExactKeys(dom, new Set(DOM_TYPES.keys()), 'Gene selector DOM');
  requireExactKeys(
    obsDom,
    new Set(OBS_DOM_TYPES.keys()),
    'Gene selector obs DOM'
  );

  const ownerDocument = dom.geneSearch?.ownerDocument;
  const view = ownerDocument?.defaultView;
  if (view === null || view === undefined) {
    throw new TypeError(
      'Gene selector DOM must belong to a document with a window'
    );
  }
  for (const [name, constructorName] of [...DOM_TYPES, ...OBS_DOM_TYPES]) {
    const value = DOM_TYPES.has(name) ? dom[name] : obsDom[name];
    const Constructor = view[constructorName];
    if (
      typeof Constructor !== 'function'
      || !(value instanceof Constructor)
      || value.ownerDocument !== ownerDocument
    ) {
      throw new TypeError(
        `Gene selector ${name} must be one ${constructorName} from the shared document`
      );
    }
  }

  const {
    geneContainer,
    geneSearch,
    geneDropdown,
    geneCopyBtn,
    geneRenameBtn,
    geneDeleteBtn,
    geneClearBtn
  } = dom;
  const { categoricalSelect, continuousSelect } = obsDom;
  const lifecycle = new view.AbortController();
  let destroyed = false;
  let hasGeneExpressionFields = false;
  let geneFieldList = [];
  // Lower-cased keys, built once per inventory, so a keystroke filters a
  // 30,000-gene panel without allocating 30,000 strings.
  let geneSearchKeys = [];
  let publishedGeneCount = 0;
  let selectedGeneOriginalIdx = -1;
  // The gene being chosen (`selectGene`), with its choice's token: while it
  // is the latest choice, a refresh of the selector (the gene list
  // republished, another field's change) names it, not what is shown.
  let choosing = null;
  // Gene choices dispatched and not ended (`chooseGene`): the field menus
  // stay held while any is, and a refresh names the latest one's gene
  // (`queuedKey`) while its action waits its turn.
  let queuedChoices = 0;
  let queuedKey = null;
  let forceDisabled = false;

  /* The dropdown is rebuilt on every keystroke, so it cannot host the live
     region itself: a region that arrives with its own text is not reliably
     announced. This one is mounted once, beside the search box, and only its
     text changes. */
  const geneSearchStatus = ownerDocument.createElement('div');
  geneSearchStatus.className = 'sr-only';
  geneSearchStatus.setAttribute('role', 'status');
  geneSearchStatus.setAttribute('aria-live', 'polite');
  geneContainer.appendChild(geneSearchStatus);

  /* The search box and its results are one windowed combobox list
     (components/windowed-listbox.js): every match is listed, only the options
     near what is shown are built, and focus stays in the box while the arrow
     keys move the active option. */
  /** @type {Array<{ field: any, originalIdx: number }>} */
  let geneResults = [];

  geneSearch.setAttribute('aria-expanded', 'false');
  if (geneDropdown.getAttribute('id') !== null) {
    geneSearch.setAttribute('aria-controls', geneDropdown.getAttribute('id'));
  }
  geneDropdown.hidden = true;
  geneDropdown.setAttribute('aria-label', 'Matching genes');

  // Prefetch on intent (utils/intent-prefetch.js): the gene kept active or
  // under the pointer is loaded before it is chosen.
  const genePrefetch = createIntentPrefetcher((originalIdx, signal) => (
    interactionOwner.isSuspended()
      ? undefined
      : state.ensureVarFieldLoaded(originalIdx, { signal, priority: 'low' })
  ));
  const scheduleGenePrefetch = originalIdx => {
    if (!destroyed) genePrefetch.intend(originalIdx);
  };
  const cancelGenePrefetch = () => genePrefetch.cancel();

  const geneList = createWindowedListbox({
    input: geneSearch,
    listbox: geneDropdown,
    idPrefix: `${geneDropdown.getAttribute('id') ?? 'gene-expression-dropdown'}-option`,
    buildOption: index => buildGeneOption(geneResults[index]),
    onActive: index => scheduleGenePrefetch(geneResults[index].originalIdx),
    signal: lifecycle.signal,
  });

  function assertAlive() {
    if (destroyed) {
      throw new Error('Gene expression selector has been destroyed');
    }
  }

  /**
   * Report a gene that could not be shown, with the reason it could not be.
   *
   * This failure has a diagnosis worth writing out. `Failed to load gene: X` names the symptom and nothing
   * else — not whether the payload never arrived or arrived unusable, not what
   * was wrong with it, and not what to do. `explainContinuousPayloadFailure`
   * knows all three, and the notification center renders the newlines it uses.
   *
   * A refusal (the action's own sentence: a gene no longer on the list)
   * is said as information. The task is the dispatch (`chooseGene`): the
   * choice itself is owned by `interactionOwner` inside the action.
   *
   * @param {Promise<unknown>} task
   * @param {string} geneKey
   */
  function reportGeneSelectionFailure(task, geneKey) {
    if (
      task === null
      || typeof task !== 'object'
      || typeof task.then !== 'function'
      || typeof task.catch !== 'function'
    ) {
      throw new TypeError('Gene selector UI task must be a Promise');
    }
    if (typeof geneKey !== 'string' || geneKey.length === 0) {
      throw new TypeError('Gene selection failure requires the gene key.');
    }
    task.catch((error) => {
      // A cancellation or a newer choice is no failure; a failure the gene's
      // own loading card already said (`announceLoadFailure`) is not said twice.
      if (isQuietFailure(error) || isReported(error)) {
        return;
      }
      if (error instanceof ActionRefused) {
        sayUnshown(error.message);
        return;
      }
      const exactError = requireError(error, 'Gene selector UI task');
      console.error(exactError);
      getNotificationCenter().error(
        explainContinuousPayloadFailure({
          subject: { kind: 'gene', name: geneKey },
          error: exactError,
        }),
        { category: 'data', title: 'Gene cannot be shown' }
      );
    });
  }

  function readDatasetGeneration() {
    const generation = state.getDatasetGeneration();
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new TypeError(
        'Gene selector dataset generation must be a non-negative safe integer'
      );
    }
    return generation;
  }

  function readVarInventory() {
    return requireVarInventory(state.getVarFields());
  }

  function updateGeneActionButtons(nextForceDisabled = forceDisabled) {
    assertAlive();
    forceDisabled = requireBoolean(
      nextForceDisabled,
      'Gene selector forced-disabled state'
    );
    const hasSelection = selectedGeneOriginalIdx >= 0;
    const disableAll = forceDisabled || !hasGeneExpressionFields;
    geneCopyBtn.disabled = disableAll || !hasSelection;
    geneRenameBtn.disabled = disableAll || !hasSelection;
    geneDeleteBtn.disabled = disableAll || !hasSelection;
    geneClearBtn.disabled = forceDisabled || !hasSelection;
  }

  function initGeneExpressionDropdown() {
    assertAlive();
    const inventory = readVarInventory();
    geneFieldList = requireVisibleVarEntries(
      state.getVisibleFields(FieldSource.VAR),
      inventory
    );
    publishedGeneCount = countPublishedGenes(inventory);
    geneSearchKeys = geneFieldList.map(({ field }) => searchKeyOf(field));
    hasGeneExpressionFields = geneFieldList.length > 0;
    // A dataset just shown lists its genes after its first view: the search
    // says they are loading (or why they could not be read) until then.
    const pending = state.areGenesPending();
    const failure = hasGeneExpressionFields ? null : state.getGeneListFailure();
    geneContainer.hidden = !hasGeneExpressionFields && !pending && failure === null;
    geneContainer.setAttribute('aria-busy', String(pending));
    setControlAvailability(geneSearch, pending
      ? 'the gene names are being read; search once they are'
      : failure !== null ? 'the gene names could not be read; open the dataset again to retry' : null);
    geneSearch.placeholder = pending
      ? 'Reading gene names…'
      : failure !== null ? 'Gene names could not be read' : 'Search genes…';
    geneSearch.title = failure === null ? '' : failure.message;
    if (
      selectedGeneOriginalIdx >= 0
      && !geneFieldList.some(
        ({ originalIdx }) => originalIdx === selectedGeneOriginalIdx
      )
    ) {
      selectedGeneOriginalIdx = -1;
    }
    updateGeneActionButtons();
  }

  function buildGeneOption({ field, originalIdx }) {
    const item = ownerDocument.createElement('div');
    item.className = 'dropdown-item';
    if (originalIdx === selectedGeneOriginalIdx) {
      item.classList.add('selected');
    }
    let label = field.key;
    if (Object.hasOwn(field, '_originalKey')) {
      StateValidator.validateFieldKey(field._originalKey);
      label = `${field.key} *`;
      item.title = `Original: ${field._originalKey}`;
    }
    item.textContent = label;
    item.dataset.originalIdx = String(originalIdx);
    return item;
  }

  function renderGeneDropdownResults(query) {
    assertAlive();
    if (typeof query !== 'string') {
      throw new TypeError('Gene search query must be a string');
    }
    const normalizedQuery = query.toLowerCase().trim();
    // Best match first: Enter with no option active takes the first one.
    const filtered = normalizedQuery.length === 0
      ? geneFieldList
      : rankGeneMatches(geneSearchKeys, normalizedQuery).map(index => geneFieldList[index]);
    geneResults = filtered;

    if (filtered.length === 0) {
      const noResults = ownerDocument.createElement('div');
      if (normalizedQuery.length === 0) {
        noResults.className = 'dropdown-no-results';
        noResults.textContent = 'Type to search genes…';
        geneSearchStatus.textContent = '';
      } else {
        noResults.className = 'dropdown-no-results text-left';
        const headline = ownerDocument.createElement('div');
        headline.className = 'text-secondary font-semibold';
        headline.textContent = 'No gene matches';
        /* The query is the reader's own text and can be arbitrarily long, so it
           gets its own line and the shared truncation primitive rather than
           being allowed to push the sidebar sideways. */
        const echo = ownerDocument.createElement('div');
        echo.className = 'truncate';
        echo.textContent = `“${query.trim()}”.`;
        headline.appendChild(echo);
        const note = ownerDocument.createElement('div');
        note.className = 'mt-1';
        note.textContent = formatGenePanelNote(publishedGeneCount, state.varData?.geneNames?.source ?? null);
        const choose = ownerDocument.createElement('button');
        choose.type = 'button';
        choose.className = 'btn btn-compact';
        choose.textContent = 'Choose gene names…';
        choose.addEventListener('click', () => callbacks.onChooseGeneNames());
        const help = ownerDocument.createElement('a');
        help.className = 'text-link';
        help.href = GENE_PANEL_HELP_URL;
        help.target = '_blank';
        help.rel = 'noopener noreferrer';
        help.textContent = GENE_PANEL_HELP_LABEL;
        // The action and the explanation share one line, wrapping only
        // where the sidebar is too narrow for both.
        const actions = ownerDocument.createElement('div');
        actions.className = 'd-flex flex-wrap items-center gap-2 mt-1';
        actions.append(choose, help);
        noResults.append(headline, note, actions);
        /* Announced without the query, so extending a query that still finds
           nothing does not repeat the whole explanation on every keystroke. */
        geneSearchStatus.textContent = (
          `No gene matches your search. ${note.textContent}`
        );
      }
      geneList.showMessage(noResults);
    } else {
      geneSearchStatus.textContent = '';
      geneList.reset(filtered.length);
    }
  }

  function showGeneDropdown() {
    // Shown first, so the first page is laid out (and its row height
    // measured) as it is built.
    geneDropdown.hidden = false;
    geneSearch.setAttribute('aria-expanded', 'true');
    renderGeneDropdownResults(geneSearch.value);
  }

  function hideGeneDropdown() {
    geneDropdown.hidden = true;
    geneSearch.setAttribute('aria-expanded', 'false');
    geneList.setActive(-1);
  }

  /**
   * The gene at `originalIdx` of the gene list in use, as the field object of
   * the view in focus.
   *
   * Every view holds its own copies of the field objects (`_cloneVarData`;
   * `setActiveView` swaps them in), so the entries listed for the search name
   * a gene by position and key, never as the field to read: the field is
   * taken from the inventory in use when the gene is chosen: a field of the
   * view the list was built in would, after `view.keep`, make a gene chosen on
   * the kept view "no longer on the gene list" (`locateVarField` finds no such
   * object), not shown, and `color.by` would answer null.
   *
   * @param {number} originalIdx
   * @returns {{field: object, originalIdx: number}}
   */
  function findGeneEntry(originalIdx) {
    const index = requireIndex(originalIdx, 'Gene field index');
    const entry = geneFieldList.find(
      candidate => candidate.originalIdx === index
    );
    if (entry === undefined) {
      throw new RangeError(
        'Gene field index is absent from the visible gene inventory'
      );
    }
    const field = readVarInventory()[index];
    if (field === undefined || field._isDeleted === true) {
      throw new RangeError(
        'Gene field index is absent from the gene list in use'
      );
    }
    return { field, originalIdx: index };
  }

  function syncFromState() {
    assertAlive();
    const source = state.activeFieldSource;
    if (
      source !== null
      && source !== FieldSource.OBS
      && source !== FieldSource.VAR
    ) {
      throw new TypeError('Active field source must be exactly obs, var, or null');
    }
    const varIdx = requireActiveIndex(
      state.activeVarFieldIndex,
      'Active var field index'
    );
    const chosenAt = choiceUnderWay();
    if (source === FieldSource.VAR && varIdx < 0) {
      throw new Error('Active var source requires one active var index');
    }
    if (source !== FieldSource.VAR && varIdx !== -1) {
      throw new Error(
        'Inactive var source requires active var field index -1'
      );
    }
    if (chosenAt >= 0) {
      selectedGeneOriginalIdx = chosenAt;
      geneSearch.value = readVarInventory()[chosenAt].key;
    } else if (queuedKey !== null) {
      selectedGeneOriginalIdx = -1;
      geneSearch.value = queuedKey;
    } else if (source === FieldSource.VAR) {
      const inventory = readVarInventory();
      if (varIdx >= inventory.length) {
        throw new RangeError(
          'Active var field index is outside its exact inventory'
        );
      }
      selectedGeneOriginalIdx = varIdx;
      geneSearch.value = inventory[varIdx].key;
    } else {
      selectedGeneOriginalIdx = -1;
      geneSearch.value = '';
    }
    updateGeneActionButtons();
  }

  /**
   * Where the gene being chosen is on the gene list in use, while its choice
   * is the latest; -1 otherwise.
   * @returns {number}
   */
  function choiceUnderWay() {
    if (choosing === null || !interactionOwner.isCurrent(choosing.token)) return -1;
    return state.locateVarField(choosing.field);
  }

  /**
   * Whether a gene choice is under way: dispatched and waiting its turn
   * (`chooseGene`), or the latest choice and being read (`selectGene`). The
   * field selector holds its menus and shows no obs field while it is.
   * @returns {boolean}
   */
  function isChoosing() {
    return queuedChoices > 0
      || (choosing !== null && interactionOwner.isCurrent(choosing.token));
  }

  /**
   * Notify that a gene chosen is not shown, and why.
   * @param {string} message
   */
  function sayUnshown(message) {
    geneSearchStatus.textContent = message;
    getNotificationCenter().info(message, { category: 'data' });
  }

  /**
   * Color the cells by the gene at `originalIdx` of the gene list.
   *
   * The choice is work on the open cells (`data/open-cells-work.js`): one
   * made while a progressive opening's step or Apply changes them starts on
   * the cells after it, and no change commits under it. (Taking the dataset
   * generation when it is made, then waiting for the step under way, would find
   * the generation the step advanced: the gene would be read and never shown,
   * with nothing said.) Whatever keeps it from being shown is said,
   * except a newer choice, Cancel or another dataset.
   *
   * It is the implementation of the action `color.by` for a gene (the
   * field selector provides it): the controls dispatch the action.
   *
   * @param {number} originalIdx
   * @param {{signal?: AbortSignal|null, onUnshown?: ((message: string) => void)|null}} [options] -
   *   The action's signal; `onUnshown` hears the sentence said when the gene
   *   is not shown, its name marked as data (`quoteName`), so the action can
   *   refuse with it
   * @returns {Promise<Object|null>} The activation, or null when not shown
   */
  function selectGene(originalIdx, { signal = null, onUnshown = null } = {}) {
    assertAlive();
    const chosen = findGeneEntry(originalIdx);
    // `sentence(name)`: told the person with the gene's name, handed to the
    // action with it marked as data.
    const unshown = (key, sentence) => {
      sayUnshown(sentence(key));
      onUnshown?.(sentence(quoteName(key)));
    };
    if (interactionOwner.isSuspended()) {
      const reason = interactionOwner.suspensionReason();
      unshown(chosen.field.key, name => describeUnshownField(name, reason));
      return Promise.resolve(null);
    }
    return interactionOwner.run(async token => {
      let { field, originalIdx: index } = chosen;
      // A prefetch of this gene is shared by the load below; one of another
      // gene is no longer wanted.
      if (genePrefetch.current() !== index) cancelGenePrefetch();
      // The choice shows at once, while the cells it is read on settle.
      hideGeneDropdown();
      geneSearchStatus.textContent = '';
      selectedGeneOriginalIdx = index;
      categoricalSelect.value = noneFieldValue;
      continuousSelect.value = noneFieldValue;
      geneSearch.value = field.key;
      updateGeneActionButtons();
      // Named before the field selector is told, so the menus it renders
      // from the choices under way see this one.
      choosing = { token, field };
      callbacks.onBusyChanged(true);
      let datasetGeneration = null;
      // The gene list in use came to have no such gene.
      let gone = false;
      const chosenKey = field.key;
      // A gene of a subsample's cell-major matrix shows on more cells as
      // they are read (`showPartialVarField`); the colors of the field
      // shown come back if it is not shown in the end.
      let partial = false;
      try {
        return await useOpenCells(async () => {
          datasetGeneration = callbacks.onAdoptDatasetGeneration();
          // The gene list may be replaced before or while the gene is read
          // (Data mapping, applied by a person or because the values refuted
          // a default): the choice follows its gene to the list in use
          // (`DataState.locateVarField`) and reads it there.
          for (;;) {
            const at = state.locateVarField(field);
            if (at < 0) {
              gone = true;
              throw cancelled('superseded', 'The gene list in use has no such gene.');
            }
            if (at !== index || readVarInventory()[at] !== field) {
              index = at;
              field = readVarInventory()[at];
              choosing = { token, field };
              selectedGeneOriginalIdx = index;
              geneSearch.value = field.key;
            }
            try {
              await state.ensureVarFieldLoaded(index, {
                signal: token.signal,
                priority: 'high',
                onPartial: column => {
                  if (interactionOwner.isCurrent(token) && readDatasetGeneration() === datasetGeneration) {
                    partial = state.showPartialVarField(index, column) || partial;
                  }
                }
              });
            } catch (error) {
              // A load the list's replacement superseded: read the gene again
              // on the list in use. Anything else ends the choice.
              if (
                !isCancellation(error)
                || cancellationKind(error) === 'user'
                || !interactionOwner.isCurrent(token)
                || readDatasetGeneration() !== datasetGeneration
                || readVarInventory()[index] === field
              ) {
                throw error;
              }
              continue;
            }
            interactionOwner.assertCurrent(token);
            if (readDatasetGeneration() !== datasetGeneration) {
              throw cancelled('superseded', 'Field loading was superseded by a replacement dataset generation.');
            }
            if (readVarInventory()[index] === field) break;
          }
          const info = requireFieldInfo(
            state.setActiveVarField(index),
            field
          );
          callbacks.onActiveFieldChanged(info);
          return info;
        }, token.signal);
      } catch (error) {
        // Ended: a refresh names what is shown again.
        if (choosing?.token === token) choosing = null;
        const sameDataset = datasetGeneration === null || readDatasetGeneration() === datasetGeneration;
        if (partial && sameDataset && !isCancellation(error)) {
          state.restoreActiveFieldColors();
        }
        if (isCancellation(error)) {
          const reason = unshownChoiceReason(
            interactionOwner,
            token,
            error,
            sameDataset ? 'the gene list changed while it was read' : null
          );
          // Still the latest choice: the search names what is shown again.
          if (interactionOwner.isCurrent(token)) {
            selectedGeneOriginalIdx = -1;
            syncFromState();
          }
          if (gone && interactionOwner.isCurrent(token)) {
            unshown(chosenKey, name => `${name} is not shown: the gene list changed while it was read (${placePath(PLACES.session, PLACES.dataMapping)}) and no longer has it.`);
          } else if (reason !== null) {
            unshown(chosenKey, name => describeUnshownField(name, reason));
          }
          return null;
        }
        if (!interactionOwner.isCurrent(token)) return null;
        const selectionError = requireError(error, 'Gene selection');
        try {
          syncFromState();
        } catch (rollbackError) {
          throw new AggregateError(
            [
              selectionError,
              requireError(rollbackError, 'Gene selection rollback')
            ],
            'Gene selection and UI rollback failed'
          );
        }
        throw selectionError;
      } finally {
        if (choosing?.token === token) choosing = null;
        if (interactionOwner.isCurrent(token)) updateGeneActionButtons(false);
        // Ended, however (shown, failed, a newer choice, Stop, a session
        // restore): the field selector names and holds its menus from the
        // choices under way now.
        if (!destroyed) callbacks.onBusyChanged(false);
      }
    }, { signal });
  }

  /**
   * Color by the gene named `geneKey`, as a step (the action `color.by`):
   * resolves with what was shown, or null when another choice replaced it.
   *
   * @param {string} geneKey
   * @returns {Promise<Object|null>}
   */
  function chooseGene(geneKey) {
    // The choice shows at once, as it is made, while the action waits its
    // turn (a change of the open cells under way first: `cells.open`); the
    // field menus are held until it ends, as while its gene is read.
    hideGeneDropdown();
    geneSearchStatus.textContent = '';
    geneSearch.value = geneKey;
    queuedChoices++;
    queuedKey = geneKey;
    callbacks.onBusyChanged(true);
    return getActions().dispatch('color.by', { field: { source: FieldSource.VAR, key: geneKey } }).then(
      ({ outcome }) => outcome,
      error => {
        if (isQuietFailure(error)) return null;
        throw error;
      }
    ).finally(() => {
      queuedChoices--;
      if (queuedChoices === 0) queuedKey = null;
      if (destroyed || queuedChoices > 0 || choiceUnderWay() >= 0) return;
      syncFromState();
      callbacks.onBusyChanged(false);
    });
  }

  /** The gene list as the lookup reads it (`utils/gene-lookup.js`). */
  function geneListForLookup() {
    return {
      pending: state.areGenesPending(),
      failure: state.getGeneListFailure(),
    };
  }

  /**
   * Color the cells by the gene named `geneKey`, exactly as choosing it in
   * this list does: how a gene picked elsewhere (an analysis result) is
   * shown, so the search box always names the gene the cells show. A name
   * the list cannot choose (still being read, or not a gene of it) rejects
   * with a `GeneUnavailableError` that says why.
   *
   * @param {string} geneKey
   * @returns {Promise<Object|null>} As `chooseGene`
   */
  function colorByGene(geneKey) {
    assertAlive();
    if (typeof geneKey !== 'string' || geneKey.length === 0) {
      throw new TypeError('Gene to color by must be its exact key');
    }
    const list = geneListForLookup();
    const outcome = resolveExactGene(geneKey, {
      keys: geneFieldList.map(entry => entry.field.key),
      ...list,
    });
    if (outcome.kind !== 'match') {
      return Promise.reject(new GeneUnavailableError(geneKey, outcome, list.failure));
    }
    return chooseGene(geneFieldList[outcome.position].field.key);
  }

  async function clearGeneSelection() {
    assertAlive();
    selectedGeneOriginalIdx = -1;
    geneSearch.value = '';
    updateGeneActionButtons();
    try {
      return await callbacks.onActivateField(-1);
    } catch (error) {
      const clearError = requireError(error, 'Gene selection clear');
      try {
        syncFromState();
      } catch (rollbackError) {
        throw new AggregateError(
          [
            clearError,
            requireError(rollbackError, 'Gene selection clear rollback')
          ],
          'Gene selection clear and UI rollback failed'
        );
      }
      throw clearError;
    }
  }

  function clearLocalSelectionUI() {
    assertAlive();
    // A gene being chosen stays named until its choice ends.
    if (choiceUnderWay() >= 0) return;
    selectedGeneOriginalIdx = -1;
    geneSearch.value = '';
    updateGeneActionButtons();
  }

  geneCopyBtn.addEventListener('click', () => {
    if (selectedGeneOriginalIdx >= 0) {
      callbacks.onDuplicateField(FieldSource.VAR, selectedGeneOriginalIdx);
    }
  }, { signal: lifecycle.signal });
  geneRenameBtn.addEventListener('click', () => {
    if (selectedGeneOriginalIdx >= 0) {
      callbacks.onStartFieldRename(
        FieldSource.VAR,
        selectedGeneOriginalIdx,
        geneSearch
      );
    }
  }, { signal: lifecycle.signal });
  geneDeleteBtn.addEventListener('click', () => {
    if (selectedGeneOriginalIdx >= 0) {
      callbacks.onStartFieldDelete(
        FieldSource.VAR,
        selectedGeneOriginalIdx
      );
    }
  }, { signal: lifecycle.signal });
  geneClearBtn.addEventListener('click', () => {
    callbacks.onClearColoring();
  }, { signal: lifecycle.signal });

  geneDropdown.addEventListener('pointerover', (event) => {
    const item = event.target instanceof view.Element
      ? event.target.closest('.dropdown-item[data-original-idx]')
      : null;
    if (item === null || !geneDropdown.contains(item)) return;
    scheduleGenePrefetch(Number(item.dataset.originalIdx));
  }, { signal: lifecycle.signal });

  // Options carry no listeners: the list handles the click.
  geneDropdown.addEventListener('click', (event) => {
    const item = event.target instanceof view.Element
      ? event.target.closest('.dropdown-item[data-original-idx]')
      : null;
    if (item === null || !geneDropdown.contains(item)) return;
    const entry = findGeneEntry(Number(item.dataset.originalIdx));
    reportGeneSelectionFailure(chooseGene(entry.field.key), entry.field.key);
  }, { signal: lifecycle.signal });

  geneSearch.addEventListener('focus', () => {
    geneSearch.select();
    showGeneDropdown();
  }, { signal: lifecycle.signal });
  geneSearch.addEventListener('input', () => {
    showGeneDropdown();
  }, { signal: lifecycle.signal });
  geneSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // Given up: the box names the gene shown again (or the choice under
      // way), and what was said of the name typed goes with it.
      hideGeneDropdown();
      geneSearchStatus.textContent = '';
      syncFromState();
      geneSearch.blur();
      return;
    }
    if (geneList.handleKeydown(event, {
      isOpen: () => !geneDropdown.hidden,
      open: showGeneDropdown,
    })) {
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault?.();
    // Enter chooses the active option; with none active, the best match for
    // what is typed (`rankGeneMatches`: the gene itself, then names starting
    // with it), read from the box itself, so a paste or a value set without
    // a keystroke chooses what it says. A name that chooses nothing is said.
    const active = geneList.getActiveIndex();
    if (active >= 0 && geneResults[active] !== undefined) {
      const entry = geneResults[active];
      reportGeneSelectionFailure(chooseGene(entry.field.key), entry.field.key);
      return;
    }
    const query = geneSearch.value;
    const list = geneListForLookup();
    const outcome = resolveTypedGene(query, { loweredKeys: geneSearchKeys, ...list });
    if (outcome.kind === 'empty') return;
    if (outcome.kind !== 'match') {
      if (geneDropdown.hidden) showGeneDropdown();
      geneSearchStatus.textContent = describeUnavailableGene(query, outcome, list.failure);
      return;
    }
    const entry = geneFieldList[outcome.position];
    reportGeneSelectionFailure(chooseGene(entry.field.key), entry.field.key);
  }, { signal: lifecycle.signal });
  // Left (a click elsewhere, Tab), the box names what is shown -- the gene,
  // the choice under way, or nothing -- never text that chose no gene; a
  // choice is made only by Enter or the list (whose click follows this).
  geneSearch.addEventListener('blur', () => {
    syncFromState();
  }, { signal: lifecycle.signal });

  ownerDocument.addEventListener('click', (event) => {
    if (!(event.target instanceof view.Node)) {
      throw new TypeError('Gene selector click target must be a Node');
    }
    if (
      !geneSearch.contains(event.target)
      && !geneDropdown.contains(event.target)
    ) {
      hideGeneDropdown();
    }
  }, { signal: lifecycle.signal });

  function destroy() {
    if (destroyed) return;
    cancelGenePrefetch();
    destroyed = true;
    lifecycle.abort();
    geneDropdown.replaceChildren();
    geneSearchStatus.remove();
  }

  const api = {
    initGeneExpressionDropdown,
    selectGene,
    colorByGene,
    clearGeneSelection,
    clearLocalSelectionUI,
    isChoosing,
    syncFromState,
    updateGeneActionButtons,
    destroy
  };
  requireExactKeys(api, RETURN_KEYS, 'Gene selector API');
  return api;
}
