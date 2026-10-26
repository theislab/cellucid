/**
 * @fileoverview The one control kit for the sidebar, its floating panels and
 * the analysis windows.
 *
 * Static markup in `index.html` and every JavaScript builder produce the same
 * elements and classes, so a control looks, reads and behaves the same
 * wherever it is drawn. The standard these builders implement is written down
 * in `assets/css/README.md` ("Sidebar control standard"); the classes they set
 * are styled only in `assets/css/components/_controls.css` and `_buttons.css`.
 *
 * Every builder returns plain DOM and wires at most the listener the caller
 * passes in. Visibility is always the `hidden` attribute, never an inline
 * `display`, and every disclosure owns its `aria-expanded`/`aria-controls`.
 *
 * @module ui/components/controls
 */

import { runBeforeNextFrame } from '../../../rendering/frame-phases.js';
import { createDomId } from './dom-id.js';
import { renderInfoTip } from './info-tips.js';

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be exact non-empty text`);
  }
  return value;
}

function requireLabelText(value) {
  requireText(value, 'Control label');
  // Labels sit above their control, so they never end in a colon.
  if (value.endsWith(':')) {
    throw new TypeError(`Control label "${value}" must not end with a colon`);
  }
  return value;
}

function optionalFunction(value, label) {
  if (value !== undefined && value !== null && typeof value !== 'function') {
    throw new TypeError(`${label} must be a function`);
  }
  return typeof value === 'function' ? value : null;
}

function idPrefix(text) {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(slug) ? slug.slice(0, 32).replace(/-+$/, '') : `control-${slug}`.slice(0, 32);
}

/**
 * A field: its label above the control it names. The label is a real
 * `<label for>`, so clicking it focuses the control and the control is
 * announced by its visible name. A field that needs explaining names a tip:
 * the explanation lives in the (i) beside the label, never in a help line.
 *
 * @param {object} options
 * @param {string} options.label - Visible label, sentence case, no colon.
 * @param {HTMLElement} options.control - The input, select or textarea.
 * @param {string} [options.tip] - Registry key of the field's (i) tip.
 * @param {string} [options.className] - Extra class for the block.
 * @returns {HTMLDivElement}
 */
export function createField({ label, control, tip, className }) {
  requireLabelText(label);
  if (!(control instanceof HTMLElement)) {
    throw new TypeError('A field requires its control element');
  }
  const block = document.createElement('div');
  block.className = className ? `control-block ${className}` : 'control-block';
  if (!control.id) control.id = createDomId(idPrefix(label));
  const labelEl = document.createElement('label');
  labelEl.htmlFor = control.id;
  labelEl.textContent = label;
  if (tip === undefined) {
    block.appendChild(labelEl);
  } else {
    const info = createInfoTip({ tip, label: `About ${label.toLowerCase()}` });
    const row = document.createElement('div');
    row.className = 'field-label-row';
    row.append(labelEl, info.button);
    block.append(row, info.popover);
  }
  block.appendChild(control);
  return block;
}

/**
 * A native select with the standard box style.
 *
 * @param {object} options
 * @param {Array<{value: string, label: string, selected?: boolean}>} options.options
 * @param {string} [options.name]
 * @param {string} [options.id]
 * @param {(value: string) => void} [options.onChange]
 * @returns {HTMLSelectElement}
 */
export function createSelect({ options, name, id, onChange }) {
  if (!Array.isArray(options)) throw new TypeError('A select requires its options');
  const select = document.createElement('select');
  select.className = 'obs-select';
  if (name !== undefined) select.name = requireText(name, 'Select name');
  if (id !== undefined) select.id = requireText(id, 'Select id');
  for (const entry of options) {
    const option = document.createElement('option');
    option.value = String(entry.value);
    option.textContent = requireText(entry.label, 'Option label');
    if (entry.selected === true) option.selected = true;
    select.appendChild(option);
  }
  const handler = optionalFunction(onChange, 'Select change handler');
  if (handler) select.addEventListener('change', () => handler(select.value));
  return select;
}

/**
 * Coalesce a stream of calls to one per animation frame, always with the
 * latest arguments. A slider fires `input` for every pixel the thumb moves —
 * several times per frame on a fast pointer — and nothing it drives can show
 * more than one value per frame.
 *
 * The call runs at the top of the next frame, before the viewer draws it
 * (`rendering/frame-phases.js`), so the value is on screen that same frame;
 * a plain animation frame would run after the viewer and show it a frame late.
 *
 * @template {unknown[]} A
 * @param {(...args: A) => void} fn
 * @returns {((...args: A) => void) & { flush: () => void, cancel: () => void }}
 */
export function coalesceToFrame(fn) {
  if (typeof fn !== 'function') throw new TypeError('coalesceToFrame requires a function');
  let cancelFrame = null;
  let pending = null;
  const run = () => {
    cancelFrame = null;
    const args = pending;
    pending = null;
    if (args !== null) fn(...args);
  };
  const scheduled = (...args) => {
    pending = args;
    if (cancelFrame === null) cancelFrame = runBeforeNextFrame(run);
  };
  scheduled.flush = () => {
    if (cancelFrame !== null) cancelFrame();
    run();
  };
  scheduled.cancel = () => {
    if (cancelFrame !== null) cancelFrame();
    cancelFrame = null;
    pending = null;
  };
  return scheduled;
}

/**
 * A labelled range slider with its value readout.
 *
 * `onInput` runs at most once per frame while the thumb moves (see
 * {@link coalesceToFrame}); `onCommit` runs once when the user lets go. The
 * readout is an `<output for>` updated in the same frame, so it never lags
 * behind or runs ahead of what the slider drives.
 *
 * @param {object} options
 * @param {string} options.label
 * @param {number} options.min
 * @param {number} options.max
 * @param {number} options.step
 * @param {number} options.value
 * @param {(value: number) => string} options.format - Readout text.
 * @param {(value: number) => void} [options.onInput]
 * @param {(value: number) => void} [options.onCommit]
 * @param {string} [options.id]
 * @returns {{ root: HTMLDivElement, input: HTMLInputElement, readout: HTMLOutputElement, setValue: (value: number) => void }}
 */
export function createSliderField({
  label,
  min,
  max,
  step,
  value,
  format,
  onInput,
  onCommit,
  id
}) {
  requireLabelText(label);
  for (const [name, number] of [['min', min], ['max', max], ['step', step], ['value', value]]) {
    if (typeof number !== 'number' || !Number.isFinite(number)) {
      throw new TypeError(`Slider ${name} must be a finite number`);
    }
  }
  if (typeof format !== 'function') throw new TypeError('A slider requires a readout format');
  const inputHandler = optionalFunction(onInput, 'Slider input handler');
  const commitHandler = optionalFunction(onCommit, 'Slider commit handler');

  const input = document.createElement('input');
  input.type = 'range';
  input.id = id === undefined ? createDomId(idPrefix(label)) : requireText(id, 'Slider id');
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);

  const readout = document.createElement('output');
  readout.className = 'slider-value';
  readout.setAttribute('for', input.id);

  const labelEl = document.createElement('label');
  labelEl.htmlFor = input.id;
  labelEl.textContent = label;

  const row = document.createElement('div');
  row.className = 'slider-row';
  row.appendChild(input);
  row.appendChild(readout);

  const root = document.createElement('div');
  root.className = 'control-block';
  root.appendChild(labelEl);
  root.appendChild(row);

  const read = () => Number(input.value);
  const paint = () => {
    readout.textContent = format(read());
  };
  const frame = coalesceToFrame(() => {
    paint();
    inputHandler?.(read());
  });
  input.addEventListener('input', () => frame());
  input.addEventListener('change', () => {
    frame.flush();
    commitHandler?.(read());
  });
  paint();

  return {
    root,
    input,
    readout,
    setValue(next) {
      input.value = String(next);
      frame.cancel();
      paint();
    }
  };
}

/**
 * A checkbox and its option text. The label wraps the input, so the whole row
 * is the target and the input is named by the visible text.
 *
 * @param {object} options
 * @param {string} options.label - Option text, sentence case.
 * @param {boolean} [options.checked=false]
 * @param {string} [options.name]
 * @param {string} [options.id]
 * @param {(checked: boolean) => void} [options.onChange]
 * @returns {{ root: HTMLLabelElement, input: HTMLInputElement }}
 */
export function createCheckbox({ label, checked = false, name, id, onChange }) {
  requireLabelText(label);
  if (typeof checked !== 'boolean') throw new TypeError('Checkbox state must be boolean');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id === undefined ? createDomId(idPrefix(label)) : requireText(id, 'Checkbox id');
  if (name !== undefined) input.name = requireText(name, 'Checkbox name');
  input.checked = checked;
  const root = document.createElement('label');
  root.className = 'checkbox-inline';
  root.htmlFor = input.id;
  root.appendChild(input);
  root.appendChild(document.createTextNode(label));
  const handler = optionalFunction(onChange, 'Checkbox change handler');
  if (handler) input.addEventListener('change', () => handler(input.checked));
  return { root, input };
}

/**
 * An on/off switch: a `role="switch"` button whose visible label is its name.
 * Use it for a setting that takes effect immediately; a checkbox is for an
 * option that is read when something else runs.
 *
 * @param {object} options
 * @param {string} options.label
 * @param {boolean} [options.checked=false]
 * @param {(checked: boolean) => void} [options.onChange]
 * @returns {{ root: HTMLButtonElement, setChecked: (checked: boolean) => void }}
 */
export function createSwitch({ label, checked = false, onChange }) {
  requireLabelText(label);
  const root = document.createElement('button');
  root.type = 'button';
  root.className = 'switch';
  root.setAttribute('role', 'switch');
  const track = document.createElement('span');
  track.className = 'switch-track';
  track.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'switch-label';
  text.textContent = label;
  root.appendChild(track);
  root.appendChild(text);
  const setChecked = next => {
    if (typeof next !== 'boolean') throw new TypeError('Switch state must be boolean');
    root.setAttribute('aria-checked', String(next));
  };
  setChecked(checked);
  const handler = optionalFunction(onChange, 'Switch change handler');
  root.addEventListener('click', () => {
    const next = root.getAttribute('aria-checked') !== 'true';
    setChecked(next);
    handler?.(next);
  });
  return { root, setChecked };
}

/**
 * A button. `primary` is the one action that commits a panel's work (run,
 * export, load); everything else is `secondary`.
 *
 * @param {object} options
 * @param {string} options.label - Sentence case; CSS sets the visual case.
 * @param {'primary'|'secondary'} [options.variant='secondary']
 * @param {string} [options.title]
 * @param {string} [options.className] - Extra hook class for the caller.
 * @param {(event: MouseEvent) => void} [options.onClick]
 * @returns {HTMLButtonElement}
 */
export function createButton({ label, variant = 'secondary', title, className, onClick }) {
  requireText(label, 'Button label');
  if (variant !== 'primary' && variant !== 'secondary') {
    throw new TypeError(`Unknown button variant "${variant}"`);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = ['btn', variant === 'primary' ? 'btn-primary' : null, className]
    .filter(Boolean).join(' ');
  button.textContent = label;
  if (title !== undefined) button.title = requireText(title, 'Button title');
  const handler = optionalFunction(onClick, 'Button click handler');
  if (handler) button.addEventListener('click', handler);
  return button;
}

/**
 * An icon-only button. Its accessible name and its hover tooltip are the same
 * words, so a pointer user reads what a screen reader announces.
 *
 * @param {object} options
 * @param {string} options.label - Accessible name and tooltip.
 * @param {string} options.icon - Inline SVG markup (decorative).
 * @param {'neutral'|'danger'} [options.tone='neutral']
 * @param {string} [options.className] - Extra hook class for the caller.
 * @param {(event: MouseEvent) => void} [options.onClick]
 * @returns {HTMLButtonElement}
 */
export function createIconButton({ label, icon, tone = 'neutral', className, onClick }) {
  requireText(label, 'Icon button label');
  requireText(icon, 'Icon markup');
  if (tone !== 'neutral' && tone !== 'danger') {
    throw new TypeError(`Unknown icon button tone "${tone}"`);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = ['icon-btn', tone === 'danger' ? 'icon-btn-danger' : null, className]
    .filter(Boolean).join(' ');
  button.setAttribute('aria-label', label);
  button.title = label;
  // The glyph is decoration: the button is named by its label.
  button.innerHTML = icon.startsWith('<svg ') && !icon.includes('aria-hidden')
    ? icon.replace('<svg ', '<svg aria-hidden="true" focusable="false" ')
    : icon;
  const handler = optionalFunction(onClick, 'Icon button click handler');
  if (handler) button.addEventListener('click', handler);
  return button;
}

/** Shared decorative icons, so one action draws one glyph everywhere. */
export const ICONS = Object.freeze({
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  rename: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  delete: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>'
});

/**
 * A segmented control: two to four mutually exclusive settings in one
 * bordered strip, each a toggle button with `aria-pressed`.
 *
 * @param {object} options
 * @param {string} options.label - Accessible name of the group.
 * @param {Array<{value: string, label: string}>} options.options
 * @param {string} options.value
 * @param {(value: string) => void} [options.onChange]
 * @returns {{ root: HTMLDivElement, setValue: (value: string) => void }}
 */
export function createSegmented({ label, options, value, onChange }) {
  requireLabelText(label);
  if (!Array.isArray(options) || options.length < 2) {
    throw new TypeError('A segmented control requires at least two options');
  }
  const root = document.createElement('div');
  root.className = 'segmented';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', label);
  const buttons = options.map(option => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'segmented-btn';
    button.dataset.value = requireText(String(option.value), 'Segment value');
    button.textContent = requireText(option.label, 'Segment label');
    root.appendChild(button);
    return button;
  });
  const setValue = next => {
    if (!buttons.some(button => button.dataset.value === next)) {
      throw new RangeError(`Segmented control has no option "${next}"`);
    }
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(button.dataset.value === next));
    }
  };
  setValue(value);
  const handler = optionalFunction(onChange, 'Segmented change handler');
  root.addEventListener('click', event => {
    const button = event.target.closest?.('.segmented-btn');
    if (!button || !root.contains(button)) return;
    if (button.getAttribute('aria-pressed') === 'true') return;
    setValue(button.dataset.value);
    handler?.(button.dataset.value);
  });
  return { root, setValue };
}

/**
 * An (i) button and the tip it opens, rendered from the tip registry. The
 * document's info-popover controller opens and positions it like any static
 * tip; the caller places the button beside its heading or control and the
 * popover anywhere in the same panel.
 *
 * @param {object} options
 * @param {string} options.tip - A key of the tip registry (info-tips.js).
 * @param {string} options.label - The button's accessible name ("About …").
 * @returns {{ button: HTMLButtonElement, popover: HTMLDivElement }}
 */
export function createInfoTip({ tip, label }) {
  requireLabelText(label);
  const popoverId = createDomId(`info-${tip}`);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'info-btn';
  button.id = `${popoverId}-trigger`;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-controls', popoverId);
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  const glyph = document.createElement('span');
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = 'i';
  button.appendChild(glyph);
  const popover = document.createElement('div');
  popover.className = 'info-tooltip';
  popover.id = popoverId;
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-labelledby', button.id);
  popover.tabIndex = -1;
  popover.hidden = true;
  renderInfoTip(popover, tip);
  return { button, popover };
}

/**
 * A control with its (i) beside it: the control and the info button share one
 * row, and the popover follows the row. Explanations live in the tip, never
 * in a help line under the control.
 *
 * @param {HTMLElement} control - A switch, checkbox label or similar row.
 * @param {{ button: HTMLButtonElement, popover: HTMLDivElement }} info - From
 *   {@link createInfoTip}.
 * @returns {HTMLDivElement}
 */
export function createInfoRow(control, info) {
  if (!(control instanceof HTMLElement)) {
    throw new TypeError('An info row requires its control element');
  }
  if (!(info?.button instanceof HTMLElement) || !(info?.popover instanceof HTMLElement)) {
    throw new TypeError('An info row requires the pair createInfoTip returns');
  }
  const block = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'checkbox-info-row';
  row.append(control, info.button);
  block.append(row, info.popover);
  return block;
}

/**
 * A sub-section heading inside a panel, with an optional info button beside
 * it. The group that follows is labelled by the heading.
 *
 * @param {object} options
 * @param {string} options.title - Sentence case, no colon.
 * @param {HTMLElement} [options.info] - An `.info-btn` to place after the title.
 * @returns {{ root: HTMLDivElement, heading: HTMLHeadingElement, body: HTMLDivElement }}
 */
export function createGroup({ title, info }) {
  requireLabelText(title);
  const root = document.createElement('div');
  root.className = 'control-group';
  root.setAttribute('role', 'group');
  const header = document.createElement('div');
  header.className = 'control-group-header';
  const heading = document.createElement('h3');
  heading.className = 'section-title';
  heading.id = createDomId(idPrefix(title));
  heading.textContent = title;
  header.appendChild(heading);
  if (info !== undefined) {
    if (!(info instanceof HTMLElement) || !info.classList.contains('info-btn')) {
      throw new TypeError('A group info control must be an .info-btn');
    }
    header.appendChild(info);
  }
  root.setAttribute('aria-labelledby', heading.id);
  const body = document.createElement('div');
  body.className = 'control-group-body';
  root.appendChild(header);
  root.appendChild(body);
  return { root, heading, body };
}

/**
 * A status line: one sentence about the state of the control above it.
 * It is a polite live region, so a change is announced without moving focus.
 * It is never hidden while empty: a live region must already be in the
 * accessibility tree when its first message arrives.
 *
 * @param {object} [options]
 * @param {'muted'|'info'|'success'|'warning'|'danger'} [options.tone='muted']
 * @param {string} [options.text]
 * @returns {{ root: HTMLParagraphElement, set: (text: string, tone?: string) => void }}
 */
export function createStatusLine({ tone = 'muted', text = '' } = {}) {
  const root = document.createElement('p');
  root.className = 'status-line';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  const set = (nextText, nextTone = tone) => {
    if (typeof nextText !== 'string') throw new TypeError('Status text must be a string');
    if (!STATUS_TONES.has(nextTone)) throw new TypeError(`Unknown status tone "${nextTone}"`);
    // Unchanged text is not rewritten: rewriting it replaces the text node,
    // which a browser's scroll anchoring can take as a change of content.
    if (root.dataset.tone !== nextTone) root.dataset.tone = nextTone;
    if (root.textContent !== nextText) root.textContent = nextText;
  };
  set(text, tone);
  return { root, set };
}

const STATUS_TONES = new Set(['muted', 'info', 'success', 'warning', 'danger']);

/**
 * An empty state: what a list or panel shows while it has nothing to show,
 * and, where there is one, what to do about it.
 *
 * @param {string} text
 * @returns {HTMLParagraphElement}
 */
export function createEmptyState(text) {
  const root = document.createElement('p');
  root.className = 'empty-state';
  root.textContent = requireText(text, 'Empty state text');
  return root;
}

/**
 * A collapsible sub-section: a full-width header button that shows and hides
 * the region under it. The button carries `aria-expanded` and
 * `aria-controls`; the region is hidden with the `hidden` attribute.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.description] - A short status beside the title
 *   (a count, the current choice); never an explanation, which goes in `tip`.
 * @param {string} [options.tip] - Registry key of an (i) beside the header.
 * @param {boolean} [options.expanded=false]
 * @param {(expanded: boolean) => void} [options.onToggle]
 * @param {string} [options.className] - Extra class for the item.
 * @returns {{ root: HTMLDivElement, header: HTMLButtonElement, content: HTMLDivElement, setExpanded: (expanded: boolean) => void }}
 */
export function createDisclosure({ title, description, tip, expanded = false, onToggle, className }) {
  requireLabelText(title);
  if (typeof expanded !== 'boolean') throw new TypeError('Disclosure state must be boolean');
  const root = document.createElement('div');
  root.className = className ? `disclosure ${className}` : 'disclosure';
  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'disclosure-header';
  const titleEl = document.createElement('span');
  titleEl.className = 'disclosure-title';
  titleEl.textContent = title;
  header.appendChild(titleEl);
  if (description !== undefined) {
    const descEl = document.createElement('span');
    descEl.className = 'disclosure-desc';
    descEl.textContent = requireText(description, 'Disclosure description');
    header.appendChild(descEl);
  }
  const chevron = document.createElement('span');
  chevron.className = 'disclosure-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  header.appendChild(chevron);
  const content = document.createElement('div');
  content.className = 'disclosure-content';
  content.id = createDomId(idPrefix(title));
  if (tip === undefined) {
    root.appendChild(header);
  } else {
    // The (i) is the header's sibling, never nested in the toggle button.
    const info = createInfoTip({ tip, label: `About ${title.toLowerCase()}` });
    const row = document.createElement('div');
    row.className = 'disclosure-header-row';
    row.append(header, info.button);
    root.append(row, info.popover);
  }
  root.appendChild(content);
  const setExpanded = bindDisclosure({ header, content, expanded, onToggle });
  return { root, header, content, setExpanded };
}

/**
 * Wire an existing disclosure header button to the region it shows and hides
 * (static or template markup with the `.disclosure` classes). Sets
 * `aria-controls`, owns `aria-expanded` and the region's `hidden`.
 *
 * @param {object} options
 * @param {HTMLButtonElement} options.header
 * @param {HTMLElement} options.content
 * @param {boolean} [options.expanded=false]
 * @param {(expanded: boolean) => void} [options.onToggle]
 * @param {AbortSignal} [options.signal]
 * @returns {(expanded: boolean) => void} Applies a new expanded state.
 */
export function bindDisclosure({ header, content, expanded = false, onToggle, signal }) {
  if (!header || String(header.localName ?? header.tagName).toLowerCase() !== 'button') {
    throw new TypeError('A disclosure header must be a button');
  }
  if (!content || typeof content.setAttribute !== 'function') {
    throw new TypeError('A disclosure requires its content region');
  }
  if (!content.id) content.id = createDomId('disclosure');
  header.setAttribute('aria-controls', content.id);
  const setExpanded = next => {
    if (typeof next !== 'boolean') throw new TypeError('Disclosure state must be boolean');
    header.setAttribute('aria-expanded', String(next));
    content.hidden = !next;
  };
  setExpanded(expanded);
  const handler = optionalFunction(onToggle, 'Disclosure toggle handler');
  header.addEventListener('click', () => {
    const next = header.getAttribute('aria-expanded') !== 'true';
    setExpanded(next);
    handler?.(next);
  }, signal === undefined ? undefined : { signal });
  return setExpanded;
}

/**
 * A row in a `.list-box` the user switches on and off and removes (an active
 * filter, a highlighted group): an enable checkbox named by the row's text, the
 * text, and a remove icon button. Rows carry no listeners; the list delegates
 * `change` and `click` and finds the row by its `data-*` id.
 *
 * @param {object} options
 * @param {string} options.text - The visible text.
 * @param {boolean} options.enabled
 * @param {string} options.noun - What the row is ("filter", "highlight"), used
 *   in the accessible names of the checkbox and the remove button.
 * @returns {{ root: HTMLDivElement, checkbox: HTMLInputElement, remove: HTMLButtonElement }}
 */
/**
 * The list-item control that has keyboard focus inside `list`, as where it
 * is (`createListItem` rows carrying their item's id in `dataset[idKey]`):
 * its item, its kind (checkbox or remove), its row's position. Null when the
 * focus is elsewhere.
 *
 * @param {HTMLElement} list
 * @param {string} idKey
 */
export function captureListItemFocus(list, idKey) {
  const active = document.activeElement ?? null;
  if (active === null || active === document.body || !list.contains?.(active)) return null;
  const row = active.closest?.('.list-item') ?? null;
  if (row === null) return { id: null, kind: null, position: -1 };
  return {
    id: row.dataset[idKey] ?? null,
    kind: active.classList.contains('list-item-remove') ? '.list-item-remove' : 'input[type="checkbox"]',
    position: [...list.children].indexOf(row),
  };
}

/**
 * Put the focus back after `list` was rebuilt: on the same control of the
 * same item, else (the item went) on that control of the row now in its
 * place, else on the list itself, so a keyboard user is never dropped to
 * the page.
 *
 * @param {HTMLElement} list
 * @param {ReturnType<typeof captureListItemFocus>} captured
 * @param {string} idKey
 */
export function restoreListItemFocus(list, captured, idKey) {
  if (captured === null) return;
  const rows = [...list.querySelectorAll('.list-item')];
  const row = (captured.id === null ? undefined : rows.find(item => item.dataset[idKey] === captured.id))
    ?? (captured.position < 0 ? undefined : rows[Math.min(captured.position, rows.length - 1)])
    ?? null;
  const target = captured.kind === null ? null : row?.querySelector(captured.kind) ?? null;
  if (target !== null) {
    target.focus({ preventScroll: true });
    return;
  }
  if (!list.hasAttribute('tabindex')) list.tabIndex = -1;
  list.focus({ preventScroll: true });
}

export function createListItem({ text, enabled, noun }) {
  requireText(text, 'List item text');
  requireText(noun, 'List item noun');
  if (typeof enabled !== 'boolean') throw new TypeError('List item state must be boolean');
  const root = document.createElement('div');
  root.className = 'list-item';
  if (!enabled) root.dataset.disabled = 'true';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = enabled;
  checkbox.setAttribute('aria-label', `Apply ${noun}: ${text}`);
  checkbox.title = enabled ? `Turn this ${noun} off` : `Turn this ${noun} on`;
  const textEl = document.createElement('span');
  textEl.className = 'list-item-text';
  textEl.textContent = text;
  textEl.title = text;
  const remove = createIconButton({
    label: `Remove this ${noun}`,
    icon: ICONS.close,
    tone: 'danger',
    className: 'list-item-remove'
  });
  // Every row has one: each is named for its own item, like its checkbox.
  remove.setAttribute('aria-label', `Remove ${noun}: ${text}`);
  root.appendChild(checkbox);
  root.appendChild(textEl);
  root.appendChild(remove);
  return { root, checkbox, remove };
}
