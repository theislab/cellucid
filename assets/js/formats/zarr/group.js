/**
 * The store contract's `Group` for one Zarr group: its children are known
 * once the store is open, so navigation never waits.
 *
 * @module formats/zarr/group
 */

import { compareNames, pathParts } from '../store.js';

/**
 * @param {{path: string, name: string, attrs: Readonly<Object>, children: Map<string, Object>, extra?: Object}} init
 *   `children` may be filled after creation (the tree is linked once every node exists).
 */
export function createGroupNode({ path, name, attrs, children, extra = {} }) {
  let sortedKeys = null;
  const node = {
    kind: 'group',
    path,
    name,
    attrs,
    attributeType: () => null,
    keys() {
      sortedKeys ??= Object.freeze([...children.keys()].sort(compareNames));
      return sortedKeys;
    },
    get(childPath) {
      let current = node;
      for (const part of pathParts(childPath)) {
        if (current.kind !== 'group') return null;
        current = current.children.get(part);
        if (current === undefined) return null;
      }
      return current;
    },
    has(childPath) {
      return node.get(childPath) !== null;
    },
    ...extra,
  };
  // Not enumerable: navigation goes through keys() and get().
  Object.defineProperty(node, 'children', { value: children, enumerable: false });
  return Object.freeze(node);
}
