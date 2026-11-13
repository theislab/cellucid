/**
 * @fileoverview Sole visible owner for terminal application-startup failure.
 */

import {
  hideWelcomeModal,
  isWelcomeModalVisible
} from './ui/onboarding/welcome-modal.js';
import { DataSourceError, isExplainedFailure } from '../data/data-source.js';
import { STARTUP_STALL_CODE } from './startup-phase.js';
import { isContextLostError, isContextRefusedError } from '../rendering/gl-errors.js';
import { failureText } from '../utils/errors.js';

/**
 * Convert JavaScript's unrestricted thrown-value channel into the sole
 * current Error contract used by startup reporting.
 *
 * @param {unknown} thrown
 * @returns {Error}
 */
export function normalizeStartupError(thrown) {
  if (
    thrown instanceof Error &&
    typeof thrown.message === 'string' &&
    thrown.message.length > 0
  ) {
    return thrown;
  }
  const error = new TypeError(
    thrown instanceof Error
      ? 'Application startup failed without an error message.'
      : 'Application startup rejected with a non-Error value.'
  );
  error.cause = thrown;
  return error;
}

const DOCS = 'https://docs.cellucid.com/en/latest/user_guide/web_app/';

/** The guide for a link, server or file that would not open. */
export const STARTUP_TROUBLESHOOTING_URL =
  `${DOCS}b_data_loading/08_troubleshooting_data_loading.html`;

/** What a browser needs to run Cellucid (WebGL2, `BROWSER_FLOOR`). */
export const STARTUP_REQUIREMENTS_URL =
  `${DOCS}a_orientation/02_system_requirements.html`;

/** Where every troubleshooting path starts. */
export const STARTUP_TROUBLESHOOTING_INDEX_URL =
  `${DOCS}q_troubleshooting_index/index.html`;

/** Where a failure nobody explained can be reported. */
export const STARTUP_ISSUES_URL = 'https://github.com/theislab/cellucid/issues';

/**
 * What a browser must have besides WebGL2: the newest platform features
 * Cellucid calls, which set its floor (Chrome 116, Firefox 124, Safari 17.4).
 * They are checked before anything starts (`requireBrowserFeatures`), so an
 * older browser is told so at once instead of failing in the middle of an
 * opening. No stand-in is supplied for a missing one.
 */
export const BROWSER_FEATURES = Object.freeze([
  // Every reader `open`, growth step and provider request joins signals with it.
  Object.freeze({ name: 'AbortSignal.any', present: scope => typeof scope.AbortSignal?.any === 'function' }),
]);

/** The browser versions `BROWSER_FEATURES` asks for, as people name them. */
const BROWSER_FLOOR = 'Chrome or Edge 116, Firefox 124, Safari 17.4';

/** Code of the failure `requireBrowserFeatures` throws. */
export const BROWSER_TOO_OLD_CODE = 'CELLUCID_BROWSER_TOO_OLD';

/**
 * The features of `BROWSER_FEATURES` `scope` lacks, by name.
 *
 * @param {typeof globalThis} [scope]
 * @returns {string[]}
 */
export function missingBrowserFeatures(scope = globalThis) {
  return BROWSER_FEATURES.filter(feature => !feature.present(scope)).map(feature => feature.name);
}

/**
 * Throw when `scope` lacks a feature of `BROWSER_FEATURES` (the failure the
 * startup screen shows as this browser being too old).
 *
 * @param {typeof globalThis} [scope]
 */
export function requireBrowserFeatures(scope = globalThis) {
  const missing = missingBrowserFeatures(scope);
  if (missing.length === 0) return;
  const error = new Error(`This browser lacks ${missing.join(', ')}; Cellucid needs ${BROWSER_FLOOR} or later.`);
  error.code = BROWSER_TOO_OLD_CODE;
  error.missing = missing;
  throw error;
}

/** The message of an explained failure (the first of an AggregateError). */
function explainedReason(error) {
  return error instanceof AggregateError && error.errors.length > 0
    ? explainedReason(error.errors[0])
    : error.message;
}

/**
 * What the person is told about a failed start, chosen by what failed and
 * never by its technical message: the message (a host, a status, an address)
 * goes under Details, to the console and to the notification log.
 *
 * Data the address names (`?data=`, `?remote=`, `?dataset=`, a catalog's
 * default) that does not open never reaches this screen: Cellucid starts
 * without it and its failed opening says why (main.js, failStartupData).
 * What remains:
 *
 * - `browser`: no WebGL2, or a browser older than `BROWSER_FLOOR`, so
 *   Cellucid cannot run in this browser at all;
 * - `graphics`: the browser's graphics stopped working while Cellucid
 *   started (its WebGL2 context was lost, as it was made or after, or a
 *   browser with WebGL2 would not give the viewer one);
 * - `data`: the server the page itself is served from could not be read;
 * - `stall`: a server startup waited on never answered (the page's own
 *   server, the sample catalog, a published default view);
 * - `app`: anything else.
 *
 * @param {Error} error
 * @param {{ webgl2Available: boolean, hasLaunchSettings: boolean }} context
 * @returns {{
 *   kind: 'browser'|'graphics'|'data'|'stall'|'app',
 *   title: string,
 *   sentence: string,
 *   offerWithoutSettings: boolean,
 *   links: Array<[string, string]>
 * }}
 */
export function describeStartupFailure(error, { webgl2Available, hasLaunchSettings }) {
  if (error.code === BROWSER_TOO_OLD_CODE) {
    return {
      kind: 'browser',
      title: 'This browser cannot run Cellucid',
      sentence:
        `This browser is older than Cellucid needs (${BROWSER_FLOOR} or later). ` +
        'Update the browser, then try again.',
      offerWithoutSettings: false,
      links: [[STARTUP_REQUIREMENTS_URL, 'System requirements']]
    };
  }
  if (!webgl2Available) {
    return {
      kind: 'browser',
      title: 'This browser cannot run Cellucid',
      sentence:
        'Cellucid draws with WebGL2, which this browser has turned off or does not have. ' +
        'Update the browser or turn on hardware acceleration, then try again.',
      offerWithoutSettings: false,
      links: [[STARTUP_REQUIREMENTS_URL, 'System requirements']]
    };
  }
  if (isContextRefusedError(error)) {
    // This browser has WebGL2 (the probe's context came), yet refused one to
    // the viewer: its graphics process cannot make another now.
    return {
      kind: 'graphics',
      title: 'The browser\u2019s graphics stopped working',
      sentence:
        'The browser would not give Cellucid a graphics context: its graphics process was reset, or too many pages are drawing at once. ' +
        'Close other tabs that draw 3D graphics and reload the page; if this happens again, restart the browser.',
      offerWithoutSettings: false,
      links: [[STARTUP_TROUBLESHOOTING_INDEX_URL, 'Troubleshooting']]
    };
  }
  if (isContextLostError(error)) {
    return {
      kind: 'graphics',
      title: 'The browser\u2019s graphics stopped working',
      sentence:
        'The browser could not give Cellucid a working graphics context: its graphics process was reset or stopped. ' +
        'Reload the page; if this happens again, restart the browser.',
      offerWithoutSettings: false,
      links: [[STARTUP_TROUBLESHOOTING_INDEX_URL, 'Troubleshooting']]
    };
  }
  if (error instanceof DataSourceError || isExplainedFailure(error)) {
    return {
      kind: 'data',
      title: 'The data could not be opened',
      // A failure written for the person says the reason itself.
      sentence: isExplainedFailure(error)
        ? explainedReason(error)
        : hasLaunchSettings
        ? 'Cellucid could not read the data this link points to. Try again, or open Cellucid without it.'
        : 'Cellucid could not read the data it was opening. Try again in a moment.',
      offerWithoutSettings: hasLaunchSettings,
      links: [[STARTUP_TROUBLESHOOTING_URL, 'Troubleshooting data loading']]
    };
  }
  if (error.code === STARTUP_STALL_CODE) {
    return {
      kind: 'stall',
      title: 'A server did not answer',
      sentence:
        'Cellucid stopped waiting for a server that did not respond. ' +
        'Check your connection, then try again.',
      offerWithoutSettings: hasLaunchSettings,
      links: [[STARTUP_TROUBLESHOOTING_URL, 'Troubleshooting data loading']]
    };
  }
  return {
    kind: 'app',
    title: 'Cellucid could not start',
    sentence: hasLaunchSettings
      ? 'Something went wrong while starting. Try again, or open Cellucid without this link\u2019s settings.'
      : 'Something went wrong while starting. Try again in a moment.',
    offerWithoutSettings: hasLaunchSettings,
    links: [
      [STARTUP_TROUBLESHOOTING_INDEX_URL, 'Troubleshooting'],
      [STARTUP_ISSUES_URL, 'Report a problem']
    ]
  };
}

/**
 * Whether this browser can create a WebGL2 context. The probe's context is
 * lost at once (`loseContext`), which lets its GPU resources go; WebKit still
 * counts it among the page's contexts until it is collected.
 *
 * @param {Document} documentOwner
 * @returns {boolean}
 */
function probeWebGL2(documentOwner) {
  const canvas = documentOwner.createElement('canvas');
  // A document without a drawing surface (a test double) cannot say no.
  if (typeof canvas.getContext !== 'function') return true;
  const context = canvas.getContext('webgl2');
  if (context === null) return false;
  context.getExtension('WEBGL_lose_context')?.loseContext();
  return true;
}

function requireStartupFailureOptions(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).length !== 3 ||
    !Object.hasOwn(options, 'documentOwner') ||
    !Object.hasOwn(options, 'error') ||
    !Object.hasOwn(options, 'statsElement')
  ) {
    throw new TypeError(
      'Startup failure publication requires exactly documentOwner, error, and statsElement.'
    );
  }
  if (!(options.error instanceof Error)) {
    throw new TypeError(
      'Startup failure publication requires one Error.'
    );
  }
  const documentOwner = options.documentOwner;
  if (
    documentOwner === null ||
    typeof documentOwner !== 'object' ||
    typeof documentOwner.createElement !== 'function' ||
    typeof documentOwner.getElementById !== 'function' ||
    documentOwner.body === null ||
    typeof documentOwner.body !== 'object' ||
    typeof documentOwner.body.appendChild !== 'function'
  ) {
    throw new TypeError(
      'Startup failure publication requires the current document body.'
    );
  }
  const location = documentOwner.location;
  if (
    location === null ||
    typeof location !== 'object' ||
    typeof location.pathname !== 'string' ||
    typeof location.search !== 'string'
  ) {
    throw new TypeError(
      'Startup failure publication requires the current document location.'
    );
  }
  if (
    options.statsElement !== null &&
    (
      typeof options.statsElement !== 'object' ||
      !('textContent' in options.statsElement)
    )
  ) {
    throw new TypeError(
      'Startup failure statsElement must be null or expose textContent.'
    );
  }
  return options;
}

function element(documentOwner, tagName, className, text) {
  const node = documentOwner.createElement(tagName);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionRow(documentOwner, href, title, primary) {
  const row = element(
    documentOwner,
    'a',
    primary ? 'welcome-btn welcome-btn-primary' : 'welcome-btn welcome-btn-link'
  );
  row.setAttribute('href', href);
  const icon = element(documentOwner, 'span', 'welcome-btn-icon', primary ? '\u21bb' : '\u2192');
  icon.setAttribute('aria-hidden', 'true');
  const text = element(documentOwner, 'span', 'welcome-btn-text');
  text.append(element(documentOwner, 'span', 'welcome-btn-title', title));
  row.append(icon, text);
  return row;
}

/**
 * Publish one persistent, accessible terminal startup surface: the brand card
 * (components/_welcome.css) over everything (layouts/_page.css), saying what
 * happened in one sentence and what to do, with the technical message folded
 * under Details.
 *
 * @param {{
 *   documentOwner: Document,
 *   error: Error,
 *   statsElement: HTMLElement|null
 * }} options
 * @returns {HTMLElement}
 */
export function publishStartupFailure(options) {
  const {
    documentOwner,
    error,
    statsElement
  } = requireStartupFailureOptions(options);
  if (documentOwner.getElementById('cellucid-startup-failure') !== null) {
    throw new Error(
      'Terminal startup failure already has a visible owner.'
    );
  }

  // Onboarding invites the user into an application that no longer exists, and
  // two dialogs claiming the screen at once leaves neither of them credible.
  // It is retracted through its own owner rather than covered over, so its
  // `aria-modal` region really does close and its Tab trap really is released.
  if (isWelcomeModalVisible()) hideWelcomeModal();

  const { location } = documentOwner;
  const hasLaunchSettings = location.search !== '';
  const said = describeStartupFailure(error, {
    webgl2Available: probeWebGL2(documentOwner),
    hasLaunchSettings
  });

  const surface = element(documentOwner, 'section', 'page-screen page-screen-fixed');
  surface.id = 'cellucid-startup-failure';
  surface.setAttribute('data-failure', said.kind);
  surface.setAttribute('role', 'alert');
  surface.setAttribute('aria-live', 'assertive');
  surface.setAttribute('aria-atomic', 'true');
  surface.setAttribute('aria-labelledby', 'cellucid-startup-failure-title');

  const card = element(documentOwner, 'div', 'welcome-content');
  const header = element(documentOwner, 'div', 'welcome-header');
  const logo = element(documentOwner, 'img', 'welcome-logo');
  logo.setAttribute('src', 'assets/img/cellucid-logo.svg');
  logo.setAttribute('alt', 'Cellucid');
  logo.setAttribute('width', '260');
  logo.setAttribute('height', '80');
  header.append(logo);

  const body = element(documentOwner, 'div', 'welcome-body');
  const title = element(documentOwner, 'h1', 'welcome-title', said.title);
  title.id = 'cellucid-startup-failure-title';
  const sentence = element(documentOwner, 'p', 'welcome-intro', said.sentence);

  // A failure is never a dead end: the same address again, and, when the
  // link carried launch settings (a dataset, a repository, a server), the app
  // as it starts by default.
  const actions = element(documentOwner, 'div', 'welcome-actions');
  actions.append(actionRow(documentOwner, `${location.pathname}${location.search}`, 'Try again', true));
  if (said.offerWithoutSettings) {
    actions.append(actionRow(documentOwner, location.pathname, 'Open Cellucid without this link', false));
  }

  const details = element(documentOwner, 'details', 'welcome-details');
  details.append(
    element(documentOwner, 'summary', '', 'Details'),
    element(documentOwner, 'p', 'welcome-details-text', error.message)
  );

  const links = element(documentOwner, 'ul', 'welcome-links');
  links.setAttribute('aria-label', 'Help');
  for (const [href, label] of said.links) {
    const item = element(documentOwner, 'li', '');
    const link = element(documentOwner, 'a', '', label);
    link.setAttribute('href', href);
    item.append(link);
    links.append(item);
  }

  body.append(title, sentence, actions, details, links);
  card.append(header, body);
  surface.appendChild(card);
  // The application behind it is gone: nothing there takes focus or is read.
  for (const sibling of Array.from(documentOwner.body.children)) {
    sibling.inert = true;
  }
  documentOwner.body.appendChild(surface);
  // Retracting onboarding takes focus off a control that no longer exists, so
  // the alert takes it: leaving focus on `<body>` would strand a keyboard user
  // behind a full-screen surface with nothing selected.
  surface.setAttribute('tabindex', '-1');
  if (typeof surface.focus !== 'function') {
    throw new TypeError(
      'Terminal startup failure requires a focusable surface.'
    );
  }
  surface.focus();
  if (statsElement !== null) {
    statsElement.textContent = `Startup failed: ${failureText(error)}`;
  }
  return surface;
}
