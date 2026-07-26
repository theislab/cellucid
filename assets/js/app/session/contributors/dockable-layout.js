/**
 * @fileoverview Exact floating dockable-panel layout session contributor.
 *
 * Analysis windows are owned by their dedicated contributor. Every serialized
 * accordion uses its stable nonempty DOM id; visible summary copy is never an
 * identity.
 *
 * @module session/contributors/dockable-layout
 */

import { StyleManager } from '../../../utils/style-manager.js';
import {
  assertArray,
  assertBoolean,
  assertExactKeys,
  assertFiniteNumber,
  assertNonEmptyString,
  assertSafeInteger,
  requireMethod
} from '../schema-contract.js';

export const id = 'dockable-layout';

function assertDetailsElement(value, context) {
  if (
    typeof HTMLDetailsElement === 'undefined'
    || !(value instanceof HTMLDetailsElement)
  ) {
    throw new TypeError(`${context} must be an HTMLDetailsElement.`);
  }
  if (
    typeof value.matches !== 'function'
    || !value.matches('details.accordion-section')
  ) {
    throw new TypeError(`${context} must be a current accordion section.`);
  }
  return value;
}

function isExcluded(details) {
  if (typeof details.closest !== 'function') {
    throw new TypeError('Dockable accordion requires closest().');
  }
  if (details.closest('[data-state-serializer-skip]') !== null) return true;
  if (
    details.classList === null
    || typeof details.classList !== 'object'
    || typeof details.classList.contains !== 'function'
  ) {
    throw new TypeError('Dockable accordion requires classList.');
  }
  if (details.classList.contains('analysis-window-panel')) return true;
  if (details.dataset === null || typeof details.dataset !== 'object') {
    throw new TypeError('Dockable accordion requires dataset metadata.');
  }
  return Object.hasOwn(details.dataset, 'analysisWindowId');
}

function assertPanelId(value, context) {
  return assertNonEmptyString(value, `${context} stable nonempty DOM id`);
}

function readPanelRect(details, context) {
  requireMethod(details, 'getBoundingClientRect', context);
  const domRect = details.getBoundingClientRect();
  if (domRect === null || typeof domRect !== 'object') {
    throw new TypeError(`${context} must return a DOMRect.`);
  }
  const rect = {
    left: assertFiniteNumber(domRect.left, `${context} left`),
    top: assertFiniteNumber(domRect.top, `${context} top`),
    width: assertFiniteNumber(domRect.width, `${context} width`),
    height: assertFiniteNumber(domRect.height, `${context} height`)
  };
  if (rect.width <= 0 || rect.height <= 0) {
    throw new RangeError(`${context} width and height must be positive.`);
  }
  return rect;
}

function readPanelLayer(details, context) {
  const raw = StyleManager.getVariable(details, '--z-layer');
  if (typeof raw !== 'string' || !/^(0|[1-9]\d*)$/.test(raw)) {
    throw new TypeError(`${context} must have an exact non-negative integer z layer.`);
  }
  return assertSafeInteger(Number(raw), `${context} z layer`);
}

function assertRect(rect, context) {
  assertExactKeys(rect, ['left', 'top', 'width', 'height'], context);
  assertFiniteNumber(rect.left, `${context} left`);
  assertFiniteNumber(rect.top, `${context} top`);
  assertFiniteNumber(rect.width, `${context} width`);
  assertFiniteNumber(rect.height, `${context} height`);
  if (rect.width <= 0 || rect.height <= 0) {
    throw new RangeError(`${context} width and height must be positive.`);
  }
}

function assertPanel(panel, context) {
  assertExactKeys(panel, ['id', 'open', 'rect', 'z'], context);
  assertPanelId(panel.id, `${context} id`);
  assertBoolean(panel.open, `${context} open`);
  assertRect(panel.rect, `${context} rect`);
  assertSafeInteger(panel.z, `${context} z`);
}

function getDockableOwner(ctx, operation) {
  if (ctx === null || typeof ctx !== 'object') {
    throw new TypeError(`Dockable layout ${operation} requires a session context.`);
  }
  const dockable = ctx.dockableAccordions;
  if (dockable === null || typeof dockable !== 'object') {
    throw new TypeError(`Dockable layout ${operation} requires the current dockable owner.`);
  }
  return dockable;
}

export function capture(ctx) {
  const dockable = getDockableOwner(ctx, 'capture');
  const floatingRoot = dockable.floatingRoot;
  if (
    floatingRoot === null
    || typeof floatingRoot !== 'object'
    || typeof floatingRoot.querySelectorAll !== 'function'
  ) {
    throw new TypeError('Dockable layout capture requires the current floating root.');
  }

  const panels = [];
  const ids = new Set();
  for (const candidate of floatingRoot.querySelectorAll('details.accordion-section')) {
    const details = assertDetailsElement(candidate, 'Floating accordion');
    if (!details.classList.contains('accordion-floating')) {
      throw new TypeError('Every accordion in the floating root must be marked floating.');
    }
    if (isExcluded(details)) continue;
    const panelId = assertPanelId(details.id, 'Floating accordion');
    if (ids.has(panelId)) {
      throw new TypeError(`Floating accordion id "${panelId}" is duplicated.`);
    }
    ids.add(panelId);
    panels.push({
      id: panelId,
      open: details.open === true,
      rect: readPanelRect(details, `Floating accordion "${panelId}" geometry`),
      z: readPanelLayer(details, `Floating accordion "${panelId}"`)
    });
  }
  panels.sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));

  return [{
    id: 'ui/dockable-layout',
    contributorId: id,
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Floating panels',
    datasetDependent: false,
    payload: { panels }
  }];
}

export function restore(ctx, _chunkMeta, payload) {
  const dockable = getDockableOwner(ctx, 'restore');
  requireMethod(dockable, 'dock', 'Dockable layout restore owner');
  requireMethod(dockable, 'float', 'Dockable layout restore owner');
  assertExactKeys(payload, ['panels'], 'Dockable layout payload');
  assertArray(payload.panels, 'Dockable layout panels');

  const ids = new Set();
  const candidates = [];
  let previousPanel = null;
  for (let index = 0; index < payload.panels.length; index++) {
    const panel = payload.panels[index];
    const context = `Dockable layout panel ${index}`;
    assertPanel(panel, context);
    if (ids.has(panel.id)) {
      throw new TypeError(`Dockable layout panel id "${panel.id}" is duplicated.`);
    }
    ids.add(panel.id);
    if (
      previousPanel !== null
      && (
        panel.z < previousPanel.z
        || (panel.z === previousPanel.z && panel.id.localeCompare(previousPanel.id) <= 0)
      )
    ) {
      throw new TypeError('Dockable layout panels must use canonical z/id order.');
    }
    previousPanel = panel;

    const details = document.getElementById(panel.id);
    assertDetailsElement(details, `Dockable layout panel "${panel.id}" current element`);
    if (isExcluded(details)) {
      throw new TypeError(`Dockable layout panel "${panel.id}" is not session-owned.`);
    }
    candidates.push({ panel, details });
  }

  for (const { panel, details } of candidates) {
    if (details.classList.contains('accordion-floating')) {
      dockable.dock(details);
      if (details.classList.contains('accordion-floating')) {
        throw new Error(`Dockable owner failed to dock current panel "${panel.id}".`);
      }
    }
    dockable.float(details, {
      left: panel.rect.left,
      top: panel.rect.top,
      preferredSize: {
        width: panel.rect.width,
        height: panel.rect.height
      }
    });
    if (!details.classList.contains('accordion-floating')) {
      throw new Error(`Dockable owner failed to float current panel "${panel.id}".`);
    }
    details.open = panel.open;
    StyleManager.setLayer(details, panel.z);
  }
}
