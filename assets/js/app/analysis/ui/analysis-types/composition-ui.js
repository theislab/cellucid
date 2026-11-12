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
import { MIN_PAIRS_WITH_CELLS, NO_CELLS, TOO_FEW_PAIRS, compositionPairs, testComposition } from '../../stats/composition-tests.js';
import { presentCompositionUnits } from '../../compute/composition-counts.js';
import { getComputeManager } from '../../compute/compute-manager.js';
import { OperationType } from '../../compute/operations.js';
import { createResultEnvelope, readResultEnvelope } from '../../shared/analysis-result-session.js';
import { describeOpenCellChoice } from '../../shared/open-cell-choice.js';
import { downloadCSV } from '../../shared/analysis-utils.js';
import { toCSVCell } from '../../compute/csv-export.js';
import { categoryDisplayName } from '../../../actions/targets/names.js';
import { createFieldGroups } from './field-groups.js';
import { fieldCategoryCss } from '../../../utils/category-state.js';
import { formatCount, formatCountOf, formatPercent, formatPValue, countNoun } from '../../../../utils/format-units.js';
import { escapeHtml } from '../../../utils/dom-utils.js';
import '../../plots/types/composition-bars.js';
import { failureDetails, sayFailure } from '../../../../utils/errors.js';
import { buttonClassName } from '../../../ui/components/controls.js';

const ADJUSTED_P_SIGNIFICANT = 0.05;

function significanceMark(p) {
  if (!Number.isFinite(p)) return '';
  if (p <= 0.001) return '***';
  if (p <= 0.01) return '**';
  if (p <= ADJUSTED_P_SIGNIFICANT) return '*';
  return '';
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


/** A finite number, or null (JSON has no NaN). */
const finiteOrNull = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * A composition result as one table, every cell type a row, the most
 * significant first (else the most abundant): its cells and pooled
 * proportion; when tested its mean proportion per condition, log₂ ratio,
 * test and p values; its proportion in each unit (sample, or condition) when
 * there are several. The agent's result table (`_resultTable`, its top rows)
 * and the CSV (`tableFile`, `file: true`) are this one table, so they cannot
 * disagree; the file adds the statistic, `n_samples_<condition>` (the
 * samples each condition's mean is over) and, for a paired test, `n_pairs`
 * (the pairs holding the type's cells, which its test took), which the agent
 * reads in the result's `about`.
 *
 * @param {object} composition
 * @param {{file: boolean}} options
 * @returns {{columns: string[], rows: Array<Array<string|number|null>>, unitTotals: number[]}}
 */
function compositionTable(composition, { file }) {
  const { types, units, counts, conditions, test } = composition;
  const unitCount = units.length;
  const unitTotals = units.map((_, unit) => types.reduce((sum, _type, type) => sum + counts[type * unitCount + unit], 0));
  const typeCells = types.map((_, type) => {
    let sum = 0;
    for (let unit = 0; unit < unitCount; unit++) sum += counts[type * unitCount + unit];
    return sum;
  });
  const perUnit = unitCount > 1;
  const paired = test !== null && test.pairs !== null;
  const columns = ['cell_type', 'cells', 'proportion'];
  if (test !== null) {
    columns.push(...conditions.map(name => `mean_proportion_${name}`), 'log2_ratio', 'test');
    if (file) columns.push('statistic');
    columns.push('p_value', 'p_adjusted');
    if (file) columns.push(...conditions.map(name => `n_samples_${name}`), ...(paired ? ['n_pairs'] : []));
  }
  if (perUnit) columns.push(...units.map(unit => `proportion_${unit.label}`));
  const order = types.map((_, index) => index);
  if (test !== null) {
    const p = index => (Number.isFinite(test.adjustedP[index]) ? test.adjustedP[index] : Infinity);
    order.sort((a, b) => p(a) - p(b) || typeCells[b] - typeCells[a]);
  } else {
    order.sort((a, b) => typeCells[b] - typeCells[a]);
  }
  const share = (part, whole) => (whole > 0 ? part / whole : null);
  const rows = order.map(index => [
    String(types[index]),
    typeCells[index],
    share(typeCells[index], composition.totalCells),
    ...(test === null ? [] : [
      ...conditions.map((_, condition) => finiteOrNull(test.meanProportion[index * conditions.length + condition])),
      finiteOrNull(test.log2Ratio[index]),
      test.typeTest[index],
      ...(file ? [finiteOrNull(test.statistic[index])] : []),
      finiteOrNull(test.pValue[index]),
      finiteOrNull(test.adjustedP[index]),
      ...(file ? [...conditions.map((_, condition) => test.unitsPerCondition[condition]), ...(paired ? [test.pairsTested[index]] : [])] : [])
    ]),
    ...(perUnit ? units.map((_, unit) => share(counts[index * unitCount + unit], unitTotals[unit])) : [])
  ]);
  return { columns, rows, unitTotals };
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
      onError: error => this._notifications.error(`Composition cell types: ${sayFailure(error)}`, { ...failureDetails(error), category: 'analysis' })
    });
  }

  /** Another set of open cells: the categories' counts are counted again on them. @override */
  _onOpenCellsChanged() {
    this._fieldGroups.reset();
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

  /** The categorical fields, the coloring field and the pages. */
  _getOptionsContext() {
    const categoricalFields = this.dataLayer.getAvailableVariables('categorical_obs').map(info => ({
      key: info.key,
      name: info.name ?? info.key,
      // Null until the field is read: its categories are not known yet.
      categoryCount: Array.isArray(info.categories) ? info.categories.length : (info.categoryCount ?? null)
    }));
    return {
      categoricalFields,
      colorField: this.dataLayer.getColoringCategoricalField(),
      pages: this.dataLayer.getPages().map(page => ({ id: page.id, name: page.name })),
      groupsFor: (_entry, record) => this._fieldGroups.groups(record.cellTypes)
    };
  }

  validateDataRequirements() {
    const base = super.validateDataRequirements();
    if (!base.valid) return base;
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
    // Cells drawn by the cell-type field at unequal shares: its proportions
    // are the subsample's design, not the data's.
    const choice = describeOpenCellChoice(this._openCells());
    if (choice !== null && choice.method === 'stratified' && !choice.representative && choice.field === options.cellTypes) {
      return `The open cells keep each ${options.cellTypes} at a chosen size, so its proportions are the subsample's, not the data's. Open every cell, or a uniform or proportional subsample.`;
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

  /** @override */
  _takesCellSample() {
    return true;
  }

  async _runAnalysisImpl(options, requestId, job, sample = null) {
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
      // Named as shown (`(empty)`, `(blank)` for a category with no name).
      typeNames.push(categoryDisplayName(typeField.categories[code]));
      typeColors.push(fieldCategoryCss(typeFieldState, code));
    });
    const identity = categories => Int32Array.from(categories.map((_, index) => index));
    const sampleNames = sampleField === null ? null : sampleField.categories.map(categoryDisplayName);
    const conditionNames = conditionField === null ? [] : conditionField.categories.map(categoryDisplayName);
    const conditionFieldState = conditionField === null ? null : fieldOf(options.condition);
    const cellCount = typeField.codes.length;
    // A first pass (`shared/progressive-cells.js`): the scope's cells in the sample.
    const scope = sample === null ? this._scopeMask(options.cells, cellCount) : sample.mask(this._scopeMask(options.cells, cellCount));

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
    // Samples with cells in both of two conditions: the pairs a paired test
    // takes, counted unpaired too so the result says when one is possible.
    const twoWithSamples = sampleField !== null && presentConditions.length === 2;
    const samplesInBoth = twoWithSamples ? compositionPairs(present.unitSample, conditionOfUnit).first.length : null;
    const paired = options.paired && sampleField !== null && conditionField !== null;
    if (paired && presentConditions.length !== 2) {
      throw new Error(`A paired test compares two conditions; the chosen cells hold ${formatCountOf(presentConditions.length, 'condition')} of ${options.condition}. Choose the cells of two (a page of them).`);
    }
    // A type is tested over the pairs holding its cells, at least
    // MIN_PAIRS_WITH_CELLS of them: with fewer pairs in all no type could be.
    if (paired && samplesInBoth < MIN_PAIRS_WITH_CELLS) {
      throw new Error(`A paired test needs at least ${MIN_PAIRS_WITH_CELLS} samples of ${options.samples} with cells in both conditions; ${formatCount(samplesInBoth)} ${samplesInBoth === 1 ? 'has' : 'have'}`);
    }
    const test = presentConditions.length >= 2
      ? testComposition({
        counts,
        typeCount,
        unitCount: units.length,
        conditionOfUnit,
        conditionCount: presentConditions.length,
        samples: sampleField !== null,
        unitSample: present.unitSample,
        paired,
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
      conditionColors: presentConditions.map(index => fieldCategoryCss(conditionFieldState, index)),
      counts,
      conditionOfUnit,
      splitSamples,
      totalCells,
      method: options.method,
      correction: options.correction,
      samplesInBoth,
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
    if (composition.test !== null) {
      const absent = composition.types.filter((_, index) => composition.test.typeTest[index] === NO_CELLS);
      if (absent.length > 0) {
        chips.push({
          text: `${formatCount(absent.length)} ${countNoun(absent.length, 'type')} without cells`,
          tone: 'info',
          title: `No cells in the samples tested (paired: in the pairs), so not tested and not counted in the multiple-testing correction: ${absent.join(', ')}`
        });
      }
      const few = composition.types.filter((_, index) => composition.test.typeTest[index] === TOO_FEW_PAIRS);
      if (few.length > 0) {
        chips.push({
          text: `${formatCount(few.length)} ${countNoun(few.length, 'type')} in too few pairs`,
          tone: 'info',
          title: `Cells in fewer than ${MIN_PAIRS_WITH_CELLS} pairs, so not tested and not counted in the multiple-testing correction (a pair without the type on either side says nothing about it): ${few.join(', ')}`
        });
      }
    }
    return chips;
  }

  async _showResult(result, requestId) {
    // The sidebar preview leaves the legend out (hover names each type);
    // the expanded view shows it.
    const rendered = await this._renderPreviewPlot({
      result,
      plotOptions: { ...result.options, legendPosition: 'none' },
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
      if (composition.samplesInBoth !== null) {
        rows.push(['Samples in both conditions', `${formatCount(composition.samplesInBoth)}${composition.test.pairs !== null ? ', tested paired' : ''}`]);
      }
      rows.push(['Multiple testing', composition.correction === 'bh' ? 'Benjamini-Hochberg' : 'Bonferroni']);
      if (composition.test.overall !== null) {
        rows.push(['Type × condition χ²', `${composition.test.overall.statistic.toFixed(2)} (df ${composition.test.overall.df}), p ${formatPValue(composition.test.overall.pValue)}`]);
      }
    }
    container.innerHTML = `<table class="analysis-stats-table">${rows.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td><strong>${escapeHtml(value)}</strong></td></tr>`).join('')}</table>`;
    const counts = document.createElement('button');
    counts.type = 'button';
    counts.className = buttonClassName('quiet');
    counts.textContent = 'Counts CSV';
    counts.title = 'Cells per cell type and sample, for other tools';
    counts.addEventListener('click', () => this._trackInteractiveTask(this._downloadCounts(), 'CSV export'));
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
        cells.push(Number.isFinite(mean) ? formatPercent(mean * 100, 1) : '–');
      }
      if (conditions.length === 2 && test !== null) {
        const ratio = test.log2Ratio[index];
        cells.push(Number.isFinite(ratio) ? ratio.toFixed(2) : '–');
      }
      if (test !== null && test.typeTest[index] === NO_CELLS) {
        cells.push(composition.test.pairs === null ? 'No cells in scope' : 'No cells in the pairs', '–', '–');
      } else if (test !== null && test.typeTest[index] === TOO_FEW_PAIRS) {
        cells.push(`Cells in ${formatCountOf(test.pairsTested[index], 'pair')} of ${formatCount(test.pairs)}`, '–', '–');
      } else if (test !== null) {
        cells.push(
          Number.isFinite(test.statistic[index]) ? test.statistic[index].toPrecision(3) : '–',
          formatPValue(test.pValue[index]),
          `${formatPValue(test.adjustedP[index])}${significanceMark(test.adjustedP[index]) === '' ? '' : ` ${significanceMark(test.adjustedP[index])}`}`
        );
      }
      return `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`;
    });
    container.innerHTML = conditions.length < 2
      ? '<p class="empty-state">Choose a condition to compare the proportions.</p>'
      : `<table class="analysis-stats-table composition-table"><thead><tr>${header.map(cell => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead><tbody>${body.join('')}</tbody></table>`;
  }

  /** The counts, one row per cell type and one column per sample (or condition). */
  async _downloadCounts() {
    if (await this._refuseStaleExport('CSV')) return;
    const file = this._countsFile();
    if (file !== null) downloadCSV(file.csv, file.name, this._notifications);
  }

  /** The counts table file, or null with no result. */
  _countsFile() {
    const composition = this._lastResult?.composition;
    if (!composition) return null;
    const { types, units, counts } = composition;
    const lines = [['cell_type', ...units.map(unit => unit.label)].map(toCSVCell).join(',')];
    types.forEach((type, index) => {
      lines.push([type, ...units.map((_, unit) => counts[index * units.length + unit])].map(toCSVCell).join(','));
    });
    return { name: 'composition_counts', csv: lines.join('\n') };
  }

  /**
   * The expanded view's CSV: the results per cell type when there is a
   * test, else the counts. Each click downloads one file (Safari keeps only
   * one download of a click); the counts beside results come from the
   * summary's own link. The rows are the agent's result table
   * (`compositionTable`) whole, with what a file read alone needs besides:
   * the statistic, the samples each condition's mean is over and, paired,
   * the pairs the test took (F108: the file once gave every sample as the
   * test's and left out the per-sample proportions).
   */
  tableFile() {
    const composition = this._lastResult?.composition;
    if (!composition) return null;
    if (composition.test === null) return this._countsFile();
    const { columns, rows } = compositionTable(composition, { file: true });
    const lines = [columns.map(toCSVCell).join(',')];
    for (const row of rows) lines.push(row.map(toCSVCell).join(','));
    return { name: 'composition_results', csv: lines.join('\n') };
  }

  // ---------------------------------------------------------------- Sessions

  /**
   * As an agent reads the result (`describeResult`): each cell type's cells
   * and pooled proportion, its proportion in each sample (or condition: each
   * unit of the bars), and when tested its mean proportion per condition,
   * ratio, test and p values, the most significant first, else the most
   * abundant (top `top`). Before, without a condition the rows held only the
   * names: no number an agent could read, and the per-sample shares a
   * donor-level argument needs were never given.
   * @override
   */
  _resultTable(result, top) {
    const composition = result?.composition;
    if (!composition) return { columns: [], rows: [], total: 0, about: null };
    const { columns, rows, unitTotals } = compositionTable(composition, { file: false });
    return { columns, rows: rows.slice(0, top), total: composition.types.length, about: this._resultAbout(composition, unitTotals) };
  }

  /** What the composition counted and tested, as the expanded view's Statistics say it. */
  _resultAbout(composition, unitTotals) {
    const { fields, units, conditions, test } = composition;
    return {
      cell_types: fields.cellTypes,
      samples: fields.samples === '' ? null : fields.samples,
      condition: fields.condition === '' ? null : fields.condition,
      cells: composition.totalCells,
      cells_per_unit: units.map((unit, index) => ({ name: unit.label, cells: unitTotals[index] })),
      ...(test === null ? { test: null } : {
        test: test.test,
        samples_per_condition: conditions.map((name, condition) => ({ name, samples: test.unitsPerCondition[condition] })),
        ...(composition.samplesInBoth === null ? {} : {
          pairing: test.pairs !== null
            ? `paired: ${formatCountOf(test.pairs, 'sample')} of ${fields.samples} in both conditions; ${units.length - 2 * test.pairs} units of a sample in one condition only left out; each type tested over the pairs holding its cells, a type in fewer than ${MIN_PAIRS_WITH_CELLS} not tested (test: too few pairs); mean proportions and log2_ratio are over the pairs' samples, as the test reads them`
            : composition.samplesInBoth >= MIN_PAIRS_WITH_CELLS
              ? `unpaired; ${formatCountOf(composition.samplesInBoth, 'sample')} of ${fields.samples} are in both conditions: paired: true tests them paired`
              : `unpaired; ${formatCountOf(composition.samplesInBoth, 'sample')} of ${fields.samples} in both conditions, too few to pair`
        }),
        multiple_testing: composition.correction === 'bh' ? 'Benjamini–Hochberg' : 'Bonferroni',
        ...(test.overall === null ? {} : { overall: `type × condition χ² ${test.overall.statistic.toFixed(2)} (df ${test.overall.df}), p ${formatPValue(test.overall.pValue)}` })
      }),
      proportions: `of each unit's counted cells; mean_proportion_* is the mean over a condition's samples${test?.pairs != null ? ' in both conditions (the pairs)' : ''}`
    };
  }

  _exportResult() {
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
      !(composition.conditionOfUnit instanceof Int32Array) ||
      (composition.samplesInBoth !== null && !Number.isSafeInteger(composition.samplesInBoth)) ||
      composition.test === undefined ||
      (composition.test !== null && (composition.test.pairs === undefined || composition.test.pairsTested === undefined))
    ) {
      throw new TypeError('A composition result must hold its counts per cell type and unit');
    }
    for (const key of Object.values(composition.fields)) {
      if (key !== '' && this.dataLayer.getVariableInfo('categorical_obs', key) === null) {
        throw new Error(`The composition result names the field "${key}", which this dataset lacks`);
      }
    }
    await this._restoreAnalysisResult(result, envelope.provenance);
  }
}

export function createCompositionUI(options) {
  const ui = new CompositionUI(options);
  ui.init(options.container);
  return ui;
}
