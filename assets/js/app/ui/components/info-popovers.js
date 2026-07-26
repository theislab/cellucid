/**
 * @fileoverview Accessible information popovers for compact UI guidance.
 *
 * One document-level controller owns every `.info-btn` disclosure. Popovers
 * are portaled to `<body>` while open so fixed positioning is not constrained
 * by the sidebar's layout containment.
 *
 * @module ui/components/info-popovers
 */

const TRIGGER_SELECTOR = 'button.info-btn[aria-controls]';
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

function requireFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function requirePositiveNumber(value, label) {
  const number = requireFiniteNumber(value, label);
  if (number <= 0) {
    throw new RangeError(`${label} must be greater than zero`);
  }
  return number;
}

function requireNonNegativeNumber(value, label) {
  const number = requireFiniteNumber(value, label);
  if (number < 0) {
    throw new RangeError(`${label} must be zero or greater`);
  }
  return number;
}

function requireRect(rect, label) {
  if (rect === null || typeof rect !== 'object') {
    throw new TypeError(`${label} must be a rectangle object`);
  }
  const left = requireFiniteNumber(rect.left, `${label}.left`);
  const top = requireFiniteNumber(rect.top, `${label}.top`);
  const width = requireNonNegativeNumber(rect.width, `${label}.width`);
  const height = requireNonNegativeNumber(rect.height, `${label}.height`);
  const right = requireFiniteNumber(rect.right, `${label}.right`);
  const bottom = requireFiniteNumber(rect.bottom, `${label}.bottom`);
  if (right !== left + width || bottom !== top + height) {
    throw new RangeError(`${label} edges must exactly match its origin and size`);
  }
  return { left, top, width, height, right, bottom };
}

function requireExactText(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.trim() !== value
  ) {
    throw new TypeError(`${label} must be a non-empty exact string`);
  }
  return value;
}

/**
 * Compute a viewport-safe fixed position for an information popover.
 *
 * @param {object} options
 * @param {{left:number,top:number,width:number,height:number,right:number,bottom:number}} options.triggerRect
 * @param {{left:number,top:number,width:number,height:number,right:number,bottom:number}} options.popoverRect
 * @param {number} options.viewportWidth
 * @param {number} options.viewportHeight
 * @param {number} [options.margin]
 * @param {number} [options.gap]
 * @returns {{left:number, top:number, placement:'above'|'below'}}
 */
export function computeInfoPopoverPosition({
  triggerRect,
  popoverRect,
  viewportWidth,
  viewportHeight,
  margin = 8,
  gap = 6
}) {
  const trigger = requireRect(triggerRect, 'Information trigger rectangle');
  const popover = requireRect(popoverRect, 'Information popover rectangle');
  const width = requirePositiveNumber(viewportWidth, 'Viewport width');
  const height = requirePositiveNumber(viewportHeight, 'Viewport height');
  const edgeMargin = requireNonNegativeNumber(margin, 'Viewport margin');
  const disclosureGap = requireNonNegativeNumber(gap, 'Popover gap');

  if (edgeMargin * 2 >= width || edgeMargin * 2 >= height) {
    throw new RangeError('Viewport margin must leave positive usable space');
  }
  if (popover.width > width - edgeMargin * 2) {
    throw new RangeError('Information popover width must fit inside the viewport margin');
  }
  if (popover.height > height - edgeMargin * 2) {
    throw new RangeError('Information popover height must fit inside the viewport margin');
  }

  const belowTop = trigger.bottom + disclosureGap;
  const aboveTop = trigger.top - disclosureGap - popover.height;
  const fitsBelow = belowTop + popover.height <= height - edgeMargin;
  const fitsAbove = aboveTop >= edgeMargin;
  const placement = fitsBelow || !fitsAbove ? 'below' : 'above';
  const proposedTop = placement === 'below' ? belowTop : aboveTop;
  const top = Math.max(
    edgeMargin,
    Math.min(proposedTop, height - edgeMargin - popover.height)
  );
  const left = Math.max(
    edgeMargin,
    Math.min(trigger.left, width - edgeMargin - popover.width)
  );

  return Object.freeze({ left, top, placement });
}

function requireDocument(root) {
  if (
    root === null
    || typeof root !== 'object'
    || root.nodeType !== 9
    || typeof root.querySelectorAll !== 'function'
    || typeof root.getElementById !== 'function'
    || !root.body
    || !root.documentElement
  ) {
    throw new TypeError('Information popovers require a complete Document');
  }
  return root;
}

function requireViewport(viewport, documentRef) {
  if (
    viewport === null
    || typeof viewport !== 'object'
    || viewport.document !== documentRef
    || typeof viewport.getComputedStyle !== 'function'
    || typeof viewport.requestAnimationFrame !== 'function'
    || typeof viewport.cancelAnimationFrame !== 'function'
    || typeof viewport.addEventListener !== 'function'
    || typeof viewport.removeEventListener !== 'function'
  ) {
    throw new TypeError(
      'Information popovers require the Document defaultView'
    );
  }
  return viewport;
}

function requireElement(element, label, documentRef) {
  if (
    element === null
    || typeof element !== 'object'
    || element.nodeType !== 1
    || element.ownerDocument !== documentRef
  ) {
    throw new TypeError(`${label} must be an Element from the owned Document`);
  }
  return element;
}

function validatePair(trigger, documentRef) {
  requireElement(trigger, 'Information trigger', documentRef);
  if (trigger.localName !== 'button' || trigger.getAttribute('type') !== 'button') {
    throw new TypeError('Information trigger must be a type="button" element');
  }
  if (!trigger.classList.contains('info-btn')) {
    throw new TypeError('Information trigger must use the info-btn class');
  }

  const triggerId = requireExactText(
    trigger.getAttribute('id'),
    'Information trigger id'
  );
  const label = requireExactText(
    trigger.getAttribute('aria-label'),
    'Information trigger accessible label'
  );
  const controlsId = requireExactText(
    trigger.getAttribute('aria-controls'),
    'Information trigger aria-controls'
  );
  if (!/^[A-Za-z][A-Za-z0-9_:.-]*$/.test(controlsId)) {
    throw new TypeError('Information popover id must be one exact HTML id token');
  }
  if (trigger.getAttribute('aria-haspopup') !== 'dialog') {
    throw new TypeError('Information trigger aria-haspopup must equal dialog');
  }

  const expanded = trigger.getAttribute('aria-expanded');
  if (expanded !== 'false' && expanded !== 'true') {
    throw new TypeError(
      'Information trigger aria-expanded must equal false or true'
    );
  }

  const popover = documentRef.getElementById(controlsId);
  requireElement(popover, 'Information popover', documentRef);
  if (!popover.classList.contains('info-tooltip')) {
    throw new TypeError('Information popover must use the info-tooltip class');
  }
  if (popover.getAttribute('role') !== 'dialog') {
    throw new TypeError('Information popover role must equal dialog');
  }
  if (popover.getAttribute('aria-labelledby') !== triggerId) {
    throw new TypeError(
      'Information popover aria-labelledby must reference its trigger'
    );
  }
  if (popover.getAttribute('tabindex') !== '-1') {
    throw new TypeError('Information popover tabindex must equal -1');
  }
  if ((expanded === 'false') !== popover.hidden) {
    throw new TypeError(
      'Information trigger expansion and popover visibility must agree'
    );
  }

  return { trigger, popover, label };
}

function isSequentiallyFocusable(element, viewport) {
  if (
    !element.isConnected
    || element.hidden
    || element.closest('[hidden], [aria-hidden="true"]') !== null
    || element.getClientRects().length === 0
  ) {
    return false;
  }
  const style = viewport.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function getSequentialFocusTargets(documentRef, viewport, excludedPopover) {
  return Array.from(documentRef.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    element => (
      !excludedPopover.contains(element)
      && isSequentiallyFocusable(element, viewport)
    )
  );
}

/**
 * Initialize the shared information-popover controller.
 *
 * @param {{root: Document}} options
 */
export function initInfoPopovers({ root }) {
  const documentRef = requireDocument(root);
  const viewport = requireViewport(documentRef.defaultView, documentRef);
  let active = null;
  let positionFrame = null;
  let destroyed = false;

  function configurePair(trigger, popover, { id, label }) {
    if (destroyed) {
      throw new Error('Information popover controller is destroyed');
    }
    requireElement(trigger, 'Information trigger', documentRef);
    requireElement(popover, 'Information popover', documentRef);
    const popoverId = requireExactText(id, 'Information popover id');
    const accessibleLabel = requireExactText(
      label,
      'Information trigger accessible label'
    );
    if (!/^[A-Za-z][A-Za-z0-9_:.-]*$/.test(popoverId)) {
      throw new TypeError('Information popover id must be one exact HTML id token');
    }
    const existing = documentRef.getElementById(popoverId);
    if (existing !== null && existing !== popover) {
      throw new Error(`Duplicate information popover id: ${popoverId}`);
    }

    trigger.setAttribute('type', 'button');
    trigger.setAttribute('id', `${popoverId}-trigger`);
    trigger.setAttribute('aria-label', accessibleLabel);
    trigger.setAttribute('aria-controls', popoverId);
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    popover.setAttribute('id', popoverId);
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-labelledby', `${popoverId}-trigger`);
    popover.setAttribute('tabindex', '-1');
    popover.hidden = true;
    if (trigger.localName !== 'button' || !trigger.classList.contains('info-btn')) {
      throw new TypeError(
        'Configured information trigger must be an info-btn button'
      );
    }
    if (!popover.classList.contains('info-tooltip')) {
      throw new TypeError(
        'Configured information popover must use the info-tooltip class'
      );
    }
  }

  function restorePopoverLocation(entry) {
    const {
      popover,
      originalParent,
      originalNextSibling
    } = entry;
    if (!originalParent.isConnected) {
      popover.remove();
      return;
    }
    if (
      originalNextSibling !== null
      && originalNextSibling.parentNode === originalParent
    ) {
      originalParent.insertBefore(popover, originalNextSibling);
      return;
    }
    originalParent.appendChild(popover);
  }

  function cancelScheduledPosition() {
    if (positionFrame === null) return;
    viewport.cancelAnimationFrame(positionFrame);
    positionFrame = null;
  }

  function close({ returnFocus = false } = {}) {
    cancelScheduledPosition();
    if (active === null) return;

    const entry = active;
    active = null;
    entry.trigger.setAttribute('aria-expanded', 'false');
    entry.popover.hidden = true;
    entry.popover.style.removeProperty('left');
    entry.popover.style.removeProperty('top');
    entry.popover.style.removeProperty('visibility');
    entry.popover.removeAttribute('data-placement');
    restorePopoverLocation(entry);

    if (returnFocus && entry.trigger.isConnected) {
      entry.trigger.focus({ preventScroll: true });
    }
  }

  function closeWithin(owner) {
    requireElement(owner, 'Information popover owner', documentRef);
    if (active !== null && owner.contains(active.trigger)) {
      close();
    }
  }

  function positionActive() {
    positionFrame = null;
    if (active === null) return;
    if (!active.trigger.isConnected || !active.popover.isConnected) {
      close();
      return;
    }

    const position = computeInfoPopoverPosition({
      triggerRect: active.trigger.getBoundingClientRect(),
      popoverRect: active.popover.getBoundingClientRect(),
      viewportWidth: viewport.innerWidth,
      viewportHeight: viewport.innerHeight
    });
    active.popover.style.left = `${position.left}px`;
    active.popover.style.top = `${position.top}px`;
    active.popover.dataset.placement = position.placement;
  }

  function schedulePosition() {
    if (active === null || positionFrame !== null) return;
    positionFrame = viewport.requestAnimationFrame(positionActive);
  }

  function open(trigger) {
    if (destroyed) {
      throw new Error('Information popover controller is destroyed');
    }
    const pair = validatePair(trigger, documentRef);
    if (active !== null) close();

    const focusTargets = getSequentialFocusTargets(
      documentRef,
      viewport,
      pair.popover
    );
    const triggerFocusIndex = focusTargets.indexOf(pair.trigger);
    if (triggerFocusIndex < 0) {
      throw new Error('Information trigger must be sequentially focusable');
    }

    active = {
      ...pair,
      originalParent: pair.popover.parentNode,
      originalNextSibling: pair.popover.nextSibling,
      nextFocusTarget: focusTargets[triggerFocusIndex + 1] || null
    };
    documentRef.body.appendChild(pair.popover);
    pair.popover.style.visibility = 'hidden';
    pair.popover.hidden = false;
    pair.trigger.setAttribute('aria-expanded', 'true');
    positionActive();
    pair.popover.style.removeProperty('visibility');
    schedulePosition();
    pair.popover.focus({ preventScroll: true });
  }

  function onClick(event) {
    if (active !== null && active.popover.contains(event.target)) return;
    const trigger = event.target?.closest?.(TRIGGER_SELECTOR) || null;
    if (trigger !== null && trigger.ownerDocument === documentRef) {
      if (active !== null && active.trigger === trigger) {
        close({ returnFocus: true });
      } else {
        open(trigger);
      }
      return;
    }
    if (active !== null) close();
  }

  function onFocusIn(event) {
    if (
      active !== null
      && !active.trigger.contains(event.target)
      && !active.popover.contains(event.target)
    ) {
      close();
    }
  }

  function focusAfterTrigger() {
    const nextTarget = active?.nextFocusTarget || null;
    close();
    nextTarget?.focus({ preventScroll: true });
  }

  function onKeyDown(event) {
    if (active === null) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close({ returnFocus: true });
      return;
    }
    if (event.key !== 'Tab' || !active.popover.contains(documentRef.activeElement)) {
      return;
    }

    const popoverFocusTargets = Array.from(
      active.popover.querySelectorAll(FOCUSABLE_SELECTOR)
    ).filter(element => isSequentiallyFocusable(element, viewport));
    const focused = documentRef.activeElement;

    if (event.shiftKey) {
      if (focused === active.popover || focused === popoverFocusTargets[0]) {
        event.preventDefault();
        close({ returnFocus: true });
      }
      return;
    }

    if (focused === active.popover && popoverFocusTargets.length > 0) {
      event.preventDefault();
      popoverFocusTargets[0].focus({ preventScroll: true });
      return;
    }
    if (
      popoverFocusTargets.length === 0
      || focused === popoverFocusTargets[popoverFocusTargets.length - 1]
    ) {
      event.preventDefault();
      focusAfterTrigger();
    }
  }

  function onViewportChange() {
    schedulePosition();
  }

  function onPageHide(event) {
    if (event.persisted === true) {
      close();
      return;
    }
    destroy();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    close();
    documentRef.removeEventListener('click', onClick);
    documentRef.removeEventListener('focusin', onFocusIn);
    documentRef.removeEventListener('keydown', onKeyDown);
    viewport.removeEventListener('resize', onViewportChange);
    viewport.removeEventListener('scroll', onViewportChange, true);
    viewport.removeEventListener('pagehide', onPageHide);
  }

  for (const trigger of documentRef.querySelectorAll(TRIGGER_SELECTOR)) {
    validatePair(trigger, documentRef);
  }
  documentRef.addEventListener('click', onClick);
  documentRef.addEventListener('focusin', onFocusIn);
  documentRef.addEventListener('keydown', onKeyDown);
  viewport.addEventListener('resize', onViewportChange);
  viewport.addEventListener('scroll', onViewportChange, {
    capture: true,
    passive: true
  });
  viewport.addEventListener('pagehide', onPageHide);

  return Object.freeze({
    close,
    closeWithin,
    configurePair,
    destroy
  });
}
