/**
 * An agent opening a dataset (`dataset.open`), dispatched from the page as an
 * agent's tool call is: its outcome, or its refusal's code and sentence.
 *
 * This is the one way a spec replaces the dataset while a modal dialog of the
 * page is open. A modal dialog (a `<dialog>` opened with `showModal()`,
 * `components/app-dialog.js`) makes the rest of the page inert, so the person
 * cannot reach the dataset picker until they answer or close it, and since
 * Playwright 1.65 an action on an inert control waits for it to stop being
 * inert as a person would. An agent's call (the in-app chat, a connector) is
 * not stopped by the dialog: it is how a dataset really changes under one.
 */

/**
 * @param {import('@playwright/test').Page} page
 * @param {{name: string, kind?: string, count?: number, fraction?: number, method?: string, seed?: number}} params
 * @param {{agent?: string, turn?: string}} [meta]
 */
export function openDatasetAsAgent(page, params, { agent = 'Claude', turn = 't1' } = {}) {
  return page.evaluate(async ({ parameters, agentName, turnId }) => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    try {
      const { outcome, step } = await getActions().dispatch('dataset.open', parameters, {
        origin: 'agent', agent: agentName, turn: turnId,
      });
      return { outcome, step };
    } catch (error) {
      return { refused: { code: error.code ?? null, message: error.message } };
    }
  }, { parameters: params, agentName: agent, turnId: turn });
}
