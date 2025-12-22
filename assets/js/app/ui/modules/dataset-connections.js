/**
 * @fileoverview Dataset connection controls.
 *
 * Encapsulates dataset-adjacent connection UX that is orthogonal to the dataset
 * dropdown itself:
 * - Local user data loading (prepared exports, h5ad, zarr)
 * - Remote server connect/disconnect
 * - GitHub repo connect/disconnect
 * - Info tooltips for the above
 *
 * Split out of `dataset-controls.js` to keep module responsibilities and file
 * size manageable while preserving runtime behavior.
 *
 * @module ui/modules/dataset-connections
 */

import { formatCellCount as formatDataNumber } from '../../../data/data-source.js';
import { getNotificationCenter } from '../../notification-center.js';
import { updateUrlForDataSource, clearUrlDataSource } from '../../url-state.js';
import { DATA_LOAD_METHODS } from '../../../analytics/tracker.js';
import { debug } from '../../utils/debug.js';

/**
 * @param {object} options
 * @param {object} options.state
 * @param {object} options.viewer
 * @param {object} options.dom
 * @param {import('../../../data/data-source-manager.js').DataSourceManager|null} options.dataSourceManager
 * @param {(metadata: any) => Promise<void> | void} [options.reloadDataset]
 * @param {(message: string, isError?: boolean) => void} [options.showSessionStatus]
 * @param {(metadata: any, sourceTypeOverride?: string|null) => void} [options.updateDatasetInfo]
 * @param {() => Promise<void> | void} [options.populateDatasetDropdown]
 * @param {string} options.noneDatasetValue
 */
export function initDatasetConnections({
  state,
  viewer,
  dom,
  dataSourceManager,
  reloadDataset,
  showSessionStatus,
  updateDatasetInfo,
  populateDatasetDropdown,
  noneDatasetValue
}) {
  if (!dom || !dataSourceManager) return;

  const {
    select: datasetSelect,

    userDataH5adBtn,
    userDataZarrBtn,
    userDataBrowseBtn,
    userDataFileInput,
    userDataH5adInput,
    userDataZarrInput,
    userDataInfoBtn,
    userDataInfoTooltip,

    remoteServerUrl,
    remoteConnectBtn,
    remoteDisconnectBtn,
    remoteDisconnectContainer,
    remoteInfoBtn,
    remoteInfoTooltip,

    githubRepoUrl,
    githubConnectBtn,
    githubDisconnectBtn,
    githubDisconnectContainer,
    githubInfoBtn,
    githubInfoTooltip
  } = dom;

  const populate = () => {
    if (typeof populateDatasetDropdown === 'function') {
      try {
        populateDatasetDropdown();
      } catch (err) {
        debug.warn('[UI] populateDatasetDropdown failed:', err);
      }
    }
  };

  const showStatus =
    typeof showSessionStatus === 'function'
      ? showSessionStatus
      : (message, isError = false) => {
          const notifications = getNotificationCenter();
          if (isError) notifications.error(message, { category: 'session' });
          else notifications.success(message, { category: 'session' });
        };

  async function loadLocalUserFromFileList(files, { loadMethod, loadingMessage }) {
    if (!files || files.length === 0) return;

    const userSource = dataSourceManager.getSource('local-user');
    if (!userSource) {
      showStatus('User data source not available', true);
      return;
    }

    const notifications = getNotificationCenter();
    const loadNotifId = notifications.loading(loadingMessage, { category: 'data' });

    try {
      const metadata = await userSource.loadFromFileList(files);
      updateDatasetInfo?.(metadata || null);

      if (datasetSelect && noneDatasetValue) {
        datasetSelect.value = noneDatasetValue;
      }

      try {
        await dataSourceManager.switchToDataset('local-user', userSource.datasetId, { loadMethod });
        if (typeof reloadDataset === 'function') {
          await reloadDataset(metadata);
        }
        populate();
        notifications.complete(
          loadNotifId,
          `User data ready: ${formatDataNumber(metadata?.stats?.n_cells)} cells`
        );
        clearUrlDataSource();
      } catch (switchErr) {
        debug.warn('[UI] Could not auto-switch to user source:', switchErr);
        notifications.complete(loadNotifId, 'User data validated. Select "Load" to apply.');
        clearUrlDataSource();
      }
    } catch (err) {
      debug.error('[UI] Failed to load user data:', err);
      notifications.fail(loadNotifId, err?.getUserMessage?.() || err?.message || 'Failed to load');
    }
  }

  // ---------------------------------------------------------------------------
  // Local user data (prepared / h5ad / zarr)
  // ---------------------------------------------------------------------------

  if (userDataFileInput) {
    userDataFileInput.addEventListener('change', async (e) => {
      await loadLocalUserFromFileList(e.target.files, {
        loadMethod: DATA_LOAD_METHODS.LOCAL_PREPARED,
        loadingMessage: 'Loading user data files...'
      });
      userDataFileInput.value = '';
    });
  }

  if (userDataH5adBtn && userDataH5adInput) {
    userDataH5adBtn.addEventListener('click', () => userDataH5adInput.click());
  }
  if (userDataZarrBtn && userDataZarrInput) {
    userDataZarrBtn.addEventListener('click', () => userDataZarrInput.click());
  }
  if (userDataBrowseBtn && userDataFileInput) {
    userDataBrowseBtn.addEventListener('click', () => userDataFileInput.click());
  }

  if (userDataH5adInput) {
    userDataH5adInput.addEventListener('change', async (e) => {
      await loadLocalUserFromFileList(e.target.files, {
        loadMethod: DATA_LOAD_METHODS.LOCAL_H5AD,
        loadingMessage: 'Loading h5ad file...'
      });
      userDataH5adInput.value = '';
    });
  }

  if (userDataZarrInput) {
    userDataZarrInput.addEventListener('change', async (e) => {
      await loadLocalUserFromFileList(e.target.files, {
        loadMethod: DATA_LOAD_METHODS.LOCAL_ZARR,
        loadingMessage: 'Loading zarr directory...'
      });
      userDataZarrInput.value = '';
    });
  }

  // ---------------------------------------------------------------------------
  // Tooltips (user data / remote / github)
  // ---------------------------------------------------------------------------

  function attachTooltipToggle(button, tooltip) {
    if (!button || !tooltip) return;
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = getComputedStyle(tooltip).display !== 'none';
      tooltip.style.display = isVisible ? 'none' : 'block';
    });
  }

  attachTooltipToggle(userDataInfoBtn, userDataInfoTooltip);
  attachTooltipToggle(remoteInfoBtn, remoteInfoTooltip);
  attachTooltipToggle(githubInfoBtn, githubInfoTooltip);

  document.addEventListener('click', (e) => {
    const closeIfOutside = (btn, tip) => {
      if (!btn || !tip) return;
      if (btn.contains(e.target) || tip.contains(e.target)) return;
      tip.style.display = 'none';
    };

    closeIfOutside(userDataInfoBtn, userDataInfoTooltip);
    closeIfOutside(remoteInfoBtn, remoteInfoTooltip);
    closeIfOutside(githubInfoBtn, githubInfoTooltip);
  });

  // ---------------------------------------------------------------------------
  // Remote server connection
  // ---------------------------------------------------------------------------

  if (remoteConnectBtn && remoteServerUrl) {
    const remoteSource = dataSourceManager.getSource('remote');

    const updateRemoteUI = (connected) => {
      remoteConnectBtn.textContent = connected ? 'Reconnect' : 'Connect';
      if (remoteDisconnectContainer) remoteDisconnectContainer.style.display = connected ? 'flex' : 'none';
      remoteServerUrl.disabled = connected;
    };

    remoteConnectBtn.addEventListener('click', async () => {
      const url = remoteServerUrl.value?.trim();
      if (!url) {
        getNotificationCenter().error('Please enter a server URL', { category: 'connectivity' });
        return;
      }
      if (!remoteSource) {
        getNotificationCenter().error('Remote source not available', { category: 'connectivity' });
        return;
      }

      const notifications = getNotificationCenter();
      const connectNotifId = notifications.loading(`Connecting to ${url}...`, { category: 'connectivity' });
      remoteConnectBtn.disabled = true;

      try {
        await remoteSource.connect({ url });
        if (!remoteSource.isConnected()) {
          notifications.fail(connectNotifId, 'Connection failed');
          return;
        }

        updateRemoteUI(true);
        const datasets = await remoteSource.listDatasets();
        if (!datasets.length) {
          notifications.fail(connectNotifId, 'Connected - no datasets found');
          return;
        }

        notifications.complete(connectNotifId, `Connected - ${datasets.length} dataset(s) found`);

        await dataSourceManager.switchToDataset('remote', datasets[0].id, {
          loadMethod: DATA_LOAD_METHODS.REMOTE_CONNECT
        });
        populate();

        if (typeof reloadDataset === 'function') {
          await reloadDataset(datasets[0]);
        }

        updateUrlForDataSource('remote', { serverUrl: url });
      } catch (err) {
        notifications.fail(connectNotifId, `Error: ${err?.message || err}`);
        debug.error('[UI] Remote connection error:', err);
      } finally {
        remoteConnectBtn.disabled = false;
      }
    });

    if (remoteDisconnectBtn) {
      remoteDisconnectBtn.addEventListener('click', async () => {
        if (!remoteSource) return;
        try {
          remoteSource.disconnect();
        } catch (err) {
          debug.warn('[UI] remoteSource.disconnect failed:', err);
        }

        getNotificationCenter().success('Disconnected', { category: 'connectivity' });
        updateRemoteUI(false);
        clearUrlDataSource();

        if (dataSourceManager.getCurrentSourceType?.() === 'remote') {
          try {
            const demoSource = dataSourceManager.getSource('local-demo');
            const defaultId = await demoSource?.getDefaultDatasetId?.();
            if (defaultId) {
              await dataSourceManager.switchToDataset('local-demo', defaultId, {
                loadMethod: DATA_LOAD_METHODS.REMOTE_DISCONNECT_FALLBACK
              });
              populate();
              if (typeof reloadDataset === 'function') {
                await reloadDataset(dataSourceManager.getCurrentMetadata?.());
              }
            }
          } catch (err) {
            debug.warn('[UI] Failed to switch back to local-demo after disconnect:', err);
          }
        }
      });
    }

    try {
      remoteSource?.onConnectionLost?.(() => {
        getNotificationCenter().error('Connection lost', { category: 'connectivity' });
        updateRemoteUI(false);
      });
    } catch (err) {
      debug.warn('[UI] remoteSource.onConnectionLost handler failed:', err);
    }

    const urlParams = new URLSearchParams(window.location.search);
    const remoteParam = urlParams.get('remote');
    if (remoteParam) {
      remoteServerUrl.value = remoteParam;
    }

    if (remoteSource?.isConnected?.()) {
      updateRemoteUI(true);
    }
  }

  // ---------------------------------------------------------------------------
  // GitHub repository connection
  // ---------------------------------------------------------------------------

  if (githubConnectBtn && githubRepoUrl) {
    const githubSource = dataSourceManager.getSource('github-repo');

    const updateGithubUI = (connected) => {
      githubConnectBtn.textContent = connected ? 'Reconnect' : 'Connect';
      if (githubDisconnectContainer) githubDisconnectContainer.style.display = connected ? 'flex' : 'none';
      githubRepoUrl.disabled = connected;
    };

    githubConnectBtn.addEventListener('click', async () => {
      const repoPath = githubRepoUrl.value?.trim();
      if (!repoPath) {
        getNotificationCenter().error('Please enter a GitHub repository path', { category: 'connectivity' });
        return;
      }
      if (!githubSource) {
        getNotificationCenter().error('GitHub source not available', { category: 'connectivity' });
        return;
      }

      const notifications = getNotificationCenter();
      const connectNotifId = notifications.loading(`Connecting to GitHub: ${repoPath}...`, { category: 'connectivity' });
      githubConnectBtn.disabled = true;

      try {
        const { repoInfo, datasets } = await githubSource.connect(repoPath);
        updateGithubUI(true);

        if (!datasets.length) {
          notifications.fail(connectNotifId, 'Connected - no datasets found');
          return;
        }

        notifications.complete(
          connectNotifId,
          `Connected to ${repoInfo.owner}/${repoInfo.repo} - ${datasets.length} dataset(s)`
        );

        await dataSourceManager.switchToDataset('github-repo', datasets[0].id, {
          loadMethod: DATA_LOAD_METHODS.GITHUB_CONNECT
        });
        populate();

        if (typeof reloadDataset === 'function') {
          await reloadDataset(datasets[0]);
        }

        updateUrlForDataSource('github-repo', { path: repoPath });
      } catch (err) {
        notifications.fail(connectNotifId, `Error: ${err?.message || err}`);
        debug.error('[UI] GitHub connection error:', err);
        updateGithubUI(false);
      } finally {
        githubConnectBtn.disabled = false;
      }
    });

    if (githubDisconnectBtn) {
      githubDisconnectBtn.addEventListener('click', async () => {
        if (!githubSource) return;
        try {
          githubSource.disconnect();
        } catch (err) {
          debug.warn('[UI] githubSource.disconnect failed:', err);
        }

        getNotificationCenter().success('Disconnected from GitHub', { category: 'connectivity' });
        updateGithubUI(false);
        clearUrlDataSource();

        if (dataSourceManager.getCurrentSourceType?.() === 'github-repo') {
          try {
            const demoSource = dataSourceManager.getSource('local-demo');
            const defaultId = await demoSource?.getDefaultDatasetId?.();
            if (defaultId) {
              await dataSourceManager.switchToDataset('local-demo', defaultId, {
                loadMethod: DATA_LOAD_METHODS.GITHUB_DISCONNECT_FALLBACK
              });
              populate();
              if (typeof reloadDataset === 'function') {
                await reloadDataset(dataSourceManager.getCurrentMetadata?.());
              }
            }
          } catch (err) {
            debug.warn('[UI] Failed to switch back to local-demo after GitHub disconnect:', err);
          }
        }
      });
    }

    const urlParams = new URLSearchParams(window.location.search);
    const githubParam = urlParams.get('github');
    if (githubParam) {
      githubRepoUrl.value = githubParam;
    }

    const connected = githubSource?.getConnectionInfo?.().connected;
    if (connected) updateGithubUI(true);
  }
}

