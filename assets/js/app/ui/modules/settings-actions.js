/**
 * @fileoverview Settings as actions: every stable control of the sidebar but
 * the layout's is a setting (`state-serializer/ui-controls.js`,
 * `SETTING_CONTROL_DOMAINS`), set by `setting.set` and listed by
 * `settings.list` (`app/actions/definitions/settings.js`). Its value is the
 * `settings` domain's, or for the centroid toggles the `views` domain's
 * (`controlDomainOf`); `setting.set` touches both.
 *
 * A person's change is recorded by observation: the control's own owner
 * applies it as it always did, and an `input` or `change` on a settings
 * control records one `setting.set` step with the value it
 * ends at (a drag coalesces into one step). The events a restore or
 * `setting.set` itself dispatch (`isApplyingControls`) are never steps, and
 * the history records nothing it put back itself. `setting.set` sets the control and dispatches its
 * event, the path a session restore takes, so the owner applies an agent's
 * or a replay's value exactly as a person's. A control added to the markup is
 * a setting here with no code.
 *
 * @module ui/modules/settings-actions
 */

import { ActionRefused } from '../../actions/dispatcher.js';
import { SETTING_CONTROL_DOMAINS, createUiControlSerializer, isApplyingControls } from '../../state-serializer/ui-controls.js';
import { quoteName } from '../../actions/targets/names.js';

/** The events a person changes a setting with. */
const OBSERVED_EVENTS = Object.freeze(['input', 'change']);

/**
 * @param {{
 *   sidebar: HTMLElement,
 *   actions: ReturnType<typeof import('../../actions/dispatcher.js').createActionDispatcher>,
 * }} options
 * @returns {() => void} Removes the handlers and the observation.
 */
export function installSettingsActions({ sidebar, actions }) {
  if (!(sidebar instanceof HTMLElement)) throw new TypeError('Settings actions need the sidebar.');
  for (const method of ['provide', 'recordObserved']) {
    if (typeof actions?.[method] !== 'function') throw new TypeError(`Settings actions need the action dispatcher (${method}).`);
  }
  const controls = createUiControlSerializer({ sidebar, domains: [...SETTING_CONTROL_DOMAINS] });
  const ownerDocument = sidebar.ownerDocument;

  /** A setting's id the person may have meant, for a refusal. */
  function nearestIds(id) {
    const wanted = id.toLowerCase();
    const words = wanted.split(/[^a-z0-9]+/).filter(Boolean);
    return controls.listSettings()
      .filter(setting => words.some(word => setting.id.includes(word) || setting.label.toLowerCase().includes(word)))
      .slice(0, 5)
      .map(setting => `${setting.id} (${setting.label})`);
  }

  const removers = [
    actions.provide('setting.set', ({ setting, value }) => {
      const before = controls.readSetting(setting);
      if (before === null) {
        const near = nearestIds(setting);
        throw new ActionRefused(
          `There is no setting ${quoteName(setting)}${near.length > 0 ? `; did you mean ${near.join(', ')}?` : ''} settings.list names every setting.`,
          { code: 'no-target', type: 'setting.set' },
        );
      }
      let after;
      try {
        after = controls.setSetting(setting, value);
      } catch (error) {
        // The value is wrong for this control: say so in its words.
        if (error instanceof TypeError || error instanceof RangeError) {
          throw new ActionRefused(error.marked ?? error.message, { code: 'bad-value', type: 'setting.set' });
        }
        throw error;
      }
      if (after.value === before.value) return null;
      return { label: after.label, shown: after.shown ?? null, value: after.value };
    }),
    actions.provide('settings.list', ({ section }) => {
      const settings = controls.listSettings();
      if (section === undefined) return { settings };
      const wanted = section.trim().toLowerCase();
      const chosen = settings.filter(setting => setting.section?.toLowerCase() === wanted);
      if (chosen.length === 0) {
        const sections = [...new Set(settings.map(setting => setting.section).filter(Boolean))];
        throw new ActionRefused(`No settings are in a section ${quoteName(section)}; the sections with settings are ${sections.join(', ')}.`, {
          code: 'no-target', type: 'settings.list',
        });
      }
      return { settings: chosen };
    }),
  ];

  /**
   * A person changed a control (by hand, or through a control of the app
   * that sets it, a Reset): if it is a setting, record the value it is at
   * now. Read in the event, after the control's own listeners ran (this
   * listens on the document, in the bubbling phase). A value a restore or
   * `setting.set` puts back is not a person's change.
   */
  function observe(event) {
    if (isApplyingControls()) return;
    const target = event.target;
    const key = controls.settingKeyOf(target);
    if (key === null) return;
    const setting = controls.readSetting(key);
    if (setting === null || (typeof setting.value === 'number' && !Number.isFinite(setting.value))) return;
    actions.recordObserved(
      'setting.set',
      { setting: key, value: setting.value },
      {},
      { label: setting.label, shown: setting.shown ?? null, value: setting.value },
    ).catch(error => console.error(`[Settings] The change of "${key}" could not be recorded:`, error));
  }
  for (const type of OBSERVED_EVENTS) ownerDocument.addEventListener(type, observe);

  return () => {
    for (const type of OBSERVED_EVENTS) ownerDocument.removeEventListener(type, observe);
    for (const remove of removers) remove();
  };
}
