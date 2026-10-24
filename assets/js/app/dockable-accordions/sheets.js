/**
 * @fileoverview Floating panels as bottom sheets on a phone.
 *
 * On a screen of 720 px or less a floating window has no room to float: it
 * would cover the plot or the full-screen sidebar wherever it sat, and its
 * edges are too thin for a finger. There, every panel registered as a sheet
 * (`register(details, { sheet: true })`; the analysis windows) is laid out as
 * a bottom sheet instead:
 *
 * - full width, at one of three heights — 40%, 75% or all of the screen —
 *   chosen by dragging, tapping or arrowing its 24 px grip;
 * - a tap on its header collapses it to the header, as anywhere else;
 * - one sheet shows at a time: the frontmost window. When there are several,
 *   a tab strip above the sheet names them all and brings one to the front.
 *
 * The layout follows the viewport live (`matchMedia`), and it never touches
 * a panel's own box (`--pos-*`): turning the phone or widening the window
 * gives every window back the place and size it had.
 *
 * @module dockable-accordions/sheets
 */

import { capturePointer, releasePointer } from '../ui/pointer-capture.js';

/** The phone layout's breakpoint, the same as the full-screen sidebar's. */
const SHEET_QUERY = '(max-width: 720px)';
/** Sheet heights, as a share of the screen. */
const SNAP_FRACTIONS = [0.4, 0.75, 1];
const DEFAULT_SNAP = 1;
/** Travel below this is a tap on the grip, not a drag. */
const TAP_TRAVEL_PX = 6;
const LAYER_PATTERN = /^-?(?:0|[1-9]\d*)$/;

function layerOf(frame) {
  const raw = frame.style.getPropertyValue('--z-layer').trim();
  return LAYER_PATTERN.test(raw) ? Number(raw) : 0;
}

function titleOf(details) {
  const summary = details.querySelector(':scope > summary');
  const title = summary?.querySelector('.disclosure-title')?.textContent ?? summary?.textContent;
  const text = typeof title === 'string' ? title.trim() : '';
  return text.length > 0 ? text : 'Window';
}

function nearestSnap(fraction) {
  let best = 0;
  for (let index = 1; index < SNAP_FRACTIONS.length; index += 1) {
    if (Math.abs(SNAP_FRACTIONS[index] - fraction) < Math.abs(SNAP_FRACTIONS[best] - fraction)) {
      best = index;
    }
  }
  return best;
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.floatingRoot
 * @param {object} deps.StyleManager
 * @param {(details: HTMLElement) => HTMLElement|null} deps.panelFrame
 * @param {(frame: HTMLElement) => void} deps.raiseToTop
 */
export function createSheetLayout({ floatingRoot, StyleManager, panelFrame, raiseToTop }) {
  const query = window.matchMedia(SHEET_QUERY);
  /** Panels registered as sheets, in registration order. */
  const panels = new Set();
  /** Each panel's chosen height (an index into SNAP_FRACTIONS). */
  const snapByDetails = new WeakMap();
  let tabs = null;
  let scheduled = false;

  function setSnap(details, index) {
    const clamped = Math.min(Math.max(index, 0), SNAP_FRACTIONS.length - 1);
    snapByDetails.set(details, clamped);
    const frame = panelFrame(details);
    if (frame === null) return;
    const percent = Math.round(SNAP_FRACTIONS[clamped] * 100);
    StyleManager.setVariable(frame, '--sheet-height', `${percent}dvh`);
    const grip = frame.querySelector(':scope > .floating-sheet-grip');
    if (grip !== null) {
      grip.setAttribute('aria-valuenow', String(percent));
      grip.setAttribute('aria-valuetext', `${percent}% of the screen`);
    }
  }

  function snapOf(details) {
    return snapByDetails.get(details) ?? DEFAULT_SNAP;
  }

  function ensureTabs() {
    if (tabs !== null) return tabs;
    tabs = document.createElement('div');
    tabs.className = 'floating-sheet-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Open windows');
    tabs.addEventListener('click', (event) => {
      const tab = event.target instanceof Element ? event.target.closest('[role="tab"]') : null;
      if (tab === null) return;
      const frame = [...floatingRoot.children].find(child => child.dataset?.sheetId === tab.dataset.sheetId);
      if (frame !== undefined) raiseToTop(frame);
    });
    return tabs;
  }

  /** Lay every sheet panel out for the current viewport. */
  function refresh() {
    scheduled = false;
    const phone = query.matches;
    const frames = [];
    for (const details of panels) {
      const frame = panelFrame(details);
      if (frame === null) continue;
      const floating = frame.parentElement === floatingRoot
        && frame.classList.contains('accordion-floating');
      frame.classList.toggle('floating-sheet', phone && floating);
      if (!phone || !floating) {
        frame.classList.remove('sheet-active', 'has-sheet-tabs');
        continue;
      }
      frames.push({ details, frame });
    }
    frames.sort((a, b) => layerOf(a.frame) - layerOf(b.frame));
    const front = frames.at(-1) ?? null;
    for (const { frame } of frames) {
      frame.classList.toggle('sheet-active', frame === front?.frame);
      frame.classList.toggle('has-sheet-tabs', frame === front?.frame && frames.length > 1);
    }
    if (front === null || frames.length < 2) {
      tabs?.remove();
      return;
    }
    // Tabs keep the order the windows opened in; only the selection moves.
    const tabOrder = [...frames].sort((a, b) => Number(a.frame.dataset.sheetId) - Number(b.frame.dataset.sheetId));
    const strip = ensureTabs();
    strip.replaceChildren(...tabOrder.map(({ details, frame }) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'floating-sheet-tab';
      tab.setAttribute('role', 'tab');
      tab.dataset.sheetId = frame.dataset.sheetId;
      tab.setAttribute('aria-selected', frame === front.frame ? 'true' : 'false');
      tab.tabIndex = frame === front.frame ? 0 : -1;
      tab.textContent = titleOf(details);
      tab.title = titleOf(details);
      return tab;
    }));
    if (strip.parentElement !== front.frame) front.frame.prepend(strip);
  }

  /** Coalesce the refreshes one change can cause into one per frame. */
  function scheduleRefresh() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(refresh);
  }

  query.addEventListener('change', refresh);
  // A window opening or closing changes which one is in front.
  new MutationObserver(scheduleRefresh).observe(floatingRoot, { childList: true });

  let sheetCounter = 0;

  /**
   * Make a registered panel a sheet on phones: give it its grip.
   *
   * @param {HTMLElement} details
   * @param {AbortSignal} signal - The registration's own signal.
   */
  function adopt(details, signal) {
    const frame = panelFrame(details);
    if (frame === null) throw new TypeError('A sheet panel must stand in its frame.');
    panels.add(details);
    sheetCounter += 1;
    frame.dataset.sheetId = String(sheetCounter);
    if (frame.querySelector(':scope > .floating-sheet-grip') === null) {
      const grip = document.createElement('div');
      grip.className = 'floating-sheet-grip';
      grip.setAttribute('role', 'separator');
      grip.setAttribute('aria-orientation', 'horizontal');
      grip.setAttribute('aria-label', 'Window height');
      grip.setAttribute('aria-valuemin', String(Math.round(SNAP_FRACTIONS[0] * 100)));
      grip.setAttribute('aria-valuemax', '100');
      grip.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown Home End');
      grip.tabIndex = 0;
      frame.prepend(grip);
      grip.addEventListener('keydown', (event) => {
        const step = { ArrowUp: 1, ArrowDown: -1 }[event.key];
        let next = null;
        if (step !== undefined) next = snapOf(details) + step;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = SNAP_FRACTIONS.length - 1;
        if (next === null) return;
        event.preventDefault();
        details.open = true;
        setSnap(details, next);
      }, { signal });
      grip.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const pointerId = event.pointerId;
        const startY = event.clientY;
        let travelled = 0;
        capturePointer(grip, pointerId);
        frame.classList.add('resizing');
        const onMove = (move) => {
          if (move.pointerId !== pointerId) return;
          travelled = Math.max(travelled, Math.abs(move.clientY - startY));
          if (travelled < TAP_TRAVEL_PX) return;
          details.open = true;
          const height = Math.min(Math.max(window.innerHeight - move.clientY, 0), window.innerHeight);
          StyleManager.setVariable(frame, '--sheet-height', `${Math.round(height)}px`);
        };
        const onUp = (up) => {
          if (up.pointerId !== pointerId) return;
          grip.removeEventListener('pointermove', onMove);
          grip.removeEventListener('pointerup', onUp);
          grip.removeEventListener('pointercancel', onUp);
          releasePointer(grip, pointerId);
          frame.classList.remove('resizing');
          if (travelled < TAP_TRAVEL_PX) {
            // A tap steps to the next height, round to the smallest.
            details.open = true;
            setSnap(details, (snapOf(details) + 1) % SNAP_FRACTIONS.length);
            return;
          }
          const fraction = (window.innerHeight - up.clientY) / window.innerHeight;
          setSnap(details, nearestSnap(fraction));
        };
        grip.addEventListener('pointermove', onMove, { signal });
        grip.addEventListener('pointerup', onUp, { signal });
        grip.addEventListener('pointercancel', onUp, { signal });
      }, { signal });
    }
    setSnap(details, snapOf(details));
    scheduleRefresh();
  }

  /**
   * Stop laying a panel out as a sheet (it is closing or re-registering).
   *
   * @param {HTMLElement} details
   */
  function release(details) {
    panels.delete(details);
    const frame = panelFrame(details);
    if (frame !== null) {
      frame.querySelector(':scope > .floating-sheet-grip')?.remove();
      if (tabs?.parentElement === frame) tabs.remove();
      frame.classList.remove('floating-sheet', 'sheet-active', 'has-sheet-tabs');
      StyleManager.removeVariable(frame, '--sheet-height');
    }
    scheduleRefresh();
  }

  return { adopt, release, refresh };
}
