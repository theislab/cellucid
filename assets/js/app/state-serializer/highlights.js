/**
 * @fileoverview Highlight page serialization helpers.
 *
 * @module state-serializer/highlights
 */

import { debug } from '../utils/debug.js';

export function serializeHighlightPages(state) {
  const pages = state.getHighlightPages?.() || [];
  return pages.map(page => ({
    id: page.id,
    name: page.name,
    color: page.color || null,
    highlightedGroups: (page.highlightedGroups || []).map(group => ({
      id: group.id,
      type: group.type,
      label: group.label,
      enabled: group.enabled,
      fieldKey: group.fieldKey,
      fieldIndex: group.fieldIndex,
      fieldSource: group.fieldSource,
      categoryIndex: group.categoryIndex,
      categoryName: group.categoryName,
      rangeMin: group.rangeMin,
      rangeMax: group.rangeMax,
      // CRITICAL: Include cellIndices for exact restoration
      cellIndices: group.cellIndices ? Array.from(group.cellIndices) : [],
      cellCount: group.cellCount || (group.cellIndices?.length || 0)
    }))
  }));
}

/**
 * Restore highlight pages with exact cellIndices.
 * Uses addHighlightDirect for precise restoration of highlighted cells.
 *
 * @param {object} state
 * @param {any[]} pages
 * @param {object|string|null} activePageInfo
 */
export function restoreHighlightPages(state, pages, activePageInfo) {
  if (!pages || !Array.isArray(pages)) {
    console.warn('[StateSerializer] No highlight pages to restore');
    return;
  }

  const activeId = activePageInfo && typeof activePageInfo === 'object' ? activePageInfo.id : activePageInfo;
  const activeName = activePageInfo && typeof activePageInfo === 'object' ? activePageInfo.name : null;

  // Ensure at least one page exists before we start
  state.ensureHighlightPage?.();

  // Clear existing pages - delete all except the first one
  let existingPages = state.getHighlightPages?.() || [];
  for (let i = existingPages.length - 1; i >= 0; i--) {
    if (existingPages.length > 1) {
      state.deleteHighlightPage?.(existingPages[i].id);
    }
  }

  // Clear highlights on remaining page and get its ID
  existingPages = state.getHighlightPages?.() || [];
  if (existingPages.length > 0) {
    state.switchToPage?.(existingPages[0].id);
  }
  state.clearAllHighlights?.();

  // Track page name to ID mapping for active page restoration
  const pageNameToId = {};
  const pageIdMap = new Map(); // originalId -> newId
  let totalGroupsRestored = 0;

  // Recreate pages
  pages.forEach((page, pageIdx) => {
    let targetPageId;

    if (pageIdx === 0) {
      // Use the existing first page, just rename it
      const currentPages = state.getHighlightPages?.() || [];
      if (currentPages.length > 0) {
        targetPageId = currentPages[0].id;
        state.renameHighlightPage?.(targetPageId, page.name);
      } else {
        const newPage = state.createHighlightPage?.(page.name);
        targetPageId = newPage?.id || newPage;
      }
    } else {
      const newPage = state.createHighlightPage?.(page.name);
      targetPageId = newPage?.id || newPage;
    }

    if (!targetPageId) {
      console.warn(`[StateSerializer] Failed to create/get page for: ${page.name}`);
      return;
    }

    pageNameToId[page.name] = targetPageId;
    if (page.id) {
      pageIdMap.set(page.id, targetPageId);
    }

    if (page.color && typeof state.setHighlightPageColor === 'function') {
      state.setHighlightPageColor(targetPageId, page.color);
    }

    // Switch to this page to add groups
    const switched = state.switchToPage?.(targetPageId);
    if (!switched && switched !== undefined) {
      console.warn(`[StateSerializer] Failed to switch to page: ${targetPageId}`);
      return;
    }

    // Recreate groups using direct cellIndices restoration
    const groups = page.highlightedGroups || [];
    groups.forEach((group) => {
      if (group.cellIndices && group.cellIndices.length > 0) {
        const result = state.addHighlightDirect?.({
          type: group.type,
          label: group.label,
          fieldKey: group.fieldKey,
          fieldIndex: group.fieldIndex,
          fieldSource: group.fieldSource || 'obs',
          categoryIndex: group.categoryIndex,
          categoryName: group.categoryName,
          rangeMin: group.rangeMin,
          rangeMax: group.rangeMax,
          cellIndices: group.cellIndices,
          enabled: group.enabled !== false
        });
        if (result) {
          totalGroupsRestored++;
        } else {
          console.warn(`[StateSerializer] Failed to restore highlight group: ${group.label}`);
        }
      } else {
        // Development phase: no legacy/migration restore paths.
        console.warn(`[StateSerializer] Skipping highlight group without cellIndices: ${group.label}`);
      }
    });
  });

  debug.log(`[StateSerializer] Restored ${pages.length} pages with ${totalGroupsRestored} highlight groups`);

  // Switch to the active page
  let targetActiveId = null;
  if (activeId && pageIdMap.has(activeId)) {
    targetActiveId = pageIdMap.get(activeId);
  } else if (activeName && pageNameToId[activeName]) {
    targetActiveId = pageNameToId[activeName];
  } else if (activeId) {
    const originalPage = pages.find(p => p.id === activeId);
    if (originalPage && pageNameToId[originalPage.name]) {
      targetActiveId = pageNameToId[originalPage.name];
    }
  }
  if (!targetActiveId && pages.length > 0) {
    targetActiveId = pageIdMap.get(pages[0].id) || pageNameToId[pages[0].name];
  }
  if (targetActiveId) {
    state.switchToPage?.(targetActiveId);
  }
}

