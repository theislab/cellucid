/**
 * @fileoverview The title a figure is given until the person writes their own.
 *
 * @module ui/modules/figure-export/utils/figure-title
 */

import { categoryVisibilityText } from '../../../../utils/category-visibility-text.js';

/**
 * "Dataset • field", and, when some of the field's categories are hidden,
 * which ones as the filter list says it, the smaller side named ("Dataset •
 * cell_type: hiding B1 cells", "… : showing only B cells, T cells"); with
 * every one shown the field says it (found 2026-11-10: "cell_type: AXL+ and
 * SIGLEC6+ DCs, B1 cells +67" over all 69 cell types). A category no cell
 * passing the other filters falls in is on neither side.
 *
 * `otherFilters`: the filters on other fields, as the filter list says them
 * ("LVL0: showing only Epithelial"), each after the field as the view's own
 * label names them ("He • LVL2 • LVL0: showing only Epithelial"). The legend
 * lists no category those filters leave without cells (`legendEntries`), so
 * the title is where the figure says why (F113).
 *
 * `viewName`: the name the view was given (`view.rename`): a named view's
 * figure is titled "Dataset • <name>", the name the person chose for what it
 * shows standing for its field and filters.
 *
 * @param {{datasetName: string, fieldLabel: string, legendModel: object|null, otherFilters?: string[], viewName?: string|null}} input
 * @returns {string} Empty when there is nothing to name
 */
export function figureAutoTitle({ datasetName, fieldLabel, legendModel, otherFilters = [], viewName = null }) {
  if (typeof viewName === 'string' && viewName.trim() !== '') {
    return [datasetName, viewName.trim()].filter(part => part).join(' • ');
  }
  let categorySummary = '';
  const categories = legendModel?.kind === 'category' && Array.isArray(legendModel.categories)
    ? legendModel.categories
    : [];
  const visible = legendModel?.visible ?? null;
  const available = legendModel?.counts?.available ?? null;
  if (visible !== null) {
    const hidden = [];
    const shown = [];
    categories.forEach((name, i) => {
      if (available !== null && (Number(available[i]) || 0) <= 0) return;
      const text = String(name ?? '').trim();
      if (!text) return;
      (visible[i] === 0 ? hidden : shown).push(text);
    });
    if (hidden.length > 0) categorySummary = categoryVisibilityText(hidden, shown);
  }
  const field = fieldLabel && categorySummary ? `${fieldLabel}: ${categorySummary}` : (fieldLabel || categorySummary);
  return [datasetName, field, ...otherFilters.map(text => String(text ?? '').trim())].filter(part => part).join(' • ');
}

/**
 * Whether a grid export's panels are colored by different fields: then the
 * figure is titled by the dataset alone and each panel names its own field
 * (found 2026-11-10: a grid of cell_type and organ panels titled "… • organ").
 * The panels are the live view (unless hidden) and every kept view, as the
 * export draws them.
 *
 * @param {{viewLayout: {mode: string, liveViewHidden?: boolean}, snapshotViewIds: string[], fieldKeyOf: (viewId: string) => string|null}} input
 * @returns {boolean}
 */
export function gridPanelsDifferInField({ viewLayout, snapshotViewIds, fieldKeyOf }) {
  if (viewLayout?.mode !== 'grid') return false;
  const viewIds = [...(viewLayout.liveViewHidden ? [] : ['live']), ...snapshotViewIds];
  return new Set(viewIds.map(fieldKeyOf)).size > 1;
}
