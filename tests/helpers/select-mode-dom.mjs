/**
 * Minimal stand-ins for the Select mode controls, shaped like the markup in
 * `index.html`: the switch and the three combine buttons of the Highlighting
 * panel and of the selection bar over the plot, and the bar's step row and
 * step buttons.
 */

function createControl(attributes, dataset = {}) {
  const values = new Map(Object.entries(attributes));
  const listeners = new Map();
  return {
    dataset,
    hidden: false,
    getAttribute(name) {
      return values.has(name) ? values.get(name) : null;
    },
    setAttribute(name, value) {
      values.set(name, String(value));
    },
    addEventListener(type, listener, options = {}) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      options.signal?.addEventListener('abort', () => {
        listeners.get(type).delete(listener);
      });
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    click() {
      for (const listener of [...(listeners.get('click') ?? [])]) {
        listener({ type: 'click' });
      }
    }
  };
}

/**
 * @param {{enabled?: boolean, combine?: 'intersect'|'union'|'subtract'}} [initial]
 */
export function createSelectModeDom(initial = {}) {
  const enabled = initial.enabled === true;
  const combine = initial.combine ?? 'intersect';
  const flag = value => (value ? 'true' : 'false');
  // The panel's switch and combine group, then the selection bar's.
  const selectModeSwitches = [
    createControl({ role: 'switch', 'aria-checked': flag(enabled) }),
    createControl({ role: 'switch', 'aria-checked': flag(enabled) })
  ];
  const selectCombineButtons = [0, 1].flatMap(() =>
    ['intersect', 'union', 'subtract'].map(name =>
      createControl({ 'aria-pressed': flag(name === combine) }, { combine: name })
    )
  );
  const selectCombineGroups = [createControl({}), createControl({})];
  for (const group of selectCombineGroups) group.hidden = !enabled;
  const selectBarSteps = createControl({}, { tool: '' });
  selectBarSteps.hidden = true;
  const selectBarStepButtons = ['undo', 'cancel', 'confirm'].map(action =>
    createControl({}, { stepAction: action })
  );
  return {
    selectModeSwitches,
    selectCombineGroups,
    selectCombineButtons,
    selectBarSteps,
    selectBarStepButtons
  };
}
