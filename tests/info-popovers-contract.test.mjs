import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  computeInfoPopoverPosition
} from '../assets/js/app/ui/components/info-popovers.js';

const INDEX_URL = new URL('../index.html', import.meta.url);
const BUTTONS_CSS_URL = new URL(
  '../assets/css/components/_buttons.css',
  import.meta.url
);
const DATASET_CONNECTIONS_URL = new URL(
  '../assets/js/app/ui/modules/dataset-connections.js',
  import.meta.url
);
const COMMUNITY_CONTROLS_URL = new URL(
  '../assets/js/app/ui/modules/community-annotation-controls.js',
  import.meta.url
);
const COMMUNITY_PANEL_URL = new URL(
  '../assets/js/app/ui/modules/community-annotation/controls-panel.js',
  import.meta.url
);
const UI_COORDINATOR_URL = new URL(
  '../assets/js/app/ui/core/ui-coordinator.js',
  import.meta.url
);

const [
  indexHtml,
  buttonsCss,
  datasetConnectionsSource,
  communityControlsSource,
  communityPanelSource,
  uiCoordinatorSource
] = await Promise.all([
  readFile(INDEX_URL, 'utf8'),
  readFile(BUTTONS_CSS_URL, 'utf8'),
  readFile(DATASET_CONNECTIONS_URL, 'utf8'),
  readFile(COMMUNITY_CONTROLS_URL, 'utf8'),
  readFile(COMMUNITY_PANEL_URL, 'utf8'),
  readFile(UI_COORDINATOR_URL, 'utf8')
]);

function attributeValue(attributes, name) {
  const value = attributes.match(
    new RegExp(`(?:^|\\s)${name}="([^"]*)"`)
  )?.[1];
  return value === undefined ? null : value;
}

function hasBooleanAttribute(attributes, name) {
  return new RegExp(`(?:^|\\s)${name}(?:\\s|$)`).test(attributes);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rect(left, top, width, height) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height
  };
}

test('every static compact information disclosure has one exact accessible pair', () => {
  const buttonMatches = Array.from(
    indexHtml.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)
  ).filter(match => (
    attributeValue(match[1], 'class')?.split(/\s+/).includes('info-btn')
  ));

  assert.ok(
    buttonMatches.length > 3,
    'the shared compact pattern must cover more than the original three controls'
  );
  assert.doesNotMatch(indexHtml, /<span\b[^>]*class="[^"]*\binfo-btn\b/);

  const triggerIds = new Set();
  const popoverIds = new Set();
  for (const [, attributes, content] of buttonMatches) {
    const triggerId = attributeValue(attributes, 'id');
    const popoverId = attributeValue(attributes, 'aria-controls');
    assert.ok(triggerId, 'information trigger id is required');
    assert.ok(popoverId, 'information trigger aria-controls is required');
    assert.equal(attributeValue(attributes, 'type'), 'button');
    assert.equal(attributeValue(attributes, 'aria-haspopup'), 'dialog');
    assert.equal(attributeValue(attributes, 'aria-expanded'), 'false');
    assert.match(attributeValue(attributes, 'aria-label') || '', /\S/);
    assert.match(
      content,
      /^\s*<span aria-hidden="true">i<\/span>\s*$/
    );
    assert.equal(triggerIds.has(triggerId), false);
    assert.equal(popoverIds.has(popoverId), false);
    triggerIds.add(triggerId);
    popoverIds.add(popoverId);

    const popoverOpen = indexHtml.match(
      new RegExp(
        `<div\\b([^>]*)\\bid="${escapeRegExp(popoverId)}"([^>]*)>`
      )
    );
    assert.ok(popoverOpen, `popover ${popoverId} is required`);
    const popoverAttributes = `${popoverOpen[1]} ${popoverOpen[2]}`;
    assert.match(
      attributeValue(popoverAttributes, 'class') || '',
      /(?:^|\s)info-tooltip(?:\s|$)/
    );
    assert.equal(attributeValue(popoverAttributes, 'role'), 'dialog');
    assert.equal(
      attributeValue(popoverAttributes, 'aria-labelledby'),
      triggerId
    );
    assert.equal(attributeValue(popoverAttributes, 'tabindex'), '-1');
    assert.equal(hasBooleanAttribute(popoverAttributes, 'hidden'), true);
  }
});

test('static guidance is compact while live state remains directly visible', () => {
  assert.doesNotMatch(indexHtml, /\buser-data-help\b/);
  assert.doesNotMatch(
    indexHtml,
    /<div class="legend-help">\s*Save or load the application state/
  );
  assert.doesNotMatch(
    indexHtml,
    /<div class="legend-help">\s*Choose orbit for 3D exploration/
  );

  for (const liveId of [
    'connectivity-info',
    'velocity-overlay-info',
    'filter-count',
    'active-filters',
    'highlight-mode-description',
    'highlight-count'
  ]) {
    assert.match(indexHtml, new RegExp(`\\bid="${liveId}"`));
  }
});

test('one controller owns static and dynamic information popovers', () => {
  assert.match(
    uiCoordinatorSource,
    /const infoPopovers = initInfoPopovers\(\{ root: document \}\)/
  );
  assert.match(
    uiCoordinatorSource,
    /initCommunityAnnotationControls\(\{[\s\S]*infoPopovers/
  );
  assert.doesNotMatch(
    datasetConnectionsSource,
    /positionTooltip|attachTooltipToggle|userDataInfoTooltip/
  );
  assert.match(
    communityPanelSource,
    /infoPopovers\.configurePair\(btn, tooltip/
  );
  assert.match(
    communityPanelSource,
    /infoPopovers\.closeWithin\(container\)/
  );
  assert.match(
    communityControlsSource,
    /infoPopovers\.closeWithin\(container\)/
  );
  for (const moduleSource of [communityControlsSource, communityPanelSource]) {
    assert.doesNotMatch(
      moduleSource,
      /document\.body\.querySelectorAll\('\.info-tooltip'\)|tooltipPairs/
    );
  }
});

test('popover geometry chooses the fitting side and clamps horizontal edges', () => {
  assert.deepEqual(
    computeInfoPopoverPosition({
      triggerRect: rect(50, 20, 14, 14),
      popoverRect: rect(0, 0, 240, 100),
      viewportWidth: 400,
      viewportHeight: 300
    }),
    { left: 50, top: 40, placement: 'below' }
  );
  assert.deepEqual(
    computeInfoPopoverPosition({
      triggerRect: rect(380, 270, 14, 14),
      popoverRect: rect(0, 0, 240, 100),
      viewportWidth: 400,
      viewportHeight: 300
    }),
    { left: 152, top: 164, placement: 'above' }
  );
});

test('popover geometry rejects inconsistent or unrenderable measurements', () => {
  assert.throws(
    () => computeInfoPopoverPosition({
      triggerRect: {
        ...rect(10, 10, 14, 14),
        right: 25
      },
      popoverRect: rect(0, 0, 100, 50),
      viewportWidth: 400,
      viewportHeight: 300
    }),
    /edges must exactly match/
  );
  assert.throws(
    () => computeInfoPopoverPosition({
      triggerRect: rect(10, 10, 14, 14),
      popoverRect: rect(0, 0, 390, 50),
      viewportWidth: 400,
      viewportHeight: 300
    }),
    /must fit inside/
  );
});

test('compact controls retain a small visual glyph with an expanded hit target', () => {
  assert.match(
    buttonsCss,
    /\.info-btn\s*\{[\s\S]*width:\s*var\(--space-3-5\)[\s\S]*height:\s*var\(--space-3-5\)/
  );
  assert.match(
    buttonsCss,
    /\.info-btn::before\s*\{[\s\S]*inset:\s*calc\(-1 \* var\(--space-1-5\)\)/
  );
  assert.match(buttonsCss, /\.info-tooltip\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(
    buttonsCss,
    /max-height:\s*calc\(100vh - var\(--space-4\)\)/
  );
});
