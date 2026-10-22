/**
 * @fileoverview DOM construction for CategoryBuilder.
 *
 * The builder uses a fairly large HTML template; extracting it keeps the main
 * `CategoryBuilder` class focused on behavior and state management.
 *
 * @module ui/category-builder/dom
 */

import { renderInfoTip } from '../components/info-tips.js';

const TEMPLATE = `
  <div class="disclosure" id="cat-builder-accordion-item">
    <div class="disclosure-header-row">
      <button type="button" class="disclosure-header" aria-expanded="false">
        <span class="disclosure-title">Create categorical</span>
        <span class="disclosure-chevron" aria-hidden="true"></span>
      </button>
      <button type="button" id="cat-builder-info-btn" class="info-btn" aria-label="About creating a categorical" aria-controls="cat-builder-info-tooltip" aria-haspopup="dialog" aria-expanded="false"><span aria-hidden="true">i</span></button>
    </div>
    <div id="cat-builder-info-tooltip" class="info-tooltip" role="dialog" aria-labelledby="cat-builder-info-btn" tabindex="-1" data-info-tip="create-categorical" hidden></div>

    <div class="disclosure-content" id="cat-builder-panel" hidden>
      <div class="cat-builder">
        <div class="cat-builder-dropzone" id="cat-builder-dropzone" role="group" aria-label="Category labels">
          <p class="empty-state" id="dropzone-placeholder">Drop pages here.</p>
          <div class="dropzone-items" id="dropzone-items" role="list" aria-label="Pages in the new column"></div>
        </div>

        <div class="cat-builder-section">
          <label for="cat-builder-page-select">Add page</label>
          <div class="cat-builder-add-row">
            <select class="obs-select" id="cat-builder-page-select"></select>
            <button type="button" class="btn btn-compact" id="cat-builder-add-page">Add</button>
          </div>
        </div>

        <div class="cat-builder-section cat-builder-conflict" id="conflict-section" hidden>
          <div class="section-header warning">
            <span id="conflict-text">Overlapping cells detected</span>
          </div>
          <div class="section-content">
            <div class="radio-group" role="radiogroup" aria-labelledby="overlap-strategy-title">
              <h3 class="section-title" id="overlap-strategy-title">Overlapping cells</h3>
              <label class="checkbox-inline"><input type="radio" name="overlap-strategy" value="first" checked>First page</label>
              <label class="checkbox-inline"><input type="radio" name="overlap-strategy" value="last">Last page</label>
              <label class="checkbox-inline"><input type="radio" name="overlap-strategy" value="overlap-label">New label</label>
              <label class="checkbox-inline"><input type="radio" name="overlap-strategy" value="intersections">Each intersection</label>
            </div>

            <div class="cat-builder-overlap-extra" id="overlap-label-section" hidden>
              <label for="overlap-label">Label for overlapping cells</label>
              <input type="text" class="obs-select" id="overlap-label" value="Overlap" />
            </div>

            <div class="cat-builder-overlap-extra" id="intersection-labels-section" hidden>
              <span class="field-label">Intersection labels</span>
              <div class="cat-builder-intersection-list" id="intersection-labels"></div>
            </div>
          </div>
        </div>

        <div class="cat-builder-section cat-builder-uncovered" id="uncovered-section" hidden>
          <div class="section-header">
            <span><span id="uncovered-count">0</span> cells not in any page</span>
          </div>
          <div class="section-content">
            <label for="uncovered-label">Label for uncovered cells</label>
            <input type="text" class="obs-select" id="uncovered-label" value="Unassigned" />
          </div>
        </div>

        <div class="cat-builder-section">
          <label for="cat-builder-name">Column name</label>
          <input type="text" class="obs-select" id="cat-builder-name" placeholder="Custom categories" />
        </div>

        <div class="cat-builder-preview" id="cat-builder-preview"></div>
        <p class="status-line" data-tone="danger" id="cat-builder-validation" role="status" aria-live="polite" hidden></p>

        <div class="cat-builder-actions">
          <button type="button" class="btn" id="cat-builder-cancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="cat-builder-confirm" disabled>Create</button>
        </div>
      </div>
    </div>
  </div>
`;

/**
 * Render the CategoryBuilder UI into the given container.
 *
 * @param {HTMLElement} containerEl
 * @returns {object} DOM references used by CategoryBuilder
 */
export function renderCategoryBuilderDom(containerEl) {
  if (containerEl === null || typeof containerEl !== 'object') {
    throw new TypeError(
      'Category builder DOM requires one document-owned HTMLElement'
    );
  }
  const ownerDocument = containerEl.ownerDocument;
  if (ownerDocument === null || ownerDocument === undefined) {
    throw new TypeError(
      'Category builder DOM requires one document-owned HTMLElement'
    );
  }
  const view = ownerDocument.defaultView;
  if (
    view === null
    || view === undefined
    || !(containerEl instanceof view.HTMLElement)
  ) {
    throw new TypeError(
      'Category builder DOM requires one document-owned HTMLElement'
    );
  }

  const wrapper = ownerDocument.createElement('div');
  wrapper.className = 'disclosure-list cat-builder-wrapper';
  wrapper.innerHTML = TEMPLATE;
  renderInfoTip(wrapper.querySelector('#cat-builder-info-tooltip'), 'create-categorical');

  const elements = {
    wrapper,
    item: wrapper.querySelector('#cat-builder-accordion-item'),
    toggle: wrapper.querySelector('.disclosure-header'),
    panel: wrapper.querySelector('.disclosure-content'),
    dropzone: wrapper.querySelector('#cat-builder-dropzone'),
    placeholder: wrapper.querySelector('#dropzone-placeholder'),
    items: wrapper.querySelector('#dropzone-items'),
    pageSelect: wrapper.querySelector('#cat-builder-page-select'),
    addPageBtn: wrapper.querySelector('#cat-builder-add-page'),
    conflictSection: wrapper.querySelector('#conflict-section'),
    conflictText: wrapper.querySelector('#conflict-text'),
    overlapLabelSection: wrapper.querySelector('#overlap-label-section'),
    overlapLabel: wrapper.querySelector('#overlap-label'),
    intersectionSection: wrapper.querySelector('#intersection-labels-section'),
    intersectionList: wrapper.querySelector('#intersection-labels'),
    uncoveredSection: wrapper.querySelector('#uncovered-section'),
    uncoveredCount: wrapper.querySelector('#uncovered-count'),
    uncoveredLabel: wrapper.querySelector('#uncovered-label'),
    fieldName: wrapper.querySelector('#cat-builder-name'),
    preview: wrapper.querySelector('#cat-builder-preview'),
    validation: wrapper.querySelector('#cat-builder-validation'),
    confirmBtn: wrapper.querySelector('#cat-builder-confirm'),
    cancelBtn: wrapper.querySelector('#cat-builder-cancel')
  };
  for (const [name, element] of Object.entries(elements)) {
    if (!(element instanceof view.HTMLElement)) {
      throw new Error(
        `Category builder DOM is missing required element "${name}"`
      );
    }
  }

  containerEl.replaceChildren(wrapper);
  return elements;
}
