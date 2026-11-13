/**
 * Every control in the interface can be reached, on a desktop and on a phone.
 *
 * A control is reachable when, after scrolling only its own scroll container
 * (`scrollIntoView`):
 *
 * - its center lies inside the viewport, so no fixed bar, selection bar or
 *   panel pushes it off screen;
 * - no ancestor clips it: an `overflow` box that cannot scroll it into view
 *   would trap it;
 * - `elementFromPoint` at its center is the control itself (or a part of it,
 *   or the label that operates it), so nothing covers it — another control's
 *   touch hit area included;
 * - it is in the Tab order, unless it is one item of a roving-tabindex group
 *   whose active item is, or a tool of such an item (a tree row's buttons,
 *   which the row's keys operate);
 * - when it is disabled, it says why (a title, an `aria-describedby`
 *   description, or a hint or status line in its group).
 *
 * Surfaces walked: every sidebar panel with every panel, disclosure and
 * analysis mode open; a floating panel and an analysis window; the welcome,
 * license, confirm and figure-export dialogs; the selection bar; and the
 * community annotation GitHub sync dialog, signed out and signed in, on every
 * step. Layouts: 1440×900 and 1280×720 with a mouse, 390×844 and 844×390 with
 * touch. Each surface reports all of its offenders in one assertion.
 *
 * No pixel snapshots: every check reads geometry, hit testing and ARIA.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome, expectWelcomeShown } from './helpers/welcome.mjs';
import { waitForPageAtRest } from './helpers/dataset-ready.mjs';
import { capability } from './helpers/community-annotation-github.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=ui-reachability-ci';
const WORKER_ORIGIN = 'https://worker.example';

const LAYOUTS = [
  { name: 'desktop 1440×900', use: { viewport: { width: 1440, height: 900 } } },
  { name: 'desktop 1280×720', use: { viewport: { width: 1280, height: 720 } } },
  { name: 'phone 390×844', use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
  { name: 'phone landscape 844×390', use: { viewport: { width: 844, height: 390 }, hasTouch: true } },
];

const ANALYSIS_MODES = ['simple', 'detailed', 'correlation', 'differential', 'signature', 'genesPanel', 'dotplot', 'composition'];

/**
 * Walk the interactive controls under `scope` and return one line per
 * offender. Runs in the page.
 */
async function auditScope(page, scope) {
  return page.evaluate(async scopeSelector => {
    const INTERACTIVE = [
      'button', 'select', 'input:not([type="hidden"])', 'textarea', 'summary', 'a[href]',
      '[tabindex="0"]', '[role="button"]', '[role="switch"]', '[role="tab"]',
      '[role="checkbox"]', '[role="radio"]', '[role="slider"]', '[role="option"]',
    ].join(', ');
    const ROVING_ROLES = new Set(['tab', 'radio', 'option', 'menuitem', 'treeitem', 'gridcell']);
    // A surface opened a moment ago may still be moving (a window or a bar
    // easing in, a transition under way): the walk starts once every finite
    // animation has ended and a frame has drawn the end state. Scrolling a
    // control into view moves nothing else, so one control needs no frame.
    const settled = async () => {
      const finite = () => document.getAnimations().filter(animation => animation.playState === 'running'
        && animation.effect?.getComputedTiming().iterations !== Infinity);
      for (let running = finite(); running.length > 0; running = finite()) {
        await Promise.allSettled(running.map(animation => animation.finished));
      }
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
    };
    const describe = element => {
      if (!element) return 'nothing';
      if (element.id) return `#${element.id}`;
      const classes = [...element.classList].slice(0, 3).map(name => `.${name}`).join('');
      const name = (element.getAttribute('aria-label') || element.textContent || '')
        .trim().replace(/\s+/g, ' ').slice(0, 32);
      return `${element.localName}${classes}${name ? ` "${name}"` : ''}`;
    };
    const effectiveOpacity = element => {
      let opacity = 1;
      for (let node = element; node; node = node.parentElement) {
        opacity *= Number(getComputedStyle(node).opacity);
      }
      return opacity;
    };
    const visibleText = element => {
      if (!element || element.getClientRects().length === 0) return '';
      return (element.textContent || '').trim();
    };
    const disabledReason = element => {
      if ((element.getAttribute('title') || '').trim()) return true;
      for (const id of (element.getAttribute('aria-describedby') || '').split(/\s+/)) {
        if (id && (document.getElementById(id)?.textContent || '').trim()) return true;
      }
      const group = element.closest(
        '.control-block, .control-group, [role="group"], .list-item, .control-box, '
        + '.disclosure-content, .field-select, .accordion-content',
      );
      if (group) {
        for (const hint of group.querySelectorAll(
          '.field-help, .status-line, .empty-state, [role="status"], .legend-help',
        )) {
          if (visibleText(hint)) return true;
        }
      }
      return false;
    };
    const rovingCovered = element => {
      const role = element.getAttribute('role');
      if (!ROVING_ROLES.has(role)) return false;
      const group = element.parentElement?.closest(
        '[role="tablist"], [role="radiogroup"], [role="listbox"], [role="menu"], '
        + '[role="tree"], [role="grid"], [role="toolbar"]',
      );
      if (!group) return false;
      if (group.tabIndex >= 0) return true;
      return [...group.querySelectorAll(`[role="${role}"]`)].some(item => item.tabIndex >= 0);
    };
    const operates = (owner, element) => owner === element
      || (owner.localName === 'label' && (owner.control === element || owner.contains(element)));

    const controls = new Set();
    for (const root of document.querySelectorAll(scopeSelector)) {
      if (root.matches(INTERACTIVE)) controls.add(root);
      for (const element of root.querySelectorAll(INTERACTIVE)) controls.add(element);
    }
    const offenders = [];
    let checked = 0;
    await settled();
    for (const element of controls) {
      if (!element.isConnected || element.getClientRects().length === 0) continue;
      if (element.closest('[aria-hidden="true"]')) continue;
      if (getComputedStyle(element).visibility !== 'visible') continue;
      const first = element.getBoundingClientRect();
      // Visually hidden on purpose (screen-reader text, a native input that a
      // visible label or proxy operates).
      if (first.width < 2 || first.height < 2) continue;
      const name = describe(element);
      if (effectiveOpacity(element) < 0.05) {
        if (!element.matches('input[type="file"], input[type="color"]')) {
          offenders.push(`${name}: drawn invisible (opacity 0)`);
        }
        continue;
      }
      checked += 1;
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const box = element.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      if (x < 0 || x > width || y < 0 || y > height) {
        offenders.push(`${name}: off screen at (${Math.round(x)}, ${Math.round(y)})`);
        continue;
      }
      // An ancestor's overflow clips only what it contains: a fixed-position
      // element (a notification card, kept inside an open dialog so it is
      // not inert there: `keepAboveModals` in `app-dialog.js`) escapes every
      // ancestor up to the one that is its containing block (a transform, a
      // filter, a backdrop filter, perspective or paint containment).
      const containsFixed = style => style.transform !== 'none' || style.perspective !== 'none'
        || style.filter !== 'none' || (style.backdropFilter ?? style.webkitBackdropFilter ?? 'none') !== 'none'
        || /\b(paint|layout|strict|content)\b/.test(style.contain)
        || /\b(transform|perspective|filter)\b/.test(style.willChange);
      let escapingFixed = getComputedStyle(element).position === 'fixed';
      let clipper = null;
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (escapingFixed && !containsFixed(style)) {
          if (style.position === 'fixed') escapingFixed = true;
          continue;
        }
        escapingFixed = style.position === 'fixed';
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const area = node.getBoundingClientRect();
        if (x < area.left - 1 || x > area.right + 1 || y < area.top - 1 || y > area.bottom + 1) {
          clipper = `${describe(node)} (overflow ${style.overflowX} ${style.overflowY})`;
          break;
        }
      }
      if (clipper) {
        offenders.push(`${name}: trapped outside ${clipper}`);
        continue;
      }
      const hit = document.elementFromPoint(x, y);
      const owner = hit?.closest(`${INTERACTIVE}, label`) ?? null;
      const reached = hit !== null
        && (hit === element || element.contains(hit) || (owner !== null && operates(owner, element)));
      if (!reached) {
        offenders.push(`${name}: covered by ${describe(owner ?? hit)}`);
        continue;
      }
      const disabled = element.disabled === true || element.getAttribute('aria-disabled') === 'true';
      if (disabled) {
        if (!disabledReason(element)) offenders.push(`${name}: disabled without a visible reason`);
        continue;
      }
      if (element.closest('[inert]')) {
        offenders.push(`${name}: inert`);
        continue;
      }
      const focusable = element.localName === 'summary' || element.tabIndex >= 0;
      // A tree row's own tools (the history graph's details and More buttons) are the row's keys'
      // (Space opens the details, Shift+F10 the menu: `state/graph.js`), reached through the row.
      const row = element.parentElement?.closest('[role="treeitem"]') ?? null;
      if (!focusable && !rovingCovered(element) && !(row !== null && rovingCovered(row))) {
        offenders.push(`${name}: not in the Tab order (tabindex ${element.tabIndex})`);
      }
    }
    return { checked, offenders };
  }, scope);
}

async function expectReachable(page, scope, label, minimum = 1) {
  const { checked, offenders } = await auditScope(page, scope);
  expect(checked, `${label}: controls walked`).toBeGreaterThanOrEqual(minimum);
  expect(offenders, `${label}: unreachable controls`).toEqual([]);
}

async function dismissNotifications(page) {
  await page.evaluate(async () => {
    const { getNotificationCenter } = await import('/assets/js/app/notification-center.js');
    getNotificationCenter().dismissAll();
  });
  // A dismissed card fades out before it leaves; a fading card's button is
  // not a control anyone can use.
  await expect(page.locator('#notification-center .notification')).toHaveCount(0);
}

/**
 * The opening is over (`waitForPageAtRest`), so what it still had to say is
 * not said over a surface under audit, after the cards were dismissed (a
 * card can stand in the confirm dialog).
 */
const openingDone = page => waitForPageAtRest(page, { timeout: 60_000 });

async function openDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await openingDone(page);
  // A phone opens on the plot with the panel closed, and a closed panel is
  // `inert` (`sidebar-controls.js`): its field is chosen, as a person does,
  // once the panel is open. Playwright 1.65 waits on an inert target
  // ("now times out if the element stays inert", release notes), where
  // earlier versions drove it through the closed panel.
  await chooseCellTypes(page);
}

async function chooseCellTypes(page) {
  await setSheetOpen(page, true);
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  await dismissNotifications(page);
}

const isPhone = page => page.viewportSize().width <= 720;

async function setSheetOpen(page, open) {
  if (!isPhone(page)) return;
  const hidden = await page.locator('#sidebar').evaluate(sidebar => sidebar.classList.contains('hidden'));
  if (hidden === open) {
    // Open from the bar at the foot of the screen (a phone's closed panel);
    // ✕ (#sidebar-toggle) closes it.
    await page.locator(open ? '#phone-sheet-bar' : '#sidebar-toggle').click();
    await expect(page.locator('#sidebar')).toHaveClass(open ? /^(?!.*\bhidden\b)/ : /\bhidden\b/);
    // The sheet rises from the bar; what it shows is final once that is over.
    await expect.poll(() => page.locator('#sidebar').evaluate(sidebar => sidebar.getAnimations().length)).toBe(0);
  }
}

async function openEverySidebarPanel(page) {
  // Lists in a panel render once it shows, on its `<details>`' `toggle`
  // (`ui/core/visibility-gate.js`), a queued task: every one has run once a
  // sentinel `<details>` opened after them has had its own (same task
  // source, in order).
  await page.evaluate(async () => {
    for (const details of document.querySelectorAll('#sidebar details')) details.open = true;
    const sentinel = document.createElement('details');
    sentinel.hidden = true;
    document.body.append(sentinel);
    const toggled = new Promise(resolve => sentinel.addEventListener('toggle', resolve, { once: true }));
    sentinel.open = true;
    await toggled;
    sentinel.remove();
  });
  // Every closed disclosure outside the analysis modes, which open one at a
  // time and are walked separately. A header shows its region in its click
  // (`bindDisclosure`); an exclusive group (Figure export's sections)
  // closes the others, so a few rounds open what can be open at once.
  for (let round = 0; round < 3; round += 1) {
    const opened = await page.evaluate(() => {
      let count = 0;
      for (const header of document.querySelectorAll(
        '#sidebar .disclosure-header[aria-expanded="false"]',
      )) {
        if (header.id.startsWith('analysis-header-')) continue;
        if (header.getClientRects().length === 0) continue;
        header.click();
        count += 1;
      }
      return count;
    });
    if (opened === 0) break;
  }
}

for (const layout of LAYOUTS) {
  test.describe(layout.name, () => {
    test.use(layout.use);

    // The open sidebar, read three ways on one opening. The Tab order is read
    // first, with no analysis mode open; the walk then opens each mode in
    // turn and closes the last, so the standing card is checked over the
    // sidebar as it stood before the walk.
    test('the open sidebar: its Tab order, every control reachable, and none under a standing notification', async ({
      page,
    }) => {
      test.setTimeout(480_000);
      await openDataset(page);
      await setSheetOpen(page, true);
      await openEverySidebarPanel(page);

      await test.step('the sidebar Tab order follows the panels and rows top to bottom', async () => {
        const report = await page.evaluate(() => {
          const positive = [...document.querySelectorAll('[tabindex]')]
            .filter(element => element.tabIndex > 0)
            .map(element => element.id || element.className);
          const scroller = document.querySelector('#sidebar .sidebar-scroll') ?? document.getElementById('sidebar');
          const top = element => element.getBoundingClientRect().top + scroller.scrollTop;
          const panels = [...document.querySelectorAll('#sidebar .accordion-panel')]
            .filter(panel => panel.getClientRects().length > 0);
          const panelOrder = [];
          for (let index = 1; index < panels.length; index += 1) {
            if (top(panels[index]) < top(panels[index - 1])) {
              panelOrder.push(`${panels[index].querySelector('details')?.id} sits above ${panels[index - 1].querySelector('details')?.id}`);
            }
          }
          const FOCUSABLE = 'button, select, input:not([type="hidden"]), textarea, summary, a[href], [tabindex="0"]';
          const rows = [];
          for (const panel of panels) {
            // The header bar (undock, copy) deliberately precedes the panel's
            // summary: it cannot live inside the summary, and before the
            // details it is reached ahead of a long panel body
            // (ensurePanelFrame in dockable-accordions.js). Each of its buttons
            // names its panel. Order is checked from the summary on.
            const items = [...panel.querySelectorAll(FOCUSABLE)].filter(element => {
              if (element.closest('.accordion-panel-actions') !== null) return false;
              if (element.getClientRects().length === 0 || element.tabIndex < 0 && element.localName !== 'summary') return false;
              if (element.disabled) return false;
              const box = element.getBoundingClientRect();
              return box.width >= 2 && box.height >= 2;
            });
            for (let index = 1; index < items.length; index += 1) {
              const previous = items[index - 1].getBoundingClientRect();
              const current = items[index].getBoundingClientRect();
              const sameRow = current.top < previous.bottom - 2 && current.bottom > previous.top + 2;
              const backwards = sameRow
                ? current.left < previous.left - 2
                : current.top < previous.top - 2;
              if (backwards) {
                const name = element => element.id || `${element.localName}.${[...element.classList].join('.')} "${(element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 24)}"`;
                rows.push(`${name(items[index])} comes after ${name(items[index - 1])} but is drawn before it`);
              }
            }
          }
          return { positive, panelOrder, rows };
        });
        expect.soft(report.positive, 'positive tabindex reorders the page').toEqual([]);
        expect.soft(report.panelOrder, 'panels in DOM order down the sidebar').toEqual([]);
        expect(report.rows, 'controls in DOM order within each panel').toEqual([]);
      });

      await test.step('every sidebar control is reachable, panel by panel and mode by mode', async () => {
        await expectReachable(page, '#sidebar', `${layout.name} sidebar`, 60);
        for (const mode of ANALYSIS_MODES) {
          const header = page.locator(`#analysis-header-${mode}`);
          await header.scrollIntoViewIfNeeded();
          if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
          await expect(header).toHaveAttribute('aria-expanded', 'true');
          // A mode fills in asynchronously, `aria-busy` until it has settled
          // (`_claimBusy`, base-analysis-ui.js), and moves every header below
          // it while it grows: its controls are walked, and the next header
          // clicked, once it is done.
          await expect(page.locator(`#analysis-panel-${mode}`)).not.toHaveAttribute('aria-busy', 'true');
          await page.evaluate(region => {
            for (const inner of document.querySelectorAll(
              `#${region} .disclosure-header[aria-expanded="false"]`,
            )) inner.click();
          }, `analysis-panel-${mode}`);
          await expectReachable(
            page, `#analysis-panel-${mode}`, `${layout.name} analysis ${mode}`,
          );
        }
        // The modes open one at a time: close the one the walk ended on.
        const last = page.locator(`#analysis-header-${ANALYSIS_MODES.at(-1)}`);
        await last.scrollIntoViewIfNeeded();
        await last.click();
        await expect(last).toHaveAttribute('aria-expanded', 'false');
      });

      await test.step('a standing notification never hides a control on the sidebar or the selection bar', async () => {
        await page.evaluate(async () => {
          const { getNotificationCenter } = await import('/assets/js/app/notification-center.js');
          getNotificationCenter().progress('Downloading expression matrix', 40, { duration: 0 });
        });
        await expect(page.locator('.notification-progress')).toBeVisible();
        // The card has stopped easing in, so its box is the one a touch meets.
        await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running'
          && animation.effect?.getComputedTiming().iterations !== Infinity).length)).toBe(0);
        // Cards let a touch through to what lies under them, so the walk also
        // checks that no card is drawn over a control's center.
        const covered = await page.evaluate(async () => {
          const cards = [...document.querySelectorAll('#notification-center .notification')];
          const out = [];
          for (const element of document.querySelectorAll(
            '#sidebar :is(button, select, input:not([type="hidden"]), textarea, summary, a[href]), #select-bar :is(button, select)',
          )) {
            if (element.getClientRects().length === 0) continue;
            const first = element.getBoundingClientRect();
            if (first.width < 2 || first.height < 2) continue;
            element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            const box = element.getBoundingClientRect();
            const x = box.left + box.width / 2;
            const y = box.top + box.height / 2;
            for (const card of cards) {
              const area = card.getBoundingClientRect();
              if (x >= area.left && x <= area.right && y >= area.top && y <= area.bottom) {
                out.push(element.id || `${element.localName}.${[...element.classList].join('.')} "${(element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 24)}"`);
              }
            }
          }
          return out;
        });
        expect(covered, 'controls drawn under a notification after scrolling').toEqual([]);
      });
    });

    // The surfaces over the plot, on one opening: the dialogs first (the
    // welcome is walked as startup shows it), each closed before the next;
    // then the selection bar, left as it was found; then the windows.
    test('dialogs, the selection bar, a floating panel and an analysis window keep every control reachable', async ({
      page,
    }) => {
      test.setTimeout(300_000);

      await test.step('dialogs keep every control reachable', async () => {
        await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
        await expectWelcomeShown(page);
        await expectReachable(page, '#welcome-modal', `${layout.name} welcome`, 2);
        await page.keyboard.press('Escape');
        await expect(page.locator('#welcome-modal')).toBeHidden();
        await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
        await openingDone(page);
        await dismissNotifications(page);

        await page.evaluate(() => document.getElementById('license-link').click());
        await expect(page.locator('#license-modal')).toBeVisible();
        await expectReachable(page, '#license-modal', `${layout.name} license`, 1);
        await page.locator('#license-close-btn').click();
        await expect(page.locator('#license-modal')).toBeHidden();

        await page.evaluate(async () => {
          const { showConfirmDialog } = await import('/assets/js/app/ui/components/confirm-dialog.js');
          showConfirmDialog({
            title: 'Rename field',
            message: 'Choose a new name for this field.',
            confirmText: 'Rename',
            inputLabel: 'Field name',
            inputDefaultValue: 'cell_type',
            onConfirm: () => {},
          });
        });
        await expect(page.locator('.confirm-dialog')).toBeVisible();
        await expectReachable(page, 'dialog.confirm-dialog', `${layout.name} confirm`, 3);
        await page.keyboard.press('Escape');
        await expect(page.locator('dialog.confirm-dialog')).toHaveCount(0);

        await page.evaluate(async () => {
          const { confirmExportFidelityWarnings } = await import(
            '/assets/js/app/ui/modules/figure-export/components/fidelity-warning-dialog.js'
          );
          window.__reachabilityFidelity = confirmExportFidelityWarnings({
            warnings: [
              { title: 'Smoke is not exported', detail: 'The figure shows points only.' },
              { title: 'Lighting differs', detail: 'Exported points use flat shading.' },
            ],
          });
        });
        await expect(page.locator('.figure-export-modal')).toBeVisible();
        await expectReachable(page, '.figure-export-modal', `${layout.name} figure export`, 1);
        await page.keyboard.press('Escape');
        await expect(page.locator('.figure-export-modal')).toBeHidden();
      });

      // The field every other walk of this file starts from, chosen in the open panel.
      await chooseCellTypes(page);

      await test.step('the selection bar keeps every control reachable', async () => {
        await setSheetOpen(page, false);
        await page.evaluate(() => {
          const toggle = document.getElementById('select-bar-mode');
          if (toggle.getAttribute('aria-checked') !== 'true') toggle.click();
        });
        await expect(page.locator('#select-bar-mode')).toHaveAttribute('aria-checked', 'true');
        await dismissNotifications(page);
        await expectReachable(page, '#select-bar', `${layout.name} selection bar`, 4);
        // Select mode off again, as it was.
        await page.evaluate(() => document.getElementById('select-bar-mode').click());
        await expect(page.locator('#select-bar-mode')).toHaveAttribute('aria-checked', 'false');
      });

      await test.step('a floating panel and an analysis window keep every control reachable', async () => {
        await setSheetOpen(page, true);
        await page.evaluate(() => {
          document.getElementById('page-analysis-section').open = true;
        });
        await page.locator('#analysis-header-genesPanel').scrollIntoViewIfNeeded();
        await page.locator('#analysis-header-genesPanel').click();
        // The window is sized from the row: copied once the row has filled in.
        await expect(page.locator('#analysis-panel-genesPanel')).not.toHaveAttribute('aria-busy', 'true');
        // Clicked as a person does: Playwright presses it only once it is
        // still, enabled, not inert and what the press lands on. A forced
        // click skips every one of those and can open no window, with nothing to
        // say what took the press.
        await page.locator('.analysis-mode[data-mode="genesPanel"] .analysis-mode-copy-btn')
          .click();
        const analysisWindow = page.locator('#floating-panels-root .analysis-window-frame');
        await expect(analysisWindow).toHaveCount(1);
        // Its copy of the analysis fills in too (`aria-busy` until it has).
        await expect(analysisWindow.locator('[aria-busy="true"]')).toHaveCount(0);
        await setSheetOpen(page, false);
        await dismissNotifications(page);
        await expectReachable(
          page, '#floating-panels-root .analysis-window-frame', `${layout.name} analysis window`, 3,
        );

        // A second window opens where it leaves the first one's header in
        // reach, so neither has to be dragged away to get at the other.
        await setSheetOpen(page, true);
        const frame = page.locator('.accordion-panel:has(> #coloring-filtering-section)');
        const undock = frame.locator('> .accordion-panel-actions > .accordion-undock-btn');
        await undock.scrollIntoViewIfNeeded();
        await undock.click();
        await expect(frame).toHaveClass(/\baccordion-floating\b/);
        await setSheetOpen(page, false);
        await dismissNotifications(page);
        await expectReachable(
          page, '.accordion-panel:has(> #coloring-filtering-section)', `${layout.name} floating panel`, 8,
        );
        await expectReachable(
          page,
          '#floating-panels-root .analysis-window-frame > :is(.accordion-panel-actions, .accordion-section > summary)',
          `${layout.name} first window's header under the second window`,
          1,
        );
      });
    });

    test('the community annotation GitHub sync dialog is reachable on every step', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await page.addInitScript(workerOrigin => {
        window.__CELLUCID_GITHUB_WORKER_ORIGIN__ = workerOrigin;
        sessionStorage.setItem('cellucid:github-app-auth:session', JSON.stringify({
          expiresAt: 4102444800000,
          token: 'reachability-token',
          user: { id: 4242, login: 'tester' },
        }));
      }, WORKER_ORIGIN);
      await page.route(`${WORKER_ORIGIN}/**`, route => route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Not Found' }),
      }));
      await page.route(`${WORKER_ORIGIN}/`, route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(capability()),
      }));
      await page.route(`${WORKER_ORIGIN}/auth/user`, route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 4242, login: 'tester' }),
      }));
      // One page each (`?page=1`), as the Worker answers a collection.
      await page.route(url => url.origin === WORKER_ORIGIN && url.pathname === '/auth/installations', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [{ id: 501, account: { login: 'team' } }], nextPage: null }),
      }));
      await page.route(url => url.origin === WORKER_ORIGIN && url.pathname === '/auth/installation-repos', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: Array.from({ length: 6 }, (_, index) => ({
            id: index + 1,
            full_name: `team/labels-${index + 1}`,
            private: index % 2 === 0,
          })),
          nextPage: null,
        }),
      }));
      await openDataset(page);
      await setSheetOpen(page, true);
      const section = page.locator('#community-annotation-section');
      await section.evaluate(details => { details.open = true; });
      await expectReachable(page, '#community-annotation-section', `${layout.name} community panel`, 1);
      await section.getByRole('button', { name: 'Connect repo', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'GitHub sync', exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('.community-annotation-repo-card').first()).toBeVisible();
      await dismissNotifications(page);
      const next = dialog.locator('.community-annotation-wizard-next');
      for (let step = 1; step <= 4; step += 1) {
        await expectReachable(
          page, '.community-annotation-dialog:not(.community-annotation-details-dialog)', `${layout.name} GitHub sync step ${step}`, 2,
        );
        if (!(await next.isVisible()) || (await next.isDisabled())) break;
        await next.click();
      }
    });
  });
}
