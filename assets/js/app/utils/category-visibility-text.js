/**
 * @fileoverview What a categorical field's legend shows, in a few words, as
 * the filter list and a figure's title say it.
 *
 * @module app/utils/category-visibility-text
 */

/** Up to four names, then how many more. */
function namesPreview(names) {
  return `${names.slice(0, 4).join(', ')}${names.length > 4 ? ` +${names.length - 4} more` : ''}`;
}

/**
 * The smaller side named (`showing only CD4 T, CD8 T` rather than `hiding`
 * the 67 others), every row of the legend counted and nothing it does not
 * list.
 *
 * @param {string[]} hiddenNames
 * @param {string[]} shownNames
 * @returns {string}
 */
export function categoryVisibilityText(hiddenNames, shownNames) {
  if (shownNames.length === 0) {
    return hiddenNames.length === 1 ? `hiding ${hiddenNames[0]}` : 'hiding every category';
  }
  return shownNames.length < hiddenNames.length
    ? `showing only ${namesPreview(shownNames)}`
    : `hiding ${namesPreview(hiddenNames)}`;
}
