/**
 * @fileoverview The analyses as actions (`app/actions/definitions/analysis.js`):
 * the implementations, and the steps a person's changes are recorded as.
 *
 * An action names an analysis by its name (`markers`) and where it is
 * (`in`: `'panel'`, or a window's number in the order the windows opened);
 * pages by their names. The analyses' own controls apply a person's change
 * as they always did and report it (`recordAnalysisChange` on the comparison
 * module), and it is recorded here as the matching action's step, so an
 * agent, a notebook and a replay take the same path a person's change is
 * described by. A result's provenance (`shared/result-provenance.js`) names
 * the open dataset through `describeOpenDataset`.
 *
 * A read makes no state: a change uses the panel's analysis of a mode, made
 * on first use inside its step (`analysisAt`); a read uses it through
 * `readAnalysisAt` (`ComparisonModule.readPanelUI`), which unmakes a mode it
 * had to make, so the `analysis` domain is as it was.
 *
 * @module analysis/actions
 */

import { ActionRefused } from '../actions/dispatcher.js';
import { ANALYSIS_MODES, analysisModeNamed, analysisModeOfId } from './options/analysis-modes.js';
import { viewKeysOf } from './options/analysis-views.js';
import { analysisViewSizes } from './shared/analysis-view-sizes.js';
import { listNames, quoteName } from '../actions/targets/names.js';
import { describeProvenance } from './shared/result-provenance.js';
import { expandPagesWithDerived } from './shared/page-derivation-utils.js';

/**
 * @param {{
 *   actions: ReturnType<typeof import('../actions/dispatcher.js').createActionDispatcher>,
 *   comparisonModule: object,
 *   dockable: {place: Function},
 *   section: HTMLDetailsElement|null,
 *   describeOpenDataset: () => ({id: string|null, method: string|null, seed: number|null}|null),
 * }} owners
 * @returns {() => void} Removes the actions and the recording.
 */
export function installAnalysisActions({ actions, comparisonModule, dockable, section, describeOpenDataset }) {
  const windows = comparisonModule.getAnalysisWindowManager();
  const dataLayer = comparisonModule.dataLayer;

  function modeNamed(name) {
    const mode = analysisModeNamed(name);
    if (mode === undefined) {
      throw new ActionRefused(`There is no analysis ${quoteName(name)}; the analyses are ${ANALYSIS_MODES.map(m => m.name).join(', ')}.`, { code: 'no-target' });
    }
    return mode;
  }

  function windowNumbered(number) {
    const open = windows.listWindows();
    const entry = open.find(window => window.number === number);
    if (entry === undefined) {
      throw new ActionRefused(open.length === 0
        ? `There is no analysis window ${number}: none is open.`
        : `There is no analysis window ${number}; the open ones are ${open.map(window => `${window.number} (${window.title})`).join(', ')}.`, { code: 'no-target' });
    }
    return entry;
  }

  /** The analysis a change names, where it names it (the panel's made on first use, inside the change's step). */
  function analysisAt(name, where = 'panel') {
    const mode = modeNamed(name);
    if (where === 'panel') {
      const ui = comparisonModule.getPanelUI(mode.id);
      if (ui === null || ui === undefined) throw new ActionRefused(`${mode.title} is not available on this page.`, { code: 'unavailable' });
      return { mode, ui };
    }
    const entry = windowNumbered(where);
    if (entry.modeId !== mode.id) {
      throw new ActionRefused(`Analysis window ${where} shows ${analysisModeOfId(entry.modeId)?.title ?? entry.modeId}, not ${mode.title}.`, { code: 'no-target' });
    }
    return { mode, ui: entry.ui };
  }

  /**
   * Read the analysis a read names, where it names it, leaving the state as
   * it was: a mode the panel never made is made for the read and unmade
   * after (`ComparisonModule.readPanelUI`), so no read creates analysis
   * state (it would be a change with no step, which undo cannot take back).
   */
  function readAnalysisAt(name, where = 'panel', read) {
    const mode = modeNamed(name);
    if (where !== 'panel') return read({ mode, ui: analysisAt(name, where).ui });
    return comparisonModule.readPanelUI(mode.id, ui => {
      if (ui === null || ui === undefined) throw new ActionRefused(`${mode.title} is not available on this page.`, { code: 'unavailable' });
      return read({ mode, ui });
    });
  }

  /** The pages an analysis can be given, by name (base pages and "Rest of …"). */
  function selectablePages() {
    return expandPagesWithDerived(dataLayer.getPages(), { includeRestOf: true });
  }

  function pageIdsOf(names) {
    const pages = selectablePages();
    return names.map(name => {
      const page = pages.find(candidate => candidate.name === name)
        ?? pages.find(candidate => candidate.name.toLowerCase() === name.toLowerCase());
      if (page === undefined) {
        throw new ActionRefused(`There is no page ${quoteName(name)}; the pages are ${pages.map(candidate => `${quoteName(candidate.name)}`).join(', ') || 'none yet'}.`, { code: 'no-target' });
      }
      return page.id;
    });
  }

  function pageNamesOf(ids) {
    const pages = selectablePages();
    return ids.map(id => pages.find(page => page.id === id)?.name ?? id);
  }

  /** A UI's result state as the reads give it. */
  /**
   * What a read says of an analysis's result, taken now (synchronously, so a
   * read of a mode made for it reads it before it is unmade,
   * `ComparisonModule.readPanelUI`): its staleness is worked out from what
   * the result was computed on and the page now, both taken now, and
   * resolves after (`resultState`).
   */
  function resultFacts(ui) {
    const provenance = ui.getResultProvenance?.() ?? null;
    return {
      has_result: (ui.getLastResult?.() ?? null) !== null,
      running: ui.isRunning(),
      computed_on: provenance === null ? null : describeProvenance(provenance),
      reasons: Promise.resolve(ui.getStaleReasons?.() ?? []),
    };
  }

  /** The facts `resultFacts` took, its staleness resolved. */
  async function resultState(facts) {
    const reasons = (await facts.reasons) ?? [];
    return {
      has_result: facts.has_result, running: facts.running, stale: reasons.length > 0, stale_reasons: reasons, computed_on: facts.computed_on,
    };
  }

  /** A refusal for what the analysis itself refuses (an option's value, Run's reason). */
  function refusing(type, run) {
    try {
      return run();
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) throw new ActionRefused(error.marked ?? error.message, { code: 'refused', type });
      throw error;
    }
  }

  /**
   * An analysis draws what these actions change where it is shown, and a
   * plot waits for a laid-out place to draw in (`shared/plot-render-slot.js`):
   * on an analysis that is not shown (its row, its section or the sidebar
   * closed, its window folded) such an action is refused before it changes
   * anything, saying what to open, never left waiting.
   */
  function requireShown(type, mode, ui, where) {
    if (ui.isShown()) return;
    throw new ActionRefused(where === 'panel'
      ? `${mode.title} is not shown, so it cannot draw: open it first (analysis.open, and the Analysis section and the sidebar when they are closed).`
      : `Analysis window ${where} is folded or hidden, so ${mode.title} cannot draw: unfold it first (analysis.window.collapse).`,
    { code: 'not-shown', type });
  }

  const removers = [
    actions.provide('analysis.open', async ({ analysis, window }) => {
      const mode = modeNamed(analysis);
      if (window) {
        const id = await windows.copyFromEmbedded(mode.id);
        // The step holds what the new window's first update changes.
        await windows.whenWindowSettled(id);
        return { window: windows.windowNumberOf(id) };
      }
      if (section !== null) section.open = true;
      comparisonModule.openMode(mode.id);
      return { title: mode.title };
    }),
    actions.provide('analysis.close', () => {
      const open = comparisonModule.getOpenMode();
      if (open === null) return null;
      comparisonModule.closeOpenMode();
      return { title: analysisModeOfId(open)?.title ?? open };
    }),
    actions.provide('analysis.pages.set', async ({ analysis, in: where, pages }) => {
      const { mode, ui } = analysisAt(analysis, where);
      const ids = pageIdsOf(pages);
      requireShown('analysis.pages.set', mode, ui, where);
      refusing('analysis.pages.set', () => ui.onPageSelectionChange(ids));
      // What the change set off (a redraw) is part of the step.
      await ui.whenSettled();
      return { pages: pages.length };
    }),
    actions.provide('analysis.quick.set', async ({ in: where, categorical, continuous }) => {
      const { mode, ui } = analysisAt('quick', where);
      for (const [kind, keys, words] of [['categorical_obs', categorical, 'categorical'], ['continuous_obs', continuous, 'continuous']]) {
        if (keys === undefined) continue;
        const known = dataLayer.getAvailableVariables(kind).map(entry => entry.key);
        const unknown = keys.find(key => !known.includes(key));
        if (unknown !== undefined) {
          throw new ActionRefused(`There is no ${words} field ${quoteName(unknown)}; the choices are ${listNames(known)}.`, {
            code: 'no-target', type: 'analysis.quick.set',
          });
        }
      }
      requireShown('analysis.quick.set', mode, ui, where);
      const changed = refusing('analysis.quick.set', () => ui.setFields({ categorical, continuous }));
      await ui.whenSettled();
      return changed ? { changed: ['categorical', 'continuous'].filter(key => (key === 'categorical' ? categorical : continuous) !== undefined).join(', ') } : null;
    }),
    actions.provide('analysis.detailed.set', async ({ in: where, variable, plot, plot_options: plotOptions }) => {
      const { mode, ui } = analysisAt('detailed', where);
      requireShown('analysis.detailed.set', mode, ui, where);
      const changed = refusing('analysis.detailed.set', () => ui.setPlot({ variable, plot, plotOptions }));
      await ui.whenSettled();
      const given = [['variable', variable], ['plot', plot], ['plot_options', plotOptions]].filter(([, value]) => value !== undefined);
      return changed ? { changed: given.map(([key]) => key).join(', ') } : null;
    }),
    actions.provide('analysis.view.set', async ({ analysis, in: where, view }) => {
      const { mode, ui } = analysisAt(analysis, where);
      const keys = viewKeysOf(mode);
      const unknown = Object.keys(view).filter(key => !keys.includes(key));
      if (unknown.length > 0) {
        throw new ActionRefused(
          `${mode.title} has no view ${quoteName(unknown[0])}; it takes ${listNames(keys)}.`,
          { code: 'refused', type: 'analysis.view.set' },
        );
      }
      // Checked whole first (a wrong name is said as such), then refused when not shown.
      const apply = refusing('analysis.view.set', () => ui.prepareView(view));
      requireShown('analysis.view.set', mode, ui, where);
      const changed = apply();
      await ui.whenSettled();
      return changed ? { changed: Object.keys(view).join(', ') } : null;
    }),
    actions.provide('analysis.run', async ({ analysis, in: where }, { signal }) => {
      const { mode, ui } = analysisAt(analysis, where);
      requireShown('analysis.run', mode, ui, where);
      let ran;
      try {
        ran = await ui.runNow({ signal });
      } catch (error) {
        if (error instanceof RangeError) throw new ActionRefused(error.marked ?? error.message, { code: 'refused', type: 'analysis.run' });
        throw error;
      }
      if (!ran) return null;
      return { rows: ui.describeResult(1)?.total ?? 0 };
    }),
    // What a run would take, for the agent presence's heavy work (measured runs of this analysis).
    actions.provideEstimate('analysis.run', ({ analysis, in: where }) => {
      try {
        return readAnalysisAt(analysis, where, ({ ui }) => ui.estimateRun?.() ?? null);
      } catch {
        return null;
      }
    }),
    actions.provide('analysis.cancel', ({ analysis, in: where }) => (
      readAnalysisAt(analysis, where, ({ ui }) => ({ stopped: ui.cancelRun() }))
    )),
    actions.provide('analysis.window.copy', async ({ window }) => {
      const entry = windowNumbered(window);
      const id = await windows.copyFromWindow(entry.id);
      await windows.whenWindowSettled(id);
      return { window: windows.windowNumberOf(id) };
    }),
    actions.provide('analysis.window.close', async ({ window }) => {
      const entry = windowNumbered(window);
      await windows.closeWindow(entry.id);
      return { title: entry.title };
    }),
    actions.provide('analysis.window.place', ({ window, left, top, width, height }) => {
      const entry = windowNumbered(window);
      dockable.place(entry.details, { left, top, width, height });
      return { window };
    }),
    actions.provide('analysis.size.set', ({ analysis, expanded }) => {
      const mode = modeNamed(analysis);
      const before = analysisViewSizes.expandedViewSize(mode.id);
      if (before !== null && Object.keys(expanded).every(key => before[key] === expanded[key])) return null;
      refusing('analysis.size.set', () => analysisViewSizes.rememberExpandedViewSize(mode.id, expanded));
      return { analysis };
    }),
    actions.provide('analysis.window.collapse', ({ window, collapsed }) => {
      const entry = windowNumbered(window);
      if (entry.details.open === !collapsed) return null;
      entry.details.open = !collapsed;
      return { window };
    }),
    actions.provide('analysis.list', async () => ({
      open: analysisModeOfId(comparisonModule.getOpenMode())?.name ?? null,
      analyses: await Promise.all([
        ...comparisonModule.listPanelUIs().map(({ modeId, ui }) => ({ modeId, ui, where: 'panel' })),
        ...windows.listWindows().map(entry => ({ modeId: entry.modeId, ui: entry.ui, where: entry.number })),
      ].map(async ({ modeId, ui, where }) => {
        const mode = analysisModeOfId(modeId);
        return {
          analysis: mode.name,
          title: mode.title,
          in: where,
          pages: pageNamesOf(ui.getSelectedPages()),
          ...(await resultState(resultFacts(ui))),
        };
      })),
    })),
    actions.provide('analysis.result', async ({ analysis, in: where, top }) => {
      // Read now (a read is synchronous); the staleness resolves after.
      const { mode, table, facts } = readAnalysisAt(analysis, where, ({ mode: read, ui }) => ({
        mode: read, table: ui.describeResult(top), facts: resultFacts(ui),
      }));
      if (table === null) {
        throw new ActionRefused(`${mode.title} has no result yet; run it first (analysis.run).`, { code: 'no-result', type: 'analysis.result' });
      }
      const state = await resultState(facts);
      return {
        analysis: mode.name,
        columns: table.columns,
        rows: table.rows,
        total_rows: table.total,
        stale: state.stale,
        stale_reasons: state.stale_reasons,
        computed_on: state.computed_on,
      };
    }),
    ...ANALYSIS_MODES.filter(mode => mode.options !== null).flatMap(mode => [
      actions.provide(`analysis.${mode.name}.set`, async ({ in: where, options, show }) => {
        if (show && where !== 'panel') {
          throw new ActionRefused(`"show" opens ${mode.title} in the panel (in "panel"); analysis window ${where} shows its own.`, {
            code: 'refused', type: `analysis.${mode.name}.set`,
          });
        }
        const { ui } = analysisAt(mode.name, where);
        // Options alone draw nothing; with a result shown, a display option redraws it.
        if (ui.describeResult(1) !== null) requireShown(`analysis.${mode.name}.set`, mode, ui, where);
        const before = ui.getOptions();
        refusing(`analysis.${mode.name}.set`, () => ui.setOptions(options));
        // A display option redraws the shown result: the step holds the redrawn one.
        await ui.whenSettled();
        const after = ui.getOptions();
        const changed = Object.keys(options).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
        const opened = show === true && comparisonModule.getOpenMode() !== mode.id;
        if (opened) comparisonModule.openMode(mode.id);
        return changed.length === 0 && !opened ? null : { changed: changed.join(', '), ...(opened ? { opened: true } : {}) };
      }),
      actions.provide(`analysis.${mode.name}.get`, async ({ in: where }) => {
        // Read now (a read is synchronous); the staleness resolves after.
        const { facts, ...read } = readAnalysisAt(mode.name, where, ({ ui }) => ({
          analysis: mode.name,
          in: where,
          options: ui.getOptions(),
          pages: pageNamesOf(ui.getSelectedPages()),
          facts: resultFacts(ui),
        }));
        return { ...read, ...(await resultState(facts)) };
      }),
    ]),
  ];

  function record(type, params, outcome = null, after = null) {
    actions.recordObserved(type, params, {}, outcome, { after })
      .catch(error => console.error(`[Analysis] ${type} could not be recorded:`, error));
  }

  /**
   * A person's change in the analyses, recorded as its action's step;
   * `after`: the work it set off, which the step waits for and holds.
   */
  function recordPersonChange(ui, kind, detail, { after = null } = {}) {
    try {
      if (kind === 'open') {
        record('analysis.open', { analysis: analysisModeOfId(detail.mode).name, window: false }, { title: analysisModeOfId(detail.mode).title });
      } else if (kind === 'close') {
        record('analysis.close', {}, { title: analysisModeOfId(detail.mode)?.title ?? detail.mode });
      } else if (kind === 'window-open') {
        record('analysis.open', { analysis: analysisModeOfId(detail.mode).name, window: true }, { window: windows.listWindows().length }, after);
      } else if (kind === 'window-copy') {
        record('analysis.window.copy', { window: detail.window }, { window: windows.listWindows().length }, after);
      } else if (kind === 'window-close') {
        record('analysis.window.close', { window: detail.window }, { title: detail.title });
      } else if (kind === 'window-place') {
        const { window, left, top, width, height } = detail;
        if (window > 0) record('analysis.window.place', { window, left, top, width, height });
      } else if (kind === 'window-collapse') {
        record('analysis.window.collapse', { window: detail.window, collapsed: detail.collapsed });
      } else {
        const located = comparisonModule.locateUI(ui);
        if (located === null) return;
        const mode = analysisModeOfId(located.modeId);
        if (kind === 'pages') {
          record('analysis.pages.set', { analysis: mode.name, in: located.where, pages: pageNamesOf(detail.pageIds) }, null, after);
        } else if (kind === 'set' && mode.options !== null) {
          record(`analysis.${mode.name}.set`, {
            in: located.where, options: detail.options, ...(detail.show === true ? { show: true } : {}),
          }, null, after);
        } else if (kind === 'view' && viewKeysOf(mode).length > 0) {
          record('analysis.view.set', { analysis: mode.name, in: located.where, view: detail.view }, null, after);
        } else if (kind === 'fields' && mode.name === 'quick') {
          record('analysis.quick.set', { in: located.where, ...detail }, null, after);
        } else if (kind === 'detailed' && mode.name === 'detailed') {
          const { plotOptions, ...rest } = detail;
          record('analysis.detailed.set', { in: located.where, ...rest, ...(plotOptions === undefined ? {} : { plot_options: plotOptions }) }, null, after);
        } else if (kind === 'run' && mode.options !== null) {
          record('analysis.run', { analysis: mode.name, in: located.where }, null, after);
        }
      }
    } catch (error) {
      console.error(`[Analysis] A ${kind} change could not be recorded:`, error);
    }
  }

  comparisonModule.setChangeRecorder(recordPersonChange);
  // A person resized an expanded view: its remembered size is a step.
  const stopSizes = analysisViewSizes.onPersonResize((modeId, size) => {
    const mode = analysisModeOfId(modeId);
    if (mode !== undefined && mode !== null) record('analysis.size.set', { analysis: mode.name, expanded: size });
  });
  comparisonModule.setOpenDatasetDescriber(describeOpenDataset);

  return () => {
    comparisonModule.setChangeRecorder(null);
    stopSizes();
    comparisonModule.setOpenDatasetDescriber(null);
    for (const remove of removers) remove();
  };
}
