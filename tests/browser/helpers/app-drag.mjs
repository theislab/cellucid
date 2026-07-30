function requireLocator(locator, label) {
  if (
    locator === null
    || typeof locator !== 'object'
    || typeof locator.elementHandle !== 'function'
    || typeof locator.evaluate !== 'function'
    || typeof locator.scrollIntoViewIfNeeded !== 'function'
    || typeof locator.waitFor !== 'function'
  ) {
    throw new TypeError(`${label} must be a Playwright Locator`);
  }
  return locator;
}

/**
 * Dispatch one deterministic application-level HTML drag.
 *
 * Playwright's physical drag helper depends on engine/host gesture timing.
 * Application drag contracts instead need one shared DataTransfer owner and a
 * deterministic pointer/drag event order. This helper runs that order inside
 * the document so it is reusable for every Cellucid drag surface.
 *
 * @param {import('@playwright/test').Locator} source
 * @param {import('@playwright/test').Locator} target
 * @param {{expectedDataType?: string}} [options]
 */
export async function dispatchAppDrag(
  source,
  target,
  options = {},
) {
  requireLocator(source, 'Drag source');
  requireLocator(target, 'Drag target');
  if (
    options === null
    || typeof options !== 'object'
    || Array.isArray(options)
    || Object.keys(options).some(key => key !== 'expectedDataType')
  ) {
    throw new TypeError(
      'Application drag options may contain only expectedDataType',
    );
  }
  const expectedDataType = options.expectedDataType ?? null;
  if (
    expectedDataType !== null
    && (
      typeof expectedDataType !== 'string'
      || expectedDataType.length === 0
      || expectedDataType !== expectedDataType.trim()
    )
  ) {
    throw new TypeError(
      'Application drag expectedDataType must be a non-empty trimmed string',
    );
  }

  await source.waitFor({ state: 'visible' });
  await target.waitFor({ state: 'visible' });
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const targetHandle = await target.elementHandle();
  if (targetHandle === null) {
    throw new Error('Application drag target detached before dispatch');
  }
  try {
    return await source.evaluate(
      (sourceElement, drag) => {
        const targetElement = drag.targetElement;
        const ownerDocument = sourceElement.ownerDocument;
        const view = ownerDocument.defaultView;
        if (
          view === null
          || !(sourceElement instanceof view.HTMLElement)
          || !(targetElement instanceof view.HTMLElement)
          || targetElement.ownerDocument !== ownerDocument
          || !sourceElement.isConnected
          || !targetElement.isConnected
        ) {
          throw new TypeError(
            'Application drag requires connected HTMLElement owners in one document',
          );
        }

        const sourceRect = sourceElement.getBoundingClientRect();
        const targetRect = targetElement.getBoundingClientRect();
        const sourcePoint = {
          x: sourceRect.left + sourceRect.width / 2,
          y: sourceRect.top + sourceRect.height / 2,
        };
        const targetPoint = {
          x: targetRect.left + targetRect.width / 2,
          y: targetRect.top + targetRect.height / 2,
        };
        const dataTransfer = new view.DataTransfer();
        const pointerEvent = (type, point, buttons) => (
          new view.PointerEvent(type, {
            bubbles: true,
            button: 0,
            buttons,
            cancelable: true,
            clientX: point.x,
            clientY: point.y,
            composed: true,
            isPrimary: true,
            pointerId: 1,
            pointerType: 'mouse',
          })
        );
        const mouseEvent = (type, point, buttons) => (
          new view.MouseEvent(type, {
            bubbles: true,
            button: 0,
            buttons,
            cancelable: true,
            clientX: point.x,
            clientY: point.y,
            composed: true,
          })
        );
        const dragEvent = (type, point, relatedTarget = null) => (
          new view.DragEvent(type, {
            bubbles: true,
            button: 0,
            buttons: type === 'dragend' ? 0 : 1,
            cancelable: true,
            clientX: point.x,
            clientY: point.y,
            composed: true,
            dataTransfer,
            relatedTarget,
          })
        );

        sourceElement.dispatchEvent(
          pointerEvent('pointerdown', sourcePoint, 1),
        );
        sourceElement.dispatchEvent(
          mouseEvent('mousedown', sourcePoint, 1),
        );
        let dragOverAccepted = false;
        let dropAccepted = false;
        try {
          sourceElement.dispatchEvent(
            dragEvent('dragstart', sourcePoint),
          );
          const dataTypes = Array.from(dataTransfer.types);
          if (
            drag.expectedDataType !== null
            && !dataTypes.includes(drag.expectedDataType)
          ) {
            throw new Error(
              `Drag source did not publish ${drag.expectedDataType}`,
            );
          }
          targetElement.dispatchEvent(
            pointerEvent('pointermove', targetPoint, 1),
          );
          targetElement.dispatchEvent(
            mouseEvent('mousemove', targetPoint, 1),
          );
          targetElement.dispatchEvent(
            dragEvent('dragenter', targetPoint, sourceElement),
          );
          dragOverAccepted = !targetElement.dispatchEvent(
            dragEvent('dragover', targetPoint, sourceElement),
          );
          if (!dragOverAccepted) {
            throw new Error(
              'Application drag target did not accept dragover',
            );
          }
          dropAccepted = !targetElement.dispatchEvent(
            dragEvent('drop', targetPoint, sourceElement),
          );
          if (!dropAccepted) {
            throw new Error(
              'Application drag target did not accept drop',
            );
          }
          return {
            dataTypes,
            dragOverAccepted,
            dropAccepted,
          };
        } finally {
          sourceElement.dispatchEvent(
            dragEvent('dragend', targetPoint, targetElement),
          );
          targetElement.dispatchEvent(
            mouseEvent('mouseup', targetPoint, 0),
          );
          targetElement.dispatchEvent(
            pointerEvent('pointerup', targetPoint, 0),
          );
        }
      },
      {
        expectedDataType,
        targetElement: targetHandle,
      },
    );
  } finally {
    await targetHandle.dispose();
  }
}
