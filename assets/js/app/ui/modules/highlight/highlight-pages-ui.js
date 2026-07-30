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
    ['appendChild', 'querySelectorAll', 'setAttribute']
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
  let closeActiveCombineMenu = null;

  highlightPagesTabsEl.setAttribute('aria-label', 'Highlight pages');
  highlightPagesTabsEl.setAttribute('aria-orientation', 'horizontal');
  highlightPagesTabsEl.setAttribute('role', 'tablist');

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

  function focusPageTab(pageId) {
    const tabs = highlightPagesTabsEl.querySelectorAll('.highlight-page-tab');
    for (const tab of tabs) {
      if (tab.dataset.pageId !== pageId) continue;
      const activation = tab.querySelector('.highlight-page-tab-activate');
      if (activation === null) {
        throw new Error(
          `Highlight page "${pageId}" is missing its tab control.`
        );
      }
      activation.focus();
      return true;
    }
    return false;
  }

  function showPageCombineMenu({
    returnFocus = null,
    sourcePageId,
    targetPageId = null,
    x,
    y
  }) {
    if (closeActiveCombineMenu !== null) {
      closeActiveCombineMenu({ restoreFocus: false });
    }
    const existingMenu = documentOwner.getElementById('page-combine-menu');
    if (existingMenu) existingMenu.remove();

    if (sourcePageId === targetPageId) return;
    const currentPages = state.getHighlightPages();
    const sourcePage = currentPages.find(page => page.id === sourcePageId);
    const targetPages = targetPageId === null
      ? currentPages.filter(page => page.id !== sourcePageId)
      : currentPages.filter(page => page.id === targetPageId);
    if (sourcePage === undefined || targetPages.length === 0) {
      throw new Error(
        'Highlight page combination requires two current page ids.'
      );
    }

    const menu = documentOwner.createElement('div');
    menu.id = 'page-combine-menu';
    menu.className = 'page-combine-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.setAttribute('aria-label', `Combine ${sourcePage.name}`);
    menu.setAttribute('role', 'menu');

    function combineWithPage(targetPage, operation) {
      const newPage = requirePage(
        state.combineHighlightPages(
          sourcePageId,
          targetPage.id,
          operation
        ),
        'Combined highlight page'
      );
      requirePageOperation(
        state.switchToPage(newPage.id),
        'Switch to combined highlight page'
      );
      closeCombineMenu({ restoreFocus: false });
      focusPageTab(newPage.id);
    }

    for (const targetPage of targetPages) {
      for (const operation of ['intersection', 'union']) {
        const operationButton = documentOwner.createElement('button');
        const isIntersection = operation === 'intersection';
        operationButton.type = 'button';
        operationButton.className = 'page-combine-option';
        operationButton.setAttribute('role', 'menuitem');
        operationButton.textContent =
          `${isIntersection ? '∩' : '∪'} ` +
          `${isIntersection ? 'Intersection' : 'Union'} with ` +
          targetPage.name;
        operationButton.title = isIntersection
          ? `Create a page with cells in both ${sourcePage.name} and ${targetPage.name}`
          : `Create a page with cells in either ${sourcePage.name} or ${targetPage.name}`;
        operationButton.addEventListener('click', () => {
          combineWithPage(targetPage, operation);
        });
        menu.appendChild(operationButton);
      }
    }
    documentOwner.body.appendChild(menu);
    if (returnFocus !== null) {
      returnFocus.setAttribute('aria-expanded', 'true');
    }

    const viewportPadding = 8;
    const viewportWidth = documentOwner.documentElement.clientWidth;
    const viewportHeight = documentOwner.documentElement.clientHeight;
    const menuRect = menu.getBoundingClientRect();
    let menuLeft = x;
    let menuTop = y;
    if (menuRect.right > viewportWidth - viewportPadding) {
      menuLeft = viewportWidth - menuRect.width - viewportPadding;
    }
    if (menuRect.bottom > viewportHeight - viewportPadding) {
      if (returnFocus !== null) {
        const returnFocusRect = returnFocus.getBoundingClientRect();
        menuTop = returnFocusRect.top - menuRect.height - 4;
      } else {
        menuTop = viewportHeight - menuRect.height - viewportPadding;
      }
    }
    menu.style.left = `${Math.max(viewportPadding, menuLeft)}px`;
    menu.style.top = `${Math.max(viewportPadding, menuTop)}px`;
    menu.style.maxHeight =
      `${Math.max(0, viewportHeight - viewportPadding * 2)}px`;

    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        closeCombineMenu({ restoreFocus: false });
      }
    };
    const handleMenuKeydown = (e) => {
      if (!menu.contains(documentOwner.activeElement)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeCombineMenu({ restoreFocus: true });
        return;
      }
      const options = [
        ...menu.querySelectorAll('.page-combine-option')
      ];
      const activeIndex = options.indexOf(documentOwner.activeElement);
      let targetIndex = null;
      if (e.key === 'ArrowDown') {
        targetIndex = (activeIndex + 1) % options.length;
      } else if (e.key === 'ArrowUp') {
        targetIndex =
          (activeIndex - 1 + options.length) % options.length;
      } else if (e.key === 'Home') {
        targetIndex = 0;
      } else if (e.key === 'End') {
        targetIndex = options.length - 1;
      }
      if (targetIndex === null) return;
      e.preventDefault();
      e.stopPropagation();
      options[targetIndex].focus();
    };
    const handleMenuFocusOut = (e) => {
      if (
        e.relatedTarget !== null &&
        !menu.contains(e.relatedTarget)
      ) {
        closeCombineMenu({ restoreFocus: false });
      }
    };
    function closeCombineMenu({ restoreFocus = true } = {}) {
      if (closeActiveCombineMenu !== closeCombineMenu) return;
      closeActiveCombineMenu = null;
      menu.remove();
      if (returnFocus !== null) {
        returnFocus.setAttribute('aria-expanded', 'false');
      }
      menu.removeEventListener('focusout', handleMenuFocusOut);
      documentOwner.removeEventListener('mousedown', closeMenu);
      documentOwner.removeEventListener('keydown', handleMenuKeydown);
      if (
        restoreFocus &&
        returnFocus !== null &&
        returnFocus.isConnected &&
        typeof returnFocus.focus === 'function'
      ) {
        returnFocus.focus();
      }
    }
    closeActiveCombineMenu = closeCombineMenu;
    menu.addEventListener('focusout', handleMenuFocusOut);
    documentOwner.addEventListener('mousedown', closeMenu);
    documentOwner.addEventListener('keydown', handleMenuKeydown);
    if (returnFocus !== null) {
      const firstOption = menu.querySelector('.page-combine-option');
      if (firstOption === null) {
        throw new Error('Highlight page combine menu has no operation.');
      }
      firstOption.focus();
    }
  }

  function startPageRename(tabEl, page) {
    const nameSpan = tabEl.querySelector('.highlight-page-tab-name');
    const activation = tabEl.querySelector('.highlight-page-tab-activate');
    if (nameSpan === null) {
      throw new Error('Highlight page tab is missing its name element.');
    }
    if (activation === null) {
      throw new Error('Highlight page tab is missing its tab control.');
    }
    if (tabEl.querySelector('.highlight-page-tab-input') !== null) return;

    const input = documentOwner.createElement('input');
    input.type = 'text';
    input.className = 'highlight-page-tab-input';
    input.value = page.name;
    input.setAttribute('aria-label', `Rename ${page.name}`);
    activation.hidden = true;
    tabEl.insertBefore(input, activation.nextSibling);
    let finished = false;

    const finishRename = ({ commit }) => {
      if (finished) return;
      const newName = input.value.trim();
      if (commit && newName.length === 0) {
        input.setCustomValidity('Page name must not be empty.');
        input.reportValidity();
        input.focus();
        return;
      }
      finished = true;
      input.setCustomValidity('');
      if (commit) {
        requirePageOperation(
          state.renameHighlightPage(page.id, newName),
          'Highlight page rename'
        );
      }
      input.remove();
      activation.hidden = false;
      activation.focus();
    };

    input.addEventListener('blur', () => finishRename({ commit: true }));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finishRename({ commit: true });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finishRename({ commit: false });
      }
    });

    input.focus();
    input.select();
  }

  function renderHighlightPages() {
    if (closeActiveCombineMenu !== null) {
      closeActiveCombineMenu({ restoreFocus: false });
    }
    const focusedElement = documentOwner.activeElement;
    const focusedTab =
      focusedElement && typeof focusedElement.closest === 'function'
        ? focusedElement.closest('.highlight-page-tab')
        : null;
    const focusedPageId =
      focusedTab !== null && focusedTab.parentNode === highlightPagesTabsEl
        ? focusedTab.dataset.pageId
        : null;
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
        const activation = tab.querySelector(
          '.highlight-page-tab-activate'
        );
        if (activation === null) {
          throw new Error(
            `Highlight page "${pageId}" is missing its tab control.`
          );
        }
        activation.setAttribute(
          'aria-selected',
          isActive ? 'true' : 'false'
        );
        activation.tabIndex = isActive ? 0 : -1;

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
        activation.setAttribute(
          'aria-label',
          `${page.name}, ${count} highlighted ` +
          `${count === 1 ? 'cell' : 'cells'}`
        );

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
        colorInput.setAttribute(
          'aria-label',
          `Highlight color for ${page.name}`
        );
        const combineButton = tab.querySelector(
          '.highlight-page-tab-combine'
        );
        if (combineButton !== null) {
          combineButton.setAttribute(
            'aria-label',
            `Combine ${page.name} with another page`
          );
        }
        const deleteButton = tab.querySelector(
          '.highlight-page-tab-delete'
        );
        if (deleteButton !== null) {
          deleteButton.setAttribute(
            'aria-label',
            `Delete ${page.name}`
          );
        }
      });
      if (focusedPageId !== null && focusedPageId !== activePageId) {
        focusPageTab(activePageId);
      }
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
          showPageCombineMenu({
            sourcePageId: draggedPageId,
            targetPageId: page.id,
            x: e.clientX,
            y: e.clientY
          });
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
      colorInput.setAttribute(
        'aria-label',
        `Highlight color for ${page.name}`
      );

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

      const activation = documentOwner.createElement('button');
      activation.type = 'button';
      activation.className = 'highlight-page-tab-activate';
      activation.setAttribute('aria-selected', isActive ? 'true' : 'false');
      activation.setAttribute('role', 'tab');
      activation.tabIndex = isActive ? 0 : -1;

      const nameSpan = documentOwner.createElement('span');
      nameSpan.className = 'highlight-page-tab-name';
      nameSpan.textContent = page.name;
      nameSpan.title = page.name;

      nameSpan.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (state.getActivePageId() !== page.id) {
          requirePageOperation(
            state.switchToPage(page.id),
            'Highlight page switch'
          );
        }
        startPageRename(tab, page);
      });

      activation.appendChild(nameSpan);

      const countSpan = documentOwner.createElement('span');
      countSpan.className = 'highlight-page-tab-count';
      const count = pageCounts.get(page.id);
      countSpan.textContent = count > 0 ? formatDataNumber(count) : '(0)';
      activation.setAttribute(
        'aria-label',
        `${page.name}, ${count} highlighted ` +
        `${count === 1 ? 'cell' : 'cells'}`
      );
      activation.appendChild(countSpan);
      activation.addEventListener('click', () => {
        requirePageOperation(
          state.switchToPage(page.id),
          'Highlight page switch'
        );
      });
      activation.addEventListener('keydown', (e) => {
        const pageIndex = pages.findIndex(
          candidate => candidate.id === page.id
        );
        if (pageIndex < 0) {
          throw new Error(
            `Focused highlight page "${page.id}" is not current.`
          );
        }
        let targetIndex = null;
        if (e.key === 'ArrowLeft') {
          targetIndex = (pageIndex - 1 + pages.length) % pages.length;
        } else if (e.key === 'ArrowRight') {
          targetIndex = (pageIndex + 1) % pages.length;
        } else if (e.key === 'Home') {
          targetIndex = 0;
        } else if (e.key === 'End') {
          targetIndex = pages.length - 1;
        }
        if (targetIndex !== null) {
          e.preventDefault();
          const targetPage = pages[targetIndex];
          requirePageOperation(
            state.switchToPage(targetPage.id),
            'Highlight page keyboard switch'
          );
          focusPageTab(targetPage.id);
          return;
        }
        const isCurrentlyActive = state.getActivePageId() === page.id;
        if (
          e.key === 'F2' ||
          (e.key === 'Enter' && isCurrentlyActive)
        ) {
          e.preventDefault();
          if (!isCurrentlyActive) {
            requirePageOperation(
              state.switchToPage(page.id),
              'Highlight page switch before rename'
            );
          }
          startPageRename(tab, page);
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          requirePageOperation(
            state.switchToPage(page.id),
            'Highlight page keyboard switch'
          );
          focusPageTab(page.id);
          return;
        }
        if (e.key === 'Delete' && pages.length > 1) {
          e.preventDefault();
          requirePageOperation(
            state.deleteHighlightPage(page.id),
            'Highlight page keyboard deletion'
          );
          focusPageTab(state.getActivePageId());
        }
      });
      tab.appendChild(activation);

      if (pages.length > 1) {
        const combineBtn = documentOwner.createElement('button');
        combineBtn.type = 'button';
        combineBtn.className = 'highlight-page-tab-combine';
        combineBtn.textContent = '⋈';
        combineBtn.title = 'Combine with another page';
        combineBtn.setAttribute('aria-controls', 'page-combine-menu');
        combineBtn.setAttribute('aria-expanded', 'false');
        combineBtn.setAttribute('aria-haspopup', 'menu');
        combineBtn.setAttribute(
          'aria-label',
          `Combine ${page.name} with another page`
        );
        combineBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = combineBtn.getBoundingClientRect();
          showPageCombineMenu({
            returnFocus: combineBtn,
            sourcePageId: page.id,
            x: rect.left,
            y: rect.bottom + 4
          });
        });
        tab.appendChild(combineBtn);
      }

      if (pages.length > 1) {
        const deleteBtn = documentOwner.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'highlight-page-tab-delete';
        deleteBtn.innerHTML = '×';
        deleteBtn.title = 'Delete this page';
        deleteBtn.setAttribute('aria-label', `Delete ${page.name}`);
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          requirePageOperation(
            state.deleteHighlightPage(page.id),
            'Highlight page deletion'
          );
        });
        tab.appendChild(deleteBtn);
      }

      highlightPagesTabsEl.appendChild(tab);
    });
    if (focusedPageId !== null) {
      focusPageTab(
        currentPageIds.includes(focusedPageId)
          ? focusedPageId
          : activePageId
      );
    }
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
    focusPageTab(newPage.id);
  });

  return { renderHighlightPages };
}
