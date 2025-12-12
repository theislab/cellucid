/**
 * State Serializer - Dynamic save/load for all application state
 *
 * Captures:
 * - All UI control values (inputs, selects, checkboxes) automatically
 * - Camera position (orbit + freefly)
 * - Highlight pages and groups
 * - Field filter states
 * - Active field selections
 * - Multiview/snapshot configurations
 * - Data source and dataset information
 */

import { getCategoryColor } from '../data/palettes.js';
import { getDataSourceManager } from '../data/data-source-manager.js';

/**
 * Compare two RGB colors for equality within a small epsilon
 */
function colorsEqual(a, b, epsilon = 1e-4) {
  if (!a || !b) return !a && !b;
  return Math.abs(a[0] - b[0]) < epsilon &&
         Math.abs(a[1] - b[1]) < epsilon &&
         Math.abs(a[2] - b[2]) < epsilon;
}

export function createStateSerializer({ state, viewer, sidebar }) {
  // v3: multiview restore, full filter capture, stronger post-restore syncing
  const VERSION = 3;

  function getUiRoots() {
    const roots = [];
    if (sidebar) roots.push(sidebar);
    const floatingRoot = document.getElementById('floating-panels-root');
    if (floatingRoot) roots.push(floatingRoot);
    return roots;
  }

  function queryAll(selector) {
    const roots = getUiRoots();
    const out = [];
    for (const root of roots) {
      out.push(...root.querySelectorAll(selector));
    }
    return out;
  }

  /**
   * Determine if a categorical field has been modified from defaults
   */
  function isCategoryFieldModified(field) {
    if (!field || field.kind !== 'category') return false;
    if (field._categoryFilterEnabled === false) return true;
    if (field._categoryVisible) {
      for (const visible of Object.values(field._categoryVisible)) {
        if (visible === false) return true;
      }
    }
    if (field._colormapId) return true;
    // Check if any category colors have been changed from defaults
    if (field._categoryColors) {
      for (let i = 0; i < field._categoryColors.length; i++) {
        const color = field._categoryColors[i];
        if (color) {
          const defaultColor = getCategoryColor(i);
          if (!colorsEqual(color, defaultColor)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Determine if a continuous field has been modified from defaults
   */
  function isContinuousFieldModified(field) {
    if (!field || field.kind !== 'continuous') return false;

    if (field._filterEnabled === false) return true;

    if (field._continuousFilter && field._continuousStats) {
      const stats = field._continuousStats;
      const filter = field._continuousFilter;
      const minChanged = filter.min > stats.min + 1e-6;
      const maxChanged = filter.max < stats.max - 1e-6;
      if (minChanged || maxChanged) return true;
    }

    // Check if colorRange differs from the stats (default is to use stats range)
    if (field._continuousColorRange && field._continuousStats) {
      const stats = field._continuousStats;
      const colorRange = field._continuousColorRange;
      const minChanged = Math.abs(colorRange.min - stats.min) > 1e-6;
      const maxChanged = Math.abs(colorRange.max - stats.max) > 1e-6;
      if (minChanged || maxChanged) return true;
    }
    if (field._useFilterColorRange) return true;
    if (field._useLogScale) return true;

    const outlierEnabled = field._outlierFilterEnabled !== false;
    if (!outlierEnabled) return true;
    if (outlierEnabled && field._outlierThreshold != null && field._outlierThreshold < 0.9999) return true;

    // Check if colormap differs from the default ('viridis')
    if (field._colormapId && field._colormapId !== 'viridis') return true;
    return false;
  }

  /**
   * Dynamically collect all UI control values from the sidebar
   * Uses element IDs as keys for restoration
   */
  function collectUIControls() {
    const controls = {};

    // Collect all inputs
    queryAll('input[id]').forEach(input => {
      const id = input.id;
      if (input.type === 'checkbox') {
        controls[id] = { type: 'checkbox', checked: input.checked };
      } else if (input.type === 'range' || input.type === 'number') {
        controls[id] = { type: input.type, value: input.value };
      } else if (input.type === 'color') {
        controls[id] = { type: 'color', value: input.value };
      } else if (input.type === 'text' || input.type === 'search') {
        controls[id] = { type: 'text', value: input.value };
      }
    });

    // Collect all selects
    queryAll('select[id]').forEach(select => {
      controls[select.id] = { type: 'select', value: select.value };
    });

    // Collect accordion open/closed states
    queryAll('details.accordion-section').forEach(details => {
      const summary = details.querySelector('summary');
      const key = summary?.textContent?.trim() || details.id;
      if (key) {
        controls[`accordion:${key}`] = { type: 'details', open: details.open };
      }
    });

    return controls;
  }

  // IDs that should be skipped during general restoration (handled specially)
  const SPECIAL_IDS = new Set([
    'navigation-mode',      // Camera-related, handled separately
    'categorical-field',    // Dynamically populated, handled via activeFields
    'continuous-field',     // Dynamically populated, handled via activeFields
    'outlier-filter',       // Per-field state, restored after active field is set
    'gene-expression-search', // Restored via activeFields
  ]);

  /**
   * Restore UI controls from saved state
   * @param {Object} controls - Saved control values
   * @param {Set<string>} skipIds - Additional IDs to skip (for deferred restoration)
   */
  function restoreUIControls(controls, skipIds = new Set()) {
    if (!controls) return;

    // Merge special IDs with additional skip IDs
    const allSkipIds = new Set([...SPECIAL_IDS, ...skipIds]);

    // First pass: restore accordions
    Object.entries(controls).forEach(([id, data]) => {
      if (id.startsWith('accordion:')) {
        const key = id.replace('accordion:', '');
        queryAll('details.accordion-section').forEach(details => {
          const summary = details.querySelector('summary');
          const summaryText = summary?.textContent?.trim();
          if (summaryText === key || details.id === key) {
            details.open = data.open;
          }
        });
      }
    });

    // Second pass: restore controls in order (checkboxes first, then selects, then ranges)
    // This ensures parent toggles are set before dependent controls
    const checkboxes = [];
    const selects = [];
    const ranges = [];
    const others = [];

    Object.entries(controls).forEach(([id, data]) => {
      if (allSkipIds.has(id) || id.startsWith('accordion:')) return;
      if (data.type === 'checkbox') checkboxes.push([id, data]);
      else if (data.type === 'select') selects.push([id, data]);
      else if (data.type === 'range' || data.type === 'number') ranges.push([id, data]);
      else others.push([id, data]);
    });

    // Restore in order: checkboxes → selects → ranges → others
    [...checkboxes, ...selects, ...ranges, ...others].forEach(([id, data]) => {
      restoreSingleControl(id, data);
    });
  }

  /**
   * Restore a single UI control by ID
   */
  function restoreSingleControl(id, data) {
    if (!data) return;
    const el = document.getElementById(id);
    if (!el) {
      console.warn(`[StateSerializer] Control not found: ${id}`);
      return;
    }

    try {
      if (data.type === 'checkbox' && el.type === 'checkbox') {
        // Avoid dispatching change events if state is already in sync (saves expensive recomputations)
        if (el.checked !== data.checked) {
          el.checked = data.checked;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (data.type === 'select' && el.tagName === 'SELECT') {
        // Check if the option exists
        const optionExists = Array.from(el.options).some(opt => opt.value === data.value);
        if (optionExists) {
          if (el.value !== data.value) {
            el.value = data.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } else {
          console.warn(`[StateSerializer] Option '${data.value}' not found in select '${id}'`);
        }
      } else if ((data.type === 'range' || data.type === 'number') && el.type === data.type) {
        const nextValue = String(data.value);
        if (el.value !== nextValue) {
          el.value = nextValue;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } else if (data.type === 'color' && el.type === 'color') {
        if (el.value !== data.value) {
          el.value = data.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } else if (data.type === 'text' && (el.type === 'text' || el.type === 'search')) {
        if (el.value !== data.value) {
          el.value = data.value;
          // Also dispatch input event for search fields that might have handlers
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    } catch (err) {
      console.error(`[StateSerializer] Error restoring control '${id}':`, err);
    }
  }

  /**
   * Serialize highlight pages from state
   * Includes cellIndices for exact restoration of highlighted cells
   */
  function serializeHighlightPages() {
    const pages = state.getHighlightPages?.() || [];
    return pages.map(page => ({
      id: page.id,
      name: page.name,
      highlightedGroups: (page.highlightedGroups || []).map(group => ({
        id: group.id,
        type: group.type,
        label: group.label,
        enabled: group.enabled,
        fieldKey: group.fieldKey,
        fieldIndex: group.fieldIndex,
        fieldSource: group.fieldSource,
        // Category-specific
        categoryIndex: group.categoryIndex,
        categoryName: group.categoryName,
        // Range-specific
        rangeMin: group.rangeMin,
        rangeMax: group.rangeMax,
        // CRITICAL: Include cellIndices for exact restoration
        cellIndices: group.cellIndices ? Array.from(group.cellIndices) : [],
        cellCount: group.cellCount || (group.cellIndices?.length || 0)
      }))
    }));
  }

  function serializeFiltersForFields(fields, source) {
    const filters = {};
    (fields || []).forEach((field) => {
      if (!field) return;

      const modified =
        field.kind === 'category'
          ? isCategoryFieldModified(field)
          : isContinuousFieldModified(field);
      if (!modified) return;

      const key = `${source}:${field.key}`;
      if (field.kind === 'category') {
        const visibility = {};
        if (field._categoryVisible) {
          Object.entries(field._categoryVisible).forEach(([catIdx, visible]) => {
            visibility[catIdx] = visible;
          });
        }
        // Only save colors that differ from the default palette
        const colors = {};
        if (field._categoryColors) {
          field._categoryColors.forEach((color, catIdx) => {
            if (color) {
              const defaultColor = getCategoryColor(catIdx);
              if (!colorsEqual(color, defaultColor)) {
                colors[catIdx] = [...color];
              }
            }
          });
        }
        filters[key] = {
          kind: 'category',
          filterEnabled: field._categoryFilterEnabled !== false,
          visibility,
          colors,
          colormapId: field._colormapId || null
        };
      } else if (field.kind === 'continuous') {
        filters[key] = {
          kind: 'continuous',
          filterEnabled: field._filterEnabled !== false,
          filter: field._continuousFilter ? { ...field._continuousFilter } : null,
          colorRange: field._continuousColorRange ? { ...field._continuousColorRange } : null,
          useLogScale: field._useLogScale ?? false,
          useFilterColorRange: field._useFilterColorRange ?? false,
          outlierFilterEnabled: field._outlierFilterEnabled ?? false,
          outlierThreshold: field._outlierThreshold ?? 1.0,
          colormapId: field._colormapId || null
        };
      }
    });
    return filters;
  }

  /**
   * Serialize filter states from fields
   * Capture only modified fields to avoid unnecessary data loading
   */
  function serializeFilters() {
    const filters = {};
    Object.assign(filters, serializeFiltersForFields(state.getFields?.(), 'obs'));
    Object.assign(filters, serializeFiltersForFields(state.getVarFields?.(), 'var'));
    return filters;
  }

  /**
   * Get active field selections
   */
  function serializeActiveFields() {
    const activeField = state.getActiveField?.();
    const activeFieldSource = state.activeFieldSource;

    return {
      activeFieldKey: activeField?.key || null,
      activeFieldSource: activeFieldSource || null,
      activeVarFieldKey: state.activeVarFieldIndex >= 0 ? state.getVarFields?.()[state.activeVarFieldIndex]?.key : null
    };
  }

  /**
   * Serialize multiview/snapshot state
   */
  function serializeMultiview() {
    const viewLayout = viewer.getViewLayout?.() || { mode: 'single', activeId: 'live' };
    const snapshots = viewer.getSnapshotViews?.() || [];
    const viewContexts = state.viewContexts instanceof Map ? state.viewContexts : null;

    const serializedSnapshots = snapshots.map((s) => {
      const ctx = viewContexts?.get?.(String(s.id)) || null;
      const activeFieldKey =
        ctx?.activeFieldIndex >= 0 ? ctx?.obsData?.fields?.[ctx.activeFieldIndex]?.key : null;
      const activeVarFieldKey =
        ctx?.activeVarFieldIndex >= 0 ? ctx?.varData?.fields?.[ctx.activeVarFieldIndex]?.key : null;
      const activeFieldSource = ctx?.activeFieldSource || (activeVarFieldKey ? 'var' : activeFieldKey ? 'obs' : null);

      const ctxFilters = ctx
        ? {
            ...serializeFiltersForFields(ctx?.obsData?.fields, 'obs'),
            ...serializeFiltersForFields(ctx?.varData?.fields, 'var')
          }
        : null;

      let ctxOutlierThreshold = null;
      if (activeFieldSource === 'var' && ctx?.varData?.fields?.[ctx.activeVarFieldIndex]) {
        ctxOutlierThreshold = ctx.varData.fields[ctx.activeVarFieldIndex]._outlierThreshold ?? null;
      } else if (activeFieldSource === 'obs' && ctx?.obsData?.fields?.[ctx.activeFieldIndex]) {
        ctxOutlierThreshold = ctx.obsData.fields[ctx.activeFieldIndex]._outlierThreshold ?? null;
      }

      return {
        id: s.id,
        label: s.label,
        fieldKey: s.fieldKey,
        fieldKind: s.fieldKind,
        meta: s.meta,
        activeFields: {
          activeFieldKey,
          activeVarFieldKey,
          activeFieldSource
        },
        filters: ctxFilters,
        colors: ctx?.colorsArray ? Array.from(ctx.colorsArray) : null,
        transparency: ctx?.categoryTransparency ? Array.from(ctx.categoryTransparency) : null,
        outlierQuantiles: ctx?.outlierQuantilesArray ? Array.from(ctx.outlierQuantilesArray) : null,
        centroidPositions: ctx?.centroidPositions ? Array.from(ctx.centroidPositions) : null,
        centroidColors: ctx?.centroidColors ? Array.from(ctx.centroidColors) : null,
        centroidOutliers: ctx?.centroidOutliers ? Array.from(ctx.centroidOutliers) : null,
        outlierThreshold: ctxOutlierThreshold
      };
    });

    return {
      layout: viewLayout,
      snapshots: serializedSnapshots
    };
  }

  /**
   * Create a complete state snapshot
   */
  function serialize() {
    const activePageId = state.getActivePageId ? state.getActivePageId() : state.activePageId;
    const activePageName = state.getActivePage ? state.getActivePage()?.name : null;

    // Get data source state
    const dataSourceManager = getDataSourceManager();
    const dataSource = dataSourceManager?.getStateSnapshot() || null;

    return {
      version: VERSION,
      timestamp: new Date().toISOString(),
      dataSource,
      camera: viewer.getCameraState?.() || null,
      uiControls: collectUIControls(),
      highlightPages: serializeHighlightPages(),
      activePageId,
      activePageName,
      filters: serializeFilters(),
      activeFields: serializeActiveFields(),
      multiview: serializeMultiview()
    };
  }

  /**
   * Validate that a parsed JSON object looks like a real state snapshot.
   * Helps avoid silently "loading" unrelated files (e.g., the manifest itself).
   */
  function validateSnapshotShape(snapshot, label = 'state file') {
    const isObject = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot);
    if (!isObject) {
      throw new Error(`Invalid ${label}: expected a state JSON object.`);
    }
    const hasStateFields = snapshot.version != null
      || snapshot.camera
      || snapshot.filters
      || snapshot.activeFields
      || snapshot.uiControls
      || snapshot.multiview;
    if (!hasStateFields) {
      const keys = Object.keys(snapshot || {}).slice(0, 5).join(', ') || 'none';
      throw new Error(`File ${label} does not look like a cellucid state (found keys: ${keys}).`);
    }
  }

  /**
   * Restore filters to fields
   * Includes colormapId and continuousColorRange restoration
   * Returns counts so callers can avoid noisy logs when nothing is applied
   */
  async function restoreFilters(filters) {
    if (!filters) return { restored: 0, skippedNoop: 0 };

    const entries = Object.entries(filters);
    if (!entries.length) return { restored: 0, skippedNoop: 0 };

    let restored = 0;
    let skippedNoop = 0;

    const isCategoryFilterNoop = (data) => {
      if (!data) return true;
      if (data.filterEnabled === false) return false;
      if (data.colormapId) return false;
      if (data.colors && Object.keys(data.colors).length > 0) return false;
      if (data.visibility) {
        for (const v of Object.values(data.visibility)) {
          if (v === false) return false;
        }
      }
      return true;
    };

    const isContinuousFilterNoop = (data) => {
      if (!data) return true;
      if (data.filterEnabled === false) return false;
      if (data.filter) return false;
      if (data.colorRange) return false;
      if (data.useLogScale) return false;
      if (data.useFilterColorRange) return false;
      if (data.outlierFilterEnabled === false) return false;
      if (typeof data.outlierThreshold === 'number' && data.outlierThreshold < 0.9999) return false;
      if (data.colormapId) return false;
      return true;
    };

    const obsFields = state.getFields?.() || [];
    const varFields = state.getVarFields?.() || [];
    const obsLookup = new Map();
    const varLookup = new Map();

    obsFields.forEach((field, idx) => {
      if (field?.key) obsLookup.set(field.key, idx);
    });
    varFields.forEach((field, idx) => {
      if (field?.key) varLookup.set(field.key, idx);
    });

    const toRestore = [];

    for (const [key, data] of entries) {
      const [source, fieldKey] = key.split(':');
      if (!fieldKey) {
        skippedNoop += 1;
        continue;
      }

      const lookup = source === 'var' ? varLookup : obsLookup;
      const fields = source === 'var' ? varFields : obsFields;
      const fieldIndex = lookup.get(fieldKey);

      if (fieldIndex == null || fieldIndex < 0) {
        skippedNoop += 1;
        continue;
      }

      const field = fields[fieldIndex];
      if (!field) {
        skippedNoop += 1;
        continue;
      }

      const isNoop =
        data.kind === 'category'
          ? isCategoryFilterNoop(data)
          : data.kind === 'continuous'
            ? isContinuousFilterNoop(data)
            : true;

      if (isNoop) {
        skippedNoop += 1;
        continue;
      }

      toRestore.push({ source, fieldIndex, data });
    }

    if (!toRestore.length) {
      return { restored: 0, skippedNoop };
    }

    // Preload all referenced fields in parallel so filter restore does not serialize network fetches
    const preloadPromises = toRestore
      .map(({ source, fieldIndex }) => {
        if (source === 'var') {
          return state.ensureVarFieldLoaded?.(fieldIndex);
        }
        return state.ensureFieldLoaded?.(fieldIndex);
      })
      .filter(Boolean);

    if (preloadPromises.length > 0) {
      await Promise.all(preloadPromises);
    }

    // Enter batch mode to suppress expensive recomputations during bulk filter restoration
    // This reduces N calls to computeGlobalVisibility() down to 1
    state.beginBatch?.();

    try {
      for (const { source, fieldIndex, data } of toRestore) {
        const fields = source === 'var' ? (state.getVarFields?.() || []) : (state.getFields?.() || []);
        const field = fields[fieldIndex];
        if (!field) {
          skippedNoop += 1;
          continue;
        }

        if (data.kind === 'category' && field.kind === 'category') {
          // Restore category visibility
          if (data.visibility) {
            Object.entries(data.visibility).forEach(([catIdx, visible]) => {
              state.setVisibilityForCategory?.(field, parseInt(catIdx, 10), visible);
            });
          }
          // Restore category colors
          if (data.colors) {
            Object.entries(data.colors).forEach(([catIdx, color]) => {
              state.setColorForCategory?.(field, parseInt(catIdx, 10), color);
            });
          }
          field._categoryFilterEnabled = data.filterEnabled !== false;
          // Restore colormap if specified
          if (data.colormapId) {
            field._colormapId = data.colormapId;
          }
          restored += 1;
          continue;
        }

        if (data.kind === 'continuous' && field.kind === 'continuous') {
          if (data.filter) {
            field._continuousFilter = { ...data.filter };
          }
          // Restore continuous color range
          if (data.colorRange) {
            field._continuousColorRange = { ...data.colorRange };
          }
          field._filterEnabled = data.filterEnabled !== false;
          field._useLogScale = data.useLogScale ?? false;
          field._useFilterColorRange = data.useFilterColorRange ?? false;
          field._outlierFilterEnabled = data.outlierFilterEnabled ?? false;
          field._outlierThreshold = data.outlierThreshold ?? 1.0;
          // Restore colormap if specified
          if (data.colormapId) {
            field._colormapId = data.colormapId;
          }
          restored += 1;
          continue;
        }

        // Field kind mismatch or unknown data; treat as skip
        skippedNoop += 1;
      }
    } finally {
      // Exit batch mode - triggers single consolidated recomputation
      state.endBatch?.();
    }

    return { restored, skippedNoop };
  }

  /**
   * Restore highlight pages with exact cellIndices
   * Uses addHighlightDirect for precise restoration of highlighted cells
   */
  function restoreHighlightPages(pages, activePageInfo) {
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
        // Create new page - createHighlightPage returns page object, extract id
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

      // Switch to this page to add groups
      const switched = state.switchToPage?.(targetPageId);
      if (!switched && switched !== undefined) {
        console.warn(`[StateSerializer] Failed to switch to page: ${targetPageId}`);
        return;
      }

      // Recreate groups using direct cellIndices restoration
      const groups = page.highlightedGroups || [];
      groups.forEach((group) => {
        // Use addHighlightDirect if we have cellIndices (preferred - exact restoration)
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
          // Fallback: try to recreate from field data (legacy support)
          console.log(`[StateSerializer] Using legacy restore for group: ${group.label}`);
          if (group.type === 'category' && group.fieldIndex != null && group.categoryIndex != null) {
            state.addHighlightFromCategory?.(group.fieldIndex, group.categoryIndex, group.fieldSource || 'obs');
            totalGroupsRestored++;
          } else if (group.type === 'range' && group.fieldIndex != null) {
            state.addHighlightFromRange?.(group.fieldIndex, group.rangeMin, group.rangeMax, group.fieldSource || 'obs');
            totalGroupsRestored++;
          }
        }
      });
    });

    console.log(`[StateSerializer] Restored ${pages.length} pages with ${totalGroupsRestored} highlight groups`);

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

  /**
   * Restore active field selections
   * Handles both obs fields (categorical/continuous) and var fields (gene expression)
   */
  async function restoreActiveFields(activeFields) {
    if (!activeFields) return;

    // First, handle var field (gene expression) if present
    if (activeFields.activeVarFieldKey) {
      const varFields = state.getVarFields?.() || [];
      const varIdx = varFields.findIndex(f => f?.key === activeFields.activeVarFieldKey);
      if (varIdx >= 0) {
        console.log(`[StateSerializer] Activating var field: ${activeFields.activeVarFieldKey} (index: ${varIdx})`);
        await state.ensureVarFieldLoaded?.(varIdx);
        state.setActiveVarField?.(varIdx);

        // Update gene expression search UI
        const geneSearch = document.getElementById('gene-expression-search');
        const geneSelected = document.getElementById('gene-expression-selected');
        if (geneSearch) {
          geneSearch.value = activeFields.activeVarFieldKey;
        }
        if (geneSelected) {
          geneSelected.textContent = activeFields.activeVarFieldKey;
          geneSelected.style.display = 'block';
        }
      }
    }

    // Then handle obs field
    if (activeFields.activeFieldKey && activeFields.activeFieldSource === 'obs') {
      const fields = state.getFields?.() || [];
      const idx = fields.findIndex(f => f?.key === activeFields.activeFieldKey);

      if (idx >= 0) {
        const field = fields[idx];
        console.log(`[StateSerializer] Activating obs field: ${field?.key} (index: ${idx})`);

        // Ensure field data is loaded first
        await state.ensureFieldLoaded?.(idx);
        state.setActiveField?.(idx);

        // Update UI selects to match and trigger change event for proper UI update
        if (field) {
          const selectId = field.kind === 'category' ? 'categorical-field' : 'continuous-field';
          const select = document.getElementById(selectId);
          if (select) {
            // Clear the other select first
            const otherSelectId = field.kind === 'category' ? 'continuous-field' : 'categorical-field';
            const otherSelect = document.getElementById(otherSelectId);
            if (otherSelect) {
              otherSelect.value = '-1';
            }
            // Set and trigger change on the active select
            select.value = String(idx);
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      } else {
        console.warn(`[StateSerializer] Obs field not found: ${activeFields.activeFieldKey}`);
      }
    } else if (activeFields.activeFieldSource === 'var' && activeFields.activeFieldKey) {
      // Active field is a var field (gene) - handled above, but also activate it as primary
      const varFields = state.getVarFields?.() || [];
      const varIdx = varFields.findIndex(f => f?.key === activeFields.activeFieldKey);
      if (varIdx >= 0) {
        console.log(`[StateSerializer] Activating var field as primary: ${activeFields.activeFieldKey}`);
        await state.ensureVarFieldLoaded?.(varIdx);
        state.setActiveVarField?.(varIdx);
      }
    }
  }

  function pushViewerState() {
    if (state.updateOutlierQuantiles) state.updateOutlierQuantiles();
    if (state.computeGlobalVisibility) state.computeGlobalVisibility();
    if (state._pushColorsToViewer) state._pushColorsToViewer();
    if (state._pushTransparencyToViewer) state._pushTransparencyToViewer();
    if (state._pushOutliersToViewer) state._pushOutliersToViewer();
    if (state._pushCentroidsToViewer) state._pushCentroidsToViewer();
    if (state._pushOutlierThresholdToViewer && state.getCurrentOutlierThreshold) {
      state._pushOutlierThresholdToViewer(state.getCurrentOutlierThreshold());
    }
  }

  /**
   * Sync field select dropdowns to match the current active field in state
   * This ensures the UI reflects the active field without triggering change events
   */
  function syncFieldSelectsToActiveField() {
    const activeField = state.getActiveField?.();
    const activeFieldSource = state.activeFieldSource;
    const fields = state.getFields?.() || [];

    const categoricalSelect = document.getElementById('categorical-field');
    const continuousSelect = document.getElementById('continuous-field');
    const geneSearch = document.getElementById('gene-expression-search');
    const geneSelected = document.getElementById('gene-expression-selected');

    if (!activeField) {
      // No active field - clear all selects
      if (categoricalSelect) categoricalSelect.value = '-1';
      if (continuousSelect) continuousSelect.value = '-1';
      if (geneSearch) geneSearch.value = '';
      if (geneSelected) geneSelected.style.display = 'none';
      return;
    }

    if (activeFieldSource === 'var') {
      // Gene expression field is active
      if (categoricalSelect) categoricalSelect.value = '-1';
      if (continuousSelect) continuousSelect.value = '-1';
      if (geneSearch) geneSearch.value = activeField.key || '';
      if (geneSelected) {
        geneSelected.textContent = activeField.key || '';
        geneSelected.style.display = 'block';
      }
    } else {
      // Obs field is active
      const fieldIndex = fields.findIndex(f => f?.key === activeField.key);
      if (activeField.kind === 'category') {
        if (categoricalSelect) categoricalSelect.value = String(fieldIndex);
        if (continuousSelect) continuousSelect.value = '-1';
      } else if (activeField.kind === 'continuous') {
        if (categoricalSelect) categoricalSelect.value = '-1';
        if (continuousSelect) continuousSelect.value = String(fieldIndex);
      }
      if (geneSearch) geneSearch.value = '';
      if (geneSelected) geneSelected.style.display = 'none';
    }
  }

  /**
   * Restore multiview snapshots and layout
   * Replays each saved snapshot by reapplying its filters/active fields and freezing a view
   */
  async function restoreMultiview(multiview) {
    if (!multiview) return;

    // Start clean
    if (viewer.clearSnapshotViews) viewer.clearSnapshotViews();
    if (state.clearSnapshotViews) state.clearSnapshotViews();

    // Ensure current live state is fully synced before cloning it
    pushViewerState();

    const baseContext = state.captureCurrentContext ? state.captureCurrentContext() : null;
    const idMap = new Map();
    const snapshots = multiview.snapshots || [];

    for (const snap of snapshots) {
      // Reset to the base live state before applying this snapshot
      if (baseContext && state.restoreContext) {
        state.restoreContext(baseContext);
      }

      if (snap.filters) {
        const { restored } = await restoreFilters(snap.filters);
        if (restored > 0) {
          console.log(`[StateSerializer] Restored ${restored} filter${restored === 1 ? '' : 's'} for snapshot ${snap.label || snap.id}`);
        }
      }
      if (snap.activeFields) {
        await restoreActiveFields(snap.activeFields);
      }

      pushViewerState();

      // Build snapshot payload (allow overriding with saved arrays for exact match)
      const payload = state.getSnapshotPayload ? state.getSnapshotPayload() : {};
      const config = {
        ...payload,
        label: snap.label || payload.label,
        fieldKey: snap.fieldKey ?? payload.fieldKey,
        fieldKind: snap.fieldKind ?? payload.fieldKind,
        meta: snap.meta || payload.meta
      };
      if (snap.colors) config.colors = new Uint8Array(snap.colors);
      if (snap.transparency) config.transparency = new Float32Array(snap.transparency);
      if (snap.outlierQuantiles) config.outlierQuantiles = new Float32Array(snap.outlierQuantiles);
      if (snap.centroidPositions) config.centroidPositions = new Float32Array(snap.centroidPositions);
      if (snap.centroidColors) config.centroidColors = new Uint8Array(snap.centroidColors);
      if (snap.centroidOutliers) config.centroidOutliers = new Float32Array(snap.centroidOutliers);
      if (typeof snap.outlierThreshold === 'number') config.outlierThreshold = snap.outlierThreshold;

      const created = viewer.createSnapshotView ? viewer.createSnapshotView(config) : null;
      const newId = created?.id;
      if (created?.id && state.createViewFromActive) {
        state.createViewFromActive(created.id);
      }
      if (newId) {
        idMap.set(String(snap.id), String(newId));
      }
    }

    // Restore the original live state
    if (baseContext && state.restoreContext) {
      state.restoreContext(baseContext);
    }

    // Apply layout and active view
    const layout = multiview.layout || { mode: 'single', activeId: 'live' };
    const resolvedActiveId = layout.activeId && idMap.has(String(layout.activeId))
      ? idMap.get(String(layout.activeId))
      : layout.activeId;

    // Restore liveViewHidden state
    if (typeof viewer.setLiveViewHidden === 'function') {
      viewer.setLiveViewHidden(Boolean(layout.liveViewHidden));
    }

    if (viewer.setViewLayout) {
      viewer.setViewLayout(layout.mode, resolvedActiveId);
    }
    if (resolvedActiveId) {
      state.setActiveView?.(resolvedActiveId);
    }
  }

  /**
   * Restore state from a snapshot
   * Comprehensive restoration of all application state
   */
  async function deserialize(snapshot, options = {}) {
    if (!snapshot) return;

    console.log('[StateSerializer] Restoring state from snapshot:', snapshot.timestamp);

    // Version check
    if (snapshot.version && snapshot.version > VERSION) {
      console.warn(`State snapshot version ${snapshot.version} is newer than supported ${VERSION}`);
    }

    // Check data source compatibility
    if (snapshot.dataSource) {
      const dataSourceManager = getDataSourceManager();
      const currentSource = dataSourceManager?.getStateSnapshot();

      if (currentSource?.sourceType !== snapshot.dataSource.sourceType ||
          currentSource?.datasetId !== snapshot.dataSource.datasetId) {
        console.warn(
          `[StateSerializer] State was saved with dataset '${snapshot.dataSource.datasetId}' ` +
          `(${snapshot.dataSource.sourceType}) but current dataset is '${currentSource?.datasetId}' ` +
          `(${currentSource?.sourceType}). Some state may not restore correctly.`
        );

        // If user path is stored, log it for reference
        if (snapshot.dataSource.userPath) {
          console.log(`[StateSerializer] Original user data path: ${snapshot.dataSource.userPath}`);
        }
      }
    }

    const controls = snapshot.uiControls || {};

    // 1. Restore UI controls first (checkboxes, selects, ranges)
    // Special IDs are automatically skipped by restoreUIControls
    console.log('[StateSerializer] Restoring UI controls (count: ' + Object.keys(controls).length + ')');
    restoreUIControls(controls);

    // 2. Restore filters (field-level filter settings)
    if (snapshot.filters) {
      const { restored, skippedNoop } = await restoreFilters(snapshot.filters);
      if (restored > 0) {
        console.log(`[StateSerializer] Restored filters (${restored} field${restored === 1 ? '' : 's'}${skippedNoop ? `, skipped ${skippedNoop} no-op` : ''})`);
      } else if (skippedNoop > 0) {
        console.log(`[StateSerializer] No filter changes to restore (skipped ${skippedNoop} no-op entries)`);
      }
    }

    // 3. Restore active fields and update field selects
    if (snapshot.activeFields) {
      console.log('[StateSerializer] Restoring active fields:', snapshot.activeFields);
      await restoreActiveFields(snapshot.activeFields);
    }

    // 3b. Sync outlier filter slider to active field's threshold (AFTER active field is set)
    const activeField = state.getActiveField?.();
    if (activeField && activeField.outlierQuantiles?.length > 0) {
      const outlierSlider = document.getElementById('outlier-filter');
      const outlierDisplay = document.getElementById('outlier-filter-display');
      if (outlierSlider) {
        const pct = Math.round((activeField._outlierThreshold ?? 1.0) * 100);
        outlierSlider.value = String(pct);
        if (outlierDisplay) {
          outlierDisplay.textContent = pct + '%';
        }
      }
    }

    // 3c. Sync field select dropdowns to match active field
    syncFieldSelectsToActiveField();

    // 4. Restore highlight pages (AFTER fields so cellIndices make sense)
    if (snapshot.highlightPages && snapshot.highlightPages.length > 0) {
      console.log('[StateSerializer] Restoring highlight pages (count: ' + snapshot.highlightPages.length + ')');
      restoreHighlightPages(snapshot.highlightPages, { id: snapshot.activePageId, name: snapshot.activePageName });
    }

    // 5. Restore multiview snapshots/layout
    if (snapshot.multiview) {
      console.log('[StateSerializer] Restoring multiview snapshots/layout');
      await restoreMultiview(snapshot.multiview);
    }

    // 6. Restore camera state LAST - this sets navigation mode directly and all camera params
    if (snapshot.camera) {
      console.log('[StateSerializer] Restoring camera:', snapshot.camera);
      viewer.setCameraState?.(snapshot.camera);

      // Update the navigation mode UI to match (without triggering event that would reset camera)
      const navSelect = document.getElementById('navigation-mode');
      if (navSelect && snapshot.camera.navigationMode) {
        navSelect.value = snapshot.camera.navigationMode;
        // Show/hide the right control panels
        const freeflyControls = document.getElementById('freefly-controls');
        const orbitControls = document.getElementById('orbit-controls');
        if (freeflyControls && orbitControls) {
          if (snapshot.camera.navigationMode === 'free') {
            freeflyControls.style.display = 'block';
            orbitControls.style.display = 'none';
          } else {
            freeflyControls.style.display = 'none';
            orbitControls.style.display = 'block';
          }
        }
      }

      // Re-apply camera after a frame to ensure it sticks (in case any async operations reset it)
      requestAnimationFrame(() => {
        viewer.setCameraState?.(snapshot.camera);
      });
    }

    // Final: ensure state + viewer are in sync even if no active field
    pushViewerState();

    // 7. Trigger state updates to refresh display
    console.log('[StateSerializer] Triggering state updates');

    // Notify visibility changes (for filter UI and display)
    if (state._notifyVisibilityChange) {
      state._notifyVisibilityChange();
    }

    // Update filtered count display
    if (state.updateFilteredCount) {
      state.updateFilteredCount();
    }

    // Update filter summary display
    if (state.updateFilterSummary) {
      state.updateFilterSummary();
    }

    // Notify highlight page changes (for highlight page tabs UI)
    if (state._notifyHighlightPageChange) {
      state._notifyHighlightPageChange();
    }

    // Notify highlight changes (for highlight list UI)
    if (state._notifyHighlightChange) {
      state._notifyHighlightChange();
    }

    // Force push colors to viewer to reflect filter/colormap changes
    if (state._pushColorsToViewer) {
      state._pushColorsToViewer();
    }

    console.log('[StateSerializer] Restore complete');
  }

  /**
   * Download state as JSON file
   */
  function downloadState(filename = 'cellucid-state.json') {
    const snapshot = serialize();
    const json = JSON.stringify(snapshot, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Load state from JSON file
   * @returns {Promise<void>}
   */
  function loadStateFromFile() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';

      input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) {
          resolve();
          return;
        }

        try {
          const text = await file.text();
          const snapshot = JSON.parse(text);
          validateSnapshotShape(snapshot, file.name || 'uploaded file');
          await deserialize(snapshot);
          resolve();
        } catch (err) {
          console.error('Failed to load state:', err);
          reject(err);
        }
      };

      input.click();
    });
  }

  /**
   * Load state from a URL (for automatic session restore)
   * @param {string} url - Absolute or relative URL to a JSON snapshot
   * @returns {Promise<void>}
   */
  async function loadStateFromUrl(url) {
    if (!url) throw new Error('State URL is required');
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch state from ${url} (${response.status} ${response.statusText})`);
    }
    const snapshot = await response.json();
    validateSnapshotShape(snapshot, url);
    await deserialize(snapshot);
  }

  return {
    serialize,
    deserialize,
    downloadState,
    loadStateFromFile,
    loadStateFromUrl,
    collectUIControls,
    restoreUIControls
  };
}
