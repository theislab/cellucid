import { expect, test } from '@playwright/test';

test('grid PNG and Hybrid SVG own per-pane scientific adornments', async ({
  page,
}) => {
  await page.goto('/tests/browser/fixtures/webgl-harness.html');

  const result = await page.evaluate(async () => {
    const [
      { renderFigureToPngBlob },
      { renderFigureToSvgBlob },
    ] = await Promise.all([
      import('/assets/js/app/ui/modules/figure-export/renderers/png-renderer.js'),
      import('/assets/js/app/ui/modules/figure-export/renderers/svg-renderer.js'),
    ]);

    const identity = Float32Array.from([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
    const cameraState = () => ({
      navigationMode: 'orbit',
      orbit: {
        radius: 3,
        targetRadius: 3,
        theta: 0,
        phi: Math.PI / 2,
        target: [0, 0, 0],
      },
      freefly: {
        position: [0, 0, 3],
        yaw: 0,
        pitch: 0,
      },
    });
    const renderState = () => ({
      bgColor: Float32Array.from([1, 1, 1]),
      cameraDistance: 3,
      cameraPosition: [0, 0, 3],
      far: 100,
      fogColor: Float32Array.from([1, 1, 1]),
      fogDensity: 0,
      fogFar: 3.5,
      fogNear: 2.5,
      fov: Math.PI / 4,
      lightDir: Float32Array.from([0, 0, 1]),
      lightingStrength: 1,
      modelMatrix: new Float32Array(identity),
      mvpMatrix: new Float32Array(identity),
      near: 0.01,
      pointSize: 4,
      projectionMatrix: new Float32Array(identity),
      shaderQuality: 'full',
      sizeAttenuation: 1,
      viewMatrix: new Float32Array(identity),
      viewportHeight: 240,
      viewportWidth: 320,
    });
    const categoryLegend = () => ({
      kind: 'category',
      categories: ['Alpha', 'Beta'],
      colors: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      visible: [true, true],
      picker: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      counts: [1, 0],
    });
    const makeView = ({
      id,
      label,
      transparency,
      legendModel,
    }) => ({
      cameraState: cameraState(),
      data: {
        centroidColors: null,
        centroidFlags: { labels: false, points: false },
        centroidLabelTexts: [],
        centroidPositions: null,
        colors: Uint8Array.from([255, 0, 0, 255]),
        pointCount: 1,
        positions: Float32Array.from([0, 0, 0]),
        transparency: Float32Array.from([transparency]),
      },
      id,
      label,
      renderState: renderState(),
      scientificState: {
        datasetGeneration: 7,
        dimensionLevel: 3,
        fieldKey: 'cluster',
        fieldKind: 'category',
        filters: [],
        geometryGeneration: 11,
        legendModel,
        lodMembership: null,
        lodSizeMultiplier: 1,
        normTransform: {
          center: [0, 0, 0],
          scale: 1,
        },
      },
    });
    const makePayload = ({
      format,
      includeAxes = true,
      legendDifference = false,
    }) => {
      const secondLegend = categoryLegend();
      if (legendDifference) secondLegend.colors[1][2] = 0.25;
      const strategy = format === 'svg' ? 'hybrid' : null;
      const views = [
        makeView({
          id: 'visible',
          label: 'Visible',
          transparency: 1,
          legendModel: categoryLegend(),
        }),
        makeView({
          id: 'filtered',
          label: 'Filtered',
          transparency: 0,
          legendModel: secondLegend,
        }),
      ];
      return {
        dpi: format === 'png' ? 96 : null,
        format,
        height: 520,
        meta: {
          views: views.map((view) => ({
            fieldKey: view.scientificState.fieldKey,
            fieldKind: view.scientificState.fieldKind,
            filters: [...view.scientificState.filters],
            id: view.id,
            label: view.label,
          })),
        },
        options: {
          axisLabelFontSizePx: 12,
          background: 'viewer',
          backgroundColor: '#ffffff',
          centroidLabelFontSizePx: 12,
          crop: null,
          depthSort3d: false,
          emphasizeSelection: false,
          fontFamily: 'Arial, sans-serif',
          fontSizePx: 12,
          height: 520,
          includeAxes,
          includeLegend: true,
          legendFontSizePx: 12,
          legendPosition: 'right',
          optimizedTargetCount: null,
          referenceGrid: null,
          selectionMutedOpacity: 0.15,
          showOrientation: true,
          strategy,
          tickFontSizePx: 12,
          title: '',
          titleFontSizePx: 15,
          width: 900,
          xLabel: 'UMAP 1',
          yLabel: 'UMAP 2',
        },
        selection: {
          highlightArray: null,
          totalCount: 0,
          visibleCount: 0,
        },
        title: '',
        views,
        width: 900,
      };
    };

    const textCalls = [];
    const originalFillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function fillText(
      text,
      x,
      y,
      ...rest
    ) {
      textCalls.push({ text: String(text), x, y });
      return originalFillText.call(this, text, x, y, ...rest);
    };

    try {
      const equalPng = await renderFigureToPngBlob({
        payload: makePayload({ format: 'png' }),
      });
      const equalCalls = textCalls.splice(0);

      const differentPng = await renderFigureToPngBlob({
        payload: makePayload({
          format: 'png',
          includeAxes: false,
          legendDifference: true,
        }),
      });
      const differentCalls = textCalls.splice(0);

      const hybridSvgBlob = await renderFigureToSvgBlob({
        payload: makePayload({ format: 'svg' }),
      });
      const hybridSvg = await hybridSvgBlob.text();

      return {
        differentCalls,
        differentPng: {
          size: differentPng.size,
          type: differentPng.type,
        },
        equalCalls,
        equalPng: {
          size: equalPng.size,
          type: equalPng.type,
        },
        hybridSvg: {
          emptyCount: hybridSvg.match(/>No visible cells<\/text>/g)?.length ?? 0,
          imageCount: hybridSvg.match(/<image\b/g)?.length ?? 0,
          orientationCount: hybridSvg.match(/>az 0°<\/text>/g)?.length ?? 0,
          sharedLegendCount:
            hybridSvg.match(/font-weight="600">cluster<\/text>/g)?.length ?? 0,
          xAxisCount: hybridSvg.match(/>UMAP 1<\/text>/g)?.length ?? 0,
        },
      };
    } finally {
      CanvasRenderingContext2D.prototype.fillText = originalFillText;
    }
  });

  expect(result.equalPng.type).toBe('image/png');
  expect(result.equalPng.size).toBeGreaterThan(100);
  expect(result.differentPng.type).toBe('image/png');
  expect(result.differentPng.size).toBeGreaterThan(100);

  const equalText = result.equalCalls.map(call => call.text);
  expect(equalText.filter(text => text === 'No visible cells')).toHaveLength(1);
  expect(equalText.filter(text => text === 'UMAP 1')).toHaveLength(1);
  expect(equalText.filter(text => text === 'UMAP 2')).toHaveLength(1);
  expect(equalText.filter(text => text === 'az 0°')).toHaveLength(2);
  expect(equalText.filter(text => text === 'cluster')).toHaveLength(1);
  expect(equalText).toContain('A. Visible');
  expect(equalText).toContain('B. Filtered');

  const paneLabels = result.equalCalls.filter(call =>
    call.text === 'A. Visible' || call.text === 'B. Filtered'
  );
  expect(paneLabels).toHaveLength(2);
  expect(paneLabels[0].x).toBeGreaterThan(20);
  expect(paneLabels[1].x).toBeGreaterThan(paneLabels[0].x + 100);
  expect(paneLabels.every(call => call.y > 20 && call.y < 80)).toBe(true);

  const differentText = result.differentCalls.map(call => call.text);
  // Panels whose legend models differ can no longer share one legend, so each
  // panel draws its own instead of the grid drawing none.
  expect(differentText.filter(text => text === 'cluster')).toHaveLength(2);
  expect(differentText.filter(text => text === 'Alpha')).toHaveLength(2);
  expect(differentText.filter(text => text === 'Beta')).toHaveLength(2);
  expect(
    differentText.filter(text => text === 'No visible cells')
  ).toHaveLength(1);
  expect(differentText.filter(text => text === 'UMAP 1')).toHaveLength(0);

  // The two panel legends sit in different panels, to the right of each plot.
  const panelLegendTitles = result.differentCalls.filter(
    call => call.text === 'cluster'
  );
  expect(panelLegendTitles[1].x).toBeGreaterThan(panelLegendTitles[0].x + 300);
  expect(panelLegendTitles.every(call => call.y > 20)).toBe(true);

  expect(result.hybridSvg).toEqual({
    emptyCount: 1,
    imageCount: 2,
    orientationCount: 2,
    sharedLegendCount: 1,
    xAxisCount: 1,
  });
});
