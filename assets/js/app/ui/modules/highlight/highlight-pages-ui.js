/**
 * @fileoverview Highlight page tabs UI.
 *
 * Manages the highlight page tab strip (switch, rename, delete, recolor) and
 * the drag-to-combine affordance (union / intersection).
 *
 * @module ui/modules/highlight/highlight-pages-ui
 */

import { formatCellCount as formatDataNumber } from '../../../../data/data-source.js';
import { StyleManager } from '../../../../utils/style-manager.js';

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} [options.dom]
 * @param {HTMLElement|null} [options.dom.pagesTabsEl]
 * @param {HTMLButtonElement|null} [options.dom.addPageBtn]
 */
export function initHighlightPagesUI({ state, dom }) {
  const highlightPagesTabsEl = dom?.pagesTabsEl || null;
  const addHighlightPageBtn = dom?.addPageBtn || null;

  let draggedPageId = null;
  let lastPageIds = [];

  function showPageCombineMenu(targetPageId, x, y) {
    const existingMenu = document.getElementById('page-combine-menu');
    if (existingMenu) existingMenu.remove();

    const sourcePageId = draggedPageId;
    if (!sourcePageId || sourcePageId === targetPageId) return;

    const menu = document.createElement('div');
    menu.id = 'page-combine-menu';
    menu.className = 'page-combine-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const intersectionBtn = document.createElement('button');
    intersectionBtn.className = 'page-combine-option';
    intersectionBtn.innerHTML = '<span class="page-combine-icon">&#8745;</span> Intersection';
    intersectionBtn.title = 'Create page with cells in BOTH pages';
    intersectionBtn.addEventListener('click', () => {
      const newPage = state.combineHighlightPages(sourcePageId, targetPageId, 'intersection');
      if (newPage) {
        state.switchToPage(newPage.id);
      }
      menu.remove();
    });

    const unionBtn = document.createElement('button');
    unionBtn.className = 'page-combine-option';
    unionBtn.innerHTML = '<span class="page-combine-icon">&#8746;</span> Union';
    unionBtn.title = 'Create page with cells in EITHER page';
    unionBtn.addEventListener('click', () => {
      const newPage = state.combineHighlightPages(sourcePageId, targetPageId, 'union');
      if (newPage) {
        state.switchToPage(newPage.id);
      }
      menu.remove();
    });

    menu.appendChild(intersectionBtn);
    menu.appendChild(unionBtn);
    document.body.appendChild(menu);

    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('mousedown', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', closeMenu), 0);
  }

  function startPageRename(tabEl, page) {
    const nameSpan = tabEl.querySelector('.highlight-page-tab-name');
    if (!nameSpan) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'highlight-page-tab-input';
    input.value = page.name;

    const finishRename = () => {
      const newName = input.value.trim() || page.name;
      state.renameHighlightPage(page.id, newName);
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = page.name;
        input.blur();
      }
    });

    nameSpan.textContent = '';
    nameSpan.appendChild(input);
    input.focus();
    input.select();
  }

  function renderHighlightPages() {
    if (!highlightPagesTabsEl) return;

    const pages = state.getHighlightPages();
    const activePageId = state.getActivePageId();
    const currentPageIds = pages.map((p) => p.id);

    const needsFullRebuild =
      lastPageIds.length !== currentPageIds.length ||
      !lastPageIds.every((id, i) => id === currentPageIds[i]);

    if (!needsFullRebuild) {
      const existingTabs = highlightPagesTabsEl.querySelectorAll('.highlight-page-tab');
      existingTabs.forEach((tab) => {
        const pageId = tab.dataset.pageId;
        const page = pages.find((p) => p.id === pageId);
        if (!page) return;

        const isActive = pageId === activePageId;
        tab.classList.toggle('active', isActive);

        const nameSpan = tab.querySelector('.highlight-page-tab-name');
        if (nameSpan && nameSpan.textContent !== page.name) {
          nameSpan.textContent = page.name;
          nameSpan.title = page.name;
        }

        const countSpan = tab.querySelector('.highlight-page-tab-count');
        if (countSpan && typeof state.getHighlightedCellCountForPage === 'function') {
          const count = state.getHighlightedCellCountForPage(pageId);
          const next = count > 0 ? formatDataNumber(count) : '(0)';
          if (countSpan.textContent !== next) countSpan.textContent = next;
        }

        const colorEl = tab.querySelector('.highlight-page-color');
        const colorInput = tab.querySelector('.highlight-page-color-input');
        const color =
          page.color || (typeof state.getHighlightPageColor === 'function' ? state.getHighlightPageColor(pageId) : null);
        if (colorEl && color) StyleManager.setVariable(colorEl, '--highlight-page-color', color);
        if (colorInput && color && colorInput.value !== color) colorInput.value = color;
      });
      return;
    }

    lastPageIds = currentPageIds.slice();
    highlightPagesTabsEl.innerHTML = '';

    pages.forEach((page) => {
      const isActive = page.id === activePageId;

      const tab = document.createElement('div');
      tab.className = 'highlight-page-tab' + (isActive ? ' active' : '');
      tab.dataset.pageId = page.id;

      tab.draggable = true;

      tab.addEventListener('dragstart', (e) => {
        draggedPageId = page.id;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-highlight-page', page.id);
        e.dataTransfer.setData('text/plain', page.id);
      });

      tab.addEventListener('dragend', () => {
        tab.classList.remove('dragging');
        highlightPagesTabsEl.querySelectorAll('.highlight-page-tab').forEach((t) => {
          t.classList.remove('drag-over');
        });
      });

      tab.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });

      tab.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (draggedPageId && draggedPageId !== page.id) {
          tab.classList.add('drag-over');
        }
      });

      tab.addEventListener('dragleave', () => {
        tab.classList.remove('drag-over');
      });

      tab.addEventListener('drop', (e) => {
        e.preventDefault();
        tab.classList.remove('drag-over');
        if (draggedPageId && draggedPageId !== page.id) {
          showPageCombineMenu(page.id, e.clientX, e.clientY);
        }
      });

      const pageColor =
        page.color || (typeof state.getHighlightPageColor === 'function' ? state.getHighlightPageColor(page.id) : null);
      if (pageColor) {
        const colorIndicator = document.createElement('span');
        colorIndicator.className = 'highlight-page-color';
        StyleManager.setVariable(colorIndicator, '--highlight-page-color', pageColor);
        colorIndicator.title = 'Click to change color';

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'highlight-page-color-input';
        colorInput.value = pageColor;
        colorInput.title = 'Click to change color';

        colorInput.addEventListener('input', (e) => {
          const newColor = e.target.value;
          StyleManager.setVariable(colorIndicator, '--highlight-page-color', newColor);
          state.setHighlightPageColor?.(page.id, newColor);
        });
        colorInput.addEventListener('click', (e) => {
          e.stopPropagation();
        });

        colorIndicator.appendChild(colorInput);
        tab.appendChild(colorIndicator);
      }

      const nameSpan = document.createElement('span');
      nameSpan.className = 'highlight-page-tab-name';
      nameSpan.textContent = page.name;
      nameSpan.title = page.name;

      nameSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startPageRename(tab, page);
      });

      tab.appendChild(nameSpan);

      const countSpan = document.createElement('span');
      countSpan.className = 'highlight-page-tab-count';
      const count = typeof state.getHighlightedCellCountForPage === 'function' ? state.getHighlightedCellCountForPage(page.id) : 0;
      countSpan.textContent = count > 0 ? formatDataNumber(count) : '(0)';
      tab.appendChild(countSpan);

      if (pages.length > 1) {
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'highlight-page-tab-delete';
        deleteBtn.innerHTML = '×';
        deleteBtn.title = 'Delete this page';
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          state.deleteHighlightPage(page.id);
        });
        tab.appendChild(deleteBtn);
      }

      tab.addEventListener('click', () => {
        state.switchToPage(page.id);
      });

      highlightPagesTabsEl.appendChild(tab);
    });
  }

  if (state.ensureHighlightPage) {
    state.ensureHighlightPage();
    renderHighlightPages();
  }

  if (addHighlightPageBtn) {
    addHighlightPageBtn.addEventListener('click', () => {
      state.createHighlightPage();
      const pages = state.getHighlightPages();
      if (pages.length > 0) {
        const newPage = pages[pages.length - 1];
        state.switchToPage(newPage.id);
      }
    });
  }

  return { renderHighlightPages };
}

