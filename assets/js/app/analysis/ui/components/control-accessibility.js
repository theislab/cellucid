/**
 * Control Accessibility
 *
 * Every analysis control is built by the shared control kit
 * (`ui/components/controls.js`), which emits a `<label for>` bound to its
 * control. What is left for this module is the one thing no builder can do on
 * its own: scoping ids to the UI instance. Ids that arrive from a builder
 * given a fixed prefix — the variable, gene and plot-type selectors — repeat
 * when an analysis mode is copied into a floating window. `label[for]`
 * resolves to the first match in the document, so the copy's label operated
 * the sidebar's control and left its own untouched.
 *
 * @module analysis/ui/components/control-accessibility
 */

/** Selector for elements that can be the target of a `<label for>`. */
const LABELLABLE = 'input, select, textarea, meter, output, progress';

let controlScopeCounter = 0;

/**
 * Create an id scope that is unique for the lifetime of the document.
 *
 * Every analysis UI instance owns one scope, so the sidebar copy and each
 * floating copy of the same analysis mode generate distinct element ids.
 *
 * @param {string} name - Human-meaningful prefix, e.g. an analysis mode id.
 * @returns {string} A unique id prefix.
 */
export function createControlScope(name) {
  if (typeof name !== 'string' || name.length === 0 || name.trim() !== name) {
    throw new TypeError('Control scope name must be exact non-empty text');
  }
  controlScopeCounter += 1;
  return `${name}-${controlScopeCounter}`;
}

/**
 * Give `element` an id that is unique to `scope`, keeping any existing id as
 * the readable suffix so the generated ids stay debuggable.
 *
 * @param {Element} element
 * @param {string} scope
 * @param {string} fallbackKey - Used when the element has no id yet.
 * @returns {string} The element's id after scoping.
 */
function scopeElementId(element, scope, fallbackKey) {
  const suffix = element.id.length > 0 ? element.id : fallbackKey;
  const scoped = `${scope}-${suffix}`;
  if (element.id !== scoped) element.id = scoped;
  return scoped;
}

/**
 * Make every id inside `root` unique to this UI instance and repoint the
 * intra-root references that used them.
 *
 * @param {Element} root - Subtree owned by one analysis UI instance.
 * @param {string} scope - Scope from {@link createControlScope}.
 */
function scopeControlIds(root, scope) {
  if (root === null || typeof root?.querySelectorAll !== 'function') {
    throw new TypeError('Control id scoping requires an element root');
  }
  if (typeof scope !== 'string' || scope.length === 0) {
    throw new TypeError('Control id scoping requires a non-empty scope');
  }

  const renamed = new Map();
  let generated = 0;
  for (const control of root.querySelectorAll(LABELLABLE)) {
    const previous = control.id;
    generated += 1;
    const next = scopeElementId(
      control,
      scope,
      `control-${generated}`
    );
    if (previous.length > 0 && previous !== next) {
      renamed.set(previous, next);
    }
  }

  if (renamed.size === 0) return;
  for (const label of root.querySelectorAll('label[for]')) {
    const target = renamed.get(label.htmlFor);
    if (target !== undefined) label.htmlFor = target;
  }
  for (const attribute of ['aria-controls', 'aria-labelledby', 'aria-describedby']) {
    for (const element of root.querySelectorAll(`[${attribute}]`)) {
      const tokens = element.getAttribute(attribute).split(/\s+/);
      const next = tokens.map(token => renamed.get(token) ?? token);
      if (next.some((token, index) => token !== tokens[index])) {
        element.setAttribute(attribute, next.join(' '));
      }
    }
  }
}

/**
 * Apply the full form-control accessibility pass to one analysis UI's form.
 *
 * @param {Element} root - The analysis form subtree.
 * @param {string} scope - Scope from {@link createControlScope}.
 */
export function applyFormControlAccessibility(root, scope) {
  scopeControlIds(root, scope);
}
