/**
 * @fileoverview Highlight page tabs UI.
 *
 * Manages the highlight page tab strip (switch, rename, delete, recolor) and
 * the drag-to-combine affordance (union / intersection). Every change is a
 * highlight action (`highlight-actions.js`), dispatched with the pages' names;
 * the tabs are redrawn from the state when it changes.
 *
 * @module ui/modules/highlight/highlight-pages-ui
 */

import { StyleManager } from '../../../../utils/style-manager.js';
import { coalesceToFrame } from '../../components/controls.js';
import { openMenu } from '../../components/menu.js';
import {
  requireDomElement,
  requireMethods,
  requireSafeInteger,
} from './exact-contract.js';
import { requireExactKeys } from '../../../../utils/exact-record.js';
import { countNoun, formatCompactCount } from '../../../../utils/format-units.js';
import { dispatchFromControl } from '../../../actions/control-dispatch.js';
import { isHexColor } from '../../../../utils/hex-color.js';

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
      'ensureHighlightPage',
      'getActivePageId',
      'getHighlightedCellCountForPage',
      'getHighlightPages'
    ]
  );
  requireExactKeys(
    dom,
    ['pagesTabsEl', 'addPageBtn'],
    'Highlight pages DOM'
  );
  /**
   * Dispatch a page action; resolves to its result, or null when it was not
   * applied (the notification already said why).
   */
  function act(type, params, failure) {
    return dispatchFromControl(type, params, { failure, category: 'highlight' });
  }

  /** The current name of the page `pageId` names, or null once it is gone. */
  function currentPageName(pageId) {
    const page = state.getHighlightPages().find(candidate => candidate.id === pageId);
    return page === undefined ? null : page.name;
  }

  /** Show a page by name, unless it is shown already. */
  function showPage(pageId) {
    const name = currentPageName(pageId);
    if (name === null) return Promise.resolve(null);
    if (state.getActivePageId() === pageId) return Promise.resolve(true);
    return act('highlight.page.switch', { page: name }, 'Showing the highlight page failed');
  }

  /** Delete a page (one history step; the history undoes it). */
  function deletePage(pageId) {
    const name = currentPageName(pageId);
    if (name === null) return Promise.resolve(null);
    return act('highlight.page.delete', { pages: [name] }, 'Deleting the highlight page failed');
  }

  /** The tab of `pageId` as drawn now (a redraw replaces tabs). */
  function tabOf(pageId) {
    for (const tab of highlightPagesTabsEl.querySelectorAll('.highlight-page-tab')) {
      if (tab.dataset.pageId === pageId) return tab;
    }
    return null;
  }

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

  const lifecycleController = new AbortController();
  let destroyed = false;
  let draggedPageId = null;
  let lastPageIds = [];
  let closeActiveCombineMenu = null;

  function listen(target, eventName, listener) {
    target.addEventListener(eventName, (...args) => {
      if (destroyed) return;
      listener(...args);
    }, { signal: lifecycleController.signal });
  }

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
      || !isHexColor(page.color)
    ) {
      throw new TypeError(`${label} color must be an exact hex RGB value.`);
    }
    if (!Array.isArray(page.highlightedGroups)) {
      throw new TypeError(`${label} highlightedGroups must be an array.`);
    }
    return page;
  }

  function focusPageTab(pageId) {
    if (destroyed) return false;
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

  /**
   * The ways to combine a page with another: the shared menu
   * (`ui/components/menu.js`, its look and keys), under the page's Combine
   * button, or where a page was dropped on another (`at`, the drop point;
   * focus returns to the page dropped on).
   */
  function showPageCombineMenu({ anchor, sourcePageId, targetPageId = null, at = null }) {
    if (destroyed) return;
    if (closeActiveCombineMenu !== null) closeActiveCombineMenu();
    closeActiveCombineMenu = null;
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

    async function combineWithPage(targetPage, operation) {
      const sourceName = currentPageName(sourcePageId);
      const targetName = currentPageName(targetPage.id);
      if (sourceName === null || targetName === null) return;
      const done = await act(
        'highlight.page.combine',
        { pages: [sourceName, targetName], operation },
        'Combining the highlight pages failed'
      );
      if (done !== null) focusPageTab(state.getActivePageId());
    }

    const items = [];
    for (const targetPage of targetPages) {
      for (const operation of ['intersection', 'union']) {
        const isIntersection = operation === 'intersection';
        items.push({
          label: `${isIntersection ? '∩ Intersection' : '∪ Union'} with ${targetPage.name}`,
          title: isIntersection
            ? `Create a page with cells in both ${sourcePage.name} and ${targetPage.name}`
            : `Create a page with cells in either ${sourcePage.name} or ${targetPage.name}`,
          run: () => {
            if (!destroyed) void combineWithPage(targetPage, operation);
          }
        });
      }
    }
    closeActiveCombineMenu = openMenu({
      anchor,
      at,
      items,
      label: `Combine ${sourcePage.name}`
    });
  }

  function startPageRename(tabEl, page) {
    if (destroyed) return;
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
      const currentName = currentPageName(page.id);
      input.remove();
      activation.hidden = false;
      activation.focus();
      if (commit && currentName !== null && newName !== currentName) {
        void act(
          'highlight.page.rename',
          { page: currentName, name: newName },
          'Renaming the highlight page failed'
        );
      }
    };

    listen(input, 'blur', () => finishRename({ commit: true }));
    listen(input, 'keydown', (e) => {
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
    if (destroyed) return;
    if (closeActiveCombineMenu !== null) closeActiveCombineMenu();
    closeActiveCombineMenu = null;
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
        if (isActive) {
          tab.dataset.state = 'selected';
        } else {
          delete tab.dataset.state;
        }
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
        const next = count > 0 ? formatCompactCount(count) : '(0)';
        if (countSpan.textContent !== next) countSpan.textContent = next;
        activation.setAttribute(
          'aria-label',
          `${page.name}, ${count} highlighted ` +
          `${countNoun(count, 'cell')}`
        );

        const colorEl = tab.querySelector('.highlight-page-color');
        const colorInput = tab.querySelector('.color-swatch-input');
        if (colorEl === null || colorInput === null) {
          throw new Error(
            `Highlight page "${pageId}" is missing its color controls.`
          );
        }
        StyleManager.setVariable(
          colorEl,
          '--swatch-color',
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
      tab.className = 'chip highlight-page-tab';
      if (isActive) tab.dataset.state = 'selected';
      tab.dataset.pageId = page.id;

      tab.draggable = true;

      listen(tab, 'dragstart', (e) => {
        draggedPageId = page.id;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-highlight-page', page.id);
      });

      listen(tab, 'dragend', () => {
        tab.classList.remove('dragging');
        highlightPagesTabsEl.querySelectorAll('.highlight-page-tab').forEach((t) => {
          t.classList.remove('drag-over');
        });
        draggedPageId = null;
      });

      listen(tab, 'dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });

      listen(tab, 'dragenter', (e) => {
        e.preventDefault();
        if (draggedPageId && draggedPageId !== page.id) {
          tab.classList.add('drag-over');
        }
      });

      listen(tab, 'dragleave', () => {
        tab.classList.remove('drag-over');
      });

      listen(tab, 'drop', (e) => {
        e.preventDefault();
        tab.classList.remove('drag-over');
        if (draggedPageId && draggedPageId !== page.id) {
          showPageCombineMenu({
            anchor: tab.querySelector('.highlight-page-tab-activate'),
            sourcePageId: draggedPageId,
            targetPageId: page.id,
            at: { x: e.clientX, y: e.clientY }
          });
        }
      });

      const colorIndicator = documentOwner.createElement('span');
      colorIndicator.className = 'color-swatch highlight-page-color';
      StyleManager.setVariable(
        colorIndicator,
        '--swatch-color',
        page.color
      );
      colorIndicator.title = 'Click to change color';

      const colorInput = documentOwner.createElement('input');
      colorInput.type = 'color';
      colorInput.className = 'color-swatch-input';
      colorInput.value = page.color;
      colorInput.title = 'Click to change color';
      colorInput.setAttribute(
        'aria-label',
        `Highlight color for ${page.name}`
      );

      // A color drag fires an input event per pointer move; each published
      // color recolors the highlights and redraws every page tab and the
      // category builder. The swatch follows every event; the state gets
      // the latest color once per frame, and the final one on change. The
      // history keeps one step per page for the whole drag
      // (`highlight.page.recolor` coalesces by page).
      const publishColor = coalesceToFrame(color => {
        const name = destroyed ? null : currentPageName(page.id);
        if (name === null) return;
        void act('highlight.page.recolor', { page: name, color }, 'Recoloring the highlight page failed');
      });
      listen(colorInput, 'input', () => {
        const newColor = colorInput.value;
        StyleManager.setVariable(
          colorIndicator,
          '--swatch-color',
          newColor
        );
        publishColor(newColor);
      });
      listen(colorInput, 'change', () => {
        publishColor(colorInput.value);
        publishColor.flush();
      });
      listen(colorInput, 'click', (e) => {
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
      nameSpan.className = 'chip-name highlight-page-tab-name';
      nameSpan.textContent = page.name;
      nameSpan.title = page.name;

      listen(nameSpan, 'dblclick', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (await showPage(page.id) === null) return;
        const current = tabOf(page.id);
        if (current !== null) startPageRename(current, page);
      });

      activation.appendChild(nameSpan);

      const countSpan = documentOwner.createElement('span');
      countSpan.className = 'chip-count highlight-page-tab-count';
      const count = pageCounts.get(page.id);
      countSpan.textContent = count > 0 ? formatCompactCount(count) : '(0)';
      activation.setAttribute(
        'aria-label',
        `${page.name}, ${count} highlighted ` +
        `${countNoun(count, 'cell')}`
      );
      activation.appendChild(countSpan);
      listen(activation, 'click', () => {
        void showPage(page.id);
      });
      listen(activation, 'keydown', (e) => {
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
          void showPage(targetPage.id).then(done => {
            if (done !== null) focusPageTab(targetPage.id);
          });
          return;
        }
        const isCurrentlyActive = state.getActivePageId() === page.id;
        if (
          e.key === 'F2' ||
          (e.key === 'Enter' && isCurrentlyActive)
        ) {
          e.preventDefault();
          if (isCurrentlyActive) {
            startPageRename(tab, page);
            return;
          }
          void showPage(page.id).then(done => {
            const current = tabOf(page.id);
            if (done !== null && current !== null) startPageRename(current, page);
          });
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void showPage(page.id).then(done => {
            if (done !== null) focusPageTab(page.id);
          });
          return;
        }
        if (e.key === 'Delete' && pages.length > 1) {
          e.preventDefault();
          void deletePage(page.id).then(() => focusPageTab(state.getActivePageId()));
        }
      });
      tab.appendChild(activation);

      if (pages.length > 1) {
        const combineBtn = documentOwner.createElement('button');
        combineBtn.type = 'button';
        combineBtn.className = 'highlight-page-tab-combine';
        combineBtn.textContent = '⋈';
        combineBtn.title = 'Combine with another page';
        combineBtn.setAttribute('aria-expanded', 'false');
        combineBtn.setAttribute('aria-haspopup', 'menu');
        combineBtn.setAttribute(
          'aria-label',
          `Combine ${page.name} with another page`
        );
        listen(combineBtn, 'click', (e) => {
          e.stopPropagation();
          showPageCombineMenu({ anchor: combineBtn, sourcePageId: page.id });
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
        // The accessible name carries a name the user typed. Declaring the
        // analytics id keeps the click countable without the tracker having to
        // read that name to identify the control.
        deleteBtn.dataset.analyticsId = 'highlight:delete-page';
        listen(deleteBtn, 'click', (e) => {
          e.stopPropagation();
          void deletePage(page.id);
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

  listen(addHighlightPageBtn, 'click', async () => {
    const made = await act('highlight.page.create', {}, 'Making a highlight page failed');
    if (made !== null) focusPageTab(state.getActivePageId());
  });

  return {
    renderHighlightPages,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      draggedPageId = null;
      const failures = [];
      if (closeActiveCombineMenu !== null) {
        try {
          closeActiveCombineMenu();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        lifecycleController.abort();
      } catch (error) {
        failures.push(error);
      }
      const exactFailures = [...new Set(failures)];
      if (exactFailures.length === 1) throw exactFailures[0];
      if (exactFailures.length > 1) {
        throw new AggregateError(
          exactFailures,
          'Highlight pages failed to release every owned resource.'
        );
      }
    }
  };
}
