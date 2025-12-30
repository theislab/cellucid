/**
 * @fileoverview Session contributor: highlight pages/groups metadata (no cell indices).
 *
 * EAGER chunk (dataset-dependent):
 * - Highlight pages (id/name/color)
 * - Highlight group shells (id/type/label/field refs/range/category info)
 * - Active page id/name (best-effort)
 *
 * Heavy membership arrays are stored separately in `highlights/cells/<groupId>`
 * lazy chunks.
 *
 * @module session/contributors/highlights-meta
 */

export const id = 'highlights-meta';

/**
 * Capture highlight pages and group metadata (no cellIndices).
 * @param {object} ctx
 * @returns {import('../session-serializer.js').SessionChunk[]}
 */
export function capture(ctx) {
  const state = ctx?.state;
  if (!state?.getHighlightPages) return [];

  const pages = state.getHighlightPages() || [];
  const activePageId = state.getActivePageId?.() || state.activePageId || null;
  const activePageName = state.getActivePage?.()?.name || null;

  const payloadPages = pages.map((page) => ({
    id: page.id,
    name: page.name,
    color: page.color || null,
    highlightedGroups: (page.highlightedGroups || []).map((group) => ({
      id: group.id,
      type: group.type,
      label: group.label,
      enabled: group.enabled !== false,
      fieldKey: group.fieldKey,
      fieldIndex: group.fieldIndex,
      fieldSource: group.fieldSource,
      categoryIndex: group.categoryIndex,
      categoryName: group.categoryName,
      rangeMin: group.rangeMin,
      rangeMax: group.rangeMax,
      // Provide a count hint so the UI can render a reasonable label early.
      cellCount: group.cellCount || (group.cellIndices?.length || 0)
    }))
  }));

  return [
    {
      id: 'highlights/meta',
      contributorId: id,
      priority: 'eager',
      kind: 'json',
      codec: 'gzip',
      label: 'Highlight metadata',
      datasetDependent: true,
      payload: {
        pages: payloadPages,
        activePageId,
        activePageName
      }
    }
  ];
}

/**
 * Restore highlight pages and group shells (no membership arrays).
 *
 * The goal is to rebuild the highlight UI structure quickly so users see their
 * pages/groups immediately; memberships fill in as lazy chunks load.
 *
 * @param {object} ctx
 * @param {any} _chunkMeta
 * @param {{ pages?: any[], activePageId?: string|null, activePageName?: string|null }} payload
 */
export function restore(ctx, _chunkMeta, payload) {
  const state = ctx?.state;
  if (!state || !payload || !Array.isArray(payload.pages)) return;

  const pages = payload.pages;

  // Reset highlight state to a clean slate.
  state.highlightPages = [];
  state.activePageId = null;
  state._highlightPageIdCounter = 0;
  state._highlightIdCounter = 0;

  let maxPageCounter = 0;
  let maxGroupCounter = 0;

  for (const page of pages) {
    const pageId = String(page?.id || '').trim();
    if (!pageId) continue;

    // Track numeric suffixes to avoid future ID collisions.
    const pageMatch = pageId.match(/^page_(\d+)$/);
    if (pageMatch) maxPageCounter = Math.max(maxPageCounter, Number(pageMatch[1]) || 0);

    const pageObj = {
      id: pageId,
      name: String(page?.name || 'Page').trim() || 'Page',
      color: page?.color || null,
      highlightedGroups: []
    };

    for (const group of (page?.highlightedGroups || [])) {
      const groupId = String(group?.id || '').trim();
      if (!groupId) continue;
      const groupMatch = groupId.match(/^highlight_(\d+)$/);
      if (groupMatch) maxGroupCounter = Math.max(maxGroupCounter, Number(groupMatch[1]) || 0);

      pageObj.highlightedGroups.push({
        id: groupId,
        type: group?.type || 'combined',
        label: group?.label || `Restored selection`,
        enabled: group?.enabled !== false,
        fieldKey: group?.fieldKey,
        fieldIndex: group?.fieldIndex,
        fieldSource: group?.fieldSource || 'obs',
        categoryIndex: group?.categoryIndex,
        categoryName: group?.categoryName,
        rangeMin: group?.rangeMin,
        rangeMax: group?.rangeMax,
        cellIndices: [], // filled in by lazy `highlights/cells/*` chunks
        cellCount: typeof group?.cellCount === 'number' ? group.cellCount : 0
      });
    }

    state.highlightPages.push(pageObj);
  }

  // Ensure we always have at least one page (UI expects this invariant).
  if (state.highlightPages.length === 0) {
    state.ensureHighlightPage?.();
  }

  // Preserve the higher of:
  // - what `ensureHighlightPage()` may have created
  // - the max numeric suffix we saw in restored ids
  // This prevents future id collisions when users add new pages/groups.
  state._highlightPageIdCounter = Math.max(Number(state._highlightPageIdCounter || 0), maxPageCounter);
  state._highlightIdCounter = Math.max(Number(state._highlightIdCounter || 0), maxGroupCounter);

  // Restore active page (best-effort).
  const activeId = String(payload.activePageId || '').trim();
  const activeById = activeId ? state.highlightPages.find(p => p.id === activeId) : null;
  const activeByName =
    !activeById && payload.activePageName
      ? state.highlightPages.find(p => p.name === payload.activePageName)
      : null;

  state.activePageId = (activeById || activeByName || state.highlightPages[0] || null)?.id || null;

  // Ensure highlight buffer matches the current dataset.
  state._recomputeHighlightArray?.();
  state._notifyHighlightPageChange?.();
  state._notifyHighlightChange?.();
}
