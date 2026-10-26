/**
 * @fileoverview Named gene sets, edited as chips: type a gene (the dataset's
 * genes are suggested as you type), paste a list (commas, semicolons,
 * spaces, tabs or new lines), import a file (`.txt`, `.csv`, `.tsv`,
 * `.gmt`), or take the markers of a marker genes result.
 *
 * Each set is a collapsible row: its name, its gene count, and an amber
 * "2 not found" chip naming the genes the dataset does not have. Those are
 * kept in the set (a session restores them as typed) and left out of the
 * analysis, which lists them in its result.
 *
 * Value: `[{ name, genes }]` (the `gene-sets` option kind of
 * `options/option-schema.js`); genes are kept as typed, matched to the
 * dataset by `shared/gene-sets.js` `resolveGenes`.
 *
 * @module analysis/ui/components/gene-set-editor
 */

import {
  ICONS,
  createDisclosure,
  createIconButton
} from '../../../ui/components/controls.js';
import { createDomId } from '../../../ui/components/dom-id.js';
import { rankedMatchIndices } from '../../../utils/text-match.js';
import { formatCount, formatCountOf } from '../../../../utils/format-units.js';
import { createWindowedListbox } from '../../../ui/components/windowed-listbox.js';
import {
  createGeneIndex,
  parseGeneFile,
  parseGeneText,
  resolveGenes
} from '../../shared/gene-sets.js';

/**
 * @param {object} options
 * @param {Array<{name: string, genes: string[]}>} [options.value]
 * @param {() => string[]} options.getGenes - The dataset's gene names
 * @param {(() => Array<{name: string, genes: string[]}>|null)|null} [options.getMarkerSets] -
 *   The sets "From markers" adds (one per group of the last marker result),
 *   or null while there is none; without it the action is not offered
 * @param {(value: Array<{name: string, genes: string[]}>) => void} [options.onChange]
 * @returns {{ root: HTMLDivElement, getValue: () => object[], setValue: (value: object[]) => void,
 *   refresh: () => void, destroy: () => void }}
 */
export function createGeneSetEditor({
  value: initialValue = [],
  getGenes,
  getMarkerSets = null,
  onChange = null,
}) {
  if (typeof getGenes !== 'function') throw new TypeError('A gene set editor needs getGenes()');
  if (getMarkerSets !== null && typeof getMarkerSets !== 'function') {
    throw new TypeError('Gene set editor getMarkerSets must be a function or null');
  }
  const abort = new AbortController();
  const { signal } = abort;

  /** @type {Array<{name: string, genes: string[]}>} */
  let sets = [];
  /** Sets whose rows are open, by position. */
  let openRows = new Set([0]);
  let index = null;
  let geneNames = [];

  const root = document.createElement('div');
  root.className = 'gene-set-editor';
  const rowsEl = document.createElement('div');
  rowsEl.className = 'gene-set-rows';
  const footer = document.createElement('div');
  footer.className = 'gene-set-actions';
  root.append(rowsEl, footer);

  /** Whether `names` lists the same genes as the index was built from. */
  const sameNames = names => names === geneNames
    || (Array.isArray(names) && names.length === geneNames.length && names.every((name, i) => name === geneNames[i]));

  const geneIndex = () => {
    const names = getGenes();
    if (index === null || !sameNames(names)) {
      geneNames = names;
      index = createGeneIndex(names);
    }
    return index;
  };

  const emit = () => {
    onChange?.(structuredClone(sets));
  };

  const uniqueSetName = base => {
    const names = new Set(sets.map(set => set.name));
    let name = base;
    for (let n = 2; names.has(name); n++) name = `${base} ${n}`;
    return name;
  };

  const addGenes = (setIndex, genes) => {
    const set = sets[setIndex];
    const present = new Set(set.genes);
    let added = 0;
    for (const gene of genes) {
      if (present.has(gene)) continue;
      present.add(gene);
      set.genes.push(gene);
      added++;
    }
    if (added > 0) {
      render();
      emit();
    }
  };

  const linkButton = (text, onClick, title) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'analysis-link-btn';
    button.textContent = text;
    if (title) button.title = title;
    button.addEventListener('click', onClick, { signal });
    return button;
  };

  const buildGeneInput = (setIndex) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'searchable-dropdown gene-set-input';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'obs-select';
    input.placeholder = 'Add or paste genes';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', `Add genes to ${sets[setIndex].name}`);
    const listbox = document.createElement('div');
    listbox.className = 'dropdown-list';
    listbox.id = createDomId('gene-set-suggestions');
    listbox.hidden = true;
    input.setAttribute('aria-controls', listbox.id);
    input.setAttribute('aria-expanded', 'false');
    wrapper.append(input, listbox);

    let matches = [];
    const list = createWindowedListbox({
      input,
      listbox,
      idPrefix: `${listbox.id}-option`,
      buildOption: i => {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.dataset.optionKey = matches[i];
        item.textContent = matches[i];
        return item;
      },
      signal,
    });
    const isOpen = () => !listbox.hidden;
    const closeList = () => {
      listbox.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      list.setActive(-1);
    };
    const openList = () => {
      const query = input.value.trim().toLowerCase();
      if (query.length === 0 || /[\s,;]/.test(input.value.trim())) {
        closeList();
        return;
      }
      const present = new Set(sets[setIndex].genes);
      const { names, lowered } = geneIndex();
      matches = rankedMatchIndices(lowered, query)
        .map(index => names[index])
        .filter(gene => !present.has(gene));
      if (matches.length === 0) {
        closeList();
        return;
      }
      listbox.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      list.reset(matches.length);
      list.setActive(0);
    };
    const commitText = text => {
      const genes = parseGeneText(text);
      input.value = '';
      closeList();
      if (genes.length > 0) addGenes(setIndex, genes);
    };
    input.addEventListener('input', openList, { signal });
    input.addEventListener('paste', event => {
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!/[\s,;]/.test(text.trim())) return;
      event.preventDefault();
      commitText(`${input.value} ${text}`);
    }, { signal });
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape' && isOpen()) {
        event.preventDefault();
        closeList();
        return;
      }
      if (event.key === 'Enter' || (event.key === ',' && input.value.trim().length > 0)) {
        event.preventDefault();
        const active = list.getActiveIndex();
        if (isOpen() && active >= 0 && !/[\s,;]/.test(input.value.trim())) commitText(matches[active]);
        else commitText(input.value);
        return;
      }
      if (event.key === 'Backspace' && input.value.length === 0 && sets[setIndex].genes.length > 0) {
        sets[setIndex].genes.pop();
        render();
        emit();
        rowsEl.querySelectorAll('.gene-set-input input')[setIndex]?.focus();
        return;
      }
      list.handleKeydown(event, { isOpen, open: openList });
    }, { signal });
    listbox.addEventListener('mousedown', event => {
      const item = event.target instanceof Element ? event.target.closest('.dropdown-item[data-option-key]') : null;
      if (item === null) return;
      event.preventDefault();
      commitText(item.dataset.optionKey);
      input.focus();
    }, { signal });
    input.addEventListener('blur', () => requestAnimationFrame(closeList), { signal });
    return wrapper;
  };

  const buildRow = (set, setIndex) => {
    const resolution = resolveGenes(set.genes, geneIndex());
    const missing = [...resolution.unmatched, ...resolution.ambiguous.map(entry => entry.requested)];
    const renamedBy = new Map(resolution.renamed.map(entry => [entry.requested, entry.gene]));
    const missingSet = new Set(missing);

    const disclosure = createDisclosure({
      title: set.name,
      description: missing.length > 0
        ? `${formatCountOf(set.genes.length, 'gene')} · ${formatCount(missing.length)} not found`
        : formatCountOf(set.genes.length, 'gene'),
      expanded: openRows.has(setIndex),
      className: 'disclosure-inline gene-set-row',
      onToggle: expanded => {
        if (expanded) openRows.add(setIndex);
        else openRows.delete(setIndex);
      },
    });
    if (missing.length > 0) {
      disclosure.header.querySelector('.disclosure-desc')?.classList.add('gene-set-missing');
      disclosure.header.title = `Not in this dataset: ${missing.join(', ')}`;
    }
    const content = disclosure.content;

    const nameRow = document.createElement('div');
    nameRow.className = 'gene-set-name-row';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'obs-select';
    nameInput.value = set.name;
    nameInput.setAttribute('aria-label', 'Set name');
    nameInput.addEventListener('change', () => {
      const name = nameInput.value.trim();
      if (name.length === 0 || sets.some((other, i) => i !== setIndex && other.name === name)) {
        nameInput.value = set.name;
        return;
      }
      set.name = name;
      render();
      emit();
    }, { signal });
    const remove = createIconButton({
      label: `Remove ${set.name}`,
      icon: ICONS.delete,
      tone: 'danger',
      onClick: () => {
        sets.splice(setIndex, 1);
        openRows = new Set([...openRows].filter(i => i !== setIndex).map(i => (i > setIndex ? i - 1 : i)));
        render();
        emit();
      },
    });
    nameRow.append(nameInput, remove);

    const chips = document.createElement('div');
    chips.className = 'gene-set-chips';
    chips.setAttribute('role', 'list');
    set.genes.forEach((gene, geneIndexInSet) => {
      const chip = document.createElement('span');
      chip.className = missingSet.has(gene) ? 'gene-chip gene-chip-missing' : 'gene-chip';
      chip.setAttribute('role', 'listitem');
      const text = document.createElement('span');
      text.textContent = gene;
      if (missingSet.has(gene)) chip.title = 'Not in this dataset; left out of the score';
      else if (renamedBy.has(gene)) chip.title = `Matched to ${renamedBy.get(gene)}`;
      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'gene-chip-remove';
      drop.setAttribute('aria-label', `Remove ${gene}`);
      drop.textContent = '×';
      drop.addEventListener('click', () => {
        set.genes.splice(geneIndexInSet, 1);
        render();
        emit();
      }, { signal });
      chip.append(text, drop);
      chips.appendChild(chip);
    });
    const tools = document.createElement('div');
    tools.className = 'gene-set-tools';
    if (set.genes.length > 0) {
      tools.appendChild(linkButton('Clear', () => {
        set.genes = [];
        render();
        emit();
      }));
    }
    if (missing.length > 0) {
      tools.appendChild(linkButton('Remove not found', () => {
        set.genes = set.genes.filter(gene => !missingSet.has(gene));
        render();
        emit();
      }, missing.join(', ')));
    }
    content.append(nameRow, chips, buildGeneInput(setIndex));
    if (tools.childElementCount > 0) content.appendChild(tools);
    return disclosure.root;
  };

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.txt,.csv,.tsv,.gmt,text/plain,text/csv,text/tab-separated-values';
  fileInput.hidden = true;
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    const imported = parseGeneFile(file.name, await file.text()).filter(set => set.genes.length > 0);
    if (imported.length === 0) return;
    const first = sets.length;
    // An empty first set is replaced rather than kept beside the import.
    const replaceEmpty = sets.length === 1 && sets[0].genes.length === 0;
    if (replaceEmpty) sets = [];
    for (const set of imported) sets.push({ name: uniqueSetName(set.name), genes: set.genes });
    openRows = new Set([replaceEmpty ? 0 : first]);
    render();
    emit();
  }, { signal });

  footer.append(
    linkButton('Add set', () => {
      sets.push({ name: uniqueSetName('Set'), genes: [] });
      openRows.add(sets.length - 1);
      render();
      emit();
      rowsEl.querySelectorAll('.gene-set-input input')[sets.length - 1]?.focus();
    }),
    linkButton('Import', () => fileInput.click(), 'A gene list (.txt), a table (.csv, .tsv) or a GMT file'),
    fileInput
  );
  let fromMarkers = null;
  if (getMarkerSets !== null) {
    fromMarkers = linkButton('From markers', () => {
      const markerSets = getMarkerSets();
      if (!Array.isArray(markerSets) || markerSets.length === 0) return;
      if (sets.length === 1 && sets[0].genes.length === 0) sets = [];
      for (const set of markerSets) sets.push({ name: uniqueSetName(set.name), genes: [...set.genes] });
      openRows = new Set();
      render();
      emit();
    }, 'One set per group of the last marker genes result');
    footer.appendChild(fromMarkers);
  }

  function render() {
    const focusedIndex = [...rowsEl.querySelectorAll('.gene-set-input input')].indexOf(document.activeElement);
    rowsEl.replaceChildren(...sets.map(buildRow));
    if (fromMarkers !== null) {
      const available = getMarkerSets();
      fromMarkers.hidden = !Array.isArray(available) || available.length === 0;
    }
    if (focusedIndex >= 0) rowsEl.querySelectorAll('.gene-set-input input')[focusedIndex]?.focus();
  }

  const sameSets = (a, b) => a.length === b.length && a.every((set, i) =>
    set.name === b[i].name && set.genes.length === b[i].genes.length && set.genes.every((gene, k) => gene === b[i].genes[k]));

  /** The sets as given; rows stay as they are (open, focused) when nothing changed. */
  const setValue = value => {
    if (!Array.isArray(value)) throw new TypeError('Gene sets must be an array');
    let next = value.map(set => ({ name: String(set.name), genes: [...set.genes] }));
    if (next.length === 0) next = [{ name: 'Set 1', genes: [] }];
    if (sets !== undefined && sameSets(next, sets)) return;
    sets = next;
    openRows = new Set([...(openRows ?? [])].filter(i => i < sets.length));
    if (openRows.size === 0) openRows.add(0);
    render();
  };

  setValue(initialValue);

  return {
    root,
    getValue: () => structuredClone(sets),
    setValue,
    /**
     * Re-match every set when the dataset's genes changed; show "From
     * markers" when a marker result exists. Nothing is rebuilt otherwise, so
     * a row being edited keeps its focus.
     */
    refresh() {
      if (fromMarkers !== null) {
        const available = getMarkerSets();
        fromMarkers.hidden = !Array.isArray(available) || available.length === 0;
      }
      if (index !== null && sameNames(getGenes())) return;
      index = null;
      render();
    },
    destroy() {
      abort.abort();
      root.remove();
    },
  };
}
