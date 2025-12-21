/**
 * CategoryBuilder - Create a user-defined categorical field from highlight pages.
 *
 * This is a development-phase UI tool that:
 * - Lets users drag highlight pages into a "builder" list
 * - Resolves overlaps with a selectable strategy (first/last/new label/intersections)
 * - Optionally assigns an "uncovered" label for cells not present in any page
 * - Calls `state.createCategoricalFromPages(...)` to materialize the field
 *
 * The builder UI is intentionally excluded from state serialization via
 * `data-state-serializer-skip` on the container element.
 */

import { getNotificationCenter } from '../notification-center.js';
import { bindDropZone } from './components/drop-zone.js';
import { StyleManager } from '../../utils/style-manager.js';
import { getCategoryColor, rgbToCss } from '../../data/palettes.js';
import { formatCellCount } from '../../data/data-source.js';
import { Limits, OverlapStrategy } from '../utils/field-constants.js';
import { makeUniqueLabel } from '../utils/label-utils.js';

const DROP_MIME = 'application/x-highlight-page';

export class CategoryBuilder {
  constructor(state, containerEl) {
    this._state = state;
    this._container = containerEl;

    this._isOpen = false;
    this._droppedPages = []; // [{ pageId, label, originalName }]
    this._preview = null; // { overlapCount, uncoveredCount, pageCounts }
    this._previewKey = null;
    this._intersectionLabels = {}; // mask string -> label

    this._els = {};
  }

  init() {
    if (!this._container) return;
    this._render();
    this._bind();

    // Keep colors/names/counts synced with global highlight page state.
    this._state?.addHighlightPageChangeCallback?.(() => {
      this._renderDroppedItems();
      this._updatePreview();
    });
  }

  _render() {
    const wrapper = document.createElement('div');
    wrapper.className = 'analysis-accordion cat-builder-wrapper';

    wrapper.innerHTML = `
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
              <button type="button" class="cat-builder-btn primary" id="cat-builder-confirm" disabled>Create Categorical</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this._container.appendChild(wrapper);

    const item = wrapper.querySelector('#cat-builder-accordion-item');
    const toggle = wrapper.querySelector('.analysis-accordion-header');
    const panel = wrapper.querySelector('.analysis-accordion-content');
    this._els = {
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

  _bind() {
    const { toggle, panel, item, dropzone, uncoveredLabel, overlapLabel, confirmBtn, cancelBtn } = this._els;
    if (!toggle || !panel || !item || !dropzone) return;

    toggle.addEventListener('click', () => {
      this._isOpen = !this._isOpen;
      toggle.setAttribute('aria-expanded', this._isOpen ? 'true' : 'false');
      item.classList.toggle('open', this._isOpen);
    });

    bindDropZone(dropzone, {
      onDrop: (dt) => {
        const pageId = dt.getData(DROP_MIME) || dt.getData('text/plain');
        if (pageId) this._handlePageDrop(pageId);
      }
    });

    uncoveredLabel?.addEventListener('input', () => this._updatePreview());
    overlapLabel?.addEventListener('input', () => this._updatePreview());
    panel.querySelectorAll('input[name="overlap-strategy"]').forEach((radio) => {
      radio.addEventListener('change', () => this._updatePreview());
    });

    confirmBtn?.addEventListener('click', () => this._handleConfirm());
    cancelBtn?.addEventListener('click', () => this._handleCancel());
  }

  _handlePageDrop(pageId) {
    if (this._droppedPages.some((p) => p.pageId === pageId)) return;
    const page = this._state.highlightPages?.find?.((p) => p.id === pageId);
    if (!page) return;

    this._droppedPages.push({
      pageId,
      label: page.name,
      originalName: page.name
    });

    this._renderDroppedItems();
    this._updatePreview();
    this._updateConfirmState();
  }

  _renderDroppedItems() {
    const { items, placeholder } = this._els;
    if (!items || !placeholder) return;

    if (this._droppedPages.length === 0) {
      placeholder.hidden = false;
      items.innerHTML = '';
      return;
    }

    placeholder.hidden = true;
    items.innerHTML = '';

    this._droppedPages.forEach((p, idx) => {
      const page = this._state.highlightPages?.find?.((hp) => hp.id === p.pageId) || null;
      const pageColor = page?.color || this._state.getHighlightPageColor?.(p.pageId) || '#888888';
      const pageCount = this._state.getHighlightedCellCountForPage?.(p.pageId) ?? 0;

      const row = document.createElement('div');
      row.className = 'dropzone-item';
      row.draggable = true;
      row.dataset.idx = String(idx);

      const colorIndicator = document.createElement('span');
      colorIndicator.className = 'dropzone-item-color';
      StyleManager.setVariable(colorIndicator, '--dropzone-item-color', pageColor);
      colorIndicator.title = 'Click to change page color';

      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.className = 'dropzone-item-color-input';
      colorInput.value = pageColor;
      colorInput.title = 'Click to change page color';
      colorInput.addEventListener('input', (e) => {
        const newColor = e.target.value;
        StyleManager.setVariable(colorIndicator, '--dropzone-item-color', newColor);
        this._state.setHighlightPageColor?.(p.pageId, newColor);
      });
      colorInput.addEventListener('click', (e) => e.stopPropagation());
      colorIndicator.appendChild(colorInput);

      const handle = document.createElement('span');
      handle.className = 'dropzone-item-handle';
      handle.title = 'Drag to reorder';
      handle.textContent = '⋮⋮';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'dropzone-item-label';
      input.value = p.label;
      input.dataset.idx = String(idx);
      input.addEventListener('input', (e) => {
        const i = parseInt(e.target.dataset.idx, 10);
        if (Number.isNaN(i) || !this._droppedPages[i]) return;
        this._droppedPages[i].label = e.target.value;
        this._updatePreview();
      });

      const source = document.createElement('span');
      source.className = 'dropzone-item-source';
      source.textContent = `(${p.originalName})`;

      const count = document.createElement('span');
      count.className = 'dropzone-item-count';
      count.textContent = pageCount > 0 ? formatCellCount(pageCount) : '(0)';

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'dropzone-item-remove';
      remove.title = 'Remove';
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        this._droppedPages.splice(idx, 1);
        this._renderDroppedItems();
        this._updatePreview();
        this._updateConfirmState();
      });

      row.appendChild(colorIndicator);
      row.appendChild(handle);
      row.appendChild(input);
      row.appendChild(source);
      row.appendChild(count);
      row.appendChild(remove);
      items.appendChild(row);
    });

    this._setupReordering(items);
  }

  _setupReordering(container) {
    let draggedIdx = null;

    container.querySelectorAll('.dropzone-item').forEach((item) => {
      item.addEventListener('dragstart', (e) => {
        draggedIdx = parseInt(item.dataset.idx, 10);
        item.classList.add('dragging');
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });

      item.addEventListener('dragend', () => {
        draggedIdx = null;
        item.classList.remove('dragging');
        container.querySelectorAll('.dropzone-item').forEach((el) => el.classList.remove('drag-over'));
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      });

      item.addEventListener('dragenter', () => {
        const targetIdx = parseInt(item.dataset.idx, 10);
        if (draggedIdx != null && draggedIdx !== targetIdx) item.classList.add('drag-over');
      });

      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));

      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        const targetIdx = parseInt(item.dataset.idx, 10);
        if (draggedIdx == null || Number.isNaN(targetIdx) || draggedIdx === targetIdx) return;

        const [moved] = this._droppedPages.splice(draggedIdx, 1);
        this._droppedPages.splice(targetIdx, 0, moved);
        this._renderDroppedItems();
        this._updatePreview();
      });
    });
  }

  _getOverlapStrategy() {
    const radio = this._els.panel?.querySelector?.('input[name="overlap-strategy"]:checked');
    const value = radio?.value;
    if (value === OverlapStrategy.LAST) return OverlapStrategy.LAST;
    if (value === OverlapStrategy.OVERLAP_LABEL) return OverlapStrategy.OVERLAP_LABEL;
    if (value === OverlapStrategy.INTERSECTIONS) return OverlapStrategy.INTERSECTIONS;
    return OverlapStrategy.FIRST;
  }

  _computePreview(overlapStrategy) {
    const pointCount = this._state.pointCount || 0;
    const strategy = overlapStrategy || OverlapStrategy.FIRST;
    const pageCounts = new Array(this._droppedPages.length).fill(0);

    const buildCellSet = (pageId) => {
      const page = this._state.highlightPages?.find?.((p) => p.id === pageId);
      if (!page) return null;
      const cellSet = new Set();
      for (const group of (page.highlightedGroups || [])) {
        if (group.enabled === false) continue;
        for (const idx of (group.cellIndices || [])) {
          if (idx >= 0 && idx < pointCount) cellSet.add(idx);
        }
      }
      return cellSet;
    };

    const isPowerOfTwo = (v) => v && (v & (v - 1)) === 0;
    const bitCount32 = (v) => {
      let x = v >>> 0;
      let c = 0;
      while (x) { x &= (x - 1); c++; }
      return c;
    };

    // ────────────────────────────────────────────────────────────────────
    // Intersections: every overlap combination becomes a category
    // ────────────────────────────────────────────────────────────────────
    if (strategy === OverlapStrategy.INTERSECTIONS) {
      const membershipByCell = new Map(); // cellIdx -> bitmask
      this._droppedPages.forEach((pageInfo, pageIndex) => {
        const cellSet = buildCellSet(pageInfo.pageId);
        if (!cellSet) return;
        const bit = 1 << pageIndex;
        for (const idx of cellSet) {
          membershipByCell.set(idx, (membershipByCell.get(idx) || 0) | bit);
        }
      });

      let overlapCount = 0;
      const intersectionCounts = new Map(); // mask -> count

      for (const mask of membershipByCell.values()) {
        if (isPowerOfTwo(mask)) {
          pageCounts[Math.log2(mask)] += 1;
        } else {
          overlapCount += 1;
          intersectionCounts.set(mask, (intersectionCounts.get(mask) || 0) + 1);
        }
      }

      const intersectionRows = [...intersectionCounts.entries()]
        .map(([mask, count]) => ({ mask, count }))
        .sort((a, b) => bitCount32(a.mask) - bitCount32(b.mask) || a.mask - b.mask);

      const uncoveredCount = Math.max(0, pointCount - membershipByCell.size);
      return { overlapCount, uncoveredCount, pageCounts, intersectionRows };
    }

    // ────────────────────────────────────────────────────────────────────
    // Overlap bucket: all overlapping cells go to a new category
    // ────────────────────────────────────────────────────────────────────
    if (strategy === OverlapStrategy.OVERLAP_LABEL) {
      const assigned = new Map(); // cellIdx -> catIndex, or -1 for overlap
      let overlapCount = 0;

      this._droppedPages.forEach((pageInfo, catIndex) => {
        const cellSet = buildCellSet(pageInfo.pageId);
        if (!cellSet) return;

        for (const idx of cellSet) {
          const prev = assigned.get(idx);
          if (prev === undefined) {
            assigned.set(idx, catIndex);
            pageCounts[catIndex] += 1;
            continue;
          }
          if (prev === -1 || prev === catIndex) continue;
          assigned.set(idx, -1);
          pageCounts[prev] -= 1;
          overlapCount += 1;
        }
      });

      const uncoveredCount = Math.max(0, pointCount - assigned.size);
      return { overlapCount, uncoveredCount, pageCounts, overlapBucketCount: overlapCount, intersectionRows: [] };
    }

    // ────────────────────────────────────────────────────────────────────
    // First/last: overlaps assigned to first/last page in order
    // ────────────────────────────────────────────────────────────────────
    const assigned = new Map(); // cellIdx -> category index
    const overlapping = new Set();

    const addCell = (cellIdx, catIndex) => {
      const prev = assigned.get(cellIdx);
      if (prev === undefined) {
        assigned.set(cellIdx, catIndex);
        pageCounts[catIndex] += 1;
        return;
      }

      if (prev !== catIndex) overlapping.add(cellIdx);
      if (strategy === OverlapStrategy.LAST && prev !== catIndex) {
        pageCounts[prev] -= 1;
        assigned.set(cellIdx, catIndex);
        pageCounts[catIndex] += 1;
      }
    };

    this._droppedPages.forEach((pageInfo, catIndex) => {
      const cellSet = buildCellSet(pageInfo.pageId);
      if (!cellSet) return;
      for (const idx of cellSet) addCell(idx, catIndex);
    });

    const uncoveredCount = Math.max(0, pointCount - assigned.size);
    return { overlapCount: overlapping.size, uncoveredCount, pageCounts, intersectionRows: [] };
  }

  _updatePreview() {
    const {
      preview,
      conflictSection,
      conflictText,
      overlapLabelSection,
      overlapLabel,
      intersectionSection,
      uncoveredSection,
      uncoveredCount,
      uncoveredLabel
    } = this._els;
    if (!preview || !conflictSection || !uncoveredSection) return;

    if (this._droppedPages.length === 0) {
      preview.innerHTML = '';
      conflictSection.hidden = true;
      uncoveredSection.hidden = true;
      this._preview = null;
      this._previewKey = null;
      return;
    }

    let strategy = this._getOverlapStrategy();
    if (strategy === OverlapStrategy.INTERSECTIONS && this._droppedPages.length > Limits.MAX_INTERSECTION_PAGES) {
      // Hard safety guard: intersections can explode combinatorially.
      getNotificationCenter().warning(
        `Intersections supports up to ${Limits.MAX_INTERSECTION_PAGES} pages`,
        { category: 'highlight', duration: 3500 }
      );
      strategy = OverlapStrategy.FIRST;
      const firstRadio = this._els.panel?.querySelector?.('input[name="overlap-strategy"][value="first"]');
      if (firstRadio) firstRadio.checked = true;
    }

    const nextKey = `${strategy}:${this._droppedPages.map((p) => p.pageId).join('|')}`;
    const shouldRecompute = nextKey !== this._previewKey;
    if (shouldRecompute) {
      this._preview = this._computePreview(strategy);
      this._previewKey = nextKey;
    }

    conflictSection.hidden = this._preview.overlapCount === 0;
    if (!conflictSection.hidden && conflictText) {
      conflictText.textContent = `${this._preview.overlapCount.toLocaleString()} cells appear in multiple pages`;
    }

    uncoveredSection.hidden = this._preview.uncoveredCount === 0;
    if (!uncoveredSection.hidden && uncoveredCount) {
      uncoveredCount.textContent = this._preview.uncoveredCount.toLocaleString();
    }

    if (overlapLabelSection) {
      overlapLabelSection.hidden = conflictSection.hidden || strategy !== OverlapStrategy.OVERLAP_LABEL;
    }
    if (intersectionSection) {
      intersectionSection.hidden = conflictSection.hidden || strategy !== OverlapStrategy.INTERSECTIONS;
    }
    if (strategy === OverlapStrategy.INTERSECTIONS && !conflictSection.hidden && shouldRecompute) {
      this._renderIntersectionLabelInputs(this._preview.intersectionRows || []);
    }

    preview.innerHTML = '';

    const categoriesWrap = document.createElement('div');
    categoriesWrap.className = 'preview-categories';

    const usedLabels = [];

    const addPreviewRow = ({ labelText, countValue, colorIndex = null, uncovered = false }) => {
      const item = document.createElement('div');
      item.className = uncovered ? 'preview-category uncovered' : 'preview-category';

      const swatch = document.createElement('span');
      swatch.className = 'preview-swatch';
      if (uncovered) {
        StyleManager.setVariable(swatch, '--preview-swatch-color', 'var(--color-text-secondary)');
      } else {
        const cssColor = rgbToCss(getCategoryColor(colorIndex));
        StyleManager.setVariable(swatch, '--preview-swatch-color', cssColor);
      }

      const label = document.createElement('span');
      label.className = 'preview-label';
      label.textContent = labelText;

      const count = document.createElement('span');
      count.className = 'preview-count';
      count.textContent = (countValue || 0).toLocaleString();

      item.appendChild(swatch);
      item.appendChild(label);
      item.appendChild(count);
      categoriesWrap.appendChild(item);
    };

    const pageLabels = this._droppedPages.map((p) => String(p.label || p.originalName || 'Category'));
    this._droppedPages.forEach((p, i) => {
      const labelText = pageLabels[i];
      usedLabels.push(labelText);
      addPreviewRow({ labelText, countValue: this._preview.pageCounts[i] || 0, colorIndex: i });
    });

    if (strategy === OverlapStrategy.OVERLAP_LABEL) {
      const base = String(overlapLabel?.value || 'Overlap').trim() || 'Overlap';
      const labelText = makeUniqueLabel(base, usedLabels);
      usedLabels.push(labelText);
      addPreviewRow({
        labelText,
        countValue: this._preview.overlapCount || 0,
        colorIndex: this._droppedPages.length
      });
    }

    if (strategy === OverlapStrategy.INTERSECTIONS) {
      const rows = this._preview.intersectionRows || [];
      rows.forEach((row, idx) => {
        const maskKey = String(row.mask);
        const labelText = makeUniqueLabel(
          String(this._intersectionLabels[maskKey] || this._formatIntersectionLabel(row.mask, pageLabels) || 'Overlap'),
          usedLabels
        );
        usedLabels.push(labelText);
        addPreviewRow({
          labelText,
          countValue: row.count,
          colorIndex: this._droppedPages.length + idx
        });
      });
    }

    const uncoveredText = String(uncoveredLabel?.value || '').trim();
    if (this._preview.uncoveredCount > 0 && uncoveredText) {
      const labelText = makeUniqueLabel(uncoveredText, usedLabels);
      usedLabels.push(labelText);
      addPreviewRow({ labelText, countValue: this._preview.uncoveredCount, uncovered: true });
    }

    const stats = document.createElement('div');
    stats.className = 'preview-stats';
    stats.textContent = `Total: ${this._state.pointCount.toLocaleString()} cells | ${categoriesWrap.childElementCount} categories`;

    preview.appendChild(categoriesWrap);
    preview.appendChild(stats);
  }

  _formatIntersectionLabel(mask, pageLabels) {
    const parts = [];
    const labels = pageLabels || this._droppedPages.map((p) => String(p.label || p.originalName || 'Category'));
    for (let i = 0; i < labels.length; i++) {
      if (mask & (1 << i)) parts.push(String(labels[i] ?? `Page ${i + 1}`));
    }
    return parts.join(' & ');
  }

  _renderIntersectionLabelInputs(rows) {
    const list = this._els.intersectionList;
    if (!list) return;

    const active = new Set(rows.map((r) => String(r.mask)));
    for (const key of Object.keys(this._intersectionLabels)) {
      if (!active.has(key)) delete this._intersectionLabels[key];
    }

    list.innerHTML = '';
    const pageLabels = this._droppedPages.map((p) => String(p.label || p.originalName || 'Category'));

    rows.forEach((row) => {
      const maskKey = String(row.mask);
      if (this._intersectionLabels[maskKey] == null) {
        this._intersectionLabels[maskKey] = this._formatIntersectionLabel(row.mask, pageLabels) || 'Overlap';
      }

      const rowEl = document.createElement('div');
      rowEl.className = 'cat-builder-intersection-row';

      const meta = document.createElement('div');
      meta.className = 'cat-builder-intersection-meta';
      meta.textContent = `${row.count.toLocaleString()} cells`;

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'cat-builder-intersection-input';
      input.value = this._intersectionLabels[maskKey];
      input.dataset.mask = maskKey;
      input.addEventListener('input', () => {
        this._intersectionLabels[maskKey] = input.value;
        this._updatePreview();
      });

      rowEl.appendChild(meta);
      rowEl.appendChild(input);
      list.appendChild(rowEl);
    });
  }

  _updateConfirmState() {
    if (this._els.confirmBtn) {
      this._els.confirmBtn.disabled = this._droppedPages.length === 0;
    }
  }

  _handleConfirm() {
    const fieldName = String(this._els.fieldName?.value || '').trim() || 'Custom Categories';
    const uncoveredLabel = String(this._els.uncoveredLabel?.value || '').trim();
    const overlapStrategy = this._getOverlapStrategy();
    const overlapLabel = String(this._els.overlapLabel?.value || '').trim();
    const intersectionLabels = overlapStrategy === OverlapStrategy.INTERSECTIONS
      ? { ...this._intersectionLabels }
      : undefined;

    const notifyId = getNotificationCenter().loading('Creating categorical...', { category: 'data' });

    try {
      if (overlapStrategy === OverlapStrategy.INTERSECTIONS && this._droppedPages.length > Limits.MAX_INTERSECTION_PAGES) {
        throw new Error(`Intersections supports up to ${Limits.MAX_INTERSECTION_PAGES} pages`);
      }

      const result = this._state.createCategoricalFromPages({
        key: fieldName,
        pages: this._droppedPages.map((p) => ({ pageId: p.pageId, label: String(p.label || '').trim() })),
        uncoveredLabel,
        overlapStrategy,
        overlapLabel,
        intersectionLabels
      });

      if (result?.field) {
        getNotificationCenter().complete(
          notifyId,
          `Created "${fieldName}" (${result.field.categories.length} categories)`
        );
        this._handleCancel();
      } else {
        getNotificationCenter().fail(notifyId, 'Failed to create categorical');
      }
    } catch (err) {
      getNotificationCenter().fail(notifyId, err?.message || 'Failed to create categorical');
    }
  }

  _handleCancel() {
    this._droppedPages = [];
    this._preview = null;
    this._previewKey = null;
    this._intersectionLabels = {};

    if (this._els.fieldName) this._els.fieldName.value = '';
    if (this._els.uncoveredLabel) this._els.uncoveredLabel.value = 'Unassigned';
    if (this._els.overlapLabel) this._els.overlapLabel.value = 'Overlap';
    if (this._els.intersectionList) this._els.intersectionList.innerHTML = '';
    const first = this._els.panel?.querySelector?.('input[name="overlap-strategy"][value="first"]');
    if (first) first.checked = true;

    this._renderDroppedItems();
    this._updatePreview();
    this._updateConfirmState();

    // Collapse panel
    this._isOpen = false;
    this._els.toggle?.setAttribute('aria-expanded', 'false');
    this._els.item?.classList.remove('open');
  }
}
