// Verifies fixture lifecycle: create a typed MEJ entry, MEJ recognizes it, sweep removes it.
import assert from 'node:assert/strict';
import { withSession, createEntry, sweep, entryFlag } from '../helpers/mej.js';

await withSession('fixtures', { users: ['Gamemaster'] }, async ({ pages }) => {
  const gm = pages['Gamemaster'];
  const id = await createEntry(gm, 'person', 'TT-fixture-person');

  const type = await gm.evaluate((id) => {
    return game.MonksEnhancedJournal.getMEJType(game.journal.get(id));
  }, id);
  assert.equal(type, 'person', 'MEJ does not recognize the created entry as a person');

  assert.equal(await entryFlag(gm, id, 'type'), 'person');

  const removed = await sweep(gm);
  assert.ok(removed >= 1, 'sweep did not remove the TT- entry');
  const gone = await gm.evaluate((id) => !game.journal.get(id), id);
  assert.ok(gone, 'entry still exists after sweep');
});
