/**
 * Composition: do cell-type proportions differ between conditions,
 * accounting for samples?
 *
 * The cells (all, the visible ones, or a page) are counted per cell type and
 * per unit — a sample, split into one unit per condition when a sample spans
 * conditions — in one pass in a worker (`COMPOSITION_COUNTS`). With samples
 * and a condition, every type is tested across the samples of each
 * condition (`stats/composition-tests.js`); without samples the cells are
 * the only replicates, which the result says beside it. The result is the
 * stacked bars per sample or condition, the per-sample points per type, a
 * table per type and the counts and results as CSV.
 *
 * @module analysis-types/composition-ui
 */

import { FormBasedAnalysisUI } from './base/form-based-analysis.js';
import { compositionOptions, COMPOSITION_DISPLAY_OPTIONS } from '../../options/composition-options.js';
import { testComposition } from '../../stats/composition-tests.js';
import { presentCompositionUnits } from '../../compute/composition-counts.js';
import { getComputeManager } from '../../compute/compute-manager.js';
import { OperationType } from '../../compute/operations.js';
import { createResultEnvelope, readResultEnvelope } from '../../shared/analysis-result-session.js';
import { downloadCSV } from '../../shared/analysis-utils.js';
import { categoryColorCss, createFieldGroups } from './field-groups.js';
import { formatCount, formatCountOf, countNoun } from '../../../../utils/format-units.js';
import { escapeHtml } from '../../../utils/dom-utils.js';
import '../../plots/types/composition-bars.js';

const ADJUSTED_P_SIGNIFICANT = 0.05;

function significanceMark(p) {
  if (!Number.isFinite(p)) return '';
  if (p <= 0.001) return '***';
  if (p <= 0.01) return '**';
  if (p <= ADJUSTED_P_SIGNIFICANT) return '*';
  return '';
}

function formatP(p) {
  if (!Number.isFinite(p)) return '–';
  return p < 1e-4 ? p.toExponential(1) : p.toPrecision(2);
}

function csvCell(value) {
  const text = typeof value === 'number'
    ? (Number.isFinite(value) ? String(value) : 'NA')
    : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Bar and point data for the plots from a composition table and the display
 * options: types in the chosen order, bars per sample or per condition,
 * proportions or counts.
 *
 * @param {Object} composition - `result.composition`
 * @param {{barsBy: string, order: string, values: string}} display
 */
export function compositionPlotData(composition, display) {
  const { types, typeColors, units, conditions, counts, conditionOfUnit, test } = composition;
  const typeCount = types.length;
  const unitCount = units.length;
  const totals = new Float64Array(typeCount);
  for (let type = 0; type < typeCount; type++) {
    for (let unit = 0; unit < unitCount; unit++) totals[type] += counts[type * unitCount + unit];
  }
  const order = types.map((_, index) => index);
  if (display.order === 'abundance') order.sort((a, b) => totals[b] - totals[a] || a - b);
  if (display.order === 'change' && test !== null) {
    const strength = index => (Number.isFinite(test.adjustedP[index]) ? -Math.log10(test.adjustedP[index]) : -1);
    order.sort((a, b) => strength(b) - strength(a) || a - b);
  }

  const byCondition = display.barsBy === 'condition' || composition.samples === null;
  const bars = byCondition && conditions.length > 0
    ? conditions.map(name => ({ label: name, group: '' }))
    // Under its condition a bar needs only its sample's name.
    : units.map(unit => ({ label: unit.condition !== '' && unit.sample !== '' ? unit.sample : unit.label, group: unit.condition }));
  const barOfUnit = byCondition && conditions.length > 0
    ? Array.from(conditionOfUnit)
    : units.map((_, index) => index);
  const barCount = bars.length;
  const raw = new Float64Array(typeCount * barCount);
  for (let type = 0; type < typeCount; type++) {
    for (let unit = 0; unit < unitCount; unit++) {
      raw[type * barCount + barOfUnit[unit]] += counts[type * unitCount + unit];
    }
  }
  const barTotals = new Float64Array(barCount);
  for (let type = 0; type < typeCount; type++) {
    for (let bar = 0; bar < barCount; bar++) barTotals[bar] += raw[type * barCount + bar];
  }
  const proportions = display.values === 'proportion';
  const values = new Float64Array(typeCount * barCount);
  order.forEach((type, row) => {
    for (let bar = 0; bar < barCount; bar++) {
      const value = raw[type * barCount + bar];
      values[row * barCount + bar] = proportions ? (barTotals[bar] > 0 ? value / barTotals[bar] : 0) : value;
    }
  });

  // One point per type and sample, for the per-sample view.
  const unitTotals = new Float64Array(unitCount);
  for (let type = 0; type < typeCount; type++) {
    for (let unit = 0; unit < unitCount; unit++) unitTotals[unit] += counts[type * unitCount + unit];
  }
  const pointCount = composition.samples === null ? 0 : typeCount * unitCount;
  const points = {
    type: new Int32Array(pointCount),
    condition: new Int32Array(pointCount),
    value: new Float64Array(pointCount),
    label: []
  };
  if (pointCount > 0) {
    let at = 0;
    order.forEach((type, row) => {
      for (let unit = 0; unit < unitCount; unit++) {
        points.type[at] = row;
        points.condition[at] = conditions.length > 0 ? conditionOfUnit[unit] : 0;
        points.value[at] = unitTotals[unit] > 0 ? counts[type * unitCount + unit] / unitTotals[unit] : 0;
        points.label.push(units[unit].label);
        at += 1;
      }
    });
  }

  return {
    bars: {
      types: order.map(index => types[index]),
      typeColors: order.map(index => typeColors[index]),
      bars,
      values,
      proportions
    },
    strips: {
      types: order.map(index => types[index]),
      conditions: conditions.length > 0 ? conditions : ['All cells'],
      conditionColors: conditions.length > 0 ? composition.conditionColors : [typeColors[0]],
      points,
      significance: order.map(index => (test === null ? '' : significanceMark(test.adjustedP[index])))
    }
  };
}

export class CompositionUI extends FormBasedAnalysisUI {
  static getRequirements() {
    return {
      minPages: 0,
      maxPages: null,
      description: 'Choose the cell types, samples and condition'
    };
  }

  constructor(options) {
    super(options);
    this._plotContainerIdBase = this._instanceId
      ? `${this._instanceId}-composition-plot`
      : 'composition-plot';
    this._fieldGroups = createFieldGroups({
      dataLayer: this.dataLayer,
      onReady: () => this._refreshOptionsContext(),
      onError: error => this._notifications.error(`Composition cell types: ${error.message}`, { category: 'analysis' })
    });
  }

  _getTitle() {
    return 'Composition';
  }

  _getClassName() {
    return 'composition';
  }

  _getOptionsSchema() {
    return compositionOptions;
  }

  /** The categorical fields, the colouring field and the pages. */
  _getOptionsContext() {
    const categoricalFields = this.dataLayer.getAvailableVariables('categorical_obs').map(info => ({
      key: info.key,
      name: info.name ?? info.key,
      // Null until the field is read: its categories are not known yet.
      categoryCount: Array.isArray(info.categories) ? info.categories.length : (info.categoryCount ?? null)
    }));
    const state = this.dataLayer.state;
    const active = state?.activeFieldSource === 'obs' && state.activeFieldIndex >= 0
      ? state.obsData?.fields?.[state.activeFieldIndex]
      : null;
    return {
      categoricalFields,
      colorField: active?.kind === 'category' ? active.key : null,
      pages: this.dataLayer.getPages().map(page => ({ id: page.id, name: page.name })),
      groupsFor: (_entry, record) => this._fieldGroups.groups(record.cellTypes)
    };
  }

  validateDataRequirements() {
    if (this.dataLayer.getAvailableVariables('categorical_obs').length === 0) {
      return { valid: false, error: 'Requires a categorical field of cell types.' };
    }
    return { valid: true };
  }

  _getRunNoun() {
    return 'composition';
  }

  _getRunBlocker(options) {
    if (options.cellTypes === '') return 'Choose the field that holds the cell types';
    if (options.onlyTypes.mode === 'subset' && options.onlyTypes.ids.length < 2) {
      return 'Choose at least two cell types';
    }
    return null;
  }

  _isDisplayOption(key) {
    return COMPOSITION_DISPLAY_OPTIONS.includes(key);
  }

  _rebuildForDisplay(options) {
    const result = this._lastResult;
    return result ? { ...result, data: this._plotData(result.composition, options) } : null;
  }

  /** The cells in scope, one byte a cell, or null for every cell. */
  _scopeMask(cells, cellCount) {
    if (cells === 'all') return null;
    if (cells === 'visible') return this.dataLayer.getVisibleCellMask();
    if (!cells.startsWith('page:')) throw new RangeError(`Unknown cell scope "${cells}"`);
    const indices = this.dataLayer.getCellIndicesForPage(cells.slice('page:'.length));
    const mask = new Uint8Array(cellCount);
    for (const index of indices) mask[index] = 1;
    return mask;
  }

  async _runAnalysisImpl(options, requestId, job) {
    const signal = job.signal;
    job.setPlan('Counts every cell once');
    job.step('Reading the fields');
    const load = key => (key === '' ? null : this.dataLayer.ensureObsFieldLoaded(key, { signal }));
    const [typeField, sampleField, conditionField] = await Promise.all([
      load(options.cellTypes), load(options.samples), load(options.condition)
    ]);
    if (!this._isCurrentAnalysisRequest(requestId)) return null;
    const fieldOf = key => this.dataLayer.state.obsData.fields.find(field => field.key === key);

    // Cell types: every category, or the chosen ones, renumbered so the
    // proportions are of the chosen types only.
    const typeCategories = typeField.categories.map(String);
    const chosen = options.onlyTypes.mode === 'subset' ? new Set(options.onlyTypes.ids) : null;
    const typeIndexOfCode = new Int32Array(Math.max(1, typeCategories.length)).fill(-1);
    const typeNames = [];
    const typeColors = [];
    const typeFieldState = fieldOf(options.cellTypes);
    typeCategories.forEach((name, code) => {
      if (chosen !== null && !chosen.has(name)) return;
      typeIndexOfCode[code] = typeNames.length;
      typeNames.push(name);
      typeColors.push(categoryColorCss(typeFieldState, code));
    });
    const identity = categories => Int32Array.from(categories.map((_, index) => index));
    const sampleNames = sampleField === null ? null : sampleField.categories.map(String);
    const conditionNames = conditionField === null ? [] : conditionField.categories.map(String);
    const conditionFieldState = conditionField === null ? null : fieldOf(options.condition);
    const cellCount = typeField.codes.length;
    const scope = this._scopeMask(options.cells, cellCount);

    job.step('Counting cells');
    const counted = await getComputeManager().execute(
      OperationType.COMPOSITION_COUNTS,
      {
        typeCodes: typeField.codes,
        typeIndexOfCode,
        typeCount: Math.max(1, typeNames.length),
        sampleCodes: sampleField === null ? null : sampleField.codes,
        sampleIndexOfCode: sampleField === null ? null : identity(sampleNames),
        sampleCount: sampleField === null ? 1 : Math.max(1, sampleNames.length),
        conditionCodes: conditionField === null ? null : conditionField.codes,
        conditionIndexOfCode: conditionField === null ? null : identity(conditionNames),
        conditionCount: conditionField === null ? 1 : Math.max(1, conditionNames.length),
        scope
      },
      // The codes are the fields' own arrays: copied, never moved.
      { transfer: false, signal }
    );
    if (!this._isCurrentAnalysisRequest(requestId)) return null;

    // Keep the units that have cells; a sample in two conditions is two units.
    const conditionCount = conditionField === null ? 1 : Math.max(1, conditionNames.length);
    const typeCount = typeNames.length;
    const present = presentCompositionUnits(counted, conditionCount);
    const splitSamples = sampleNames === null || conditionField === null
      ? []
      : present.splitSamples.map(sample => sampleNames[sample]);
    const split = new Set(splitSamples);
    const units = Array.from(present.unitSample, (sample, unit) => {
      const sampleName = sampleNames === null ? '' : sampleNames[sample];
      const conditionName = conditionField === null ? '' : conditionNames[present.conditions[present.unitCondition[unit]]];
      return {
        sample: sampleName,
        condition: conditionName,
        label: sampleName === ''
          ? (conditionName === '' ? 'All cells' : conditionName)
          : (split.has(sampleName) ? `${sampleName} · ${conditionName}` : sampleName)
      };
    });
    const counts = present.counts;
    const conditionOfUnit = present.unitCondition;
    const presentConditions = conditionField === null ? [] : present.conditions;
    job.step('Testing');
    const test = presentConditions.length >= 2
      ? testComposition({
        counts,
        typeCount,
        unitCount: units.length,
        conditionOfUnit,
        conditionCount: presentConditions.length,
        samples: sampleField !== null,
        method: options.method,
        correction: options.correction
      })
      : null;

    let totalCells = 0;
    for (const value of counts) totalCells += value;
    const composition = {
      fields: { cellTypes: options.cellTypes, samples: options.samples, condition: options.condition },
      cells: options.cells,
      types: typeNames,
      typeColors,
      samples: sampleNames === null ? null : [...new Set(units.map(unit => unit.sample))],
      units,
      conditions: presentConditions.map(index => conditionNames[index]),
      conditionColors: presentConditions.map(index => categoryColorCss(conditionFieldState, index)),
      counts,
      conditionOfUnit,
      splitSamples,
      totalCells,
      method: options.method,
      correction: options.correction,
      test
    };
    // What limits the test goes to the notification center once per run;
    // the result keeps it as a chip.
    for (const chip of this._resultChips(composition)) {
      if (chip.tone === 'warning') this._notifications.info(chip.title, { category: 'analysis' });
    }
    return {
      type: 'composition',
      plotType: 'composition-bars',
      title: 'Composition',
      subtitle: options.condition === '' ? options.cellTypes : `${options.cellTypes} by ${options.condition}`,
      options: {},
      data: this._plotData(composition, options),
      composition
    };
  }

  /** Both plots' data: bars, and per-sample points when there are samples. */
  _plotData(composition, options) {
    const plots = compositionPlotData(composition, options);
    return { bars: plots.bars, strips: composition.samples === null ? null : plots.strips };
  }

  _getSuccessMessage(result = this._lastResult) {
    const composition = result?.composition;
    if (!composition) return 'Composition complete';
    const tested = composition.test;
    if (tested === null) {
      return `Composition: ${formatCount(composition.types.length)} cell types in ${formatCountOf(composition.totalCells, 'cell')}`;
    }
    let significant = 0;
    for (const p of tested.adjustedP) if (p <= ADJUSTED_P_SIGNIFICANT) significant += 1;
    return `Composition: ${formatCount(significant)} of ${formatCount(composition.types.length)} cell types differ (adj. p ≤ ${ADJUSTED_P_SIGNIFICANT})`;
  }

  /** The chips under the plot: what the test could not do, said once, briefly. */
  _resultChips(composition) {
    const chips = [];
    if (composition.conditions.length >= 2 && composition.samples === null) {
      chips.push({ text: 'Cells as replicates', tone: 'warning', title: 'Without samples the tests treat every cell as a replicate, which overstates the evidence. Choose a samples field to test across samples.' });
    }
    if (composition.splitSamples.length > 0) {
      chips.push({
        text: `${composition.splitSamples.length} split ${countNoun(composition.splitSamples.length, 'sample')}`,
        tone: 'info',
        title: `Samples spanning conditions are counted once per condition: ${composition.splitSamples.join(', ')}`
      });
    }
    if (composition.test !== null && composition.samples !== null) {
      const thin = [...composition.test.unitsPerCondition].some(n => n < 2);
      if (thin) chips.push({ text: 'Too few samples', tone: 'warning', title: 'A test across samples needs at least two samples in every condition.' });
    }
    return chips;
  }

  async _showResult(result, requestId) {
    // The sidebar preview leaves the legend out (hover names each type);
    // the expanded view shows it.
    const rendered = await this._renderPreviewPlot({
      result: { ...result, options: { ...result.options, legendPosition: 'none' } },
      requestId,
      containerId: this._plotContainerIdBase,
      expandable: true,
      height: 260
    });
    if (rendered === null || !this._isCurrentAnalysisRequest(requestId)) return rendered;
    const composition = result.composition;
    const container = this._resultContainer;
    container.querySelector(':scope > .analysis-result-header')?.remove();
    const header = document.createElement('div');
    header.className = 'analysis-result-header';
    const line = document.createElement('p');
    line.className = 'analysis-result-line';
    const parts = [`${formatCount(composition.types.length)} cell types`, `${formatCountOf(composition.totalCells, 'cell')}`];
    if (composition.samples !== null) parts.push(`${formatCountOf(composition.samples.length, 'sample')}`);
    if (composition.test !== null) {
      parts.push(composition.test.test, composition.correction === 'bh' ? 'BH' : 'Bonferroni');
    }
    line.textContent = parts.join(' · ');
    header.appendChild(line);
    const chips = this._resultChips(composition);
    if (chips.length > 0) {
      const row = document.createElement('div');
      row.className = 'analysis-chip-row';
      for (const chip of chips) {
        const element = document.createElement('span');
        element.className = `analysis-chip analysis-chip-${chip.tone}`;
        element.textContent = chip.text;
        element.title = chip.title;
        row.appendChild(element);
      }
      header.appendChild(row);
    }
    container.prepend(header);
    return rendered;
  }

  // ---------------------------------------------------------------- Expanded view

  _renderModalStats(container) {
    const composition = this._lastResult?.composition;
    if (!composition) return;
    const rows = [
      ['Cells', formatCount(composition.totalCells)],
      ['Cell types', formatCount(composition.types.length)],
      ['Samples', composition.samples === null ? 'None' : formatCount(composition.samples.length)],
      ['Conditions', composition.conditions.length === 0 ? 'None' : composition.conditions.join(', ')]
    ];
    if (composition.test !== null) {
      rows.push(['Test', composition.test.test]);
      rows.push(['Multiple testing', composition.correction === 'bh' ? 'Benjamini-Hochberg' : 'Bonferroni']);
      if (composition.test.overall !== null) {
        rows.push(['Type × condition χ²', `${composition.test.overall.statistic.toFixed(2)} (df ${composition.test.overall.df}), p ${formatP(composition.test.overall.pValue)}`]);
      }
    }
    container.innerHTML = `<table class="analysis-stats-table">${rows.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td><strong>${escapeHtml(value)}</strong></td></tr>`).join('')}</table>`;
    const counts = document.createElement('button');
    counts.type = 'button';
    counts.className = 'analysis-link-btn';
    counts.textContent = 'Counts CSV';
    counts.title = 'Cells per cell type and sample, for other tools';
    counts.addEventListener('click', () => this._downloadCounts());
    container.appendChild(counts);
  }

  _renderModalAnnotations(container) {
    const composition = this._lastResult?.composition;
    if (!composition) return;
    const { types, conditions, test } = composition;
    const header = ['Cell type', ...conditions.map(name => `Mean ${name}`)];
    if (conditions.length === 2) header.push('log₂ ratio');
    if (test !== null) header.push('Statistic', 'p', 'Adj. p');
    const body = types.map((type, index) => {
      const cells = [escapeHtml(type)];
      for (let condition = 0; condition < conditions.length; condition++) {
        const mean = test === null ? NaN : test.meanProportion[index * conditions.length + condition];
        cells.push(Number.isFinite(mean) ? `${(mean * 100).toFixed(1)}%` : '–');
      }
      if (conditions.length === 2 && test !== null) {
        const ratio = test.log2Ratio[index];
        cells.push(Number.isFinite(ratio) ? ratio.toFixed(2) : '–');
      }
      if (test !== null) {
        cells.push(
          Number.isFinite(test.statistic[index]) ? test.statistic[index].toPrecision(3) : '–',
          formatP(test.pValue[index]),
          `${formatP(test.adjustedP[index])}${significanceMark(test.adjustedP[index]) === '' ? '' : ` ${significanceMark(test.adjustedP[index])}`}`
        );
      }
      return `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`;
    });
    container.innerHTML = conditions.length < 2
      ? '<p class="empty-state">Choose a condition to compare the proportions.</p>'
      : `<table class="analysis-stats-table composition-table"><thead><tr>${header.map(cell => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead><tbody>${body.join('')}</tbody></table>`;
  }

  /** The counts, one row per cell type and one column per sample (or condition). */
  _downloadCounts() {
    const composition = this._lastResult?.composition;
    if (!composition) return;
    const { types, units, counts } = composition;
    const lines = [['cell_type', ...units.map(unit => unit.label)].map(csvCell).join(',')];
    types.forEach((type, index) => {
      lines.push([type, ...units.map((_, unit) => counts[index * units.length + unit])].map(csvCell).join(','));
    });
    downloadCSV(lines.join('\n'), 'composition_counts', this._notifications);
  }

  /**
   * The expanded view's CSV: the results per cell type when there is a
   * test, else the counts. Each click downloads one file (Safari keeps only
   * one download of a click); the counts beside results come from the
   * summary's own link.
   */
  _exportModalCSV() {
    const composition = this._lastResult?.composition;
    if (!composition) return;
    const { types, conditions, test } = composition;
    if (test === null) {
      this._downloadCounts();
      return;
    }
    const header = ['cell_type', ...conditions.map(name => `mean_proportion_${name}`), 'log2_ratio', 'test', 'statistic', 'pvalue', 'pvalue_adjusted', ...conditions.map(name => `n_samples_${name}`)];
    const rows = [header.map(csvCell).join(',')];
    types.forEach((type, index) => {
      rows.push([
        type,
        ...conditions.map((_, condition) => test.meanProportion[index * conditions.length + condition]),
        test.log2Ratio[index],
        test.typeTest[index],
        test.statistic[index],
        test.pValue[index],
        test.adjustedP[index],
        ...conditions.map((_, condition) => test.unitsPerCondition[condition])
      ].map(csvCell).join(','));
    });
    downloadCSV(rows.join('\n'), 'composition_results', this._notifications);
  }

  // ---------------------------------------------------------------- Sessions

  exportResult() {
    if (this._lastResult === null || this._lastResult === undefined) return null;
    return createResultEnvelope('composition', this._lastResult);
  }

  async importResult(envelope) {
    if (envelope === null) {
      await this._discardFormResult();
      return;
    }
    const result = readResultEnvelope(envelope, 'composition');
    const composition = result?.composition;
    if (
      result?.type !== 'composition' ||
      result.plotType !== 'composition-bars' ||
      composition === null || typeof composition !== 'object' ||
      !(composition.counts instanceof Uint32Array) ||
      !(composition.conditionOfUnit instanceof Int32Array)
    ) {
      throw new TypeError('A composition result must hold its counts per cell type and unit');
    }
    for (const key of Object.values(composition.fields)) {
      if (key !== '' && this.dataLayer.getVariableInfo('categorical_obs', key) === null) {
        throw new Error(`The composition result names the field "${key}", which this dataset lacks`);
      }
    }
    await this._restoreAnalysisResult(result);
  }
}

export function createCompositionUI(options) {
  const ui = new CompositionUI(options);
  ui.init(options.container);
  return ui;
}
