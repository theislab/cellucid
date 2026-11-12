/**
 * @fileoverview State domains: the units the open dataset's state is kept,
 * compared, undone and saved in.
 *
 * Every piece of state a person can change belongs to exactly one domain. A
 * domain's owner provides `capture()` (its current value) and
 * `restore(value)` (put that value back). The history keeps a step's touched
 * domains before and after it; a session file holds every domain at the
 * steps it keeps; the state fingerprint is the digest of every domain.
 *
 * A domain value is plain data plus immutable typed arrays: fields, genes,
 * categories and views by name, cells by original position. A value is never
 * changed after capture: an owner whose arrays are edited in place copies
 * them into the value (`domains/README.md` in `app/state/`).
 *
 * @module app/actions/domains
 */

/**
 * Every domain, in the order a full restore applies them (each after what it
 * depends on): `[id, name, description]`. The name is what a person reads
 * where a step or a comparison lists the parts it changed.
 *
 * `cells` comes first: reading other cells makes the dataset's state again
 * (every other value names cells by original position, so it applies to
 * whatever cells are open), and a restore that reads them captures every
 * domain again before comparing the next (`REREADING_DOMAINS`).
 */
export const DOMAINS = Object.freeze([
  ['cells', 'Open cells', 'Which cells are open (every cell, or a subsample) and how many of them genes are read for.'],
  ['mapping', 'Data mapping', 'Which stored arrays are plotted and read (the data mapping).'],
  ['expression', 'Expression values', 'The values the genes are shown and analyzed in: normalized to 10,000 counts per cell, log1p, or as stored.'],
  ['field-overlays', 'Fields and labels', 'Field and category renames, deleted fields, user-defined fields with their values.'],
  ['gene-sets', 'Gene sets', 'Gene sets pushed by a notebook or made in the app.'],
  ['views', 'Views', 'Kept views, their layout, the focused view, camera lock, the representation each view shows.'],
  ['active-field', 'Active field', 'What each view is colored by (a field or a gene).'],
  ['filters', 'Filters', 'Category visibility, continuous ranges, outlier and missing-value filters, per view.'],
  ['colors', 'Colors', 'Category colors, color maps, color ranges, log scale, zero gray, per view.'],
  ['visibility', 'Hidden cells', 'Cells hidden one by one (the cell visibility mask), per view.'],
  ['highlights', 'Highlights', 'Highlight pages and their groups of cells.'],
  ['camera', 'Camera', 'The camera of each view and the navigation mode.'],
  ['camera-path', 'Camera path', 'Camera path keyframes and their playback settings.'],
  ['settings', 'Settings', 'Render, navigation and overlay settings (every stable control of the sidebar).'],
  ['analysis', 'Analysis', 'The analyses of the panel and of each window: their settings and results.'],
  ['layout', 'Layout', 'Docked and floating panels, analysis windows\' places and sizes, open sections, sidebar, theme.'],
]);

export const DOMAIN_IDS = Object.freeze(DOMAINS.map(([id]) => id));

/**
 * The domains whose value is one entry per view (`{views: [live, kept 1, …]}`,
 * `app/state/domains/view-list.js`): what a kept view carries of its own.
 */
export const PER_VIEW_DOMAINS = Object.freeze(['active-field', 'filters', 'colors', 'visibility', 'camera']);

/**
 * The domains whose restore reads the dataset again (`cells`): every other
 * domain's value may come out of it changed (cells not open are left out of
 * a value), so a restore captures every domain again after one.
 */
export const REREADING_DOMAINS = Object.freeze(['cells']);

/**
 * Domains whose value follows another's: an owner re-derives it when the
 * other changes, with no action of its own (the analyses' page selections
 * follow the highlight pages: a page removed leaves every selection, a page
 * made joins a selection that held every page; `comparison-module.js`
 * `onPagesChanged`). The history captures a derived domain with the domain
 * it follows, after an action and after a restore, so the change is part of
 * the step that caused it and never one made outside the history.
 * `derived → [the domains it follows]`.
 */
export const DERIVED_DOMAINS = Object.freeze({ analysis: Object.freeze(['highlights']) });

/** `ids` with every domain that follows one of them (`DERIVED_DOMAINS`), in domain order. */
export function withDerivedDomains(ids) {
  const out = new Set(ids);
  for (const [derived, follows] of Object.entries(DERIVED_DOMAINS)) if (follows.some(id => out.has(id))) out.add(derived);
  return DOMAIN_IDS.filter(id => out.has(id));
}

const NAMES = new Map(DOMAINS.map(([id, name]) => [id, name]));
const DESCRIPTIONS = new Map(DOMAINS.map(([id, , description]) => [id, description]));

/** What a domain is called where a person reads it ("Open cells", "Filters"). */
export function domainName(id) {
  const name = NAMES.get(id);
  if (name === undefined) throw new RangeError(`There is no state domain "${id}"`);
  return name;
}

/** What a domain holds, in one sentence. */
export function domainDescription(id) {
  const description = DESCRIPTIONS.get(id);
  if (description === undefined) throw new RangeError(`There is no state domain "${id}"`);
  return description;
}

/**
 * The registry the page fills at startup: one owner per domain.
 *
 * An owner whose values carry generated parts (ids from a counter that is
 * never lowered, creation times) gives `canonical(value)`: the value with
 * those renamed in order and dropped, so the same steps applied again
 * compare equal. Verify and a delete's "did this input change" compare
 * canonical forms (`history.js`); a restore always puts the value itself back.
 *
 * An owner whose domain means one value when a saved state does not hold it
 * (a file written before the domain, or by hand) gives `absent()`: that
 * value. A saved state restored onto the open dataset puts it back with the
 * rest (`history.js` `readSaved`), so one file restores one state whatever
 * was shown before (the Expression values: as stored, plan §3). Without
 * `absent`, a saved state that does not hold the domain keeps its value
 * shown.
 *
 * An owner whose value is held per view (`{views: [...]}`, one entry per
 * view by position) gives `readPart(value, views)`: the part a step that
 * acted in one view read, `views` being the `views` value it ran with (its
 * `focus`). A step whose input differs only outside that part (another view
 * kept, another view's filters) is not stale (`provenance.js`, F156).
 * @returns {{
 *   provide: (id: string, owner: {capture: Function, restore: Function, describe?: Function, canonical?: Function, absent?: Function, readPart?: Function}) => () => void,
 *   owner: (id: string) => {capture: Function, restore: Function, describe?: Function, canonical?: Function, absent?: Function, readPart?: Function},
 *   missing: () => string[],
 * }}
 */
export function createDomainRegistry() {
  const owners = new Map();
  return Object.freeze({
    provide(id, owner) {
      if (!DOMAIN_IDS.includes(id)) throw new RangeError(`There is no state domain "${id}"`);
      if (owners.has(id)) throw new Error(`State domain "${id}" already has an owner`);
      if (owner === null || typeof owner !== 'object' || typeof owner.capture !== 'function'
        || typeof owner.restore !== 'function') {
        throw new TypeError(`State domain "${id}" owner needs capture() and restore(value)`);
      }
      if (owner.canonical !== undefined && typeof owner.canonical !== 'function') {
        throw new TypeError(`State domain "${id}" owner's canonical must be a function of a value`);
      }
      if (owner.absent !== undefined && typeof owner.absent !== 'function') {
        throw new TypeError(`State domain "${id}" owner's absent must be a function giving the value a saved state without the domain means`);
      }
      if (owner.readPart !== undefined && typeof owner.readPart !== 'function') {
        throw new TypeError(`State domain "${id}" owner's readPart must be a function of a value and the views value, giving the part one view reads`);
      }
      owners.set(id, owner);
      return () => { if (owners.get(id) === owner) owners.delete(id); };
    },
    owner(id) {
      const owner = owners.get(id);
      if (owner === undefined) throw new Error(`State domain "${id}" has no owner yet`);
      return owner;
    },
    has: id => owners.has(id),
    missing: () => DOMAIN_IDS.filter(id => !owners.has(id)),
  });
}
