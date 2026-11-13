/**
 * A saved state is written whole or not at all when its tab closes during
 * the write (`app/history/autosave-store.js`, `utils/indexed-db-database.js`).
 *
 * The browser commits a transaction once it has no request left to run. The
 * store reads first and makes all its writes at once, so they are all in the
 * transaction before any has run, and tells it to commit. Writes made one at a
 * time, each awaited, are committed as far as they got when a page goes away
 * between two of them, and a history's saved state would then hold a
 * conversation's count and not its messages, and could not be opened
 * (33_decisions_actions_domains_and_history.md).
 *
 * Here a tab is closed at several moments of one write, by the product's own
 * store, and what the next tab finds is the whole of it or none.
 * `tests/indexed-db-database.test.mjs` holds the rule itself (every write in
 * one task, no read after a write) where a close cannot be timed.
 */
import { closePageWithApplicationRetirement, expect, test } from './helpers/test.mjs';

// The browser's own storage (WebKit keeps IndexedDB only in a persistent context).
test.use({ persistentStorage: true });

const MESSAGES = 300;
const PAGE = '/saved-state-close.html';

async function openPage(context) {
  const page = await context.newPage();
  await page.goto(PAGE);
  return page;
}

test('a tab closed while a saved state is written leaves all of the write or none', async ({ context }) => {
  await context.route(`**${PAGE}`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>saved state</title>' }));
  const kept = [];
  // Closed after one to six exchanges with the page: other moments of the write. The page runs
  // no application (the fixture's closing has nothing to retire there, and asks the page once).
  for (let round = 0; round < 12; round++) {
    const id = `state-${round}`;
    const writer = await openPage(context);
    await writer.evaluate(async ({ id, count }) => {
      const { defaultHistoryStore } = await import('/assets/js/app/history/autosave-store.js');
      const store = defaultHistoryStore();
      // The database is open before the write starts.
      await store.list();
      const messages = Array.from({ length: count }, (_, index) => ({ index, message: { role: 'user', text: `message ${index} ${'x'.repeat(200)}` } }));
      void store.write({
        entry: { id, schema: 2, kind: 'autosave' },
        owner: 'the-writer',
        mode: 'whole',
        trackers: [{ id: 'tracker' }],
        removedTrackers: [],
        steps: [],
        removedSteps: [],
        turns: [],
        removedTurns: [],
        journal: [],
        removedJournal: [],
        chats: [{ tracker: 'tracker', conversation: 'chat', head: {}, messages, count }],
        values: [],
        parts: [],
        arrays: [],
      }).catch(() => {});
    }, { id, count: MESSAGES });
    for (let exchange = 0; exchange < round % 6; exchange++) await writer.evaluate(() => 1);
    await closePageWithApplicationRetirement(writer);

    const reader = await openPage(context);
    kept.push(await reader.evaluate(async id => {
      const { defaultHistoryStore } = await import('/assets/js/app/history/autosave-store.js');
      const read = await defaultHistoryStore().read(id);
      if (read === null) return 'none';
      return read.chats.length === 1 && read.chats[0].count === read.messages.length ? `whole: ${read.messages.length}` : `a part: count ${read.chats[0]?.count}, ${read.messages.length} messages`;
    }, id));
    await closePageWithApplicationRetirement(reader);
  }
  expect(kept.filter(what => what !== 'none' && what !== `whole: ${MESSAGES}`)).toEqual([]);
});
