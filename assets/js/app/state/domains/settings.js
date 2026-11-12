/**
 * @fileoverview The `settings` state domain: every stable control of the
 * sidebar and its floating panels (render, navigation, overlays, …), and
 * the Figure export panel's settings.
 *
 * Value:
 *
 *     {controls: {[id]: {type: 'checkbox', checked}
 *                     | {type: 'select'|'range'|'number'|'color'|'text', value}},
 *      figureExport: object|null}     // the panel's own record (`exportSessionSettings`)
 *
 * The controls are the part of the generic inventory of
 * `state-serializer/ui-controls.js` (every `input` and `select` with a
 * stable id outside a skipped subtree) whose
 * value this domain holds (`controlDomainOf`): a control added to the markup
 * is a setting here, saved and restored, with no code. Left out, because
 * another domain holds what they show: accordion sections and the theme
 * (`layout`), the focused view's centroid toggles (`views`), and the
 * controls the inventory leaves to their owners (field pickers, the outlier
 * slider, the navigation mode, the representation picker, the multiview
 * layout). The selection tool and Select mode are input modes, page chrome
 * like a held Alt key, and no setting (History v2 §3.3.8).
 *
 * Restore reads the saved record one setting at a time (`readSavedControls`,
 * `readSavedFigureExportSettings`): a value this version cannot use (a
 * control removed or changed since, a value of another version) keeps the
 * setting as shown and is said (`unread-settings.js`), and never fails the
 * others. Then it writes each control that differs and dispatches the event
 * its owner listens for (`restoreUIControls`). Smoke on a device that cannot
 * draw it is said, as a session says it, and Points is kept.
 *
 * @module app/state/domains/settings
 */

import { createUiControlSerializer } from '../../state-serializer/ui-controls.js';
import { reportSmokeUnavailable } from '../../ui/modules/smoke-availability.js';
import { sameValue } from './same-value.js';
import { controlReadout } from '../../ui/core/control-readout.js';
import { readSavedFigureExportSettings } from '../../ui/modules/figure-export/utils/session-settings.js';
import { reportUnreadSettings } from './unread-settings.js';

/**
 * What a control is called where it stands: its label, its accessible name,
 * else its id in words.
 */
function labelOf(id) {
  const element = typeof document === 'undefined' ? null : document.getElementById(id);
  const text = element?.labels?.[0]?.textContent ?? element?.getAttribute?.('aria-label') ?? element?.textContent ?? null;
  const name = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return name.length > 0 && name.length <= 60 ? name : id.replace(/-/g, ' ');
}

/**
 * What a control's recorded value reads as where it stands, at any step: a
 * choice's option, a slider's readout (its owner's, `core/control-readout.js`;
 * a slider's position is not always what it means), on or off. A slider whose
 * owner defines no readout reads as its value when its readout shows the
 * value, and as a position otherwise ("slider at 37 of 0–100").
 */
function shownOf(id, record) {
  if (record.type === 'checkbox') return record.checked ? 'on' : 'off';
  const element = typeof document === 'undefined' ? null : document.getElementById(id);
  if (element === null) return record.value;
  if (record.type === 'select') {
    const option = [...(element.options ?? [])].find(candidate => candidate.value === record.value);
    const text = option?.textContent?.replace(/\s+/g, ' ').trim();
    return text ? text : record.value;
  }
  if (record.type === 'range' || record.type === 'number') {
    const readout = controlReadout(element, record.value);
    if (readout !== null) return readout;
    const shown = element.closest?.('.slider-row')?.querySelector?.('.slider-value')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    // No readout beside it, or one that shows the value itself: the value says it.
    if (shown === '' || shown === String(element.value)) return record.value;
    return `slider at ${record.value} of ${element.min}–${element.max}`;
  }
  return record.value;
}

/**
 * @param {{sidebar: HTMLElement, viewer: object, figureExport: object|null}} options
 */
export function createSettingsDomain({ sidebar, viewer, figureExport }) {
  const controls = createUiControlSerializer({ sidebar, domains: ['settings'] });

  function capture() {
    return {
      controls: controls.collectUIControls(),
      figureExport: figureExport === null ? null : structuredClone(figureExport.exportSessionSettings()),
    };
  }

  return {
    capture,
    restore(value) {
      if (value === null || typeof value !== 'object' || typeof value.controls !== 'object') {
        throw new TypeError('The settings to restore must list every control.');
      }
      const current = capture();
      if (sameValue(current, value)) return;
      const unread = [];
      if (!sameValue(current.controls, value.controls)) {
        const read = controls.readSavedControls(value.controls);
        unread.push(...read.unread);
        const smoke = read.controls['render-mode']?.value === 'smoke' ? viewer.getSmokeSupport() : null;
        const withheld = smoke !== null && !smoke.supported;
        unread.push(...controls.restoreUIControls(read.controls, withheld ? { withholdControlIds: ['render-mode'] } : {})());
        if (withheld) reportSmokeUnavailable(smoke);
      }
      if (!sameValue(current.figureExport, value.figureExport) && value.figureExport !== null) {
        if (figureExport === null) throw new Error('The Figure export panel is not available on this page.');
        const read = readSavedFigureExportSettings(structuredClone(value.figureExport), current.figureExport);
        unread.push(...read.unread.map(({ setting, reason }) => ({ label: `Figure export ${setting}`, reason })));
        figureExport.importSessionSettings(read.settings);
      }
      reportUnreadSettings(unread);
    },
    describe(a, b) {
      const lines = [];
      for (const [id, record] of Object.entries(b.controls)) {
        const before = a.controls[id];
        if (sameValue(before, record)) continue;
        lines.push(`${labelOf(id)}: ${shownOf(id, record)}`);
      }
      if (!sameValue(a.figureExport, b.figureExport)) lines.push('Figure export settings changed');
      return lines;
    },
  };
}
