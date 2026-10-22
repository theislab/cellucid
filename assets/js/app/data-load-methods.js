/**
 * How a dataset was loaded: the vocabulary the dataset controls record and the
 * optional usage analytics report as `data_load.load_method`. It lives in the
 * application, not in `analytics/`, because the controls need it whether or
 * not analytics loads. Every value is reachable from a current load path.
 *
 * @module app/data-load-methods
 */

export const DATA_LOAD_METHODS = Object.freeze({
  DEFAULT_DEMO: 'default-demo',
  SERVER_AUTO: 'server-auto',
  DATASET_DROPDOWN: 'dataset-dropdown',
  DATASET_URL_PARAM: 'dataset-url-param',
  LOCAL_PREPARED: 'local-user-prepared',
  LOCAL_H5AD: 'local-user-h5ad',
  LOCAL_ZARR_ZIP: 'local-user-zarr-zip',
  REMOTE_URL_PARAM: 'remote-url-param',
  REMOTE_CONNECT: 'remote-connect',
  GITHUB_URL_PARAM: 'github-url-param',
  GITHUB_CONNECT: 'github-connect',
  JUPYTER_AUTO: 'jupyter-auto'
});
