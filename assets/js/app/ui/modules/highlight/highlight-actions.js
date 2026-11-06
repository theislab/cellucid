/**
 * @fileoverview The implementation of the highlight actions
 * (`app/actions/definitions/highlights.js`): pages and groups named by their
 * names, cells by original position, applied through the highlight state's
 * own methods.
 *
 * Every control of the Highlighting panel, the selection tools' Confirm, the
 * legend's highlight toggle, the X key and the viewer host's highlight
 * commands dispatch these; nothing else changes highlight pages or groups
 * except a dataset's publication and a restore (session, history).
 *
 * Names are kept unique so they stay names: a page is never made or renamed
 * to the name of another, and a group added under a label already on its
 * page gets " (2)", " (3)", ….
 *
 * @module ui/modules/highlight/highlight-actions
 */

import { getActions } from '../../../actions/index.js';
import { dispatchFromControl } from '../../../actions/control-dispatch.js';
import { ActionRefused } from '../../../actions/dispatcher.js';
import { resolveCategory, resolveField } from '../../../actions/targets/fields.js';
import { resolveGroup, resolvePage } from '../../../actions/targets/pages.js';
import { formatCountOf } from '../../../../utils/format-units.js';
import { cellListsEqual } from '../../../utils/cell-set.js';
import { PLACES, placePath } from '../../place-names.js';
import { quoteName } from '../../../actions/targets/names.js';

function refuse(message) {
  return new ActionRefused(message, { code: 'no-target' });
}

function sameColor(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

/** The page `name` names, or the page shown when it is omitted. */
function pageOrShown(state, name) {
  if (name !== undefined) return resolvePage(state, name);
  state.ensureHighlightPage();
  const page = state.getActivePage();
  if (page === null) throw refuse('There is no highlight page to act on.');
  return page;
}

/** `label`, or `label (2)`, `label (3)`, … when the page has it already. */
function freeGroupLabel(page, label) {
  const taken = new Set(page.highlightedGroups.map(group => group.label));
  if (!taken.has(label)) return label;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${label} (${suffix})`;
    if (!taken.has(candidate)) return candidate;
  }
}

function requireFreePageName(state, name, except = null) {
  const holder = state.getHighlightPages().find(page => page.name === name && page !== except);
  if (holder !== undefined) {
    throw refuse(`A highlight page is called ${quoteName(name)} already; choose another name.`);
  }
}

/**
 * Where a new group goes (`highlight.cells`, `.category`, `.range`): checked
 * first, made and shown by `commit` (so a refusal changes nothing).
 *
 * - `page` named: that page, or a page of that name made with `color`; an
 *   existing page must already have `color` (a highlight never recolours a
 *   page).
 * - `color` only: the page shown when it has that colour, else the first
 *   page that has it, else a new page of that colour.
 * - neither: the page shown.
 */
function planTargetPage(state, { page: name, color }) {
  state.ensureHighlightPage();
  const pages = state.getHighlightPages();
  if (name !== undefined) {
    const matches = pages.filter(page => page.name === name);
    if (matches.length > 1) resolvePage(state, name);
    const existing = matches[0];
    if (existing !== undefined) {
      if (color !== undefined && !sameColor(existing.color, color)) {
        throw refuse(
          `Highlight page ${quoteName(name)} is ${existing.color}, not ${color}; name another page, or leave the colour out.`
        );
      }
      return { existing, name, color };
    }
    return { existing: null, name, color };
  }
  if (color !== undefined) {
    const shown = state.getActivePage();
    const existing = shown !== null && sameColor(shown.color, color)
      ? shown
      : pages.find(page => sameColor(page.color, color)) ?? null;
    return { existing, name: null, color };
  }
  return { existing: state.getActivePage(), name: null, color: undefined };
}

/** Make the planned page if it is new, show it, and return it. */
function commitTargetPage(state, plan) {
  let page = plan.existing;
  if (page === null) {
    page = state.createHighlightPage(plan.name);
    if (plan.color !== undefined && !state.setHighlightPageColor(page.id, plan.color)) {
      throw new Error(`The new highlight page could not take the colour ${plan.color}.`);
    }
  }
  if (!state.switchToPage(page.id)) throw new Error(`Highlight page "${page.name}" could not be shown.`);
  return page;
}

/**
 * A category or range group the target page has already: brought up to the
 * cells the selected view shows now (`highlight.category` and
 * `highlight.range` asked again, the history's Run again of a stale step,
 * `rerun` in the catalogue), in its place, shown. The same cells change
 * nothing (null: no step); no cell visible now is refused, the group keeping
 * its cells.
 *
 * @param {object} state
 * @param {{existing: object}} plan - from `planTargetPage`
 * @param {object} group - the page's group
 * @param {Uint32Array} cells - the cells the view shows now
 * @param {string} none - the sentence for no cell visible
 */
function bringUpToDate(state, plan, group, cells, none) {
  if (cells.length === 0) {
    throw refuse(`${none}; ${quoteName(group.label)} on page ${quoteName(plan.existing.name)} keeps its ${formatCountOf(group.cellCount, 'cell')}.`);
  }
  if (cellListsEqual(group.cellIndices, cells)) return null;
  const page = commitTargetPage(state, plan);
  const updated = state.replaceHighlightGroupCells(group.id, cells, page.id);
  if (updated === null) throw new Error(`Highlight "${group.label}" could not be brought up to date.`);
  return { page: page.name, group: updated.label, cells: updated.cellCount, updated: true };
}

/**
 * The open cells among `cells` (original positions, any order, each once),
 * as a cell list (subset positions, ascending), and how many are not open.
 */
function openCellsOf(state, cells) {
  const identity = state.cellIdentity;
  let found;
  try {
    found = identity.fromOriginal(cells);
  } catch (error) {
    if (error instanceof RangeError) throw refuse(`${error.message} Name cells by their 0-based row of obs.`);
    throw error;
  }
  const { positions } = found;
  let unique = 0;
  for (let i = 0; i < positions.length; i++) {
    if (i === 0 || positions[i] !== positions[i - 1]) positions[unique++] = positions[i];
  }
  const list = unique === positions.length ? positions : positions.slice(0, unique);
  return { positions: list, notOpen: found.dropped };
}

/**
 * A selection tool's Confirm: the confirmed cells become one
 * `highlight.cells` step on the page shown (the tool's own step-undo stays
 * with the tool until then). The step names the cells by original position;
 * the group holds exactly the confirmed cells.
 *
 * The in-progress preview stays drawn until the group replaces it, so the
 * highlight does not blink off between Confirm and the group's arrival:
 * `clearPreview` waits for a Confirm still being applied.
 *
 * @param {{state: object, isDestroyed: () => boolean}} options
 */
export function createSelectionConfirmer({ state, isDestroyed }) {
  let pending = null;
  return Object.freeze({
    /**
     * @param {{cellIndices: Uint32Array, label: string, tool: 'annotation'|'lasso'|'proximity'|'knn'}} selection
     * @returns {Promise<object|null>}
     */
    confirm({ cellIndices, label, tool }) {
      state.ensureHighlightPage();
      const page = state.getActivePage();
      const { cells } = state.cellIdentity.originalValues(cellIndices, null);
      const done = dispatchFromControl(
        'highlight.cells',
        { cells, label, tool, page: page.name },
        { failure: 'Highlighting the selection failed', category: 'highlight' }
      );
      const tracked = done.finally(() => {
        if (pending === tracked) pending = null;
      });
      pending = tracked;
      return done;
    },
    /** Clear the selection preview once no Confirm is being applied. */
    clearPreview() {
      if (pending === null) {
        state.clearPreviewHighlight();
        return;
      }
      void pending.then(() => {
        if (!isDestroyed()) state.clearPreviewHighlight();
      });
    },
  });
}

/**
 * Provide every highlight action. Returns the remover (call it when the
 * panel is destroyed).
 *
 * @param {{state: object, actions?: ReturnType<typeof getActions>}} options
 * @returns {() => void}
 */
export function provideHighlightActions({ state, actions = getActions() }) {
  const handlers = {
    'highlight.page.create'({ name, color }) {
      if (name !== undefined) requireFreePageName(state, name);
      const page = state.createHighlightPage(name ?? null);
      if (color !== undefined && !state.setHighlightPageColor(page.id, color)) {
        throw new Error(`The new highlight page could not take the colour ${color}.`);
      }
      if (!state.switchToPage(page.id)) throw new Error(`Highlight page "${page.name}" could not be shown.`);
      return { page: page.name };
    },

    'highlight.page.switch'({ page: name }) {
      const page = resolvePage(state, name);
      if (!state.switchToPage(page.id)) throw new Error(`Highlight page "${name}" could not be shown.`);
      return { page: page.name };
    },

    'highlight.page.rename'({ page: name, name: next }) {
      const page = resolvePage(state, name);
      if (next === page.name) return null;
      requireFreePageName(state, next, page);
      if (!state.renameHighlightPage(page.id, next)) throw new Error(`Highlight page "${name}" could not be renamed.`);
      return { page: next };
    },

    'highlight.page.recolor'({ page: name, color }) {
      const page = resolvePage(state, name);
      if (!state.setHighlightPageColor(page.id, color)) throw new Error(`Highlight page "${name}" could not take ${color}.`);
      return { page: page.name };
    },

    'highlight.page.delete'({ page: name }) {
      const page = resolvePage(state, name);
      if (state.getHighlightPages().length <= 1) {
        throw refuse(`${quoteName(name)} is the only highlight page and cannot be deleted; clear it instead.`);
      }
      if (!state.deleteHighlightPage(page.id)) throw new Error(`Highlight page "${name}" could not be deleted.`);
      return { page: name };
    },

    'highlight.page.combine'({ pages: [first, second], operation, name }) {
      const left = resolvePage(state, first);
      const right = resolvePage(state, second);
      if (name !== undefined) requireFreePageName(state, name);
      const page = state.combineHighlightPages(left.id, right.id, operation, name ?? null);
      if (page === null) throw new Error(`Highlight pages "${first}" and "${second}" could not be combined.`);
      if (!state.switchToPage(page.id)) throw new Error(`Highlight page "${page.name}" could not be shown.`);
      return { page: page.name, cells: state.getHighlightedCellCountForPage(page.id) };
    },

    'highlight.page.clear'({ page: name }) {
      const page = pageOrShown(state, name);
      const groups = page.highlightedGroups.length;
      if (groups === 0) return null;
      if (state.clearHighlightPage(page.id) !== groups) throw new Error(`Highlight page "${page.name}" could not be cleared.`);
      return { page: page.name, groups };
    },

    'highlight.clear-all'() {
      const groups = state.clearHighlightsOnAllPages();
      return groups === 0 ? null : { groups };
    },

    'highlight.cells'(params) {
      const { positions, notOpen } = openCellsOf(state, params.cells);
      if (positions.length === 0) {
        throw refuse(
          `None of the ${formatCountOf(params.cells.length, 'cell')} to highlight is open; open more of them in ${placePath(PLACES.session, PLACES.subsampling)} to highlight them.`
        );
      }
      const plan = planTargetPage(state, params);
      const page = commitTargetPage(state, plan);
      const label = freeGroupLabel(page, params.label ?? `Highlight (${formatCountOf(positions.length, 'cell')})`);
      const group = state.addHighlightDirect({ type: params.tool, label, cellIndices: positions });
      // Highlight membership is scientific data (it is counted, exported and
      // compared): the group holds exactly the cells asked for, or the step
      // fails and is undone.
      if (
        group === null || typeof group !== 'object'
        || !(group.cellIndices instanceof Uint32Array) || !cellListsEqual(group.cellIndices, positions)
      ) {
        throw new Error('The highlight group does not hold exactly the cells it was made of.');
      }
      return { page: page.name, group: group.label, cells: group.cellCount, notOpen };
    },

    async 'highlight.category'(params, { signal }) {
      if (params.field.source !== 'obs') {
        throw refuse(`A gene has no categories; highlight a range of ${params.field.key} instead.`);
      }
      const { index: fieldIndex } = resolveField(state, params.field);
      await state.ensureFieldLoaded(fieldIndex, { signal, silent: true });
      const field = state.getFields()[fieldIndex];
      if (field.kind !== 'category') {
        throw refuse(`${params.field.key} is not categorical; highlight a range of its values instead.`);
      }
      const categoryIndex = resolveCategory(field, params.category);
      const plan = planTargetPage(state, params);
      const label = `${field.key}: ${field.categories[categoryIndex]}`;
      const cells = state.getCellIndicesForCategory(field, categoryIndex, state.categoryTransparency);
      const onPage = plan.existing === null ? undefined : plan.existing.highlightedGroups.find(group => (
        group.type === 'category' && group.fieldKey === field.key && group.categoryIndex === categoryIndex
      ));
      if (onPage !== undefined) return bringUpToDate(state, plan, onPage, cells, `No cell of ${quoteName(label)} is visible in the selected view`);
      if (cells.length === 0) {
        throw refuse(`No cell of ${quoteName(label)} is visible in the selected view; show the category first.`);
      }
      const page = commitTargetPage(state, plan);
      const group = state.addHighlightFromCategory(fieldIndex, categoryIndex, 'obs');
      return { page: page.name, group: group.label, cells: group.cellCount };
    },

    async 'highlight.range'(params, { signal }) {
      if (params.min > params.max) {
        throw refuse(`The range of ${params.field.key} runs from its smaller value to its larger: ${params.max} to ${params.min}.`);
      }
      const { index: fieldIndex } = resolveField(state, params.field);
      const field = params.field.source === 'var'
        ? await state.ensureVarFieldLoaded(fieldIndex, { signal, silent: true })
        : await state.ensureFieldLoaded(fieldIndex, { signal, silent: true });
      if (field.kind !== 'continuous') {
        throw refuse(`${params.field.key} is categorical; highlight one of its categories instead.`);
      }
      const plan = planTargetPage(state, params);
      const cells = state.getCellIndicesForRange(field, params.min, params.max, state.categoryTransparency);
      const onPage = plan.existing === null ? undefined : plan.existing.highlightedGroups.find(group => (
        group.type === 'range' && group.fieldKey === field.key && (group.fieldSource ?? 'obs') === params.field.source
        && group.rangeMin === params.min && group.rangeMax === params.max
      ));
      if (onPage !== undefined) {
        return bringUpToDate(state, plan, onPage, cells, `No cell visible in the selected view has ${params.field.key} from ${params.min} to ${params.max}`);
      }
      if (cells.length === 0) {
        throw refuse(`No cell visible in the selected view has ${params.field.key} from ${params.min} to ${params.max}.`);
      }
      const page = commitTargetPage(state, plan);
      const group = state.addHighlightFromRange(fieldIndex, params.min, params.max, params.field.source);
      if (group === null) throw new Error(`The range of ${params.field.key} could not be highlighted.`);
      return { page: page.name, group: group.label, cells: group.cellCount };
    },

    'highlight.group.toggle'({ group: label, enabled, page: name }) {
      const page = pageOrShown(state, name);
      const group = resolveGroup(page, label);
      const isOn = group.enabled !== false;
      if (isOn === enabled) return null;
      if (!state.toggleHighlightEnabled(group.id, enabled, page.id)) {
        throw new Error(`Highlight "${label}" could not be turned ${enabled ? 'on' : 'off'}.`);
      }
      return { page: page.name, group: label };
    },

    'highlight.group.remove'({ group: label, page: name }) {
      const page = pageOrShown(state, name);
      const group = resolveGroup(page, label);
      if (!state.removeHighlightGroup(group.id, page.id)) throw new Error(`Highlight "${label}" could not be removed.`);
      return { page: page.name, group: label, cells: group.cellCount };
    },
  };

  const removers = Object.entries(handlers).map(([type, handler]) => actions.provide(type, handler));
  return () => {
    for (const remove of removers) remove();
  };
}
