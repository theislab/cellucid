/**
 * @fileoverview An analysis form drawn from its options schema
 * (`option-schema.js`): the essentials, always shown, then one collapsed
 * "More options" disclosure holding a collapsed disclosure per group. Each
 * header counts the options changed from their defaults ("2 changed"); a
 * Reset link puts them back. An option whose `when` does not hold is hidden.
 * Every control carries its (i) tip; no explanation is drawn under a
 * control.
 *
 * The form holds one options record. It never runs anything: the caller
 * places the Run button after `root` and reads `getValue()`.
 *
 * Which disclosures are open is the viewer's, not the analysis's: it is
 * reported through `onViewChange` and saved in the session's `view` record.
 *
 * @module analysis/options/render-options-form
 */

import {
  createDisclosure,
  createField,
  createInfoTip,
  createInfoRow,
  createSegmented,
  createSelect,
  createSwitch
} from '../../ui/components/controls.js';
import { createDomId } from '../../ui/components/dom-id.js';
import { createGroupPicker } from '../ui/components/group-picker.js';
import { createGeneSetEditor } from '../ui/components/gene-set-editor.js';
import { choicesOf, sameOptionValue } from './option-schema.js';

function labelBlock(entry, control) {
  // A label for a control that is not itself labelable (a segmented strip, a
  // chip row, a picker): the label names the group by aria-labelledby.
  const block = document.createElement('div');
  block.className = 'control-block';
  const row = document.createElement('div');
  row.className = 'field-label-row';
  const label = document.createElement('span');
  label.className = 'field-label';
  label.id = createDomId(`option-${entry.key}`);
  label.textContent = entry.label;
  const info = createInfoTip({ tip: entry.tip, label: `About ${entry.label.toLowerCase()}` });
  row.append(label, info.button);
  block.append(row, info.popover, control);
  if (!control.hasAttribute('aria-label')) control.setAttribute('aria-labelledby', label.id);
  return block;
}

/**
 * @param {object} options
 * @param {ReturnType<import('./option-schema.js').defineOptions>} options.schema
 * @param {object} options.value - A valid options record
 * @param {object} [options.context] - What the data offers; passed to
 *   choices, `when`, `check` and data-dependent defaults. For `groups`
 *   options: `groupsFor(entry, record)` → `[{id, name, count, color}]` and
 *   `minCellsFor(entry, record)`; for `gene-sets`: `getGenes()` and
 *   `getMarkerSets()`; for `variable`: `createVariableControl(entry, value,
 *   onChange)` → `{root, set, destroy?}`.
 * @param {{more?: boolean, groups?: string[]}} [options.view] - Open
 *   disclosures
 * @param {(record: object, key: string) => void} [options.onChange]
 * @param {(view: {more: boolean, groups: string[]}) => void} [options.onViewChange]
 */
export function renderOptionsForm({
  schema,
  value,
  context = {},
  view = { more: false, groups: [] },
  onChange = null,
  onViewChange = null,
}) {
  let record = schema.normalize(value, context);
  let currentContext = context;
  const openGroups = new Set(view.groups ?? []);
  let moreOpen = view.more === true;
  const abort = new AbortController();

  const root = document.createElement('div');
  root.className = 'analysis-options-form';
  root.dataset.options = schema.id;
  const essentials = document.createElement('div');
  essentials.className = 'analysis-options-essentials';
  root.appendChild(essentials);

  /** @type {Map<string, {block: HTMLElement, set: (value: unknown) => void, refreshChoices?: () => void, destroy?: () => void}>} */
  const controls = new Map();

  const commit = (key, next) => {
    if (sameOptionValue(record[key], next)) return;
    const candidate = { ...record, [key]: next };
    const reason = schema.refuse(key, next, candidate, currentContext);
    if (reason !== null) {
      const control = controls.get(key);
      control?.markInvalid?.(reason);
      return;
    }
    controls.get(key)?.markInvalid?.(null);
    record = candidate;
    reconcileDependents(key);
    refresh();
    onChange?.(structuredClone(record), key);
  };

  /**
   * A dependent choice that no longer holds its value returns to its default,
   * else its first choice. Choices not known yet (null: the data is still
   * being read) keep the value.
   */
  const reconcileDependents = changedKey => {
    for (const entry of schema.entries) {
      if (entry.key === changedKey || typeof entry.choices !== 'function') continue;
      const choices = choicesOf(entry, currentContext, record);
      if (choices === null) continue;
      if (entry.kind === 'flags') {
        const allowed = new Set(choices.map(choice => choice.value));
        const kept = record[entry.key].filter(item => allowed.has(item));
        if (kept.length !== record[entry.key].length) record = { ...record, [entry.key]: kept };
        continue;
      }
      if (choices.some(choice => choice.value === record[entry.key])) continue;
      const preferred = schema.defaultOf(entry.key, currentContext);
      const next = choices.some(choice => choice.value === preferred) ? preferred : (choices[0]?.value ?? preferred);
      record = { ...record, [entry.key]: next };
    }
  };

  const buildControl = entry => {
    const key = entry.key;
    switch (entry.kind) {
      case 'select': {
        const select = createSelect({ name: key, options: [{ value: '', label: '—' }] });
        const refreshChoices = () => {
          // Choices not known yet show the value held, until they are.
          const choices = choicesOf(entry, currentContext, record) ?? [{ value: record[key], label: '…' }];
          select.replaceChildren(...choices.map(choice => {
            const option = document.createElement('option');
            option.value = choice.value;
            option.textContent = choice.label;
            return option;
          }));
          select.value = record[key];
          select.disabled = choices.length === 0;
        };
        select.addEventListener('change', () => commit(key, select.value), { signal: abort.signal });
        const block = createField({ label: entry.label, control: select, tip: entry.tip, className: 'field-select' });
        refreshChoices();
        return { block, set: v => { select.value = v; }, refreshChoices, focus: () => select.focus() };
      }
      case 'segmented': {
        const choices = choicesOf(entry, currentContext, record) ?? [];
        const segmented = createSegmented({
          label: entry.label,
          options: choices.map(choice => ({ value: choice.value, label: choice.label })),
          value: record[key],
          onChange: next => commit(key, next),
        });
        segmented.root.removeAttribute('aria-label');
        return { block: labelBlock(entry, segmented.root), set: v => segmented.setValue(v) };
      }
      case 'number': {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'obs-select analysis-number-input';
        input.name = key;
        input.step = entry.integer === true ? '1' : 'any';
        if (entry.min !== undefined) input.min = String(entry.min);
        if (entry.max !== undefined) input.max = String(entry.max);
        input.inputMode = entry.integer === true ? 'numeric' : 'decimal';
        input.value = String(record[key]);
        const markInvalid = reason => {
          if (reason === null) {
            input.removeAttribute('aria-invalid');
            input.removeAttribute('title');
          } else {
            input.setAttribute('aria-invalid', 'true');
            input.title = reason;
          }
        };
        input.addEventListener('change', () => {
          const parsed = input.value.trim() === '' ? NaN : Number(input.value);
          commit(key, parsed);
          if (!Number.isFinite(parsed)) markInvalid(`${entry.label} must be a number`);
        }, { signal: abort.signal });
        const block = createField({ label: entry.label, control: input, tip: entry.tip });
        return { block, set: v => { input.value = String(v); markInvalid(null); }, markInvalid, focus: () => input.focus() };
      }
      case 'boolean': {
        const toggle = createSwitch({ label: entry.label, checked: record[key], onChange: next => commit(key, next) });
        const info = createInfoTip({ tip: entry.tip, label: `About ${entry.label.toLowerCase()}` });
        return { block: createInfoRow(toggle.root, info), set: v => toggle.setChecked(v) };
      }
      case 'text': {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'obs-select';
        input.name = key;
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.value = record[key];
        const markInvalid = reason => {
          if (reason === null) {
            input.removeAttribute('aria-invalid');
            input.removeAttribute('title');
          } else {
            input.setAttribute('aria-invalid', 'true');
            input.title = reason;
          }
        };
        input.addEventListener('change', () => commit(key, input.value.trim()), { signal: abort.signal });
        const block = createField({ label: entry.label, control: input, tip: entry.tip });
        return { block, set: v => { input.value = v; markInvalid(null); }, markInvalid };
      }
      case 'flags': {
        const row = document.createElement('div');
        row.className = 'analysis-flag-row';
        row.setAttribute('role', 'group');
        const refreshChoices = () => {
          const choices = choicesOf(entry, currentContext, record) ?? [];
          row.replaceChildren(...choices.map(choice => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'analysis-flag';
            button.dataset.value = choice.value;
            button.textContent = choice.label;
            if (choice.title) button.title = choice.title;
            button.setAttribute('aria-pressed', String(record[key].includes(choice.value)));
            return button;
          }));
        };
        row.addEventListener('click', event => {
          const button = event.target.closest?.('.analysis-flag');
          if (!button || !row.contains(button)) return;
          const valueOf = button.dataset.value;
          const next = record[key].includes(valueOf)
            ? record[key].filter(item => item !== valueOf)
            : [...record[key], valueOf];
          commit(key, next);
        }, { signal: abort.signal });
        refreshChoices();
        return { block: labelBlock(entry, row), set: () => refreshChoices(), refreshChoices };
      }
      case 'groups': {
        const groupsFor = currentContext.groupsFor;
        if (typeof groupsFor !== 'function') throw new TypeError(`Option "${key}" needs context.groupsFor`);
        const picker = createGroupPicker({
          label: entry.label,
          groups: groupsFor(entry, record),
          value: record[key],
          minCells: currentContext.minCellsFor?.(entry, record) ?? null,
          onChange: next => commit(key, next),
        });
        const refreshChoices = () => {
          picker.setGroups(currentContext.groupsFor(entry, record), currentContext.minCellsFor?.(entry, record) ?? null);
          const next = picker.getValue();
          if (!sameOptionValue(next, record[key])) record = { ...record, [key]: next };
        };
        return {
          block: labelBlock(entry, picker.root),
          set: v => picker.setValue(v),
          refreshChoices,
          destroy: () => picker.destroy(),
        };
      }
      case 'gene-sets': {
        if (typeof currentContext.getGenes !== 'function') throw new TypeError(`Option "${key}" needs context.getGenes`);
        const editor = createGeneSetEditor({
          value: record[key],
          getGenes: () => currentContext.getGenes(),
          getMarkerSets: typeof currentContext.getMarkerSets === 'function' ? () => currentContext.getMarkerSets() : null,
          onChange: next => commit(key, next),
        });
        return {
          block: labelBlock(entry, editor.root),
          set: v => editor.setValue(v),
          refreshChoices: () => editor.refresh(),
          destroy: () => editor.destroy(),
        };
      }
      case 'variable': {
        if (typeof currentContext.createVariableControl !== 'function') {
          throw new TypeError(`Option "${key}" needs context.createVariableControl`);
        }
        const control = currentContext.createVariableControl(entry, record[key], next => commit(key, next));
        return {
          block: control.root,
          set: v => control.set(v),
          destroy: () => control.destroy?.()
        };
      }
      default:
        throw new RangeError(`No control for option kind ${entry.kind}`);
    }
  };

  for (const entry of schema.group('essentials')) {
    const control = buildControl(entry);
    control.block.dataset.option = entry.key;
    controls.set(entry.key, control);
    essentials.appendChild(control.block);
  }

  const countText = keys => (keys.length === 0 ? '' : `${keys.length} changed`);
  const addCount = header => {
    const count = document.createElement('span');
    count.className = 'disclosure-desc analysis-options-changed';
    header.insertBefore(count, header.querySelector('.disclosure-chevron'));
    return count;
  };

  let more = null;
  let moreCount = null;
  let resetButton = null;
  const groupParts = [];
  if (schema.groups.length > 0) {
    more = createDisclosure({
      title: 'More options',
      expanded: moreOpen,
      className: 'disclosure-inline analysis-more-options',
      onToggle: expanded => {
        moreOpen = expanded;
        reportView();
      },
    });
    moreCount = addCount(more.header);
    resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'analysis-link-btn analysis-options-reset';
    resetButton.textContent = 'Reset to defaults';
    resetButton.addEventListener('click', () => {
      const defaults = schema.defaults(currentContext);
      const essentialKeys = new Set(schema.group('essentials').map(entry => entry.key));
      for (const entry of schema.entries) {
        if (!essentialKeys.has(entry.key)) record = { ...record, [entry.key]: defaults[entry.key] };
      }
      reconcileDependents(null);
      for (const [key, control] of controls) control.set(record[key]);
      refresh();
      onChange?.(structuredClone(record), null);
    }, { signal: abort.signal });
    more.content.appendChild(resetButton);
    for (const group of schema.groups) {
      const part = createDisclosure({
        title: group.title,
        tip: group.tip ?? undefined,
        expanded: openGroups.has(group.id),
        className: 'disclosure-inline analysis-options-group',
        onToggle: expanded => {
          if (expanded) openGroups.add(group.id);
          else openGroups.delete(group.id);
          reportView();
        },
      });
      part.root.dataset.group = group.id;
      const count = addCount(part.header);
      for (const entry of schema.group(group.id)) {
        const control = buildControl(entry);
        control.block.dataset.option = entry.key;
        controls.set(entry.key, control);
        part.content.appendChild(control.block);
      }
      groupParts.push({ group, part, count });
      more.content.appendChild(part.root);
    }
    root.appendChild(more.root);
  }

  function reportView() {
    onViewChange?.({ more: moreOpen, groups: schema.groups.map(g => g.id).filter(id => openGroups.has(id)) });
  }

  function refresh() {
    for (const entry of schema.entries) {
      const control = controls.get(entry.key);
      control.refreshChoices?.();
      control.block.hidden = !(entry.when === undefined || entry.when(record, currentContext) === true);
    }
    let total = 0;
    for (const { group, part, count } of groupParts) {
      const changed = schema.changedKeys(record, currentContext, group.id);
      total += changed.length;
      count.textContent = countText(changed);
      part.root.hidden = schema.group(group.id).every(entry => controls.get(entry.key).block.hidden);
    }
    if (moreCount !== null) moreCount.textContent = countText({ length: total });
    if (resetButton !== null) resetButton.hidden = total === 0;
  }

  refresh();

  return {
    root,
    essentials,
    getValue: () => structuredClone(record),
    /** Show another record (a restored session, a preset). */
    setValue(next) {
      record = schema.normalize(next, currentContext);
      for (const [key, control] of controls) control.set(record[key]);
      refresh();
    },
    /** The data changed (a dataset, a field's categories, the genes). */
    setContext(next) {
      currentContext = next;
      reconcileDependents(null);
      for (const [key, control] of controls) control.set(record[key]);
      refresh();
      return structuredClone(record);
    },
    getView: () => ({ more: moreOpen, groups: schema.groups.map(g => g.id).filter(id => openGroups.has(id)) }),
    setView(next) {
      moreOpen = next?.more === true;
      openGroups.clear();
      for (const id of next?.groups ?? []) openGroups.add(id);
      more?.setExpanded(moreOpen);
      for (const { group, part } of groupParts) part.setExpanded(openGroups.has(group.id));
    },
    /** Open the disclosures holding an option and focus it. */
    reveal(key) {
      const entry = schema.entry(key);
      if (entry.group !== 'essentials') {
        moreOpen = true;
        more?.setExpanded(true);
        openGroups.add(entry.group);
        groupParts.find(item => item.group.id === entry.group)?.part.setExpanded(true);
        reportView();
      }
      controls.get(key)?.focus?.();
    },
    setDisabled(disabled) {
      root.toggleAttribute('inert', disabled === true);
    },
    destroy() {
      abort.abort();
      for (const control of controls.values()) control.destroy?.();
      root.remove();
    },
  };
}

