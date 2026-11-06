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
 * Restore writes each control that differs and dispatches the event its
 * owner listens for (the session path, `restoreUIControls`); a control whose
 * owner refuses the value fails the restore. Smoke on a device that cannot
 * draw it is said, as a session says it, and Points is kept.
 *
 * @module app/state/domains/settings
 */

import { createUiControlSerializer } from '../../state-serializer/ui-controls.js';
import { reportSmokeUnavailable } from '../../ui/modules/smoke-availability.js';
import { sameValue } from './same-value.js';

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
      if (!sameValue(current.controls, value.controls)) {
        const smoke = value.controls['render-mode']?.value === 'smoke' ? viewer.getSmokeSupport() : null;
        const withheld = smoke !== null && !smoke.supported;
        controls.restoreUIControls(value.controls, withheld ? { withholdControlIds: ['render-mode'] } : {})();
        if (withheld) reportSmokeUnavailable(smoke);
      }
      if (!sameValue(current.figureExport, value.figureExport) && value.figureExport !== null) {
        if (figureExport === null) throw new Error('The Figure export panel is not available on this page.');
        figureExport.importSessionSettings(structuredClone(value.figureExport));
      }
    },
    describe(a, b) {
      const lines = [];
      for (const [id, record] of Object.entries(b.controls)) {
        const before = a.controls[id];
        if (sameValue(before, record)) continue;
        const shown = record.type === 'checkbox' ? (record.checked ? 'on' : 'off') : record.value;
        lines.push(`${labelOf(id)}: ${shown}`);
      }
      if (!sameValue(a.figureExport, b.figureExport)) lines.push('Figure export settings changed');
      return lines;
    },
  };
}
