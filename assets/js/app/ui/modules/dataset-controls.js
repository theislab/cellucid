/**
 * @fileoverview Dataset selection and data-source connection UI.
 *
 * Handles:
 * - Dataset dropdown + metadata panel
 * - Local user data (prepared, h5ad, zarr)
 * - Remote server connect/disconnect
 * - GitHub repo connect/disconnect
 *
 * This module is UI-only and calls back into the coordinator for dataset-wide
 * refresh hooks (field dropdowns, gene search, dimension options, etc.).
 *
 * @module ui/modules/dataset-controls
 */

import { formatCellCount as formatDataNumber } from '../../../data/data-source.js';
import { getNotificationCenter } from '../../notification-center.js';
import { updateUrlForDataSource } from '../../url-state.js';
import { DATA_LOAD_METHODS } from '../../../analytics/tracker.js';
import { debug } from '../../utils/debug.js';
import { initDatasetConnections } from './dataset-connections.js';

export function initDatasetControls({
  state,
  viewer,
  dom,
  dataSourceManager,
  reloadDataset,
  callbacks = {}
}) {
  const {
    renderFieldSelects,
    renderDeletedFieldsSection,
    initGeneExpressionDropdown,
    clearGeneSelection,
    refreshUIForActiveView,
    updateDimensionSelectUI,
    showSessionStatus: showSessionStatusCallback
  } = callbacks;

  const showSessionStatus =
    typeof showSessionStatusCallback === 'function'
      ? showSessionStatusCallback
      : (message, isError = false) => {
          const notifications = getNotificationCenter();
          if (isError) {
            notifications.error(message, { category: 'session' });
          } else {
            notifications.success(message, { category: 'session' });
          }
        };

  const {
    select: datasetSelect,
    info: datasetInfo,
    nameEl: datasetNameEl,
    sourceEl: datasetSourceEl,
    descriptionEl: datasetDescriptionEl,
    urlEl: datasetUrlEl,
    cellsEl: datasetCellsEl,
    genesEl: datasetGenesEl,
    obsEl: datasetObsEl,
    connectivityEl: datasetConnectivityEl,
  } = dom || {};

  const NONE_DATASET_VALUE = '__none__';


// =========================================================================
// Dataset Selector
// =========================================================================

/**
 * Update the dataset info display
 * @param {Object|null} metadata - Dataset metadata
 */
function updateDatasetInfo(metadata, sourceTypeOverride = null) {
  if (!datasetInfo || !datasetCellsEl || !datasetGenesEl) return;

  const resetValues = () => {
    if (datasetNameEl) datasetNameEl.textContent = '—';
    if (datasetSourceEl) datasetSourceEl.textContent = '—';
    if (datasetDescriptionEl) {
      datasetDescriptionEl.textContent = '—';
      datasetDescriptionEl.title = '—';
    }
    if (datasetUrlEl) {
      datasetUrlEl.textContent = '—';
      datasetUrlEl.title = '—';
    }
    datasetCellsEl.textContent = '–';
    datasetGenesEl.textContent = '–';
    if (datasetObsEl) datasetObsEl.textContent = '–';
    if (datasetConnectivityEl) datasetConnectivityEl.textContent = '–';
    datasetInfo.classList.remove('loading', 'error');
  };

  if (!metadata) {
    resetValues();
    return;
  }

  const stats = metadata.stats || {};
  const sourceTypeLabel = (sourceTypeOverride || dataSourceManager?.getCurrentSourceType?.() || 'demo')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  // Prefer dataset's own source name (from dataset_identity.json).
  // Only fall back to the source-type label (e.g., "Local Demo")
  // if the dataset source name is missing or empty.
  const sourceName = (metadata.source?.name || '').trim();
  const sourceLabel = sourceName || sourceTypeLabel;

  if (datasetNameEl) datasetNameEl.textContent = metadata.name || metadata.id || 'Dataset';
  if (datasetSourceEl) datasetSourceEl.textContent = sourceLabel;
  if (datasetDescriptionEl) {
    const desc = metadata.description || '—';
    datasetDescriptionEl.textContent = desc;
    datasetDescriptionEl.title = desc;
  }
  if (datasetUrlEl) {
    const url = metadata.source?.url || metadata.url || '—';
    datasetUrlEl.textContent = url;
    datasetUrlEl.title = url;
  }
  datasetCellsEl.textContent = formatDataNumber(stats.n_cells);
  datasetGenesEl.textContent = formatDataNumber(stats.n_genes);
  if (datasetObsEl) datasetObsEl.textContent = formatDataNumber(stats.n_obs_fields);
  if (datasetConnectivityEl) {
    if (stats.has_connectivity) {
      const edgeText = stats.n_edges ? `${formatDataNumber(stats.n_edges)} edges` : 'Available';
      datasetConnectivityEl.textContent = edgeText;
    } else {
      datasetConnectivityEl.textContent = 'None';
    }
  }
  datasetInfo.classList.remove('loading', 'error');
}

/**
 * Refresh dataset-aware UI (field dropdowns, gene search, info panel, dimension controls)
 * @param {Object|null} metadata - Dataset metadata
 */
function refreshDatasetUI(metadata) {
  renderFieldSelects();
  renderDeletedFieldsSection();
  initGeneExpressionDropdown();
  clearGeneSelection();
  refreshUIForActiveView();
  updateDatasetInfo(metadata || (dataSourceManager?.getCurrentMetadata?.() || null));
  // Update dimension dropdown when dataset changes (different datasets may have different available dimensions)
  updateDimensionSelectUI();
}

/**
 * Populate the dataset dropdown with available datasets from all sources
 */
async function populateDatasetDropdown() {
  debug.log('[UI] populateDatasetDropdown called', { datasetSelect, dataSourceManager });

  if (!datasetSelect) {
    debug.warn('[UI] Dataset select element not found');
    return;
  }
  if (!dataSourceManager) {
    debug.warn('[UI] DataSourceManager not provided');
    datasetSelect.innerHTML = '<option value="" disabled>Manager not available</option>';
    return;
  }

  datasetSelect.innerHTML = '<option value="" disabled>Loading...</option>';

  try {
    debug.log('[UI] Calling getAllDatasets...');

    // Add timeout to detect hanging
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout: getAllDatasets took more than 10s')), 10000)
    );

    // Get datasets from all sources (with timeout)
    const allSourceDatasets = await Promise.race([
      dataSourceManager.getAllDatasets(),
      timeoutPromise
    ]);

    debug.log('[UI] getAllDatasets returned:', allSourceDatasets);

    // Flatten and collect all datasets with their source type
    const allDatasets = [];
    for (const { sourceType, datasets } of allSourceDatasets) {
      for (const dataset of datasets) {
        allDatasets.push({ ...dataset, sourceType });
      }
    }

    datasetSelect.innerHTML = '';

    const addNoneOption = () => {
      const noneOption = document.createElement('option');
      noneOption.value = NONE_DATASET_VALUE;
      noneOption.textContent = 'None';
      datasetSelect.appendChild(noneOption);
      return noneOption;
    };

    addNoneOption();

    if (allDatasets.length === 0) {
      const emptyMsg = document.createElement('option');
      emptyMsg.value = '';
      emptyMsg.disabled = true;
      emptyMsg.textContent = 'No datasets found';
      datasetSelect.appendChild(emptyMsg);
      datasetSelect.value = NONE_DATASET_VALUE;
      updateDatasetInfo(null);
      return;
    }

    // Group by source type if there are multiple sources with data
    const sourcesWithData = allSourceDatasets.filter(s => s.datasets.length > 0);
    const useGroups = sourcesWithData.length > 1;

    if (useGroups) {
      // Create optgroups for each source
      for (const { sourceType, datasets } of sourcesWithData) {
        const group = document.createElement('optgroup');
        group.label = sourceType === 'local-demo' ? 'Demo Datasets' :
                      sourceType === 'local-user' ? 'Your Data' :
                      sourceType;

        for (const dataset of datasets) {
          const option = document.createElement('option');
          option.value = dataset.id;
          option.dataset.sourceType = sourceType;
          const cellCount = dataset.stats?.n_cells ? ` (${formatDataNumber(dataset.stats.n_cells)} cells)` : '';
          option.textContent = `${dataset.name}${cellCount}`;
          group.appendChild(option);
        }

        datasetSelect.appendChild(group);
      }
    } else {
      // Simple flat list
      for (const dataset of allDatasets) {
        const option = document.createElement('option');
        option.value = dataset.id;
        option.dataset.sourceType = dataset.sourceType;
        const cellCount = dataset.stats?.n_cells ? ` (${formatDataNumber(dataset.stats.n_cells)} cells)` : '';
        option.textContent = `${dataset.name}${cellCount}`;
        datasetSelect.appendChild(option);
      }
    }

    // Select the current dataset if any; fall back to None
    const currentId = dataSourceManager.getCurrentDatasetId();
    if (currentId) {
      datasetSelect.value = currentId;
      updateDatasetInfo(dataSourceManager.getCurrentMetadata());
    } else if (datasetSelect.querySelector(`option[value=\"${NONE_DATASET_VALUE}\"]`)) {
      datasetSelect.value = NONE_DATASET_VALUE;
      updateDatasetInfo(null);
    }
  } catch (err) {
    debug.error('[UI] Failed to populate dataset dropdown:', err);
    datasetSelect.innerHTML = '<option value="" disabled>Error loading datasets</option>';
  }
}

/**
 * Handle dataset selection change - reloads page with new dataset
 * @param {string} datasetId - The selected dataset ID
 * @param {string} [sourceType='local-demo'] - The source type for the dataset
 */
async function handleDatasetChange(datasetId, sourceType = 'local-demo') {
  if (!dataSourceManager || !datasetId) return;

  // Check if this is already the current dataset
  const currentId = dataSourceManager.getCurrentDatasetId();
  const currentSourceType = dataSourceManager.getCurrentSourceType();
  if (currentId === datasetId && currentSourceType === sourceType) {
    return; // No change needed
  }

  try {
    if (datasetInfo) {
      datasetInfo.classList.add('loading');
      datasetCellsEl.textContent = '...';
      datasetGenesEl.textContent = '...';
    }

    showSessionStatus('Switching dataset...', false);

    await dataSourceManager.switchToDataset(sourceType, datasetId, {
      loadMethod: DATA_LOAD_METHODS.DATASET_DROPDOWN
    });

    // Local-user datasets must be loaded in-place to keep file handles alive
    if (sourceType === 'local-user') {
      if (typeof reloadDataset === 'function') {
        await reloadDataset(dataSourceManager.getCurrentMetadata?.());
      }
      showSessionStatus('Dataset loaded', false);
      return;
    }

    // Update URL and reload for server-hosted sources
    // Use updateUrlForDataSource to ensure other params (remote, github) are cleared
    updateUrlForDataSource('local-demo', { datasetId });

    // Small delay to show the status message before reload
    setTimeout(() => {
      window.location.reload();
    }, 100);

  } catch (err) {
    debug.error('[UI] Failed to switch dataset:', err);
    if (datasetInfo) datasetInfo.classList.add('error');
    showSessionStatus(`Failed to switch dataset: ${err.message}`, true);
  }
}

/**
 * Handle selecting the "None" dataset option - clear data and UI state
 */
function handleNoneDatasetSelection() {
  if (typeof dataSourceManager?.clearActiveDataset === 'function') {
    dataSourceManager.clearActiveDataset();
  }

  // Clear data/state
  if (state?.initScene) {
    state.setFieldLoader?.(null);
    state.setVarFieldLoader?.(null);
    state.varData = null;
    state.initScene(new Float32Array(), { fields: [], count: 0 });
    state.clearActiveField?.();
    state.clearAllHighlights?.();
    state.clearSnapshotViews?.();
  }
  if (typeof viewer?.clearSnapshotViews === 'function') {
    viewer.clearSnapshotViews();
  }
  if (typeof viewer?.updateHighlight === 'function') {
    viewer.updateHighlight(new Uint8Array());
  }

  // Reset UI affordances
  refreshDatasetUI(null);
  if (datasetSelect) {
    datasetSelect.value = NONE_DATASET_VALUE;
  }
  showSessionStatus('No dataset selected', false);
}

// Initialize dataset selector
debug.log('[UI] Dataset selector initialization:', {
  datasetSelect: !!datasetSelect,
  dataSourceManager: !!dataSourceManager,
  datasetInfo: !!datasetInfo,
  hasUserDataControls: Boolean(dom?.userDataBlock),
  hasRemoteControls: Boolean(dom?.remoteConnectBtn),
  hasGithubControls: Boolean(dom?.githubConnectBtn)
});


if (datasetSelect && dataSourceManager) {
  // Populate dropdown
  populateDatasetDropdown();

  // Keep dropdown in sync with source changes and dataset switches
  if (typeof dataSourceManager.onSourcesChange === 'function') {
    dataSourceManager.onSourcesChange(() => {
      populateDatasetDropdown();
    });
  }
  if (typeof dataSourceManager.onDatasetChange === 'function') {
    dataSourceManager.onDatasetChange((event) => {
      try {
        if (datasetSelect) {
          if (event?.datasetId) {
            datasetSelect.value = event.datasetId;
          } else if (datasetSelect.querySelector(`option[value=\"${NONE_DATASET_VALUE}\"]`)) {
            datasetSelect.value = NONE_DATASET_VALUE;
          }
        }
      } catch (_) {
        /* ignore */
      }
      updateDatasetInfo(event?.metadata || null, event?.sourceType || null);
    });
  }

  // Handle selection changes
  datasetSelect.addEventListener('change', (e) => {
    const selectedValue = e.target.value;
    if (selectedValue === NONE_DATASET_VALUE) {
      handleNoneDatasetSelection();
      return;
    }
    const selectedOption = e.target.selectedOptions[0];
    const sourceType = selectedOption?.dataset?.sourceType || 'local-demo';
    handleDatasetChange(selectedValue, sourceType);
  });
} else {
  debug.warn('[UI] Dataset selector not initialized - missing elements:', {
    datasetSelect: datasetSelect,
    dataSourceManager: dataSourceManager
  });
}
  initDatasetConnections({
    state,
    viewer,
    dom,
    dataSourceManager,
    reloadDataset,
    showSessionStatus,
    updateDatasetInfo,
    populateDatasetDropdown,
    noneDatasetValue: NONE_DATASET_VALUE
  });

  return { refreshDatasetUI };
}
