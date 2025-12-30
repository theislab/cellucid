/**
 * @fileoverview UI control save/restore helpers for session bundles.
 *
 * This module is intentionally DOM-focused and does not depend on DataState
 * internals. It is used by the SessionSerializer eager stage to capture/restore
 * lightweight sidebar + floating panel UI inputs in a generic way.
 *
 * @module state-serializer/ui-controls
 */

function getUiRoots(sidebar) {
  const roots = [];
  if (sidebar) roots.push(sidebar);
  const floatingRoot = document.getElementById('floating-panels-root');
  if (floatingRoot) roots.push(floatingRoot);
  return roots;
}

function queryAll(sidebar, selector) {
  const roots = getUiRoots(sidebar);
  const out = [];
  for (const root of roots) {
    out.push(...root.querySelectorAll(selector));
  }
  return out;
}

/**
 * Skip ephemeral UI subtrees from session bundle capture/restore.
 * Used for floating, copy-only panels that should not be serialized.
 * @param {Element|null} el
 * @returns {boolean}
 */
function isStateSerializerSkipped(el) {
  if (!el) return false;
  return !!el.closest?.('[data-state-serializer-skip]');
}

// IDs that should be skipped during general restoration (handled specially or
// intentionally excluded from session bundles).
const SPECIAL_IDS = new Set([
  'navigation-mode', // Camera-related, handled separately
  'categorical-field', // Dynamically populated, handled via activeFields
  'continuous-field', // Dynamically populated, handled via activeFields
  'outlier-filter', // Per-field state, restored after active field is set
  'gene-expression-search', // Restored via activeFields
  'dimension-select', // Restored explicitly by core-state (avoid async handler races)
  'dataset-select', // Not part of session state (dataset assumed already loaded)
  'remote-server-url', // Connection UI only; not session state
  'github-repo-url', // Connection UI only; not session state
]);

function restoreSingleControl(id, data, options = {}) {
  // NOTE: We keep this helper resilient to dynamic UIs. Some selects are
  // populated asynchronously (e.g., after dataset metadata arrives). The
  // restore logic retries setting select values for a short period to avoid
  // noisy warnings and to improve fidelity.
  if (!data) return;
  const abortSignal = options.abortSignal || null;
  const el = document.getElementById(id);
  if (!el) {
    console.warn(`[SessionSerializer] Control not found: ${id}`);
    return;
  }
  if (isStateSerializerSkipped(el)) return;

  try {
    if (data.type === 'checkbox' && el.type === 'checkbox') {
      // Avoid dispatching change events if state is already in sync (saves expensive recomputations)
      if (el.checked !== data.checked) {
        el.checked = data.checked;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else if (data.type === 'select' && el.tagName === 'SELECT') {
      const nextValue = data.value ?? '';
      const stringValue = String(nextValue);

      // Empty string is commonly used by placeholder options (or by selects that
      // haven't been populated yet). Treat it as "no-op" unless the option
      // actually exists.
      if (stringValue === '') {
        const hasEmptyOption = Array.from(el.options).some(opt => opt.value === '');
        if (hasEmptyOption && el.value !== '') {
          el.value = '';
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return;
      }

      const optionExists = Array.from(el.options).some(opt => opt.value === stringValue);
      if (optionExists) {
        if (el.value !== stringValue) {
          el.value = stringValue;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return;
      }

      // If the option isn't present yet, the select may be dynamically
      // populated. Defer a few retries instead of warning immediately.
      const maxAttempts = 30;
      const delayMs = 100;
      let attempt = 0;

      const retry = () => {
        if (abortSignal?.aborted) return;
        attempt += 1;
        const current = document.getElementById(id);
        if (!current || current.tagName !== 'SELECT') return;

        const exists = Array.from(current.options).some(opt => opt.value === stringValue);
        if (exists) {
          if (current.value !== stringValue) {
            current.value = stringValue;
            current.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return;
        }

        if (attempt >= maxAttempts) {
          console.warn(`[SessionSerializer] Option '${stringValue}' not found in select '${id}'`);
          return;
        }

        setTimeout(retry, delayMs);
      };

      if (!abortSignal?.aborted) setTimeout(retry, 0);
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
    console.error(`[SessionSerializer] Error restoring control '${id}':`, err);
  }
}

export function createUiControlSerializer({ sidebar }) {
  /**
   * Dynamically collect all UI control values from the sidebar.
   * Uses element IDs as keys for restoration.
   */
  function collectUIControls() {
    const controls = {};

    queryAll(sidebar, 'input[id]').forEach(input => {
      if (isStateSerializerSkipped(input)) return;
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

    queryAll(sidebar, 'select[id]').forEach(select => {
      if (isStateSerializerSkipped(select)) return;
      controls[select.id] = { type: 'select', value: select.value };
    });

    queryAll(sidebar, 'details.accordion-section').forEach(details => {
      if (isStateSerializerSkipped(details)) return;
      const summary = details.querySelector('summary');
      const key = summary?.textContent?.trim() || details.id;
      if (key) {
        controls[`accordion:${key}`] = { type: 'details', open: details.open };
      }
    });

    return controls;
  }

  /**
   * Restore UI controls from saved state.
   * @param {Object} controls - Saved control values
   * @param {{ skipIds?: Set<string>, abortSignal?: AbortSignal | null }} [options]
   */
  function restoreUIControls(controls, options = {}) {
    if (!controls) return;

    const skipIds = options.skipIds instanceof Set ? options.skipIds : new Set();
    const abortSignal = options.abortSignal || null;
    const allSkipIds = new Set([...SPECIAL_IDS, ...skipIds]);

    // First pass: restore accordions
    Object.entries(controls).forEach(([id, data]) => {
      if (!id.startsWith('accordion:')) return;
      const key = id.replace('accordion:', '');
      queryAll(sidebar, 'details.accordion-section').forEach(details => {
        if (isStateSerializerSkipped(details)) return;
        const summary = details.querySelector('summary');
        const summaryText = summary?.textContent?.trim();
        if (summaryText === key || details.id === key) {
          details.open = data.open;
        }
      });
    });

    // Second pass: restore controls in order (checkboxes first, then selects, then ranges)
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

    [...checkboxes, ...selects, ...ranges, ...others].forEach(([id, data]) => {
      restoreSingleControl(id, data, { abortSignal });
    });
  }

  return { collectUIControls, restoreUIControls };
}
