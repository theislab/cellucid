/**
 * The group picker keeps "every group" as an intent of its own: groups that
 * arrive after the picker is drawn (a field read asynchronously) are all
 * chosen, and an empty list while loading never becomes "no group chosen"
 * (`analysis/ui/components/group-picker.js`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = { setProperty() {} };
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = '';
    this.value = '';
    this.scrollTop = 0;
    this.clientHeight = 280;
  }
  appendChild(child) { this.children.push(child); return child; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  matches() { return false; }
  remove() {}
  focus() {}
}

globalThis.document ??= {
  createElement: tag => new FakeNode(tag),
  createDocumentFragment: () => new FakeNode('fragment'),
};
globalThis.window ??= { addEventListener() {}, innerWidth: 1024, innerHeight: 768 };

class HTMLInputElementStub {}
globalThis.HTMLInputElement ??= HTMLInputElementStub;

const { createGroupPicker } = await import('../assets/js/app/analysis/ui/components/group-picker.js');

const GROUPS = [
  { id: 'a', name: 'A', count: 30 },
  { id: 'b', name: 'B', count: 20 },
  { id: 'c', name: 'C', count: 4 },
];

test('"all groups" holds while the groups load, and covers the groups that arrive', () => {
  const changes = [];
  const picker = createGroupPicker({ label: 'Groups', groups: [], value: { mode: 'all' }, onChange: v => changes.push(v) });
  assert.deepEqual(picker.getValue(), { mode: 'all' }, 'an empty list while loading is not "none chosen"');
  picker.setGroups(GROUPS);
  assert.deepEqual(picker.getValue(), { mode: 'all' });
  picker.setGroups([...GROUPS, { id: 'd', name: 'D', count: 9 }]);
  assert.deepEqual(picker.getValue(), { mode: 'all' }, 'a group added later is chosen too');
  assert.deepEqual(changes, [], 'loading groups changes nothing the user chose');
});

test('a chosen subset survives the groups loading late, and drops only groups that do not exist', () => {
  const picker = createGroupPicker({ label: 'Groups', groups: [], value: { mode: 'subset', ids: ['a', 'zz'] } });
  assert.deepEqual(picker.getValue(), { mode: 'subset', ids: ['a', 'zz'] });
  picker.setGroups(GROUPS);
  assert.deepEqual(picker.getValue(), { mode: 'subset', ids: ['a'] });
});

test('unchecking one group leaves "all"; checking every group returns to it', () => {
  const changes = [];
  const picker = createGroupPicker({ label: 'Groups', groups: GROUPS, value: { mode: 'all' }, onChange: v => changes.push(v) });
  const find = node => (node.listeners.has('change') ? node : node.children.map(find).find(Boolean) ?? null);
  const list = find(picker.root);
  const toggleBox = (id, checked) => list.listeners.get('change')({ target: Object.assign(Object.create(HTMLInputElementStub.prototype), { checked, dataset: { groupId: id } }) });
  toggleBox('c', false);
  assert.deepEqual(changes.at(-1), { mode: 'subset', ids: ['a', 'b'] });
  toggleBox('c', true);
  assert.deepEqual(changes.at(-1), { mode: 'all' });
});

