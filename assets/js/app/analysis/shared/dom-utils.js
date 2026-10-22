/**
 * Analysis form helpers.
 *
 * Every control here is built by the shared control kit
 * (`ui/components/controls.js`): this module only adds what is specific to
 * analysis forms — a labelled select with an optional (i), and the
 * performance-settings disclosure shared by Differential Expression and
 * Marker Genes.
 *
 * NOTE: Number formatting lives in `ui/components/display-format.js`.
 *
 * @module shared/dom-utils
 */

import { PerformanceConfig } from './performance-config.js';
import {
  createDisclosure,
  createField,
  createSelect
} from '../../ui/components/controls.js';
import { createDomId } from '../../ui/components/dom-id.js';

/**
 * Sentinel value for "None" selection in dropdowns
 */
export const NONE_VALUE = '-1';

/**
 * A labelled select for an analysis form. What the choices mean is explained
 * by the field's (i) tip, not by a help line under the select.
 *
 * @param {Object} options
 * @param {string} options.label - Visible label, sentence case, no colon.
 * @param {string} options.name - The control's `name`, which form snapshots read.
 * @param {Array<{value: string|number, label: string, selected?: boolean}>} options.options
 * @param {string} [options.tip] - Registry key of the field's (i) tip.
 * @param {(value: string) => void} [options.onChange]
 * @param {string} [options.className] - Extra class for the field block.
 * @returns {{ root: HTMLDivElement, select: HTMLSelectElement }}
 */
export function createSelectField({ label, name, options, tip, onChange, className }) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new TypeError(`Select field "${label}" requires its options`);
  }
  if (onChange !== undefined && typeof onChange !== 'function') {
    throw new TypeError(`Select field "${label}" change handler must be a function`);
  }
  const select = createSelect({
    name,
    id: createDomId(`form-select-${name}`),
    options: options.map(option => ({
      value: String(option.value),
      label: option.label,
      selected: option.selected === true
    }))
  });
  const root = createField({ label, control: select, tip, className });
  if (onChange !== undefined) {
    select.addEventListener('change', () => onChange(select.value));
  }
  return { root, select };
}

/**
 * Create a collapsible performance settings section
 *
 * Shared UI component for DE Analysis, Genes Panel, and other analysis types.
 * Uses PerformanceConfig for options and recommendations.
 *
 * @param {Object} options
 * @param {Object} options.dataLayer - Data layer for accessing dataset info
 * @param {string} [options.className='analysis-performance-settings'] - CSS class prefix
 * @param {boolean} [options.collapsed=true] - Start collapsed
 * @returns {HTMLDivElement} Performance settings section element
 */
export function createPerformanceSettings(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options)
  ) {
    throw new TypeError('Performance settings options must be an object');
  }
  const {
    dataLayer,
    className = 'analysis-performance-settings',
    collapsed = true
  } = options;
  if (
    dataLayer === null ||
    typeof dataLayer !== 'object' ||
    dataLayer.state === null ||
    typeof dataLayer.state !== 'object' ||
    typeof dataLayer.getAvailableVariables !== 'function'
  ) {
    throw new TypeError(
      'Performance settings require a DataLayer with exact dataset metadata'
    );
  }
  if (typeof className !== 'string' || className.length === 0) {
    throw new TypeError(
      'Performance settings className must be a non-empty string'
    );
  }
  if (typeof collapsed !== 'boolean') {
    throw new TypeError('Performance settings collapsed must be a boolean');
  }

  // Get data characteristics
  const pointCount = dataLayer.state.pointCount;
  if (!Number.isSafeInteger(pointCount) || pointCount <= 0) {
    throw new RangeError(
      'Performance settings require an exact positive dataset pointCount'
    );
  }
  const genes = dataLayer.getAvailableVariables('gene_expression');
  if (!Array.isArray(genes) || genes.length === 0) {
    throw new Error(
      'Performance settings require the exact available gene inventory'
    );
  }
  const geneCount = genes.length;
  const recommended = PerformanceConfig.getRecommendedSettings(
    pointCount,
    geneCount
  );

  const { root: container, content } = createDisclosure({
    title: 'Performance settings',
    tip: 'analysis-performance',
    expanded: !collapsed,
    className: `disclosure-inline ${className}`
  });

  // Batch size selector
  const batchOptions = PerformanceConfig.getBatchSizeOptions(
    pointCount,
    geneCount
  );
  content.appendChild(createSelectField({
    label: 'Batch size',
    name: 'batchSize',
    options: batchOptions.map(opt => ({
      value: String(opt.value),
      label: opt.label,
      selected: opt.selected
    }))
  }).root);

  // Memory budget selector
  const memoryOptions = PerformanceConfig.getMemoryBudgetOptions();
  content.appendChild(createSelectField({
    label: 'Memory budget',
    name: 'memoryBudget',
    options: memoryOptions.map(opt => ({
      value: String(opt.value),
      label: opt.label,
      selected: opt.value === recommended.memoryBudgetMB
    }))
  }).root);

  // Network concurrency selector
  const networkOptions = PerformanceConfig.getNetworkConcurrencyOptions();
  content.appendChild(createSelectField({
    label: 'Network parallelism',
    name: 'networkConcurrency',
    options: networkOptions.map(opt => ({
      value: String(opt.value),
      label: opt.label,
      selected: opt.value === recommended.networkConcurrency
    }))
  }).root);

  // Parallelism selector
  content.appendChild(createSelectField({
    label: 'Compute parallelism',
    name: 'parallelism',
    options: [
    {
      value: 'auto',
      label: 'Auto',
      selected: true
    },
    {
      value: '1',
      label: '1 core'
    },
    {
      value: '2',
      label: '2 cores'
    },
    {
      value: '4',
      label: '4 cores'
    },
    {
      value: '8',
      label: '8 cores'
    }
    ]
  }).root);

  return container;
}

/**
 * Extract performance settings from a form container
 *
 * @param {HTMLElement} formContainer - Form container element
 * @returns {Object} Performance settings object
 */
export function getPerformanceFormValues(formContainer) {
  if (
    formContainer === null ||
    typeof formContainer !== 'object' ||
    typeof formContainer.querySelector !== 'function'
  ) {
    throw new TypeError(
      'Performance form values require a queryable form container'
    );
  }
  const getValue = (name) => {
    const field = formContainer.querySelector(`[name="${name}"]`);
    if (
      field === null ||
      typeof field !== 'object' ||
      typeof field.value !== 'string' ||
      field.value.length === 0
    ) {
      throw new Error(`Performance form field "${name}" is required`);
    }
    return field.value;
  };
  const readPositiveInteger = (name, value) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new RangeError(
        `Performance form field "${name}" must be a positive integer`
      );
    }
    return parsed;
  };

  const parallelismRaw = getValue('parallelism');
  const batchSizeRaw = getValue('batchSize');
  const memoryBudgetRaw = getValue('memoryBudget');
  const networkConcurrencyRaw = getValue('networkConcurrency');
  if (
    parallelismRaw !== 'auto' &&
    !['1', '2', '4', '8'].includes(parallelismRaw)
  ) {
    throw new RangeError(
      'Performance form parallelism must be auto, 1, 2, 4, or 8'
    );
  }

  return {
    parallelism: parallelismRaw === 'auto'
      ? 'auto'
      : readPositiveInteger('parallelism', parallelismRaw),
    batchConfig: {
      preloadCount: readPositiveInteger('batchSize', batchSizeRaw),
      memoryBudgetMB: readPositiveInteger('memoryBudget', memoryBudgetRaw),
      networkConcurrency: readPositiveInteger(
        'networkConcurrency',
        networkConcurrencyRaw
      )
    }
  };
}
