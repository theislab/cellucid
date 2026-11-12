/**
 * @fileoverview Search and filter the history (History v2 §3.13): 🔍 in the
 * History header opens a box; its words match each step's label, notes,
 * parameters and bookmark (any case), and Filter narrows by who acted
 * (you, an agent, Python, R, a replay), the kind of change (the analysis,
 * views, layout), notes, bookmarks, stale or flagged steps, the part of the
 * state changed (Part changed…) and the day (Day…), each listing what the
 * steps hold. Matching rows stay in the graph and the rest fold; the status
 * line reads "8 of 214 steps". `/` opens it from the graph, Escape closes it.
 * The rule is the history's own (`app/history/search.js` `stepMatches`), so
 * the box and an agent's `history.search` find the same steps.
 *
 * `stepMatcher`, `searchCriteria` and `filterChoices` are pure (Node).
 *
 * @module ui/modules/state/search
 */

import { openMenu } from '../../components/menu.js';
import { formatCountOf } from '../../../../utils/format-units.js';
import { searchWords, stepMatches } from '../../../history/search.js';
import { debounce } from '../../../../utils/debounce.js';

/** The Filter menu's choices: each a key of the query and its value. */
export const SEARCH_FILTERS = Object.freeze([
  { key: 'by', value: 'person', label: 'By you' },
  { key: 'by', value: 'agent', label: 'By an agent' },
  { key: 'by', value: 'python', label: 'From Python' },
  { key: 'by', value: 'r', label: 'From R' },
  { key: 'by', value: 'replay', label: 'Replayed' },
  { separator: true },
  { key: 'kind', value: 'state', label: 'Analysis changes' },
  { key: 'kind', value: 'view', label: 'Views and camera' },
  { key: 'kind', value: 'layout', label: 'Panels and layout' },
  { separator: true },
  { key: 'hasNote', value: true, label: 'With a note' },
  { key: 'bookmarked', value: true, label: 'Bookmarked' },
  { key: 'flagged', value: true, label: 'Stale or flagged' },
]);

/** A query that asks for nothing. */
const EMPTY_QUERY = Object.freeze({ text: '', by: null, kind: null, domain: null, day: null, hasNote: false, bookmarked: false, flagged: false });

/**
 * Whether a query asks for anything.
 * @param {{text?: string, by?: string|null, kind?: string|null, domain?: string|null, day?: number|null,
 *   hasNote?: boolean, bookmarked?: boolean, flagged?: boolean}} query
 */
export function isSearching(query) {
  return (query.text ?? '').trim() !== '' || Boolean(query.by) || Boolean(query.kind) || Boolean(query.domain)
    || Number.isFinite(query.day) || query.hasNote === true || query.bookmarked === true || query.flagged === true;
}

/** The local midnight a time falls on (a day of the Day filter). */
export function dayOf(at) {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The midnight after `day` (a day is not always 24 hours long). */
function nextDay(day) {
  const date = new Date(day);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

/**
 * The panel's query as `history.search` criteria (`app/history/search.js`):
 * a day is the time range from its midnight to the next one's.
 * @param {object} query
 */
export function searchCriteria(query) {
  const criteria = {};
  if ((query.text ?? '').trim() !== '') criteria.text = query.text;
  if (query.by) criteria.by = query.by;
  if (query.kind) criteria.kind = query.kind;
  if (query.domain) criteria.domain = query.domain;
  if (Number.isFinite(query.day)) {
    criteria.from = query.day;
    criteria.to = nextDay(query.day) - 1;
  }
  if (query.hasNote === true) criteria.has_note = true;
  if (query.bookmarked === true) criteria.bookmarked = true;
  if (query.flagged === true) criteria.flagged = true;
  return criteria;
}

/**
 * A step predicate for a query (null when it asks for nothing): the
 * history's own search rule (`stepMatches`), the opening never matching.
 *
 * @param {object} query
 * @param {{effectOf: (type: string) => (string|null), stale: Map<string, object>}} context
 * @returns {((step: object) => boolean)|null}
 */
export function stepMatcher(query, { effectOf, stale }) {
  if (!isSearching(query)) return null;
  const criteria = searchCriteria(query);
  const words = searchWords(criteria.text);
  const isStale = id => stale.has(id);
  return step => step.parent !== null && stepMatches(step, criteria, { effectOf, isStale, words });
}

/**
 * What the Part changed and Day filters offer: each part of the state some
 * step changed, and each day some step was taken, with its steps (the
 * opening not counted), most recent day first.
 *
 * @param {object[]} steps
 * @param {(domain: string) => string} domainName
 * @param {number} now
 * @returns {{domains: Array<{id: string, label: string, count: number}>, days: Array<{day: number, label: string, count: number}>}}
 */
export function filterChoices(steps, domainName, now) {
  const domains = new Map();
  const days = new Map();
  for (const step of steps) {
    if (step.parent === null) continue;
    for (const id of step.touches ?? []) domains.set(id, (domains.get(id) ?? 0) + 1);
    if (Number.isFinite(step.at)) {
      const day = dayOf(step.at);
      days.set(day, (days.get(day) ?? 0) + 1);
    }
  }
  const thisYear = new Date(now).getFullYear();
  const dayLabel = day => {
    const date = new Date(day);
    if (day === dayOf(now)) return 'Today';
    if (nextDay(day) === dayOf(now)) return 'Yesterday';
    return date.toLocaleDateString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', ...(date.getFullYear() === thisYear ? {} : { year: 'numeric' }),
    });
  };
  return {
    domains: [...domains].map(([id, count]) => ({ id, label: domainName(id), count }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    days: [...days].sort((a, b) => b[0] - a[0]).map(([day, count]) => ({ day, label: dayLabel(day), count })),
  };
}

/**
 * @param {object} options
 * @param {HTMLElement} options.box - `#history-search`
 * @param {HTMLButtonElement} options.toggle - 🔍
 * @param {HTMLInputElement} options.input
 * @param {HTMLButtonElement} options.filterButton
 * @param {(query: object) => void} options.onChange
 * @param {() => void} options.onClose - focus returns to the graph
 * @param {() => ReturnType<typeof filterChoices>} options.choices - what Part changed and Day offer now
 */
export function createSearch({ box, toggle, input, filterButton, onChange, onClose, choices }) {
  const controller = new AbortController();
  const { signal } = controller;
  const query = { ...EMPTY_QUERY };
  /** The labels of the part and the day chosen, as the menu named them. */
  const named = { domain: null, day: null };
  // The text filters once typing pauses.
  const filterByText = debounce(() => {
    query.text = input.value;
    onChange({ ...query });
  }, 120);

  function filtersOn() {
    const on = SEARCH_FILTERS.filter(choice => !('separator' in choice) && query[choice.key] === choice.value).map(choice => choice.label);
    if (query.domain) on.push(`changed ${named.domain}`);
    if (Number.isFinite(query.day)) on.push(`on ${named.day}`);
    return on;
  }

  function writeFilterButton() {
    const on = filtersOn();
    filterButton.textContent = on.length === 0 ? 'Filter' : `Filter · ${on.length}`;
    filterButton.setAttribute('aria-label', on.length === 0 ? 'Filter the steps' : `Filter the steps: ${on.join(', ')}`);
  }

  /** Choose (or, chosen again, clear) the part or the day. */
  function choose(key, value, label) {
    const same = query[key] === value;
    query[key] = same ? null : value;
    named[key] = same ? null : label;
    writeFilterButton();
    onChange({ ...query });
  }

  /** The second menu of Part changed or Day, from the steps there are now. */
  function openChoices(key) {
    const now = choices();
    const list = key === 'domain' ? now.domains.map(each => ({ value: each.id, label: each.label, count: each.count }))
      : now.days.map(each => ({ value: each.day, label: each.label, count: each.count }));
    openMenu({
      anchor: filterButton,
      label: key === 'domain' ? 'Steps that changed' : 'Steps taken on',
      items: list.length === 0
        ? [{ label: key === 'domain' ? 'No step changed anything yet' : 'No step has a time', disabled: true }]
        : list.map(each => ({
          label: each.label,
          hint: formatCountOf(each.count, 'step'),
          checked: query[key] === each.value,
          run: () => choose(key, each.value, each.label),
        })),
    });
  }

  function setOpen(open) {
    box.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      input.focus();
      input.select();
    } else {
      const was = isSearching(query);
      Object.assign(query, EMPTY_QUERY);
      Object.assign(named, { domain: null, day: null });
      input.value = '';
      writeFilterButton();
      if (was) onChange({ ...query });
    }
  }

  toggle.addEventListener('click', () => {
    setOpen(box.hidden);
    if (box.hidden) onClose();
  }, { signal });
  input.addEventListener('input', () => filterByText(), { signal });
  box.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      onClose();
    } else if (event.key === 'ArrowDown' && event.target === input) {
      event.preventDefault();
      onClose();
    }
  }, { signal });
  filterButton.addEventListener('click', () => {
    openMenu({
      anchor: filterButton,
      label: 'Filter the steps',
      items: [
        ...SEARCH_FILTERS.map(choice => ('separator' in choice ? choice : {
          label: choice.label,
          checked: query[choice.key] === choice.value,
          run: () => {
            query[choice.key] = query[choice.key] === choice.value ? (typeof choice.value === 'boolean' ? false : null) : choice.value;
            writeFilterButton();
            onChange({ ...query });
          },
        })),
        { separator: true },
        // Each opens the steps' own list: the parts some step changed, the days some step was taken.
        { label: 'Part changed…', hint: named.domain ?? '', run: () => openChoices('domain') },
        { label: 'Day…', hint: named.day ?? '', run: () => openChoices('day') },
      ],
    });
  }, { signal });

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    /** Show only the stale and flagged steps (the status line's "⚠ 2 stale"). */
    showFlagged() {
      setOpen(true);
      query.flagged = true;
      writeFilterButton();
      onChange({ ...query });
    },
    get query() { return { ...query }; },
    destroy() {
      filterByText.cancel();
      controller.abort();
    },
  };
}
