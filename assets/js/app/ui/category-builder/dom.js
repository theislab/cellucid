/**
 * @fileoverview DOM construction for CategoryBuilder.
 *
 * The builder uses a fairly large HTML template; extracting it keeps the main
 * `CategoryBuilder` class focused on behavior and state management.
 *
 * @module ui/category-builder/dom
 */

const TEMPLATE = `
  <div class="analysis-accordion-item" id="cat-builder-accordion-item">
    <button type="button" class="analysis-accordion-header" aria-expanded="false">
      <span class="analysis-accordion-title">Create Categorical</span>
      <span class="analysis-accordion-desc">Build a new categorical obs column from highlight pages.</span>
      <span class="analysis-accordion-chevron" aria-hidden="true"></span>
    </button>

    <div class="analysis-accordion-content">
      <div class="cat-builder">
        <p class="cat-builder-hint">Drag highlight pages from above to create category labels.</p>

        <div class="cat-builder-dropzone" id="cat-builder-dropzone">
          <div class="dropzone-placeholder" id="dropzone-placeholder">
            <span>Drop pages here</span>
          </div>
          <div class="dropzone-items" id="dropzone-items"></div>
        </div>

        <div class="cat-builder-section cat-builder-conflict" id="conflict-section" hidden>
          <div class="section-header warning">
            <span id="conflict-text">Overlapping cells detected</span>
          </div>
          <div class="section-content">
            <label>Assign overlapping cells to:</label>
            <div class="radio-group">
              <label><input type="radio" name="overlap-strategy" value="first" checked> First page</label>
              <label><input type="radio" name="overlap-strategy" value="last"> Last page</label>
              <label><input type="radio" name="overlap-strategy" value="overlap-label"> New label</label>
              <label><input type="radio" name="overlap-strategy" value="intersections"> Each intersection</label>
            </div>

            <div class="cat-builder-overlap-extra" id="overlap-label-section" hidden>
              <label for="overlap-label">Label for overlapping cells:</label>
              <input type="text" id="overlap-label" value="Overlap" />
            </div>

            <div class="cat-builder-overlap-extra" id="intersection-labels-section" hidden>
              <div class="cat-builder-intersection-hint">
                Name each overlap condition (e.g. A &amp; B, A &amp; B &amp; C).
              </div>
              <div class="cat-builder-intersection-list" id="intersection-labels"></div>
            </div>
          </div>
        </div>

        <div class="cat-builder-section cat-builder-uncovered" id="uncovered-section" hidden>
          <div class="section-header">
            <span><span id="uncovered-count">0</span> cells not in any page</span>
          </div>
          <div class="section-content">
            <label for="uncovered-label">Label for uncovered cells:</label>
            <input type="text" id="uncovered-label" value="Unassigned" />
          </div>
        </div>

        <div class="cat-builder-section">
          <label for="cat-builder-name">Column name:</label>
          <input type="text" id="cat-builder-name" placeholder="Custom Categories" />
        </div>

        <div class="cat-builder-preview" id="cat-builder-preview"></div>

        <div class="cat-builder-actions">
          <button type="button" class="cat-builder-btn secondary" id="cat-builder-cancel">Cancel</button>
          <button type="button" class="cat-builder-btn secondary" id="cat-builder-confirm" disabled>Create</button>
        </div>
      </div>
    </div>
  </div>
`;

/**
 * Render the CategoryBuilder UI into the given container.
 *
 * @param {HTMLElement|null} containerEl
 * @returns {object} DOM references used by CategoryBuilder
 */
export function renderCategoryBuilderDom(containerEl) {
  if (!containerEl) return {};

  const wrapper = document.createElement('div');
  wrapper.className = 'analysis-accordion cat-builder-wrapper';
  wrapper.innerHTML = TEMPLATE;

  containerEl.appendChild(wrapper);

  const item = wrapper.querySelector('#cat-builder-accordion-item');
  const toggle = wrapper.querySelector('.analysis-accordion-header');
  const panel = wrapper.querySelector('.analysis-accordion-content');

  return {
    wrapper,
    item,
    toggle,
    panel,
    dropzone: wrapper.querySelector('#cat-builder-dropzone'),
    placeholder: wrapper.querySelector('#dropzone-placeholder'),
    items: wrapper.querySelector('#dropzone-items'),
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
    confirmBtn: wrapper.querySelector('#cat-builder-confirm'),
    cancelBtn: wrapper.querySelector('#cat-builder-cancel')
  };
}
