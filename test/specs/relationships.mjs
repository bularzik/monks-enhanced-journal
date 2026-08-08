// Dropping person B onto person A's relationships tab creates the relationship
// on A (keyed by B's JournalEntry id - `relationships` is an object keyed by
// id, not an array; EnhancedJournalSheet.getRelationships migrates any legacy
// array shape on read) AND cascades the reciprocal onto B, keyed by A's
// JournalEntry id (round-2/3 fix: cascade keyed by journal id, not page id).
//
// The relationship drop zone is scoped to the relationships tab's item list
// (EnhancedJournalSheet._dragDrop: dropSelector ".relationships .items-list"
// -> _onDropRelationship), not the whole `.monks-enhanced-journal` window -
// the base `_onDrop(event)` on EnhancedJournalSheet is never bound to any
// subsheet DOM (only apps/enhanced-journal.js's own same-named method is
// wired, to the tab-bar header). All tabs render into the DOM up front
// (templates/sheets/person.html) with only an "active" class toggling
// visibility, so the synthetic drop reaches the handler without switching
// tabs first.
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, dropOnSheet, entryFlag, assertNoErrors } from '../helpers/mej.js';

await withSession('relationships', { users: ['Gamemaster'] }, async (session) => {
  const gm = session.pages['Gamemaster'];
  const idA = await createEntry(gm, 'person', 'TT-rel-personA');
  const idB = await createEntry(gm, 'person', 'TT-rel-personB');
  await openEntry(gm, idA);

  const uuidB = await gm.evaluate((id) => game.journal.get(id).uuid, idB);
  await dropOnSheet(gm, '.relationships .items-list', { type: 'JournalEntry', uuid: uuidB });

  // relationship writes are async; poll the flags
  await gm.waitForFunction((idA) => {
    const rels = game.journal.get(idA)?.pages.contents[0]?.getFlag('monks-enhanced-journal', 'relationships');
    return rels && Object.keys(rels).length > 0;
  }, idA);

  const relsA = await entryFlag(gm, idA, 'relationships');
  const relsB = await entryFlag(gm, idB, 'relationships');
  assert.ok(relsA && relsA[idB], 'A does not reference B');
  assert.ok(relsB && relsB[idA], 'cascade did not write the reciprocal relationship onto B');
  assert.equal(relsB[idA].hidden, true, 'cascaded reciprocal relationship should default to hidden');
  assertNoErrors(session);
});
