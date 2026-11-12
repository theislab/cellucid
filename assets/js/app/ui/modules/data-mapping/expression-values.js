/**
 * @fileoverview Session › Data mapping › Expression values: the disclosure of
 * the expression transform (`data/expression-transform.js`), collapsed, its
 * header saying the values shown ("Raw values", "Normalized · log1p").
 *
 * Two switches, each a change made at once (`expression.transform.set`,
 * not staged with the mapping's Apply): **Normalize to library size** and
 * **Log transform (log1p)**. Under the first, where each cell's total comes
 * from: an obs column (free), or every gene summed once, with what that
 * reads at the link as measured. The switches are off by default, and
 * disabled with the reason when the mapped matrix does not take them (not
 * counts, or `log1p` already). Nested controls, so quiet: compact switches
 * and muted lines (the control standard, `assets/css/README.md`).
 *
 * Markup only: the controller (`../data-mapping-controls.js`) gives the
 * model and dispatches the change.
 *
 * @module ui/modules/data-mapping/expression-values
 */

import { createDisclosure, createStatusLine, createSwitch } from '../../components/controls.js';
import { setText } from './dom.js';
import { setControlAvailability } from '../../core/control-availability.js';
import { PLACES } from '../../place-names.js';

/** The section id the panel and the tests find it by. */
export const EXPRESSION_VALUES_SECTION = 'expression-values';

/**
 * Build the section once.
 *
 * @param {{onChange: (change: {normalize?: boolean, log1p?: boolean}) => void}} options
 * @returns {{root: HTMLDivElement, disclosure: Object, render: (model: ExpressionValuesModel) => void}}
 */
export function buildExpressionValuesSection({ onChange }) {
  if (typeof onChange !== 'function') throw new TypeError('The expression values section needs onChange().');
  const disclosure = createDisclosure({
    title: PLACES.expressionValues.name,
    description: 'Raw values',
    tip: 'data-mapping-expression-values',
    expanded: false,
  });
  disclosure.root.classList.add('data-mapping-group', 'data-mapping-expression-values');
  disclosure.root.dataset.mappingSection = EXPRESSION_VALUES_SECTION;
  const description = disclosure.header.querySelector('.disclosure-desc');
  const normalize = createSwitch({ label: 'Normalize to library size', onChange: next => onChange({ normalize: next }) });
  const log1p = createSwitch({ label: 'Log transform (log1p)', onChange: next => onChange({ log1p: next }) });
  for (const control of [normalize, log1p]) control.root.classList.add('switch-compact');
  normalize.root.dataset.expressionSwitch = 'normalize';
  log1p.root.dataset.expressionSwitch = 'log1p';
  const source = createStatusLine({ tone: 'muted' });
  source.root.classList.add('data-mapping-hint', 'expression-values-source');
  const status = createStatusLine({ tone: 'muted' });
  status.root.classList.add('data-mapping-hint', 'expression-values-status');
  disclosure.content.append(normalize.root, source.root, log1p.root, status.root);

  /**
   * @typedef {Object} ExpressionValuesModel
   * @property {boolean} shown - Whether the dataset has genes (the section shows)
   * @property {string} summary - The header's status ("Raw values", "Normalized · log1p")
   * @property {{normalize: boolean, log1p: boolean}} asked
   * @property {boolean} offered - Whether the mapped matrix takes the transform
   * @property {string|null} reason - Why it does not
   * @property {string} source - Where each cell's total comes from, one line
   * @property {string} sourceDetail - Its details (the line's tooltip)
   * @property {boolean} busy - A change is being made
   * @property {{text: string, tone: string}|null} status - What the last change said
   */
  function render(model) {
    disclosure.root.hidden = !model.shown;
    if (!model.shown) return;
    setText(description, model.summary);
    normalize.setChecked(model.asked.normalize);
    log1p.setChecked(model.asked.log1p);
    const reason = !model.offered
      ? model.reason ?? 'this dataset offers no expression values to change'
      : model.busy ? 'Applying the data mapping…' : null;
    for (const control of [normalize, log1p]) setControlAvailability(control.root, reason);
    // Status lines stay in the tree while empty (a live region must be).
    source.set(model.offered ? model.source : '', 'muted');
    if (model.sourceDetail === '') source.root.removeAttribute('title');
    else source.root.title = model.sourceDetail;
    const said = !model.offered ? { text: model.reason ?? '', tone: 'muted' } : model.status ?? { text: '', tone: 'muted' };
    status.set(said.text, said.tone);
  }

  return { root: disclosure.root, disclosure, render };
}
