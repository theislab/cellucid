/**
 * The reader-visible text of the (i) tip a static `.info-tooltip` names: the
 * markup carries only `data-info-tip`, and the words live in the tip registry
 * (assets/js/app/ui/components/info-tips.js).
 */
import assert from 'node:assert/strict';

import { INFO_TIPS } from '../../assets/js/app/ui/components/info-tips.js';

export function infoTipKey(indexHtml, tooltipId) {
  const match = new RegExp(`<div id="${tooltipId}"[^>]*\\bdata-info-tip="([a-z-]+)"`).exec(indexHtml);
  assert.ok(match, `${tooltipId} must name its tip with data-info-tip`);
  return match[1];
}

export function infoTipText(indexHtml, tooltipId) {
  const tip = INFO_TIPS[infoTipKey(indexHtml, tooltipId)];
  assert.ok(tip, `${tooltipId} names a tip the registry does not hold`);
  const blocks = tip.body.map(block => (typeof block === 'string' ? block : block.list.join('\n')));
  return [tip.title, ...blocks].join('\n');
}
