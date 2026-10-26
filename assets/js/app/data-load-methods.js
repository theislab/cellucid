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
  // A file, a ZIP archive or a folder from this computer, whatever format it
  // holds: the format is reported beside it (`data_load.data_format`).
  LOCAL_FILE: 'local-user-file',
  LOCAL_ZIP: 'local-user-zip',
  LOCAL_FOLDER: 'local-user-folder',
  REMOTE_URL_PARAM: 'remote-url-param',
  REMOTE_CONNECT: 'remote-connect',
  DATA_URL_PARAM: 'data-url-param',
  LINK_CONNECT: 'link-connect',
  SESSION_SOURCE: 'session-source',
  VIEWER_HOST_AUTO: 'jupyter-auto'
});
