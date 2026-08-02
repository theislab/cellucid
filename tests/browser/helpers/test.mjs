import {
  expect,
  test as playwrightTest,
} from '@playwright/test';

export async function retirePageApplication(page) {
  if (page.isClosed()) return;

  await page.evaluate(async () => {
    const viewer = window._cellucidViewer ?? null;
    const dispose = window._cellucidDispose;

    // A document that stopped before viewer construction owns no application
    // runtime. Once the viewer exists, however, the stable application
    // disposer is mandatory: force-closing a Playwright page does not dispatch
    // pagehide in Chromium, Firefox, or WebKit.
    if (dispose === undefined && viewer === null) return;
    if (typeof dispose !== 'function') {
      throw new Error(
        'A constructed Cellucid viewer has no application teardown owner.',
      );
    }

    const firstTask = dispose();
    const secondTask = dispose();
    if (
      firstTask === null ||
      typeof firstTask !== 'object' ||
      typeof firstTask.then !== 'function' ||
      secondTask !== firstTask
    ) {
      throw new Error(
        'Cellucid application teardown must publish one stable Promise.',
      );
    }
    await firstTask;

    if (viewer !== null) {
      if (
        typeof viewer.isDisposed !== 'function' ||
        typeof viewer.isDisposalSettled !== 'function' ||
        viewer.isDisposed() !== true ||
        viewer.isDisposalSettled() !== true
      ) {
        throw new Error(
          'Cellucid application teardown did not settle viewer disposal.',
        );
      }
    }
  });
}

export async function retireContextApplications(context) {
  const outcomes = await Promise.allSettled(
    context.pages().map(page => retirePageApplication(page)),
  );
  const failures = outcomes
    .filter(outcome => outcome.status === 'rejected')
    .map(outcome => outcome.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'One or more browser applications could not be retired.',
    );
  }
}

export async function closePageWithApplicationRetirement(page) {
  const failures = [];
  try {
    await retirePageApplication(page);
  } catch (error) {
    failures.push(error);
  }
  try {
    await page.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'Application retirement and page closure both failed.',
    );
  }
}

export async function closeContextWithApplicationRetirement(context) {
  const failures = [];
  try {
    await retireContextApplications(context);
  } catch (error) {
    failures.push(error);
  }
  try {
    await context.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'Application retirement and browser-context closure both failed.',
    );
  }
}

export const test = playwrightTest.extend({
  applicationRetirement: [async ({ context }, use) => {
    try {
      await use();
    } finally {
      await retireContextApplications(context);
    }
  }, { auto: true }],
});

export { expect };
