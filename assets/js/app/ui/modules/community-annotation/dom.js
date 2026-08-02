/**
 * @fileoverview Element construction and file-download helpers for the
 * community annotation UI.
 *
 * `el()` is deliberately attribute-based (rather than the property-based
 * `createElement()` in `utils/dom-utils.js`): community annotation markup
 * relies on attribute presence semantics for `disabled`/`checked`/`readonly`
 * and on omitting attributes whose value is nullish or `false`.
 *
 * @module ui/modules/community-annotation/dom
 */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'className') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'disabled' || k === 'checked' || k === 'readonly') {
      // Boolean HTML attributes: presence = true, absence = false
      if (v) node.setAttribute(k, '');
      // Don't set attribute if false (absence means not disabled/checked/readonly)
    } else if (v != null && v !== false) node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function toCleanString(value) {
  return String(value ?? '').trim();
}

export function hasAtLeastUnicodeCodePoints(value, minimum) {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count >= minimum) return true;
  }
  return false;
}

export function downloadJsonAsFile(filename, json) {
  if (
    typeof filename !== 'string' ||
    !filename ||
    /^\s|\s$/.test(filename) ||
    /[\\/:*?"<>|]/.test(filename)
  ) {
    throw new Error('Download filename must be an exact portable filename');
  }
  const payload = JSON.stringify(json, null, 2) + '\n';
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1500);
}
