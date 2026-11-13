/**
 * The control walk: every control produces a step, the drift guard of the
 * action layer (`assets/js/app/actions/README.md`, "Drift guards"). Its tests
 * are declared by the spec files `control-walk-<k>-of-<n>.spec.mjs`, each
 * holding a share (`declareWalkTests`).
 *
 * The walk discovers the interactive surface the way assistive technology
 * meets it, from the page itself, never from a list of controls: every
 * visible element with an interactive role (buttons, switches, check boxes,
 * selects, sliders, text fields, tabs, menu items, section headers) in the
 * sidebar, its sections and the legend, the floating panels and analysis
 * windows, the toolbars and the select bar, and the canvas itself (a camera
 * gesture). What a control opens, makes or enables (a menu, a dialog, an
 * expander, a new page tab, an analysis's options, an Apply button) is
 * walked too, shown again through the controls that opened it. The control
 * inventory cross-checks it: every setting `settings.list` names that was
 * shown must have been walked, so a control the discovery misses fails by
 * name.
 *
 * Each control is operated the way its role is (clicked, toggled, another
 * option chosen, a slider moved one key step, a value typed and entered),
 * then the walk waits for the dispatcher and the history to be idle and
 * asserts, from the state fingerprint (`app/state/domains/fingerprint.js`)
 * and the history (`app/history/history.js`):
 *
 * - nothing differs from what the history shows (`shownHashes`): a change
 *   that made no step names its domains and fails;
 * - no "Changed outside the history" step was kept;
 * - a changed fingerprint came with exactly one new step (a drag's events
 *   amend it) with a label, and undo puts every domain back exactly;
 * - a history control (a step shown, a tracker, a deleted step, a rename)
 *   moved the history, which shows exactly the values it records.
 *
 * A control that changes nothing (an info button, a menu, a dialog, a
 * download, a file picker, an expander) is recognized by that effect, not
 * by a list. Left out are links (they leave the page) and the few controls
 * that replace the dataset, sign in or delete what this browser keeps, each
 * listed below with why. A control a click cannot reach (something covers
 * it) is pressed from the keyboard and listed; one shown once through other
 * controls but not again (a panel's draft changed since) is listed as
 * unreached. After each control
 * the history is put back as it was (`history.load` of the tree saved
 * where the control began: the scene, or for a control shown through others
 * the state they made), so every control the scene shows starts from the
 * scene, and siblings from what opened them.
 *
 * Scenes: the fixture dataset (categories, a continuous field, genes, two
 * embeddings) colored by a category, with a highlight and a kept view; then
 * colored by a continuous field; by a gene; with the kept view selected
 * showing the 3D embedding; with camera path keyframes. A control walked in
 * an earlier scene is not walked again. The walk is split into parts, a
 * test each (`PARTS`: a section of the sidebar each, then everything outside
 * them), spread over the spec files, a share each, filled by weight
 * (`control-walk-parts.mjs`). Playwright shards by test
 * count, so in a shard of the whole suite these few long tests would fall
 * together: CI runs the walk in a job of its own, a share a job
 * (`CELLUCID_CONTROL_WALK=only` and `--shard=<k>/<n>`, a file each; the
 * browser job's shards set it `apart`: `playwright.config.mjs`,
 * `.github/workflows/test.yml`). One part is walked alone with
 * `--grep "<section id>"`. Another
 * test walks the Visualization section of a dataset with neighbor graphs
 * and vector fields (their controls show only there). A control is judged by
 * what it does, never by how long it takes: the walk is bounded by its
 * progress (`untilHung`, `keepPartAlive`). The report lists every control and
 * what it did, a line each as it is walked, then where the time went (by
 * section, the slowest controls, by phase).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from './test.mjs';
import { APP_ORIGIN, ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './origins.mjs';
import { dismissWelcome } from './welcome.mjs';
import { waitForDatasetReady, waitForPageAtRest } from './dataset-ready.mjs';
import { takeSteps, waitForHistory } from './state-history.mjs';
import { chooseFiles } from './file-input.mjs';
import {
  GRAPH_AND_VECTORS, LEFT_OUT, OUTSIDE_SECTIONS, PARTS, SECTIONS, WALK_TESTS, readWalkWeights, recordWalkWeight, recordsWalkWeights,
  walkShares,
} from './control-walk-parts.mjs';

const FIXTURE_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui`;
/** 300 cells with three neighbor graphs and vector fields (`fixtures/README.md`). */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRAPH_AND_VECTORS_FILE = path.join(HERE, '..', 'fixtures', 'data-mapping-full.h5ad');
const CELLS = 120;
/** The section a control is in (its outermost), or OUTSIDE_SECTIONS. */
function sectionOf(control) {
  return SECTIONS.find(id => control.places.includes(id)) ?? OUTSIDE_SECTIONS;
}

/*
 * Time. The walk asserts what a control does (one step per change, exact
 * undo), never how fast it does it: a control that ends, however slowly, is
 * judged like any other, and its time is in the report (each control's line
 * in `control-walk.json`, the slowest in the time report). Most of a
 * control's time is the page's own frames (`settle` waits for frames to agree,
 * a Playwright action for its element to stand still), so it follows the
 * renderer: under the CI runners' software GL a frame with the velocity
 * overlay flowing or smoke animating takes about half a second, and each
 * such control tens of seconds where a GPU takes under one, so no fixed
 * budget a control fits both (measured:
 * 38_decisions_testing_and_hosted_runners.md).
 *
 * What bounds the walk is progress, measured on the page it walks: a wait of
 * the walk (`timed`) that has not ended after `HANG_FACTOR` times the slowest
 * wait this part has seen end, and at least `HANG_FLOOR_MS`, is a hang
 * (`untilHung`): the control is named and the part ends, since its page is no
 * longer the one the next control expects. The part's test timeout moves
 * with each wait that ends (`keepPartAlive`), so a part takes as long as its
 * controls do. A Playwright action waits for its element for
 * `ACTION_FRAMES` of the page's frames, as slowly as the last settle measured
 * them, and at least `ACTION_TIMEOUT_MS` (`actionTimeout`).
 */
/** The least time a wait of the walk is left before it is a hang (`untilHung`). */
const HANG_FLOOR_MS = 120_000;
/** A wait is a hang after this many times the slowest wait the part has seen end. */
const HANG_FACTOR = 10;
/** The least time one Playwright action on a control may wait for it. */
const ACTION_TIMEOUT_MS = 5_000;
/** The page's frames one Playwright action may wait for (actionability: stable over frames, retried hit tests). */
const ACTION_FRAMES = 20;
/**
 * How deep the walk follows what a control opens: a menu (1), a dialog it
 * opens (2), a control of that dialog (3). Deeper surfaces of this app are
 * the same controls again.
 */
const MAX_DEPTH = 3;

/** Where the walk's time goes, by phase: phase → {ms, count}; printed with the report. */
const PHASES = new Map();
/**
 * The walk's progress (`timed`, read by `untilHung` and `keepPartAlive`): when
 * a wait last ended, the slowest wait seen to end, and the slowest frame the
 * last settle waited for (ms).
 */
const PROGRESS = { lastAt: 0, slowestMs: 0, frameMs: 0, onProgress: null };
/**
 * Time a wait of the walk (`phase`), and count its end as progress. A phase
 * that holds other timed waits (`inclusive`) is reported, but is not a wait
 * of its own: its length is the sum of theirs.
 */
async function timed(phase, task, { inclusive = false } = {}) {
  const start = performance.now();
  try {
    return await task();
  } finally {
    const end = performance.now();
    const entry = PHASES.get(phase) ?? { ms: 0, count: 0 };
    entry.ms += end - start;
    entry.count += 1;
    PHASES.set(phase, entry);
    if (!inclusive) PROGRESS.slowestMs = Math.max(PROGRESS.slowestMs, end - start);
    PROGRESS.lastAt = end;
    PROGRESS.onProgress?.();
  }
}

/** How long a wait of the walk may go on before it is a hang. */
function hangAfterMs() {
  return Math.max(HANG_FLOOR_MS, HANG_FACTOR * PROGRESS.slowestMs);
}

/** How long one Playwright action may wait for its element, at the page's measured frame rate. */
function actionTimeout() {
  return Math.max(ACTION_TIMEOUT_MS, Math.ceil(ACTION_FRAMES * PROGRESS.frameMs));
}

/**
 * Keep the running test's timeout (`testInfo`) a hang's allowance and as
 * much again ahead of the walk's last progress, so the walk's own bound
 * (`untilHung`) names a hung control before the test times out, and a part
 * that keeps making progress never does.
 */
function keepPartAlive(testInfo) {
  // A test's progress is its own (the tests of a worker share the module).
  Object.assign(PROGRESS, { lastAt: performance.now(), slowestMs: 0, frameMs: 0 });
  let extendedAt = PROGRESS.lastAt;
  let headroom = 2 * hangAfterMs();
  testInfo.setTimeout(headroom);
  PROGRESS.onProgress = () => {
    const now = performance.now();
    const next = 2 * hangAfterMs();
    if (now - extendedAt < 1_000 && next === headroom) return;
    testInfo.setTimeout(Math.ceil(testInfo.timeout + (now - extendedAt) + (next - headroom)));
    extendedAt = now;
    headroom = next;
  };
}

/**
 * Controls the walk does not operate, by what they are (a role), each with
 * why. No control is left out by its id here; the few left out one by one
 * are `LEFT_OUT` (`control-walk-parts.mjs`).
 */
const LEFT_OUT_ROLES = Object.freeze({
  link: 'a link leaves the page or opens another one; it changes no state',
  file: 'a file input opens the system file picker, outside the page',
});

/** The part a section (or OUTSIDE_SECTIONS) is walked in. */
function partOfSection(section) {
  return PARTS.includes(section) ? section : OUTSIDE_SECTIONS;
}

function leftOutReason(control) {
  if (Object.hasOwn(LEFT_OUT_ROLES, control.role)) return LEFT_OUT_ROLES[control.role];
  const entry = LEFT_OUT.find(item => (item.key !== undefined && item.key === control.key)
    || (item.name !== undefined && item.name === control.name)
    || (item.place !== undefined && control.places.includes(item.place)
      && (item.namePrefix === undefined || control.name.startsWith(item.namePrefix))));
  return entry?.why ?? null;
}

/**
 * The walker's page side: discovery, marking a control for the locator,
 * the fingerprint and the history facts, settling, saving and putting back
 * the history. Installed once per page.
 */
async function installWalker(page) {
  await page.evaluate(async () => {
    const { getActions, getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint } = await import('/assets/js/app/state/domains/fingerprint.js');
    const { isGeneratedDomId } = await import('/assets/js/app/ui/components/dom-id.js');
    const { historySettings, setHistorySetting } = await import('/assets/js/app/history/history-settings.js');

    const INTERACTIVE = [
      'button', 'input', 'select', 'textarea', 'summary', 'a[href]', '[role="button"]', '[role="menuitem"]',
      '[role="menuitemcheckbox"]', '[role="menuitemradio"]', '[role="tab"]', '[role="switch"]', '[role="checkbox"]',
      '[role="radio"]', '[role="slider"]', '[role="option"]', '[role="combobox"]', '[contenteditable="true"]',
    ].join(', ');
    // Not controls of the app: the page's own frame (welcome, license, the
    // text for search engines, the footer) and the notifications.
    const OUTSIDE = '#welcome-modal, #license-modal, main.sr-only, #copyright, #notification-center';
    const INPUT_ROLES = {
      checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', color: 'color', file: 'file',
      button: 'button', submit: 'button', reset: 'button', search: 'searchbox',
    };

    const clean = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
    // An id minted on this page, or made from one (`<minted>-trigger`, `<scope>-method-<minted>`),
    // names nothing on the next draw: it holds the minted separator (`dom-id.js`).
    const stableId = element => (!element.id || isGeneratedDomId(element.id) ? null : element.id);

    function roleOf(element) {
      const explicit = element.getAttribute('role');
      if (explicit) return explicit;
      switch (element.tagName) {
        case 'A': return 'link';
        case 'SUMMARY': return 'summary';
        case 'SELECT': return 'select';
        case 'TEXTAREA': return 'textbox';
        case 'BUTTON': return 'button';
        case 'INPUT': return INPUT_ROLES[element.type] ?? 'textbox';
        default: return element.isContentEditable ? 'textbox' : 'other';
      }
    }

    function nameOf(element) {
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = clean(labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' '));
        if (text) return text;
      }
      const label = element.getAttribute('aria-label');
      if (label && label.trim()) return clean(label);
      if (element.labels?.length) {
        const text = clean([...element.labels].map(item => item.textContent).join(' '));
        if (text) return text;
      }
      const text = clean(element.textContent);
      if (text && element.tagName !== 'SELECT') return text;
      return clean(element.title || element.getAttribute('placeholder') || element.value || '');
    }

    /** The stable ids around a control, nearest first. */
    function placesOf(element) {
      const places = [];
      for (let node = element.parentElement; node !== null; node = node.parentElement) {
        const id = stableId(node);
        if (id !== null) places.push(id);
      }
      return places;
    }

    function shown(element) {
      if (element.closest(OUTSIDE) !== null) return false;
      if (element.closest('[inert]') !== null) return false;
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    }

    function enabled(element) {
      return !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true';
    }

    /** Every control shown now as [element, key], keys that find it again after a redraw. */
    function controls() {
      const out = [];
      const seen = new Map();
      for (const element of document.querySelectorAll(INTERACTIVE)) {
        if (!shown(element)) continue;
        const id = stableId(element);
        let key;
        if (id !== null) {
          key = `#${id}`;
        } else {
          // Counts and times in a name follow the state and the clock ("40 cells. Keep only
          // some…", "Step 3: …, just now", "…, 1 minute ago": the State panel's `formatAgo`):
          // a key does not.
          const steady = nameOf(element)
            .replace(/\b(?:just now|\d+ (?:minute|hour|day)s? ago)\b/g, '<when>')
            .replace(/\d[\d,.]*/g, '#');
          const base = `${placesOf(element)[0] ?? 'page'} › ${roleOf(element)} "${steady}"`;
          const count = seen.get(base) ?? 0;
          seen.set(base, count + 1);
          key = count === 0 ? base : `${base} (${count + 1})`;
        }
        out.push([element, key]);
      }
      const canvas = document.getElementById('glcanvas');
      if (canvas !== null && shown(canvas)) out.push([canvas, '#glcanvas']);
      return out;
    }

    function discover() {
      return controls().map(([element, key]) => ({
        key,
        role: element.id === 'glcanvas' ? 'canvas' : roleOf(element),
        name: nameOf(element) || element.id,
        places: placesOf(element),
        enabled: enabled(element),
        // The control just operated (`mark`), whatever it is called now: a
        // control that renames itself as it answers ("Copy" -> "Copied", back
        // a moment later) is not a control it opened.
        walked: element.hasAttribute('data-walk-target'),
      }));
    }

    /**
     * Mark the control `key` names (`data-walk-target`) when it is shown and
     * enabled now; false when it is not (a disabled one is not marked).
     */
    function mark(key) {
      for (const element of document.querySelectorAll('[data-walk-target]')) element.removeAttribute('data-walk-target');
      const found = controls().find(([, candidate]) => candidate === key);
      if (found === undefined) return 'not shown';
      if (found[0].id !== 'glcanvas' && !enabled(found[0])) return 'disabled';
      found[0].setAttribute('data-walk-target', '1');
      return 'marked';
    }

    function history() {
      return window._cellucidHistories?.current() ?? null;
    }

    /** The history's facts: which history, tracker, head, steps. */
    function tree() {
      const current = history();
      const active = current?.active ?? null;
      if (active === null) return null;
      const steps = [...active.steps.values()];
      return {
        history: current === window.__walk.history ? 'same' : 'replaced',
        tracker: active.id,
        trackers: current.trackers().map(item => `${item.id}:${item.name}`),
        head: active.headId,
        branch: active.activeBranch,
        tip: active.branches.get(active.activeBranch).tip,
        ids: steps.map(step => step.id),
        outside: steps.filter(step => step.type === 'history.outside-change').map(step => step.label),
        names: JSON.stringify([...active.branches.values()].map(branch => [branch.id, branch.name])),
        // A note or a bookmark added or removed is an edit of the history the walk puts back.
        notes: (active.notes?.length ?? 0) + steps.reduce((sum, step) => sum + (step.notes?.length ?? 0), 0)
          + [...active.branches.values()].reduce((sum, branch) => sum + (branch.notes?.length ?? 0), 0),
        bookmarks: JSON.stringify(steps.filter(step => step.bookmark !== null && step.bookmark !== undefined).map(step => [step.id, step.bookmark])),
        pending: JSON.stringify(current.pending?.() ?? null),
        headAfter: JSON.stringify(active.steps.get(active.headId).after),
      };
    }

    async function facts() {
      const current = history();
      return {
        fingerprint: await stateFingerprint(getStateDomains()),
        shown: current === null ? null : current.shownHashes(),
        tree: tree(),
      };
    }

    const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

    /**
     * Wait until nothing is under way (the dispatcher's actions, the
     * history's operations and observed changes: `history.idle()`), no
     * camera moves, and three reads of the fingerprint and the history, two
     * frames apart, agree: a control's own work that starts a frame later (a
     * module it loads first) is waited for too.
     */
    async function settle() {
      let last = null;
      let agreed = 0;
      // The slowest frame waited for: how fast the page draws now (the walk's `actionTimeout`).
      let frameMs = 0;
      window.__walk.stats.settles += 1;
      for (let round = 0; round < 600; round++) {
        window.__walk.stats.rounds += 1;
        let start = performance.now();
        await getActions().idle();
        await history()?.idle();
        window.__walk.stats.idleMs += performance.now() - start;
        start = performance.now();
        await frame();
        const between = performance.now();
        await frame();
        const framed = performance.now();
        frameMs = Math.max(frameMs, between - start, framed - between);
        window.__walk.stats.framesMs += framed - start;
        start = performance.now();
        const now = await facts();
        window.__walk.stats.factsMs += performance.now() - start;
        // A part of the page that says it is busy (the State panel making a report) is under way too.
        const moving = window._cellucidViewer?.isCameraInMotion?.() === true
          || document.querySelector('[aria-busy="true"]') !== null;
        const key = JSON.stringify([now.fingerprint.digest, now.tree, now.shown]);
        agreed = !moving && key === last ? agreed + 1 : 0;
        if (agreed >= 2) return { ...now, frameMs };
        last = key;
      }
      throw new Error('the state never settled');
    }

    /** The history as it is now, with every value its steps name. */
    function saveTree() {
      const current = history();
      const saved = current.snapshot();
      const values = new Map();
      for (const tracker of saved.trackers) {
        for (const step of tracker.steps) {
          for (const hash of [...Object.values(step.before), ...Object.values(step.after)]) {
            if (!values.has(hash)) values.set(hash, current.pool.get(hash));
          }
        }
      }
      return { saved, values };
    }

    window.__walk = {
      stats: { settles: 0, rounds: 0, idleMs: 0, framesMs: 0, factsMs: 0 },
      history: history(),
      discover,
      mark,
      facts,
      settle,
      saved: new Map(),
      /** The controls each scene shows, by key. */
      surfaces: new Map(),
      save(name) {
        this.saved.set(name, saveTree());
        this.surfaces.set(name, new Set(controls().map(([, key]) => key)));
      },
      /** Keep the history as it is now under `name` (a control's home, `restore` puts it back). */
      remember(name) {
        this.saved.set(name, saveTree());
      },
      forget(name) {
        this.saved.delete(name);
      },
      async restore(name) {
        const { saved, values } = this.saved.get(name);
        await getActions().idle();
        await history().load(saved, { values });
        return settle();
      },
      async undo() {
        await history().undo();
        return settle();
      },
      /** This browser's History settings (a preference, in no step and no history). */
      preferences() {
        return historySettings();
      },
      /**
       * Put the History settings back as `saved` holds them, and close the history's search (a
       * search or filter left on hides the steps it does not match from every later control; the
       * panel's view of the history, in no step either). Closing it clears it, as Escape does.
       */
      putPreferences(saved) {
        const now = historySettings();
        for (const [key, value] of Object.entries(saved)) if (now[key] !== value) setHistorySetting(key, value);
        const search = document.getElementById('history-search');
        if (search !== null && !search.hidden) search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      },
      /**
       * Every setting of the control inventory: whether its control is
       * shown now, its section, and the keys it is met by (its own, and
       * those of the controls it holds: a group of pressed buttons).
       */
      async settings() {
        const { outcome } = await getActions().dispatch('settings.list', {});
        const keyOf = new Map(controls());
        return outcome.settings.map(setting => {
          const element = document.getElementById(setting.id);
          const keys = new Set([`#${setting.id}`]);
          for (const item of element === null ? [] : [element, ...element.querySelectorAll(INTERACTIVE)]) {
            const key = keyOf.get(item) ?? (stableId(item) === null ? null : `#${item.id}`);
            if (key !== null) keys.add(key);
          }
          return {
            id: setting.id,
            shown: element !== null && shown(element),
            section: element?.closest('details.accordion-section')?.id ?? null,
            keys: [...keys],
          };
        });
      },
      step(id) {
        const step = history().active.steps.get(id);
        return step === undefined ? null : { type: step.type, label: step.label, parent: step.parent, origin: step.by.origin };
      },
      /**
       * How much a control opened is open: dialogs, menus, popovers and
       * editors, and every control the scene `name` did not show (a tour's
       * bar, a menu's items).
       */
      transientOpen(allowed) {
        const base = typeof allowed === 'string' ? this.surfaces.get(allowed) : new Set(allowed);
        const keys = new Map(controls());
        // A container that holds a control shown before was open before: it is not counted.
        const openedNow = element => ![...element.querySelectorAll(INTERACTIVE)].some(item => base?.has(keys.get(item)));
        const open = [
          ...document.querySelectorAll('dialog[open]'),
          ...[...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], .info-tooltip, .inline-rename-input')]
            .filter(element => element.closest('#welcome-modal') === null && shown(element)),
        ].filter(openedNow);
        const extra = base === undefined ? 0 : [...keys.values()].filter(key => !base.has(key)).length;
        return open.length + extra;
      },
      /**
       * `transientOpen` once the page is still: no animation of its own
       * runs (a dialog or menu closing; the spinners, which never end, and
       * the notifications aside) and two reads two frames apart agree.
       */
      async transientSettled(allowed) {
        let last = null;
        for (let round = 0; round < 600; round++) {
          await frame();
          await frame();
          const running = document.getAnimations().filter(animation => animation.playState === 'running'
            && Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity)
            && !(animation.effect?.target instanceof Element && animation.effect.target.closest(OUTSIDE) !== null));
          if (running.length > 0) {
            await Promise.all(running.map(animation => animation.finished.catch(() => {})));
            last = null;
            continue;
          }
          const now = this.transientOpen(allowed);
          if (now === last) return now;
          last = now;
        }
        throw new Error('what a control opened never stood still');
      },
    };
  });
}

function differing(a, b) {
  return Object.keys(a.domains).filter(id => a.domains[id] !== b.domains[id]);
}

/** The domains whose value differs from what the history shows: changed with no step. */
function drifted(facts) {
  if (facts.shown === null) return [];
  return Object.keys(facts.fingerprint.domains).filter(id => facts.shown[id] !== facts.fingerprint.domains[id]);
}

/** A gene of the dataset that is not the one shown, by the agents' own read. */
function otherGene(page) {
  return page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    const shown = window._cellucidState.getActiveField?.();
    for (const query of ['A', 'C', 'E', 'G', 'M']) {
      const { outcome } = await getActions().dispatch('genes.search', { query, limit: 20 });
      const gene = outcome.genes.find(name => !(shown?.key === name));
      if (gene !== undefined) return gene;
    }
    return null;
  });
}

/** Operate a marked control the way its role is operated; says what was done. */
async function operate(page, control) {
  const target = page.locator('[data-walk-target]');
  const options = { timeout: actionTimeout() };
  switch (control.role) {
    case 'canvas': {
      const box = await target.boundingBox();
      const sidebar = await page.locator('#sidebar').boundingBox();
      const left = Math.max(box.x, (sidebar?.x ?? 0) + (sidebar?.width ?? 0));
      const x = left + (box.x + box.width - left) * 0.5;
      const y = box.y + box.height * 0.5;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 40, y + 20, { steps: 4 });
      await page.mouse.move(x + 80, y + 40, { steps: 4 });
      await page.mouse.up();
      return 'dragged';
    }
    case 'select': {
      const choices = await target.evaluate(select => [...select.options].map((option, index) => ({
        index, disabled: option.disabled, selected: option.selected,
      })));
      const current = choices.findIndex(choice => choice.selected);
      const next = [...choices.slice(current + 1), ...choices.slice(0, Math.max(current, 0))].find(choice => !choice.disabled);
      if (next === undefined) return 'has one option';
      await target.selectOption({ index: next.index }, options);
      return `chose option ${next.index + 1}`;
    }
    case 'slider': {
      const atMax = await target.evaluate(element => {
        const value = Number(element.value ?? element.getAttribute('aria-valuenow'));
        const max = Number(element.max ?? element.getAttribute('aria-valuemax'));
        return Number.isFinite(value) && Number.isFinite(max) && value >= max;
      });
      await target.focus(options);
      await page.keyboard.press(atMax ? 'ArrowLeft' : 'ArrowRight');
      return atMax ? 'moved one step down' : 'moved one step up';
    }
    case 'spinbutton': {
      const value = await target.evaluate(input => {
        const step = Number(input.step) > 0 ? Number(input.step) : 1;
        const now = Number(input.value);
        const max = input.max === '' ? Infinity : Number(input.max);
        const next = Number.isFinite(now) ? (now + step <= max ? now + step : now - step) : Number(input.min || 0);
        return String(Number(next.toFixed(6)));
      });
      await target.fill(value, options);
      await target.press('Enter', options);
      return `typed ${value}`;
    }
    case 'color': {
      const value = await target.inputValue(options);
      const next = value.toLowerCase() === '#3366cc' ? '#cc6633' : '#3366cc';
      await target.fill(next, options);
      return `chose ${next}`;
    }
    case 'textbox':
    case 'searchbox':
    case 'combobox': {
      const field = await target.evaluate(input => ({
        readOnly: input.readOnly === true || input.getAttribute('aria-readonly') === 'true',
        numeric: ['decimal', 'numeric'].includes(input.inputMode) || (input.value !== '' && Number.isFinite(Number(input.value))),
        value: input.value ?? '',
        gene: input.id === 'gene-expression-search',
      }));
      if (field.readOnly) {
        // All a person does with a read-only field: select it to copy.
        await press(page, target);
        return 'clicked (read only)';
      }
      let text = 'Walk';
      if (field.gene) {
        text = (await otherGene(page)) ?? 'Walk';
      } else if (field.numeric) {
        const now = Number(field.value);
        text = String(Number.isFinite(now) && now > 2 ? Math.round(now / 2) : 2);
      }
      await target.fill(text, options);
      await target.press('Enter', options);
      return `typed ${JSON.stringify(text)} and Enter`;
    }
    default:
      return press(page, target);
  }
}

/**
 * Click a control; when something else covers it, press it from the
 * keyboard (Enter on it, as a keyboard user does) and say what covered it:
 * `COVERED` lists them for the report.
 */
async function press(page, target) {
  try {
    await target.click({ timeout: actionTimeout() });
    return 'clicked';
  } catch (error) {
    const cover = String(error?.message ?? '').split('\n').find(line => /intercepts pointer events/.test(line));
    if (cover === undefined) throw error;
    const what = cover.trim().replace(/\s+intercepts pointer events$/, '').slice(0, 160);
    COVERED.push(what);
    await target.focus({ timeout: actionTimeout() });
    await page.keyboard.press('Enter');
    return `pressed Enter on it (covered by ${what})`;
  }
}

/** Controls a click could not reach because something covered them, pressed from the keyboard. */
const COVERED = [];

/** Move the pointer a little over the plot, as a person reaching for a control does. */
async function wakePointer(page) {
  const box = await page.locator('#glcanvas').boundingBox();
  if (box === null) return;
  const x = box.x + box.width * 0.75;
  const y = box.y + box.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.move(x + 5, y + 5, { steps: 2 });
  await settle(page);
}

/** What a marked control shows now, for `undoOperation`. */
function controlValue(page, control) {
  if (control.role === 'canvas') return null;
  return page.locator('[data-walk-target]').evaluate(element => ({
    index: element instanceof HTMLSelectElement ? element.selectedIndex : null,
    value: typeof element.value === 'string' ? element.value : null,
  }));
}

/**
 * Operate a marked control back to `memo` (what it showed before), the way a
 * person does: the option chosen before, the other arrow key, the value typed
 * before, or the same click again (a toggle).
 */
async function undoOperation(page, control, memo) {
  const target = page.locator('[data-walk-target]');
  const options = { timeout: actionTimeout() };
  switch (control.role) {
    case 'canvas':
      return;
    case 'select':
      if (memo.index >= 0) await target.selectOption({ index: memo.index }, options);
      return;
    case 'slider': {
      const now = await target.evaluate(element => Number(element.value ?? element.getAttribute('aria-valuenow')));
      if (now === Number(memo.value)) return;
      await target.focus(options);
      await page.keyboard.press(now > Number(memo.value) ? 'ArrowLeft' : 'ArrowRight');
      return;
    }
    case 'color':
      await target.fill(memo.value, options);
      return;
    case 'spinbutton':
    case 'textbox':
    case 'searchbox':
    case 'combobox':
      if (await target.evaluate(input => input.readOnly === true)) return;
      await target.fill(memo.value ?? '', options);
      await target.press('Enter', options);
      return;
    default:
      await press(page, target);
  }
}

/** The first line of a Playwright error and why an element could not be operated, or else where the action stood when it ran out of time. */
function errorWords(error) {
  const lines = String(error?.message ?? error).split('\n');
  const why = lines.find(line => /intercepts pointer events|not visible|not enabled|outside of the viewport|not stable|detached/.test(line))
    // None of those: what the action was doing when its time ran out (the call log's last step:
    // a locator that never resolved, a check that never answered, a press not acknowledged).
    ?? lines.slice(1).reverse().find(line => /^\s*(?:\d+ × )?-?\s*(?:waiting(?! \d+ms)|locator|attempting|performing|scrolling|element)/.test(line));
  return why === undefined ? lines[0] : `${lines[0]} (${why.trim()})`;
}

/**
 * Press Escape while what a control opened is open (a dialog, a menu, a
 * popover, an editor, a tour bar: controls the scene did not show), as long
 * as each press closes something.
 */
async function closeTransient(page, scene) {
  let open = await page.evaluate(name => window.__walk.transientOpen(name), scene);
  while (open > 0) {
    await page.keyboard.press('Escape');
    // What the press closed, once the page stands still (a closing
    // animation ended): never a fixed wait.
    const now = await page.evaluate(name => window.__walk.transientSettled(name), scene);
    // What Escape does not close (an expander) is left open; the walk
    // operates it back, or the next control's walk starts beside it.
    if (now >= open) break;
    open = now;
  }
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
}

/**
 * Run one control's walk (`task`) for as long as it makes progress: until it
 * ends, however long that takes, unless one of its waits stalls, no wait of
 * the walk having ended for `hangAfterMs()` (`HANG_FACTOR` times the slowest
 * wait the part has seen end, at least `HANG_FLOOR_MS`). A stalled walk ends
 * the part, naming the control: left running beside the next control, its
 * work would operate, restore and close on that control's page. The report
 * says how long the page then takes to answer one read: a page that stood
 * still itself is the browser's or the machine's (on macOS, Mission Control
 * or a change of Space during a local run; developer docs, record 38), a
 * page that answers at once leaves the stall to the walk's own wait.
 */
async function untilHung(page, task, what) {
  PROGRESS.lastAt = performance.now();
  let timer;
  const stalled = new Promise(resolve => {
    const check = () => {
      const quiet = performance.now() - PROGRESS.lastAt;
      const allowed = hangAfterMs();
      if (quiet >= allowed) resolve(quiet);
      else timer = setTimeout(check, allowed - quiet + 1);
    };
    timer = setTimeout(check, hangAfterMs());
  });
  const work = task();
  const quiet = await Promise.race([work.then(() => null, () => null), stalled]);
  clearTimeout(timer);
  if (quiet === null) return work;
  const seconds = ms => `${(ms / 1000).toFixed(1)} s`;
  // The read is given as long as the stall itself was: a page that does not
  // answer by then stands still, and the report goes out without it.
  const asked = performance.now();
  let bound;
  const answeredAt = await Promise.race([
    page.evaluate(() => true).then(() => performance.now(), () => performance.now()),
    new Promise(resolve => { bound = setTimeout(() => resolve(null), quiet); }),
  ]);
  clearTimeout(bound);
  const answer = answeredAt === null
    ? `the page itself did not answer one read in ${seconds(quiet)}, so it stood still, not the walk`
    : answeredAt - asked > PROGRESS.slowestMs
      ? `the page itself then took ${seconds(answeredAt - asked)} to answer one read, so it stood still, not the walk`
      : `the page answered one read in ${seconds(answeredAt - asked)}`;
  throw Object.assign(new Error(`${what} made no progress for ${seconds(quiet)} (no wait of its walk ended; the slowest wait seen to end took ${seconds(PROGRESS.slowestMs)}; ${answer}): the walk cannot go on beside it`), { fatal: true });
}

/**
 * Scroll the history graph `id` from its top, a view at a time, until the
 * control `key` is drawn; true when it was.
 */
async function scrollGraphTo(page, id, key) {
  const views = await page.evaluate(graph => {
    const element = document.getElementById(graph);
    if (element === null) return 0;
    element.scrollTop = 0;
    return Math.ceil(element.scrollHeight / Math.max(1, element.clientHeight));
  }, id);
  for (let view = 0; view <= views; view++) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (await mark(page, key)) return true;
    await page.evaluate(graph => {
      const element = document.getElementById(graph);
      element.scrollTop += element.clientHeight;
    }, id);
  }
  return false;
}

/** Mark a control for the locator: true when it is shown and enabled now. */
const mark = async (page, key) => (await timed('mark', () => page.evaluate(name => window.__walk.mark(name), key))) === 'marked';
/** Why a control could not be marked: 'not shown' or 'disabled' ('marked' when it could). */
const markState = (page, key) => page.evaluate(name => window.__walk.mark(name), key);
const settle = page => timed('settle', async () => {
  const facts = await page.evaluate(() => window.__walk.settle());
  PROGRESS.frameMs = facts.frameMs;
  return facts;
});
const discover = page => timed('discover', () => page.evaluate(() => window.__walk.discover()));

/**
 * The walk over one page: scenes, controls, what each opens. One report
 * entry per control.
 */
function createWalk(page) {
  // A test's report counts its own walk (tests of a worker share the module).
  PHASES.clear();
  COVERED.length = 0;
  const report = [];
  /** The state the scene began with, and the last control walked at its top level. */
  let sceneFingerprint = null;
  let lastTopEntry = null;
  /** Controls operated or left out (a control seen disabled is walked once it is enabled). */
  const visited = new Set();
  /** Controls seen disabled and never enabled: key → entry. */
  const disabled = new Map();
  const external = [];
  const errors = [];
  page.on('download', download => {
    external.push(`download ${download.suggestedFilename()}`);
    void download.cancel().catch(() => {});
  });
  page.on('filechooser', chooser => {
    external.push('file picker');
    void chooser.setFiles([]).catch(() => {});
  });
  page.on('popup', popup => {
    external.push(`window ${popup.url()}`);
    void popup.close().catch(() => {});
  });
  page.on('dialog', dialog => {
    external.push(`${dialog.type()} "${dialog.message().slice(0, 60)}"`);
    void (dialog.type() === 'prompt' ? dialog.dismiss() : dialog.accept()).catch(() => {});
  });
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    // A request outside the test servers is refused on purpose (a sign-in, a model provider): its
    // failure is that. Known by its address, whichever control is walked when the browser says so
    // (a call a control began may be refused, and tried again, while the next one is walked).
    if (/^Failed to load resource: net::ERR_FAILED/.test(message.text()) && REFUSED.has(message.location().url)) return;
    errors.push(`console: ${message.text()}`);
  });

  /**
   * Show `control` again through the controls that opened it: each is
   * operated unless what it opens is shown already; a second attempt
   * operates each (a toggle left open that hides what is wanted).
   */
  async function reach(control, path, scene) {
    // A bar that hides while the pointer rests (the camera path's transport
    // bar) shows again when it moves, as for a person reaching for it.
    await wakePointer(page);
    if (await mark(page, control.key)) return true;
    // A row of a history graph is drawn only while it is in the graph's scrolled view (the graph
    // is virtualised, `state/graph.js`): scrolled through, as a person scrolls to a row.
    const graphOf = control.key.match(/^(history(?:-map)?-graph)-row-/)?.[1] ?? null;
    if (graphOf !== null && await scrollGraphTo(page, graphOf, control.key)) return true;
    for (let attempt = 0; attempt < 2; attempt++) {
      for (let index = 0; index < path.length; index++) {
        const next = path[index + 1]?.key ?? control.key;
        if (attempt === 0 && await mark(page, next)) continue;
        if (!await mark(page, path[index].key)) break;
        await operate(page, path[index]);
        await settle(page);
      }
      if (await mark(page, control.key)) return true;
      await closeTransient(page, scene);
    }
    return false;
  }

  /** What one operation did, judged from the facts before and after it. */
  async function judge(entry, how, before, after, errorsBefore) {
    const problems = [];
    if (after.tree?.history !== 'same') throw new Error('replaced the dataset\'s history (another dataset was opened)');
    // Drift the controls that showed this one left (reported for them) is not this control's.
    const driftBefore = drifted(before);
    const drift = drifted(after).filter(id => !driftBefore.includes(id) || before.fingerprint.domains[id] !== after.fingerprint.domains[id]);
    if (drift.length > 0) problems.push(`changed ${drift.join(', ')} outside the history (no step holds it)`);
    const outside = after.tree.outside.length - before.tree.outside.length;
    if (outside > 0) problems.push(`kept ${outside} "Changed outside the history" step(s)`);
    if (errors.length > errorsBefore) problems.push(`page errors: ${errors.slice(errorsBefore).join(' | ').slice(0, 400)}`);
    const changed = differing(before.fingerprint, after.fingerprint);
    const newSteps = after.tree.ids.filter(id => !before.tree.ids.includes(id));
    // Steps taken out with the new one (a squash), or new steps on another branch none of which
    // follows the step shown, are an edit of the history, judged as a history control, not a step
    // made: Clear history keeping the state starts one from the opening, and Branch without this
    // step replays every step after the one left out on a branch from the step before it (as many
    // steps as followed it on the way to the step shown; none on the last step). A change made after going back
    // follows the step shown: a step, checked as every step is.
    const removedSteps = before.tree.ids.filter(id => !after.tree.ids.includes(id));
    const newParents = after.tree.branch === before.tree.branch || newSteps.length === 0 ? []
      : await page.evaluate(ids => ids.map(id => window.__walk.step(id)?.parent ?? null), newSteps);
    const otherBranch = newParents.length > 0 && !newParents.includes(before.tree.head);
    const sameTrackers = after.tree.tracker === before.tree.tracker && after.tree.trackers.join() === before.tree.trackers.join();
    entry.detail = how;
    if (newSteps.length > 0 && sameTrackers && removedSteps.length === 0 && !otherBranch) {
      const step = await page.evaluate(id => window.__walk.step(id), after.tree.head);
      if (newSteps.length !== 1) problems.push(`made ${newSteps.length} steps (${newSteps.join(', ')})`);
      else if (after.tree.head !== newSteps[0]) problems.push(`made step ${newSteps[0]} but shows ${after.tree.head}`);
      else if (step.parent !== before.tree.head) problems.push(`its step does not follow the step shown before (${step.parent} ≠ ${before.tree.head})`);
      if (!step?.label) problems.push('its step has no label');
      if (changed.length === 0) problems.push('made a step that changed nothing');
      entry.outcome = 'step';
      entry.detail = `${how} → "${step?.label}" (${step?.type}; ${changed.join(', ')})`;
      if (problems.length === 0) {
        const undone = await timed('undo', () => page.evaluate(() => window.__walk.undo()));
        const back = differing(before.fingerprint, undone.fingerprint);
        if (back.length > 0) problems.push(`undo did not put back ${back.join(', ')}`);
        if (undone.tree.head !== before.tree.head) problems.push(`undo shows ${undone.tree.head}, not ${before.tree.head}`);
      }
    } else if (JSON.stringify(before.tree) !== JSON.stringify(after.tree)) {
      entry.outcome = 'history';
      const what = !sameTrackers ? 'changed its trackers'
        : after.tree.ids.length < before.tree.ids.length ? 'lost a step'
          : removedSteps.length > 0 ? `replaced ${removedSteps.length} step(s) with ${newSteps.length}`
            : otherBranch ? `shows branch ${after.tree.branch} (${newSteps.length} new step${newSteps.length === 1 ? '' : 's'})`
            : after.tree.head !== before.tree.head ? `shows ${after.tree.head}`
              : after.tree.notes !== before.tree.notes ? 'changed its notes'
                : after.tree.bookmarks !== before.tree.bookmarks ? 'changed its bookmarks'
                  : after.tree.pending !== before.tree.pending ? 'waits to branch' : 'was renamed';
      entry.detail = `${how} → the history ${what}${changed.length ? ` (${changed.join(', ')})` : ''}`;
    } else if (changed.length > 0) {
      problems.unshift(`changed ${changed.join(', ')} with no step`);
    } else {
      entry.outcome = external.length > 0 ? 'external' : 'no change';
      if (external.length > 0) entry.detail = `${how} → ${external.join(', ')}`;
    }
    if (problems.length > 0) {
      entry.outcome = 'failed';
      entry.detail = `${how}: ${problems.join('; ')}`;
    }
  }

  /** Walk one control (shown through `path`), then what it opened, made or enabled. */
  async function walkControl(scene, control, path, known) {
    const via = path.map(item => item.key);
    if (!control.enabled) {
      if (!visited.has(control.key) && !disabled.has(control.key)) {
        disabled.set(control.key, { scene, key: control.key, role: control.role, name: control.name, via, outcome: 'disabled', detail: 'never enabled in the walk' });
      }
      return;
    }
    disabled.delete(control.key);
    visited.add(control.key);
    const started = performance.now();
    const entry = { scene, key: control.key, role: control.role, name: control.name, via, outcome: null, detail: '', section: sectionOf(path[0] ?? control), ms: 0 };
    report.push(entry);
    const left = leftOutReason(control);
    if (left !== null) {
      entry.outcome = 'left out';
      entry.detail = left;
      console.log(line(entry));
      return;
    }
    let children = [];
    let seen = known;
    let shownBefore = null;
    // Where this control's walk puts the state and the history back: the
    // scene for a control the scene shows; for one shown through others,
    // the state they made (its home), so it and its siblings start there
    // and a sibling is reached without operating them again.
    let home = scene;
    try {
      await untilHung(page, async () => {
        if (!await mark(page, control.key) && !await timed('reach (inclusive)', () => reach(control, path, scene), { inclusive: true })) {
          const state = await markState(page, control.key);
          if (path.length > 0) {
            // It was shown once (a draft of the panel that opened it, which the
            // controls walked since changed, held it): listed, not judged.
            entry.outcome = 'unreached';
            entry.detail = `was shown once but not again through ${via.join(' → ')} (${state})`;
          } else {
            entry.outcome = 'failed';
            entry.detail = `was ${state} when its turn came, though the scene began with it shown and enabled`;
          }
          return;
        }
        let before = await settle(page);
        if (path.length === 0) {
          // A control's work that ended after its own checks (and after the
          // scene was put back) shows here: it is reported for that control,
          // and the scene is put back before this one starts.
          const late = differing(sceneFingerprint, before.fingerprint);
          if (late.length > 0 && lastTopEntry !== null) {
            lastTopEntry.outcome = 'failed';
            lastTopEntry.detail += `; changed ${late.join(', ')} after its checks had ended (seen when the next control began)`;
            await timed('restore', () => page.evaluate(name => window.__walk.restore(name), scene));
            before = await settle(page);
          }
        } else {
          home = `${scene} › ${[...via, control.key].join(' › ')}`;
          await page.evaluate(name => window.__walk.remember(name), home);
        }
        const surface = await discover(page);
        shownBefore = surface.map(item => item.key);
        seen = new Set([...known, ...surface.filter(item => item.enabled).map(item => item.key)]);
        if (!await mark(page, control.key)) {
          entry.outcome = 'failed';
          entry.detail = `was ${await markState(page, control.key)} once the page settled`;
          return;
        }
        external.length = 0;
        BLOCKED.length = 0;
        const errorsBefore = errors.length;
        // History settings are this browser's preferences, which no load of the history puts back: a
        // detail switch left off (Camera moves) would leave every later control's camera unrecorded.
        const preferences = await page.evaluate(() => window.__walk.preferences());
        const memo = await controlValue(page, control);
        const how = await timed('operate', () => operate(page, control));
        const after = await settle(page);
        // A control that takes the pointer (Capture pointer, in Free-fly) has
        // the browser lock it to the plot: every later click goes to the
        // canvas, for a person until they press Escape. It is released as
        // they would release it. Linux Chromium grants the lock to the click;
        // macOS headless Chromium does not, so on Linux the next control's
        // click would wait for the button to take it
        // (`#pointer-lock-info-btn`).
        if (await page.evaluate(() => document.pointerLockElement !== null)) {
          external.push('the pointer captured');
          await page.evaluate(() => document.exitPointerLock());
          await page.waitForFunction(() => document.pointerLockElement === null);
        }
        // What it opened, made or enabled (read before its step is undone).
        const opened = path.length < MAX_DEPTH ? await discover(page) : [];
        external.push(...BLOCKED.map(origin => `a request to ${origin} (outside the test servers, refused)`));
        await judge(entry, how, before, after, errorsBefore);
        // Walked next, shown again through this control. Not after a step
        // shown (the controls of another state), and not the State panel's
        // own, which follow every step (walked from the panel).
        if (entry.outcome !== 'history') {
          const inHistoryPanel = item => item.places.includes('state-section') && !control.places.includes('state-section')
            && control.key !== '#state-section';
          children = opened.filter(item => item.enabled && !item.walked && !seen.has(item.key) && !visited.has(item.key) && !inHistoryPanel(item));
        }
        // Its home is put back, unless it moved neither the state nor the history.
        const moved = after.fingerprint.digest !== before.fingerprint.digest || JSON.stringify(after.tree) !== JSON.stringify(before.tree);
        if (moved || entry.outcome === 'step') await timed('restore', () => page.evaluate(name => window.__walk.restore(name), home));
        await timed('close', () => closeTransient(page, shownBefore));
        if (entry.outcome === 'no change' || entry.outcome === 'external') {
          // It showed or hid part of the page and changed no state (an
          // expander): operated once more, the page is as it was.
          const shownNow = await discover(page);
          const keysNow = new Set(shownNow.map(item => item.key));
          const changedSurface = surface.some(item => !keysNow.has(item.key)) || shownNow.some(item => !shownBefore.includes(item.key));
          if (changedSurface && await mark(page, control.key)) {
            await timed('operate back', () => undoOperation(page, control, memo));
            await settle(page);
            await timed('close', () => closeTransient(page, shownBefore));
          }
        }
        await page.evaluate(saved => window.__walk.putPreferences(saved), preferences);
        const restored = await settle(page);
        const left = differing(before.fingerprint, restored.fingerprint);
        if (left.length > 0) {
          throw new Error(`the walk could not put ${left.join(', ')} back after this control (the history's load of where it began did not)`);
        }
      }, control.key);
    } catch (error) {
      entry.outcome = 'failed';
      entry.detail = `${entry.detail ? `${entry.detail}: ` : ''}${errorWords(error)}`;
      if (error?.fatal === true) {
        console.log(line(entry));
        throw error;
      }
      await closeTransient(page, scene).catch(() => {});
      await page.evaluate(name => window.__walk.restore(name), scene).catch(() => {});
      children = [];
    }
    // The report, a line per control as it is walked.
    entry.ms = Math.round(performance.now() - started);
    console.log(line(entry));
    const siblings = new Set([...seen, ...children.map(item => item.key)]);
    for (const child of children) {
      if (visited.has(child.key)) continue;
      await walkControl(scene, child, [...path, control], siblings);
    }
    if (children.length > 0) {
      // Its children were put back where they began (what it made): its own
      // home comes back, and what they needed open (a menu, a dialog) is
      // closed before the next control.
      await timed('restore', () => page.evaluate(name => window.__walk.restore(name), home));
      if (shownBefore !== null) await timed('close', () => closeTransient(page, shownBefore));
    }
    if (home !== scene) await page.evaluate(name => window.__walk.forget(name), home);
    if (path.length === 0) lastTopEntry = entry;
  }

  /** Walk every control the scene shows in `part` (`PARTS`), and what each opens. */
  async function walkScene(scene, part) {
    await page.evaluate(name => window.__walk.save(name), scene);
    sceneFingerprint = (await settle(page)).fingerprint;
    lastTopEntry = null;
    const surface = await discover(page);
    const known = new Set(surface.filter(item => item.enabled).map(item => item.key));
    for (const control of surface) {
      if (visited.has(control.key)) continue;
      if (partOfSection(sectionOf(control)) !== part) continue;
      await walkControl(scene, control, [], known);
    }
  }

  /** Whether the walk met a setting (`window.__walk.settings`): walked, or seen disabled. */
  function met(setting) {
    return setting.keys.some(key => visited.has(key) || disabled.has(key));
  }

  return { report, visited, disabled, met, walkScene };
}

/** The origins outside the test servers a control asked for (refused), since the control began. */
const BLOCKED = [];
/** Every address outside the test servers asked for (refused) in the walk. */
const REFUSED = new Set();

async function openFixture(page) {
  // A copy (pseudocode, a methods paragraph, a link) writes to the clipboard, as a person's page may.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_ORIGIN });
  // Nothing outside the test servers is reached (a sign-in, a link).
  await page.context().route(url => url.protocol.startsWith('http') && url.origin !== APP_ORIGIN && url.origin !== SAMPLE_ORIGIN, route => {
    BLOCKED.push(new URL(route.request().url()).origin);
    REFUSED.add(route.request().url());
    return route.abort();
  });
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await waitForDatasetReady(page, CELLS);
  await waitForHistory(page);
  await waitForPageAtRest(page);
  // The walk puts the history back after every control by loading it, and
  // each load would be kept as its own saved state in this browser.
  await page.evaluate(async () => {
    const { setHistorySetting } = await import('/assets/js/app/history/history-settings.js');
    setHistorySetting('autosave', false);
  });
}

/** Every closed section opened, as layout steps (`layout.section.open`). */
async function openEverySection(page) {
  const closed = await page.evaluate(() => [...document.querySelectorAll('details.accordion-section')]
    .filter(details => !details.open && details.checkVisibility()).map(details => details.id));
  await takeSteps(page, closed.map(section => ['layout.section.open', { section, open: true }]));
}

/** The views as `views.state` names them (what view actions take). */
function viewNames(page) {
  return page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    const { outcome } = await getActions().dispatch('views.state', {});
    return outcome.views.map(view => view.name);
  });
}

/** The camera of the view shown, turned `degrees` around its target. */
function turnedCamera(page, degrees) {
  return page.evaluate(turn => {
    const viewer = window._cellucidViewer;
    const camera = structuredClone(viewer.getViewCameraState(viewer.getFocusedViewId()));
    camera.orbit.theta += (turn * Math.PI) / 180;
    return camera;
  }, degrees);
}

/** How many of the slowest controls the time report names. */
const SLOWEST_SHOWN = 10;

/**
 * Where the walk's time went: by section, the slowest controls (slow is
 * reported, never failed), by phase, and the page's settling.
 */
async function timeReport(page, report) {
  const seconds = ms => `${(ms / 1000).toFixed(1)} s`;
  const bySection = new Map();
  for (const entry of report) {
    if (entry.ms === undefined) continue;
    const total = bySection.get(entry.section) ?? { ms: 0, count: 0 };
    total.ms += entry.ms;
    total.count += 1;
    bySection.set(entry.section, total);
  }
  const stats = await page.evaluate(() => window.__walk?.stats ?? null).catch(() => null);
  return [
    'Time by section:',
    ...[...bySection].sort((a, b) => b[1].ms - a[1].ms).map(([section, { ms, count }]) => `  ${section}: ${seconds(ms)} (${count} controls)`),
    'Slowest controls:',
    ...report.filter(entry => entry.ms !== undefined).sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_SHOWN)
      .map(entry => `  ${seconds(entry.ms)} ${entry.scene} ${entry.key}`),
    'Time by phase:',
    ...[...PHASES].sort((a, b) => b[1].ms - a[1].ms).map(([phase, { ms, count }]) => `  ${phase}: ${seconds(ms)} (${count} calls)`),
    stats === null ? '' : `Page settling: ${stats.settles} settles, ${stats.rounds} rounds; idle ${seconds(stats.idleMs)}, frames ${seconds(stats.framesMs)}, facts ${seconds(stats.factsMs)}`,
  ].join('\n');
}

function line(entry) {
  const via = entry.via.length > 0 ? ` (via ${entry.via.join(' → ')})` : '';
  return `${entry.outcome.padEnd(9)} ${entry.scene.padEnd(12)} ${entry.key}${entry.key.startsWith('#') ? ` "${entry.name}"` : ''}${via}${entry.detail ? ` — ${entry.detail}` : ''}`;
}

/** Declare the walk of one part (`PARTS`) with the spec file's `test`. */
function declarePartTest(test, part) {
  const where = part === OUTSIDE_SECTIONS ? 'outside the sidebar sections' : `of ${part}`;
  test(`every control ${where} that changes state makes exactly one step, and undo puts the state back exactly`, async ({ page }, testInfo) => {
    keepPartAlive(testInfo);
    await openFixture(page);
    await takeSteps(page, [
      ['color.by', { field: { source: 'obs', key: 'cell_type' } }],
      ['highlight.category', { field: { source: 'obs', key: 'cell_type' }, categories: ['gamma'] }],
      ['view.keep', {}],
    ]);
    await openEverySection(page);
    await waitForPageAtRest(page);
    await installWalker(page);
    const walk = createWalk(page);

    const umap = { key: 'X_umap_2d', columns: [0, 1] };
    const latent = { key: 'latent_space', columns: [0, 1, 2] };
    // Each scene's steps are taken on the scene before it.
    const scenes = [
      ['categories', async () => []],
      ['continuous', async () => [['color.by', { field: { source: 'obs', key: 'score' } }]]],
      ['gene', async () => [['color.by', { field: { source: 'var', key: await otherGene(page) } }]]],
      ['kept view 3D', async () => {
        const views = await viewNames(page);
        expect(views.length, 'the live view and the kept view').toBe(2);
        return [
          // The second embedding is enabled in the data mapping, then shown by the kept view.
          ['mapping.set', { embeddings: { enabled: [umap, latent], defaults: { '1d': null, '2d': umap, '3d': latent } } }],
          ['view.focus', { view: views[1] }],
          ['view.embedding.set', { view: views[1], embedding: latent }],
        ];
      }],
      ['camera path', async () => [
        ['camera-path.keyframe.add', { camera: await turnedCamera(page, 0) }],
        ['camera-path.keyframe.add', { camera: await turnedCamera(page, 40) }],
      ]],
    ];
    let missed = [];
    let notShown = [];
    try {
      for (const [scene, prepare] of scenes) {
        await takeSteps(page, await prepare());
        await walk.walkScene(scene, part);
      }
      // The control inventory: a setting of this part shown now that the
      // walk never met is one the discovery missed; one shown in no scene is
      // reported.
      const settings = (await page.evaluate(() => window.__walk.settings()))
        .filter(setting => partOfSection(setting.section ?? OUTSIDE_SECTIONS) === part)
        .filter(setting => !walk.met(setting));
      missed = settings.filter(setting => setting.shown).map(setting => setting.id);
      notShown = settings.filter(setting => !setting.shown).map(setting => ({
        scene: 'all', key: `#${setting.id}`, role: 'setting', name: setting.id, via: [], outcome: 'not shown',
        detail: part === OUTSIDE_SECTIONS
          ? 'a setting outside the sections that no scene showed at its top level (one a section opens is walked in that section\'s part)'
          : 'a setting no scene of this dataset shows',
      }));
    } finally {
      const report = [...walk.report, ...walk.disabled.values(), ...notShown];
      const counts = {};
      for (const entry of report) counts[entry.outcome] = (counts[entry.outcome] ?? 0) + 1;
      const unwalked = report.filter(entry => ['disabled', 'not shown', 'unreached'].includes(entry.outcome));
      console.log(`Control walk ${where}: ${report.length} controls (${Object.entries(counts).map(([outcome, count]) => `${count} ${outcome}`).join(', ')})\n${unwalked.map(line).join('\n')}`);
      if (COVERED.length > 0) console.log(`Covered when clicked (pressed from the keyboard):\n${[...new Set(COVERED)].join('\n')}`);
      console.log(await timeReport(page, walk.report));
      await testInfo.attach('control-walk.json', { body: JSON.stringify(report, null, 1), contentType: 'application/json' });
      PROGRESS.onProgress = null;
    }
    if (recordsWalkWeights()) recordWalkWeight(part, walk.report);

    expect(walk.report.length, `the page shows controls ${where}`).toBeGreaterThan(0);
    const failed = walk.report.filter(entry => entry.outcome === 'failed');
    expect(failed.map(line), 'every control either changes nothing or makes one undoable step').toEqual([]);
    expect(missed, 'settings of the control inventory (settings.list) the walk never met: the discovery missed them').toEqual([]);
  });
}

/**
 * The controls the first fixture cannot show (a neighbor graph's edges, a
 * vector field's overlay) on a dataset that has both: its Visualization
 * section is walked the same way. Smoke's controls need a volume renderer
 * this browser may not offer; they stay listed as not shown.
 */
function declareGraphAndVectorsTest(test) {
  test('a neighbour graph\'s and a vector field\'s controls make one undoable step each', async ({ page }, testInfo) => {
    keepPartAlive(testInfo);
    await openFixture(page);
    await chooseFiles(page.locator('#user-data-file-input'), GRAPH_AND_VECTORS_FILE);
    await waitForDatasetReady(page, 300);
    await waitForHistory(page);
    await waitForPageAtRest(page);
    await takeSteps(page, [['layout.section.open', { section: 'visualization-section', open: true }]]);
    await waitForPageAtRest(page);
    await installWalker(page);
    const walk = createWalk(page);
    try {
      await walk.walkScene('graph, vectors', 'visualization-section');
    } finally {
      console.log(await timeReport(page, walk.report));
      await testInfo.attach('control-walk-graph-vectors.json', { body: JSON.stringify(walk.report, null, 1), contentType: 'application/json' });
      PROGRESS.onProgress = null;
    }
    const settings = (await page.evaluate(() => window.__walk.settings()))
      .filter(setting => /^(toggle-connectivity|connectivity-|velocity-)/.test(setting.id));
    expect(settings.length, 'the graph and vector settings are in the inventory').toBeGreaterThan(5);
    const unmet = settings.filter(setting => !walk.met(setting));
    expect(unmet.map(setting => setting.id), 'graph and vector settings the walk never met').toEqual([]);
    const failed = walk.report.filter(entry => entry.outcome === 'failed');
    expect(failed.map(line), 'every control either changes nothing or makes one undoable step').toEqual([]);
    if (recordsWalkWeights()) recordWalkWeight(GRAPH_AND_VECTORS, walk.report);
  });
}

/** Declare the test `name` of the walk (`WALK_TESTS`): a part, or the graph and vectors. */
function declareWalkTest(test, name) {
  if (name === GRAPH_AND_VECTORS) declareGraphAndVectorsTest(test);
  else declarePartTest(test, name);
}

/**
 * Declare the share of the walk's tests that the spec file `specUrl` holds:
 * `control-walk-<k>-of-<n>.spec.mjs` holds the k-th of the n shares the
 * walk's tests (`WALK_TESTS`) are split into by weight (`walkShares`,
 * `control-walk-parts.mjs`: the controls each test's walk operated when last
 * recorded; as many tests in each), so the n files hold each test exactly
 * once, the longest tests are in different files, and `--shard` over the
 * walk alone
 * (`CELLUCID_CONTROL_WALK=only`, CI's `control-walk` job) runs them side by
 * side, a file a shard. The n files must all
 * be there, and no others, or no test is declared. The walk runs on Chromium
 * only.
 *
 * @param {import('@playwright/test').TestType<any, any>} test - the spec file's `test` (`helpers/test.mjs`)
 * @param {string} specUrl - the spec file's `import.meta.url`
 */
export function declareWalkTests(test, specUrl) {
  const file = fileURLToPath(specUrl);
  const name = /^control-walk-(\d+)-of-(\d+)\.spec\.mjs$/;
  const match = name.exec(path.basename(file));
  if (match === null) throw new Error(`${path.basename(file)} is not named control-walk-<k>-of-<n>.spec.mjs`);
  const share = Number(match[1]);
  const shares = Number(match[2]);
  const present = fs.readdirSync(path.dirname(file)).filter(entry => name.test(entry)).sort();
  const expected = Array.from({ length: shares }, (_, index) => `control-walk-${index + 1}-of-${shares}.spec.mjs`).sort();
  if (JSON.stringify(present) !== JSON.stringify(expected)) {
    throw new Error(`The control walk's spec files are ${present.join(', ')}; they must be exactly ${expected.join(', ')}`);
  }
  // The walk checks the app's own logic (one step per change, exact undo),
  // which does not depend on the engine; on Firefox and WebKit, and above all
  // macOS Firefox's slow GL, it would only add hours of CI time.
  test.skip(({ browserName }) => browserName !== 'chromium', 'The control walk runs on Chromium only');
  for (const name of walkShares(WALK_TESTS, readWalkWeights(), shares)[share - 1]) declareWalkTest(test, name);
}
