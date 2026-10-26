/**
 * Analysis form helpers.
 *
 * Every control here is built by the shared control kit
 * (`ui/components/controls.js`): this module only adds what is specific to
 * analysis forms: a labelled select with an optional (i).
 *
 * NOTE: Number formatting lives in `ui/components/display-format.js`.
 *
 * @module shared/dom-utils
 */

import {
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
