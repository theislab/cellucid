import { expect, test } from '@playwright/test';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const PREPARED_DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=ui-keyboard-lifecycle-ci`;

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      errors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return errors;
}

test('highlight pages provide complete roving-tab keyboard workflows', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );

  const tablist = page.getByRole('tablist', { name: 'Highlight pages' });
  await expect(tablist).toHaveAttribute('aria-orientation', 'horizontal');
  let tabs = tablist.getByRole('tab');
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.first()).toHaveAttribute('tabindex', '0');

  await page.getByRole('button', { name: 'Add highlight page' }).click();
  tabs = tablist.getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(0)).toHaveAttribute('tabindex', '-1');

  await page.keyboard.press('ArrowLeft');
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(0)).toBeFocused();
  await expect(tabs.nth(0)).toHaveAttribute('tabindex', '0');
  await expect(tabs.nth(1)).toHaveAttribute('tabindex', '-1');

  await page.keyboard.press('Enter');
  const renameInput = page.getByRole('textbox', { name: 'Rename Page 1' });
  await expect(renameInput).toBeFocused();
  await renameInput.fill('Activated cells');
  await page.keyboard.press('Enter');
  tabs = tablist.getByRole('tab');
  await expect(tabs.nth(0)).toHaveAccessibleName(
    /Activated cells, 0 highlighted cells/
  );
  await expect(tabs.nth(0)).toBeFocused();

  const combineButton = page.getByRole('button', {
    name: 'Combine Activated cells with another page'
  });
  await combineButton.click();
  let combineMenu = page.getByRole('menu', {
    name: 'Combine Activated cells'
  });
  await expect(combineButton).toHaveAttribute('aria-haspopup', 'menu');
  await expect(combineButton).toHaveAttribute('aria-expanded', 'true');
  await expect(combineMenu).toBeVisible();
  const menuItems = combineMenu.getByRole('menuitem');
  await expect(menuItems.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menuItems.nth(1)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(menuItems.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(combineMenu).toHaveCount(0);
  await expect(combineButton).toBeFocused();
  await expect(combineButton).toHaveAttribute('aria-expanded', 'false');

  await combineButton.click();
  combineMenu = page.getByRole('menu', {
    name: 'Combine Activated cells'
  });
  await combineMenu.getByRole('menuitem', {
    name: /Union with Page 2/
  }).click();
  tabs = tablist.getByRole('tab');
  await expect(tabs).toHaveCount(3);
  const combinedTab = tabs.filter({
    has: page.getByText('Activated cells ∪ Page 2', { exact: true })
  });
  await expect(combinedTab).toHaveAttribute('aria-selected', 'true');
  await expect(combinedTab).toBeFocused();

  await page.keyboard.press('Delete');
  tabs = tablist.getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(0)).toBeFocused();
  await expect(tabs.nth(0)).toHaveAttribute('tabindex', '0');

  expect(productErrors).toEqual([]);
});

test('analysis modal owns focus and releases every active pointer interaction on Escape', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );

  const results = await page.evaluate(async () => {
    const {
      createAnalysisModal,
      openModal
    } = await import('/assets/js/app/analysis/ui/components/modal.js');
    const readInlineUserSelect = () => ({
      standard: document.body.style.getPropertyValue('user-select'),
      webkit: document.body.style.getPropertyValue('-webkit-user-select')
    });
    const readEffectiveInlineUserSelect = () => {
      const values = readInlineUserSelect();
      return values.standard || values.webkit;
    };
    const scenarios = [
      {
        expectedCursor: 'ew-resize',
        eventType: 'mouse',
        selector: '.analysis-modal-edge-resize-right'
      },
      {
        expectedCursor: 'col-resize',
        eventType: 'pointer',
        selector: '.analysis-modal-resizer-vertical'
      },
      {
        expectedCursor: 'move',
        eventType: 'mouse',
        selector: '.analysis-modal-header'
      }
    ];
    const outcomes = [];

    for (let index = 0; index < scenarios.length; index++) {
      const scenario = scenarios[index];
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.textContent = `Modal trigger ${index + 1}`;
      document.body.appendChild(trigger);
      trigger.focus();
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = readInlineUserSelect();
      const modal = createAnalysisModal();
      openModal(modal);
      const closeButton = modal.querySelector('.analysis-modal-close');
      const initial = {
        closeFocused: document.activeElement === closeButton,
        labelled:
          modal.getAttribute('aria-labelledby') === modal._title.id,
        modal: modal.getAttribute('aria-modal'),
        role: modal.getAttribute('role')
      };

      closeButton.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Tab'
      }));
      const tabStayedInside = document.activeElement === closeButton;

      const target = modal.querySelector(scenario.selector);
      let capturedPointer = null;
      let releasedPointer = null;
      if (scenario.eventType === 'pointer') {
        Object.defineProperties(target, {
          hasPointerCapture: {
            configurable: true,
            value(pointerId) {
              return capturedPointer === pointerId;
            }
          },
          releasePointerCapture: {
            configurable: true,
            value(pointerId) {
              releasedPointer = pointerId;
              capturedPointer = null;
            }
          },
          setPointerCapture: {
            configurable: true,
            value(pointerId) {
              capturedPointer = pointerId;
            }
          }
        });
        target.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          clientX: 400,
          clientY: 240,
          pointerId: 31
        }));
      } else {
        target.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          clientX: 400,
          clientY: 240
        }));
      }
      const during = {
        cursor: document.body.style.cursor,
        userSelect: readEffectiveInlineUserSelect()
      };

      document.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Escape'
      }));
      if (modal._closePromise === null) {
        throw new Error('Escape did not publish the modal close owner.');
      }
      await modal._closePromise;
      outcomes.push({
        captureReleased:
          scenario.eventType !== 'pointer' ||
          (capturedPointer === null && releasedPointer === 31),
        classesCleared:
          !target.classList.contains('resizing'),
        detached: !modal.isConnected,
        during,
        expectedCursor: scenario.expectedCursor,
        focusRestored: document.activeElement === trigger,
        initial,
        previousUserSelect,
        restoredCursor: document.body.style.cursor === previousCursor,
        restoredUserSelect: readInlineUserSelect(),
        tabStayedInside
      });
      trigger.remove();
    }
    return outcomes;
  });

  for (const result of results) {
    expect(result.initial).toEqual({
      closeFocused: true,
      labelled: true,
      modal: 'true',
      role: 'dialog'
    });
    expect(result.tabStayedInside).toBe(true);
    expect(result.during).toEqual({
      cursor: result.expectedCursor,
      userSelect: 'none'
    });
    expect(result.captureReleased).toBe(true);
    expect(result.classesCleared).toBe(true);
    expect(result.detached).toBe(true);
    expect(result.focusRestored).toBe(true);
    expect(result.restoredCursor).toBe(true);
    expect(result.restoredUserSelect).toEqual(result.previousUserSelect);
  }
  expect(productErrors).toEqual([]);
});

test('community profile modal owns focus, requests, timers, and global listeners', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await page.addInitScript(() => {
    window._simulate_repo_connected = true;
    window._author_mode = true;
  });
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );

  const section = page.locator('#community-annotation-section');
  await section.evaluate(element => {
    if (!(element instanceof HTMLDetailsElement)) {
      throw new TypeError('Community annotation section must be details');
    }
    element.open = true;
  });
  const editProfile = section
    .locator('.community-annotation-identity-actions')
    .getByRole('button', { name: 'Edit', exact: true });
  await expect(editProfile).toBeEnabled();

  await page.evaluate(() => {
    const nativeAddEventListener = window.addEventListener;
    const nativeRemoveEventListener = window.removeEventListener;
    const nativeSetTimeout = window.setTimeout;
    const nativeClearTimeout = window.clearTimeout;
    const nativeFetch = window.fetch;
    const resizeWrappers = new Map();
    const timers = new Map();
    const probe = {
      abortEvents: 0,
      capture: false,
      fetchStarts: 0,
      resizeAdds: 0,
      resizeInvocations: 0,
      resizeRemoves: 0,
      timers,
    };

    window.addEventListener = function trackProfileResize(
      type,
      listener,
      options
    ) {
      if (probe.capture && type === 'resize' && typeof listener === 'function') {
        const wrapped = function countProfileResize(...args) {
          probe.resizeInvocations += 1;
          return listener.apply(this, args);
        };
        resizeWrappers.set(listener, wrapped);
        probe.resizeAdds += 1;
        return nativeAddEventListener.call(this, type, wrapped, options);
      }
      return nativeAddEventListener.call(this, type, listener, options);
    };
    window.removeEventListener = function untrackProfileResize(
      type,
      listener,
      options
    ) {
      if (type === 'resize' && resizeWrappers.has(listener)) {
        const wrapped = resizeWrappers.get(listener);
        resizeWrappers.delete(listener);
        probe.resizeRemoves += 1;
        return nativeRemoveEventListener.call(this, type, wrapped, options);
      }
      return nativeRemoveEventListener.call(this, type, listener, options);
    };
    window.setTimeout = function trackProfileTimer(callback, delay, ...args) {
      let timerId;
      const wrapped = (...callbackArgs) => {
        timers.delete(timerId);
        return callback(...callbackArgs);
      };
      timerId = nativeSetTimeout.call(this, wrapped, delay, ...args);
      if (probe.capture && (delay === 150 || delay === 6500)) {
        timers.set(timerId, delay);
      }
      return timerId;
    };
    window.clearTimeout = function untrackProfileTimer(timerId) {
      timers.delete(timerId);
      return nativeClearTimeout.call(this, timerId);
    };
    window.fetch = function holdOrcidRequest(input, options = {}) {
      const url = typeof input === 'string' ? input : input?.url;
      if (typeof url !== 'string' || !url.startsWith('https://pub.orcid.org/')) {
        return nativeFetch.call(this, input, options);
      }
      probe.fetchStarts += 1;
      const signal = options.signal;
      return new Promise((_resolve, reject) => {
        const rejectAborted = () => {
          probe.abortEvents += 1;
          reject(new DOMException('Synthetic ORCID request aborted', 'AbortError'));
        };
        if (signal?.aborted) {
          rejectAborted();
          return;
        }
        signal?.addEventListener('abort', rejectAborted, { once: true });
      });
    };
    window.__cellucidProfileModalProbe = probe;
  });

  for (const exit of ['close', 'cancel', 'escape', 'save']) {
    await editProfile.click();
    const dialog = page.getByRole('dialog', { name: 'Your identity' });
    await expect(dialog).toBeVisible();
    const disclosure = dialog.locator(
      '.community-annotation-external-lookup-disclosure'
    );
    await expect(disclosure).toBeVisible();
    await expect(disclosure).toHaveText(
      'Typing 3 or more characters in Name or ORCID searches the public ' +
      'ORCID registry. Requests omit credentials and referrer information.'
    );
    const disclosureId = await disclosure.getAttribute('id');
    expect(disclosureId).toMatch(/^cellucid-orcid-disclosure-/);
    await expect(
      dialog.getByRole('combobox', { name: 'Name', exact: true })
    ).toHaveAttribute('aria-describedby', disclosureId);
    await expect(
      dialog.getByRole('combobox', { name: 'ORCID', exact: true })
    ).toHaveAttribute('aria-describedby', disclosureId);
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    if (exit === 'close') {
      await dialog.getByRole('button', { name: 'Close' }).click();
    } else if (exit === 'cancel') {
      await dialog.getByRole('button', { name: 'Cancel' }).click();
    } else if (exit === 'escape') {
      await page.keyboard.press('Escape');
    } else {
      await dialog.getByRole('button', { name: 'Save' }).click();
    }
    await expect(dialog).toHaveCount(0);
    const activeAfterExit = await section.evaluate(sectionElement => ({
      belongsToOrigin: sectionElement.contains(document.activeElement),
      isProfileEdit: document.activeElement?.classList.contains(
        'community-annotation-profile-edit'
      ) || false,
      tag: document.activeElement?.tagName || null,
    }));
    expect(activeAfterExit, `${exit} must restore profile focus`).toEqual({
      belongsToOrigin: true,
      isProfileEdit: true,
      tag: 'BUTTON',
    });
  }

  await page.evaluate(() => {
    window.__cellucidProfileModalProbe.capture = true;
  });
  await editProfile.click();
  const dialog = page.getByRole('dialog', { name: 'Your identity' });
  const orcidInput = dialog.getByPlaceholder(
    'Type a name or ORCID ID (auto-suggest)'
  );
  await orcidInput.fill('😀😀');
  await page.waitForTimeout(350);
  expect(
    await page.evaluate(
      () => window.__cellucidProfileModalProbe.fetchStarts
    )
  ).toBe(0);
  await orcidInput.fill('😀😀😀');
  await expect.poll(
    () => page.evaluate(
      () => window.__cellucidProfileModalProbe.fetchStarts
    ),
    { timeout: 3000 }
  ).toBe(1);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(editProfile).toBeFocused();
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));

  const cleanup = await page.evaluate(() => {
    const probe = window.__cellucidProfileModalProbe;
    return {
      abortEvents: probe.abortEvents,
      pendingTrackedDelays: [...probe.timers.values()].sort((a, b) => a - b),
      resizeAdds: probe.resizeAdds,
      resizeInvocations: probe.resizeInvocations,
      resizeRemoves: probe.resizeRemoves,
    };
  });
  expect(cleanup).toEqual({
    abortEvents: 1,
    pendingTrackedDelays: [],
    resizeAdds: 1,
    resizeInvocations: 0,
    resizeRemoves: 1,
  });
  expect(productErrors).toEqual([]);
});

test('ORCID combobox owns bounded superseded search and complete keyboard selection', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await page.addInitScript(() => {
    window._simulate_repo_connected = true;
    window._author_mode = true;
    const nativeFetch = window.fetch;
    const probe = {
      aborts: 0,
      queries: [],
    };
    window.fetch = function exactOrcidSearch(input, options = {}) {
      const raw = typeof input === 'string' ? input : input?.url;
      if (
        typeof raw !== 'string' ||
        !raw.startsWith(
          'https://pub.orcid.org/v3.0/expanded-search/'
        )
      ) {
        return nativeFetch.call(this, input, options);
      }
      const url = new URL(raw);
      probe.queries.push(url.searchParams.get('q'));
      if (probe.queries.length === 1) {
        return new Promise((_resolve, reject) => {
          const signal = options.signal;
          const rejectAbort = () => {
            probe.aborts += 1;
            reject(
              signal?.reason ??
                new DOMException('Synthetic ORCID supersession', 'AbortError')
            );
          };
          if (signal?.aborted) {
            rejectAbort();
            return;
          }
          signal?.addEventListener('abort', rejectAbort, { once: true });
        });
      }
      return Promise.resolve(new Response(JSON.stringify({
        'expanded-result': [
          {
            'orcid-id': '0000-0002-1825-0097',
            'given-names': 'Alice',
            'family-names': 'Alpha',
          },
          {
            'orcid-id': '0000-0001-5109-3700',
            'given-names': 'Bob',
            'family-names': 'Beta',
          },
          {
            'orcid-id': '0000-0003-1419-2405',
            'given-names': 'Carol',
            'family-names': 'Gamma',
          },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    };
    window.__cellucidOrcidKeyboardProbe = probe;
  });
  await page.goto(PREPARED_DATASET_URL, {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );

  const section = page.locator('#community-annotation-section');
  await section.evaluate(element => {
    if (!(element instanceof HTMLDetailsElement)) {
      throw new TypeError('Community annotation section must be details');
    }
    element.open = true;
  });
  const editProfile = section
    .locator('.community-annotation-identity-actions')
    .getByRole('button', { name: 'Edit', exact: true });
  await editProfile.click();
  const dialog = page.getByRole('dialog', {
    name: 'Your identity',
    exact: true,
  });
  const nameInput = dialog.getByRole('combobox', {
    name: 'Name',
    exact: true,
  });
  const orcidInput = dialog.getByRole('combobox', {
    name: 'ORCID',
    exact: true,
  });
  const listbox = dialog.locator(
    '[role="listbox"][aria-label="ORCID search suggestions"]'
  );
  const expectPopupAnchoredTo = async input => {
    await expect.poll(async () => {
      const [anchor, popup] = await Promise.all([
        input.boundingBox(),
        listbox.boundingBox(),
      ]);
      if (anchor === null || popup === null) return false;
      const aligned =
        Math.abs(popup.x - anchor.x) <= 1 &&
        Math.abs(popup.width - anchor.width) <= 1;
      const below =
        Math.abs(popup.y - (anchor.y + anchor.height + 6)) <= 2;
      const above =
        Math.abs(
          popup.y + popup.height - (anchor.y - 6)
        ) <= 2;
      return aligned && (below || above);
    }).toBe(true);
  };

  await expect(orcidInput).toHaveAttribute(
    'aria-controls',
    await listbox.getAttribute('id')
  );
  await expect(orcidInput).toHaveAttribute('aria-expanded', 'false');
  await orcidInput.fill('First superseded query');
  await expect.poll(
    () => page.evaluate(
      () => window.__cellucidOrcidKeyboardProbe.queries.length
    )
  ).toBe(1);
  await orcidInput.fill('Second exact query');
  await expect.poll(
    () => page.evaluate(
      () => window.__cellucidOrcidKeyboardProbe
    )
  ).toMatchObject({
    aborts: 1,
    queries: ['First superseded query', 'Second exact query'],
  });

  const options = listbox.getByRole('option');
  await expect(options).toHaveCount(3);
  await expect(options.first()).toHaveJSProperty('tagName', 'BUTTON');
  await expect(options.first()).toHaveAttribute('tabindex', '-1');
  await expect(orcidInput).toBeFocused();
  await expect(orcidInput).toHaveAttribute('aria-expanded', 'true');
  await expectPopupAnchoredTo(orcidInput);
  await nameInput.focus();
  await expect(nameInput).toHaveAttribute('aria-expanded', 'true');
  await expectPopupAnchoredTo(nameInput);
  await orcidInput.focus();
  await expect(orcidInput).toHaveAttribute('aria-expanded', 'true');
  await expectPopupAnchoredTo(orcidInput);

  await orcidInput.press('ArrowDown');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(orcidInput).toHaveAttribute(
    'aria-activedescendant',
    await options.nth(0).getAttribute('id')
  );
  await orcidInput.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await orcidInput.press('ArrowUp');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await orcidInput.press('End');
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
  await orcidInput.press('Home');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await orcidInput.press('End');
  await orcidInput.press('Enter');
  await expect(orcidInput).toHaveValue('0000-0003-1419-2405');
  await expect(nameInput).toHaveValue('Carol Gamma');
  await expect(orcidInput).toBeFocused();
  await expect(orcidInput).toHaveAttribute('aria-expanded', 'false');
  await expect(orcidInput).not.toHaveAttribute('aria-activedescendant');
  await expect(listbox).not.toBeVisible();

  // A pre-existing 19-character ORCID must not replace the exact Name edit as
  // the next query owner.
  await nameInput.fill('Existing profile name edit');
  await expect.poll(
    () => page.evaluate(
      () => window.__cellucidOrcidKeyboardProbe.queries.at(-1)
    )
  ).toBe('Existing profile name edit');
  await expect(options).toHaveCount(3);
  await expect(nameInput).toHaveAttribute('aria-expanded', 'true');
  await expect(orcidInput).toHaveAttribute('aria-expanded', 'false');
  await expectPopupAnchoredTo(nameInput);
  await nameInput.press('ArrowDown');
  await expect(nameInput).toHaveAttribute(
    'aria-activedescendant',
    await options.nth(0).getAttribute('id')
  );
  await nameInput.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(listbox).not.toBeVisible();
  await expect(nameInput).toHaveAttribute('aria-expanded', 'false');
  await expect(nameInput).toBeFocused();
  await nameInput.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(editProfile).toBeFocused();

  expect(productErrors).toEqual([]);
});

test('ORCID retry, blur, timeout, and Escape settlements stay with the focused combobox', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await page.addInitScript(() => {
    window._simulate_repo_connected = true;
    window._author_mode = true;
    const nativeFetch = window.fetch;
    const nativeSetTimeout = window.setTimeout;
    const successDocument = {
      'expanded-result': [{
        'orcid-id': '0000-0002-1825-0097',
        'given-names': 'Focused',
        'family-names': 'Researcher',
      }],
    };
    const emptyDocument = { 'expanded-result': [] };
    const response = document => new Response(
      JSON.stringify(document),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );
    const probe = {
      aborts: 0,
      pending: new Map(),
      queries: [],
      retryAttempts: 0,
      shortenTimeout: false,
      settle(query, outcome) {
        const owner = this.pending.get(query);
        if (!owner) {
          throw new Error(
            `Synthetic ORCID request is not pending: ${query}`
          );
        }
        this.pending.delete(query);
        if (outcome === 'empty') {
          owner.resolve(response(emptyDocument));
          return;
        }
        if (outcome === 'failure') {
          owner.reject(new Error('Synthetic unfocused ORCID failure'));
          return;
        }
        throw new Error(`Unknown synthetic ORCID outcome: ${outcome}`);
      },
    };
    window.setTimeout = function exactOrcidTimeout(
      callback,
      delay,
      ...args
    ) {
      const exactDelay =
        probe.shortenTimeout && Number(delay) === 6500
          ? 80
          : delay;
      return nativeSetTimeout.call(this, callback, exactDelay, ...args);
    };
    const pendingRequest = (query, signal) => new Promise(
      (resolve, reject) => {
        const owner = { reject, resolve };
        probe.pending.set(query, owner);
        const abort = () => {
          probe.aborts += 1;
          if (probe.pending.get(query) === owner) {
            probe.pending.delete(query);
          }
          reject(
            signal?.reason ??
              new DOMException('Synthetic ORCID abort', 'AbortError')
          );
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
      }
    );
    window.fetch = function exactOrcidLifecycle(
      input,
      options = {}
    ) {
      const raw = typeof input === 'string' ? input : input?.url;
      if (
        typeof raw !== 'string' ||
        !raw.startsWith(
          'https://pub.orcid.org/v3.0/expanded-search/'
        )
      ) {
        return nativeFetch.call(this, input, options);
      }
      const query = new URL(raw).searchParams.get('q');
      probe.queries.push(query);
      if (query === 'Same exact retry query') {
        probe.retryAttempts += 1;
        if (probe.retryAttempts === 1) {
          return Promise.resolve(response(emptyDocument));
        }
        if (probe.retryAttempts === 2) {
          return Promise.reject(
            new Error('Synthetic focused ORCID failure')
          );
        }
        return Promise.resolve(response(successDocument));
      }
      return pendingRequest(query, options.signal);
    };
    window.__cellucidOrcidLifecycleProbe = probe;
  });
  await page.goto(PREPARED_DATASET_URL, {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );

  const section = page.locator('#community-annotation-section');
  await section.evaluate(element => {
    if (!(element instanceof HTMLDetailsElement)) {
      throw new TypeError('Community annotation section must be details');
    }
    element.open = true;
  });
  const editProfile = section
    .locator('.community-annotation-identity-actions')
    .getByRole('button', { name: 'Edit', exact: true });
  await editProfile.click();
  const dialog = page.getByRole('dialog', {
    name: 'Your identity',
    exact: true,
  });
  const status = dialog.getByRole('status');
  const orcidInput = dialog.getByRole('combobox', {
    name: 'ORCID',
    exact: true,
  });
  const titleInput = dialog.getByRole('textbox', {
    name: 'Affiliation / role',
    exact: true,
  });
  const listbox = dialog.locator(
    '[role="listbox"][aria-label="ORCID search suggestions"]'
  );

  await orcidInput.fill('Debounce blur query');
  await titleInput.focus();
  await page.waitForTimeout(450);
  expect(
    await page.evaluate(
      () => window.__cellucidOrcidLifecycleProbe.queries
    )
  ).not.toContain('Debounce blur query');
  await expect(listbox).not.toBeVisible();
  await expect(orcidInput).toHaveAttribute('aria-expanded', 'false');

  await orcidInput.fill('Same exact retry query');
  await expect(status).toContainText(
    'No ORCID records matched the exact query.'
  );
  await titleInput.focus();
  await page.waitForTimeout(180);
  await orcidInput.focus();
  await expect(status).toContainText(
    'Synthetic focused ORCID failure'
  );
  await titleInput.focus();
  await page.waitForTimeout(180);
  await orcidInput.focus();
  await expect(listbox.getByRole('option')).toHaveCount(1);
  await expect(listbox).toBeVisible();
  await expect(orcidInput).toHaveAttribute('aria-expanded', 'true');
  expect(
    await page.evaluate(
      () => window.__cellucidOrcidLifecycleProbe.retryAttempts
    )
  ).toBe(3);

  await orcidInput.fill('Deferred no-result query');
  await expect.poll(
    () => page.evaluate(
      () => window.__cellucidOrcidLifecycleProbe.queries.at(-1)
    )
  ).toBe('Deferred no-result query');
  await titleInput.focus();
  await page.evaluate(() => {
    window.__cellucidOrcidLifecycleProbe.settle(
      'Deferred no-result query',
      'empty'
    );
  });
  await page.waitForTimeout(250);
  await expect(status).not.toContainText(
    'No ORCID records matched the exact query.'
  );
  await expect(listbox).not.toBeVisible();

  await orcidInput.fill('Deferred failure query');
  await expect.poll(
    () => page.evaluate(
      () => window.__cellucidOrcidLifecycleProbe.queries.at(-1)
    )
  ).toBe('Deferred failure query');
  await titleInput.focus();
  await page.evaluate(() => {
    window.__cellucidOrcidLifecycleProbe.settle(
      'Deferred failure query',
      'failure'
    );
  });
  await page.waitForTimeout(250);
  await expect(status).not.toContainText(
    'Synthetic unfocused ORCID failure'
  );
  await expect(listbox).not.toBeVisible();

  await page.evaluate(() => {
    const probe = window.__cellucidOrcidLifecycleProbe;
    probe.shortenTimeout = true;
    const dialogOwner = document.querySelector(
      '.community-annotation-modal-overlay'
    );
    const orcid = dialogOwner.querySelector(
      'input[aria-label="ORCID"]'
    );
    const title = dialogOwner.querySelector(
      'input[aria-label="Affiliation / role"]'
    );
    orcid.focus();
    orcid.value = 'Deferred timeout query';
    orcid.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => title.focus(), 270);
  });
  await expect.poll(
    () => page.evaluate(
      () => window.__cellucidOrcidLifecycleProbe.queries.at(-1)
    )
  ).toBe('Deferred timeout query');
  await page.waitForTimeout(350);
  await expect(status).not.toContainText(
    'ORCID request timed out'
  );
  await expect(listbox).not.toBeVisible();

  await page.evaluate(() => {
    window.__cellucidOrcidLifecycleProbe.shortenTimeout = false;
  });
  await orcidInput.fill('Escape pending query');
  await expect.poll(
    () => page.evaluate(
      () => window.__cellucidOrcidLifecycleProbe.queries.at(-1)
    )
  ).toBe('Escape pending query');
  const abortsBeforeEscape = await page.evaluate(
    () => window.__cellucidOrcidLifecycleProbe.aborts
  );
  await orcidInput.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(listbox).not.toBeVisible();
  await expect.poll(
    () => page.evaluate(
      () => window.__cellucidOrcidLifecycleProbe.aborts
    )
  ).toBe(abortsBeforeEscape + 1);
  await orcidInput.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(editProfile).toBeFocused();

  expect(productErrors).toEqual([]);
});

test('community profile modal cannot outlive its controls owner', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await page.addInitScript(() => {
    window._simulate_repo_connected = true;
    window._author_mode = true;
  });
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );

  const result = await page.evaluate(async () => {
    const { initCommunityAnnotationControls } = await import(
      '/assets/js/app/ui/modules/community-annotation-controls.js'
    );
    const datasetListeners = new Set();
    const container = document.createElement('div');
    container.id = 'annotation-destroy-audit';
    document.body.appendChild(container);

    const controls = initCommunityAnnotationControls({
      state: {
        getFields() {
          return [];
        },
      },
      dom: { container },
      dataSourceManager: {
        getCurrentDatasetId() {
          return 'current-ui-prepared';
        },
        onDatasetChange(listener) {
          datasetListeners.add(listener);
        },
        offDatasetChange(listener) {
          datasetListeners.delete(listener);
        },
      },
      infoPopovers: {
        closeWithin() {},
        configurePair() {},
      },
    });

    const edit = [...container.querySelectorAll('button')].find(
      button => button.textContent === 'Edit'
    );
    if (!(edit instanceof HTMLButtonElement) || edit.disabled) {
      throw new Error('Synthetic annotation profile Edit button unavailable');
    }
    edit.click();

    for (
      let attempt = 0;
      attempt < 20 &&
        !document.querySelector('.community-annotation-modal-overlay');
      attempt += 1
    ) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const overlay = document.querySelector(
      '.community-annotation-modal-overlay'
    );
    if (!(overlay instanceof HTMLElement)) {
      throw new Error('Synthetic annotation profile modal did not open');
    }

    const markupBeforeDestroy = container.innerHTML;
    const mutations = [];
    const observer = new MutationObserver(records => mutations.push(...records));
    observer.observe(container, { childList: true, subtree: true });

    controls.destroy();
    const survivedDestroy = overlay.isConnected;

    // Let the in-progress edit task observe closure and settle.
    overlay.remove();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    observer.disconnect();

    const outcome = {
      focusRetiredWithOwner: container.contains(document.activeElement),
      listenersRemaining: datasetListeners.size,
      markupStable: container.innerHTML === markupBeforeDestroy,
      postDestroyMutations: mutations.length,
      survivedDestroy,
    };
    container.remove();
    return outcome;
  });

  expect(result).toEqual({
    focusRetiredWithOwner: false,
    listenersRemaining: 0,
    markupStable: true,
    postDestroyMutations: 0,
    survivedDestroy: false,
  });
  expect(productErrors).toEqual([]);
});

test('pending community profile launch cannot cross controls teardown', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await page.addInitScript(() => {
    window._simulate_repo_connected = true;
    window._author_mode = true;
  });
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );

  const result = await page.evaluate(async () => {
    const { initCommunityAnnotationControls } = await import(
      '/assets/js/app/ui/modules/community-annotation-controls.js'
    );
    const datasetListeners = new Set();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const controls = initCommunityAnnotationControls({
      state: {
        getFields() {
          return [];
        },
      },
      dom: { container },
      dataSourceManager: {
        getCurrentDatasetId() {
          return 'current-ui-prepared';
        },
        onDatasetChange(listener) {
          datasetListeners.add(listener);
        },
        offDatasetChange(listener) {
          datasetListeners.delete(listener);
        },
      },
      infoPopovers: {
        closeWithin() {},
        configurePair() {},
      },
    });
    const edit = [...container.querySelectorAll('button')].find(
      button => button.textContent === 'Edit'
    );
    if (!(edit instanceof HTMLButtonElement) || edit.disabled) {
      throw new Error('Synthetic annotation profile Edit button unavailable');
    }

    edit.click();
    controls.destroy();
    const markupAfterDestroy = container.innerHTML;
    const mutations = [];
    const observer = new MutationObserver(records => mutations.push(...records));
    observer.observe(container, { childList: true, subtree: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    observer.disconnect();

    const outcome = {
      listenersRemaining: datasetListeners.size,
      modalCount: document.querySelectorAll(
        '.community-annotation-modal-overlay'
      ).length,
      postDestroyMutations: mutations.length,
      stableMarkup: container.innerHTML === markupAfterDestroy,
    };
    container.remove();
    return outcome;
  });

  expect(result).toEqual({
    listenersRemaining: 0,
    modalCount: 0,
    postDestroyMutations: 0,
    stableMarkup: true,
  });
  expect(productErrors).toEqual([]);
});

test('community profile publication survives reentrant focus lifecycle changes', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await page.addInitScript(() => {
    window._simulate_repo_connected = true;
    window._author_mode = true;
  });
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );

  const result = await page.evaluate(async () => {
    const { initCommunityAnnotationControls } = await import(
      '/assets/js/app/ui/modules/community-annotation-controls.js'
    );
    const createControls = () => {
      const listeners = new Set();
      const container = document.createElement('div');
      document.body.appendChild(container);
      const controls = initCommunityAnnotationControls({
        state: {
          getFields() {
            return [];
          },
        },
        dom: { container },
        dataSourceManager: {
          getCurrentDatasetId() {
            return 'current-ui-prepared';
          },
          onDatasetChange(listener) {
            listeners.add(listener);
          },
          offDatasetChange(listener) {
            listeners.delete(listener);
          },
        },
        infoPopovers: {
          closeWithin() {},
          configurePair() {},
        },
      });
      return { container, controls, listeners };
    };
    const findEdit = container => {
      const edit = [...container.querySelectorAll('button')].find(
        button => button.textContent === 'Edit'
      );
      if (!(edit instanceof HTMLButtonElement) || edit.disabled) {
        throw new Error('Synthetic annotation profile Edit button unavailable');
      }
      return edit;
    };
    const nextTurns = async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
    };

    const autoCloseOwner = createControls();
    const closeOnFocus = event => {
      if (
        event.target instanceof HTMLButtonElement &&
        event.target.classList.contains('community-annotation-modal-close')
      ) {
        event.target.click();
      }
    };
    window.addEventListener('focusin', closeOnFocus);
    findEdit(autoCloseOwner.container).click();
    await nextTurns();
    window.removeEventListener('focusin', closeOnFocus);
    const autoClosed = !document.querySelector(
      '.community-annotation-modal-overlay'
    );

    findEdit(autoCloseOwner.container).click();
    await nextTurns();
    const reopened = document.querySelector(
      '.community-annotation-modal-overlay'
    ) instanceof HTMLElement;
    autoCloseOwner.controls.destroy();
    const autoCloseListenersRemaining = autoCloseOwner.listeners.size;
    autoCloseOwner.container.remove();

    const destroyOwner = createControls();
    let markupAfterReentrantDestroy = null;
    const destroyOnFocus = event => {
      if (
        event.target instanceof HTMLButtonElement &&
        event.target.classList.contains('community-annotation-modal-close')
      ) {
        destroyOwner.controls.destroy();
        markupAfterReentrantDestroy = destroyOwner.container.innerHTML;
      }
    };
    window.addEventListener('focusin', destroyOnFocus);
    findEdit(destroyOwner.container).click();
    await nextTurns();
    window.removeEventListener('focusin', destroyOnFocus);

    const outcome = {
      autoCloseListenersRemaining,
      autoClosed,
      destroyListenersRemaining: destroyOwner.listeners.size,
      destroyedMarkupStable:
        destroyOwner.container.innerHTML === markupAfterReentrantDestroy,
      modalCount: document.querySelectorAll(
        '.community-annotation-modal-overlay'
      ).length,
      reopened,
    };
    destroyOwner.container.remove();
    return outcome;
  });

  expect(result).toEqual({
    autoCloseListenersRemaining: 0,
    autoClosed: true,
    destroyListenersRemaining: 0,
    destroyedMarkupStable: true,
    modalCount: 0,
    reopened: true,
  });
  expect(productErrors).toEqual([]);
});

test('community profile Save surfaces teardown failure after exact cleanup', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await page.addInitScript(() => {
    window._simulate_repo_connected = true;
    window._author_mode = true;
  });
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );

  const section = page.locator('#community-annotation-section');
  await section.evaluate(element => {
    if (!(element instanceof HTMLDetailsElement)) {
      throw new TypeError('Community annotation section must be details');
    }
    element.open = true;
  });
  await section
    .locator('.community-annotation-identity-actions')
    .getByRole('button', { name: 'Edit', exact: true })
    .click();

  const dialog = page.getByRole('dialog', { name: 'Your identity' });
  await expect(dialog).toBeVisible();
  await dialog.evaluate(dialogElement => {
    const content = dialogElement.querySelector(
      '.community-annotation-modal-body'
    );
    if (!(content instanceof HTMLElement)) {
      throw new Error('Community annotation profile content unavailable');
    }
    const cleanup = content.__cellucidCleanup;
    if (typeof cleanup !== 'function') {
      throw new Error('Community annotation profile cleanup unavailable');
    }
    let failed = false;
    content.__cellucidCleanup = () => {
      cleanup();
      if (!failed) {
        failed = true;
        throw new Error('Synthetic profile cleanup failure');
      }
    };
  });

  const pageError = page.waitForEvent('pageerror');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(section.locator('.community-annotation-profile-edit')).toBeFocused();
  const surfacedError = await pageError;
  expect(surfacedError.message).toBe('Synthetic profile cleanup failure');

  const editProfile = section.locator('.community-annotation-profile-edit');
  await editProfile.click();
  const replacementDialog = page.getByRole('dialog', {
    name: 'Your identity'
  });
  await expect(replacementDialog).toBeVisible();
  await replacementDialog.getByRole('button', { name: 'Close' }).click();
  await expect(replacementDialog).toHaveCount(0);
  await expect(editProfile).toBeFocused();

  const unexpectedErrors = productErrors.filter(
    error => !error.includes('Synthetic profile cleanup failure')
  );
  expect(unexpectedErrors).toEqual([]);
  expect(productErrors.filter(
    error => error.includes('Synthetic profile cleanup failure')
  )).toHaveLength(1);
});

test('community voting closes and aborts its pending field load at an exact context boundary', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await page.addInitScript(() => {
    window._simulate_repo_connected = true;
  });
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );

  const result = await page.evaluate(async () => {
    const { getCommunityAnnotationSession } = await import(
      '/assets/js/app/community-annotations/session.js'
    );
    const { openCommunityAnnotationVotingModal } = await import(
      '/assets/js/app/ui/modules/community-annotation-voting-modal.js'
    );
    const session = getCommunityAnnotationSession();
    const openingContext = {
      datasetId: session.getDatasetId(),
      repoRef: session.getRepoRef(),
      userId: session.getCacheUserId()
    };
    const originalSetFieldCategories = session.setFieldCategories;
    let categoryWrites = 0;
    let capturedSignal = null;
    let loadAbortEvents = 0;
    let resolveLoadAbort;
    const loadAborted = new Promise(resolve => {
      resolveLoadAbort = resolve;
    });
    session.setFieldCategories = function countCategoryWrite(...args) {
      categoryWrites += 1;
      return originalSetFieldCategories.apply(this, args);
    };

    let outcome;
    try {
      const field = {
        _isDeleted: false,
        categories: ['T cell', 'B cell'],
        key: 'cell_type',
        kind: 'category',
        loaded: false
      };
      const state = {
        ensureFieldLoaded(_fieldIndex, options) {
          capturedSignal = options.signal;
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
              loadAbortEvents += 1;
              const error = new Error('Synthetic voting field load retired');
              error.name = 'AbortError';
              reject(error);
              resolveLoadAbort();
            }, { once: true });
          });
        },
        getFields() {
          return [field];
        }
      };
      const modal = openCommunityAnnotationVotingModal({
        defaultCatIdx: 0,
        defaultFieldKey: 'cell_type',
        state
      });
      if (modal === null) {
        throw new Error('Synthetic connected voting context did not open');
      }
      if (capturedSignal === null) {
        throw new Error('Voting field load did not receive its context signal');
      }

      session.setCacheContext({
        datasetId: 'voting-context-boundary',
        repoRef: null,
        userId: null
      });
      await loadAborted;
      await Promise.resolve();
      await Promise.resolve();

      outcome = {
        categoryWrites,
        contextAfterRetirement: session.getDatasetId(),
        loadAbortEvents,
        modalConnected: modal.overlay.isConnected,
        signalAborted: capturedSignal.aborted
      };
    } finally {
      session.setFieldCategories = originalSetFieldCategories;
      session.setCacheContext(openingContext);
    }
    return outcome;
  });

  expect(result).toEqual({
    categoryWrites: 0,
    contextAfterRetirement: 'voting-context-boundary',
    loadAbortEvents: 1,
    modalConnected: false,
    signalAborted: true
  });
  expect(productErrors).toEqual([]);
});

test('community annotation legend and settings expose complete keyboard identities', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  const readGlErrorAfterFrames = () => page.evaluate(async () => {
    await new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    return window._cellucidViewer.getGLContext().getError();
  });
  await page.addInitScript(() => {
    window._simulate_repo_connected = true;
    window._author_mode = true;
  });
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );

  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  expect(await readGlErrorAfterFrames()).toBe(0);

  let alphaRow = page.locator('.legend-item', {
    has: page.locator('.legend-label-main', { hasText: /^alpha$/ })
  });
  await expect(alphaRow.locator('.legend-checkbox')).toHaveAccessibleName(
    'Show category alpha'
  );
  await expect(alphaRow.locator('.legend-color-input')).toHaveAccessibleName(
    'Color for category alpha'
  );

  const section = page.locator('#community-annotation-section');
  await section.evaluate(element => {
    if (!(element instanceof HTMLDetailsElement)) {
      throw new TypeError('Community annotation section must be details');
    }
    element.open = true;
  });
  const manage = section.locator('.analysis-accordion-item').filter({
    hasText: 'MANAGE ANNOTATION'
  });
  await manage
    .getByRole('button', { name: /^MANAGE ANNOTATION/ })
    .click();
  const fieldSelect = manage.locator('.field-select > select.obs-select');
  await expect(fieldSelect).toHaveAccessibleName('Categorical obs');
  await fieldSelect.selectOption({ label: 'cell_type' });
  await manage.getByRole('button', { name: 'Add', exact: true }).click();
  expect(await readGlErrorAfterFrames()).toBe(0);

  const annotationSettings = manage.locator(
    '.community-annotation-settings.relative'
  );
  await expect(annotationSettings).toBeVisible();
  await expect(
    annotationSettings.locator('input[type="range"]')
  ).toHaveAccessibleName('Annotatable consensus threshold');
  await expect(
    annotationSettings.locator('input[type="number"]')
  ).toHaveAccessibleName('Annotatable min annotators');

  const derived = section.locator('.analysis-accordion-item').filter({
    hasText: 'DERIVED CONSENSUS COLUMN'
  });
  await derived
    .getByRole('button', { name: /^DERIVED CONSENSUS COLUMN/ })
    .click();
  await expect(
    derived.locator('.field-select.relative > select.obs-select')
  ).toHaveAccessibleName('Annotatable column');
  await expect(
    derived.locator('input[type="text"]')
  ).toHaveAccessibleName('New column key');
  await expect(
    derived.locator('.community-annotation-settings input[type="range"]')
  ).toHaveAccessibleName('Consensus threshold');
  await expect(
    derived.locator('.community-annotation-settings input[type="number"]')
  ).toHaveAccessibleName('Min annotators');

  alphaRow = page.locator('.legend-item', {
    has: page.locator('.legend-label-main', { hasText: /^alpha$/ })
  });
  await expect(alphaRow).toHaveClass(/legend-item-annotating/);
  const voteTrigger = alphaRow.getByRole('button', {
    name: 'Vote on category alpha'
  });
  await expect(voteTrigger).toHaveAttribute('tabindex', '0');

  const highlightButton = alphaRow.getByRole('button', {
    name: 'Highlight category alpha'
  });
  await expect(highlightButton).toHaveAttribute('aria-pressed', 'false');
  await highlightButton.click();
  await expect(highlightButton).toHaveAttribute('aria-pressed', 'true');
  expect(await readGlErrorAfterFrames()).toBe(0);
  await page.evaluate(() => {
    window._cellucidState.clearAllHighlights();
  });
  await expect(highlightButton).toHaveAttribute('aria-pressed', 'false');
  expect(await readGlErrorAfterFrames()).toBe(0);
  await highlightButton.click();
  await expect(highlightButton).toHaveAttribute('aria-pressed', 'true');
  expect(await readGlErrorAfterFrames()).toBe(0);

  await page.evaluate(async () => {
    const state = window._cellucidState;
    const fields = state.getFields();
    const scoreIndex = fields.findIndex(field => field?.key === 'score');
    if (scoreIndex < 0) {
      throw new Error('Prepared fixture score field is unavailable');
    }
    const score = await state.ensureFieldLoaded(scoreIndex, { silent: true });
    if (!(score?.values instanceof Float32Array)) {
      throw new TypeError('Prepared fixture score values must be Float32');
    }
    state.applyContinuousFilter(
      scoreIndex,
      score.values[1],
      score.values[1]
    );
  });
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing 1 of 120 points'
  );
  await expect(alphaRow).toHaveClass(/legend-item-disabled/);
  await expect(alphaRow.locator('.legend-vote-trigger')).toHaveCount(0);
  await expect(alphaRow.locator('.legend-label')).toHaveAttribute(
    'title',
    /Voting unavailable/
  );
  await expect(alphaRow.locator('.legend-checkbox')).toBeDisabled();
  await expect(alphaRow.locator('.legend-color-input')).toBeDisabled();
  await expect(highlightButton).toHaveAttribute('aria-pressed', 'true');
  await expect(highlightButton).toBeEnabled();
  await highlightButton.click();
  await expect(highlightButton).toHaveAttribute('aria-pressed', 'false');
  await expect(highlightButton).toBeDisabled();
  expect(
    await highlightButton.evaluate(
      button => getComputedStyle(button).cursor
    )
  ).toBe('not-allowed');

  await page.evaluate(() => {
    const state = window._cellucidState;
    const scoreIndex = state
      .getFields()
      .findIndex(field => field?.key === 'score');
    if (scoreIndex < 0) {
      throw new Error('Prepared fixture score field is unavailable');
    }
    state.resetContinuousFilter(scoreIndex);
  });
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing all 120 points'
  );
  await expect(alphaRow).not.toHaveClass(/legend-item-disabled/);
  await expect(
    alphaRow.getByRole('button', { name: 'Vote on category alpha' })
  ).toBeEnabled();
  await expect(alphaRow.locator('.legend-label')).toHaveAttribute(
    'title',
    /Voting mode enabled/
  );
  await expect(highlightButton).toBeEnabled();
  await expect(highlightButton).toHaveAttribute('aria-pressed', 'false');

  await voteTrigger.focus();
  const openingVoteHandle = await voteTrigger.elementHandle();
  if (openingVoteHandle === null) {
    throw new Error('Community annotation vote trigger handle is unavailable');
  }
  await voteTrigger.press('Enter');
  let dialog = page.getByRole('dialog', { name: 'Community voting' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText('cell_type • alpha', { exact: true })
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Close' })
  ).toBeFocused();

  await page.evaluate(async () => {
    const { getCommunityAnnotationSession } = await import(
      '/assets/js/app/community-annotations/session.js'
    );
    getCommunityAnnotationSession().setAnnotatableConsensusSettings(
      'cell_type',
      { minAnnotators: 2, threshold: 0.5 }
    );
  });
  expect(await openingVoteHandle.evaluate(element => element.isConnected)).toBe(
    false
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  alphaRow = page.locator('.legend-item', {
    has: page.locator('.legend-label-main', { hasText: /^alpha$/ })
  });
  const currentVoteTrigger = alphaRow.getByRole('button', {
    name: 'Vote on category alpha'
  });
  await expect(currentVoteTrigger).toBeFocused();

  await currentVoteTrigger.press('Space');
  dialog = page.getByRole('dialog', { name: 'Community voting' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText('cell_type • alpha', { exact: true })
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(currentVoteTrigger).toBeFocused();

  await section
    .locator('.community-annotation-identity-actions')
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  const profileDialog = page.getByRole('dialog', { name: 'Your identity' });
  await expect(profileDialog).toBeVisible();
  await expect(
    profileDialog.getByRole('combobox', { name: 'Name', exact: true })
  ).toBeVisible();
  await expect(
    profileDialog.getByRole('textbox', {
      name: 'Affiliation / role',
      exact: true
    })
  ).toBeVisible();
  await expect(
    profileDialog.getByRole('textbox', { name: 'LinkedIn', exact: true })
  ).toBeVisible();
  await expect(
    profileDialog.getByRole('combobox', { name: 'ORCID', exact: true })
  ).toBeVisible();
  await profileDialog.getByRole('button', { name: 'Close' }).click();

  expect(productErrors).toEqual([]);
});

test('community annotation GitHub sync controls expose exact accessible identities', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await page.addInitScript(() => {
    window._simulate_repo_connected = true;
  });
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );

  const section = page.locator('#community-annotation-section');
  await section.evaluate(element => {
    if (!(element instanceof HTMLDetailsElement)) {
      throw new TypeError('Community annotation section must be details');
    }
    element.open = true;
  });
  await section.getByRole('button', { name: 'Connect GitHub…' }).click();

  const dialog = page.getByRole('dialog', { name: 'GitHub sync' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.locator('input[placeholder="Filter repositories…"]')
  ).toHaveAttribute('aria-label', 'Filter repositories');
  await expect(
    dialog.locator('.community-annotation-auto-pull-select')
  ).toHaveAttribute('aria-label', 'Auto pull interval');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);

  expect(productErrors).toEqual([]);
});

test('welcome modal owns focus, contains Tab, and returns it on close', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });

  const modal = page.locator('#welcome-modal');
  const exploreButton = page.locator('#welcome-demo-btn');
  const learnMore = modal.getByRole('link', { name: /Learn More/ });
  const canvas = page.locator('#glcanvas');

  // The modal is `aria-modal="true"`, so focus must enter it and stay inside.
  await expect(modal).toBeVisible();
  await expect(exploreButton).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(learnMore).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(exploreButton).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(learnMore).toBeFocused();
  await expect(canvas).not.toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(exploreButton).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(learnMore).toBeFocused();
  await expect(canvas).not.toBeFocused();

  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );

  // Reopened from a real invoker, closing must hand focus back to it.
  const resetCamera = page.locator('#reset-camera-btn');
  await resetCamera.focus();
  await page.evaluate(async () => {
    const { showWelcomeModal } = await import(
      '/assets/js/app/ui/onboarding/welcome-modal.js'
    );
    if (showWelcomeModal() !== true) {
      throw new Error('Welcome modal did not reopen');
    }
  });
  await expect(modal).toBeVisible();
  await expect(exploreButton).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect(resetCamera).toBeFocused();

  // The explore action owns focus after it closes the modal, and the restored
  // return target must not steal it back.
  await page.evaluate(async () => {
    const { showWelcomeModal } = await import(
      '/assets/js/app/ui/onboarding/welcome-modal.js'
    );
    if (showWelcomeModal() !== true) {
      throw new Error('Welcome modal did not reopen');
    }
  });
  await expect(exploreButton).toBeFocused();
  await exploreButton.click();
  await expect(modal).toBeHidden();
  await expect(page.locator('#dataset-select')).toBeFocused();

  expect(productErrors).toEqual([]);
});

test('licence modal owns focus, contains Tab, and returns it to its link', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );

  const link = page.locator('#license-link');
  const modal = page.locator('#license-modal');
  const closeButton = page.locator('#license-close-btn');
  const body = modal.locator('.license-body');
  const canvas = page.locator('#glcanvas');

  // The licence text scrolls, so it is a declared tab stop in every engine.
  await expect(body).toHaveAttribute('tabindex', '0');

  await link.click();
  await expect(modal).toBeVisible();
  await expect(closeButton).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(body).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(closeButton).toBeFocused();
  await expect(canvas).not.toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(body).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(closeButton).toBeFocused();
  await expect(canvas).not.toBeFocused();

  await closeButton.click();
  await expect(modal).toBeHidden();
  await expect(link).toBeFocused();

  await link.press('Enter');
  await expect(modal).toBeVisible();
  await expect(closeButton).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect(link).toBeFocused();

  await link.press('Enter');
  await expect(modal).toBeVisible();
  await modal.locator('.license-backdrop').click({ position: { x: 4, y: 4 } });
  await expect(modal).toBeHidden();
  await expect(link).toBeFocused();

  expect(productErrors).toEqual([]);
});
