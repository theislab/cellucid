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
import {
  requireDomElement,
  requireExactKeys,
  requireMethods,
  requireSafeInteger
} from './exact-contract.js';

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} [options.dom]
 * @param {HTMLElement|null} [options.dom.pagesTabsEl]
 * @param {HTMLButtonElement|null} [options.dom.addPageBtn]
 */
export function initHighlightPagesUI(options) {
  requireExactKeys(
    options,
    ['state', 'dom'],
    'Highlight pages UI options'
  );
  const { state, dom } = options;
  requireMethods(
    state,
    'Highlight pages state',
    [
      'combineHighlightPages',
      'createHighlightPage',
      'deleteHighlightPage',
      'ensureHighlightPage',
      'getActivePageId',
      'getHighlightedCellCountForPage',
      'getHighlightPages',
      'renameHighlightPage',
      'setHighlightPageColor',
      'switchToPage'
    ]
  );
  requireExactKeys(
    dom,
    ['pagesTabsEl', 'addPageBtn'],
    'Highlight pages DOM'
  );
  const highlightPagesTabsEl = requireDomElement(
    dom.pagesTabsEl,
    'Highlight pages tabs',
    ['appendChild', 'querySelectorAll']
  );
  const addHighlightPageBtn = requireDomElement(
    dom.addPageBtn,
    'Add highlight page button',
    ['addEventListener']
  );
  const documentOwner = globalThis.document;
  requireMethods(
    documentOwner,
    'Highlight pages document',
    [
      'addEventListener',
      'createElement',
      'getElementById',
      'removeEventListener'
    ]
  );
  requireDomElement(
    documentOwner.body,
    'Highlight document body',
    ['appendChild']
  );

  let draggedPageId = null;
  let lastPageIds = [];

  function requirePage(page, label) {
    requireExactKeys(
      page,
      ['id', 'name', 'color', 'highlightedGroups'],
      label
    );
    if (
      typeof page.id !== 'string'
      || page.id.length === 0
      || page.id !== page.id.trim()
    ) {
      throw new TypeError(`${label} id must be a nonempty trimmed string.`);
    }
    if (
      typeof page.name !== 'string'
      || page.name.length === 0
      || page.name !== page.name.trim()
    ) {
      throw new TypeError(`${label} name must be a nonempty trimmed string.`);
    }
    if (
      typeof page.color !== 'string'
      || !/^#[0-9a-fA-F]{6}$/.test(page.color)
    ) {
      throw new TypeError(`${label} color must be an exact hex RGB value.`);
    }
    if (!Array.isArray(page.highlightedGroups)) {
      throw new TypeError(`${label} highlightedGroups must be an array.`);
    }
    return page;
  }

  function requirePageOperation(result, label) {
    if (result !== true) {
      throw new Error(`${label} was rejected by highlight state.`);
    }
  }

  function showPageCombineMenu(targetPageId, x, y) {
    const existingMenu = documentOwner.getElementById('page-combine-menu');
    if (existingMenu) existingMenu.remove();

    const sourcePageId = draggedPageId;
    if (sourcePageId === null || sourcePageId === targetPageId) return;
    const currentPages = state.getHighlightPages();
    if (
      !currentPages.some(page => page.id === sourcePageId)
      || !currentPages.some(page => page.id === targetPageId)
    ) {
      throw new Error(
        'Highlight page combination requires two current page ids.'
      );
    }

    const menu = documentOwner.createElement('div');
    menu.id = 'page-combine-menu';
    menu.className = 'page-combine-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const intersectionBtn = documentOwner.createElement('button');
    intersectionBtn.className = 'page-combine-option';
    intersectionBtn.innerHTML = '<span class="page-combine-icon">&#8745;</span> Intersection';
    intersectionBtn.title = 'Create page with cells in BOTH pages';
    intersectionBtn.addEventListener('click', () => {
      const newPage = requirePage(
        state.combineHighlightPages(
          sourcePageId,
          targetPageId,
          'intersection'
        ),
        'Combined highlight page'
      );
      requirePageOperation(
        state.switchToPage(newPage.id),
        'Switch to combined highlight page'
      );
      closeCombineMenu();
    });

    const unionBtn = documentOwner.createElement('button');
    unionBtn.className = 'page-combine-option';
    unionBtn.innerHTML = '<span class="page-combine-icon">&#8746;</span> Union';
    unionBtn.title = 'Create page with cells in EITHER page';
    unionBtn.addEventListener('click', () => {
      const newPage = requirePage(
        state.combineHighlightPages(sourcePageId, targetPageId, 'union'),
        'Combined highlight page'
      );
      requirePageOperation(
        state.switchToPage(newPage.id),
        'Switch to combined highlight page'
      );
      closeCombineMenu();
    });

    menu.appendChild(intersectionBtn);
    menu.appendChild(unionBtn);
    documentOwner.body.appendChild(menu);

    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        closeCombineMenu();
      }
    };
    function closeCombineMenu() {
      menu.remove();
      documentOwner.removeEventListener('mousedown', closeMenu);
    }
    documentOwner.addEventListener('mousedown', closeMenu);
  }

  function startPageRename(tabEl, page) {
    const nameSpan = tabEl.querySelector('.highlight-page-tab-name');
    if (nameSpan === null) {
      throw new Error('Highlight page tab is missing its name element.');
    }

    const input = documentOwner.createElement('input');
    input.type = 'text';
    input.className = 'highlight-page-tab-input';
    input.value = page.name;

    const finishRename = () => {
      const newName = input.value.trim();
      if (newName.length === 0) {
        input.setCustomValidity('Page name must not be empty.');
        input.reportValidity();
        input.focus();
        return;
      }
      input.setCustomValidity('');
      requirePageOperation(
        state.renameHighlightPage(page.id, newName),
        'Highlight page rename'
      );
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
    const pages = state.getHighlightPages();
    if (!Array.isArray(pages) || pages.length === 0) {
      throw new TypeError(
        'Highlight pages state must contain at least one page.'
      );
    }
    const activePageId = state.getActivePageId();
    if (
      typeof activePageId !== 'string'
      || !pages.some(page => page.id === activePageId)
    ) {
      throw new TypeError(
        'Active highlight page id must identify a current page.'
      );
    }
    const seenPageIds = new Set();
    const pageCounts = new Map();
    for (const page of pages) {
      requirePage(page, 'Highlight page');
      if (seenPageIds.has(page.id)) {
        throw new TypeError(`Duplicate highlight page id: ${page.id}.`);
      }
      seenPageIds.add(page.id);
      const count = state.getHighlightedCellCountForPage(page.id);
      requireSafeInteger(
        count,
        `Highlight page "${page.id}" cell count`,
        0
      );
      pageCounts.set(page.id, count);
    }
    const currentPageIds = pages.map((p) => p.id);

    const needsFullRebuild =
      lastPageIds.length !== currentPageIds.length ||
      !lastPageIds.every((id, i) => id === currentPageIds[i]);

    if (!needsFullRebuild) {
      const existingTabs = highlightPagesTabsEl.querySelectorAll('.highlight-page-tab');
      existingTabs.forEach((tab) => {
        const pageId = tab.dataset.pageId;
        const page = pages.find((p) => p.id === pageId);
        if (page === undefined) {
          throw new Error(
            `Rendered highlight page "${pageId}" is not in current state.`
          );
        }

        const isActive = pageId === activePageId;
        tab.classList.toggle('active', isActive);

        const nameSpan = tab.querySelector('.highlight-page-tab-name');
        if (nameSpan === null) {
          throw new Error(
            `Highlight page "${pageId}" is missing its name element.`
          );
        }
        if (nameSpan.textContent !== page.name) {
          nameSpan.textContent = page.name;
          nameSpan.title = page.name;
        }

        const countSpan = tab.querySelector('.highlight-page-tab-count');
        if (countSpan === null) {
          throw new Error(
            `Highlight page "${pageId}" is missing its count element.`
          );
        }
        const count = pageCounts.get(pageId);
        const next = count > 0 ? formatDataNumber(count) : '(0)';
        if (countSpan.textContent !== next) countSpan.textContent = next;

        const colorEl = tab.querySelector('.highlight-page-color');
        const colorInput = tab.querySelector('.highlight-page-color-input');
        if (colorEl === null || colorInput === null) {
          throw new Error(
            `Highlight page "${pageId}" is missing its color controls.`
          );
        }
        StyleManager.setVariable(
          colorEl,
          '--highlight-page-color',
          page.color
        );
        if (colorInput.value !== page.color) colorInput.value = page.color;
      });
      return;
    }

    lastPageIds = currentPageIds.slice();
    highlightPagesTabsEl.innerHTML = '';

    pages.forEach((page) => {
      const isActive = page.id === activePageId;

      const tab = documentOwner.createElement('div');
      tab.className = 'highlight-page-tab' + (isActive ? ' active' : '');
      tab.dataset.pageId = page.id;

      tab.draggable = true;

      tab.addEventListener('dragstart', (e) => {
        draggedPageId = page.id;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-highlight-page', page.id);
      });

      tab.addEventListener('dragend', () => {
        tab.classList.remove('dragging');
        highlightPagesTabsEl.querySelectorAll('.highlight-page-tab').forEach((t) => {
          t.classList.remove('drag-over');
        });
        draggedPageId = null;
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

      const colorIndicator = documentOwner.createElement('span');
      colorIndicator.className = 'highlight-page-color';
      StyleManager.setVariable(
        colorIndicator,
        '--highlight-page-color',
        page.color
      );
      colorIndicator.title = 'Click to change color';

      const colorInput = documentOwner.createElement('input');
      colorInput.type = 'color';
      colorInput.className = 'highlight-page-color-input';
      colorInput.value = page.color;
      colorInput.title = 'Click to change color';

      colorInput.addEventListener('input', () => {
        const newColor = colorInput.value;
        requirePageOperation(
          state.setHighlightPageColor(page.id, newColor),
          'Highlight page color update'
        );
        StyleManager.setVariable(
          colorIndicator,
          '--highlight-page-color',
          newColor
        );
      });
      colorInput.addEventListener('click', (e) => {
        e.stopPropagation();
      });

      colorIndicator.appendChild(colorInput);
      tab.appendChild(colorIndicator);

      const nameSpan = documentOwner.createElement('span');
      nameSpan.className = 'highlight-page-tab-name';
      nameSpan.textContent = page.name;
      nameSpan.title = page.name;

      nameSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startPageRename(tab, page);
      });

      tab.appendChild(nameSpan);

      const countSpan = documentOwner.createElement('span');
      countSpan.className = 'highlight-page-tab-count';
      const count = pageCounts.get(page.id);
      countSpan.textContent = count > 0 ? formatDataNumber(count) : '(0)';
      tab.appendChild(countSpan);

      if (pages.length > 1) {
        const deleteBtn = documentOwner.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'highlight-page-tab-delete';
        deleteBtn.innerHTML = '×';
        deleteBtn.title = 'Delete this page';
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          requirePageOperation(
            state.deleteHighlightPage(page.id),
            'Highlight page deletion'
          );
        });
        tab.appendChild(deleteBtn);
      }

      tab.addEventListener('click', () => {
        requirePageOperation(
          state.switchToPage(page.id),
          'Highlight page switch'
        );
      });

      highlightPagesTabsEl.appendChild(tab);
    });
  }

  state.ensureHighlightPage();
  renderHighlightPages();

  addHighlightPageBtn.addEventListener('click', () => {
    const newPage = requirePage(
      state.createHighlightPage(),
      'Created highlight page'
    );
    requirePageOperation(
      state.switchToPage(newPage.id),
      'Switch to created highlight page'
    );
  });

  return { renderHighlightPages };
}
