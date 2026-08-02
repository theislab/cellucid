import { expect, test } from './helpers/test.mjs';

function observeBrowserErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      errors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return errors;
}

test(
  'analysis exact-key records survive codecs, worker execution, and cache lifecycles',
  async ({ page }) => {
    const browserErrors = observeBrowserErrors(page);
    await page.goto('/tests/browser/fixtures/webgl-harness.html');

    const proof = await page.evaluate(async () => {
      const exactNames = Object.getOwnPropertyNames(Object.prototype);
      const bodyMarkup = document.body.innerHTML;
      const prototypeDescriptors = new Map(
        exactNames.map(name => [
          name,
          Object.getOwnPropertyDescriptor(Object.prototype, name),
        ]),
      );
      const sensitiveObjects = new Set([Object.prototype]);
      for (const descriptor of prototypeDescriptors.values()) {
        for (const value of [
          descriptor.value,
          descriptor.get,
          descriptor.set,
        ]) {
          if (
            (typeof value === 'object' && value !== null)
            || typeof value === 'function'
          ) {
            sensitiveObjects.add(value);
          }
        }
      }
      const sensitiveSurfaces = new Map(
        [...sensitiveObjects].map(value => [
          value,
          {
            descriptors: new Map(
              Reflect.ownKeys(value).map(key => [
                key,
                Object.getOwnPropertyDescriptor(value, key),
              ]),
            ),
            prototype: Object.getPrototypeOf(value),
          },
        ]),
      );

      function fail(message) {
        throw new Error(message);
      }

      function assertSameKeys(actual, expected, label) {
        if (
          actual.length !== expected.length
          || actual.some((key, index) => key !== expected[index])
        ) {
          fail(
            `${label} keys differ: ${JSON.stringify(actual)} != `
            + JSON.stringify(expected),
          );
        }
      }

      function assertOwnRecord(record, names, label) {
        if (
          record === null
          || typeof record !== 'object'
          || Array.isArray(record)
          || Object.getPrototypeOf(record) !== Object.prototype
        ) {
          fail(`${label} must retain the ordinary Object prototype`);
        }
        assertSameKeys(Object.keys(record), names, label);
        for (const name of names) {
          if (!Object.hasOwn(record, name)) {
            fail(`${label} is missing own key ${name}`);
          }
          const descriptor = Object.getOwnPropertyDescriptor(record, name);
          if (
            descriptor.enumerable !== true
            || descriptor.configurable !== true
            || descriptor.writable !== true
          ) {
            fail(`${label}.${name} has a non-standard data descriptor`);
          }
        }
      }

      function assertArray(actual, expected, label) {
        if (
          actual.length !== expected.length
          || actual.some((value, index) => value !== expected[index])
        ) {
          fail(
            `${label} differs: ${JSON.stringify([...actual])} != `
            + JSON.stringify(expected),
          );
        }
      }

      function assertDescriptorEqual(actual, expected, label) {
        if (!actual || !expected) {
          if (actual !== expected) fail(`${label} descriptor presence changed`);
          return;
        }
        for (const key of [
          'configurable',
          'enumerable',
          'writable',
          'value',
          'get',
          'set',
        ]) {
          if (actual[key] !== expected[key]) {
            fail(`${label} descriptor.${key} changed`);
          }
        }
      }

      function assertGlobalPrototypeSurfaceUnchanged() {
        assertSameKeys(
          Object.getOwnPropertyNames(Object.prototype),
          exactNames,
          'Object.prototype',
        );
        for (const name of exactNames) {
          assertDescriptorEqual(
            Object.getOwnPropertyDescriptor(Object.prototype, name),
            prototypeDescriptors.get(name),
            `Object.prototype.${name}`,
          );
        }
        for (const [value, before] of sensitiveSurfaces) {
          if (Object.getPrototypeOf(value) !== before.prototype) {
            fail('An Object.prototype-owned value changed its prototype');
          }
          const afterKeys = Reflect.ownKeys(value);
          assertSameKeys(
            afterKeys,
            [...before.descriptors.keys()],
            'Object.prototype-owned value',
          );
          for (const key of afterKeys) {
            assertDescriptorEqual(
              Object.getOwnPropertyDescriptor(value, key),
              before.descriptors.get(key),
              `Object.prototype-owned value ${String(key)}`,
            );
          }
        }
      }

      const [
        { encodeTable, decodeTable },
        { executeOperation },
        { createWorkerPool },
        { DataLayer },
        { getMemoryMonitor },
      ] = await Promise.all([
        import('/assets/js/app/session/codecs/table-codec.js'),
        import('/assets/js/app/analysis/compute/operation-handlers.js'),
        import('/assets/js/app/analysis/compute/worker-pool.js'),
        import('/assets/js/app/analysis/data/data-layer.js'),
        import('/assets/js/app/analysis/shared/memory-monitor.js'),
      ]);

      const layers = new Set();
      let pool = null;
      try {
        const codecCases = [
          {
            dtype: 'float32',
            input: index => Float32Array.of(index + 0.25, index + 1.25),
            expected: index => [index + 0.25, index + 1.25],
          },
          {
            dtype: 'bool',
            input: index => [index % 2 === 0, index % 2 !== 0],
            expected: index => [index % 2 === 0 ? 1 : 0, index % 2],
          },
          {
            dtype: 'string',
            input: index => [`left-${index}`, `right-${index}`],
            expected: index => [`left-${index}`, `right-${index}`],
          },
        ];
        for (const codecCase of codecCases) {
          const decoded = decodeTable(encodeTable({
            rowCount: 2,
            columns: exactNames.map((name, index) => ({
              name,
              dtype: codecCase.dtype,
              data: codecCase.input(index),
            })),
          }));
          assertOwnRecord(
            decoded.columns,
            exactNames,
            `${codecCase.dtype} decoded columns`,
          );
          for (let index = 0; index < exactNames.length; index++) {
            assertArray(
              decoded.columns[exactNames[index]],
              codecCase.expected(index),
              `${codecCase.dtype}.${exactNames[index]}`,
            );
          }
        }

        const variables = exactNames.map((key, index) => ({
          key,
          rawValues: Float32Array.of(index + 0.5, index + 1.5),
        }));
        const conditions = exactNames.map(field => ({
          field,
          operator: 'is_not_null',
          value: null,
          logic: 'AND',
        }));
        const ownFields = Object.fromEntries(
          exactNames.map(name => [name, Float32Array.of(1)]),
        );
        const extractionPayload = {
          cellIndices: [0, 1],
          variables,
        };
        const ownFilterPayload = {
          cellIndices: [0],
          conditions,
          fieldsData: ownFields,
        };
        const missingFilterPayload = {
          cellIndices: [0],
          conditions,
          fieldsData: {},
        };
        const missingNegatedFilterPayload = {
          cellIndices: [0],
          conditions: conditions.map(condition => ({
            ...condition,
            negate: true,
          })),
          fieldsData: {},
        };

        const directBatch = executeOperation(
          'BATCH_EXTRACT',
          extractionPayload,
        );
        assertOwnRecord(directBatch, exactNames, 'direct BATCH_EXTRACT');
        for (let index = 0; index < exactNames.length; index++) {
          assertArray(
            directBatch[exactNames[index]].values,
            [index + 0.5, index + 1.5],
            `direct BATCH_EXTRACT.${exactNames[index]}`,
          );
        }
        assertArray(
          executeOperation('FILTER_CELLS', ownFilterPayload).filtered,
          [0],
          'direct FILTER_CELLS own fields',
        );
        assertArray(
          executeOperation('FILTER_CELLS', missingFilterPayload).filtered,
          [],
          'direct FILTER_CELLS inherited fields',
        );
        assertArray(
          executeOperation(
            'FILTER_CELLS',
            missingNegatedFilterPayload,
          ).filtered,
          [],
          'direct FILTER_CELLS negated inherited fields',
        );

        pool = createWorkerPool({
          poolSize: 1,
          defaultTimeout: 10_000,
        });
        await pool.init();
        const workerBatch = await pool.execute(
          'BATCH_EXTRACT',
          extractionPayload,
          { transfer: false },
        );
        assertOwnRecord(workerBatch, exactNames, 'worker BATCH_EXTRACT');
        for (let index = 0; index < exactNames.length; index++) {
          assertArray(
            workerBatch[exactNames[index]].values,
            [index + 0.5, index + 1.5],
            `worker BATCH_EXTRACT.${exactNames[index]}`,
          );
        }
        assertArray(
          (
            await pool.execute(
              'FILTER_CELLS',
              ownFilterPayload,
              { transfer: false },
            )
          ).filtered,
          [0],
          'worker FILTER_CELLS own fields',
        );
        assertArray(
          (
            await pool.execute(
              'FILTER_CELLS',
              missingFilterPayload,
              { transfer: false },
            )
          ).filtered,
          [],
          'worker FILTER_CELLS inherited fields',
        );
        assertArray(
          (
            await pool.execute(
              'FILTER_CELLS',
              missingNegatedFilterPayload,
              { transfer: false },
            )
          ).filtered,
          [],
          'worker FILTER_CELLS negated inherited fields',
        );
        const workerStats = pool.getStats();
        pool.terminate();
        pool = null;

        const monitor = getMemoryMonitor();
        const baselineCleanupHandlers = monitor.getCleanupHandlerCount();
        const state = {
          getHighlightPages() {
            return [];
          },
        };
        const createLayer = () => {
          const layer = new DataLayer(state, {
            enableCache: false,
            enableDedup: false,
            enableNotifications: false,
            enablePrefetch: false,
            enableVersionTracking: false,
          });
          layers.add(layer);
          return layer;
        };
        const destroyLayer = async layer => {
          await layer.destroy();
          layers.delete(layer);
        };
        const artifacts = exactNames.flatMap((gene, geneIndex) =>
          exactNames.map((pageId, pageIndex) => ({
            kind: 'bulk-gene',
            cacheKey: 'prototype-matrix',
            gene,
            pageId,
            pageName: `Page ${pageId}`,
            cellCount: 1,
            timestamp: 1,
            geneCount: exactNames.length,
            values: Float32Array.of(geneIndex * 100 + pageIndex),
            cellIndices: Uint32Array.of(pageIndex),
          }))
        );
        const verifyArtifacts = (exported, label) => {
          if (exported.length !== artifacts.length) {
            fail(
              `${label} count ${exported.length} != ${artifacts.length}`,
            );
          }
          const byIdentity = new Map(
            exported.map(artifact => [
              `${artifact.gene}\u0000${artifact.pageId}`,
              artifact,
            ]),
          );
          for (let geneIndex = 0; geneIndex < exactNames.length; geneIndex++) {
            for (
              let pageIndex = 0;
              pageIndex < exactNames.length;
              pageIndex++
            ) {
              const gene = exactNames[geneIndex];
              const pageId = exactNames[pageIndex];
              const artifact = byIdentity.get(`${gene}\u0000${pageId}`);
              if (!artifact) {
                fail(`${label} omitted ${gene}/${pageId}`);
              }
              assertArray(
                artifact.values,
                [geneIndex * 100 + pageIndex],
                `${label} ${gene}/${pageId} values`,
              );
              assertArray(
                artifact.cellIndices,
                [pageIndex],
                `${label} ${gene}/${pageId} indices`,
              );
            }
          }
        };

        const firstLayer = createLayer();
        if (firstLayer.importSessionCache(artifacts) !== artifacts.length) {
          fail('The first DataLayer did not import every cache artifact');
        }
        const firstExport = firstLayer.exportSessionCache();
        verifyArtifacts(firstExport, 'first DataLayer export');

        firstLayer.getDataForPages = async () => exactNames.map(pageId => ({
          pageId,
          pageName: `Page ${pageId}`,
          values: [...exactNames],
          cellIndices: Uint32Array.from(
            { length: exactNames.length },
            (_, index) => index,
          ),
          cellCount: exactNames.length,
        }));
        const aggregation = await firstLayer.getCategoryCountsByPage(
          '__proto__',
          exactNames,
        );
        assertOwnRecord(
          aggregation.pages,
          exactNames,
          'category aggregation pages',
        );
        for (const pageId of exactNames) {
          assertOwnRecord(
            aggregation.pages[pageId].counts,
            exactNames,
            `category aggregation ${pageId}`,
          );
          for (const category of exactNames) {
            if (aggregation.pages[pageId].counts[category] !== 1) {
              fail(
                `category aggregation ${pageId}/${category} did not count 1`,
              );
            }
          }
        }
        await destroyLayer(firstLayer);

        const secondLayer = createLayer();
        if (secondLayer.importSessionCache(firstExport) !== firstExport.length) {
          fail('The recreated DataLayer did not import every cache artifact');
        }
        verifyArtifacts(
          secondLayer.exportSessionCache(),
          'recreated DataLayer export',
        );
        await destroyLayer(secondLayer);

        if (monitor.getCleanupHandlerCount() !== baselineCleanupHandlers) {
          fail('DataLayer destroy leaked a memory-monitor cleanup handler');
        }
        if (document.body.innerHTML !== bodyMarkup) {
          fail('The module lifecycle mutated the test document');
        }
        assertGlobalPrototypeSurfaceUnchanged();

        return {
          aggregationPages: Object.keys(aggregation.pages).length,
          cacheArtifacts: artifacts.length,
          codecCases: codecCases.length,
          exactNames: exactNames.length,
          workerState: workerStats.state,
        };
      } finally {
        if (pool !== null) pool.terminate();
        for (const layer of [...layers]) {
          await layer.destroy();
        }
      }
    });

    expect(proof).toEqual({
      aggregationPages: proof.exactNames,
      cacheArtifacts: proof.exactNames ** 2,
      codecCases: 3,
      exactNames: proof.exactNames,
      workerState: 'ready',
    });
    expect(proof.exactNames).toBeGreaterThan(0);
    expect(browserErrors).toEqual([]);
  },
);
